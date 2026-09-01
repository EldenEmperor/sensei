// Core shared types for the Sensei engine. UI-free by design.

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** User-message content parts — images are user-attached only (v1); assistant
 *  and tool messages stay flat strings. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }; // base64

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Flatten any content shape to prose (images become a placeholder). */
export function contentToText(content: ChatMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((p) => (p.type === 'text' ? p.text : `[image: ${p.media_type}]`))
    .join('\n');
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Anthropic prompt caching: tokens written to / served from the cache.
   *  Anthropic's input_tokens EXCLUDES cached tokens, so these are additive —
   *  never fold them into prompt_tokens or costs double-count. */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ChatChoice {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] | null };
  finish_reason: string;
}

/** OpenAI wire shape, normalized. `aborted` replaces PS's `@{ Aborted = $true }`. */
export interface ChatResponse {
  aborted?: boolean;
  choices?: ChatChoice[];
  usage?: ChatUsage | null;
  streamed?: boolean;
  printed?: boolean;
}

export interface ChatRequest {
  messages: ChatMessage[];
  toolSpecs: ToolSpec[];
  allowStream: boolean;
  spinnerLabel?: string;
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A named endpoint definition under config.providers. All fields except
 *  `wire` are optional; user entries deep-merge over the built-ins
 *  (openai / anthropic / local). */
export interface ProviderEntry {
  /** Which wire protocol the endpoint speaks — decides the client class. */
  wire?: 'openai' | 'anthropic';
  /** Endpoint base URL; null/absent = the SDK default for the wire. */
  base_url?: string | null;
  /** Env var checked first for the key. */
  api_key_env?: string;
  /** Literal key fallback; the string "none" means no auth (mTLS/VPN gateways). */
  api_key?: string | null;
  /** "x-api-key" | "bearer"; default per wire (anthropic → x-api-key, openai → bearer). */
  auth?: string;
  /** Extra headers sent verbatim on every request. */
  headers?: Record<string, string>;
  /** Per-provider model override. */
  model?: string | null;
  /** Anthropic wire only: send cache_control breakpoints (default true). */
  prompt_caching?: boolean;
  /** OpenAI wire only: send stream_options include_usage (default true). */
  stream_usage?: boolean;
}

export interface SenseiConfig {
  model: string;
  api_key: string | null;
  /** System-prompt doctrine: 'code' (default) or 'logs'. */
  mode: string;
  /** Active provider name; null/absent = infer from the model name. */
  provider?: string | null;
  /** Named endpoint definitions; merge over built-ins openai/anthropic/local. */
  providers?: Record<string, ProviderEntry>;
  local_model: string;
  local_base_url: string;
  max_output_tokens: number;
  theme: boolean;
  stream: boolean;
  save_sessions: boolean;
  context_char_budget: number;
  mcp_call_timeout: number;
  mcpServers: Record<string, unknown>;
  permissions: { allow: string[]; deny?: string[]; defaultMode?: string };
  hooks: unknown[];
  prices: Record<string, [number, number]>;
  output_style: string;
  auto_verify: boolean;
  auto_continue: boolean;
  embed_model: string;
  accent: string;
  /** Optional command whose first stdout line replaces the TUI status bar
   *  (runs at turn end with JSON context on stdin). */
  statusline?: string | null;
  /** Unknown keys from config.json are preserved on save. */
  [key: string]: unknown;
}

export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  primaryValue?: string;
  resolvedValue?: string;
  suggestedPersistRule: string;
}

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestionRequest {
  question: string;
  /** Short chip label, e.g. "Auth method". */
  header?: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

export type UserChoiceDecision =
  | { cancelled: true }
  | { cancelled?: false; selected: string[]; otherText?: string };

export type PermissionDecision =
  | { allow: true; scope: 'once' | 'session' | 'persist' }
  | { allow: false; reason: 'denied' | 'plan-mode' | 'non-interactive' };

export type PermissionPolicy =
  | { mode: 'yolo' }
  | { mode: 'allowlist'; extraRules?: string[]; acceptEdits?: boolean }
  | { mode: 'interactive'; acceptEdits?: boolean };

export type PermissionModeName = 'default' | 'acceptEdits' | 'plan' | 'yolo';

export interface TurnResult {
  finalText: string | null;
  finishReason: string | null;
  aborted: boolean;
  rounds: number;
  permissionDenials: { tool: string; primary?: string }[];
}
