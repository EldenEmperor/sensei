# smoke.ps1 — offline checks of the whole Sensei toolchain. No API key needed.
# Run with:  pwsh -NoProfile -File tests\smoke.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# --- minimal harness state, then dot-source everything ----------------------
$script:SenseiRoot = $root
$script:SenseiVersion = '0.0.0-test'
$script:YoloMode = $true
$script:LocalMode = $false
$script:PrintMode = $false
$script:PlanMode = $false
$script:SessionId = 'smoke-test'

foreach ($f in 'render', 'config', 'input', 'permissions', 'hooks', 'tools', 'web', 'skills', 'tasks', 'logtools', 'prompts', 'openai', 'agent', 'mcp', 'repl') {
    . (Join-Path $root "src\$f.ps1")
}

# hermetic config: never touch the user's real ~/.sensei
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "sensei-smoke-$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$script:ConfigDir = Join-Path $tmp 'sensei-home'
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
Assert ($r -match 'tools\.ps1' -and $r -match 'sensei\.ps1') 'glob recursive'
$r = Invoke-Tool 'grep' @{ pattern = 'Register-SenseiTool'; path = (Join-Path $root 'src') }
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
Initialize-SenseiInput
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
Assert (Test-SenseiAllowRule -Rule 'run_powershell(git status*)' -ToolName 'run_powershell' -PrimaryValue 'git status --short') 'rule: command prefix match'
Assert (-not (Test-SenseiAllowRule -Rule 'run_powershell(git status*)' -ToolName 'run_powershell' -PrimaryValue 'rm -rf /')) 'rule: command mismatch'
Assert (Test-SenseiAllowRule -Rule 'mcp__github__*' -ToolName 'mcp__github__create_issue') 'rule: wildcard tool name'
Assert (Test-SenseiAllowRule -Rule 'write_file(C:\logs\*)' -ToolName 'write_file' -PrimaryValue 'app.log' -ResolvedValue 'C:\logs\app.log') 'rule: resolved path match'
Assert (-not (Test-SenseiAllowRule -Rule 'write_file' -ToolName 'edit_file')) 'rule: bare name exact'
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
$h = Invoke-SenseiHooks -Event 'PreToolUse' -ToolName 'run_powershell' -ToolInput @{ command = 'x' }
Assert ($h.Block -and $h.Reason -eq 'nope') 'PreToolUse exit-2 blocks with stderr reason'
$h = Invoke-SenseiHooks -Event 'PreToolUse' -ToolName 'read_file' -ToolInput @{}
Assert (-not $h.Block) 'hook matcher skips non-matching tool'
$script:Config.hooks = @(@{ event = 'PreToolUse'; matcher = ''; command = 'exit 0' })
$h = Invoke-SenseiHooks -Event 'PreToolUse' -ToolName 'read_file' -ToolInput @{}
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

$cmdDir = Join-Path $tmp 'proj\.sensei\commands'
New-Item -ItemType Directory -Force -Path $cmdDir | Out-Null
Set-Content -Path (Join-Path $cmdDir 'greet.md') -Value 'Say hello to $ARGUMENTS please'
Push-Location (Join-Path $tmp 'proj')
try {
    $p = Find-SenseiCustomCommand 'greet'
    Assert ($null -ne $p) 'custom command found'
    $content = (Get-Content -LiteralPath $p -Raw) -replace '\$ARGUMENTS', 'world'
    Assert ($content -match 'hello to world') 'custom command $ARGUMENTS substitution'
} finally { Pop-Location }

$script:TotalPromptTokens = 100000
$script:TotalCompletionTokens = 10000
$line = Get-SenseiCostLine
Assert ($line -match '100\.0k in' -and $line -match '\$') 'cost line with estimate'
$script:TotalPromptTokens = 0
$script:TotalCompletionTokens = 0

$html = ConvertFrom-SenseiHtml '<html><head><style>x{color:red}</style></head><body><h1>Title</h1><p>Hello <b>world</b></p><script>evil()</script></body></html>'
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
$n = Restore-SenseiSession -Path $sessFile
Assert ($script:Messages[0].role -eq 'system' -and $script:Messages[0].content -match 'Sensei') 'resume re-seeds fresh system prompt'
Assert ((@($script:Messages | Where-Object { $_.role -eq 'tool' })).Count -eq 1) 'resume drops orphan tool message'
Assert ($script:Messages[2].tool_calls[0].id -eq 'c1') 'resume preserves tool_call pair'
Assert ($script:Messages[-1].content -eq 'question two') 'resume keeps last user message'
$script:Messages = [System.Collections.Generic.List[object]]::new()
$script:SessionPath = $null

