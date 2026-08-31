# Getting started

## Requirements

- Node.js ≥ 22
- Windows, macOS, or Linux (the shell tool is `run_powershell`/pwsh on Windows, `bash` on POSIX)
- One of: an Anthropic API key, an OpenAI API key, a company LLM gateway token, or a local
  [Ollama](https://ollama.com) install (no key needed)

## Install

One command after cloning:

```
git clone https://github.com/jayupadhyay451/sensei.git && cd sensei
npm run setup
```

The setup script:

1. checks Node ≥ 22,
2. runs `npm install` and builds,
3. links the global `sensei` command onto your PATH,
4. runs the offline test suite (no key or network needed — the 14 MB test log fixture is
   generated locally on first run),
5. interactively asks which provider you use and writes your choice into
   `~/.sensei/config.json`.

`npm run setup -- --yes` skips the interactive part. Re-running merges into your existing
config instead of clobbering it. After changing the source later, `npm run build` alone
refreshes the linked command.

## Set your API key

Keys live in environment variables (recommended) — sensei never needs them in a file:

```powershell
# PowerShell — this shell only:
$env:ANTHROPIC_API_KEY = "sk-ant-..."
# permanently (takes effect in NEW terminals):
setx ANTHROPIC_API_KEY "sk-ant-..."
```

```bash
# bash / zsh — add to ~/.bashrc or ~/.zshrc to persist:
export ANTHROPIC_API_KEY="sk-ant-..."
```

`OPENAI_API_KEY` works the same way for GPT models. For a company gateway token, see
[Providers](providers.md) — you name the env var yourself.

## First run

```
sensei                                    # interactive TUI in the current directory
sensei --model claude-opus-5              # pick a model; claude-* selects the Anthropic API
sensei "why did the 02:47 crash happen?"  # one-shot headless run
sensei --local                            # local Ollama, no key
```

Make your model the default so plain `sensei` does the right thing — either run
`/model claude-opus-5` once in the TUI (persists to config), or set it in
`~/.sensei/config.json`:

```jsonc
{ "model": "claude-opus-5" }   // provider inferred: claude-* → anthropic
```

## A typical session

```
cd path\to\your\logs
sensei
```

Then just ask: *"the service crashed around 02:47 — what happened?"* Sensei calls
`log_stats` first (level counts, time range, top error templates), drills in with
`log_slice`/`grep`, and cites evidence as `path:line`. Attach a file to any prompt with
`@app.log` (Tab completes paths).

Useful first commands:

- `/help` — every command, key binding, and custom command; `/<command> --help` for details
- `/model`, `/provider` — what you're talking to
- `/plan fix the parser` — plan mode: read-only research first, then an approval prompt
- `/init` — sensei explores the directory and writes a `SENSEI.md` memory file for future
  sessions

## Where things live

| Path | Purpose |
|---|---|
| `~/.sensei/config.json` | user config ([reference](configuration.md)) |
| `.sensei.json` (project root) | per-project config: MCP servers, permissions, hooks |
| `.sensei/commands/`, `.sensei/skills/`, `.sensei/agents/` | project [customization](customization.md) |
| `SENSEI.md` | project memory, loaded into the system prompt |
| `~/.sensei/sessions/` | saved sessions (`--continue`, `/resume`) |
| `~/.sensei/logs/` | MCP server stderr logs |
