/**
 * Generated Hostedshop catalogue fragments for DanDomain seed tiers.
 * SOAP Product_CreateOrUpdate / User_CreateOrUpdate / Order_Create shapes only.
 * Not Woo REST. Example Living fiction; bytes are DanDomain.
 */
const SENTINEL = "DDSEED-";

export const LADDER_COUNTS = Object.freeze({
  mediumProducts: 60,
  heavyProducts: 280,
  realGenProducts: 104,
  xlTailProducts: 230,
  xlYarnVariants: 120,
});

export function pad(n, w = 4) {
  return String(n).padStart(w, "0");
}

export function skuPart(s) {
  return String(s)
    .toUpperCase()
    .replaceAll("Æ", "AE")
    .replaceAll("Ø", "OE")
    .replaceAll("Å", "AA")
    .replace(/[^A-Z0-9]+/g, "");
}

export function descClean(txt) {
  return `<p>${txt}</p>\n<p>Fremstillet med omtanke i Danmark. Example Living, est. 2018.</p>`;
}

/** Word-paste HTML as a DescriptionLong string (Hostedshop merchants paste this). */
export function descWordPaste(txt) {
  return `<p class="MsoNormal" style="mso-margin-top-alt:auto;line-height:normal"><span style="font-size:11.0pt;font-family:Calibri,sans-serif">${txt} – “hygge” når det er bedst.<o:p></o:p></span></p><p class="MsoNormal">Mål og materiale: se specifikationer. Leveres i gavepose.</p>`;
}

/** Builder-ish leftover strings in DescriptionLong — not Woo shortcodes as a product. */
export function descBuilder(txt) {
  return `[et_pb_section fb_built="1" admin_label="sektion"][et_pb_row][et_pb_column type="4_4"][et_pb_text]<h2>Produktdetaljer</h2><p>${txt}</p>[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]`;
}

const DESCS = [descClean, descWordPaste, descBuilder];

const NOUNS = Object.freeze([
  ["plaid", "Plaid", "tekstiler", 449],
  ["pude", "Pude", "puder", 249],
  ["skaal", "Skål", "keramik", 179],
  ["noegle", "Nøgle", "garn", 59],
  ["bakke", "Bakke", "koekken", 299],
  ["viske", "Viskestykke", "tekstiler", 79],
  ["kop", "Kop", "keramik", 129],
  ["pind", "Strikkepind", "strikkepinde", 89],
]);

const COLORS = Object.freeze([
  "Grå", "Natur", "Støvet Blå", "Ærtegrøn", "Karry", "Rødbrun", "Sort", "Hvid", "Sennep", "Bølgeblå",
]);

const STREETS = Object.freeze([
  "Søndergade 14", "Åboulevarden 3, 2. th", "Græsvænget 21", "Nørrebrogade 55", "Østergade 9", "Bakkedraget 8",
]);
const CITIES = Object.freeze([
  ["Aarhus C", "8000"], ["København N", "2200"], ["Odense C", "5000"], ["Aalborg", "9000"], ["Vejle", "7100"], ["Rønne", "3700"],
]);
const FIRST = Object.freeze([
  "Anna", "Kirsten", "Jørgen", "Camilla", "Niels", "Lærke", "Ole", "Birgitte", "Rasmus", "Åse",
  "Per", "Ditte", "Bjørn", "Helle", "Kasper", "Ingrid", "Troels", "Maja", "Sofie", "Emil",
]);
const LAST = Object.freeze([
  "Jensen", "Holm", "Østergaard", "Lund", "Kjær", "Andersen", "Skovgaard", "Bruun", "Dam", "Nyborg",
]);
const B2B = Object.freeze([
  { company: "Hyggehjem I/S", cvr: "41290573", ean: "5790000000001" },
  { company: "Garn & Græs ApS", cvr: "35672918", ean: "5790000000002" },
  { company: "Fru Fjord Interiør", cvr: "39548201", ean: "5790000000003" },
]);

