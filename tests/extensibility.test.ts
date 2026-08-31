// M5: custom subagent definitions (.sensei/agents), command frontmatter with
// $1..$n and allowed-tools, and the subagent_type flow through the task tool.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import { getAgentDefs, parseAgentFile } from '../src/core/agents.js';
import { buildCommandPrompt, findCustomCommand, parseCommandFile, splitArgs } from '../src/core/commands.js';
import { FakeChatClient, makeStore, makeTempDir, RecordingHost, stopResponse, toolCallResponse } from './helpers.js';

function writeAgent(dir: string, file: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

describe('custom agent defs', () => {
  it('parses frontmatter and body', () => {
    const tmp = makeTempDir('sensei-adef-');
    const p = path.join(tmp, 'triager.md');
    fs.writeFileSync(
      p,
      '---\nname: log-triager\ndescription: triages logs\ntools: read_file, grep, log_stats\nmodel: claude-haiku-4-5\n---\nYou are a triager. Report the top issues.',
    );
    const def = parseAgentFile(p, 'project')!;
    expect(def.name).toBe('log-triager');
    expect(def.description).toBe('triages logs');
    expect(def.tools).toEqual(['read_file', 'grep', 'log_stats']);
    expect(def.model).toBe('claude-haiku-4-5');
    expect(def.prompt).toBe('You are a triager. Report the top issues.');
  });

  it('project shadows user by name; filename is the fallback name', () => {
    const tmp = makeTempDir('sensei-adefs-');
    const home = path.join(tmp, 'home');
    writeAgent(path.join(tmp, '.sensei', 'agents'), 'helper.md', 'project prompt');
    writeAgent(path.join(home, 'agents'), 'helper.md', 'user prompt');
    writeAgent(path.join(home, 'agents'), 'extra.md', 'extra prompt');
    const defs = getAgentDefs(tmp, home);
    expect(defs.map((d) => `${d.name}:${d.source}`)).toEqual(['helper:project', 'extra:user']);
    expect(defs[0].prompt).toBe('project prompt');
    expect(defs[0].tools).toBeNull();
  });

  it('task exposes subagent_type and the def drives the subagent', async () => {
    const tmp = makeTempDir('sensei-atask-');
    writeAgent(
      path.join(tmp, '.sensei', 'agents'),
      'greeter.md',
      '---\ndescription: says hi\ntools: read_file\n---\nYou are the greeter.',
    );
    const store = makeStore(tmp);
    const fake = new FakeChatClient();
    const agent = new SenseiAgent({
      configStore: store,
      host: new RecordingHost(),
      permissionPolicy: { mode: 'yolo' },
      chatClient: fake,
    });
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'task', args: { description: 'greet', prompt: 'go', subagent_type: 'greeter' } }]));
    fake.enqueue(stopResponse('subagent says hi'));
    fake.enqueue(stopResponse('done'));
    await agent.ask('use the greeter');
    // the task tool advertises the custom agent
    const spec = agent.registry.getSpecs([]).find((s) => s.function.name === 'task')!;
    expect(spec.function.description).toContain('greeter — says hi');
    // the subagent call (2nd chat) got only the allowed tools (minus subagent tools)
    const subagentTools = fake.seenToolSpecs[1];
    expect(subagentTools).toEqual(['read_file']);
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('subagent says hi');
  });

  it('unknown subagent_type errors with the available list', async () => {
    const tmp = makeTempDir('sensei-atask2-');
    const store = makeStore(tmp);
    const fake = new FakeChatClient();
    const agent = new SenseiAgent({
      configStore: store,
      host: new RecordingHost(),
      permissionPolicy: { mode: 'yolo' },
      chatClient: fake,
    });
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'task', args: { description: 'x', prompt: 'y', subagent_type: 'ghost' } }]));
    fake.enqueue(stopResponse('done'));
    await agent.ask('go');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain("unknown subagent_type 'ghost'");
  });
});

describe('command frontmatter', () => {
  it('parses description, argument-hint, allowed-tools; strips frontmatter from the body', () => {
    const tmp = makeTempDir('sensei-cmd-');
    const p = path.join(tmp, 'triage.md');
    fs.writeFileSync(
      p,
      '---\ndescription: triage a log\nargument-hint: <file> [level]\nallowed-tools: log_stats, log_slice\n---\nTriage $1 at level $2. Raw: $ARGUMENTS',
    );
    const cmd = parseCommandFile(p, 'triage');
    expect(cmd.description).toBe('triage a log');
    expect(cmd.argumentHint).toBe('<file> [level]');
    expect(cmd.allowedTools).toEqual(['log_stats', 'log_slice']);
    expect(cmd.body).not.toContain('---');
    expect(buildCommandPrompt(cmd, 'app.log ERROR')).toBe('Triage app.log at level ERROR. Raw: app.log ERROR');
  });

  it('splitArgs honors double quotes; missing positionals become empty', () => {
    expect(splitArgs('a "b c" d')).toEqual(['a', 'b c', 'd']);
    const cmd = { name: 'x', path: '', description: '', argumentHint: '', allowedTools: [], body: 'one=$1 two=$2' };
    expect(buildCommandPrompt(cmd, 'only')).toBe('one=only two=');
  });

  it('findCustomCommand prefers project over user and works without frontmatter', () => {
    const tmp = makeTempDir('sensei-cmd2-');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(tmp, '.sensei', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(home, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.sensei', 'commands', 'go.md'), 'project body $ARGUMENTS');
    fs.writeFileSync(path.join(home, 'commands', 'go.md'), 'user body');
    const cmd = findCustomCommand('go', tmp, home)!;
    expect(cmd.body).toBe('project body $ARGUMENTS');
    expect(cmd.allowedTools).toEqual([]);
    expect(findCustomCommand('missing', tmp, home)).toBeNull();
  });

  it('allowed-tools rules apply only for that turn', async () => {
    const tmp = makeTempDir('sensei-cmd3-');
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'x');
    const store = makeStore(tmp);
    const fake = new FakeChatClient();
    const host = new RecordingHost();
    host.permissionResponse = { allow: false, reason: 'denied' };
    const agent = new SenseiAgent({
      configStore: store,
      host,
      permissionPolicy: { mode: 'interactive' },
      chatClient: fake,
    });
    // turn 1: write_file allowed via extraAllowRules
    fake.enqueue(toolCallResponse([{ id: 'c1', name: 'write_file', args: { path: 'out.txt', content: 'yes' } }]));
    fake.enqueue(stopResponse('ok'));
    await agent.ask('/cmd expansion', { extraAllowRules: ['write_file'] });
    expect(fs.readFileSync(path.join(tmp, 'out.txt'), 'utf8')).toBe('yes');
    // turn 2: same tool now prompts (and is denied)
    fake.enqueue(toolCallResponse([{ id: 'c2', name: 'write_file', args: { path: 'out2.txt', content: 'no' } }]));
    fake.enqueue(stopResponse('ok'));
    await agent.ask('again');
    expect(fs.existsSync(path.join(tmp, 'out2.txt'))).toBe(false);
    expect(host.permissionRequests.map((r) => r.toolName)).toEqual(['write_file']);
  });
});
