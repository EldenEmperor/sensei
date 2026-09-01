// M1 demo: embed Sensei in-process — no child processes, a custom AgentHost
// receives live events, and one SenseiAgent instance carries the conversation.
//
//   npx tsx examples/drive-import.mjs
//
// Requires Ollama running locally.

import { ConfigStore, SenseiAgent } from '../src/index.js';

const store = new ConfigStore();
store.load();

const host = {
  onEvent(e) {
    if (e.type === 'tool-start') console.log(`  [tool] ${e.name}`);
    if (e.type === 'note') console.log(`  [note] ${e.text}`);
  },
  requestPermission: async () => ({ allow: false, reason: 'non-interactive' }),
  requestPlanApproval: async () => ({ approved: false }),
  requestUserChoice: async () => ({ cancelled: true }),
};

const agent = new SenseiAgent({
  configStore: store,
  host,
  permissionPolicy: { mode: 'yolo' },
  local: true,
});

const questions = [
  'Read the file tests/fixtures/sample-logfmt.log and report the maximum "used" value you see and the timestamp of that line. Be brief.',
  'What log level was that line? One word.',
];

for (const q of questions) {
  console.log(`\n>>> ${q}`);
  const r = await agent.ask(q);
  console.log(`<<< ${r.finalText}`);
}
console.log(`\ndrive-import: done (session ${agent.sessionId}, in-process, no child processes).`);
