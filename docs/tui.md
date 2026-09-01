# Interactive TUI

```
sensei [--provider <name>] [--local] [--model <name>] [--permission-mode <m>] [--plan] [--continue [id]]
```

Streaming markdown answers, live tool-call lines, a todo checklist the agent maintains,
permission prompts with real diff previews, and an animated samurai who fights while
sensei works.

## The composer

| Key | Action |
|---|---|
| Enter | submit (or run the selected menu item) |
| `\` then Enter | continue on a new line (multiline input) |
| ← / → | move the caret; Alt/Ctrl+← → by word |
| Ctrl+A / Ctrl+E | start / end of line |
| Ctrl+W / Ctrl+U | delete word back / kill to line start |
| ↑ / ↓ | input history (single-line input) |
| Tab | complete `@file` paths (and menu selections) |
| Esc / Ctrl+C | abort the in-flight turn |
| Ctrl+D | exit (saves the session) |
| Ctrl+O | toggle verbose tool output in the transcript |

More composer behaviors:

- **Typing while sensei is busy queues the message** — it auto-submits when the turn
  ends (the status bar shows the queue depth).
- **`!command`** runs directly in the platform shell and prints the output into the
  transcript — no model turn, no tokens.
- **`@path`** inlines a file into your prompt (large files are pointed at the log
  tools instead); Tab completes paths, descending directories.
- **Big pastes collapse to a chip** — `[pasted #1 +42 lines]` — instead of flooding the
  composer; the full text expands into the prompt when you submit. Delete the chip to
  drop the paste.

## The slash-command menu

Typing `/` opens a live menu of every command — built-ins, [custom
commands](customization.md#custom-slash-commands), and skills — with argument hints and
descriptions. Type to filter, ↑/↓ to select, Tab to complete, Enter to run, Esc to
dismiss.

Every command also answers `--help` (or `-h`):

```
/permissions --help      the rule grammar and where rules persist
/provider --help         the providers config shape
/mycustomcommand --help  generated from its frontmatter
```

Frequently used:

| Command | Purpose |
|---|---|
| `/model [name]`, `/provider [name]` | show/switch the model and endpoint (persists) |
| `/mode [code\|logs]` | which doctrine leads the system prompt — coding (default) or log-first (persists) |
| `/permissions` | list allow/deny rules with sources |
| `/mcp` | MCP server status and tools |
| `/cost` | token totals, cached-prefix reads, estimated $ |
| `/compact` | force context compaction (automatic at ~80% budget) |
| `/resume [n\|id]` | list / continue saved sessions |
| `/memory` | which SENSEI.md files are loaded |
| `/init` | write a SENSEI.md for this directory |
| `/investigate [path]` | deep-map a log file's structure |
| `/design <what>` | sensei builds a self-contained HTML mockup in `.sensei/designs/` and opens it in your browser; iterate by describing changes |
| `/clear` | reset the conversation |

## Plan mode

`/plan` toggles plan mode; `/plan <task>` enters it *and* starts planning that task in
one step. While active, every state-changing tool is blocked — sensei researches with
read-only tools, then presents a plan:

```
Proposed plan:
  1. ...
  Approve? [y] yes, execute · [a] yes + auto-accept file edits this session · [n]/Esc no, keep planning
```

- `y` — plan mode ends and the same turn continues into execution
- `a` — same, plus file edits inside the working directory stop prompting for the rest
  of the session ([acceptEdits](permissions.md#permission-modes))
- `n`/Esc — sensei stays in plan mode and asks what to change

## Steering while it works

Five commands act **immediately** even while sensei is busy (everything else you type
queues for the next turn):

| Command | What it does |
|---|---|
| `/also <text>` | interjects into the *running* request — delivered to the model at its next step, as part of what it's doing. Idle, it just runs as a prompt. |
| `/btw <note>` | drops background context without changing course — marked "use only where relevant" |
| `/subtask <prompt>` | spawns an independent background subagent (a spectral clone appears while it works); its report is injected into the conversation when it finishes, and the status bar shows `⛩ N subtasks` |
| `/stop` | stops **everything** — aborts the in-flight turn, kills every running subtask and background task, and reports what was stopped (with a sheath animation) |
| `/agents` | lists your custom subagents; `/agents new <name> [purpose]` has sensei author one ([customization](customization.md#custom-subagents)) |

## Clarifying questions

When a genuine decision blocks sensei mid-task (ambiguous scope, several defensible
approaches), it can ask you instead of guessing — the `ask_user` tool renders a picker:

```
◆ Auth method — Which auth flow should the CLI use?
  ❯ 1. OAuth        browser sign-in
    2. API key      read from an env var
    3. Other…       type your own answer
  ↑/↓ move · 1-9 pick · Enter confirm · Esc dismiss
```

- ↑/↓ or a digit selects; Enter confirms; **Other…** opens a one-line free-text answer
- multi-select questions show checkboxes (Space toggles, Enter confirms the set)
- Esc dismisses — sensei is told to proceed with its best judgment and state the assumption
- Headless sessions never hang on questions: the tool immediately returns "no answer,
  proceed with judgment". Subagents don't get the tool at all.

## Permission prompts

When a tool needs approval you'll see the call (file edits show a line diff) and
`[y]es / [n]o / [a]lways this session / [p]ersist to allowlist`. Details in
[Permissions](permissions.md).

## The working status

While sensei works, the spinner line is a live readout instead of a bare "thinking…":

```
⠸ grep… 12s · ctx 43k/300k (14%) · ~12.3k in / 1.2k out
```

- the active tool (or `thinking…` while the model responds) and elapsed seconds
- **context build-up**: transcript size vs `context_char_budget`, ticking up as tool
  results land — when it nears ~80% the conversation auto-compacts
- session tokens in/out so far (updates each model round)

## Status bar

The bottom line shows `model · provider · tokens in/out · PLAN` (when active) and the
queued-message count. A [`statusline` config command](customization.md#statusline) can
replace it with your own.
