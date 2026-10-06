#!/usr/bin/env node
/**
 * probe-dandomain.mjs — P1 live probes against a DanDomain Webshop (Hostedshop) demo shop.
 * Zero dependencies, Node >= 20. RUN NATIVELY (the cloud sandbox cannot reach shop APIs).
 *
 * Probes a DanDomain shop. Results land in data/probes/:
 * per-probe JSON + probe-log.jsonl + the full service.wsdl. Read those in the next session.
 *
 * Setup (once): in the shop admin enable Indstillinger > API: SOAP (+ your public IP),
 * create an employee with app-access "API" (password WITHOUT ! , €), then in repo .env:
 *   DD_SOAP_USERNAME=...   DD_SOAP_PASSWORD=...   DD_PROBE_SHOP=shop000000
 *
 * Usage:
 *   node scripts/probe-dandomain.mjs wsdl          # download + census the full WSDL (read-only, no auth)
 *   node scripts/probe-dandomain.mjs smoke         # connect + read-only inventory of the shop
 *   node scripts/probe-dandomain.mjs op <Name>     # print an operation's input schema from the saved WSDL
 *   node scripts/probe-dandomain.mjs vat --write         # VAT-basis probe (creates PROBE-* products + 1 order)
 *   node scripts/probe-dandomain.mjs ordercreate --write # Order_Create fault matrix + backdated transaction
 *   node scripts/probe-dandomain.mjs urls --write        # URL fields, language slugs, rename->auto-redirect
 *   node scripts/probe-dandomain.mjs limits        # page-size sweep + burst timing (read-only)
 *   node scripts/probe-dandomain.mjs sentinels     # inventory DDSEED-* (read-only)
 *   node scripts/probe-dandomain.mjs sentinels --write  # delete DDSEED-* on scratch 105698
 *   node scripts/probe-dandomain.mjs all [--write]
 *
 * SAFETY: --write probes create PROBE-* data in the shop named by DD_PROBE_SHOP (a scratch
 * demo shop, never a migration source). This script NEVER calls transaction capture/cancel,
 * Klarna ops, or Order_Send*Email. After ordercreate, check the shop's mail log manually —
 * whether Order_Create/UpdateStatus fires customer email is one of the findings we need.
 *
 * NOTE: envelopes are best-effort SOAP 1.2 doc/literal-wrapped, written before the full
 * WSDL was obtainable. If a call faults oddly, run `wsdl` then `op <Name>` and align params.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import tls from "node:tls";
import { buildQueryDocument } from "../src/dandomain/graphql.js";
import { loadConfig } from "../src/config.js";
import { isScratchDanDomainShopId, resetDanDomainSentinels } from "../src/seed-dandomain.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "probes");
mkdirSync(OUT, { recursive: true });

// ---------- env ----------
try {
  for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env is fine for `wsdl` */ }
const USER = process.env.DD_SOAP_USERNAME, PASS = process.env.DD_SOAP_PASSWORD;
const PROBE_SHOP = process.env.DD_PROBE_SHOP;
const WSDL_URLS = ["https://api.hostedshop.io/service.wsdl", "https://api.hostedshop.dk/service.wsdl"];
let ENDPOINT = "https://api.hostedshop.io/service.php"; // corrected from WSDL soap:address when available
const epFile = path.join(OUT, "endpoint.txt");
if (existsSync(epFile)) ENDPOINT = readFileSync(epFile, "utf8").trim() || ENDPOINT;
const NS = "https://api.hostedshop.io/service.php";

// ---------- tiny SOAP 1.2 client (session = cookies) ----------
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const toXml = (v) => v === null || v === undefined ? "" :
  typeof v === "object" && !Array.isArray(v) ? Object.entries(v).map(([k, x]) =>
    Array.isArray(x) ? x.map((it) => `<${k}>${toXml(it)}</${k}>`).join("") : `<${k}>${toXml(x)}</${k}>`).join("")
  : esc(v);
let jar = {};
const ENC_EVIDENCE = { recorded: false };
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
let LAST_BUF = null;
let WIRE = "utf-8"; // "utf-8" | "latin1" — the charset our REQUEST bytes are encoded in
async function call(op, args = {}, { timeoutMs = 30000, wire = WIRE } = {}) {
  const decl = wire === "latin1" ? "ISO-8859-1" : "UTF-8";
  const bodyStr = `<?xml version="1.0" encoding="${decl}"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>
<m:${op} xmlns:m="${NS}">${toXml(args)}</m:${op}>
</env:Body></env:Envelope>`;
  // LIVE FACT 2026-08-15: sending UTF-8 bytes stored "Æblegrød" as "?blegr?d" in the shop.
  // Hostedshop is a windows-1252/latin1 stack, so the wire encoding is a probe variable.
  const body = wire === "latin1" ? Buffer.from(bodyStr, "latin1") : Buffer.from(bodyStr, "utf8");
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": `application/soap+xml; charset=${wire === "latin1" ? "iso-8859-1" : "utf-8"}; action="${NS}#${op}"`, ...(cookieHeader() ? { cookie: cookieHeader() } : {}) },
    body,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) { const m = sc.match(/^([^=]+)=([^;]+)/); if (m) jar[m[1]] = m[2]; }
  // Decode EXPLICITLY: the server's declared charset is not trustworthy (live probe 2026-08-15
  // showed "Genåbnet" arriving as "GenÃ¥bnet" via res.text()). Try strict UTF-8, fall back to
  // windows-1252, and record the evidence so the encoding question is settled by data.
  const buf = new Uint8Array(await res.arrayBuffer());
  LAST_BUF = buf;
  let text, decodedAs;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); decodedAs = "utf-8"; }
  catch { text = new TextDecoder("windows-1252").decode(buf); decodedAs = "windows-1252"; }
  const mojibake = /Ã[\x80-\xBF]|Â[\x80-\xBF]/.test(text); // valid UTF-8 that is itself double-encoded
  if (!ENC_EVIDENCE.recorded) {
    ENC_EVIDENCE.recorded = true;
    ENC_EVIDENCE.contentType = res.headers.get("content-type");
    ENC_EVIDENCE.decodedAs = decodedAs;
    ENC_EVIDENCE.doubleEncodedSuspected = mojibake;
    ENC_EVIDENCE.sampleHex = Buffer.from(buf.slice(0, 0)).toString();
  }
  if (mojibake && !ENC_EVIDENCE.mojibakeSeen) ENC_EVIDENCE.mojibakeSeen = true;
  const ms = Date.now() - t0;
  const fault = text.match(/<(?:\w+:)?Code>[\s\S]*?<(?:\w+:)?Value>(?:\w+:)?([^<]*)<[\s\S]*?<(?:\w+:)?(?:Reason|faultstring)>[\s\S]*?<(?:\w+:)?Text[^>]*>([^<]*)</) ||
    text.match(/<(?:\w+:)?faultcode>([^<]*)<[\s\S]*?<(?:\w+:)?faultstring>([^<]*)</);
  if (fault) {
    // SOAP 1.2 app codes live in Subcode/Value (Code/Value is just env:Sender|Receiver)
    const sub = text.match(/<(?:\w+:)?Subcode>[\s\S]*?<(?:\w+:)?Value>(?:\w+:)?([^<]*)</);
    const code = (sub?.[1] ?? fault[1]).trim();
    const e = new Error(`SoapFault ${code}: ${fault[2].trim()}`); e.code = code; e.raw = text; e.ms = ms; throw e;
  }
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.raw = text.slice(0, 2000); throw e; }
  const inner = text.match(new RegExp(`<(?:\\w+:)?${op}Response[^>]*>([\\s\\S]*?)</(?:\\w+:)?${op}Response>`));
  let parsed = inner ? parseXml(inner[1]) : text;
  // unwrap the doc/literal-wrapped result layer: {Op_Result: X} -> X
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const k = Object.keys(parsed);
    if (k.length === 1 && k[0] === `${op}Result`) parsed = parsed[k[0]];
  }
  return { ms, raw: text, result: parsed };
}
function parseXml(x) { // naive but sufficient: elements -> objects/arrays/strings; attributes ignored
  x = x.trim(); const out = {}; let any = false;
  const re = /<(?:\w+:)?([\w.]+)(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?\1>|<(?:\w+:)?([\w.]+)(?:\s[^>]*)?\/>/g;
  let m; while ((m = re.exec(x))) {
    any = true; const k = m[1] ?? m[3]; const v = m[3] !== undefined ? null : parseXml(m[2]);
    if (k in out) { out[k] = Array.isArray(out[k]) ? out[k] : [out[k]]; out[k].push(v); } else out[k] = v;
  }
  if (!any) return x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"');
  if ("item" in out && Object.keys(out).length === 1) return Array.isArray(out.item) ? out.item : [out.item];
  return out;
}
async function connect() {
  if (!USER || !PASS) throw new Error("DD_SOAP_USERNAME / DD_SOAP_PASSWORD missing from .env");
  jar = {};
  await call("Solution_Connect", { Username: USER, Password: PASS });
  // LIVE FACT: Solution_SetEncoding("UTF-8") double-encodes reads AND destroys writes ("?").
  // The session default is correct for this latin1 stack — do not set it.
}
const save = (name, data) => { writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2)); log(name, data); };
const log = (probe, findings) => appendFileSync(path.join(OUT, "probe-log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), probe, findings }) + "\n");
const p = (...a) => console.log(...a);
const requireWrite = () => {
  if (!process.argv.includes("--write")) throw new Error("This probe WRITES to the shop. Re-run with --write.");
  if (!PROBE_SHOP) throw new Error("Set DD_PROBE_SHOP=<shop id> in .env to consent to writes on that scratch shop.");
};

// ---------- P1-REDO harness (adversarial review 2026-08-15) ----------
// Rule 1: never swallow a fault. Every call records its outcome.
// Rule 2: *_SetFields is NOT a contract — a requested field can vanish with no error
//         (InvoiceNumber did, silently). Diff requested vs returned on every read.
const FAULTS = [];
async function tryCall(op, args = {}, opts = {}) {
  try { const r = await call(op, args, opts); return { ok: true, op, result: r.result, ms: r.ms }; }
  catch (e) { const rec = { ok: false, op, code: e.code ?? "?", message: e.message, args: Object.keys(args) };
    FAULTS.push(rec); return rec; }
}
/** Set a field list and report whether the server honoured it on the first record read back.
 *  NOTE (2026-08-15): when the read returned NO record there is nothing to audit, and the
 *  honest answer is `truncated: null`, not `true`. The first cut returned `true` for an empty
 *  result set and would have let "customers are silently truncated" into the findings when the
 *  recorded fact was "this shop has zero customers". Same class of error the review caught. */
function fieldAudit(requested, sample) {
  const want = String(requested).split(",").map((x) => x.trim()).filter(Boolean);
  const rec = Array.isArray(sample) ? sample[0] : sample;
  const hasRecord = Boolean(rec && typeof rec === "object" && Object.keys(rec).length);
  const got = hasRecord ? Object.keys(rec) : [];
  const missing = hasRecord ? want.filter((w) => !got.includes(w)) : [];
  return { requested: want, returned: got, missing, sampleAvailable: hasRecord,
    truncated: hasRecord ? missing.length > 0 : null };
}
const wsdlType = (() => { let xml = null;
  return (name) => {
    if (xml === null) { try { xml = readFileSync(path.join(OUT, "service.wsdl"), "utf8"); } catch { xml = ""; } }
    const m = xml.match(new RegExp(`<xsd:complexType name="${name}">[\\s\\S]*?</xsd:complexType>`));
    return m ? [...m[0].matchAll(/<xsd:element name="([^"]+)" type="([^"]+)"/g)].map((x) => x[1]) : [];
  };
})();

// ---------- probes ----------
async function probeWsdl() {
  let xml = null, used = null;
  for (const u of WSDL_URLS) { try { const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); if (r.ok) { xml = await r.text(); used = u; break; } } catch { } }
  if (!xml) throw new Error("Could not download WSDL from either mirror");
  writeFileSync(path.join(OUT, "service.wsdl"), xml);
  const addr = xml.match(/<(?:\w+:)?address[^>]*location="([^"]+)"/);
  if (addr) { ENDPOINT = addr[1]; writeFileSync(epFile, ENDPOINT); }
  // NB: this WSDL uses the DEFAULT namespace — tags are <definitions>/<operation>, not <wsdl:...>
  const ops = [...new Set([...xml.matchAll(/<(?:\w+:)?operation name="([^"]+)"/g)].map((m) => m[1]))].sort();
  writeFileSync(path.join(OUT, "operations-census.json"), JSON.stringify(ops, null, 2));
  const has = (n) => ops.includes(n);
  save("wsdl-findings", {
    source: used, endpoint: ENDPOINT, operationCount: ops.length, truncated: !/<\/(?:\w+:)?definitions>/.test(xml),
    key: {
      Order_Create: has("Order_Create"), Product_CreateOrUpdate: has("Product_CreateOrUpdate"),
      Product_CreateOrUpdateBulk: has("Product_CreateOrUpdateBulk"), Product_CreateOrUpdateVariant: has("Product_CreateOrUpdateVariant"),
      User_CreateOrUpdate: has("User_CreateOrUpdate"), Category_CreateOrUpdate: has("Category_CreateOrUpdate"),
      SEORedirect_Create: has("SEORedirect_Create"), SEORedirect_Update: has("SEORedirect_Update"),
      SEORedirect_GetAll: has("SEORedirect_GetAll"), Order_LowerTransaction: has("Order_LowerTransaction"),
      Order_GetAllWithPagination: has("Order_GetAllWithPagination"), Product_GetAllWithLimit: has("Product_GetAllWithLimit"),
    },
  });
  p(`WSDL: ${ops.length} operations (census vs docs' 249 — diff in next session). Complete document: ${/<\/(?:\w+:)?definitions>/.test(xml)}`);
}
function probeOp(name) { // print an operation's input element from the saved WSDL
  const xml = readFileSync(path.join(OUT, "service.wsdl"), "utf8");
  const el = xml.match(new RegExp(`<xsd:element name="${name}">[\\s\\S]*?</xsd:element>`)) ||
    xml.match(new RegExp(`<xsd:element name="${name}"[^>]*/>`));
  p(el ? el[0] : `element ${name} not found — grep data/probes/service.wsdl manually`);
  const t = xml.match(new RegExp(`<xsd:complexType name="${name}"[\\s\\S]*?</xsd:complexType>`));
  if (t) p(t[0]);
}
async function probeSmoke() {
  await connect();
  const web = (await call("Solution_GetWebinfo")).result;
  const langs = (await call("Solution_GetLanguages")).result;
  const sites = (await call("Sites_GetAll")).result;
  const statuses = (await call("OrderStatusCode_GetAll")).result;
  const currencies = (await call("Currency_GetAll")).result;
  const vat = (await call("VatGroup_GetAll")).result;
  let productSample = null; try { await call("Product_SetFields", { Fields: "Id,ItemNumber,Title,Price,Url,SeoLink" }); productSample = (await call("Product_GetAllWithLimit", { Start: 0, Length: 3 })).result; } catch (e) { productSample = `FAILED: ${e.message}`; }
  let ids = null; try { ids = await lookups(); } catch (e) { ids = `lookups failed: ${e.message}`; }
  save("smoke", { webinfo: web, languages: langs, sites, orderStatusCodes: statuses, currencies, vatGroups: vat, productSample, lookups: ids, encoding: ENC_EVIDENCE });
  p("Smoke OK — inspect data/probes/smoke.json (webinfo should identify", PROBE_SHOP ?? "(your shop)", ")");
}
/** LIVE FACT 2026-08-15 (F16): Order_Create can CREATE the order and still raise a
 *  SoapFault "lineErrors: Order: N created. Following products were not included: ...".
 *  Retrying on this fault duplicates orders. Always parse the id out and treat it as
 *  created-but-incomplete. */
const orderIdFromLineErrors = (e) => {
  const m = /Order:\s*(\d+)\s*created/i.exec(e?.message ?? "");
  return m ? Number(m[1]) : null;
};
/** Ids required by Order_Create (CurrencyId/PaymentId/DeliveryId are mandatory per WSDL). */
async function lookups() {
  const one = (r) => Array.isArray(r) ? r[0] : r;
  const currencies = (await call("Currency_GetAll")).result;
  const payments = (await call("Payment_GetAll")).result;
  const deliveries = (await call("Delivery_GetAll")).result;
  const vatGroups = (await call("VatGroup_GetAll")).result;
  const L = {
    currencyId: Number(one(currencies)?.Id ?? 1), currencyIso: one(currencies)?.Iso ?? "DKK",
    paymentId: Number(one(payments)?.Id ?? 0), deliveryId: Number(one(deliveries)?.Id ?? 0),
    vatGroups: (Array.isArray(vatGroups) ? vatGroups : [vatGroups]).map((v) => ({ Id: v?.Id, Name: v?.Name, Pct: v?.VatPercentage })),
    raw: { payments, deliveries },
  };
  L.vat25 = L.vatGroups.find((v) => Number(v.Pct) === 25) ?? null;
  L.vat0 = L.vatGroups.find((v) => Number(v.Pct) === 0) ?? null;
  // LIVE FACT 2026-08-15: OrderCustomerCreate.CountryCode is xsd:string in the WSDL but the
  // server rejects "DK" with PARAM "CountryCode 'DK' is not a number" — it wants an id.
  try {
    const c = (await call("Product_GetDeliveryCountryAll")).result;
    L.countries = (Array.isArray(c) ? c : [c]).filter(Boolean).map((x) => ({ Id: x?.Id, Iso: x?.Iso, Code: x?.Code, Primary: x?.Primary }));
    L.dk = L.countries.find((x) => String(x.Iso).toUpperCase() === "DK") ?? L.countries.find((x) => String(x.Primary) === "true") ?? L.countries[0] ?? null;
  } catch (e) { L.countries = `Product_GetDeliveryCountryAll failed: ${e.message}`; L.dk = null; }
  return L;
}
/** LIVE FACT 2026-08-15: Product_CreateOrUpdate REQUIRES CategoryId even though the WSDL
 *  marks it minOccurs="0" (fault code "PRODUCT": "A CategoryId must be set when creating a
 *  product"). Every product write must resolve a category first. */
async function ensureCategory(title = "Probe Kategori") {
  const find = async () => {
    const r = (await call("Category_GetAll")).result;
    const list = (Array.isArray(r) ? r : [r]).filter(Boolean);
    return { hit: list.find((c) => String(c?.Title ?? "") === title), list };
  };
  let { hit, list } = await find();
  if (hit) return hit;
  await call("Category_CreateOrUpdate", { CategoryData: { Title: title, LanguageISO: "DK", Status: true } });
  ({ hit, list } = await find());
  return hit ?? list[list.length - 1] ?? null;
}
/** VatGroup_Create exists in the WSDL, so the VAT probe provisions its own 25% group.
 *  (Language layers, delivery and payment methods have NO create ops — admin-only setup.) */
async function ensureVat25(L) {
  if (L.vat25) return L;
  await call("VatGroup_Create", { VatGroupData: { Name: "25 % (probe)", VatPercentage: 25, Sorting: 1 } });
  const groups = (await call("VatGroup_GetAll")).result;
  L.vatGroups = (Array.isArray(groups) ? groups : [groups]).map((v) => ({ Id: v?.Id, Name: v?.Name, Pct: v?.VatPercentage }));
  L.vat25 = L.vatGroups.find((v) => Number(v.Pct) === 25) ?? null;
  L.vat25Provisioned = !!L.vat25;
  return L;
}
async function probeVat() {
  requireWrite(); await connect();
  const L = await ensureVat25(await lookups());
  const cat = await ensureCategory();
  const webinfo = (await call("Solution_GetWebinfo")).result;
  const mk = async (item, price, vatGroupId, title) => {
    await call("Product_CreateOrUpdate", { ProductData: { ItemNumber: item, Title: title, LanguageISO: "DK", Price: price, Status: true, Online: true, Stock: 100, OutOfStockBuy: "1", CategoryId: Number(cat?.Id), ...(vatGroupId ? { VatGroupId: Number(vatGroupId) } : {}) } });
    await call("Product_SetFields", { Fields: "Id,ItemNumber,Title,Price,BuyingPrice,VatGroupId,Status,Online,Stock,OutOfStockBuy,DisableOnEmpty,CategoryId" });
    return (await call("Product_GetByItemNumber", { ItemNumber: item })).result;
  };
  const at25 = L.vat25 ? await mk("PROBE-VAT-25", 100, L.vat25.Id, "PROBE VAT 25pct at 100") : null;
  const at0 = L.vat0 ? await mk("PROBE-VAT-00", 100, L.vat0.Id, "PROBE VAT 0pct at 100") : null;
  // DECISIVE, no eyeballing: put the 25% product on an order and read Total/Vat back.
  // entered 100 -> Total 100 / Vat 20  => Price is VAT-INCLUSIVE
  // entered 100 -> Total 125 / Vat 25  => Price is VAT-EXCLUSIVE
  let vatOrder = null;
  try {
    const p25 = Array.isArray(at25) ? at25[0] : at25;
    const pid = Number(p25?.Id);
    const ccList = [L.dk?.Id, L.dk?.Code, 208].filter((v) => v !== undefined && v !== null);
    const cust = (cc) => ({ Firstname: "Probe", Lastname: "Vat", Company: "", Cvr: "", Ean: "", Address: "Testvej 1", Address2: "", Zip: "8000", City: "Aarhus", Country: "Denmark", CountryCode: cc, Phone: "", Email: "probe-vat@example.com" });
    let orderId = null, attempts = [];
    for (const cc of ccList) {
      try {
        const r = (await call("Order_Create", { OrderData: { CurrencyId: L.currencyId, PaymentId: L.paymentId, DeliveryId: L.deliveryId, LanguageISO: "DK",
          ReferenceNumber: "PROBE-VAT-ORDER", OrderCustomer: cust(cc), OrderLines: { item: [{ ProductId: pid, Amount: 1, Price: 100 }] } } })).result;
        orderId = typeof r === "object" ? (r?.Order_CreateResult ?? JSON.stringify(r)) : r;
        attempts.push({ countryCode: cc, ok: true, orderId }); break;
      } catch (e) {
        const partial = orderIdFromLineErrors(e);
        attempts.push({ countryCode: cc, ok: false, code: e.code, message: e.message, orderCreatedAnyway: partial });
        if (partial) { orderId = partial; break; } // F16: created despite the fault — DO NOT retry
      }
    }
    if (orderId) {
      await call("Order_SetFields", { Fields: "Id,ReferenceNumber,Total,Vat,CurrencyId,Status,OrderLines,DateUpdated" });
      const o = (await call("Order_GetById", { OrderId: Number(orderId) })).result;
      const total = Number(o?.Total), vat = Number(o?.Vat);
      vatOrder = { attempts, order: o, total, vat,
        basis: Number.isFinite(total) ? (Math.abs(total - 100) < 0.51 ? "INCLUSIVE (entered price already contains VAT)"
          : Math.abs(total - 125) < 0.51 ? "EXCLUSIVE (VAT added on top of the entered price)"
          : `UNCLEAR — Total=${total}, Vat=${vat}; note delivery price may be included in Total`) : "UNCLEAR — no numeric Total" };
    } else vatOrder = { attempts, note: "Order_Create failed for every CountryCode candidate — VAT basis unresolved" };
  } catch (e) { vatOrder = { error: e.message }; }

  save("vat", { lookups: L, encoding: ENC_EVIDENCE, vatOrder,
    shopSetting: { ProductPricesWithVat: webinfo?.ProductPricesWithVat, ShowProductPricesWithVat: webinfo?.ShowProductPricesWithVat },
    enteredPrice: 100, readBack25: at25, readBack0: at0,
    interpret: "ProductPricesWithVat=true means prices are ENTERED incl. VAT. Confirm empirically: open both PROBE-VAT-* products in admin and on the storefront and note the displayed price. If the 25% product shows 100 incl (=80 ex) the API Price field is INCL VAT; if it shows 125 the API field is EX VAT. Without a 25% VAT group this probe is inconclusive - create one in admin first." });
  p(vatOrder?.basis ? `VAT BASIS: ${vatOrder.basis}` : L.vat25 ? "VAT probe done - see data/probes/vat.json (order-based basis check inconclusive)." : "VAT probe INCONCLUSIVE: shop has no 25% VAT group (only " + JSON.stringify(L.vatGroups) + "). Create one in admin, then re-run.");
}
async function probeOrderCreate() {
  requireWrite(); await connect();
  const L = await lookups();
  const cat = await ensureCategory();
  await call("Product_CreateOrUpdate", { ProductData: { ItemNumber: "PROBE-OC-A", Title: "PROBE order product", LanguageISO: "DK", Price: 250, Status: true, Online: true, Stock: 100, OutOfStockBuy: "1", CategoryId: Number(cat?.Id) } });
  await call("Product_SetFields", { Fields: "Id,ItemNumber,Price" });
  const prod = (await call("Product_GetByItemNumber", { ItemNumber: "PROBE-OC-A" })).result;
  const pid = Number(Array.isArray(prod) ? prod[0]?.Id : prod?.Id);
  const mkCust = (cc) => ({ Firstname: "Probe", Lastname: "Order", Company: "", Cvr: "", Ean: "", Address: "Testvej 2", Address2: "", Zip: "8000", City: "Aarhus", Country: "Denmark", CountryCode: cc, Phone: "", Email: "probe-oc@example.com" });
  // Country candidates, most-likely first: delivery-country Id, its Code, then a bare 208 (DK ISO-3166 numeric)
  const ccCandidates = [L.dk?.Id, L.dk?.Code, 208].filter((v) => v !== undefined && v !== null);
  const cust = mkCust(ccCandidates[0]);
  const lines = { item: [{ ProductId: pid, Amount: 1, Price: 199 }] };
  const base = { CurrencyId: L.currencyId, PaymentId: L.paymentId, DeliveryId: L.deliveryId, LanguageISO: "DK" };
  const matrix = [];
  // Fault matrix: strip one REQUIRED field at a time to learn the effective required set.
  const attempts = [
    ["empty", {}],
    ["only-currency", { CurrencyId: L.currencyId }],
    ["no-lines", { ...base, OrderCustomer: cust }],
    ["no-customer", { ...base, OrderLines: lines }],
    ["minimal-valid", { ...base, OrderCustomer: cust, OrderLines: lines }],
    ["full-backdated-paid", { ...base, ReferenceNumber: "SRC-2019-0042", CustomerComment: "PROBE backdated paid",
      OrderCustomer: cust, OrderLines: lines,
      OrderTransaction: { OrderId: 0, PaymentId: L.paymentId, Status: 1, TransactionNumber: 0, Cardtype: "probe",
        Amount: 199, Currency: L.currencyId, Errorcode: 0, Actioncode: 0, Date: "2019-01-05 10:00:00" } }],
  ];
  for (const [label, data] of attempts) {
    try { const r = (await call("Order_Create", { OrderData: data })).result; matrix.push({ label, ok: true, returned: r }); }
    catch (e) { matrix.push({ label, ok: false, code: e.code, message: e.message }); }
  }
  // If every attempt failed on the country field, sweep the remaining candidates so one run settles it.
  if (!matrix.some((m) => m.ok) && matrix.some((m) => /CountryCode/i.test(m.message ?? ""))) {
    for (const cc of ccCandidates.slice(1)) {
      const label = `country-candidate:${cc}`;
      try { const r = (await call("Order_Create", { OrderData: { ...base, OrderCustomer: mkCust(cc), OrderLines: lines } })).result; matrix.push({ label, ok: true, returned: r }); break; }
      catch (e) { matrix.push({ label, ok: false, code: e.code, message: e.message }); }
    }
  }
  const okId = [...matrix].reverse().find((m) => m.ok)?.returned;
  let readBack = null, statusWalk = null;
  if (okId) {
    const oid = typeof okId === "object" ? okId?.Order_CreateResult ?? JSON.stringify(okId) : okId;
    await call("Order_SetFields", { Fields: "Id,InvoiceNumber,ReferenceNumber,Status,Total,Vat,DateDelivered,DateSent,DateUpdated,CurrencyId,CustomerComment,OrderLines,Transactions" });
    try { readBack = (await call("Order_GetById", { OrderId: oid })).result; } catch (e) { readBack = e.message; }
    try { const codes = (await call("OrderStatusCode_GetAll")).result; statusWalk = { availableCodes: codes };
      // walk one status forward if any code list came back — record only, no emails checked here
      // F37: status 1 ("Ordre modtaget") ALWAYS emails the customer, regardless of shop
      // settings. Never walk into it from a probe or a seeder.
      const safe = (Array.isArray(codes) ? codes : []).filter((c) => String(c?.Id) !== "1");
      const first = safe[0] ?? null;
      statusWalk.skippedAlwaysEmails = (Array.isArray(codes) ? codes : []).filter((c) => String(c?.Id) === "1");
      if (first?.Id) { await call("Order_UpdateStatus", { OrderId: oid, Status: first.Id }); statusWalk.walkedTo = first; }
    } catch (e) { statusWalk = { error: e.message }; }
  }
  save("ordercreate", { lookups: L, faultMatrix: matrix, readBack, statusWalk,
    interpret: "Findings: required-field set (which attempts PARAM-faulted), whether line Price 199 was honored or recomputed, what initial status/date the server assigned, id vs order number. CHECK THE SHOP MAIL LOG: did any customer email fire?" });
  p("Order_Create probe done — see data/probes/ordercreate.json + check mail log manually.");
}
async function probeUrls() {
  requireWrite(); await connect();
  const cat = await ensureCategory();
  await call("Product_CreateOrUpdate", { ProductData: { ItemNumber: "PROBE-URL-A", Title: "Probe URL Æblegrød", LanguageISO: "DK", Price: 10, Status: true, Online: true, Stock: 100, CategoryId: Number(cat?.Id), SeoLink: "probe-url-aeblegroed" } });
  const langs = (await call("Solution_GetLanguages")).result;
  const langList = (Array.isArray(langs) ? langs : [langs]).filter(Boolean);
  const perLang = {};
  if (langList.length < 2) perLang._note = "shop has ONE language layer only (plan limit 2026-08-15) - per-language slug findings are UNPROVEN; re-run after the package upgrade adds a layer";
  if (!langList.length) langList.push({ LanguageISO: "DK" }); // still read the product once
  for (const l of langList) {
    // live shape is LanguageISO (not Iso) — accept all spellings
    const iso = l?.LanguageISO ?? l?.Iso ?? l?.LanguageIso ?? l; if (!iso || typeof iso === "object") continue;
    try { await call("Solution_SetLanguage", { LanguageISO: iso });
      await call("Product_SetFields", { Fields: "Id,ItemNumber,Title,Url,SeoLink" });
      perLang[iso] = (await call("Product_GetByItemNumber", { ItemNumber: "PROBE-URL-A" })).result;
    } catch (e) { perLang[iso] = e.message; }
  }
  const before = (await call("SEORedirect_GetAll")).result;
  await call("Product_CreateOrUpdate", { ProductData: { ItemNumber: "PROBE-URL-A", Title: "Probe URL Æblegrød RENAMED", LanguageISO: "DK", CategoryId: Number(cat?.Id), SeoLink: "probe-url-renamed" } });
  const after = (await call("SEORedirect_GetAll")).result;
  save("urls", { category: cat, productPerLanguage: perLang, redirectsBefore: before, redirectsAfter: after,
    interpret: "Does Url hold a RESOLVED live path (incl. /shop|/webshop base + catId-catSlug)? Do rename redirects appear as new SEORedirect rows (recoverable URL history)? Also open the product on the storefront via its secondary category to test alternate paths manually." });
  p("URL probe done — see data/probes/urls.json (and click the storefront once for the secondary-category question).");
}
/** Danish text arrives double-encoded ("Genåbnet" -> "GenÃ¥bnet") even though the response
 *  header says charset=utf-8 and the bytes are valid UTF-8. Hypothesis: Solution_SetEncoding
 *  triggers a Latin-1->UTF-8 conversion on data that is ALREADY UTF-8. Test all three modes
 *  against the same known-Danish string and let the bytes decide. */
async function probeEncoding() {
  const probeText = async (mode) => {
    jar = {};
    await call("Solution_Connect", { Username: USER, Password: PASS });
    if (mode !== "none") await call("Solution_SetEncoding", { Encoding: mode });
    const r = (await call("OrderStatusCode_GetAll")).result;
    const list = (Array.isArray(r) ? r : [r]).filter(Boolean);
    const hit = list.find((s) => /^Gen/.test(String(s?.Title ?? ""))) ?? list[0];
    const title = String(hit?.Title ?? "");
    return {
      mode, title,
      codepoints: [...title].map((c) => c.codePointAt(0).toString(16)).join(" "),
      correct: title === "Genåbnet",
      doubleEncoded: /Ã[-¿]/.test(title),
      repaired: (() => { try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from([...title].map((c) => c.charCodeAt(0)))); } catch { return null; } })(),
    };
  };
  const modes = [];
  for (const m of ["UTF-8", "none", "ISO-8859-1"]) {
    try { modes.push(await probeText(m)); } catch (e) { modes.push({ mode: m, error: e.message }); }
  }
  const good = modes.find((m) => m.correct);

  // WRITE round-trip: the read side alone cannot prove storage is correct (a symmetric bug
  // round-trips cleanly while storing garbage). Write a known Danish title under each
  // (setEncoding x wire) combination; the shop admin/storefront is the ground truth.
  const DANISH = "Ærø æøå ÆØÅ";
  const writes = [];
  if (process.argv.includes("--write") && PROBE_SHOP) {
    const combos = [
      { setEncoding: "none", wire: "latin1" }, { setEncoding: "ISO-8859-1", wire: "latin1" },
      { setEncoding: "none", wire: "utf-8" }, { setEncoding: "UTF-8", wire: "utf-8" },
    ];
    for (const [i, c] of combos.entries()) {
      const item = `PROBE-ENC-${i + 1}`;
      try {
        jar = {}; WIRE = c.wire;
        await call("Solution_Connect", { Username: USER, Password: PASS });
        if (c.setEncoding !== "none") await call("Solution_SetEncoding", { Encoding: c.setEncoding });
        const cat = await ensureCategory();
        await call("Product_CreateOrUpdate", { ProductData: { ItemNumber: item, Title: `${item} ${DANISH}`, LanguageISO: "DK", Price: 1, Status: true, Online: true, Stock: 100, CategoryId: Number(cat?.Id) } });
        await call("Product_SetFields", { Fields: "Id,ItemNumber,Title" });
        const back = (await call("Product_GetByItemNumber", { ItemNumber: item })).result;
        const got = String((Array.isArray(back) ? back[0] : back)?.Title ?? "");
        writes.push({ item, ...c, sent: DANISH, readBack: got, roundTripOk: got.includes(DANISH), productId: (Array.isArray(back) ? back[0] : back)?.Id });
      } catch (e) { writes.push({ item, ...c, error: e.message }); }
    }
    WIRE = "utf-8"; jar = {};
  }
  save("encoding", { modes, writes, header: ENC_EVIDENCE,
    verdict: good ? `READ: Solution_SetEncoding mode "${good.mode}" returns correct Danish text.`
      : "READ: no mode returns correct text directly; if repaired==='Genåbnet' the payload is double-encoded and the client must apply that repair to every string field.",
    writeVerdict: writes.length ? "WRITE: the combo whose readBack contains 'Ærø æøå ÆØÅ' AND looks correct in the shop admin is the one to use. Check all PROBE-ENC-* products in admin — readBack alone can hide a symmetric bug."
      : "WRITE: not run (needs --write).",
    interpret: "correct=true means the string matched 'Genåbnet' exactly. repaired shows the string reinterpreted as bytes and decoded as UTF-8 (standard mojibake repair)." });
  p("Encoding probe done — see data/probes/encoding.json, then eyeball the PROBE-ENC-* product titles in the shop admin.");
}
/** INDEPENDENT-CHANNEL check: a SOAP read-back can round-trip a symmetric encoding bug
 *  cleanly while the shop stores garbage. The storefront renders what the SHOP believes is
 *  stored, so it is the ground truth. Set DD_STOREFRONT_PRODUCT_URL in .env with an {id}
 *  placeholder, e.g. https://shop000000.webshop.dandomain.dk/heimdal/products/{id} */
