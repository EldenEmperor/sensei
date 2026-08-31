// MCP client on @modelcontextprotocol/sdk (stdio transport). Servers come from
// "mcpServers" in ~/.sensei/config.json or .sensei.json; their tools register
// as mcp__<server>__<tool>. Server stderr is drained to ~/.sensei/logs/.

import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ConfigStore } from '../core/config.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpServerState {
  name: string;
  status: 'connected' | 'failed';
  error: string | null;
  client: Client | null;
  tools: { name: string; description?: string; inputSchema?: unknown }[];
}

export function safeToolName(name: string): string {
  let safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (safe.length > 64) safe = safe.slice(0, 64);
  return safe;
}

/** Merged user + project mcpServers (project wins on collisions). */
export function mergedMcpServers(store: ConfigStore): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  for (const src of [store.config.mcpServers, (store.projectConfig as { mcpServers?: unknown }).mcpServers]) {
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src as Record<string, McpServerConfig>)) merged[k] = v;
    }
  }
  return merged;
}

export class McpManager {
  readonly servers = new Map<string, McpServerState>();
  private readonly configDir: string;
  private readonly cwd: string;
  private readonly callTimeoutMs: number;

  constructor(opts: { configDir: string; cwd: string; callTimeoutSec?: number }) {
    this.configDir = opts.configDir;
    this.cwd = opts.cwd;
    this.callTimeoutMs = 1000 * (opts.callTimeoutSec ?? 120);
  }

  logPath(name: string): string {
    return path.join(this.configDir, 'logs', `mcp-${name}.log`);
  }

  async startAll(configs: Record<string, McpServerConfig>, note: (t: string) => void): Promise<void> {
    for (const [name, cfg] of Object.entries(configs)) {
      try {
        await this.connect(name, cfg);
        const s = this.servers.get(name)!;
        note(`mcp: ${name} connected (${s.tools.length} tools)`);
      } catch (e) {
        this.servers.set(name, {
          name,
          status: 'failed',
          error: (e as Error).message,
          client: null,
          tools: [],
        });
        note(`mcp: ${name} failed — ${(e as Error).message} (log: ${this.logPath(name)})`);
      }
    }
  }

  private async connect(name: string, cfg: McpServerConfig): Promise<void> {
    const logDir = path.join(this.configDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = String(v);

    const transport = new StdioClientTransport({
      command: String(cfg.command),
      args: (cfg.args ?? []).map(String),
      env,
      cwd: this.cwd,
      stderr: 'pipe',
    });
    // stderr must be actively drained or a chatty server stalls on a full pipe
    const logStream = fs.createWriteStream(this.logPath(name), { flags: 'a' });
    transport.stderr?.pipe(logStream);

    const client = new Client({ name: 'sensei', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools: McpServerState['tools'] = [];
    let cursor: string | undefined;
    do {
      const r = await client.listTools(cursor ? { cursor } : {});
      tools.push(...(r.tools as McpServerState['tools']));
      cursor = (r as { nextCursor?: string }).nextCursor;
    } while (cursor);

    this.servers.set(name, { name, status: 'connected', error: null, client, tools });
  }

  /** Register every connected server's tools as mcp__<server>__<tool>. */
  registerTools(registry: ToolRegistry): void {
    for (const s of this.servers.values()) {
      if (s.status !== 'connected') continue;
      for (const tool of s.tools) {
        const full = `mcp__${s.name}__${tool.name}`;
        const safe = safeToolName(full);
        let schema = tool.inputSchema as Record<string, unknown> | undefined;
        if (schema && typeof schema === 'object') {
          schema = { ...schema };
          delete schema['$schema'];
        }
        if (!schema || schema.type !== 'object') schema = { type: 'object', properties: {} };
        const serverName = s.name;
        const toolName = tool.name;
        // first string-typed property = primaryArg, so allow/deny rules can
        // match on the argument (e.g. "mcp__github__get_issue(123)")
        const props = (schema.properties ?? {}) as Record<string, { type?: unknown } | undefined>;
        const primaryArg = Object.keys(props).find((k) => props[k]?.type === 'string');
        registry.register({
          name: safe,
          readOnly: false,
          primaryArg,
          description: String(tool.description ?? ''),
          parameters: schema,
          handler: async (a) => this.call(serverName, toolName, a),
        });
      }
    }
  }

  async call(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const s = this.servers.get(serverName);
    if (!s || s.status !== 'connected' || !s.client) {
      return `ERROR: MCP server '${serverName}' is not connected`;
    }
    let result;
    try {
      result = await s.client.callTool({ name: toolName, arguments: args ?? {} }, undefined, {
        timeout: this.callTimeoutMs,
      });
    } catch (e) {
      return `ERROR: ${(e as Error).message}`;
    }
    const parts: string[] = [];
    for (const c of (result.content as { type: string; text?: string }[] | undefined) ?? []) {
      if (!c) continue;
      if (c.type === 'text') parts.push(String(c.text ?? ''));
      else parts.push(`[${c.type} content omitted]`);
    }
    let text = parts.join('\n');
    if (result.isError) text = `ERROR: ${text}`;
    if (!text) text = '(empty result)';
    return text;
  }

  /** Status lines for /mcp. */
  statusLines(): string[] {
    if (this.servers.size === 0) {
      return [
        'no MCP servers configured — add "mcpServers" to ~/.sensei/config.json or .sensei.json:',
        '  "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\logs"] } }',
      ];
    }
    const out: string[] = [];
    for (const s of this.servers.values()) {
      if (s.status === 'connected') {
        out.push(`  ● ${s.name} — connected, ${s.tools.length} tools`);
        for (const tool of s.tools) {
          let desc = String(tool.description ?? '').replace(/\r?\n[\s\S]*/, '');
          if (desc.length > 70) desc = desc.slice(0, 67) + '…';
          out.push(`     mcp__${s.name}__${tool.name} — ${desc}`);
        }
      } else {
        out.push(`  ● ${s.name} — failed: ${s.error}`);
        out.push(`     log: ${this.logPath(s.name)}`);
      }
    }
    return out;
  }

  async stopAll(): Promise<void> {
    for (const s of this.servers.values()) {
      try {
        await s.client?.close();
      } catch {
        /* best effort */
      }
    }
    this.servers.clear();
  }
}
