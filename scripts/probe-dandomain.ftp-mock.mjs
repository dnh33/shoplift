#!/usr/bin/env node
/**
 * probe-dandomain.ftp-mock.mjs — a tiny FTPS server for OFFLINE testing of the hand-rolled
 * FTPS client in probe-dandomain.mjs (R10). Zero dependencies, Node >= 20.
 *
 * Why this exists: R10's transport spec (explicit AUTH TLS, PBSZ 0 / PROT P, TYPE I, PASV with
 * the control host reused instead of the advertised IP, TLS session resumption on the data
 * channel) was written from the protocol and a hostname, not from a run. This mock lets every
 * one of those rules be regression-tested without touching a live shop — the same pattern
 * probe-dandomain.mock.mjs already provides for SOAP.
 *
 * It deliberately reproduces the two traps that break naive FTPS clients:
 *   1. `advertiseBogusIp` — PASV advertises an unroutable IP while listening on loopback, so a
 *      client that trusts the advertised address hangs. R10 says reuse the CONTROL host.
 *   2. `requireSessionReuse` — the data channel refuses connections that did not resume the
 *      control connection's TLS session (vsftpd's `require_ssl_reuse=YES`, which is the default).
 *
 * NOTE ON (2): this option was ADVERTISED here for a whole review round while being implemented
 * NOWHERE — the header and the @param list mentioned it, `grep requireSessionReuse` found only
 * those two comments, and so R11.2 ("the server REQUIRES resumption") had no server-side test at
 * all. It is now real: the data channel checks `isSessionReused()` on the server's own TLSSocket
 * and answers 426 when the client did not resume, and every data channel the mock secures is
 * recorded in `srv.dataChannels` so a test can assert resumption from the SERVER's observation
 * instead of from a field the client computed about itself.
 *
 * The other options exist because a mutation survived without them: `refuseLogin` (a 530 to PASS),
 * `badGreeting` (421 + close), `refuseAuth` (AUTH TLS refused, so the AUTH SSL fallback is
 * exercised), `pipelineAfterAuth` (an extra reply glued to the 234, which is the only way to catch
 * a client that upgrades TLS without draining the reply reader) and `dataAbort` (a transfer that
 * dies after the 1xx, with or without a final reply — the difference between a recoverable session
 * and a desynced one).
 *
 * Usage (tests):  const srv = await startFtpsMock({ mode: "explicit" }); ... await srv.close();
 * Usage (manual): node scripts/probe-dandomain.ftp-mock.mjs [explicit|implicit] [port]
 *
 * The keypair below is a THROWAWAY self-signed cert generated for this file. It is a test
 * fixture, not a credential — it protects nothing and must never be used anywhere else.
 */
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const TEST_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCQZUtXeTgH+36F",
  "wDhnCX3fum5soxUhoRlIYyiuX2NLxrXIvF1ftuDeIuTuECZPfKW+ecKtSE09zFsl",
  "yc3m+sL2t/tseDL+K9gfUTSMJnkNf2kO0H5nkPN9q0Ff67FbdYdyYEWpClqOhSF3",
  "I/A7MO7+nzSw42dmKOuMD/AkiEtjBPp5TF/uryj9q+JXrfTi5rHnW3chcrdh7N8S",
  "P4la4Z69JIph9S4WUvwLGil+qKSJvaAtfcJjxOCuw+RtKojLLgewOtmstt6SJagv",
  "+YjGtUSVrF6nAimtzo1Z7zxIqsZV1YHsswJENsHu6oDWbZQnoHWo9rT0Awt88fci",
  "AKQfp1FbAgMBAAECggEADx2Tc/48B9XjakPzg5HCTAPboGK4CROwrlu2+/3/SoTs",
  "La3ORoFB6+8SMPuezw5Y2WYso3Agqdn1JrEH7WiNtT8QQkwY5nOXhbu9+PfkDy4p",
  "xMO9n8DURHEDgHOPVugoPCho0mfDkAzOsoagFMosEpp+7Q95GQAqnDhk5qYf4icQ",
  "dP9XEaM4pAhqjDHnNJW0XrNeOep0ijLDbQEMwpZbbwpbig/V0jcPM6+2jPkZ7Pyu",
  "2wzdgdtmysvqc2d/VN3FgUi86giTV4Ht/ED0TUesrKZoNY+pApYSFkfWwAddsRyT",
  "QaVXN58alALOLlSX9EVndBXW8tHJJOzK4ljZi6k1SQKBgQDKWLRAeXvexm6nRARv",
  "CPp0Nch7LhNh+jCAVEru8EKIBgwpIuTAokQpyJ+IITvpi10h/OoNRa8SzFGEDG1n",
  "ljcm2rR99P81xdm/QvyJz+FEhxHSgkJWCb/ZIaAzMluEek45JesNKUP3zuNuWQc1",
  "LNuuFFL+Gojlh+t6FH6V4eGmwwKBgQC2ruJXDt8iUQWShUBHiRoMAx4Kn6FwXBBE",
  "tGwh0+bJ8XuBHc1uxrJSBG1f6El9efqg8KXlfPsUwdNeJUw+KyDE65s1whKeltnp",
  "oLy3+2/6mNDPDPdBbmU2Ziv1S+PDUq8kRivMi5Jqe3j4I+1BHSjn/TkCtIIBI1Ep",
  "vd5zpQNxiQKBgH44gRAq98MKguHiAuYEcr7lAc8c+chHWdPjQO71fnr9Ur6iXpFv",
  "ZxetZx5ypL3VSl42NwXabxBJ1ZuKaQCR6otZJ/feSQiRB3hQX9nTi9DEdLCcwqaK",
  "5FqcqCLnicEEziDF727BS/2b17Dw5hcciVh4oyCRCs4rUA9SE3iJc8ojAoGBAIEB",
  "5XMHXIn2X5IGKcuaxVsgRHHKIw6e5Rovs4D8DKolr0sSCcYl6T3ERJ0LBALpRhWr",
  "e+whI4qYCjUc78ejW0PVAkmnYNC/xOmYikz+8igtDKB7Do0VccJFytsyGYkQ9gAO",
  "0dVj5yTtRxMtA9oMxpt1lnITmQ9GqoVowRQ3vsPJAoGAKnFd9YrRYb73C5CQQf+q",
  "K8/vC2DmjrnuF/FBhuH30BEBFCZMNrpBYp98hlLxUpqDq0llwjfMKq3vspUYdNgD",
  "4VdhHWhYxTKy9DvBSMN6BiVziW0/RRSKDEh6n1nzr902jjGyFsJQz31FByy4cYU+",
  "9Y8ysdfeKgQynbpVDKVJAPA=",
  "-----END PRIVATE KEY-----",
].join("\n");
const TEST_CERT = [
  "-----BEGIN CERTIFICATE-----",
  "MIIDJTCCAg2gAwIBAgIUeII7sP/cj/LR8GthO6ZpNlou4LMwDQYJKoZIhvcNAQEL",
  "BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgxNTE5MTI0M1oXDTQ2MDgx",
  "MDE5MTI0M1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF",
  "AAOCAQ8AMIIBCgKCAQEAkGVLV3k4B/t+hcA4Zwl937pubKMVIaEZSGMorl9jS8a1",
  "yLxdX7bg3iLk7hAmT3ylvnnCrUhNPcxbJcnN5vrC9rf7bHgy/ivYH1E0jCZ5DX9p",
  "DtB+Z5DzfatBX+uxW3WHcmBFqQpajoUhdyPwOzDu/p80sONnZijrjA/wJIhLYwT6",
  "eUxf7q8o/aviV6304uax51t3IXK3YezfEj+JWuGevSSKYfUuFlL8Cxopfqikib2g",
  "LX3CY8TgrsPkbSqIyy4HsDrZrLbekiWoL/mIxrVElaxepwIprc6NWe88SKrGVdWB",
  "7LMCRDbB7uqA1m2UJ6B1qPa09AMLfPH3IgCkH6dRWwIDAQABo28wbTAdBgNVHQ4E",
  "FgQUMooaxCIuaiIAqcHS6iN50LHav6wwHwYDVR0jBBgwFoAUMooaxCIuaiIAqcHS",
  "6iN50LHav6wwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH",
  "BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAG5RL/o5z5D2llpT6P+NY+UYgMWiFfU1",
  "Exp+5MBRbX3HMNNlINhJkpwxQiFv9+IDMLs64blmz47mlU3EbZXp9vRybEprmGzQ",
  "NV3T4GTnKOoqck49lcubkuWIvjwgsgU7dY9h64vUOJZhvnP4YjC0QNvP3BxkPMOv",
  "mMz0H6BsJ0seSEEmh6AGF1iNkRNB1tbaTm5uJ9qb6dKRdt09+47RM1SuOMdrVvVJ",
  "STOxY14uw5fhRfODMsx7AtmmaLtcfq/AiwYB2ottu4H07lhWPBF53hhvI0AWWvJG",
  "exqwuAQCt/wxl0Vs9wxilClFwtewQNp7Og2H8N42E2XNMsszvzuZRRw=",
  "-----END CERTIFICATE-----",
].join("\n");

