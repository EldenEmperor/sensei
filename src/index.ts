// Public embedding API — import { SenseiAgent } from 'sensei' and drive the
// engine in-process, no child process needed.

export { SenseiAgent, MAX_TOOL_ROUNDS, type AgentOptions } from './core/agent.js';
export { ConfigStore, DEFAULT_CONFIG, costLine, getActiveModel, getApiKey } from './core/config.js';
export {
  activeModel,
  listProviders,
  preflightProvider,
  resolveProvider,
  setActiveModel,
  type ProviderOverrides,
  type ResolvedProvider,
} from './core/providers.js';
export type { AgentEvent, AgentHost } from './core/events.js';
export type { ChatClient } from './core/chat/client.js';
export { OpenAIChatClient } from './core/chat/openaiClient.js';
export { AnthropicChatClient } from './core/chat/anthropicClient.js';
export { makeChatClient } from './core/chat/factory.js';
export { classifyHttpError, MAX_ATTEMPTS as CHAT_MAX_ATTEMPTS } from './core/chat/retry.js';
export {
  findSession,
  loadSessionFile,
  newSessionId,
  validateTranscript,
  type SessionEnvelope,
} from './core/sessions.js';
export { isPassiveReply, getSystemPrompt, AUTO_CONTINUE_NOTE } from './core/prompts.js';
export {
  likeMatch,
  likePatternToRegex,
  persistRuleFor,
  resolveSenseiPath,
  testAllowRule,
} from './core/permissions.js';
export { trimTranscript, transcriptCharCount, TRIM_MARKER } from './core/transcript.js';
export { limitToolOutput, ToolRegistry } from './tools/registry.js';
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
  SenseiConfig,
  Todo,
  ToolCall,
  TurnResult,
} from './core/types.js';