async function probeStorefront() {
  const tpl = process.env.DD_STOREFRONT_PRODUCT_URL;
  if (!tpl || !tpl.includes("{id}")) throw new Error('Set DD_STOREFRONT_PRODUCT_URL in .env (must contain "{id}"), e.g. https://shop000000.webshop.dandomain.dk/heimdal/products/{id}');
  const enc = (() => { try { return JSON.parse(readFileSync(path.join(OUT, "encoding.json"), "utf8")); } catch { return null; } })();
  const targets = (enc?.writes ?? []).filter((w) => w.productId).map((w) => ({ id: w.productId, item: w.item, setEncoding: w.setEncoding, wire: w.wire, sent: w.sent }));
  if (!targets.length) throw new Error("No PROBE-ENC-* product ids found — run `encoding --write` first.");
  const DANISH = "Ærø æøå ÆØÅ";
  const rows = [];
  for (const t of targets) {
    const url = tpl.replace("{id}", t.id);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "user-agent": "shoplift-probe" } });
      const buf = new Uint8Array(await res.arrayBuffer());
      const asUtf8 = new TextDecoder("utf-8").decode(buf);
      const as1252 = new TextDecoder("windows-1252").decode(buf);
      const grab = (s) => (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      const tUtf8 = grab(asUtf8), t1252 = grab(as1252);
      rows.push({ ...t, url, httpStatus: res.status, charsetHeader: res.headers.get("content-type"),
        titleAsUtf8: tUtf8, titleAs1252: t1252,
        storedCorrectly: tUtf8.includes(DANISH) || t1252.includes(DANISH),
        showsQuestionMarks: /\?r\?|\?\?\?/.test(tUtf8 + t1252), showsMojibake: /Ã[-¿]/.test(tUtf8) });
    } catch (e) { rows.push({ ...t, url, error: e.message }); }
  }
  const winner = rows.find((r) => r.storedCorrectly && !r.showsMojibake && !r.showsQuestionMarks);
  save("storefront", { rows,
    verdict: winner ? `STORAGE CORRECT with setEncoding=${winner.setEncoding} + wire=${winner.wire} (${winner.item}). Use this combination in client.js.`
      : "No combination stored the Danish string correctly as rendered by the storefront — inspect data/probes/storefront.json rows.",
    interpret: "storedCorrectly = the storefront renders the exact sent string under either decoding. showsQuestionMarks = data was destroyed on write. showsMojibake = double-encoded on write." });
  p(winner ? `Storefront probe: WINNER -> setEncoding=${winner.setEncoding}, wire=${winner.wire}` : "Storefront probe done — no clean winner; see data/probes/storefront.json");
}
/** GraphQL probe — settles the export-architecture fork empirically. Research concluded
 *  "SOAP-first" because DanDomain's (undated) roadmap says products/variants are not shipped.
 *  With a Success-plan shop we can introspect instead of inferring. Also the ONLY channel
 *  that might expose gift-card balances (no SOAP ops exist for those). */
async function probeGraphql() {
  const id = process.env.DD_GQL_CLIENT_ID, secret = process.env.DD_GQL_CLIENT_SECRET;
  const tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;
  if (!id || !secret || !tenant) throw new Error("Set DD_GQL_CLIENT_ID / DD_GQL_CLIENT_SECRET / DD_GQL_TENANT in .env");
  const hosts = [`https://${tenant}.mywebshop.io`, `https://${tenant}.webshop.dandomain.dk`];
  let token = null, tokenHost = null, tokenErr = [];
  for (const h of hosts) {
    try {
      const res = await fetch(`${h}/auth/oauth/token`, { method: "POST", signal: AbortSignal.timeout(30000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: "" }) });
      const txt = await res.text();
      if (res.ok) { const j = JSON.parse(txt); token = j.access_token; tokenHost = h; tokenErr.push({ host: h, status: res.status, tokenType: j.token_type, expiresIn: j.expires_in }); break; }
      tokenErr.push({ host: h, status: res.status, body: txt.slice(0, 300) });
    } catch (e) { tokenErr.push({ host: h, error: e.message }); }
  }
  if (!token) { save("graphql", { tokenAttempts: tokenErr, verdict: "Could not obtain an OAuth token — see tokenAttempts." }); throw new Error("OAuth token request failed; see data/probes/graphql.json"); }

  const gql = async (endpoint, query) => {
    const res = await fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }) });
    const txt = await res.text();
    try { return { status: res.status, json: JSON.parse(txt) }; } catch { return { status: res.status, raw: txt.slice(0, 500) }; }
  };
  const INTROSPECT = "{__schema{queryType{fields{name}} mutationType{fields{name}}}}";
  const schemas = {};
  for (const [label, ep] of [["public", `${tokenHost}/api/graphql`], ["experimental", `${tokenHost}/api/graphql/experimental`]]) {
    const r = await gql(ep, INTROSPECT);
    const s = r.json?.data?.__schema;
    if (!s) { schemas[label] = { endpoint: ep, status: r.status, introspectionBlocked: true, response: r.json?.errors ?? r.raw }; continue; }
    const queries = (s.queryType?.fields ?? []).map((f) => f.name).sort();
    const mutations = (s.mutationType?.fields ?? []).map((f) => f.name).sort();
    const has = (re) => queries.filter((q) => re.test(q)).concat(mutations.filter((m) => re.test(m)));
    schemas[label] = { endpoint: ep, status: r.status, queryCount: queries.length, mutationCount: mutations.length, queries, mutations,
      keyEntities: { products: has(/^product/i), variants: has(/variant/i), orders: has(/^order/i), users: has(/^user|^customer/i),
        giftCards: has(/giftcard/i), redirects: has(/redirect/i), categories: has(/categor/i), languages: has(/language|sitelanguage/i) } };
  }
  const pub = schemas.public, exp = schemas.experimental;
  const productsAnywhere = [...(pub?.keyEntities?.products ?? []), ...(exp?.keyEntities?.products ?? [])];
  const giftAnywhere = [...(pub?.keyEntities?.giftCards ?? []), ...(exp?.keyEntities?.giftCards ?? [])];
  save("graphql", { tokenAttempts: tokenErr, tokenHost, schemas,
    verdict: `PRODUCTS via GraphQL: ${productsAnywhere.length ? "AVAILABLE -> " + productsAnywhere.slice(0, 8).join(", ") : "NOT AVAILABLE (SOAP-first design stands)"}. GIFT CARDS: ${giftAnywhere.length ? "AVAILABLE -> " + giftAnywhere.slice(0, 6).join(", ") : "not exposed"}.`,
    interpret: "Full query/mutation lists are in schemas.*.queries/mutations — this is the introspection the research phase could not obtain. If products ARE queryable, PLAN §D2 (SOAP-first) needs revisiting with Daniel before P1b." });
  p(`GraphQL probe done — products: ${productsAnywhere.length ? "AVAILABLE" : "not available"}; gift cards: ${giftAnywhere.length ? "available" : "not exposed"}. See data/probes/graphql.json`);
}
/** BYTE-LEVEL encoding truth. The storefront theme is JS-rendered so HTML scraping returns
 *  a placeholder; instead read each PROBE-ENC-* title back and decode the SAME bytes two
 *  ways. "Ærø" stored as latin1 is C6 72 F8; stored as UTF-8 it is C3 86 72 C3 B8; destroyed
 *  it is 3F ('?'). That distinguishes correct storage from a symmetric round-trip bug. */
async function probeEncBytes() {
  await connect(); // NB: connect() no longer calls Solution_SetEncoding (live fact: it corrupts)
  const enc = (() => { try { return JSON.parse(readFileSync(path.join(OUT, "encoding.json"), "utf8")); } catch { return null; } })();
  const items = (enc?.writes ?? []).map((w) => ({ item: w.item, setEncoding: w.setEncoding, wire: w.wire }));
  if (!items.length) throw new Error("Run `encoding --write` first.");
  const rows = [];
  for (const it of items) {
    await call("Product_SetFields", { Fields: "Id,ItemNumber,Title" });
    await call("Product_GetByItemNumber", { ItemNumber: it.item });
    const buf = LAST_BUF;
    const utf8 = new TextDecoder("utf-8").decode(buf), l1 = new TextDecoder("windows-1252").decode(buf);
    const grab = (s) => s.match(/<Title>([\s\S]*?)<\/Title>/)?.[1] ?? "";
    const tU = grab(utf8), tL = grab(l1);
    // locate the title bytes for a hex fingerprint of the first non-ASCII run
    const idx = utf8.indexOf(tU);
    const hex = idx >= 0 ? [...buf.slice(idx, idx + Math.min(tU.length + 6, 40))].map((b) => b.toString(16).padStart(2, "0")).join(" ") : null;
    rows.push({ ...it, titleDecodedUtf8: tU, titleDecodedLatin1: tL, hexHead: hex,
      storedLatin1: /\u00c6r\u00f8/.test(tL) && !/\u00c6r\u00f8/.test(tU),
      storedUtf8: /\u00c6r\u00f8/.test(tU),
      destroyed: /\?r\?/.test(tU) || /\?r\?/.test(tL) });
  }
  const good = rows.find((r) => (r.storedUtf8 || r.storedLatin1) && !r.destroyed);
  save("encbytes", { rows,
    verdict: good ? `WRITE with setEncoding=${good.setEncoding} + wire=${good.wire} stores Danish text intact (${good.storedLatin1 ? "as latin1 bytes" : "as UTF-8 bytes"}). Use it in client.js.`
      : "No combination stored Danish text intact — inspect rows/hexHead.",
    interpret: "storedLatin1: bytes decode correctly only as windows-1252 (native latin1 storage). storedUtf8: bytes decode correctly as UTF-8. destroyed: '?' substitution happened on write." });
  p(good ? `Byte probe: WINNER -> setEncoding=${good.setEncoding}, wire=${good.wire}` : "Byte probe: no clean winner — see data/probes/encbytes.json");
}
/** SHOP PROFILE — the shop's own settings answer most configuration questions, so a
 *  migration should READ them rather than ask the client. This is the prototype of the
 *  DanDomain doctor stage: generation guard + auto-configuration + feature census. */
async function probeProfile() {
  await connect();
  const one = (r) => Array.isArray(r) ? r[0] : r;
  const arr = (r) => (Array.isArray(r) ? r : [r]).filter(Boolean);
  const get = async (op, args) => { try { return (await call(op, args)).result; } catch (e) { return { _error: `${e.code}: ${e.message}` }; } };

  const webinfo = await get("Solution_GetWebinfo");
  const languages = arr(await get("Solution_GetLanguages"));
  const sites = arr(await get("Sites_GetAll"));
  const currencies = arr(await get("Currency_GetAll"));
  const vatGroups = arr(await get("VatGroup_GetAll"));
  const statuses = arr(await get("OrderStatusCode_GetAll"));
  const payments = arr(await get("Payment_GetAll"));
  const deliveries = arr(await get("Delivery_GetAll"));
  const countries = arr(await get("Product_GetDeliveryCountryAll"));
  const units = arr(await get("Product_GetUnitAll"));
  const userGroups = arr(await get("User_GetGroupAll"));

  // Module census: Solution_HasModule's vocabulary is undocumented — sweep candidates.
  const MODULE_CANDIDATES = ["newsletter", "giftcard", "giftcards", "blog", "news", "b2b", "customergroup",
    "usergroup", "multilanguage", "multisite", "variant", "variants", "discount", "productfields",
    "customfields", "stocklocation", "stocklocations", "packet", "bundle", "filesale", "download",
    "subscription", "seo", "redirect", "api", "graphql", "webhook", "review", "extrabuy", "additional"];
  const modules = {};
  for (const m of MODULE_CANDIDATES) {
    try { const r = await call("Solution_HasModule", { module: m }); modules[m] = String(r.result); }
    catch (e) { modules[m] = `ERR ${e.code}`; }
  }

  const primaryLang = languages.find((l) => String(l?.Primary) === "true") ?? languages[0] ?? null;
  const primaryCurrency = one(currencies);
  const vatInclusive = String(webinfo?.ProductPricesWithVat) === "true";
  const customStatuses = statuses.filter((s) => !["0","1","2","3","4","5","6","7","8","99","100"].includes(String(s?.Id)));

  // Everything a migration would otherwise have to ASK the merchant:
  const derivedConfig = {
    solutionId: webinfo?.SolutionId ?? null,
    generation: webinfo?.SolutionId ? "hostedshop (modern)" : "UNKNOWN — verify not classic WS8",
    vatBasis: vatInclusive ? "INCLUSIVE" : "EXCLUSIVE",
    vatBasisSource: "Solution_GetWebinfo.ProductPricesWithVat",
    storefrontVatDisplay: String(webinfo?.ShowProductPricesWithVat) === "true" ? "incl" : "excl",
    primaryLanguage: primaryLang?.LanguageISO ?? null,
    languageLayers: languages.map((l) => ({ iso: l?.LanguageISO, title: l?.Title, primary: String(l?.Primary) === "true", siteId: l?.SiteId })),
    multiLanguage: languages.length > 1,
    sites: sites.map((s) => ({ id: s?.Id, title: s?.Title, iso: s?.LanguageISO, type: s?.Type })),
    multiSite: sites.length > 1,
    currency: primaryCurrency?.Iso ?? null,
    currencyFormat: primaryCurrency ? { decimalSep: primaryCurrency.Decimal, thousandSep: primaryCurrency.Point, decimals: primaryCurrency.DecimalCount } : null,
    multiCurrency: currencies.length > 1,
    vatGroups: vatGroups.map((v) => ({ id: v?.Id, name: v?.Name, pct: v?.VatPercentage })),
    mixedVatRisk: vatGroups.filter((v) => Number(v?.VatPercentage) > 0).length > 1,
    countryIdForOrders: countries.map((c) => ({ id: c?.Id, iso: c?.Iso, primary: String(c?.Primary) === "true" })),
    orderStatuses: statuses.map((s) => ({ id: s?.Id, title: s?.Title })),
    customOrderStatuses: customStatuses.map((s) => ({ id: s?.Id, title: s?.Title })),
    customerGroups: userGroups.map((g) => ({ id: g?.Id, title: g?.Title ?? g?.Name })),
    b2bPricingInPlay: userGroups.length > 0,
    paymentMethods: payments.map((p) => ({ id: p?.Id, title: p?.Title, type: p?.Type, fee: p?.FixedFee })),
    deliveryMethods: deliveries.map((d) => ({ id: d?.Id, title: d?.Title, price: d?.Price, service: d?.ServiceType })),
    units: units.map((u) => ({ id: u?.Id, title: u?.Title ?? u?.Name })),
    modulesReporting: Object.entries(modules).filter(([, v]) => v === "true").map(([k]) => k),
  };
  save("profile", { webinfo, derivedConfig, modules, raw: { languages, sites, currencies, vatGroups, statuses, payments, deliveries, countries, units, userGroups },
    interpret: "derivedConfig is what a migration would otherwise have to ASK the merchant. Fold this into the DanDomain doctor stage: generation guard (solutionId present), auto-config (vatBasis/currency/languages), and a feature census that decides which warnings are even relevant for THIS shop." });
  p(`Profile: ${derivedConfig.solutionId} · VAT ${derivedConfig.vatBasis} · ${derivedConfig.currency} · ${derivedConfig.languageLayers.length} language layer(s) · ${derivedConfig.customerGroups.length} customer group(s) · ${derivedConfig.customOrderStatuses.length} custom status(es)`);
}
/** Deep GraphQL probe — closes P1 items (h) rename-redirect visibility, (i) gift-card balance
 *  fields, (n) invoices/kreditnota channel, plus blog shape and 429 semantics. */
export const BLOG_POSTS_PROBE_QUERY_NOTE =
  "blogPosts must use graphql.js buildQueryDocument / input-wrapped; never pagination:{limit,page}";
async function probeGqlDeep() {
  const id = process.env.DD_GQL_CLIENT_ID, secret = process.env.DD_GQL_CLIENT_SECRET;
  const tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;
  const host = `https://${tenant}.mywebshop.io`;
  const tr = await fetch(`${host}/auth/oauth/token`, { method: "POST", signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: "" }) });
  const tok = (await tr.json()).access_token;
  const gql = async (ep, query) => {
    const r = await fetch(`${host}${ep}`, { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ query }) });
    const t = await r.text();
    try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t.slice(0, 400) }; }
  };
  const typeFields = async (ep, name) => {
    const r = await gql(ep, `{__type(name:"${name}"){name kind fields{name type{name kind ofType{name kind}}}}}`);
    const t = r?.data?.__type;
    return t ? { name: t.name, fields: (t.fields ?? []).map((f) => `${f.name}:${f.type?.name ?? f.type?.ofType?.name ?? f.type?.kind}`) } : { name, error: r?.errors ?? r?.raw ?? "not found" };
  };
  const unwrapNamed = (t) => {
    const chain = [];
    let cur = t;
    while (cur) {
      chain.push({ name: cur.name ?? null, kind: cur.kind ?? null });
      cur = cur.ofType;
    }
    const named = chain.find((x) => x.name);
    return { chain, namedName: named?.name ?? null, namedKind: named?.kind ?? null };
  };
  const PUB = "/api/graphql", EXP = "/api/graphql/experimental";
  const out = {};
  // (i) gift cards — the ONLY channel for balances (no SOAP ops exist)
  out.giftCardType = await typeFields(PUB, "GiftCard");
  out.giftCardsQuery = await gql(PUB, "{giftCards(pagination:{limit:5,page:1}){data{__typename} pagination{total}}}");
  // (h) redirects — do renames leave recoverable history?
  out.redirectType = await typeFields(PUB, "Redirect");
  out.redirectsQuery = await gql(PUB, "{redirects(pagination:{limit:20,page:1}){data{__typename} pagination{total}}}");
  // (n) invoices — candidate kreditnota channel
  out.invoiceType = await typeFields(PUB, "Invoice");
  out.invoicesQuery = await gql(PUB, "{invoices(pagination:{limit:5,page:1}){data{__typename} pagination{total}}}");
  // orders + blog shapes (experimental)
  out.orderType = await typeFields(EXP, "Order");
  out.blogPostType = await typeFields(EXP, "BlogPost");
  // Registry: Convention A input-wrapped (BlogPostsInput). Convention B pagination:{limit,page}
  // is rejected by blogPosts — gqlshapes.json + graphql.js header. Do not send it.
  out.blogPostsQuery = await gql(
    EXP,
    buildQueryDocument("blogPosts", {
      selection: "__typename",
      limit: 5,
      page: 1,
    }),
  );
  out.blogMutations = await gql(
    EXP,
    "{ __schema { mutationType { fields { name } } } }",
  );
  out.blogPostCreatePresent = Boolean(
    (out.blogMutations?.data?.__schema?.mutationType?.fields || []).some((f) => f.name === "blogPostCreate"),
  );
  // Nested BlogPost.translations __type (Task 7). Top-level typeFields stops at
  // NON_NULL and never names the element type. Do not guess title/body/handle.
  const blogPostDeep = await gql(
    EXP,
    `{__type(name:"BlogPost"){name fields{name type{name kind ofType{name kind ofType{name kind ofType{name kind ofType{name kind}}}}}}}}`,
  );
  const translationsField = (blogPostDeep?.data?.__type?.fields ?? []).find((f) => f.name === "translations");
  out.blogPostTranslationsField = translationsField
    ? { ...unwrapNamed(translationsField.type), raw: translationsField.type }
    : { fault: blogPostDeep?.errors ?? blogPostDeep?.raw ?? "BlogPost.translations missing" };
  const trTypeName = out.blogPostTranslationsField?.namedName;
  out.blogPostTranslationType = trTypeName
    ? await typeFields(EXP, trTypeName)
    : { fault: "no named type on BlogPost.translations" };
  const pair = (f) => {
    const i = String(f).indexOf(":");
    return i < 0 ? [String(f), null] : [String(f).slice(0, i), String(f).slice(i + 1)];
  };
  const SCALAR_KINDS = new Set(["String", "Int", "ID", "Boolean", "Float", "DateTime", "URL", "HTML", "UnsignedInt"]);
  const trFields = (out.blogPostTranslationType?.fields ?? []).map(pair);
  const dataTypeName = trFields.find(([n]) => n === "data")?.[1];
  const langTypeName = trFields.find(([n]) => n === "language")?.[1];
  out.blogPostTranslationDataType = dataTypeName && dataTypeName !== "NON_NULL"
    ? await typeFields(EXP, dataTypeName)
    : { fault: "BlogPostTranslation.data type not named" };
  out.displayLanguageType = langTypeName && langTypeName !== "NON_NULL"
    ? await typeFields(EXP, langTypeName)
    : { fault: "BlogPostTranslation.language type not named" };
  const dataScalars = (out.blogPostTranslationDataType?.fields ?? [])
    .map(pair)
    .filter(([, t]) => t && SCALAR_KINDS.has(t))
    .map(([n]) => n);
  const langScalars = (out.displayLanguageType?.fields ?? [])
    .map(pair)
    .filter(([, t]) => t && SCALAR_KINDS.has(t))
    .map(([n]) => n);
  out.blogPostTranslationDataScalars = dataScalars;
  out.displayLanguageScalars = langScalars;
  out.blogPostsTranslationsTypename = await gql(
    EXP,
    buildQueryDocument("blogPosts", {
      selection: "id translations { __typename }",
      limit: 5,
      page: 1,
    }),
  );
  out.blogPostsTranslationsDataTypename = await gql(
    EXP,
    buildQueryDocument("blogPosts", {
      selection: "id translations { data { __typename } }",
      limit: 5,
      page: 1,
    }),
  );
  if (dataScalars.length) {
    const dataSel = dataScalars.join(" ");
    const langSel = langScalars.length ? ` language { ${langScalars.join(" ")} }` : "";
    out.blogPostsTranslationsData = await gql(
      EXP,
      buildQueryDocument("blogPosts", {
        selection: `id translations { data { ${dataSel} }${langSel} }`,
        limit: 5,
        page: 1,
      }),
    );
  } else {
    out.blogPostsTranslationsData = { fault: "zero scalar names on BlogPostTranslationData" };
  }
  // (k) rate-limit semantics: 12 rapid calls, capture any non-200 verbatim
  const burst = [];
  for (let i = 0; i < 12; i++) {
    const t0 = Date.now();
    const r = await fetch(`${host}${PUB}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ query: "{currencies{data{__typename}}}" }) });
    burst.push({ i, status: r.status, ms: Date.now() - t0, retryAfter: r.headers.get("retry-after"), rl: r.headers.get("x-ratelimit-remaining") });
    if (r.status !== 200) { burst.push({ note: "non-200 body", body: (await r.text()).slice(0, 300) }); break; }
  }
  out.burst = burst;
  save("gqldeep", { ...out,
    verdict: `GiftCard fields: ${out.giftCardType.fields ? out.giftCardType.fields.length : "n/a"}; Redirect rows: ${out.redirectsQuery?.data?.redirects?.pagination?.total ?? "?"}; Invoices: ${out.invoicesQuery?.data?.invoices?.pagination?.total ?? "?"}; BlogPosts: ${out.blogPostsQuery?.data?.blogPosts?.content?.pagination?.total ?? "?"}; burst non-200: ${burst.filter((b) => b.status && b.status !== 200).length}` });
  p("GraphQL deep probe done — see data/probes/gqldeep.json");
}
/** Query/payload SHAPES. The docs' `pagination:{limit,page}` argument is NOT universal —
 *  giftCards/redirects/blogPosts reject it while invoices accepts it. The client cannot be
 *  written from the docs; introspect args + payload fields per query. */
async function probeGqlShapes() {
  const id = process.env.DD_GQL_CLIENT_ID, secret = process.env.DD_GQL_CLIENT_SECRET;
  const tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;
  const host = `https://${tenant}.mywebshop.io`;
  const tr = await fetch(`${host}/auth/oauth/token`, { method: "POST", signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: "" }) });
  const tok = (await tr.json()).access_token;
  const gql = async (ep, query) => {
    const r = await fetch(`${host}${ep}`, { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ query }) });
    const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
  };
  const tname = (t) => t?.name ?? t?.ofType?.name ?? t?.ofType?.ofType?.name ?? t?.kind;
  const out = {};
  for (const [label, ep] of [["public", "/api/graphql"], ["experimental", "/api/graphql/experimental"]]) {
    const r = await gql(ep, "{__schema{queryType{fields{name args{name type{name kind ofType{name kind ofType{name}}}} type{name kind ofType{name}}}}}}");
    const fields = r?.data?.__schema?.queryType?.fields ?? [];
    out[label] = { queries: fields.map((f) => ({ name: f.name, returns: tname(f.type), args: (f.args ?? []).map((a) => `${a.name}:${tname(a.type)}`) })) };
    // payload shapes for the entities the migration reads
    const payloads = {};
    for (const q of ["giftCards", "redirects", "blogPosts", "orders", "users", "pages", "discounts", "productCategories", "invoices"]) {
      const f = fields.find((x) => x.name === q); if (!f) continue;
      const pt = tname(f.type);
      const pr = await gql(ep, `{__type(name:"${pt}"){name fields{name type{name kind ofType{name kind ofType{name}}}}}}`);
      payloads[q] = { payloadType: pt, fields: (pr?.data?.__type?.fields ?? []).map((x) => `${x.name}:${tname(x.type)}`) };
    }
    out[label].payloads = payloads;
  }
  // OrderInvoice is the kreditnota candidate (Invoice type does not exist)
  const oi = await gql("/api/graphql/experimental", '{__type(name:"OrderInvoice"){name fields{name type{name kind ofType{name}}}}}');
  out.orderInvoiceType = { fields: (oi?.data?.__type?.fields ?? []).map((x) => `${x.name}:${tname(x.type)}`) };
  const te = await gql("/api/graphql/experimental", '{__type(name:"OrderTransactionEvent"){name fields{name type{name kind ofType{name}}}}}');
  out.transactionEventType = { fields: (te?.data?.__type?.fields ?? []).map((x) => `${x.name}:${tname(x.type)}`) };
  save("gqlshapes", { ...out, interpret: "args per query tell the client how to paginate/filter each entity; payload fields tell it where the rows live. Written because the documented pagination shape is not universal." });
  p("GraphQL shapes probe done — see data/probes/gqlshapes.json");
}
/** DEEP write probe — closes P1 items (a) backdated transaction, (b) DateCreated honoured,
 *  (d) order number vs Id, (e) mixed-VAT order, (h) rename-redirect visibility via GraphQL,
 *  (g) storefront URL grammar. Creates PROBE-DEEP-* data on the scratch shop. */
