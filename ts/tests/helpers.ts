// Shared test scaffolding: hermetic ConfigStore in a temp dir, a FIFO
// FakeChatClient (the ChatClient seam replaces smoke.ps1's function-
// redefinition stub), and a silent host.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatClient } from '../src/core/chat/client.js';
import { ConfigStore } from '../src/core/config.js';
import type { AgentEvent, AgentHost } from '../src/core/events.js';
import type {
  ChatRequest,
  ChatResponse,
  PermissionDecision,
  PermissionRequest,
  ToolCall,
} from '../src/core/types.js';

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeStore(tmp: string): ConfigStore {
  const store = new ConfigStore({ configDir: path.join(tmp, 'sensei-home'), cwd: tmp });
  store.load();
  return store;
}

export class FakeChatClient implements ChatClient {
  readonly queue: ChatResponse[] = [];
  readonly seenToolSpecs: string[][] = [];

  enqueue(resp: ChatResponse): void {
    this.queue.push(resp);
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    this.seenToolSpecs.push(req.toolSpecs.map((t) => t.function.name));
    const next = this.queue.shift();
    if (!next) throw new Error('FakeChatClient: queue empty');
    return Promise.resolve(next);
  }
}

export function stopResponse(text: string | null, finish = 'stop', toolCalls?: ToolCall[]): ChatResponse {
  return {
    choices: [
      {
        message: { role: 'assistant', content: text, tool_calls: toolCalls ?? null },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

export function toolCallResponse(calls: { id: string; name: string; args: Record<string, unknown> }[]): ChatResponse {
  return stopResponse(
    null,
    'tool_calls',
    calls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  );
}

export class RecordingHost implements AgentHost {
  readonly events: AgentEvent[] = [];
  permissionResponse: PermissionDecision = { allow: false, reason: 'denied' };
  readonly permissionRequests: PermissionRequest[] = [];

  onEvent(e: AgentEvent): void {
    this.events.push(e);
  }

  requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.permissionRequests.push(req);
    return Promise.resolve(this.permissionResponse);
  }

  requestPlanApproval(): Promise<boolean> {
    return Promise.resolve(false);
  }

  notes(): string[] {
    return this.events.filter((e) => e.type === 'note').map((e) => (e as { text: string }).text);
  }
}
