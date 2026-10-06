/**
 * test/xml.test.mjs — acceptance tests for src/dandomain/xml.js.
 *
 * The three "collapse" suites are not invented cases. Each one BUILDS the XML that the recorded
 * failure implies, PROVES the reconstruction is faithful by running the original naive walker
 * (copied verbatim from scripts/probe-dandomain.mjs:119) over it and deep-equalling the output
 * against the recording in data/probes/, and only then asserts what the real parser must return.
 * If a future edit "simplifies" a rule away, the naive-walker assertion still passes and the
 * parser assertion fails — you will see exactly which recorded defect you re-introduced.
 *
 * Run: node --test test/xml.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSoapResponse, parseXml, parseElements, readFault, asRecords, unescapeXml,
  decodeResponseBytes, decodeWindows1252Table, MOJIBAKE_RE, MOJIBAKE_BRIEF_RE, SOURCE_SNIPPET_LIMIT,
  XmlParseError, SoapFaultError, EncodingError,
} from "../src/dandomain/xml.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = (name) => JSON.parse(readFileSync(path.join(ROOT, "data", "probes", `${name}.json`), "utf8"));
const GAPS = probe("gaps");
const SCALE = probe("scale");

/** assert.throws() does not hand back the error; this does. */
function catches(fn, type) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, "expected a throw, got none");
  if (type) assert.ok(caught instanceof type, `expected ${type.name}, got ${caught.name}: ${caught.message}`);
  return caught;
}

// ---------------------------------------------------------------------------
// The parser that produced the recordings. VERBATIM from scripts/probe-dandomain.mjs:119-127
// plus the response-unwrapping from lines 110-116. Do not "fix" it: it is the control.
// ---------------------------------------------------------------------------
function naiveParseXml(x) {
  x = x.trim(); const out = {}; let any = false;
  const re = /<(?:\w+:)?([\w.]+)(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?\1>|<(?:\w+:)?([\w.]+)(?:\s[^>]*)?\/>/g;
  let m; while ((m = re.exec(x))) {
    any = true; const k = m[1] ?? m[3]; const v = m[3] !== undefined ? null : naiveParseXml(m[2]);
    if (k in out) { out[k] = Array.isArray(out[k]) ? out[k] : [out[k]]; out[k].push(v); } else out[k] = v;
  }
  if (!any) return x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"');
  if ("item" in out && Object.keys(out).length === 1) return Array.isArray(out.item) ? out.item : [out.item];
  return out;
}
function naiveParseResponse(text, op) {
  const inner = text.match(new RegExp(`<(?:\\w+:)?${op}Response[^>]*>([\\s\\S]*?)</(?:\\w+:)?${op}Response>`));
  let parsed = inner ? naiveParseXml(inner[1]) : text;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const k = Object.keys(parsed);
    if (k.length === 1 && k[0] === `${op}Result`) parsed = parsed[k[0]];
  }
  return parsed;
}
/** the probe's own list-normaliser (scripts/probe-dandomain.mjs:1564) */
const naiveArr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
/** the probe's raw markers (scripts/probe-dandomain.mjs:2031) */
const countItems = (xml) => (String(xml).match(/<item>/g) || []).length;
const countTag = (xml, t) => (String(xml).match(new RegExp(`<${t}[\\s>/]`, "g")) || []).length;

// ---------------------------------------------------------------------------
// fixture builders — the wire format is single-line, prefixed SOAP 1.2, exactly as
// scripts/probe-dandomain.mock.mjs and the live shop emit it.
// ---------------------------------------------------------------------------
const envelope = (op, inner) =>
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
  "<env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\"><env:Body>" +
  `<ns1:${op}Response xmlns:ns1="https://api.hostedshop.io/service.php">` +
  `<ns1:${op}Result>${inner}</ns1:${op}Result></ns1:${op}Response>` +
  "</env:Body></env:Envelope>";

const stockLocation = (v, id) =>
  `<item><StockLocationId>${id}</StockLocationId><DeliveryTimeId>-2</DeliveryTimeId>` +
  `<Stock>${v.Stock}</Stock><BuyPrice>${v.BuyingPrice}</BuyPrice></item>`;

/**
 * One ProductVariant record in service.wsdl declaration order, carrying only the fields the
 * recording proves came back (DeliveryTime/Description/DescriptionLong were omitted per record —
 * R3/R26). Two details are forced by the recording and are not free choices:
 *   - PictureIds is SELF-CLOSING: the recorded value is null, and the naive walker only produces
 *     null from its self-closing alternative (`<X></X>` would have produced "").
 *   - VariantTypeValues (ArrayOfInt, the field between Sorting and MinAmount) holds a SCALAR
 *     item. Any element children inside that nested <item> would have leaked into the truncated
 *     record — the recording shows Id/Title etc. clean, so the nested item had no elements.
 */
const variantRecord = (v) =>
  "<item>" +
  `<Id>${v.Id}</Id><ProductId>${v.ProductId}</ProductId><Stock>${v.Stock}</Stock><StockLow>0</StockLow>` +
  `<Price>199</Price><BuyingPrice>${v.BuyingPrice}</BuyingPrice><ItemNumber></ItemNumber>` +
  "<ItemNumberSupplier></ItemNumberSupplier><Weight>0</Weight><DeliveryTimeId>-1</DeliveryTimeId>" +
  "<Status>true</Status><DisableOnEmpty>true</DisableOnEmpty><Discount>49</Discount>" +
  "<DiscountType>a</DiscountType><Ean></Ean><PictureId>0</PictureId><PictureIds/>" +
  `<Sorting>${v.Sorting}</Sorting>` +
  `<VariantTypeValues><item>${v.VariantTypeValueId}</item></VariantTypeValues>` +
  "<MinAmount>1</MinAmount>" +
  `<Title>${v.Title}</Title>` +
  "<Unit><Id>1</Id><LanguageISO>DK</LanguageISO><Title>stk.</Title></Unit>" +
  `<StockLocations>${(v.stockLocationIds ?? [1]).map((id) => stockLocation(v, id)).join("")}</StockLocations>` +
  "</item>";

const TITLES = ["Small", "Medium", "Large"];
const variantsResponse = (productId, ids, sortingBase, stock, buyingPrice, stockLocationIdsPerVariant = null) =>
  envelope("Product_GetVariants", ids.map((Id, i) => variantRecord({
    Id, ProductId: productId, Stock: stock, BuyingPrice: buyingPrice, Sorting: sortingBase + i,
    Title: TITLES[i], VariantTypeValueId: 10 + i,
    stockLocationIds: stockLocationIdsPerVariant ? stockLocationIdsPerVariant[i] : [1],
  })).join(""));

