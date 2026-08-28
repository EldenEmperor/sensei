// TUI entry: builds the agent with a deferred host, mounts the Ink app.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { SenseiAgent } from '../core/agent.js';
import type { ConfigStore } from '../core/config.js';
import type { ChatMessage, PermissionPolicy } from '../core/types.js';
import type { McpManager } from '../mcp/client.js';
import { App, DeferredHost } from './App.js';

export interface TuiOptions {
  store: ConfigStore;
  local: boolean;
  planMode: boolean;
  policy: PermissionPolicy;
  sessionId?: string;
  restoredMessages?: ChatMessage[];
  version?: string;
  mcp?: McpManager;
}

export interface BannerFrame {
  lines: string[];
  delayMs: number;
}

/** Parse assets/banner.txt: either plain ANSI lines (one static frame) or the
 *  animated format (%%SENSEI-BANNER-ANIM v1 with %%FRAME <delayMs> sections). */
export function parseBanner(raw: string): BannerFrame[] {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.startsWith('%%SENSEI-BANNER-ANIM')) {
    const frames: BannerFrame[] = [];
    let current: BannerFrame | null = null;
    for (const l of lines.slice(1)) {
      const m = l.match(/^%%FRAME (\d+)$/);
      if (m) {
        current = { lines: [], delayMs: Number(m[1]) };
        frames.push(current);
      } else if (current && l !== '') {
        current.lines.push(l);
      }
    }
    return frames.filter((f) => f.lines.length > 0);
  }
  const plain = lines.filter((l) => l !== '');
  return plain.length > 0 ? [{ lines: plain, delayMs: 100 }] : [];
}

function loadBanner(): BannerFrame[] {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bannerPath = path.resolve(here, '..', '..', 'assets', 'banner.txt');
    if (fs.existsSync(bannerPath)) return parseBanner(fs.readFileSync(bannerPath, 'utf8'));
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
    mcp: opts.mcp,
  });
  const instance = render(
    React.createElement(App, {
      agent,
      host,
      version: opts.version ?? '0.1.0',
      bannerFrames: loadBanner(),
      mcp: opts.mcp,
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  return 0;
}
