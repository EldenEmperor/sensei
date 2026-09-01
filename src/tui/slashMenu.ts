// Slash-command menu logic as pure functions (mirrors composer.ts): the App
// derives the menu view every render from (composer text, command list,
// selection offset) — filtering, clamping, and scroll windowing live here so
// they test without Ink.

import type { ComposerState } from './composer.js';

export type CommandSource = 'builtin' | 'custom' | 'skill';

export interface SlashItem {
  /** Without the leading '/', e.g. 'help'. */
  name: string;
  /** Argument hint, '' when none, e.g. '[name]'. */
  hint: string;
  desc: string;
  source: CommandSource;
  /** Extra detail lines shown by `/<name> --help` (builtins). */
  help?: string[];
}

const b = (name: string, hint: string, desc: string, help: string[] = []): SlashItem => ({
  name,
  hint,
  desc,
  source: 'builtin',
  help,
});

export const BUILTIN_COMMANDS: SlashItem[] = [
  b('help', '', 'show this help', [
    'Lists every command (built-ins, custom commands, skills) and the key bindings.',
    'Any command also takes --help (or -h) for its own usage, e.g. /permissions --help.',
  ]),
  b('clear', '', 'reset the conversation (and todos)', [
    'Wipes the transcript and the todo checklist; config, session id, and provider stay.',
    'The system prompt is regenerated, so SENSEI.md changes are picked up too.',
  ]),
  b('plan', '[task]', 'toggle plan mode, or plan a task right away (read-only until you approve a plan)', [
    '/plan            toggle plan mode on/off (read-only tools while on)',
    '/plan <task>     enter plan mode and start planning <task> in one step',
    'When the plan is presented: [y] approve & execute · [a] approve + auto-accept',
    'file edits for this session · [n]/Esc keep planning.',
  ]),
  b('also', '<text>', 'interject into what sensei is doing right now (works while busy)', [
    'While a turn runs, the text is delivered to the model at its next step as part of',
    'the current request — steer without restarting. Idle, it just runs as a prompt.',
  ]),
  b('btw', '<note>', 'drop background context without changing course (works while busy)', [
    'The note reaches the model at its next step (or next turn) marked as context to',
    'use only where relevant — it will not redirect the current work.',
  ]),
  b('subtask', '<prompt>', 'spawn a background side-investigation while you keep working', [
    'Runs an independent subagent (own context, non-interactive) in parallel; a spectral',
    'clone appears while it works, and its report is injected into the conversation when',
    'it finishes. /stop kills running subtasks. Works while sensei is busy.',
  ]),
  b('stop', '', 'stop everything: the current turn, subtasks, and background tasks', [
    'Aborts the in-flight turn (like Esc) AND kills every running /subtask and',
    'run_in_background task, reporting what was stopped. Works while sensei is busy.',
  ]),
  b('agents', '[new <name> [purpose]]', 'list custom subagents, or have sensei create one', [
    '/agents           list defs from .sensei/agents/ and ~/.sensei/agents/',
    '/agents new <name> [purpose]   sensei authors the agent file for you',
    'Custom agents run via the task tool (subagent_type) with their own prompt,',
    'tool allowlist, and model. Listing works while sensei is busy.',
  ]),
  b('mode', '[code|logs]', 'system-prompt doctrine: coding (default) or log debugging', [
    'code — coding doctrine leads: read-before-write, minimal diffs matching the',
    'surrounding conventions, risk-proportional verification (run the checks!).',
    'logs — log-first doctrine leads: log_stats first, hunt the first anomaly in time.',
    'All tools stay available in both modes; a name sets and persists.',
  ]),
  b('style', '[name]', 'response style: default|concise|explanatory|teaching', [
    'No argument shows the current style; a name sets it and persists to config.',
  ]),
  b('color', '[name|hex]', 'accent color: indigo|jade|gold|teal|red or #RRGGBB', [
    'Persists to config; takes full effect on restart.',
  ]),
  b('model', '[name|list]', 'show or set the model (setting persists to config)', [
    '/model            show the active model',
    '/model list       installed Ollama models (local) or known model names (cloud)',
    '/model <name>     set it — writes the active provider\'s model key in config.',
    'A claude-* name switches the inferred provider to anthropic (and vice versa).',
    'On local, setting a model Ollama does not have warns immediately.',
  ]),
  b('provider', '[name]', 'show or switch the API provider (openai|anthropic|local|custom)', [
    'No argument lists configured providers with wire protocol, endpoint, and key status.',
    'A name switches and persists. Custom entries live under "providers" in',
    '~/.sensei/config.json (wire, base_url, api_key_env, headers, model).',
  ]),
  b('config', '', 'show effective config', [
    'Dumps ~/.sensei/config.json merged over defaults; api_key values are masked.',
    'Project overrides (.sensei.json) add mcpServers, permissions, and hooks.',
  ]),
  b('permissions', '', 'list allow/deny rules', [
    'Shows every allow and deny rule with its source (user config, project, CLI).',
    'Rule grammar: "tool" or "tool(pattern)" with * ? [abc] wildcards, matched against',
    'the tool\'s primary argument, e.g. run_powershell(git *) or read_file(C:\\logs\\*).',
    'allow lives in ~/.sensei/config.json or .sensei.json under permissions.allow;',
    'deny rules beat everything, including --yolo and read-only tools.',
  ]),
  b('todos', '', 'show the current checklist', [
    'The checklist the agent maintains via todo_write during multi-step work.',
  ]),
  b('cost', '', 'token usage and estimated cost', [
    'Session totals: input/output tokens, cached-prefix reads, and estimated $ based',
    'on the model price table (override via "prices" in config).',
  ]),
  b('mcp', '', 'MCP server status and tools', [
    'Connection status and tool list per configured server. Configure under',
    '"mcpServers": stdio {"command","args"} or remote {"url","headers"}.',
  ]),
  b('skills', '', 'list available skills', [
    'Skills load from .sensei/skills/<name>/SKILL.md (project) and ~/.sensei/skills.',
    'Invoke one directly as /<skillname> [args].',
  ]),
  b('newskill', '<name> [purpose]', 'have the agent author a new skill', [
    'The agent writes .sensei/skills/<name>/SKILL.md for you.',
    'Example: /newskill triage summarize the top errors in a log file',
  ]),
  b('tasks', '', 'list background tasks', [
    'Tasks started with run_in_background; the agent reads them with task_output.',
  ]),
  b('compact', '', 'summarize the conversation to reclaim context', [
    'Forces the summarizing compaction that otherwise runs automatically at ~80%',
    'of context_char_budget. Earlier exchanges become one summary message.',
  ]),
  b('memory', '', 'show loaded SENSEI.md memory files', [
    'Memory chain: ~/.sensei/SENSEI.md first, then every SENSEI.md from the drive',
    'root down to the current directory (nearest last). @file.md lines import.',
  ]),
  b('init', '', 'explore this directory and write a SENSEI.md', [
    'The agent investigates the project and records what future sessions should know.',
  ]),
  b('investigate', '[path]', "deep-map a log file's structure (default: newest .log in cwd)", [
    'Runs log_investigate: format family, timestamp styles, level vocabulary, rare',
    'events. The resulting format map is cached and teaches the other log tools.',
  ]),
  b('resume', '[n|id]', 'list recent sessions / continue one', [
    '/resume          list recent saved sessions for this directory',
    '/resume <n|id>   swap the conversation to that session',
    'Sessions live in ~/.sensei/sessions; --continue does the same from the CLI.',
  ]),
  b('exit', '', 'quit (also /quit, or Ctrl+D)', ['Saves the session first when save_sessions is on.']),
  b('quit', '', 'quit', ['Same as /exit.']),
];

