// Chat-completions client on the openai npm package (baseURL-switchable for
// Ollama). Custom 5-attempt retry with Retry-After, matching the PS variant;
// SDK-internal retries are disabled so our policy is the only one.

import OpenAI, { APIError, APIConnectionError } from 'openai';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import type { ChatClient } from './client.js';
import type { ChatRequest, ChatResponse, ChatUsage, SenseiConfig, ToolCall } from '../types.js';
import { getActiveModel, getApiKey } from '../config.js';

const RETRY_STATUSES = new Set([429, 500, 502, 503]);
const MAX_ATTEMPTS = 5;

// Node's default undici Agent caps headersTimeout at 300s — below our 600s
// request timeout, which matters when a local model has to load first.
const dispatcher = new UndiciAgent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export function stripThinkBlocks(text: string | null): string | null {
  if (!text) return text ?? null;
  const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  return stripped === '' ? null : stripped;
}

export class OpenAIChatClient implements ChatClient {
  private readonly config: SenseiConfig;
  private readonly local: boolean;

  constructor(config: SenseiConfig, local: boolean) {
    this.config = config;
    this.local = local;
  }

  private makeClient(): OpenAI {
    if (this.local) {
      // Ollama ignores auth, but the header must be present
      return new OpenAI({
        apiKey: 'ollama',
        baseURL: String(this.config.local_base_url).replace(/\/+$/, ''),
        maxRetries: 0,
        timeout: 600_000,
        fetch: undiciFetch as unknown as typeof globalThis.fetch,
        fetchOptions: { dispatcher },
      });
    }
    const key = getApiKey(this.config);
    if (!key) {
      throw new Error(
        'No OpenAI API key configured. Set OPENAI_API_KEY or delete ~/.sensei/config.json to rerun setup.',
      );
    }
    return new OpenAI({
      apiKey: key,
      maxRetries: 0,
      timeout: 600_000,
      fetch: undiciFetch as unknown as typeof globalThis.fetch,
      fetchOptions: { dispatcher },
    });
  }

  async chat(
    req: ChatRequest,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void; onNote?: (text: string) => void } = {},
  ): Promise<ChatResponse> {
    const client = this.makeClient();
    const model = getActiveModel(this.config, this.local);
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
    };
    if (this.local) body.max_tokens = Number(this.config.max_output_tokens);
    else body.max_completion_tokens = Number(this.config.max_output_tokens);
    if (req.toolSpecs.length > 0) body.tools = req.toolSpecs;
    const useStream = req.allowStream && Boolean(this.config.stream);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (useStream) return await this.streamOnce(client, body, opts);
        return await this.completeOnce(client, body, opts);
      } catch (e) {
        if (opts.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
          return { aborted: true };
        }
        const { retryable, delaySec, message } = this.classifyError(e, attempt);
        if (!retryable || attempt === MAX_ATTEMPTS) throw new Error(message);
        opts.onNote?.(`${message}; retrying in ${Math.round(delaySec)}s (${attempt}/${MAX_ATTEMPTS})…`);
        await sleep(delaySec * 1000, opts.signal);
      }
    }
    /* unreachable */
    throw new Error('retry loop exhausted');
  }

  private classifyError(e: unknown, attempt: number): { retryable: boolean; delaySec: number; message: string } {
    const backoff = Math.min(60, Math.pow(2, attempt)) + Math.random();
    if (e instanceof APIConnectionError) {
      if (this.local) {
        return {
          retryable: false,
          delaySec: 0,
          message:
            `Couldn't reach Ollama at ${this.config.local_base_url}: ${e.message}\n` +
            `Is Ollama running? Start the Ollama app (or 'ollama serve') and make sure '${getActiveModel(this.config, this.local)}' is pulled.`,
        };
      }
      return { retryable: true, delaySec: backoff, message: `network error (${e.message})` };
    }
    if (e instanceof APIError) {
      const status = e.status ?? 0;
      if (RETRY_STATUSES.has(status)) {
        const ra = e.headers?.get?.('retry-after');
        const delaySec = ra && !Number.isNaN(Number(ra)) ? Number(ra) : backoff;
        return { retryable: true, delaySec, message: `API returned ${status}` };
      }
      const errMsg = e.message ?? String(e);
      if (status === 401) {
        return {
          retryable: false,
          delaySec: 0,
          message: `OpenAI rejected the API key (401): ${errMsg}\nFix OPENAI_API_KEY (or delete ~/.sensei/config.json to rerun setup).`,
        };
      }
      return { retryable: false, delaySec: 0, message: `API error ${status}: ${errMsg}` };
    }
    return { retryable: false, delaySec: 0, message: (e as Error)?.message ?? String(e) };
  }

  private async completeOnce(
    client: OpenAI,
    body: Record<string, unknown>,
    opts: { signal?: AbortSignal },
  ): Promise<ChatResponse> {
    const resp = (await client.chat.completions.create(body as never, {
      signal: opts.signal,
    })) as unknown as {
      choices: { message: { content: string | null; tool_calls?: ToolCall[] | null }; finish_reason: string }[];
      usage?: ChatUsage | null;
    };
    const choice = resp.choices?.[0];
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: choice?.message?.content ?? null,
            tool_calls: choice?.message?.tool_calls ?? null,
          },
          finish_reason: choice?.finish_reason ?? 'stop',
        },
      ],
      usage: resp.usage ?? null,
    };
  }

  private async streamOnce(
    client: OpenAI,
    body: Record<string, unknown>,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void },
  ): Promise<ChatResponse> {
    const stream = (await client.chat.completions.create(
      { ...body, stream: true, stream_options: { include_usage: true } } as never,
      { signal: opts.signal },
    )) as unknown as AsyncIterable<{
      choices?: {
        delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
        finish_reason?: string | null;
      }[];
      usage?: ChatUsage | null;
    }>;

    let content = '';
    let finish: string | null = null;
    let usage: ChatUsage | null = null;
    const acc = new Map<number, { id: string | null; name: string | null; args: string }>();
    let printed = false;

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const ch = chunk.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const delta = ch.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        printed = true;
        opts.onDelta?.(delta.content);
      }
      if (delta.tool_calls) {
        for (const frag of delta.tool_calls) {
          const idx = frag.index ?? 0;
          let e = acc.get(idx);
          if (!e) {
            e = { id: null, name: null, args: '' };
            acc.set(idx, e);
          }
          if (frag.id) e.id = frag.id;
          if (frag.function?.name) e.name = frag.function.name;
          if (frag.function?.arguments !== undefined) e.args += frag.function.arguments;
        }
      }
    }

    let toolCalls: ToolCall[] | null = null;
    if (acc.size > 0) {
      toolCalls = [...acc.keys()]
        .sort((a, b) => a - b)
        .map((idx) => {
          const e = acc.get(idx)!;
          return { id: e.id ?? '', type: 'function' as const, function: { name: e.name ?? '', arguments: e.args } };
        });
    }
    const cleaned = stripThinkBlocks(content || null);
    if (!finish) finish = toolCalls ? 'tool_calls' : 'stop';
    return {
      choices: [
        { message: { role: 'assistant', content: cleaned, tool_calls: toolCalls }, finish_reason: finish },
      ],
      usage,
      streamed: true,
      printed,
    };
  }
}
