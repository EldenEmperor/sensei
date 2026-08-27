# smoke.ps1 — offline checks of the whole Kakuna toolchain. No API key needed.
# Run with:  pwsh -NoProfile -File tests\smoke.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# --- minimal harness state, then dot-source everything ----------------------
$script:KakunaRoot = $root
$script:KakunaVersion = '0.0.0-test'
$script:YoloMode = $true
$script:LocalMode = $false
$script:PrintMode = $false
$script:SessionId = 'smoke-test'

foreach ($f in 'render', 'config', 'input', 'permissions', 'hooks', 'tools', 'skills', 'tasks', 'logtools', 'prompts', 'openai', 'agent', 'mcp', 'repl') {
    . (Join-Path $root "src\$f.ps1")
}

# hermetic config: never touch the user's real ~/.kakuna
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "kakuna-smoke-$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$script:ConfigDir = Join-Path $tmp 'kakuna-home'
$script:SessionDir = Join-Path $script:ConfigDir 'sessions'
New-Item -ItemType Directory -Force -Path $script:ConfigDir, $script:SessionDir | Out-Null
$script:Config = @{} + $script:DefaultConfig
$script:ProjectConfig = @{}
$script:Messages = [System.Collections.Generic.List[object]]::new()

$script:fail = 0
function Assert {
    param([bool]$Cond, [string]$Name)
    if ($Cond) { Write-Host "  ok    $Name" }
    else { Write-Host "  FAIL  $Name"; $script:fail++ }
}
function Invoke-Tool {
    param([string]$Name, [hashtable]$ToolArgs)
    return @(& $script:ToolRegistry[$Name].Handler $ToolArgs) -join "`n"
}

# ============================================================ core tools (v1)
Write-Host 'core tools:'
$r = Invoke-Tool 'write_file' @{ path = "$tmp\x.txt"; content = "alpha`nbeta`ngamma" }
Assert ($r -match 'Wrote') 'write_file'
$r = Invoke-Tool 'read_file' @{ path = "$tmp\x.txt" }
Assert ($r -match '2→beta') 'read_file line numbers'
$r = Invoke-Tool 'read_file' @{ path = "$tmp\x.txt"; offset = 2; limit = 1 }
Assert ($r -match 'beta' -and $r -notmatch 'alpha' -and $r -match 'offset=3') 'read_file offset/limit'
$r = Invoke-Tool 'edit_file' @{ path = "$tmp\x.txt"; old_string = 'beta'; new_string = 'BETA' }
Assert ($r -match 'Edited') 'edit_file'
$r = Invoke-Tool 'edit_file' @{ path = "$tmp\x.txt"; old_string = 'a'; new_string = 'A' }
Assert ($r -match 'ERROR' -and $r -match 'times') 'edit_file uniqueness enforced'
$r = Invoke-Tool 'glob' @{ pattern = '**/*.ps1'; path = $root }
Assert ($r -match 'tools\.ps1' -and $r -match 'kakuna\.ps1') 'glob recursive'
$r = Invoke-Tool 'grep' @{ pattern = 'Register-KakunaTool'; path = (Join-Path $root 'src') }
Assert ($r -match 'tools\.ps1' -and $r -match 'logtools\.ps1') 'grep files_with_matches'
$r = Invoke-Tool 'run_powershell' @{ command = 'Write-Output hello; exit 3' }
Assert ($r -match 'exit_code: 3' -and $r -match 'hello') 'run_powershell exit code + stdout'

# ============================================================ log tools (v1)
Write-Host 'log tools (generating synthetic log)…'
$log = Join-Path $tmp 'app.log'
& (Join-Path $PSScriptRoot 'New-TestLog.ps1') -Path $log -Lines 200000 | Out-Null
$answers = Get-Content -Raw "$log.answers.json" | ConvertFrom-Json -AsHashtable
$stats = Invoke-Tool 'log_stats' @{ path = $log }
$statLines = if ($stats -match 'lines: ([\d,]+)') { [int]($Matches[1] -replace ',', '') } else { -1 }
Assert ($statLines -eq $answers.total_lines) 'log_stats total lines'
$statErr = if ($stats -match 'ERROR: (\d+)') { [int]$Matches[1] } else { -1 }
Assert ($statErr -eq $answers.error_total) 'log_stats ERROR count'
Assert ($stats -match 'FATAL: 1' -and $stats -match 'OutOfMemoryException') 'log_stats FATAL + OOM template'
$r = Invoke-Tool 'log_slice' @{ path = $log; tail = 5 }
Assert ($r -match ('{0}→' -f $answers.total_lines)) 'log_slice tail reaches last line'
$r = Invoke-Tool 'log_slice' @{ path = $log; from_time = '2026-08-27 02:46:30'; to_time = '2026-08-27 02:47:30' }
Assert ($r -match 'OutOfMemoryException') 'log_slice time range catches crash'