// ---------------------------------------------------------------------------
describe("R6/R18/R26 — gaps.json sections.variants: the hoisting collapse", () => {
  const P1 = variantsResponse(1, [4, 5, 28], 0, 10, 79);
  const P2 = variantsResponse(2, [6, 7, 8], 1, 5, 299);

  test("the fixture reproduces the RECORDED failure exactly (control)", () => {
    // If this fails, the fixture no longer models the real payload and every assertion below
    // is worthless. gaps.json sections.variants.sample is the recording, byte-shape and all:
    // records truncated at Sorting, Title hoisted to ["Small","Medium","Large"], and
    // StockLocations mixed [{…},[{…}],[{…}]].
    assert.deepStrictEqual(
      [naiveParseResponse(P1, "Product_GetVariants"), naiveParseResponse(P2, "Product_GetVariants")],
      GAPS.sections.variants.sample,
    );
    assert.deepStrictEqual(
      Object.keys(naiveParseResponse(P1, "Product_GetVariants")),
      GAPS.sections.variants.audit.returned, // ["item","MinAmount","Title","Unit","StockLocations"]
    );
    // and the recorded per-product count of 1 for a 3-variant product
    assert.equal(naiveArr(naiveParseResponse(P1, "Product_GetVariants")).length, 1);
    assert.equal(GAPS.sections.variants.perProduct[0].count, 1);
  });

  test("N sibling <item> records stay N records", () => {
    const { result } = parseSoapResponse(P1, "Product_GetVariants");
    assert.ok(Array.isArray(result), "a 3-variant response must parse as an array, not an object");
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result.map((v) => v.Id), ["4", "5", "28"]);
    assert.equal(asRecords(parseSoapResponse(P2, "Product_GetVariants").result).length, 3);
  });

  test("no field is hoisted out of its record", () => {
    const { result } = parseSoapResponse(P1, "Product_GetVariants");
    assert.deepStrictEqual(result.map((v) => v.Title), ["Small", "Medium", "Large"]);
    assert.deepStrictEqual(result.map((v) => v.MinAmount), ["1", "1", "1"]);
    for (const v of result) {
      assert.deepStrictEqual(v.Unit, { Id: "1", LanguageISO: "DK", Title: "stk." });
      assert.equal(typeof v.Title, "string", "Title is a scalar field, never a parallel array");
    }
    // every requested-and-returned field is INSIDE the record, not beside it
    assert.deepStrictEqual(Object.keys(result[0]), [
      "Id", "ProductId", "Stock", "StockLow", "Price", "BuyingPrice", "ItemNumber",
      "ItemNumberSupplier", "Weight", "DeliveryTimeId", "Status", "DisableOnEmpty", "Discount",
      "DiscountType", "Ean", "PictureId", "PictureIds", "Sorting", "VariantTypeValues",
      "MinAmount", "Title", "Unit", "StockLocations",
    ]);
  });

  test("one nested <item> is still an array, and the shape never varies between records", () => {
    const { result } = parseSoapResponse(P1, "Product_GetVariants");
    for (const v of result) {
      assert.ok(Array.isArray(v.StockLocations), "ArrayOfProductVariantStockLocation is a list even with one row");
      assert.equal(v.StockLocations.length, 1);
      assert.deepStrictEqual(v.StockLocations[0], { StockLocationId: "1", DeliveryTimeId: "-2", Stock: "10", BuyPrice: "79" });
      assert.ok(Array.isArray(v.VariantTypeValues), "ArrayOfInt is a list even with one item");
    }
    assert.deepStrictEqual(result.map((v) => v.VariantTypeValues), [["10"], ["11"], ["12"]]);
  });

  test("BRIEF GATE: 3 records, one with a 1-element nested array and one with a 3-element one", () => {
    const mixed = variantsResponse(1, [4, 5, 28], 0, 10, 79, [[1], [1, 2, 3], [7]]);
    const { result } = parseSoapResponse(mixed, "Product_GetVariants");
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result.map((v) => v.StockLocations.length), [1, 3, 1],
      "a sibling record having three rows must not change this record's cardinality");
    assert.deepStrictEqual(result[1].StockLocations.map((s) => s.StockLocationId), ["1", "2", "3"]);
    assert.deepStrictEqual(result[2].StockLocations, [{ StockLocationId: "7", DeliveryTimeId: "-2", Stock: "10", BuyPrice: "79" }]);
    // and every record is still whole
    assert.deepStrictEqual(result.map((v) => v.Title), ["Small", "Medium", "Large"]);
    assert.deepStrictEqual(result.map((v) => v.Id), ["4", "5", "28"]);
  });

  test("empty forms stay distinct: <X/> is null, <X></X> is \"\"", () => {
    const [v] = parseSoapResponse(P1, "Product_GetVariants").result;
    assert.equal(v.PictureIds, null, "<PictureIds/> — the recorded value is null");
    assert.equal(v.ItemNumber, "", "<ItemNumber></ItemNumber> — an empty string is a value");
    assert.equal(v.Ean, "");
    // ...and the WSDL says PictureIds is ArrayOfInt, so a caller that knows the schema can ask
    const hinted = parseSoapResponse(P1, "Product_GetVariants", { arrayElements: ["PictureIds"] });
    assert.deepStrictEqual(hinted.result[0].PictureIds, []);
  });
});

// ---------------------------------------------------------------------------
describe("R6 — gaps.json sections.pages: returned == [\"item\",\"LanguageAccess\"]", () => {
  const pagePicture = (id) =>
    `<item><Id>${id}</Id><LanguageISO>DK</LanguageISO><Name>billede-${id}.jpg</Name>` +
    `<Thumbnail>thumb-${id}.jpg</Thumbnail><Sorting>${id}</Sorting><LanguageAccess/></item>`;
  const pageRecord = (p) =>
    "<item>" +
    `<Id>${p.Id}</Id><CategoryId>0</CategoryId><Sorting>${p.Id}</Sorting><ParentId>0</ParentId>` +
    "<ShowInMenu>true</ShowInMenu><Target></Target><UpdatedDate>2026-08-15 09:00:00</UpdatedDate>" +
    `<LanguageISO>DK</LanguageISO><Title>${p.Title}</Title><Headline>${p.Title}</Headline>` +
    `<Link>/${p.Id}-${p.Slug}</Link><Text>&lt;p&gt;Tekst for ${p.Title}&lt;/p&gt;</Text>` +
    "<Text2></Text2><Text3></Text3><Visible>1</Visible><SeoKeywords></SeoKeywords>" +
    "<SeoDescription></SeoDescription><SeoTitle></SeoTitle>" +
    (p.pictures ? `<Pictures>${p.pictures.map(pagePicture).join("")}</Pictures>` : "<Pictures/>") +
    "<LanguageAccess/>" +
    "</item>";

  // gaps.json byFolder[3] recorded these four titles; the byIds call over the same shop collapsed
  // to ONE object. The difference is data-dependent: ONE page with a picture is enough, because
  // its nested </item> truncates that record and hoists everything after Pictures.
  const TITLES = GAPS.sections.pages.byFolder[3].titles; // ["Om os","Kontakt","Handelsbetingelser","Cookies"]
  const PAGES = envelope("PageText_GetByIds", TITLES.map((Title, i) => pageRecord({
    Id: i + 1, Title, Slug: `side-${i + 1}`, pictures: i === 1 ? [11, 12] : null,
  })).join(""));

  test("the fixture reproduces the RECORDED failure exactly (control)", () => {
    const collapsed = naiveParseResponse(PAGES, "PageText_GetByIds");
    assert.deepStrictEqual(Object.keys(collapsed), GAPS.sections.pages.audit.returned);
    assert.equal(naiveArr(collapsed).length, GAPS.sections.pages.byIdsCount, "recorded byIdsCount == 1");
    assert.deepStrictEqual(
      naiveArr(collapsed).map((p) => p?.Title).filter(Boolean),
      GAPS.sections.pages.byIdsTitles, // [] — every Title was hoisted out of every record
    );
  });

  test("four pages parse as four records with their own titles", () => {
    const { result } = parseSoapResponse(PAGES, "PageText_GetByIds");
    assert.equal(result.length, 4);
    assert.deepStrictEqual(result.map((p) => p.Title), TITLES);
    assert.deepStrictEqual(result.map((p) => p.Id), ["1", "2", "3", "4"]);
    for (const p of result) assert.ok("LanguageAccess" in p, "LanguageAccess belongs to the record");
  });

  test("the one page with pictures keeps two, the others keep none", () => {
    const { result } = parseSoapResponse(PAGES, "PageText_GetByIds", { arrayElements: ["Pictures", "LanguageAccess"] });
    assert.deepStrictEqual(result.map((p) => p.Pictures.length), [0, 2, 0, 0]);
    assert.equal(result[1].Pictures[0].Name, "billede-11.jpg");
    assert.deepStrictEqual(result.map((p) => p.LanguageAccess), [[], [], [], []]);
    // without the schema hint an empty <Pictures/> is null, not [] — documented, not guessed
    const plain = parseSoapResponse(PAGES, "PageText_GetByIds").result;
    assert.equal(plain[0].Pictures, null);
    assert.equal(plain[1].Pictures.length, 2);
  });

  test("escaped HTML in Text survives and is unescaped once", () => {
    const { result } = parseSoapResponse(PAGES, "PageText_GetByIds");
    assert.equal(result[0].Text, "<p>Tekst for Om os</p>");
  });
});

