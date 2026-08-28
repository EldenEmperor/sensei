// Permission gate: allow-rule grammar "tool" or "tool(pattern)" with
// PowerShell -like wildcard semantics (case-insensitive, * ? and [abc] classes).

import path from 'node:path';
import type { AllowRule } from './config.js';

/** Compile a PowerShell -like pattern to a RegExp (case-insensitive full match). */
export function likePatternToRegex(pattern: string): RegExp {
  let rx = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') rx += '.*';
    else if (c === '?') rx += '.';
    else if (c === '[') {
      // character class: consume through the closing ]
      const end = pattern.indexOf(']', i + 1);
      if (end > i) {
        rx += '[' + pattern.slice(i + 1, end).replace(/\\/g, '\\\\') + ']';
        i = end;
      } else {
        rx += '\\[';
      }
    } else if (c === '`' && i + 1 < pattern.length) {
      // PS escape char
      rx += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    } else {
      rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${rx}$`, 'is');
}

export function likeMatch(value: string, pattern: string): boolean {
  return likePatternToRegex(pattern).test(value);
}

/** Rule grammar: "tool" or "tool(pattern)". Pattern is tested against the
 *  tool's primary argument, raw and resolved. */
export function testAllowRule(
  rule: string,
  toolName: string,
  primaryValue?: string,
  resolvedValue?: string,
): boolean {
  const m = rule.match(/^([^(]+?)(?:\((.*)\))?$/);
  if (!m) return false;
  const namePat = m[1].trim();
  const argPat = m[2];
  if (!likeMatch(toolName, namePat)) return false;
  if (argPat === undefined || argPat === '') return true;
  if (primaryValue && likeMatch(primaryValue, argPat)) return true;
  if (resolvedValue && likeMatch(resolvedValue, argPat)) return true;
  return false;
}

export function resolveSenseiPath(p: string, cwd: string): string {
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(cwd, p);
}

export function getPrimaryArg(
  primaryArg: string | undefined,
  args: Record<string, unknown>,
  cwd: string,
): { primary?: string; resolved?: string } {
  if (!primaryArg || args[primaryArg] === undefined || args[primaryArg] === null) return {};
  const primary = String(args[primaryArg]);
  let resolved: string | undefined;
  if (primaryArg === 'path' && primary) {
    try {
      resolved = resolveSenseiPath(primary, cwd);
    } catch {
      /* keep undefined */
    }
  }
  return { primary, resolved };
}

/** The rule the [p]ersist option writes for this tool call. */
export function persistRuleFor(
  name: string,
  primaryArg: string | undefined,
  args: Record<string, unknown>,
  cwd: string,
): string {
  if (name === 'run_powershell') {
    const first = String(args['command'] ?? '')
      .trim()
      .split(/\s+/)[0];
    if (first) return `run_powershell(${first} *)`;
    return 'run_powershell';
  }
  if (primaryArg === 'path') {
    const { resolved } = getPrimaryArg(primaryArg, args, cwd);
    if (resolved) return `${name}(${resolved})`;
  }
  return name;
}

export function matchesAllowlist(
  rules: AllowRule[],
  name: string,
  primaryArg: string | undefined,
  args: Record<string, unknown>,
  cwd: string,
): boolean {
  const { primary, resolved } = getPrimaryArg(primaryArg, args, cwd);
  return rules.some((r) => testAllowRule(r.rule, name, primary, resolved));
}
