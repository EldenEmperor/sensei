// log_investigate's engine: format detection + reusable format maps, ported
// from src\logtools.ps1. Maps are cached per file (~/.sensei/formats/) with the
// FULL fingerprint stored and re-validated on load, and are consumed as hints
// by the other log tools via getFormatHints — which never triggers an analysis.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EXTRA_LEVEL_TERMS, DEFAULT_LEVEL_RX, LEVEL_FOLD } from './levels.js';
import { getLogTemplate } from './template.js';
import {
  convertTimestampValue,
  TS_CANDIDATES,
  type LogHints,
} from './timestamps.js';

export const FORMAT_MAP_SCHEMA_VERSION = 1;

// --- file facts -------------------------------------------------------------

export interface FileFacts {
  bytes: number;
  lines: number;
  encoding: string;
  line_ending: string;
  max_line_chars: number;
  binary: boolean;
}

/** Byte-level facts from the first 64KB: encoding/BOM, NUL sniff, line endings. */
export function getFileFacts(p: string): FileFacts {
  const fd = fs.openSync(p, 'r');
  let n = 0;
  const buf = Buffer.alloc(65536);
  let bytes = 0;
  try {
    n = fs.readSync(fd, buf, 0, buf.length, 0);
    bytes = fs.fstatSync(fd).size;
  } finally {
    fs.closeSync(fd);
  }
  let encoding = 'ascii-compatible';
  if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) encoding = 'utf-8-bom';
  else if (n >= 2 && buf[0] === 0xff && buf[1] === 0xfe) encoding = 'utf-16le';
  else if (n >= 2 && buf[0] === 0xfe && buf[1] === 0xff) encoding = 'utf-16be';
  else {
    for (let i = 0; i < n; i++) {
      if (buf[i] >= 0x80) {
        encoding = 'utf-8';
        break;
      }
    }
  }
  let binary = false;
  let lineEnding = 'unknown';
  if (encoding !== 'utf-16le' && encoding !== 'utf-16be') {
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) {
        binary = true;
        break;
      }
    }
    let crlf = 0;
    let lf = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i] === 10) {
        if (i > 0 && buf[i - 1] === 13) crlf++;
        else lf++;
      }
    }
    lineEnding = crlf > 0 && lf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'none';
  }
  return { bytes, lines: 0, encoding, line_ending: lineEnding, max_line_chars: 0, binary };
}

// --- value typing -----------------------------------------------------------

export function getLogValueType(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '' || value === 'null') return 'null';
  if (/^1[6-9]\d{11}$/.test(value)) return 'timestamp'; // epoch-ms, before the generic int check
  if (/^1[6-9]\d{8}$/.test(value)) return 'timestamp'; // epoch-s
  if (/^-?\d{1,18}$/.test(value)) return 'int';
  if (/^-?\d+\.\d+$/.test(value)) return 'float';
  if (/^(true|false)$/i.test(value)) return 'bool';
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) return 'guid';
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(value)) return 'ip';
  for (const c of TS_CANDIDATES) {
    const m = c.regex.exec(value);
    if (m && m.index === 0 && m[0].length === value.length) return 'timestamp';
  }
  if (/^\d+(\.\d+)?(ms|s|m|h)$/.test(value)) return 'duration';
  if (/^https?:\/\//.test(value)) return 'url';
  if (/^([A-Za-z]:\\|\/)/.test(value)) return 'path';
  return 'string';
}

// --- family detection -------------------------------------------------------

export interface FamilyResult {
  family: string;
  confidence: number;
  familiesSeen: Record<string, number>;
  delimiter: string | null;
  header: string[] | null;
}

