// M3 pure-function tests: markdown renderer, ESC sanitizer, theme, diff preview.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDiffPreview } from '../src/tui/diff.js';
import { parseBanner, parseSprites } from '../src/tui/index.js';
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

describe('banner parsing', () => {
  it('plain files become one static frame', () => {
    const frames = parseBanner('line one\nline two\n');
    expect(frames.length).toBe(1);
    expect(frames[0].lines).toEqual(['line one', 'line two']);
  });

  it('animated format yields frames with delays', () => {
    const raw = '%%SENSEI-BANNER-ANIM v1\n%%FRAME 100\naaa\nbbb\n%%FRAME 250\nccc\nddd\n';
    const frames = parseBanner(raw);
    expect(frames.length).toBe(2);
    expect(frames[0].delayMs).toBe(100);
    expect(frames[0].lines).toEqual(['aaa', 'bbb']);
    expect(frames[1].delayMs).toBe(250);
    expect(frames[1].lines).toEqual(['ccc', 'ddd']);
  });

  it('the committed banner parses as a multi-frame animation', () => {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const p = path.resolve(here, '..', 'assets', 'banner.txt');
    const frames = parseBanner(fs.readFileSync(p, 'utf8'));
    expect(frames.length).toBeGreaterThan(1);
    const heights = new Set(frames.map((f) => f.lines.length));
    expect(heights.size).toBe(1); // all frames align
  });
});

describe('sprite parsing', () => {
  it('parses animations with delay and mode', () => {
    const raw =
      '%%SENSEI-SPRITES v1\n%%ANIM slash 90 loop\n%%FRAME\naa\nbb\n%%FRAME\ncc\ndd\n%%ANIM sheath 120 once\n%%FRAME\nee\n';
    const anims = parseSprites(raw);
    expect(Object.keys(anims).sort()).toEqual(['sheath', 'slash']);
    expect(anims.slash.delayMs).toBe(90);
    expect(anims.slash.mode).toBe('loop');
    expect(anims.slash.frames.length).toBe(2);
    expect(anims.slash.frames[1]).toEqual(['cc', 'dd']);
    expect(anims.sheath.mode).toBe('once');
  });

  it('the committed sprite sheet has the event animations, frames aligned', () => {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const anims = parseSprites(fs.readFileSync(path.resolve(here, '..', 'assets', 'sprites.txt'), 'utf8'));
    // thinking/slash = the red-vs-blue duel, scout = the spyglass, summonN =
    // the mini melee with one clone per active subagent (capped at three)
    expect(Object.keys(anims).sort()).toEqual(['scout', 'sheath', 'slash', 'spawn', 'summon', 'summon2', 'summon3', 'thinking']);
    for (const anim of Object.values(anims)) {
      expect(anim.frames.length).toBeGreaterThan(1);
      const heights = new Set(anim.frames.map((f) => f.length));
      expect(heights.size).toBe(1);
    }
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
