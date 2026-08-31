// Custom subagent definitions: .sensei/agents/<name>.md (project) and
// ~/.sensei/agents/<name>.md (user); project shadows user by name. The body
// is the subagent's system prompt; frontmatter carries metadata:
//
//   ---
//   name: log-triager
//   description: triages a log file and reports the top issues
//   tools: read_file, grep, log_stats, log_slice     (optional allowlist)
//   model: claude-haiku-4-5                          (optional override)
//   ---

import fs from 'node:fs';
import path from 'node:path';

export interface AgentDef {
  name: string;
  description: string;
  /** Tool names this agent may use; null = every tool a subagent gets. */
  tools: string[] | null;
  /** Model override; null = the session's model. */
  model: string | null;
  /** The agent's system prompt (frontmatter stripped). */
  prompt: string;
  path: string;
  source: 'project' | 'user';
}

export function parseAgentFile(file: string, source: AgentDef['source']): AgentDef | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const fallback = path.basename(file, '.md');
  let name = fallback;
  let description = '';
  let tools: string[] | null = null;
  let model: string | null = null;
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === 'name' && val) name = val;
      else if (key === 'description') description = val;
      else if (key === 'model' && val) model = val;
      else if (key === 'tools' && val) {
        tools = val
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        if (tools.length === 0) tools = null;
      }
    }
  }
  const prompt = body.trim();
  if (!prompt) return null;
  return { name, description, tools, model, prompt, path: file, source };
}

/** Project agents first (shadowing user agents by name). */
export function getAgentDefs(cwd: string, configDir: string): AgentDef[] {
  const out: AgentDef[] = [];
  const seen = new Set<string>();
  const dirs: { dir: string; source: AgentDef['source'] }[] = [
    { dir: path.join(cwd, '.sensei', 'agents'), source: 'project' },
    { dir: path.join(configDir, 'agents'), source: 'user' },
  ];
  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of entries.sort()) {
      const def = parseAgentFile(path.join(dir, f), source);
      if (!def) continue;
      const key = def.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(def);
    }
  }
  return out;
}
