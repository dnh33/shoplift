#!/usr/bin/env node
/**
 * Offline import simulation: runs the REAL order importer against a mock
 * Shopify client that reproduces the live-observed orderCreate creation
 * rate limit (verbatim "Too many attempts. Please try again later." as a
 * userError). Proves, without a network:
 *   - rate-limited orders are deferred (never marked failed) and drained in rounds
 *   - pacing engages after the first rate-limit hit
 *   - the mock REJECTS duplicate creations — zero-duplicate guarantee is asserted, not assumed
 *   - pre-existing orders (found by tag) are skipped and ledgered
 *   - validation errors fail immediately and don't poison the queue
 * Run: node test/run-import-sim.js  (also part of npm test)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { importOrders } from "../src/import/orders.js";
import { openIdMap } from "../src/util/idmap.js";
import { jsonlWriter, readJsonl } from "../src/util/fsx.js";

let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? (passed++, console.log(`  ✓ ${name}`)) : (failed++, console.error(`  ✗ ${name}`)); };

// ---------- mock Shopify ----------
function createMockShopify({ rateLimitFirstN = 0, preExisting = [], preExistingPrefix = "wc-order-", validationFails = [] } = {}) {
  const byTag = new Map(); // wc-order / dd-order tag -> gid
  for (const sid of preExisting) byTag.set(`${preExistingPrefix}${sid}`, `gid://mock/Order/pre-${sid}`);
  const state = { createCalls: 0, rateLimited: 0, duplicates: 0 };
  const tagOf = (order) => (order.tags || []).find((t) => t.startsWith("wc-order-") || t.startsWith("dd-order-"));

  return {
    state, byTag,
    async graphql(query, vars) {
      if (query.includes("ordersByTag")) {
        const tag = (vars.q.match(/tag:'([^']+)'/) || [])[1];
        const gid = byTag.get(tag);
        return { orders: { nodes: gid ? [{ id: gid, name: tag, tags: [tag] }] : [] } };
      }
      if (query.includes("productVariants")) return { productVariants: { nodes: [] } };
      throw new Error("mock: unexpected query " + query.slice(0, 60));
    },
    async mutate(name, doc, vars) {
      if (name !== "orderCreate") throw new Error("mock: unexpected mutation " + name);
      state.createCalls++;
      const order = vars.order;
      if (validationFails.includes(order.sourceIdentifier)) {
        const e = new Error("orderCreate userErrors: boom");
        e.userErrors = [{ field: ["order"], message: "mock validation failure" }];
        throw e;
      }
      if (state.createCalls <= rateLimitFirstN) {
        state.rateLimited++;
        const e = new Error("orderCreate userErrors: throttle");
        e.userErrors = [{ field: null, message: "Too many attempts. Please try again later." }];
        throw e;
      }
      const tag = tagOf(order);
      if (byTag.has(tag)) { state.duplicates++; throw new Error(`mock: DUPLICATE CREATION of ${tag} — importer bug!`); }
      const gid = `gid://mock/Order/${order.sourceIdentifier}`;
      byTag.set(tag, gid);
      return { order: { id: gid, name: order.name } };
    }
  };
}

// ---------- scenario scaffolding ----------
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// unique per run: environments that block dir deletion (sandboxes) must never
// let a previous run's ledger bleed into this one
const simDir = path.join(ROOT, "data-test", `sim-${Date.now()}`);

async function scenario(label, { orders, mockOpts, ledgered = [], tagPrefix = "wc-order-", namePrefix = "#WP" }) {
  const dataDir = path.join(simDir, label);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* sandboxes may block deletes; writers truncate anyway */ }
  const cfg = {
    options: { dryRun: false, orders: { tag: "wp-import", paceMs: 1, retryWaitBaseMs: 2, retryWaitMaxMs: 5, maxRetryRounds: 7 } },
    paths: { data: dataDir, transformed: path.join(dataDir, "transformed"), state: path.join(dataDir, "state") }
  };
  const w = jsonlWriter(path.join(cfg.paths.transformed, "orders.jsonl"));
  for (const sid of orders) {
    w.write({ order: {
      sourceIdentifier: String(sid), name: `${namePrefix}${sid}`, email: `sim${sid}@example.dk`,
      processedAt: "2026-07-27T10:00:00Z", currency: "DKK",
      tags: ["wp-import", `${tagPrefix}${sid}`],
      lineItems: [{ title: `Item ${sid}`, quantity: 1, priceSet: { shopMoney: { amount: "10.00", currencyCode: "DKK" } }, requiresShipping: true, taxLines: [], _sku: null }],
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "sim", amountSet: { shopMoney: { amount: "10.00", currencyCode: "DKK" } }, processedAt: "2026-07-27T10:00:00Z" }]
    } });
  }
  await w.close();
  const idmap = openIdMap(cfg.paths.state);
  for (const sid of ledgered) idmap.set("orders", String(sid), `gid://mock/Order/${sid}`);
  const mock = createMockShopify(mockOpts);
  console.log(`— ${label} —`);
  const result = await importOrders(cfg, mock, idmap);
  return { result, mock, idmap, failedRows: readJsonl(path.join(cfg.paths.state, "failed-orders.jsonl")) };
}

// ---------- A: rate-limit storm (mirrors the live 17:56 incident) ----------
{
  const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
  const { result, mock, idmap, failedRows } = await scenario("storm", { orders: ids, mockOpts: { rateLimitFirstN: 15 } });
  ok(result.imported === 12, "storm: all 12 orders eventually imported");
  ok(result.failed === 0, "storm: zero orders written off as failed");
  ok(mock.state.rateLimited === 15, "storm: mock delivered all 15 rate-limit rejections");
  ok(mock.state.duplicates === 0, "storm: ZERO duplicate creations (mock-enforced)");
  ok(ids.every((sid) => idmap.get("orders", String(sid))), "storm: ledger has every order gid");
  ok(failedRows.length === 0, "storm: failed ledger empty");
  ok(mock.state.createCalls === 15 + 12, "storm: exactly failures+successes calls — no wasted retries");
}

// ---------- B: pre-existing orders are detected by tag, never re-created ----------
{
  const ids = [200, 201, 202, 203];
  const { result, mock, idmap } = await scenario("dedup", { orders: ids, mockOpts: { preExisting: [201, 203] } });
  ok(result.imported === 2, "dedup: only the 2 missing orders created");
  ok(mock.state.duplicates === 0, "dedup: existing orders never re-sent");
  ok(idmap.get("orders", "201")?.includes("pre-201"), "dedup: ledger adopted the pre-existing gid");
  ok(idmap.get("orders", "203")?.includes("pre-203"), "dedup: both pre-existing adopted");
}

// ---------- B2: dd-order- tags are found the same way as wc-order- ----------
{
  const ids = [801, 802];
  const { result, mock, idmap } = await scenario("dd-dedup", {
    orders: ids,
    tagPrefix: "dd-order-",
    namePrefix: "#DD",
    mockOpts: { preExisting: [801], preExistingPrefix: "dd-order-" },
  });
  ok(result.imported === 1, "dd-dedup: only the missing dd-order is created");
  ok(mock.state.duplicates === 0, "dd-dedup: existing dd-order never re-sent");
  ok(idmap.get("orders", "801")?.includes("pre-801"), "dd-dedup: ledger adopted the dd-order- gid");
  ok(idmap.get("orders", "802"), "dd-dedup: the new dd-order was created");
}

// ---------- C: validation failures fail fast; rest of queue unaffected ----------
{
  const ids = [300, 301, 302, 303, 304];
  const { result, failedRows } = await scenario("validation", { orders: ids, mockOpts: { validationFails: ["302"] } });
  ok(result.imported === 4, "validation: 4 clean orders imported");
  ok(result.failed === 1, "validation: exactly 1 failure");
  ok(failedRows.length === 1 && failedRows[0].sourceIdentifier === "302", "validation: failed ledger names the right order");
}

