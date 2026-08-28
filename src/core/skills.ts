// Skills, ported from src\skills.ps1: packaged instruction sets in
// .sensei\skills\<name>\SKILL.md (project) or ~/.sensei/skills/<name>/ (user).
// The model discovers them through the `skill` tool; users invoke them as
// /<name>. Project shadows user on collisions.

import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistry } from '../tools/registry.js';

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
  path: string;
  source: 'project' | 'user';
}

export function parseSkillFile(p: string): { name: string | null; description: string; body: string } {
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  let name: string | null = null;
  let description = '';
  let bodyStart = 0;
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
      const nm = lines[i].match(/^name:\s*(.+)$/);
      const dm = lines[i].match(/^description:\s*(.+)$/);
      if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
      else if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  const body = bodyStart < lines.length ? lines.slice(bodyStart).join('\n').trim() : '';
  return { name, description, body };
}

export function getSkills(cwd: string, configDir: string): SkillMeta[] {
  const skills: SkillMeta[] = [];
  const seen = new Set<string>();
  const sources: { dir: string; source: 'project' | 'user' }[] = [
    { dir: path.join(cwd, '.sensei', 'skills'), source: 'project' },
    { dir: path.join(configDir, 'skills'), source: 'user' },
  ];
  for (const src of sources) {
    if (!fs.existsSync(src.dir)) continue;
    for (const entry of fs.readdirSync(src.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(src.dir, entry.name);
      const skillPath = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      let meta;
      try {
        meta = parseSkillFile(skillPath);
      } catch {
        continue;
      }
      const name = meta.name ?? entry.name;
      const key = name.toLowerCase();
      if (seen.has(key)) continue; // project scanned first → wins
      seen.add(key);
      skills.push({ name, description: meta.description, dir, path: skillPath, source: src.source });
    }
  }
  return skills;
}

function skillBodyPrompt(s: SkillMeta): string {
  const body = parseSkillFile(s.path).body;
  return `# Skill: ${s.name}\n(Supporting files for this skill live in ${s.dir} — reference them by full path; scripts there can be run with run_powershell.)\n\n${body}`;
}

/** The prompt submitted when a user invokes /<skillname> args. */
export function getSkillPrompt(s: SkillMeta, args = ''): string {
  const parsed = parseSkillFile(s.path);
  const hadPlaceholder = /\$ARGUMENTS/.test(parsed.body);
  const body = parsed.body.replace(/\$ARGUMENTS/g, args);
  let p = `# Skill: ${s.name}\n(Supporting files for this skill live in ${s.dir} — reference them by full path; scripts there can be run with run_powershell.)\n\n${body}`;
  if (args && !hadPlaceholder) p += `\n\nUser input: ${args}`;
  return p;
}

/** (Re)build the `skill` tool from the current skill set. Cheap — called at
 *  startup and at each turn start so mid-session skill creation is picked up. */
export function registerSkillTool(registry: ToolRegistry, cwd: string, configDir: string): void {
  const skills = getSkills(cwd, configDir);
  if (skills.length === 0) {
    registry.remove('skill');
    return;
  }
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  registry.register({
    name: 'skill',
    readOnly: true,
    description: `Load a skill — packaged instructions for a specialized task. Invoke it when the user's request matches a skill's description, BEFORE attempting the task yourself. Available skills:\n${list}`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name, exactly as listed' } },
      required: ['name'],
    },
    handler: (a, ctx) => {
      const current = getSkills(ctx.cwd, ctx.configDir);
      const s = current.find((x) => x.name === String(a.name));
      if (!s) {
        return `ERROR: no skill named '${a.name}' — available: ${current.map((x) => x.name).join(', ')}`;
      }
      return skillBodyPrompt(s);
    },
  });
}
