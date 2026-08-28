// Port of smoke.ps1's log-tool sections: stats/slice against the committed
// 200k-line app.log + answers.json, timeline/trace/baseline/search fixtures,
// and the log_investigate format-map suite (families, cache, hints, edges).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import { getLogTemplate } from '../src/logtools/template.js';
import { cosine, setEmbeddingsProvider } from '../src/logtools/search.js';
import type { ToolContext } from '../src/tools/registry.js';
import { FakeChatClient, makeStore, makeTempDir, RecordingHost } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoTests = path.resolve(here, '..', '..', 'tests');
const appLog = path.join(repoTests, 'app.log');
const fixtures = path.join(repoTests, 'fixtures');

let tmp: string;
let agent: SenseiAgent;
let answers: Record<string, number | string>;

const ctx = (): ToolContext => ({
  cwd: tmp,
  configDir: agent.store.configDir,
  config: agent.store.config,
  local: agent.local,
  emitNote: () => {},
  setTodos: () => {},
});

async function invokeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = agent.registry.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return String(await tool.handler(args, ctx()));
}

beforeAll(() => {
  tmp = makeTempDir('sensei-ts-logtools-');
  agent = new SenseiAgent({
    configStore: makeStore(tmp),
    host: new RecordingHost(),
    permissionPolicy: { mode: 'yolo' },
    local: true,
    chatClient: new FakeChatClient(),
  });
  answers = JSON.parse(fs.readFileSync(`${appLog}.answers.json`, 'utf8'));
});

describe('log_stats + log_slice on the 200k-line app.log', () => {
  let stats = '';
  it('log_stats totals match the generator ground truth', async () => {
    stats = await invokeTool('log_stats', { path: appLog });
    const m = stats.match(/lines: ([\d,]+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1].replace(/,/g, ''))).toBe(answers.total_lines);
    const err = stats.match(/ERROR: (\d+)/);
    expect(Number(err![1])).toBe(answers.error_total);
  });

  it('log_stats surfaces the FATAL + OOM template', () => {
    expect(stats).toMatch(/FATAL: 1/);
    expect(stats).toMatch(/OutOfMemoryException/);
  });

  it('log_slice tail reaches the last line', async () => {
    const r = await invokeTool('log_slice', { path: appLog, tail: 5 });
    expect(r).toContain(`${answers.total_lines}→`);
  });

  it('log_slice time range catches the crash', async () => {
    const r = await invokeTool('log_slice', {
      path: appLog,
      from_time: '2026-08-27 02:46:30',
      to_time: '2026-08-27 02:47:30',
    });
    expect(r).toMatch(/OutOfMemoryException/);
  }, 30000);
});

describe('log_timeline / log_trace', () => {
  it('merges by timestamp and tags sources; trace orders across files', async () => {
    const logA = path.join(tmp, 'a.log');
    const logB = path.join(tmp, 'b.log');
    fs.writeFileSync(logA, '2026-01-01 00:00:01 [INFO] A-one\n2026-01-01 00:00:03 [INFO] A-three req-ZZZ');
    fs.writeFileSync(logB, '2026-01-01 00:00:02 [INFO] B-two req-ZZZ\n2026-01-01 00:00:04 [INFO] B-four');
    const r = await invokeTool('log_timeline', { paths: [logA, logB] });
    const iA1 = r.indexOf('A-one');
    const iB2 = r.indexOf('B-two');
    const iA3 = r.indexOf('A-three');
    const iB4 = r.indexOf('B-four');
    expect(iA1).toBeGreaterThanOrEqual(0);
    expect(iA1).toBeLessThan(iB2);
    expect(iB2).toBeLessThan(iA3);
    expect(iA3).toBeLessThan(iB4);
    expect(r).toMatch(/\[a\.log\]/);
    expect(r).toMatch(/\[b\.log\]/);
    const t = await invokeTool('log_trace', { id: 'req-ZZZ', paths: [logA, logB] });
    expect(t.indexOf('B-two')).toBeLessThan(t.indexOf('A-three'));
  });
});

describe('log_baseline', () => {
  it('save + diff flags new templates and count spikes', async () => {
    const baseLog = path.join(tmp, 'base.log');
    const newLog = path.join(tmp, 'new.log');
    const bl = Array.from({ length: 10 }, (_, i) => `2026-01-01 00:00:0${(i + 1) % 10} [ERROR] Payment failed for order ${i + 1}`);
    fs.writeFileSync(baseLog, bl.join('\n'));
    const nl = Array.from({ length: 50 }, (_, i) => `2026-01-01 00:00:0${(i + 1) % 10} [ERROR] Payment failed for order ${i + 1}`);
    nl.push(...Array.from({ length: 3 }, (_, i) => `2026-01-01 00:01:0${i + 1} [ERROR] Kafka broker unreachable`));
    fs.writeFileSync(newLog, nl.join('\n'));
    expect(await invokeTool('log_baseline', { action: 'save', path: baseLog, name: 'b1' })).toMatch(/saved baseline/);
    const r = await invokeTool('log_baseline', { action: 'diff', path: newLog, name: 'b1' });
    expect(r).toMatch(/NEW error/);
    expect(r).toMatch(/Kafka/);
    expect(r).toMatch(/COUNT SPIKES/);
    expect(r).toMatch(/Payment/);
  });
});

