#!/usr/bin/env node
/**
 * test/run-dandomain.mjs — THE entry point for the DanDomain source client's tests.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 * -------------------------------------
 * There were five test files and no way to run them as one thing: `node --test test/` failed on
 * this Node build, one of the five (`_scratch-ftp.mjs`) was a console.log walk-through with zero
 * assertions that could never fail, and each suite had to be invoked by hand. A suite nobody can
 * run in one command is a suite that stops being run. So:
 *
 *   - every *.test.mjs under test/ is discovered and run — nothing is opted in by hand, which
 *     means a new suite file cannot be forgotten;
 *   - the scratch file was promoted into real assertions (test/ftp.test.mjs) and deleted, so
 *     "everything under test/" and "everything that is a test" are now the same set;
 *   - the last line is `N passed, M failed`, and the exit status is 1 if M > 0 (or if nothing
 *     ran at all — an empty run reporting success is how a broken glob hides).
 *
 * Counting is done from the event stream (test:pass / test:fail, suites excluded so a failing
 * `describe` is not counted twice) and then CROSS-CHECKED against node:test's own final summary.
 * If the two disagree the run fails: a miscounting runner is worse than no runner, because
 * "0 failed" is exactly the sentence people trust without reading.
 *
 * A file that throws at import time produces no per-file summary at all — node:test reports one
 * failure named after the file. That case is detected explicitly and its stderr is printed,
 * because otherwise a suite that cannot even load looks like a suite with no tests.
 *
 * Two settings exist so that a BROKEN implementation produces a red instead of a hang, which
 * matters most on the day someone actually breaks something:
 *   - `timeout` bounds each individual test. The FTPS suite is the reason: violate R11.1 and the
 *     data-channel handshake waits on a ServerHello that never comes, so the honest symptom of
 *     the bug is "this never finishes". Unbounded, that is a CI job that hangs forever.
 *   - a STALL watchdog. If no event arrives for longer than one test timeout plus a grace
 *     period, the run is declared stalled and fails. This catches the other half of the same
 *     problem: a suite whose tests all finished but whose child process cannot exit because a
 *     failing test left a socket or a listening server behind.
 *
 * `forceExit: true` was tried for the second job and REMOVED. On this Node (v22.22) it truncates
 * the run: three back-to-back full runs reported 290, 298 and 316 of 326 tests, each time with
 * "0 failed" and exit 0, because the parent exits while children are still streaming — and
 * node:test's own summary agrees with the truncated number, so the cross-check below cannot see
 * it either. A runner that silently drops 36 tests and calls it green is worse than one that
 * hangs. That is what the "every requested file must produce a summary" check now guards.
 *
 * Invariant #4 ("modules never write to stdout") is about `src/`. This is an entry point: its
 * whole job is to print and to set an exit status. Nothing under src/ imports it.
 *
 * Usage:
 *   node test/run-dandomain.mjs                 # every suite
 *   node test/run-dandomain.mjs client ftp      # only suites whose filename matches a substring
 *   node test/run-dandomain.mjs --name="R11.1"  # only tests whose name matches (repeatable)
 *   node test/run-dandomain.mjs --concurrency=4 # run suite files in parallel (default: serial)
 *   node test/run-dandomain.mjs --timeout=5000  # per-test timeout in ms (default: 60000)
 *
 * Zero dependencies. Node >= 20 built-ins only.
 */
import { run } from "node:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE_RE = /\.test\.mjs$/;

