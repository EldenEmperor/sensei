# logtools.ps1 — Sensei's differentiating log tools.
# Everything streams; nothing ever loads a whole log file into memory.

$script:FormatMapSchemaVersion = 1   # part of the format-map cache key; bump when detector logic changes

# One shared level regex; log_investigate's format map can extend it per file via hints.
$script:DefaultLevelRx = [regex]'(?i)\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b'

function Get-LogLevelRegex {
    param($Hints = $null)
    if ($Hints -and $Hints.LevelRx) { return $Hints.LevelRx }
    return $script:DefaultLevelRx
}

# Named timestamp candidates. iso8601/us-legacy/syslog are the always-on defaults;
# the rest only activate through a format map's hints — epoch patterns especially
# are too false-positive-prone to run against every file.
$script:TsCandidates = @(
    @{ Name = 'iso8601-tz'; Regex = [regex]'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})'; Parse = 'tryparse' }
    @{ Name = 'iso8601';    Regex = [regex]'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?'; Parse = 'tryparse' }
    @{ Name = 'us-legacy';  Regex = [regex]'\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2}'; Parse = 'tryparse' }
    @{ Name = 'syslog';     Regex = [regex]'^[A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}'; Parse = 'MMM d HH:mm:ss' }
    @{ Name = 'clf';        Regex = [regex]'\d{2}/[A-Z][a-z]{2}/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}'; Parse = 'dd/MMM/yyyy:HH:mm:ss zzz' }
    @{ Name = 'epoch-ms';   Regex = [regex]'(?<![\d.])1[6-9]\d{11}(?![\d.])'; Parse = 'epoch-ms' }   # 2020–2033 digit guard
    @{ Name = 'epoch-s';    Regex = [regex]'(?<![\d.])1[6-9]\d{8}(?![\d.])';  Parse = 'epoch-s' }
)

# The always-on default set, in the original priority order.
$script:TsRegexes = @($script:TsCandidates | Where-Object { $_.Name -in 'iso8601', 'us-legacy', 'syslog' } | ForEach-Object Regex)

function Convert-LogTimestampValue {
    # Parse a raw timestamp match according to a candidate's Parse spec.
    param([string]$Raw, [string]$Parse)
    $raw = $Raw -replace ',', '.'
    $dt = [datetime]::MinValue
    switch ($Parse) {
        'epoch-s'  { try { return [DateTimeOffset]::FromUnixTimeSeconds([long]$raw).LocalDateTime } catch { return $null } }
        'epoch-ms' { try { return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$raw).LocalDateTime } catch { return $null } }
        'tryparse' {
            if ([datetime]::TryParse($raw, [cultureinfo]::InvariantCulture,
                    [System.Globalization.DateTimeStyles]::None, [ref]$dt)) { return $dt }
            return $null
        }
        default {
            if ([datetime]::TryParseExact($raw, $Parse, [cultureinfo]::InvariantCulture,
                    [System.Globalization.DateTimeStyles]::AllowWhiteSpaces, [ref]$dt)) { return $dt }
            return $null
        }
    }
}

