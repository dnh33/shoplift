/**
 * seed-real-xl.js — the `real-xl` tier. A strict SUPERSET of `real`: it runs
 * the whole "Example Living" shop first, then layers on the scale and the mess
 * that only shows up once a shop is genuinely eight years old and has had four
 * different people editing the catalogue.
 *
 * The bar for everything in here is NOT "does this break the pipeline" but
 * "can I tell a plausible story about how a real client's shop ended up like
 * this". Each block below names its story. Anything that failed that test was
 * left out (see the header of each section).
 *
 * Like `real`, unknown WooCommerce behaviours are PROBES, not assertions: they
 * are attempted live, the outcome is recorded as a verdict string in
 * `xl.probes`, and a rejection is never a hard failure. A seed that dies on the
 * fourth probe is useless — every risky creation is wrapped.
 *
 * Idempotent throughout: products/categories resolve by slug, orders by a
 * `_example_xl` marker, customers by email, coupons by code.
 */

import { seedReal, ensureProduct, ensureContent, ensureCategory, batchProducts, batchOrders } from "./seed-real.js";

const pad = (n, w = 4) => String(n).padStart(w, "0");

/**
 * Run `fn`, store a verdict string under `probes[key]`, never throw.
 * `verdict` reads the result — which may be a freshly-created row OR the row a
 * previous run created, since every creation goes through an ensure* helper.
 * That is deliberate: the verdict describes what WooCommerce STORED, so it
 * stays true on a re-run instead of degrading to "already seeded".
 */
async function probe(probes, key, fn, verdict = () => "ok") {
  try {
    const res = await fn();
    probes[key] = String(verdict(res));
    return res;
  } catch (e) {
    probes[key] = `rejected: ${e.data?.code || e.status || String(e.message).slice(0, 70)}`;
    return null;
  }
}

const trunc = (s, n = 90) => (s == null ? "null" : JSON.stringify(String(s)).slice(0, n));

// ---------- Danish address mess ----------
// Story: eight years of checkout forms, three of which did not validate.
// A missing postcode, a floor/door in address_1, and the same country's phone
// numbers written four different ways.
const XL_PHONES = ["+45 21 43 65 87", "21436587", "0045 21 43 65 87", "45-2143 6587", "tlf. 21 43 65 87"];
const XL_STREETS = [
  "Havnegade 12, 3. th",          // floor/door inside address_1
  "Skovbrynet 44",
  "Fiskergade 7, st. tv",
  "Vestergade 118, 2. sal, dør 4",
  "Møllevangen 3"
];
const XL_FIRST = ["Sofie", "Emil", "Frederikke", "Villads", "Astrid", "Malthe", "Karla", "Silas", "Josefine", "Alma"];
const XL_LAST = ["Nyborg", "Thomsen", "Vester", "Kruse", "Lindholm", "Bang", "Frost", "Riis"];

const xlAddr = (i, email, opts = {}) => {
  const noZip = opts.noPostcode ?? i % 11 === 4; // ~9% of rows lost their postcode
  return {
    first_name: XL_FIRST[i % XL_FIRST.length],
    last_name: i % 9 === 5 ? "" : XL_LAST[i % XL_LAST.length],
    ...(opts.company ? { company: opts.company } : {}),
    address_1: XL_STREETS[i % XL_STREETS.length],
    ...(i % 6 === 3 ? { address_2: "c/o Nyborg" } : {}),
    city: ["Aarhus C", "Silkeborg", "Esbjerg", "Hillerød", "Nykøbing F"][i % 5],
    postcode: noZip ? "" : ["8000", "8600", "6700", "3400", "4800"][i % 5],
    country: "DK",
    email,
    phone: XL_PHONES[i % XL_PHONES.length]
  };
};

// ---------- description shapes ----------
const descPlain = (t) => `<p>${t}</p>`;

// Story: a marketer pasted a tracking pixel / booking widget straight into the
// product description in 2021. Every agency-touched shop has at least one.
const descTrackingPixel = (t) => `<p>${t}</p>
<script>/* Facebook Pixel — indsat af bureauet, okt. 2021 */ !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};}(window,document);fbq('track','ViewContent');</script>
<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=000000000000000&ev=ViewContent"></noscript>`;

// Story: content copied out of the old shop, HTML-escaped once by the exporter
// and once again by the importer.
const descDoubleEncoded = (t) => `<p>${t}</p>
<p>Str&amp;amp;oslash;rrelse: 130 &amp;amp;times; 170 cm &amp;amp;ndash; 100&amp;amp;nbsp;% uld</p>
<p>Vask &amp;amp; pleje: se vejledningen &amp;amp;raquo;</p>`;

// Story: someone edited the HTML by hand in the classic editor and closed
// nothing. It has rendered "fine" in the theme for years.
const descUnclosed = (t) => `<div class="produkt-tekst"><p>${t}
<ul><li>100% dansk uld<li>Vævet i Danmark<li>Leveres i gavepose
<p><strong>Bemærk: <em>begrænset antal
<table><tr><td>Mål<td>130 × 170 cm`;

// Story: a page builder inlined the images as base64 instead of uploading them.
const GIF_1PX = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const descDataUri = (t) => `<p>${t}</p>
<figure><img src="data:image/gif;base64,${GIF_1PX}" alt="Farveprøve grå" width="1" height="1"></figure>
<figure><img src="data:image/gif;base64,${GIF_1PX}" alt="Farveprøve natur" width="1" height="1"></figure>`;

// Story: eight years of Divi/WPBakery revisions on the shop's flagship product,
// with the gallery inlined as base64. ~200 KB in one post_content field.
function hugeBuilderDescription() {
  const block = `[et_pb_section fb_built="1" _builder_version="4.9.4" custom_padding="0px||0px||true|false"][et_pb_row _builder_version="4.9.4"][et_pb_column type="4_4" _builder_version="4.9.4"][et_pb_text _builder_version="4.9.4" text_font="||||||||" header_font="||||||||"]<h3>Om Example Living</h3><p>Example Living blev grundlagt i 2018 omkring et køkkenbord i Aarhus. Vi vævede det første plaid selv, og i dag sender vi tekstiler, keramik og garn til hele Norden. Alle mål er cirka-mål og kan variere en anelse, fordi varerne er håndlavede.</p><img src="data:image/gif;base64,${GIF_1PX}" alt="stemningsbillede"/>[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]\n`;
  return block.repeat(Math.ceil(200000 / block.length));
}

