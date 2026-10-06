#!/usr/bin/env node
/**
 * qa-real-tier.mjs — automated post-run QA for the `real` tier: executes the
 * manual-QA list as Admin-API assertions.
 * Read-only (queries only). Uses the pair's own ledger/exports to find gids,
 * so it asserts against exactly what THIS run created.
 *
 * Run from the repo root:  node scripts/qa-real-tier.mjs
 * Also writes data/state/qa-report.json for the record.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireShopify } from "../src/config.js";
import { createShopifyClient } from "../src/shopify/client.js";
import { readJson, readJsonl, writeJson } from "../src/util/fsx.js";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const cfg = loadConfig(process.argv[2] || path.join(ROOT, "config", "migration.config.json"));
const client = createShopifyClient(requireShopify(cfg));
const idmap = readJson(path.join(cfg.paths.state, "idmap.json"), {});
const rawOrders = readJsonl(path.join(cfg.paths.raw, "orders.jsonl"));
const transformed = readJsonl(path.join(cfg.paths.transformed, "products.jsonl"));

const results = [];
let failed = 0;
const check = (ok, label, evidence) => {
  results.push({ ok: Boolean(ok), label, evidence });
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${evidence ? ` — ${evidence}` : ""}`);
};
const orderGidByMarker = (marker) => {
  const o = rawOrders.find((x) => (x.meta_data || []).some((m) => m.key === "_example_seed" && m.value === marker));
  return { gid: o ? idmap.orders?.[String(o.id)] : null, wooId: o?.id };
};

const NODE_PRODUCT = `query($id: ID!){ node(id:$id){ ... on Product { title handle status variants(first:10){nodes{sku price}} } } }`;
const NODE_ORDER = `query($id: ID!){ node(id:$id){ ... on Order { name note lineItems(first:20){nodes{title sku variant{id}}} } } }`;
const NODE_ARTICLE = `query($id: ID!){ node(id:$id){ ... on Article { handle body } } }`;
const NODE_COLLECTION = `query($id: ID!){ node(id:$id){ ... on Collection { handle title productsCount{count} } } }`;
const CUSTOMERS = `query($q: String!){ customers(first:5, query:$q){ nodes { id email displayName } } }`;

console.log("— real-tier QA (live Admin API) —");

// 1 — entity decode on title + handle
{
  const gid = idmap.products?.["taepper-plaider-proevekollektion"];
  const p = gid ? (await client.graphql(NODE_PRODUCT, { id: gid })).node : null;
  check(p && p.title.includes("Tæpper & Plaider") && !p.title.includes("&amp;"), "entity-decoded title (Tæpper & Plaider)", p?.title);
  check(p && !p.handle.includes("amp"), "no 'amp' leaked into the handle", p?.handle);
}

// 2 — sale>regular product sells at the transform's price (never the bogus sale)
{
  const t = transformed.find((x) => x.input.handle === "sofapude-vintage-rosa")?.input;
  const gid = idmap.products?.["sofapude-vintage-rosa"];
  const p = gid ? (await client.graphql(NODE_PRODUCT, { id: gid })).node : null;
  const live = p?.variants.nodes[0];
  check(t && live && Number(live.price) === Number(t.variants[0].price), "sofapude-vintage-rosa price matches transform", `live ${live?.price} vs expected ${t?.variants[0].price}`);
}

// 3 — whitespace SKU arrived trimmed
{
  const gid = idmap.products?.["hyggeplaid-meleret"];
  const p = gid ? (await client.graphql(NODE_PRODUCT, { id: gid })).node : null;
  const sku = p?.variants.nodes[0]?.sku;
  check(sku === "BH-PLAID-07", "hyggeplaid SKU has no padding", JSON.stringify(sku));
}

// 4 — zero-price product imported at 0 (by design, action-flagged)
{
  const gid = idmap.products?.["vareproeve-garnkort"];
  const p = gid ? (await client.graphql(NODE_PRODUCT, { id: gid })).node : null;
  check(p && Number(p.variants.nodes[0]?.price) === 0, "vareprøve imported at 0 (action warning covers it)", p?.variants.nodes[0]?.price);
}

// 5 — handle collisions actually merged: both slugs ledger to ONE collection
{
  const a = idmap.collections?.["strikke-tilbehoer"];
  const b = idmap.collections?.["strikke_tilbehoer"];
  check(a && a === b, "strikke-tilbehør cat×cat collision merged (one gid for two slugs)", a === b ? "same gid" : `a=${a} b=${b}`);
  const gid = idmap.collections?.["tilbehoer"];
  const c = gid ? (await client.graphql(NODE_COLLECTION, { id: gid })).node : null;
  check(c && c.productsCount.count > 0, "tilbehoer collection (cat×grouped merge) exists with members", `${c?.title} · ${c?.productsCount.count} products`);
}

// 6 — partial-refund order carries the Danish note, imported at full value
{
  const { gid } = orderGidByMarker("bh-o-055");
  const o = gid ? (await client.graphql(NODE_ORDER, { id: gid })).node : null;
  check(o && o.note.includes("Delvis refusion") && o.note.includes("100.00"), "bh-o-055 has partial-refund note (da)", o?.name);
}

// 7 — ghost order: title-only line (no variant behind it)
{
  let found = null, name = null;
  for (const marker of ["bh-o-056", "bh-o-057"]) {
    const { gid } = orderGidByMarker(marker);
    if (!gid) continue;
    const o = (await client.graphql(NODE_ORDER, { id: gid })).node;
    const ghost = o?.lineItems.nodes.find((li) => li.title.startsWith("Udgået"));
    if (ghost) { found = ghost; name = `${marker} → ${o.name}`; break; }
  }
  check(found && !found.variant, "ghost line is title-only (no variant resolved)", `${name}: "${found?.title}" sku=${JSON.stringify(found?.sku ?? null)}`);
}

// 8 — YouTube iframe survived into the article body
{
  const gid = idmap.articles?.["pleje-af-uldplaid"];
  const a = gid ? (await client.graphql(NODE_ARTICLE, { id: gid })).node : null;
  check(a && a.body.includes("<iframe") && a.body.includes("youtube"), "YouTube iframe preserved in article", a?.handle);
}

// 9 — 2018-era markup preserved (not mangled by the sanitizer)
{
  const gid = idmap.articles?.["strik-med-restegarn"];
  const a = gid ? (await client.graphql(NODE_ARTICLE, { id: gid })).node : null;
  check(a && a.body.includes("<center>") && a.body.includes("<font"), "2018 markup (<center>/<font>) intact", a?.handle);
}

// 10 — case-duplicate guest emails merged: exactly ONE customer, findable both ways
{
  const email = "aase.lund31@example.dk";
  const lower = (await client.graphql(CUSTOMERS, { q: `email:${email}` })).customers.nodes;
  const upper = (await client.graphql(CUSTOMERS, { q: `email:Aase.lund31@Example.dk` })).customers.nodes;
  check(lower.length === 1, "exactly ONE customer for the case-dup email", `${lower.length} hit(s): ${lower.map((c) => c.displayName).join(", ")}`);
  check(upper.length === 1 && upper[0]?.id === lower[0]?.id, "case-variant search resolves to the SAME customer", upper[0]?.id === lower[0]?.id ? "same gid" : "DIFFERENT");
}

const report = { ranAt: new Date().toISOString(), passed: results.length - failed, failed, results };
writeJson(path.join(cfg.paths.state, "qa-report.json"), report);
console.log(`\n${report.passed}/${results.length} passed → data/state/qa-report.json`);
process.exit(failed ? 1 : 0);