// Empty line items are unlandable (Shopify orderCreate: at least one line item).
// Live F16 #DD1–8 + #DD21 used to write failed-orders.jsonl and exit 4/5.
{
  const dataDir = path.join(simDir, "empty-lines");
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* sandboxes may block deletes */ }
  const cfg = {
    options: { dryRun: false, orders: { tag: "wp-import", paceMs: 1, retryWaitBaseMs: 2, retryWaitMaxMs: 5, maxRetryRounds: 7 } },
    paths: { data: dataDir, transformed: path.join(dataDir, "transformed"), state: path.join(dataDir, "state") }
  };
  const w = jsonlWriter(path.join(cfg.paths.transformed, "orders.jsonl"));
  w.write({ order: {
    sourceIdentifier: "1", name: "#DD1", email: "empty@example.dk",
    processedAt: "2026-07-27T10:00:00Z", currency: "DKK",
    tags: ["wp-import", "dd-order-1"],
    lineItems: [],
    transactions: []
  } });
  w.write({ order: {
    sourceIdentifier: "9", name: "#DD9", email: "ok@example.dk",
    processedAt: "2026-07-27T10:00:00Z", currency: "DKK",
    tags: ["wp-import", "dd-order-9"],
    lineItems: [{ title: "Item 9", quantity: 1, priceSet: { shopMoney: { amount: "10.00", currencyCode: "DKK" } }, requiresShipping: true, taxLines: [], _sku: null }],
    transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "sim", amountSet: { shopMoney: { amount: "10.00", currencyCode: "DKK" } }, processedAt: "2026-07-27T10:00:00Z" }]
  } });
  await w.close();
  const idmap = openIdMap(cfg.paths.state);
  const mock = createMockShopify();
  console.log("— empty-lines —");
  const result = await importOrders(cfg, mock, idmap);
  const failedRows = readJsonl(path.join(cfg.paths.state, "failed-orders.jsonl"));
  ok(result.imported === 1, `empty-lines: the landable order still imports (got imported=${result.imported})`);
  ok(result.failed === 0, `empty-lines: empty lineItems is skipped, not failed (got failed=${result.failed})`);
  ok(result.skippedEmpty === 1, `empty-lines: skippedEmpty counts the unlandable order (got ${result.skippedEmpty})`);
  ok(mock.state.createCalls === 1, `empty-lines: no orderCreate for the empty order (got createCalls=${mock.state.createCalls})`);
  ok(failedRows.length === 0, "empty-lines: failed-orders.jsonl stays empty so verify does not exit 5");
  ok(!idmap.get("orders", "1"), "empty-lines: unlandable order is not ledgered (resume will skip again, not retry-create)");
  ok(idmap.get("orders", "9"), "empty-lines: landable order is ledgered");
}

// ---------- D: persistent rate limit exhausts rounds but stays resumable ----------
{
  const ids = [400, 401];
  const { result, failedRows, idmap } = await scenario("persistent", { orders: ids, mockOpts: { rateLimitFirstN: 9999 } });
  ok(result.imported === 0, "persistent: nothing imported under permanent throttle");
  ok(failedRows.length === 2 && failedRows.every((r) => /re-run import later/.test(r.error)), "persistent: deferred orders written off with resumable message");
  ok(!idmap.get("orders", "400"), "persistent: ledger untouched — re-run will retry");
}

// ---------- E: already-ledgered orders are skipped without any API call ----------
{
  const ids = [500, 501];
  const { result, mock } = await scenario("ledgered", { orders: ids, ledgered: [500, 501], mockOpts: {} });
  ok(result.imported === 0 && mock.state.createCalls === 0, "ledgered: zero API calls for already-migrated orders");
}

// ---------- F: >3-attribute merge produces Shopify-legal option names ----------
{
  const { transformProduct } = await import("../src/transform/products.js");
  const monster = {
    id: 1, name: "Deluxe", slug: "deluxe", type: "variable", status: "publish", description: "",
    attributes: [
      { name: "Størrelse", variation: true }, { name: "Farve", variation: true },
      { name: "Materiale", variation: true }, { name: "Twist", variation: true }
    ],
    _variations: [{
      id: 11, sku: "DLX-1", regular_price: "99", manage_stock: false,
      attributes: [{ name: "Størrelse", option: "50g" }, { name: "Farve", option: "Natur" }, { name: "Materiale", option: "Merino" }, { name: "Twist", option: "Løs" }]
    }],
    images: [], categories: [], tags: [], meta_data: []
  };
  const { input, warnings } = transformProduct(monster, { cfg: { source: { baseUrl: "https://x.dk" }, options: { productStatus: "ACTIVE", weightUnit: "KILOGRAMS", trackInventory: true, stripShortcodes: true, rewriteInternalLinks: true } } });
  ok(input.productOptions.length === 3, "monster: 4 attributes merged to Shopify's 3-option limit");
  ok(input.productOptions[2].name === "Materiale & Twist", "monster: merged option name uses legal ' & ' separator");
  ok(!JSON.stringify(input.productOptions).includes(" / "), "monster: no illegal ' / ' sequence anywhere in options");
  ok(input.variants[0].optionValues[2].name === "Merino & Løs", "monster: merged variant values use ' & ' too");
  ok(warnings.some((w) => w.code === "TOO_MANY_OPTIONS"), "monster: merge warning emitted for review");
}

// ---------- G: an already-finished redirect import skips, and SAYS it did nothing ----------
// Every entity's `created`/`imported` means "what this run did" — products
// report 0 when the ledger skips them. Redirects used to return the ledger's
// cumulative total on the skip path, so a no-op re-run looked like it created
// 148 redirects, both to an agent summing results.* and in the MCP summary
// line (mcp-format.js reads results.redirects.created).
{
  const { importRedirects } = await import("../src/import/redirects.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = path.join(ROOT, "data-test-redirect-skip");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Two guards run BEFORE the skip branch: the CSV must exist and be >30 bytes,
  // and the ledger's rowCount must still match it (a changed redirect set is
  // deliberately re-imported rather than skipped).
  const rows = ["Redirect from,Redirect to", "/old-a,/new-a", "/old-b,/new-b", "/old-c,/new-c"];
  writeFileSync(path.join(dir, "redirects.csv"), rows.join("\n") + "\n");
  const idmap = openIdMap(dir);
  idmap.set("redirects", "lastImportId", "gid://shopify/UrlRedirectImport/1");
  idmap.set("redirects", "finished", true);
  idmap.set("redirects", "rowCount", rows.length - 1);
  idmap.set("redirects", "createdCount", rows.length - 1);
  idmap.set("redirects", "failedCount", 0);

  // Any network call on the skip path is itself a failure, so the client throws.
  const explodingClient = { mutate: () => { throw new Error("redirect skip path must not call Shopify"); }, query: () => { throw new Error("redirect skip path must not call Shopify"); } };
  const cfg = { paths: { state: dir, transformed: dir }, options: {} };

  let res, threw = null;
  try { res = await importRedirects(cfg, explodingClient, idmap); } catch (e) { threw = e.message; }
  ok(threw === null, `already-finished redirect import makes no API call (${threw || "none"})`);
  ok(res?.skipped === true, "the result is flagged skipped:true");
  ok(res?.created === 0, `created reports THIS run's work, not the ledger total (got ${res?.created})`);
  ok(res?.alreadyCreated === 3, `the cumulative ledger figure stays available as alreadyCreated (got ${res?.alreadyCreated})`);
  rmSync(dir, { recursive: true, force: true });
}

// The ledger's write cost is the one scale problem that does NOT need a scale
// tier to find or to guard. save() rewrites the whole file, and the importers
// called it once per record — O(n^2). A live 10k-product run to prove that costs
// hours and a store; this costs milliseconds and runs on every commit.
console.log("— the ledger batches writes instead of rewriting per record —");
{
  const { statSync, readdirSync, mkdirSync, readFileSync } = await import("node:fs");
  const dir = path.join(process.cwd(), "data-test-ledger");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "idmap.json");

  // Count real writes by watching mtime+size change, the way the filesystem sees
  // it — not by trusting a counter the implementation could lie about.
  const led = openIdMap(dir);
  let writes = 0, last = "";
  const N = 1000;
  for (let i = 0; i < N; i++) {
    led.set("products", `handle-${i}`, `gid://mock/Product/${i}`);
    led.save(); // exactly what the per-record import loops do
    let sig = "";
    try { const st = statSync(file); sig = `${st.mtimeMs}:${st.size}`; } catch { /* not written yet */ }
    if (sig && sig !== last) { writes++; last = sig; }
  }
  led.flush();

  ok(writes < N / 10, `${N} per-record save() calls caused ${writes} file writes, not ${N} (batched)`);
  ok(writes > 0, "batching still writes during a long run — a crash must not lose everything");

  // flush() is the durability contract the stage boundaries rely on
  ok(led.pending === 0, "flush() leaves nothing pending");
  const reopened = openIdMap(dir);
  ok(reopened.count("products") === N, `every one of the ${N} entries survived to disk (got ${reopened.count("products")})`);
  ok(reopened.get("products", "handle-999") === "gid://mock/Product/999", "the last entry before flush is on disk, not just the batched ones");

  // a small mutation set must still persist — the trap that would have silently
  // broken scripts/cleanup-duplicate-orders.mjs, which fixes a handful of rows
  const few = openIdMap(dir);
  few.set("orders", "42", "gid://mock/Order/42");
  few.save();
  ok(openIdMap(dir).get("orders", "42") === undefined, "a sub-threshold save() is genuinely deferred (so callers that need durability must flush)");
  few.flush();
  ok(openIdMap(dir).get("orders", "42") === "gid://mock/Order/42", "flush() persists a mutation set far below the batch threshold");

  // compact encoding: this file is rewritten constantly and read by no human
  ok(!readFileSync(file, "utf8").includes("\n  "), "the ledger is written compact — indentation is ~40% of the bytes on every rewrite");
  ok(readdirSync(dir).includes("idmap.json"), "the ledger lands where the stages look for it");
  rmSync(dir, { recursive: true, force: true });
}

