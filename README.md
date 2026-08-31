# sensei

A terminal AI agent for debugging logs — a Claude Code-style agent (TypeScript/Node + Ink) powered by the Anthropic API, the OpenAI API, a company LLM gateway, or a local Ollama model. Full agentic tooling (read/write/edit/glob/grep/run, subagents, background tasks, MCP servers, skills, hooks) plus a family of log-specific tools that let the model analyze huge log files without drowning in tokens — including `log_investigate`, which maps ANY unknown log format and teaches the other tools to read it.

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

> Originally implemented in PowerShell 7 and ported to TypeScript feature-by-feature ([PARITY.md](./PARITY.md)). The PS variant's final state lives at the git tag `ps-final`.

## Setup

One command after cloning:

```
git clone <repo> && cd sensei
npm run setup
```

The setup script checks Node ≥ 22, installs dependencies, builds, links the global
`sensei` command, runs the offline test suite, then interactively configures your
provider and model into `~/.sensei/config.json` (Anthropic / OpenAI / company gateway /
local Ollama). `npm run setup -- --yes` skips the interactive part. Re-running merges
into your existing config rather than clobbering it.

Manual equivalent:

```
npm install
npm test                        # offline test suite, no API key needed
npm run build && npm link       # `sensei` on your PATH
npm run dev -- --local          # or: interactive TUI against local Ollama, no link
```

Then launch from any directory — bare `sensei` opens the interactive TUI in that
directory, `sensei "prompt"` runs headless. After changing the source, `npm run build`
alone refreshes the linked command (the link points at this repo).

### Quick start with an API key

```powershell
# Claude models (Anthropic API) — model name alone selects the provider
$env:ANTHROPIC_API_KEY = "sk-ant-..."          # setx ANTHROPIC_API_KEY "sk-ant-..." to persist
sensei --model claude-opus-5                   # interactive TUI
sensei "summarize the errors in @app.log" --model claude-opus-5

# GPT models (OpenAI API) — the default provider
$env:OPENAI_API_KEY = "sk-..."
sensei                                          # uses config model (default gpt-5.1)

# bash / zsh
export ANTHROPIC_API_KEY="sk-ant-..."
sensei --model claude-opus-5
```

Persist your choice so plain `sensei` does the right thing: run `/model claude-opus-5`
once in the TUI (saves to `~/.sensei/config.json`), or set it there directly:

```jsonc
{ "model": "claude-opus-5" }                   // provider inferred: claude-* → anthropic
```

For a company token behind a gateway, add a `providers` entry (next section) and set
the token's env var — e.g. with `"api_key_env": "COMPANY_LLM_TOKEN"`:

```powershell
$env:COMPANY_LLM_TOKEN = "..."
sensei --provider company
```

Runs on Windows, macOS, and Linux (the shell tool is `run_powershell`/pwsh on Windows, `bash` on POSIX; hooks run in pwsh or sh respectively). Requires Node ≥ 22, plus one of:

