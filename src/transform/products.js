import { cleanHtml, toHandle, extractSeo, pathFromUrl, decodeEntities, truncateTitle, TITLE_MAX } from "./html.js";
import { productMetafieldsFromMeta } from "./dd-metafields.js";

const cleanSku = (s) => (typeof s === "string" ? s.trim() : s) || undefined; // padded SKUs break exact-match resolution

/**
 * WooCommerce product -> Shopify ProductSetInput (GraphQL Admin API, 2026).
 *
 * Uses the current product model:
 *  - productSet upserts product + options + variants in one call (sync or bulk)
 *  - up to 3 options, 2048 variants, 250 media per product
 *  - weight lives on inventoryItem.measurement, quantities on inventoryQuantities
 *  - `files` with originalSource = Shopify downloads images from the WP site
 *
 * Refs: shopify.dev productSet, "2048 variant limit", bulk import docs.
 */
const WEIGHT_UNITS = { kg: "KILOGRAMS", g: "GRAMS", lbs: "POUNDS", lb: "POUNDS", oz: "OUNCES" };

const money = (v) => (v === "" || v === null || v === undefined ? null : String(Number(v)));

// Shopify stores money at 2 decimals. A source price with more precision does
// NOT import as itself, and anything under half a cent rounds to 0.00 — the
// product goes live FREE. Woo shops reach sub-cent prices legitimately (per-gram
// yarn, per-cm cable, importer feeds carrying 4-decimal wholesale), so this is
// not a data error to reject; it is a value change to perform HERE and declare,
// rather than let Shopify do it silently on write. Same principle as the field
// limits (D12-D14): enforce the platform's shape at transform, not at import.
export const MONEY_DP = 2;