async function probeDeep() {
  requireWrite();
  await connect();
  const L = await ensureVat25(await lookups());
  const cat = await ensureCategory();
  const out = {};

  // ---- (b) does the server honour a backdated DateCreated on upsert? ----
  const BACKDATE = "2019-01-05 10:00:00";
  await call("Product_CreateOrUpdate", { ProductData: { ItemNumber: "PROBE-DEEP-A", Title: "PROBE deep backdated", LanguageISO: "DK",
    Price: 100, Status: true, Online: true, Stock: 50, CategoryId: Number(cat?.Id), VatGroupId: Number(L.vat25?.Id), DateCreated: BACKDATE } });
  await call("Product_SetFields", { Fields: "Id,ItemNumber,Title,Price,DateCreated,DateUpdated,VatGroupId,Stock" });
  const pa = (await call("Product_GetByItemNumber", { ItemNumber: "PROBE-DEEP-A" })).result;
  const prodA = Array.isArray(pa) ? pa[0] : pa;
  out.dateCreated = { sent: BACKDATE, readBack: prodA?.DateCreated, honoured: String(prodA?.DateCreated ?? "").startsWith("2019-01-05") };

  // a 0% product for the mixed-VAT basket
  await call("Product_CreateOrUpdate", { ProductData: { ItemNumber: "PROBE-DEEP-B", Title: "PROBE deep zero vat", LanguageISO: "DK",
    Price: 50, Status: true, Online: true, Stock: 50, CategoryId: Number(cat?.Id), VatGroupId: Number(L.vat0?.Id) } });
  const pb = (await call("Product_GetByItemNumber", { ItemNumber: "PROBE-DEEP-B" })).result;
  const prodB = Array.isArray(pb) ? pb[0] : pb;

  const cust = { Firstname: "Probe", Lastname: "Deep", Company: "", Cvr: "", Ean: "", Address: "Testvej 9", Address2: "",
    Zip: "8000", City: "Aarhus", Country: "Denmark", CountryCode: L.dk?.Id, Phone: "", Email: "probe-deep@example.com" };
  const base = { CurrencyId: L.currencyId, PaymentId: L.paymentId, DeliveryId: L.deliveryId, LanguageISO: "DK" };

  // ---- (a)+(d) backdated PAID transaction, and what identifiers come back ----
  const mkOrder = async (label, data) => {
    try { const r = (await call("Order_Create", { OrderData: data })).result;
      return { label, ok: true, id: typeof r === "object" ? (r?.Order_CreateResult ?? JSON.stringify(r)) : r }; }
    catch (e) { const partial = orderIdFromLineErrors(e); return { label, ok: !!partial, id: partial, fault: `${e.code}: ${e.message}` }; }
  };
  // Transaction Amount units: we sent 100 and the server stored 1 -> test minor units (øre).
  const mkTx = (amount) => ({ OrderId: 0, PaymentId: L.paymentId, Status: 1, TransactionNumber: 987654, Cardtype: "probe",
    Amount: amount, Currency: L.currencyId, Errorcode: 0, Actioncode: 0, Date: BACKDATE });
  const minor = await mkOrder("tx-amount-minor-units", { ...base, ReferenceNumber: "SRC-TX-10000", OrderCustomer: cust,
    OrderLines: { item: [{ ProductId: Number(prodA?.Id), Amount: 1, Price: 100 }] }, OrderTransaction: mkTx(10000) });
  const paid = await mkOrder("backdated-paid", { ...base, ReferenceNumber: "SRC-2019-0042", OrderCustomer: cust,
    OrderLines: { item: [{ ProductId: Number(prodA?.Id), Amount: 1, Price: 100 }] },
    OrderTransaction: { OrderId: 0, PaymentId: L.paymentId, Status: 1, TransactionNumber: 987654, Cardtype: "probe",
      Amount: 100, Currency: L.currencyId, Errorcode: 0, Actioncode: 0, Date: BACKDATE } });
  // ---- (e) mixed-VAT basket: 25% + 0% on one order ----
  const mixed = await mkOrder("mixed-vat", { ...base, ReferenceNumber: "SRC-MIXED-VAT", OrderCustomer: cust,
    OrderLines: { item: [{ ProductId: Number(prodA?.Id), Amount: 1, Price: 100 }, { ProductId: Number(prodB?.Id), Amount: 1, Price: 50 }] } });

  await call("Order_SetFields", { Fields: "Id,InvoiceNumber,ReferenceNumber,Status,Total,Vat,DateDelivered,DateSent,DateUpdated,CurrencyId,Currency,Transactions,OrderLines" });
  const readOrder = async (id) => { try { return (await call("Order_GetById", { OrderId: Number(id) })).result; } catch (e) { return { _error: e.message }; } };
  out.backdatedPaid = { create: paid, order: paid.id ? await readOrder(paid.id) : null };
  const minorOrder = minor.id ? await readOrder(minor.id) : null;
  const txOf = (o) => { const t = o?.Transactions; return Array.isArray(t) ? t[0] : t; };
  out.txAmountUnits = { sent100: txOf(out.backdatedPaid.order)?.Amount, sent10000: txOf(minorOrder)?.Amount,
    verdict: String(txOf(minorOrder)?.Amount) === "100" ? "MINOR UNITS (øre): send amount*100"
      : String(txOf(out.backdatedPaid.order)?.Amount) === "100" ? "MAJOR UNITS (kroner): send as-is" : "UNCLEAR — inspect both" };
  out.mixedVat = { create: mixed, order: mixed.id ? await readOrder(mixed.id) : null };
  if (out.mixedVat.order) {
    const t = Number(out.mixedVat.order.Total), v = Number(out.mixedVat.order.Vat);
    out.mixedVat.reading = `Total=${t} (expect 150 if inclusive), Vat=${v} (25% of the 100-line incl-VAT = 20; a single order-level rate cannot express 25%+0%)`;
  }
  // ---- (d) number vs id: read the same order by number ----
  if (paid.id) { try { out.byNumber = (await call("Order_GetByNumber", { Start: Number(paid.id), End: Number(paid.id) })).result; }
    catch (e) { out.byNumber = { _error: `${e.code}: ${e.message}` }; } }

  // ---- (h) rename → does a redirect row appear? (GraphQL, correct Convention-A syntax) ----
  const gid = process.env.DD_GQL_CLIENT_ID, gsec = process.env.DD_GQL_CLIENT_SECRET, tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;
  try {
    const tr = await fetch(`https://${tenant}.mywebshop.io/auth/oauth/token`, { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: gid, client_secret: gsec, scope: "" }) });
    const tok = (await tr.json()).access_token;
    const q = async (query) => { const r = await fetch(`https://${tenant}.mywebshop.io/api/graphql`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ query }) });
      const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; } };
    const REDIR = "{redirects{content{data{id source target httpStatusCode isForced sourceHasWildcard wasCreatedManually createdAt} pagination{total}}}}";
    out.redirectsBefore = await q(REDIR);
    await call("Product_CreateOrUpdate", { ProductData: { ItemNumber: "PROBE-DEEP-A", Title: "PROBE deep backdated RENAMED", LanguageISO: "DK",
      CategoryId: Number(cat?.Id), SeoLink: "probe-deep-renamed-" + String(prodA?.Id) } });
    out.redirectsAfter = await q(REDIR);
    const before = out.redirectsBefore?.data?.redirects?.content?.pagination?.total ?? null;
    const after = out.redirectsAfter?.data?.redirects?.content?.pagination?.total ?? null;
    out.renameCreatesRedirect = (before !== null && after !== null) ? { before, after, created: after > before } : "inconclusive";
  } catch (e) { out.redirectsError = e.message; }

  // ---- (g) storefront URL grammar: which shape actually resolves? ----
  const sf = process.env.DD_STOREFRONT_BASE || `https://${tenant}.webshop.dandomain.dk`;
  const candidates = [`/heimdal/products/${prodA?.Id}`, `/shop/${cat?.Id}-probe-kategori/${prodA?.Id}-probe-deep-backdated/`,
    `/webshop/${cat?.Id}-probe-kategori/${prodA?.Id}-probe-deep-backdated/`, `/products/${prodA?.Id}`, `/produkt/${prodA?.Id}`];
  out.urlGrammar = [];
  for (const c of candidates) {
    try { const r = await fetch(sf + c, { signal: AbortSignal.timeout(20000), redirect: "manual" });
      out.urlGrammar.push({ path: c, status: r.status, location: r.headers.get("location") }); }
    catch (e) { out.urlGrammar.push({ path: c, error: e.message }); }
  }
  save("deep", { ...out, interpret: "dateCreated.honoured decides seeding fidelity for historic products; backdatedPaid.order.Transactions decides it for orders; mixedVat.reading shows how a single order-level Vat copes with two rates; renameCreatesRedirect answers whether URL history is recoverable; urlGrammar shows which storefront path shape resolves (status 200) on THIS theme." });
  p(`Deep probe: DateCreated honoured=${out.dateCreated.honoured} · rename→redirect=${JSON.stringify(out.renameCreatesRedirect)} · url 200s=${out.urlGrammar.filter((u) => u.status === 200).map((u) => u.path).join(", ") || "none"}`);
}
/** SOAP session lifetime — how long may the exporter idle between calls before the cookie
 *  session dies? Bounded test: DD_SESSION_IDLE_S (default 480s, under the MCP 600s ceiling). */
async function probeSession() {
  const idle = Number(process.env.DD_SESSION_IDLE_S || 480);
  await connect();
  const first = (await call("Solution_GetWebinfo")).result;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, idle * 1000));
  let survived, err = null, reconnected = null;
  try { const r = (await call("Solution_GetWebinfo")).result; survived = !!r?.SolutionId; }
  catch (e) { survived = false; err = `${e.code}: ${e.message}`;
    try { await connect(); const r2 = (await call("Solution_GetWebinfo")).result; reconnected = !!r2?.SolutionId; } catch (e2) { reconnected = `failed: ${e2.message}`; } }
  save("session", { idleSeconds: idle, actualIdleS: Math.round((Date.now() - t0) / 1000), firstOk: !!first?.SolutionId,
    survivedIdle: survived, faultAfterIdle: err, reconnectWorked: reconnected,
    verdict: survived ? `Session survives at least ${idle}s idle.` : `Session died after ~${idle}s idle (${err}); reconnect ${reconnected === true ? "works" : "FAILED"}.`,
    interpret: "If the session survives, the exporter may idle safely up to this bound. Either way the client rule stands: treat an AUTH fault as reconnect-once-and-replay (idempotent reads only)." });
  p(`Session probe: idle ${idle}s -> survived=${survived}${err ? " (" + err + ")" : ""}`);
}
/** Kreditnota probe — closes item (n). A credit note is created in the ADMIN ("opret
 *  kreditnota"), which duplicates the order into a new document. Reads parent + credit note
 *  through BOTH transports to establish numbering, status and the origin linkage the
 *  transform needs to fold credit notes into Shopify refunds.
 *  Env: DD_CREDIT_ORDER (default 17), DD_PARENT_ORDER (default 16). */
async function probeKreditnota() {
  const credit = Number(process.env.DD_CREDIT_ORDER || 17), parent = Number(process.env.DD_PARENT_ORDER || 16);
  await connect();
  const FIELDS = "Id,InvoiceNumber,ReferenceNumber,Status,Total,Vat,Origin,CustomerComment,OrderComment,DateDelivered,DateSent,DateUpdated,CurrencyId,Currency,OrderLines,Transactions";
  await call("Order_SetFields", { Fields: FIELDS });
  const soap = {};
  for (const [k, id] of [["parent", parent], ["credit", credit]]) {
    try { soap[k] = (await call("Order_GetById", { OrderId: id })).result; } catch (e) { soap[k] = { _error: `${e.code}: ${e.message}` }; }
  }
  // line detail: are credit-note lines negative, or same-sign with a status marker?
  try { await call("Order_SetOrderLineFields", { Fields: "Id,ProductId,Title,Amount,Price,Vat,Status,ItemNumber" }); } catch { /* op may not exist */ }
  const lines = {};
  for (const [k, id] of [["parent", parent], ["credit", credit]]) {
    try { lines[k] = (await call("Order_GetLines", { OrderId: id })).result; } catch (e) { lines[k] = { _error: `${e.code}: ${e.message}` }; }
  }
  // GraphQL view of the same pair
  let gql = null;
  try {
    const tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;
    const tr = await fetch(`https://${tenant}.mywebshop.io/auth/oauth/token`, { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.DD_GQL_CLIENT_ID, client_secret: process.env.DD_GQL_CLIENT_SECRET, scope: "" }) });
    const tok = (await tr.json()).access_token;
    const q = async (query) => { const r = await fetch(`https://${tenant}.mywebshop.io/api/graphql`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ query }) });
      const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 400) }; } };
    const F = "{id origin total subTotal isPaid createdAt status{__typename} invoice{id createdAt isPaid}}";
    gql = { parent: await q(`{orderById(id:${parent})${F}}`), credit: await q(`{orderById(id:${credit})${F}}`) };
  } catch (e) { gql = { error: e.message }; }

  const p_ = soap.parent, c_ = soap.credit;
  save("kreditnota", { parentId: parent, creditId: credit, soap, lines, gql,
    findings: {
      sharedNumberSequence: Number(c_?.Id) === Number(p_?.Id) + 1 ? "YES — credit note took the next order id" : `id ${c_?.Id} vs parent ${p_?.Id}`,
      creditStatus: c_?.Status, parentStatus: p_?.Status,
      statusIsKreditnota: String(c_?.Status) === "100",
      creditOrigin: c_?.Origin, parentOrigin: p_?.Origin,
      originLinksToParent: String(c_?.Origin ?? "").includes(String(parent)),
      creditTotal: c_?.Total, parentTotal: p_?.Total,
      totalSign: Number(c_?.Total) < 0 ? "NEGATIVE (credit expressed as negative total)" : "positive/zero — sign is NOT how the credit is expressed",
      invoiceNumbers: { parent: p_?.InvoiceNumber, credit: c_?.InvoiceNumber },
    },
    interpret: "The transform must partition orders: real orders vs credit notes (status 100), fold each credit note into its parent as a Shopify refund via origin. These fields tell it how to find the parent and how much to refund." });
  p(`Kreditnota: credit ${credit} status=${c_?.Status} origin=${JSON.stringify(c_?.Origin)} total=${c_?.Total} (parent ${parent} status=${p_?.Status} total=${p_?.Total})`);
}
/** REDO-1 — VAT GATE, done properly. The previous probe supplied its own line Price, so the
 *  order Total was just the sum of our own input and proved nothing. Create the order WITHOUT
 *  a line Price so the SERVER prices it from the product, then read Total. */
async function probeVatServer() {
  requireWrite(); await connect();
  const L = await ensureVat25(await lookups());
  const cat = await ensureCategory();
  const mk = async (item, price, vatId, title) => {
    const r = await tryCall("Product_CreateOrUpdate", { ProductData: { ItemNumber: item, Title: title, LanguageISO: "DK",
      Price: price, Status: true, Online: true, Stock: 99, CategoryId: Number(cat?.Id), VatGroupId: Number(vatId) } });
    const F = "Id,ItemNumber,Title,Price,VatGroupId,Stock,Online,Status";
    await tryCall("Product_SetFields", { Fields: F });
    const back = await tryCall("Product_GetByItemNumber", { ItemNumber: item });
    return { create: r.ok, product: Array.isArray(back.result) ? back.result[0] : back.result, audit: fieldAudit(F, back.result) };
  };
  const p25 = await mk("PROBE-VS-25", 100, L.vat25?.Id, "PROBE server-priced 25pct at 100");
  const p0  = await mk("PROBE-VS-00", 100, L.vat0?.Id, "PROBE server-priced 0pct at 100");
  const cust = { Firstname: "Probe", Lastname: "Vs", Company: "", Cvr: "", Ean: "", Address: "Testvej 3", Address2: "",
    Zip: "8000", City: "Aarhus", Country: "Denmark", CountryCode: L.dk?.Id, Phone: "", Email: "probe-vs@example.com" };
  const base = { CurrencyId: L.currencyId, PaymentId: L.paymentId, DeliveryId: L.deliveryId, LanguageISO: "DK" };
  const ORDER_F = "Id,InvoiceNumber,ReferenceNumber,Status,Total,Vat,OrderLines,Delivery,Payment,Customer,DiscountCodes";
  const LINE_F = wsdlType("OrderLine").join(",") || "Id,ProductId,ProductTitle,Amount,Price,PriceRounded,VatRate,Discount";
  const place = async (label, lines) => {
    const r = await tryCall("Order_Create", { OrderData: { ...base, ReferenceNumber: label, OrderCustomer: cust, OrderLines: { item: lines } } });
    const id = r.ok ? (typeof r.result === "object" ? r.result?.Order_CreateResult : r.result) : orderIdFromLineErrors({ message: r.message });
    if (!id) return { label, created: false, fault: r.message };
    await tryCall("Order_SetFields", { Fields: ORDER_F });
    const o = await tryCall("Order_GetById", { OrderId: Number(id) });
    await tryCall("Order_SetOrderLineFields", { Fields: LINE_F });
    const lr = await tryCall("Order_GetLines", { OrderId: Number(id) });
    return { label, created: true, id, order: o.result, orderAudit: fieldAudit(ORDER_F, o.result),
      lines: lr.result, lineAudit: fieldAudit(LINE_F, lr.result) };
  };
  // THE decisive case: no Price on the line — the server must price it.
  const serverPriced = await place("VS-SERVER-PRICED", [{ ProductId: Number(p25.product?.Id), Amount: 1 }]);
  const clientPriced = await place("VS-CLIENT-PRICED", [{ ProductId: Number(p25.product?.Id), Amount: 1, Price: 100 }]);
  const mixed = await place("VS-MIXED-SERVER", [{ ProductId: Number(p25.product?.Id), Amount: 1 }, { ProductId: Number(p0.product?.Id), Amount: 1 }]);
  const t = Number(serverPriced.order?.Total);
  save("vatserver", { products: { p25, p0 }, serverPriced, clientPriced, mixed, faults: FAULTS,
    verdict: !serverPriced.created ? `Server-priced order could not be created: ${serverPriced.fault}`
      : Math.abs(t - 100) < 0.01 ? "INCLUSIVE — server priced a 25% product entered at 100 as Total 100"
      : Math.abs(t - 125) < 0.01 ? "EXCLUSIVE — server added 25% on top (Total 125)"
      : `UNRESOLVED — server-priced Total = ${t}; delivery/fees may be included. Inspect .order and .lines`,
    interpret: "This supersedes F18. The line carries NO Price, so Total and the per-line VatRate come from the server. Also carries the first real order-line read (correct field names from the WSDL) and a field-set truncation audit." });
  p(`VAT (server-priced): Total=${t} -> ${!serverPriced.created ? "NOT CREATED" : Math.abs(t - 100) < 0.01 ? "INCLUSIVE" : Math.abs(t - 125) < 0.01 ? "EXCLUSIVE" : "UNRESOLVED"} | faults=${FAULTS.length}`);
}

/** REDO-2 — ARCHITECTURE. Can Product_SetFields inline nested arrays? Order_SetFields inlines
 *  Transactions/Currency. If products inline too, the export is ~N calls, not 8N. */
async function probeNested() {
  await connect();
  const SCALARS = "Id,ItemNumber,Title,Price";
  // NB "Files" is NOT a valid field name; one bad name faults the WHOLE SetFields call and the
  // session silently keeps the PREVIOUS field set (no error on the subsequent read).
  const NESTED = "Id,ItemNumber,Title,Price,Variants,Pictures,CustomData,Discounts,Tags,SecondaryCategories,StockLocations,VariantTypes";
  const out = {};
  const a = await tryCall("Product_SetFields", { Fields: SCALARS });
  const t0 = Date.now();
  const flat = await tryCall("Product_GetAllWithLimit", { Start: 0, Length: 50 });
  out.scalar = { setOk: a.ok, ms: Date.now() - t0, rows: Array.isArray(flat.result) ? flat.result.length : 0,
    bytes: JSON.stringify(flat.result ?? "").length, audit: fieldAudit(SCALARS, flat.result) };
  const b = await tryCall("Product_SetFields", { Fields: NESTED });
  const t1 = Date.now();
  const rich = await tryCall("Product_GetAllWithLimit", { Start: 0, Length: 50 });
  out.nested = { setOk: b.ok, setFault: b.ok ? null : `${b.code}: ${b.message}`, ms: Date.now() - t1,
    rows: Array.isArray(rich.result) ? rich.result.length : 0, bytes: JSON.stringify(rich.result ?? "").length,
    audit: fieldAudit(NESTED, rich.result), sample: Array.isArray(rich.result) ? rich.result[0] : rich.result };
  // per-field probe: which nested names are accepted at all?
  out.perField = {};
  for (const f of ["Variants", "Pictures", "CustomData", "Discounts", "Tags", "SecondaryCategories", "StockLocations", "VariantTypes", "Files", "ProductFiles", "DeliveryTimes"]) {
    const r = await tryCall("Product_SetFields", { Fields: `Id,${f}` });
    out.perField[f] = r.ok ? "accepted" : `${r.code}: ${String(r.message).slice(0, 90)}`;
  }
  const inl = out.nested.audit.returned.filter((k) => ["Variants", "Pictures", "CustomData", "Discounts", "Tags", "SecondaryCategories", "StockLocations", "VariantTypes"].includes(k));
  out.poisonedSetFields = "One invalid field name faults the ENTIRE Product_SetFields call; the session then keeps the PREVIOUS field set and the next read succeeds with the wrong shape and no error. Validate every name before sending.";
  save("nested", { ...out, faults: FAULTS,
    verdict: inl.length ? `INLINING WORKS for: ${inl.join(", ")} — export is a batch loop, NOT an N+1 crawler.`
      : "NO inlining observed — the exporter must make per-product sub-calls (8 ops/product). Budget accordingly and design resumable chunking.",
    interpret: "Decides the exporter's architecture before a line of client code. NOSUCHPARAM on a nested name means the field is not selectable; acceptance plus a populated array in .sample means it inlines." });
  p(`Nested inlining: ${inl.length ? "YES -> " + inl.join(",") : "NO"} | perField=${JSON.stringify(out.perField)}`);
}

/** REDO-3 — MEDIA. F35 claimed "export is unaffected" without ever calling Product_GetPictures.
 *  Blast radius if wrong: every image in the catalogue. */
async function probeMedia() {
  await connect();
  // NB: read pictures by EXPLICIT id. Deriving ids from a nested read is unsafe until the
  // client has a real XML parser — the naive one collapses repeated elements and yields
  // arrays where a scalar id is expected, which the server rejects as an encoding violation.
  await tryCall("Product_SetFields", { Fields: "Id,ItemNumber,Title" });
  const ids = (process.env.DD_MEDIA_IDS || "1,2,3,4,5,6").split(",").map((x) => Number(x.trim())).filter(Boolean);
  const out = { probedProducts: ids.length, pictures: [], urlTests: [] };
  for (const id of ids) {
    const pics = await tryCall("Product_GetPictures", { ProductId: id });
    if (pics.ok && pics.result) out.pictures.push({ productId: id, raw: pics.result });
    else if (!pics.ok) out.pictures.push({ productId: id, fault: `${pics.code}: ${pics.message}` });
  }
  const names = out.pictures.flatMap((p) => (Array.isArray(p.raw) ? p.raw : [p.raw]).filter(Boolean).map((x) => x?.FileName)).filter(Boolean);
  out.fileNames = names;
  const tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;
  const bases = [`https://${tenant}.webshop.dandomain.dk/images/`, `https://${tenant}.webshop.dandomain.dk/`,
    `https://${tenant}.webshop.dandomain.dk/shop/files/`, `https://sw${String(tenant).replace(/\D/g, "")}.sfstatic.io/upload_dir/pics/`];
  for (const n of names.slice(0, 2)) for (const b of bases) {
    try { const r = await fetch(b + n, { method: "GET", signal: AbortSignal.timeout(15000), redirect: "manual" });
      out.urlTests.push({ url: b + n, status: r.status, type: r.headers.get("content-type") }); }
    catch (e) { out.urlTests.push({ url: b + n, error: e.message }); }
  }
  const hit = out.urlTests.find((u) => u.status === 200 && String(u.type).startsWith("image/"));
  save("media", { ...out, faults: FAULTS,
    verdict: !names.length ? "NO product images exist on this shop — F35's export claim remains UNVERIFIED and must be re-probed on a shop with images."
      : hit ? `Resolvable: ${hit.url} (${hit.type}) — Shopify can fetch by URL.`
      : "FileNames exist but NONE of the candidate URL bases resolved to an image — media export is BROKEN until the real base is found.",
    interpret: "Shopify fetches media server-side from originalSource. A wrong base produces zero images across the catalogue with a clean-looking import." });
  p(`Media: ${names.length} filenames, ${out.urlTests.filter((u) => u.status === 200).length} URL 200s -> ${hit ? "RESOLVABLE" : names.length ? "UNRESOLVED" : "NO IMAGES ON SHOP"}`);
}
async function probeLimits() {
  await connect();
  await call("Product_SetFields", { Fields: "Id,ItemNumber" });
  const sweep = [];
  for (const len of [10, 100, 250, 500, 1000, 2500]) {
    try { const r = await call("Product_GetAllWithLimit", { Start: 0, Length: len }, { timeoutMs: 45000 });
      sweep.push({ length: len, ok: true, ms: r.ms, returned: Array.isArray(r.result) ? r.result.length : typeof r.result }); }
    catch (e) { sweep.push({ length: len, ok: false, code: e.code, message: e.message }); break; }
  }
  const burst = [];
  for (let i = 0; i < 20; i++) { const t0 = Date.now(); try { await call("Solution_GetWebinfo"); burst.push(Date.now() - t0); } catch (e) { burst.push(`ERR:${e.code}`); break; } }
  save("limits", { pageSweep: sweep, burst20_ms: burst, interpret: "First failing page size = chunk ceiling; rising/failing burst latencies = server throttle evidence (docs document none for SOAP)." });
  p("Limits probe done.");
}

