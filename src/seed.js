/**
 * seed.js — tiered test datasets, created ON the WordPress source store so
 * migrations can be tested at chosen realism/scale. All tiers are idempotent
 * (sentinel SKU/slug checks) and cumulative: heavy ⊃ medium ⊃ light.
 *
 *  light   ~1 min   every mapping edge case once: simple-on-sale, variable
 *                   2×2, virtual, grouped, 3 coupon types (incl. expired +
 *                   product-scoped), guest+registered buyers, completed/
 *                   processing/refunded orders, posts (internal links,
 *                   shortcodes), page.
 *  medium  ~3 min   + 60 batch products (pushes the import over the bulk-
 *                   operations threshold), a 3-attribute variable (12 var.),
 *                   10 customers, ~15 orders incl. multi-coupon + fee lines.
 *  heavy   ~10 min  + 280 more products (incl. long builder-shortcode HTML,
 *                   æøå/emoji/quote torture names), a 4-attribute "monster"
 *                   variable (16 var. -> tests >3-option merging), 30
 *                   customers, ~40 total orders. TasteWP-sized; a real VPS
 *                   handles more.
 */
import path from "node:path";
import { existsSync } from "node:fs";

export const TIERS = {
  light: "edge cases only (~10 products-equivalents, 3 orders)",
  medium: "light + bulk path (~75 products, 15 orders)",
  heavy: "medium + scale & pathological content (~355 products, 40 orders)",
  real: "STANDALONE realistic Danish SMB shop \"Example Living\" (~120 products, ~60 orders, 8 years of mess) — wipe WP first",
  "real-xl": "STANDALONE real + scale and every quirk we can reproduce (~350 products incl. a 120-variant one, ~70 orders, unicode/oversize/price/HTML/media probes) — wipe WP first"
};

/** Tiers that replace the source rather than adding to it — they assume a clean
 *  WP site and must be seeded with wipeFirst. Kept as data so callers (menu,
 *  docs, prompts) ask the question once instead of hardcoding tier names. */
export const STANDALONE_TIERS = new Set(["real", "real-xl"]);

const pad = (n) => String(n).padStart(4, "0");
const addr = (fn, ln, mail, country = "DK", city = "Aarhus", zip = "8000") =>
  ({ first_name: fn, last_name: ln, address_1: "Uldvej 7", city, postcode: zip, country, email: mail, phone: "+4530123456" });

export async function seedDataset({ api, site, tier = "light", logger = () => {} }) {
  if (!TIERS[tier]) throw new Error(`Unknown tier "${tier}" — use ${Object.keys(TIERS).join("/")}`);
  const summary = {};
  // standalone tiers — do NOT include light; seed onto a clean WP site
  if (tier === "real") {
    const { seedReal } = await import("./seed-real.js");
    summary.real = await seedReal({ api, site, logger });
    return summary;
  }
  if (tier === "real-xl") {
    // real-xl is a strict SUPERSET of real: it runs the whole Example Living
    // shop, then layers scale and the quirk probes on top. Keeping it built on
    // seedReal (rather than a parallel copy) is what guarantees the superset
    // relationship stays true as `real` evolves.
    const { seedRealXl } = await import("./seed-real-xl.js");
    summary["real-xl"] = await seedRealXl({ api, site, logger });
    return summary;
  }
  await seedLight(api, site, logger, summary);
  if (tier === "medium" || tier === "heavy") await seedMedium(api, logger, summary);
  if (tier === "heavy") await seedHeavy(api, logger, summary);
  return summary;
}

/**
 * Wipe a WordPress TEST site so tiers can be tested independently
 * (tiers are cumulative — after heavy, "light" needs a reset first).
 * Deletes ALL products, orders, coupons, non-admin customers, posts, pages.
 *
 * Source-side gate (invariant #4's counterpart): refuses when the active
 * pair's data/raw/summary.json exists — that file only exists once `export`
 * has run against this source, meaning it is a real migration source, not a
 * scratch test shop. The only override is an explicit source.allowDestructive:
 * true in the config file (no CLI flag, no env var — a human edits a file).
 * Callers that have no cfg (or no active pair yet) are not gated; every
 * agent/CLI/menu route passes cfg through so this cannot be bypassed by
 * routing around it.
 */
