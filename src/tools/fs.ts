// File tools: read_file, write_file, edit_file, multi_edit — ported from src\tools.ps1.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolveSenseiPath } from '../core/permissions.js';
import type { ToolRegistry } from './registry.js';

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = text.indexOf(needle, idx);
    if (idx < 0) break;
    count++;
    idx += needle.length;
  }
  return count;
}

function applyOneEdit(
  text: string,
  old: string,
  replacement: string,
  replaceAll: boolean,
): { text: string; count: number } | { error: string } {
  const count = countOccurrences(text, old);
  if (count === 0) return { error: 'not_found' };
  if (count > 1 && !replaceAll) return { error: `multiple:${count}` };
  if (replaceAll) return { text: text.split(old).join(replacement), count };
  const idx = text.indexOf(old);
  return { text: text.slice(0, idx) + replacement + text.slice(idx + old.length), count };
}

export function registerFsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'read_file',
    readOnly: true,
    primaryArg: 'path',
    description:
      'Read a text file with line numbers. Use offset/limit to page through large files. For log files prefer log_stats and log_slice.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
        offset: { type: 'integer', description: '1-based line number to start from (default 1)' },
        limit: { type: 'integer', description: 'Maximum lines to return (default 2000)' },
      },
      required: ['path'],
    },
    handler: async (a, ctx) => {
      const p = resolveSenseiPath(String(a.path), ctx.cwd);
      if (!isFile(p)) return `ERROR: file not found: ${p}`;
      if (/\.(png|jpe?g|gif|webp)$/i.test(p)) {
        return `This is a binary image file — I can't read it as text. If the USER wants me to look at it, they can attach it to a message with @${String(a.path)} (images attach as vision input).`;
      }
      const offset = Math.max(1, Number(a.offset ?? 1));
      const limit = Math.max(1, Number(a.limit ?? 2000));
      const out: string[] = [];
      let n = 0;
      let emitted = 0;
      const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          n++;
          if (n < offset) continue;
          if (emitted >= limit) {
            out.push(`[more lines follow — call again with offset=${n}]`);
            break;
          }
          out.push(`${String(n).padStart(6)}→${line}`);
          emitted++;
        }
      } finally {
        rl.close();
      }
      if (emitted === 0) return `ERROR: offset ${offset} is past the end of the file (${n} lines)`;
      return out.join('\n') + '\n';
    },
  });

  registry.register({
    name: 'write_file',
    readOnly: false,
    primaryArg: 'path',
    description:
      'Create or overwrite a text file with the given content (UTF-8, no BOM). Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    handler: (a, ctx) => {
      const p = resolveSenseiPath(String(a.path), ctx.cwd);
      const dir = path.dirname(p);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      const content = String(a.content ?? '');
      fs.writeFileSync(p, content, 'utf8');
      return `Wrote ${content.length} chars to ${p}`;
    },
  });

  registry.register({
    name: 'edit_file',
    readOnly: false,
    primaryArg: 'path',
    description:
      'Replace an exact string in a file. old_string must match exactly once unless replace_all is true; include surrounding lines to make it unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to find (must be unique in the file unless replace_all)' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    handler: (a, ctx) => {
      const p = resolveSenseiPath(String(a.path), ctx.cwd);
      if (!isFile(p)) return `ERROR: file not found: ${p}`;
      const old = String(a.old_string ?? '');
      const replacement = String(a.new_string ?? '');
      if (old === '') return 'ERROR: old_string must not be empty';
      const text = fs.readFileSync(p, 'utf8');
      const r = applyOneEdit(text, old, replacement, Boolean(a.replace_all ?? false));
      if ('error' in r) {
        if (r.error === 'not_found') return `ERROR: old_string not found in ${p}`;
        const count = r.error.split(':')[1];
        return `ERROR: old_string occurs ${count} times in ${p}; add surrounding context to make it unique, or set replace_all=true`;
      }
      fs.writeFileSync(p, r.text, 'utf8');
      return `Edited ${p} (${r.count} replacement${r.count !== 1 ? 's' : ''})`;
    },
  });

  registry.register({
    name: 'multi_edit',
    readOnly: false,
    primaryArg: 'path',
    description:
      'Apply several exact-string edits to one file atomically, in order. Each edit follows edit_file rules (old_string unique unless replace_all). If ANY edit fails to match, the file is left unchanged and an error names the failing edit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    handler: (a, ctx) => {
      const p = resolveSenseiPath(String(a.path), ctx.cwd);
      if (!isFile(p)) return `ERROR: file not found: ${p}`;
      const edits = Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : [];
      if (edits.length === 0) return 'ERROR: no edits provided';
      let text = fs.readFileSync(p, 'utf8');
      let applied = 0;
      for (let i = 0; i < edits.length; i++) {
        const old = String(edits[i].old_string ?? '');
        const replacement = String(edits[i].new_string ?? '');
        if (old === '') return `ERROR: edit #${i + 1}: old_string must not be empty (no changes written)`;
        const r = applyOneEdit(text, old, replacement, Boolean(edits[i].replace_all ?? false));
        if ('error' in r) {
          if (r.error === 'not_found') return `ERROR: edit #${i + 1}: old_string not found (no changes written)`;
          const count = r.error.split(':')[1];
          return `ERROR: edit #${i + 1}: old_string occurs ${count} times; add context or set replace_all (no changes written)`;
        }
        text = r.text;
        applied++;
      }
      fs.writeFileSync(p, text, 'utf8');
      return `Applied ${applied} edit(s) to ${p}`;
    },
  });
}
