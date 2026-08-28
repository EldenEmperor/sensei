// Line-based markdown renderer, ported from src\render.ps1's single code path.
// Pure string → string; ANSI comes from the theme wrappers. Ink passes raw
// ANSI in <Text> through to the terminal, so the TUI renders these directly.

import { protectTerminalText, type Theme } from './theme.js';

interface RenderState {
  inCode: boolean;
  inThink: boolean;
}

function renderLine(state: RenderState, line: string, t: Theme): string | null {
  if (state.inThink) {
    if (/<\/think>/.test(line)) state.inThink = false;
    return null;
  }
  if (/<think>/.test(line)) {
    state.inThink = !/<\/think>/.test(line);
    return null;
  }
  if (/^\s*```/.test(line)) {
    state.inCode = !state.inCode;
    return null;
  }
  if (state.inCode) {
    return '  ' + t.codeBg(protectTerminalText(line));
  }
  const safe = protectTerminalText(line);
  const header = safe.match(/^#{1,4}\s+(.*)$/);
  if (header) return t.bold(t.accent(header[1]));
  let out = safe.replace(/^(\s*)[-*]\s+/, (_, ws: string) => `${ws}${t.accent('•')} `);
  out = out.replace(/\*\*(.+?)\*\*/g, (_, inner: string) => t.bold(inner));
  out = out.replace(/`([^`]+)`/g, (_, inner: string) => t.accent(inner));
  return out;
}

/** Render a complete markdown-ish text (think blocks stripped) to ANSI lines. */
export function renderMarkdown(text: string | null | undefined, theme: Theme): string {
  if (!text) return '';
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  if (!cleaned.trim()) return '';
  const state: RenderState = { inCode: false, inThink: false };
  const out: string[] = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const rendered = renderLine(state, line, theme);
    if (rendered !== null) out.push(rendered);
  }
  return out.join('\n');
}
