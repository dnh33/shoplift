#!/usr/bin/env node
/**
 * Offline end-to-end test: fixture export -> transform -> assertions.
 * No network, no Shopify store needed. Run with: npm test
 */
import path from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { runExport } from "../src/stages/export.js";
import { runTransform } from "../src/transform/index.js";
import { readJsonl, readJson } from "../src/util/fsx.js";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
};

const cfg = loadConfig(fileURLToPath(new URL("./fixture.config.json", import.meta.url)));
try { rmSync(cfg.paths.data, { recursive: true, force: true }); }
catch { /* stage writers truncate on open, so a stale data-test dir is harmless */ }

console.log("— export (fixture adapter) —");
const exp = await runExport(cfg, cfg.entities);
ok(exp.counts.products === 8, "exports 8 raw products");
ok(exp.counts.orders === 4, "exports 4 raw orders");
ok(exp.counts.reviews === 2, "exports product reviews");
ok(exp.counts.posts === 2 && exp.counts.pages === 1, "exports WP content");

console.log("— transform —");
const { counts, warnings } = await runTransform(cfg, cfg.entities);

// products
const products = readJsonl(path.join(cfg.paths.transformed, "products.jsonl"));
ok(counts.products === 7 && products.length === 7, "grouped product not a product, 7 products transformed");
const grouped = warnings.find((w) => w.code === "GROUPED_CONVERTED");
ok(grouped?.severity === "handled", "grouped product auto-converted (severity: handled)");
const cols = readJson(path.join(cfg.paths.transformed, "collections.json"));
const gcol = cols.find((col) => col.slug === "gavesaet" && col.memberWooIds);
ok(gcol && gcol.memberWooIds.join(",") === "101,102", "grouped -> collection with member woo ids");
ok(counts.collections === 4, "collections count includes the converted grouped product");
ok(cols.every((col) => col.kind !== "conditions"), "Woo/fixture path emits no conditions collections");
ok(cols.every((col) => !String(col.slug || "").startsWith("brand-")), "Woo/fixture path emits no brand- handles");
ok(cols.every((col) => col.slug !== "fokus-forside"), "Woo/fixture path emits no fokus-forside collection");

const cup = products.find((p) => p.input.handle === "kaffekop-keramik")?.input;
ok(Boolean(cup), "simple product handle kept");
ok(cup.variants[0].price === "129.00" && cup.variants[0].compareAtPrice === "179.00", "sale price -> price + compareAtPrice (2dp, as Shopify stores money)");
ok(cup.variants[0].inventoryQuantities?.[0]?.quantity === 42, "stock quantity mapped");
ok(cup.variants[0].inventoryItem.measurement.weight.value === 0.4, "weight on inventoryItem.measurement");
ok(cup.seo?.title?.includes("håndlavet"), "Yoast SEO title mapped");
ok(!cup.descriptionHtml.includes("[gallery"), "shortcodes stripped");
ok(cup.descriptionHtml.includes('href="/om-os/"'), "internal links rewritten to relative");
ok(cup.files?.[0]?.originalSource.startsWith("https://"), "image originalSource set");

const shirt = products.find((p) => p.input.handle === "t-shirt-basic")?.input;
ok(shirt.productOptions.length === 2, "2 options built from variation attributes");
ok(shirt.variants.length === 2, "2 variants");
const mHvid = shirt.variants.find((v) => v.sku === "TS-M-HVID");
ok(mHvid.price === "149.00" && mHvid.compareAtPrice === "199.00", "variant sale price mapped");
ok(mHvid.inventoryPolicy === "CONTINUE", "backorders -> inventoryPolicy CONTINUE");
ok(shirt.variants[0].optionValues.some((o) => o.optionName === "Størrelse"), "option values keep attribute names");

// customers
const customers = readJsonl(path.join(cfg.paths.transformed, "customers.jsonl"));
ok(customers.length === 1, "customer without email skipped");
ok(customers[0].identifier.email === "mette@example.dk", "customerSet identifier = email");
ok(warnings.some((w) => w.code === "NO_EMAIL"), "no-email customer warned");

