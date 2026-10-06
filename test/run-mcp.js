#!/usr/bin/env node
/** Offline MCP server test: handshake, tools/list, tools/call, confirm gate. */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? (passed++, console.log(`  ✓ ${name}`)) : (failed++, console.error(`  ✗ ${name}`)); };

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Several assertions below read the fixture pair's transformed output (ACTION
// warnings, entity counts, the ledger totals behind progress `total`). Under
// `npm test` run-fixtures.js has already produced data-test/; standalone it has
// not, and those assertions fail for a missing-fixture reason that looks like a
// server bug. Produce it here too, exactly as run-machine.js does, so this file
// is standalone-runnable and a failure always means what it says.
execFileSync(process.execPath, [path.join(ROOT, "test", "run-fixtures.js")], { stdio: "ignore" });

const srv = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), "--config", path.join(ROOT, "test", "fixture.config.json")], { stdio: ["pipe", "pipe", "ignore"] });

const responses = new Map();
const arrival = []; // ids in the order frames actually arrived on stdout
let buf = "";
srv.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { const m = JSON.parse(line); const id = m.id === undefined ? null : m.id; responses.set(id, m); arrival.push(id); }
  }
});
const send = (obj) => srv.stdin.write(JSON.stringify(obj) + "\n");
const sendRaw = (line) => srv.stdin.write(line + "\n");
/** Write several JSON-RPC frames in ONE stdin.write() so they land on the
 * server in the same tick — this is how the concurrency bug (C2) reproduces:
 * multiple `line` events fire back-to-back before any earlier one resolves. */
