// Composer state as a pure reducer (keystroke → state) so the editing
// behavior is testable without rendering Ink. The App maps ink key events to
// ComposerActions and renders text/cursor.

export interface ComposerState {
  text: string;
  /** Caret index into text, 0..text.length. */
  cursor: number;
}

export const EMPTY_COMPOSER: ComposerState = { text: '', cursor: 0 };

export type ComposerAction =
  | { type: 'insert'; text: string } // typing or paste (CRLF normalized)
  | { type: 'backspace' }
  | { type: 'del' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'wordLeft' }
  | { type: 'wordRight' }
  | { type: 'deleteWordBack' }
  | { type: 'killToStart' }
  | { type: 'newline' }
  | { type: 'set'; text: string }; // history recall — caret to end

function wordLeftIndex(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

function wordRightIndex(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

export function composerReduce(s: ComposerState, a: ComposerAction): ComposerState {
  switch (a.type) {
    case 'insert': {
      const ins = a.text.replace(/\r\n?/g, '\n');
      return { text: s.text.slice(0, s.cursor) + ins + s.text.slice(s.cursor), cursor: s.cursor + ins.length };
    }
    case 'backspace':
      if (s.cursor === 0) return s;
      return { text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), cursor: s.cursor - 1 };
    case 'del':
      if (s.cursor >= s.text.length) return s;
      return { text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1), cursor: s.cursor };
    case 'left':
      return { ...s, cursor: Math.max(0, s.cursor - 1) };
    case 'right':
      return { ...s, cursor: Math.min(s.text.length, s.cursor + 1) };
    case 'home': {
      const nl = s.text.lastIndexOf('\n', s.cursor - 1);
      return { ...s, cursor: nl < 0 ? 0 : nl + 1 };
    }
    case 'end': {
      const nl = s.text.indexOf('\n', s.cursor);
      return { ...s, cursor: nl < 0 ? s.text.length : nl };
    }
    case 'wordLeft':
      return { ...s, cursor: wordLeftIndex(s.text, s.cursor) };
    case 'wordRight':
      return { ...s, cursor: wordRightIndex(s.text, s.cursor) };
    case 'deleteWordBack': {
      const i = wordLeftIndex(s.text, s.cursor);
      return { text: s.text.slice(0, i) + s.text.slice(s.cursor), cursor: i };
    }
    case 'killToStart':
      return { text: s.text.slice(s.cursor), cursor: 0 };
    case 'newline':
      return { text: s.text.slice(0, s.cursor) + '\n' + s.text.slice(s.cursor), cursor: s.cursor + 1 };
    case 'set':
      return { text: a.text, cursor: a.text.length };
    default:
      return s;
  }
}

/** Backslash-Enter continues onto a new line: if the caret line ends with a
 *  trailing backslash at the caret, Enter swaps it for a newline. Returns the
 *  new state, or null when Enter should submit instead. */
export function continuationOnEnter(s: ComposerState): ComposerState | null {
  if (s.cursor === s.text.length && s.text.endsWith('\\') && !s.text.endsWith('\\\\')) {
    return { text: s.text.slice(0, -1) + '\n', cursor: s.cursor };
  }
  return null;
}

/** Split for rendering: the caret sits on `at` (a single char or a space at
 *  end-of-text), rendered inverse by the caller. */
export function splitAtCursor(s: ComposerState): { before: string; at: string; after: string } {
  const before = s.text.slice(0, s.cursor);
  const at = s.cursor < s.text.length ? s.text[s.cursor] : ' ';
  const after = s.cursor < s.text.length ? s.text.slice(s.cursor + 1) : '';
  return { before, at, after };
}

// --- @file completion --------------------------------------------------------

export interface FileCompletionResult {
  state: ComposerState;
  /** Candidates when the completion is ambiguous (shown to the user). */
  candidates?: string[];
}

/** Tab on a token that starts with '@': complete a file path against the
 *  filesystem (injected as listDir for testability). Completes the longest
 *  common prefix; returns candidates when still ambiguous. */
export function completeFileToken(
  s: ComposerState,
  listDir: (dir: string) => string[],
): FileCompletionResult | null {
  const upto = s.text.slice(0, s.cursor);
  const m = upto.match(/@([^\s@]*)$/);
  if (!m) return null;
  const partial = m[1];
  const slash = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf('\\'));
  const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
  const namePart = slash >= 0 ? partial.slice(slash + 1) : partial;
  let entries: string[];
  try {
    entries = listDir(dirPart === '' ? '.' : dirPart);
  } catch {
    return null;
  }
  const matches = entries.filter((e) => e.toLowerCase().startsWith(namePart.toLowerCase()));
  if (matches.length === 0) return null;
  let completion: string;
  if (matches.length === 1) {
    completion = matches[0];
  } else {
    // longest common prefix
    completion = matches.reduce((acc, e) => {
      let i = 0;
      while (i < acc.length && i < e.length && acc[i].toLowerCase() === e[i].toLowerCase()) i++;
      return acc.slice(0, i);
    });
    if (completion.length <= namePart.length) {
      return { state: s, candidates: matches.slice(0, 20) };
    }
  }
  const start = s.cursor - namePart.length;
  const text = s.text.slice(0, start) + completion + s.text.slice(s.cursor);
  return { state: { text, cursor: start + completion.length } };
}