// ---------------------------------------------------------------------------
describe("R18 — scale.json pages[].parsedLength == 1 for a 618-product response", () => {
  const RECORDED = SCALE.pages.find((p) => p.pageSize === 1000); // the page that returned all 618
  const CATALOGUE = SCALE.catalogueSize; // 618
  const WITH_SEOLINK = RECORDED.productMarkers.SeoLink; // 8 of 618 (R26)

  const productPicture = (pid, i) =>
    `<item><Id>${pid}${i}</Id><FileName>p${pid}-${i}.jpg</FileName><Sorting>${i}</Sorting></item>`;
  const productRecord = (id) => {
    const seo = id <= WITH_SEOLINK; // exactly 8 records carry SeoLink — a per-record omission
    return "<item>" +
      `<Id>${id}</Id><Online>true</Online><Stock>5</Stock><ItemNumber>SCALE-${id}</ItemNumber>` +
      "<Price>199</Price><DateCreated>2026-08-15 09:00:00</DateCreated>" +
      `<Title>Skaleringsprodukt ${id}</Title>` +
      (seo ? `<SeoLink>skalering-${id}</SeoLink>` : "") +
      "<Variants/><Tags/>" +
      (seo ? `<Pictures>${[1, 2, 3].map((i) => productPicture(id, i)).join("")}</Pictures>` : "<Pictures/>") +
      "<CustomData/><Discounts/>" +
      "<SecondaryCategories><item><Id>9</Id><Title>Probe Kategori</Title></item></SecondaryCategories>" +
      "<StockLocations/><VariantTypes></VariantTypes><VatGroupId>1</VatGroupId><Status>true</Status>" +
      "</item>";
  };
  const PAGE = envelope("Product_GetAllWithLimit",
    Array.from({ length: CATALOGUE }, (_, i) => productRecord(i + 1)).join(""));

  test("the fixture reproduces the RECORDED markers and the RECORDED parsedLength (control)", () => {
    assert.equal(countTag(PAGE, "VatGroupId"), RECORDED.productMarkers.VatGroupId); // 618
    assert.equal(countTag(PAGE, "Online"), RECORDED.productMarkers.Online); // 618
    assert.equal(countTag(PAGE, "SeoLink"), RECORDED.productMarkers.SeoLink); // 8
    assert.equal(countItems(PAGE), RECORDED.itemTagsIncludingNested); // 1260 = 618 + 618 + 8*3
    const collapsed = naiveParseResponse(PAGE, "Product_GetAllWithLimit");
    const parsedLength = Array.isArray(collapsed) ? collapsed.length : 1;
    assert.equal(parsedLength, RECORDED.parsedLength, "recorded: a 618-product page parsed as ONE record");
    assert.equal(RECORDED.parserAgreesWithRaw, false);
  });

  test("618 products parse as 618 records", () => {
    const t0 = Date.now();
    const { result } = parseSoapResponse(PAGE, "Product_GetAllWithLimit", { resultIsArray: true });
    const ms = Date.now() - t0;
    assert.equal(result.length, CATALOGUE);
    assert.equal(result.length, countTag(PAGE, "VatGroupId"), "parser must agree with the raw markers");
    assert.deepStrictEqual(result.slice(0, 3).map((p) => p.Id), ["1", "2", "3"]);
    assert.equal(result[CATALOGUE - 1].Title, `Skaleringsprodukt ${CATALOGUE}`);
    assert.ok(ms < 5000, `parse took ${ms}ms`);
  });

  test("R26: a field present on SOME records stays absent on the others", () => {
    const { result } = parseSoapResponse(PAGE, "Product_GetAllWithLimit", { resultIsArray: true });
    const withSeo = result.filter((p) => "SeoLink" in p);
    assert.equal(withSeo.length, WITH_SEOLINK, "8 of 618 — the batch-wide scan must still be possible");
    assert.equal(withSeo[0].SeoLink, "skalering-1");
    assert.ok(!("SeoLink" in result[100]), "no field may be fabricated onto a record that omitted it");
    // the nested inline (R5) survives per record
    assert.equal(result[0].Pictures.length, 3);
    assert.equal(result[100].Pictures, null);
    assert.deepStrictEqual(result[100].SecondaryCategories, [{ Id: "9", Title: "Probe Kategori" }]);
  });
});

// ---------------------------------------------------------------------------
describe("cardinality is decided per element, never from siblings or from stored shape", () => {
  test("a sibling record with two children does not make this record's field an array", () => {
    const xml = "<item><Id>1</Id><Tag>a</Tag></item><item><Id>2</Id><Tag>a</Tag><Tag>b</Tag></item>";
    const rows = parseXml(xml);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].Tag, "a");
    assert.deepStrictEqual(rows[1].Tag, ["a", "b"]);
  });

  test("a field whose VALUE is an array is never mistaken for an accumulator", () => {
    // this is the exact mechanism behind the recorded [{…},[{…}],[{…}]]
    const xml = "<r><L><item>x</item></L><M><item>y</item><item>z</item></M></r>";
    assert.deepStrictEqual(parseXml(xml), { r: { L: ["x"], M: ["y", "z"] } });
  });

  test("repeated wrapper elements each keep their own array", () => {
    const xml = "<r><L><item>x</item></L><L><item>y</item><item>z</item></L></r>";
    const got = parseXml(xml);
    assert.deepStrictEqual(got, { r: { L: [["x"], ["y", "z"]] } });
    // the recorded defect, spelled out: the first occurrence must NOT be unwrapped into the
    // accumulator just because its value happened to be an array (gaps.json StockLocations)
    assert.notDeepStrictEqual(got.r.L, ["x", ["y", "z"]]);
    assert.ok(got.r.L.every(Array.isArray), "every occurrence keeps the same shape");
  });

  test("a record carrying the same array field twice keeps both lists whole", () => {
    const xml = "<item><Id>1</Id><L><item>a</item></L><L><item>b</item><item>c</item></L></item>";
    assert.deepStrictEqual(parseXml(xml), [{ Id: "1", L: [["a"], ["b", "c"]] }]);
  });

  test("three records with array-valued fields keep one shape each", () => {
    const rec = (id, xs) => `<item><Id>${id}</Id><L>${xs.map((x) => `<item>${x}</item>`).join("")}</L></item>`;
    const rows = parseXml(rec(1, ["a"]) + rec(2, ["b", "c"]) + rec(3, ["d"]));
    assert.deepStrictEqual(rows.map((r) => r.L), [["a"], ["b", "c"], ["d"]]);
    assert.ok(rows.every((r) => Array.isArray(r.L) && r.L.every((v) => typeof v === "string")),
      "no record may come back with a different shape than its siblings");
  });

  test("a record field literally named item is not confused with an array wrapper", () => {
    // mixed children => object; the item key still carries every occurrence
    assert.deepStrictEqual(parseXml("<r><item>1</item><Other>2</Other></r>"), { r: { item: "1", Other: "2" } });
  });

  test("arrayElements accepts bare names and path suffixes", () => {
    const xml = "<Product><Pictures/><Variants><item><Pictures/></item></Variants></Product>";
    assert.deepStrictEqual(parseXml(xml, { arrayElements: ["Variants/item/Pictures"] }),
      { Product: { Pictures: null, Variants: [{ Pictures: [] }] } });
    assert.deepStrictEqual(parseXml(xml, { arrayElements: ["Pictures"] }),
      { Product: { Pictures: [], Variants: [{ Pictures: [] }] } });
  });

  test("an empty nested array in the middle record does not shift the others", () => {
    const xml = "<item><Id>1</Id><L><item>a</item></L></item>" +
      "<item><Id>2</Id><L/></item>" +
      "<item><Id>3</Id><L><item>b</item><item>c</item><item>d</item></L></item>";
    const rows = parseXml(xml, { arrayElements: ["L"] });
    assert.deepStrictEqual(rows.map((r) => r.Id), ["1", "2", "3"]);
    assert.deepStrictEqual(rows.map((r) => r.L), [["a"], [], ["b", "c", "d"]]);
  });

  test("an empty <item/> inside a wrapper is one empty row, not zero rows", () => {
    assert.deepStrictEqual(parseXml("<Pictures><item/></Pictures>"), { Pictures: [null] });
  });

  test("asRecords replaces the probe's arr() without hiding a collapse", () => {
    assert.deepStrictEqual(asRecords(null), []);
    assert.deepStrictEqual(asRecords(undefined), []);
    assert.deepStrictEqual(asRecords([1, 2]), [1, 2]);
    assert.deepStrictEqual(asRecords({ Id: "1" }), [{ Id: "1" }]);
  });
});