export async function wipeWordPress({ api, cfg = null, logger = () => {} }) {
  const isDd = cfg?.source?.adapter === "dandomain" || cfg?.source?.kind === "dandomain";
  if (isDd) {
    throw new Error(
      `"${cfg.source?.baseUrl || "this DanDomain source"}" is a DanDomain pair — wipeWordPress refuses to run against a DanDomain shop. This tool never deletes DanDomain source data (use the Hostedshop admin or the probe kit). The data/raw/summary.json source-wipe gate is for WordPress test sites only.`
    );
  }
  if (cfg?.paths?.raw && existsSync(path.join(cfg.paths.raw, "summary.json")) && cfg.source?.allowDestructive !== true) {
    throw new Error(`"${cfg.source?.baseUrl || "this WordPress source"}" has already been exported from (data/raw/summary.json exists for the active pair) — wipeWordPress refuses to run against what looks like a real migration source. Set source.allowDestructive: true in the config file to override. (No CLI flag, no env var exists — by design.)`);
  }
  const summary = {};
  const failures = [];
  /**
   * Per-item failures must NOT abort the wipe.
   *
   * util/http.js retries 429/5xx and network errors, but a 4xx is thrown
   * straight through — so before this, ONE unlucky row (a product WooCommerce
   * refuses to delete, a row already gone -> 404, a host edge returning 403 on
   * a burst of DELETEs) aborted the entire wipe mid-loop. Observed live
   * 2026-07-28: `seed {tier:real, wipeFirst:true}` deleted all orders and
   * coupons, died 38 products into 119, and left the source in a state that
   * was neither the old dataset nor a clean slate. stages/wipe.js (Shopify
   * side) already gets this right — log the item, keep going, and stop only
   * when an ENTIRE batch fails (that means systemic breakage, e.g. auth
   * revoked, not one bad row). This mirrors that behaviour so both sides of
   * the pipeline fail the same way.
   *
   * Failures are returned in the summary: a wipe that skipped rows must say so
   * loudly, because the caller's next move is usually to seed on top of it.
   */
  const wipe = async (label, listRoute, delRoute, opts = {}) => {
    let n = 0;
    for (;;) {
      const sep = listRoute.includes("?") ? "&" : "?";
      const rows = await api("GET", `${listRoute}${sep}per_page=100`);
      const targets = rows.filter((r) => !(opts.skipAdmins && r.role === "administrator"));
      if (!targets.length) break;
      let okCount = 0;
      for (const r of targets) {
        try {
          await api("DELETE", `${delRoute}/${r.id}?force=true${opts.extra || ""}`);
          okCount++;
          logger(`${label}: ${++n} deleted`);
        } catch (e) {
          failures.push({ label, id: r.id, error: String(e?.message || e).slice(0, 200) });
          logger(`${label}: ${r.id} FAILED — ${String(e?.message || e).slice(0, 120)}`);
        }
      }
      // every row in the batch failed -> systemic, not bad data. Stop instead
      // of looping forever re-fetching the same undeletable page.
      if (okCount === 0) {
        logger(`${label}: entire batch of ${targets.length} failed — stopping to avoid a loop`);
        break;
      }
      if (rows.length < 100) break;
    }
    summary[label] = n;
  };
  // orders first (reference products), then catalog, then people/content
  await wipe("orders", "wc/v3/orders?status=any", "wc/v3/orders");
  await wipe("coupons", "wc/v3/coupons", "wc/v3/coupons");
  await wipe("products", "wc/v3/products?status=any", "wc/v3/products"); // force also removes variations
  // category/tag terms survive product deletion and would pollute the next
  // dataset's collection counts — clear them too (default term is protected)
  const skipDefault = (rows) => rows.filter((r) => r.slug !== "uncategorized");
  const wipeTerms = async (label, route) => {
    let n = 0;
    for (;;) {
      const rows = skipDefault(await api("GET", `wc/v3/${route}?per_page=100`));
      if (!rows.length) break;
      let okCount = 0; // same per-item tolerance as wipe() above
      for (const r of rows) {
        try { await api("DELETE", `wc/v3/${route}/${r.id}?force=true`); okCount++; logger(`${label}: ${++n} deleted`); }
        catch (e) {
          failures.push({ label, id: r.id, error: String(e?.message || e).slice(0, 200) });
          logger(`${label}: ${r.id} FAILED — ${String(e?.message || e).slice(0, 120)}`);
        }
      }
      if (okCount === 0) { logger(`${label}: entire batch of ${rows.length} failed — stopping to avoid a loop`); break; }
      if (rows.length < 100) break;
    }
    summary[label] = n;
  };
  await wipeTerms("categories", "products/categories");
  await wipeTerms("tags", "products/tags");
  await wipe("customers", "wc/v3/customers?role=all", "wc/v3/customers", { skipAdmins: true, extra: "&reassign=0" });
  await wipe("posts", "wp/v2/posts", "wp/v2/posts");
  await wipe("pages", "wp/v2/pages", "wp/v2/pages");
  // surfaced, not swallowed — callers (and the seed that usually runs straight
  // after) must be able to see that the "clean slate" isn't fully clean
  if (failures.length) summary.failures = failures;
  return summary;
}

