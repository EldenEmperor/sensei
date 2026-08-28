// todo_write — the visible task checklist, surfaced to the host via an event.

import type { Todo } from '../core/types.js';
import type { ToolRegistry } from './registry.js';

export function registerTodoTools(registry: ToolRegistry): void {
  registry.register({
    name: 'todo_write',
    readOnly: true,
    description:
      'Create or update the visible task checklist for multi-step work. Pass the FULL list every time (it replaces the previous one). Keep exactly one item in_progress while working.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    handler: (a, ctx) => {
      const todos = Array.isArray(a.todos) ? (a.todos as Todo[]) : [];
      ctx.setTodos(todos);
      return `Todos updated (${todos.length} items)`;
    },
  });
}
