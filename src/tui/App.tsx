// The Ink TUI — a thin host over the SenseiAgent engine. All engine output
// arrives as AgentEvents; completed output scrolls into terminal history via
// <Static>, while the dynamic bottom region holds the streaming answer,
// spinner, todos, permission prompts, and the composer.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SenseiAgent } from '../core/agent.js';
import { buildCommandPrompt, findCustomCommand, listCustomCommands } from '../core/commands.js';
import { getActiveModel, getMemory, OUTPUT_STYLES } from '../core/config.js';
import { listProviders, resolveProvider, setActiveModel } from '../core/providers.js';
import type { AgentEvent, AgentHost, PlanApprovalDecision } from '../core/events.js';
import { INIT_PROMPT, INVESTIGATE_PROMPT, NEW_SKILL_PROMPT } from '../core/prompts.js';
import { loadSessionFile } from '../core/sessions.js';
import { transcriptCharCount } from '../core/transcript.js';
import { getSkills } from '../core/skills.js';
import type {
  PermissionDecision,
  PermissionRequest,
  Todo,
  UserChoiceDecision,
  UserQuestionRequest,
} from '../core/types.js';
import type { McpManager } from '../mcp/client.js';
import { finishedTaskNotes, listBackgroundTasks } from '../tools/tasks.js';
import { formatToolArgs } from '../cli/textOutput.js';
import { getShell } from '../tools/platformShell.js';
import { runShellCommand } from '../tools/shell.js';
import {
  completeFileToken,
  composerReduce,
  continuationOnEnter,
  EMPTY_COMPOSER,
  type ComposerState,
} from './composer.js';
import { renderDiffPreview } from './diff.js';
import { renderMarkdown } from './markdown.js';
import {
  applySlashCompletion,
  BUILTIN_COMMANDS,
  buildSlashItems,
  commandHelpLines,
  helpLines,
  slashMenuQuery,
  slashMenuView,
} from './slashMenu.js';
import { ACCENT_PRESETS, makeTheme, protectTerminalText, resolveAccent, type Theme } from './theme.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Host whose target is wired in after the App mounts (agent needs a host at construction). */
export class DeferredHost implements AgentHost {
  target: AgentHost | null = null;
  onEvent(e: AgentEvent): void {
    this.target?.onEvent(e);
  }
  requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    return this.target
      ? this.target.requestPermission(req)
      : Promise.resolve({ allow: false, reason: 'non-interactive' });
  }
  requestPlanApproval(plan: string): Promise<PlanApprovalDecision> {
    return this.target ? this.target.requestPlanApproval(plan) : Promise.resolve({ approved: false });
  }
  requestUserChoice(req: UserQuestionRequest): Promise<UserChoiceDecision> {
    return this.target ? this.target.requestUserChoice(req) : Promise.resolve({ cancelled: true });
  }
}

interface Item {
  id: number;
  text: string;
}

export interface BannerFrame {
  lines: string[];
  delayMs: number;
}

export interface SpriteAnim {
  delayMs: number;
  mode: 'loop' | 'once';
  frames: string[][];
}

interface AppProps {
  agent: SenseiAgent;
  host: DeferredHost;
  version: string;
  bannerFrames: BannerFrame[];
  sprites?: Record<string, SpriteAnim>;
  mcp?: McpManager;
}

const SUBAGENT_TOOLS = ['task', 'verify', 'task_parallel'];

