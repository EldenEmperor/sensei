// Provider resolution: which endpoint to talk to, over which wire protocol,
// with which key. Wire protocol (openai|anthropic) is deliberately separate
// from model family — a company gateway may serve claude models over the
// OpenAI wire, or sit at a custom path speaking the Anthropic wire.
//
// Imports only from types.ts to stay cycle-free (config.ts imports this).

import type { ProviderEntry, SenseiConfig } from './types.js';

export type Wire = 'openai' | 'anthropic';
export type AuthStyle = 'x-api-key' | 'bearer';

export interface ResolvedProvider {
  name: string;
  wire: Wire;
  /** null = the SDK's default endpoint for this wire. */
  baseUrl: string | null;
  /** null = no key found (preflight fails); 'none' in config resolves to null with noAuth. */
  apiKey: string | null;
  /** True when the entry declared api_key "none" — ambient auth (mTLS/VPN). */
  noAuth: boolean;
  authStyle: AuthStyle;
  headers: Record<string, string>;
  /** Per-provider model override; active model is still read per call via activeModel(). */
  modelOverride: string | null;
  promptCaching: boolean;
  streamUsage: boolean;
  isLocal: boolean;
  /** Where the user should set the key — used in preflight/401 messages. */
  keyHint: string;
}

interface BuiltIn {
  wire: Wire;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  isLocal: boolean;
}

const BUILT_INS: Record<string, BuiltIn> = {
  openai: { wire: 'openai', baseUrl: null, apiKeyEnv: 'OPENAI_API_KEY', isLocal: false },
  anthropic: { wire: 'anthropic', baseUrl: null, apiKeyEnv: 'ANTHROPIC_API_KEY', isLocal: false },
  local: { wire: 'openai', baseUrl: '', apiKeyEnv: null, isLocal: true }, // baseUrl filled from config.local_base_url
};

export function inferProviderFromModel(model: string): 'openai' | 'anthropic' {
  return /^claude-/i.test(model) ? 'anthropic' : 'openai';
}

function providerEntries(config: SenseiConfig): Record<string, ProviderEntry> {
  const raw = config.providers;
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, ProviderEntry>;
}

export interface ProviderOverrides {
  /** --provider flag. */
  provider?: string | null;
  /** --local flag (alias for provider 'local'). */
  local?: boolean;
}

/** Selection order: --provider → --local → config.provider → inference from the
 *  active model name (claude-* → anthropic, else openai). */
export function resolveProviderName(config: SenseiConfig, overrides: ProviderOverrides = {}): string {
  if (overrides.provider) return overrides.provider;
  if (overrides.local) return 'local';
  if (config.provider) return String(config.provider);
  return inferProviderFromModel(String(config.model));
}

export function resolveProvider(config: SenseiConfig, overrides: ProviderOverrides = {}): ResolvedProvider {
  const name = resolveProviderName(config, overrides);
  const entry = providerEntries(config)[name] ?? {};
  const builtIn = BUILT_INS[name];
  if (!builtIn && !entry.wire) {
    throw new Error(
      `unknown provider '${name}' — add it under "providers" in ~/.sensei/config.json with at least a "wire" ("openai" or "anthropic")`,
    );
  }

  const wire = (entry.wire ?? builtIn?.wire ?? 'openai') as Wire;
  const isLocal = name === 'local' || Boolean(builtIn?.isLocal);

  let baseUrl: string | null = null;
  if (entry.base_url) baseUrl = String(entry.base_url).replace(/\/+$/, '');
  else if (isLocal) baseUrl = String(config.local_base_url).replace(/\/+$/, '');
  else baseUrl = builtIn?.baseUrl ?? null;

  // key resolution: entry env var → built-in env var → entry literal → legacy config.api_key
  const envVar = entry.api_key_env ?? builtIn?.apiKeyEnv ?? null;
  let apiKey: string | null = null;
  let noAuth = false;
  if (isLocal) {
    apiKey = 'ollama'; // Ollama ignores auth, but the header must be present
  } else if (envVar && process.env[envVar]) {
    apiKey = process.env[envVar]!;
  } else if (entry.api_key === 'none') {
    noAuth = true;
  } else if (entry.api_key) {
    apiKey = String(entry.api_key);
  } else if ((name === 'openai' || name === 'anthropic') && config.api_key) {
    apiKey = String(config.api_key);
  }

  const authStyle: AuthStyle =
    entry.auth === 'x-api-key' || entry.auth === 'bearer'
      ? entry.auth
      : wire === 'anthropic'
        ? 'x-api-key'
        : 'bearer';

  const keyHint = envVar
    ? `set ${envVar}`
    : `set "providers.${name}.api_key_env" (or "api_key") in ~/.sensei/config.json`;

  return {
    name,
    wire,
    baseUrl,
    apiKey,
    noAuth,
    authStyle,
    headers: entry.headers && typeof entry.headers === 'object' ? { ...entry.headers } : {},
    modelOverride: entry.model ? String(entry.model) : null,
    promptCaching: entry.prompt_caching !== false,
    streamUsage: entry.stream_usage !== false,
    isLocal,
    keyHint,
  };
}

/** The model the resolved provider should use, read per call so /model and
 *  --model changes apply without rebuilding the client. */
export function activeModel(config: SenseiConfig, rp: ResolvedProvider): string {
  if (rp.modelOverride) return rp.modelOverride;
  return rp.isLocal ? String(config.local_model) : String(config.model);
}

/** Write a model choice to the key activeModel() reads for this provider. */
export function setActiveModel(config: SenseiConfig, rp: ResolvedProvider, model: string): void {
  const entries = providerEntries(config);
  if (rp.modelOverride && entries[rp.name]) {
    entries[rp.name].model = model;
    return;
  }
  if (rp.isLocal) config.local_model = model;
  else config.model = model;
}

/** Human-readable "can this provider make a call" check; null = OK. */
export function preflightProvider(rp: ResolvedProvider): string | null {
  if (rp.apiKey || rp.noAuth) return null;
  const wireName = rp.wire === 'anthropic' ? 'Anthropic' : 'OpenAI';
  return `no API key for provider '${rp.name}' (${wireName} wire) — ${rp.keyHint}, or use --local`;
}

/** All configured provider names (built-ins + user entries), for /provider. */
export function listProviders(config: SenseiConfig): string[] {
  const names = new Set<string>(Object.keys(BUILT_INS));
  for (const k of Object.keys(providerEntries(config))) names.add(k);
  return [...names];
}
