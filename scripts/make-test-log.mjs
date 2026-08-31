#!/usr/bin/env node
// Generate tests/app.log — a synthetic messy 200k-line application log with a
// planted failure narrative — plus the sidecar app.log.answers.json holding
// the ground-truth counts the logtools tests assert against.
//
// Node port of the retired PS variant's tests/New-TestLog.ps1 (see the
// ps-final git tag). The ~14 MB fixture is gitignored; `npm test` runs this
// automatically via the pretest hook (--if-missing).
//
// The story: connection-pool WARNs ramp up from 02:10, an OutOfMemory FATAL
// lands at 02:47:13 with a multi-line stack, and a cascade of retry ERRORs
// follows. Payment-gateway timeout ERRORs and a rare config-parse ERROR occur
// throughout as red herrings. A legacy component logs with a different
// (US-style) timestamp format on purpose.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ifMissing = args.includes('--if-missing');
const linesArg = args.indexOf('--lines');
const totalTarget = linesArg >= 0 ? Number(args[linesArg + 1]) : 200000;
const outPath = path.join(here, '..', 'tests', 'app.log');
const answersPath = `${outPath}.answers.json`;

if (ifMissing && fs.existsSync(outPath) && fs.existsSync(answersPath)) {
  process.exit(0);
}

// deterministic PRNG (mulberry32) — reproducible runs; the sidecar carries
// the actual counts, so cross-runtime bit-compatibility is not required
let seed = 42;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (min, maxExclusive) => min + Math.floor(rand() * (maxExclusive - min));
const guid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = randInt(0, 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

const pad = (n, w = 2) => String(n).padStart(w, '0');
function isoStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function usStamp(d) {
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let t = new Date(2026, 7, 27, 0, 0, 0, 0); // 2026-08-27 00:00:00 local
const rampStart = new Date(2026, 7, 27, 2, 10, 0, 0);
const crashTime = new Date(2026, 7, 27, 2, 47, 13, 0);

const counts = {
  payment_timeout: 0,
  retry_failed: 0,
  config_parse: 0,
  pool_warn: 0,
  fatal: 0,
  total_lines: 0,
};

const stack = [
  '   at OrderService.Cache.CacheManager.Grow(Int32 newSize)',
  '   at OrderService.Cache.CacheManager.Add(String key, Byte[] payload)',
  '   at OrderService.Handlers.OrderLookupHandler.HandleAsync(OrderRequest req)',
  '   at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.TaskOfIActionResultExecutor.Execute(...)',
  '   at Microsoft.AspNetCore.Routing.EndpointMiddleware.Invoke(HttpContext httpContext)',
  '   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](...)',
  '   --- End of inner exception stack trace ---',
  '   at System.Threading.ThreadPoolWorkQueue.Dispatch()',
];

const chunks = [];
let buffer = [];
function writeLine(line) {
  buffer.push(line);
  counts.total_lines++;
  if (buffer.length >= 10000) {
    chunks.push(buffer.join('\n') + '\n');
    buffer = [];
  }
}

while (counts.total_lines < totalTarget) {
  t = new Date(t.getTime() + 50 + randInt(0, 27));
  const stamp = isoStamp(t);

  if (t >= crashTime && counts.fatal === 0) {
    writeLine(`${stamp} [FATAL] System.OutOfMemoryException: Insufficient memory to continue the execution of the program.`);
    counts.fatal = 1;
    for (const s of stack) {
      if (counts.total_lines >= totalTarget) break;
      writeLine(s);
    }
    continue;
  }

  const postCrash = t >= crashTime;
  const inRamp = t >= rampStart && !postCrash;
  const roll = randInt(0, 1000);
  let line = null;

  if (postCrash && roll < 400) {
    counts.retry_failed++;
    line = `${stamp} [ERROR] Retry ${randInt(1, 6)}/5 failed for request ${guid()}: connection refused (10061)`;
  } else if (inRamp) {
    // WARN probability ramps from ~0% to ~15% as the crash approaches
    const progress = (t.getTime() - rampStart.getTime()) / (crashTime.getTime() - rampStart.getTime());
    if (roll < 150 * progress) {
      counts.pool_warn++;
      const used = Math.trunc(60 + 39 * progress);
      line = `${stamp} [WARN] Connection pool nearing capacity: ${used}/100 connections in use, queue depth ${randInt(0, 40)}`;
    }
  }

  if (line === null) {
    if (roll < 8) {
      counts.payment_timeout++;
      line = `${stamp} [ERROR] Payment gateway timeout after ${randInt(3000, 9000)} ms for order ${randInt(10000, 99999)}`;
    } else if (roll < 10) {
      counts.config_parse++;
      line = `${stamp} [ERROR] Failed to parse config value 'cache.ttl': input string was not in a correct format`;
    } else if (roll < 60) {
      line = `${stamp} [DEBUG] Cache lookup key=order:${randInt(10000, 99999)} hit=${rand() < 0.5 ? 'True' : 'False'}`;
    } else if (roll < 80) {
      // legacy component with a different timestamp format, on purpose
      line = `${usStamp(t)} [INFO] LegacyBilling: invoice batch ${randInt(100, 999)} processed`;
    } else {
      switch (randInt(0, 4)) {
        case 0:
          line = `${stamp} [INFO] Request GET /api/orders/${randInt(10000, 99999)} completed in ${randInt(5, 900)} ms (200)`;
          break;
        case 1:
          line = `${stamp} [INFO] Heartbeat OK from worker-${randInt(1, 9)}`;
          break;
        case 2:
          line = `${stamp} [INFO] User u${randInt(1000, 9999)} session refreshed`;
          break;
        default:
          line = `${stamp} [INFO] Cache refresh completed: ${randInt(500, 5000)} entries`;
          break;
      }
    }
  }

  writeLine(line);
}

if (buffer.length > 0) chunks.push(buffer.join('\n') + '\n');
fs.writeFileSync(outPath, chunks.join(''), 'utf8');

const answers = {
  ...counts,
  error_total: counts.payment_timeout + counts.retry_failed + counts.config_parse,
  warn_total: counts.pool_warn,
  crash_time: '2026-08-27 02:47:13',
};
fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2), 'utf8');
console.log(`wrote ${counts.total_lines} lines to ${outPath} (answers in ${answersPath})`);
