# permissions.ps1 — gate for tools that write or execute: session allows,
# persistent allowlist rules, diff previews, print-mode policy.

$script:SessionAllowed = [System.Collections.Generic.HashSet[string]]::new()

function Test-SenseiAllowRule {
    # Rule grammar: "tool" or "tool(pattern)". Wildcards (-like) allowed in both
    # parts. Pattern is tested against the tool's primary argument, raw and resolved.
    param([string]$Rule, [string]$ToolName, [string]$PrimaryValue, [string]$ResolvedValue)
    if ($Rule -notmatch '^([^(]+?)(?:\((.*)\))?$') { return $false }
    $namePat = $Matches[1].Trim()
    $argPat = $Matches[2]
    if ($ToolName -notlike $namePat) { return $false }
    if ([string]::IsNullOrEmpty($argPat)) { return $true }
    if ($PrimaryValue -and $PrimaryValue -like $argPat) { return $true }
    if ($ResolvedValue -and $ResolvedValue -like $argPat) { return $true }
    return $false
}

function Get-SenseiPrimaryArg {
    param([hashtable]$Tool, [hashtable]$ToolArgs)
    $primary = $null; $resolved = $null
    if ($Tool.PrimaryArg -and $ToolArgs) {
        $primary = [string]$ToolArgs[$Tool.PrimaryArg]
        if ($Tool.PrimaryArg -eq 'path' -and $primary) {
            try { $resolved = Resolve-SenseiPath $primary } catch { }
        }
    }
    return @($primary, $resolved)
}

function Test-SenseiAllowlist {
    param([string]$Name, [hashtable]$Tool, [hashtable]$ToolArgs)
    $primary, $resolved = Get-SenseiPrimaryArg $Tool $ToolArgs
    foreach ($r in (Get-SenseiAllowRules)) {
        if (Test-SenseiAllowRule -Rule $r.Rule -ToolName $Name -PrimaryValue $primary -ResolvedValue $resolved) { return $true }
    }
    return $false
}

function Add-SenseiProjectAllowRule {
    param([string]$Rule)
    $projPath = Join-Path (Get-Location).Path '.sensei.json'
    $proj = @{}
    if (Test-Path -LiteralPath $projPath) {
        try { $proj = Get-Content -LiteralPath $projPath -Raw | ConvertFrom-Json -AsHashtable } catch { $proj = @{} }
        if (-not $proj) { $proj = @{} }
    }
    if (-not $proj.permissions) { $proj.permissions = @{} }
    $proj.permissions.allow = @(@($proj.permissions.allow) + $Rule | Where-Object { $_ } | Select-Object -Unique)
    ConvertTo-Json -InputObject $proj -Depth 12 | Set-Content -LiteralPath $projPath -Encoding utf8NoBOM
    $script:ProjectConfig = $proj
    Write-SenseiNote "  allowlist rule saved to .sensei.json: $Rule"
}

function Get-SenseiPersistRule {
    # The rule the [p]ersist option writes for this tool call.
    param([string]$Name, [hashtable]$Tool, [hashtable]$ToolArgs)
    if ($Name -eq 'run_powershell') {
        $first = ([string]$ToolArgs['command']).Trim() -split '\s+' | Select-Object -First 1
        if ($first) { return "run_powershell($first *)" }
        return 'run_powershell'
    }
    if ($Tool.PrimaryArg -eq 'path') {
        $primary, $resolved = Get-SenseiPrimaryArg $Tool $ToolArgs
        if ($resolved) { return "$Name($resolved)" }
    }
    return $Name
}

function Request-ToolPermission {
    param(
        [string]$Name,
        [hashtable]$Tool,
        [hashtable]$ToolArgs
    )
    if ($Tool.ReadOnly) { return $true }
    if ($script:PlanMode) { return $false }   # plan mode is read-only until a plan is approved
    if ($script:YoloMode -or $script:SessionAllowed.Contains($Name)) { return $true }
    if (Test-SenseiAllowlist -Name $Name -Tool $Tool -ToolArgs $ToolArgs) { return $true }
    if ($script:PrintMode -or [Console]::IsInputRedirected) { return $false }   # non-interactive: deny

    $primary, $resolved = Get-SenseiPrimaryArg $Tool $ToolArgs
    $preview = if ($primary) { $primary } else { $Name }
    Write-Host ''
    Write-Host "$($script:Theme.Accent)◆ $Name$($script:Theme.Reset) wants to run:"
    Write-Host "  $($script:Theme.Bold)$(Protect-TerminalText $preview)$($script:Theme.Reset)"
    if ($Name -in 'edit_file', 'write_file') { Write-SenseiDiff -Name $Name -ToolArgs $ToolArgs }
    $ans = (Read-Host '  Allow? [y]es / [n]o / [a]lways this session / [p]ersist to allowlist').Trim().ToLower()
    switch ($ans) {
        'a'       { [void]$script:SessionAllowed.Add($Name); return $true }
        'always'  { [void]$script:SessionAllowed.Add($Name); return $true }
        'p'       { Add-SenseiProjectAllowRule (Get-SenseiPersistRule $Name $Tool $ToolArgs); return $true }
        'persist' { Add-SenseiProjectAllowRule (Get-SenseiPersistRule $Name $Tool $ToolArgs); return $true }
        'y'       { return $true }
        'yes'     { return $true }
        default   { return $false }
    }
}
