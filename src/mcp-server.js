#!/usr/bin/env node
/**
 * Minimal MCP server — stdio transport, newline-delimited JSON-RPC 2.0,
 * ZERO dependencies (invariant #6). Exposes the api.js command core as tools;
 * results are the same envelopes the --json CLI emits, serialized as text.
 * Destructive tools hard-require confirm:true (the api enforces it too).
 */
import readline from "node:readline";
import path from "node:path";
import util from "node:util";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { PKG_ROOT } from "./paths.js";
import { loadConfig } from "./config.js";
import { machine, envelope, elapsedS, EXIT } from "./util/machine.js";
import { readJson } from "./util/fsx.js";
import { openIdMap } from "./util/idmap.js";
import { formatSummary } from "./util/mcp-format.js";
import { createApi } from "./api.js";

machine.enable(); // stdout must carry ONLY JSON-RPC frames

// T1 — stream stage prose as MCP log notifications, IN ADDITION to stderr.
// machine.enable() just collapsed console.log/console.warn onto console.error
// (stderr) so stdout stays pure by construction. Wrapping them AGAIN here —
// after machine.enable(), not instead of it — lets us see the log-vs-warn
// distinction before it disappears into one stderr stream, while the human
// path (a person running this file directly) is completely unchanged: both
// wrapped functions call the machine-mode version FIRST, so stderr output is
// byte-for-byte what it was before this change.
//
// Feedback-loop guard: notifyLog() below only ever calls send() (a raw
// process.stdout.write of a JSON-RPC frame) — it never calls console.log or
// console.warn itself, so a notification can never trigger another one.
// RFC 5424 order (low -> high severity), the order the MCP logging spec follows.
const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
const LEVEL_ORDER = LOG_LEVELS;
const levelRank = (l) => { const i = LEVEL_ORDER.indexOf(l); return i === -1 ? LEVEL_ORDER.indexOf("info") : i; };

// Per the MCP spec, `logging` is a SERVER capability (the server declares it
// can emit notifications/message); there is no standard CLIENT capability
// meaning "I want to receive them." The only signal a client has to opt in
// pre-`logging/setLevel` is what it puts in its OWN `capabilities` object at
// `initialize` — capability objects are explicitly extensible (base spec:
// "Additional capabilities can be introduced without breaking backwards
// compatibility"). This server treats a truthy `capabilities.logging` on the
// client's initialize request as that opt-in signal, so an unaware client
// (anything that only sends the three standard client capabilities —
// roots/sampling/elicitation — or none at all) gets ZERO notifications,
// exactly today's behavior, while a client that knows to ask gets the stream
// this task exists to deliver.
let clientAcceptsLogs = false;
let currentLogLevel = "info"; // MCP spec default before any logging/setLevel call
let currentToolName = null; // set for the duration of a tool.fn() call, for the `logger` field

function notifyLog(level, ...args) {
  if (!clientAcceptsLogs) return;
  if (levelRank(level) < levelRank(currentLogLevel)) return;
  send({ jsonrpc: "2.0", method: "notifications/message", params: { level, logger: currentToolName || "shoplift", data: util.format(...args) } });
}

const toStderrLog = console.log, toStderrWarn = console.warn;
console.log = (...args) => { toStderrLog(...args); notifyLog("info", ...args); };
console.warn = (...args) => { toStderrWarn(...args); notifyLog("warning", ...args); };

const argv = process.argv;
const configFlagIdx = argv.indexOf("--config");
let configPath;
if (configFlagIdx === -1) {
  configPath = path.join(PKG_ROOT, "config", "migration.config.json");
} else {
  // MCP clients are configured by hand-edited JSON — a trailing `--config`
  // with no value, or one immediately followed by another flag, must be a
  // loud startup failure, not a server that starts and fails every call
  // with a raw Node error (`paths[0] argument must be of type string`).
  const val = argv[configFlagIdx + 1];
  if (!val || val.startsWith("-")) {
    process.stderr.write("shoplift-mcp: --config requires a path argument, e.g. --config /absolute/path/to/migration.config.json\n");
    process.exit(EXIT.USAGE);
  }
  configPath = val;
}
const api = createApi(configPath);

// MCP spec: the server should echo the client's requested protocolVersion if
// it supports it, and otherwise reply with its own latest supported version
// (the client then decides whether to proceed or disconnect). This server's
// surface — basic tools/list + tools/call with content[].text — is simple
// enough to be genuinely compatible across all three; do not add a version
// here without checking the surface still holds for it.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Heartbeat cadence for notifications/progress (see tools/call). 5s is well
// inside every client timeout we've seen; the env override exists so the test
// suite can assert heartbeats without sleeping for seconds.
const PROGRESS_INTERVAL_MS = Number(process.env.SHOPLIFT_MCP_PROGRESS_MS) || 5000;

/**
 * Black-box recorder — one JSONL line per tools/call outcome.
 *
 * Why this exists: when a client abandons a request (see DEFECT-1 — Claude
 * Desktop raises -32001 at ~60s), the stage keeps running to completion but
 * the RESULT ENVELOPE IS DISCARDED BY THE CLIENT. A stage that failed after
 * the client gave up is then invisible: no error code, no message, nothing to
 * debug with — exactly how a half-wiped WordPress source went unexplained.
 * Prose logs go to stderr, which on a desktop client lands in an app-internal
 * log directory the operator (and any agent) usually can't read.
 *
 * Written to the DATA DIR ROOT, not data/state/ — the Shopify wipe rm -rf's
 * state/ to clear the ledger, which would erase the log precisely when a wipe
 * needs explaining. Recording must never break a call: every failure here is
 * swallowed (a diagnostic that can take down the tool it diagnoses is worse
 * than no diagnostic).
 */

