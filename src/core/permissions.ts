// Permission gate: allow-rule grammar "tool" or "tool(pattern)" with
// PowerShell -like wildcard semantics (case-insensitive, * ? and [abc] classes).

import path from 'node:path';
import type { AllowRule } from './config.js';

/** Compile a PowerShell -like pattern to a RegExp (full match; case-insensitive
 *  unless caseSensitive — POSIX paths match case-sensitively). */
export function likePatternToRegex(pattern: string, caseSensitive = false): RegExp {
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
  return new RegExp(`^${rx}$`, caseSensitive ? 's' : 'is');
}

export function likeMatch(value: string, pattern: string, caseSensitive = false): boolean {
  return likePatternToRegex(pattern, caseSensitive).test(value);
}

/** Rule grammar: "tool" or "tool(pattern)". Pattern is tested against the
 *  tool's primary argument, raw and resolved. Tool names always match
 *  case-insensitively; on POSIX the resolved-path comparison is
 *  case-sensitive (the filesystem is). */
export function testAllowRule(
  rule: string,
  toolName: string,
  primaryValue?: string,
  resolvedValue?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const m = rule.match(/^([^(]+?)(?:\((.*)\))?$/);
  if (!m) return false;
  const namePat = m[1].trim();
  const argPat = m[2];
  if (!likeMatch(toolName, namePat)) return false;
  if (argPat === undefined || argPat === '') return true;
  if (primaryValue && likeMatch(primaryValue, argPat)) return true;
  if (resolvedValue && likeMatch(resolvedValue, argPat, platform !== 'win32')) return true;
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
  if (name === 'run_powershell' || name === 'bash') {
    const first = String(args['command'] ?? '')
      .trim()
      .split(/\s+/)[0];
    if (first) return `${name}(${first} *)`;
    return name;
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
  return rules.some((r) => testAllowRule(r.rule, name, primary, resolved, process.platform));
}

// --- acceptEdits mode --------------------------------------------------------

/** Tools acceptEdits auto-allows — file edits only, never shell/web. */
export const EDIT_TOOLS = ['write_file', 'edit_file', 'multi_edit'];

export function isPathInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  // the platform's own path rules, not the host's (testable cross-platform)
  const P = platform === 'win32' ? path.win32 : path.posix;
  const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const rel = P.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

/** acceptEdits: auto-allow file-edit tools whose resolved target is inside
 *  `boundary` (default cwd; --add-dir passes extra boundaries). */
export function acceptEditsAllows(
  name: string,
  primaryArg: string | undefined,
  args: Record<string, unknown>,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  boundary: string = cwd,
): boolean {
  if (!EDIT_TOOLS.includes(name)) return false;
  const { resolved } = getPrimaryArg(primaryArg, args, cwd);
  return resolved ? isPathInside(resolved, boundary, platform) : false;
}
