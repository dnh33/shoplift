#!/usr/bin/env node
// Offline tests for probe-dandomain.mjs's pure core (envelope building + response parsing)
// AND for the hand-rolled FTPS transport (R10), driven against a loopback FTPS mock.
// Run: node scripts/probe-dandomain.test.mjs   (no network, no credentials)
import { toXml, parseXml, ftpReplyReader, parseList, ftpsConnect, classifyPageProbes, wsdlPageOps } from "./probe-dandomain.mjs";
import { startFtpsMock, ONE_PX_PNG } from "./probe-dandomain.ftp-mock.mjs";
import { EventEmitter } from "node:events";
let failed = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log("ok  ", name);
  else { failed++; console.error("FAIL", name, "\n  got ", g, "\n  want", w); }
};

// toXml: scalars, escaping, nesting, arrays-as-repeated-elements
eq("toXml scalar", toXml({ Username: "a@b.dk" }), "<Username>a@b.dk</Username>");
eq("toXml escapes", toXml({ T: `æ<&>"'` }), "<T>æ&lt;&amp;&gt;&quot;&apos;</T>");
eq("toXml nested", toXml({ OrderData: { CurrencyIso: "DKK" } }), "<OrderData><CurrencyIso>DKK</CurrencyIso></OrderData>");
eq("toXml array items", toXml({ OrderLines: { item: [{ ProductId: 1 }, { ProductId: 2 }] } }),
  "<OrderLines><item><ProductId>1</ProductId></item><item><ProductId>2</ProductId></item></OrderLines>");
eq("toXml zero survives", toXml({ Start: 0 }), "<Start>0</Start>");

// parseXml: scalar result, entity unescape, item arrays, single item, namespaced tags, nested objects
eq("parse scalar", parseXml("<Product_GetByIdResult>42</Product_GetByIdResult>"), { Product_GetByIdResult: "42" });
eq("parse unescape", parseXml("<T>a &amp; b &lt;c&gt;</T>"), { T: "a & b <c>" });
eq("parse item array", parseXml("<R><item><Id>1</Id></item><item><Id>2</Id></item></R>"),
  { R: [{ Id: "1" }, { Id: "2" }] });
eq("parse single item still array", parseXml("<R><item><Id>7</Id></item></R>"), { R: [{ Id: "7" }] });
eq("parse namespaced", parseXml("<ns1:R><ns1:Id>9</ns1:Id></ns1:R>"), { R: { Id: "9" } });
eq("parse siblings same name (not nested-confused)", parseXml("<a><b>1</b><b>2</b></a>"), { a: { b: ["1", "2"] } });
eq("parse self-closing", parseXml("<R><Ean/><Id>3</Id></R>"), { R: { Ean: null, Id: "3" } });

// Wrapped response extraction shape (what call() feeds parseXml after the Response regex)
const wrapped = `<Solution_GetLanguagesResult><item><Id>1</Id><Iso>DK</Iso></item><item><Id>2</Id><Iso>UK</Iso></item></Solution_GetLanguagesResult>`;
eq("wrapped languages", parseXml(wrapped), { Solution_GetLanguagesResult: [{ Id: "1", Iso: "DK" }, { Id: "2", Iso: "UK" }] });

// SOAP 1.2 fault detection regexes (mirror of call()'s patterns)
const f12 = `<env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>AUTH</env:Value></env:Subcode></env:Code><env:Reason><env:Text xml:lang="en">A valid authentication has not been performed with the service</env:Text></env:Reason></env:Fault>`;
const m12 = f12.match(/<(?:\w+:)?Code>[\s\S]*?<(?:\w+:)?Value>(?:\w+:)?([^<]*)<[\s\S]*?<(?:\w+:)?(?:Reason|faultstring)>[\s\S]*?<(?:\w+:)?Text[^>]*>([^<]*)</);
eq("fault 1.2 detected", !!m12, true);
eq("fault 1.2 reason", m12 && m12[2].includes("valid authentication"), true);
const f11 = `<SOAP-ENV:Fault><faultcode>PARAM</faultcode><faultstring>Parameter error</faultstring></SOAP-ENV:Fault>`;
const m11 = f11.match(/<(?:\w+:)?faultcode>([^<]*)<[\s\S]*?<(?:\w+:)?faultstring>([^<]*)</);
eq("fault 1.1 detected", m11 && m11[1] === "PARAM" && m11[2] === "Parameter error", true);

