# Configuration reference

## Files

| File | Scope | Keys honored |
|---|---|---|
| `~/.sensei/config.json` | user (all projects) | everything below |
| `.sensei.json` (project root) | that project | `mcpServers`, `permissions`, `hooks`, `provider`, `providers` |

Project values are merged in addition to (MCP/hooks) or after (permissions rules) the
user config. Unknown keys in `config.json` are preserved on save. The TUI's `/config`
shows the effective result with keys masked.

## `~/.sensei/config.json` keys

| Key | Default | Meaning |
|---|---|---|
| `model` | `"gpt-5.1"` | active model for cloud providers (`claude-*` infers the Anthropic provider) |
| `provider` | *(absent)* | active provider name; absent = infer from the model ([Providers](providers.md)) |
| `providers` | *(absent)* | named endpoint definitions — wire, base_url, api_key_env, auth, headers, model, prompt_caching, stream_usage |
| `api_key` | `null` | literal key fallback for the built-in openai/anthropic providers (env vars win) |
| `local_model` | `"qwen3:14b"` | model for `--local` |
| `local_base_url` | `"http://localhost:11434/v1"` | Ollama endpoint |
| `max_output_tokens` | `8192` | per-response output cap |
| `stream` | `true` | stream responses in the TUI |
| `theme` | `true` | colors/sprites on or off |
| `accent` | `"indigo"` | accent color preset or `#RRGGBB` (`/color`) |
| `output_style` | `"default"` | response style: default \| concise \| explanatory \| teaching (`/style`) |
| `save_sessions` | `true` | save the transcript to `~/.sensei/sessions/` on exit |
| `context_char_budget` | `300000` | context size; past ~80% the conversation auto-compacts |
| `auto_continue` | `true` | nudge tutorial-style answers into action, once per turn |
| `auto_verify` | `false` | run an independent verifier subagent after file-modifying turns |
| `mcpServers` | `{}` | MCP servers ([guide](mcp.md)) |
| `mcp_call_timeout` | `120` | per-MCP-call timeout, seconds |
| `permissions` | `{"allow": []}` | `allow`, `deny`, `defaultMode` ([guide](permissions.md)) |
| `hooks` | `[]` | lifecycle hooks ([guide](hooks.md)) |
| `prices` | `{}` | per-model `[input, output]` $/1M overrides for the cost line |
| `embed_model` | `"nomic-embed-text"` | Ollama embedding model for `log_search` (local mode) |
| `statusline` | *(absent)* | command whose first stdout line replaces the TUI status bar ([guide](customization.md#statusline)) |

## A complete example

```jsonc
// ~/.sensei/config.json
{
  "model": "claude-opus-5",
  "provider": "company",
  "providers": {
    "company": {
      "wire": "anthropic",
      "base_url": "https://llm-gw.corp.example/anthropic",
      "api_key_env": "COMPANY_LLM_TOKEN",
      "headers": { "x-corp-project": "sensei" }
    }
  },
  "permissions": {
    "allow": ["run_powershell(git *)"],
    "deny": ["read_file(*secret*)"],
    "defaultMode": "acceptEdits"
  },
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\logs"] }
  },
  "hooks": [
    { "event": "SessionEnd", "command": "echo session done >> ~/.sensei/audit.log" }
  ],
  "prices": { "my-gateway-model": [5.0, 25.0] },
  "statusline": "node scripts/statusline.mjs"
}
```

```jsonc
// .sensei.json — checked into the project repo
{
  "permissions": { "allow": ["bash(npm test*)"] },
  "mcpServers": { "corp": { "url": "https://mcp.corp.example/v1", "headers": { "authorization": "Bearer ..." } } },
  "hooks": [ { "event": "PreToolUse", "matcher": "write_file", "command": "node hooks/guard.mjs" } ]
}
```

## Other locations

| Path | Contents |
|---|---|
| `~/.sensei/sessions/` | saved session envelopes (`--continue`, `/resume`) |
| `~/.sensei/formats/` | cached `log_investigate` format maps |
| `~/.sensei/logs/` | MCP server stderr logs |
| `~/.sensei/SENSEI.md` | global memory ([guide](customization.md#memory-senseimd)) |
| `.sensei/commands\|skills\|agents/` | project customization ([guide](customization.md)) |
