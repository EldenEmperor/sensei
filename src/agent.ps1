# agent.ps1 — the agentic loop, tool dispatch, subagents, @file expansion,
# and context compaction.

$script:MaxToolRounds = 40
$script:TotalPromptTokens = 0
$script:TotalCompletionTokens = 0
$script:Todos = @()

function Show-ToolCall {
    param([string]$Name, [hashtable]$ToolArgs, [int]$Depth = 0)
    $argStr = ''
    if ($ToolArgs -and $ToolArgs.Count -gt 0) {
        $argStr = ($ToolArgs.GetEnumerator() | ForEach-Object {
            $v = [string]$_.Value
            $v = $v -replace '\r?\n', '⏎'
            if ($v.Length -gt 70) { $v = $v.Substring(0, 67) + '…' }
            "$($_.Key)=$v"
        }) -join ' '
    }
    $indent = '  ' * $Depth
    if ($Depth -gt 0) {
        Write-Host "$indent$($script:Theme.Dim)● $Name $(Protect-TerminalText $argStr)$($script:Theme.Reset)"
    } else {
        Write-Host "$($script:Theme.Accent)● $Name$($script:Theme.Reset) $($script:Theme.Dim)$(Protect-TerminalText $argStr)$($script:Theme.Reset)"
    }
}

function Invoke-KakunaToolCall {
    param($ToolCall, [int]$Depth = 0)
    $name = [string]$ToolCall.function.name
    $tool = $script:ToolRegistry[$name]
    if (-not $tool) { return "ERROR: unknown tool '$name'" }
    $toolArgs = @{}
    try {
        if ($ToolCall.function.arguments) {
            $parsed = $ToolCall.function.arguments | ConvertFrom-Json -AsHashtable
            if ($parsed) { $toolArgs = $parsed }
        }
    } catch {
        return "ERROR: tool arguments were not valid JSON: $($_.Exception.Message)"
    }
    Show-ToolCall $name $toolArgs $Depth

    $hook = Invoke-KakunaHooks -Event 'PreToolUse' -ToolName $name -ToolInput $toolArgs
    if ($hook.Block) { return "ERROR: blocked by PreToolUse hook: $($hook.Reason)" }

    if (-not (Request-ToolPermission -Name $name -Tool $tool -ToolArgs $toolArgs)) {
        Write-KakunaNote '  denied'
        if ($script:PrintMode -or [Console]::IsInputRedirected) {
            return 'ERROR: permission denied (non-interactive mode; rerun with --yolo or add an allowlist rule)'
        }
        return "ERROR: user denied permission for $name"
    }

    $out = $null
    try {
        if ($tool.McpServer) {
            $out = Invoke-McpToolCall -ServerName $tool.McpServer -ToolName $tool.McpTool -Arguments $toolArgs
        } else {
            $out = @(& $tool.Handler $toolArgs) -join "`n"
        }
    } catch [System.OperationCanceledException] {
        $out = 'ERROR: aborted by user'
    } catch {
        $out = "ERROR: $($_.Exception.Message)"
    }
    [void](Invoke-KakunaHooks -Event 'PostToolUse' -ToolName $name -ToolInput $toolArgs -ToolResponse ([string]$out))
    return $out
}