// ---------------------------------------------------------------------------
describe("XML mechanics", () => {
  test("nested elements of the same name keep their boundaries", () => {
    const xml = "<item><Id>1</Id><Kids><item><Id>a</Id></item><item><Id>b</Id></item></Kids></item>" +
      "<item><Id>2</Id><Kids><item><Id>c</Id></item></Kids></item>";
    assert.deepStrictEqual(parseXml(xml), [
      { Id: "1", Kids: [{ Id: "a" }, { Id: "b" }] },
      { Id: "2", Kids: [{ Id: "c" }] },
    ]);
    // the control: this is precisely what the backreference walker cannot do
    assert.notDeepStrictEqual(naiveParseXml(xml), parseXml(xml));
  });

  test("namespaced and default-namespace tags resolve to the same local names", () => {
    assert.deepStrictEqual(parseXml("<ns1:item xmlns:ns1=\"urn:x\"><ns1:Id>1</ns1:Id></ns1:item>"), [{ Id: "1" }]);
    assert.deepStrictEqual(parseXml("<item xmlns=\"urn:x\"><Id>1</Id></item>"), [{ Id: "1" }]);
  });

  test("self-closing, whitespace and empty elements", () => {
    assert.deepStrictEqual(parseXml("<a><b/><c></c><d>  </d></a>"), { a: { b: null, c: "", d: "  " } });
    assert.deepStrictEqual(parseXml("<a>\n  <b>1</b>\n</a>"), { a: { b: "1" } }, "whitespace between elements is not data");
    assert.deepStrictEqual(parseXml("<a> <b>1</b> </a>", { trimText: true }), { a: { b: "1" } });
  });

  test("xsi:nil is null; attributes are otherwise ignored, including '>' inside a value", () => {
    assert.equal(parseXml("<a xsi:nil=\"true\"></a>").a, null);
    assert.equal(parseXml("<a nil='1'/>").a, null);
    assert.equal(parseXml("<a xsi:nil=\"false\">v</a>").a, "v");
    assert.equal(parseXml("<a title='nil=\"true\"'>v</a>").a, "v", "nil inside an attribute VALUE is not xsi:nil");
    assert.deepStrictEqual(parseXml("<a title=\"x &gt; y\" alt='a>b'>v</a>"), { a: "v" });
  });

  test("XML entities are decoded; HTML named entities are left alone (gaps.json htmlEntities)", () => {
    assert.equal(parseXml("<a>&lt;p&gt;R&amp;D&lt;/p&gt;</a>").a, "<p>R&D</p>");
    assert.equal(parseXml("<a>&quot;q&quot; &apos;a&apos;</a>").a, "\"q\" 'a'");
    assert.equal(parseXml("<a>&#65;&#x42;&#229;</a>").a, "ABå");
    assert.equal(parseXml("<a>&amp;oslash;</a>").a, "&oslash;",
      "a global HTML decode would corrupt a field that legitimately contains an ampersand sequence");
    assert.equal(parseXml("<a>&oslash;</a>").a, "&oslash;", "not our layer: per-field decode is the caller's call");
    assert.equal(parseXml("<a>&unknown; &amp</a>").a, "&unknown; &amp", "unknown/unterminated entities pass through");
    assert.equal(unescapeXml("&constructor;"), "&constructor;", "no prototype leakage");
  });

  test("CDATA is verbatim and cannot break a record boundary", () => {
    const xml = "<item><Id>1</Id><Text><![CDATA[<p>a &amp; b</p></item>]]></Text></item><item><Id>2</Id></item>";
    const rows = parseXml(xml);
    assert.equal(rows.length, 2, "a </item> inside CDATA is text, not a close tag");
    assert.equal(rows[0].Text, "<p>a &amp; b</p></item>", "CDATA is not entity-decoded — that would corrupt escaped HTML");
    assert.equal(rows[1].Id, "2");
    assert.equal(parseXml("<a>x<![CDATA[&y]]>&amp;z</a>").a, "x&y&z", "only the non-CDATA run is decoded");
  });

  test("comments, processing instructions and DOCTYPE are skipped", () => {
    assert.deepStrictEqual(parseXml("<?xml version=\"1.0\"?><!-- <item>x</item> --><a>1</a>"), { a: "1" });
    assert.deepStrictEqual(parseXml("<!DOCTYPE a [ <!ENTITY x \"y\"> ]><a>1</a>"), { a: "1" });
  });

  test("mixed content is preserved rather than dropped", () => {
    assert.deepStrictEqual(parseXml("<a>text<b>1</b></a>"), { a: { b: "1", "#text": "text" } });
  });

  test("malformed XML throws instead of returning a wrong shape", () => {
    assert.match(catches(() => parseXml("<a><b></a>"), XmlParseError).message,
      /mismatched closing tag <\/a>, expected <\/b>/);
    assert.match(catches(() => parseXml("<a><b>1</b>"), XmlParseError).message, /unclosed element <a>/);
    assert.match(catches(() => parseXml("</a>"), XmlParseError).message, /unexpected closing tag/);
    assert.match(catches(() => parseXml("<a>1</a><b"), XmlParseError).message, /unterminated tag <b>/);
    assert.match(catches(() => parseXml("<a><![CDATA[x</a>"), XmlParseError).message, /unterminated CDATA/);
    assert.match(catches(() => parseXml("<a><!-- x</a>"), XmlParseError).message, /unterminated comment/);
    // a mis-nesting that the stack would otherwise "absorb" silently
    assert.match(catches(() => parseXml("<r><a><b></a></b></r>"), XmlParseError).message,
      /mismatched closing tag <\/a>, expected <\/b>/);
  });

  test("parseElements exposes the tree without collapsing it", () => {
    const doc = parseElements("<a><b/></a>");
    assert.equal(doc.children.length, 1);
    assert.equal(doc.children[0].name, "a");
    assert.equal(doc.children[0].children[0].selfClosing, true);
  });

  test("a field named __proto__ becomes a field, not a prototype", () => {
    const got = parseXml("<r><__proto__>x</__proto__><Id>1</Id></r>").r;
    assert.equal(Object.getPrototypeOf(got), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(got, "__proto__"), true);
    assert.equal(got.Id, "1");
  });

  test("text-only and empty fragments", () => {
    assert.equal(parseXml("plain &amp; text"), "plain & text");
    assert.equal(parseXml(""), "");
  });
});

