/**
 * O15 — export persists err.resume, appends jsonl, and restarts from the cursor.
 * Kill-at-70% is the STATUS close: a walk that dies mid-entity must not truncate
 * prior lines, and the second run must start at resume.restart (start / startPage).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExport, exportResumePath } from "../src/stages/export.js";
import { readJsonl, readJson } from "../src/util/fsx.js";

function tmpRaw() {
  const dir = mkdtempSync(path.join(tmpdir(), "shoplift-o15-"));
  return { dir, raw: path.join(dir, "raw") };
}

describe("O15 export resume", () => {
  it("kill at 70%: persists resume, second run appends from start cursor, jsonl is complete", async () => {
    const { dir, raw } = tmpRaw();
    const starts = [];
    const all = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    async function* products(resume) {
      const start = Number(resume?.restart?.start ?? 0);
      starts.push(start);
      for (let i = start; i < all.length; i++) {
        if (!resume && i === 7) {
          const err = new Error("socket death at 70%");
          err.resume = { op: "Product_GetAllWithLimit", recordsDone: 7, restart: { start: i } };
          throw err;
        }
        yield all[i];
      }
    }
    const source = { name: "mock", products, warnings: () => [] };
    const cfg = { paths: { raw }, source: { adapter: "fixture" } };
    const entities = { products: true };
    try {
      await assert.rejects(
        () => runExport(cfg, entities, { source }),
        /socket death at 70%/,
      );
      const resumeFile = exportResumePath(raw, "products");
      assert.equal(existsSync(resumeFile), true, "resume file must exist after failure");
      const saved = readJson(resumeFile);
      assert.equal(saved.restart.start, 7);
      const mid = readJsonl(path.join(raw, "products.jsonl"));
      assert.deepEqual(mid.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7],
        "O14+O18: records written before the kill must already be on disk");

      const summary = await runExport(cfg, entities, { source });
      assert.equal(starts[0], 0);
      assert.equal(starts[1], 7, "second run must start from resume.restart.start, not 0");
      assert.equal(existsSync(resumeFile), false, "resume file deleted on success");
      const final = readJsonl(path.join(raw, "products.jsonl"));
      assert.deepEqual(final.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      // close() count includes prior lines when append:true
      assert.equal(summary.counts.products, 10);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("kill at 70% on orders: second run starts from startPage", async () => {
    const { dir, raw } = tmpRaw();
    const startPages = [];
    const all = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    async function* orders(resume) {
      const startPage = Number(resume?.restart?.startPage ?? 0);
      startPages.push(startPage);
      for (let i = startPage; i < all.length; i++) {
        if (!resume && i === 7) {
          const err = new Error("socket death at 70%");
          err.resume = { op: "Order_GetAllWithPagination", recordsDone: 7, restart: { startPage: i, pageBase: 1 } };
          throw err;
        }
        yield all[i];
      }
    }
    const source = { name: "mock", orders, warnings: () => [] };
    const cfg = { paths: { raw }, source: { adapter: "fixture" } };
    const entities = { orders: true };
    try {
      await assert.rejects(() => runExport(cfg, entities, { source }), /socket death at 70%/);
      const saved = readJson(exportResumePath(raw, "orders"));
      assert.equal(saved.restart.startPage, 7);
      assert.equal(saved.restart.pageBase, 1);
      await runExport(cfg, entities, { source });
      assert.equal(startPages[0], 0);
      assert.equal(startPages[1], 7, "second run must start from resume.restart.startPage");
      assert.deepEqual(readJsonl(path.join(raw, "orders.jsonl")).map((r) => r.id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(existsSync(exportResumePath(raw, "orders")), false);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
