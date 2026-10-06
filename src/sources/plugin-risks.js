/**
 * Which active WordPress plugins hold data this tool does not migrate.
 *
 * Pure and offline: `assessPlugins()` takes what /wp/v2/plugins returns and says
 * what will be left behind. Reading that endpoint needs nothing new — the
 * WooCommerce application password already carries the capability.
 *
 * WHY this exists. Every defect in this project came from running against a real
 * store, and the whole live matrix so far is ONE source shape: WooCommerce, USD,
 * no plugins beyond Woo itself. A client store is not that. WPML, Subscriptions
 * and Bundles are commercial, cannot be installed from the .org repo, and each
 * has its own data model — so testing against them speculatively is not possible
 * and testing against free lookalikes would manufacture confidence rather than
 * earn it. What IS possible, cheaply and honestly, is to look at what the store
 * actually runs and say out loud what will not come across, BEFORE anyone quotes
 * the job. Invariant 5 ("lossy decisions become warnings, not silence") applied
 * to the engagement instead of to a single record.
 *
 * This list is deliberately NOT presented as exhaustive — see UNKNOWN_NOTE. An
 * unrecognised plugin means unknown, not safe, and claiming otherwise would be
 * the same overclaim this file exists to prevent.
 */

/** Matched on the plugin's directory (the part of `plugin` before the slash). */
export const KNOWN_LOSSY = [
  { dir: "sitepress-multilingual-cms", name: "WPML", loses: "product/page translations and language URLs — only the default language migrates" },
  { dir: "woocommerce-multilingual", name: "WooCommerce Multilingual", loses: "translated product data and multi-currency prices" },
  { dir: "polylang", name: "Polylang", loses: "translations — only the default language migrates" },
  { dir: "polylang-pro", name: "Polylang Pro", loses: "translations — only the default language migrates" },
  { dir: "woocommerce-subscriptions", name: "WooCommerce Subscriptions", loses: "subscriptions, billing schedules and renewal history — Shopify needs a subscriptions app and a re-signup flow" },
  { dir: "woocommerce-bookings", name: "WooCommerce Bookings", loses: "bookable products, availability rules and existing bookings" },
  { dir: "woocommerce-product-bundles", name: "WooCommerce Product Bundles", loses: "bundle composition — bundles arrive as ordinary products" },
  { dir: "woocommerce-composite-products", name: "Composite Products", loses: "composite configuration — arrives as an ordinary product" },
  { dir: "woocommerce-memberships", name: "WooCommerce Memberships", loses: "memberships and their content-access rules" },
  { dir: "woocommerce-points-and-rewards", name: "Points and Rewards", loses: "customer point balances" },
  { dir: "woocommerce-gift-cards", name: "WooCommerce Gift Cards", loses: "gift card balances — outstanding liability that must be reissued" },
  { dir: "woocommerce-store-credit", name: "Store Credit", loses: "customer credit balances — outstanding liability" },
  { dir: "advanced-custom-fields", name: "ACF", loses: "custom field values, unless each field is mapped to a metafield first" },
  { dir: "advanced-custom-fields-pro", name: "ACF Pro", loses: "custom field values, unless each field is mapped to a metafield first" },
  { dir: "woo-multi-currency", name: "CURCY Multi Currency", loses: "per-currency prices — orders keep their currency, products do not" },
  { dir: "woocommerce-currency-switcher", name: "WOOCS Currency Switcher", loses: "per-currency prices" },
  { dir: "dokan-lite", name: "Dokan", loses: "vendor accounts, commissions and per-vendor products — Shopify is single-vendor" },
  { dir: "wc-vendors", name: "WC Vendors", loses: "vendor accounts and commission records" },
  { dir: "woocommerce-wholesale-prices", name: "Wholesale Prices", loses: "role-based wholesale pricing — needs Shopify B2B or an app" },
  // Redirect plugins are the sharpest of these. This tool DERIVES redirects from
  // product/category/post URLs (transform/redirects.js) and reads no plugin's
  // rule table — so hand-made 301s, often years of accumulated SEO work and the
  // most valuable thing in the migration, would vanish without a word.
  { dir: "redirection", name: "Redirection", loses: "hand-made 301 rules — this tool derives redirects from post URLs only, so custom rules must be exported from the plugin and merged into redirects.csv" },
  { dir: "redirect-redirection", name: "Redirect Redirection", loses: "hand-made redirect rules — export them and merge into redirects.csv before go-live" },
  { dir: "safe-redirect-manager", name: "Safe Redirect Manager", loses: "hand-made redirect rules — export and merge into redirects.csv" },
  { dir: "eps-301-redirects", name: "301 Redirects (EPS)", loses: "hand-made redirect rules — export and merge into redirects.csv" },
  { dir: "quick-pagepost-redirect-plugin", name: "Quick Page/Post Redirect", loses: "hand-made redirect rules — export and merge into redirects.csv" },
  { dir: "yith-woocommerce-wishlist", name: "YITH Wishlist", loses: "customer wishlists" },
  { dir: "woocommerce-product-reviews-pro", name: "Product Reviews Pro", loses: "extended review data (reviews are already flagged as not migrated)" }
];

export const UNKNOWN_NOTE =
  "This scan only recognises plugins it has a rule for; anything else is UNKNOWN, not safe. Check any plugin that stores its own product, order or customer data.";

/**
 * @param {Array<{plugin?: string, name?: string, status?: string}>} plugins  /wp/v2/plugins payload
 * @returns {{active: number, total: number, risks: Array<{dir:string,name:string,loses:string,plugin:string}>, unrecognised: string[]}}
 */
// /wp/v2/plugins returns HTML-escaped names ("Copy &amp; Delete Posts"). These go
// straight into operator-facing output, so decode the handful WP actually emits
// rather than importing the transform layer's full entity table into sources/.
const unescape = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8211;/g, "–");

export function assessPlugins(plugins) {
  const list = Array.isArray(plugins) ? plugins : [];
  const active = list.filter((p) => p && p.status === "active");
  const risks = [];
  const unrecognised = [];
  for (const p of active) {
    const dir = String(p.plugin || "").split("/")[0].toLowerCase();
    if (dir === "woocommerce") continue; // the one we exist to migrate
    const hit = KNOWN_LOSSY.find((k) => k.dir === dir);
    if (hit) risks.push({ ...hit, plugin: p.plugin });
    else unrecognised.push(unescape(p.name) || p.plugin || dir);
  }
  return { active: active.length, total: list.length, risks, unrecognised };
}