// =====================================================================
export async function seedRealXl({ api, site, logger = () => {} }) {
  // ---------- the whole `real` shop first — real-xl is a strict superset ----------
  logger("real-xl: running the `real` tier first (superset base)");
  const base = await seedReal({ api, site, logger });

  const xl = { probes: {} };
  const p = xl.probes;
  const P = ensureProduct(api, logger);
  const C = ensureContent(api);

  // ============================================================
  // Phase X1 — categories (22 more; 6 levels deep, a case-only
  // collision, a name with a slash, and several left empty).
  // Story: three rounds of "let's restructure the shop", none finished.
  // ============================================================
  logger("xl: categories (22)");
  const catDefs = [
    // 6-level chain. Story: SEO consultant in 2022 wanted a page per material
    // property, and nobody ever collapsed it back.
    ["xl-oekologisk", "Økologisk", null, "Certificerede økologiske varer."],
    ["xl-oeko-tekstil", "Økologisk tekstil", "xl-oekologisk"],
    ["xl-oeko-uld", "Økologisk uld", "xl-oeko-tekstil"],
    ["xl-oeko-uld-merino", "Merino", "xl-oeko-uld"],
    ["xl-oeko-uld-merino-superwash", "Superwash", "xl-oeko-uld-merino"],
    ["xl-oeko-uld-merino-superwash-gots", "GOTS-certificeret", "xl-oeko-uld-merino-superwash"], // level 6
    // the long tail
    ["xl-udsalg", "Udsalg", null, "Restpartier og udgåede varer."],
    ["xl-udsalg-restpartier", "Restpartier", "xl-udsalg"],
    ["xl-nyheder", "Nyheder", null],
    ["xl-nyheder-2025", "Nyheder 2025", "xl-nyheder"],
    ["xl-nyheder-2026", "Nyheder 2026", "xl-nyheder"],             // EMPTY — made in advance
    ["xl-gaveideer", "Gaveidéer", null],
    ["xl-gaveideer-under-200", "Gaver under 200 kr.", "xl-gaveideer"],
    ["xl-gaveideer-over-1000", "Gaver over 1.000 kr.", "xl-gaveideer"], // EMPTY
    ["xl-boern", "Børn", null],
    ["xl-boern-vaerelse", "Børneværelset", "xl-boern"],            // EMPTY
    ["xl-badevaerelse", "Badeværelse", null],                      // EMPTY
    ["xl-have", "Have & terrasse", null],
    ["xl-have-udemoebler", "Udemøbler", "xl-have"],                // EMPTY
    ["xl-bolig-tilbehoer", "Bolig tilbehør", null],
    // Story: a category whose NAME has a slash — someone typed the breadcrumb
    // into the name field.
    ["xl-bolig-og-have", "Bolig / Have", null]
  ];
  const cat = {};
  for (const [slug, name, parent, description] of catDefs) {
    try {
      const c = await ensureCategory(api, {
        slug, name,
        ...(parent && cat[parent] ? { parent: cat[parent].id } : {}),
        ...(description ? { description } : {})
      });
      cat[slug] = c;
    } catch (e) {
      logger(`xl: category ${slug} failed — ${e.data?.code || e.message.slice(0, 60)}`);
    }
  }
  // 22nd category: differs from xl-bolig-tilbehoer ONLY by letter case.
  // Story: a CSV re-import in 2020 that did not lowercase its slugs.
  await probe(p, "categoryCaseCollision",
    () => ensureCategory(api, { slug: "XL-Bolig-Tilbehoer", name: "BOLIG TILBEHØR" }),
    (c) => (c.slug === "xl-bolig-tilbehoer"
      ? "collapsed onto the existing lowercase term (same id)"
      : `stored as a separate term, slug=${c.slug}`));

  p.deepCategoryLevel6 = cat["xl-oeko-uld-merino-superwash-gots"]
    ? `6-level chain created (leaf id ${cat["xl-oeko-uld-merino-superwash-gots"].id})`
    : "6-level chain NOT created";
  p.categorySlashName = cat["xl-bolig-og-have"]
    ? `name=${trunc(cat["xl-bolig-og-have"].name)} slug=${cat["xl-bolig-og-have"].slug}`
    : "not created";

  xl.categories = Object.keys(cat).length + (p.categoryCaseCollision.startsWith("rejected") ? 0 : 1);
  const catId = (s) => cat[s]?.id;
  const inCats = (...slugs) => ({ categories: slugs.map(catId).filter(Boolean).map((id) => ({ id })) });

  // ============================================================
  // Phase X2 — the long tail: 200 batch products.
  // This is where the *ordinary* mess lives: status spread, orphans,
  // stale sale prices, inconsistent attribute names, partial SEO,
  // no images at all, and dates spread over eight years.
  // ============================================================
  const XL_COLORS = ["Natur", "Grå", "Støvet Blå", "Ærtegrøn", "Karry", "Rødbrun", "Sort", "Sennep", "Terrakotta", "Havblå"];
  const XL_NOUNS = [
    ["Plaid", ["xl-udsalg-restpartier", "xl-oeko-uld"], 449],
    ["Pude", ["xl-udsalg-restpartier", "xl-bolig-tilbehoer"], 249],
    ["Nøgle Uldgarn", ["xl-udsalg-restpartier", "xl-oeko-uld-merino"], 59],
    ["Krus", ["xl-udsalg-restpartier", "xl-gaveideer-under-200"], 129],
    ["Lysestage", ["xl-udsalg-restpartier", "xl-nyheder-2025"], 199],
    ["Kurv", ["xl-udsalg-restpartier", "xl-bolig-og-have"], 279],
    ["Duge", ["xl-udsalg-restpartier", "xl-oeko-tekstil"], 349],
    ["Løber", ["xl-udsalg-restpartier", "xl-have"], 399]
  ];
  // Story: four people, four spellings, one concept. This is what actually
  // drives option/collection mapping in a migration.
  const ATTR_NAMES = ["Farve", "farve", "Colour", "COLOR", "Farve "];

  const BULK = 200;
  const sentinel = await api("GET", "wc/v3/products?sku=XL-0001&status=any");
  if (!sentinel.length) {
    logger(`xl: long-tail catalogue (${BULK} products)`);
    const gen = Array.from({ length: BULK }, (_, i) => {
      const [noun, cats, basePrice] = XL_NOUNS[i % XL_NOUNS.length];
      const color = XL_COLORS[i % XL_COLORS.length];
      const price = basePrice + (i % 9) * 10;
      const year = 2018 + (i % 8);                       // eight years of catalogue
      // status spread — not everything is published. Story: abandoned drafts,
      // staff-only items, and one batch scheduled for a campaign that never ran.
      const status = i % 17 === 16 ? "draft"
        : i % 29 === 28 ? "private"
        : i % 43 === 42 ? "future"
        : "publish";
      // stale sale: a 2021 campaign whose sale_price was never removed
      const staleSale = i % 7 === 2;
      const orphan = i % 13 === 7;                        // no category at all
      const discontinued = i % 19 === 11;                 // still published, still orderable
      return {
        name: `${noun} ${color} ${discontinued ? "(udgået) " : ""}No. ${pad(i + 1)}`,
        slug: `xl-vare-${pad(i + 1)}`,
        type: "simple",
        status,
        // `future` needs a date ahead of now or WP silently publishes it
        ...(status === "future"
          ? { date_created: `${new Date().getFullYear() + 1}-03-01T09:00:00` }
          : { date_created: `${year}-${pad((i % 12) + 1, 2)}-${pad((i % 27) + 1, 2)}T10:${pad(i % 60, 2)}:00` }),
        sku: `XL-${pad(i + 1)}`,
        regular_price: String(price),
        ...(staleSale ? {
          sale_price: String(price - 40),
          date_on_sale_from: "2021-11-15T00:00:00",
          date_on_sale_to: "2021-12-05T23:59:59"     // ended years ago, never cleared
        } : {}),
        manage_stock: i % 8 !== 0,
        stock_quantity: discontinued ? 0 : (i * 7) % 55,
        ...(discontinued ? { stock_status: "instock", backorders: "yes" } : {}), // still orderable
        weight: String(0.1 + (i % 9) / 10),
        // Story: the oldest half of the catalogue has NO image at all — the
        // photos lived on a CDN that was cancelled, or were never uploaded.
        description: descPlain(`${noun} i farven ${color.toLowerCase()}. Del af Example Livings sortiment siden ${year}.`),
        short_description: `<p>${noun}, ${color.toLowerCase()}.</p>`,
        // inconsistent attribute naming for one and the same concept
        attributes: [{ name: ATTR_NAMES[i % ATTR_NAMES.length], visible: true, variation: false, options: [color] }],
        ...(orphan ? {} : { categories: cats.map(catId).filter(Boolean).map((id) => ({ id })) }),
        // partial SEO: a handful have Yoast fields, the vast majority none
        ...(i % 12 === 0 ? {
          meta_data: [
            { key: "_yoast_wpseo_title", value: `${noun} ${color} | Example Living` },
            { key: "_yoast_wpseo_metadesc", value: `Køb ${noun.toLowerCase()} i ${color.toLowerCase()} hos Example Living. Fri fragt over 499 kr.` },
            { key: "_yoast_wpseo_focuskw", value: `${noun.toLowerCase()} ${color.toLowerCase()}` }
          ]
        } : {})
      };
    });
    try {
      xl.bulkProducts = (await batchProducts(api, logger, gen, "xl long tail")).length;
    } catch (e) {
      xl.bulkProducts = 0;
      p.bulkBatch = `rejected: ${e.data?.code || e.message.slice(0, 70)}`;
      logger(`xl: long-tail batch failed — ${String(e.message).slice(0, 120)}`);
    }
    p.orphanProducts = `${gen.filter((g) => !g.categories).length} products created with no category`;
    p.noImageProducts = `${gen.length} long-tail products created with no image at all`;
    p.staleSaleProducts = `${gen.filter((g) => g.sale_price).length} products carry a sale_price whose date_on_sale_to is 2021`;
    p.statusSpread = Object.entries(gen.reduce((a, g) => ({ ...a, [g.status]: (a[g.status] || 0) + 1 }), {}))
      .map(([k, v]) => `${k}=${v}`).join(", ");
    p.attributeNameSpread = ATTR_NAMES.map((n) => JSON.stringify(n)).join(" / ");
  } else {
    xl.bulkProducts = BULK;
    logger("xl: long-tail catalogue already seeded");
  }

  // verdicts that must be read back from the store, not from the payload
  await probe(p, "scheduledProductStatus",
    async () => (await api("GET", "wc/v3/products?slug=xl-vare-0043&status=any"))[0] || { status: "not-found" },
    (r) => `slug xl-vare-0043 requested status=future, stored status=${r.status}`);
  await probe(p, "staleSalePrice",
    async () => (await api("GET", "wc/v3/products?slug=xl-vare-0003&status=any"))[0] || {},
    (r) => `sale_price=${trunc(r.sale_price, 20)} on_sale=${r.on_sale} date_on_sale_to=${trunc(r.date_on_sale_to, 30)}`);

  // ============================================================
  // Phase X3 — quirk singles (32). Every one has a story; each risky
  // creation is a probe.
  // ============================================================
  logger("xl: quirk singles");
  let quirk = 0;
  const single = async (payload) => { const r = await P(payload); quirk++; return r; };

  // --- X3.1 variant explosion: 8 farver × 5 nøglestørrelser × 3 materialer = 120
  // Story: completely ordinary for a yarn shop. Also sits exactly at Shopify's
  // per-product variant ceiling, which is the point.
  logger("xl: 120-variant yarn product");
  const VC = ["Natur", "Grå", "Støvet Blå", "Ærtegrøn", "Karry", "Rødbrun", "Sort", "Sennep"];
  const VS = ["25 g", "50 g", "100 g", "150 g", "200 g"];
  const VM = ["Merino", "Alpaka", "Merino/Silke"];
  await probe(p, "variantExplosion", async () => {
    const parent = await single({
      name: "Example Basisgarn — alle farver og størrelser",
      slug: "xl-basisgarn-alle-varianter", type: "variable", status: "publish",
      description: descPlain("Vores basisgarn i hele programmet. Vælg farve, nøglestørrelse og materiale."),
      attributes: [
        { name: "Farve", visible: true, variation: true, options: VC },
        { name: "Størrelse", visible: true, variation: true, options: VS },
        { name: "Materiale", visible: true, variation: true, options: VM }
      ],
      ...inCats("xl-oeko-uld-merino", "xl-oeko-uld")
    });
    // count what is already there before creating anything (idempotency)
    const countVariations = async () => {
      let n = 0;
      for (let page = 1; ; page++) {
        const rows = await api("GET", `wc/v3/products/${parent.id}/variations?per_page=100&page=${page}`);
        n += rows.length;
        if (rows.length < 100) break;
      }
      return n;
    };
    let have = await countVariations();
    if (have < VC.length * VS.length * VM.length) {
      const want = [];
      let k = 0;
      for (const c of VC) for (const s of VS) for (const m of VM) {
        want.push({
          sku: `XLV-${pad(++k, 3)}`,
          regular_price: String(39 + VS.indexOf(s) * 25 + VM.indexOf(m) * 15),
          manage_stock: true, stock_quantity: (k * 3) % 30,
          attributes: [{ name: "Farve", option: c }, { name: "Størrelse", option: s }, { name: "Materiale", option: m }]
        });
      }
      // Woo's batch endpoint caps at 100 items per request by default
      for (let i = have; i < want.length; i += 40) {
        await api("POST", `wc/v3/products/${parent.id}/variations/batch`, { create: want.slice(i, i + 40) });
        logger(`xl: variations ${Math.min(i + 40, want.length)}/${want.length}`);
      }
      have = await countVariations();
    }
    xl.variantExplosion = { requested: VC.length * VS.length * VM.length, stored: have };
    return have;
  }, (n) => `requested ${VC.length * VS.length * VM.length}, WooCommerce stored ${n}`);

  // --- X3.2 unicode. Every one of these arrived by copy/paste from somewhere.
  logger("xl: unicode gauntlet");

  // Story: the 2024 Christmas campaign. Emoji in product titles is normal now.
  await probe(p, "unicodeEmojiTitle",
    () => single({
      name: "🎁 Julegave: Uldplaid & Krus i gaveæske ✨", slug: "xl-julegave-gavesaet",
      type: "simple", status: "publish", sku: "XL-JUL-2024", regular_price: "649",
      description: descPlain("Årets julegave — plaid og krus samlet i én gaveæske."),
      date_created: "2024-11-04T08:30:00", ...inCats("xl-gaveideer", "xl-gaveideer-over-1000")
    }),
    (r) => (/\p{Extended_Pictographic}/u.test(r.name || "")
      ? `emoji preserved: ${trunc(r.name)}`
      : `emoji stripped, stored ${trunc(r.name)}`));

  // Story: the title was pasted out of Word, which brought a U+200B along.
  await probe(p, "unicodeZeroWidthSpace",
    () => single({
      name: "Pudebetræk​Hør Natur 50×50", slug: "xl-pudebetraek-hoer-natur",
      type: "simple", status: "publish", sku: "XL-PUDE-HOER-50", regular_price: "229",
      description: descPlain("Pudebetræk i vasket hør."), ...inCats("xl-oeko-tekstil")
    }),
    (r) => (String(r.name).includes("​")
      ? `U+200B preserved (title length ${String(r.name).length}), slug=${r.slug}`
      : `U+200B stripped (title length ${String(r.name).length}), slug=${r.slug}`));

  // Story: the importer's product sheet came from the manufacturer and the
  // original Arabic title was pasted into the name field alongside the Danish.
  await probe(p, "unicodeRtlTitle",
    () => single({
      name: "بطانية صوف — Uldplaid (leverandørens originaltitel)", slug: "xl-rtl-leverandoertitel",
      type: "simple", status: "publish", sku: "XL-RTL-0001", regular_price: "529",
      description: descPlain("Importeret plaid — leverandørens originaltitel er bevaret i varenavnet."),
      ...inCats("xl-udsalg-restpartier")
    }),
    (r) => `stored name=${trunc(r.name)} slug=${trunc(r.slug, 60)}`);

  // Story: also a Word paste — "café" as "cafe" + U+0301 rather than U+00E9.
  await probe(p, "unicodeCombiningDiacritics",
    () => single({
      name: "Cafékrus Mat Sort 30 cl", slug: "xl-cafekrus-mat-sort",
      type: "simple", status: "publish", sku: "XL-KRUS-30CL", regular_price: "139",
      description: descPlain("Mat sort krus til morgenkaffen."), ...inCats("xl-gaveideer-under-200")
    }),
    (r) => (String(r.name).includes("́")
      ? "combining acute U+0301 preserved (decomposed form stored)"
      : String(r.name).includes("é")
        ? "normalized to precomposed é (U+00E9)"
        : `mark lost entirely: ${trunc(r.name)}`));

  // Story (revised): NOT an emoji in a SKU — that had no plausible origin.
  // This is a supplier reference pasted out of a PDF price list, which brought
  // a non-breaking space and a U+2044 fraction slash with it.
  await probe(p, "supplierRefSku",
    () => single({
      name: "Uldplaid Herringbone (leverandørvare)", slug: "xl-leverandoervare-herringbone",
      type: "simple", status: "publish",
      sku: "LEV.NR. 44-892⁄A", regular_price: "699",
      description: descPlain("Indkøbt hos ekstern leverandør — varenummeret er deres."),
      ...inCats("xl-udsalg-restpartier")
    }),
    (r) => `stored sku=${trunc(r.sku)}`);

  // --- X3.3 oversized fields
  logger("xl: oversized fields");

  // Story: someone pasted the whole product description into the title field
  // and only fixed the front page.
  const longTitle = "Håndvævet Uldplaid Med Rullede Kanter Og Broderet Monogram Fra Example Living I Aarhus Danmark Leveres I Gavepose Med Plejevejledning "
    .repeat(3).slice(0, 312).trim();
  await probe(p, "longTitle",
    () => single({
      name: longTitle, slug: "xl-lang-titel", type: "simple", status: "publish",
      sku: "XL-LANGTITEL", regular_price: "899",
      description: descPlain("Plaid med broderet monogram."), ...inCats("xl-udsalg-restpartier")
    }),
    (r) => (String(r.name).length >= longTitle.length
      ? `stored verbatim (${String(r.name).length} chars, sent ${longTitle.length})`
      : `truncated to ${String(r.name).length} chars (sent ${longTitle.length})`));

  // Story: eight years of page-builder revisions with base64 images inlined.
  const huge = hugeBuilderDescription();
  await probe(p, "hugeDescription",
    () => single({
      name: "Example Signaturplaid (flagskib)", slug: "xl-signaturplaid",
      type: "simple", status: "publish", sku: "XL-SIGNATUR", regular_price: "1299",
      description: huge, short_description: "<p>Vores flagskib siden 2018.</p>",
      date_created: "2018-04-02T09:00:00", ...inCats("xl-oeko-uld", "xl-nyheder")
    }),
    (r) => `sent ${huge.length} chars, stored ${String(r.description || "").length} chars`);

  // Story: supplier number + EAN + variant code concatenated by an old importer.
  const longSku = "XL-" + "BROHAVE-LIVING-RESTPARTI-LEVERANDOER-".repeat(2) + "5701234000123-VAR01";
  await probe(p, "longSku",
    () => single({
      name: "Restparti Uldplaid Blandet", slug: "xl-restparti-blandet",
      type: "simple", status: "publish", sku: longSku, regular_price: "299",
      description: descPlain("Restparti — blandede farver."), ...inCats("xl-udsalg-restpartier")
    }),
    (r) => (String(r.sku).length >= longSku.length
      ? `stored verbatim (${String(r.sku).length} chars, sent ${longSku.length})`
      : `truncated/rewritten to ${String(r.sku).length} chars: ${trunc(r.sku, 60)}`));

  // --- X3.4 price extremes
  logger("xl: price extremes");

  // Story: garn sold by the gram; the per-gram price was entered as the price.
  await probe(p, "priceSubCent",
    () => single({
      name: "Uldgarn — pris pr. gram", slug: "xl-pris-pr-gram", type: "simple", status: "publish",
      sku: "XL-PRIS-GRAM", regular_price: "0.001",
      description: descPlain("Sælges i løs vægt. Prisen er pr. gram."), ...inCats("xl-oeko-uld")
    }),
    (r) => `regular_price=${trunc(r.regular_price, 20)} price=${trunc(r.price, 20)}`);

  // Story: a supplier feed in EUR converted to DKK at four decimals.
  await probe(p, "priceFourDecimals",
    () => single({
      name: "Importeret Alpakaplaid (feed-pris)", slug: "xl-feed-pris-alpaka",
      type: "simple", status: "publish", sku: "XL-FEED-ALPAKA", regular_price: "1234.5678",
      description: descPlain("Pris hentet automatisk fra leverandørens feed."), ...inCats("xl-udsalg-restpartier")
    }),
    (r) => `regular_price=${trunc(r.regular_price, 20)} price=${trunc(r.price, 20)}`);

  // Story: the "do not sell this" placeholder price every shop has.
  await probe(p, "priceHuge",
    () => single({
      name: "Udstillingsmodel — ikke til salg", slug: "xl-udstillingsmodel",
      type: "simple", status: "publish", sku: "XL-UDSTILLING", regular_price: "9999999.99",
      description: descPlain("Udstillingsmodel. Kontakt butikken."), ...inCats("xl-udsalg-restpartier")
    }),
    (r) => `regular_price=${trunc(r.regular_price, 24)} price=${trunc(r.price, 24)}`);

  // --- X3.5 HTML nasties
  logger("xl: HTML nasties");
  await probe(p, "htmlDoubleEncoded",
    () => single({
      name: "Plaid Fiskeben Grå 130 × 170", slug: "xl-html-dobbeltkodet",
      type: "simple", status: "publish", sku: "XL-HTML-DBL", regular_price: "579",
      description: descDoubleEncoded("Klassisk fiskebensplaid."), ...inCats("xl-oeko-uld")
    }),
    (r) => (String(r.description).includes("&amp;amp;")
      ? "double-encoded entities stored verbatim (&amp;amp; survives)"
      : "entities collapsed on store"));

  await probe(p, "htmlUnclosedTags",
    () => single({
      name: "Vævet Løber Natur 40 × 140", slug: "xl-html-uafsluttet",
      type: "simple", status: "publish", sku: "XL-HTML-OPEN", regular_price: "399",
      description: descUnclosed("Vævet løber i naturhør."), ...inCats("xl-oeko-tekstil")
    }),
    (r) => `stored ${String(r.description || "").length} chars; </div> present=${String(r.description || "").includes("</div>")}`);

  await probe(p, "htmlScriptBlock",
    () => single({
      name: "Sengeplaid Quiltet Sennep", slug: "xl-html-tracking-pixel",
      type: "simple", status: "publish", sku: "XL-HTML-PIXEL", regular_price: "749",
      description: descTrackingPixel("Quiltet sengeplaid i sennepsgul."), ...inCats("xl-oeko-tekstil")
    }),
    (r) => (String(r.description || "").includes("<script")
      ? "inline <script> stored verbatim (author has unfiltered_html)"
      : "inline <script> stripped by kses"));

  await probe(p, "htmlDataUriImage",
    () => single({
      name: "Farvekort Uldgarn 2023", slug: "xl-html-data-uri",
      type: "simple", status: "publish", sku: "XL-HTML-DATAURI", regular_price: "49",
      description: descDataUri("Farvekort med alle årets garnfarver."), ...inCats("xl-oeko-uld")
    }),
    (r) => (String(r.description || "").includes("data:image/gif;base64")
      ? "data: URI images stored verbatim in the description"
      : "data: URI images stripped"));

  // --- X3.6 broken media. Story: the CDN contract lapsed in 2024.
  logger("xl: broken media");
  await probe(p, "image404",
    () => single({
      name: "Keramikskål Røget Eg 22 cm", slug: "xl-billede-404",
      type: "simple", status: "publish", sku: "XL-IMG-404", regular_price: "329",
      description: descPlain("Drejet keramikskål."),
      images: [{ src: "https://cdn-nedlagt.example.dk/2019/produkt/skaal-roeget-eg.jpg", alt: "Keramikskål" }],
      ...inCats("xl-bolig-tilbehoer")
    }),
    (r) => (r.images?.length
      ? `image accepted by Woo (${r.images.length} attached: ${trunc(r.images[0].src, 70)})`
      : "image rejected — ensureProduct re-created the product without it"));

  await probe(p, "imageQueryString",
    () => single({
      name: "Keramikkande Sart Grøn 1 l", slug: "xl-billede-querystring",
      type: "simple", status: "publish", sku: "XL-IMG-QS", regular_price: "389",
      description: descPlain("Drejet kande med hank."),
      images: [{ src: "https://picsum.photos/id/1025/600/400.jpg?v=3&cachebust=2021", alt: "Keramikkande" }],
      ...inCats("xl-bolig-tilbehoer")
    }),
    (r) => (r.images?.length
      ? `image accepted, stored src=${trunc(r.images[0].src, 90)}`
      : "image rejected — created without it"));

  // --- X3.7 reserved-path slugs. Story: someone built landing pages as
  // products so they would show up in the shop menu. On Shopify these collide
  // with reserved routes, so the generated redirects are the interesting part.
  logger("xl: reserved-path slugs");
  const reserved = [
    ["cart", "Kurvens indhold — se dine varer", "XL-LP-KURV"],
    ["products", "Alle produkter — samlet oversigt", "XL-LP-ALLE"],
    ["admin", "Forhandlerlogin (kun for erhverv)", "XL-LP-ADMIN"],
    ["account", "Min konto — opret bruger", "XL-LP-KONTO"]
  ];
  const reservedVerdicts = [];
  for (const [slug, name, sku] of reserved) {
    const r = await probe(p, `_reserved_${slug}`,
      () => single({
        name, slug, type: "simple", status: "publish", sku, regular_price: "0",
        description: descPlain(`Landingsside oprettet som produkt i 2020 (${slug}).`),
        catalog_visibility: "hidden", ...inCats("xl-bolig-tilbehoer")
      }),
      (x) => `${slug}->${x.slug}`);
    reservedVerdicts.push(r ? `${slug}->${r.slug}` : `${slug}->${p[`_reserved_${slug}`]}`);
    delete p[`_reserved_${slug}`];
  }
  p.reservedSlugs = reservedVerdicts.join("; ");

  // --- X3.8 stock oddities
  logger("xl: stock oddities");

  // Story: oversold during the Black Friday rush; Woo went negative.
  await probe(p, "negativeStock",
    () => single({
      name: "Uldplaid Karry 130 × 170 (oversolgt)", slug: "xl-negativ-lager",
      type: "simple", status: "publish", sku: "XL-LAGER-NEG", regular_price: "599",
      manage_stock: true, stock_quantity: -6, backorders: "yes", stock_status: "onbackorder",
      description: descPlain("Populær farve — flere på vej fra væveriet."), ...inCats("xl-oeko-uld")
    }),
    (r) => `stock_quantity=${r.stock_quantity} stock_status=${r.stock_status} backorders=${r.backorders}`);

  // Story: made to order, so backorders are simply how it is sold.
  await probe(p, "backordersAllowed",
    () => single({
      name: "Specialvævet Løber (efter mål)", slug: "xl-restordre-tilladt",
      type: "simple", status: "publish", sku: "XL-LAGER-BO", regular_price: "1199",
      manage_stock: true, stock_quantity: 0, backorders: "notify", stock_status: "onbackorder",
      description: descPlain("Væves efter mål — 4-6 ugers leveringstid."), ...inCats("xl-oeko-tekstil")
    }),
    (r) => `stock_quantity=${r.stock_quantity} backorders=${r.backorders} stock_status=${r.stock_status}`);

  // Story: stock is tracked per size, not on the parent. Ordinary for apparel.
  await probe(p, "variantLevelStock", async () => {
    const parent = await single({
      name: "Uldsokker Example (str. 36-46)", slug: "xl-lager-paa-variant",
      type: "variable", status: "publish", manage_stock: false,
      description: descPlain("Uldsokker — lagerstyres pr. størrelse."),
      attributes: [{ name: "Størrelse", visible: true, variation: true, options: ["36-38", "39-42", "43-46"] }],
      ...inCats("xl-oeko-uld-merino")
    });
    const have = await api("GET", `wc/v3/products/${parent.id}/variations?per_page=10`);
    if (!have.length) {
      await api("POST", `wc/v3/products/${parent.id}/variations/batch`, {
        create: ["36-38", "39-42", "43-46"].map((s, k) => ({
          sku: `XL-SOK-${s.replace("-", "")}`, regular_price: "129",
          manage_stock: true, stock_quantity: [0, 14, 3][k],
          attributes: [{ name: "Størrelse", option: s }]
        }))
      });
    }
    const after = await api("GET", `wc/v3/products/${parent.id}/variations?per_page=10`);
    const full = await api("GET", `wc/v3/products/${parent.id}`);
    return { parentManages: full.manage_stock, n: after.length, managed: after.filter((v) => v.manage_stock).length };
  }, (r) => `parent manage_stock=${r.parentManages}, ${r.managed}/${r.n} variations manage their own stock`);

  // --- X3.9 duplicate listings. Story: two staff members listed the same
  // physical plaid within a week of each other in 2022. Nobody merged them.
  logger("xl: duplicate listings");
  await probe(p, "duplicateListingA",
    () => single({
      name: "Uldplaid Grå 130x170", slug: "xl-dublet-listing-a",
      type: "simple", status: "publish", sku: "XL-DUP-4471", regular_price: "599",
      date_created: "2022-03-14T11:20:00",
      description: descPlain("Uldplaid grå, 130x170 cm."), ...inCats("xl-oeko-uld")
    }),
    (r) => `sku=${trunc(r.sku, 30)} id=${r.id}`);
  await probe(p, "duplicateListingB",
    () => single({
      name: "Plaid, uld, grå, 130 x 170 cm", slug: "xl-dublet-listing-b",
      type: "simple", status: "publish", sku: "XL-DUP-4471-KOPI", regular_price: "589",
      date_created: "2022-03-21T09:05:00",
      description: descPlain("Plaid i uld. Grå. 130 x 170 cm."), ...inCats("xl-oeko-uld", "xl-udsalg-restpartier")
    }),
    (r) => `near-duplicate of A, sku=${trunc(r.sku, 30)} id=${r.id}`);
  // the third listing reuses the EXACT same SKU — does the API allow it?
  await probe(p, "duplicateListingExactSku", async () => {
    const pre = await api("GET", "wc/v3/products?slug=xl-dublet-listing-c&status=any");
    if (pre[0]) return { pre: true, sku: pre[0].sku };
    const r = await api("POST", "wc/v3/products", {
      name: "UldPlaid grå 130X170 (webshop)", slug: "xl-dublet-listing-c",
      type: "simple", status: "publish", sku: "XL-DUP-4471", regular_price: "609",
      description: descPlain("Uldplaid grå."), ...inCats("xl-oeko-uld")
    });
    quirk++;
    return { pre: false, sku: r.sku };
  }, (r) => (r.pre
    ? `already seeded, stored sku=${trunc(r.sku, 30)}`
    : r.sku === "XL-DUP-4471" ? "accepted — three live products share one SKU" : `rewritten to ${trunc(r.sku, 30)}`));

  // --- X3.10 discontinued but still published and orderable
  await probe(p, "discontinuedStillOrderable",
    () => single({
      name: "Uldplaid Petrol (UDGÅET — sælges så længe lager haves)", slug: "xl-udgaaet-men-koebbar",
      type: "simple", status: "publish", sku: "XL-UDGAAET-01", regular_price: "499",
      manage_stock: true, stock_quantity: 0, backorders: "yes", stock_status: "instock",
      description: descPlain("Farven udgår. Vi sælger de sidste eksemplarer."), ...inCats("xl-udsalg-restpartier")
    }),
    (r) => `status=${r.status} stock_status=${r.stock_status} stock_quantity=${r.stock_quantity} purchasable=${r.purchasable}`);

  // --- X3.11 an explicitly orphaned product (no category at all)
  await probe(p, "orphanProductSingle",
    () => single({
      name: "Prøvekasse Blandede Rester", slug: "xl-forældreloes-vare",
      type: "simple", status: "publish", sku: "XL-ORPHAN-01", regular_price: "149",
      description: descPlain("Blandet kasse med restestof og garn.")
    }),
    (r) => `categories=${(r.categories || []).length}`);

  xl.quirkProducts = quirk;

  // ============================================================
  // Phase X4 — customers (50 more; 90 total).
  // Story: the checkout never normalised anything.
  // ============================================================
  logger("xl: customers (50)");
  const custPayload = Array.from({ length: 47 }, (_, i) => {
    const first = XL_FIRST[i % XL_FIRST.length];
    const last = XL_LAST[i % XL_LAST.length];
    const email = `xl.${first.toLowerCase()}.${last.toLowerCase()}${i}@example.dk`;
    return {
      email, first_name: first,
      last_name: i % 9 === 5 ? "" : last,          // empty last names in the wild
      billing: xlAddr(i, email), shipping: xlAddr(i + 2, email)
    };
  });
  let createdCust = 0;
  for (let i = 0; i < custPayload.length; i += 20) {
    const res = await api("POST", "wc/v3/customers/batch", { create: custPayload.slice(i, i + 20) }).catch(() => ({ create: [] }));
    createdCust += (res.create || []).filter((c) => c.id).length;
    logger(`xl: customers ${Math.min(i + 20, custPayload.length)}/${custPayload.length}`);
  }

  const findCustomer = async (email) => (await api("GET", `wc/v3/customers?email=${encodeURIComponent(email)}&role=all`).catch(() => []))[0];

  // Story: the same person checked out twice, once with caps lock half on.
  await probe(p, "customerEmailCaseCollision", async () => {
    const variant = "XL.Sofie.Nyborg0@Example.DK";
    const pre = await findCustomer(variant);
    if (pre) return { pre: true, email: pre.email };
    const r = await api("POST", "wc/v3/customers", {
      email: variant, first_name: "Sofie", last_name: "Nyborg",
      billing: xlAddr(0, variant), shipping: xlAddr(0, variant)
    });
    createdCust++;
    return { pre: false, email: r.email };
  }, (r) => (r.pre
    ? `already present as ${trunc(r.email, 50)}`
    : `accepted alongside the lowercase address, stored ${trunc(r.email, 50)}`));

  // Story: a Gmail user tagging the shop. Utterly ordinary.
  await probe(p, "customerPlusTag", async () => {
    const email = "example+webshop@example.dk";
    const pre = await findCustomer(email);
    if (pre) return pre;
    const r = await api("POST", "wc/v3/customers", {
      email, first_name: "Katrine", last_name: "Bang",
      billing: xlAddr(3, email), shipping: xlAddr(3, email)
    });
    createdCust++;
    return r;
  }, (r) => `stored email=${trunc(r.email, 50)}`);

  // Story: the name field was one box for years, so the surname is empty.
  await probe(p, "customerEmptyLastName", async () => {
    const email = "xl.kun.fornavn@example.dk";
    const pre = await findCustomer(email);
    if (pre) return pre;
    const r = await api("POST", "wc/v3/customers", {
      email, first_name: "Bjarke", last_name: "",
      billing: { ...xlAddr(6, email), last_name: "", postcode: "" }, // also lost its postcode
      shipping: { ...xlAddr(6, email), last_name: "" }
    });
    createdCust++;
    return r;
  }, (r) => `last_name=${trunc(r.last_name, 12)} billing.postcode=${trunc(r.billing?.postcode, 12)}`);

  xl.customers = createdCust;

  // ============================================================
  // Phase X5 — coupons (4 more).
  // ============================================================
  logger("xl: coupons");
  const couponProbe = async (key, def, verdict) => probe(p, key, async () => {
    const pre = await api("GET", `wc/v3/coupons?code=${encodeURIComponent(def.code.toLowerCase())}`).catch(() => []);
    if (pre[0]) return { pre: true, c: pre[0] };
    return { pre: false, c: await api("POST", "wc/v3/coupons", def) };
  }, ({ pre, c }) => `${pre ? "already seeded; " : ""}${verdict(c)}`);

  // Story: a staff/press code that gives the product away.
  await couponProbe("coupon100Percent",
    { code: "PRESSE100", discount_type: "percent", amount: "100", description: "Pressekode — 100% rabat", usage_limit: 20 },
    (c) => `amount=${trunc(c.amount, 12)} type=${c.discount_type}`);

  // Story: a launch code that sold out. usage_count is read-only in Woo's REST
  // schema, so this probe records whether the API let us pre-set it.
  await couponProbe("couponUsageExhausted",
    { code: "LANCERING50", discount_type: "fixed_cart", amount: "50", usage_limit: 1, usage_count: 1, date_expires: "2022-02-28T23:59:59" },
    (c) => `usage_limit=${c.usage_limit} usage_count=${c.usage_count} (sent usage_count=1)`);

  // Story: printed on a flyer in caps, typed into the shop in lowercase.
  await couponProbe("couponCaseA",
    { code: "BROHAVE20", discount_type: "percent", amount: "20" },
    (c) => `stored code=${trunc(c.code, 24)}`);
  await couponProbe("couponCaseCollision",
    { code: "example20", discount_type: "percent", amount: "25" },
    (c) => `stored code=${trunc(c.code, 24)} amount=${trunc(c.amount, 12)}`);
  xl.coupons = 4;

  // ============================================================
  // Phase X6 — orders (15 more; ~70-75 total).
  // Orders are the rate-limit-expensive axis on import, so this stays small
  // and every one of the 15 earns its place: the status spread real exports
  // are actually full of, defunct gateways from 2018, a wholesale order with
  // 30+ lines, a fee-only invoice, a future date, a zero total, and a guest
  // whose customer record was deleted afterwards.
  // ============================================================
  logger("xl: orders (15)");

  // line-item pool: everything filed under Restpartier, in one request
  const poolCat = catId("xl-udsalg-restpartier");
  const poolRows = poolCat
    ? await api("GET", `wc/v3/products?category=${poolCat}&per_page=40&status=publish`).catch(() => [])
    : [];
  const pool = poolRows.map((r) => r.id).filter(Boolean);
  const zeroPrice = (await api("GET", "wc/v3/products?slug=vareproeve-garnkort&status=any").catch(() => []))[0];

  // existing markers -> skip
  const allOrders = [];
  for (let page = 1; ; page++) {
    const rows = await api("GET", `wc/v3/orders?per_page=100&page=${page}&status=any`).catch(() => []);
    allOrders.push(...rows);
    if (rows.length < 100) break;
  }
  const seen = new Set(allOrders.flatMap((o) => (o.meta_data || []).filter((m) => m.key === "_example_xl").map((m) => m.value)));

  const nextYear = new Date().getFullYear() + 1;
  const line = (i, qty = 1) => ({ product_id: pool[i % (pool.length || 1)], quantity: qty });

  // Story: gateways that no longer exist. DIBS was folded into Nets, ePay
  // became Bambora then Worldline, and the shop still has orders from all of
  // them sitting next to last month's MobilePay.
  const mk = (i, marker, o) => {
    const email = o.email || `xl.gaest${i}@${["gmail.com", "hotmail.com", "live.dk"][i % 3]}`;
    return {
      status: o.status,
      set_paid: o.set_paid ?? ["completed", "processing", "refunded"].includes(o.status),
      billing: o.billing === null ? undefined : { ...xlAddr(i, email, o.addrOpts || {}) },
      ...(o.noShipping ? {} : { shipping: xlAddr(i + 1, email) }),
      ...(o.customer_id ? { customer_id: o.customer_id } : {}),
      line_items: o.line_items ?? [line(i, 1 + (i % 3))],
      ...(o.fee_lines ? { fee_lines: o.fee_lines } : {}),
      ...(o.date_created ? { date_created: o.date_created } : {}),
      ...(o.shipping_lines ? { shipping_lines: o.shipping_lines } : {}),
      payment_method: o.payment_method || "quickpay",
      payment_method_title: o.payment_method_title || "QuickPay (kort)",
      ...(o.customer_note ? { customer_note: o.customer_note } : {}),
      meta_data: [{ key: "_example_xl", value: marker }, ...(o.meta_data || [])]
    };
  };

  // a customer we delete straight after the order is placed
  let doomedId = null;
  if (!seen.has("bh-xl-o-012")) {
    const doomedEmail = "xl.slettet.kunde@example.dk";
    const pre = await findCustomer(doomedEmail);
    doomedId = pre?.id ?? (await api("POST", "wc/v3/customers", {
      email: doomedEmail, first_name: "Henrik", last_name: "Dahl",
      billing: xlAddr(8, doomedEmail), shipping: xlAddr(8, doomedEmail)
    }).then((c) => c.id).catch(() => null));
  }

  const SPECS = [
    // --- status spread with period-appropriate, now-defunct gateways
    ["bh-xl-o-000", { status: "cancelled", date_created: "2018-09-12T14:22:00", payment_method: "dibs", payment_method_title: "DIBS Betalingsvindue", addrOpts: { noPostcode: true }, customer_note: "Kunden fortrød inden afsendelse." }],
    ["bh-xl-o-001", { status: "cancelled", date_created: "2019-11-30T21:41:00", payment_method: "epay", payment_method_title: "ePay / Bambora" }],
    ["bh-xl-o-002", { status: "failed", date_created: "2019-03-02T08:14:00", payment_method: "epay", payment_method_title: "ePay / Bambora" }],
    ["bh-xl-o-003", { status: "failed", payment_method: "mobilepay", payment_method_title: "MobilePay" }],
    ["bh-xl-o-004", { status: "pending", date_created: "2018-05-19T16:03:00", payment_method: "bacs", payment_method_title: "Bankoverførsel" }],
    ["bh-xl-o-005", { status: "pending", payment_method: "quickpay", payment_method_title: "QuickPay (kort)" }],
    ["bh-xl-o-006", { status: "on-hold", payment_method: "bacs", payment_method_title: "Bankoverførsel", customer_note: "Ring inden levering — 3. th, ingen dørtelefon." }],
    ["bh-xl-o-007", { status: "refunded", date_created: "2020-06-08T12:00:00", payment_method: "dankort", payment_method_title: "Dankort-terminal (butik)" }],
    // --- shapes
    ["bh-xl-o-008", {  // B2B wholesale: 30+ line items
      status: "completed", date_created: "2023-08-21T09:30:00",
      payment_method: "bacs", payment_method_title: "Faktura, 8 dage netto",
      line_items: Array.from({ length: 32 }, (_, k) => line(k, 1 + (k % 4))),
      shipping_lines: [{ method_id: "flat_rate", method_title: "Fragtmand — palle", total: "395.00" }],
      customer_note: "Leveres på bagsiden, ring ved ankomst."
    }],
    ["bh-xl-o-009", {  // fee only, no products: a repair invoiced through the shop
      status: "completed", line_items: [],
      fee_lines: [{ name: "Reparation af plaid (systue)", total: "295.00" }],
      payment_method: "mobilepay", payment_method_title: "MobilePay"
    }],
    ["bh-xl-o-010", { status: "processing", date_created: `${nextYear}-03-04T10:00:00`, customer_note: "Forudbestilling — sendes når varen kommer hjem." }],
    ["bh-xl-o-011", {  // zero total: warranty replacement
      status: "completed",
      line_items: [zeroPrice ? { product_id: zeroPrice.id, quantity: 1 } : { ...line(4), total: "0.00", subtotal: "0.00" }],
      customer_note: "Garantiombytning — kunden betaler ikke."
    }],
    ["bh-xl-o-012", { status: "completed", ...(doomedId ? { customer_id: doomedId } : {}), email: "xl.slettet.kunde@example.dk" }],
    ["bh-xl-o-013", { status: "completed", date_created: "2018-12-03T19:47:00", payment_method: "dibs", payment_method_title: "DIBS Betalingsvindue", addrOpts: { noPostcode: true } }],
    ["bh-xl-o-014", { status: "processing", noShipping: true, customer_note: "Afhentes i butikken." }]
  ];

  const queue = [];
  SPECS.forEach(([marker, o], i) => { if (!seen.has(marker)) queue.push(mk(i, marker, o)); });

  let created = [];
  if (queue.length) {
    try { created = await batchOrders(api, logger, queue, "xl orders"); }
    catch (e) { p.orderBatch = `rejected: ${e.data?.code || String(e.message).slice(0, 70)}`; }
  }
  xl.orders = { created: created.length, skipped: SPECS.length - queue.length };

  const byMarker = new Map();
  for (const o of [...allOrders, ...created]) {
    const m = (o.meta_data || []).find((x) => x.key === "_example_xl");
    if (m) byMarker.set(m.value, o);
  }
  const readOrder = async (marker) => {
    const o = byMarker.get(marker);
    return o ? api("GET", `wc/v3/orders/${o.id}`).catch(() => o) : null;
  };

  await probe(p, "order30Lines", () => readOrder("bh-xl-o-008"),
    (o) => (o ? `${(o.line_items || []).length} line items stored, total=${o.total}` : "order not created"));
  await probe(p, "orderFeeOnly", () => readOrder("bh-xl-o-009"),
    (o) => (o ? `line_items=${(o.line_items || []).length} fee_lines=${(o.fee_lines || []).length} total=${o.total}` : "order not created"));
  await probe(p, "orderFutureDated", () => readOrder("bh-xl-o-010"),
    (o) => (o
      ? (String(o.date_created).startsWith(String(nextYear))
        ? `accepted (${o.date_created})`
        : `ignored — stored ${o.date_created}`)
      : "order not created"));
  await probe(p, "orderZeroTotal", () => readOrder("bh-xl-o-011"),
    (o) => (o ? `total=${o.total} status=${o.status} paid=${Boolean(o.date_paid)}` : "order not created"));
  await probe(p, "orderOldGateways", () => readOrder("bh-xl-o-000"),
    (o) => (o ? `date_created=${o.date_created} gateway=${trunc(o.payment_method_title, 40)} postcode=${trunc(o.billing?.postcode, 10)}` : "order not created"));
  await probe(p, "orderNoShipping", () => readOrder("bh-xl-o-014"),
    (o) => (o ? `shipping.address_1=${trunc(o.shipping?.address_1, 30)} shipping.city=${trunc(o.shipping?.city, 20)}` : "order not created"));

  // Story: the customer asked to be deleted under GDPR; the order stayed.
  await probe(p, "orderWithDeletedCustomer", async () => {
    const o = byMarker.get("bh-xl-o-012");
    if (!o) return { state: "order not created" };
    const cid = o.customer_id;
    if (cid) await api("DELETE", `wc/v3/customers/${cid}?force=true&reassign=0`).catch(() => {});
    const after = await api("GET", `wc/v3/orders/${o.id}`).catch(() => o);
    const stillThere = cid ? await api("GET", `wc/v3/customers/${cid}`).then(() => true).catch(() => false) : false;
    return { cid, orderCustomerId: after.customer_id, stillThere, email: after.billing?.email };
  }, (r) => (r.state
    ? r.state
    : `order keeps customer_id=${r.orderCustomerId} (user row exists=${r.stillThere}), billing email=${trunc(r.email, 40)}`));

  // ============================================================
  // Phase X7 — a little content carrying the same HTML debris.
  // Story: the blog was written in the classic editor by four different people.
  // ============================================================
  logger("xl: content (2 posts)");
  await C("wp/v2/posts", {
    title: "Julegaveguide 2024 🎁", slug: "xl-julegaveguide-2024", status: "publish",
    content: `<p>Her er årets favoritter fra Example Living.</p>
<script>/* bureauets konverteringssporing, dec. 2024 */ window.dataLayer=window.dataLayer||[];dataLayer.push({event:'guide_view'});</script>
<ul><li>Uldplaid<li>Krus<li>Garnkort
<p>Str&amp;amp;oslash;rrelser og priser kan &amp;amp;aelig;ndre sig.`
  });
  await C("wp/v2/pages", {
    title: "Forhandlerlogin", slug: "xl-forhandlerlogin", status: "publish",
    content: `<p>Erhvervskunder logger ind her.</p><figure><img src="data:image/gif;base64,${GIF_1PX}" alt="logo"></figure><p><a href="${site}/admin/">Til forhandlerportalen</a></p>`
  });
  xl.posts = 1;
  xl.pages = 1;

  // ---------- final counts (recounted, never copied from a plan) ----------
  let productCount = 0;
  for (let page = 1; ; page++) {
    const rows = await api("GET", `wc/v3/products?per_page=100&page=${page}&status=any`).catch(() => []);
    productCount += rows.length;
    if (rows.length < 100) break;
  }
  let orderCount = 0;
  for (let page = 1; ; page++) {
    const rows = await api("GET", `wc/v3/orders?per_page=100&page=${page}&status=any`).catch(() => []);
    orderCount += rows.length;
    if (rows.length < 100) break;
  }
  xl.products = productCount;   // TOTAL on the site, real + xl
  xl.totalOrders = orderCount;  // TOTAL on the site, real + xl

  logger(`real-xl tier done — ${productCount} products, ${orderCount} orders on the source`);
  return { ...base, xl };
}
