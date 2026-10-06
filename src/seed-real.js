/**
 * seed-real.js — the `real` tier: "Example Living", a fictional Danish
 * home-goods & yarn webshop est. 2018. STANDALONE (not cumulative with
 * light/medium/heavy): reproduces the *emergent* mess of 8 years of genuine
 * SMB WooCommerce history to test the pipeline's assumptions, not its
 * code paths.
 *
 * Everything is idempotent (slug/SKU/marker sentinels) so interrupted runs
 * resume safely on flaky TasteWP sites. API behaviors we exploit are noted
 * inline; genuinely unknown behaviors are PROBES: attempted live, outcome
 * logged into summary.probes, never a hard failure.
 */

const pad = (n, w = 2) => String(n).padStart(w, "0");

// ---------- shared idempotent helpers ----------
export const ensureProduct = (api, logger) => async (payload) => {
  const existing = await api("GET", `wc/v3/products?slug=${encodeURIComponent(payload.slug)}&status=any`);
  if (existing[0]) return existing[0];
  try { return await api("POST", "wc/v3/products", payload); }
  catch (e) {
    if (payload.images && String(e.data?.code || "").includes("image")) {
      logger(`image rejected for ${payload.slug} — creating without image`);
      const { images, ...rest } = payload;
      return api("POST", "wc/v3/products", rest);
    }
    throw e;
  }
};

export const ensureContent = (api) => async (route, payload) => {
  const existing = await api("GET", `${route}?slug=${payload.slug}`);
  return existing[0] ?? api("POST", route, payload);
};

export async function ensureCategory(api, def) {
  const existing = await api("GET", `wc/v3/products/categories?slug=${encodeURIComponent(def.slug)}`);
  return existing[0] ?? api("POST", "wc/v3/products/categories", def);
}

export async function batchProducts(api, logger, products, label) {
  const created = [];
  for (let i = 0; i < products.length; i += 90) {
    const res = await api("POST", "wc/v3/products/batch", { create: products.slice(i, i + 90) });
    created.push(...(res.create || []).filter((p) => p.id));
    logger(`${label}: ${Math.min(i + 90, products.length)}/${products.length}`);
  }
  return created;
}

export async function batchOrders(api, logger, orders, label) {
  const created = [];
  for (let i = 0; i < orders.length; i += 15) {
    const res = await api("POST", "wc/v3/orders/batch", { create: orders.slice(i, i + 15) });
    for (const o of res.create || []) {
      if (o.id) created.push(o);
      else logger(`${label}: one order rejected — ${JSON.stringify(o.error || {}).slice(0, 120)}`);
    }
    logger(`${label}: ${Math.min(i + 15, orders.length)}/${orders.length}`);
  }
  return created;
}

// ---------- description templates (⅓ clean / ⅓ Word-paste / ⅓ builder debris) ----------
const descClean = (txt) => `<p>${txt}</p>\n<p>Fremstillet med omtanke i Danmark. Ved spørgsmål er du altid velkommen til at kontakte os.</p>`;

const descWord = (txt) => `<p class="MsoNormal" style="mso-margin-top-alt:auto;mso-margin-bottom-alt:auto;line-height:normal"><span style="font-size:11.0pt;font-family:&quot;Calibri&quot;,sans-serif;mso-ascii-theme-font:minor-latin">${txt} – “hygge” når det er bedst.<o:p></o:p></span></p>
<!--[if !supportLists]--><p class="MsoNormal"><span style="mso-fareast-font-family:&quot;Times New Roman&quot;;mso-bidi-font-weight:bold"><span style="color:black">Mål og materiale: se specifikationer.&nbsp;</span></span><span style="mso-spacerun:yes"> </span>Leveres i gavepose.</p><!--[endif]-->`;

const descBuilderDivi = (txt) => `[et_pb_section fb_built="1" admin_label="sektion"][et_pb_row][et_pb_column type="4_4"][et_pb_text admin_label="Tekst"]<h2>Produktdetaljer</h2><p>${txt}</p>[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]`;

const descBuilderVc = (txt) => `[vc_row][vc_column width="2/3"][vc_column_text]<p>${txt}</p>[/vc_column_text][/vc_column][vc_column width="1/3"][vc_message]Fri fragt over et vist beløb[/vc_message][/vc_column][/vc_row]`;

const DESCS = [descClean, descWord, descBuilderDivi, descClean, descWord, descBuilderVc];

