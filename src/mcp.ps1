# mcp.ps1 — Model Context Protocol client, stdio transport.
# Servers are configured under "mcpServers" in ~/.sensei/config.json or .sensei.json:
#   "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\logs"], "env": {} } }
# Their tools register as mcp__<server>__<tool> and dispatch through JSON-RPC
# (newline-delimited JSON over the child's stdin/stdout — no Content-Length framing).

$script:McpServers = [ordered]@{}

function Get-McpLogPath { param([string]$Name) Join-Path $script:ConfigDir "logs\mcp-$Name.log" }

function Start-SenseiMcpServers {
    $servers = Get-SenseiMcpServers
    if (-not $servers -or $servers.Count -eq 0) { return }
    foreach ($name in @($servers.Keys)) {
        $cfg = $servers[$name]
        try {
            Connect-McpServer -Name $name -Config $cfg
            $s = $script:McpServers[$name]
            if (-not $script:PrintMode) {
                Write-SenseiNote "mcp: $name connected ($(@($s.Tools).Count) tools)"
            }
        } catch {
            if ($script:McpServers.Contains($name)) {
                $script:McpServers[$name].Status = 'failed'
                $script:McpServers[$name].Error = $_.Exception.Message
                try {
                    $proc = $script:McpServers[$name].Process
                    if ($proc -and -not $proc.HasExited) { $proc.Kill($true) }
                } catch { }
            } else {
                $script:McpServers[$name] = @{ Name = $name; Status = 'failed'; Error = $_.Exception.Message; Config = $cfg; Tools = @() }
            }
            Write-SenseiNote "mcp: $name failed — $($_.Exception.Message) (log: $(Get-McpLogPath $name))"
        }
    }
}

