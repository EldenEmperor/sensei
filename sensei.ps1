#!/usr/bin/env pwsh
# Sensei — a terminal AI agent for debugging logs, powered by the OpenAI API or local Ollama.
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
    Write-Host 'Sensei requires PowerShell 7. Install it with:  winget install --id Microsoft.PowerShell -e'
    exit 1
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::InputEncoding  = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$script:SenseiRoot    = $PSScriptRoot
$script:SenseiVersion = '0.5.0'
$script:YoloMode      = $false
$script:LocalMode     = $false
$script:PrintMode     = $false
$script:PlanMode      = $false
$script:ModelOverride = $null
$script:PrintPrompt   = $null
$script:ResumeFlag    = $false
$script:InvestigatePath = $null
$script:SessionId     = [guid]::NewGuid().ToString('n').Substring(0, 12)

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -match '^--?(yolo|dangerously-skip-permissions)$') {
        $script:YoloMode = $true
    } elseif ($arg -match '^--?local$') {
        $script:LocalMode = $true
    } elseif ($arg -match '^--?resume$') {
        $script:ResumeFlag = $true
    } elseif ($arg -match '^--?plan$') {
        $script:PlanMode = $true
    } elseif ($arg -match '^(-p|--print)$') {
        if ($i + 1 -lt $args.Count) { $script:PrintPrompt = [string]$args[++$i]; $script:PrintMode = $true }
        else { Write-Host 'sensei: -p requires a prompt'; exit 1 }
    } elseif ($arg -match '^--?model$') {
        if ($i + 1 -lt $args.Count) { $script:ModelOverride = [string]$args[++$i] }
        else { Write-Host 'sensei: --model requires a value'; exit 1 }
    } elseif ($arg -match '^--?investigate$') {
        if ($i + 1 -lt $args.Count) { $script:InvestigatePath = [string]$args[++$i] }
        else { Write-Host 'sensei: --investigate requires a log file path'; exit 1 }
    } elseif ($arg -match '^--?(help|h|\?)$') {
        Write-Host 'usage: sensei [--local] [--model <name>] [--yolo] [--resume] [--investigate <path>] [-p <prompt>]'
        Write-Host ''
        Write-Host '  --local         use a local Ollama model instead of OpenAI (no API key needed)'
        Write-Host '  --model <name>  override the configured model for this session'
        Write-Host '  --yolo          skip all tool permission prompts (alias: --dangerously-skip-permissions)'
        Write-Host '  --resume        pick a previous session to continue'
        Write-Host '  --plan          start in plan mode (read-only until you approve a plan)'
        Write-Host '  --investigate <path>  map the log''s structure on startup, then continue interactively'
        Write-Host '  -p <prompt>     print mode: run one prompt non-interactively and exit'
        exit 0
    } else {
        Write-Host "sensei: unknown option '$arg' (try --help)"
        exit 1
    }
}

foreach ($f in 'render', 'config', 'input', 'permissions', 'hooks', 'tools', 'web', 'skills', 'tasks', 'logtools', 'prompts', 'openai', 'agent', 'mcp', 'repl') {
    . (Join-Path $script:SenseiRoot "src\$f.ps1")
}

Initialize-SenseiConfig
if ($script:ModelOverride) {
    if ($script:LocalMode) { $script:Config.local_model = $script:ModelOverride }
    else { $script:Config.model = $script:ModelOverride }
}
if (-not $script:Config.theme -or ($script:PrintMode -and [Console]::IsOutputRedirected)) {
    foreach ($k in @($script:Theme.Keys)) { $script:Theme[$k] = '' }
} else {
    [void](Set-SenseiAccent $script:Config.accent)
}
Initialize-SenseiInput

if (-not $script:PrintMode) {
    Show-SenseiBanner
    if ($script:YoloMode) {
        Write-Host "$($script:Theme.Err) yolo mode: all tool permission prompts are OFF$($script:Theme.Reset)"
        Write-Host ''
    }
}

Register-SenseiSkillTool
Start-SenseiMcpServers

$script:Messages = [System.Collections.Generic.List[object]]::new()
$script:Messages.Add(@{ role = 'system'; content = (Get-SenseiSystemPrompt) })

try {
    if ($script:PrintMode) {
        Invoke-AgentTurn $script:PrintPrompt
    } else {
        if ($script:ResumeFlag) { Show-ResumePicker }
        if ($script:InvestigatePath) {
            $ip = Resolve-SenseiPath $script:InvestigatePath
            if (Test-Path -LiteralPath $ip -PathType Leaf) {
                try { Invoke-AgentTurn ($script:InvestigatePrompt -replace '<PATH>', $ip) }
                catch [System.OperationCanceledException] { Write-SenseiNote '(aborted)' }
            } else {
                Write-SenseiNote "--investigate: file not found: $ip"
            }
        }
        Start-SenseiRepl
    }
} finally {
    Stop-SenseiMcpServers
    Stop-AllBackgroundTasks
    Save-SenseiSession
    if ($script:HttpClient) { $script:HttpClient.Dispose() }
    if (-not $script:PrintMode) {
        Write-Host "$($script:Theme.Accent) sensei out. harden well.$($script:Theme.Reset)"
    }
}
