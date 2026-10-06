import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { existsSync } from "../util/fsx.js";
import { fetchRetry, sleep } from "../util/http.js";
import { STAGED_UPLOADS_CREATE, URL_REDIRECT_IMPORT_CREATE, URL_REDIRECT_IMPORT_SUBMIT, URL_REDIRECT_IMPORT_STATUS } from "../shopify/mutations.js";
import { log } from "../log.js";

/**
 * 301 redirect import via the native flow:
 *   stagedUploadsCreate (resource URL_REDIRECT_IMPORT, text/csv)
 *   -> upload CSV -> urlRedirectImportCreate(url) -> urlRedirectImportSubmit
 *   -> poll urlRedirectImport for createdCount/failedCount.
 * The same CSV (data/transformed/redirects.csv) can also be uploaded by hand
 * in Shopify admin under Content -> Menus -> URL redirects -> Import.
 */
export async function importRedirects(cfg, client, idmap) {
  const csvFile = path.join(cfg.paths.transformed, "redirects.csv");
  if (!existsSync(csvFile) || statSync(csvFile).size < 30) { log.info("No redirects to import"); return { created: 0, failed: 0 }; }
  if (cfg.options.dryRun) { log.info(`[dry-run] would import redirects from ${csvFile}`); return { created: 0, failed: 0, dryRun: true }; }

  // staleness guard: if the redirect SET changed since the last import
  // (different dataset / re-transform), the "finished" flag must not skip it
  const rowCount = readFileSync(csvFile, "utf8").trim().split("\n").length - 1;
  if (idmap?.get("redirects", "finished") && idmap.get("redirects", "rowCount") !== rowCount) {
    log.info(`Redirect set changed (${idmap.get("redirects", "rowCount") ?? "?"} -> ${rowCount} rows) — re-importing`);
    idmap.set("redirects", "finished", false);
    idmap.set("redirects", "lastImportId", null);
  }

  // resumable: if a previous run already submitted an import, poll it instead of re-uploading
  const pendingId = idmap?.get("redirects", "lastImportId");
  if (pendingId && !idmap.get("redirects", "finished")) {
    log.info(`Redirect import ${pendingId} was already submitted — polling status...`);
    const done = await poll(client, pendingId, idmap);
    if (done) return done;
    log.warn("Previous redirect import not finished — submitting a fresh one");
  } else if (pendingId && idmap.get("redirects", "finished")) {
    log.info("Redirects already imported — skipping");
    // `created`/`failed` mean "what THIS run did", the same as every other
    // entity in the report (products report imported:0 when the ledger skips
    // them). Returning the ledger's cumulative count here instead made a
    // no-op re-run look like it created 148 redirects — both to an agent
    // summing results.* and in the summary line, which reads this field.
    // The cumulative figures stay available under their own names.
    return { created: 0, failed: 0, skipped: true, alreadyCreated: idmap.get("redirects", "createdCount"), alreadyFailed: idmap.get("redirects", "failedCount") };
  }

  const staged = await client.mutate("stagedUploadsCreate", STAGED_UPLOADS_CREATE, {
    input: [{ resource: "URL_REDIRECT_IMPORT", filename: "redirects.csv", mimeType: "text/csv", httpMethod: "POST" }]
  });
  const target = staged.stagedTargets?.[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([readFileSync(csvFile)], { type: "text/csv" }), "redirects.csv");
  const up = await fetchRetry(target.url, { method: "POST", body: form });
  if (!up.ok) throw new Error(`Redirect CSV staged upload failed: HTTP ${up.status}`);

  // For this resource type resourceUrl can come back as the bare bucket root —
  // urlRedirectImportCreate needs the full object URL (bucket url + key).
  const key = target.parameters.find((p) => p.name === "key")?.value;
  const fileUrl = key && !(target.resourceUrl || "").includes(key)
    ? `${target.url.replace(/\/$/, "")}/${key}`
    : target.resourceUrl;

  const created = await client.mutate("urlRedirectImportCreate", URL_REDIRECT_IMPORT_CREATE, { url: fileUrl });
  const importId = created.urlRedirectImport.id;
  await client.mutate("urlRedirectImportSubmit", URL_REDIRECT_IMPORT_SUBMIT, { id: importId });
  if (idmap) { idmap.set("redirects", "lastImportId", importId); idmap.set("redirects", "finished", false); idmap.set("redirects", "rowCount", rowCount); idmap.flush(); }
  log.info(`Redirect import submitted (${importId}) — polling...`);

  const done = await poll(client, importId, idmap);
  if (done) return done;
  log.warn("Redirect import still running after 3 min — it finishes server-side; re-run import later or check admin (Content -> Menus -> URL redirects)");
  return { created: null, failed: null, pending: true };
}

async function poll(client, importId, idmap) {
  const { spinner } = await import("../ui.js");
  const { URL_REDIRECT_IMPORT_STATUS_BASIC } = await import("../shopify/mutations.js");
  const sp = spinner("redirects: Shopify is importing the CSV…");
  let query = URL_REDIRECT_IMPORT_STATUS;
  for (let i = 0; i < 60; i++) {
    let data;
    try { data = await client.graphql(query, { id: importId }); }
    catch (e) {
      if (/updatedCount/.test(e.message)) { query = URL_REDIRECT_IMPORT_STATUS_BASIC; continue; } // older schema
      throw e;
    }
    const st = data.urlRedirectImport;
    const done = (st?.createdCount ?? 0) + (st?.updatedCount ?? 0);
    sp.update(`redirects: importing… ${done} processed · ${(i + 1) * 3}s`);
    if (st?.finished) {
      if (idmap) {
        idmap.set("redirects", "finished", true);
        idmap.set("redirects", "createdCount", st.createdCount);
        idmap.set("redirects", "failedCount", st.failedCount);
        idmap.flush();
      }
      const created = st.createdCount ?? 0, updated = st.updatedCount ?? 0, failedN = st.failedCount ?? 0;
      const summary = `redirects: ${created} created${updated ? `, ${updated} updated (paths already existed)` : ""}, ${failedN} failed` +
        (created + updated + failedN === 0 ? " — 0 changes usually means identical redirects already exist; spot-check one URL in admin" : "");
      sp.succeed(summary);
      if (idmap) { idmap.set("redirects", "updatedCount", updated); }
      return { created, updated, failed: failedN };
    }
    if (!st) { sp.fail(`redirect import ${importId} not found — will re-submit`); return null; }
    await sleep(3000);
  }
  sp.stop();
  return null;
}