export function App({ agent, host, version, bannerFrames, sprites, mcp }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const nextId = useRef(0);
  const [items, setItems] = useState<Item[]>([]);
  const [streamText, setStreamText] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [frame, setFrame] = useState(0);
  const [permReq, setPermReq] = useState<{ req: PermissionRequest; resolve: (d: PermissionDecision) => void } | null>(null);
  const [planReq, setPlanReq] = useState<{ plan: string; resolve: (d: PlanApprovalDecision) => void } | null>(null);
  const [askReq, setAskReq] = useState<{ req: UserQuestionRequest; resolve: (d: UserChoiceDecision) => void } | null>(null);
  const [askSel, setAskSel] = useState(0);
  const [askChecked, setAskChecked] = useState<Set<number>>(new Set());
  const [askOther, setAskOther] = useState<ComposerState | null>(null);
  const [comp, setComp] = useState<ComposerState>(EMPTY_COMPOSER);
  const [menuSel, setMenuSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [tokens, setTokens] = useState<{ inTok: number; outTok: number }>({ inTok: 0, outTok: 0 });
  const [queuedCount, setQueuedCount] = useState(0);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const queuedRef = useRef<string[]>([]);
  const verboseRef = useRef(false);
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const resumeList = useRef<string[]>([]);
  const [bannerIdx, setBannerIdx] = useState(0);
  const [bannerFrozen, setBannerFrozen] = useState(false);
  const bannerFrozenRef = useRef(false);
  const bannerIdxRef = useRef(0);
  const [flourishStart, setFlourishStart] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef('');
  const turnStartRef = useRef<number | null>(null);

  // slash menu: selection/dismissal reset whenever the composer text changes;
  // the view itself is derived per render (pure) from text + items + selection
  useEffect(() => {
    setMenuSel(0);
    setMenuDismissed(false);
  }, [comp.text]);

  const menuOpen = slashMenuQuery(comp.text) !== null;
  const allCommands = useMemo(() => {
    if (!menuOpen) return [];
    return buildSlashItems(
      BUILTIN_COMMANDS,
      listCustomCommands(agent.store.cwd, agent.store.configDir),
      getSkills(agent.store.cwd, agent.store.configDir),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);
  const menuView = menuDismissed ? null : slashMenuView(comp.text, allCommands, menuSel);

  const theme: Theme = useMemo(() => {
    const accent = resolveAccent(String(agent.store.config.accent)) ?? ACCENT_PRESETS.indigo;
    return makeTheme(accent, Boolean(agent.store.config.theme));
  }, [agent.store.config.accent, agent.store.config.theme]);

  // banner — lines that already carry ANSI (color pixel art) pass through
  // untouched; plain lines get the accent; with theming off, strip ANSI.
  const decorateBanner = (l: string): string => {
    const hasAnsi = l.includes('\x1b');
    if (!theme.enabled) return hasAnsi ? l.replace(/\x1b\[[0-9;]*m/g, '') : l;
    return hasAnsi ? l : theme.accent(l);
  };

  const titleLines = (): string[] => {
    const t = theme;
    const modelLabel =
      getActiveModel(agent.store.config, agent.provider) +
      (agent.local ? ' (local · ollama)' : ` (${agent.provider.name})`);
    return [
      t.bold(t.accent('  sensei')) +
        t.dim(
          ` v${version} · your custom problem solver + agent · model: ${modelLabel}${agent.store.config.mode === 'logs' ? ' · logs mode' : ''}`,
        ),
      t.dim('  ask anything (logs are my specialty) — /help for commands'),
      '',
    ];
  };

  // Animated banners play while the app idles at the fresh prompt. The first
  // transcript entry freezes the current frame into scrollback (<Static>).
  const push = (text: string): void => {
    const pre: Item[] = [];
    if (!bannerFrozenRef.current) {
      bannerFrozenRef.current = true;
      setBannerFrozen(true);
      const frame = bannerFrames[bannerIdxRef.current % Math.max(1, bannerFrames.length)];
      if (frame) for (const l of frame.lines) pre.push({ id: nextId.current++, text: decorateBanner(l) });
      for (const l of titleLines()) pre.push({ id: nextId.current++, text: l });
    }
    setItems((prev) => [...prev, ...pre, { id: nextId.current++, text }]);
  };

  // gif loop
  useEffect(() => {
    if (bannerFrozen || bannerFrames.length < 2) return;
    const delay = bannerFrames[0].delayMs || 100;
    const t = setInterval(() => {
      bannerIdxRef.current = (bannerIdxRef.current + 1) % bannerFrames.length;
      setBannerIdx(bannerIdxRef.current);
    }, delay);
    return () => clearInterval(t);
  }, [bannerFrozen, bannerFrames]);

  // spinner / sprite tick
  useEffect(() => {
    if (!busy && flourishStart === null) return;
    const t = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(t);
  }, [busy, flourishStart]);

  // the sheath flourish plays once, then clears
  useEffect(() => {
    if (flourishStart === null) return;
    const sheath = sprites?.sheath;
    const total = sheath ? sheath.frames.length * sheath.delayMs + 60 : 0;
    const t = setTimeout(() => setFlourishStart(null), total);
    return () => clearTimeout(t);
  }, [flourishStart, sprites]);

  // wire the host
  useEffect(() => {
    host.target = {
      onEvent: (e: AgentEvent) => {
        switch (e.type) {
          case 'assistant-delta':
            streamRef.current += e.text;
            setStreamText(streamRef.current);
            break;
          case 'assistant-message': {
            streamRef.current = '';
            setStreamText('');
            const rendered = renderMarkdown(e.text ?? '', theme);
            if (rendered) push('\n' + rendered);
            break;
          }
          case 'tool-start':
            setActiveTool(e.name);
            push(
              (e.depth > 0 ? '  ' : '') +
                theme.accent(`● ${e.name}`) +
                ' ' +
                theme.dim(protectTerminalText(formatToolArgs(e.args))),
            );
            break;
          case 'tool-end':
            setActiveTool(null);
            if (verboseRef.current && e.result) {
              const lines = e.result.split('\n');
              const shown = lines.slice(0, 30);
              for (const l of shown) push(theme.dim('  │ ' + protectTerminalText(l)));
              if (lines.length > shown.length) push(theme.dim(`  │ … ${lines.length - shown.length} more lines`));
            }
            break;
          case 'note':
            push(theme.dim(protectTerminalText(e.text)));
            break;
          case 'todos':
            setTodos(e.todos);
            break;
          case 'usage':
            setTokens({ inTok: e.promptTokens, outTok: e.completionTokens });
            break;
          case 'turn-end':
            if (!e.aborted && e.finishReason !== 'blocked' && sprites?.sheath && theme.enabled) {
              setFlourishStart(Date.now());
            }
            break;
          default:
            break;
        }
      },
      requestPermission: (req) => new Promise<PermissionDecision>((resolve) => setPermReq({ req, resolve })),
      requestPlanApproval: (plan) => new Promise<PlanApprovalDecision>((resolve) => setPlanReq({ plan, resolve })),
      requestUserChoice: (req) =>
        new Promise<UserChoiceDecision>((resolve) => {
          setAskSel(0);
          setAskChecked(new Set());
          setAskOther(null);
          setAskReq({ req, resolve });
        }),
    };
    return () => {
      host.target = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // custom statusline: config "statusline" names a command; it runs when a
  // turn ends (and at start) with JSON context on stdin, and its first stdout
  // line replaces the default status bar.
  useEffect(() => {
    const cmd = agent.store.config.statusline;
    if (!cmd || typeof cmd !== 'string' || busy) return;
    const shell = getShell().hookSpawn(cmd);
    let done = false;
    try {
      const p = spawn(shell.exe, shell.args, { cwd: agent.store.cwd, windowsHide: true });
      let out = '';
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d: string) => (out += d));
      const timer = setTimeout(() => {
        done = true;
        try {
          p.kill();
        } catch {
          /* gone */
        }
      }, 5000);
      p.on('close', () => {
        clearTimeout(timer);
        if (done) return;
        const line = out.split('\n')[0]?.trim();
        if (line) setStatusOverride(line);
      });
      p.on('error', () => clearTimeout(timer));
      p.stdin.write(
        JSON.stringify({
          model: getActiveModel(agent.store.config, agent.provider),
          provider: agent.provider.name,
          cwd: agent.store.cwd,
          session_id: agent.sessionId,
          tokens: { in: agent.totalPromptTokens, out: agent.totalCompletionTokens },
          plan_mode: agent.planMode,
        }),
        'utf8',
      );
      p.stdin.end();
    } catch {
      /* statusline is best-effort */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const doExit = (): void => {
    try {
      if (Boolean(agent.store.config.save_sessions) && agent.messages.length > 1) {
        const file = agent.saveSession();
        push(theme.dim(`session saved → ${file}`));
      }
    } catch {
      /* best effort */
    }
    exit();
  };

  // a queued message (typed while busy) submits as soon as the turn ends
  const drainQueue = (): void => {
    const next = queuedRef.current.shift();
    setQueuedCount(queuedRef.current.length);
    if (next !== undefined) submitText(next);
  };

  const run = (prompt: string, extraAllowRules?: string[]): void => {
    turnStartRef.current = Date.now();
    setBusy(true);
    abortRef.current = new AbortController();
    void agent
      .ask(prompt, { signal: abortRef.current.signal, extraAllowRules })
      .catch((e: Error) => push(theme.err(`✗ ${protectTerminalText(e.message)}`)))
      .finally(() => {
        turnStartRef.current = null;
        setBusy(false);
        setActiveTool(null);
        streamRef.current = '';
        setStreamText('');
        for (const n of finishedTaskNotes()) push(theme.dim(n));
        drainQueue();
      });
  };

  // ! prefix: run the command in the platform shell directly, no model turn
  const runBang = (cmd: string): void => {
    setBusy(true);
    void runShellCommand(cmd, agent.store.cwd, 120)
      .then((out) => {
        for (const l of out.split('\n').slice(0, 200)) push(theme.dim(protectTerminalText(l)));
      })
      .catch((e: Error) => push(theme.err(`✗ ${protectTerminalText(e.message)}`)))
      .finally(() => {
        setBusy(false);
        drainQueue();
      });
  };

  const handleSlash = (line: string): void => {
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    const t = theme;

    // per-command help: /<name> --help (or -h)
    if (arg === '--help' || arg === '-h') {
      const name = cmd.replace(/^\//, '');
      const builtin = BUILTIN_COMMANDS.find((c) => c.name === name);
      if (builtin) {
        for (const l of commandHelpLines(builtin)) push(t.dim(l));
        return;
      }
      const custom = findCustomCommand(name, agent.store.cwd, agent.store.configDir);
      if (custom) {
        const item = { name: custom.name, hint: custom.argumentHint, desc: custom.description || 'custom command', source: 'custom' as const };
        const extra = [
          `custom command from ${custom.path}`,
          ...(custom.allowedTools.length > 0 ? [`allowed-tools for its turn: ${custom.allowedTools.join(', ')}`] : []),
          'arguments substitute $ARGUMENTS and $1..$n in the command body',
        ];
        for (const l of commandHelpLines(item, extra)) push(t.dim(l));
        return;
      }
      const skill = getSkills(agent.store.cwd, agent.store.configDir).find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (skill) {
        const item = { name: skill.name, hint: '[args]', desc: skill.description || 'skill', source: 'skill' as const };
        for (const l of commandHelpLines(item, [`skill from ${skill.path}`])) push(t.dim(l));
        return;
      }
      push(t.dim(`unknown command ${cmd} — try /help`));
      return;
    }

    switch (cmd) {
      case '/help': {
        for (const l of helpLines()) push(l);
        const customs = listCustomCommands(agent.store.cwd, agent.store.configDir);
        for (const c of customs) {
          push(t.dim(`  /${c.name} ${c.argumentHint}`.trimEnd() + (c.description ? `  — ${c.description}` : '')));
        }
        break;
      }
      case '/clear':
        agent.clearConversation();
        push(t.dim('conversation cleared'));
        break;
      case '/plan': {
        if (arg) {
          // /plan <task>: enter plan mode (if off) and plan that task now
          if (!agent.planMode) {
            agent.setPlanMode(true);
            push(t.dim('plan mode ON — read-only until you approve a plan'));
          }
          run(arg);
          break;
        }
        agent.setPlanMode(!agent.planMode);
        push(t.dim(agent.planMode ? 'plan mode ON — read-only until you approve a plan' : 'plan mode OFF'));
        break;
      }
      case '/mode': {
        if (!arg) {
          push(t.dim(`mode: ${agent.store.config.mode} (available: code|logs)`));
          break;
        }
        if (arg !== 'code' && arg !== 'logs') {
          push(t.err(`unknown mode '${arg}' (code|logs)`));
          break;
        }
        agent.store.config.mode = arg;
        agent.store.save();
        agent.setPlanMode(agent.planMode); // re-seed the system prompt for the new mode
        push(t.dim(`mode set to ${arg} — ${arg === 'code' ? 'coding doctrine leads the prompt' : 'log-first doctrine leads the prompt'}`));
        break;
      }
      case '/style': {
        if (!arg) {
          push(t.dim(`style: ${agent.store.config.output_style} (available: ${Object.keys(OUTPUT_STYLES).join('|')})`));
          break;
        }
        if (!(arg in OUTPUT_STYLES)) {
          push(t.err(`unknown style '${arg}' (${Object.keys(OUTPUT_STYLES).join('|')})`));
          break;
        }
        agent.store.config.output_style = arg;
        agent.store.save();
        agent.setPlanMode(agent.planMode); // re-seed the system prompt with the new directive
        push(t.dim(`style set to ${arg}`));
        break;
      }
      case '/color': {
        if (!arg) {
          push(t.dim(`accent: ${agent.store.config.accent} (presets: ${Object.keys(ACCENT_PRESETS).join('|')} or #RRGGBB)`));
          break;
        }
        if (resolveAccent(arg) === null) {
          push(t.err(`unknown color '${arg}'`));
          break;
        }
        agent.store.config.accent = arg.toLowerCase();
        agent.store.save();
        push(t.dim(`accent set to ${arg} (takes full effect on restart)`));
        break;
      }
      case '/model': {
        if (!arg) {
          push(t.dim(`model: ${getActiveModel(agent.store.config, agent.provider)} (provider: ${agent.provider.name})`));
          break;
        }
        setActiveModel(agent.store.config, agent.provider, arg);
        agent.store.save();
        agent.refreshProvider(); // model family may change the inferred provider
        push(t.dim(`model set to ${arg} (provider: ${agent.provider.name})`));
        break;
      }
      case '/provider': {
        if (!arg) {
          for (const name of listProviders(agent.store.config)) {
            let line: string;
            try {
              const rp = resolveProvider(agent.store.config, { provider: name });
              const key = rp.apiKey || rp.noAuth ? '✓ key' : '✗ no key';
              const url = rp.baseUrl ?? '(default endpoint)';
              line = `  ${name === agent.provider.name ? '*' : ' '} ${name} — ${rp.wire} wire · ${url} · ${key}`;
            } catch (e) {
              line = `    ${name} — ${(e as Error).message}`;
            }
            push(t.dim(line));
          }
          push(t.dim('  /provider <name> switches (persists to config)'));
          break;
        }
        try {
          const rp = resolveProvider(agent.store.config, { provider: arg });
          agent.store.config.provider = arg;
          agent.store.save();
          agent.refreshProvider();
          push(t.dim(`provider set to ${arg} (${rp.wire} wire) · model: ${getActiveModel(agent.store.config, agent.provider)}`));
        } catch (e) {
          push(t.err((e as Error).message));
        }
        break;
      }
      case '/config': {
        const cfg = { ...agent.store.config } as Record<string, unknown>;
        if (cfg.api_key) cfg.api_key = '(set)';
        if (cfg.providers && typeof cfg.providers === 'object') {
          const masked: Record<string, unknown> = {};
          for (const [name, entry] of Object.entries(cfg.providers as Record<string, Record<string, unknown>>)) {
            masked[name] = entry && entry.api_key && entry.api_key !== 'none' ? { ...entry, api_key: '(set)' } : entry;
          }
          cfg.providers = masked;
        }
        for (const l of JSON.stringify(cfg, null, 2).split('\n')) push(t.dim(l));
        break;
      }
      case '/permissions': {
        const rules = agent.store.getAllowRules();
        const deny = agent.store.getDenyRules();
        if (rules.length === 0 && deny.length === 0) push(t.dim('no allow/deny rules'));
        for (const r of rules) push(t.dim(`  allow ${r.rule}  (${r.source})`));
        for (const r of deny) push(t.dim(`  deny  ${r.rule}  (${r.source})`));
        break;
      }
      case '/todos': {
        if (todos.length === 0) push(t.dim('  (no todos)'));
        for (const td of todos) push(renderTodoLine(td, t));
        break;
      }
      case '/cost': {
        const { line: cl } = agent.costLine();
        push(t.dim(cl));
        break;
      }
      case '/mcp': {
        const lines = mcp
          ? mcp.statusLines()
          : [
              'no MCP servers configured — add "mcpServers" to ~/.sensei/config.json or .sensei.json:',
              '  "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\logs"] } }',
            ];
        for (const l of lines) push(t.dim(protectTerminalText(l)));
        break;
      }
      case '/skills': {
        const skills = getSkills(agent.store.cwd, agent.store.configDir);
        if (skills.length === 0) {
          push(t.dim('no skills found — create .sensei\\skills\\<name>\\SKILL.md or use /newskill'));
          break;
        }
        for (const s of skills) push(t.dim(`  ${s.name} (${s.source}) — ${s.description}`));
        break;
      }
      case '/newskill': {
        const parts = arg.split(/\s+/);
        const skillName = parts[0] ?? '';
        if (!skillName) {
          push(t.dim('usage: /newskill <name> [purpose]'));
          break;
        }
        const purpose = parts.slice(1).join(' ') || '(decide from the name)';
        run(NEW_SKILL_PROMPT.replace(/<NAME>/g, skillName).replace(/<DESC>/g, purpose));
        break;
      }
      case '/tasks': {
        const list = listBackgroundTasks();
        if (list.length === 0) {
          push(t.dim('no background tasks'));
          break;
        }
        for (const bt of list) push(t.dim(`  ${bt.id}: ${bt.status} — ${protectTerminalText(bt.command)}`));
        break;
      }
      case '/compact': {
        setBusy(true);
        void agent
          .compactContext(true)
          .catch((e: Error) => push(t.err(`✗ ${protectTerminalText(e.message)}`)))
          .finally(() => setBusy(false));
        break;
      }
      case '/init':
        run(INIT_PROMPT);
        break;
      case '/investigate': {
        let target = arg;
        if (!target) {
          const logs = fs
            .readdirSync(agent.store.cwd)
            .filter((n) => n.endsWith('.log'))
            .map((n) => path.join(agent.store.cwd, n))
            .filter((p) => fs.statSync(p).isFile())
            .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
          if (logs.length === 0) {
            push(t.dim('usage: /investigate <path-to-log> (no *.log files found in the current directory)'));
            break;
          }
          target = logs[0];
          push(t.dim(`no path given — using newest .log in cwd: ${path.basename(target)}`));
        }
        run(INVESTIGATE_PROMPT.replace('<PATH>', target));
        break;
      }
      case '/memory': {
        const mem = getMemory(agent.store.configDir, agent.store.cwd);
        if (mem.length === 0) {
          push(t.dim('no SENSEI.md loaded — /init creates one for this directory'));
          break;
        }
        for (const m of mem) push(t.dim(`  ${m.path}  (${m.content.length} chars)`));
        break;
      }
      case '/resume': {
        const files = fs.existsSync(agent.store.sessionDir)
          ? fs
              .readdirSync(agent.store.sessionDir)
              .filter((n) => n.endsWith('.json'))
              .map((n) => path.join(agent.store.sessionDir, n))
              .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)
              .slice(0, 10)
          : [];
        if (files.length === 0 && !arg) {
          push(t.dim('no saved sessions'));
          break;
        }
        if (!arg) {
          resumeList.current = files;
          push('Recent sessions:');
          files.forEach((f, i) => {
            try {
              const loaded = loadSessionFile(f);
              const firstUser = loaded.messages.find(
                (m) => m.role === 'user' && !String(m.content ?? '').startsWith('['),
              );
              let preview = String(firstUser?.content ?? '').split(/\r?\n/)[0];
              if (preview.length > 80) preview = preview.slice(0, 77) + '…';
              push(t.dim(`  [${i + 1}] ${path.basename(f)}  ${loaded.messages.length} msgs  ${protectTerminalText(preview)}`));
            } catch {
              push(t.dim(`  [${i + 1}] ${path.basename(f)}  (unreadable)`));
            }
          });
          push(t.dim('resume with: /resume <number|id>'));
          break;
        }
        let file: string | null = null;
        if (/^\d+$/.test(arg) && Number(arg) >= 1 && Number(arg) <= resumeList.current.length) {
          file = resumeList.current[Number(arg) - 1];
        } else {
          const byId = path.join(agent.store.sessionDir, `${arg}.json`);
          if (fs.existsSync(byId)) file = byId;
          else if (fs.existsSync(arg)) file = arg;
        }
        if (!file) {
          push(t.err(`no session matching '${arg}'`));
          break;
        }
        try {
          const loaded = loadSessionFile(file);
          agent.restoreConversation(loaded.messages);
          push(t.dim(`resumed ${loaded.messages.length} messages from ${path.basename(file)}`));
        } catch (e) {
          push(t.err(`couldn't resume: ${(e as Error).message}`));
        }
        break;
      }
      case '/exit':
      case '/quit':
        doExit();
        break;
      default: {
        const name = cmd.replace(/^\//, '');
        const custom = findCustomCommand(name, agent.store.cwd, agent.store.configDir);
        if (custom) {
          push(t.dim(`(custom command: ${custom.path})`));
          run(buildCommandPrompt(custom, arg), custom.allowedTools.length > 0 ? custom.allowedTools : undefined);
          break;
        }
        const skill = getSkills(agent.store.cwd, agent.store.configDir).find(
          (s) => s.name.toLowerCase() === name.toLowerCase(),
        );
        if (skill) {
          push(t.dim(`(skill: ${skill.path})`));
          void import('../core/skills.js').then(({ getSkillPrompt }) => run(getSkillPrompt(skill, arg)));
          break;
        }
        push(t.dim(`unknown command ${cmd} — try /help`));
        break;
      }
    }
  };

  const submitText = (line: string): void => {
    push(theme.accent('❯ ') + protectTerminalText(line));
    if (line.startsWith('!')) runBang(line.slice(1).trim());
    else if (line.startsWith('/')) handleSlash(line);
    else run(line);
  };

  const submitLine = (line: string): void => {
    history.current.push(line);
    if (busy) {
      queuedRef.current.push(line);
      setQueuedCount(queuedRef.current.length);
      push(theme.dim(`(queued: ${protectTerminalText(line.split('\n')[0]).slice(0, 60)})`));
      return;
    }
    submitText(line);
  };

  const submit = (): void => {
    const line = comp.text.trim();
    setComp(EMPTY_COMPOSER);
    historyIdx.current = -1;
    if (!line) return;
    submitLine(line);
  };

  useInput((ch, key) => {
    // permission prompt captures everything
    if (permReq) {
      const done = (d: PermissionDecision): void => {
        const r = permReq;
        setPermReq(null);
        r.resolve(d);
      };
      const c = ch.toLowerCase();
      if (c === 'y') done({ allow: true, scope: 'once' });
      else if (c === 'a') done({ allow: true, scope: 'session' });
      else if (c === 'p') done({ allow: true, scope: 'persist' });
      else if (c === 'n' || key.escape || key.return) done({ allow: false, reason: 'denied' });
      return;
    }
    if (askReq) {
      const opts = askReq.req.options;
      const otherIdx = opts.length; // "Other…" is always the last row
      const done = (d: UserChoiceDecision): void => {
        const r = askReq;
        setAskReq(null);
        setAskOther(null);
        r.resolve(d);
      };
      // free-text entry mode
      if (askOther) {
        if (key.escape) {
          setAskOther(null);
          return;
        }
        if (key.return) {
          const text = askOther.text.trim();
          if (text) done({ selected: [], otherText: text });
          else setAskOther(null);
          return;
        }
        if (key.leftArrow) setAskOther((s) => s && composerReduce(s, { type: 'left' }));
        else if (key.rightArrow) setAskOther((s) => s && composerReduce(s, { type: 'right' }));
        else if (key.backspace || key.delete) setAskOther((s) => s && composerReduce(s, { type: 'backspace' }));
        else if (ch && !key.ctrl && !key.meta) setAskOther((s) => s && composerReduce(s, { type: 'insert', text: ch }));
        return;
      }
      if (key.escape) {
        done({ cancelled: true });
        return;
      }
      if (key.upArrow) {
        setAskSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setAskSel((s) => Math.min(otherIdx, s + 1));
        return;
      }
      const digit = /^[1-9]$/.test(ch) ? Number(ch) - 1 : null;
      if (digit !== null && digit <= otherIdx) {
        if (digit === otherIdx) {
          setAskOther(EMPTY_COMPOSER);
          return;
        }
        if (askReq.req.multiSelect) {
          setAskSel(digit);
          setAskChecked((prev) => {
            const next = new Set(prev);
            if (next.has(digit)) next.delete(digit);
            else next.add(digit);
            return next;
          });
          return;
        }
        done({ selected: [opts[digit].label] });
        return;
      }
      if (askReq.req.multiSelect && ch === ' ' && askSel < otherIdx) {
        setAskChecked((prev) => {
          const next = new Set(prev);
          if (next.has(askSel)) next.delete(askSel);
          else next.add(askSel);
          return next;
        });
        return;
      }
      if (key.return) {
        if (askSel === otherIdx) {
          setAskOther(EMPTY_COMPOSER);
          return;
        }
        if (askReq.req.multiSelect) {
          const picked = [...askChecked].sort((a, b) => a - b).map((i) => opts[i].label);
          done({ selected: picked.length > 0 ? picked : [opts[askSel].label] });
          return;
        }
        done({ selected: [opts[askSel].label] });
        return;
      }
      return; // askReq captures everything else
    }
    if (planReq) {
      const done = (d: PlanApprovalDecision): void => {
        const r = planReq;
        setPlanReq(null);
        r.resolve(d);
      };
      const c = ch.toLowerCase();
      if (c === 'y') done({ approved: true });
      else if (c === 'a') {
        push(theme.dim('(auto-accepting file edits for this session)'));
        done({ approved: true, acceptEdits: true });
      } else if (c === 'n' || key.escape || key.return) done({ approved: false });
      return;
    }
    // slash menu captures Esc/Up/Down/Tab/Enter while visible
    if (menuView) {
      if (key.escape) {
        setMenuDismissed(true);
        return;
      }
      if (key.upArrow) {
        setMenuSel(Math.max(0, menuView.selected - 1));
        return;
      }
      if (key.downArrow) {
        setMenuSel(Math.min(menuView.items.length - 1, menuView.selected + 1));
        return;
      }
      if (key.tab) {
        setComp(applySlashCompletion(comp, menuView.items[menuView.selected]));
        return;
      }
      if (key.return) {
        const line = '/' + menuView.items[menuView.selected].name;
        setComp(EMPTY_COMPOSER);
        historyIdx.current = -1;
        submitLine(line);
        return;
      }
      // other keys fall through: typing refilters, backspace narrows
    }
    if (busy && (key.escape || (key.ctrl && ch === 'c'))) {
      abortRef.current?.abort();
      return;
    }
    if (!busy && key.ctrl && (ch === 'c' || ch === 'd')) {
      doExit();
      return;
    }
    // editing works while busy too — Enter then queues the message
    if (key.return) {
      const cont = continuationOnEnter(comp);
      if (cont) setComp(cont); // trailing backslash → newline
      else submit();
      return;
    }
    if (key.ctrl && ch === 'o') {
      verboseRef.current = !verboseRef.current;
      push(theme.dim(`(verbose tool output ${verboseRef.current ? 'on' : 'off'})`));
      return;
    }
    if (key.upArrow) {
      if (comp.text.includes('\n')) return; // multiline: arrows stay editing
      if (history.current.length === 0) return;
      if (historyIdx.current < 0) historyIdx.current = history.current.length;
      historyIdx.current = Math.max(0, historyIdx.current - 1);
      setComp({ text: history.current[historyIdx.current] ?? '', cursor: (history.current[historyIdx.current] ?? '').length });
      return;
    }
    if (key.downArrow) {
      if (historyIdx.current < 0) return;
      historyIdx.current++;
      if (historyIdx.current >= history.current.length) {
        historyIdx.current = -1;
        setComp(EMPTY_COMPOSER);
      } else {
        const t = history.current[historyIdx.current] ?? '';
        setComp({ text: t, cursor: t.length });
      }
      return;
    }
    if (key.leftArrow) {
      setComp((s) => composerReduce(s, { type: key.meta || key.ctrl ? 'wordLeft' : 'left' }));
      return;
    }
    if (key.rightArrow) {
      setComp((s) => composerReduce(s, { type: key.meta || key.ctrl ? 'wordRight' : 'right' }));
      return;
    }
    if (key.ctrl && ch === 'a') {
      setComp((s) => composerReduce(s, { type: 'home' }));
      return;
    }
    if (key.ctrl && ch === 'e') {
      setComp((s) => composerReduce(s, { type: 'end' }));
      return;
    }
    if (key.ctrl && ch === 'w') {
      setComp((s) => composerReduce(s, { type: 'deleteWordBack' }));
      return;
    }
    if (key.ctrl && ch === 'u') {
      setComp((s) => composerReduce(s, { type: 'killToStart' }));
      return;
    }
    if (key.tab) {
      // @file completion against the working directory (slash completion is
      // handled by the menu above)
      const r = completeFileToken(comp, (dir) =>
        fs
          .readdirSync(path.resolve(agent.store.cwd, dir), { withFileTypes: true })
          .map((e) => e.name + (e.isDirectory() ? '/' : '')),
      );
      if (r) {
        setComp(r.state);
        if (r.candidates) push(theme.dim('  ' + r.candidates.join('  ')));
      }
      return;
    }
    if (key.backspace || key.delete) {
      // most terminals send Backspace as \x7f, which ink reports as `delete`
      setComp((s) => composerReduce(s, { type: 'backspace' }));
      return;
    }
    if (ch && !key.ctrl && !key.meta) setComp((s) => composerReduce(s, { type: 'insert', text: ch }));
  });

  // dynamic region -----------------------------------------------------------
  const t = theme;
  let displayStream = streamText;
  const thinkIdx = displayStream.indexOf('<think>');
  if (thinkIdx >= 0 && !displayStream.includes('</think>')) displayStream = displayStream.slice(0, thinkIdx);
  // live working status: elapsed time, context fill (the transcript grows as
  // tool results land, so this ticks up mid-turn), and session tokens — all
  // read fresh on every 100ms spinner frame
  const spinnerLabel = (() => {
    const base = activeTool ? `${activeTool}…` : 'thinking…';
    if (turnStartRef.current === null) return base;
    const secs = Math.floor((Date.now() - turnStartRef.current) / 1000);
    const chars = transcriptCharCount(agent.messages);
    const budget = Number(agent.store.config.context_char_budget) || 300000;
    const pct = Math.min(999, Math.round((chars / budget) * 100));
    const k = (n: number) => (n / 1000).toFixed(1);
    let label = `${base} ${secs}s · ctx ${Math.round(chars / 1000)}k/${Math.round(budget / 1000)}k (${pct}%)`;
    if (agent.totalPromptTokens > 0) label += ` · ~${k(agent.totalPromptTokens)}k in / ${k(agent.totalCompletionTokens)}k out`;
    return label;
  })();
  const modelLabel =
    getActiveModel(agent.store.config, agent.provider) + (agent.local ? ' · local' : ` · ${agent.provider.name}`);

  // pick the samurai's move for the moment: slash while a tool runs, summon
  // while subagents work, idle glint while the model thinks, sheath on finish
  const spriteFrame = ((): string[] | null => {
    if (!sprites || !theme.enabled) return null;
    if (busy && !permReq && !askReq) {
      const name = activeTool ? (SUBAGENT_TOOLS.includes(activeTool) ? 'summon' : 'slash') : 'thinking';
      const anim = sprites[name] ?? sprites.thinking;
      if (!anim || anim.frames.length === 0) return null;
      return anim.frames[Math.floor((frame * 100) / anim.delayMs) % anim.frames.length];
    }
    if (flourishStart !== null) {
      const anim = sprites.sheath;
      if (!anim || anim.frames.length === 0) return null;
      return anim.frames[Math.min(anim.frames.length - 1, Math.floor((Date.now() - flourishStart) / anim.delayMs))];
    }
    return null;
  })();

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <Text key={item.id}>{item.text}</Text>}</Static>
      {!bannerFrozen && bannerFrames.length > 0 ? (
        <Box flexDirection="column">
          {bannerFrames[bannerIdx % bannerFrames.length].lines.map((l, i) => (
            <Text key={i}>{decorateBanner(l)}</Text>
          ))}
          {titleLines().map((l, i) => (
            <Text key={`t${i}`}>{l}</Text>
          ))}
        </Box>
      ) : null}
      {displayStream ? <Text>{renderMarkdown(displayStream, t)}</Text> : null}
      {spriteFrame ? (
        <Box flexDirection="row">
          <Box flexDirection="column">
            {spriteFrame.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </Box>
          {busy ? (
            <Box flexDirection="column" justifyContent="flex-end" marginLeft={2}>
              <Text>{t.accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]) + ' ' + t.dim(spinnerLabel)}</Text>
            </Box>
          ) : null}
        </Box>
      ) : busy && !permReq && !askReq ? (
        <Text>{t.accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]) + ' ' + t.dim(spinnerLabel)}</Text>
      ) : null}
      {todos.length > 0 ? (
        <Box flexDirection="column">
          {todos.map((td, i) => (
            <Text key={i}>{renderTodoLine(td, t)}</Text>
          ))}
        </Box>
      ) : null}
      {permReq ? (
        <Box flexDirection="column">
          <Text>{t.accent(`◆ ${permReq.req.toolName}`) + ' wants to run:'}</Text>
          <Text>{'  ' + t.bold(protectTerminalText(permReq.req.primaryValue ?? permReq.req.toolName))}</Text>
          {['edit_file', 'write_file'].includes(permReq.req.toolName)
            ? renderDiffPreview(permReq.req.toolName, permReq.req.args, agent.store.cwd, t).map((l, i) => (
                <Text key={i}>{l}</Text>
              ))
            : null}
          <Text>{t.dim('  Allow? [y]es / [n]o / [a]lways this session / [p]ersist to allowlist')}</Text>
        </Box>
      ) : askReq ? (
        <Box flexDirection="column">
          <Text>
            {t.accent(`◆ ${askReq.req.header ? protectTerminalText(askReq.req.header) + ' — ' : ''}`) +
              t.bold(protectTerminalText(askReq.req.question))}
          </Text>
          {askOther ? (
            <Text>
              {'  ' + t.dim('your answer: ')}
              {protectTerminalText(askOther.text.slice(0, askOther.cursor))}
              <Text inverse>{protectTerminalText(askOther.cursor < askOther.text.length ? askOther.text[askOther.cursor] : ' ')}</Text>
              {protectTerminalText(askOther.cursor < askOther.text.length ? askOther.text.slice(askOther.cursor + 1) : '')}
            </Text>
          ) : (
            <>
              {askReq.req.options.map((o, i) => {
                const sel = i === askSel;
                const mark = askReq.req.multiSelect ? (askChecked.has(i) ? '[x] ' : '[ ] ') : '';
                return (
                  <Text key={i}>
                    {sel ? t.accent('  ❯ ') : '    '}
                    {mark + `${i + 1}. `}
                    {sel ? <Text inverse>{protectTerminalText(o.label)}</Text> : protectTerminalText(o.label)}
                    {o.description ? t.dim('  ' + protectTerminalText(o.description)) : ''}
                  </Text>
                );
              })}
              <Text>
                {askSel === askReq.req.options.length ? t.accent('  ❯ ') : '    '}
                {`${askReq.req.options.length + 1}. `}
                {askSel === askReq.req.options.length ? <Text inverse>Other…</Text> : 'Other…'}
                {t.dim('  type your own answer')}
              </Text>
            </>
          )}
          <Text>
            {t.dim(
              askOther
                ? '  Enter submit · Esc back to the options'
                : askReq.req.multiSelect
                  ? '  ↑/↓ move · Space or 1-9 toggle · Enter confirm · Esc dismiss'
                  : '  ↑/↓ move · 1-9 pick · Enter confirm · Esc dismiss',
            )}
          </Text>
        </Box>
      ) : planReq ? (
        <Box flexDirection="column">
          <Text>{t.bold(t.accent('Proposed plan:'))}</Text>
          <Text>{renderMarkdown(planReq.plan, t)}</Text>
          <Text>
            {t.dim('  Approve? [y] yes, execute · [a] yes + auto-accept file edits this session · [n]/Esc no, keep planning')}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {(() => {
            const lines = comp.text.split('\n');
            let acc = 0;
            let cLine = lines.length - 1;
            let cCol = lines[lines.length - 1].length;
            for (let i = 0; i < lines.length; i++) {
              if (comp.cursor <= acc + lines[i].length) {
                cLine = i;
                cCol = comp.cursor - acc;
                break;
              }
              acc += lines[i].length + 1;
            }
            return lines.map((l, i) => {
              const prefix = i === 0 ? t.accent(busy ? 'sensei ⋯ ' : 'sensei ❯ ') : t.dim('     … ');
              if (i !== cLine) return <Text key={i}>{prefix + protectTerminalText(l)}</Text>;
              const at = cCol < l.length ? l[cCol] : ' ';
              return (
                <Text key={i}>
                  {prefix + protectTerminalText(l.slice(0, cCol))}
                  <Text inverse>{protectTerminalText(at)}</Text>
                  {protectTerminalText(cCol < l.length ? l.slice(cCol + 1) : '')}
                </Text>
              );
            });
          })()}
          {menuView
            ? menuView.rows.map((it, i) => {
                const sel = menuView.start + i === menuView.selected;
                const label = `/${it.name}${it.hint ? ' ' + it.hint : ''}`;
                const cols = stdout?.columns ?? 80;
                let desc = it.desc;
                const room = cols - label.length - 6;
                if (desc.length > room) desc = room > 1 ? desc.slice(0, room - 1) + '…' : '';
                return (
                  <Text key={`${it.source}:${it.name}`}>
                    {sel ? t.accent('❯ ') : '  '}
                    {sel ? <Text inverse>{label}</Text> : label}
                    {'  '}
                    <Text dimColor>{desc}</Text>
                  </Text>
                );
              })
            : null}
          {menuView && menuView.moreBelow > 0 ? <Text>{t.dim(`  … ${menuView.moreBelow} more`)}</Text> : null}
        </Box>
      )}
      <Text>
        {t.dim(
          statusOverride
            ? `  ${protectTerminalText(statusOverride)}${queuedCount > 0 ? ` · ${queuedCount} queued` : ''}`
            : `  ${modelLabel} · ~${(tokens.inTok / 1000).toFixed(1)}k in / ${(tokens.outTok / 1000).toFixed(1)}k out${agent.planMode ? ' · PLAN' : ''}${queuedCount > 0 ? ` · ${queuedCount} queued` : ''}`,
        )}
      </Text>
    </Box>
  );
}

function renderTodoLine(td: Todo, t: Theme): string {
  const c = protectTerminalText(td.content);
  if (td.status === 'completed') return t.dim(`  [x] ${c}`);
  if (td.status === 'in_progress') return t.accent(`  [>] ${c}`);
  return `  [ ] ${c}`;
}