// ---------- shared helpers ----------
const ensureProduct = (api, logger) => async (payload) => {
  const existing = await api("GET", `wc/v3/products?slug=${payload.slug}`);
  if (existing[0]) return existing[0];
  try { return await api("POST", "wc/v3/products", payload); }
  catch (e) {
    if (payload.images && String(e.data?.code || "").includes("image")) {
      logger(`image rejected for ${payload.slug} — creating without image`);
      const { images, ...rest } = payload;
      return api("POST", "wc/v3/products", rest);
    }
    throw e;
  }
};

const ensureContent = (api) => async (route, payload) => {
  const existing = await api("GET", `${route}?slug=${payload.slug}`);
  return existing[0] ?? api("POST", route, payload);
};

async function ensureCategory(api, def) {
  const existing = await api("GET", `wc/v3/products/categories?slug=${def.slug}`);
  return existing[0]?.id ?? (await api("POST", "wc/v3/products/categories", def)).id;
}

async function batchProducts(api, logger, products, label) {
  let created = 0;
  for (let i = 0; i < products.length; i += 90) {
    const res = await api("POST", "wc/v3/products/batch", { create: products.slice(i, i + 90) });
    created += res.create?.filter((p) => p.id)?.length ?? 0;
    logger(`${label}: ${Math.min(i + 90, products.length)}/${products.length}`);
  }
  return created;
}

async function batchOrders(api, logger, orders, label) {
  const ids = [];
  for (let i = 0; i < orders.length; i += 20) {
    const res = await api("POST", "wc/v3/orders/batch", { create: orders.slice(i, i + 20) });
    ids.push(...(res.create || []).map((o) => o.id).filter(Boolean));
    logger(`${label}: ${Math.min(i + 20, orders.length)}/${orders.length}`);
  }
  return ids;
}

