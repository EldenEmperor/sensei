# convert-image-banner.ps1 — convert an image (or animated GIF) into truecolor
# ANSI half-block art for assets/banner.txt. Windows-only (System.Drawing).
#
#   pwsh -File scripts\convert-image-banner.ps1 -Path <image> [-Width 64] [-DebugMap]
#
# Built for pixel art: each cell takes the DOMINANT color of its source block
# (no averaging → crisp edges). Near-black is transparent; fully-gray regions
# (background bands/gradients) are dropped, except where content crosses them
# in-column (a sword blade) or they show through inside the silhouette.
#
# Animated GIFs emit every frame:
#   %%SENSEI-BANNER-ANIM v1
#   %%FRAME <delayMs>
#   <ansi lines…>
# Single-frame images emit plain lines (backward compatible).

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

    $fd = if ($img.FrameDimensionsList.Count -gt 0) { [System.Drawing.Imaging.FrameDimension]::new($img.FrameDimensionsList[0]) } else { $null }
    $frameCount = if ($fd) { $img.GetFrameCount($fd) } else { 1 }
    $delaysMs = @(1..$frameCount | ForEach-Object { 100 })
    try {
        $dprop = $img.GetPropertyItem(0x5100).Value
        $delaysMs = for ($i = 0; $i -lt $frameCount; $i++) {
            $d = [BitConverter]::ToInt32($dprop, ($i * 4) % $dprop.Length) * 10
            if ($d -lt 20) { 100 } else { $d }
        }
    } catch { }

    $frameCells = [System.Collections.Generic.List[object]]::new()
    $minX = $Width; $maxX = -1; $minY = $gridH; $maxY = -1

    for ($f = 0; $f -lt $frameCount; $f++) {
        if ($fd) { [void]$img.SelectActiveFrame($fd, $f) }
        # fast pixel access: copy the frame once
        $rect = [System.Drawing.Rectangle]::new(0, 0, $srcW, $srcH)
        $data = $img.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $stride = $data.Stride
        $bytes = [byte[]]::new($stride * $srcH)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        $img.UnlockBits($data)

        $cells = New-Object 'object[,]' $Width, $gridH
        $banded = New-Object 'object[,]' $Width, $gridH

        for ($ty = 0; $ty -lt $gridH; $ty++) {
            $sy0 = [int][Math]::Floor($ty * $srcH / $gridH)
            $sy1 = [Math]::Max($sy0 + 1, [int][Math]::Ceiling(($ty + 1) * $srcH / $gridH))
            for ($tx = 0; $tx -lt $Width; $tx++) {
                $sx0 = [int][Math]::Floor($tx * $srcW / $Width)
                $sx1 = [Math]::Max($sx0 + 1, [int][Math]::Ceiling(($tx + 1) * $srcW / $Width))
                $n = 0; $black = 0; $grayN = 0; $blueN = 0
                $solidBuckets = @{}
                $grayBuckets = @{}
                for ($y = $sy0; $y -lt $sy1; $y += 2) {
                    $rowOff = $y * $stride
                    for ($x = $sx0; $x -lt $sx1; $x += 2) {
                        $o = $rowOff + $x * 4
                        $b = $bytes[$o]; $g = $bytes[$o + 1]; $r = $bytes[$o + 2]
                        $n++
                        $mx = [Math]::Max($r, [Math]::Max($g, $b))
                        if ($mx -lt 40) { $black++; continue }
                        $isGray = ([Math]::Abs($r - $g) -lt 30 -and [Math]::Abs($g - $b) -lt 30 -and [Math]::Abs($r - $b) -lt 30)
                        if ($b -gt ($r + 25) -and $b -gt ($g + 10)) { $blueN++ }
                        $key = (($r -band 0xE0) -shl 16) -bor (($g -band 0xE0) -shl 8) -bor ($b -band 0xE0)
                        $target = if ($isGray) { $grayN++; $grayBuckets } else { $solidBuckets }
                        if ($target.ContainsKey($key)) {
                            $e = $target[$key]; $e[0]++; $e[1] += $r; $e[2] += $g; $e[3] += $b
                        } else {
                            $target[$key] = @(1, [int]$r, [int]$g, [int]$b)
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
                if ($grayN / $solid -gt 0.85 -and $blueN / $solid -lt 0.12) {
                    $banded[$tx, $ty] = & $dominant $grayBuckets
                } else {
                    $colored = & $dominant $solidBuckets
                    $cells[$tx, $ty] = if ($colored) { $colored } else { & $dominant $grayBuckets }
                }
            }
        }

        # restore band cells strictly BETWEEN a column's surviving content
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

        # grow the union bounding box so every frame aligns
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
        $frameCells.Add($cells)
    }

    if ($maxX -lt 0) { throw 'image reduced to nothing — lower the thresholds' }
    if ((($maxY - $minY + 1) % 2) -ne 0) { if ($minY -gt 0) { $minY-- } else { $maxY++ } }

    if ($DebugMap) {
        $cells = $frameCells[0]
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
    $renderFrame = {
        param($cells)
        for ($ty = $minY; $ty -le $maxY; $ty += 2) {
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
    }

    if (-not $OutFile) { $OutFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\banner.txt' }
    if ($frameCount -gt 1) {
        $out = [System.Collections.Generic.List[string]]::new()
        $out.Add('%%SENSEI-BANNER-ANIM v1')
        for ($f = 0; $f -lt $frameCount; $f++) {
            $out.Add("%%FRAME $($delaysMs[$f])")
            foreach ($l in (& $renderFrame $frameCells[$f])) { $out.Add($l) }
        }
        ($out -join "`n") + "`n" | Set-Content -LiteralPath $OutFile -Encoding utf8NoBOM -NoNewline
        Write-Host "wrote $frameCount frames x $([int](($maxY - $minY + 1) / 2)) lines x $($maxX - $minX + 1) cols to $OutFile"
    } else {
        $lines = & $renderFrame $frameCells[0]
        ($lines -join "`n") + "`n" | Set-Content -LiteralPath $OutFile -Encoding utf8NoBOM -NoNewline
        Write-Host "wrote $($lines.Count) lines x $($maxX - $minX + 1) cols to $OutFile"
    }
} finally {
    $img.Dispose()
}