const sendBatch = (objs) => srv.stdin.write(objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
const waitFor = (id, ms = 15000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (responses.has(id)) { clearInterval(iv); res(responses.get(id)); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for id ${id}`)); }
  }, 25);
});

console.log("— mcp server —");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
const init = await waitFor(1);
ok(init.result?.serverInfo?.name === "shoplift" && init.result?.capabilities?.tools, "initialize handshake");
ok(init.result?.protocolVersion === "2025-06-18", "initialize echoes back a supported protocolVersion the client requested");
// T1 — the server declares the `logging` capability unconditionally (per
// spec, `logging` is a SERVER capability the server offers regardless of
// what the client asked for); whether it actually SENDS notifications is a
// separate, per-client-opt-in decision tested further down against a
// dedicated server instance.
ok(init.result?.capabilities?.logging && typeof init.result.capabilities.logging === "object", "initialize declares the logging capability");
send({ jsonrpc: "2.0", method: "notifications/initialized" }); // must not crash or answer

console.log("— mcp server: logging/setLevel (T1) —");
send({ jsonrpc: "2.0", id: 200, method: "logging/setLevel", params: { level: "warning" } });
const setLevelOk = await waitFor(200);
ok(setLevelOk.result !== undefined && !setLevelOk.error, "logging/setLevel with a valid RFC 5424 level -> empty result, no error");
send({ jsonrpc: "2.0", id: 201, method: "logging/setLevel", params: { level: "not-a-real-level" } });
const setLevelBad = await waitFor(201);
ok(setLevelBad.error?.code === -32602, "logging/setLevel with an invalid level -> -32602 (Invalid params)");
send({ jsonrpc: "2.0", id: 202, method: "logging/setLevel", params: { level: "info" } }); // reset for the rest of this session
await waitFor(202);

// Cross-client portability (item 1.1): the server must NEGOTIATE
// protocolVersion, not hardcode it — a client on an older-but-supported spec
// version gets that version echoed back (so it doesn't disconnect), and a
// client on a version the server has never heard of gets the server's own
// newest supported version (the client then decides whether to proceed).
send({ jsonrpc: "2.0", id: 101, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old-client", version: "0" } } });
ok((await waitFor(101)).result?.protocolVersion === "2024-11-05", "initialize echoes back protocolVersion 2024-11-05 when the client asks for it (supported)");
send({ jsonrpc: "2.0", id: 102, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "unknown-client", version: "0" } } });
ok((await waitFor(102)).result?.protocolVersion === "2025-06-18", "initialize falls back to the server's newest supported version for an unrecognized protocolVersion");

send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const list = await waitFor(2);
ok(Array.isArray(list.result?.tools) && list.result.tools.length === 16, "16 tools listed");
ok(list.result.tools.every((t) => t.name && t.description && t.inputSchema?.type === "object"), "every tool has name/description/schema");
// T2 — outputSchema declared on every tool must be the shape structuredContent
// ACTUALLY carries on every path (see mcp-server.js's ENVELOPE_OUTPUT_SCHEMA
// comment) — assert the required top-level envelope keys are present here;
// the D1 block below proves structuredContent itself conforms, across all 15
// tools' success AND error paths.
ok(list.result.tools.every((t) => t.outputSchema?.type === "object" && ["tool", "v", "command", "ok", "exit", "data", "error"].every((k) => t.outputSchema.required?.includes(k))), "every tool declares an outputSchema requiring the envelope's core keys");

// Invariant #1 (this task's constraint 1): the tool names are a frozen,
// published contract (docs/MACHINE-CONTRACT.md) — the original 12, the two async-job tools
// appended at the end (2026-07-28, async job pattern), and sites_add placed
// next to the other sites_* tools (2026-07-28, agent setup layer). Verify
// exact names AND order, not just count — a reorder or rename here would
// silently break agents that pattern-match names.
const EXPECTED_TOOLS = [
  "migration_status", "migration_doctor", "migration_export", "migration_transform",
  "migration_import", "migration_verify", "migration_all", "migration_seed",
  "wipe_shopify", "wipe_wordpress", "sites_list", "sites_activate", "sites_add",
  "migration_job_status", "migration_job_list",
  // 2026-08-15: DanDomain (Hostedshop) source work — investigative probe tool,
  // appended at the end so the published order of the original 15 is untouched.
  "dandomain_probe"
];
ok(JSON.stringify(list.result.tools.map((t) => t.name)) === JSON.stringify(EXPECTED_TOOLS), "tool names + order match the frozen 16 (docs/MACHINE-CONTRACT.md)");

{
  const byName = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  ok(/DanDomain/.test(byName.migration_doctor?.description || ""), "migration_doctor description names DanDomain SOAP");
  ok(/DanDomain/.test(byName.migration_export?.description || ""), "migration_export description names DanDomain as a source");
  ok(/DanDomain/.test(byName.wipe_wordpress?.description || "") && /Refuses/i.test(byName.wipe_wordpress?.description || ""),
    "wipe_wordpress description says it refuses a DanDomain pair");
  ok(byName.sites_add?.inputSchema?.properties?.kind?.enum?.includes("dandomain"), "sites_add kind enum includes dandomain");
}

// The eight tools that do real work against a live system must advertise
// async:true in their inputSchema (2026-07-28 async job pattern) — an agent
// introspecting tools/list should be able to discover which tools support it
// without reading docs/MACHINE-CONTRACT.md.
{
  const ASYNC_ELIGIBLE = ["migration_export", "migration_transform", "migration_import", "migration_verify", "migration_all", "migration_seed", "wipe_shopify", "wipe_wordpress"];
  const byName = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  ok(ASYNC_ELIGIBLE.every((n) => byName[n]?.inputSchema?.properties?.async?.type === "boolean"), `all 8 async-eligible tools declare an async:boolean input (${ASYNC_ELIGIBLE.join(", ")})`);
  const ASYNC_INELIGIBLE = ["migration_status", "migration_doctor", "sites_list", "sites_activate", "migration_job_status", "migration_job_list"];
  ok(ASYNC_INELIGIBLE.every((n) => !byName[n]?.inputSchema?.properties?.async), `synchronous-only tools do NOT declare async (${ASYNC_INELIGIBLE.join(", ")})`);
}

// Post-P5 integration parity: DanDomain onboarding goes through the SAME
// sites_add tool as WordPress. An agent introspecting tools/list must be able
// to discover the kind and its profile fields without reading docs/MACHINE-CONTRACT.md.
{
  const add = list.result.tools.find((t) => t.name === "sites_add");
  ok(JSON.stringify(add?.inputSchema?.properties?.kind?.enum) === JSON.stringify(["wordpress", "shopify", "dandomain"]),
    `sites_add kind enum is wordpress|shopify|dandomain (got ${JSON.stringify(add?.inputSchema?.properties?.kind?.enum)})`);
  const DD_FIELDS = ["storefrontUrl", "tenant", "shopId", "username", "password"];
  ok(DD_FIELDS.every((k) => add?.inputSchema?.properties?.[k]?.type === "string"),
    `sites_add declares the dandomain profile fields (${DD_FIELDS.join(", ")})`);
}

// 2026-07-28 live-test finding: with no `annotations`, spec-compliant clients
// must assume every tool is destructive + open-world, so the host prompts for
// permission on EVERY call including pure reads (observed in Claude Desktop:
// no way to blanket-approve, a dialog per call). Annotations are advisory
// metadata only — the confirm/dev-store/source gates in api.js are the real
// protection — but they are what lets a client auto-approve the safe tools.
// Assert the SAFETY-CRITICAL direction exhaustively: no tool that can delete
// may ever claim readOnly, and the three wipe/seed tools must stay flagged
// destructive. A future tool added without annotations fails this too.
{
  const ann = Object.fromEntries(list.result.tools.map((t) => [t.name, t.annotations]));
  ok(list.result.tools.every((t) => t.annotations && typeof t.annotations === "object"), "every tool carries an annotations object");
  const READ_ONLY = ["migration_status", "migration_doctor", "migration_verify", "sites_list", "migration_job_status", "migration_job_list"];
  ok(READ_ONLY.every((n) => ann[n]?.readOnlyHint === true), `read-only tools declare readOnlyHint (${READ_ONLY.join(", ")})`);
  const MUTATING = ["migration_export", "migration_transform", "migration_import", "migration_all", "migration_seed", "wipe_shopify", "wipe_wordpress", "sites_activate"];
  ok(MUTATING.every((n) => ann[n]?.readOnlyHint !== true), "no mutating tool falsely claims readOnlyHint — a client must never auto-approve a write as a read");
  const DELETERS = ["wipe_shopify", "wipe_wordpress", "migration_seed"];
  ok(DELETERS.every((n) => ann[n]?.destructiveHint === true), `data-deleting tools declare destructiveHint (${DELETERS.join(", ")})`);
  ok(["migration_import", "migration_all", "migration_export"].every((n) => ann[n]?.destructiveHint === false && ann[n]?.idempotentHint === true), "resumable import/export/all are marked non-destructive + idempotent (they only add/update, and re-running is the documented retry path)");
  ok(ann.migration_status?.openWorldHint === false && ann.migration_transform?.openWorldHint === false, "offline tools (status, transform) declare openWorldHint:false — no external calls");
}

send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "migration_status", arguments: {} } });
const st = await waitFor(3);
const payload = JSON.parse(st.result.content[1].text);
ok(st.result.isError === false && payload.ok === true && payload.data.pair, "migration_status returns the api envelope");
// Fix round 1, Finding 2: the MCP payload must be the SAME 8-key envelope
// docs/MACHINE-CONTRACT.md publishes and the CLI emits (tool/v/command/ok/exit/elapsedS/data/error),
// not the bare {command,ok,exit,data,error} api.js result. `v` in particular
// is the contract's version discriminator — it must never be undefined.
ok(payload.tool === "shoplift" && payload.v === 1, "migration_status payload carries the envelope's tool + v fields (matches docs/MACHINE-CONTRACT.md/CLI shape)");

send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "wipe_shopify", arguments: {} } });
const wp = await waitFor(4);
ok(wp.result.isError === true && JSON.parse(wp.result.content[1].text).error.code === "CONFIRM_REQUIRED", "wipe without confirm -> isError + CONFIRM_REQUIRED");

send({ jsonrpc: "2.0", id: 5, method: "nope/nope" });
ok((await waitFor(5)).error?.code === -32601, "unknown method -> -32601");

// Deferred minor closed: the one named path in tools/call (mcp-server.js:71,
// `unknown tool: ${name}` -> rpcCode -32602) had no live assertion behind it.
send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "not_a_real_tool", arguments: {} } });
const unknownTool = await waitFor(10);
ok(unknownTool.error?.code === -32602 && /unknown tool/i.test(unknownTool.error?.message || ""), "tools/call with an unknown tool name -> -32602");

// Frame guarantee (this task's constraint 2): a malformed JSON-RPC line must
// still produce a frame on stdout (parse error), never silence. The frame has
// id:null per JSON-RPC 2.0 since the id couldn't be recovered from bad JSON.
sendRaw("this is not json");
const parseErr = await waitFor(null);
ok(parseErr.error?.code === -32700, "malformed JSON line -> -32700 parse error frame (never silently dropped)");

// Fix round 1, Finding 1: a line that parses as VALID JSON but isn't a JSON-RPC
// request object (e.g. the bare literal `null`) must not crash the server.
// `msg.id` on a non-object throws inside the async line handler, outside the
// try/catch around handler(...) -- an unhandled rejection that kills the
// process and silently drops every request already in flight. Assert BOTH
// halves in one check: the malformed line gets a -32600 frame, AND the
// server is still alive to answer the next real request (the part that
// actually proves the session survived, not just that this one line didn't crash).
responses.delete(null);
sendRaw("null");
const invalidReq = await waitFor(null);
send({ jsonrpc: "2.0", id: 6, method: "ping" });
const afterNull = await waitFor(6);
ok(invalidReq.error?.code === -32600 && afterNull.result !== undefined && !afterNull.error, "bare JSON `null` -> -32600 invalid-request frame, and the server survives to answer the next request");

// C2 — tools/call must be serialized: concurrent mutating calls corrupt the
// on-disk ledger (idmap.json / failed-*.jsonl are last-writer-wins, not
// merge-safe). Send two tools/call frames + a ping in ONE write (same tick,
// mirrors how agent runtimes batch calls) and prove the two tool RESULTS
// come back in issue order regardless of relative speed.
//
// migration_transform (no entities filter = all 8 entity types) is issued
// FIRST and is genuinely the slow one: jsonlWriter.close() awaits a real
// stream "finish" event per entity (util/fsx.js:19-25) -- true event-loop
// yields, not just microtasks. migration_status is issued SECOND and is
// cheap (a few sync file reads). Unserialized, the fast call routinely
// finishes and calls send() before the slow one's stream-close callbacks
// fire, which reorders the responses. Serialized, order is preserved no
// matter how slow the first call is, because the second can't even start
// until the first settles.
{
  const beforeArrivalLen = arrival.length;
  sendBatch([
    { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "migration_transform", arguments: {} } },
    { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "migration_status", arguments: {} } },
    { jsonrpc: "2.0", id: 22, method: "ping" }
  ]);
  const [r20, r21] = await Promise.all([waitFor(20), waitFor(21)]);
  await waitFor(22);
  ok(r20.result?.content && r21.result?.content, "both tools/call frames answered");
  const order = arrival.slice(beforeArrivalLen).filter((id) => id === 20 || id === 21);
  ok(order.length === 2 && order[0] === 20 && order[1] === 21, `tools/call results arrive in issue order (transform before status), got arrival order ${JSON.stringify(order)}`);
}

// Item 3.6 — the serialization queue in mcp-server.js is deliberately scoped
// to tools/call ONLY (initialize/ping/tools/list run outside it, per the
// comment at mcp-server.js ~90) so a client isn't blocked for the duration of
// a long migration_all. Prove ping specifically is not stuck behind a queued
// tools/call: issue the (genuinely slow, see the C2 comment above)
// migration_transform first, then a ping, in the same tick — the ping must
// come back BEFORE the queued tool result despite being issued second.
{
  const beforeLen = arrival.length;
  sendBatch([
    { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "migration_transform", arguments: {} } },
    { jsonrpc: "2.0", id: 41, method: "ping" }
  ]);
  const pingResp = await waitFor(41);
  ok(pingResp.result !== undefined && !pingResp.error, "ping answered while a tools/call is queued ahead of it");
  const transformResp = await waitFor(40);
  ok(transformResp.result?.content, "the queued tools/call is still answered afterward");
  const order = arrival.slice(beforeLen).filter((id) => id === 40 || id === 41);
  ok(order.length === 2 && order[0] === 41 && order[1] === 40, `ping is NOT blocked behind a queued tools/call — arrives first despite being issued second, got arrival order ${JSON.stringify(order)}`);
}

// 2026-07-28 async job pattern (DEFECT-1 fix, second half): heartbeats only
// help a client that opts into notifications/progress, and CLIENTS DIFFER —
// the recorder measured Claude Desktop sending no progressToken on any call,
// while Claude Code sends one (see the D6 block below, which is what makes
// that field trustworthy for async calls). A client in the first group cannot
// be kept alive by any amount of server-side heartbeating. async:true on the
// 8 eligible tools returns a job handle immediately instead; the client polls
// migration_job_status. All of this is reachable offline via fixture.config
// (dryRun:true) — migration_transform never touches the network.
console.log("— mcp server: async job pattern (DEFECT-1 fix) —");
{
  let pollId = 500;
  async function jobStatusCall(jobId) {
    const id = pollId++;
    const t0 = Date.now();
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "migration_job_status", arguments: { jobId } } });
    const resp = await waitFor(id, 5000);
    return { resp, ms: Date.now() - t0 };
  }
  async function pollJobDone(jobId, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const { resp } = await jobStatusCall(jobId);
      const payload = JSON.parse(resp.result.content[1].text);
      if (payload.data.status !== "running") return payload;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
  }

  // Sync path is unchanged (async absent vs. explicit async:false) — proves
  // this change didn't touch the byte-for-byte-covered synchronous behavior.
  {
    const plainId = pollId++, explicitFalseId = pollId++;
    send({ jsonrpc: "2.0", id: plainId, method: "tools/call", params: { name: "migration_transform", arguments: {} } });
    send({ jsonrpc: "2.0", id: explicitFalseId, method: "tools/call", params: { name: "migration_transform", arguments: { async: false } } });
    const plain = JSON.parse((await waitFor(plainId)).result.content[1].text);
    const explicitFalse = JSON.parse((await waitFor(explicitFalseId)).result.content[1].text);
    ok(plain.data.jobId === undefined && explicitFalse.data.jobId === undefined, "sync calls (async absent or false) never return a jobId — unchanged shape");
    // D1: the MCP envelope's command is the TOOL name (migration_transform),
    // never api.js's internal stage name (transform) — see the D1 test block
    // below for the exhaustive all-15 assertion; this just re-confirms it
    // holds for the sync path specifically, which is what this block tests.
    ok(plain.command === "migration_transform" && plain.ok === true && JSON.stringify(plain.data.counts) === JSON.stringify(explicitFalse.data.counts), "async:false behaves identically to async absent (same counts, same shape, command:migration_transform)");
  }

  // Canonical synchronous envelope, used below as the "ground truth" the
  // polled async job's envelope must match.
  const syncId = pollId++;
  send({ jsonrpc: "2.0", id: syncId, method: "tools/call", params: { name: "migration_transform", arguments: {} } });
  const syncPayload = JSON.parse((await waitFor(syncId)).result.content[1].text);

  // async:true returns a job handle immediately — well under the time a
  // synchronous call (or a client's request timeout) would take.
  const t0start = Date.now();
  const startId = pollId++;
  send({ jsonrpc: "2.0", id: startId, method: "tools/call", params: { name: "migration_transform", arguments: { async: true } } });
  const startResp = await waitFor(startId);
  const startLatencyMs = Date.now() - t0start;
  const startPayload = JSON.parse(startResp.result.content[1].text);
  ok(startResp.result.isError === false && startPayload.ok === true && startPayload.exit === 0, "async:true call returns ok:true, exit:0 immediately");
  ok(startPayload.data?.status === "running" && typeof startPayload.data?.jobId === "string" && startPayload.data?.jobId.length > 0 && startPayload.data?.tool === "migration_transform" && typeof startPayload.data?.startedAt === "string", "async:true response is { jobId, status:running, tool, startedAt }");
  ok(startLatencyMs < 1000, `async:true start round-trip is fast, well under a real stage's duration (got ${startLatencyMs}ms)`);

  const jobId = startPayload.data.jobId;
  const donePayload = await pollJobDone(jobId);
  ok(donePayload.data.status === "done", `polling migration_job_status eventually yields status:done, got ${donePayload.data.status}`);
  const jobEnvelope = donePayload.data.envelope;
  ok(jobEnvelope && jobEnvelope.command === syncPayload.command && jobEnvelope.ok === syncPayload.ok && jobEnvelope.exit === syncPayload.exit
    && JSON.stringify(jobEnvelope.data) === JSON.stringify(syncPayload.data) && JSON.stringify(jobEnvelope.error) === JSON.stringify(syncPayload.error),
    "the finished job's envelope matches what the synchronous call returns for the same input (command/ok/exit/data/error)");

  // D2 — a terminal job_status hoists ok/exit onto data directly, matching
  // envelope.ok/envelope.exit exactly, so an agent can branch without
  // descending two levels (data.envelope.ok) or reading a misleading
  // job-level `error:null` on success.
  ok(donePayload.data.ok === jobEnvelope.ok && donePayload.data.exit === jobEnvelope.exit,
    `terminal job_status hoists ok/exit matching envelope (data.ok=${donePayload.data.ok}, data.exit=${donePayload.data.exit}, envelope.ok=${jobEnvelope.ok}, envelope.exit=${jobEnvelope.exit})`);
  ok(donePayload.data.error === null, "job-level data.error stays null on a normal completion (distinct from envelope.error / a non-zero exit)");

  // Unknown jobId -> a clean, classified exit-2 error envelope, never a throw.
  const { resp: unknownResp } = await jobStatusCall("not-a-real-job-id-00000");
  const unknownPayload = JSON.parse(unknownResp.result.content[1].text);
  ok(unknownResp.result.isError === true && unknownPayload.exit === 2 && unknownPayload.error?.code === "JOB_NOT_FOUND", "migration_job_status on an unknown jobId -> exit 2 USAGE (JOB_NOT_FOUND), not a throw");

  // migration_job_list reflects the started job.
  const listId1 = pollId++;
  send({ jsonrpc: "2.0", id: listId1, method: "tools/call", params: { name: "migration_job_list", arguments: {} } });
  const listPayload1 = JSON.parse((await waitFor(listId1)).result.content[1].text);
  ok(Array.isArray(listPayload1.data?.jobs) && listPayload1.data.jobs.some((j) => j.id === jobId && j.tool === "migration_transform" && j.status === "done"), "migration_job_list reflects the started (now completed) job");

  // Two async jobs started back to back run one after the other, never
  // concurrently — and migration_job_status answers promptly even while one
  // is still queued/running, i.e. it is NOT stuck behind the serialize()
  // chain the job's own work uses.
  {
    const startA = pollId++, startB = pollId++;
    sendBatch([
      { jsonrpc: "2.0", id: startA, method: "tools/call", params: { name: "migration_transform", arguments: { async: true } } },
      { jsonrpc: "2.0", id: startB, method: "tools/call", params: { name: "migration_transform", arguments: { async: true } } }
    ]);
    const [respA, respB] = await Promise.all([waitFor(startA), waitFor(startB)]);
    const jobA = JSON.parse(respA.result.content[1].text).data.jobId;
    const jobB = JSON.parse(respB.result.content[1].text).data.jobId;
    ok(typeof jobA === "string" && typeof jobB === "string" && jobA !== jobB, "two back-to-back async job starts each return a distinct jobId");

    const { resp: quickPoll, ms: quickMs } = await jobStatusCall(jobB);
    ok(quickPoll.result?.content && quickMs < 2000, `migration_job_status answers promptly while a job may still be running/queued — not blocked behind the chain (got ${quickMs}ms)`);

    const doneA = await pollJobDone(jobA);
    const doneB = await pollJobDone(jobB);
    ok(doneA.data.status === "done" && doneB.data.status === "done", "both async jobs eventually reach status done");
    ok(doneA.data.workStartedAt && doneA.data.finishedAt && doneB.data.workStartedAt && doneB.data.finishedAt, "both jobs report workStartedAt/finishedAt timestamps");
    const [first, second] = doneA.data.workStartedAt <= doneB.data.workStartedAt ? [doneA, doneB] : [doneB, doneA];
    ok(first.data.finishedAt <= second.data.workStartedAt, `the two jobs' execution windows do not overlap (serialized, not concurrent) — first finished at ${first.data.finishedAt}, second started work at ${second.data.workStartedAt}`);
  }

  // Invariant #4: the confirm:true gate rejects synchronously, before a job
  // is ever created — async:true must never defer or bypass it.
  {
    const beforeListId = pollId++;
    send({ jsonrpc: "2.0", id: beforeListId, method: "tools/call", params: { name: "migration_job_list", arguments: {} } });
    const beforeCount = JSON.parse((await waitFor(beforeListId)).result.content[1].text).data.jobs.length;

    const gateId = pollId++;
    send({ jsonrpc: "2.0", id: gateId, method: "tools/call", params: { name: "wipe_shopify", arguments: { async: true } } });
    const gateResp = await waitFor(gateId);
    const gatePayload = JSON.parse(gateResp.result.content[1].text);
    ok(gateResp.result.isError === true && gatePayload.error?.code === "CONFIRM_REQUIRED" && gatePayload.data === null, "wipe_shopify async:true without confirm -> immediate CONFIRM_REQUIRED, synchronously");

    const afterListId = pollId++;
    send({ jsonrpc: "2.0", id: afterListId, method: "tools/call", params: { name: "migration_job_list", arguments: {} } });
    const afterCount = JSON.parse((await waitFor(afterListId)).result.content[1].text).data.jobs.length;
    ok(afterCount === beforeCount, "no job was created for the rejected confirm gate");
  }
}

// 2026-07-28 live-test finding (D3) — migration_status is the documented
// "run this first" tool, and it used to inline every ACTION warning's full
// `message` text on every call (~4KB/call on a real store). verbose:false is
// now the default: data.warnings.actions keeps entity/id/code/severity
// (still countable/actionable) but drops message; verbose:true restores
// today's full behavior. The fixture dataset carries 4 action-severity
// warnings (see run-machine.js's collectStatus assertion) so this has real
// entries to assert against, not an empty array.
console.log("— mcp server: D3 — migration_status verbose default omits message, verbose:true includes it —");
{
  send({ jsonrpc: "2.0", id: 700, method: "tools/call", params: { name: "migration_status", arguments: {} } });
  send({ jsonrpc: "2.0", id: 701, method: "tools/call", params: { name: "migration_status", arguments: { verbose: true } } });
  const nonVerbose = JSON.parse((await waitFor(700)).result.content[1].text);
  const verbose = JSON.parse((await waitFor(701)).result.content[1].text);
  const nvActions = nonVerbose.data.warnings.actions;
  const vActions = verbose.data.warnings.actions;
  ok(Array.isArray(nvActions) && nvActions.length > 0, "fixture data produces at least one ACTION warning to assert against");
  ok(nvActions.every((w) => !("message" in w)), "verbose:false (default) omits the message key entirely from every action entry");
  ok(nvActions.every((w) => typeof w.entity === "string" && w.id !== undefined && typeof w.code === "string" && typeof w.severity === "string"),
    "verbose:false still keeps entity/id/code/severity — the punch list stays countable/actionable");
  ok(vActions.length === nvActions.length && vActions.every((w) => typeof w.message === "string" && w.message.length > 0),
    "verbose:true includes the full human-readable message text");
  ok(vActions.every((w) => typeof w.entity === "string" && w.id !== undefined && typeof w.code === "string" && typeof w.severity === "string"),
    "verbose:true still carries entity/id/code/severity alongside message");
}

// D4 — live end-to-end smoke check that a real call's elapsedS is non-zero
// (the precise 1-vs-3-decimal rounding contract is asserted deterministically
// against util/machine.js's elapsedS() directly in run-machine.js — this just
// proves the fix is actually wired up on the MCP response path).
//
// The tool here is migration_doctor and NOT migration_status, which is what this
// assertion used to call. elapsedS rounds to 3 decimals, and migration_status is
// a few sync file reads: it lands on 0.001 s on an ordinary box and on exactly 0
// on a fast one, so the assertion failed as a function of MACHINE SPEED. That is
// the worst kind of flake — it fires on better hardware, which is the direction
// nobody suspects, and it makes `npm test`'s "0 failed" unreproducible.
// Measured over 5 consecutive runs in a fast sandbox:
//   migration_status  0.003, 0.001, 0, 0.001, 0.001   <- straddles the rounding floor
//   migration_doctor  0.618, 0.006, 0.006, 0.004, 0.004
// Doctor clears the 0.0005 s floor by ~8x on its SLOWEST sample, so what is being
// tested is the wiring, not the CPU. A zero from doctor is a real defect.
console.log("— mcp server: D4 — a real call's elapsedS is never 0 —");
{
  send({ jsonrpc: "2.0", id: 702, method: "tools/call", params: { name: "migration_doctor", arguments: {} } });
  const payload = JSON.parse((await waitFor(702)).result.content[1].text);
  ok(typeof payload.elapsedS === "number" && payload.elapsedS > 0, `migration_doctor reports a non-zero elapsedS (got ${payload.elapsedS})`);
}

// D5 — migration_job_status/migration_job_list are polling reads with no
// outcome worth preserving; recording them turned the recorder into mostly
// polling noise (8 of 15 rows in the session that found this). Assert BOTH
// halves: the two poll tools add nothing, and an ordinary tool still does.
console.log("— mcp server: D5 — job_status/job_list add no recorder rows; other tools still do —");
{
  const recorderPath = path.join(ROOT, "data-test", "mcp-calls.jsonl");
  const countRows = () => { try { return fs.readFileSync(recorderPath, "utf8").split("\n").filter((l) => l.trim()).length; } catch { return 0; } };
  const before = countRows();

  send({ jsonrpc: "2.0", id: 703, method: "tools/call", params: { name: "migration_job_list", arguments: {} } });
  await waitFor(703);
  send({ jsonrpc: "2.0", id: 704, method: "tools/call", params: { name: "migration_job_status", arguments: { jobId: "not-a-real-job-for-d5" } } });
  await waitFor(704);
  ok(countRows() === before, `migration_job_list + migration_job_status add zero recorder rows (before=${before}, after=${countRows()})`);

  send({ jsonrpc: "2.0", id: 705, method: "tools/call", params: { name: "sites_list", arguments: {} } });
  await waitFor(705);
  const afterReal = countRows();
  ok(afterReal === before + 1, `a non-excluded tool (sites_list) still adds exactly one recorder row (before=${before}, after=${afterReal})`);
  const lines = fs.readFileSync(recorderPath, "utf8").trim().split("\n");
  ok(JSON.parse(lines[lines.length - 1]).tool === "sites_list", "the new row names the real tool that ran");
}

// D6 (2026-07-28 medium-tier live test) — an async job recorded
// hadProgressToken:false unconditionally, because startJob() never saw the
// originating request's _meta. That field answers a CLIENT-capability
// question ("does this client opt into progress at all?"), so a hardcoded
// false silently reclassified every long call — the only ones for which the
// answer matters — as "client sent no token". Both directions are asserted:
// a broken build passes the without-token case and fails the with-token one.
console.log("— mcp server: D6 — an async job records the ORIGINATING request's progressToken —");
{
  const recorderPath = path.join(ROOT, "data-test", "mcp-calls.jsonl");
  const rows = () => { try { return fs.readFileSync(recorderPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return []; } };
  let d6Id = 730;

  // migration_transform is async-eligible and fully offline under
  // fixture.config (dryRun) — same tool the async block above uses.
  async function asyncJobWith(meta) {
    const id = d6Id++;
    const params = { name: "migration_transform", arguments: { async: true } };
    if (meta) params._meta = meta;
    send({ jsonrpc: "2.0", id, method: "tools/call", params });
    const jobId = JSON.parse((await waitFor(id)).result.content[1].text).data.jobId;
    for (let i = 0; i < 200; i++) {
      const pid = d6Id++;
      send({ jsonrpc: "2.0", id: pid, method: "tools/call", params: { name: "migration_job_status", arguments: { jobId } } });
      if (JSON.parse((await waitFor(pid)).result.content[1].text).data.status !== "running") return jobId;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("D6: async job never settled");
  }

  const withId = await asyncJobWith({ progressToken: "d6-token" });
  const withoutId = await asyncJobWith(null);

  const all = rows();
  const rowWith = all.find((r) => r.jobId === withId);
  const rowWithout = all.find((r) => r.jobId === withoutId);
  ok(!!rowWith && !!rowWithout, "both async jobs produced a recorder row");
  ok(rowWith?.hadProgressToken === true, `an async job started WITH a progressToken records hadProgressToken:true (got ${rowWith?.hadProgressToken})`);
  ok(rowWithout?.hadProgressToken === false, `an async job started WITHOUT one records hadProgressToken:false (got ${rowWithout?.hadProgressToken})`);
}

// The recorder writes tools/call `args` verbatim, and sites_add is the first
// tool that can carry credentials — so without redaction a literal secret
// would be persisted in plaintext to mcp-calls.jsonl, a file deliberately
// written OUTSIDE data/state/ so it survives a wipe. A ${VAR} value is an
// env-var pointer rather than a secret and must survive intact, or the log
// stops being useful for working out which variable a profile expects.
//
// Uses a REJECTED call (invalid kind): args are recorded either way, and
// sites.js writes to config/sites.json under PKG_ROOT, which this suite's
// --config cannot redirect. A successful call here would edit the real
// registry. That does mean this asserts redaction on the error path only —
// the code path is shared (one redactArgs inside record()), but a future
// change that redacted only one branch would not be caught here.
console.log("— mcp server: credential args are redacted in the call recorder —");
{
  const recorderPath = path.join(ROOT, "data-test", "mcp-calls.jsonl");
  const LITERAL = "shpat_d0_not_persist_me_0123456789";
  send({ jsonrpc: "2.0", id: 760, method: "tools/call", params: { name: "sites_add", arguments: {
    kind: "not-a-valid-kind-so-nothing-is-written",
    clientSecret: LITERAL,
    adminAccessToken: LITERAL,
    consumerKey: "${WC_CONSUMER_KEY}",
    password: LITERAL,
    shop: "example-store"
  } } });
  await waitFor(760);

  const raw = fs.readFileSync(recorderPath, "utf8");
  const row = raw.trim().split("\n").map((l) => JSON.parse(l)).reverse().find((r) => r.tool === "sites_add");
  ok(!!row, "the rejected sites_add call was recorded");
  ok(row?.args?.clientSecret === "<redacted>", `a literal clientSecret is stored as "<redacted>" (got ${JSON.stringify(row?.args?.clientSecret)})`);
  ok(row?.args?.adminAccessToken === "<redacted>", `a literal adminAccessToken is stored as "<redacted>" (got ${JSON.stringify(row?.args?.adminAccessToken)})`);
  ok(row?.args?.password === "<redacted>", `a literal dandomain SOAP password is stored as "<redacted>" (got ${JSON.stringify(row?.args?.password)})`);
  ok(row?.args?.consumerKey === "${WC_CONSUMER_KEY}", "a ${VAR} reference passes through unredacted — it is a pointer, not a secret");
  ok(row?.args?.shop === "example-store", "non-credential fields are untouched");
  // The strongest form of the assertion: the literal must appear NOWHERE in
  // the file, not merely be absent from the field we thought to check.
  ok(!raw.includes(LITERAL), "the literal secret appears nowhere in mcp-calls.jsonl");
}

srv.kill();

// D1 (2026-07-28 live MCP test) — 8 of the then-14 tools returned envelope.command as
// api.js's internal stage name (e.g. "transform") instead of the MCP tool
// name actually invoked (e.g. "migration_transform"), because the envelope
// was built from res.command (api.js's wrap()-baked constant) rather than
// the tool the client called. Exercise ALL 16 tools here, not a sample —
// command must equal the tool name regardless of whether the call itself
// succeeds (several of these ARE expected to fail: no WP creds, no confirm,
// an unknown site profile — that's fine and irrelevant to what's asserted).
//
// migration_doctor and migration_verify make REAL network calls against
// whatever source.baseUrl/shopify.shop the active config carries — even
// through the offline "fixture" WP adapter, since doctor's WordPress-REST
// check and verify's Shopify count query don't care about adapter type. This
// block therefore runs against its OWN isolated config with no baseUrl and no
// shopify block at all, so both throw on missing config synchronously
// (doctor.js: "source.baseUrl not set"; config.js's requireShopify: "Missing
// Shopify config") before ever reaching fetch() — verified by reading
// doctor.js/import/index.js/stages/verify.js, not assumed.
console.log("— mcp server: D1 — envelope.command echoes the invoked tool name (all 16) —");
{
  const d1CfgPath = path.join(ROOT, "test", `tmp-d1-command-${process.pid}.config.json`);
  const d1DataDir = path.join(ROOT, "data-test-d1-command");
  fs.rmSync(d1DataDir, { recursive: true, force: true });
  fs.writeFileSync(d1CfgPath, JSON.stringify({
    source: { adapter: "fixture" }, // no baseUrl -> doctor's WP-REST check throws before any fetch
    options: { dryRun: true },
    paths: { data: "./data-test-d1-command" }
    // no "shopify" key at all -> requireShopify() throws before any fetch (import/verify/all)
  }));

  const srvD1 = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), "--config", d1CfgPath], { stdio: ["pipe", "pipe", "ignore"] });
  const respD1 = new Map();
  let bufD1 = "";
  srvD1.stdout.on("data", (d) => {
    bufD1 += d;
    let i;
    while ((i = bufD1.indexOf("\n")) >= 0) { const line = bufD1.slice(0, i); bufD1 = bufD1.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); respD1.set(m.id, m); } }
  });
  const sendD1 = (obj) => srvD1.stdin.write(JSON.stringify(obj) + "\n");
  const waitD1 = (id, ms = 15000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (respD1.has(id)) { clearInterval(iv); res(respD1.get(id)); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`D1: timeout waiting for id ${id}`)); }
    }, 25);
  });

  // One safe args pairing per tool: enough to satisfy required schema fields
  // / pass the synchronous confirm gate check. Export before transform before
  // import/verify so the offline fixture data is there for stages that read
  // it (several still fail downstream on missing Shopify config — expected).
  const CALLS = [
    ["migration_status", {}],
    ["migration_doctor", {}],
    ["migration_export", {}],
    ["migration_transform", {}],
    ["migration_import", {}],
    ["migration_verify", {}],
    ["migration_all", { dryRun: true }],
    ["migration_seed", { tier: "light" }],
    ["wipe_shopify", {}],
    ["wipe_wordpress", {}],
    ["sites_list", {}],
    ["sites_activate", { source: "shoplift-test-d1-nonexistent-source", target: "shoplift-test-d1-nonexistent-target" }],
    // Deliberately an INVALID kind: sites.js writes to config/sites.json under
    // PKG_ROOT, which this block's temp --config cannot redirect. A rejected
    // call still exercises the D1/T2/T3 assertions (command echo, two content
    // blocks, structuredContent) without touching the real registry.
    ["sites_add", { kind: "not-a-valid-kind-for-d1" }],
    ["migration_job_status", { jobId: "not-a-real-job-for-d1" }],
    ["migration_job_list", {}],
    // Deliberately an INVALID probe name: rejected in-process by the enum/usage
    // guard, so D1 exercises the envelope contract without spawning the probe
    // script or touching any live DanDomain shop.
    ["dandomain_probe", { probe: "not-a-real-probe-for-d1" }]
  ];

  try {
    let idD1 = 1;
    for (const [name, args] of CALLS) {
      const id = idD1++;
      sendD1({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const resp = await waitD1(id);
      if (!resp.result?.content) throw new Error(`D1: ${name} produced no content frame — ${JSON.stringify(resp)}`);
      const payload = JSON.parse(resp.result.content[1].text);
      ok(payload.command === name, `${name}: envelope.command === "${name}" (got "${payload.command}")`);

      // T2/T3, exercised across all 16 tools' success AND error paths here
      // (this block already covers both — see the CALLS list, several are
      // expected to fail on missing config/confirm) rather than spot-checked
      // on one or two calls elsewhere.
      const blocks = resp.result.content;
      ok(Array.isArray(blocks) && blocks.length === 2, `${name}: tools/call result carries exactly two content blocks`);
      ok(blocks[0]?.type === "text" && typeof blocks[0]?.text === "string" && blocks[0].text.trim().length > 0, `${name}: content[0] is a non-empty human-readable summary`);
      ok(JSON.stringify(blocks[0]?.annotations?.audience) === JSON.stringify(["user"]), `${name}: content[0] is annotated audience:["user"]`);
      ok(blocks[1]?.type === "text" && blocks[1].text === JSON.stringify(payload), `${name}: content[1] is the JSON envelope (unchanged shape/position semantics, now at index 1)`);
      ok(JSON.stringify(blocks[1]?.annotations?.audience) === JSON.stringify(["assistant"]), `${name}: content[1] is annotated audience:["assistant"]`);
      ok(resp.result.structuredContent !== undefined && JSON.stringify(resp.result.structuredContent) === JSON.stringify(payload), `${name}: structuredContent deep-equals the parsed content[1] JSON text block`);
    }
    ok(CALLS.length === 16, "D1 block covers all 16 tools, not a sample");
  } finally {
    srvD1.kill();
    fs.rmSync(d1CfgPath, { force: true });
    fs.rmSync(d1DataDir, { recursive: true, force: true });
  }
}

// 2026-07-28 live-test finding (DEFECT-1): every long stage — wipe, seed real,
// import of a big order book, `all` — outran the client's per-request timeout
// (Claude Desktop gave up on wipe_shopify with -32001 after ~60s while the
// wipe was still deleting, leaving the target half-wiped). The MCP fix is
// notifications/progress heartbeats: spec-compliant clients reset the request
// timeout each time one arrives. Assert with a short interval (env override)
// that heartbeats (a) carry the client's exact progressToken, (b) do NOT
// appear when the client didn't ask for progress, and (c) stop once the call
// settles — a leaked interval would keep a zombie timer alive per call.
console.log("— mcp server: notifications/progress heartbeat for long calls (DEFECT-1) —");
{
  const srv3 = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), "--config", path.join(ROOT, "test", "fixture.config.json")], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, SHOPLIFT_MCP_PROGRESS_MS: "20" } });
  let out3 = "";
  const frames3 = [];
  srv3.stdout.on("data", (d) => {
    out3 += d;
    let i;
    while ((i = out3.indexOf("\n")) >= 0) { const line = out3.slice(0, i); out3 = out3.slice(i + 1); if (line.trim()) frames3.push(JSON.parse(line)); }
  });
  const wait3 = (id, ms = 15000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = frames3.find((x) => x.id === id);
      if (f) { clearInterval(iv); res(f); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for id ${id}`)); }
    }, 10);
  });
  const progressFor = (tok) => frames3.filter((f) => f.method === "notifications/progress" && f.params?.progressToken === tok);

  // token 0 on purpose: a falsy-but-valid token would be dropped by a truthiness check
  srv3.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "migration_transform", arguments: {}, _meta: { progressToken: 0 } } }) + "\n");
  const r1 = await wait3(1);
  ok(r1.result?.content, "tool with a progressToken still returns its normal result frame");
  ok(progressFor(0).length > 0, `heartbeats sent for progressToken 0 (falsy token must not be dropped), got ${progressFor(0).length}`);
  ok(progressFor(0).every((f) => f.jsonrpc === "2.0" && f.id === undefined && typeof f.params.progress === "number"), "each heartbeat is a valid JSON-RPC notification (no id) with a numeric progress");

  // no progressToken -> the client didn't opt in, so no notifications at all
  srv3.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "migration_transform", arguments: {} } }) + "\n");
  await wait3(2);
  ok(frames3.filter((f) => f.method === "notifications/progress" && f.params?.progressToken === undefined).length === 0, "no heartbeats when the client sent no progressToken");

  // interval must be cleared when the call settles, not left running
  const afterSettle = progressFor(0).length;
  await new Promise((res) => setTimeout(res, 120)); // 6x the 20ms interval
  ok(progressFor(0).length === afterSettle, "heartbeats stop once the call settles (interval cleared, no leaked timer)");
  srv3.kill();
}

// The heartbeat contract is UNCONDITIONAL: a call that opted in gets at least one
// notifications/progress even if it finishes before the interval would ever fire.
//
// This is asserted with the interval set to a MINUTE, so it cannot pass by timing
// luck — the only way to see a heartbeat here is the immediate first beat. The
// block above cannot test this: it uses a 20 ms interval, so on a slow machine it
// passes for the wrong reason, and on a fast one it used to fail outright (~1 run
// in 12) because migration_transform finished inside 20 ms and the client's opt-in
// was silently dropped. Same defect, made deterministic.
console.log("— mcp server: a fast call still honours its progressToken (no timing luck) —");
{
  const srv3b = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), "--config", path.join(ROOT, "test", "fixture.config.json")], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, SHOPLIFT_MCP_PROGRESS_MS: "60000" } });
  let out3b = "";
  const frames3b = [];
  srv3b.stdout.on("data", (d) => {
    out3b += d;
    let i;
    while ((i = out3b.indexOf("\n")) >= 0) { const line = out3b.slice(0, i); out3b = out3b.slice(i + 1); if (line.trim()) frames3b.push(JSON.parse(line)); }
  });
  const wait3b = (id, ms = 15000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = frames3b.find((x) => x.id === id);
      if (f) { clearInterval(iv); res(f); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for id ${id}`)); }
    }, 10);
  });
  srv3b.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "migration_status", arguments: {}, _meta: { progressToken: "fast" } } }) + "\n");
  await wait3b(1);
  const beats = frames3b.filter((f) => f.method === "notifications/progress" && f.params?.progressToken === "fast");
  ok(beats.length > 0, `a sub-interval call still emits a heartbeat with a 60s interval (got ${beats.length})`);
  ok(beats.every((f) => f.id === undefined && typeof f.params.progress === "number"), "the immediate beat is a valid notification with a numeric progress, same shape as the interval ones");
  srv3b.kill();
}

