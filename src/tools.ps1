# tools.ps1 — tool registry + core Claude-Code-style tools.

$script:ToolRegistry = [ordered]@{}

function Register-SenseiTool {
    param(
        [string]$Name,
        [string]$Description,
        [hashtable]$Parameters,
        [bool]$ReadOnly,
        [scriptblock]$Handler,
        [string]$PrimaryArg = $null
    )
    $script:ToolRegistry[$Name] = @{
        Description = $Description
        Parameters  = $Parameters
        ReadOnly    = $ReadOnly
        Handler     = $Handler
        PrimaryArg  = $PrimaryArg
    }
}

function Get-ToolSpecs {
    param([string[]]$Exclude = @())
    $specs = foreach ($e in $script:ToolRegistry.GetEnumerator()) {
        if ($e.Key -in $Exclude) { continue }
        @{
            type     = 'function'
            function = @{
                name        = $e.Key
                description = $e.Value.Description
                parameters  = $e.Value.Parameters
            }
        }
    }
    return @($specs)
}

function Limit-ToolOutput {
    param([string]$Text, [int]$Max = 30000)
    if ($null -eq $Text) { return '' }
    if ($Text.Length -le $Max) { return $Text }
    return $Text.Substring(0, $Max) + "`n[truncated: showing $Max of $($Text.Length) chars — use offset/limit or range parameters to narrow the request]"
}

