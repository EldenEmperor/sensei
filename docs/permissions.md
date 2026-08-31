# Permissions

Sensei gates every write-capable tool (file edits, shell, web, MCP) behind a permission
system. Read-only tools (`read_file`, `grep`, `log_*`, …) run freely — except when a deny
rule matches.

## The decision order

For each tool call, in order:

1. **Deny rules** — `permissions.deny` beats *everything*: `--yolo`, session allows,
   even read-only tools. A denied call tells the model not to retry.
2. **Plan mode** — while active, every non-read-only tool is blocked until you approve a
   plan ([TUI guide](tui.md#plan-mode)).
3. **Yolo** — `--yolo` (or mode `yolo`): everything else is allowed.
4. **Session allows** — you pressed `a` at a prompt earlier this session.
5. **Allow rules** — from user config, project config, `--allow` flags, and a custom
   command's `allowed-tools` (that turn only).
6. **acceptEdits** — if the mode is `acceptEdits`, file edits inside the working
   directory (and any `--add-dir`) are auto-allowed; shell/web/MCP still prompt.
7. **The prompt** — interactive TUI asks; headless fails closed with
   `permission denied`.

## Permission modes

Set with `--permission-mode <mode>`, or persistently with
`"permissions": {"defaultMode": "..."}` in config. `--yolo` and `--plan` are aliases.

| Mode | Behavior |
|---|---|
| `default` | prompt for every non-allowed write tool (TUI); fail closed headlessly |
| `acceptEdits` | auto-allow `write_file`/`edit_file`/`multi_edit` inside cwd; prompt for the rest |
| `plan` | start in plan mode (read-only until a plan is approved) |
| `yolo` | skip all permission checks (deny rules still apply) |

Approving a plan with `[a]` also turns on acceptEdits for the rest of the session.

## Rule grammar

Rules are `tool` or `tool(pattern)` with PowerShell-style wildcards (`*`, `?`, `[abc]`),
matched against the tool's primary argument — the command for shell tools, the (raw and
resolved) path for file tools, the URL/query for web tools, the first string argument for
MCP tools:

```jsonc
{
  "permissions": {
    "allow": [
      "run_powershell(git *)",        // any git command (use "bash(git *)" on POSIX)
      "write_file(C:\\repo\\*)",      // writes under a directory
      "mcp__github__*"                // every tool from one MCP server
    ],
    "deny": [
      "read_file(*secret*)",          // even read-only tools can be denied
      "run_powershell(*rm -rf*)"
    ],
    "defaultMode": "acceptEdits"
  }
}
```

- Tool names match case-insensitively everywhere; **resolved paths match
  case-sensitively on POSIX** (the filesystem does).
- Where rules live: `permissions.allow`/`deny` in `~/.sensei/config.json` (all
  projects) and `.sensei.json` (this project). `--allow "rule"` adds run-scoped rules.
- `/permissions` in the TUI lists every rule with its source.

## The interactive prompt

When a tool needs approval the TUI shows the call (with a real diff preview for file
edits) and offers:

- `y` — allow once
- `n` / Esc / Enter — deny (the model is told the *user* refused, and won't retry)
- `a` — allow this tool for the rest of the session
- `p` — persist a rule to `.sensei.json` (shell tools persist as
  `<tool>(<first-word> *)`, file tools as the resolved path)

## Headless policy

Without a TTY there is no prompt: write tools fail closed unless you pass `--yolo`,
`--allow "rule"` (repeatable), or `--permission-mode acceptEdits`. Denied calls are
reported in the JSON output's `permission_denials`. See [Headless CLI](headless.md).
