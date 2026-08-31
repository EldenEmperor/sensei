// Provider resolution matrix, preflight messages, cache-aware cost math,
// and the session envelope provider tag.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costLine, DEFAULT_CONFIG } from '../src/core/config.js';
import {
  activeModel,
  inferProviderFromModel,
  listProviders,
  preflightProvider,
  resolveProvider,
  setActiveModel,
} from '../src/core/providers.js';
import { loadSessionFile, saveSession, type SessionEnvelope } from '../src/core/sessions.js';
import type { SenseiConfig } from '../src/core/types.js';

function cfg(over: Partial<SenseiConfig> = {}): SenseiConfig {
  return { ...DEFAULT_CONFIG, ...over } as SenseiConfig;
}

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPANY_LLM_TOKEN'];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

describe('provider resolution', () => {
  it('infers anthropic from claude-* model names, openai otherwise', () => {
    expect(inferProviderFromModel('claude-opus-5')).toBe('anthropic');
    expect(inferProviderFromModel('gpt-5.1')).toBe('openai');
    expect(inferProviderFromModel('qwen3:14b')).toBe('openai');
  });

  it('model inference selects the anthropic built-in end to end', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const rp = resolveProvider(cfg({ model: 'claude-sonnet-4-6' }));
    expect(rp.name).toBe('anthropic');
    expect(rp.wire).toBe('anthropic');
    expect(rp.baseUrl).toBeNull();
    expect(rp.apiKey).toBe('sk-ant-test');
    expect(rp.authStyle).toBe('x-api-key');
    expect(rp.isLocal).toBe(false);
  });

  it('defaults to openai with the exact legacy key behavior (env over literal)', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    const rp = resolveProvider(cfg({ api_key: 'sk-config' }));
    expect(rp.name).toBe('openai');
    expect(rp.wire).toBe('openai');
    expect(rp.apiKey).toBe('sk-env');
    const rp2 = resolveProvider(cfg({ api_key: 'sk-config' }), {});
    delete process.env.OPENAI_API_KEY;
    const rp3 = resolveProvider(cfg({ api_key: 'sk-config' }));
    expect(rp3.apiKey).toBe('sk-config');
    expect(rp2.authStyle).toBe('bearer');
  });

  it('--local wins over config.provider and keeps ollama defaults', () => {
    const rp = resolveProvider(cfg({ provider: 'anthropic' }), { local: true });
    expect(rp.name).toBe('local');
    expect(rp.wire).toBe('openai');
    expect(rp.isLocal).toBe(true);
    expect(rp.apiKey).toBe('ollama');
    expect(rp.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('--provider wins over everything', () => {
    const rp = resolveProvider(cfg({ provider: 'anthropic', model: 'claude-opus-5' }), {
      provider: 'openai',
      local: true,
    });
    expect(rp.name).toBe('openai');
  });

  it('custom gateway entry: wire, base_url trimming, env-first key, headers, auth style', () => {
    process.env.COMPANY_LLM_TOKEN = 'tok-123';
    const c = cfg({
      provider: 'company',
      providers: {
        company: {
          wire: 'anthropic',
          base_url: 'https://llm-gw.corp.example/anthropic///',
          api_key_env: 'COMPANY_LLM_TOKEN',
          auth: 'bearer',
          headers: { 'x-corp-project': 'sensei' },
          model: 'claude-opus-5',
        },
      },
    });
    const rp = resolveProvider(c);
    expect(rp.wire).toBe('anthropic');
    expect(rp.baseUrl).toBe('https://llm-gw.corp.example/anthropic');
    expect(rp.apiKey).toBe('tok-123');
    expect(rp.authStyle).toBe('bearer');
    expect(rp.headers).toEqual({ 'x-corp-project': 'sensei' });
    expect(activeModel(c, rp)).toBe('claude-opus-5');
  });

  it('custom entry literal key + "none" no-auth sentinel', () => {
    const withKey = resolveProvider(
      cfg({ provider: 'gw', providers: { gw: { wire: 'openai', base_url: 'https://x', api_key: 'k' } } }),
    );
    expect(withKey.apiKey).toBe('k');
    expect(preflightProvider(withKey)).toBeNull();
    const noAuth = resolveProvider(
      cfg({ provider: 'gw', providers: { gw: { wire: 'openai', base_url: 'https://x', api_key: 'none' } } }),
    );
    expect(noAuth.apiKey).toBeNull();
    expect(noAuth.noAuth).toBe(true);
    expect(preflightProvider(noAuth)).toBeNull();
  });

  it('user entries can override a built-in (anthropic through a proxy)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    const rp = resolveProvider(
      cfg({ provider: 'anthropic', providers: { anthropic: { base_url: 'https://proxy.corp/v1' } } }),
    );
    expect(rp.wire).toBe('anthropic');
    expect(rp.baseUrl).toBe('https://proxy.corp/v1');
    expect(rp.apiKey).toBe('sk-ant');
  });

  it('unknown provider without a wire throws a helpful error', () => {
    expect(() => resolveProvider(cfg({ provider: 'nope' }))).toThrow(/unknown provider 'nope'/);
  });

  it('preflight names the env var when no key resolves', () => {
    expect(preflightProvider(resolveProvider(cfg({ model: 'claude-opus-5' })))).toMatch(/ANTHROPIC_API_KEY/);
    expect(preflightProvider(resolveProvider(cfg()))).toMatch(/OPENAI_API_KEY/);
    expect(preflightProvider(resolveProvider(cfg(), { local: true }))).toBeNull();
  });

  it('listProviders includes built-ins and custom entries', () => {
    const names = listProviders(cfg({ providers: { company: { wire: 'openai' } } }));
    expect(names).toEqual(expect.arrayContaining(['openai', 'anthropic', 'local', 'company']));
  });

  it('setActiveModel writes the key activeModel reads', () => {
    const c = cfg();
    const openai = resolveProvider(c);
    setActiveModel(c, openai, 'gpt-5');
    expect(c.model).toBe('gpt-5');
    const local = resolveProvider(c, { local: true });
    setActiveModel(c, local, 'llama3');
    expect(c.local_model).toBe('llama3');
    expect(c.model).toBe('gpt-5');
    const c2 = cfg({ provider: 'gw', providers: { gw: { wire: 'anthropic', model: 'claude-opus-5' } } });
    const gw = resolveProvider(c2);
    setActiveModel(c2, gw, 'claude-sonnet-5');
    expect(c2.providers!.gw.model).toBe('claude-sonnet-5');
    expect(activeModel(c2, resolveProvider(c2))).toBe('claude-sonnet-5');
  });
});

