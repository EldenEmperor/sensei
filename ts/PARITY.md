# Parity: PowerShell variant ↔ TypeScript variant

Status values: ✅ ported · 🔶 partial · ⬜ pending (milestone) · ➖ intentionally not ported · 🆕 TS-only

## Tools

| Feature | PS | TS | Notes |
|---|---|---|---|
| read_file | ✅ | ✅ | |
| write_file | ✅ | ✅ | |
| edit_file | ✅ | ✅ | exact-match-count semantics verbatim |
| multi_edit | ✅ | ✅ | atomic |
| glob | ✅ | ✅ | same pattern→regex translation, newest-first, cap 200 |
| grep | ✅ | ✅ | JS regex instead of .NET regex (documented divergence) |
| run_powershell (foreground) | ✅ | ✅ | spawns pwsh, same output format, kill-tree on timeout |
| run_powershell (background) | ✅ | ✅ | -EncodedCommand base64 UTF-16LE, file-backed delta reads |
| todo_write | ✅ | ✅ | surfaces via the `todos` event |
| log_slice / log_stats | ✅ | ✅ | cross-check: byte-identical output on the 200k-line app.log |
| log_timeline / log_trace | ✅ | ✅ | block-cursor k-way merge via async iterators |
| log_baseline | ✅ | ✅ | template_version=2, same diff rules |
| log_search | ✅ | ✅ | Ollama embeddings via fetch; provider injectable for tests |
| log_investigate + format maps | ✅ | ✅ | full analyzer + cache + hints; ~10× faster per pass than PS |
| web_fetch / web_search / web_browser | ✅ | ✅ | pure HTML/DDG parsers unit-tested; fetch + headless Edge/Chrome spawn |
| task / verify / task_parallel / exit_plan_mode | ✅ | ⬜ (M5) | task_parallel becomes Promise.all in-process |
| skill | ✅ | ✅ | re-registered each turn; project shadows user |
| MCP tool bridge (mcp__server__tool) | ✅ | ✅ | @modelcontextprotocol/sdk StdioClientTransport; stderr → ~/.sensei/logs; round-trip tested vs a live SDK server |
| task_output / kill_task | ✅ | ✅ | |

## Engine

| Feature | PS | TS | Notes |
|---|---|---|---|
| Agent loop (40 rounds, 30k tool-output cap) | ✅ | ✅ | |
| auto_continue nudge (detector + one-shot note) | ✅ | ✅ | regexes verbatim, inline flags hoisted |
| stop+tool_calls orphan fix | ✅ | ✅ | condition is `no tool_calls` in both |
| Transcript trim (tool-pair invariant) | ✅ | ✅ | |
| Summarizing compaction | ✅ | ⬜ (M5) | TS trims only for now |
| @file expansion (256KB guard) | ✅ | ✅ | |
| Permission gate (yolo / session / allowlist / persist) | ✅ | ✅ | PS `-like` semantics reimplemented + tested |
| Interactive y/n/a/p prompt | ✅ | ✅ | Ink PermissionPrompt with diff preview; persist writes .sensei.json |
| Hooks (Pre/PostToolUse, UserPromptSubmit, Stop) | ✅ | ✅ | pwsh child, JSON on stdin, exit 2 = block — existing hooks work unchanged |
| Background-task turn notices (<system-note>) | ✅ | ✅ | turn start + between tool rounds |
| SENSEI.md memory chain + @import | ✅ | ✅ | |
| auto_verify | ✅ | ⬜ (M5) | |
| Plan mode gate + exit_plan_mode | ✅ | 🔶 | gate + /plan toggle + plan-approval host callback ✅; exit_plan_mode tool M5 |
| Sessions | ✅ | ✅ 🆕 | TS: versioned envelope + reads PS legacy arrays; print-mode saving with --continue is TS-only |
| Cost line / token totals | ✅ | ✅ | |
| Streaming + `<think>` strip | ✅ | ✅ | via openai pkg async iterator |
| Retry/backoff (5 attempts, Retry-After, Ollama message) | ✅ | ✅ | |
| ESC (U+241B) terminal sanitization | ✅ | ✅ | all model/tool text through sanitizeTerminalText |

## CLI / UX

| Feature | PS | TS | Notes |
|---|---|---|---|
| -p print mode | ✅ | ✅ | TS requires -p until the TUI lands |
| --local / --model / --yolo / --plan | ✅ | ✅ | |
| --output-format text\|json\|stream-json | ➖ | 🆕 | headless payload with session_id/usage/permission_denials |
| --continue [id] / --session-id / --resume | 🔶 (/resume picker) | 🆕/✅ | bare --continue starts fresh when nothing exists |
| --allow rule (repeatable) | ➖ | 🆕 | |
| --file attach | ➖ | 🆕 | routed through @file expansion |
| --investigate | ✅ | ✅ | headless: runs the investigate prompt through the agent |
| Interactive REPL | ✅ | ✅ | Ink TUI: Static transcript + streaming region, spinner, composer w/ history + tab-completion, Esc/Ctrl+C abort |
| Slash commands | ✅ | 🔶 | /help /clear /plan /style /color /model /config /permissions /todos /cost /mcp /skills /newskill /tasks /exit /quit + custom .md commands + /<skillname>; /compact /memory /init /investigate /resume land M5 |
| Markdown renderer / diff previews / themes | ✅ | ✅ | line renderer ported (pure, tested); real line-diff for write_file (upgrade over Compare-Object); accent presets + hex |
| First-run key setup + PATH mutation | ✅ | ➖ | TS prints instructions instead |
| PS 5.1 relaunch shim | ✅ | ➖ | N/A |

## Tests

| Suite | PS asserts | TS tests |
|---|---|---|
| Core tools | ~15 | 11 (tools.test.ts) |
| Permissions / allowlist | ~6 | 9 (permissions.test.ts) |
| Agent loop + auto-continue + orphan fix | ~15 | 12 (agent.test.ts) |
| Sessions / trim | ~8 | 7 (sessions.test.ts) |
| Detector unit tests | 7 | 7 (in agent.test.ts) |
| Log tools + format maps | ~45 | 14 (logtools.test.ts, against the committed app.log + fixtures) |
| TUI renderer/diff/theme + Ink components | — | 15 (tui.test.ts pure fns; tui-app.test.tsx boots the real App, drives stdin) |
| Hooks / skills / tasks / web / MCP | ~25 | 18 (integrations.test.ts; MCP vs a live mock SDK server subprocess) |

Cross-variant check: `pwsh -File ts\scripts\cross-check.ps1` runs log_stats/log_slice
through both variants on tests/app.log and requires byte-identical output.

Known per-variant divergence: format-map cache files use different fingerprint
units (PS .NET ticks vs TS mtimeMs), so the two variants keep separate cache
entries in the shared `~/.sensei/formats/` — they coexist, never conflict.