// ---------------------------------------------------------------------------
describe("SOAP envelope handling", () => {
  test("doc/literal <OpResponse><OpResult> is unwrapped", () => {
    const r = parseSoapResponse(envelope("Product_SetFields", "1"), "Product_SetFields");
    assert.equal(r.result, "1");
    assert.equal(r.resultElement, "Product_SetFieldsResult");
    assert.equal(r.op, "Product_SetFields");
  });

  test("a single-record object result stays an object", () => {
    const xml = envelope("Order_GetById",
      "<Id>5001</Id><ReferenceNumber>SRC-2019-0042</ReferenceNumber><Status>1</Status><Total>199</Total>");
    assert.deepStrictEqual(parseSoapResponse(xml, "Order_GetById").result,
      { Id: "5001", ReferenceNumber: "SRC-2019-0042", Status: "1", Total: "199" });
  });

  test("an empty result is null, or [] when the caller knows the WSDL says ArrayOf*", () => {
    const empty = "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\">" +
      "<env:Body><ns1:Customer_GetAllResponse xmlns:ns1=\"urn:x\"><ns1:Customer_GetAllResult/>" +
      "</ns1:Customer_GetAllResponse></env:Body></env:Envelope>";
    assert.equal(parseSoapResponse(empty, "Customer_GetAll").result, null);
    assert.deepStrictEqual(parseSoapResponse(empty, "Customer_GetAll", { resultIsArray: true }).result, []);
    assert.deepStrictEqual(asRecords(parseSoapResponse(empty, "Customer_GetAll").result), []);
  });

  test("a one-record list is still a list", () => {
    const one = envelope("Solution_GetLanguages", "<item><Id>1</Id><Iso>DK</Iso></item>");
    assert.deepStrictEqual(parseSoapResponse(one, "Solution_GetLanguages").result, [{ Id: "1", Iso: "DK" }]);
  });

  test("the SOAP 1.2 envelope may use any prefix, or none", () => {
    const bare = "<Envelope xmlns=\"http://www.w3.org/2003/05/soap-envelope\"><Body>" +
      "<Solution_GetWebinfoResponse><Solution_GetWebinfoResult><ShopName>Mock demo shop000000</ShopName>" +
      "</Solution_GetWebinfoResult></Solution_GetWebinfoResponse></Body></Envelope>";
    assert.deepStrictEqual(parseSoapResponse(bare, "Solution_GetWebinfo").result, { ShopName: "Mock demo shop000000" });
  });

  test("a response for the wrong operation throws instead of returning garbage", () => {
    const xml = envelope("Product_GetAllWithLimit", "<item><Id>1</Id></item>");
    assert.throws(() => parseSoapResponse(xml, "Order_GetById"), XmlParseError);
    assert.throws(() => parseSoapResponse("<Envelope><Body></Body></Envelope>", "X"), XmlParseError);
  });

  test("a bare fragment (no Envelope) is accepted for reuse on GraphQL/WSDL-free payloads", () => {
    assert.deepStrictEqual(parseSoapResponse("<XResponse><XResult><A>1</A></XResult></XResponse>", "X").result, { A: "1" });
  });

  test("a proxy/HTML error page fails loudly instead of parsing as a record", () => {
    const err = catches(() => parseSoapResponse("<html><body><h1>502 Bad Gateway</h1></body></html>", "Product_GetAllWithLimit"), XmlParseError);
    assert.match(err.message, /expected <Product_GetAllWithLimitResponse>/);
  });
});

// ---------------------------------------------------------------------------
describe("faults (F3, F16) — extracted, never classified here", () => {
  const faultEnvelope = (inner) =>
    "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\">" +
    `<env:Body><env:Fault>${inner}</env:Fault></env:Body></env:Envelope>`;
  const soap12 = (code, msg) => faultEnvelope(
    `<env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>${code}</env:Value></env:Subcode></env:Code>` +
    `<env:Reason><env:Text xml:lang="en">${msg}</env:Text></env:Reason>`);

  test("F3: the app code comes from Subcode/Value, not Code/Value", () => {
    const err = catches(() => parseSoapResponse(soap12("NOSUCHPARAM", "Unknown parameter"), "Product_SetFields"), SoapFaultError);
    assert.equal(err.code, "NOSUCHPARAM");
    assert.equal(err.faultCode, "Sender");
    assert.equal(err.reason, "Unknown parameter");
    assert.equal(err.message, "SoapFault NOSUCHPARAM: Unknown parameter");
  });

  test("F3: an undocumented code is passed through untouched for the client to treat as fatal", () => {
    const err = catches(() => parseSoapResponse(soap12("SOMETHING_NEW", "boom"), "X"), SoapFaultError);
    assert.equal(err.code, "SOMETHING_NEW");
  });

  test("without a Subcode the app code falls back to Code/Value", () => {
    const xml = faultEnvelope("<env:Code><env:Value>env:Receiver</env:Value></env:Code>" +
      "<env:Reason><env:Text>SoapFault Receiver: Too few arguments to function WebService::" +
      "Order_GetAllWithPagination(), 0 passed in /code/smartweb/latest/api/service.php on line 108 and exactly 2 expected</env:Text></env:Reason>");
    const err = catches(() => parseSoapResponse(xml, "Order_GetAllWithPagination"), SoapFaultError);
    assert.equal(err.code, "Receiver");
    // R17/R27: this exact string must survive so the client can classify it as a NAME error
    assert.equal(err.reason, GAPS.faults[0].message);
    assert.match(err.reason, /Too few arguments to function WebService::/);
  });

  test("F16: the lineErrors reason survives verbatim so the order id can be recovered", () => {
    const msg = "lineErrors: Order: 4 created. Following products were not included: 999";
    const err = catches(() => parseSoapResponse(soap12("ORDER", msg), "Order_Create"), SoapFaultError);
    assert.equal(err.reason, msg);
    assert.equal(err.reason.match(/Order:\s*(\d+)\s*created/)[1], "4");
  });

  test("SOAP 1.1 faultcode/faultstring is understood too", () => {
    const xml = "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body><soap:Fault>" +
      "<faultcode>soap:Server</faultcode><faultstring>AUTH</faultstring></soap:Fault></soap:Body></soap:Envelope>";
    const err = catches(() => parseSoapResponse(xml, "Solution_Connect"), SoapFaultError);
    assert.equal(err.code, "Server");
    assert.equal(err.reason, "AUTH");
  });

  test("readFault reports without throwing, and returns null for a normal response", () => {
    assert.equal(readFault(envelope("Product_SetFields", "1")), null);
    assert.equal(readFault(soap12("AUTH", "A valid authentication has not been performed with the service")).appCode, "AUTH");
  });
});