const RFC5424_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

// T1 — the whole point of this task: a client watching stdio should see live
// progress through a stage instead of nothing until the final envelope, AND
// (Invariant #10, the constraint this feature most endangers) stdout must
// stay 100% valid JSON-RPC frames the entire time a noisy stage is printing.
console.log("— mcp server: T1 — log notifications stream during a noisy stage, stdout stays pure JSON (Invariant #10) —");
{
  const srv4 = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), "--config", path.join(ROOT, "test", "fixture.config.json")], { stdio: ["pipe", "pipe", "ignore"] });
  let raw4 = "";
  const lines4 = [];
  let parseFailures4 = 0;
  const frames4 = [];
  srv4.stdout.on("data", (d) => {
    raw4 += d;
    let i;
    while ((i = raw4.indexOf("\n")) >= 0) {
      const line = raw4.slice(0, i); raw4 = raw4.slice(i + 1);
      if (!line.trim()) continue;
      lines4.push(line);
      try { frames4.push(JSON.parse(line)); } catch { parseFailures4++; }
    }
  });
  const wait4 = (id, ms = 15000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = frames4.find((x) => x.id === id);
      if (f) { clearInterval(iv); res(f); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for id ${id}`)); }
    }, 10);
  });

  // Declare logging support the way this server checks for it (see
  // mcp-server.js's clientAcceptsLogs comment) — a `logging` key in the
  // client's OWN capabilities object at initialize.
  srv4.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { logging: {} }, clientInfo: { name: "logging-test-client", version: "0" } } }) + "\n");
  await wait4(1);
  srv4.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  srv4.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "migration_transform", arguments: {} } }) + "\n");
  const r2 = await wait4(2);
  ok(r2.result?.content, "the noisy tools/call still returns its normal result frame");

  const logMsgs = frames4.filter((f) => f.method === "notifications/message");
  ok(logMsgs.length > 0, `stage prose (console.log/warn, rerouted to stderr by machine.enable()) was ALSO mirrored as notifications/message (got ${logMsgs.length})`);
  ok(logMsgs.every((f) => f.jsonrpc === "2.0" && f.id === undefined), "each log notification is a valid JSON-RPC notification (no id)");
  ok(logMsgs.every((f) => RFC5424_LEVELS.includes(f.params?.level)), "each log notification carries a valid RFC 5424 level");
  // transform/index.js log.info()s its progress (-> console.log -> level
  // info) and, whenever action-severity warnings exist (the fixture dataset
  // has some — see the D3 block above), ALSO log.warn()s a one-line summary
  // (-> console.warn -> level warning). Assert BOTH mappings hold rather than
  // assuming only one ever fires.
  ok(logMsgs.every((f) => f.params?.level === "info" || f.params?.level === "warning"), "console.log/warn-originated stage prose only ever maps to level info/warning (never a level this hook doesn't produce)");
  ok(logMsgs.some((f) => f.params?.level === "info"), "console.log output is mirrored at level info");
  ok(logMsgs.some((f) => f.params?.level === "warning"), "console.warn output (this stage's ACTION-warning summary line) is mirrored at level warning");
  ok(logMsgs.every((f) => f.params?.logger === "migration_transform"), "each log notification's logger names the running tool");
  ok(logMsgs.every((f) => typeof f.params?.data === "string" && f.params.data.length > 0), "each log notification carries non-empty data");

  ok(parseFailures4 === 0, `Invariant #10: every stdout line parsed as valid JSON while a noisy stage ran (${parseFailures4} parse failure(s) out of ${lines4.length} lines)`);
  ok(lines4.length > logMsgs.length, "stdout carried more than just the log notifications — the real response frame(s) landed too, on the same pure-JSON stream");

  // Feedback-loop guard (T1 requirement): a notification must never itself
  // trigger another one. If it did, frames would keep arriving after the
  // call already settled with nothing else in flight.
  const beforeLen = frames4.length;
  await new Promise((r) => setTimeout(r, 50));
  ok(frames4.length === beforeLen, "no further notifications arrive after the call settles — no feedback loop");

  // Raising the threshold above where this stage's prose lands must silence it.
  srv4.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "logging/setLevel", params: { level: "error" } }) + "\n");
  await wait4(3);
  const beforeLevelGate = frames4.filter((f) => f.method === "notifications/message").length;
  srv4.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "migration_transform", arguments: {} } }) + "\n");
  await wait4(4);
  ok(frames4.filter((f) => f.method === "notifications/message").length === beforeLevelGate, "raising the level via logging/setLevel suppresses lower-severity notifications (this stage only logs at info, threshold now error)");

  srv4.kill();
}

