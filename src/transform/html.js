/**
 * HTML cleanup for descriptions, posts and pages.
 * - strips WordPress shortcodes ([gallery], [vc_row], [et_pb_*], ...)
 * - removes Gutenberg block comments (<!-- wp:paragraph -->)
 * - scrubs Word-paste debris (mso- styles, Mso classes, <o:p>, conditional
 *   comments, attribute-less span wrappers) and reports it via `wordHtml`
 * - optionally rewrites absolute internal links to relative paths so they
 *   keep working on the Shopify domain (redirects catch moved paths);
 *   query-style permalinks (?p=, ?page_id=, ?product=) CANNOT be mapped
 *   without a lookup — they are left untouched and returned in
 *   `unresolvedLinks` so the operator sees every link that will break
 * - collects every <img src> so image URLs can be audited before go-live
 */
const SELF_CLOSING_SHORTCODE = /\[\/?[a-zA-Z0-9_-]+(?:\s[^\]]*)?\]/g;
const GUTENBERG_COMMENT = /<!--\s*\/?wp:[^>]*-->/g;
const MSO_MARKER = /mso-|class=["'][^"']*\bMso/i;
const QUERY_PERMALINK = /[?&](p|page_id|product|cat_id|attachment_id)=\d+/;

/** Word/Outlook paste cleanup. Only invoked when mso- markers are present. */
function scrubWordHtml(s) {
  let out = s
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")          // paired conditional comments
    .replace(/<!--\[if[^\]]*\]>|<!\[endif\]-->|<!--\[endif\]-->|<!--\[if[^>]*-->/gi, "") // stray halves
    .replace(/<xml>[\s\S]*?<\/xml>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?o:[a-z]+[^>]*>/gi, "")                       // <o:p> and friends
    .replace(/\s*style=["'][^"']*mso-[^"']*["']/gi, "")        // style attrs carrying mso- props
    .replace(/\s*class=["'][^"']*\bMso[^"']*["']/gi, "");      // MsoNormal & co.
  // unwrap spans left with no attributes (Word nests them 2-3 deep)
  for (let i = 0; i < 5 && /<span>/i.test(out); i++) out = out.replace(/<span>([\s\S]*?)<\/span>/gi, "$1");
  return out;
}

export function cleanHtml(html, { baseUrl, stripShortcodes = true, rewriteInternalLinks = true } = {}) {
  if (!html) return { html: "", images: [], wordHtml: false, unresolvedLinks: [] };
  let out = String(html);

  const wordHtml = MSO_MARKER.test(out);
  if (wordHtml) out = scrubWordHtml(out);

  out = out.replace(GUTENBERG_COMMENT, "");
  if (stripShortcodes) {
    // Keep shortcode inner content, drop the tags themselves.
    out = out.replace(SELF_CLOSING_SHORTCODE, "");
  }

  const images = [];
  out.replace(/<img[^>]+src=["']([^"']+)["']/gi, (_, src) => { images.push(src); return _; });

  const unresolvedLinks = [];
  if (rewriteInternalLinks && baseUrl) {
    const origin = baseUrl.replace(/\/$/, "");
    const originAlt = origin.replace("://www.", "://");
    // href="https://old-site.com/foo" -> href="/foo" (image srcs are left absolute:
    // Shopify re-hosts referenced files only if you upload them; body images keep
    // pointing at the source until a Files migration or theme rebuild handles them)
    out = out.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (m, url) => {
      if (url.startsWith(origin) || url.startsWith(originAlt)) {
        if (QUERY_PERMALINK.test(url)) { unresolvedLinks.push(url); return m; } // ID-based permalink — no path to map
        try { const u = new URL(url); return `href="${u.pathname}${u.search}${u.hash}"`; } catch { return m; }
      }
      return m;
    });
  }

  return { html: out.trim(), images, wordHtml, unresolvedLinks };
}

/** Decode common HTML entities — Woo REST returns names like "Tæpper &amp; Plaider". */
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Shopify handle rules: lowercase alphanumerics and hyphens. */
export function toHandle(slugOrName) {
  // Danish digraphs match DanDomain storefront slugify (æ→ae, ø→oe, å→aa).
  // Mapping ø→o / å→a would split Tilbehør vs Tilbehoer into two handles.
  return decodeEntities(String(slugOrName || ""))
    .replace(/&/g, " ") // decoded & must not leak "amp"-like fragments into handles
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255) || "item";
}

/** Extract SEO title/description from Yoast or Rank Math REST payloads. */
export function extractSeo(record) {
  const y = record.yoast_head_json;
  if (y) return { title: y.title || undefined, description: y.description || y.og_description || undefined };
  const rm = record.rank_math_seo || record.rankmath;
  if (rm) return { title: rm.title, description: rm.description };
  const metaSeo = {};
  for (const m of record.meta_data || []) {
    if (m.key === "_yoast_wpseo_title") metaSeo.title = m.value;
    if (m.key === "_yoast_wpseo_metadesc") metaSeo.description = m.value;
    if (m.key === "rank_math_title") metaSeo.title = metaSeo.title || m.value;
    if (m.key === "rank_math_description") metaSeo.description = metaSeo.description || m.value;
  }
  return metaSeo;
}

/**
 * Shopify rejects titles over 255 characters — products with INVALID_PRODUCT
 * ("is too long"), and order line items with "Line items Title is too long".
 * WooCommerce enforces no such limit, so long SEO-stuffed titles arrive intact
 * and fail at import time unless they are reshaped here first.
 *
 * Shared by products.js and orders.js deliberately: a line item's title is
 * derived from the product's, so if the two used different limits an order
 * could still fail after its product succeeded.
 */
export const TITLE_MAX = 255;
export function truncateTitle(s, max = TITLE_MAX) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  // cut on a word boundary when one is close to the end, so the result reads
  // like a title rather than a severed string; ellipsis included in the budget
  const hard = t.slice(0, max - 1);
  const space = hard.lastIndexOf(" ");
  return (space > max - 40 ? hard.slice(0, space) : hard).trimEnd() + "…";
}

export function pathFromUrl(url) {
  try { const u = new URL(url); return u.pathname.replace(/\/$/, "") || "/"; } catch { return null; }
}