function Invoke-AgentLoop {
    # The core model → tools → model loop over an arbitrary message list.
    # Used by top-level turns (Depth 0) and subagents (Depth 1).
    param(
        [System.Collections.Generic.List[object]]$Messages,
        [int]$MaxRounds = 40,
        [int]$Depth = 0,
        [string[]]$ExcludeTools = @(),
        [switch]$AllowStream
    )
    $result = @{ FinalText = $null; FinishReason = $null; Aborted = $false; Rounds = 0 }
    for ($round = 1; $round -le $MaxRounds; $round++) {
        $result.Rounds = $round
        $resp = $null
        try {
            $resp = Invoke-OpenAIChat -Messages $Messages -ToolSpecs (Get-ToolSpecs -Exclude $ExcludeTools) `
                -AllowStream:($AllowStream -and $Depth -eq 0)
        } catch {
            Write-KakunaError "$($_.Exception.Message)"
            $result.FinalText = "ERROR: $($_.Exception.Message)"
            $result.FinishReason = 'error'
            return $result
        }
        if ($resp.Aborted) {
            Write-KakunaNote '(request aborted)'
            $result.Aborted = $true
            return $result
        }

        $choice = $resp.choices[0]
        $msg = $choice.message
        $assistantMsg = @{ role = 'assistant'; content = $msg.content }
        if ($msg.tool_calls) { $assistantMsg.tool_calls = $msg.tool_calls }
        $Messages.Add($assistantMsg)

        if ($resp.usage) {
            $script:TotalPromptTokens += [int]$resp.usage.prompt_tokens
            $script:TotalCompletionTokens += [int]$resp.usage.completion_tokens
        }

        if ($choice.finish_reason -ne 'tool_calls' -or -not $msg.tool_calls) {
            $result.FinalText = $msg.content
            $result.FinishReason = $choice.finish_reason
            if ($Depth -eq 0) {
                if ($msg.content -and -not $resp._printed) {
                    Write-Host ''
                    Write-KakunaMarkdown $msg.content
                }
                if ($choice.finish_reason -eq 'length') {
                    Write-KakunaNote '(output was cut off by max_output_tokens — /config to raise it)'
                }
            }
            return $result
        }

        foreach ($tc in $msg.tool_calls) {
            $toolResult = Invoke-KakunaToolCall -ToolCall $tc -Depth $Depth
            $Messages.Add(@{
                role         = 'tool'
                tool_call_id = $tc.id
                content      = (Limit-ToolOutput $toolResult)
            })
        }

        if ($Depth -eq 0) {
            Add-BackgroundTaskNotices -Messages $Messages
            Invoke-ContextCompaction -Messages $Messages
        }
    }
    Write-KakunaError "Reached the maximum of $MaxRounds tool rounds without a final answer."
    $result.FinalText = '(max tool rounds reached without a final answer)'
    $result.FinishReason = 'max_rounds'
    return $result
}

function Invoke-AgentTurn {
    param([string]$UserText)
    Register-KakunaSkillTool   # cheap rescan: picks up skills created mid-session
    $hook = Invoke-KakunaHooks -Event 'UserPromptSubmit' -Prompt $UserText
    if ($hook.Block) { Write-KakunaError "prompt blocked by hook: $($hook.Reason)"; return }
    $expanded = Expand-FileReferences $UserText
    $script:Messages.Add(@{ role = 'user'; content = $expanded })
    Add-BackgroundTaskNotices -Messages $script:Messages
    $r = Invoke-AgentLoop -Messages $script:Messages -MaxRounds $script:MaxToolRounds -Depth 0 -AllowStream
    if (-not $r.Aborted) {
        Write-Host ''
        Write-KakunaNote (Get-KakunaCostLine)
        [void](Invoke-KakunaHooks -Event 'Stop' -LastMessage ([string]$r.FinalText))
    }
}

# --- @file references -------------------------------------------------------

function Expand-FileReferences {
    param([string]$Text)
    $appendix = ''
    foreach ($m in [regex]::Matches($Text, '(?<=^|\s)@([\w.\\/:~-]+)')) {
        $p = $m.Groups[1].Value
        $abs = $null
        try { $abs = Resolve-KakunaPath $p } catch { continue }
        if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { continue }
        $len = (Get-Item -LiteralPath $abs).Length
        if ($len -gt 262144) {
            $appendix += "`n--- @file: $abs is too large to inline ($([Math]::Round($len / 1KB)) KB) — use log_stats/log_slice/read_file on it ---"
            continue
        }
        $appendix += "`n--- @file: $abs ---`n$([System.IO.File]::ReadAllText($abs))"
    }
    if ($appendix) { return $Text + "`n" + $appendix }
    return $Text
}

# --- subagents (task tool) --------------------------------------------------

Register-KakunaTool -Name 'task' -ReadOnly $true `
    -Description "Delegate a self-contained investigation to a subagent with its own fresh context. It can use every tool except task, works autonomously, and returns only its final report. Use for scoped side-work whose intermediate details you don't need." `
    -Parameters @{
        type       = 'object'
        properties = @{
            description = @{ type = 'string'; description = '3-6 word summary shown to the user' }
            prompt      = @{ type = 'string'; description = 'Complete, self-contained task instructions for the subagent' }
        }
        required   = @('description', 'prompt')
    } -Handler {
        param($a)
        Write-Host "$($script:Theme.Accent)◇ subagent: $(Protect-TerminalText ([string]$a.description))$($script:Theme.Reset)"
        $child = [System.Collections.Generic.List[object]]::new()
        $child.Add(@{ role = 'system'; content = (Get-KakunaSystemPrompt -Subagent) })
        $child.Add(@{ role = 'user'; content = [string]$a.prompt })
        $r = Invoke-AgentLoop -Messages $child -MaxRounds 25 -Depth 1 -ExcludeTools @('task')
        if ($r.Aborted) { return 'ERROR: subagent aborted by user' }
        if (-not $r.FinalText) { return 'ERROR: subagent returned no result' }
        Write-KakunaNote "  ◇ subagent finished ($($r.Rounds) rounds)"
        return [string]$r.FinalText
    }

# --- context management -----------------------------------------------------

function Get-MessageCharCount {
    param($M)
    $chars = 0
    if ($M.content) { $chars += ([string]$M.content).Length }
    if ($M.tool_calls) {
        foreach ($tc in @($M.tool_calls)) {
            $chars += ([string]$tc.function.name).Length + ([string]$tc.function.arguments).Length + 40
        }
    }
    return $chars
}

