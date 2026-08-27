# kakuna

A terminal AI agent for debugging logs, written in PowerShell 7 — a Claude Code-style agent powered by the OpenAI API or a local Ollama model. Full agentic tooling (read/write/edit/glob/grep/run, subagents, background tasks, MCP servers) plus two log-specific tools (`log_stats`, `log_slice`) that let the model analyze huge log files without drowning in tokens.

```
             ▄▄▄▄▄
           ▄███████▄        kakuna — log-debugging agent
          ▄█████████▄
```

## Setup

1. `winget install --id Microsoft.PowerShell -e` (PowerShell 7)
2. Run `kakuna.cmd` (or `pwsh -File kakuna.ps1`). First run asks for your OpenAI API key and offers to persist it, and to add the folder to your PATH so `kakuna` works from any shell. Or skip the key entirely with `--local` (uses Ollama at `localhost:11434`, default model `qwen3:14b`).

## Usage

```
kakuna [--local] [--model <name>] [--yolo] [--resume] [-p <prompt>]
```

- `--local` — local Ollama model instead of OpenAI (no API key)
- `--model` — override the model for this session
- `--yolo` — skip all permission prompts
- `--resume` — pick a previous session to continue
- `-p "prompt"` — print mode: one non-interactive turn, answer to stdout (read-only + allowlisted tools only)

Ask things like: `summarize what's wrong with tests\app.log` · `what happened right before the crash at 02:47?` · `tail the service log while I reproduce this` (`@file` references inline a file into your message).

## Slash commands

`/help` `/clear` `/compact` `/model` `/config` `/mcp` `/permissions` `/skills` `/newskill` `/tasks` `/todos` `/cost` `/memory` `/init` `/resume` `/exit` — plus custom commands: drop a markdown file in `.kakuna\commands\name.md` (project) or `~/.kakuna/commands/` (global), `$ARGUMENTS` is substituted, and `/name args` submits it as a prompt.

## Skills

Packaged instruction sets the **model discovers on its own** (unlike custom commands, which only you can trigger). A skill is a folder with a `SKILL.md`:

```
.kakuna\skills\<name>\SKILL.md      (project)    ~/.kakuna/skills/<name>/SKILL.md      (global)
```

```markdown
---
name: triage
description: Standard triage procedure for production incidents. Use when asked to triage a log or incident.
---
1. Run log_stats on every log mentioned...
```

The `skill` tool's description lists every skill's name + description, so when a request matches, the model loads it and follows it. You can also invoke one directly as `/name args` (`$ARGUMENTS` substituted). Supporting files and scripts in the skill folder are fair game — the loaded skill tells the model where they live. `/skills` lists what's available; `/newskill <name> [purpose]` has the agent write one for you.

## Tools the model gets

`read_file` `write_file` `edit_file` `glob` `grep` `run_powershell` (foreground or `run_in_background` → `task_output`/`kill_task`) `task` (subagent with its own context) `todo_write` `web_fetch` `skill` (loads packaged skills) `log_slice` `log_stats` — and every tool exposed by configured MCP servers as `mcp__<server>__<tool>`.

Read-only tools run without prompting; anything that writes or executes asks `[y]es/[n]o/[a]lways this session/[p]ersist to allowlist`, with a colored diff preview for edits. Ctrl+C aborts the in-flight request, not the app. Input has history and editing via PSReadLine; responses stream token-by-token.

## MCP servers

Kakuna is an MCP client (stdio transport). Configure in `~/.kakuna/config.json` or a project `.kakuna.json`:

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\logs"] }
  }
}
```

`/mcp` shows status; server stderr lands in `~/.kakuna/logs/mcp-<name>.log`.

## Config

`~/.kakuna/config.json` — model, local_model/local_base_url, max_output_tokens, stream, theme, save_sessions, context_char_budget, mcp_call_timeout, mcpServers, permissions.allow, hooks, prices. A project `.kakuna.json` in the working directory adds `mcpServers`, `permissions.allow`, and `hooks`.

- **Allowlist rules**: `"permissions": {"allow": ["run_powershell(git *)", "mcp__github__*", "write_file(C:\\logs\\*)"]}` — matched tools skip the prompt.
- **Hooks**: `"hooks": [{"event": "PreToolUse", "matcher": "run_powershell", "command": "..."}]` — the command gets a JSON payload on stdin; exit 2 on PreToolUse/UserPromptSubmit blocks. Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop.
- **Memory**: `KAKUNA.md` in `~/.kakuna/` and/or the working directory is loaded into the system prompt; `/init` writes one for the current directory.
- **Context**: past ~80% of budget the conversation is auto-compacted (summarized by the model); `/compact` does it on demand.

Session transcripts land in `~/.kakuna/sessions/`; `--resume` / `/resume` continues one.

## Tests

```
pwsh -NoProfile -File tests\smoke.ps1     # offline, no API key needed (~50 assertions)
```

Covers all tool handlers against a generated 200k-line log with a planted failure story, the SSE stream parser (fixture), allowlist matching, hooks, resume round-trips, background tasks, the agent loop/subagents/compaction against a stubbed API, and a full MCP handshake against `tests\mock-mcp-server.ps1`.
