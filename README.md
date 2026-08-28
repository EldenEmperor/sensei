# sensei

A terminal AI agent for debugging logs, written in PowerShell 7 — a Claude Code-style agent powered by the OpenAI API or a local Ollama model. Full agentic tooling (read/write/edit/glob/grep/run, subagents, background tasks, MCP servers) plus two log-specific tools (`log_stats`, `log_slice`) that let the model analyze huge log files without drowning in tokens.

> **Two implementations.** The PowerShell variant documented below is the stable reference, now **frozen to bugfixes** — new work happens in the TypeScript port in [`ts/`](./ts/), which has the engine, all log tools (byte-identical output, cross-checked), a headless mode (`-p` + `--continue` + JSON output, plus an importable `SenseiAgent` API), and an Ink terminal UI. Both share `~/.sensei`. Feature status: [`ts/PARITY.md`](./ts/PARITY.md).

```
   ██          ██
    ██        ██
     ██      ██
   ██████████████       sensei — log-debugging agent
  ████████████████
  ████  ████  ████
  ████████████████
   ██  ██  ██  ██
    ████████████
```

## Setup

1. `winget install --id Microsoft.PowerShell -e` (PowerShell 7)
2. Run `sensei.cmd` (or `pwsh -File sensei.ps1`). First run asks for your OpenAI API key and offers to persist it, and to add the folder to your PATH so `sensei` works from any shell. Or skip the key entirely with `--local` (uses Ollama at `localhost:11434`, default model `qwen3:14b`).

## Usage

```
sensei [--local] [--model <name>] [--yolo] [--resume] [--plan] [--investigate <path>] [-p <prompt>]
```

- `--local` — local Ollama model instead of OpenAI (no API key)
- `--model` — override the model for this session
- `--yolo` — skip all permission prompts
- `--resume` — pick a previous session to continue
- `--plan` — start in plan mode: read-only until you approve a plan
- `--investigate <path>` — deep-map the log's structure on startup, then continue interactively
- `-p "prompt"` — print mode: one non-interactive turn, answer to stdout (read-only + allowlisted tools only)

Ask things like: `summarize what's wrong with tests\app.log` · `what happened right before the crash at 02:47?` · `tail the service log while I reproduce this` (`@file` references inline a file into your message).

## Slash commands

`/help` `/clear` `/compact` `/plan` `/style` `/color` `/model` `/config` `/mcp` `/permissions` `/skills` `/newskill` `/tasks` `/todos` `/cost` `/memory` `/init` `/investigate` `/resume` `/exit` — plus custom commands: drop a markdown file in `.sensei\commands\name.md` (project) or `~/.sensei/commands/` (global), `$ARGUMENTS` is substituted, and `/name args` submits it as a prompt.

## Skills

Packaged instruction sets the **model discovers on its own** (unlike custom commands, which only you can trigger). A skill is a folder with a `SKILL.md`:

