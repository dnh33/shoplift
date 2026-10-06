#!/usr/bin/env node
/**
 * run-real-tier-live.mjs — one-shot NON-INTERACTIVE live runner for the
 * `real` tier verification matrix.
 *
 * Sequence: doctor → wipe WP (source!) → wipe Shopify (dev-store gate stays)
 *           → seed --tier real → export → transform → import → verify
 *
 * DESTRUCTIVE by design (test pair only): wipes BOTH sides first so the
 * pre-declared expected numbers in the PLAN are verifiable. Every stage is
 * idempotent/resumable — re-running this script after a crash is safe.
 *
 * Usage (from the repo root; survives the caller disconnecting):
 *   setsid nohup node scripts/run-real-tier-live.mjs > live-run.log 2>&1 < /dev/null &
 * Then watch:  tail -n 25 live-run.log
 * NB: the log lives in the repo ROOT on purpose — the wipe-shopify stage
 *     deletes data/state/ (ledger reset), which would unlink a log kept there.
 * Machine-readable outcome: data/state/live-run-summary.json (written at the end)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { writeJson } from "../src/util/fsx.js";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const cfg = loadConfig(process.argv[2] || path.join(ROOT, "config", "migration.config.json"));

const t0 = Date.now();
const summary = { startedAt: new Date().toISOString(), stages: {}, ok: false };
const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const finish = (code) => {
  summary.finishedAt = new Date().toISOString();
  summary.elapsedMin = Number(((Date.now() - t0) / 60000).toFixed(1));
  summary.ok = code === 0;
  writeJson(path.join(cfg.paths.state, "live-run-summary.json"), summary);
  say(code === 0 ? `=== REAL-TIER RUN COMPLETE (${summary.elapsedMin} min) ===` : `=== REAL-TIER RUN FAILED (stage: ${summary.failedStage}) ===`);
  process.exit(code);
};
process.on("unhandledRejection", (e) => { say(`UNHANDLED: ${e?.stack || e}`); summary.failedStage = summary.failedStage || "unhandled"; finish(2); });

async function stage(name, fn) {
  const s0 = Date.now();
  say(`=== STAGE: ${name} ===`);
  try {
    const out = await fn();
    summary.stages[name] = { ok: true, seconds: Math.round((Date.now() - s0) / 1000), ...(out ? { result: out } : {}) };
    say(`=== STAGE OK: ${name} (${summary.stages[name].seconds}s) ===`);
    return out;
  } catch (e) {
    summary.stages[name] = { ok: false, seconds: Math.round((Date.now() - s0) / 1000), error: String(e?.message || e).slice(0, 400) };
    summary.failedStage = name;
    say(`=== STAGE FAILED: ${name} — ${e?.stack || e} ===`);
    finish(1);
  }
}

// 1 — connections
await stage("doctor", async () => {
  const { runDoctor } = await import("../src/stages/doctor.js");
  const { ok } = await runDoctor(cfg);
  if (!ok) throw new Error("doctor reported connection problems — aborting before any destructive step");
});

// 2 — wipe WordPress source (real tier is STANDALONE; old tier data pollutes counts)
await stage("wipe-wordpress", async () => {
  const { wipeWordPress } = await import("../src/seed.js");
  const { createWpApi } = await import("../src/wp-bootstrap.js");
  const user = cfg.source.wpContent?.username || cfg.source.woocommerce?.consumerKey;
  const pass = cfg.source.wpContent?.appPassword || cfg.source.woocommerce?.consumerSecret;
  if (!user || !pass) throw new Error("no WP write credentials in config");
  const api = createWpApi({ site: cfg.source.baseUrl, username: user, password: pass });
  const res = await wipeWordPress({ api, cfg, logger: say });
  say(`WP wiped: ${JSON.stringify(res)}`);
  return res;
});

// 3 — wipe Shopify target (dev-store-only gate inside runWipe; also clears ledger)
await stage("wipe-shopify", async () => {
  const { runWipe } = await import("../src/stages/wipe.js");
  await runWipe(cfg, { yes: true });
});

// 4 — seed the real tier (probes logged, never fatal)
await stage("seed-real", async () => {
  const { seedDataset } = await import("../src/seed.js");
  const { createWpApi } = await import("../src/wp-bootstrap.js");
  const user = cfg.source.wpContent?.username || cfg.source.woocommerce?.consumerKey;
  const pass = cfg.source.wpContent?.appPassword || cfg.source.woocommerce?.consumerSecret;
  const api = createWpApi({ site: cfg.source.baseUrl, username: user, password: pass });
  const s = await seedDataset({ api, site: cfg.source.baseUrl, tier: "real", logger: say });
  writeJson(path.join(cfg.paths.state, "seed-report.json"), { tier: "real", seededAt: new Date().toISOString(), summary: s });
  say(`SEED SUMMARY: ${JSON.stringify(s.real, null, 1)}`);
  say(`PROBES: ${JSON.stringify(s.real?.probes)}`);
  return { counts: { products: s.real?.products, customers: s.real?.customers, orders: s.real?.orders }, probes: s.real?.probes };
});

// 5-8 — the pipeline itself
const entities = { ...cfg.entities };
await stage("export", async () => {
  const { runExport } = await import("../src/stages/export.js");
  const s = await runExport(cfg, entities);
  return { counts: s.counts };
});
await stage("transform", async () => {
  const { runTransform } = await import("../src/transform/index.js");
  const { counts, severities, warnings } = await runTransform(cfg, entities);
  const byCode = {};
  for (const w of warnings) byCode[w.code] = (byCode[w.code] || 0) + 1;
  say(`WARNINGS BY CODE: ${JSON.stringify(byCode)}`);
  return { counts, severities, byCode };
});
await stage("import", async () => {
  const { runImport } = await import("../src/import/index.js");
  const report = await runImport(cfg, entities);
  return { results: Object.fromEntries(Object.entries(report.results).map(([k, v]) => [k, v])) };
});
await stage("verify", async () => {
  const { runVerify } = await import("../src/stages/verify.js");
  const report = await runVerify(cfg);
  return { ok: report.ok, counts: report.counts, failures: report.failures, actionWarnings: report.warnings, dirtyTarget: report.dirtyTarget, staleTarget: report.staleTarget };
});

finish(0);
