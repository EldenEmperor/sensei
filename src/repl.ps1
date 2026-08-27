# repl.ps1 — the interactive loop and slash commands.

function Start-KakunaRepl {
    while ($true) {
        Write-Host -NoNewline "$($script:Theme.Accent)kakuna ❯ $($script:Theme.Reset)"
        $line = [Console]::ReadLine()
        if ($null -eq $line) { break }   # EOF (Ctrl+Z then Enter)
        $line = $line.Trim()
        if (-not $line) { continue }
        if ($line.StartsWith('/')) {
            if (-not (Invoke-SlashCommand $line)) { break }
            continue
        }
        Invoke-AgentTurn $line
        Write-Host ''
    }
}

function Invoke-SlashCommand {
    # Returns $false when the REPL should exit.
    param([string]$Line)
    $parts = $Line.Split(' ', 2)
    switch ($parts[0].ToLower()) {
        '/help' {
            Write-Host '  /help            show this help'
            Write-Host '  /clear           save + reset the conversation'
            Write-Host '  /model [name]    show or set the OpenAI model (setting persists to config)'
            Write-Host '  /config          show effective config and where the API key comes from'
            Write-Host '  /exit            quit (also /quit, or Ctrl+C)'
        }
        '/clear' {
            Save-KakunaSession
            $script:Messages.Clear()
            $script:Messages.Add(@{ role = 'system'; content = $script:SystemPrompt })
            $script:TotalPromptTokens = 0
            $script:TotalCompletionTokens = 0
            Write-KakunaNote 'conversation cleared'
        }
        '/model' {
            $modeTag = if ($script:LocalMode) { ' (local · ollama)' } else { '' }
            if ($parts.Count -gt 1 -and $parts[1].Trim()) {
                Set-ActiveModel $parts[1].Trim()
                Write-KakunaNote "model set to $(Get-ActiveModel)$modeTag"
            } else {
                Write-KakunaNote "current model: $(Get-ActiveModel)$modeTag"
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
            Write-KakunaNote "mode: $mode | api key source: $keySource | config file: $script:ConfigPath"
        }
        '/exit' { return $false }
        '/quit' { return $false }
        default { Write-KakunaNote "unknown command $($parts[0]) — try /help" }
    }
    return $true
}
