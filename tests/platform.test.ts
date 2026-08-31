// Cross-platform behavior: shell selection (bash on POSIX, pwsh on Windows),
// platform-aware prompts, browser discovery, persist rules, and path
// case-sensitivity — all parameterized on platform so both branches run on
// any host.

import { describe, expect, it } from 'vitest';
import { makeAutoContinueNote, getSystemPrompt } from '../src/core/prompts.js';
import { likeMatch, persistRuleFor, testAllowRule } from '../src/core/permissions.js';
import { getShell } from '../src/tools/platformShell.js';
import { registerShellTools } from '../src/tools/shell.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { browserCandidates } from '../src/tools/web.js';

describe('getShell', () => {
  it('win32: run_powershell over pwsh, EncodedCommand background, pwsh hooks', () => {
    const s = getShell('win32');
    expect(s.toolName).toBe('run_powershell');
    expect(s.exe).toBe('pwsh');
    expect(s.fgArgs('git status')).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'git status']);
    const bg = s.bgSpawn('echo "a | b"');
    expect(bg.exe).toBe('pwsh');
    expect(bg.args[2]).toBe('-EncodedCommand');
    expect(Buffer.from(bg.args[3], 'base64').toString('utf16le')).toBe('echo "a | b"');
    expect(s.hookSpawn('x').exe).toBe('pwsh');
  });

  it('POSIX: bash tool with -c, plain background args, sh hooks', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const s = getShell(platform);
      expect(s.toolName).toBe('bash');
      expect(s.fgArgs('grep -r ERROR .')).toEqual(['-c', 'grep -r ERROR .']);
      const bg = s.bgSpawn('sleep 5 && echo done');
      expect(bg.args).toEqual(['-c', 'sleep 5 && echo done']);
      expect(s.hookSpawn('x')).toEqual({ exe: 'sh', args: ['-c', 'x'] });
    }
  });

  it('registers exactly one shell tool, named for the platform', () => {
    const win = new ToolRegistry();
    registerShellTools(win, getShell('win32'));
    expect(win.getSpecs([]).map((t) => t.function.name)).toEqual(['run_powershell']);
    const posix = new ToolRegistry();
    registerShellTools(posix, getShell('linux'));
    const specs = posix.getSpecs([]);
    expect(specs.map((t) => t.function.name)).toEqual(['bash']);
    // exe probes the host (bash, falling back to sh) — either way, never pwsh
    expect(specs[0].function.description).toMatch(/non-interactive (bash|sh) child/);
    expect(specs[0].function.description).not.toContain('pwsh');
  });
});

describe('platform-aware prompts', () => {
  const base = { cwd: 'X', configDir: 'Y' };

  it('windows prompt keeps PowerShell/winget/UAC guidance', () => {
    const p = getSystemPrompt({ ...base, platform: 'win32' });
    expect(p).toContain('PowerShell on Windows');
    expect(p).toContain('run_powershell');
    expect(p).toContain('winget');
    expect(p).toContain('UAC');
    expect(p).not.toContain('sudo');
  });

  it('POSIX prompt names bash and sudo instead of pwsh and UAC', () => {
    const p = getSystemPrompt({ ...base, platform: 'linux' });
    expect(p).toContain('POSIX shell');
    expect(p).toContain('Linux');
    expect(p).toMatch(/- (bash|sh) runs in a fresh NON-INTERACTIVE/);
    expect(p).toContain('sudo');
    expect(p).not.toContain('run_powershell');
    expect(p).not.toContain('winget');
    expect(p).not.toContain('UAC');
    const mac = getSystemPrompt({ ...base, platform: 'darwin' });
    expect(mac).toContain('macOS');
    expect(mac).toContain('brew');
  });

  it('auto-continue note names the platform shell tool', () => {
    expect(makeAutoContinueNote('win32')).toContain('run_powershell');
    expect(makeAutoContinueNote('win32')).toContain('winget');
    expect(makeAutoContinueNote('linux')).toContain('bash');
    expect(makeAutoContinueNote('linux')).not.toContain('winget');
  });
});

describe('browser discovery', () => {
  it('candidates per platform', () => {
    expect(browserCandidates('win32').some((p) => p.includes('msedge.exe'))).toBe(true);
    expect(browserCandidates('darwin').some((p) => p.includes('Google Chrome.app'))).toBe(true);
    expect(browserCandidates('linux').some((p) => p.includes('google-chrome'))).toBe(true);
  });
});

describe('permissions on POSIX', () => {
  it('persistRuleFor handles the bash tool like run_powershell', () => {
    expect(persistRuleFor('bash', 'command', { command: 'git status -sb' }, '/x')).toBe('bash(git *)');
    expect(persistRuleFor('bash', 'command', { command: '' }, '/x')).toBe('bash');
  });

  it('resolved paths match case-sensitively on POSIX, insensitively on Windows', () => {
    // tool name matching stays case-insensitive everywhere
    expect(testAllowRule('READ_FILE', 'read_file', undefined, undefined, 'linux')).toBe(true);
    expect(testAllowRule('read_file(/var/LOG/*)', 'read_file', 'x', '/var/log/app.log', 'linux')).toBe(false);
    expect(testAllowRule('read_file(/var/log/*)', 'read_file', 'x', '/var/log/app.log', 'linux')).toBe(true);
    expect(testAllowRule('read_file(C:\\LOGS\\*)', 'read_file', 'x', 'C:\\logs\\app.log', 'win32')).toBe(true);
    // raw primary values (commands) stay case-insensitive on both
    expect(testAllowRule('bash(GIT *)', 'bash', 'git status', undefined, 'linux')).toBe(true);
  });

  it('likeMatch caseSensitive flag', () => {
    expect(likeMatch('AbC', 'abc')).toBe(true);
    expect(likeMatch('AbC', 'abc', true)).toBe(false);
  });
});
