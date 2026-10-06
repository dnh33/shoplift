import { fetchJson } from "../util/http.js";

/**
 * WordPress core content adapter — WP REST API (/wp-json/wp/v2).
 * Exports posts and pages with embedded terms, author and featured media.
 * If Yoast SEO or Rank Math is active, their REST head data rides along
 * (yoast_head_json / rank_math head) and is used for SEO titles/descriptions.
 */
export function createWpContentAdapter(cfg) {
  const wp = cfg.source.wpContent || {};
  const base = cfg.source.baseUrl.replace(/\/$/, "");
  const headers = { "User-Agent": "shoplift/1.337" };
  if (wp.username && wp.appPassword) {
    headers.Authorization = "Basic " + Buffer.from(`${wp.username}:${wp.appPassword}`).toString("base64");
  }

  async function* paginate(endpoint, params = {}) {
    let page = 1;
    for (;;) {
      const url = new URL(`${base}/wp-json/wp/v2/${endpoint}`);
      for (const [k, v] of Object.entries({ per_page: 100, page, _embed: "1", ...params })) url.searchParams.set(k, v);
      let data, h;
      try { ({ data, headers: h } = await fetchJson(url, { headers })); }
      catch (e) {
        // WP returns 400 rest_post_invalid_page_number past the last page
        if (String(e.message).includes("rest_post_invalid_page_number")) break;
        throw e;
      }
      if (!Array.isArray(data) || data.length === 0) break;
      yield* data;
      const totalPages = Number(h.get("x-wp-totalpages") || 0);
      if (totalPages && page >= totalPages) break;
      page++;
    }
  }

  return {
    async *posts() {
      if (!wp.includePosts) return;
      yield* paginate("posts", { status: headers.Authorization ? "publish,draft" : "publish" });
    },
    async *pages() {
      if (!wp.includePages) return;
      const exclude = new Set(wp.excludePageSlugs || []);
      for await (const p of paginate("pages", { status: "publish" })) {
        if (!exclude.has(p.slug)) yield p;
      }
    }
  };
}
