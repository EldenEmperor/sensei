# logtools.ps1 — log_slice and log_stats, Sensei's differentiating tools.
# Both stream; neither ever loads a whole log file into memory.

$script:TsRegexes = @(
    [regex]'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?'   # ISO-8601-ish
    [regex]'\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2}'                       # US legacy
    [regex]'^[A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}'                # syslog (no year)
)

function Get-LogLineTimestamp {
    param([string]$Line)
    foreach ($rx in $script:TsRegexes) {
        $m = $rx.Match($Line)
        if (-not $m.Success) { continue }
        $raw = $m.Value -replace ',', '.'
        $dt = [datetime]::MinValue
        if ([datetime]::TryParse($raw, [cultureinfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::None, [ref]$dt)) { return $dt }
        if ([datetime]::TryParseExact($raw, 'MMM d HH:mm:ss', [cultureinfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AllowWhiteSpaces, [ref]$dt)) { return $dt }
    }
    return $null
}

function Get-LogTemplate {
    # Normalize a log line into a template so repeats group together.
    param([string]$Line)
    $t = $Line
    foreach ($rx in $script:TsRegexes) { $t = $rx.Replace($t, '<ts>') }
    $t = $t -replace '\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b', '<guid>'
    $t = $t -replace '\b0x[0-9a-fA-F]+\b', '<hex>'
    $t = $t -replace '\d+', '<n>'
    return $t.Trim()
}

# --- log_slice -------------------------------------------------------------

Register-SenseiTool -Name 'log_slice' -ReadOnly $true `
    -Description 'Efficiently read part of a (possibly huge) log file with absolute line numbers. Provide exactly one of: tail=N, head=N, from_line/to_line, or from_time/to_time. Never loads the whole file.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            path      = @{ type = 'string' }
            tail      = @{ type = 'integer'; description = 'Last N lines' }
            head      = @{ type = 'integer'; description = 'First N lines' }
            from_line = @{ type = 'integer'; description = '1-based start line' }
            to_line   = @{ type = 'integer'; description = '1-based end line (default from_line+199)' }
            from_time = @{ type = 'string'; description = "Start timestamp, e.g. '2026-08-27 02:46:00'" }
            to_time   = @{ type = 'string'; description = "End timestamp, e.g. '2026-08-27 02:48:00'" }
        }
        required   = @('path')
    } -Handler {
        param($a)
        $path = Resolve-SenseiPath $a.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "ERROR: file not found: $path" }
        $maxLines = 2000
        $sb = [System.Text.StringBuilder]::new()

        if ($a.tail) {
            $n = [Math]::Min($maxLines, [Math]::Max(1, [int]$a.tail))
            $total = 0
            $reader = [System.IO.StreamReader]::new($path)
            try { while ($null -ne $reader.ReadLine()) { $total++ } } finally { $reader.Dispose() }
            $lines = @(Get-Content -LiteralPath $path -Tail $n)
            [void]$sb.AppendLine("[$path — last $($lines.Count) of $total lines]")
            $i = $total - $lines.Count + 1
            foreach ($l in $lines) { [void]$sb.AppendLine(('{0,8}→{1}' -f $i, $l)); $i++ }
            return $sb.ToString()
        }

        if ($a.head) {
            $n = [Math]::Min($maxLines, [Math]::Max(1, [int]$a.head))
            [void]$sb.AppendLine("[$path — first $n lines]")
            $i = 0
            $reader = [System.IO.StreamReader]::new($path)
            try {
                while ($null -ne ($line = $reader.ReadLine())) {
                    $i++
                    [void]$sb.AppendLine(('{0,8}→{1}' -f $i, $line))
                    if ($i -ge $n) { break }
                }
            } finally {
                $reader.Dispose()
            }
            return $sb.ToString()
        }

        if ($a.from_line -or $a.to_line) {
            $from = [Math]::Max(1, [int]($a.from_line ?? 1))
            $to = if ($a.to_line) { [int]$a.to_line } else { $from + 199 }
            if ($to -lt $from) { return 'ERROR: to_line is before from_line' }
            if ($to - $from + 1 -gt $maxLines) {
                $to = $from + $maxLines - 1
                [void]$sb.AppendLine("[range capped at $maxLines lines]")
            }
            [void]$sb.AppendLine("[$path — lines $from..$to]")
            $i = 0
            $reader = [System.IO.StreamReader]::new($path)
            try {
                while ($null -ne ($line = $reader.ReadLine())) {
                    $i++
                    if ($i -lt $from) { continue }
                    if ($i -gt $to) { break }
                    [void]$sb.AppendLine(('{0,8}→{1}' -f $i, $line))
                }
            } finally {
                $reader.Dispose()
            }
            if ($i -lt $from) { return "ERROR: from_line $from is past the end of the file ($i lines)" }
            return $sb.ToString()
        }

        if ($a.from_time -or $a.to_time) {
            $fromT = [datetime]::MinValue
            $toT = [datetime]::MaxValue
            try {
                if ($a.from_time) { $fromT = [datetime]::Parse([string]$a.from_time, [cultureinfo]::InvariantCulture) }
                if ($a.to_time)   { $toT   = [datetime]::Parse([string]$a.to_time, [cultureinfo]::InvariantCulture) }
            } catch {
                return "ERROR: could not parse from_time/to_time: $($_.Exception.Message)"
            }
            [void]$sb.AppendLine("[$path — $($a.from_time ?? 'start') → $($a.to_time ?? 'end')]")
            $i = 0
            $emitted = 0
            $current = $null   # last seen timestamp; untimestamped lines belong to it
            $reader = [System.IO.StreamReader]::new($path)
            try {
                while ($null -ne ($line = $reader.ReadLine())) {
                    $i++
                    $ts = Get-LogLineTimestamp $line
                    if ($ts) {
                        if ($ts -gt $toT) { break }   # logs are time-ordered: done
                        $current = $ts
                    }
                    if ($null -eq $current -or $current -lt $fromT) { continue }
                    [void]$sb.AppendLine(('{0,8}→{1}' -f $i, $line))
                    $emitted++
                    if ($emitted -ge $maxLines) {
                        [void]$sb.AppendLine("[capped at $maxLines lines — narrow the time range]")
                        break
                    }
                }
            } finally {
                $reader.Dispose()
            }
            if ($emitted -eq 0) { [void]$sb.AppendLine('(no lines in that time range)') }
            return $sb.ToString()
        }

        return 'ERROR: specify exactly one of tail, head, from_line/to_line, or from_time/to_time'
    }

# --- log_stats -------------------------------------------------------------

Register-SenseiTool -Name 'log_stats' -ReadOnly $true `
    -Description 'Cheap single-pass analysis of a log file: line/byte totals, log-level counts, time range, error frequency over time buckets, and the most common ERROR/WARN/FATAL message templates. ALWAYS call this before reading a log file.' `
    -Parameters @{
        type       = 'object'
        properties = @{ path = @{ type = 'string' } }
        required   = @('path')
    } -Handler {
        param($a)
        $path = Resolve-SenseiPath $a.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "ERROR: file not found: $path" }
        $levelRx = [regex]'(?i)\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b'
        $levels = [ordered]@{ FATAL = 0; ERROR = 0; WARN = 0; INFO = 0; DEBUG = 0; TRACE = 0 }
        $templates = [System.Collections.Generic.Dictionary[string, int]]::new()
        $errTimes = [System.Collections.Generic.List[datetime]]::new()
        $total = 0
        $noLevel = 0
        $firstTs = $null
        $lastTs = $null

        $reader = [System.IO.StreamReader]::new($path)
        try {
            while ($null -ne ($line = $reader.ReadLine())) {
                $total++
                $ts = Get-LogLineTimestamp $line
                if ($ts) {
                    if ($null -eq $firstTs) { $firstTs = $ts }
                    $lastTs = $ts
                }
                $m = $levelRx.Match($line)
                if (-not $m.Success) { $noLevel++; continue }
                $level = $m.Groups[1].Value.ToUpper()
                if ($level -eq 'WARNING') { $level = 'WARN' }
                $levels[$level]++
                if ($level -in 'ERROR', 'FATAL', 'WARN') {
                    $key = "[$level] " + (Get-LogTemplate $line)
                    if ($templates.ContainsKey($key)) { $templates[$key]++ } else { $templates[$key] = 1 }
                    if ($level -ne 'WARN' -and $ts) { $errTimes.Add($ts) }
                }
            }
        } finally {
            $reader.Dispose()
        }

        $sb = [System.Text.StringBuilder]::new()
        $bytes = (Get-Item -LiteralPath $path).Length
        [void]$sb.AppendLine("[log_stats — $path]")
        [void]$sb.AppendLine(("lines: {0:n0}   size: {1:n1} MB   lines without a recognized level: {2:n0}" -f $total, ($bytes / 1MB), $noLevel))
        if ($firstTs) {
            $span = $lastTs - $firstTs
            [void]$sb.AppendLine(("time range: {0:yyyy-MM-dd HH:mm:ss} → {1:yyyy-MM-dd HH:mm:ss}  ({2}h {3}m)" -f $firstTs, $lastTs, [int][Math]::Floor($span.TotalHours), $span.Minutes))
        } else {
            [void]$sb.AppendLine('time range: no recognizable timestamps found')
        }
        [void]$sb.AppendLine('levels: ' + (($levels.GetEnumerator() | Where-Object Value -gt 0 | ForEach-Object { "$($_.Key): $($_.Value)" }) -join ' | '))

        if ($errTimes.Count -gt 0 -and $firstTs) {
            $spanMin = ($lastTs - $firstTs).TotalMinutes
            $bucketMin = if ($spanMin -le 90) { 1 } elseif ($spanMin -le 1440) { 10 } else { 60 }
            $buckets = [System.Collections.Generic.SortedDictionary[datetime, int]]::new()
            foreach ($t in $errTimes) {
                $b = [datetime]::new($t.Year, $t.Month, $t.Day, $t.Hour, [int][Math]::Floor($t.Minute / $bucketMin) * $bucketMin, 0)
                if ($bucketMin -eq 60) { $b = [datetime]::new($t.Year, $t.Month, $t.Day, $t.Hour, 0, 0) }
                if ($buckets.ContainsKey($b)) { $buckets[$b]++ } else { $buckets[$b] = 1 }
            }
            $maxCount = ($buckets.Values | Measure-Object -Maximum).Maximum
            [void]$sb.AppendLine("error/fatal frequency (${bucketMin}m buckets):")
            foreach ($e in $buckets.GetEnumerator()) {
                $bar = '#' * [Math]::Max(1, [int](30 * $e.Value / $maxCount))
                [void]$sb.AppendLine(("  {0:MM-dd HH:mm}  {1,6}  {2}" -f $e.Key, $e.Value, $bar))
            }
        }

        if ($templates.Count -gt 0) {
            [void]$sb.AppendLine('top error/warn templates:')
            $top = $templates.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15
            foreach ($e in $top) {
                $tmpl = if ($e.Key.Length -gt 160) { $e.Key.Substring(0, 157) + '…' } else { $e.Key }
                [void]$sb.AppendLine(("  {0,7} × {1}" -f $e.Value, $tmpl))
            }
        }
        return $sb.ToString()
    }

# --- shared: streaming block cursor for timeline merge ---------------------

function New-LogCursor {
    param([string]$Path)
    $sr = [System.IO.StreamReader]::new($Path)
    return @{ Reader = $sr; Pending = $sr.ReadLine(); Name = (Split-Path -Leaf $Path); LastTs = $null; Block = $null; EOF = $false }
}

function Read-LogBlock {
    # One block = a line plus any following continuation (untimestamped) lines,
    # tagged with the most recent timestamp. Returns $null at EOF.
    param($C)
    if ($null -eq $C.Pending) { $C.EOF = $true; return $null }
    $first = $C.Pending
    $ts = Get-LogLineTimestamp $first
    if ($ts) { $C.LastTs = $ts }
    $block = [System.Text.StringBuilder]::new()
    [void]$block.Append($first)
    while ($true) {
        $next = $C.Reader.ReadLine()
        if ($null -eq $next) { $C.Pending = $null; break }
        if (Get-LogLineTimestamp $next) { $C.Pending = $next; break }
        [void]$block.Append("`n"); [void]$block.Append($next)
    }
    return @{ Ts = $C.LastTs; Text = $block.ToString() }
}

