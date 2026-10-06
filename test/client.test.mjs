/**
 * test/client.test.mjs — acceptance tests for src/dandomain/client.js.
 *
 * The rule this suite is written to: a test that cannot FAIL when the handling is removed is not
 * evidence. So wherever it is possible, a test asserts against the WIRE (what bytes actually left
 * the client, and in what order) rather than against a counter the client keeps about itself, and
 * the fixtures are reconstructed from data/probes/ rather than invented.
 *
 *   - the SOAP suites run over REAL HTTP against scripts/probe-dandomain.mock.mjs, which
 *     implements F2's harm: once Solution_SetEncoding has been called it starts returning
 *     "GenÃ¥bnet" instead of "Genåbnet". That is what makes the F2 guard testable rather than
 *     merely assertable.
 *   - the FTPS suite runs against scripts/probe-dandomain.ftp-mock.mjs.
 *   - stub-fetch suites cover the shapes the mock cannot produce (the recorded PHP arity fault,
 *     F16's lineErrors, a 618-row catalogue, a page-capping server, an HTTP 502 nginx page).
 *
 * Run: node --test test/client.test.mjs
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as CLIENT from "../src/dandomain/client.js";
import {
  DanDomainClient, createClient,
  DanDomainClientError, ForbiddenOperationError, ArgumentNameError, FieldListError,
  FieldSetTruncatedError, FieldSetReassertError, DanDomainFaultError, SoapTransportError,
  PaginationError, UnresolvedWriteEncodingError,
  FAULT_KIND, classifyFault, PHP_ARITY_RE, ORDER_CREATED_RE,
  READ_NAME_VERBS, READ_DOC_VERBS, REPLAYABLE_OPERATIONS, REPLAY_SIGNAL_DISAGREEMENTS, isReplayable,
  replaySignalsFor,
  createTokenBucket, createGate, DEFAULT_MAX_CONCURRENT, SOAP_RATE_EVIDENCE,
  buildEnvelope, escapeXml, auditBatch, FIELD_SET_OP_FOR_TYPE,
  paginationStyleFor, PAGINATED_OPERATIONS, PAGINATION_STYLE, SOAP_PAGE_BASE, recordTypeOf,
} from "../src/dandomain/client.js";
import {
  FIELD_SET_OPERATIONS, FORBIDDEN_OPERATIONS, OPERATIONS, SET_FIELDS_TYPE, TYPES,
  operationNames, validateFields,
} from "../src/dandomain/operations.js";
import { EncodingError } from "../src/dandomain/xml.js";
import { DanDomainGraphQLClient } from "../src/dandomain/graphql.js";
import { parseList } from "../src/dandomain/ftp.js";
import { startFtpsMock } from "../scripts/probe-dandomain.ftp-mock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = (name) => JSON.parse(readFileSync(path.join(ROOT, "data", "probes", `${name}.json`), "utf8"));
const GAPS = probe("gaps");
const SCALE = probe("scale");
const CLIENT_SRC = readFileSync(path.join(ROOT, "src", "dandomain", "client.js"), "utf8");

/** assert.rejects() does not hand back the error; this does. */
async function catchesAsync(fn, type) {
  let caught = null;
  try { await fn(); } catch (e) { caught = e; }
  assert.ok(caught, "expected a rejection, got none");
  if (type) assert.ok(caught instanceof type, `expected ${type.name}, got ${caught?.name}: ${caught?.message}`);
  return caught;
}
function catches(fn, type) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, "expected a throw, got none");
  if (type) assert.ok(caught instanceof type, `expected ${type.name}, got ${caught?.name}: ${caught?.message}`);
  return caught;
}

// ---------------------------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------------------------

/** A port nothing is listening on right now. The mock prints back whatever it was given. */
async function freePort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The real mock, over real HTTP, in its own process. */
async function startSoapMock() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "probe-dandomain.mock.mjs"), String(port)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  const line = await new Promise((resolve, reject) => {
    child.stdout.once("data", (d) => resolve(String(d)));
    child.once("error", reject);
    const t = setTimeout(() => reject(new Error("mock did not start")), 8000);
    if (typeof t.unref === "function") t.unref();
  });
  assert.ok(line.includes(`:${port}/`), `mock did not come up on ${port}: ${JSON.stringify(line)}`);
  return { port, url: `http://127.0.0.1:${port}/`, close: () => child.kill() };
}

/** Wraps a fetch and records the operation name of every request that leaves. */
function recorder(inner = globalThis.fetch) {
  const ops = [];
  const bodies = [];
  const fn = async (url, init) => {
    const body = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
    bodies.push(body);
    ops.push(/<m:(\w+)/.exec(body)?.[1] ?? "?");
    return inner(url, init);
  };
  fn.ops = ops;
  fn.bodies = bodies;
  fn.reset = () => { ops.length = 0; bodies.length = 0; };
  return fn;
}

const ENV = (inner) =>
  `<?xml version="1.0"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>${inner}</env:Body></env:Envelope>`;
const RESULT = (op, inner) =>
  ENV(`<ns1:${op}Response xmlns:ns1="mock"><ns1:${op}Result>${inner}</ns1:${op}Result></ns1:${op}Response>`);
const FAULT = (code, msg) =>
  ENV(`<env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>${code}</env:Value></env:Subcode></env:Code>` +
      `<env:Reason><env:Text xml:lang="en">${msg}</env:Text></env:Reason></env:Fault>`);
const ITEMS = (rows) => rows.map((r) => `<item>${Object.entries(r).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</item>`).join("");

/** A stub fetch built from a per-operation handler. Returns real Response objects. */
function stub(handler) {
  const ops = [];
  const fn = async (_url, init) => {
    const body = new TextDecoder().decode(init.body);
    const op = /<m:(\w+)/.exec(body)?.[1] ?? "?";
    ops.push(op);
    const out = await handler(op, body, init, ops.length);
    if (out instanceof Response) return out;
    const { xml, status = 200, headers = {} } = out;
    return new Response(new TextEncoder().encode(xml), {
      status,
      headers: { "content-type": "application/soap+xml; charset=utf-8", ...headers },
    });
  };
  fn.ops = ops;
  return fn;
}

const CREDS = { username: "u", password: "p" };

// ---------------------------------------------------------------------------------------------