// ---------------------------------------------------------------------------
describe("encoding (F2)", () => {
  const bytes = (s, enc = "utf8") => new Uint8Array(Buffer.from(s, enc));
  const danish = envelope("OrderStatusCode_GetAll", "<item><Id>4</Id><Title>Genåbnet</Title></item>");

  test("bytes are decoded as UTF-8 explicitly, not by the declared charset", () => {
    const r = parseSoapResponse(bytes(danish), "OrderStatusCode_GetAll");
    assert.equal(r.decodedAs, "utf-8");
    assert.equal(r.mojibake, false);
    assert.equal(r.result[0].Title, "Genåbnet");
  });

  test("a double-encoded response THROWS by default — the brief says fail loudly (F2)", () => {
    // what Solution_SetEncoding("UTF-8") did to reads: "Genåbnet" -> "GenÃ¥bnet".
    // The DIRECTION of the default is the point: a boolean the not-yet-written client.js
    // forgets to read means corrupted titles migrated into Shopify with no error anywhere.
    const doubled = envelope("OrderStatusCode_GetAll", "<item><Title>GenÃ¥bnet</Title></item>");
    const err = catches(() => parseSoapResponse(bytes(doubled), "OrderStatusCode_GetAll"), EncodingError);
    assert.match(err.message, /Solution_SetEncoding/);
    assert.equal(err.mojibake, true);
    assert.match(err.sample, /GenÃ¥bnet/, "the error carries the offending text");
    // Opting OUT is what gives you the survey mode.
    const r = parseSoapResponse(bytes(doubled), "OrderStatusCode_GetAll", { failOnMojibake: false });
    assert.equal(r.mojibake, true, "the detector must match");
    assert.equal(r.decodedAs, "utf-8", "it is valid UTF-8 — that is exactly why only the detector catches it");
    assert.equal(r.result[0].Title, "GenÃ¥bnet");
    // ...and an explicit true still throws.
    catches(() => parseSoapResponse(bytes(doubled), "X", { failOnMojibake: true }), EncodingError);
    assert.equal(MOJIBAKE_RE.test("Genåbnet"), false);
    assert.equal(MOJIBAKE_RE.test("Æblegrød"), false, "correct Danish text must not trip the detector");
  });

  test("the detector is the PROBE's, not the brief's narrower quote (F2)", () => {
    // BRIEF.md quotes /Ã[\x80-\xBF]/. The probe that produced the live evidence ran
    // /Ã[\x80-\xBF]|Â[\x80-\xBF]/ (probe-dandomain.mjs:92). The dropped half is not
    // decorative: U+0080–U+00BF double-encodes to Â+char — nbsp (from &nbsp; in CMS HTML),
    // °, ©, », ±, ½ — all ordinary in Danish shop text, and PageText.Text is raw HTML.
    const probeSource = readFileSync(path.join(ROOT, "scripts", "probe-dandomain.mjs"), "utf8");
    assert.ok(
      probeSource.includes("/Ã[\\x80-\\xBF]|Â[\\x80-\\xBF]/.test(text)"),
      "the probe's detector moved — re-check which form this module should use",
    );
    assert.equal(String(MOJIBAKE_RE), String(/Ã[\x80-\xBF]|Â[\x80-\xBF]/));
    // Each of these is UTF-8 text that was itself encoded again: the source character is
    // U+00A0 / U+00B0 / U+00A9 / U+00BB, whose UTF-8 bytes C2 xx re-read as "Â" + xx.
    const doubleEncode = (s) => [...s].map((c) => {
      const cp = c.codePointAt(0);
      return cp < 0x80 ? c : [...Buffer.from(c, "utf8")].map((b) => String.fromCharCode(b)).join("");
    }).join("");
    assert.equal(doubleEncode("Genåbnet"), "GenÃ¥bnet", "the helper models the F2 double-encode");
    for (const src of ["Genåbnet", "Kontooverførsel", "20 kr", "12°C", "© 2026", "» videre"]) {
      assert.equal(MOJIBAKE_RE.test(doubleEncode(src)), true, `${JSON.stringify(src)} double-encoded must be caught`);
    }
    // The brief's exact rule stays exported, and stays a strict subset.
    assert.equal(String(MOJIBAKE_BRIEF_RE), String(/Ã[\x80-\xBF]/));
    assert.equal(MOJIBAKE_BRIEF_RE.test(doubleEncode("20 kr")), false, "this is the half the brief's form misses");
    assert.equal(MOJIBAKE_BRIEF_RE.test(doubleEncode("12°C")), false);
    assert.equal(MOJIBAKE_BRIEF_RE.test("GenÃ¥bnet"), true);
    for (const clean of ["Genåbnet", "Æblegrød", "Størrelse", "Grå ☃", "100 kr"]) {
      assert.equal(MOJIBAKE_RE.test(clean), false, `${clean} is clean text`);
    }
    // A double-encoded nbsp — the shape `&nbsp;` in PageText.Text HTML actually produces —
    // really does throw through the whole path.
    const page = envelope("PageText_GetAll", `<item><Text>${doubleEncode("Fri fragt over 500 kr")}</Text></item>`);
    const err = catches(() => parseSoapResponse(bytes(page), "PageText_GetAll"), EncodingError);
    assert.match(err.message, /double-encoded/);
    // ...and with the brief's narrow detector it would have been imported silently.
    assert.equal(MOJIBAKE_BRIEF_RE.test(page), false);
  });

  test("non-UTF-8 bytes fall back to windows-1252 and say so", () => {
    const r = decodeResponseBytes(bytes("Genåbnet", "latin1"));
    assert.equal(r.decodedAs, "windows-1252");
    assert.equal(r.text, "Genåbnet");
    assert.equal(decodeResponseBytes(bytes("Æblegrød")).decodedAs, "utf-8");
  });

  test("a UTF-8 BOM is stripped, not parsed", () => {
    const r = parseSoapResponse(bytes("﻿" + envelope("X", "<item><Id>1</Id></item>")), "X");
    assert.deepStrictEqual(r.result, [{ Id: "1" }]);
  });

  test("multi-byte text inside records survives the tokenizer", () => {
    const xml = envelope("Product_GetVariantTypeValuesByType",
      "<item><Title>Størrelse</Title></item><item><Title>Rød</Title></item><item><Title>Grå ☃</Title></item>");
    const { result } = parseSoapResponse(bytes(xml), "Product_GetVariantTypeValuesByType");
    assert.deepStrictEqual(result.map((v) => v.Title), ["Størrelse", "Rød", "Grå ☃"]);
  });
});

// ---------------------------------------------------------------------------
describe("no type coercion (R1, R18)", () => {
  test("numbers, booleans and ids stay strings", () => {
    const { result } = parseSoapResponse(envelope("X",
      "<item><Id>0042</Id><Price>199.00</Price><Online>true</Online><Stock>0</Stock></item>"), "X");
    assert.deepStrictEqual(result, [{ Id: "0042", Price: "199.00", Online: "true", Stock: "0" }]);
  });
});

