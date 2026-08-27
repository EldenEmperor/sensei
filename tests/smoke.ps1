# smoke.ps1 — offline checks of every tool handler. No API key needed.
# Run with:  pwsh -NoProfile -File tests\smoke.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script:KakunaRoot = $root
$script:YoloMode = $true
. (Join-Path $root 'src\tools.ps1')
. (Join-Path $root 'src\logtools.ps1')

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

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "kakuna-smoke-$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host 'core tools:'
$r = Invoke-Tool 'write_file' @{ path = "$tmp\x.txt"; content = "alpha`nbeta`ngamma" }
Assert ($r -match 'Wrote') 'write_file'
$r = Invoke-Tool 'read_file' @{ path = "$tmp\x.txt" }
Assert ($r -match '2→beta') 'read_file line numbers'
$r = Invoke-Tool 'read_file' @{ path = "$tmp\x.txt"; offset = 2; limit = 1 }
Assert ($r -match 'beta' -and $r -notmatch 'alpha' -and $r -match 'offset=3') 'read_file offset/limit'
$r = Invoke-Tool 'edit_file' @{ path = "$tmp\x.txt"; old_string = 'beta'; new_string = 'BETA' }
Assert ($r -match 'Edited') 'edit_file'
Assert ((Get-Content "$tmp\x.txt" -Raw) -match 'BETA') 'edit_file applied on disk'
$r = Invoke-Tool 'edit_file' @{ path = "$tmp\x.txt"; old_string = 'a'; new_string = 'A' }
Assert ($r -match 'ERROR' -and $r -match 'times') 'edit_file uniqueness enforced'
$r = Invoke-Tool 'edit_file' @{ path = "$tmp\x.txt"; old_string = 'a'; new_string = 'A'; replace_all = $true }
Assert ($r -match 'Edited') 'edit_file replace_all'
$r = Invoke-Tool 'glob' @{ pattern = '**/*.ps1'; path = $root }
Assert ($r -match 'tools\.ps1' -and $r -match 'kakuna\.ps1') 'glob recursive'
$r = Invoke-Tool 'glob' @{ pattern = '*.zzz'; path = $root }
Assert ($r -match 'No files match') 'glob no-match message'
$r = Invoke-Tool 'grep' @{ pattern = 'Register-KakunaTool'; path = (Join-Path $root 'src') }
Assert ($r -match 'tools\.ps1' -and $r -match 'logtools\.ps1') 'grep files_with_matches'
$r = Invoke-Tool 'grep' @{ pattern = 'Register-KakunaTool'; path = (Join-Path $root 'src'); output_mode = 'content'; head_limit = 3 }
Assert ($r -match ':\d+:') 'grep content mode'
$r = Invoke-Tool 'run_powershell' @{ command = 'Write-Output hello; exit 3' }
Assert ($r -match 'exit_code: 3' -and $r -match 'hello') 'run_powershell exit code + stdout'
$r = Invoke-Tool 'run_powershell' @{ command = 'Start-Sleep 30'; timeout_seconds = 2 }
Assert ($r -match 'timed out') 'run_powershell timeout kill'

Write-Host 'log tools (generating synthetic log)…'
$log = Join-Path $tmp 'app.log'
& (Join-Path $PSScriptRoot 'New-TestLog.ps1') -Path $log -Lines 200000 | Out-Null
$answers = Get-Content -Raw "$log.answers.json" | ConvertFrom-Json -AsHashtable

$stats = Invoke-Tool 'log_stats' @{ path = $log }
$statLines = if ($stats -match 'lines: ([\d,]+)') { [int]($Matches[1] -replace ',', '') } else { -1 }
Assert ($statLines -eq $answers.total_lines) "log_stats total lines ($statLines vs $($answers.total_lines))"
$statErr = if ($stats -match 'ERROR: (\d+)') { [int]$Matches[1] } else { -1 }
Assert ($statErr -eq $answers.error_total) "log_stats ERROR count ($statErr vs $($answers.error_total))"
$statWarn = if ($stats -match 'WARN: (\d+)') { [int]$Matches[1] } else { -1 }
Assert ($statWarn -eq $answers.warn_total) "log_stats WARN count ($statWarn vs $($answers.warn_total))"
Assert ($stats -match 'FATAL: 1') 'log_stats FATAL count'
Assert ($stats -match 'OutOfMemoryException') 'log_stats surfaces the OOM template'
Assert ($stats -match 'frequency') 'log_stats has time buckets'

$r = Invoke-Tool 'log_slice' @{ path = $log; tail = 5 }
Assert ($r -match ('{0}→' -f $answers.total_lines)) 'log_slice tail reaches last line number'
$r = Invoke-Tool 'log_slice' @{ path = $log; head = 3 }
Assert ($r -match '1→' -and $r -match '3→') 'log_slice head'
$r = Invoke-Tool 'log_slice' @{ path = $log; from_line = 100; to_line = 105 }
Assert ((@($r -split "`n") | Where-Object { $_ -match '→' }).Count -eq 6) 'log_slice line range'
$r = Invoke-Tool 'log_slice' @{ path = $log; from_time = '2026-08-27 02:46:30'; to_time = '2026-08-27 02:47:30' }
Assert ($r -match 'OutOfMemoryException') 'log_slice time range catches the crash'
$r = Invoke-Tool 'log_slice' @{ path = $log }
Assert ($r -match 'ERROR') 'log_slice requires a mode'

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host ''
if ($script:fail -eq 0) { Write-Host 'ALL SMOKE TESTS PASSED'; exit 0 }
else { Write-Host "$script:fail TEST(S) FAILED"; exit 1 }
