// Pure-function fixtures for the OpenAI-normalized ↔ Anthropic wire translation.

import { describe, expect, it } from 'vitest';
import {
  fromAnthropicMessage,
  mapStopReason,
  mapUsage,
  rawBlockKey,
  toAnthropicRequest,
  type AnthropicBlock,
} from '../src/core/chat/anthropicTranslate.js';
import type { ChatMessage, ToolSpec } from '../src/core/types.js';

const OPTS = { model: 'claude-opus-5', maxTokens: 8192, promptCaching: false };

const TOOLS: ToolSpec[] = [
  { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } } },
];

describe('toAnthropicRequest', () => {
  it('lifts the system message to the top-level param and requires max_tokens', () => {
    const req = toAnthropicRequest(
      [
        { role: 'system', content: 'You are sensei.' },
        { role: 'user', content: 'hi' },
      ],
      [],
      OPTS,
    );
    expect(req.system).toEqual([{ type: 'text', text: 'You are sensei.' }]);
    expect(req.max_tokens).toBe(8192);
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('re-wraps tool specs as input_schema tools', () => {
    const req = toAnthropicRequest([{ role: 'user', content: 'x' }], TOOLS, OPTS);
    expect(req.tools).toHaveLength(2);
    expect(req.tools![0]).toEqual({
      name: 'read_file',
      description: 'read',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    });
  });

  it('groups consecutive tool results into ONE user message of tool_result blocks', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.log"}' } },
          { id: 't2', type: 'function', function: { name: 'grep', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'line one' },
      { role: 'tool', tool_call_id: 't2', content: '' },
      { role: 'user', content: 'and now?' },
    ];
    const req = toAnthropicRequest(messages, [], OPTS);
    expect(req.messages).toHaveLength(4);
    const assistant = req.messages[1];
    expect(assistant.role).toBe('assistant');
    const blocks = assistant.content as AnthropicBlock[];
    expect(blocks).toEqual([
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.log' } },
      { type: 'tool_use', id: 't2', name: 'grep', input: {} },
    ]);
    const results = req.messages[2];
    expect(results.role).toBe('user');
    expect(results.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'line one' },
      { type: 'tool_result', tool_use_id: 't2', content: '(no output)' },
    ]);
    expect(req.messages[3]).toEqual({ role: 'user', content: 'and now?' });
  });

  it('assistant text + tool_use in one turn; unparseable args become {}', () => {
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'Let me look.',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'grep', arguments: '{oops' } }],
        },
        { role: 'tool', tool_call_id: 't1', content: 'r' },
      ],
      [],
      OPTS,
    );
    const blocks = req.messages[1].content as AnthropicBlock[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'Let me look.' });
    expect(blocks[1]).toEqual({ type: 'tool_use', id: 't1', name: 'grep', input: {} });
  });

  it('prepends a user message when the transcript would start with assistant', () => {
    const req = toAnthropicRequest([{ role: 'assistant', content: 'earlier reply' }], [], OPTS);
    expect(req.messages[0]).toEqual({ role: 'user', content: '(continuing)' });
    expect(req.messages[1].role).toBe('assistant');
  });

  it('prompt caching places exactly three breakpoints: tools-last, system, final user block', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'out' },
    ];
    const req = toAnthropicRequest(messages, TOOLS, { ...OPTS, promptCaching: true });
    const flat = JSON.stringify(req);
    expect(flat.match(/cache_control/g)).toHaveLength(3);
    expect((req.tools![1] as Record<string, unknown>).cache_control).toEqual({ type: 'ephemeral' });
    expect(req.system![0].cache_control).toEqual({ type: 'ephemeral' });
    const lastMsg = req.messages[req.messages.length - 1].content as AnthropicBlock[];
    expect(lastMsg[lastMsg.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // string user content is converted to a block to carry the breakpoint
    const req2 = toAnthropicRequest(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'question' },
      ],
      [],
      { ...OPTS, promptCaching: true },
    );
    expect(req2.messages[0].content).toEqual([{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }]);
  });

  it('no cache_control anywhere when promptCaching is off', () => {
    const req = toAnthropicRequest(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
      ],
      TOOLS,
      OPTS,
    );
    expect(JSON.stringify(req)).not.toContain('cache_control');
  });

  it('substitutes cached raw blocks (thinking included) for a matching assistant turn', () => {
    const raw: AnthropicBlock[] = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig123' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't9', name: 'grep', input: { pattern: 'x' } },
    ];
    const cache = new Map([[rawBlockKey([{ id: 't9', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }]), raw]]);
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 't9', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] },
        { role: 'tool', tool_call_id: 't9', content: 'found' },
      ],
      [],
      { ...OPTS, rawBlockCache: cache },
    );
    expect(req.messages[1].content).toBe(raw);
  });
});

describe('fromAnthropicMessage / mappers', () => {
  it('maps stop reasons to OpenAI-style finish reasons', () => {
    expect(mapStopReason('end_turn', false)).toBe('stop');
    expect(mapStopReason('stop_sequence', false)).toBe('stop');
    expect(mapStopReason('tool_use', true)).toBe('tool_calls');
    expect(mapStopReason('max_tokens', false)).toBe('length');
    expect(mapStopReason('refusal', false)).toBe('stop');
    expect(mapStopReason(null, true)).toBe('tool_calls');
    expect(mapStopReason(null, false)).toBe('stop');
  });

  it('maps usage names and passes cache tokens through additively', () => {
    expect(
      mapUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    });
    expect(mapUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it('extracts text + tool calls, drops thinking from content but keeps raw blocks', () => {
    const r = fromAnthropicMessage({
      content: [
        { type: 'thinking', thinking: 'reasoning...', signature: 's' },
        { type: 'text', text: 'Found it. ' },
        { type: 'text', text: 'See a.log:42.' },
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.log' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(r.content).toBe('Found it. See a.log:42.');
    expect(r.toolCalls).toEqual([
      { id: 'tu1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.log"}' } },
    ]);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.rawBlocks).toHaveLength(4);
    expect(r.refusal).toBe(false);
  });

  it('flags refusal and returns null content for empty responses', () => {
    const r = fromAnthropicMessage({ content: [], stop_reason: 'refusal', usage: null });
    expect(r.refusal).toBe(true);
    expect(r.content).toBeNull();
    expect(r.toolCalls).toBeNull();
    expect(r.finishReason).toBe('stop');
  });
});