// orders
const orders = readJsonl(path.join(cfg.paths.transformed, "orders.jsonl"));
ok(orders.length === 4, "4 orders transformed");
const o1 = orders.find((o) => o.order.sourceIdentifier === "9001")?.order;
ok(o1.transactions?.[0]?.kind === "SALE" && o1.transactions[0].status === "SUCCESS", "paid order gets SALE/SUCCESS transaction");
ok(o1.transactions[0].amountSet.shopMoney.amount === "348.00", "transaction amount = order total");
ok(o1.fulfillmentStatus === "FULFILLED", "completed order marked FULFILLED");
ok(o1.discountCode?.itemFixedDiscountCode?.code === "VELKOMMEN10", "first coupon becomes discountCode");
ok(o1.processedAt === "2025-11-14T09:31:12Z", "processedAt backdated to payment date");
ok(o1.lineItems[0].priceSet.shopMoney.amount === "129.00", "unit price from subtotal/qty");
ok(!("taxLines" in (o1.shippingLines[0] || {})), "Woo shipping omits empty taxLines (bit-identity)");
ok(o1.shippingLines[0].priceSet.shopMoney.amount === "49.00", "Woo shipping money unchanged");
ok(o1.transactions[0].amountSet.shopMoney.amount === "348.00", "Woo order total money unchanged when shipping taxLines omitted");
ok(warnings.some((w) => w.code === "MULTI_DISCOUNT"), "multi-coupon order warned");
ok(warnings.some((w) => w.code === "REFUND_NOT_RECREATED"), "refunded order warned");
const o2 = orders.find((o) => o.order.sourceIdentifier === "9002")?.order;
ok(o2.lineItems.length === 2 && o2.lineItems[1].title === "Gaveindpakning" && o2.lineItems[1].priceSet.shopMoney.amount === "25.00", "positive fee line becomes a line item");
ok(o2.lineItems[1].requiresShipping === false, "fee line item requires no shipping");
ok(warnings.some((w) => w.code === "NEGATIVE_FEE"), "negative fee warned");

// discounts
const discounts = readJsonl(path.join(cfg.paths.transformed, "discounts.jsonl"));
ok(counts.discounts === 2, "expired coupon skipped");
const pct = discounts.find((d) => d.basicCodeDiscount.code === "VELKOMMEN10").basicCodeDiscount;
ok(pct.customerGets.value.percentage === 0.1, "percent coupon -> percentage 0.1");
ok(pct.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal === "100.00", "minimum amount mapped");
ok(pct.appliesOncePerCustomer === true, "usage_limit_per_user=1 -> appliesOncePerCustomer");
const perItem = discounts.find((d) => d.basicCodeDiscount.code === "KOP25").basicCodeDiscount;
ok(perItem.customerGets.value.discountAmount.appliesOnEachItem === true, "fixed_product -> appliesOnEachItem");
ok(warnings.some((w) => w.code === "SCOPED_COUPON"), "product-scoped coupon warned");

// content
const articles = readJsonl(path.join(cfg.paths.transformed, "articles.jsonl"));
ok(articles[0].article.handle === "guide-til-keramikpleje", "post handle kept");
ok(articles[0].article.author?.name === "Test Author", "author mapped");
ok(articles[0].article.image?.url.includes("keramik-hero"), "featured image mapped");
ok(articles[0].seo?.title?.includes("Keramikpleje"), "post SEO extracted");
const pages = readJsonl(path.join(cfg.paths.transformed, "pages.jsonl"));
ok(pages[0].page.handle === "om-os", "page handle kept");

// locale (fixture config has no explicit locale -> defaults to "da")
// Bit-identical WP pin: DanDomain source-aware wrapping must not change this byte.
const WP_ORDER_NOTE = [
  `Importeret fra WordPress. Oprindelig ordre 9001 (id 9001), status "completed".`,
  `Rabatkoder: VELKOMMEN10, FRIFRAGT (rabat 30.00 DKK)`,
  `Kundenote: Ring ved levering`,
].join("\n");
ok(o1.note === WP_ORDER_NOTE, "WP order note bit-identical (da)");
ok(customers[0].input.note === "Importeret fra WordPress (bruger 501)", "WP customer note bit-identical (da)");
{
  const { localeOf, LOCALES } = await import("../src/locales.js");
  ok(localeOf({ options: {} }).orderNote === LOCALES.da.orderNote, "localeOf default returns same orderNote function (WP)");
  ok(localeOf({ source: { adapter: "fixture" }, options: { locale: "da" } }).orderNote === LOCALES.da.orderNote, "fixture adapter keeps WP orderNote function");
  ok(localeOf({ source: { adapter: "woocommerce" } }).customerNote === LOCALES.da.customerNote, "woocommerce adapter keeps WP customerNote function");
}

