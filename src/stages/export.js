import path from "node:path";
import { createSource } from "../sources/index.js";
import { jsonlWriter, writeJson, readJson, removeFile } from "../util/fsx.js";
import { translationsEnabled } from "../transform/translations.js";
import { spinner } from "../ui.js";
import { log } from "../log.js";

/** O15 — per-entity resume cursor left by a failed walk. */
export function exportResumePath(rawDir, entity) {
  return path.join(rawDir, `export-resume-${entity}.json`);
}

/**
 * Stage 1 — EXPORT
 * Pulls raw data from the WordPress site and snapshots it to data/raw/*.jsonl.
 * Nothing is transformed here: raw snapshots make every later stage
 * reproducible and diffable, and mean the source site is only hit once.
 *
 * O15 — on failure, persist `err.resume` and on the next run reopen the jsonl
 * in append mode and pass the cursor into the generator.
 */
export async function runExport(cfg, entities, deps = {}) {
  const src = deps.source || createSource(cfg);
  const rawDir = cfg.paths.raw;
  const summary = { adapter: src.name, exportedAt: new Date().toISOString(), counts: {} };

  const jobs = [
    ["products", src.products, entities.products],
    ["categories", src.categories, entities.products || entities.collections || entities.redirects],
    ["customers", src.customers, entities.customers],
    ["orders", src.orders, entities.orders],
    ["coupons", src.coupons, entities.discounts],
    ["reviews", src.reviews, entities.products], // not importable — exported for the count + review-app handoff
    ["posts", src.posts, entities.articles],
    ["pages", src.pages, entities.pages],
    ["redirects", src.redirects, entities.redirects],
    ["i18n-products", src.translationLayers, entities.products && translationsEnabled(cfg)],
  ];

  if (src.settings) {
    summary.settings = (await src.settings()) || {};
    log.info(`Source settings: ${JSON.stringify(summary.settings)}`);
  }

  // The summary and the adapter's warnings are written on EVERY exit, including a
  // failed one. They used to be on the success path only, which meant the run that
  // most needs a record — a walk that died 40 minutes into 50k orders — produced
  // no summary.json and threw away every warning the adapter had accumulated,
  // including the FIELD_SET_REJECTED lines that would say why it died.
  try {
    for (const [name, generator, enabled] of jobs) {
      if (!enabled || !generator) { log.debug(`Skipping export of ${name}`); continue; }
      const resumeFile = exportResumePath(rawDir, name);
      const resume = readJson(resumeFile, null);
      const restarting = Boolean(resume?.restart);
      const out = jsonlWriter(path.join(rawDir, `${name}.jsonl`), { append: restarting });
      const sp = spinner(`exporting ${name}${restarting ? ` (resume @ ${resume.recordsDone ?? resume.restart.start ?? resume.restart.startPage ?? "?"})` : ""}…`);
      try {
        // Generators that ignore the resume arg still work (WP adapters).
        for await (const record of generator(restarting ? resume : undefined)) {
          await out.write(record);
          if (out.count % 10 === 0) sp.update(`exporting ${name}… ${out.count}`);
        }
        summary.counts[name] = await out.close();
        removeFile(resumeFile);
        sp.succeed(`${name}: ${summary.counts[name]} exported`);
      } catch (e) {
        summary.counts[name] = await out.close();
        if (e && typeof e === "object" && e.resume) {
          writeJson(resumeFile, e.resume);
          summary.resume = { entity: name, ...e.resume };
          log.warn(`export resume cursor saved -> ${resumeFile}`);
        }
        summary.failed = { entity: name, message: String(e?.message ?? e).slice(0, 500) };
        sp.fail(`${name}: failed after ${summary.counts[name]} — ${String(e?.message ?? e).slice(0, 120)}`);
        throw e;
      }
    }
    summary.complete = true;
  } finally {
    // Adapter-level warnings. Most warnings are produced by the transform, which
    // sees the records — but some facts are only visible to the adapter and only
    // during the export: "this shop has a blog and we do not export blogs" (D5),
    // "the server dropped a column we asked for" (R26). They ride in summary.json
    // and the transform folds them into warnings.jsonl, so they reach verify,
    // status and the operator through the one channel that already exists rather
    // than through a second one that would drift.
    //
    // Both calls are guarded: this block runs while an exception may already be in
    // flight, and a throw from HERE would replace the real cause with a secondary
    // failure in the reporting code — the worst possible trade.
    summary.complete = summary.complete === true;
    try {
      const w = src.warnings ? (src.warnings() || []) : [];
      if (w.length) {
        summary.warnings = w;
        const actions = w.filter((x) => x?.severity === "action").length;
        log.info(`Source warnings: ${w.length}${actions ? ` (${actions} need a human)` : ""}`);
      }
    } catch (e) {
      log.warn(`Could not read source warnings: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    try {
      // NOTE: writing this on a failed export also makes the source-side wipe gate
      // (util/machine.js WP_WIPE_GATE, seed.js) refuse for a half-exported source.
      // That is the direction to fail in — a partial export is still evidence the
      // shop is a real migration source and not a scratch shop.
      writeJson(path.join(rawDir, "summary.json"), summary);
    } catch (e) {
      log.warn(`Could not write summary.json: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  log.info(`Export complete -> ${rawDir}`);
  return summary;
}
