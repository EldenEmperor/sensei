// log_investigate — the tool wrapper over the format-map engine.

import fs from 'node:fs';
import { resolveSenseiPath } from '../core/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { formatMapSummary, getFormatMap } from './formatMap.js';

export function registerLogInvestigate(registry: ToolRegistry): void {
  registry.register({
    name: 'log_investigate',
    readOnly: true,
    primaryArg: 'path',
    description:
      'Deep structural analysis of ANY unknown log file: detects the format family (json-lines, logfmt, csv, apache/w3c access, timestamped text…), timestamp styles and coverage, level vocabulary, field types and cardinality, repeated templates, and rare/unique events. Saves a reusable format map that makes the other log tools understand the file. Call this when log_stats finds no timestamps/levels or the format is unfamiliar.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        refresh: { type: 'boolean', description: 'Re-analyze even if a cached map exists' },
      },
      required: ['path'],
    },
    handler: async (a, ctx) => {
      const p = resolveSenseiPath(String(a.path), ctx.cwd);
      try {
        if (!fs.statSync(p).isFile()) return `ERROR: file not found: ${p}`;
      } catch {
        return `ERROR: file not found: ${p}`;
      }
      const r = await getFormatMap(p, ctx.configDir, { refresh: Boolean(a.refresh) });
      if (!r) return `ERROR: could not analyze ${p}`;
      return formatMapSummary(r.map, r.cached);
    },
  });
}