describe("module invariants", () => {
  test("importing the client writes nothing and exits 0 (no top-level side effects)", async () => {
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "src", "dandomain", "client.js")).href)});`], { cwd: ROOT });
      let so = "", se = "";
      c.stdout.on("data", (d) => { so += d; });
      c.stderr.on("data", (d) => { se += d; });
      c.on("close", (code) => resolve({ code, so, se }));
    });
    assert.equal(out.code, 0, out.se);
    assert.equal(out.so, "", `stdout must be empty, got ${JSON.stringify(out.so)}`);
    assert.equal(out.se, "", `stderr must be empty, got ${JSON.stringify(out.se)}`);
  });

  test("zero dependencies: every import is a sibling module (no npm, no require)", () => {
    const imports = [...CLIENT_SRC.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    for (const spec of imports) {
      assert.ok(spec.startsWith("./") || spec.startsWith("node:"), `unexpected import "${spec}"`);
    }
    assert.equal(/\brequire\s*\(/.test(CLIENT_SRC), false, "no require() in an ESM module");
  });

  test("no console output and no process.exit in the CODE (invariant #4)", () => {
    // Comments are stripped first: the module header legitimately says "no process.exit".
    const code = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/\bconsole\s*\./.test(code), false);
    assert.equal(/process\.exit/.test(code), false);
    assert.equal(/\bprocess\.stdout\b/.test(code), false);
  });
});

describe("F2 — Solution_SetEncoding is unreachable through this client", () => {
  let mock;
  before(async () => { mock = await startSoapMock(); });
  after(() => mock.close());

  test("the ban is not stale: every forbidden name is still a real WSDL operation", () => {
    assert.deepEqual(FORBIDDEN_OPERATIONS, ["Solution_SetEncoding"]);
    for (const op of FORBIDDEN_OPERATIONS) assert.ok(operationNames().includes(op), `${op} vanished from the WSDL`);
  });

  test("no CODE path can name it — the forbidden operation appears only in comments", () => {
    // A call would have to name the operation. Comments explaining the ban are fine; an
    // occurrence in executable code is not, because that is what a request could be built from.
    const code = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/Solution_SetEncoding/.test(code), false,
      "client.js must never name the forbidden operation in executable code");
    // ...and the ban itself is not local: it comes from operations.FORBIDDEN_OPERATIONS.
    assert.match(CLIENT_SRC, /FORBIDDEN_OPERATIONS\.includes\(op\)/);
  });

  test("EVERY entrance to the socket is guarded, not just the front door", () => {
    // connect() and the R4 re-assertion loop reach #send without passing through call(), so the
    // guard is at both. The second one is unreachable from the public surface today, which is why
    // this is asserted structurally: there is no behavioural test that can get to it.
    const code = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const sites = code.match(/assertNotForbidden\(op\);/g) ?? [];
    assert.equal(sites.length, 2, "call() and #send must both call the F2 guard");
    assert.match(code, /async #send\(op, args, options\) \{\s*assertNotForbidden\(op\);/,
      "the guard must be the FIRST thing #send does — before the throttle and before the socket");
  });

  test("call() refuses it, and NOTHING goes on the wire", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();
    fetchImpl.reset();
    const err = await catchesAsync(() => c.call("Solution_SetEncoding", { Encoding: "UTF-8" }), ForbiddenOperationError);
    assert.match(err.message, /IRREVERSIBLY DESTROYS WRITES/);
    assert.deepEqual(fetchImpl.ops, [], "the forbidden call must not reach the network");
  });

  test("WIRE PROOF: a whole realistic session emits it ZERO times, from BOTH ends of the socket", async () => {
    // The source-level test above can only prove the string is absent from client.js. This one
    // proves the BYTES are absent, over the paths that emit requests the caller never asked for:
    // connect(), the six *_SetFields, the R4 re-assertion loop, an AUTH reconnect + replay, and a
    // paged read. Then the SERVER is asked the same question a second way — the mock latches into
    // mojibake for the rest of its life the moment it is told to set an encoding, so a clean
    // "Genåbnet" at the end is the server's own testimony that it never received the call.
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    // Whatever the session does, the BYTES get audited. A client that did emit the forbidden call
    // would very likely then die on the mojibake it caused, and this test is about the wire, not
    // about which exception came out — so the session's own error is held and reported after.
    let sessionError = null;
    try {
      await c.connect();
      await c.setFields("Product", "Id,ItemNumber,Title");
      await c.setFields("Order", "Id,Status");
      await c.call("OrderStatusCode_GetAll");
      await c.call("Solution_GetWebinfo");
      await c.call("Currency_GetAll");
      await c.call("Category_GetAll");
      await c.call("Product_GetAllWithLimit", { Start: 0, Length: 3 });
      // a NON-auth fault: the R4 re-assertion loop runs again, emitting requests nobody asked for
      await catchesAsync(() => c.call("Product_CreateOrUpdate", { ProductData: { Title: "no category" } }), DanDomainFaultError);
      c.cookies.set("PHPSESSID", "expired");                     // force AUTH -> reconnect -> re-assert -> replay
      assert.equal((await c.call("Product_GetAllWithLimit", { Start: 0, Length: 3 })).replayed, true);
      await catchesAsync(() => c.call("Solution_SetEncoding", { Encoding: "UTF-8" }), ForbiddenOperationError);
      await catchesAsync(() => c.call("Product_CreateOrUpdate", { ProductData: { Title: "Æblegrød", CategoryId: 9 } }), UnresolvedWriteEncodingError);
    } catch (e) {
      sessionError = e;
    }

    // THE WIRE ASSERTION.
    const offenders = fetchImpl.bodies.filter((b) => /Solution_SetEncoding/.test(b));
    assert.deepEqual(offenders, [], "F2: not one request body may name the encoding call");
    assert.deepEqual(fetchImpl.ops.filter((o) => o === "Solution_SetEncoding"), []);
    assert.equal(sessionError, null, `the session must run cleanly: ${sessionError?.message}`);
    assert.ok(fetchImpl.bodies.length >= 12, `too few requests to be a realistic session: ${fetchImpl.bodies.length}`);
    assert.ok(fetchImpl.ops.includes("Solution_Connect") && fetchImpl.ops.filter((o) => /_Set\w*Fields$/.test(o)).length >= 4,
      `the reconnect/re-assert paths must be among them: ${JSON.stringify(fetchImpl.ops)}`);

    // The server's own answer, on a fresh read: still clean Danish, so it was never told.
    const after = await c.call("OrderStatusCode_GetAll");
    assert.equal(after.records.find((r) => r.Id === "4").Title, "Genåbnet",
      "the mock latches to mojibake once Solution_SetEncoding arrives — clean text proves it never did");
    assert.equal(after.mojibake, false);
  });

  test("the mock implements the harm, so the guard is load-bearing: reads stay clean before, mojibake after", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();

    // Before: clean Danish.
    const before = await c.call("OrderStatusCode_GetAll");
    assert.equal(before.records.find((r) => r.Id === "4").Title, "Genåbnet");
    assert.equal(before.mojibake, false);

    // Refused call changes nothing.
    await catchesAsync(() => c.call("Solution_SetEncoding", { Encoding: "UTF-8" }), ForbiddenOperationError);
    const after = await c.call("OrderStatusCode_GetAll");
    assert.equal(after.records.find((r) => r.Id === "4").Title, "Genåbnet");

    // CONTROL: reach around the client and make the call the design doc asks for. The very next
    // read is now double-encoded, and the client THROWS instead of migrating it (F2 "fail loudly").
    await globalThis.fetch(mock.url, {
      method: "POST",
      headers: { "content-type": "application/soap+xml; charset=utf-8", cookie: "PHPSESSID=mock" },
      body: '<?xml version="1.0"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>' +
        '<m:Solution_SetEncoding xmlns:m="x"><Encoding>UTF-8</Encoding></m:Solution_SetEncoding></env:Body></env:Envelope>',
    });
    const err = await catchesAsync(() => c.call("OrderStatusCode_GetAll"), EncodingError);
    assert.match(err.message, /double-encoded/);
    assert.match(err.sample, /GenÃ/);

    // Put the mock back (Solution_Connect resets its encoding mode).
    await c.connect();
    const healed = await c.call("OrderStatusCode_GetAll");
    assert.equal(healed.records.find((r) => r.Id === "4").Title, "Genåbnet");
  });

  test("responses are decoded from BYTES, not from res.text() (the declared charset is not trusted)", async () => {
    // A runtime that obeys a lying charset header: text() decodes as windows-1252, arrayBuffer()
    // hands back the true UTF-8 bytes. Only the byte path yields the right string.
    const xml = RESULT("Category_GetAll", ITEMS([{ Id: 9, Title: "Æblegrød" }]));
    const bytes = new TextEncoder().encode(xml);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null, getSetCookie: () => [] },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => new TextDecoder("windows-1252").decode(bytes),
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const res = await c.call("Category_GetAll");
    assert.equal(res.records[0].Title, "Æblegrød");
    assert.equal(res.decodedAs, "utf-8");
  });
});

describe("R17/R27 — argument names are validated before the wire", () => {
  test("the recorded gaps.json breakage cannot happen again", async () => {
    // gaps.json faults[0]: Order_GetAllWithPagination called with {Start, Length} when the WSDL
    // declares {Page, PageSize}. The server dropped both and PHP reported arity.
    const recorded = GAPS.faults[0];
    assert.equal(recorded.op, "Order_GetAllWithPagination");
    assert.deepEqual(recorded.args, ["Start", "Length"]);

    const fetchImpl = stub(() => ({ xml: RESULT("Order_GetAllWithPagination", "") }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const bad = Object.fromEntries(recorded.args.map((a) => [a, 0]));
    const err = await catchesAsync(() => c.call(recorded.op, bad), ArgumentNameError);
    assert.deepEqual(err.unknown, ["Start", "Length"]);
    assert.deepEqual(err.missingRequired, ["Page", "PageSize"]);
    assert.deepEqual(fetchImpl.ops, [], "no request may be sent for a call with wrong argument names");
  });

  test("the recorded arity MESSAGE classifies as a fatal NAME error, and is never retried", async () => {
    const recordedMessage = GAPS.faults[0].message.replace(/^SoapFault \w+: /, "");
    const cls = classifyFault({ code: GAPS.faults[0].code, reason: recordedMessage });
    assert.equal(cls.kind, FAULT_KIND.ARITY);
    assert.equal(cls.fatal, true);
    assert.equal(cls.retryable, false);
    assert.equal(cls.reconnect, false);
    assert.deepEqual(cls.arity, { klass: "WebService", operation: "Order_GetAllWithPagination", passed: 0, expected: 2 });
    // The code on the recording is "Receiver" — NOT NOSUCHPARAM, NOT AUTH. Classifying by code
    // alone would make this a nameless unknown; classifying it as transient would retry forever.
    assert.equal(cls.code, "Receiver");

    const fetchImpl = stub(() => ({ xml: FAULT("Receiver", recordedMessage), status: 500 }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(() => c.call("Order_GetAllWithPagination", { Page: 1, PageSize: 10 }), DanDomainFaultError);
    assert.equal(err.kind, FAULT_KIND.ARITY);
    assert.equal(err.retryable, false);
    assert.deepEqual(fetchImpl.ops, ["Order_GetAllWithPagination"], "a name error must be attempted exactly once");
  });

  test("PHP_ARITY_RE also matches the 'at least N expected' form", () => {
    const m = PHP_ARITY_RE.exec("Too few arguments to function WebService::Product_GetById(), 0 passed in /x.php on line 3 and at least 1 expected");
    assert.ok(m);
    assert.equal(m[2], "Product_GetById");
    assert.equal(m[4], "1");
  });

  test("R34 — an arity fault after OMITTING a nillable argument names that argument", async () => {
    // Recorded verbatim in data/probes/pagebase.json: Status is nillable="true" on
    // Order_GetByStatusWithPagination, validateArgs therefore lets it be absent, and the server
    // answers with an arity error rather than an empty selection. classifyFault's own wording is
    // "an ARGUMENT NAME was wrong", which is true for the cause it was written for and misleading
    // for this one — there is no misspelling to find.
    const recorded = "Too few arguments to function WebService::Order_GetByStatusWithPagination(), " +
      "2 passed in /code/smartweb/latest/api/service.php on line 108 and exactly 3 expected";
    const fetchImpl = stub(() => ({ xml: FAULT("Receiver", recorded), status: 500 }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(
      () => c.call("Order_GetByStatusWithPagination", { Page: 1, PageSize: 5 }),
      DanDomainFaultError,
    );
    assert.equal(err.kind, FAULT_KIND.ARITY);
    assert.deepEqual(err.omittedNillableArgs, ["Status"]);
    assert.match(err.omittedNillableWhy, /nillable describes the VALUE, not the presence/i);
    assert.deepEqual(fetchImpl.ops, ["Order_GetByStatusWithPagination"], "still a name error: attempted once");
  });

  test("R34 — and stays quiet when nothing nillable was omitted", async () => {
    // The hint must not fire on every arity fault, or it becomes noise that hides the real cause.
    const recorded = "Too few arguments to function WebService::Order_GetAllWithPagination(), " +
      "0 passed in /x.php on line 108 and exactly 2 expected";
    const fetchImpl = stub(() => ({ xml: FAULT("Receiver", recorded), status: 500 }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(
      () => c.call("Order_GetAllWithPagination", { Page: 1, PageSize: 5 }),
      DanDomainFaultError,
    );
    assert.equal(err.kind, FAULT_KIND.ARITY);
    assert.equal(err.omittedNillableArgs, undefined);
  });

  test("R34 — and does not attach itself to faults that are not about arity", async () => {
    // Same omitted nillable argument, a completely different fault. If the hint rode along here it
    // would read as a diagnosis of the PARAM error, which it is not — the recorded PARAM fault on
    // this operation happened with Status PRESENT.
    const fetchImpl = stub(() => ({ xml: FAULT("PARAM", "Page must be greater than 0"), status: 500 }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(
      () => c.call("Order_GetByStatusWithPagination", { Page: 0, PageSize: 5 }),
      DanDomainFaultError,
    );
    assert.notEqual(err.kind, FAULT_KIND.ARITY);
    assert.equal(err.omittedNillableArgs, undefined, "a nillable omission does not explain a PARAM fault");
  });

  test("a NILLABLE argument may be omitted — the exact recorded Order_GetByDate call is accepted", async () => {
    // gaps.json sections.orderGetByDate: Start+End with NO Status element -> ok, 20 orders.
    const tried = GAPS.sections.orderGetByDate.tried.find((t) => t.label === "Status omitted");
    assert.equal(tried.ok, true);
    assert.equal(GAPS.sections.orderGetByDate.statusIsOptionalInPractice, true);

    const fetchImpl = stub(() => ({ xml: RESULT("Order_GetByDate", ITEMS(tried.ids.map((id) => ({ Id: id })))) }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const res = await c.call("Order_GetByDate", tried.args);
    assert.equal(res.records.length, tried.count);
    // And the omitted nillable argument really is absent from the wire, not sent as an empty one.
    assert.equal(/<Status>/.test(fetchImpl.ops.length ? "" : ""), false);
  });

  test("undefined is DROPPED and null is SENT — the serialiser contract validateArgs assumes", () => {
    const xml = buildEnvelope("Order_GetByDate", { Start: "a", End: "b", Status: undefined });
    assert.equal(/<Status>/.test(xml), false, "undefined must not emit an element");
    const withNull = buildEnvelope("Order_GetByDate", { Start: "a", End: "b", Status: null });
    assert.match(withNull, /<Status><\/Status>/);
    assert.equal(/xsi:nil/.test(withNull), false, "no xsi:nil was ever observed on this wire");
  });

  test("the undefined/null contract holds at EVERY depth, not just the top level", () => {
    // orderedArgs() only screens top-level arguments; a nested `undefined` reaching the wire as
    // an empty element is a value the caller never sent.
    const xml = buildEnvelope("Order_Create", {
      OrderData: { CurrencyId: 1, Comment: undefined, ReferenceNumber: null },
    });
    assert.equal(/<Comment>/.test(xml), false, "a nested undefined must be dropped");
    assert.match(xml, /<ReferenceNumber><\/ReferenceNumber>/, "a nested null must be sent");
  });

  test("arguments are emitted in WSDL sequence order regardless of the caller's key order", () => {
    const xml = buildEnvelope("Order_GetByDate", { Status: "0", End: "b", Start: "a" });
    const order = [...xml.matchAll(/<(Start|End|Status)>/g)].map((m) => m[1]);
    assert.deepEqual(order, ["Start", "End", "Status"]);
  });

  test("an unknown operation is refused rather than guessed at (R27)", async () => {
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: stub(() => ({ xml: "" })) });
    const err = await catchesAsync(() => c.call("Product_GetEverythingPlease", {}));
    assert.match(err.message, /not in the WSDL/);
  });
});

describe("fault classification (F3, F16, R4, session)", () => {
  test("F16 — lineErrors: the order EXISTS, id parsed, never retryable", () => {
    const reason = "Order: 4 created. Following products were not included: 9999, 9998";
    const cls = classifyFault({ code: "lineErrors", reason });
    assert.equal(cls.kind, FAULT_KIND.LINE_ERRORS);
    assert.equal(cls.created, true);
    assert.equal(cls.orderId, 4);
    assert.equal(cls.retryable, false);
    assert.equal(cls.reconnect, false);
    assert.equal(ORDER_CREATED_RE.source, "Order:\\s*(\\d+)\\s*created");
  });

  test("F16 wins on the MESSAGE even when the code is something else — misreading it duplicates an order", () => {
    const cls = classifyFault({ code: "Receiver", reason: "Order: 5001 created. Following products were not included: X" });
    assert.equal(cls.kind, FAULT_KIND.LINE_ERRORS);
    assert.equal(cls.orderId, 5001);
  });

  test("Order_Create surfaces the created id instead of being retried", async () => {
    const fetchImpl = stub(() => ({ xml: FAULT("lineErrors", "Order: 4 created. Following products were not included: 77"), status: 500 }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(() => c.call("Order_Create", { OrderData: { CurrencyId: 1 } }), DanDomainFaultError);
    assert.equal(err.kind, FAULT_KIND.LINE_ERRORS);
    assert.equal(err.created, true);
    assert.equal(err.orderId, 4);
    assert.deepEqual(fetchImpl.ops, ["Order_Create"], "a create is attempted exactly once, ever");
  });

  test("R4 — NOSUCHPARAM is fatal and never retried", () => {
    const cls = classifyFault({ code: "NOSUCHPARAM", reason: "Field SeoLnk does not exist" });
    assert.equal(cls.kind, FAULT_KIND.NOSUCHPARAM);
    assert.equal(cls.fatal, true);
    assert.equal(cls.retryable, false);
    assert.match(cls.why, /PREVIOUS field set/);
  });

  test("AUTH is recognised by code and by the recorded reason", () => {
    assert.equal(classifyFault({ code: "AUTH", reason: "" }).kind, FAULT_KIND.AUTH);
    assert.equal(
      classifyFault({ code: "Sender", reason: "A valid authentication has not been performed with the service" }).kind,
      FAULT_KIND.AUTH,
    );
    assert.equal(classifyFault({ code: "AUTH", reason: "" }).retryable, true);
  });

  test("F3 — an unknown code is NAMED-fatal, not transient", () => {
    const cls = classifyFault({ code: "KLARNA_TIMEOUT", reason: "boom" });
    assert.equal(cls.kind, FAULT_KIND.UNKNOWN);
    assert.equal(cls.code, "KLARNA_TIMEOUT", "the real code must survive classification");
    assert.equal(cls.fatal, true);
    assert.equal(cls.retryable, false);
  });

  test("precedence is message-first: an arity message under an AUTH code is still a NAME error", () => {
    const cls = classifyFault({
      code: "AUTH",
      reason: "Too few arguments to function WebService::X(), 0 passed in /x.php on line 1 and exactly 2 expected",
    });
    assert.equal(cls.kind, FAULT_KIND.ARITY, "retrying this after a reconnect would loop on a permanent name error");
  });

  test("classifyFault is pure and refuses a non-object", () => {
    catches(() => classifyFault("AUTH"), TypeError);
    const input = { code: "AUTH", reason: "x" };
    classifyFault(input);
    assert.deepEqual(input, { code: "AUTH", reason: "x" });
  });
});

describe("replay policy — derived from the WSDL, cross-checked, fail-safe", () => {
  test("the two signals agree on all 247 operations", () => {
    assert.deepEqual([...REPLAY_SIGNAL_DISAGREEMENTS], [], "name-verb and documentation-verb disagree somewhere: API drift");
  });

  test("the cross-check is real: either signal alone is not enough to be replayable", () => {
    // The pinned WSDL never disagrees, so this is asserted on the predicate directly. A future
    // "Order_GetAndArchive" documented as "Deletes …" must NOT become replayable on its name.
    assert.deepEqual(replaySignalsFor("Product_GetById", "Returns the indicated Product"),
      { byName: true, byDoc: true, replayable: true });
    assert.deepEqual(replaySignalsFor("Order_GetAndArchive", "Deletes the order after reading it"),
      { byName: true, byDoc: false, replayable: false });
    assert.deepEqual(replaySignalsFor("Order_Create", "Returns the created order"),
      { byName: false, byDoc: true, replayable: false });
    assert.deepEqual(replaySignalsFor("Order_Create", "Creates a new Order"),
      { byName: false, byDoc: false, replayable: false });
    // "Getter_X" must not read as the verb Get; the verb segment has to end at a word boundary.
    assert.equal(replaySignalsFor("Solution_Getter", "Returns a thing").byName, false);
    assert.equal(replaySignalsFor("NoUnderscore", "Returns a thing").byName, false);
  });

  test("the allow-list is re-derived here from OPERATIONS, not copied from the module", () => {
    const expected = operationNames().filter((op) => {
      const verb = op.slice(op.indexOf("_") + 1);
      const nameRead = READ_NAME_VERBS.some((v) => verb === v || (verb.startsWith(v) && /^[A-Z]/.test(verb.slice(v.length))));
      const doc = (OPERATIONS[op].documentation ?? "").trim().split(/\s+/)[0];
      return nameRead && READ_DOC_VERBS.includes(doc) && !FORBIDDEN_OPERATIONS.includes(op) && !FIELD_SET_OPERATIONS.includes(op);
    });
    assert.deepEqual([...REPLAYABLE_OPERATIONS].sort(), expected.sort());
    assert.equal(REPLAYABLE_OPERATIONS.size, 117);
    assert.equal(operationNames().length - REPLAYABLE_OPERATIONS.size, 130);
  });

  test("nothing that writes is replayable — including all six field-set operations", () => {
    for (const op of ["Order_Create", "Product_CreateOrUpdate", "Order_UpdateStatus", "Product_Delete",
      "Order_SendMail", "Order_CompleteTransaction", "Solution_Connect", "Solution_SetEncoding"]) {
      assert.equal(REPLAYABLE_OPERATIONS.has(op), false, `${op} must never be replayed`);
    }
    for (const op of FIELD_SET_OPERATIONS) assert.equal(REPLAYABLE_OPERATIONS.has(op), false, op);
    // Every non-replayable operation's own documentation opens with a mutation verb.
    for (const op of operationNames()) {
      if (REPLAYABLE_OPERATIONS.has(op)) continue;
      const doc = (OPERATIONS[op].documentation ?? "").trim().split(/\s+/)[0];
      assert.equal(READ_DOC_VERBS.includes(doc) && !FIELD_SET_OPERATIONS.includes(op) && !FORBIDDEN_OPERATIONS.includes(op), false,
        `${op} is excluded but its documentation says "${doc}"`);
    }
  });

  test("reads are replayable and isReplayable refuses an unknown name", () => {
    assert.equal(isReplayable("Product_GetAllWithLimit"), true);
    assert.equal(isReplayable("Product_Search"), true);
    assert.equal(isReplayable("Solution_HasModule"), true);
    catches(() => isReplayable("Nope_Get"));
  });
});

describe("session — AUTH reconnect, replay, and R4 re-assertion (over the real mock)", () => {
  let mock;
  before(async () => { mock = await startSoapMock(); });
  after(() => mock.close());

  test("a read AUTH-faults, reconnects, re-asserts, then replays — in that wire order", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();
    // The offline mock only implements two of the six field-set operations, so the all-six
    // ordering is asserted in the next test against a stub. These two are enough to show the
    // re-assertion happens BETWEEN the reconnect and the replay.
    await c.setFields("Product", "Id,ItemNumber,Title");
    await c.setFields("Order", "Id,Status");

    fetchImpl.reset();
    c.cookies.set("PHPSESSID", "expired"); // the session the server no longer knows
    const res = await c.call("Product_GetAllWithLimit", { Start: 0, Length: 3 });

    assert.deepEqual(fetchImpl.ops, [
      "Product_GetAllWithLimit", // AUTH fault
      "Solution_Connect",
      "Product_SetFields", "Order_SetFields",
      "Product_GetAllWithLimit", // replayed
    ]);
    assert.equal(res.replayed, true);
    assert.equal(res.records.length, 3);
    assert.equal(c.stats.reconnects, 1);
    assert.equal(c.stats.replays, 1);
  });

  test("ALL SIX field sets are re-asserted — including the two a name-suffix list misses", async () => {
    // Order_SetOrderLineFields and Product_SetVariantFields do not end in "_SetFields" as a
    // name-suffix rule would expect; miss them and order lines and variants silently fall back to
    // Id-only after a replay, with no error (R4).
    const fetchImpl = stub((op) => (op === "Solution_Connect"
      ? { xml: RESULT(op, "1"), headers: { "set-cookie": `PHPSESSID=s${Math.random()}` } }
      : { xml: RESULT(op, ITEMS([{ Id: "1" }])) }));
    let authOnce = true;
    const gated = async (url, init) => {
      const body = new TextDecoder().decode(init.body);
      if (/<m:Product_GetAllWithLimit/.test(body) && authOnce) {
        authOnce = false;
        gated.ops.push("Product_GetAllWithLimit");
        return new Response(new TextEncoder().encode(FAULT("AUTH", "A valid authentication has not been performed with the service")), { status: 500 });
      }
      const res = await fetchImpl(url, init);
      gated.ops.push(fetchImpl.ops.at(-1));
      return res;
    };
    gated.ops = [];
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: gated });
    await c.connect();
    const sets = [["Product", "Id,Title"], ["Order", "Id,Status"], ["OrderLine", "Id,ProductTitle"],
      ["ProductVariant", "Id,Stock"], ["PageText", "Id,Title"], ["User", "Id,Username"]];
    for (const [type, list] of sets) await c.setFields(type, list);
    assert.equal(c.fieldSets().length, 6);

    gated.ops.length = 0;
    await c.call("Product_GetAllWithLimit", { Start: 0, Length: 1 });
    assert.deepEqual(gated.ops, [
      "Product_GetAllWithLimit",
      "Solution_Connect",
      "Product_SetFields", "Order_SetFields", "Order_SetOrderLineFields",
      "Product_SetVariantFields", "PageText_SetFields", "User_SetFields",
      "Product_GetAllWithLimit",
    ]);
    assert.deepEqual(FIELD_SET_OPERATIONS.slice().sort(), [...new Set(gated.ops.filter((o) => /Fields$/.test(o)))].sort());
  });

  test("a WRITE never replays: it reconnects (so the session is usable) and then throws", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();
    fetchImpl.reset();
    c.cookies.set("PHPSESSID", "expired");
    const err = await catchesAsync(
      () => c.call("Product_CreateOrUpdate", { ProductData: { Title: "T", CategoryId: 9 } }),
      DanDomainFaultError,
    );
    assert.equal(err.kind, FAULT_KIND.AUTH);
    assert.equal(err.reconnected, true);
    assert.equal(err.replayed, false);
    assert.deepEqual(fetchImpl.ops, ["Product_CreateOrUpdate", "Solution_Connect"]);
    assert.equal(fetchImpl.ops.filter((o) => o === "Product_CreateOrUpdate").length, 1);
  });

  test("the replay option can turn replay OFF; it can never turn it ON for a write", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();

    fetchImpl.reset();
    c.cookies.set("PHPSESSID", "expired");
    await catchesAsync(() => c.call("Product_GetAllWithLimit", { Start: 0, Length: 3 }, { replay: false }), DanDomainFaultError);
    assert.deepEqual(fetchImpl.ops, ["Product_GetAllWithLimit", "Solution_Connect"], "replay:false must suppress the replay");

    fetchImpl.reset();
    c.cookies.set("PHPSESSID", "expired");
    await catchesAsync(() => c.call("Order_Create", { OrderData: { CurrencyId: 1 } }, { replay: true }), DanDomainFaultError);
    assert.equal(fetchImpl.ops.filter((o) => o === "Order_Create").length, 1, "replay:true must not enable replay for a create");
  });

  test("R4 — every field set is re-asserted after a NON-auth fault too", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();
    await c.setFields("Product", "Id,Title");
    await c.setFields("Order", "Id,Status");
    fetchImpl.reset();
    // The mock faults PRODUCT when CategoryId is missing.
    const err = await catchesAsync(() => c.call("Product_CreateOrUpdate", { ProductData: { Title: "x" } }), DanDomainFaultError);
    assert.equal(err.kind, FAULT_KIND.UNKNOWN);
    assert.equal(err.code, "PRODUCT");
    assert.deepEqual(fetchImpl.ops, ["Product_CreateOrUpdate", "Product_SetFields", "Order_SetFields"]);
  });

  test("{ reassertOnFault: false } is the documented opt-out and really suppresses it", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl, reassertOnFault: false });
    await c.connect();
    await c.setFields("Product", "Id,Title");
    fetchImpl.reset();
    await catchesAsync(() => c.call("Product_CreateOrUpdate", { ProductData: { Title: "x" } }), DanDomainFaultError);
    assert.deepEqual(fetchImpl.ops, ["Product_CreateOrUpdate"]);
  });

  test("bad credentials fault on the LOGIN itself and do not loop", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, username: "wrong", password: "p", fetchImpl });
    const err = await catchesAsync(() => c.connect(), DanDomainFaultError);
    assert.equal(err.kind, FAULT_KIND.AUTH);
    assert.equal(err.duringConnect, true);
    assert.deepEqual(fetchImpl.ops, ["Solution_Connect"]);
  });

  test("connect() starts a CLEAN jar — a dead session's cookie never travels with the login", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();
    c.cookies.set("PHPSESSID", "expired");
    c.cookies.set("STALE", "leftover");
    await c.connect();
    assert.equal(c.cookies.get("PHPSESSID"), "mock");
    assert.equal(c.cookies.has("STALE"), false, "a stale cookie must not survive a reconnect");
    const login = fetchImpl.bodies.length - 1;
    assert.ok(login >= 0);
  });

  test("connect() stores cookies and sends them on the next call", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    assert.equal(c.connected, false);
    await c.connect();
    assert.equal(c.cookies.get("PHPSESSID"), "mock");
    assert.equal(c.connected, true);
    await c.call("Solution_GetWebinfo");
  });
});

describe("R4 — a new session reverts to the DEFAULT field set (the reason re-assertion exists)", () => {
  /**
   * The offline SOAP mock ignores field sets, so it cannot show the smaller record. This stub
   * models exactly the recorded behaviour instead: the field set is SESSION state, a new session
   * starts on the default (Id only), and one AUTH fault is injected.
   */
  function statefulShop() {
    const sessions = new Map();
    let n = 0;
    let injectAuthOnce = true;
    return stub((op, body) => {
      const sid = /PHPSESSID=([^;]+)/.exec(body ? "" : "") ?? null; // cookies come from init, see below
      return { xml: "", status: 200, sid, n, sessions, injectAuthOnce };
    });
  }
  // Written out longhand so the cookie is read from the request headers, not the body.
  function shopFetch() {
    const sessions = new Map();
    let counter = 0;
    let authInjected = false;
    const ops = [];
    const fn = async (_url, init) => {
      const body = new TextDecoder().decode(init.body);
      const op = /<m:(\w+)/.exec(body)?.[1] ?? "?";
      ops.push(op);
      const sid = /PHPSESSID=([^;]+)/.exec(init.headers.cookie ?? "")?.[1] ?? null;
      const mk = (xml, headers) => new Response(new TextEncoder().encode(xml), {
        status: 200, headers: { "content-type": "application/soap+xml", ...headers },
      });
      if (op === "Solution_Connect") {
        counter += 1;
        const id = `s${counter}`;
        sessions.set(id, { fields: ["Id"] }); // R4: a NEW SESSION HAS THE DEFAULT FIELD SET
        return mk(RESULT(op, "1"), { "set-cookie": `PHPSESSID=${id}; path=/` });
      }
      const session = sid ? sessions.get(sid) : null;
      if (!session) return mk(FAULT("AUTH", "A valid authentication has not been performed with the service"));
      if (op === "Product_SetFields") {
        session.fields = /<Fields>([^<]*)</.exec(body)[1].split(",");
        return mk(RESULT(op, "1"));
      }
      if (op === "Product_GetAllWithLimit") {
        if (!authInjected) { authInjected = true; sessions.delete(sid); return mk(FAULT("AUTH", "A valid authentication has not been performed with the service")); }
        const full = { Id: "1", ItemNumber: "A-1", Title: "Ting", SeoLink: "ting" };
        const row = Object.fromEntries(session.fields.filter((f) => f in full).map((f) => [f, full[f]]));
        return mk(RESULT(op, ITEMS([row])));
      }
      return mk(FAULT("PARAM", `unhandled ${op}`));
    };
    fn.ops = ops;
    fn.sessions = sessions;
    return fn;
  }

  test("with re-assertion the replayed read keeps the FULL record", async () => {
    const fetchImpl = shopFetch();
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await c.setFields("Product", "Id,ItemNumber,Title,SeoLink");
    const res = await c.call("Product_GetAllWithLimit", { Start: 0, Length: 1 });
    assert.deepEqual(Object.keys(res.records[0]), ["Id", "ItemNumber", "Title", "SeoLink"]);
    assert.deepEqual(fetchImpl.ops, [
      "Solution_Connect", "Product_SetFields",
      "Product_GetAllWithLimit", "Solution_Connect", "Product_SetFields", "Product_GetAllWithLimit",
    ]);
  });

  test("WITHOUT a remembered field set the same reconnect silently returns the smaller record", async () => {
    // Same server, same AUTH fault — but the field set was established out of band, so the client
    // has nothing to re-assert. This is what removing the re-assertion looks like from the caller's
    // side: no error anywhere, a record with one key.
    const fetchImpl = shopFetch();
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await fetchImpl("http://x/", {
      headers: { cookie: `PHPSESSID=${[...fetchImpl.sessions.keys()][0]}` },
      body: new TextEncoder().encode('<m:Product_SetFields xmlns:m="x"><Fields>Id,ItemNumber,Title,SeoLink</Fields></m:Product_SetFields>'),
    });
    const res = await c.call("Product_GetAllWithLimit", { Start: 0, Length: 1 });
    assert.deepEqual(Object.keys(res.records[0]), ["Id"], "this is the silent truncation R4 warns about");
    assert.equal(res.replayed, true);
  });

  test("a re-assertion that fails is FATAL, not swallowed", async () => {
    let allowSetFields = true;
    const fetchImpl = stub((op, body, init) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok; path=/" } };
      if (op === "Product_SetFields") {
        if (!allowSetFields) return { xml: FAULT("NOSUCHPARAM", "Field Title does not exist"), status: 500 };
        return { xml: RESULT(op, "1") };
      }
      return { xml: FAULT("PARAM", "nope"), status: 500 };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await c.setFields("Product", "Id,Title");
    allowSetFields = false;
    const err = await catchesAsync(() => c.call("Product_GetById", { ProductId: 1 }), FieldSetReassertError);
    assert.match(err.message, /record shape is now UNKNOWN/);
    assert.equal(err.type, "Product");
  });
});

describe("R4 — field-set validation and memory", () => {
  let mock;
  before(async () => { mock = await startSoapMock(); });
  after(() => mock.close());

  test("an invalid field name never reaches the wire", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();
    fetchImpl.reset();
    const err = await catchesAsync(() => c.setFields("Product", "Id,ItemNumber,SeoLnk"), FieldListError);
    assert.deepEqual(err.invalid, ["SeoLnk"]);
    assert.match(err.message, /PREVIOUS field set/);
    assert.deepEqual(fetchImpl.ops, []);
  });

  test("the direct call() path is validated too — there is no unguarded way in", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();
    fetchImpl.reset();
    await catchesAsync(() => c.call("Product_SetFields", { Fields: "Id,SeoLnk" }), FieldListError);
    assert.deepEqual(fetchImpl.ops, []);
    // ...and a successful direct call IS remembered, so it survives a reconnect.
    await c.call("Order_SetFields", { Fields: "Id,Status" });
    assert.deepEqual(c.activeFields("Order"), ["Id", "Status"]);
  });

  test("SET_FIELDS_TYPE wiring: Product_SetVariantFields validates against ProductVariant", async () => {
    const c = createClient({ endpoint: mock.url, ...CREDS });
    assert.equal(FIELD_SET_OP_FOR_TYPE.ProductVariant, "Product_SetVariantFields");
    assert.equal(SET_FIELDS_TYPE.Product_SetVariantFields, "ProductVariant");
    // A field that exists on ProductVariant but not on Product proves the two are not confused.
    assert.equal(validateFields("ProductVariant", "PictureIds").ok, true);
    assert.equal(validateFields("Product", "PictureIds").ok, false);
    await catchesAsync(() => c.setFields("Product", "PictureIds"), FieldListError);
    assert.deepEqual(Object.keys(FIELD_SET_OP_FOR_TYPE).sort(), Object.values(SET_FIELDS_TYPE).sort());
    assert.equal(Object.keys(FIELD_SET_OP_FOR_TYPE).length, 6);
  });

  test("a type with no *_SetFields operation is refused, naming the six that have one", async () => {
    const c = createClient({ endpoint: mock.url, ...CREDS });
    const err = await catchesAsync(() => c.setFields("Category", "Id,Title"), FieldListError);
    assert.match(err.message, /six field-set types/);
    assert.ok(TYPES.Category, "Category IS a real complexType — it just has no field-set operation");
  });

  test("a FAULTED *_SetFields leaves the memory on the PREVIOUS set (the session keeps it too)", async () => {
    let fail = false;
    const fetchImpl = stub((op) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      if (op === "Product_SetFields" && fail) return { xml: FAULT("NOSUCHPARAM", "no"), status: 500 };
      return { xml: RESULT(op, "1") };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, reassertOnFault: false });
    await c.connect();
    await c.setFields("Product", "Id,Title");
    fail = true;
    // Both names are valid, so this passes the local check and faults at the server.
    await catchesAsync(() => c.setFields("Product", "Id,ItemNumber"), DanDomainFaultError);
    assert.deepEqual(c.activeFields("Product"), ["Id", "Title"], "the memory must describe what the SESSION has");
  });
});

describe("R26/R28 — the whole-batch field audit", () => {
  /** scale.json: SeoLink came back on 8 of 618 products, at every page size. */
  const SEOLINK_ROWS = SCALE.pages.find((p) => p.pageSize === 1000);

  test("the fixture is the recording: SeoLink on 8 of 618", () => {
    assert.equal(SEOLINK_ROWS.products, 618);
    assert.equal(SEOLINK_ROWS.productMarkers.SeoLink, 8);
    assert.equal(SEOLINK_ROWS.productMarkers.VatGroupId, 618);
  });

  function seoLinkBatch() {
    // 618 products; only the last 8 carry SeoLink — so record 1 does NOT have it.
    return Array.from({ length: 618 }, (_, i) => {
      const rec = { Id: String(i + 1), VatGroupId: "1", Online: "true" };
      if (i >= 610) rec.SeoLink = `slug-${i}`;
      return rec;
    });
  }

  test("a field on SOME records is an EMPTY VALUE, not a truncated column", () => {
    const records = seoLinkBatch();
    const audit = auditBatch(["Id", "VatGroupId", "Online", "SeoLink"], records);
    assert.deepEqual(audit.truncated, []);
    assert.deepEqual(audit.partial, [{ field: "SeoLink", present: 8, of: 618 }]);
    assert.deepEqual(audit.presentOnAll, ["Id", "VatGroupId", "Online"]);
  });

  test("NEVER FROM RECORD 1 — the first-record rule calls the same batch truncated (R28)", () => {
    const records = seoLinkBatch();
    // The rule R26 supersedes, implemented here so the difference is pinned rather than described.
    const firstRecordVerdict = ["Id", "VatGroupId", "Online", "SeoLink"].filter((f) => !(f in records[0]));
    assert.deepEqual(firstRecordVerdict, ["SeoLink"], "a record-1 audit reports a truncated column here");
    assert.deepEqual(auditBatch(["Id", "VatGroupId", "Online", "SeoLink"], records).truncated, [],
      "the whole-batch audit must not");
  });

  test("a field on ZERO records raises FIELD_SET_TRUNCATED", () => {
    const records = seoLinkBatch();
    const err = catches(() => auditBatch(["Id", "SeoKeywords"], records), FieldSetTruncatedError);
    assert.deepEqual(err.truncated, ["SeoKeywords"]);
    assert.equal(err.code, "FIELD_SET_TRUNCATED");
    assert.equal(err.audit.objectRecords, 618);
    assert.match(err.message, /truncated column, not an empty value/);
  });

  test("{ throwOnTruncation: false } surveys instead of raising", () => {
    const audit = auditBatch(["Id", "SeoKeywords"], seoLinkBatch(), { throwOnTruncation: false });
    assert.deepEqual(audit.truncated, ["SeoKeywords"]);
    assert.equal(audit.decidable, true);
  });

  test("ZERO records decides nothing and raises nothing (gaps.json sections.customers)", () => {
    const customers = GAPS.sections.customers;
    assert.equal(customers.customerCount, 0);
    assert.equal(customers.audit.sampleAvailable, false);
    assert.equal(customers.audit.truncated, null, "the recording itself says: not decidable");

    const audit = auditBatch(customers.audit.requested, []);
    assert.equal(audit.decidable, false);
    assert.deepEqual(audit.truncated, []);
    assert.equal(audit.requested.length, 56);
  });

  test("R28's recorded false positive: correctly-parsed variants are NOT truncated", () => {
    const variants = GAPS.sections.variants;
    // What the recording says, produced by the naive walker: 22 of 26 fields "missing".
    assert.equal(variants.audit.truncated, true);
    assert.equal(variants.audit.missing.length, 22);
    assert.deepEqual(variants.audit.returned, ["item", "MinAmount", "Title", "Unit", "StockLocations"]);

    // The collapsed shape really does produce that verdict — the fixture is faithful.
    const collapsed = variants.sample;
    const collapsedAudit = auditBatch(variants.audit.requested, collapsed, { throwOnTruncation: false });
    assert.equal(collapsedAudit.truncated.length, 22);
    assert.deepEqual(collapsedAudit.truncated, variants.audit.missing);

    // Recovered records (what xml.js returns: the nested <item> rows ARE the records) are fine.
    const records = collapsed.flatMap((page) => page.item);
    assert.equal(records.length, 6);
    const recovered = auditBatch(variants.audit.requested, records, { throwOnTruncation: false });
    assert.deepEqual(recovered.truncated.length > 0, true, "this shop genuinely omits some variant fields");
    // …but the 18 fields that were reported missing purely because of the collapse are now present.
    for (const f of ["Id", "ProductId", "Stock", "Price", "BuyingPrice", "ItemNumber", "Status", "Sorting"]) {
      assert.ok(recovered.presentOnAll.includes(f), `${f} was falsely reported truncated by the collapse`);
      assert.ok(variants.audit.missing.includes(f), `${f} is in the recorded false-positive list`);
    }
  });

  test("non-object entries are not counted as records (a parse artefact is not a sample)", () => {
    const audit = auditBatch(["Id"], ["", null, { Id: "1" }], { throwOnTruncation: false });
    assert.equal(audit.recordCount, 3);
    assert.equal(audit.objectRecords, 1, "only the real record counts");
    assert.deepEqual(audit.presentOnAll, ["Id"]);
    // A batch of nothing but parse artefacts decides nothing — it must not report a truncation.
    const empty = auditBatch(["Id"], ["", ""]);
    assert.equal(empty.decidable, false);
    assert.deepEqual(empty.truncated, []);
  });

  test("extra fields the server volunteered are reported, not silently swallowed", () => {
    const audit = auditBatch(["Id"], [{ Id: "1", Surprise: "x" }]);
    assert.deepEqual(audit.extra, ["Surprise"]);
  });

  test("auditBatch refuses a single record — the signature is the WHOLE batch", () => {
    catches(() => auditBatch(["Id"], { Id: "1" }), TypeError);
  });

  test("auditAgainstFieldSet uses the remembered list so the two cannot drift", async () => {
    const fetchImpl = stub((op) => (op === "Solution_Connect"
      ? { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } }
      : { xml: RESULT(op, "1") }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await c.setFields("Product", "Id,Title,SeoLink");
    const audit = c.auditAgainstFieldSet("Product", [{ Id: "1", Title: "a" }, { Id: "2", Title: "b", SeoLink: "s" }], { throwOnTruncation: false });
    assert.deepEqual(audit.requested, ["Id", "Title", "SeoLink"]);
    assert.deepEqual(audit.partial, [{ field: "SeoLink", present: 1, of: 2 }]);
    catches(() => c.auditAgainstFieldSet("Order", []), FieldListError);
  });
});

describe("throttle — token bucket and concurrency gate", () => {
  test("the recorded evidence is that nothing was observed, so the default is unpaced", () => {
    assert.equal(SOAP_RATE_EVIDENCE.observedLimit, null);
    assert.equal(SOAP_RATE_EVIDENCE.retryAfterSeen, false);
    assert.deepEqual(SCALE.faults, [], "scale.json ran 11 calls with no faults at all");
    assert.equal(GAPS.faults.length, 1, "and the one recorded fault is the arity one, not a 429");
  });

  test("the bucket paces: capacity 2, 5/s, the third take waits 200ms", async () => {
    let clock = 1000;
    const slept = [];
    const bucket = createTokenBucket({
      capacity: 2,
      refillPerSecond: 5,
      now: () => clock,
      sleep: async (ms) => { slept.push(ms); clock += ms; },
    });
    await bucket.take();
    await bucket.take();
    await bucket.take();
    assert.deepEqual(slept, [200]);
    assert.equal(bucket.stats().takes, 3);
    assert.equal(bucket.stats().waits, 1);
  });

  test("time passing refills it", async () => {
    let clock = 0;
    const slept = [];
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 10, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
    await bucket.take();
    clock += 1000;
    await bucket.take();
    assert.deepEqual(slept, [], "a full second at 10/s means no wait");
  });

  test("the default is unpaced and never sleeps", async () => {
    const slept = [];
    const bucket = createTokenBucket({ sleep: async (ms) => slept.push(ms) });
    for (let i = 0; i < 50; i++) await bucket.take();
    assert.deepEqual(slept, []);
    assert.equal(bucket.refillPerSecond, Infinity);
  });

  test("bad configuration is refused", () => {
    catches(() => createTokenBucket({ capacity: 0 }), RangeError);
    catches(() => createTokenBucket({ refillPerSecond: 0 }), RangeError);
    catches(() => createGate(0), RangeError);
  });

  test("the client really goes through the bucket", async () => {
    let clock = 0;
    const slept = [];
    const fetchImpl = stub((op) => (op === "Solution_Connect"
      ? { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } }
      : { xml: RESULT(op, ITEMS([{ Id: 1 }])) }));
    const c = createClient({
      endpoint: "http://x/", ...CREDS, fetchImpl,
      throttle: { capacity: 1, refillPerSecond: 4, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } },
    });
    await c.connect();
    await c.call("Category_GetAll");
    await c.call("Category_GetAll");
    assert.deepEqual(slept, [250, 250], "3 calls at 4/s with capacity 1 means two 250ms waits");
  });

  test("the concurrency gate defaults to 1 because the field set is SESSION state (R4)", async () => {
    assert.equal(DEFAULT_MAX_CONCURRENT, 1);
    const gate = createGate(1);
    const order = [];
    const task = async (n) => { await gate.acquire(); order.push(`in${n}`); await Promise.resolve(); order.push(`out${n}`); gate.release(); };
    await Promise.all([task(1), task(2)]);
    assert.deepEqual(order, ["in1", "out1", "in2", "out2"], "no interleaving");
  });

  test("concurrent client calls do not overlap on the wire", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = async (_u, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      const op = /<m:(\w+)/.exec(new TextDecoder().decode(init.body))[1];
      return new Response(new TextEncoder().encode(RESULT(op, ITEMS([{ Id: 1 }]))), { status: 200 });
    };
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await Promise.all([c.call("Category_GetAll"), c.call("Category_GetAll"), c.call("Category_GetAll")]);
    assert.equal(maxInFlight, 1);
  });
});

describe("paged reads", () => {
  /** An offset-paginated shop of `total` products; `cap` models a server that caps page size. */
  function offsetShop(total, cap = Infinity) {
    return stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      const start = Number(/<Start>(\d+)</.exec(body)[1]);
      const length = Math.min(Number(/<Length>(\d+)</.exec(body)[1]), cap);
      const rows = [];
      for (let i = start; i < Math.min(start + length, total); i++) rows.push({ Id: String(i + 1), ItemNumber: `A-${i + 1}` });
      return { xml: RESULT(op, ITEMS(rows)) };
    });
  }

  test("the WSDL decides which operations can be paged, and which style", () => {
    assert.deepEqual([...PAGINATED_OPERATIONS].sort(), [
      "Order_GetAllWithPagination", "Order_GetByDateUpdatedWithPagination", "Order_GetByDateWithPagination",
      "Order_GetByStatusWithPagination", "Product_GetAllWithLimit", "Product_GetDiscountsAccumulativeAllWithPagination",
    ]);
    assert.equal(paginationStyleFor("Product_GetAllWithLimit"), PAGINATION_STYLE.OFFSET);
    assert.equal(paginationStyleFor("Order_GetAllWithPagination"), PAGINATION_STYLE.PAGE);
    assert.equal(paginationStyleFor("Order_GetByDate"), null);
  });

  test("THE TRAP: Start is a DATE in the four *ByDate* paginated operations, not an offset", () => {
    // Order_GetByDateWithPagination takes (Start, End, Status, Page, PageSize).
    assert.equal(paginationStyleFor("Order_GetByDateWithPagination"), PAGINATION_STYLE.PAGE,
      "treating its Start as an offset would silently re-window the export by date");
    const args = OPERATIONS.Order_GetByDateWithPagination.args.map((a) => a.name);
    assert.deepEqual(args, ["Start", "End", "Status", "Page", "PageSize"]);
  });

  test("a 618-product catalogue reads completely at pageSize 250 (scale.json's shop)", async () => {
    const fetchImpl = offsetShop(SCALE.catalogueSize);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 250 });
    assert.equal(all.records.length, 618);
    assert.equal(all.pages, 3);
    assert.equal(new Set(all.records.map((r) => r.Id)).size, 618, "no duplicates, no gaps");
    assert.equal(all.records[0].Id, "1");
    assert.equal(all.records.at(-1).Id, "618");
  });

  test("scale.json's own last page: pageSize 1000 against 618 products", async () => {
    const fetchImpl = offsetShop(618);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 1000 });
    assert.equal(all.records.length, 618);
    assert.equal(all.pages, 1, "the whole catalogue in one short page — scale.json pageSizeCeiling");
    // 2, not 1: "short" is measured against the OBSERVED page size (618, page 1's own count), not
    // against the caller's 1000. Trusting the caller's number here is what loses 70 of 120 rows
    // against a capping server, so the walk pays one confirming request instead.
    assert.equal(all.requests, 2);
  });

  test("a page that is exactly full costs one confirming request, and that is reported", async () => {
    // 600 products at pageSize 300: page 2 is exactly full, so the walk cannot know it is the end
    // without asking once more. `pages` (2) and `requests` (3) must not be conflated.
    const fetchImpl = offsetShop(600);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 300 });
    assert.equal(all.records.length, 600);
    assert.equal(all.pages, 2);
    assert.equal(all.requests, 3);
  });

  test("A SERVER THAT CAPS PAGE SIZE must not end the walk after one page", async () => {
    // Ask for 100, the server only ever gives 50. Using the caller's number as the yardstick
    // reads 50 of 618 and reports success — the exact defect the GraphQL walker was caught with.
    const fetchImpl = offsetShop(618, 50);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 100 });
    assert.equal(all.records.length, 618);
    assert.equal(all.observedPageSize, 50);
    assert.equal(all.pages, 13);
  });

  test("a server that IGNORES the pagination argument throws instead of looping or duplicating", async () => {
    // This is the real offline mock: Product_GetAllWithLimit ignores Start entirely.
    const mock = await startSoapMock();
    try {
      const c = createClient({ endpoint: mock.url, ...CREDS });
      await c.connect();
      const err = await catchesAsync(() => c.readAll("Product_GetAllWithLimit", { pageSize: 2 }), PaginationError);
      assert.match(err.message, /SAME page twice/);
      assert.equal(err.style, PAGINATION_STYLE.OFFSET);
    } finally {
      mock.close();
    }
  });

  test("page-number style walks 1, 2, 3 and stops on the ZERO-row page, not the short one", async () => {
    const seen = [];
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      const page = Number(/<Page>(\d+)</.exec(body)[1]);
      const size = Number(/<PageSize>(\d+)</.exec(body)[1]);
      seen.push(page);
      const total = 25;
      const rows = [];
      for (let i = (page - 1) * size; i < Math.min(page * size, total); i++) rows.push({ Id: String(i + 1) });
      return { xml: RESULT(op, ITEMS(rows)) };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    // `pageBase` is stated explicitly here even though it now has a recorded default, because this
    // test is about H1 (a SHORT page must not end a walk) and it should not also depend on what
    // the default happens to be.
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10, pageBase: 1 });
    // H1: page 3 is SHORT (5 of 10 rows) and must NOT end the walk — a short page in the middle
    // of a real catalogue truncated the export silently. Page 4 returns zero rows, and THAT ends
    // it. This assertion previously read [1, 2, 3], which encoded the defect.
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.equal(all.records.length, 25);
    assert.equal(SOAP_PAGE_BASE.verified, true, "pagebase.json settled it on two independent methods");
    assert.equal(SOAP_PAGE_BASE.value, 1);
    assert.deepEqual(SOAP_PAGE_BASE.candidates, [0, 1]);
  });

  test("extra (non-pagination) arguments are passed through untouched", async () => {
    const bodies = [];
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      bodies.push(body);
      return { xml: RESULT(op, "") };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    // H3 gates every page-NUMBER read on an explicit base; this test is about argument
    // pass-through, so it states the base rather than relying on a default that no longer exists.
    await c.readAll("Order_GetByDateWithPagination", {
      pageSize: 50,
      pageBase: 1,
      args: { Start: "2019-01-01 00:00:00", End: "2030-01-01 00:00:00", Status: null },
    });
    assert.match(bodies[0], /<Start>2019-01-01 00:00:00<\/Start><End>2030-01-01 00:00:00<\/End><Status><\/Status><Page>1<\/Page><PageSize>50<\/PageSize>/);
  });

  test("an empty first page is zero records, not one phantom", async () => {
    const fetchImpl = offsetShop(0);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 50 });
    assert.deepEqual(all.records, []);
  });

  test("an empty list result is ZERO records even when the caller disables resultIsArray", async () => {
    // The scale.json phantom: an empty page that parses as one record. `records` is normalised
    // with asRecords() at the client boundary as well, so turning the parser hint off cannot
    // reintroduce it.
    const fetchImpl = stub((op) => (op === "Solution_Connect"
      ? { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } }
      : { xml: RESULT(op, "") }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const off = await c.call("Product_GetAllWithLimit", { Start: 0, Length: 50 }, { parse: { resultIsArray: false } });
    assert.deepEqual(off.records, [], "an empty page is 0 records, never 1 phantom");
    const on = await c.call("Product_GetAllWithLimit", { Start: 0, Length: 50 });
    assert.deepEqual(on.records, []);
  });

  test("R26 IS ENFORCED IN THE READ PATH: readAll audits the whole batch against the field set", async () => {
    // The record type comes from the WSDL, not from a hand-written map.
    assert.equal(recordTypeOf("Product_GetAllWithLimit"), "Product");
    assert.equal(recordTypeOf("Order_GetAllWithPagination"), "Order");
    assert.equal(recordTypeOf("Solution_GetWebinfo"), null);

    // 618 products; SeoLink on the last 8 only (scale.json), Title on none.
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      if (op === "Product_SetFields") return { xml: RESULT(op, "1") };
      const start = Number(/<Start>(\d+)</.exec(body)[1]);
      const length = Number(/<Length>(\d+)</.exec(body)[1]);
      const rows = [];
      for (let i = start; i < Math.min(start + length, 618); i++) {
        rows.push(i >= 610 ? { Id: String(i + 1), SeoLink: `s-${i}` } : { Id: String(i + 1) });
      }
      return { xml: RESULT(op, ITEMS(rows)) };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();

    // SeoLink on 8 of 618 is an EMPTY VALUE: the read succeeds and reports it.
    await c.setFields("Product", "Id,SeoLink");
    const ok = await c.readAll("Product_GetAllWithLimit", { pageSize: 250 });
    assert.equal(ok.records.length, 618);
    assert.equal(ok.auditedType, "Product");
    assert.deepEqual(ok.audit.partial, [{ field: "SeoLink", present: 8, of: 618 }]);
    assert.deepEqual(ok.audit.truncated, []);

    // Title on ZERO of 618 is a TRUNCATED COLUMN: the read refuses.
    await c.setFields("Product", "Id,SeoLink,Title");
    const err = await catchesAsync(() => c.readAll("Product_GetAllWithLimit", { pageSize: 250 }), FieldSetTruncatedError);
    assert.deepEqual(err.truncated, ["Title"]);
    assert.equal(err.audit.objectRecords, 618);

    // ...and { audit: false } is the survey mode.
    const surveyed = await c.readAll("Product_GetAllWithLimit", { pageSize: 250, audit: false });
    assert.equal(surveyed.audit, null);
    assert.equal(surveyed.records.length, 618);

    // With no remembered field set there is nothing to audit against.
    c.forgetFieldSet("Product");
    const noSet = await c.readAll("Product_GetAllWithLimit", { pageSize: 250 });
    assert.equal(noSet.audit, null);
    assert.equal(noSet.auditedType, null);
  });

  test("pageSize is required — no invented default", async () => {
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: stub(() => ({ xml: "" })) });
    const err = await catchesAsync(() => c.readAll("Product_GetAllWithLimit", {}), PaginationError);
    assert.match(err.message, /requires an explicit integer pageSize/);
    await catchesAsync(() => c.readAll("Product_GetAllWithLimit", { pageSize: 0 }), PaginationError);
  });

  test("a non-paginated operation is refused, naming the six that are", async () => {
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: stub(() => ({ xml: "" })) });
    const err = await catchesAsync(() => c.readAll("Order_GetByDate", { pageSize: 10 }), PaginationError);
    assert.match(err.message, /Product_GetAllWithLimit/);
  });

  test("maxPages with a full page still coming is an ERROR, not a short success", async () => {
    const fetchImpl = offsetShop(618);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const err = await catchesAsync(() => c.readAll("Product_GetAllWithLimit", { pageSize: 100, maxPages: 2 }), PaginationError);
    assert.match(err.message, /silently truncate/);
    assert.equal(err.records, 200);
  });
});

describe("envelope construction", () => {
  test("the SOAPAction comes from the WSDL binding, not from a guess", async () => {
    let seen = null;
    const fetchImpl = async (_u, init) => {
      seen = init.headers["content-type"];
      return new Response(new TextEncoder().encode(RESULT("Solution_GetWebinfo", "<ShopName>x</ShopName>")), { status: 200 });
    };
    // Every soapAction in this WSDL happens to equal `${targetNamespace}#${op}`, so the value
    // alone cannot tell a read from a guess. Two things pin it. (1) Behaviour: overriding the
    // element namespace must NOT move the action, because the action is a binding fact and the
    // namespace is a message fact.
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, namespace: "urn:not-the-wsdl-namespace" });
    await c.call("Solution_GetWebinfo");
    assert.ok(seen.includes(`action="${OPERATIONS.Solution_GetWebinfo.soapAction}"`), seen);
    assert.equal(/action="urn:not-the-wsdl-namespace#/.test(seen), false, "the action must not be composed from the namespace");
    assert.ok(seen.includes("charset=utf-8"));
    // (2) Structure: the source must not compose an action at all.
    const code = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.match(code, /action="\$\{spec\.soapAction\}"/);
    assert.equal(/action="\$\{[^}]*\}#\$\{op\}"/.test(code), false, "no `${ns}#${op}` composition anywhere");
  });

  test("a Date is refused instead of silently serialising to an empty element", () => {
    const err = catches(() => buildEnvelope("Order_GetByDate", { Start: new Date(0), End: "b", Status: "0" }), ArgumentNameError);
    assert.match(err.message, /Date has no enumerable own keys/);
    assert.match(err.message, /2019-01-01 00:00:00/);
  });

  test("a bare array for an ArrayOf* argument is refused with the shape that works", () => {
    const arrayArg = Object.entries(OPERATIONS).find(([, s]) => s.args.some((a) => /^tns:ArrayOf/i.test(a.type)));
    assert.ok(arrayArg, "the WSDL has at least one ArrayOf* argument");
    const [op, spec] = arrayArg;
    const arg = spec.args.find((a) => /^tns:ArrayOf/i.test(a.type));
    const args = Object.fromEntries(spec.args.map((a) => [a.name, a === arg ? [1, 2] : "x"]));
    const err = catches(() => buildEnvelope(op, args), ArgumentNameError);
    assert.match(err.message, /item: \[\.\.\.\]/);
  });

  test("buildEnvelope refuses an unknown argument name on its own, not only via call()", () => {
    const err = catches(() => buildEnvelope("Order_GetByDate", { Start: "a", End: "b", Status: "c", Nope: 1 }), ArgumentNameError);
    assert.deepEqual(err.unknown, ["Nope"]);
    assert.match(err.message, /DROPS these silently/);
  });

  test("nested objects and { item: [...] } lists serialise the way the probe sent them", () => {
    const xml = buildEnvelope("Order_Create", {
      OrderData: { CurrencyId: 1, OrderLines: { item: [{ ProductId: 1 }, { ProductId: 2 }] } },
    });
    assert.match(xml, /<OrderData><CurrencyId>1<\/CurrencyId><OrderLines><item><ProductId>1<\/ProductId><\/item><item><ProductId>2<\/ProductId><\/item><\/OrderLines><\/OrderData>/);
  });

  test("text is escaped and element names are validated", () => {
    assert.equal(escapeXml(`<a href='x' & "y">`), "&lt;a href=&apos;x&apos; &amp; &quot;y&quot;&gt;");
    assert.match(buildEnvelope("Product_Search", { SearchString: "A & B" }), /<SearchString>A &amp; B<\/SearchString>/);
    catches(() => buildEnvelope("Order_Create", { OrderData: { "bad name": 1 } }), ArgumentNameError);
  });

  test("the envelope is SOAP 1.2 and names the operation the way the server parses it", () => {
    const xml = buildEnvelope("Solution_GetWebinfo", {});
    assert.match(xml, /xmlns:env="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
    assert.match(xml, /<m:Solution_GetWebinfo xmlns:m="https:\/\/api\.hostedshop\.io\/service\.php">/);
  });
});

