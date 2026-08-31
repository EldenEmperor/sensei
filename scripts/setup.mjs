#!/usr/bin/env node
// Post-clone setup: install → build → link the `sensei` command → tests →
// interactive provider/model configuration into ~/.sensei/config.json.
// Zero dependencies; run as `npm run setup` (add `-- --yes` to skip prompts).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (msg) => console.log(`  ✗ ${msg}`);
const say = (msg) => console.log(msg);

const nonInteractive = process.argv.includes('--yes') || !process.stdin.isTTY;
const configDir = path.join(os.homedir(), '.sensei');
const configPath = path.join(configDir, 'config.json');

function run(label, cmd, args) {
  say(`\n> ${label} (${cmd} ${args.join(' ')})`);
  // one shell string (all-static args) so the Windows npm.cmd shim resolves
  // without the DEP0190 args-with-shell warning
  const r = spawnSync(`${cmd} ${args.join(' ')}`, { stdio: 'inherit', shell: true });
  return r.status === 0;
}

/** Merge new keys into ~/.sensei/config.json, preserving everything else
 *  (same contract as ConfigStore.load: unknown keys survive). */
function mergeConfig(patch) {
  fs.mkdirSync(configDir, { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) ?? {};
  } catch {
    /* fresh or unreadable — start clean */
  }
  const merged = { ...existing, ...patch };
  if (patch.providers) merged.providers = { ...(existing.providers ?? {}), ...patch.providers };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function keyInstructions(envVar) {
  if (process.platform === 'win32') {
    return [
      `  this shell:   $env:${envVar} = "sk-..."`,
      `  permanently:  setx ${envVar} "sk-..."   (takes effect in NEW terminals)`,
    ];
  }
  return [`  export ${envVar}="sk-..."   (add to your ~/.bashrc or ~/.zshrc to persist)`];
}

async function interactiveConfig() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def = '') => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };

  try {
    say('\n--- Mode ---');
    const mode = (await ask('Primary use — coding or log debugging? (code|logs)', 'code')).toLowerCase();
    mergeConfig({ mode: mode === 'logs' ? 'logs' : 'code' });
    ok(`mode: ${mode === 'logs' ? 'logs' : 'code'} (switch anytime with /mode)`);

    say('\n--- Provider setup (writes ~/.sensei/config.json; Ctrl+C to stop) ---');
    say('  1) anthropic  — Claude models via ANTHROPIC_API_KEY');
    say('  2) openai     — GPT models via OPENAI_API_KEY');
    say('  3) gateway    — a company gateway/proxy (custom URL + token)');
    say('  4) local      — local Ollama, no key needed');
    say('  5) skip       — configure later (/provider and /model in the TUI)');
    const choice = await ask('Which will you use? (1-5)', '1');

    if (choice === '5' || choice === 'skip') {
      say('  skipped — set a model later with /model, or edit ~/.sensei/config.json');
      return;
    }

    if (choice === '4' || choice === 'local') {
      ok('local Ollama selected — no key needed (default endpoint http://localhost:11434)');
      const model = await ask('Local model', 'qwen3:14b');
      mergeConfig({ local_model: model });
      ok(`saved — launch with: sensei --local`);
      return;
    }

    if (choice === '3' || choice === 'gateway') {
      const name = await ask('Provider name (a short label)', 'company');
      const wire = await ask('Wire protocol the gateway speaks (openai|anthropic)', 'anthropic');
      const baseUrl = await ask('Base URL (e.g. https://llm-gw.corp.example/anthropic)');
      const envVar = await ask('Env var that will hold the token', 'COMPANY_LLM_TOKEN');
      const model = await ask('Model to use', wire === 'openai' ? 'gpt-5.1' : 'claude-opus-5');
      mergeConfig({
        provider: name,
        providers: {
          [name]: { wire: wire === 'openai' ? 'openai' : 'anthropic', base_url: baseUrl, api_key_env: envVar, model },
        },
      });
      ok(`saved provider '${name}' (${wire} wire) with model ${model}`);
      if (!process.env[envVar]) {
        warn(`${envVar} is not set in this shell. Set it:`);
        for (const l of keyInstructions(envVar)) say(l);
      } else ok(`${envVar} is set`);
      return;
    }

    const isAnthropic = choice === '1' || choice === 'anthropic';
    const envVar = isAnthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    const model = await ask('Model', isAnthropic ? 'claude-opus-5' : 'gpt-5.1');
    mergeConfig({ model });
    ok(`saved model ${model} (provider inferred: ${isAnthropic ? 'anthropic' : 'openai'})`);
    if (process.env[envVar]) {
      ok(`${envVar} is already set`);
    } else {
      warn(`${envVar} is not set in this shell. Set it:`);
      for (const l of keyInstructions(envVar)) say(l);
      const store = (await ask('Or store the key in ~/.sensei/config.json instead? (y/N)', 'n')).toLowerCase();
      if (store === 'y' || store === 'yes') {
        const key = await ask('API key');
        if (key) {
          mergeConfig({ api_key: key });
          ok('key stored in config (env var still wins if set later)');
        }
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  say('sensei setup');

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    fail(`Node ${process.versions.node} found — sensei needs Node >= 22. Install it from https://nodejs.org and rerun.`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);

  if (!run('installing dependencies', 'npm', ['install'])) {
    fail('npm install failed — fix the error above and rerun npm run setup');
    process.exit(1);
  }
  if (!run('building', 'npm', ['run', 'build'])) {
    fail('build failed — fix the error above and rerun npm run setup');
    process.exit(1);
  }
  if (run('linking the `sensei` command', 'npm', ['link'])) {
    ok('`sensei` is on your PATH (rerun `npm run build` after source changes)');
  } else {
    warn('npm link failed (permissions?) — you can still run `npm run dev`, or retry `npm link` manually');
  }
  if (run('running the offline test suite', 'npm', ['test'])) {
    ok('all tests passed');
  } else {
    warn('tests failed — sensei may still work, but something is off; see output above');
  }

  if (nonInteractive) {
    say('\n(non-interactive: skipping provider setup — set ANTHROPIC_API_KEY/OPENAI_API_KEY');
    say(' and a model in ~/.sensei/config.json, or rerun `npm run setup` in a terminal)');
  } else {
    await interactiveConfig();
  }

  say('\nDone. Launch with:');
  say('  sensei                 interactive TUI in the current directory');
  say('  sensei "prompt"        one-shot headless run');
  say('  /help /model /provider inside the TUI · config lives at ~/.sensei/config.json');
}

main().catch((e) => {
  fail(e?.message ?? String(e));
  process.exit(1);
});
