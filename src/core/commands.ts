// Custom slash commands: .sensei/commands/<name>.md (project) then
// ~/.sensei/commands/<name>.md (user). Optional frontmatter:
//
//   ---
//   description: one line for /help
//   argument-hint: <file> [level]
//   allowed-tools: read_file, grep, log_stats     (turn-scoped allow rules)
//   ---
//
// The body is the prompt; $ARGUMENTS is the raw argument string, $1..$n are
// whitespace-split (double-quoted spans count as one argument).

import fs from 'node:fs';
import path from 'node:path';

export interface CustomCommand {
  name: string;
  path: string;
  description: string;
  argumentHint: string;
  /** Allow rules granted for the turn this command starts. */
  allowedTools: string[];
  body: string;
}

export function parseCommandFile(file: string, name: string): CustomCommand {
  const raw = fs.readFileSync(file, 'utf8');
  let body = raw;
  let description = '';
  let argumentHint = '';
  let allowedTools: string[] = [];
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === 'description') description = val;
      else if (key === 'argument-hint') argumentHint = val;
      else if (key === 'allowed-tools' && val) {
        allowedTools = val
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
  }
  return { name, path: file, description, argumentHint, allowedTools, body: body.trim() };
}

export function findCustomCommand(name: string, cwd: string, configDir: string): CustomCommand | null {
  for (const dir of [path.join(cwd, '.sensei', 'commands'), path.join(configDir, 'commands')]) {
    const p = path.join(dir, `${name}.md`);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return parseCommandFile(p, name);
    } catch {
      /* skip */
    }
  }
  return null;
}

export function listCustomCommands(cwd: string, configDir: string): CustomCommand[] {
  const out: CustomCommand[] = [];
  const seen = new Set<string>();
  for (const dir of [path.join(cwd, '.sensei', 'commands'), path.join(configDir, 'commands')]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of entries.sort()) {
      const name = path.basename(f, '.md');
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      try {
        out.push(parseCommandFile(path.join(dir, f), name));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** Whitespace-split honoring double-quoted spans: `a "b c"` → ["a", "b c"]. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const rx = /"([^"]*)"|(\S+)/g;
  for (const m of args.matchAll(rx)) out.push(m[1] ?? m[2]);
  return out;
}

/** Substitute $ARGUMENTS and $1..$n into the command body. */
export function buildCommandPrompt(cmd: CustomCommand, args: string): string {
  const parts = splitArgs(args);
  let prompt = cmd.body.replace(/\$ARGUMENTS/g, args);
  prompt = prompt.replace(/\$(\d+)/g, (_, n: string) => parts[Number(n) - 1] ?? '');
  return prompt;
}