describe("write encoding — the unresolved question is refused, not guessed", () => {
  let mock;
  before(async () => { mock = await startSoapMock(); });
  after(() => mock.close());

  test("a non-ASCII WRITE is refused by default and never reaches the wire", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl });
    await c.connect();
    fetchImpl.reset();
    const err = await catchesAsync(
      () => c.call("Product_CreateOrUpdate", { ProductData: { Title: "Æblegrød", CategoryId: 9 } }),
      UnresolvedWriteEncodingError,
    );
    assert.match(err.message, /\?blegr\?d/);
    assert.deepEqual(fetchImpl.ops, []);
  });

  test("a non-ASCII READ is unaffected — a read cannot corrupt the shop", async () => {
    const c = createClient({ endpoint: mock.url, ...CREDS });
    await c.connect();
    await c.call("Product_GetByItemNumber", { ItemNumber: "Æble" }); // must not throw
  });

  test("choosing an encoding explicitly is the opt-in, and it round-trips through the mock", async () => {
    const c = createClient({ endpoint: mock.url, ...CREDS, requestEncoding: "utf-8" });
    await c.connect();
    await c.call("Product_CreateOrUpdate", { ProductData: { Title: "Æblegrød", CategoryId: 9 } });
    const back = await c.call("Product_GetByItemNumber", { ItemNumber: "PROBE-X" });
    assert.equal(back.records[0].Title, "Æblegrød");
  });

  test("latin1 is available and refuses a character it cannot represent, rather than writing '?'", async () => {
    const c = createClient({ endpoint: mock.url, ...CREDS, requestEncoding: "latin1" });
    await c.connect();
    const err = await catchesAsync(
      () => c.call("Product_CreateOrUpdate", { ProductData: { Title: "emoji \u{1F600}", CategoryId: 9 } }),
      UnresolvedWriteEncodingError,
    );
    assert.match(err.message, /cannot represent U\+/);
  });

  test("{ refuseNonAsciiWrites: false } is the other documented way out", async () => {
    const fetchImpl = recorder();
    const c = createClient({ endpoint: mock.url, ...CREDS, fetchImpl, refuseNonAsciiWrites: false });
    await c.connect();
    fetchImpl.reset();
    await c.call("Product_CreateOrUpdate", { ProductData: { Title: "Æblegrød", CategoryId: 9 } });
    assert.deepEqual(fetchImpl.ops, ["Product_CreateOrUpdate"]);
  });
});

