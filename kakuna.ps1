#!/usr/bin/env pwsh
# Kakuna — a terminal AI agent for debugging logs, powered by the OpenAI API or local Ollama.
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
$script:KakunaVersion = '0.2.0'
$script:YoloMode      = $false
$script:LocalMode     = $false
$script:PrintMode     = $false
$script:ModelOverride = $null
$script:PrintPrompt   = $null
$script:ResumeFlag    = $false
$script:SessionId     = [guid]::NewGuid().ToString('n').Substring(0, 12)

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -match '^--?(yolo|dangerously-skip-permissions)$') {
        $script:YoloMode = $true
    } elseif ($arg -match '^--?local$') {
        $script:LocalMode = $true
    } elseif ($arg -match '^--?resume$') {
        $script:ResumeFlag = $true
    } elseif ($arg -match '^(-p|--print)$') {
        if ($i + 1 -lt $args.Count) { $script:PrintPrompt = [string]$args[++$i]; $script:PrintMode = $true }
        else { Write-Host 'kakuna: -p requires a prompt'; exit 1 }
    } elseif ($arg -match '^--?model$') {
        if ($i + 1 -lt $args.Count) { $script:ModelOverride = [string]$args[++$i] }
        else { Write-Host 'kakuna: --model requires a value'; exit 1 }
    } elseif ($arg -match '^--?(help|h|\?)$') {
        Write-Host 'usage: kakuna [--local] [--model <name>] [--yolo] [--resume] [-p <prompt>]'
        Write-Host ''
        Write-Host '  --local         use a local Ollama model instead of OpenAI (no API key needed)'
        Write-Host '  --model <name>  override the configured model for this session'
        Write-Host '  --yolo          skip all tool permission prompts (alias: --dangerously-skip-permissions)'
        Write-Host '  --resume        pick a previous session to continue'
        Write-Host '  -p <prompt>     print mode: run one prompt non-interactively and exit'
        exit 0
    } else {
        Write-Host "kakuna: unknown option '$arg' (try --help)"
        exit 1
    }
}

foreach ($f in 'render', 'config', 'input', 'permissions', 'hooks', 'tools', 'tasks', 'logtools', 'prompts', 'openai', 'agent', 'mcp', 'repl') {
    . (Join-Path $script:KakunaRoot "src\$f.ps1")
}

Initialize-KakunaConfig
if ($script:ModelOverride) {
    if ($script:LocalMode) { $script:Config.local_model = $script:ModelOverride }
    else { $script:Config.model = $script:ModelOverride }
}
if (-not $script:Config.theme -or ($script:PrintMode -and [Console]::IsOutputRedirected)) {
    foreach ($k in @($script:Theme.Keys)) { $script:Theme[$k] = '' }
}
Initialize-KakunaInput

if (-not $script:PrintMode) {
    Show-KakunaBanner
    if ($script:YoloMode) {
        Write-Host "$($script:Theme.Err) yolo mode: all tool permission prompts are OFF$($script:Theme.Reset)"
        Write-Host ''
    }
}

Start-KakunaMcpServers

$script:Messages = [System.Collections.Generic.List[object]]::new()
$script:Messages.Add(@{ role = 'system'; content = (Get-KakunaSystemPrompt) })

try {
    if ($script:PrintMode) {
        Invoke-AgentTurn $script:PrintPrompt
    } else {
        if ($script:ResumeFlag) { Show-ResumePicker }
        Start-KakunaRepl
    }
} finally {
    Stop-KakunaMcpServers
    Stop-AllBackgroundTasks
    Save-KakunaSession
    if ($script:HttpClient) { $script:HttpClient.Dispose() }
    if (-not $script:PrintMode) {
        Write-Host "$($script:Theme.Accent) kakuna out. harden well.$($script:Theme.Reset)"
    }
}
