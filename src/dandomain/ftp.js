/**
 * src/dandomain/ftp.js — hand-rolled FTPS (explicit or implicit) over node:tls.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS (R10 as written, R11 as CORRECTED BY A LIVE RUN)
 * -------------------------------------------------------------------------------------
 * This is a PROMOTION, not a rewrite. Every line of the transport below is the code that ran
 * against the real shop (ProFTPD, 2026-08-15) and came back with a transcript: it listed the
 * archive, RETRieved a 71,236-byte PNG whose magic bytes were intact, and STORed a byte-identical
 * round trip. The source is scripts/probe-dandomain.mjs, section "R10 — hand-rolled FTPS over
 * node:tls". R10 was the SPEC; the live run corrected it in four places, and those corrections
 * are the expensive part of this file. Each is marked in place. Do not "simplify" one away:
 *
 *   R11.1  The data channel is TLS-upgraded AFTER the transfer command is accepted with a 1xx,
 *          NEVER on connect. R10's spec implied handshaking right after the TCP connect;
 *          ProFTPD does not begin the data handshake until it has answered 150/125, so the
 *          early handshake hangs until the timeout. Order is: PASV -> TCP connect -> send the
 *          transfer command -> read 150 -> THEN tls.connect over the socket. This ordering is
 *          also safe against servers that handshake immediately, because in TLS the client
 *          speaks first either way. See FtpsSession#xferIn / #xferOut / #secureData.
 *   R11.2  The CONTROL connection's TLS session is passed to the data socket, and it is taken
 *          from the 'session' EVENT, not from getSession(). The server requires resumption on
 *          the data channel (vsftpd `require_ssl_reuse=YES`, ProFTPD's default TLSOptions).
 *          The ticket can arrive just AFTER secureConnect resolves, so getSession() alone can
 *          return undefined; resumption then fails SILENTLY and the symptom is a data channel
 *          that looks refused. Hence the `session` listener installed in ftpsConnect() and the
 *          `this.tlsSession ?? this.sock.getSession?.()` fallback in secureData().
 *   R11.3  PASV: connect to the CONTROL host, never to the IP the 227 advertises. The shop sits
 *          behind NAT and advertises an unroutable address. The advertised value is still
 *          recorded (session.pasv[]) so the NAT case stays visible in evidence.
 *   R11.4  PBSZ 0, then PROT P, then TYPE I — in that order, and refusals are RECORDED
 *          (session.pbsz / session.protReply / session.prot / session.typeI) instead of being
 *          assumed successful. A server that answers 534 to PROT P leaves the data channel in
 *          cleartext; secureData() honours that by returning the plain socket, so the transfer
 *          still works and the transcript shows why it was unencrypted. TYPE I is not cosmetic:
 *          under TYPE A the server rewrites newlines and every PNG comes back corrupt.
 *
 * Two more properties that are load-bearing and easy to lose:
 *   - PASS is REDACTED in the transcript and in everything handed to the logger. The transcript
 *     is written into probe artifacts and error objects; a password must never reach either.
 *   - A refused data channel must surface as a REPLY CODE (425) quickly, not as a 30s hang. The
 *     transfer command is sent on the control channel and awaited there, so a server that
 *     cannot open the data connection answers 425 and the error carries `.reply`.
 *
 * WHAT A HOSTILE REVIEW ADDED (2026-08-16) — none of it touches the R11 orderings above
 * ------------------------------------------------------------------------------------
 * The promotion was faithful to the live run, and that was the problem: the live run only ever
 * exercised the HAPPY path, so every failure path was shaped by assumption. Each item below had a
 * reproduction before it had a fix, and each has a test that fails without it.
 *
 *   A. A transfer's FINAL reply code is now checked. `xferIn`/`xferOut` read the 226 and returned
 *      it as data; a server that answered 426 after sending 100 of 4096 bytes produced a resolved
 *      promise with `truncated: false`. At the socket level an aborted TLS transfer is
 *      indistinguishable from a clean EOF — the reply code is the ONLY evidence there is, so a
 *      non-2xx final reply now throws with `.reply` and `.partial`.
 *   B. A transfer that dies AFTER the 1xx leaves the server's final reply unread. Left there, it
 *      is served to the NEXT command: `PWD` came back `426`, and the session stayed one reply out
 *      of step forever with nothing marking it. The data socket is now destroyed, the trailing
 *      reply is drained within a bound, and if it never arrives the session is marked `broken`
 *      and `cmd()` refuses to use it. A corrupt session must not be handed back as usable.
 *   C. The control socket used to LEAK on six failure paths (greeting timeout, bad greeting, AUTH
 *      timeout, USER/PASS, PBSZ/PROT/TYPE) and those errors carried neither `.stage` nor
 *      `.transcript`, so client.js's aggregate reported `stage: null`. Everything from the
 *      greeting to `TYPE I` is now inside one try/catch that closes the socket and names the
 *      stage ("greeting" or "command").
 *   D. `cmd()` wrote its line verbatim. Paths reach this module from `Product_GetPictures`
 *      FileNames — server-controlled data — so a CRLF in a filename injected a second command
 *      (a real DELE was executed in the repro). CR/LF/NUL are now rejected before any bytes move.
 *   E. FTP multiplexes nothing. Two transfers on one session interleaved their PASVs and both
 *      died, one only after a 20s handshake timeout. A second concurrent transfer is now refused.
 *   F. LIST names are latin1 because the bytes must survive back into `RETR` — that part was
 *      right. But the only name exported WAS the latin1 one, so `Æblegrød.png` reached callers as
 *      `ÃblegrÃ¸d.png` and could never match a UTF-8 SOAP `FileName` (F2). `parseList` now
 *      returns BOTH: `name` (wire-safe) and `nameUtf8` (comparable).
 *   G. The 16MB cap was hardcoded, unreachable from any exported API, and dropped the whole chunk
 *      that straddled it (2000 bytes returned against a 2500-byte cap). It is now a per-call
 *      option with an exported default, and the straddling chunk is cut to the cap.
 *   H. `leftoverBeforeUpgrade` was assigned and never read, and it measured the wrong thing: a
 *      reply the reader had already PARSED sits in a queue neither `pending()` nor `detach()` can
 *      see. Both are now checked, and a non-zero either way aborts the connect instead of
 *      silently dropping a reply (which is defect B by another route).
 *   I. `dataTls` records the FIRST data channel only. It still does — but `dataChannels` counts
 *      every one, so a mid-session downgrade to cleartext or a lost resumption is visible.
 *   J. An unrecognised `mode` fell into the explicit branch and dialled port 21 in cleartext.
 *      Modes and ports are now validated before anything is dialled.
 *
 * The one claim in this header that was too strong has been narrowed rather than defended: see
 * FtpsSession#tlsOpts. `rejectUnauthorized` is pinned; `checkServerIdentity` is not, and cannot
 * be without removing a capability the JSDoc licenses — so it is RECORDED instead.
 *
 * WHAT CHANGED FROM THE PROBE (and nothing else changed)
 * ------------------------------------------------------
 *   - No console output, no artifact writing, no process-level state (invariant #4).
 *   - Certificate verification is CONFIGURABLE and DEFAULTS TO ON. The probe used
 *     rejectUnauthorized:false because it was discovering the endpoint; the live cert is a valid
 *     Sectigo cert for *.mywebshop.io and it validated (controlTls.authorized === true), so
 *     production has no excuse to turn it off. `rejectUnauthorized: false` remains reachable for
 *     self-signed test servers, but it has to be asked for by name, in one visible place.
 *   - An injectable logger replaces printing. Default is silent.
 *
 * The reply reader detaches before every TLS upgrade: a 'data' handler left on the plain socket
 * eats the handshake bytes. `leftoverBeforeUpgrade` (unparsed bytes) and `queuedBeforeUpgrade`
 * (whole replies already parsed and waiting) record what would be thrown away at that moment —
 * both must be 0, and the connect now FAILS rather than continuing if either is not.
 *
 * Zero dependencies (node:net + node:tls), ESM, pure: no top-level side effects, nothing
 * printed, errors thrown. Control channel is a latin1 line protocol — replies are `NNN text\r\n`
 * or multi-line `NNN-first\r\n ... \r\nNNN last\r\n`.
 */
