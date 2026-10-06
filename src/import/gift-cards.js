/**
 * Flag-gated gift-card importer (PLAN §11 / F24).
 * No invented DanDomain GraphQL read schema — operator CSV / documented step only.
 *
 * Expected CSV (transformed/gift-cards.csv or options.giftCardsCsv):
 *   code,initial_value,note
 *   (code optional — Shopify can mint)
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { GIFT_CARD_CREATE, QUERY_GIFT_CARDS } from "../shopify/mutations.js";
import { log } from "../log.js";
import { writeFailedJsonl } from "../util/fsx.js";

function flagOn(cfg) {
  return cfg.options?.importGiftCards === true;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.trim());
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i]; });
    const initial = Number(row.initial_value || row.balance || row.amount || 0);
    if (!initial) continue;
    rows.push({
      code: row.code || undefined,
      initialValue: initial.toFixed(2),
      note: row.note || row.memo || "DanDomain gift card (manual CSV)",
      id: row.id || row.code || `${initial}-${rows.length}`,
    });
  }
  return rows;
}

function isCodeTaken(e) {
  const msg = `${e?.message || ""} ${JSON.stringify(e?.userErrors || [])}`;
  return /already exists|already been taken|code.*taken|TAKEN|duplicate/i.test(msg);
}

async function existingGiftCardId(client, code) {
  if (!code || typeof client.graphql !== "function") return null;
  try {
    const data = await client.graphql(QUERY_GIFT_CARDS, { query: `code:${code}` });
    return data?.giftCards?.nodes?.[0]?.id || null;
  } catch {
    return null;
  }
}

function loadRows(cfg) {
  const custom = cfg.options?.giftCardsCsv;
  const candidates = [
    custom,
    path.join(cfg.paths.transformed, "gift-cards.csv"),
    path.join(cfg.paths.raw, "gift-cards.csv"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, rows: parseCsv(readFileSync(p, "utf8")) };
  }
  return { path: null, rows: [] };
}

export async function importGiftCards(cfg, client, idmap) {
  if (!flagOn(cfg)) {
    return { skipped: true, reason: "importGiftCards flag off" };
  }
  const { path: csvPath, rows } = loadRows(cfg);
  if (!rows.length) {
    log.warn(
      "GIFT_CARDS_MANUAL: importGiftCards is on but no CSV found " +
      "(place transformed/gift-cards.csv with initial_value column). " +
      "F24: gift-card GraphQL was never successfully read from DanDomain — do not invent a schema.",
    );
    return { imported: 0, failed: 0, manual: true, code: "GIFT_CARDS_MANUAL" };
  }
  if (cfg.options.dryRun) {
    return { imported: 0, failed: 0, dryRun: true, wouldImport: rows.length, csvPath };
  }

  let imported = 0;
  let failed = 0;
  const failures = [];
  for (const row of rows) {
    const key = `gift:${row.id}`;
    if (idmap.has("giftCards", key)) continue;
    try {
      const input = { initialValue: row.initialValue, note: row.note };
      if (row.code) input.code = row.code;
      const res = await client.mutate("giftCardCreate", GIFT_CARD_CREATE, { input });
      const gid = res.giftCardCreate?.giftCard?.id || res.giftCard?.id;
      if (gid) {
        idmap.set("giftCards", key, gid);
        imported++;
      } else {
        failed++;
        failures.push({ key, code: row.code, error: "giftCardCreate returned no id" });
      }
    } catch (e) {
      if (isCodeTaken(e)) {
        const existing = await existingGiftCardId(client, row.code);
        if (existing) {
          idmap.set("giftCards", key, existing);
          imported++;
          log.warn(`gift card ${key}: code already exists — ledgered existing ${existing}`);
          continue;
        }
      }
      failed++;
      failures.push({ key, code: row.code, error: e.message, userErrors: e.userErrors });
      log.warn(`gift card ${key}: ${e.message}`);
    }
  }
  if (failures.length) await writeFailedJsonl(cfg.paths.state, "gift-cards", failures);
  return { imported, failed, csvPath };
}