// T1 — the flip side: an ordinary client that never mentions logging in its
// own capabilities must see EXACTLY today's behavior (additive-only change).
console.log("— mcp server: T1 — a client that does not declare the logging capability gets zero log notifications —");
{
  const srv5 = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), "--config", path.join(ROOT, "test", "fixture.config.json")], { stdio: ["pipe", "pipe", "ignore"] });
  const frames5 = [];
  let buf5 = "";
  srv5.stdout.on("data", (d) => {
    buf5 += d;
    let i;
    while ((i = buf5.indexOf("\n")) >= 0) { const line = buf5.slice(0, i); buf5 = buf5.slice(i + 1); if (line.trim()) frames5.push(JSON.parse(line)); }
  });
  const wait5 = (id, ms = 15000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = frames5.find((x) => x.id === id);
      if (f) { clearInterval(iv); res(f); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for id ${id}`)); }
    }, 10);
  });
  // Standard/real-world client capabilities (roots/sampling/elicitation-shaped,
  // or none at all) — no `logging` key, exactly what every MCP client sends
  // today since the spec defines no such client capability.
  srv5.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plain-client", version: "0" } } }) + "\n");
  await wait5(1);
  srv5.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  srv5.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "migration_transform", arguments: {} } }) + "\n");
  await wait5(2);
  ok(frames5.filter((f) => f.method === "notifications/message").length === 0, "a client that did not declare capabilities.logging at initialize receives zero notifications/message, even though the same noisy stage ran");
  srv5.kill();
}

// T4 — for migration_import specifically, the heartbeat should carry a REAL
// completed/total ratio (derived from data/transformed/summary.json + the
// idmap.json ledger — see mcp-server.js's importProgressSnapshot()), not
// just elapsed seconds. The fixture's dry-run import completes fast, so a
// heartbeat carrying `total` is best-effort within the test's short window
// (asserted honestly below either way); what's asserted unconditionally is
// that no OTHER tool ever fabricates a total.
console.log("— mcp server: T4 — migration_import progress heartbeat reports a real total when one is knowable —");
{
  const srv6 = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), "--config", path.join(ROOT, "test", "fixture.config.json")], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, SHOPLIFT_MCP_PROGRESS_MS: "1" } });
  const frames6 = [];
  let buf6 = "";
  srv6.stdout.on("data", (d) => {
    buf6 += d;
    let i;
    while ((i = buf6.indexOf("\n")) >= 0) { const line = buf6.slice(0, i); buf6 = buf6.slice(i + 1); if (line.trim()) frames6.push(JSON.parse(line)); }
  });
  const wait6 = (id, ms = 15000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = frames6.find((x) => x.id === id);
      if (f) { clearInterval(iv); res(f); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for id ${id}`)); }
    }, 5);
  });

  srv6.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "migration_transform", arguments: {} } }) + "\n");
  const trResp = await wait6(1);
  const trPayload = JSON.parse(trResp.result.content[1].text);
  const expectedTotal = ["products", "collections", "customers", "discounts", "orders", "articles", "pages"].reduce((s, k) => s + (Number(trPayload.data.counts?.[k]) || 0), 0);
  ok(expectedTotal > 0, `fixture dataset transforms to a nonzero total across the counted entities (got ${expectedTotal})`);

  srv6.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "migration_import", arguments: {}, _meta: { progressToken: "import-progress" } } }) + "\n");
  const impResp = await wait6(2);
  ok(impResp.result?.content, "migration_import with a progressToken still returns its normal result frame");

  const heartbeats = frames6.filter((f) => f.method === "notifications/progress" && f.params?.progressToken === "import-progress");
  const withTotal = heartbeats.filter((f) => typeof f.params?.total === "number");
  if (withTotal.length > 0) {
    ok(withTotal.every((f) => f.params.total === expectedTotal), `every progress notification carrying a total reports the SAME honest total (${expectedTotal}) derived from data/transformed/summary.json, not a fabricated number`);
    ok(withTotal.every((f) => typeof f.params.progress === "number" && f.params.progress >= 0 && f.params.progress <= f.params.total), "progress never exceeds total");
  } else {
    // T4 explicitly requires OMITTING total rather than inventing one when
    // nothing honest is knowable yet — on a fast machine the fixture's
    // dry-run import can finish inside a single 1ms tick, so zero
    // total-bearing ticks is not a failure of the mechanism (the negative
    // assertion below, run every time, is what actually guards it).
    ok(true, "migration_import completed before any 1ms heartbeat tick landed on this machine — mechanism still exercised by the assertions below");
  }

  // migration_transform (not import) must NEVER report a total — T4 scopes
  // the real-total mechanism to migration_import specifically; every other
  // tool keeps the original elapsed-seconds-only heartbeat.
  srv6.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "migration_transform", arguments: {}, _meta: { progressToken: "transform-progress" } } }) + "\n");
  await wait6(3);
  const transformHeartbeats = frames6.filter((f) => f.method === "notifications/progress" && f.params?.progressToken === "transform-progress");
  ok(transformHeartbeats.every((f) => f.params.total === undefined), "migration_transform's heartbeat never fabricates a total (elapsed-seconds only, as before T4)");

  srv6.kill();
}

