# mock-mcp-server.ps1 — minimal NDJSON MCP server for smoke tests.
# Speaks JSON-RPC 2.0 over stdin/stdout, exposes one tool: echo.
# Deliberately emits an interleaved notification before the tools/list reply
# to exercise the client's correlation loop.

$in = [Console]::In
$out = [Console]::Out

function Send-Reply {
    param($Id, $Result)
    $m = @{ jsonrpc = '2.0'; id = $Id; result = $Result }
    $out.WriteLine((ConvertTo-Json -InputObject $m -Depth 20 -Compress))
    $out.Flush()
}

while ($null -ne ($line = $in.ReadLine())) {
    if (-not $line.Trim()) { continue }
    try { $m = $line | ConvertFrom-Json -AsHashtable } catch { continue }
    switch ([string]$m.method) {
        'initialize' {
            Send-Reply $m.id @{
                protocolVersion = '2025-06-18'
                capabilities    = @{ tools = @{} }
                serverInfo      = @{ name = 'mock'; version = '1.0' }
            }
        }
        'notifications/initialized' { }
        'tools/list' {
            $out.WriteLine('{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"interleaved noise"}}')
            $out.Flush()
            Send-Reply $m.id @{
                tools = @(@{
                    name        = 'echo'
                    description = 'Echo the text back'
                    inputSchema = @{ type = 'object'; properties = @{ text = @{ type = 'string' } }; required = @('text') }
                })
            }
        }
        'tools/call' {
            Send-Reply $m.id @{ content = @(@{ type = 'text'; text = [string]$m.params.arguments.text }) }
        }
        'ping' { Send-Reply $m.id @{} }
        default {
            if ($m.ContainsKey('id')) {
                $err = @{ jsonrpc = '2.0'; id = $m.id; error = @{ code = -32601; message = 'not supported' } }
                $out.WriteLine((ConvertTo-Json -InputObject $err -Depth 5 -Compress))
                $out.Flush()
            }
        }
    }
}
