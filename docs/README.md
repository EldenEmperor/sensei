# Sensei documentation

Sensei is a Claude Code-style terminal AI agent (TypeScript/Node + Ink) specialized in
debugging logs, powered by the Anthropic API, the OpenAI API, a company LLM gateway, or a
local Ollama model.

| Guide | What it covers |
|---|---|
| [Getting started](getting-started.md) | Install, `npm run setup`, API keys, your first session |
| [Providers](providers.md) | Anthropic / OpenAI / company gateways / Ollama, model selection, prompt caching, cost |
| [Interactive TUI](tui.md) | The composer, slash-command menu, plan mode, key bindings |
| [Headless CLI](headless.md) | One-shot runs, output formats, sessions, piping, scripting |
| [Permissions](permissions.md) | Permission modes, allow/deny rules, acceptEdits, plan mode |
| [MCP servers](mcp.md) | Connecting local (stdio) and remote (HTTP) MCP servers |
| [Hooks](hooks.md) | Running your own commands around agent events |
| [Customization](customization.md) | Custom slash commands, skills, custom subagents, SENSEI.md memory, statusline |
| [Log tools](log-tools.md) | The log-analysis tool family — sensei's edge |
| [Configuration reference](configuration.md) | Every key in `~/.sensei/config.json` and `.sensei.json` |

## Quick orientation

- **Config** lives in `~/.sensei/config.json` (user) and `.sensei.json` (per project).
- **Project extensions** live under `.sensei/` in your repo: `commands/`, `skills/`, `agents/`.
- **Memory** is `SENSEI.md` — global in `~/.sensei/`, per-project anywhere up the directory tree.
- **Sessions** are saved to `~/.sensei/sessions/` and resumed with `--continue` / `/resume`.
- In the TUI, type `/` to see every command; any command answers `--help` (e.g. `/mcp --help`).