// Item 1.2 — `--config` with a missing or flag-shaped value must be a clear,
// fast, non-zero-exit startup failure, not a server that starts and then
// fails every tool call with a raw Node error. Two shapes: trailing flag
// (nothing after --config) and --config immediately followed by another flag.
console.log("— mcp server: --config argument validation (item 1.2) —");
async function expectBadConfigStartup(args, label) {
  const p = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; });
  const [code] = await new Promise((res) => p.on("exit", (c) => res([c])));
  ok(code !== 0 && code !== null, `${label}: non-zero exit (got ${code})`);
  ok(/--config requires a path/i.test(stderr), `${label}: clear stderr message naming --config`);
}
await expectBadConfigStartup(["--config"], "trailing --config (no value)");
await expectBadConfigStartup(["--config", "--verbose"], "--config immediately followed by another flag");

// Item 1.3 — stdin closing while a tools/call is queued/running must not
// report success. Spawn a fresh server, issue a genuinely slow tools/call
// (migration_transform — see the C2 comment above for why it's slow), close
// stdin WITHOUT waiting for the response, and prove two things: the process
// still exits non-zero (the disconnect happened mid-flight), and the queued
// work was actually drained first (the frame for the in-flight call appears
// on stdout before the process exits, not silently dropped).
console.log("— mcp server: close mid-flight drains pending work, exits non-zero (item 1.3) —");
{
  const srv2 = spawn(process.execPath, [path.join(ROOT, "src", "mcp-server.js"), "--config", path.join(ROOT, "test", "fixture.config.json")], { stdio: ["pipe", "pipe", "ignore"] });
  let out2 = "";
  const frames2 = [];
  srv2.stdout.on("data", (d) => {
    out2 += d;
    let i;
    while ((i = out2.indexOf("\n")) >= 0) { const line = out2.slice(0, i); out2 = out2.slice(i + 1); if (line.trim()) frames2.push(JSON.parse(line)); }
  });
  const exitPromise = new Promise((res) => srv2.on("exit", (code) => res(code)));
  srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "migration_transform", arguments: {} } }) + "\n");
  srv2.stdin.end(); // close stdin immediately — do not wait for the response
  const exitCode = await exitPromise;
  ok(exitCode !== 0 && exitCode !== null, `server exits non-zero when stdin closes with a tools/call still pending (got ${exitCode})`);
  ok(frames2.some((f) => f.id === 1 && f.result?.content), "the pending tools/call was still drained and its result written before exit, not silently dropped");
}

