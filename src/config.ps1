# config.ps1 — config load/save, first-run setup, session transcripts.

$script:ConfigDir  = Join-Path $HOME '.kakuna'
$script:ConfigPath = Join-Path $script:ConfigDir 'config.json'
$script:SessionDir = Join-Path $script:ConfigDir 'sessions'

$script:DefaultConfig = @{
    model               = 'gpt-5.1'
    api_key             = $null
    local_model         = 'qwen3:14b'
    local_base_url      = 'http://localhost:11434/v1'
    max_output_tokens   = 8192
    theme               = $true
    save_sessions       = $true
    context_char_budget = 300000
}

function Initialize-KakunaConfig {
    foreach ($dir in $script:ConfigDir, $script:SessionDir) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
    $cfg = @{} + $script:DefaultConfig
    if (Test-Path -LiteralPath $script:ConfigPath) {
        try {
            $saved = Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json -AsHashtable
            foreach ($k in $saved.Keys) { $cfg[$k] = $saved[$k] }
        } catch {
            Write-KakunaNote "config.json is unreadable, using defaults ($($_.Exception.Message))"
        }
    }
    $script:Config = $cfg
    if (-not $script:LocalMode -and -not (Get-OpenAIApiKey)) { Invoke-FirstRunSetup }
}

function Get-ActiveModel {
    if ($script:LocalMode) { return [string]$script:Config.local_model }
    return [string]$script:Config.model
}

function Set-ActiveModel {
    param([string]$Name)
    if ($script:LocalMode) { $script:Config.local_model = $Name }
    else { $script:Config.model = $Name }
    Save-KakunaConfig
}

function Save-KakunaConfig {
    ConvertTo-Json -InputObject (@{} + $script:Config) -Depth 12 |
        Set-Content -LiteralPath $script:ConfigPath -Encoding utf8NoBOM
}

function Get-OpenAIApiKey {
    if ($env:OPENAI_API_KEY) { return $env:OPENAI_API_KEY }
    if ($script:Config -and $script:Config.api_key) { return [string]$script:Config.api_key }
    return $null
}

function Invoke-FirstRunSetup {
    Write-Host ''
    Write-Host "$($script:Theme.Accent)Kakuna needs an OpenAI API key (none found in OPENAI_API_KEY or $script:ConfigPath).$($script:Theme.Reset)"
    $secure = Read-Host 'Paste your OpenAI API key' -AsSecureString
    $key = [System.Net.NetworkCredential]::new('', $secure).Password.Trim()
    if (-not $key) {
        Write-KakunaError 'No key entered. Set OPENAI_API_KEY and rerun.'
        exit 1
    }
    Write-KakunaNote 'validating key…'
    if (-not (Test-OpenAIKey $key)) {
        Write-KakunaError 'The OpenAI API rejected that key. Check it and rerun.'
        exit 1
    }
    Write-Host "$($script:Theme.Ok)Key OK.$($script:Theme.Reset)"
    Write-Host 'How should Kakuna remember it?'
    Write-Host '  [1] User environment variable OPENAI_API_KEY (recommended)'
    Write-Host '  [2] Save in ~/.kakuna/config.json (plaintext on disk)'
    Write-Host '  [3] This session only'
    switch ((Read-Host 'Choice [1/2/3]').Trim()) {
        '2' { $script:Config.api_key = $key; Save-KakunaConfig }
        '3' { }
        default {
            [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $key, 'User')
            Write-KakunaNote 'saved to your user environment (new shells pick it up automatically)'
        }
    }
    $env:OPENAI_API_KEY = $key

    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$script:KakunaRoot*") {
        $ans = Read-Host "Add $script:KakunaRoot to your user PATH so 'kakuna' works from any shell? [Y/n]"
        if ($ans.Trim() -notmatch '^[nN]') {
            [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $script:KakunaRoot), 'User')
            $env:Path += ';' + $script:KakunaRoot
            Write-KakunaNote 'PATH updated (new shells pick it up automatically)'
        }
    }
    Write-Host ''
}

function Save-KakunaSession {
    if (-not $script:Config -or -not $script:Config.save_sessions) { return }
    if (-not $script:Messages -or $script:Messages.Count -le 1) { return }
    $path = Join-Path $script:SessionDir ("{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        ConvertTo-Json -InputObject @($script:Messages) -Depth 30 |
            Set-Content -LiteralPath $path -Encoding utf8NoBOM
        Write-KakunaNote "session saved → $path"
    } catch {
        Write-KakunaNote "couldn't save session: $($_.Exception.Message)"
    }
}