# SENSEI.md memory
Set-Content -Path (Join-Path $script:ConfigDir 'SENSEI.md') -Value 'GLOBAL_MEMORY_MARKER'
$sp = Get-SenseiSystemPrompt
Assert ($sp -match 'GLOBAL_MEMORY_MARKER' -and $sp -match 'Project memory') 'SENSEI.md loaded into system prompt'
$sp2 = Get-SenseiSystemPrompt -Subagent
Assert ($sp2 -match 'Subagent mode') 'subagent preamble'

# ============================================================ skills
Write-Host 'skills:'
Push-Location $tmp   # no .sensei\skills here, temp ConfigDir has none either
try {
    Register-SenseiSkillTool
    Assert (-not $script:ToolRegistry.Contains('skill')) 'skill tool absent when no skills exist'

    $skillDir = Join-Path $tmp 'proj\.sensei\skills\demo'
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
    $bareDir = Join-Path $tmp 'proj\.sensei\skills\bare'
    New-Item -ItemType Directory -Force -Path $bareDir | Out-Null
    Set-Content -Path (Join-Path $bareDir 'SKILL.md') -Value 'BARE_BODY_MARKER only'
    # user-level skill with the same name as the project one — project must win
    $userSkillDir = Join-Path $script:ConfigDir 'skills\demo'
    New-Item -ItemType Directory -Force -Path $userSkillDir | Out-Null
    Set-Content -Path (Join-Path $userSkillDir 'SKILL.md') -Value "---`nname: demo`ndescription: user copy`n---`nUSER_COPY_MARKER"

    Push-Location (Join-Path $tmp 'proj')
    try {
        $skills = @(Get-SenseiSkills)
        Assert ($skills.Count -eq 2) 'skills discovered (project demo + bare)'
        $demo = $skills | Where-Object { $_.Name -eq 'demo' }
        Assert ($demo.Description -match 'demo procedure' -and $demo.Source -eq 'project') 'frontmatter parsed, project shadows user'
        $bare = $skills | Where-Object { $_.Name -eq 'bare' }
        Assert ($null -ne $bare -and $bare.Description -eq '') 'frontmatter-less skill named from folder'

        Register-SenseiSkillTool
        Assert ($script:ToolRegistry.Contains('skill')) 'skill tool registered'
        Assert ($script:ToolRegistry['skill'].Description -match 'demo: Demonstrates') 'skill tool description lists skills'
        $r = Invoke-Tool 'skill' @{ name = 'demo' }
        Assert ($r -match 'DEMO_PROCEDURE_MARKER' -and $r -match [regex]::Escape($demo.Dir)) 'skill tool loads body + supporting-files path'
        Assert ($r -notmatch 'USER_COPY_MARKER') 'shadowed user skill not loaded'
        $r = Invoke-Tool 'skill' @{ name = 'nope' }
        Assert ($r -match 'ERROR' -and $r -match 'demo') 'unknown skill errors with available list'
        $p = Get-SenseiSkillPrompt -Skill $demo -Arguments 'the log file'
        Assert ($p -match 'steps with the log file' -and $p -match '# Skill: demo') 'skill prompt substitutes $ARGUMENTS'
        $p = Get-SenseiSkillPrompt -Skill $bare -Arguments 'xyz'
        Assert ($p -match 'User input: xyz') 'skill prompt appends args when no placeholder'
    } finally { Pop-Location }
} finally { Pop-Location }
Remove-Item -Recurse -Force (Join-Path $script:ConfigDir 'skills') -ErrorAction SilentlyContinue
Register-SenseiSkillTool   # back to zero-skill state for later sections

# ============================================================ v0.3 features
Write-Host 'output styles:'
$script:Config.output_style = 'concise'
Assert ((Get-SenseiSystemPrompt) -match 'tersely as correctness') 'output style injected into system prompt'
$script:Config.output_style = 'default'
Assert ((Get-SenseiStyleDirective) -eq '') 'default style is empty'

