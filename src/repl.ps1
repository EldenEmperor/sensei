# repl.ps1 — the interactive loop, built-in slash commands, custom commands.

function Start-SenseiRepl {
    while ($true) {
        Show-FinishedTaskNotes
        $line = Read-SenseiInput
        if ($null -eq $line) { break }   # EOF
        $line = $line.Trim()
        if (-not $line) { continue }
        if ($line.StartsWith('/')) {
            if (-not (Invoke-SlashCommand $line)) { break }
            continue
        }
        try {
            Invoke-AgentTurn $line
        } catch [System.OperationCanceledException] {
            Write-SenseiNote '(aborted)'
        }
        Write-Host ''
    }
}

function Find-SenseiCustomCommand {
    param([string]$Name)
    $candidates = @(
        (Join-Path (Get-Location).Path ".sensei\commands\$Name.md")
        (Join-Path $script:ConfigDir "commands\$Name.md")
    )
    foreach ($p in $candidates) {
        if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
    }
    return $null
}

function Get-SenseiCustomCommandNames {
    $names = @()
    foreach ($dir in @((Join-Path (Get-Location).Path '.sensei\commands'), (Join-Path $script:ConfigDir 'commands'))) {
        if (Test-Path -LiteralPath $dir) {
            $names += @(Get-ChildItem -LiteralPath $dir -Filter '*.md' | ForEach-Object { $_.BaseName })
        }
    }
    return @($names | Select-Object -Unique)
}