// ---------------------------------------------------------------------------
// R10 — the hand-rolled FTPS transport. Everything below runs against
// probe-dandomain.ftp-mock.mjs on loopback: no live shop, no credentials.
// ---------------------------------------------------------------------------

// ftpReplyReader: replies split across arbitrary chunk boundaries, and multi-line FEAT
{
  class Fake extends EventEmitter { write() { } }
  const s = new Fake(), r = ftpReplyReader(s), got = [];
  (async () => { for (let i = 0; i < 4; i++) got.push(await r.next(3000)); })();
  s.emit("data", Buffer.from("220 Welcome to "));
  s.emit("data", Buffer.from("the archive\r\n234 AUTH TLS OK\r\n211-Feat"));
  s.emit("data", Buffer.from("ures:\r\n UTF8\r\n MLSD\r\n211 End\r\n227 Entering Passive Mode (10,1,2,3,195,80)\r\n"));
  await new Promise((res) => setTimeout(res, 50));
  eq("ftp reader: reply split across chunks", got[0] && [got[0].code, got[0].text], [220, "220 Welcome to the archive"]);
  eq("ftp reader: second reply in same chunk", got[1]?.code, 234);
  eq("ftp reader: multi-line FEAT is ONE reply", got[2]?.code, 211);
  eq("ftp reader: FEAT keeps its inner lines", /UTF8/.test(got[2]?.text ?? "") && /MLSD/.test(got[2]?.text ?? ""), true);
  eq("ftp reader: reply after a multi-line block", got[3]?.code, 227);
  eq("ftp reader: nothing left buffered", r.pending(), 0);
}

// parseList: Unix and DOS listings, symlinks, and junk lines kept rather than dropped
eq("parseList unix", parseList("drwxr-xr-x 3 1001 1001 4096 Aug 15 19:00 images\r\n-rw-r--r-- 1 1001 1001 12345 Aug 15 19:00 product-1.png")
  .map((x) => [x.type, x.name, x.size]), [["dir", "images", 4096], ["file", "product-1.png", 12345]]);
eq("parseList unix symlink target stripped", parseList("lrwxrwxrwx 1 a b 7 Aug 15 19:00 cur -> images")[0], { type: "link", size: 7, name: "cur", raw: "lrwxrwxrwx 1 a b 7 Aug 15 19:00 cur -> images" });
eq("parseList dos", parseList("08-15-26  07:00PM       <DIR>          images\r\n08-15-26  07:00PM             99 a.txt")
  .map((x) => [x.type, x.name, x.size]), [["dir", "images", null], ["file", "a.txt", 99]]);
eq("parseList keeps junk as unparsed (never silently dropped)", parseList("total 12")[0].type, "unparsed");

