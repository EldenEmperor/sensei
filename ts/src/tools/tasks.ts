// Background tasks for run_powershell run_in_background, ported from
// src\tasks.ps1. Child output goes to files (the OS owns the pipes — no pump
// threads, no deadlock); reads are byte-offset deltas.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../core/types.js';
import type { ToolRegistry } from './registry.js';

interface BgTask {
  id: string;
  process: ChildProcess;
  outFile: string;
  errFile: string;
  command: string;
  started: Date;
  outOffset: number;
  errOffset: number;
  exited: boolean;
  exitCode: number | null;
  notified: boolean;
  userNotified: boolean;
}

const tasks = new Map<string, BgTask>();
let nextId = 0;

export function startBackgroundTask(command: string, cwd: string, configDir: string): string {
  nextId++;
  const id = `bg${nextId}`;
  const dir = path.join(configDir, 'tasks', String(process.pid));
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `${id}.out`);
  const errFile = path.join(dir, `${id}.err`);
  // -EncodedCommand sidesteps argument-quoting mangling of pipes/quotes
  const enc = Buffer.from(command, 'utf16le').toString('base64');
  let p: ChildProcess;
  try {
    const outFd = fs.openSync(outFile, 'a');
    const errFd = fs.openSync(errFile, 'a');
    p = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  } catch (e) {
    return `ERROR: could not start background task: ${(e as Error).message}`;
  }
  const t: BgTask = {
    id,
    process: p,
    outFile,
    errFile,
    command,
    started: new Date(),
    outOffset: 0,
    errOffset: 0,
    exited: false,
    exitCode: null,
    notified: false,
    userNotified: false,
  };
  p.on('exit', (code) => {
    t.exited = true;
    t.exitCode = code ?? -1;
  });
  p.on('error', () => {
    t.exited = true;
    t.exitCode = -1;
  });
  tasks.set(id, t);
  return `Started background task ${id} (pid ${p.pid}). Use task_output with task_id '${id}' to check on it.`;
}

function readDelta(t: BgTask, which: 'out' | 'err'): string {
  const file = which === 'out' ? t.outFile : t.errFile;
  if (!fs.existsSync(file)) return '';
  const offset = which === 'out' ? t.outOffset : t.errOffset;
  const size = fs.statSync(file).size;
  if (size <= offset) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    const n = fs.readSync(fd, buf, 0, buf.length, offset);
    if (which === 'out') t.outOffset += n;
    else t.errOffset += n;
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Inject completion notes as user-role messages. Only called at legal
 *  transcript boundaries (turn start / between tool rounds). */
export function addBackgroundTaskNotices(messages: ChatMessage[]): void {
  for (const t of tasks.values()) {
    if (t.exited && !t.notified) {
      t.notified = true;
      const dur = Math.trunc((Date.now() - t.started.getTime()) / 1000);
      messages.push({
        role: 'user',
        content: `<system-note>Background task ${t.id} ('${t.command}') exited with code ${t.exitCode} after ${dur}s. Use task_output to read its output.</system-note>`,
      });
    }
  }
}

/** Human-facing notes for tasks that finished while the user was idle. */
export function finishedTaskNotes(): string[] {
  const out: string[] = [];
  for (const t of tasks.values()) {
    if (t.exited && !t.userNotified) {
      t.userNotified = true;
      out.push(`background task ${t.id} finished (exit ${t.exitCode}) — ${t.command}`);
    }
  }
  return out;
}

export function listBackgroundTasks(): { id: string; status: string; command: string }[] {
  return [...tasks.values()].map((t) => ({
    id: t.id,
    status: t.exited ? `exited (code ${t.exitCode})` : 'running',
    command: t.command,
  }));
}

export function stopAllBackgroundTasks(): string[] {
  const killed: string[] = [];
  for (const t of tasks.values()) {
    if (!t.exited) {
      try {
        if (process.platform === 'win32' && t.process.pid) {
          spawn('taskkill', ['/PID', String(t.process.pid), '/T', '/F'], { windowsHide: true });
        } else {
          t.process.kill('SIGKILL');
        }
        killed.push(t.id);
      } catch {
        /* best effort */
      }
    }
  }
  return killed;
}

/** Test hook: forget all tracked tasks. */
export function resetBackgroundTasks(): void {
  tasks.clear();
  nextId = 0;
}

export function registerTaskTools(registry: ToolRegistry): void {
  registry.register({
    name: 'task_output',
    readOnly: true,
    description:
      'Read the status and any NEW output (since the last check) of a background task started with run_in_background.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: "e.g. 'bg1'" } },
      required: ['task_id'],
    },
    handler: (a) => {
      const t = tasks.get(String(a.task_id));
      if (!t) return `ERROR: no such task '${a.task_id}' — known tasks: ${[...tasks.keys()].join(', ')}`;
      const status = t.exited ? `exited (code ${t.exitCode})` : 'running';
      const out = readDelta(t, 'out');
      const err = readDelta(t, 'err');
      const started = t.started.toTimeString().slice(0, 8);
      let r = `task ${t.id}: ${status} | started ${started} | command: ${t.command}`;
      if (out) r += `\n--- new stdout ---\n${out}`;
      if (err) r += `\n--- new stderr ---\n${err}`;
      if (!out && !err) r += '\n(no new output)';
      return r;
    },
  });

  registry.register({
    name: 'kill_task',
    readOnly: false,
    description: 'Kill a running background task (and its child processes).',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    handler: (a) => {
      const t = tasks.get(String(a.task_id));
      if (!t) return `ERROR: no such task '${a.task_id}'`;
      if (t.exited) return `task ${t.id} already exited (code ${t.exitCode})`;
      try {
        if (process.platform === 'win32' && t.process.pid) {
          spawn('taskkill', ['/PID', String(t.process.pid), '/T', '/F'], { windowsHide: true });
        } else {
          t.process.kill('SIGKILL');
        }
      } catch (e) {
        return `ERROR: ${(e as Error).message}`;
      }
      return `killed task ${t.id}`;
    },
  });
}