// A real 1x1 PNG — the RETR test asserts the magic bytes survive TYPE I.
export const ONE_PX_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000a49444154789c6300010000050001" +
  "0d0a2db40000000049454e44ae426082", "hex");

const DEFAULT_FILES = {
  "/images": null,                               // null = directory
  "/images/product-1.png": ONE_PX_PNG,
  "/images/product-2.png": ONE_PX_PNG,
  "/images/product-5.png": ONE_PX_PNG,
  "/logs": null,
  "/logs/access.txt": Buffer.from("not an image\n"),
};

const two = (port) => [Math.floor(port / 256), port % 256];

/**
 * @param {object} opt
 * @param {"explicit"|"implicit"} opt.mode
 * @param {number} [opt.port] 0 = ephemeral
 * @param {object} [opt.files] path -> Buffer (file) or null (directory)
 * @param {boolean} [opt.advertiseBogusIp] PASV advertises 10.255.255.1 (tests R10's NAT rule)
 * @param {boolean} [opt.requireSessionReuse] data channel answers 426 unless the client resumed
 *   the CONTROL connection's TLS session (vsftpd `require_ssl_reuse=YES`). R11.2's server side.
 * @param {boolean} [opt.refuseProt] PROT P answers 534 (tests the "record the refusal" path)
 * @param {boolean} [opt.rejectData] the PASV listener destroys the data connection -> 425
 * @param {boolean} [opt.refuseLogin] PASS answers 530 (tests that a refused login is not a session)
 * @param {boolean} [opt.badGreeting] greet with 421 and close, like a server at its connection cap
 * @param {"tls"|"both"} [opt.refuseAuth] "tls" = AUTH TLS 500 / AUTH SSL 234 (exercises the
 *   fallback); "both" = neither is accepted
 * @param {string} [opt.pipelineAfterAuth] an extra COMPLETE reply written in the same packet as
 *   the 234, e.g. "220 pipelined". A client that upgrades TLS without draining its reader loses it.
 * @param {"truncate"|"destroy"|"tls-garbage"} [opt.dataAbort] make RETR die after the 1xx:
 *   send part of the file then FIN / then RST / never handshake at all.
 * @param {boolean} [opt.noFinalReply] after a dataAbort, say NOTHING on the control channel — the
 *   case that leaves a careless client permanently one reply out of step.
 */