// ---------- addresses / people ----------
const STREETS = ["Søndergade 14", "Åboulevarden 3, 2. th", "Græsvænget 21", "Nørrebrogade 55", "Østergade 9", "Bakkedraget 8"];
const CITIES = [["Aarhus C", "8000"], ["København N", "2200"], ["Odense C", "5000"], ["Aalborg", "9000"], ["Vejle", "7100"], ["Rønne", "3700"]];
const PHONES = ["+45 21 43 65 87", "23456789", "0045-8765-4321", "(+45) 98 76 54 32"];
const FIRST = ["Anna", "Mette", "Søren", "Kirsten", "Jørgen", "Camilla", "Niels", "Lærke", "Ole", "Birgitte", "Rasmus", "Åse", "Per", "Ditte", "Bjørn", "Helle", "Kasper", "Ingrid", "Troels", "Maja"];
const LAST = ["Møller", "Jensen", "Holm", "Østergaard", "Lund", "Kjær", "Andersen", "Skovgaard", "Bruun", "Dam"];

const mkAddr = (i, email, { company } = {}) => {
  const [city, zip] = CITIES[i % CITIES.length];
  return {
    first_name: FIRST[i % FIRST.length],
    last_name: i % 7 === 3 ? "" : LAST[i % LAST.length], // missing last names
    ...(company ? { company } : {}),
    address_1: STREETS[i % STREETS.length],
    ...(i % 5 === 2 ? { address_2: "c/o Jensen, st. tv" } : {}),
    city, postcode: zip, country: "DK",
    email, phone: PHONES[i % PHONES.length]
  };
};

const B2B_COMPANIES = ["Nordisk Bolig ApS (CVR 38119482)", "Hyggehjem I/S · CVR 41290573", "Garn & Græs ApS, CVR: 35672918", "Fru Fjord Interiør — CVR 39548201", "Bæk & Bølge A/S (CVR 30765412)"];