export function transformProduct(p, ctx) {
  const warnings = [];
  const { cfg, locationId, currencyNote } = ctx;
  const o = cfg.options;

  if (p.type === "grouped") {
    // A grouped product is a price-less container — Shopify products REQUIRE a
    // priced variant, so the true equivalent is a collection of its members.
    const gHandle = toHandle(p.slug || p.name);
    const gBody = cleanHtml(p.description, { baseUrl: cfg.source.baseUrl });
    warnings.push({ entity: "product", id: p.id, code: "GROUPED_CONVERTED", severity: "handled", message: `Woo grouped product "${p.name}" auto-converted to collection /collections/${gHandle} with its member products; old URL redirected there.` });
    return {
      input: null, warnings, membership: null,
      groupedCollection: {
        slug: gHandle,
        input: { title: p.name, handle: gHandle, descriptionHtml: gBody.html || undefined, ...(p.images?.[0]?.src ? { image: { src: p.images[0].src, altText: p.images[0].alt || p.name } } : {}) },
        memberWooIds: p.grouped_products || [],
        oldPath: pathFromUrl(p.permalink)
      }
    };
  }
  if (p.type === "external") {
    warnings.push({ entity: "product", id: p.id, code: "UNSUPPORTED_TYPE", severity: "action", message: `Woo external/affiliate product "${p.name}" cannot exist on Shopify (no checkout for external URLs) — link it from a page or drop it.` });
    return { input: null, warnings, membership: null };
  }

  const handleBase = toHandle(p.slug || p.name);
  let handle = handleBase;
  const isDd = (p.meta_data || []).some((m) => m.key === "_dd_id");
  if (isDd && !p.slug) {
    warnings.push({ entity: "product", id: p.id, code: "EMPTY_PRODUCT_SEOLINK", severity: "action", message: `"${p.name}" has no SeoLink. The storefront path cannot be composed (R41 records a category title fallback, not a product one) — no redirect is emitted, and the Shopify handle is derived from the title. Do not invent a slug the storefront never served.` });
    if (handleBase === "item") {
      handle = `item-${p.id}`;
      warnings.push({ entity: "product", id: p.id, code: "HANDLE_FALLBACK_ITEM", severity: "action", message: `"${p.name}" has no SeoLink and its title does not slugify, so the Shopify handle is "${handle}" (id suffix is handle-only; oldPath stays null). Rename before importing if this is not the handle you want.` });
    }
  }
  let status = p.status === "publish" ? o.productStatus : "DRAFT";
  const body = cleanHtml(p.description, { baseUrl: cfg.source.baseUrl, stripShortcodes: o.stripShortcodes, rewriteInternalLinks: o.rewriteInternalLinks });
  if (body.wordHtml) warnings.push({ entity: "product", id: p.id, code: "WORD_HTML", severity: "handled", message: `"${p.name}": description contained Word-paste markup (mso- styles) — cleaned automatically; eyeball the description on Shopify.` });
  if (body.unresolvedLinks.length) warnings.push({ entity: "product", id: p.id, code: "UNRESOLVED_LINK", severity: "info", message: `"${p.name}": ${body.unresolvedLinks.length} ID-based internal link(s) (${body.unresolvedLinks.slice(0, 3).join(", ")}) can't be mapped to a new URL — they still point at the old site. Fix manually or let the domain redirect catch them.` });
  const seo = extractSeo(p);
  const weightUnit = WEIGHT_UNITS[(ctx.sourceWeightUnit || "").toLowerCase()] || o.weightUnit;

  // digital products: Woo download files (PDF patterns etc.) have no Shopify
  // equivalent in this pipeline — the products import fine but their FILES
  // don't. That's lost merchandise unless a human acts (Digital Downloads
  // app / re-upload), so it's an action item.
  const downloads = [...(p.downloads || []), ...(p._variations || []).flatMap((v) => v.downloads || [])];
  if ((p.downloadable || (p._variations || []).some((v) => v.downloadable)) && downloads.length) {
    warnings.push({ entity: "product", id: p.id, code: "DIGITAL_FILES", severity: "action", message: `"${p.name}" is downloadable with ${downloads.length} file(s) (${downloads.slice(0, 2).map((d) => d.name || d.file).join(", ")}) — file assets do NOT migrate. Re-attach via a digital-delivery app (e.g. Shopify Digital Downloads) before go-live.` });
  }

  // ----- options (max 3 on Shopify) -----
  let variationAttrs = (p.attributes || []).filter((a) => a.variation);
  if (p.type !== "variable") variationAttrs = [];

  // case-fold option names across the catalog: "Farve" vs "farve" on two
  // products would surface as two distinct filter dimensions on Shopify.
  // First-seen casing wins; the fold is per-run deterministic (export order).
  if (ctx.optionCase) {
    variationAttrs = variationAttrs.map((a) => {
      const canonical = ctx.optionCase.get(a.name.toLowerCase());
      if (canonical === undefined) { ctx.optionCase.set(a.name.toLowerCase(), a.name); return a; }
      if (canonical !== a.name) {
        warnings.push({ entity: "product", id: p.id, code: "OPTION_CASE_FOLDED", severity: "handled", message: `"${p.name}": option name "${a.name}" folded to "${canonical}" (first-seen casing) so Shopify filters/option names stay consistent.` });
        return { ...a, name: canonical };
      }
      return a;
    });
  }
  if (variationAttrs.length > 3) {
    warnings.push({ entity: "product", id: p.id, code: "TOO_MANY_OPTIONS", severity: "handled", message: `"${p.name}" has ${variationAttrs.length} variation attributes; Shopify allows 3. Extra attributes were merged into option 3.` });
    const extras = variationAttrs.slice(2);
    // NB: Shopify rejects the sequence " / " in option names — use " & "
    variationAttrs = [
      ...variationAttrs.slice(0, 2),
      { name: extras.map((a) => a.name).join(" & "), options: null, _merged: extras.map((a) => a.name) }
    ];
  }

  // ----- variants -----
  const mkInventory = (v) => {
    const qty = v.manage_stock && Number.isFinite(Number(v.stock_quantity)) ? Math.max(0, Number(v.stock_quantity)) : null;
    return {
      inventoryItem: {
        tracked: Boolean(o.trackInventory && v.manage_stock),
        requiresShipping: !(v.virtual || v.downloadable),
        ...(v.weight ? { measurement: { weight: { value: Number(v.weight), unit: weightUnit } } } : {})
      },
      ...(qty !== null && locationId ? { inventoryQuantities: [{ locationId, name: "available", quantity: qty }] } : {})
    };
  };

  let saleAnomaly = null;
  const rounded = []; // { from, to } for every price this product had to reshape
  const toMoney = (v) => {
    if (v === null || v === undefined) return v;
    const exact = Number(v);
    const fixed = exact.toFixed(MONEY_DP);
    if (Number(fixed) !== exact) rounded.push({ from: String(exact), to: fixed });
    return fixed;
  };
  const mkPrices = (v) => {
    const regular = money(v.regular_price);
    const sale = money(v.sale_price);
    const effective = money(v.price) ?? sale ?? regular ?? "0";
    // data-entry error guard: "sale" ABOVE regular would import the higher
    // price as the selling price. Sell at regular, drop the bogus sale.
    if (sale !== null && regular !== null && Number(sale) > Number(regular)) {
      saleAnomaly = { sale, regular };
      return { price: toMoney(regular) };
    }
    const onSale = sale !== null && regular !== null && Number(sale) < Number(regular);
    return { price: toMoney(onSale ? sale : effective), ...(onSale ? { compareAtPrice: toMoney(regular) } : {}) };
  };

  let productOptions;
  let variants;

  if (p.type === "variable" && Array.isArray(p._variations) && p._variations.length) {
    const optionNames = variationAttrs.map((a) => a.name);
    const valueSets = optionNames.map(() => new Set());

    variants = p._variations.map((v) => {
      const byAttr = Object.fromEntries((v.attributes || []).map((a) => [a.name?.toLowerCase(), a.option]));
      const optionValues = optionNames.map((name, i) => {
        let value;
        const src = variationAttrs[i];
        if (src?._merged) value = src._merged.map((n) => byAttr[n.toLowerCase()] ?? "-").join(" & ");
        else value = byAttr[name.toLowerCase()] ?? "Default";
        valueSets[i].add(value);
        return { optionName: name, name: value };
      });
      return {
        optionValues,
        sku: cleanSku(v.sku),
        barcode: v.meta_data?.find((m) => ["_barcode", "barcode", "_global_unique_id"].includes(m.key))?.value || v.global_unique_id || undefined,
        taxable: v.tax_status ? v.tax_status === "taxable" : true,
        inventoryPolicy: v.backorders && v.backorders !== "no" ? "CONTINUE" : "DENY",
        ...(v.image?.src ? { file: { originalSource: v.image.src, contentType: "IMAGE" } } : {}),
        ...mkPrices(v),
        ...mkInventory(v)
      };
    });

    if (variants.length > 2048) {
      warnings.push({ entity: "product", id: p.id, code: "VARIANT_LIMIT", severity: "action", message: `"${p.name}" has ${variants.length} variants; Shopify caps at 2048. Excess variants dropped — split the product.` });
      variants = variants.slice(0, 2048);
    }

    productOptions = optionNames.map((name, i) => ({ name, position: i + 1, values: [...valueSets[i]].map((v) => ({ name: v })) }));
  } else {
    productOptions = undefined; // single default variant
    variants = [{
      optionValues: [{ optionName: "Title", name: "Default Title" }],
      sku: cleanSku(p.sku),
      taxable: p.tax_status ? p.tax_status === "taxable" : true,
      inventoryPolicy: p.backorders && p.backorders !== "no" ? "CONTINUE" : "DENY",
      ...mkPrices(p),
      ...mkInventory(p)
    }];
    productOptions = [{ name: "Title", position: 1, values: [{ name: "Default Title" }] }];
  }

  // ----- media -----
  const files = (p.images || []).slice(0, 250).map((img) => ({
    originalSource: img.src, alt: img.alt || p.name, contentType: "IMAGE"
  }));
  if ((p.images || []).length > 250) warnings.push({ entity: "product", id: p.id, code: "MEDIA_LIMIT", severity: "action", message: `"${p.name}" has ${p.images.length} images; Shopify caps media at 250 per product.` });

  const prov = ctx.provenance || { productIdTag: "wp-id-" };
  const tags = [...(p.tags || []).map((t) => t.name), `${prov.productIdTag}${p.id}`];

  // A price that ROUNDS to zero is the same horror as a price that IS zero, but
  // it used to slip past the guard below: the old check tested the source value,
  // and 0.001 is not 0. Shopify then stored 0.00 and the product went live free
  // with no warning anywhere (found on a live real-xl run, D15). Report it
  // separately from a genuinely priceless product — the source value is the
  // thing a human needs to see, and the fix is different (re-price vs. price).
  const roundedToZero = rounded.filter((r) => Number(r.to) === 0);
  if (roundedToZero.length) {
    // Park it as DRAFT, and note the difference from the ZERO_PRICE case below:
    // there the merchant CHOSE 0 (free sample, comped item) and overriding them
    // would be presumptuous. Here the merchant chose a non-zero price and the
    // zero is an artifact WE introduced by rounding to Shopify's precision — so
    // shipping it sellable is this tool's bug, not the merchant's decision.
    // A warning alone is fail-OPEN: it relies on someone reading it, which is
    // precisely what did not happen when D15 shipped a live free product past a
    // green run. Nothing is lost — the product migrates whole and one click in
    // Shopify publishes it once it has a real price.
    const wasPublished = status !== "DRAFT";
    status = "DRAFT";
    warnings.push({ entity: "product", id: p.id, code: "PRICE_ROUNDED_TO_ZERO", severity: "action", message: `"${p.name}" has a price of ${roundedToZero[0].from} — below Shopify's smallest unit (${MONEY_DP} decimals), so it becomes 0.00 and would sell as FREE.${wasPublished ? " Imported as DRAFT so it cannot be bought at that price" : " Already draft"}; re-price it (e.g. per 100 units) and publish when it is right.` });
  }
  const roundedNonZero = rounded.filter((r) => Number(r.to) !== 0);
  if (roundedNonZero.length) {
    const { from, to } = roundedNonZero[0];
    warnings.push({ entity: "product", id: p.id, code: "PRICE_ROUNDED", severity: "handled", message: `"${p.name}": ${roundedNonZero.length} price(s) carried more than ${MONEY_DP} decimals and were rounded to fit Shopify (e.g. ${from} -> ${to}). Verify margins if these came from a supplier feed.` });
  }

  // zero-price guard: a priceless product/variant imports as FREE merchandise —
  // the classic migration horror. Loudly a human's problem.
  if (!roundedToZero.length && variants.some((v) => !v.price || Number(v.price) === 0)) {
    warnings.push({ entity: "product", id: p.id, code: "ZERO_PRICE", severity: "action", message: `"${p.name}" has variant(s) with price 0 — will sell as FREE on Shopify. Set a price or unpublish before go-live.` });
  }
  if (saleAnomaly) {
    warnings.push({ entity: "product", id: p.id, code: "SALE_GTE_REGULAR", severity: "handled", message: `"${p.name}": sale price ${saleAnomaly.sale} is HIGHER than regular ${saleAnomaly.regular} (data-entry error) — imported at regular price, bogus sale dropped.` });
  }

  // Shopify rejects a product whose title exceeds 255 characters
  // (INVALID_PRODUCT, "is too long"). WooCommerce has no such limit and stores
  // long SEO-stuffed titles verbatim — a 312-character one killed an otherwise
  // clean import (real-xl, 2026-07-29). Truncating here turns a hard import
  // failure into a lossy-but-visible decision, which is invariant 5: reshape
  // loudly rather than fail late.
  const rawTitle = decodeEntities(p.name).trim();
  const title = truncateTitle(rawTitle);
  if (title !== rawTitle) {
    warnings.push({ entity: "product", id: p.id, code: "TITLE_TRUNCATED", severity: "action", message: `"${rawTitle.slice(0, 60)}…" has a ${rawTitle.length}-character title — Shopify's limit is ${TITLE_MAX}. Truncated to fit; shorten it deliberately before go-live so the cut lands where you want it.` });
  }

  const metafields = productMetafieldsFromMeta(p.meta_data);
  const input = {
    title,
    handle,
    status,
    descriptionHtml: body.html,
    vendor: p.brands?.[0]?.name || p.meta_data?.find((m) => m.key === "_brand")?.value || undefined,
    productType: p.categories?.[0]?.name || undefined,
    tags,
    productOptions,
    variants,
    ...(files.length ? { files } : {}),
    ...(seo.title || seo.description ? { seo: { title: seo.title, description: seo.description } } : {}),
    ...(metafields.length ? { metafields } : {}),
  };

  return {
    input,
    warnings,
    membership: {
      wooId: p.id, handle,
      categorySlugs: (p.categories || []).map((c) => c.slug || toHandle(c.name)),
      oldPath: pathFromUrl(p.permalink),
      skus: variants.map((v) => v.sku).filter(Boolean)
    }
  };
}

