// Session envelope round-trip, transcript-legality validation, --continue resolution.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findSession,
  loadSessionFile,
  newSessionId,
  saveSession,
  validateTranscript,
  type SessionEnvelope,
} from '../src/core/sessions.js';
import { trimTranscript, TRIM_MARKER } from '../src/core/transcript.js';
import type { ChatMessage } from '../src/core/types.js';
import { makeTempDir } from './helpers.js';

const tc = (id: string) => ({
  id,
  type: 'function' as const,
  function: { name: 'glob', arguments: '{}' },
});

describe('validateTranscript', () => {
  it('drops an assistant-with-tool_calls missing any result', () => {
    const out = validateTranscript([
      { role: 'user', content: 'q' },
      { role: 'assistant', tool_calls: [tc('a'), tc('b')] },
      { role: 'tool', tool_call_id: 'a', content: 'r1' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[1].content).toBe('answer');
  });

  it('keeps a complete tool-call group', () => {
    const out = validateTranscript([
      { role: 'user', content: 'q' },
      { role: 'assistant', tool_calls: [tc('a')] },
      { role: 'tool', tool_call_id: 'a', content: 'r1' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('drops orphan tool messages and system messages', () => {
    const out = validateTranscript([
      { role: 'system', content: 'old prompt' },
      { role: 'tool', tool_call_id: 'ghost', content: 'r' },
      { role: 'user', content: 'q' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });
});

describe('session envelope + resolution', () => {
  it('round-trips and resolves by id, and bare --continue matches cwd', () => {
    const tmp = makeTempDir('sensei-ts-sess-');
    const sessionDir = path.join(tmp, 'sessions');
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    const env: SessionEnvelope = {
      schema_version: 1,
      id,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      cwd: tmp,
      model: 'test-model',
      local: true,
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    };
    const file = saveSession(sessionDir, env);
    expect(fs.existsSync(file)).toBe(true);

    const byId = findSession(sessionDir, id, 'C:\\elsewhere');
    expect(byId).toBe(file);
    const bare = findSession(sessionDir, null, tmp);
    expect(bare).toBe(file);
    expect(findSession(sessionDir, null, path.join(tmp, 'other'))).toBeNull();

    const loaded = loadSessionFile(file);
    expect(loaded.id).toBe(id);
    expect(loaded.messages.length).toBe(2);
  });

  it('reads PS legacy bare-array session files', () => {
    const tmp = makeTempDir('sensei-ts-legacy-');
    const file = path.join(tmp, '20260827-120000.json');
    fs.writeFileSync(
      file,
      JSON.stringify([
        { role: 'system', content: 'prompt' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    );
    const loaded = loadSessionFile(file);
    expect(loaded.id).toBeNull();
    expect(loaded.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('trimTranscript', () => {
  it('removes assistant-with-tool_calls together with all its results', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old '.repeat(200) },
      { role: 'assistant', tool_calls: [tc('t1')], content: null },
      { role: 'tool', tool_call_id: 't1', content: 'r '.repeat(200) },
      { role: 'user', content: 'recent' },
      { role: 'assistant', content: 'answer' },
    ];
    const trimmed = trimTranscript(messages, 300);
    expect(trimmed).toBe(true);
    expect(messages[1].content).toBe(TRIM_MARKER);
    const orphans = messages.filter((m) => m.role === 'tool');
    expect(orphans.length).toBe(0);
    expect(messages.at(-1)?.content).toBe('answer');
  });

  it('does nothing under budget', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    expect(trimTranscript(messages, 10000)).toBe(false);
    expect(messages.length).toBe(3);
  });
});
