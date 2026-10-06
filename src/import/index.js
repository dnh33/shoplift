import { createShopifyClient, getPrimaryLocationId } from "../shopify/client.js";
import { openIdMap } from "../util/idmap.js";
import { requireShopify } from "../config.js";
import { importProducts } from "./products.js";
import { importCollections } from "./collections.js";
import { importCustomers } from "./customers.js";
import { importOrders } from "./orders.js";
import { importDiscounts } from "./discounts.js";
import { importContent } from "./content.js";
import { importRedirects } from "./redirects.js";
import { importRefunds } from "./refunds.js";
import { importB2bPricing } from "./b2b.js";
import { importGiftCards } from "./gift-cards.js";
import { importTranslations } from "./translations.js";
import { importBlog } from "./blog.js";
import { writeJson } from "../util/fsx.js";
import path from "node:path";
import { log } from "../log.js";

/**
 * Stage 3 — IMPORT, in dependency order:
 *   products -> collections (need product ids) -> customers -> discounts
 *   -> content -> orders (need variant ids + customers) -> redirects (last:
 *   only meaningful once target URLs exist)
 *   Flag-gated DanDomain extras (PLAN §11): B2B, refunds, gift cards,
 *   translations, blog signal — after orders so refunds can find ledger ids.
 * Every step is resumable: the idmap ledger skips whatever already landed.
 */
export async function runImport(cfg, entities) {
  const shopifyCfg = requireShopify(cfg);
  const client = createShopifyClient(shopifyCfg);
  const idmap = openIdMap(cfg.paths.state);
  // A dry run writes this same import-report.json, so `status.lastImport` (and
  // any agent reading it) sees zeros and must be able to tell a PREVIEW from a
  // real import that genuinely wrote nothing. Individual importers each set
  // their own `dryRun` inside results.*, but that is not dependable as the
  // signal: importContent never sets one, and an --entities subset can produce
  // a report where no group carries it at all. One top-level flag, always
  // present, is the thing a caller can branch on.
  const report = { startedAt: new Date().toISOString(), shop: shopifyCfg.shop, apiVersion: shopifyCfg.apiVersion, dryRun: cfg.options.dryRun === true, results: {} };

  const locationId = cfg.options.dryRun ? "gid://shopify/Location/0" : await getPrimaryLocationId(client, shopifyCfg.primaryLocationId);

  // PCD pre-flight: customers/orders mutations EXECUTE even when the response
  // is redacted for apps without Protected Customer Data approval — failing
  // here, before any mutation, prevents silent duplicates.
  if ((entities.customers || entities.orders) && !cfg.options.dryRun) {
    const { QUERY_PCD_PROBE } = await import("../shopify/mutations.js");
    try { await client.graphql(QUERY_PCD_PROBE); }
    catch (e) {
      if (/not approved to access|ACCESS_DENIED/i.test(e.message)) {
        throw new Error("Protected Customer Data access is not enabled for this app — customers/orders would duplicate. Enable it (Dev Dashboard -> your app -> API access -> Protected customer data + Name/Address/Email/Phone fields), then re-run. See PLAYBOOK §3.");
      }
      throw e;
    }
  }

  // The ledger batches its writes (util/idmap.js), so each stage is flushed
  // before the next begins. Enforcing durability HERE rather than in each
  // importer is the point: the O(n^2) save-per-record this replaced happened
  // because per-loop ledger discipline is easy to get wrong seven times over.
  // A crash now costs at most the in-flight stage's last few entries.
  if (entities.products) { report.results.products = await importProducts(cfg, client, idmap, locationId); idmap.flush(); }
  if (entities.collections) { report.results.collections = await importCollections(cfg, client, idmap); idmap.flush(); }
  if (entities.customers) { report.results.customers = await importCustomers(cfg, client, idmap); idmap.flush(); }
  if (entities.discounts) { report.results.discounts = await importDiscounts(cfg, client, idmap); idmap.flush(); }
  if (entities.articles || entities.pages) { report.results.content = await importContent(cfg, client, idmap, entities); idmap.flush(); }
  if (entities.orders) { report.results.orders = await importOrders(cfg, client, idmap); idmap.flush(); }
  if (entities.redirects) { report.results.redirects = await importRedirects(cfg, client, idmap); idmap.flush(); }

  // Flag-gated DanDomain importers (no-op / skip when flags off). Always safe
  // to call — they check options themselves.
  report.results.blog = await importBlog(cfg, client, idmap);
  if (cfg.options?.importB2bPricing) {
    report.results.b2b = await importB2bPricing(cfg, client, idmap); idmap.flush();
  }
  if (cfg.options?.importRefunds) {
    report.results.refunds = await importRefunds(cfg, client, idmap); idmap.flush();
  }
  if (cfg.options?.importGiftCards) {
    report.results.giftCards = await importGiftCards(cfg, client, idmap); idmap.flush();
  }
  if (cfg.options?.importTranslations) {
    report.results.translations = await importTranslations(cfg, client, idmap); idmap.flush();
  }

  report.finishedAt = new Date().toISOString();
  writeJson(path.join(cfg.paths.state, "import-report.json"), report);
  if (cfg.options.dryRun) {
    const { verdict, c } = await import("../ui.js");
    console.log(`\n  ${verdict(false, "DRY-RUN — NOTHING WAS WRITTEN TO SHOPIFY")}`);
    console.log(`  ${c.muted("this was a simulation; run the import in LIVE mode to migrate for real")}`);
  } else {
    log.info(`Import complete. Report: ${path.join(cfg.paths.state, "import-report.json")}`);
  }
  return report;
}
