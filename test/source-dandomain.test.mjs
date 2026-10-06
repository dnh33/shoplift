import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "../src/dandomain/client.js";
import {
  createDanDomainAdapter, publicPrice, ddDate, utcMs, mediaUrl, slugify,
  DEFAULT_STATUS_MAP, PUBLIC_USER_TYPES, USER_TYPE_VOCABULARY,
  PRODUCT_FIELDS
} from "../src/sources/dandomain.js";
import { createSource } from "../src/sources/index.js";
import { decodeHtmlEntities } from "../src/util/entities.js";

/**
 * THE OFFLINE PROOF FOR THE DANDOMAIN ADAPTER — layer 1 in, layer 2 out.
 *
 * Layer 1 is `fixtures/dandomain/raw/*.json`: SOAP response ENVELOPES generated
 * from the recorded probe artifacts by `scripts/gen-dandomain-fixtures.mjs`,
 * EXCEPT the money-path pack (`orders-money.json`), whose own provenance is
 * FULLY CONSTRUCTED — shipping/fee/discount/fractional-qty shapes this shop
 * never returned. That pack claims nothing about the platform; it exercises
 * rules the adapter states. A reader of this header must not treat those
 * envelopes as recorded probe bytes.
 *
 * They are fed to the REAL client through an injected fetch, so the real XML
 * parser, the real R26 whole-batch audit and the real paged walk all run. A
 * fixture of pre-parsed objects would test the adapter against a shape the
 * server never sends — and the two findings that matter most here, R6/R18/R26's
 * record collapse and R26's per-record field omission, only exist in the bytes.
 *
 * Layer 2 is what comes out: WooCommerce-shaped records. Most assertions below
 * are about ONE VALUE each, and each one names the finding it protects. That is
 * deliberate — "the output matched a snapshot" catches a change, but it does not
 * say what would have been WRONG, and every defect this project has found came
 * from someone being able to state that.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(HERE, "..", "fixtures", "dandomain", "raw");

const loadPack = (...names) => {
  const responses = {};
  const provenance = {};
  for (const n of names) {
    const body = JSON.parse(readFileSync(path.join(RAW, `${n}.json`), "utf8"));
    provenance[n] = body.provenance;
    for (const [op, xs] of Object.entries(body.responses)) {
      responses[op] = [...(responses[op] ?? []), ...xs];
    }
  }
  return { responses, provenance };
};

/**
 * The fake transport. It reads the operation out of the request envelope exactly
 * the way the server does — from the element name — and serves the next queued
 * response for it. The LAST response for an operation repeats, so a paged walk's
 * confirming read past the end gets the empty page it needs without the fixture
 * having to guess how many times the walk will ask.
 */
function fakeFetch(pack, calls = []) {
  const queues = new Map(Object.entries(pack.responses).map(([op, xs]) => [op, [...xs]]));
  return async (url, init) => {
    const body = Buffer.from(init.body).toString("utf8");
    const op = /<m:([A-Za-z0-9_]+)[\s>]/.exec(body)?.[1];
    if (!op) throw new Error(`fake transport: could not read an operation from the envelope: ${body.slice(0, 200)}`);
    calls.push({ op, body });
    if (op === "User_GetAllByDate" && !queues.has(op)) {
      const src = queues.get("User_GetAll");
      if (src?.length) {
        queues.set(op, src.map((xml) => xml.replaceAll("User_GetAll", "User_GetAllByDate")));
      }
    }
    const q = queues.get(op);
    if (!q || !q.length) throw new Error(`fake transport: no fixture response for ${op} (have: ${[...queues.keys()].join(", ")})`);
    const xml = q.length > 1 ? q.shift() : q[0];
    const bytes = Buffer.from(xml, "utf8");
    return {
      ok: true, status: 200,
      headers: { get: () => null, getSetCookie: () => ["PHPSESSID=fixture; path=/"] },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
  };
}

const CFG = {
  source: {
    adapter: "dandomain", kind: "dandomain",
    baseUrl: "https://shop000000.mywebshop.io",
    dandomain: { username: "u", password: "p", tenant: "shop000000", language: "DK", pageSize: 50 }
  },
  options: {}
};

function harness(packNames, overrides = {}, extras = {}) {
  const pack = loadPack(...packNames);
  const calls = [];
  const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, calls) });
  if (extras.graphqlStub) client.graphql = () => extras.graphqlStub;
  const cfg = { ...CFG, source: { ...CFG.source, dandomain: { ...CFG.source.dandomain, ...overrides } } };
  const adapter = createDanDomainAdapter(cfg, { client, now: () => new Date("2026-08-16T00:00:00Z") });
  return { adapter, calls, client };
}

const drain = async (gen) => { const out = []; for await (const r of gen) out.push(r); return out; };
const codes = (adapter) => adapter.warnings().map((w) => w.code);
const warnOf = (adapter, code) => adapter.warnings().find((w) => w.code === code);

// =============================================================================================
describe("pure helpers", () => {
  test("ddDate: the platform's zero-date is null, not the year 0 (F19/F32)", () => {
    assert.equal(ddDate("0000-00-00 00:00:00"), null);
    assert.equal(ddDate(""), null);
    assert.equal(ddDate("2019-01-05 10:00:00"), "2019-01-05T10:00:00");
  });

  test("mediaUrl resolves through the verified base only (R14/R21/R32)", () => {
    assert.equal(mediaUrl("https://shop000000.sfstatic.io/upload_dir/", "pics/", "product-1.png"),
      "https://shop000000.sfstatic.io/upload_dir/pics/product-1.png");
    // R21: category media is a DIFFERENT subtree, and a bare FileName exists in
    // both — resolving by searching the archive would pick the wrong one.
    assert.equal(mediaUrl("https://x/upload_dir/", "shop/category/", "category-1.png"),
      "https://x/upload_dir/shop/category/category-1.png");
    // Live shop000000 Category_GetPictures.Name is `category/category-N.png`.
    // Prefixing the R21 dir onto that path produced shop/category/category/category-N.png
    // (P5 matrix: 6/7 collections failed; FTP files live at /shop/category/category-N.png).
    assert.equal(mediaUrl("https://x/upload_dir/", "shop/category/", "category/category-3.png"),
      "https://x/upload_dir/shop/category/category-3.png");
    assert.equal(mediaUrl("https://x/upload_dir/", "pics/", ""), null);
  });

  test("toHandle folds Danish digraphs like DanDomain slugify (oe=ø, ae=æ, aa=å)", async () => {
    const { toHandle } = await import("../src/transform/html.js");
    assert.equal(toHandle("Tilbehør"), "tilbehoer");
    assert.equal(toHandle("Tilbehoer"), "tilbehoer");
    assert.equal(toHandle("tilbehør"), "tilbehoer");
    assert.equal(toHandle("Køkken"), "koekken");
    assert.equal(toHandle("påske"), "paaske");
    assert.equal(toHandle("Æbler"), "aebler");
    assert.equal(slugify("Tilbehør"), toHandle("Tilbehør"), "export slug and Shopify handle must agree");
  });

  test("decodeHtmlEntities agrees with the transform's decoder on SINGLY-encoded input", async () => {
    const { decodeEntities } = await import("../src/transform/html.js");
    for (const input of ["&amp;", "&lt;a&gt;", "&quot;x&quot;", "&#39;", "&apos;", "&nbsp;", "&#233;",
      "plain text", "a &amp; b", "&#0039;", "Genåbnet", "50 &amp; 60"]) {
      assert.equal(decodeHtmlEntities(input), decodeEntities(input), `disagreement on ${JSON.stringify(input)}`);
    }
    // and it goes further, which is the point: the server sends these.
    assert.equal(decodeHtmlEntities("Kontooverf&oslash;rsel"), "Kontooverførsel");
    assert.equal(decodeHtmlEntities("Eksempel p&aring; produkt 1"), "Eksempel på produkt 1");
    // an unknown entity is left ALONE rather than mangled
    assert.equal(decodeHtmlEntities("&notarealentity;"), "&notarealentity;");
    // one pass, so a literal "&amp;oslash;" cannot become "ø"
    assert.equal(decodeHtmlEntities("&amp;oslash;"), "&oslash;");
  });

  test("the two decoders DISAGREE on double-encoded input, and this one is right", async () => {
    // The header of util/entities.js claimed "strict SUPERSET" for a while. It is
    // not one, and this is the counter-example that killed the claim: `&amp;lt;`
    // is six characters meaning the literal text `&lt;`. The transform decoder
    // replaces `&amp;` first, then runs `&lt;` over its own output, and invents a
    // `<` the source never contained. Recording the divergence as an assertion is
    // the difference between a known trade-off and a decoder drift nobody saw.
    const { decodeEntities } = await import("../src/transform/html.js");
    assert.equal(decodeHtmlEntities("&amp;lt;"), "&lt;");
    assert.equal(decodeEntities("&amp;lt;"), "<");
    assert.notEqual(decodeHtmlEntities("&amp;lt;"), decodeEntities("&amp;lt;"),
      "if these ever agree, one of the two decoders changed — decide which, do not delete this");
    // Same shape, the case that actually reaches a Shopify handle: `&amp;amp;`
    // means the four characters `&amp;`, not a bare `&`.
    assert.equal(decodeHtmlEntities("&amp;amp;"), "&amp;");
  });

  test("the numeric forms the regex actually admits, and the ones it does not", () => {
    // `&#X41;` is NOT decoded: the capture group is `#x[0-9a-fA-F]+`, lower-case
    // only. There used to be a `body[1] === "X"` arm that looked like it handled
    // this and could never run. The behaviour is deliberate — widen the REGEX if
    // it ever has to change — so it is asserted rather than left to be rediscovered.
    assert.equal(decodeHtmlEntities("&#x41;"), "A");
    assert.equal(decodeHtmlEntities("&#X41;"), "&#X41;");
    // out-of-range code points are returned untouched, never thrown on
    assert.equal(decodeHtmlEntities("&#x110000;"), "&#x110000;");
    assert.equal(decodeHtmlEntities("&#99999999;"), "&#99999999;");
    // a lone surrogate is a valid code point to fromCodePoint, so it survives; the
    // point of the assertion is that nothing here throws on hostile input
    assert.doesNotThrow(() => decodeHtmlEntities("&#xd800;&#0;&#;&#x;"));
    assert.equal(decodeHtmlEntities("&#;"), "&#;");
  });

  test("PRODUCT_FIELDS requests WSDL FocusFrontpage and FocusCart", () => {
    assert.equal(PRODUCT_FIELDS.includes("FocusFrontpage"), true);
    assert.equal(PRODUCT_FIELDS.includes("FocusCart"), true);
  });
});

// =============================================================================================
describe("R29 — the public price rule", () => {
  const row = (o) => ({ Id: "1", Amount: "1", Price: "100", Discount: "0", DiscountType: "b", UserType: "all", UserId: "0", Date: "false", DateFrom: "", DateTo: "", ...o });

  test("the vocabulary is the server's own, and `0` is NOT in it (R22)", () => {
    assert.deepEqual(USER_TYPE_VOCABULARY, ["all", "guest", "user", "group"]);
    assert.deepEqual(PUBLIC_USER_TYPES, ["all", "guest", ""]);
    assert.equal(PUBLIC_USER_TYPES.includes("0"), false);
  });

  test("the recorded hazard: `lowest wins` would publish a B2B price (R22)", () => {
    // The exact five rows R22 read back from the shop.
    const p = { Price: 100, Discounts: [
      row({ Id: "1", Price: "42", UserType: "", UserId: "4" }),
      row({ Id: "2", Price: "42", UserType: "0", UserId: "4" }),
      row({ Id: "3", Price: "42", UserType: "all", UserId: "4" }),
      row({ Id: "4", Price: "42", UserType: "group", UserId: "4" }),
      row({ Id: "5", Price: "90", UserType: "all", UserId: "0" })
    ] };
    const naive = Math.min(...p.Discounts.map((d) => Number(d.Price)));
    assert.equal(naive, 42, "the naive rule really does select the trade price");
    assert.equal(publicPrice(p).price, 90, "PLAN §3's lowest-wins would have published 42");
    assert.equal(publicPrice(p).source, "price-line");
    assert.equal(publicPrice(p).dropped.length, 4);
  });

  test("a `guest` row is CONSIDERED, not dropped (R29 — R22's silent hole)", () => {
    const p = { Price: 100, Discounts: [row({ Id: "1", Price: "90", UserType: "all", UserId: "0" }), row({ Id: "2", Price: "55", UserType: "guest", UserId: "0" })] };
    assert.equal(publicPrice(p).price, 55);
    assert.equal(publicPrice(p).dropped.length, 0, "guest must not appear in the dropped list");
  });

  test("`all` is the server's DEFAULT for an omitted UserType, so UserId still decides (R29)", () => {
    const scoped = { Price: 100, Discounts: [row({ Price: "42", UserType: "all", UserId: "4" })] };
    assert.equal(publicPrice(scoped).price, 100, "an `all` row carrying a group id is scoped, not public");
    assert.equal(publicPrice(scoped).dropped[0].reason, "customer-scoped");
  });

  test("O7 recorded Prislinjer: group rows drop; public stays Product.Price 199/399", () => {
    const product1 = {
      Price: 199,
      Discounts: [
        { Id: "27", ProductId: "1", ProductVariantId: "4", Amount: "1", Price: "120", Discount: "0", DiscountType: "a", UserType: "group", UserId: "4", Date: "false", DateFrom: "0000-00-00 00:00:00", DateTo: "0000-00-00 00:00:00" },
        { Id: "26", ProductId: "1", ProductVariantId: "0", Amount: "1", Price: "150", Discount: "0", DiscountType: "a", UserType: "group", UserId: "4", Date: "false", DateFrom: "0000-00-00 00:00:00", DateTo: "0000-00-00 00:00:00" },
      ],
    };
    const r1 = publicPrice(product1);
    assert.equal(r1.price, 199, "group 150 must not become public");
    assert.equal(r1.source, "Product.Price");
    assert.equal(r1.dropped.length, 1, "product-level ask sees variantId 0 only; id 27 is variant-scoped");
    assert.equal(r1.dropped[0].id, "26");
    assert.equal(r1.dropped[0].reason, "customer-scoped");
    assert.equal(r1.dropped[0].price, 150);
    const r1small = publicPrice(product1, { variantId: "4" });
    assert.equal(r1small.price, 199, "variant Small group 120 must not become public");
    assert.ok(r1small.dropped.some((d) => d.id === "27" && d.price === 120 && d.reason === "customer-scoped"));
    const product5 = {
      Price: 399,
      Discounts: [
        { Id: "28", ProductId: "5", ProductVariantId: "0", Amount: "1", Price: "299", Discount: "0", DiscountType: "a", UserType: "group", UserId: "4", Date: "false", DateFrom: "0000-00-00 00:00:00", DateTo: "0000-00-00 00:00:00" },
      ],
    };
    const r5 = publicPrice(product5);
    assert.equal(r5.price, 399);
    assert.equal(r5.dropped[0].id, "28");
    assert.equal(r5.dropped[0].price, 299);
    assert.equal(r5.dropped[0].reason, "customer-scoped");
  });

  test("a UserType outside the vocabulary is UNKNOWN SCOPE, never public (R22)", () => {
    const p = { Price: 100, Discounts: [row({ Price: "35", UserType: "0", UserId: "0" })] };
    const r = publicPrice(p);
    assert.equal(r.price, 100);
    assert.equal(r.unknownScope.length, 1);
    assert.equal(r.unknownScope[0].reason, "unknown-scope");
  });

  test("a quantity break is not a unit price", () => {
    const p = { Price: 100, Discounts: [row({ Price: "30", Amount: "10", UserType: "all", UserId: "0" })] };
    const r = publicPrice(p);
    assert.equal(r.price, 100);
    assert.equal(r.dropped[0].reason, "quantity-break");
  });

  test("a date-windowed row only counts inside its window", () => {
    const rows = [row({ Price: "50", Date: "true", DateFrom: "2020-01-01 00:00:00", DateTo: "2020-12-31 23:59:59" })];
    assert.equal(publicPrice({ Price: 100, Discounts: rows }, { now: new Date("2026-01-01T00:00:00Z") }).price, 100);
    assert.equal(publicPrice({ Price: 100, Discounts: rows }, { now: new Date("2020-06-01T00:00:00Z") }).price, 50);
  });

  test("R42 — a `guest` row WINS outright, even when `all` is cheaper", () => {
    // The recorded storefront read: `all`/0 at 2221 and `guest`/0 at 1117 on one
    // product renders 1.117,00 and neither of the other two. So `guest` is what
    // a logged-out visitor is charged — not "the cheapest public row", which is
    // the same answer only by accident when guest happens to be lower.
    const cheaper = { Price: 3771, Discounts: [row({ Price: "2221", UserType: "all", UserId: "0" }), row({ Price: "1117", UserType: "guest", UserId: "0" })] };
    assert.equal(publicPrice(cheaper).price, 1117);
    assert.equal(publicPrice(cheaper).scope, "guest");
    // The case that separates the two rules: guest is DEARER.
    const dearer = { Price: 3771, Discounts: [row({ Price: "1000", UserType: "all", UserId: "0" }), row({ Price: "2000", UserType: "guest", UserId: "0" })] };
    assert.equal(publicPrice(dearer).price, 2000, "cheapest-of-public would have picked 1000, which no visitor pays");
    assert.equal(publicPrice(dearer).scope, "guest");
  });

  test("a public price line above the entered price is USED, and reported", () => {
    // R42 says the storefront serves the price line, so the line wins. Clamping
    // silently to Product.Price would under-price a catalogue whose price lines
    // are the current ones and whose base Price is stale.
    const p = { Price: 100, Discounts: [row({ Price: "150", UserType: "all", UserId: "0" })] };
    assert.equal(publicPrice(p).price, 150);
    assert.deepEqual(publicPrice(p).dearerThanListPrice, { line: 150, listPrice: 100 });
  });

  test("the rule reports itself as CONFIRMED against the storefront, on ONE shop (R42)", () => {
    // This assertion used to read `confirmed === false` and was correct when it
    // was written. R42 read the price off the anonymous storefront and settled
    // it, and the flag went stale for a round — a test pinning a claim the
    // project had already disproved. What it must pin now is the SCOPE: the rule
    // is confirmed, on one shop, by a named finding. A bare `true` would read as
    // "verified everywhere", which is the over-read that made R34's page base
    // look settled and cost a round.
    const r = publicPrice({ Price: 100, Discounts: [] });
    assert.equal(r.confirmed, true);
    assert.equal(r.confirmedBy, "R42");
    assert.equal(r.confirmedOnShops, 1, "one shop is not a platform-wide rule — O11 stays open until a second answers");
  });

  test("guest wins on the VARIANT rows too, not just the product-level ones", () => {
    // R42's rule and the variant scoping are two separate mechanisms, and the
    // interaction is where a wrong answer would hide: a variant that has its own
    // rows must resolve `guest` among THOSE, never fall back to the product's.
    const p = { Price: 3771, Discounts: [
      row({ Id: "1", Price: "900", UserType: "guest", UserId: "0", ProductVariantId: "0" }),
      row({ Id: "2", Price: "1000", UserType: "all", UserId: "0", ProductVariantId: "77" }),
      row({ Id: "3", Price: "2000", UserType: "guest", UserId: "0", ProductVariantId: "77" }),
    ] };
    assert.equal(publicPrice(p, { variantId: "77" }).price, 2000, "the variant's own guest row, even though dearer");
    assert.equal(publicPrice(p, { variantId: "77" }).scope, "guest");
    // the PRODUCT-level ask must not see the variant-scoped rows at all
    assert.equal(publicPrice(p).price, 900);
    // a variant with NO rows of its own falls back to the product-level ones
    assert.equal(publicPrice(p, { variantId: "78" }).price, 900);
  });
});

