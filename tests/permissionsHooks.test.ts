// M3 parity: deny rules (beat everything), acceptEdits mode, the hooks JSON
// stdout protocol, and the new hook events (SessionStart, PreCompact,
// SubagentStop, SessionEnd).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import { runHooks } from '../src/core/hooks.js';
import { acceptEditsAllows, isPathInside } from '../src/core/permissions.js';
import { FakeChatClient, makeStore, makeTempDir, RecordingHost, stopResponse, toolCallResponse } from './helpers.js';

function makeAgent(
  tmp: string,
  opts: {
    policy?: import('../src/core/types.js').PermissionPolicy;
    deny?: string[];
    hooks?: { event: string; matcher?: string; command: string }[];
  } = {},
) {
  const store = makeStore(tmp);
  if (opts.deny) store.config.permissions = { allow: [], deny: opts.deny };
  if (opts.hooks) store.config.hooks = opts.hooks;
  const fake = new FakeChatClient();
  const host = new RecordingHost();
  const agent = new SenseiAgent({
    configStore: store,
    host,
    permissionPolicy: opts.policy ?? { mode: 'yolo' },
    chatClient: fake,
  });
  return { agent, fake, host, store };
}

const hookCtx = (cwd: string) => ({ cwd, sessionId: 's1', note: () => {} });

describe('deny rules', () => {
  it('beat yolo mode', async () => {
    const tmp = makeTempDir('sensei-deny-');
    const { agent, fake } = makeAgent(tmp, { deny: ['write_file'] });
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'write_file', args: { path: 'x.txt', content: 'hi' } }]));
    fake.enqueue(stopResponse('done'));
    await agent.ask('write it');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('permissions.deny');
    expect(fs.existsSync(path.join(tmp, 'x.txt'))).toBe(false);
  });

  it('block read-only tools and match on the argument', async () => {
    const tmp = makeTempDir('sensei-deny2-');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'shh');
    fs.writeFileSync(path.join(tmp, 'open.txt'), 'ok');
    const { agent, fake } = makeAgent(tmp, { deny: ['read_file(*secret*)'] });
    fake.enqueue(
      toolCallResponse([
        { id: 'c1', name: 'read_file', args: { path: 'secret.txt' } },
        { id: 'c2', name: 'read_file', args: { path: 'open.txt' } },
      ]),
    );
    fake.enqueue(stopResponse('done'));
    await agent.ask('read both');
    const tools = agent.messages.filter((m) => m.role === 'tool');
    expect(tools[0].content).toContain('permissions.deny');
    expect(tools[1].content).toContain('ok');
  });
});

describe('acceptEdits mode', () => {
  it('auto-allows file edits inside cwd, still prompts outside and for shell', async () => {
    const tmp = makeTempDir('sensei-ae-');
    const outside = makeTempDir('sensei-ae-outside-');
    const { agent, fake, host } = makeAgent(tmp, { policy: { mode: 'interactive', acceptEdits: true } });
    host.permissionResponse = { allow: false, reason: 'denied' };
    fake.enqueue(
      toolCallResponse([
        { id: 'c1', name: 'write_file', args: { path: 'in.txt', content: 'inside' } },
        { id: 'c2', name: 'write_file', args: { path: path.join(outside, 'out.txt'), content: 'outside' } },
        { id: 'c3', name: 'run_powershell', args: { command: 'echo hi' } },
      ]),
    );
    fake.enqueue(stopResponse('done'));
    await agent.ask('edit things');
    expect(fs.readFileSync(path.join(tmp, 'in.txt'), 'utf8')).toBe('inside');
    expect(fs.existsSync(path.join(outside, 'out.txt'))).toBe(false);
    // the inside-cwd edit never reached the host; the other two did
    expect(host.permissionRequests.map((r) => r.toolName)).toEqual(['write_file', 'run_powershell']);
  });

  it('path helpers', () => {
    expect(isPathInside('C:\\proj\\a\\b.txt', 'C:\\proj', 'win32')).toBe(true);
    expect(isPathInside('C:\\PROJ\\a.txt', 'C:\\proj', 'win32')).toBe(true);
    expect(isPathInside('C:\\other\\a.txt', 'C:\\proj', 'win32')).toBe(false);
    expect(isPathInside('/home/u/p/x', '/home/u/p', 'linux')).toBe(true);
    expect(isPathInside('/home/u/P/x', '/home/u/p', 'linux')).toBe(false);
    expect(acceptEditsAllows('run_powershell', 'command', { command: 'rm x' }, 'C:\\proj')).toBe(false);
    expect(acceptEditsAllows('bash', 'command', { command: 'rm x' }, '/p')).toBe(false);
  });
});

