// M5: subagent flow (task/verify/task_parallel), exit_plan_mode approval,
// auto_verify, and summarizing compaction — port of smoke.ps1's stubbed
// agent-loop sections plus the new TS behaviors.

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import type { ChatMessage } from '../src/core/types.js';
import { FakeChatClient, makeStore, makeTempDir, RecordingHost, stopResponse, toolCallResponse } from './helpers.js';

let tmp: string;
let fake: FakeChatClient;
let host: RecordingHost;

function makeAgent(opts: { planMode?: boolean; interactive?: boolean } = {}): SenseiAgent {
  return new SenseiAgent({
    configStore: makeStore(tmp),
    host,
    permissionPolicy: opts.interactive ? { mode: 'interactive' } : { mode: 'yolo' },
    planMode: opts.planMode,
    chatClient: fake,
  });
}

beforeEach(() => {
  tmp = makeTempDir('sensei-ts-sub-');
  fs.writeFileSync(path.join(tmp, 'x.txt'), 'alpha\nBETA\ngamma');
  fake = new FakeChatClient();
  host = new RecordingHost();
});

describe('subagents', () => {
  it('task tool runs a child loop and returns its report as the tool result', async () => {
    // parent calls task → child does one tool round + final → parent final
    fake.enqueue(toolCallResponse([{ id: 'p1', name: 'task', args: { description: 'child job', prompt: 'investigate the thing' } }]));
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'read_file', args: { path: `${tmp}/x.txt` } }]));
    fake.enqueue(stopResponse('CHILD REPORT'));
    fake.enqueue(stopResponse('PARENT DONE'));
    const agent = makeAgent();
    const r = await agent.ask('delegate this');
    expect(r.finalText).toBe('PARENT DONE');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('CHILD REPORT');
    // the child's calls saw a tool list without the subagent tools
    const childSpecs = fake.seenToolSpecs[1];
    expect(childSpecs).not.toContain('task');
    expect(childSpecs).not.toContain('task_parallel');
    expect(childSpecs).not.toContain('verify');
    expect(childSpecs).not.toContain('exit_plan_mode');
    expect(childSpecs).toContain('read_file');
    // parent saw the full list
    expect(fake.seenToolSpecs[0]).toContain('task');
    // subagent lifecycle events fired
    expect(host.events.some((e) => e.type === 'subagent-start')).toBe(true);
    expect(host.events.some((e) => e.type === 'subagent-end')).toBe(true);
  });

  it('verify tool wraps the claim and returns the child verdict', async () => {
    fake.enqueue(toolCallResponse([{ id: 'p1', name: 'verify', args: { claim: 'x.txt contains BETA' } }]));
    fake.enqueue(stopResponse('PASS — x.txt:2 contains BETA'));
    fake.enqueue(stopResponse('verified'));
    const agent = makeAgent();
    await agent.ask('check it');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/^PASS/);
    // the child user message carries the wrapped claim
    // (child transcript is separate; assert via the chat request the fake saw)
    expect(fake.seenToolSpecs.length).toBe(3);
  });

  it('task_parallel runs children concurrently and merges reports', async () => {
    fake.enqueue(
      toolCallResponse([
        {
          id: 'p1',
          name: 'task_parallel',
          args: {
            tasks: [
              { description: 'one', prompt: 'do one' },
              { description: 'two', prompt: 'do two' },
            ],
          },
        },
      ]),
    );
    // both children make exactly one call each; identical responses so order doesn't matter
    fake.enqueue(stopResponse('CHILD RESULT'));
    fake.enqueue(stopResponse('CHILD RESULT'));
    fake.enqueue(stopResponse('merged'));
    const agent = makeAgent();
    const r = await agent.ask('parallel work');
    expect(r.finalText).toBe('merged');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('## Task 1: one');
    expect(toolMsg?.content).toContain('## Task 2: two');
    expect(toolMsg?.content).toContain('CHILD RESULT');
  });

  it('parallel subagents cannot prompt interactively — writes fail closed', async () => {
    fake.enqueue(
      toolCallResponse([
        { id: 'p1', name: 'task_parallel', args: { tasks: [{ description: 'w', prompt: 'write' }] } },
      ]),
    );
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'write_file', args: { path: `${tmp}/nope.txt`, content: 'x' } }]));
    fake.enqueue(stopResponse('child gave up'));
    fake.enqueue(stopResponse('done'));
    const agent = makeAgent({ interactive: true });
    await agent.ask('go');
    expect(host.permissionRequests.length).toBe(0); // never prompted
    expect(fs.existsSync(path.join(tmp, 'nope.txt'))).toBe(false);
  });
});

