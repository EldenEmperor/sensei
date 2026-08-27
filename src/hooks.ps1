# hooks.ps1 — user-configured shell hooks around agent events.
# Config: "hooks": [ { "event": "PreToolUse|PostToolUse|UserPromptSubmit|Stop",
#                      "matcher": "run_powershell", "command": "..." } ]
# The hook command runs in pwsh with a JSON event payload on stdin.
# Exit 0 = continue (stdout shown dim). Exit 2 on PreToolUse/UserPromptSubmit = block
# (stderr becomes the reason). Anything else = warn and continue.

function Invoke-SenseiHooks {
    param(
        [string]$Event,
        [string]$ToolName = '',
        [hashtable]$ToolInput = $null,
        [string]$ToolResponse = $null,
        [string]$Prompt = $null,
        [string]$LastMessage = $null
    )
    $result = @{ Block = $false; Reason = '' }
    $hooks = @(Get-SenseiHooks | Where-Object { [string]$_.event -eq $Event })
    if ($hooks.Count -eq 0) { return $result }

    foreach ($h in $hooks) {
        if ($Event -in 'PreToolUse', 'PostToolUse' -and $h.matcher -and $ToolName -notlike [string]$h.matcher) { continue }
        $payload = @{
            hook_event_name = $Event
            cwd             = (Get-Location).Path
            session_id      = [string]$script:SessionId
        }
        if ($ToolName) { $payload.tool_name = $ToolName; $payload.tool_input = $ToolInput }
        if ($null -ne $ToolResponse) { $payload.tool_response = $ToolResponse }
        if ($null -ne $Prompt) { $payload.prompt = $Prompt }
        if ($null -ne $LastMessage) { $payload.last_message = $LastMessage }
        $json = ConvertTo-Json -InputObject $payload -Depth 30 -Compress

        try {
            $psi = [System.Diagnostics.ProcessStartInfo]::new()
            $psi.FileName = 'pwsh'
            foreach ($x in '-NoProfile', '-NonInteractive', '-Command', [string]$h.command) { $psi.ArgumentList.Add($x) }
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.RedirectStandardInput = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
            $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
            $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
            $psi.WorkingDirectory = (Get-Location).Path
            $p = [System.Diagnostics.Process]::Start($psi)
            try {
                $p.StandardInput.Write($json)
                $p.StandardInput.Close()
                $outTask = $p.StandardOutput.ReadToEndAsync()
                $errTask = $p.StandardError.ReadToEndAsync()
                if (-not $p.WaitForExit(30000)) {
                    try { $p.Kill($true) } catch { }
                    Write-SenseiNote "hook timed out (30s): $($h.command)"
                    continue
                }
                $p.WaitForExit()
                $out = $outTask.GetAwaiter().GetResult()
                $err = $errTask.GetAwaiter().GetResult()
                if ($p.ExitCode -eq 0) {
                    if ($out -and $out.Trim()) { Write-SenseiNote "hook: $($out.Trim())" }
                } elseif ($p.ExitCode -eq 2 -and $Event -in 'PreToolUse', 'UserPromptSubmit') {
                    $result.Block = $true
                    $result.Reason = if ($err) { $err.Trim() } else { "blocked by hook: $($h.command)" }
                    return $result
                } else {
                    Write-SenseiNote "hook exited $($p.ExitCode): $($h.command)$(if ($err) { " — $($err.Trim())" })"
                }
            } finally {
                $p.Dispose()
            }
        } catch {
            Write-SenseiNote "hook failed to run: $($_.Exception.Message)"
        }
    }
    return $result
}