// redirects
const csv = readFileSync(path.join(cfg.paths.transformed, "redirects.csv"), "utf8");
ok(csv.startsWith("Redirect from,Redirect to"), "redirect CSV header");
ok(csv.includes("/produkt/kaffekop-keramik,/products/kaffekop-keramik"), "product redirect built");
ok(csv.includes("/product-category/koekken,/collections/koekken"), "category redirect built");
ok(csv.includes("/blog/guide-til-keramikpleje,/blogs/blog/guide-til-keramikpleje"), "post redirect built");
ok(csv.includes("/om-os,/pages/om-os"), "page redirect built");
ok(csv.includes("/shop,/collections/all"), "structural redirect built");
ok(csv.includes("/butik,/collections/all") && csv.includes("/kurv,/cart"), "danish structural redirects built (locale da)");
ok(csv.includes("/produkt/gavesaet,/collections/gavesaet"), "grouped product URL redirects to its collection");

// —— phase 4: real-tier hardening ——
console.log("— phase 4: real-tier hardening —");

// Word-paste cleanup (mso debris)
const plaid = products.find((x) => x.input.handle === "plaid-oeko")?.input;
ok(Boolean(plaid), "messy product transformed");
ok(plaid.title === "Plaid & Pude Øko", "title entity-decoded and trimmed");
ok(!/mso-|MsoNormal|<o:p>|<!--\[if/.test(plaid.descriptionHtml), "word-paste debris stripped (mso styles, o:p, conditional comments)");
ok(!plaid.descriptionHtml.includes("<span"), "attribute-less span wrappers unwrapped");
ok(plaid.descriptionHtml.includes("Blødt plaid") && plaid.descriptionHtml.includes("Vaskes skånsomt"), "content survives the scrub");
ok(warnings.some((w) => w.code === "WORD_HTML" && w.entity === "product" && w.severity === "handled"), "WORD_HTML warned for product (handled)");
ok(warnings.some((w) => w.code === "WORD_HTML" && w.entity === "article"), "WORD_HTML warned for article");

// unresolved ?p= links
ok(plaid.descriptionHtml.includes('href="https://www.example-shop.com/?p=123"'), "?p= link left absolute — not fake-rewritten to a dead relative URL");
ok(warnings.some((w) => w.code === "UNRESOLVED_LINK" && w.entity === "product" && w.severity === "info"), "UNRESOLVED_LINK warned for product (info)");
ok(warnings.some((w) => w.code === "UNRESOLVED_LINK" && w.entity === "article" && w.message.includes("?p=42")), "UNRESOLVED_LINK warned for article, naming the link");

// sale >= regular guard + whitespace SKU
ok(plaid.variants[0].price === "199.00" && !plaid.variants[0].compareAtPrice, "sale>regular: sells at regular price, bogus sale dropped");
ok(warnings.some((w) => w.code === "SALE_GTE_REGULAR" && w.severity === "handled"), "SALE_GTE_REGULAR warned (handled)");
ok(plaid.variants[0].sku === "PLAID-OKO-1", "padded SKU trimmed");

// digital product files
const digi = warnings.find((w) => w.code === "DIGITAL_FILES");
ok(digi?.severity === "action" && digi.message.includes("Opskrift: Hue"), "downloadable product's files flagged as ACTION, naming the file");
const pdf = products.find((x) => x.input.handle === "strikkeopskrift-hue")?.input;
ok(pdf.variants[0].inventoryItem.requiresShipping === false, "virtual/downloadable product needs no shipping");

// option-name case folding across the catalog
const hue = products.find((x) => x.input.handle === "hue-merino")?.input;
ok(hue.productOptions[0].name === "Farve", 'option "farve" folded to first-seen "Farve"');
ok(hue.variants.every((v) => v.optionValues[0].optionName === "Farve"), "variant optionValues use the folded name");
ok(warnings.some((w) => w.code === "OPTION_CASE_FOLDED" && w.severity === "handled"), "OPTION_CASE_FOLDED warned (handled)");
ok(warnings.some((w) => w.code === "ZERO_PRICE" && w.id === 106 && w.severity === "action"), "priceless variation -> ZERO_PRICE action");

// handle collisions
const colWarn = warnings.find((w) => w.code === "HANDLE_COLLISION" && w.entity === "collection");
ok(colWarn?.severity === "handled" && colWarn.message.includes('"gavesaet"') && colWarn.message.includes("grouped"), "collection handle collision names the category × grouped merge");
const prodCol = warnings.find((w) => w.code === "HANDLE_COLLISION" && w.entity === "product");
ok(prodCol?.severity === "action" && prodCol.message.includes('"gave-saet"'), "product handle collision is an ACTION (silent overwrite risk)");

// orders: partial refunds + foreign currency
const o3 = orders.find((o) => o.order.sourceIdentifier === "9003")?.order;
ok(warnings.some((w) => w.code === "REFUND_PARTIAL" && w.severity === "info" && w.message.includes("100.00")), "partial refund -> info note with amount");
ok(o3.note.includes("Delvis refusion") && o3.note.includes("100.00"), "partial refund noted on the order itself (da)");
ok(o3.transactions[0].amountSet.shopMoney.amount === "449.00", "partially refunded order imports at full value");
const o4 = orders.find((o) => o.order.sourceIdentifier === "9004")?.order;
ok(o4.currency === "EUR", "order keeps its source currency");
ok(warnings.some((w) => w.code === "CURRENCY_MISMATCH" && w.severity === "info"), "non-store currency -> CURRENCY_MISMATCH info");

// reviews
const rev = warnings.find((w) => w.code === "REVIEWS_NOT_MIGRATED");
ok(rev?.severity === "info" && rev.message.includes("2 product review(s)"), "review count surfaced with review-app pointer");

// severity taxonomy
const { severities } = await runTransform(cfg, cfg.entities); // re-run: deterministic
ok(severities.action === 4 && severities.handled === 7 && severities.info === 8, `severities split correctly (4 action / 7 handled / 8 info, got ${JSON.stringify(severities)})`);

// handle sanitization (Danish chars)
const collections = readJson(path.join(cfg.paths.transformed, "collections.json"));
ok(collections.find((c) => c.slug === "koekken")?.input.handle === "koekken", "collection handle ascii-safe");

// Three real-xl live findings (2026-07-29). Shopify enforces limits WooCommerce
// does not, and the mapper used to pass the source through unchanged — so the
// run died at IMPORT with exit 4 instead of warning at transform. Invariant 5:
// a lossy decision is a warning, not a late failure.
console.log("— Shopify field limits are enforced at transform, not at import —");
{
  const { transformProduct } = await import("../src/transform/products.js");
  const { transformOrder } = await import("../src/transform/orders.js");
  const { TITLE_MAX } = await import("../src/transform/html.js");

  const pctx = { cfg: { source: { baseUrl: "https://x.example" }, options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true } }, locationId: null, optionCase: new Map() };
  // A real WooCommerce title: SEO-stuffed, no limit on the source side.
  const longName = "Uldplaid " + "ekstra blød merino i mange farver ".repeat(12);
  const long = transformProduct({ id: 1, name: longName, slug: "lang", type: "simple", status: "publish", description: "", regular_price: "10", attributes: [], categories: [], tags: [], images: [], meta_data: [] }, pctx);
  ok(longName.length > TITLE_MAX, `fixture title is genuinely over the limit (${longName.length} > ${TITLE_MAX})`);
  ok(long.input.title.length <= TITLE_MAX, `product title truncated to <= ${TITLE_MAX} (got ${long.input.title.length})`);
  ok(long.warnings.some((w) => w.code === "TITLE_TRUNCATED" && w.severity === "action"), "an over-long title raises an actionable TITLE_TRUNCATED warning rather than failing at import");

  const short = transformProduct({ id: 2, name: "Kort titel", slug: "kort", type: "simple", status: "publish", description: "", regular_price: "10", attributes: [], categories: [], tags: [], images: [], meta_data: [] }, pctx);
  ok(short.input.title === "Kort titel" && !short.warnings.some((w) => w.code === "TITLE_TRUNCATED"), "a normal title is untouched and warns about nothing");

  // use the real locale table rather than a hand-rolled stub — transformOrder
  // builds its note from several locale strings, and a partial stub only fails
  // once the code reaches a branch the stub forgot.
  const { localeOf } = await import("../src/locales.js");
  const octx = { cfg: { options: { orders: {} } }, L: localeOf({ options: {} }), storeCurrency: "DKK" };
  // Paid, zero total — a 100% discount code or a comped replacement.
  const zero = transformOrder({ id: 9, number: "1009", status: "completed", currency: "DKK", total: "0.00", date_paid_gmt: "2026-01-05T10:00:00", line_items: [{ name: "Gratis vareprøve", quantity: 1, subtotal: "0.00", total: "0.00", taxes: [] }], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [] }, octx);
  ok(zero.order && !zero.order.transactions, "a paid zero-total order imports WITHOUT a transaction (Shopify rejects a zero-value SALE)");
  ok(zero.warnings.some((w) => w.code === "ZERO_TOTAL_PAID"), "the dropped transaction is recorded as ZERO_TOTAL_PAID, not silent");

  const emptyLines = transformOrder({ id: 1, number: "DD1", status: "completed", currency: "DKK", total: "0.00", line_items: [], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [] }, octx);
  ok(emptyLines.order && emptyLines.order.lineItems.length === 0, "an empty-line order is still transformed (counts stay honest)");
  ok(emptyLines.warnings.some((w) => w.code === "ORDER_EMPTY_UNLANDABLE" && w.severity === "handled"),
    "empty line items raise ORDER_EMPTY_UNLANDABLE (handled) — import skips, does not fabricate lines");

  const paidNormal = transformOrder({ id: 10, number: "1010", status: "completed", currency: "DKK", total: "199.00", date_paid_gmt: "2026-01-05T10:00:00", line_items: [{ name: "Plaid", quantity: 1, subtotal: "199.00", total: "199.00", taxes: [] }], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [] }, octx);
  ok(paidNormal.order.transactions?.[0]?.amountSet.shopMoney.amount === "199.00", "a normal paid order still gets its SALE transaction");
  ok(!paidNormal.warnings.some((w) => w.code === "ORDER_EMPTY_UNLANDABLE"), "a landable order does not get ORDER_EMPTY_UNLANDABLE");

  const longLine = transformOrder({ id: 11, number: "1011", status: "completed", currency: "DKK", total: "50.00", date_paid_gmt: "2026-01-05T10:00:00", line_items: [{ name: longName, quantity: 1, subtotal: "50.00", total: "50.00", taxes: [] }], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [] }, octx);
  ok(longLine.order.lineItems[0].title.length <= TITLE_MAX, `order line item title truncated to <= ${TITLE_MAX} (got ${longLine.order.lineItems[0].title.length})`);
  ok(longLine.warnings.some((w) => w.code === "TITLE_TRUNCATED"), "the order records that a line title was truncated — the order survives but its text differs from source");
}

