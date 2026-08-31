# MCP servers

Sensei connects to [Model Context Protocol](https://modelcontextprotocol.io) servers and
registers every tool they expose as `mcp__<server>__<tool>`, available to the model like
any built-in tool.

## Configuration

MCP servers go under `"mcpServers"` in `~/.sensei/config.json` (all projects) or
`.sensei.json` in your project root (that project only; project entries win on name
collisions). Two transport kinds:

### Local servers (stdio)

Sensei spawns the process and speaks MCP over stdin/stdout:

```jsonc
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\logs"],
      "env": { "SOME_VAR": "value" }          // merged over your environment
    }
  }
}
```

### Remote servers (streamable HTTP)

Point at an HTTP endpoint; `headers` carry auth (tokens, gateway headers):

```jsonc
{
  "mcpServers": {
    "corp": {
      "url": "https://mcp.corp.example/v1",
      "headers": { "authorization": "Bearer ${TOKEN goes here}" }
    }
  }
}
```

An entry needs either `command` (stdio) or `url` (HTTP). `url` wins if both are present.

## Using MCP tools

- Servers connect at startup; `/mcp` in the TUI shows each server's status and tool list.
- Tools appear to the model as `mcp__<server>__<tool>` (names sanitized to
  `[A-Za-z0-9_-]`, max 64 chars).
- Every MCP tool is treated as a **write-capable** tool, so it goes through the
  permission gate. Allow or deny it like any tool:

  ```jsonc
  { "permissions": { "allow": ["mcp__fs__*", "mcp__github__get_issue(123)"] } }
  ```

  The first *string* property of the tool's input schema is its rule-matchable argument,
  so `tool(pattern)` rules can match values, not just names.

## Timeouts and logs

- Per-call timeout: `"mcp_call_timeout"` in config (seconds, default 120).
- Local server stderr streams to `~/.sensei/logs/mcp-<name>.log` — the first place to
  look when a server fails to connect (`/mcp` shows the failure reason and the log path).

## Troubleshooting

| Symptom | Check |
|---|---|
| `mcp: <name> failed — ...` at startup | the log file; is the `command` on PATH? does `npx -y <pkg>` work standalone? |
| Tool calls hang then error | raise `mcp_call_timeout`; slow servers (first `npx` download) can exceed 120s |
| Remote server 401/403 | the `headers` entry — tokens are sent verbatim, no substitution |
| Tools missing from `/mcp` | the server connected but returned none — check its own configuration |
| Permission prompt on every call | add an allow rule (`mcp__<server>__*`), or press `a` (always this session) / `p` (persist) at the prompt |
