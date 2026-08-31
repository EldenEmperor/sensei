// SenseiAgent — the engine: model → tools → model loop with permissions,
// auto-continue nudging, transcript trim, and @file expansion. UI-free; all
// interaction flows through the AgentHost.

import fs from 'node:fs';
import type { ChatClient } from './chat/client.js';
import { makeChatClient } from './chat/factory.js';
import { ConfigStore, costLine, getActiveModel } from './config.js';
import { inferProviderFromModel, resolveProvider, type ProviderOverrides, type ResolvedProvider } from './providers.js';
import { getAgentDefs } from './agents.js';
import type { AgentEvent, AgentHost } from './events.js';
import {
  acceptEditsAllows,
  getPrimaryArg,
  matchesAllowlist,
  persistRuleFor,
  resolveSenseiPath,
} from './permissions.js';
import { AUTO_CONTINUE_NOTE, COMPACT_SYSTEM_PROMPT, getSystemPrompt, isPassiveReply } from './prompts.js';
import { newSessionId, saveSession, type SessionEnvelope } from './sessions.js';
import { messageCharCount, transcriptCharCount, trimTranscript } from './transcript.js';
import type {
  ChatMessage,
  PermissionPolicy,
  Todo,
  ToolCall,
  TurnResult,
} from './types.js';
import { registerLogTools } from '../logtools/index.js';
import type { McpManager } from '../mcp/client.js';
import { registerFsTools } from '../tools/fs.js';
import { registerSearchTools } from '../tools/search.js';
import { registerShellTools } from '../tools/shell.js';
import { addBackgroundTaskNotices, registerTaskTools } from '../tools/tasks.js';
import { registerTodoTools } from '../tools/todo.js';
import { registerWebTools } from '../tools/web.js';
import { mergedHooks, runHooks, type HookConfig } from './hooks.js';
import { registerSkillTool } from './skills.js';
import { limitToolOutput, ToolRegistry, type ToolContext } from '../tools/registry.js';

export const MAX_TOOL_ROUNDS = 40;

export interface AgentOptions {
  configStore: ConfigStore;
  host: AgentHost;
  permissionPolicy: PermissionPolicy;
  local?: boolean;
  /** Provider name override (--provider); wins over `local`. */
  provider?: string;
  planMode?: boolean;
  chatClient?: ChatClient;
  maxRounds?: number;
  sessionId?: string;
  /** Restored transcript (no system message — it is regenerated). */
  restoredMessages?: ChatMessage[];
  /** Connected MCP manager; its tools register as mcp__<server>__<tool>. */
  mcp?: McpManager;
  /** Extra instructions appended to the system prompt (--append-system-prompt). */
  appendSystemPrompt?: string;
  /** Extra directories acceptEdits may auto-allow edits in (--add-dir). */
  additionalDirs?: string[];
}

export class SenseiAgent {
  readonly store: ConfigStore;
  readonly registry: ToolRegistry;
  readonly host: AgentHost;
  local: boolean;
  provider: ResolvedProvider;
  planMode: boolean;
  policy: PermissionPolicy;
  chatClient: ChatClient;
  messages: ChatMessage[];
  todos: Todo[] = [];
  totalPromptTokens = 0;
  totalCompletionTokens = 0;
  totalCacheReadTokens = 0;
  totalCacheWriteTokens = 0;
  /** Original CLI overrides, kept so provider re-resolution (e.g. after
   *  /model changes the model family) applies the same precedence. */
  private readonly providerOverrides: ProviderOverrides;
  private readonly injectedChatClient: boolean;
  private readonly sessionAllowed = new Set<string>();
  private readonly maxRounds: number;
  private readonly _sessionId: string;
  private permissionDenials: { tool: string; primary?: string }[] = [];
  private currentSignal?: AbortSignal;
  private sessionStarted = false;
  private sessionEnded = false;
  private readonly appendSystemPrompt?: string;
  private readonly additionalDirs: string[];
  /** Allow rules granted only for the current turn (command allowed-tools). */
  private turnAllowRules: string[] = [];