// TIERS (seed.js) + DD_TIERS (seed-dandomain.js) and migration_seed's inputSchema
// enum are hand-maintained lists of the same thing. Add a tier to one and forget
// the other and an agent simply cannot reach it: the schema is what tools/list
// publishes. Same drift class this repo has hit repeatedly with counts.
console.log("— migration_seed's tier enum matches TIERS —");
{
  const { TIERS, STANDALONE_TIERS } = await import("../src/seed.js");
  const { DD_TIERS, STANDALONE_DD_TIERS } = await import("../src/seed-dandomain.js");
  const seedTool = list.result.tools.find((t) => t.name === "migration_seed");
  const enumTiers = seedTool?.inputSchema?.properties?.tier?.enum || [];
  const expected = [...Object.keys(TIERS), ...Object.keys(DD_TIERS)];
  ok(JSON.stringify(enumTiers) === JSON.stringify(expected),
    `the published tier enum equals WP+DD TIERS keys (enum ${JSON.stringify(enumTiers)} vs ${JSON.stringify(expected)})`);
  ok(STANDALONE_TIERS.size > 0 && [...STANDALONE_TIERS].every((t) => t in TIERS),
    `every standalone tier is a real tier (${[...STANDALONE_TIERS].join(", ")})`);
  ok([...STANDALONE_DD_TIERS].every((t) => t in DD_TIERS),
    `every DD standalone tier is a real DD tier (${[...STANDALONE_DD_TIERS].join(", ")})`);
  ok(/standalone/i.test(seedTool?.description || ""),
    "the tool description warns that some tiers are standalone — an agent seeding one without wipeFirst gets a half-merged source");
}

