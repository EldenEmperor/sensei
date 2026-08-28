// Ink component tests: boot the real App with a FakeChatClient and drive it
// through stdin — banner, slash commands, and a full fake turn.

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import { App, DeferredHost } from '../src/tui/App.js';
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
