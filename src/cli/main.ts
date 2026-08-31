#!/usr/bin/env node
// sensei CLI — headless-first entry point.
// Exit codes: 0 success; 1 turn error (API/key/network); 2 usage error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SenseiAgent } from '../core/agent.js';
import { ConfigStore } from '../core/config.js';
import { preflightProvider, resolveProvider, setActiveModel } from '../core/providers.js';
import { INVESTIGATE_PROMPT } from '../core/prompts.js';
import { findSession, loadSessionFile } from '../core/sessions.js';
import { McpManager, mergedMcpServers } from '../mcp/client.js';
import { stopAllBackgroundTasks } from '../tools/tasks.js';
import type { PermissionPolicy } from '../core/types.js';
import { parseCliArgs, USAGE, UsageError } from './args.js';
import { HeadlessHost } from './headlessHost.js';

interface JsonResult {
  schema_version: 1;
  session_id: string;
  result: string | null;
  finish_reason: string | null;
  rounds: number;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number | null;
  };
  permission_denials: { tool: string; primary?: string }[];
  error: string | null;
}

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`sensei: ${e.message}\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let prompt = args.print;
  if (args.investigate && !prompt) {
    prompt = INVESTIGATE_PROMPT.replace('<PATH>', path.resolve(args.investigate));
  }
  const interactive = !prompt && process.stdout.isTTY && process.stdin.isTTY;
  if (!prompt && !interactive) {
    process.stderr.write('sensei: -p <prompt> is required when not attached to a terminal\n');
    return 2;
  }

  const store = new ConfigStore();
  store.load((t) => process.stderr.write(t + '\n'));
  if (args.model) {
    // written before provider resolution so model-name inference sees it
    if (args.local) store.config.local_model = args.model;
    else store.config.model = args.model;
  }

  // resolve a session to continue/resume (before provider resolution — the
  // envelope's provider is adopted when no --provider/--local was given)
  let restoredMessages;
  let sessionId = args.sessionId;
  let providerName = args.provider;
  if (args.continueSession || args.resume) {
    const file = findSession(
      store.sessionDir,
      args.resume ?? args.continueId,
      store.cwd,
    );
    if (!file) {
      const explicit = args.resume ?? args.continueId;
      if (explicit) {
        process.stderr.write(`sensei: no saved session found (${explicit})\n`);
        return 2;
      }
      // bare --continue with nothing to continue: start fresh (and save after)
      process.stderr.write('(no saved session for this directory — starting a new one)\n');
    } else {
      const loaded = loadSessionFile(file);
      restoredMessages = loaded.messages;
      if (args.continueSession && !sessionId && loaded.id) sessionId = loaded.id;
      if (!providerName && !args.local && loaded.provider) providerName = loaded.provider;
      process.stderr.write(`(resumed ${loaded.messages.length} messages from ${file})\n`);
    }
  }

  let resolved;
  try {
    resolved = resolveProvider(store.config, { provider: providerName, local: args.local });
  } catch (e) {
    process.stderr.write(`sensei: ${(e as Error).message}\n`);
    return 2;
  }
  if (args.model) setActiveModel(store.config, resolved, args.model);
  const preflightError = preflightProvider(resolved);
  if (preflightError) {
    process.stderr.write(`sensei: ${preflightError}\n`);
    return 1;
  }

  // MCP servers (shared config with the PS variant)
  const mcpConfigs = mergedMcpServers(store);
  let mcp: McpManager | undefined;
  if (Object.keys(mcpConfigs).length > 0) {
    mcp = new McpManager({
      configDir: store.configDir,
      cwd: store.cwd,
      callTimeoutSec: Number(store.config.mcp_call_timeout ?? 120),
    });
    await mcp.startAll(mcpConfigs, (t) => process.stderr.write(t + '\n'));
  }

  if (interactive) {
    // TUI mode: --allow rules merge into the in-memory allowlist; permission
    // prompts are interactive unless --yolo.
    if (args.allow.length > 0) {
      const perms = (store.config.permissions ?? { allow: [] }) as { allow: string[] };
      perms.allow = [...(perms.allow ?? []), ...args.allow];
      store.config.permissions = perms;
    }
    try {
      const { runTui } = await import('../tui/index.js');
      return await runTui({
        store,
        local: args.local,
        provider: providerName,
        planMode: args.plan,
        policy: args.yolo ? { mode: 'yolo' } : { mode: 'interactive' },
        sessionId: sessionId ?? undefined,
        restoredMessages,
        version: '0.1.0',
        mcp,
      });
    } finally {
      stopAllBackgroundTasks();
      await mcp?.stopAll();
    }
  }

  const policy: PermissionPolicy = args.yolo
    ? { mode: 'yolo' }
    : { mode: 'allowlist', extraRules: args.allow };

  const host = new HeadlessHost(args.outputFormat);
  const agent = new SenseiAgent({
    configStore: store,
    host,
    permissionPolicy: policy,
    local: args.local,
    provider: providerName ?? undefined,
    planMode: args.plan,
    maxRounds: args.maxRounds ?? undefined,
    sessionId: sessionId ?? undefined,
    restoredMessages,
    mcp,
  });

  let result;
  let error: string | null = null;
  try {
    result = await agent.ask(prompt!, { files: args.files });
  } catch (e) {
    error = (e as Error).message;
    result = null;
  } finally {
    stopAllBackgroundTasks();
    await mcp?.stopAll();
  }

  // print mode saves the session when the caller opted into continuity
  const wantsPersistence = args.continueSession || args.sessionId !== null;
  if (wantsPersistence && Boolean(store.config.save_sessions)) {
    try {
      agent.saveSession();
    } catch (e) {
      process.stderr.write(`(couldn't save session: ${(e as Error).message})\n`);
    }
  }

  if (args.outputFormat === 'json' || args.outputFormat === 'stream-json') {
    const { costUsd } = agent.costLine();
    const payload: JsonResult = {
      schema_version: 1,
      session_id: agent.sessionId,
      result: result?.finalText ?? null,
      finish_reason: result?.finishReason ?? null,
      rounds: result?.rounds ?? 0,
      usage: {
        prompt_tokens: agent.totalPromptTokens,
        completion_tokens: agent.totalCompletionTokens,
        cache_read_tokens: agent.totalCacheReadTokens,
        cache_creation_tokens: agent.totalCacheWriteTokens,
        cost_usd: costUsd,
      },
      permission_denials: result?.permissionDenials ?? [],
      error,
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else if (error) {
    process.stderr.write(`sensei: ${error}\n`);
  }

  return error ? 1 : 0;
}

// invoked directly (not imported as a library): argv[1] is this module
const isDirect = (() => {
  try {
    if (!process.argv[1]) return false;
    const a = path.resolve(process.argv[1]);
    const b = fileURLToPath(import.meta.url);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
})();
if (isDirect) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`sensei: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