const APACHE_RX = /^\S+ \S+ \S+ \[\d{2}\/[A-Z][a-z]{2}\/\d{4}:/;
const KV_RX = /\b\w+=("[^"]*"|\S+)/g;
const SYSLOG_RX = TS_CANDIDATES.find((c) => c.name === 'syslog')!.regex;

export function getFormatFamily(sampleLines: string[]): FamilyResult {
  const lines = sampleLines.filter((l) => l && l.trim());
  const res: FamilyResult = { family: 'empty', confidence: 0, familiesSeen: {}, delimiter: null, header: null };
  if (lines.length === 0) return res;

  const fieldsHeader = lines.find((l) => l.startsWith('#Fields:'));
  if (fieldsHeader) {
    res.family = 'w3c-iis';
    res.confidence = 0.95;
    res.header = fieldsHeader.replace(/^#Fields:\s*/, '').split(/\s+/).filter(Boolean);
    res.familiesSeen = { 'w3c-iis': 1.0 };
    return res;
  }

  const counts: Record<string, number> = {};
  let jsonParses = 0;
  for (const l of lines) {
    const t = l.trim();
    let fam: string | null = null;
    if (t.startsWith('{') && t.endsWith('}')) {
      if (jsonParses < 200) {
        jsonParses++;
        try {
          JSON.parse(t);
          fam = 'json-lines';
        } catch {
          /* not json */
        }
      } else {
        fam = 'json-lines';
      }
    }
    if (!fam && APACHE_RX.test(l)) fam = 'apache-access';
    if (!fam && /^\w+=/.test(l) && (l.match(KV_RX)?.length ?? 0) >= 3) fam = 'logfmt';
    if (!fam && SYSLOG_RX.test(l)) fam = 'syslog';
    if (!fam) {
      for (const c of TS_CANDIDATES) {
        if (c.name === 'epoch-ms' || c.name === 'epoch-s') continue;
        if (c.regex.test(l)) {
          fam = 'timestamped-text';
          break;
        }
      }
    }
    if (!fam) fam = 'unstructured';
    counts[fam] = (counts[fam] ?? 0) + 1;
  }

  const total = lines.length;
  const seen: Record<string, number> = {};
  for (const k of Object.keys(counts)) seen[k] = Math.round((counts[k] / total) * 1000) / 1000;
  res.familiesSeen = seen;

  // csv/tsv: cross-line delimiter consistency, only when nothing structured dominates
  const structFrac = ((counts['json-lines'] ?? 0) + (counts['apache-access'] ?? 0) + (counts['logfmt'] ?? 0)) / total;
  if (structFrac < 0.5) {
    for (const delim of ['\t', ',']) {
      const dcounts = new Map<number, number>();
      for (const l of lines) {
        const n = l.split(delim).length - 1;
        dcounts.set(n, (dcounts.get(n) ?? 0) + 1);
      }
      let modalKey = -1;
      let modalVal = 0;
      for (const [k, v] of dcounts) {
        if (v > modalVal) {
          modalKey = k;
          modalVal = v;
        }
      }
      if (modalKey >= 2 && modalVal / total >= 0.9) {
        res.family = delim === '\t' ? 'tsv' : 'csv';
        res.confidence = Math.round((modalVal / total) * 100) / 100;
        res.delimiter = delim;
        seen[res.family] = Math.round((modalVal / total) * 1000) / 1000;
        if (total > 1) {
          const h = lines[0].split(delim);
          const r2 = lines[1].split(delim);
          const hAllStr = h.every((c) => getLogValueType(c) === 'string');
          const r2Typed = r2.some((c) => ['int', 'float', 'timestamp', 'guid', 'ip'].includes(getLogValueType(c)));
          if (hAllStr && r2Typed) res.header = h;
        }
        return res;
      }
    }
  }

  let winKey = 'unstructured';
  let winVal = 0;
  for (const k of Object.keys(counts)) {
    if (counts[k] > winVal) {
      winKey = k;
      winVal = counts[k];
    }
  }
  const frac = winVal / total;
  res.family = frac < 0.6 ? 'mixed' : winKey;
  res.confidence = Math.round(frac * 100) / 100;
  return res;
}

// --- field sampling ---------------------------------------------------------

interface FieldState {
  count: number;
  types: Record<string, number>;
  values: Set<string>;
  examples: string[];
  min: number | null;
  max: number | null;
}

const DEEP_KV_RX = /\b(\w+)=("([^"]*)"|[^\s,;\]]+)/g;

function addFieldSamples(
  state: Map<string, FieldState>,
  line: string,
  family: string,
  delimiter: string | null,
  header: string[] | null,
): boolean {
  const pairs: [string, string, string | null][] = [];
  if (family === 'json-lines') {
    const trim = line.trim();
    if (!(trim.startsWith('{') && trim.endsWith('}'))) return false;
    let obj: unknown;
    try {
      obj = JSON.parse(trim);
    } catch {
      return false;
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') pairs.push([k, Array.isArray(v) ? '[...]' : '{...}', Array.isArray(v) ? 'array' : 'object']);
      else if (v === null) pairs.push([k, '', 'null']);
      else pairs.push([k, String(v), null]);
    }
  } else if (family === 'csv' || family === 'tsv' || family === 'w3c-iis') {
    if (line.startsWith('#')) return false;
    const d = family === 'w3c-iis' ? ' ' : (delimiter ?? ',');
    const cells = line.split(d);
    for (let i = 0; i < cells.length; i++) {
      const name = header && i < header.length ? header[i] : `col${i}`;
      pairs.push([name, cells[i], null]);
    }
  } else {
    // logfmt and key=value tokens embedded in timestamped text
    for (const m of line.matchAll(DEEP_KV_RX)) {
      const v = m[3] !== undefined ? m[3] : m[2];
      pairs.push([m[1], v, null]);
    }
  }
  if (pairs.length === 0) return false;
  for (const [name, sv, forced] of pairs) {
    let f = state.get(name);
    if (!f) {
      if (state.size >= 100) continue;
      f = { count: 0, types: {}, values: new Set(), examples: [], min: null, max: null };
      state.set(name, f);
    }
    f.count++;
    const ty = forced ?? getLogValueType(sv);
    f.types[ty] = (f.types[ty] ?? 0) + 1;
    if (f.values.size < 5000) f.values.add(sv.length > 100 ? sv.slice(0, 100) : sv);
    if (f.examples.length < 3 && sv && !f.examples.includes(sv)) {
      f.examples.push(sv.length > 60 ? sv.slice(0, 60) : sv);
    }
    if (ty === 'int' || ty === 'float') {
      const d = Number(sv);
      if (Number.isFinite(d)) {
        if (f.min === null || d < f.min) f.min = d;
        if (f.max === null || d > f.max) f.max = d;
      }
    }
  }
  return true;
}

// --- the analyzer -----------------------------------------------------------

export interface FormatMap {
  schema_version: number;
  path: string;
  fingerprint: string;
  generated: string;
  sampled: boolean;
  file: FileFacts;
  format: {
    family: string;
    confidence: number;
    families_seen: Record<string, number>;
    delimiter: string | null;
    header: string[] | null;
    json_ts_field: string | null;
    json_ts_parse: string | null;
  };
  timestamps: {
    name: string;
    regex: string;
    parse: string;
    position: string | null;
    coverage_pct: number;
    example: string | null;
  }[];
  time_range: { first: string; last: string; ordered_pct: number } | null;
  levels: {
    position: string | null;
    vocabulary: Record<string, number>;
    extra_terms: string[];
    coverage_pct: number;
  };
  fields: {
    name: string;
    type: string;
    coverage_pct: number;
    cardinality: number;
    cardinality_capped: boolean;
    examples: string[];
    min?: number;
    max?: number;
  }[];
  templates: {
    distinct: number;
    capped: boolean;
    top: { template: string; count: number; level: string | null; example_line: number }[];
    rare: { template: string; count: number; level: string | null; example_line: number }[];
  };
  blocks: { continuation_pct: number; max_block_lines: number; example: string | null };
  notes: string[];
}

const EXTRA_LEVEL_RX = /(?:\[(\w{3,10})\]|"level"\s*:\s*"(\w+)"|\blevel=(\w+))/i;

/** One streaming pass: cheap work on every line, expensive field typing on a
 *  deterministic sample. Pure — no cache I/O beyond reading the file. */
export async function buildFormatMap(p: string): Promise<FormatMap> {
  const facts = getFileFacts(p);
  const map: FormatMap = {
    schema_version: FORMAT_MAP_SCHEMA_VERSION,
    path: p,
    fingerprint: '',
    generated: new Date().toISOString(),
    sampled: false,
    file: facts,
    format: { family: 'unstructured', confidence: 0, families_seen: {}, delimiter: null, header: null, json_ts_field: null, json_ts_parse: null },
    timestamps: [],
    time_range: null,
    levels: { position: null, vocabulary: {}, extra_terms: [], coverage_pct: 0 },
    fields: [],
    templates: { distinct: 0, capped: false, top: [], rare: [] },
    blocks: { continuation_pct: 0, max_block_lines: 0, example: null },
    notes: [],
  };
  if (facts.binary) {
    map.format.family = 'binary';
    return map;
  }
  if (facts.bytes === 0) {
    map.format.family = 'empty';
    return map;
  }

  const samplingOnly = facts.bytes > 200 * 1024 * 1024;
  const tsStats = new Map<string, { hits: number; example: string | null; position: string | null }>();
  for (const c of TS_CANDIDATES) tsStats.set(c.name, { hits: 0, example: null, position: null });
  const tmplCounts = new Map<string, number>();
  const tmplMeta = new Map<string, { level: string | null; line: number }>();
  const fieldState = new Map<string, FieldState>();
  const vocab: Record<string, number> = {};
  const extraVocab: Record<string, number> = {};
  const first1000: string[] = [];
  const tailRing: { no: number; line: string }[] = [];
  let family: string | null = null;
  let delimiter: string | null = null;
  let header: string[] | null = null;
  let total = 0;
  let maxLineChars = 0;
  let tmplOverflow = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let prevTs: number | null = null;
  let ordOk = 0;
  let ordCompares = 0;
  let tsLineCount = 0;
  let levelLines = 0;
  let contLines = 0;
  let curBlockLen = 0;
  let maxBlockLines = 0;
  let contExample: string | null = null;
  let bracketHits = 0;
  let bracketSampled = 0;
  let stride = 1;
  let deepSamples = 0;
  let charsFirst1000 = 0;

  const processDeep = (line: string): void => {
    deepSamples++;
    addFieldSamples(fieldState, line, family ?? 'unstructured', delimiter, header);
    const em = EXTRA_LEVEL_RX.exec(line);
    if (em) {
      const tok = (em[1] ?? em[2] ?? em[3] ?? '').toUpperCase();
      if (tok && EXTRA_LEVEL_TERMS.includes(tok)) extraVocab[tok] = (extraVocab[tok] ?? 0) + 1;
    }
  };

  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      total++;
      const len = line.length;
      if (len > maxLineChars) maxLineChars = len;
      const scan = len > 8192 ? line.slice(0, 8192) : line;

      // timestamp: first matching candidate wins the line
      let lineTs: number | null = null;
      for (const cand of TS_CANDIDATES) {
        const m = cand.regex.exec(scan);
        if (!m) continue;
        const dt = convertTimestampValue(m[0], cand.parse);
        if (dt === null) continue;
        lineTs = dt;
        const stat = tsStats.get(cand.name)!;
        stat.hits++;
        if (stat.example === null) {
          stat.example = m[0];
          stat.position = m.index === 0 ? 'prefix' : 'embedded';
        }
        break;
      }
      if (lineTs !== null) {
        if (firstTs === null) firstTs = lineTs;
        lastTs = lineTs;
        if (prevTs !== null) {
          ordCompares++;
          if (lineTs >= prevTs) ordOk++;
        }
        prevTs = lineTs;
        tsLineCount++;
        curBlockLen = 1;
      } else if (tsLineCount > 0) {
        contLines++;
        curBlockLen++;
        if (curBlockLen > maxBlockLines) maxBlockLines = curBlockLen;
        if (contExample === null && scan.trim()) {
          contExample = scan.length > 120 ? scan.slice(0, 120) : scan;
        }
      }

      // level vocabulary (builtin terms; extra terms come from the deep sample)
      let lineLevel: string | null = null;
      const lm = DEFAULT_LEVEL_RX.exec(scan);
      if (lm) {
        let lv = lm[1].toUpperCase();
        if (lv === 'WARNING') lv = 'WARN';
        vocab[lv] = (vocab[lv] ?? 0) + 1;
        levelLines++;
        lineLevel = lv;
        if (bracketSampled < 200) {
          bracketSampled++;
          if (lm.index > 0 && scan[lm.index - 1] === '[') bracketHits++;
        }
      }

      // deep-sample bookkeeping
      let deep = false;
      if (total <= 1000) {
        first1000.push(line);
        charsFirst1000 += len;
        deep = true; // deferred until family is known
      } else {
        if (total === 1001) {
          const fd = getFormatFamily(first1000);
          family = fd.family;
          delimiter = fd.delimiter;
          header = fd.header;
          map.format.confidence = fd.confidence;
          map.format.families_seen = fd.familiesSeen;
          const avg = Math.max(1, charsFirst1000 / 1000 + 2);
          const estTotal = Math.max(1000, facts.bytes / avg);
          stride = Math.max(1, Math.trunc(estTotal / 3000));
          for (const buffered of first1000) processDeep(buffered);
        }
        if (total % stride === 0) {
          deep = true;
          processDeep(line);
        }
        tailRing.push({ no: total, line });
        if (tailRing.length > 200) tailRing.shift();
      }

      // templates: every line normally, deep samples only for huge files
      if (!samplingOnly || deep || total <= 1000) {
        const tmpl = getLogTemplate(scan);
        if (tmpl) {
          if (tmplCounts.has(tmpl)) tmplCounts.set(tmpl, tmplCounts.get(tmpl)! + 1);
          else if (tmplCounts.size < 20000) {
            tmplCounts.set(tmpl, 1);
            tmplMeta.set(tmpl, { level: lineLevel, line: total });
          } else tmplOverflow++;
        }
      }
    }
  } finally {
    rl.close();
  }

  if (total === 0) {
    map.format.family = 'empty';
    return map;
  }
  if (total <= 1000) {
    const fd = getFormatFamily(first1000);
    family = fd.family;
    delimiter = fd.delimiter;
    header = fd.header;
    map.format.confidence = fd.confidence;
    map.format.families_seen = fd.familiesSeen;
    for (const buffered of first1000) processDeep(buffered);
  } else {
    for (const entry of tailRing) {
      if (entry.no % stride !== 0) processDeep(entry.line);
    }
  }

  map.file.lines = total;
  map.file.max_line_chars = maxLineChars;
  map.format.family = family ?? 'unstructured';
  map.format.delimiter = delimiter === '\t' ? '\\t' : delimiter;
  map.format.header = header;
  if (samplingOnly) {
    map.sampled = true;
    map.notes.push(`file over 200MB — template counts are extrapolated from a 1-in-${stride} sample`);
  }

  // timestamps: only styles with meaningful coverage
  const minHits = Math.max(2, Math.trunc(total * 0.01));
  const tsOut: FormatMap['timestamps'] = [];
  for (const c of TS_CANDIDATES) {
    const s = tsStats.get(c.name)!;
    if (s.hits < minHits && !(s.hits > 0 && tsLineCount === s.hits)) continue;
    tsOut.push({
      name: c.name,
      regex: c.regex.source,
      parse: c.parse,
      position: s.position,
      coverage_pct: Math.round((1000 * s.hits) / total) / 10,
      example: s.example,
    });
  }
  tsOut.sort((a, b) => b.coverage_pct - a.coverage_pct);
  map.timestamps = tsOut;
  if (firstTs !== null && lastTs !== null) {
    map.time_range = {
      first: new Date(firstTs).toISOString(),
      last: new Date(lastTs).toISOString(),
      ordered_pct: ordCompares > 0 ? Math.round((1000 * ordOk) / ordCompares) / 10 : 100,
    };
  }
  if (map.timestamps.length > 1) {
    const second = map.timestamps[1];
    map.notes.push(`second timestamp style '${second.name}' on ${second.coverage_pct}% of lines`);
  }

  // levels
  const vocabOrdered: Record<string, number> = {};
  for (const [k, v] of Object.entries(vocab).sort((a, b) => b[1] - a[1])) vocabOrdered[k] = v;
  for (const [k, v] of Object.entries(extraVocab).sort((a, b) => b[1] - a[1])) {
    if (!(k in vocabOrdered)) vocabOrdered[k] = v;
  }
  map.levels.vocabulary = vocabOrdered;
  map.levels.extra_terms = Object.keys(extraVocab);
  map.levels.coverage_pct = Math.round((1000 * levelLines) / total) / 10;
  map.levels.position =
    family === 'json-lines' || family === 'logfmt'
      ? 'field:level'
      : (family === 'csv' || family === 'tsv' || family === 'w3c-iis') && header?.includes('level')
        ? `column:${header.indexOf('level')}`
        : bracketSampled > 0 && bracketHits / bracketSampled > 0.5
          ? 'bracketed'
          : levelLines > 0
            ? 'bare'
            : null;

  // fields
  const fieldsOut: FormatMap['fields'] = [];
  for (const [name, f] of [...fieldState.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const typeVotes = Object.entries(f.types)
      .filter(([k]) => k !== 'null')
      .sort((a, b) => b[1] - a[1]);
    const ftype =
      typeVotes.length === 0
        ? 'null'
        : typeVotes.length > 1 && typeVotes[1][1] >= 0.25 * f.count
          ? 'mixed'
          : typeVotes[0][0];
    const out: FormatMap['fields'][number] = {
      name,
      type: ftype,
      coverage_pct: Math.round((1000 * f.count) / Math.max(1, deepSamples)) / 10,
      cardinality: f.values.size,
      cardinality_capped: f.values.size >= 5000,
      examples: f.examples,
    };
    if ((ftype === 'int' || ftype === 'float') && f.min !== null) {
      out.min = f.min;
      out.max = f.max ?? f.min;
    }
    fieldsOut.push(out);
  }
  map.fields = fieldsOut;

  // json timestamp field (for a fast hint path)
  if (family === 'json-lines') {
    const tsFields = map.fields.filter((f) => f.type === 'timestamp');
    const preferred = tsFields.find((f) => ['time', 'ts', 'timestamp', '@timestamp', 'datetime', 'date'].includes(f.name));
    const tsField = preferred ?? tsFields[0];
    if (tsField) {
      map.format.json_ts_field = tsField.name;
      const ex = tsField.examples[0] ?? '';
      map.format.json_ts_parse = /^1[6-9]\d{11}$/.test(ex) ? 'epoch-ms' : /^1[6-9]\d{8}$/.test(ex) ? 'epoch-s' : 'tryparse';
    }
  }

  // templates
  const mult = samplingOnly ? stride : 1;
  map.templates.distinct = tmplCounts.size;
  map.templates.capped = tmplOverflow > 0;
  if (tmplOverflow > 0) map.notes.push(`template catalog capped at 20000 distinct entries (${tmplOverflow} lines uncounted)`);
  const sorted = [...tmplCounts.entries()].sort((a, b) => b[1] - a[1]);
  map.templates.top = sorted.slice(0, 15).map(([template, count]) => {
    const meta = tmplMeta.get(template)!;
    return { template, count: count * mult, level: meta.level, example_line: meta.line };
  });
  const rareMax = Math.max(1, Math.floor(total / 100000));
  const levelPri: Record<string, number> = { FATAL: 0, ERROR: 1, WARN: 2 };
  const rare = [...tmplCounts.entries()]
    .filter(([, count]) => count <= rareMax)
    .sort((a, b) => {
      const pa = levelPri[tmplMeta.get(a[0])!.level ?? ''] ?? 3;
      const pb = levelPri[tmplMeta.get(b[0])!.level ?? ''] ?? 3;
      if (pa !== pb) return pa - pb;
      return a[1] - b[1];
    })
    .slice(0, 10);
  map.templates.rare = rare.map(([template, count]) => {
    const meta = tmplMeta.get(template)!;
    return { template, count: count * mult, level: meta.level, example_line: meta.line };
  });

  // multi-line blocks
  map.blocks.continuation_pct = Math.round((1000 * contLines) / total) / 10;
  map.blocks.max_block_lines = maxBlockLines;
  map.blocks.example = contExample;
  if (contLines > 0) {
    map.notes.push(
      `multi-line blocks present: ${map.blocks.continuation_pct}% continuation lines, up to ${maxBlockLines} lines per block`,
    );
  }
  if (map.time_range && map.time_range.ordered_pct < 99) {
    map.notes.push(`only ${map.time_range.ordered_pct}% of lines are time-ordered — treat time-range slicing with care`);
  }
  return map;
}