export async function startFtpsMock(opt = {}) {
  const mode = opt.mode ?? "explicit";
  const files = { ...(opt.files ?? DEFAULT_FILES) };
  const ticketKeys = crypto.randomBytes(48); // shared so the data channel CAN resume the control session
  const tlsOpt = { key: TEST_KEY, cert: TEST_CERT, ticketKeys };
  const log = [];
  /** The SERVER's own observation of every data channel it secured — the only trustworthy
   *  evidence for R11.2, because the client's `dataTls.sessionReused` is a field the client
   *  computes about itself and a broken client can report it as true unconditionally. */
  const dataChannels = [];

  const dirOf = (p) => (p === "/" ? "/" : p.replace(/\/+$/, ""));
  const children = (dir) => {
    const d = dirOf(dir), pre = d === "/" ? "/" : d + "/";
    const out = [];
    for (const [k, v] of Object.entries(files)) {
      if (!k.startsWith(pre) || k === d) continue;
      const rest = k.slice(pre.length);
      if (rest.includes("/")) continue;
      out.push({ name: rest, isDir: v === null, size: v === null ? 4096 : v.length });
    }
    return out;
  };
  const listText = (dir) => children(dir).map((e) =>
    `${e.isDir ? "d" : "-"}rw${e.isDir ? "x" : "-"}r-${e.isDir ? "x" : "-"}r-${e.isDir ? "x" : "-"}   1 ftp      ftp      ${String(e.size).padStart(12)} Aug 15 19:00 ${e.name}`
  ).join("\r\n") + (children(dir).length ? "\r\n" : "");

  const handle = (sock, isSecureAlready) => {
    let secure = isSecureAlready, authed = false, prot = false, type = "A";
    let cwd = "/", pending = null, rest = "";
    const say = (s) => { log.push({ "<": s }); sock.write(s + "\r\n", "latin1"); };
    const bind = (s) => {
      s.setNoDelay?.(true);
      s.on("data", (d) => {
        rest += Buffer.from(d).toString("latin1");
        for (; ;) {
          const i = rest.indexOf("\r\n");
          if (i < 0) break;
          const line = rest.slice(0, i); rest = rest.slice(i + 2);
          onLine(line).catch((e) => say(`451 mock error: ${e.message}`));
        }
      });
      s.on("error", () => { });
    };
    /** Opens the PASV listener as a PLAIN socket server. Returns the advertised 227 string.
     *  LIVE FACT (shop000000, ProFTPD, 2026-08-15): the server does NOT handshake the data
     *  channel on connect — it waits for the transfer command to be accepted first. This mock
     *  reproduces that ordering, because a mock that handshakes immediately would happily
     *  certify a client sequence the real server hangs on.
     *  sockP always settles: {ok:true, sock} or {ok:false, reason} — a data channel that
     *  never arrives must produce a 425, not a hang (the client's timeout path is tested). */
    const openPasv = () => new Promise((res) => {
      const srv = net.createServer();
      let settle; const sockP = new Promise((r) => (settle = r));
      const timer = setTimeout(() => settle({ ok: false, reason: "no data connection within 5s" }), 5000);
      timer.unref?.();
      srv.on("connection", (ds) => {
        clearTimeout(timer);
        if (opt.rejectData) { log.push({ note: "data connection REJECTED (rejectData)" }); ds.destroy(); return settle({ ok: false, reason: "rejected by policy" }); }
        settle({ ok: true, sock: ds });
      });
      srv.listen(0, "127.0.0.1", () => {
        // unref'd on purpose: a transfer that FAILS part-way (which is what the R11.1 ordering
        // test provokes) leaves this listener unclaimed, and a referenced listener would then
        // hold the whole test process open — a red test would look like a hung suite.
        // It changes nothing while a transfer is in flight: the control and data sockets are
        // referenced, so the process still cannot exit underneath a live session.
        srv.unref?.();
        const port = srv.address().port;
        pending = { srv, sockP };
        const ip = opt.advertiseBogusIp ? "10,255,255,1" : "127,0,0,1";
        const [p1, p2] = two(port);
        res(`227 Entering Passive Mode (${ip},${p1},${p2})`);
      });
    });
    /** Claim the pending data socket, or emit 425 and return null. Caller sends 150, THEN
     *  calls secureData() — matching the live server's ordering. */
    const takeData = async () => {
      if (!pending) { say("425 use PASV first"); return null; }
      const { srv, sockP } = pending; pending = null;
      const r = await sockP;
      try { srv.close(); } catch { }
      if (!r.ok) { say(`425 can't open data connection: ${r.reason}`); return null; }
      return r.sock;
    };
    /** Upgrade the data socket AFTER the 1xx, mirroring ProFTPD. With `requireSessionReuse` the
     *  server enforces R11.2 for real: a data channel whose TLS session did not resume the
     *  control session is destroyed, exactly as vsftpd's `require_ssl_reuse=YES` does. Either
     *  way the observation is recorded in srv.dataChannels. */
    const secureData = (raw) => new Promise((res, rej) => {
      if (!prot) { dataChannels.push({ secure: false, sessionReused: null }); return res(raw); }
      const up = new tls.TLSSocket(raw, { isServer: true, ...tlsOpt });
      const t = setTimeout(() => rej(new Error("data TLS handshake timeout")), 10000);
      up.on("secure", () => {
        clearTimeout(t);
        const sessionReused = up.isSessionReused?.() ?? false;
        dataChannels.push({ secure: true, sessionReused });
        if (opt.requireSessionReuse && !sessionReused) {
          log.push({ note: "data channel REFUSED: TLS session was not resumed (requireSessionReuse)" });
          up.destroy();
          const e = new Error("TLS session reuse required on the data channel");
          e.ftpReply = "426 data connection: TLS session reuse required";
          return rej(e);
        }
        res(up);
      });
      up.on("error", (e) => { clearTimeout(t); rej(e); });
    });
    /** A data-channel failure is a 4xx on the CONTROL channel, not a 451 mock error — that is
     *  what a real server does and what the client's recovery path has to cope with. */
    const dataFailure = (e) => say(e.ftpReply ?? `426 data connection failed: ${e.message}`);
    const closePasv = () => { if (pending) { try { pending.srv.close(); } catch { } pending = null; } };
    const resolve = (arg) => {
      if (!arg) return cwd;
      return arg.startsWith("/") ? dirOf(arg) : dirOf((cwd === "/" ? "/" : cwd + "/") + arg);
    };

    async function onLine(line) {
      log.push({ ">": /^PASS/i.test(line) ? "PASS ****" : line });
      const [cmdRaw, ...restArgs] = line.split(" ");
      const cmd = cmdRaw.toUpperCase(), arg = restArgs.join(" ");
      if (cmd === "AUTH") {
        if (secure) return say("534 already secure");
        if (!/^TLS/i.test(arg) && !/^SSL/i.test(arg)) return say("504 unknown AUTH type");
        // refuseAuth:"tls" refuses only AUTH TLS, so the client's AUTH SSL fallback is the ONLY
        // way through — that fallback had no coverage at all before this option existed.
        if (opt.refuseAuth === "both") return say("500 AUTH not understood");
        if (opt.refuseAuth === "tls" && /^TLS/i.test(arg)) return say("500 AUTH TLS not available");
        say("234 AUTH TLS OK, starting TLS");
        // Written in the SAME packet as the 234, before the handshake starts: a client that
        // upgrades without draining its reply reader silently loses this reply and is then one
        // reply out of step forever.
        if (opt.pipelineAfterAuth) { log.push({ "<": opt.pipelineAfterAuth }); sock.write(opt.pipelineAfterAuth + "\r\n", "latin1"); }
        const up = new tls.TLSSocket(sock, { isServer: true, ...tlsOpt });
        up.on("secure", () => { secure = true; sock = up; rest = ""; bind(up); });
        return;
      }
      if (cmd === "USER") return say("331 password required");
      if (cmd === "PASS") {
        if (opt.refuseLogin) return say("530 login incorrect");
        authed = true; return say("230 logged in");
      }
      if (!authed) return say("530 not logged in");
      if (cmd === "PBSZ") return say("200 PBSZ=0");
      if (cmd === "PROT") {
        if (opt.refuseProt) return say("534 data channel protection refused");
        if (!secure) return say("503 AUTH TLS first");
        prot = arg.toUpperCase() === "P";
        return say("200 PROT set");
      }
      if (cmd === "TYPE") { type = arg.toUpperCase(); return say(`200 TYPE set to ${type}`); }
      if (cmd === "SYST") return say("215 UNIX Type: L8");
      if (cmd === "PWD") return say(`257 "${cwd}" is the current directory`);
      if (cmd === "CWD") { cwd = resolve(arg); return say(`250 CWD ok`); }
      if (cmd === "FEAT") return say("211-Features:\r\n UTF8\r\n MLSD\r\n SIZE\r\n AUTH TLS\r\n PBSZ\r\n PROT\r\n211 End");
      if (cmd === "SIZE") { const f = files[resolve(arg)]; return say(f ? `213 ${f.length}` : "550 no such file"); }
      if (cmd === "PASV") return say(await openPasv());
      if (cmd === "LIST" || cmd === "NLST") {
        const raw = await takeData(); if (!raw) return;
        say("150 opening data connection for LIST");
        let ds; try { ds = await secureData(raw); } catch (e) { return dataFailure(e); }
        ds.end(Buffer.from(listText(resolve(arg)), "latin1"));
        return say("226 transfer complete");
      }
      if (cmd === "RETR") {
        const f = files[resolve(arg)];
        if (f === undefined || f === null) { closePasv(); return say("550 no such file"); }
        const raw = await takeData(); if (!raw) return;
        say("150 opening BINARY data connection");
        // A transfer that dies AFTER the 1xx. "tls-garbage" never handshakes at all, so it is the
        // client's data-channel TLS that fails; the other two die once the channel is already up.
        if (opt.dataAbort === "tls-garbage") {
          raw.write("this is not a TLS record, it is a proxy error page\r\n");
          setTimeout(() => { raw.destroy(); if (!opt.noFinalReply) say("426 data connection closed; transfer aborted"); }, 60);
          return;
        }
        let dsr; try { dsr = await secureData(raw); } catch (e) { return dataFailure(e); }
        if (opt.dataAbort === "truncate" || opt.dataAbort === "destroy") {
          dsr.write(f.subarray(0, Math.max(1, Math.floor(f.length / 3))));
          setTimeout(() => {
            if (opt.dataAbort === "truncate") dsr.end(); else dsr.destroy();   // clean FIN vs no FIN
            if (!opt.noFinalReply) say("426 transfer aborted: the file went away underneath us");
          }, 60);
          return;
        }
        // TYPE A on a PNG is the classic corruption: mangle CRLF so the test can SEE it.
        dsr.end(type === "I" ? f : Buffer.from(f.toString("latin1").replace(/\n/g, "\r\n"), "latin1"));
        return say("226 transfer complete");
      }
      if (cmd === "STOR") {
        const raw = await takeData(); if (!raw) return;
        say("150 ready to receive");
        let ds; try { ds = await secureData(raw); } catch (e) { return dataFailure(e); }
        const chunks = [];
        await new Promise((r) => { ds.on("data", (c) => chunks.push(Buffer.from(c))); ds.on("end", r); ds.on("close", r); });
        files[resolve(arg)] = Buffer.concat(chunks);
        return say("226 transfer complete");
      }
      if (cmd === "DELE") {
        const p = resolve(arg);
        if (files[p] === undefined) return say("550 no such file");
        delete files[p]; return say("250 file deleted");
      }
      if (cmd === "QUIT") { say("221 bye"); return sock.end(); }
      return say(`502 command not implemented: ${cmd}`);
    }

    bind(sock);
    // A 421 greeting is what a server at its connection cap answers, and it CLOSES the control
    // connection straight after — so a client that ignores the greeting code does not merely
    // proceed, it proceeds into a dead socket.
    if (opt.badGreeting) { say("421 service not available, closing control connection"); sock.end(); return; }
    say("220 shoplift FTPS mock ready");
  };

  const server = mode === "implicit"
    ? tls.createServer(tlsOpt, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  await new Promise((res) => server.listen(opt.port ?? 0, "127.0.0.1", res));
  return {
    host: "127.0.0.1", port: server.address().port, mode, files, log, dataChannels,
    close: () => new Promise((res) => server.close(res)),
  };
}

// Manual run: node scripts/probe-dandomain.ftp-mock.mjs [explicit|implicit] [port]
if (process.argv[1] && process.argv[1].endsWith("probe-dandomain.ftp-mock.mjs")) {
  const srv = await startFtpsMock({ mode: process.argv[2] === "implicit" ? "implicit" : "explicit", port: Number(process.argv[3]) || 0 });
  console.log(`FTPS mock (${srv.mode}) listening on ${srv.host}:${srv.port} — DD_FTP_HOST=127.0.0.1 DD_FTP_PORT=${srv.port}`);
}
