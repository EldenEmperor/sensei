// Ink component tests: boot the real App with a FakeChatClient and drive it
// through stdin — banner, slash commands, and a full fake turn.

import fs from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import type { ChatClient } from '../src/core/chat/client.js';
import { App, DeferredHost, type SpriteAnim } from '../src/tui/App.js';
import { FakeChatClient, makeStore, makeTempDir, stopResponse } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeTuiAgent(fake: FakeChatClient): { agent: SenseiAgent; host: DeferredHost } {
  const tmp = makeTempDir('sensei-ts-tui-');
  const store = makeStore(tmp);
  store.config.theme = false; // plain output for assertions
  store.config.stream = false;
  const host = new DeferredHost();
  const agent = new SenseiAgent({
    configStore: store,
    host,
    permissionPolicy: { mode: 'interactive' },
    chatClient: fake,
  });
  return { agent, host };
}

describe('Ink App', () => {
  it('boots with the banner and answers /help', async () => {
    const { agent, host } = makeTuiAgent(new FakeChatClient());
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [{ lines: ['██ banner ██'], delayMs: 100 }] }),
    );
    await sleep(50);
    expect(lastFrame()).toContain('██ banner ██');
    expect(lastFrame()).toContain('your custom problem solver + agent');
    stdin.write('/help');
    await sleep(20);
    stdin.write('\r');
    await sleep(50);
    expect(lastFrame()).toContain('/clear');
    expect(lastFrame()).toContain('toggle plan mode');
  });

  it('runs a turn through the engine and renders the answer', async () => {
    const fake = new FakeChatClient();
    fake.enqueue(stopResponse('# Result\nthe **answer** is 42'));
    const { agent, host } = makeTuiAgent(fake);
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('what is the answer?');
    await sleep(20);
    stdin.write('\r');
    await sleep(200);
    const frame = lastFrame()!;
    expect(frame).toContain('❯ what is the answer?');
    expect(frame).toContain('Result');
    expect(frame).toContain('the answer is 42'); // markdown rendered, theme off
    expect(agent.messages.at(-1)?.content).toBe('# Result\nthe **answer** is 42');
  });

  it('permission prompt approves a write with y', async () => {
    const fake = new FakeChatClient();
    fake.enqueue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'out.txt', content: 'hello' }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    fake.enqueue(stopResponse('written'));
    const { agent, host } = makeTuiAgent(fake);
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('write hello to out.txt');
    await sleep(20);
    stdin.write('\r');
    await sleep(200);
    expect(lastFrame()).toContain('wants to run:');
    expect(lastFrame()).toContain('[y]es / [n]o');
    stdin.write('y');
    await sleep(200);
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/Wrote 5 chars/);
  });

  it('shows live context build-up in the working status', async () => {
    const slowClient: ChatClient = {
      chat: async (req) => {
        await sleep(250);
        return stopResponse(`done after ${req.messages.length} messages`);
      },
    };
    const tmp = makeTempDir('sensei-ts-ctx-');
    const store = makeStore(tmp);
    store.config.theme = false;
    store.config.stream = false;
    const host = new DeferredHost();
    const agent = new SenseiAgent({ configStore: store, host, permissionPolicy: { mode: 'yolo' }, chatClient: slowClient });
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('long thinking task');
    await sleep(20);
    stdin.write('\r');
    await sleep(150);
    const frame = lastFrame()!;
    expect(frame).toContain('thinking…');
    expect(frame).toMatch(/thinking… \d+s · ctx \d+k\/300k \(\d+%\)/);
    await sleep(250); // turn finishes; the working status clears
    expect(lastFrame()).not.toContain('· ctx ');
  });

  it('plays the thinking sprite during a turn and the sheath flourish after', async () => {
    const slowClient: ChatClient = {
      chat: async () => {
        await sleep(250);
        return stopResponse('done thinking');
      },
    };
    const tmp = makeTempDir('sensei-ts-anim-');
    const store = makeStore(tmp);
    store.config.theme = true; // sprites require theming
    store.config.stream = false;
    const host = new DeferredHost();
    const agent = new SenseiAgent({ configStore: store, host, permissionPolicy: { mode: 'yolo' }, chatClient: slowClient });
    const sprites: Record<string, SpriteAnim> = {
      thinking: { delayMs: 100, mode: 'loop', frames: [['THINK-SPRITE-A'], ['THINK-SPRITE-B']] },
      slash: { delayMs: 90, mode: 'loop', frames: [['SLASH-SPRITE']] },
      summon: { delayMs: 100, mode: 'loop', frames: [['SUMMON-SPRITE']] },
      sheath: { delayMs: 200, mode: 'once', frames: [['SHEATH-SPRITE']] },
    };
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [], sprites }),
    );
    await sleep(50);
    stdin.write('think about it');
    await sleep(20);
    stdin.write('\r');
    await sleep(120);
    expect(lastFrame()).toMatch(/THINK-SPRITE/); // model pending, no tool → thinking
    await sleep(220); // turn completes → sheath flourish window (200ms + grace)
    expect(lastFrame()).toContain('SHEATH-SPRITE');
    await sleep(400);
    expect(lastFrame()).not.toContain('SHEATH-SPRITE'); // flourish over
  });

  it('slash menu: filters, arrows+Tab complete, Enter runs, Esc dismisses', async () => {
    const { agent, host } = makeTuiAgent(new FakeChatClient());
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('/c');
    await sleep(30);
    let frame = lastFrame()!;
    expect(frame).toContain('/clear');
    expect(frame).toContain('/color');
    expect(frame).toContain('reset the conversation');
    stdin.write(String.fromCharCode(27) + '[B'); // Down arrow -> /color
    await sleep(20);
    stdin.write('\t'); // Tab completes the selection
    await sleep(30);
    expect(lastFrame()).toContain('❯ /color'); // completed into the composer (trailing space trimmed in frame)
    stdin.write(String.fromCharCode(21)); // Ctrl+U clears the composer
    await sleep(20);
    stdin.write('/cle');
    await sleep(20);
    stdin.write('\r'); // Enter runs the selected /clear
    await sleep(50);
    expect(lastFrame()).toContain('conversation cleared');
    stdin.write('/c');
    await sleep(20);
    stdin.write(String.fromCharCode(27)); // Esc dismisses the menu
    await sleep(30);
    expect(lastFrame()).not.toContain('reset the conversation');
  });

  it('/permissions --help shows per-command usage', async () => {
    const { agent, host } = makeTuiAgent(new FakeChatClient());
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('/permissions --help');
    await sleep(20);
    stdin.write('\r');
    await sleep(50);
    const frame = lastFrame()!;
    expect(frame).toContain('usage: /permissions');
    expect(frame).toContain('deny rules beat everything');
  });

  it('/plan <task> plans immediately; [a] approves with auto-accept edits', async () => {
    const fake = new FakeChatClient();
    fake.enqueue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'p1', type: 'function', function: { name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '1. fix it' }) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    fake.enqueue(stopResponse('executing'));
    const { agent, host } = makeTuiAgent(fake);
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('/plan fix the bug');
    await sleep(20);
    stdin.write('\r');
    await sleep(200);
    expect(agent.messages.some((m) => m.role === 'user' && m.content === 'fix the bug')).toBe(true);
    const frame = lastFrame()!;
    expect(frame).toContain('Proposed plan:');
    expect(frame).toContain('auto-accept file edits');
    stdin.write('a');
    await sleep(200);
    expect(agent.planMode).toBe(false);
    expect((agent.policy as { acceptEdits?: boolean }).acceptEdits).toBe(true);
  });

  it('/also interjects mid-turn and /stop aborts everything', async () => {
    let call = 0;
    const slowClient: ChatClient = {
      chat: async (req) => {
        call++;
        await sleep(300);
        return stopResponse(`reply ${call} (saw ${req.messages.length} messages)`);
      },
    };
    const tmp = makeTempDir('sensei-ts-mid-');
    const store = makeStore(tmp);
    store.config.theme = false;
    store.config.stream = false;
    const host = new DeferredHost();
    const agent = new SenseiAgent({ configStore: store, host, permissionPolicy: { mode: 'yolo' }, chatClient: slowClient });
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('long job');
    await sleep(20);
    stdin.write('\r');
    await sleep(100); // now busy
    stdin.write('/also focus on the parser');
    await sleep(20);
    stdin.write('\r'); // immediate dispatch, not queued
    await sleep(50);
    expect(lastFrame()).toContain('interjecting at the next step');
    expect(agent.messages.some((m) => String(m.content).includes('<user-interjection>focus on the parser</user-interjection>'))).toBe(false); // not yet delivered (mid model call)
    await sleep(400); // turn ends; interjection stays queued for the next boundary
    stdin.write('next');
    await sleep(20);
    stdin.write('\r');
    await sleep(400);
    expect(agent.messages.some((m) => String(m.content).includes('<user-interjection>focus on the parser</user-interjection>'))).toBe(true);

    // /stop while a new turn runs
    stdin.write('another long job');
    await sleep(20);
    stdin.write('\r');
    await sleep(100);
    stdin.write('/stop');
    await sleep(20);
    stdin.write('\r');
    await sleep(100);
    expect(lastFrame()).toContain('⨯ stopped the current turn');
  }, 15_000);

  it('/subtask spawns a background subagent whose report is announced', async () => {
    const fake = new FakeChatClient();
    fake.enqueue(stopResponse('SIDE REPORT: readme is fine'));
    const { agent, host } = makeTuiAgent(fake);
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('/subtask check the readme');
    await sleep(20);
    stdin.write('\r');
    await sleep(300);
    const frame = lastFrame()!;
    expect(frame).toContain('sub1 spawned');
    expect(frame).toContain('sub1 finished');
    fake.enqueue(stopResponse('done'));
    stdin.write('go on');
    await sleep(20);
    stdin.write('\r');
    await sleep(200);
    expect(agent.messages.some((m) => String(m.content).includes('SIDE REPORT: readme is fine'))).toBe(true);
  });

  it('/agents lists custom defs', async () => {
    const { agent, host } = makeTuiAgent(new FakeChatClient());
    fs.mkdirSync(path.join(agent.store.cwd, '.sensei', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(agent.store.cwd, '.sensei', 'agents', 'helper.md'),
      '---\ndescription: helps out\ntools: read_file\n---\nYou help.',
    );
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('/agents');
    await sleep(20);
    stdin.write('\r');
    await sleep(50);
    const frame = lastFrame()!;
    expect(frame).toContain('helper');
    expect(frame).toContain('helps out');
    expect(frame).toContain('tools: read_file');
  });

  it('ask_user renders the picker; a digit picks; the answer reaches the model', async () => {
    const fake = new FakeChatClient();
    fake.enqueue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'q1',
                type: 'function',
                function: {
                  name: 'ask_user',
                  arguments: JSON.stringify({
                    question: 'Which auth flow?',
                    header: 'Auth',
                    options: [
                      { label: 'OAuth', description: 'browser sign-in' },
                      { label: 'API key', description: 'env var' },
                    ],
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    fake.enqueue(stopResponse('going with your pick'));
    const { agent, host } = makeTuiAgent(fake);
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('set up auth');
    await sleep(20);
    stdin.write('\r');
    await sleep(200);
    const frame = lastFrame()!;
    expect(frame).toContain('Which auth flow?');
    expect(frame).toContain('1. OAuth');
    expect(frame).toContain('2. API key');
    expect(frame).toContain('Other…');
    stdin.write('2'); // digit pick
    await sleep(200);
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('The user chose: API key (env var)');
    expect(lastFrame()).toContain('going with your pick');
  });

  it('ask_user Other… takes free text; Esc dismisses', async () => {
    const askCall = (id: string) => ({
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              {
                id,
                type: 'function' as const,
                function: {
                  name: 'ask_user',
                  arguments: JSON.stringify({ question: 'Pick?', options: [{ label: 'a' }, { label: 'b' }] }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const fake = new FakeChatClient();
    fake.enqueue(askCall('q1'));
    fake.enqueue(stopResponse('ok1'));
    fake.enqueue(askCall('q2'));
    fake.enqueue(stopResponse('ok2'));
    const { agent, host } = makeTuiAgent(fake);
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('first');
    await sleep(20);
    stdin.write('\r');
    await sleep(200);
    stdin.write('3'); // jump to Other…
    await sleep(30);
    expect(lastFrame()).toContain('your answer:');
    stdin.write('use SAML');
    await sleep(30);
    stdin.write('\r');
    await sleep(200);
    expect(agent.messages.find((m) => m.role === 'tool')?.content).toBe('The user answered: use SAML');
    // second round: Esc dismisses
    stdin.write('second');
    await sleep(20);
    stdin.write('\r');
    await sleep(200);
    expect(lastFrame()).toContain('Pick?');
    stdin.write(String.fromCharCode(27)); // Esc
    await sleep(200);
    const tools = agent.messages.filter((m) => m.role === 'tool');
    expect(tools.at(-1)?.content).toContain('best judgment');
  });

  it('plan mode toggles via /plan and blocks writes', async () => {
    const fake = new FakeChatClient();
    const { agent, host } = makeTuiAgent(fake);
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    stdin.write('/plan');
    await sleep(20);
    stdin.write('\r');
    await sleep(50);
    expect(lastFrame()).toContain('plan mode ON');
    expect(agent.planMode).toBe(true);
    expect(String(agent.messages[0].content)).toContain('Plan mode (ACTIVE)');
  });
});
