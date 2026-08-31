// Config load/save, project .sensei.json merge, SENSEI.md memory, cost line.
// Shares ~/.sensei with the PowerShell variant: same config.json keys, and any
// keys this variant doesn't know about are preserved on save.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SenseiConfig } from './types.js';
import { activeModel, type ResolvedProvider } from './providers.js';

export const DEFAULT_CONFIG: SenseiConfig = {
  model: 'gpt-5.1',
  api_key: null,
  mode: 'code',
  local_model: 'qwen3:14b',
  local_base_url: 'http://localhost:11434/v1',
  max_output_tokens: 8192,
  theme: true,
  stream: true,
  save_sessions: true,
  context_char_budget: 300000,
  mcp_call_timeout: 120,
  mcpServers: {},
  permissions: { allow: [] },
  hooks: [],
  prices: {},
  output_style: 'default',
  auto_verify: false,
  auto_continue: true,
  embed_model: 'nomic-embed-text',
  accent: 'indigo',
};

export const OUTPUT_STYLES: Record<string, string> = {
  default: '',
  concise: 'Answer as tersely as correctness allows: lead with the conclusion, minimal prose, no preamble.',
  explanatory:
    'Explain your reasoning as you go: state what you checked, why, and what it implies, so the reader learns the debugging path. Still perform all actions with your own tools — explain what you did, never hand the user steps to run in your place.',
  teaching:
    'Teach as you answer: define the concepts and PowerShell/log techniques involved, and note what the reader should look for next time. Still perform all actions with your own tools — teach by doing, never by handing the user steps to run in your place.',
};

// $/1M tokens (input, output) — estimates; override via config "prices": {"model": [in, out]}
export const MODEL_PRICES: Record<string, [number, number]> = {
  'gpt-5.1': [1.25, 10.0],
  'gpt-5': [1.25, 10.0],
  'gpt-5-mini': [0.25, 2.0],
  'gpt-4o': [2.5, 10.0],
  'claude-fable-5': [10.0, 50.0],
  'claude-opus-5': [5.0, 25.0],
  'claude-opus-4-8': [5.0, 25.0],
  'claude-opus-4-7': [5.0, 25.0],
  'claude-opus-4-6': [5.0, 25.0],
  'claude-sonnet-5': [2.0, 10.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-haiku-4-5': [1.0, 5.0],
};

// Anthropic prompt caching: multipliers on the input price
export const CACHE_PRICE_FACTORS = { write: 1.25, read: 0.1 };

export interface AllowRule {
  rule: string;
  source: 'user' | 'project' | 'cli';
}

export class ConfigStore {
  readonly configDir: string;
  readonly configPath: string;
  readonly sessionDir: string;
  config: SenseiConfig;
  projectConfig: Record<string, unknown>;
  readonly cwd: string;

  constructor(opts: { configDir?: string; cwd?: string } = {}) {
    this.configDir = opts.configDir ?? path.join(os.homedir(), '.sensei');
    this.configPath = path.join(this.configDir, 'config.json');
    this.sessionDir = path.join(this.configDir, 'sessions');
    this.cwd = opts.cwd ?? process.cwd();
    this.config = { ...DEFAULT_CONFIG };
    this.projectConfig = {};
  }

  load(notes?: (text: string) => void): void {
    for (const dir of [this.configDir, this.sessionDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const cfg: SenseiConfig = { ...DEFAULT_CONFIG };
    if (fs.existsSync(this.configPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Record<string, unknown>;
        for (const k of Object.keys(saved)) (cfg as Record<string, unknown>)[k] = saved[k];
      } catch (e) {
        notes?.(`config.json is unreadable, using defaults (${(e as Error).message})`);
      }
    }
    this.config = cfg;

    this.projectConfig = {};
    const projPath = path.join(this.cwd, '.sensei.json');
    if (fs.existsSync(projPath)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(projPath, 'utf8')) as Record<string, unknown>;
        if (loaded) this.projectConfig = loaded;
      } catch (e) {
        notes?.(`.sensei.json is unreadable, ignoring (${(e as Error).message})`);
      }
    }
  }

  save(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  }

  getAllowRules(): AllowRule[] {
    const rules: AllowRule[] = [];
    const userAllow = (this.config.permissions as { allow?: unknown } | undefined)?.allow;
    if (Array.isArray(userAllow)) for (const r of userAllow) rules.push({ rule: String(r), source: 'user' });
    const proj = this.projectConfig as { permissions?: { allow?: unknown } };
    if (Array.isArray(proj.permissions?.allow)) {
      for (const r of proj.permissions.allow) rules.push({ rule: String(r), source: 'project' });
    }
    return rules;
  }

  /** permissions.deny — same rule grammar; checked first and beats everything
   *  (yolo included), even on read-only tools. */
  getDenyRules(): AllowRule[] {
    const rules: AllowRule[] = [];
    const userDeny = (this.config.permissions as { deny?: unknown } | undefined)?.deny;
    if (Array.isArray(userDeny)) for (const r of userDeny) rules.push({ rule: String(r), source: 'user' });
    const proj = this.projectConfig as { permissions?: { deny?: unknown } };
    if (Array.isArray(proj.permissions?.deny)) {
      for (const r of proj.permissions.deny) rules.push({ rule: String(r), source: 'project' });
    }
    return rules;
  }

  addProjectAllowRule(rule: string): void {
    const projPath = path.join(this.cwd, '.sensei.json');
    let proj: Record<string, unknown> = {};
    if (fs.existsSync(projPath)) {
      try {
        proj = (JSON.parse(fs.readFileSync(projPath, 'utf8')) as Record<string, unknown>) ?? {};
      } catch {
        proj = {};
      }
    }
    const perms = (proj.permissions ?? {}) as Record<string, unknown>;
    const allow = Array.isArray(perms.allow) ? perms.allow.map(String) : [];
    if (!allow.includes(rule)) allow.push(rule);
    perms.allow = allow;
    proj.permissions = perms;
    fs.writeFileSync(projPath, JSON.stringify(proj, null, 2), 'utf8');
    this.projectConfig = proj;
  }

  styleDirective(): string {
    const style = String(this.config.output_style);
    return OUTPUT_STYLES[style] ?? '';
  }
}

/** Legacy helper (boolean local) — provider-aware callers use activeModel()
 *  from providers.ts. A ResolvedProvider is also accepted for convenience. */
export function getActiveModel(config: SenseiConfig, localOrProvider: boolean | ResolvedProvider): string {
  if (typeof localOrProvider === 'object') return activeModel(config, localOrProvider);
  return localOrProvider ? String(config.local_model) : String(config.model);
}

/** Legacy OpenAI key resolution — kept for export compat; provider-aware
 *  resolution lives in resolveProvider(). */
export function getApiKey(config: SenseiConfig): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (config.api_key) return String(config.api_key);
  return null;
}

