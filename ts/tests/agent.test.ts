// Port of smoke.ps1's stubbed agent-loop + auto-continue sections, plus the
// orphan stop+tool_calls fix and non-interactive permission denial.

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import { isPassiveReply } from '../src/core/prompts.js';
import { FakeChatClient, makeStore, makeTempDir, RecordingHost, stopResponse, toolCallResponse } from './helpers.js';

const PASSIVE =
  'To install wget, follow these steps:\n**Step 1**: Open PowerShell as Administrator\n**Step 2**: Run the following command:\nchoco install wget\nLet me know if you run into issues!';

describe('isPassiveReply detector', () => {
  it('flags a step-by-step tutorial', () => expect(isPassiveReply(PASSIVE)).toBe(true));
  it('flags two markers without Step', () =>
    expect(isPassiveReply('Run the following command in your terminal.\nLet me know if that works')).toBe(true));
  it('strips think blocks before detecting', () =>
    expect(isPassiveReply(`<think>I should just tell them how</think>${PASSIVE}`)).toBe(true));
  it('ignores a tutorial only inside a think block', () =>
    expect(isPassiveReply('<think>Step 1: run this. Let me know</think>Installed wget 1.21 via winget.')).toBe(false));
  it('does not flag an active answer', () =>
    expect(isPassiveReply('Installed wget 1.21 via winget --scope user; verified with wget --version.')).toBe(false));
  it('null content is not passive', () => expect(isPassiveReply(null)).toBe(false));
  it('a single marker is not enough', () =>
    expect(isPassiveReply('You can run log_stats on this next time.')).toBe(false));
});

