// Wire-protocol → concrete ChatClient. The one place that knows both clients.

import type { SenseiConfig } from '../types.js';
import type { ResolvedProvider } from '../providers.js';
import type { ChatClient } from './client.js';
import { AnthropicChatClient } from './anthropicClient.js';
import { OpenAIChatClient } from './openaiClient.js';

export function makeChatClient(config: SenseiConfig, provider: ResolvedProvider): ChatClient {
  if (provider.wire === 'anthropic') return new AnthropicChatClient(config, provider);
  return new OpenAIChatClient(config, provider);
}