function Resolve-SenseiPath {
    param([string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

# --- read_file -------------------------------------------------------------

Register-SenseiTool -Name 'read_file' -ReadOnly $true -PrimaryArg 'path' `
    -Description 'Read a text file with line numbers. Use offset/limit to page through large files. For log files prefer log_stats and log_slice.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            path   = @{ type = 'string'; description = 'File path, absolute or relative to the working directory' }
            offset = @{ type = 'integer'; description = '1-based line number to start from (default 1)' }
            limit  = @{ type = 'integer'; description = 'Maximum lines to return (default 2000)' }
        }
        required   = @('path')
    } -Handler {
        param($a)
        $path = Resolve-SenseiPath $a.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "ERROR: file not found: $path" }
        $offset = [Math]::Max(1, [int]($a.offset ?? 1))
        $limit  = [Math]::Max(1, [int]($a.limit ?? 2000))
        $sb = [System.Text.StringBuilder]::new()
        $n = 0
        $emitted = 0
        # explicit reader: PowerShell's foreach never disposes ReadLines'
        # enumerator, which keeps the file handle open after an early break
        $reader = [System.IO.StreamReader]::new($path)
        try {
            while ($null -ne ($line = $reader.ReadLine())) {
                $n++
                if ($n -lt $offset) { continue }
                if ($emitted -ge $limit) {
                    [void]$sb.AppendLine("[more lines follow — call again with offset=$n]")
                    break
                }
                [void]$sb.AppendLine(('{0,6}→{1}' -f $n, $line))
                $emitted++
            }
        } finally {
            $reader.Dispose()
        }
        if ($emitted -eq 0) { return "ERROR: offset $offset is past the end of the file ($n lines)" }
        return $sb.ToString()
    }

# --- write_file ------------------------------------------------------------

Register-SenseiTool -Name 'write_file' -ReadOnly $false -PrimaryArg 'path' `
    -Description 'Create or overwrite a text file with the given content (UTF-8, no BOM). Parent directories are created automatically.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            path    = @{ type = 'string' }
            content = @{ type = 'string' }
        }
        required   = @('path', 'content')
    } -Handler {
        param($a)
        $path = Resolve-SenseiPath $a.path
        $dir = Split-Path -Parent $path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
        [System.IO.File]::WriteAllText($path, [string]$a.content)
        return "Wrote $(([string]$a.content).Length) chars to $path"
    }

# --- edit_file -------------------------------------------------------------

Register-SenseiTool -Name 'edit_file' -ReadOnly $false -PrimaryArg 'path' `
    -Description 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true; include surrounding lines to make it unique.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            path        = @{ type = 'string' }
            old_string  = @{ type = 'string'; description = 'Exact text to find (must be unique in the file unless replace_all)' }
            new_string  = @{ type = 'string'; description = 'Replacement text' }
            replace_all = @{ type = 'boolean'; description = 'Replace every occurrence (default false)' }
        }
        required   = @('path', 'old_string', 'new_string')
    } -Handler {
        param($a)
        $path = Resolve-SenseiPath $a.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "ERROR: file not found: $path" }
        $old = [string]$a.old_string
        $new = [string]$a.new_string
        if ($old -eq '') { return 'ERROR: old_string must not be empty' }
        $text = [System.IO.File]::ReadAllText($path)
        $count = [regex]::Matches($text, [regex]::Escape($old)).Count
        if ($count -eq 0) { return "ERROR: old_string not found in $path" }
        $replaceAll = [bool]($a.replace_all ?? $false)
        if ($count -gt 1 -and -not $replaceAll) {
            return "ERROR: old_string occurs $count times in $path; add surrounding context to make it unique, or set replace_all=true"
        }
        if ($replaceAll) {
            $text = $text.Replace($old, $new)
        } else {
            $idx = $text.IndexOf($old, [System.StringComparison]::Ordinal)
            $text = $text.Substring(0, $idx) + $new + $text.Substring($idx + $old.Length)
        }
        [System.IO.File]::WriteAllText($path, $text)
        return "Edited $path ($count replacement$(if ($count -ne 1) { 's' }))"
    }

# --- multi_edit ------------------------------------------------------------

Register-SenseiTool -Name 'multi_edit' -ReadOnly $false -PrimaryArg 'path' `
    -Description 'Apply several exact-string edits to one file atomically, in order. Each edit follows edit_file rules (old_string unique unless replace_all). If ANY edit fails to match, the file is left unchanged and an error names the failing edit.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            path  = @{ type = 'string' }
            edits = @{
                type  = 'array'
                items = @{
                    type       = 'object'
                    properties = @{
                        old_string  = @{ type = 'string' }
                        new_string  = @{ type = 'string' }
                        replace_all = @{ type = 'boolean' }
                    }
                    required   = @('old_string', 'new_string')
                }
            }
        }
        required   = @('path', 'edits')
    } -Handler {
        param($a)
        $path = Resolve-SenseiPath $a.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "ERROR: file not found: $path" }
        $edits = @($a.edits)
        if ($edits.Count -eq 0) { return 'ERROR: no edits provided' }
        $text = [System.IO.File]::ReadAllText($path)
        $applied = 0
        for ($i = 0; $i -lt $edits.Count; $i++) {
            $old = [string]$edits[$i].old_string
            $new = [string]$edits[$i].new_string
            if ($old -eq '') { return "ERROR: edit #$($i + 1): old_string must not be empty (no changes written)" }
            $count = [regex]::Matches($text, [regex]::Escape($old)).Count
            if ($count -eq 0) { return "ERROR: edit #$($i + 1): old_string not found (no changes written)" }
            $replaceAll = [bool]($edits[$i].replace_all ?? $false)
            if ($count -gt 1 -and -not $replaceAll) {
                return "ERROR: edit #$($i + 1): old_string occurs $count times; add context or set replace_all (no changes written)"
            }
            if ($replaceAll) { $text = $text.Replace($old, $new) }
            else {
                $idx = $text.IndexOf($old, [System.StringComparison]::Ordinal)
                $text = $text.Substring(0, $idx) + $new + $text.Substring($idx + $old.Length)
            }
            $applied++
        }
        [System.IO.File]::WriteAllText($path, $text)
        return "Applied $applied edit(s) to $path"
    }

# --- glob ------------------------------------------------------------------