// ---------------------------------------------------------------------------
// arrayElements hints — the wiring path a client actually takes (TYPE_DETAILS -> hints)
// ---------------------------------------------------------------------------
describe("arrayElements hints are scoped to EMPTY elements", () => {
  // A hint matches by bare name at EVERY depth. service.wsdl has three field names that are
  // ArrayOf* on one type and a scalar on another, and one collision fires inside a single
  // response: Product.LanguageAccess is ArrayOfString, ImageAltText.LanguageAccess is
  // xsd:string, and ImageAltText is reached through Product -> Pictures -> ImageAltTexts.
  const productResponse = envelope("Product_GetAllWithLimit",
    "<item><Id>1</Id><LanguageAccess><item>DK</item><item>SE</item></LanguageAccess>" +
    "<PictureIds/><Pictures><item><Id>9</Id><FileName>a.jpg</FileName>" +
    "<ImageAltTexts><item><Text>Cykel</Text><LanguageAccess>DK</LanguageAccess></item></ImageAltTexts>" +
    "</item></Pictures></item>");

  test("a hinted element that CARRIES TEXT keeps its scalar shape", () => {
    const hints = ["LanguageAccess", "PictureIds", "Pictures", "ImageAltTexts"];
    const { result } = parseSoapResponse(productResponse, "Product_GetAllWithLimit",
      { resultIsArray: true, arrayElements: hints });
    const product = result[0];
    // the real list is still a list...
    assert.deepStrictEqual(product.LanguageAccess, ["DK", "SE"]);
    // ...the empty ArrayOf* is still [] (the case the hint exists for)...
    assert.deepStrictEqual(product.PictureIds, []);
    // ...and the nested SCALAR of the same name is NOT wrapped.
    assert.strictEqual(product.Pictures[0].ImageAltTexts[0].LanguageAccess, "DK");
    assert.strictEqual(product.Pictures[0].ImageAltTexts[0].Text, "Cykel");
  });

  test("the same read without hints agrees on every field except the empty one", () => {
    const without = parseSoapResponse(productResponse, "Product_GetAllWithLimit", { resultIsArray: true }).result[0];
    const withHints = parseSoapResponse(productResponse, "Product_GetAllWithLimit",
      { resultIsArray: true, arrayElements: ["LanguageAccess", "PictureIds"] }).result[0];
    assert.strictEqual(without.Pictures[0].ImageAltTexts[0].LanguageAccess, "DK");
    assert.strictEqual(withHints.Pictures[0].ImageAltTexts[0].LanguageAccess, "DK",
      "hinting the parent's list must not reshape a same-named scalar three levels down");
    assert.strictEqual(without.PictureIds, null);
    assert.deepStrictEqual(withHints.PictureIds, []); // the one intended difference
  });

  test("a path hint still discriminates by position when a caller needs it", () => {
    const { result } = parseSoapResponse(productResponse, "Product_GetAllWithLimit",
      { resultIsArray: true, arrayElements: ["Product_GetAllWithLimitResult/item/PictureIds"] });
    assert.deepStrictEqual(result[0].PictureIds, []);
    assert.strictEqual(result[0].Pictures[0].ImageAltTexts[0].LanguageAccess, "DK");
  });

  test("the collisions this rule protects are real, per data/probes/service.wsdl", () => {
    // Derived from the WSDL text itself so the list cannot be a stale comment.
    const wsdl = readFileSync(path.join(ROOT, "data", "probes", "service.wsdl"), "utf8");
    for (const [field, arrayOwner, scalarOwner] of [
      ["LanguageAccess", "tns:ArrayOfString", "xsd:string"],
      ["ShowInMenu", "tns:ArrayOfInt", "xsd:boolean"],
      ["Access", "tns:ArrayOfString", "xsd:string"],
    ]) {
      assert.ok(wsdl.includes(`<xsd:element name="${field}" type="${arrayOwner}"`), `${field} array form`);
      assert.ok(wsdl.includes(`<xsd:element name="${field}" type="${scalarOwner}"`), `${field} scalar form`);
    }
  });
});

// ---------------------------------------------------------------------------
// empty results: the live server self-closes, the offline mock does not
// ---------------------------------------------------------------------------
describe("an empty result element means zero records in BOTH wire forms", () => {
  // gaps.json sections.discounts records count 0 with sample [], computed by the probe as
  // arr(all.result) with no filter — reachable only via null, i.e. <Discount_GetAllResult/>.
  // scripts/probe-dandomain.mock.mjs writes result(op, "") = <ns1:XResult></ns1:XResult>.
  const selfClosing = "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\">" +
    "<env:Body><ns1:Discount_GetAllResponse xmlns:ns1=\"mock\"><ns1:Discount_GetAllResult/>" +
    "</ns1:Discount_GetAllResponse></env:Body></env:Envelope>";
  const mockForm = envelope("Discount_GetAll", "");
  const whitespaceForm = envelope("Discount_GetAll", "\n  ");

  test("both forms parse to null and normalise to zero records", () => {
    assert.equal(GAPS.sections.discounts.count, 0, "the probe recorded an empty list here");
    assert.deepStrictEqual(GAPS.sections.discounts.sample, []);
    for (const [label, xml] of [["self-closing (live)", selfClosing], ["empty (mock)", mockForm], ["whitespace", whitespaceForm]]) {
      const r = parseSoapResponse(xml, "Discount_GetAll");
      assert.strictEqual(r.result, null, `${label}: result`);
      assert.deepStrictEqual(asRecords(r.result), [], `${label}: asRecords`);
      assert.deepStrictEqual(parseSoapResponse(xml, "Discount_GetAll", { resultIsArray: true }).result, [],
        `${label}: resultIsArray`);
    }
  });

  test("asRecords never invents a record out of an empty string", () => {
    assert.deepStrictEqual(asRecords(""), []);
    assert.deepStrictEqual(asRecords("\n  "), []);
    assert.deepStrictEqual(asRecords(null), []);
    // ...but a real scalar is still one record, and a real list is untouched.
    assert.deepStrictEqual(asRecords("101"), ["101"]);
    assert.deepStrictEqual(asRecords([{ Id: "1" }]), [{ Id: "1" }]);
  });

  test("the coercion is scoped to the RESULT wrapper — empty FIELDS still parse to \"\"", () => {
    // R26 needs <ItemNumber></ItemNumber> to stay "" (an empty value) and stay distinct from
    // an absent key (a truncated column). Only the unwrapped result element is coerced.
    const { result } = parseSoapResponse(
      envelope("Product_GetById", "<item><Id>1</Id><ItemNumber></ItemNumber><SeoLink/></item>"),
      "Product_GetById",
    );
    assert.deepStrictEqual(result, [{ Id: "1", ItemNumber: "", SeoLink: null }]);
  });
});

