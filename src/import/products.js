import path from "node:path";
import { readJsonl, jsonlWriter } from "../util/fsx.js";
import { runBulkMutation } from "../shopify/bulk.js";
import { PRODUCT_SET, PRODUCT_SET_BULK } from "../shopify/mutations.js";
import { progress } from "../ui.js";
import { log } from "../log.js";

/**
 * WP HANDLE_COLLISION: later import OVERWRITES the earlier product (productSet upserts by handle).
 * Bulk productSet in one operation returns HANDLE_NOT_UNIQUE on later rows instead.
 * Collapse pending lines by handle, last writer wins, before either import path.
 */
export function collapsePendingByHandle(pending) {
  const byHandle = new Map();
  for (const line of pending) byHandle.set(line.input.handle, line);
  return [...byHandle.values()];
}

/** After bulk+catalog sweep, only handles still absent from the ledger are failures. HANDLE_NOT_UNIQUE on a leftover (incomplete wipe) is adopted, not PARTIAL. */
export function pendingNotInLedger(pending, idmap) {
  return pending.filter((l) => !idmap.has("products", l.input.handle));
}

/**
 * Product import. Two paths, chosen by catalog size:
 *  - small catalogs: synchronous productSet per product (instant feedback,
 *    variant IDs returned inline)
 *  - large catalogs: one bulk operation (stagedUploadsCreate -> JSONL ->
 *    bulkOperationRunMutation) — free of rate-limit cost, up to 100 MB input
 * productSet is an upsert keyed on handle, so re-running is safe.
 */
export async function importProducts(cfg, client, idmap, locationId) {
  const file = path.join(cfg.paths.transformed, "products.jsonl");
  const lines = readJsonl(file).map((l) => {
    // inject the real location id into inventoryQuantities placeholders
    const json = JSON.stringify(l).replaceAll("{{LOCATION_ID}}", locationId);
    return JSON.parse(json);
  });
  if (!lines.length) { log.info("No products to import"); return { imported: 0, failed: 0 }; }

  const failed = jsonlWriter(path.join(cfg.paths.state, "failed-products.jsonl"));
  let imported = 0;

  const pendingRaw = lines.filter((l) => !idmap.has("products", l.input.handle));
  const pending = collapsePendingByHandle(pendingRaw);
  if (pending.length !== pendingRaw.length) {
    log.warn(`Products: ${pendingRaw.length - pending.length} duplicate handle(s) collapsed to last writer (HANDLE_COLLISION overwrite semantics)`);
  }
  log.info(`Products: ${lines.length} total, ${pending.length} to import (rest already in idmap)`);

  if (cfg.options.dryRun) { log.info(`[dry-run] would import ${pending.length} products`); await failed.close(); return { imported: 0, failed: 0, dryRun: true }; }

  if (pending.length <= (cfg.options.productsBulkThreshold ?? 25)) {
    const bar = progress("products", pending.length);
    for (const line of pending) {
      try {
        const res = await client.mutate("productSet", PRODUCT_SET, { input: line.input, synchronous: true });
        const prod = res.product;
        idmap.set("products", line.input.handle, prod.id);
        for (const v of prod.variants?.nodes || []) if (v.sku) idmap.set("variantsBySku", v.sku, v.id);
        imported++;
        bar.tick(line.input.handle);
      } catch (e) {
        failed.write({ handle: line.input.handle, error: e.message, userErrors: e.userErrors });
        bar.tick(`${line.input.handle} FAILED`);
        log.warn(`  product FAILED: ${line.input.handle} — ${e.message.slice(0, 200)}`);
      }
      idmap.save();
    }
    bar.done(`products: ${imported} imported, ${failed.count} failed`);
  } else {
    // bulk path — force synchronous:true per line: inside a bulk operation the
    // async wrapper is Shopify's job, and synchronous:false would return a
    // productSetOperation instead of the product (empty result rows).
    const tmp = path.join(cfg.paths.state, "bulk-products.jsonl");
    const w = jsonlWriter(tmp);
    for (const line of pending) w.write({ ...line, synchronous: true });
    await w.close();

    const op = await runBulkMutation(client, { jsonlFile: tmp, mutation: PRODUCT_SET_BULK, label: "products", total: pending.length });
    const bulkFails = [];
    for (const row of op.results) {
      const payload = row.data?.productSet ?? row.productSet ?? row;
      const errs = payload?.userErrors || [];
      if (payload?.product?.id) {
        idmap.set("products", payload.product.handle, payload.product.id);
        imported++;
      } else if (errs.length) {
        bulkFails.push({ line: row.__lineNumber, userErrors: errs });
      }
    }
    idmap.save();

    // safety net: sweep the catalog so the ledger (product ids + variant SKUs)
    // is complete even if the bulk result shape ever surprises us
    await sweepCatalog(client, idmap);
    imported = pending.filter((l) => idmap.has("products", l.input.handle)).length;
    for (const line of pendingNotInLedger(pending, idmap)) {
      const match = bulkFails.find((f) => JSON.stringify(f.userErrors || []).includes(line.input.handle));
      failed.write({ handle: line.input.handle, error: match ? JSON.stringify(match.userErrors) : "bulk productSet did not land; not in catalog sweep", userErrors: match?.userErrors });
    }
    log.info(`Products bulk import: ${imported} ok, ${failed.count} failed`);
  }

  await failed.close();
  return { imported, failed: failed.count };
}

/** Paginate the whole catalog into the ledger: handle -> product gid, sku -> variant gid. */
async function sweepCatalog(client, idmap) {
  const { spinner } = await import("../ui.js");
  const sp = spinner("catalog sweep: page 1…");
  let cursor = null, pages = 0;
  do {
    const d = await client.graphql(
      `query sweep($c: String) {
        products(first: 25, after: $c) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle variants(first: 30) { nodes { id sku } } }
        }
      }`, { c: cursor });
    for (const p of d.products?.nodes || []) {
      idmap.set("products", p.handle, p.id);
      for (const v of p.variants?.nodes || []) if (v.sku) idmap.set("variantsBySku", v.sku, v.id);
    }
    cursor = d.products?.pageInfo?.hasNextPage ? d.products.pageInfo.endCursor : null;
    sp.update(`catalog sweep: page ${pages + 2} · ${idmap.count("products")} products, ${idmap.count("variantsBySku")} SKUs ledgered…`);
  } while (cursor && ++pages < 400);
  idmap.save();
  sp.succeed(`catalog sweep: ${idmap.count("products")} products, ${idmap.count("variantsBySku")} SKUs in ledger`);
}
