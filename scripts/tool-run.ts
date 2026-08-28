// Cross-check helper: run one tool against a path and print its raw output.
//   npx tsx scripts/tool-run.ts <toolName> <logPath> [configDir]

import path from 'node:path';
import os from 'node:os';
import { SenseiAgent } from '../src/core/agent.js';
import { ConfigStore } from '../src/core/config.js';
import type { ToolContext } from '../src/tools/registry.js';

const [, , toolName, logPath, configDirArg] = process.argv;
if (!toolName || !logPath) {
  process.stderr.write('usage: tool-run.ts <toolName> <logPath> [configDir]\n');
  process.exit(2);
}

const configDir = configDirArg ?? path.join(os.tmpdir(), 'sensei-crosscheck-ts');
const store = new ConfigStore({ configDir, cwd: process.cwd() });
store.load();
const agent = new SenseiAgent({
  configStore: store,
  host: {
    onEvent: () => {},
    requestPermission: async () => ({ allow: false, reason: 'non-interactive' }),
    requestPlanApproval: async () => false,
  },
  permissionPolicy: { mode: 'yolo' },
  local: true,
  chatClient: { chat: async () => ({ aborted: true }) },
});

const ctx: ToolContext = {
  cwd: process.cwd(),
  configDir: store.configDir,
  config: store.config,
  local: true,
  emitNote: () => {},
  setTodos: () => {},
};

const tool = agent.registry.get(toolName);
if (!tool) {
  process.stderr.write(`unknown tool ${toolName}\n`);
  process.exit(2);
}
const args: Record<string, unknown> =
  toolName === 'log_slice' ? { path: logPath, tail: 3 } : { path: logPath };
const out = await tool.handler(args, ctx);
process.stdout.write(String(out));