function Close-LogCursors { param($Cursors) foreach ($c in $Cursors) { try { $c.Reader.Dispose() } catch { } } }

# --- log_timeline ----------------------------------------------------------

Register-SenseiTool -Name 'log_timeline' -ReadOnly $true `
    -Description 'Merge 2+ log files into one timestamp-ordered view, each line tagged with its source file. Optionally bound to from_time/to_time. The tool for "what did every service say around the moment of the crash?"' `
    -Parameters @{
        type       = 'object'
        properties = @{
            paths     = @{ type = 'array'; items = @{ type = 'string' }; description = 'Two or more log file paths' }
            from_time = @{ type = 'string'; description = "e.g. '2026-08-27 02:46:00'" }
            to_time   = @{ type = 'string' }
        }
        required   = @('paths')
    } -Handler {
        param($a)
        $paths = @($a.paths | ForEach-Object { Resolve-SenseiPath $_ })
        $missing = @($paths | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
        if ($missing.Count -gt 0) { return "ERROR: file(s) not found: $($missing -join ', ')" }
        if ($paths.Count -lt 2) { return 'ERROR: log_timeline needs at least 2 paths' }
        $fromT = [datetime]::MinValue; $toT = [datetime]::MaxValue
        try {
            if ($a.from_time) { $fromT = [datetime]::Parse([string]$a.from_time, [cultureinfo]::InvariantCulture) }
            if ($a.to_time)   { $toT   = [datetime]::Parse([string]$a.to_time, [cultureinfo]::InvariantCulture) }
        } catch { return "ERROR: could not parse from_time/to_time: $($_.Exception.Message)" }
        $maxLines = 2000
        $cursors = @($paths | ForEach-Object { New-LogCursor $_ })
        $sb = [System.Text.StringBuilder]::new()
        [void]$sb.AppendLine("[log_timeline — $($paths.Count) files, $($a.from_time ?? 'start') → $($a.to_time ?? 'end')]")
        $emitted = 0
        try {
            foreach ($c in $cursors) { $c.Block = Read-LogBlock $c }
            while ($emitted -lt $maxLines) {
                $live = @($cursors | Where-Object { $null -ne $_.Block })
                if ($live.Count -eq 0) { break }
                $pick = $live | Sort-Object @{ Expression = { if ($_.Block.Ts) { $_.Block.Ts } else { [datetime]::MinValue } } } | Select-Object -First 1
                $blk = $pick.Block
                $pick.Block = Read-LogBlock $pick
                if ($blk.Ts -ne [datetime]::MinValue -and $blk.Ts -gt $toT) { continue }
                if ($blk.Ts -ne [datetime]::MinValue -and $blk.Ts -lt $fromT) { continue }
                foreach ($ln in ($blk.Text -split "`n")) {
                    [void]$sb.AppendLine("[$($pick.Name)] $ln")
                    $emitted++
                }
            }
            if ($emitted -ge $maxLines) { [void]$sb.AppendLine("[capped at $maxLines lines — narrow the time window]") }
        } finally { Close-LogCursors $cursors }
        return $sb.ToString()
    }

# --- log_trace -------------------------------------------------------------

Register-SenseiTool -Name 'log_trace' -ReadOnly $true `
    -Description 'Follow a correlation/request/trace id across one or more log files: every matching line, in timestamp order, tagged with source:line.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            id    = @{ type = 'string'; description = 'The id/token to trace (literal, case-insensitive)' }
            paths = @{ type = 'array'; items = @{ type = 'string' }; description = 'Files to scan (default: cwd *.log)' }
        }
        required   = @('id')
    } -Handler {
        param($a)
        $id = [string]$a.id
        if (-not $id) { return 'ERROR: id is required' }
        $paths = if ($a.paths) { @($a.paths | ForEach-Object { Resolve-SenseiPath $_ }) }
                 else { @(Get-ChildItem -LiteralPath (Get-Location).Path -Filter '*.log' -File | ForEach-Object FullName) }
        if ($paths.Count -eq 0) { return 'ERROR: no files to scan (pass paths, or run where *.log files exist)' }
        $hits = [System.Collections.Generic.List[object]]::new()
        $cap = 1000
        foreach ($p in $paths) {
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
            $name = Split-Path -Leaf $p
            $reader = [System.IO.StreamReader]::new($p)
            try {
                $n = 0; $lastTs = $null
                while ($null -ne ($line = $reader.ReadLine())) {
                    $n++
                    $ts = Get-LogLineTimestamp $line
                    if ($ts) { $lastTs = $ts }
                    if ($line.IndexOf($id, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                        $hits.Add(@{ Ts = $lastTs; Name = $name; LineNo = $n; Line = $line })
                        if ($hits.Count -ge $cap) { break }
                    }
                }
            } finally { $reader.Dispose() }
            if ($hits.Count -ge $cap) { break }
        }
        if ($hits.Count -eq 0) { return "no lines mention '$id' in $($paths.Count) file(s)" }
        $sorted = $hits | Sort-Object @{ Expression = { if ($_.Ts) { $_.Ts } else { [datetime]::MaxValue } } }
        $sb = [System.Text.StringBuilder]::new()
        [void]$sb.AppendLine("[log_trace '$id' — $($hits.Count) line(s) across $($paths.Count) file(s)]")
        foreach ($h in $sorted) { [void]$sb.AppendLine("$($h.Name):$($h.LineNo): $($h.Line)") }
        if ($hits.Count -ge $cap) { [void]$sb.AppendLine("[capped at $cap matches]") }
        return $sb.ToString()
    }

# --- log_baseline ----------------------------------------------------------

function Get-LogBaselineData {
    param([string]$Path)
    $levelRx = [regex]'(?i)\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b'
    $levels = [ordered]@{ FATAL = 0; ERROR = 0; WARN = 0; INFO = 0; DEBUG = 0; TRACE = 0 }
    $templates = @{}
    $total = 0; $firstTs = $null; $lastTs = $null
    $reader = [System.IO.StreamReader]::new($Path)
    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            $total++
            $ts = Get-LogLineTimestamp $line
            if ($ts) { if ($null -eq $firstTs) { $firstTs = $ts }; $lastTs = $ts }
            $m = $levelRx.Match($line)
            if (-not $m.Success) { continue }
            $level = $m.Groups[1].Value.ToUpper(); if ($level -eq 'WARNING') { $level = 'WARN' }
            $levels[$level]++
            if ($level -in 'ERROR', 'FATAL', 'WARN') {
                $key = "[$level] " + (Get-LogTemplate $line)
                if ($templates.ContainsKey($key)) { $templates[$key]++ } else { $templates[$key] = 1 }
            }
        }
    } finally { $reader.Dispose() }
    return @{
        total = $total; levels = $levels; templates = $templates
        first = $(if ($firstTs) { $firstTs.ToString('o') } else { $null })
        last  = $(if ($lastTs) { $lastTs.ToString('o') } else { $null })
    }
}

Register-SenseiTool -Name 'log_baseline' -ReadOnly $true `
    -Description "Capture a log's profile as a named baseline (action=save), or compare a log against a saved baseline (action=diff) to surface NEW error templates and count spikes. Answers 'what changed since the last good run?'" `
    -Parameters @{
        type       = 'object'
        properties = @{
            action = @{ type = 'string'; enum = @('save', 'diff', 'list') }
            path   = @{ type = 'string' }
            name   = @{ type = 'string'; description = 'Baseline name (default: log file name)' }
        }
        required   = @('action')
    } -Handler {
        param($a)
        $dir = Join-Path $script:ConfigDir 'baselines'
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $action = [string]$a.action
        if ($action -eq 'list') {
            $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -ErrorAction SilentlyContinue)
            if ($files.Count -eq 0) { return 'no baselines saved' }
            return "baselines: " + (($files | ForEach-Object { $_.BaseName }) -join ', ')
        }
        $path = Resolve-SenseiPath ([string]$a.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "ERROR: file not found: $path" }
        $name = if ($a.name) { [string]$a.name } else { (Split-Path -Leaf $path) -replace '[^\w.-]', '_' }
        $bpath = Join-Path $dir "$name.json"
        $data = Get-LogBaselineData $path
        if ($action -eq 'save') {
            ConvertTo-Json -InputObject $data -Depth 8 | Set-Content -LiteralPath $bpath -Encoding utf8NoBOM
            return "saved baseline '$name' ($($data.total) lines, $(@($data.templates.Keys).Count) error/warn templates)"
        }
        if ($action -eq 'diff') {
            if (-not (Test-Path -LiteralPath $bpath -PathType Leaf)) { return "ERROR: no baseline named '$name' (save one first)" }
            $base = Get-Content -LiteralPath $bpath -Raw | ConvertFrom-Json -AsHashtable
            $sb = [System.Text.StringBuilder]::new()
            [void]$sb.AppendLine("[log_baseline diff — $path vs baseline '$name']")
            [void]$sb.AppendLine("lines: $($base.total) → $($data.total)")
            $newT = @($data.templates.Keys | Where-Object { -not $base.templates.ContainsKey($_) })
            $goneT = @($base.templates.Keys | Where-Object { -not $data.templates.ContainsKey($_) })
            $spikes = foreach ($k in $data.templates.Keys) {
                if ($base.templates.ContainsKey($k)) {
                    $b = [int]$base.templates[$k]; $c = [int]$data.templates[$k]
                    if ($b -gt 0 -and $c -ge 3 * $b -and ($c - $b) -ge 5) { "  {0}× (was {1}, now {2}) {3}" -f [Math]::Round($c / $b, 1), $b, $c, $k }
                }
            }
            if ($newT.Count -gt 0) {
                [void]$sb.AppendLine("NEW error/warn templates ($($newT.Count)):")
                foreach ($t in ($newT | Select-Object -First 20)) { [void]$sb.AppendLine("  + [$($data.templates[$t])×] $t") }
            }
            if (@($spikes).Count -gt 0) {
                [void]$sb.AppendLine('COUNT SPIKES:')
                foreach ($s in ($spikes | Select-Object -First 20)) { [void]$sb.AppendLine($s) }
            }
            if ($goneT.Count -gt 0) { [void]$sb.AppendLine("templates that disappeared: $($goneT.Count)") }
            if ($newT.Count -eq 0 -and @($spikes).Count -eq 0) { [void]$sb.AppendLine('no new templates or count spikes — profile looks consistent with the baseline') }
            return $sb.ToString()
        }
        return "ERROR: unknown action '$action' (save|diff|list)"
    }

# --- log_search (semantic; local Ollama embeddings) ------------------------

function Get-SenseiEmbeddings {
    # Returns an array of float[] vectors for the given input strings, via the
    # OpenAI-compatible /embeddings endpoint (Ollama). Local mode only.
    param([string[]]$Inputs)
    $url = ([string]$script:Config.local_base_url).TrimEnd('/') + '/embeddings'
    $body = ConvertTo-Json -InputObject @{ model = [string]$script:Config.embed_model; input = @($Inputs) } -Depth 6
    $r = Invoke-OpenAIRequest -Method 'POST' -Url $url -JsonBody $body -ApiKey 'ollama' -NoSpinner
    if ($r.Status -ne 200) { throw "embeddings endpoint returned $($r.Status): $($r.Body)" }
    $parsed = $r.Body | ConvertFrom-Json -AsHashtable
    return @($parsed.data | ForEach-Object { ,@($_.embedding) })
}

function Get-SenseiCosine {
    param($A, $B)
    $dot = 0.0; $na = 0.0; $nb = 0.0
    for ($i = 0; $i -lt $A.Count; $i++) {
        $dot += $A[$i] * $B[$i]; $na += $A[$i] * $A[$i]; $nb += $B[$i] * $B[$i]
    }
    if ($na -eq 0 -or $nb -eq 0) { return 0.0 }
    return $dot / ([Math]::Sqrt($na) * [Math]::Sqrt($nb))
}

Register-SenseiTool -Name 'log_search' -ReadOnly $true `
    -Description 'Semantic search over a log by MEANING (not regex): ranks the log''s distinct error/warn templates by similarity to a natural-language query, e.g. "memory pressure" or "auth failures". Local mode only (uses your Ollama embedding model).' `
    -Parameters @{
        type       = 'object'
        properties = @{
            path  = @{ type = 'string' }
            query = @{ type = 'string'; description = 'What to look for, in plain language' }
            top   = @{ type = 'integer'; description = 'How many matches to return (default 10)' }
        }
        required   = @('path', 'query')
    } -Handler {
        param($a)
        if (-not $script:LocalMode) { return 'ERROR: log_search needs local embeddings — start sensei with --local (Ollama + an embedding model).' }
        $path = Resolve-SenseiPath ([string]$a.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "ERROR: file not found: $path" }
        $top = [Math]::Max(1, [int]($a.top ?? 10))
        # distinct error/warn templates with counts (one streaming pass)
        $data = Get-LogBaselineData $path
        $templates = @($data.templates.Keys)
        if ($templates.Count -eq 0) { return 'no error/warn templates to search in this log' }
        $templates = @($templates | Sort-Object { $data.templates[$_] } -Descending | Select-Object -First 200)

        $cacheDir = Join-Path $script:ConfigDir 'embed-cache'
        if (-not (Test-Path -LiteralPath $cacheDir)) { New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null }
        $fi = Get-Item -LiteralPath $path
        $fp = "$($fi.Length)-$($fi.LastWriteTimeUtc.Ticks)-$($script:Config.embed_model)"
        $hash = [BitConverter]::ToString([System.Security.Cryptography.SHA1]::HashData([System.Text.Encoding]::UTF8.GetBytes("$path|$fp"))).Replace('-', '').Substring(0, 16)
        $cacheFile = Join-Path $cacheDir "$hash.json"

        $vectors = $null
        if (Test-Path -LiteralPath $cacheFile) {
            try {
                $cached = Get-Content -LiteralPath $cacheFile -Raw | ConvertFrom-Json -AsHashtable
                if ($cached.templates.Count -eq $templates.Count) { $vectors = $cached.vectors }
            } catch { $vectors = $null }
        }
        try {
            if (-not $vectors) {
                $vectors = Get-SenseiEmbeddings -Inputs $templates
                ConvertTo-Json -InputObject @{ templates = $templates; vectors = $vectors } -Depth 6 |
                    Set-Content -LiteralPath $cacheFile -Encoding utf8NoBOM
            }
            $qVec = (Get-SenseiEmbeddings -Inputs @([string]$a.query))[0]
        } catch {
            return "ERROR: $($_.Exception.Message)`nIs Ollama running with '$($script:Config.embed_model)' pulled? (ollama pull $($script:Config.embed_model))"
        }
        $ranked = for ($i = 0; $i -lt $templates.Count; $i++) {
            @{ Template = $templates[$i]; Score = (Get-SenseiCosine $qVec $vectors[$i]); Count = $data.templates[$templates[$i]] }
        }
        $sb = [System.Text.StringBuilder]::new()
        [void]$sb.AppendLine("[log_search '$($a.query)' — top $top of $($templates.Count) templates]")
        foreach ($r in ($ranked | Sort-Object { $_.Score } -Descending | Select-Object -First $top)) {
            [void]$sb.AppendLine(("  {0:n3}  [{1}×] {2}" -f $r.Score, $r.Count, $r.Template))
        }
        return $sb.ToString()
    }
