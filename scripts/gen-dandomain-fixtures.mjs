#!/usr/bin/env node
/**
 * gen-dandomain-fixtures.mjs — build the LAYER 1 fixture pack for the DanDomain
 * source from the recorded probe artifacts under `data/probes/`.
 *
 * WHY A GENERATOR RATHER THAN HAND-WRITTEN FIXTURES. `data/` is gitignored, so
 * the probe artifacts cannot be referenced from a test. If the fixtures were
 * typed by hand they would be my recollection of what the shop returned, and
 * PLAYBOOK's whole method is that a recollection is not evidence. This script is
 * the audit trail: every response below names the artifact and the section it
 * came from, and re-running it against the same probes reproduces the pack.
 *
 * WHAT LAYER 1 IS. Verbatim-shaped SOAP response ENVELOPES, not parsed objects.
 * The offline suite feeds them to the REAL client through an injected fetch, so
 * the real XML parser, the real R26 batch audit and the real paged walk all run.
 * A fixture of pre-parsed objects would test the adapter against a shape the
 * server never sends, and the two findings that matter most here — R6/R18/R26's
 * record collapse and R26's per-record field omission — only exist in the bytes.
 *
 * THE COLLAPSE SHAPES ARE DELIBERATE. `gaps.json.sections.variants.sample`
 * records what the NAIVE parser did to a three-variant response: three records
 * became `{item:[...], MinAmount:["1","1","1"], Title:["Small","Medium","Large"],
 * Unit:[...], StockLocations:[...]}`. The recorded `item` object stops exactly
 * after `Sorting`, and the next field in WSDL order is `VariantTypeValues` — an
 * `ArrayOfInt`, i.e. `<VariantTypeValues><item>4</item></VariantTypeValues>`.
 * That inner `</item>` is what terminated the naive parser's lazy match of the
 * OUTER `<item>`, hoisting every later field into a parallel array.
 *
 * That last step is an INFERENCE from the collapse pattern, not a recording, and
 * it is labelled as one below. It matters because it predicts that the inline
 * variant->option link R20 called "unread" is present in the bytes and was only
 * destroyed by the parser. The fixture encodes the prediction so the real parser
 * is tested against it; the adapter falls back to the per-variant call either
 * way, so nothing depends on the inference being right.
 *
 * Usage: node scripts/gen-dandomain-fixtures.mjs [--check]
 *   --check  exit 1 if the generated pack differs from what is on disk
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBES = path.join(ROOT, "data", "probes");
const OUT = path.join(ROOT, "fixtures", "dandomain", "raw");
const CHECK = process.argv.includes("--check");

const probe = (name) => {
  const p = path.join(PROBES, `${name}.json`);
  if (!existsSync(p)) throw new Error(`missing probe artifact ${p} — run the probe kit first (this script only RE-derives, it never invents)`);
  return JSON.parse(readFileSync(p, "utf8"));
};

// ---------------------------------------------------------------------------------------------
// JSON -> SOAP body XML, in the shape this server actually emits
// ---------------------------------------------------------------------------------------------
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The server writes an entity-encoded string as `&amp;aring;` on the wire so the
 * XML parser hands back the literal text `&aring;` — which is exactly what
 * `smoke.json.productSample` recorded ("Eksempel p&aring; produkt 1"). Passing
 * such a value through `esc` reproduces that, and it is why the adapter decodes
 * HTML entities as well as XML ones.
 */
function toXml(value, indent = "") {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined || v === null
      ? `${indent}<item/>\n`
      : `${indent}<item>${typeof v === "object" ? "\n" + toXml(v, indent + "  ") + indent : esc(v)}</item>\n`)).join("");
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([k, v]) => {
      // `undefined` used to fall through to the scalar arm and render the literal
      // six characters "undefined" into the fixture — a value the server never
      // sends, in a file whose whole claim is that it is what the server sent.
      // JSON.parse cannot produce undefined, so this only fires on a hand-built
      // object, which is precisely where the mistake is easy to make and hard to
      // see. `nillable !== omissible` (R35): an absent value is an EMPTY element,
      // never a string.
      if (v === null || v === undefined) return `${indent}<${k}/>\n`;
      if (typeof v === "object") return `${indent}<${k}>\n${toXml(v, indent + "  ")}${indent}</${k}>\n`;
      return `${indent}<${k}>${esc(v)}</${k}>\n`;
    }).join("");
  }
  return `${indent}${esc(value)}\n`;
}

