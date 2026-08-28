// Port of smoke.ps1's "core tools" section.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import type { ToolContext } from '../src/tools/registry.js';
import { FakeChatClient, makeStore, makeTempDir, RecordingHost } from './helpers.js';

let tmp: string;
let agent: SenseiAgent;
const ctx = (): ToolContext => ({ cwd: tmp, emitNote: () => {}, setTodos: () => {} });

async function invokeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = agent.registry.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return String(await tool.handler(args, ctx()));
}

beforeAll(() => {
  tmp = makeTempDir('sensei-ts-tools-');
  agent = new SenseiAgent({
    configStore: makeStore(tmp),
    host: new RecordingHost(),
    permissionPolicy: { mode: 'yolo' },
    chatClient: new FakeChatClient(),
  });
});

describe('core tools', () => {
  it('write_file / read_file line numbers', async () => {
    expect(await invokeTool('write_file', { path: `${tmp}/x.txt`, content: 'alpha\nbeta\ngamma' })).toMatch(/Wrote/);
    const r = await invokeTool('read_file', { path: `${tmp}/x.txt` });
    expect(r).toMatch(/2→beta/);
  });

  it('read_file offset/limit', async () => {
    const r = await invokeTool('read_file', { path: `${tmp}/x.txt`, offset: 2, limit: 1 });
    expect(r).toMatch(/beta/);
    expect(r).not.toMatch(/alpha/);
    expect(r).toMatch(/offset=3/);
  });

  it('edit_file', async () => {
    expect(await invokeTool('edit_file', { path: `${tmp}/x.txt`, old_string: 'beta', new_string: 'BETA' })).toMatch(
      /Edited/,
    );
  });

  it('edit_file uniqueness enforced', async () => {
    const r = await invokeTool('edit_file', { path: `${tmp}/x.txt`, old_string: 'a', new_string: 'A' });
    expect(r).toMatch(/ERROR/);
    expect(r).toMatch(/times/);
  });

  it('multi_edit atomic: file unchanged on failure', async () => {
    const before = fs.readFileSync(`${tmp}/x.txt`, 'utf8');
    const r = await invokeTool('multi_edit', {
      path: `${tmp}/x.txt`,
      edits: [
        { old_string: 'alpha', new_string: 'ALPHA' },
        { old_string: 'NOT-THERE', new_string: 'x' },
      ],
    });
    expect(r).toMatch(/ERROR: edit #2/);
    expect(fs.readFileSync(`${tmp}/x.txt`, 'utf8')).toBe(before);
  });

  it('multi_edit applies all edits in order', async () => {
    const r = await invokeTool('multi_edit', {
      path: `${tmp}/x.txt`,
      edits: [
        { old_string: 'alpha', new_string: 'ALPHA' },
        { old_string: 'gamma', new_string: 'GAMMA' },
      ],
    });
    expect(r).toMatch(/Applied 2 edit/);
    expect(fs.readFileSync(`${tmp}/x.txt`, 'utf8')).toBe('ALPHA\nBETA\nGAMMA');
  });

  it('glob recursive with ** and top-level *', async () => {
    fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'top.log'), 'x');
    fs.writeFileSync(path.join(tmp, 'sub', 'deep.log'), 'x');
    const rec = await invokeTool('glob', { pattern: '**/*.log', path: tmp });
    expect(rec).toMatch(/top\.log/);
    expect(rec).toMatch(/deep\.log/);
    const top = await invokeTool('glob', { pattern: '*.log', path: tmp });
    expect(top).toMatch(/top\.log/);
    expect(top).not.toMatch(/deep\.log/);
  });

  it('grep files_with_matches and content modes', async () => {
    fs.writeFileSync(path.join(tmp, 'g1.txt'), 'hello world\nsecond line\n');
    fs.writeFileSync(path.join(tmp, 'g2.txt'), 'nothing here\n');
    const fm = await invokeTool('grep', { pattern: 'HELLO', path: tmp, glob: '*.txt' });
    expect(fm).toMatch(/g1\.txt/);
    expect(fm).not.toMatch(/g2\.txt/);
    const content = await invokeTool('grep', {
      pattern: 'second',
      path: tmp,
      glob: '*.txt',
      output_mode: 'content',
      context: 1,
    });
    expect(content).toMatch(/g1\.txt:2:second line/);
    expect(content).toMatch(/g1\.txt:1- hello world/);
  });

  it('grep count mode', async () => {
    const r = await invokeTool('grep', { pattern: 'l', path: path.join(tmp, 'g1.txt'), output_mode: 'count' });
    expect(r).toMatch(/^2\t/);
  });

  it('run_powershell exit code + stdout', async () => {
    const r = await invokeTool('run_powershell', { command: 'Write-Output hello; exit 3' });
    expect(r).toMatch(/exit_code: 3/);
    expect(r).toMatch(/hello/);
  });

  it('run_powershell timeout kills the command', async () => {
    const r = await invokeTool('run_powershell', { command: 'Start-Sleep -Seconds 30', timeout_seconds: 1 });
    expect(r).toMatch(/timed out after 1s/);
  }, 15000);
});