// Credential-bearing tool arguments (sites_add). The recorder writes `args`
// verbatim, so without this a literal secret passed to sites_add would be
// persisted in plaintext to mcp-calls.jsonl — a file that deliberately
// SURVIVES a wipe and is meant to be read during incidents. A `${VAR}` value
// is an env-var POINTER, not a secret, and is the whole point of the sites_add
// default path, so it passes through: an operator reading the log needs to see
// which variable a profile expects.
//
// Redaction lives inside record() rather than at each call site so a future
// call site cannot forget it. `args` never leaves this process by any other
// route — jobStatusFn/jobListFn deliberately do not return job.args.
const SECRET_ARG_KEYS = new Set(["consumerKey", "consumerSecret", "wpAppPassword", "clientId", "clientSecret", "adminAccessToken", "password"]);
const ENV_REF = /^\$\{[A-Z0-9_]+\}$/;
function redactArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  let out = null;
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_ARG_KEYS.has(k) && typeof v === "string" && v !== "" && !ENV_REF.test(v)) {
      out = out || { ...args };
      out[k] = "<redacted>";
    }
  }
  return out || args; // unchanged object when there was nothing to redact
}

function record(entry) {
  try {
    const dir = loadConfig(configPath)?.paths?.data;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const safe = "args" in entry ? { ...entry, args: redactArgs(entry.args) } : entry;
    appendFileSync(path.join(dir, "mcp-calls.jsonl"), JSON.stringify(safe) + "\n");
  } catch { /* diagnostics are best-effort, never load-bearing */ }
}
const S = (props = {}, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const entitiesProp = { entities: { type: "array", items: { type: "string" }, description: "subset of: products, collections, customers, orders, discounts, pages, articles, redirects" } };

// MCP tool annotations (spec 2025-03-26+; older clients ignore the field).
// Without these, spec-compliant clients must assume EVERY tool is destructive
// and open-world — which forces a permission prompt on every call, including
// pure reads. Hints are advisory, not security: the confirm/dev-store/source
// gates in api.js remain the real protection. Spec defaults when absent are
// readOnlyHint:false, destructiveHint:true, idempotentHint:false,
// openWorldHint:true — so only deviations from those need stating.
const RO_LOCAL = { readOnlyHint: true, openWorldHint: false };            // reads local state only
const RO_NET = { readOnlyHint: true };                                    // reads over the network, writes nothing meaningful
const ADDITIVE = { destructiveHint: false, idempotentHint: true };        // creates/updates, never deletes; safe to re-run
const DESTRUCTIVE = { destructiveHint: true, idempotentHint: true };      // deletes data; re-run converges on "empty"

/**
 * Async job registry (DEFECT-1 fix, 2026-07-28).
 *
 * Claude Desktop gives up on a tools/call ~60s in with -32001 and closes
 * stdin (see the drain handler below and the recorder's doc comment above).
 * notifications/progress heartbeats only help a client that opts in with
 * `_meta.progressToken`, and CLIENTS DIFFER: the recorder measured Claude
 * Desktop sending one on no call at all, and Claude Code sending one on every
 * call. So heartbeats are not a general answer — for a client in the first
 * group, no amount of server-side heartbeating can keep its request alive.
 * (Read `hadProgressToken` in data/mcp-calls.jsonl to settle this for any new
 * client in one run; D6 below makes that field truthful for async calls too,
 * which is where it had been reporting a hardcoded false.)
 * The only fix that works regardless of client behavior: long tools
 * return a job handle immediately (`async: true`) and the caller polls
 * `migration_job_status` instead of holding one request open for 15 minutes.
 *
 * Every tool that touches a live system (WordPress or Shopify) is eligible.
 * migration_status/migration_doctor/sites_list/sites_activate stay
 * synchronous-only: status and sites_* are local + fast, and doctor is a
 * bounded network round-trip, not a multi-minute stage.
 */
const ASYNC_ELIGIBLE = new Set([
  "migration_export", "migration_transform", "migration_import", "migration_verify",
  "migration_all", "migration_seed", "wipe_shopify", "wipe_wordpress"
]);

// Invariant #4: the confirm:true gate on both wipes (and on migration_seed's
// wipeFirst) must reject SYNCHRONOUSLY, before a job exists — async:true must
// never defer or bypass it. This mirrors the same boolean check api.js's
// confirmGate() makes; it does not replace it — the tool's own gate still
// runs for real inside the (possibly-async) call. A gate rejection here just
// means: don't hand this call off to a background job, run it inline instead,
// so the CONFIRM_REQUIRED error comes back on the original request, not
// through a job that would immediately "complete" with a gate failure.
function gateRejected(toolName, args) {
  if (toolName === "wipe_shopify" || toolName === "wipe_wordpress") return args?.confirm !== true;
  if (toolName === "migration_seed" && args?.wipeFirst === true) return args?.confirm !== true;
  return false;
}

// Completed jobs stay queryable for the life of the process, but a long-lived
// server must not grow this Map unboundedly — cap it and evict the oldest
// COMPLETED (done/failed) entries first once over the cap. Never evict a
// running job: something may still be polling it.
const MAX_JOBS = 100;
const jobs = new Map(); // insertion order == Map iteration order
function evictOldCompletedJobs() {
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.status !== "running") jobs.delete(id);
  }
}