# ============================================================ input fallback
Write-Host 'input:'
Initialize-KakunaInput
Assert (-not $script:UsePSReadLine) 'PSReadLine fallback when stdin redirected'

# ============================================================ SSE parser
Write-Host 'sse parser:'
$acc = New-SseAccumulator
$done = $false
foreach ($line in (Get-Content (Join-Path $PSScriptRoot 'fixtures\sse-tool-calls.txt'))) {
    $d = Add-SseLine -A $acc -Line $line
    if ($d.Done) { $done = $true; break }
}
$resp = Complete-SseAccumulator -A $acc
Assert $done 'SSE [DONE] detected'
Assert ($resp.choices[0].message.content -eq 'Hello world') 'SSE content assembled'
$tc = @($resp.choices[0].message.tool_calls)
Assert ($tc.Count -eq 2) 'SSE two tool calls'
Assert ($tc[0].id -eq 'call_a' -and $tc[0].function.arguments -eq '{"pattern":"x"}') 'SSE fragmented arguments concatenated'
Assert ($tc[1].function.name -eq 'glob') 'SSE second tool call intact'
Assert ($resp.usage.prompt_tokens -eq 100 -and $resp.usage.completion_tokens -eq 20) 'SSE usage captured'
Assert ($resp.choices[0].finish_reason -eq 'tool_calls') 'SSE finish_reason'

# ============================================================ allowlist rules
Write-Host 'permissions:'
Assert (Test-KakunaAllowRule -Rule 'run_powershell(git status*)' -ToolName 'run_powershell' -PrimaryValue 'git status --short') 'rule: command prefix match'
Assert (-not (Test-KakunaAllowRule -Rule 'run_powershell(git status*)' -ToolName 'run_powershell' -PrimaryValue 'rm -rf /')) 'rule: command mismatch'
Assert (Test-KakunaAllowRule -Rule 'mcp__github__*' -ToolName 'mcp__github__create_issue') 'rule: wildcard tool name'
Assert (Test-KakunaAllowRule -Rule 'write_file(C:\logs\*)' -ToolName 'write_file' -PrimaryValue 'app.log' -ResolvedValue 'C:\logs\app.log') 'rule: resolved path match'
Assert (-not (Test-KakunaAllowRule -Rule 'write_file' -ToolName 'edit_file')) 'rule: bare name exact'
$script:Config.permissions = @{ allow = @('run_powershell(git *)') }
$script:YoloMode = $false
Assert (Request-ToolPermission -Name 'run_powershell' -Tool $script:ToolRegistry['run_powershell'] -ToolArgs @{ command = 'git log' }) 'allowlisted tool auto-allowed'
Assert (-not (Request-ToolPermission -Name 'run_powershell' -Tool $script:ToolRegistry['run_powershell'] -ToolArgs @{ command = 'del x' })) 'non-allowlisted denied when non-interactive'
$script:PrintMode = $true
Assert (-not (Request-ToolPermission -Name 'write_file' -Tool $script:ToolRegistry['write_file'] -ToolArgs @{ path = 'x' })) 'print mode denies gated tools'
$script:PrintMode = $false
$script:YoloMode = $true
$script:Config.permissions = @{ allow = @() }

