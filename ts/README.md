# Sensei (TypeScript variant)

The TypeScript/Node port of Sensei — **feature-complete**: the full engine,
all log tools (byte-identical output, cross-checked against the PS variant),
subagents (`task`/`verify`/`task_parallel`/auto-verify), summarizing
compaction, MCP (official SDK), skills, hooks, background tasks, web tools,
an Ink TUI, and a first-class headless mode. The PowerShell variant at the
repo root is the frozen reference; both share `~/.sensei` (config, sessions,
allowlists, MCP servers, hooks). Feature map: [PARITY.md](./PARITY.md).

## Setup

```
cd ts
npm install
npm test          # vitest, offline
```

Requires Node ≥ 22 and (for real runs) either `OPENAI_API_KEY` or a local
Ollama (`--local`).

## Interactive usage (Ink TUI)

```
cd ts
npm run dev -- --local          # or: npx tsx src/cli/main.ts --local
```

Claude Code-style terminal UI: streaming markdown answers, live tool-call
lines, todo checklist, y/n/a/p permission prompts with diff previews, plan
mode (`/plan`), history + tab-completion in the composer, Esc/Ctrl+C aborts
the in-flight turn, Ctrl+D exits (saving the session). `/help` lists the
slash commands; custom commands from `.sensei\commands\*.md` work as in the
PS variant.

## Headless usage

```
npx tsx src/cli/main.ts -p "why did the 02:47 crash happen?" --file ..\tests\app.log --local --yolo
```

- `--output-format json` — one machine-readable object on stdout
  (`session_id`, `result`, `usage`, `permission_denials`, `error`); progress on stderr.
- `--output-format stream-json` — NDJSON of live agent events.
- `--continue [id]` — continue a saved conversation across invocations
  (bare `--continue` picks the latest session for this directory, or starts one).
- `--yolo` / `--allow "tool(pattern)"` — headless permission policy; without
  either, write/execute tools fail closed.

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

See `examples/drive-spawn.mjs` (child-process driver with `--continue`) and
`examples/drive-import.mjs` (in-process embedding).

## Architecture

`src/core` + `src/tools` never touch stdout — every interaction is an
`AgentEvent` or an awaitable `AgentHost` callback, so the headless CLI and the
future Ink TUI are thin hosts over the same engine. The LLM sits behind a
`ChatClient` interface (`openai` package with a configurable baseURL for
Ollama); tests substitute a FIFO fake.
