# render.ps1 — theme, banner, markdown rendering (streaming-capable), diffs, todos.

$script:Theme = @{
    Accent = $PSStyle.Foreground.FromRgb(0xF8D030)   # Kakuna yellow
    Dim    = $PSStyle.Foreground.BrightBlack
    Bold   = $PSStyle.Bold
    Err    = $PSStyle.Foreground.BrightRed
    Ok     = $PSStyle.Foreground.Green
    Red    = $PSStyle.Foreground.Red
    Green  = $PSStyle.Foreground.Green
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

# --- markdown rendering (single code path for streaming + complete text) ----

function New-StreamRenderer {
    return @{
        InCode  = $false
        InThink = $false
        Buffer  = [System.Text.StringBuilder]::new()
        RawTail = $false   # currently mid-line after a raw flush; finish the line unstyled
    }
}

function Write-RenderedLine {
    param([hashtable]$R, [string]$Line)
    $t = $script:Theme
    if ($R.InThink) {
        if ($Line -match '</think>') { $R.InThink = $false }
        return
    }
    if ($Line -match '<think>') {
        $R.InThink = -not ($Line -match '</think>')
        return
    }
    if ($Line -match '^\s*```') { $R.InCode = -not $R.InCode; return }
    if ($R.InCode) {
        Write-Host "  $($t.CodeBg)$(Protect-TerminalText $Line)$($t.Reset)"
        return
    }
    $Line = Protect-TerminalText $Line
    if ($Line -match '^#{1,4}\s+(.*)$') {
        Write-Host "$($t.Bold)$($t.Accent)$($Matches[1])$($t.Reset)"
        return
    }
    $out = $Line -replace '^(\s*)[-*]\s+', "`$1$($t.Accent)•$($t.Reset) "
    $out = [regex]::Replace($out, '\*\*(.+?)\*\*', { param($m) "$($script:Theme.Bold)$($m.Groups[1].Value)$($script:Theme.Reset)" })
    $out = [regex]::Replace($out, '`([^`]+)`', { param($m) "$($script:Theme.Accent)$($m.Groups[1].Value)$($script:Theme.Reset)" })
    Write-Host $out
}

function Write-StreamDelta {
    param([hashtable]$R, [string]$Text)
    if (-not $Text) { return }
    [void]$R.Buffer.Append($Text)
    while ($true) {
        $buf = $R.Buffer.ToString()
        $nl = $buf.IndexOf("`n")
        if ($nl -ge 0) {
            $line = $buf.Substring(0, $nl).TrimEnd("`r")
            $R.Buffer.Clear() | Out-Null
            [void]$R.Buffer.Append($buf.Substring($nl + 1))
            if ($R.RawTail) {
                Write-Host (Protect-TerminalText $line)   # finish the raw line
                $R.RawTail = $false
            } else {
                Write-RenderedLine $R $line
            }
            continue
        }
        # no newline buffered: keep long single-paragraph output feeling live
        if (-not $R.RawTail -and -not $R.InCode -and -not $R.InThink -and $buf.Length -gt 200 -and $buf -notmatch '<think') {
            Write-Host -NoNewline (Protect-TerminalText $buf)
            $R.Buffer.Clear() | Out-Null
            $R.RawTail = $true
        } elseif ($R.RawTail -and $buf.Length -gt 0) {
            Write-Host -NoNewline (Protect-TerminalText $buf)
            $R.Buffer.Clear() | Out-Null
        }
        break
    }
}

function Complete-StreamRender {
    param([hashtable]$R)
    $rest = $R.Buffer.ToString()
    $R.Buffer.Clear() | Out-Null
    if ($R.RawTail) {
        if ($rest) { Write-Host (Protect-TerminalText $rest) } else { Write-Host '' }
        $R.RawTail = $false
    } elseif ($rest.Trim()) {
        Write-RenderedLine $R $rest
    }
}

function Write-KakunaMarkdown {
    param([string]$Text)
    if (-not $Text) { return }
    $Text = [regex]::Replace($Text, '(?s)<think>.*?</think>\s*', '')
    if (-not $Text.Trim()) { return }
    $r = New-StreamRenderer
    foreach ($line in $Text -split "`r?`n") { Write-RenderedLine $r $line }
}

# --- diff preview -----------------------------------------------------------

function Write-KakunaDiff {
    param([string]$Name, [hashtable]$ToolArgs)
    $t = $script:Theme
    try {
        if ($Name -eq 'edit_file') {
            $old = @(([string]$ToolArgs.old_string) -split "`r?`n")
            $new = @(([string]$ToolArgs.new_string) -split "`r?`n")
            foreach ($l in ($old | Select-Object -First 20)) { Write-Host "  $($t.Red)- $(Protect-TerminalText $l)$($t.Reset)" }
            if ($old.Count -gt 20) { Write-KakunaNote "  … $($old.Count - 20) more removed lines" }
            foreach ($l in ($new | Select-Object -First 20)) { Write-Host "  $($t.Green)+ $(Protect-TerminalText $l)$($t.Reset)" }
            if ($new.Count -gt 20) { Write-KakunaNote "  … $($new.Count - 20) more added lines" }
        } elseif ($Name -eq 'write_file') {
            $path = Resolve-KakunaPath ([string]$ToolArgs.path)
            $newLines = @(([string]$ToolArgs.content) -split "`r?`n")
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $oldLines = @(Get-Content -LiteralPath $path)
                $diff = @(Compare-Object $oldLines $newLines)
                $minus = @($diff | Where-Object SideIndicator -eq '<=').Count
                $plus = @($diff | Where-Object SideIndicator -eq '=>').Count
                foreach ($d in ($diff | Select-Object -First 40)) {
                    if ($d.SideIndicator -eq '<=') { Write-Host "  $($t.Red)- $(Protect-TerminalText $d.InputObject)$($t.Reset)" }
                    else { Write-Host "  $($t.Green)+ $(Protect-TerminalText $d.InputObject)$($t.Reset)" }
                }
                Write-KakunaNote "  (overwrite: -$minus/+$plus changed lines vs the existing file)"
            } else {
                foreach ($l in ($newLines | Select-Object -First 20)) { Write-Host "  $($t.Green)+ $(Protect-TerminalText $l)$($t.Reset)" }
                Write-KakunaNote "  (new file, $($newLines.Count) lines)"
            }
        }
    } catch {
        Write-KakunaNote "  (diff preview unavailable: $($_.Exception.Message))"
    }
}

# --- todo checklist ---------------------------------------------------------

function Write-KakunaTodos {
    $t = $script:Theme
    if (-not $script:Todos -or @($script:Todos).Count -eq 0) {
        Write-KakunaNote '  (no todos)'
        return
    }
    foreach ($td in @($script:Todos)) {
        $c = Protect-TerminalText ([string]$td.content)
        switch ([string]$td.status) {
            'completed'   { Write-Host "  $($t.Dim)[x] $c$($t.Reset)" }
            'in_progress' { Write-Host "  $($t.Accent)[>] $c$($t.Reset)" }
            default       { Write-Host "  [ ] $c" }
        }
    }
}