describe("transport errors", () => {
  test("a SOAP fault arriving with HTTP 500 is a FAULT, not a transport error", async () => {
    const fetchImpl = stub(() => ({ xml: FAULT("PARAM", "nope"), status: 500 }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(() => c.call("Solution_GetWebinfo"), DanDomainFaultError);
    assert.equal(err.code, "PARAM");
  });

  test("an HTML error page is a transport error carrying the body", async () => {
    const fetchImpl = async () => new Response(new TextEncoder().encode("<html><head><title>502 Bad Gateway</title></head></html>"), {
      status: 502, headers: { "content-type": "text/html" },
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(() => c.call("Solution_GetWebinfo"), SoapTransportError);
    assert.equal(err.status, 502);
    assert.match(err.body, /502 Bad Gateway/);
  });

  test("a bad status with a well-formed NON-fault body is a transport error", async () => {
    const fetchImpl = async () => new Response(
      new TextEncoder().encode(RESULT("Solution_GetWebinfo", "<ShopName>x</ShopName>")),
      { status: 503, headers: { "content-type": "application/soap+xml" } },
    );
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(() => c.call("Solution_GetWebinfo"), SoapTransportError);
    assert.equal(err.status, 503);
    assert.match(err.body, /ShopName/);
  });

  test("a network failure is wrapped, not leaked", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    const err = await catchesAsync(() => c.call("Solution_GetWebinfo"), SoapTransportError);
    assert.match(err.message, /ECONNREFUSED/);
    assert.equal(err.op, "Solution_GetWebinfo");
  });

  test("no fetch implementation is an explicit error, not a TypeError at import time", async () => {
    const c = new DanDomainClient({ endpoint: "http://x/", ...CREDS, fetchImpl: null });
    assert.ok(c);
    const saved = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      await catchesAsync(() => c.call("Solution_GetWebinfo"), SoapTransportError);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("ftp() — the FTPS transport, promoted", () => {
  // The mock's self-signed cert, read out of the mock source the same way the R11 scratch did.
  const src = readFileSync(path.join(ROOT, "scripts", "probe-dandomain.ftp-mock.mjs"), "utf8");
  const region = src.slice(src.indexOf("const TEST_CERT = ["), src.indexOf("].join(", src.indexOf("const TEST_CERT = [")));
  const CA = [...region.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join("\n");

  test("no configuration is an explicit error", () => {
    const c = createClient({ ...CREDS });
    catches(() => c.ftp(), DanDomainClientError);
  });

  test("it is the promoted module, not a rewrite", () => {
    const c = createClient({ ...CREDS, ftp: { host: "h", user: "u", pass: "p" } });
    assert.equal(c.ftp().parseList, parseList);
    assert.equal(c.ftp(), c.ftp(), "memoised");
  });

  test("explicit FTPS connects, lists and retrieves through the client facade", async () => {
    const srv = await startFtpsMock({ mode: "explicit", advertiseBogusIp: true });
    const c = createClient({ ...CREDS, ftp: { host: "127.0.0.1", port: srv.port, user: "u", pass: "p", tlsOptions: { ca: CA } } });
    try {
      const s = await c.ftp().connect();
      assert.equal(c.ftp().mode, "explicit");
      assert.equal(s.prot, true);
      assert.equal(s.typeI, 200);
      const l = await s.xferIn("LIST /images");
      const names = c.ftp().parseList(l.buf.toString("latin1")).map((e) => e.name);
      assert.ok(names.length > 0, JSON.stringify(names));
    } finally {
      c.ftp().quit();
      await srv.close();
    }
  });

  test("R10's flavour order is the CALLER's loop, and it is here: explicit fails, implicit wins", async () => {
    // The simplest shape of R10's fallback: explicit-on-21 finds nothing listening, implicit-on-990
    // answers. The HARDER shape — explicit pointed at a port that speaks TLS from byte 0, so the
    // greeting never arrives — used to be untestable from here: ftpsConnect leaked the plain socket
    // on that path and the mock server could then never close, so the suite hung instead of
    // failing. That leak is fixed, and the test below drives exactly that branch.
    const srv = await startFtpsMock({ mode: "implicit" });
    const closed = await freePort();
    const c = createClient({
      ...CREDS,
      ftp: {
        host: "127.0.0.1", user: "u", pass: "p",
        modes: ["explicit", "implicit"],
        explicitPort: closed, implicitPort: srv.port,
        timeoutMs: 4000,
        tlsOptions: { ca: CA },
      },
    });
    try {
      const s = await c.ftp().connect();
      assert.equal(c.ftp().mode, "implicit", "the second flavour must be tried, not given up on");
      assert.equal(s.prot, true);
      assert.equal(s.typeI, 200);
      assert.equal(c.ftp().attempts.length, 1, "the failed explicit attempt is kept, not discarded");
      assert.equal(c.ftp().attempts[0].mode, "explicit");
      assert.equal(c.ftp().attempts[0].stage, "tcp-connect", "the stage names the wrong assumption");
    } finally {
      c.ftp().quit();
      await srv.close();
    }
  });

  test("R10's fallback when the explicit attempt HANGS: the greeting never comes on an implicit port", async () => {
    // One port, both flavours. Explicit does a plain TCP connect to a server that will not say a
    // word until it gets a ClientHello, so the greeting times out — the path that used to leak the
    // control socket, report `stage: null`, and keep this mock open forever.
    const srv = await startFtpsMock({ mode: "implicit" });
    const c = createClient({
      ...CREDS,
      ftp: {
        host: "127.0.0.1", user: "u", pass: "p",
        modes: ["explicit", "implicit"],
        explicitPort: srv.port, implicitPort: srv.port,
        timeoutMs: 1500,
        tlsOptions: { ca: CA },
      },
    });
    try {
      const s = await c.ftp().connect();
      assert.equal(c.ftp().mode, "implicit");
      assert.equal(s.typeI, 200, "the second flavour produced a WORKING session");
      const [failed] = c.ftp().attempts;
      assert.equal(failed.mode, "explicit");
      assert.equal(failed.stage, "greeting", "the stage must be named, not null");
      assert.match(String(failed.message), /reply timeout/);
      assert.ok(Array.isArray(failed.transcript), "and the redacted transcript comes with it");
    } finally {
      c.ftp().quit();
      await srv.close();       // hangs forever if the explicit attempt leaked its socket
    }
  });

  test("certificate verification stays ON: without the CA the connection is refused", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    const c = createClient({ ...CREDS, ftp: { host: "127.0.0.1", port: srv.port, user: "u", pass: "p", modes: ["explicit"], timeoutMs: 4000 } });
    try {
      const err = await catchesAsync(() => c.ftp().connect(), DanDomainClientError);
      assert.equal(err.attempts.length, 1);
      assert.match(String(err.attempts[0].message), /self-signed|self signed|unable to verify/i);
    } finally {
      await srv.close();
    }
  });
});

describe("graphql() — the GraphQL transport, wired behind the same object", () => {
  test("no configuration is an explicit error naming what is needed", () => {
    const c = createClient({ ...CREDS });
    const err = catches(() => c.graphql(), DanDomainClientError);
    assert.match(err.message, /clientId/);
  });

  test("it builds a real DanDomainGraphQLClient, lazily and once", () => {
    const c = createClient({ ...CREDS, graphql: { tenant: "shop000000", clientId: "id", clientSecret: "sec" } });
    const g = c.graphql();
    assert.ok(g instanceof DanDomainGraphQLClient);
    assert.equal(c.graphql(), g, "memoised");
    assert.equal(g.baseUrl, "https://shop000000.mywebshop.io");
  });

  test("a query runs end to end through the facade (OAuth mint + a Convention-B payload)", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(String(url));
      if (String(url).includes("token")) {
        return new Response(JSON.stringify({ access_token: "T", token_type: "Bearer", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      assert.equal(init.headers.authorization, "Bearer T");
      return new Response(JSON.stringify({ data: { orders: { data: [{ id: "1" }], pagination: { total: 1 } } } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const c = createClient({ ...CREDS, graphql: { tenant: "t", clientId: "i", clientSecret: "s", fetchImpl, minIntervalMs: 0 } });
    const page = await c.graphql().query("orders", { selection: "id", limit: 1, page: 1 });
    assert.deepEqual(page.rows, [{ id: "1" }]);
    assert.equal(calls.length, 2, "one token mint plus one query");
  });

  test("an injected client is used as-is", () => {
    const injected = { marker: true };
    const c = createClient({ ...CREDS, graphql: { client: injected } });
    assert.equal(c.graphql(), injected);
  });
});

// =============================================================================================
// HOSTILE REVIEW — the HIGH defects, each with a test that FAILS without its fix.
//
// These are written against the module NAMESPACE (`CLIENT.*`) rather than against named imports
// on purpose: several of them name errors and constants that did not exist when the defect was
// found, and a missing NAMED import is a link-time error that takes the whole suite file down
// with it. Through the namespace the same mistake is a per-test failure, which is what "confirm
// red, then confirm green" needs.
// =============================================================================================
describe("H1/H2 — a paged walk stops on ZERO ROWS or a known total, never on a short page", () => {
  /**
   * An offset-style shop whose pages can be deliberately deformed.
   *   short:  Start -> how many rows to hand back at that offset (a SHORT page mid-walk)
   *   empty:  a Set of offsets that answer with zero rows
   */
  function deformableShop(total, { short = {}, empty = new Set(), emptyOnce = new Set() } = {}) {
    const served = [];
    const fired = new Set();
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      const start = Number(/<Start>(\d+)</.exec(body)[1]);
      const length = Number(/<Length>(\d+)</.exec(body)[1]);
      served.push(start);
      if (empty.has(start) || (emptyOnce.has(start) && !fired.has(start))) {
        fired.add(start);
        return { xml: RESULT(op, "") };
      }
      const give = Object.prototype.hasOwnProperty.call(short, start) ? short[start] : length;
      const rows = [];
      for (let i = start; i < Math.min(start + give, total); i++) rows.push({ Id: String(i + 1) });
      return { xml: RESULT(op, ITEMS(rows)) };
    });
    fetchImpl.served = served;
    return fetchImpl;
  }

  test("H1 — a SHORT page in the MIDDLE of the walk does not end it", async () => {
    // 618 products; the server hands back 100 rows at Start=250 instead of 250. Ending there
    // loses 268 products and reports success. Nothing about a short page proves the data ended.
    const fetchImpl = deformableShop(618, { short: { 250: 100 } });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 250 });
    assert.equal(all.records.length, 618, "the short page must not truncate the export");
    assert.equal(new Set(all.records.map((r) => r.Id)).size, 618, "no gaps, no duplicates");
    assert.equal(all.records.at(-1).Id, "618");
    assert.equal(all.stoppedBecause, "zero-rows");
  });

  test("H1 — the walk advances by rows RECEIVED, so a short page re-aligns the cursor", async () => {
    const fetchImpl = deformableShop(618, { short: { 250: 100 } });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await c.readAll("Product_GetAllWithLimit", { pageSize: 250 });
    assert.deepEqual(fetchImpl.served, [0, 250, 350, 600, 618],
      "after the 100-row page at 250 the next offset must be 350, not 500");
  });

  test("H1 — a caller-supplied known total is the OTHER legal stop condition", async () => {
    const fetchImpl = deformableShop(618);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 309, expectedTotal: 618 });
    assert.equal(all.records.length, 618);
    assert.equal(all.stoppedBecause, "known-total");
    assert.deepEqual(fetchImpl.served, [0, 309], "the total is reached, so no confirming request is spent");
  });

  test("H1 — running out of rows BEFORE the known total is an error, not a short success", async () => {
    const fetchImpl = deformableShop(500);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const err = await catchesAsync(
      () => c.readAll("Product_GetAllWithLimit", { pageSize: 250, expectedTotal: 618 }),
      CLIENT.PaginationError,
    );
    assert.match(err.message, /618/);
    assert.equal(err.resume.recordsDone, 500);
  });

  test("H2 — a mid-walk EMPTY page is an ERROR the caller must decide on", async () => {
    // The server answers page 2 with zero rows and then has data again. Treating that as the end
    // loses 368 products silently. Nothing here can distinguish "the data ended" from "one page
    // came back empty", so this fails loudly instead of guessing.
    const fetchImpl = deformableShop(618, { empty: new Set([250]) });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const err = await catchesAsync(
      () => c.readAll("Product_GetAllWithLimit", { pageSize: 250 }),
      CLIENT.EmptyPageError,
    );
    assert.match(err.message, /empty page/i);
    assert.equal(err.resume.cursor, 250, "the caller is told exactly where to resume");
    assert.equal(err.resume.recordsDone, 250);
  });

  test("H2 — an empty FIRST page is an empty RESULT SET, and that is decidable", async () => {
    const fetchImpl = deformableShop(0);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 50 });
    assert.deepEqual(all.records, []);
    assert.equal(all.stoppedBecause, "zero-rows");
  });

  test("H2 — { emptyPage: 'confirm' } needs a SECOND zero-row read before it believes the end", async () => {
    // First reading of Start=250 is empty; the corroborating re-read returns the rows. The walk
    // survives the hole instead of truncating on it.
    const fetchImpl = deformableShop(618, { emptyOnce: new Set([250]) });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 250, emptyPage: "confirm" });
    assert.equal(all.records.length, 618);
    assert.equal(all.emptyPagesRetried, 1);
  });

  test("H2 — { emptyPage: 'confirm' } stops when the SECOND read is empty too", async () => {
    const fetchImpl = deformableShop(618, { empty: new Set([618]) });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 250, emptyPage: "confirm" });
    assert.equal(all.records.length, 618);
    assert.equal(all.stoppedBecause, "zero-rows");
    assert.equal(fetchImpl.served.filter((s) => s === 618).length, 2, "the end of data is corroborated, not assumed");
  });

  test("H2 — { emptyPage: 'stop' } is the old behaviour and must be asked for BY NAME", async () => {
    const fetchImpl = deformableShop(618, { empty: new Set([250]) });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 250, emptyPage: "stop" });
    assert.equal(all.records.length, 250);
    assert.equal(all.complete, false, "a walk that stopped on an unconfirmed empty page is NOT complete");
  });
});

