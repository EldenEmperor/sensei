# config.ps1 — config load/save, project .sensei.json, first-run setup,
# sessions (save/resume), SENSEI.md memory, cost estimates.

$script:ConfigDir  = Join-Path $HOME '.sensei'
$script:ConfigPath = Join-Path $script:ConfigDir 'config.json'
$script:SessionDir = Join-Path $script:ConfigDir 'sessions'
$script:SessionPath = $null
$script:ProjectConfig = @{}

$script:DefaultConfig = @{
    model               = 'gpt-5.1'
    api_key             = $null
    local_model         = 'qwen3:14b'
    local_base_url      = 'http://localhost:11434/v1'
    max_output_tokens   = 8192
    theme               = $true
    stream              = $true
    save_sessions       = $true
    context_char_budget = 300000
    mcp_call_timeout    = 120
    mcpServers          = @{}
    permissions         = @{ allow = @() }
    hooks               = @()
    prices              = @{}
    output_style        = 'default'
    auto_verify         = $false
    auto_continue       = $true
    embed_model         = 'nomic-embed-text'
    accent              = 'indigo'
}

$script:OutputStyles = @{
    default     = ''
    concise     = 'Answer as tersely as correctness allows: lead with the conclusion, minimal prose, no preamble.'
    explanatory = 'Explain your reasoning as you go: state what you checked, why, and what it implies, so the reader learns the debugging path. Still perform all actions with your own tools — explain what you did, never hand the user steps to run in your place.'
    teaching    = 'Teach as you answer: define the concepts and PowerShell/log techniques involved, and note what the reader should look for next time. Still perform all actions with your own tools — teach by doing, never by handing the user steps to run in your place.'
}

# $/1M tokens (input, output) — estimates; override via config "prices": {"model": [in, out]}
$script:ModelPrices = @{
    'gpt-5.1'    = @(1.25, 10.0)
    'gpt-5'      = @(1.25, 10.0)
    'gpt-5-mini' = @(0.25, 2.0)
    'gpt-4o'     = @(2.5, 10.0)
}

function Initialize-SenseiConfig {
    foreach ($dir in $script:ConfigDir, $script:SessionDir) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
    $cfg = @{} + $script:DefaultConfig
    if (Test-Path -LiteralPath $script:ConfigPath) {
        try {
            $saved = Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json -AsHashtable
            foreach ($k in $saved.Keys) { $cfg[$k] = $saved[$k] }
        } catch {
            Write-SenseiNote "config.json is unreadable, using defaults ($($_.Exception.Message))"
        }
    }
    $script:Config = $cfg

    $script:ProjectConfig = @{}
    $projPath = Join-Path (Get-Location).Path '.sensei.json'
    if (Test-Path -LiteralPath $projPath) {
        try {
            $loaded = Get-Content -LiteralPath $projPath -Raw | ConvertFrom-Json -AsHashtable
            if ($loaded) { $script:ProjectConfig = $loaded }
        } catch {
            Write-SenseiNote ".sensei.json is unreadable, ignoring ($($_.Exception.Message))"
        }
    }

    if (-not $script:LocalMode -and -not (Get-OpenAIApiKey)) { Invoke-FirstRunSetup }
}

function Save-SenseiConfig {
    ConvertTo-Json -InputObject (@{} + $script:Config) -Depth 12 |
        Set-Content -LiteralPath $script:ConfigPath -Encoding utf8NoBOM
}

function Get-ActiveModel {
    if ($script:LocalMode) { return [string]$script:Config.local_model }
    return [string]$script:Config.model
}

function Set-ActiveModel {
    param([string]$Name)
    if ($script:LocalMode) { $script:Config.local_model = $Name }
    else { $script:Config.model = $Name }
    Save-SenseiConfig
}

function Get-OpenAIApiKey {
    if ($env:OPENAI_API_KEY) { return $env:OPENAI_API_KEY }
    if ($script:Config -and $script:Config.api_key) { return [string]$script:Config.api_key }
    return $null
}

# --- merged project/user views ---------------------------------------------

function Get-SenseiMcpServers {
    $merged = [ordered]@{}
    foreach ($src in @($script:Config.mcpServers, $script:ProjectConfig.mcpServers)) {
        if ($src -is [hashtable] -or $src -is [System.Collections.IDictionary]) {
            foreach ($k in $src.Keys) { $merged[[string]$k] = $src[$k] }
        }
    }
    return $merged
}

function Get-SenseiAllowRules {
    $rules = @()
    if ($script:Config.permissions -and $script:Config.permissions.allow) {
        foreach ($r in @($script:Config.permissions.allow)) { $rules += @{ Rule = [string]$r; Source = 'user' } }
    }
    if ($script:ProjectConfig.permissions -and $script:ProjectConfig.permissions.allow) {
        foreach ($r in @($script:ProjectConfig.permissions.allow)) { $rules += @{ Rule = [string]$r; Source = 'project' } }
    }
    return $rules
}