// ---------- LIGHT ----------
async function seedLight(api, site, logger, summary) {
  logger("light: edge-case set");
  const P = ensureProduct(api, logger);
  const C = ensureContent(api);

  const cats = {
    garn: await ensureCategory(api, { name: "Garn", slug: "garn", description: "Uldgarn i alle tykkelser og farver." }),
    tilbehoer: await ensureCategory(api, { name: "Strikketilbehør", slug: "strikketilbehoer", description: "Pinde og tilbehør." })
  };

  const merino = await P({
    name: "Merino Uldgarn 50g", slug: "merino-uldgarn-50g", type: "simple", status: "publish",
    sku: "WOOL-MERINO-50", regular_price: "49", sale_price: "39",
    description: `<p>Blødt merinould fra <a href="${site}/om-sulky-wool/">Sulky Wool</a>.</p>`,
    short_description: "<p>100% merinould, 50 g nøgle.</p>",
    manage_stock: true, stock_quantity: 120, weight: "0.05",
    categories: [{ id: cats.garn }], tags: [{ name: "merino" }],
    images: [{ src: "https://picsum.photos/id/1084/800/800.jpg", alt: "Merino uldgarn" }]
  });

  const sweater = await P({
    name: "Håndstrikket Sweater", slug: "haandstrikket-sweater", type: "variable", status: "publish",
    description: "<p>Håndstrikket sweater i ren uld.</p>", categories: [{ id: cats.garn }],
    attributes: [
      { name: "Størrelse", visible: true, variation: true, options: ["S", "M"] },
      { name: "Farve", visible: true, variation: true, options: ["Natur", "Grå"] }
    ]
  });
  let variationIds = (await api("GET", `wc/v3/products/${sweater.id}/variations?per_page=10`)).map((v) => v.id);
  if (!variationIds.length) {
    for (const [size, color, sku, price, sale] of [
      ["S", "Natur", "SWTR-S-NAT", "599", ""], ["S", "Grå", "SWTR-S-GRA", "599", ""],
      ["M", "Natur", "SWTR-M-NAT", "649", "549"], ["M", "Grå", "SWTR-M-GRA", "649", ""]
    ]) {
      const v = await api("POST", `wc/v3/products/${sweater.id}/variations`, {
        sku, regular_price: price, sale_price: sale, manage_stock: true, stock_quantity: 8, weight: "0.6",
        attributes: [{ name: "Størrelse", option: size }, { name: "Farve", option: color }]
      });
      variationIds.push(v.id);
    }
  }

  const pattern = await P({
    name: "Strikkeopskrift: Klassisk Sweater (PDF)", slug: "strikkeopskrift-sweater", type: "simple",
    status: "publish", sku: "PATTERN-001", regular_price: "29", virtual: true,
    description: "<p>Digital opskrift som PDF.</p>", categories: [{ id: cats.tilbehoer }]
  });
  await P({
    name: "Gavesæt Uld", slug: "gavesaet-uld", type: "grouped", status: "publish",
    description: "<p>Garn + opskrift samlet.</p>", grouped_products: [merino.id, pattern.id], categories: [{ id: cats.garn }]
  });

  for (const cpn of [
    { code: "WELCOME10", discount_type: "percent", amount: "10", minimum_amount: "100", usage_limit_per_user: 1 },
    { code: "SOMMER25", discount_type: "fixed_cart", amount: "25", date_expires: "2025-08-31T23:59:59" },
    { code: "WOOL5", discount_type: "fixed_product", amount: "5", product_ids: [merino.id] }
  ]) await api("POST", "wc/v3/coupons", cpn).catch((e) => { if (e.status !== 400) throw e; });

  const anna = await api("POST", "wc/v3/customers", {
    email: "anna@example.dk", first_name: "Anna", last_name: "Andersen",
    billing: addr("Anna", "Andersen", "anna@example.dk"), shipping: addr("Anna", "Andersen", "anna@example.dk")
  }).catch(async (e) => (e.status === 400 ? (await api("GET", "wc/v3/customers?email=anna@example.dk"))[0] : Promise.reject(e)));

  const prior = await api("GET", "wc/v3/orders?per_page=5");
  if (prior.length < 3) {
    const o1 = await api("POST", "wc/v3/orders", {
      status: "processing", customer_id: anna.id, set_paid: true,
      billing: addr("Anna", "Andersen", "anna@example.dk"), shipping: addr("Anna", "Andersen", "anna@example.dk"),
      line_items: [{ product_id: merino.id, quantity: 3 }, { product_id: sweater.id, variation_id: variationIds[0], quantity: 1 }],
      shipping_lines: [{ method_id: "flat_rate", method_title: "GLS Pakkeshop", total: "45.00" }]
    });
    await api("PUT", `wc/v3/orders/${o1.id}`, { status: "completed" });
    await api("POST", "wc/v3/orders", {
      status: "processing", set_paid: true,
      billing: addr("Bo", "Berg", "bo@example.dk"), shipping: addr("Bo", "Berg", "bo@example.dk"),
      line_items: [{ product_id: pattern.id, quantity: 1 }]
    });
    const o3 = await api("POST", "wc/v3/orders", {
      status: "processing", set_paid: true,
      billing: addr("Carla", "Clausen", "carla@example.dk"), shipping: addr("Carla", "Clausen", "carla@example.dk"),
      line_items: [{ product_id: merino.id, quantity: 1 }]
    });
    await api("PUT", `wc/v3/orders/${o3.id}`, { status: "refunded" });
  }

  await C("wp/v2/posts", {
    title: "Sådan vasker du uld", slug: "saadan-vasker-du-uld", status: "publish",
    content: `<p>Uld skal vaskes skånsomt. Se vores <a href="${merino.permalink}">merinogarn</a>.</p><p>Brug uldvaskemiddel.</p>`,
    excerpt: "Skånsom uldvask, trin for trin."
  });
  await C("wp/v2/posts", { title: "Strikkefestival 2026", slug: "strikkefestival-2026", status: "publish", content: "<p>Mød os på strikkefestivalen i september.</p>" });
  await C("wp/v2/pages", { title: "Om Sulky Wool", slug: "om-sulky-wool", status: "publish", content: "<p>Sulky Wool er et lille dansk garnunivers.</p>" });

  summary.light = { products: 4, coupons: 3, orders: 3, posts: 2, pages: 1, ids: { merino: merino.id, pattern: pattern.id, sweaterVariation: variationIds[0], sweater: sweater.id } };
  logger("light: done");
}

