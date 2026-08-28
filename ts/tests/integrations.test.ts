// M4: hooks, skills, background tasks, web parsers, and an MCP round-trip
// against a real SDK server subprocess.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import { runHooks } from '../src/core/hooks.js';
import { getSkillPrompt, getSkills, parseSkillFile, registerSkillTool } from '../src/core/skills.js';
import { McpManager, safeToolName } from '../src/mcp/client.js';
import { ToolRegistry, type ToolContext } from '../src/tools/registry.js';
import {
  addBackgroundTaskNotices,
  resetBackgroundTasks,
  startBackgroundTask,
} from '../src/tools/tasks.js';
import { extractLinks, formatPage, htmlToText, parseDdgResults } from '../src/tools/web.js';
import { FakeChatClient, makeStore, makeTempDir, RecordingHost, stopResponse, toolCallResponse } from './helpers.js';
import type { ChatMessage } from '../src/core/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('hooks', () => {
  const notes: string[] = [];
  const ctx = { cwd: process.cwd(), sessionId: 'test', note: (t: string) => notes.push(t) };

  it('exit 2 on PreToolUse blocks with stderr as the reason', async () => {
    const r = await runHooks(
      'PreToolUse',
      [{ event: 'PreToolUse', matcher: 'run_powershell', command: "[Console]::Error.Write('nope'); exit 2" }],
      ctx,
      { toolName: 'run_powershell', toolInput: { command: 'x' } },
    );
    expect(r.block).toBe(true);
    expect(r.reason).toBe('nope');
  }, 60000);

  it('matcher skips non-matching tools', async () => {
    const r = await runHooks(
      'PreToolUse',
      [{ event: 'PreToolUse', matcher: 'run_powershell', command: 'exit 2' }],
      ctx,
      { toolName: 'read_file', toolInput: {} },
    );
    expect(r.block).toBe(false);
  }, 60000);

  it('exit 0 stdout becomes a note; payload arrives on stdin', async () => {
    notes.length = 0;
    const r = await runHooks(
      'UserPromptSubmit',
      [{ event: 'UserPromptSubmit', command: '$p = [Console]::In.ReadToEnd() | ConvertFrom-Json; Write-Output "saw: $($p.prompt)"' }],
      ctx,
      { prompt: 'hello hooks' },
    );
    expect(r.block).toBe(false);
    expect(notes.some((n) => n.includes('saw: hello hooks'))).toBe(true);
  }, 60000);
});

describe('skills', () => {
  let tmp: string;
  let configDir: string;

  beforeAll(() => {
    tmp = makeTempDir('sensei-ts-skills-');
    configDir = path.join(tmp, 'home');
    const proj = path.join(tmp, '.sensei', 'skills', 'triage');
    const user1 = path.join(configDir, 'skills', 'triage');
    const user2 = path.join(configDir, 'skills', 'deploy');
    for (const d of [proj, user1, user2]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(proj, 'SKILL.md'),
      '---\nname: triage\ndescription: project triage procedure\n---\nRun log_stats on $ARGUMENTS first.',
    );
    fs.writeFileSync(path.join(user1, 'SKILL.md'), '---\nname: triage\ndescription: user triage\n---\nuser body');
    fs.writeFileSync(path.join(user2, 'SKILL.md'), '---\nname: deploy\ndescription: deploy checklist\n---\ncheck twice');
  });

  it('parses frontmatter and body', () => {
    const meta = parseSkillFile(path.join(tmp, '.sensei', 'skills', 'triage', 'SKILL.md'));
    expect(meta.name).toBe('triage');
    expect(meta.description).toBe('project triage procedure');
    expect(meta.body).toContain('log_stats');
  });

  it('project shadows user; both sources found', () => {
    const skills = getSkills(tmp, configDir);
    expect(skills.map((s) => s.name).sort()).toEqual(['deploy', 'triage']);
    expect(skills.find((s) => s.name === 'triage')?.source).toBe('project');
  });

  it('skill prompt substitutes $ARGUMENTS', () => {
    const s = getSkills(tmp, configDir).find((x) => x.name === 'triage')!;
    const p = getSkillPrompt(s, 'app.log');
    expect(p).toContain('Run log_stats on app.log first.');
    expect(p).toContain('# Skill: triage');
  });

  it('the skill tool lists skills in its description and loads bodies', async () => {
    const registry = new ToolRegistry();
    registerSkillTool(registry, tmp, configDir);
    const tool = registry.get('skill')!;
    expect(tool.description).toContain('triage: project triage procedure');
    expect(tool.description).toContain('deploy: deploy checklist');
    const ctx = { cwd: tmp, configDir, config: {} as never, local: false, emitNote: () => {}, setTodos: () => {} };
    const body = String(await tool.handler({ name: 'deploy' }, ctx));
    expect(body).toContain('check twice');
    const err = String(await tool.handler({ name: 'nope' }, ctx));
    expect(err).toMatch(/ERROR: no skill named 'nope'/);
  });

  it('no skills → tool removed', () => {
    const registry = new ToolRegistry();
    const empty = makeTempDir('sensei-ts-noskills-');
    registerSkillTool(registry, empty, path.join(empty, 'home'));
    expect(registry.get('skill')).toBeUndefined();
  });
});