// ---------- P4 flag-gated DanDomain importers ----------
console.log("— P4 flag-gated importers (B2B / refunds / blog / gift cards / translations) —");
{
  const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { importRefunds, refundIdempotencyKey } = await import("../src/import/refunds.js");
  const { importB2bPricing } = await import("../src/import/b2b.js");
  const { importGiftCards } = await import("../src/import/gift-cards.js");
  const { importTranslations } = await import("../src/import/translations.js");
  const { importBlog } = await import("../src/import/blog.js");
  const { REFUND_CREATE } = await import("../src/shopify/mutations.js");

  const dir = path.join(ROOT, "data-test-p4-importers");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "raw"), { recursive: true });
  mkdirSync(path.join(dir, "transformed"), { recursive: true });
  mkdirSync(path.join(dir, "state"), { recursive: true });

  writeFileSync(path.join(dir, "raw", "orders.jsonl"), JSON.stringify({
    id: 501, currency: "DKK",
    refunds: [{ id: 9, total: "-50.00", reason: "kreditnota" }],
  }) + "\n");
  writeFileSync(path.join(dir, "raw", "customers.jsonl"), JSON.stringify({
    id: 1, meta_data: [{ key: "_dd_customer_group", value: "4" }],
  }) + "\n");
  writeFileSync(path.join(dir, "raw", "products.jsonl"), JSON.stringify({
    id: 1,
    meta_data: [{ key: "_dd_group_discounts", value: JSON.stringify([{ userId: "4", variantId: "0", price: "150.00" }]) }],
  }) + "\n");
  writeFileSync(path.join(dir, "raw", "warnings.jsonl"), JSON.stringify({
    code: "BLOG_NOT_EXPORTED", message: "blog module on",
  }) + "\n");
  writeFileSync(path.join(dir, "transformed", "gift-cards.csv"), "initial_value,note\n100.00,manual\n");
  writeFileSync(path.join(dir, "transformed", "translations.jsonl"), JSON.stringify({
    resourceId: "gid://shopify/Product/1", locale: "en", key: "title", value: "Apple", digest: "abc",
  }) + "\n");

  const baseCfg = {
    paths: { raw: path.join(dir, "raw"), transformed: path.join(dir, "transformed"), state: path.join(dir, "state") },
    options: { dryRun: false },
  };

  // Flags OFF → skip
  ok((await importRefunds({ ...baseCfg, options: {} }, {}, openIdMap(path.join(dir, "state")))).skipped === true, "refunds: flag off skips");
  ok((await importB2bPricing({ ...baseCfg, options: {} }, {}, openIdMap(path.join(dir, "state")))).skipped === true, "b2b: flag off skips");
  ok((await importGiftCards({ ...baseCfg, options: {} }, {}, openIdMap(path.join(dir, "state")))).skipped === true, "gift cards: flag off skips");
  ok((await importTranslations({ ...baseCfg, options: {} }, {}, openIdMap(path.join(dir, "state")))).skipped === true, "translations: flag off skips");

  const blog = await importBlog(baseCfg, {}, openIdMap(path.join(dir, "state")));
  ok(blog.code === "BLOG_NOT_EXPORTED" && blog.present === true, "blog: emits BLOG_NOT_EXPORTED when present (no crawler)");

  writeFileSync(path.join(dir, "transformed", "articles.jsonl"), JSON.stringify({
    article: { handle: "hygge-i-stuen", title: "Hygge i stuen", body: "<p>Et indlæg.</p>", author: { name: "Import" } },
  }) + "\n");
  const blogLanded = await importBlog(baseCfg, {}, openIdMap(path.join(dir, "state")));
  ok(blogLanded.skipped === false && blogLanded.importedVia === "articles.jsonl",
    "blog: non-empty articles.jsonl is the content.js lander, not crawl-only");

  // Refunds ON — honest money + parent tx
  const refundMutations = [];
  const refundClient = {
    async graphql(q) {
      if (q.includes("orderTransactions") || q.includes("transactions")) {
        return { order: { id: "gid://shopify/Order/1", transactions: [{ id: "gid://shopify/OrderTransaction/1", kind: "SALE", gateway: "manual" }] } };
      }
      return {};
    },
    async mutate(name, doc, vars) {
      refundMutations.push({ name, doc, vars });
      return { refundCreate: { refund: { id: "gid://shopify/Refund/1" }, userErrors: [] } };
    },
  };
  const idmapR = openIdMap(path.join(dir, "state"));
  idmapR.set("orders", "501", "gid://shopify/Order/1");
  idmapR.flush();
  const refRes = await importRefunds({ ...baseCfg, options: { importRefunds: true } }, refundClient, idmapR);
  ok(refRes.imported === 1, `refunds: flag on creates refundCreate (got imported=${refRes.imported})`);
  ok(refundMutations[0]?.name === "refundCreate", "refunds: mutate name is refundCreate");
  ok(refundMutations[0]?.vars?.input?.transactions?.[0]?.amount === "50.00", "refunds: amount is abs of adapter total, not invented");
  ok(/@idempotent\(key: \$idempotencyKey\)/.test(REFUND_CREATE),
    "refunds: REFUND_CREATE document carries @idempotent (Admin GraphQL 2026-01; required 2026-04)");
  ok(/@idempotent\(key: \$idempotencyKey\)/.test(refundMutations[0]?.doc || ""),
    "refunds: mutate is called with the @idempotent document");
  ok(typeof refundMutations[0]?.vars?.idempotencyKey === "string" && refundMutations[0].vars.idempotencyKey.length >= 8,
    `refunds: mutate sends idempotencyKey (got ${JSON.stringify(refundMutations[0]?.vars?.idempotencyKey)})`);
  ok(refundMutations[0]?.vars?.idempotencyKey === refundIdempotencyKey("refund:501:9:gid://shopify/Order/1"),
    "refunds: idempotency key includes the landed order GID (post-wipe GIDs must not reuse the pre-wipe key)");
  ok(refundIdempotencyKey("refund:501:9:gid://shopify/Order/1") !== refundIdempotencyKey("refund:501:9:gid://shopify/Order/99"),
    "refunds: different order GIDs produce different idempotency keys");

  // Live 2026-07: Order.transactions is a connection `{ nodes: [...] }`. `.find` on that
  // object threw / missed SALE and recorded refunds 0/3 (dd-real-xl live matrix).
  mkdirSync(path.join(dir, "state-refund-conn"), { recursive: true });
  const refundConnMut = [];
  const refundConnClient = {
    async graphql(q) {
      if (q.includes("orderTransactions") || q.includes("transactions")) {
        return { order: { id: "gid://shopify/Order/2", transactions: { nodes: [{ id: "gid://shopify/OrderTransaction/9", kind: "SALE", gateway: "import" }] } } };
      }
      return {};
    },
    async mutate(name, _doc, vars) {
      refundConnMut.push({ name, vars });
      return { refundCreate: { refund: { id: "gid://shopify/Refund/2" }, userErrors: [] } };
    },
  };
  const idmapConn = openIdMap(path.join(dir, "state-refund-conn"));
  idmapConn.set("orders", "501", "gid://shopify/Order/2");
  idmapConn.flush();
  const refConn = await importRefunds({ ...baseCfg, options: { importRefunds: true } }, refundConnClient, idmapConn);
  ok(refConn.imported === 1, `refunds: connection-shaped transactions still refundCreate (imported=${refConn.imported} failed=${refConn.failed})`);
  ok(refundConnMut[0]?.vars?.input?.orderId === "gid://shopify/Order/2", "refunds: refundCreate orderId is the ledger GID");

  mkdirSync(path.join(dir, "state-refund-noparent"), { recursive: true });
  const idmapNoTx = openIdMap(path.join(dir, "state-refund-noparent"));
  idmapNoTx.set("orders", "501", "gid://shopify/Order/3");
  idmapNoTx.flush();
  const refNoTx = await importRefunds({
    ...baseCfg,
    paths: { ...baseCfg.paths, state: path.join(dir, "state-refund-noparent") },
    options: { importRefunds: true },
  }, {
    async graphql() { return { order: { id: "gid://shopify/Order/3", transactions: { nodes: [] } } }; },
    async mutate() { throw new Error("refundCreate should not run without a parent tx"); },
  }, idmapNoTx);
  ok(refNoTx.imported === 0 && refNoTx.failed === 0 && refNoTx.skipped === 1,
    `refunds: no SALE/CAPTURE is skipped not invented (imported=${refNoTx.imported} failed=${refNoTx.failed} skipped=${refNoTx.skipped})`);
  const refundFailFile = path.join(dir, "state-refund-noparent", "failed-refunds.jsonl");
  ok(!existsSync(refundFailFile) || !readFileSync(refundFailFile, "utf8").trim(),
    "refunds: missing parent capture does not write a failed ledger (verify/import stay green)");
  ok(/no SALE\/CAPTURE/i.test(JSON.stringify(refNoTx.skippedRows || [])),
    `refunds: skip row names missing parent capture (got ${JSON.stringify(refNoTx.skippedRows)})`);

  // B2B ON
  const b2bMut = [];
  const b2bClient = {
    async mutate(name, _d, vars) {
      b2bMut.push({ name, vars });
      if (name === "companyCreate") {
        return { company: { id: "gid://shopify/Company/1", locations: { nodes: [{ id: "gid://shopify/CompanyLocation/1" }] } } };
      }
      if (name === "catalogCreate") return { catalogCreate: { catalog: { id: "gid://shopify/CompanyLocationCatalog/1" } } };
      if (name === "priceListCreate") return { priceListCreate: { priceList: { id: "gid://shopify/PriceList/1" } } };
      if (name === "priceListFixedPricesAdd") return { priceListFixedPricesAdd: { prices: vars.prices, userErrors: [] } };
      throw new Error("unexpected " + name);
    },
  };
  const idmapB = openIdMap(path.join(dir, "state"));
  idmapB.set("products", "1", "gid://shopify/ProductVariant/100");
  idmapB.flush();
  const b2bRes = await importB2bPricing({ ...baseCfg, options: { importB2bPricing: true } }, b2bClient, idmapB);
  ok(b2bRes.imported === 1, `b2b: creates catalog for kundegruppe (imported=${b2bRes.imported})`);
  ok(b2bMut.some((m) => m.name === "catalogCreate"), "b2b: catalogCreate called");
  ok(b2bMut.some((m) => m.name === "priceListFixedPricesAdd"), "b2b: group prices attached to price list");
  ok(b2bMut.find((m) => m.name === "priceListFixedPricesAdd")?.vars?.prices?.[0]?.price?.amount === "150.00", "b2b: uses recorded group price, not public R42");
  const catInput = b2bMut.find((m) => m.name === "catalogCreate")?.vars?.input;
  ok(catInput?.context?.companyLocationIds?.length > 0, "b2b: catalogCreate sends required context.companyLocationIds (2026-01 CatalogCreateInput)");
  const plInput = b2bMut.find((m) => m.name === "priceListCreate")?.vars?.input;
  ok(plInput?.parent?.adjustment, "b2b: priceListCreate sends required parent.adjustment (2026-01 PriceListCreateInput)");

  // Live 0/2: companyCreate 2026-01 docs return locations.edges.node, not nodes.
  mkdirSync(path.join(dir, "state-b2b-edges"), { recursive: true });
  const b2bEdgeMut = [];
  const b2bEdgeClient = {
    async graphql(q) {
      if (String(q).includes("currencyCode")) return { shop: { currencyCode: "USD" } };
      return {};
    },
    async mutate(name, _d, vars) {
      b2bEdgeMut.push({ name, vars });
      if (name === "companyCreate") {
        return { company: { id: "gid://shopify/Company/9", locations: { edges: [{ node: { id: "gid://shopify/CompanyLocation/9" } }] } } };
      }
      if (name === "catalogCreate") return { catalogCreate: { catalog: { id: "gid://shopify/CompanyLocationCatalog/9" } } };
      if (name === "priceListCreate") return { priceListCreate: { priceList: { id: "gid://shopify/PriceList/9" } } };
      if (name === "priceListFixedPricesAdd") return { priceListFixedPricesAdd: { prices: vars.prices, userErrors: [] } };
      throw new Error("unexpected " + name);
    },
  };
  const idmapEdge = openIdMap(path.join(dir, "state-b2b-edges"));
  idmapEdge.set("products", "1", "gid://shopify/ProductVariant/100");
  idmapEdge.flush();
  const b2bEdge = await importB2bPricing({ ...baseCfg, paths: { ...baseCfg.paths, state: path.join(dir, "state-b2b-edges") }, options: { importB2bPricing: true, currency: "DKK" } }, b2bEdgeClient, idmapEdge);
  ok(b2bEdge.imported === 1, `b2b: edges-shaped company.locations still creates catalog (imported=${b2bEdge.imported} failed=${b2bEdge.failed})`);
  ok(b2bEdgeMut.find((m) => m.name === "catalogCreate")?.vars?.input?.context?.companyLocationIds?.[0] === "gid://shopify/CompanyLocation/9", "b2b: location id from locations.edges.node");
  ok(b2bEdgeMut.find((m) => m.name === "priceListCreate")?.vars?.input?.currency === "USD", "b2b: price list currency is shop currencyCode, not hardcoded DKK");

  mkdirSync(path.join(dir, "state-b2b-fail"), { recursive: true });
  const b2bFail = await importB2bPricing({
    ...baseCfg,
    paths: { ...baseCfg.paths, state: path.join(dir, "state-b2b-fail") },
    options: { importB2bPricing: true },
  }, {
    async mutate() {
      const err = new Error("companyCreate userErrors: [{\"message\":\"Currency DKK is not supported\"}]");
      err.userErrors = [{ message: "Currency DKK is not supported" }];
      throw err;
    },
  }, openIdMap(path.join(dir, "state-b2b-fail")));
  ok(b2bFail.failed >= 1, `b2b: non-capability userError increments failed (failed=${b2bFail.failed})`);
  const b2bFailFile = path.join(dir, "state-b2b-fail", "failed-b2b.jsonl");
  ok(existsSync(b2bFailFile), "b2b: writes state/failed-b2b.jsonl");
  const b2bFailRow = existsSync(b2bFailFile) ? JSON.parse(readFileSync(b2bFailFile, "utf8").trim().split("\n")[0]) : {};
  ok(/Currency DKK|userError/i.test(JSON.stringify(b2bFailRow)), `b2b: jsonl carries the GraphQL error (got ${JSON.stringify(b2bFailRow)})`);

  // Live: settings live in summary.json as customerGroups (5 rows); settings.json is absent.
  // Only DDSEED B2B (id 7) has _dd_group_discounts. Empty groups must not catalogCreate.
  mkdirSync(path.join(dir, "raw-b2b-sum"), { recursive: true });
  mkdirSync(path.join(dir, "state-b2b-sum"), { recursive: true });
  writeFileSync(path.join(dir, "raw-b2b-sum", "summary.json"), JSON.stringify({
    settings: { customerGroups: [
      { id: "1", title: "Kunder" },
      { id: "7", title: "DDSEED B2B" },
    ] },
  }));
  writeFileSync(path.join(dir, "raw-b2b-sum", "products.jsonl"), JSON.stringify({
    id: 626,
    meta_data: [{ key: "_dd_group_discounts", value: JSON.stringify([{ userId: "7", variantId: "0", price: "150.00" }]) }],
  }) + "\n");
  writeFileSync(path.join(dir, "raw-b2b-sum", "customers.jsonl"), "\n");
  const b2bSumMut = [];
  const b2bSumClient = {
    async mutate(name, _d, vars) {
      b2bSumMut.push({ name, vars });
      if (name === "companyCreate") {
        return { company: { id: "gid://shopify/Company/1", locations: { nodes: [{ id: "gid://shopify/CompanyLocation/1" }] } } };
      }
      if (name === "catalogCreate") return { catalogCreate: { catalog: { id: "gid://shopify/CompanyLocationCatalog/2" } } };
      if (name === "priceListCreate") return { priceListCreate: { priceList: { id: "gid://shopify/PriceList/2" } } };
      if (name === "priceListFixedPricesAdd") return { priceListFixedPricesAdd: { prices: vars.prices, userErrors: [] } };
      throw new Error("unexpected " + name);
    },
  };
  const idmapSum = openIdMap(path.join(dir, "state-b2b-sum"));
  idmapSum.set("products", "626", "gid://shopify/ProductVariant/626");
  idmapSum.flush();
  const b2bSum = await importB2bPricing({
    paths: { raw: path.join(dir, "raw-b2b-sum"), transformed: path.join(dir, "transformed"), state: path.join(dir, "state-b2b-sum") },
    options: { importB2bPricing: true, currency: "DKK" },
  }, b2bSumClient, idmapSum);
  ok(b2bSum.imported === 1, `b2b: summary.json customerGroups id 7 attaches (imported=${b2bSum.imported} failed=${b2bSum.failed})`);
  ok(b2bSumMut.filter((m) => m.name === "catalogCreate").length === 1, "b2b: only groups with _dd_group_discounts create catalogs");
  ok(b2bSum.pricesAttached === 1, `b2b: pricesAttached=${b2bSum.pricesAttached}`);

  mkdirSync(path.join(dir, "state-b2b-cap"), { recursive: true });
  const b2bCapMut = [];
  const b2bCap = await importB2bPricing({
    paths: { raw: path.join(dir, "raw-b2b-sum"), transformed: path.join(dir, "transformed"), state: path.join(dir, "state-b2b-cap") },
    options: { importB2bPricing: true, currency: "DKK" },
  }, {
    async mutate(name) {
      b2bCapMut.push(name);
      const err = new Error("GraphQL errors: [{\"message\":\"B2B is not enabled on this shop\"}]");
      throw err;
    },
  }, openIdMap(path.join(dir, "state-b2b-cap")));
  ok(b2bCap.capabilitySkip === true || b2bCap.shopCapability, `b2b: shop without B2B is capability skip not silent 0/N (got ${JSON.stringify(b2bCap)})`);
  ok(typeof (b2bCap.reason || b2bCap.note) === "string" && /B2B/i.test(b2bCap.reason || b2bCap.note || ""), "b2b: capability reason names B2B");

  // Live 2026-08-18: catalogCreate with companyLocationIds + ACTIVE is refused
  // (UNPERMITTED_ENTITLEMENTS_DIRECT_CATALOG_ASSIGNMENT). Doctor "plan ok"
  // (Plus / partnerDevelopment) is not this entitlement. Public R42 unchanged.
  mkdirSync(path.join(dir, "state-b2b-entitlement"), { recursive: true });
  const entitlementErr = new Error("catalogCreate userErrors: [{\"field\":[\"input\",\"context\"],\"message\":\"Catalogs assigned to company locations can't be set to active with your plan.\",\"code\":\"UNPERMITTED_ENTITLEMENTS_DIRECT_CATALOG_ASSIGNMENT\"}]");
  entitlementErr.userErrors = [{ field: ["input", "context"], message: "Catalogs assigned to company locations can't be set to active with your plan.", code: "UNPERMITTED_ENTITLEMENTS_DIRECT_CATALOG_ASSIGNMENT" }];
  const b2bEntMut = [];
  const b2bEnt = await importB2bPricing({
    ...baseCfg,
    paths: { ...baseCfg.paths, state: path.join(dir, "state-b2b-entitlement") },
    options: { importB2bPricing: true },
  }, {
    async mutate(name) {
      b2bEntMut.push(name);
      if (name === "companyCreate") {
        return { company: { id: "gid://shopify/Company/8", locations: { nodes: [{ id: "gid://shopify/CompanyLocation/8" }] } } };
      }
      if (name === "catalogCreate") throw entitlementErr;
      throw new Error("unexpected " + name);
    },
  }, openIdMap(path.join(dir, "state-b2b-entitlement")));
  ok(b2bEnt.capabilitySkip === true && b2bEnt.failed === 0,
    `b2b: company-location catalog entitlement is capability skip not failed (got ${JSON.stringify(b2bEnt)})`);
  ok(b2bEnt.imported === 0 && b2bEnt.pricesAttached === 0, "b2b: entitlement skip attaches no prices");
  ok(/UNPERMITTED_ENTITLEMENTS_DIRECT_CATALOG_ASSIGNMENT|can't be set to active with your plan/i.test(b2bEnt.reason || ""),
    `b2b: capability reason keeps the shop error (got ${b2bEnt.reason})`);
  ok(!existsSync(path.join(dir, "state-b2b-entitlement", "failed-b2b.jsonl")),
    "b2b: entitlement skip does not write failed-b2b.jsonl");
  ok(b2bEntMut.includes("catalogCreate") && !b2bEntMut.includes("priceListCreate"),
    "b2b: entitlement skip stops at catalogCreate");

  // Live: wipe does not delete B2B companies; ledger is cleared; second companyCreate
  // collides on externalId (groups 4 and 13). Lookup and reuse, then attach prices.
  mkdirSync(path.join(dir, "state-b2b-taken"), { recursive: true });
  const takenErr = new Error("companyCreate userErrors: [{\"field\":[\"input\",\"company\",\"externalId\"],\"message\":\"External id has already been taken.\",\"code\":\"TAKEN\"}]");
  takenErr.userErrors = [{ field: ["input", "company", "externalId"], message: "External id has already been taken.", code: "TAKEN" }];
  const b2bTakenMut = [];
  const b2bTakenGql = [];
  const b2bTakenClient = {
    async graphql(q, vars) {
      b2bTakenGql.push({ q: String(q), vars });
      if (String(q).includes("currencyCode")) return { shop: { currencyCode: "DKK" } };
      if (String(q).includes("companies")) {
        return {
          companies: {
            nodes: [{
              id: "gid://shopify/Company/40",
              name: "DD 4",
              externalId: "dd-group-4",
              locations: { nodes: [{ id: "gid://shopify/CompanyLocation/40" }] },
            }],
          },
        };
      }
      return {};
    },
    async mutate(name, _d, vars) {
      b2bTakenMut.push({ name, vars });
      if (name === "companyCreate") throw takenErr;
      if (name === "catalogCreate") return { catalogCreate: { catalog: { id: "gid://shopify/CompanyLocationCatalog/40" } } };
      if (name === "priceListCreate") return { priceListCreate: { priceList: { id: "gid://shopify/PriceList/40" } } };
      if (name === "priceListFixedPricesAdd") return { priceListFixedPricesAdd: { prices: vars.prices, userErrors: [] } };
      throw new Error("unexpected " + name);
    },
  };
  const idmapTaken = openIdMap(path.join(dir, "state-b2b-taken"));
  idmapTaken.set("products", "1", "gid://shopify/ProductVariant/100");
  idmapTaken.flush();
  const b2bTaken = await importB2bPricing({
    ...baseCfg,
    paths: { ...baseCfg.paths, state: path.join(dir, "state-b2b-taken") },
    options: { importB2bPricing: true, currency: "DKK" },
  }, b2bTakenClient, idmapTaken);
  ok(b2bTaken.imported === 1 && b2bTaken.failed === 0,
    `b2b: TAKEN reuses company (imported=${b2bTaken.imported} failed=${b2bTaken.failed})`);
  ok(b2bTakenGql.some((g) => /companies/.test(g.q)), "b2b: lookup companies after TAKEN");
  ok(b2bTakenGql.some((g) => /external_id|dd-group-4/.test(JSON.stringify(g.vars || g.q))),
    "b2b: companies query filters by externalId");
  ok(b2bTakenMut.find((m) => m.name === "catalogCreate")?.vars?.input?.context?.companyLocationIds?.[0] === "gid://shopify/CompanyLocation/40",
    "b2b: reused company location after TAKEN");
  ok(b2bTakenMut.find((m) => m.name === "priceListFixedPricesAdd")?.vars?.prices?.[0]?.price?.amount === "150.00",
    "b2b: TAKEN reuse attaches group 150, not public R42");
  ok(!b2bTaken.capabilitySkip, "b2b: TAKEN with a found company is not a capability skip");

  mkdirSync(path.join(dir, "state-b2b-taken-miss"), { recursive: true });
  const b2bMiss = await importB2bPricing({
    ...baseCfg,
    paths: { ...baseCfg.paths, state: path.join(dir, "state-b2b-taken-miss") },
    options: { importB2bPricing: true },
  }, {
    async graphql(q) {
      if (String(q).includes("companies")) return { companies: { nodes: [] } };
      return { shop: { currencyCode: "DKK" } };
    },
    async mutate() { throw takenErr; },
  }, openIdMap(path.join(dir, "state-b2b-taken-miss")));
  ok(b2bMiss.failed >= 1 && b2bMiss.imported === 0,
    `b2b: TAKEN with no lookup match stays failed (imported=${b2bMiss.imported} failed=${b2bMiss.failed})`);
  const missFile = path.join(dir, "state-b2b-taken-miss", "failed-b2b.jsonl");
  ok(existsSync(missFile), "b2b: TAKEN miss writes failed-b2b.jsonl");
  const missRow = existsSync(missFile) ? JSON.parse(readFileSync(missFile, "utf8").trim().split("\n")[0]) : {};
  ok(/TAKEN|already been taken/i.test(JSON.stringify(missRow)),
    `b2b: jsonl keeps the TAKEN error (got ${JSON.stringify(missRow)})`);

  // Gift cards ON + CSV
  const gcMut = [];
  const gcClient = {
    async mutate(name, _d, vars) {
      gcMut.push({ name, vars });
      return { giftCardCreate: { giftCard: { id: "gid://shopify/GiftCard/1" } } };
    },
  };
  const gcRes = await importGiftCards({ ...baseCfg, options: { importGiftCards: true } }, gcClient, openIdMap(path.join(dir, "state")));
  ok(gcRes.imported === 1, "gift cards: CSV path creates giftCardCreate");
  ok(gcMut[0]?.vars?.input?.initialValue === "100.00", "gift cards: initialValue from CSV");

  // Gift cards ON, no CSV → manual signal (F24 honest)
  const emptyDir = path.join(dir, "empty-gc");
  mkdirSync(path.join(emptyDir, "transformed"), { recursive: true });
  mkdirSync(path.join(emptyDir, "raw"), { recursive: true });
  mkdirSync(path.join(emptyDir, "state"), { recursive: true });
  const gcManual = await importGiftCards({
    paths: { raw: path.join(emptyDir, "raw"), transformed: path.join(emptyDir, "transformed"), state: path.join(emptyDir, "state") },
    options: { importGiftCards: true },
  }, { async mutate() { throw new Error("should not call"); } }, openIdMap(path.join(emptyDir, "state")));
  ok(gcManual.code === "GIFT_CARDS_MANUAL", "gift cards: no CSV → GIFT_CARDS_MANUAL (no invented GraphQL schema)");

  // Repo fixture (Task 9) — load this file as well as the temp CSV above
  const fixturePath = path.join(ROOT, "fixtures", "dandomain", "gift-cards.csv");
  ok(existsSync(fixturePath), "gift-cards.csv fixture exists");
  const fixtureCsv = existsSync(fixturePath) ? readFileSync(fixturePath, "utf8") : "";
  ok(/initial_value/.test(fixtureCsv), "fixture has initial_value header");
  const fixtureDir = path.join(dir, "gc-fixture");
  mkdirSync(path.join(fixtureDir, "transformed"), { recursive: true });
  mkdirSync(path.join(fixtureDir, "raw"), { recursive: true });
  mkdirSync(path.join(fixtureDir, "state"), { recursive: true });
  const gcFixMut = [];
  const gcFixClient = {
    async mutate(name, _d, vars) {
      gcFixMut.push({ name, vars });
      return { giftCardCreate: { giftCard: { id: "gid://shopify/GiftCard/2" } } };
    },
  };
  const gcFixRes = await importGiftCards({
    paths: { raw: path.join(fixtureDir, "raw"), transformed: path.join(fixtureDir, "transformed"), state: path.join(fixtureDir, "state") },
    options: { importGiftCards: true, giftCardsCsv: fixturePath },
  }, gcFixClient, openIdMap(path.join(fixtureDir, "state")));
  ok(gcFixRes.imported === 1, "gift cards: fixture CSV creates giftCardCreate");
  ok(gcFixMut[0]?.vars?.input?.code === "DDSEED-GC-100", "gift cards: fixture code");
  ok(gcFixMut[0]?.vars?.input?.initialValue === "100.00", "gift cards: fixture initialValue");

  mkdirSync(path.join(dir, "state-gc-taken"), { recursive: true });
  const gcTakenClient = {
    async graphql(q) {
      if (String(q).includes("giftCards") || String(q).includes("code:")) {
        return { giftCards: { nodes: [{ id: "gid://shopify/GiftCard/99" }] } };
      }
      return {};
    },
    async mutate() {
      const err = new Error("giftCardCreate userErrors: [{\"message\":\"Gift card code already exists.\",\"code\":\"TAKEN\"}]");
      err.userErrors = [{ message: "Gift card code already exists.", code: "TAKEN" }];
      throw err;
    },
  };
  const gcTaken = await importGiftCards({
    ...baseCfg,
    paths: { ...baseCfg.paths, state: path.join(dir, "state-gc-taken") },
    options: { importGiftCards: true, giftCardsCsv: fixturePath },
  }, gcTakenClient, openIdMap(path.join(dir, "state-gc-taken")));
  ok(gcTaken.imported === 1 && gcTaken.failed === 0, `gift cards: code collision ledgers existing card (imported=${gcTaken.imported} failed=${gcTaken.failed})`);

  mkdirSync(path.join(dir, "state-gc-fail"), { recursive: true });
  const gcFail = await importGiftCards({
    ...baseCfg,
    paths: { ...baseCfg.paths, state: path.join(dir, "state-gc-fail") },
    options: { importGiftCards: true, giftCardsCsv: fixturePath },
  }, {
    async mutate() {
      const err = new Error("giftCardCreate userErrors: [{\"message\":\"Amount exceeds maximum\"}]");
      err.userErrors = [{ message: "Amount exceeds maximum" }];
      throw err;
    },
  }, openIdMap(path.join(dir, "state-gc-fail")));
  ok(gcFail.failed === 1, `gift cards: other userError increments failed (failed=${gcFail.failed})`);
  const gcFailFile = path.join(dir, "state-gc-fail", "failed-gift-cards.jsonl");
  ok(existsSync(gcFailFile), "gift cards: writes state/failed-gift-cards.jsonl");
  const gcFailRow = existsSync(gcFailFile) ? JSON.parse(readFileSync(gcFailFile, "utf8").trim().split("\n")[0]) : {};
  ok(/exceeds maximum/i.test(JSON.stringify(gcFailRow)), `gift cards: jsonl carries userError (got ${JSON.stringify(gcFailRow)})`);

  // Translations ON
  const trMut = [];
  const trClient = {
    async mutate(name, _d, vars) {
      trMut.push({ name, vars });
      return { translationsRegister: { translations: [{ key: "title" }], userErrors: [] } };
    },
  };
  const trRes = await importTranslations({ ...baseCfg, options: { importTranslations: true } }, trClient, openIdMap(path.join(dir, "state")));
  ok(trRes.imported === 1, "translations: registers from translations.jsonl");
  ok(trMut[0]?.name === "translationsRegister", "translations: mutate name");

  mkdirSync(path.join(dir, "transformed-nodigest"), { recursive: true });
  mkdirSync(path.join(dir, "state-nodigest"), { recursive: true });
  writeFileSync(path.join(dir, "transformed-nodigest", "translations.jsonl"), JSON.stringify({
    resourceId: "gid://shopify/Product/1", locale: "en", key: "title", value: "Apple",
  }) + "\n");
  const skipMut = [];
  const skipGql = [];
  const skipRes = await importTranslations({
    paths: { raw: path.join(dir, "raw"), transformed: path.join(dir, "transformed-nodigest"), state: path.join(dir, "state-nodigest") },
    options: { importTranslations: true },
  }, {
    async graphql(_q, vars) {
      skipGql.push(vars);
      if (String(_q).includes("shopLocales")) return { shopLocales: [{ locale: "en", primary: false, published: true }] };
      return {
        translatableResource: {
          resourceId: vars.resourceId,
          translatableContent: [
            { key: "title", digest: "abc123digest", locale: "da" },
          ],
        },
      };
    },
    async mutate(name, _d, vars) {
      skipMut.push({ name, vars });
      return { translationsRegister: { translations: [{ key: "title" }], userErrors: [] } };
    },
  }, openIdMap(path.join(dir, "state-nodigest")));
  ok(skipRes.imported === 1, "translations: digest-less jsonl fetches translatableContentDigest then registers");
  ok(skipGql.length >= 1, "translations: graphql digest query ran");
  ok(skipMut[0]?.vars?.translations?.[0]?.translatableContentDigest === "abc123digest", "translations: digest from Shopify query");

  // Live 0/7: shop primary is da; UK layer maps to locale "en" which is not enabled.
  mkdirSync(path.join(dir, "transformed-locale"), { recursive: true });
  mkdirSync(path.join(dir, "state-locale"), { recursive: true });
  writeFileSync(path.join(dir, "transformed-locale", "translations.jsonl"), JSON.stringify({
    resourceId: "gid://shopify/Product/9", locale: "en", key: "title", value: "Grey wool throw", digest: "digest9",
  }) + "\n");
  const locGql = [];
  const locMut = [];
  const locRes = await importTranslations({
    paths: { raw: path.join(dir, "raw"), transformed: path.join(dir, "transformed-locale"), state: path.join(dir, "state-locale") },
    options: { importTranslations: true },
  }, {
    async graphql(q) {
      locGql.push(q);
      if (q.includes("shopLocales")) return { shopLocales: [{ locale: "da", primary: true, published: true }] };
      return { translatableResource: { translatableContent: [{ key: "title", digest: "digest9", locale: "da" }] } };
    },
    async mutate(name, _d, vars) {
      locMut.push({ name, vars });
      if (name === "shopLocaleEnable") return { shopLocaleEnable: { shopLocale: { locale: "en", published: false }, userErrors: [] } };
      return { translationsRegister: { translations: [{ key: "title" }], userErrors: [] } };
    },
  }, openIdMap(path.join(dir, "state-locale")));
  ok(locRes.imported === 1, `translations: enables missing locale then registers (imported=${locRes.imported} failed=${locRes.failed})`);
  ok(locMut.some((m) => m.name === "shopLocaleEnable" && m.vars?.locale === "en"), "translations: shopLocaleEnable(en) before translationsRegister");
  ok(locMut.some((m) => m.name === "shopLocaleUpdate" && m.vars?.shopLocale?.published === true), "translations: shopLocaleUpdate publishes enabled locale");
  ok(locMut.some((m) => m.name === "translationsRegister"), "translations: translationsRegister after locale enable");

  mkdirSync(path.join(dir, "state-locale-fail"), { recursive: true });
  mkdirSync(path.join(dir, "transformed-locale-fail"), { recursive: true });
  writeFileSync(path.join(dir, "transformed-locale-fail", "translations.jsonl"), JSON.stringify({
    resourceId: "gid://shopify/Product/9", locale: "en", key: "title", value: "Grey wool throw", digest: "digest9",
  }) + "\n");
  const locFail = await importTranslations({
    paths: { raw: path.join(dir, "raw"), transformed: path.join(dir, "transformed-locale-fail"), state: path.join(dir, "state-locale-fail") },
    options: { importTranslations: true },
  }, {
    async graphql(q) {
      if (String(q).includes("shopLocales")) return { shopLocales: [{ locale: "da", primary: true, published: true }] };
      return { translatableResource: { translatableContent: [{ key: "title", digest: "digest9", locale: "da" }] } };
    },
    async mutate(name) {
      if (name === "shopLocaleEnable") {
        const err = new Error("shopLocaleEnable userErrors: [{\"message\":\"Locale is not supported\"}]");
        err.userErrors = [{ message: "Locale is not supported" }];
        throw err;
      }
      throw new Error("translationsRegister should not run when locale enable failed");
    },
  }, openIdMap(path.join(dir, "state-locale-fail")));
  ok(locFail.imported === 0 && locFail.failed >= 1, `translations: locale enable failure is failed not silent skip (imported=${locFail.imported} failed=${locFail.failed})`);
  const trFailFile = path.join(dir, "state-locale-fail", "failed-translations.jsonl");
  ok(existsSync(trFailFile), "translations: writes state/failed-translations.jsonl");
  const trFailRow = existsSync(trFailFile) ? JSON.parse(readFileSync(trFailFile, "utf8").trim().split("\n")[0]) : {};
  ok(/Locale is not supported|TRANSLATION_LOCALE/i.test(JSON.stringify(trFailRow)), `translations: jsonl names locale skip (got ${JSON.stringify(trFailRow)})`);

  // Live: Shopify primary is already `en`. UK layer maps to locale `en`.
  // translationsRegister rejects "Locale cannot be the same as the shop's primary locale".
  mkdirSync(path.join(dir, "transformed-primary"), { recursive: true });
  mkdirSync(path.join(dir, "state-primary"), { recursive: true });
  writeFileSync(path.join(dir, "transformed-primary", "translations.jsonl"),
    JSON.stringify({ resourceId: "gid://shopify/Product/1", locale: "en", key: "title", value: "Grey wool throw", digest: "d1" }) + "\n" +
    JSON.stringify({ resourceId: "gid://shopify/Product/1", locale: "en", key: "body_html", value: "<p>Grey wool throw</p>", digest: "d2" }) + "\n");
  const primaryMut = [];
  const primaryRes = await importTranslations({
    paths: { raw: path.join(dir, "raw"), transformed: path.join(dir, "transformed-primary"), state: path.join(dir, "state-primary") },
    options: { importTranslations: true },
  }, {
    async graphql(q) {
      if (String(q).includes("shopLocales")) return { shopLocales: [{ locale: "en", primary: true, published: true }] };
      return { translatableResource: { translatableContent: [{ key: "title", digest: "d1" }] } };
    },
    async mutate(name, _d, vars) {
      primaryMut.push({ name, vars });
      return { translationsRegister: { translations: [], userErrors: [] } };
    },
  }, openIdMap(path.join(dir, "state-primary")));
  ok(primaryRes.imported === 0 && primaryRes.failed === 0 && primaryRes.skipped === 2,
    `translations: shop primary locale en skips en rows (imported=${primaryRes.imported} failed=${primaryRes.failed} skipped=${primaryRes.skipped})`);
  ok(primaryRes.code === "TRANSLATION_LOCALE", `translations: primary-locale skip is named TRANSLATION_LOCALE (got ${primaryRes.code})`);
  ok(!primaryMut.some((m) => m.name === "translationsRegister"), "translations: does not register into the shop primary locale");
  ok(!primaryMut.some((m) => m.name === "shopLocaleEnable"), "translations: does not enable or change the shop primary locale");
  ok(!existsSync(path.join(dir, "state-primary", "failed-translations.jsonl")), "translations: primary-locale skip is not a failed jsonl row");

  mkdirSync(path.join(dir, "transformed-primary-da"), { recursive: true });
  mkdirSync(path.join(dir, "state-primary-da"), { recursive: true });
  writeFileSync(path.join(dir, "transformed-primary-da", "translations.jsonl"),
    JSON.stringify({ resourceId: "gid://shopify/Product/2", locale: "da", key: "title", value: "Gråt uldplaid", digest: "da1" }) + "\n" +
    JSON.stringify({ resourceId: "gid://shopify/Product/2", locale: "en", key: "title", value: "Grey wool throw", digest: "en1" }) + "\n");
  const daPrimaryMut = [];
  const daPrimaryRes = await importTranslations({
    paths: { raw: path.join(dir, "raw"), transformed: path.join(dir, "transformed-primary-da"), state: path.join(dir, "state-primary-da") },
    options: { importTranslations: true },
  }, {
    async graphql(q) {
      if (String(q).includes("shopLocales")) return { shopLocales: [{ locale: "da", primary: true, published: true }] };
      return { translatableResource: { translatableContent: [{ key: "title", digest: "en1" }] } };
    },
    async mutate(name, _d, vars) {
      daPrimaryMut.push({ name, vars });
      if (name === "shopLocaleEnable") return { shopLocaleEnable: { shopLocale: { locale: "en", published: false }, userErrors: [] } };
      return { translationsRegister: { translations: [{ key: "title" }], userErrors: [] } };
    },
  }, openIdMap(path.join(dir, "state-primary-da")));
  ok(daPrimaryRes.imported === 1 && daPrimaryRes.failed === 0 && daPrimaryRes.skipped === 1,
    `translations: shop primary da skips da rows and registers en (imported=${daPrimaryRes.imported} failed=${daPrimaryRes.failed} skipped=${daPrimaryRes.skipped})`);
  ok(daPrimaryMut.some((m) => m.name === "shopLocaleEnable" && m.vars?.locale === "en"), "translations: enables en when shop primary is da");
  ok(daPrimaryMut.some((m) => m.name === "translationsRegister" && m.vars?.translations?.every((t) => t.locale === "en")),
    "translations: translationsRegister payload is en only when shop primary is da");

  mkdirSync(path.join(dir, "transformed-nokey"), { recursive: true });
  mkdirSync(path.join(dir, "state-nokey"), { recursive: true });
  writeFileSync(path.join(dir, "transformed-nokey", "translations.jsonl"), JSON.stringify({
    resourceId: "gid://shopify/Product/2", locale: "en", key: "title", value: "Pear",
  }) + "\n");
  const missMut = [];
  const missRes = await importTranslations({
    paths: { raw: path.join(dir, "raw"), transformed: path.join(dir, "transformed-nokey"), state: path.join(dir, "state-nokey") },
    options: { importTranslations: true },
  }, {
    async graphql(q) {
      if (String(q).includes("shopLocales")) return { shopLocales: [{ locale: "en", primary: false, published: true }] };
      return {
        translatableResource: {
          resourceId: "gid://shopify/Product/2",
          translatableContent: [
            { key: "body_html", digest: "otherdigest", locale: "da" },
          ],
        },
      };
    },
    async mutate() { missMut.push(1); return { translationsRegister: { translations: [], userErrors: [] } }; },
  }, openIdMap(path.join(dir, "state-nokey")));
  ok(missRes.imported === 0 && missMut.length === 0, "translations: missing Shopify key skips, no invented digest");

  rmSync(dir, { recursive: true, force: true });
}