# ============================================================ hooks
Write-Host 'hooks:'
$script:Config.hooks = @(@{ event = 'PreToolUse'; matcher = 'run_powershell'; command = '[Console]::Error.Write(''nope''); exit 2' })
$h = Invoke-KakunaHooks -Event 'PreToolUse' -ToolName 'run_powershell' -ToolInput @{ command = 'x' }
Assert ($h.Block -and $h.Reason -eq 'nope') 'PreToolUse exit-2 blocks with stderr reason'
$h = Invoke-KakunaHooks -Event 'PreToolUse' -ToolName 'read_file' -ToolInput @{}
Assert (-not $h.Block) 'hook matcher skips non-matching tool'
$script:Config.hooks = @(@{ event = 'PreToolUse'; matcher = ''; command = 'exit 0' })
$h = Invoke-KakunaHooks -Event 'PreToolUse' -ToolName 'read_file' -ToolInput @{}
Assert (-not $h.Block) 'exit-0 hook continues'
$script:Config.hooks = @()

# ============================================================ parity batch
Write-Host 'parity features:'
$r = Invoke-Tool 'todo_write' @{ todos = @(@{ content = 'a'; status = 'completed' }, @{ content = 'b'; status = 'in_progress' }) }
Assert ($r -match 'Todos updated \(2' -and @($script:Todos).Count -eq 2) 'todo_write'

$reffile = Join-Path $tmp 'ref.txt'
Set-Content -Path $reffile -Value 'REF_CONTENT_42'
$r = Expand-FileReferences "please look at @$reffile now"
Assert ($r -match 'REF_CONTENT_42' -and $r -match '--- @file:') '@file expansion'
$big = Join-Path $tmp 'big.bin'
[System.IO.File]::WriteAllBytes($big, [byte[]]::new(300000))
$r = Expand-FileReferences "check @$big"
Assert ($r -match 'too large to inline') '@file oversize note'

$cmdDir = Join-Path $tmp 'proj\.kakuna\commands'
New-Item -ItemType Directory -Force -Path $cmdDir | Out-Null
Set-Content -Path (Join-Path $cmdDir 'greet.md') -Value 'Say hello to $ARGUMENTS please'
Push-Location (Join-Path $tmp 'proj')
try {
    $p = Find-KakunaCustomCommand 'greet'
    Assert ($null -ne $p) 'custom command found'
    $content = (Get-Content -LiteralPath $p -Raw) -replace '\$ARGUMENTS', 'world'
    Assert ($content -match 'hello to world') 'custom command $ARGUMENTS substitution'
} finally { Pop-Location }

$script:TotalPromptTokens = 100000
$script:TotalCompletionTokens = 10000
$line = Get-KakunaCostLine
Assert ($line -match '100\.0k in' -and $line -match '\$') 'cost line with estimate'
$script:TotalPromptTokens = 0
$script:TotalCompletionTokens = 0

$html = ConvertFrom-KakunaHtml '<html><head><style>x{color:red}</style></head><body><h1>Title</h1><p>Hello <b>world</b></p><script>evil()</script></body></html>'
Assert ($html -match 'Title' -and $html -match 'Hello +world' -and $html -notmatch 'evil' -and $html -notmatch 'color:red') 'html stripped to text'

# resume round-trip (with an orphan tool message that must be dropped)
$sessionData = @(
    @{ role = 'system'; content = 'old system prompt' }
    @{ role = 'user'; content = 'question one' }
    @{ role = 'assistant'; content = $null; tool_calls = @(@{ id = 'c1'; type = 'function'; function = @{ name = 'glob'; arguments = '{}' } }) }
    @{ role = 'tool'; tool_call_id = 'c1'; content = 'glob result' }
    @{ role = 'assistant'; content = 'answer one' }
    @{ role = 'tool'; tool_call_id = 'orphan'; content = 'orphan result' }
    @{ role = 'user'; content = 'question two' }
)
$sessFile = Join-Path $tmp 'sess.json'
ConvertTo-Json -InputObject $sessionData -Depth 20 | Set-Content -Path $sessFile
$n = Restore-KakunaSession -Path $sessFile
Assert ($script:Messages[0].role -eq 'system' -and $script:Messages[0].content -match 'Kakuna') 'resume re-seeds fresh system prompt'
Assert ((@($script:Messages | Where-Object { $_.role -eq 'tool' })).Count -eq 1) 'resume drops orphan tool message'
Assert ($script:Messages[2].tool_calls[0].id -eq 'c1') 'resume preserves tool_call pair'
Assert ($script:Messages[-1].content -eq 'question two') 'resume keeps last user message'
$script:Messages = [System.Collections.Generic.List[object]]::new()
$script:SessionPath = $null

