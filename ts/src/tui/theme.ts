// Accent themes + ANSI helpers, ported from src\render.ps1. The theme is a set
// of string-wrapping functions so the markdown/diff renderers stay pure and
// testable; with theming off every wrapper is the identity function.

export const ACCENT_PRESETS: Record<string, number> = {
  indigo: 0x5b8def,
  jade: 0x3cb371,
  gold: 0xe0a030,
  teal: 0x2ec4b6,
  red: 0xe0533d,
};

export interface Theme {
  enabled: boolean;
  accentHex: string;
  accent(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  err(s: string): string;
  ok(s: string): string;
  red(s: string): string;
  green(s: string): string;
  codeBg(s: string): string;
}

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const fg = (rgb: number) => `${ESC}[38;2;${(rgb >> 16) & 0xff};${(rgb >> 8) & 0xff};${rgb & 0xff}m`;
const bg = (rgb: number) => `${ESC}[48;2;${(rgb >> 16) & 0xff};${(rgb >> 8) & 0xff};${rgb & 0xff}m`;
const wrap = (open: string) => (s: string) => `${open}${s}${RESET}`;
const id = (s: string) => s;

/** Resolve a preset name (indigo/jade/gold/teal/red) or a hex string
 *  (#RRGGBB or 0xRRGGBB). Returns null when unrecognized. */
export function resolveAccent(nameOrHex: string): number | null {
  if (!nameOrHex) return null;
  const key = nameOrHex.toLowerCase();
  if (key in ACCENT_PRESETS) return ACCENT_PRESETS[key];
  const hex = nameOrHex.replace(/^#/, '').replace(/^0x/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
  return null;
}

export function makeTheme(accent: number, enabled: boolean): Theme {
  if (!enabled) {
    return { enabled, accentHex: '', accent: id, dim: id, bold: id, err: id, ok: id, red: id, green: id, codeBg: id };
  }
  return {
    enabled,
    accentHex: '#' + accent.toString(16).padStart(6, '0'),
    accent: wrap(fg(accent)),
    dim: wrap(`${ESC}[90m`), // bright black
    bold: wrap(`${ESC}[1m`),
    err: wrap(`${ESC}[91m`), // bright red
    ok: wrap(`${ESC}[32m`),
    red: wrap(`${ESC}[31m`),
    green: wrap(`${ESC}[32m`),
    codeBg: wrap(bg(0x1f1f1f)),
  };
}

/** Neutralize raw ESC chars arriving in model output or log content so a
 *  hostile log line can't inject terminal control sequences. */
export function protectTerminalText(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return text.replace(/\x1b/g, '␛');
}
