// Normalize a log line into a template so repeats group together.

import { DEFAULT_TS_REGEXES } from './timestamps.js';

const TS_REGEXES_G = DEFAULT_TS_REGEXES.map((c) => new RegExp(c.regex.source, 'g'));

export function getLogTemplate(line: string): string {
  let t = line;
  for (const rx of TS_REGEXES_G) t = t.replace(rx, '<ts>');
  t = t.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<guid>');
  t = t.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>');
  t = t.replace(/"[^"]{1,200}"/g, '<q>');
  t = t.replace(/(\b\w+)=([^\s,;\]]+)/g, '$1=<v>');
  t = t.replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>');
  t = t.replace(/\d+/g, '<n>');
  return t.trim();
}
