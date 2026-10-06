import { cleanHtml, toHandle, extractSeo, pathFromUrl } from "./html.js";

const embedded = (rec, key) => rec._embedded?.[key];

/**
 * Shopify DateTime is ISO-8601 with either a numeric offset or a trailing Z,
 * not both. WP `date_gmt` is naive UTC (`…T00:36:10`); DanDomain `ddDate`
 * already carries `+02:00`. Appending Z to an offset yields the invalid
 * `…+02:00Z` that articleCreate rejected (post-1, ddseed-news-velkommen).
 */
export function toShopifyDateTime(iso) {
  if (!iso) return undefined;
  const cleaned = String(iso).trim().replace(/([+-]\d{2}:?\d{2})Z$/i, "$1");
  if (/[Zz]$|[+-]\d{2}(:?\d{2})?$/.test(cleaned)) return cleaned;
  return `${cleaned}Z`;
}

/** Operator-facing notes for anything cleanHtml found questionable in a body. */
const bodyWarnings = (entity, id, title, body) => {
  const warnings = [];
  if (body.wordHtml) warnings.push({ entity, id, code: "WORD_HTML", severity: "handled", message: `${entity} "${title}": Word-paste markup (mso- styles) cleaned automatically — eyeball the rendered result on Shopify.` });
  if (body.unresolvedLinks.length) warnings.push({ entity, id, code: "UNRESOLVED_LINK", severity: "info", message: `${entity} "${title}": ${body.unresolvedLinks.length} ID-based internal link(s) (${body.unresolvedLinks.slice(0, 3).join(", ")}) can't be mapped to a new URL — they still point at the old site.` });
  return warnings;
};

/** WP post -> Shopify articleCreate input (goes into the configured blog). */
export function transformPost(post, ctx) {
  const { cfg } = ctx;
  const body = cleanHtml(post.content?.rendered ?? post.content, {
    baseUrl: cfg.source.baseUrl,
    stripShortcodes: cfg.options.stripShortcodes,
    rewriteInternalLinks: cfg.options.rewriteInternalLinks
  });
  const seo = extractSeo(post);
  const title = (post.title?.rendered ?? post.title ?? "").replace(/<[^>]+>/g, "").trim() || `Post ${post.id}`;
  const handle = toHandle(post.slug || title);
  const warnings = bodyWarnings("article", post.id, title, body);

  const terms = (embedded(post, "wp:term") || []).flat();
  const tags = terms.filter((t) => t && (t.taxonomy === "category" || t.taxonomy === "post_tag")).map((t) => t.name);
  const author = (embedded(post, "author") || [])[0]?.name;
  const featured = (embedded(post, "wp:featuredmedia") || [])[0];

  const article = {
    title,
    handle,
    body: body.html,
    summary: (post.excerpt?.rendered || "").replace(/<[^>]+>/g, "").trim() || undefined,
    tags: tags.length ? tags : undefined,
    author: { name: author || "Import" }, // AuthorInput is REQUIRED on articleCreate — deleted WP authors must not break import
    isPublished: post.status === "publish",
    ...(post.status === "publish" && post.date_gmt ? { publishDate: toShopifyDateTime(post.date_gmt) } : {}),
    ...(featured?.source_url ? { image: { url: featured.source_url, altText: featured.alt_text || title } } : {})
  };

  return { article, seo, handle, oldPath: pathFromUrl(post.link), wpId: post.id, images: body.images, warnings };
}

/** WP page -> Shopify pageCreate input. */
export function transformPage(page, ctx) {
  const { cfg } = ctx;
  const body = cleanHtml(page.content?.rendered ?? page.content, {
    baseUrl: cfg.source.baseUrl,
    stripShortcodes: cfg.options.stripShortcodes,
    rewriteInternalLinks: cfg.options.rewriteInternalLinks
  });
  const title = (page.title?.rendered ?? page.title ?? "").replace(/<[^>]+>/g, "").trim() || `Page ${page.id}`;
  const handle = toHandle(page.slug || title);

  return {
    page: { title, handle, body: body.html, isPublished: page.status === "publish" },
    seo: extractSeo(page),
    handle,
    oldPath: pathFromUrl(page.link),
    wpId: page.id,
    images: body.images,
    warnings: bodyWarnings("page", page.id, title, body)
  };
}
