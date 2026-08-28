// log_stats — cheap single-pass profile of a log file.

import fs from 'node:fs';
import readline from 'node:readline';
import { resolveSenseiPath } from '../core/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { getFormatHints } from './formatMap.js';
import { getLevelRegex } from './levels.js';
import { getLogTemplate } from './template.js';
import { formatLocal, formatLocalShort, getLineTimestamp } from './timestamps.js';

const n0 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });
const n1 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function registerLogStats(registry: ToolRegistry): void {
  registry.register({
    name: 'log_stats',
    readOnly: true,
    primaryArg: 'path',
    description:
      'Cheap single-pass analysis of a log file: line/byte totals, log-level counts, time range, error frequency over time buckets, and the most common ERROR/WARN/FATAL message templates. ALWAYS call this before reading a log file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    handler: async (a, ctx) => {
      const p = resolveSenseiPath(String(a.path), ctx.cwd);
      let bytes: number;
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) return `ERROR: file not found: ${p}`;
        bytes = st.size;
      } catch {
        return `ERROR: file not found: ${p}`;
      }
      const hints = getFormatHints(p, ctx.configDir);
      const levelRx = getLevelRegex(hints);
      const levels: Record<string, number> = { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0 };
      const levelOrder = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
      const templates = new Map<string, number>();
      const errTimes: number[] = [];
      let total = 0;
      let noLevel = 0;
      let firstTs: number | null = null;
      let lastTs: number | null = null;

      const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          total++;
          const ts = getLineTimestamp(line, hints);
          if (ts !== null) {
            if (firstTs === null) firstTs = ts;
            lastTs = ts;
          }
          const m = levelRx.exec(line);
          if (!m) {
            noLevel++;
            continue;
          }
          let level = m[1].toUpperCase();
          if (hints?.levelFold && hints.levelFold[level]) level = hints.levelFold[level];
          else if (level === 'WARNING') level = 'WARN';
          if (!(level in levels)) {
            levels[level] = 0;
            levelOrder.push(level);
          }
          levels[level]++;
          if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
            const key = `[${level}] ` + getLogTemplate(line);
            templates.set(key, (templates.get(key) ?? 0) + 1);
            if (level !== 'WARN' && ts !== null) errTimes.push(ts);
          }
        }
      } finally {
        rl.close();
      }

      const out: string[] = [];
      out.push(`[log_stats — ${p}]`);
      out.push(`lines: ${n0(total)}   size: ${n1(bytes / 1048576)} MB   lines without a recognized level: ${n0(noLevel)}`);
      if (firstTs !== null && lastTs !== null) {
        const spanMs = lastTs - firstTs;
        const hours = Math.floor(spanMs / 3600000);
        const minutes = Math.floor((spanMs % 3600000) / 60000);
        out.push(`time range: ${formatLocal(firstTs)} → ${formatLocal(lastTs)}  (${hours}h ${minutes}m)`);
      } else {
        out.push('time range: no recognizable timestamps found');
      }
      out.push(
        'levels: ' +
          levelOrder
            .filter((k) => levels[k] > 0)
            .map((k) => `${k}: ${levels[k]}`)
            .join(' | '),
      );

      if (errTimes.length > 0 && firstTs !== null && lastTs !== null) {
        const spanMin = (lastTs - firstTs) / 60000;
        const bucketMin = spanMin <= 90 ? 1 : spanMin <= 1440 ? 10 : 60;
        const buckets = new Map<number, number>();
        for (const t of errTimes) {
          const d = new Date(t);
          const b =
            bucketMin === 60
              ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0).getTime()
              : new Date(
                  d.getFullYear(),
                  d.getMonth(),
                  d.getDate(),
                  d.getHours(),
                  Math.floor(d.getMinutes() / bucketMin) * bucketMin,
                  0,
                ).getTime();
          buckets.set(b, (buckets.get(b) ?? 0) + 1);
        }
        const keys = [...buckets.keys()].sort((x, y) => x - y);
        const maxCount = Math.max(...buckets.values());
        out.push(`error/fatal frequency (${bucketMin}m buckets):`);
        for (const k of keys) {
          const v = buckets.get(k)!;
          // PS's [int] cast rounds (banker's); Math.round matches it for these values
          const bar = '#'.repeat(Math.max(1, Math.round((30 * v) / maxCount)));
          out.push(`  ${formatLocalShort(k)}  ${String(v).padStart(6)}  ${bar}`);
        }
      }

      if (templates.size > 0) {
        out.push('top error/warn templates:');
        const top = [...templates.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15);
        for (const [key, count] of top) {
          const tmpl = key.length > 160 ? key.slice(0, 157) + '…' : key;
          out.push(`  ${String(count).padStart(7)} × ${tmpl}`);
        }
      }
      return out.join('\n') + '\n';
    },
  });
}
