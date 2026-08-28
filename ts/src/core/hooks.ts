// User-configured shell hooks around agent events, ported from src\hooks.ps1.
// Config: "hooks": [ { "event": "PreToolUse|PostToolUse|UserPromptSubmit|Stop",
//                      "matcher": "run_powershell", "command": "..." } ]
// The hook command runs in pwsh with a JSON event payload on stdin.
// Exit 0 = continue (stdout shown dim). Exit 2 on PreToolUse/UserPromptSubmit =
// block (stderr becomes the reason). Anything else = warn and continue.

import { spawn } from 'node:child_process';
import { likeMatch } from './permissions.js';

export interface HookConfig {
  event: string;
  matcher?: string;
  command: string;
}

export interface HookContext {
  cwd: string;
  sessionId: string;
  note(text: string): void;
}

export interface HookEventArgs {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: string;
  prompt?: string;
  lastMessage?: string;
}

export interface HookResult {
  block: boolean;
  reason: string;
}

function runOne(command: string, json: string, cwd: string): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true });
    let out = '';
    let err = '';
    let settled = false;
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (out += d));
    p.stderr.on('data', (d: string) => (err += d));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        p.kill();
      } catch {
        /* gone */
      }
      resolve({ code: -1, out, err, timedOut: true });
    }, 30000);
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message, timedOut: false });
    });
    p.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err, timedOut: false });
    });
    p.stdin.write(json, 'utf8');
    p.stdin.end();
  });
}

export async function runHooks(
  event: string,
  hooks: HookConfig[],
  ctx: HookContext,
  args: HookEventArgs = {},
): Promise<HookResult> {
  const result: HookResult = { block: false, reason: '' };
  const matching = hooks.filter((h) => String(h.event) === event);
  if (matching.length === 0) return result;

  for (const h of matching) {
    if ((event === 'PreToolUse' || event === 'PostToolUse') && h.matcher && !likeMatch(args.toolName ?? '', String(h.matcher))) {
      continue;
    }
    const payload: Record<string, unknown> = {
      hook_event_name: event,
      cwd: ctx.cwd,
      session_id: ctx.sessionId,
    };
    if (args.toolName) {
      payload.tool_name = args.toolName;
      payload.tool_input = args.toolInput ?? {};
    }
    if (args.toolResponse !== undefined) payload.tool_response = args.toolResponse;
    if (args.prompt !== undefined) payload.prompt = args.prompt;
    if (args.lastMessage !== undefined) payload.last_message = args.lastMessage;
    const json = JSON.stringify(payload);

    try {
      const r = await runOne(String(h.command), json, ctx.cwd);
      if (r.timedOut) {
        ctx.note(`hook timed out (30s): ${h.command}`);
        continue;
      }
      if (r.code === 0) {
        if (r.out.trim()) ctx.note(`hook: ${r.out.trim()}`);
      } else if (r.code === 2 && (event === 'PreToolUse' || event === 'UserPromptSubmit')) {
        result.block = true;
        result.reason = r.err.trim() || `blocked by hook: ${h.command}`;
        return result;
      } else {
        ctx.note(`hook exited ${r.code}: ${h.command}${r.err ? ` — ${r.err.trim()}` : ''}`);
      }
    } catch (e) {
      ctx.note(`hook failed to run: ${(e as Error).message}`);
    }
  }
  return result;
}

/** Merged user + project hooks (mirrors Get-SenseiHooks). */
export function mergedHooks(config: { hooks?: unknown }, projectConfig: { hooks?: unknown }): HookConfig[] {
  const out: HookConfig[] = [];
  for (const src of [config.hooks, projectConfig.hooks]) {
    if (Array.isArray(src)) out.push(...(src as HookConfig[]));
  }
  return out;
}
