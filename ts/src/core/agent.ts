// SenseiAgent — the engine: model → tools → model loop with permissions,
// auto-continue nudging, transcript trim, and @file expansion. UI-free; all
// interaction flows through the AgentHost.

import fs from 'node:fs';
import type { ChatClient } from './chat/client.js';
import { OpenAIChatClient } from './chat/openaiClient.js';
import { ConfigStore, costLine, getActiveModel } from './config.js';
import type { AgentEvent, AgentHost } from './events.js';
import {
  getPrimaryArg,
  matchesAllowlist,
  persistRuleFor,
  resolveSenseiPath,
} from './permissions.js';
import { AUTO_CONTINUE_NOTE, getSystemPrompt, isPassiveReply } from './prompts.js';
import { newSessionId, saveSession, type SessionEnvelope } from './sessions.js';
import { trimTranscript } from './transcript.js';
import type {
  ChatMessage,
  PermissionPolicy,
  Todo,
  ToolCall,
  TurnResult,
} from './types.js';
import { registerFsTools } from '../tools/fs.js';
import { registerSearchTools } from '../tools/search.js';
import { registerShellTools } from '../tools/shell.js';
import { registerTodoTools } from '../tools/todo.js';
import { limitToolOutput, ToolRegistry, type ToolContext } from '../tools/registry.js';

export const MAX_TOOL_ROUNDS = 40;

export interface AgentOptions {
  configStore: ConfigStore;
  host: AgentHost;
  permissionPolicy: PermissionPolicy;
  local?: boolean;
  planMode?: boolean;
  chatClient?: ChatClient;
  maxRounds?: number;
  sessionId?: string;
  /** Restored transcript (no system message — it is regenerated). */
  restoredMessages?: ChatMessage[];
}

export class SenseiAgent {
  readonly store: ConfigStore;
  readonly registry: ToolRegistry;
  readonly host: AgentHost;
  readonly local: boolean;
  planMode: boolean;
  policy: PermissionPolicy;
  chatClient: ChatClient;
  messages: ChatMessage[];
  todos: Todo[] = [];
  totalPromptTokens = 0;
  totalCompletionTokens = 0;
  private readonly sessionAllowed = new Set<string>();
  private readonly maxRounds: number;
  private readonly _sessionId: string;
  private permissionDenials: { tool: string; primary?: string }[] = [];

  constructor(opts: AgentOptions) {
    this.store = opts.configStore;
    this.host = opts.host;
    this.local = opts.local ?? false;
    this.planMode = opts.planMode ?? false;
    this.policy = opts.permissionPolicy;
    this.maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
    this._sessionId = opts.sessionId ?? newSessionId();
    this.chatClient = opts.chatClient ?? new OpenAIChatClient(this.store.config, this.local);
    this.registry = new ToolRegistry();
    registerFsTools(this.registry);
    registerSearchTools(this.registry);
    registerShellTools(this.registry);
    registerTodoTools(this.registry);
    this.messages = [{ role: 'system', content: this.systemPrompt() }];
    if (opts.restoredMessages) this.messages.push(...opts.restoredMessages);
  }

  get sessionId(): string {
    return this._sessionId;
  }

  private systemPrompt(): string {
    return getSystemPrompt({
      cwd: this.store.cwd,
      configDir: this.store.configDir,
      planMode: this.planMode,
      styleDirective: this.store.styleDirective(),
    });
  }

  private emit(e: AgentEvent): void {
    this.host.onEvent(e);
  }

  private note(text: string): void {
    this.emit({ type: 'note', text });
  }

  costLine(): { line: string; costUsd: number | null } {
    return costLine(this.store.config, this.local, this.totalPromptTokens, this.totalCompletionTokens);
  }

  /** @file references: inline small files, point big ones at the log tools. */
  expandFileReferences(text: string): string {
    let appendix = '';
    for (const m of text.matchAll(/(?<=^|\s)@([\w.\\/:~-]+)/g)) {
      const p = m[1];
      let abs: string;
      try {
        abs = resolveSenseiPath(p, this.store.cwd);
      } catch {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > 262144) {
        appendix += `\n--- @file: ${abs} is too large to inline (${Math.round(stat.size / 1024)} KB) — use log_stats/log_slice/read_file on it ---`;
        continue;
      }
      appendix += `\n--- @file: ${abs} ---\n${fs.readFileSync(abs, 'utf8')}`;
    }
    return appendix ? `${text}\n${appendix}` : text;
  }