# KAKUNA.md memory
Set-Content -Path (Join-Path $script:ConfigDir 'KAKUNA.md') -Value 'GLOBAL_MEMORY_MARKER'
$sp = Get-KakunaSystemPrompt
Assert ($sp -match 'GLOBAL_MEMORY_MARKER' -and $sp -match 'Project memory') 'KAKUNA.md loaded into system prompt'
$sp2 = Get-KakunaSystemPrompt -Subagent
Assert ($sp2 -match 'Subagent mode') 'subagent preamble'

# ============================================================ skills
Write-Host 'skills:'
Push-Location $tmp   # no .kakuna\skills here, temp ConfigDir has none either
try {
    Register-KakunaSkillTool
    Assert (-not $script:ToolRegistry.Contains('skill')) 'skill tool absent when no skills exist'

    $skillDir = Join-Path $tmp 'proj\.kakuna\skills\demo'
    New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
    Set-Content -Path (Join-Path $skillDir 'SKILL.md') -Value @'
---
name: demo
description: "Demonstrates skills. Use when asked about the demo procedure."
---
Follow the DEMO_PROCEDURE_MARKER steps with $ARGUMENTS.
'@
    Set-Content -Path (Join-Path $skillDir 'helper.txt') -Value 'helper data'
    # bare skill: no frontmatter at all
    $bareDir = Join-Path $tmp 'proj\.kakuna\skills\bare'
    New-Item -ItemType Directory -Force -Path $bareDir | Out-Null
    Set-Content -Path (Join-Path $bareDir 'SKILL.md') -Value 'BARE_BODY_MARKER only'
    # user-level skill with the same name as the project one — project must win
    $userSkillDir = Join-Path $script:ConfigDir 'skills\demo'
    New-Item -ItemType Directory -Force -Path $userSkillDir | Out-Null
    Set-Content -Path (Join-Path $userSkillDir 'SKILL.md') -Value "---`nname: demo`ndescription: user copy`n---`nUSER_COPY_MARKER"

    Push-Location (Join-Path $tmp 'proj')
    try {
        $skills = @(Get-KakunaSkills)
        Assert ($skills.Count -eq 2) 'skills discovered (project demo + bare)'
        $demo = $skills | Where-Object { $_.Name -eq 'demo' }
        Assert ($demo.Description -match 'demo procedure' -and $demo.Source -eq 'project') 'frontmatter parsed, project shadows user'
        $bare = $skills | Where-Object { $_.Name -eq 'bare' }
        Assert ($null -ne $bare -and $bare.Description -eq '') 'frontmatter-less skill named from folder'

        Register-KakunaSkillTool
        Assert ($script:ToolRegistry.Contains('skill')) 'skill tool registered'
        Assert ($script:ToolRegistry['skill'].Description -match 'demo: Demonstrates') 'skill tool description lists skills'
        $r = Invoke-Tool 'skill' @{ name = 'demo' }
        Assert ($r -match 'DEMO_PROCEDURE_MARKER' -and $r -match [regex]::Escape($demo.Dir)) 'skill tool loads body + supporting-files path'
        Assert ($r -notmatch 'USER_COPY_MARKER') 'shadowed user skill not loaded'
        $r = Invoke-Tool 'skill' @{ name = 'nope' }
        Assert ($r -match 'ERROR' -and $r -match 'demo') 'unknown skill errors with available list'
        $p = Get-KakunaSkillPrompt -Skill $demo -Arguments 'the log file'
        Assert ($p -match 'steps with the log file' -and $p -match '# Skill: demo') 'skill prompt substitutes $ARGUMENTS'
        $p = Get-KakunaSkillPrompt -Skill $bare -Arguments 'xyz'
        Assert ($p -match 'User input: xyz') 'skill prompt appends args when no placeholder'
    } finally { Pop-Location }
} finally { Pop-Location }
Remove-Item -Recurse -Force (Join-Path $script:ConfigDir 'skills') -ErrorAction SilentlyContinue
Register-KakunaSkillTool   # back to zero-skill state for later sections

