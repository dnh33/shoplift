/**
 * Generated Example SeoLink/title uniqueness (dd-real-xl HANDLE_COLLISION 104).
 * Live: GEN-0088 / GEN-0036 NOT FOUND — last-writer XL tail shared seo `plaid-NNNN`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  LADDER_COUNTS,
  generatedProducts,
  awkwardRealProducts,
  BROHAVE_CATEGORIES,
} from "../src/seed-dandomain-catalog.js";

const SENTINEL = "DDSEED-";

describe("generated Hostedshop catalogue uniqueness", () => {
  test("dd-real GEN and dd-real-xl tail do not share SeoLink or title", () => {
    const gen = generatedProducts({
      prefix: `${SENTINEL}P-GEN-`,
      count: LADDER_COUNTS.realGenProducts,
      categoryKeys: ["bolig", "tekstiler"],
    });
    const xl = generatedProducts({
      prefix: `${SENTINEL}P-XL-`,
      count: LADDER_COUNTS.xlTailProducts,
      categoryKeys: ["bolig", "tekstiler"],
    });
    assert.equal(gen.length, 104);
    assert.equal(xl.length, 230);

    const genSeo = new Set(gen.map((p) => p.seo));
    const xlSeo = new Set(xl.map((p) => p.seo));
    const seoClash = [...genSeo].filter((s) => xlSeo.has(s));
    assert.equal(seoClash.length, 0, `SeoLink clash: ${seoClash.slice(0, 8).join(", ")}`);

    const genTitle = new Set(gen.map((p) => p.title));
    const xlTitle = new Set(xl.map((p) => p.title));
    const titleClash = [...genTitle].filter((t) => xlTitle.has(t));
    assert.equal(titleClash.length, 0, `title clash: ${titleClash.slice(0, 8).join(", ")}`);

    assert.equal(genSeo.size, gen.length, "GEN SeoLinks are unique within the GEN set");
    assert.equal(xlSeo.size, xl.length, "XL SeoLinks are unique within the XL set");
    assert.ok(gen[0].seo.includes("gen"), `GEN seo carries prefix tag, got ${gen[0].seo}`);
    assert.ok(xl[0].seo.includes("xl"), `XL seo carries prefix tag, got ${xl[0].seo}`);
  });

  test("named awkward probes stay named singles (tilbehoer), not generated clones", () => {
    const awkward = awkwardRealProducts();
    const tilb = awkward.find((p) => p.item === `${SENTINEL}P-TILB`);
    assert.ok(tilb);
    assert.equal(tilb.seo, "tilbehoer");
    const gen = generatedProducts({ prefix: `${SENTINEL}P-GEN-`, count: 8, categoryKeys: ["tilbehoer"] });
    assert.equal(gen.some((p) => p.seo === "tilbehoer"), false);
  });

  test("display titles use æøå; ItemNumber and SeoLink stay ASCII", () => {
    const gen = generatedProducts({
      prefix: `${SENTINEL}P-GEN-`,
      count: LADDER_COUNTS.realGenProducts,
      categoryKeys: ["bolig", "tekstiler"],
    });
    const awkward = awkwardRealProducts();
    assert.ok(gen.some((p) => /[æøå]/i.test(p.title)), "generated titles carry Danish letters");
    assert.ok(awkward.some((p) => /[æøå]/i.test(p.title)));
    for (const p of [...gen, ...awkward]) {
      assert.match(p.item, /^[\x00-\x7F]+$/, `SKU ${p.item}`);
      assert.match(p.seo, /^[\x00-\x7F]+$/, `SeoLink ${p.seo}`);
      assert.equal(/[æøå]/i.test(p.seo), false, `SeoLink must not carry æøå: ${p.seo}`);
      assert.equal(/&(?:aelig|oslash|aring);/i.test(p.title), false);
    }
    const tilbeh = BROHAVE_CATEGORIES.find((c) => c.key === "tilbehoer");
    const asciiDup = BROHAVE_CATEGORIES.find((c) => c.key === "tilbehoer-2");
    assert.equal(tilbeh.title, "Tilbehør");
    assert.equal(asciiDup.title, "Tilbehoer");
  });
});
