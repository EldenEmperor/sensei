// Timestamp knowledge, ported from src\logtools.ps1. Times are epoch millis
// (local-naive semantics match the PS variant: strings without an offset parse
// as local time). Hand parsers replace [datetime]::TryParseExact.

export interface TsCandidate {
  name: string;
  regex: RegExp;
  parse: string; // 'tryparse' | 'MMM d HH:mm:ss' | 'dd/MMM/yyyy:HH:mm:ss zzz' | 'epoch-ms' | 'epoch-s'
}

// iso8601/us-legacy/syslog are the always-on defaults; the rest only activate
// through a format map's hints — epoch patterns are too false-positive-prone
// to run against every file.
export const TS_CANDIDATES: TsCandidate[] = [
  { name: 'iso8601-tz', regex: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/, parse: 'tryparse' },
  { name: 'iso8601', regex: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?/, parse: 'tryparse' },
  { name: 'us-legacy', regex: /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/, parse: 'tryparse' },
  { name: 'syslog', regex: /^[A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}/, parse: 'MMM d HH:mm:ss' },
  { name: 'clf', regex: /\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}/, parse: 'dd/MMM/yyyy:HH:mm:ss zzz' },
  { name: 'epoch-ms', regex: /(?<![\d.])1[6-9]\d{11}(?![\d.])/, parse: 'epoch-ms' },
  { name: 'epoch-s', regex: /(?<![\d.])1[6-9]\d{8}(?![\d.])/, parse: 'epoch-s' },
];

/** The always-on default set, in the original priority order. */
export const DEFAULT_TS_REGEXES: TsCandidate[] = TS_CANDIDATES.filter((c) =>
  ['iso8601', 'us-legacy', 'syslog'].includes(c.name),
);

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Hints compiled from a cached format map (see formatMap.ts). */
export interface LogHints {
  tsMatchers?: { regex: RegExp; parse: string }[];
  jsonTsRx?: RegExp;
  jsonTsParse?: string;
  levelRx?: RegExp;
  levelFold?: Record<string, string>;
}

/** Parse a raw timestamp match according to a candidate's Parse spec. Returns epoch ms or null. */
export function convertTimestampValue(raw0: string, parse: string): number | null {
  const raw = raw0.replace(',', '.');
  switch (parse) {
    case 'epoch-s': {
      const n = Number(raw);
      return Number.isFinite(n) ? n * 1000 : null;
    }
    case 'epoch-ms': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'MMM d HH:mm:ss': {
      const m = raw.trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})$/);
      if (!m || !(m[1] in MONTHS)) return null;
      // no year in syslog — assume the current year, like TryParseExact did
      const d = new Date(new Date().getFullYear(), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
      return d.getTime();
    }
    case 'dd/MMM/yyyy:HH:mm:ss zzz': {
      const m = raw.match(/^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
      if (!m || !(m[2] in MONTHS)) return null;
      const utc = Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
      const offsetMin = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
      return utc - offsetMin * 60000;
    }
    default: {
      // 'tryparse' — V8 handles ISO (with/without offset), 'yyyy-MM-dd HH:mm:ss.fff'
      // and 'MM/dd/yyyy HH:mm:ss', all as local time when no offset is given.
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) return t;
      return convertTimestampValue(raw, 'MMM d HH:mm:ss');
    }
  }
}

/** First-match-wins timestamp for a line: learned hints first, then the builtin set. */
export function getLineTimestamp(line: string, hints?: LogHints | null): number | null {
  if (hints) {
    if (hints.jsonTsRx) {
      const m = hints.jsonTsRx.exec(line);
      if (m) {
        const t = convertTimestampValue(m[1], hints.jsonTsParse ?? 'tryparse');
        if (t !== null) return t;
      }
    }
    if (hints.tsMatchers) {
      for (const tm of hints.tsMatchers) {
        const m = tm.regex.exec(line);
        if (!m) continue;
        const t = convertTimestampValue(m[0], tm.parse);
        if (t !== null) return t;
      }
    }
  }
  for (const cand of DEFAULT_TS_REGEXES) {
    const m = cand.regex.exec(line);
    if (!m) continue;
    const t = convertTimestampValue(m[0], cand.parse);
    if (t !== null) return t;
  }
  return null;
}

/** Local-time formatter matching PS '{0:yyyy-MM-dd HH:mm:ss}'. */
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Local-time formatter matching PS '{0:MM-dd HH:mm}'. */
export function formatLocalShort(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