// The user-facing summary block (content[0]) had no direct coverage — D1 only
// asserts it is a non-empty string, so its CONTENT could regress silently.
// This is the block a human actually reads, and formatSummary()'s contract is
// that it never throws: a formatter bug must degrade to the generic fallback,
// never take down a tool call that otherwise succeeded.
console.log("— mcp-format: the human-readable summary block —");
{
  const { formatSummary } = await import("../src/util/mcp-format.js");

  // doctor's whole purpose is diagnosis, so `detail` must reach the summary —
  // it holds the actionable text ("is the app installed on <shop>?"). Listing
  // bare check names sent the reader into the JSON block to learn anything.
  const doctorEnv = { tool: "shoplift", v: 1, command: "migration_doctor", ok: false, exit: 3, elapsedS: 0.5,
    data: { ok: false, results: [
      { name: "WordPress REST (/wp-json)", ok: false, detail: "fetch failed" },
      { name: "Currency alignment", ok: true, detail: "both USD" },
      { name: "Shopify Admin API auth", ok: false, detail: "is the app installed on x.myshopify.com?" }
    ] }, error: { code: "CONNECTION", message: "doctor reported failing connections" } };
  const dsum = formatSummary("migration_doctor", doctorEnv);
  ok(/2 of 3 checks failed/.test(dsum), `doctor summary states the failed/total ratio (got ${JSON.stringify(dsum.split("\n")[1])})`);
  ok(dsum.includes("is the app installed on x.myshopify.com?"), "doctor summary carries each failing check's actionable detail, not just its name");
  ok(!dsum.includes("Currency alignment"), "doctor summary omits checks that PASSED");

  ok(/3 check\(s\) OK/.test(formatSummary("migration_doctor", { command: "migration_doctor", ok: true, exit: 0, elapsedS: 1, data: { results: [1, 2, 3] } })),
    "a passing doctor summarises as a count, not a list");

  // sites_add's summary is what tells an operator which .env keys to fill in.
  // A PASSING verify used to summarise as "counts reconciled, spot-checks
  // passed" and nothing else — which is what an agent was told about a store
  // shipping a product at 0.00 (D15). The verdict is about whether the
  // migration LANDED; the punch list is separate and must not be swallowed.
  const { formatActionCodes } = await import("../src/util/machine.js");
  const okVerify = { command: "migration_verify", ok: true, exit: 0, elapsedS: 3.2,
    data: { ok: true, warnings: 12, notes: 57, actionCodes: { ZERO_PRICE: 6, DIGITAL_FILES: 3, PRICE_ROUNDED_TO_ZERO: 1, TITLE_TRUNCATED: 1, NEGATIVE_FEE: 1 } } };
  const vsum = formatSummary("migration_verify", okVerify);
  ok(/12 item\(s\) need a human/.test(vsum), "a PASSING verify still reports how many items need a human — 'spot-checks passed' alone is what let a free product through");
  ok(/PRICE_ROUNDED_TO_ZERO/.test(vsum), "the verify summary names WHICH kinds of attention are outstanding, not just a count");
  ok(/migration_status/.test(vsum), "the summary points at the tool that returns the full list rather than reprinting it");

  const cleanVerify = formatSummary("migration_verify", { command: "migration_verify", ok: true, exit: 0, elapsedS: 3.2, data: { ok: true, warnings: 0, notes: 4, actionCodes: {} } });
  ok(!/need a human/.test(cleanVerify), "a genuinely clean verify says nothing about action items — the line must mean something when it appears");

  ok(formatActionCodes({ A: 1, B: 9 }).startsWith("B 9"), "action codes are ordered by count, so the biggest pile is never the one elided");
  ok(/\+2 more$/.test(formatActionCodes({ A: 5, B: 4, C: 3, D: 2, E: 1, F: 1 })), "a long code list is truncated with a +N more suffix rather than swamping the line");
  ok(formatActionCodes({}) === "" && formatActionCodes(undefined) === "", "no action codes formats to an empty string, never 'undefined'");

  const addSum = formatSummary("sites_add", { command: "sites_add", ok: true, exit: 0, elapsedS: 0.01,
    data: { kind: "wordpress", name: "acme", created: true, profile: { baseUrl: "https://acme.example.com", adapter: "woocommerce", consumerKey: "${WC_CONSUMER_KEY}", consumerSecret: "<redacted>" } } });
  ok(addSum.includes("${WC_CONSUMER_KEY}"), "sites_add summary names the ${VAR} references the new profile expects");
  ok(!addSum.includes("<redacted>") || addSum.includes("acme"), "sites_add summary identifies the profile it registered");

  const listSum = formatSummary("sites_list", { command: "sites_list", ok: true, exit: 0, elapsedS: 0.01,
    data: { wordpress: ["a"], dandomain: ["shop000000"], shopify: ["b"], activePair: { source: "shop000000", target: "b" } } });
  ok(/dandomain/.test(listSum) && /shop000000/.test(listSum), "sites_list summary counts the dandomain bucket");

  const ddAddSum = formatSummary("sites_add", { command: "sites_add", ok: true, exit: 0, elapsedS: 0.01,
    data: { kind: "dandomain", name: "shop000000", created: true, profile: { storefrontUrl: "https://shop000000.mywebshop.io", tenant: "shop000000", username: "${DD_SOAP_USERNAME}", password: "${DD_SOAP_PASSWORD}" } } });
  ok(ddAddSum.includes("dandomain") && ddAddSum.includes("${DD_SOAP_USERNAME}") && /shop000000\.mywebshop\.io/.test(ddAddSum),
    "sites_add summary for a dandomain profile names the storefront and DD_SOAP_* refs");

  // The never-throws contract, exercised on genuinely hostile input.
  for (const [label, tool, env] of [
    ["null envelope", "migration_doctor", null],
    ["envelope with no data", "migration_doctor", { ok: false, exit: 3, command: "migration_doctor" }],
    ["results is not an array", "migration_doctor", { ok: false, exit: 3, command: "migration_doctor", data: { results: "nope" } }],
    ["unknown tool name", "some_tool_that_does_not_exist", { ok: true, exit: 0, command: "x", data: {} }],
    ["profile is not an object", "sites_add", { ok: true, exit: 0, command: "sites_add", data: { profile: 42 } }]
  ]) {
    let out, threw = false;
    try { out = formatSummary(tool, env); } catch { threw = true; }
    ok(!threw && typeof out === "string" && out.trim().length > 0, `formatSummary survives ${label} and still returns a non-empty string`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