function Get-SenseiHooks {
    $hooks = @()
    if ($script:Config.hooks) { $hooks += @($script:Config.hooks) }
    if ($script:ProjectConfig.hooks) { $hooks += @($script:ProjectConfig.hooks) }
    return $hooks
}

# --- SENSEI.md memory -------------------------------------------------------

function Get-SenseiMemory {
    $out = @()
    # global first, then every SENSEI.md from the drive root down to cwd
    # (nearest last so more-specific memory wins when the model reads top-to-bottom)
    $candidates = @(Join-Path $script:ConfigDir 'SENSEI.md')
    $chain = @()
    $dir = (Get-Location).Path
    while ($dir) {
        $chain += (Join-Path $dir 'SENSEI.md')
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    [array]::Reverse($chain)
    $candidates += $chain
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($p in $candidates) {
        if (-not $seen.Add($p.ToLower())) { continue }
        if (Test-Path -LiteralPath $p -PathType Leaf) {
            $content = Read-SenseiMemoryFile -Path $p
            $out += @{ Path = $p; Content = $content }
        }
    }
    return $out
}

function Read-SenseiMemoryFile {
    # Read a SENSEI.md, resolving one level of `@relative/path.md` import lines.
    param([string]$Path, [int]$Depth = 0)
    $content = Get-Content -LiteralPath $Path -Raw
    if ($content.Length -gt 20000) { $content = $content.Substring(0, 20000) + "`n[truncated]" }
    if ($Depth -ge 1) { return $content }
    $baseDir = Split-Path -Parent $Path
    $lines = foreach ($line in ($content -split "`r?`n")) {
        if ($line -match '^\s*@([^\s]+\.md)\s*$') {
            $imp = Join-Path $baseDir $Matches[1]
            if (Test-Path -LiteralPath $imp -PathType Leaf) {
                "<!-- imported $($Matches[1]) -->`n" + (Read-SenseiMemoryFile -Path $imp -Depth ($Depth + 1))
            } else { $line }
        } else { $line }
    }
    return ($lines -join "`n")
}

function Get-SenseiStyleDirective {
    $style = [string]$script:Config.output_style
    if ($script:OutputStyles.ContainsKey($style)) { return $script:OutputStyles[$style] }
    return ''
}

# --- cost -------------------------------------------------------------------

function Get-SenseiCostLine {
    $inTok = [double]$script:TotalPromptTokens
    $outTok = [double]$script:TotalCompletionTokens
    $line = 'tokens ~{0:n1}k in / {1:n1}k out | model {2}' -f ($inTok / 1000), ($outTok / 1000), (Get-ActiveModel)
    if ($script:LocalMode) { return $line + ' (local · $0)' }
    $model = Get-ActiveModel
    $p = $null
    if ($script:Config.prices -and $script:Config.prices[$model]) { $p = @($script:Config.prices[$model]) }
    elseif ($script:ModelPrices[$model]) { $p = $script:ModelPrices[$model] }
    if ($p -and @($p).Count -ge 2) {
        $cost = ($inTok * [double]$p[0] + $outTok * [double]$p[1]) / 1e6
        $line += ' | ~$' + ('{0:n4}' -f $cost)
    }
    return $line
}

# --- first-run --------------------------------------------------------------

function Invoke-FirstRunSetup {
    if ($script:PrintMode -or [Console]::IsInputRedirected) {
        Write-SenseiError 'No OpenAI API key found (set OPENAI_API_KEY, or use --local).'
        exit 1
    }
    Write-Host ''
    Write-Host "$($script:Theme.Accent)Sensei needs an OpenAI API key (none found in OPENAI_API_KEY or $script:ConfigPath).$($script:Theme.Reset)"
    Write-Host "$($script:Theme.Dim)(Tip: run 'sensei --local' to use a local Ollama model instead — no key needed.)$($script:Theme.Reset)"
    $secure = Read-Host 'Paste your OpenAI API key' -AsSecureString
    $key = [System.Net.NetworkCredential]::new('', $secure).Password.Trim()
    if (-not $key) {
        Write-SenseiError 'No key entered. Set OPENAI_API_KEY and rerun.'
        exit 1
    }
    Write-SenseiNote 'validating key…'
    if (-not (Test-OpenAIKey $key)) {
        Write-SenseiError 'The OpenAI API rejected that key. Check it and rerun.'
        exit 1
    }
    Write-Host "$($script:Theme.Ok)Key OK.$($script:Theme.Reset)"
    Write-Host 'How should Sensei remember it?'
    Write-Host '  [1] User environment variable OPENAI_API_KEY (recommended)'
    Write-Host '  [2] Save in ~/.sensei/config.json (plaintext on disk)'
    Write-Host '  [3] This session only'
    switch ((Read-Host 'Choice [1/2/3]').Trim()) {
        '2' { $script:Config.api_key = $key; Save-SenseiConfig }
        '3' { }
        default {
            [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $key, 'User')
            Write-SenseiNote 'saved to your user environment (new shells pick it up automatically)'
        }
    }
    $env:OPENAI_API_KEY = $key

    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$script:SenseiRoot*") {
        $ans = Read-Host "Add $script:SenseiRoot to your user PATH so 'sensei' works from any shell? [Y/n]"
        if ($ans.Trim() -notmatch '^[nN]') {
            [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $script:SenseiRoot), 'User')
            $env:Path += ';' + $script:SenseiRoot
            Write-SenseiNote 'PATH updated (new shells pick it up automatically)'
        }
    }
    Write-Host ''
}

