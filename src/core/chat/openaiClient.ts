// Chat-completions client on the openai npm package. Provider-driven: the
// ResolvedProvider supplies base URL (null = api.openai.com), key, and extra
// headers — which also covers OpenAI-compatible company gateways and Ollama.
// Custom 5-attempt retry with Retry-After (shared classifier); SDK-internal
// retries are disabled so our policy is the only one.

import OpenAI from 'openai';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import type { ChatClient } from './client.js';
import type { ChatRequest, ChatResponse, ChatUsage, SenseiConfig, ToolCall } from '../types.js';
import { activeModel, type ResolvedProvider } from '../providers.js';
import { classifyHttpError, MAX_ATTEMPTS, sleep } from './retry.js';

// Node's default undici Agent caps headersTimeout at 300s — below our 600s
// request timeout, which matters when a local model has to load first.
const dispatcher = new UndiciAgent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

export function stripThinkBlocks(text: string | null): string | null {
  if (!text) return text ?? null;
  const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  return stripped === '' ? null : stripped;
}

export class OpenAIChatClient implements ChatClient {
  private readonly config: SenseiConfig;
  private readonly provider: ResolvedProvider;
  private readonly fetchImpl: typeof globalThis.fetch;

  /** fetchImpl is the offline wire-level test seam. */
  constructor(config: SenseiConfig, provider: ResolvedProvider, fetchImpl?: typeof globalThis.fetch) {
    this.config = config;
    this.provider = provider;
    this.fetchImpl = fetchImpl ?? (undiciFetch as unknown as typeof globalThis.fetch);
  }

  private makeClient(): OpenAI {
    const p = this.provider;
    let key = p.apiKey;
    if (!key) {
      if (p.noAuth) key = 'none'; // gateway with ambient auth; SDK requires a value
      else {
        throw new Error(`No API key for provider '${p.name}' — ${p.keyHint}, or use --local.`);
      }
    }
    return new OpenAI({
      apiKey: key,
      baseURL: p.baseUrl ?? undefined,
      defaultHeaders: Object.keys(p.headers).length > 0 ? p.headers : undefined,
      maxRetries: 0,
      timeout: 600_000,
      fetch: this.fetchImpl,
      fetchOptions: { dispatcher },
    });
  }

  async chat(
    req: ChatRequest,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void; onNote?: (text: string) => void } = {},
  ): Promise<ChatResponse> {
    const client = this.makeClient();
    const model = activeModel(this.config, this.provider);
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
    };
    // max_completion_tokens only against real api.openai.com — many
    // OpenAI-compatible servers (Ollama, gateways) reject it.
    if (this.provider.baseUrl === null) body.max_completion_tokens = Number(this.config.max_output_tokens);
    else body.max_tokens = Number(this.config.max_output_tokens);
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
        const { retryable, delaySec, message } = classifyHttpError(e, attempt, {
          isLocal: this.provider.isLocal,
          baseUrl: this.provider.baseUrl,
          keyHint: this.provider.keyHint,
          providerName: this.provider.name,
          localModel: model,
        });
        if (!retryable || attempt === MAX_ATTEMPTS) throw new Error(message);
        opts.onNote?.(`${message}; retrying in ${Math.round(delaySec)}s (${attempt}/${MAX_ATTEMPTS})…`);
        await sleep(delaySec * 1000, opts.signal);
      }
    }
    /* unreachable */
    throw new Error('retry loop exhausted');
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
    const streamBody: Record<string, unknown> = { ...body, stream: true };
    // escape hatch for gateways that reject stream_options
    if (this.provider.streamUsage) streamBody.stream_options = { include_usage: true };
    const stream = (await client.chat.completions.create(streamBody as never, {
      signal: opts.signal,
    })) as unknown as AsyncIterable<{
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