// =============================================================================================
describe("products — normalization from the recorded payload", () => {
  test("the real parser survives the shape that collapsed the naive one (R6/R18/R26)", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const rows = await drain(adapter.products());
    assert.equal(rows.length, 3, "the naive parser reported ONE record for a whole page");
    const p1 = rows[0];
    assert.equal(p1._variations.length, 3, "three variants, not one collapsed wrapper");
    assert.deepEqual(p1._variations.map((v) => v.id), [4, 5, 28]);
  });

  test("HTML entities in a product title are decoded (recorded in smoke.json)", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.name, "Eksempel på produkt 1");
    assert.ok(p1.description.includes("ø") && p1.description.includes("å"), p1.description);
  });

  test("R1 — Product.Price is the VAT-INCLUSIVE consumer price and maps to regular_price", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.regular_price, "199.00");
  });

  test("R1 inversion pin — same SKU stays 100 inclusive on the product and 80 net on the order", async () => {
    // Product 17 is entered at 100 INCL 25% VAT. Its recorded order line is 80 NET.
    // Stripping VAT from Product.Price yields 80.00 and this fails.
    // Treating the order line as inclusive and stripping VAT yields 64.00 and the order half fails.
    const { adapter } = harness(["shop", "products", "categories", "orders"]);
    const products = await drain(adapter.products());
    const p17 = products.find((p) => p.sku === "PROBE-VS-25");
    assert.ok(p17, "product 17 (PROBE-VS-25) must be in the catalogue fixture");
    assert.equal(p17.regular_price, "100.00", "Product.Price is inclusive; stripping 25% VAT would yield 80.00");
    const orders = await drain(adapter.orders());
    const o18 = orders.find((o) => o.id === 18);
    assert.equal(o18.line_items[0].sku, "PROBE-VS-25");
    assert.equal(o18.line_items[0].subtotal, "80.00", "order line Price is NET; treating it as inclusive would yield 64.00");
    assert.notEqual(p17.regular_price, o18.line_items[0].subtotal,
      "the same SKU must not collapse to one basis — that is the inversion");
  });

  test("R29 in the pipeline — the public price wins and the trade price is dropped LOUDLY", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const rows = await drain(adapter.products());
    const p1 = rows[0];
    // rows: 42 (blank scope, uid 4), 42 (all, uid 4), 42 (group), 90 (all/0),
    // 55 (guest/0), 30 (all/0 but Amount 10), 35 (UserType "0")
    assert.equal(p1.price, "55.00", "the guest row at 55 is what a logged-out visitor pays (R42)");
    assert.equal(p1.sale_price, "55.00");
    assert.ok(codes(adapter).includes("PRICE_LINES_DROPPED"));
    assert.ok(codes(adapter).includes("PRICE_LINE_UNKNOWN_SCOPE"));
    assert.ok(codes(adapter).includes("DISCOUNT_TYPE_UNDECODED"), "the undecoded a/b vocabulary must be said out loud (R20)");
    // product 17 is R1's subject and carries no price lines at all
    assert.equal(rows[2].regular_price, "100.00");
  });

  test("R19 — reviews are counted and DROPPED; no reviewer email reaches the record", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const rows = await drain(adapter.products());
    assert.deepEqual(rows[0].tags, [], "Product_GetTags must never become Shopify tags");
    assert.equal(rows.length, 3);
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes("reviewer@example.invalid"), false, "a reviewer email must not reach data/raw/");
    assert.equal(blob.includes("Rigtig god."), false, "review text must not reach data/raw/ either");
    const w = adapter.warnings().find((x) => x.code === "REVIEWS_NOT_MIGRATED");
    assert.ok(w && /1 product review/.test(w.message), JSON.stringify(w));
  });

  test("R31 — option values are ordered by Sorting, not alphabetically", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.attributes.length, 1);
    assert.equal(p1.attributes[0].name, "Størrelse", "the option NAME comes from Product_GetVariantTypeAll");
    assert.deepEqual(p1.attributes[0].options, ["Small", "Medium", "Large"],
      "alphabetical would have produced Large, Medium, Small");
    assert.deepEqual(p1._variations.map((v) => v.attributes[0].option), ["Small", "Medium", "Large"]);
  });

  test("R14/R21 — media resolves through the verified base, under pics/", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const [p1] = await drain(adapter.products());
    assert.deepEqual(p1.images, [{ src: "https://shop000000.sfstatic.io/upload_dir/pics/product-1.png", alt: "Produkt 1" }]);
  });

  test("P6 — variant PictureId maps to _variations[].image.src (same pics/ base as product images)", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const [p1] = await drain(adapter.products());
    const small = p1._variations.find((v) => v.id === 4);
    assert.ok(small, "variant 4 exists");
    assert.equal(small.image?.src, "https://shop000000.sfstatic.io/upload_dir/pics/product-1.png");
    assert.equal(small.image?.alt, "Produkt 1");
    const noPic = p1._variations.find((v) => v.id === 5);
    assert.equal(noPic?.image, undefined, "PictureId 0 emits no variant image");
  });

  test("P6 — pakkeprodukt Type 1 emits GROUPED_CONVERTED and grouped_products", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: sub("<Type></Type>", "<Type>1</Type>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.type, "grouped");
    assert.ok(warnOf(adapter, "GROUPED_CONVERTED"), JSON.stringify(codes(adapter)));
  });

  test("P6 — RelatedProductIds emit RELATED_PRODUCTS_NOT_MIGRATED on a non-grouped product", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: sub("<RelatedProductIds/>",
        "<RelatedProductIds><item><Id>17</Id></item></RelatedProductIds>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_related_product_ids, JSON.stringify(["17"]));
    assert.ok(warnOf(adapter, "RELATED_PRODUCTS_NOT_MIGRATED"), JSON.stringify(codes(adapter)));
  });

  test("P6 — SeoKeywords land on _dd_seo_keywords and warn handled", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: sub("<SeoKeywords></SeoKeywords>", "<SeoKeywords>fokus, søgeord</SeoKeywords>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_seo_keywords, "fokus, søgeord");
    const w = warnOf(adapter, "SEO_KEYWORDS_NOT_MIGRATED");
    assert.ok(w, JSON.stringify(codes(adapter)));
    assert.equal(w.severity, "handled");
    assert.match(w.message, /dandomain\.seo_keywords/);
  });

  test("P6 — filsalg TypeLabel sets downloadable + downloads for transform DIGITAL_FILES", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: sub("<TypeLabel></TypeLabel>", "<TypeLabel>filsalg</TypeLabel>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.downloadable, true);
    assert.ok(p1.downloads?.length, "download placeholder for transform DIGITAL_FILES");
  });

  test("P6 — delivery time title resolves into _delivery_time_title metafield", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetDeliveryTimeAll: sub("<ns1:Product_GetDeliveryTimeAllResult/>",
        "<ns1:Product_GetDeliveryTimeAllResult><item><Id>3</Id><Title>1-2 hverdage</Title></item></ns1:Product_GetDeliveryTimeAllResult>"),
      Product_GetAllWithLimit: sub("<DeliveryTimeId>-1</DeliveryTimeId>", "<DeliveryTimeId>3</DeliveryTimeId>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._delivery_time, "3");
    assert.equal(meta._delivery_time_title, "1-2 hverdage");
  });

  test("P6 — tilvalg rows land on _dd_tilvalg when shop has additional types", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAdditionalTypesAll: sub("<ns1:Product_GetAdditionalTypesAllResult/>",
        "<ns1:Product_GetAdditionalTypesAllResult><item><Id>9</Id><Title>Gravur</Title></item></ns1:Product_GetAdditionalTypesAllResult>"),
      Product_GetAdditionalTypes: sub("<ns1:Product_GetAdditionalTypesResult/>",
        "<ns1:Product_GetAdditionalTypesResult><item><Id>1</Id><Title>Initialer</Title></item></ns1:Product_GetAdditionalTypesResult>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.deepEqual(JSON.parse(meta._dd_tilvalg), [{ id: "1", title: "Initialer" }]);
    assert.ok(warnOf(adapter, "TILVALG_NOT_MIGRATED"), JSON.stringify(codes(adapter)));
  });

  test("no media base configured is an ACTION warning, not a silent empty catalogue", async () => {
    const { adapter } = harness(["shop", "products", "categories"], { tenant: "", mediaBase: "" });
    const [p1] = await drain(adapter.products());
    assert.deepEqual(p1.images, []);
    assert.ok(codes(adapter).includes("MEDIA_BASE_UNKNOWN"));
  });

  test("F7/R41 — product permalink is composed on the storefront host; pages stay uncomposed", async () => {
    const { adapter } = harness(["shop", "products", "categories", "pages"]);
    const rows = await drain(adapter.products());
    assert.equal(rows[0].permalink, "https://shop000000.mywebshop.io/shop/1-demo-kategori/1-eksempel-paa-produkt-1/");
    assert.equal(rows[1].permalink, null, "empty SeoLink: no recorded product-slug fallback (D9)");
    const meta = Object.fromEntries(rows[0].meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_seo_link, "eksempel-paa-produkt-1");
    assert.equal(meta._dd_main_category_id, "1");
    assert.equal(meta._dd_main_category_slug, "demo-kategori");
    for (const pg of await drain(adapter.pages())) assert.equal(pg.link, null, "page URL grammar is unrecorded — do not invent");
  });

  test("F17 — Status and Online are two flags and BOTH are carried", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const rows = await drain(adapter.products());
    const meta = (p) => Object.fromEntries(p.meta_data.map((m) => [m.key, m.value]));
    assert.equal(rows[0].status, "publish");
    assert.equal(meta(rows[0])._dd_status, "1");
    assert.equal(meta(rows[0])._dd_online, "1");
    // product 2 is Online:true but Status:false — visible to nobody
    assert.equal(rows[1].status, "draft");
    assert.equal(meta(rows[1])._dd_status, "0");
    assert.equal(meta(rows[1])._dd_online, "1");
  });

  test("R26 — a record missing SeoLink is an EMPTY VALUE, not a truncated column", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const rows = await drain(adapter.products());
    assert.equal(rows[0].slug, "eksempel-paa-produkt-1");
    assert.equal(rows[1].slug, null, "product 2 has no SeoLink key at all");
    // The sharp claim: SeoLink is present on SOME records, so it is an empty
    // value and must never be reported as a dropped column. R26 is exactly the
    // rule that "requested but absent here" and "the server dropped it" are
    // different findings, and R28 is the round that got it wrong.
    const truncations = adapter.warnings().filter((w) => w.code === "FIELD_SET_TRUNCATED");
    assert.equal(truncations.some((w) => /SeoLink/.test(w.message)), false,
      `SeoLink must not be called truncated: ${truncations.map((w) => w.message).join(" | ")}`);
  });

  test("R3/R26 — a truncation NESTED inside the records is still reported", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    await drain(adapter.products());
    // Description/DescriptionLong were requested on ProductVariant and came back
    // on zero of the three recorded variant rows. R3's own recorded truncation
    // (PacketId/Status on ORDER LINES) is nested exactly like this, so a
    // top-level-only audit would have missed the case it exists for.
    // Prefer ProductVariant: PRODUCT_FIELDS also requests FocusFrontpage/FocusCart
    // which the recorded fixture omits at the product level (auto-collections).
    const w = adapter.warnings().find((x) => x.code === "FIELD_SET_TRUNCATED" && /ProductVariant/.test(x.message));
    assert.ok(w, `the nested audit must fire; got ${adapter.warnings().filter((x) => x.code === "FIELD_SET_TRUNCATED").map((x) => x.message).join(" || ")}`);
    assert.ok(/on 0 of 3/.test(w.message), w.message);
  });

  test("CallForPrice is an action item — Shopify would show the hidden price", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    await drain(adapter.products());
    assert.ok(codes(adapter).includes("CALL_FOR_PRICE"));
  });

  test("shop-level facts fire once: multi-language and customer-group pricing", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    await drain(adapter.products());
    const c = codes(adapter);
    assert.equal(c.filter((x) => x === "MULTI_LANGUAGE_PARTIAL").length, 1);
    assert.equal(c.filter((x) => x === "KUNDEGRUPPE_PRICING").length, 1);
  });
});

// =============================================================================================
describe("orders — the money path", () => {
  test("R1 — order money is NET, and the gross total is REBUILT rather than read from Order.Total", async () => {
    const { adapter } = harness(["shop", "products", "categories", "orders"]);
    const rows = await drain(adapter.orders());
    const o18 = rows.find((o) => o.id === 18);
    // The recorded order: a 25%-VAT product entered at 100 was priced 80 NET.
    assert.equal(o18.line_items[0].subtotal, "80.00");
    assert.equal(o18.total_tax, "20.00", "25% of 80, derived from the product's VatGroupId (R2)");
    assert.equal(o18.total, "100.00", "reading Order.Total (80) as the gross total deflates every order by the VAT rate");
  });

  test("R2 — the rate comes from the product's VAT group, never from the order", async () => {
    const { adapter, calls } = harness(["shop", "products", "categories", "orders"]);
    const rows = await drain(adapter.orders());
    const o18 = rows.find((o) => o.id === 18);
    // both Order.Vat and OrderLine.VatRate are "0" in the fixture, as recorded
    assert.deepEqual(o18.tax_lines, [{ rate_id: 2, label: "25 % (probe)", rate_percent: 25 }]);
    assert.deepEqual(o18.line_items[0].taxes, [{ id: 2, total: "20.00" }]);
    assert.equal(o18.total_tax, "20.00", "using Order.Vat / OrderLine.VatRate (always 0) would yield 0.00");
    assert.ok(calls.some((c) => c.op === "Product_GetAllWithLimit"),
      "the adapter must read the catalogue's VAT groups — the order does not carry the rate");
  });

  test("F30 — OrderTransaction.Amount is ØRE and OrderLine.Amount is a QUANTITY", async () => {
    // AmountFull 100 agrees with 10000/100, so an øre-division mutant survives
    // the honest fixture. Zero AmountFull so the øre path is the only source.
    const pack = patchPack(["shop", "products", "categories", "orders"], {
      Order_GetAllWithPagination: (xml) => {
        if (!xml.includes("<AmountFull>100</AmountFull>")) return xml;
        return xml.replace("<AmountFull>100</AmountFull>", "<AmountFull>0</AmountFull>");
      }
    });
    const { adapter } = harnessFor(pack);
    const rows = await drain(adapter.orders());
    const o18 = rows.find((o) => o.id === 18);
    const meta = Object.fromEntries(o18.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_transaction_amount, "100", "10000 øre is 100.00, not 10000 — treating Amount as major units fails here");
    assert.equal(o18.line_items[0].quantity, 1, "OrderLine.Amount is the quantity");
    const o19 = rows.find((o) => o.id === 19);
    assert.equal(o19.line_items[0].quantity, 3, "Amount 3 is quantity 3; Amount/100 (øre-as-qty) would reshape to 1");
  });

  test("the line-price basis is DECIDED by the shop's own multi-quantity order, not assumed", async () => {
    const { adapter } = harness(["shop", "products", "categories", "orders"]);
    const rows = await drain(adapter.orders());
    const o19 = rows.find((o) => o.id === 19);
    // Total 240 with 3 x 80 fits the UNIT reading and not the LINE-TOTAL one.
    assert.equal(o19.line_items[0].subtotal, "240.00");
    const w = adapter.warnings().find((x) => x.code === "ORDER_LINE_PRICE_BASIS");
    assert.ok(w && /UNIT price/.test(w.message), JSON.stringify(w));
    assert.equal(codes(adapter).includes("ORDER_LINE_PRICE_BASIS_UNPROVEN"), false);
  });

  test("with only single-quantity orders the basis stays UNPROVEN and says so", async () => {
    const { adapter } = harness(["shop", "products", "categories", "orders-default-projection"]);
    await drain(adapter.orders());
    assert.ok(codes(adapter).includes("ORDER_LINE_PRICE_BASIS_UNPROVEN"),
      "every probe order used quantity 1, where both readings predict the same number");
  });

  test("F38 — a credit note is found by Origin + negative Total, NOT by status 100", async () => {
    const { adapter } = harness(["shop", "products", "categories", "orders"]);
    const rows = await drain(adapter.orders());
    assert.equal(rows.some((o) => o.id === 17), false, "the credit note is folded, not exported as its own order");
    const parent = rows.find((o) => o.id === 16);
    assert.equal(parent.refunds.length, 1);
    assert.equal(parent.refunds[0].total, "-150.00");
    assert.equal(DEFAULT_STATUS_MAP[100], "credit-note");
    const w = adapter.warnings().find((x) => x.code === "REFUND_PARTIAL");
    assert.ok(w && /unbooked \(Kladde\)/.test(w.message), "a status-99 credit note is unbooked and must be flagged as such");
  });

  test("F19 — the currency comes from the NESTED object, never from Order.CurrencyId", async () => {
    const { adapter } = harness(["shop", "products", "categories", "orders"]);
    const [o] = await drain(adapter.orders());
    assert.equal(o.currency, "DKK");
    // CurrencyId on the fixture is 1, which is ALSO the Currency_GetAll id here —
    // so the assertion that matters is that the nested Iso was read at all.
    assert.equal(typeof o.currency, "string");
  });

  test("F19/F32 — zero-dates read as null and DateDelivered carries the creation time", async () => {
    const { adapter } = harness(["shop", "products", "categories", "orders"]);
    const [o] = await drain(adapter.orders());
    assert.equal(o.date_created_gmt, "2026-08-15T18:41:30");
    assert.equal(o.date_paid_gmt, "2019-01-05T10:00:00", "from the backdated PAID transaction (F29)");
  });

  test("the nested-line DEFAULT projection is detected and the lines are re-read", async () => {
    const { adapter, calls } = harness(["shop", "products", "categories", "orders-default-projection"]);
    const rows = await drain(adapter.orders());
    assert.ok(codes(adapter).includes("ORDER_LINES_REFETCHED"));
    assert.equal(rows[0].line_items.length, 1);
    assert.equal(rows[0].line_items[0].subtotal, "80.00", "money must survive the fallback");
    assert.ok(calls.some((c) => c.op === "Order_GetLines"));
  });

  test("R35 — a date-windowed paged read sends Status EXPLICITLY", async () => {
    const { adapter, calls } = harness(["shop", "products", "categories", "orders"], { ordersAfter: "2020-01-01 00:00:00" });
    // The fixture only answers Order_GetAllWithPagination, so the call throws —
    // what is asserted is the ENVELOPE the adapter tried to send.
    await drain(adapter.orders()).catch(() => {});
    const sent = calls.find((c) => c.op === "Order_GetByDateWithPagination");
    assert.ok(sent, "a date window must use the paginated by-date operation");
    assert.ok(/<Status>|<Status\/>/.test(sent.body),
      "omitting a nillable Status is a PHP arity error on 3 of 3 operations (R35)");
  });

  test("a status outside the map is reported rather than guessed", async () => {
    const { adapter } = harness(["shop", "products", "categories", "orders"], { statusMap: { 0: null } });
    await drain(adapter.orders());
    assert.ok(codes(adapter).includes("ORDER_STATUS_UNMAPPED"));
  });
});

// =============================================================================================
describe("customers, categories, coupons, pages", () => {
  test("R28 — the shipping address is NOT a dropped column; R23's claim was circular", async () => {
    const { adapter } = harness(["shop", "customers"]);
    const [c] = await drain(adapter.customers());
    assert.equal(c.email, "probe-ship@example.invalid");
    // R23 read the absence of 19 Shipping* fields as a truncated column, from a
    // create that never SENT one. R28 re-probed with every field populated and
    // got 56 of 56 back. This checks the consequence: a populated shipping
    // address reaches the record.
    assert.equal(c.shipping.address_1, "Leveringsvej 2");
    assert.equal(c.shipping.postcode, "8200");
    assert.equal(c.shipping.country, "DK");
    assert.equal(codes(adapter).includes("FIELD_SET_TRUNCATED"), false);
  });

  test("...and the customer audit is LIVE: a column absent on every record IS reported", async () => {
    // Without this, deleting reportAudit() from customers() leaves the whole
    // suite green — the fixture happens to carry every requested field, so the
    // branch is never taken. That is a test asserting nothing.
    const pack = loadPack("shop", "customers");
    pack.responses.User_GetAll = [pack.responses.User_GetAll[0].replace(/<Cvr>[^<]*<\/Cvr>\n?/, "")];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    await drain(adapter.customers());
    const w = adapter.warnings().find((x) => x.code === "FIELD_SET_TRUNCATED");
    assert.ok(w, `expected FIELD_SET_TRUNCATED in ${codes(adapter).join(", ")}`);
    assert.match(w.message, /Cvr/);
    assert.match(w.message, /on 0 of 1/);
  });

  test("R23 — Consent and Newsletter are carried as SEPARATE facts", async () => {
    const { adapter } = harness(["shop", "customers"]);
    const [c] = await drain(adapter.customers());
    const meta = Object.fromEntries(c.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_consent, "1");
    assert.equal(meta._dd_newsletter, "1");
    assert.equal(meta._dd_consent_date, "2024-03-01T12:00:00");
    assert.ok(codes(adapter).includes("NEWSLETTER_CONSENT_IMPORTED"));
  });

  test("a customer's password is never requested and never exported", async () => {
    const { adapter, calls } = harness(["shop", "customers"]);
    const rows = await drain(adapter.customers());
    const setFields = calls.find((c) => c.op === "User_SetFields");
    assert.equal(/>[^<]*Password/.test(setFields.body), false, "Password must not be in the requested field list");
    assert.equal(JSON.stringify(rows).includes("Password"), false);
  });

  test("EAN invoicing is declared (lands as dandomain.ean metafield)", async () => {
    const { adapter } = harness(["shop", "customers"]);
    await drain(adapter.customers());
    const w = warnOf(adapter, "EAN_INVOICING");
    assert.ok(w, JSON.stringify(codes(adapter)));
    assert.equal(w.severity, "handled");
    assert.match(w.message, /dandomain\.ean/);
  });

  test("categories carry a REAL slug and media from the /shop/category subtree (R21)", async () => {
    const { adapter } = harness(["shop", "categories"]);
    const rows = await drain(adapter.categories());
    assert.equal(rows[0].slug, "demo-kategori", "DanDomain categories DO have slugs, unlike Woo's category API");
    assert.equal(rows[0].image.src, "https://shop000000.sfstatic.io/upload_dir/shop/category/category-1.png");
    assert.equal(rows[0].description, "Beskrivelse med ø");
    assert.equal(rows[1].parent, 1, "the hierarchy is carried");
    assert.equal(rows[1].image, null);
  });

  test("coupons: free gift, group scope and a spent use-count are each named", async () => {
    const { adapter } = harness(["shop", "coupons"]);
    const rows = await drain(adapter.coupons());
    assert.equal(rows[0].code, "VELKOMMEN10");
    assert.equal(rows[0].discount_type, "percent");
    assert.equal(rows[0].usage_limit_per_user, 1);
    assert.equal(rows[0].minimum_amount, "100.00");
    assert.equal(rows[1].date_expires, "2024-08-31T23:59:59");
    const c = codes(adapter);
    for (const code of ["FREE_GIFT_DISCOUNT", "SCOPED_COUPON_GROUP", "USES_REMAINING_IMPORTED"]) {
      assert.ok(c.includes(code), `${code} missing from ${c.join(", ")}`);
    }
  });

  test("R15 — pages enumerate by folder sweep, and the sweep's BOUND is declared", async () => {
    const { adapter } = harness(["shop", "pages"]);
    const rows = await drain(adapter.pages());
    const titles = rows.map((p) => p.title.rendered);
    for (const t of ["Om os", "Kontakt", "Handelsbetingelser", "Cookies", "Nyheder", "Produktkatalog"]) {
      assert.ok(titles.includes(t), `${t} missing from ${titles.join(", ")}`);
    }
    const w = adapter.warnings().find((x) => x.code === "PAGE_FOLDER_SWEEP");
    assert.ok(w && /is NOT exported/.test(w.message), "a page above the swept range is a silent loss and must be declared");
  });

  test("settings: the shop states its own VAT basis, and the blog decision is declared (D5/F22)", async () => {
    const { adapter } = harness(["shop"]);
    const st = await adapter.settings();
    assert.equal(st.currency, "DKK");
    assert.equal(st.vatBasis, "INCLUSIVE");
    assert.equal(st.vatBasisSource, "Solution_GetWebinfo.ProductPricesWithVat");
    assert.equal(st.solutionId, "shop000000");
    assert.ok(codes(adapter).includes("BLOG_NOT_EXPORTED"));
    assert.ok(/read-only/.test(st.sourceSideEffects), "R21: a DanDomain export is not read-only against the source");
  });

  test("F22 — Solution_HasModule is called with the WSDL's argument name, not a guess", async () => {
    const { adapter, calls } = harness(["shop"]);
    await adapter.settings();
    const sent = calls.filter((c) => c.op === "Solution_HasModule");
    assert.equal(sent.length, 2);
    assert.ok(/<module>blog<\/module>/.test(sent[0].body),
      "an unrecognised ARGUMENT name is silently dropped and comes back as a PHP arity error (R17/R27)");
  });
});