// Runs the tool's REAL work. Enqueued via `serialize()` below — the SAME
// promise chain a synchronous tools/call uses — so an async job's work can
// never run concurrently with another mutating call (invariant #1). This is
// the one function in this file allowed to call tool.fn() outside the
// request/response cycle that created it.
async function runJobWork(job, tool, args) {
  job.workStartedAt = new Date().toISOString();
  const t0 = job.t0;
  let res;
  currentToolName = tool.name; // T1: so log notifications emitted by this background job's stage prose carry the right `logger`
  try {
    // async is this server's own dispatch flag, not a stage/api.js parameter —
    // strip it so it can never leak into stage logic even if a future stage
    // starts destructuring extra keys.
    const { async: _async, ...workArgs } = args;
    res = await tool.fn(workArgs);
  } catch (e) {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.elapsedS = elapsedS(Date.now() - t0);
    job.error = String(e?.message || e).slice(0, 400);
    // D2: near-unreachable throw path (api.js's own wrap() already catches
    // everything) — still hoist ok/exit so a poller never has to special-case
    // "failed" as "no ok/exit exists". EXIT.CRASH mirrors classifyError()'s
    // default for an unclassified exception (util/machine.js).
    job.ok = false;
    job.exit = EXIT.CRASH;
    record({ at: job.startedAt, tool: tool.name, jobId: job.id, ok: false, threw: job.error, elapsedS: job.elapsedS, hadProgressToken: job.hadProgressToken });
    return;
  } finally { currentToolName = null; }
  // A non-zero exit (e.g. PARTIAL, VERIFY) is NOT a failed job — the envelope
  // carries the outcome exactly as the synchronous path does. `failed` is
  // reserved for the near-unreachable unexpected-throw case above; do not
  // invent a second error channel here.
  job.status = "done";
  job.finishedAt = new Date().toISOString();
  job.elapsedS = elapsedS(Date.now() - t0);
  // D1: command echoes the MCP tool NAME invoked (tool.name, e.g.
  // "migration_transform"), never api.js's internal stage name (res.command,
  // e.g. "transform") — see the tools/call handler below for the full
  // rationale. tool.name === job.tool, kept as tool.name here for locality.
  job.envelope = envelope(tool.name, { ...res, t0 });
  job.ok = job.envelope.ok;
  job.exit = job.envelope.exit;
  record({
    at: job.startedAt, finishedAt: job.finishedAt, tool: tool.name, jobId: job.id, args,
    ok: res.ok === true, exit: res.exit, errorCode: res.error?.code ?? null, errorMessage: res.error?.message ?? null,
    elapsedS: job.elapsedS, hadProgressToken: job.hadProgressToken
  });
}

// Creates the job record and hands its WORK off to the serialization chain
// WITHOUT awaiting it — the caller (tools/call handler) returns the job
// handle immediately. `serialize()` is defined further down in this file but
// only referenced here inside a closure that runs later, once the module has
// finished loading, so the declaration order is not a problem.
// D6 (2026-07-28 medium-tier live test): `hadProgressToken` answers a
// CLIENT-CAPABILITY question — "does this client opt into progress at all?" —
// which is true or false of the client regardless of whether THIS server chose
// to emit heartbeats. The async path deliberately sends no progress (the
// response is already gone by the time the job runs), but recording a hardcoded
// false conflated "client sent no token" with "server sent no beats". Since
// async is the recommended path for exactly the long tools where the answer
// matters, the log then reads as though the client had no token on every call
// worth asking about. Capture the originating request's real value instead.
function startJob(tool, args, hadProgressToken) {
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const job = { id: jobId, tool: tool.name, args, hadProgressToken, status: "running", startedAt, t0: Date.now(), workStartedAt: null, finishedAt: null, elapsedS: null, ok: null, exit: null, envelope: null, error: null };
  jobs.set(jobId, job);
  evictOldCompletedJobs();
  serialize(() => runJobWork(job, tool, args));
  return job;
}

const jobStatusFn = async ({ jobId } = {}) => {
  const job = jobs.get(jobId);
  if (!job) {
    return { command: "migration_job_status", ok: false, exit: EXIT.USAGE, data: null, error: { code: "JOB_NOT_FOUND", message: `unknown jobId: ${jobId}`, hint: "Use migration_job_list to see known jobs (they stay queryable for the life of the process, capped at the most recent 100)." } };
  }
  if (job.status === "running") {
    return { command: "migration_job_status", ok: true, exit: EXIT.OK, data: { jobId: job.id, tool: job.tool, status: "running", startedAt: job.startedAt, workStartedAt: job.workStartedAt, elapsedS: elapsedS(Date.now() - job.t0) }, error: null };
  }
  // D2: done or failed — hand back the full envelope the synchronous call
  // would have returned, nested at data.envelope (unchanged, still the
  // authoritative full result). ok/exit are ALSO hoisted straight onto data
  // so an agent can branch (`if (!data.ok)`) without descending through
  // envelope.ok — present only now that the job is terminal (null while
  // running, see above). `data.error` is a SEPARATE, job-level signal: it is
  // non-null only for the near-unreachable "the call threw past api.js's own
  // wrap()" case (status:"failed"); a normal non-zero exit (PARTIAL, VERIFY)
  // is status:"done" with data.error still null and the real outcome living
  // in envelope.error — command-level failure and job-level failure are two
  // different axes, do not conflate them.
  return {
    command: "migration_job_status", ok: true, exit: EXIT.OK,
    data: { jobId: job.id, tool: job.tool, status: job.status, startedAt: job.startedAt, workStartedAt: job.workStartedAt, finishedAt: job.finishedAt, elapsedS: job.elapsedS, ok: job.ok, exit: job.exit, envelope: job.envelope, error: job.error },
    error: null
  };
};

const jobListFn = async () => {
  const list = [...jobs.values()].reverse().map((j) => ({
    id: j.id, tool: j.tool, status: j.status, startedAt: j.startedAt,
    elapsedS: j.status === "running" ? elapsedS(Date.now() - j.t0) : j.elapsedS
  }));
  return { command: "migration_job_list", ok: true, exit: EXIT.OK, data: { jobs: list }, error: null };
};

