/**
 * Flag-gated kundegruppe → B2B catalog importer (PLAN §11).
 * Off by default — group-scoped prices stay as export warnings only.
 *
 * 2026-01 CatalogCreateInput requires `context`. PriceListCreateInput requires
 * `parent`. Group prices must NOT attach to a market catalog (would leak onto
 * the public storefront). Company + companyLocation is the B2B path.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readJsonl } from "../util/fsx.js";
import {
  CATALOG_CREATE,
  PRICE_LIST_CREATE,
  PRICE_LIST_FIXED_PRICES_ADD,
  COMPANY_CREATE,
  QUERY_COMPANIES,
  QUERY_SHOP_CURRENCY,
} from "../shopify/mutations.js";
import { log } from "../log.js";
import { writeFailedJsonl } from "../util/fsx.js";

function flagOn(cfg) {
  return cfg.options?.importB2bPricing === true;
}

function mapGroups(g) {
  return g.map((x) => ({ id: String(x.id ?? x.Id), title: x.title || x.Title || String(x.id ?? x.Id) }));
}

function loadGroups(cfg) {
  const settingsPath = path.join(cfg.paths.raw, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      const g = s.customer_groups || s._dd_customer_groups || s.customerGroups;
      if (Array.isArray(g) && g.length) return mapGroups(g);
    } catch { /* fall through */ }
  }
  const summaryPath = path.join(cfg.paths.raw, "summary.json");
  if (existsSync(summaryPath)) {
    try {
      const s = JSON.parse(readFileSync(summaryPath, "utf8"));
      const g = s.settings?.customerGroups || s.settings?.customer_groups || s.customerGroups;
      if (Array.isArray(g) && g.length) return mapGroups(g);
    } catch { /* fall through */ }
  }
  const custPath = path.join(cfg.paths.raw, "customers.jsonl");
  if (!existsSync(custPath)) return [];
  const seen = new Map();
  for (const c of readJsonl(custPath)) {
    const groupId = c._dd?.groupId;
    const meta = Object.fromEntries((c.meta_data || []).map((m) => [m.key, m.value]));
    const g = groupId || meta._dd_customer_group;
    if (g && !seen.has(String(g))) seen.set(String(g), { id: String(g), title: String(meta._dd_customer_group || g) });
  }
  return [...seen.values()];
}

/** Group-scoped ProductDiscount rows captured in raw product meta (_dd_group_discounts). */
function loadGroupPrices(cfg) {
  const productsPath = path.join(cfg.paths.raw, "products.jsonl");
  if (!existsSync(productsPath)) return [];
  const rows = [];
  for (const p of readJsonl(productsPath)) {
    const meta = Object.fromEntries((p.meta_data || []).map((m) => [m.key, m.value]));
    const raw = meta._dd_group_discounts;
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const d of parsed) {
      if (!d?.userId || d.price == null) continue;
      rows.push({
        productId: String(p.id),
        userId: String(d.userId),
        variantId: d.variantId && d.variantId !== "0" ? String(d.variantId) : null,
        price: String(d.price),
      });
    }
  }
  return rows;
}

function variantLedgerKey(productId, variantId) {
  return variantId ? `${productId}:${variantId}` : String(productId);
}

export function isB2bCapabilityError(e) {
  const msg = `${e?.message || ""} ${JSON.stringify(e?.userErrors || [])}`;
  return /B2B is not enabled|B2B.*not (?:enabled|available)|not enabled on this shop|ACCESS_DENIED.*[Cc]ompan|companies.*access|requires Shopify Plus|PLUS.*B2B|B2B.*Plus|UNPERMITTED_ENTITLEMENTS_DIRECT_CATALOG_ASSIGNMENT|company locations can't be set to active with your plan/i.test(msg);
}

export function isCompanyTaken(e) {
  const msg = `${e?.message || ""} ${JSON.stringify(e?.userErrors || [])}`;
  return /TAKEN/i.test(msg) && /externalId|external id/i.test(msg);
}

function companyNodes(data) {
  if (Array.isArray(data?.companies?.nodes)) return data.companies.nodes;
  if (Array.isArray(data?.companies?.edges)) return data.companies.edges.map((e) => e.node).filter(Boolean);
  return [];
}