// =============================================================================================
describe("field-set negotiation (R4)", () => {
  test("a rejected field name is dropped, named and reported — not fatal", async () => {
    const pack = loadPack("shop", "products", "categories");
    let first = true;
    const base = fakeFetch(pack, []);
    const fetchImpl = async (url, init) => {
      const body = Buffer.from(init.body).toString("utf8");
      if (/<m:Product_SetFields[\s>]/.test(body) && first) {
        first = false;
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><env:Fault>
<env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>NOSUCHPARAM</env:Value></env:Subcode></env:Code>
<env:Reason><env:Text>SoapFault NOSUCHPARAM: No such fieldname: "GuidelinePrice"</env:Text></env:Reason>
</env:Fault></env:Body></env:Envelope>`;
        const bytes = Buffer.from(xml, "utf8");
        return { ok: false, status: 500, headers: { get: () => null, getSetCookie: () => [] },
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      }
      return base(url, init);
    };
    const client = createClient({ username: "u", password: "p", fetchImpl });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const rows = await drain(adapter.products());
    assert.equal(rows.length, 3, "the export must survive a field this shop's API does not know");
    const w = adapter.warnings().find((x) => x.code === "FIELD_SET_REJECTED");
    assert.ok(w && /GuidelinePrice/.test(w.message), JSON.stringify(w));
  });
});

// =============================================================================================
describe("the content de-coupling (PLAN §1)", () => {
  test("the DanDomain adapter owns pages and posts — wp-content must not fill a hole", () => {
    const src = createSource(CFG);
    assert.equal(src.kind, "dandomain");
    assert.equal(typeof src.pages, "function");
    assert.equal(typeof src.posts, "function");
  });

  test("wp-content still applies to the WordPress kinds, on the same condition as before", () => {
    const woo = createSource({ source: { adapter: "woocommerce", baseUrl: "https://x.test", woocommerce: {}, wpContent: { enabled: true } } });
    assert.equal(woo.kind, "wordpress");
    assert.equal(typeof woo.posts, "function");
    assert.equal(typeof woo.pages, "function");

    const off = createSource({ source: { adapter: "woocommerce", baseUrl: "https://x.test", woocommerce: {}, wpContent: { enabled: false } } });
    assert.equal(off.posts, undefined);

    const edd = createSource({ source: { adapter: "edd", baseUrl: "https://x.test", wpContent: {} } });
    assert.equal(edd.kind, "wordpress");
    assert.equal(typeof edd.posts, "function");
  });

  test("the fixture adapter keeps its own content, now as a CONSEQUENCE of the rule", () => {
    const fx = createSource({ source: { adapter: "fixture", baseUrl: "https://x.test", wpContent: { enabled: true } } });
    assert.equal(fx.kind, "fixture");
    assert.equal(typeof fx.posts, "function");
    assert.equal(typeof fx.pages, "function");
  });

  test("an explicit cfg.source.kind overrides the adapter's own platform", () => {
    const forced = createSource({ source: { adapter: "woocommerce", kind: "dandomain", baseUrl: "https://x.test", woocommerce: {}, wpContent: {} } });
    assert.equal(forced.kind, "dandomain");
    assert.equal(forced.posts, undefined);
  });
});

// =============================================================================================
describe("layer 2 — the records survive the REAL transform", () => {
  /**
   * The claim D1 rests on: "the DanDomain adapter emits Woo-shaped records, so
   * the battle-tested transform machinery applies unchanged". A shape that only
   * LOOKS Woo-shaped is worth nothing — the proof is running the actual
   * transform over the actual adapter output and reading what comes out the far
   * side. Nothing here is stubbed except the network.
   */
  test("export -> transform end to end, offline", async (t) => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { runTransform } = await import("../src/transform/index.js");
    const { jsonlWriter, writeJson } = await import("../src/util/fsx.js");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-transform-"));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
    const raw = path.join(dir, "raw"), out = path.join(dir, "transformed");

    const { adapter } = harness(["shop", "products", "orders", "customers", "categories", "coupons", "pages"]);
    const settings = await adapter.settings();
    for (const [name, gen] of [["products", adapter.products], ["categories", adapter.categories],
      ["customers", adapter.customers], ["orders", adapter.orders], ["coupons", adapter.coupons],
      ["pages", adapter.pages]]) {
      const w = jsonlWriter(path.join(raw, `${name}.jsonl`));
      for await (const r of gen()) w.write(r);
      await w.close();
    }
    for (const empty of ["reviews", "posts"]) { const w = jsonlWriter(path.join(raw, `${empty}.jsonl`)); await w.close(); }
    writeJson(path.join(raw, "summary.json"), { adapter: "dandomain", settings, warnings: adapter.warnings() });

    const cfg = {
      ...CFG,
      paths: { raw, transformed: out },
      entities: { products: true, collections: true, customers: true, orders: true, discounts: true, pages: true, articles: false, redirects: true },
      options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true, stripShortcodes: true, rewriteInternalLinks: true, locale: "da", orders: { markFulfilledWhenComplete: true, importCancelled: false, tag: "dd-import" } },
      shopify: { blog: { title: "Blog", handle: "blog" } }
    };
    const res = await runTransform(cfg, cfg.entities);

    assert.equal(res.counts.products, 3);
    assert.equal(res.counts.customers, 1);
    assert.ok(res.counts.orders >= 2, `orders: ${res.counts.orders}`);
    // 8, not 6: the recorded sweep has one row each in folders 0 and 1 whose
    // TITLE the naive parser never extracted (R18). They are real pages and
    // they export — dropping an untitled row would be a silent loss.
    assert.equal(res.counts.pages, 8);

    const products = fs.readFileSync(path.join(out, "products.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const p1 = products[0].input;
    assert.equal(p1.title, "Eksempel på produkt 1", "the entity decode has to survive into the Shopify input");
    assert.equal(p1.handle, "eksempel-paa-produkt-1");
    assert.deepEqual(p1.productOptions.map((o) => o.name), ["Størrelse"]);
    assert.deepEqual(p1.productOptions[0].values.map((v) => v.name), ["Small", "Medium", "Large"]);
    assert.equal(p1.variants.length, 3);
    assert.equal(p1.files[0].originalSource, "https://shop000000.sfstatic.io/upload_dir/pics/product-1.png");
    assert.ok(
      p1.variants.some((v) => v.file?.originalSource === "https://shop000000.sfstatic.io/upload_dir/pics/product-1.png"),
      "P6 Task 1: variant PictureId reaches transform file.originalSource",
    );
    assert.ok(res.counts.collections >= 1, "SHIPPED-LIVE: categories → collections");
    assert.equal(res.counts.customers, 1, "SHIPPED-LIVE: customers");
    assert.ok(res.counts.pages >= 1, "SHIPPED-LIVE: CMS pages");
    assert.ok(p1.tags.includes("dd-id-1"), "PLAN D9: adapter-provided provenance prefix");
    assert.equal(p1.tags.includes("wp-id-1"), false);

    const orders = fs.readFileSync(path.join(out, "orders.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const o18 = orders.map((x) => x.order).find((o) => o.sourceIdentifier === "18");
    assert.equal(o18.lineItems[0].priceSet.shopMoney.amount, "80.00", "NET unit price, R1");
    assert.equal(o18.lineItems[0].taxLines[0].priceSet.shopMoney.amount, "20.00");
    assert.equal(o18.lineItems[0].taxLines[0].rate, 0.25);
    assert.equal(o18.transactions[0].amountSet.shopMoney.amount, "100.00", "the SALE transaction is the GROSS amount");

    // The adapter's export-time warnings reached warnings.jsonl through the one
    // channel that already existed, rather than through a second one.
    const warnings = fs.readFileSync(path.join(out, "warnings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const seen = new Set(warnings.map((w) => w.code));
    for (const code of ["BLOG_NOT_EXPORTED", "PRICE_LINES_DROPPED", "KUNDEGRUPPE_PRICING"]) {
      assert.ok(seen.has(code), `${code} did not reach warnings.jsonl (${[...seen].join(", ")})`);
    }
    // and the transform's own warnings still fire on these records
    assert.ok(seen.has("ZERO_PRICE") || seen.has("PRICE_ROUNDED") || warnings.length > 3, "the transform still inspects the records");
  });
});

// =============================================================================================
describe("R36 — the page-folder sweep is driven by the shop, and still covers folder 0", () => {
  test("the GraphQL folder list is used, UNIONED with 0", async () => {
    const pack = loadPack("shop", "pages");
    const calls = [];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, calls) });
    // A GraphQL stub that answers exactly what the live shop answered (ids 1/3/6/8 —
    // note: NO 0, though the SOAP sweep found a page in folder 0).
    const asked = [];
    client.graphql = () => ({ query: async (name, opts) => { asked.push({ name, opts }); return { rows: [{ id: "1" }, { id: "3" }, { id: "6" }, { id: "8" }] }; } });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    await drain(adapter.pages());
    assert.equal(asked.length, 1);
    assert.equal(asked[0].name, "folders");
    // `__type(name:"Folder")` lists id · sorting · languageLayerAccess ·
    // menuDisplaySettings · isLeaf · translations — no name, no title. Nothing
    // ever asked for one, so "it would fault" is R4's rule extended to this
    // transport, not a recorded observation; what IS recorded is the field list.
    assert.equal(asked[0].opts.selection, "id", "Folder's introspected fields contain no name or title");
    const folderCalls = calls.filter((c) => c.op === "PageText_GetByFolder").map((c) => Number(/<FolderId>(\d+)<\/FolderId>/.exec(c.body)?.[1]));
    assert.deepEqual(folderCalls, [0, 1, 3, 6, 8],
      "folder 0 is not in the GraphQL list but HELD a page in the recorded SOAP sweep");
    // and with a real folder list there is no sweep-bound to declare
    assert.equal(codes(adapter).includes("PAGE_FOLDER_SWEEP"), false);
  });
});

// =============================================================================================
describe("the secondary money path — what an adversarial review found uncovered", () => {
  /**
   * Twelve mutations to shipping, fees, discounts, quantities and country codes
   * survived all 53 assertions of the first version of this file, because the
   * recorded fixtures contain none of those shapes. The pack these tests use is
   * FULLY CONSTRUCTED and labelled so in its provenance; it claims nothing about
   * the platform and exists to make those mutations fail.
   */
  const moneyHarness = () => harness(["shop", "products", "categories", "orders-money"]);

  test("shipping VAT is applied, not dropped (OrderDelivery.Vat is a BOOLEAN)", async () => {
    const { adapter } = moneyHarness();
    const rows = await drain(adapter.orders());
    const o = rows.find((x) => x.id === 20);
    // 2 x 80 net, 10/unit off -> 140 net; 25 % from the product's VAT group -> 35.
    assert.equal(o.line_items[0].subtotal, "160.00");
    assert.equal(o.line_items[0].total, "140.00");
    assert.equal(o.line_items[0].taxes[0].total, "35.00");
    // 70 shipping NET + 17.50 VAT in taxes[], 20 fee NET + 5 VAT.
    assert.equal(o.shipping_lines[0].total, "70.00", "total is NET; dropping Delivery.Vat would omit taxes[] and understate Shopify taxLines");
    assert.equal(o.shipping_lines[0].taxes[0].total, "17.50");
    assert.equal(o.fee_lines[0].total, "20.00");
    assert.equal(o.fee_lines[0].taxes[0].total, "5.00");
    assert.equal(o.total_tax, "57.50");
    assert.equal(o.total, "287.50");
    assert.equal(o.discount_total, "20.00");
  });

  test("the rebuilt total AGREES with what the transaction says was captured", async () => {
    const { adapter } = moneyHarness();
    const rows = await drain(adapter.orders());
    // AmountFull states 287.50 independently of the lines. The rebuild lands on
    // the same number — 140 net + 35 VAT + 70 shipping + 17.50 + 20 fee + 5 —
    // which is the whole point of checking it: DROP the shipping VAT and the two
    // disagree by 17.50, which is exactly the defect this check exists for.
    assert.equal(rows.find((x) => x.id === 20).total, "287.50");
    assert.equal(codes(adapter).includes("ORDER_TOTAL_VS_CAPTURED"), false);
    // And order 21 — the fractional-quantity case — does NOT trip
    // ORDER_TOTAL_MISMATCH: 50 + 2.5 x 20 = 100 = its own Total. It DID before
    // the quantity guard stopped rounding 2.5 up to 3, which inflated the line
    // to 110 and then blamed the shop for a discrepancy this adapter created.
    // A money check that fires on every weighed-goods order is a check the
    // operator learns to ignore.
    assert.equal(codes(adapter).includes("ORDER_TOTAL_MISMATCH"), false);
  });

  test("...and the oracle FIRES when they disagree", async () => {
    const pack = loadPack("shop", "products", "categories", "orders-money");
    pack.responses.Order_GetAllWithPagination = pack.responses.Order_GetAllWithPagination
      .map((x) => x.replace("<AmountFull>287.5</AmountFull>", "<AmountFull>999</AmountFull>"));
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    await drain(adapter.orders());
    const w = adapter.warnings().find((x) => x.code === "ORDER_TOTAL_VS_CAPTURED");
    assert.ok(w, `expected ORDER_TOTAL_VS_CAPTURED in ${codes(adapter).join(", ")}`);
    assert.match(w.message, /captured 999, rebuilt 287\.5/);
  });

  test("a line whose product is gone gets NO tax — and says so", async () => {
    const { adapter } = moneyHarness();
    const rows = await drain(adapter.orders());
    const o = rows.find((x) => x.id === 21);
    assert.deepEqual(o.line_items[0].taxes, [], "there is no rate to derive from");
    const w = adapter.warnings().find((x) => x.code === "ORDER_LINE_VAT_UNRESOLVED");
    assert.ok(w, "silently charging 0 % understates the order by the VAT rate");
    assert.match(w.message, /OfflineProduct/);
  });

  test("a fractional quantity keeps its MONEY exact and loses only the unit count", async () => {
    const { adapter } = moneyHarness();
    const rows = await drain(adapter.orders());
    const o = rows.find((x) => x.id === 21);
    const line = o.line_items[1];
    // 2.5 kg at 20/kg. Shopify rejects a non-integer quantity outright, so the
    // line becomes quantity 1 — carrying the FULL 50.00, not 3 x 20 = 60.00.
    // Rounding the quantity would have changed what the customer paid and then
    // tripped the order-total check against the shop.
    assert.equal(line.quantity, 1);
    assert.equal(line.subtotal, "50.00", "rounding 2.5 up to 3 would make this 60.00");
    assert.equal(Number(o.line_items[0].subtotal) + Number(line.subtotal), 100, "the order still reconciles to its own Total");
    const meta = Object.fromEntries(line.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_source_amount, "2.5", "the source amount is not lost, it is recorded");
    assert.equal(meta._dd_unit, "kg");
    const w = adapter.warnings().find((x) => x.code === "ORDER_QUANTITY_RESHAPED");
    assert.ok(w && /kg/.test(w.message) && /money matches the source exactly/.test(w.message), JSON.stringify(w));
  });

  test("the country code resolves through the shop's own delivery-country list (F20)", async () => {
    const { adapter } = moneyHarness();
    const rows = await drain(adapter.orders());
    assert.equal(rows[0].billing.country, "DK", 'CountryCode is a NUMERIC id on this platform, never "DK"');
  });

  test("the line-price basis is decided across the WHOLE batch before anything is emitted", async () => {
    const { adapter } = moneyHarness();
    const rows = await drain(adapter.orders());
    // Order 20 has quantity 2 and reconciles unit-wise; order 21 is emitted
    // after it. Deciding inside the emit loop would leave any order yielded
    // BEFORE the decisive one on the default reading, silently.
    assert.equal(rows.find((x) => x.id === 20).line_items[0].subtotal, "160.00");
    const w = adapter.warnings().find((x) => x.code === "ORDER_LINE_PRICE_BASIS");
    assert.ok(w && /whole batch was read before any order was emitted/.test(w.message), JSON.stringify(w));
  });

  test("source.dandomain.lineBasis is READ — the warning's own remediation works", async () => {
    const { adapter } = harness(["shop", "products", "categories", "orders-money"], { lineBasis: "line" });
    const rows = await drain(adapter.orders());
    assert.equal(rows.find((x) => x.id === 20).line_items[0].subtotal, "80.00",
      "under the LINE reading, Price is the whole line and quantity does not multiply it");
    const w = adapter.warnings().find((x) => x.code === "ORDER_LINE_PRICE_BASIS");
    assert.match(w.message, /because source\.dandomain\.lineBasis says so/);
  });
});

// =============================================================================================
describe("collections — the membership that a null slug destroys", () => {
  test("a product's categories carry a REAL slug and name", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    const rows = await drain(adapter.products());
    assert.deepEqual(rows[0].categories, [{ id: 1, slug: "demo-kategori", name: "Demo kategori", _main: true }]);
    // R41 — a category with no SeoLink still has a storefront slug, derived from
    // its title. Null here becomes the handle "item" three layers downstream,
    // every collection lookup misses, and NOT ONE product lands in a collection
    // on a run that reports success.
    const cats = await drain(adapter.categories());
    assert.equal(cats.find((c) => c.id === 9).slug, "probe-kategori");
  });

  test("the membership survives the real transform into a real collection handle", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { transformProduct, transformCategory } = await import("../src/transform/products.js");
    const { adapter } = harness(["shop", "products", "categories"]);
    const rows = await drain(adapter.products());
    const cats = await drain(adapter.categories());
    const ctx = { cfg: { source: { baseUrl: "https://x" }, options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true } }, locationId: "L" };
    const { membership } = transformProduct(rows[0], ctx);
    const collection = transformCategory(cats.find((c) => c.id === 1), ctx);
    assert.deepEqual(membership.categorySlugs, ["demo-kategori"]);
    assert.equal(collection.slug, "demo-kategori");
    assert.equal(membership.categorySlugs[0], collection.slug,
      "import/collections.js resolves membership BY SLUG — a mismatch here is a silent zero-membership import");
    assert.ok(!membership.categorySlugs.includes("item"), "toHandle(null) is the literal 'item'");
    void os; void fs;
  });

  test("a product pointing at a category that no longer exists is reported", async () => {
    const pack = loadPack("shop", "products", "categories");
    // The category list answers with a DIFFERENT id, so product 1's category 1 is gone.
    pack.responses.Category_GetAll = [pack.responses.Category_GetAll[0].replace(/<Id>1<\/Id>/, "<Id>77</Id>")];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    await drain(adapter.products());
    assert.ok(codes(adapter).includes("CATEGORY_NOT_FOUND"));
  });

  test("a product restricted to a customer group is a disclosure risk, and is named", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    await drain(adapter.products());
    const w = adapter.warnings().find((x) => x.code === "PRODUCT_GROUP_RESTRICTED");
    assert.ok(w && /PUBLICLY VISIBLE/.test(w.message), JSON.stringify(w));
  });

  test("a product- or variant-level Discount is dropped LOUDLY, not silently", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    await drain(adapter.products());
    // The recorded variant rows carry Discount 49 / DiscountType "a" (R20).
    const w = adapter.warnings().find((x) => x.code === "PRODUCT_DISCOUNT_NOT_APPLIED");
    assert.ok(w, `expected PRODUCT_DISCOUNT_NOT_APPLIED in ${codes(adapter).join(", ")}`);
    assert.match(w.message, /undecoded/);
  });
});

describe("Hostedshop auto-collections — transform", () => {
  test("auto-col transform — secondary category stays a custom collection with no sources", async () => {
    const { transformProduct, transformCategory } = await import("../src/transform/products.js");
    const pctx = {
      cfg: { source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://x" }, options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true } },
      locationId: "L",
      provenance: { productIdTag: "dd-id-" },
    };
    const { membership } = transformProduct({
      id: 1, name: "P", slug: "p", type: "simple", status: "publish", description: "",
      regular_price: "10", attributes: [],
      categories: [
        { id: 1, name: "Demo kategori", slug: "demo-kategori" },
        { id: 9, name: "Probe Kategori", slug: "probe-kategori" },
      ],
      tags: [], images: [], brands: [],
      meta_data: [{ key: "_dd_id", value: "1" }],
    }, pctx);
    const main = transformCategory({ id: 1, name: "Demo kategori", slug: "demo-kategori", parent: 0, description: "" }, pctx);
    const sec = transformCategory({ id: 9, name: "Probe Kategori", slug: "probe-kategori", parent: 0, description: "" }, pctx);
    assert.deepEqual(membership.categorySlugs, ["demo-kategori", "probe-kategori"]);
    assert.equal(main.input.handle, "demo-kategori");
    assert.equal(sec.input.handle, "probe-kategori");
    assert.equal(main.kind, undefined);
    assert.equal(main.input.ruleSet, undefined);
    assert.equal(main.collection, undefined);
  });

  test("auto-col transform — distinct vendor yields brand-* conditions collection with productVendor EQUALS", async () => {
    const { buildHostedshopConditionsCollections } = await import("../src/transform/products.js");
    const { rows, warnings } = buildHostedshopConditionsCollections({
      vendors: ["Probe ApS", "Probe ApS", "  "],
      hasFocusFrontpage: false,
      reservedHandles: new Set(["demo-kategori"]),
    });
    assert.equal(rows.length, 1);
    assert.equal(warnings.length, 0);
    const row = rows[0];
    assert.equal(row.kind, "conditions");
    assert.equal(row.slug, "brand-probe-aps");
    assert.equal(row.collection.title, "Probe ApS");
    assert.equal(row.collection.handle, "brand-probe-aps");
    assert.equal(row.input, undefined);
    const cond = row.collection.sources[0].source;
    assert.equal(cond.title, "vendor");
    assert.equal(cond.targetType, "PRODUCTS");
    assert.deepEqual(cond.inclusion, {
      matchType: "ALL",
      conditions: [{ productVendor: { relation: "EQUALS", values: ["Probe ApS"], matchType: "ANY" } }],
    });
  });

  test("auto-col transform — brand row is skipped when handle is already used by a custom collection", async () => {
    const { buildHostedshopConditionsCollections } = await import("../src/transform/products.js");
    const { rows, warnings } = buildHostedshopConditionsCollections({
      vendors: ["Probe ApS"],
      hasFocusFrontpage: false,
      reservedHandles: new Set(["brand-probe-aps"]),
    });
    assert.equal(rows.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "HANDLE_COLLISION");
    assert.equal(warnings[0].severity, "handled");
    assert.match(warnings[0].message, /skipped/);
    assert.equal(/MERGE/i.test(warnings[0].message), false);
  });

  test("auto-col transform — two vendors that slugify to the same handle skip the later", async () => {
    const { buildHostedshopConditionsCollections } = await import("../src/transform/products.js");
    const { rows, warnings } = buildHostedshopConditionsCollections({
      vendors: ["Probe ApS", "Probe  ApS"],
      hasFocusFrontpage: false,
      reservedHandles: new Set(),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].collection.title, "Probe ApS");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "HANDLE_COLLISION");
    assert.match(warnings[0].message, /skipped/);
  });

  test("auto-col transform — FocusFrontpage tag yields fokus-forside; empty focus yields no collection", async () => {
    const { buildHostedshopConditionsCollections, DD_FOCUS_FRONTPAGE_TAG } = await import("../src/transform/products.js");
    const empty = buildHostedshopConditionsCollections({
      vendors: [],
      hasFocusFrontpage: false,
      reservedHandles: new Set(),
    });
    assert.equal(empty.rows.length, 0);
    const hit = buildHostedshopConditionsCollections({
      vendors: [],
      hasFocusFrontpage: true,
      reservedHandles: new Set(),
    });
    assert.equal(hit.rows.length, 1);
    const row = hit.rows[0];
    assert.equal(row.slug, "fokus-forside");
    assert.equal(row.kind, "conditions");
    assert.equal(row.collection.title, "Fokus forside");
    assert.equal(row.collection.handle, "fokus-forside");
    const cond = row.collection.sources[0].source;
    assert.equal(cond.title, "tag");
    assert.equal(cond.targetType, "PRODUCTS");
    assert.deepEqual(cond.inclusion, {
      matchType: "ALL",
      conditions: [{ productTag: { relation: "TAGGED_WITH", values: [DD_FOCUS_FRONTPAGE_TAG], matchType: "ANY" } }],
    });
  });

  test("auto-col transform — fokus-forside skipped when handle is already reserved", async () => {
    const { buildHostedshopConditionsCollections } = await import("../src/transform/products.js");
    const { rows, warnings } = buildHostedshopConditionsCollections({
      vendors: [],
      hasFocusFrontpage: true,
      reservedHandles: new Set(["fokus-forside"]),
    });
    assert.equal(rows.length, 0);
    assert.equal(warnings[0].code, "HANDLE_COLLISION");
    assert.match(warnings[0].message, /skipped/);
  });

  test("auto-col transform — runTransform on Hostedshop appends brand + fokus-forside; reviews stay off product tags", async (t) => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { runTransform } = await import("../src/transform/index.js");
    const { jsonlWriter, writeJson, readJson } = await import("../src/util/fsx.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-auto-col-"));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
    const raw = path.join(dir, "raw"), out = path.join(dir, "transformed");
    const pw = jsonlWriter(path.join(raw, "products.jsonl"));
    pw.write({
      id: 1, name: "Eksempel", slug: "eksempel", type: "simple", status: "publish",
      description: "", regular_price: "10",
      attributes: [], categories: [{ id: 1, name: "Demo kategori", slug: "demo-kategori" }],
      tags: [{ name: "dd-focus-frontpage" }],
      brands: [{ id: 1, name: "Probe ApS" }],
      images: [], meta_data: [{ key: "_dd_id", value: "1" }],
    });
    await pw.close();
    const cw = jsonlWriter(path.join(raw, "categories.jsonl"));
    cw.write({ id: 1, name: "Demo kategori", slug: "demo-kategori", parent: 0, description: "", permalink: "https://shop000000.mywebshop.io/shop/1-demo-kategori/" });
    await cw.close();
    writeJson(path.join(raw, "summary.json"), {
      adapter: "dandomain",
      settings: { provenance: { productIdTag: "dd-id-", orderTag: "dd-order-", statusTag: "dd-status-", orderNamePrefix: "#DD" } },
      warnings: [],
    });
    const cfg = {
      source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://shop000000.mywebshop.io" },
      paths: { raw, transformed: out },
      entities: { products: true, collections: true, customers: false, orders: false, discounts: false, pages: false, articles: false, redirects: false },
      options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true },
    };
    const res = await runTransform(cfg, cfg.entities);
    const cols = readJson(path.join(out, "collections.json"));
    const custom = cols.filter((c) => c.kind !== "conditions");
    const auto = cols.filter((c) => c.kind === "conditions");
    assert.equal(custom.length, 1);
    assert.equal(custom[0].slug, "demo-kategori");
    assert.ok(custom[0].input.handle);
    assert.equal(custom[0].input.sources, undefined);
    assert.equal(auto.length, 2);
    assert.ok(auto.find((c) => c.slug === "brand-probe-aps"));
    assert.ok(auto.find((c) => c.slug === "fokus-forside"));
    assert.equal(res.counts.collections, 3);
    const products = fs.readFileSync(path.join(out, "products.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(products[0].input.tags.includes("dd-focus-frontpage"), true);
    assert.equal(products[0].input.tags.includes("dd-id-1"), true);
    assert.equal(products[0].input.vendor, "Probe ApS");
    assert.equal(JSON.stringify(products).includes("reviewer@example.invalid"), false);
  });

  test("auto-col transform — runTransform on non-dandomain does not emit conditions collections", async (t) => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { runTransform } = await import("../src/transform/index.js");
    const { jsonlWriter, writeJson, readJson } = await import("../src/util/fsx.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woo-auto-col-"));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
    const raw = path.join(dir, "raw"), out = path.join(dir, "transformed");
    const pw = jsonlWriter(path.join(raw, "products.jsonl"));
    pw.write({
      id: 1, name: "Cup", slug: "cup", type: "simple", status: "publish",
      description: "", regular_price: "10",
      attributes: [], categories: [{ id: 1, name: "Køkken", slug: "koekken" }],
      tags: [{ name: "sale" }], brands: [{ name: "Acme" }], images: [], meta_data: [],
    });
    await pw.close();
    const cw = jsonlWriter(path.join(raw, "categories.jsonl"));
    cw.write({ id: 1, name: "Køkken", slug: "koekken", parent: 0, description: "" });
    await cw.close();
    writeJson(path.join(raw, "summary.json"), { settings: {}, warnings: [] });
    const cfg = {
      source: { adapter: "woocommerce", kind: "wordpress", baseUrl: "https://www.example-shop.com" },
      paths: { raw, transformed: out },
      entities: { products: true, collections: true, customers: false, orders: false, discounts: false, pages: false, articles: false, redirects: false },
      options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true },
    };
    await runTransform(cfg, cfg.entities);
    const cols = readJson(path.join(out, "collections.json"));
    assert.equal(cols.some((c) => c.kind === "conditions"), false);
    assert.equal(cols.some((c) => String(c.slug || "").startsWith("brand-")), false);
    assert.equal(cols.length, 1);
  });

  test("auto-col transform — DD verify note names brand/focus extras", async () => {
    const { verifyNotes } = await import("../src/stages/verify.js");
    assert.match(verifyNotes("dd-id-").collections, /brand/);
    assert.match(verifyNotes("dd-id-").collections, /fokus-forside|focus/i);
  });
});

describe("Hostedshop auto-collections — GraphQL documents", () => {
  test("auto-col graphql — COLLECTION_CREATE_CONDITIONS uses CollectionCreateInput sources, not ruleSet", async () => {
    const { COLLECTION_CREATE, COLLECTION_CREATE_CONDITIONS } = await import("../src/shopify/mutations.js");
    assert.match(COLLECTION_CREATE, /\$input:\s*CollectionInput!/);
    assert.equal(/ruleSet/.test(COLLECTION_CREATE), false);
    assert.match(COLLECTION_CREATE_CONDITIONS, /\$collection:\s*CollectionCreateInput!/);
    assert.match(COLLECTION_CREATE_CONDITIONS, /collectionCreate\(collection:\s*\$collection\)/);
    assert.equal(/ruleSet/.test(COLLECTION_CREATE_CONDITIONS), false);
    assert.equal(/CollectionInput!/.test(COLLECTION_CREATE_CONDITIONS), false);
  });
});

describe("Hostedshop auto-collections — app scopes", () => {
  test("auto-col scopes — shopify.app.toml and .env.example include publication scopes", () => {
    const root = path.join(HERE, "..");
    const toml = readFileSync(path.join(root, "shopify.app.toml"), "utf8");
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    const scopesLine = /^\s*scopes\s*=\s*"([^"]+)"/m.exec(toml);
    assert.ok(scopesLine, "shopify.app.toml must declare access_scopes.scopes");
    const scopes = scopesLine[1].split(",").map((s) => s.trim());
    for (const required of [
      "write_products", "write_customers", "write_orders", "write_discounts",
      "write_content", "write_files", "write_inventory", "read_locations",
      "read_publications", "write_publications",
    ]) {
      assert.equal(scopes.includes(required), true, `shopify.app.toml missing ${required}`);
    }
    assert.match(example, /read_publications/);
    assert.match(example, /write_publications/);
  });
});

describe("Hostedshop auto-collections — import", () => {
  test("auto-col import — conditions collections use collectionCreate(collection:) and skip membership", async (t) => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { writeJson } = await import("../src/util/fsx.js");
    const { openIdMap } = await import("../src/util/idmap.js");
    const { importCollections } = await import("../src/import/collections.js");
    const { COLLECTION_CREATE, COLLECTION_CREATE_CONDITIONS, PUBLISHABLE_PUBLISH, QUERY_PUBLICATIONS } = await import("../src/shopify/mutations.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-imp-col-"));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
    const transformed = path.join(dir, "transformed");
    const state = path.join(dir, "state");
    writeJson(path.join(transformed, "collections.json"), [
      { slug: "demo-kategori", input: { title: "Demo kategori", handle: "demo-kategori" } },
      {
        slug: "brand-probe-aps",
        kind: "conditions",
        collection: {
          title: "Probe ApS",
          handle: "brand-probe-aps",
          sources: [{
            source: {
              title: "vendor",
              targetType: "PRODUCTS",
              inclusion: {
                matchType: "ALL",
                conditions: [{ productVendor: { relation: "EQUALS", values: ["Probe ApS"], matchType: "ANY" } }],
              },
            },
          }],
        },
      },
    ]);
    writeJson(path.join(transformed, "product-memberships.json"), [
      { wooId: 1, handle: "p1", categorySlugs: ["demo-kategori", "brand-probe-aps"] },
    ]);
    const calls = [];
    const client = {
      async graphql(doc) {
        if (doc === QUERY_PUBLICATIONS) {
          return {
            publications: {
              nodes: [{
                id: "gid://shopify/Publication/online",
                supportsFuturePublishing: true,
                catalog: { apps: { nodes: [{ handle: "online_store" }] } },
              }],
            },
          };
        }
        return { collectionByHandle: null };
      },
      async mutate(name, doc, vars) {
        calls.push({ name, doc, vars });
        if (name === "collectionCreate") {
          const handle = vars.input?.handle || vars.collection?.handle;
          return { collection: { id: `gid://shopify/Collection/${handle}`, handle } };
        }
        if (name === "collectionAddProductsV2") return { job: { id: "j1" } };
        if (name === "publishablePublish") return { publishable: { id: vars.id } };
        throw new Error(`unexpected ${name}`);
      },
    };
    const cfg = { options: { dryRun: false }, paths: { transformed, state } };
    const idmap = openIdMap(state);
    idmap.set("products", "p1", "gid://shopify/Product/1");
    await importCollections(cfg, client, idmap);
    const creates = calls.filter((c) => c.name === "collectionCreate");
    assert.equal(creates.length, 2);
    assert.equal(creates[0].doc, COLLECTION_CREATE);
    assert.equal(creates[0].vars.input.handle, "demo-kategori");
    assert.equal(creates[0].vars.collection, undefined);
    assert.equal(creates[1].doc, COLLECTION_CREATE_CONDITIONS);
    assert.equal(creates[1].vars.collection.handle, "brand-probe-aps");
    assert.equal(creates[1].vars.input, undefined);
    const adds = calls.filter((c) => c.name === "collectionAddProductsV2");
    assert.equal(adds.length, 1);
    assert.equal(adds[0].vars.id, "gid://shopify/Collection/demo-kategori");
    assert.deepEqual(adds[0].vars.productIds, ["gid://shopify/Product/1"]);
    const publishes = calls.filter((c) => c.name === "publishablePublish");
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].doc, PUBLISHABLE_PUBLISH);
    assert.equal(publishes[0].vars.id, "gid://shopify/Collection/brand-probe-aps");
    assert.equal(publishes[0].vars.input[0].publicationId, "gid://shopify/Publication/online");
  });

  test("auto-col import — legacy collections.json rows without kind stay on the custom path", async (t) => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { writeJson } = await import("../src/util/fsx.js");
    const { openIdMap } = await import("../src/util/idmap.js");
    const { importCollections } = await import("../src/import/collections.js");
    const { COLLECTION_CREATE } = await import("../src/shopify/mutations.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-imp-legacy-"));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
    const transformed = path.join(dir, "transformed");
    const state = path.join(dir, "state");
    writeJson(path.join(transformed, "collections.json"), [
      { slug: "koekken", input: { title: "Køkken", handle: "koekken" } },
    ]);
    writeJson(path.join(transformed, "product-memberships.json"), []);
    const calls = [];
    const client = {
      async graphql() { return { collectionByHandle: null }; },
      async mutate(name, doc, vars) {
        calls.push({ name, doc, vars });
        return { collection: { id: "gid://shopify/Collection/koekken", handle: "koekken" } };
      },
    };
    await importCollections({ options: { dryRun: false }, paths: { transformed, state } }, client, openIdMap(state));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].doc, COLLECTION_CREATE);
    assert.ok(calls[0].vars.input);
  });
});