// D15. Found on a live real-xl run, NOT by this suite: a product priced 0.001
// ("Uldgarn — pris pr. gram") imported ACTIVE at 0.00 — free — with no warning
// anywhere. The zero-price guard tested the SOURCE value, and 0.001 is not 0;
// Shopify did the rounding on write, silently. Money is now reshaped to
// Shopify's 2 decimals at transform, where it can be declared.
console.log("— money is rounded to Shopify's precision at transform, and declared —");
{
  const { transformProduct, MONEY_DP } = await import("../src/transform/products.js");
  const { transformOrder } = await import("../src/transform/orders.js");
  const { localeOf } = await import("../src/locales.js");

  const pctx = { cfg: { source: { baseUrl: "https://x.example" }, options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true } }, locationId: null, optionCase: new Map() };
  const mkProduct = (id, name, price) => ({ id, name, slug: `p${id}`, type: "simple", status: "publish", description: "", regular_price: price, price, attributes: [], categories: [], tags: [], images: [], meta_data: [] });

  ok(MONEY_DP === 2, "Shopify money precision is declared as a constant, not spelled 2 in four places");

  // the exact live case: per-gram pricing, legitimate in Woo, free in Shopify
  const subCent = transformProduct(mkProduct(1, "Uldgarn — pris pr. gram", "0.001"), pctx);
  ok(subCent.input.variants[0].price === "0.00", `a sub-cent price is rounded at transform, so what we send is what lands (got ${subCent.input.variants[0].price})`);
  const rz = subCent.warnings.find((w) => w.code === "PRICE_ROUNDED_TO_ZERO");
  ok(rz?.severity === "action", "a price that ROUNDS to zero raises an actionable PRICE_ROUNDED_TO_ZERO — the defect was that this was silent");
  ok(rz?.message.includes("0.001"), "the warning names the SOURCE price, which is the number a human has to act on");
  ok(!subCent.warnings.some((w) => w.code === "ZERO_PRICE"), "a rounded-to-zero price is not ALSO reported as ZERO_PRICE — different cause, different fix");

  // A warning is fail-OPEN — it relies on being read. The zero here is OUR
  // artifact (the merchant priced it non-zero), so the product must not be
  // sellable at a price they never set, even with productStatus: ACTIVE.
  ok(subCent.input.status === "DRAFT", `a product whose price we rounded to zero is parked as DRAFT even when productStatus is ACTIVE (got ${subCent.input.status})`);
  ok(rz?.message.includes("DRAFT"), "the warning says the product was parked, so the operator knows why it is not live");

  // a genuinely priceless product must still take the original path
  const free = transformProduct(mkProduct(2, "Vareprøve", "0"), pctx);
  ok(free.warnings.some((w) => w.code === "ZERO_PRICE" && w.severity === "action"), "a product that IS priceless still raises ZERO_PRICE");
  ok(!free.warnings.some((w) => w.code === "PRICE_ROUNDED_TO_ZERO"), "a product that IS priceless is not reported as rounded");
  ok(free.input.status === "ACTIVE", "a merchant who DELIBERATELY priced something 0 keeps their published status — we only override the zero we introduced ourselves");

  // supplier feeds carry 4-decimal wholesale prices; rounding is fine, silence is not
  const feed = transformProduct(mkProduct(3, "Importeret Alpakaplaid", "1234.5678"), pctx);
  ok(feed.input.variants[0].price === "1234.57", `a 4-decimal feed price rounds to ${MONEY_DP} decimals (got ${feed.input.variants[0].price})`);
  const pr = feed.warnings.find((w) => w.code === "PRICE_ROUNDED");
  ok(pr?.severity === "handled", "an ordinary rounding is 'handled' — it changed the data but needs no decision");
  ok(pr?.message.includes("1234.5678") && pr?.message.includes("1234.57"), "the rounding warning shows both the before and the after");

  // the common case must stay quiet, or the warning is noise
  const plain = transformProduct(mkProduct(4, "Plaid", "199"), pctx);
  ok(plain.input.variants[0].price === "199.00", "an ordinary price is emitted at 2 decimals, matching what Shopify stores");
  ok(!plain.warnings.some((w) => /^PRICE_ROUNDED/.test(w.code)), "an ordinary price warns about nothing");
  ok(plain.input.status === "ACTIVE", "an ordinary product is untouched by the parking rule");
  ok(feed.input.status === "ACTIVE", "a merely-rounded price does NOT park the product — it still has a real price");

  // Order line drift: Woo stores a line TOTAL, Shopify wants a UNIT price, and
  // the division does not always divide. Live: order #WP1489, 32 lines, +0.01.
  const octx = { cfg: { options: { orders: {} } }, L: localeOf({ options: {} }), storeCurrency: "DKK" };
  const mkOrder = (id, lines, total) => ({ id, number: String(id), status: "completed", currency: "DKK", total, date_paid_gmt: "2026-01-05T10:00:00", line_items: lines, shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [] });

  // 10.00 over 3 units = 3.3333... -> 3.33 -> 9.99. One cent lost.
  const drift = transformOrder(mkOrder(20, [{ name: "Garnnøgle", quantity: 3, subtotal: "10.00", total: "10.00", taxes: [] }], "10.00"), octx);
  const dw = drift.warnings.find((w) => w.code === "ORDER_TOTAL_DRIFT");
  ok(dw?.severity === "handled", "a line total that does not divide evenly raises ORDER_TOTAL_DRIFT");
  ok(dw?.message.includes("-0.01"), `the drift warning states the signed amount so it can be reconciled (got: ${dw?.message.match(/[-+]0\.\d\d/)?.[0]})`);
  ok(drift.order && drift.order.lineItems.length === 1, "the order still imports — drift is declared, not fatal");

  // and it must NOT fire on the overwhelming majority that divide cleanly
  const clean = transformOrder(mkOrder(21, [{ name: "Plaid", quantity: 2, subtotal: "10.00", total: "10.00", taxes: [] }], "10.00"), octx);
  ok(!clean.warnings.some((w) => w.code === "ORDER_TOTAL_DRIFT"), "an evenly-divisible order warns about nothing — this fired on 1 of 63 live orders, and that precision is the point");
}

