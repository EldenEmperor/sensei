// log_slice — read part of a (possibly huge) log with absolute line numbers.
// Streams in every branch; the tail branch keeps a ring buffer in one pass.

import fs from 'node:fs';
import readline from 'node:readline';
import { resolveSenseiPath } from '../core/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { getFormatHints } from './formatMap.js';
import { getLineTimestamp } from './timestamps.js';

const MAX_LINES = 2000;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const numbered = (i: number, line: string) => `${String(i).padStart(8)}→${line}`;

export function registerLogSlice(registry: ToolRegistry): void {
  registry.register({
    name: 'log_slice',
    readOnly: true,
    primaryArg: 'path',
    description:
      'Efficiently read part of a (possibly huge) log file with absolute line numbers. Provide exactly one of: tail=N, head=N, from_line/to_line, or from_time/to_time. Never loads the whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        tail: { type: 'integer', description: 'Last N lines' },
        head: { type: 'integer', description: 'First N lines' },
        from_line: { type: 'integer', description: '1-based start line' },
        to_line: { type: 'integer', description: '1-based end line (default from_line+199)' },
        from_time: { type: 'string', description: "Start timestamp, e.g. '2026-08-27 02:46:00'" },
        to_time: { type: 'string', description: "End timestamp, e.g. '2026-08-27 02:48:00'" },
      },
      required: ['path'],
    },
    handler: async (a, ctx) => {
      const p = resolveSenseiPath(String(a.path), ctx.cwd);
      if (!isFile(p)) return `ERROR: file not found: ${p}`;
      const out: string[] = [];

      if (a.tail) {
        const n = Math.min(MAX_LINES, Math.max(1, Number(a.tail)));
        const ring: string[] = [];
        let total = 0;
        const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            total++;
            ring.push(line);
            if (ring.length > n) ring.shift();
          }
        } finally {
          rl.close();
        }
        out.push(`[${p} — last ${ring.length} of ${total} lines]`);
        let i = total - ring.length + 1;
        for (const l of ring) out.push(numbered(i++, l));
        return out.join('\n') + '\n';
      }

      if (a.head) {
        const n = Math.min(MAX_LINES, Math.max(1, Number(a.head)));
        out.push(`[${p} — first ${n} lines]`);
        let i = 0;
        const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            i++;
            out.push(numbered(i, line));
            if (i >= n) break;
          }
        } finally {
          rl.close();
        }
        return out.join('\n') + '\n';
      }

      if (a.from_line || a.to_line) {
        const from = Math.max(1, Number(a.from_line ?? 1));
        let to = a.to_line ? Number(a.to_line) : from + 199;
        if (to < from) return 'ERROR: to_line is before from_line';
        if (to - from + 1 > MAX_LINES) {
          to = from + MAX_LINES - 1;
          out.push(`[range capped at ${MAX_LINES} lines]`);
        }
        out.push(`[${p} — lines ${from}..${to}]`);
        let i = 0;
        const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            i++;
            if (i < from) continue;
            if (i > to) break;
            out.push(numbered(i, line));
          }
        } finally {
          rl.close();
        }
        if (i < from) return `ERROR: from_line ${from} is past the end of the file (${i} lines)`;
        return out.join('\n') + '\n';
      }

      if (a.from_time || a.to_time) {
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
        out.push(`[${p} — ${a.from_time ?? 'start'} → ${a.to_time ?? 'end'}]`);
        let i = 0;
        let emitted = 0;
        let current: number | null = null; // last seen timestamp; untimestamped lines belong to it
        const hints = getFormatHints(p, ctx.configDir);
        const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            i++;
            const ts = getLineTimestamp(line, hints);
            if (ts !== null) {
              if (ts > toT) break; // logs are time-ordered: done
              current = ts;
            }
            if (current === null || current < fromT) continue;
            out.push(numbered(i, line));
            emitted++;
            if (emitted >= MAX_LINES) {
              out.push(`[capped at ${MAX_LINES} lines — narrow the time range]`);
              break;
            }
          }
        } finally {
          rl.close();
        }
        if (emitted === 0) out.push('(no lines in that time range)');
        return out.join('\n') + '\n';
      }

      return 'ERROR: specify exactly one of tail, head, from_line/to_line, or from_time/to_time';
    },
  });
}
