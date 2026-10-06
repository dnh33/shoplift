#!/usr/bin/env node
/**
 * seed-bulk-products.mjs — creates N extra WooCommerce products on the
 * active source site so the next import exceeds options.productsBulkThreshold
 * and exercises the Shopify BULK path (staged JSONL upload +
 * bulkOperationRunMutation) against a live store.
 *
 * Usage: node scripts/seed-bulk-products.mjs [count=40]
 * Uses the active config/migration.config.json + .env credentials.
 * Idempotent: skips if the bulk SKUs already exist.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COUNT = Math.min(Number(process.argv[2]) || 40, 100);

const cfg = loadConfig(path.join(ROOT, "config", "migration.config.json"));
const wc = cfg.source.woocommerce;
const base = `${cfg.source.baseUrl}/wp-json/wc/v3`;
const auth = "Basic " + Buffer.from(`${wc.consumerKey}:${wc.consumerSecret}`).toString("base64");
const api = async (method, route, payload) => {
  const res = await fetch(`${base}/${route}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json", "User-Agent": "shoplift/1.337" },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(180000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${route}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
};

const existing = await api("GET", "products?sku=WOOLBULK-0001");
if (existing.length) {
  console.log("Bulk products already seeded — nothing to do.");
  process.exit(0);
}

console.log(`Seeding ${COUNT} bulk-test products on ${cfg.source.baseUrl} ...`);
const colors = ["Rød", "Blå", "Grøn", "Gul", "Natur", "Grå", "Sort", "Hvid"];
const create = Array.from({ length: COUNT }, (_, i) => ({
  name: `Uldgarn ${colors[i % colors.length]} #${String(i + 1).padStart(4, "0")}`,
  slug: `uldgarn-bulk-${String(i + 1).padStart(4, "0")}`,
  type: "simple",
  status: "publish",
  sku: `WOOLBULK-${String(i + 1).padStart(4, "0")}`,
  regular_price: String(29 + (i % 40)),
  ...(i % 3 === 0 ? { sale_price: String(19 + (i % 20)) } : {}),
  manage_stock: true,
  stock_quantity: 10 + (i % 90),
  weight: "0.05",
  short_description: `<p>Bulktest-nøgle ${i + 1} — 100% uld.</p>`
}));

// Woo batch endpoint takes up to 100 ops per call
const res = await api("POST", "products/batch", { create });
console.log(`✓ created ${res.create?.length ?? 0} products (WOOLBULK-0001 … WOOLBULK-${String(COUNT).padStart(4, "0")})`);
console.log("Next: node src/cli.js all   — products import should take the BULK path");
