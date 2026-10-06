import path from "node:path";
import { readJsonl, jsonlWriter } from "../util/fsx.js";
import { toHandle } from "./html.js";

/** True when the operator opted into DanDomain secondary-language export. */
export function translationsEnabled(cfg) {
  return cfg.options?.importTranslations === true || cfg.source?.dandomain?.multiLanguage === true;
}

/** Map DanDomain LanguageISO to a Shopify locale code (primary slugs stay on redirects). */
export function shopifyLocaleFromIso(iso) {
  const key = String(iso || "").trim().toUpperCase();
  const map = { DK: "da", EN: "en", UK: "en", GB: "en", DE: "de", SV: "sv", NO: "no", FI: "fi", FR: "fr", ES: "es", IT: "it", NL: "nl" };
  return map[key] || key.toLowerCase() || null;
}

/**
 * Write transformed/translations.jsonl from raw/i18n-products.jsonl (+ pages when present).
 * Rows: { handle, locale, key, value, digest? } — digest-less rows are skipped at import.
 */
export async function writeTranslationsJsonl(cfg, outDir) {
  if (!translationsEnabled(cfg)) return { written: 0, skipped: true };

  const raw = cfg.paths.raw;
  const i18nProducts = readJsonl(path.join(raw, "i18n-products.jsonl"));
  const i18nPages = readJsonl(path.join(raw, "i18n-pages.jsonl"));
  if (!i18nProducts.length && !i18nPages.length) return { written: 0, skippedEmpty: true };

  const handleByProductId = new Map();
  for (const p of readJsonl(path.join(raw, "products.jsonl"))) {
    handleByProductId.set(String(p.id), toHandle(p.slug || p.name));
  }
  const handleByPageId = new Map();
  for (const p of readJsonl(path.join(raw, "pages.jsonl"))) {
    handleByPageId.set(String(p.id), toHandle(p.slug || p.title || p.name));
  }

  const w = jsonlWriter(path.join(outDir, "translations.jsonl"));
  let written = 0;

  const push = async (handle, locale, key, value) => {
    if (!handle || !locale || !key || value == null || value === "") return;
    await w.write({ handle, locale, key, value: String(value) });
    written++;
  };

  for (const row of i18nProducts) {
    const handle = handleByProductId.get(String(row.productId));
    const locale = shopifyLocaleFromIso(row.languageISO);
    if (!handle || !locale) continue;
    const f = row.fields || {};
    if (f.title) await push(handle, locale, "title", f.title);
    if (f.bodyHtml) await push(handle, locale, "body_html", f.bodyHtml);
    if (f.seoTitle) await push(handle, locale, "meta_title", f.seoTitle);
    if (f.seoDescription) await push(handle, locale, "meta_description", f.seoDescription);
  }

  for (const row of i18nPages) {
    const handle = handleByPageId.get(String(row.pageId));
    const locale = shopifyLocaleFromIso(row.languageISO);
    if (!handle || !locale) continue;
    const f = row.fields || {};
    if (f.title) await push(handle, locale, "title", f.title);
    if (f.bodyHtml) await push(handle, locale, "body_html", f.bodyHtml);
    if (f.seoTitle) await push(handle, locale, "meta_title", f.seoTitle);
    if (f.seoDescription) await push(handle, locale, "meta_description", f.seoDescription);
  }

  await w.close();
  return { written };
}
