# kakuna

A terminal AI agent for debugging logs, written in PowerShell 7 and powered by the OpenAI API. Claude Code-style tooling (read/write/edit/glob/grep/run) plus two log-specific tools (`log_stats`, `log_slice`) that let the model analyze huge log files without drowning in tokens.

```
             ▄▄▄▄▄
           ▄███████▄        kakuna — log-debugging agent
          ▄█████████▄
```

## Setup

1. `winget install --id Microsoft.PowerShell -e` (PowerShell 7)
2. Run `kakuna.cmd` (or `pwsh -File kakuna.ps1`). First run asks for your OpenAI API key and offers to persist it, and to add the folder to your PATH so `kakuna` works from any shell.

## Usage

```
kakuna [--local] [--model <name>] [--yolo]
```

`--local` uses a local Ollama model (default `qwen3:14b`, OpenAI-compatible endpoint at `http://localhost:11434/v1`) instead of the OpenAI API — no API key needed. Configure via `local_model` / `local_base_url` in config, or `/model` while running in local mode.

Ask things like:

- `summarize what's wrong with tests\app.log`
- `what happened right before the crash at 02:47?`
- `how many distinct error types are in C:\logs\service.log and which is most frequent?`

Slash commands: `/help`, `/clear`, `/model [name]`, `/config`, `/exit`.

Read-only tools run without prompting; anything that writes or executes asks permission first (`--yolo` skips the prompts).

## Config

`~/.kakuna/config.json` — model, max_output_tokens, theme, save_sessions, context_char_budget. API key comes from `OPENAI_API_KEY` (preferred) or `config.api_key`. Session transcripts land in `~/.kakuna/sessions/`.

## Tests

```
pwsh -NoProfile -File tests\smoke.ps1     # offline, no API key needed
```

`tests\New-TestLog.ps1` generates a 200k-line synthetic log with a planted failure story (WARN ramp from 02:10 → OOM FATAL at 02:47:13 → retry-error cascade) for end-to-end testing.