console.log("— DanDomain fixtures: adapter → transform (SHIPPED-LIVE) —");
{
  const { readFileSync: read, mkdirSync, rmSync: rm, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const { createClient } = await import("../src/dandomain/client.js");
  const { createDanDomainAdapter } = await import("../src/sources/dandomain.js");
  const { jsonlWriter, writeJson } = await import("../src/util/fsx.js");
  const RAW_DD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "dandomain", "raw");
  const responses = {};
  for (const n of ["shop", "products", "orders", "customers", "categories", "coupons", "pages"]) {
    const body = JSON.parse(read(path.join(RAW_DD, `${n}.json`), "utf8"));
    for (const [op, xs] of Object.entries(body.responses)) {
      responses[op] = [...(responses[op] ?? []), ...xs];
    }
  }
  const queues = new Map(Object.entries(responses).map(([op, xs]) => [op, [...xs]]));
  const fetchImpl = async (_url, init) => {
    const body = Buffer.from(init.body).toString("utf8");
    const op = /<m:([A-Za-z0-9_]+)[\s>]/.exec(body)?.[1];
    if (op === "User_GetAllByDate" && !queues.has(op)) {
      const src = queues.get("User_GetAll");
      if (src?.length) {
        queues.set(op, src.map((xml) => xml.replaceAll("User_GetAll", "User_GetAllByDate")));
      }
    }
    const q = queues.get(op);
    if (!q?.length) throw new Error(`no fixture for ${op}`);
    const xml = q.length > 1 ? q.shift() : q[0];
    const bytes = Buffer.from(xml, "utf8");
    return {
      ok: true, status: 200,
      headers: { get: () => null, getSetCookie: () => ["PHPSESSID=fx; path=/"] },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const client = createClient({ username: "u", password: "p", fetchImpl });
  const adapter = createDanDomainAdapter({
    source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://shop000000.mywebshop.io", dandomain: { username: "u", password: "p", tenant: "shop000000", language: "DK", pageSize: 50 } },
    options: {},
  }, { client, now: () => new Date("2026-08-16T00:00:00Z") });
  const dir = mkdtempSync(path.join(os.tmpdir(), "dd-fx-"));
  const raw = path.join(dir, "raw"), out = path.join(dir, "transformed");
  mkdirSync(raw, { recursive: true });
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
  const ddCfg = {
    source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://shop000000.mywebshop.io" },
    paths: { raw, transformed: out },
    entities: { products: true, collections: true, customers: true, orders: true, discounts: true, pages: true, articles: false, redirects: true },
    options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true, stripShortcodes: true, rewriteInternalLinks: true, locale: "da", orders: { markFulfilledWhenComplete: true, importCancelled: false, tag: "dd-import" } },
    shopify: { blog: { title: "Blog", handle: "blog" } },
  };
  const dd = await runTransform(ddCfg, ddCfg.entities);
  ok(dd.counts.products >= 1, "SHIPPED-LIVE 1: products transformed");
  ok(dd.counts.collections >= 1, "SHIPPED-LIVE 2: categories → collections");
  ok(dd.counts.customers >= 1, "SHIPPED-LIVE 3: customers");
  ok(dd.counts.orders >= 1, "SHIPPED-LIVE 4: orders");
  ok(settings.vatBasis === "INCLUSIVE" && settings.currency === "DKK", "SHIPPED-LIVE 9: settings/VAT");
  ok(dd.counts.pages >= 1, "SHIPPED-LIVE 8: CMS pages");
  const ddProducts = readJsonl(path.join(out, "products.jsonl"));
  ok(ddProducts[0].input.files?.[0]?.originalSource?.includes("/pics/"), "SHIPPED-LIVE 1: product images");
  ok(ddProducts[0].input.variants.some((v) => v.file?.originalSource?.includes("/pics/")), "SHIPPED-LIVE/P6: variant images");
  const ddWarn = new Set(dd.warnings.map((w) => w.code));
  ok(ddWarn.has("BLOG_NOT_EXPORTED"), "blog warning stays until posts() GraphQL succeeds (this harness does not stub GraphQL)");
  ok(dd.counts.discounts >= 0, "SHIPPED-LIVE 6: discounts transform ran");
  rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
