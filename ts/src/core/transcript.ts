// Transcript accounting + the hard trim fallback. Invariant: an
// assistant-with-tool_calls message is always removed together with ALL of its
// tool results — a tool-role message without its matching tool_call id 400s the API.

import type { ChatMessage } from './types.js';

export const TRIM_MARKER = '[earlier conversation trimmed]';

export function messageCharCount(m: ChatMessage): number {
  let chars = 0;
  if (m.content) chars += String(m.content).length;
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      chars += tc.function.name.length + tc.function.arguments.length + 40;
    }
  }
  return chars;
}

export function transcriptCharCount(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += messageCharCount(m);
  return chars;
}

/** Drop the oldest messages (after the system prompt) until under budget.
 *  Returns true if anything was trimmed. Mutates the array in place. */
export function trimTranscript(messages: ChatMessage[], budget: number): boolean {
  if (transcriptCharCount(messages) <= budget) return false;
  let trimmed = false;
  while (transcriptCharCount(messages) > budget && messages.length > 3) {
    let idx = 1;
    if (messages[idx].role === 'user' && messages[idx].content === TRIM_MARKER) idx = 2;
    if (idx >= messages.length - 1) break; // never eat the in-flight turn
    const m = messages[idx];
    messages.splice(idx, 1);
    if (m.role === 'assistant' && m.tool_calls) {
      while (idx < messages.length && messages[idx].role === 'tool') {
        messages.splice(idx, 1);
      }
    }
    trimmed = true;
  }
  if (trimmed) {
    if (!(messages.length > 1 && messages[1].content === TRIM_MARKER)) {
      messages.splice(1, 0, { role: 'user', content: TRIM_MARKER });
    }
  }
  return trimmed;
}