function Connect-McpServer {
    param([string]$Name, $Config)
    $logDir = Join-Path $script:ConfigDir 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

    $cmdName = [string]$Config.command
    $cmdInfo = Get-Command $cmdName -ErrorAction Stop
    $exe = $cmdInfo.Source
    if (-not $exe) { $exe = $cmdName }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    if ($exe -match '\.(cmd|bat)$') {
        # npx & friends are .cmd shims on Windows — Process.Start can't run them directly
        $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
        foreach ($x in @('/d', '/c', $exe) + @($Config.args)) { $psi.ArgumentList.Add([string]$x) }
    } else {
        $psi.FileName = $exe
        foreach ($x in @($Config.args)) { $psi.ArgumentList.Add([string]$x) }
    }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    # BOM-less UTF-8 on stdin is critical: a BOM corrupts the server's first JSON parse
    $psi.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    $psi.WorkingDirectory = (Get-Location).Path
    if ($Config.env) {
        foreach ($k in $Config.env.Keys) { $psi.Environment[[string]$k] = [string]$Config.env[$k] }
    }

    $p = [System.Diagnostics.Process]::Start($psi)
    # stderr must be actively drained or a chatty server stalls on a full 4KB pipe
    $stderrStream = [System.IO.FileStream]::new((Get-McpLogPath $Name), [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $stderrTask = $p.StandardError.BaseStream.CopyToAsync($stderrStream)
    $writer = $p.StandardInput
    $writer.AutoFlush = $true

    $s = @{
        Name = $Name; Process = $p; Writer = $writer; Reader = $p.StandardOutput
        PendingRead = $null; NextId = 0; Tools = @(); Status = 'connecting'
        NameMap = @{}; StderrTask = $stderrTask; StderrStream = $stderrStream
        Config = $Config; Error = $null
    }
    $script:McpServers[$Name] = $s

    [void](Send-McpRequest -Server $s -Method 'initialize' -Params @{
        protocolVersion = '2025-06-18'
        capabilities    = @{}
        clientInfo      = @{ name = 'sensei'; version = [string]$script:SenseiVersion }
    } -TimeoutSec 15)
    Send-McpNotification -Server $s -Method 'notifications/initialized'

    $tools = @()
    $cursor = $null
    do {
        $params = if ($cursor) { @{ cursor = $cursor } } else { @{} }
        $lr = Send-McpRequest -Server $s -Method 'tools/list' -Params $params -TimeoutSec 15
        $tools += @($lr.tools)
        $cursor = $lr.nextCursor
    } while ($cursor)
    $s.Tools = $tools
    $s.Status = 'connected'
    Register-McpTools -Server $s
}

function Send-McpRawMessage {
    param([hashtable]$Server, [hashtable]$Message)
    $json = ConvertTo-Json -InputObject $Message -Depth 30 -Compress
    $Server.Writer.WriteLine($json)
}

function Send-McpNotification {
    param([hashtable]$Server, [string]$Method, [hashtable]$Params)
    $m = @{ jsonrpc = '2.0'; method = $Method }
    if ($Params) { $m.params = $Params }
    Send-McpRawMessage -Server $Server -Message $m
}

function Send-McpRequest {
    # Synchronous request/response with id correlation. Tolerates interleaved
    # server notifications and answers server-initiated ping requests.
    param(
        [hashtable]$Server,
        [string]$Method,
        [hashtable]$Params,
        [int]$TimeoutSec = 30,
        [switch]$Cancellable
    )
    $Server.NextId++
    $id = $Server.NextId
    $req = @{ jsonrpc = '2.0'; id = $id; method = $Method }
    if ($null -ne $Params) { $req.params = $Params }
    Send-McpRawMessage -Server $Server -Message $req

    $canKeys = $Cancellable -and -not [Console]::IsInputRedirected
    $canSpin = $Cancellable -and -not [Console]::IsOutputRedirected
    $frames = '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'
    $spinI = 0
    $prevCC = $null
    if ($canKeys) {
        while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
        $prevCC = [Console]::TreatControlCAsInput
        [Console]::TreatControlCAsInput = $true
    }
    try {
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $deadline) {
            if ($null -eq $Server.PendingRead) { $Server.PendingRead = $Server.Reader.ReadLineAsync() }
            $done = $false
            try { $done = $Server.PendingRead.Wait(50) } catch { $done = $true }
            if (-not $done) {
                if ($canKeys) {
                    while ([Console]::KeyAvailable) {
                        $k = [Console]::ReadKey($true)
                        if (($k.Key -eq 'C' -and ($k.Modifiers -band [ConsoleModifiers]::Control)) -or $k.Key -eq 'Escape') {
                            throw [System.OperationCanceledException]::new('aborted by user')
                        }
                    }
                }
                if ($canSpin) {
                    Write-Host -NoNewline "`r$($script:Theme.Accent)$($frames[$spinI % $frames.Count]) mcp:$($Server.Name) $Method…$($script:Theme.Reset)"
                    $spinI++
                }
                continue
            }
            $line = $null
            try { $line = $Server.PendingRead.GetAwaiter().GetResult() } catch { $line = $null }
            $Server.PendingRead = $null
            if ($null -eq $line) {
                $Server.Status = 'failed'
                throw "MCP server '$($Server.Name)' closed its output (crashed? see $(Get-McpLogPath $Server.Name))"
            }
            if (-not $line.Trim()) { continue }
            $msg = $null
            try { $msg = $line | ConvertFrom-Json -AsHashtable } catch { continue }
            if (-not ($msg -is [hashtable])) { continue }

            if ($msg.ContainsKey('id') -and $null -ne $msg.id -and -not $msg.ContainsKey('method')) {
                # a response — servers echo ids as number OR string, so compare as strings
                if ([string]$msg.id -eq [string]$id) {
                    if ($msg.ContainsKey('error') -and $msg.error) {
                        throw "MCP error $($msg.error.code): $($msg.error.message)"
                    }
                    return $msg.result
                }
                continue   # stale response to an abandoned request
            }
            if ($msg.ContainsKey('method') -and $msg.ContainsKey('id')) {
                # server-initiated request — we declared no capabilities, so only ping is answerable
                if ([string]$msg.method -eq 'ping') {
                    Send-McpRawMessage -Server $Server -Message @{ jsonrpc = '2.0'; id = $msg.id; result = @{} }
                } else {
                    Send-McpRawMessage -Server $Server -Message @{ jsonrpc = '2.0'; id = $msg.id; error = @{ code = -32601; message = 'method not supported' } }
                }
                continue
            }
            # notification — ignore
        }
        throw "MCP request '$Method' to '$($Server.Name)' timed out after ${TimeoutSec}s"
    } finally {
        if ($canSpin) { Write-Host -NoNewline ("`r" + (' ' * 40) + "`r") }
        if ($null -ne $prevCC) { [Console]::TreatControlCAsInput = $prevCC }
    }
}

function ConvertTo-SafeToolName {
    param([string]$Name)
    $safe = $Name -replace '[^a-zA-Z0-9_-]', '_'
    if ($safe.Length -gt 64) { $safe = $safe.Substring(0, 64) }
    return $safe
}

function Register-McpTools {
    param([hashtable]$Server)
    foreach ($tool in @($Server.Tools)) {
        $full = "mcp__$($Server.Name)__$($tool.name)"
        $safe = ConvertTo-SafeToolName $full
        $Server.NameMap[$safe] = [string]$tool.name
        $schema = $tool.inputSchema
        if ($schema -is [hashtable]) { $schema.Remove('$schema') }
        if (-not ($schema -is [hashtable]) -or [string]$schema.type -ne 'object') {
            $schema = @{ type = 'object'; properties = @{} }
        }
        Register-SenseiTool -Name $safe -Description ([string]$tool.description) `
            -Parameters $schema -ReadOnly $false -Handler { param($a) 'ERROR: MCP dispatch missing' }
        # dispatch metadata: agent routes these to Invoke-McpToolCall (no closure games)
        $script:ToolRegistry[$safe].McpServer = $Server.Name
        $script:ToolRegistry[$safe].McpTool = [string]$tool.name
    }
}

function Invoke-McpToolCall {
    param([string]$ServerName, [string]$ToolName, [hashtable]$Arguments)
    $s = $script:McpServers[$ServerName]
    if (-not $s -or $s.Status -ne 'connected') { return "ERROR: MCP server '$ServerName' is not connected" }
    if ($null -eq $Arguments) { $Arguments = @{} }
    $r = $null
    try {
        $r = Send-McpRequest -Server $s -Method 'tools/call' `
            -Params @{ name = $ToolName; arguments = $Arguments } `
            -TimeoutSec ([int]($script:Config.mcp_call_timeout ?? 120)) -Cancellable
    } catch [System.OperationCanceledException] {
        throw
    } catch {
        return "ERROR: $($_.Exception.Message)"
    }
    $parts = @()
    foreach ($c in @($r.content)) {
        if (-not $c) { continue }
        if ([string]$c.type -eq 'text') { $parts += [string]$c.text }
        else { $parts += "[$($c.type) content omitted]" }
    }
    $text = $parts -join "`n"
    if ($r.isError) { $text = "ERROR: $text" }
    if (-not $text) { $text = '(empty result)' }
    return $text
}

function Stop-SenseiMcpServers {
    foreach ($s in @($script:McpServers.Values)) {
        if (-not $s.Process) { continue }
        try { $s.Writer.Dispose() } catch { }                     # closing stdin = MCP shutdown signal
        try {
            if (-not $s.Process.WaitForExit(2000)) { $s.Process.Kill($true) }   # tree: real server is a grandchild via cmd/npx
        } catch { }
        try { $s.Reader.Dispose() } catch { }
        try { $s.StderrStream.Dispose() } catch { }
        try { $s.Process.Dispose() } catch { }
    }
}

function Show-McpStatus {
    if ($script:McpServers.Count -eq 0) {
        Write-SenseiNote 'no MCP servers configured — add "mcpServers" to ~/.sensei/config.json or .sensei.json:'
        Write-SenseiNote '  "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\logs"] } }'
        return
    }
    foreach ($s in $script:McpServers.Values) {
        if ($s.Status -eq 'connected') {
            Write-Host "  $($script:Theme.Ok)●$($script:Theme.Reset) $($s.Name) — connected, pid $($s.Process.Id), $(@($s.Tools).Count) tools"
            foreach ($tool in @($s.Tools)) {
                $desc = [string]$tool.description -replace '\r?\n.*', ''
                if ($desc.Length -gt 70) { $desc = $desc.Substring(0, 67) + '…' }
                Write-SenseiNote "     mcp__$($s.Name)__$($tool.name) — $desc"
            }
        } else {
            Write-Host "  $($script:Theme.Err)●$($script:Theme.Reset) $($s.Name) — failed: $($s.Error)"
            Write-SenseiNote "     log: $(Get-McpLogPath $s.Name)"
        }
    }
}
