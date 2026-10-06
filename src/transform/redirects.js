/**
 * Builds the 301 redirect set: old WordPress paths -> new Shopify paths.
 * Output is both a Shopify-format CSV ("Redirect from,Redirect to") for the
 * urlRedirectImport flow / manual admin upload, and JSONL for the API import.
 *
 * Shopify's redirect import matches on path only (no domain), which is
 * exactly what WP permalinks reduce to once the domain moves.
 */
export function buildRedirects({ products = [], categories = [], posts = [], pages = [], blogHandle = "news", structural = [], wooCategoryBase = "/product-category", extra = [] }) {
  const rows = [];
  const seen = new Set();
  const add = (from, to) => {
    if (!from || !to) return;
    from = from.replace(/\/$/, "") || "/";
    to = String(to).replace(/\/$/, "") || "/";
    if (from === "/" || from === to || seen.has(from)) return;
    seen.add(from);
    rows.push({ from, to });
  };

  for (const p of products) add(p.oldPath, `/products/${p.handle}`);
  for (const c of categories) {
    add(c.oldPath, `/collections/${c.handle}`);
    if (wooCategoryBase !== false && c.slug) add(`${wooCategoryBase}/${c.slug}`, `/collections/${c.handle}`);
  }
  for (const post of posts) add(post.oldPath, `/blogs/${blogHandle}/${post.handle}`);
  for (const page of pages) add(page.oldPath, `/pages/${page.handle}`);

  if (wooCategoryBase !== false) {
    add("/shop", "/collections/all");
    add("/my-account", "/account");
    add("/cart", "/cart");
  }
  for (const [from, to] of structural) add(from, to);
  for (const r of extra) add(r.from, r.to);

  const csv = ["Redirect from,Redirect to", ...rows.map((r) => `${csvEscape(r.from)},${csvEscape(r.to)}`)].join("\n") + "\n";
  return { rows, csv };
}

const csvEscape = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const stripSlash = (p) => String(p || "").replace(/\/$/, "") || "/";

/** PLAN §5: expand a SEO Source glob against exported old paths. `*` → `.*`. */
export function expandWildcardPaths(pattern, inventory) {
  const from = stripSlash(pattern);
  if (!from.includes("*")) return [];
  const re = new RegExp("^" + from.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const seen = new Set();
  const out = [];
  for (const p of inventory || []) {
    const path = stripSlash(p);
    if (path === "/" || seen.has(path) || !re.test(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