// Added to the inputSchema of every ASYNC_ELIGIBLE tool (see the job registry
// above) — docs/MACHINE-CONTRACT.md documents the poll loop this enables.
const asyncProp = { async: { type: "boolean", description: "Return a jobId immediately and run in the background instead of blocking this request; poll migration_job_status to retrieve the result. See docs/MACHINE-CONTRACT.md." } };

// D5 (2026-07-28 live MCP test): migration_job_status/migration_job_list are
// polling reads over the in-memory job registry, not calls with an outcome
// worth preserving — recording them turns data/mcp-calls.jsonl (see the
// recorder doc comment above) into mostly polling noise (8 of 15 rows in the
// session that found this). Named explicitly, not inferred from
// readOnlyHint/RO_LOCAL, so the exclusion is legible on its own without
// cross-referencing the annotations table above — and so a future read-only
// tool with a real outcome worth recording doesn't get silently swept in.
const RECORD_EXCLUDED_TOOLS = new Set(["migration_job_status", "migration_job_list"]);

// T2 — every tool result is the same 8-key envelope (see the D1 comment on
// the tools/call handler below) regardless of which tool ran or whether it
// succeeded: {tool,v,command,ok,exit,elapsedS,data,error}. `data`'s INNER
// shape genuinely differs per tool and per success/failure branch (that's
// the whole point of a shared envelope wrapping heterogeneous stage
// results) — describing it precisely per tool would mean either being wrong
// on some branch (most tools have a distinct success shape vs. a
// CONFIRM_REQUIRED/CONFIG_MISSING gate-rejection shape) or writing 14
// separate oneOf schemas for a field this file cannot promise never
// changes. The outer envelope shape, by contrast, is a hard invariant this
// file enforces by construction (envelope() in util/machine.js, called on
// every path below) — so ONE honest schema, declared identically on all 14
// tools, is what `structuredContent` actually satisfies on every path,
// success or error, sync or async-dispatch. `elapsedS` is listed as required
// because both call sites that build an envelope always pass `t0`.
const ENVELOPE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", const: "shoplift" },
    v: { type: "number", const: 1 },
    command: { type: "string", description: "the MCP tool name invoked, e.g. \"migration_import\" (not api.js's internal stage name)" },
    ok: { type: "boolean" },
    exit: { type: "number", description: "0 OK, 1 crash, 2 usage/gate, 3 connection, 4 partial import, 5 verify failed" },
    elapsedS: { type: "number" },
    data: { description: "shape depends on the tool and on ok/exit — see this tool's description and docs/MACHINE-CONTRACT.md" },
    error: {
      anyOf: [
        { type: "null" },
        { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, hint: { type: "string" } }, required: ["code", "message"] }
      ]
    }
  },
  required: ["tool", "v", "command", "ok", "exit", "elapsedS", "data", "error"]
};