- `ANTHROPIC_API_KEY` — Claude models (`--model claude-opus-5` auto-selects the Anthropic API)
- `OPENAI_API_KEY` — GPT models (the default)
- a company gateway/proxy — one `providers` entry in `~/.sensei/config.json` (see Providers below)
- a local [Ollama](https://ollama.com) (`--local`, default endpoint `localhost:11434`)

## Providers

The endpoint is picked by `--provider` → `--local` → config `provider` → inference from the
model name (`claude-*` → anthropic, else openai). Built-ins: `openai`, `anthropic`, `local`.
A company gateway is one config entry — `wire` says which protocol it speaks (a gateway can
serve claude models over the OpenAI wire, or the Anthropic wire at a custom path):

```jsonc
{
  "provider": "company",
  "providers": {
    "company": {
      "wire": "anthropic",                     // or "openai"
      "base_url": "https://llm-gw.corp.example/anthropic",
      "api_key_env": "COMPANY_LLM_TOKEN",      // env var checked first; or "api_key": "..."
      "auth": "bearer",                        // "x-api-key" (anthropic default) | "bearer"
      "headers": { "x-corp-project": "sensei" },
      "model": "claude-opus-5",                // optional per-provider model
      "prompt_caching": true                   // anthropic wire: cache_control breakpoints (default on)
    }
  }
}
```

`api_key: "none"` marks a keyless gateway (mTLS/VPN auth). On the anthropic wire, prompt
caching is on by default — repeat agent rounds re-read the cached prefix at ~0.1× input price,
and the cost line shows `(~Nk cached)`. `/provider` in the TUI lists/switches endpoints;
`/model` follows the active provider.

## Interactive usage (Ink TUI)

```
npm run dev -- [--provider <name>] [--local] [--model <name>] [--yolo] [--plan] [--continue [id]]
```

Streaming markdown answers, live tool-call lines, todo checklist, y/n/a/p permission prompts with diff previews, plan mode; Esc/Ctrl+C aborts the in-flight turn, Ctrl+D exits (saving the session). The composer has full cursor editing (←/→, Ctrl+A/E home/end, Ctrl+W/U word/line delete, Alt+←/→ words), multiline input (`\` then Enter), paste handling, history (↑/↓), Tab completion for /commands and `@file` paths, `!cmd` to run a shell command directly, Ctrl+O to toggle verbose tool output — and typing while sensei is busy queues the message for the next turn. Typing `/` opens a live command menu (built-ins, custom commands, and skills with their
descriptions) — type to filter, ↑/↓ to select, Tab to complete, Enter to run, Esc to
dismiss. Every command also takes `--help` (or `-h`) for its own usage — e.g.
`/permissions --help` explains the rule grammar; it works for custom commands and skills
too. `/help` lists everything: `/clear /compact /plan /style /color /model /provider
/config /mcp /permissions /skills /newskill /tasks /todos /cost /memory /init
/investigate /resume /exit` — plus custom commands and direct skill invocation as
`/<skillname>`.

`/plan` toggles plan mode; `/plan <task>` enters plan mode and starts planning that task
in one step. Sensei researches read-only, then presents the plan: `[y]` approve &
execute, `[a]` approve and auto-accept file edits for the rest of the session, `[n]`/Esc
keep planning.

Custom commands (`.sensei/commands/<name>.md`, project, or `~/.sensei/commands/`) support frontmatter — `description` and `argument-hint` (shown in /help), `allowed-tools` (comma list granted as allow rules for that turn) — with `$ARGUMENTS` and `$1..$n` substitution (double-quoted spans count as one argument). They also work headlessly: `sensei -p "/mycmd args"`. A `statusline` config key names a command whose first stdout line replaces the TUI status bar (JSON context on stdin, re-run each turn).

## Headless usage

```
npx tsx src/cli/main.ts -p "why did the 02:47 crash happen?" --file tests\app.log --local --yolo
sensei "why did the 02:47 crash happen?"        # bare positional prompt
git log --oneline -20 | sensei "what shipped this week?"   # or pipe the prompt/context on stdin
```

- `--output-format json` — one machine-readable object on stdout (`session_id`, `result`, `usage`, `permission_denials`, `error`); progress on stderr. `stream-json` emits NDJSON agent events.
- `--continue [id]` — continue a saved conversation across invocations (bare `--continue` picks the latest session for this directory, or starts one).
- `--yolo` / `--allow "tool(pattern)"` — headless permission policy; without either, write/execute tools fail closed.
- `--investigate <path>` — deep-map a log's structure via the built-in prompt.

Exit codes: 0 success · 1 turn error · 2 usage error.

## Embedding API

```js
import { ConfigStore, SenseiAgent } from './src/index.js';

const store = new ConfigStore();
store.load();
const agent = new SenseiAgent({
  configStore: store,
  host: { onEvent: console.log, requestPermission: async () => ({ allow: false, reason: 'non-interactive' }), requestPlanApproval: async () => false },
  permissionPolicy: { mode: 'yolo' },
  local: true,
});
const r = await agent.ask('read x.log and summarize the errors');
```

See `examples/drive-spawn.mjs` (child-process driver with `--continue`) and `examples/drive-import.mjs` (in-process embedding).

## Log-debugging tools (sensei's edge)

- **`log_stats`** — one-pass profile: level counts, time range, error-frequency-over-time, top error templates. Always called first.
- **`log_slice`** — tail/head/line-range/time-range of a huge file, streamed, never loaded whole.
- **`log_timeline`** — merge 2+ logs into one timestamp-ordered view, each line tagged by source.
- **`log_trace`** — follow a request/correlation id across all logs, in order.
- **`log_search`** — *semantic* search over a log's error templates via your local Ollama embedding model (`--local`).
- **`log_baseline`** — `save` a known-good profile, then `diff` a later run: new error templates, count spikes.
- **`log_investigate`** — deep structural analysis of ANY unknown log: format family (json-lines, logfmt, csv/tsv, apache/w3c access, timestamped text…), timestamp styles with coverage, level vocabulary (incl. SEVERE/CRIT…), field types and cardinality, rare/unique events, multi-line blocks. The resulting **format map** is cached in `~/.sensei/formats/` and transparently consumed by the other log tools — after one investigate, they can read epoch timestamps, JSON timestamp fields, and extended level vocabularies.

## General tooling

`read_file` `write_file` `edit_file` `multi_edit` `glob` `grep` · shell: `run_powershell` on Windows / `bash` on macOS+Linux (foreground or `run_in_background` → `task_output`/`kill_task`) · subagents: `task`, `verify`, `task_parallel` (≤3 concurrent, in-process) — plus **custom agents**: `.sensei/agents/<name>.md` (project) or `~/.sensei/agents/<name>.md` (frontmatter `name`/`description`/`tools`/`model`, body = system prompt) run via `task` with `subagent_type`, with their own tool allowlist and model override · `todo_write` · `web_search` / `web_fetch` / `web_browser` (headless Edge/Chrome) · `skill` · `exit_plan_mode` · every configured MCP server's tools as `mcp__<server>__<tool>`.

## Architecture

`src/core` + `src/tools` + `src/logtools` are UI-free — every interaction is an `AgentEvent` or an awaitable `AgentHost` callback, so the headless CLI and the Ink TUI are thin hosts over one engine. The LLM sits behind a `ChatClient` interface (`openai` package, baseURL-switchable for Ollama); tests substitute a FIFO fake.

## Config

`~/.sensei/config.json` — model, provider, providers (see Providers above), local_model/local_base_url, max_output_tokens, stream, theme, save_sessions, context_char_budget, mcp_call_timeout, mcpServers, permissions, hooks, prices, output_style, auto_verify, auto_continue, embed_model, accent, statusline. A project `.sensei.json` adds `mcpServers`, `permissions`, and `hooks`. MCP servers are local stdio (`{"command", "args", "env"}`) or remote streamable HTTP (`{"url", "headers"}` — headers carry gateway auth).

- **Permission rules**: `"permissions": {"allow": ["run_powershell(git *)", "mcp__github__*"], "deny": ["read_file(*secret*)"], "defaultMode": "acceptEdits"}` — allow-matched tools skip the prompt; **deny rules are checked first and beat everything** (yolo and read-only tools included). `defaultMode` (default|acceptEdits|plan|yolo) applies when no `--permission-mode`/`--yolo`/`--plan` flag is given; **acceptEdits** auto-allows `write_file`/`edit_file`/`multi_edit` inside the working directory while shell/web still prompt. MCP tools take their first string schema property as the rule-matchable argument.
- **Hooks**: `"hooks": [{"event": "PreToolUse", "matcher": "run_powershell", "command": "..."}]` — runs in the platform shell (pwsh/sh) with a JSON payload on stdin. Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, SessionEnd, PreCompact, SubagentStop. Two output protocols: exit 2 on PreToolUse/UserPromptSubmit blocks (stderr = reason), or JSON on stdout — `{"decision": "block", "reason": "...", "additionalContext": "injected into the conversation", "systemMessage": "shown to the user"}`.
- **Memory**: `SENSEI.md` in `~/.sensei/` and/or up the directory tree is loaded into the system prompt; `/init` writes one.
- **Autonomy**: sensei acts rather than instructs, iterates on failed commands, and prefers user-scoped installs (it cannot elevate). `auto_continue` (default true) nudges tutorial-style answers once per turn; `auto_verify` runs an independent checker after file-modifying turns.
- **Context**: past ~80% of budget the conversation is auto-compacted (summarized); `/compact` forces it.

Sessions live in `~/.sensei/sessions/` as versioned envelopes; `--continue`/`--resume`/`/resume` pick them up (legacy PS-era session files still load).

## Tests

```
npm test        # vitest, fully offline — engine, tools, log analysis, TUI components, MCP vs a mock server
```
