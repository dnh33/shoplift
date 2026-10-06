/**
 * O18 — jsonlWriter must await backpressure so bytes reach disk mid-loop.
 * Measured close: after many write() awaits, the file exists with growing size
 * before close(). A no-op drain would leave the file missing or empty until end.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonlWriter } from "../src/util/fsx.js";

describe("O18 jsonlWriter drain", () => {
  it("awaits backpressure: bytes on disk mid-loop before close()", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shoplift-o18-"));
    const file = path.join(dir, "products.jsonl");
    try {
      const w = jsonlWriter(file);
      // Large enough that the write buffer fills and forces drain waits.
      const payload = { id: 0, body: "x".repeat(64 * 1024) };
      let midSize = 0;
      let sawFileMidLoop = false;
      for (let i = 0; i < 200; i++) {
        payload.id = i;
        await w.write(payload);
        if (i === 50 || i === 100 || i === 150) {
          sawFileMidLoop = existsSync(file);
          if (sawFileMidLoop) midSize = Math.max(midSize, statSync(file).size);
        }
      }
      assert.equal(sawFileMidLoop, true, "file must exist mid-loop (not only after close)");
      assert.ok(midSize > 0, `mid-loop size must be > 0, got ${midSize}`);
      const n = await w.close();
      assert.equal(n, 200);
      const finalSize = statSync(file).size;
      assert.ok(finalSize >= midSize, `final ${finalSize} must be >= mid ${midSize}`);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("O15 — { append: true } keeps prior lines (flags a)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shoplift-o15-append-"));
    const file = path.join(dir, "products.jsonl");
    try {
      const first = jsonlWriter(file);
      await first.write({ id: 1 });
      await first.write({ id: 2 });
      await first.close();
      const second = jsonlWriter(file, { append: true });
      await second.write({ id: 3 });
      const n = await second.close();
      assert.equal(n, 3, "count must include lines already on disk");
      const { readJsonl } = await import("../src/util/fsx.js");
      assert.deepEqual(readJsonl(file).map((r) => r.id), [1, 2, 3]);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("write() returns a thenable so callers can await drain", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shoplift-o18b-"));
    const file = path.join(dir, "one.jsonl");
    try {
      const w = jsonlWriter(file);
      const ret = w.write({ a: 1 });
      assert.equal(typeof ret?.then, "function", "write must return a Promise");
      await ret;
      await w.close();
      assert.ok(existsSync(file));
      assert.ok(statSync(file).size > 0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