describe('hooks JSON stdout protocol', () => {
  it('decision:"block" blocks with the JSON reason', async () => {
    const r = await runHooks(
      'PreToolUse',
      [{ event: 'PreToolUse', command: `Write-Output '{"decision":"block","reason":"nope from json"}'` }],
      hookCtx(makeTempDir('sensei-hj-')),
      { toolName: 'write_file', toolInput: {} },
    );
    expect(r.block).toBe(true);
    expect(r.reason).toBe('nope from json');
  });

  it('additionalContext is collected; systemMessage becomes a note', async () => {
    const notes: string[] = [];
    const r = await runHooks(
      'UserPromptSubmit',
      [
        {
          event: 'UserPromptSubmit',
          command: `Write-Output '{"additionalContext":"the deploy is frozen","systemMessage":"heads up"}'`,
        },
      ],
      { cwd: makeTempDir('sensei-hj2-'), sessionId: 's', note: (t) => notes.push(t) },
      { prompt: 'p' },
    );
    expect(r.block).toBe(false);
    expect(r.context).toEqual(['the deploy is frozen']);
    expect(notes.some((n) => n.includes('heads up'))).toBe(true);
  });

  it('malformed JSON falls back to the plain stdout note', async () => {
    const notes: string[] = [];
    const r = await runHooks(
      'PreToolUse',
      [{ event: 'PreToolUse', command: `Write-Output '{not json'` }],
      { cwd: makeTempDir('sensei-hj3-'), sessionId: 's', note: (t) => notes.push(t) },
      { toolName: 'x', toolInput: {} },
    );
    expect(r.block).toBe(false);
    expect(notes.some((n) => n.includes('{not json'))).toBe(true);
  });

  it('decision:"block" is ignored on non-blockable events', async () => {
    const r = await runHooks(
      'PostToolUse',
      [{ event: 'PostToolUse', command: `Write-Output '{"decision":"block","reason":"late"}'` }],
      hookCtx(makeTempDir('sensei-hj4-')),
      { toolName: 'x', toolInput: {}, toolResponse: 'y' },
    );
    expect(r.block).toBe(false);
  });
});

describe('new hook events', () => {
  it('SessionStart fires once and its additionalContext lands in the first prompt', async () => {
    const tmp = makeTempDir('sensei-ss-');
    const { agent, fake } = makeAgent(tmp, {
      hooks: [{ event: 'SessionStart', command: `Write-Output '{"additionalContext":"project memory: use pnpm"}'` }],
    });
    fake.enqueue(stopResponse('ok'));
    fake.enqueue(stopResponse('ok2'));
    await agent.ask('first');
    expect(agent.messages[1].content).toContain('project memory: use pnpm');
    await agent.ask('second');
    const second = agent.messages.filter((m) => m.role === 'user')[1];
    expect(second.content).not.toContain('project memory');
  });

  it('SubagentStop fires after a task subagent finishes', async () => {
    const tmp = makeTempDir('sensei-sas-');
    const marker = 'subagent-stop-marker.txt';
    const { agent, fake } = makeAgent(tmp, {
      hooks: [{ event: 'SubagentStop', command: `Set-Content -Path ${marker} -Value done` }],
    });
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'task', args: { description: 'side job', prompt: 'do it' } }]));
    fake.enqueue(stopResponse('subagent report'));
    fake.enqueue(stopResponse('parent done'));
    await agent.ask('delegate');
    expect(fs.existsSync(path.join(tmp, marker))).toBe(true);
  });

  it('PreCompact fires before forced compaction; SessionEnd fires once on endSession', async () => {
    const tmp = makeTempDir('sensei-pc-');
    const { agent, fake } = makeAgent(tmp, {
      hooks: [
        { event: 'PreCompact', command: `Set-Content -Path precompact.txt -Value done` },
        { event: 'SessionEnd', command: `Set-Content -Path sessionend.txt -Value done` },
      ],
    });
    fake.enqueue(stopResponse('a'));
    await agent.ask('hello');
    agent.messages.push(
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    );
    fake.enqueue(stopResponse('SUMMARY'));
    await agent.compactContext(true);
    expect(fs.existsSync(path.join(tmp, 'precompact.txt'))).toBe(true);
    await agent.endSession();
    await agent.endSession(); // idempotent
    expect(fs.existsSync(path.join(tmp, 'sessionend.txt'))).toBe(true);
  });
});
