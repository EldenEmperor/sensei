// TUI entry: builds the agent with a deferred host, mounts the Ink app.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { SenseiAgent } from '../core/agent.js';
import type { ConfigStore } from '../core/config.js';
import type { ChatMessage, PermissionPolicy } from '../core/types.js';
import { App, DeferredHost } from './App.js';

export interface TuiOptions {
  store: ConfigStore;
  local: boolean;
  planMode: boolean;
  policy: PermissionPolicy;
  sessionId?: string;
  restoredMessages?: ChatMessage[];
  version?: string;
}

function loadBanner(): string[] {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bannerPath = path.resolve(here, '..', '..', '..', 'assets', 'banner.txt');
    if (fs.existsSync(bannerPath)) return fs.readFileSync(bannerPath, 'utf8').split(/\r?\n/).filter((l) => l !== '');
  } catch {
    /* no banner */
  }
  return [];
}

export async function runTui(opts: TuiOptions): Promise<number> {
  const host = new DeferredHost();
  const agent = new SenseiAgent({
    configStore: opts.store,
    host,
    permissionPolicy: opts.policy,
    local: opts.local,
    planMode: opts.planMode,
    sessionId: opts.sessionId,
    restoredMessages: opts.restoredMessages,
  });
  const instance = render(
    React.createElement(App, {
      agent,
      host,
      version: opts.version ?? '0.1.0',
      bannerLines: loadBanner(),
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  return 0;
}
