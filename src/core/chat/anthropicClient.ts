// Anthropic Messages API client behind the ChatClient seam. Translates
// sensei's OpenAI-normalized transcript at the wire (anthropicTranslate.ts)
// so the engine, sessions, and compaction never see Anthropic shapes.
// Same retry policy as the OpenAI client via the shared classifier.

import Anthropic from '@anthropic-ai/sdk';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import type { ChatClient } from './client.js';
import type { ChatRequest, ChatResponse, ChatUsage, SenseiConfig, ToolCall } from '../types.js';
import { activeModel, type ResolvedProvider } from '../providers.js';
import {
  fromAnthropicMessage,
  mapStopReason,
  mapUsage,
  rawBlockKey,
  toAnthropicRequest,
  type AnthropicBlock,
  type AnthropicRequest,
} from './anthropicTranslate.js';
import { classifyHttpError, MAX_ATTEMPTS, sleep } from './retry.js';

// Node's default undici Agent caps headersTimeout at 300s — below our 600s
// request timeout.
const dispatcher = new UndiciAgent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

export class AnthropicChatClient implements ChatClient {
  private readonly config: SenseiConfig;
  private readonly provider: ResolvedProvider;
  /** Thinking-fidelity cache: raw content blocks of the last response, keyed
   *  by its tool_use ids. Substituted verbatim into the next request so
   *  thinking blocks (with signatures) replay unchanged. Empty after a
   *  session resume — the API accepts assistant turns without them. */
  private readonly rawBlockCache = new Map<string, AnthropicBlock[]>();
  private readonly fetchImpl: typeof globalThis.fetch;

  /** fetchImpl is the offline wire-level test seam. */
  constructor(config: SenseiConfig, provider: ResolvedProvider, fetchImpl?: typeof globalThis.fetch) {
    this.config = config;
    this.provider = provider;
    this.fetchImpl = fetchImpl ?? (undiciFetch as unknown as typeof globalThis.fetch);
  }

  private makeClient(): Anthropic {
    const p = this.provider;
    const common = {
      baseURL: p.baseUrl ?? undefined,
      defaultHeaders: p.headers,
      maxRetries: 0,
      timeout: 600_000,
      fetch: this.fetchImpl,
      fetchOptions: { dispatcher },
    };
    if (p.noAuth) return new Anthropic({ ...common, apiKey: 'none' });
    if (!p.apiKey) {
      throw new Error(`No API key for provider '${p.name}' — ${p.keyHint}, or use --local.`);
    }
    // apiKey → x-api-key header; authToken → Authorization: Bearer (gateways)
    if (p.authStyle === 'bearer') return new Anthropic({ ...common, apiKey: null, authToken: p.apiKey });
    return new Anthropic({ ...common, apiKey: p.apiKey });
  }

  async chat(
    req: ChatRequest,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void; onNote?: (text: string) => void } = {},
  ): Promise<ChatResponse> {
    const client = this.makeClient();
    const body = toAnthropicRequest(req.messages, req.toolSpecs, {
      model: activeModel(this.config, this.provider),
      maxTokens: Number(this.config.max_output_tokens),
      promptCaching: this.provider.promptCaching,
      rawBlockCache: this.rawBlockCache,
    });
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
          isLocal: false,
          baseUrl: this.provider.baseUrl,
          keyHint: this.provider.keyHint,
          providerName: this.provider.name,
        });
        if (!retryable || attempt === MAX_ATTEMPTS) throw new Error(message);
        opts.onNote?.(`${message}; retrying in ${Math.round(delaySec)}s (${attempt}/${MAX_ATTEMPTS})…`);
        await sleep(delaySec * 1000, opts.signal);
      }
    }
    /* unreachable */
    throw new Error('retry loop exhausted');
  }

  private remember(rawBlocks: AnthropicBlock[], toolCalls: ToolCall[] | null): void {
    this.rawBlockCache.clear(); // only the immediately-previous turn is ever replayed
    if (toolCalls && toolCalls.length > 0 && rawBlocks.length > 0) {
      this.rawBlockCache.set(rawBlockKey(toolCalls), rawBlocks);
    }
  }

  private async completeOnce(
    client: Anthropic,
    body: AnthropicRequest,
    opts: { signal?: AbortSignal; onNote?: (text: string) => void },
  ): Promise<ChatResponse> {
    const resp = (await client.messages.create(body as never, {
      signal: opts.signal,
    })) as unknown as Parameters<typeof fromAnthropicMessage>[0];
    const r = fromAnthropicMessage(resp);
    if (r.refusal) opts.onNote?.('(the model declined this request for safety reasons)');
    this.remember(r.rawBlocks, r.toolCalls);
    return {
      choices: [
        {
          message: { role: 'assistant', content: r.content, tool_calls: r.toolCalls },
          finish_reason: r.finishReason,
        },
      ],
      usage: r.usage,
    };
  }

  private async streamOnce(
    client: Anthropic,
    body: AnthropicRequest,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void; onNote?: (text: string) => void },
  ): Promise<ChatResponse> {
    const stream = (await client.messages.create({ ...body, stream: true } as never, {
      signal: opts.signal,
    })) as unknown as AsyncIterable<Record<string, any>>;

    // accumulate raw content blocks by index — text, tool_use, and thinking
    const blocks = new Map<number, AnthropicBlock & { _json?: string }>();
    let stopReason: string | null = null;
    let usage: ChatUsage | null = null;
    let printed = false;

    for await (const ev of stream) {
      switch (ev.type) {
        case 'message_start': {
          usage = mapUsage(ev.message?.usage) ?? usage;
          break;
        }
        case 'content_block_start': {
          blocks.set(Number(ev.index ?? 0), { ...(ev.content_block ?? { type: 'text' }) });
          break;
        }
        case 'content_block_delta': {
          const b = blocks.get(Number(ev.index ?? 0));
          if (!b) break;
          const d = ev.delta ?? {};
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            b.text = String(b.text ?? '') + d.text;
            printed = true;
            opts.onDelta?.(d.text);
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            b._json = (b._json ?? '') + d.partial_json;
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            b.thinking = String(b.thinking ?? '') + d.thinking;
          } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
            b.signature = String(b.signature ?? '') + d.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(Number(ev.index ?? 0));
          if (b && b.type === 'tool_use') {
            try {
              b.input = b._json ? (JSON.parse(b._json) as Record<string, unknown>) : (b.input ?? {});
            } catch {
              b.input = {};
            }
          }
          if (b) delete b._json;
          break;
        }
        case 'message_delta': {
          if (ev.delta?.stop_reason) stopReason = String(ev.delta.stop_reason);
          if (ev.usage) {
            usage = usage ?? { prompt_tokens: 0, completion_tokens: 0 };
            usage.completion_tokens = Number(ev.usage.output_tokens ?? usage.completion_tokens ?? 0);
          }
          break;
        }
        default:
          break; // message_stop, ping, error events surface via SDK throw
      }
    }

    const rawBlocks = [...blocks.keys()].sort((a, b) => a - b).map((i) => blocks.get(i)!);
    const r = fromAnthropicMessage({ content: rawBlocks, stop_reason: stopReason, usage: null });
    if (stopReason === 'refusal') opts.onNote?.('(the model declined this request for safety reasons)');
    this.remember(rawBlocks, r.toolCalls);
    return {
      choices: [
        {
          message: { role: 'assistant', content: r.content, tool_calls: r.toolCalls },
          finish_reason: mapStopReason(stopReason, Boolean(r.toolCalls)),
        },
      ],
      usage,
      streamed: true,
      printed,
    };
  }
}
