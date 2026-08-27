#!/usr/bin/env pwsh
# Kakuna — a terminal AI agent for debugging logs, powered by the OpenAI API.
# NOTE: this file must stay parseable by Windows PowerShell 5.1 so the
# relaunch guard below can run; pwsh-7-only syntax goes in src\*.ps1.

if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $pwshCmd) {
        $fallback = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
        if (Test-Path $fallback) { $pwshCmd = Get-Command $fallback }
    }
    if ($pwshCmd) {
        & $pwshCmd.Source -NoLogo -NoProfile -File $PSCommandPath @args
        exit $LASTEXITCODE
    }
    Write-Host 'Kakuna requires PowerShell 7. Install it with:  winget install --id Microsoft.PowerShell -e'
    exit 1
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::InputEncoding  = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$script:KakunaRoot    = $PSScriptRoot
$script:KakunaVersion = '0.1.0'
$script:YoloMode      = $false
$script:LocalMode     = $false
$script:ModelOverride = $null

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -match '^--?(yolo|dangerously-skip-permissions)$') {
        $script:YoloMode = $true
    } elseif ($arg -match '^--?local$') {
        $script:LocalMode = $true
    } elseif ($arg -match '^--?model$') {
        if ($i + 1 -lt $args.Count) { $script:ModelOverride = [string]$args[++$i] }
        else { Write-Host 'kakuna: --model requires a value'; exit 1 }
    } elseif ($arg -match '^--?(help|h|\?)$') {
        Write-Host 'usage: kakuna [--local] [--model <name>] [--yolo]'
        Write-Host ''
        Write-Host '  --local         use a local Ollama model instead of OpenAI (no API key needed)'
        Write-Host '  --model <name>  override the configured model for this session'
        Write-Host '  --yolo          skip all tool permission prompts (alias: --dangerously-skip-permissions)'
        exit 0
    } else {
        Write-Host "kakuna: unknown option '$arg' (try --help)"
        exit 1
    }
}

foreach ($f in 'render', 'config', 'permissions', 'tools', 'logtools', 'prompts', 'openai', 'agent', 'repl') {
    . (Join-Path $script:KakunaRoot "src\$f.ps1")
}

Initialize-KakunaConfig
if ($script:ModelOverride) {
    if ($script:LocalMode) { $script:Config.local_model = $script:ModelOverride }
    else { $script:Config.model = $script:ModelOverride }
}
if (-not $script:Config.theme) {
    foreach ($k in @($script:Theme.Keys)) { $script:Theme[$k] = '' }
}

Show-KakunaBanner
if ($script:YoloMode) {
    Write-Host "$($script:Theme.Err) yolo mode: all tool permission prompts are OFF$($script:Theme.Reset)"
    Write-Host ''
}

$script:Messages = [System.Collections.Generic.List[object]]::new()
$script:Messages.Add(@{ role = 'system'; content = $script:SystemPrompt })

try {
    Start-KakunaRepl
} finally {
    Save-KakunaSession
    if ($script:HttpClient) { $script:HttpClient.Dispose() }
    Write-Host "$($script:Theme.Accent) kakuna out. harden well.$($script:Theme.Reset)"
}
