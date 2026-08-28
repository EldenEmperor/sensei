// Session persistence. TS sessions use a versioned envelope; the reader also
// accepts the PS variant's bare-array legacy format. The restore validator
// ports Restore-SenseiSession: keep an assistant-with-tool_calls only when
// every one of its results follows; drop orphan tool messages.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, ToolCall } from './types.js';

export interface SessionEnvelope {
  schema_version: 1;
  id: string;
  created: string;
  updated: string;
  cwd: string;
  model: string;
  local: boolean;
  messages: ChatMessage[];
}

export function newSessionId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/** Normalize + validate a restored transcript (system prompt NOT included). */
export function validateTranscript(raw: unknown[]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const item of raw) {
    const m = item as Record<string, unknown> | null;
    if (!m || !m.role || m.role === 'system') continue;
    const clean: ChatMessage = { role: m.role as ChatMessage['role'] };
    if ('content' in m) clean.content = (m.content as string | null) ?? null;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      clean.tool_calls = (m.tool_calls as Record<string, unknown>[]).map(
        (tc): ToolCall => ({
          id: String(tc.id ?? ''),
          type: 'function',
          function: {
            name: String((tc.function as Record<string, unknown>)?.name ?? ''),
            arguments: String((tc.function as Record<string, unknown>)?.arguments ?? ''),
          },
        }),
      );
    }
    if (m.role === 'tool') clean.tool_call_id = String(m.tool_call_id ?? '');
    msgs.push(clean);
  }

  const valid: ChatMessage[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls) {
      const ids = m.tool_calls.map((tc) => tc.id);
      const tools: ChatMessage[] = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool') {
        tools.push(msgs[j]);
        j++;
      }
      const haveIds = tools.map((t) => t.tool_call_id);
      const missing = ids.filter((id) => !haveIds.includes(id));
      if (missing.length === 0) {
        valid.push(m, ...tools);
      }
      i = j;
    } else if (m.role === 'tool') {
      i++; // orphan tool result — drop
    } else {
      valid.push(m);
      i++;
    }
  }
  return valid;
}

export function saveSession(sessionDir: string, envelope: SessionEnvelope): string {
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, `${envelope.id}.json`);
  envelope.updated = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(envelope, null, 1), 'utf8');
  return file;
}

export interface LoadedSession {
  id: string | null;
  cwd: string | null;
  messages: ChatMessage[];
  file: string;
}

/** Read a session file — envelope or PS legacy bare array. Transcript is validated. */
export function loadSessionFile(file: string): LoadedSession {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (Array.isArray(raw)) {
    return { id: null, cwd: null, messages: validateTranscript(raw), file };
  }
  const env = raw as Partial<SessionEnvelope>;
  return {
    id: env.id ?? null,
    cwd: env.cwd ?? null,
    messages: validateTranscript(Array.isArray(env.messages) ? env.messages : []),
    file,
  };
}

/** Resolve `--continue [id]` / `--resume <id>`: an explicit id (or file path),
 *  or the most recently updated envelope session whose cwd matches. */
export function findSession(sessionDir: string, idOrPath: string | null, cwd: string): string | null {
  if (idOrPath) {
    if (fs.existsSync(idOrPath) && fs.statSync(idOrPath).isFile()) return idOrPath;
    const byId = path.join(sessionDir, `${idOrPath}.json`);
    if (fs.existsSync(byId)) return byId;
    return null;
  }
  if (!fs.existsSync(sessionDir)) return null;
  let best: { file: string; updated: number } | null = null;
  for (const name of fs.readdirSync(sessionDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(sessionDir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SessionEnvelope> | unknown[];
      if (Array.isArray(raw)) continue; // legacy sessions carry no cwd — not eligible for bare --continue
      if (!raw || raw.schema_version !== 1) continue;
      if (path.resolve(String(raw.cwd ?? '')) !== path.resolve(cwd)) continue;
      const updated = Date.parse(String(raw.updated ?? '')) || 0;
      if (!best || updated > best.updated) best = { file, updated };
    } catch {
      continue;
    }
  }
  return best?.file ?? null;
}