function Get-LogLineTimestamp {
    param([string]$Line, $Hints = $null)
    if ($Hints) {
        # learned styles from the file's format map take priority
        if ($Hints.JsonTsRx) {
            $m = $Hints.JsonTsRx.Match($Line)
            if ($m.Success) {
                $dt = Convert-LogTimestampValue $m.Groups[1].Value $Hints.JsonTsParse
                if ($dt) { return $dt }
            }
        }
        if ($Hints.TsMatchers) {
            foreach ($tm in $Hints.TsMatchers) {
                $m = $tm.Regex.Match($Line)
                if (-not $m.Success) { continue }
                $dt = Convert-LogTimestampValue $m.Value $tm.Parse
                if ($dt) { return $dt }
            }
        }
    }
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
    $t = $t -replace '\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b', '<ip>'
    $t = $t -replace '"[^"]{1,200}"', '<q>'
    $t = $t -replace '(\b\w+)=([^\s,;\]]+)', '$1=<v>'
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
            $hints = Get-LogFormatHints $path
            $reader = [System.IO.StreamReader]::new($path)
            try {
                while ($null -ne ($line = $reader.ReadLine())) {
                    $i++
                    $ts = Get-LogLineTimestamp $line $hints
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
        $hints = Get-LogFormatHints $path
        $levelRx = Get-LogLevelRegex $hints
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
                $ts = Get-LogLineTimestamp $line $hints
                if ($ts) {
                    if ($null -eq $firstTs) { $firstTs = $ts }
                    $lastTs = $ts
                }
                $m = $levelRx.Match($line)
                if (-not $m.Success) { $noLevel++; continue }
                $level = $m.Groups[1].Value.ToUpper()
                if ($hints -and $hints.LevelFold -and $hints.LevelFold.ContainsKey($level)) { $level = $hints.LevelFold[$level] }
                elseif ($level -eq 'WARNING') { $level = 'WARN' }
                if (-not $levels.Contains($level)) { $levels[$level] = 0 }
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
    return @{ Reader = $sr; Pending = $sr.ReadLine(); Name = (Split-Path -Leaf $Path); LastTs = $null; Block = $null; EOF = $false; Hints = (Get-LogFormatHints $Path) }
}

function Read-LogBlock {
    # One block = a line plus any following continuation (untimestamped) lines,
    # tagged with the most recent timestamp. Returns $null at EOF.
    param($C)
    if ($null -eq $C.Pending) { $C.EOF = $true; return $null }
    $first = $C.Pending
    $ts = Get-LogLineTimestamp $first $C.Hints
    if ($ts) { $C.LastTs = $ts }
    $block = [System.Text.StringBuilder]::new()
    [void]$block.Append($first)
    while ($true) {
        $next = $C.Reader.ReadLine()
        if ($null -eq $next) { $C.Pending = $null; break }
        if (Get-LogLineTimestamp $next $C.Hints) { $C.Pending = $next; break }
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
            $pHints = Get-LogFormatHints $p
            $reader = [System.IO.StreamReader]::new($p)
            try {
                $n = 0; $lastTs = $null
                while ($null -ne ($line = $reader.ReadLine())) {
                    $n++
                    $ts = Get-LogLineTimestamp $line $pHints
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
    $hints = Get-LogFormatHints $Path
    $levelRx = Get-LogLevelRegex $hints
    $levels = [ordered]@{ FATAL = 0; ERROR = 0; WARN = 0; INFO = 0; DEBUG = 0; TRACE = 0 }
    $templates = @{}
    $total = 0; $firstTs = $null; $lastTs = $null
    $reader = [System.IO.StreamReader]::new($Path)
    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            $total++
            $ts = Get-LogLineTimestamp $line $hints
            if ($ts) { if ($null -eq $firstTs) { $firstTs = $ts }; $lastTs = $ts }
            $m = $levelRx.Match($line)
            if (-not $m.Success) { continue }
            $level = $m.Groups[1].Value.ToUpper()
            if ($hints -and $hints.LevelFold -and $hints.LevelFold.ContainsKey($level)) { $level = $hints.LevelFold[$level] }
            elseif ($level -eq 'WARNING') { $level = 'WARN' }
            if (-not $levels.Contains($level)) { $levels[$level] = 0 }
            $levels[$level]++
            if ($level -in 'ERROR', 'FATAL', 'WARN') {
                $key = "[$level] " + (Get-LogTemplate $line)
                if ($templates.ContainsKey($key)) { $templates[$key]++ } else { $templates[$key] = 1 }
            }
        }
    } finally { $reader.Dispose() }
    return @{
        total = $total; levels = $levels; templates = $templates
        template_version = 2
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
            if ([int]($base.template_version ?? 0) -ne 2) {
                [void]$sb.AppendLine("NOTE: baseline saved with older template rules — re-save it; this diff may over-report NEW templates")
            }
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

# --- log_investigate: format detection + reusable format maps ---------------
# Deep structural analysis of any unknown log file. Emits a "format map" that
# is cached per file (~/.sensei/formats/) and transparently consumed as hints
# by the other log tools via Get-LogFormatHints.

$script:LogLevelFold = @{
    WARNING = 'WARN'; SEVERE = 'ERROR'; CRIT = 'ERROR'; CRITICAL = 'ERROR'; ERR = 'ERROR'
    PANIC = 'FATAL'; EMERG = 'FATAL'; EMERGENCY = 'FATAL'; ALERT = 'FATAL'; FTL = 'FATAL'
    NOTICE = 'INFO'; INF = 'INFO'; VERBOSE = 'DEBUG'; FINE = 'DEBUG'; DBG = 'DEBUG'
    FINER = 'TRACE'; FINEST = 'TRACE'; TRC = 'TRACE'; WRN = 'WARN'
}
$script:LogExtraLevelTerms = @('CRIT', 'CRITICAL', 'SEVERE', 'NOTICE', 'EMERG', 'EMERGENCY', 'ALERT',
    'PANIC', 'FINE', 'FINER', 'FINEST', 'VERBOSE', 'WRN', 'ERR', 'DBG', 'INF', 'FTL', 'TRC')

function Get-LogFileFacts {
    # Byte-level facts from the first 64KB: encoding/BOM, NUL sniff, line endings.
    param([string]$Path)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $buf = [byte[]]::new(65536)
        $n = $fs.Read($buf, 0, $buf.Length)
        $bytes = $fs.Length
    } finally { $fs.Dispose() }
    $encoding = 'ascii-compatible'
    if ($n -ge 3 -and $buf[0] -eq 0xEF -and $buf[1] -eq 0xBB -and $buf[2] -eq 0xBF) { $encoding = 'utf-8-bom' }
    elseif ($n -ge 2 -and $buf[0] -eq 0xFF -and $buf[1] -eq 0xFE) { $encoding = 'utf-16le' }
    elseif ($n -ge 2 -and $buf[0] -eq 0xFE -and $buf[1] -eq 0xFF) { $encoding = 'utf-16be' }
    else { for ($i = 0; $i -lt $n; $i++) { if ($buf[$i] -ge 0x80) { $encoding = 'utf-8'; break } } }
    $binary = $false
    $lineEnding = 'unknown'
    if ($encoding -notin 'utf-16le', 'utf-16be') {
        for ($i = 0; $i -lt $n; $i++) { if ($buf[$i] -eq 0) { $binary = $true; break } }
        $crlf = 0; $lf = 0
        for ($i = 0; $i -lt $n; $i++) {
            if ($buf[$i] -eq 10) { if ($i -gt 0 -and $buf[$i - 1] -eq 13) { $crlf++ } else { $lf++ } }
        }
        $lineEnding = if ($crlf -gt 0 -and $lf -gt 0) { 'mixed' } elseif ($crlf -gt 0) { 'crlf' } elseif ($lf -gt 0) { 'lf' } else { 'none' }
    }
    return [ordered]@{ bytes = $bytes; lines = 0; encoding = $encoding; line_ending = $lineEnding; max_line_chars = 0; binary = $binary }
}

function Get-LogValueType {
    param([string]$Value)
    if ($null -eq $Value -or $Value -eq '' -or $Value -eq 'null') { return 'null' }
    if ($Value -match '^1[6-9]\d{11}$') { return 'timestamp' }   # epoch-ms, before the generic int check
    if ($Value -match '^1[6-9]\d{8}$') { return 'timestamp' }    # epoch-s
    if ($Value -match '^-?\d{1,18}$') { return 'int' }
    if ($Value -match '^-?\d+\.\d+$') { return 'float' }
    if ($Value -match '^(?i)(true|false)$') { return 'bool' }
    if ($Value -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { return 'guid' }
    if ($Value -match '^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$') { return 'ip' }
    foreach ($c in $script:TsCandidates) {
        $m = $c.Regex.Match($Value)
        if ($m.Success -and $m.Index -eq 0 -and $m.Length -eq $Value.Length) { return 'timestamp' }
    }
    if ($Value -match '^\d+(\.\d+)?(ms|s|m|h)$') { return 'duration' }
    if ($Value -match '^https?://') { return 'url' }
    if ($Value -match '^([A-Za-z]:\\|/)') { return 'path' }
    return 'string'
}

function Get-LogFormatFamily {
    # Classify a sample of lines into a format family. Returns
    # @{ Family; Confidence; FamiliesSeen; Delimiter; Header }.
    param([string[]]$SampleLines)
    $lines = @($SampleLines | Where-Object { $_ -and $_.Trim() })
    $res = @{ Family = 'empty'; Confidence = 0.0; FamiliesSeen = @{}; Delimiter = $null; Header = $null }
    if ($lines.Count -eq 0) { return $res }
    $fieldsHeader = $lines | Where-Object { $_ -like '#Fields:*' } | Select-Object -First 1
    if ($fieldsHeader) {
        $res.Family = 'w3c-iis'; $res.Confidence = 0.95
        $res.Header = @((($fieldsHeader -replace '^#Fields:\s*', '') -split '\s+') | Where-Object { $_ })
        $res.FamiliesSeen = @{ 'w3c-iis' = 1.0 }
        return $res
    }
    $apacheRx = [regex]'^\S+ \S+ \S+ \[\d{2}/[A-Z][a-z]{2}/\d{4}:'
    $kvRx = [regex]'\b\w+=("[^"]*"|\S+)'
    $syslogRx = ($script:TsCandidates | Where-Object Name -eq 'syslog').Regex
    $counts = @{}
    $jsonParses = 0
    foreach ($l in $lines) {
        $t = $l.Trim()
        $fam = $null
        if ($t.StartsWith('{') -and $t.EndsWith('}')) {
            if ($jsonParses -lt 200) {
                $jsonParses++
                try { $null = $t | ConvertFrom-Json; $fam = 'json-lines' } catch { }
            } else { $fam = 'json-lines' }
        }
        if (-not $fam -and $apacheRx.IsMatch($l)) { $fam = 'apache-access' }
        if (-not $fam -and $l -match '^\w+=' -and $kvRx.Matches($l).Count -ge 3) { $fam = 'logfmt' }
        if (-not $fam -and $syslogRx.IsMatch($l)) { $fam = 'syslog' }
        if (-not $fam) {
            foreach ($c in $script:TsCandidates) {
                if ($c.Name -in 'epoch-ms', 'epoch-s') { continue }
                if ($c.Regex.IsMatch($l)) { $fam = 'timestamped-text'; break }
            }
        }
        if (-not $fam) { $fam = 'unstructured' }
        $counts[$fam] = 1 + ($counts[$fam] ?? 0)
    }
    $total = $lines.Count
    $seen = @{}
    foreach ($k in $counts.Keys) { $seen[$k] = [Math]::Round($counts[$k] / $total, 3) }
    $res.FamiliesSeen = $seen
    # csv/tsv: cross-line delimiter consistency, only when nothing structured dominates
    $structFrac = (($counts['json-lines'] ?? 0) + ($counts['apache-access'] ?? 0) + ($counts['logfmt'] ?? 0)) / $total
    if ($structFrac -lt 0.5) {
        foreach ($delim in "`t", ',') {
            $dcounts = [System.Collections.Generic.Dictionary[int, int]]::new()
            foreach ($l in $lines) {
                $n = $l.Split($delim).Length - 1
                if ($dcounts.ContainsKey($n)) { $dcounts[$n]++ } else { $dcounts[$n] = 1 }
            }
            $modal = $dcounts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
            if ($modal.Key -ge 2 -and ($modal.Value / $total) -ge 0.9) {
                $res.Family = if ($delim -eq "`t") { 'tsv' } else { 'csv' }
                $res.Confidence = [Math]::Round($modal.Value / $total, 2)
                $res.Delimiter = $delim
                $seen[$res.Family] = [Math]::Round($modal.Value / $total, 3)
                # header row: all cells read as plain words while the second row has typed cells
                if ($total -gt 1) {
                    $h = $lines[0].Split($delim)
                    $r2 = $lines[1].Split($delim)
                    $hAllStr = -not [bool]($h | Where-Object { (Get-LogValueType $_) -ne 'string' })
                    $r2Typed = [bool]($r2 | Where-Object { (Get-LogValueType $_) -in 'int', 'float', 'timestamp', 'guid', 'ip' })
                    if ($hAllStr -and $r2Typed) { $res.Header = @($h) }
                }
                return $res
            }
        }
    }
    $win = $counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
    $frac = $win.Value / $total
    $res.Family = if ($frac -lt 0.6) { 'mixed' } else { $win.Key }
    $res.Confidence = [Math]::Round($frac, 2)
    return $res
}

function Add-LogFieldSamples {
    # Extract name=value pairs from one line per the detected family and fold
    # them into $State (per-field type votes, cardinality, examples, min/max).
    param($State, [string]$Line, [string]$Family, [string]$Delimiter, $Header)
    $pairs = [System.Collections.Generic.List[object]]::new()
    switch ($Family) {
        'json-lines' {
            $trim = $Line.Trim()
            if (-not ($trim.StartsWith('{') -and $trim.EndsWith('}'))) { return $false }
            try { $obj = $trim | ConvertFrom-Json -AsHashtable } catch { return $false }
            if ($obj -isnot [hashtable]) { return $false }
            foreach ($k in $obj.Keys) {
                $v = $obj[$k]
                if ($v -is [hashtable]) { $pairs.Add(@([string]$k, '{...}', 'object')) }
                elseif ($v -is [array]) { $pairs.Add(@([string]$k, '[...]', 'array')) }
                elseif ($null -eq $v) { $pairs.Add(@([string]$k, '', 'null')) }
                else { $pairs.Add(@([string]$k, [string]$v, $null)) }
            }
        }
        { $_ -in 'csv', 'tsv', 'w3c-iis' } {
            if ($Line.StartsWith('#')) { return $false }
            $d = if ($Family -eq 'w3c-iis') { ' ' } else { $Delimiter }
            $cells = $Line.Split($d)
            for ($i = 0; $i -lt $cells.Length; $i++) {
                $name = if ($Header -and $i -lt @($Header).Count) { [string]@($Header)[$i] } else { "col$i" }
                $pairs.Add(@($name, $cells[$i], $null))
            }
        }
        default {
            # logfmt and key=value tokens embedded in timestamped text
            foreach ($m in [regex]::Matches($Line, '\b(\w+)=("([^"]*)"|[^\s,;\]]+)')) {
                $v = if ($m.Groups[3].Success) { $m.Groups[3].Value } else { $m.Groups[2].Value }
                $pairs.Add(@($m.Groups[1].Value, $v, $null))
            }
        }
    }
    if ($pairs.Count -eq 0) { return $false }
    foreach ($p in $pairs) {
        $name = $p[0]; $sv = $p[1]; $forced = $p[2]
        if (-not $State.ContainsKey($name)) {
            if ($State.Count -ge 100) { continue }
            $State[$name] = @{
                count = 0; types = @{}; values = [System.Collections.Generic.HashSet[string]]::new()
                examples = [System.Collections.Generic.List[string]]::new(); min = $null; max = $null
            }
        }
        $f = $State[$name]
        $f.count++
        $ty = if ($forced) { $forced } else { Get-LogValueType $sv }
        $f.types[$ty] = 1 + ($f.types[$ty] ?? 0)
        if ($f.values.Count -lt 5000) {
            [void]$f.values.Add($(if ($sv.Length -gt 100) { $sv.Substring(0, 100) } else { $sv }))
        }
        if ($f.examples.Count -lt 3 -and $sv -and -not $f.examples.Contains($sv)) {
            $f.examples.Add($(if ($sv.Length -gt 60) { $sv.Substring(0, 60) } else { $sv }))
        }
        if ($ty -in 'int', 'float') {
            $d = 0.0
            if ([double]::TryParse($sv, [cultureinfo]::InvariantCulture, [ref]$d)) {
                if ($null -eq $f.min -or $d -lt $f.min) { $f.min = $d }
                if ($null -eq $f.max -or $d -gt $f.max) { $f.max = $d }
            }
        }
    }
    return $true
}

function Get-LogFormatMap {
    # The analyzer: one streaming pass over the file, cheap work on every line,
    # expensive field typing on a deterministic sample. Pure — no cache I/O.
    param([string]$Path)
    $facts = Get-LogFileFacts $Path
    $map = [ordered]@{
        schema_version = $script:FormatMapSchemaVersion
        path           = $Path
        fingerprint    = ''
        generated      = [datetime]::UtcNow.ToString('o')
        sampled        = $false
        file           = $facts
        format         = [ordered]@{ family = 'unstructured'; confidence = 0.0; families_seen = @{}; delimiter = $null; header = $null; json_ts_field = $null; json_ts_parse = $null }
        timestamps     = @()
        time_range     = $null
        levels         = [ordered]@{ position = $null; vocabulary = [ordered]@{}; extra_terms = @(); coverage_pct = 0.0 }
        fields         = @()
        templates      = [ordered]@{ distinct = 0; capped = $false; top = @(); rare = @() }
        blocks         = [ordered]@{ continuation_pct = 0.0; max_block_lines = 0; example = $null }
        notes          = @()
    }
    if ($facts.binary) { $map.format.family = 'binary'; return $map }
    if ($facts.bytes -eq 0) { $map.format.family = 'empty'; return $map }

    $samplingOnly = $facts.bytes -gt 200MB
    $active = @($script:TsCandidates)
    $tsStats = @{}
    foreach ($c in $script:TsCandidates) { $tsStats[$c.Name] = @{ Hits = 0; Example = $null; Position = $null } }
    $extraRx = [regex]'(?i)(?:\[(\w{3,10})\]|"level"\s*:\s*"(\w+)"|\blevel=(\w+))'
    $tmplCounts = [System.Collections.Generic.Dictionary[string, int]]::new()
    $tmplMeta = [System.Collections.Generic.Dictionary[string, object]]::new()
    $fieldState = @{}
    $vocab = @{}
    $extraVocab = @{}
    $first1000 = [System.Collections.Generic.List[string]]::new()
    $tailRing = [System.Collections.Generic.Queue[object]]::new()
    $family = $null; $delimiter = $null; $header = $null
    $total = 0; $maxLineChars = 0; $tmplOverflow = 0
    $firstTs = $null; $lastTs = $null; $prevTs = $null
    $ordOk = 0; $ordCompares = 0
    $tsLineCount = 0; $levelLines = 0
    $contLines = 0; $curBlockLen = 0; $maxBlockLines = 0; $contExample = $null
    $bracketHits = 0; $bracketSampled = 0
    $stride = 1
    $deepState = @{ Samples = 0 }   # hashtable so the scriptblock below can mutate it
    $charsFirst1000 = 0

    $processDeep = {
        param([string]$line)
        $deepState.Samples++
        if (Add-LogFieldSamples $fieldState $line $family $delimiter $header) { }
        $em = $extraRx.Match($line)
        if ($em.Success) {
            $tok = ($em.Groups[1].Value + $em.Groups[2].Value + $em.Groups[3].Value).ToUpper()
            if ($tok -and $script:LogExtraLevelTerms -contains $tok) {
                $extraVocab[$tok] = 1 + ($extraVocab[$tok] ?? 0)
            }
        }
    }

    $reader = [System.IO.StreamReader]::new($Path)
    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            $total++
            $len = $line.Length
            if ($len -gt $maxLineChars) { $maxLineChars = $len }
            $scan = if ($len -gt 8192) { $line.Substring(0, 8192) } else { $line }

            # timestamp: first matching candidate wins the line
            $lineTs = $null
            foreach ($cand in $active) {
                $m = $cand.Regex.Match($scan)
                if (-not $m.Success) { continue }
                $dt = Convert-LogTimestampValue $m.Value $cand.Parse
                if ($null -eq $dt) { continue }
                $lineTs = $dt
                $stat = $tsStats[$cand.Name]
                $stat.Hits++
                if ($null -eq $stat.Example) {
                    $stat.Example = $m.Value
                    $stat.Position = if ($m.Index -eq 0) { 'prefix' } else { 'embedded' }
                }
                break
            }
            if ($lineTs) {
                if ($null -eq $firstTs) { $firstTs = $lineTs }
                $lastTs = $lineTs
                if ($null -ne $prevTs) { $ordCompares++; if ($lineTs -ge $prevTs) { $ordOk++ } }
                $prevTs = $lineTs
                $tsLineCount++
                $curBlockLen = 1
            } elseif ($tsLineCount -gt 0) {
                $contLines++
                $curBlockLen++
                if ($curBlockLen -gt $maxBlockLines) { $maxBlockLines = $curBlockLen }
                if ($null -eq $contExample -and $scan.Trim()) {
                    $contExample = if ($scan.Length -gt 120) { $scan.Substring(0, 120) } else { $scan }
                }
            }

            # level vocabulary (builtin terms; extra terms come from the deep sample)
            $lineLevel = $null
            $lm = $script:DefaultLevelRx.Match($scan)
            if ($lm.Success) {
                $lv = $lm.Groups[1].Value.ToUpper()
                if ($lv -eq 'WARNING') { $lv = 'WARN' }
                $vocab[$lv] = 1 + ($vocab[$lv] ?? 0)
                $levelLines++
                $lineLevel = $lv
                if ($bracketSampled -lt 200) {
                    $bracketSampled++
                    if ($lm.Index -gt 0 -and $scan[$lm.Index - 1] -eq '[') { $bracketHits++ }
                }
            }

            # deep-sample bookkeeping
            $deep = $false
            if ($total -le 1000) {
                $first1000.Add($line)
                $charsFirst1000 += $len
                $deep = $true   # deferred until family is known
            } else {
                if ($total -eq 1001) {
                    $fd = Get-LogFormatFamily $first1000
                    $family = $fd.Family; $delimiter = $fd.Delimiter; $header = $fd.Header
                    $map.format.confidence = $fd.Confidence; $map.format.families_seen = $fd.FamiliesSeen
                    $avg = [Math]::Max(1, $charsFirst1000 / 1000 + 2)
                    $estTotal = [Math]::Max(1000, $facts.bytes / $avg)
                    $stride = [Math]::Max(1, [int]($estTotal / 3000))
                    foreach ($buffered in $first1000) { & $processDeep $buffered }
                }
                if ($total % $stride -eq 0) { $deep = $true; & $processDeep $line }
                $tailRing.Enqueue(@{ No = $total; Line = $line })
                if ($tailRing.Count -gt 200) { [void]$tailRing.Dequeue() }
            }

            # templates: every line normally, deep samples only for huge files
            if (-not $samplingOnly -or $deep -or $total -le 1000) {
                $tmpl = Get-LogTemplate $scan
                if ($tmpl) {
                    if ($tmplCounts.ContainsKey($tmpl)) { $tmplCounts[$tmpl]++ }
                    elseif ($tmplCounts.Count -lt 20000) {
                        $tmplCounts[$tmpl] = 1
                        $tmplMeta[$tmpl] = @{ level = $lineLevel; line = $total }
                    } else { $tmplOverflow++ }
                }
            }
        }
    } finally { $reader.Dispose() }

    if ($total -eq 0) { $map.format.family = 'empty'; return $map }
    if ($total -le 1000) {
        # small file: family detection + deep pass never triggered inline
        $fd = Get-LogFormatFamily $first1000
        $family = $fd.Family; $delimiter = $fd.Delimiter; $header = $fd.Header
        $map.format.confidence = $fd.Confidence; $map.format.families_seen = $fd.FamiliesSeen
        foreach ($buffered in $first1000) { & $processDeep $buffered }
    } else {
        # deep-sample the tail (skip lines the stride already covered)
        foreach ($entry in $tailRing) {
            if ($entry.No % $stride -ne 0) { & $processDeep $entry.Line }
        }
    }

    $map.file.lines = $total
    $map.file.max_line_chars = $maxLineChars
    $map.format.family = $family
    $map.format.delimiter = if ($delimiter -eq "`t") { '\t' } else { $delimiter }
    $map.format.header = $header
    if ($samplingOnly) {
        $map.sampled = $true
        $map.notes += "file over 200MB — template counts are extrapolated from a 1-in-$stride sample"
    }

    # timestamps: only styles with meaningful coverage
    $minHits = [Math]::Max(2, [int]($total * 0.01))
    $tsOut = foreach ($c in $script:TsCandidates) {
        $s = $tsStats[$c.Name]
        if ($s.Hits -lt $minHits -and -not ($s.Hits -gt 0 -and $tsLineCount -eq $s.Hits)) { continue }
        [ordered]@{
            name = $c.Name; regex = $c.Regex.ToString(); parse = $c.Parse
            position = $s.Position; coverage_pct = [Math]::Round(100.0 * $s.Hits / $total, 1)
            example = $s.Example
        }
    }
    $map.timestamps = @($tsOut | Sort-Object coverage_pct -Descending)
    if ($firstTs) {
        $map.time_range = [ordered]@{
            first = $firstTs.ToString('o'); last = $lastTs.ToString('o')
            ordered_pct = if ($ordCompares -gt 0) { [Math]::Round(100.0 * $ordOk / $ordCompares, 1) } else { 100.0 }
        }
    }
    if (@($map.timestamps).Count -gt 1) {
        $second = @($map.timestamps)[1]
        $map.notes += "second timestamp style '$($second.name)' on $($second.coverage_pct)% of lines"
    }

    # levels
    foreach ($e in ($vocab.GetEnumerator() | Sort-Object Value -Descending)) { $map.levels.vocabulary[$e.Key] = $e.Value }
    foreach ($e in ($extraVocab.GetEnumerator() | Sort-Object Value -Descending)) {
        if (-not $map.levels.vocabulary.Contains($e.Key)) { $map.levels.vocabulary[$e.Key] = $e.Value }
    }
    $map.levels.extra_terms = @($extraVocab.Keys)
    $map.levels.coverage_pct = [Math]::Round(100.0 * $levelLines / $total, 1)
    $map.levels.position =
        if ($family -in 'json-lines', 'logfmt') { 'field:level' }
        elseif ($family -in 'csv', 'tsv', 'w3c-iis' -and $header -and (@($header) -contains 'level')) { "column:$([array]::IndexOf(@($header), 'level'))" }
        elseif ($bracketSampled -gt 0 -and $bracketHits / $bracketSampled -gt 0.5) { 'bracketed' }
        elseif ($levelLines -gt 0) { 'bare' }
        else { $null }

    # fields
    $fieldsOut = foreach ($e in ($fieldState.GetEnumerator() | Sort-Object { $_.Value.count } -Descending)) {
        $f = $e.Value
        $typeVotes = @($f.types.GetEnumerator() | Where-Object { $_.Key -ne 'null' } | Sort-Object Value -Descending)
        $ftype =
            if ($typeVotes.Count -eq 0) { 'null' }
            elseif ($typeVotes.Count -gt 1 -and $typeVotes[1].Value -ge 0.25 * $f.count) { 'mixed' }
            else { $typeVotes[0].Key }
        $out = [ordered]@{
            name = $e.Key; type = $ftype
            coverage_pct = [Math]::Round(100.0 * $f.count / [Math]::Max(1, $deepState.Samples), 1)
            cardinality = $f.values.Count; cardinality_capped = ($f.values.Count -ge 5000)
            examples = @($f.examples)
        }
        if ($ftype -in 'int', 'float' -and $null -ne $f.min) { $out.min = $f.min; $out.max = $f.max }
        $out
    }
    $map.fields = @($fieldsOut)

    # json timestamp field (for a fast hint path)
    if ($family -eq 'json-lines') {
        $tsFields = @($map.fields | Where-Object { $_.type -eq 'timestamp' })
        $preferred = $tsFields | Where-Object { $_.name -in 'time', 'ts', 'timestamp', '@timestamp', 'datetime', 'date' } | Select-Object -First 1
        $tsField = if ($preferred) { $preferred } else { $tsFields | Select-Object -First 1 }
        if ($tsField) {
            $map.format.json_ts_field = $tsField.name
            $ex = [string](@($tsField.examples) | Select-Object -First 1)
            $map.format.json_ts_parse =
                if ($ex -match '^1[6-9]\d{11}$') { 'epoch-ms' }
                elseif ($ex -match '^1[6-9]\d{8}$') { 'epoch-s' }
                else { 'tryparse' }
        }
    }

    # templates
    $mult = if ($samplingOnly) { $stride } else { 1 }
    $map.templates.distinct = $tmplCounts.Count
    $map.templates.capped = ($tmplOverflow -gt 0)
    if ($tmplOverflow -gt 0) { $map.notes += "template catalog capped at 20000 distinct entries ($tmplOverflow lines uncounted)" }
    $top = $tmplCounts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15
    $map.templates.top = @(foreach ($e in $top) {
        $meta = $tmplMeta[$e.Key]
        [ordered]@{ template = $e.Key; count = $e.Value * $mult; level = $meta.level; example_line = $meta.line }
    })
    $rareMax = [Math]::Max(1, [int][Math]::Floor($total / 100000))
    $levelPri = @{ FATAL = 0; ERROR = 1; WARN = 2 }
    $rare = $tmplCounts.GetEnumerator() | Where-Object { $_.Value -le $rareMax } |
        Sort-Object @{ Expression = { $levelPri[[string]$tmplMeta[$_.Key].level] ?? 3 } }, @{ Expression = { $_.Value } } |
        Select-Object -First 10
    $map.templates.rare = @(foreach ($e in $rare) {
        $meta = $tmplMeta[$e.Key]
        [ordered]@{ template = $e.Key; count = $e.Value * $mult; level = $meta.level; example_line = $meta.line }
    })

    # multi-line blocks
    $map.blocks.continuation_pct = [Math]::Round(100.0 * $contLines / $total, 1)
    $map.blocks.max_block_lines = $maxBlockLines
    $map.blocks.example = $contExample
    if ($contLines -gt 0) { $map.notes += "multi-line blocks present: $($map.blocks.continuation_pct)% continuation lines, up to $maxBlockLines lines per block" }
    if ($map.time_range -and $map.time_range.ordered_pct -lt 99) {
        $map.notes += "only $($map.time_range.ordered_pct)% of lines are time-ordered — treat time-range slicing with care"
    }
    return $map
}

# --- format-map cache + hints ----------------------------------------------

$script:LogHintsCache = @{}

function Get-SenseiFormatMapPath {
    # Cache location + fingerprint for a resolved path. Hash recipe mirrors the
    # embed-cache, with the schema version in place of the model name.
    param([string]$ResolvedPath)
    $fi = Get-Item -LiteralPath $ResolvedPath
    $fp = "$($fi.Length)-$($fi.LastWriteTimeUtc.Ticks)"
    $hash = [BitConverter]::ToString([System.Security.Cryptography.SHA1]::HashData(
            [System.Text.Encoding]::UTF8.GetBytes("$ResolvedPath|$fp|v$($script:FormatMapSchemaVersion)"))).Replace('-', '').Substring(0, 16)
    return @{ File = Join-Path (Join-Path $script:ConfigDir 'formats') "$hash.json"; Fingerprint = $fp }
}

function Get-SenseiFormatMap {
    # Cache orchestrator. -IfCached never analyzes (used by the hints path).
    # The stored fingerprint is validated IN FULL against the file on disk.
    param([string]$Path, [switch]$Refresh, [switch]$IfCached)
    $resolved = Resolve-SenseiPath $Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { return $null }
    $loc = Get-SenseiFormatMapPath $resolved
    if (-not $Refresh -and (Test-Path -LiteralPath $loc.File)) {
        try {
            $map = Get-Content -LiteralPath $loc.File -Raw | ConvertFrom-Json -AsHashtable
            if ([string]$map.fingerprint -eq $loc.Fingerprint -and [int]$map.schema_version -eq $script:FormatMapSchemaVersion) {
                return @{ Map = $map; Cached = $true }
            }
        } catch { }
    }
    if ($IfCached) { return $null }
    $map = Get-LogFormatMap $resolved
    $map.fingerprint = $loc.Fingerprint
    $dir = Split-Path -Parent $loc.File
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    ConvertTo-Json -InputObject $map -Depth 12 | Set-Content -LiteralPath $loc.File -Encoding utf8NoBOM
    $old = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' | Sort-Object LastWriteTime)
    if ($old.Count -gt 50) { $old | Select-Object -First ($old.Count - 50) | Remove-Item -Force -ErrorAction SilentlyContinue }
    return @{ Map = $map; Cached = $false }
}

function Get-LogFormatHints {
    # Cheap accessor the other log tools call once per file: returns $null when
    # no fresh cached map exists (behavior then identical to before), else a
    # small compiled hints hashtable. Never triggers an analysis.
    param([string]$Path)
    try {
        $resolved = Resolve-SenseiPath $Path
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { return $null }
        $loc = Get-SenseiFormatMapPath $resolved
        if (-not (Test-Path -LiteralPath $loc.File)) { return $null }
        $key = "$resolved|$($loc.Fingerprint)"
        if ($script:LogHintsCache.ContainsKey($key)) { return $script:LogHintsCache[$key] }
        $r = Get-SenseiFormatMap -Path $resolved -IfCached
        if (-not $r) { return $null }
        $map = $r.Map
        $hints = @{}
        $builtin = @('iso8601', 'us-legacy', 'syslog')
        $tm = [System.Collections.Generic.List[object]]::new()
        foreach ($t in @($map.timestamps)) {
            if (-not $t -or $builtin -contains [string]$t.name) { continue }
            try { $tm.Add(@{ Regex = [regex][string]$t.regex; Parse = [string]$t.parse }) } catch { }
        }
        if ($tm.Count -gt 0) { $hints.TsMatchers = $tm }
        if ($map.format.json_ts_field) {
            $hints.JsonTsRx = [regex]('"' + [regex]::Escape([string]$map.format.json_ts_field) + '"\s*:\s*"?([^",}\s]+)')
            $hints.JsonTsParse = [string]$map.format.json_ts_parse
        }
        $extras = @($map.levels.extra_terms | Where-Object { $_ })
        if ($extras.Count -gt 0) {
            $alts = (@('FATAL', 'ERROR', 'WARN(?:ING)?', 'INFO', 'DEBUG', 'TRACE') +
                @($extras | ForEach-Object { [regex]::Escape([string]$_) })) -join '|'
            $hints.LevelRx = [regex]"(?i)\b($alts)\b"
        }
        if ($hints.Count -eq 0) { return $null }   # map adds nothing beyond the defaults
        $hints.LevelFold = $script:LogLevelFold
        $script:LogHintsCache[$key] = $hints
        return $hints
    } catch { return $null }
}

function Format-LogMapSummary {
    # Human/model-readable rendering of a format map. Stays far below the 30k
    # tool-output cap: top 15 templates, 10 rare, 20 fields, trimmed examples.
    param($Map, [bool]$Cached)
    $sb = [System.Text.StringBuilder]::new()
    $cachedTag = if ($Cached) { '  (cached — refresh=true to re-analyze)' } else { '' }
    [void]$sb.AppendLine("[log_investigate — $($Map.path)]$cachedTag")
    $f = $Map.file
    if ($Map.format.family -eq 'binary') {
        [void]$sb.AppendLine("format: binary (NUL bytes in the first 64KB) — not a text log; the log tools cannot parse this file")
        return $sb.ToString()
    }
    if ($Map.format.family -eq 'empty') {
        [void]$sb.AppendLine("format: empty file (0 lines)")
        return $sb.ToString()
    }
    [void]$sb.AppendLine(("file: {0:n1} MB, {1:n0} lines, {2}, {3} line endings, longest line {4:n0} chars" -f
        ($f.bytes / 1MB), $f.lines, $f.encoding, $f.line_ending, $f.max_line_chars))
    $fmtLine = "format: $($Map.format.family) ($([int](100 * $Map.format.confidence))% confidence)"
    if ($Map.format.delimiter) { $fmtLine += ", delimiter '$($Map.format.delimiter)'" }
    [void]$sb.AppendLine($fmtLine)
    if ($Map.format.family -eq 'mixed' -and $Map.format.families_seen) {
        $mixParts = foreach ($k in $Map.format.families_seen.Keys) { "$k $([int](100 * $Map.format.families_seen[$k]))%" }
        [void]$sb.AppendLine("  families seen: " + ($mixParts -join ', '))
    }
    if ($Map.format.header) { [void]$sb.AppendLine("columns: " + (@($Map.format.header) -join ', ')) }
    if (@($Map.timestamps).Count -gt 0) {
        [void]$sb.AppendLine('timestamp styles:')
        foreach ($t in @($Map.timestamps)) {
            [void]$sb.AppendLine(("  {0,-11} {1,-9} {2,5:n1}%  e.g. {3}" -f $t.name, $t.position, $t.coverage_pct, $t.example))
        }
    } else {
        [void]$sb.AppendLine('timestamp styles: none detected')
    }
    if ($Map.format.json_ts_field) {
        [void]$sb.AppendLine("  json timestamp field: ""$($Map.format.json_ts_field)"" ($($Map.format.json_ts_parse))")
    }
    if ($Map.time_range) {
        [void]$sb.AppendLine("time range: $($Map.time_range.first) → $($Map.time_range.last)  ($($Map.time_range.ordered_pct)% time-ordered)")
    }
    $lv = $Map.levels
    if ($lv.vocabulary.Count -gt 0) {
        $lvParts = foreach ($k in $lv.vocabulary.Keys) { "${k}: $($lv.vocabulary[$k])" }
        $lvLine = "levels ($($lv.position), $($lv.coverage_pct)% of lines): " + ($lvParts -join ' | ')
        if (@($lv.extra_terms).Count -gt 0) { $lvLine += "   [extra terms beyond the default set: $(@($lv.extra_terms) -join ', ')]" }
        [void]$sb.AppendLine($lvLine)
    } else {
        [void]$sb.AppendLine('levels: none detected')
    }
    if (@($Map.fields).Count -gt 0) {
        [void]$sb.AppendLine('fields (from sampled records):')
        foreach ($fd in (@($Map.fields) | Select-Object -First 20)) {
            $line = ("  {0,-18} {1,-9} {2,5:n1}%  card {3}{4}" -f $fd.name, $fd.type, $fd.coverage_pct, $fd.cardinality,
                $(if ($fd.cardinality_capped) { '+' } else { '' }))
            if (@($fd.examples).Count -gt 0) { $line += "  e.g. " + ((@($fd.examples) | Select-Object -First 2) -join ', ') }
            if ($null -ne $fd.min) { $line += "  range $($fd.min)..$($fd.max)" }
            [void]$sb.AppendLine($line)
        }
        if (@($Map.fields).Count -gt 20) { [void]$sb.AppendLine("  … and $(@($Map.fields).Count - 20) more fields") }
    }
    $tp = $Map.templates
    [void]$sb.AppendLine("templates: $($tp.distinct) distinct$(if ($tp.capped) { ' (capped)' })")
    foreach ($t in @($tp.top)) {
        $txt = if ($t.template.Length -gt 120) { $t.template.Substring(0, 117) + '…' } else { $t.template }
        [void]$sb.AppendLine(("  {0,8} × {1}" -f $t.count, $txt))
    }
    if (@($tp.rare).Count -gt 0) {
        [void]$sb.AppendLine('RARE / UNIQUE EVENTS:')
        foreach ($t in @($tp.rare)) {
            $txt = if ($t.template.Length -gt 120) { $t.template.Substring(0, 117) + '…' } else { $t.template }
            [void]$sb.AppendLine(("  {0,4} × (line {1}) {2}" -f $t.count, $t.example_line, $txt))
        }
    }
    if ($Map.blocks.max_block_lines -gt 1) {
        [void]$sb.AppendLine("multi-line: $($Map.blocks.continuation_pct)% continuation lines, blocks up to $($Map.blocks.max_block_lines) lines (stack traces or wrapped output)")
    }
    if (@($Map.notes).Count -gt 0) {
        [void]$sb.AppendLine('notes:')
        foreach ($n in @($Map.notes)) { [void]$sb.AppendLine("  - $n") }
    }
    [void]$sb.AppendLine('hint: log_stats, log_slice, log_timeline and log_trace now understand this file''s timestamps and level vocabulary.')
    return $sb.ToString()
}

Register-SenseiTool -Name 'log_investigate' -ReadOnly $true -PrimaryArg 'path' `
    -Description 'Deep structural analysis of ANY unknown log file: detects the format family (json-lines, logfmt, csv, apache/w3c access, timestamped text…), timestamp styles and coverage, level vocabulary, field types and cardinality, repeated templates, and rare/unique events. Saves a reusable format map that makes the other log tools understand the file. Call this when log_stats finds no timestamps/levels or the format is unfamiliar.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            path    = @{ type = 'string' }
            refresh = @{ type = 'boolean'; description = 'Re-analyze even if a cached map exists' }
        }
        required   = @('path')
    } -Handler {
        param($a)
        $path = Resolve-SenseiPath ([string]$a.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "ERROR: file not found: $path" }
        $r = Get-SenseiFormatMap -Path $path -Refresh:([bool]$a.refresh)
        if (-not $r) { return "ERROR: could not analyze $path" }
        return Format-LogMapSummary $r.Map $r.Cached
    }