/** CLI: bare words filter files by substring; --flag=value are options. */
function parseArgv(argv) {
  const filters = [];
  const names = [];
  let concurrency = 1;
  let timeout = 60_000;
  for (const arg of argv) {
    const flag = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!flag) { filters.push(arg); continue; }
    const [, key, value] = flag;
    if (key === "name") names.push(value ?? "");
    else if (key === "concurrency") concurrency = Number(value);
    else if (key === "timeout") timeout = Number(value);
    else throw new Error(`unknown option --${key}. Known: --name=<pattern>, --concurrency=<n>, --timeout=<ms>`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got ${JSON.stringify(concurrency)}`);
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`--timeout must be a positive number of milliseconds, got ${JSON.stringify(timeout)}`);
  }
  return { filters, names, concurrency, timeout };
}

let cli;
try {
  cli = parseArgv(process.argv.slice(2));
} catch (err) {
  // An entry point answers a bad flag with a sentence, not with a stack trace.
  process.stdout.write(`${err.message}\n0 passed, 0 failed\n`);
  process.exit(2);
}
const { filters, names, concurrency, timeout } = cli;

const all = readdirSync(HERE).filter((f) => SUITE_RE.test(f)).sort();
const chosen = filters.length === 0 ? all : all.filter((f) => filters.some((needle) => f.includes(needle)));
const files = chosen.map((f) => path.join(HERE, f));

if (files.length === 0) {
  process.stdout.write(
    `no suite files matched ${JSON.stringify(filters)} in ${HERE}\n` +
    `available: ${JSON.stringify(all)}\n0 passed, 0 failed\n`,
  );
  process.exit(1);
}

const rel = (file) => (file ? path.relative(path.resolve(HERE, ".."), file) : "(no file)");
const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;

/** Per-file tallies, in the order the files were requested, so output order is deterministic. */
const perFile = new Map(files.map((f) => [f, { passed: 0, failed: 0, ms: 0, sawSummary: false, stderr: [] }]));
const bucket = (file) => {
  if (!perFile.has(file)) perFile.set(file, { passed: 0, failed: 0, ms: 0, sawSummary: false, stderr: [] });
  return perFile.get(file);
};

const failures = [];
let passed = 0;
let failed = 0;
/**
 * When a suite file yields no tests at all (every test filtered out by --name), node:test emits a
 * pass event for the FILE itself — name === file, nesting 0 — and counts it in its own summary.
 * That is a file, not a test, so it is excluded here and added back only for the cross-check.
 * The mirror-image event (a file that throws at import time) IS a real failure and is counted.
 */
let fileWrapperPasses = 0;
let finalSummary = null;
const startedAt = Date.now();

const stream = run({
  files,
  concurrency,
  timeout,        // a hung test is a FAILING test, not a hung pipeline
  ...(names.length ? { testNamePatterns: names } : {}),
});

// Stall watchdog: a child that finished its tests but cannot exit produces no further events.
// The window is one whole test timeout plus a grace period, so a legitimately slow test can
// never trip it — only silence longer than any single test is allowed to take.
const STALL_MS = timeout + 30_000;
const iterator = stream[Symbol.asyncIterator]();
let stalled = false;

for (;;) {
  let tick;
  const step = await Promise.race([
    iterator.next(),
    new Promise((resolve) => { tick = setTimeout(() => resolve({ stalled: true }), STALL_MS); tick.unref?.(); }),
  ]);
  clearTimeout(tick);
  if (step.stalled) { stalled = true; break; }
  if (step.done) break;
  const event = step.value;
  const data = event.data ?? {};
  const isSuite = data.details?.type === "suite";
  switch (event.type) {
    case "test:pass":
      if (isSuite) break;
      if (data.name === data.file) { fileWrapperPasses += 1; break; }
      passed += 1;
      bucket(data.file).passed += 1;
      break;
    case "test:fail": {
      if (isSuite) break;               // a failing describe is its children, already counted
      failed += 1;
      bucket(data.file).failed += 1;
      const error = data.details?.error;
      failures.push({
        file: data.file,
        name: data.name === data.file ? "(the suite file itself — it did not load)" : data.name,
        message: String(error?.message ?? error ?? "(no message)"),
        stack: String(error?.stack ?? "").split("\n").slice(0, 6).join("\n"),
      });
      break;
    }
    case "test:stderr":
      bucket(data.file).stderr.push(String(data.message ?? ""));
      break;
    case "test:summary":
      if (data.file) {
        const b = bucket(data.file);
        b.sawSummary = true;
        b.ms = data.duration_ms ?? b.ms;
      } else {
        finalSummary = data;
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const out = [];
const width = Math.max(...files.map((f) => rel(f).length));
out.push(`dandomain — ${files.length} suite${files.length === 1 ? "" : "s"} on ${process.version}` +
  (names.length ? `, name pattern ${JSON.stringify(names)}` : "") +
  (concurrency > 1 ? `, concurrency ${concurrency}` : ""));
out.push("");
for (const file of files) {
  const b = perFile.get(file);
  const crashed = !b.sawSummary && b.failed > 0;
  out.push(
    `  ${rel(file).padEnd(width)}  ${String(b.passed).padStart(4)} passed, ${b.failed} failed` +
    `${b.ms ? `  ${secs(b.ms)}` : ""}${crashed ? "  (suite did not load)" : ""}`,
  );
}

if (failures.length) {
  out.push("");
  out.push(`FAILURES (${failures.length}):`);
  for (const [i, f] of failures.entries()) {
    out.push("");
    out.push(`  ${i + 1}) ${rel(f.file)} — ${f.name}`);
    for (const l of f.message.split("\n")) out.push(`     ${l}`);
    if (f.stack) for (const l of f.stack.split("\n").slice(1)) out.push(`     ${l.trim()}`);
  }
  for (const file of files) {
    const b = perFile.get(file);
    if (b.sawSummary || b.stderr.length === 0) continue;
    out.push("");
    out.push(`  stderr from ${rel(file)} (it never produced a summary — it failed to load):`);
    for (const l of b.stderr.join("").split("\n").slice(0, 20)) out.push(`     ${l}`);
  }
}

// The cross-check. node:test counted the same run; if its numbers differ from ours, this runner
// is lying about one of them and the run must not be reported as green.
const problems = [];
if (stalled) {
  problems.push(
    `the run STALLED: no event for ${STALL_MS}ms. A suite finished its tests but its process ` +
    "could not exit — a failing test almost certainly left a socket or a listening server behind. " +
    `Files that never reported: ${JSON.stringify(files.filter((f) => !perFile.get(f).sawSummary).map(rel))}`,
  );
}
// Every requested file must account for itself. A file that produced neither a summary nor a
// failure means the stream ended before that file ran — a truncated run reporting "0 failed".
for (const file of files) {
  const b = perFile.get(file);
  if (!b.sawSummary && b.failed === 0) problems.push(`${rel(file)} never ran (no summary, no failure) — the run was truncated`);
}
if (finalSummary?.counts) {
  const { passed: theirPass = 0, failed: theirFail = 0 } = finalSummary.counts;
  if (theirPass !== passed + fileWrapperPasses || theirFail !== failed) {
    problems.push(
      `runner miscount: node:test reported ${theirPass} passed / ${theirFail} failed, ` +
      `this runner counted ${passed} / ${failed} (+${fileWrapperPasses} empty-file wrappers)`,
    );
  }
} else {
  problems.push("node:test produced no final summary — the run did not complete");
}
if (passed + failed === 0) problems.push("no tests ran at all");

if (problems.length) {
  out.push("");
  for (const p of problems) out.push(`RUNNER ERROR: ${p}`);
}

// The LAST line is exactly "N passed, M failed" and nothing else — it is the line CI greps and
// the line a human reads first. Anything else worth saying goes above it.
out.push("");
out.push(`  ran ${files.length} suite${files.length === 1 ? "" : "s"} in ${secs(Date.now() - startedAt)}`);
out.push("");
out.push(`${passed} passed, ${failed} failed`);
process.stdout.write(out.join("\n") + "\n");
process.exitCode = failed > 0 || problems.length > 0 ? 1 : 0;
// A stalled run means a child process is still alive and holding the loop open. The report is
// already written, so leaving is the only honest thing left to do.
if (stalled) process.exit(1);
