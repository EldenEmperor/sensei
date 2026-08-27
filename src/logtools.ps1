# logtools.ps1 — log_slice and log_stats, Kakuna's differentiating tools.
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

Register-KakunaTool -Name 'log_slice' -ReadOnly $true `
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
        $path = Resolve-KakunaPath $a.path
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

Register-KakunaTool -Name 'log_stats' -ReadOnly $true `
    -Description 'Cheap single-pass analysis of a log file: line/byte totals, log-level counts, time range, error frequency over time buckets, and the most common ERROR/WARN/FATAL message templates. ALWAYS call this before reading a log file.' `
    -Parameters @{
        type       = 'object'
        properties = @{ path = @{ type = 'string' } }
        required   = @('path')
    } -Handler {
        param($a)
        $path = Resolve-KakunaPath $a.path
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