describe('background tasks', () => {
  it('start → exit → task_output reads delta once → notices injected once', async () => {
    resetBackgroundTasks();
    const tmp = makeTempDir('sensei-ts-tasks-');
    const started = startBackgroundTask("Write-Output 'bg says hi'", tmp, tmp);
    expect(started).toMatch(/Started background task bg1/);

    const registry = new ToolRegistry();
    const { registerTaskTools } = await import('../src/tools/tasks.js');
    registerTaskTools(registry);
    const ctx: ToolContext = { cwd: tmp, configDir: tmp, config: {} as never, local: false, emitNote: () => {}, setTodos: () => {} };

    // wait for the pwsh child to finish
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      const r = String(await registry.get('task_output')!.handler({ task_id: 'bg1' }, ctx));
      if (r.includes('exited')) break;
    }
    const out = String(await registry.get('task_output')!.handler({ task_id: 'bg1' }, ctx));
    expect(out).toMatch(/exited \(code 0\)/);
    // delta semantics: output may have been consumed by the polling loop above,
    // so drain once more and expect "(no new output)"
    const again = String(await registry.get('task_output')!.handler({ task_id: 'bg1' }, ctx));
    expect(again).toContain('(no new output)');

    const messages: ChatMessage[] = [];
    addBackgroundTaskNotices(messages);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toMatch(/<system-note>Background task bg1 .*exited with code 0/);
    addBackgroundTaskNotices(messages);
    expect(messages.length).toBe(1); // only notified once

    expect(String(await registry.get('task_output')!.handler({ task_id: 'nope' }, ctx))).toMatch(/ERROR: no such task/);
  }, 60000);

  it('run_powershell run_in_background routes to the task manager', async () => {
    resetBackgroundTasks();
    const tmp = makeTempDir('sensei-ts-tasks2-');
    const fake = new FakeChatClient();
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'run_powershell', args: { command: "Write-Output 'x'", run_in_background: true } }]));
    fake.enqueue(stopResponse('started'));
    const agent = new SenseiAgent({
      configStore: makeStore(tmp),
      host: new RecordingHost(),
      permissionPolicy: { mode: 'yolo' },
      chatClient: fake,
    });
    await agent.ask('run it in the background');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/Started background task bg1/);
  }, 60000);
});

describe('web parsers', () => {
  const html =
    '<html><head><style>body{}</style><script>evil()</script></head><body>' +
    '<nav>menu</nav><h1>Title</h1><p>Hello &amp; welcome</p><li>item</li>' +
    '<a href="https://a.example/page">A</a> <a href="/rel">R</a> <a href="mailto:x@y">M</a>' +
    '<a href="https://a.example/page">dup</a></body></html>';

  it('htmlToText strips scripts/nav and decodes entities', () => {
    const t = htmlToText(html);
    expect(t).toContain('Title');
    expect(t).toContain('Hello & welcome');
    expect(t).not.toContain('evil');
    expect(t).not.toContain('menu');
  });

  it('extractLinks resolves relative and dedupes', () => {
    const links = extractLinks(html, 'https://base.example/dir/');
    expect(links).toEqual(['https://a.example/page', 'https://base.example/rel']);
  });

  it('formatPage pretty-prints JSON and appends links for HTML', () => {
    expect(formatPage('{"a":1}', 'application/json', 'https://x')).toBe('{\n  "a": 1\n}');
    const page = formatPage(html, 'text/html', 'https://base.example/');
    expect(page).toContain('--- Links found (2) ---');
    expect(formatPage('plain text', 'text/plain', 'https://x')).toBe('plain text');
  });

  it('parseDdgResults unwraps uddg redirect links and pairs snippets', () => {
    const ddg =
      '<a class="result__a" href="/l/?kh=1&uddg=https%3A%2F%2Fexample.com%2Fdoc">Example <b>Doc</b></a>' +
      '<a class="result__snippet" href="#">A useful page</a>';
    const r = parseDdgResults(ddg);
    expect(r.length).toBe(1);
    expect(r[0].url).toBe('https://example.com/doc');
    expect(r[0].title).toBe('Example Doc');
    expect(r[0].snippet).toBe('A useful page');
  });
});

describe('MCP (mock SDK server)', () => {
  let manager: McpManager;
  const notes: string[] = [];

  beforeAll(async () => {
    const tmp = makeTempDir('sensei-ts-mcp-');
    manager = new McpManager({ configDir: tmp, cwd: tmp, callTimeoutSec: 30 });
    await manager.startAll(
      { mock: { command: process.execPath, args: [path.join(here, 'mock-mcp-server.mjs')] } },
      (t) => notes.push(t),
    );
  }, 60000);

  afterAll(async () => {
    await manager.stopAll();
  });

  it('connects and discovers tools', () => {
    expect(notes.some((n) => n.includes('mock connected (1 tools)'))).toBe(true);
    const s = manager.servers.get('mock')!;
    expect(s.status).toBe('connected');
    expect(s.tools[0].name).toBe('echo');
  });

  it('registers mcp__mock__echo and round-trips a call', async () => {
    const registry = new ToolRegistry();
    manager.registerTools(registry);
    const tool = registry.get('mcp__mock__echo');
    expect(tool).toBeTruthy();
    const ctx: ToolContext = { cwd: '.', configDir: '.', config: {} as never, local: false, emitNote: () => {}, setTodos: () => {} };
    const r = String(await tool!.handler({ text: 'round trip' }, ctx));
    expect(r).toBe('echo: round trip');
  }, 30000);

  it('sanitizes unsafe tool names', () => {
    expect(safeToolName('mcp__a b__c/d')).toBe('mcp__a_b__c_d');
  });

  it('unknown server call errors cleanly', async () => {
    const r = await manager.call('ghost', 'echo', {});
    expect(r).toMatch(/ERROR: MCP server 'ghost' is not connected/);
  });
});