Write-Host 'multi_edit (atomic):'
$mf = Join-Path $tmp 'multi.txt'
Set-Content -Path $mf -Value "one`ntwo`nthree" -NoNewline
$r = Invoke-Tool 'multi_edit' @{ path = $mf; edits = @(@{ old_string = 'one'; new_string = 'ONE' }, @{ old_string = 'three'; new_string = 'THREE' }) }
Assert ($r -match 'Applied 2') 'multi_edit applies all edits'
Assert ((Get-Content -Raw $mf) -match 'ONE' -and (Get-Content -Raw $mf) -match 'THREE') 'multi_edit changes on disk'
Set-Content -Path $mf -Value "alpha`nbeta" -NoNewline
$r = Invoke-Tool 'multi_edit' @{ path = $mf; edits = @(@{ old_string = 'alpha'; new_string = 'A' }, @{ old_string = 'nope'; new_string = 'X' }) }
Assert ($r -match 'ERROR' -and $r -match 'edit #2') 'multi_edit reports failing edit'
Assert ((Get-Content -Raw $mf) -eq "alpha`nbeta") 'multi_edit atomic: file unchanged on failure'

Write-Host 'memory up-tree + import:'
$deep = Join-Path $tmp 'mem\a\b'
New-Item -ItemType Directory -Force -Path $deep | Out-Null
Set-Content -Path (Join-Path $tmp 'mem\a\SENSEI.md') -Value 'PARENT_MEM'
Set-Content -Path (Join-Path $deep 'shared.md') -Value 'IMPORTED_MEM'
Set-Content -Path (Join-Path $deep 'SENSEI.md') -Value "CHILD_MEM`n@shared.md"
Push-Location $deep
try {
    $mem = Get-SenseiMemory
    $joined = ($mem | ForEach-Object { $_.Content }) -join "`n"
    Assert ($joined -match 'PARENT_MEM' -and $joined -match 'CHILD_MEM') 'memory walks up-tree'
    Assert ($joined -match 'IMPORTED_MEM') 'memory resolves @import'
    $childIdx = ($mem.Path | ForEach-Object { $_ }) -join '|'
    Assert (($mem[-1].Content) -match 'CHILD_MEM') 'nearest memory is last (wins)'
} finally { Pop-Location }

Write-Host 'log_timeline / log_trace:'
$logA = Join-Path $tmp 'a.log'; $logB = Join-Path $tmp 'b.log'
Set-Content -Path $logA -Value "2026-01-01 00:00:01 [INFO] A-one`n2026-01-01 00:00:03 [INFO] A-three req-ZZZ"
Set-Content -Path $logB -Value "2026-01-01 00:00:02 [INFO] B-two req-ZZZ`n2026-01-01 00:00:04 [INFO] B-four"
$r = Invoke-Tool 'log_timeline' @{ paths = @($logA, $logB) }
$iA1 = $r.IndexOf('A-one'); $iB2 = $r.IndexOf('B-two'); $iA3 = $r.IndexOf('A-three'); $iB4 = $r.IndexOf('B-four')
Assert ($iA1 -lt $iB2 -and $iB2 -lt $iA3 -and $iA3 -lt $iB4) 'log_timeline merges by timestamp'
Assert ($r -match '\[a\.log\]' -and $r -match '\[b\.log\]') 'log_timeline tags sources'
$r = Invoke-Tool 'log_trace' @{ id = 'req-ZZZ'; paths = @($logA, $logB) }
Assert ($r.IndexOf('B-two') -lt $r.IndexOf('A-three')) 'log_trace orders matches by timestamp across files'

Write-Host 'log_baseline:'
$baseLog = Join-Path $tmp 'base.log'; $newLog = Join-Path $tmp 'new.log'
$bl = 1..10 | ForEach-Object { "2026-01-01 00:00:0$($_ % 10) [ERROR] Payment failed for order $_" }
Set-Content -Path $baseLog -Value ($bl -join "`n")
$nl = @()
$nl += 1..50 | ForEach-Object { "2026-01-01 00:00:0$($_ % 10) [ERROR] Payment failed for order $_" }
$nl += 1..3 | ForEach-Object { "2026-01-01 00:01:0$_ [ERROR] Kafka broker unreachable" }
Set-Content -Path $newLog -Value ($nl -join "`n")
$r = Invoke-Tool 'log_baseline' @{ action = 'save'; path = $baseLog; name = 'b1' }
Assert ($r -match 'saved baseline') 'log_baseline save'
$r = Invoke-Tool 'log_baseline' @{ action = 'diff'; path = $newLog; name = 'b1' }
Assert ($r -match 'NEW error' -and $r -match 'Kafka') 'log_baseline diff flags new template'
Assert ($r -match 'COUNT SPIKES' -and $r -match 'Payment') 'log_baseline diff flags count spike'

