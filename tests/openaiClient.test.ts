// Wire-level tests for OpenAIChatClient (previously untested): stream delta
// accumulation, finish_reason synthesis, gateway mode (base_url + headers +
// token-param switch), and the shared retry classifier. Fully offline.

import { describe, expect, it } from 'vitest';
import { OpenAIChatClient, stripThinkBlocks } from '../src/core/chat/openaiClient.js';
import { classifyHttpError } from '../src/core/chat/retry.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { resolveProvider } from '../src/core/providers.js';
import type { ChatRequest, SenseiConfig } from '../src/core/types.js';

function cfg(over: Partial<SenseiConfig> = {}): SenseiConfig {
  return { ...DEFAULT_CONFIG, ...over } as SenseiConfig;
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function fakeFetch(responses: (() => Response)[]): { fetch: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let body: Record<string, any> = {};
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, headers, body });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return next();
  }) as typeof globalThis.fetch;
  return { fetch: f, calls };
}

function jsonResponse(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function chatSse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const COMPLETION_OK = {
  id: 'c1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
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

describe('OpenAIChatClient wire', () => {
  it('default provider hits api.openai.com with bearer auth and max_completion_tokens', async () => {
    process.env.OPENAI_API_KEY = 'sk-wire';
    try {
      const c = cfg();
      const { fetch, calls } = fakeFetch([() => jsonResponse(COMPLETION_OK)]);
      const client = new OpenAIChatClient(c, resolveProvider(c), fetch);
      const resp = await client.chat(req());
      expect(calls[0].url).toContain('api.openai.com');
      expect(calls[0].headers.get('authorization')).toBe('Bearer sk-wire');
      expect(calls[0].body.max_completion_tokens).toBe(8192);
      expect(calls[0].body.max_tokens).toBeUndefined();
      expect(resp.choices![0].message.content).toBe('hi there');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('gateway mode: custom base_url + headers switch to max_tokens', async () => {
    const c = cfg({
      provider: 'gw',
      providers: {
        gw: { wire: 'openai', base_url: 'https://llm-gw.corp.example/v1', api_key: 'tok', headers: { 'x-corp': 'yes' } },
      },
    });
    const { fetch, calls } = fakeFetch([() => jsonResponse(COMPLETION_OK)]);
    const client = new OpenAIChatClient(c, resolveProvider(c), fetch);
    await client.chat(req());
    expect(calls[0].url).toContain('https://llm-gw.corp.example/v1');
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok');
    expect(calls[0].headers.get('x-corp')).toBe('yes');
    expect(calls[0].body.max_tokens).toBe(8192);
    expect(calls[0].body.max_completion_tokens).toBeUndefined();
  });

  it('accumulates streamed tool-call fragments by index and synthesizes finish_reason', async () => {
    process.env.OPENAI_API_KEY = 'k';
    try {
      const c = cfg({ stream: true });
      const deltas: string[] = [];
      const { fetch, calls } = fakeFetch([
        () =>
          chatSse([
            { choices: [{ delta: { content: 'Look' } }] },
            { choices: [{ delta: { content: 'ing.' } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c_1', function: { name: 'grep', arguments: '{"pa' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ttern":"E"}' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c_2', function: { name: 'glob', arguments: '{}' } }] } }] },
            { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } },
          ]),
      ]);
      const client = new OpenAIChatClient(c, resolveProvider(c), fetch);
      const resp = await client.chat(req({ allowStream: true }), { onDelta: (t) => deltas.push(t) });
      expect(calls[0].body.stream).toBe(true);
      expect(calls[0].body.stream_options).toEqual({ include_usage: true });
      expect(deltas.join('')).toBe('Looking.');
      const choice = resp.choices![0];
      expect(choice.message.tool_calls).toEqual([
        { id: 'c_1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"E"}' } },
        { id: 'c_2', type: 'function', function: { name: 'glob', arguments: '{}' } },
      ]);
      expect(choice.finish_reason).toBe('tool_calls');
      expect(resp.usage).toEqual({ prompt_tokens: 5, completion_tokens: 9 });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('stream_usage:false omits stream_options for picky gateways', async () => {
    const c = cfg({
      stream: true,
      provider: 'gw',
      providers: { gw: { wire: 'openai', base_url: 'https://gw/v1', api_key: 'k', stream_usage: false } },
    });
    const { fetch, calls } = fakeFetch([() => chatSse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])]);
    const client = new OpenAIChatClient(c, resolveProvider(c), fetch);
    const resp = await client.chat(req({ allowStream: true }));
    expect(calls[0].body.stream_options).toBeUndefined();
    expect(resp.usage).toBeNull();
    expect(resp.choices![0].message.content).toBe('ok');
  });

  it('strips <think> blocks on the streamed path', () => {
    expect(stripThinkBlocks('<think>internal</think>answer')).toBe('answer');
    expect(stripThinkBlocks('<think>only</think>')).toBeNull();
    expect(stripThinkBlocks(null)).toBeNull();
  });
});

describe('shared retry classifier', () => {
  const ctx = { isLocal: false, baseUrl: null, keyHint: 'set FOO_KEY', providerName: 'test' };

  it('retries 429/500/502/503/529, honors numeric retry-after', () => {
    for (const status of [429, 500, 502, 503, 529]) {
      const r = classifyHttpError({ status, message: 'x' }, 1, ctx);
      expect(r.retryable).toBe(true);
    }
    const ra = classifyHttpError(
      { status: 429, message: 'x', headers: new Headers({ 'retry-after': '7' }) },
      1,
      ctx,
    );
    expect(ra.delaySec).toBe(7);
  });

  it('401 is fatal and names the key hint; 400 is fatal', () => {
    const r = classifyHttpError({ status: 401, message: 'bad key' }, 1, ctx);
    expect(r.retryable).toBe(false);
    expect(r.message).toContain('set FOO_KEY');
    expect(r.message).toContain("'test'");
    expect(classifyHttpError({ status: 400, message: 'bad req' }, 1, ctx).retryable).toBe(false);
  });

  it('connection errors: retryable normally, fatal with Ollama guidance in local mode', () => {
    class APIConnectionError extends Error {}
    const e = new APIConnectionError('ECONNREFUSED');
    expect(classifyHttpError(e, 1, ctx).retryable).toBe(true);
    const local = classifyHttpError(e, 1, {
      ...ctx,
      isLocal: true,
      baseUrl: 'http://localhost:11434/v1',
      localModel: 'qwen3:14b',
    });
    expect(local.retryable).toBe(false);
    expect(local.message).toContain('Ollama');
    expect(local.message).toContain('qwen3:14b');
  });

  it('unknown errors are fatal with their message', () => {
    const r = classifyHttpError(new Error('weird'), 1, ctx);
    expect(r.retryable).toBe(false);
    expect(r.message).toBe('weird');
  });
});