  async ask(prompt: string, opts: { signal?: AbortSignal; files?: string[] } = {}): Promise<TurnResult> {
    let text = prompt;
    for (const f of opts.files ?? []) text += `\n@${f}`;
    const expanded = this.expandFileReferences(text);
    this.messages.push({ role: 'user', content: expanded });
    this.permissionDenials = [];
    this.emit({ type: 'turn-start', depth: 0 });
    const r = await this.runLoop(this.messages, this.maxRounds, 0, opts.signal);
    const result: TurnResult = { ...r, permissionDenials: this.permissionDenials };
    if (!r.aborted) {
      const { line, costUsd } = this.costLine();
      this.note(line);
      this.emit({
        type: 'usage',
        promptTokens: this.totalPromptTokens,
        completionTokens: this.totalCompletionTokens,
        costUsd,
      });
    }
    this.emit({
      type: 'turn-end',
      finalText: r.finalText,
      finishReason: r.finishReason,
      aborted: r.aborted,
      rounds: r.rounds,
    });
    return result;
  }

  /** The core loop — port of Invoke-AgentLoop. Turn is over when the reply has
   *  no tool calls (a `stop` finish WITH tool calls still executes them — some
   *  local models emit that shape, and skipping them would orphan the transcript). */
  private async runLoop(
    messages: ChatMessage[],
    maxRounds: number,
    depth: number,
    signal?: AbortSignal,
  ): Promise<Omit<TurnResult, 'permissionDenials'>> {
    const result: Omit<TurnResult, 'permissionDenials'> = {
      finalText: null,
      finishReason: null,
      aborted: false,
      rounds: 0,
    };
    let nudged = false;
    for (let round = 1; round <= maxRounds; round++) {
      result.rounds = round;
      let resp;
      try {
        resp = await this.chatClient.chat(
          {
            messages,
            toolSpecs: this.registry.getSpecs(),
            allowStream: depth === 0,
          },
          {
            signal,
            onDelta: (t) => this.emit({ type: 'assistant-delta', text: t }),
            onNote: (t) => this.note(t),
          },
        );
      } catch (e) {
        const msg = (e as Error).message;
        this.note(`ERROR: ${msg}`);
        result.finalText = `ERROR: ${msg}`;
        result.finishReason = 'error';
        return result;
      }
      if (resp.aborted) {
        this.note('(request aborted)');
        result.aborted = true;
        return result;
      }

      const choice = resp.choices![0];
      const msg = choice.message;
      const toolCalls = msg.tool_calls ?? null;
      const assistantMsg: ChatMessage = { role: 'assistant', content: msg.content };
      if (toolCalls && toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);

      if (resp.usage) {
        this.totalPromptTokens += Number(resp.usage.prompt_tokens ?? 0);
        this.totalCompletionTokens += Number(resp.usage.completion_tokens ?? 0);
      }

      if (!toolCalls || toolCalls.length === 0) {
        // auto_continue: passive tutorial answer with tools available → nudge once and re-run
        if (
          depth === 0 &&
          !nudged &&
          Boolean(this.store.config.auto_continue) &&
          !this.planMode &&
          choice.finish_reason !== 'length' &&
          round < maxRounds &&
          isPassiveReply(msg.content)
        ) {
          nudged = true;
          this.note('(auto-continue: doing it rather than describing it)');
          messages.push({ role: 'user', content: AUTO_CONTINUE_NOTE });
          continue;
        }
        result.finalText = msg.content ?? null;
        result.finishReason = choice.finish_reason;
        this.emit({
          type: 'assistant-message',
          text: msg.content ?? null,
          finishReason: choice.finish_reason,
          depth,
          streamed: Boolean(resp.streamed && resp.printed),
        });
        if (choice.finish_reason === 'length') {
          this.note('(output was cut off by max_output_tokens — /config to raise it)');
        }
        return result;
      }

      for (const tc of toolCalls) {
        const started = Date.now();
        const { name, args, parseError } = parseToolCall(tc);
        this.emit({ type: 'tool-start', callId: tc.id, name, args, depth });
        let out: string;
        if (parseError) {
          out = parseError;
        } else {
          out = await this.executeToolCall(name, args, signal);
        }
        this.emit({
          type: 'tool-end',
          callId: tc.id,
          name,
          result: out,
          ok: !out.startsWith('ERROR:'),
          ms: Date.now() - started,
          depth,
        });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: limitToolOutput(out) });
      }