/** A complete SOAP 1.2 response envelope for one operation. */
function envelope(op, result) {
  // A SCALAR result is written inline, exactly as the server writes it:
  // `<Result>true</Result>`. Pretty-printing it would surround the value with
  // whitespace the real wire never has, and a fixture that is easier to read
  // than the wire is a fixture that tests a shape nobody serves.
  const inner = result === null
    ? `      <ns1:${op}Result/>\n`
    : (typeof result === "object"
      ? `      <ns1:${op}Result>\n${toXml(result, "        ")}      </ns1:${op}Result>\n`
      : `      <ns1:${op}Result>${esc(result)}</ns1:${op}Result>\n`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="https://api.hostedshop.io/service.php">
  <env:Body>
    <ns1:${op}Response>
${inner}    </ns1:${op}Response>
  </env:Body>
</env:Envelope>`;
}

const ok = (op) => envelope(op, "true");
const files = {};
const add = (file, provenance, responses) => { files[file] = { provenance, responses }; };

// ---------------------------------------------------------------------------------------------
// shop context
// ---------------------------------------------------------------------------------------------
{
  const smoke = probe("smoke");
  const prof = probe("profile");
  const groups = prof.raw?.userGroups ?? [];
  const countries = prof.raw?.countries ?? [];
  add("shop.json",
    "smoke.json (webinfo, languages, currencies, vatGroups) + profile.json (raw.userGroups, raw.countries). shop000000, 2026-08-15. P6 shopContext: Product_GetDeliveryTimeAll + Product_GetAdditionalTypesAll return empty lists on this shop (CONSTRUCTED empty envelopes — ops exist, zero rows).",
    {
      Solution_Connect: [ok("Solution_Connect")],
      Solution_GetWebinfo: [envelope("Solution_GetWebinfo", smoke.webinfo)],
      Currency_GetAll: [envelope("Currency_GetAll", smoke.currencies)],
      VatGroup_GetAll: [envelope("VatGroup_GetAll", smoke.vatGroups)],
      Solution_GetLanguages: [envelope("Solution_GetLanguages", smoke.languages)],
      User_GetGroupAll: [envelope("User_GetGroupAll", groups)],
      Product_GetDeliveryCountryAll: [envelope("Product_GetDeliveryCountryAll", countries)],
      Product_GetDeliveryTimeAll: [envelope("Product_GetDeliveryTimeAll", null)],
      Product_GetAdditionalTypesAll: [envelope("Product_GetAdditionalTypesAll", null)],
      // F22 — `blog` and `news` are VALID module names on this shop and both
      // answer true. That is what makes BLOG_NOT_EXPORTED fire.
      Solution_HasModule: [envelope("Solution_HasModule", "true"), envelope("Solution_HasModule", "true")]
    });
}

// ---------------------------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------------------------
{
  const gaps = probe("gaps");
  const smoke = probe("smoke");
  const close = probe("close");
  const variantItems = gaps.sections?.variants?.sample?.[0]?.item ?? [];
  const titles = gaps.sections?.variants?.sample?.[0]?.Title ?? [];
  const minAmounts = gaps.sections?.variants?.sample?.[0]?.MinAmount ?? [];
  if (variantItems.length !== 3) throw new Error(`expected 3 recorded variant rows in gaps.json, got ${variantItems.length}`);

  // R25/R31 — variant 4/5/28 -> value 4/5/8 (Small/Medium/Large), type 2
  // (Størrelse), sorting 1/2/3. Recorded in close.json.sections.optionValueOrder.
  const VALUE_FOR_VARIANT = { 4: "4", 5: "5", 28: "8" };
  const sizeValues = (close.sections?.optionValueOrder?.sortingForRealVariantValues ?? []).length
    ? close.sections.optionValueOrder.sortingForRealVariantValues
    : [{ Id: "4", Title: "Small", Sorting: "1" }, { Id: "5", Title: "Medium", Sorting: "2" }, { Id: "8", Title: "Large", Sorting: "3" }];

  const variants = variantItems.map((v, i) => ({
    ...v,
    // INFERRED position (see the header): between Sorting and MinAmount, and an
    // ArrayOfInt, which is what broke the naive parser's outer <item> match.
    VariantTypeValues: [VALUE_FOR_VARIANT[Number(v.Id)] ?? String(v.Id)],
    MinAmount: minAmounts[i] ?? "1",
    Title: titles[i] ?? `Variant ${v.Id}`,
    Unit: { Id: "1", LanguageISO: "DK", Title: "stk." },
    StockLocations: [{ StockLocationId: "1", DeliveryTimeId: "-1", Stock: v.Stock ?? "0", BuyPrice: v.BuyingPrice ?? "0" }]
  }));
  // P6 — variant PictureId→product Pictures[] for transform v.image.src pin.
  for (const v of variants) {
    if (String(v.Id) === "4") v.PictureId = "1";
  }

  const sample = smoke.productSample ?? [];
  const title1 = sample[0]?.Title ?? "Eksempel p&aring; produkt 1";

  // Product 1 — the variable product. Titles keep the recorded HTML-entity
  // encoding (`p&aring;`), because that is what the server sent.
  const p1 = {
    Id: "1", CategoryId: "1", SecondaryCategoryIds: null, ProducerId: "0",
    Online: "true", Status: "true", DisableOnEmpty: "false", CallForPrice: "false",
    Stock: "30", StockLow: "0", OutOfStockBuy: "0", ItemNumber: "DEMO-1", ItemNumberSupplier: "",
    Url: "", Weight: "0.5", BuyingPrice: "79", Price: "199", Discount: "0", DiscountType: "",
    GuidelinePrice: "0", DeliveryTimeId: "-1", Ean: "5701234567890",
    DateCreated: "2019-01-05 10:00:00", DateUpdated: "0000-00-00 00:00:00",
    LanguageISO: "DK", Title: title1,
    SeoTitle: "", SeoDescription: "", SeoKeywords: "", SeoLink: "eksempel-paa-produkt-1", SeoCanonical: "",
    Description: "Kort tekst", DescriptionShort: "Kort", DescriptionLong: "<p>Lang beskrivelse med &oslash; og &aring;.</p>",
    MinAmount: "1", Sorting: "0", UnitId: "1", VatGroupId: "2", Type: "", TypeLabel: "",
    RelatedProductIds: null, UserGroupAccessIds: null,
    Variants: variants,
    // R21/R14 — a bare FileName. It resolves ONLY through the verified URL base.
    Pictures: [{ Id: "1", ProductId: "1", FileName: "product-1.png", Sorting: "0", ImageAltTexts: [{ Text: "Produkt 1", LanguageAccess: "DK" }] }],
    CustomData: null,
    // R22/R29 — the recorded price-line hazard, as rows. Cheapest row is a
    // group-scoped 42; the only genuinely public row is 90.
    Discounts: [
      { Id: "1", ProductId: "1", ProductVariantId: "0", Amount: "1", Price: "42", Discount: "0", Currency: "DKK", DiscountType: "b", UserType: "", UserId: "4", Date: "false", DateFrom: "", DateTo: "", Accumulate: "false", Site: "1", Language: "DK" },
      { Id: "3", ProductId: "1", ProductVariantId: "0", Amount: "1", Price: "42", Discount: "0", Currency: "DKK", DiscountType: "b", UserType: "all", UserId: "4", Date: "false", DateFrom: "", DateTo: "", Accumulate: "false", Site: "1", Language: "DK" },
      { Id: "4", ProductId: "1", ProductVariantId: "0", Amount: "1", Price: "42", Discount: "0", Currency: "DKK", DiscountType: "b", UserType: "group", UserId: "4", Date: "false", DateFrom: "", DateTo: "", Accumulate: "false", Site: "1", Language: "DK" },
      { Id: "5", ProductId: "1", ProductVariantId: "0", Amount: "1", Price: "90", Discount: "0", Currency: "DKK", DiscountType: "b", UserType: "all", UserId: "0", Date: "false", DateFrom: "", DateTo: "", Accumulate: "false", Site: "1", Language: "DK" },
      { Id: "6", ProductId: "1", ProductVariantId: "0", Amount: "1", Price: "55", Discount: "0", Currency: "DKK", DiscountType: "b", UserType: "guest", UserId: "0", Date: "false", DateFrom: "", DateTo: "", Accumulate: "false", Site: "1", Language: "DK" },
      { Id: "7", ProductId: "1", ProductVariantId: "0", Amount: "10", Price: "30", Discount: "0", Currency: "DKK", DiscountType: "b", UserType: "all", UserId: "0", Date: "false", DateFrom: "", DateTo: "", Accumulate: "false", Site: "1", Language: "DK" },
      { Id: "8", ProductId: "1", ProductVariantId: "0", Amount: "1", Price: "35", Discount: "0", Currency: "DKK", DiscountType: "a", UserType: "0", UserId: "0", Date: "false", DateFrom: "", DateTo: "", Accumulate: "false", Site: "1", Language: "DK" }
    ],
    // R19 — Product_GetTags is a REVIEW carrying a reviewer email address.
    // Present in the payload on purpose: the adapter must count it and drop it.
    Tags: [{ Id: "1", LanguageISO: "DK", Title: "God kop", UserId: "0", Username: "Anmelder", UserEmail: "reviewer@example.invalid", Rating: "5", Text: "Rigtig god.", DateCreated: "2025-03-01 12:00:00" }],
    SecondaryCategories: null,
    StockLocations: [{ StockLocationId: "1", DeliveryTimeId: "-1", Stock: "30", BuyPrice: "79" }],
    VariantTypes: [{ Id: "2", LanguageISO: "DK", Title: "Størrelse", Sorting: "0" }]
  };

  // Product 2 — the simple one, and R26's per-record omission: it has NO
  // SeoLink key at all (8 of 618 products had one), which must read as an EMPTY
  // VALUE, never as a truncated column. Also CallForPrice.
  const p2 = {
    Id: "2", CategoryId: "1", SecondaryCategoryIds: null, ProducerId: "0", Online: "true", Status: "false",
    DisableOnEmpty: "false", CallForPrice: "true", Stock: "0", StockLow: "0", OutOfStockBuy: "1",
    ItemNumber: "DEMO-2", ItemNumberSupplier: "", Url: "", Weight: "0", BuyingPrice: "0", Price: "249",
    Discount: "0", DiscountType: "", GuidelinePrice: "0", DeliveryTimeId: "-1", Ean: "",
    DateCreated: "2020-06-01 09:00:00", DateUpdated: "2026-01-02 08:00:00",
    LanguageISO: "DK", Title: sample[2]?.Title ?? "Eksempel p&aring; produkt 3",
    // NO SeoLink key AT ALL — that is R26's finding, and the only field this
    // record is missing. Everything else is present-but-empty so the batch
    // audit has exactly one thing to be right or wrong about.
    SeoTitle: "SEO titel", SeoDescription: "SEO beskrivelse", SeoKeywords: "", SeoCanonical: "",
    Description: "", DescriptionShort: "", DescriptionLong: "",
    MinAmount: "1", Sorting: "1", UnitId: "1", VatGroupId: "1", Type: "", TypeLabel: "",
    RelatedProductIds: null,
    // Restricted to the "Kunder B2B-login" group (id 4, from profile.json). A
    // product a logged-out visitor cannot even SEE on the source, which Shopify
    // has no equivalent for on a plain product — so it would import publicly
    // visible. CONSTRUCTED: this shop has no restricted product.
    UserGroupAccessIds: ["4"],
    Variants: null, Pictures: null, CustomData: null, Discounts: null, Tags: null,
    SecondaryCategories: null, StockLocations: null, VariantTypes: null
  };

  // Product 17 — `PROBE-VS-25`, verbatim from vatserver.json. This is R1's
  // subject: entered at 100 in the 25% VAT group, and the order below shows the
  // server pricing its line at 80 NET. Both halves of the finding in one pack.
  const vs = probe("vatserver");
  const p25 = vs.products?.p25?.product ?? {};
  const p17 = {
    Id: String(p25.Id ?? "17"), CategoryId: "9", SecondaryCategoryIds: null, ProducerId: "0",
    Online: String(p25.Online ?? "true"), Status: String(p25.Status ?? "true"),
    DisableOnEmpty: "false", CallForPrice: "false", Stock: String(p25.Stock ?? "99"), StockLow: "0",
    OutOfStockBuy: "0", ItemNumber: String(p25.ItemNumber ?? "PROBE-VS-25"), ItemNumberSupplier: "",
    Url: "", Weight: "0", BuyingPrice: "0", Price: String(p25.Price ?? "100"),
    Discount: "0", DiscountType: "", GuidelinePrice: "0", DeliveryTimeId: "-1", Ean: "",
    DateCreated: "2026-08-15 18:00:00", DateUpdated: "0000-00-00 00:00:00",
    LanguageISO: "DK", Title: String(p25.Title ?? "PROBE server-priced 25pct at 100"),
    SeoTitle: "", SeoDescription: "", SeoKeywords: "", SeoLink: "probe-vs-25", SeoCanonical: "",
    Description: "", DescriptionShort: "", DescriptionLong: "",
    MinAmount: "1", Sorting: "2", UnitId: "1", VatGroupId: String(p25.VatGroupId ?? "2"),
    Type: "", TypeLabel: "", RelatedProductIds: null, UserGroupAccessIds: null,
    Variants: null, Pictures: null, CustomData: null, Discounts: null, Tags: null,
    SecondaryCategories: null, StockLocations: null, VariantTypes: null
  };

  const farveValues = [
    { Id: "1", LanguageISO: "DK", Title: "Sort", ProductVariantTypeId: "1", Sorting: "1", Color: "000000", Picture: "" },
    { Id: "2", LanguageISO: "DK", Title: "Rød", ProductVariantTypeId: "1", Sorting: "2", Color: "FF0000", Picture: "" },
    { Id: "3", LanguageISO: "DK", Title: "Grå", ProductVariantTypeId: "1", Sorting: "3", Color: "A1A1A1", Picture: "" },
    { Id: "6", LanguageISO: "DK", Title: "Gul", ProductVariantTypeId: "1", Sorting: "4", Color: "FFFF00", Picture: "" },
    { Id: "7", LanguageISO: "DK", Title: "Hvid", ProductVariantTypeId: "1", Sorting: "5", Color: "FFFFFF", Picture: "" }
  ];

  add("products.json",
    [
      "RECORDED: gaps.json sections.variants.sample (the three-variant collapse); close.json sections.optionValueOrder (R31 sorting);",
      "smoke.json productSample (entity-encoded titles); gapsw.json sections.priceLines.readBack + close.json sections.guestScope",
      "for price-line rows Id 1/3/4/5/6 (R22->R29); vatserver.json products.p25 for product 17 (R1's subject).",
      "CONSTRUCTED, and labelled here because no recorded row has these shapes: price-line row Id 7 (a quantity break) and",
      "row Id 8 (an out-of-vocabulary UserType carrying DiscountType 'a'); product 2's UserGroupAccessIds. Each exists to",
      "exercise a rule the recorded rows cannot reach.",
      "NORMALISED: the recorded price-line rows carried probe scaffolding, changed here to shop-plausible values —",
      "Currency '1'->'DKK', Site '0'->'1', Language ''->'DK', DateFrom zero-date->''. gapsw row Id 2 (UserType '0', UserId '4')",
      "is not carried; row Id 8 covers the unknown-scope case.",
      "P6 CONSTRUCTED: variant 4 PictureId→1 maps to product picture 1 for variant image test.",
      "INFERRED: the position of VariantTypeValues — see this script's header.",
      "CONSTRUCTED P6: variant 4 PictureId 1 points at product Pictures[0] for variant-image pin (recorded gaps rows had PictureId 0)."
    ].join(" "),
    {
      Product_SetFields: [ok("Product_SetFields")],
      Product_SetVariantFields: [ok("Product_SetVariantFields")],
      Product_GetVariantTypeAll: [envelope("Product_GetVariantTypeAll", [{ Id: "1", LanguageISO: "DK", Title: "Farve", Sorting: "0" }, { Id: "2", LanguageISO: "DK", Title: "Størrelse", Sorting: "1" }])],
      // One response per type, in id order: R31's JOIN needs the per-type list,
      // and Farve is here as well so a wrong type id cannot silently pick the
      // right values.
      Product_GetVariantTypeValuesByType: [
        envelope("Product_GetVariantTypeValuesByType", farveValues),
        envelope("Product_GetVariantTypeValuesByType", sizeValues.map((v) => ({ Id: String(v.Id), LanguageISO: "DK", Title: String(v.Title), ProductVariantTypeId: "2", Sorting: String(v.Sorting), Color: "", Picture: "" })))
      ],
      // P6 — per-product tilvalg read when Product_GetAdditionalTypesAll is non-empty.
      Product_GetAdditionalTypes: [envelope("Product_GetAdditionalTypes", null)],
      // The walk asks for a second window to confirm the end of the data.
      Product_GetAllWithLimit: [envelope("Product_GetAllWithLimit", [p1, p2, p17]), envelope("Product_GetAllWithLimit", null)]
    });
}

// ---------------------------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------------------------
{
  const urls = probe("urls");
  const cat = urls.category ?? {};
  add("categories.json",
    "urls.json category (the recorded Category shape, including the WSDL's misspelled SeoDescripton) + R21's confirmed /shop/category media subtree.",
    {
      Category_GetAll: [envelope("Category_GetAll", [
        { ...cat, Id: "1", Title: "Demo kategori", SeoLink: "demo-kategori", ParentId: "0", Status: "true", Sorting: "0", Description: "Beskrivelse med &oslash;" },
        { ...cat, Id: "9", Title: "Probe Kategori", SeoLink: null, ParentId: "1", Status: "true", Sorting: "1" }
      ])],
      Category_GetPictures: [
        envelope("Category_GetPictures", [{ Id: "1", CategoryId: "1", Name: "category-1.png", Sorting: "0", ImageAltTexts: null }]),
        envelope("Category_GetPictures", null)
      ]
    });
}

// ---------------------------------------------------------------------------------------------
// customers
// ---------------------------------------------------------------------------------------------
{
  const close = probe("close");
  const perField = close.sections?.userTruncation?.perField ?? [];
  if (!perField.length) throw new Error("close.json has no userTruncation.perField — R28's evidence is missing");
  // R28 — all 56 fields round-trip when populated. The shop itself has ZERO
  // customers, so this record is the SYNTHETIC one R28 created on
  // example.invalid (RFC 2606, cannot route to a person), reused verbatim.
  add("customers.json",
    "close.json sections.userTruncation (R28: the User read is NOT truncated; 56/56 fields round-trip). The shop has 0 real customers — this is the synthetic example.invalid record R28 created.",
    {
      User_SetFields: [ok("User_SetFields")],
      User_GetAll: [envelope("User_GetAll", [{
        Id: "1", Username: "probe-ship@example.invalid", UserGroupId: "4", Type: "", Company: "Probe ApS",
        Cvr: "12345678", Ean: "5790000000000", Firstname: "Probe", Lastname: "Shipping", Sex: "0",
        Address: "Testvej 1", Address2: "", Zip: "8000", City: "Aarhus", Country: "Danmark",
        CountryCode: "1", Currency: "DKK", Phone: "+4512345678", Mobile: "", Fax: "",
        Email: "probe-ship@example.invalid", Url: "", DiscountGroupId: "0",
        Newsletter: "true", Referer: "", BirthDate: "", DateCreated: "2024-03-01 12:00:00",
        DateUpdated: "0000-00-00 00:00:00", Approved: "true", LanguageISO: "DK",
        Description: "probe description", Number: "D-1001", Site: "1",
        ShippingType: "1", ShippingFirstname: "Ship", ShippingLastname: "Recipient",
        ShippingCompany: "Probe ApS", ShippingCvr: "12345678", ShippingEan: "5790000000000",
        ShippingAddress: "Leveringsvej 2", ShippingAddress2: "2. sal", ShippingZip: "8200",
        ShippingCity: "Aarhus N", ShippingCountry: "Danmark", ShippingCountryCode: "1",
        ShippingState: "", ShippingPhone: "+4512345678", ShippingMobile: "+4587654321",
        ShippingEmail: "ship@example.invalid", ShippingReferenceNumber: "REF-1",
        Consent: "true", ConsentDate: "2024-03-01 12:00:00"
      }])]
    });
}

// ---------------------------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------------------------
{
  const vs = probe("vatserver");
  const kn = probe("kreditnota");
  const order = vs.serverPriced?.order;
  const line = vs.serverPriced?.lines?.[0];
  if (!order || !line) throw new Error("vatserver.json has no serverPriced order/line — R1's evidence is missing");

  // R1's decisive order, verbatim: a 25% product ENTERED at 100 produced a
  // server-priced line of 80 and a Total of 80. Product prices are INCLUSIVE,
  // order money is NET, and both sides call the field `Price`.
  const o18 = {
    ...order,
    // The nested OrderLines here carry the money, i.e. the case where the line
    // field set DID take. The refetch fixture below covers the other case.
    OrderLines: [{ ...line }],
    InvoiceNumber: null,
    Currency: { OrderId: "18", Id: "1", Iso: "DKK", Symbol: "DKK", SymbolPlace: "right", Currency: "1", Decimal: ",", Point: ".", Round: "3" },
    Transactions: [{
      Id: "1", OrderId: "18", PaymentId: "1", Status: "1", TransactionNumber: "987654",
      // F30 — Amount is in ØRE. 10000 øre = 100.00. AmountFull is the major-unit
      // form, and the adapter must not read Amount as major units.
      Cardtype: "Visa", Amount: "10000", AmountFull: "100", AmountOriginal: "100",
      Currency: "1", Errorcode: "0", Actioncode: "0", Date: "2019-01-05 10:00:00"
    }],
    UserId: "1",
    // F19/F32 — DateDelivered holds the CREATION timestamp and DateSent/
    // DateUpdated are zero-dates, which must read as null, not as year 0.
    DateDelivered: "2026-08-15 18:41:30", DateSent: "0000-00-00 00:00:00", DateUpdated: "0000-00-00 00:00:00",
    DateDue: "0000-00-00 00:00:00",
    OrderComment: "", OrderCommentExternal: "", CustomerComment: "Ring ved levering",
    DeliveryComment: "", DeliveryTime: "", TrackingCode: "", PackingId: "0",
    DeliveryId: "1", LanguageISO: "DK", Site: "1", CustomerId: "14", ReferenceNumber: "VS-SERVER-PRICED",
    Origin: "", ReferralCode: "", DiscountCodes: null
  };

  // A multi-quantity order: the ONLY shape that can decide whether
  // OrderLine.Price is a unit price or a line total. Total 240 = 80 x 3, so it
  // decides UNIT. Constructed, and labelled as constructed — every probe order
  // used quantity 1, where the two hypotheses predict the same number.
  const o19 = {
    ...o18, Id: "19", Total: "240", ReferenceNumber: "MULTI-QTY",
    OrderLines: [{ ...line, Id: "15", OrderId: "19", Amount: "3", Price: "80", PriceRounded: "80" }],
    Transactions: null, Origin: ""
  };

  // F38 — the credit note. Recorded in kreditnota.json: order 17 is order 16's
  // credit note, status 99 (Kladde, NOT 100), Total negative, Origin "16", and
  // ReferenceNumber INHERITED from the parent.
  const parent = { ...o18, Id: "16", Total: "150", Status: "0", ReferenceNumber: "SRC-MIXED-VAT", Origin: "", Transactions: null, OrderLines: [{ ...line, Id: "10", OrderId: "16", Amount: "1", Price: "150", PriceRounded: "150" }] };
  const note = { ...parent, Id: "17", Total: "-150", Status: kn?.creditNote?.Status ?? "99", Origin: "16", OrderLines: [{ ...line, Id: "12", OrderId: "17", Amount: "1", Price: "-150", PriceRounded: "-150" }] };

  add("orders.json",
    "vatserver.json serverPriced (R1: the 25%-at-100 product priced at 80 NET) + kreditnota.json (F38: order 17 is order 16's credit note at status 99 with Origin 16 and an inherited ReferenceNumber). The multi-quantity order 19 is CONSTRUCTED — no probe order ever used a quantity above 1, which is exactly why the line-price basis is unrecorded.",
    {
      Order_SetFields: [ok("Order_SetFields")],
      Order_SetOrderLineFields: [ok("Order_SetOrderLineFields")],
      Order_GetAllWithPagination: [envelope("Order_GetAllWithPagination", [o18, o19, parent, note]), envelope("Order_GetAllWithPagination", null)],
      Order_GetLines: [envelope("Order_GetLines", [line])]
    });

  // ---- the SECONDARY money path, entirely CONSTRUCTED and labelled as such ----
  // An adversarial review measured that the recorded fixtures contain no shipping
  // charge, no payment fee, no line-level discount, no non-integer quantity and no
  // line whose product is missing — so twelve mutations to those paths survived
  // every assertion. None of these shapes exists on shop000000 (its probe orders
  // were minimal by construction), so they cannot be recorded, only built. They
  // claim NOTHING about the platform: each one exercises a rule this adapter
  // states, against the shape that rule is about.
  const money = {
    // Total 140 = the post-discount NET line sum (2 x 80 - 2 x 10), which is one
    // of the two readings the adapter accepts; the other is 160 (pre-discount).
    // Whether this platform's Order.Total is pre- or post-discount is unrecorded,
    // and the adapter refuses to guess — see the ORDER_TOTAL_MISMATCH comment.
    ...o18, Id: "20", Total: "140", ReferenceNumber: "MONEY-PATH", Origin: "",
    // 70 is the delivery price this shop actually charges — the number the F1-F38
    // adversarial review used to prove Order.Total is not a materialised total.
    Delivery: { ...(o18.Delivery ?? {}), Id: "20", OrderId: "20", Vat: "true", Title: "GLS Pakkeshop", Price: "70", BuyPrice: "0", ServiceType: "gls", DroppointId: "0", DroppointIdLong: "" },
    Payment: { ...(o18.Payment ?? {}), Id: "20", OrderId: "20", PaymentMethodId: "1", Title: "Kontooverf&oslash;rsel", Price: "20", Vat: "true", ExternalId: "" },
    // 80 net, 10 off, quantity 2 -> 140 net, 35 VAT at 25 %; plus 70 + 17.50
    // shipping and 20 + 5 fee = 287.50 captured. AmountFull states that
    // independently, so the oracle can catch a wrong model.
    OrderLines: [{ ...line, Id: "20", OrderId: "20", Amount: "2", Price: "80", PriceRounded: "80", Discount: "10", DiscountRounded: "10" }],
    Transactions: [{ Id: "2", OrderId: "20", PaymentId: "1", Status: "1", TransactionNumber: "111", Cardtype: "Visa", Amount: "28750", AmountFull: "287.5", AmountOriginal: "287.5", Currency: "1", Errorcode: "0", Actioncode: "0", Date: "2020-02-02 10:00:00" }],
    DiscountCodes: [{ Id: "1", OrderId: "20", DiscountId: "1", Title: "VELKOMMEN10", Type: "percent", Value: "10", Discount: "20", Vat: "false", IsNewGiftCard: "false" }]
  };
  // A line whose product is not in the catalogue, and a fractional quantity.
  const orphan = {
    ...o18, Id: "21", Total: "100", ReferenceNumber: "ORPHAN", Origin: "", Transactions: null,
    OrderLines: [
      { ...line, Id: "21", OrderId: "21", ProductId: "99999", ItemNumber: "GONE-1", Amount: "1", Price: "50", PriceRounded: "50", OfflineProduct: "true" },
      { ...line, Id: "22", OrderId: "21", Amount: "2.5", Price: "20", PriceRounded: "20", Unit: "kg" }
    ]
  };

  add("orders-money.json",
    "FULLY CONSTRUCTED. shop000000's probe orders carry no shipping charge, no payment fee, no line discount, no fractional quantity and no orphaned line, so these shapes cannot be recorded — only built. The 70-unit delivery price is the one real number here (the shop's own, from the F1-F38 adversarial review). These fixtures claim nothing about the platform; they exercise rules the adapter states.",
    {
      Order_SetFields: [ok("Order_SetFields")],
      Order_SetOrderLineFields: [ok("Order_SetOrderLineFields")],
      Order_GetAllWithPagination: [envelope("Order_GetAllWithPagination", [money, orphan]), envelope("Order_GetAllWithPagination", null)],
      Order_GetLines: [envelope("Order_GetLines", [line])]
    });

  // The OTHER recorded case: the nested OrderLines came back as the DEFAULT
  // projection `{Id, PacketLines, LineAddresses}` — no money at all. This is
  // verbatim what vatserver.json's `serverPriced.order.OrderLines` holds, and it
  // is why the adapter checks the data before believing the field set took.
  add("orders-default-projection.json",
    "vatserver.json serverPriced.order.OrderLines — the DEFAULT line projection, verbatim. No Price, no Amount, no ProductId.",
    {
      Order_SetFields: [ok("Order_SetFields")],
      Order_SetOrderLineFields: [ok("Order_SetOrderLineFields")],
      Order_GetAllWithPagination: [envelope("Order_GetAllWithPagination", [{ ...o18, OrderLines: [{ Id: "14", PacketLines: null, LineAddresses: null }] }]), envelope("Order_GetAllWithPagination", null)],
      Order_GetLines: [envelope("Order_GetLines", [line])]
    });
}

// ---------------------------------------------------------------------------------------------
// coupons
// ---------------------------------------------------------------------------------------------
{
  // R19's table records `Discount_GetAll` -> ok, 0 rows: this shop has no
  // discounts, so a row here is CONSTRUCTED from the 24-field WSDL type. It is
  // labelled as such: nothing about DanDomain discount behaviour is claimed
  // from it, only that the adapter maps the shape it declares.
  add("coupons.json",
    "CONSTRUCTED from the Discount complexType (24 fields, R19). shop000000 has ZERO discounts — gaps.json sections.discounts records `Discount_GetAll -> ok, 0`. This fixture proves the mapping, never the platform's behaviour.",
    {
      Discount_GetAll: [envelope("Discount_GetAll", [
        { Id: "1", Title: "Velkommen 10%", Type: "percent", Value: "10", Code: "VELKOMMEN10", UseCount: "3", ProductIds: null, DiscountCustomerAssociation: null, DiscountCustomerGroupAssociation: { AssociationType: "include", CustomerGroupIds: ["4"] }, Limit: "100", DateExpire: "0000-00-00 00:00:00", DateCreated: "2025-01-10 08:00:00", AmountSpent: "0", AmountSpentPrecise: "0", Vat: "0", AllowDiscountedProducts: "true", StartDate: "2025-01-10 08:00:00", IsActive: "true", IsRestrictedToNewCustomer: "false", MinimumCartValue: "100", DiscountedProductCategories: null, IsSingleUsePerCustomer: "true", DeliveryMethodIds: null, FreeGift: null },
        { Id: "2", Title: "Gratis gave", Type: "amount", Value: "0", Code: "GAVE", UseCount: "0", ProductIds: ["1"], DiscountCustomerGroupAssociation: null, Limit: "", DateExpire: "2024-08-31 23:59:59", DateCreated: "2024-06-01 08:00:00", Vat: "0", StartDate: "2024-06-01 08:00:00", IsActive: "true", IsRestrictedToNewCustomer: "true", MinimumCartValue: "0", DiscountedProductCategories: { AssociationType: "include", CategoryIds: ["1"] }, IsSingleUsePerCustomer: "false", DeliveryMethodIds: null, FreeGift: { ProductId: "1", VariantId: "0", Amount: "1" } }
      ])]
    });
}

// ---------------------------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------------------------
{
  const gaps = probe("gaps");
  const byFolder = gaps.sections?.pages?.byFolder ?? [];
  if (!byFolder.length) throw new Error("gaps.json has no pages.byFolder — R15's evidence is missing");
  // R15 — the recorded sweep: folders 0 and 1 hold one row each (title not
  // extractable through the naive parser), folder 3 holds four named pages,
  // folder 6 holds one, folder 8 holds one, and everything else is empty.
  const responses = {};
  const seq = [];
  let nextId = 1;
  for (const f of byFolder) {
    const rows = [];
    for (let i = 0; i < (f.count ?? 0); i++) {
      const title = f.titles?.[i] ?? "";
      rows.push({
        Id: String(nextId++), CategoryId: String(f.folderId), Sorting: String(i), ParentId: "0",
        ShowInMenu: "true", Target: "", UpdatedDate: "2025-05-05 12:00:00", LanguageISO: "DK",
        Title: title, Headline: title, Link: title ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "",
        Text: title ? `<p>Indhold for ${title} med &oslash;.</p>` : "<p>Uden titel</p>",
        Text2: "", Text3: "", Visible: "1",
        SeoKeywords: "", SeoDescription: "", SeoTitle: "", Pictures: null
      });
    }
    seq.push(rows.length ? rows : null);
  }
  responses.PageText_SetFields = [ok("PageText_SetFields")];
  responses.PageText_GetByFolder = seq.map((rows) => envelope("PageText_GetByFolder", rows));
  add("pages.json",
    `gaps.json sections.pages.byFolder — the recorded folder sweep 0-${byFolder[byFolder.length - 1]?.folderId}. Counts and titles are verbatim; page bodies are filler because the naive parser never extracted them (R18).`,
    responses);
}

// ---------------------------------------------------------------------------------------------
// recorded naive-parser collapse (not adapter SOAP)
// ---------------------------------------------------------------------------------------------
// The adapter packs above store UN-collapsed reconstructions the real parser
// must not squash. The collapse the naive walker actually produced lives here,
// copied from the probe artifacts — so a clone without `data/probes/` still
// holds the recorded failure shapes, and `--check` still derives them.
{
  const gaps = probe("gaps");
  const scale = probe("scale");
  const v = gaps.sections?.variants;
  if (!v?.sample) throw new Error("gaps.json sections.variants.sample missing — the collapse pack cannot invent it");
  files["collapse-variants.json"] = {
    provenance: "RECORDED: gaps.json sections.variants.sample + audit.returned + perProduct. Naive-parser collapse (three variant records became one object truncated before VariantTypeValues). Not SOAP the adapter consumes — products.json stores the un-collapsed reconstruction.",
    responses: {},
    collapse: {
      sample: v.sample,
      auditReturned: v.audit?.returned ?? null,
      perProduct: v.perProduct ?? null
    }
  };
  const p = gaps.sections?.pages;
  if (!p?.audit) throw new Error("gaps.json sections.pages.audit missing");
  files["collapse-pages.json"] = {
    provenance: "RECORDED: gaps.json sections.pages.audit.returned, byIdsCount, byIdsTitles, byFolder (id/count/titles). Naive-parser collapse of PageText_GetByIds to returned == [item, LanguageAccess]. Page bodies are not here; pages.json holds the folder-sweep reconstruction.",
    responses: {},
    collapse: {
      auditReturned: p.audit.returned,
      byIdsCount: p.byIdsCount,
      byIdsTitles: p.byIdsTitles,
      byFolder: (p.byFolder ?? []).map((f) => ({ folderId: f.folderId, count: f.count, titles: f.titles ?? [] }))
    }
  };
  const pages = scale.pages;
  if (!Array.isArray(pages) || !pages.length) throw new Error("scale.json pages missing");
  files["collapse-scale.json"] = {
    provenance: "RECORDED: scale.json catalogueSize + pages[].parsedLength / itemTagsIncludingNested / productMarkers. Every recorded page collapsed to parsedLength 1. The 618-product SOAP is not stored — only the collapse counts.",
    responses: {},
    collapse: {
      catalogueSize: scale.catalogueSize,
      pages: pages.map((row) => ({
        pageSize: row.pageSize,
        parsedLength: row.parsedLength,
        itemTagsIncludingNested: row.itemTagsIncludingNested,
        productMarkers: row.productMarkers
      }))
    }
  };
}

// ---------------------------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------------------------
// `--check` is READ-ONLY. It used to call mkdirSync unconditionally, so the mode
// whose entire promise is "I only look" created a directory — harmless here and
// exactly the habit that makes a --check mode untrustworthy in CI.
if (!CHECK) mkdirSync(OUT, { recursive: true });
if (CHECK && !existsSync(OUT)) {
  console.error(`MISSING: ${path.relative(ROOT, OUT)} does not exist — run this script without --check first`);
  process.exit(1);
}

let drift = 0;
for (const [file, body] of Object.entries(files)) {
  const target = path.join(OUT, file);
  const text = JSON.stringify(body, null, 2) + "\n";
  const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (existing !== text) {
    drift++;
    if (CHECK) console.error(`DRIFT: ${path.relative(ROOT, target)}`);
    else writeFileSync(target, text);
  }
  console.log(`${CHECK ? "checked" : "wrote"} ${path.relative(ROOT, target)} (${Object.keys(body.responses).length} operations)`);
}

// ORPHANS. Comparing only the files the generator KNOWS about cannot see a pack
// that used to be generated and no longer is: it stays on disk, keeps being loaded
// by the test suite, and drifts from the probes with nothing checking it. That is
// a fixture presenting itself as recorded evidence while no longer being derived
// from any recording — the exact failure this two-layer pack exists to prevent.
const expected = new Set(Object.keys(files));
// Task 7 constructed GraphQL row pack — not SOAP, not generated from probes.
expected.add("blog-posts.json");
const onDisk = readdirSync(OUT).filter((f) => f.endsWith(".json"));
const orphans = onDisk.filter((f) => !expected.has(f));
for (const f of orphans) console.error(`ORPHAN: ${path.relative(ROOT, path.join(OUT, f))} is not produced by this generator — delete it, or restore the block that derived it`);

if (CHECK && (drift || orphans.length)) {
  if (drift) console.error(`${drift} fixture file(s) differ from the generator output`);
  if (orphans.length) console.error(`${orphans.length} orphaned fixture file(s)`);
  process.exit(1);
}
if (orphans.length) { console.error(`${orphans.length} orphaned fixture file(s) — not deleted automatically; a fixture is evidence, and deleting evidence is a decision`); process.exit(1); }
console.log(CHECK ? "fixtures match the generator" : "done");