// =============================================================================================
describe("coupons — the guard that could never fire", () => {
  test("an unrecognised Discount.Type warns (R37: the field is a one-character column)", async () => {
    const pack = loadPack("shop", "coupons");
    pack.responses.Discount_GetAll = [pack.responses.Discount_GetAll[0].replace("<Type>percent</Type>", "<Type>z</Type>")];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const rows = await drain(adapter.coupons());
    assert.equal(rows[0].discount_type, "unknown",
      "R37 sentOrder:null — an unrecognised Type must not become a Shopify money-off type");
    const w = adapter.warnings().find((x) => x.code === "COUPON_TYPE_UNKNOWN");
    assert.ok(w, "the old guard tested the MAPPED value, which could only ever be valid");
    assert.match(w.message, /unknown/);
    assert.equal(/fixed_cart|FIXED CART/i.test(w.message), false,
      "the warning must not claim a usable Shopify money-off mapping");
  });

  test("a switched-off discount does not go live silently", async () => {
    const pack = loadPack("shop", "coupons");
    pack.responses.Discount_GetAll = [pack.responses.Discount_GetAll[0].replace("<IsActive>true</IsActive>", "<IsActive>false</IsActive>")];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const rows = await drain(adapter.coupons());
    assert.equal(rows.length, 2, "it still exports — the operator decides, not the adapter");
    assert.ok(codes(adapter).includes("COUPON_INACTIVE"));
  });

  test("StartDate leads DateCreated, because it is the activation date", async () => {
    // The fixture's two dates were IDENTICAL, so this test passed with the
    // fields swapped back — it asserted nothing. Make them differ.
    const pack = loadPack("shop", "coupons");
    pack.responses.Discount_GetAll = [pack.responses.Discount_GetAll[0]
      .replace("<StartDate>2025-01-10 08:00:00</StartDate>", "<StartDate>2025-06-06 06:00:00</StartDate>")];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const rows = await drain(adapter.coupons());
    assert.equal(rows[0].date_created_gmt, "2025-06-06T06:00:00", "DateCreated is 2025-01-10; StartDate must win");
    const meta = Object.fromEntries(rows[0].meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_is_active, "1");
  });

  test("a future StartDate is flagged — including one that already carries a Z", async () => {
    // `Date.parse(iso + "Z")` on a string that already ends in Z gives NaN, and
    // every comparison against NaN is false, so the check silently never fired.
    const pack = loadPack("shop", "coupons");
    pack.responses.Discount_GetAll = [pack.responses.Discount_GetAll[0]
      .replace("<StartDate>2025-01-10 08:00:00</StartDate>", "<StartDate>2027-01-10 08:00:00</StartDate>")];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    await drain(adapter.coupons());
    assert.ok(codes(adapter).includes("COUPON_NOT_STARTED"));
  });

  test("an UNSET IsActive is not `false` — an empty element must not disable every coupon", async () => {
    // This platform sends an unset value as an EMPTY ELEMENT, which parses to
    // "" and not `undefined`. Reading that as "the shop said false" flags every
    // discount inactive, and with skipInactiveCoupons exports NONE of them.
    const pack = loadPack("shop", "coupons");
    pack.responses.Discount_GetAll = [pack.responses.Discount_GetAll[0].replace(/<IsActive>[^<]*<\/IsActive>/g, "<IsActive/>")];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter({ ...CFG, source: { ...CFG.source, dandomain: { ...CFG.source.dandomain, skipInactiveCoupons: true } } },
      { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const rows = await drain(adapter.coupons());
    assert.equal(rows.length, 2, "an unstated IsActive must not be read as off");
    assert.equal(codes(adapter).includes("COUPON_INACTIVE"), false);
  });

  test("a prototype key cannot masquerade as a recognised discount type", async () => {
    for (const evil of ["constructor", "__proto__", "toString"]) {
      const pack = loadPack("shop", "coupons");
      pack.responses.Discount_GetAll = [pack.responses.Discount_GetAll[0].replace("<Type>percent</Type>", `<Type>${evil}</Type>`)];
      const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
      const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
      const rows = await drain(adapter.coupons());
      assert.equal(rows[0].discount_type, "unknown", `${evil}: a prototype key must not become a Shopify money-off type`);
      assert.ok(codes(adapter).includes("COUPON_TYPE_UNKNOWN"), `${evil}: the guard must still fire`);
    }
  });
});

// =============================================================================================
describe("the second review — defects the FIXES introduced or left", () => {
  test("R42's price reaches SHOPIFY, not just the adapter's top-level field", async () => {
    // The one that mattered most. `transform/products.js` prices a VARIABLE
    // product from `_variations` and discards the top-level `price`, so the rule
    // two probe rounds were spent confirming never reached the store: the
    // adapter said 55.00 and Shopify got 199.00 three times.
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { transformProduct } = await import("../src/transform/products.js");
    const { adapter } = harness(["shop", "products", "categories"]);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.price, "55.00");
    const { input } = transformProduct(p1, {
      cfg: { source: { baseUrl: "https://x" }, options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true } },
      locationId: "L",
    });
    // list 199 -> public 55 is a 0.2764 ratio; the variants are all 199 too.
    assert.deepEqual(input.variants.map((v) => v.price), ["55.00", "55.00", "55.00"]);
    assert.deepEqual(input.variants.map((v) => v.compareAtPrice), ["199.00", "199.00", "199.00"]);
    void os; void fs;
  });

  test("a variant priced apart from its product keeps its own price, scaled", async () => {
    const pack = loadPack("shop", "products", "categories");
    pack.responses.Product_GetAllWithLimit = pack.responses.Product_GetAllWithLimit
      .map((x) => x.replace("<Price>199</Price>\n            <BuyingPrice>79</BuyingPrice>", "<Price>398</Price>\n            <BuyingPrice>79</BuyingPrice>"));
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const [p1] = await drain(adapter.products());
    // whichever variant was doubled must not be flattened onto the others
    const prices = new Set(p1._variations.map((v) => v.price));
    assert.ok(prices.size >= 1);
    for (const v of p1._variations) assert.ok(Number(v.price) > 0, JSON.stringify(v));
  });

  test("a DEARER public line survives the transform instead of being clamped back", async () => {
    // `transform/products.js` drops a sale_price above regular_price as a
    // data-entry error. Putting a dearer public price there re-imposed exactly
    // the clamp R42 removed, while the adapter's warning said it had been used.
    const { transformProduct } = await import("../src/transform/products.js");
    const p = { Price: 199, Discounts: [{ Id: "1", Amount: "1", Price: "555", Discount: "0", DiscountType: "b", UserType: "guest", UserId: "0", Date: "false", DateFrom: "", DateTo: "" }] };
    const pp = publicPrice(p);
    assert.equal(pp.price, 555);
    assert.deepEqual(pp.dearerThanListPrice, { line: 555, listPrice: 199 });
    // and end to end, through the fixture path
    const pack = loadPack("shop", "products", "categories");
    pack.responses.Product_GetAllWithLimit = pack.responses.Product_GetAllWithLimit
      .map((x) => x.replace(/<Price>55<\/Price>/, "<Price>555</Price>"));
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const [p1] = await drain(adapter.products());
    assert.equal(p1.sale_price, "", "a dearer public price is the REGULAR price, never a sale");
    const { input } = transformProduct(p1, { cfg: { source: { baseUrl: "https://x" }, options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true } }, locationId: "L" });
    assert.equal(Number(input.variants[0].price) > 199, true, `got ${input.variants[0].price} — the clamp is back`);
  });

  test("a price line's date window is honoured when ddDate already returns a Z", () => {
    // Date.parse("2020-12-31T23:59:59Z" + "Z") is NaN, and NaN comparisons are
    // all false — so an expired window read as "no bound" and set today's price.
    const row = { Id: "1", Amount: "1", Price: "50", Discount: "0", DiscountType: "b", UserType: "guest", UserId: "0", Date: "true", DateFrom: "2020-01-01T00:00:00Z", DateTo: "2020-12-31T23:59:59Z" };
    const p = { Price: 1000, Discounts: [row] };
    assert.equal(publicPrice(p, { now: new Date("2026-01-01T00:00:00Z") }).price, 1000, "a window that closed in 2020 must not price 2026");
    assert.equal(publicPrice(p, { now: new Date("2020-06-01T00:00:00Z") }).price, 50);
  });

  test("the capture oracle survives an AmountFull of 0 (F30's øre fallback)", async () => {
    const pack = loadPack("shop", "products", "categories", "orders-money");
    pack.responses.Order_GetAllWithPagination = pack.responses.Order_GetAllWithPagination
      .map((x) => x.replace("<AmountFull>287.5</AmountFull>", "<AmountFull>0</AmountFull>")
        .replace("<Price>70</Price>", "<Price>10</Price>"));   // break the money model
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    await drain(adapter.orders());
    const w = adapter.warnings().find((x) => x.code === "ORDER_TOTAL_VS_CAPTURED");
    assert.ok(w, "`??` does not fall through on 0, which silently disabled the oracle");
    assert.match(w.message, /captured 287\.5/, "the øre field still states the truth");
  });

  test("a 0%-VAT order does not claim its totals are understated", async () => {
    const pack = loadPack("shop", "products", "categories", "orders-money");
    pack.responses.Product_GetAllWithLimit = pack.responses.Product_GetAllWithLimit
      .map((x) => x.replace(/<VatGroupId>2<\/VatGroupId>/g, "<VatGroupId>1</VatGroupId>"));
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const rows = await drain(adapter.orders());
    const o = rows.find((x) => x.id === 20);
    assert.equal(o.total_tax, "0.00");
    assert.equal(o.shipping_lines[0].total, "70.00", "0 % is a KNOWN rate — no VAT to add");
    assert.equal(codes(adapter).includes("SHIPPING_VAT_UNRESOLVED"), false,
      "filtering rates on `> 0` conflates 'zero' with 'unknown' and cries wolf on every VAT-exempt order");
  });

  test("an invalid lineBasis is refused AT CONSTRUCTION, before a single request", async () => {
    // It used to throw from inside orders(), i.e. after the whole catalogue and
    // order history had been read — measured at 14 SOAP calls on the fixtures,
    // hours on a real shop, with the accumulated warnings and summary.json
    // discarded with it. A config typo is knowable before the first request.
    for (const bad of ["line-total", true, 1, "unite"]) {
      assert.throws(() => harness(["shop", "products", "categories", "orders-money"], { lineBasis: bad }),
        /Missing config: source\.dandomain\.lineBasis/, String(bad));
    }
    // but a capitalised or padded valid value is accepted, because the operator
    // clearly meant it — the warning's own remediation must not fail on case.
    const { adapter } = harness(["shop", "products", "categories", "orders-money"], { lineBasis: " Line " });
    const rows = await drain(adapter.orders());
    assert.equal(rows.find((x) => x.id === 20).line_items[0].subtotal, "80.00");
  });

  test("a category with no Latin-mappable title still gets a slug, and collisions are named", async () => {
    const pack = loadPack("shop", "products", "categories");
    pack.responses.Category_GetAll = [pack.responses.Category_GetAll[0]
      .replace("<Title>Probe Kategori</Title>", "<Title>日本語カテゴリ</Title>")];
    const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const cats = await drain(adapter.categories());
    const c9 = cats.find((c) => c.id === 9);
    assert.equal(c9.slug, "kategori-9", "a null slug becomes the handle 'item' and every membership lookup misses");

    // two categories, one slug — the ordinary Herre>Jakker / Dame>Jakker shape
    const pack2 = loadPack("shop", "products", "categories");
    pack2.responses.Category_GetAll = [pack2.responses.Category_GetAll[0]
      .replace("<Title>Probe Kategori</Title>", "<Title>Demo kategori</Title>")
      .replace(/<SeoLink\/>|<SeoLink><\/SeoLink>/, "<SeoLink></SeoLink>")];
    const client2 = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack2, []) });
    const adapter2 = createDanDomainAdapter(CFG, { client: client2, now: () => new Date("2026-08-16T00:00:00Z") });
    await drain(adapter2.categories());
    assert.ok(codes(adapter2).includes("CATEGORY_SLUG_COLLISION"),
      "Shopify merges collections by handle — one is created, the other's products land in it, exit 0");
  });

  test("User_GetAllByDate is read behind an asserted field set, never User_GetAll", async () => {
    const pack = loadPack("shop", "products", "categories", "customers");
    pack.responses.Product_GetAllWithLimit = pack.responses.Product_GetAllWithLimit.map((xml) =>
      xml.replace("<ProducerId>0</ProducerId>", "<ProducerId>1</ProducerId>"));
    const { adapter, calls } = harnessFor(pack);
    const products = await drain(adapter.products());     // triggers the producer lookup
    await drain(adapter.customers());    // must NOT re-walk the windows
    const userOps = calls.map((c) => c.op).filter((op) => op === "User_SetFields" || op === "User_GetAll" || op === "User_GetAllByDate");
    assert.equal(userOps[0], "User_SetFields",
      "the producer lookup runs inside products(), which runExport walks BEFORE customers() — without this it read on the server's default projection (R4)");
    assert.ok(userOps.slice(1).every((op) => op === "User_GetAllByDate"),
      `user reads after SetFields must be User_GetAllByDate windows, got ${userOps.slice(1).join(",")}`);
    assert.equal(calls.filter((c) => c.op === "User_GetAll").length, 0,
      "User_GetAll is the 28 MB cliff; the date-window op is the only customer read");
    const windows = calls.filter((c) => c.op === "User_GetAllByDate");
    assert.ok(windows.length >= 2, `O17: a full export must issue multiple date windows, got ${windows.length}`);
    const starts = windows.map((c) => /<Start>([^<]*)<\/Start>/.exec(c.body)?.[1]);
    const ends = windows.map((c) => /<End>([^<]*)<\/End>/.exec(c.body)?.[1]);
    assert.equal(starts[0], "2000-01-01 00:00:00");
    assert.equal(ends[0], "2000-12-31 23:59:59");
    assert.equal(starts[1], "2001-01-01 00:00:00");
    assert.equal(new Set(starts).size, windows.length, "each window must have a distinct Start");
    assert.equal(products[0].brands[0]?.name, "Probe ApS", "producer index is a side-effect of the same ByDate walk");
  });

  test("the throttle is actually wired — an export must not hammer a live shop", () => {
    // The client's OWN default is refillPerSecond: Infinity — right for a probe,
    // wrong for an export that issues tens of thousands of requests against a
    // merchant's live shop. Asserted at the construction site, because that is
    // where it was missing.
    const built = [];
    const spy = (opts) => { built.push(opts); return { connect: async () => {} }; };
    createDanDomainAdapter(CFG, { createClient: spy });
    assert.deepEqual(built[0].throttle, { capacity: 1, refillPerSecond: 4 },
      "F27: the documented 5/s did not fire and there may be no signal at all before something breaks");
    built.length = 0;
    createDanDomainAdapter({ ...CFG, source: { ...CFG.source, dandomain: { ...CFG.source.dandomain, throttle: { capacity: 2, refillPerSecond: 10 } } } }, { createClient: spy });
    assert.deepEqual(built[0].throttle, { capacity: 2, refillPerSecond: 10 }, "and it stays overridable per shop");
  });

  test("the fixture pack still matches what the generator derives from the probes", () => {
    // `gen-dandomain-fixtures.mjs --check` had no runner anywhere, which made it
    // a check nobody ran: layer 1 could drift from `data/probes/` and the suite
    // would keep passing against a fixture that no longer represented a recording.
    //
    // `data/` is gitignored, so on a fresh clone the probes are absent and this
    // cannot run. It SKIPS there rather than failing — but loudly, and only on
    // that one condition, because a check that quietly opts out is the thing it
    // was written to prevent. On the machine that has the probes it is enforced.
    const probes = path.join(HERE, "..", "data", "probes");
    if (!existsSync(path.join(probes, "smoke.json"))) {
      assert.ok(true);
      return void console.warn("SKIPPED: the full probe set (data/probes/smoke.json etc.) is not in the repo — fixture drift is NOT checked in this environment");
    }
    const r = spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "gen-dandomain-fixtures.mjs"), "--check"],
      { cwd: path.join(HERE, ".."), encoding: "utf8" });
    assert.equal(r.status, 0, `the fixture pack has drifted from the probes, or an orphan is present:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /fixtures match the generator/);
  });

  test("the walk's completeness verdict is silent on a COMPLETE walk", async () => {
    // The negative half only. The positive half — that a short or unproven walk
    // actually raises the warning — is in the mutation-guard suite below, against
    // a payload built to produce one. On its own this assertion passes just as
    // happily with `reportWalk` deleted, which is what made it worth nothing.
    const { adapter } = harness(["shop", "products", "categories"]);
    await drain(adapter.products());
    assert.equal(codes(adapter).includes("WALK_INCOMPLETE"), false);
    assert.equal(codes(adapter).includes("WALK_SHORT_PAGES"), false);
  });
});

// =============================================================================================
/**
 * MUTATION GUARDS — the assertions that a surviving mutant demanded.
 *
 * A mutation-testing pass over the adapter left ten mutants alive: ten one-line
 * edits to shipping code that no assertion could tell apart from the original.
 * A surviving mutant is not a hypothetical. It is a measured statement that the
 * suite does not test that line, on a file whose green run is the reason anyone
 * believes the money rules hold. Each test below names the mutation it kills.
 *
 * They work by PATCHING THE RECORDED PAYLOAD rather than by inventing one: the
 * bytes stay the shape the server actually sends, and exactly one value moves.
 * `patchPack` fails loudly when a patch matches nothing, because a `.replace`
 * that silently no-ops leaves the test running against the untouched fixture and
 * passing for the wrong reason — the failure mode this whole suite exists to
 * avoid.
 */
function patchPack(packNames, patches) {
  const pack = loadPack(...packNames);
  for (const [op, fn] of Object.entries(patches)) {
    assert.ok(pack.responses[op], `patchPack: no recorded response for ${op} in ${packNames.join("+")}`);
    let changed = 0;
    // A walk's LAST recorded response is the empty confirming page, and a patch
    // has nothing to match there. So the rule is per-OPERATION, not per-response:
    // at least one response for each named operation must actually move, and an
    // operation where none did is a patch aimed at bytes that are not there.
    pack.responses[op] = pack.responses[op].map((xml, i) => {
      const next = fn(xml, i);
      if (next !== xml) changed += 1;
      return next;
    });
    assert.ok(changed > 0, `patchPack: the patch for ${op} changed NOTHING in any of its ${pack.responses[op].length} response(s) — the test would run against the untouched fixture and pass for the wrong reason`);
  }
  return pack;
}

function harnessFor(pack, overrides = {}, extras = {}) {
  const { options: optOv, ...ddOv } = overrides;
  const calls = [];
  const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, calls) });
  if (extras.graphqlStub) client.graphql = () => extras.graphqlStub;
  const cfg = {
    ...CFG,
    source: { ...CFG.source, dandomain: { ...CFG.source.dandomain, ...ddOv } },
    options: { ...CFG.options, ...optOv },
  };
  return { adapter: createDanDomainAdapter(cfg, { client, now: () => new Date("2026-08-16T00:00:00Z") }), calls, client };
}

/** CONSTRUCTED SOAP envelope for ops the recorded packs never returned. */
function soapResult(op, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="https://api.hostedshop.io/service.php">
  <env:Body>
    <ns1:${op}Response>
      <ns1:${op}Result>${inner}</ns1:${op}Result>
    </ns1:${op}Response>
  </env:Body>
</env:Envelope>`;
}

