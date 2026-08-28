// glob + grep tools, ported from src\tools.ps1 with the same output formats.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import fg from 'fast-glob';
import { likeMatch, resolveSenseiPath } from '../core/permissions.js';
import type { ToolRegistry } from './registry.js';

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Same glob→regex translation as the PS variant: '*.log' matches only the top
 *  level; '**\/*.log' matches recursively. */
export function globPatternToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let rx = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  rx = rx.replace(/\\\*\\\*\//g, '(?:.*/)?');
  rx = rx.replace(/\\\*\\\*/g, '.*');
  rx = rx.replace(/\\\*/g, '[^/]*');
  rx = rx.replace(/\\\?/g, '.');
  return new RegExp(`^${rx}$`);
}

export function registerSearchTools(registry: ToolRegistry): void {
  registry.register({
    name: 'glob',
    readOnly: true,
    primaryArg: 'path',
    description:
      "Find files by glob pattern, newest first (max 200). '*.log' matches only the top level of the search root; '**/*.log' matches recursively.",
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob pattern, e.g. '**/*.log' or 'src/*.ps1'" },
        path: { type: 'string', description: 'Directory to search (default: working directory)' },
      },
      required: ['pattern'],
    },
    handler: async (a, ctx) => {
      const root = resolveSenseiPath(String(a.path ?? '.'), ctx.cwd);
      if (!isDir(root)) return `ERROR: directory not found: ${root}`;
      const rx = globPatternToRegex(String(a.pattern));
      const entries = await fg('**/*', {
        cwd: root,
        onlyFiles: true,
        dot: true,
        suppressErrors: true,
        stats: true,
      });
      const found = entries.filter((e) => rx.test(e.path.replace(/\\/g, '/')));
      if (found.length === 0) return `No files match '${a.pattern}' under ${root}`;
      const sorted = [...found]
        .sort((x, y) => (y.stats?.mtimeMs ?? 0) - (x.stats?.mtimeMs ?? 0))
        .slice(0, 200);
      let out = sorted.map((e) => path.join(root, e.path)).join('\n');
      if (found.length > 200) out += `\n[showing newest 200 of ${found.length} matches]`;
      return out;
    },
  });

  registry.register({
    name: 'grep',
    readOnly: true,
    primaryArg: 'path',
    description:
      'Regex content search across files (case-insensitive by default). Modes: files_with_matches (default), content (file:line:text with optional context), count (per-file match counts).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', description: 'File or directory to search (default: working directory)' },
        glob: { type: 'string', description: "Filename filter when searching a directory, e.g. '*.log'" },
        output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
        context: { type: 'integer', description: 'Lines of context before/after each match (content mode only)' },
        case_sensitive: { type: 'boolean', description: 'Default false' },
        head_limit: { type: 'integer', description: 'Max results to return (default 100)' },
      },
      required: ['pattern'],
    },
    handler: async (a, ctx) => {
      const root = resolveSenseiPath(String(a.path ?? '.'), ctx.cwd);
      let files: string[];
      if (isFile(root)) {
        files = [root];
      } else if (isDir(root)) {
        const nameFilter = String(a.glob ?? '*');
        const entries = await fg('**/*', { cwd: root, onlyFiles: true, dot: true, suppressErrors: true });
        files = entries
          .filter((rel) => likeMatch(path.basename(rel), nameFilter))
          .map((rel) => path.join(root, rel));
      } else {
        return `ERROR: path not found: ${root}`;
      }
      if (files.length === 0) return `ERROR: no files to search under ${root}`;

      const cs = Boolean(a.case_sensitive ?? false);
      const limit = Math.max(1, Number(a.head_limit ?? 100));
      const mode = String(a.output_mode ?? 'files_with_matches');
      let rx: RegExp;
      try {
        rx = new RegExp(String(a.pattern), cs ? '' : 'i');
      } catch (e) {
        return `ERROR: invalid regex: ${(e as Error).message}`;
      }

      if (mode === 'files_with_matches') {
        const out: string[] = [];
        for (const f of files) {
          if (out.length >= limit) break;
          const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
          try {
            for await (const line of rl) {
              if (rx.test(line)) {
                out.push(f);
                break;
              }
            }
          } catch {
            /* unreadable file — skip */
          } finally {
            rl.close();
          }
        }
        if (out.length === 0) return `No matches for '${a.pattern}'`;
        return out.join('\n');
      }

      if (mode === 'count') {
        const counts: { file: string; count: number }[] = [];
        for (const f of files) {
          let n = 0;
          const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
          try {
            for await (const line of rl) if (rx.test(line)) n++;
          } catch {
            /* skip */
          } finally {
            rl.close();
          }
          if (n > 0) counts.push({ file: f, count: n });
        }
        if (counts.length === 0) return `No matches for '${a.pattern}'`;
        counts.sort((x, y) => y.count - x.count);
        return counts
          .slice(0, limit)
          .map((c) => `${c.count}\t${c.file}`)
          .join('\n');
      }

      if (mode === 'content') {
        const ctxLines = Math.max(0, Number(a.context ?? 0));
        const out: string[] = [];
        let emitted = 0;
        for (const f of files) {
          if (emitted >= limit) break;
          let lines: string[];
          try {
            lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
          } catch {
            continue;
          }
          for (let i = 0; i < lines.length && emitted < limit; i++) {
            if (!rx.test(lines[i])) continue;
            const lineNo = i + 1;
            if (ctxLines > 0) {
              const preStart = Math.max(0, i - ctxLines);
              for (let j = preStart; j < i; j++) out.push(`${f}:${j + 1}- ${lines[j]}`);
            }
            out.push(`${f}:${lineNo}:${lines[i]}`);
            if (ctxLines > 0) {
              const postEnd = Math.min(lines.length - 1, i + ctxLines);
              for (let j = i + 1; j <= postEnd; j++) out.push(`${f}:${j + 1}- ${lines[j]}`);
              out.push('--');
            }
            emitted++;
          }
        }
        if (emitted === 0) return `No matches for '${a.pattern}'`;
        return out.join('\n') + '\n';
      }

      return `ERROR: unknown output_mode '${mode}'`;
    },
  });
}
