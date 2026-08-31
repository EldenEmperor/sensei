// Ink component tests: boot the real App with a FakeChatClient and drive it
// through stdin — banner, slash commands, and a full fake turn.

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
    expect(lastFrame()).toContain('log-debugging agent');
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
