import path from "node:path";
import { readJsonl, jsonlWriter } from "../util/fsx.js";
import { ORDER_CREATE, QUERY_VARIANT_BY_SKU, QUERY_ORDERS_BY_TAG } from "../shopify/mutations.js";
import { progress } from "../ui.js";
import { sleep } from "../util/http.js";
import { log } from "../log.js";

/**
 * Historical order import via orderCreate — one call per order, with a
 * deferred-retry queue:
 *
 *   orderCreate has its own global order-CREATION rate limit (separate from
 *   the GraphQL cost throttle) that surfaces as a "Too many attempts"
 *   userError — ~4-5/min on dev stores, more on production. Because the
 *   limit is global, skipping ahead doesn't help throughput; instead:
 *
 *   - rate-limited orders are DEFERRED into a queue (never marked failed)
 *   - the importer learns pacing the moment the limit first bites
 *   - the queue drains in rounds with escalating waits as the bucket refills
 *   - only validation-style errors fail immediately; only orders still
 *     rate-limited after all rounds are written to the failed ledger
 *
 * Safety rails: inventoryBehaviour BYPASS (no stock mutation), sendReceipt /
 * sendFulfillmentReceipt false (no customer emails), and a per-order
 * existence check by tag so retries after ambiguous outcomes can't duplicate.
 */