/** The `/name --help` output for any menu item. Builtins carry curated help;
 *  custom commands and skills get generated detail from `extra`. */
export function commandHelpLines(item: SlashItem, extra: string[] = []): string[] {
  const usage = `usage: /${item.name}${item.hint ? ' ' + item.hint : ''}`;
  const lines = [usage, `  ${item.desc}`];
  for (const l of item.help ?? []) lines.push(`  ${l}`);
  for (const l of extra) lines.push(`  ${l}`);
  return lines;
}

/** The /help body, derived from BUILTIN_COMMANDS plus the footer notes. */
export function helpLines(): string[] {
  const label = (c: SlashItem) => `/${c.name}${c.hint ? ' ' + c.hint : ''}`;
  const width = Math.max(...BUILTIN_COMMANDS.map((c) => label(c).length)) + 2;
  const lines = BUILTIN_COMMANDS.map((c) => `  ${label(c).padEnd(width)}${c.desc}`);
  // '/plan' must keep the phrase 'toggle plan mode' (asserted by tui-app tests)
  return [
    ...lines,
    '  /<command> --help   usage details for one command (works for custom commands and skills too)',
    '  custom commands: .sensei\\commands\\<name>.md ($ARGUMENTS and $1..$n substituted)',
    '  keys: !cmd runs in the shell directly · @path Tab-completes files · \\ then Enter = new line',
    '        typing while busy queues the message · Ctrl+O verbose tool output · Ctrl+A/E/W/U edit',
  ];
}