async function lookupCompany(client, externalId, name) {
  if (typeof client.graphql !== "function") return null;
  const queries = [`external_id:${externalId}`];
  if (name) queries.push(`name:${JSON.stringify(name)}`);
  for (const query of queries) {
    const data = await client.graphql(QUERY_COMPANIES, { query });
    const nodes = companyNodes(data);
    const match = nodes.find((c) => c.externalId === externalId)
      || nodes.find((c) => name && c.name === name)
      || (nodes.length === 1 ? nodes[0] : null);
    if (match) return match;
  }
  return null;
}

/** 2026-01 companyCreate docs return locations.edges.node; some clients still send nodes. */
export function companyLocationId(payload) {
  const company = payload?.company || payload;
  const locs = company?.locations;
  return locs?.nodes?.[0]?.id
    || locs?.edges?.[0]?.node?.id
    || payload?.companyLocation?.id
    || null;
}

async function resolveShopCurrency(client, fallback) {
  if (typeof client.graphql === "function") {
    try {
      const data = await client.graphql(QUERY_SHOP_CURRENCY);
      const code = data?.shop?.currencyCode;
      if (code) return code;
    } catch { /* use fallback */ }
  }
  return fallback || "DKK";
}

function capabilityResult(e) {
  const shopMsg = e?.message || "B2B is not enabled on this shop (company/catalogs)";
  const reason = `${shopMsg} Group prices stay on _dd_group_discounts; public price remains R42.`;
  log.warn(`B2B_NOT_AVAILABLE: ${shopMsg}`);
  return { imported: 0, failed: 0, pricesAttached: 0, capabilitySkip: true, shopCapability: true, reason };
}

