// log_baseline — capture a log's profile, then diff a later run against it.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolveSenseiPath } from '../core/permissions.js';
import type { ToolContext, ToolRegistry } from '../tools/registry.js';
import { getFormatHints } from './formatMap.js';
import { getLevelRegex } from './levels.js';
import { getLogTemplate } from './template.js';
import { getLineTimestamp } from './timestamps.js';

export interface BaselineData {
  total: number;
  levels: Record<string, number>;
  templates: Record<string, number>;
  template_version: number;
  first: string | null;
  last: string | null;
}

/** One streaming pass: totals, level counts, error/warn templates. */
export async function getBaselineData(p: string, ctx: ToolContext): Promise<BaselineData> {
  const hints = getFormatHints(p, ctx.configDir);
  const levelRx = getLevelRegex(hints);
  const levels: Record<string, number> = { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0 };
  const templates: Record<string, number> = {};
  let total = 0;
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
      if (!m) continue;
      let level = m[1].toUpperCase();
      if (hints?.levelFold && hints.levelFold[level]) level = hints.levelFold[level];
      else if (level === 'WARNING') level = 'WARN';
      levels[level] = (levels[level] ?? 0) + 1;
      if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
        const key = `[${level}] ` + getLogTemplate(line);
        templates[key] = (templates[key] ?? 0) + 1;
      }
    }
  } finally {
    rl.close();
  }
  return {
    total,
    levels,
    templates,
    template_version: 2,
    first: firstTs !== null ? new Date(firstTs).toISOString() : null,
    last: lastTs !== null ? new Date(lastTs).toISOString() : null,
  };
}

export function registerLogBaseline(registry: ToolRegistry): void {
  registry.register({
    name: 'log_baseline',
    readOnly: true,
    description:
      "Capture a log's profile as a named baseline (action=save), or compare a log against a saved baseline (action=diff) to surface NEW error templates and count spikes. Answers 'what changed since the last good run?'",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'diff', 'list'] },
        path: { type: 'string' },
        name: { type: 'string', description: 'Baseline name (default: log file name)' },
      },
      required: ['action'],
    },
    handler: async (a, ctx) => {
      const dir = path.join(ctx.configDir, 'baselines');
      fs.mkdirSync(dir, { recursive: true });
      const action = String(a.action);
      if (action === 'list') {
        const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
        if (files.length === 0) return 'no baselines saved';
        return 'baselines: ' + files.map((n) => n.replace(/\.json$/, '')).join(', ');
      }
      const p = resolveSenseiPath(String(a.path ?? ''), ctx.cwd);
      try {
        if (!fs.statSync(p).isFile()) return `ERROR: file not found: ${p}`;
      } catch {
        return `ERROR: file not found: ${p}`;
      }
      const name = a.name ? String(a.name) : path.basename(p).replace(/[^\w.-]/g, '_');
      const bpath = path.join(dir, `${name}.json`);
      const data = await getBaselineData(p, ctx);
      if (action === 'save') {
        fs.writeFileSync(bpath, JSON.stringify(data, null, 1), 'utf8');
        return `saved baseline '${name}' (${data.total} lines, ${Object.keys(data.templates).length} error/warn templates)`;
      }
      if (action === 'diff') {
        if (!fs.existsSync(bpath)) return `ERROR: no baseline named '${name}' (save one first)`;
        const base = JSON.parse(fs.readFileSync(bpath, 'utf8')) as Partial<BaselineData>;
        const out: string[] = [];
        out.push(`[log_baseline diff — ${p} vs baseline '${name}']`);
        if (Number(base.template_version ?? 0) !== 2) {
          out.push('NOTE: baseline saved with older template rules — re-save it; this diff may over-report NEW templates');
        }
        out.push(`lines: ${base.total} → ${data.total}`);
        const baseTemplates = base.templates ?? {};
        const newT = Object.keys(data.templates).filter((k) => !(k in baseTemplates));
        const goneT = Object.keys(baseTemplates).filter((k) => !(k in data.templates));
        const spikes: string[] = [];
        for (const k of Object.keys(data.templates)) {
          if (k in baseTemplates) {
            const b = Number(baseTemplates[k]);
            const c = data.templates[k];
            if (b > 0 && c >= 3 * b && c - b >= 5) {
              spikes.push(`  ${Math.round((c / b) * 10) / 10}× (was ${b}, now ${c}) ${k}`);
            }
          }
        }
        if (newT.length > 0) {
          out.push(`NEW error/warn templates (${newT.length}):`);
          for (const t of newT.slice(0, 20)) out.push(`  + [${data.templates[t]}×] ${t}`);
        }
        if (spikes.length > 0) {
          out.push('COUNT SPIKES:');
          for (const s of spikes.slice(0, 20)) out.push(s);
        }
        if (goneT.length > 0) out.push(`templates that disappeared: ${goneT.length}`);
        if (newT.length === 0 && spikes.length === 0) {
          out.push('no new templates or count spikes — profile looks consistent with the baseline');
        }
        return out.join('\n') + '\n';
      }
      return `ERROR: unknown action '${action}' (save|diff|list)`;
    },
  });
}
