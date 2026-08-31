// Wire-level tests for AnthropicChatClient via an injected fake fetch —
// request shape (URL, auth headers, body), SSE stream accumulation, retry
// policy, and abort. Fully offline.

import { describe, expect, it } from 'vitest';
import { AnthropicChatClient } from '../src/core/chat/anthropicClient.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { resolveProvider } from '../src/core/providers.js';
import type { ChatRequest, SenseiConfig } from '../src/core/types.js';

function cfg(over: Partial<SenseiConfig> = {}): SenseiConfig {
  return { ...DEFAULT_CONFIG, model: 'claude-opus-5', ...over } as SenseiConfig;
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function jsonResponse(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function sseResponse(events: { event: string; data: unknown }[]): Response {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Fake fetch returning queued responses; captures each request. */
function fakeFetch(responses: (() => Response)[]): { fetch: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let body: Record<string, any> = {};
    const rawBody = init?.body;
    if (typeof rawBody === 'string') body = JSON.parse(rawBody);
    calls.push({ url, headers, body });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return next();
  }) as typeof globalThis.fetch;
  return { fetch: f, calls };
}

const MESSAGE_OK = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'hello there' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 100 },
};

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    toolSpecs: [],
    allowStream: false,
    ...over,
  };
}

describe('AnthropicChatClient (non-streaming)', () => {
  it('sends x-api-key auth, lifted system, max_tokens; normalizes the response', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-wire';
    try {
      const c = cfg();
      const { fetch, calls } = fakeFetch([() => jsonResponse(MESSAGE_OK)]);
      const client = new AnthropicChatClient(c, resolveProvider(c), fetch);
      const resp = await client.chat(req());
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('api.anthropic.com');
      expect(calls[0].url).toContain('/v1/messages');
      expect(calls[0].headers.get('x-api-key')).toBe('sk-ant-wire');
      expect(calls[0].headers.get('authorization')).toBeNull();
      expect(calls[0].body.model).toBe('claude-opus-5');
      expect(calls[0].body.max_tokens).toBe(8192);
      expect(calls[0].body.system[0].text).toBe('sys');
      expect(calls[0].body.messages).toHaveLength(1);
      expect(resp.choices![0].message.content).toBe('hello there');
      expect(resp.choices![0].finish_reason).toBe('stop');
      expect(resp.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, cache_read_input_tokens: 100 });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('gateway: custom base_url path, bearer auth, extra headers, caching off', async () => {
    const c = cfg({
      provider: 'company',
      providers: {
        company: {
          wire: 'anthropic',
          base_url: 'https://llm-gw.corp.example/anthropic',
          api_key: 'tok-9',
          auth: 'bearer',
          headers: { 'x-corp-project': 'sensei' },
          prompt_caching: false,
        },
      },
    });
    const { fetch, calls } = fakeFetch([() => jsonResponse(MESSAGE_OK)]);
    const client = new AnthropicChatClient(c, resolveProvider(c), fetch);
    await client.chat(req());
    expect(calls[0].url).toContain('https://llm-gw.corp.example/anthropic');
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok-9');
    expect(calls[0].headers.get('x-corp-project')).toBe('sensei');
    expect(JSON.stringify(calls[0].body)).not.toContain('cache_control');
  });

  it('caching on by default: request carries cache_control breakpoints', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    try {
      const c = cfg();
      const { fetch, calls } = fakeFetch([() => jsonResponse(MESSAGE_OK)]);
      const client = new AnthropicChatClient(c, resolveProvider(c), fetch);
      await client.chat(req());
      expect(JSON.stringify(calls[0].body)).toContain('cache_control');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('retries 429 (retry-after) and 529, then succeeds', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    try {
      const c = cfg();
      const notes: string[] = [];
      const { fetch, calls } = fakeFetch([
        () =>
          jsonResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '0', 'content-type': 'application/json' } }),
        () => jsonResponse({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, { status: 529 }),
        () => jsonResponse(MESSAGE_OK),
      ]);
      const client = new AnthropicChatClient(c, resolveProvider(c), fetch);
      const resp = await client.chat(req(), { onNote: (t) => notes.push(t) });
      expect(calls).toHaveLength(3);
      expect(resp.choices![0].message.content).toBe('hello there');
      expect(notes.some((n) => n.includes('429'))).toBe(true);
      expect(notes.some((n) => n.includes('529'))).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }, 30_000);

  it('401 does not retry and names the key hint', async () => {
    process.env.ANTHROPIC_API_KEY = 'bad';
    try {
      const c = cfg();
      const { fetch, calls } = fakeFetch([
        () => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'nope' } }, { status: 401 }),
      ]);
      const client = new AnthropicChatClient(c, resolveProvider(c), fetch);
      await expect(client.chat(req())).rejects.toThrow(/401[\s\S]*ANTHROPIC_API_KEY/);
      expect(calls).toHaveLength(1);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('abort surfaces as { aborted: true }', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    try {
      const c = cfg();
      const ac = new AbortController();
      const { fetch } = fakeFetch([
        () => {
          ac.abort();
          throw new DOMException('aborted', 'AbortError');
        },
      ]);
      const client = new AnthropicChatClient(c, resolveProvider(c), fetch);
      const resp = await client.chat(req(), { signal: ac.signal });
      expect(resp.aborted).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('AnthropicChatClient (streaming)', () => {
  it('accumulates split text and json deltas, maps stop_reason and usage', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    try {
      const c = cfg({ stream: true });
      const deltas: string[] = [];
      const { fetch, calls } = fakeFetch([
        () =>
          sseResponse([
            { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 7, cache_creation_input_tokens: 3 } } } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Sear' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ching.' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_9', name: 'grep', input: {} } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pattern":' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ERROR"}' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
            { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 21 } } },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]),
      ]);
      const client = new AnthropicChatClient(c, resolveProvider(c), fetch);
      const resp = await client.chat(req({ allowStream: true }), { onDelta: (t) => deltas.push(t) });
      expect(calls[0].body.stream).toBe(true);
      expect(deltas.join('')).toBe('Searching.');
      const choice = resp.choices![0];
      expect(choice.message.content).toBe('Searching.');
      expect(choice.message.tool_calls).toEqual([
        { id: 'tu_9', type: 'function', function: { name: 'grep', arguments: '{"pattern":"ERROR"}' } },
      ]);
      expect(choice.finish_reason).toBe('tool_calls');
      expect(resp.usage).toEqual({ prompt_tokens: 7, completion_tokens: 21, cache_creation_input_tokens: 3 });
      expect(resp.streamed).toBe(true);
      expect(resp.printed).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('replays the previous turn raw blocks (thinking) on the next request', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    try {
      const c = cfg();
      const { fetch, calls } = fakeFetch([
        () =>
          jsonResponse({
            ...MESSAGE_OK,
            content: [
              { type: 'thinking', thinking: 'let me grep', signature: 'sig1' },
              { type: 'tool_use', id: 'tu_1', name: 'grep', input: { pattern: 'x' } },
            ],
            stop_reason: 'tool_use',
          }),
        () => jsonResponse(MESSAGE_OK),
      ]);
      const client = new AnthropicChatClient(c, resolveProvider(c), fetch);
      const first = await client.chat(req());
      const tc = first.choices![0].message.tool_calls!;
      // second call: transcript now carries the assistant turn + tool result
      await client.chat(
        req({
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: null, tool_calls: tc },
            { role: 'tool', tool_call_id: 'tu_1', content: 'match' },
          ],
        }),
      );
      const sent = calls[1].body.messages as { role: string; content: unknown }[];
      const assistant = sent.find((m) => m.role === 'assistant')!;
      const blocks = assistant.content as { type: string; thinking?: string; signature?: string }[];
      expect(blocks[0].type).toBe('thinking');
      expect(blocks[0].thinking).toBe('let me grep');
      expect(blocks[0].signature).toBe('sig1');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