// ---------------------------------------------------------------------------
// the advertised-but-unpinned surface
// ---------------------------------------------------------------------------
describe("the documented surface is actually exercised", () => {
  const faultEnvelope = (inner) =>
    "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\">" +
    `<env:Body><env:Fault>${inner}</env:Fault></env:Body></env:Envelope>`;
  const soap12 = (code, msg) => faultEnvelope(
    `<env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>${code}</env:Value></env:Subcode></env:Code>` +
    `<env:Reason><env:Text xml:lang="en">${msg}</env:Text></env:Reason>`);

  test("readFault never throws, whatever it is handed", () => {
    // It is documented as "extract a SOAP fault WITHOUT throwing" — the whole reason a caller
    // reaches for it instead of parseSoapResponse.
    for (const bad of ["", "<Fault", "<a><Fault></a>", "not xml at all", "<Envelope><Body><Fault><Code>"]) {
      assert.doesNotThrow(() => readFault(bad), `readFault(${JSON.stringify(bad)}) threw`);
    }
    assert.equal(readFault("<Fault"), null);
    assert.equal(readFault("<a><Fault></a>"), null);
    assert.equal(readFault(new Uint8Array(Buffer.from(soap12("AUTH", "nope")))).appCode, "AUTH");
  });

  test("SoapFaultError carries subcode, detail and the raw body (F3, F16)", () => {
    const xml = faultEnvelope(
      "<env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>ORDER</env:Value></env:Subcode></env:Code>" +
      "<env:Reason><env:Text>Order failed</env:Text></env:Reason>" +
      "<env:Detail><lineErrors><item>Order: 4 created. Following products were not included: 999</item></lineErrors></env:Detail>",
    );
    const err = catches(() => parseSoapResponse(xml, "Order_Create"), SoapFaultError);
    assert.equal(err.code, "ORDER", "F3: the app code is Subcode/Value when present");
    assert.equal(err.faultCode, "Sender");
    assert.equal(err.subcode, "ORDER");
    assert.deepStrictEqual(err.detail, { lineErrors: ["Order: 4 created. Following products were not included: 999"] });
    assert.equal(err.raw, xml, ".raw is the whole body — F16 parses the order id out of it");
    assert.equal(err.detail.lineErrors[0].match(/Order:\s*(\d+)\s*created/)[1], "4");
    // A fault with no Detail says so rather than inventing one.
    assert.equal(catches(() => parseSoapResponse(soap12("AUTH", "nope"), "X"), SoapFaultError).detail, null);
  });

  test("a SOAP 1.2 Reason with two languages uses the first Text, and says so", () => {
    const xml = faultEnvelope("<env:Code><env:Value>env:Sender</env:Value></env:Code>" +
      "<env:Reason><env:Text xml:lang=\"da\">Fejl</env:Text><env:Text xml:lang=\"en\">Error</env:Text></env:Reason>");
    assert.equal(catches(() => parseSoapResponse(xml, "X"), SoapFaultError).reason, "Fejl");
  });

  test("nilAsNull:false keeps an xsi:nil element as its (empty) text", () => {
    const xml = "<r><a xsi:nil=\"true\"></a><b xsi:nil=\"1\"></b></r>";
    assert.deepStrictEqual(parseXml(xml), { r: { a: null, b: null } });
    assert.deepStrictEqual(parseXml(xml, { nilAsNull: false }), { r: { a: "", b: "" } });
  });

  test("xsi:nil is read from the ATTRIBUTE, on an element that is not self-closing", () => {
    // The old assertion used <a nil='1'/>, which returns null from the self-closing branch
    // whether or not nil is understood at all — it could not fail.
    assert.equal(parseXml("<a xsi:nil='1'></a>").a, null);
    assert.equal(parseXml("<a xsi:nil='true'></a>").a, null);
    assert.equal(parseXml("<a xsi:nil='false'></a>").a, "");
    assert.equal(parseXml("<a xsi:nil='true'>text</a>").a, null, "nil wins over stray text");
    // ...and a value that merely LOOKS like the attribute must not trip it.
    assert.equal(parseXml("<a title='nil=\"true\"'>x</a>").a, "x");
    assert.equal(parseXml("<a>nil</a>").a, "nil");
  });

  test("the path option seeds the path used by \"Parent/Child\" hints", () => {
    const frag = "<Product><PictureIds/></Product>";
    assert.deepStrictEqual(parseXml(frag, { path: "root", arrayElements: ["root/Product/PictureIds"] }),
      { Product: { PictureIds: [] } });
    assert.deepStrictEqual(parseXml(frag, { path: "other", arrayElements: ["root/Product/PictureIds"] }),
      { Product: { PictureIds: null } }, "a path hint that does not match must not fire");
  });

  test("an Envelope with no Body is a parse error, not an empty result", () => {
    const xml = "<env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\"><env:Header/></env:Envelope>";
    assert.match(catches(() => parseSoapResponse(xml, "X"), XmlParseError).message, /Envelope without a Body/);
  });

  test("unescapeXml refuses invalid character references instead of producing garbage", () => {
    assert.equal(unescapeXml("&#65;&#x42;"), "AB");
    assert.equal(unescapeXml("&#xD800;"), "&#xD800;", "a lone surrogate is left literal");
    assert.equal(unescapeXml("&#1114112;"), "&#1114112;", "above U+10FFFF is left literal");
    assert.equal(unescapeXml("&oslash;&nbsp;"), "&oslash;&nbsp;", "HTML entities are NOT XML syntax");
    assert.equal(unescapeXml("&constructor;"), "&constructor;", "prototype names must not resolve");
    assert.equal(unescapeXml("&amp;lt;"), "&lt;", "one pass only");
  });

  test("both TypeError guards fire rather than coercing", () => {
    assert.throws(() => parseElements(null), TypeError);
    assert.throws(() => parseElements(42), TypeError);
    assert.throws(() => decodeResponseBytes(42), TypeError);
    assert.throws(() => decodeResponseBytes(null), TypeError);
  });

  test("XmlParseError carries position, context AND the body (one bad char kills a page)", () => {
    const page = envelope("Product_GetAll",
      Array.from({ length: 40 }, (_, i) => `<item><Id>${i}</Id></item>`).join("") +
      "<item><Text><p>hej<br>der</p></Text></item>");
    const err = catches(() => parseSoapResponse(page, "Product_GetAll"), XmlParseError);
    assert.match(err.message, /mismatched closing tag <\/p>, expected <\/br>/);
    assert.ok(err.position > 0);
    assert.ok(err.context.length > 0);
    assert.equal(typeof err.source, "string");
    assert.ok(err.source.startsWith("<?xml"), "the failing document is attached, like SoapFaultError.raw");
    assert.ok(err.source.includes("<Id>0</Id>"), "including the records that were lost with it");
    assert.ok(err.source.length <= SOURCE_SNIPPET_LIMIT);
    // An HTML error page instead of SOAP is the other case where the body is the only clue.
    const nginx = catches(() => parseSoapResponse("<html><body><h1>502 Bad Gateway</h1><hr><center>nginx</center></body></html>", "X"), XmlParseError);
    assert.match(nginx.source, /502 Bad Gateway/);
  });

  test("the hand-rolled windows-1252 table matches the platform decoder for every byte", () => {
    // The fallback exists for a Node built without full-icu, so on THIS runtime it is
    // unreachable — which is why it has to be tested directly rather than through
    // decodeResponseBytes. 0x80..0x9F is where windows-1252 and latin-1 disagree.
    const all = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    assert.equal(decodeWindows1252Table(all), new TextDecoder("windows-1252").decode(all));
    assert.equal(decodeWindows1252Table(new Uint8Array([0x80, 0x92, 0x93])), "€’“");
    // And the live path still works end to end: cp1252 bytes for "Æblegrød" are not valid UTF-8.
    const r = decodeResponseBytes(new Uint8Array([0xc6, 0x62, 0x6c, 0x65, 0x67, 0x72, 0xf8, 0x64]));
    assert.equal(r.decodedAs, "windows-1252");
    assert.equal(r.text, "Æblegrød");
  });
});

// ---------------------------------------------------------------------------
describe("mixed content is never silently dropped — including in an item wrapper", () => {
  test("character data beside <item> rows throws instead of vanishing", () => {
    // The object branch preserved mixed content as "#text"; the all-<item> branch dropped it.
    // An ArrayOf* wrapper carrying text is a shape service.wsdl cannot produce, so this fails
    // loudly rather than returning a value that is quietly missing data.
    const err = catches(() => parseXml("<r><L>junk<item>a</item></L></r>"), XmlParseError);
    assert.match(err.message, /character data beside <item> rows in <L>/);
    assert.match(err.message, /"junk"/);
    // ...and the same shape inside a real response is not silently a 1-element list.
    catches(() => parseSoapResponse(envelope("X", "junk<item><Id>1</Id></item>"), "X"), XmlParseError);
  });

  test("pretty-printing is not mixed content", () => {
    assert.deepStrictEqual(parseXml("<r><L>\n  <item>a</item>\n  <item>b</item>\n</L></r>"),
      { r: { L: ["a", "b"] } });
  });

  test("mixed content in a RECORD is still preserved as #text", () => {
    assert.deepStrictEqual(parseXml("<r><Rec>loose<Id>1</Id></Rec></r>"), { r: { Rec: { Id: "1", "#text": "loose" } } });
  });
});