describe('log_search (stubbed embeddings)', () => {
  it('ranks by semantic similarity', async () => {
    const memLog = path.join(tmp, 'mem.log');
    fs.writeFileSync(
      memLog,
      [
        '2026-01-01 00:00:01 [ERROR] OutOfMemoryException heap exhausted',
        '2026-01-01 00:00:02 [ERROR] OutOfMemoryException heap exhausted',
        '2026-01-01 00:00:03 [ERROR] OutOfMemoryException heap exhausted',
        '2026-01-01 00:00:04 [ERROR] Disk write failed no space left',
        '2026-01-01 00:00:05 [ERROR] Disk write failed no space left',
      ].join('\n'),
    );
    setEmbeddingsProvider(async (inputs) => inputs.map((s) => (/memory|heap/i.test(s) ? [1, 0] : [0, 1])));
    try {
      const r = await invokeTool('log_search', { path: memLog, query: 'memory pressure', top: 2 });
      expect(r.indexOf('OutOfMemory')).toBeLessThan(r.indexOf('Disk'));
    } finally {
      setEmbeddingsProvider(null);
    }
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe('log_investigate', () => {
  let appCopy: string;

  beforeAll(() => {
    appCopy = path.join(tmp, 'app.log');
    fs.copyFileSync(appLog, appCopy); // never mutate the committed fixture
  });

  it('maps the generated app.log: family, both ts styles, rare FATAL, blocks', async () => {
    const r = await invokeTool('log_investigate', { path: appCopy });
    expect(r).toMatch(/timestamped-text/);
    expect(r).toMatch(/iso8601/);
    expect(r).toMatch(/us-legacy/);
    expect(r).toMatch(/rare/i);
    expect(r).toMatch(/OutOfMemoryException/);
    expect(r).toMatch(/continuation|block/i);
  }, 120000);

  it('serves the second call from cache, invalidates on change, rejects a bad stored fingerprint', async () => {
    const r2 = await invokeTool('log_investigate', { path: appCopy });
    expect(r2).toMatch(/\(cached/);
    fs.appendFileSync(appCopy, '\n2026-08-27 03:59:59.000 [INFO] appended after analysis');
    const r3 = await invokeTool('log_investigate', { path: appCopy });
    expect(r3).not.toMatch(/\(cached/);
    // corrupt the stored fingerprint → full-fingerprint validation forces a rebuild
    const formatsDir = path.join(agent.store.configDir, 'formats');
    const newest = fs
      .readdirSync(formatsDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => ({ n, t: fs.statSync(path.join(formatsDir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    const mapFile = path.join(formatsDir, newest.n);
    const mj = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    mj.fingerprint = 'bogus';
    fs.writeFileSync(mapFile, JSON.stringify(mj), 'utf8');
    const r4 = await invokeTool('log_investigate', { path: appCopy });
    expect(r4).not.toMatch(/\(cached/);
  }, 240000);

  it('detects json-lines with field types and extra level vocabulary', async () => {
    const rj = await invokeTool('log_investigate', { path: path.join(fixtures, 'sample-jsonl.log') });
    expect(rj).toMatch(/json-lines/);
    expect(rj).toMatch(/duration_ms/);
    expect(rj).toMatch(/\bint\b/);
    expect(rj).toMatch(/severe/i);
  });

  it('detects logfmt, apache-access, and csv with header columns', async () => {
    expect(await invokeTool('log_investigate', { path: path.join(fixtures, 'sample-logfmt.log') })).toMatch(/logfmt/);
    expect(await invokeTool('log_investigate', { path: path.join(fixtures, 'sample-access.log') })).toMatch(
      /apache-access/,
    );
    const rc = await invokeTool('log_investigate', { path: path.join(fixtures, 'sample.csv') });
    expect(rc).toMatch(/\bcsv\b/);
    expect(rc).toMatch(/component/);
  });

  it('hints consumption: epoch json-lines becomes navigable after a map', async () => {
    const epochLog = path.join(tmp, 'epoch.log');
    fs.copyFileSync(path.join(fixtures, 'sample-jsonl-epoch.log'), epochLog);
    const before = await invokeTool('log_stats', { path: epochLog });
    expect(before).toMatch(/no recognizable timestamps/);
    await invokeTool('log_investigate', { path: epochLog });
    const after = await invokeTool('log_stats', { path: epochLog });
    expect(after).toMatch(/time range: \d{4}/);
    const sl = await invokeTool('log_slice', {
      path: epochLog,
      from_time: '2026-08-26 00:00:00',
      to_time: '2026-08-29 00:00:00',
    });
    expect(sl).not.toMatch(/no lines in that time range/);
    expect(sl).toMatch(/batch processed/);
  });

  it('template placeholders: <ip> and key=<v>', () => {
    expect(getLogTemplate('2026-01-01 00:00:00 conn from 10.0.0.7:443 key=abc ok')).toMatch(/<ip>/);
    expect(getLogTemplate('x key=order:12345 hit=True')).toMatch(/key=<v>/);
  });

  it('handles empty and binary files gracefully', async () => {
    const emptyLog = path.join(tmp, 'empty.log');
    fs.writeFileSync(emptyLog, '');
    expect(await invokeTool('log_investigate', { path: emptyLog })).toMatch(/empty/i);
    const binLog = path.join(tmp, 'bin.log');
    fs.writeFileSync(binLog, Buffer.from([0, 1, 2, 0, 65, 66, 0]));
    expect(await invokeTool('log_investigate', { path: binLog })).toMatch(/binary/i);
  });
});
