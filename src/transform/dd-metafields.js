/**
 * DanDomain raw meta_data → Shopify MetafieldInput / MetafieldsSetInput rows.
 * Namespace `dandomain` keeps Hostedshop facts out of Woo/theme keys.
 * Product rows ride on productSet.input.metafields; customers use metafieldsSet
 * after customerSet (CustomerSetInput has no metafields field).
 */

export const DD_META_NAMESPACE = "dandomain";

const metaMap = (meta_data) =>
  Object.fromEntries((meta_data || []).filter((m) => m?.key).map((m) => [m.key, m.value]));

function mf(key, value, type = "single_line_text_field") {
  if (value == null || value === "") return null;
  return { namespace: DD_META_NAMESPACE, key, type, value: String(value) };
}

/** Customer metafields from exported `_dd_ean` / `_dd_cvr` (and friends). */
export function customerMetafieldsFromMeta(meta_data) {
  const m = metaMap(meta_data);
  return [
    mf("ean", m._dd_ean),
    mf("cvr", m._dd_cvr),
    mf("debtor_number", m._dd_debtor_number),
    mf("customer_group", m._dd_customer_group),
  ].filter(Boolean);
}

/**
 * Product metafields: SEO keywords + related/ExtraBuy/Tilvalg ID payloads.
 * Native Shopify recommendation UI is still operator work; IDs are preserved.
 */
export function productMetafieldsFromMeta(meta_data) {
  const m = metaMap(meta_data);
  return [
    mf("seo_keywords", m._dd_seo_keywords),
    mf("related_product_ids", m._dd_related_product_ids, "json"),
    mf("extrabuy_relations", m._dd_extrabuy_relations, "json"),
    mf("tilvalg", m._dd_tilvalg, "json"),
  ].filter(Boolean);
}