/** Woo category -> Shopify custom collection input (+ redirect info). */
export function transformCategory(c, ctx) {
  const body = cleanHtml(c.description, { baseUrl: ctx.cfg.source.baseUrl });
  return {
    slug: c.slug || toHandle(c.name),
    parentId: c.parent || 0,
    input: {
      title: c.name,
      handle: toHandle(c.slug || c.name),
      descriptionHtml: body.html || undefined,
      ...(c.image?.src ? { image: { src: c.image.src, altText: c.image.alt || c.name } } : {})
    },
    oldPath: pathFromUrl(c.permalink)
  };
}

export const DD_FOCUS_FRONTPAGE_TAG = "dd-focus-frontpage";
export const DD_FOCUS_CART_TAG = "dd-focus-cart";
export const FOCUS_FORSIDE_HANDLE = "fokus-forside";
export const FOCUS_FORSIDE_TITLE = "Fokus forside";
export const BRAND_HANDLE_PREFIX = "brand-";

function conditionsCollectionInput({ title, handle, sourceTitle, condition }) {
  return {
    title,
    handle,
    sources: [{
      source: {
        title: sourceTitle,
        targetType: "PRODUCTS",
        inclusion: {
          matchType: "ALL",
          conditions: [condition],
        },
      },
    }],
  };
}