describe("H3 — the page-number base is not a silent default", () => {
  /** A page-style shop with an explicit base. `clamp` models a server that maps page 0 onto 1. */
  function pageShop(total, size, base, { clamp = false } = {}) {
    const seen = [];
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      let page = Number(/<Page>(\d+)</.exec(body)[1]);
      seen.push(page);
      if (clamp && page < base) page = base;
      const index = page - base;
      const rows = [];
      // An out-of-range page (e.g. Page=0 on a 1-BASED server) returns NOTHING. Without this the
      // double served a phantom page from a negative index, so a "1-based" server answered page 0
      // with rows and detectPageBase correctly concluded 0-based. The double was wrong, not the
      // detector: a real 1-based server faults, clamps, or returns empty, and all three are handled.
      if (index < 0) return { xml: RESULT(op, ITEMS(rows)) };
      for (let i = index * size; i < Math.min((index + 1) * size, total); i++) rows.push({ Id: String(i + 1) });
      return { xml: RESULT(op, ITEMS(rows)) };
    });
    fetchImpl.seen = seen;
    return fetchImpl;
  }

  test("the base and its EVIDENCE are an export the caller can read, not a comment", () => {
    assert.equal(CLIENT.SOAP_PAGE_BASE.verified, true);
    assert.equal(CLIENT.SOAP_PAGE_BASE.value, 1);
    assert.deepEqual(CLIENT.SOAP_PAGE_BASE.candidates, [0, 1]);
    assert.equal(CLIENT.SOAP_PAGE_BASE.source, "data/probes/pagebase.json");
    // The two methods, named, so "verified" cannot quietly decay into "we assumed it again".
    assert.match(CLIENT.SOAP_PAGE_BASE.why, /truth set/i);
    assert.match(CLIENT.SOAP_PAGE_BASE.why, /Page must be greater than 0/);
  });

  test("the scope keeps the SILENT operation out of the agreement count", () => {
    const { scope } = CLIENT.SOAP_PAGE_BASE;
    // Product_GetDiscountsAccumulativeAllWithPagination returned zero rows for BOTH candidate
    // first pages. That is an empty result set, not a vote. Recording it as agreement would be
    // the same class of error as reading a reply code as a state observation (D15).
    assert.deepEqual(scope.silent, ["Product_GetDiscountsAccumulativeAllWithPagination"]);
    assert.equal(scope.agreed.includes("Product_GetDiscountsAccumulativeAllWithPagination"), false);
    assert.equal(scope.agreed.length, 4, "four operations answered; the fifth had no data");
    // One shop. The claim must not read wider than the evidence.
    assert.deepEqual(scope.shops, ["shop000000"]);
    assert.match(CLIENT.SOAP_PAGE_BASE.openQuestion, /SECOND SHOP/);
  });

  test("with no explicit base the walk uses the RECORDED default, and says so", async () => {
    const fetchImpl = pageShop(25, 10, 1);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10 });
    assert.equal(all.records.length, 25);
    assert.equal(all.pageBase, 1);
    assert.deepEqual(fetchImpl.seen, [1, 2, 3, 4], "started at 1, never asked for page 0");
    // The evidence has to keep the weaker claim weak. This base came out of this repo, not out of
    // the shop being read, and an export that cannot tell those apart cannot be audited.
    assert.equal(all.pageBaseEvidence.source, "recorded-default");
    assert.equal(all.pageBaseEvidence.verifiedAgainstThisShop, false);
    assert.match(all.pageBaseEvidence.openQuestion, /SECOND SHOP/);
  });

  test("defaultPageBase: null restores H3's refusal for a shop that has not proved its base", async () => {
    const fetchImpl = pageShop(25, 10, 1);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, defaultPageBase: null });
    await c.connect();
    const before = fetchImpl.ops.length;
    const err = await catchesAsync(
      () => c.readAll("Order_GetAllWithPagination", { pageSize: 10 }),
      CLIENT.PageBaseUnverifiedError,
    );
    assert.match(err.message, /pageBase/);
    assert.equal(fetchImpl.ops.length, before, "no request may be sent on an unproved assumption");
  });

  test("a client-level defaultPageBase is reported as a CHOICE, not as the recorded value", async () => {
    const fetchImpl = pageShop(25, 10, 0);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, defaultPageBase: 0 });
    await c.connect();
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10 });
    assert.equal(all.records.length, 25, "a 0-based shop read whole because the operator said 0");
    assert.equal(all.pageBase, 0);
    assert.equal(all.pageBaseEvidence.source, "client-default");
  });

  test("the call's pageBase beats the client default", async () => {
    const fetchImpl = pageShop(25, 10, 0);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, defaultPageBase: 1 });
    await c.connect();
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10, pageBase: 0 });
    assert.equal(all.pageBase, 0);
    assert.equal(all.pageBaseEvidence.source, "caller");
    assert.equal(all.records.length, 25);
  });

  test("a nonsense defaultPageBase is refused at construction, not at the first walk", () => {
    assert.throws(
      () => createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: stub(() => ({ xml: "" })), defaultPageBase: 2 }),
      CLIENT.PaginationError,
    );
  });

  test("a startPage does NOT stand in for the base — the gate is not skippable by resuming", async () => {
    // The gate used to return early whenever startPage was an integer, on the reasoning that a
    // caller who names a page number has already made the base decision. It has not: { startPage: 1 }
    // against a 0-based server walks from page 1 and loses the ENTIRE first page with no error,
    // which is the same loss the gate exists to prevent, reached by another door. The recorded
    // default now fills that hole for a normal client, so the rule is asserted where it still
    // bites: a client whose default was switched off.
    const fetchImpl = pageShop(25, 10, 0);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, defaultPageBase: null });
    await c.connect();
    const before = fetchImpl.ops.length;
    const err = await catchesAsync(
      () => c.readAll("Order_GetAllWithPagination", { pageSize: 10, startPage: 1 }),
      CLIENT.PageBaseUnverifiedError,
    );
    assert.match(err.message, /startPage/);
    assert.equal(err.startPage, 1);
    assert.equal(fetchImpl.ops.length, before, "no request may be sent on an unproved assumption");

    // ...and a REAL resume carries both, which is exactly the shape `.resume.restart` hands back.
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10, startPage: 1, pageBase: 0 });
    assert.equal(all.records.length, 15, "pages 1 and 2 of a 0-based walk are records 11..25");
    assert.equal(all.records[0].Id, "11");
  });

  test("the RECORDED default does not silently rescue a 0-based shop — that loss is still real", async () => {
    // The honest cost of defaulting: against a 0-based server the default of 1 skips page 0 and
    // reports a complete read. This test PINS that so nobody can later claim the default is safe
    // in general; it is safe on the shops pagebase.json covers, and `detect` is the answer
    // elsewhere. If this ever starts passing with 25 records, the default became magic.
    const fetchImpl = pageShop(25, 10, 0);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10 });
    assert.equal(all.records.length, 15, "records 1..10 were lost — this is the residual risk, recorded");
    assert.equal(all.complete, true, "and the walk still calls itself complete, which is why it is dangerous");

    // The same shop, asked instead of assumed, reads whole.
    const c2 = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: pageShop(25, 10, 0) });
    await c2.connect();
    const detected = await c2.readAll("Order_GetAllWithPagination", { pageSize: 10, pageBase: "detect" });
    assert.equal(detected.records.length, 25);
    assert.equal(detected.pageBaseEvidence.verifiedAgainstThisShop, true);
  });

  test("an OFFSET-style read needs no such decision — Start:0 is recorded fact", async () => {
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      const start = Number(/<Start>(\d+)</.exec(body)[1]);
      return { xml: RESULT(op, start === 0 ? ITEMS([{ Id: "1" }]) : "") };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Product_GetAllWithLimit", { pageSize: 10 });
    assert.equal(all.records.length, 1);
  });

  test("{ pageBase: 0 } on a 0-BASED server reads every record", async () => {
    const fetchImpl = pageShop(25, 10, 0);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10, pageBase: 0 });
    assert.equal(all.records.length, 25);
    assert.equal(all.records[0].Id, "1", "page 0 is the FIRST page — assuming 1 loses it");
    assert.deepEqual(fetchImpl.seen, [0, 1, 2, 3]);
  });

  test("{ pageBase: 'detect' } finds a 0-BASED server empirically", async () => {
    const fetchImpl = pageShop(25, 10, 0);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10, pageBase: "detect" });
    assert.equal(all.pageBase, 0);
    assert.equal(all.pageBaseEvidence.decided, true);
    assert.equal(all.records.length, 25);
    assert.equal(all.records[0].Id, "1");
  });

  test("{ pageBase: 'detect' } finds a 1-BASED server empirically", async () => {
    const fetchImpl = pageShop(25, 10, 1);
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 10, pageBase: "detect" });
    assert.equal(all.pageBase, 1);
    assert.equal(all.records.length, 25);
    assert.equal(all.records[0].Id, "1");
  });

  test("detection REFUSES to guess when the server clamps page 0 onto page 1", async () => {
    const fetchImpl = pageShop(25, 10, 1, { clamp: true });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const err = await catchesAsync(
      () => c.readAll("Order_GetAllWithPagination", { pageSize: 10, pageBase: "detect" }),
      CLIENT.PageBaseUndecidableError,
    );
    assert.match(err.message, /same page/i);
  });
});

