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

```
npm install
npm test                        # offline test suite, no API key needed
npm run dev -- --local          # interactive TUI against local Ollama
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

Streaming markdown answers, live tool-call lines, todo checklist, y/n/a/p permission prompts with diff previews, plan mode, composer history + tab-completion; Esc/Ctrl+C aborts the in-flight turn, Ctrl+D exits (saving the session). `/help` lists the slash commands: `/clear /compact /plan /style /color /model /config /mcp /permissions /skills /newskill /tasks /todos /cost /memory /init /investigate /resume /exit` — plus custom commands (`.sensei\commands\<name>.md`, `$ARGUMENTS` substituted) and direct skill invocation as `/<skillname>`.

## Headless usage

```
npx tsx src/cli/main.ts -p "why did the 02:47 crash happen?" --file tests\app.log --local --yolo
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

`read_file` `write_file` `edit_file` `multi_edit` `glob` `grep` · shell: `run_powershell` on Windows / `bash` on macOS+Linux (foreground or `run_in_background` → `task_output`/`kill_task`) · subagents: `task`, `verify`, `task_parallel` (≤3 concurrent, in-process) · `todo_write` · `web_search` / `web_fetch` / `web_browser` (headless Edge/Chrome) · `skill` · `exit_plan_mode` · every configured MCP server's tools as `mcp__<server>__<tool>`.

## Architecture

`src/core` + `src/tools` + `src/logtools` are UI-free — every interaction is an `AgentEvent` or an awaitable `AgentHost` callback, so the headless CLI and the Ink TUI are thin hosts over one engine. The LLM sits behind a `ChatClient` interface (`openai` package, baseURL-switchable for Ollama); tests substitute a FIFO fake.

## Config

`~/.sensei/config.json` — model, provider, providers (see Providers above), local_model/local_base_url, max_output_tokens, stream, theme, save_sessions, context_char_budget, mcp_call_timeout, mcpServers, permissions.allow, hooks, prices, output_style, auto_verify, auto_continue, embed_model, accent. A project `.sensei.json` adds `mcpServers`, `permissions.allow`, and `hooks`.

- **Allowlist rules**: `"permissions": {"allow": ["run_powershell(git *)", "mcp__github__*"]}` — matched tools skip the prompt.
- **Hooks**: `"hooks": [{"event": "PreToolUse", "matcher": "run_powershell", "command": "..."}]` — runs in pwsh with a JSON payload on stdin; exit 2 on PreToolUse/UserPromptSubmit blocks. Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop.
- **Memory**: `SENSEI.md` in `~/.sensei/` and/or up the directory tree is loaded into the system prompt; `/init` writes one.
- **Autonomy**: sensei acts rather than instructs, iterates on failed commands, and prefers user-scoped installs (it cannot elevate). `auto_continue` (default true) nudges tutorial-style answers once per turn; `auto_verify` runs an independent checker after file-modifying turns.
- **Context**: past ~80% of budget the conversation is auto-compacted (summarized); `/compact` forces it.

Sessions live in `~/.sensei/sessions/` as versioned envelopes; `--continue`/`--resume`/`/resume` pick them up (legacy PS-era session files still load).

## Tests

```
npm test        # vitest, fully offline — engine, tools, log analysis, TUI components, MCP vs a mock server
```
