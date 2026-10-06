import path from "node:path";
import { readJsonl, jsonlWriter, writeJson, readJson } from "../util/fsx.js";
import { writeFileSync } from "node:fs";
import { ensureDir } from "../util/fsx.js";
import { transformProduct, transformCategory, buildHostedshopConditionsCollections, DD_FOCUS_FRONTPAGE_TAG } from "./products.js";
import { transformCustomer } from "./customers.js";
import { transformOrder } from "./orders.js";
import { transformCoupon } from "./discounts.js";
import { transformPost, transformPage } from "./content.js";
import { buildRedirects, expandWildcardPaths } from "./redirects.js";
import { writeTranslationsJsonl, translationsEnabled } from "./translations.js";
import { toHandle, pathFromUrl } from "./html.js";
import { localeOf } from "../locales.js";
import { log } from "../log.js";

/**
 * Stage 2 — TRANSFORM
 * Converts raw WP snapshots into ready-to-send Shopify GraphQL inputs.
 * Pure and offline: no network calls, deterministic, re-runnable.
 * Everything questionable lands in warnings.jsonl for human review
 * BEFORE anything touches the Shopify store.
 */
export async function runTransform(cfg, entities, { locationId = "{{LOCATION_ID}}" } = {}) {
  const raw = cfg.paths.raw;
  const out = cfg.paths.transformed;
  const summary = readJson(path.join(raw, "summary.json"), {}) || {};
  const ctx = {
    cfg, locationId,
    sourceWeightUnit: summary.settings?.weightUnit,
    storeCurrency: summary.settings?.currency,
    optionCase: new Map(), // catalog-wide option-name case folding (Farve vs farve)
    L: localeOf(cfg),
    provenance: summary.settings?.provenance || summary.provenance || {
      productIdTag: "wp-id-", orderTag: "wc-order-", statusTag: "wc-status-", orderNamePrefix: "#WP"
    }
  };
  const allWarnings = [];
  const counts = {};

  // Warnings the SOURCE ADAPTER raised during export (see stages/export.js).
  // They are facts about the source that no record carries — a blog that is not
  // exported, a column the server dropped — so they cannot be re-derived here.
  // Folded in first so they lead the file, and re-read from raw/summary.json on
  // every transform re-run rather than being copied into a second store.
  //
  // EVERY field is defaulted, including `code` and `message`. summary.json is a
  // file on disk that a hand-edit, a truncated write or a future adapter can
  // shape freely — it is not an in-process value this function controls. A
  // warning with no `code` reached menu.js:604, which groups by `w.code` and
  // calls `.toUpperCase()` on the key, and crashed the whole status screen on a
  // missing string. Warnings are the mechanism that reports problems; they must
  // not become one.
  for (const w of Array.isArray(summary.warnings) ? summary.warnings : []) {
    if (!w || typeof w !== "object") continue;
    allWarnings.push({
      entity: w.entity ?? "source",
      id: w.id ?? "all",
      code: w.code || "SOURCE_WARNING",
      severity: w.severity || "action",
      message: w.message || "(the source adapter raised a warning with no message)",
    });
  }

  // ---- products ----
  const memberships = [];
  const groupedCols = [];
  const hostedshopVendors = [];
  let hostedshopFocusFrontpage = false;
  if (entities.products) {
    const w = jsonlWriter(path.join(out, "products.jsonl"));
    for (const p of readJsonl(path.join(raw, "products.jsonl"))) {
      const { input, warnings, membership, groupedCollection } = transformProduct(p, ctx);
      allWarnings.push(...warnings);
      if (input) {
        await w.write({ input, synchronous: false });
        memberships.push(membership);
        if (input.vendor) hostedshopVendors.push(input.vendor);
        if ((input.tags || []).includes(DD_FOCUS_FRONTPAGE_TAG)) hostedshopFocusFrontpage = true;
      }
      if (groupedCollection) groupedCols.push(groupedCollection);
    }
    counts.products = await w.close();
    writeJson(path.join(out, "product-memberships.json"), memberships);
  }

  // ---- categories -> collections ----
  const categories = [];
  if (entities.collections || entities.redirects) {
    for (const c of readJsonl(path.join(raw, "categories.jsonl"))) categories.push(transformCategory(c, ctx));
    if (entities.collections) {
      const customRows = [
        ...categories.map(({ slug, input }) => ({ slug, input })),
        ...groupedCols.map(({ slug, input, memberWooIds }) => ({ slug, input, memberWooIds })),
      ];
      let conditionsRows = [];
      const isHostedshop = cfg.source?.adapter === "dandomain" || cfg.source?.kind === "dandomain";
      if (isHostedshop) {
        const reservedHandles = new Set([
          ...categories.map((c) => c.input.handle),
          ...groupedCols.map((g) => g.input.handle),
        ]);
        const extra = buildHostedshopConditionsCollections({
          vendors: hostedshopVendors,
          hasFocusFrontpage: hostedshopFocusFrontpage,
          reservedHandles,
        });
        conditionsRows = extra.rows;
        allWarnings.push(...extra.warnings);
      }
      writeJson(path.join(out, "collections.json"), [...customRows, ...conditionsRows]);
      counts.collections = customRows.length + conditionsRows.length;
    }
  }

  // ---- handle-collision detection ----
  // Shopify handles are unique per resource type; imports upsert BY handle.
  // Two sources mapping to one handle therefore merge (collections) or
  // overwrite (products) SILENTLY unless someone is told. Real causes:
  // æøå transliteration overlap, underscore vs hyphen slugs, and grouped
  // products (which become collections) named like an existing category.
  if (entities.collections) {
    const byHandle = new Map();
    for (const c of categories) byHandle.set(c.input.handle, [...(byHandle.get(c.input.handle) || []), `category "${c.input.title}" (slug ${c.slug})`]);
    for (const g of groupedCols) byHandle.set(g.input.handle, [...(byHandle.get(g.input.handle) || []), `grouped product "${g.input.title}" (slug ${g.slug})`]);
    for (const [handle, sources] of byHandle) {
      if (sources.length > 1) allWarnings.push({ entity: "collection", id: handle, code: "HANDLE_COLLISION", severity: "handled", message: `${sources.join(" and ")} share the collection handle "${handle}" — they MERGE into one collection on import (last writer's title/description wins). Danish æ/ø/å fold to ae/oe/aa (Tilbehør = Tilbehoer); rename a slug only if they must stay separate.` });
    }
  }
  if (entities.products) {
    const pHandles = new Map();
    for (const m of memberships) pHandles.set(m.handle, [...(pHandles.get(m.handle) || []), m.wooId]);
    for (const [handle, ids] of pHandles) {
      if (ids.length > 1) allWarnings.push({ entity: "product", id: ids[1], code: "HANDLE_COLLISION", severity: "action", message: `Woo products ${ids.join(" and ")} both map to product handle "${handle}" — the later import OVERWRITES the earlier product (productSet upserts by handle). Rename one slug in WP before importing.` });
    }
  }

  // ---- customers ----
  if (entities.customers) {
    const w = jsonlWriter(path.join(out, "customers.jsonl"));
    for (const c of readJsonl(path.join(raw, "customers.jsonl"))) {
      const { line, warnings } = transformCustomer(c, ctx);
      allWarnings.push(...warnings);
      if (line) await w.write(line);
    }
    counts.customers = await w.close();
  }

  // ---- orders ----
  if (entities.orders) {
    const w = jsonlWriter(path.join(out, "orders.jsonl"));
    for (const o of readJsonl(path.join(raw, "orders.jsonl"))) {
      const { order, warnings } = transformOrder(o, ctx);
      allWarnings.push(...warnings);
      if (order) await w.write({ order });
    }
    counts.orders = await w.close();
  }

  // ---- coupons -> discounts ----
  if (entities.discounts) {
    const w = jsonlWriter(path.join(out, "discounts.jsonl"));
    let skipped = 0;
    for (const c of readJsonl(path.join(raw, "coupons.jsonl"))) {
      const { discount, warnings, skipped: s, productIds } = transformCoupon(c, ctx);
      allWarnings.push(...warnings);
      if (discount) await w.write({ basicCodeDiscount: discount, _wooProductIds: productIds }); else if (s) skipped++;
    }
    counts.discounts = await w.close();
    if (skipped) log.info(`  discounts: ${skipped} expired coupons skipped`);
  }

  // ---- posts -> articles, pages ----
  const postMeta = [], pageMeta = [];
  if (entities.articles) {
    const w = jsonlWriter(path.join(out, "articles.jsonl"));
    for (const p of readJsonl(path.join(raw, "posts.jsonl"))) {
      const t = transformPost(p, ctx);
      allWarnings.push(...(t.warnings || []));
      postMeta.push({ handle: t.handle, oldPath: t.oldPath });
      await w.write({ article: t.article, seo: t.seo });
    }
    counts.articles = await w.close();
  }
  if (entities.pages) {
    const w = jsonlWriter(path.join(out, "pages.jsonl"));
    for (const p of readJsonl(path.join(raw, "pages.jsonl"))) {
      const t = transformPage(p, ctx);
      allWarnings.push(...(t.warnings || []));
      pageMeta.push({ handle: t.handle, oldPath: t.oldPath });
      await w.write({ page: t.page, seo: t.seo });
    }
    counts.pages = await w.close();
  }

  // ---- product reviews (exported for the count; not importable) ----
  // Shopify has no native product-review store; review apps (Judge.me, Yotpo,
  // Loox) own that data and each ships its own importer. The pipeline's job
  // is to make sure nobody DISCOVERS this after go-live.
  if (entities.products) {
    const reviews = readJsonl(path.join(raw, "reviews.jsonl"));
    if (reviews.length) {
      allWarnings.push({ entity: "reviews", id: "all", code: "REVIEWS_NOT_MIGRATED", severity: "info", message: `${reviews.length} product review(s) exist in WooCommerce — Shopify has no native review import. Export them to your review app's importer (Judge.me/Yotpo/Loox) after products are live; raw/reviews.jsonl holds the full data.` });
    }
  }

  // ---- redirects ----
  if (entities.redirects) {
    const blogHandle = toHandle(cfg.shopify?.blog?.handle || ctx.L.blog.handle);
    const rd = summary.settings?.redirects;
    const wooCategoryBase = rd?.wooCategoryBase === false ? false : "/product-category";
    const extra = [];
    const inventory = urlInventory(raw, { memberships, categories, postMeta, pageMeta });
    for (const r of readJsonl(path.join(raw, "redirects.jsonl"))) {
      if (!r?.from || !r?.to) continue;
      if (/[?&]/.test(r.from)) {
        allWarnings.push({ entity: "redirect", id: r.id ?? r.from, code: "QUERY_URL_DROPPED", severity: "info", message: `SEO redirect ${r.from} carries a query string and is not imported (Shopify matches path only).` });
        continue;
      }
      if (String(r.from).includes("*")) {
        const hits = expandWildcardPaths(r.from, inventory);
        if (hits.length) {
          allWarnings.push({ entity: "redirect", id: r.id ?? r.from, code: "REDIRECT_WILDCARD_EXPANDED", severity: "handled", message: `SEO redirect ${r.from} expanded to ${hits.length} concrete path(s) from the URL inventory.` });
          for (const from of hits) extra.push({ from, to: r.to });
        } else {
          allWarnings.push({ entity: "redirect", id: r.id ?? r.from, code: "REDIRECT_WILDCARD_EXPANDED", severity: "action", message: `SEO redirect ${r.from} is a wildcard and matched no exported product/category/page old path — add the concrete paths by hand.` });
        }
        continue;
      }
      if (/302/i.test(String(r.type || ""))) {
        allWarnings.push({ entity: "redirect", id: r.id ?? r.from, code: "REDIRECT_302_UPGRADED", severity: "handled", message: `SEO redirect ${r.from} was a 302; Shopify urlRedirect is a 301.` });
      }
      extra.push({ from: r.from, to: r.to });
    }
    const { rows, csv } = buildRedirects({
      products: memberships.filter((m) => m.oldPath),
      categories: categories.map((c) => ({ handle: c.input.handle, slug: c.slug, oldPath: c.oldPath })),
      posts: postMeta, pages: pageMeta, blogHandle,
      wooCategoryBase,
      extra,
      structural: [
        ...(Array.isArray(rd?.structural) ? rd.structural : ctx.L.structural),
        ...groupedCols.filter((g) => g.oldPath).map((g) => [g.oldPath, `/collections/${g.slug}`])
      ]
    });
    ensureDir(out);
    writeFileSync(path.join(out, "redirects.csv"), csv);
    writeJson(path.join(out, "redirects.json"), rows);
    counts.redirects = rows.length;
  }

  // ---- translations (DanDomain secondary layers, flag-gated) ----
  if (translationsEnabled(cfg)) {
    const tr = await writeTranslationsJsonl(cfg, out);
    if (tr.written) counts.translations = tr.written;
  }

  // ---- warnings ----
  const ww = jsonlWriter(path.join(out, "warnings.jsonl"));
  for (const w of allWarnings) await ww.write(w);
  await ww.close();

  const severities = { action: 0, handled: 0, info: 0 };
  for (const w of allWarnings) severities[w.severity && severities[w.severity] !== undefined ? w.severity : "action"]++;
  writeJson(path.join(out, "summary.json"), { transformedAt: new Date().toISOString(), counts, warnings: allWarnings.length, severities });
  log.info(`Transform complete -> ${out}`);
  log.info(`  counts: ${JSON.stringify(counts)}`);
  if (severities.action) log.warn(`  ${severities.action} ACTION item(s) need a human: ${path.join(out, "warnings.jsonl")}`);
  if (severities.handled || severities.info) log.info(`  notes: ${severities.handled} auto-handled · ${severities.info} platform facts (no action needed)`);
  return { counts, warnings: allWarnings, severities };
}

function urlInventory(raw, { memberships, categories, postMeta, pageMeta }) {
  const paths = [];
  const add = (p) => { if (p) paths.push(String(p).replace(/\/$/, "") || "/"); };
  for (const m of memberships) add(m.oldPath);
  for (const c of categories) add(c.oldPath);
  for (const p of postMeta) add(p.oldPath);
  for (const p of pageMeta) add(p.oldPath);
  for (const rec of readJsonl(path.join(raw, "products.jsonl"))) add(pathFromUrl(rec.permalink));
  for (const rec of readJsonl(path.join(raw, "categories.jsonl"))) add(pathFromUrl(rec.permalink));
  for (const rec of readJsonl(path.join(raw, "pages.jsonl"))) add(pathFromUrl(rec.link || rec.permalink));
  for (const rec of readJsonl(path.join(raw, "posts.jsonl"))) add(pathFromUrl(rec.link || rec.permalink));
  return [...new Set(paths)];
}