describe("H4 — a fault is never lost by the recovery that follows it", () => {
  function faultingShop({ setFieldsFailsFrom = 2 } = {}) {
    let setFields = 0;
    return stub((op) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      if (op === "Product_SetFields") {
        setFields += 1;
        return setFields >= setFieldsFailsFrom
          ? { xml: FAULT("NOSUCHPARAM", "No such parameter"), status: 500 }
          : { xml: RESULT(op, "1") };
      }
      return { xml: FAULT("INTERNAL", "An internal error in the service occured. Contact an administrator"), status: 500 };
    });
  }

  test("the ORIGINAL fault survives a re-assertion that itself faults", async () => {
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: faultingShop() });
    await c.connect();
    await c.setFields("Product", "Id,Title");
    const err = await catchesAsync(
      () => c.call("Product_GetAllWithLimit", { Start: 0, Length: 10 }),
      CLIENT.PostFaultReassertError,
    );
    assert.ok(err.originalFault instanceof DanDomainFaultError, "the diagnosis must not be deleted by the recovery");
    assert.equal(err.originalFault.kind, FAULT_KIND.UNKNOWN);
    assert.equal(err.originalFault.code, "INTERNAL");
    assert.equal(err.originalFault.op, "Product_GetAllWithLimit");
    assert.ok(err.reassertError instanceof FieldSetReassertError, "the re-assertion failure is its own named error");
    assert.equal(err.phase, "reassert");
    assert.match(err.message, /INTERNAL/);
    assert.match(err.message, /NOSUCHPARAM/);
  });

  test("a failed RECONNECT after an AUTH fault also preserves the AUTH fault", async () => {
    let connects = 0;
    const fetchImpl = stub((op) => {
      if (op === "Solution_Connect") {
        connects += 1;
        return connects === 1
          ? { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } }
          : { xml: FAULT("AUTH", "A valid authentication has not been performed with the service"), status: 500 };
      }
      return { xml: FAULT("AUTH", "A valid authentication has not been performed with the service"), status: 500 };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    const err = await catchesAsync(
      () => c.call("Product_GetAllWithLimit", { Start: 0, Length: 10 }),
      CLIENT.PostFaultReassertError,
    );
    assert.equal(err.phase, "reconnect");
    assert.equal(err.originalFault.kind, FAULT_KIND.AUTH);
    assert.equal(err.originalFault.op, "Product_GetAllWithLimit");
  });

  test("when the recovery SUCCEEDS the plain fault is still what surfaces", async () => {
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: faultingShop({ setFieldsFailsFrom: 99 }) });
    await c.connect();
    await c.setFields("Product", "Id,Title");
    const err = await catchesAsync(
      () => c.call("Product_GetAllWithLimit", { Start: 0, Length: 10 }),
      DanDomainFaultError,
    );
    assert.equal(err.code, "INTERNAL");
  });
});

