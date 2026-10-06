import { fetchJson } from "../util/http.js";
import { log } from "../log.js";

/**
 * WooCommerce source adapter — WooCommerce REST API v3.
 * Auth: HTTP Basic with consumer key/secret over HTTPS.
 * Pagination: per_page (max 100) + X-WP-Total / Link headers.
 * Docs: https://woocommerce.github.io/woocommerce-rest-api-docs/
 */
export function createWooAdapter(cfg) {
  const wc = cfg.source.woocommerce || {};
  const base = cfg.source.baseUrl.replace(/\/$/, "");
  const apiBase = `${base}/wp-json/${wc.apiVersion || "wc/v3"}`;
  const perPage = Math.min(wc.perPage || 100, 100);
  const auth = "Basic " + Buffer.from(`${wc.consumerKey}:${wc.consumerSecret}`).toString("base64");
  const headers = { Authorization: auth, "User-Agent": "shoplift/1.337" };

  async function* paginate(endpoint, params = {}) {
    let page = 1;
    for (;;) {
      const url = new URL(`${apiBase}/${endpoint}`);
      for (const [k, v] of Object.entries({ per_page: perPage, page, ...params })) {
        if (v !== null && v !== undefined) url.searchParams.set(k, v);
      }
      const { data, headers: h } = await fetchJson(url, { headers });
      if (!Array.isArray(data)) throw new Error(`Expected array from ${endpoint}, got: ${JSON.stringify(data).slice(0, 200)}`);
      yield* data;
      const totalPages = Number(h.get("x-wp-totalpages") || 0);
      log.debug(`${endpoint} page ${page}/${totalPages || "?"} (${data.length} rows)`);
      if (data.length < perPage || (totalPages && page >= totalPages)) break;
      page++;
    }
  }

  return {
    name: "woocommerce",

    /** Products incl. per-product variations for variable products. */
    async *products() {
      for await (const p of paginate("products", { status: "any", orderby: "id", order: "asc" })) {
        if (p.type === "variable") {
          const variations = [];
          for await (const v of paginate(`products/${p.id}/variations`, {})) variations.push(v);
          p._variations = variations;
        }
        yield p;
      }
    },

    async *categories() { yield* paginate("products/categories", { hide_empty: false }); },

    async *customers() {
      // role=all includes guest-created accounts; Woo guest checkout buyers without accounts
      // only exist inside orders and are captured by the order transform.
      yield* paginate("customers", { role: "all", orderby: "id", order: "asc" });
    },

    async *orders() {
      const statuses = wc.orderStatuses || ["completed", "processing", "on-hold", "refunded"];
      const params = { status: statuses.join(","), orderby: "id", order: "asc" };
      if (wc.ordersAfter) params.after = wc.ordersAfter;
      yield* paginate("orders", params);
    },

    async *coupons() { yield* paginate("coupons", {}); },

    /** Product reviews — NOT importable to Shopify; exported so the transform
     *  can surface the "reviews don't migrate" fact with a real count, and so
     *  the data survives for a review-app import later. */
    async *reviews() { yield* paginate("products/reviews", {}); },

    /** Store settings needed for correct mapping (currency, weight unit). */
    async settings() {
      try {
        const { data } = await fetchJson(`${apiBase}/settings/general`, { headers });
        const get = (id) => data.find((s) => s.id === id)?.value;
        let weightUnit;
        try {
          const { data: prod } = await fetchJson(`${apiBase}/settings/products`, { headers });
          weightUnit = prod.find((s) => s.id === "woocommerce_weight_unit")?.value;
        } catch { /* optional */ }
        return { currency: get("woocommerce_currency"), country: get("woocommerce_default_country"), weightUnit };
      } catch (e) {
        log.warn(`Could not read WooCommerce settings (${e.message}) — using config defaults`);
        return {};
      }
    }
  };
}