describe('agent loop', () => {
  let tmp: string;
  let fake: FakeChatClient;
  let host: RecordingHost;

  function makeAgent(policy: 'yolo' | 'allowlist' = 'yolo'): SenseiAgent {
    return new SenseiAgent({
      configStore: makeStore(tmp),
      host,
      permissionPolicy: policy === 'yolo' ? { mode: 'yolo' } : { mode: 'allowlist' },
      chatClient: fake,
    });
  }

  beforeEach(() => {
    tmp = makeTempDir('sensei-ts-agent-');
    fs.writeFileSync(path.join(tmp, 'x.txt'), 'alpha\nBETA\ngamma');
    fake = new FakeChatClient();
    host = new RecordingHost();
  });

  it('returns final text and keeps the transcript shape (sys,user,asst+tc,tool,asst)', async () => {
    fake.enqueue(toolCallResponse([{ id: 'call_1', name: 'read_file', args: { path: `${tmp}/x.txt` } }]));
    fake.enqueue(stopResponse('the answer is 42'));
    const agent = makeAgent();
    const r = await agent.ask('what is in x.txt?');
    expect(r.finalText).toBe('the answer is 42');
    expect(agent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(agent.messages[3].tool_call_id).toBe('call_1');
    expect(agent.messages[3].content).toMatch(/BETA/);
  });

  it('nudges a passive reply once and lets the model recover', async () => {
    fake.enqueue(stopResponse(PASSIVE));
    fake.enqueue(toolCallResponse([{ id: 'call_n1', name: 'read_file', args: { path: `${tmp}/x.txt` } }]));
    fake.enqueue(stopResponse('installed it'));
    const agent = makeAgent();
    const r = await agent.ask('install wget for me');
    expect(r.finalText).toBe('installed it');
    expect(r.rounds).toBeGreaterThanOrEqual(3);
    const nudges = agent.messages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && /<system-note>.*do the task NOW/.test(m.content),
    );
    expect(nudges.length).toBe(1);
    const pIdx = agent.messages.findIndex((m) => m.role === 'assistant' && /Step 1/.test(String(m.content)));
    expect(agent.messages[pIdx + 1].content).toMatch(/<system-note>/);
  });

  it('caps at one nudge per turn: a second passive reply is returned as final', async () => {
    fake.enqueue(stopResponse(PASSIVE));
    fake.enqueue(stopResponse(PASSIVE));
    const agent = makeAgent();
    const r = await agent.ask('install wget for me');
    expect(r.finalText).toMatch(/Step 1/);
    expect(fake.queue.length).toBe(0);
    const nudges = agent.messages.filter((m) => /<system-note>.*do the task NOW/.test(String(m.content ?? '')));
    expect(nudges.length).toBe(1);
  });

  it('never nudges a normal answer', async () => {
    fake.enqueue(stopResponse('the log shows an OOM at 02:47:13'));
    const agent = makeAgent();
    const r = await agent.ask('what crashed?');
    expect(r.rounds).toBe(1);
    expect(agent.messages.length).toBe(3);
  });

  it('auto_continue=false disables the nudge', async () => {
    fake.enqueue(stopResponse(PASSIVE));
    const store = makeStore(tmp);
    store.config.auto_continue = false;
    const agent = new SenseiAgent({
      configStore: store,
      host,
      permissionPolicy: { mode: 'yolo' },
      chatClient: fake,
    });
    const r = await agent.ask('install wget for me');
    expect(r.rounds).toBe(1);
    expect(r.finalText).toMatch(/Step 1/);
  });

  it('never nudges a length-truncated reply', async () => {
    fake.enqueue(stopResponse(PASSIVE, 'length'));
    const agent = makeAgent();
    const r = await agent.ask('install wget for me');
    expect(r.rounds).toBe(1);
    expect(r.finishReason).toBe('length');
  });

  it('orphan fix: finish_reason=stop WITH tool_calls still executes them', async () => {
    fake.enqueue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'let me check',
            tool_calls: [
              {
                id: 'call_s',
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: `${tmp}/x.txt` }) },
              },
            ],
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    fake.enqueue(stopResponse('file contains BETA'));
    const agent = makeAgent();
    const r = await agent.ask('check x.txt');
    const orphanTool = agent.messages.filter((m) => m.role === 'tool' && m.tool_call_id === 'call_s');
    expect(orphanTool.length).toBe(1);
    expect(orphanTool[0].content).toMatch(/BETA/);
    expect(r.rounds).toBe(2);
    expect(r.finalText).toBe('file contains BETA');
  });

  it('non-interactive policy denies write tools with the canonical error', async () => {
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'write_file', args: { path: `${tmp}/y.txt`, content: 'x' } }]));
    fake.enqueue(stopResponse('done'));
    const agent = makeAgent('allowlist');
    const r = await agent.ask('write something');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/permission denied \(non-interactive mode/);
    expect(r.permissionDenials.length).toBe(1);
    expect(r.permissionDenials[0].tool).toBe('write_file');
    expect(fs.existsSync(path.join(tmp, 'y.txt'))).toBe(false);
  });

  it('allowlist rules from config permit matching calls', async () => {
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'write_file', args: { path: `${tmp}/y.txt`, content: 'ok' } }]));
    fake.enqueue(stopResponse('done'));
    const store = makeStore(tmp);
    store.config.permissions = { allow: [`write_file(${tmp.replace(/\\/g, '\\')}\\*)`] };
    const agent = new SenseiAgent({
      configStore: store,
      host,
      permissionPolicy: { mode: 'allowlist' },
      chatClient: fake,
    });
    await agent.ask('write something');
    expect(fs.readFileSync(path.join(tmp, 'y.txt'), 'utf8')).toBe('ok');
  });

  it('plan mode blocks write tools with the plan-mode message', async () => {
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'write_file', args: { path: `${tmp}/z.txt`, content: 'x' } }]));
    fake.enqueue(stopResponse('understood'));
    const store = makeStore(tmp);
    const agent = new SenseiAgent({
      configStore: store,
      host,
      permissionPolicy: { mode: 'yolo' },
      planMode: true,
      chatClient: fake,
    });
    await agent.ask('do it');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/plan mode is read-only/);
    expect(fs.existsSync(path.join(tmp, 'z.txt'))).toBe(false);
  });

  it('@file expansion inlines small files and flags big ones', async () => {
    fake.enqueue(stopResponse('ok'));
    const big = path.join(tmp, 'big.log');
    fs.writeFileSync(big, 'x'.repeat(300000));
    const agent = makeAgent();
    await agent.ask(`look at @${tmp.replace(/\\/g, '/')}/x.txt and @${big.replace(/\\/g, '/')}`);
    const user = String(agent.messages[1].content);
    expect(user).toMatch(/--- @file: .*x\.txt ---/);
    expect(user).toMatch(/alpha/);
    expect(user).toMatch(/too large to inline/);
  });
});