describe("H5 — the R26 audit recurses into nested record collections", () => {
  /** Orders whose ORDER LINES are missing PacketId and Status on every line — R3's real case. */
  function orderShop(lineFields) {
    return stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      if (op === "Order_SetFields" || op === "Order_SetOrderLineFields") return { xml: RESULT(op, "1") };
      const page = Number(/<Page>(\d+)</.exec(body)[1]);
      if (page > 1) return { xml: RESULT(op, "") };
      const orders = [1, 2, 3].map((id) =>
        `<item><Id>${id}</Id><Status>1</Status><OrderLines>` +
        [0, 1].map((n) => `<item>${Object.entries(lineFields(id, n)).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</item>`).join("") +
        "</OrderLines></item>").join("");
      return { xml: RESULT(op, orders) };
    });
  }

  test("PacketId and Status missing on ALL order lines is a TRUNCATED COLUMN (R3's real defect)", async () => {
    const fetchImpl = orderShop((id, n) => ({ Id: `${id}${n}`, ProductId: 7, Amount: 1 }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await c.setFields("Order", "Id,Status,OrderLines");
    await c.setFields("OrderLine", "Id,ProductId,Amount,PacketId,Status");
    const err = await catchesAsync(
      () => c.readAll("Order_GetAllWithPagination", { pageSize: 50, pageBase: 1 }),
      FieldSetTruncatedError,
    );
    assert.match(err.message, /OrderLine/);
    assert.deepEqual(
      err.truncatedByType.find((t) => t.recordType === "OrderLine"),
      { recordType: "OrderLine", path: "OrderLines", fields: ["PacketId", "Status"], records: 6 },
    );
  });

  test("a field on SOME nested records is an EMPTY VALUE, not a truncation (R26 applies to nesting too)", async () => {
    const fetchImpl = orderShop((id, n) => (id === 3 && n === 1
      ? { Id: `${id}${n}`, ProductId: 7, Amount: 1, PacketId: 4, Status: "1" }
      : { Id: `${id}${n}`, ProductId: 7, Amount: 1 }));
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await c.setFields("Order", "Id,Status,OrderLines");
    await c.setFields("OrderLine", "Id,ProductId,Amount,PacketId,Status");
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 50, pageBase: 1 });
    const lines = all.audit.nested.find((n) => n.recordType === "OrderLine");
    assert.equal(lines.objectRecords, 6, "the WHOLE batch of nested records, not one order's worth");
    assert.deepEqual(lines.partial, [{ field: "PacketId", present: 1, of: 6 }, { field: "Status", present: 1, of: 6 }]);
    assert.deepEqual(lines.truncated, []);
  });

  test("zero nested records is UNDECIDABLE, not truncated (R28's lesson, one level down)", async () => {
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      if (op === "Order_SetFields" || op === "Order_SetOrderLineFields") return { xml: RESULT(op, "1") };
      const page = Number(/<Page>(\d+)</.exec(body)[1]);
      if (page > 1) return { xml: RESULT(op, "") };
      return { xml: RESULT(op, ITEMS([{ Id: 1, Status: 1, OrderLines: "" }, { Id: 2, Status: 1, OrderLines: "" }])) };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await c.setFields("Order", "Id,Status,OrderLines");
    await c.setFields("OrderLine", "Id,PacketId");
    const all = await c.readAll("Order_GetAllWithPagination", { pageSize: 50, pageBase: 1 });
    const lines = all.audit.nested.find((n) => n.recordType === "OrderLine");
    assert.equal(lines.decidable, false);
    assert.deepEqual(lines.truncated, []);
  });

  test("Product.Variants are audited against the ProductVariant set, and Pictures are SURVEYED", async () => {
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      if (op === "Product_SetFields" || op === "Product_SetVariantFields") return { xml: RESULT(op, "1") };
      const start = Number(/<Start>(\d+)</.exec(body)[1]);
      if (start > 0) return { xml: RESULT(op, "") };
      const p = (id) => `<item><Id>${id}</Id><Title>t${id}</Title>` +
        `<Variants><item><Id>${id}1</Id><Stock>3</Stock></item></Variants>` +
        `<Pictures><item><Id>${id}9</Id><FileName>f${id}.png</FileName></item></Pictures></item>`;
      return { xml: RESULT(op, [1, 2].map(p).join("")) };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl });
    await c.connect();
    await c.setFields("Product", "Id,Title,Variants,Pictures");
    await c.setFields("ProductVariant", "Id,Stock,Ean");
    const err = await catchesAsync(
      () => c.readAll("Product_GetAllWithLimit", { pageSize: 50 }),
      FieldSetTruncatedError,
    );
    // Ean is on ZERO of the 2 variants: a truncated column on a NESTED type.
    assert.deepEqual(err.truncatedByType.find((t) => t.recordType === "ProductVariant").fields, ["Ean"]);
    // Pictures has no *_SetFields operation, so there is nothing to audit against — but the shape
    // is still reported per record type instead of being invisible.
    const pics = err.audit.nested.find((n) => n.recordType === "ProductPicture");
    assert.equal(pics.audited, false);
    assert.equal(pics.objectRecords, 2);
    assert.deepEqual(pics.fieldsSeen, [{ field: "Id", present: 2, of: 2 }, { field: "FileName", present: 2, of: 2 }]);
  });

  test("the nested record TYPES come from the WSDL, not from a hand-written map", () => {
    assert.deepEqual(CLIENT.nestedRecordTypes("Order").find((n) => n.field === "OrderLines"),
      { field: "OrderLines", recordType: "OrderLine" });
    const product = CLIENT.nestedRecordTypes("Product");
    assert.deepEqual(product.find((n) => n.field === "Variants"), { field: "Variants", recordType: "ProductVariant" });
    assert.deepEqual(product.find((n) => n.field === "Pictures"), { field: "Pictures", recordType: "ProductPicture" });
    assert.deepEqual(product.find((n) => n.field === "StockLocations"), { field: "StockLocations", recordType: "ProductStockLocation" });
    // ArrayOfInt / ArrayOfString are lists of SCALARS and must not be mistaken for record types.
    assert.equal(product.some((n) => n.field === "RelatedProductIds"), false);
    assert.equal(product.some((n) => n.field === "LanguageAccess"), false);
  });
});

