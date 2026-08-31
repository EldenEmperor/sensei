// Headless AgentHost: never blocks on input. Progress goes to stderr; the
// answer (text mode) or the machine-readable payload (json/stream-json) is
// the only thing on stdout.

import type { AgentEvent, AgentHost, PlanApprovalDecision } from '../core/events.js';
import type { PermissionDecision, PermissionRequest } from '../core/types.js';
import { formatToolArgs, sanitizeTerminalText, stripThinkForDisplay } from './textOutput.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export class HeadlessHost implements AgentHost {
  readonly format: OutputFormat;
  private streamedAnything = false;

  constructor(format: OutputFormat) {
    this.format = format;
  }

  onEvent(e: AgentEvent): void {
    if (this.format === 'stream-json') {
      process.stdout.write(JSON.stringify(e) + '\n');
      return;
    }
    switch (e.type) {
      case 'assistant-delta':
        if (this.format === 'text') {
          process.stdout.write(sanitizeTerminalText(e.text));
          this.streamedAnything = true;
        }
        break;
      case 'assistant-message':
        if (this.format === 'text' && e.text && !e.streamed) {
          process.stdout.write(sanitizeTerminalText(stripThinkForDisplay(e.text)) + '\n');
        } else if (this.format === 'text' && e.streamed && this.streamedAnything) {
          process.stdout.write('\n');
        }
        break;
      case 'tool-start':
        process.stderr.write(`● ${e.name} ${sanitizeTerminalText(formatToolArgs(e.args))}\n`);
        break;
      case 'note':
        process.stderr.write(sanitizeTerminalText(e.text) + '\n');
        break;
      default:
        break;
    }
  }

  requestPermission(_req: PermissionRequest): Promise<PermissionDecision> {
    // Headless never prompts; the agent's policy check answers before reaching here.
    return Promise.resolve({ allow: false, reason: 'non-interactive' });
  }

  requestPlanApproval(_plan: string): Promise<PlanApprovalDecision> {
    return Promise.resolve({ approved: false });
  }
}
