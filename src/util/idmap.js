import path from "node:path";
import { readJson, writeJson } from "./fsx.js";

/**
 * Persistent ledger mapping source IDs -> Shopify GIDs.
 * Makes every import stage resumable/idempotent: already-imported records are skipped.
 *
 * Writes are BATCHED, because save() rewrites the whole file and the importers
 * called it once per record. That is O(n^2): at 10k products plus ~30k variant
 * SKUs the ledger is ~2.5 MB (measured: 943 entries = 59 KB, ~63 B/entry), so
 * the products loop alone rewrote it 10,000 times — on the order of 12 GB of
 * writes to record 2.5 MB of state.
 *
 * orders.js already avoided this with a call-site `if (imported % 25 === 0)`,
 * which nobody copied — so the batching belongs HERE, where every caller gets it,
 * rather than in seven loops that can each forget it.
 *
 * Durability: batching means a crash can lose up to LEDGER_BATCH entries, and
 * those records are re-imported on the next run. For products and collections
 * that costs nothing (productSet upserts on handle; collections are looked up by
 * handle first). For orders it risks a duplicate — which is precisely the risk
 * orders' own `% 25` already accepted, so the threshold is 25 to preserve that
 * worst case rather than widen it. Stage boundaries call flush()
 * (src/import/index.js), so a crash can only cost the stage in flight.
 */
const LEDGER_BATCH = 25;

export function openIdMap(statePath) {
  const file = path.join(statePath, "idmap.json");
  const map = readJson(file, {}) || {};
  const ns = (name) => (map[name] = map[name] || {});
  let dirty = 0;
  // compact: this is machine state, not something a human reads — `status` exists
  // for that. Pretty-printing a multi-MB ledger is overhead on every write.
  const write = () => { writeJson(file, map, { compact: true }); dirty = 0; };
  return {
    get: (namespace, key) => ns(namespace)[String(key)],
    set(namespace, key, value) { ns(namespace)[String(key)] = value; dirty++; },
    has: (namespace, key) => String(key) in ns(namespace),
    all: (namespace) => ({ ...ns(namespace) }),
    count: (namespace) => Object.keys(ns(namespace)).length,
    /** Cheap: writes only once LEDGER_BATCH mutations have accumulated. */
    save() { if (dirty >= LEDGER_BATCH) write(); },
    /** Durability boundary: write now if anything is pending. */
    flush() { if (dirty) write(); },
    /** Mutations not yet on disk — for tests and diagnostics. */
    get pending() { return dirty; }
  };
}
