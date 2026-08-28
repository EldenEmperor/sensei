// M3 pure-function tests: markdown renderer, ESC sanitizer, theme, diff preview.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDiffPreview } from '../src/tui/diff.js';
import { renderMarkdown } from '../src/tui/markdown.js';
import { ACCENT_PRESETS, makeTheme, protectTerminalText, resolveAccent } from '../src/tui/theme.js';
import { makeTempDir } from './helpers.js';

const plain = makeTheme(ACCENT_PRESETS.indigo, false); // identity wrappers
const themed = makeTheme(ACCENT_PRESETS.indigo, true);

describe('markdown renderer', () => {
  it('renders headers, bullets, bold and inline code with theme off as plain text', () => {
    const out = renderMarkdown('# Title\n- item one\n**bold** and `code`', plain);
    expect(out).toBe('Title\n• item one\nbold and code');
  });

  it('emits ANSI when themed', () => {
    const out = renderMarkdown('# Title', themed);
    expect(out).toContain('\x1b[');
    expect(out).toContain('Title');
  });

  it('hides code-fence markers and marks code lines', () => {
    const out = renderMarkdown('before\n```js\nconst x = 1;\n```\nafter', plain);
    expect(out).toBe('before\n  const x = 1;\nafter');
  });

  it('strips think blocks entirely', () => {
    expect(renderMarkdown('<think>secret reasoning</think>the answer', plain)).toBe('the answer');
    expect(renderMarkdown('<think>only thinking</think>', plain)).toBe('');
  });

  it('handles multi-line think blocks in line mode', () => {
    const out = renderMarkdown('start\n<think>\nhidden\n</think>\nend', plain);
    expect(out).toBe('start\nend');
  });
});

describe('terminal safety', () => {
  it('neutralizes raw ESC characters', () => {
    expect(protectTerminalText('evil \x1b[31mred\x1b[0m')).toBe('evil ␛[31mred␛[0m');
  });
  it('renderer sanitizes model text', () => {
    const out = renderMarkdown('danger \x1b[2J', plain);
    expect(out).not.toContain('\x1b');
    expect(out).toContain('␛');
  });
});

describe('accent resolution', () => {
  it('resolves presets and hex forms', () => {
    expect(resolveAccent('jade')).toBe(0x3cb371);
    expect(resolveAccent('#E0533D')).toBe(0xe0533d);
    expect(resolveAccent('0x123abc')).toBe(0x123abc);
    expect(resolveAccent('nope')).toBeNull();
  });
});

describe('diff preview', () => {
  it('edit_file shows -/+ lines', () => {
    const out = renderDiffPreview('edit_file', { old_string: 'alpha', new_string: 'beta' }, 'C:\\x', plain);
    expect(out).toEqual(['  - alpha', '  + beta']);
  });

  it('write_file over an existing file shows a real line diff with counts', () => {
    const tmp = makeTempDir('sensei-ts-diff-');
    const p = path.join(tmp, 'f.txt');
    fs.writeFileSync(p, 'one\ntwo\nthree');
    const out = renderDiffPreview('write_file', { path: p, content: 'one\nTWO\nthree' }, tmp, plain);
    expect(out).toContain('  - two');
    expect(out).toContain('  + TWO');
    expect(out.at(-1)).toMatch(/overwrite: -1\/\+1 changed lines/);
  });

  it('write_file for a new file shows + lines and a summary', () => {
    const tmp = makeTempDir('sensei-ts-diff2-');
    const out = renderDiffPreview('write_file', { path: path.join(tmp, 'new.txt'), content: 'a\nb' }, tmp, plain);
    expect(out).toEqual(['  + a', '  + b', '  (new file, 2 lines)']);
  });
});
