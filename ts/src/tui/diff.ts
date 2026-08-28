// Diff previews for the permission prompt, ported from Write-SenseiDiff.
// write_file overwrites get a real line diff (the PS variant used unordered
// Compare-Object; diffLines is strictly better and keeps the same summary).

import fs from 'node:fs';
import { diffLines } from 'diff';
import { resolveSenseiPath } from '../core/permissions.js';
import { protectTerminalText, type Theme } from './theme.js';

export function renderDiffPreview(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  t: Theme,
): string[] {
  const out: string[] = [];
  try {
    if (name === 'edit_file') {
      const oldLines = String(args.old_string ?? '').split(/\r?\n/);
      const newLines = String(args.new_string ?? '').split(/\r?\n/);
      for (const l of oldLines.slice(0, 20)) out.push('  ' + t.red('- ' + protectTerminalText(l)));
      if (oldLines.length > 20) out.push(t.dim(`  … ${oldLines.length - 20} more removed lines`));
      for (const l of newLines.slice(0, 20)) out.push('  ' + t.green('+ ' + protectTerminalText(l)));
      if (newLines.length > 20) out.push(t.dim(`  … ${newLines.length - 20} more added lines`));
    } else if (name === 'write_file') {
      const p = resolveSenseiPath(String(args.path ?? ''), cwd);
      const newContent = String(args.content ?? '');
      const newLines = newContent.split(/\r?\n/);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const oldContent = fs.readFileSync(p, 'utf8');
        const parts = diffLines(oldContent, newContent);
        let minus = 0;
        let plus = 0;
        let shown = 0;
        for (const part of parts) {
          if (!part.added && !part.removed) continue;
          for (const l of part.value.replace(/\n$/, '').split('\n')) {
            if (part.removed) {
              minus++;
              if (shown < 40) out.push('  ' + t.red('- ' + protectTerminalText(l)));
            } else {
              plus++;
              if (shown < 40) out.push('  ' + t.green('+ ' + protectTerminalText(l)));
            }
            shown++;
          }
        }
        out.push(t.dim(`  (overwrite: -${minus}/+${plus} changed lines vs the existing file)`));
      } else {
        for (const l of newLines.slice(0, 20)) out.push('  ' + t.green('+ ' + protectTerminalText(l)));
        out.push(t.dim(`  (new file, ${newLines.length} lines)`));
      }
    }
  } catch (e) {
    out.push(t.dim(`  (diff preview unavailable: ${(e as Error).message})`));
  }
  return out;
}
