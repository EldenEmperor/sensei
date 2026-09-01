import type { PermissionDecision, PermissionRequest, Todo, UserChoiceDecision, UserQuestionRequest } from './types.js';

export type AgentEvent =
  | { type: 'turn-start'; depth: number }
  | { type: 'assistant-delta'; text: string }
  | { type: 'assistant-message'; text: string | null; finishReason: string; depth: number; streamed: boolean }
  | { type: 'tool-start'; callId: string; name: string; args: Record<string, unknown>; depth: number }
  | { type: 'tool-end'; callId: string; name: string; result: string; ok: boolean; ms: number; depth: number }
  | { type: 'subagent-start'; description: string }
  | { type: 'subagent-end'; rounds: number }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'note'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; costUsd: number | null }
  | { type: 'turn-end'; finalText: string | null; finishReason: string | null; aborted: boolean; rounds: number };

export interface PlanApprovalDecision {
  approved: boolean;
  /** Approve AND auto-accept file edits for the rest of the session. */
  acceptEdits?: boolean;
}

/** The UI seam: both the headless CLI and the Ink TUI implement this. */
export interface AgentHost {
  onEvent(e: AgentEvent): void;
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
  requestPlanApproval(plan: string): Promise<PlanApprovalDecision>;
  /** ask_user tool: present a clarifying question with options; non-interactive
   *  hosts resolve { cancelled: true }. */
  requestUserChoice(req: UserQuestionRequest): Promise<UserChoiceDecision>;
}