/** ~18 Example category rows. SOAP Category_CreateOrUpdate, not WP terms. */
export const BROHAVE_CATEGORIES = Object.freeze([
  { key: "bolig", title: "Bolig", description: "Alt til det hyggelige hjem." },
  { key: "tekstiler", title: "Tekstiler", parent: "bolig", description: "Plaider, puder og tekstiler." },
  { key: "plaider", title: "Plaider", parent: "tekstiler", description: "Plaider i uld og bomuld." },
  { key: "uld", title: "Uld", parent: "plaider" },
  { key: "bomuld", title: "Bomuld", parent: "plaider" },
  { key: "puder", title: "Puder", parent: "tekstiler" },
  { key: "gardiner", title: "Gardiner", parent: "tekstiler" },
  { key: "koekken", title: "Køkken", parent: "bolig" },
  { key: "keramik", title: "Keramik", parent: "koekken", description: "Stentøj og skåle til køkkenet." },
  { key: "garn", title: "Garn", description: "Garn til strik og hækling." },
  { key: "uldgarn", title: "Uldgarn", parent: "garn" },
  { key: "bomuldsgarn", title: "Bomuldsgarn", parent: "garn" },
  { key: "opskrifter", title: "Opskrifter", parent: "garn" },
  { key: "strikkepinde", title: "Strikkepinde", parent: "garn" },
  { key: "tilbehoer", title: "Tilbehør" },
  { key: "tilbehoer-2", title: "Tilbehoer" },
  { key: "strikke-tilbehoer", title: "Strikke-tilbehør", parent: "tilbehoer" },
  { key: "udsalg", title: "Udsalg", parent: "bolig" },
]);

export const YARN_COLORS = Object.freeze([
  "Sort", "Hvid", "Grå", "Navy", "Beige", "Rust", "Oliven", "Sennep", "Blå", "Natur",
]);

export const YARN_SIZES = Object.freeze([
  "50g", "100g", "150g", "200g", "250g", "300g", "2.5mm", "3mm", "3.5mm", "4mm", "5mm", "6mm",
]);

/** Discriminator from SOAP ItemNumber prefix so GEN vs XL SeoLinks do not collide. */
export function catalogTag(prefix) {
  const stripped = String(prefix || "").replace(/^DDSEED-P-/i, "").replace(/-+$/g, "");
  return stripped.toLowerCase().replace(/[^a-z0-9]+/g, "") || "gen";
}

export function generatedProducts({ prefix, count, categoryKeys, torture = false }) {
  const cats = categoryKeys?.length ? categoryKeys : ["bolig"];
  const tag = catalogTag(prefix);
  const out = [];
  for (let i = 0; i < count; i++) {
    const [key, noun, catHint, base] = NOUNS[i % NOUNS.length];
    const color = COLORS[i % COLORS.length];
    let title = `${noun} ${color} ${tag.toUpperCase()} ${pad(i + 1)}`;
    if (torture) {
      title = i % 3 === 0
        ? `Plaid Ærø “${color}” ${tag.toUpperCase()} ${pad(i + 1)}`
        : i % 3 === 1
          ? `Garn æøå ${color} ${tag.toUpperCase()} ${pad(i + 1)}`
          : title;
    }
    const body = `${noun} i farven ${color.toLowerCase()} — klassisk kvalitet fra Example Living.`;
    let description = DESCS[i % 3](body);
    if (torture && i % 5 === 0) {
      description = descBuilder(`${body} ${body} ${body} ${body} ${body} ${body} ${body} ${body}`);
    }
    const category = cats.includes(catHint) ? catHint : cats[i % cats.length];
    out.push({
      item: `${prefix}${pad(i + 1)}`,
      title,
      description,
      priceGross: base + (i % 7) * 10,
      vatGroupId: 1,
      seo: `${key}-${tag}-${pad(i + 1)}`,
      category,
      weight: 0.2 + (i % 8) / 10,
    });
  }
  return out;
}

