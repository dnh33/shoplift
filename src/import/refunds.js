/**
 * Flag-gated kreditnota / refund importer (PLAN §11).
 * Default path stays label-level folding (transform notes). When
 * options.importRefunds is true, refundCreate runs only with honest adapter
 * money from raw/transformed refunds[] — never invented amounts.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readJsonl, writeFailedJsonl, removeFile } from "../util/fsx.js";
import { REFUND_CREATE, QUERY_ORDER_TRANSACTIONS, QUERY_ORDER_TRANSACTIONS_LIST } from "../shopify/mutations.js";
import { log } from "../log.js";

function flagOn(cfg) {
  return cfg.options?.importRefunds === true;
}

/** Shopify @idempotent examples use UUID-shaped keys. Include the landed order GID so a post-wipe retry is a new request (source-only keys collide: payload orderId changed). */
export function refundIdempotencyKey(s) {
  const hex = createHash("sha256").update(String(s)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Collect refund rows: prefer transformed `_refunds` (when present), else raw
 * Woo-shaped `refunds` on orders.jsonl.
 */
function collectRefunds(cfg) {
  const out = [];
  const transformed = path.join(cfg.paths.transformed, "orders.jsonl");
  if (existsSync(transformed)) {
    for (const line of readJsonl(transformed)) {
      const list = line._refunds || line.refunds;
      if (!list?.length) continue;
      const sid = line.order?.sourceIdentifier || line.sourceIdentifier || line.id;
      for (const r of list) {
        const amount = Math.abs(Number(r.total ?? r.amount ?? 0));
        if (!amount) continue;
        out.push({
          sourceOrderId: String(sid),
          amount: amount.toFixed(2),
          currency: r.currency || line.order?.currency || line.currency || "DKK",
          reason: r.reason || "kreditnota",
          id: r.id,
        });
      }
    }
  }
  const raw = path.join(cfg.paths.raw, "orders.jsonl");
  if (!out.length && existsSync(raw)) {
    for (const w of readJsonl(raw)) {
      for (const r of w.refunds || []) {
        const amount = Math.abs(Number(r.total ?? 0));
        if (!amount) continue;
        out.push({
          sourceOrderId: String(w.id),
          amount: amount.toFixed(2),
          currency: w.currency || "DKK",
          reason: r.reason || "kreditnota",
          id: r.id,
        });
      }
    }
  }
  return out;
}

/** 2026-07 Order.transactions is a connection `{ nodes }`; older mocks/docs return a list. */
export function transactionList(tx) {
  if (!tx) return [];
  if (Array.isArray(tx)) return tx;
  if (Array.isArray(tx.nodes)) return tx.nodes;
  if (Array.isArray(tx.edges)) return tx.edges.map((e) => e.node).filter(Boolean);
  return [];
}

async function loadTransactions(client, orderGid) {
  try {
    const data = await client.graphql(QUERY_ORDER_TRANSACTIONS, { id: orderGid });
    return transactionList(data.order?.transactions);
  } catch (e) {
    const msg = e?.message || "";
    if (!/GraphQL errors|doesn't exist|Cannot query field/i.test(msg)) throw e;
    const data = await client.graphql(QUERY_ORDER_TRANSACTIONS_LIST, { id: orderGid });
    return transactionList(data.order?.transactions);
  }
}

export async function importRefunds(cfg, client, idmap) {
  if (!flagOn(cfg)) {
    return { skipped: true, reason: "importRefunds flag off — label-level folding only" };
  }
  const rows = collectRefunds(cfg);
  if (!rows.length) {
    log.info("Refunds: flag on but no refund rows with amounts — nothing to create");
    return { imported: 0, failed: 0, skippedEmpty: true };
  }
  if (cfg.options.dryRun) {
    return { imported: 0, failed: 0, dryRun: true, wouldImport: rows.length };
  }

  let imported = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];
  const skippedRows = [];
  const transformed = path.join(cfg.paths.transformed, "orders.jsonl");
  const unlandableParents = new Set();
  if (existsSync(transformed)) {
    for (const line of readJsonl(transformed)) {
      if (!(line.order?.lineItems || []).length) {
        unlandableParents.add(String(line.order?.sourceIdentifier || line.sourceIdentifier || line.id));
      }
    }
  }
  for (const row of rows) {
    const key = `refund:${row.sourceOrderId}:${row.id ?? row.amount}`;
    if (idmap.has("refunds", key)) continue;
    const orderGid = idmap.get("orders", row.sourceOrderId);
    if (!orderGid) {
      if (unlandableParents.has(String(row.sourceOrderId))) {
        skipped++;
        const skip = { sourceOrderId: row.sourceOrderId, id: row.id, error: "parent order unlandable (empty line items) — refund skipped, not invented" };
        skippedRows.push(skip);
        log.warn(`refund for source order ${row.sourceOrderId}: parent order unlandable (empty line items) — skip`);
        continue;
      }
      failed++;
      const miss = { sourceOrderId: row.sourceOrderId, id: row.id, error: "order not in ledger — import orders first" };
      failures.push(miss);
      log.warn(`refund for source order ${row.sourceOrderId}: order not in ledger — import orders first`);
      continue;
    }
    try {
      const txs = await loadTransactions(client, orderGid);
      const parent = txs.find((t) => /^(SALE|CAPTURE)$/i.test(t.kind || ""));
      if (!parent?.id) {
        skipped++;
        const skip = { sourceOrderId: row.sourceOrderId, id: row.id, key, error: "no SALE/CAPTURE transaction — refusing to invent (honest money only)", kinds: txs.map((t) => t.kind) };
        skippedRows.push(skip);
        log.warn(`refund ${key}: no parent SALE/CAPTURE transaction — refusing to invent (honest money only)`);
        continue;
      }
      await client.mutate("refundCreate", REFUND_CREATE, {
        input: {
          orderId: orderGid,
          note: row.reason,
          transactions: [{
            orderId: orderGid,
            parentId: parent.id,
            kind: "REFUND",
            gateway: parent.gateway || "import",
            amount: row.amount,
          }],
        },
        idempotencyKey: refundIdempotencyKey(`${key}:${orderGid}`),
      });
      idmap.set("refunds", key, `refunded:${row.amount}`);
      imported++;
    } catch (e) {
      failed++;
      failures.push({ sourceOrderId: row.sourceOrderId, id: row.id, key, error: e.message, userErrors: e.userErrors });
      log.warn(`refund ${key}: ${e.message}`);
    }
  }
  if (failures.length) await writeFailedJsonl(cfg.paths.state, "refunds", failures);
  else removeFile(path.join(cfg.paths.state, "failed-refunds.jsonl"));
  return { imported, failed, skipped, skippedRows };
}