import net from "node:net";
import tls from "node:tls";

/** Silent by default (invariant #4: modules never write to stdout). */
const NOOP_LOGGER = Object.freeze({});

/** Defaults for one transfer. EXPORTED and per-call overridable on purpose: invariant #3 forbids
 *  shop-dependent magic numbers, and a hardcoded 16MB that no caller can reach IS one the moment
 *  a shop has a bigger media file. These are memory/liveness guards, not protocol rules. */
export const DEFAULT_MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TRANSFER_TIMEOUT_MS = 60_000;
export const DEFAULT_FINAL_REPLY_TIMEOUT_MS = 30_000;
/** How long to wait for the server's final reply after a transfer has ALREADY failed. Short: the
 *  transfer is lost either way and this only decides recoverable-session vs broken-session. */
export const DEFAULT_ABORT_DRAIN_MS = 5_000;

/**
 * A logger call must never be able to break a transfer, so it is isolated. `logger` may be any
 * object; only the methods it actually has are called.
 * @param {object|null|undefined} logger
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {object} event structured event — already redacted by the caller
 */
function emit(logger, level, event) {
  try { logger?.[level]?.(event); } catch { /* a broken logger is not a transport failure */ }
}

/**
 * Reply reader bound to ONE socket. Detach before a TLS upgrade — the plain socket's 'data'
 * handler would otherwise eat the handshake bytes.
 *
 * Handles both reply forms. Multi-line replies terminate on a line that repeats the SAME code
 * followed by a space, which is why the terminator regex is built from the opening code.
 *
 * `pending()` and `queued()` are NOT the same question and the difference is load-bearing:
 * `pending()` is the unparsed byte tail, `queued()` is whole replies already parsed and sitting
 * in `ready` waiting for a `next()`. A reply pipelined with the 234 lands in `queued()`, where
 * `detach()` cannot see it — so checking only `detach().length` before a TLS upgrade reports 0
 * while a complete reply is silently discarded with the old reader.
 * @param {import("node:net").Socket} sock
 * @returns {{next(timeoutMs?: number): Promise<{code: number, text: string, multiline?: string}>,
 *            detach(): string, pending(): number, queued(): number}}
 */
