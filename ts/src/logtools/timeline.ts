// log_timeline — k-way merge of 2+ logs into one timestamp-ordered view.
// Block = a line plus any following continuation (untimestamped) lines,
// tagged with the most recent timestamp.

import fs from 'node:fs';
import readline from 'node:readline';
import { resolveSenseiPath } from '../core/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { getFormatHints } from './formatMap.js';
import { getLineTimestamp, type LogHints } from './timestamps.js';

const MAX_LINES = 2000;

interface LogCursor {
  it: AsyncIterator<string>;
  rl: readline.Interface;
  pending: string | null;
  name: string;
  lastTs: number | null;
  block: LogBlock | null;
  hints: LogHints | null;
}

interface LogBlock {
  ts: number | null;
  text: string;
}

async function newLogCursor(p: string, configDir: string): Promise<LogCursor> {
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  const it = rl[Symbol.asyncIterator]();
  const first = await it.next();
  return {
    it,
    rl,
    pending: first.done ? null : first.value,
    name: p.split(/[\\/]/).pop() ?? p,
    lastTs: null,
    block: null,
    hints: getFormatHints(p, configDir),
  };
}

async function readLogBlock(c: LogCursor): Promise<LogBlock | null> {
  if (c.pending === null) return null;
  const first = c.pending;
  const ts = getLineTimestamp(first, c.hints);
  if (ts !== null) c.lastTs = ts;
  const block = [first];
  for (;;) {
    const next = await c.it.next();
    if (next.done) {
      c.pending = null;
      break;
    }
    if (getLineTimestamp(next.value, c.hints) !== null) {
      c.pending = next.value;
      break;
    }
    block.push(next.value);
  }
  return { ts: c.lastTs, text: block.join('\n') };
}

export function registerLogTimeline(registry: ToolRegistry): void {
  registry.register({
    name: 'log_timeline',
    readOnly: true,
    description:
      'Merge 2+ log files into one timestamp-ordered view, each line tagged with its source file. Optionally bound to from_time/to_time. The tool for "what did every service say around the moment of the crash?"',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Two or more log file paths' },
        from_time: { type: 'string', description: "e.g. '2026-08-27 02:46:00'" },
        to_time: { type: 'string' },
      },
      required: ['paths'],
    },
    handler: async (a, ctx) => {
      const paths = (Array.isArray(a.paths) ? a.paths : []).map((x) => resolveSenseiPath(String(x), ctx.cwd));
      const missing = paths.filter((p) => {
        try {
          return !fs.statSync(p).isFile();
        } catch {
          return true;
        }
      });
      if (missing.length > 0) return `ERROR: file(s) not found: ${missing.join(', ')}`;
      if (paths.length < 2) return 'ERROR: log_timeline needs at least 2 paths';
      let fromT = -Infinity;
      let toT = Infinity;
      if (a.from_time) {
        const t = Date.parse(String(a.from_time));
        if (Number.isNaN(t)) return `ERROR: could not parse from_time/to_time: '${a.from_time}'`;
        fromT = t;
      }
      if (a.to_time) {
        const t = Date.parse(String(a.to_time));
        if (Number.isNaN(t)) return `ERROR: could not parse from_time/to_time: '${a.to_time}'`;
        toT = t;
      }
      const cursors = await Promise.all(paths.map((p) => newLogCursor(p, ctx.configDir)));
      const out: string[] = [];
      out.push(`[log_timeline — ${paths.length} files, ${a.from_time ?? 'start'} → ${a.to_time ?? 'end'}]`);
      let emitted = 0;
      try {
        for (const c of cursors) c.block = await readLogBlock(c);
        while (emitted < MAX_LINES) {
          const live = cursors.filter((c) => c.block !== null);
          if (live.length === 0) break;
          let pick = live[0];
          for (const c of live) {
            const a1 = c.block!.ts ?? -Infinity;
            const b1 = pick.block!.ts ?? -Infinity;
            if (a1 < b1) pick = c;
          }
          const blk = pick.block!;
          pick.block = await readLogBlock(pick);
          if (blk.ts !== null && blk.ts > toT) continue;
          if (blk.ts !== null && blk.ts < fromT) continue;
          for (const ln of blk.text.split('\n')) {
            out.push(`[${pick.name}] ${ln}`);
            emitted++;
          }
        }
        if (emitted >= MAX_LINES) out.push(`[capped at ${MAX_LINES} lines — narrow the time window]`);
      } finally {
        for (const c of cursors) c.rl.close();
      }
      return out.join('\n') + '\n';
    },
  });
}
