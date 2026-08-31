// Platform shell selection. One shell tool per platform, never both:
// POSIX registers `bash` (the tool name models know best), Windows keeps
// `run_powershell` (existing allow rules, hooks, and prompt guidance keep
// working). Platform is a parameter so both branches are testable anywhere.

import fs from 'node:fs';

export interface ShellSpec {
  /** Tool name registered with the agent. */
  toolName: 'bash' | 'run_powershell';
  /** Executable + args for a foreground command. */
  exe: string;
  fgArgs(command: string): string[];
  /** Executable + args for a background command (no stdin, output to files).
   *  Windows uses -EncodedCommand to sidestep argument-quoting mangling. */
  bgSpawn(command: string): { exe: string; args: string[] };
  /** Shell used to run hook commands (POSIX hooks run in sh for portability). */
  hookSpawn(command: string): { exe: string; args: string[] };
  /** Human name for error messages and prompts. */
  displayName: string;
}

let posixBash: string | null = null;
function findPosixBash(): string {
  if (posixBash) return posixBash;
  posixBash = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  })
    ? 'bash'
    : 'sh';
  return posixBash;
}

export function getShell(platform: NodeJS.Platform = process.platform): ShellSpec {
  if (platform === 'win32') {
    return {
      toolName: 'run_powershell',
      exe: 'pwsh',
      displayName: 'pwsh',
      fgArgs: (command) => ['-NoProfile', '-NonInteractive', '-Command', command],
      bgSpawn: (command) => ({
        exe: 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      }),
      hookSpawn: (command) => ({ exe: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', command] }),
    };
  }
  const bash = findPosixBash();
  return {
    toolName: 'bash',
    exe: bash,
    displayName: bash,
    fgArgs: (command) => ['-c', command],
    bgSpawn: (command) => ({ exe: bash, args: ['-c', command] }),
    hookSpawn: (command) => ({ exe: 'sh', args: ['-c', command] }),
  };
}

/** Test hook: reset the cached bash lookup. */
export function resetShellCache(): void {
  posixBash = null;
}