Register-SenseiTool -Name 'glob' -ReadOnly $true -PrimaryArg 'path' `
    -Description "Find files by glob pattern, newest first (max 200). '*.log' matches only the top level of the search root; '**/*.log' matches recursively." `
    -Parameters @{
        type       = 'object'
        properties = @{
            pattern = @{ type = 'string'; description = "Glob pattern, e.g. '**/*.log' or 'src/*.ps1'" }
            path    = @{ type = 'string'; description = 'Directory to search (default: working directory)' }
        }
        required   = @('pattern')
    } -Handler {
        param($a)
        $root = Resolve-SenseiPath ([string]($a.path ?? '.'))
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { return "ERROR: directory not found: $root" }
        $rx = '^' + ([regex]::Escape((([string]$a.pattern) -replace '\\', '/')) `
                -replace '\\\*\\\*/', '(?:.*/)?' `
                -replace '\\\*\\\*', '.*' `
                -replace '\\\*', '[^/]*' `
                -replace '\\\?', '.') + '$'
        $opts = [System.IO.EnumerationOptions]::new()
        $opts.RecurseSubdirectories = $true
        $opts.IgnoreInaccessible = $true
        $found = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
        foreach ($f in [System.IO.Directory]::EnumerateFiles($root, '*', $opts)) {
            $rel = $f.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
            if ($rel -match $rx) { $found.Add([System.IO.FileInfo]::new($f)) }
        }
        if ($found.Count -eq 0) { return "No files match '$($a.pattern)' under $root" }
        $sorted = @($found | Sort-Object LastWriteTime -Descending | Select-Object -First 200)
        $out = ($sorted | ForEach-Object { $_.FullName }) -join "`n"
        if ($found.Count -gt 200) { $out += "`n[showing newest 200 of $($found.Count) matches]" }
        return $out
    }

# --- grep ------------------------------------------------------------------

Register-SenseiTool -Name 'grep' -ReadOnly $true -PrimaryArg 'path' `
    -Description 'Regex content search across files (case-insensitive by default). Modes: files_with_matches (default), content (file:line:text with optional context), count (per-file match counts).' `
    -Parameters @{
        type       = 'object'
        properties = @{
            pattern        = @{ type = 'string'; description = '.NET regular expression' }
            path           = @{ type = 'string'; description = 'File or directory to search (default: working directory)' }
            glob           = @{ type = 'string'; description = "Filename filter when searching a directory, e.g. '*.log'" }
            output_mode    = @{ type = 'string'; enum = @('files_with_matches', 'content', 'count') }
            context        = @{ type = 'integer'; description = 'Lines of context before/after each match (content mode only)' }
            case_sensitive = @{ type = 'boolean'; description = 'Default false' }
            head_limit     = @{ type = 'integer'; description = 'Max results to return (default 100)' }
        }
        required   = @('pattern')
    } -Handler {
        param($a)
        $root = Resolve-SenseiPath ([string]($a.path ?? '.'))
        if (-not (Test-Path -LiteralPath $root)) { return "ERROR: path not found: $root" }
        $files = if (Test-Path -LiteralPath $root -PathType Leaf) {
            @(Get-Item -LiteralPath $root)
        } else {
            @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter ([string]($a.glob ?? '*')) -ErrorAction SilentlyContinue)
        }
        if ($files.Count -eq 0) { return "ERROR: no files to search under $root" }
        $cs = [bool]($a.case_sensitive ?? $false)
        $limit = [Math]::Max(1, [int]($a.head_limit ?? 100))
        $mode = [string]($a.output_mode ?? 'files_with_matches')
        switch ($mode) {
            'files_with_matches' {
                $paths = @($files | Select-String -Pattern $a.pattern -CaseSensitive:$cs -List |
                    ForEach-Object Path | Select-Object -Unique -First $limit)
                if ($paths.Count -eq 0) { return "No matches for '$($a.pattern)'" }
                return $paths -join "`n"
            }
            'count' {
                $hits = @($files | Select-String -Pattern $a.pattern -CaseSensitive:$cs)
                if ($hits.Count -eq 0) { return "No matches for '$($a.pattern)'" }
                $groups = @($hits | Group-Object Path | Sort-Object Count -Descending | Select-Object -First $limit)
                return ($groups | ForEach-Object { "$($_.Count)`t$($_.Name)" }) -join "`n"
            }
            'content' {
                $ctx = [Math]::Max(0, [int]($a.context ?? 0))
                $hits = @($files | Select-String -Pattern $a.pattern -CaseSensitive:$cs -Context $ctx |
                    Select-Object -First $limit)
                if ($hits.Count -eq 0) { return "No matches for '$($a.pattern)'" }
                $sb = [System.Text.StringBuilder]::new()
                foreach ($h in $hits) {
                    if ($ctx -gt 0 -and $h.Context) {
                        $pre = @($h.Context.PreContext)
                        for ($j = 0; $j -lt $pre.Count; $j++) {
                            [void]$sb.AppendLine("$($h.Path):$($h.LineNumber - $pre.Count + $j)- $($pre[$j])")
                        }
                    }
                    [void]$sb.AppendLine("$($h.Path):$($h.LineNumber):$($h.Line)")
                    if ($ctx -gt 0 -and $h.Context) {
                        $post = @($h.Context.PostContext)
                        for ($j = 0; $j -lt $post.Count; $j++) {
                            [void]$sb.AppendLine("$($h.Path):$($h.LineNumber + 1 + $j)- $($post[$j])")
                        }
                        [void]$sb.AppendLine('--')
                    }
                }
                return $sb.ToString()
            }
            default { return "ERROR: unknown output_mode '$mode'" }
        }
    }

