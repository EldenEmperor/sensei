// CLI argument parsing on node:util parseArgs, with light preprocessing for
// `--continue [id]` (optional value).

import { parseArgs } from 'node:util';

export interface CliArgs {
  print: string | null;
  files: string[];
  outputFormat: 'text' | 'json' | 'stream-json';
  continueSession: boolean;
  continueId: string | null;
  sessionId: string | null;
  resume: string | null;
  yolo: boolean;
  allow: string[];
  local: boolean;
  provider: string | null;
  model: string | null;
  plan: boolean;
  maxRounds: number | null;
  investigate: string | null;
  help: boolean;
}

export class UsageError extends Error {}

export function parseCliArgs(argv: string[]): CliArgs {
  // `--continue` may take an optional id: treat the next token as its value
  // only when it doesn't look like another flag.
  const pre: string[] = [];
  let continueSession = false;
  let continueId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--continue') {
      continueSession = true;
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        continueId = argv[++i];
      }
      continue;
    }
    pre.push(a);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: pre,
      allowPositionals: false,
      options: {
        print: { type: 'string', short: 'p' },
        file: { type: 'string', multiple: true },
        'output-format': { type: 'string' },
        'session-id': { type: 'string' },
        resume: { type: 'string' },
        yolo: { type: 'boolean' },
        allow: { type: 'string', multiple: true },
        local: { type: 'boolean' },
        provider: { type: 'string' },
        model: { type: 'string' },
        plan: { type: 'boolean' },
        'max-rounds': { type: 'string' },
        investigate: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const v = parsed.values;

  const format = String(v['output-format'] ?? 'text');
  if (!['text', 'json', 'stream-json'].includes(format)) {
    throw new UsageError(`unknown --output-format '${format}' (text|json|stream-json)`);
  }
  let maxRounds: number | null = null;
  if (v['max-rounds'] !== undefined) {
    maxRounds = Number(v['max-rounds']);
    if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new UsageError('--max-rounds must be a positive integer');
  }

  return {
    print: (v.print as string | undefined) ?? null,
    files: (v.file as string[] | undefined) ?? [],
    outputFormat: format as CliArgs['outputFormat'],
    continueSession,
    continueId,
    sessionId: (v['session-id'] as string | undefined) ?? null,
    resume: (v.resume as string | undefined) ?? null,
    yolo: Boolean(v.yolo),
    allow: (v.allow as string[] | undefined) ?? [],
    local: Boolean(v.local),
    provider: (v.provider as string | undefined) ?? null,
    model: (v.model as string | undefined) ?? null,
    plan: Boolean(v.plan),
    maxRounds,
    investigate: (v.investigate as string | undefined) ?? null,
    help: Boolean(v.help),
  };
}

export const USAGE = `usage: sensei -p "prompt" [options]

  -p, --print <prompt>      run one prompt non-interactively (required in this build; TUI arrives later)
  --file <path>             attach a file to the prompt (repeatable; big files are pointed at the log tools)
  --output-format <f>       text (default) | json (single result object) | stream-json (NDJSON events)
  --continue [id]           continue a saved session — latest for this directory, or the given id
  --session-id <id>         use/create a session with this exact id (saved after the turn)
  --resume <id>             load this saved session (id or file path) without adopting its id
  --yolo                    skip all tool permission checks
  --allow "tool(pattern)"   add an allowlist rule for this run (repeatable)
  --local                   use the local Ollama endpoint (alias for --provider local)
  --provider <name>         endpoint to use: openai | anthropic | local | a "providers" entry from config
  --model <name>            override the model for this run (claude-* infers --provider anthropic)
  --plan                    plan mode: read-only tools only
  --max-rounds <n>          cap model/tool rounds for the turn (default 40)
  --investigate <path>      deep-map a log file's structure (implies a built-in prompt; -p optional)
`;
