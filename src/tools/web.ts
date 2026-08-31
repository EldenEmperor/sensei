// web_fetch, web_search, web_browser and their shared helpers — ported from
// src\web.ps1. The HTML→text/link/DDG parsers are pure and unit-tested.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ToolRegistry } from './registry.js';

// --- shared: HTML → readable text + link extraction -------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', copy: '©', reg: '®', trade: '™',
};

export function htmlDecode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, ent: string) => {
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const cp = parseInt(ent.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (ent.startsWith('#')) {
      const cp = parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[ent.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  let t = html.replace(/<(script|style|noscript|nav|header|footer|aside|form|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/ul|\/ol)[^>]*>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = htmlDecode(t);
  t = t.replace(/[ \t]+/g, ' ');
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.join('\n');
}

/** Absolute, de-duplicated http(s) links found in the HTML, resolved vs baseUrl. */
export function extractLinks(html: string, baseUrl: string, max = 30): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["']/gi)) {
    const href = htmlDecode(m[1]).trim();
    if (!href || /^(javascript|mailto|tel):/.test(href)) continue;
    let abs = href;
    if (!/^https?:\/\//.test(href)) {
      try {
        abs = new URL(href, baseUrl).href;
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//.test(abs)) continue;
    if (!set.has(abs)) {
      set.add(abs);
      seen.push(abs);
      if (seen.length >= max) break;
    }
  }
  return seen;
}

/** Raw content + content-type → the tool result text. */
export function formatPage(content: string, contentType: string, url: string, isDom = false): string {
  const isHtml = isDom || /html/i.test(contentType) || /<html|<!doctype html/i.test(content);
  if (/json/i.test(contentType)) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  if (!isHtml) return content;
  let text = htmlToText(content);
  const links = extractLinks(content, url);
  if (links.length > 0) {
    text += `\n\n--- Links found (${links.length}) ---\n` + links.join('\n');
  }
  if (!text.trim()) return `(no readable text at ${url})`;
  return text;
}

// --- DuckDuckGo results parsing (brittle by nature — see web.ps1 note) ------

export interface DdgResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDdgResults(html: string, max = 8): DdgResult[] {
  const out: DdgResult[] = [];
  for (const m of html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = htmlDecode(m[1]);
    const um = href.match(/uddg=([^&]+)/);
    if (um) href = decodeURIComponent(um[1]);
    else if (href.startsWith('//')) href = 'https:' + href;
    const title = htmlDecode(m[2].replace(/<[^>]+>/g, '')).trim();
    if (title && /^https?:\/\//.test(href)) {
      out.push({ title, url: href, snippet: '' });
      if (out.length >= max) break;
    }
  }
  const snips: string[] = [];
  for (const m of html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    snips.push(htmlDecode(m[1].replace(/<[^>]+>/g, '')).trim());
  }
  for (let i = 0; i < out.length; i++) out[i].snippet = i < snips.length ? snips[i] : '';
  return out;
}

// --- HTTP + browser ---------------------------------------------------------

async function httpGet(url: string, timeoutMs = 30000, headers: Record<string, string> = {}) {
  const resp = await fetch(url, {
    headers: { 'user-agent': 'sensei/0.1.0', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  let body = await resp.text();
  if (body.length > 3 * 1024 * 1024) body = body.slice(0, 3 * 1024 * 1024);
  return {
    ok: resp.ok,
    status: resp.status,
    body,
    contentType: resp.headers.get('content-type') ?? '',
    finalUrl: resp.url || url,
  };
}

export function browserCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

export function findBrowser(platform: NodeJS.Platform = process.platform): string | null {
  for (const p of browserCandidates(platform)) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* skip */
    }
  }
  return null;
}

export function registerWebTools(registry: ToolRegistry): void {
  registry.register({
    name: 'web_fetch',
    readOnly: true,
    primaryArg: 'url',
    description:
      'Fetch an http(s) URL and return its content as readable text (HTML stripped, JSON pretty-printed), followed by the links found on the page so you can follow onward. Use to read documentation, referenced pages, and error-message lookups.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    handler: async (a) => {
      const url = String(a.url ?? '');
      if (!/^https?:\/\//.test(url)) return 'ERROR: only http(s) URLs are supported';
      try {
        const r = await httpGet(url);
        if (!r.ok) return `ERROR: HTTP ${r.status} from ${url}`;
        return formatPage(r.body, r.contentType, r.finalUrl);
      } catch (e) {
        if ((e as Error).name === 'TimeoutError') return `ERROR: fetch of ${url} timed out or was aborted`;
        return `ERROR: ${(e as Error).message}`;
      }
    },
  });

  registry.register({
    name: 'web_search',
    readOnly: true,
    primaryArg: 'query',
    description:
      'Search the web (DuckDuckGo) and return the top results as title + URL + snippet. Use to FIND sources when you do not already have a link; then web_fetch the promising ones.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top: { type: 'integer', description: 'How many results (default 8)' },
      },
      required: ['query'],
    },
    handler: async (a) => {
      const q = String(a.query ?? '');
      if (!q) return 'ERROR: query is required';
      const top = Math.max(1, Number(a.top ?? 8));
      const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
      try {
        const r = await httpGet(url, 30000, { accept: 'text/html' });
        if (!r.ok) return `ERROR: search returned HTTP ${r.status}`;
        const results = parseDdgResults(r.body, top);
        if (results.length === 0) {
          const raw = htmlToText(r.body);
          return `(no results parsed for '${q}' — DuckDuckGo may have changed its markup or rate-limited. Raw text follows.)\n` + raw.slice(0, 1500);
        }
        const out: string[] = [`[web_search '${q}' — top ${results.length}]`];
        results.forEach((res, i) => {
          out.push(`${i + 1}. ${res.title}\n   ${res.url}`);
          if (res.snippet) out.push(`   ${res.snippet}`);
        });
        return out.join('\n') + '\n';
      } catch (e) {
        if ((e as Error).name === 'TimeoutError') return 'ERROR: search timed out or was aborted';
        return `ERROR: ${(e as Error).message}`;
      }
    },
  });

  registry.register({
    name: 'web_browser',
    readOnly: true,
    primaryArg: 'url',
    description:
      'Render an http(s) page in a headless browser (Edge/Chrome) so JavaScript runs, then return the rendered text + links. Use when web_fetch returns little because the page needs JS. Optional screenshot=true saves a PNG for the USER to open (it is not shown to you — you read the text).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        screenshot: { type: 'boolean', description: 'Also save a PNG to ~/.sensei/screenshots (default false)' },
      },
      required: ['url'],
    },
    handler: async (a, ctx) => {
      const url = String(a.url ?? '');
      if (!/^https?:\/\//.test(url)) return 'ERROR: only http(s) URLs are supported';
      const browser = findBrowser();
      if (!browser) return 'ERROR: no headless browser found (Edge/Chrome). Use web_fetch instead for non-JS pages.';

      let shotNote = '';
      const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions'];
      if (a.screenshot) {
        const shotDir = path.join(ctx.configDir, 'screenshots');
        fs.mkdirSync(shotDir, { recursive: true });
        const shot = path.join(shotDir, `shot-${crypto.randomBytes(4).toString('hex')}.png`);
        args.push(`--screenshot=${shot}`, '--window-size=1280,1600', '--hide-scrollbars');
        shotNote = `\n[screenshot saved for you to open: ${shot}]`;
      }
      args.push('--dump-dom', url);

      return new Promise<string>((resolve) => {
        const p = spawn(browser, args, { windowsHide: true });
        let dom = '';
        let settled = false;
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (d: string) => (dom += d));
        p.stderr.resume(); // drain
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            p.kill();
          } catch {
            /* gone */
          }
          resolve(`ERROR: browser render of ${url} timed out (45s)`);
        }, 45000);
        p.on('error', (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(`ERROR: ${e.message}`);
        });
        p.on('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!dom.trim()) {
            resolve(`ERROR: browser returned no DOM for ${url}${shotNote}`);
            return;
          }
          if (dom.length > 3 * 1024 * 1024) dom = dom.slice(0, 3 * 1024 * 1024);
          resolve(formatPage(dom, 'text/html', url, true) + shotNote);
        });
      });
    },
  });
}
