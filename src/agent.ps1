# agent.ps1 — the agentic loop, tool dispatch, subagents, @file expansion,
# and context compaction.

$script:MaxToolRounds = 40
$script:TotalPromptTokens = 0
$script:TotalCompletionTokens = 0
$script:Todos = @()

# auto_continue: when a turn ends with a tutorial telling the USER what to run,
# nudge the model once with this note and give it another round to act itself.
$script:AutoContinueNote = '<system-note>Your last reply described steps for the user to perform instead of performing them. You have run_powershell and file tools: do the task NOW yourself. If a command fails, read exit_code and stderr, diagnose, and try a different approach (2-3 attempts) before giving up. No UAC elevation is possible - prefer user-scoped installs (winget --scope user, pip --user, -Scope CurrentUser) and non-interactive flags. Only stop to ask the user if truly blocked (explicit permission denial, or elevation is genuinely unavoidable). Do not repeat instructions to the user - act.</system-note>'

function Test-SenseiPassiveReply {
    # Heuristic: does this final-looking assistant message read like a tutorial
    # telling the USER to run things, instead of the agent doing them itself?
    param([string]$Content)
    if (-not $Content) { return $false }
    # the non-streaming path keeps <think> blocks (openai.ps1 strips only when streaming)
    $t = [regex]::Replace($Content, '(?s)<think>.*?</think>', '')
    if ($t -match '(?im)^\s*(?:#+\s*|\*{1,2}|\d+[.)]\s*)*step\s+\d') { return $true }
    $markers = @(
        '(?i)\b(?:run|execute|paste|type)\s+(?:this|that|these|the following)\b'
        '(?i)\bfollowing\s+(?:command|script|steps?)\b'
        '(?i)\bas\s+(?:an?\s+)?administrator\b'
        '(?i)\byou\s+can\s+(?:run|install|then\s+run)\b'
        '(?im)^\s*let me know\b'
        '(?im)^\s*(?:then\s+)?(?:open|launch|start)\s+(?:powershell|windows\s+terminal|a\s+terminal|cmd)\b'
    )
    $hits = 0
    foreach ($rx in $markers) { if ($t -match $rx) { $hits++ } }
    return ($hits -ge 2)
}

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

