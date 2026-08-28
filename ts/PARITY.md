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
| run_powershell (background) | ✅ | ⬜ (M4) | returns a clear error for now |
| todo_write | ✅ | ✅ | surfaces via the `todos` event |
| log_slice / log_stats / log_timeline / log_trace | ✅ | ⬜ (M2) | |
| log_baseline / log_search / log_investigate | ✅ | ⬜ (M2) | |
| web_fetch / web_search / web_browser | ✅ | ⬜ (M4) | |
| task / verify / task_parallel / exit_plan_mode | ✅ | ⬜ (M5) | task_parallel becomes Promise.all in-process |
| skill | ✅ | ⬜ (M4) | |
| MCP tool bridge (mcp__server__tool) | ✅ | ⬜ (M4) | via @modelcontextprotocol/sdk |

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
| Interactive y/n/a/p prompt | ✅ | ⬜ (M3) | host callback exists; headless is policy-driven |
| Hooks (Pre/PostToolUse, UserPromptSubmit, Stop) | ✅ | ⬜ (M4) | |
| SENSEI.md memory chain + @import | ✅ | ✅ | |
| auto_verify | ✅ | ⬜ (M5) | |
| Plan mode gate + exit_plan_mode | ✅ | 🔶 | gate ✅; exit_plan_mode tool M5 |
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
| --investigate | ✅ | ⬜ (M2) | |
| Interactive REPL + slash commands | ✅ | ⬜ (M3) | Ink TUI |
| Markdown renderer / diff previews / themes | ✅ | ⬜ (M3) | |
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
