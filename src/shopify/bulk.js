import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sleep, fetchRetry } from "../util/http.js";
import { spinner, isTTY } from "../ui.js";
import { log } from "../log.js";
import { STAGED_UPLOADS_CREATE, BULK_RUN_MUTATION, BULK_OP_BY_ID, CURRENT_BULK_MUTATION } from "./mutations.js";

/**
 * Shopify bulk import flow (the recommended path for large datasets):
 *   1. stagedUploadsCreate  (resource BULK_MUTATION_VARIABLES, mimeType text/jsonl)
 *   2. multipart POST of the JSONL file to the returned staged URL
 *   3. bulkOperationRunMutation(mutation, stagedUploadPath)
 *   4. poll currentBulkOperation(type: MUTATION) until COMPLETED/FAILED
 *   5. download the result JSONL (one result object per input line)
 *
 * Limits (2026): JSONL <= 100 MB, op must finish within 24h, mutation may touch
 * one connection field; 2026-01+ allows up to 5 concurrent bulk mutations per
 * app per shop. Bulk operations don't consume the normal cost bucket.
 */
export async function runBulkMutation(client, { jsonlFile, mutation, label = "bulk", total = null }) {
  const size = statSync(jsonlFile).size;
  if (size > 95 * 1024 * 1024) {
    throw new Error(`${jsonlFile} is ${(size / 1e6).toFixed(0)} MB — over Shopify's 100 MB bulk limit. Split the file (see docs/README).`);
  }

  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);
  const sp = spinner(`${label}: staging ${(size / 1024).toFixed(0)} kB JSONL…`);

  // 1. reserve staged upload
  const staged = await client.mutate("stagedUploadsCreate", STAGED_UPLOADS_CREATE, {
    input: [{ resource: "BULK_MUTATION_VARIABLES", filename: path.basename(jsonlFile), mimeType: "text/jsonl", httpMethod: "POST" }]
  });
  const target = staged.stagedTargets?.[0];
  if (!target) { sp.fail(`${label}: stagedUploadsCreate returned no target`); throw new Error("stagedUploadsCreate returned no target"); }
  sp.update(`${label}: uploading ${(size / 1024).toFixed(0)} kB to Shopify's staging bucket…`);

  // 2. multipart upload — parameters MUST precede the file part
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([readFileSync(jsonlFile)], { type: "text/jsonl" }), path.basename(jsonlFile));
  const upload = await fetchRetry(target.url, { method: "POST", body: form });
  if (!upload.ok) throw new Error(`Staged upload failed: HTTP ${upload.status} ${await upload.text().then((t) => t.slice(0, 300))}`);

  // Shopify returns the staged path in the "key" parameter
  const stagedUploadPath = target.parameters.find((p) => p.name === "key")?.value;
  if (!stagedUploadPath) throw new Error("No 'key' parameter in staged upload target");

  // 3. run
  sp.update(`${label}: submitting bulk operation…`);
  const run = await client.mutate("bulkOperationRunMutation", BULK_RUN_MUTATION, { mutation, stagedUploadPath });
  const opId = run.bulkOperation?.id;
  sp.update(`${label}: queued on Shopify's side (${opId?.split("/").pop()}) — waiting for it to start…`);
  if (!isTTY) log.info(`[${label}] bulk operation started: ${opId}`);

  // 4. poll — bulkOperation(id:) on 2026-01+, currentBulkOperation on older versions
  let waited = 0;
  let legacyPoll = false;
  let firstSeen = null; // [timestamp, objectCount] — for rate/ETA
  for (;;) {
    await sleep(Math.min(2000 + waited * 100, 15000));
    waited++;
    let op;
    if (!legacyPoll) {
      try {
        op = (await client.graphql(BULK_OP_BY_ID, { id: opId })).bulkOperation;
      } catch (e) {
        if (/doesn't exist|undefinedField|Field 'bulkOperation'/i.test(e.message)) { legacyPoll = true; continue; }
        throw e;
      }
    } else {
      op = (await client.graphql(CURRENT_BULK_MUTATION)).currentBulkOperation;
      if (op && op.id !== opId) { log.debug(`[${label}] another bulk op is current — waiting`); continue; }
    }
    if (!op) { log.debug(`[${label}] waiting for operation visibility...`); continue; }
    if (op.status === "COMPLETED") {
      sp.update(`${label}: downloading result file…`);
      const results = op.url ? await downloadJsonl(op.url) : [];
      sp.succeed(`${label}: ${op.objectCount} objects processed in ${elapsed()}s`);
      if (!isTTY) log.info(`[${label}] completed — ${op.objectCount} objects in ${elapsed()}s`);
      return { ...op, results };
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(op.status)) {
      sp.fail(`${label}: bulk operation ${op.status} (${op.errorCode || "unknown"}) after ${elapsed()}s`);
      const partial = op.partialDataUrl ? await downloadJsonl(op.partialDataUrl) : [];
      throw Object.assign(new Error(`[${label}] bulk operation ${op.status}: ${op.errorCode || "unknown"}`), { partial });
    }
    // live telemetry: count, rate, ETA
    const n = Number(op.objectCount || 0);
    if (n && !firstSeen) firstSeen = [Date.now(), n];
    let tail = "";
    if (n && firstSeen && Date.now() - firstSeen[0] > 3000) {
      const rate = (n - firstSeen[1]) / ((Date.now() - firstSeen[0]) / 1000);
      if (rate > 0 && total) tail = ` · ~${Math.max(1, Math.round((total - n) / rate))}s left`;
      else if (rate > 0) tail = ` · ${rate.toFixed(1)}/s`;
    }
    sp.update(`${label}: ${op.status} · ${n}${total ? `/${total}` : ""} objects · ${elapsed()}s${tail}`);
    if (!isTTY && waited % 10 === 0) log.info(`[${label}] status ${op.status}, ${n} objects processed...`);
  }
}

async function downloadJsonl(url) {
  const res = await fetchRetry(url);
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
