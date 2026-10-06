/**
 * Flag-gated translations importer (PLAN §11).
 * Reads transformed/translations.jsonl when present:
 *   { resourceId|handle, locale, key, value, digest? }
 * Shopify requires translatableContentDigest. Rows without it fetch digest
 * via translatableResource; skip only when Shopify returns no matching key.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { readJsonl, writeFailedJsonl } from "../util/fsx.js";
import { TRANSLATIONS_REGISTER, QUERY_TRANSLATABLE_RESOURCE, QUERY_SHOP_LOCALES, SHOP_LOCALE_ENABLE, SHOP_LOCALE_UPDATE } from "../shopify/mutations.js";
import { log } from "../log.js";

function flagOn(cfg) {
  return cfg.options?.importTranslations === true;
}

async function digestFor(client, resourceId, key) {
  const data = await client.graphql(QUERY_TRANSLATABLE_RESOURCE, { resourceId });
  const content = data?.translatableResource?.translatableContent
    || data?.translatableResources?.nodes?.[0]?.translatableContent
    || [];
  const hit = content.find((c) => c.key === key);
  return hit?.digest || null;
}

function localeEnabled(enabled, locale) {
  return enabled.some((e) => e === locale || e.startsWith(`${locale}-`));
}

/** Row locale matches shop primary (`en` vs `en`, or `en` vs `en-US`). Not `en-GB` vs primary `en`. */
function isShopPrimaryLocale(primary, locale) {
  if (!primary || !locale) return false;
  return locale === primary || primary.startsWith(`${locale}-`);
}

async function ensureLocales(client, locales) {
  const wantedAll = [...new Set(locales.filter(Boolean))];
  if (!wantedAll.length) return { enabled: wantedAll, failures: [], primary: null };
  if (typeof client.graphql !== "function") return { enabled: wantedAll, failures: [], primary: null };
  let enabled = [];
  let primary = null;
  const failures = [];
  try {
    const data = await client.graphql(QUERY_SHOP_LOCALES);
    const shopLocales = data?.shopLocales || [];
    enabled = shopLocales.map((l) => l.locale).filter(Boolean);
    primary = shopLocales.find((l) => l.primary)?.locale || null;
  } catch (e) {
    log.warn(`shopLocales: ${e.message}`);
  }
  const wanted = wantedAll.filter((locale) => !isShopPrimaryLocale(primary, locale));
  for (const locale of wanted) {
    if (localeEnabled(enabled, locale)) continue;
    try {
      await client.mutate("shopLocaleEnable", SHOP_LOCALE_ENABLE, { locale });
      enabled.push(locale);
      try {
        await client.mutate("shopLocaleUpdate", SHOP_LOCALE_UPDATE, { locale, shopLocale: { published: true } });
      } catch (e) {
        log.warn(`TRANSLATION_LOCALE: shopLocaleUpdate(${locale}) publish failed: ${e.message}`);
      }
    } catch (e) {
      failures.push({ locale, error: e.message, userErrors: e.userErrors, code: "TRANSLATION_LOCALE" });
      log.warn(`TRANSLATION_LOCALE: shopLocaleEnable(${locale}) failed: ${e.message}`);
    }
  }
  return { enabled, failures, primary };
}

export async function importTranslations(cfg, client, idmap) {
  if (!flagOn(cfg)) {
    return { skipped: true, reason: "importTranslations flag off" };
  }
  const file = path.join(cfg.paths.transformed, "translations.jsonl");
  if (!existsSync(file)) {
    log.warn(
      "TRANSLATIONS_MANUAL: importTranslations is on but transformed/translations.jsonl is missing — " +
      "export secondary-language strings or register them in Shopify admin.",
    );
    return { imported: 0, failed: 0, manual: true, code: "TRANSLATIONS_MANUAL" };
  }
  const lines = readJsonl(file);
  if (!lines.length) {
    return { imported: 0, failed: 0, skippedEmpty: true };
  }
  if (cfg.options.dryRun) {
    return { imported: 0, failed: 0, dryRun: true, wouldImport: lines.length };
  }

  const { enabled: enabledLocales, failures: localeFailures, primary: primaryLocale } = await ensureLocales(client, lines.map((r) => r.locale));

  // Group by resourceId
  const byResource = new Map();
  const failures = [...localeFailures];
  let skipped = 0;
  for (const row of lines) {
    const rid = row.resourceId || idmap.get("products", row.handle) || idmap.get("pages", row.handle);
    if (!rid) continue;
    if (!row.locale || !row.key || row.value == null) continue;
    if (isShopPrimaryLocale(primaryLocale, row.locale)) {
      skipped++;
      continue;
    }
    if (enabledLocales.length && !localeEnabled(enabledLocales, row.locale)) {
      failures.push({ handle: row.handle, resourceId: rid, locale: row.locale, key: row.key, code: "TRANSLATION_LOCALE", error: `locale ${row.locale} is not enabled on the shop; skipped` });
      log.warn(`TRANSLATION_LOCALE: ${row.key}@${row.locale} — locale is not enabled on the shop; skipped`);
      continue;
    }
    let digest = row.digest || row.translatableContentDigest;
    if (!digest) {
      digest = await digestFor(client, rid, row.key);
      if (!digest) {
        log.warn(`TRANSLATION_KEY_MISSING: translation ${row.key}@${row.locale} — Shopify returned no digest; skipped`);
        continue;
      }
    }
    if (!byResource.has(rid)) byResource.set(rid, []);
    byResource.get(rid).push({
      locale: row.locale,
      key: row.key,
      value: String(row.value),
      translatableContentDigest: digest,
    });
  }

  let imported = 0;
  let failed = 0;
  for (const [resourceId, translations] of byResource) {
    const key = `tr:${resourceId}`;
    if (idmap.has("translations", key)) continue;
    try {
      await client.mutate("translationsRegister", TRANSLATIONS_REGISTER, { resourceId, translations });
      idmap.set("translations", key, `${translations.length}`);
      imported += translations.length;
    } catch (e) {
      failed++;
      failures.push({ resourceId, error: e.message, userErrors: e.userErrors });
      log.warn(`translations ${resourceId}: ${e.message}`);
    }
  }
  failed += failures.filter((f) => f.code === "TRANSLATION_LOCALE").length;
  if (skipped) {
    log.warn(`TRANSLATION_LOCALE: skipped ${skipped} translation(s) whose locale is the shop's primary locale (${primaryLocale})`);
  }
  if (failures.length) await writeFailedJsonl(cfg.paths.state, "translations", failures);
  return {
    imported,
    failed,
    skipped,
    primaryLocale,
    ...(skipped ? { code: "TRANSLATION_LOCALE" } : {}),
  };
}