// --- cache + hints ----------------------------------------------------------

export function formatMapPathFor(resolvedPath: string, configDir: string): { file: string; fingerprint: string } {
  const st = fs.statSync(resolvedPath);
  const fp = `${st.size}-${Math.trunc(st.mtimeMs)}`;
  const hash = crypto
    .createHash('sha1')
    .update(`${resolvedPath}|${fp}|v${FORMAT_MAP_SCHEMA_VERSION}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return { file: path.join(configDir, 'formats', `${hash}.json`), fingerprint: fp };
}

export interface FormatMapResult {
  map: FormatMap;
  cached: boolean;
}

/** Cache orchestrator. ifCached never analyzes (used by the hints path).
 *  The stored fingerprint is validated IN FULL against the file on disk. */
export async function getFormatMap(
  p: string,
  configDir: string,
  opts: { refresh?: boolean; ifCached?: boolean } = {},
): Promise<FormatMapResult | null> {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  const loc = formatMapPathFor(p, configDir);
  if (!opts.refresh && fs.existsSync(loc.file)) {
    try {
      const map = JSON.parse(fs.readFileSync(loc.file, 'utf8')) as FormatMap;
      if (String(map.fingerprint) === loc.fingerprint && Number(map.schema_version) === FORMAT_MAP_SCHEMA_VERSION) {
        return { map, cached: true };
      }
    } catch {
      /* unreadable cache — rebuild */
    }
  }
  if (opts.ifCached) return null;
  const map = await buildFormatMap(p);
  map.fingerprint = loc.fingerprint;
  const dir = path.dirname(loc.file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(loc.file, JSON.stringify(map, null, 1), 'utf8');
  const all = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  if (all.length > 50) {
    for (const e of all.slice(0, all.length - 50)) {
      try {
        fs.unlinkSync(path.join(dir, e.n));
      } catch {
        /* best effort */
      }
    }
  }
  return { map, cached: false };
}

const hintsCache = new Map<string, LogHints>();

/** Cheap accessor the other log tools call once per file: null when no fresh
 *  cached map exists (behavior then identical to before). Never analyzes. */
export function getFormatHints(p: string, configDir: string): LogHints | null {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    const loc = formatMapPathFor(p, configDir);
    if (!fs.existsSync(loc.file)) return null;
    const key = `${p}|${loc.fingerprint}`;
    const memo = hintsCache.get(key);
    if (memo) return memo;
    let map: FormatMap;
    try {
      map = JSON.parse(fs.readFileSync(loc.file, 'utf8')) as FormatMap;
    } catch {
      return null;
    }
    if (String(map.fingerprint) !== loc.fingerprint || Number(map.schema_version) !== FORMAT_MAP_SCHEMA_VERSION) {
      return null;
    }
    const hints: LogHints = {};
    const builtin = ['iso8601', 'us-legacy', 'syslog'];
    const tm: { regex: RegExp; parse: string }[] = [];
    for (const t of map.timestamps ?? []) {
      if (!t || builtin.includes(t.name)) continue;
      try {
        tm.push({ regex: new RegExp(t.regex), parse: t.parse });
      } catch {
        /* skip malformed */
      }
    }
    if (tm.length > 0) hints.tsMatchers = tm;
    if (map.format.json_ts_field) {
      hints.jsonTsRx = new RegExp(`"${map.format.json_ts_field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"?([^",}\\s]+)`);
      hints.jsonTsParse = map.format.json_ts_parse ?? 'tryparse';
    }
    const extras = (map.levels.extra_terms ?? []).filter(Boolean);
    if (extras.length > 0) {
      const alts = ['FATAL', 'ERROR', 'WARN(?:ING)?', 'INFO', 'DEBUG', 'TRACE']
        .concat(extras.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('|');
      hints.levelRx = new RegExp(`\\b(${alts})\\b`, 'i');
    }
    if (!hints.tsMatchers && !hints.jsonTsRx && !hints.levelRx) return null; // map adds nothing beyond the defaults
    hints.levelFold = LEVEL_FOLD;
    hintsCache.set(key, hints);
    return hints;
  } catch {
    return null;
  }
}

// --- summary rendering ------------------------------------------------------

const n0 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });
const n1 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Human/model-readable rendering of a format map. Stays far below the 30k
 *  tool-output cap: top 15 templates, 10 rare, 20 fields, trimmed examples. */