export const MENU_MAX_ROWS = 8;

/** The menu query ('' for bare '/', 'he' for '/he'), or null when the menu is
 *  closed: text doesn't start with '/', or already has a space or newline. */
export function slashMenuQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const rest = text.slice(1);
  if (/\s/.test(rest)) return null; // space or newline: args typed, menu closes
  return rest;
}

/** Merge sources in dispatch-priority order (builtin > custom > skill),
 *  deduping by lowercase name — a shadowed entry is unreachable in
 *  handleSlash, so it is dropped here too. */
export function buildSlashItems(
  builtins: SlashItem[],
  customs: { name: string; argumentHint: string; description: string }[],
  skills: { name: string; description: string }[],
): SlashItem[] {
  const out: SlashItem[] = [];
  const seen = new Set<string>();
  const add = (item: SlashItem): void => {
    const key = item.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const c of builtins) add(c);
  for (const c of customs) add({ name: c.name, hint: c.argumentHint, desc: c.description || 'custom command', source: 'custom' });
  for (const s of skills) add({ name: s.name, hint: '', desc: s.description || 'skill', source: 'skill' });
  return out;
}

export interface SlashMenuView {
  query: string;
  /** All prefix matches, source-priority order. */
  items: SlashItem[];
  /** selIndex clamped to 0..items.length-1. */
  selected: number;
  /** Scroll-window start, keeps `selected` visible. */
  start: number;
  rows: SlashItem[];
  /** Items hidden below the window. */
  moreBelow: number;
}

/** null when the query is closed or nothing matches — the App treats null as
 *  "menu closed" and every key falls through to its existing behavior. */
export function slashMenuView(
  text: string,
  all: SlashItem[],
  selIndex: number,
  maxRows: number = MENU_MAX_ROWS,
): SlashMenuView | null {
  const query = slashMenuQuery(text);
  if (query === null) return null;
  const q = query.toLowerCase();
  const items = all.filter((c) => c.name.toLowerCase().startsWith(q));
  if (items.length === 0) return null;
  const selected = Math.min(Math.max(0, selIndex), items.length - 1);
  const start = Math.min(Math.max(0, selected - maxRows + 1), Math.max(0, items.length - maxRows));
  const rows = items.slice(start, start + maxRows);
  return { query, items, selected, start, rows, moreBelow: Math.max(0, items.length - (start + maxRows)) };
}

/** Tab: complete the selected command into the composer as '/name '. */
export function applySlashCompletion(_state: ComposerState, item: SlashItem): ComposerState {
  const text = `/${item.name} `;
  return { text, cursor: text.length };
}