export function costLine(
  config: SenseiConfig,
  localOrProvider: boolean | ResolvedProvider,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): { line: string; costUsd: number | null } {
  const model = getActiveModel(config, localOrProvider);
  const isLocal = typeof localOrProvider === 'object' ? localOrProvider.isLocal : localOrProvider;
  const fmt = (n: number) =>
    (n / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  let line = `tokens ~${fmt(promptTokens)}k in / ${fmt(completionTokens)}k out | model ${model}`;
  if (cacheReadTokens > 0) line += ` (~${fmt(cacheReadTokens)}k cached)`;
  if (isLocal) return { line: line + ' (local · $0)', costUsd: 0 };
  let p: [number, number] | null = null;
  const override = config.prices?.[model];
  if (Array.isArray(override) && override.length >= 2) p = [Number(override[0]), Number(override[1])];
  else if (MODEL_PRICES[model]) p = MODEL_PRICES[model];
  if (p) {
    // Anthropic's input_tokens EXCLUDES cached tokens — cache read/write are
    // billed separately at their factors; adding them to promptTokens first
    // would double-count.
    const cost =
      (promptTokens * p[0] +
        cacheWriteTokens * CACHE_PRICE_FACTORS.write * p[0] +
        cacheReadTokens * CACHE_PRICE_FACTORS.read * p[0] +
        completionTokens * p[1]) /
      1e6;
    line += ' | ~$' + cost.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    return { line, costUsd: cost };
  }
  return { line, costUsd: null };
}

// --- SENSEI.md memory -------------------------------------------------------

function readMemoryFile(p: string, depth = 0): string {
  let content = fs.readFileSync(p, 'utf8');
  if (content.length > 20000) content = content.slice(0, 20000) + '\n[truncated]';
  if (depth >= 1) return content;
  const baseDir = path.dirname(p);
  const lines = content.split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*@([^\s]+\.md)\s*$/);
    if (m) {
      const imp = path.join(baseDir, m[1]);
      if (fs.existsSync(imp) && fs.statSync(imp).isFile()) {
        return `<!-- imported ${m[1]} -->\n` + readMemoryFile(imp, depth + 1);
      }
    }
    return line;
  });
  return lines.join('\n');
}

/** Global SENSEI.md first, then every SENSEI.md from the drive root down to cwd (nearest last). */
export function getMemory(
  configDir: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): { path: string; content: string }[] {
  const candidates: string[] = [path.join(configDir, 'SENSEI.md')];
  const chain: string[] = [];
  let dir = cwd;
  for (;;) {
    chain.push(path.join(dir, 'SENSEI.md'));
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  chain.reverse();
  candidates.push(...chain);
  const seen = new Set<string>();
  const out: { path: string; content: string }[] = [];
  for (const p of candidates) {
    // case-fold dedup only where the filesystem is case-insensitive
    const key = platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      out.push({ path: p, content: readMemoryFile(p) });
    }
  }
  return out;
}