Write-Host 'log_investigate:'
$fx = Join-Path $PSScriptRoot 'fixtures'
# generated app.log: timestamped text, two ts styles, stack blocks, one rare FATAL
$r = Invoke-Tool 'log_investigate' @{ path = $log }
Assert ($r -match 'timestamped-text') 'investigate: family timestamped-text'
Assert ($r -match 'iso8601' -and $r -match 'us-legacy') 'investigate: both timestamp styles detected'
Assert ($r -match '(?i)rare' -and $r -match 'OutOfMemoryException') 'investigate: FATAL OOM surfaced as rare event'
Assert ($r -match '(?i)continuation|block') 'investigate: stack-trace continuation blocks detected'
# cache behavior: hit, invalidation on change, full-fingerprint validation
$r2 = Invoke-Tool 'log_investigate' @{ path = $log }
Assert ($r2 -match '\(cached') 'investigate: second call served from cache'
Add-Content -LiteralPath $log -Value '2026-08-27 03:59:59.000 [INFO] appended after analysis'
$r3 = Invoke-Tool 'log_investigate' @{ path = $log }
Assert ($r3 -notmatch '\(cached') 'investigate: cache invalidated on file change'
$mapFile = Get-ChildItem (Join-Path $script:ConfigDir 'formats') -Filter '*.json' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$mj = Get-Content $mapFile.FullName -Raw | ConvertFrom-Json -AsHashtable
$mj.fingerprint = 'bogus'
ConvertTo-Json -InputObject $mj -Depth 12 | Set-Content $mapFile.FullName -Encoding utf8NoBOM
Assert ((Invoke-Tool 'log_investigate' @{ path = $log }) -notmatch '\(cached') 'investigate: stored fingerprint mismatch forces rebuild'
# family detection across fixtures
$rj = Invoke-Tool 'log_investigate' @{ path = "$fx\sample-jsonl.log" }
Assert ($rj -match 'json-lines') 'investigate: json-lines family'
Assert ($rj -match 'duration_ms' -and $rj -match '\bint\b') 'investigate: field types inferred'
Assert ($rj -match '(?i)severe') 'investigate: extra level vocabulary found'
Assert ((Invoke-Tool 'log_investigate' @{ path = "$fx\sample-logfmt.log" }) -match 'logfmt') 'investigate: logfmt family'
Assert ((Invoke-Tool 'log_investigate' @{ path = "$fx\sample-access.log" }) -match 'apache-access') 'investigate: apache access family'
$rc = Invoke-Tool 'log_investigate' @{ path = "$fx\sample.csv" }
Assert ($rc -match '\bcsv\b' -and $rc -match 'component') 'investigate: csv family + header columns'
# hints consumption: epoch-ms json-lines is unusable before a map, usable after
$epochLog = Join-Path $tmp 'epoch.log'
Copy-Item "$fx\sample-jsonl-epoch.log" $epochLog -Force
$before = Invoke-Tool 'log_stats' @{ path = $epochLog }
Assert ($before -match 'no recognizable timestamps') 'epoch json-lines: no time range without a map'
[void](Invoke-Tool 'log_investigate' @{ path = $epochLog })
$after = Invoke-Tool 'log_stats' @{ path = $epochLog }
Assert ($after -match 'time range: \d{4}') 'log_stats gains time range from format map'
$sl = Invoke-Tool 'log_slice' @{ path = $epochLog; from_time = '2026-08-26 00:00:00'; to_time = '2026-08-29 00:00:00' }
Assert ($sl -notmatch 'no lines in that time range' -and $sl -match 'batch processed') 'log_slice time filter works via hints'
# template placeholder upgrades
Assert ((Get-LogTemplate '2026-01-01 00:00:00 conn from 10.0.0.7:443 key=abc ok') -match '<ip>') 'template: <ip> placeholder'
Assert ((Get-LogTemplate 'x key=order:12345 hit=True') -match 'key=<v>') 'template: key=value collapsed'
# edge cases: empty and binary files
$emptyLog = Join-Path $tmp 'empty.log'
[System.IO.File]::WriteAllText($emptyLog, '')
Assert ((Invoke-Tool 'log_investigate' @{ path = $emptyLog }) -match '(?i)empty') 'investigate: empty file graceful'
$binLog = Join-Path $tmp 'bin.log'
[System.IO.File]::WriteAllBytes($binLog, [byte[]](0, 1, 2, 0, 65, 66, 0))
Assert ((Invoke-Tool 'log_investigate' @{ path = $binLog }) -match '(?i)binary') 'investigate: binary file detected, no crash'