      if (depth === 0) {
        const budget = Number(this.store.config.context_char_budget);
        if (trimTranscript(messages, budget)) {
          this.note('(trimmed earlier conversation to stay within the context budget)');
        }
      }
    }
    this.note(`Reached the maximum of ${maxRounds} tool rounds without a final answer.`);
    result.finalText = '(max tool rounds reached without a final answer)';
    result.finishReason = 'max_rounds';
    return result;
  }

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const tool = this.registry.get(name);
    if (!tool) return `ERROR: unknown tool '${name}'`;

    if (!tool.readOnly) {
      const allowed = await this.checkPermission(name, tool.primaryArg, args);
      if (allowed !== true) return allowed;
    }

    const ctx: ToolContext = {
      cwd: this.store.cwd,
      emitNote: (t) => this.note(t),
      setTodos: (todos) => {
        this.todos = todos;
        this.emit({ type: 'todos', todos });
      },
    };
    try {
      if (signal?.aborted) return 'ERROR: aborted by user';
      return String(await tool.handler(args, ctx));
    } catch (e) {
      return `ERROR: ${(e as Error).message}`;
    }
  }

  /** Returns true, or the ERROR string to hand the model. */
  private async checkPermission(
    name: string,
    primaryArg: string | undefined,
    args: Record<string, unknown>,
  ): Promise<true | string> {
    if (this.planMode) {
      return `ERROR: plan mode is read-only — you cannot run ${name} yet. Finish researching, then call exit_plan_mode with your plan for the user to approve.`;
    }
    if (this.policy.mode === 'yolo') return true;
    if (this.sessionAllowed.has(name)) return true;
    const rules = this.store.getAllowRules();
    if (this.policy.mode === 'allowlist' && this.policy.extraRules) {
      for (const r of this.policy.extraRules) rules.push({ rule: r, source: 'cli' });
    }
    if (matchesAllowlist(rules, name, primaryArg, args, this.store.cwd)) return true;

    const { primary, resolved } = getPrimaryArg(primaryArg, args, this.store.cwd);
    if (this.policy.mode !== 'interactive') {
      this.permissionDenials.push({ tool: name, primary: resolved ?? primary });
      this.note(`  denied (${name})`);
      return 'ERROR: permission denied (non-interactive mode; rerun with --yolo or add an allowlist rule)';
    }

    const decision = await this.host.requestPermission({
      toolName: name,
      args,
      primaryValue: primary,
      resolvedValue: resolved,
      suggestedPersistRule: persistRuleFor(name, primaryArg, args, this.store.cwd),
    });
    if (!decision.allow) {
      this.permissionDenials.push({ tool: name, primary: resolved ?? primary });
      return `ERROR: user denied permission for ${name}`;
    }
    if (decision.scope === 'session') this.sessionAllowed.add(name);
    if (decision.scope === 'persist') {
      const rule = persistRuleFor(name, primaryArg, args, this.store.cwd);
      this.store.addProjectAllowRule(rule);
      this.note(`  allowlist rule saved to .sensei.json: ${rule}`);
    }
    return true;
  }

  saveSession(): string {
    const envelope: SessionEnvelope = {
      schema_version: 1,
      id: this._sessionId,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      cwd: this.store.cwd,
      model: getActiveModel(this.store.config, this.local),
      local: this.local,
      messages: this.messages.filter((m) => m.role !== 'system'),
    };
    return saveSession(this.store.sessionDir, envelope);
  }
}

function parseToolCall(tc: ToolCall): {
  name: string;
  args: Record<string, unknown>;
  parseError?: string;
} {
  const name = tc.function.name;
  if (!tc.function.arguments) return { name, args: {} };
  try {
    const parsed = JSON.parse(tc.function.arguments) as Record<string, unknown> | null;
    return { name, args: parsed ?? {} };
  } catch (e) {
    return { name, args: {}, parseError: `ERROR: tool arguments were not valid JSON: ${(e as Error).message}` };
  }
}
