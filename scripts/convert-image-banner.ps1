# convert-image-banner.ps1 — downscale an image into truecolor ANSI half-block
# art for assets/banner.txt. Windows-only (System.Drawing / GDI+).
#
#   pwsh -File scripts\convert-image-banner.ps1 -Path <image> [-Width 46] [-DebugMap]
#
# Near-black pixels are transparent; fully-gray regions with no blue content
# (background bands/gradients) are dropped too, so only the subject survives.

param(
    [Parameter(Mandatory)] [string]$Path,
    [int]$Width = 46,
    [switch]$DebugMap,
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $Path).Path)
try {
    $srcW = $img.Width; $srcH = $img.Height
    $gridH = [int][Math]::Round($srcH / $srcW * $Width)
    if ($gridH % 2 -ne 0) { $gridH++ }   # half-blocks pair rows

    # sample each target cell's source block
    $cells = New-Object 'object[,]' $Width, $gridH
    $banded = New-Object 'object[,]' $Width, $gridH
    $debug = @()
    for ($ty = 0; $ty -lt $gridH; $ty++) {
        $rowDbg = ''
        $sy0 = [int][Math]::Floor($ty * $srcH / $gridH)
        $sy1 = [int][Math]::Ceiling(($ty + 1) * $srcH / $gridH)
        for ($tx = 0; $tx -lt $Width; $tx++) {
            $sx0 = [int][Math]::Floor($tx * $srcW / $Width)
            $sx1 = [int][Math]::Ceiling(($tx + 1) * $srcW / $Width)
            $n = 0; $solid = 0; $blue = 0; $gray = 0; $red = 0
            $sr = 0; $sg = 0; $sb = 0
            for ($y = $sy0; $y -lt $sy1; $y += 2) {
                for ($x = $sx0; $x -lt $sx1; $x += 2) {
                    $p = $img.GetPixel([Math]::Min($x, $srcW - 1), [Math]::Min($y, $srcH - 1))
                    $n++
                    $mx = [Math]::Max($p.R, [Math]::Max($p.G, $p.B))
                    if ($mx -lt 40) { continue }               # near-black = transparent
                    $solid++
                    $sr += $p.R; $sg += $p.G; $sb += $p.B
                    $isGray = ([Math]::Abs($p.R - $p.G) -lt 30 -and [Math]::Abs($p.G - $p.B) -lt 30 -and [Math]::Abs($p.R - $p.B) -lt 30)
                    if ($isGray) { $gray++ }
                    if ($p.B -gt ($p.R + 25) -and $p.B -gt ($p.G + 10)) { $blue++ }
                    if ($p.R -gt ($p.B + 40) -and $p.R -gt ($p.G + 40)) { $red++ }
                }
            }
            $cell = $null
            if ($n -gt 0 -and $solid / $n -ge 0.3) {
                # fully-gray blocks with no blue = background band → drop (but
                # remember the color: a later pass restores band cells that have
                # in-column neighbors, i.e. the sword blade crossing the band)
                $grayFrac = if ($solid) { $gray / $solid } else { 0 }
                $blueFrac = if ($solid) { $blue / $solid } else { 0 }
                $avg = @([int]($sr / $solid), [int]($sg / $solid), [int]($sb / $solid))
                if ($grayFrac -gt 0.85 -and $blueFrac -lt 0.12) {
                    $banded[$tx, $ty] = $avg
                } else {
                    $cell = $avg
                }
            }
            $cells[$tx, $ty] = $cell
            if ($DebugMap) {
                if ($null -eq $cell) { $rowDbg += '.' }
                elseif ($red -gt 0 -and $red -ge $blue) { $rowDbg += 'R' }
                elseif ($cell[0] -gt 200 -and $cell[1] -gt 200 -and $cell[2] -gt 200) { $rowDbg += 'W' }
                elseif ($cell[2] -gt $cell[0]) { $rowDbg += 'B' }
                else { $rowDbg += 'g' }
            }
        }
        if ($DebugMap) { $debug += $rowDbg }
    }

    # restore band cells strictly BETWEEN a column's surviving content — the
    # sword blade crossing the band, and silhouette gaps where the band shows
    # through in the source. The open band (no content above) stays dropped.
    for ($tx = 0; $tx -lt $Width; $tx++) {
        $top = -1; $bottom = -1
        for ($ty = 0; $ty -lt $gridH; $ty++) {
            if ($null -ne $cells[$tx, $ty]) {
                if ($top -lt 0) { $top = $ty }
                $bottom = $ty
            }
        }
        if ($top -lt 0) { continue }
        for ($ty = $top + 1; $ty -lt $bottom; $ty++) {
            if ($null -eq $cells[$tx, $ty] -and $null -ne $banded[$tx, $ty]) {
                $cells[$tx, $ty] = $banded[$tx, $ty]
            }
        }
    }

    if ($DebugMap) {
        for ($ty = 0; $ty -lt $gridH; $ty++) {
            $rowDbg = ''
            for ($tx = 0; $tx -lt $Width; $tx++) {
                $c = $cells[$tx, $ty]
                if ($null -eq $c) { $rowDbg += '.' }
                elseif ($c[0] -gt ($c[2] + 40) -and $c[0] -gt ($c[1] + 40)) { $rowDbg += 'R' }
                elseif ($c[0] -gt 200 -and $c[1] -gt 200 -and $c[2] -gt 200) { $rowDbg += 'W' }
                elseif ($c[2] -gt $c[0]) { $rowDbg += 'B' }
                else { $rowDbg += 'g' }
            }
            Write-Host $rowDbg
        }
    }

    $esc = [char]0x1B
    $reset = "$esc[0m"
    $lines = for ($ty = 0; $ty -lt $gridH; $ty += 2) {
        $line = ''
        $open = $false
        for ($tx = 0; $tx -lt $Width; $tx++) {
            $t = $cells[$tx, $ty]
            $b = $cells[$tx, ($ty + 1)]
            if ($null -eq $t -and $null -eq $b) {
                if ($open) { $line += $reset; $open = $false }
                $line += ' '
            } elseif ($t -and $b) {
                $line += "$esc[38;2;$($t[0]);$($t[1]);$($t[2])m$esc[48;2;$($b[0]);$($b[1]);$($b[2])m" + [char]0x2580
                $open = $true
            } elseif ($t) {
                if ($open) { $line += $reset }
                $line += "$esc[38;2;$($t[0]);$($t[1]);$($t[2])m" + [char]0x2580
                $open = $true
            } else {
                if ($open) { $line += $reset }
                $line += "$esc[38;2;$($b[0]);$($b[1]);$($b[2])m" + [char]0x2584
                $open = $true
            }
        }
        if ($open) { $line += $reset }
        $line.TrimEnd()
    }

    if (-not $OutFile) { $OutFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\banner.txt' }
    ($lines -join "`n") + "`n" | Set-Content -LiteralPath $OutFile -Encoding utf8NoBOM -NoNewline
    Write-Host "wrote $($lines.Count) lines to $OutFile"
} finally {
    $img.Dispose()
}