Write-Host 'log_search (stubbed embeddings):'
$memLog = Join-Path $tmp 'mem.log'
Set-Content -Path $memLog -Value "2026-01-01 00:00:01 [ERROR] OutOfMemoryException heap exhausted`n2026-01-01 00:00:02 [ERROR] OutOfMemoryException heap exhausted`n2026-01-01 00:00:03 [ERROR] OutOfMemoryException heap exhausted`n2026-01-01 00:00:04 [ERROR] Disk write failed no space left`n2026-01-01 00:00:05 [ERROR] Disk write failed no space left"
function Get-SenseiEmbeddings { param([string[]]$Inputs)
    return @($Inputs | ForEach-Object { if ($_ -match '(?i)memory|heap') { ,@(1.0, 0.0) } else { ,@(0.0, 1.0) } })
}
$script:LocalMode = $true
$r = Invoke-Tool 'log_search' @{ path = $memLog; query = 'memory pressure'; top = 2 }
$script:LocalMode = $false
Assert ($r.IndexOf('OutOfMemory') -lt $r.IndexOf('Disk')) 'log_search ranks by semantic similarity'
Assert ((Get-SenseiCosine @(1.0, 0.0) @(1.0, 0.0)) -eq 1.0 -and (Get-SenseiCosine @(1.0, 0.0) @(0.0, 1.0)) -eq 0.0) 'cosine similarity'

Write-Host 'plan mode:'
$script:PlanMode = $true
Assert (-not (Request-ToolPermission -Name 'write_file' -Tool $script:ToolRegistry['write_file'] -ToolArgs @{ path = 'x' })) 'plan mode blocks write tools'
Assert (Request-ToolPermission -Name 'read_file' -Tool $script:ToolRegistry['read_file'] -ToolArgs @{ path = 'x' }) 'plan mode allows read-only tools'
Assert ((Get-SenseiSystemPrompt) -match 'Plan mode \(ACTIVE\)') 'plan mode note in system prompt'
$script:PlanMode = $false

Write-Host 'accent / theme:'
Assert (Set-SenseiAccent 'indigo') 'accent preset resolves'
Assert (Set-SenseiAccent '#1188ff') 'accent hex resolves'
Assert (-not (Set-SenseiAccent 'chartreusish')) 'unknown accent rejected'

Write-Host 'web helpers:'
$html = '<html><body><nav>NAVJUNK</nav><header>HEADJUNK</header><p>Real content here.</p><a href="/sub/page">more</a><a href="https://other.com/y">ext</a><footer>FOOTJUNK</footer></body></html>'
$txt = ConvertFrom-SenseiHtml $html
Assert ($txt -match 'Real content' -and $txt -notmatch 'NAVJUNK' -and $txt -notmatch 'FOOTJUNK' -and $txt -notmatch 'HEADJUNK') 'html readability drops nav/header/footer'
$links = Get-SenseiLinks -Html $html -BaseUrl 'https://site.com/a/b'
Assert ($links -contains 'https://site.com/sub/page' -and $links -contains 'https://other.com/y') 'links resolved to absolute'
$page = Format-SenseiPage -Content $html -ContentType 'text/html' -Url 'https://site.com/a/b'
Assert ($page -match 'Real content' -and $page -match 'Links found') 'Format-SenseiPage appends links section'
$json = Format-SenseiPage -Content '{"b":2,"a":1}' -ContentType 'application/json' -Url 'https://x'
Assert ($json -match '"a": 1') 'json passthrough pretty-printed'

Write-Host 'web_search parser:'
$ddg = '<div class="result"><a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Fdoc%3Fx%3D1">Example <b>Doc</b></a><a class="result__snippet" href="#">A helpful snippet here</a></div>'
$res = @(ConvertFrom-DdgResults -Html $ddg -Max 8)
Assert ($res.Count -eq 1 -and $res[0].Title -eq 'Example Doc') 'ddg parses title (tags stripped)'
Assert ($res[0].Url -eq 'https://example.com/doc?x=1') 'ddg decodes uddg real url'
Assert ($res[0].Snippet -match 'helpful snippet') 'ddg pairs snippet'

