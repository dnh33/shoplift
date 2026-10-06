/**
 * test/ftp.test.mjs — offline acceptance tests for src/dandomain/ftp.js (R11).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The FTPS transport was PROMOTED from the probe with a live transcript behind it, but the only
 * thing under test/ that exercised it was `_scratch-ftp.mjs`: a console.log walk-through with no
 * assertions, which cannot fail. Every scenario that scratch explored is promoted here into an
 * assertion, and the R11.1 ordering rule — the one that cost a live hang to discover — is
 * asserted against the WIRE (the mock server's own control-channel log at the instant the client
 * begins the data handshake), not against a comment.
 *
 * THE HEADLINE RULE (R11.1). "Upgrade the data channel AFTER the transfer command's 1xx, not on
 * connect." Two tests carry it:
 *
 *   1. the ordering test snapshots BOTH ends of the control channel at the exact moment
 *      tls.connect() is called on the data socket, and asserts the transfer command had been
 *      sent and the 150 had been ANSWERED before that moment;
 *   2. the negative control drives the forbidden order by hand — PASV, TCP connect, handshake
 *      immediately, no transfer command — and asserts the handshake never completes. That is
 *      what proves the mock reproduces ProFTPD's behaviour, so rule 1 is load-bearing rather
 *      than a property the mock would grant to any client.
 *
 * Everything runs against scripts/probe-dandomain.ftp-mock.mjs on loopback. No network.
 *
 * ALWAYS PASS A TEST TIMEOUT. `node --test` defaults to NO per-test timeout, and the honest
 * symptom of several bugs here (violate R11.1, or lose collect()'s `close` listener) is "this
 * never finishes" — which under the default looks like a hung CI job instead of a red test. The
 * repo runner passes one for you.
 *
 * Run: node --test --test-timeout=30000 test/ftp.test.mjs   (or: node test/run-dandomain.mjs ftp)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import net from "node:net";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

import { ftpsConnect, parseList, ftpReplyReader, DEFAULT_MAX_TRANSFER_BYTES } from "../src/dandomain/ftp.js";
import { startFtpsMock, ONE_PX_PNG } from "../scripts/probe-dandomain.ftp-mock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The mock's throwaway self-signed cert, read out of the mock source (as the R11 scratch did). */
const MOCK_CA = (() => {
  const src = readFileSync(path.join(ROOT, "scripts", "probe-dandomain.ftp-mock.mjs"), "utf8");
  const from = src.indexOf("const TEST_CERT = [");
  const region = src.slice(from, src.indexOf("].join(", from));
  return [...region.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join("\n");
})();

const BASE = { host: "127.0.0.1", user: "u", pass: "p", timeoutMs: 8000 };
const withCa = (extra) => ({ ...BASE, tlsOptions: { ca: MOCK_CA }, ...extra });

/** `{">" : "LIST /x"}` / `{"<": "150 ..."}` -> `"> LIST /x"` / `"< 150 ..."`. */
const line = (entry) => {
  const [dir, value] = Object.entries(entry)[0];
  return `${dir} ${value}`;
};

/** assert.rejects() does not hand back the error; this does. */
async function catchesAsync(fn) {
  let caught = null;
  try { await fn(); } catch (e) { caught = e; }
  assert.ok(caught, "expected a rejection, got none");
  return caught;
}

/** Bound wait so a rule that has been broken fails in seconds instead of hanging on a timeout. */
function deadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`HUNG: ${what} did not finish within ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

/** The commands the SERVER actually received, in order — the wire, not the client's own record. */
const sentTo = (srv) => srv.log.filter((e) => e[">"] !== undefined).map((e) => e[">"]);

/**
 * Run `fn` with net.connect (or tls.connect) patched so every socket it creates is captured.
 * Used to prove a socket was DESTROYED: "no leak" is otherwise unobservable from the outside,
 * and a leaked control socket is what makes a broken suite hang instead of fail.
 */
/** The server's live connection count once it stops changing — a FIN takes a turn of the loop to
 *  be observed, so asserting instantly would be a flake rather than a check. */
async function settledConnections(server, withinMs) {
  const until = Date.now() + withinMs;
  for (;;) {
    const n = await new Promise((res) => server.getConnections((_, count) => res(count)));
    if (n === 0 || Date.now() > until) return n;
    await new Promise((res) => setTimeout(res, 25));
  }
}

async function capturingSockets(mod, fn) {
  const real = mod.connect;
  const made = [];
  mod.connect = (...args) => { const s = real.apply(mod, args); made.push(s); return s; };
  try { return { made, value: await fn(made) }; } finally { mod.connect = real; }
}

// ---------------------------------------------------------------------------------------------
describe("R11.1 — the data channel is upgraded AFTER the transfer command's 1xx", () => {
  test("at the instant of the data handshake, the command was sent AND the 150 was answered", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    // Patch only AFTER login, so the explicit-mode CONTROL upgrade (which also passes a socket)
    // cannot be mistaken for a data upgrade. Every capture below is therefore a data channel.
    const realConnect = tls.connect;
    const upgrades = [];
    const opened = [];
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      assert.equal(s.prot, true, "PROT P must have been accepted, or this test proves nothing");

      tls.connect = (opts, ...rest) => {
        upgrades.push({
          hasSocket: Boolean(opts?.socket),
          server: srv.log.map(line),          // what the SERVER had exchanged, at this instant
          client: s.transcript.map(line),     // what the CLIENT had recorded, at this instant
        });
        const sock = realConnect.call(tls, opts, ...rest);
        // Kept so that a FAILING run (an implementation that upgrades too early and never gets a
        // ServerHello) tears its own sockets down instead of leaving the suite holding handles.
        opened.push(opts?.socket, sock);
        return sock;
      };

      const listed = await deadline(s.xferIn("LIST /images"), 5000, "LIST");
      assert.equal(listed.openCode, 150);
      assert.equal(listed.finCode, 226);
      assert.ok(listed.bytes > 0, "the transfer must actually have carried bytes");

      assert.equal(upgrades.length, 1, "exactly one data-channel TLS upgrade for one transfer");
      const u = upgrades[0];
      assert.equal(u.hasSocket, true, "a data upgrade wraps the already-connected PASV socket");

      // --- SERVER SIDE: the 1xx had already left the server before the client handshook. ---
      const iPasv = u.server.findIndex((l) => l === "> PASV");
      const i227 = u.server.findIndex((l) => l.startsWith("< 227 "));
      const iCmd = u.server.findIndex((l) => l === "> LIST /images");
      const i1xx = u.server.findIndex((l) => /^< 1\d\d /.test(l));
      assert.ok(iPasv >= 0 && i227 > iPasv, "PASV must precede the data connection");
      assert.ok(iCmd > i227, `the transfer command must reach the server before the upgrade: ${JSON.stringify(u.server)}`);
      assert.ok(i1xx > iCmd, `the 1xx must be ANSWERED before the upgrade (R11.1): ${JSON.stringify(u.server)}`);
      assert.equal(u.server.at(-1), "< 150 opening data connection for LIST",
        "the last thing on the control channel before the data handshake is the 1xx itself");
      assert.equal(u.server.some((l) => l.startsWith("< 226 ")), false,
        "the transfer cannot already be complete when the data channel is being secured");

      // --- CLIENT SIDE: the same ordering, seen from the client's own transcript. ---
      assert.deepEqual(u.client.at(-2), "> LIST /images");
      assert.deepEqual(u.client.at(-1), "< 150");

      // …and the upgrade really happened: the data channel is TLS and resumed the control session.
      assert.equal(s.dataTls.protocol?.startsWith("TLS"), true, JSON.stringify(s.dataTls));
      assert.equal(s.dataTls.ticketAvailable, true, "R11.2: a control-session ticket was available");
      assert.equal(s.dataTls.sessionReused, true, "R11.2: the data channel RESUMED the control session");
    } finally {
      tls.connect = realConnect;
      for (const sock of opened) { try { sock?.destroy(); } catch { /* already gone */ } }
      s?.quit();
      await srv.close();
    }
  });

  test("NEGATIVE CONTROL: handshaking on connect (R10's spec) never completes", async () => {
    // This is the failure R11.1 corrects. The mock reproduces ProFTPD: it does not touch the data
    // socket until the transfer command has been accepted. So an early handshake gets no
    // ServerHello — it hangs until the client's timeout, which is exactly what the live run saw.
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const plain = await s.dataConnect();          // PASV + TCP connect, no transfer command yet
      const early = tls.connect({
        socket: plain, ca: MOCK_CA, servername: "127.0.0.1", session: s.tlsSession,
      });
      const outcome = await new Promise((resolve) => {
        const t = setTimeout(() => resolve("no-handshake"), 1200);
        t.unref?.();
        early.once("secureConnect", () => { clearTimeout(t); resolve("handshook"); });
        early.once("error", (e) => { clearTimeout(t); resolve(`error:${e.code ?? e.message}`); });
      });
      assert.equal(outcome, "no-handshake",
        "the mock must NOT handshake before the 1xx — otherwise the ordering test proves nothing");
      early.destroy();
      plain.destroy();
      // Free the mock's pending PASV listener (RETR of a missing file calls its closePasv()).
      assert.equal((await s.cmd("RETR /nope")).code, 550);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("the ordering is the same for an OUTBOUND transfer, and the bytes round-trip", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    const realConnect = tls.connect;
    const seen = [];
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      tls.connect = (opts, ...rest) => {
        seen.push(srv.log.map(line).at(-1));
        return realConnect.call(tls, opts, ...rest);
      };
      const put = await deadline(s.xferOut("STOR /images/up.png", ONE_PX_PNG), 5000, "STOR");
      assert.equal(put.openCode, 150);
      assert.equal(put.finCode, 226);
      assert.equal(put.sentBytes, ONE_PX_PNG.length);
      assert.deepEqual(seen, ["< 150 ready to receive"], "xferOut upgrades after its own 1xx too");

      const back = await deadline(s.xferIn("RETR /images/up.png"), 5000, "RETR");
      assert.equal(Buffer.compare(back.buf, ONE_PX_PNG), 0, "TYPE I: the PNG survives byte for byte");
      assert.equal((await s.cmd("DELE /images/up.png")).code, 250);
      assert.equal((await s.cmd("DELE /images/up.png")).code, 550, "…and it is really gone");
    } finally {
      tls.connect = realConnect;
      s?.quit();
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("R11.2/R11.3/R11.4 — the other corrections the live run paid for", () => {
  test("R11.3 — PASV's advertised (NAT) IP is recorded but never dialled", async () => {
    const srv = await startFtpsMock({ mode: "explicit", advertiseBogusIp: true });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const got = await deadline(s.xferIn("LIST /images"), 5000, "LIST over a bogus PASV IP");
      assert.equal(got.finCode, 226, "a client that dialled 10.255.255.1 would time out here");
      assert.equal(s.pasv.length, 1);
      assert.equal(s.pasv[0].advertised, "10.255.255.1", "the NAT address is kept as evidence");
      assert.equal(s.pasv[0].usedHost, "127.0.0.1", "…and the CONTROL host is what was dialled");
      assert.equal(s.pasv[0].advertisedDifferedFromControl, true);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("R11.2 — the session ticket comes from the EVENT; getSession() alone can be undefined", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      assert.ok(s.tlsSession, "the 'session' event must have delivered a ticket");
      await deadline(s.xferIn("LIST /images"), 5000, "LIST");
      assert.equal(s.dataTls.sessionReused, true);
      assert.deepEqual(srv.dataChannels.at(-1), { secure: true, sessionReused: true },
        "and the SERVER agrees it was a resumed session, not just the client's own field");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("R11.2 — BEHAVIOURAL: the EVENT ticket is preferred, and getSession() is the FALLBACK", async () => {
    // This replaced `assert.match(FTP_SRC, /this\.tlsSession \?\? .../)`. A source-text assertion
    // survives any semantics-preserving break and breaks on any harmless rename; it tests the
    // characters in the file, not the rule. Both halves of the `??` are now driven for real.
    const srv = await startFtpsMock({ mode: "explicit" });
    let a = null, b = null;
    try {
      // (a) getSession() gone — resumption must still happen, from the event-captured ticket.
      a = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      assert.ok(a.tlsSession, "precondition: the 'session' event delivered a ticket");
      a.sock.getSession = () => undefined;
      await deadline(a.xferIn("LIST /images"), 5000, "LIST with getSession() blinded");
      assert.equal(srv.dataChannels.at(-1).sessionReused, true, "the EVENT ticket carried the resumption");

      // (b) no event ticket — getSession() is consulted rather than resumption being abandoned.
      b = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      assert.ok(b.sock.getSession?.(), "precondition: this socket does have a getSession() session");
      b.tlsSession = undefined;
      await deadline(b.xferIn("LIST /images"), 5000, "LIST with only getSession()");
      assert.equal(srv.dataChannels.at(-1).sessionReused, true, "the FALLBACK carried the resumption");
    } finally {
      a?.quit(); b?.quit();
      await srv.close();
    }
  });

  test("R11.2 — the SERVER can REQUIRE resumption, and a client that does not resume is refused", async () => {
    // The mock advertised `requireSessionReuse` in its header for a whole review round while
    // implementing it nowhere, so the most expensive R11.2 claim ("the server REQUIRES it;
    // failure looks like a refused data channel") had no server-side test at all.
    const srv = await startFtpsMock({ mode: "explicit", requireSessionReuse: true });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const ok = await deadline(s.xferIn("LIST /images"), 5000, "resumed LIST");
      assert.equal(ok.finCode, 226, "the real client resumes, so the strict server serves it");
      assert.deepEqual(srv.dataChannels.at(-1), { secure: true, sessionReused: true });

      // Now take the control session away — the M29 mutation, done from the outside.
      s.tlsSession = undefined;
      s.sock.getSession = () => undefined;
      const err = await catchesAsync(() => deadline(s.xferIn("LIST /images"), 9000, "unresumed LIST"));
      assert.equal(srv.dataChannels.at(-1).sessionReused, false,
        "the SERVER's own observation is the evidence, not a field the client set about itself");
      assert.equal(err.reply?.code, 426, `a strict server refuses the channel: ${err.message}`);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("the client's OWN record tells the truth when a data channel does not resume", async () => {
    // Kills the mutation that hardcodes `sessionReused: true`: here the FIRST data channel — the
    // only one `dataTls` ever records — is genuinely unresumed, so a hardcoded true is visible.
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      s.tlsSession = undefined;
      s.sock.getSession = () => undefined;
      const got = await deadline(s.xferIn("LIST /images"), 5000, "unresumed LIST");
      assert.equal(got.finCode, 226, "this mock does not enforce reuse, so the transfer works");
      assert.equal(srv.dataChannels.at(-1).sessionReused, false, "precondition: it really did not resume");
      assert.equal(s.dataTls.sessionReused, false, "the client must not claim a resumption it did not get");
      assert.equal(s.dataTls.ticketAvailable, false);
      assert.deepEqual(s.dataChannels, { secured: 1, cleartext: 0, resumed: 0, notResumed: 1 });
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("R11.4 — PBSZ/PROT/TYPE are recorded, and a refused PROT leaves a WORKING cleartext channel", async () => {
    const srv = await startFtpsMock({ mode: "explicit", refuseProt: true });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      assert.equal(s.pbsz, 200);
      assert.equal(s.protReply, 534, "the refusal is RECORDED, not assumed successful");
      assert.equal(s.prot, false);
      assert.equal(s.typeI, 200);
      const got = await deadline(s.xferIn("LIST /images"), 5000, "LIST with PROT refused");
      assert.equal(got.finCode, 226, "the transfer still completes in cleartext");
      assert.equal(s.dataTls, undefined, "…and the transcript shows it was never secured");
      // `dataTls` describes the FIRST data channel only, so on a long session it cannot answer
      // "were they ALL encrypted?". The counters can, and they are what makes a mid-session
      // downgrade visible instead of hiding behind transfer #1's record.
      assert.deepEqual(s.dataChannels, { secured: 0, cleartext: 1, resumed: 0, notResumed: 0 });
      await deadline(s.xferIn("LIST /logs"), 5000, "second cleartext LIST");
      assert.deepEqual(s.dataChannels, { secured: 0, cleartext: 2, resumed: 0, notResumed: 0 });
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("R11.4 — PBSZ 0, PROT P, TYPE I reach the WIRE, in that order", async () => {
    // The only PBSZ assertion used to be `s.pbsz === 200` — a field the module sets on itself.
    // Deleting the `PBSZ 0` command entirely, or reordering all three, passed the whole suite.
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      assert.deepEqual(sentTo(srv), ["AUTH TLS", "USER u", "PASS ****", "PBSZ 0", "PROT P", "TYPE I"],
        "R11.4's order is a rule the live run paid for, not a comment");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("a refused data channel surfaces as a 425 REPLY, fast — and does not leak the PASV socket", async () => {
    const srv = await startFtpsMock({ mode: "explicit", rejectData: true });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const started = Date.now();
      // Patch only AFTER login, so the only socket captured is the PASV data socket.
      const { made } = await capturingSockets(net, async () => {
        const err = await catchesAsync(() => deadline(s.xferIn("LIST /images"), 15000, "refused LIST"));
        assert.equal(err.reply?.code, 425, err.message);
      });
      assert.ok(Date.now() - started < 12000, "425 must arrive on the control channel, not after a data timeout");
      assert.equal(made.length, 1, "exactly one PASV data socket was opened");
      assert.equal((await s.cmd("PWD")).code, 257, "…and the control channel is still in step");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("a transfer command refused AFTER PASV closes the orphaned data socket", async () => {
    // Deliberately NOT the rejectData mock: there the SERVER destroys the data connection, so the
    // client's socket dies whatever the client does and the assertion proves nothing. On the 550
    // path the mock closes only its LISTENER and leaves the accepted socket open, so the only
    // thing that can close the client's end is the client.
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const { made } = await capturingSockets(net, async () => {
        const inbound = await catchesAsync(() => deadline(s.xferIn("RETR /nope"), 5000, "RETR of a missing file"));
        assert.equal(inbound.reply?.code, 550, inbound.message);
        const outbound = await catchesAsync(() => deadline(s.xferOut("APPE /nope", ONE_PX_PNG), 5000, "unsupported APPE"));
        assert.equal(outbound.reply?.code, 502, outbound.message);
      });
      assert.equal(made.length, 2, "one PASV data socket per refused transfer");
      assert.deepEqual(made.map((m) => m.destroyed), [true, true],
        "both orphaned data sockets must be closed — the same class of leak as the greeting path");
      assert.equal((await s.cmd("PWD")).code, 257);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("implicit mode logs in on the TLS socket from byte 0 and transfers the same way", async () => {
    const srv = await startFtpsMock({ mode: "implicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "implicit" }));
      assert.equal(s.mode, "implicit");
      assert.equal(s.authTlsReply, undefined, "implicit mode must not send AUTH TLS");
      assert.equal(s.prot, true);
      const got = await deadline(s.xferIn("LIST /images"), 5000, "implicit LIST");
      const names = parseList(got.buf.toString("latin1")).map((e) => e.name);
      assert.deepEqual(names.sort(), ["product-1.png", "product-2.png", "product-5.png"]);
    } finally {
      s?.quit();
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("certificate verification and secret handling", () => {
  test("verification is ON by default: the self-signed mock is REFUSED", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    try {
      const err = await catchesAsync(() => ftpsConnect({ ...BASE, port: srv.port, mode: "explicit" }));
      assert.equal(err.stage, "tls-upgrade", "the stage names the wrong assumption");
      assert.match(String(err.message), /self-signed|self signed|unable to verify/i);
    } finally {
      await srv.close();
    }
  });

  test("a rejectUnauthorized:false smuggled inside tlsOptions does NOT disable verification", async () => {
    // tlsOpts() applies the single visible switch LAST, so the copy inside tlsOptions cannot win.
    const srv = await startFtpsMock({ mode: "explicit" });
    try {
      const err = await catchesAsync(() => ftpsConnect({
        ...BASE, port: srv.port, mode: "explicit", tlsOptions: { rejectUnauthorized: false },
      }));
      assert.match(String(err.message), /self-signed|self signed|unable to verify/i);
    } finally {
      await srv.close();
    }
  });

  test("checkServerIdentity inside tlsOptions CAN relax the hostname check — so it is recorded", async () => {
    // The header used to claim "a copy smuggled inside tlsOptions cannot quietly disable
    // verification". That is true of exactly one key: `rejectUnauthorized`, which tlsOpts() pins.
    // With rejectUnauthorized left at its default TRUE, a `checkServerIdentity` override still
    // turns hostname verification off completely. The override stays reachable (connecting by IP
    // to a cert issued for a name is a legitimate need, and the JSDoc licenses it) — but it is no
    // longer silent: it is recorded on the session and warned about, the way a refused PROT is.
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      const hostile = { ca: MOCK_CA, servername: "evil.example" };
      const refused = await catchesAsync(() => ftpsConnect({
        ...BASE, port: srv.port, mode: "explicit", tlsOptions: hostile,
      }));
      assert.match(String(refused.message), /altnames|Hostname\/IP does not match/i,
        "control: without the override, the wrong servername IS refused");

      const warns = [];
      s = await ftpsConnect({
        ...BASE, port: srv.port, mode: "explicit",
        tlsOptions: { ...hostile, checkServerIdentity: () => undefined },
        logger: { warn: (e) => warns.push(e) },
      });
      assert.equal(s.controlTls.authorized, true, "the CHAIN is still verified — this is a partial bypass");
      assert.equal(s.identityCheckOverridden, true, "…but the hostname check was replaced, and the session says so");
      assert.deepEqual(s.tlsOptionKeys, ["ca", "checkServerIdentity", "servername"]);
      assert.ok(warns.some((w) => JSON.stringify(w).includes("checkServerIdentity")),
        `the override must be warned about, got ${JSON.stringify(warns)}`);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("a session with no identity override says so too", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      assert.equal(s.identityCheckOverridden, false, "recorded as false, not left as a missing field");
      assert.deepEqual(s.tlsOptionKeys, ["ca"]);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("rejectUnauthorized:false is reachable, but only by name", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect({ ...BASE, port: srv.port, mode: "explicit", rejectUnauthorized: false });
      assert.equal(s.controlTls.authorized, false);
      assert.match(String(s.controlTls.authorizationError), /self.signed/i);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("the password never reaches the transcript, the logger or a thrown error", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    const events = [];
    let s = null;
    try {
      s = await ftpsConnect(withCa({
        port: srv.port, mode: "explicit", pass: "hunter2-SECRET",
        logger: { debug: (e) => events.push(e) },
      }));
      const dump = JSON.stringify({ transcript: s.transcript, events });
      assert.equal(dump.includes("hunter2-SECRET"), false, "the password leaked into an artifact");
      assert.ok(s.transcript.some((e) => e[">"] === "PASS ****"), "…and the redacted form is what is kept");
      assert.equal(s.leftoverBeforeUpgrade, 0, "no control bytes were dropped across the TLS upgrade");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("a broken logger cannot break a transfer", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({
        port: srv.port, mode: "explicit", logger: { debug() { throw new Error("logger exploded"); } },
      }));
      const got = await deadline(s.xferIn("LIST /images"), 5000, "LIST with a throwing logger");
      assert.equal(got.finCode, 226);
    } finally {
      s?.quit();
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("a transfer that ends badly is a FAILURE, and never leaves the session desynced", () => {
  test("a transfer the server ABORTS (426) must not be returned as a short success", async () => {
    // The defect: xferIn read the final reply and returned `finCode` without ever looking at it,
    // so a 426-aborted RETR resolved with a truncated buffer and `truncated: false`. A 23-byte
    // PNG then reaches the media export looking complete. Note this is indistinguishable from a
    // clean EOF at the socket level — the reply code is the ONLY signal there is.
    const srv = await startFtpsMock({ mode: "explicit", dataAbort: "truncate" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const err = await catchesAsync(() => deadline(s.xferIn("RETR /images/product-1.png"), 6000, "aborted RETR"));
      assert.equal(err.reply?.code, 426, `the abort must surface as the reply code: ${err.message}`);
      assert.ok(err.partial, "the bytes that DID arrive are handed over, not thrown away");
      assert.ok(err.partial.bytes > 0 && err.partial.bytes < ONE_PX_PNG.length,
        `a partial file: ${err.partial.bytes} of ${ONE_PX_PNG.length}`);
      assert.equal(err.partial.buf.length, err.partial.bytes);
      assert.ok(!s.broken, "the 426 WAS read, so the control channel is still in step");
      assert.equal((await s.cmd("PWD")).code, 257, "…and the next command gets its own reply");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("the same when the data socket dies with no FIN at all (close, not end)", async () => {
    // collect() listens for BOTH 'end' and 'close'. Dropping the 'close' listener passed the whole
    // suite while turning every RST'd peer into a 60-second hang.
    const srv = await startFtpsMock({ mode: "explicit", dataAbort: "destroy" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const err = await catchesAsync(() => deadline(s.xferIn("RETR /images/product-1.png"), 6000, "RST'd RETR"));
      assert.equal(err.reply?.code, 426, err.message);
      assert.equal((await s.cmd("PWD")).code, 257, "the 426 was consumed; the session survives");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("collect() finishes on a socket that CLOSES without ever emitting 'end'", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const fake = new EventEmitter();
      fake.destroy = () => { };
      const pending = s.collect(fake, 1024, 4000);
      fake.emit("data", Buffer.from("abc"));
      fake.emit("close");                       // a peer that RSTs never emits 'end'
      const got = await deadline(pending, 2000, "collect() on a close-only socket");
      assert.deepEqual({ bytes: got.bytes, truncated: got.truncated, text: got.buf.toString() },
        { bytes: 3, truncated: false, text: "abc" });
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("BLIND SPOT: no final reply at all marks the session BROKEN instead of desyncing it forever", async () => {
    // Nobody considered this one. With the data channel dead and the server's 426 never sent, the
    // old code left that reply unread: `PWD` then returned the PREVIOUS command's reply, and every
    // command after it was permanently one reply out of step — with no flag saying so, and
    // client.js handing the corrupt session straight to callers.
    const srv = await startFtpsMock({ mode: "explicit", dataAbort: "tls-garbage", noFinalReply: true });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const err = await catchesAsync(() => deadline(
        s.xferIn("RETR /images/product-1.png", { abortDrainMs: 800 }), 9000, "RETR onto a dead data channel"));
      assert.match(String(err.message), /data-channel TLS after 150/);
      assert.equal(err.sessionBroken, true);
      assert.match(String(s.broken), /final reply/, `the session must say why it is unusable: ${s.broken}`);
      const after = await catchesAsync(() => s.cmd("PWD"));
      assert.match(String(after.message), /broken/i,
        "a broken session must REFUSE commands, not answer them with the previous reply");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("a transfer whose FINAL REPLY never arrives also breaks the session", async () => {
    // The data moved and the socket closed cleanly, so this is not the aborted case — but the
    // 226 can still turn up later and be served to the next command, which is the same desync.
    const srv = await startFtpsMock({ mode: "explicit", dataAbort: "truncate", noFinalReply: true });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const err = await catchesAsync(() => deadline(
        s.xferIn("RETR /images/product-1.png", { finTimeoutMs: 700 }), 6000, "RETR with no final reply"));
      assert.match(String(err.message), /reply timeout/);
      assert.equal(err.sessionBroken, true);
      assert.match(String(s.broken), /final reply never arrived/);
      const after = await catchesAsync(() => s.cmd("PWD"));
      assert.match(String(after.message), /broken/i);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("a CRLF in a path cannot inject a second command", async () => {
    // Paths reach this module from Product_GetPictures FileNames — server-controlled data. cmd()
    // wrote the line verbatim, so one xferIn() put FOUR lines on the control channel and really
    // deleted a file.
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const before = srv.log.length;
      const err = await catchesAsync(() => s.xferIn("RETR /images/x.png\r\nDELE /images/product-1.png"));
      assert.match(String(err.message), /injection|CR, LF or NUL/i);
      assert.equal(srv.log.length, before, "not one byte reached the wire — not even the PASV");
      assert.notEqual(srv.files["/images/product-1.png"], undefined, "the injected DELE never ran");

      const direct = await catchesAsync(() => s.cmd("PWD\r\nDELE /images/product-2.png"));
      assert.match(String(direct.message), /injection|CR, LF or NUL/i);
      assert.notEqual(srv.files["/images/product-2.png"], undefined);
      assert.equal((await s.cmd("PWD")).code, 257, "a rejected command leaves the session usable");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("BLIND SPOT: two transfers on one session are refused, not interleaved", async () => {
    // FTP multiplexes nothing: one control channel, one data channel at a time. Fired in
    // parallel, the two PASVs and the two transfer commands interleave and both transfers die —
    // one of them only after a 20s handshake timeout. A media walk that parallelises is the
    // obvious way for a caller to hit this.
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const first = s.xferIn("LIST /images");
      const second = catchesAsync(() => s.xferIn("LIST /logs"));
      const err = await deadline(second, 3000, "the rejected second transfer");
      assert.match(String(err.message), /already in flight/i);
      const got = await deadline(first, 5000, "the first transfer");
      assert.equal(got.finCode, 226, "the refusal must not damage the transfer already running");
      const later = await deadline(s.xferIn("LIST /logs"), 5000, "a later, sequential transfer");
      assert.equal(later.finCode, 226, "…and the guard releases");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("the byte cap is configurable, reachable, and keeps the chunk that straddles it", async () => {
    const srv = await startFtpsMock({ mode: "explicit" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));

      // The straddle: 5 x 1000B against a 2500B cap used to yield 2000 bytes — a whole chunk
      // short. At 16MB with 64KB TLS records that is up to a full record lost before the limit.
      const stream = new PassThrough();
      const pending = s.collect(stream, 2500, 4000);
      for (let i = 0; i < 5; i++) stream.write(Buffer.alloc(1000, i));
      stream.end();
      const capped = await deadline(pending, 3000, "collect() at a 2500-byte cap");
      assert.equal(capped.bytes, 5000, "every byte is COUNTED");
      assert.equal(capped.truncated, true);
      assert.equal(capped.buf.length, 2500, "…and the buffer is filled exactly to the cap");

      // Reachable from the public API: xferIn took only `command`, so neither the cap nor the
      // 60s transfer timeout could be set by a caller at all.
      const small = await deadline(s.xferIn("RETR /images/product-1.png", { maxBytes: 10 }), 5000, "capped RETR");
      assert.equal(small.truncated, true);
      assert.equal(small.buf.length, 10);
      assert.equal(small.bytes, ONE_PX_PNG.length);
      assert.equal(typeof DEFAULT_MAX_TRANSFER_BYTES, "number", "the default is exported, not hidden in a signature");

      const whole = await deadline(s.xferIn("RETR /images/product-1.png"), 5000, "uncapped RETR");
      assert.equal(whole.truncated, false);
      assert.equal(Buffer.compare(whole.buf, ONE_PX_PNG), 0);
    } finally {
      s?.quit();
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("bringing the session up: every failure closes the socket and names the stage", () => {
  test("the greeting never arriving is a named failure with a CLOSED socket, not a leak", async () => {
    // Accept, drain, and never greet. `resume()` matters: a paused socket never reads, so it
    // would never observe the client's FIN and this server could never close.
    const idle = net.createServer((sock) => sock.resume());
    await new Promise((res) => idle.listen(0, "127.0.0.1", res));
    try {
      const { made } = await capturingSockets(net, async () => {
        const err = await catchesAsync(() => ftpsConnect({
          ...BASE, port: idle.address().port, mode: "explicit", timeoutMs: 700,
        }));
        assert.match(String(err.message), /reply timeout/);
        assert.equal(err.stage, "greeting", "the stage must name the wrong assumption");
        assert.ok(Array.isArray(err.transcript), "…and the transcript must come with it");
      });
      assert.equal(made.length, 1);
      assert.equal(made[0].destroyed, true, "the control socket must be closed on the way out");
      assert.equal(await settledConnections(idle, 3000), 0, "the SERVER must see the connection go away too");
    } finally {
      await new Promise((res) => idle.close(res));
    }
  });

  test("a 421 greeting is refused (explicit), with the socket closed", async () => {
    const srv = await startFtpsMock({ mode: "explicit", badGreeting: true });
    try {
      const { made } = await capturingSockets(net, async () => {
        const err = await catchesAsync(() => ftpsConnect(withCa({ port: srv.port, mode: "explicit" })));
        assert.match(String(err.message), /greeting 421/);
        assert.equal(err.stage, "greeting");
        assert.ok(err.transcript.some((e) => e["<"] === 421));
      });
      assert.equal(made[0].destroyed, true);
    } finally {
      await srv.close();
    }
  });

  test("a 421 greeting is refused in IMPLICIT mode too", async () => {
    const srv = await startFtpsMock({ mode: "implicit", badGreeting: true });
    try {
      const err = await catchesAsync(() => ftpsConnect(withCa({ port: srv.port, mode: "implicit" })));
      assert.match(String(err.message), /greeting 421/);
      assert.equal(err.stage, "greeting");
    } finally {
      await srv.close();
    }
  });

  test("a login refused with 530 is an ERROR, not a live session", async () => {
    // Deleting the PASS reply-code check passed all 64 assertions: no test ever drove a server
    // that says no. A "connected" session with authed=false then fails on the next command.
    const srv = await startFtpsMock({ mode: "explicit", refuseLogin: true });
    try {
      const { made } = await capturingSockets(net, async () => {
        const err = await catchesAsync(() => ftpsConnect(withCa({
          port: srv.port, mode: "explicit", pass: "hunter2-SECRET",
        })));
        assert.match(String(err.message), /login refused \(530/);
        assert.equal(err.stage, "command");
        assert.ok(err.transcript.some((e) => e[">"] === "PASS ****"), "the transcript comes back redacted");
        assert.equal(JSON.stringify(err.transcript).includes("hunter2-SECRET"), false,
          "a failed login is exactly when a transcript gets attached to an error and logged");
      });
      assert.equal(made[0].destroyed, true, "and the socket does not leak on this path either");
    } finally {
      await srv.close();
    }
  });

  test("AUTH TLS refused: the AUTH SSL FALLBACK is what gets the session up, and it is recorded", async () => {
    // Deleting the fallback outright passed all 64 assertions.
    const srv = await startFtpsMock({ mode: "explicit", refuseAuth: "tls" });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      assert.equal(s.authTlsReply, 500);
      assert.equal(s.authSslFallbackUsed, true);
      assert.deepEqual(sentTo(srv).slice(0, 2), ["AUTH TLS", "AUTH SSL"]);
      const got = await deadline(s.xferIn("LIST /images"), 5000, "LIST over an AUTH SSL session");
      assert.equal(got.finCode, 226, "the fallback produces a WORKING session, not just a code");
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("AUTH refused outright fails with the stage named and the socket closed", async () => {
    const srv = await startFtpsMock({ mode: "explicit", refuseAuth: "both" });
    try {
      const { made } = await capturingSockets(net, async () => {
        const err = await catchesAsync(() => ftpsConnect(withCa({ port: srv.port, mode: "explicit" })));
        assert.match(String(err.message), /AUTH TLS\/SSL refused \(500/);
        assert.equal(err.stage, "command");
      });
      assert.equal(made[0].destroyed, true);
    } finally {
      await srv.close();
    }
  });

  test("a reply pipelined with the 234 is NOT silently dropped by the TLS upgrade", async () => {
    // `leftoverBeforeUpgrade` was only ever ASSIGNED, never read, and it measured the wrong thing:
    // a reply the reader had already PARSED sits in its queue where neither pending() nor
    // detach() can see it, so 0 was compatible with having thrown a whole reply away — and a
    // dropped reply is exactly what puts the control channel permanently out of step.
    const srv = await startFtpsMock({ mode: "explicit", pipelineAfterAuth: "220 pipelined nonsense" });
    try {
      const err = await catchesAsync(() => ftpsConnect(withCa({ port: srv.port, mode: "explicit" })));
      assert.match(String(err.message), /dropped by the TLS upgrade/i);
      assert.equal(err.stage, "tls-upgrade");
      assert.equal(err.queuedBeforeUpgrade, 1, "one fully-parsed reply was sitting in the reader");
      assert.equal(err.leftoverBeforeUpgrade, 0);
    } finally {
      await srv.close();
    }
  });

  test("an unrecognised mode is a configuration error, not a plaintext attempt on port 21", async () => {
    // client.js builds `modes` straight from user config, so a typo used to become a cleartext
    // dial of port 21 instead of a config error.
    const { made } = await capturingSockets(net, async () => {
      for (const mode of ["ftps", "Implicit", "", undefined]) {
        const err = await catchesAsync(() => ftpsConnect({ ...BASE, mode, port: 12345 }));
        assert.match(String(err.message), /mode must be/, `mode ${JSON.stringify(mode)}`);
      }
      // `port || default` also swallowed an explicit 0.
      const bad = await catchesAsync(() => ftpsConnect({ ...BASE, mode: "explicit", port: 0 }));
      assert.match(String(bad.message), /port/);
    });
    assert.equal(made.length, 0, "a rejected configuration must not dial anything at all");
  });
});

// ---------------------------------------------------------------------------------------------
describe("the control-channel line protocol and the LIST parser", () => {
  test("ftpReplyReader handles single-line and multi-line replies and reports leftovers", async () => {
    const { PassThrough } = await import("node:stream");
    const sock = new PassThrough();
    const rdr = ftpReplyReader(sock);
    sock.write("220 hello\r\n211-Features:\r\n UTF8\r\n PROT\r\n211 End\r\n150 partial");
    assert.deepEqual(await rdr.next(1000), { code: 220, text: "220 hello" });
    const feat = await rdr.next(1000);
    assert.equal(feat.code, 211);
    assert.match(feat.text, /UTF8 \|\s+PROT/);
    assert.match(feat.multiline, /^211-Features:\r\n UTF8\r\n PROT\r\n211 End\r\n$/);
    assert.equal(rdr.pending(), "150 partial".length, "an unterminated reply stays buffered");
    assert.equal(rdr.queued(), 0, "…and nothing is left parsed-but-unread");
    assert.equal(rdr.detach(), "150 partial");
  });

  test("queued() sees the replies pending() and detach() cannot", async () => {
    const sock = new PassThrough();
    const rdr = ftpReplyReader(sock);
    sock.write("234 go\r\n226 a whole extra reply\r\n150 half");
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(await rdr.next(1000), { code: 234, text: "234 go" });
    assert.equal(rdr.queued(), 1, "the 226 is fully parsed and waiting — invisible to pending()");
    assert.equal(rdr.pending(), "150 half".length);
    assert.equal(rdr.detach(), "150 half", "detach() only ever returned the UNPARSED tail");
  });

  test("a UTF-8 filename: `name` stays wire-safe and `nameUtf8` is what a SOAP FileName matches", () => {
    // The consumer is the media export, matching against Product_GetPictures FileNames, which are
    // UTF-8 (F2). Decoded latin1, every Danish product image with æ/ø/å silently fails to match.
    const NAME = "Æblegrød.png";
    const onTheWire = Buffer.from(NAME, "utf8").toString("latin1");   // what LIST actually carries
    const [row] = parseList(`-rw-r--r--   1 ftp ftp        71236 Aug 15 19:00 ${onTheWire}`);
    assert.equal(row.name, onTheWire, "`name` is the byte-preserving form RETR must be given");
    assert.notEqual(row.name, NAME, "…which is deliberately NOT the readable string");
    assert.equal(row.nameUtf8, NAME, "`nameUtf8` is the one a SOAP FileName can be compared to");
  });

  test("a filename whose bytes are NOT valid UTF-8 is left alone rather than corrupted twice", () => {
    // An ISO-8859-1 server: 0xE9 is a bare `é`, not a UTF-8 sequence. Re-decoding it would be the
    // same double-conversion F2 forbids, so the latin1 form is kept as the truthful one.
    const [row] = parseList("-rw-r--r--   1 ftp ftp           10 Aug 15 19:00 café.png");
    assert.equal(row.name, "café.png");
    assert.equal(row.nameUtf8, row.name, "no U+FFFD, no invention");
  });

  test("an unparsed line has no name in either encoding", () => {
    const [row] = parseList("total 4");
    assert.deepEqual([row.type, row.name, row.nameUtf8], ["unparsed", null, null]);
  });

  test("END TO END: a non-ASCII image is listed, matched by its UTF-8 name, and RETRieved", async () => {
    const NAME = "Æblegrød.png";
    const onTheWire = Buffer.from(NAME, "utf8").toString("latin1");
    const srv = await startFtpsMock({
      mode: "explicit",
      files: { "/images": null, [`/images/${onTheWire}`]: ONE_PX_PNG },
    });
    let s = null;
    try {
      s = await ftpsConnect(withCa({ port: srv.port, mode: "explicit" }));
      const listed = await deadline(s.xferIn("LIST /images"), 5000, "LIST with a UTF-8 filename");
      const rows = parseList(listed.buf.toString("latin1"));
      const hit = rows.find((r) => r.nameUtf8 === NAME);
      assert.ok(hit, `no row matched the SOAP-side name: ${JSON.stringify(rows.map((r) => r.nameUtf8))}`);
      // …and the WIRE form is what the transfer command has to use.
      const back = await deadline(s.xferIn(`RETR /images/${hit.name}`), 5000, "RETR by the wire name");
      assert.equal(Buffer.compare(back.buf, ONE_PX_PNG), 0);
    } finally {
      s?.quit();
      await srv.close();
    }
  });

  test("parseList keeps unparsed lines instead of dropping them", () => {
    const rows = parseList([
      "drwxr-xr-x   2 ftp ftp         4096 Aug 15 19:00 images",
      "-rw-r--r--   1 ftp ftp        71236 Aug 15 19:00 product-1.png",
      "lrwxrwxrwx   1 ftp ftp            9 Aug 15 19:00 latest -> product-1.png",
      "08-15-26  07:00PM       <DIR>          winstyle",
      "total 4",
      "",
    ].join("\r\n"));
    assert.deepEqual(rows.map((r) => [r.type, r.name, r.size, r.nameUtf8]), [
      ["dir", "images", 4096, "images"],
      ["file", "product-1.png", 71236, "product-1.png"],
      ["link", "latest", 9, "latest"],
      ["dir", "winstyle", null, "winstyle"],
      ["unparsed", null, undefined, null],
    ]);
    assert.equal(rows.at(-1).raw, "total 4", "a line nobody can parse is still visible");
  });
});
