import path from "node:path";
import { rmSync, existsSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { requireShopify } from "../config.js";
import { createShopifyClient } from "../shopify/client.js";
import {
  ORDER_DELETE, PRODUCT_DELETE, COLLECTION_DELETE, CUSTOMER_DELETE, DISCOUNT_DELETE,
  ARTICLE_DELETE, BLOG_DELETE, PAGE_DELETE, URL_REDIRECT_DELETE, URL_REDIRECT_BULK_DELETE_ALL, QUERY_COUNTS
} from "../shopify/mutations.js";
import { c, chip, section, progress, verdict } from "../ui.js";
import { log } from "../log.js";
import { sleep } from "../util/http.js";

/** QUERY_COUNTS leftover shape. Gift cards / B2B companies are not in this census. */
export function leftoverStoreCounts(live) {
  return {
    products: live?.productsCount?.count ?? 0,
    orders: live?.ordersCount?.count ?? 0,
    customers: live?.customersCount?.count ?? 0,
    collections: live?.collectionsCount?.count ?? 0,
  };
}

export function wipeStoreEmpty(left) {
  return (Number(left?.products) || 0) + (Number(left?.orders) || 0) + (Number(left?.customers) || 0) + (Number(left?.collections) || 0) === 0;
}

/**
 * Stage — WIPE (test tooling): deletes ALL store data from the target shop
 * so migration tests start from a clean slate.
 *
 * Safety rails:
 *  - HARD refusal on anything that isn't a partner development store.
 *    There is deliberately no override flag.
 *  - interactive confirmation: the store domain must be typed back
 *    (skippable with --yes for scripted test loops).
 *  - deletion order respects API constraints (orders before customers —
 *    Shopify refuses to delete customers that still have orders).
 *
 * Also clears the pair's local ledger (data/state) so the next import
 * starts fresh instead of skipping everything.
 */
export async function runWipe(cfg, { yes = false, ask = null } = {}) {
  const client = createShopifyClient(requireShopify(cfg));
  const { shop } = await client.graphql(`{ shop { name myshopifyDomain plan { partnerDevelopment } } }`);

  if (!shop.plan?.partnerDevelopment) {
    throw new Error(`"${shop.myshopifyDomain}" is NOT a development store — wipe refuses to run against live stores. (No override exists, by design.)`);
  }

  const live = await client.graphql(QUERY_COUNTS);
  console.log(section("wipe"));
  console.log(`  ${chip.warn()} target: ${c.magenta(shop.name)} ${c.gray(`(${shop.myshopifyDomain}, dev store)`)}`);
  console.log(`  ${c.gray("will delete:")} ${c.white(live.productsCount?.count ?? "?")} products · ${c.white(live.customersCount?.count ?? "?")} customers · ${c.white(live.ordersCount?.count ?? "?")} orders · ${c.white(live.collectionsCount?.count ?? "?")} collections ${c.gray("+ all discounts, articles, blogs, pages, redirects")}`);

  if (!yes) {
    // the dev-store-only gate above is the real safety; confirmation is just y/N
    const q = `wipe ${shop.myshopifyDomain}? (y/N)`;
    let answer;
    if (ask) {
      answer = await ask(q, "n");
    } else {
      const rl = readline.createInterface({ input, output });
      answer = (await rl.question(`  ${chip.prompt()} ${q} [n]: `)).trim() || "n";
      rl.close();
    }
    if (!answer.toLowerCase().startsWith("y")) throw new Error("aborted — nothing deleted");
  }

  /** Page through a listing query, deleting each node. Never stop on a short page while rows remain — that left 346 products after a rate-limited batch (2026-08-19). */
  async function deleteAll(label, listQuery, extract, deleteOne) {
    let total = 0;
    for (let page = 0; page < 200; page++) {
      const nodes = extract(await client.graphql(listQuery)) || [];
      if (!nodes.length) break;
      const bar = progress(`wiping ${label}`, nodes.length);
      let okCount = 0;
      for (const n of nodes) {
        try { await deleteOne(n); okCount++; }
        catch (e) { log.warn(`  ${label} ${n.id}: ${e.message.slice(0, 120)}`); }
        bar.tick();
      }
      bar.done(`${label}: ${okCount}/${nodes.length} deleted`);
      total += okCount;
      if (okCount === 0) {
        log.warn(`  ${label}: entire batch deleted 0 — waiting 2s for Shopify listing consistency`);
        await sleep(2000);
        const again = extract(await client.graphql(listQuery)) || [];
        if (!again.length) break;
      }
    }
    return total;
  }

  const summary = {};
  let left = { products: 1, orders: 1, customers: 1, collections: 1 };
  for (let pass = 1; pass <= 4; pass++) {
    summary.orders = (summary.orders || 0) + await deleteAll("orders",
      `{ orders(first: 75) { nodes { id } } }`, (d) => d.orders?.nodes,
      (n) => client.mutate("orderDelete", ORDER_DELETE, { orderId: n.id }));
    summary.products = (summary.products || 0) + await deleteAll("products",
      `{ products(first: 75) { nodes { id } } }`, (d) => d.products?.nodes,
      (n) => client.mutate("productDelete", PRODUCT_DELETE, { input: { id: n.id } }));
    summary.collections = (summary.collections || 0) + await deleteAll("collections",
      `{ collections(first: 75) { nodes { id } } }`, (d) => d.collections?.nodes,
      (n) => client.mutate("collectionDelete", COLLECTION_DELETE, { input: { id: n.id } }));
    summary.discounts = (summary.discounts || 0) + await deleteAll("discounts",
      `{ codeDiscountNodes(first: 75) { nodes { id } } }`, (d) => d.codeDiscountNodes?.nodes,
      (n) => client.mutate("discountCodeDelete", DISCOUNT_DELETE, { id: n.id }));
    summary.articles = (summary.articles || 0) + await deleteAll("articles",
      `{ articles(first: 75) { nodes { id } } }`, (d) => d.articles?.nodes,
      (n) => client.mutate("articleDelete", ARTICLE_DELETE, { id: n.id }));
    summary.blogs = (summary.blogs || 0) + await deleteAll("blogs",
      `{ blogs(first: 50) { nodes { id } } }`, (d) => d.blogs?.nodes,
      (n) => client.mutate("blogDelete", BLOG_DELETE, { id: n.id }));
    summary.pages = (summary.pages || 0) + await deleteAll("pages",
      `{ pages(first: 75) { nodes { id } } }`, (d) => d.pages?.nodes,
      (n) => client.mutate("pageDelete", PAGE_DELETE, { id: n.id }));
    summary.customers = (summary.customers || 0) + await deleteAll("customers",
      `{ customers(first: 75) { nodes { id } } }`, (d) => d.customers?.nodes,
      (n) => client.mutate("customerDelete", CUSTOMER_DELETE, { id: n.id }));

    left = leftoverStoreCounts(await client.graphql(QUERY_COUNTS));
    if (wipeStoreEmpty(left)) break;
    log.warn(`wipe pass ${pass}: leftover ${JSON.stringify(left)} — continuing`);
  }

  // redirects: try the async bulk mutation, fall back to one-by-one
  // (bulk-all may require a user-context token, which client credentials isn't)
  try {
    await client.mutate("urlRedirectBulkDeleteAll", URL_REDIRECT_BULK_DELETE_ALL, {});
    log.info("  redirects: bulk delete job submitted");
    summary.redirects = "bulk-job";
  } catch {
    summary.redirects = await deleteAll("redirects",
      `{ urlRedirects(first: 75) { nodes { id } } }`, (d) => d.urlRedirects?.nodes,
      (n) => client.mutate("urlRedirectDelete", URL_REDIRECT_DELETE, { id: n.id }));
  }

  // local ledger — without this, the next import would "skip" everything
  if (cfg.paths?.state) {
    try {
      if (existsSync(cfg.paths.state)) rmSync(cfg.paths.state, { recursive: true, force: true });
      const vr = path.join(cfg.paths.data, "verify-report.json");
      if (existsSync(vr)) rmSync(vr, { force: true });
      log.info(`  local ledger cleared (${path.relative(process.cwd(), cfg.paths.state)})`);
    } catch (e) {
      log.warn(`  could not clear local ledger: ${e.message.slice(0, 100)} — delete ${cfg.paths.state} manually before re-importing`);
    }
  }

  if (!wipeStoreEmpty(left)) {
    throw new Error(`wipe incomplete: ${JSON.stringify(left)} remain on ${shop.myshopifyDomain} — re-run wipe`);
  }

  console.log(`\n  ${verdict(true, "WIPE COMPLETE")} ${c.dim(c.muted(JSON.stringify(summary)))}`);
  console.log(`  ${c.muted("WordPress source data is untouched. Next:")} ${c.key("node src/cli.js all")}`);
  return summary;
}
