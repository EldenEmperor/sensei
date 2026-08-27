# permissions.ps1 — gate for tools that write or execute.

$script:SessionAllowed = [System.Collections.Generic.HashSet[string]]::new()

function Request-ToolPermission {
    param(
        [string]$Name,
        [hashtable]$Tool,
        [hashtable]$ToolArgs
    )
    if ($Tool.ReadOnly -or $script:YoloMode -or $script:SessionAllowed.Contains($Name)) { return $true }

    $preview = if ($Name -eq 'run_powershell') { [string]$ToolArgs['command'] } else { [string]$ToolArgs['path'] }
    Write-Host ''
    Write-Host "$($script:Theme.Accent)◆ $Name$($script:Theme.Reset) wants to run:"
    Write-Host "  $($script:Theme.Bold)$(Protect-TerminalText $preview)$($script:Theme.Reset)"
    $ans = (Read-Host '  Allow? [y]es / [n]o / [a]lways this session').Trim().ToLower()
    switch ($ans) {
        'a'      { [void]$script:SessionAllowed.Add($Name); return $true }
        'always' { [void]$script:SessionAllowed.Add($Name); return $true }
        'y'      { return $true }
        'yes'    { return $true }
        default  { return $false }
    }
}