// ---------- R10 — hand-rolled FTPS over node:tls (ZERO dependencies, invariant #6) ----------
// Spec lives in PLAYBOOK-dandomain.md R10. Everything here is a HYPOTHESIS until the
// transcript in data/probes/ftp.json says otherwise — report the recorded result.
//
// Control channel is ASCII/latin1 line protocol. Replies are `NNN text\r\n`, or multi-line
// `NNN-first\r\n ...\r\nNNN last\r\n`. We never guess: every command and reply is transcribed
// (PASS redacted) so a wrong assumption is visible in the artifact instead of inferred.

/** Reply reader bound to one socket. Detach before a TLS upgrade — the plain socket's
 *  'data' handler would otherwise eat the handshake bytes. */
function ftpReplyReader(sock) {
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
  };
}
const sockOnce = (sock, ev, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${ev} timeout after ${ms}ms`)), ms);
  const ok = (v) => { clearTimeout(t); sock.removeListener("error", bad); res(v); };
  const bad = (e) => { clearTimeout(t); sock.removeListener(ev, ok); rej(e); };
  sock.once(ev, ok); sock.once("error", bad);
});
const tlsInfo = (s) => ({
  protocol: s.getProtocol?.() ?? null, cipher: s.getCipher?.()?.name ?? null,
  authorized: s.authorized ?? null, authorizationError: String(s.authorizationError ?? "") || null,
  peerCN: s.getPeerCertificate?.()?.subject?.CN ?? null, peerIssuerCN: s.getPeerCertificate?.()?.issuer?.CN ?? null,
  altNames: s.getPeerCertificate?.()?.subjectaltname ?? null,
});

/** One FTPS session. `mode` is "explicit" (AUTH TLS on 21) or "implicit" (TLS from byte 0 on 990). */
class FtpsSession {
  constructor(host, mode, port) { this.host = host; this.mode = mode; this.port = port; this.transcript = []; this.pasv = []; this.prot = false; }
  async cmd(line, timeoutMs = 20000) {
    const shown = /^(PASS|ACCT)\s/i.test(line) ? line.replace(/\s.*$/, " ****") : line;
    this.transcript.push({ ">": shown });
    this.sock.write(line + "\r\n", "latin1");
    const r = await this.rdr.next(timeoutMs);
    this.transcript.push({ "<": r.code, text: r.text.slice(0, 500) });
    return r;
  }
  async expect(line, codes, timeoutMs) {
    const r = await this.cmd(line, timeoutMs);
    if (!codes.includes(r.code)) { const e = new Error(`${line.split(" ")[0]} -> ${r.code} ${r.text.slice(0, 200)}`); e.reply = r; throw e; }
    return r;
  }
  /** PASV + TCP data socket, still in cleartext. R10: reuse the CONTROL host, not the
   *  advertised IP (NAT). The TLS upgrade is deliberately NOT done here — see secureData(). */
  async dataConnect(timeoutMs = 20000) {
    const r = await this.expect("PASV", [227], timeoutMs);
    const m = r.text.match(/(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (!m) throw new Error("unparseable PASV reply: " + r.text);
    const advertised = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
    const port = Number(m[5]) * 256 + Number(m[6]);
    const controlIp = this.sock.remoteAddress?.replace(/^::ffff:/, "") ?? null;
    this.pasv.push({ advertised, controlIp, usedHost: this.host, port, advertisedDifferedFromControl: advertised !== controlIp });
    const plain = net.connect({ host: this.host, port });
    await sockOnce(plain, "connect", timeoutMs);
    return plain;
  }
  /** LIVE FACT 2026-08-15 (corrects R10): ProFTPD does NOT begin the data-channel TLS
   *  handshake until the transfer command has been accepted with a 1xx. Handshaking right
   *  after the TCP connect — which R10's spec implied — hangs until the timeout.
   *  So: connect -> send command -> read 150 -> THEN upgrade. This order is also safe against
   *  servers that handshake immediately, because the TLS client speaks first either way. */
  async secureData(plain, timeoutMs = 20000) {
    if (!this.prot) return plain;
    // Many servers (vsftpd require_ssl_reuse=YES, ProFTPD's default TLSOptions) demand the
    // CONTROL session be resumed on the data socket. The ticket can arrive just AFTER
    // secureConnect, so prefer the one captured from the 'session' event; getSession() alone
    // can be undefined and resumption then fails silently — which looks like a refused channel.
    const sessionTicket = this.tlsSession ?? this.sock.getSession?.();
    const d = tls.connect({ socket: plain, servername: this.host, rejectUnauthorized: false, session: sessionTicket });
    await sockOnce(d, "secureConnect", timeoutMs);
    this.dataTls = this.dataTls ?? { ...tlsInfo(d), sessionReused: d.isSessionReused?.() ?? null, ticketAvailable: Boolean(sessionTicket) };
    return d;
  }
  async collect(sock, maxBytes = 16 * 1024 * 1024, timeoutMs = 60000) {
    const chunks = []; let n = 0;
    await new Promise((res, rej) => {
      const t = setTimeout(() => { sock.destroy(); rej(new Error("data-channel read timeout")); }, timeoutMs);
      const done = () => { clearTimeout(t); res(); };
      sock.on("data", (c) => { n += c.length; if (n <= maxBytes) chunks.push(Buffer.from(c)); });
      sock.on("end", done); sock.on("close", done);
      sock.on("error", (e) => { clearTimeout(t); rej(e); });
    });
    return { buf: Buffer.concat(chunks), bytes: n, truncated: n > maxBytes };
  }
  /** Data-transfer command: PASV -> TCP connect -> send cmd -> 1xx -> TLS upgrade -> drain -> 2xx. */
  async xferIn(command) {
    const plain = await this.dataConnect();
    let open;
    try { open = await this.expect(command, [125, 150]); }
    catch (e) { plain.destroy(); throw e; }
    let d;
    try { d = await this.secureData(plain); }
    catch (e) { plain.destroy(); e.message = `data-channel TLS after ${open.code}: ${e.message}`; throw e; }
    const got = await this.collect(d);
    const fin = await this.rdr.next(30000);
    this.transcript.push({ "<": fin.code, text: fin.text.slice(0, 200) });
    return { openCode: open.code, finCode: fin.code, ...got };
  }
  async xferOut(command, payload) {
    const plain = await this.dataConnect();
    let open;
    try { open = await this.expect(command, [125, 150]); }
    catch (e) { plain.destroy(); throw e; }
    let d;
    try { d = await this.secureData(plain); }
    catch (e) { plain.destroy(); e.message = `data-channel TLS after ${open.code}: ${e.message}`; throw e; }
    await new Promise((res, rej) => { d.end(payload, (e) => (e ? rej(e) : res())); });
    const fin = await this.rdr.next(30000);
    this.transcript.push({ "<": fin.code, text: fin.text.slice(0, 200) });
    return { openCode: open.code, finCode: fin.code, sentBytes: payload.length };
  }
  quit() { try { this.sock.write("QUIT\r\n"); } catch { } try { this.sock.destroy(); } catch { } }
}

/** Bring up one flavour. Returns a live session or throws with the transcript attached.
 *  `port` defaults to the flavour's standard port; the offline FTPS mock overrides it. */
async function ftpsConnect({ host, user, pass, mode, port, timeoutMs = 20000 }) {
  port = port || (mode === "implicit" ? 990 : 21);
  const s = new FtpsSession(host, mode, port);
  if (mode === "implicit") {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
    s.port = port;
    try { await sockOnce(sock, "secureConnect", timeoutMs); }
    catch (e) { sock.destroy(); e.transcript = s.transcript; e.stage = "tls-connect"; throw e; }
    s.sock = sock; s.rdr = ftpReplyReader(sock); s.controlTls = tlsInfo(sock);
    sock.on("session", (t) => { s.tlsSession = t; });
    const greet = await s.rdr.next(timeoutMs);
    s.transcript.push({ "<": greet.code, text: greet.text.slice(0, 300) });
    if (greet.code !== 220) { s.quit(); const e = new Error(`implicit greeting ${greet.code}`); e.transcript = s.transcript; throw e; }
  } else {
    const plain = net.connect({ host, port });
    try { await sockOnce(plain, "connect", timeoutMs); }
    catch (e) { plain.destroy(); e.transcript = s.transcript; e.stage = "tcp-connect"; throw e; }
    s.sock = plain; s.rdr = ftpReplyReader(plain);
    const greet = await s.rdr.next(timeoutMs);
    s.transcript.push({ "<": greet.code, text: greet.text.slice(0, 300) });
    if (greet.code !== 220) { s.quit(); const e = new Error(`plain greeting ${greet.code}`); e.transcript = s.transcript; throw e; }
    let auth = await s.cmd("AUTH TLS", timeoutMs);
    s.authTlsReply = auth.code;            // record it ALWAYS — set only on the failure path, this
    s.authSslFallbackUsed = false;         // read back as null on every successful run (dead probe)
    if (auth.code !== 234) { s.authSslFallbackUsed = true; auth = await s.cmd("AUTH SSL", timeoutMs); }
    if (auth.code !== 234) { s.quit(); const e = new Error(`AUTH TLS/SSL refused (${auth.code} ${auth.text.slice(0, 120)})`); e.transcript = s.transcript; throw e; }
    const leftover = s.rdr.detach();
    s.leftoverBeforeUpgrade = leftover.length; // must be 0; anything else means we dropped bytes
    const sec = tls.connect({ socket: plain, servername: host, rejectUnauthorized: false });
    try { await sockOnce(sec, "secureConnect", timeoutMs); }
    catch (e) { try { plain.destroy(); } catch { } e.transcript = s.transcript; e.stage = "tls-upgrade"; throw e; }
    s.sock = sec; s.rdr = ftpReplyReader(sec); s.controlTls = tlsInfo(sec);
    sec.on("session", (t) => { s.tlsSession = t; });
  }
  await s.expect(`USER ${user}`, [230, 331], timeoutMs);
  const pw = await s.cmd(`PASS ${pass}`, timeoutMs);
  if (![230, 202].includes(pw.code)) { s.quit(); const e = new Error(`login refused (${pw.code} ${pw.text.slice(0, 160)})`); e.transcript = s.transcript; throw e; }
  // R10 order: PBSZ 0 then PROT P, then binary. Record refusals instead of assuming success.
  const pbsz = await s.cmd("PBSZ 0", timeoutMs); s.pbsz = pbsz.code;
  const prot = await s.cmd("PROT P", timeoutMs); s.protReply = prot.code; s.prot = prot.code === 200;
  const type = await s.cmd("TYPE I", timeoutMs); s.typeI = type.code;
  return s;
}

/** Tolerant LIST parser: Unix (`drwxr-xr-x 2 u g 4096 Aug 15 19:00 name`) and DOS
 *  (`08-15-26  07:00PM       <DIR>          name`). Unknown lines are kept as raw. */
function parseList(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    let m = line.match(/^([dl-])[rwxstST-]{9}[.+]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(?:\w{3}\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2}))\s+(.+)$/);
    if (m) { out.push({ type: m[1] === "d" ? "dir" : m[1] === "l" ? "link" : "file", size: Number(m[2]), name: m[3].replace(/ -> .*$/, "").trim(), raw: line }); continue; }
    m = line.match(/^\d{2}-\d{2}-\d{2,4}\s+\d{2}:\d{2}(?:AM|PM)?\s+(<DIR>|\d+)\s+(.+)$/i);
    if (m) { out.push({ type: m[1].toUpperCase() === "<DIR>" ? "dir" : "file", size: m[1] === "<DIR>" ? null : Number(m[1]), name: m[2].trim(), raw: line }); continue; }
    out.push({ type: "unparsed", name: null, raw: line });
  }
  return out;
}

/** R10 LIVE TEST — the FTPS transport, before any of it becomes client.js.
 *  Read-only by default: connect, FEAT, walk the archive, RETR one image.
 *  With --write it additionally proves STOR (the seeding half of F35) and cleans up. */
async function probeFtp() {
  const host = process.env.DD_FTP_HOST, user = process.env.DD_FTP_USER, pass = process.env.DD_FTP_PASSWORD;
  const out = { host: host ?? null, credentialsPresent: Boolean(host && user && pass), attempts: [], flavour: null };
  if (!out.credentialsPresent) {
    save("ftp", { ...out, verdict: "NOT RUN — DD_FTP_HOST / DD_FTP_USER / DD_FTP_PASSWORD missing from .env.",
      interpret: "R10 is a specification until this probe records a transcript. Absent credentials, nothing is proven either way." });
    p("FTP: credentials missing from .env — recorded as NOT RUN.");
    return;
  }
  // R10 says explicit-on-21 FIRST, implicit-on-990 second. Record BOTH outcomes either way.
  let sess = null;
  const portOverride = Number(process.env.DD_FTP_PORT) || 0;
  for (const mode of ["explicit", "implicit"]) {
    if (sess) { out.attempts.push({ mode, skipped: "a previous flavour already connected" }); continue; }
    const t0 = Date.now();
    try {
      const s = await ftpsConnect({ host, user, pass, mode, port: mode === "explicit" ? portOverride : 0 });
      out.attempts.push({ mode, port: s.port, ok: true, ms: Date.now() - t0, controlTls: s.controlTls,
        authTlsFirstReply: s.authTlsReply ?? null, authSslFallbackUsed: s.authSslFallbackUsed ?? null,
        leftoverBeforeUpgrade: s.leftoverBeforeUpgrade ?? null,
        pbszReply: s.pbsz, protReply: s.protReply, protEncrypted: s.prot, typeIReply: s.typeI });
      sess = s;
    } catch (e) {
      out.attempts.push({ mode, port: mode === "implicit" ? 990 : portOverride || 21, ok: false, ms: Date.now() - t0,
        stage: e.stage ?? "command", error: e.message, transcript: e.transcript ?? null });
      FAULTS.push({ ok: false, op: `FTPS ${mode}`, code: e.stage ?? "?", message: e.message });
    }
  }
  if (!sess) {
    save("ftp", { ...out, faults: FAULTS,
      verdict: "NEITHER FTPS flavour connected. R10's transport spec is NOT confirmed; media Path B is unavailable until this connects.",
      interpret: "Read attempts[].error and attempts[].transcript — the failing stage names the wrong assumption (tcp-connect = firewall/port, tls-upgrade = AUTH refused, command = auth or PROT)." });
    p(`FTP: no flavour connected (${out.attempts.map((a) => `${a.mode}:${a.error ?? "?"}`).join(" | ")})`);
    return;
  }
  out.flavour = sess.mode;
  try {
    const feat = await sess.cmd("FEAT");
    out.feat = { code: feat.code, lines: (feat.multiline ?? feat.text).split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/^211/.test(x)) };
    out.syst = (await sess.cmd("SYST")).text;
    out.pwd = (await sess.cmd("PWD")).text;
    // --- walk the archive, hunting the FileNames Product_GetPictures actually returned ---
    const targets = (process.env.DD_FTP_FIND || "product-1.png,product-2.png,product-5.png")
      .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const deadline = Date.now() + 90000, seen = new Set(), tree = {}, found = {};
    const queue = ["/"];
    let listCalls = 0;
    while (queue.length && listCalls < 60 && Date.now() < deadline) {
      const dir = queue.shift();
      if (seen.has(dir)) continue;
      seen.add(dir); listCalls++;
      let entries;
      try {
        const r = await sess.xferIn(`LIST ${dir}`);
        entries = parseList(r.buf.toString("latin1"));
        tree[dir] = { openCode: r.openCode, finCode: r.finCode, bytes: r.bytes, entries: entries.slice(0, 200) };
      } catch (e) { tree[dir] = { error: e.message }; FAULTS.push({ ok: false, op: `LIST ${dir}`, code: "?", message: e.message }); continue; }
      for (const en of entries) {
        if (!en.name || en.name === "." || en.name === "..") continue;
        const full = dir === "/" ? `/${en.name}` : `${dir}/${en.name}`;
        if (en.type === "dir") queue.push(full);
        else if (targets.includes(en.name.toLowerCase()) && !found[en.name.toLowerCase()]) found[en.name.toLowerCase()] = { path: full, size: en.size };
      }
      // Do NOT stop at the first hit. The early-exit version listed /pics, found the product
      // images and never looked inside /pics/_thumbs or /pics/placeholders — so it could not
      // see that the archive holds machine-generated DERIVATIVES alongside the originals.
      // An FTP media export that uploads everything it walks would import those as product
      // images. Drain the queue instead, bounded by the call cap and the deadline.
    }
    out.walk = { listCalls, directoriesListed: [...seen], queueRemaining: queue.length,
      capHit: listCalls >= 60, timedOut: Date.now() >= deadline, targets, found };
    out.tree = tree;
    // --- RETR: prove binary mode is intact (PNG magic bytes survive) ---
    const first = Object.values(found)[0];
    if (first) {
      const r = await sess.xferIn(`RETR ${first.path}`);
      const magic = r.buf.subarray(0, 8).toString("hex");
      out.retr = { path: first.path, openCode: r.openCode, finCode: r.finCode, bytes: r.bytes,
        listedSize: first.size, sizeMatchesListing: first.size == null ? null : first.size === r.bytes,
        magicHex: magic, looksPng: magic.startsWith("89504e470d0a1a0a"), looksJpeg: magic.startsWith("ffd8ff") };
    } else {
      out.retr = { skipped: "none of the target FileNames were found in the walked tree" };
    }
    // --- STOR round-trip (seeding half of F35). --write only. ---
    if (process.argv.includes("--write")) {
      requireWrite();
      const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
        "0d0a2db40000000049454e44ae426082", "hex"); // 1x1 transparent PNG
      const dir = out.retr?.path ? out.retr.path.replace(/\/[^/]*$/, "") : (out.pwd?.match(/"([^"]+)"/)?.[1] ?? "");
      const name = `shoplift-probe-${Date.now()}.png`;
      const remote = `${dir}/${name}`.replace(/\/+/g, "/");
      const st = { remote };
      try {
        const w = await sess.xferOut(`STOR ${remote}`, png);
        st.stor = { openCode: w.openCode, finCode: w.finCode, sentBytes: w.sentBytes };
        const back = await sess.xferIn(`RETR ${remote}`);
        st.roundTrip = { bytes: back.bytes, identical: Buffer.compare(back.buf, png) === 0 };
        const del = await sess.cmd(`DELE ${remote}`);
        st.dele = del.code;
        st.cleanedUp = del.code === 250;
      } catch (e) { st.error = e.message; FAULTS.push({ ok: false, op: "STOR", code: "?", message: e.message }); }
      out.stor = st;
    } else {
      out.stor = { skipped: "read-only run — re-run with --write to prove STOR (the seeding half of F35)" };
    }
  } finally {
    out.transcript = sess.transcript;
    out.pasv = sess.pasv;
    out.dataTls = sess.dataTls ?? null;
    sess.quit();
  }
  const gotBytes = out.retr?.bytes > 0;
  const imageOk = Boolean(out.retr?.looksPng || out.retr?.looksJpeg);
  save("ftp", { ...out, faults: FAULTS,
    verdict: !gotBytes
      ? `Connected via ${out.flavour} FTPS, but no target image was RETRieved — media Path B is NOT yet proven. See walk.found / tree.`
      : imageOk
      ? `CONFIRMED: ${out.flavour} FTPS on port ${out.attempts.find((a) => a.ok)?.port}, PROT ${out.attempts.find((a) => a.ok)?.protEncrypted ? "P" : "REFUSED"}, RETR returned ${out.retr.bytes} bytes with intact image magic bytes at ${out.retr.path}. Media Path B (FTP -> stagedUploadsCreate) is viable.`
      : `RETR returned ${out.retr.bytes} bytes but the magic bytes are not a known image header (${out.retr.magicHex}) — suspect TYPE I was not honoured or the path is not an image.`,
    interpret: "attempts[] records BOTH flavours. pasv[].advertisedDifferedFromControl proves whether the NAT workaround mattered. dataTls.sessionReused shows whether the server required control-session resumption on the data channel. retr.looksPng is the binary-mode proof; stor.roundTrip.identical is the seeding proof." });
  p(`FTP: flavour=${out.flavour} | found=${Object.keys(out.walk?.found ?? {}).length}/${out.walk?.targets?.length ?? 0} | RETR=${out.retr?.bytes ?? "-"}B png=${out.retr?.looksPng ?? "-"} | STOR=${out.stor?.roundTrip?.identical ?? out.stor?.skipped ?? out.stor?.error} | faults=${FAULTS.length}`);
}

/** R9 Path A — find a REAL storefront image URL. One cheap probe; URL-based media import
 *  beats moving bytes when it works. Three independent channels, because the heimdal theme
 *  is JS-rendered (standing note) and a single scrape could come back empty and prove nothing. */
async function probeImgurl() {
  const tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;
  const out = { tenant, channels: {}, candidates: [], urlTests: [] };
  // Channel 1: SOAP — the authoritative FileName list (do not reuse a stale artifact).
  await connect();
  await tryCall("Product_SetFields", { Fields: "Id,ItemNumber,Title" });
  const ids = (process.env.DD_MEDIA_IDS || "1,2,3,4,5,6").split(",").map((x) => Number(x.trim())).filter(Boolean);
  const names = [];
  for (const id of ids) {
    const pics = await tryCall("Product_GetPictures", { ProductId: id });
    const rows = pics.ok ? (Array.isArray(pics.result) ? pics.result : [pics.result]).filter(Boolean) : [];
    for (const r of rows) if (r?.FileName) names.push({ productId: id, fileName: r.FileName });
  }
  out.channels.soap = { productsProbed: ids.length, pictures: names };
  if (!names.length) {
    save("imgurl", { ...out, faults: FAULTS, verdict: "NO FileNames returned — cannot resolve what does not exist. Re-probe on a shop with product images.", interpret: "Without a FileName there is nothing to resolve; this is not evidence about the URL base." });
    p("imgurl: no FileNames from SOAP — nothing to resolve.");
    return;
  }
  // Channel 2: scrape real pages. Ask for HTML like a browser; the theme may SSR for crawlers.
  const tpl = process.env.DD_STOREFRONT_PRODUCT_URL || "";
  const pages = [];
  if (tpl.includes("{id}")) for (const { productId } of names.slice(0, 3)) pages.push(tpl.replace("{id}", String(productId)));
  const origin = tpl ? (() => { try { return new URL(tpl.replace("{id}", "1")).origin; } catch { return null; } })() : null;
  if (origin) { pages.push(origin + "/", origin + "/sitemap.xml"); }
  if (tenant) pages.push(`https://${tenant}.mywebshop.io/`);
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36";
  const wanted = names.map((n) => n.fileName);
  const seenUrls = new Set();
  // The heimdal product pages are JS-rendered (standing note), so a single scrape proves
  // nothing. Crawl one hop deeper from any server-rendered page until a page actually
  // references a product image — a real <img src> beats every inferred base.
  const queue = [...new Set(pages)], visited = new Set();
  let extraHops = 0;
  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url) || visited.size > 12) continue;
    visited.add(url);
    const rec = { url };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*" } });
      const html = await res.text();
      rec.status = res.status; rec.bytes = html.length; rec.contentType = res.headers.get("content-type");
      // every URL-ish token that points at an image, from src / data-src / srcset / og:image / css url()
      const urls = new Set();
      for (const m of html.matchAll(/(?:src|data-src|data-original|href|content)\s*=\s*["']([^"']+\.(?:png|jpe?g|webp|gif|avif|svg)(?:\?[^"']*)?)["']/gi)) urls.add(m[1]);
      for (const m of html.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(",")) { const u = part.trim().split(/\s+/)[0]; if (u) urls.add(u); }
      for (const m of html.matchAll(/url\((["']?)([^)"']+\.(?:png|jpe?g|webp|gif|avif))\1\)/gi)) urls.add(m[2]);
      for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>()\\]+\.(?:png|jpe?g|webp|gif|avif)/gi)) urls.add(m[0].replace(/\\\//g, "/"));
      rec.imageUrlsFound = urls.size;
      rec.sample = [...urls].slice(0, 25);
      // hostnames that smell like a CDN — the thing R7's four guessed bases were missing
      rec.hosts = [...new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]*(?:sfstatic|cdn|static|img|image|media)[a-z0-9.-]*)/gi)].map((m) => m[1].toLowerCase()))].slice(0, 20);
      // does the page mention the exact FileName anywhere at all? (with context)
      rec.fileNameHits = wanted.filter((n) => html.includes(n)).map((n) => {
        const i = html.indexOf(n);
        return { fileName: n, context: html.slice(Math.max(0, i - 160), i + n.length + 60).replace(/\s+/g, " ") };
      });
      for (const u of urls) {
        const abs = u.startsWith("//") ? "https:" + u : u.startsWith("http") ? u : origin ? new URL(u, origin).href : null;
        if (abs) seenUrls.add(abs);
      }
      // one hop deeper, but only from pages the server actually rendered (a JS shell has
      // nothing to follow) and only while no page has yet named one of our FileNames
      if (extraHops < 5 && html.length > 20000 && !rec.fileNameHits.length) {
        const here = new URL(url).origin;
        const links = [...html.matchAll(/href\s*=\s*["'“]([^"'”]+)["'”]/g)].map((m) => m[1])
          .filter((h) => !/^(#|mailto:|tel:|javascript:)/i.test(h) && !/\.(css|js|png|jpe?g|gif|svg|webp|xml|ico)(\?|$)/i.test(h))
          .map((h) => { try { return new URL(h, url).href; } catch { return null; } })
          .filter((h) => h && h.startsWith(here) && !visited.has(h));
        // prefer links that look like a product or a category listing
        const ranked = [...new Set(links)].sort((a, b) =>
          (/(produkt|product|vare|shop\/)/i.test(b) ? 1 : 0) - (/(produkt|product|vare|shop\/)/i.test(a) ? 1 : 0));
        for (const l of ranked.slice(0, 3)) { queue.push(l); extraHops++; }
        rec.followed = ranked.slice(0, 3);
      }
    } catch (e) { rec.error = e.message; }
    out.channels[`page:${url}`] = rec;
  }
  // Channel 3: Solution_CreateThumb is a PATH ORACLE — it takes ImagePath and returns a string.
  // Whatever it echoes tells us the server's own idea of where product images live.
  if (process.argv.includes("--write")) {
    requireWrite();
    const probes = [wanted[0], `/${wanted[0]}`, `images/${wanted[0]}`, `/images/${wanted[0]}`, `upload_dir/pics/${wanted[0]}`];
    out.channels.createThumb = [];
    for (const ip of probes) {
      const r = await tryCall("Solution_CreateThumb", { ImagePath: ip, ThumbWidth: 40, ThumbHeight: 40, Crop: false, Greyscale: false, Watermark: false });
      out.channels.createThumb.push({ imagePath: ip, ok: r.ok, result: r.ok ? r.result : `${r.code}: ${r.message}` });
      const s = r.ok ? String(r.result ?? "") : "";
      if (s && /\.(png|jpe?g|webp|gif)/i.test(s)) seenUrls.add(s.startsWith("http") ? s : origin ? new URL(s, origin).href : s);
    }
  } else {
    out.channels.createThumb = { skipped: "Solution_CreateThumb writes a thumbnail file — re-run with --write to use it as a path oracle" };
  }
  // Channel 4: the FTP archive layout is itself a hypothesis about the public layout.
  // The `ftp` probe found the pictures under /pics/ — try that directory (and the other
  // archive roots) on every storefront origin. This is a GUESS derived from evidence, and it
  // is only accepted below on HTTP 200 + content-type image/*, same as every other candidate.
  // Hosts the pages themselves referenced images from — this is where the CDN reveals itself.
  const cdnHosts = [...new Set([...seenUrls].map((u) => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean))];
  const origins = [...new Set([origin, tenant ? `https://${tenant}.mywebshop.io` : null,
    tenant ? `https://${tenant}.webshop.dandomain.dk` : null, ...cdnHosts].filter(Boolean))];
  let archiveDirs = [];
  try {
    const ftpArt = JSON.parse(readFileSync(path.join(OUT, "ftp.json"), "utf8"));
    archiveDirs = [...new Set(Object.values(ftpArt.walk?.found ?? {}).map((f) => String(f.path).replace(/\/[^/]*$/, "") + "/"))];
    out.channels.ftpDerived = { source: "data/probes/ftp.json", archiveDirs };
  } catch { out.channels.ftpDerived = { source: "data/probes/ftp.json", note: "not present — run the `ftp` probe first to derive archive paths" }; }
  // A discovered URL that carries a file we KNOW is in the FTP archive reveals the prefix the
  // CDN puts in front of the archive path (e.g. FTP /pics/slide.png -> /upload_dir/pics/...).
  // Derive it rather than hardcoding "upload_dir".
  const archiveFiles = (() => { try {
    const t = JSON.parse(readFileSync(path.join(OUT, "ftp.json"), "utf8")).tree ?? {};
    return Object.entries(t).flatMap(([dir, v]) => (v.entries ?? []).filter((e) => e.type === "file").map((e) => ({ dir: dir === "/" ? "/" : dir + "/", name: e.name })));
  } catch { return []; } })();
  const derivedPrefixes = new Set();
  for (const u of seenUrls) for (const f of archiveFiles) {
    const stem = f.name.replace(/\.[^.]+$/, "");
    const i = u.indexOf(f.dir + f.name) >= 0 ? u.indexOf(f.dir + f.name) : u.indexOf(f.dir + "_thumbs/" + stem + ".");
    if (i > 0) { try { derivedPrefixes.add(new URL(u).pathname.slice(0, new URL(u).pathname.indexOf(f.dir))); } catch { } }
  }
  out.channels.derivedCdnPrefixes = { archiveFilesKnown: archiveFiles.length, prefixes: [...derivedPrefixes] };
  const prefixes = [...new Set(["", "/upload_dir", ...derivedPrefixes])];
  for (const o of origins) for (const pre of prefixes) for (const d of [...archiveDirs, "/pics/", "/images/", "/"]) {
    for (const n of wanted.slice(0, 1)) seenUrls.add(o + pre + d.replace(/^\/+/, "/") + n);
  }
  // --- resolve: which discovered URL actually serves one of OUR filenames? ---
  const bearing = [...seenUrls].filter((u) => wanted.some((n) => u.includes(n)));
  out.candidates = [...seenUrls].slice(0, 80);
  out.candidatesBearingOurFileNames = bearing;
  for (const u of bearing.slice(0, 40)) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { "user-agent": UA } });
      out.urlTests.push({ url: u, status: r.status, type: r.headers.get("content-type"), length: r.headers.get("content-length") }); }
    catch (e) { out.urlTests.push({ url: u, error: e.message }); }
  }
  // A 200 + image/* is necessary but not sufficient: a CDN can 200 a placeholder. Cross-check
  // the served byte count against the size FTP LISTed for the same FileName — two independent
  // channels agreeing on a length is what makes this a fact rather than a hopeful GET.
  const ftpSizes = Object.fromEntries(archiveFiles.map((f) => [f.name, null]));
  try {
    const t = JSON.parse(readFileSync(path.join(OUT, "ftp.json"), "utf8")).tree ?? {};
    for (const v of Object.values(t)) for (const e of v.entries ?? []) if (e.type === "file") ftpSizes[e.name] = e.size;
  } catch { /* no ftp artifact — the cross-check is simply unavailable, and says so below */ }
  for (const u of out.urlTests) {
    const n = wanted.find((x) => u.url.includes(x));
    const ftpSize = n ? ftpSizes[n] ?? null : null;
    u.ftpListedSize = ftpSize;
    u.byteCountMatchesFtp = ftpSize == null || u.length == null ? null : Number(u.length) === ftpSize;
  }
  const working = out.urlTests.filter((u) => u.status === 200 && String(u.type).startsWith("image/"));
  const hit = working.find((u) => u.byteCountMatchesFtp === true) ?? working[0] ?? null;
  const baseOf = (u) => { const n = wanted.find((x) => u.url.includes(x)); return n ? u.url.slice(0, u.url.indexOf(n)) : null; };
  const base = hit ? baseOf(hit) : null;
  out.resolvedBase = base;
  out.allWorkingBases = working.map((u) => ({ base: baseOf(u), bytes: u.length, ftpListedSize: u.ftpListedSize, byteCountMatchesFtp: u.byteCountMatchesFtp }));
  out.observedInMarkup = Object.values(out.channels).some((c) => Array.isArray(c?.fileNameHits) && c.fileNameHits.length > 0);
  save("imgurl", { ...out, faults: FAULTS,
    verdict: hit
      ? `RESOLVED: ${hit.url} -> ${hit.status} ${hit.type}${hit.byteCountMatchesFtp === true ? `, and its ${hit.length} bytes match the size FTP LISTed for the same file` : ""}. Base template = ${base}{FileName}. ${out.allWorkingBases.length} working base(s) found. R9 Path A (Shopify originalSource) is viable on this shop.`
      : bearing.length
      ? `Found ${bearing.length} URL(s) bearing our FileNames but NONE returned an image (see urlTests) — Path A stays UNRESOLVED; use Path B (FTP).`
      : "NO discovered URL contains any FileName from Product_GetPictures. Path A remains UNRESOLVED — the storefront never references these files by that name (JS-rendered theme, or a different naming scheme server-side).",
    interpret: `A base is only 'resolved' on HTTP 200 + content-type image/*, and is only CORROBORATED when byteCountMatchesFtp is true. observedInMarkup=${out.observedInMarkup} — false means no page ever referenced these FileNames, so the base was DERIVED (archive dir + CDN prefix) and then verified, not observed in the wild. Doctor must re-verify the base per shop before an import trusts it.` });
  p(`imgurl: names=${wanted.length} | bearing=${bearing.length} | ${hit ? "RESOLVED base=" + base + " (bytes match FTP: " + hit.byteCountMatchesFtp + ")" : "UNRESOLVED"} | faults=${FAULTS.length}`);
}

