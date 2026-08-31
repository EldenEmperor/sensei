# Customization

Everything project-specific lives under `.sensei/` in your repo (shared with your team
via git) or `~/.sensei/` (just you). Project entries shadow user entries by name.

## Custom slash commands

A markdown file per command: `.sensei/commands/<name>.md` (project) or
`~/.sensei/commands/<name>.md`. The body is the prompt; optional frontmatter adds
metadata:

```markdown
---
description: triage a log file and report the top issues
argument-hint: <file> [level]
allowed-tools: log_stats, log_slice, grep
---
Triage the log file $1 focusing on $2-level events.
Start with log_stats, then drill into the worst window. Raw input: $ARGUMENTS
```

- `$ARGUMENTS` is the raw argument string; `$1..$n` are whitespace-split (double-quoted
  spans count as one argument).
- `description` and `argument-hint` show in `/help` and the slash menu;
  `/name --help` renders them too.
- `allowed-tools` grants those tools as allow rules **for that turn only** — the command
  can run its tools without prompting, without loosening anything else.
- Invoke as `/triage app.log ERROR` in the TUI, or headlessly:
  `sensei -p "/triage app.log ERROR"`.

## Skills

Reusable instruction packs the model loads on demand:
`.sensei/skills/<name>/SKILL.md` (project) or `~/.sensei/skills/<name>/`:

```markdown
---
name: sre-runbook
description: incident triage runbook — use when the user reports an outage or asks to triage an incident
---
Follow this method: ...
Supporting files in this folder can be referenced by full path.
```

The `description` line is how the model decides to load a skill, so include trigger
phrases. Invoke directly as `/sre-runbook [args]`, or let the model pick it up via its
`skill` tool. `/newskill <name> [purpose]` has the agent author one for you.

**Skills vs commands:** a command is a prompt *you* fire; a skill is instructions the
*model* can load mid-task when it recognizes the situation.

## Custom subagents

Define specialized agents in `.sensei/agents/<name>.md` (project) or
`~/.sensei/agents/`:

```markdown
---
name: log-triager
description: triages a log file and reports the top three issues
tools: read_file, grep, log_stats, log_slice
model: claude-haiku-4-5
---
You are a log triager. Given a log file, find the top three issues with evidence
(path:line each) and nothing else.
```

- The **body is the subagent's system prompt**.
- `tools` (optional) restricts it to that list; `model` (optional) overrides the session
  model — e.g. a cheap fast model for bulk reading.
- The main agent runs them through its `task` tool with `subagent_type: "log-triager"`;
  the tool's description advertises every defined agent, so the model discovers them
  automatically. Subagents get a fresh context and return only their final report.

## Memory: SENSEI.md

Loaded into the system prompt every session:

- `~/.sensei/SENSEI.md` — global (you)
- every `SENSEI.md` from the drive root down to the working directory — project
  knowledge, nearest last

Lines like `@more-notes.md` import another file (one level deep). `/memory` shows what's
loaded; `/init` has the agent explore the directory and write one.

Put in it what a new teammate would need: where the logs live, their formats, known
failure patterns, useful commands.

## Statusline

Replace the TUI status bar with your own command:

```jsonc
{ "statusline": "node scripts/my-statusline.mjs" }
```

It runs at each turn end (and at start) in the platform shell with JSON context on
stdin — `{ model, provider, cwd, session_id, tokens: { in, out }, plan_mode }` — and its
first stdout line becomes the status bar. 5-second timeout, best-effort.

## Output styles

`/style default|concise|explanatory|teaching` changes the response style directive in
the system prompt (persists as `output_style` in config).
