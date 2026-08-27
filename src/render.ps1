# render.ps1 — theme, banner, spinner, and terminal markdown rendering.

$script:Theme = @{
    Accent = $PSStyle.Foreground.FromRgb(0xF8D030)   # Kakuna yellow
    Dim    = $PSStyle.Foreground.BrightBlack
    Bold   = $PSStyle.Bold
    Err    = $PSStyle.Foreground.BrightRed
    Ok     = $PSStyle.Foreground.Green
    CodeBg = $PSStyle.Background.FromRgb(0x1F1F1F)
    Reset  = $PSStyle.Reset
}

function Protect-TerminalText {
    # Neutralize raw ESC chars arriving in model output or log content so a
    # hostile log line can't inject terminal control sequences.
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    return $Text -replace "`e", [string][char]0x241B
}

function Write-KakunaError { param([string]$Text) Write-Host "$($script:Theme.Err)✗ $(Protect-TerminalText $Text)$($script:Theme.Reset)" }
function Write-KakunaNote  { param([string]$Text) Write-Host "$($script:Theme.Dim)$(Protect-TerminalText $Text)$($script:Theme.Reset)" }

function Show-KakunaBanner {
    $bannerPath = Join-Path $script:KakunaRoot 'assets\banner.txt'
    if (Test-Path -LiteralPath $bannerPath) {
        foreach ($line in Get-Content -LiteralPath $bannerPath -Encoding utf8) {
            Write-Host "$($script:Theme.Accent)$line$($script:Theme.Reset)"
        }
    }
    $modelLabel = Get-ActiveModel
    if ($script:LocalMode) { $modelLabel += ' (local · ollama)' }
    Write-Host "$($script:Theme.Bold)$($script:Theme.Accent)  kakuna$($script:Theme.Reset)$($script:Theme.Dim) v$($script:KakunaVersion) · log-debugging agent · model: $modelLabel$($script:Theme.Reset)"
    Write-Host "$($script:Theme.Dim)  ask about a log file, or /help for commands$($script:Theme.Reset)"
    Write-Host ''
}

function Invoke-WithSpinner {
    # Animate a spinner while a .NET Task runs. Returns when the task completes
    # (it does NOT throw for a faulted task — the caller unwraps the result).
    param(
        [System.Threading.Tasks.Task]$Task,
        [string]$Label = 'thinking…'
    )
    $frames = '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'
    $handle = ([System.IAsyncResult]$Task).AsyncWaitHandle
    if ([Console]::IsOutputRedirected) {
        [void]$handle.WaitOne()
        return
    }
    $i = 0
    try {
        while (-not $handle.WaitOne(90)) {
            Write-Host -NoNewline "`r$($script:Theme.Accent)$($frames[$i % $frames.Count]) $Label$($script:Theme.Reset)"
            $i++
        }
    } finally {
        Write-Host -NoNewline ("`r" + (' ' * ($Label.Length + 4)) + "`r")
    }
}

function Write-KakunaMarkdown {
    # Minimal line-based markdown → ANSI pass: headers, bullets, code fences,
    # inline `code` and **bold**. Deliberately no links/tables/nesting.
    param([string]$Text)
    if (-not $Text) { return }
    # local reasoning models (qwen3, deepseek-r1) may leak <think> blocks
    $Text = [regex]::Replace($Text, '(?s)<think>.*?</think>\s*', '')
    if (-not $Text.Trim()) { return }
    $Text = Protect-TerminalText $Text
    $t = $script:Theme
    $inCode = $false
    foreach ($line in $Text -split "`r?`n") {
        if ($line -match '^\s*```') { $inCode = -not $inCode; continue }
        if ($inCode) {
            Write-Host "  $($t.CodeBg)$line$($t.Reset)"
            continue
        }
        if ($line -match '^#{1,4}\s+(.*)$') {
            Write-Host "$($t.Bold)$($t.Accent)$($Matches[1])$($t.Reset)"
            continue
        }
        $out = $line -replace '^(\s*)[-*]\s+', "`$1$($t.Accent)•$($t.Reset) "
        $out = [regex]::Replace($out, '\*\*(.+?)\*\*', { param($m) "$($script:Theme.Bold)$($m.Groups[1].Value)$($script:Theme.Reset)" })
        $out = [regex]::Replace($out, '`([^`]+)`', { param($m) "$($script:Theme.Accent)$($m.Groups[1].Value)$($script:Theme.Reset)" })
        Write-Host $out
    }
}
