import path from "node:path";
import { readJsonl, jsonlWriter, readJson } from "../util/fsx.js";
import { DISCOUNT_CREATE } from "../shopify/mutations.js";
import { log } from "../log.js";

/**
 * Coupons -> discountCodeBasicCreate (one call per code; no bulk equivalent).
 * Product-restricted Woo coupons are re-scoped to the migrated Shopify
 * products via the id-ledger. Shopify requires item scoping whenever
 * appliesOnEachItem is true, so unresolvable restrictions fall back to
 * appliesOnEachItem: false (order-level fixed amount) with a log line.
 */
export async function importDiscounts(cfg, client, idmap) {
  const lines = readJsonl(path.join(cfg.paths.transformed, "discounts.jsonl"));
  if (!lines.length) { log.info("No discounts to import"); return { imported: 0, failed: 0 }; }

  const memberships = readJson(path.join(cfg.paths.transformed, "product-memberships.json"), []) || [];
  const handleByWooId = new Map(memberships.map((m) => [m.wooId, m.handle]));
  const resolveProducts = (wooIds = []) =>
    wooIds.map((id) => idmap.get("products", handleByWooId.get(id))).filter(Boolean);

  const pending = lines.filter((l) => !idmap.has("discounts", l.basicCodeDiscount.code));
  log.info(`Discounts: ${lines.length} total, ${pending.length} to import`);
  if (cfg.options.dryRun) { log.info(`[dry-run] would import ${pending.length} discounts`); return { imported: 0, failed: 0, dryRun: true }; }

  const failed = jsonlWriter(path.join(cfg.paths.state, "failed-discounts.jsonl"));
  let imported = 0;
  for (const line of pending) {
    try {
      const discount = structuredClone(line.basicCodeDiscount);
      // re-apply product restrictions / satisfy the appliesOnEachItem rule
      const gids = resolveProducts(line._wooProductIds);
      if (gids.length) {
        discount.customerGets.items = { products: { productsToAdd: gids } };
      } else if (discount.customerGets?.value?.discountAmount?.appliesOnEachItem) {
        discount.customerGets.value.discountAmount.appliesOnEachItem = false;
        log.warn(`  discount ${discount.code}: could not resolve restricted products — imported as order-level fixed amount`);
      }
      const res = await client.mutate("discountCodeBasicCreate", DISCOUNT_CREATE, { basicCodeDiscount: discount });
      idmap.set("discounts", line.basicCodeDiscount.code, res.codeDiscountNode.id);
      imported++;
    } catch (e) {
      if (/already been taken|duplicate/i.test(e.message)) idmap.set("discounts", line.basicCodeDiscount.code, "exists");
      else failed.write({ code: line.basicCodeDiscount.code, error: e.message, userErrors: e.userErrors });
    }
  }
  idmap.save();
  await failed.close();
  log.info(`Discounts: ${imported} imported, ${failed.count} failed`);
  return { imported, failed: failed.count };
}
