// The Ink TUI — a thin host over the SenseiAgent engine. All engine output
// arrives as AgentEvents; completed output scrolls into terminal history via
// <Static>, while the dynamic bottom region holds the streaming answer,
// spinner, todos, permission prompts, and the composer.

import fs from 'node:fs';
import path from 'node:path';
import { Box, Static, Text, useApp, useInput } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SenseiAgent } from '../core/agent.js';
import { costLine, getActiveModel, OUTPUT_STYLES } from '../core/config.js';
import type { AgentEvent, AgentHost } from '../core/events.js';
import type { PermissionDecision, PermissionRequest, Todo } from '../core/types.js';
import { formatToolArgs } from '../cli/textOutput.js';
import { renderDiffPreview } from './diff.js';
import { renderMarkdown } from './markdown.js';
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
  requestPlanApproval(plan: string): Promise<boolean> {
    return this.target ? this.target.requestPlanApproval(plan) : Promise.resolve(false);
  }
}

interface Item {
  id: number;
  text: string;
}

interface AppProps {
  agent: SenseiAgent;
  host: DeferredHost;
  version: string;
  bannerLines: string[];
}

const HELP_LINES = [
  '  /help            show this help',
  '  /clear           reset the conversation (and todos)',
  '  /plan            toggle plan mode (read-only until you approve a plan)',
  '  /style [name]    response style: default|concise|explanatory|teaching',
  '  /color [name|hex] accent color: indigo|jade|gold|teal|red or #RRGGBB',
  '  /model [name]    show or set the model (setting persists to config)',
  '  /config          show effective config',
  '  /permissions     list allowlist rules',
  '  /todos           show the current checklist',
  '  /cost            token usage and estimated cost',
  '  /exit            quit (also /quit, or Ctrl+D)',
  '  custom commands: .sensei\\commands\\<name>.md ($ARGUMENTS substituted)',
];