# ============================================================ background tasks
Write-Host 'background tasks:'
$r = Start-KakunaBackgroundTask -Command '1..3 | ForEach-Object { "tick $_" }; exit 7'
Assert ($r -match 'Started background task bg\d') 'bg task starts and returns immediately'
$bgId = if ($r -match '(bg\d+)') { $Matches[1] } else { '' }
$T = $script:BackgroundTasks[$bgId]
$waited = 0
while (-not $T.Process.HasExited -and $waited -lt 30000) { Start-Sleep -Milliseconds 250; $waited += 250 }
Assert ($T.Process.HasExited) 'bg task exits'
$r = Invoke-Tool 'task_output' @{ task_id = $bgId }
Assert ($r -match 'exited \(code 7\)' -and $r -match 'tick 3') 'task_output reads status + output'
$r = Invoke-Tool 'task_output' @{ task_id = $bgId }
Assert ($r -match 'no new output') 'task_output is incremental'
$scratch = [System.Collections.Generic.List[object]]::new()
Add-BackgroundTaskNotices -Messages $scratch
Assert ($scratch.Count -eq 1 -and $scratch[0].content -match "$bgId.*exited with code 7") 'exit notice injected as user message'
Add-BackgroundTaskNotices -Messages $scratch
Assert ($scratch.Count -eq 1) 'exit notice only injected once'

# ============================================================ agent loop (stubbed API)
Write-Host 'agent loop (stubbed api):'
$script:StubQueue = [System.Collections.Generic.Queue[object]]::new()
$script:StubSpecNames = [System.Collections.Generic.List[object]]::new()
function Invoke-OpenAIChat {
    param($Messages, $ToolSpecs, [switch]$AllowStream, [string]$SpinnerLabel = '')
    $script:StubSpecNames.Add(@(@($ToolSpecs) | ForEach-Object { $_.function.name }))
    return $script:StubQueue.Dequeue()
}

$script:StubQueue.Enqueue(@{
    choices = @(@{ message = @{ role = 'assistant'; content = $null; tool_calls = @(
        @{ id = 'call_1'; type = 'function'; function = @{ name = 'read_file'; arguments = (ConvertTo-Json -InputObject @{ path = "$tmp\x.txt" } -Compress) } }
    ) }; finish_reason = 'tool_calls' })
    usage = @{ prompt_tokens = 10; completion_tokens = 5 }
})
$script:StubQueue.Enqueue(@{
    choices = @(@{ message = @{ role = 'assistant'; content = 'the answer is 42' }; finish_reason = 'stop' })
    usage = @{ prompt_tokens = 20; completion_tokens = 6 }
})
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'test' })
$msgs.Add(@{ role = 'user'; content = 'what is in x.txt?' })
$r = Invoke-AgentLoop -Messages $msgs -Depth 0
Assert ($r.FinalText -eq 'the answer is 42') 'loop returns FinalText'
Assert ($msgs.Count -eq 5) 'loop transcript shape (sys,user,asst+tc,tool,asst)'
Assert ($msgs[3].role -eq 'tool' -and $msgs[3].tool_call_id -eq 'call_1' -and $msgs[3].content -match 'BETA') 'tool result paired and real'
Assert ($script:TotalPromptTokens -eq 30) 'usage accumulated'

# subagent via stub
$script:StubQueue.Enqueue(@{
    choices = @(@{ message = @{ role = 'assistant'; content = $null; tool_calls = @(
        @{ id = 'call_t'; type = 'function'; function = @{ name = 'task'; arguments = '{"description":"child job","prompt":"investigate the thing"}' } }
    ) }; finish_reason = 'tool_calls' })
})
$script:StubQueue.Enqueue(@{
    choices = @(@{ message = @{ role = 'assistant'; content = 'CHILD REPORT' }; finish_reason = 'stop' })
})
$script:StubQueue.Enqueue(@{
    choices = @(@{ message = @{ role = 'assistant'; content = 'PARENT DONE' }; finish_reason = 'stop' })
})
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'test' })
$msgs.Add(@{ role = 'user'; content = 'delegate this' })
$r = Invoke-AgentLoop -Messages $msgs -Depth 0
Assert ($r.FinalText -eq 'PARENT DONE') 'subagent flow completes'
Assert (($msgs | Where-Object { $_.role -eq 'tool' } | Select-Object -First 1).content -eq 'CHILD REPORT') 'child report becomes tool result'
Assert ($script:StubSpecNames[$script:StubSpecNames.Count - 2] -notcontains 'task') 'task tool excluded at depth 1'