function withOps(pack, extras) {
  for (const [op, inner] of Object.entries(extras)) {
    pack.responses[op] = [inner.includes("env:Envelope") ? inner : soapResult(op, inner)];
  }
  return pack;
}

/**
 * Replace the FIRST occurrence of `find`, or return the response untouched when
 * it is not there. Tolerant on purpose: `patchPack`'s per-operation guard is what
 * catches a patch that hits nothing, and it can tell "this response has no such
 * bytes" (normal — the confirming empty page) from "no response does" (a bug).
 */
const sub = (find, replace) => (xml) => {
  const at = xml.indexOf(find);
  if (at === -1) return xml;
  return xml.slice(0, at) + replace + xml.slice(at + find.length);
};

describe("mutation guards — one test per surviving mutant", () => {
  const PRODUCTS = ["shop", "products", "categories"];
  const warnOf = (adapter, code) => adapter.warnings().find((w) => w.code === code);

  // -- M5 ------------------------------------------------------------------------------------
  test("M5 — utcMs honours an explicit UTC OFFSET instead of stamping Z onto it", () => {
    // The mutant deletes the HAS_ZONE branch and always appends "Z". On a value
    // that already carries an offset that yields "…+02:00Z", which Date.parse
    // rejects — so every comparison against it becomes false, and a price window
    // that expired in 2020 reads as "in window" and sets today's price.
    assert.equal(utcMs("2026-08-16T10:00:00+02:00"), Date.UTC(2026, 7, 16, 8, 0, 0),
      "+02:00 means 08:00 UTC; appending Z would give NaN and appending nothing would give local time");
    assert.equal(utcMs("2026-08-16T10:00:00-05:00"), Date.UTC(2026, 7, 16, 15, 0, 0));
    assert.equal(utcMs("2026-08-16T10:00:00Z"), Date.UTC(2026, 7, 16, 10, 0, 0));
    assert.equal(utcMs("2026-08-16T10:00:00"), Date.UTC(2026, 7, 16, 10, 0, 0), "no zone = the server's UTC, not the runner's local zone");
    assert.equal(utcMs("2026-08-16T10:00:00+0200"), Date.UTC(2026, 7, 16, 8, 0, 0), "the compact offset form too");
    assert.equal(utcMs("not a date"), null);
    assert.equal(utcMs(null), null);
    // and the whole reason it matters: an expired window must READ as expired
    const expired = [{ Id: "1", Amount: "1", Price: "50", Discount: "0", DiscountType: "b", UserType: "all", UserId: "0",
      Date: "true", DateFrom: "2020-01-01T00:00:00+02:00", DateTo: "2020-12-31T23:59:59+02:00" }];
    assert.equal(publicPrice({ Price: 100, Discounts: expired }, { now: new Date("2026-01-01T00:00:00Z") }).price, 100,
      "an offset-carrying window that closed in 2020 must not set today's price");
  });

  // -- M1 / M3 -------------------------------------------------------------------------------
  // The recorded product 1 already carries the shape these need: Price 199, a
  // `guest`/UserId 0 line at 55, and three variants all priced 199. All three at
  // 199 is precisely why the mutant lived — scaling and copying give the same
  // answer when every variant equals the product. So one variant is repriced.
  const VARIANT_PRICE = "<Price>199</Price>\n              <BuyingPrice>79</BuyingPrice>";
  const PRODUCT_PRICE = "<Price>199</Price>\n          <Discount>0</Discount>";

  test("M1 — a product-level price line scales its variants PROPORTIONALLY, not by copying", async () => {
    // The mutant returns `{regular: chosen}` for every variant, so the first
    // variant, repriced to 400, would come out at 55 — an 86 % markdown on a
    // live catalogue that nothing in the suite could see.
    const pack = patchPack(PRODUCTS, {
      Product_GetAllWithLimit: sub(VARIANT_PRICE, "<Price>400</Price>\n              <BuyingPrice>79</BuyingPrice>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    // list 199, recorded public line 55 -> ratio 55/199
    assert.equal(Number(p1.regular_price), 199, "the entered VAT-inclusive price stays the compare-at (R1)");
    assert.equal(Number(p1.sale_price), 55);
    const byId = Object.fromEntries(p1._variations.map((v) => [v.id, v]));
    const repriced = byId[4];
    assert.equal(Number(repriced.regular_price), 400, "the variant's own price stays the compare-at");
    assert.ok(Math.abs(Number(repriced.sale_price) - 400 * (55 / 199)) < 0.01,
      `expected the RATIO applied (${(400 * (55 / 199)).toFixed(2)}), got ${repriced.sale_price} — copying the line would give 55.00`);
    assert.notEqual(Number(repriced.sale_price), 55, "the flattening this test exists to catch");
    // the untouched siblings still land on the line, because for them the ratio
    // and the copy genuinely agree
    assert.equal(Number(byId[5].sale_price), 55);
  });

  test("M3 — with no usable base price there is NO ratio, so variants keep their own and the shop is told", async () => {
    // The mutant deletes the `ref > 0` guard, and `chosen / 0` is Infinity — a
    // price that reaches Shopify as a rejected mutation late in an import rather
    // than as a warning early. The guard's ORIGINAL form was wrong in the other
    // direction too: it copied the line onto every variant, which is the loss its
    // own comment claimed to prevent. Both are asserted here.
    const pack = patchPack(PRODUCTS, {
      Product_GetAllWithLimit: (xml) => sub(PRODUCT_PRICE, "<Price>0</Price>\n          <Discount>0</Discount>")(
        sub(VARIANT_PRICE, "<Price>300</Price>\n              <BuyingPrice>79</BuyingPrice>")(xml)),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const byId = Object.fromEntries(p1._variations.map((v) => [v.id, v]));
    for (const v of p1._variations) {
      const n = Number(v.regular_price);
      assert.ok(Number.isFinite(n), `variant ${v.id}: price must be finite, got ${JSON.stringify(v.regular_price)}`);
    }
    assert.equal(Number(byId[4].regular_price), 300, "a 300 DKK variant keeps its own price — copying the 55 line onto it is the loss");
    assert.equal(byId[4].sale_price, undefined, "and with no ratio there is no sale price to derive");
    const w = warnOf(adapter, "PRICE_LINE_NOT_SCALABLE");
    assert.ok(w, `expected PRICE_LINE_NOT_SCALABLE, got ${JSON.stringify(codes(adapter))}`);
    assert.match(w.message, /no ratio/i);
  });

  test("a VARIANT-scoped price line is that variant's price, not something to scale", async () => {
    // The other half of the same defect. `publicPrice` falls back to the
    // product-level rows when a variant has none, so `rows > 0` is true either
    // way — the adapter used it as the test for "this variant has its own line"
    // and scaled a variant-scoped line by the PRODUCT's ratio, pricing the
    // variant at neither number. 400 * (120/199) = 241.21, not 120.
    const pack = patchPack(PRODUCTS, {
      Product_GetAllWithLimit: (xml) => sub("<Discounts>", `<Discounts><item>
          <Id>9003</Id><ProductId>1</ProductId><ProductVariantId>4</ProductVariantId>
          <Amount>1</Amount><Price>120</Price><Discount>0</Discount><Currency>DKK</Currency><DiscountType>b</DiscountType>
          <UserType>guest</UserType><UserId>0</UserId><Date>false</Date><DateFrom></DateFrom><DateTo></DateTo>
          <Accumulate>false</Accumulate><Site>1</Site><Language>DK</Language>
        </item>`)(sub(VARIANT_PRICE, "<Price>400</Price>\n              <BuyingPrice>79</BuyingPrice>")(xml)),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const v4 = p1._variations.find((v) => v.id === 4);
    assert.equal(Number(v4.regular_price), 400, "its own price is the compare-at");
    assert.equal(Number(v4.sale_price), 120, `the variant-scoped line IS the price; scaling would give ${(400 * (120 / 199)).toFixed(2)}`);
    // and the siblings, which have no line of their own, still take the product's by ratio
    const v5 = p1._variations.find((v) => v.id === 5);
    assert.equal(Number(v5.sale_price), 55);
    assert.ok(warnOf(adapter, "PRICE_LINES_VARIANT_SCOPED"), JSON.stringify(codes(adapter)));
  });

  // -- M7 / M8 -------------------------------------------------------------------------------
  test("M7 — a zero or negative OrderLine.Amount is reshaped to 1 and reported, never used as a quantity", async () => {
    // Shopify rejects quantity 0, and a NEGATIVE quantity is how a credit note is
    // encoded on this platform. The mutant relaxes `>= 1` to `>= 0`, which ships
    // a zero-quantity line into an order import and fails it at the API — after
    // the export, the transform and half the import have already run.
    for (const [amount, label] of [["0", "zero"], ["-2", "negative"]]) {
      const pack = patchPack(["shop", "products", "categories", "orders"], {
        Order_GetAllWithPagination: sub("<Amount>1</Amount>", `<Amount>${amount}</Amount>`),
      });
      const { adapter } = harnessFor(pack);
      const orders = await drain(adapter.orders());
      const lines = orders.flatMap((o) => o.line_items);
      for (const li of lines) {
        assert.ok(Number.isInteger(li.quantity) && li.quantity >= 1,
          `${label}: quantity ${JSON.stringify(li.quantity)} would be rejected by Shopify`);
      }
      const w = warnOf(adapter, "ORDER_QUANTITY_RESHAPED");
      assert.ok(w, `${label}: expected ORDER_QUANTITY_RESHAPED, got ${JSON.stringify(codes(adapter))}`);
      // the original is preserved on the record, because a reshaped value that
      // cannot be traced back is a value nobody can reconcile against the shop
      const reshaped = lines.find((li) => (li.meta_data ?? []).some((m) => m.key === "_dd_source_amount"));
      assert.ok(reshaped, `${label}: the source Amount must survive as line metadata`);
      assert.equal(reshaped.meta_data.find((m) => m.key === "_dd_source_amount").value, amount);
    }
  });

  test("M8 — an absurd OrderLine.Amount is reshaped too; the bound is a real bound", async () => {
    // The mutant raises 1e6 to 1e9. A quantity of 2,000,000 on one line is a unit
    // artefact (grams, millimetres), not two million items — and importing it
    // creates an order for two million units of stock.
    const pack = patchPack(["shop", "products", "categories", "orders"], {
      Order_GetAllWithPagination: sub("<Amount>1</Amount>", "<Amount>2000000</Amount>"),
    });
    const { adapter } = harnessFor(pack);
    const orders = await drain(adapter.orders());
    for (const li of orders.flatMap((o) => o.line_items)) {
      assert.ok(li.quantity <= 1e6, `quantity ${li.quantity} is past the bound the adapter claims to enforce`);
    }
    assert.ok(warnOf(adapter, "ORDER_QUANTITY_RESHAPED"), JSON.stringify(codes(adapter)));
  });

  // -- M10 / M11 / M12 / M23 -----------------------------------------------------------------
  test("M10-M12, M23 — per-record warnings are CAPPED and the roll-up carries the true total", async () => {
    // Measured, not imagined: 10k products with kundegruppe pricing raised 10,000
    // PRICE_LINES_DROPPED objects, and a shop tripping several codes produced
    // 60,000 warnings / 27 MB of warnings.jsonl. The four mutants here removed
    // the cap, removed the roll-up, made the roll-up count the suppressed rows
    // only, and dropped the "every record is still exported" sentence. The last
    // one matters most: a cap that reads as a FILTER makes an operator believe
    // records were skipped.
    //
    // 130 products, each with one customer-scoped price line, all raising the
    // same code. The recorded single-product block is repeated with fresh ids —
    // the SHAPE is the server's, the volume is the test's.
    const N = 130;
    const pack = patchPack(PRODUCTS, {
      Product_GetAllWithLimit: (xml) => {
        // TOP-LEVEL items only. `<item>` nests three deep here (products,
        // variants, discount rows) and the recorded product 1 has a VARIANT whose
        // Id is 4 — so a non-greedy scan to "the item before <Id>4</Id>" cut the
        // block in the middle of <Variants> and produced XML the parser rejected.
        // The eight-space indentation is the recorded document's own, and it is
        // asserted rather than assumed.
        const one = /^ {8}<item>\n {10}<Id>1<\/Id>[\s\S]*?\n {8}<\/item>\n/m.exec(xml);
        if (!one) return xml;   // the confirming empty page — patchPack's guard covers the real miss
        const withLine = one[0].replace("<Discounts>", `<Discounts><item>
          <Id>9100</Id><ProductId>1</ProductId><ProductVariantId>0</ProductVariantId>
          <Amount>1</Amount><Price>42</Price><Discount>0</Discount><DiscountType>b</DiscountType>
          <UserType>group</UserType><UserId>4</UserId><Date>false</Date><DateFrom></DateFrom><DateTo></DateTo>
        </item>`);
        const many = Array.from({ length: N }, (_, i) =>
          withLine.replace(/<Id>1<\/Id>/, `<Id>${5000 + i}</Id>`).replace(/<ItemNumber>DEMO-1<\/ItemNumber>/, `<ItemNumber>DEMO-${5000 + i}</ItemNumber>`),
        ).join("");
        return xml.replace(one[0], many);
      },
    });
    const { adapter } = harnessFor(pack);
    const rows = await drain(adapter.products());
    assert.ok(rows.length >= N, `all ${N} products must still be EXPORTED — the cap is a display limit: got ${rows.length}`);

    const w = adapter.warnings();
    const dropped = w.filter((x) => x.code === "PRICE_LINES_DROPPED");
    // M10/M11: capped at 50 per code, not one per record
    assert.equal(dropped.length, 51, `expected 50 per-record warnings + 1 roll-up, got ${dropped.length}`);
    const roll = dropped.filter((x) => x.id === "all" || /more record/i.test(x.message));
    assert.equal(roll.length, 1, "exactly one roll-up");
    // M12: the roll-up reports the TRUE total, not just the suppressed remainder
    assert.match(roll[0].message, new RegExp(`\\b${N}\\b`),
      `the roll-up must name the true total (${N}); reporting only the ${N - 50} suppressed ones understates it: ${roll[0].message}`);
    // M23: and it must say the cap is a display limit, or an operator reads it as data loss
    assert.match(roll[0].message, /still exported/i);
  });

  // -- M19 -----------------------------------------------------------------------------------
  test("M19 — a MID-WALK short page is reported, not silently treated as a whole export", async () => {
    // The mutant deletes reportWalk's body. The suite's only walk assertion was
    // that a COMPLETE fixture walk raises nothing, which an empty function
    // satisfies perfectly — so the mutant lived.
    //
    // The signal here is H1's: a window that comes back SHORT in the middle of a
    // walk. ONE short page is the end of the data and must stay silent (that is
    // the ordinary case on any shop smaller than a page, and warning on it would
    // fire everywhere). TWO means the server truncated a window mid-walk, which
    // is how a large export loses records quietly. So a second short page is
    // spliced in between the recorded first page and the recorded empty one.
    const pack = loadPack(...PRODUCTS);
    const pages = pack.responses.Product_GetAllWithLimit;
    assert.equal(pages.length, 2, "the recorded walk is [rows, empty]; this splice assumes that shape");
    // ONE top-level item, taken verbatim from the recorded page and renumbered.
    // Matching on the eight-space indentation is deliberate: `<item>` nests three
    // deep and the recorded product 1 has a variant whose Id is 4, so any scan
    // keyed on `<Id>4</Id>` cuts the block open mid-<Variants>.
    const blocks = pages[0].match(/^ {8}<item>\n[\s\S]*?\n {8}<\/item>\n/gm) ?? [];
    assert.equal(blocks.length, 3, "the recorded first page holds three top-level products");
    const extra = pages[0]
      .replace(blocks.join(""), blocks[0]
        .replace("<Id>1</Id>", "<Id>7001</Id>")
        .replace("<ItemNumber>DEMO-1</ItemNumber>", "<ItemNumber>DEMO-7001</ItemNumber>"));
    assert.notEqual(extra, pages[0], "the spliced page must actually differ from the recorded one");
    assert.equal((extra.match(/^ {8}<item>$/gm) ?? []).length, 1, "the spliced page must be SHORT — one product, not three");
    pack.responses.Product_GetAllWithLimit = [pages[0], extra, pages[1]];

    const { adapter } = harnessFor(pack, { pageSize: 50 });
    const rows = await drain(adapter.products());
    assert.ok(rows.length > 3, `both windows' records must be kept — a short page never ends a walk (H1); got ${rows.length}`);
    const w = warnOf(adapter, "WALK_SHORT_PAGES");
    assert.ok(w, `two short windows must be reported; got ${JSON.stringify(codes(adapter))}`);
    assert.match(w.message, /short|truncat/i, "the message has to tell an operator what the signal means");
    assert.equal(w.severity, "handled", "the walk handled it correctly — this is telemetry, not an action item");
  });
});

// =============================================================================================
/**
 * P2 audit defects (D1–D5 + named reconstruct). Each test is the
 * input that distinguishes the shipping line from its opposite. Money first.
 */
describe("P2 audit — silent mappings the suite did not pin", () => {
  test("D1 — Discount.Type 'a' is unknown (R37 sentOrder:null), not a silent fixed_cart", async () => {
    // Letters that look like Woo initials must still warn. R37 recorded
    // sentOrder:null — the API cannot decode a/p/%/1/2. Mapping them as
    // recognised types made COUPON_TYPE_UNKNOWN a dead warning.
    for (const letter of ["a", "p", "%", "1", "2"]) {
      const pack = loadPack("shop", "coupons");
      pack.responses.Discount_GetAll = [pack.responses.Discount_GetAll[0].replace("<Type>percent</Type>", `<Type>${letter}</Type>`)];
      assert.notEqual(pack.responses.Discount_GetAll[0].includes("<Type>percent</Type>"), true, `patch for Type ${JSON.stringify(letter)} did not apply`);
      const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
      const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
      const rows = await drain(adapter.coupons());
      assert.equal(rows[0].discount_type, "unknown",
        `${letter}: R37 sentOrder:null — Type letters must not become a Shopify money-off type`);
      assert.equal(["percent", "fixed_cart", "fixed_product", "free_shipping"].includes(rows[0].discount_type), false,
        `${letter}: transform must not receive a known Woo discount_type`);
      assert.ok(codes(adapter).includes("COUPON_TYPE_UNKNOWN"),
        `${letter}: must warn — R37 recorded that one-character Type values cannot be decoded from the API`);
    }
  });

  test("D1 — KNOWN coupon Type values are words only; no invented a/b DiscountType vocab", async () => {
    const words = [
      ["percent", "percent"],
      ["ship", "free_shipping"],
      ["shipping", "free_shipping"],
      ["product", "fixed_product"],
      ["amount", "fixed_cart"],
      ["kr", "fixed_cart"]
    ];
    for (const [type, mapped] of words) {
      const pack = loadPack("shop", "coupons");
      pack.responses.Discount_GetAll = [pack.responses.Discount_GetAll[0].replace("<Type>percent</Type>", `<Type>${type}</Type>`)];
      assert.ok(pack.responses.Discount_GetAll[0].includes(`<Type>${type}</Type>`), `patch for Type ${type} did not apply`);
      const client = createClient({ username: "u", password: "p", fetchImpl: fakeFetch(pack, []) });
      const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
      const rows = await drain(adapter.coupons());
      assert.equal(rows[0].discount_type, mapped, `${type} is a word in KNOWN`);
      assert.equal(codes(adapter).includes("COUPON_TYPE_UNKNOWN"), false, `${type} must not warn`);
    }
    const src = readFileSync(path.join(HERE, "..", "src", "sources", "dandomain.js"), "utf8");
    const i = src.indexOf("const KNOWN = Object.assign");
    const j = src.indexOf("const recognised = KNOWN", i);
    assert.ok(i !== -1 && j !== -1, "KNOWN block moved");
    const objStart = src.indexOf("{", i);
    const obj = src.slice(objStart, j);
    for (const letter of ['"a"', '"p"', '"%"', '"1"', '"2"', '"b"', " a:", " p:", " b:"]) {
      assert.equal(obj.includes(letter), false, `KNOWN must not invent letter vocab ${JSON.stringify(letter)}`);
    }
  });

  test("D2 — shop currency is not unique rate-1 and not Currency_GetAll[0]", async () => {
    // Fixture has one DKK row (rate 1), so [0] and unique rate-1 agree by
    // accident. Prepend EUR at 7.45: unique rate-1 exports DKK, [0] exports EUR.
    // Neither is recorded — WSDL Currency has no Primary, SOAP Site has no
    // Valuta, ShopWebinfo has no currency, help-page primary is Site Standard.
    // Length !== 1 must warn and leave currency unset.
    const pack = patchPack(["shop"], {
      Currency_GetAll: (xml) => {
        const eur =
          "        <item>\n" +
          "          <Id>2</Id>\n" +
          "          <Iso>EUR</Iso>\n" +
          "          <Symbol>EUR</Symbol>\n" +
          "          <SymbolPlace>right</SymbolPlace>\n" +
          "          <Currency>7.45</Currency>\n" +
          "          <Decimal>,</Decimal>\n" +
          "          <DecimalCount>2</DecimalCount>\n" +
          "          <Point>.</Point>\n" +
          "          <Round>3</Round>\n" +
          "          <RoundOn>2</RoundOn>\n" +
          "          <Title>Euro</Title>\n" +
          "        </item>\n";
        const needle = "<ns1:Currency_GetAllResult>\n";
        assert.ok(xml.includes(needle), "Currency_GetAll envelope shape changed");
        return xml.replace(needle, needle + eur);
      }
    });
    const { adapter } = harnessFor(pack);
    const st = await adapter.settings();
    assert.equal(st.currency, undefined,
      "rate-1 would pick DKK; [0] would pick EUR; neither is a recorded default");
    assert.ok(codes(adapter).includes("CURRENCY_LIST_AMBIGUOUS"),
      "more than one Currency_GetAll row and no ShopWebinfo currency field — say so");
  });

  test("D2 — two rate-1 rows cannot be silently resolved by list position", async () => {
    const pack = patchPack(["shop"], {
      Currency_GetAll: (xml) => {
        const usd =
          "        <item>\n" +
          "          <Id>3</Id>\n" +
          "          <Iso>USD</Iso>\n" +
          "          <Symbol>USD</Symbol>\n" +
          "          <SymbolPlace>left</SymbolPlace>\n" +
          "          <Currency>1</Currency>\n" +
          "          <Decimal>.</Decimal>\n" +
          "          <DecimalCount>2</DecimalCount>\n" +
          "          <Point>,</Point>\n" +
          "          <Round>3</Round>\n" +
          "          <RoundOn>2</RoundOn>\n" +
          "          <Title>US Dollar</Title>\n" +
          "        </item>\n";
        const needle = "<ns1:Currency_GetAllResult>\n";
        return xml.replace(needle, needle + usd);
      }
    });
    const { adapter } = harnessFor(pack);
    const st = await adapter.settings();
    assert.equal(st.currency, undefined,
      "two rate-1 rows: [0] is USD; list position is not a recorded default");
    assert.ok(codes(adapter).includes("CURRENCY_LIST_AMBIGUOUS"),
      "two rate-1 rows: warning must fire — [0] is not a recorded default");
  });

  test("D2 — 0 Currency_GetAll rows warn and leave currency unset", async () => {
    // A `length > 1` warn mutant stays silent on the empty list. N-row D2 tests
    // and the 1-row settings test cannot see that. 0 rows is not a recorded
    // default — WSDL Currency has no Primary; SOAP Site has no Valuta.
    const pack = patchPack(["shop"], {
      Currency_GetAll: (xml) => {
        const next = xml.replace(/<ns1:Currency_GetAllResult>[\s\S]*?<\/ns1:Currency_GetAllResult>/,
          "<ns1:Currency_GetAllResult/>");
        assert.notEqual(next, xml, "0-row patch must empty Currency_GetAllResult");
        return next;
      }
    });
    const { adapter } = harnessFor(pack);
    const st = await adapter.settings();
    assert.equal(st.currency, undefined, "no Currency_GetAll row means no shop currency");
    assert.ok(codes(adapter).includes("CURRENCY_LIST_AMBIGUOUS"),
      "0 rows must warn — a >1-only mutant is silent here");
  });

  test("D2 — 1 Currency_GetAll row is that ISO and does not warn", async () => {
    // The fixture's one DKK row agrees with a hardcoded "DKK" and with [0].
    // Replace the ISO: hardcoded DKK fails; always-warn fails; skip-pick fails.
    const pack = patchPack(["shop"], {
      Currency_GetAll: (xml) => {
        const next = xml.replace("<Iso>DKK</Iso>", "<Iso>NOK</Iso>");
        assert.notEqual(next, xml, "1-row ISO patch must apply");
        return next;
      }
    });
    const { adapter } = harnessFor(pack);
    const st = await adapter.settings();
    assert.equal(st.currency, "NOK", "the sole row is the shop currency");
    assert.equal(codes(adapter).includes("CURRENCY_LIST_AMBIGUOUS"), false,
      "one row is unambiguous — an always-warn mutant dies here");
  });

  test("D3 — a failed Solution_HasModule is not 'module absent'", async () => {
    const pack = loadPack("shop");
    const calls = [];
    const base = fakeFetch(pack, calls);
    const fault = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><env:Fault>
<env:Code><env:Value>env:Sender</env:Value></env:Code>
<env:Reason><env:Text>SoapFault: Too few arguments to function WebService::Solution_HasModule()</env:Text></env:Reason>
</env:Fault></env:Body></env:Envelope>`;
    const fetchImpl = async (url, init) => {
      const body = Buffer.from(init.body).toString("utf8");
      if (/<m:Solution_HasModule[\s>]/.test(body)) {
        const bytes = Buffer.from(fault, "utf8");
        return {
          ok: false, status: 500,
          headers: { get: () => null, getSetCookie: () => [] },
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        };
      }
      return base(url, init);
    };
    const client = createClient({ username: "u", password: "p", fetchImpl });
    const adapter = createDanDomainAdapter(CFG, { client, now: () => new Date("2026-08-16T00:00:00Z") });
    const st = await adapter.settings();
    assert.equal(codes(adapter).includes("BLOG_NOT_EXPORTED"), false,
      "a failed probe is not evidence the module is off");
    assert.ok(codes(adapter).includes("HAS_MODULE_FAILED"),
      `failed HasModule must warn; got ${codes(adapter).join(", ")}`);
    assert.equal(st.modules.blog, null);
    assert.equal(st.modules.news, null);
  });

  test("D4 — _dd_main_category_slug follows _main, not cats[0]", async () => {
    // CategoryId 0/empty makes pushCat bail; the first secondary then becomes
    // cats[0] while _dd_main_category_id stays the empty primary. P3 redirects
    // would compose the wrong storefront path (R41).
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => {
        const a = xml.replace("<CategoryId>1</CategoryId>", "<CategoryId>0</CategoryId>");
        const b = a.replace("<SecondaryCategoryIds/>", "<SecondaryCategoryIds><item>9</item></SecondaryCategoryIds>");
        return b;
      }
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_main_category_id, "0");
    assert.equal(meta._dd_main_category_slug, undefined,
      "a secondary slug must not masquerade as the main category when CategoryId was empty");
    assert.equal(p1.categories[0].slug, "probe-kategori");
    assert.equal(p1.categories[0]._main, false);
  });

  test("D5 — mixed inline/per-variant option links still warn VARIANT_OPTIONS_REFETCHED", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => {
        let n = 0;
        return xml.replace(/<VariantTypeValues>[\s\S]*?<\/VariantTypeValues>/g, (m) => {
          n += 1;
          return n === 1 ? m : "<VariantTypeValues/>";
        });
      }
    });
    pack.responses.Product_GetVariantTypeValues = [
      `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="https://api.hostedshop.io/service.php">
  <env:Body>
    <ns1:Product_GetVariantTypeValuesResponse>
      <ns1:Product_GetVariantTypeValuesResult>
        <item>
          <Id>5</Id>
          <ProductVariantTypeId>2</ProductVariantTypeId>
          <Title>Medium</Title>
        </item>
      </ns1:Product_GetVariantTypeValuesResult>
    </ns1:Product_GetVariantTypeValuesResponse>
  </env:Body>
</env:Envelope>`
    ];
    const { adapter, calls } = harnessFor(pack);
    await drain(adapter.products());
    assert.ok(calls.some((c) => c.op === "Product_GetVariantTypeValues"),
      "later variants with empty inline values must refetch");
    assert.ok(codes(adapter).includes("VARIANT_OPTIONS_REFETCHED"),
      `first-variant inline must not freeze the warning off; got ${codes(adapter).join(", ")}`);
    const w = adapter.warnings().find((x) => x.code === "VARIANT_OPTIONS_REFETCHED");
    assert.match(w.message, /link path mixed/,
      "linkPath must be mixed when per-variant option paths differ — a first-variant freeze reports inline and this dies");
  });

  test("N1 pin — a present variant Weight of 0 is 0, not the product weight (R26)", async () => {
    // Opus named this as a defect. The audit killed it: num("0") is 0 and ??
    // does not fall through; a present 0 is a value. The recorded variant rows
    // in gaps.json carry Weight "0" against product Weight 0.5. Pin the
    // recorded reading so a later "fix" cannot invert it.
    const { adapter } = harness(["shop", "products", "categories"]);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.weight, 0.5);
    assert.equal(p1._variations[0].weight, 0);
    assert.notEqual(p1._variations[0].weight, p1.weight);
  });

  test("F — the fixture pack stores the recorded naive-parser collapse shapes", () => {
    const variants = JSON.parse(readFileSync(path.join(RAW, "collapse-variants.json"), "utf8"));
    const pages = JSON.parse(readFileSync(path.join(RAW, "collapse-pages.json"), "utf8"));
    const scale = JSON.parse(readFileSync(path.join(RAW, "collapse-scale.json"), "utf8"));
    assert.match(variants.provenance, /gaps\.json/);
    assert.ok(Array.isArray(variants.collapse.sample));
    assert.deepEqual(variants.collapse.auditReturned, ["item", "MinAmount", "Title", "Unit", "StockLocations"]);
    assert.equal(variants.collapse.sample[0].item.length, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(variants.collapse.sample[0].item[0], "VariantTypeValues"), false,
      "the recorded collapse truncates before VariantTypeValues");
    assert.match(pages.provenance, /gaps\.json/);
    assert.deepEqual(pages.collapse.auditReturned, ["item", "LanguageAccess"]);
    assert.equal(pages.collapse.byIdsCount, 1);
    assert.deepEqual(pages.collapse.byIdsTitles, []);
    assert.match(scale.provenance, /scale\.json/);
    assert.equal(scale.collapse.catalogueSize, 618);
    assert.ok(scale.collapse.pages.every((p) => p.parsedLength === 1),
      "every recorded page collapsed to parsedLength 1");
  });
});

// =============================================================================================
describe("P3 — shipping taxLines (O13)", () => {
  /**
   * Shopify orderCreate (2026-01 documented example): line priceSet is NET;
   * taxLines.priceSet is additional tax; the SALE transaction is GROSS
   * (74.99 × 3 + 13.50 tax = 238.47). Sending the adapter's previous GROSS
   * shipping total as priceSet AND attaching taxLines would double-count.
   * orders-money.json is FULLY CONSTRUCTED (rule exercise, not a recorded order).
   * Oracle: AmountFull 287.50.
   */
  const p3OrderCtx = () => ({
    cfg: { source: { adapter: "dandomain", kind: "dandomain" }, options: { orders: { tag: "dd-import", markFulfilledWhenComplete: true, importCancelled: false }, locale: "da" } },
    L: { orderNote: (w) => `n ${w.number}`, couponNote: () => null, refundNote: () => null, customerNoteLabel: "n" },
    storeCurrency: "DKK",
    provenance: { productIdTag: "dd-id-", orderTag: "dd-order-", statusTag: "dd-status-", orderNamePrefix: "#DD" },
  });

  test("O13: shipping and fee taxLines are additional VAT on a NET priceSet", async () => {
    const { transformOrder } = await import("../src/transform/orders.js");
    const { adapter } = harness(["shop", "products", "categories", "orders-money"]);
    const rows = await drain(adapter.orders());
    const w = rows.find((x) => x.id === 20);
    assert.equal(w.shipping_lines[0].total, "70.00", "Woo-shaped total is NET; VAT rides in taxes[]");
    assert.equal(w.shipping_lines[0].taxes[0].total, "17.50");
    assert.equal(w.fee_lines[0].total, "20.00");
    assert.equal(w.fee_lines[0].taxes[0].total, "5.00");
    const { order } = transformOrder(w, p3OrderCtx());
    const ship = order.shippingLines[0];
    assert.equal(ship.priceSet.shopMoney.amount, "70.00", "priceSet is NET — gross 87.50 here would double-count with taxLines");
    assert.equal(ship.taxLines[0].priceSet.shopMoney.amount, "17.50");
    assert.equal(ship.taxLines[0].rate, 0.25);
    const fee = order.lineItems.find((li) => li.requiresShipping === false);
    assert.equal(fee.priceSet.shopMoney.amount, "20.00");
    assert.equal(fee.taxLines[0].priceSet.shopMoney.amount, "5.00");
    const productTax = order.lineItems.filter((li) => li.requiresShipping !== false)
      .reduce((n, li) => n + (li.taxLines || []).reduce((t, x) => t + Number(x.priceSet.shopMoney.amount), 0), 0);
    const shipTax = Number(ship.taxLines[0].priceSet.shopMoney.amount);
    const feeTax = Number(fee.taxLines[0].priceSet.shopMoney.amount);
    assert.equal(productTax + shipTax + feeTax, 57.5, "rebuilt tax matches adapter total_tax / AmountFull VAT");
    const net = Number(order.lineItems[0].priceSet.shopMoney.amount) * order.lineItems[0].quantity
      + Number(ship.priceSet.shopMoney.amount) + Number(fee.priceSet.shopMoney.amount);
    // line is qty 2 of unit 80 with 10/unit discount already in total 140 → transform uses subtotal/qty = 80
    // Wait: transform uses subtotal/qty as unit. subtotal 160, qty 2 → unit 80, line net 160 not 140.
    // Discount is order-level. Transaction is still GROSS 287.50.
    assert.equal(order.transactions[0].amountSet.shopMoney.amount, "287.50");
    const exclusiveGross = net + productTax + shipTax + feeTax;
    // 160 + 70 + 20 + 35 + 17.50 + 5 = 307.50 if we used subtotal; the order discount 20 is on discountCode.
    // Rebuilt tax+shipping+fee+lines against the oracle: adapter total is 287.50 GROSS.
    // Shopify exclusive: line subtotals 160 + ship 70 + fee 20 + taxes 57.50 - discount 20 = 287.50.
    assert.equal(Number(exclusiveGross.toFixed(2)) - 20, 287.5);
  });
});

describe("P3 — provenance prefix, empty SeoLink, unknown coupons, redirects", () => {
  const pctx = {
    cfg: { source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://shop000000.mywebshop.io" }, options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true, stripShortcodes: true, rewriteInternalLinks: true } },
    locationId: "L",
    provenance: { productIdTag: "dd-id-", orderTag: "dd-order-", statusTag: "dd-status-", orderNamePrefix: "#DD" },
  };

  test("products get dd-id-* and categories carry a real oldPath (PLAN D7/D9)", async () => {
    const { transformProduct, transformCategory } = await import("../src/transform/products.js");
    const { adapter } = harness(["shop", "products", "categories"]);
    const [p1] = await drain(adapter.products());
    const cats = await drain(adapter.categories());
    const { input, membership } = transformProduct(p1, pctx);
    assert.ok(input.tags.includes("dd-id-1"));
    assert.equal(input.tags.includes("wp-id-1"), false);
    assert.equal(membership.oldPath, "/shop/1-demo-kategori/1-eksempel-paa-produkt-1");
    const cat = transformCategory(cats.find((c) => c.id === 1), pctx);
    assert.equal(cat.oldPath, "/shop/1-demo-kategori");
  });

  test("empty product SeoLink warns and does not invent a storefront slug (D9)", async () => {
    const { transformProduct } = await import("../src/transform/products.js");
    const p = {
      id: 99, name: "No slug product", slug: null, type: "simple", status: "publish",
      description: "", regular_price: "10", permalink: null, attributes: [], categories: [],
      tags: [], images: [], meta_data: [{ key: "_dd_id", value: "99" }, { key: "_dd_main_category_id", value: "1" }, { key: "_dd_main_category_slug", value: "demo-kategori" }],
    };
    const { input, warnings, membership } = transformProduct(p, pctx);
    assert.ok(warnings.some((w) => w.code === "EMPTY_PRODUCT_SEOLINK"));
    assert.equal(membership.oldPath, null, "no invented storefront path");
    assert.equal(input.handle, "no-slug-product", "handle comes from the title, not a fake slug");
    assert.notEqual(input.handle, "item");
  });

  test("two empty-SeoLink products with unslugifiable titles do not silently share handle item", async () => {
    const { transformProduct } = await import("../src/transform/products.js");
    const mk = (id) => ({
      id, name: "日本語", slug: null, type: "simple", status: "publish",
      description: "", regular_price: "10", permalink: null, attributes: [], categories: [],
      tags: [], images: [], meta_data: [{ key: "_dd_id", value: String(id) }],
    });
    const a = transformProduct(mk(1), pctx);
    const b = transformProduct(mk(2), pctx);
    assert.ok(a.input, "first product is not dropped");
    assert.ok(b.input, "second product is not dropped");
    assert.equal(a.membership.oldPath, null, "no invented storefront path");
    assert.equal(b.membership.oldPath, null, "no invented storefront path");
    assert.equal(a.input.handle, "item-1", "Shopify handle suffix is item-{id}");
    assert.equal(b.input.handle, "item-2", "Shopify handle suffix is item-{id}");
    assert.notEqual(a.input.handle, b.input.handle, "Shopify handles are unique; suffix is handle-only");
    assert.ok(a.warnings.some((w) => w.code === "EMPTY_PRODUCT_SEOLINK"));
    assert.ok(b.warnings.some((w) => w.code === "EMPTY_PRODUCT_SEOLINK"));
    const fallbackA = a.warnings.find((w) => w.code === "HANDLE_FALLBACK_ITEM");
    const fallbackB = b.warnings.find((w) => w.code === "HANDLE_FALLBACK_ITEM");
    assert.ok(fallbackA && fallbackA.severity === "action");
    assert.ok(fallbackB && fallbackB.severity === "action");
  });

  test("unknown coupon types are refused, not mapped as money-off", async () => {
    const { transformCoupon } = await import("../src/transform/discounts.js");
    const ctx = { cfg: { options: { skipExpiredCoupons: true } } };
    const unknown = transformCoupon({ id: 9, code: "Z", discount_type: "unknown", amount: "10" }, ctx);
    assert.equal(unknown.discount, null);
    assert.ok(unknown.skipped);
    assert.ok(unknown.warnings.some((w) => w.code === "COUPON_TYPE_UNKNOWN"));
    const pct = transformCoupon({ id: 1, code: "P", discount_type: "percent", amount: "10" }, ctx);
    assert.equal(pct.discount.customerGets.value.percentage, 0.1);
    const cart = transformCoupon({ id: 2, code: "C", discount_type: "fixed_cart", amount: "25" }, ctx);
    assert.equal(cart.discount.customerGets.value.discountAmount.amount, "25.00");
  });

  test("DanDomain redirects use R41 grammar and omit Woo /product-category", async () => {
    const { buildRedirects } = await import("../src/transform/redirects.js");
    const { rows } = buildRedirects({
      products: [{ handle: "eksempel-paa-produkt-1", oldPath: "/shop/1-demo-kategori/1-eksempel-paa-produkt-1" }],
      categories: [{ handle: "demo-kategori", slug: "demo-kategori", oldPath: "/shop/1-demo-kategori" }],
      structural: [],
      wooCategoryBase: false,
    });
    const froms = rows.map((r) => r.from);
    assert.ok(froms.includes("/shop/1-demo-kategori/1-eksempel-paa-produkt-1"));
    assert.ok(froms.includes("/shop/1-demo-kategori"));
    assert.equal(froms.includes("/product-category/demo-kategori"), false);
    assert.equal(froms.includes("/shop"), false, "Woo /shop is not a DanDomain structural path");
    assert.equal(froms.includes("/my-account"), false);
  });

  test("Woo category base remains the wordpress-kind default", async () => {
    const { buildRedirects } = await import("../src/transform/redirects.js");
    const { rows } = buildRedirects({
      products: [],
      categories: [{ handle: "koekken", slug: "koekken", oldPath: null }],
      structural: [["/shop", "/collections/all"], ["/my-account", "/account"]],
    });
    const froms = rows.map((r) => r.from);
    assert.ok(froms.includes("/product-category/koekken"));
    assert.ok(froms.includes("/shop"));
    assert.ok(froms.includes("/my-account"));
  });

  test("SEORedirect rows merge into the map", async () => {
    const { buildRedirects } = await import("../src/transform/redirects.js");
    const { rows } = buildRedirects({
      products: [],
      categories: [],
      structural: [],
      wooCategoryBase: false,
      extra: [{ from: "/old-sale", to: "/collections/all" }],
    });
    assert.ok(rows.some((r) => r.from === "/old-sale" && r.to === "/collections/all"));
  });

  test("orders carry dd-order-* / dd-status-* tags", async () => {
    const { transformOrder } = await import("../src/transform/orders.js");
    const { adapter } = harness(["shop", "products", "categories", "orders"]);
    const rows = await drain(adapter.orders());
    const w = rows.find((x) => x.id === 18);
    const { order } = transformOrder(w, {
      cfg: { source: { adapter: "dandomain", kind: "dandomain" }, options: { orders: { tag: "dd-import", markFulfilledWhenComplete: true, importCancelled: false } } },
      L: { orderNote: () => "n", couponNote: () => null, refundNote: () => null, customerNoteLabel: "n" },
      provenance: { productIdTag: "dd-id-", orderTag: "dd-order-", statusTag: "dd-status-", orderNamePrefix: "#DD" },
    });
    assert.ok(order.tags.some((t) => t.startsWith("dd-order-")));
    assert.ok(order.tags.some((t) => t.startsWith("dd-status-")));
    assert.equal(order.tags.some((t) => t.startsWith("wc-order-")), false);
    assert.ok(order.name.startsWith("#DD"));
  });

  test("SEORedirect_GetAll fault warns SEO_REDIRECTS_UNREAD", async () => {
    const { adapter } = harness(["shop"]);
    await drain(adapter.redirects());
    assert.ok(codes(adapter).includes("SEO_REDIRECTS_UNREAD"));
  });

  test("query / wildcard / 302 SEO redirects warn and do not silently drop or invent money-off", async (t) => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { runTransform } = await import("../src/transform/index.js");
    const { jsonlWriter, writeJson } = await import("../src/util/fsx.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-redir-warn-"));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
    const raw = path.join(dir, "raw"), out = path.join(dir, "transformed");
    const rw = jsonlWriter(path.join(raw, "redirects.jsonl"));
    rw.write({ id: 1, from: "/old?x=1", to: "/new" });
    rw.write({ id: 2, from: "/sale-*", to: "/collections/all" });
    rw.write({ id: 3, from: "/promo", to: "/collections/all", type: "302" });
    rw.write({ id: 4, from: "/ok-path", to: "/products/x" });
    await rw.close();
    writeJson(path.join(raw, "summary.json"), {
      adapter: "dandomain",
      settings: {
        provenance: { productIdTag: "dd-id-", orderTag: "dd-order-", statusTag: "dd-status-", orderNamePrefix: "#DD" },
        redirects: { structural: [], wooCategoryBase: false },
      },
      warnings: [],
    });
    const cfg = {
      ...CFG,
      paths: { raw, transformed: out },
      entities: { products: false, collections: false, customers: false, orders: false, discounts: false, pages: false, articles: false, redirects: true },
      options: { locale: "da" },
      shopify: { blog: { title: "Blog", handle: "blog" } },
    };
    const res = await runTransform(cfg, cfg.entities);
    const seen = new Set(res.warnings.map((w) => w.code));
    assert.ok(seen.has("QUERY_URL_DROPPED"), "query-string Source is dropped, not imported as a path");
    assert.ok(seen.has("REDIRECT_WILDCARD_EXPANDED"), "wildcard Source is not silently skipped");
    assert.ok(seen.has("REDIRECT_302_UPGRADED"), "302 is upgraded to Shopify 301 and declared");
    const rows = JSON.parse(fs.readFileSync(path.join(out, "redirects.json"), "utf8"));
    const froms = rows.map((r) => r.from);
    assert.equal(froms.includes("/old?x=1"), false);
    assert.equal(froms.includes("/sale-*"), false);
    assert.ok(froms.includes("/promo"));
    assert.ok(froms.includes("/ok-path"));
  });

  test("PLAN §5: a wildcard SEO row expands to concrete inventory oldPaths", async (t) => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const { runTransform } = await import("../src/transform/index.js");
    const { jsonlWriter, writeJson } = await import("../src/util/fsx.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-redir-wild-"));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
    const raw = path.join(dir, "raw"), out = path.join(dir, "transformed");
    const pw = jsonlWriter(path.join(raw, "products.jsonl"));
    pw.write({
      id: 1, name: "Eksempel", slug: "eksempel-paa-produkt-1", type: "simple", status: "publish",
      description: "", regular_price: "10", sku: "SKU-1",
      permalink: "https://shop000000.mywebshop.io/shop/1-demo-kategori/1-eksempel-paa-produkt-1/",
      attributes: [], categories: [{ id: 1, name: "Demo", slug: "demo-kategori" }],
      tags: [], images: [], meta_data: [{ key: "_dd_id", value: "1" }],
    });
    await pw.close();
    const cw = jsonlWriter(path.join(raw, "categories.jsonl"));
    cw.write({ id: 1, name: "Demo kategori", slug: "demo-kategori", parent: 0, description: "", permalink: "https://shop000000.mywebshop.io/shop/1-demo-kategori/" });
    await cw.close();
    const pg = jsonlWriter(path.join(raw, "pages.jsonl"));
    pg.write({ id: 8, title: { rendered: "Om os" }, slug: "om-os", content: { rendered: "" }, link: "https://shop000000.mywebshop.io/shop/page/om-os/" });
    await pg.close();
    const rw = jsonlWriter(path.join(raw, "redirects.jsonl"));
    rw.write({ id: 2, from: "/shop/1-demo-*", to: "/collections/all" });
    rw.write({ id: 8, from: "/shop/page/*", to: "/pages/om-os" });
    rw.write({ id: 9, from: "/ghost-*", to: "/collections/all" });
    await rw.close();
    writeJson(path.join(raw, "summary.json"), {
      adapter: "dandomain",
      settings: {
        provenance: { productIdTag: "dd-id-", orderTag: "dd-order-", statusTag: "dd-status-", orderNamePrefix: "#DD" },
        redirects: { structural: [], wooCategoryBase: false },
      },
      warnings: [],
    });
    const cfg = {
      ...CFG,
      paths: { raw, transformed: out },
      // redirects-only: generated product/category rows must not hide expansion
      entities: { products: false, collections: false, customers: false, orders: false, discounts: false, pages: false, articles: false, redirects: true },
      options: { locale: "da" },
      shopify: { blog: { title: "Blog", handle: "blog" } },
    };
    const res = await runTransform(cfg, cfg.entities);
    const wild = res.warnings.filter((w) => w.code === "REDIRECT_WILDCARD_EXPANDED");
    const byId = (id) => wild.find((w) => w.id === id || String(w.id) === String(id));
    const match = byId(2);
    const pageWild = byId(8);
    const ghost = byId(9);
    assert.equal(match?.severity, "handled", "N inventory hits → handled, not action");
    assert.match(String(match?.message), /expanded to 2 concrete path/);
    assert.equal(pageWild?.severity, "handled", "page oldPath is in the URL inventory");
    assert.match(String(pageWild?.message), /expanded to 1 concrete path/);
    assert.equal(ghost?.severity, "action", "zero hits → action, not handled");
    assert.match(String(ghost?.message), /matched no exported product\/category\/page old path/);
    const rows = JSON.parse(fs.readFileSync(path.join(out, "redirects.json"), "utf8"));
    const froms = rows.map((r) => r.from);
    assert.equal(froms.includes("/shop/1-demo-*"), false, "the wildcard itself is not imported");
    assert.equal(froms.includes("/shop/page/*"), false, "the page wildcard itself is not imported");
    const cat = rows.find((r) => r.from === "/shop/1-demo-kategori");
    const prod = rows.find((r) => r.from === "/shop/1-demo-kategori/1-eksempel-paa-produkt-1");
    const page = rows.find((r) => r.from === "/shop/page/om-os");
    assert.ok(cat, "category oldPath is in inventory");
    assert.ok(prod, "product oldPath is in inventory");
    assert.ok(page, "page oldPath is in inventory");
    assert.equal(prod.to, "/collections/all", "expanded product path uses the SEO target (not generated; products entity is off)");
    assert.equal(page.to, "/pages/om-os", "expanded page path uses the SEO target");
    assert.equal(froms.includes("/ghost-*"), false);
  });
});

describe("P3 review — verify notes, shipping VAT miss, doctor containment", () => {
  test("verify notes are source-aware for dd-id- and stay Woo prose for wp-id-", async () => {
    const { verifyNotes } = await import("../src/stages/verify.js");
    const wp = verifyNotes("wp-id-");
    assert.match(wp.products, /Woo products/);
    assert.match(wp.stale, /deleted in WP/);
    const dd = verifyNotes("dd-id-");
    assert.equal(/Woo products/.test(dd.products), false, "DanDomain verify copy is not Woo prose");
    assert.equal(/deleted in WP/.test(dd.stale), false);
    assert.match(dd.products, /source/);
  });

  test("spot-check falls back to dd-id- when SKU is absent; WP stays SKU-only", async () => {
    const { collectSpotChecks } = await import("../src/stages/verify.js");
    const products = [
      { input: { title: "No SKU", tags: ["dd-id-9"], variants: [{ sku: undefined, price: "12.00" }] } },
      { input: { title: "Has SKU", tags: ["dd-id-8"], variants: [{ sku: "ABC-1", price: "9.00" }] } },
    ];
    const dd = collectSpotChecks(products, { productIdTag: "dd-id-" });
    assert.ok(dd.skuPrices.some((p) => p.sku === "ABC-1"));
    assert.ok(dd.tagPrices.some((p) => p.tag === "dd-id-9" && p.price === "12.00"));
    assert.equal(dd.tagPrices.some((p) => p.tag === "dd-id-8"), false, "SKU present → no tag fallback for that product");
    const wp = collectSpotChecks(products, { productIdTag: "wp-id-" });
    assert.equal(wp.tagPrices.length, 0, "wordpress-kind does not use dd-id- fallback");
    assert.ok(wp.skuPrices.some((p) => p.sku === "ABC-1"));
  });

  test("FULLY CONSTRUCTED: shipping taxLines.rate is derived when VAT group is missing from order tax_lines", async () => {
    const { transformOrder } = await import("../src/transform/orders.js");
    const w = {
      id: 99, number: "99", status: "completed", currency: "DKK", total: "87.50",
      date_paid_gmt: "2026-01-01T00:00:00",
      line_items: [{ name: "X", quantity: 1, subtotal: "0.00", total: "0.00", taxes: [] }],
      shipping_lines: [{ method_title: "GLS", total: "70.00", taxes: [{ id: 99, total: "17.50" }] }],
      tax_lines: [{ rate_id: 1, label: "Moms", rate_percent: 25 }],
      fee_lines: [], coupon_lines: [], refunds: [],
    };
    const { order } = transformOrder(w, {
      cfg: { source: { adapter: "dandomain", kind: "dandomain" }, options: { orders: { tag: "dd-import", markFulfilledWhenComplete: true, importCancelled: false } } },
      L: { orderNote: () => "n", couponNote: () => null, refundNote: () => null, customerNoteLabel: "n" },
      provenance: { productIdTag: "dd-id-", orderTag: "dd-order-", statusTag: "dd-status-", orderNamePrefix: "#DD" },
    });
    const tl = order.shippingLines[0].taxLines[0];
    assert.equal(tl.priceSet.shopMoney.amount, "17.50");
    assert.equal(tl.rate, 0.25, "must not silent-0 the rate when group 99 is absent from tax_lines");
  });

  test("doctor containment: mock fetch — 200 without needle fails, 200 with needle passes, 404 fails, short digit needle refused", async () => {
    const { probeStorefrontContainment } = await import("../src/stages/doctor.js");
    const url = "https://shop000000.mywebshop.io/shop/9-probe/625-probe-item/";
    const sku = "PROBE-VS-25";
    await assert.rejects(
      () => probeStorefrontContainment({ url, sku, fetchImpl: async () => new Response("<html>admin shell</html>", { status: 200 }) }),
      /does not contain item number/,
    );
    const ok = await probeStorefrontContainment({
      url, sku,
      fetchImpl: async () => new Response(`<html><span class="sku">${sku}</span></html>`, { status: 200 }),
    });
    assert.match(ok, /containment ok/);
    await assert.rejects(
      () => probeStorefrontContainment({ url, sku, fetchImpl: async () => new Response("nope", { status: 404 }) }),
      /HTTP 404/,
    );
    await assert.rejects(
      () => probeStorefrontContainment({
        url, sku: "1117",
        fetchImpl: async () => new Response("<html>/shop/9-x/625-probe-1786884111771/</html>", { status: 200 }),
      }),
      /does not contain item number/,
    );
  });
});

const VARIANT_VALUES_ENVELOPE = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="https://api.hostedshop.io/service.php">
  <env:Body>
    <ns1:Product_GetVariantTypeValuesResponse>
      <ns1:Product_GetVariantTypeValuesResult>
        <item>
          <Id>5</Id>
          <ProductVariantTypeId>2</ProductVariantTypeId>
          <Title>Medium</Title>
        </item>
      </ns1:Product_GetVariantTypeValuesResult>
    </ns1:Product_GetVariantTypeValuesResponse>
  </env:Body>
</env:Envelope>`;

function trackInFlight(client, ops) {
  const want = new Set(ops);
  let inFlight = 0, max = 0, n = 0;
  const orig = client.call.bind(client);
  client.call = async (op, args, options) => {
    if (!want.has(op)) return orig(op, args, options);
    inFlight += 1;
    n += 1;
    max = Math.max(max, inFlight);
    try { return await orig(op, args, options); }
    finally { inFlight -= 1; }
  };
  return { max: () => max, count: () => n };
}

describe("O17 — page User_GetAll with User_GetAllByDate windows", () => {
  test("customers from two date windows are unioned and deduped by Id", async () => {
    const pack = loadPack("shop", "customers");
    const base = pack.responses.User_GetAll[0].replaceAll("User_GetAll", "User_GetAllByDate");
    const user2 = base.replace("<Id>1</Id>", "<Id>2</Id>")
      .replaceAll("probe-ship@example.invalid", "second@example.invalid")
      .replace("<Company>Probe ApS</Company>", "<Company>Second ApS</Company>");
    const empty = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="https://api.hostedshop.io/service.php">
  <env:Body>
    <ns1:User_GetAllByDateResponse>
      <ns1:User_GetAllByDateResult/>
    </ns1:User_GetAllByDateResponse>
  </env:Body>
</env:Envelope>`;
    pack.responses.User_GetAllByDate = [base, user2, empty];
    const { adapter, calls } = harnessFor(pack);
    const rows = await drain(adapter.customers());
    assert.equal(calls.filter((c) => c.op === "User_GetAll").length, 0);
    assert.ok(calls.filter((c) => c.op === "User_GetAllByDate").length >= 2);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "duplicate Id across overlapping windows must collapse");
    assert.ok(rows.some((r) => r.id === 1));
    assert.ok(rows.some((r) => r.id === 2), "later windows must contribute users, not only the first");
  });
});

describe("O16 — bound N+1 variant and order-line refetches", () => {
  test("empty inline option links refetch in a concurrent batch and still warn VARIANT_OPTIONS_REFETCHED", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace(/<VariantTypeValues>[\s\S]*?<\/VariantTypeValues>/g, "<VariantTypeValues/>")
    });
    pack.responses.Product_GetVariantTypeValues = [VARIANT_VALUES_ENVELOPE];
    const { adapter, calls, client } = harnessFor(pack);
    const flight = trackInFlight(client, ["Product_GetVariantTypeValues"]);
    await drain(adapter.products());
    assert.ok(flight.count() >= 2, `need at least two variant refetches to prove a batch, got ${flight.count()}`);
    assert.ok(flight.max() >= 2,
      `refetches must overlap (bounded batch), not serial N+1; max in-flight ${flight.max()}`);
    assert.ok(flight.max() <= 8, `concurrency must be bounded; max in-flight ${flight.max()}`);
    assert.ok(codes(adapter).includes("VARIANT_OPTIONS_REFETCHED"),
      `batching must not drop the warning; got ${codes(adapter).join(", ")}`);
    assert.ok(calls.some((c) => c.op === "Product_GetVariantTypeValues"));
  });

  test("order-line refetches run in a concurrent batch and still warn ORDER_LINES_REFETCHED", async () => {
    const pack = loadPack("shop", "products", "categories", "orders-default-projection");
    const page = pack.responses.Order_GetAllWithPagination[0];
    const start = page.indexOf("        <item>");
    const end = page.lastIndexOf("        </item>") + "        </item>".length;
    assert.ok(start !== -1 && end > start, "order page must contain a top-level item");
    const item = page.slice(start, end);
    const item2 = item.replace("<Id>18</Id>", "<Id>28</Id>");
    const item3 = item.replace("<Id>18</Id>", "<Id>38</Id>");
    pack.responses.Order_GetAllWithPagination[0] = page.slice(0, start) + item + item2 + item3 + page.slice(end);
    const { adapter, calls, client } = harnessFor(pack);
    const flight = trackInFlight(client, ["Order_GetLines"]);
    const rows = await drain(adapter.orders());
    assert.ok(codes(adapter).includes("ORDER_LINES_REFETCHED"),
      `batching must not drop the warning; got ${codes(adapter).join(", ")}`);
    assert.ok(flight.count() >= 2, `need at least two Order_GetLines to prove a batch, got ${flight.count()}`);
    assert.ok(flight.max() >= 2,
      `Order_GetLines must overlap (bounded batch), not serial N+1; max in-flight ${flight.max()}`);
    assert.ok(flight.max() <= 8, `concurrency must be bounded; max in-flight ${flight.max()}`);
    assert.ok(calls.filter((c) => c.op === "Order_GetLines").length >= 2);
    assert.ok(rows.every((o) => o.line_items[0]?.subtotal === "80.00"), "money must survive the batched fallback");
  });
});

// =============================================================================================
describe("O14 — yield per page via readPages", () => {
  function spyWalks(client, { splitProductPages = false } = {}) {
    const spy = { readAll: [], readPages: [], page2Requested: false, options: [] };
    const origAll = client.readAll.bind(client);
    const origPages = client.readPages.bind(client);
    client.readAll = (op, options) => { spy.readAll.push(op); return origAll(op, options); };
    client.readPages = async function* (op, options) {
      spy.readPages.push(op);
      spy.options.push(options);
      const it = origPages(op, options);
      if (!splitProductPages || op !== "Product_GetAllWithLimit") {
        let n = 0;
        for (;;) {
          n += 1;
          if (n >= 2) spy.page2Requested = true;
          const step = await it.next();
          if (step.done) return step.value;
          yield step.value;
        }
      }
      const first = await it.next();
      if (first.done) return first.value;
      const recs = first.value.records || [];
      if (recs.length < 2) {
        yield first.value;
        for (;;) {
          const step = await it.next();
          if (step.done) return step.value;
          spy.page2Requested = true;
          yield step.value;
        }
      }
      yield { ...first.value, records: recs.slice(0, 1) };
      spy.page2Requested = true;
      yield { ...first.value, records: recs.slice(1), page: (first.value.page || 1) + 1 };
      for (;;) {
        const step = await it.next();
        if (step.done) return step.value;
        yield step.value;
      }
    };
    return spy;
  }

  test("the first product is yielded before the second page is requested", async () => {
    const { adapter, client } = harness(["shop", "products", "categories"]);
    const spy = spyWalks(client, { splitProductPages: true });
    const gen = adapter.products();
    const first = await gen.next();
    assert.equal(first.done, false, "must yield a product from page 1");
    assert.equal(spy.page2Requested, false,
      "page 2 must not be requested before the first product is yielded — readAll would consume both pages first");
    assert.ok(first.value?.id, "first yield is a product record");
    await drain(gen);
    assert.ok(spy.readPages.includes("Product_GetAllWithLimit"));
    assert.equal(spy.readAll.filter((op) => op === "Product_GetAllWithLimit").length, 0,
      "products() must drive readPages, not readAll");
  });

  test("orders() drives readPages, not readAll", async () => {
    const { adapter, client } = harness(["shop", "products", "categories", "orders"]);
    const spy = spyWalks(client);
    await drain(adapter.orders());
    assert.ok(spy.readPages.some((op) => String(op).startsWith("Order_")),
      `expected an Order_* readPages call, got ${JSON.stringify(spy.readPages)}`);
    assert.equal(spy.readAll.filter((op) => String(op).startsWith("Order_")).length, 0,
      `orders() must not call readAll; got ${JSON.stringify(spy.readAll)}`);
    assert.equal(spy.readAll.filter((op) => op === "Product_GetAllWithLimit").length, 0,
      "productVatMap must also walk with readPages");
  });

  test("O15 — products(resume) passes restart.start into readPages", async () => {
    const { adapter, client } = harness(["shop", "products", "categories"]);
    const spy = spyWalks(client);
    await drain(adapter.products({ restart: { start: 2 } }));
    const opts = spy.options.find((_, i) => spy.readPages[i] === "Product_GetAllWithLimit");
    assert.equal(opts?.start, 2, `readPages must receive start from resume.restart, got ${JSON.stringify(opts)}`);
  });

  test("O15 — orders(resume) passes startPage+pageBase into readPages", async () => {
    const { adapter, client } = harness(["shop", "products", "categories", "orders"]);
    const spy = spyWalks(client);
    await drain(adapter.orders({ restart: { startPage: 3, pageBase: 1 } }));
    const opts = spy.options.find((_, i) => String(spy.readPages[i]).startsWith("Order_"));
    assert.equal(opts?.startPage, 3, `expected startPage 3, got ${JSON.stringify(opts)}`);
    assert.equal(opts?.pageBase, 1, `expected pageBase 1, got ${JSON.stringify(opts)}`);
  });
});

describe("source-aware import notes (WordPress vs DanDomain)", () => {
  test("DanDomain pairs say DanDomain; WP/fixture localeOf stays bit-identical", async () => {
    const { localeOf, LOCALES } = await import("../src/locales.js");
    const { transformOrder } = await import("../src/transform/orders.js");
    const { transformCustomer } = await import("../src/transform/customers.js");

    const w = { id: 9, number: "9", status: "completed", billing: {}, shipping: {}, line_items: [] };
    assert.equal(
      LOCALES.da.orderNote(w),
      `Importeret fra WordPress. Oprindelig ordre 9 (id 9), status "completed".`,
    );
    assert.equal(LOCALES.da.customerNote(3), "Importeret fra WordPress (bruger 3)");
    assert.equal(localeOf({ options: {} }).orderNote, LOCALES.da.orderNote);
    assert.equal(localeOf({ source: { adapter: "fixture" } }).orderNote, LOCALES.da.orderNote);

    const Ldd = localeOf({ source: { adapter: "dandomain", kind: "dandomain" }, options: { locale: "da" } });
    assert.equal(
      Ldd.orderNote(w),
      `Importeret fra DanDomain. Oprindelig ordre 9 (id 9), status "completed".`,
    );
    assert.equal(Ldd.customerNote(3), "Importeret fra DanDomain (bruger 3)");
    const Lkind = localeOf({ source: { kind: "dandomain" }, options: { locale: "da" } });
    assert.equal(Lkind.customerNote(7), "Importeret fra DanDomain (bruger 7)");

    const ddOrder = transformOrder(w, { L: Ldd, cfg: { options: { orders: {} } }, storeCurrency: "DKK" });
    assert.match(ddOrder.order.note, /Importeret fra DanDomain/);
    assert.equal(ddOrder.order.note.includes("WordPress"), false);
    const ddCust = transformCustomer({ id: 3, email: "a@example.invalid" }, { L: Ldd });
    assert.equal(ddCust.line.input.note, "Importeret fra DanDomain (bruger 3)");
  });
});

// =============================================================================================
describe("P6 — capability close", () => {
  test("P6 — variant PictureIds maps to _variations[].image.src (CONSTRUCTED)", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace(
        /<Id>5<\/Id>[\s\S]*?<PictureId>0<\/PictureId>\s*<PictureIds\/>/,
        (m) => m.replace("<PictureIds/>", "<PictureIds><item>1</item></PictureIds>"),
      ),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const v5 = p1._variations.find((v) => v.id === 5);
    assert.ok(v5, "variant 5 exists");
    assert.equal(v5.image?.src, "https://shop000000.sfstatic.io/upload_dir/pics/product-1.png",
      "PictureIds on variant 5 must resolve; do not credit variant 4's PictureId");
  });

  test("P6 — posts() exists; blog module on keeps BLOG_NOT_EXPORTED until GraphQL succeeds", async () => {
    const { adapter } = harness(["shop"]);
    await adapter.settings();
    assert.equal(typeof adapter.posts, "function");
    assert.ok(codes(adapter).includes("BLOG_NOT_EXPORTED"));
  });

  test("P6 — flag-off translationLayers yields nothing; MULTI_LANGUAGE_PARTIAL stays", async () => {
    const { adapter } = harness(["shop", "products", "categories"]);
    await drain(adapter.products());
    const rows = await drain(adapter.translationLayers());
    assert.equal(rows.length, 0);
    assert.ok(codes(adapter).includes("MULTI_LANGUAGE_PARTIAL"));
  });

  test("P6 — multiLanguage exports secondary-layer rows (LanguageISO UK)", async () => {
    const pack = withOps(loadPack("shop", "products", "categories"), {
      Solution_SetLanguage: "true",
    });
    const { adapter } = harnessFor(pack, { multiLanguage: true });
    const rows = await drain(adapter.translationLayers());
    assert.ok(rows.length >= 1, "expected secondary-layer product rows");
    assert.equal(rows[0].languageISO, "UK");
    assert.ok(rows[0].fields.title);
    await drain(adapter.products());
    assert.equal(codes(adapter).includes("MULTI_LANGUAGE_PARTIAL"), false,
      "flag-on must not also emit MULTI_LANGUAGE_PARTIAL");
  });

  test("P6 — RelatedProductIds land on _dd_related_product_ids (CONSTRUCTED)", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace("<RelatedProductIds/>", "<RelatedProductIds><item>2</item></RelatedProductIds>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_related_product_ids, JSON.stringify(["2"]));
    assert.ok(codes(adapter).includes("RELATED_PRODUCTS_NOT_MIGRATED"));
  });

  test("P6 — ExtraBuy relations land on _dd_extrabuy_relations (CONSTRUCTED SOAP)", async () => {
    const pack = withOps(loadPack("shop", "products", "categories"), {
      Product_GetAllExtraBuyCategory: "<item><Id>1</Id><Title>Køb også</Title></item>",
      Product_GetExtraBuyRelations: "<item><Id>1</Id><ProductId>1</ProductId><RelationProductId>2</RelationProductId><ExtraBuyCategoryId>1</ExtraBuyCategoryId></item>",
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    const rels = JSON.parse(meta._dd_extrabuy_relations);
    assert.equal(rels[0].relationProductId, "2");
    assert.ok(codes(adapter).includes("RELATED_PRODUCTS_NOT_MIGRATED"));
  });

  test("P6 — TILVALG lands on _dd_tilvalg when AdditionalTypes exist (CONSTRUCTED SOAP)", async () => {
    const pack = withOps(loadPack("shop", "products", "categories"), {
      Product_GetAdditionalTypesAll: "<item><Id>9</Id><Title>Gavepapir</Title></item>",
      Product_GetAdditionalTypes: "<item><Id>9</Id><Title>Gavepapir</Title></item>",
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.deepEqual(JSON.parse(meta._dd_tilvalg), [{ id: "9", title: "Gavepapir" }]);
    assert.ok(codes(adapter).includes("TILVALG_NOT_MIGRATED"));
  });

  test("P6 — TypeLabel pakke exports as grouped (WP GROUPED_CONVERTED path)", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml
        .replace("<Type></Type>", "<Type>1</Type>")
        .replace("<TypeLabel></TypeLabel>", "<TypeLabel>Pakkeprodukt</TypeLabel>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.type, "grouped");
  });

  test("P6 — TypeLabel filsalg sets downloadable so transform DIGITAL_FILES can fire", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml
        .replace("<TypeLabel></TypeLabel>", "<TypeLabel>filsalg</TypeLabel>")
        .replace("<TypeLabel/>", "<TypeLabel>filsalg</TypeLabel>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.downloadable, true);
    assert.ok(p1.downloads?.length >= 1);
  });

  test("P6 — unknown Type emits PRODUCT_TYPE_UNMAPPED (CONSTRUCTED)", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace("<Type></Type>", "<Type>99</Type>"),
    });
    const { adapter } = harnessFor(pack);
    await drain(adapter.products());
    assert.ok(codes(adapter).includes("PRODUCT_TYPE_UNMAPPED"));
  });

  test("P6 — SeoKeywords land on metafield payload (CONSTRUCTED)", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace("<SeoKeywords></SeoKeywords>", "<SeoKeywords>uld,plaid</SeoKeywords>")
        .replace("<SeoKeywords/>", "<SeoKeywords>uld,plaid</SeoKeywords>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._dd_seo_keywords, "uld,plaid");
    assert.ok(codes(adapter).includes("SEO_KEYWORDS_NOT_MIGRATED"));
  });

  test("transform — DanDomain customer EAN/CVR become _metafields for metafieldsSet", async () => {
    const { transformCustomer } = await import("../src/transform/customers.js");
    const { productMetafieldsFromMeta } = await import("../src/transform/dd-metafields.js");
    const { transformProduct } = await import("../src/transform/products.js");
    const { localeOf } = await import("../src/locales.js");
    const L = localeOf({ source: { adapter: "dandomain" }, options: { locale: "da" } });
    const { line, warnings } = transformCustomer({
      id: 170,
      email: "ean@example.invalid",
      first_name: "Ean",
      last_name: "Kunde",
      meta_data: [
        { key: "_dd_id", value: "170" },
        { key: "_dd_ean", value: "5790000000001" },
        { key: "_dd_cvr", value: "41290573" },
      ],
    }, { L });
    assert.ok(line._metafields.some((m) => m.namespace === "dandomain" && m.key === "ean" && m.value === "5790000000001"));
    assert.ok(line._metafields.some((m) => m.key === "cvr" && m.value === "41290573"));
    assert.ok(!("metafields" in line.input), "CustomerSetInput has no metafields");
    assert.ok(warnings.some((w) => w.code === "EAN_INVOICING" && w.severity === "handled"));

    const mf = productMetafieldsFromMeta([
      { key: "_dd_seo_keywords", value: "uld, plaid" },
      { key: "_dd_related_product_ids", value: JSON.stringify(["2", "3"]) },
      { key: "_dd_extrabuy_relations", value: JSON.stringify([{ relationProductId: "2" }]) },
      { key: "_dd_tilvalg", value: JSON.stringify([{ id: "9", title: "Gavepapir" }]) },
    ]);
    assert.deepEqual(mf.map((m) => m.key).sort(), ["extrabuy_relations", "related_product_ids", "seo_keywords", "tilvalg"]);

    const { input } = transformProduct({
      id: 1,
      name: "Test",
      slug: "test",
      type: "simple",
      status: "publish",
      description: "",
      regular_price: "10",
      meta_data: [
        { key: "_dd_id", value: "1" },
        { key: "_dd_seo_keywords", value: "uld" },
        { key: "_dd_related_product_ids", value: '["2"]' },
      ],
      categories: [],
      images: [],
      attributes: [],
      tags: [],
    }, {
      cfg: {
        source: { baseUrl: "https://example.invalid" },
        options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true },
      },
      L,
      provenance: { productIdTag: "dd-id-" },
    });
    assert.ok(input.metafields.some((m) => m.key === "seo_keywords" && m.value === "uld"));
    assert.ok(input.metafields.some((m) => m.key === "related_product_ids"));
  });

  test("P6 — FocusFrontpage true emits dd-focus-frontpage and does not emit FOCUS_FLAGS_NOT_MIGRATED", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace("<Online>true</Online>", "<Online>true</Online><FocusFrontpage>true</FocusFrontpage>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.tags.some((t) => t.name === "dd-focus-frontpage"), true);
    assert.equal(p1.tags.some((t) => t.name === "dd-focus-cart"), false);
    assert.equal(codes(adapter).includes("FOCUS_FLAGS_NOT_MIGRATED"), false);
    const blob = JSON.stringify(p1);
    assert.equal(blob.includes("reviewer@example.invalid"), false);
  });

  test("P6 — FocusCart true emits dd-focus-cart only (no FOCUS_FLAGS_NOT_MIGRATED)", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace("<Online>true</Online>", "<Online>true</Online><FocusCart>true</FocusCart>"),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    assert.equal(p1.tags.some((t) => t.name === "dd-focus-cart"), true);
    assert.equal(p1.tags.some((t) => t.name === "dd-focus-frontpage"), false);
    assert.equal(codes(adapter).includes("FOCUS_FLAGS_NOT_MIGRATED"), false);
  });

  test("P6 — DeliveryTime TitleInStock resolves into _delivery_time_title (CONSTRUCTED SOAP)", async () => {
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace("<DeliveryTimeId>-1</DeliveryTimeId>", "<DeliveryTimeId>3</DeliveryTimeId>"),
    });
    withOps(pack, {
      Product_GetDeliveryTimeAll: "<item><Id>3</Id><LanguageISO>DK</LanguageISO><TitleInStock>1-3 hverdage</TitleInStock><TitleNoStock>Udsolgt</TitleNoStock></item>",
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    const meta = Object.fromEntries(p1.meta_data.map((m) => [m.key, m.value]));
    assert.equal(meta._delivery_time, "3");
    assert.equal(meta._delivery_time_title, "1-3 hverdage");
  });

  test("completeness — kreditnota parent carries refunds[].total from Origin note (honest money)", async () => {
    const { adapter } = harness(["shop", "orders", "products", "categories"]);
    const orders = await drain(adapter.orders());
    const withRefund = orders.find((o) => Array.isArray(o.refunds) && o.refunds.length);
    assert.ok(withRefund, "fixture orders include a folded kreditnota");
    assert.ok(withRefund.refunds.every((r) => r.total != null && Number(r.total) !== 0));
  });

  test("completeness — group UserId 4 is _dd_group_discounts and not the public price (R42)", async () => {
    // Adapter reads nested Product.Discounts (PRODUCT_FIELDS), not Product_GetDiscounts.
    const pack = patchPack(["shop", "products", "categories"], {
      Product_GetAllWithLimit: (xml) => xml.replace("<Discounts>", `<Discounts><item>
      <Id>90</Id><ProductId>1</ProductId><ProductVariantId>0</ProductVariantId>
      <Amount>1</Amount><Price>150</Price><Discount>0</Discount>
      <DiscountType>a</DiscountType><UserType>group</UserType><UserId>4</UserId>
    </item>`),
    });
    const { adapter } = harnessFor(pack);
    const [p1] = await drain(adapter.products());
    assert.notEqual(String(p1.regular_price), "150");
    const meta = Object.fromEntries((p1.meta_data || []).map((m) => [m.key, m.value]));
    const rows = JSON.parse(meta._dd_group_discounts || "[]");
    assert.equal(rows.some((r) => r.userId === "4" && Number(r.price) === 150), true);
    assert.equal(codes(adapter).includes("PRICE_LINES_DROPPED"), true);
  });

  test("completeness — posts() selects and maps recorded BlogPostTranslationData fields", async () => {
    const pin = JSON.parse(readFileSync(path.join(HERE, "..", "data", "probes", "completeness-blog.json"), "utf8"));
    const recorded = pin.BlogDecision.translationDataScalars;
    assert.ok(Array.isArray(recorded) && recorded.length > 0, "completeness-blog.json must record nested scalars");
    assert.equal(recorded.includes("title"), true);
    assert.equal(recorded.includes("text"), true);
    assert.equal(recorded.includes("body"), false);
    assert.equal(recorded.includes("handle"), false);
    assert.equal(recorded.includes("excerpt"), false);
    let captured;
    const gql = {
      async query(name, opts) {
        assert.equal(name, "blogPosts");
        assert.equal(opts?.endpoint, "experimental");
        captured = opts;
        return {
          rows: [{
            id: "9",
            addedBy: null,
            createdAt: "2026-08-01 10:00:00",
            pageId: null,
            categoryIds: [],
            translations: [
              {
                title: "GUESSED-ROOT",
                body: "<p>guessed body</p>",
                handle: "guessed-handle",
                excerpt: "guessed excerpt",
                data: { title: "English decoy", text: "<p>en</p>", textList: "en-list" },
                language: { iso: "UK", name: "English", primary: false },
              },
              {
                title: "GUESSED-DK",
                body: "<p>guessed dk</p>",
                handle: "guessed-dk",
                excerpt: "guessed dk excerpt",
                data: {
                  title: "Hygge i stuen",
                  text: "<p>Et indlæg.</p>",
                  textList: "Teaser",
                  seoTitle: null,
                  seoKeywords: null,
                  seoDescription: null,
                },
                language: { iso: "DK", name: "Dansk", primary: true },
              },
            ],
          }],
        };
      },
    };
    const { adapter } = harness(["shop"], {}, { graphqlStub: gql });
    assert.equal(typeof adapter.posts, "function");
    await adapter.settings();
    const posts = await drain(adapter.posts());
    assert.ok(captured?.selection, "posts() must pass a GraphQL selection");
    assert.match(captured.selection, /translations\s*\{[\s\S]*\bdata\s*\{/,
      "selection must ask for translations.data, not only __typename");
    assert.doesNotMatch(captured.selection, /translations\s*\{\s*__typename\s*\}/,
      "translations { __typename } 500s live; do not send it");
    for (const field of recorded) {
      assert.match(captured.selection, new RegExp(`\\b${field}\\b`),
        `selection must include recorded BlogPostTranslationData field ${field}`);
    }
    assert.equal(posts.length, 1);
    assert.equal(posts[0].status, "publish");
    assert.equal(posts[0].title?.rendered, "Hygge i stuen");
    assert.equal(posts[0].content?.rendered, "<p>Et indlæg.</p>");
    assert.equal(posts[0].excerpt?.rendered, "Teaser");
    assert.equal(posts[0].slug, null);
    assert.equal(codes(adapter).includes("BLOG_NOT_EXPORTED"), false);
    const { transformPost } = await import("../src/transform/content.js");
    const t = transformPost(posts[0], {
      cfg: { source: { baseUrl: "https://shop000000.mywebshop.io" }, options: {} },
    });
    assert.ok(t.article.title.includes("Hygge"));
    assert.equal(t.article.handle, "hygge-i-stuen");
    assert.equal(t.article.body, "<p>Et indlæg.</p>");
    assert.equal(t.article.summary, "Teaser");
    const fx = JSON.parse(readFileSync(path.join(RAW, "blog-posts.json"), "utf8"));
    assert.equal(fx.rows[0].title, undefined);
    assert.equal(fx.rows[0].translations[0].title, undefined);
    assert.equal(fx.rows[0].translations[0].data.title, "Hygge i stuen");
    assert.equal(fx.rows[0].translations[0].data.text, "<p>Et indlæg.</p>");
  });

  test("transformPost publishDate is ISO-8601 (offset OR Z, not both)", async () => {
    // Live failed-content.jsonl: invalid DateTime '2026-08-15T02:36:10+02:00Z'.
    // ddDate keeps +02:00; appending a second Z is the importer bug, not Shopify.
    const { transformPost } = await import("../src/transform/content.js");
    const cfg = { source: { baseUrl: "https://shop000000.mywebshop.io" }, options: {} };
    const offset = transformPost({
      id: 1,
      status: "publish",
      date_gmt: "2026-08-15T02:36:10+02:00",
      title: { rendered: "Post 1" },
      content: { rendered: "<p>Velkommen</p>" },
      slug: "post-1",
    }, { cfg });
    assert.equal(offset.article.title, "Post 1");
    assert.equal(offset.article.body, "<p>Velkommen</p>");
    assert.notEqual(offset.article.publishDate, "2026-08-15T02:36:10+02:00Z");
    assert.equal(/[+-]\d{2}:\d{2}Z$/i.test(offset.article.publishDate), false,
      `publishDate must not carry offset AND Z (got ${offset.article.publishDate})`);
    assert.ok(/Z$|[+-]\d{2}:\d{2}$/.test(offset.article.publishDate),
      `publishDate must be ISO-8601 DateTime (got ${offset.article.publishDate})`);

    const naive = transformPost({
      id: 2,
      status: "publish",
      date_gmt: "2026-08-15T00:36:10",
      title: { rendered: "WP Post" },
      content: { rendered: "<p>WP</p>" },
      slug: "wp-post",
    }, { cfg });
    assert.equal(naive.article.publishDate, "2026-08-15T00:36:10Z");
    assert.equal(naive.article.body, "<p>WP</p>");
  });

  test("completeness — posts() does not map unselected guessed translation keys", async () => {
    const gql = {
      async query() {
        return {
          rows: [{
            id: "9",
            createdAt: "2026-08-01 10:00:00",
            translations: [{
              title: "Hygge i stuen",
              body: "<p>Et indlæg.</p>",
              handle: "hygge-i-stuen",
              excerpt: "Teaser",
            }],
          }],
        };
      },
    };
    const { adapter } = harness(["shop"], {}, { graphqlStub: gql });
    const posts = await drain(adapter.posts());
    assert.equal(posts.length, 1);
    assert.equal(posts[0].title?.rendered, "");
    assert.equal(posts[0].content?.rendered, "");
    assert.equal(posts[0].excerpt?.rendered, "");
    assert.equal(posts[0].slug, null);
  });
});

