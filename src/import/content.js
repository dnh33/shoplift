import path from "node:path";
import { readJsonl, jsonlWriter } from "../util/fsx.js";
import { BLOG_CREATE, ARTICLE_CREATE, PAGE_CREATE, QUERY_BLOGS, QUERY_PAGES_BY_HANDLE } from "../shopify/mutations.js";
import { toHandle } from "../transform/html.js";
import { localeOf } from "../locales.js";
import { log } from "../log.js";

/**
 * WP posts -> articles in one Shopify blog; WP pages -> Shopify pages.
 * SEO titles/descriptions ride along as the theme-standard global metafields
 * (global.title_tag / global.description_tag) which Online Store themes read.
 */
const seoMetafields = (seo) => {
  const mf = [];
  if (seo?.title) mf.push({ namespace: "global", key: "title_tag", type: "single_line_text_field", value: seo.title });
  if (seo?.description) mf.push({ namespace: "global", key: "description_tag", type: "single_line_text_field", value: seo.description });
  return mf.length ? { metafields: mf } : {};
};

export async function importContent(cfg, client, idmap, entities) {
  const failed = jsonlWriter(path.join(cfg.paths.state, "failed-content.jsonl"));
  const result = { articles: 0, pages: 0, failed: 0 };

  // ----- articles -----
  if (entities.articles) {
    const lines = readJsonl(path.join(cfg.paths.transformed, "articles.jsonl"));
    if (lines.length) {
      const L = localeOf(cfg);
      const wantHandle = toHandle(cfg.shopify?.blog?.handle || L.blog.handle);
      const wantTitle = cfg.shopify?.blog?.title || L.blog.title;
      let blogId = idmap.get("blogs", wantHandle);
      if (!blogId && !cfg.options.dryRun) {
        const data = await client.graphql(QUERY_BLOGS);
        const existing = data.blogs?.nodes?.find((b) => b.handle === wantHandle);
        blogId = existing?.id;
        if (!blogId) {
          const res = await client.mutate("blogCreate", BLOG_CREATE, { blog: { title: wantTitle, handle: wantHandle } });
          blogId = res.blog.id;
        }
        idmap.set("blogs", wantHandle, blogId);
        idmap.save();
      }
      const pending = lines.filter((l) => !idmap.has("articles", l.article.handle));
      log.info(`Articles: ${lines.length} total, ${pending.length} to import into blog "${wantHandle}"`);
      if (!cfg.options.dryRun) {
        for (const line of pending) {
          try {
            const article = { blogId, ...line.article, ...seoMetafields(line.seo) };
            const res = await client.mutate("articleCreate", ARTICLE_CREATE, { article });
            idmap.set("articles", line.article.handle, res.article.id);
            result.articles++;
          } catch (e) {
            failed.write({ type: "article", handle: line.article.handle, error: e.message, userErrors: e.userErrors });
            log.warn(`  article FAILED ${line.article.handle}: ${e.message.slice(0, 160)}`);
          }
        }
        idmap.save();
      }
    }
  }

  // ----- pages -----
  if (entities.pages) {
    const lines = readJsonl(path.join(cfg.paths.transformed, "pages.jsonl"));
    const pending = lines.filter((l) => !idmap.has("pages", l.page.handle));
    log.info(`Pages: ${lines.length} total, ${pending.length} to import`);
    if (!cfg.options.dryRun) {
      for (const line of pending) {
        try {
          const existing = await client.graphql(QUERY_PAGES_BY_HANDLE, { q: `handle:${line.page.handle}` });
          if (existing.pages?.nodes?.[0]?.handle === line.page.handle) {
            idmap.set("pages", line.page.handle, existing.pages.nodes[0].id);
            continue;
          }
          const res = await client.mutate("pageCreate", PAGE_CREATE, { page: { ...line.page, ...seoMetafields(line.seo) } });
          idmap.set("pages", line.page.handle, res.page.id);
          result.pages++;
        } catch (e) {
          failed.write({ type: "page", handle: line.page.handle, error: e.message, userErrors: e.userErrors });
          log.warn(`  page FAILED ${line.page.handle}: ${e.message.slice(0, 160)}`);
        }
      }
      idmap.save();
    }
  }

  result.failed = failed.count;
  await failed.close();
  log.info(`Content: ${result.articles} articles, ${result.pages} pages imported, ${result.failed} failed`);
  return result;
}