// ---------- MEDIUM ----------
async function seedMedium(api, logger, summary) {
  const sentinel = await api("GET", "wc/v3/products?sku=SEEDM-0001");
  const { merino, pattern } = summary.light.ids;
  const colors = ["Rød", "Blå", "Grøn", "Gul", "Natur", "Grå", "Sort", "Hvid"];

  if (!sentinel.length) {
    logger("medium: 60 batch products");
    const products = Array.from({ length: 60 }, (_, i) => ({
      name: `Uldgarn ${colors[i % colors.length]} №${pad(i + 1)}`,
      slug: `uldgarn-m-${pad(i + 1)}`, type: "simple", status: "publish",
      sku: `SEEDM-${pad(i + 1)}`, regular_price: String(29 + (i % 40)),
      ...(i % 3 === 0 ? { sale_price: String(19 + (i % 20)) } : {}),
      manage_stock: true, stock_quantity: 10 + (i % 90), weight: "0.05",
      short_description: `<p>Nøgle ${i + 1} — 100% uld.</p>`
    }));
    summary.mediumProducts = await batchProducts(api, logger, products, "medium products");
  } else { logger("medium: batch products already seeded"); summary.mediumProducts = 60; }

  // 3-attribute variable (exactly at Shopify's option limit)
  const P = ensureProduct(api, logger);
  const cardigan = await P({
    name: "Cardigan Trio", slug: "cardigan-trio", type: "variable", status: "publish",
    description: "<p>Cardigan med tre valg.</p>",
    attributes: [
      { name: "Størrelse", visible: true, variation: true, options: ["S", "M", "L"] },
      { name: "Farve", visible: true, variation: true, options: ["Natur", "Grå"] },
      { name: "Knapper", visible: true, variation: true, options: ["Træ", "Horn"] }
    ]
  });
  if (!(await api("GET", `wc/v3/products/${cardigan.id}/variations?per_page=5`)).length) {
    let n = 0;
    for (const s of ["S", "M", "L"]) for (const f of ["Natur", "Grå"]) for (const k of ["Træ", "Horn"]) {
      await api("POST", `wc/v3/products/${cardigan.id}/variations`, {
        sku: `CARD-${s}-${f.slice(0, 3)}-${k.slice(0, 3)}`.toUpperCase(), regular_price: "799",
        manage_stock: true, stock_quantity: 4, weight: "0.7",
        attributes: [{ name: "Størrelse", option: s }, { name: "Farve", option: f }, { name: "Knapper", option: k }]
      });
      if (++n % 4 === 0) logger(`medium: cardigan variations ${n}/12`);
    }
  }

  // customers + orders (multi-coupon + fee lines covered here)
  const custRes = await api("POST", "wc/v3/customers/batch", {
    create: Array.from({ length: 10 }, (_, i) => ({
      email: `kunde${i + 1}@example.dk`, first_name: `Kunde${i + 1}`, last_name: "Medium",
      billing: addr(`Kunde${i + 1}`, "Medium", `kunde${i + 1}@example.dk`), shipping: addr(`Kunde${i + 1}`, "Medium", `kunde${i + 1}@example.dk`)
    }))
  }).catch(() => ({ create: [] }));
  summary.mediumCustomers = custRes.create?.filter((c) => c.id)?.length ?? 0;

  const priorOrders = await api("GET", "wc/v3/orders?per_page=20");
  if (priorOrders.length < 15) {
    logger("medium: 12 orders (incl. multi-coupon + fee)");
    const seedmIds = (await api("GET", "wc/v3/products?sku=SEEDM-0001,SEEDM-0002,SEEDM-0003")).map((p) => p.id);
    const orders = Array.from({ length: 12 }, (_, i) => ({
      status: "processing", set_paid: true,
      billing: addr(`Kunde${(i % 10) + 1}`, "Medium", `kunde${(i % 10) + 1}@example.dk`),
      shipping: addr(`Kunde${(i % 10) + 1}`, "Medium", `kunde${(i % 10) + 1}@example.dk`),
      line_items: [{ product_id: [merino, pattern, ...seedmIds][i % (2 + seedmIds.length)], quantity: 1 + (i % 3) }],
      ...(i === 0 ? { coupon_lines: [{ code: "welcome10" }, { code: "wool5" }] } : {}),
      ...(i === 1 ? { fee_lines: [{ name: "Gaveindpakning", total: "25.00" }] } : {}),
      ...(i % 4 === 2 ? { shipping_lines: [{ method_id: "flat_rate", method_title: "GLS Pakkeshop", total: "45.00" }] } : {})
    }));
    const ids = await batchOrders(api, logger, orders, "medium orders");
    if (ids[2]) await api("POST", "wc/v3/orders/batch", { update: [{ id: ids[2], status: "completed" }, ...(ids[3] ? [{ id: ids[3], status: "cancelled" }] : [])] });
    summary.mediumOrders = ids.length;
  } else { summary.mediumOrders = 0; logger("medium: orders already seeded"); }

  const C = ensureContent(api);
  for (let i = 1; i <= 3; i++) {
    await C("wp/v2/posts", {
      title: `Strikkeguide del ${i}`, slug: `strikkeguide-${i}`, status: "publish",
      content: `[vc_row][vc_column]<p>Guide del ${i} med <strong>teknikker</strong> og billeder.</p>[/vc_column][/vc_row]<p>Mere indhold her.</p>`
    });
  }
  await C("wp/v2/pages", { title: "Handelsbetingelser", slug: "handelsbetingelser", status: "publish", content: "<p>Betingelser for køb hos Sulky Wool.</p>" });
  logger("medium: done");
}