export async function importB2bPricing(cfg, client, idmap) {
  if (!flagOn(cfg)) {
    return { skipped: true, reason: "importB2bPricing flag off" };
  }
  const groups = loadGroups(cfg);
  const groupPrices = loadGroupPrices(cfg);
  const pricedIds = new Set(groupPrices.map((r) => r.userId));
  const needed = groups.filter((g) => pricedIds.has(String(g.id)));
  if (!needed.length) {
    log.info("B2B: flag on but no customer groups with _dd_group_discounts — nothing to create");
    return { imported: 0, failed: 0, skippedEmpty: true };
  }
  if (cfg.options.dryRun) {
    return { imported: 0, failed: 0, dryRun: true, wouldImport: needed.length, wouldPrice: groupPrices.length };
  }

  const currency = await resolveShopCurrency(client, cfg.options?.currency);
  let imported = 0;
  let failed = 0;
  let pricesAttached = 0;
  const failures = [];

  for (const g of needed) {
    const key = `b2b-group:${g.id}`;
    let catalogId = idmap.get("b2bCatalogs", key);
    let priceListId = idmap.get("b2bPriceLists", key);
    if (!catalogId) {
      const externalId = `dd-group-${g.id}`;
      const companyName = `DD ${g.title}`;
      let locationId = null;
      try {
        const co = await client.mutate("companyCreate", COMPANY_CREATE, {
          input: {
            company: { name: companyName, externalId },
            companyLocation: {
              name: companyName,
              billingSameAsShipping: true,
              shippingAddress: {
                firstName: "B2B",
                lastName: "Group",
                address1: "Import",
                city: "Copenhagen",
                zip: "1000",
                countryCode: "DK",
              },
            },
            companyContact: {
              email: `dd-group-${g.id}@example.invalid`,
              firstName: "B2B",
              lastName: "Group",
            },
          },
        });
        locationId = companyLocationId(co);
        if (!locationId) {
          failed++;
          const row = { groupId: g.id, title: g.title, error: "companyCreate returned no companyLocation id", payloadKeys: Object.keys(co || {}) };
          failures.push(row);
          log.warn(`B2B catalog ${g.title}: companyCreate returned no companyLocation id`);
          continue;
        }
      } catch (e) {
        if (isB2bCapabilityError(e)) return capabilityResult(e);
        if (isCompanyTaken(e)) {
          try {
            const existing = await lookupCompany(client, externalId, companyName);
            locationId = companyLocationId(existing);
            if (locationId) {
              log.info(`B2B catalog ${g.title}: company externalId taken — reused existing company`);
            }
          } catch (lookupErr) {
            if (isB2bCapabilityError(lookupErr)) return capabilityResult(lookupErr);
            failed++;
            failures.push({ groupId: g.id, title: g.title, error: lookupErr.message, userErrors: lookupErr.userErrors });
            log.warn(`B2B catalog ${g.title}: TAKEN lookup failed: ${lookupErr.message}`);
            continue;
          }
        }
        if (!locationId) {
          failed++;
          failures.push({ groupId: g.id, title: g.title, error: e.message, userErrors: e.userErrors });
          log.warn(`B2B catalog ${g.title}: ${e.message}`);
          continue;
        }
      }
      try {
        const cat = await client.mutate("catalogCreate", CATALOG_CREATE, {
          input: {
            title: companyName,
            status: "ACTIVE",
            context: { companyLocationIds: [locationId] },
          },
        });
        catalogId = cat.catalogCreate?.catalog?.id || cat.catalog?.id;
        if (catalogId) {
          idmap.set("b2bCatalogs", key, catalogId);
          imported++;
        } else {
          failed++;
          failures.push({ groupId: g.id, title: g.title, error: "catalogCreate returned no catalog id" });
          continue;
        }
      } catch (e) {
        if (isB2bCapabilityError(e)) return capabilityResult(e);
        failed++;
        failures.push({ groupId: g.id, title: g.title, error: e.message, userErrors: e.userErrors });
        log.warn(`B2B catalog ${g.title}: ${e.message}`);
        continue;
      }
    }
    if (!priceListId) {
      try {
        const pl = await client.mutate("priceListCreate", PRICE_LIST_CREATE, {
          input: {
            name: `DD ${g.title} prices`,
            currency,
            catalogId,
            parent: { adjustment: { type: "PERCENTAGE_DECREASE", value: 0 } },
          },
        });
        priceListId = pl.priceListCreate?.priceList?.id || pl.priceList?.id;
        if (priceListId) idmap.set("b2bPriceLists", key, priceListId);
        else {
          failed++;
          failures.push({ groupId: g.id, title: g.title, error: "priceListCreate returned no id" });
          log.warn(`B2B price list for ${g.title}: create returned no id`);
        }
      } catch (e) {
        if (isB2bCapabilityError(e)) return capabilityResult(e);
        failed++;
        failures.push({ groupId: g.id, title: g.title, error: e.message, userErrors: e.userErrors });
        log.warn(`B2B price list for ${g.title}: ${e.message}`);
      }
    }

    if (!priceListId) continue;
    const forGroup = groupPrices.filter((r) => r.userId === g.id);
    if (!forGroup.length) continue;
    const prices = [];
    for (const row of forGroup) {
      const shopifyVariantId = idmap.get("productVariants", variantLedgerKey(row.productId, row.variantId))
        || idmap.get("products", row.productId);
      if (!shopifyVariantId) continue;
      prices.push({
        variantId: shopifyVariantId,
        price: { amount: row.price, currencyCode: currency },
      });
    }
    if (!prices.length) continue;
    const priceKey = `b2b-prices:${g.id}`;
    if (idmap.has("b2bPrices", priceKey)) continue;
    try {
      await client.mutate("priceListFixedPricesAdd", PRICE_LIST_FIXED_PRICES_ADD, {
        priceListId,
        prices,
      });
      idmap.set("b2bPrices", priceKey, String(prices.length));
      pricesAttached += prices.length;
    } catch (e) {
      if (isB2bCapabilityError(e)) return capabilityResult(e);
      failed++;
      failures.push({ groupId: g.id, title: g.title, error: e.message, userErrors: e.userErrors });
      log.warn(`B2B group prices ${g.title}: ${e.message}`);
    }
  }
  if (failures.length) await writeFailedJsonl(cfg.paths.state, "b2b", failures);
  return { imported, failed, pricesAttached };
}
