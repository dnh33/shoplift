import path from "node:path";
import { readJson } from "../util/fsx.js";
import { COLLECTION_CREATE, COLLECTION_CREATE_CONDITIONS, COLLECTION_ADD_PRODUCTS, QUERY_COLLECTION_BY_HANDLE, QUERY_PUBLICATIONS, PUBLISHABLE_PUBLISH } from "../shopify/mutations.js";
import { log } from "../log.js";

async function onlineStorePublicationId(client, cached) {
  if (cached.id !== undefined) return cached.id;
  const data = await client.graphql(QUERY_PUBLICATIONS);
  const nodes = data?.publications?.nodes || [];
  const hit = nodes.find((n) => (n.catalog?.apps?.nodes || []).some((a) => a.handle === "online_store"))
    || nodes.find((n) => n.supportsFuturePublishing)
    || nodes[0];
  cached.id = hit?.id ?? null;
  if (!cached.id) log.warn("  collections: no Online Store publication — conditions collections stay unpublished");
  return cached.id;
}

/** CollectionCreateInput creates unpublished; publish to Online Store. Custom/legacy path is unchanged. */
async function publishConditionsCollection(client, collectionId, cached) {
  const publicationId = await onlineStorePublicationId(client, cached);
  if (!publicationId) return;
  await client.mutate("publishablePublish", PUBLISHABLE_PUBLISH, { id: collectionId, input: [{ publicationId }] });
}

/**
 * Woo/Hostedshop categories -> Shopify custom collections, then product
 * membership via collectionAddProductsV2 (250 products per call).
 * Hostedshop brand/fokus-forside rows (`kind: "conditions"`) use
 * collectionCreate(collection:) and are never given membership adds.
 * Idempotent: existing collections are found by handle and reused.
 */
export async function importCollections(cfg, client, idmap) {
  const defs = readJson(path.join(cfg.paths.transformed, "collections.json"), []);
  const memberships = readJson(path.join(cfg.paths.transformed, "product-memberships.json"), []);
  if (!defs.length) { log.info("No collections to import"); return { imported: 0 }; }
  if (cfg.options.dryRun) { log.info(`[dry-run] would import ${defs.length} collections`); return { imported: 0, dryRun: true }; }

  const conditionsSlugs = new Set(defs.filter((d) => d.kind === "conditions").map((d) => d.slug));
  const publicationCache = {};

  let imported = 0;
  for (const def of defs) {
    const { slug, kind, input, collection } = def;
    if (idmap.has("collections", slug)) continue;
    const handle = kind === "conditions" ? collection?.handle : input?.handle;
    try {
      const existing = await client.graphql(QUERY_COLLECTION_BY_HANDLE, { handle });
      if (existing.collectionByHandle?.id) {
        const gid = existing.collectionByHandle.id;
        if (kind === "conditions") await publishConditionsCollection(client, gid, publicationCache);
        idmap.set("collections", slug, gid);
      } else if (kind === "conditions") {
        const res = await client.mutate("collectionCreate", COLLECTION_CREATE_CONDITIONS, { collection });
        await publishConditionsCollection(client, res.collection.id, publicationCache);
        idmap.set("collections", slug, res.collection.id);
        imported++;
      } else {
        const res = await client.mutate("collectionCreate", COLLECTION_CREATE, { input });
        idmap.set("collections", slug, res.collection.id);
        imported++;
      }
    } catch (e) {
      log.warn(`  collection FAILED: ${slug} — ${e.message.slice(0, 200)}`);
    }
    idmap.save();
  }

  // memberships: category slug -> product ids (resolved through the products idmap by handle)
  const bySlug = new Map();
  for (const m of memberships) {
    const gid = idmap.get("products", m.handle);
    if (!gid) continue;
    for (const slug of m.categorySlugs || []) {
      if (conditionsSlugs.has(slug)) continue;
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(gid);
    }
  }
  // grouped-product collections: members referenced by Woo product id
  const handleByWooId = new Map(memberships.map((m) => [m.wooId, m.handle]));
  for (const def of defs) {
    if (def.kind === "conditions") continue;
    if (!def.memberWooIds?.length) continue;
    const gids = def.memberWooIds.map((id) => idmap.get("products", handleByWooId.get(id))).filter(Boolean);
    if (gids.length) bySlug.set(def.slug, [...(bySlug.get(def.slug) || []), ...gids]);
    else log.warn(`  grouped collection ${def.slug}: no member products resolved — assign manually in admin`);
  }
  for (const [slug, productIds] of bySlug) {
    if (conditionsSlugs.has(slug)) continue;
    const collId = idmap.get("collections", slug);
    if (!collId) continue;
    for (let i = 0; i < productIds.length; i += 250) {
      try {
        await client.mutate("collectionAddProductsV2", COLLECTION_ADD_PRODUCTS, { id: collId, productIds: productIds.slice(i, i + 250) });
      } catch (e) {
        if (!/already (exists|in)/i.test(e.message)) log.warn(`  membership ${slug}: ${e.message.slice(0, 160)}`);
      }
    }
    log.info(`  collection ${slug}: ${productIds.length} products assigned`);
  }
  return { imported };
}
