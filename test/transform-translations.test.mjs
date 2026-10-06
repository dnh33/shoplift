import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeTranslationsJsonl, translationsEnabled, shopifyLocaleFromIso } from "../src/transform/translations.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(HERE, "..", "data-test-translations");

describe("transform translations writer (P6)", () => {
  test("shopifyLocaleFromIso maps DK → da and recorded UK → en", () => {
    assert.equal(shopifyLocaleFromIso("DK"), "da");
    assert.equal(shopifyLocaleFromIso("EN"), "en");
    assert.equal(shopifyLocaleFromIso("UK"), "en");
  });

  test("writes translations.jsonl when flag on", async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, "raw"), { recursive: true });
    mkdirSync(path.join(dir, "transformed"), { recursive: true });
    writeFileSync(path.join(dir, "raw", "products.jsonl"), JSON.stringify({ id: 1, slug: "demo-1", name: "Demo" }) + "\n");
    writeFileSync(path.join(dir, "raw", "i18n-products.jsonl"), JSON.stringify({
      productId: "1", languageISO: "EN",
      fields: { title: "Demo EN", bodyHtml: "<p>English</p>" },
    }) + "\n");
    const cfg = {
      source: { dandomain: {} },
      options: { importTranslations: true },
      paths: { raw: path.join(dir, "raw"), transformed: path.join(dir, "transformed") },
    };
    assert.equal(translationsEnabled(cfg), true);
    const res = await writeTranslationsJsonl(cfg, cfg.paths.transformed);
    assert.ok(res.written >= 2);
    const lines = readFileSync(path.join(dir, "transformed", "translations.jsonl"), "utf8").trim().split("\n");
    const rows = lines.map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.locale === "en" && r.key === "title" && r.value === "Demo EN"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("skips when flag off", async () => {
    const cfg = { source: { dandomain: {} }, options: {}, paths: { raw: dir, transformed: dir } };
    assert.equal(translationsEnabled(cfg), false);
    const res = await writeTranslationsJsonl(cfg, dir);
    assert.equal(res.skipped, true);
  });
});