// ---- DanDomain (Hostedshop) P1 probes -------------------------------------
// Thin, gated wrapper around scripts/probe-dandomain.mjs so an agent session can
// run the live investigation itself instead of relaying terminal output by hand.
// The probe kit owns all SOAP logic; this only spawns it and returns its JSON.
const DD_PROBE_RE = /^[a-z][a-z0-9-]{0,31}$/; // the probe script validates the actual name
const DD_FILES = { wsdl: ["wsdl-findings"], all: ["wsdl-findings", "smoke", "profile", "encoding", "storefront", "graphql", "vat", "ordercreate", "urls", "limits"] };
const dandomainProbeFn = async ({ probe, write = false, confirm = false } = {}) => {
  const command = "dandomain_probe";
  const fail = (code, message, hint, exit = EXIT.USAGE) => ({ command, ok: false, exit, data: null, error: { code, message, hint } });
  if (typeof probe !== "string" || !DD_PROBE_RE.test(probe)) return fail("USAGE", `invalid probe name: ${probe}`, "Lowercase letters, digits and hyphens; the probe script prints the valid list.");
  if (write && confirm !== true) return fail("CONFIRM_REQUIRED", "write probes create PROBE-* products/categories/orders on the DanDomain source shop", "Pass confirm:true. Scratch/demo shops only — never a real migration source.");
  const { execFile } = await import("node:child_process");
  const script = path.join(PKG_ROOT, "scripts", "probe-dandomain.mjs");
  const args = [script, probe, ...(write ? ["--write"] : [])];
  const r = await new Promise((res) => execFile(process.execPath, args, { cwd: PKG_ROOT, timeout: 600000, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => res({ err, stdout: String(stdout || ""), stderr: String(stderr || "") })));
  const dir = path.join(PKG_ROOT, "data", "probes");
  const results = {};
  for (const n of (DD_FILES[probe] ?? [probe])) {
    try { const j = readJson(path.join(dir, `${n}.json`), null); if (j) results[n] = j; } catch { /* probe may not have written it */ }
  }
  const data = { probe, write, results, stdout: r.stdout.slice(-4000) };
  if (r.err) return { command, ok: false, exit: EXIT.CONNECT, data, error: { code: "PROBE_FAILED", message: (r.stderr || r.err.message || "probe exited non-zero").slice(0, 800), hint: "Any JSON the probe managed to write is at data.results; the tail of stdout is at data.stdout." } };
  return { command, ok: true, exit: EXIT.OK, data, error: null };
};

const TOOLS = [
  { name: "migration_status", description: "Aggregate migration state: export/transform counts, ledger, last import, verify verdict, ACTION warnings (entity/id/code/severity — pass verbose:true for the full human-readable message text too). Run this first.", inputSchema: S({ verbose: { type: "boolean", description: "Include the long human-readable `message` text on each data.warnings.actions entry. Default false — entity/id/code/severity are always present; message is opt-in (it can run ~4KB on a real store)." } }), annotations: { title: "Migration status", ...(RO_LOCAL) }, fn: api.status },
  { name: "migration_doctor", description: "Connection checks for the active source (WordPress/WooCommerce or DanDomain SOAP) and Shopify.", inputSchema: S(), annotations: { title: "Doctor: connection checks", ...(RO_NET) }, fn: api.doctor },
  { name: "migration_export", description: "Snapshot the source (WordPress or DanDomain) to data/raw/ (read-only on the source).", inputSchema: S({ ...entitiesProp, ...asyncProp }), annotations: { title: "Export source → data/raw", ...(ADDITIVE) }, fn: api.export },
  { name: "migration_transform", description: "Map raw data to Shopify inputs offline; returns counts, severities and the full ACTION warning list.", inputSchema: S({ ...entitiesProp, ...asyncProp }), annotations: { title: "Transform → Shopify inputs", ...({ ...ADDITIVE, openWorldHint: false }) }, fn: api.transform },
  { name: "migration_import", description: "Push transformed data to Shopify. Idempotent and resumable; re-run to retry failures. Orders are rate-limited by Shopify (~4-5/min on dev stores).", inputSchema: S({ ...entitiesProp, dryRun: { type: "boolean" }, ...asyncProp }), annotations: { title: "Import → Shopify", ...(ADDITIVE) }, fn: api.import },
  { name: "migration_verify", description: "Reconcile counts and spot-check prices after import.", inputSchema: S({ ...asyncProp }), annotations: { title: "Verify migration", ...(RO_NET) }, fn: api.verify },
  { name: "migration_all", description: "export → transform → import → verify in one call. Can run 15+ minutes when order history is large. data carries one keyed result per stage; a stage that did not run is null. With dryRun:true verify is SKIPPED and data.verify is null by design — verifying an import that wrote nothing would compare the source against an untouched store and report a false failure.", inputSchema: S({ ...entitiesProp, dryRun: { type: "boolean" }, ...asyncProp }), annotations: { title: "Run full migration (export→verify)", ...(ADDITIVE) }, fn: api.all },
  { name: "migration_seed", description: "Create a test dataset on the source. WordPress tiers: light/medium/heavy (cumulative), real/real-xl (standalone — set wipeFirst). DanDomain tiers (when source.adapter/kind is dandomain): dd-light, dd-medium, dd-heavy, dd-real, dd-real-xl (idempotent SOAP upserts; no wipeFirst). dd-real is the messy Example Hostedshop; dd-real-xl is that shop plus scale (120-variant yarn probe). wipeFirst:true on WP DELETES ALL WooCommerce/WP content and requires confirm:true.", inputSchema: S({ tier: { type: "string", enum: ["light", "medium", "heavy", "real", "real-xl", "dd-light", "dd-medium", "dd-heavy", "dd-real", "dd-real-xl"] }, wipeFirst: { type: "boolean" }, confirm: { type: "boolean" }, ...asyncProp }, ["tier"]), annotations: { title: "Seed test dataset on source", ...(DESTRUCTIVE) }, fn: api.seed },
  { name: "wipe_shopify", description: "DELETE ALL data on the Shopify target. Refuses non-development stores. Requires confirm:true.", inputSchema: S({ confirm: { type: "boolean", const: true }, ...asyncProp }, ["confirm"]), annotations: { title: "WIPE Shopify target", ...(DESTRUCTIVE) }, fn: api.wipeShopify },
  { name: "wipe_wordpress", description: "DELETE ALL WooCommerce/WP content on the WordPress SOURCE (test sites only). Refuses a DanDomain pair — this tool never wipes a DanDomain shop. Requires confirm:true.", inputSchema: S({ confirm: { type: "boolean", const: true }, ...asyncProp }, ["confirm"]), annotations: { title: "WIPE WordPress source", ...(DESTRUCTIVE) }, fn: api.wipeWordpress },
  { name: "sites_list", description: "List registered WordPress/DanDomain/Shopify profiles, pairs and the active pair.", inputSchema: S(), annotations: { title: "List site profiles", ...(RO_LOCAL) }, fn: api.sitesList },
  { name: "sites_activate", description: "Activate a source/target pair (rewrites config/migration.config.json; each pair keeps its data dir forever).", inputSchema: S({ source: { type: "string" }, target: { type: "string" } }, ["source", "target"]), annotations: { title: "Activate site pair", ...({ ...ADDITIVE, openWorldHint: false }) }, fn: api.sitesActivate },
  // Credential fields all default to a ${ENV_VAR} reference, so the normal
  // path registers a profile WITHOUT this tool ever receiving a real secret:
  // the caller passes only baseUrl/shop, and the operator puts the values in
  // .env. Literal values ARE accepted (some callers legitimately have them)
  // but are redacted from both the response and the call recorder.
  { name: "sites_add", description: "Register a WordPress, Shopify or DanDomain connection profile in config/sites.json. Credential fields default to ${ENV_VAR} references resolved from .env at load time — prefer that over passing literal secrets. Pair it with sites_activate to generate the runtime config. Refuses to replace an existing profile name unless overwrite:true.", inputSchema: S({ kind: { type: "string", enum: ["wordpress", "shopify", "dandomain"] }, name: { type: "string", description: "profile name; derived from baseUrl/shop/tenant when omitted" }, overwrite: { type: "boolean" }, baseUrl: { type: "string", description: "wordpress: site URL (required for kind=wordpress)" }, adapter: { type: "string" }, consumerKey: { type: "string" }, consumerSecret: { type: "string" }, wpUser: { type: "string" }, wpAppPassword: { type: "string" }, shop: { type: "string", description: "shopify: \"mystore\" or \"mystore.myshopify.com\" (required for kind=shopify)" }, apiVersion: { type: "string" }, clientId: { type: "string" }, clientSecret: { type: "string" }, adminAccessToken: { type: "string" }, tenant: { type: "string", description: "dandomain: the shopNNNNN subdomain (kind=dandomain needs tenant or storefrontUrl; each derives the other)" }, storefrontUrl: { type: "string", description: "dandomain: STOREFRONT host https://{tenant}.mywebshop.io — never the admin host {tenant}.webshop.dandomain.dk (it answers 200 for every path)" }, shopId: { type: "string", description: "dandomain: Solution_GetWebinfo SolutionId for the seed/doctor identity gate; defaults to the tenant" }, username: { type: "string", description: "dandomain: SOAP API user" }, password: { type: "string", description: "dandomain: SOAP API password" } }, ["kind"]), annotations: { title: "Register site profile", ...({ ...ADDITIVE, openWorldHint: false }) }, fn: api.sitesAdd },
  { name: "migration_job_status", description: "Poll an async job started with async:true. Returns { status:\"running\" } while in progress; once done/failed also returns { ok, exit } hoisted from the result (branch on these without descending into data.envelope), the full envelope at data.envelope, and a SEPARATE job-level data.error (non-null only if the call threw past api.js's own error handling — a normal non-zero exit like PARTIAL/VERIFY is still status:\"done\" with data.error:null).", inputSchema: S({ jobId: { type: "string" } }, ["jobId"]), annotations: { title: "Async job status", ...(RO_LOCAL) }, fn: jobStatusFn },
  { name: "migration_job_list", description: "List known async jobs (id, tool, status, startedAt, elapsedS), newest first. Completed jobs stay queryable for the life of the process, capped at the most recent 100.", inputSchema: S(), annotations: { title: "List async jobs", ...(RO_LOCAL) }, fn: jobListFn },
  { name: "dandomain_probe", description: "Run a P1 live probe against the DanDomain (Hostedshop) SOAP API and return its JSON findings. Read-only probes: wsdl (download+census the WSDL), smoke (connect + shop inventory), profile (read the shop\u0027s own settings and DERIVE the migration config: VAT basis, languages, currencies, customer groups, custom order statuses, module census), graphql (OAuth + introspect both schemas), encbytes (byte-level encoding check), storefront (independent-channel check), limits (page-size/throttle sweep). Probes that WRITE PROBE-* data (need write:true + confirm:true): encoding (charset round-trip matrix), vat (VAT-basis products), ordercreate (Order_Create fault matrix), urls (URL fields + rename redirects). 'all' runs everything. Results also persist under data/probes/.", inputSchema: S({ probe: { type: "string", description: "Probe name, e.g. wsdl | smoke | profile | encoding | encbytes | storefront | graphql | gqldeep | vat | ordercreate | urls | limits | all. The probe script owns the authoritative list." }, write: { type: "boolean", description: "Allow probes that create PROBE-* data on the source shop." }, confirm: { type: "boolean", description: "Required alongside write:true." } }, ["probe"]), annotations: { title: "DanDomain live probe", ...(ADDITIVE) }, fn: dandomainProbeFn }
];
for (const t of TOOLS) t.outputSchema = ENVELOPE_OUTPUT_SCHEMA; // T2 — see ENVELOPE_OUTPUT_SCHEMA comment above

// T3 — every tools/call result carries two content blocks (summary first,
// full envelope second, per the task) plus structuredContent (T2) carrying
// the SAME envelope object (not a re-stringified copy) the text block holds.
// `annotations.audience` lets a client route each block to the right
// consumer; both blocks are ALWAYS present — never conditional on ok/exit —
// so a caller never has to guess which shape it got back.
function buildResult(toolName, env) {
  return {
    content: [
      { type: "text", text: formatSummary(toolName, env), annotations: { audience: ["user"] } },
      { type: "text", text: JSON.stringify(env), annotations: { audience: ["assistant"] } }
    ],
    structuredContent: env,
    isError: env.ok !== true
  };
}

// T4 — for migration_import specifically, a real completed/total ratio is
// knowable without touching any stage: transform already wrote the target
// counts to data/transformed/summary.json before import ever starts, and
// the resumable-import ledger (state/idmap.json — util/idmap.js) grows one
// key per landed entity AS import runs, saved incrementally by the stage
// itself. Reading both fresh on every heartbeat tick costs a few sync file
// reads on an interval already bounded by PROGRESS_INTERVAL_MS — cheap next
// to a stage that takes 15 minutes. Only entities with a genuine PER-ITEM
// ledger namespace are counted (see util/idmap.js call sites): redirects
// share one row of bookkeeping keys (finished/rowCount/createdCount) rather
// than one key per redirect, so idmap.count("redirects") would not mean
// "redirects landed" — it is deliberately left out of the total rather than
// reported dishonestly. Returns null (never a fabricated number) whenever
// the transformed summary doesn't exist yet or carries no countable entity.
const PROGRESS_ENTITY_NAMESPACES = ["products", "collections", "customers", "discounts", "orders", "articles", "pages"];
function importProgressSnapshot() {
  try {
    const c = loadConfig(configPath);
    const summary = readJson(path.join(c.paths.transformed, "summary.json"), null);
    if (!summary?.counts) return null;
    let total = 0;
    for (const k of PROGRESS_ENTITY_NAMESPACES) total += Number(summary.counts[k]) || 0;
    if (total <= 0) return null;
    const idmap = openIdMap(c.paths.state);
    let completed = 0;
    for (const k of PROGRESS_ENTITY_NAMESPACES) completed += idmap.count(k);
    return { completed: Math.min(completed, total), total };
  } catch { return null; } // best-effort only — never let a progress read break the heartbeat or the call
}

const HANDLERS = {
  initialize: async (params) => {
    // T1: see the notifyLog()/clientAcceptsLogs comment near machine.enable()
    // above for why "did the client's own capabilities object mention
    // logging" is the opt-in signal this server uses.
    clientAcceptsLogs = params?.capabilities?.logging !== undefined;
    currentLogLevel = "info"; // MCP spec default level before any logging/setLevel call
    return {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {}, logging: {} },
      serverInfo: { name: "shoplift", version: "1.337.0" }
    };
  },
  ping: async () => ({}),
  // T1 — MCP logging utility: https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging
  // Invalid levels get -32602 (Invalid params) per that spec's Error Handling section.
  "logging/setLevel": async (params) => {
    const level = params?.level;
    if (!LOG_LEVELS.includes(level)) { const e = new Error(`invalid log level: ${level}. Expected one of: ${LOG_LEVELS.join(", ")}`); e.rpcCode = -32602; throw e; }
    currentLogLevel = level;
    return {};
  },
  "tools/list": async () => ({ tools: TOOLS.map(({ fn, ...t }) => t) }),
  "tools/call": async (params) => {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) { const e = new Error(`unknown tool: ${params?.name}`); e.rpcCode = -32602; throw e; }
    const t0 = Date.now();
    const args = params.arguments || {};

    // Async job dispatch (DEFECT-1 fix — see the job registry comment above).
    // async:true on an eligible tool returns a job handle immediately; the
    // job's real work is enqueued on the SAME serialize() chain a synchronous
    // call uses (invariant #1) but this request does not await it. A
    // rejected destructive gate (confirm:true) must fail synchronously and
    // must never spin up a job first (invariant #4) — gateRejected() falls
    // through to the ordinary synchronous path below, which re-runs the same
    // gate for real and returns CONFIRM_REQUIRED on THIS request.
    if (args.async === true && ASYNC_ELIGIBLE.has(tool.name) && !gateRejected(tool.name, args)) {
      const job = startJob(tool, args, params._meta?.progressToken !== undefined);
      // D1: command is tool.name, not res.command — see the sync path below
      // for the full rationale (same governing principle applies here).
      const res = { command: tool.name, ok: true, exit: EXIT.OK, data: { jobId: job.id, status: "running", tool: tool.name, startedAt: job.startedAt }, error: null };
      return buildResult(tool.name, envelope(tool.name, { ...res, t0 }));
    }

    // Long stages (wipe, seed real, import, all) outlive typical client
    // request timeouts (observed: Claude Desktop -32001 after ~60s, then it
    // closes stdin — see the drain handler below for what that used to do to
    // in-flight work). If the client sent a progressToken, heartbeat
    // notifications/progress every 5s: spec-compliant clients reset their
    // per-request timeout on progress, keeping a 15-minute migration_all
    // alive. Token 0 is valid, hence the explicit undefined check.
    //
    // T4: for migration_import, prefer a REAL completed/total ratio
    // (importProgressSnapshot(), see its comment above) over the bare
    // elapsed-seconds counter whenever one is available yet — early in the
    // stage, before transform's summary/ledger exist for THIS run, there is
    // nothing honest to report yet, so it falls back to elapsed seconds
    // rather than inventing a total. Every other tool keeps the original
    // elapsed-only heartbeat unchanged.
    const token = params._meta?.progressToken;
    const emitProgress = () => {
      const s = Math.round((Date.now() - t0) / 1000);
      const snap = tool.name === "migration_import" ? importProgressSnapshot() : null;
      const p = snap
        ? { progressToken: token, progress: snap.completed, total: snap.total, message: `${tool.name}: ${snap.completed}/${snap.total} (${s}s)` }
        : { progressToken: token, progress: s, message: `${tool.name} still running (${s}s)` };
      send({ jsonrpc: "2.0", method: "notifications/progress", params: p });
    };
    // The FIRST heartbeat goes out immediately, before the stage starts, and only
    // then does the interval take over. Two reasons, one of them a bug this fixed:
    //
    //   1. The contract becomes unconditional — "a call that sent a progressToken
    //      ALWAYS gets at least one notifications/progress" — instead of "…gets one
    //      if it happens to outlive the interval". A tool that finishes in under
    //      PROGRESS_INTERVAL_MS previously sent none, so the client's opt-in was
    //      silently ignored for every fast call, and the test that asserts the
    //      falsy-token path failed roughly 1 run in 12 on fast hardware — a flake
    //      that fires on BETTER machines, which is the direction nobody suspects.
    //   2. It acknowledges the call at t=0. DEFECT-1 is a client giving up on a
    //      long stage; the sooner its per-request timer is first reset, the smaller
    //      the window in which a slow start looks like a dead server.
    if (token !== undefined) emitProgress();
    const beat = token === undefined ? null : setInterval(emitProgress, PROGRESS_INTERVAL_MS);
    const startedAt = new Date().toISOString();
    let res;
    currentToolName = tool.name; // T1: `logger` field on any notifications/message this call's stage prose triggers
    try {
      res = await tool.fn(args);
    } catch (e) {
      // api.js wrap() means this is near-unreachable, but an unexpected throw
      // here is exactly the case worth recording — it would otherwise surface
      // only as a bare JSON-RPC error the client may never show.
      // D5: job_status/job_list are polling reads with no outcome worth
      // preserving — see RECORD_EXCLUDED_TOOLS above.
      if (!RECORD_EXCLUDED_TOOLS.has(tool.name))
        record({ at: startedAt, tool: tool.name, ok: false, threw: String(e?.message || e).slice(0, 400), elapsedS: elapsedS(Date.now() - t0), hadProgressToken: token !== undefined });
      throw e;
    } finally { if (beat) clearInterval(beat); currentToolName = null; }
    if (!RECORD_EXCLUDED_TOOLS.has(tool.name))
      record({
        at: startedAt,
        finishedAt: new Date().toISOString(),
        tool: tool.name,
        args,
        ok: res.ok === true,
        exit: res.exit,
        errorCode: res.error?.code ?? null,
        errorMessage: res.error?.message ?? null,
        elapsedS: elapsedS(Date.now() - t0),
        // whether this client opts into progress at all — determines if the
        // DEFECT-1 heartbeat can ever keep a long call alive here
        hadProgressToken: token !== undefined
      });
    // Same 8-key envelope the --json CLI emits (cli.js:96, util/machine.js:22-28) —
    // docs/MACHINE-CONTRACT.md publishes this shape as the agent-facing contract; the MCP
    // surface must not ship a different (undocumented, un-versioned) one.
    //
    // D1 (2026-07-28 live MCP test): `command` echoes what the caller invoked
    // on THIS surface — tool.name (e.g. "migration_transform"), never
    // res.command, which is api.js's own internal stage name (e.g.
    // "transform", correct for the CLI's `transform --json`, which reports
    // command:"transform" for the identical operation). api.js is not
    // changed — the CLI still depends on its command names — only what the
    // MCP server puts in ITS envelope changes. Applies uniformly regardless
    // of res.ok, so error envelopes (CONFIRM_REQUIRED, CONFIG_MISSING, etc.)
    // echo the tool name too, not just success responses.
    return buildResult(tool.name, envelope(tool.name, { ...res, t0 }));
  }
};

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// tools/call runs real stage code against shared on-disk state (idmap.json,
// failed-*.jsonl — util/idmap.js, util/fsx.js) that is NOT concurrency-safe:
// two overlapping calls each hold an independent in-memory snapshot and the
// later save() clobbers the earlier one's writes, breaking the resumable-
// import ledger (invariant #1). Agent runtimes routinely emit several tool
// calls in one block, and readline's "line" handler below is never awaited
// by readline itself, so without this queue every arriving frame would start
// executing immediately and could interleave. Serialize tools/call ONLY —
// initialize/ping/tools/list must stay responsive so a client isn't blocked
// for the duration of a 15-minute migration_all.
let chain = Promise.resolve();
// pendingCalls counts tools/call work that has been queued but not yet
// settled — used by the "close" handler below to know whether stdin closing
// happened mid-flight (a tool call in progress or waiting behind one).
let pendingCalls = 0;
// chain.then(fn, fn): run fn next whether the PRIOR link resolved or
// rejected, so one failing call can never poison the queue for the calls
// queued behind it.
const serialize = (fn) => {
  pendingCalls++;
  const run = chain.then(fn, fn);
  chain = run.finally(() => { pendingCalls--; });
  return run;
};

