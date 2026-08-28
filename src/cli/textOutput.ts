// Minimal terminal text helpers for the headless CLI. The full markdown
// renderer arrives with the Ink TUI; headless output stays plain but SAFE:
// every piece of model/tool text is sanitized so embedded ESC bytes can't
// smuggle ANSI control sequences into the terminal.

const ESC_RX = /\x1b/g;

export function sanitizeTerminalText(text: string): string {
  return text.replace(ESC_RX, '␛');
}

export function stripThinkForDisplay(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
}

export function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let s = String(v ?? '').replace(/\r?\n/g, '⏎');
    if (s.length > 70) s = s.slice(0, 67) + '…';
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}
