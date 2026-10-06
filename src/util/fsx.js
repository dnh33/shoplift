import { mkdirSync, createWriteStream, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }

// Pretty by default — most of what this writes (reports, config) gets read by a
// human. `compact` is for hot machine state like the idmap ledger, where the
// indentation is ~40% of the bytes on every rewrite and nobody reads it.
export function writeJson(file, obj, { compact = false } = {}) {
  ensureDir(path.dirname(file));
  writeFileSync(file, JSON.stringify(obj, null, compact ? 0 : 2));
}

export function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function removeFile(file) {
  try { if (existsSync(file)) unlinkSync(file); } catch { /* ignore */ }
}

/**
 * Stream-append JSON objects, one per line (JSONL).
 * O18 — `write` returns a Promise and awaits backpressure (`drain`) so callers
 * that `await write()` push bytes to disk mid-loop instead of buffering the
 * whole entity until `close()`. `close()` always drains the write chain first.
 * O15 — `{ append: true }` keeps prior lines when export resumes mid-entity.
 * Shared with the WordPress path; WP suites guard regressions.
 */
export function jsonlWriter(file, { append = false } = {}) {
  ensureDir(path.dirname(file));
  let count = 0;
  if (append && existsSync(file)) {
    const prev = readFileSync(file, "utf8");
    if (prev) count = prev.split("\n").filter(Boolean).length;
  }
  const stream = createWriteStream(file, { flags: append ? "a" : "w" });
  let chain = Promise.resolve();
  return {
    write(obj) {
      count++;
      const line = JSON.stringify(obj) + "\n";
      chain = chain.then(() => new Promise((resolve, reject) => {
        try {
          const ok = stream.write(line);
          if (ok) resolve();
          else stream.once("drain", resolve);
        } catch (err) {
          reject(err);
        }
      }));
      return chain;
    },
    async close() {
      await chain;
      await new Promise((res, rej) => stream.end((err) => (err ? rej(err) : res())));
      return count;
    },
    get count() { return count; }
  };
}

/** Flag-on landers persist misses here so a live 0/N is evidence, not a count. */
export async function writeFailedJsonl(stateDir, entity, rows) {
  const w = jsonlWriter(path.join(stateDir, `failed-${entity}.jsonl`));
  for (const row of rows) await w.write(row);
  return w.close();
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export { existsSync };