Write-Host 'web_browser detection:'
$b = Find-SenseiBrowser
Assert ($null -eq $b -or (Test-Path -LiteralPath $b)) 'browser detection returns a valid path or null'

# ============================================================ background tasks

# ============================================================ background tasks
Write-Host 'background tasks:'
$r = Start-SenseiBackgroundTask -Command '1..3 | ForEach-Object { "tick $_" }; exit 7'
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

# ============================================================ auto-continue nudge
Write-Host 'auto-continue nudge:'
function New-StubStop {
    param([string]$Text, [string]$Finish = 'stop', $ToolCalls = $null)
    $m = @{ role = 'assistant'; content = $Text }
    if ($ToolCalls) { $m.tool_calls = $ToolCalls }
    return @{ choices = @(@{ message = $m; finish_reason = $Finish }); usage = @{ prompt_tokens = 1; completion_tokens = 1 } }
}
$passive = "To install wget, follow these steps:`n**Step 1**: Open PowerShell as Administrator`n**Step 2**: Run the following command:`nchoco install wget`nLet me know if you run into issues!"

# detector unit tests
Assert (Test-SenseiPassiveReply -Content $passive) 'detector: step-by-step tutorial'
Assert (Test-SenseiPassiveReply -Content "Run the following command in your terminal.`nLet me know if that works") 'detector: two markers, no Step'
Assert (Test-SenseiPassiveReply -Content "<think>I should just tell them how</think>$passive") 'detector: think block stripped, tutorial found'
Assert (-not (Test-SenseiPassiveReply -Content "<think>Step 1: run this. Let me know</think>Installed wget 1.21 via winget.")) 'detector: tutorial only inside think block ignored'
Assert (-not (Test-SenseiPassiveReply -Content 'Installed wget 1.21 via winget --scope user; verified with wget --version.')) 'detector: active answer not flagged'
Assert (-not (Test-SenseiPassiveReply -Content $null)) 'detector: null content'
Assert (-not (Test-SenseiPassiveReply -Content 'You can run log_stats on this next time.')) 'detector: single marker not enough'

# nudge fires, model recovers with tool use
$script:StubQueue.Enqueue((New-StubStop -Text $passive))
$script:StubQueue.Enqueue(@{
    choices = @(@{ message = @{ role = 'assistant'; content = $null; tool_calls = @(
        @{ id = 'call_n1'; type = 'function'; function = @{ name = 'read_file'; arguments = (ConvertTo-Json -InputObject @{ path = "$tmp\x.txt" } -Compress) } }
    ) }; finish_reason = 'tool_calls' })
    usage = @{ prompt_tokens = 1; completion_tokens = 1 }
})
$script:StubQueue.Enqueue((New-StubStop -Text 'installed it'))
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'test' })
$msgs.Add(@{ role = 'user'; content = 'install wget for me' })
$r = Invoke-AgentLoop -Messages $msgs -Depth 0
Assert ($r.FinalText -eq 'installed it') 'nudge: final answer comes from recovery round'
Assert ($r.Rounds -ge 3) 'nudge: extra rounds consumed'
$nudges = @($msgs | Where-Object { $_.role -eq 'user' -and [string]$_.content -match '<system-note>.*do the task NOW' })
Assert ($nudges.Count -eq 1) 'nudge: exactly one system-note injected'
$pIdx = -1; $nIdx = -1
for ($i = 0; $i -lt $msgs.Count; $i++) {
    if ($msgs[$i].role -eq 'assistant' -and [string]$msgs[$i].content -match 'Step 1' -and $pIdx -lt 0) { $pIdx = $i }
    if ($msgs[$i].role -eq 'user' -and [string]$msgs[$i].content -match '<system-note>' -and $nIdx -lt 0) { $nIdx = $i }
}
Assert ($pIdx -ge 0 -and $nIdx -eq $pIdx + 1) 'nudge: note directly follows the passive reply'