# --- run_powershell --------------------------------------------------------

Register-SenseiTool -Name 'run_powershell' -ReadOnly $false -PrimaryArg 'command' `
    -Description 'Run a command in a fresh non-interactive pwsh child process and return exit code, stdout, and stderr. State does not persist between calls. Default timeout 120s. Set run_in_background=true for long-running commands: returns a task id immediately; check it later with task_output.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            command           = @{ type = 'string' }
            timeout_seconds   = @{ type = 'integer'; description = '1–600, default 120 (foreground only)' }
            run_in_background = @{ type = 'boolean'; description = 'Run detached and return a task id immediately (default false)' }
        }
        required   = @('command')
    } -Handler {
        param($a)
        if ([bool]($a.run_in_background ?? $false)) {
            return Start-SenseiBackgroundTask -Command ([string]$a.command)
        }
        $timeoutMs = 1000 * [Math]::Min(600, [Math]::Max(1, [int]($a.timeout_seconds ?? 120)))
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = 'pwsh'
        foreach ($arg in '-NoProfile', '-NonInteractive', '-Command', [string]$a.command) { $psi.ArgumentList.Add($arg) }
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new()
        $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new()
        $psi.WorkingDirectory = (Get-Location).Path
        $p = [System.Diagnostics.Process]::Start($psi)
        try {
            $outTask = $p.StandardOutput.ReadToEndAsync()
            $errTask = $p.StandardError.ReadToEndAsync()
            if (-not $p.WaitForExit($timeoutMs)) {
                try { $p.Kill($true) } catch { }
                return "ERROR: command timed out after $($timeoutMs / 1000)s and was killed (use run_in_background=true for long commands)"
            }
            $p.WaitForExit()   # second wait flushes the async output streams
            $out = $outTask.GetAwaiter().GetResult()
            $err = $errTask.GetAwaiter().GetResult()
            $result = "exit_code: $($p.ExitCode)"
            if ($out) { $result += "`n--- stdout ---`n$out" }
            if ($err) { $result += "`n--- stderr ---`n$err" }
            return $result
        } finally {
            $p.Dispose()
        }
    }

# --- todo_write ------------------------------------------------------------

Register-SenseiTool -Name 'todo_write' -ReadOnly $true `
    -Description 'Create or update the visible task checklist for multi-step work. Pass the FULL list every time (it replaces the previous one). Keep exactly one item in_progress while working.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            todos = @{
                type  = 'array'
                items = @{
                    type       = 'object'
                    properties = @{
                        content = @{ type = 'string' }
                        status  = @{ type = 'string'; enum = @('pending', 'in_progress', 'completed') }
                    }
                    required   = @('content', 'status')
                }
            }
        }
        required   = @('todos')
    } -Handler {
        param($a)
        $script:Todos = @($a.todos)
        Write-SenseiTodos
        return "Todos updated ($(@($a.todos).Count) items)"
    }

# web_fetch, web_search, and web_browser live in src\web.ps1
