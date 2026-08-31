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
}

const b = (name: string, hint: string, desc: string): SlashItem => ({ name, hint, desc, source: 'builtin' });

export const BUILTIN_COMMANDS: SlashItem[] = [
  b('help', '', 'show this help'),
  b('clear', '', 'reset the conversation (and todos)'),
  b('plan', '[task]', 'toggle plan mode, or plan a task right away (read-only until you approve a plan)'),
  b('style', '[name]', 'response style: default|concise|explanatory|teaching'),
  b('color', '[name|hex]', 'accent color: indigo|jade|gold|teal|red or #RRGGBB'),
  b('model', '[name]', 'show or set the model (setting persists to config)'),
  b('provider', '[name]', 'show or switch the API provider (openai|anthropic|local|custom)'),
  b('config', '', 'show effective config'),
  b('permissions', '', 'list allow/deny rules'),
  b('todos', '', 'show the current checklist'),
  b('cost', '', 'token usage and estimated cost'),
  b('mcp', '', 'MCP server status and tools'),
  b('skills', '', 'list available skills'),
  b('newskill', '<name> [purpose]', 'have the agent author a new skill'),
  b('tasks', '', 'list background tasks'),
  b('compact', '', 'summarize the conversation to reclaim context'),
  b('memory', '', 'show loaded SENSEI.md memory files'),
  b('init', '', 'explore this directory and write a SENSEI.md'),
  b('investigate', '[path]', "deep-map a log file's structure (default: newest .log in cwd)"),
  b('resume', '[n|id]', 'list recent sessions / continue one'),
  b('exit', '', 'quit (also /quit, or Ctrl+D)'),
  b('quit', '', 'quit'),
];

/** The /help body, derived from BUILTIN_COMMANDS plus the footer notes. */
export function helpLines(): string[] {
  const label = (c: SlashItem) => `/${c.name}${c.hint ? ' ' + c.hint : ''}`;
  const width = Math.max(...BUILTIN_COMMANDS.map((c) => label(c).length)) + 2;
  const lines = BUILTIN_COMMANDS.map((c) => `  ${label(c).padEnd(width)}${c.desc}`);
  // '/plan' must keep the phrase 'toggle plan mode' (asserted by tui-app tests)
  return [
    ...lines,
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
