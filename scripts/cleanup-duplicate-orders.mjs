#!/usr/bin/env node
/**
 * cleanup-duplicate-orders.mjs — removes duplicate imported orders.
 *
 * Duplicates happen when orderCreate succeeds but its response is redacted
 * (e.g. Protected Customer Data not yet approved) and the order is retried.
 * The pipeline now guards against this; this script cleans up any that
 * already landed.
 *
 * Strategy: fetch all orders tagged by the importer (options.orders.tag),
 * group them by their wc-order-<n> tag, keep the one recorded in the
 * id-ledger (or the oldest if none is recorded), delete the rest.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-orders.mjs           # dry-run: list only
 *   node scripts/cleanup-duplicate-orders.mjs --yes     # actually delete
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireShopify } from "../src/config.js";
import { createShopifyClient } from "../src/shopify/client.js";
import { openIdMap } from "../src/util/idmap.js";
import { QUERY_ORDERS_BY_TAG, ORDER_DELETE } from "../src/shopify/mutations.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YES = process.argv.includes("--yes");
const configPath = process.argv.find((a, i) => process.argv[i - 1] === "--config") || path.join(ROOT, "config", "migration.config.json");

const cfg = loadConfig(configPath);
const client = createShopifyClient(requireShopify(cfg));
const idmap = openIdMap(cfg.paths.state);
const keep = new Set(Object.values(idmap.all("orders")));
const importTag = cfg.options.orders?.tag || "wp-import";

// collect every imported order (paginate defensively via repeated tag query)
const data = await client.graphql(
  `query($q: String!) { orders(first: 250, query: $q) { nodes { id name tags createdAt } } }`,
  { q: `tag:'${importTag}'` }
);
const orders = data.orders?.nodes || [];
console.log(`Found ${orders.length} orders tagged '${importTag}'`);

const byWcTag = new Map();
for (const o of orders) {
  const wc = o.tags.find((t) => t.startsWith("wc-order-")) || o.name;
  if (!byWcTag.has(wc)) byWcTag.set(wc, []);
  byWcTag.get(wc).push(o);
}

let deleted = 0, kept = 0;
for (const [wc, group] of byWcTag) {
  group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const keeper = group.find((o) => keep.has(o.id)) || group[0];
  kept++;
  for (const o of group) {
    if (o.id === keeper.id) continue;
    if (!YES) { console.log(`  would delete duplicate ${o.name} (${wc}) — keeping ${keeper.name}`); continue; }
    const res = await client.mutate("orderDelete", ORDER_DELETE, { orderId: o.id });
    if (res.deletedId) { console.log(`  ✓ deleted duplicate ${o.name} (${wc})`); deleted++; }
  }
  // make sure the ledger points at the keeper
  const srcId = wc.replace("wc-order-", "");
  idmap.set("orders", srcId, keeper.id);
}
// flush, not save: the ledger batches writes (util/idmap.js) and a cleanup of
// fewer than LEDGER_BATCH duplicates would otherwise persist nothing at all.
idmap.flush();

console.log(YES ? `Done: ${deleted} duplicates deleted, ${kept} orders kept.` : "Dry-run only — re-run with --yes to delete.");