  constructor(opts: AgentOptions) {
    this.store = opts.configStore;
    this.host = opts.host;
    this.planMode = opts.planMode ?? false;
    this.policy = opts.permissionPolicy;
    this.maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
    this._sessionId = opts.sessionId ?? newSessionId();
    this.appendSystemPrompt = opts.appendSystemPrompt;
    this.additionalDirs = opts.additionalDirs ?? [];
    this.providerOverrides = { provider: opts.provider ?? null, local: opts.local ?? false };
    this.provider = resolveProvider(this.store.config, this.providerOverrides);
    this.local = this.provider.isLocal;
    this.injectedChatClient = Boolean(opts.chatClient);
    this.chatClient = opts.chatClient ?? makeChatClient(this.store.config, this.provider);
    this.registry = new ToolRegistry();
    registerFsTools(this.registry);
    registerSearchTools(this.registry);
    registerShellTools(this.registry);
    registerTodoTools(this.registry);
    registerLogTools(this.registry);
    registerTaskTools(this.registry);
    registerWebTools(this.registry);
    opts.mcp?.registerTools(this.registry);
    registerSkillTool(this.registry, this.store.cwd, this.store.configDir);
    this.registerSubagentTools();
    this.messages = [{ role: 'system', content: this.systemPrompt() }];
    if (opts.restoredMessages) this.messages.push(...opts.restoredMessages);
  }

  private hooks(): HookConfig[] {
    return mergedHooks(this.store.config, this.store.projectConfig as { hooks?: unknown });
  }

  private hookCtx() {
    return { cwd: this.store.cwd, sessionId: this._sessionId, note: (t: string) => this.note(t) };
  }

  get sessionId(): string {
    return this._sessionId;
  }

  private systemPrompt(): string {
    return getSystemPrompt({
      cwd: this.store.cwd,
      configDir: this.store.configDir,
      mode: this.store.config.mode === 'logs' ? 'logs' : 'code',
      planMode: this.planMode,
      styleDirective: this.store.styleDirective(),
      appendSystem: this.appendSystemPrompt,
    });
  }

  private emit(e: AgentEvent): void {
    this.host.onEvent(e);
  }

  private note(text: string): void {
    this.emit({ type: 'note', text });
  }

  costLine(): { line: string; costUsd: number | null } {
    return costLine(
      this.store.config,
      this.provider,
      this.totalPromptTokens,
      this.totalCompletionTokens,
      this.totalCacheReadTokens,
      this.totalCacheWriteTokens,
    );
  }

