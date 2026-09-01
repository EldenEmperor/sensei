// Composer reducer (cursor editing, multiline, paste normalization),
// @file completion, and the new CLI arg forms.

import { describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../src/cli/args.js';
import {
  collapsePaste,
  completeFileToken,
  composerReduce,
  continuationOnEnter,
  EMPTY_COMPOSER,
  expandPastes,
  isPasteChunk,
  newPasteStore,
  splitAtCursor,
  type ComposerState,
} from '../src/tui/composer.js';

const st = (text: string, cursor = text.length): ComposerState => ({ text, cursor });

describe('composer reducer', () => {
  it('inserts at the cursor and normalizes CRLF paste', () => {
    let s = composerReduce(EMPTY_COMPOSER, { type: 'insert', text: 'helo' });
    s = composerReduce(s, { type: 'left' });
    s = composerReduce(s, { type: 'insert', text: 'l' });
    expect(s).toEqual(st('hello', 4));
    const pasted = composerReduce(EMPTY_COMPOSER, { type: 'insert', text: 'a\r\nb\rc' });
    expect(pasted.text).toBe('a\nb\nc');
  });

  it('backspace/del around the cursor', () => {
    let s = st('abc', 1);
    expect(composerReduce(s, { type: 'backspace' })).toEqual(st('bc', 0));
    expect(composerReduce(s, { type: 'del' })).toEqual(st('ac', 1));
    expect(composerReduce(st('', 0), { type: 'backspace' })).toEqual(st('', 0));
  });

  it('home/end are line-scoped in multiline text', () => {
    const s = st('one\ntwo three', 8); // inside "two"
    expect(composerReduce(s, { type: 'home' }).cursor).toBe(4);
    expect(composerReduce(s, { type: 'end' }).cursor).toBe(13);
    expect(composerReduce(st('one\ntwo', 2), { type: 'end' }).cursor).toBe(3);
  });

  it('word movement and word delete', () => {
    const s = st('git commit -m msg', 17);
    expect(composerReduce(s, { type: 'wordLeft' }).cursor).toBe(14);
    expect(composerReduce(st('git commit', 0), { type: 'wordRight' }).cursor).toBe(3);
    expect(composerReduce(s, { type: 'deleteWordBack' })).toEqual(st('git commit -m ', 14));
    expect(composerReduce(st('abc def', 7), { type: 'killToStart' })).toEqual(st('', 0));
  });

  it('backslash-Enter becomes a newline; plain Enter submits', () => {
    expect(continuationOnEnter(st('line one\\'))).toEqual(st('line one\n', 9));
    expect(continuationOnEnter(st('line one'))).toBeNull();
    expect(continuationOnEnter(st('ends with \\\\'))).toBeNull(); // escaped backslash
    expect(continuationOnEnter(st('mid\\dle', 3))).toBeNull(); // cursor not at end
  });

  it('splitAtCursor for rendering', () => {
    expect(splitAtCursor(st('abc', 1))).toEqual({ before: 'a', at: 'b', after: 'c' });
    expect(splitAtCursor(st('abc'))).toEqual({ before: 'abc', at: ' ', after: '' });
  });
});

describe('paste collapse', () => {
  it('short inserts stay literal; long or multi-line inserts qualify', () => {
    expect(isPasteChunk('hello world')).toBe(false);
    expect(isPasteChunk('one\ntwo')).toBe(false); // a single newline is just multiline typing
    expect(isPasteChunk('a\nb\nc')).toBe(true);
    expect(isPasteChunk('x'.repeat(151))).toBe(true);
  });

  it('collapses to a chip at the caret and stores the text', () => {
    const store = newPasteStore();
    const pasted = 'line1\nline2\nline3';
    const r = collapsePaste(st('see  here', 4), pasted, store, 1000, null);
    expect(r.state.text).toBe('see [pasted #1 +3 lines] here');
    expect(r.state.cursor).toBe(4 + '[pasted #1 +3 lines]'.length);
    expect(store.pastes.get(1)).toBe(pasted);
    expect(r.last).toEqual({ id: 1, time: 1000 });
  });

  it('a burst within the merge window appends and rewrites the chip count', () => {
    const store = newPasteStore();
    const r1 = collapsePaste(EMPTY_COMPOSER, 'a\nb\nc', store, 1000, null);
    const r2 = collapsePaste(r1.state, '\nd\ne', store, 1080, r1.last);
    expect(r2.state.text).toBe('[pasted #1 +5 lines]');
    expect(store.pastes.get(1)).toBe('a\nb\nc\nd\ne');
    // outside the window → a second chip
    const r3 = collapsePaste(r2.state, 'x\ny\nz', store, 2000, r2.last);
    expect(r3.state.text).toBe('[pasted #1 +5 lines][pasted #2 +3 lines]');
  });

  it('expandPastes restores content, prunes used entries, leaves unknown ids', () => {
    const store = newPasteStore();
    const r1 = collapsePaste(EMPTY_COMPOSER, 'AAA\nBBB\nCCC', store, 0, null);
    const text = `before ${r1.state.text} after [pasted #9 +2 lines]`;
    const out = expandPastes(text, store);
    expect(out).toBe('before AAA\nBBB\nCCC after [pasted #9 +2 lines]');
    expect(store.pastes.size).toBe(0); // pruned
  });

  it('a deleted chip simply never expands', () => {
    const store = newPasteStore();
    collapsePaste(EMPTY_COMPOSER, '1\n2\n3', store, 0, null);
    expect(expandPastes('typed something else', store)).toBe('typed something else');
    expect(store.pastes.size).toBe(1); // still stored, harmless
  });

  it('normalizes CRLF in stored pastes', () => {
    const store = newPasteStore();
    collapsePaste(EMPTY_COMPOSER, 'a\r\nb\r\nc', store, 0, null);
    expect(store.pastes.get(1)).toBe('a\nb\nc');
  });
});

describe('@file completion', () => {
  const listDir = (dir: string): string[] => {
    if (dir === '.') return ['app.log', 'application.log', 'src/', 'readme.md'];
    if (dir === 'src/') return ['main.ts'];
    throw new Error('no such dir');
  };

  it('completes a unique match and descends into directories', () => {
    const r = completeFileToken(st('see @rea'), listDir)!;
    expect(r.state.text).toBe('see @readme.md');
    const r2 = completeFileToken(st('see @src/ma'), listDir)!;
    expect(r2.state.text).toBe('see @src/main.ts');
  });

  it('extends to the longest common prefix, then lists candidates', () => {
    const r = completeFileToken(st('@ap'), listDir)!;
    expect(r.state.text).toBe('@app');
    const r2 = completeFileToken(st('@app'), listDir)!;
    expect(r2.state.text).toBe('@app'); // no further progress
    expect(r2.candidates).toEqual(['app.log', 'application.log']);
  });

  it('returns null with no @token or no matches', () => {
    expect(completeFileToken(st('plain text'), listDir)).toBeNull();
    expect(completeFileToken(st('@zzz'), listDir)).toBeNull();
    expect(completeFileToken(st('@nodir/x'), listDir)).toBeNull();
  });
});

describe('new CLI arg forms', () => {
  it('positional prompt', () => {
    const a = parseCliArgs(['fix the bug', '--yolo']);
    expect(a.print).toBe('fix the bug');
    expect(a.yolo).toBe(true);
  });

  it('rejects both -p and a positional', () => {
    expect(() => parseCliArgs(['-p', 'x', 'y'])).toThrow(UsageError);
  });

  it('append-system-prompt and add-dir', () => {
    const a = parseCliArgs(['-p', 'x', '--append-system-prompt', 'be terse', '--add-dir', 'C:\\a', '--add-dir', 'C:\\b']);
    expect(a.appendSystemPrompt).toBe('be terse');
    expect(a.addDirs).toEqual(['C:\\a', 'C:\\b']);
  });

  it('permission-mode still validates', () => {
    expect(parseCliArgs(['-p', 'x', '--permission-mode', 'acceptEdits']).permissionMode).toBe('acceptEdits');
    expect(() => parseCliArgs(['-p', 'x', '--permission-mode', 'wild'])).toThrow(UsageError);
  });

  it('--mode validates code|logs', () => {
    expect(parseCliArgs(['-p', 'x', '--mode', 'logs']).mode).toBe('logs');
    expect(parseCliArgs(['-p', 'x']).mode).toBeNull();
    expect(() => parseCliArgs(['-p', 'x', '--mode', 'wild'])).toThrow(UsageError);
  });
});