export function App({ agent, host, version, bannerLines }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const nextId = useRef(0);
  const [items, setItems] = useState<Item[]>([]);
  const [streamText, setStreamText] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [frame, setFrame] = useState(0);
  const [permReq, setPermReq] = useState<{ req: PermissionRequest; resolve: (d: PermissionDecision) => void } | null>(null);
  const [planReq, setPlanReq] = useState<{ plan: string; resolve: (ok: boolean) => void } | null>(null);
  const [input, setInput] = useState('');
  const [tokens, setTokens] = useState<{ inTok: number; outTok: number }>({ inTok: 0, outTok: 0 });
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef('');

  const theme: Theme = useMemo(() => {
    const accent = resolveAccent(String(agent.store.config.accent)) ?? ACCENT_PRESETS.indigo;
    return makeTheme(accent, Boolean(agent.store.config.theme));
  }, [agent.store.config.accent, agent.store.config.theme]);

  const push = (text: string): void => {
    setItems((prev) => [...prev, { id: nextId.current++, text }]);
  };

  // banner
  useEffect(() => {
    const t = theme;
    const lines = bannerLines.map((l) => t.accent(l));
    const modelLabel = getActiveModel(agent.store.config, agent.local) + (agent.local ? ' (local · ollama)' : '');
    lines.push(t.bold(t.accent('  sensei')) + t.dim(` v${version} · log-debugging agent · model: ${modelLabel}`));
    lines.push(t.dim('  ask about a log file, or /help for commands'));
    lines.push('');
    setItems(lines.map((text) => ({ id: nextId.current++, text })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // spinner
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(t);
  }, [busy]);

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
          default:
            break;
        }
      },
      requestPermission: (req) => new Promise<PermissionDecision>((resolve) => setPermReq({ req, resolve })),
      requestPlanApproval: (plan) => new Promise<boolean>((resolve) => setPlanReq({ plan, resolve })),
    };
    return () => {
      host.target = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

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

  const run = (prompt: string): void => {
    setBusy(true);
    abortRef.current = new AbortController();
    void agent
      .ask(prompt, { signal: abortRef.current.signal })
      .catch((e: Error) => push(theme.err(`✗ ${protectTerminalText(e.message)}`)))
      .finally(() => {
        setBusy(false);
        setActiveTool(null);
        streamRef.current = '';
        setStreamText('');
      });
  };

  const findCustomCommand = (name: string): string | null => {
    for (const dir of [path.join(agent.store.cwd, '.sensei', 'commands'), path.join(agent.store.configDir, 'commands')]) {
      const p = path.join(dir, `${name}.md`);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    return null;
  };

  const handleSlash = (line: string): void => {
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    const t = theme;
    switch (cmd) {
      case '/help':
        for (const l of HELP_LINES) push(l);
        break;
      case '/clear':
        agent.clearConversation();
        push(t.dim('conversation cleared'));
        break;
      case '/plan': {
        agent.setPlanMode(!agent.planMode);
        push(t.dim(agent.planMode ? 'plan mode ON — read-only until you approve a plan' : 'plan mode OFF'));
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
          push(t.dim(`model: ${getActiveModel(agent.store.config, agent.local)}${agent.local ? ' (local)' : ''}`));
          break;
        }
        if (agent.local) agent.store.config.local_model = arg;
        else agent.store.config.model = arg;
        agent.store.save();
        push(t.dim(`model set to ${arg}`));
        break;
      }
      case '/config': {
        const cfg = { ...agent.store.config };
        if (cfg.api_key) cfg.api_key = '(set)';
        for (const l of JSON.stringify(cfg, null, 2).split('\n')) push(t.dim(l));
        break;
      }
      case '/permissions': {
        const rules = agent.store.getAllowRules();
        if (rules.length === 0) push(t.dim('no allowlist rules'));
        for (const r of rules) push(t.dim(`  ${r.rule}  (${r.source})`));
        break;
      }
      case '/todos': {
        if (todos.length === 0) push(t.dim('  (no todos)'));
        for (const td of todos) push(renderTodoLine(td, t));
        break;
      }
      case '/cost': {
        const { line: cl } = costLine(agent.store.config, agent.local, tokens.inTok, tokens.outTok);
        push(t.dim(cl));
        break;
      }
      case '/exit':
      case '/quit':
        doExit();
        break;
      default: {
        const name = cmd.replace(/^\//, '');
        const file = findCustomCommand(name);
        if (file) {
          push(t.dim(`(custom command: ${file})`));
          const prompt = fs.readFileSync(file, 'utf8').replace(/\$ARGUMENTS/g, arg);
          run(prompt);
          break;
        }
        push(t.dim(`unknown command ${cmd} — try /help`));
        break;
      }
    }
  };

  const submit = (): void => {
    const line = input.trim();
    setInput('');
    historyIdx.current = -1;
    if (!line) return;
    history.current.push(line);
    push(theme.accent('❯ ') + protectTerminalText(line));
    if (line.startsWith('/')) handleSlash(line);
    else run(line);
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
    if (planReq) {
      const r = planReq;
      setPlanReq(null);
      r.resolve(ch.toLowerCase() === 'y');
      return;
    }
    if (busy) {
      if (key.escape || (key.ctrl && ch === 'c')) abortRef.current?.abort();
      return;
    }
    if (key.ctrl && (ch === 'c' || ch === 'd')) {
      doExit();
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.upArrow) {
      if (history.current.length === 0) return;
      if (historyIdx.current < 0) historyIdx.current = history.current.length;
      historyIdx.current = Math.max(0, historyIdx.current - 1);
      setInput(history.current[historyIdx.current] ?? '');
      return;
    }
    if (key.downArrow) {
      if (historyIdx.current < 0) return;
      historyIdx.current++;
      if (historyIdx.current >= history.current.length) {
        historyIdx.current = -1;
        setInput('');
      } else {
        setInput(history.current[historyIdx.current] ?? '');
      }
      return;
    }
    if (key.tab) {
      if (input.startsWith('/')) {
        const partial = input.slice(1).toLowerCase();
        const all = HELP_LINES.map((l) => l.trim().split(/\s+/)[0]).filter((c) => c.startsWith('/'));
        const match = all.find((c) => c.slice(1).startsWith(partial));
        if (match) setInput(match + ' ');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (ch && !key.ctrl && !key.meta) setInput((v) => v + ch);
  });

  // dynamic region -----------------------------------------------------------
  const t = theme;
  let displayStream = streamText;
  const thinkIdx = displayStream.indexOf('<think>');
  if (thinkIdx >= 0 && !displayStream.includes('</think>')) displayStream = displayStream.slice(0, thinkIdx);
  const spinnerLabel = activeTool ? `${activeTool}…` : 'thinking…';
  const modelLabel = getActiveModel(agent.store.config, agent.local) + (agent.local ? ' · local' : '');

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <Text key={item.id}>{item.text}</Text>}</Static>
      {displayStream ? <Text>{renderMarkdown(displayStream, t)}</Text> : null}
      {busy && !permReq ? (
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
      ) : planReq ? (
        <Box flexDirection="column">
          <Text>{t.bold(t.accent('Proposed plan:'))}</Text>
          <Text>{renderMarkdown(planReq.plan, t)}</Text>
          <Text>{t.dim('  Approve this plan and let Sensei execute it? [y/N]')}</Text>
        </Box>
      ) : !busy ? (
        <Text>
          {t.accent('sensei ❯ ') + protectTerminalText(input) + t.dim('▌')}
        </Text>
      ) : null}
      <Text>
        {t.dim(
          `  ${modelLabel} · ~${(tokens.inTok / 1000).toFixed(1)}k in / ${(tokens.outTok / 1000).toFixed(1)}k out${agent.planMode ? ' · PLAN' : ''}`,
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
