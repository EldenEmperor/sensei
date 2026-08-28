# cross-check.ps1 — run the same log tools through the PowerShell and
# TypeScript variants and diff their output. Both sides use hermetic config
# dirs (no cached format maps) so behavior is compared at defaults.
#
#   pwsh -File ts\scripts\cross-check.ps1 [-LogPath tests\app.log]

param([string]$LogPath = '')

$ErrorActionPreference = 'Stop'
$tsRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $tsRoot
if (-not $LogPath) { $LogPath = Join-Path $repoRoot 'tests\app.log' }
$log = (Resolve-Path -LiteralPath $LogPath).Path

# --- PS side: dot-source with a minimal harness, call handlers directly ------
$script:SenseiRoot = $repoRoot
$script:SenseiVersion = 'cross-check'
$script:YoloMode = $true; $script:LocalMode = $false; $script:PrintMode = $true; $script:PlanMode = $false
foreach ($f in 'render', 'config', 'input', 'permissions', 'hooks', 'tools', 'web', 'skills', 'tasks', 'logtools', 'prompts', 'openai', 'agent', 'mcp', 'repl') {
    . (Join-Path $repoRoot "src\$f.ps1")
}
$psTempHome = Join-Path ([System.IO.Path]::GetTempPath()) "sensei-crosscheck-ps-$PID"
New-Item -ItemType Directory -Force -Path $psTempHome | Out-Null
$script:ConfigDir = $psTempHome
$script:Config = @{} + $script:DefaultConfig
$script:ProjectConfig = @{}

$tsHome = Join-Path ([System.IO.Path]::GetTempPath()) "sensei-crosscheck-ts-$PID"

function Invoke-TsTool {
    param([string]$Tool, [string]$Path)
    Push-Location $tsRoot
    try {
        return (& node (Join-Path $tsRoot 'node_modules\tsx\dist\cli.mjs') (Join-Path $tsRoot 'scripts\tool-run.ts') $Tool $Path $tsHome) -join "`n"
    } finally { Pop-Location }
}

function Compare-Tool {
    param([string]$Tool)
    $ps = (@(& $script:ToolRegistry[$Tool].Handler $(if ($Tool -eq 'log_slice') { @{ path = $log; tail = 3 } } else { @{ path = $log } })) -join "`n")
    $ts = Invoke-TsTool -Tool $Tool -Path $log
    $psN = ($ps -replace "`r`n", "`n").TrimEnd("`n")
    $tsN = ($ts -replace "`r`n", "`n").TrimEnd("`n")
    if ($psN -eq $tsN) {
        Write-Host "  MATCH  $Tool (byte-identical after newline normalization)"
        return $true
    }
    Write-Host "  DIFF   $Tool"
    $a = $psN -split "`n"; $b = $tsN -split "`n"
    $n = [Math]::Max($a.Count, $b.Count)
    $shown = 0
    for ($i = 0; $i -lt $n -and $shown -lt 6; $i++) {
        $la = if ($i -lt $a.Count) { $a[$i] } else { '<missing>' }
        $lb = if ($i -lt $b.Count) { $b[$i] } else { '<missing>' }
        if ($la -ne $lb) {
            Write-Host "    line $($i + 1):"
            Write-Host "      PS: $la"
            Write-Host "      TS: $lb"
            $shown++
        }
    }
    return $false
}

Write-Host "cross-check on $log"
$ok = $true
foreach ($tool in 'log_stats', 'log_slice') {
    if (-not (Compare-Tool -Tool $tool)) { $ok = $false }
}
Remove-Item -Recurse -Force $psTempHome, $tsHome -ErrorAction SilentlyContinue
if ($ok) { Write-Host 'CROSS-CHECK PASSED' } else { Write-Host 'CROSS-CHECK FOUND DIFFERENCES'; exit 1 }
