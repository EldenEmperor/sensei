# agent.ps1 — the agentic loop: model → tool_calls → dispatch → results → repeat.

$script:MaxToolRounds = 40
$script:TotalPromptTokens = 0
$script:TotalCompletionTokens = 0

function Show-ToolCall {
    param([string]$Name, [hashtable]$ToolArgs)
    $argStr = ''
    if ($ToolArgs -and $ToolArgs.Count -gt 0) {
        $argStr = ($ToolArgs.GetEnumerator() | ForEach-Object {
            $v = [string]$_.Value
            $v = $v -replace '\r?\n', '⏎'
            if ($v.Length -gt 70) { $v = $v.Substring(0, 67) + '…' }
            "$($_.Key)=$v"
        }) -join ' '
    }
    Write-Host "$($script:Theme.Accent)● $Name$($script:Theme.Reset) $($script:Theme.Dim)$(Protect-TerminalText $argStr)$($script:Theme.Reset)"
}

function Invoke-AgentTurn {
    param([string]$UserText)
    $script:Messages.Add(@{ role = 'user'; content = $UserText })

    for ($round = 1; $round -le $script:MaxToolRounds; $round++) {
        try {
            $resp = Invoke-OpenAIChat -Messages $script:Messages -ToolSpecs (Get-ToolSpecs)
        } catch {
            Write-KakunaError "$($_.Exception.Message)"
            return
        }

        $choice = $resp.choices[0]
        $msg = $choice.message
        $assistantMsg = @{ role = 'assistant'; content = $msg.content }
        if ($msg.tool_calls) { $assistantMsg.tool_calls = $msg.tool_calls }
        $script:Messages.Add($assistantMsg)

        if ($resp.usage) {
            $script:TotalPromptTokens += [int]$resp.usage.prompt_tokens
            $script:TotalCompletionTokens += [int]$resp.usage.completion_tokens
        }

        if ($choice.finish_reason -ne 'tool_calls' -or -not $msg.tool_calls) {
            if ($msg.content) {
                Write-Host ''
                Write-KakunaMarkdown $msg.content
            }
            if ($choice.finish_reason -eq 'length') {
                Write-KakunaNote '(output was cut off by max_output_tokens — /config to raise it)'
            }
            Write-Host ''
            Write-KakunaNote ('tokens ~{0:n1}k in / {1:n1}k out | model {2}{3}' -f `
                ($script:TotalPromptTokens / 1000.0), ($script:TotalCompletionTokens / 1000.0), (Get-ActiveModel),
                $(if ($script:LocalMode) { ' (local)' } else { '' }))
            return
        }

        foreach ($tc in $msg.tool_calls) {
            $name = [string]$tc.function.name
            $tool = $script:ToolRegistry[$name]
            $result = $null

            if (-not $tool) {
                $result = "ERROR: unknown tool '$name'"
            } else {
                $toolArgs = @{}
                try {
                    if ($tc.function.arguments) {
                        $parsed = $tc.function.arguments | ConvertFrom-Json -AsHashtable
                        if ($parsed) { $toolArgs = $parsed }
                    }
                } catch {
                    $result = "ERROR: tool arguments were not valid JSON: $($_.Exception.Message)"
                }
                if ($null -eq $result) {
                    Show-ToolCall $name $toolArgs
                    if (-not (Request-ToolPermission -Name $name -Tool $tool -ToolArgs $toolArgs)) {
                        Write-KakunaNote '  denied'
                        $result = "ERROR: user denied permission for $name"
                    } else {
                        try {
                            $result = @(& $tool.Handler $toolArgs) -join "`n"
                        } catch {
                            $result = "ERROR: $($_.Exception.Message)"
                        }
                    }
                }
            }

            $script:Messages.Add(@{
                role         = 'tool'
                tool_call_id = $tc.id
                content      = (Limit-ToolOutput $result)
            })
        }

        Invoke-TranscriptTrim
    }
    Write-KakunaError "Reached the maximum of $script:MaxToolRounds tool rounds without a final answer."
}

# --- context management ----------------------------------------------------

function Get-TranscriptCharCount {
    $chars = 0
    foreach ($m in $script:Messages) {
        if ($m.content) { $chars += ([string]$m.content).Length }
        if ($m.tool_calls) { $chars += (ConvertTo-Json -InputObject $m.tool_calls -Depth 10 -Compress).Length }
    }
    return $chars
}

function Invoke-TranscriptTrim {
    # Drop the oldest messages (after the system prompt) until under budget,
    # always removing an assistant-with-tool_calls together with all of its
    # tool results — a dangling pair makes the API reject the transcript.
    $budget = [int]$script:Config.context_char_budget
    if ((Get-TranscriptCharCount) -le $budget) { return }
    $marker = '[earlier conversation trimmed]'
    $trimmed = $false
    while ((Get-TranscriptCharCount) -gt $budget -and $script:Messages.Count -gt 3) {
        $idx = 1
        if ($script:Messages[$idx].role -eq 'user' -and $script:Messages[$idx].content -eq $marker) { $idx = 2 }
        if ($idx -ge $script:Messages.Count - 1) { break }   # never eat the in-flight turn
        $m = $script:Messages[$idx]
        $script:Messages.RemoveAt($idx)
        if ($m.role -eq 'assistant' -and $m.tool_calls) {
            while ($idx -lt $script:Messages.Count -and $script:Messages[$idx].role -eq 'tool') {
                $script:Messages.RemoveAt($idx)
            }
        }
        $trimmed = $true
    }
    if ($trimmed) {
        if (-not ($script:Messages.Count -gt 1 -and $script:Messages[1].content -eq $marker)) {
            $script:Messages.Insert(1, @{ role = 'user'; content = $marker })
        }
        Write-KakunaNote '(trimmed earlier conversation to stay within the context budget)'
    }
}