export function formatMapSummary(map: FormatMap, cached: boolean): string {
  const out: string[] = [];
  const cachedTag = cached ? '  (cached — refresh=true to re-analyze)' : '';
  out.push(`[log_investigate — ${map.path}]${cachedTag}`);
  if (map.format.family === 'binary') {
    out.push('format: binary (NUL bytes in the first 64KB) — not a text log; the log tools cannot parse this file');
    return out.join('\n') + '\n';
  }
  if (map.format.family === 'empty') {
    out.push('format: empty file (0 lines)');
    return out.join('\n') + '\n';
  }
  const f = map.file;
  out.push(
    `file: ${n1(f.bytes / 1048576)} MB, ${n0(f.lines)} lines, ${f.encoding}, ${f.line_ending} line endings, longest line ${n0(f.max_line_chars)} chars`,
  );
  let fmtLine = `format: ${map.format.family} (${Math.trunc(100 * map.format.confidence)}% confidence)`;
  if (map.format.delimiter) fmtLine += `, delimiter '${map.format.delimiter}'`;
  out.push(fmtLine);
  if (map.format.family === 'mixed' && map.format.families_seen) {
    const mixParts = Object.entries(map.format.families_seen).map(([k, v]) => `${k} ${Math.trunc(100 * v)}%`);
    out.push('  families seen: ' + mixParts.join(', '));
  }
  if (map.format.header) out.push('columns: ' + map.format.header.join(', '));
  if (map.timestamps.length > 0) {
    out.push('timestamp styles:');
    for (const t of map.timestamps) {
      out.push(
        `  ${t.name.padEnd(11)} ${(t.position ?? '?').padEnd(9)} ${String(n1(t.coverage_pct)).padStart(5)}%  e.g. ${t.example}`,
      );
    }
  } else {
    out.push('timestamp styles: none detected');
  }
  if (map.format.json_ts_field) {
    out.push(`  json timestamp field: "${map.format.json_ts_field}" (${map.format.json_ts_parse})`);
  }
  if (map.time_range) {
    out.push(`time range: ${map.time_range.first} → ${map.time_range.last}  (${map.time_range.ordered_pct}% time-ordered)`);
  }
  const lv = map.levels;
  const vocabKeys = Object.keys(lv.vocabulary);
  if (vocabKeys.length > 0) {
    const lvParts = vocabKeys.map((k) => `${k}: ${lv.vocabulary[k]}`);
    let lvLine = `levels (${lv.position}, ${lv.coverage_pct}% of lines): ` + lvParts.join(' | ');
    if (lv.extra_terms.length > 0) lvLine += `   [extra terms beyond the default set: ${lv.extra_terms.join(', ')}]`;
    out.push(lvLine);
  } else {
    out.push('levels: none detected');
  }
  if (map.fields.length > 0) {
    out.push('fields (from sampled records):');
    for (const fd of map.fields.slice(0, 20)) {
      let line = `  ${fd.name.padEnd(18)} ${fd.type.padEnd(9)} ${String(n1(fd.coverage_pct)).padStart(5)}%  card ${fd.cardinality}${fd.cardinality_capped ? '+' : ''}`;
      if (fd.examples.length > 0) line += '  e.g. ' + fd.examples.slice(0, 2).join(', ');
      if (fd.min !== undefined) line += `  range ${fd.min}..${fd.max}`;
      out.push(line);
    }
    if (map.fields.length > 20) out.push(`  … and ${map.fields.length - 20} more fields`);
  }
  out.push(`templates: ${map.templates.distinct} distinct${map.templates.capped ? ' (capped)' : ''}`);
  for (const t of map.templates.top) {
    const txt = t.template.length > 120 ? t.template.slice(0, 117) + '…' : t.template;
    out.push(`  ${String(t.count).padStart(8)} × ${txt}`);
  }
  if (map.templates.rare.length > 0) {
    out.push('RARE / UNIQUE EVENTS:');
    for (const t of map.templates.rare) {
      const txt = t.template.length > 120 ? t.template.slice(0, 117) + '…' : t.template;
      out.push(`  ${String(t.count).padStart(4)} × (line ${t.example_line}) ${txt}`);
    }
  }
  if (map.blocks.max_block_lines > 1) {
    out.push(
      `multi-line: ${map.blocks.continuation_pct}% continuation lines, blocks up to ${map.blocks.max_block_lines} lines (stack traces or wrapped output)`,
    );
  }
  if (map.notes.length > 0) {
    out.push('notes:');
    for (const n of map.notes) out.push(`  - ${n}`);
  }
  out.push("hint: log_stats, log_slice, log_timeline and log_trace now understand this file's timestamps and level vocabulary.");
  return out.join('\n') + '\n';
}
