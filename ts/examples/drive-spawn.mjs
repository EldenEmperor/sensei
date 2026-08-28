// M1 demo: an external program drives Sensei through child processes, holding
// a multi-invocation conversation with --continue and machine-readable output.
//
//   node examples/drive-spawn.mjs
//
// Requires Ollama running locally (uses --local --yolo).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function askSensei(prompt) {
  const r = spawnSync(
    process.execPath,
    [
      path.join(tsRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(tsRoot, 'src', 'cli', 'main.ts'),
      '-p', prompt,
      '--continue',
      '--local',
      '--yolo',
      '--output-format', 'json',
    ],
    { cwd: tsRoot, encoding: 'utf8', timeout: 600000 },
  );
  if (r.status !== 0) {
    throw new Error(`sensei-ts exited ${r.status}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

const questions = [
  'Read the file ../tests/fixtures/sample-logfmt.log and report the maximum "used" value you see and the timestamp of that line. Be brief.',
  'What log level was that line? One word.',
  'Summarize what we established in this conversation in one sentence.',
];

for (const q of questions) {
  console.log(`\n>>> ${q}`);
  const res = askSensei(q);
  console.log(`<<< [session ${res.session_id}, ${res.rounds} round(s)] ${res.result}`);
}
console.log('\ndrive-spawn: 3-invocation --continue conversation complete.');