/**
 * Hostedshop-only extra rows for collections.json.
 * Category/pakke rows stay `{ slug, input }` with no `kind`.
 * Skip (do not merge) when the brand/focus handle is already reserved.
 */
export function buildHostedshopConditionsCollections({
  vendors = [],
  hasFocusFrontpage = false,
  reservedHandles = new Set(),
} = {}) {
  const rows = [];
  const warnings = [];
  const used = new Set(reservedHandles);
  const seenVendor = new Set();

  for (const raw of vendors) {
    const vendor = typeof raw === "string" ? raw.trim() : "";
    if (!vendor || seenVendor.has(vendor)) continue;
    seenVendor.add(vendor);
    const handle = `${BRAND_HANDLE_PREFIX}${toHandle(vendor)}`;
    if (used.has(handle)) {
      warnings.push({
        entity: "collection",
        id: handle,
        code: "HANDLE_COLLISION",
        severity: "handled",
        message: `automated brand collection for vendor "${vendor}" skipped because collection handle "${handle}" is already used — the brand page is not created. Rename a slug if they must stay separate.`,
      });
      continue;
    }
    used.add(handle);
    rows.push({
      slug: handle,
      kind: "conditions",
      collection: conditionsCollectionInput({
        title: vendor,
        handle,
        sourceTitle: "vendor",
        condition: { productVendor: { relation: "EQUALS", values: [vendor], matchType: "ANY" } },
      }),
    });
  }

  if (hasFocusFrontpage) {
    const handle = FOCUS_FORSIDE_HANDLE;
    if (used.has(handle)) {
      warnings.push({
        entity: "collection",
        id: handle,
        code: "HANDLE_COLLISION",
        severity: "handled",
        message: `automated Fokus-forside collection skipped because collection handle "${handle}" is already used — the focus page is not created. Rename a slug if they must stay separate.`,
      });
    } else {
      used.add(handle);
      rows.push({
        slug: handle,
        kind: "conditions",
        collection: conditionsCollectionInput({
          title: FOCUS_FORSIDE_TITLE,
          handle,
          sourceTitle: "tag",
          condition: { productTag: { relation: "TAGGED_WITH", values: [DD_FOCUS_FRONTPAGE_TAG], matchType: "ANY" } },
        }),
      });
    }
  }

  return { rows, warnings };
}