function Invoke-SenseiToolCall {
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

    $hook = Invoke-SenseiHooks -Event 'PreToolUse' -ToolName $name -ToolInput $toolArgs
    if ($hook.Block) { return "ERROR: blocked by PreToolUse hook: $($hook.Reason)" }

    if (-not (Request-ToolPermission -Name $name -Tool $tool -ToolArgs $toolArgs)) {
        if ($script:PlanMode) {
            Write-SenseiNote '  (plan mode: blocked)'
            return "ERROR: plan mode is read-only — you cannot run $name yet. Finish researching, then call exit_plan_mode with your plan for the user to approve."
        }
        Write-SenseiNote '  denied'
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
    [void](Invoke-SenseiHooks -Event 'PostToolUse' -ToolName $name -ToolInput $toolArgs -ToolResponse ([string]$out))
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
    $nudged = $false
    for ($round = 1; $round -le $MaxRounds; $round++) {
        $result.Rounds = $round
        $resp = $null
        try {
            $resp = Invoke-OpenAIChat -Messages $Messages -ToolSpecs (Get-ToolSpecs -Exclude $ExcludeTools) `
                -AllowStream:($AllowStream -and $Depth -eq 0)
        } catch {
            Write-SenseiError "$($_.Exception.Message)"
            $result.FinalText = "ERROR: $($_.Exception.Message)"
            $result.FinishReason = 'error'
            return $result
        }
        if ($resp.Aborted) {
            Write-SenseiNote '(request aborted)'
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

        if (-not $msg.tool_calls) {
            # auto_continue: passive tutorial answer with tools available → nudge once and re-run
            if ($Depth -eq 0 -and -not $nudged -and [bool]$script:Config.auto_continue -and
                -not $script:PlanMode -and $choice.finish_reason -ne 'length' -and
                $round -lt $MaxRounds -and (Test-SenseiPassiveReply -Content ([string]$msg.content))) {
                $nudged = $true
                Write-SenseiNote '(auto-continue: doing it rather than describing it)'
                $Messages.Add(@{ role = 'user'; content = $script:AutoContinueNote })
                continue
            }
            $result.FinalText = $msg.content
            $result.FinishReason = $choice.finish_reason
            if ($Depth -eq 0) {
                if ($msg.content -and -not $resp._printed) {
                    Write-Host ''
                    Write-SenseiMarkdown $msg.content
                }
                if ($choice.finish_reason -eq 'length') {
                    Write-SenseiNote '(output was cut off by max_output_tokens — /config to raise it)'
                }
            }
            return $result
        }

        foreach ($tc in $msg.tool_calls) {
            $toolResult = Invoke-SenseiToolCall -ToolCall $tc -Depth $Depth
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
    Write-SenseiError "Reached the maximum of $MaxRounds tool rounds without a final answer."
    $result.FinalText = '(max tool rounds reached without a final answer)'
    $result.FinishReason = 'max_rounds'
    return $result
}

function Invoke-AgentTurn {
    param([string]$UserText)
    Register-SenseiSkillTool   # cheap rescan: picks up skills created mid-session
    $hook = Invoke-SenseiHooks -Event 'UserPromptSubmit' -Prompt $UserText
    if ($hook.Block) { Write-SenseiError "prompt blocked by hook: $($hook.Reason)"; return }
    $expanded = Expand-FileReferences $UserText
    $script:Messages.Add(@{ role = 'user'; content = $expanded })
    Add-BackgroundTaskNotices -Messages $script:Messages
    $startCount = $script:Messages.Count
    $r = Invoke-AgentLoop -Messages $script:Messages -MaxRounds $script:MaxToolRounds -Depth 0 -AllowStream
    if (-not $r.Aborted) {
        Invoke-AutoVerify -StartIndex $startCount
        Write-Host ''
        Write-SenseiNote (Get-SenseiCostLine)
        [void](Invoke-SenseiHooks -Event 'Stop' -LastMessage ([string]$r.FinalText))
    }
}

function Invoke-AutoVerify {
    # If auto_verify is on and this turn wrote to files, run one independent
    # verifier over the changes and surface its verdict.
    param([int]$StartIndex)
    if (-not $script:Config.auto_verify -or $script:PlanMode) { return }
    $writeTools = 'write_file', 'edit_file', 'multi_edit'
    $wrote = $false
    for ($i = $StartIndex; $i -lt $script:Messages.Count; $i++) {
        $m = $script:Messages[$i]
        if ($m.role -eq 'assistant' -and $m.tool_calls) {
            foreach ($tc in @($m.tool_calls)) { if ([string]$tc.function.name -in $writeTools) { $wrote = $true } }
        }
    }
    if (-not $wrote) { return }
    Write-SenseiNote 'auto-verify: checking the changes…'
    $child = [System.Collections.Generic.List[object]]::new()
    $child.Add(@{ role = 'system'; content = (Get-SenseiSystemPrompt -Subagent) })
    $child.Add(@{ role = 'user'; content = 'The agent just modified one or more files in this directory to satisfy the user. Inspect the current state of those files with read-only tools and judge whether the change is correct and complete. Reply starting with PASS or FAIL, then brief evidence.' })
    $r = Invoke-AgentLoop -Messages $child -MaxRounds 12 -Depth 1 -ExcludeTools @('task', 'task_parallel', 'verify', 'exit_plan_mode')
    if ($r.FinalText) {
        Write-Host ''
        Write-Host "$($script:Theme.Accent)auto-verify:$($script:Theme.Reset) $(Protect-TerminalText ([string]$r.FinalText))"
    }
}

# --- @file references -------------------------------------------------------

function Expand-FileReferences {
    param([string]$Text)
    $appendix = ''
    foreach ($m in [regex]::Matches($Text, '(?<=^|\s)@([\w.\\/:~-]+)')) {
        $p = $m.Groups[1].Value
        $abs = $null
        try { $abs = Resolve-SenseiPath $p } catch { continue }
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

Register-SenseiTool -Name 'task' -ReadOnly $true `
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
        $child.Add(@{ role = 'system'; content = (Get-SenseiSystemPrompt -Subagent) })
        $child.Add(@{ role = 'user'; content = [string]$a.prompt })
        $r = Invoke-AgentLoop -Messages $child -MaxRounds 25 -Depth 1 -ExcludeTools @('task', 'task_parallel', 'verify', 'exit_plan_mode')
        if ($r.Aborted) { return 'ERROR: subagent aborted by user' }
        if (-not $r.FinalText) { return 'ERROR: subagent returned no result' }
        Write-SenseiNote "  ◇ subagent finished ($($r.Rounds) rounds)"
        return [string]$r.FinalText
    }

# --- verify (independent check via a fresh subagent) -----------------------

Register-SenseiTool -Name 'verify' -ReadOnly $true `
    -Description 'Independently verify a claim or that a change is correct. Spawns a fresh subagent with read-only tools that checks the claim against the actual files/logs and reports PASS or FAIL with evidence. Use before asserting something important is fixed or true.' `
    -Parameters @{
        type       = 'object'
        properties = @{ claim = @{ type = 'string'; description = 'The specific claim to verify' } }
        required   = @('claim')
    } -Handler {
        param($a)
        Write-Host "$($script:Theme.Accent)◇ verify: $(Protect-TerminalText ([string]$a.claim))$($script:Theme.Reset)"
        $child = [System.Collections.Generic.List[object]]::new()
        $child.Add(@{ role = 'system'; content = (Get-SenseiSystemPrompt -Subagent) })
        $child.Add(@{ role = 'user'; content = "Independently verify this claim by inspecting the actual files/logs with read-only tools. Do not assume it is true. Reply starting with PASS or FAIL, then the evidence (path:line):`n`n$($a.claim)" })
        $r = Invoke-AgentLoop -Messages $child -MaxRounds 15 -Depth 1 -ExcludeTools @('task', 'verify', 'task_parallel')
        if ($r.Aborted) { return 'ERROR: verification aborted' }
        Write-SenseiNote '  ◇ verify finished'
        return [string]$r.FinalText
    }

# --- exit_plan_mode --------------------------------------------------------

Register-SenseiTool -Name 'exit_plan_mode' -ReadOnly $true `
    -Description 'Call this when, in plan mode, your plan is ready. Presents the plan to the user for approval; if approved, plan mode ends and you may execute it.' `
    -Parameters @{
        type       = 'object'
        properties = @{ plan = @{ type = 'string'; description = 'The plan, as a concise numbered list' } }
        required   = @('plan')
    } -Handler {
        param($a)
        if (-not $script:PlanMode) { return 'Not in plan mode; nothing to exit.' }
        Write-Host ''
        Write-Host "$($script:Theme.Bold)$($script:Theme.Accent)Proposed plan:$($script:Theme.Reset)"
        Write-SenseiMarkdown ([string]$a.plan)
        Write-Host ''
        if ($script:PrintMode -or [Console]::IsInputRedirected) {
            return 'Plan recorded (non-interactive; still in plan mode — the user will review).'
        }
        $ans = (Read-Host '  Approve this plan and let Sensei execute it? [y/N]').Trim().ToLower()
        if ($ans -in 'y', 'yes') {
            $script:PlanMode = $false
            return 'APPROVED — plan mode is now off. Proceed to execute the plan.'
        }
        return 'The user did NOT approve the plan. Stay in plan mode; ask what they want to change.'
    }

# --- task_parallel (bounded concurrent subagents) --------------------------

Register-SenseiTool -Name 'task_parallel' -ReadOnly $true `
    -Description 'Run up to 3 independent subagent investigations concurrently and return all their reports. Use for genuinely independent side-work (e.g. analyzing several logs at once). Each runs in isolation and cannot ask the user questions.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            tasks = @{
                type  = 'array'
                items = @{
                    type       = 'object'
                    properties = @{
                        description = @{ type = 'string' }
                        prompt      = @{ type = 'string' }
                    }
                    required   = @('description', 'prompt')
                }
            }
        }
        required   = @('tasks')
    } -Handler {
        param($a)
        $tasks = @($a.tasks)
        if ($tasks.Count -eq 0) { return 'ERROR: no tasks provided' }
        if ($tasks.Count -gt 3) { $tasks = $tasks[0..2] }
        foreach ($t in $tasks) { Write-Host "$($script:Theme.Accent)◇ parallel task: $(Protect-TerminalText ([string]$t.description))$($script:Theme.Reset)" }

        $canThread = $null -ne (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue)
        if (-not $canThread) {
            # sequential fallback — still correct, just not concurrent
            $out = for ($i = 0; $i -lt $tasks.Count; $i++) {
                $child = [System.Collections.Generic.List[object]]::new()
                $child.Add(@{ role = 'system'; content = (Get-SenseiSystemPrompt -Subagent) })
                $child.Add(@{ role = 'user'; content = [string]$tasks[$i].prompt })
                $r = Invoke-AgentLoop -Messages $child -MaxRounds 20 -Depth 1 -ExcludeTools @('task', 'task_parallel', 'verify')
                "## Task $($i + 1): $($tasks[$i].description)`n$($r.FinalText)"
            }
            return ($out -join "`n`n") + "`n`n(note: ran sequentially — Start-ThreadJob unavailable)"
        }

        $root = $script:SenseiRoot
        $local = $script:LocalMode
        $model = Get-ActiveModel
        $jobs = foreach ($t in $tasks) {
            Start-ThreadJob -ArgumentList $root, $local, $model, ([string]$t.prompt) -ScriptBlock {
                param($Root, $Local, $Model, $Prompt)
                $script:SenseiRoot = $Root; $script:SenseiVersion = 'subagent'
                $script:YoloMode = $false; $script:LocalMode = $Local; $script:PrintMode = $true; $script:PlanMode = $false
                foreach ($f in 'render','config','input','permissions','hooks','tools','skills','tasks','logtools','prompts','openai','agent','mcp','repl') {
                    . (Join-Path $Root "src\$f.ps1")
                }
                Initialize-SenseiConfig
                if ($Local) { $script:Config.local_model = $Model } else { $script:Config.model = $Model }
                $script:Messages = [System.Collections.Generic.List[object]]::new()
                $child = [System.Collections.Generic.List[object]]::new()
                $child.Add(@{ role = 'system'; content = (Get-SenseiSystemPrompt -Subagent) })
                $child.Add(@{ role = 'user'; content = $Prompt })
                $r = Invoke-AgentLoop -Messages $child -MaxRounds 20 -Depth 1 -ExcludeTools @('task','task_parallel','verify')
                return [string]$r.FinalText
            }
        }
        $null = Wait-Job -Job $jobs -Timeout 600
        $out = for ($i = 0; $i -lt $tasks.Count; $i++) {
            $res = try { Receive-Job -Job $jobs[$i] -ErrorAction Stop } catch { "ERROR: $($_.Exception.Message)" }
            if ($jobs[$i].State -eq 'Running') { $res = '(timed out)'; Stop-Job -Job $jobs[$i] }
            "## Task $($i + 1): $($tasks[$i].description)`n$(@($res) -join "`n")"
        }
        Remove-Job -Job $jobs -Force -ErrorAction SilentlyContinue
        Write-SenseiNote "  ◇ $($tasks.Count) parallel tasks finished"
        return ($out -join "`n`n")
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
        Write-SenseiNote '(trimmed earlier conversation to stay within the context budget)'
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
        Write-SenseiNote "(compaction failed: $($_.Exception.Message) — trimming instead)"
        Invoke-TranscriptTrim $Messages
        return
    }

    for ($i = 1; $i -lt $cut; $i++) { $Messages.RemoveAt(1) }
    $Messages.Insert(1, @{ role = 'user'; content = "[Conversation summary — earlier messages compacted]`n$summary" })
    Write-SenseiNote '(compacted earlier conversation)'
}