# compaction via stub (-Force)
$script:StubQueue.Enqueue(@{
    choices = @(@{ message = @{ role = 'assistant'; content = 'DENSE SUMMARY' }; finish_reason = 'stop' })
})
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'sys' })
$msgs.Add(@{ role = 'user'; content = 'q1' })
$msgs.Add(@{ role = 'assistant'; content = $null; tool_calls = @(@{ id = 'c9'; type = 'function'; function = @{ name = 'glob'; arguments = '{}' } }) })
$msgs.Add(@{ role = 'tool'; tool_call_id = 'c9'; content = 'stuff' })
$msgs.Add(@{ role = 'assistant'; content = 'a1' })
Invoke-ContextCompaction -Messages $msgs -Force
Assert ($msgs.Count -eq 2 -and $msgs[1].content -match 'DENSE SUMMARY' -and $msgs[1].content -match 'compacted') '/compact replaces transcript with summary'

# auto-compaction keeps tool pairs intact
$script:StubQueue.Enqueue(@{
    choices = @(@{ message = @{ role = 'assistant'; content = 'AUTO SUMMARY' }; finish_reason = 'stop' })
})
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'sys' })
$msgs.Add(@{ role = 'user'; content = ('old ' * 800) })          # ~3200 chars of history
$msgs.Add(@{ role = 'assistant'; content = ('blah ' * 300) })
$msgs.Add(@{ role = 'user'; content = 'recent question' })
$msgs.Add(@{ role = 'assistant'; content = $null; tool_calls = @(@{ id = 'c2'; type = 'function'; function = @{ name = 'glob'; arguments = '{}' } }) })
$msgs.Add(@{ role = 'tool'; tool_call_id = 'c2'; content = 'recent result' })
$script:Config.context_char_budget = 2000
Invoke-ContextCompaction -Messages $msgs
$script:Config.context_char_budget = 300000
Assert ($msgs[1].content -match 'AUTO SUMMARY') 'auto-compact summarizes old exchanges'
Assert ($msgs[2].content -eq 'recent question') 'auto-compact cut lands on a user boundary'
$toolIdx = -1; for ($i = 0; $i -lt $msgs.Count; $i++) { if ($msgs[$i].role -eq 'tool') { $toolIdx = $i } }
Assert ($toolIdx -gt 0 -and $msgs[$toolIdx - 1].tool_calls) 'auto-compact keeps tool pair intact'

# ============================================================ MCP (mock server)
Write-Host 'mcp (mock server):'
$script:Config.mcpServers = @{
    mock = @{ command = 'pwsh'; args = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'mock-mcp-server.ps1')) }
}
Start-KakunaMcpServers
$mock = $script:McpServers['mock']
Assert ($mock -and $mock.Status -eq 'connected') 'mcp handshake connects'
Assert ($script:ToolRegistry.Contains('mcp__mock__echo')) 'mcp tool registered'
$r = Invoke-McpToolCall -ServerName 'mock' -ToolName 'echo' -Arguments @{ text = 'hi kakuna' }
Assert ($r -eq 'hi kakuna') 'mcp tools/call round-trip (despite interleaved notification)'
$fakeCall = @{ id = 'x1'; function = @{ name = 'mcp__mock__echo'; arguments = '{"text":"via dispatch"}' } }
$r = Invoke-KakunaToolCall -ToolCall $fakeCall -Depth 0
Assert ($r -eq 'via dispatch') 'mcp dispatch through agent tool-call path'
$mockPid = $mock.Process.Id
Stop-KakunaMcpServers
Start-Sleep -Milliseconds 500
Assert ($null -eq (Get-Process -Id $mockPid -ErrorAction SilentlyContinue)) 'mcp clean shutdown, no zombie'
Assert (Test-KakunaAllowRule -Rule 'mcp__mock__*' -ToolName 'mcp__mock__echo') 'mcp allowlist wildcard applies'

# ============================================================ done
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host ''
if ($script:fail -eq 0) { Write-Host 'ALL SMOKE TESTS PASSED'; exit 0 }
else { Write-Host "$script:fail TEST(S) FAILED"; exit 1 }
