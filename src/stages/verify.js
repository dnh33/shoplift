import path from "node:path";
import { readJson, readJsonl, writeJson } from "../util/fsx.js";
import { createShopifyClient } from "../shopify/client.js";
import { requireShopify } from "../config.js";
import { QUERY_COUNTS, QUERY_VARIANT_BY_SKU, QUERY_PRODUCTS_BY_TAG } from "../shopify/mutations.js";
import { openIdMap } from "../util/idmap.js";
import { c, chip, section, kv, verdict } from "../ui.js";
import { formatActionCodes } from "../util/machine.js";
import { log } from "../log.js";

/**
 * Stage 4 — VERIFY (post-import reconciliation)
 *  1. count comparison: source snapshot vs Shopify live counts
 *  2. price spot-check: N random SKUs compared source vs Shopify
 *  3. failure roll-up from data/state/failed-*.jsonl
 *  4. warning roll-up from the transform stage
 * Writes data/verify-report.json and prints a summary.
 */
export async function runVerify(cfg, { samples = 10 } = {}) {
  const client = createShopifyClient(requireShopify(cfg));
  const rawSummary = readJson(path.join(cfg.paths.raw, "summary.json"), { counts: {} });
  const importReport = readJson(path.join(cfg.paths.state, "import-report.json"), { results: {} });
  const report = { verifiedAt: new Date().toISOString(), counts: {}, spotChecks: [], failures: {}, warnings: 0, ok: true };

  const productIdTag = rawSummary.settings?.provenance?.productIdTag || "wp-id-";
  const notes = verifyNotes(productIdTag);

  // 1 — counts
  const live = await client.graphql(QUERY_COUNTS);
  report.counts = {
    products: { source: rawSummary.counts.products ?? null, shopify: live.productsCount?.count ?? null, note: notes.products },
    customers: { source: rawSummary.counts.customers ?? null, shopify: live.customersCount?.count ?? null, note: notes.customers },
    orders: { source: rawSummary.counts.orders ?? null, shopify: live.ordersCount?.count ?? null, note: notes.orders },
    collections: { source: rawSummary.counts.categories ?? null, shopify: live.collectionsCount?.count ?? null, note: notes.collections }
  };

  // 1b — dirty-target detection: the target holding MORE than this source
  // provides means residue from a previous dataset (or another source) —
  // "OK" would be a lie. Fewer-than-source has legitimate explanations;
  // more-than-source never does within a single pair.
  // three-way: source (this dataset) vs ledger (what THIS pair created) vs
  // store (everything). store > max(source, ledger) = items we can't account
  // for — residue from a previous dataset or another source.
  const led = openIdMap(cfg.paths.state);
  report.counts.products.ledger = led.count("products");
  report.counts.orders.ledger = led.count("orders");
  report.counts.customers.ledger = led.count("customers");
  const dirty = [];   // store > source AND > ledger: items nobody accounts for (another source / manual)
  const stale = [];   // ledger > source: THIS pair created them from a PREVIOUS dataset — gone from WP now
  for (const k of ["products", "orders"]) {
    const v = report.counts[k];
    if (v.shopify !== null && Number(v.shopify) > Math.max(Number(v.source ?? 0), Number(v.ledger ?? 0))) dirty.push(k);
    if (v.ledger !== undefined && v.source !== null && Number(v.ledger) > Number(v.source)) stale.push(`${k} (+${v.ledger - v.source})`);
  }
  if (dirty.length) { report.ok = false; report.dirtyTarget = dirty; }
  if (stale.length) { report.ok = false; report.staleTarget = stale; }

  // 2 — price spot checks on random SKUs; DanDomain falls back to dd-id- when SKU is absent
  const products = readJsonl(path.join(cfg.paths.transformed, "products.jsonl"));
  const { skuPrices, tagPrices } = collectSpotChecks(products, { productIdTag });
  for (const pick of [...shuffle(skuPrices), ...shuffle(tagPrices)].slice(0, samples)) {
    try {
      if (pick.via === "tag") {
        const data = await client.graphql(QUERY_PRODUCTS_BY_TAG, { q: `tag:'${String(pick.tag).replace(/'/g, "\\'")}'` });
        const node = data.products?.nodes?.[0];
        const actual = node?.variants?.nodes?.[0]?.price;
        const match = actual != null && Number(actual) === Number(pick.price);
        report.spotChecks.push({ tag: pick.tag, expected: pick.price, actual: actual ?? "NOT FOUND", ok: Boolean(match) });
        if (!match) report.ok = false;
        continue;
      }
      const data = await client.graphql(QUERY_VARIANT_BY_SKU, { q: `sku:"${pick.sku.replace(/"/g, '\\"')}"` });
      const node = data.productVariants?.nodes?.find((n) => n.sku === pick.sku);
      const match = node && Number(node.price) === Number(pick.price);
      report.spotChecks.push({ sku: pick.sku, expected: pick.price, actual: node?.price ?? "NOT FOUND", ok: Boolean(match) });
      if (!match) report.ok = false;
    } catch (e) {
      report.spotChecks.push({ sku: pick.sku, tag: pick.tag, error: e.message.slice(0, 120), ok: false });
      report.ok = false;
    }
  }

  // 3 — failures
  for (const entity of ["products", "customers", "orders", "discounts", "content"]) {
    const rows = readJsonl(path.join(cfg.paths.state, `failed-${entity}.jsonl`));
    if (rows.length) { report.failures[entity] = rows.length; report.ok = false; }
  }

  // 4 — warnings: only ACTION items count against a clean migration.
  //
  // Deliberately these do NOT set report.ok = false. An action item needs a
  // HUMAN, not a retry — every real store has some (zero-price items, digital
  // downloads) and failing on them would cry wolf and break the exit taxonomy.
  //
  // But "not a failure" is not "not worth saying". This report was returning
  // ok:true, and the MCP summary was rendering it as "counts reconciled,
  // spot-checks passed", over a store with a product that would sell for FREE
  // (D15). The verdict was right and the message was misleading. So the report
  // carries its own punch list: WHICH kinds of attention, not just how many.
  // Codes and counts only — the message text lives in migration_status and
  // warnings.jsonl, and duplicating it here would be a second copy to drift.
  const allWarnings = readJsonl(path.join(cfg.paths.transformed, "warnings.jsonl"));
  const actionWarnings = allWarnings.filter((w) => (w.severity || "action") === "action");
  report.warnings = actionWarnings.length;
  report.notes = allWarnings.length - report.warnings;
  report.actionCodes = {};
  for (const w of actionWarnings) report.actionCodes[w.code] = (report.actionCodes[w.code] || 0) + 1;
  const composedRedirects = readJson(path.join(cfg.paths.transformed, "redirects.json"), []);
  report.redirects = { composed: Array.isArray(composedRedirects) ? composedRedirects.length : 0, note: "composed old paths; live 301 hop is P5" };

  writeJson(path.join(cfg.paths.data, "verify-report.json"), report);

  console.log(section("verify"));
  for (const [k, v] of Object.entries(report.counts)) {
    const match = v.source !== null && v.shopify !== null && Number(v.source) === Number(v.shopify);
    const mark = match ? chip.ok() : chip.warn();
    const note = v.note && !match ? c.dim(`  (${v.note})`) : "";
    const ledgerNote = v.ledger !== undefined ? c.dim(c.muted(` · ledger ${v.ledger}`)) : "";
    console.log(`  ${mark} ${c.gray(k.padEnd(12))} ${c.white(v.source ?? "-")} ${c.dim("source")} ${chip.arrow()} ${c.white(v.shopify ?? "-")} ${c.dim("shopify")}${ledgerNote}${note}`);
  }
  const okChecks = report.spotChecks.filter((s) => s.ok).length;
  const spotLabel = tagPrices.length ? "random SKU/tag prices match" : "random SKU prices match";
  console.log(`  ${okChecks === report.spotChecks.length ? chip.ok() : chip.fail()} ${c.gray("spot checks".padEnd(12))} ${c.white(`${okChecks}/${report.spotChecks.length}`)} ${c.dim(spotLabel)}`);
  const failEntries = Object.entries(report.failures);
  console.log(`  ${failEntries.length ? chip.fail() : chip.ok()} ${c.gray("failures".padEnd(12))} ${failEntries.length ? c.red(JSON.stringify(report.failures)) : c.white("none")}`);
  console.log(`  ${report.warnings ? chip.warn() : chip.ok()} ${c.gray("actions".padEnd(12))} ${c.white(report.warnings)} ${c.dim(`need a human${report.notes ? ` (+${report.notes} auto-handled/info notes)` : ""}`)}`);
  if (report.warnings) {
    console.log(`  ${c.gray("".padEnd(14))}${c.dim(formatActionCodes(report.actionCodes))}`);
    console.log(`  ${c.gray("".padEnd(14))}${c.muted("full list: node src/cli.js status --json (add --verbose for the message text)")}`);
  }
  if (report.dirtyTarget) {
    console.log(`\n  ${chip.warn()} ${c.warn(`target holds ${report.dirtyTarget.join("/")} that neither this source nor this tool's ledger accounts for — foreign data.`)}`);
    console.log(`  ${c.muted("expected if the store intentionally has other data; otherwise reset it:")} ${c.key("menu [x] / node src/cli.js wipe")}`);
  }
  if (report.staleTarget) {
    console.log(`\n  ${chip.warn()} ${c.warn(`stale: ledger holds ${report.staleTarget.join(", ")} the CURRENT source doesn't provide — ${notes.stale}`)}`);
    console.log(`  ${c.muted(notes.staleHint)}`);
  }
  // "VERIFY OK" alone reads as "nothing left to do". It means the migration
  // LANDED; it never meant the catalogue is fit to sell. Say both.
  const okLabel = report.warnings ? `VERIFY OK — ${report.warnings} NEED A HUMAN BEFORE GO-LIVE` : "VERIFY OK";
  console.log(`\n  ${verdict(report.ok, report.ok ? okLabel : report.dirtyTarget ? "TARGET DIRTY" : report.staleTarget ? "TARGET STALE" : "NEEDS ATTENTION")} ${c.dim(c.muted(path.join(cfg.paths.data, "verify-report.json")))}`);
  return report;
}

const WP_NOTES = {
  products: "grouped/external Woo products are skipped by design — see warnings.jsonl",
  customers: "guest buyers from orders become Shopify customers; count >= source is expected",
  orders: "counts above source mean duplicates or pre-existing test orders — investigate",
  collections: "grouped products add collections; handle collisions merge them; the auto Home collection is +1 on fresh stores but GONE after a wipe",
  stale: "imported from a previous dataset (or deleted in WP since).",
  staleHint: "for tier testing: wipe the target and re-run. For a real migration: check what was deleted in WP before go-live."
};

const DD_NOTES = {
  products: "source products skipped by design — see warnings.jsonl",
  customers: "guest buyers from orders become Shopify customers; count >= source is expected",
  orders: "counts above source mean duplicates or pre-existing test orders — investigate",
  collections: "handle collisions merge collections; brand and fokus-forside conditions collections add extras vs source category count; the auto Home collection is +1 on fresh stores but GONE after a wipe",
  stale: "imported from a previous dataset (or deleted in the source since).",
  staleHint: "for tier testing: wipe the target and re-run. For a real migration: check what was deleted in the source before go-live."
};

/** PLAN §8: count-note strings are source-aware. Do not rename WP tags. */
export function verifyNotes(productIdTag) {
  return String(productIdTag || "").startsWith("dd-id-") ? DD_NOTES : WP_NOTES;
}

/** SKU-first; DanDomain falls back to dd-id- when a product has no SKU. */
export function collectSpotChecks(products, { productIdTag = "wp-id-" } = {}) {
  const skuPrices = [];
  const tagPrices = [];
  const dd = String(productIdTag).startsWith("dd-id-");
  for (const { input } of products || []) {
    const variants = input.variants || [];
    for (const v of variants) if (v.sku) skuPrices.push({ sku: v.sku, price: v.price, title: input.title, via: "sku" });
    if (dd && !variants.some((v) => v.sku)) {
      const tag = (input.tags || []).find((t) => String(t).startsWith("dd-id-"));
      const price = variants[0]?.price;
      if (tag && price != null) tagPrices.push({ tag, price, title: input.title, via: "tag" });
    }
  }
  return { skuPrices, tagPrices };
}

const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