/** GAPS — the entities the adversarial review found with ZERO probes. Read-only.
 *  Every field list below is taken from the WSDL complexType at runtime (R4: one invented
 *  name faults the whole call AND leaves the session on the previous field set), and every
 *  read is field-audited (R3: a requested field can vanish with no error). */
async function probeGaps() {
  const out = { sections: {} };
  const raws = [];                       // {op, text} — fed to the HTML-entity scan at the end
  const rawCall = async (op, args = {}, opts = {}) => {
    try { const r = await call(op, args, opts); raws.push({ op, text: r.raw }); return { ok: true, op, result: r.result, ms: r.ms }; }
    catch (e) { const rec = { ok: false, op, code: e.code ?? "?", message: e.message, args: Object.keys(args) }; FAULTS.push(rec); if (e.raw) raws.push({ op, text: e.raw }); return rec; }
  };
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const first = (x) => arr(x)[0] ?? null;
  /** Field lists come from the WSDL, never from memory. Empty = the type was not found. */
  const typeFields = (name) => { const f = wsdlType(name); return { list: f.join(","), count: f.length }; };
  // GDPR: this shop's customers are synthetic, a client's are not. The probe records SHAPE,
  // never values, for anything that could be personal data — presence/type only.
  const PII = new Set(["Username", "Password", "Company", "Cvr", "Ean", "Firstname", "Lastname", "Sex", "Address", "Address2",
    "Zip", "City", "Phone", "Mobile", "Fax", "Email", "Url", "BirthDate", "Description", "InterestFields",
    "ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingCvr", "ShippingEan", "ShippingAddress",
    "ShippingAddress2", "ShippingZip", "ShippingCity", "ShippingPhone", "ShippingMobile", "ShippingEmail", "ShippingReferenceNumber"]);
  const redact = (rec) => Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) =>
    [k, PII.has(k) ? (v == null ? null : `<${typeof v}:${String(v).length}>`) : v]));

  await connect();

  // --- 1. CUSTOMERS: 0 read ops before now. Consent vs ConsentDate vs Newsletter is the GDPR question.
  {
    const F = typeFields("User");
    const set = await rawCall("User_SetFields", { Fields: F.list });
    const all = await rawCall("User_GetAll");
    const rows = arr(all.result);
    const groups = await rawCall("User_GetGroupAll");
    const news = await rawCall("User_GetAllNewsletter");
    const sample = first(all.result);
    const consentValues = rows.map((r) => ({ Consent: r?.Consent ?? null, ConsentDate: r?.ConsentDate ?? null, Newsletter: r?.Newsletter ?? null }));
    out.sections.customers = {
      wsdlFieldCount: F.count, setFieldsOk: set.ok, setFieldsFault: set.ok ? null : `${set.code}: ${set.message}`,
      getAllOk: all.ok, getAllFault: all.ok ? null : `${all.code}: ${all.message}`,
      customerCount: rows.length, audit: fieldAudit(F.list, all.result),
      sampleRedacted: redact(sample),
      consentTriplet: consentValues.slice(0, 20),
      threeFieldsAreDistinct: sample ? ["Consent", "ConsentDate", "Newsletter"].every((k) => k in sample) : null,
      groups: arr(groups.result).map((g) => ({ Id: g?.Id, Title: g?.Title, Producer: g?.Producer })),
      newsletterSubscriberCount: news.ok ? arr(news.result).length : null, newsletterFault: news.ok ? null : `${news.code}: ${news.message}`,
      note: "Values for personal fields are replaced with <type:length> — the shape is the finding, the data is not ours to record.",
    };
  }

  // --- 2. PRICE LINES: the live money-corruption path. ProductDiscount is scoped by UserType/UserId.
  {
    const F = typeFields("ProductDiscount");
    const ids = (process.env.DD_MEDIA_IDS || "1,2,3,4,5,6").split(",").map(Number).filter(Boolean);
    const perProduct = [];
    for (const id of ids) {
      const d = await rawCall("Product_GetDiscounts", { ProductId: id });
      perProduct.push({ productId: id, ok: d.ok, fault: d.ok ? null : `${d.code}: ${d.message}`, rows: arr(d.result) });
    }
    const allRows = perProduct.flatMap((p) => p.rows).filter(Boolean);
    const dg = await rawCall("DiscountGroup_GetAll");
    const dgp = await rawCall("DiscountGroupProduct_GetAll");
    const acc = await rawCall("Product_GetDiscountsAccumulativeAll");
    out.sections.priceLines = {
      wsdlFieldCount: F.count, wsdlFields: F.list,
      productsProbed: ids.length, priceLineRowsFound: allRows.length,
      audit: allRows.length ? fieldAudit(F.list, allRows) : null,
      userTypeValues: [...new Set(allRows.map((r) => r?.UserType))],
      userIdValues: [...new Set(allRows.map((r) => r?.UserId))],
      scopedRowsPresent: allRows.some((r) => (r?.UserType ?? "0") !== "0" || (r?.UserId ?? "0") !== "0"),
      sample: allRows.slice(0, 5),
      perProduct: perProduct.map((p) => ({ productId: p.productId, ok: p.ok, fault: p.fault, count: p.rows.length })),
      discountGroups: dg.ok ? arr(dg.result) : `${dg.code}: ${dg.message}`,
      discountGroupProducts: dgp.ok ? arr(dgp.result).length : `${dgp.code}: ${dgp.message}`,
      accumulativeAll: acc.ok ? arr(acc.result).length : `${acc.code}: ${acc.message}`,
      interpret: "SETTLED by R22 (probe `gapsw`): scoping was created and read back, and 'lowest wins' over the unfiltered set DID select a group price over the public one. Public price = cheapest row with UserType==='all' && UserId==='0'. A 0 count here just means this shop currently has no price lines.",
    };
  }

  // --- 3. VARIANTS + variant types
  {
    const F = typeFields("ProductVariant");
    const set = await rawCall("Product_SetVariantFields", { Fields: F.list });
    const ids = (process.env.DD_MEDIA_IDS || "1,2,3,4,5,6").split(",").map(Number).filter(Boolean);
    const per = [];
    for (const id of ids) {
      const v = await rawCall("Product_GetVariants", { ProductId: id });
      per.push({ productId: id, ok: v.ok, fault: v.ok ? null : `${v.code}: ${v.message}`, rows: arr(v.result) });
    }
    const rows = per.flatMap((x) => x.rows).filter(Boolean);
    const types = await rawCall("Product_GetVariantTypeAll");
    const typeRows = arr(types.result);
    const values = typeRows[0]?.Id ? await rawCall("Product_GetVariantTypeValuesByType", { VariantTypeId: Number(typeRows[0].Id) }) : null;
    out.sections.variants = {
      wsdlFieldCount: F.count, setVariantFieldsOk: set.ok, setVariantFieldsFault: set.ok ? null : `${set.code}: ${set.message}`,
      variantRowsFound: rows.length, audit: rows.length ? fieldAudit(F.list, rows) : null,
      sample: rows.slice(0, 2),
      perProduct: per.map((x) => ({ productId: x.productId, ok: x.ok, fault: x.fault, count: x.rows.length })),
      variantTypes: typeRows, variantTypeValues: values ? (values.ok ? arr(values.result) : `${values.code}: ${values.message}`) : "skipped (no variant types)",
    };
  }

  // --- 4. DISCOUNTS (voucher codes) — 24 fields incl. FreeGift, which PLAN listed as a loss
  {
    const F = typeFields("Discount");
    const all = await rawCall("Discount_GetAll");
    const rows = arr(all.result);
    out.sections.discounts = {
      wsdlFieldCount: F.count, wsdlFields: F.list, ok: all.ok, fault: all.ok ? null : `${all.code}: ${all.message}`,
      count: rows.length, audit: rows.length ? fieldAudit(F.list, rows) : null, sample: rows.slice(0, 3),
    };
  }

  // --- 5. CMS PAGES: the review's "no PageText_GetAll exists" — find the enumeration path or record its absence
  {
    const F = typeFields("PageText");
    const set = await rawCall("PageText_SetFields", { Fields: F.list });
    const byFolder = [];
    for (let fid = 0; fid <= 20; fid++) {
      const r = await rawCall("PageText_GetByFolder", { FolderId: fid });
      const rows = arr(r.result).filter(Boolean);
      byFolder.push({ folderId: fid, ok: r.ok, fault: r.ok ? null : `${r.code}: ${r.message}`, count: rows.length,
        titles: rows.flatMap((p) => arr(p?.Title)).filter(Boolean).slice(0, 20) });
    }
    // WSDL: PageTextIds is xsd:STRING, not an array. Sending {item:[...]} produced
    // "Violation of encoding rules" — a guessed shape faulting exactly as R4 predicts.
    const byIds = await rawCall("PageText_GetByIds", { PageTextIds: "1,2,3,4,5,6,7,8,9,10" });
    const found = arr(byIds.result).filter(Boolean);
    out.sections.pages = {
      wsdlFieldCount: F.count, setFieldsOk: set.ok, setFieldsFault: set.ok ? null : `${set.code}: ${set.message}`,
      enumerationOpsInWsdl: ["PageText_GetByFolder", "PageText_GetById", "PageText_GetByIds", "PageText_GetByLink"],
      noGetAllConfirmed: true,
      byFolder, byIdsCount: found.length, byIdsOk: byIds.ok, byIdsFault: byIds.ok ? null : `${byIds.code}: ${byIds.message}`,
      byIdsTitles: found.map((p) => p?.Title).filter(Boolean),
      audit: found.length ? fieldAudit(F.list, found) : null,
      interpret: "If GetByFolder(0..n) enumerates, SOAP has a folder-walk path. If not, enumeration must come from GraphQL `pages`/`folders` (F12) or from an id sweep, and that is a documented scan cost.",
    };
  }

  // --- 6. Product_GetTags is a REVIEW record, not a tag (review re-opened PLAN §11)
  {
    const F = typeFields("ProductTag");
    const ids = [1, 2, 3, 4, 5, 6];
    const per = [];
    for (const id of ids) { const t = await rawCall("Product_GetTags", { ProductId: id }); per.push({ productId: id, ok: t.ok, fault: t.ok ? null : `${t.code}: ${t.message}`, rows: arr(t.result) }); }
    const rows = per.flatMap((x) => x.rows).filter(Boolean);
    out.sections.tagsAreReviews = {
      wsdlFieldCount: F.count, wsdlFields: F.list, rowsFound: rows.length,
      hasRatingAndText: F.list.includes("Rating") && F.list.includes("Text"),
      sample: rows.slice(0, 3), perProduct: per.map((x) => ({ productId: x.productId, ok: x.ok, count: x.rows.length })),
      interpret: "The TYPE proves these are reviews (Rating/Text/UserEmail). A zero row count means this shop has no reviews, not that the entity is absent.",
    };
  }

  // --- 7. Product custom fields
  {
    const types = await rawCall("Product_GetCustomDataTypeAll");
    const per = [];
    for (const id of [1, 2, 3]) { const c = await rawCall("Product_GetCustomData", { ProductId: id }); per.push({ productId: id, ok: c.ok, fault: c.ok ? null : `${c.code}: ${c.message}`, rows: arr(c.result) }); }
    out.sections.customFields = {
      typesOk: types.ok, types: types.ok ? arr(types.result) : `${types.code}: ${types.message}`,
      perProduct: per.map((x) => ({ productId: x.productId, ok: x.ok, fault: x.fault, count: x.rows.length, sample: x.rows.slice(0, 2) })),
    };
  }

  // --- 8. Order_GetByDate's Status argument: WSDL says nillable — does the server agree?
  {
    const shapes = [
      { label: "Status omitted", args: { Start: "2019-01-01 00:00:00", End: "2030-01-01 00:00:00" } },
      { label: "Status empty string", args: { Start: "2019-01-01 00:00:00", End: "2030-01-01 00:00:00", Status: "" } },
      { label: "Status 0", args: { Start: "2019-01-01 00:00:00", End: "2030-01-01 00:00:00", Status: "0" } },
      { label: "Status 99", args: { Start: "2019-01-01 00:00:00", End: "2030-01-01 00:00:00", Status: "99" } },
    ];
    const tried = [];
    for (const s of shapes) {
      const r = await rawCall("Order_GetByDate", s.args);
      tried.push({ ...s, ok: r.ok, fault: r.ok ? null : `${r.code}: ${r.message}`, count: arr(r.result).length,
        ids: arr(r.result).map((o) => o?.Id).filter(Boolean).slice(0, 30) });
    }
    const omitted = tried[0], zero = tried[2];
    out.sections.orderGetByDate = {
      wsdlSignature: "Start, End, Status — all xsd:string nillable=true", tried,
      statusIsOptionalInPractice: omitted.ok,
      omittingStatusReturnsEverything: omitted.ok && zero.ok ? omitted.count >= zero.count : null,
      interpret: "If omitting Status faults, a date-window export MUST loop every status id or it silently exports a subset. If it succeeds but returns fewer rows than the status-specific call, that is worse: a silent partial export.",
    };
  }

  // --- 9. SCALE: what the shop can actually tell us, stated as the bound it is
  {
    const F = "Id,ItemNumber,Title,Price,Status,Online";
    await rawCall("Product_SetFields", { Fields: F });
    const page = await rawCall("Product_GetAllWithLimit", { Start: 0, Length: 2500 }, { timeoutMs: 60000 });
    // WSDL: Order_GetAllWithPagination takes Page/PageSize, NOT Start/Length. The wrong names
    // did not fault as NOSUCHPARAM — PHP reported "0 passed, exactly 2 expected", i.e. unknown
    // element names are DROPPED silently before the call. Another reason to read the WSDL.
    const orders = await rawCall("Order_GetAllWithPagination", { Page: 1, PageSize: 250 }, { timeoutMs: 60000 });
    const ordersWrongArgs = await rawCall("Order_GetAllWithPagination", { Start: 0, Length: 250 }, { timeoutMs: 60000 });
    out.sections.scale = {
      products: arr(page.result).length, productsFault: page.ok ? null : `${page.code}: ${page.message}`,
      ordersPaginated: orders.ok ? arr(orders.result).length : `${orders.code}: ${orders.message}`,
      wrongArgNamesBehaviour: ordersWrongArgs.ok ? "accepted (unexpected)" : `${ordersWrongArgs.code}: ${ordersWrongArgs.message}`,
      wrongArgNamesLesson: "Unrecognised element names are silently dropped rather than rejected as NOSUCHPARAM — the server then complains about arity. Validate argument names against the WSDL, not just field names (R4's rule extends to arguments).",
      bound: "Product count only. R26 (probe `scale`) is the real measurement — R5's paged-batch architecture is confirmed at 618 products, ~1.2 ms/product fully inlined.",
    };
  }

  // --- 10. HTML ENTITIES: the review found Kontooverf&oslash;rsel next to a raw å in ONE
  // response — Payment_GetAll. Call the implicated ops explicitly; scanning only whatever
  // this probe happened to touch would report "not reproduced" without ever asking.
  {
    for (const op of ["Payment_GetAll", "Delivery_GetAll", "OrderStatusCode_GetAll", "Currency_GetAll", "Solution_GetWebinfo"]) await rawCall(op);
    const perOp = [];
    for (const { op, text } of raws) {
      const ents = [...new Set([...String(text).matchAll(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g)].map((m) => m[0]))]
        .filter((e) => !["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"].includes(e));
      const rawNonAscii = /[À-ɏ]/.test(String(text));
      if (ents.length || rawNonAscii) perOp.push({ op, entities: ents.slice(0, 12), rawNonAsciiPresent: rawNonAscii, bothFormsInSameResponse: Boolean(ents.length && rawNonAscii) });
    }
    out.sections.htmlEntities = {
      responsesScanned: raws.length, opsWithFindings: perOp,
      mixedEncodingResponses: perOp.filter((x) => x.bothFormsInSameResponse).map((x) => x.op),
      interpret: "F2's mojibake detector matches /Ã[\\x80-\\xBF]/ and cannot see &oslash;. Any op listed under mixedEncodingResponses carries BOTH conventions, so the client needs a per-field entity-decode step, not a global one — decoding globally would corrupt any field that legitimately contains an ampersand sequence.",
    };
  }

  const gaps = Object.entries(out.sections).filter(([, v]) => v.getAllOk === false || v.ok === false);
  save("gaps", { ...out, faults: FAULTS,
    verdict: `Probed ${Object.keys(out.sections).length} previously-unprobed areas. Faults: ${FAULTS.length}. ` +
      `customers=${out.sections.customers.customerCount} priceLines=${out.sections.priceLines.priceLineRowsFound} ` +
      `variants=${out.sections.variants.variantRowsFound} discounts=${out.sections.discounts.count} ` +
      `pagesById=${out.sections.pages.byIdsCount} reviews=${out.sections.tagsAreReviews.rowsFound}. ` +
      (gaps.length ? `STILL FAULTING: ${gaps.map(([k]) => k).join(", ")}.` : "No section failed outright."),
    interpret: "A zero count is a fact about THIS demo shop, not about the entity. Every section states its own bound; do not promote 'no rows' to 'no such feature'." });
  p(`gaps: customers=${out.sections.customers.customerCount} priceLines=${out.sections.priceLines.priceLineRowsFound} variants=${out.sections.variants.variantRowsFound} discounts=${out.sections.discounts.count} pages=${out.sections.pages.byIdsCount} reviews=${out.sections.tagsAreReviews.rowsFound} | faults=${FAULTS.length}`);
}

/** GAPSW — the WRITE probes that close the P1 gaps blocking P1b. Creates PROBE-* scratch data
 *  and cleans up after itself. Sections: price lines (the B2B money hazard), customers
 *  (Consent/ConsentDate/Newsletter = GDPR), the SOAP half of F35 (Product_CreatePicture over an
 *  FTP-placed file), the variant -> type-value link (R20), and Solution_CreateThumb as a path
 *  oracle (R14). Field lists come from the WSDL at runtime; every call is fault-recorded. */
