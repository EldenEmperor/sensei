# tasks.ps1 — background task tracking for run_powershell run_in_background.
# Child output goes to files (the OS owns the pipes — no pump threads, no deadlock).

$script:BackgroundTasks = [ordered]@{}
$script:NextBgId = 0

function Start-SenseiBackgroundTask {
    param([string]$Command)
    $script:NextBgId++
    $id = "bg$($script:NextBgId)"
    $dir = Join-Path $script:ConfigDir "tasks\$PID"
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $outFile = Join-Path $dir "$id.out"
    $errFile = Join-Path $dir "$id.err"
    # -EncodedCommand sidesteps Start-Process's argument-quoting mangling of
    # pipes/quotes in the command string
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Command))
    try {
        $p = Start-Process -FilePath 'pwsh' `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $enc) `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
            -PassThru -NoNewWindow -WorkingDirectory (Get-Location).Path
    } catch {
        return "ERROR: could not start background task: $($_.Exception.Message)"
    }
    $script:BackgroundTasks[$id] = @{
        Id = $id; Process = $p; OutFile = $outFile; ErrFile = $errFile
        Command = $Command; Started = Get-Date
        OutOffset = [long]0; ErrOffset = [long]0
        Notified = $false; UserNotified = $false
    }
    return "Started background task $id (pid $($p.Id)). Use task_output with task_id '$id' to check on it."
}

function Read-TaskFileDelta {
    param([hashtable]$T, [string]$Which)
    $file = if ($Which -eq 'out') { $T.OutFile } else { $T.ErrFile }
    $key = if ($Which -eq 'out') { 'OutOffset' } else { 'ErrOffset' }
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    $fs = [System.IO.FileStream]::new($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($fs.Length -le $T[$key]) { return '' }
        [void]$fs.Seek($T[$key], [System.IO.SeekOrigin]::Begin)
        $buf = [byte[]]::new($fs.Length - $T[$key])
        $n = $fs.Read($buf, 0, $buf.Length)
        $T[$key] = $T[$key] + $n
        return [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
    } finally {
        $fs.Dispose()
    }
}

Register-SenseiTool -Name 'task_output' -ReadOnly $true `
    -Description 'Read the status and any NEW output (since the last check) of a background task started with run_in_background.' `
    -Parameters @{
        type       = 'object'
        properties = @{ task_id = @{ type = 'string'; description = "e.g. 'bg1'" } }
        required   = @('task_id')
    } -Handler {
        param($a)
        $T = $script:BackgroundTasks[[string]$a.task_id]
        if (-not $T) { return "ERROR: no such task '$($a.task_id)' — known tasks: $(@($script:BackgroundTasks.Keys) -join ', ')" }
        $status = if ($T.Process.HasExited) { "exited (code $($T.Process.ExitCode))" } else { 'running' }
        $out = Read-TaskFileDelta $T 'out'
        $err = Read-TaskFileDelta $T 'err'
        $r = "task $($T.Id): $status | started $($T.Started.ToString('HH:mm:ss')) | command: $($T.Command)"
        if ($out) { $r += "`n--- new stdout ---`n$out" }
        if ($err) { $r += "`n--- new stderr ---`n$err" }
        if (-not $out -and -not $err) { $r += "`n(no new output)" }
        return $r
    }

Register-SenseiTool -Name 'kill_task' -ReadOnly $false `
    -Description 'Kill a running background task (and its child processes).' `
    -Parameters @{
        type       = 'object'
        properties = @{ task_id = @{ type = 'string' } }
        required   = @('task_id')
    } -Handler {
        param($a)
        $T = $script:BackgroundTasks[[string]$a.task_id]
        if (-not $T) { return "ERROR: no such task '$($a.task_id)'" }
        if ($T.Process.HasExited) { return "task $($T.Id) already exited (code $($T.Process.ExitCode))" }
        try { $T.Process.Kill($true) } catch { return "ERROR: $($_.Exception.Message)" }
        return "killed task $($T.Id)"
    }

function Add-BackgroundTaskNotices {
    # Inject a completion note as a user-role message. Only called at legal
    # transcript boundaries (turn start / between tool rounds) — a tool-role
    # message without a matching tool_call id would 400 the API.
    param([System.Collections.Generic.List[object]]$Messages)
    foreach ($T in @($script:BackgroundTasks.Values)) {
        if ($T.Process.HasExited -and -not $T.Notified) {
            $T.Notified = $true
            $dur = [int]((Get-Date) - $T.Started).TotalSeconds
            $Messages.Add(@{
                role    = 'user'
                content = "<system-note>Background task $($T.Id) ('$($T.Command)') exited with code $($T.Process.ExitCode) after ${dur}s. Use task_output to read its output.</system-note>"
            })
        }
    }
}

function Show-FinishedTaskNotes {
    # Human-facing dim note at the REPL prompt (separate flag from the model notice).
    foreach ($T in @($script:BackgroundTasks.Values)) {
        if ($T.Process.HasExited -and -not $T.UserNotified) {
            $T.UserNotified = $true
            Write-SenseiNote "background task $($T.Id) finished (exit $($T.Process.ExitCode)) — $($T.Command)"
        }
    }
}

function Stop-AllBackgroundTasks {
    foreach ($T in @($script:BackgroundTasks.Values)) {
        if (-not $T.Process.HasExited) {
            try { $T.Process.Kill($true) } catch { }
            Write-SenseiNote "killed background task $($T.Id)"
        }
    }
}