describe('cache-aware cost line', () => {
  it('prices claude models and bills cache read/write at their factors', () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    const c = cfg({ model: 'claude-opus-5' });
    const rp = resolveProvider(c);
    // 100k uncached in, 10k out, 500k cache read, 50k cache write
    const { costUsd, line } = costLine(c, rp, 100_000, 10_000, 500_000, 50_000);
    // 100k*5 + 50k*1.25*5 + 500k*0.1*5 + 10k*25 all /1e6
    const expected = (100_000 * 5 + 50_000 * 1.25 * 5 + 500_000 * 0.1 * 5 + 10_000 * 25) / 1e6;
    expect(costUsd).toBeCloseTo(expected, 6);
    expect(line).toContain('cached');
    expect(line).toContain('claude-opus-5');
  });

  it('does not double-count: cache tokens are separate from prompt tokens', () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    const c = cfg({ model: 'claude-haiku-4-5' });
    const rp = resolveProvider(c);
    const noCache = costLine(c, rp, 100_000, 0, 0, 0).costUsd!;
    const withCache = costLine(c, rp, 100_000, 0, 100_000, 0).costUsd!;
    expect(withCache).toBeCloseTo(noCache + (100_000 * 0.1 * 1) / 1e6, 9);
  });

  it('legacy boolean call still works (local = $0)', () => {
    const { costUsd, line } = costLine(cfg(), true, 1000, 1000);
    expect(costUsd).toBe(0);
    expect(line).toContain('$0');
  });
});

describe('session provider tag', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-prov-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips provider through the envelope', () => {
    const env: SessionEnvelope = {
      schema_version: 1,
      id: 'abc123abc123',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      cwd: dir,
      model: 'claude-opus-5',
      local: false,
      provider: 'anthropic',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const file = saveSession(dir, env);
    const loaded = loadSessionFile(file);
    expect(loaded.provider).toBe('anthropic');
    expect(loaded.messages).toHaveLength(1);
  });

  it('legacy envelopes derive provider from local; bare arrays get null', () => {
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ schema_version: 1, id: 'x', cwd: dir, model: 'q', local: true, messages: [] }),
    );
    expect(loadSessionFile(file).provider).toBe('local');
    const arr = path.join(dir, 'y.json');
    fs.writeFileSync(arr, JSON.stringify([{ role: 'user', content: 'hi' }]));
    expect(loadSessionFile(arr).provider).toBeNull();
  });
});