async function probeGapsw() {
  requireWrite();
  const out = { sections: {}, cleanup: {} };
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const first = (x) => arr(x)[0] ?? null;
  const stamp = Date.now();
  await connect();

  // ---- A. PRICE LINES — the highest-risk open item. ProductDiscount is scoped by
  // UserType/UserId, and PLAN §3's "lowest wins" over an unfiltered set would publish a B2B
  // price. The shop had ZERO rows, so the scoping had to be CREATED to be observed.
  {
    const s = { note: "UserType is xsd:string with no documented vocabulary — swept empirically." };
    const cat = Number(process.env.DD_PROBE_CATEGORY || 9);           // "Probe Kategori"
    const mk = await tryCall("Product_CreateOrUpdate", { ProductData: {
      CategoryId: cat, ItemNumber: `PROBE-PL-${stamp}`, Title: "PROBE price-line carrier",
      Price: 100, Online: true, Status: true, Stock: 50, LanguageISO: "DK" } });
    s.carrierCreate = { ok: mk.ok, fault: mk.ok ? null : `${mk.code}: ${mk.message}` };
    await tryCall("Product_SetFields", { Fields: "Id,ItemNumber,Title,Price" });
    const look = await tryCall("Product_GetByItemNumber", { ItemNumber: `PROBE-PL-${stamp}` });
    const pid = Number(first(look.result)?.Id ?? 0);
    s.carrierProductId = pid || null;
    if (pid) {
      // group 4 on this shop is "Kunder B2B-login" (R19). Sweep the UserType vocabulary.
      const GROUP_ID = Number(process.env.DD_PROBE_USERGROUP || 4);
      const candidates = ["", "0", "1", "2", "3", "all", "user", "group", "usergroup", "customer"];
      s.userTypeSweep = [];
      for (const ut of candidates) {
        const r = await tryCall("Product_CreateDiscount", { ProductDiscountData: {
          ProductId: pid, Amount: 1, Price: 42, Discount: 0, Currency: "1",
          DiscountType: "b", UserType: ut, UserId: GROUP_ID, Accumulate: false } });
        s.userTypeSweep.push({ userType: ut === "" ? "(empty)" : ut, accepted: r.ok,
          fault: r.ok ? null : `${r.code}: ${r.message}` });
      }
      // ALSO create an unscoped, DEARER row — this is the pair that makes "lowest wins" wrong.
      const pub = await tryCall("Product_CreateDiscount", { ProductDiscountData: {
        ProductId: pid, Amount: 1, Price: 90, Discount: 0, Currency: "1",
        DiscountType: "b", UserId: 0, Accumulate: false } });
      s.publicRowCreated = pub.ok;
      const F = wsdlType("ProductDiscount").join(",");
      const back = await tryCall("Product_GetDiscounts", { ProductId: pid });
      const rows = arr(back.result).filter(Boolean);
      s.readBack = { ok: back.ok, count: rows.length, audit: fieldAudit(F, rows), rows };
      // THE question: can a reader tell a group-scoped row from a public one?
      const scoped = rows.filter((r) => String(r?.UserId ?? "0") !== "0");
      const unscoped = rows.filter((r) => String(r?.UserId ?? "0") === "0");
      s.scopedRows = scoped.length; s.unscopedRows = unscoped.length;
      s.distinguishable = rows.length ? scoped.length > 0 && unscoped.length > 0 : null;
      s.cheapestRow = rows.length ? rows.reduce((a, b) => (Number(a?.Price ?? 1e9) <= Number(b?.Price ?? 1e9) ? a : b)) : null;
      s.verdict = !rows.length ? "NO rows read back — the create calls did not produce readable price lines; scoping remains UNPROVEN."
        : s.distinguishable
        ? `Scoping IS readable: ${scoped.length} scoped + ${unscoped.length} unscoped rows on one product. Cheapest row = ${s.cheapestRow.Price} at UserId ${s.cheapestRow.UserId} / UserType "${s.cheapestRow.UserType}" — so "lowest wins" over the unfiltered set ${String(s.cheapestRow.UserId) !== "0" ? "WOULD PUBLISH A GROUP PRICE. HAZARD CONFIRMED." : "picks the public row here, but only because of the values chosen."}`
        : `Rows exist (${rows.length}) but scoped and unscoped were not both produced — inspect rows[] before trusting any filter rule.`;
      const del = await tryCall("Product_DeleteAllDiscounts", { ProductId: pid });
      out.cleanup.priceLinesDeleted = del.ok ? "Product_DeleteAllDiscounts ok" : `${del.code}: ${del.message}`;
    } else {
      s.verdict = "Could not resolve the carrier product id — price-line scoping NOT probed.";
    }
    out.sections.priceLines = s;
  }

  // ---- B. CUSTOMERS — Consent vs ConsentDate vs Newsletter. Synthetic data only
  // (example.invalid is reserved by RFC 2606 and can never route to a real person).
  {
    const s = { note: "Synthetic customers on example.invalid. Personal values are not recorded." };
    const F = wsdlType("User").join(",");
    await tryCall("User_SetFields", { Fields: F });
    const mkUser = async (label, consent, newsletter) => {
      const email = `probe-${label}-${stamp}@example.invalid`;
      const r = await tryCall("User_CreateOrUpdate", { UserData: {
        Username: email, Email: email, Password: `Pr0be${stamp}x`, UserGroupId: 1,
        Firstname: "Probe", Lastname: label, Address: "Testvej 1", Zip: "8000", City: "Aarhus",
        CountryCode: 1, LanguageISO: "DK", Newsletter: newsletter, Consent: consent,
        ConsentDate: consent ? "2024-03-01 12:00:00" : "", Approved: true } });
      return { label, ok: r.ok, fault: r.ok ? null : `${r.code}: ${r.message}` };
    };
    s.creates = [await mkUser("consentY-newsY", true, true),
      await mkUser("consentN-newsY", false, true),
      await mkUser("consentY-newsN", true, false)];
    const all = await tryCall("User_GetAll");
    const rows = arr(all.result).filter(Boolean);
    const mine = rows.filter((u) => String(u?.Username ?? "").includes(String(stamp)));
    s.totalCustomersNow = rows.length;
    s.createdAndReadBack = mine.length;
    s.audit = fieldAudit(F, mine.length ? mine : rows);
    s.triplet = mine.map((u) => ({ label: String(u?.Lastname ?? "?"), Consent: u?.Consent ?? null,
      ConsentDate: u?.ConsentDate ?? null, Newsletter: u?.Newsletter ?? null }));
    const news = await tryCall("User_GetAllNewsletter");
    s.newsletterQueryCount = news.ok ? arr(news.result).filter(Boolean).length : `${news.code}: ${news.message}`;
    const t = s.triplet;
    s.consentIndependentOfNewsletter = t.length >= 2 ? t.some((x) => String(x.Consent) !== String(x.Newsletter)) : null;
    s.consentDateSurvives = t.some((x) => x.ConsentDate && !/^0000|^$/.test(String(x.ConsentDate)));
    s.verdict = !mine.length
      ? "Customers were created but could not be read back — the GDPR triplet is STILL unverified."
      : `Read back ${mine.length} synthetic customers. Consent is ${s.consentIndependentOfNewsletter ? "INDEPENDENT of" : "NOT observably distinct from"} Newsletter; ConsentDate ${s.consentDateSurvives ? "round-trips" : "did NOT round-trip"}. User_GetAllNewsletter returned ${s.newsletterQueryCount}.`;
    const dels = [];
    for (const u of mine) { const d = await tryCall("User_Delete", { UserId: Number(u.Id) }); dels.push({ id: u.Id, ok: d.ok, fault: d.ok ? null : `${d.code}: ${d.message}` }); }
    out.cleanup.customersDeleted = dels;
    out.sections.customers = s;
  }

  // ---- C. The SOAP half of F35: does Product_CreatePicture bind an FTP-placed file?
  {
    const s = {};
    const host = process.env.DD_FTP_HOST, user = process.env.DD_FTP_USER, pass = process.env.DD_FTP_PASSWORD;
    const pid = Number(process.env.DD_MEDIA_PID || 1);
    const name = `probe-media-${stamp}.png`;
    // a real 8x8 PNG, not a 1x1 placeholder — a thumbnailer should cope with it
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000080000000808020000004b6d29dc0000001b494441547" +
      "89c63fccfc0f09f8111981918fe6768606060fa8f0100b1a105fe6d7d3c2c0000000049454e44ae426082", "hex");
    if (!(host && user && pass)) { s.skipped = "FTP credentials missing"; }
    else {
      let sess = null;
      try {
        sess = await ftpsConnect({ host, user, pass, mode: "explicit" });
        const w = await sess.xferOut(`STOR /pics/${name}`, png);
        s.stor = { openCode: w.openCode, finCode: w.finCode, bytes: w.sentBytes };
        const bind = await tryCall("Product_CreatePicture", { PictureData: { ProductId: pid, FileName: name, Sorting: 99 } });
        s.createPicture = { ok: bind.ok, fault: bind.ok ? null : `${bind.code}: ${bind.message}` };
        const back = await tryCall("Product_GetPictures", { ProductId: pid });
        const rows = arr(back.result).filter(Boolean);
        s.readBack = rows.map((r) => ({ Id: r?.Id, FileName: r?.FileName, Sorting: r?.Sorting }));
        const mine = rows.find((r) => r?.FileName === name);
        s.boundToProduct = Boolean(mine);
        let base = null;
        try { const a = JSON.parse(readFileSync(path.join(OUT, "imgurl.json"), "utf8"));
          base = (a.allWorkingBases ?? []).map((b) => b.base).find((b) => /sfstatic/.test(b)) ?? a.resolvedBase ?? null; } catch { }
        s.urlBaseUsed = base;
        if (base) {
          try { const r = await fetch(base + name, { signal: AbortSignal.timeout(20000) });
            s.httpFetch = { url: base + name, status: r.status, type: r.headers.get("content-type"), length: r.headers.get("content-length") }; }
          catch (e) { s.httpFetch = { url: base + name, error: e.message }; }
        }
        s.verdict = s.boundToProduct && s.httpFetch?.status === 200
          ? "F35 CLOSED END TO END: FTP STOR -> Product_CreatePicture -> readable via Product_GetPictures -> served over the public base. dd-real CAN seed products with images."
          : s.boundToProduct
          ? `Product_CreatePicture bound the FTP-placed file (readable via Product_GetPictures) but the public URL returned ${s.httpFetch?.status ?? s.httpFetch?.error ?? "nothing"} — binding works, serving unconfirmed.`
          : "Product_CreatePicture did NOT bind the FTP-placed file — F35's SOAP half stays OPEN.";
        if (mine?.Id) { const d = await tryCall("Product_DeletePicture", { PictureId: Number(mine.Id) }); out.cleanup.pictureDeleted = d.ok ? `deleted ${mine.Id}` : `${d.code}: ${d.message}`; }
        const del = await sess.cmd(`DELE /pics/${name}`);
        out.cleanup.ftpFileDeleted = del.code === 250;
      } catch (e) { s.error = e.message; FAULTS.push({ ok: false, op: "gapsw/media", code: "?", message: e.message }); }
      finally { sess?.quit(); }
    }
    out.sections.f35SoapHalf = s;
  }

  // ---- D. The variant -> type-value LINK (R20's unread dependency for Shopify options)
  {
    const s = {};
    const ids = (process.env.DD_PROBE_VARIANT_IDS || "4,5,28,6,7,8").split(",").map(Number).filter(Boolean);
    s.perVariant = [];
    for (const vid of ids) {
      const v = await tryCall("Product_GetVariantTypeValues", { VariantId: vid });
      const rows = arr(v.result).filter(Boolean);
      s.perVariant.push({ variantId: vid, ok: v.ok, fault: v.ok ? null : `${v.code}: ${v.message}`,
        values: rows.map((r) => ({ Id: r?.Id, Title: r?.Title, ProductVariantTypeId: r?.ProductVariantTypeId, Color: r?.Color })) });
    }
    const byId = await tryCall("Product_GetVariantById", { VariantId: String(ids[0]) });
    s.getVariantById = { ok: byId.ok, fault: byId.ok ? null : `${byId.code}: ${byId.message}`, sample: first(byId.result) };
    const linked = s.perVariant.filter((v) => v.values.length);
    s.variantsWithValues = linked.length;
    s.typeIdsSeen = [...new Set(linked.flatMap((v) => v.values.map((x) => x.ProductVariantTypeId)))];
    s.verdict = linked.length
      ? `LINK READ: ${linked.length}/${ids.length} variants resolve to type values via Product_GetVariantTypeValues(VariantId). Type ids seen: ${s.typeIdsSeen.join(",")}. This is the op the Shopify option mapping must use — the inlined VariantTypeValues field collapses under the naive parser (R18).`
      : "No variant resolved to type values — the Shopify option mapping still has no source.";
    out.sections.variantTypeValueLink = s;
  }

  // ---- E. Solution_CreateThumb as a path oracle (turns R14's derived base into an API answer)
  {
    const s = { probes: [] };
    for (const ip of ["product-1.png", "/product-1.png", "pics/product-1.png", "/pics/product-1.png", "upload_dir/pics/product-1.png"]) {
      const r = await tryCall("Solution_CreateThumb", { ImagePath: ip, ThumbWidth: 60, ThumbHeight: 60, Crop: false, Greyscale: false, Watermark: false });
      s.probes.push({ imagePath: ip, ok: r.ok, returned: r.ok ? r.result : `${r.code}: ${r.message}` });
    }
    const hit = s.probes.find((p) => p.ok && typeof p.returned === "string" && /\.(png|jpe?g|webp)/i.test(p.returned));
    s.oracleAnswer = hit ? hit.returned : null;
    s.verdict = hit
      ? `Solution_CreateThumb("${hit.imagePath}") returned "${hit.returned}" — the server's OWN statement of where an image lives. Compare against R14's derived base.`
      : "No ImagePath form produced a usable path string — the oracle did not answer; R14's base stays derived-and-verified rather than API-confirmed.";
    out.sections.thumbPathOracle = s;
  }

  if (out.sections.priceLines?.carrierProductId) {
    const d = await tryCall("Product_Delete", { ProductId: out.sections.priceLines.carrierProductId });
    out.cleanup.carrierProductDeleted = d.ok ? `deleted ${out.sections.priceLines.carrierProductId}` : `${d.code}: ${d.message}`;
  }

  save("gapsw", { ...out, faults: FAULTS,
    verdict: [out.sections.priceLines?.verdict, out.sections.customers?.verdict,
      out.sections.f35SoapHalf?.verdict, out.sections.variantTypeValueLink?.verdict,
      out.sections.thumbPathOracle?.verdict].filter(Boolean).join(" || "),
    interpret: "These are the P1 write-gaps that were blocking P1b, plus R20's unread link. Every section states whether it CLOSED its gap or left it open. cleanup{} records what was removed — verify it against the shop rather than trusting these strings." });
  p(`gapsw: priceLines=${out.sections.priceLines?.scopedRows ?? "-"}scoped/${out.sections.priceLines?.unscopedRows ?? "-"}public | customers=${out.sections.customers?.createdAndReadBack ?? "-"} | F35bind=${out.sections.f35SoapHalf?.boundToProduct ?? "-"} | variantLink=${out.sections.variantTypeValueLink?.variantsWithValues ?? "-"} | thumb=${out.sections.thumbPathOracle?.oracleAnswer ?? "none"} | faults=${FAULTS.length}`);
}

/** SCALE — the largest untested assumption. R5 says nested inlining makes the export a paged
 *  batch loop, but that was measured on 18 products, which bounds nothing. Bulk-create N
 *  products, then time the inlined paged read at several page sizes. --write. */
async function probeScale() {
  requireWrite();
  const N = Number(process.env.DD_SCALE_N || 300);
  const cat = Number(process.env.DD_PROBE_CATEGORY || 9);
  const out = { requested: N, categoryId: cat, created: [], pages: [] };
  await connect();
  // STABLE tag: a re-run must UPSERT the same N products, not mint another N.
  const tag = process.env.DD_SCALE_TAG || "SCALE-PROBE";
  out.tag = tag;
  // Bulk create in chunks — Product_CreateOrUpdateBulk takes ArrayOfProductCreateUpdate
  const CHUNK = Number(process.env.DD_SCALE_CHUNK || 50);
  for (let i = 0; i < N; i += CHUNK) {
    const items = [];
    for (let j = i; j < Math.min(i + CHUNK, N); j++) {
      items.push({ CategoryId: cat, ItemNumber: `${tag}-${j}`, Title: `Scale probe ${j} æøå`,
        Price: 100 + (j % 50), Online: true, Status: true, Stock: 10, LanguageISO: "DK" });
    }
    const t0 = Date.now();
    const r = await tryCall("Product_CreateOrUpdateBulk", { ProductDataList: { item: items } }, { timeoutMs: 120000 });
    out.created.push({ from: i, count: items.length, ok: r.ok, ms: Date.now() - t0,
      fault: r.ok ? null : `${r.code}: ${r.message}` });
    if (!r.ok) break;
  }
  // Now measure the R5 architecture: inlined nested read, paged.
  const NESTED = "Id,ItemNumber,Title,Price,Status,Online,Stock,VatGroupId,SeoLink,DateCreated," +
    "Variants,Pictures,CustomData,Discounts,Tags,SecondaryCategories,StockLocations,VariantTypes";
  const setF = await tryCall("Product_SetFields", { Fields: NESTED });
  out.setFieldsOk = setF.ok;
  out.setFieldsFault = setF.ok ? null : `${setF.code}: ${setF.message}`;
  // COUNT FROM THE RAW XML, not from the parsed object. The first run of this probe reported
  // `returned: 1` for every page size because the naive parser (R6/R18) collapses N records
  // into one object with parallel arrays — so a scale measurement taken through the parser
  // measures the parser. Counting <item> in the response bytes is parser-independent.
  // …and count a PRODUCT-ONLY field, not <item>. The first attempt counted <item> and reported
  // 1260 "products" for a ~600-product catalogue: nested Variants/Pictures/StockLocations rows
  // are <item> too. Count markers that exist on Product and on none of the nested types, and
  // record every marker so a disagreement is visible instead of averaged away.
  const countItems = (xml) => (String(xml).match(/<item>/g) || []).length;
  const countTag = (xml, t) => (String(xml).match(new RegExp(`<${t}[\\s>/]`, "g")) || []).length;
  const PRODUCT_ONLY = ["VatGroupId", "SeoLink", "Online"];
  for (const len of [50, 100, 250, 500, 1000]) {
    const t0 = Date.now();
    let rec = { pageSize: len };
    try {
      const r = await call("Product_GetAllWithLimit", { Start: 0, Length: len }, { timeoutMs: 180000 });
      const ms = Date.now() - t0;
      const marks = Object.fromEntries(PRODUCT_ONLY.map((t) => [t, countTag(r.raw, t)]));
      const vals = Object.values(marks);
      const agree = vals.every((v) => v === vals[0]);
      const products = agree ? vals[0] : Math.max(...vals);
      rec = { pageSize: len, ok: true, ms, bytes: String(r.raw).length,
        products, productMarkers: marks, markersAgree: agree,
        itemTagsIncludingNested: countItems(r.raw),
        msPerProduct: products ? Math.round(ms / products * 1000) / 1000 : null,
        bytesPerProduct: products ? Math.round(String(r.raw).length / products) : null,
        parsedLength: Array.isArray(r.result) ? r.result.length : 1,
        parserAgreesWithRaw: (Array.isArray(r.result) ? r.result.length : 1) === products };
    } catch (e) {
      rec = { pageSize: len, ok: false, ms: Date.now() - t0, fault: `${e.code ?? "?"}: ${e.message}` };
      FAULTS.push({ ok: false, op: "Product_GetAllWithLimit", code: e.code ?? "?", message: e.message });
    }
    out.pages.push(rec);
    if (!rec.ok) break;
  }
  const ok = out.pages.filter((x) => x.ok && x.products > 0);
  const total = ok.reduce((m, x) => Math.max(m, x.products), 0);
  const best = ok.slice().sort((a, b) => a.msPerProduct - b.msPerProduct)[0] ?? null;
  const capped = ok.filter((x) => x.products >= x.pageSize);
  out.catalogueSize = total;
  out.pageSizeHonoured = capped.map((x) => x.pageSize);
  out.pageSizeCeiling = ok.some((x) => x.pageSize > total && x.products === total)
    ? { note: `every page size above ${total} returned the whole catalogue — no server cap observed up to ${Math.max(...ok.map((x) => x.pageSize))}` } : null;
  out.markerDisagreement = out.pages.filter((x) => x.ok && !x.markersAgree).map((x) => ({ pageSize: x.pageSize, productMarkers: x.productMarkers }));
  out.parserDisagreedEverywhere = out.pages.every((x) => x.ok === false || x.parserAgreesWithRaw === false);
  out.projected10k = best ? { basisMsPerProduct: best.msPerProduct, basisPageSize: best.pageSize,
    calls: Math.ceil(10000 / best.pageSize), estimatedReadSeconds: Math.round(best.msPerProduct * 10000 / 1000),
    estimatedBytes: best.bytesPerProduct * 10000,
    caveat: "linear extrapolation from a few hundred mostly-empty products — optimistic by construction" } : null;
  save("scale", { ...out, faults: FAULTS,
    verdict: !best ? "No successful inlined page read — R5's batch architecture is NOT measured."
      : `Catalogue is ${total} products. Fully-inlined read of all of them took ${best.ms}ms at page size ${best.pageSize} (${best.msPerProduct} ms/product, ${best.bytesPerProduct} bytes/product). **R5's paged-batch architecture HOLDS at ${total} products** — ~${Math.ceil(10000 / best.pageSize)} calls for a 10k catalogue against the ~110,000 the pre-R5 N+1 design implied. ` +
        (out.parserDisagreedEverywhere ? `NOTE: the naive parser reported ONE record on every page (R6/R18), so all counts here come from the response bytes. ` : "") +
        (out.markerDisagreement.length ? `NOTE: product-only markers disagreed on ${out.markerDisagreement.length} page(s) — see markerDisagreement.` : ""),
    interpret: "products/msPerProduct/bytesPerProduct count PRODUCT-ONLY tags in the response BYTES. Counting <item> instead would inflate the total, because nested Variants/Pictures/StockLocations rows are <item> too — the first run of this probe made exactly that error. The extrapolation bounds the ARCHITECTURE (paged batch vs N+1); it is NOT a wall-clock estimate for a real migration: these products are near-empty, and bytesPerProduct will be far higher on a real catalogue with descriptions, variants and images." });
  p(`scale: created=${out.created.filter((c) => c.ok).reduce((a, c) => a + c.count, 0)} catalogue=${total} best=${best ? best.msPerProduct + "ms/product @" + best.pageSize : "none"} markersAgree=${!out.markerDisagreement.length} | faults=${FAULTS.length}`);
}

/** CLOSE — the four blockers an adversarial review of round 3 raised against P1 sign-off.
 *  Each section exists because a round-3 claim was CIRCULAR or UNVERIFIED, not because the
 *  entity was unprobed. --write; self-cleaning, and it RE-QUERIES its own cleanup. */
async function probeClose() {
  requireWrite();
  const out = { sections: {}, cleanup: {} };
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const first = (x) => arr(x)[0] ?? null;
  const stamp = Date.now();
  await connect();

  // ---- A. Is the User read TRUNCATED, or were the fields simply never populated?
  // R23 claimed truncation from a create that never SENT a Shipping* field — circular, and it
  // contradicts R26 (empty fields are omitted per record). Send a FULL shipping address and see.
  {
    const s = { why: "R23's truncation claim was circular: the create omitted every field it then reported missing." };
    const F = wsdlType("User").join(",");
    await tryCall("User_SetFields", { Fields: F });
    const email = `probe-ship-${stamp}@example.invalid`;
    const mk = await tryCall("User_CreateOrUpdate", { UserData: {
      Username: email, Email: email, Password: `Pr0be${stamp}x`, UserGroupId: 1,
      Firstname: "Probe", Lastname: "Shipping", Address: "Testvej 1", Zip: "8000", City: "Aarhus",
      CountryCode: 1, LanguageISO: "DK", Newsletter: true, Consent: true,
      ConsentDate: "2024-03-01 12:00:00", Approved: true,
      Description: "probe description", Site: 1,
      // the fields R23 declared truncated — now actually POPULATED
      ShippingType: "1", ShippingFirstname: "Ship", ShippingLastname: "Recipient",
      ShippingCompany: "Probe ApS", ShippingCvr: "12345678", ShippingEan: "5790000000000",
      ShippingAddress: "Leveringsvej 2", ShippingAddress2: "2. sal", ShippingZip: "8200",
      ShippingCity: "Aarhus N", ShippingCountry: "Danmark", ShippingCountryCode: 1,
      ShippingState: "", ShippingPhone: "+4512345678", ShippingMobile: "+4587654321",
      ShippingEmail: `ship-${stamp}@example.invalid`, ShippingReferenceNumber: "REF-1" } });
    s.create = { ok: mk.ok, fault: mk.ok ? null : `${mk.code}: ${mk.message}` };
    const all = await tryCall("User_GetAll");
    const mine = arr(all.result).filter(Boolean).filter((u) => String(u?.Username ?? "").includes(String(stamp)));
    const rec = first(mine);
    s.readBack = Boolean(rec);
    const SENT = ["ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingAddress",
      "ShippingZip", "ShippingCity", "ShippingCountryCode", "ShippingPhone", "ShippingEmail",
      "ShippingReferenceNumber", "Description", "Site"];
    s.perField = SENT.map((f) => ({ field: f, present: rec ? f in rec : null,
      value: rec && f in rec ? (String(rec[f]).length ? "<non-empty>" : "<empty>") : null }));
    s.returnedCount = rec ? Object.keys(rec).length : 0;
    s.audit = fieldAudit(F, mine);
    const anyShippingBack = s.perField.filter((x) => x.field.startsWith("Shipping")).some((x) => x.present);
    s.verdict = !rec ? "Customer not read back — nothing settled."
      : anyShippingBack
      ? `NOT TRUNCATED. Populated Shipping* fields DO come back (${s.perField.filter((x) => x.present).length}/${SENT.length} of the sent fields present). R23 was wrong: the earlier absence was empty-value omission (R26), not a dropped column.`
      : `TRUNCATED CONFIRMED. Shipping* fields were POPULATED on create and still did not come back — this is a real dropped column, and a migration would lose every delivery address.`;
    for (const u of mine) { const d = await tryCall("User_Delete", { UserId: Number(u.Id) }); out.cleanup.customerDeleted = d.ok ? `deleted ${u.Id}` : `${d.code}: ${d.message}`; }
    out.sections.userTruncation = s;
  }

  // ---- B. `guest` — in the server's own vocabulary, never swept. R22's public-price rule gives
  // it no branch, so a guest row would be silently dropped. Also confirm that an OMITTED
  // UserType really defaults to "all", and delete with the right argument name this time.
  {
    const s = { why: "R22 swept 10 UserType values but not `guest`, which the server itself names." };
    const cat = Number(process.env.DD_PROBE_CATEGORY || 9);
    const itemNo = `PROBE-GUEST-${stamp}`;
    const mk = await tryCall("Product_CreateOrUpdate", { ProductData: {
      CategoryId: cat, ItemNumber: itemNo, Title: "PROBE guest price-line carrier",
      Price: 100, Online: true, Status: true, Stock: 10, LanguageISO: "DK" } });
    s.carrierCreate = mk.ok;
    await tryCall("Product_SetFields", { Fields: "Id,ItemNumber,Title,Price" });
    const look = await tryCall("Product_GetByItemNumber", { ItemNumber: itemNo });
    const pid = Number(first(look.result)?.Id ?? 0);
    s.carrierProductId = pid || null;
    if (pid) {
      const rows = [
        { label: "guest scope", args: { UserType: "guest", UserId: 0, Price: 55 } },
        { label: "guest with a group id", args: { UserType: "guest", UserId: 4, Price: 56 } },
        { label: "UserType OMITTED", args: { UserId: 0, Price: 77 } },
      ];
      s.creates = [];
      for (const r of rows) {
        const c = await tryCall("Product_CreateDiscount", { ProductDiscountData: {
          ProductId: pid, Amount: 1, Discount: 0, Currency: "1", DiscountType: "b",
          Accumulate: false, ...r.args } });
        s.creates.push({ ...r, ok: c.ok, fault: c.ok ? null : `${c.code}: ${c.message}` });
      }
      const back = await tryCall("Product_GetDiscounts", { ProductId: pid });
      const got = arr(back.result).filter(Boolean);
      s.rows = got.map((r) => ({ Price: r?.Price, UserType: r?.UserType, UserId: r?.UserId }));
      s.guestAccepted = s.creates.find((c) => c.label === "guest scope")?.ok ?? null;
      const omitted = got.find((r) => String(r?.Price) === "77");
      s.omittedUserTypeStoredAs = omitted ? omitted.UserType : null;
      s.guestRowsPresent = got.filter((r) => String(r?.UserType) === "guest").length;
      s.verdict = `guest accepted: ${s.guestAccepted}. An OMITTED UserType is stored as "${s.omittedUserTypeStoredAs}". ` +
        (s.guestRowsPresent
          ? `${s.guestRowsPresent} guest row(s) read back — R22's rule (UserType==="all" && UserId==="0") would DROP them silently, so guest needs its own branch.`
          : "No guest row read back — guest may be accepted but not stored, or not readable here.");
      // R27: the argument is ProductItemNumber (a STRING), not ProductId. Then RE-QUERY.
      const del = await tryCall("Product_DeleteAllDiscounts", { ProductItemNumber: itemNo });
      const after = await tryCall("Product_GetDiscounts", { ProductId: pid });
      const left = arr(after.result).filter(Boolean).length;
      s.deleteAllDiscounts = { ok: del.ok, fault: del.ok ? null : `${del.code}: ${del.message}`,
        rowsBefore: got.length, rowsAfterReQuery: left, actuallyCleared: left === 0 };
      out.cleanup.priceLines = s.deleteAllDiscounts.actuallyCleared
        ? `verified clear by re-query (was ${got.length}, now 0)` : `STILL ${left} rows after delete`;
      const dp = await tryCall("Product_Delete", { ProductId: pid });
      out.cleanup.carrierProductDeleted = dp.ok ? `deleted ${pid}` : `${dp.code}: ${dp.message}`;
    }
    out.sections.guestScope = s;
  }

  // ---- C. Option-value ORDER. R25 said GetVariantTypeValues(VariantId) is the op to use, but it
  // returns only {Id, Title, ProductVariantTypeId, Color} — no Sorting, no Picture. Shopify needs
  // option-value order, so fetch the GLOBAL list for the type the real variants belong to (2).
  {
    const s = { why: "R25's link op drops Sorting/Picture; only Farve (type 1) values were ever listed globally." };
    s.byType = [];
    for (const t of [1, 2, 3]) {
      const r = await tryCall("Product_GetVariantTypeValuesByType", { VariantTypeId: t });
      const rows = arr(r.result).filter(Boolean);
      s.byType.push({ variantTypeId: t, ok: r.ok, fault: r.ok ? null : `${r.code}: ${r.message}`,
        values: rows.map((v) => ({ Id: v?.Id, Title: v?.Title, Sorting: v?.Sorting, Color: v?.Color, Picture: v?.Picture })) });
    }
    const t2 = s.byType.find((x) => x.variantTypeId === 2);
    const wanted = ["4", "5", "8"];                       // the Størrelse values the variants use
    s.sortingForRealVariantValues = t2 ? t2.values.filter((v) => wanted.includes(String(v.Id))) : [];
    s.verdict = s.sortingForRealVariantValues.length
      ? `Option-value ORDER recovered for the values the real variants use: ${s.sortingForRealVariantValues.map((v) => `${v.Title}=${v.Sorting}`).join(", ")}. Mapping = link via Product_GetVariantTypeValues(VariantId), then JOIN to Product_GetVariantTypeValuesByType(TypeId) for Sorting and Picture.`
      : "Could not recover Sorting for the Størrelse values — Shopify option ORDER is still unsourced.";
    out.sections.optionValueOrder = s;
  }

  save("close", { ...out, faults: FAULTS,
    verdict: [out.sections.userTruncation?.verdict, out.sections.guestScope?.verdict,
      out.sections.optionValueOrder?.verdict].filter(Boolean).join(" || "),
    interpret: "Each section exists because an adversarial review found a round-3 claim circular or unverified. cleanup.priceLines is RE-QUERIED, not inferred from a reply code — that was one of the review's findings." });
  p(`close: shippingBack=${out.sections.userTruncation?.perField?.filter((x) => x.present).length ?? "-"} | guest=${out.sections.guestScope?.guestAccepted} omittedAs=${out.sections.guestScope?.omittedUserTypeStoredAs} | discountsCleared=${out.sections.guestScope?.deleteAllDiscounts?.actuallyCleared} | sorting=${out.sections.optionValueOrder?.sortingForRealVariantValues?.length ?? 0} | faults=${FAULTS.length}`);
}

/** PAGEBASE — is a Page/PageSize walk 0-based or 1-based? P1b's H3 gate refuses to guess,
 *  because guessing wrong skips an ENTIRE page and still reports a complete read. P1 never
 *  completed a *WithPagination call, so nothing recorded the answer.
 *
 *  NON-CIRCULAR BY CONSTRUCTION. This probe does NOT use client.js's detectPageBase — that
 *  would test the client against itself. It builds an INDEPENDENT TRUTH SET first
 *  (Order_GetByDate with Status omitted returns every order — R16, recorded in gaps.json), then
 *  walks the paged op from base 0 and from base 1 and asks which walk reproduces that truth set
 *  exactly once per record. The answer is decided by set comparison, not by a reply code. */
