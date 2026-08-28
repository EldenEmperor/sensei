// run_powershell — spawns a fresh non-interactive pwsh child, same semantics
// and result format as the PS variant. Background tasks arrive in M4.

import { spawn } from 'node:child_process';
import type { ToolRegistry } from './registry.js';

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* best effort */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone already */
      }
    }
  }
}

export function runPowershell(
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<string> {
  const timeoutMs = 1000 * Math.min(600, Math.max(1, timeoutSeconds));
  return new Promise((resolve) => {
    const p = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let settled = false;
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (out += d));
    p.stderr.on('data', (d: string) => (err += d));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(p.pid ?? 0);
      resolve(
        `ERROR: command timed out after ${timeoutMs / 1000}s and was killed (use run_in_background=true for long commands)`,
      );
    }, timeoutMs);
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(`ERROR: could not start pwsh: ${e.message}`);
    });
    p.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let result = `exit_code: ${code ?? -1}`;
      if (out) result += `\n--- stdout ---\n${out}`;
      if (err) result += `\n--- stderr ---\n${err}`;
      resolve(result);
    });
  });
}

export function registerShellTools(registry: ToolRegistry): void {
  registry.register({
    name: 'run_powershell',
    readOnly: false,
    primaryArg: 'command',
    description:
      'Run a command in a fresh non-interactive pwsh child process and return exit code, stdout, and stderr. State does not persist between calls. Default timeout 120s. Set run_in_background=true for long-running commands: returns a task id immediately; check it later with task_output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_seconds: { type: 'integer', description: '1–600, default 120 (foreground only)' },
        run_in_background: { type: 'boolean', description: 'Run detached and return a task id immediately (default false)' },
      },
      required: ['command'],
    },
    handler: async (a, ctx) => {
      if (a.run_in_background) {
        const { startBackgroundTask } = await import('./tasks.js');
        return startBackgroundTask(String(a.command), ctx.cwd, ctx.configDir);
      }
      return runPowershell(String(a.command), ctx.cwd, Number(a.timeout_seconds ?? 120));
    },
  });
}