  /** Re-resolve the provider (same CLI precedence) and rebuild the chat
   *  client — call after config.provider or the model family changes.
   *  A test-injected chat client is never replaced. */
  refreshProvider(): void {
    this.provider = resolveProvider(this.store.config, this.providerOverrides);
    this.local = this.provider.isLocal;
    if (!this.injectedChatClient) {
      this.chatClient = makeChatClient(this.store.config, this.provider);
    }
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

  async ask(
    prompt: string,
    opts: { signal?: AbortSignal; files?: string[]; extraAllowRules?: string[] } = {},
  ): Promise<TurnResult> {
    registerSkillTool(this.registry, this.store.cwd, this.store.configDir); // cheap rescan: picks up skills created mid-session
    this.registerTaskTool(); // rescan custom agent defs too
    this.turnAllowRules = opts.extraAllowRules ?? [];
    const hookContext: string[] = [];
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      const start = await runHooks('SessionStart', this.hooks(), this.hookCtx(), { trigger: 'startup' });
      hookContext.push(...start.context);
    }
    const hook = await runHooks('UserPromptSubmit', this.hooks(), this.hookCtx(), { prompt });
    if (hook.block) {
      this.note(`✗ prompt blocked by hook: ${hook.reason}`);
      const blocked: TurnResult = { finalText: null, finishReason: 'blocked', aborted: false, rounds: 0, permissionDenials: [] };
      this.emit({ type: 'turn-end', finalText: null, finishReason: 'blocked', aborted: false, rounds: 0 });
      return blocked;
    }
    hookContext.push(...hook.context);
    let text = prompt;
    for (const f of opts.files ?? []) text += `\n@${f}`;
    for (const c of hookContext) text += `\n<system-note>${c}</system-note>`;
    const expanded = this.expandFileReferences(text);
    this.messages.push({ role: 'user', content: expanded });
    addBackgroundTaskNotices(this.messages);
    this.permissionDenials = [];
    this.currentSignal = opts.signal;
    const startCount = this.messages.length;
    this.emit({ type: 'turn-start', depth: 0 });
    const r = await this.runLoop(this.messages, this.maxRounds, 0, opts.signal);
    const result: TurnResult = { ...r, permissionDenials: this.permissionDenials };
    if (!r.aborted) {
      await this.autoVerify(startCount);
      const { line, costUsd } = this.costLine();
      this.note(line);
      this.emit({
        type: 'usage',
        promptTokens: this.totalPromptTokens,
        completionTokens: this.totalCompletionTokens,
        costUsd,
      });
      await runHooks('Stop', this.hooks(), this.hookCtx(), { lastMessage: r.finalText ?? '' });
    }
    this.emit({
      type: 'turn-end',
      finalText: r.finalText,
      finishReason: r.finishReason,
      aborted: r.aborted,
      rounds: r.rounds,
    });
    this.turnAllowRules = [];
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
    loopOpts: { excludeTools?: string[]; nonInteractive?: boolean; chatClient?: ChatClient } = {},
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
        resp = await (loopOpts.chatClient ?? this.chatClient).chat(
          {
            messages,
            toolSpecs: this.registry.getSpecs(loopOpts.excludeTools ?? []),
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
        this.totalCacheReadTokens += Number(resp.usage.cache_read_input_tokens ?? 0);
        this.totalCacheWriteTokens += Number(resp.usage.cache_creation_input_tokens ?? 0);
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
          out = await this.executeToolCall(name, args, signal, loopOpts.nonInteractive ?? false);
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
        addBackgroundTaskNotices(messages);
        await this.compactContext(false);
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
    nonInteractive = false,
  ): Promise<string> {
    const tool = this.registry.get(name);
    if (!tool) return `ERROR: unknown tool '${name}'`;

    // deny rules beat everything — yolo, session allows, read-only status
    const denyRules = this.store.getDenyRules();
    if (denyRules.length > 0 && matchesAllowlist(denyRules, name, tool.primaryArg, args, this.store.cwd)) {
      const { primary, resolved } = getPrimaryArg(tool.primaryArg, args, this.store.cwd);
      this.permissionDenials.push({ tool: name, primary: resolved ?? primary });
      this.note(`  denied by permissions.deny (${name})`);
      return `ERROR: '${name}' is blocked by a permissions.deny rule — do not retry it`;
    }

    const pre = await runHooks('PreToolUse', this.hooks(), this.hookCtx(), { toolName: name, toolInput: args });
    if (pre.block) return `ERROR: blocked by PreToolUse hook: ${pre.reason}`;

    if (!tool.readOnly) {
      const allowed = await this.checkPermission(name, tool.primaryArg, args, nonInteractive);
      if (allowed !== true) return allowed;
    }

    const ctx: ToolContext = {
      cwd: this.store.cwd,
      configDir: this.store.configDir,
      config: this.store.config,
      local: this.local,
      emitNote: (t) => this.note(t),
      setTodos: (todos) => {
        this.todos = todos;
        this.emit({ type: 'todos', todos });
      },
    };
    let out: string;
    try {
      if (signal?.aborted) return 'ERROR: aborted by user';
      out = String(await tool.handler(args, ctx));
    } catch (e) {
      out = `ERROR: ${(e as Error).message}`;
    }
    await runHooks('PostToolUse', this.hooks(), this.hookCtx(), { toolName: name, toolInput: args, toolResponse: out });
    return out;
  }

  /** Returns true, or the ERROR string to hand the model. */
  private async checkPermission(
    name: string,
    primaryArg: string | undefined,
    args: Record<string, unknown>,
    nonInteractive = false,
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
    for (const r of this.turnAllowRules) rules.push({ rule: r, source: 'cli' });
    if (matchesAllowlist(rules, name, primaryArg, args, this.store.cwd)) return true;
    // acceptEdits: file edits inside cwd (or an --add-dir) skip the prompt;
    // shell/web still ask
    if (
      this.policy.acceptEdits &&
      [this.store.cwd, ...this.additionalDirs].some((d) => acceptEditsAllows(name, primaryArg, args, this.store.cwd, process.platform, d))
    ) {
      return true;
    }

    const { primary, resolved } = getPrimaryArg(primaryArg, args, this.store.cwd);
    if (this.policy.mode !== 'interactive' || nonInteractive) {
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

  /** Run a subagent: fresh transcript with the subagent system prompt, same
   *  registry, depth 1 (no streaming, no nudge). */
  /** Provider for a custom agent's model override: the session's explicit
   *  provider if one was chosen, else inferred from the override model. */
  private providerFor(model: string): ResolvedProvider {
    const explicit = this.providerOverrides.provider || this.providerOverrides.local || this.store.config.provider;
    const rp = explicit
      ? resolveProvider(this.store.config, this.providerOverrides)
      : resolveProvider(this.store.config, { provider: inferProviderFromModel(model) });
    return { ...rp, modelOverride: model };
  }

  async runSubagent(
    prompt: string,
    opts: {
      maxRounds: number;
      excludeTools: string[];
      nonInteractive?: boolean;
      /** Custom agent def: its body replaces the base system prompt. */
      systemPrompt?: string;
      /** Tool allowlist for this subagent; everything else is excluded. */
      allowedTools?: string[];
      /** Model override for this subagent (rides on the provider layer). */
      model?: string;
    },
  ): Promise<{ finalText: string | null; aborted: boolean; rounds: number }> {
    const sys = opts.systemPrompt
      ? `${opts.systemPrompt}\n\nWorking directory: ${this.store.cwd}\n\n# Subagent mode\nYou are running as a subagent for a parent Sensei agent. Work autonomously: you cannot ask the user questions. Your FINAL message must be a complete, self-contained report of everything you found — it is the only thing the parent agent receives.`
      : getSystemPrompt({
          cwd: this.store.cwd,
          configDir: this.store.configDir,
          mode: this.store.config.mode === 'logs' ? 'logs' : 'code',
          subagent: true,
          planMode: this.planMode,
          styleDirective: this.store.styleDirective(),
        });
    const exclude = [...opts.excludeTools];
    if (opts.allowedTools) {
      const allowed = new Set(opts.allowedTools.map((t) => t.toLowerCase()));
      for (const n of this.registry.names()) {
        if (!allowed.has(n.toLowerCase()) && !exclude.includes(n)) exclude.push(n);
      }
    }
    let chatClient: ChatClient | undefined;
    if (opts.model && !this.injectedChatClient) {
      chatClient = makeChatClient(this.store.config, this.providerFor(opts.model));
    }
    const child: ChatMessage[] = [
      { role: 'system', content: sys },
      { role: 'user', content: prompt },
    ];
    const r = await this.runLoop(child, opts.maxRounds, 1, this.currentSignal, {
      excludeTools: exclude,
      nonInteractive: opts.nonInteractive,
      chatClient,
    });
    await runHooks('SubagentStop', this.hooks(), this.hookCtx(), { lastMessage: r.finalText ?? '' });
    return { finalText: r.finalText, aborted: r.aborted, rounds: r.rounds };
  }

  /** Fire the SessionEnd hook once; hosts call this on exit. */
  async endSession(): Promise<void> {
    if (this.sessionEnded || !this.sessionStarted) return;
    this.sessionEnded = true;
    await runHooks('SessionEnd', this.hooks(), this.hookCtx(), {});
  }

  /** The task tool, rebuilt each turn so its description lists the current
   *  custom agent defs (.sensei/agents/*.md), selectable via subagent_type. */
  private registerTaskTool(): void {
    const defs = getAgentDefs(this.store.cwd, this.store.configDir);
    let description =
      "Delegate a self-contained investigation to a subagent with its own fresh context. It can use every tool except task, works autonomously, and returns only its final report. Use for scoped side-work whose intermediate details you don't need.";
    const properties: Record<string, unknown> = {
      description: { type: 'string', description: '3-6 word summary shown to the user' },
      prompt: { type: 'string', description: 'Complete, self-contained task instructions for the subagent' },
    };
    if (defs.length > 0) {
      description +=
        ' Custom agents (pass subagent_type to use one): ' +
        defs.map((d) => `${d.name} — ${d.description || 'custom agent'}`).join('; ') +
        '.';
      properties.subagent_type = {
        type: 'string',
        description: `Optional custom agent to run as: ${defs.map((d) => d.name).join(', ')}`,
      };
    }
    this.registry.register({
      name: 'task',
      readOnly: true,
      description,
      parameters: { type: 'object', properties, required: ['description', 'prompt'] },
      handler: async (a) => {
        const type = a.subagent_type ? String(a.subagent_type) : '';
        const def = type ? defs.find((d) => d.name.toLowerCase() === type.toLowerCase()) : undefined;
        if (type && !def) {
          return `ERROR: unknown subagent_type '${type}' — available: ${defs.map((d) => d.name).join(', ') || '(none)'}`;
        }
        this.emit({
          type: 'subagent-start',
          description: String(a.description ?? '') + (def ? ` [${def.name}]` : ''),
        });
        const r = await this.runSubagent(String(a.prompt ?? ''), {
          maxRounds: 25,
          excludeTools: ['task', 'task_parallel', 'verify', 'exit_plan_mode'],
          systemPrompt: def?.prompt,
          allowedTools: def?.tools ?? undefined,
          model: def?.model ?? undefined,
        });
        if (r.aborted) return 'ERROR: subagent aborted by user';
        if (!r.finalText) return 'ERROR: subagent returned no result';
        this.emit({ type: 'subagent-end', rounds: r.rounds });
        return r.finalText;
      },
    });
  }

  private registerSubagentTools(): void {
    this.registerTaskTool();

    this.registry.register({
      name: 'verify',
      readOnly: true,
      description:
        'Independently verify a claim or that a change is correct. Spawns a fresh subagent with read-only tools that checks the claim against the actual files/logs and reports PASS or FAIL with evidence. Use before asserting something important is fixed or true.',
      parameters: {
        type: 'object',
        properties: { claim: { type: 'string', description: 'The specific claim to verify' } },
        required: ['claim'],
      },
      handler: async (a) => {
        this.emit({ type: 'subagent-start', description: `verify: ${String(a.claim ?? '')}` });
        const r = await this.runSubagent(
          `Independently verify this claim by inspecting the actual files/logs with read-only tools. Do not assume it is true. Reply starting with PASS or FAIL, then the evidence (path:line):\n\n${a.claim}`,
          { maxRounds: 15, excludeTools: ['task', 'verify', 'task_parallel'] },
        );
        if (r.aborted) return 'ERROR: verification aborted';
        this.emit({ type: 'subagent-end', rounds: r.rounds });
        return r.finalText ?? '';
      },
    });

    this.registry.register({
      name: 'exit_plan_mode',
      readOnly: true,
      description:
        'Call this when, in plan mode, your plan is ready. Presents the plan to the user for approval; if approved, plan mode ends and you may execute it.',
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string', description: 'The plan, as a concise numbered list' } },
        required: ['plan'],
      },
      handler: async (a) => {
        if (!this.planMode) return 'Not in plan mode; nothing to exit.';
        if (this.policy.mode !== 'interactive') {
          return 'Plan recorded (non-interactive; still in plan mode — the user will review).';
        }
        const decision = await this.host.requestPlanApproval(String(a.plan ?? ''));
        if (decision.approved) {
          if (decision.acceptEdits && this.policy.mode === 'interactive') this.policy.acceptEdits = true;
          this.setPlanMode(false);
          return 'APPROVED — plan mode is now off. Proceed to execute the plan.';
        }
        return 'The user did NOT approve the plan. Stay in plan mode; ask what they want to change.';
      },
    });

    this.registry.register({
      name: 'task_parallel',
      readOnly: true,
      description:
        'Run up to 3 independent subagent investigations concurrently and return all their reports. Use for genuinely independent side-work (e.g. analyzing several logs at once). Each runs in isolation and cannot ask the user questions.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { description: { type: 'string' }, prompt: { type: 'string' } },
              required: ['description', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
      handler: async (a) => {
        let tasks = Array.isArray(a.tasks) ? (a.tasks as { description: string; prompt: string }[]) : [];
        if (tasks.length === 0) return 'ERROR: no tasks provided';
        if (tasks.length > 3) tasks = tasks.slice(0, 3);
        for (const t of tasks) this.emit({ type: 'subagent-start', description: `parallel: ${t.description}` });
        const results = await Promise.all(
          tasks.map((t) =>
            this.runSubagent(String(t.prompt), {
              maxRounds: 20,
              excludeTools: ['task', 'task_parallel', 'verify'],
              nonInteractive: true, // concurrent subagents can't share an interactive prompt
            })
              .then((r) => r.finalText ?? '(no result)')
              .catch((e: Error) => `ERROR: ${e.message}`),
          ),
        );
        this.note(`  ◇ ${tasks.length} parallel tasks finished`);
        return tasks.map((t, i) => `## Task ${i + 1}: ${t.description}\n${results[i]}`).join('\n\n');
      },
    });
  }

  /** If auto_verify is on and this turn wrote to files, run one independent
   *  verifier over the changes and surface its verdict. */
  private async autoVerify(startIndex: number): Promise<void> {
    if (!this.store.config.auto_verify || this.planMode) return;
    const writeTools = ['write_file', 'edit_file', 'multi_edit'];
    let wrote = false;
    for (let i = startIndex; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) if (writeTools.includes(tc.function.name)) wrote = true;
      }
    }
    if (!wrote) return;
    this.note('auto-verify: checking the changes…');
    const r = await this.runSubagent(
      'The agent just modified one or more files in this directory to satisfy the user. Inspect the current state of those files with read-only tools and judge whether the change is correct and complete. Reply starting with PASS or FAIL, then brief evidence.',
      { maxRounds: 12, excludeTools: ['task', 'task_parallel', 'verify', 'exit_plan_mode'] },
    );
    if (r.finalText) this.note(`auto-verify: ${r.finalText}`);
  }

  /** Summarize old exchanges into one message instead of deleting them.
   *  Only called at legal boundaries (turn start / between tool rounds). */
  async compactContext(force = false): Promise<void> {
    const messages = this.messages;
    const budget = Number(this.store.config.context_char_budget);
    if (!force && transcriptCharCount(messages) <= 0.8 * budget) return;
    if (messages.length < 4) return;
    await runHooks('PreCompact', this.hooks(), this.hookCtx(), { trigger: force ? 'manual' : 'auto' });

    let cut = -1;
    if (force) {
      cut = messages.length;
    } else {
      // walk back from the end: the cut lands on a user message and keeps the
      // tail within ~25% of budget — the in-flight turn always survives
      const tailBudget = Math.trunc(0.25 * budget);
      let chars = 0;
      for (let i = messages.length - 1; i >= 2; i--) {
        chars += messageCharCount(messages[i]);
        if (messages[i].role === 'user') {
          if (chars <= tailBudget) cut = i;
          else break;
        }
      }
      if (cut < 2) {
        if (trimTranscript(messages, budget)) {
          this.note('(trimmed earlier conversation to stay within the context budget)');
        }
        return;
      }
    }

    const lines: string[] = [];
    for (let i = 1; i < cut; i++) {
      const m = messages[i];
      if (m.role === 'user') lines.push(`USER: ${m.content}`);
      else if (m.role === 'assistant') {
        if (m.content) lines.push(`ASSISTANT: ${m.content}`);
        for (const tc of m.tool_calls ?? []) lines.push(`  → called ${tc.function.name}(${tc.function.arguments})`);
      } else if (m.role === 'tool') {
        let c = String(m.content ?? '');
        if (c.length > 500) c = c.slice(0, 500) + '…';
        lines.push(`  ← result: ${c}`);
      }
    }

    let summary: string | null = null;
    try {
      const resp = await this.chatClient.chat({
        messages: [
          { role: 'system', content: COMPACT_SYSTEM_PROMPT },
          { role: 'user', content: `Summarize this conversation so the agent can continue:\n\n${lines.join('\n')}` },
        ],
        toolSpecs: [],
        allowStream: false,
      });
      if (resp.aborted) return;
      summary = resp.choices?.[0]?.message.content ?? null;
      if (!summary) throw new Error('empty summary');
    } catch (e) {
      this.note(`(compaction failed: ${(e as Error).message} — trimming instead)`);
      if (trimTranscript(messages, budget)) {
        this.note('(trimmed earlier conversation to stay within the context budget)');
      }
      return;
    }

    messages.splice(1, cut - 1);
    messages.splice(1, 0, { role: 'user', content: `[Conversation summary — earlier messages compacted]\n${summary}` });
    this.note('(compacted earlier conversation)');
  }

  /** Replace the conversation with a restored transcript (fresh system prompt). */
  restoreConversation(restored: ChatMessage[]): void {
    this.messages = [{ role: 'system', content: this.systemPrompt() }, ...restored];
    this.todos = [];
    this.emit({ type: 'todos', todos: [] });
  }

  /** Reset the conversation (keeps config/session id). Used by /clear. */
  clearConversation(): void {
    this.messages = [{ role: 'system', content: this.systemPrompt() }];
    this.todos = [];
    this.emit({ type: 'todos', todos: [] });
  }

  /** Toggle plan mode and regenerate the system prompt to match. */
  setPlanMode(on: boolean): void {
    this.planMode = on;
    if (this.messages.length > 0 && this.messages[0].role === 'system') {
      this.messages[0] = { role: 'system', content: this.systemPrompt() };
    }
  }

  saveSession(): string {
    const envelope: SessionEnvelope = {
      schema_version: 1,
      id: this._sessionId,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      cwd: this.store.cwd,
      model: getActiveModel(this.store.config, this.provider),
      local: this.local,
      provider: this.provider.name,
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