async function probePageBase() {
  await connect();
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const idsOf = (r) => arr(r).filter(Boolean).map((o) => String(o?.Id ?? "")).filter(Boolean);
  const out = { op: "Order_GetAllWithPagination" };
  await tryCall("Order_SetFields", { Fields: "Id,Status,Total" });

  // --- 1. the TRUTH SET, from a completely different operation (R16: Status is optional)
  const truth = await tryCall("Order_GetByDate", { Start: "2000-01-01 00:00:00", End: "2100-01-01 00:00:00" });
  const truthIds = idsOf(truth.result);
  out.truth = { op: "Order_GetByDate", ok: truth.ok, count: truthIds.length, ids: truthIds,
    fault: truth.ok ? null : `${truth.code}: ${truth.message}` };
  if (!truthIds.length) {
    save("pagebase", { ...out, faults: FAULTS,
      verdict: "NO TRUTH SET — Order_GetByDate returned nothing, so a paged walk cannot be checked against a known answer. Page base UNRESOLVED.",
      interpret: "Without an independent full list there is nothing to compare a walk to, and comparing a walk to itself proves nothing." });
    p("pagebase: no truth set — UNRESOLVED"); return;
  }

  // --- 2. the two candidate FIRST pages, raw
  const SIZE = Number(process.env.DD_PAGEBASE_SIZE || 5);
  out.pageSize = SIZE;
  const first = {};
  for (const page of [0, 1]) {
    const r = await tryCall("Order_GetAllWithPagination", { Page: page, PageSize: SIZE });
    first[page] = { ok: r.ok, fault: r.ok ? null : `${r.code}: ${r.message}`, ids: r.ok ? idsOf(r.result) : [] };
  }
  out.firstPages = first;

  // --- 3. walk from each candidate base until a page comes back empty
  const walk = async (base) => {
    const seen = [], pages = [];
    for (let i = 0; i < 12; i++) {
      const r = await tryCall("Order_GetAllWithPagination", { Page: base + i, PageSize: SIZE });
      if (!r.ok) { pages.push({ page: base + i, fault: `${r.code}: ${r.message}` }); break; }
      const ids = idsOf(r.result);
      pages.push({ page: base + i, rows: ids.length });
      if (!ids.length) break;
      seen.push(...ids);
    }
    const uniq = [...new Set(seen)];
    const missing = truthIds.filter((x) => !uniq.includes(x));
    const extra = uniq.filter((x) => !truthIds.includes(x));
    const dupes = seen.length - uniq.length;
    return { base, pages, collected: seen.length, unique: uniq.length, duplicates: dupes,
      missing, extra, reproducesTruth: dupes === 0 && missing.length === 0 && extra.length === 0 };
  };
  out.walks = { 0: await walk(0), 1: await walk(1) };

  // --- 4. decide by SET COMPARISON, and refuse to guess when both or neither fit
  const w0 = out.walks[0], w1 = out.walks[1];
  let base = null, why = "";
  if (w0.reproducesTruth && !w1.reproducesTruth) { base = 0; why = `walking from 0 reproduced all ${truthIds.length} orders exactly once; walking from 1 did not (missing ${w1.missing.length}).`; }
  else if (w1.reproducesTruth && !w0.reproducesTruth) { base = 1; why = `walking from 1 reproduced all ${truthIds.length} orders exactly once; walking from 0 did not (${w0.duplicates} duplicate(s), ${w0.extra.length} extra).`; }
  else if (w0.reproducesTruth && w1.reproducesTruth) { why = "BOTH walks reproduced the truth set — the server clamps out-of-range pages, so the two bases are indistinguishable by this method."; }
  else { why = `NEITHER walk reproduced the truth set (base0 missing ${w0.missing.length}/dupes ${w0.duplicates}; base1 missing ${w1.missing.length}/dupes ${w1.duplicates}).`; }
  out.decided = base !== null; out.base = base; out.why = why;

  // --- 5. EVERY Page/PageSize operation, not just this one.
  //
  //     The first run of this probe settled ONE operation and then a second one was spot-checked
  //     with `Page: 1` and "it returned rows" — which is not evidence: a 0-based server answers
  //     Page=1 with its SECOND page, rows and all. That check could not have failed, so it proved
  //     nothing, and shipping base 1 as a default for the other four operations on the strength of
  //     it would be exactly the extrapolation H3's gate exists to stop.
  //
  //     So: derive the operation list from the WSDL (an input element whose sequence carries both
  //     Page and PageSize), and give each one the same two-observation test. The op list is a
  //     schema fact, not a hand-kept list that can drift.
  const pageOps = wsdlPageOps();
  out.pageOpsFromWsdl = pageOps.map((o) => o.op);
  const WIDE = { Start: "2000-01-01 00:00:00", End: "2100-01-01 00:00:00" };
  const isArity = (m) => /Too few arguments|expects exactly|passed in .* on line/i.test(String(m));

  // R27: an argument name the server does not know is DROPPED silently and resurfaces as a PHP
  // arity error, so nothing outside `argNames` may be invented here. Where the WSDL declares
  // Status the FIRST variant OMITS it — that is the recorded behaviour (R16: omitting Status on
  // Order_GetByDate returns every order, which is how the truth set above was built), and "" is
  // the guess. A second variant supplies a concrete status only if the first says nothing.
  const argVariants = (argNames) => {
    const fixed = {};
    if (argNames.includes("Start")) fixed.Start = WIDE.Start;
    if (argNames.includes("End")) fixed.End = WIDE.End;
    if (!argNames.includes("Status")) return [{ name: "declared-args", args: fixed }];
    return [
      { name: "status-omitted", args: { ...fixed } },
      { name: "status-0", args: { ...fixed, Status: "0" } },
    ];
  };

  const attempt = async (op, args, page) => {
    const r = await tryCall(op, { ...args, Page: page, PageSize: SIZE });
    return { page, ok: r.ok, code: r.ok ? null : r.code, fault: r.ok ? null : `${r.code}: ${r.message}`,
      arity: r.ok ? false : isArity(r.message), rows: r.ok ? idsOf(r.result).length : null,
      ids: r.ok ? idsOf(r.result) : [] };
  };

  const sweepOne = async (op, argNames) => {
    const tried = [];
    for (const v of argVariants(argNames)) {
      const z = await attempt(op, v.args, 0);
      const o = await attempt(op, v.args, 1);
      const [opBase, opWhy] = classifyPageProbes(z, o);
      tried.push({ variant: v.name, sentArgs: Object.keys({ ...v.args, Page: 0, PageSize: SIZE }), probes: [z, o], base: opBase, why: opWhy });
      if (opBase !== null) break;   // decisive — do not spend more calls on the same question
    }
    const winner = tried.find((t) => t.base !== null) ?? tried[tried.length - 1];
    return { op, argNames, attempts: tried, variantUsed: winner.variant,
      base: winner.base, decided: winner.base !== null, why: winner.why };
  };

  const sweep = [];
  for (const { op, args } of pageOps) sweep.push(await sweepOne(op, args));
  out.allPageOps = sweep;

  const decidedOps = sweep.filter((s) => s.decided);
  const bases = [...new Set(decidedOps.map((s) => s.base))];
  const silent = sweep.filter((s) => !s.decided).map((s) => s.op);
  out.agreement = {
    total: sweep.length,
    decided: decidedOps.map((s) => ({ op: s.op, base: s.base })),
    silent,
    unanimous: bases.length === 1,
    base: bases.length === 1 ? bases[0] : null,
    // The walk in step 3 and the sweep are two different methods; if they disagree, say so.
    agreesWithWalk: base === null ? null : bases.length === 1 && bases[0] === base,
  };

  const sweepLine = out.agreement.unanimous
    ? `All ${decidedOps.length} of ${sweep.length} Page/PageSize operations that could answer agree on base ${out.agreement.base}` +
      (silent.length ? ` (${silent.length} carried no evidence: ${silent.join(", ")})` : "")
    : `PAGE OPS DISAGREE: ${decidedOps.map((s) => `${s.op}=${s.base}`).join(", ")} — the base is PER-OPERATION, not per-API`;

  // --- 6. a SECOND finding fell out of the sweep, and it is not about page numbers.
  //     Omitting the nillable `Status` argument on the *WithPagination variants is an ARITY error,
  //     not an empty selection — so R16 ("Status is optional on Order_GetByDate", which is how the
  //     truth set above was built) does NOT extend to them. A reader who generalised R16 would
  //     write an exporter that faults on every paged order read.
  const statusOps = sweep.filter((s) => s.argNames.includes("Status"));
  const statusOmissionFaults = statusOps.filter((s) =>
    s.attempts.some((a) => a.variant === "status-omitted" && a.probes.some((x) => x.arity)));
  out.statusOnPaginatedVariants = {
    opsWithStatus: statusOps.map((s) => s.op),
    omittingStatusFaults: statusOmissionFaults.map((s) => s.op),
    rule: statusOmissionFaults.length === statusOps.length && statusOps.length > 0
      ? "Status is REQUIRED on every *WithPagination variant: omitting it returns a PHP arity error " +
        "(Too few arguments), NOT an empty selection. R16's 'Status is optional' holds for " +
        "Order_GetByDate and does NOT extend to the paginated forms. Send Status explicitly."
      : "mixed or no result — see omittingStatusFaults",
  };

  // Faults are the evidence here, not noise, so the verdict names them rather than reading clean.
  const paramFaults = FAULTS.filter((f) => /must be greater than 0/i.test(String(f.message)));
  const arityFaults = FAULTS.filter((f) => /Too few arguments/i.test(String(f.message)));
  const faultLine = `${FAULTS.length} fault(s) RECORDED, and they are the evidence: ` +
    `${paramFaults.length} are the server REJECTING Page=0 with its own "Page must be greater than 0" ` +
    `across ${new Set(paramFaults.map((f) => f.op)).size} operation(s); ${arityFaults.length} are PHP arity ` +
    "errors from omitting the nillable Status argument, which is the separate finding in " +
    "statusOnPaginatedVariants. None is unexplained.";

  save("pagebase", { ...out, faults: FAULTS,
    verdict: base === null
      ? `PAGE BASE UNRESOLVED. ${why} H3's gate stays closed: client.js must keep refusing to page without an explicit { pageBase }. ${sweepLine}. ${faultLine}`
      : `PAGE BASE = ${base}. ${why} Decided by comparing each walk against an INDEPENDENT truth set from Order_GetByDate, not by a reply code or by the client's own detector. ${sweepLine}. ${faultLine}`,
    interpret: "Bound: ONE shop (shop000000). The walk settles Order_GetAllWithPagination against an " +
      "independent truth set; the sweep asks every Page/PageSize operation the WSDL declares whether " +
      "it agrees. An op whose result set is empty answers nothing and is listed as silent, not as " +
      "agreeing. Treat the result as the platform default only until a SECOND SHOP agrees, and keep " +
      "{ pageBase } overridable on every call." });
  p(`pagebase: truth=${truthIds.length} base0.ok=${w0.reproducesTruth} base1.ok=${w1.reproducesTruth} -> ${base === null ? "UNRESOLVED" : "BASE " + base} | sweep: ${sweepLine} | statusRequiredOnPaged=${statusOmissionFaults.length}/${statusOps.length} | faults=${FAULTS.length}`);
}

/**
 * What two observations — Page=0 and Page=1 — can and cannot mean. Module-level and EXPORTED so
 * the table is testable offline: a mis-ordered branch here would produce a confident wrong answer
 * that live output looks exactly like, which is the failure mode this whole probe exists to avoid.
 *
 * `[base, why]`, and `base` is null wherever the pair does not force a single reading. Each
 * observation is `{ ok, fault, arity, rows, ids }`.
 */
export function classifyPageProbes(z, o) {
  const sameIds = z.ok && o.ok && z.ids.length > 0 && JSON.stringify(z.ids) === JSON.stringify(o.ids);
  if (z.arity || o.arity) {
    return [null, "ARGUMENTS UNRESOLVED — the server answered a PHP arity error, so the call never " +
      "reached the paging code (R17/R27). Not evidence either way."];
  }
  if (!z.ok && o.ok) return [1, `the server REJECTED Page=0 in its own words ("${z.fault}") and accepted Page=1.`];
  if (z.ok && !o.ok) return [null, `INCONSISTENT — Page=0 was accepted but Page=1 faulted ("${o.fault}"). Recorded, not interpreted.`];
  if (!z.ok && !o.ok) return [null, `BOTH pages faulted ("${z.fault}" / "${o.fault}") — no statement about page numbering.`];
  if (z.rows === 0 && o.rows === 0) {
    return [null, "both candidate first pages returned ZERO rows: this selection is empty, so it " +
      "carries no evidence. Not a base."];
  }
  if (z.rows === 0) return [1, "Page=0 returned zero rows and Page=1 returned rows."];
  if (o.rows === 0) return [0, "Page=0 returned rows and Page=1 returned none: page 0 is the first page."];
  if (sameIds) {
    return [null, "Page=0 and Page=1 returned the SAME rows — the server clamps, so the two bases " +
      "are indistinguishable for this op."];
  }
  return [0, "Page=0 and Page=1 returned DIFFERENT rows, so page 0 is a real first page."];
}

/** Every operation whose WSDL input sequence carries BOTH Page and PageSize, with its declared
 *  argument names in order. Derived from the saved WSDL so the list cannot drift from the schema
 *  — and so this probe never has to trust src/dandomain/operations.js, which is generated from
 *  the same document and would make the cross-check circular. */
export function wsdlPageOps() {
  let xml = "";
  try { xml = readFileSync(path.join(OUT, "service.wsdl"), "utf8"); } catch { return []; }
  const found = [];
  for (const m of xml.matchAll(/<xsd:element name="([A-Za-z0-9_]+)">\s*<xsd:complexType>\s*<xsd:sequence>([\s\S]*?)<\/xsd:sequence>/g)) {
    const args = [...m[2].matchAll(/<xsd:element name="([^"]+)"/g)].map((a) => a[1]);
    if (args.includes("Page") && args.includes("PageSize")) found.push({ op: m[1], args });
  }
  return found;
}

/** P2 — the four "cheap wins" the P2 start prompt named, each one probe, each one currently
 *  recorded as open and non-blocking. Written so that every section can come out the OTHER way:
 *
 *  A. THE PUBLIC-PRICE RULE against the ANONYMOUS storefront (R29). This is a MONEY rule that has
 *     never been checked against the channel it describes. Two public-eligible price lines are
 *     created on one carrier product at three mutually distinct, unlikely numbers — the list
 *     price, an `all`/UserId 0 row and a `guest`/UserId 0 row — and the logged-out storefront is
 *     then asked which one it serves. Whichever number appears IS the answer; if the list price
 *     appears, price lines with UserId 0 do not reach anonymous visitors at all, which is a
 *     bigger finding than either candidate; if NONE appears, the channel cannot settle it and the
 *     section says INCONCLUSIVE. The heimdal theme is a JS shell (standing operating note), so
 *     inconclusive is a real possible outcome and is recorded as one rather than hidden.
 *  B. `DiscountType` "a"/"b" (R20/R22), by the one method that has worked on this server: send an
 *     invalid value and read the enumeration out of the fault. R22 got the UserType vocabulary
 *     exactly this way. If the server accepts an obvious nonsense value instead, then the field
 *     is NOT validated and the fault method cannot answer it — also recorded.
 *  C. The `PageText` folder-id UPPER BOUND (R15). GraphQL `folders` answers it authoritatively;
 *     the SOAP sweep can only ever say "nothing above the number I happened to try".
 *  D. `Consent: false` on a customer (R23). `ConsentDate: ""` is REJECTED, so the create must
 *     OMIT the field — that is the whole question, and it is one create.
 *
 *  SAFETY: writes go to DD_PROBE_SHOP only. Synthetic customers use example.invalid (RFC 2606).
 *  No Order_* call of any kind. Cleanup is verified by RE-QUERY, never by a reply code (R30). */