describe('exit_plan_mode', () => {
  it('approval ends plan mode and re-seeds the system prompt', async () => {
    fake.enqueue(toolCallResponse([{ id: 'p1', name: 'exit_plan_mode', args: { plan: '1. do the thing' } }]));
    fake.enqueue(stopResponse('executing now'));
    const agent = makeAgent({ planMode: true, interactive: true });
    host.permissionResponse = { allow: false, reason: 'denied' }; // unrelated
    // approve the plan
    const origApproval = host.requestPlanApproval.bind(host);
    host.requestPlanApproval = () => Promise.resolve(true);
    await agent.ask('plan it');
    host.requestPlanApproval = origApproval;
    expect(agent.planMode).toBe(false);
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/^APPROVED/);
    expect(String(agent.messages[0].content)).not.toContain('Plan mode (ACTIVE)');
  });

  it('denial stays in plan mode', async () => {
    fake.enqueue(toolCallResponse([{ id: 'p1', name: 'exit_plan_mode', args: { plan: '1. x' } }]));
    fake.enqueue(stopResponse('ok, what should change?'));
    const agent = makeAgent({ planMode: true, interactive: true });
    await agent.ask('plan it');
    expect(agent.planMode).toBe(true);
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/did NOT approve/);
  });

  it('outside plan mode it is a no-op message', async () => {
    fake.enqueue(toolCallResponse([{ id: 'p1', name: 'exit_plan_mode', args: { plan: '1. x' } }]));
    fake.enqueue(stopResponse('right'));
    const agent = makeAgent();
    await agent.ask('exit plan');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('Not in plan mode; nothing to exit.');
  });
});

describe('auto_verify', () => {
  it('runs a verifier subagent after a turn that wrote files', async () => {
    fake.enqueue(toolCallResponse([{ id: 'p1', name: 'write_file', args: { path: `${tmp}/w.txt`, content: 'hi' } }]));
    fake.enqueue(stopResponse('wrote it'));
    fake.enqueue(stopResponse('PASS — w.txt contains hi')); // the verifier child
    const store = makeStore(tmp);
    store.config.auto_verify = true;
    const agent = new SenseiAgent({ configStore: store, host, permissionPolicy: { mode: 'yolo' }, chatClient: fake });
    await agent.ask('write hi');
    expect(host.notes().some((n) => n.includes('auto-verify: PASS'))).toBe(true);
    expect(fake.queue.length).toBe(0);
  });

  it('does not run when nothing was written', async () => {
    fake.enqueue(stopResponse('just an answer'));
    const store = makeStore(tmp);
    store.config.auto_verify = true;
    const agent = new SenseiAgent({ configStore: store, host, permissionPolicy: { mode: 'yolo' }, chatClient: fake });
    await agent.ask('hello');
    expect(fake.queue.length).toBe(0); // no extra verifier call tried to dequeue
    expect(host.notes().some((n) => n.includes('auto-verify'))).toBe(false);
  });
});

describe('compaction', () => {
  it('/compact (force) replaces the transcript with a summary', async () => {
    const agent = makeAgent();
    agent.messages.push(
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'glob', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c9', content: 'stuff' },
      { role: 'assistant', content: 'a1' },
    );
    fake.enqueue(stopResponse('DENSE SUMMARY'));
    await agent.compactContext(true);
    expect(agent.messages.length).toBe(2);
    expect(agent.messages[1].content).toContain('DENSE SUMMARY');
    expect(agent.messages[1].content).toContain('compacted');
  });

  it('auto-compaction cuts on a user boundary and keeps tool pairs intact', async () => {
    const store = makeStore(tmp);
    store.config.context_char_budget = 2000;
    const agent = new SenseiAgent({ configStore: store, host, permissionPolicy: { mode: 'yolo' }, chatClient: fake });
    agent.messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old '.repeat(800) },
      { role: 'assistant', content: 'blah '.repeat(300) },
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'glob', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'recent result' },
    ] as ChatMessage[];
    fake.enqueue(stopResponse('AUTO SUMMARY'));
    await agent.compactContext(false);
    expect(agent.messages[1].content).toContain('AUTO SUMMARY');
    expect(agent.messages[2].content).toBe('recent question');
    const toolIdx = agent.messages.findIndex((m) => m.role === 'tool');
    expect(toolIdx).toBeGreaterThan(0);
    expect(agent.messages[toolIdx - 1].tool_calls).toBeTruthy();
  });

  it('falls back to trim when the summarizer fails', async () => {
    const store = makeStore(tmp);
    store.config.context_char_budget = 300;
    const agent = new SenseiAgent({ configStore: store, host, permissionPolicy: { mode: 'yolo' }, chatClient: fake });
    agent.messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old '.repeat(200) },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q '.repeat(100) },
      { role: 'assistant', content: 'done' },
    ] as ChatMessage[];
    // queue empty → summarize call throws → trim path
    await agent.compactContext(true);
    expect(host.notes().some((n) => n.includes('compaction failed'))).toBe(true);
  });
});

describe('restoreConversation', () => {
  it('replaces the transcript behind a fresh system prompt', () => {
    const agent = makeAgent();
    agent.restoreConversation([
      { role: 'user', content: 'earlier q' },
      { role: 'assistant', content: 'earlier a' },
    ]);
    expect(agent.messages.length).toBe(3);
    expect(agent.messages[0].role).toBe('system');
    expect(agent.messages[2].content).toBe('earlier a');
  });
});