function Get-TranscriptCharCount {
    param([System.Collections.Generic.List[object]]$Messages = $script:Messages)
    $chars = 0
    foreach ($m in $Messages) { $chars += Get-MessageCharCount $m }
    return $chars
}

function Invoke-TranscriptTrim {
    # Hard fallback: drop the oldest messages (after the system prompt) until
    # under budget, always removing an assistant-with-tool_calls together with
    # all of its tool results.
    param([System.Collections.Generic.List[object]]$Messages = $script:Messages)
    $budget = [int]$script:Config.context_char_budget
    if ((Get-TranscriptCharCount $Messages) -le $budget) { return }
    $marker = '[earlier conversation trimmed]'
    $trimmed = $false
    while ((Get-TranscriptCharCount $Messages) -gt $budget -and $Messages.Count -gt 3) {
        $idx = 1
        if ($Messages[$idx].role -eq 'user' -and $Messages[$idx].content -eq $marker) { $idx = 2 }
        if ($idx -ge $Messages.Count - 1) { break }   # never eat the in-flight turn
        $m = $Messages[$idx]
        $Messages.RemoveAt($idx)
        if ($m.role -eq 'assistant' -and $m.tool_calls) {
            while ($idx -lt $Messages.Count -and $Messages[$idx].role -eq 'tool') {
                $Messages.RemoveAt($idx)
            }
        }
        $trimmed = $true
    }
    if ($trimmed) {
        if (-not ($Messages.Count -gt 1 -and $Messages[1].content -eq $marker)) {
            $Messages.Insert(1, @{ role = 'user'; content = $marker })
        }
        Write-KakunaNote '(trimmed earlier conversation to stay within the context budget)'
    }
}

function Invoke-ContextCompaction {
    # Summarize old exchanges into one message instead of deleting them.
    # Only called at legal boundaries (turn start / between tool rounds).
    param(
        [System.Collections.Generic.List[object]]$Messages = $script:Messages,
        [switch]$Force
    )
    $budget = [int]$script:Config.context_char_budget
    if (-not $Force -and (Get-TranscriptCharCount $Messages) -le 0.8 * $budget) { return }
    if ($Messages.Count -lt 4) { return }

    $cut = -1
    if ($Force) {
        $cut = $Messages.Count
    } else {
        # walk back from the end: the cut lands on a user message and keeps
        # the tail (cut..end) within ~25% of budget — the in-flight turn always survives
        $tailBudget = [int](0.25 * $budget)
        $chars = 0
        for ($i = $Messages.Count - 1; $i -ge 2; $i--) {
            $chars += Get-MessageCharCount $Messages[$i]
            if ($Messages[$i].role -eq 'user') {
                if ($chars -le $tailBudget) { $cut = $i } else { break }
            }
        }
        if ($cut -lt 2) { Invoke-TranscriptTrim $Messages; return }
    }

    $sb = [System.Text.StringBuilder]::new()
    for ($i = 1; $i -lt $cut; $i++) {
        $m = $Messages[$i]
        switch ([string]$m.role) {
            'user' { [void]$sb.AppendLine("USER: $($m.content)") }
            'assistant' {
                if ($m.content) { [void]$sb.AppendLine("ASSISTANT: $($m.content)") }
                foreach ($tc in @($m.tool_calls)) {
                    if ($tc) { [void]$sb.AppendLine("  → called $($tc.function.name)($($tc.function.arguments))") }
                }
            }
            'tool' {
                $c = [string]$m.content
                if ($c.Length -gt 500) { $c = $c.Substring(0, 500) + '…' }
                [void]$sb.AppendLine("  ← result: $c")
            }
        }
    }

    $summary = $null
    try {
        $req = [System.Collections.Generic.List[object]]::new()
        $req.Add(@{ role = 'system'; content = $script:CompactSystemPrompt })
        $req.Add(@{ role = 'user'; content = "Summarize this conversation so the agent can continue:`n`n$($sb.ToString())" })
        $resp = Invoke-OpenAIChat -Messages $req -SpinnerLabel 'compacting…'
        if ($resp.Aborted) { return }
        $summary = $resp.choices[0].message.content
        if (-not $summary) { throw 'empty summary' }
    } catch {
        Write-KakunaNote "(compaction failed: $($_.Exception.Message) — trimming instead)"
        Invoke-TranscriptTrim $Messages
        return
    }

    for ($i = 1; $i -lt $cut; $i++) { $Messages.RemoveAt(1) }
    $Messages.Insert(1, @{ role = 'user'; content = "[Conversation summary — earlier messages compacted]`n$summary" })
    Write-KakunaNote '(compacted earlier conversation)'
}