async function probeP2() {
  requireWrite();
  await connect();
  const out = { sections: {}, cleanup: {} };
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const first = (x) => arr(x)[0] ?? null;
  const stamp = Date.now();

  // ---- A. the public price, against the anonymous storefront -------------------------------
  {
    const s = { question: "Which price does a LOGGED-OUT visitor pay: the `all` row, the `guest` row, or Product.Price?" };
    // Three numbers that cannot collide with a date, an id, a VAT rate or each other, and that
    // are unlikely to occur anywhere else in a page's markup.
    const LIST = 3771, ALL = 2221, GUEST = 1117;
    s.numbers = { list: LIST, all: ALL, guest: GUEST };
    const cat = await ensureCategory();
    const item = `PROBE-PP-${stamp}`;
    const mk = await tryCall("Product_CreateOrUpdate", { ProductData: {
      ItemNumber: item, Title: `PROBE public price ${stamp}`, LanguageISO: "DK",
      Price: LIST, Status: true, Online: true, Stock: 99, CategoryId: Number(cat?.Id) } });
    s.productCreated = mk.ok;
    await tryCall("Product_SetFields", { Fields: "Id,ItemNumber,Title,Price,Status,Online,SeoLink" });
    const back = await tryCall("Product_GetByItemNumber", { ItemNumber: item });
    const prod = first(back.result);
    s.productId = prod?.Id ?? null;
    s.seoLink = prod?.SeoLink ?? null;

    if (s.productId) {
      const pid = Number(s.productId);
      const line = async (userType, userId, price) => tryCall("Product_CreateDiscount", { ProductDiscountData: {
        ProductId: pid, ProductVariantId: 0, Amount: 1, Price: price, Discount: 0,
        Currency: "DKK", DiscountType: "b", UserType: userType, UserId: userId,
        Date: false, DateFrom: "", DateTo: "" } });
      const a = await line("all", 0, ALL);
      const g = await line("guest", 0, GUEST);
      s.lines = { all: { ok: a.ok, fault: a.ok ? null : `${a.code}: ${a.message}` },
                  guest: { ok: g.ok, fault: g.ok ? null : `${g.code}: ${g.message}` } };
      const rows = await tryCall("Product_GetDiscounts", { ProductId: pid });
      s.readBack = arr(rows.result).map((r) => ({ Id: r?.Id, UserType: r?.UserType, UserId: r?.UserId, Price: r?.Price, DiscountType: r?.DiscountType }));

      // The anonymous channel. No cookies, no auth, a plain browser UA.
      const tenant = PROBE_SHOP || "";
      const tpl = process.env.DD_STOREFRONT_PRODUCT_URL || "";
      const urls = [];
      if (tpl.includes("{id}")) urls.push(tpl.replace("{id}", String(pid)));
      for (const host of [`https://${tenant}.mywebshop.io`, `https://${tenant}.webshop.dandomain.dk`]) {
        if (!tenant) continue;
        urls.push(`${host}/heimdal/products/${pid}`);
        urls.push(`${host}/shop/product/${pid}`);
      }
      const hit = (text) => ({
        list: text.includes(String(LIST)), all: text.includes(String(ALL)), guest: text.includes(String(GUEST)),
      });
      s.fetches = [];
      for (const url of [...new Set(urls)].slice(0, 8)) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "follow",
            headers: { "user-agent": "Mozilla/5.0 (shoplift-probe)", accept: "text/html,application/json;q=0.9" } });
          const text = new TextDecoder("utf-8").decode(new Uint8Array(await res.arrayBuffer()));
          s.fetches.push({ url, status: res.status, bytes: text.length, contentType: res.headers.get("content-type"), found: hit(text) });
        } catch (e) { s.fetches.push({ url, error: e.message }); }
      }
      const found = s.fetches.filter((f) => f.found).map((f) => f.found);
      const any = (k) => found.some((f) => f[k]);
      s.anyNumberSeen = any("list") || any("all") || any("guest");
      s.verdict = !s.anyNumberSeen
        ? `INCONCLUSIVE. None of the three prices (${LIST}/${ALL}/${GUEST}) appears in any anonymous response — the heimdal theme is a JS shell, so this channel cannot answer the question. The R29 rule stays UNCONFIRMED and the adapter's warning stays. What IS settled: an \`all\`+UserId 0 row and a \`guest\`+UserId 0 row can coexist on one product (readBack has both), so the rule has something to choose BETWEEN.`
        : any("guest") && !any("all")
          ? `GUEST WINS. The anonymous storefront serves ${GUEST}, the \`guest\`/UserId 0 row — not \`all\` (${ALL}) and not Product.Price (${LIST}). R29's rule must keep \`guest\` and should PREFER it.`
          : any("all") && !any("guest")
            ? `ALL WINS. The anonymous storefront serves ${ALL}, the \`all\`/UserId 0 row — not \`guest\` (${GUEST}). R29's rule is right to include \`all\`; whether \`guest\` ever reaches an anonymous visitor is still open.`
            : any("list") && !any("all") && !any("guest")
              ? `NEITHER. The anonymous storefront serves Product.Price (${LIST}) and IGNORES both UserId 0 price lines. That is a bigger finding than either candidate: the public price is Product.Price, and R29's whole rule would be selecting a price no visitor is charged.`
              : `AMBIGUOUS — more than one of the three numbers appears in the same response, so a substring match cannot decide. See .fetches for which. Treat as inconclusive.`;

      // Cleanup, VERIFIED BY RE-QUERY (R30: the reply code is not a state observation).
      const del = await tryCall("Product_DeleteAllDiscounts", { ProductItemNumber: item });
      const after = await tryCall("Product_GetDiscounts", { ProductId: pid });
      out.cleanup.priceLines = { deleteOk: del.ok, before: s.readBack.length, after: arr(after.result).length };
      const dp = await tryCall("Product_Delete", { ProductId: pid });
      const gone = await tryCall("Product_GetByItemNumber", { ItemNumber: item });
      out.cleanup.product = { deleteOk: dp.ok, stillPresent: arr(gone.result).filter(Boolean).length > 0 };
    } else {
      s.verdict = `NOT RUN — the carrier product could not be created (${mk.ok ? "read-back failed" : mk.message}).`;
    }
    out.sections.publicPrice = s;
  }

  // ---- B. the DiscountType vocabulary ------------------------------------------------------
  {
    const s = { question: "What does DiscountType 'a' vs 'b' mean, and is the field validated at all?" };
    const cat = await ensureCategory();
    const item = `PROBE-DT-${stamp}`;
    await tryCall("Product_CreateOrUpdate", { ProductData: { ItemNumber: item, Title: `PROBE discount type ${stamp}`,
      LanguageISO: "DK", Price: 500, Status: true, Online: true, Stock: 9, CategoryId: Number(cat?.Id) } });
    await tryCall("Product_SetFields", { Fields: "Id,ItemNumber,Price" });
    const prod = first((await tryCall("Product_GetByItemNumber", { ItemNumber: item })).result);
    s.productId = prod?.Id ?? null;
    if (s.productId) {
      const pid = Number(s.productId);
      s.sweep = [];
      for (const dt of ["a", "b", "c", "p", "%", "amount", "percent", "zzz-not-a-type", ""]) {
        const r = await tryCall("Product_CreateDiscount", { ProductDiscountData: {
          ProductId: pid, ProductVariantId: 0, Amount: 1, Price: 400, Discount: 10, Currency: "DKK",
          DiscountType: dt, UserType: "all", UserId: 0, Date: false, DateFrom: "", DateTo: "" } });
        s.sweep.push({ sent: dt, accepted: r.ok, fault: r.ok ? null : `${r.code}: ${r.message}` });
      }
      const rows = arr((await tryCall("Product_GetDiscounts", { ProductId: pid })).result);
      s.storedAs = rows.map((r) => ({ Id: r?.Id, sentOrder: null, DiscountType: r?.DiscountType, Price: r?.Price, Discount: r?.Discount }));
      const rejected = s.sweep.filter((x) => !x.accepted);
      // The enumeration, if the server states one — the R22 method.
      const enumeration = rejected.map((x) => /must be one of ([^"]+)/i.exec(x.fault || "")?.[1]).find(Boolean) ?? null;
      s.serverEnumeration = enumeration;
      s.verdict = enumeration
        ? `DECODED BY FAULT: the server states its own DiscountType vocabulary as "${enumeration}". Every value outside it must be treated as UNKNOWN, exactly as R22 did for UserType.`
        : rejected.length === 0
          ? `NOT VALIDATED. The server accepted every value tried, INCLUDING "zzz-not-a-type" and "". So DiscountType has no server-side vocabulary to read out of a fault, and the a/b meaning cannot be decoded this way — it has to come from the storefront or the admin. The rows stored as ${JSON.stringify([...new Set(s.storedAs.map((r) => r.DiscountType))])}.`
          : `PARTIAL. ${rejected.length} value(s) were rejected but no fault named an enumeration. Faults: ${JSON.stringify(rejected.map((x) => x.fault).slice(0, 3))}.`;
      const del = await tryCall("Product_DeleteAllDiscounts", { ProductItemNumber: item });
      const after = arr((await tryCall("Product_GetDiscounts", { ProductId: pid })).result);
      out.cleanup.discountTypeRows = { deleteOk: del.ok, before: rows.length, after: after.length };
      await tryCall("Product_Delete", { ProductId: pid });
      const gone = arr((await tryCall("Product_GetByItemNumber", { ItemNumber: item })).result).filter(Boolean);
      out.cleanup.discountTypeProduct = { stillPresent: gone.length > 0 };
    } else s.verdict = "NOT RUN — the carrier product could not be created.";
    out.sections.discountType = s;
  }

  // ---- C. the PageText folder upper bound --------------------------------------------------
  {
    const s = { question: "What is the folder-id upper bound the SOAP sweep can never establish?" };
    const id = process.env.DD_GQL_CLIENT_ID, secret = process.env.DD_GQL_CLIENT_SECRET;
    const tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;
    if (!id || !secret || !tenant) { s.verdict = "NOT RUN — DD_GQL_* not configured."; }
    else {
      try {
        const tokRes = await fetch(`https://${tenant}.mywebshop.io/auth/oauth/token`, {
          method: "POST", signal: AbortSignal.timeout(30000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }) });
        const tok = await tokRes.json();
        s.tokenOk = Boolean(tok?.access_token);
        if (!tok?.access_token) s.tokenError = JSON.stringify(tok).slice(0, 300);
        else {
          const q = `{ folders(input: { pagination: { limit: 200, page: 1 } }) { content { data { id name } pagination { total } } errors { __typename } } }`;
          const r = await fetch(`https://${tenant}.mywebshop.io/api/graphql/experimental`, {
            method: "POST", signal: AbortSignal.timeout(30000),
            headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token}` },
            body: JSON.stringify({ query: q }) });
          const body = await r.json();
          s.httpStatus = r.status;
          s.raw = JSON.stringify(body).slice(0, 1500);
          const rows = body?.data?.folders?.content?.data ?? null;
          s.folders = Array.isArray(rows) ? rows.map((f) => ({ id: f?.id, name: f?.name })) : null;
          s.total = body?.data?.folders?.content?.pagination?.total ?? null;
          const ids = (s.folders ?? []).map((f) => Number(f.id)).filter(Number.isFinite);
          s.maxId = ids.length ? Math.max(...ids) : null;
        }
      } catch (e) { s.error = e.message; }
      s.verdict = s.maxId !== null
        ? `BOUND ESTABLISHED: the shop has ${s.folders.length} PageText folders, highest id ${s.maxId}. A SOAP sweep must cover 0..${s.maxId}; the adapter should drive the sweep from THIS list rather than from a guessed range (R15).`
        : `UNRESOLVED — GraphQL folders did not return a usable list${s.error ? ` (${s.error})` : ""}. The SOAP sweep's bound remains "nothing above the number we happened to try", which is a silent-loss risk the adapter must keep declaring.`;
    }
    out.sections.pageFolderBound = s;
  }

  // ---- D. Consent: false -------------------------------------------------------------------
  {
    const s = { question: "Can a customer be created with Consent:false, given that ConsentDate:'' is rejected (R23)?" };
    const email = `probe-consent-${stamp}@example.invalid`;
    await tryCall("User_SetFields", { Fields: "Id,Username,Email,Consent,ConsentDate,Newsletter,Approved,Firstname,Lastname" });
    // The whole question: OMIT ConsentDate entirely. R23 recorded that sending "" faults with
    // `PARAM: ConsentDate '' is not a valid datetime`, which killed this case last round.
    const mk = await tryCall("User_CreateOrUpdate", { UserData: {
      Username: email, Email: email, Password: `Pr0be${stamp}x`, UserGroupId: 1,
      Firstname: "Probe", Lastname: "NoConsent", Address: "Testvej 9", Zip: "8000", City: "Aarhus",
      CountryCode: 1, LanguageISO: "DK", Newsletter: false, Consent: false, Approved: true } });
    s.create = { ok: mk.ok, fault: mk.ok ? null : `${mk.code}: ${mk.message}` };
    const all = arr((await tryCall("User_GetAll")).result).filter(Boolean);
    const rec = all.find((u) => String(u?.Username ?? "") === email) ?? null;
    s.readBack = rec ? { Consent: rec.Consent, ConsentDate: rec.ConsentDate, Newsletter: rec.Newsletter } : null;
    s.consentDateKeyPresent = rec ? ("ConsentDate" in rec) : null;
    s.verdict = !mk.ok
      ? `CONSENT:FALSE IS NOT CREATABLE this way — the create faulted with ${s.create.fault}. Omitting ConsentDate is not sufficient.`
      : !rec
        ? "Created without a fault but not readable back — nothing settled."
        : `CLOSED: Consent:false round-trips when ConsentDate is OMITTED (read back Consent=${JSON.stringify(rec.Consent)}, ConsentDate key ${s.consentDateKeyPresent ? `present as ${JSON.stringify(rec.ConsentDate)}` : "absent — an EMPTY VALUE per R26, not a dropped column"}). An importer must omit the field rather than send "".`;
    if (rec?.Id) {
      const d = await tryCall("User_Delete", { UserId: Number(rec.Id) });
      const left = arr((await tryCall("User_GetAll")).result).filter(Boolean).filter((u) => String(u?.Username ?? "") === email);
      out.cleanup.consentCustomer = { deleteOk: d.ok, stillPresent: left.length > 0 };
    }
    out.sections.consentFalse = s;
  }

  save("p2", { ...out, faults: FAULTS,
    verdict: [out.sections.publicPrice?.verdict, out.sections.discountType?.verdict,
      out.sections.pageFolderBound?.verdict, out.sections.consentFalse?.verdict].filter(Boolean).join(" || "),
    interpret: "Four independent questions, each with a stated falsifier. Section A can return ALL, GUEST, NEITHER or INCONCLUSIVE and each of those is a different finding; INCONCLUSIVE is a real outcome here because the heimdal theme renders in JS. Recorded faults are expected controls in section B (the sweep deliberately sends invalid values) and are listed above. Every cleanup below is verified by RE-QUERY, not by a reply code (R30)." });
  p(`p2: publicPrice=${out.sections.publicPrice?.anyNumberSeen ? "decided" : "inconclusive"} | discountTypeEnum=${out.sections.discountType?.serverEnumeration ?? "none"} | folders=${out.sections.pageFolderBound?.maxId ?? "-"} | consentFalse=${out.sections.consentFalse?.create?.ok} | faults=${FAULTS.length}`);
}

/** P2B — the two questions the `p2` run left open, each with the server's own error as the guide.
 *
 *  C'. `folders` — p2 sent the DOCUMENTED Convention-A shape and the server answered:
 *      `Field "pagination" is not defined by type FoldersInput` and
 *      `Cannot query field "data" on type "Folder"`. That is the server stating its own schema
 *      (the R22 method again), so this run re-derives the query FROM the fault rather than
 *      guessing a second time: `content` is a list of `Folder`, not a paginated wrapper.
 *      `graphql.js`'s QUERY_REGISTRY entry for `folders` carries `rowsPathVerified: false`, and
 *      this is what verifying it looks like.
 *
 *  A'. The anonymous price channel. The heimdal product page IS reachable
 *      (`{tenant}.webshop.dandomain.dk/heimdal/products/{id}` -> 200, 7460 bytes) and holds no
 *      prices, because it renders in JS. So this run reads the SHELL and asks what the shell
 *      fetches — script sources, JSON endpoints, any URL the markup names — and then tries those
 *      with the same three distinguishable prices. If none of them answers either, the finding is
 *      that this shop's anonymous channel cannot settle R29 without a browser, which is worth
 *      recording once so nobody spends a third round on it. */
async function probeP2b() {
  requireWrite();
  await connect();
  const out = { sections: {}, cleanup: {} };
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const first = (x) => arr(x)[0] ?? null;
  const stamp = Date.now();
  const tenant = process.env.DD_GQL_TENANT || PROBE_SHOP;

  // ---- C'. folders, with the query the server's own errors describe -------------------------
  {
    const s = { question: "How many PageText folders does this shop have, and what is the highest id?" };
    const id = process.env.DD_GQL_CLIENT_ID, secret = process.env.DD_GQL_CLIENT_SECRET;
    if (!id || !secret || !tenant) s.verdict = "NOT RUN — DD_GQL_* not configured.";
    else {
      try {
        const tokRes = await fetch(`https://${tenant}.mywebshop.io/auth/oauth/token`, {
          method: "POST", signal: AbortSignal.timeout(30000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }) });
        const tok = await tokRes.json();
        if (!tok?.access_token) { s.tokenError = JSON.stringify(tok).slice(0, 300); }
        else {
          const ask = async (query) => {
            const r = await fetch(`https://${tenant}.mywebshop.io/api/graphql/experimental`, {
              method: "POST", signal: AbortSignal.timeout(30000),
              headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token}` },
              body: JSON.stringify({ query }) });
            return { status: r.status, body: await r.json() };
          };
          // 1) the shape the server's errors imply, 2) an introspection of Folder so the
          //    field names come from the schema and not from me.
          s.introspect = await ask(`{ __type(name: "Folder") { fields { name type { name kind ofType { name } } } } }`);
          const fields = (s.introspect.body?.data?.__type?.fields ?? []).map((f) => f.name);
          s.folderFields = fields.length ? fields : null;
          const selection = fields.length ? fields.filter((f) => ["id", "name", "title", "type", "pageType"].includes(f)).join(" ") : "id";
          s.query = `{ folders(input: {}) { content { ${selection || "id"} } errors { __typename } } }`;
          s.attempt = await ask(s.query);
          const rows = s.attempt.body?.data?.folders?.content ?? null;
          s.folders = Array.isArray(rows) ? rows : (rows ? [rows] : null);
          const ids = (s.folders ?? []).map((f) => Number(f?.id)).filter(Number.isFinite);
          s.maxId = ids.length ? Math.max(...ids) : null;
          s.count = s.folders?.length ?? null;
          s.errors = s.attempt.body?.errors ? JSON.stringify(s.attempt.body.errors).slice(0, 600) : null;
        }
      } catch (e) { s.error = e.message; }
      s.verdict = s.maxId !== null
        ? `BOUND ESTABLISHED: ${s.count} PageText folder(s), highest id ${s.maxId}. The adapter should drive PageText_GetByFolder from THIS list, not from a guessed 0..20 range (R15) — and \`folders\` is Convention A with a NON-paginated \`content\`, which corrects graphql.js's registry entry (it shipped rowsPath ["content","data"] with rowsPathVerified:false).`
        : `STILL UNRESOLVED${s.errors ? `: ${s.errors}` : s.error ? `: ${s.error}` : ""}. The SOAP sweep's bound stays "nothing above the number we happened to try".`;
    }
    out.sections.folders = s;
  }

  // ---- A'. what does the JS shell fetch? ----------------------------------------------------
  {
    const s = { question: "Is there ANY anonymous channel on this shop that states a product's price?" };
    const LIST = 3771, ALL = 2221, GUEST = 1117;
    s.numbers = { list: LIST, all: ALL, guest: GUEST };
    const cat = await ensureCategory();
    const item = `PROBE-PP2-${stamp}`;
    await tryCall("Product_CreateOrUpdate", { ProductData: { ItemNumber: item, Title: `PROBE public price 2 ${stamp}`,
      LanguageISO: "DK", Price: LIST, Status: true, Online: true, Stock: 99, CategoryId: Number(cat?.Id) } });
    await tryCall("Product_SetFields", { Fields: "Id,ItemNumber,Price,SeoLink" });
    const prod = first((await tryCall("Product_GetByItemNumber", { ItemNumber: item })).result);
    s.productId = prod?.Id ?? null;
    if (!s.productId) { s.verdict = "NOT RUN — carrier product not created."; out.sections.anonymousPrice = s; }
    else {
      const pid = Number(s.productId);
      const line = (ut, uid, price) => tryCall("Product_CreateDiscount", { ProductDiscountData: {
        ProductId: pid, ProductVariantId: 0, Amount: 1, Price: price, Discount: 0, Currency: "DKK",
        DiscountType: "b", UserType: ut, UserId: uid, Date: false, DateFrom: "", DateTo: "" } });
      await line("all", 0, ALL);
      await line("guest", 0, GUEST);

      const base = `https://${tenant}.webshop.dandomain.dk`;
      const page = `${base}/heimdal/products/${pid}`;
      const get = async (url, headers = {}) => {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: "follow",
            headers: { "user-agent": "Mozilla/5.0 (shoplift-probe)", ...headers } });
          const text = new TextDecoder("utf-8").decode(new Uint8Array(await r.arrayBuffer()));
          return { url, status: r.status, contentType: r.headers.get("content-type"), bytes: text.length, text };
        } catch (e) { return { url, error: e.message, text: "" }; }
      };
      const shell = await get(page);
      s.shell = { status: shell.status, bytes: shell.bytes, contentType: shell.contentType, error: shell.error ?? null };
      // Record the shell VERBATIM (it is 7 KB and contains no customer data) so the next round
      // does not have to re-fetch it to see what it references.
      s.shellHead = (shell.text || "").slice(0, 2500);
      const urls = new Set();
      for (const m of (shell.text || "").matchAll(/(?:src|href|action|data-url|content)\s*=\s*["']([^"']+)["']/gi)) urls.add(m[1]);
      for (const m of (shell.text || "").matchAll(/["'](\/[A-Za-z0-9_\-./]*(?:api|json|graphql|ajax|product)[A-Za-z0-9_\-./]*)["']/gi)) urls.add(m[1]);
      s.referencedUrls = [...urls].slice(0, 60);

      const candidates = [
        `${base}/api/products/${pid}`, `${base}/heimdal/products/${pid}?format=json`,
        `${base}/shop/json/product/${pid}`, `${base}/api/v1/products/${pid}`,
        `${base}/heimdal/api/products/${pid}`, `${base}/sitemap.xml`,
        ...[...urls].filter((u) => /api|json|graphql|ajax/i.test(u)).slice(0, 6)
          .map((u) => (u.startsWith("http") ? u : `${base}${u.startsWith("/") ? "" : "/"}${u}`))
      ];
      s.probes = [];
      for (const url of [...new Set(candidates)].slice(0, 10)) {
        const r = await get(url, { accept: "application/json,text/html;q=0.5" });
        s.probes.push({ url, status: r.status ?? null, bytes: r.bytes ?? 0, contentType: r.contentType ?? null,
          error: r.error ?? null,
          found: { list: (r.text || "").includes(String(LIST)), all: (r.text || "").includes(String(ALL)), guest: (r.text || "").includes(String(GUEST)) } });
      }
      const hits = s.probes.filter((x) => x.found && (x.found.list || x.found.all || x.found.guest));
      s.decided = hits.length > 0;
      s.verdict = !s.decided
        ? `NO ANONYMOUS CHANNEL FOUND. ${s.probes.length} candidate endpoint(s) plus the page shell itself were fetched and NONE contains any of the three prices. The heimdal storefront renders prices in the browser, so settling R29 on this shop needs a real browser, not an HTTP probe. Recording this so a third round does not repeat it: **R29's public-price rule is unconfirmable through this channel** and the adapter's warning stays. The referencedUrls list below is what the shell actually names, for whoever tries next.`
        : `DECIDED: ${JSON.stringify(hits.map((h) => ({ url: h.url, found: h.found })))} — read the found flags: whichever of all(${ALL}) / guest(${GUEST}) / list(${LIST}) appears is the price an anonymous visitor is served.`;

      const del = await tryCall("Product_DeleteAllDiscounts", { ProductItemNumber: item });
      const after = arr((await tryCall("Product_GetDiscounts", { ProductId: pid })).result);
      await tryCall("Product_Delete", { ProductId: pid });
      const gone = arr((await tryCall("Product_GetByItemNumber", { ItemNumber: item })).result).filter(Boolean);
      out.cleanup.anonymousPrice = { discountsDeleteOk: del.ok, discountsAfter: after.length, productStillPresent: gone.length > 0 };
      out.sections.anonymousPrice = s;
    }
  }

  save("p2b", { ...out, faults: FAULTS,
    verdict: [out.sections.folders?.verdict, out.sections.anonymousPrice?.verdict].filter(Boolean).join(" || "),
    interpret: "Both sections re-derive their approach from the SERVER's own statements — the GraphQL schema errors for folders, the page markup for the price channel — rather than from a second guess. A negative result in section A is a real finding: it bounds what an HTTP probe can ever settle on this theme. Cleanup is verified by RE-QUERY (R30)." });
  p(`p2b: folders=${out.sections.folders?.maxId ?? "-"} (${out.sections.folders?.count ?? "-"}) | anonPrice=${out.sections.anonymousPrice?.decided ? "DECIDED" : "no channel"} | faults=${FAULTS.length}`);
}

/** P2C — the storefront, found. An adversarial review of round 5 pointed at evidence that had
 *  been on disk since round 2 and that both F34 and R39/R40 walked past:
 *
 *    imgurl.json  https://{tenant}.webshop.dandomain.dk/   -> 200, 24 KB, DanDomain LOGIN banners,
 *                                                             redirects to ?recover        = ADMIN
 *                 https://{tenant}.mywebshop.io/           -> 200, 159 KB, 19 images       = SHOP
 *                 https://{tenant}.mywebshop.io/shop/9-probe-kategori/ -> 200, 178 KB      = SHOP
 *
 *  F34 fetched all five of its candidates against the ADMIN host, so its 404s are negatives about
 *  the admin app and its one 200 is the admin SPA's catch-all (R39). R40 then concluded "the
 *  storefront renders in the browser" from pages that were never the storefront.
 *
 *  So this probe asks the question on the host the artifacts say is the shop, and it asks it with
 *  a product whose price is DISTINGUISHABLE three ways — list / `all` / `guest` — so that the
 *  answer to R29 falls out of the same fetch as the answer to the URL grammar. Both questions can
 *  come out either way, and "the category page lists the product but shows the list price" is a
 *  different and equally recordable outcome from "it shows the guest price". */
async function probeP2c() {
  requireWrite();
  await connect();
  const out = { sections: {}, cleanup: {} };
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const first = (x) => arr(x)[0] ?? null;
  const stamp = Date.now();
  const tenant = PROBE_SHOP;
  const SHOP = `https://${tenant}.mywebshop.io`;
  const ADMIN = `https://${tenant}.webshop.dandomain.dk`;
  const LIST = 3771, ALL = 2221, GUEST = 1117;

  const get = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (shoplift-probe)" } });
      const buf = new Uint8Array(await r.arrayBuffer());
      // These pages are ISO-8859-1 (imgurl.json), so decode BOTH ways and search both.
      const utf8 = new TextDecoder("utf-8").decode(buf);
      const l1 = new TextDecoder("windows-1252").decode(buf);
      return { url, status: r.status, bytes: buf.length, contentType: r.headers.get("content-type"), utf8, l1 };
    } catch (e) { return { url, error: e.message, utf8: "", l1: "" }; }
  };
  const seek = (r, needles) => Object.fromEntries(Object.entries(needles)
    .map(([k, v]) => [k, (r.utf8 || "").includes(String(v)) || (r.l1 || "").includes(String(v))]));
  const slim = (r, needles) => ({ url: r.url, status: r.status ?? null, bytes: r.bytes ?? 0,
    contentType: r.contentType ?? null, error: r.error ?? null, found: r.error ? null : seek(r, needles) });

  // ---- 0. Which host is the shop? Asked, not assumed. --------------------------------------
  {
    const s = { question: "Which of the two hosts is the storefront and which is the admin?" };
    const shopRoot = await get(`${SHOP}/`);
    const adminRoot = await get(`${ADMIN}/`);
    const marks = { adminMarker: "Manage your online store", loginMarker: "recover", noindex: "noindex" };
    s.shopRoot = slim(shopRoot, marks);
    s.adminRoot = slim(adminRoot, marks);
    s.verdict = (s.shopRoot.bytes > 100000 && !(s.shopRoot.found?.adminMarker))
      ? `STOREFRONT = ${SHOP} (${s.shopRoot.bytes} bytes, server-rendered). ADMIN = ${ADMIN} (${s.adminRoot.bytes} bytes${s.adminRoot.found?.loginMarker ? ", login/recover markers present" : ""}). F34 and R40 both probed the ADMIN host.`
      : `UNEXPECTED — ${SHOP} returned ${s.shopRoot.status} / ${s.shopRoot.bytes} bytes. Read the two rows before trusting anything below.`;
    out.sections.hosts = s;
  }

  // ---- 1. A product with three distinguishable prices, in a known category ------------------
  const cat = await ensureCategory();
  const catId = Number(cat?.Id);
  // LETTERS ONLY. The first run of this probe used a millisecond timestamp in the slug, and
  // 1786884111771 CONTAINS "1117" — the guest price — so the "guest wins" hit was a substring of
  // the probe's own URL. It would have been recorded as a finding. Identifiers here carry no
  // digits at all, so a numeric hit cannot come from them.
  const tag = stamp.toString(36).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]);
  const item = `PROBE-SF-${tag.toUpperCase()}`;
  const seo = `probe-storefront-${tag}`;
  await tryCall("Product_CreateOrUpdate", { ProductData: { ItemNumber: item,
    Title: `PROBE storefront ${stamp}`, LanguageISO: "DK", SeoLink: seo,
    Price: LIST, Status: true, Online: true, Stock: 99, CategoryId: catId } });
  await tryCall("Product_SetFields", { Fields: "Id,ItemNumber,Title,Price,SeoLink,CategoryId" });
  const prod = first((await tryCall("Product_GetByItemNumber", { ItemNumber: item })).result);
  const pid = Number(prod?.Id ?? 0);
  const prodSeo = String(prod?.SeoLink ?? "") || seo;
  // (A no-op `Category_SetFields` call lived here and faulted with
  // ProcedureNotPresent every run — the operation does not exist, which is why
  // the adapter reads categories on the default projection. Removed; the fault
  // is recorded in p2c.json and written up under R41.)
  const catRow = arr((await tryCall("Category_GetAll")).result).find((c) => String(c?.Id) === String(catId)) ?? cat;
  // The recorded category URL is /shop/9-probe-kategori/ while that category's SeoLink is NULL
  // (urls.json), so the slug is derived from the TITLE. Carry both candidates rather than picking.
  const slugify = (t) => String(t ?? "").toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const catSlugs = [...new Set([String(catRow?.SeoLink ?? ""), slugify(catRow?.Title)].filter(Boolean))];

  {
    const s = { question: "What is the storefront URL grammar, and which price does an anonymous visitor see?",
      productId: pid, itemNumber: item, categoryId: catId, categorySlugs: catSlugs,
      productSeoLink: prodSeo, numbers: { list: LIST, all: ALL, guest: GUEST } };
    if (!pid) { s.verdict = "NOT RUN — carrier product not created."; out.sections.storefront = s; }
    else {
      const line = (ut, uid, price) => tryCall("Product_CreateDiscount", { ProductDiscountData: {
        ProductId: pid, ProductVariantId: 0, Amount: 1, Price: price, Discount: 0, Currency: "DKK",
        DiscountType: "b", UserType: ut, UserId: uid, Date: false, DateFrom: "", DateTo: "" } });
      await line("all", 0, ALL);
      await line("guest", 0, GUEST);
      s.priceLines = arr((await tryCall("Product_GetDiscounts", { ProductId: pid })).result)
        .map((r) => ({ Id: r?.Id, UserType: r?.UserType, UserId: r?.UserId, Price: r?.Price }));

      // The shop formats DKK as 1.117,00 (profile.json currencyFormat: thousand ".", decimal ",",
      // 2 places), and the FORMATTED form is what a rendered page contains. A bare 4-digit number
      // is a weak needle; the formatted one cannot occur by accident.
      const fmt = (n) => `${String(n).slice(0, -3)}.${String(n).slice(-3)},00`;
      const needles = {
        listFmt: fmt(LIST), allFmt: fmt(ALL), guestFmt: fmt(GUEST),
        list: LIST, all: ALL, guest: GUEST,
        itemNumber: item, productId: `${pid}-`, seoLink: prodSeo,
      };
      // Could a numeric needle have come from the probe's OWN identifiers rather than from a
      // price? Asked here, before any result is read, because the first run of this probe hit
      // exactly that and the answer is what turns a hit into evidence.
      const selfText = `${item} ${prodSeo} ${pid} ${catId} ${catSlugs.join(" ")}`;
      s.needleCollisions = Object.fromEntries(Object.entries(needles)
        .filter(([k]) => ["list", "all", "guest", "listFmt", "allFmt", "guestFmt"].includes(k))
        .map(([k, v]) => [k, selfText.includes(String(v))]));
      s.needlesAreClean = Object.values(s.needleCollisions).every((x) => x === false);
      const candidates = [];
      for (const cs of catSlugs) {
        candidates.push(`${SHOP}/shop/${catId}-${cs}/`);
        candidates.push(`${SHOP}/shop/${catId}-${cs}/${pid}-${prodSeo}/`);
      }
      candidates.push(`${SHOP}/shop/${pid}-${prodSeo}/`, `${SHOP}/${pid}-${prodSeo}`, `${SHOP}/shop/frontpage.html`);
      s.fetches = [];
      for (const url of [...new Set(candidates)].slice(0, 8)) s.fetches.push(slim(await get(url), needles));

      const ok = s.fetches.filter((f) => f.status === 200 && f.found);
      // A URL counts only if the page CONTAINS the product. R39: a 200 alone is worthless here,
      // and the 404 pages in this very run echo the requested slug back, so `seoLink` alone is
      // not containment either — the ITEM NUMBER is, because nothing puts it in a URL.
      const productPage = ok.find((f) => f.found.itemNumber);
      s.urlGrammar = productPage ? productPage.url : null;
      // Decide from the PRODUCT PAGE only, on the FORMATTED needles only.
      const pp = productPage?.found ?? null;
      s.priceVerdict = !s.needlesAreClean ? "REFUSED — a price needle is a substring of the probe's own identifiers"
        : !pp ? "no product page"
          : pp.guestFmt && !pp.allFmt && !pp.listFmt ? "GUEST"
            : pp.allFmt && !pp.guestFmt && !pp.listFmt ? "ALL"
              : pp.listFmt && !pp.allFmt && !pp.guestFmt ? "LIST (price lines ignored)"
                : (pp.guestFmt || pp.allFmt || pp.listFmt) ? "AMBIGUOUS (more than one formatted price on the page)"
                  : "no formatted price on the product page";
      s.verdict =
        `URL GRAMMAR: ${s.urlGrammar ? `\`${s.urlGrammar}\` resolves 200 AND contains the product (its SeoLink or its item number) — a 200 alone is not evidence on this platform (R39), so the containment check is the finding.` : `NOT FOUND. ${s.fetches.filter((f) => f.status === 200).length} of ${s.fetches.length} candidates returned 200 but none contained the product.`}` +
        ` || PRICE: ${s.priceVerdict.startsWith("no ") || s.priceVerdict.startsWith("REFUSED") ? `${s.priceVerdict}. R29 is still unconfirmed. Raw-number hits on the product page were ${JSON.stringify({ list: pp?.list ?? null, all: pp?.all ?? null, guest: pp?.guest ?? null })} — read them against .needleCollisions before treating any of them as a price.` : s.priceVerdict === "GUEST" ? `the anonymous storefront serves ${GUEST} — the \`guest\`/UserId 0 row. R29 must keep \`guest\` and should PREFER it.` : s.priceVerdict === "ALL" ? `the anonymous storefront serves ${ALL} — the \`all\`/UserId 0 row.` : s.priceVerdict === "LIST (price lines ignored)" ? `the anonymous storefront serves Product.Price (${LIST}) and IGNORES both UserId 0 price lines — R29's rule would select a price no visitor is charged.` : `more than one candidate number appears in the same page; a substring match cannot decide. See .fetches.`}`;

      const del = await tryCall("Product_DeleteAllDiscounts", { ProductItemNumber: item });
      const after = arr((await tryCall("Product_GetDiscounts", { ProductId: pid })).result);
      await tryCall("Product_Delete", { ProductId: pid });
      const gone = arr((await tryCall("Product_GetByItemNumber", { ItemNumber: item })).result).filter(Boolean);
      out.cleanup.storefront = { discountsDeleteOk: del.ok, discountsAfter: after.length, productStillPresent: gone.length > 0 };
      out.sections.storefront = s;
    }
  }

  save("p2c", { ...out, faults: FAULTS,
    verdict: [out.sections.hosts?.verdict, out.sections.storefront?.verdict].filter(Boolean).join(" || "),
    interpret: "Asks F34's and R29's questions on the host the round-2 artifacts identify as the storefront. A URL is only accepted when the response CONTAINS the product, never on a 200 alone — R39 is that this platform serves a 200 shell for any path. Every outcome of the price check (GUEST / ALL / LIST / none / ambiguous) is a different recordable finding." });
  p(`p2c: grammar=${out.sections.storefront?.urlGrammar ?? "not found"} | price=${out.sections.storefront?.priceVerdict ?? "-"} | faults=${FAULTS.length}`);
}

function listOf(v) {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object" && v.item != null) return Array.isArray(v.item) ? v.item : [v.item];
  return [v];
}

function loadScratchCfg() {
  let cfg;
  try {
    cfg = loadConfig(path.join(ROOT, "config", "migration.config.json"));
  } catch {
    cfg = { source: { dandomain: { shopId: "105698" } } };
  }
  const shopId = String(cfg.source?.dandomain?.shopId ?? "").trim();
  if (!isScratchDanDomainShopId(shopId)) {
    throw new Error(`sentinels probe: scratch shop 105698 only (config shopId ${shopId || "(empty)"})`);
  }
  return cfg;
}

async function inventorySentinels() {
  try { await call("Product_SetFields", { Fields: "Id,ItemNumber,Title,DeliveryTimeId" }); } catch { /* ok */ }
  try { await call("User_SetFields", { Fields: "Id,Username,UserGroupId" }); } catch { /* ok */ }
  const products = listOf((await call("Product_GetAll")).result);
  const discounts = listOf((await call("Discount_GetAll")).result);
  let page = null;
  try { page = (await call("PageText_GetByLink", { PageTextLink: "ddseed-page-handel" })).result; }
  catch (e) { page = { _error: e.message }; }
  const groups = listOf((await call("User_GetGroupAll")).result);
  const extraBuy = listOf((await call("Product_GetAllExtraBuyCategory")).result);
  const users = listOf((await call("User_GetAll")).result);
  return {
    products: products.filter((x) => String(x?.ItemNumber ?? "").startsWith("DDSEED-")),
    coupons: discounts.filter((x) => String(x?.Code ?? "").startsWith("DDSEED-COUPON")),
    page,
    groups: groups.filter((x) => String(x?.Title ?? "") === "DDSEED B2B"),
    extraBuy: extraBuy.filter((x) => String(x?.Title ?? "") === "DDSEED Køb også"),
    users: users.filter((x) => String(x?.Username ?? "").startsWith("DDSEED-")),
  };
}

async function probeSentinels() {
  const write = process.argv.includes("--write");
  if (write) requireWrite();
  const cfg = loadScratchCfg();
  await connect();
  const webinfo = (await call("Solution_GetWebinfo")).result;
  const solutionId = String(webinfo?.SolutionId ?? "").trim();
  const shopId = String(cfg.source.dandomain.shopId).trim();
  if (!isScratchDanDomainShopId(solutionId) || solutionId !== shopId) {
    throw new Error(`shop-identity gate: config shopId ${shopId} disagrees with Solution_GetWebinfo SolutionId ${solutionId || "(empty)"}`);
  }
  if (!write) {
    const inventory = await inventorySentinels();
    save("sentinels", { write: false, identityOk: true, solutionId, shopId, inventory });
    p("sentinels inventory (read-only) — data/probes/sentinels.json");
    return;
  }
  const client = { call };
  const recorded = await resetDanDomainSentinels(client, cfg, (m) => p(m));
  const remainingInventory = await inventorySentinels();
  save("sentinels", { write: true, identityOk: true, solutionId, shopId, ...recorded, remainingInventory });
  p("sentinels write complete — data/probes/sentinels.json");
}

// ---------- exports (P1b can import this as a mini-lib; tests do) ----------
export { toXml, parseXml, call, connect, ftpReplyReader, parseList, ftpsConnect };

// ---------- main ----------
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const cmd = process.argv[2];
const run = async () => {
  switch (cmd) {
    case "wsdl": return probeWsdl();
    case "op": return probeOp(process.argv[3]);
    case "smoke": return probeSmoke();
    case "vat": return probeVat();
    case "ordercreate": return probeOrderCreate();
    case "urls": return probeUrls();
    case "encoding": return probeEncoding();
    case "storefront": return probeStorefront();
    case "graphql": return probeGraphql();
    case "profile": return probeProfile();
    case "gqldeep": return probeGqlDeep();
    case "gqlshapes": return probeGqlShapes();
    case "deep": return probeDeep();
    case "session": return probeSession();
    case "kreditnota": return probeKreditnota();
    case "vatserver": return probeVatServer();
    case "nested": return probeNested();
    case "media": return probeMedia();
    case "ftp": return probeFtp();
    case "imgurl": return probeImgurl();
    case "gaps": return probeGaps();
    case "gapsw": return probeGapsw();
    case "scale": return probeScale();
    case "close": return probeClose();
    case "pagebase": return probePageBase();
    case "p2": return probeP2();
    case "p2b": return probeP2b();
    case "p2c": return probeP2c();
    case "encbytes": return probeEncBytes();
    case "limits": return probeLimits();
    case "sentinels": return probeSentinels();
    case "all": {
      await probeWsdl(); await probeSmoke(); await probeProfile(); await probeEncoding();
      if (process.argv.includes("--write")) { await probeVat(); await probeOrderCreate(); await probeUrls(); }
      else p("(write probes skipped — add --write to run vat/ordercreate/urls)");
      try { await probeStorefront(); } catch (e) { p("storefront probe skipped: " + e.message); }
      try { await probeGraphql(); } catch (e) { p("graphql probe skipped: " + e.message); }
      try { await probeFtp(); } catch (e) { p("ftp probe skipped: " + e.message); }
      try { await probeImgurl(); } catch (e) { p("imgurl probe skipped: " + e.message); }
      try { await probeGaps(); } catch (e) { p("gaps probe skipped: " + e.message); }
      await probeLimits(); return;
    }
    default: p("usage: node scripts/probe-dandomain.mjs <wsdl|smoke|op <Name>|encoding|storefront|graphql|gqldeep|gqlshapes|encbytes|profile|vat|vatserver|nested|media|ftp|imgurl|gaps|gapsw|scale|close|pagebase|p2|p2b|p2c|deep|session|kreditnota|ordercreate|urls|limits|sentinels|all> [--write]"); process.exit(2);
  }
};
if (IS_MAIN) run().then(() => p("done")).catch((e) => { console.error("PROBE FAILED:", e.message); if (e.raw) console.error("RAW (first 3000):\n", String(e.raw).slice(0, 3000)); log(cmd, { failed: e.message, code: e.code }); process.exit(1); });