export function ftpReplyReader(sock) {
  let buf = "", err = null;
  const ready = [], waiters = [];
  const push = (r) => { const w = waiters.shift(); w ? w.resolve(r) : ready.push(r); };
  const fail = (e) => { err = err ?? e; while (waiters.length) waiters.shift().reject(err); };
  const onData = (d) => {
    buf += Buffer.from(d).toString("latin1");
    for (;;) {
      const m = buf.match(/^(\d{3})([ -])/);
      if (!m) { if (buf.length > 1 << 20) fail(new Error("control buffer overflow")); break; }
      if (m[2] === " ") {
        const eol = buf.indexOf("\r\n");
        if (eol < 0) break;
        const line = buf.slice(0, eol); buf = buf.slice(eol + 2);
        push({ code: Number(m[1]), text: line });
      } else {
        const end = buf.match(new RegExp(`(?:^|\\r\\n)${m[1]} [^\\r\\n]*\\r\\n`));
        if (!end) break;
        const cut = end.index + end[0].length;
        const block = buf.slice(0, cut); buf = buf.slice(cut);
        push({ code: Number(m[1]), text: block.replace(/\r\n/g, " | ").trim(), multiline: block });
      }
    }
  };
  sock.on("data", onData);
  sock.on("error", fail);
  sock.on("close", () => fail(new Error("control connection closed by peer")));
  return {
    next(timeoutMs = 20000) {
      if (ready.length) return Promise.resolve(ready.shift());
      if (err) return Promise.reject(err);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`FTP reply timeout after ${timeoutMs}ms`)), timeoutMs);
        waiters.push({ resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
      });
    },
    detach() { sock.removeListener("data", onData); return buf; },
    pending: () => buf.length,
    queued: () => ready.length,
  };
}

/**
 * A control-channel command is exactly ONE line. Paths reach this module from server-controlled
 * data (`Product_GetPictures` FileNames), and `cmd()` writes what it is given, so a CR or LF in a
 * filename injects arbitrary FTP commands — the repro deleted a real file with one xferIn() call.
 * Rejected before a single byte reaches the wire, and before PASV opens a data connection.
 * @param {string} line
 */
function assertOneLine(line) {
  if (typeof line !== "string") throw new TypeError(`FTP command must be a string, got ${typeof line}`);
  if (/[\r\n\0]/.test(line)) {
    const e = new Error("control-channel injection: the command contains CR, LF or NUL");
    e.command = JSON.stringify(line).slice(0, 200);
    throw e;
  }
}

