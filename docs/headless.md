# Headless CLI

Run sensei non-interactively for scripts, CI, and one-shot questions.

## Giving it a prompt

Three equivalent ways:

```
sensei -p "why did the 02:47 crash happen?"
sensei "why did the 02:47 crash happen?"                  # bare positional
git log --oneline -20 | sensei "what shipped this week?"  # piped stdin becomes context
type app.log | sensei                                     # piped stdin alone IS the prompt
```

Attach files with `--file <path>` (repeatable) or inline `@path` references in the
prompt — **image files attach as vision input** (`sensei "what's in this? @shot.png"`,
needs a vision-capable model). `/custom-commands` work headlessly too:
`sensei -p "/triage app.log ERROR"`.

## Flags

Run `sensei -h` for the full list. The ones that matter most:

| Flag | Purpose |
|---|---|
| `--output-format text\|json\|stream-json` | plain answer (default) / one JSON object / NDJSON event stream |
| `--continue [id]` | continue a saved session (bare: latest for this directory) |
| `--session-id <id>` / `--resume <id>` | force an id / load without adopting the id |
| `--yolo` / `--allow "tool(pattern)"` / `--permission-mode acceptEdits` | permission policy — without one, write/execute tools **fail closed** |
| `--provider <name>` / `--local` / `--model <name>` | endpoint and model ([Providers](providers.md)) |
| `--plan` | plan mode (read-only research; the plan is recorded, nothing executes) |
| `--append-system-prompt "<text>"` | extra system-prompt instructions |
| `--add-dir <path>` | extra directory acceptEdits may auto-allow edits in (repeatable) |
| `--max-rounds <n>` | cap model/tool rounds for the turn (default 40) |
| `--investigate <path>` | deep-map a log's structure via the built-in prompt |

Exit codes: `0` success · `1` turn error (API/key/network) · `2` usage error.

## JSON output

`--output-format json` prints exactly one object on stdout (progress goes to stderr):

```json
{
  "schema_version": 1,
  "session_id": "a1b2c3d4e5f6",
  "result": "…the answer…",
  "finish_reason": "stop",
  "rounds": 3,
  "usage": {
    "prompt_tokens": 48210, "completion_tokens": 1834,
    "cache_read_tokens": 96400, "cache_creation_tokens": 12000,
    "cost_usd": 0.31
  },
  "permission_denials": [],
  "error": null
}
```

`--output-format stream-json` emits one NDJSON line per agent event (`turn-start`,
`assistant-delta`, `tool-start`, `tool-end`, `usage`, `turn-end`, …) — pipe it into your
own tooling.

## Sessions across invocations

```
sensei -p "start reviewing app.log" --continue
sensei -p "now check the payment errors too" --continue   # same conversation
```

Bare `--continue` picks the most recent session saved from the current directory (or
starts one and saves it). Sessions remember their provider; resume re-selects it unless
you pass `--provider`/`--local`. Files live in `~/.sensei/sessions/<id>.json`.

## Scripting example

```powershell
$r = sensei "summarize new errors since the last baseline" --file app.log `
      --allow "log_baseline" --output-format json | ConvertFrom-Json
if ($r.error) { throw $r.error }
$r.result
```

## Embedding in your own program

The engine is a library — no child process needed:

```js
import { ConfigStore, SenseiAgent } from 'sensei';

const store = new ConfigStore();
store.load();
const agent = new SenseiAgent({
  configStore: store,
  host: {
    onEvent: (e) => console.log(e.type),
    requestPermission: async () => ({ allow: false, reason: 'non-interactive' }),
    requestPlanApproval: async () => ({ approved: false }),
  },
  permissionPolicy: { mode: 'yolo' },
});
const r = await agent.ask('read x.log and summarize the errors');
```

See `examples/drive-import.mjs` (in-process) and `examples/drive-spawn.mjs`
(child-process driver with `--continue`).
