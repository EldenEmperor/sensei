// Exhaustive slash-command sweep: every builtin dispatches through the real
// App and produces its expected output — a regression net for the command
// table (menu) vs handleSlash (dispatch) staying in sync.

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import { App, DeferredHost } from '../src/tui/App.js';
import { BUILTIN_COMMANDS } from '../src/tui/slashMenu.js';
import { FakeChatClient, makeStore, makeTempDir, stopResponse } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeTuiAgent(fake: FakeChatClient) {
  const tmp = makeTempDir('sensei-ts-cmds-');
  const store = makeStore(tmp);
  store.config.theme = false;
  store.config.stream = false;
  store.config.save_sessions = false;
  const host = new DeferredHost();
  const agent = new SenseiAgent({
    configStore: store,
    host,
    permissionPolicy: { mode: 'interactive' },
    chatClient: fake,
  });
  return { agent, host };
}

async function type(stdin: { write: (s: string) => void }, line: string): Promise<void> {
  stdin.write(line);
  await sleep(20);
  stdin.write('\r');
  await sleep(60);
}

describe('every builtin command dispatches', () => {
  it('read-only and config commands produce their expected output', async () => {
    const { agent, host } = makeTuiAgent(new FakeChatClient());
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);

    // command → substring the frame must contain after running it
    const table: [string, string][] = [
      ['/help', '/clear'],
      ['/design', 'usage: /design'],
      ['/also', 'usage: /also'],
      ['/btw', 'usage: /btw'],
      ['/subtask', 'usage: /subtask'],
      ['/stop', '(nothing running)'],
      ['/agents', 'no custom agents'],
      ['/mode', 'mode: code'],
      ['/mode logs', 'mode set to logs'],
      ['/mode code', 'mode set to code'],
      ['/style', 'style: default'],
      ['/style concise', 'style set to concise'],
      ['/color', 'accent: indigo'],
      ['/color jade', 'accent set to jade'],
      ['/model', 'model: gpt-5.1'],
      ['/model show', 'model: gpt-5.1'], // show displays, never sets
      ['/model list', 'claude-opus-5'], // cloud provider: known model names
      ['/provider', '/provider <name> switches'],
      ['/config', '"output_style"'],
      ['/permissions', 'no allow/deny rules'],
      ['/todos', '(no todos)'],
      ['/cost', 'tokens ~'],
      ['/mcp', 'no MCP servers configured'],
      ['/skills', 'no skills found'],
      ['/newskill', 'usage: /newskill'],
      ['/tasks', 'no background tasks'],
      ['/resume', 'no saved sessions'],
      ['/investigate', 'no *.log files found'],
      ['/memory', 'SENSEI.md'], // lists loaded files, or the "no SENSEI.md loaded" hint
    ];
    for (const [cmd, expected] of table) {
      await type(stdin, cmd);
      expect(lastFrame()!, `after ${cmd}`).toContain(expected);
    }

    // /compact with a short transcript is a no-op — must not error
    await type(stdin, '/compact');
    await sleep(100);

    // /plan toggles both ways
    await type(stdin, '/plan');
    expect(lastFrame()).toContain('plan mode ON');
    await type(stdin, '/plan');
    expect(lastFrame()).toContain('plan mode OFF');

    // /clear resets
    await type(stdin, '/clear');
    expect(lastFrame()).toContain('conversation cleared');

    // nothing above fell through to the unknown-command branch or errored
    // (note: '✗ no key' in the /provider listing is expected output, so the
    // error check looks for the actual failure strings instead)
    const frame = lastFrame()!;
    expect(frame).not.toContain('unknown command');
    expect(frame).not.toContain('FakeChatClient: queue empty');
  }, 20_000);

  it('every builtin also answers --help', async () => {
    const { agent, host } = makeTuiAgent(new FakeChatClient());
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    for (const c of BUILTIN_COMMANDS) {
      await type(stdin, `/${c.name} --help`);
      expect(lastFrame()!, `--help for /${c.name}`).toContain(`usage: /${c.name}`);
    }
    expect(lastFrame()).not.toContain('unknown command');
  }, 20_000);

  it('/init runs a model turn; unknown commands still say so; /quit exits', async () => {
    const fake = new FakeChatClient();
    fake.enqueue(stopResponse('SENSEI.md written'));
    const { agent, host } = makeTuiAgent(fake);
    const { lastFrame, stdin } = render(
      React.createElement(App, { agent, host, version: 'test', bannerFrames: [] }),
    );
    await sleep(50);
    await type(stdin, '/init');
    await sleep(200);
    expect(lastFrame()).toContain('SENSEI.md written');

    stdin.write('/nope-not-a-command');
    await sleep(20);
    stdin.write('\r');
    await sleep(60);
    expect(lastFrame()).toContain('unknown command');

    await type(stdin, '/quit');
    // exit unmounts; getting here without a throw is the assertion
  }, 15_000);
});