async function respond(handler, msg) {
  try { send({ jsonrpc: "2.0", id: msg.id, result: await handler(msg.params || {}) }); }
  catch (e) { send({ jsonrpc: "2.0", id: msg.id, error: { code: e.rpcCode ?? -32000, message: String(e.message || e).slice(0, 300) } }); }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  // Valid JSON that isn't a JSON-RPC request object (bare `null`, a number, a
  // string, an array...) must not reach `msg.id` below: on a non-object that
  // throws inside this async handler, OUTSIDE the try/catch that guards
  // handler(...) — an unhandled rejection that kills the whole server and
  // silently drops every request already in flight (strictly worse than the
  // CLI's documented exit-1-empty-stdout hole, since that only loses one
  // command's output, not the whole session).
  if (!msg || typeof msg !== "object" || Array.isArray(msg))
    return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
  if (msg.id === undefined) return; // notification — no response by spec
  const handler = HANDLERS[msg.method];
  if (!handler) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  // migration_job_status/migration_job_list are reads over the in-memory job
  // registry, not stage work against shared on-disk state — they must NOT go
  // through the serialize() chain, or polling would be blocked behind the
  // very job it's trying to check on (defeating the entire point of async
  // jobs). Everything else named tools/call still serializes, including an
  // async:true job's OWN work — that happens inside startJob() via a nested
  // serialize() call in the tools/call handler, not here.
  const isJobRead = msg.method === "tools/call" && (msg.params?.name === "migration_job_status" || msg.params?.name === "migration_job_list");
  if (msg.method === "tools/call" && !isJobRead) serialize(() => respond(handler, msg));
  else await respond(handler, msg);
});
// stdin closing while a tools/call is queued/running must not report success:
// exiting 0 mid-flight would silently drop whatever the client was waiting
// on. Await the serialization chain so in-flight work actually finishes
// (real writes complete), bounded so a stuck stage can't hang the process
// forever, and always exit non-zero when there WAS pending work at close —
// the disconnect during active work is the abnormal condition being reported,
// not whether the drain itself finished in time.
// 2026-07-28: was 10s — which GUILLOTINED in-flight work. Observed live: the
// client timed out wipe_shopify at ~60s and closed stdin; the wipe got 10 more
// seconds of drain, then process.exit(1) killed it mid-products-batch (orders
// gone, 30/118 products left, customers untouched, ledger not cleared). A
// disconnect must not abort a half-done store mutation: drain long enough for
// any real stage to finish (import of a big order book runs 15+ min). Still
// bounded so a genuinely hung stage can't keep a zombie process forever.
// This also covers async jobs "for free": startJob() enqueues a job's real
// work on this SAME chain via serialize() (see the job registry above), so
// pendingCalls/chain already reflect a running background job with no
// separate bookkeeping needed here — closing stdin while a job is still
// running drains it exactly like a synchronous call in flight.
const CLOSE_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;
rl.on("close", async () => {
  if (pendingCalls === 0) process.exit(0);
  await Promise.race([chain, new Promise((res) => setTimeout(res, CLOSE_DRAIN_TIMEOUT_MS))]);
  process.exit(1);
});