# --- sessions ---------------------------------------------------------------

function Save-SenseiSession {
    if (-not $script:Config -or -not $script:Config.save_sessions -or $script:PrintMode) { return }
    if (-not $script:Messages -or $script:Messages.Count -le 1) { return }
    if (-not $script:SessionPath) {
        $script:SessionPath = Join-Path $script:SessionDir ("{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
    try {
        ConvertTo-Json -InputObject @($script:Messages) -Depth 30 |
            Set-Content -LiteralPath $script:SessionPath -Encoding utf8NoBOM
        Write-SenseiNote "session saved → $script:SessionPath"
    } catch {
        Write-SenseiNote "couldn't save session: $($_.Exception.Message)"
    }
}

function Get-SenseiSessionFiles {
    if (-not (Test-Path -LiteralPath $script:SessionDir)) { return @() }
    return @(Get-ChildItem -LiteralPath $script:SessionDir -Filter '*.json' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 10)
}

function Restore-SenseiSession {
    param([string]$Path)
    $raw = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    $msgs = [System.Collections.Generic.List[object]]::new()
    foreach ($m in @($raw)) {
        if (-not $m -or -not $m.role -or $m.role -eq 'system') { continue }
        $clean = @{ role = [string]$m.role }
        if ($m.ContainsKey('content')) { $clean.content = $m.content }
        if ($m.role -eq 'assistant' -and $m.tool_calls) {
            $clean.tool_calls = @(foreach ($tc in @($m.tool_calls)) {
                @{ id = [string]$tc.id; type = 'function'
                   function = @{ name = [string]$tc.function.name; arguments = [string]$tc.function.arguments } }
            })
        }
        if ($m.role -eq 'tool') { $clean.tool_call_id = [string]$m.tool_call_id }
        $msgs.Add($clean)
    }
    # validation: keep assistant-with-tool_calls only when every result follows; drop orphan tool msgs
    $valid = [System.Collections.Generic.List[object]]::new()
    $valid.Add(@{ role = 'system'; content = (Get-SenseiSystemPrompt) })
    $i = 0
    while ($i -lt $msgs.Count) {
        $m = $msgs[$i]
        if ($m.role -eq 'assistant' -and $m.tool_calls) {
            $ids = @($m.tool_calls | ForEach-Object { [string]$_.id })
            $tools = [System.Collections.Generic.List[object]]::new()
            $j = $i + 1
            while ($j -lt $msgs.Count -and $msgs[$j].role -eq 'tool') { $tools.Add($msgs[$j]); $j++ }
            $haveIds = @($tools | ForEach-Object { [string]$_.tool_call_id })
            $missing = @($ids | Where-Object { $_ -notin $haveIds })
            if ($missing.Count -eq 0) {
                $valid.Add($m)
                foreach ($tm in $tools) { $valid.Add($tm) }
            }
            $i = $j
        } elseif ($m.role -eq 'tool') {
            $i++   # orphan tool result — drop
        } else {
            $valid.Add($m)
            $i++
        }
    }
    $script:Messages = $valid
    $script:SessionPath = $Path
    return $valid.Count - 1
}

function Show-ResumePicker {
    $files = Get-SenseiSessionFiles
    if ($files.Count -eq 0) { Write-SenseiNote 'no saved sessions'; return }
    Write-Host 'Recent sessions:'
    for ($i = 0; $i -lt $files.Count; $i++) {
        $first = ''
        try {
            $msgs = Get-Content -LiteralPath $files[$i].FullName -Raw | ConvertFrom-Json -AsHashtable
            $firstUser = @($msgs) | Where-Object { $_.role -eq 'user' -and $_.content -notmatch '^\[' } | Select-Object -First 1
            if ($firstUser) {
                $first = ([string]$firstUser.content) -replace '\r?\n.*', ''
                if ($first.Length -gt 80) { $first = $first.Substring(0, 77) + '…' }
            }
            Write-Host ("  [{0}] {1:MM-dd HH:mm}  {2} msgs  {3}" -f ($i + 1), $files[$i].LastWriteTime, @($msgs).Count, (Protect-TerminalText $first))
        } catch {
            Write-Host ("  [{0}] {1:MM-dd HH:mm}  (unreadable)" -f ($i + 1), $files[$i].LastWriteTime)
        }
    }
    $pick = (Read-Host 'Resume which? [number, or Enter to skip]').Trim()
    if ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $files.Count) {
        $n = Restore-SenseiSession -Path $files[[int]$pick - 1].FullName
        Write-SenseiNote "resumed $n messages from $($files[[int]$pick - 1].Name)"
    }
}
