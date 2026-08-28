// Level detection: one shared default, overridable per file by format-map hints.

import type { LogHints } from './timestamps.js';

export const DEFAULT_LEVEL_RX = /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;

export function getLevelRegex(hints?: LogHints | null): RegExp {
  return hints?.levelRx ?? DEFAULT_LEVEL_RX;
}

export const LEVEL_FOLD: Record<string, string> = {
  WARNING: 'WARN', SEVERE: 'ERROR', CRIT: 'ERROR', CRITICAL: 'ERROR', ERR: 'ERROR',
  PANIC: 'FATAL', EMERG: 'FATAL', EMERGENCY: 'FATAL', ALERT: 'FATAL', FTL: 'FATAL',
  NOTICE: 'INFO', INF: 'INFO', VERBOSE: 'DEBUG', FINE: 'DEBUG', DBG: 'DEBUG',
  FINER: 'TRACE', FINEST: 'TRACE', TRC: 'TRACE', WRN: 'WARN',
};

export const EXTRA_LEVEL_TERMS = [
  'CRIT', 'CRITICAL', 'SEVERE', 'NOTICE', 'EMERG', 'EMERGENCY', 'ALERT',
  'PANIC', 'FINE', 'FINER', 'FINEST', 'VERBOSE', 'WRN', 'ERR', 'DBG', 'INF', 'FTL', 'TRC',
];

/** Match + normalize a line's level per the standard fold rules. */
export function matchLevel(line: string, hints?: LogHints | null): string | null {
  const rx = getLevelRegex(hints);
  const m = rx.exec(line);
  if (!m) return null;
  let level = m[1].toUpperCase();
  const fold = hints?.levelFold ?? null;
  if (fold && fold[level]) level = fold[level];
  else if (level === 'WARNING') level = 'WARN';
  return level;
}
