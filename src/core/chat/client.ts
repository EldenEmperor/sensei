import type { ChatRequest, ChatResponse } from '../types.js';

/** The LLM seam. Tests substitute a FIFO FakeChatClient; production uses OpenAIChatClient. */
export interface ChatClient {
  chat(
    req: ChatRequest,
    opts?: { signal?: AbortSignal; onDelta?: (text: string) => void; onNote?: (text: string) => void },
  ): Promise<ChatResponse>;
}
