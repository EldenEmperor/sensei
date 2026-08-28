# convert-image-banner.ps1 — downscale an image into truecolor ANSI half-block
# art for assets/banner.txt. Windows-only (System.Drawing / GDI+).
#
#   pwsh -File scripts\convert-image-banner.ps1 -Path <image> [-Width 64] [-DebugMap]
#
# Built for pixel art: each cell takes the DOMINANT color of its source block
# (no averaging → crisp edges). Near-black is transparent; fully-gray regions
# (background bands/gradients) are dropped, except where content crosses them
# in-column (a sword blade) or they show through inside the silhouette.

param(
    [Parameter(Mandatory)] [string]$Path,
    [int]$Width = 64,
    [switch]$DebugMap,
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $Path).Path)
try {
    $srcW = $img.Width; $srcH = $img.Height
    $gridH = [int][Math]::Round($srcH / $srcW * $Width)

    $cells = New-Object 'object[,]' $Width, $gridH
    $banded = New-Object 'object[,]' $Width, $gridH

    for ($ty = 0; $ty -lt $gridH; $ty++) {
        $sy0 = [int][Math]::Floor($ty * $srcH / $gridH)
        $sy1 = [Math]::Max($sy0 + 1, [int][Math]::Ceiling(($ty + 1) * $srcH / $gridH))
        for ($tx = 0; $tx -lt $Width; $tx++) {
            $sx0 = [int][Math]::Floor($tx * $srcW / $Width)
            $sx1 = [Math]::Max($sx0 + 1, [int][Math]::Ceiling(($tx + 1) * $srcW / $Width))
            $n = 0; $black = 0; $grayN = 0; $blueN = 0
            # histogram of quantized colors → dominant bucket, split by class
            $solidBuckets = @{}
            $grayBuckets = @{}
            for ($y = $sy0; $y -lt $sy1; $y += 2) {
                for ($x = $sx0; $x -lt $sx1; $x += 2) {
                    $p = $img.GetPixel([Math]::Min($x, $srcW - 1), [Math]::Min($y, $srcH - 1))
                    $n++
                    $mx = [Math]::Max($p.R, [Math]::Max($p.G, $p.B))
                    if ($mx -lt 40) { $black++; continue }
                    $isGray = ([Math]::Abs($p.R - $p.G) -lt 30 -and [Math]::Abs($p.G - $p.B) -lt 30 -and [Math]::Abs($p.R - $p.B) -lt 30)
                    if ($p.B -gt ($p.R + 25) -and $p.B -gt ($p.G + 10)) { $blueN++ }
                    $key = (($p.R -band 0xE0) -shl 16) -bor (($p.G -band 0xE0) -shl 8) -bor ($p.B -band 0xE0)
                    $target = if ($isGray) { $grayN++; $grayBuckets } else { $solidBuckets }
                    if ($target.ContainsKey($key)) {
                        $e = $target[$key]; $e[0]++; $e[1] += $p.R; $e[2] += $p.G; $e[3] += $p.B
                    } else {
                        $target[$key] = @(1, [int]$p.R, [int]$p.G, [int]$p.B)
                    }
                }
            }
            if ($n -eq 0) { continue }
            $solid = $n - $black
            if ($solid / $n -lt 0.5) { continue }   # black-dominant → transparent (hard edge)

            $dominant = {
                param($buckets)
                $best = $null
                foreach ($e in $buckets.Values) { if ($null -eq $best -or $e[0] -gt $best[0]) { $best = $e } }
                if ($best) { @([int]($best[1] / $best[0]), [int]($best[2] / $best[0]), [int]($best[3] / $best[0])) } else { $null }
            }
            # fully-gray cell with no blue = background band → remember for the restore pass
            if ($grayN / $solid -gt 0.85 -and $blueN / $solid -lt 0.12) {
                $banded[$tx, $ty] = & $dominant $grayBuckets
            } else {
                $colored = & $dominant $solidBuckets
                $cells[$tx, $ty] = if ($colored) { $colored } else { & $dominant $grayBuckets }
            }
        }
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

    # crop to the content bounding box (pad height to an even row count)
    $minX = $Width; $maxX = -1; $minY = $gridH; $maxY = -1
    for ($ty = 0; $ty -lt $gridH; $ty++) {
        for ($tx = 0; $tx -lt $Width; $tx++) {
            if ($null -ne $cells[$tx, $ty]) {
                if ($tx -lt $minX) { $minX = $tx }
                if ($tx -gt $maxX) { $maxX = $tx }
                if ($ty -lt $minY) { $minY = $ty }
                if ($ty -gt $maxY) { $maxY = $ty }
            }
        }
    }
    if ($maxX -lt 0) { throw 'image reduced to nothing — lower the thresholds' }
    if ((($maxY - $minY + 1) % 2) -ne 0) { if ($minY -gt 0) { $minY-- } else { $maxY++ } }

    if ($DebugMap) {
        for ($ty = $minY; $ty -le $maxY; $ty++) {
            $rowDbg = ''
            for ($tx = $minX; $tx -le $maxX; $tx++) {
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
    $lines = for ($ty = $minY; $ty -le $maxY; $ty += 2) {
        $line = ''
        $open = $false
        for ($tx = $minX; $tx -le $maxX; $tx++) {
            $t = $cells[$tx, $ty]
            $b = if (($ty + 1) -le $maxY) { $cells[$tx, ($ty + 1)] } else { $null }
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
    Write-Host "wrote $($lines.Count) lines x $($maxX - $minX + 1) cols to $OutFile"
} finally {
    $img.Dispose()
}