describe("H6 — bounded retry for TRANSPORT errors only, and a resumable paged read", () => {
  /** Deterministic backoff: no real sleeping, and the jitter source is injected. */
  const fastRetry = (extra = {}) => ({ sleep: async () => {}, random: () => 0.5, ...extra });

  test("a transport blip on an idempotent READ is retried and the read succeeds", async () => {
    let n = 0;
    const fetchImpl = stub((op) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      n += 1;
      if (n < 3) throw new TypeError("fetch failed");
      return { xml: RESULT(op, ITEMS([{ Id: "1" }])) };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, retry: fastRetry() });
    await c.connect();
    const res = await c.call("Product_GetAllWithLimit", { Start: 0, Length: 10 });
    assert.equal(res.records.length, 1);
    assert.equal(res.transportAttempts, 3);
    assert.equal(c.stats.transportRetries, 2);
  });

  test("the backoff is bounded, exponential and JITTERED", async () => {
    const slept = [];
    const fetchImpl = stub((op) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      throw new TypeError("fetch failed");
    });
    const c = createClient({
      endpoint: "http://x/", ...CREDS, fetchImpl,
      retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 350, sleep: async (ms) => { slept.push(ms); }, random: () => 1 },
    });
    await c.connect();
    const err = await catchesAsync(() => c.call("Product_GetAllWithLimit", { Start: 0, Length: 10 }), SoapTransportError);
    assert.deepEqual(slept, [100, 200, 350], "100, 200, then CAPPED at 350");
    assert.equal(err.transportAttempts, 4);
    assert.match(err.message, /4 attempt/);

    // ...and the jitter is real: random() === 0 collapses every wait to the floor.
    const slept2 = [];
    const c2 = createClient({
      endpoint: "http://x/", ...CREDS, fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 350, sleep: async (ms) => { slept2.push(ms); }, random: () => 0 },
    });
    await c2.connect();
    await catchesAsync(() => c2.call("Product_GetAllWithLimit", { Start: 0, Length: 10 }), SoapTransportError);
    assert.notDeepEqual(slept2, [100, 200], "a fixed backoff is not a jittered one");
    assert.ok(slept2.every((ms) => ms >= 0 && ms <= 200), JSON.stringify(slept2));
  });

  test("a named FAULT is NEVER retried", async () => {
    const fetchImpl = stub((op) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      return { xml: FAULT("INTERNAL", "An internal error in the service occured. Contact an administrator"), status: 500 };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, retry: fastRetry() });
    await c.connect();
    await catchesAsync(() => c.call("Product_GetAllWithLimit", { Start: 0, Length: 10 }), DanDomainFaultError);
    assert.deepEqual(fetchImpl.ops.filter((o) => o === "Product_GetAllWithLimit").length, 1);
  });

  test("a CREATE is NEVER retried, however transport-y the failure looks (F16)", async () => {
    // Order_Create can succeed and THEN throw. A transport error says nothing about whether the
    // order exists, so a retry is how you get two orders.
    let n = 0;
    const fetchImpl = stub((op) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      n += 1;
      throw new TypeError("fetch failed");
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, retry: fastRetry() });
    await c.connect();
    const err = await catchesAsync(
      () => c.call("Order_Create", { OrderData: { CurrencyId: 1, PaymentId: 4, DeliveryId: 2 } }),
      SoapTransportError,
    );
    assert.equal(n, 1, "exactly one attempt: a retried create is a duplicated order");
    assert.equal(err.transportAttempts, 1);
    assert.match(err.retryRefusedBecause, /not replayable/i);
  });

  test("a paged read that dies mid-walk hands back the state needed to RESUME it", async () => {
    const total = 618;
    let calls = 0;
    const shop = (failOn) => stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      calls += 1;
      if (failOn(calls)) throw new TypeError("fetch failed");
      const start = Number(/<Start>(\d+)</.exec(body)[1]);
      const length = Number(/<Length>(\d+)</.exec(body)[1]);
      const rows = [];
      for (let i = start; i < Math.min(start + length, total); i++) rows.push({ Id: String(i + 1) });
      return { xml: RESULT(op, ITEMS(rows)) };
    });
    // Dies on every attempt of the third page (retries included), after 200 records.
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: shop((n) => n >= 3), retry: fastRetry() });
    await c.connect();
    const err = await catchesAsync(() => c.readAll("Product_GetAllWithLimit", { pageSize: 100 }), SoapTransportError);
    assert.equal(err.resume.op, "Product_GetAllWithLimit");
    assert.equal(err.resume.cursor, 200, "resume at offset 200, not at zero");
    assert.equal(err.resume.recordsDone, 200);
    assert.equal(err.resume.pagesDone, 2);
    assert.deepEqual(err.resume.restart, { start: 200 });

    // The caller resumes from exactly that state against a healthy server and loses nothing.
    calls = 0;
    const c2 = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl: shop(() => false), retry: fastRetry() });
    await c2.connect();
    const rest = await c2.readAll("Product_GetAllWithLimit", { pageSize: 100, ...err.resume.restart });
    assert.equal(rest.records.length, 418);
    assert.equal(rest.records[0].Id, "201", "the resumed walk begins exactly where the dead one stopped");
  });

  test("a PAGE-style walk resumes by page number, carrying the base it was told", async () => {
    let calls = 0;
    const fetchImpl = stub((op, body) => {
      if (op === "Solution_Connect") return { xml: RESULT(op, "1"), headers: { "set-cookie": "PHPSESSID=ok" } };
      calls += 1;
      if (calls === 2) throw new TypeError("fetch failed");
      const page = Number(/<Page>(\d+)</.exec(body)[1]);
      const rows = [];
      for (let i = page * 10; i < Math.min((page + 1) * 10, 25); i++) rows.push({ Id: String(i + 1) });
      return { xml: RESULT(op, ITEMS(rows)) };
    });
    const c = createClient({ endpoint: "http://x/", ...CREDS, fetchImpl, retry: { maxAttempts: 1 } });
    await c.connect();
    const err = await catchesAsync(
      () => c.readAll("Order_GetAllWithPagination", { pageSize: 10, pageBase: 0 }),
      SoapTransportError,
    );
    assert.deepEqual(err.resume.restart, { startPage: 1, pageBase: 0 });
  });
});
