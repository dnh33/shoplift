import { fetchJson } from "../util/http.js";
import { log } from "../log.js";

/**
 * Easy Digital Downloads source adapter — EDD REST API (v2).
 * EDD "downloads" are mapped to the same intermediate product shape the
 * WooCommerce adapter produces, so the transform stage works unchanged.
 * EDD products are digital: requiresShipping=false, no inventory tracking.
 *
 * Endpoint: {site}/edd-api/v2/{products|customers|sales} with key+token
 * (EDD Downloads -> Settings -> API, per-user keys).
 */
export function createEddAdapter(cfg) {
  const edd = cfg.source.edd || {};
  const base = cfg.source.baseUrl.replace(/\/$/, "");
  const api = (endpoint, params = {}) => {
    const url = new URL(`${base}/edd-api/v2/${endpoint}`);
    url.searchParams.set("key", edd.apiKey || "");
    url.searchParams.set("token", edd.apiToken || "");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return fetchJson(url, { headers: { "User-Agent": "shoplift/1.337" } });
  };

  async function* paged(endpoint, listKey, params = {}) {
    let page = 1;
    for (;;) {
      const { data } = await api(endpoint, { number: 50, page, ...params });
      const rows = data[listKey] || [];
      if (rows.length === 0) break;
      yield* rows;
      if (rows.length < 50) break;
      page++;
    }
  }

  /** Normalize an EDD download into the Woo-like product shape the transformer expects. */
  function toProductShape(d) {
    const info = d.info || {};
    const pricing = d.pricing || {};
    const priceKeys = Object.keys(pricing).filter((k) => k !== "amount");
    const hasVariants = priceKeys.length > 1;
    return {
      id: info.id,
      name: info.title,
      slug: info.slug,
      permalink: info.link,
      type: hasVariants ? "variable" : "simple",
      status: info.status === "publish" ? "publish" : "draft",
      description: info.content || "",
      short_description: info.excerpt || "",
      sku: String(info.id),
      price: String(pricing.amount ?? Object.values(pricing)[0] ?? "0"),
      regular_price: String(pricing.amount ?? Object.values(pricing)[0] ?? "0"),
      sale_price: "",
      manage_stock: false,
      stock_quantity: null,
      weight: "",
      virtual: true,
      downloadable: true,
      categories: (info.category || []).map((c) => ({ id: c.term_id ?? c.id ?? c.name, name: c.name, slug: c.slug || String(c.name).toLowerCase() })),
      tags: (info.tags || []).map((t) => ({ name: t.name })),
      images: info.thumbnail ? [{ src: info.thumbnail, alt: info.title }] : [],
      attributes: hasVariants ? [{ name: "Option", variation: true, options: priceKeys }] : [],
      _variations: hasVariants
        ? priceKeys.map((k, i) => ({
            id: `${info.id}-${i}`, sku: `${info.id}-${k}`.slice(0, 60),
            regular_price: String(pricing[k]), sale_price: "",
            attributes: [{ name: "Option", option: k }],
            manage_stock: false, weight: "", virtual: true
          }))
        : undefined,
      meta_data: []
    };
  }

  return {
    name: "edd",
    async *products() { for await (const d of paged("products", "products")) yield toProductShape(d); },
    async *categories() { log.info("EDD: categories are exported inline with products"); },
    async *customers() {
      for await (const c of paged("customers", "customers")) {
        const info = c.info || {};
        const [firstName, ...rest] = String(info.display_name || info.name || "").split(" ");
        yield { id: info.user_id || info.customer_id || info.id, email: info.email, first_name: info.first_name || firstName || "", last_name: info.last_name || rest.join(" "), billing: {}, shipping: {}, meta_data: [] };
      }
    },
    async *orders() {
      for await (const s of paged("sales", "sales")) {
        yield {
          id: s.ID, number: String(s.ID), status: s.status === "complete" ? "completed" : s.status,
          currency: cfg.source.edd?.currency || "USD",
          date_created_gmt: s.date, date_paid_gmt: s.date,
          total: String(s.total), total_tax: String(s.tax || 0), shipping_total: "0",
          payment_method: s.gateway, payment_method_title: s.gateway,
          billing: { email: s.email, first_name: s.customer?.first_name || "", last_name: s.customer?.last_name || "" },
          shipping: {},
          line_items: (s.products || []).map((p) => ({ name: p.name, quantity: p.quantity, sku: String(p.id), price: Number(p.price) / Math.max(1, p.quantity || 1), total: String(p.price), total_tax: "0" })),
          shipping_lines: [], tax_lines: [], coupon_lines: s.discounts ? Object.keys(s.discounts).map((code) => ({ code })) : [],
          customer_id: 0, meta_data: []
        };
      }
    },
    async *coupons() { for await (const d of paged("discounts", "discounts")) {
      yield { id: d.ID, code: d.code, discount_type: d.type === "percent" ? "percent" : "fixed_cart", amount: String(d.amount), date_expires: d.exp_date || null, usage_limit: d.max_uses || null, usage_count: d.uses || 0, minimum_amount: d.min_price || "0" };
    } },
    async settings() { return { currency: cfg.source.edd?.currency }; }
  };
}
