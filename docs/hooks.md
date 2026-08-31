# Hooks

Hooks run your own shell commands at points in the agent lifecycle — audit logging,
blocking dangerous calls, injecting context, cleanup on exit.

## Configuration

A flat array under `"hooks"` in `~/.sensei/config.json` (all projects) or `.sensei.json`
(this project; both lists run):

```jsonc
{
  "hooks": [
    { "event": "PreToolUse", "matcher": "run_powershell", "command": "C:\\hooks\\audit.ps1" },
    { "event": "SessionStart", "command": "node hooks/load-context.mjs" }
  ]
}
```

- `event` — which lifecycle point (below).
- `matcher` — optional tool-name wildcard (`*`, `?`, `[abc]`), only meaningful on
  PreToolUse/PostToolUse; absent = always.
- `command` — runs in the platform shell (`pwsh` on Windows, `sh -c` on POSIX) with the
  event payload as JSON on **stdin**. Hard timeout: 30 s.

## Events

| Event | Fires | Extra payload fields | Can block? |
|---|---|---|---|
| `PreToolUse` | before each tool call | `tool_name`, `tool_input` | yes |
| `PostToolUse` | after each tool call | `tool_name`, `tool_input`, `tool_response` | no |
| `UserPromptSubmit` | when you submit a prompt | `prompt` | yes |
| `Stop` | when a turn finishes | `last_message` | no |
| `SessionStart` | once, at the first prompt of a session | `trigger: "startup"` | no |
| `SessionEnd` | once, when the session exits | — | no |
| `PreCompact` | before context compaction | `trigger: "auto"` or `"manual"` | no |
| `SubagentStop` | after a subagent finishes | `last_message` | no |

Every payload also carries `hook_event_name`, `cwd`, and `session_id`.

## Output protocols

Two ways for a hook to talk back — use either:

**Exit codes** (simple):

- exit `0` — continue; stdout is shown to the user as a dim note
- exit `2` on a blockable event — **block**; stderr becomes the reason the model sees
- anything else — warn and continue

**JSON on stdout** (exit 0, richer):

```json
{
  "decision": "block",
  "reason": "writes to prod config are not allowed from sensei",
  "additionalContext": "the deploy freeze ends Friday",
  "systemMessage": "heads up: deploy freeze is active"
}
```

- `decision: "block"` — blocks (blockable events only)
- `additionalContext` — injected into the conversation as a system note the model sees
  (great on `SessionStart`/`UserPromptSubmit` for loading project state)
- `systemMessage` — shown to the user as a note
- Non-JSON stdout falls back to the plain note behavior; malformed JSON is not an error.

## Examples

Block any shell command touching a protected path (PowerShell):

```jsonc
{ "event": "PreToolUse", "matcher": "run_powershell",
  "command": "$p = [Console]::In.ReadToEnd() | ConvertFrom-Json; if ($p.tool_input.command -match 'prod') { [Console]::Error.Write('prod is off-limits'); exit 2 }" }
```

Inject context at session start (any language — read stdin, print JSON):

```jsonc
{ "event": "SessionStart",
  "command": "echo {\"additionalContext\":\"CI is red on main; see build 8123\"}" }
```

Audit every tool call to a file (POSIX):

```jsonc
{ "event": "PostToolUse", "command": "cat >> ~/.sensei/audit.jsonl" }
```
