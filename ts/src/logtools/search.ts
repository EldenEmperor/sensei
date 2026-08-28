// log_search — semantic search over a log's error/warn templates via local
// Ollama embeddings. Local mode only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSenseiPath } from '../core/permissions.js';
import type { ToolContext, ToolRegistry } from '../tools/registry.js';
import { getBaselineData } from './baseline.js';

export type EmbeddingsProvider = (inputs: string[], ctx: ToolContext) => Promise<number[][]>;

let embeddingsOverride: EmbeddingsProvider | null = null;

/** Tests inject a fake provider here (mirrors smoke.ps1 redefining Get-SenseiEmbeddings). */
export function setEmbeddingsProvider(fn: EmbeddingsProvider | null): void {
  embeddingsOverride = fn;
}

async function getEmbeddings(inputs: string[], ctx: ToolContext): Promise<number[][]> {
  if (embeddingsOverride) return embeddingsOverride(inputs, ctx);
  const url = String(ctx.config.local_base_url).replace(/\/+$/, '') + '/embeddings';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ollama' },
    body: JSON.stringify({ model: String(ctx.config.embed_model), input: inputs }),
  });
  if (resp.status !== 200) {
    throw new Error(`embeddings endpoint returned ${resp.status}: ${await resp.text()}`);
  }
  const parsed = (await resp.json()) as { data: { embedding: number[] }[] };
  return parsed.data.map((d) => d.embedding);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const n3 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function registerLogSearch(registry: ToolRegistry): void {
  registry.register({
    name: 'log_search',
    readOnly: true,
    primaryArg: 'path',
    description:
      'Semantic search over a log by MEANING (not regex): ranks the log\'s distinct error/warn templates by similarity to a natural-language query, e.g. "memory pressure" or "auth failures". Local mode only (uses your Ollama embedding model).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        query: { type: 'string', description: 'What to look for, in plain language' },
        top: { type: 'integer', description: 'How many matches to return (default 10)' },
      },
      required: ['path', 'query'],
    },
    handler: async (a, ctx) => {
      if (!ctx.local) {
        return 'ERROR: log_search needs local embeddings — start sensei with --local (Ollama + an embedding model).';
      }
      const p = resolveSenseiPath(String(a.path), ctx.cwd);
      try {
        if (!fs.statSync(p).isFile()) return `ERROR: file not found: ${p}`;
      } catch {
        return `ERROR: file not found: ${p}`;
      }
      const top = Math.max(1, Number(a.top ?? 10));
      const data = await getBaselineData(p, ctx);
      let templates = Object.keys(data.templates);
      if (templates.length === 0) return 'no error/warn templates to search in this log';
      templates = templates.sort((x, y) => data.templates[y] - data.templates[x]).slice(0, 200);

      const cacheDir = path.join(ctx.configDir, 'embed-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const st = fs.statSync(p);
      const fp = `${st.size}-${Math.trunc(st.mtimeMs)}-${ctx.config.embed_model}`;
      const hash = crypto.createHash('sha1').update(`${p}|${fp}`, 'utf8').digest('hex').slice(0, 16);
      const cacheFile = path.join(cacheDir, `${hash}.json`);

      let vectors: number[][] | null = null;
      if (fs.existsSync(cacheFile)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { templates: string[]; vectors: number[][] };
          if (cached.templates.length === templates.length) vectors = cached.vectors;
        } catch {
          vectors = null;
        }
      }
      let qVec: number[];
      try {
        if (!vectors) {
          vectors = await getEmbeddings(templates, ctx);
          fs.writeFileSync(cacheFile, JSON.stringify({ templates, vectors }), 'utf8');
        }
        qVec = (await getEmbeddings([String(a.query)], ctx))[0];
      } catch (e) {
        return `ERROR: ${(e as Error).message}\nIs Ollama running with '${ctx.config.embed_model}' pulled? (ollama pull ${ctx.config.embed_model})`;
      }
      const ranked = templates
        .map((t, i) => ({ template: t, score: cosine(qVec, vectors![i]), count: data.templates[t] }))
        .sort((x, y) => y.score - x.score)
        .slice(0, top);
      const out: string[] = [];
      out.push(`[log_search '${a.query}' — top ${top} of ${templates.length} templates]`);
      for (const r of ranked) out.push(`  ${n3(r.score)}  [${r.count}×] ${r.template}`);
      return out.join('\n') + '\n';
    },
  });
}
