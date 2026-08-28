// Tool registry + shared helpers, ported from src\tools.ps1.

import type { Todo, ToolSpec } from '../core/types.js';

export interface ToolContext {
  cwd: string;
  emitNote(text: string): void;
  setTodos(todos: Todo[]): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  primaryArg?: string;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  getSpecs(exclude: string[] = []): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const [name, def] of this.tools) {
      if (exclude.includes(name)) continue;
      specs.push({
        type: 'function',
        function: { name, description: def.description, parameters: def.parameters },
      });
    }
    return specs;
  }
}

export function limitToolOutput(text: string | null | undefined, max = 30000): string {
  if (text === null || text === undefined) return '';
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n[truncated: showing ${max} of ${text.length} chars — use offset/limit or range parameters to narrow the request]`
  );
}
