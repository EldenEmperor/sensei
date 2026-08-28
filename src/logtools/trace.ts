// log_trace — follow a correlation/request id across files, in timestamp order.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolveSenseiPath } from '../core/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { getFormatHints } from './formatMap.js';
import { getLineTimestamp } from './timestamps.js';

const CAP = 1000;

export function registerLogTrace(registry: ToolRegistry): void {
  registry.register({
    name: 'log_trace',
    readOnly: true,
    description:
      'Follow a correlation/request/trace id across one or more log files: every matching line, in timestamp order, tagged with source:line.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id/token to trace (literal, case-insensitive)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files to scan (default: cwd *.log)' },
      },
      required: ['id'],
    },
    handler: async (a, ctx) => {
      const id = String(a.id ?? '');
      if (!id) return 'ERROR: id is required';
      const paths = Array.isArray(a.paths)
        ? a.paths.map((x) => resolveSenseiPath(String(x), ctx.cwd))
        : fs
            .readdirSync(ctx.cwd)
            .filter((n) => n.endsWith('.log'))
            .map((n) => path.join(ctx.cwd, n))
            .filter((p) => {
              try {
                return fs.statSync(p).isFile();
              } catch {
                return false;
              }
            });
      if (paths.length === 0) return 'ERROR: no files to scan (pass paths, or run where *.log files exist)';
      const idLower = id.toLowerCase();
      const hits: { ts: number | null; name: string; lineNo: number; line: string }[] = [];
      for (const p of paths) {
        try {
          if (!fs.statSync(p).isFile()) continue;
        } catch {
          continue;
        }
        const name = path.basename(p);
        const pHints = getFormatHints(p, ctx.configDir);
        const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
        try {
          let n = 0;
          let lastTs: number | null = null;
          for await (const line of rl) {
            n++;
            const ts = getLineTimestamp(line, pHints);
            if (ts !== null) lastTs = ts;
            if (line.toLowerCase().includes(idLower)) {
              hits.push({ ts: lastTs, name, lineNo: n, line });
              if (hits.length >= CAP) break;
            }
          }
        } finally {
          rl.close();
        }
        if (hits.length >= CAP) break;
      }
      if (hits.length === 0) return `no lines mention '${id}' in ${paths.length} file(s)`;
      const sorted = [...hits].sort((x, y) => (x.ts ?? Infinity) - (y.ts ?? Infinity));
      const out: string[] = [];
      out.push(`[log_trace '${id}' — ${hits.length} line(s) across ${paths.length} file(s)]`);
      for (const h of sorted) out.push(`${h.name}:${h.lineNo}: ${h.line}`);
      if (hits.length >= CAP) out.push(`[capped at ${CAP} matches]`);
      return out.join('\n') + '\n';
    },
  });
}
