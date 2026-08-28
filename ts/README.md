# Sensei (TypeScript variant)

The TypeScript/Node port of Sensei — engine-first, headless-capable, with an
Ink TUI on the roadmap. The PowerShell variant at the repo root remains the
stable reference; both share `~/.sensei` (config, sessions, allowlists).
Progress is tracked feature-by-feature in [PARITY.md](./PARITY.md).

## Setup

```
cd ts
npm install
npm test          # vitest, offline
```

Requires Node ≥ 22 and (for real runs) either `OPENAI_API_KEY` or a local
Ollama (`--local`).

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
