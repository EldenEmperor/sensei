# input.ps1 — PSReadLine-backed input and Ctrl+C-aware task waits.

$script:UsePSReadLine = $false

function Initialize-KakunaInput {
    if ([Console]::IsInputRedirected -or $script:PrintMode) { return }
    try {
        Import-Module PSReadLine -ErrorAction Stop
        Set-PSReadLineOption -HistorySavePath (Join-Path $script:ConfigDir 'history.txt') `
            -HistorySaveStyle SaveIncrementally -PredictionSource History -ErrorAction Stop
        Set-PSReadLineKeyHandler -Chord Ctrl+d -ScriptBlock {
            [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
            [Microsoft.PowerShell.PSConsoleReadLine]::Insert('/exit')
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
        $script:UsePSReadLine = $true
    } catch {
        Write-KakunaNote "PSReadLine unavailable ($($_.Exception.Message)); using basic input"
    }
}

# PSReadLine calls the host's prompt function when it redraws (e.g. on resize) —
# keep it identical to the prompt Read-KakunaInput prints.
function prompt { "$($script:Theme.Accent)kakuna ❯ $($script:Theme.Reset)" }

function Read-KakunaInput {
    Write-Host -NoNewline "$($script:Theme.Accent)kakuna ❯ $($script:Theme.Reset)"
    if ($script:UsePSReadLine) {
        try {
            return [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace, $ExecutionContext, $true)
        } catch {
            $script:UsePSReadLine = $false
            Write-KakunaNote 'PSReadLine failed; falling back to basic input'
        }
    }
    return [Console]::ReadLine()
}

function Wait-KakunaTask {
    # Poll a .NET Task to completion. Ctrl+C / Esc → cancel the CTS and throw
    # OperationCanceledException. A faulted task counts as done (the caller's
    # GetResult() surfaces its real exception). $OnTick runs every ~60ms.
    # Callers that check keys must have set [Console]::TreatControlCAsInput.
    param(
        [object]$Task,
        [System.Threading.CancellationTokenSource]$Cts,
        [scriptblock]$OnTick
    )
    $canKeys = -not [Console]::IsInputRedirected
    while ($true) {
        $done = $false
        try { $done = $Task.Wait(60) } catch { $done = $true }
        if ($done) { return }
        if ($canKeys) {
            while ([Console]::KeyAvailable) {
                $k = [Console]::ReadKey($true)
                if (($k.Key -eq 'C' -and ($k.Modifiers -band [ConsoleModifiers]::Control)) -or $k.Key -eq 'Escape') {
                    if ($Cts) { $Cts.Cancel() }
                    throw [System.OperationCanceledException]::new('aborted by user')
                }
            }
        }
        if ($OnTick) { & $OnTick }
    }
}

function Invoke-CancellableWait {
    # Spinner + Ctrl+C abort around a Task. Throws OperationCanceledException on abort.
    param(
        [object]$Task,
        [System.Threading.CancellationTokenSource]$Cts,
        [string]$Label = 'thinking…'
    )
    $canKeys = -not [Console]::IsInputRedirected
    $canSpin = -not [Console]::IsOutputRedirected
    if (-not $canKeys -and -not $canSpin) {
        try { [void]$Task.Wait() } catch { }
        return
    }
    $frames = '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'
    $state = @{ I = 0 }
    $prev = $null
    if ($canKeys) {
        while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }   # drain strays
        $prev = [Console]::TreatControlCAsInput
        [Console]::TreatControlCAsInput = $true
    }
    try {
        $tick = if ($canSpin) {
            { Write-Host -NoNewline "`r$($script:Theme.Accent)$($frames[$state.I % $frames.Count]) $Label$($script:Theme.Reset)"; $state.I++ }
        } else { $null }
        Wait-KakunaTask -Task $Task -Cts $Cts -OnTick $tick
    } finally {
        if ($canSpin) { Write-Host -NoNewline ("`r" + (' ' * ($Label.Length + 4)) + "`r") }
        if ($canKeys) { [Console]::TreatControlCAsInput = $prev }
    }
}