```
.sensei\skills\<name>\SKILL.md      (project)    ~/.sensei/skills/<name>/SKILL.md      (global)
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

`read_file` `write_file` `edit_file` `multi_edit` (several atomic edits to one file) `glob` `grep` `run_powershell` (foreground or `run_in_background` → `task_output`/`kill_task`) `task` / `task_parallel` (subagents with their own context; up to 3 concurrent) `verify` (independent check via a fresh subagent) `todo_write` `web_search` (find sources) `web_fetch` (read a page + its links) `web_browser` (render JS pages via headless Edge/Chrome) `skill` (loads packaged skills) `exit_plan_mode` `log_slice` `log_stats` `log_timeline` `log_trace` `log_search` `log_baseline` `log_investigate` — and every tool exposed by configured MCP servers as `mcp__<server>__<tool>`.

### Log-debugging tools (Sensei's edge)

- **`log_stats`** — one-pass profile: level counts, time range, error-frequency-over-time, top error templates. Always called first.
- **`log_slice`** — tail/head/line-range/time-range of a huge file, streamed, never loaded whole.
- **`log_timeline`** — merge 2+ logs into one timestamp-ordered view, each line tagged by source. "What did every service say at the moment of the crash?"
- **`log_trace`** — follow a request/correlation id across all logs, in order.
- **`log_search`** — *semantic* search over a log's error templates via your local Ollama embedding model (`--local`). Find by meaning ("memory pressure") when you don't know the exact wording. No cloud tool can search your logs on your own GPU.
- **`log_baseline`** — `save` a known-good log's profile, then `diff` a later run to surface new error templates and count spikes. "What changed since the last good run?"
- **`log_investigate`** — deep structural analysis of ANY unknown log: format family (json-lines, logfmt, csv/tsv, apache/w3c access, timestamped text…), timestamp styles with coverage, level vocabulary (including non-standard terms like SEVERE/CRIT), field types and cardinality, repeated templates, rare/unique events, and multi-line block behavior. The result is a **format map** cached in `~/.sensei/formats/` (auto-refreshed when the file changes) that the other log tools transparently consume — after one investigate, `log_slice`/`log_stats`/`log_timeline`/`log_trace` can read epoch timestamps, JSON timestamp fields, and extended level vocabularies they'd otherwise miss. Trigger it yourself with `/investigate [path]` (defaults to the newest `.log` in the cwd) or start a session with `--investigate <path>`.

Read-only tools run without prompting; anything that writes or executes asks `[y]es/[n]o/[a]lways this session/[p]ersist to allowlist`, with a colored diff preview for edits. Ctrl+C aborts the in-flight request, not the app. Input has history and editing via PSReadLine; responses stream token-by-token.

## Web

Sensei can reach the web with no API key (works in `--local` too):

- **`web_search`** — DuckDuckGo results (title / URL / snippet) to *find* sources.
- **`web_fetch`** — read an http(s) page as clean text (HTML stripped, JSON pretty-printed) with the links on the page listed so it can follow onward.
- **`web_browser`** — render a JavaScript-heavy page in headless Edge/Chrome (auto-detected on Windows) and read the resulting text; optional `screenshot=true` saves a PNG for you to open.

## Theme

`/color [indigo|jade|gold|teal|red|#RRGGBB]` sets the accent (default **indigo**); `/style [default|concise|explanatory|teaching]` sets the response style. Both persist to config.

## MCP servers

Sensei is an MCP client (stdio transport). Configure in `~/.sensei/config.json` or a project `.sensei.json`:

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\logs"] }
  }
}
```

`/mcp` shows status; server stderr lands in `~/.sensei/logs/mcp-<name>.log`.

## Config

`~/.sensei/config.json` — model, local_model/local_base_url, max_output_tokens, stream, theme, save_sessions, context_char_budget, mcp_call_timeout, mcpServers, permissions.allow, hooks, prices, auto_continue. A project `.sensei.json` in the working directory adds `mcpServers`, `permissions.allow`, and `hooks`.

- **Allowlist rules**: `"permissions": {"allow": ["run_powershell(git *)", "mcp__github__*", "write_file(C:\\logs\\*)"]}` — matched tools skip the prompt.
- **Hooks**: `"hooks": [{"event": "PreToolUse", "matcher": "run_powershell", "command": "..."}]` — the command gets a JSON payload on stdin; exit 2 on PreToolUse/UserPromptSubmit blocks. Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop.
- **Memory**: `SENSEI.md` in `~/.sensei/` and/or the working directory is loaded into the system prompt; `/init` writes one for the current directory.
- **Context**: past ~80% of budget the conversation is auto-compacted (summarized by the model); `/compact` does it on demand.
- **Autonomy**: Sensei is prompted to act rather than instruct — it runs commands itself, iterates on failures (reads exit codes/stderr, tries different approaches), and, since it cannot elevate (no UAC), prefers user-scoped installs (`winget --scope user`, `pip --user`, `-Scope CurrentUser`), asking you to run an elevated command only as a last resort. If a model still answers with a "Step 1 / Step 2" tutorial instead of acting, `auto_continue` (default `true`) nudges it once per turn to do the work itself — set it to `false` to disable.

Session transcripts land in `~/.sensei/sessions/`; `--resume` / `/resume` continues one.

## Tests

```
pwsh -NoProfile -File tests\smoke.ps1     # offline, no API key needed (~50 assertions)
```

Covers all tool handlers against a generated 200k-line log with a planted failure story, the SSE stream parser (fixture), allowlist matching, hooks, resume round-trips, background tasks, the agent loop/subagents/compaction against a stubbed API, and a full MCP handshake against `tests\mock-mcp-server.ps1`.