export async function importOrders(cfg, client, idmap) {
  // tunable for tests/unusual stores; defaults match observed live limits
  const knobs = cfg.options.orders || {};
  const MAX_ROUNDS = knobs.maxRetryRounds ?? 7;
  const PACE_MS = knobs.paceMs ?? 13000; // ~4.6/min once the creation limit has been observed
  const roundWait = (round) => Math.min((knobs.retryWaitBaseMs ?? 20000) * round, knobs.retryWaitMaxMs ?? 90000);
  const lines = readJsonl(path.join(cfg.paths.transformed, "orders.jsonl"));
  if (!lines.length) { log.info("No orders to import"); return { imported: 0, failed: 0 }; }

  const pending = lines.filter((l) => !idmap.has("orders", l.order.sourceIdentifier));
  log.info(`Orders: ${lines.length} total, ${pending.length} to import`);
  if (cfg.options.dryRun) { log.info(`[dry-run] would import ${pending.length} orders`); return { imported: 0, failed: 0, dryRun: true }; }

  const failed = jsonlWriter(path.join(cfg.paths.state, "failed-orders.jsonl"));
  const skuCache = new Map(Object.entries(idmap.all("variantsBySku")));
  const options = { inventoryBehaviour: "BYPASS", sendReceipt: false, sendFulfillmentReceipt: false };
  let imported = 0;
  let skippedEmpty = 0;
  let paceMs = 0; // 0 = full speed until the creation limit first bites

  const isCreationRateLimit = (e) => (e.userErrors || []).some((u) => /too many attempts/i.test(u.message || ""));

  async function resolveVariantId(sku) {
    if (!sku) return null;
    if (skuCache.has(sku)) return skuCache.get(sku);
    try {
      const data = await client.graphql(QUERY_VARIANT_BY_SKU, { q: `sku:"${sku.replace(/"/g, '\\"')}"` });
      const node = data.productVariants?.nodes?.find((n) => n.sku === sku) || null;
      const id = node?.id ?? null;
      skuCache.set(sku, id);
      if (id) idmap.set("variantsBySku", sku, id);
      return id;
    } catch { skuCache.set(sku, null); return null; }
  }

  /** Prepare once: resolve variants, strip internal keys. Reused across retry rounds. */
  async function prepare(line) {
    const order = structuredClone(line.order);
    for (const li of order.lineItems || []) {
      const variantId = await resolveVariantId(li._sku);
      if (variantId) li.variantId = variantId;
      delete li._sku; delete li._variationId; delete li._productId;
    }
    return order;
  }

  /** Duplicate guard — a mutation can succeed while its response is redacted/lost. */
  async function alreadyExists(order) {
    const wcTag = (order.tags || []).find((t) => t.startsWith("wc-order-") || t.startsWith("dd-order-"));
    if (!wcTag) return null;
    try {
      const ex = await client.graphql(QUERY_ORDERS_BY_TAG, { q: `tag:'${wcTag}'` });
      return ex.orders?.nodes?.[0] ?? null;
    } catch { return null; }
  }

  let queue = pending.map((line) => ({ line, order: null, tries: 0 }));

  for (let round = 1; queue.length && round <= MAX_ROUNDS; round++) {
    const label = round === 1 ? "orders" : `orders · retry round ${round} (${queue.length} deferred)`;
    const bar = progress(label, queue.length);
    const deferred = [];

    for (const item of queue) {
      item.order = item.order ?? await prepare(item.line);
      const name = item.order.name || item.order.sourceIdentifier;

      // Shopify orderCreate (Admin GraphQL 2026-01) requires ≥1 line item.
      // Empty F16 orders used to land in failed-orders.jsonl (exit 4/5). Skip
      // them as unlandable — do not fabricate lines, do not count as failed.
      if (!(item.order.lineItems || []).length) {
        skippedEmpty++;
        bar.tick(`${name} skipped (empty line items)`);
        log.warn(`  order SKIPPED ${name}: Shopify orderCreate requires at least one line item — unlandable, not a retryable failure`);
        continue;
      }

      if (item.tries === 0) {
        const existing = await alreadyExists(item.order);
        if (existing) {
          idmap.set("orders", item.order.sourceIdentifier, existing.id);
          bar.tick(`${name} exists — skipped`);
          continue;
        }
      }

      if (paceMs) await sleep(paceMs);
      item.tries++;
      try {
        const res = await client.mutate("orderCreate", ORDER_CREATE, { order: item.order, options });
        idmap.set("orders", item.order.sourceIdentifier, res.order.id);
        imported++;
        bar.tick(name);
        idmap.save(); // batched in the ledger now — this used to be `% 25` here
      } catch (e) {
        if (isCreationRateLimit(e)) {
          if (!paceMs) { paceMs = PACE_MS; log.warn(`  orderCreate creation limit hit — pacing to ~${Math.round(60000 / PACE_MS)}/min and queueing deferred orders (normal on dev stores)`); }
          deferred.push(item);
          bar.tick(`${name} deferred (rate limit)`);
        } else {
          failed.write({ sourceIdentifier: item.order.sourceIdentifier, name: item.order.name, error: e.message, userErrors: e.userErrors });
          bar.tick(`${name} FAILED`);
          log.warn(`  order FAILED ${name}: ${e.message.slice(0, 180)}`);
        }
      }
    }

    bar.done(`${label}: ${imported} imported so far, ${deferred.length} deferred, ${failed.count} failed`);
    idmap.save();
    queue = deferred;

    if (queue.length && round < MAX_ROUNDS) {
      const wait = roundWait(round);
      log.info(`  waiting ${Math.round(wait / 1000)}s for the creation-rate bucket to refill…`);
      await sleep(wait);
    }
  }

  // whatever survived every round is a real failure — but a resumable one:
  // re-running the import retries exactly these (ledger + tag guard prevent dupes)
  for (const item of queue) {
    failed.write({ sourceIdentifier: item.order.sourceIdentifier, name: item.order.name, error: `still rate-limited after ${MAX_ROUNDS} rounds — re-run import later to retry safely` });
  }
  if (queue.length) log.warn(`  ${queue.length} orders still rate-limited after ${MAX_ROUNDS} rounds — re-run 'import' later; it resumes exactly where this stopped`);

  idmap.save();
  await failed.close();
  log.info(`Orders: ${imported} imported, ${failed.count} failed${skippedEmpty ? `, ${skippedEmpty} skipped (empty line items)` : ""}`);
  return { imported, failed: failed.count, skippedEmpty };
}