// ---------- HEAVY ----------
async function seedHeavy(api, logger, summary) {
  const sentinel = await api("GET", "wc/v3/products?sku=SEEDH-0001");
  const torture = ['Gæstefår "Bøvl" & Co. 🐑', "O'Malley's Ø-garn <æøå>", "50% uld / 50% akryl — spar 20%!"];
  const longDesc = `[et_pb_section][et_pb_row][et_pb_column type="4_4"]<h2>Produktdetaljer</h2>${"<p>Kvalitetsuld fra danske får. Strikkefasthed 22 m. Pinde 4 mm. ".repeat(30)}</p>[/et_pb_column][/et_pb_row][/et_pb_section]<img src="https://picsum.photos/id/1025/600/400.jpg" alt="uld">`;

  if (!sentinel.length) {
    logger("heavy: 280 batch products (long HTML + torture names)");
    const products = Array.from({ length: 280 }, (_, i) => ({
      name: i % 70 === 0 ? `${torture[(i / 70) % torture.length | 0]} №${pad(i + 1)}` : `Lammeuld Nøgle №${pad(i + 1)}`,
      slug: `lammeuld-h-${pad(i + 1)}`, type: "simple", status: i % 25 === 0 ? "draft" : "publish",
      sku: `SEEDH-${pad(i + 1)}`, regular_price: String(19 + (i % 80)),
      ...(i % 5 === 0 ? { sale_price: String(15 + (i % 60)) } : {}),
      manage_stock: i % 7 !== 0, stock_quantity: i % 90, weight: String(0.05 + (i % 5) / 100),
      description: i % 10 === 0 ? longDesc : `<p>Lammeuld i høj kvalitet, nøgle ${i + 1}.</p>`,
      short_description: "<p>100% lammeuld.</p>"
    }));
    summary.heavyProducts = await batchProducts(api, logger, products, "heavy products");
  } else { logger("heavy: batch products already seeded"); summary.heavyProducts = 280; }

  // "monster": 4 variation attributes -> forces the >3-option merge path
  const P = ensureProduct(api, logger);
  const monster = await P({
    name: "Bestillingsgarn Deluxe (4 valg)", slug: "bestillingsgarn-deluxe", type: "variable", status: "publish",
    description: "<p>Fire attributter — tester Shopifys 3-options-grænse.</p>",
    attributes: [
      { name: "Størrelse", visible: true, variation: true, options: ["50g", "100g"] },
      { name: "Farve", visible: true, variation: true, options: ["Natur", "Indigo"] },
      { name: "Materiale", visible: true, variation: true, options: ["Merino", "Alpaka"] },
      { name: "Twist", visible: true, variation: true, options: ["Løs", "Fast"] }
    ]
  });
  if (!(await api("GET", `wc/v3/products/${monster.id}/variations?per_page=5`)).length) {
    let n = 0;
    for (const a of ["50g", "100g"]) for (const b of ["Natur", "Indigo"]) for (const m of ["Merino", "Alpaka"]) for (const t of ["Løs", "Fast"]) {
      await api("POST", `wc/v3/products/${monster.id}/variations`, {
        sku: `DLX-${a}-${b.slice(0, 3)}-${m.slice(0, 3)}-${t.slice(0, 3)}`.toUpperCase().replace("Ø", "O"),
        regular_price: String(99 + n * 3), manage_stock: true, stock_quantity: 3,
        attributes: [{ name: "Størrelse", option: a }, { name: "Farve", option: b }, { name: "Materiale", option: m }, { name: "Twist", option: t }]
      });
      if (++n % 4 === 0) logger(`heavy: monster variations ${n}/16`);
    }
  }

  await api("POST", "wc/v3/customers/batch", {
    create: Array.from({ length: 20 }, (_, i) => ({
      email: `heavy${i + 1}@example.${["dk", "de", "se"][i % 3]}`,
      first_name: i % 6 === 0 ? "" : `Køber${i + 1}`, last_name: i % 6 === 0 ? "(mangler fornavn)" : "Heavy",
      billing: addr(`Køber${i + 1}`, "Heavy", `heavy${i + 1}@example.dk`, ["DK", "DE", "SE"][i % 3], ["Aarhus", "Berlin", "Malmö"][i % 3], ["8000", "10115", "21119"][i % 3])
    }))
  }).catch(() => ({}));

  const priorOrders = await api("GET", "wc/v3/orders?per_page=50");
  if (priorOrders.length < 35) {
    logger("heavy: 25 more orders");
    const heavyIds = (await api("GET", "wc/v3/products?sku=SEEDH-0001,SEEDH-0002,SEEDH-0003,SEEDH-0004,SEEDH-0005")).map((p) => p.id);
    const orders = Array.from({ length: 25 }, (_, i) => ({
      status: "processing", set_paid: i % 5 !== 4,
      billing: addr(`Køber${(i % 20) + 1}`, "Heavy", `heavy${(i % 20) + 1}@example.dk`),
      shipping: addr(`Køber${(i % 20) + 1}`, "Heavy", `heavy${(i % 20) + 1}@example.dk`),
      line_items: [
        { product_id: heavyIds[i % heavyIds.length], quantity: 1 + (i % 4) },
        ...(i % 3 === 0 ? [{ product_id: heavyIds[(i + 2) % heavyIds.length], quantity: 1 }] : [])
      ],
      ...(i % 6 === 0 ? { fee_lines: [{ name: "Betalingsgebyr", total: "9.50" }] } : {}),
      ...(i % 4 === 1 ? { shipping_lines: [{ method_id: "flat_rate", method_title: "PostNord", total: "39.00" }] } : {})
    }));
    const ids = await batchOrders(api, logger, orders, "heavy orders");
    const updates = ids.filter((_, i) => i % 3 === 0).map((id) => ({ id, status: "completed" }));
    if (ids[7]) updates.push({ id: ids[7], status: "refunded" });
    for (let i = 0; i < updates.length; i += 20) await api("POST", "wc/v3/orders/batch", { update: updates.slice(i, i + 20) });
    summary.heavyOrders = ids.length;
  } else { summary.heavyOrders = 0; logger("heavy: orders already seeded"); }

  const C = ensureContent(api);
  for (let i = 1; i <= 5; i++) {
    await C("wp/v2/posts", {
      title: `Uldens verden ${i}: æøå & "citater"`, slug: `uldens-verden-${i}`, status: "publish",
      content: `[gallery ids="1,2,3"]<p>Langt indlæg ${i}. ${"Uld er fantastisk. ".repeat(60)}</p><blockquote>Citat med <em>formatering</em> &amp; entiteter.</blockquote>`
    });
  }
  logger("heavy: done");
}