// Explicit FTPS (R10's first flavour), against a mock that reproduces R10's NAT trap:
// PASV advertises an unroutable IP while listening on loopback.
{
  const srv = await startFtpsMock({ mode: "explicit", advertiseBogusIp: true });
  let s;
  try {
    s = await ftpsConnect({ host: srv.host, port: srv.port, mode: "explicit", user: "u", pass: "p" });
    eq("ftps explicit: AUTH TLS upgrade succeeded", Boolean(s.controlTls?.protocol), true);
    eq("ftps explicit: no bytes lost across the TLS upgrade", s.leftoverBeforeUpgrade, 0);
    eq("ftps explicit: PBSZ 0 accepted", s.pbsz, 200);
    eq("ftps explicit: PROT P accepted", [s.protReply, s.prot], [200, true]);
    eq("ftps explicit: TYPE I accepted", s.typeI, 200);

    const feat = await s.cmd("FEAT");
    eq("ftps: FEAT parses as one 211 reply", feat.code, 211);

    const list = await s.xferIn("LIST /images");
    const entries = parseList(list.buf.toString("latin1"));
    eq("ftps: LIST opened 150 and closed 226", [list.openCode, list.finCode], [150, 226]);
    eq("ftps: LIST returned the archive contents", entries.map((e) => e.name).sort(),
      ["product-1.png", "product-2.png", "product-5.png"]);
    eq("ftps: PASV advertised an IP we did NOT use (R10 NAT rule)", s.pasv[0].advertisedDifferedFromControl, true);
    eq("ftps: data channel used the control host, not the advertisement", s.pasv[0].usedHost, "127.0.0.1");

    const retr = await s.xferIn("RETR /images/product-1.png");
    eq("ftps: RETR byte-identical under TYPE I", Buffer.compare(retr.buf, ONE_PX_PNG), 0);
    eq("ftps: RETR preserved the PNG magic bytes", retr.buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const payload = Buffer.concat([ONE_PX_PNG, Buffer.from([0x0a, 0x0d, 0x0a])]); // bytes TYPE A would mangle
    const stor = await s.xferOut("STOR /images/uploaded.png", payload);
    eq("ftps: STOR completed 226", [stor.openCode, stor.finCode], [150, 226]);
    const back = await s.xferIn("RETR /images/uploaded.png");
    eq("ftps: STOR round-trip is byte-identical (seeding half of F35)", Buffer.compare(back.buf, payload), 0);
    const del = await s.cmd("DELE /images/uploaded.png");
    eq("ftps: DELE cleans up", del.code, 250);

    eq("ftps: transcript redacts the password", s.transcript.some((t) => t[">"] === "PASS ****") && !JSON.stringify(s.transcript).includes('"PASS p"'), true);
  } finally { s?.quit(); await srv.close(); }
}

// Implicit FTPS (R10's fallback flavour) — TLS from the first byte, no AUTH command.
{
  const srv = await startFtpsMock({ mode: "implicit" });
  let s;
  try {
    s = await ftpsConnect({ host: srv.host, port: srv.port, mode: "implicit", user: "u", pass: "p" });
    eq("ftps implicit: connected with TLS from byte 0", Boolean(s.controlTls?.protocol), true);
    eq("ftps implicit: never sent AUTH TLS", s.transcript.some((t) => String(t[">"] ?? "").startsWith("AUTH")), false);
    const r = await s.xferIn("RETR /images/product-2.png");
    eq("ftps implicit: RETR works", Buffer.compare(r.buf, ONE_PX_PNG), 0);
    // The mock upgrades the data channel with a standalone TLSSocket, which cannot share
    // ticket keys with the control listener, so it cannot honestly assert server-side reuse.
    // What IS ours to guarantee is that the client always OFFERS the control session.
    eq("ftps: client offers the control TLS session on the data channel", s.dataTls?.ticketAvailable, true);
  } finally { s?.quit(); await srv.close(); }
}

// A refused data channel must surface as a reply code, NOT as a 60-second hang.
// (Found by this mock: the first cut of xferIn waited for a 226 that was never coming.)
{
  const srv = await startFtpsMock({ mode: "explicit", rejectData: true });
  let s, err = null;
  try {
    s = await ftpsConnect({ host: srv.host, port: srv.port, mode: "explicit", user: "u", pass: "p" });
    const t0 = Date.now();
    try { await s.xferIn("LIST /images"); } catch (e) { err = { msg: e.message, ms: Date.now() - t0 }; }
    eq("ftps: refused data channel surfaces 425", Boolean(err && /425/.test(err.msg)), true);
    eq("ftps: and does so in seconds, not on a timeout", Boolean(err && err.ms < 10000), true);
  } finally { s?.quit(); await srv.close(); }
}

// A server that refuses PROT P must be RECORDED, not assumed away (adversarial-review rule).
{
  const srv = await startFtpsMock({ mode: "explicit", refuseProt: true });
  let s;
  try {
    s = await ftpsConnect({ host: srv.host, port: srv.port, mode: "explicit", user: "u", pass: "p" });
    eq("ftps: PROT refusal is recorded, not swallowed", [s.protReply, s.prot], [534, false]);
    const r = await s.xferIn("LIST /images"); // falls back to a cleartext data channel
    eq("ftps: cleartext data channel still transfers when PROT is refused", parseList(r.buf.toString("latin1")).length, 3);
  } finally { s?.quit(); await srv.close(); }
}

// Wrong credentials / wrong port must throw with the transcript attached, never hang.
{
  let msg = null;
  try { await ftpsConnect({ host: "127.0.0.1", port: 1, mode: "explicit", user: "u", pass: "p", timeoutMs: 3000 }); }
  catch (e) { msg = e.stage; }
  eq("ftps: unreachable port fails fast at tcp-connect", msg, "tcp-connect");
}


// ---------------------------------------------------------------------------------------------
// classifyPageProbes — the page-base decision table.
//
// This is the part of the pagebase probe that live output CANNOT check: a mis-ordered branch
// returns a confident base that looks exactly like a correct one in the artifact. So every row of
// the table gets an assertion, and every row that must NOT decide is asserted to return null.
// ---------------------------------------------------------------------------------------------
{
  const P = (o) => ({ page: 0, ok: true, fault: null, arity: false, rows: 0, ids: [], ...o });
  const base = (z, o) => classifyPageProbes(z, o)[0];

  eq("pagebase: Page=0 faults, Page=1 works -> 1",
    base(P({ ok: false, fault: "PARAM: Page must be greater than 0" }), P({ rows: 5, ids: ["1", "2"] })), 1);
  eq("pagebase: Page=0 empty, Page=1 has rows -> 1",
    base(P({ rows: 0, ids: [] }), P({ rows: 5, ids: ["1", "2"] })), 1);
  eq("pagebase: Page=0 has rows, Page=1 empty -> 0",
    base(P({ rows: 5, ids: ["1", "2"] }), P({ rows: 0, ids: [] })), 0);
  eq("pagebase: both have DIFFERENT rows -> 0",
    base(P({ rows: 2, ids: ["1", "2"] }), P({ rows: 2, ids: ["3", "4"] })), 0);

  // The rows that must refuse to decide. Each of these returning a base is a silent page loss.
  eq("pagebase: both have the SAME rows -> undecidable (the server clamps)",
    base(P({ rows: 2, ids: ["1", "2"] }), P({ rows: 2, ids: ["1", "2"] })), null);
  eq("pagebase: both empty -> no evidence, not a base",
    base(P({ rows: 0, ids: [] }), P({ rows: 0, ids: [] })), null);
  eq("pagebase: an arity fault is an ARGUMENT error, never page evidence (R17/R27)",
    base(P({ ok: false, arity: true, fault: "PHP: Too few arguments to function" }), P({ rows: 5, ids: ["1"] })), null);
  eq("pagebase: arity on the SECOND probe also disqualifies the pair",
    base(P({ rows: 5, ids: ["1"] }), P({ ok: false, arity: true, fault: "PHP: Too few arguments to function" })), null);
  eq("pagebase: both faulting decides nothing",
    base(P({ ok: false, fault: "AUTH: x" }), P({ ok: false, fault: "AUTH: x" })), null);
  eq("pagebase: Page=0 ok but Page=1 faulting is INCONSISTENT, not base 0",
    base(P({ rows: 5, ids: ["1"] }), P({ ok: false, fault: "PARAM: nope" })), null);

  // Order matters: the arity guard has to run BEFORE the fault-shape branch, or an arity error on
  // Page=0 reads as "the server rejected page 0" and yields a confident, wrong base of 1.
  eq("pagebase: arity on Page=0 must NOT be read as a rejection of page 0",
    base(P({ ok: false, arity: true, fault: "PHP: Too few arguments to function WebService::X()" }),
      P({ rows: 5, ids: ["1"] })), null);

  // The op list is a schema fact read out of the WSDL, not a hand-kept list.
  const ops = wsdlPageOps();
  eq("pagebase: WSDL yields the Page/PageSize operations", ops.map((o) => o.op).sort(),
    ["Order_GetAllWithPagination", "Order_GetByDateUpdatedWithPagination", "Order_GetByDateWithPagination",
      "Order_GetByStatusWithPagination", "Product_GetDiscountsAccumulativeAllWithPagination"]);
  eq("pagebase: and their declared argument names come with them (R27 - no invented names)",
    ops.find((o) => o.op === "Order_GetByStatusWithPagination")?.args, ["Status", "Page", "PageSize"]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall green");
process.exit(failed ? 1 : 0);
