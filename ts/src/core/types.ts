// Core shared types for the Sensei engine. UI-free by design.

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
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

export interface SenseiConfig {
  model: string;
  api_key: string | null;
  local_model: string;
  local_base_url: string;
  max_output_tokens: number;
  theme: boolean;
  stream: boolean;
  save_sessions: boolean;
  context_char_budget: number;
  mcp_call_timeout: number;
  mcpServers: Record<string, unknown>;
  permissions: { allow: string[] };
  hooks: unknown[];
  prices: Record<string, [number, number]>;
  output_style: string;
  auto_verify: boolean;
  auto_continue: boolean;
  embed_model: string;
  accent: string;
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

export type PermissionDecision =
  | { allow: true; scope: 'once' | 'session' | 'persist' }
  | { allow: false; reason: 'denied' | 'plan-mode' | 'non-interactive' };

export type PermissionPolicy =
  | { mode: 'yolo' }
  | { mode: 'allowlist'; extraRules?: string[] }
  | { mode: 'interactive' };

export interface TurnResult {
  finalText: string | null;
  finishReason: string | null;
  aborted: boolean;
  rounds: number;
  permissionDenials: { tool: string; primary?: string }[];
}