// =====================================================================
export async function seedReal({ api, site, logger = () => {} }) {
  const S = { probes: {} };

  // ---------- Phase 1a: categories (18, 4 levels, near-dups, 2 empty, 1 colliding pair) ----------
  logger("categories (18)");
  const catDefs = [
    ["bolig", "Bolig", null, descBuilderVc("Alt til det hyggelige hjem.")],
    ["tekstiler", "Tekstiler", "bolig"],
    ["plaider", "Plaider", "tekstiler", descClean("Plaider i uld og bomuld.")],
    ["uld", "Uld", "plaider"],                                     // level 4
    ["bomuld", "Bomuld", "plaider"],                               // level 4
    ["puder", "Puder", "tekstiler"],
    ["gardiner", "Gardiner", "tekstiler"],                         // EMPTY
    ["koekken", "Køkken", "bolig"],
    ["keramik", "Keramik", "koekken"],
    ["garn", "Garn", null, descWord("Garn til strik og hækling.")],
    ["uldgarn", "Uldgarn", "garn"],
    ["bomuldsgarn", "Bomuldsgarn", "garn"],
    ["opskrifter", "Opskrifter", "garn", descClean("Digitale strikkeopskrifter som PDF.")],
    ["strikkepinde", "Strikkepinde", "garn"],
    ["tilbehoer", "Tilbehør", null],                          // da_DK-era slug; grouped product collides with this handle
    ["tilbehoer-2", "Tilbehoer", null],                            // EMPTY abandoned near-duplicate (a 2019 re-import)
    ["strikke-tilbehoer", "Strikke-tilbehør", "tilbehoer"],
    ["strikke_tilbehoer", "Strikke_tilbehør (2019)", null]    // CSV-import artifact; handle collides with the above
  ];
  const cat = {};
  for (const [slug, name, parent, description] of catDefs) {
    const c = await ensureCategory(api, { slug, name, ...(parent ? { parent: cat[parent].id } : {}), ...(description ? { description } : {}) });
    cat[slug] = c;
    if (c.slug !== slug) logger(`NB: WP normalized category slug ${slug} -> ${c.slug}`);
  }
  S.categories = Object.keys(cat).length;
  S.probes.underscoreSlugKept = cat["strikke_tilbehoer"].slug === "strikke_tilbehoer";

  // ---------- Phase 1b: generated simple products (92) ----------
  const TYPES = [
    ["plaid", "Plaid", ["plaider", "uld", "tekstiler"], 449],
    ["pude", "Pude", ["puder", "tekstiler"], 249],
    ["skaal", "Skål", ["keramik", "koekken"], 179],
    ["garn", "Nøgle", ["uldgarn", "garn"], 59],
    ["bomuldsgarn", "Bomuldsgarn", ["bomuldsgarn", "garn"], 45],
    ["pind", "Strikkepind", ["strikkepinde", "strikke-tilbehoer"], 89],
    ["bakke", "Bakke", ["koekken", "bolig"], 299],
    ["viskestykke", "Viskestykke", ["koekken", "tekstiler", "bolig"], 79]
  ];
  const COLORS = ["Grå", "Natur", "Støvet Blå", "Ærtegrøn", "Karry", "Rødbrun", "Sort", "Hvid", "Sennep", "Bølgeblå"];
  const sentinel = await api("GET", "wc/v3/products?sku=1040&status=any");
  if (!sentinel.length) {
    logger("generated products (92)");
    const gen = Array.from({ length: 92 }, (_, i) => {
      const [key, noun, cats, base] = TYPES[i % TYPES.length];
      const color = COLORS[i % COLORS.length];
      const name = `${noun} ${color} ${i % 4 === 0 ? `${40 + (i % 5) * 10}×${60 + (i % 5) * 20}` : `No. ${pad(i + 1)}`}`;
      // three SKU generations + ~20% missing (i%5===3)
      const sku = i % 5 === 3 ? undefined
        : i < 30 ? String(1040 + i)
        : i < 60 ? `BH-${key.slice(0, 5).toUpperCase()}-${pad(i)}`
        : `example_${key}_${color.toLowerCase().replace(/[^a-zæøå]+/g, "")}`;
      const price = base + (i % 7) * 10;
      return {
        name, slug: `${key}-${color.toLowerCase().replace(/[^a-z0-9æøå]+/g, "-")}-${pad(i + 1)}`,
        type: "simple", status: i % 11 === 10 ? "draft" : i % 23 === 22 ? "private" : "publish",
        ...(sku ? { sku } : {}),
        regular_price: String(price),
        ...(i % 6 === 1 ? { sale_price: String(price - 30) } : {}),
        manage_stock: i % 9 !== 0, stock_quantity: (i * 3) % 40,
        weight: String(0.1 + (i % 8) / 10),
        description: DESCS[i % DESCS.length](`${noun} i farven ${color.toLowerCase()} — klassisk kvalitet fra Example Living.`),
        short_description: `<p>${noun}, ${color.toLowerCase()}.</p>`,
        categories: cats.slice(0, 2 + (i % 3)).map((c) => ({ id: cat[c].id })),
        ...(i % 6 === 0 ? {
          meta_data: [
            { key: "_yoast_wpseo_title", value: `${name} | Example Living` },
            { key: "rank_math_title", value: `${name} – køb online` },
            { key: "rank_math_description", value: `Køb ${name} hos Example Living.` },
            { key: "_wpm_gtin_code", value: `570123400${pad(i, 4)}` }
          ]
        } : {})
      };
    });
    S.generated = (await batchProducts(api, logger, gen, "generated")).length;
  } else { S.generated = 92; logger("generated products already seeded"); }

  // ---------- Phase 1c: deliberate awkward singles ----------
  logger("awkward singles");
  const P = ensureProduct(api, logger);
  const inCats = (...slugs) => ({ categories: slugs.map((s) => ({ id: cat[s].id })) });

  const uldplaid = await P({
    name: "Uldplaid Grå", slug: "uldplaid-graa", type: "simple", status: "publish", sku: "BH-PLAID-01",
    regular_price: "599", description: descClean("Klassisk uldplaid i grå — vores bestseller siden 2018."),
    manage_stock: true, stock_quantity: 14, weight: "0.9", ...inCats("plaider", "uld", "tekstiler")
  });
  await P({ // re-import duplicate, name suffix "(kopi)", SKU lost in the copy
    name: "Uldplaid Grå (kopi)", slug: "uldplaid-graa-kopi", type: "simple", status: "draft",
    regular_price: "599", description: descClean("Klassisk uldplaid i grå — vores bestseller siden 2018."),
    ...inCats("plaider")
  });
  await P({ // second re-import artifact: same name, "-2" slug
    name: "Uldplaid Grå", slug: "uldplaid-graa-2", type: "simple", status: "publish",
    regular_price: "579", ...inCats("plaider", "uld")
  });

  // whitespace-in-SKU probe: does Woo store "BH-PLAID-07 " verbatim?
  const wsp = await P({
    name: "Hyggeplaid Meleret", slug: "hyggeplaid-meleret", type: "simple", status: "publish",
    sku: "BH-PLAID-07 ", regular_price: "489", ...inCats("plaider", "tekstiler")
  });
  S.probes.whitespaceSkuStored = JSON.stringify(wsp.sku); // observed as-stored

  await P({ // HTML entity in name -> title/handle must entity-decode
    name: "Tæpper &amp; Plaider – Prøvekollektion", slug: "taepper-plaider-proevekollektion",
    type: "simple", status: "publish", sku: "example_taeppe_prove", regular_price: "349", ...inCats("plaider", "tekstiler")
  });
  await P({ // 0 kr product -> ZERO_PRICE action warning
    name: "Vareprøve: Garnkort", slug: "vareproeve-garnkort", type: "simple", status: "publish",
    sku: "1090", regular_price: "0", ...inCats("garn", "tilbehoer")
  });
  await P({ // price edge: luxury
    name: "Designerplaid Kastanje — Limited Edition", slug: "designerplaid-kastanje", type: "simple",
    status: "publish", sku: "BH-PLAID-99", regular_price: "12499",
    description: descWord("Eksklusivt designerplaid i kastanjebrun — kun få eksemplarer."),
    manage_stock: true, stock_quantity: 2, ...inCats("plaider", "uld")
  });

  // sale > regular probe (data-entry error): does the API accept it as-is?
  let sgr = await P({
    name: "Sofapude Vintage Rosa", slug: "sofapude-vintage-rosa", type: "simple", status: "publish",
    sku: "1091", regular_price: "199", sale_price: "249", ...inCats("puder", "tekstiler")
  });
  if (Number(sgr.sale_price) > Number(sgr.regular_price || 0)) {
    S.probes.saleGtRegular = "accepted-directly";
  } else {
    // fallback per plan: set a valid sale first, then lower regular beneath it
    await api("PUT", `wc/v3/products/${sgr.id}`, { regular_price: "299", sale_price: "249" });
    sgr = await api("PUT", `wc/v3/products/${sgr.id}`, { regular_price: "199" });
    S.probes.saleGtRegular = Number(sgr.sale_price) > Number(sgr.regular_price) ? "accepted-via-two-step" : "unreproducible-via-api";
  }

  // duplicate SKU probe: Woo admin enforces unique SKUs — does the API?
  try {
    const dup = await api("POST", "wc/v3/products", {
      name: "Uldplaid Grå Special", slug: "uldplaid-graa-special", type: "simple", status: "publish",
      sku: "BH-PLAID-01", regular_price: "649", ...inCats("plaider")
    });
    S.probes.duplicateSku = dup.sku === "BH-PLAID-01" ? "accepted (!)" : `rewritten to ${dup.sku}`;
  } catch (e) {
    const pre = await api("GET", "wc/v3/products?slug=uldplaid-graa-special&status=any");
    S.probes.duplicateSku = pre[0] ? "already-seeded" : `rejected: ${e.data?.code || e.message.slice(0, 60)}`;
  }

  // downloadable products (yarn patterns are PDFs) -> DIGITAL_FILES action warning
  for (const [n, slug, file] of [
    ["Strikkeopskrift: Example Plaid (PDF)", "opskrift-example-plaid", "opskrift-example-plaid.pdf"],
    ["Strikkeopskrift: Sokker i restegarn (PDF)", "opskrift-sokker-restegarn", "opskrift-sokker.pdf"],
    ["Hækleopskrift: Karklude (PDF)", "opskrift-karklude", "opskrift-karklude.pdf"]
  ]) {
    await P({
      name: n, slug, type: "simple", status: "publish", virtual: true, downloadable: true,
      sku: `example_pdf_${slug.split("-").pop()}`, regular_price: "39",
      downloads: [{ name: n, file: `https://example.dk/downloads/${file}` }],
      ...inCats("opskrifter", "garn")
    });
  }

  // grouped product whose slug EQUALS category "tilbehoer" -> guaranteed
  // collection HANDLE_COLLISION (product and term slugs are separate WP namespaces)
  const pind1 = await api("GET", "wc/v3/products?sku=1045&status=any"); // any two cheap members
  const pind2 = await api("GET", "wc/v3/products?sku=1046&status=any");
  await P({
    name: "Tilbehørssæt", slug: "tilbehoer", type: "grouped", status: "publish",
    description: descClean("Vores mest solgte tilbehør — samlet ét sted."),
    grouped_products: [pind1[0]?.id, pind2[0]?.id, uldplaid.id].filter(Boolean), ...inCats("tilbehoer")
  });

  // ---------- Phase 1d: variable products (15, case-variant attribute names) ----------
  logger("variable products (15)");
  const VAR_DEFS = Array.from({ length: 15 }, (_, i) => {
    const attrName = i < 5 ? "Farve" : i < 10 ? "farve" : i < 13 ? "Color" : "Størrelse";
    const opts = attrName === "Størrelse" ? ["50×50", "60×60"] : ["Natur", "Grå", "Støvet Rosa"].slice(0, 2 + (i % 2));
    const noun = ["Pudebetræk Hør", "Plaid Merino", "Grydelapper Strik", "Løber Bomuld", "Sengeplaid"][i % 5];
    return { i, attrName, opts, name: `${noun} ${["Classic", "Bold", "Nordic"][i % 3]} ${pad(i + 1)}`, slug: `var-${noun.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${pad(i + 1)}` };
  });
  for (const d of VAR_DEFS) {
    const vp = await P({
      name: d.name, slug: d.slug, type: "variable", status: "publish",
      description: DESCS[d.i % DESCS.length](`${d.name} — vælg variant.`),
      attributes: [{ name: d.attrName, visible: true, variation: true, options: d.opts }],
      ...inCats(...(d.i % 2 ? ["puder", "tekstiler"] : ["plaider", "tekstiler", "bolig"]))
    });
    const have = await api("GET", `wc/v3/products/${vp.id}/variations?per_page=10`);
    if (!have.length) {
      for (let k = 0; k < d.opts.length; k++) {
        // d.i===2, k===0: variation deliberately has NO price -> zero-price action warning
        const priceless = d.i === 2 && k === 0;
        await api("POST", `wc/v3/products/${vp.id}/variations`, {
          ...(d.i % 4 === 3 && k === 0 ? {} : { sku: `BHV-${pad(d.i)}-${k}` }), // some variants missing SKUs
          ...(priceless ? {} : { regular_price: String(199 + d.i * 10 + k * 20) }),
          manage_stock: true, stock_quantity: 3 + k,
          attributes: [{ name: d.attrName, option: d.opts[k] }]
        });
      }
    }
    if (d.i % 5 === 4) logger(`variable ${d.i + 1}/15`);
  }

  // ---------- Phase 2a: coupons (12, 8 expired, email-restricted, free-shipping) ----------
  logger("coupons (12)");
  const coupons = [
    { code: "BLACKFRIDAY2019", discount_type: "percent", amount: "20", date_expires: "2019-12-01T23:59:59" },
    { code: "JUL2020", discount_type: "fixed_cart", amount: "50", date_expires: "2020-12-24T23:59:59" },
    { code: "PAASKE2021", discount_type: "percent", amount: "15", date_expires: "2021-04-05T23:59:59" },
    { code: "SOMMER2022", discount_type: "fixed_cart", amount: "40", date_expires: "2022-08-31T23:59:59" },
    { code: "EFTERAAR2022", discount_type: "percent", amount: "10", date_expires: "2022-11-01T23:59:59" },
    { code: "BF2023", discount_type: "percent", amount: "25", date_expires: "2023-11-27T23:59:59" },
    { code: "JUL2023", discount_type: "fixed_cart", amount: "60", date_expires: "2023-12-23T23:59:59" },
    { code: "FORAAR2024", discount_type: "percent", amount: "12", date_expires: "2024-05-31T23:59:59" },
    { code: "VELKOMMEN10", discount_type: "percent", amount: "10", minimum_amount: "100", usage_limit_per_user: 1 },
    { code: "MOBILEPAY25", discount_type: "fixed_cart", amount: "25" },
    { code: "STAMKUNDE15", discount_type: "percent", amount: "15", email_restrictions: ["stamkunde@example.dk"] },
    { code: "FRIFRAGT", discount_type: "fixed_cart", amount: "0", free_shipping: true }
  ];
  for (const c of coupons) await api("POST", "wc/v3/coupons", c).catch((e) => { if (e.status !== 400) throw e; });
  S.coupons = coupons.length;

  // ---------- Phase 2b: customers (40 registered; 5 B2B w/ CVR) ----------
  logger("customers (40)");
  const custPayload = Array.from({ length: 40 }, (_, i) => {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i + 3) % LAST.length];
    const email = `${first.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")}.${last.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")}${i}@example.dk`;
    const b2b = i % 8 === 5 ? B2B_COMPANIES[(i / 8) | 0] : undefined;
    return {
      email, first_name: first, last_name: i % 7 === 3 ? "" : last,
      billing: { ...mkAddr(i, email, { company: b2b }), first_name: first },
      shipping: mkAddr(i, email)
    };
  });
  let createdCust = 0;
  for (let i = 0; i < custPayload.length; i += 20) {
    const res = await api("POST", "wc/v3/customers/batch", { create: custPayload.slice(i, i + 20) }).catch(() => ({ create: [] }));
    createdCust += (res.create || []).filter((c) => c.id).length;
    logger(`customers ${Math.min(i + 20, 40)}/40`);
  }
  S.customers = createdCust;
  const registered = (await api("GET", "wc/v3/customers?per_page=100&role=all")).filter((c) => c.role !== "administrator");

  // ---------- Phase 2c: orders (~60; 65% guest; full status mix; markers) ----------
  logger("orders (~60)");
  const existingOrders = [];
  for (let page = 1; ; page++) {
    const rows = await api("GET", `wc/v3/orders?per_page=100&page=${page}&status=any`);
    existingOrders.push(...rows);
    if (rows.length < 100) break;
  }
  const seededMarkers = new Set(existingOrders.flatMap((o) => (o.meta_data || []).filter((m) => m.key === "_example_seed").map((m) => m.value)));

  const skuId = async (sku) => (await api("GET", `wc/v3/products?sku=${encodeURIComponent(sku)}&status=any`))[0]?.id;
  const pool = [uldplaid.id, wsp.id, sgr.id, await skuId("1041"), await skuId("1044"), await skuId("BH-PLAID-99"), await skuId("example_pdf_plaid"), await skuId("1047"), await skuId("BH-GARN-32"), await skuId("1050")].filter(Boolean);
  const STATUSES = [...Array(26).fill("completed"), ...Array(12).fill("processing"), ...Array(4).fill("on-hold"), "refunded", "refunded", "pending", "pending", "failed", "failed", "cancelled", "cancelled"]; // 50 baseline

  const mkOrder = (i, marker, extra = {}) => {
    const reg = registered.length ? registered[i % registered.length] : null;
    const guest = i % 100 < 65 || extra._forceGuest || !reg; // ~65% guest
    // case-duplicate emails: guests re-type a REGISTERED email with different casing
    const dupSource = registered[i % 3 === 0 ? 0 : 1]?.email || "anna.moeller0@example.dk";
    const guestEmail = i % 9 === 4
      ? dupSource.replace(/^./, (ch) => ch.toUpperCase()).replace("@example", "@Example")
      : `gaest${i}@${["gmail.com", "hotmail.com", "example.dk"][i % 3]}`;
    const email = guest ? guestEmail : reg.email;
    const billing = { ...mkAddr(i, email, i % 12 === 7 ? { company: B2B_COMPANIES[i % B2B_COMPANIES.length] } : {}) };
    const { _forceGuest, ...rest } = extra;
    const status = rest.status || STATUSES[i % STATUSES.length];
    return {
      status,
      ...(guest ? {} : { customer_id: reg.id }),
      set_paid: rest.set_paid ?? ["completed", "processing", "refunded"].includes(status),
      billing, shipping: mkAddr(i, email),
      line_items: rest.line_items || [
        { product_id: pool[i % pool.length], quantity: 1 + (i % 3) },
        ...(i % 3 === 0 ? [{ product_id: pool[(i + 4) % pool.length], quantity: 1 }] : [])
      ],
      ...(i % 6 === 2 ? { shipping_lines: [{ method_id: "flat_rate", method_title: ["GLS Pakkeshop", "PostNord Privat", "DAO - nærmeste udleveringssted"][i % 3], total: "45.00" }] } : {}),
      ...(i % 10 === 6 ? { fee_lines: [{ name: "Gaveindpakning", total: "25.00" }] } : {}),
      ...(i % 17 === 9 ? { fee_lines: [{ name: "Betalingsgebyr (MobilePay)", total: "4.95" }] } : {}),
      payment_method: i % 2 ? "quickpay" : "mobilepay",
      payment_method_title: i % 2 ? "QuickPay (kort)" : "MobilePay",
      meta_data: [{ key: "_example_seed", value: marker }],
      ...Object.fromEntries(Object.entries(rest).filter(([k]) => !["status", "set_paid", "line_items"].includes(k)))
    };
  };

  const orderQueue = [];
  for (let i = 0; i < 50; i++) {
    const marker = `bh-o-${pad(i, 3)}`;
    if (!seededMarkers.has(marker)) orderQueue.push(mkOrder(i, marker));
  }
  // specials 50..59
  const specials = [
    ["bh-o-050", (m) => mkOrder(50, m, { status: "completed", coupon_lines: [{ code: "velkommen10" }, { code: "mobilepay25" }], line_items: [{ product_id: pool[0], quantity: 2 }] })], // multi-coupon
    ["bh-o-051", (m) => mkOrder(51, m, { status: "completed", _forceGuest: true, billing: undefined, line_items: [{ product_id: pool[1], quantity: 1 }] })],
    ["bh-o-052", (m) => mkOrder(52, m, { status: "completed", fee_lines: [{ name: "Kulancekredit", total: "-30.00" }] })], // negative fee
    ["bh-o-053", (m) => mkOrder(53, m, { status: "completed", currency: "EUR", line_items: [{ product_id: pool[2], quantity: 1 }] })], // mixed currency
    ["bh-o-054", (m) => mkOrder(54, m, { status: "completed", date_created: "2019-11-29T10:15:00", date_paid: "2019-11-29T10:20:00" })], // backdating probe
    ["bh-o-055", (m) => mkOrder(55, m)], // partial-refund target A
    ["bh-o-056", (m) => ({ ...mkOrder(56, m), status: "processing" })], // partial-refund target B
    ["bh-o-057", (m) => mkOrder(57, m)], // ghost target A (lines added below)
    ["bh-o-058", (m) => mkOrder(58, m)], // ghost target B
    ["bh-o-059", (m) => ({ ...mkOrder(59, m, { _forceGuest: true }), billing: { ...mkAddr(9, "stamkunde@example.dk"), email: "stamkunde@example.dk" }, coupon_lines: [{ code: "stamkunde15" }], status: "completed", set_paid: true })] // email-restricted coupon
  ];

  // ghost products: ordered, then force-deleted -> title-only lines on import
  const ghostIds = [];
  for (const [n, slug] of [["Udgået Vase Sart Grøn", "udgaaet-vase-sart-groen"], ["Udgået Skål Røget Eg", "udgaaet-skaal-roeget-eg"]]) {
    if (!seededMarkers.has("bh-o-057") || !seededMarkers.has("bh-o-058")) {
      const g = await P({ name: n, slug, type: "simple", status: "publish", regular_price: "149", sku: `GHOST-${slug.slice(-4).toUpperCase()}` });
      ghostIds.push(g.id);
    }
  }
  const bySpecialMarker = new Map(specials.map((s) => [s[0], s]));
  if (ghostIds[0]) bySpecialMarker.get("bh-o-057")[1] = (m) => mkOrder(57, m, { status: "completed", line_items: [{ product_id: ghostIds[0], quantity: 1 }, { product_id: pool[3], quantity: 2 }] });
  if (ghostIds[1]) bySpecialMarker.get("bh-o-058")[1] = (m) => mkOrder(58, m, { status: "completed", line_items: [{ product_id: ghostIds[1], quantity: 3 }] });

  for (const [marker, make] of specials) if (!seededMarkers.has(marker)) orderQueue.push(make(marker));

  const createdOrders = orderQueue.length ? await batchOrders(api, logger, orderQueue, "orders") : [];
  S.orders = { created: createdOrders.length, skipped: 60 - orderQueue.length };

  const byMarker = new Map();
  for (const o of [...existingOrders, ...createdOrders]) {
    const m = (o.meta_data || []).find((x) => x.key === "_example_seed");
    if (m) byMarker.set(m.value, o);
  }

  // backdating probe verdict
  const bd = byMarker.get("bh-o-054");
  if (bd) {
    const created = (await api("GET", `wc/v3/orders/${bd.id}`)).date_created || "";
    S.probes.backdatedDateCreated = created.startsWith("2019") ? `accepted (${created})` : `ignored (stored ${created})`;
  }
  // EUR probe verdict (Woo side)
  const eur = byMarker.get("bh-o-053");
  if (eur) S.probes.eurOrderWooCurrency = (await api("GET", `wc/v3/orders/${eur.id}`)).currency;

  // ---------- Phase 2d: REAL partial refunds ----------
  logger("partial refunds");
  S.refunds = 0;
  for (const marker of ["bh-o-055", "bh-o-056"]) {
    const o = byMarker.get(marker);
    if (!o) continue;
    const existing = await api("GET", `wc/v3/orders/${o.id}/refunds`);
    if (existing.length) { S.refunds++; continue; }
    try {
      await api("POST", `wc/v3/orders/${o.id}/refunds`, { amount: "100.00", reason: "Reklamation — delvis refusion aftalt", api_refund: false });
      S.refunds++;
      S.probes.partialRefundApi = "accepted";
    } catch (e) { S.probes.partialRefundApi = `rejected: ${e.data?.code || e.message.slice(0, 80)}`; }
  }

  // ---------- Phase 2e: ghost lines — force-delete the ordered products ----------
  for (const gid of ghostIds) await api("DELETE", `wc/v3/products/${gid}?force=true`).catch(() => {});
  S.ghostOrders = ["bh-o-057", "bh-o-058"].filter((m) => byMarker.has(m)).length;

  // ---------- Phase 3a: product reviews (not migratable -> info note) ----------
  logger("reviews");
  const revs = await api("GET", `wc/v3/products/reviews?product=${uldplaid.id}`);
  if (!revs.length) {
    const reviews = [
      { product_id: uldplaid.id, reviewer: "Mette H.", reviewer_email: "mette.h@example.dk", rating: 5, review: "Skønt plaid — blødt og lækkert. Køber gerne igen!" },
      { product_id: uldplaid.id, reviewer: "Søren", reviewer_email: "soeren@example.dk", rating: 4, review: "God kvalitet, dog lidt længere levering end lovet." },
      { product_id: wsp.id, reviewer: "Anna Møller", reviewer_email: "anna.moeller0@example.dk", rating: 5, review: "Hyggeligste plaid i stuen. Ønsker mig flere farver!" },
      { product_id: sgr.id, reviewer: "Kirsten", reviewer_email: "kirsten@example.dk", rating: 3, review: "Pæn pude, men farven er mere rosa end på billedet." },
      { product_id: pool[3] || uldplaid.id, reviewer: "Jørgen", reviewer_email: "joergen@example.dk", rating: 5, review: "Hurtig levering. Fin kvalitet til prisen." }
    ];
    for (const r of reviews) await api("POST", "wc/v3/products/reviews", r).catch((e) => { S.probes.reviewsApi = `rejected: ${e.data?.code || e.status}`; });
    S.reviews = reviews.length;
  } else { S.reviews = "already seeded"; }

  // ---------- Phase 3b: content (8 posts, 5 pages) ----------
  logger("content (8 posts, 5 pages)");
  const C = ensureContent(api);
  const posts = [
    ["Sådan plejer du din uldplaid", "pleje-af-uldplaid",
      `<p>Uld er selvrensende og skal sjældent vaskes — luftning gør underværker.</p><figure class="wp-block-embed"><iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Uldpleje" frameborder="0" allowfullscreen></iframe></figure><p>Se også vores <a href="${site}/produkt/uldplaid-graa/">grå uldplaid</a>.</p>`],
    ["Kontakt os om B2B-samarbejde", "b2b-samarbejde",
      `<p>Vi leverer gerne til butikker og kontorer. CVR-kunder får faktura med 8 dages betalingsfrist.</p>[contact-form-7 id="123" title="B2B-formular"]<p>Eller ring til os på hverdage.</p>`],
    ["Efterårets nyheder 2023", "efteraarets-nyheder-2023",
      `<p>Se stemningsbilleder fra årets efterårskollektion:</p>[gallery ids="12,13,14" columns="3"]<p>Alle varer er på lager nu.</p>`],
    ["Vores historie", "vores-historie",
      `<p>Example Living startede i 2018 ved et køkkenbord i Aarhus. Læs <a href="${site}/?p=42">vores allerførste indlæg</a> og siden om <a href="${site}/?page_id=7">holdet bag</a>.</p><p>I dag sender vi til hele Norden.</p>`],
    ["Strik med restegarn", "strik-med-restegarn",
      `<center><font size="4" color="#333366"><b>Restegarn er guld!</b></font></center>\n<table width="600" border="1" cellpadding="4"><tr><td><font face="Verdana">Sokker</font></td><td>50&nbsp;g</td></tr><tr><td><font face="Verdana">Karklude</font></td><td>30&nbsp;g</td></tr></table>\n<p><b>Tip:</b> bland farver &amp; strukturer. <i>God fornøjelse!</i></p>`],
    ["Nyt fra værkstedet", "nyt-fra-vaerkstedet",
      descWord("Vi har travlt bag kulisserne med næste kollektion")],
    ["Guide: Vask af uld", "guide-vask-af-uld",
      `<p>Brug altid uldprogram og uldvaskemiddel. Centrifugering ødelægger fibrene.</p><p>Vi anbefaler vores <a href="${site}/produkt/hyggeplaid-meleret/">hyggeplaid</a> til efter badet.</p>`],
    ["Julemarked i Example 2024", "julemarked-2024",
      `<p>Tak for et fantastisk julemarked! Vi glæder os allerede til næste år.</p><blockquote>“Den hyggeligste stand på pladsen” &mdash; besøgende</blockquote>`]
  ];
  for (const [title, slug, content] of posts) await C("wp/v2/posts", { title, slug, status: "publish", content });
  const pages = [
    ["Handelsbetingelser", "handelsbetingelser", `<p>Alle priser er i DKK inkl. 25% moms. Levering med GLS, PostNord eller DAO.</p><p>Betaling via QuickPay eller MobilePay. 14 dages fortrydelsesret.</p>`],
    ["Cookie- og privatlivspolitik", "cookiepolitik", `<p>Vi bruger cookies til statistik og markedsføring. Du kan altid trække dit samtykke tilbage.</p>`],
    ["Om os", "om-os", `<p>Example Living er en lille dansk familievirksomhed med kærlighed til tekstiler, keramik og garn.</p>`],
    ["Levering og retur", "levering-og-retur", `<p>Vi sender alle hverdage. Returnering sker til vores adresse i Aarhus — husk ordrenummer.</p>`],
    ["Kontakt", "kontakt", `<p>Skriv til os:</p>[contact-form-7 id="128" title="Kontaktformular"]`]
  ];
  for (const [title, slug, content] of pages) await C("wp/v2/pages", { title, slug, status: "publish", content });
  S.posts = posts.length;
  S.pages = pages.length;

  // ---------- final count ----------
  let productCount = 0;
  for (let page = 1; ; page++) {
    const rows = await api("GET", `wc/v3/products?per_page=100&page=${page}&status=any`);
    productCount += rows.length;
    if (rows.length < 100) break;
  }
  S.products = productCount;

  logger("real tier done");
  return S;
}
