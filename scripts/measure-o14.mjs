#!/usr/bin/env node
/**
 * O14 re-measure — same question as the STATUS cliff: does the walk hold the
 * whole entity before the first record leaves the generator?
 *
 * Synthetic pages (no network). Writes data/probes/o14-remeasure.json.
 *
 * Compares:
 *   - bufferAll: push every record, then iterate (old readAll / cosmetic async*)
 *   - yieldPerPage: for each page, touch records then drop the page (products path)
 *
 * Memory: heapUsed + external (Buffers land in external).
 * Orders still buffer for decideLineBasis — residual noted in observation.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "probes", "o14-remeasure.json");

function memMb() {
  const m = process.memoryUsage();
  return Math.round(((m.heapUsed + m.external) / (1024 * 1024)) * 10) / 10;
}

function makePage(page, pageSize, bytesPer) {
  const records = [];
  for (let i = 0; i < pageSize; i++) {
    records.push({
      Id: String(page * pageSize + i),
      body: Buffer.alloc(Math.max(64, bytesPer - 64), page & 0xff),
      Price: "100",
      Total: "80",
    });
  }
  return records;
}

async function bufferAll(pages, pageSize, bytesPer) {
  const before = memMb();
  const all = [];
  let firstAt = null;
  for (let p = 0; p < pages; p++) {
    all.push(...makePage(p, pageSize, bytesPer));
  }
  for (const _ of all) {
    if (firstAt === null) firstAt = memMb();
    break;
  }
  const peak = memMb();
  // retain until return so GC cannot hide the cliff
  const retained = all.length;
  return {
    mode: "bufferAll",
    records: retained,
    memBeforeMb: before,
    memAtFirstMb: firstAt,
    memPeakMb: peak,
    deltaToFirstMb: Math.round((firstAt - before) * 10) / 10,
    deltaPeakMb: Math.round((peak - before) * 10) / 10,
    _keep: all,
  };
}

async function yieldPerPage(pages, pageSize, bytesPer) {
  const before = memMb();
  let firstAt = null;
  let seen = 0;
  let peak = before;
  for (let p = 0; p < pages; p++) {
    const page = makePage(p, pageSize, bytesPer);
    for (const _ of page) {
      seen += 1;
      if (firstAt === null) firstAt = memMb();
    }
    peak = Math.max(peak, memMb());
  }
  return {
    mode: "yieldPerPage",
    records: seen,
    memBeforeMb: before,
    memAtFirstMb: firstAt,
    memPeakMb: peak,
    deltaToFirstMb: Math.round((firstAt - before) * 10) / 10,
    deltaPeakMb: Math.round((peak - before) * 10) / 10,
  };
}

for (let i = 0; i < 1000; i++) JSON.stringify({ i, x: "y".repeat(100) });
global.gc?.();

// Full 50k×20KB ≈ STATUS cliff (~1 GB). This run: 5k×8KB so a laptop finishes;
// the ratio (stream vs buffer) is the close signal.
const PAGE_SIZE = 100;
const PAGES = 50;
const BYTES = 8 * 1024;

const buffer = await bufferAll(PAGES, PAGE_SIZE, BYTES);
const bufferOut = { ...buffer };
delete bufferOut._keep;
buffer._keep = null;
global.gc?.();

const streamed = await yieldPerPage(PAGES, PAGE_SIZE, BYTES);

const closes = streamed.deltaToFirstMb <= Math.max(2, bufferOut.deltaToFirstMb * 0.15)
  && streamed.deltaPeakMb < bufferOut.deltaPeakMb * 0.35;

const result = {
  measuredAt: new Date().toISOString(),
  params: { pages: PAGES, pageSize: PAGE_SIZE, records: PAGES * PAGE_SIZE, approxBytesPerRecord: BYTES },
  bufferAll: bufferOut,
  yieldPerPage: streamed,
  closesO14Harness: closes,
  observation: `At ${PAGES * PAGE_SIZE} synthetic ~${BYTES}B records (heap+external): bufferAll deltaToFirst=${bufferOut.deltaToFirstMb}MB peak=${bufferOut.deltaPeakMb}MB; yieldPerPage deltaToFirst=${streamed.deltaToFirstMb}MB peak=${streamed.deltaPeakMb}MB. products() matches yieldPerPage (test: first product before page 2). orders() still buffers for decideLineBasis + credit-note Origin (residual O(n) peak on the order entity).`,
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
