import path from "node:path";
import { readJson, readJsonl } from "../util/fsx.js";
import { openIdMap } from "../util/idmap.js";

/**
 * Aggregate every state file of the active pair into ONE object — the answer
 * to an agent's first question, "where is this migration?", without it having
 * to know the file layout. All blocks are null when their stage hasn't run.
 */
export function collectStatus(cfg, { verbose = true } = {}) {
  const p = cfg.paths;
  const raw = readJson(path.join(p.raw, "summary.json"), null);
  const tr = readJson(path.join(p.transformed, "summary.json"), null);
  const importReport = readJson(path.join(p.state, "import-report.json"), null);
  const verify = readJson(path.join(p.data, "verify-report.json"), null);
  const seed = readJson(path.join(p.state, "seed-report.json"), null);
  const liveRun = readJson(path.join(p.state, "live-run-summary.json"), null);
  const warnings = readJsonl(path.join(p.transformed, "warnings.jsonl"));
  const led = openIdMap(p.state);
  const ledger = Object.fromEntries(
    ["products", "variantsBySku", "collections", "customers", "discounts", "blogs", "articles", "pages", "orders"].map((k) => [k, led.count(k)])
  );
  const failed = {};
  for (const entity of ["products", "customers", "orders", "discounts", "content"]) {
    const rows = readJsonl(path.join(p.state, `failed-${entity}.jsonl`));
    if (rows.length) failed[entity] = rows.length;
  }
  const sev = (w) => w.severity || "action";
  const actions = warnings.filter((w) => sev(w) === "action");
  return {
    pair: { source: cfg.source?.baseUrl || null, adapter: cfg.source?.adapter || null, target: cfg.shopify?.shop || null, dataDir: p.data },
    exported: raw ? { at: raw.exportedAt, counts: raw.counts, settings: raw.settings || null } : null,
    transformed: tr ? { at: tr.transformedAt, counts: tr.counts, severities: tr.severities } : null,
    seed: seed ? { tier: seed.tier, at: seed.seededAt, probes: seed.summary?.real?.probes || null } : null,
    ledger,
    // `dryRun` is forwarded deliberately: a preview writes the same
    // import-report.json, so without it lastImport shows zeros that read
    // exactly like a real import which wrote nothing. Older reports predate
    // the field, so treat a missing value as false rather than unknown.
    lastImport: importReport ? { startedAt: importReport.startedAt, finishedAt: importReport.finishedAt, dryRun: importReport.dryRun === true, results: importReport.results } : null,
    lastLiveRun: liveRun ? { ok: liveRun.ok, at: liveRun.finishedAt, failedStage: liveRun.failedStage || null } : null,
    verify: verify ? { at: verify.verifiedAt, ok: verify.ok, counts: verify.counts, failures: verify.failures, dirtyTarget: verify.dirtyTarget || null, staleTarget: verify.staleTarget || null } : null,
    failed,
    // action items are the human/agent punch list. D3 (2026-07-28 live MCP
    // test): status is the documented "run this first" tool, so the default
    // (verbose:false) drops the long `message` prose (~4KB/call on a real
    // store) and keeps only entity/id/code/severity — enough to count and
    // branch on. Pass verbose:true for the human-readable text to relay.
    warnings: {
      actions: verbose ? actions : actions.map(({ message, ...rest }) => rest),
      handled: warnings.filter((w) => sev(w) === "handled").length,
      info: warnings.filter((w) => sev(w) === "info").length
    }
  };
}