function Invoke-SlashCommand {
    # Returns $false when the REPL should exit.
    param([string]$Line)
    $parts = $Line.Split(' ', 2)
    $cmd = $parts[0].ToLower()
    $arg = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
    switch ($cmd) {
        '/help' {
            Write-Host '  /help            show this help'
            Write-Host '  /clear           save + reset the conversation (and todos)'
            Write-Host '  /compact         summarize the conversation to reclaim context'
            Write-Host '  /plan            toggle plan mode (read-only until you approve a plan)'
            Write-Host '  /style [name]    response style: default|concise|explanatory|teaching'
            Write-Host '  /color [name|hex] accent color: indigo|jade|gold|teal|red or #RRGGBB'
            Write-Host '  /model [name]    show or set the model (setting persists to config)'
            Write-Host '  /config          show effective config and key/mode info'
            Write-Host '  /mcp             MCP server status and tools'
            Write-Host '  /permissions     list allowlist rules'
            Write-Host '  /skills          list available skills'
            Write-Host '  /newskill <name> [purpose]  have the agent author a new skill'
            Write-Host '  /tasks           list background tasks'
            Write-Host '  /todos           show the current checklist'
            Write-Host '  /cost            token usage and estimated cost'
            Write-Host '  /memory          show loaded SENSEI.md memory files'
            Write-Host '  /init            explore this directory and write a SENSEI.md'
            Write-Host '  /investigate [path]  deep-map a log file''s structure (default: newest .log in cwd)'
            Write-Host '  /resume          pick a previous session to continue'
            Write-Host '  /exit            quit (also /quit, or Ctrl+D)'
            $custom = Get-SenseiCustomCommandNames
            if ($custom.Count -gt 0) {
                Write-Host "  custom: $(($custom | ForEach-Object { "/$_" }) -join ' ')"
            }
            $skillNames = @(Get-SenseiSkills | ForEach-Object { $_.Name })
            if ($skillNames.Count -gt 0) {
                Write-Host "  skills: $(($skillNames | ForEach-Object { "/$_" }) -join ' ')"
            }
        }
        '/clear' {
            Save-SenseiSession
            $script:Messages.Clear()
            $script:Messages.Add(@{ role = 'system'; content = (Get-SenseiSystemPrompt) })
            $script:Todos = @()
            $script:TotalPromptTokens = 0
            $script:TotalCompletionTokens = 0
            $script:SessionPath = $null
            Write-SenseiNote 'conversation cleared'
        }
        '/compact' {
            try {
                Invoke-ContextCompaction -Messages $script:Messages -Force
            } catch [System.OperationCanceledException] {
                Write-SenseiNote '(aborted)'
            }
        }
        '/plan' {
            $script:PlanMode = -not $script:PlanMode
            if ($script:PlanMode) { Write-SenseiNote 'plan mode ON — read-only; the agent will propose a plan for you to approve' }
            else { Write-SenseiNote 'plan mode OFF — the agent can edit and run commands again' }
        }
        '/style' {
            if ($arg) {
                if ($script:OutputStyles.ContainsKey($arg)) {
                    $script:Config.output_style = $arg
                    Save-SenseiConfig
                    Write-SenseiNote "response style set to $arg"
                } else {
                    Write-SenseiNote "unknown style '$arg' — choices: $(@($script:OutputStyles.Keys) -join ', ')"
                }
            } else {
                Write-SenseiNote "current style: $($script:Config.output_style) | choices: $(@($script:OutputStyles.Keys) -join ', ')"
            }
        }
        '/color' {
            if ($arg) {
                if (Set-SenseiAccent $arg) {
                    $script:Config.accent = $arg.ToLower()
                    Save-SenseiConfig
                    Write-Host "$($script:Theme.Accent)accent color set to $($script:Config.accent)$($script:Theme.Reset)"
                } else {
                    Write-SenseiNote "unknown color '$arg' — presets: $(@($script:AccentPresets.Keys) -join ', ') or a #RRGGBB hex"
                }
            } else {
                Write-SenseiNote "current accent: $($script:Config.accent) | presets: $(@($script:AccentPresets.Keys) -join ', ') or #RRGGBB"
            }
        }
        '/model' {
            $modeTag = if ($script:LocalMode) { ' (local · ollama)' } else { '' }
            if ($arg) {
                Set-ActiveModel $arg
                Write-SenseiNote "model set to $(Get-ActiveModel)$modeTag"
            } else {
                Write-SenseiNote "current model: $(Get-ActiveModel)$modeTag"
            }
        }
        '/config' {
            $show = @{} + $script:Config
            if ($show.api_key) { $show.api_key = '(saved in config.json)' }
            Write-Host (ConvertTo-Json -InputObject $show -Depth 5)
            $keySource = if ($script:LocalMode) { 'not needed (local mode)' }
                         elseif ($env:OPENAI_API_KEY) { 'OPENAI_API_KEY env var' }
                         elseif ($script:Config.api_key) { 'config.json' }
                         else { 'none' }
            $mode = if ($script:LocalMode) { "local · ollama at $($script:Config.local_base_url)" } else { 'openai' }
            Write-SenseiNote "mode: $mode | api key source: $keySource | config file: $script:ConfigPath"
            if ($script:ProjectConfig.Count -gt 0) { Write-SenseiNote "project config: $(Join-Path (Get-Location).Path '.sensei.json')" }
        }
        '/mcp' { Show-McpStatus }
        '/permissions' {
            $rules = Get-SenseiAllowRules
            if ($rules.Count -eq 0) {
                Write-SenseiNote 'no allowlist rules — add "permissions": {"allow": ["run_powershell(git *)"]} to config, or answer [p] at a permission prompt'
            } else {
                foreach ($r in $rules) { Write-Host "  $($r.Rule)  $($script:Theme.Dim)($($r.Source))$($script:Theme.Reset)" }
            }
            if ($script:SessionAllowed.Count -gt 0) {
                Write-SenseiNote "session-allowed: $(@($script:SessionAllowed) -join ', ')"
            }
        }
        '/tasks' {
            if ($script:BackgroundTasks.Count -eq 0) { Write-SenseiNote 'no background tasks' }
            foreach ($T in $script:BackgroundTasks.Values) {
                $status = if ($T.Process.HasExited) { "exited $($T.Process.ExitCode)" } else { 'running' }
                $runtime = [int]((Get-Date) - $T.Started).TotalSeconds
                Write-Host "  $($T.Id)  $status  ${runtime}s  $($script:Theme.Dim)$(Protect-TerminalText $T.Command)$($script:Theme.Reset)"
            }
        }
        '/skills' {
            $skills = @(Get-SenseiSkills)
            if ($skills.Count -eq 0) {
                Write-SenseiNote 'no skills — create one with /newskill <name> [purpose], or drop a SKILL.md in .sensei\skills\<name>\ (project) or ~/.sensei/skills/<name>/ (global)'
            }
            foreach ($s in $skills) {
                Write-Host "  /$($s.Name) — $($s.Description) $($script:Theme.Dim)($($s.Source))$($script:Theme.Reset)"
            }
        }
        '/newskill' {
            if (-not $arg) {
                Write-SenseiNote 'usage: /newskill <name> [what it should do]'
            } else {
                $nsParts = $arg.Split(' ', 2)
                $nsName = $nsParts[0]
                $nsDesc = if ($nsParts.Count -gt 1 -and $nsParts[1].Trim()) { $nsParts[1].Trim() } else { 'decide from the name' }
                $prompt = $script:NewSkillPrompt -replace '<NAME>', $nsName -replace '<DESC>', $nsDesc
                try { Invoke-AgentTurn $prompt }
                catch [System.OperationCanceledException] { Write-SenseiNote '(aborted)' }
            }
        }
        '/todos' { Write-SenseiTodos }
        '/cost' {
            Write-SenseiNote (Get-SenseiCostLine)
            Write-SenseiNote '(cost is an estimate from a static price table; override via "prices" in config)'
        }
        '/memory' {
            $mem = Get-SenseiMemory
            if ($mem.Count -eq 0) { Write-SenseiNote 'no SENSEI.md loaded — /init creates one for this directory' }
            foreach ($m in $mem) { Write-Host "  $($m.Path)  $($script:Theme.Dim)($($m.Content.Length) chars)$($script:Theme.Reset)" }
        }
        '/init' {
            try { Invoke-AgentTurn $script:InitPrompt }
            catch [System.OperationCanceledException] { Write-SenseiNote '(aborted)' }
        }
        '/investigate' {
            $target = $arg
            if (-not $target) {
                $newest = Get-ChildItem -LiteralPath (Get-Location).Path -Filter '*.log' -File |
                    Sort-Object LastWriteTime -Descending | Select-Object -First 1
                if ($newest) {
                    $target = $newest.FullName
                    Write-SenseiNote "no path given — using newest .log in cwd: $($newest.Name)"
                } else {
                    Write-SenseiNote 'usage: /investigate <path-to-log> (no *.log files found in the current directory)'
                    break
                }
            }
            try { Invoke-AgentTurn ($script:InvestigatePrompt -replace '<PATH>', $target) }
            catch [System.OperationCanceledException] { Write-SenseiNote '(aborted)' }
        }
        '/resume' {
            Save-SenseiSession
            Show-ResumePicker
        }
        '/exit' { return $false }
        '/quit' { return $false }
        default {
            $name = $cmd.TrimStart('/')
            $path = Find-SenseiCustomCommand $name
            $skill = if (-not $path) { @(Get-SenseiSkills) | Where-Object { $_.Name -eq $name } | Select-Object -First 1 } else { $null }
            if ($path) {
                $prompt = (Get-Content -LiteralPath $path -Raw) -replace '\$ARGUMENTS', $arg
                Write-SenseiNote "(custom command: $path)"
                try { Invoke-AgentTurn $prompt }
                catch [System.OperationCanceledException] { Write-SenseiNote '(aborted)' }
            } elseif ($skill) {
                Write-SenseiNote "(skill: $($skill.Path))"
                try { Invoke-AgentTurn (Get-SenseiSkillPrompt -Skill $skill -Arguments $arg) }
                catch [System.OperationCanceledException] { Write-SenseiNote '(aborted)' }
            } else {
                Write-SenseiNote "unknown command $($parts[0]) — try /help"
            }
        }
    }
    return $true
}
