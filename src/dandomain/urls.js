/**
 * DanDomain storefront URL grammar (R41) and containment (R39).
 *
 * Recorded on one shop, one theme: storefront is `{tenant}.mywebshop.io`.
 * `{tenant}.webshop.dandomain.dk` is the admin SPA and answers 200 with the
 * same shell for every path — a status code is not evidence (R39). Category
 * slug falls back to the title when SeoLink is empty (R41). There is no
 * recorded product-slug fallback (D9): refuse to invent one.
 */

export function isAdminHost(hostname) {
  return String(hostname || "").toLowerCase().endsWith(".webshop.dandomain.dk");
}

export function storefrontOrigin(baseUrl) {
  if (!baseUrl) return null;
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`); }
  catch { return null; }
  if (isAdminHost(u.hostname)) {
    const tenant = u.hostname.split(".")[0];
    return tenant ? `https://${tenant}.mywebshop.io` : null;
  }
  return `${u.protocol}//${u.hostname}`;
}

export function categoryPath({ catId, catSlug } = {}) {
  if (catId == null || catId === "" || !catSlug) return null;
  return `/shop/${catId}-${catSlug}`;
}

export function productPath({ catId, catSlug, prodId, prodSlug } = {}) {
  if (!prodSlug) return null;
  const cat = categoryPath({ catId, catSlug });
  if (!cat || prodId == null || prodId === "") return null;
  return `${cat}/${prodId}-${prodSlug}`;
}

/**
 * R39: the product page is the one whose body CONTAINS the item number.
 * Digit-only needles shorter than 5 are refused — a price search for 1117
 * matched a timestamped slug (p2c) and is not containment.
 */
export function containsItemNumber(html, itemNumber) {
  const needle = String(itemNumber || "");
  if (!needle) return false;
  if (/^\d{1,4}$/.test(needle)) return false;
  return String(html || "").includes(needle);
}
