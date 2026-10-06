/**
 * Blog handling: import/content.js lands articles.jsonl via ARTICLE_CREATE.
 * This file is the warning surface when that jsonl is empty and the source
 * still signals blog/news (BLOG_NOT_EXPORTED).
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readJsonl } from "../util/fsx.js";
import { log } from "../log.js";

function blogPresent(cfg) {
  const warnPath = path.join(cfg.paths.raw, "warnings.jsonl");
  if (existsSync(warnPath)) {
    for (const w of readJsonl(warnPath)) {
      if (w.code === "BLOG_NOT_EXPORTED") return { present: true, via: "warnings.jsonl" };
    }
  }
  const settingsPath = path.join(cfg.paths.raw, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      const mods = s.modules || s._dd_modules || {};
      if (mods.blog === true || mods.blog === "true" || mods.news === true || mods.news === "true") {
        return { present: true, via: "settings.json modules" };
      }
      if (s.blog === true || s.hasBlog === true) return { present: true, via: "settings.json" };
    } catch { /* ignore */ }
  }
  return { present: false };
}

/**
 * Not the article lander — that is import/content.js. Surfaces documented loss
 * only when articles.jsonl is empty.
 */
export async function importBlog(cfg, _client, _idmap) {
  const articlesPath = path.join(cfg.paths.transformed, "articles.jsonl");
  const articleLines = existsSync(articlesPath) ? readJsonl(articlesPath) : [];
  if (articleLines.length) {
    return { skipped: false, importedVia: "articles.jsonl", count: articleLines.length };
  }
  const { present, via } = blogPresent(cfg);
  if (!present) {
    return { skipped: true, reason: "no blog/news signal on source" };
  }
  log.warn(
    `BLOG_NOT_EXPORTED: blog/news is present (${via}) and is NOT imported in v1 (crawl-only; no crawler). ` +
    "Rebuild articles by hand or keep the old site serving those URLs.",
  );
  return { skipped: true, code: "BLOG_NOT_EXPORTED", present: true, via };
}