# cap: one nudge per turn — a second passive reply returns normally
$script:StubQueue.Enqueue((New-StubStop -Text $passive))
$script:StubQueue.Enqueue((New-StubStop -Text $passive))
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'test' })
$msgs.Add(@{ role = 'user'; content = 'install wget for me' })
$r = Invoke-AgentLoop -Messages $msgs -Depth 0
Assert ($r.FinalText -match 'Step 1') 'nudge cap: second passive reply returned as final'
Assert ($script:StubQueue.Count -eq 0) 'nudge cap: queue exactly drained (no second nudge)'
Assert (@($msgs | Where-Object { [string]$_.content -match '<system-note>.*do the task NOW' }).Count -eq 1) 'nudge cap: one note only'

# negative: a normal answer never nudges
$script:StubQueue.Enqueue((New-StubStop -Text 'the log shows an OOM at 02:47:13'))
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'test' })
$msgs.Add(@{ role = 'user'; content = 'what crashed?' })
$r = Invoke-AgentLoop -Messages $msgs -Depth 0
Assert ($msgs.Count -eq 3 -and $r.Rounds -eq 1) 'nudge negative: active answer returns in one round'

# gating: auto_continue=false disables the nudge
$script:Config.auto_continue = $false
$script:StubQueue.Enqueue((New-StubStop -Text $passive))
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'test' })
$msgs.Add(@{ role = 'user'; content = 'install wget for me' })
$r = Invoke-AgentLoop -Messages $msgs -Depth 0
$script:Config.auto_continue = $true
Assert ($r.Rounds -eq 1 -and $r.FinalText -match 'Step 1') 'nudge gating: disabled config returns passive reply untouched'

# orphan-tool_calls fix: finish_reason=stop WITH tool_calls still executes them
$script:StubQueue.Enqueue((New-StubStop -Text 'let me check' -Finish 'stop' -ToolCalls @(
    @{ id = 'call_s'; type = 'function'; function = @{ name = 'read_file'; arguments = (ConvertTo-Json -InputObject @{ path = "$tmp\x.txt" } -Compress) } }
)))
$script:StubQueue.Enqueue((New-StubStop -Text 'file contains BETA'))
$msgs = [System.Collections.Generic.List[object]]::new()
$msgs.Add(@{ role = 'system'; content = 'test' })
$msgs.Add(@{ role = 'user'; content = 'check x.txt' })
$r = Invoke-AgentLoop -Messages $msgs -Depth 0
$orphanTool = @($msgs | Where-Object { $_.role -eq 'tool' -and $_.tool_call_id -eq 'call_s' })
Assert ($orphanTool.Count -eq 1) 'orphan fix: stop+tool_calls executes the tool'
Assert ($orphanTool[0].content -match 'BETA') 'orphan fix: tool result captured'
Assert ($r.Rounds -eq 2 -and $r.FinalText -eq 'file contains BETA') 'orphan fix: loop continues to a real final answer'

# ============================================================ MCP (mock server)
Write-Host 'mcp (mock server):'
$script:Config.mcpServers = @{
    mock = @{ command = 'pwsh'; args = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'mock-mcp-server.ps1')) }
}
Start-SenseiMcpServers
$mock = $script:McpServers['mock']
Assert ($mock -and $mock.Status -eq 'connected') 'mcp handshake connects'
Assert ($script:ToolRegistry.Contains('mcp__mock__echo')) 'mcp tool registered'
$r = Invoke-McpToolCall -ServerName 'mock' -ToolName 'echo' -Arguments @{ text = 'hi sensei' }
Assert ($r -eq 'hi sensei') 'mcp tools/call round-trip (despite interleaved notification)'
$fakeCall = @{ id = 'x1'; function = @{ name = 'mcp__mock__echo'; arguments = '{"text":"via dispatch"}' } }
$r = Invoke-SenseiToolCall -ToolCall $fakeCall -Depth 0
Assert ($r -eq 'via dispatch') 'mcp dispatch through agent tool-call path'
$mockPid = $mock.Process.Id
Stop-SenseiMcpServers
Start-Sleep -Milliseconds 500
Assert ($null -eq (Get-Process -Id $mockPid -ErrorAction SilentlyContinue)) 'mcp clean shutdown, no zombie'
Assert (Test-SenseiAllowRule -Rule 'mcp__mock__*' -ToolName 'mcp__mock__echo') 'mcp allowlist wildcard applies'

# ============================================================ done
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host ''
if ($script:fail -eq 0) { Write-Host 'ALL SMOKE TESTS PASSED'; exit 0 }
else { Write-Host "$script:fail TEST(S) FAILED"; exit 1 }
