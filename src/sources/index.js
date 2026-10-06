import { createWooAdapter } from "./woocommerce.js";
import { createEddAdapter } from "./edd.js";
import { createFixtureAdapter } from "./fixture.js";
import { createDanDomainAdapter } from "./dandomain.js";
import { createWpContentAdapter } from "./wp-content.js";

/**
 * Adapter registry. Every adapter yields WooCommerce-shaped records so the
 * transform stage is source-agnostic. To support another WordPress commerce
 * plugin (SureCart, WP eCommerce, ...), add an adapter that normalizes to the
 * same shape — see edd.js for a compact example. A whole other PLATFORM is the
 * same job plus a `kind` (see below) — see dandomain.js.
 */
const REGISTRY = {
  woocommerce: createWooAdapter,
  edd: createEddAdapter,
  fixture: createFixtureAdapter,
  dandomain: createDanDomainAdapter
};

/**
 * The PLATFORM each adapter reads from, as opposed to the adapter's own name.
 * woocommerce and edd are two commerce plugins on ONE platform; dandomain is a
 * different platform entirely. `cfg.source.kind` overrides this when a config
 * says so explicitly, which is the documented escape hatch — nothing derives a
 * kind from a URL or sniffs for one.
 */
const ADAPTER_KIND = { woocommerce: "wordpress", edd: "wordpress", fixture: "fixture", dandomain: "dandomain" };

/**
 * The kinds `createSource` knows how to act on. An unknown one is a HARD ERROR,
 * not a fallback, because of how this lever fails: `kind` decides whether
 * wp-content is wired in, so `"WordPress"` or `"wp"` in a config would resolve to
 * "not wordpress", drop posts and pages from the export, and produce a summary
 * that looks like a shop with no content. That is silent data loss caused by a
 * capital letter — the loudest possible failure is the cheap one here (invariant
 * #5, reshape loudly rather than fail late).
 */
export const SOURCE_KINDS = ["wordpress", "dandomain", "fixture"];

/**
 * THE CONTENT DE-COUPLING (PLAN §1). This function used to force-wire
 * `wp-content.js` as the posts/pages source for EVERY adapter except `fixture`,
 * which is a WordPress assumption sitting in the source registry: a DanDomain
 * export would have called the WP REST API on a shop that has no `/wp-json`.
 *
 * The rule, in precedence order:
 *   1. An adapter that provides its own `posts()`/`pages()` OWNS content.
 *      Providing one and not the other is a decision, not an oversight — the
 *      DanDomain adapter has `pages()` and `posts()` (GraphQL blogPosts).
 *      wp-content must not quietly fill a hole the adapter left empty.
 *   2. Otherwise wp-content applies only when the resolved kind is `wordpress`
 *      (and `source.wpContent.enabled` is not false, as before).
 *   3. Otherwise there is no content source, and `posts`/`pages` are undefined.
 *      runExport skips an entity whose generator is missing.
 *
 * The Woo/EDD path is bit-identical to the old behaviour: neither adapter
 * provides posts/pages, both resolve to kind `wordpress`, so both still get
 * wp-content on exactly the same condition. The fixture adapter provides both,
 * so rule 1 hands it content — which is what the old `name === "fixture"`
 * special case did, now as a consequence of the rule rather than a name check.
 */
export function createSource(cfg) {
  const name = cfg.source?.adapter || "woocommerce";
  const factory = REGISTRY[name];
  if (!factory) throw new Error(`Unknown source adapter "${name}". Available: ${Object.keys(REGISTRY).join(", ")}`);
  const kind = cfg.source?.kind || ADAPTER_KIND[name] || "wordpress";
  if (!SOURCE_KINDS.includes(kind)) {
    throw new Error(
      `Unknown source.kind "${kind}". Available: ${SOURCE_KINDS.join(", ")}. ` +
      "This value decides whether WordPress content (posts/pages) is exported, so an " +
      "unrecognised one would silently produce an export with no content.",
    );
  }
  // Validated BEFORE the factory runs: an adapter constructor may open a client or
  // read credentials, and there is no reason to do that for a config that cannot work.
  const commerce = factory(cfg);

  const ownsContent = Boolean(commerce.posts || commerce.pages);
  const content = ownsContent
    ? commerce
    : (kind === "wordpress" && cfg.source.wpContent?.enabled !== false ? createWpContentAdapter(cfg) : null);

  return {
    name,
    kind,
    products: commerce.products?.bind(commerce),
    categories: commerce.categories?.bind(commerce),
    customers: commerce.customers?.bind(commerce),
    orders: commerce.orders?.bind(commerce),
    coupons: commerce.coupons?.bind(commerce),
    reviews: commerce.reviews?.bind(commerce),
    settings: commerce.settings?.bind(commerce),
    redirects: commerce.redirects?.bind(commerce),
    provenance: commerce.provenance,
    posts: content?.posts?.bind(content),
    pages: content?.pages?.bind(content),
    translationLayers: commerce.translationLayers?.bind(commerce),
    // Export-time warnings the adapter accumulated (BLOG_NOT_EXPORTED,
    // FIELD_SET_TRUNCATED, ...). Drained by runExport AFTER the generators have
    // run, so anything discovered mid-walk is included.
    warnings: commerce.warnings?.bind(commerce)
  };
}
