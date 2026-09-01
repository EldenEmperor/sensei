// Pure translation between sensei's internal OpenAI-normalized shapes and the
// Anthropic Messages API wire. No SDK imports, no I/O — the unit-test surface.
//
// Internal → wire: system message lifted to the top-level `system` param;
// role:'tool' results regrouped as tool_result blocks in ONE user message per
// assistant turn (splitting them silently degrades parallel tool use);
// ToolSpec re-wrapped to {name, description, input_schema}.

import type { ChatMessage, ChatUsage, ToolCall, ToolSpec } from '../types.js';

export type AnthropicBlock = Record<string, unknown> & { type: string };

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: AnthropicBlock[];
  messages: { role: 'user' | 'assistant'; content: string | AnthropicBlock[] }[];
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
}

export interface TranslateOpts {
  model: string;
  maxTokens: number;
  promptCaching: boolean;
  /** Raw content blocks from the previous response, keyed by a signature of
   *  its tool_use ids — substituted verbatim (thinking blocks included) when
   *  the transcript's assistant turn matches. */
  rawBlockCache?: Map<string, AnthropicBlock[]>;
}

const CACHE_CONTROL = { type: 'ephemeral' } as const;

export function rawBlockKey(toolCalls: ToolCall[]): string {
  return toolCalls.map((tc) => tc.id).join('|');
}

function assistantToBlocks(m: ChatMessage, cache?: Map<string, AnthropicBlock[]>): AnthropicBlock[] {
  if (m.tool_calls && m.tool_calls.length > 0 && cache) {
    const hit = cache.get(rawBlockKey(m.tool_calls));
    if (hit) return hit;
  }
  const blocks: AnthropicBlock[] = [];
  if (typeof m.content === 'string' && m.content.trim() !== '') {
    blocks.push({ type: 'text', text: m.content });
  }
  for (const tc of m.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') input = parsed;
    } catch {
      // unparseable args: send an empty object; the tool result already
      // carried the parse error back to the model in the transcript
    }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return blocks;
}

export function toAnthropicRequest(
  messages: ChatMessage[],
  toolSpecs: ToolSpec[],
  opts: TranslateOpts,
): AnthropicRequest {
  const req: AnthropicRequest = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: [],
  };

  if (toolSpecs.length > 0) {
    req.tools = toolSpecs.map((s) => ({
      name: s.function.name,
      description: s.function.description,
      input_schema: s.function.parameters,
    }));
    if (opts.promptCaching && req.tools.length > 0) {
      (req.tools[req.tools.length - 1] as Record<string, unknown>).cache_control = CACHE_CONTROL;
    }
  }

  let i = 0;
  if (messages[0]?.role === 'system') {
    const sys: AnthropicBlock = { type: 'text', text: messages[0].content ?? '' };
    if (opts.promptCaching) sys.cache_control = CACHE_CONTROL;
    req.system = [sys];
    i = 1;
  }

  const out = req.messages;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'tool') {
      // group every consecutive tool result into one user message
      const blocks: AnthropicBlock[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const t = messages[i];
        blocks.push({
          type: 'tool_result',
          tool_use_id: t.tool_call_id ?? '',
          content: t.content && t.content !== '' ? t.content : '(no output)',
        });
        i++;
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = assistantToBlocks(m, opts.rawBlockCache);
      // Anthropic rejects an assistant message with no content blocks
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(no reply)' });
      out.push({ role: 'assistant', content: blocks });
    } else {
      // user (and any stray system mid-transcript, folded to user)
      if (Array.isArray(m.content)) {
        // image parts become base64 source blocks, text parts text blocks
        out.push({
          role: 'user',
          content: m.content.map((p): AnthropicBlock =>
            p.type === 'image'
              ? { type: 'image', source: { type: 'base64', media_type: p.media_type, data: p.data } }
              : { type: 'text', text: p.text },
          ),
        });
      } else {
        out.push({ role: 'user', content: m.content ?? '' });
      }
    }
    i++;
  }

  // Anthropic requires the first message to be from the user
  if (out.length === 0 || out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '(continuing)' });
  }

  // moving conversation-prefix breakpoint: last block of the final message.
  // Only ever stamped on a user message — an assistant-final can only come
  // from the raw-block cache, and mutating those shared blocks would leak
  // breakpoints (max 4 per request).
  const lastMsg = out[out.length - 1];
  if (opts.promptCaching && lastMsg && lastMsg.role === 'user') {
    const last = lastMsg;
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content !== '' ? last.content : '(empty)', cache_control: CACHE_CONTROL }];
    } else if (last.content.length > 0) {
      last.content[last.content.length - 1].cache_control = CACHE_CONTROL;
    }
  }

  return req;
}

// --- response → internal ----------------------------------------------------

export interface AnthropicMessageShape {
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
}

export function mapStopReason(stop: string | null | undefined, hasToolCalls: boolean): string {
  switch (stop) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'end_turn':
    case 'stop_sequence':
    case 'refusal':
    case 'pause_turn':
      return 'stop';
    default:
      return stop ?? (hasToolCalls ? 'tool_calls' : 'stop');
  }
}

export function mapUsage(u: AnthropicMessageShape['usage']): ChatUsage | null {
  if (!u) return null;
  const usage: ChatUsage = {
    prompt_tokens: Number(u.input_tokens ?? 0),
    completion_tokens: Number(u.output_tokens ?? 0),
  };
  if (u.cache_creation_input_tokens) usage.cache_creation_input_tokens = Number(u.cache_creation_input_tokens);
  if (u.cache_read_input_tokens) usage.cache_read_input_tokens = Number(u.cache_read_input_tokens);
  return usage;
}

export interface FromAnthropicResult {
  content: string | null;
  toolCalls: ToolCall[] | null;
  finishReason: string;
  usage: ChatUsage | null;
  /** Full raw blocks (thinking included) for the next request's fidelity cache. */
  rawBlocks: AnthropicBlock[];
  refusal: boolean;
}

export function fromAnthropicMessage(msg: AnthropicMessageShape): FromAnthropicResult {
  const rawBlocks = Array.isArray(msg.content) ? msg.content : [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of rawBlocks) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id ?? ''),
        type: 'function',
        function: { name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
      });
    }
    // thinking / redacted_thinking: kept in rawBlocks, never in content
  }
  const has = toolCalls.length > 0;
  return {
    content: text !== '' ? text : null,
    toolCalls: has ? toolCalls : null,
    finishReason: mapStopReason(msg.stop_reason, has),
    usage: mapUsage(msg.usage),
    rawBlocks,
    refusal: msg.stop_reason === 'refusal',
  };
}