export function generatedUsers({ prefix, count }) {
  return Array.from({ length: count }, (_, i) => {
    const [city, zip] = CITIES[i % CITIES.length];
    const b2b = i % 9 === 0 ? B2B[i % B2B.length] : null;
    return {
      username: `${prefix}${pad(i + 1, 2)}`,
      email: `${String(prefix).replace(/[^a-z0-9]+/gi, "").toLowerCase()}${pad(i + 1, 2)}@example.invalid`,
      first: FIRST[i % FIRST.length],
      last: i % 7 === 3 ? "" : LAST[i % LAST.length],
      address: STREETS[i % STREETS.length],
      zip,
      city,
      phone: i % 2 ? "23456789" : "+45 21 43 65 87",
      ...(b2b || {}),
    };
  });
}

export function generatedOrders({ prefix, count, guestEvery = 5 }) {
  return Array.from({ length: count }, (_, i) => {
    const kredit = i === 3 && count > 3;
    return {
      ref: `${prefix}${pad(i + 1, 2)}`,
      statusWalk: kredit ? [0, 99] : i % 4 === 3 ? [0, 2] : [0, 2, 3],
      paid: kredit ? false : i % 5 !== 4,
      lineNet: kredit ? -100 : 100,
      qty: 1 + (i % 3),
      mixedVat: i % 7 === 0,
      guest: i % guestEvery === 0,
      originRef: kredit ? `${prefix}${pad(1, 2)}` : undefined,
    };
  });
}

/** Named Hostedshop mess on dd-real (duplicate title, entity, zero price, SeoLink collision). */
export function awkwardRealProducts() {
  return [
    {
      item: `${SENTINEL}P-KOPI`,
      title: "Uldplaid Grå (kopi)",
      description: descClean("Klassisk uldplaid i grå — kopieret række efter en re-import."),
      priceGross: 125,
      vatGroupId: 1,
      seo: "uldplaid-graa-kopi",
      category: "plaider",
    },
    {
      item: `${SENTINEL}P-TAEPPE`,
      title: "Tæpper & Plaider – Prøvekollektion",
      description: descWordPaste("Prøvekollektion af tæpper og plaider."),
      priceGross: 349,
      vatGroupId: 1,
      seo: "taepper-plaider-proevekollektion",
      category: "tekstiler",
    },
    {
      item: `${SENTINEL}P-PROVE`,
      title: "Vareprøve: Garnkort",
      description: descClean("Gratis garnkort — pris 0 kr."),
      priceGross: 0,
      vatGroupId: 1,
      seo: "vareproeve-garnkort",
      category: "garn",
    },
    {
      item: `${SENTINEL}P-TILB`,
      title: "Tilbehørssæt",
      description: descClean("Vores mest solgte tilbehør — samlet ét sted."),
      priceGross: 189,
      vatGroupId: 1,
      seo: "tilbehoer",
      category: "tilbehoer",
    },
  ];
}

export function xlProbeProducts() {
  const oversize = `${descClean("Oversize DescriptionLong til Hostedshop-feltet. ")}`.repeat(350);
  return [
    {
      item: `${SENTINEL}P-XL-UNI`,
      title: "ウールプレード Æblegrød",
      description: descClean("Unicode-titel: japansk plus dansk æøå i SOAP Title/DescriptionLong."),
      priceGross: 199,
      vatGroupId: 1,
      seo: "uldplaid-unicode",
      category: "tekstiler",
      weight: 0.9,
    },
    {
      item: `${SENTINEL}P-XL-OVER`,
      title: "Katalogtekst lang",
      description: oversize,
      priceGross: 149,
      vatGroupId: 1,
      seo: "katalogtekst-lang",
      category: "bolig",
      weight: 0.4,
    },
    {
      item: `${SENTINEL}P-XL-P01`,
      title: "Pris 1 øre",
      description: descClean("Price-edge 0.01 som SOAP Product.Price (gross)."),
      priceGross: 0.01,
      vatGroupId: 1,
      seo: "pris-1-oere",
      category: "bolig",
    },
    {
      item: `${SENTINEL}P-XL-PHI`,
      title: "Pris loft",
      description: descClean("Price-edge 99999.95 som SOAP Product.Price (gross)."),
      priceGross: 99999.95,
      vatGroupId: 1,
      seo: "pris-loft",
      category: "bolig",
    },
  ];
}