/** One-shot event await with a timeout that also unhooks the loser, so neither listener leaks. */
const sockOnce = (sock, ev, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${ev} timeout after ${ms}ms`)), ms);
  const ok = (v) => { clearTimeout(t); sock.removeListener("error", bad); res(v); };
  const bad = (e) => { clearTimeout(t); sock.removeListener(ev, ok); rej(e); };
  sock.once(ev, ok); sock.once("error", bad);
});

/** Evidence about one TLS socket. `authorized`/`authorizationError` are the proof that
 *  certificate verification was actually ON for this connection — keep them in the record. */
const tlsInfo = (s) => ({
  protocol: s.getProtocol?.() ?? null, cipher: s.getCipher?.()?.name ?? null,
  authorized: s.authorized ?? null, authorizationError: String(s.authorizationError ?? "") || null,
  peerCN: s.getPeerCertificate?.()?.subject?.CN ?? null, peerIssuerCN: s.getPeerCertificate?.()?.issuer?.CN ?? null,
  altNames: s.getPeerCertificate?.()?.subjectaltname ?? null,
});

/**
 * One FTPS session. `mode` is "explicit" (AUTH TLS on 21) or "implicit" (TLS from byte 0 on 990).
 * Constructed by ftpsConnect(); not exported, because a session that skipped the login sequence
 * has not had PBSZ/PROT/TYPE asserted and would silently transfer in ASCII.
 */
class FtpsSession {
  /**
   * @param {string} host control host — also the host every data connection uses (R11.3)
   * @param {"explicit"|"implicit"} mode
   * @param {number} port
   * @param {{rejectUnauthorized?: boolean, tlsOptions?: object, logger?: object}} [opts]
   */
  constructor(host, mode, port, opts = {}) {
    this.host = host; this.mode = mode; this.port = port;
    this.transcript = []; this.pasv = []; this.prot = false;
    this.rejectUnauthorized = opts.rejectUnauthorized !== false; // R11: verification ON unless asked otherwise
    this.tlsOptions = opts.tlsOptions ?? {};
    this.logger = opts.logger ?? NOOP_LOGGER;
    /** Set to a REASON string once the control channel can no longer be trusted to be in step.
     *  Never cleared: there is no way to resynchronise an FTP control channel from the client
     *  side, so the only honest recovery is a new connection. */
    this.broken = null;
    /** `dataTls` describes the FIRST data channel; on a session doing hundreds of RETRs that is
     *  evidence about transfer #1 and nothing else. These counters cover all of them, so a
     *  mid-session downgrade to cleartext or a lost resumption cannot hide behind it. */
    this.dataChannels = { secured: 0, cleartext: 0, resumed: 0, notResumed: 0 };
    /** Which keys the caller supplied inside `tlsOptions`, and whether one of them replaced the
     *  hostname check. See tlsOpts() for why this is recorded rather than forbidden. */
    this.tlsOptionKeys = Object.keys(this.tlsOptions).sort();
    this.identityCheckOverridden = typeof this.tlsOptions.checkServerIdentity === "function";
    this.transferInFlight = null;
  }

  /**
   * TLS options for control and data sockets alike.
   *
   * `rejectUnauthorized` is applied LAST, so the single visible switch always wins: a copy
   * smuggled inside `tlsOptions` is IGNORED. That is the whole of the guarantee, and the header
   * used to claim more than that. It does NOT cover `checkServerIdentity`: with
   * `rejectUnauthorized` left at its default true, `tlsOptions.checkServerIdentity = () => undefined`
   * still disables hostname verification completely (the certificate CHAIN is still checked, so it
   * is a partial bypass, not a total one). Pinning it would remove a capability the JSDoc licenses
   * — connecting by IP to a certificate issued for a name legitimately needs it — so it is
   * RECORDED on the session and warned about instead, the same way a refused PROT is recorded.
   */
  tlsOpts(extra) {
    return { servername: this.host, ...this.tlsOptions, ...extra, rejectUnauthorized: this.rejectUnauthorized };
  }

  /** Send one command and read one reply. PASS/ACCT arguments are redacted before they touch
   *  the transcript or the logger — the transcript ends up in artifacts and error objects.
   *  Refuses to run on a session whose control channel is known to be out of step: answering
   *  from a stale reply is worse than failing, because the caller cannot tell. */
  async cmd(line, timeoutMs = 20000) {
    if (this.broken) throw new Error(`FTP session is broken and cannot be used: ${this.broken}`);
    assertOneLine(line);
    const shown = /^(PASS|ACCT)\s/i.test(line) ? line.replace(/\s.*$/, " ****") : line;
    this.transcript.push({ ">": shown });
    emit(this.logger, "debug", { ftp: "cmd", dir: ">", line: shown });
    this.sock.write(line + "\r\n", "latin1");
    const r = await this.rdr.next(timeoutMs);
    this.transcript.push({ "<": r.code, text: r.text.slice(0, 500) });
    emit(this.logger, "debug", { ftp: "reply", dir: "<", code: r.code, text: r.text.slice(0, 500) });
    return r;
  }

  /** cmd() plus an accepted-code check. The thrown error carries `.reply` so a caller can read
   *  the code (this is how a refused data channel surfaces as 425 instead of a hang). */
  async expect(line, codes, timeoutMs) {
    const r = await this.cmd(line, timeoutMs);
    if (!codes.includes(r.code)) { const e = new Error(`${line.split(" ")[0]} -> ${r.code} ${r.text.slice(0, 200)}`); e.reply = r; throw e; }
    return r;
  }

  /** PASV + TCP data socket, still in cleartext. R11.3: reuse the CONTROL host, not the
   *  advertised IP (NAT). The TLS upgrade is deliberately NOT done here — see secureData(). */
  async dataConnect(timeoutMs = 20000) {
    const r = await this.expect("PASV", [227], timeoutMs);
    const m = r.text.match(/(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (!m) throw new Error("unparseable PASV reply: " + r.text);
    const advertised = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
    const port = Number(m[5]) * 256 + Number(m[6]);
    const controlIp = this.sock.remoteAddress?.replace(/^::ffff:/, "") ?? null;
    this.pasv.push({ advertised, controlIp, usedHost: this.host, port, advertisedDifferedFromControl: advertised !== controlIp });
    emit(this.logger, "debug", { ftp: "pasv", advertised, usedHost: this.host, port, advertisedDifferedFromControl: advertised !== controlIp });
    const plain = net.connect({ host: this.host, port });
    await sockOnce(plain, "connect", timeoutMs);
    return plain;
  }

  /** LIVE FACT 2026-08-15 (R11.1, corrects R10): ProFTPD does NOT begin the data-channel TLS
   *  handshake until the transfer command has been accepted with a 1xx. Handshaking right
   *  after the TCP connect — which R10's spec implied — hangs until the timeout.
   *  So: connect -> send command -> read 150 -> THEN upgrade. This order is also safe against
   *  servers that handshake immediately, because the TLS client speaks first either way.
   *
   *  When PROT was refused (R11.4) the data channel stays cleartext and the plain socket is
   *  returned unchanged, so the transfer still completes and the transcript shows the 534. */
  async secureData(plain, timeoutMs = 20000) {
    if (!this.prot) { this.dataChannels.cleartext += 1; return plain; }
    // R11.2 — many servers (vsftpd require_ssl_reuse=YES, ProFTPD's default TLSOptions) demand
    // the CONTROL session be resumed on the data socket. The ticket can arrive just AFTER
    // secureConnect, so prefer the one captured from the 'session' event; getSession() alone
    // can be undefined and resumption then fails silently — which looks like a refused channel.
    const sessionTicket = this.tlsSession ?? this.sock.getSession?.();
    const d = tls.connect(this.tlsOpts({ socket: plain, session: sessionTicket }));
    await sockOnce(d, "secureConnect", timeoutMs);
    // One computed value feeds BOTH the first-channel record and the counters, so the two can
    // never disagree about the same handshake.
    const sessionReused = d.isSessionReused?.() ?? null;
    this.dataChannels.secured += 1;
    if (sessionReused === true) this.dataChannels.resumed += 1; else this.dataChannels.notResumed += 1;
    this.dataTls = this.dataTls ?? { ...tlsInfo(d), sessionReused, ticketAvailable: Boolean(sessionTicket) };
    return d;
  }

  /** Drain a data socket to a Buffer. `maxBytes` is a memory guard, not a protocol rule: bytes
   *  past it are counted (`bytes`) and flagged (`truncated`) rather than silently lost.
   *
   *  Both `end` AND `close` finish the read: a peer that RSTs never emits `end`, and listening
   *  for `end` alone turns that into a wait for the full `timeoutMs`. */
  async collect(sock, maxBytes = DEFAULT_MAX_TRANSFER_BYTES, timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS) {
    const chunks = []; let n = 0;
    await new Promise((res, rej) => {
      const t = setTimeout(() => { sock.destroy(); rej(new Error(`data-channel read timeout after ${timeoutMs}ms`)); }, timeoutMs);
      const done = () => { clearTimeout(t); res(); };
      sock.on("data", (c) => {
        const before = n;
        n += c.length;
        if (before >= maxBytes) return;
        // Keep the part of the straddling chunk that fits. Dropping the whole chunk (which is
        // what `if (n <= maxBytes)` did) loses up to one TLS record BELOW the stated cap.
        chunks.push(before + c.length <= maxBytes ? Buffer.from(c) : Buffer.from(c.subarray(0, maxBytes - before)));
      });
      sock.on("end", done); sock.on("close", done);
      sock.on("error", (e) => { clearTimeout(t); rej(e); });
    });
    return { buf: Buffer.concat(chunks), bytes: n, truncated: n > maxBytes };
  }

  /** FTP multiplexes nothing: one control channel, one data channel at a time. Fired in parallel,
   *  two transfers interleave their PASVs and both die — one of them only after a 20s handshake
   *  timeout. Concurrency needs one session per transfer; that is a caller decision, so this
   *  refuses loudly rather than silently queueing behind a policy nobody chose. */
  #claim(command) {
    assertOneLine(command);
    if (this.broken) throw new Error(`FTP session is broken and cannot be used: ${this.broken}`);
    if (this.transferInFlight !== null) {
      throw new Error(`a transfer is already in flight on this session (${JSON.stringify(this.transferInFlight)}); ` +
        "FTP allows one data channel per control connection — use one session per concurrent transfer");
    }
    this.transferInFlight = command;
  }

  /**
   * A transfer that dies AFTER the 1xx leaves the server's final reply unread. Left there it is
   * served to the NEXT command, and every command after that reads the previous one's reply —
   * silently, forever. So: destroy the data socket, then drain that trailing reply within a
   * bound. If it arrives the session is still in step and stays usable; if it does not, the
   * session is marked `broken` and cmd() refuses it.
   * @returns {Promise<Error>} the same error, annotated — the caller throws it
   */
  async #abortAfter1xx(cause, socks, drainMs) {
    for (const s of socks) { try { s?.destroy(); } catch { /* already gone */ } }
    let fin = null;
    try { fin = await this.rdr.next(drainMs); }
    catch (e) {
      this.broken = `a transfer aborted (${cause.message}) and the server's final reply never ` +
        `arrived (${e.message}), so the control channel is one reply out of step`;
    }
    if (fin) {
      this.transcript.push({ "<": fin.code, text: fin.text.slice(0, 200) });
      emit(this.logger, "debug", { ftp: "reply", dir: "<", code: fin.code, text: fin.text.slice(0, 200) });
      cause.reply = fin;
    }
    cause.aborted = true;
    cause.sessionBroken = Boolean(this.broken);
    emit(this.logger, "warn", { ftp: "transfer-aborted", message: cause.message, finCode: fin?.code ?? null, sessionBroken: cause.sessionBroken });
    return cause;
  }

  /** Read the transfer's final reply and RECORD it. A final reply that never comes is the same
   *  hazard as one that is never read: it can still turn up later and be served to the next
   *  command. The data moved, so this is not #abortAfter1xx's case — but the session is just as
   *  untrustworthy, so it is marked the same way. */
  async #finalReply(timeoutMs) {
    let fin;
    try { fin = await this.rdr.next(timeoutMs); }
    catch (e) {
      this.broken = `the transfer's final reply never arrived (${e.message}); it may still turn ` +
        "up and be served to the next command, so the control channel can no longer be trusted";
      e.sessionBroken = true;
      emit(this.logger, "warn", { ftp: "transfer-unfinished", message: e.message, sessionBroken: true });
      throw e;
    }
    this.transcript.push({ "<": fin.code, text: fin.text.slice(0, 200) });
    emit(this.logger, "debug", { ftp: "reply", dir: "<", code: fin.code, text: fin.text.slice(0, 200) });
    return fin;
  }

  /** A transfer is only complete if the server SAYS so. An aborted TLS transfer looks exactly
   *  like a clean EOF on the socket, so this reply code is the only evidence there is that the
   *  bytes are all of them. 226 is what the live run returned; 250 is the other 2xx some servers
   *  use for a completed STOR. Anything else is a failure carrying what did arrive. */
  #requireComplete(out, fin) {
    if (fin.code >= 200 && fin.code < 300) return out;
    const e = new Error(`transfer ended ${fin.code} ${fin.text.slice(0, 200)}`);
    e.reply = fin;
    e.partial = out;
    throw e;
  }

  /**
   * Inbound data-transfer command (LIST/RETR/NLST/MLSD):
   * PASV -> TCP connect -> send cmd -> 1xx -> TLS upgrade -> drain -> 2xx. (R11.1)
   * If the server cannot open the data channel it answers 425 HERE, on the control channel,
   * and expect() throws with `.reply` — fast, not a read timeout.
   *
   * RESOLVES only on a 2xx final reply. Anything else throws with `.reply` (the final reply) and
   * `.partial` (what did arrive): an aborted transfer looks exactly like a clean EOF on the
   * socket, so the reply code is the only thing that can tell a complete file from a truncated
   * one. `.aborted`/`.sessionBroken` are set when the failure happened after the 1xx.
   *
   * @param {string} command e.g. `RETR /images/x.png`. CR/LF/NUL are rejected (injection).
   * @param {object} [opts]
   * @param {number} [opts.maxBytes=DEFAULT_MAX_TRANSFER_BYTES] memory guard; bytes past it are
   *   still COUNTED in `bytes` and flagged with `truncated`, and the buffer is filled exactly to it
   * @param {number} [opts.timeoutMs=DEFAULT_TRANSFER_TIMEOUT_MS] whole-transfer read timeout
   * @param {number} [opts.finTimeoutMs=DEFAULT_FINAL_REPLY_TIMEOUT_MS] wait for the final reply
   * @param {number} [opts.abortDrainMs=DEFAULT_ABORT_DRAIN_MS] wait for the final reply after a
   *   FAILED transfer; exceeding it marks the session `broken` rather than desyncing it
   * @returns {Promise<{openCode: number, finCode: number, buf: Buffer, bytes: number, truncated: boolean}>}
   */
  async xferIn(command, {
    maxBytes = DEFAULT_MAX_TRANSFER_BYTES,
    timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
    finTimeoutMs = DEFAULT_FINAL_REPLY_TIMEOUT_MS,
    abortDrainMs = DEFAULT_ABORT_DRAIN_MS,
  } = {}) {
    this.#claim(command);
    try {
      const plain = await this.dataConnect();
      let open;
      // BEFORE the 1xx the server owes us nothing further, so destroying the orphaned PASV socket
      // and rethrowing keeps the control channel exactly in step. This is the 425 path.
      try { open = await this.expect(command, [125, 150]); }
      catch (e) { plain.destroy(); throw e; }
      // AFTER the 1xx a final reply is owed, and every failure below has to account for it.
      let d;
      try { d = await this.secureData(plain); }
      catch (e) { e.message = `data-channel TLS after ${open.code}: ${e.message}`; throw await this.#abortAfter1xx(e, [plain], abortDrainMs); }
      let got;
      try { got = await this.collect(d, maxBytes, timeoutMs); }
      catch (e) { throw await this.#abortAfter1xx(e, [d, plain], abortDrainMs); }
      const fin = await this.#finalReply(finTimeoutMs);
      return this.#requireComplete({ openCode: open.code, finCode: fin.code, ...got }, fin);
    } finally { this.transferInFlight = null; }
  }

  /** Outbound data-transfer command (STOR/APPE). Same ordering rule as xferIn (R11.1), same
   *  final-reply rule: a STOR that ends 4xx/5xx did not store the file. */
  async xferOut(command, payload, {
    finTimeoutMs = DEFAULT_FINAL_REPLY_TIMEOUT_MS,
    abortDrainMs = DEFAULT_ABORT_DRAIN_MS,
  } = {}) {
    this.#claim(command);
    try {
      const plain = await this.dataConnect();
      let open;
      try { open = await this.expect(command, [125, 150]); }
      catch (e) { plain.destroy(); throw e; }
      let d;
      try { d = await this.secureData(plain); }
      catch (e) { e.message = `data-channel TLS after ${open.code}: ${e.message}`; throw await this.#abortAfter1xx(e, [plain], abortDrainMs); }
      // The callback is awaited so a write error is OBSERVED rather than becoming an unhandled
      // socket error while the code goes on to read a reply the server never sent.
      try { await new Promise((res, rej) => { d.end(payload, (e) => (e ? rej(e) : res())); }); }
      catch (e) { throw await this.#abortAfter1xx(e, [d, plain], abortDrainMs); }
      const fin = await this.#finalReply(finTimeoutMs);
      return this.#requireComplete({ openCode: open.code, finCode: fin.code, sentBytes: payload.length }, fin);
    } finally { this.transferInFlight = null; }
  }

  /** Best-effort close. Never throws — callers use it in `finally`. */
  quit() { try { this.sock.write("QUIT\r\n"); } catch { } try { this.sock.destroy(); } catch { } }
}

/**
 * Bring up one FTPS flavour and log in. Returns a live session, or throws with `.transcript`
 * (PASS redacted) and `.stage` attached so the failing assumption is named: "tcp-connect" =
 * firewall/port, "tls-connect"/"tls-upgrade" = TLS or certificate, "greeting" = the server
 * answered something other than 220, or nothing at all, "command" = auth, login or PROT.
 *
 * EVERY throw after the socket exists closes that socket and carries both fields. Six paths used
 * to do neither, which is how a failed connect left a live socket behind and reported
 * `stage: null` — and how a broken test suite hung instead of failing.
 *
 * R10 order: try explicit-on-21 first, implicit-on-990 second — that is the CALLER's loop; this
 * function brings up exactly the flavour it is asked for.
 *
 * @param {object} o
 * @param {string} o.host control host; also the host used for every PASV data connection (R11.3)
 * @param {string} o.user
 * @param {string} o.pass redacted everywhere it is recorded
 * @param {"explicit"|"implicit"} o.mode REQUIRED and validated — an unrecognised value is a
 *   configuration error, not a silent fall-through to cleartext on port 21
 * @param {number} [o.port] defaults to the flavour's standard port (21 / 990); tests override it
 * @param {number} [o.timeoutMs=20000] connect/login timeout
 * @param {boolean} [o.rejectUnauthorized=true] R11: certificate verification is ON by default.
 *   The live cert is a valid Sectigo cert for *.mywebshop.io and validated. Pass false only for
 *   a self-signed test server, and only deliberately.
 * @param {object} [o.tlsOptions] extra node:tls options merged into BOTH the control and the
 *   data socket (`ca`, `minVersion`, `checkServerIdentity`, `servername`…). A
 *   `rejectUnauthorized` inside here is ignored. A `checkServerIdentity` is NOT ignored — it
 *   REPLACES hostname verification, so it is recorded on the session as `identityCheckOverridden`
 *   and warned about. See FtpsSession#tlsOpts for exactly what is and is not pinned.
 * @param {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [o.logger]
 *   receives the same redacted events the transcript records. Default: silent.
 * @returns {Promise<FtpsSession>}
 */
export async function ftpsConnect({ host, user, pass, mode, port, timeoutMs = 20000, rejectUnauthorized = true, tlsOptions, logger }) {
  // Validate BEFORE dialling. `mode` used to fall through to the explicit branch, so a typo in a
  // config file ("ftps", "Implicit") became a CLEARTEXT attempt on port 21 rather than an error —
  // and client.js builds `modes` straight from user config. `port || default` swallowed 0 too.
  if (mode !== "explicit" && mode !== "implicit") {
    throw new Error(`mode must be "explicit" or "implicit", got ${JSON.stringify(mode)}`);
  }
  port = port ?? (mode === "implicit" ? 990 : 21);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`port must be an integer between 1 and 65535, got ${JSON.stringify(port)}`);
  }
  const s = new FtpsSession(host, mode, port, { rejectUnauthorized, tlsOptions, logger });
  if (s.identityCheckOverridden) {
    // Not forbidden (see tlsOpts) — but never silent, because the visible switch still reads "on".
    emit(s.logger, "warn", {
      ftp: "tls-identity-override",
      message: "tlsOptions.checkServerIdentity replaces hostname verification; the certificate " +
        "CHAIN is still verified, the NAME is whatever that function says",
      keys: s.tlsOptionKeys,
    });
  }

  /** Attach the evidence a caller needs to name the wrong assumption, then hand the error on. */
  const tag = (e, stage) => { e.transcript = s.transcript; e.stage = e.stage ?? stage; return e; };

  if (mode === "implicit") {
    const sock = tls.connect(s.tlsOpts({ host, port }));
    s.port = port;
    try { await sockOnce(sock, "secureConnect", timeoutMs); }
    catch (e) { sock.destroy(); throw tag(e, "tls-connect"); }
    s.sock = sock; s.rdr = ftpReplyReader(sock); s.controlTls = tlsInfo(sock);
    // R11.2 — capture the ticket from the EVENT. It can arrive after secureConnect resolved.
    sock.on("session", (t) => { s.tlsSession = t; });
  } else {
    const plain = net.connect({ host, port });
    try { await sockOnce(plain, "connect", timeoutMs); }
    catch (e) { plain.destroy(); throw tag(e, "tcp-connect"); }
    s.sock = plain; s.rdr = ftpReplyReader(plain);
  }

  // From here the control socket EXISTS, so EVERY exit has to close it. Six paths used to leak it
  // (greeting timeout, bad greeting, AUTH timeout, USER, PASS, PBSZ/PROT/TYPE) and none of them
  // attached `.stage` or `.transcript`, so the caller's aggregate reported `stage: null` and the
  // process kept a live socket — which is also why a broken suite hung instead of failing.
  try {
    const greet = await s.rdr.next(timeoutMs).catch((e) => { throw tag(e, "greeting"); });
    s.transcript.push({ "<": greet.code, text: greet.text.slice(0, 300) });
    emit(s.logger, "debug", { ftp: "greeting", dir: "<", code: greet.code, text: greet.text.slice(0, 300) });
    if (greet.code !== 220) throw tag(new Error(`${mode === "implicit" ? "implicit" : "plain"} greeting ${greet.code}`), "greeting");

    if (mode === "explicit") {
      const plain = s.sock;
      let auth = await s.cmd("AUTH TLS", timeoutMs);
      s.authTlsReply = auth.code;            // recorded ALWAYS, so the fallback path below is
      s.authSslFallbackUsed = false;         // visible as false rather than as a missing field
      if (auth.code !== 234) { s.authSslFallbackUsed = true; auth = await s.cmd("AUTH SSL", timeoutMs); }
      if (auth.code !== 234) throw new Error(`AUTH TLS/SSL refused (${auth.code} ${auth.text.slice(0, 120)})`);
      // Detach BEFORE the upgrade: a 'data' listener on the plain socket eats the handshake.
      // Two different things can be lost here and only one of them used to be measured: unparsed
      // BYTES (detach) and whole replies already PARSED and queued (queued). Either one means the
      // next reply we read belongs to the previous command — defect B, arriving early.
      const leftover = s.rdr.detach();
      s.leftoverBeforeUpgrade = leftover.length;
      s.queuedBeforeUpgrade = s.rdr.queued();
      if (s.leftoverBeforeUpgrade || s.queuedBeforeUpgrade) {
        const e = new Error(
          `control bytes would be dropped by the TLS upgrade: ${s.leftoverBeforeUpgrade} unparsed ` +
          `byte(s) and ${s.queuedBeforeUpgrade} already-parsed repl${s.queuedBeforeUpgrade === 1 ? "y" : "ies"} ` +
          "still in the reader; continuing would put every later reply one command out of step");
        e.leftoverBeforeUpgrade = s.leftoverBeforeUpgrade;
        e.queuedBeforeUpgrade = s.queuedBeforeUpgrade;
        throw tag(e, "tls-upgrade");
      }
      const sec = tls.connect(s.tlsOpts({ socket: plain }));
      try { await sockOnce(sec, "secureConnect", timeoutMs); }
      catch (e) { try { plain.destroy(); } catch { } throw tag(e, "tls-upgrade"); }
      s.sock = sec; s.rdr = ftpReplyReader(sec); s.controlTls = tlsInfo(sec);
      // R11.2 — same reason as the implicit branch: the event, not getSession().
      sec.on("session", (t) => { s.tlsSession = t; });
    }

    await s.expect(`USER ${user}`, [230, 331], timeoutMs);
    const pw = await s.cmd(`PASS ${pass}`, timeoutMs);
    if (![230, 202].includes(pw.code)) throw new Error(`login refused (${pw.code} ${pw.text.slice(0, 160)})`);
    // R11.4 order: PBSZ 0 then PROT P, then binary. Record refusals instead of assuming success.
    const pbsz = await s.cmd("PBSZ 0", timeoutMs); s.pbsz = pbsz.code;
    const prot = await s.cmd("PROT P", timeoutMs); s.protReply = prot.code; s.prot = prot.code === 200;
    const type = await s.cmd("TYPE I", timeoutMs); s.typeI = type.code;
    return s;
  } catch (e) {
    s.quit();
    throw tag(e, "command");
  }
}

/** Strict UTF-8 decoder: `fatal` so bytes that are NOT UTF-8 raise instead of being silently
 *  replaced with U+FFFD. A latin1-named file on an ISO-8859-1 server must keep its own name. */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/**
 * The same filename, decoded as UTF-8. The control channel is a latin1 byte channel, so `name`
 * holds the exact bytes the server sent and is the ONLY form that can be handed back in a RETR.
 * But the consumer here is the media export, matching against `Product_GetPictures` FileNames,
 * which are UTF-8 (F2) — so `Æblegrød.png` arriving as `ÃblegrÃ¸d.png` matches nothing, on every
 * Danish shop, silently. Both forms are therefore returned; neither replaces the other.
 *
 * If the bytes are not valid UTF-8 the latin1 string IS the truth and is returned unchanged —
 * decoding it anyway would be exactly the double conversion F2 forbids.
 */
function toUtf8Name(name) {
  if (name == null) return null;
  try { return UTF8_STRICT.decode(Buffer.from(name, "latin1")); }
  catch { return name; }
}

/**
 * Tolerant LIST parser: Unix (`drwxr-xr-x 2 u g 4096 Aug 15 19:00 name`) and DOS
 * (`08-15-26  07:00PM       <DIR>          name`). Unknown lines are kept as raw.
 *
 * Unparsed lines are RETAINED as `{type:"unparsed", name:null, raw}` rather than dropped: a
 * silently discarded line is an image the media export would never see. Callers must skip
 * entries without a name (and "." / "..") instead of assuming every entry is a file.
 *
 * TWO NAMES, ON PURPOSE (see toUtf8Name): use `name` to build a transfer command, `nameUtf8` to
 * compare against anything that came out of the SOAP or GraphQL API.
 * @param {string} text LIST output decoded as latin1 (byte-preserving; never as utf8)
 * @returns {Array<{type: "dir"|"file"|"link"|"unparsed", size?: number|null, name: string|null,
 *                  nameUtf8: string|null, raw: string}>}
 */
export function parseList(text) {
  const out = [];
  const push = (row) => out.push({ ...row, nameUtf8: toUtf8Name(row.name) });
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    let m = line.match(/^([dl-])[rwxstST-]{9}[.+]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(?:\w{3}\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2}))\s+(.+)$/);
    if (m) { push({ type: m[1] === "d" ? "dir" : m[1] === "l" ? "link" : "file", size: Number(m[2]), name: m[3].replace(/ -> .*$/, "").trim(), raw: line }); continue; }
    m = line.match(/^\d{2}-\d{2}-\d{2,4}\s+\d{2}:\d{2}(?:AM|PM)?\s+(<DIR>|\d+)\s+(.+)$/i);
    if (m) { push({ type: m[1].toUpperCase() === "<DIR>" ? "dir" : "file", size: m[1] === "<DIR>" ? null : Number(m[1]), name: m[2].trim(), raw: line }); continue; }
    push({ type: "unparsed", name: null, raw: line });
  }
  return out;
}
