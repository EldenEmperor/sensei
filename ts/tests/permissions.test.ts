import { describe, expect, it } from 'vitest';
import { likeMatch, persistRuleFor, testAllowRule } from '../src/core/permissions.js';

describe('PS -like wildcard semantics', () => {
  it('matches * across anything, case-insensitively', () => {
    expect(likeMatch('run_powershell', 'run_*')).toBe(true);
    expect(likeMatch('RUN_POWERSHELL', 'run_*')).toBe(true);
    expect(likeMatch('read_file', 'run_*')).toBe(false);
  });
  it('? matches exactly one character', () => {
    expect(likeMatch('a1c', 'a?c')).toBe(true);
    expect(likeMatch('ac', 'a?c')).toBe(false);
  });
  it('[abc] character classes work', () => {
    expect(likeMatch('cat', 'c[aeiou]t')).toBe(true);
    expect(likeMatch('cxt', 'c[aeiou]t')).toBe(false);
  });
  it('regex metacharacters in patterns are literal', () => {
    expect(likeMatch('a.b', 'a.b')).toBe(true);
    expect(likeMatch('axb', 'a.b')).toBe(false);
    expect(likeMatch('C:\\logs\\app.log', 'C:\\logs\\*')).toBe(true);
  });
});

describe('allow-rule grammar', () => {
  it('bare tool name matches any args', () => {
    expect(testAllowRule('glob', 'glob', 'x')).toBe(true);
    expect(testAllowRule('glob', 'grep', 'x')).toBe(false);
  });
  it('tool(pattern) tests primary and resolved values', () => {
    expect(testAllowRule('run_powershell(git *)', 'run_powershell', 'git status')).toBe(true);
    expect(testAllowRule('run_powershell(git *)', 'run_powershell', 'rm -rf /')).toBe(false);
    expect(testAllowRule('write_file(C:\\logs\\*)', 'write_file', 'app.log', 'C:\\logs\\app.log')).toBe(true);
  });
  it('wildcard tool names work (mcp__server__*)', () => {
    expect(testAllowRule('mcp__github__*', 'mcp__github__search', 'q')).toBe(true);
    expect(testAllowRule('mcp__github__*', 'mcp__gitlab__search', 'q')).toBe(false);
  });
});

describe('persist rule synthesis', () => {
  it('run_powershell persists first word + wildcard', () => {
    expect(persistRuleFor('run_powershell', 'command', { command: 'git status -sb' }, 'C:\\x')).toBe(
      'run_powershell(git *)',
    );
  });
  it('path tools persist the resolved path', () => {
    const rule = persistRuleFor('write_file', 'path', { path: 'out.txt' }, 'C:\\proj');
    expect(rule).toBe('write_file(C:\\proj\\out.txt)');
  });
  it('other tools persist the bare name', () => {
    expect(persistRuleFor('todo_write', undefined, {}, 'C:\\x')).toBe('todo_write');
  });
});