// HANDLE_COLLISION overwrite: transform warns, sequential productSet last-writer-wins.
// Bulk productSet returns HANDLE_NOT_UNIQUE on the later row. Collapse pending by handle
// before bulk so WP semantics hold above productsBulkThreshold (plan Task 4 Branch A).
console.log("— duplicate product handles collapse to last writer before bulk —");
{
  const { collapsePendingByHandle } = await import("../src/import/products.js");
  const dupA = { input: { handle: "scale-probe-dup", title: "SCALE A", variants: [{ price: "10.00" }] } };
  const dupB = { input: { handle: "scale-probe-dup", title: "SCALE B last writer", variants: [{ price: "11.00" }] } };
  const pendingUnique = collapsePendingByHandle([dupA, dupB]);
  ok(pendingUnique.length === 1, "duplicate handles collapse to one line before bulk");
  ok(pendingUnique[0].input.title === "SCALE B last writer", "last writer wins (WP HANDLE_COLLISION overwrite)");
  ok(pendingUnique[0].input.variants[0].price === "11.00", "last writer's price is the one sent");
  ok(collapsePendingByHandle([dupA]).length === 1, "a unique handle is unchanged");
}

{
  const { pendingNotInLedger } = await import("../src/import/products.js");
  const { leftoverStoreCounts, wipeStoreEmpty } = await import("../src/stages/wipe.js");
  const dir = path.join(ROOT, "data-test-adopt-handle");
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  const idmap = openIdMap(dir);
  idmap.set("products", "eksempel-pa-produkt-2", "gid://shopify/Product/leftover");
  const pending = [
    { input: { handle: "eksempel-pa-produkt-2" } },
    { input: { handle: "brand-new-handle" } },
  ];
  ok(pendingNotInLedger(pending, idmap).map((l) => l.input.handle).join() === "brand-new-handle",
    "HANDLE_NOT_UNIQUE that the catalog sweep ledgered is not a product failure");
  ok(wipeStoreEmpty({ products: 0, orders: 0, customers: 0, collections: 0 }), "wipe is complete when QUERY_COUNTS leftovers are 0");
  ok(!wipeStoreEmpty({ products: 346, orders: 0, customers: 7, collections: 9 }), "wipe is incomplete when products remain");
  ok(leftoverStoreCounts({ productsCount: { count: 2 }, ordersCount: { count: 0 }, customersCount: { count: 1 }, collectionsCount: { count: 0 } }).products === 2,
    "leftoverStoreCounts reads QUERY_COUNTS shape");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
