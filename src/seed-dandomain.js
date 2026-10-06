/**
 * DanDomain seed tiers (P4 / PLAN §6).
 * Upserts via *_CreateOrUpdate with sentinel ItemNumbers/Usernames.
 * Never gateway ops, never Order_Send*Email, never Order_UpdateStatus(1) (F37).
 * Paid: Order_SetTransactionCode with TransactionData.Status=1 (tx ≠ order status).
 * Line prices are NET (R1).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  LADDER_COUNTS,
  BROHAVE_CATEGORIES,
  generatedProducts,
  generatedUsers,
  generatedOrders,
  awkwardRealProducts,
  xlProbeProducts,
  YARN_COLORS,
  YARN_SIZES,
  skuPart,
  descClean as catalogDesc,
  descBuilder,
} from "./seed-dandomain-catalog.js";
import { graphqlOptionsFromEnv } from "./dandomain/client.js";

export { LADDER_COUNTS };

export const SENTINEL = "DDSEED-";

/** Probe `sentinels` only. Live pair config shopId is tenant `shop000000`; SOAP SolutionId matches that string. */
export function isScratchDanDomainShopId(id) {
  const v = s(id);
  return v === "105698" || v === "shop000000";
}

export const FORBIDDEN_SEED_OPS = Object.freeze([
  "Order_CompleteTransaction",
  "Order_CancelTransaction",
  "Order_LowerTransaction",
  "Order_SendEmail",
  "Order_SendStatusEmail",
  "Order_SendReceiptEmail",
  "Solution_SetEncoding",
]);

export const DD_TIERS = Object.freeze({
  "dd-light": { label: "DanDomain light scratch" },
  "dd-medium": { label: "DanDomain light + ~60 generated SOAP products" },
  "dd-heavy": { label: "DanDomain medium + ~280 generated + pathological Hostedshop content" },
  "dd-real": { label: "Example Hostedshop (standalone, messy client catalogue)" },
  "dd-real-xl": { label: "Example Hostedshop + scale (standalone; 120-variant yarn probe)" },
});

export const STANDALONE_DD_TIERS = new Set(["dd-real", "dd-real-xl"]);

export function assertSeedGates(cfg) {
  const rawSummary = cfg?.paths?.raw && path.join(cfg.paths.raw, "summary.json");
  if (rawSummary && existsSync(rawSummary) && cfg.source?.allowDestructive !== true) {
    throw new Error(
      `data/raw/summary.json exists for this pair — seed refuses unless source.allowDestructive: true ` +
        `(no CLI flag). This looks like a real migration source, not a scratch shop.`
    );
  }
}

function s(v) {
  return v == null ? "" : String(v).trim();
}

function arr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object" && v.item != null) return Array.isArray(v.item) ? v.item : [v.item];
  return [v];
}

async function assertShopIdentity(client, cfg) {
  const want = s(cfg.source?.dandomain?.shopId);
  if (!want) {
    throw new Error("shop-identity gate: source.dandomain.shopId is required before seeding");
  }
  const webinfo = (await client.call("Solution_GetWebinfo")).result || {};
  const got = s(webinfo.SolutionId);
  if (got !== want) {
    throw new Error(
      `shop-identity gate: config shopId ${want} disagrees with Solution_GetWebinfo SolutionId ${got || "(empty)"}`
    );
  }
  return webinfo;
}

/**
 * FTPS options from active config, else .env (DD_FTP_HOST / DD_FTP_USER / DD_FTP_PASSWORD).
 * Same fields export/doctor pass into createClient({ ftp }). Never logs secrets.
 */
export function ftpOptionsFromCfg(cfg) {
  const block = cfg?.source?.dandomain?.ftp;
  if (block && s(block.host) && s(block.user) && s(block.pass)) {
    return { ...block, host: s(block.host), user: s(block.user), pass: s(block.pass) };
  }
  const host = s(process.env.DD_FTP_HOST);
  const user = s(process.env.DD_FTP_USER);
  const pass = s(process.env.DD_FTP_PASSWORD);
  if (host && user && pass) return { host, user, pass };
  return null;
}

function wireFtpOptions(client, cfg) {
  if (!client) return;
  if (client.ftpOptions && s(client.ftpOptions.host) && s(client.ftpOptions.user) && s(client.ftpOptions.pass)) return;
  const opts = ftpOptionsFromCfg(cfg);
  if (opts) client.ftpOptions = opts;
}

function wireGraphqlOptions(client, cfg) {
  if (!client) return;
  if (client.graphqlOptions?.client || (client.graphqlOptions?.clientId && client.graphqlOptions?.clientSecret)) return;
  const opts = graphqlOptionsFromEnv(cfg?.source?.dandomain || {});
  if (opts) client.graphqlOptions = opts;
}

function descClean(txt) {
  return `<p>${txt}</p>\n<p>Fremstillet med omtanke i Danmark. Example Living, est. 2018.</p>`;
}

/** Product_CreateOrUpdate TypeLabel enum (WSDL ProductCreateUpdate has TypeLabel, not Type). */
const SOAP_PRODUCT_TYPES = Object.freeze([
  "normal",
  "file-sale",
  "gift-card-with-code",
  "gift-card-without-code",
  "discontinued",
  "call-for-price",
]);

function soapProductType(p) {
  if (p.type && SOAP_PRODUCT_TYPES.includes(p.type)) return p.type;
  if (p.typeLabel === "file-sale" || p.typeLabel === "filsalg") return "file-sale";
  return "normal";
}

/** Gross 125 @ 25% VAT → net 100 for order lines (R1). ItemNumbers stay DDSEED-* (upsert keys). */
const LIGHT = {
  categoryTitle: "Bolig",
  categories: [
    { key: "bolig", title: "Bolig", description: "Alt til det hyggelige hjem." },
  ],
  products: [
    {
      item: `${SENTINEL}P-SIMPLE`,
      title: "Uldplaid Grå",
      description: descClean("Klassisk uldplaid i grå — vores bestseller siden 2018."),
      priceGross: 125,
      vatGroupId: 1,
      seo: "uldplaid-graa",
      category: "bolig",
      weight: 0.6,
      seoKeywords: "uld,plaid,example",
      focusFrontpage: true,
    },
  ],
  users: [
    {
      username: `${SENTINEL}user-mette`,
      email: "mette-seed@example.invalid",
      first: "Mette",
      last: "Hansen",
      address: "Søndergade 14",
      zip: "8000",
      city: "Aarhus C",
      phone: "+45 21 43 65 87",
    },
  ],
  orders: [
    { ref: `${SENTINEL}ORD-001`, statusWalk: [0, 2, 3], paid: true, lineNet: 100, qty: 1 },
  ],
};

const REAL = {
  ...LIGHT,
  categories: [
    ...LIGHT.categories,
    { key: "tekstiler", title: "Tekstiler", parent: "bolig", description: "Plaider, puder og tekstiler." },
    { key: "keramik", title: "Keramik", description: "Stentøj og skåle til køkkenet." },
    { key: "garn", title: "Garn", description: "Garn til strik og hækling." },
  ],
  products: [
    ...LIGHT.products,
    {
      item: `${SENTINEL}P-AEOEAA`,
      title: "Plaid Ærø æøå",
      description: descClean("Plaid vævet på Ærø — æøå i titel og brødtekst, så encoding overlever eksport."),
      priceGross: 125,
      vatGroupId: 1,
      seo: "plaid-aeroe-aeoeaa",
      category: "tekstiler",
    },
    {
      item: `${SENTINEL}P-VAR`,
      title: "Sofapude merino",
      description: descClean("Sofapude i merinould. Varianten er det bevidste >3-dimensionelle probe."),
      priceGross: 200,
      vatGroupId: 1,
      variants: true,
      category: "tekstiler",
    },
    {
      item: `${SENTINEL}P-PAKKE`,
      title: "Gaveæske keramik",
      description: descClean("Gaveæske med stentøj — pakkeprodukt til Shopify bundle-advarsler."),
      priceGross: 300,
      vatGroupId: 1,
      bundle: true,
      type: "normal",
      relatedItem: `${SENTINEL}P-SIMPLE`,
      category: "keramik",
    },
    {
      item: `${SENTINEL}P-0VAT`,
      title: "Strikkeopskrift: Example Plaid (PDF)",
      description: descClean("Digital strikkeopskrift som PDF. Momsgruppe 0 % på denne linje."),
      priceGross: 80,
      vatGroupId: 2,
      type: "file-sale",
      weight: 0,
      seo: "strikkeopskrift-example-plaid",
      category: "garn",
    },
    {
      item: `${SENTINEL}P-2DIM`,
      title: "Plaid Farve × Størrelse",
      description: descClean("Uldplaid med to variantakser: Farve og Størrelse."),
      priceGross: 199,
      vatGroupId: 1,
      twoDim: true,
      seo: "ddseed-p-2dim",
      category: "tekstiler",
    },
    {
      item: `${SENTINEL}P-SKAAL`,
      title: "Skål stentøj",
      description: descClean("Hånddrejet skål i stentøj — klassisk kvalitet fra Example Living."),
      priceGross: 179,
      vatGroupId: 1,
      seo: "skaal-stentoej",
      category: "keramik",
    },
    {
      item: `${SENTINEL}P-NOGLE`,
      title: "Nøgle merino",
      description: descClean("Nøgle merinould til strik og hækling."),
      priceGross: 59,
      vatGroupId: 1,
      seo: "noegle-merino",
      category: "garn",
    },
    {
      item: `${SENTINEL}P-BAKKE`,
      title: "Bakke eg",
      description: descClean("Bakke i massiv eg til køkkenet."),
      priceGross: 299,
      vatGroupId: 1,
      seo: "bakke-eg",
      category: "bolig",
    },
    {
      item: `${SENTINEL}P-VISKE`,
      title: "Viskestykke hør",
      description: descClean("Viskestykke i hør — vaskes varmt, holder farven."),
      priceGross: 79,
      vatGroupId: 1,
      seo: "viskestykke-hoer",
      category: "tekstiler",
    },
    {
      item: `${SENTINEL}P-KASTANJE`,
      title: "Designerplaid Kastanje",
      description: descClean("Eksklusivt designerplaid i kastanjebrun — kun få eksemplarer."),
      priceGross: 1249,
      vatGroupId: 1,
      seo: "designerplaid-kastanje",
      category: "tekstiler",
    },
    {
      item: `${SENTINEL}P-HYGGE`,
      title: "Hyggeplaid Meleret",
      description: descClean("Hyggeplaid i meleret uld — “hygge” når det er bedst."),
      priceGross: 489,
      vatGroupId: 1,
      seo: "hyggeplaid-meleret",
      category: "tekstiler",
    },
  ],
  users: [
    ...LIGHT.users,
    {
      username: `${SENTINEL}user-b2b`,
      email: "b2b-seed@example.invalid",
      first: "Søren",
      last: "Møller",
      company: "Nordisk Bolig ApS",
      cvr: "38119482",
      ean: "5790000000000",
      groupId: 7,
      address: "Åboulevarden 3, 2. th",
      zip: "8000",
      city: "Aarhus C",
      phone: "23456789",
    },
  ],
  orders: [
    ...LIGHT.orders,
    { ref: `${SENTINEL}ORD-MIX`, statusWalk: [0, 2], paid: true, lineNet: 100, qty: 2, mixedVat: true },
    { ref: `${SENTINEL}ORD-PARENT`, statusWalk: [0, 3], paid: true, lineNet: 100, qty: 1 },
    { ref: `${SENTINEL}ORD-KREDIT`, statusWalk: [0, 99], paid: false, lineNet: -100, qty: 1, originRef: `${SENTINEL}ORD-PARENT` },
    { ref: `${SENTINEL}ORD-HYGGE`, statusWalk: [0, 2, 3], paid: true, lineNet: 100, qty: 1 },
  ],
};

function mediumPlan() {
  return {
    ...LIGHT,
    completeness: false,
    xl: false,
    products: [
      ...LIGHT.products,
      ...generatedProducts({ prefix: `${SENTINEL}P-M-`, count: LADDER_COUNTS.mediumProducts, categoryKeys: ["bolig"] }),
    ],
    users: [
      ...LIGHT.users,
      ...generatedUsers({ prefix: `${SENTINEL}user-m-`, count: 10 }),
    ],
    orders: [
      ...LIGHT.orders,
      ...generatedOrders({ prefix: `${SENTINEL}ORD-M-`, count: 12 }),
    ],
  };
}

function heavyPlan() {
  const mid = mediumPlan();
  return {
    ...mid,
    products: [
      ...mid.products,
      ...generatedProducts({
        prefix: `${SENTINEL}P-H-`,
        count: LADDER_COUNTS.heavyProducts,
        categoryKeys: ["bolig"],
        torture: true,
      }),
      {
        item: `${SENTINEL}P-H-MONSTER`,
        title: "Garn monster fire akser",
        description: descBuilder("Pathological >3-dimensionelt variantprobe — Hostedshop tillader flere akser end Shopify viser pent."),
        priceGross: 159,
        vatGroupId: 1,
        seo: "garn-monster-fire-akser",
        category: "bolig",
        multiDim: 4,
      },
    ],
    users: [...mid.users, ...generatedUsers({ prefix: `${SENTINEL}user-h-`, count: 20 })],
    orders: [...mid.orders, ...generatedOrders({ prefix: `${SENTINEL}ORD-H-`, count: 25 })],
  };
}

function realPlan(xl) {
  return {
    ...REAL,
    categories: [...BROHAVE_CATEGORIES],
    products: [
      ...REAL.products,
      ...awkwardRealProducts(),
      ...generatedProducts({
        prefix: `${SENTINEL}P-GEN-`,
        count: LADDER_COUNTS.realGenProducts,
        categoryKeys: BROHAVE_CATEGORIES.map((c) => c.key),
      }),
    ],
    users: [
      ...REAL.users,
      ...generatedUsers({ prefix: `${SENTINEL}user-gen-`, count: 38 }),
    ],
    orders: [
      ...REAL.orders,
      ...generatedOrders({ prefix: `${SENTINEL}ORD-GEN-`, count: 50, guestEvery: 5 }),
    ],
    completeness: true,
    xl: xl === true,
  };
}

function planFor(tier) {
  if (tier === "dd-light") return { ...LIGHT, completeness: false, xl: false };
  if (tier === "dd-medium") return mediumPlan();
  if (tier === "dd-heavy") return heavyPlan();
  if (tier === "dd-real") return realPlan(false);
  if (tier === "dd-real-xl") return realPlan(true);
  return null;
}

const TWO_DIM_VARIANTS = Object.freeze([
  { color: "Sort", size: "Small", sku: `${SENTINEL}P-2DIM-SORT-S`, price: 199, stock: 3 },
  { color: "Sort", size: "Medium", sku: `${SENTINEL}P-2DIM-SORT-M`, price: 209, stock: 5 },
  { color: "Sort", size: "Large", sku: `${SENTINEL}P-2DIM-SORT-L`, price: 219, stock: 7 },
  { color: "Hvid", size: "Small", sku: `${SENTINEL}P-2DIM-HVID-S`, price: 189, stock: 2 },
  { color: "Hvid", size: "Medium", sku: `${SENTINEL}P-2DIM-HVID-M`, price: 199, stock: 4 },
  { color: "Hvid", size: "Large", sku: `${SENTINEL}P-2DIM-HVID-L`, price: 209, stock: 6 },
]);

const PRODUCT_SEO = Object.freeze({
  SeoTitle: "Plaid Farve × Størrelse | Example Living",
  SeoDescription: "Køb Plaid Farve × Størrelse hos Example Living. FIELD_SET_TRUNCATED round-trip",
  SeoLink: "ddseed-p-2dim",
});

const PIC_FILES = Object.freeze([
  { file: "ddseed-2dim-1.png", sorting: 1, alt: "Uldplaid sort — overblik" },
  { file: "ddseed-2dim-2.png", sorting: 2, alt: "Uldplaid hvid — detalje" },
  { file: "ddseed-2dim-3.png", sorting: 3, alt: "Uldplaid foldet på sofa" },
]);

const LETTER_COUPON = Object.freeze({
  Title: "Example Living — ukendt rabattype (x)",
  Type: "x",
  Value: 10,
  Code: `${SENTINEL}COUPON-X`,
  UseCount: 0,
  Limit: 100,
  DateExpire: "2030-12-31 23:59:59",
  DateCreated: "2026-08-17 12:00:00",
  IsActive: true,
});

const WORD_COUPONS = Object.freeze([
  { Title: "Example 10%", Type: "percent", Value: 10, Code: `${SENTINEL}COUPON-PERCENT` },
  { Title: "Example 25 kr", Type: "amount", Value: 25, Code: `${SENTINEL}COUPON-AMOUNT` },
]);

/** PageTextUpdate in the WSDL has no SeoTitle/SeoDescription/SeoLink — read type PageText does. */
export const PAGE_SEO_SKIP_REASON =
  "PageText_Update WSDL type PageTextUpdate has no SeoTitle/SeoDescription/SeoLink (operations.js PageTextUpdate fields). PageText read type has those columns. Not forced.";

// 1×1 PNG — distinct filenames, same bytes. Never written under _thumbs/ or placeholders/.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function resultId(res) {
  if (res == null) return 0;
  if (typeof res === "object") return Number(res.result ?? res.Id ?? 0);
  return Number(res);
}

async function upsertVariantType(client, title) {
  const res = await client.call("Product_CreateOrUpdateVariantType", {
    VariantTypeData: { LanguageISO: "DK", Title: title, Sorting: 0 },
  });
  return resultId(res);
}

async function upsertVariantValue(client, typeId, title) {
  const res = await client.call("Product_CreateOrUpdateVariantTypeValue", {
    VariantTypeValueData: {
      LanguageISO: "DK",
      Title: title,
      ProductVariantTypeId: Number(typeId),
      Sorting: 0,
    },
  });
  return resultId(res);
}

async function seedTwoDimVariants(client, productId, p, logger) {
  const colorTypeId = await upsertVariantType(client, "Farve");
  const sizeTypeId = await upsertVariantType(client, "Størrelse");
  if (!colorTypeId || !sizeTypeId) {
    logger(`two-dim skip ${p.item}: VariantType upsert returned no Id`);
    return;
  }
  const colorIds = new Map();
  const sizeIds = new Map();
  for (const name of ["Sort", "Hvid"]) colorIds.set(name, await upsertVariantValue(client, colorTypeId, name));
  for (const name of ["Small", "Medium", "Large"]) sizeIds.set(name, await upsertVariantValue(client, sizeTypeId, name));
  for (const v of TWO_DIM_VARIANTS) {
    const cId = colorIds.get(v.color);
    const sId = sizeIds.get(v.size);
    if (!cId || !sId) {
      logger(`two-dim skip ${v.sku}: missing type value ids`);
      continue;
    }
    const variantData = {
      ProductId: Number(productId),
      ItemNumber: v.sku,
      Price: v.price,
      Stock: v.stock,
      Status: 1,
      Weight: 0.55,
      VariantTypeValues: { item: [cId, sId] },
    };
    await client.call("Product_CreateOrUpdateVariant", { VariantData: variantData });
    logger(`variant ${v.sku}`);
  }
}

async function seedMultiDimVariants(client, productId, p, logger) {
  try {
    const typeTitles = ["Kulør", "Længde", "Fiber", "Snoning"].slice(0, Number(p.multiDim) || 4);
    const valueIds = [];
    for (const title of typeTitles) {
      const typeId = await upsertVariantType(client, title);
      if (!typeId) continue;
      const vid = await upsertVariantValue(client, typeId, `${title}-1`);
      if (vid) valueIds.push(vid);
    }
    if (valueIds.length < 4) {
      logger(`multi-dim skip ${p.item}: fewer than 4 type values`);
      return;
    }
    await client.call("Product_CreateOrUpdateVariant", {
      VariantData: {
        ProductId: Number(productId),
        ItemNumber: `${p.item}-V1`,
        Price: p.priceGross,
        Status: 1,
        VariantTypeValues: { item: valueIds },
      },
    });
    logger(`multi-dim ${p.item} axes ${valueIds.length}`);
  } catch (e) {
    logger(`multi-dim probe ${p.item}: ${e.message}`);
  }
}

async function seedProductSeo(client, productId, logger) {
  await client.call("Product_Update", {
    ProductData: {
      Id: Number(productId),
      ItemNumber: `${SENTINEL}P-2DIM`,
      LanguageISO: "DK",
      ...PRODUCT_SEO,
    },
  });
  let read = null;
  try {
    await client.call("Product_SetFields", {
      Fields: "Id,ItemNumber,Title,SeoTitle,SeoDescription,SeoLink",
    });
    const got = arr((await client.call("Product_GetByItemNumber", { ItemNumber: `${SENTINEL}P-2DIM` })).result);
    read = got[0] || null;
  } catch (e) {
    logger(`SEO re-query failed: ${e.message}`);
  }
  const roundTrip = read
    ? {
        SeoTitle: s(read.SeoTitle),
        SeoDescription: s(read.SeoDescription),
        SeoLink: s(read.SeoLink),
      }
    : null;
  logger(`product SEO update ${SENTINEL}P-2DIM`);
  return roundTrip;
}

/** ASCII FileName from a DDSEED ItemNumber. Same PNG bytes, unique name per product. */
function pictureFileName(itemNumber) {
  const slug = String(itemNumber)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}.png`;
}

function picturesForProduct(item, title) {
  if (item === `${SENTINEL}P-2DIM`) return PIC_FILES;
  return [{ file: pictureFileName(item), sorting: 1, alt: String(title || item) }];
}

/** ProFTPD control sessions die around ~60s / many STOR (live dd-real-xl, two ECONNRESET). */
const FTPS_STOR_PER_SESSION = 20;
const FTP_RESET_RE = /ECONNRESET|ETIMEDOUT|EPIPE|ECONNABORTED|socket hang up|session is broken/i;

function isFtpResetError(e) {
  const code = e?.code != null ? String(e.code) : "";
  const msg = e?.message != null ? String(e.message) : String(e);
  return FTP_RESET_RE.test(code) || FTP_RESET_RE.test(msg);
}

function closeFtp(client) {
  try { client.ftp().quit(); } catch { /* quit is best-effort */ }
}

async function seedCataloguePictures(client, productIds, productTitles, logger, summary) {
  summary.pictures = 0;
  if (typeof client.ftp !== "function") {
    logger("pictures skip: no client.ftp()");
    return;
  }
  let session;
  let storOnSession = 0;
  async function openSession() {
    closeFtp(client);
    session = await client.ftp().connect();
    storOnSession = 0;
  }
  try {
    await openSession();
  } catch (e) {
    logger(`pictures skip: FTPS connect failed (${e.message})`);
    return;
  }
  try {
    for (const [item, productId] of productIds) {
      const specs = picturesForProduct(item, productTitles.get(item));
      let existing = [];
      try {
        existing = arr((await client.call("Product_GetPictures", { ProductId: Number(productId) })).result);
      } catch {
        existing = [];
      }
      const have = new Set(existing.map((p) => s(p.FileName)));
      for (const pic of specs) {
        if (have.has(pic.file)) {
          logger(`picture ${pic.file} already bound — skip CreatePicture`);
          continue;
        }
        if (storOnSession >= FTPS_STOR_PER_SESSION) {
          logger(`picture FTPS session rotated after ${storOnSession} STOR`);
          await openSession();
        }
        try {
          await session.xferOut(`STOR /pics/${pic.file}`, PNG_1X1);
          storOnSession += 1;
        } catch (e) {
          if (!isFtpResetError(e)) throw e;
          logger(`picture STOR reset (${e.message}) — reconnect`);
          await openSession();
          await session.xferOut(`STOR /pics/${pic.file}`, PNG_1X1);
          storOnSession += 1;
        }
        await client.call("Product_CreatePicture", {
          PictureData: {
            ProductId: Number(productId),
            FileName: pic.file,
            Sorting: pic.sorting,
            ImageAltTexts: { item: { Text: pic.alt, LanguageAccess: "DK_1" } },
          },
        });
        summary.pictures += 1;
        logger(`picture ${pic.file} sorting ${pic.sorting}`);
      }
    }
  } finally {
    closeFtp(client);
  }
}

async function seedTwoDimVariantPicture(client, productId, logger) {
  let pics = [];
  try {
    pics = arr((await client.call("Product_GetPictures", { ProductId: Number(productId) })).result);
  } catch {
    pics = [];
  }
  const first = pics[0];
  const picId = Number(first?.Id);
  if (!picId) {
    logger(`variant PictureId skip ${TWO_DIM_VARIANTS[0].sku}: no picture Id`);
    return;
  }
  await client.call("Product_UpdateVariant", {
    VariantData: {
      ProductId: Number(productId),
      ItemNumber: TWO_DIM_VARIANTS[0].sku,
      PictureId: picId,
      Weight: 0.55,
    },
  });
  logger(`variant ${TWO_DIM_VARIANTS[0].sku} PictureId ${picId}`);
}

async function seedLetterCoupon(client, logger) {
  let existing = [];
  try {
    existing = arr((await client.call("Discount_GetAll")).result);
  } catch {
    existing = [];
  }
  if (existing.some((d) => s(d.Code) === LETTER_COUPON.Code)) {
    logger(`coupon ${LETTER_COUPON.Code} already seeded — skip create`);
    return { created: 0, skipped: 1 };
  }
  await client.call("Discount_Create", { DiscountData: { ...LETTER_COUPON } });
  logger(`coupon ${LETTER_COUPON.Code} type ${LETTER_COUPON.Type}`);
  return { created: 1, skipped: 0 };
}

async function seedWordCoupons(client, logger, summary) {
  const existing = arr((await client.call("Discount_GetAll")).result);
  summary.wordCoupons = [];
  for (const row of WORD_COUPONS) {
    if (existing.some((d) => s(d.Code) === row.Code)) {
      logger(`coupon ${row.Code} already seeded — skip`);
      summary.wordCoupons.push({ code: row.Code, created: 0, storedType: s(existing.find((d) => s(d.Code) === row.Code)?.Type) });
      continue;
    }
    await client.call("Discount_Create", {
      DiscountData: {
        ...row,
        UseCount: 0,
        Limit: 100,
        DateExpire: "2030-12-31 23:59:59",
        DateCreated: "2026-08-18 12:00:00",
        IsActive: true,
      },
    });
    const again = arr((await client.call("Discount_GetAll")).result);
    const stored = s(again.find((d) => s(d.Code) === row.Code)?.Type);
    logger(`coupon ${row.Code} sent Type ${row.Type} stored ${stored}`);
    summary.wordCoupons.push({ code: row.Code, created: 1, storedType: stored });
  }
}

const PAGE_LINK = "ddseed-page-handel";

/**
 * PageText.CategoryId is a page-folder id (GetByFolder FolderId), not a product
 * Category_CreateOrUpdate id. There is no PageText_GetAll (R15 / operations.js).
 * Copy a working CategoryId from an existing CMS page.
 */
async function recordedPageFolderCategoryId(client) {
  try {
    await client.call("PageText_SetFields", { Fields: "Id,CategoryId,ParentId,Link,Title" });
  } catch {
    /* default projection is Id-only; GetByFolder still runs */
  }
  const max = 20;
  for (let folderId = 0; folderId <= max; folderId++) {
    let rows = [];
    try {
      rows = arr((await client.call("PageText_GetByFolder", { FolderId: folderId })).result);
    } catch {
      continue;
    }
    for (const pg of rows) {
      const cid = Number(pg?.CategoryId);
      if (cid > 0) return cid;
    }
  }
  throw new Error(
    "PageText_Create needs a recorded page-folder CategoryId from PageText_GetByFolder (R15) — product Category_CreateOrUpdate ids are not PageText parents",
  );
}

async function seedDeliveryAndPunch(client, productIds, logger, summary) {
  let existingDt = [];
  try {
    existingDt = arr((await client.call("Product_GetDeliveryTimeAll")).result);
  } catch {
    existingDt = [];
  }
  const hitDt = existingDt.find((d) => s(d.TitleInStock) === "1-2 hverdage" && s(d.TitleNoStock) === "2-3 uger");
  let dtId = Number(hitDt?.Id) || 0;
  if (dtId) {
    logger("delivery time already seeded — skip create");
    summary.deliveryTimes = 1;
  } else {
    const dt = await client.call("Product_CreateDeliveryTime", {
      DeliveryTimeData: {
        LanguageISO: "DK",
        Sorting: 0,
        TitleInStock: "1-2 hverdage",
        TitleNoStock: "2-3 uger",
      },
    });
    dtId = resultId(dt);
    summary.deliveryTimes = dtId ? 1 : 0;
  }
  const simpleId = productIds.get(`${SENTINEL}P-SIMPLE`);
  if (dtId && simpleId) {
    await client.call("Product_Update", {
      ProductData: {
        Id: Number(simpleId),
        ItemNumber: `${SENTINEL}P-SIMPLE`,
        LanguageISO: "DK",
        DeliveryTimeId: Number(dtId),
      },
    });
  }

  let ebCats = [];
  try {
    ebCats = arr((await client.call("Product_GetAllExtraBuyCategory")).result);
  } catch {
    ebCats = [];
  }
  const hitEb = ebCats.find((c) => s(c.Title) === "DDSEED Køb også");
  let catId = Number(hitEb?.Id) || 0;
  if (catId) {
    logger("ExtraBuy category already seeded — skip create");
  } else {
    const cat = await client.call("Product_CreateExtraBuyCategory", {
      ExtraBuyCategoryData: { LanguageISO: "DK", Title: "DDSEED Køb også", ParentId: 0, Sorting: 0 },
    });
    catId = resultId(cat);
  }
  const relTo = productIds.get(`${SENTINEL}P-SKAAL`);
  let rels = [];
  try {
    rels = simpleId
      ? arr((await client.call("Product_GetExtraBuyRelations", { ProductId: Number(simpleId) })).result)
      : [];
  } catch {
    rels = [];
  }
  const alreadyRel = rels.some(
    (r) => Number(r.RelationProductId) === Number(relTo) && Number(r.ExtraBuyCategoryId) === Number(catId),
  );
  if (alreadyRel) {
    summary.extraBuy = 1;
    logger("ExtraBuy relation already seeded — skip");
  } else if (catId && simpleId && relTo) {
    await client.call("Product_CreateExtraBuyRelation", {
      ExtraBuyRelationData: {
        ProductId: Number(simpleId),
        RelationProductId: Number(relTo),
        ExtraBuyCategoryId: Number(catId),
        Sorting: 0,
      },
    });
    summary.extraBuy = 1;
  } else {
    summary.extraBuy = 0;
  }

  let hit = null;
  try {
    hit = (await client.call("PageText_GetByLink", { PageTextLink: PAGE_LINK })).result;
  } catch {
    hit = null;
  }
  const pageExists = hit && (s(hit.Link) === PAGE_LINK || Number(hit.Id) > 0);
  if (pageExists) {
    logger(`page ${PAGE_LINK} already seeded — skip`);
    summary.pages = 1;
  } else {
    const recordedCategoryId = await recordedPageFolderCategoryId(client);
    await client.call("PageText_Create", {
      PageTextData: {
        // WSDL PageTextCreate requires both (operations.js). Live: "Either
        // CategoryId or ParentId must be set" — 0 is unset. CategoryId is a
        // page-folder id copied from PageText_GetByFolder (R15), never a
        // product Category_CreateOrUpdate id (Bolig 11 is not a PageText parent).
        // ParentId 0 is the page-tree root in fixtures/dandomain/raw/pages.json.
        CategoryId: recordedCategoryId,
        Sorting: 0,
        ParentId: 0,
        Visible: 1,
        ShowInMenu: true,
        UpdatedDate: "2026-08-18 12:00:00",
        LanguageISO: "DK",
        Title: "Handel og levering",
        Headline: "Handel og levering",
        Link: PAGE_LINK,
        Text: "<p>Example Living — handel, levering og retur. Seedet side til CMS-eksport i København.</p>",
      },
    });
    summary.pages = 1;
  }

  let types = [];
  try {
    types = arr((await client.call("Product_GetAdditionalTypesAll")).result);
  } catch {
    types = [];
  }
  summary.tilvalgAttached = 0;
  if (types.length && simpleId) {
    await client.call("Product_AddAdditionalType", {
      ProductId: Number(simpleId),
      AdditionalTypeId: Number(types[0].Id),
    });
    summary.tilvalgAttached = 1;
  } else {
    logger("tilvalg skip: Product_GetAdditionalTypesAll returned 0 types (no CreateAdditionalType in WSDL)");
  }
}

async function seedB2bGroupPrice(client, productIds, logger, summary) {
  const groups = arr((await client.call("User_GetGroupAll")).result);
  let groupId = Number(groups.find((g) => s(g.Title) === "DDSEED B2B")?.Id);
  if (!groupId) {
    groupId = resultId(await client.call("User_CreateGroup", {
      UserGroupData: {
        Description: "Seeded B2B login group for SHOPLIFT completeness",
        ParentId: 0,
        Producer: false,
        LanguageISO: "DK",
        Title: "DDSEED B2B",
        Sorting: 0,
      },
    }));
  }
  summary.b2bGroupId = groupId;
  const simpleId = productIds.get(`${SENTINEL}P-SIMPLE`);
  let existing = [];
  try {
    existing = arr((await client.call("Product_GetDiscounts", { ProductId: Number(simpleId) })).result);
  } catch {
    existing = [];
  }
  const already = existing.some((d) => s(d.UserType) === "group" && Number(d.UserId) === Number(groupId));
  if (!already && simpleId && groupId) {
    await client.call("Product_CreateDiscount", {
      ProductDiscountData: {
        ProductId: Number(simpleId),
        ProductVariantId: 0,
        Amount: 1,
        Price: 150,
        Discount: 0,
        Currency: "DKK",
        DiscountType: "a",
        UserType: "group",
        UserId: Number(groupId),
        Date: false,
        DateFrom: "0000-00-00 00:00:00",
        DateTo: "0000-00-00 00:00:00",
        Accumulate: false,
      },
    });
    summary.b2bPrices = 1;
  } else {
    summary.b2bPrices = 0;
    logger("B2B group price already present — skip");
  }
  return groupId;
}

async function seedUkLayer(client, productIds, logger, summary) {
  const langs = arr((await client.call("Solution_GetLanguages")).result);
  const secondary = langs.find((l) => {
    const iso = s(l.LanguageISO).toUpperCase();
    return iso && iso !== "DK";
  });
  if (!secondary) {
    summary.i18n = 0;
    logger("i18n skip: shop has no secondary language layer (F13: cannot create)");
    return;
  }
  const iso = s(secondary.LanguageISO);
  await client.call("Solution_SetLanguage", { LanguageISO: iso });
  const pid = productIds.get(`${SENTINEL}P-SIMPLE`);
  await client.call("Product_Update", {
    ProductData: {
      Id: Number(pid),
      ItemNumber: `${SENTINEL}P-SIMPLE`,
      LanguageISO: iso,
      Title: "Grey wool throw",
      DescriptionLong: "<p>Classic grey wool throw.</p>",
    },
  });
  await client.call("Solution_SetLanguage", { LanguageISO: "DK" });
  summary.i18n = 1;
  logger(`i18n UK-layer title written under ${iso}`);
}

const BLOG_SENTINELS = Object.freeze([
  {
    title: `${SENTINEL}BLOG-HYGGE`,
    text: "<p>Hygge i stuen med ægte grå uldplaid og hør. Example Living nyhed.</p>",
    pageType: "BLOG",
    pageTitle: `${SENTINEL}PAGE-BLOG`,
    pageLink: "ddseed-page-blog",
  },
  {
    title: `${SENTINEL}NEWS-VELKOMMEN`,
    text: "<p>Velkommen til Example Living. Tæpper, skåle og nøgler.</p>",
    pageType: "NEWS",
    pageTitle: `${SENTINEL}PAGE-NEWS`,
    pageLink: "ddseed-page-news",
  },
]);

function blogPostTitles(rows) {
  const out = [];
  for (const row of rows || []) {
    const layers = Array.isArray(row.translations) ? row.translations : (row.translations ? [row.translations] : []);
    for (const layer of layers) {
      const t = layer?.data?.title || layer?.title;
      if (t) out.push(String(t));
    }
  }
  return out;
}

function pageTranslationTitles(page) {
  const layers = Array.isArray(page?.translations) ? page.translations : (page?.translations ? [page.translations] : []);
  return layers.map((layer) => String(layer?.data?.title || layer?.title || "")).filter(Boolean);
}

function pickLanguageId(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const dk = list.find((r) => String(r?.iso || "").toUpperCase() === "DK");
  const primary = list.find((r) => r?.primary);
  const hit = dk || primary || list[0];
  return hit?.id != null ? String(hit.id) : null;
}

function pickPageId(pages, pageType, sentinelTitle) {
  const list = Array.isArray(pages) ? pages : [];
  const typed = list.filter((p) => String(p?.type || "") === pageType);
  const sentinel = typed.find((p) => pageTranslationTitles(p).some((t) => t === sentinelTitle || t.includes(sentinelTitle)));
  const hit = sentinel || typed[0];
  return hit?.id != null ? String(hit.id) : null;
}

function firstAddedBy(rows) {
  for (const row of rows || []) {
    if (row?.addedBy) return String(row.addedBy);
  }
  return null;
}

async function seedBlogPosts(client, logger, summary) {
  summary.blogMutation = null;
  summary.blogPosts = 0;
  summary.blogPostsSkipped = 0;
  summary.blogPagesCreated = [];
  let gql;
  try {
    gql = typeof client.graphql === "function" ? client.graphql() : null;
  } catch (e) {
    summary.blog = { skipped: true, reason: e.message };
    logger(`blog seed skipped: ${e.message}`);
    return;
  }
  if (!gql?.execute) {
    summary.blog = { skipped: true, reason: "GraphQL client missing" };
    logger("blog seed skipped: GraphQL client missing");
    return;
  }

  let fields = [];
  try {
    const intro = await gql.execute({
      endpoint: "experimental",
      document: "{ __schema { mutationType { fields { name } } } }",
    });
    fields = (intro.data?.__schema?.mutationType?.fields || []).map((f) => f.name);
  } catch (e) {
    summary.blog = { skipped: true, reason: e.message };
    logger(`blog seed: mutationType introspect failed (${e.message})`);
    return;
  }
  const mutationName = fields.find((n) => n === "blogPostCreate") || fields.find((n) => /^blogPostCreate$/i.test(n)) || null;
  summary.blogMutation = mutationName;
  if (!mutationName) {
    const blogMuts = fields.filter((n) => /blog/i.test(n));
    summary.blog = { skipped: true, reason: "blogPostCreate recorded absent", mutationNames: blogMuts };
    logger(`blog seed: blogPostCreate recorded absent${blogMuts.length ? ` (saw ${blogMuts.join(", ")})` : ""}`);
    return;
  }

  let existingRows = [];
  let existing = [];
  try {
    if (typeof gql.query === "function") {
      const res = await gql.query("blogPosts", {
        endpoint: "experimental",
        selection: "id addedBy pageId translations { data { title } }",
      });
      existingRows = res?.rows ?? res?.content?.data ?? res?.data ?? [];
      existing = blogPostTitles(existingRows);
    }
  } catch (e) {
    logger(`blog seed: blogPosts query failed (${e.message}) — will still attempt create`);
  }

  const pending = BLOG_SENTINELS.filter((post) => !existing.some((t) => t === post.title || t.includes(post.title)));
  if (pending.length === 0) {
    summary.blogPosts = BLOG_SENTINELS.length;
    summary.blogPostsSkipped = BLOG_SENTINELS.length;
    logger("blog seed: sentinel titles already present — skip");
    return;
  }

  let languageId = null;
  try {
    const langRes = await gql.execute({
      endpoint: "experimental",
      document: "{ languages(input: {}) { content { id iso name primary } errors { __typename } } }",
    });
    languageId = pickLanguageId(langRes.data?.languages?.content);
  } catch (e) {
    summary.blog = { ...(summary.blog || {}), fault: `languageId: ${e.message}` };
    logger(`blog seed: languages query failed (${e.message})`);
    return;
  }
  if (!languageId) {
    summary.blog = { ...(summary.blog || {}), fault: "languages query returned no id" };
    logger("blog seed: no languageId");
    return;
  }
  summary.blogLanguageId = languageId;

  let pages = [];
  try {
    const pageRes = await gql.execute({
      endpoint: "experimental",
      document: "{ pages(input: {}) { content { id type translations { data { title } } } errors { __typename } } }",
    });
    pages = pageRes.data?.pages?.content ?? [];
  } catch (e) {
    summary.blog = { ...(summary.blog || {}), fault: `pages: ${e.message}` };
    logger(`blog seed: pages query failed (${e.message})`);
    return;
  }

  let addedBy = firstAddedBy(existingRows);
  if (!addedBy) {
    try {
      const userRes = await gql.execute({
        endpoint: "experimental",
        document: "{ users(pagination: { limit: 5, page: 1 }) { data { username } pagination { total } } }",
      });
      const uname = (userRes.data?.users?.data || []).map((u) => u?.username).find(Boolean);
      if (uname) addedBy = String(uname);
    } catch (e) {
      logger(`blog seed: users query failed (${e.message})`);
    }
  }
  if (!addedBy) addedBy = "DDSEED";
  summary.blogAddedBy = addedBy;

  const pageIds = new Map();
  for (const post of pending) {
    if (pageIds.has(post.pageType)) continue;
    let pageId = pickPageId(pages, post.pageType, post.pageTitle);
    if (!pageId) {
      try {
        const created = await gql.execute({
          endpoint: "experimental",
          document: "mutation PageCreate($input: PageCreateInput!) { pageCreate(input: $input) { content { id type } errors { __typename } } }",
          variables: {
            input: {
              type: post.pageType,
              translations: [{ data: { title: post.pageTitle, link: post.pageLink }, languageId }],
            },
          },
        });
        const payload = created.data?.pageCreate;
        if (payload?.errors?.length) {
          throw new Error(`pageCreate ${post.pageType} payload errors`);
        }
        pageId = payload?.content?.id != null ? String(payload.content.id) : null;
        if (!pageId) throw new Error(`pageCreate ${post.pageType} returned no id`);
        pages.push({ id: pageId, type: post.pageType, translations: [{ data: { title: post.pageTitle } }] });
        summary.blogPagesCreated.push({ type: post.pageType, id: pageId, title: post.pageTitle });
        logger(`blog seed: created host page ${post.pageTitle} (${post.pageType}) -> ${pageId}`);
      } catch (e) {
        summary.blog = { ...(summary.blog || {}), fault: e.message };
        logger(`blog seed pageCreate ${post.pageType}: ${e.message}`);
      }
    }
    if (pageId) pageIds.set(post.pageType, pageId);
  }

  for (const post of BLOG_SENTINELS) {
    if (existing.some((t) => t === post.title || t.includes(post.title))) {
      summary.blogPosts++;
      summary.blogPostsSkipped++;
      logger(`blog seed: ${post.title} already present — skip`);
      continue;
    }
    const pageId = pageIds.get(post.pageType);
    if (!pageId) {
      summary.blog = { ...(summary.blog || {}), fault: `no pageId for ${post.pageType}` };
      logger(`blog seed ${post.title}: no pageId for ${post.pageType}`);
      continue;
    }
    try {
      const created = await gql.execute({
        endpoint: "experimental",
        document: `mutation BlogPostCreate($input: BlogPostCreateInput!) { ${mutationName}(input: $input) { content { id } errors { __typename } } }`,
        variables: {
          input: {
            addedBy,
            pageId,
            translations: [{ data: { title: post.title, text: post.text }, languageId }],
          },
        },
      });
      const payload = created.data?.[mutationName];
      if (payload?.errors?.length) {
        throw new Error(`${mutationName} payload errors`);
      }
      summary.blogPosts++;
      existing.push(post.title);
      logger(`blog seed: created ${post.title}`);
    } catch (e) {
      summary.blog = { ...(summary.blog || {}), fault: e.message };
      logger(`blog seed ${post.title}: ${e.message}`);
    }
  }
}

async function upsertPlanProduct(client, p, catIds, defaultCategoryId, productIds, summary, logger, productTitles) {
  const categoryId = catIds.get(p.category) || defaultCategoryId;
  const soapType = soapProductType(p);
  const id = await client.call("Product_CreateOrUpdate", {
    ProductData: {
      ItemNumber: p.item,
      Title: p.title,
      Description: p.description || undefined,
      DescriptionLong: p.description || undefined,
      Weight: p.weight ?? 0.45,
      Price: p.priceGross,
      VatGroupId: p.vatGroupId,
      Status: 1,
      Online: 1,
      Stock: 100,
      OutOfStockBuy: "1",
      CategoryId: categoryId,
      LanguageISO: "DK",
      SeoLink: p.seo || undefined,
      Type: soapType,
      TypeLabel: soapType,
      FocusFrontpage: p.focusFrontpage === true,
      FocusCart: p.focusCart === true,
      SeoKeywords: p.seoKeywords || undefined,
      DeliveryTimeId: p.deliveryTimeId || undefined,
    },
  });
  const pid = typeof id === "object" ? id.result : id;
  productIds.set(p.item, pid);
  if (productTitles) productTitles.set(p.item, p.title);
  summary.products += 1;
  if (p.variants) {
    const types = arr((await client.call("Product_GetVariantTypeAll")).result);
    const typeId = Number(types[0]?.Id);
    let valueId = 0;
    if (typeId) {
      const vals = arr((await client.call("Product_GetVariantTypeValuesByType", { VariantTypeId: typeId })).result);
      valueId = Number(vals[0]?.Id);
    }
    if (!valueId) {
      logger(`variant skip ${p.item}: shop has no VariantTypeValues`);
    } else {
      await client.call("Product_CreateOrUpdateVariant", {
        VariantData: {
          ProductId: pid,
          ItemNumber: `${p.item}-V1`,
          Price: p.priceGross,
          Status: 1,
          VariantTypeValues: { item: valueId },
        },
      });
    }
  }
  if (p.twoDim) {
    await seedTwoDimVariants(client, pid, p, logger);
  }
  if (p.multiDim) {
    await seedMultiDimVariants(client, pid, p, logger);
  }
  logger(`product ${p.item}`);
  return pid;
}

async function seedYarn120(client, catIds, defaultCategoryId, productIds, productTitles, logger, summary) {
  summary.xlYarn = { requested: LADDER_COUNTS.xlYarnVariants, stored: 0, faults: [] };
  const categoryId = catIds.get("garn") || defaultCategoryId;
  let pid;
  try {
    const id = await client.call("Product_CreateOrUpdate", {
      ProductData: {
        ItemNumber: `${SENTINEL}P-XL-YARN`,
        Title: "Example merino — farve × nøglestørrelse",
        Description: catalogDesc("Garn med to Hostedshop-akser: Farve og Størrelse."),
        DescriptionLong: catalogDesc("Garn med to Hostedshop-akser: Farve og Størrelse. 10 × 12 = 120 varianter."),
        Weight: 0.05,
        Price: 89,
        VatGroupId: 1,
        Status: 1,
        Online: 1,
        Stock: 10,
        OutOfStockBuy: "1",
        CategoryId: categoryId,
        LanguageISO: "DK",
        SeoLink: "example-merino-garn",
        Type: "normal",
        TypeLabel: "normal",
      },
    });
    pid = typeof id === "object" ? id.result : id;
    productIds.set(`${SENTINEL}P-XL-YARN`, pid);
    if (productTitles) productTitles.set(`${SENTINEL}P-XL-YARN`, "Example merino — farve × nøglestørrelse");
    summary.products += 1;
  } catch (e) {
    summary.xlYarn.faults.push(`parent: ${e.message}`);
    logger(`yarn parent probe: ${e.message}`);
    return;
  }
  const colorTypeId = await upsertVariantType(client, "Farve");
  const sizeTypeId = await upsertVariantType(client, "Størrelse");
  if (!colorTypeId || !sizeTypeId) {
    summary.xlYarn.faults.push("variant types missing");
    logger("yarn 120 skip: VariantType upsert returned no Id");
    return;
  }
  const colorIds = new Map();
  const sizeIds = new Map();
  for (const name of YARN_COLORS) colorIds.set(name, await upsertVariantValue(client, colorTypeId, name));
  for (const name of YARN_SIZES) sizeIds.set(name, await upsertVariantValue(client, sizeTypeId, name));
  for (const color of YARN_COLORS) {
    for (const size of YARN_SIZES) {
      const sku = `${SENTINEL}P-XL-YARN-${skuPart(color)}-${skuPart(size)}`;
      const cId = colorIds.get(color);
      const sId = sizeIds.get(size);
      if (!cId || !sId) {
        summary.xlYarn.faults.push(sku);
        continue;
      }
      try {
        await client.call("Product_CreateOrUpdateVariant", {
          VariantData: {
            ProductId: Number(pid),
            ItemNumber: sku,
            Price: 89,
            Stock: 10,
            Status: 1,
            VariantTypeValues: { item: [cId, sId] },
          },
        });
        summary.xlYarn.stored += 1;
      } catch (e) {
        summary.xlYarn.faults.push(sku);
        logger(`yarn variant probe ${sku}: ${e.message}`);
      }
    }
  }
}

async function seedRealXlLayers(client, catIds, defaultCategoryId, productIds, productTitles, summary, logger) {
  await seedYarn120(client, catIds, defaultCategoryId, productIds, productTitles, logger, summary);
  const tail = generatedProducts({
    prefix: `${SENTINEL}P-XL-`,
    count: LADDER_COUNTS.xlTailProducts,
    categoryKeys: BROHAVE_CATEGORIES.map((c) => c.key),
  });
  for (const p of tail) {
    try {
      await upsertPlanProduct(client, p, catIds, defaultCategoryId, productIds, summary, logger, productTitles);
    } catch (e) {
      logger(`xl tail probe ${p.item}: ${e.message}`);
    }
  }
  for (const p of xlProbeProducts()) {
    try {
      await upsertPlanProduct(client, p, catIds, defaultCategoryId, productIds, summary, logger, productTitles);
    } catch (e) {
      logger(`xl field probe ${p.item}: ${e.message}`);
    }
  }
}

/**
 * @param {{ client: { call: Function }, cfg: object, tier?: string, logger?: Function }} opts
 */
export async function seedDanDomain({ client, cfg, tier = "dd-light", logger = () => {} }) {
  if (!DD_TIERS[tier]) throw new Error(`Unknown DanDomain seed tier "${tier}" — use ${Object.keys(DD_TIERS).join("|")}`);
  assertSeedGates(cfg);
  // Real client injects Username/Password only in connect() (R17). call("Solution_Connect")
  // with no args is refused by validateArgs — that was the first live dd-real failure.
  if (typeof client.connect === "function") await client.connect();
  else await client.call("Solution_Connect");
  await assertShopIdentity(client, cfg);
  wireFtpOptions(client, cfg);
  wireGraphqlOptions(client, cfg);

  const plan = planFor(tier);
  const summary = {
    tier,
    products: 0,
    users: 0,
    orders: 0,
    ordersSkipped: 0,
    categories: 0,
    pictures: 0,
    coupons: 0,
    couponsSkipped: 0,
    pageSeoWrite: null,
    seoRoundTrip: null,
    deliveryTimes: 0,
    extraBuy: 0,
    pages: 0,
    tilvalgAttached: 0,
    b2bGroupId: 0,
    b2bPrices: 0,
    wordCoupons: [],
    i18n: 0,
    xlYarn: null,
    blogMutation: null,
    blogPosts: 0,
    blogPostsSkipped: 0,
    blogPagesCreated: [],
  };

  // Categories — Product_CreateOrUpdate requires CategoryId even though WSDL minOccurs=0
  // (probe-dandomain.mjs LIVE FACT 2026-08-15). Resolve by title after upsert.
  const catPlan = plan.categories || [{ key: "main", title: plan.categoryTitle }];
  const catIds = new Map();
  for (const c of catPlan) {
    await client.call("Category_CreateOrUpdate", {
      CategoryData: {
        Title: c.title,
        LanguageISO: "DK",
        Status: 1,
        Sorting: 0,
        Description: c.description || undefined,
        ParentId: c.parent && catIds.get(c.parent) ? catIds.get(c.parent) : undefined,
      },
    });
  }
  const cats = arr((await client.call("Category_GetAll")).result);
  for (const c of catPlan) {
    const found = cats.find((row) => s(row?.Title) === c.title);
    const id = Number(found?.Id);
    if (!id) throw new Error(`seed category ${c.title}: no Id after CreateOrUpdate`);
    catIds.set(c.key, id);
    logger(`category ${c.title} -> ${id}`);
  }
  summary.categories = catIds.size;
  const defaultCategoryId = catIds.get(catPlan[0].key);

  // Products (gross list price; order lines use NET separately)
  const productIds = new Map();
  const productTitles = new Map();
  for (const p of plan.products) {
    await upsertPlanProduct(client, p, catIds, defaultCategoryId, productIds, summary, logger, productTitles);
  }

  for (const p of plan.products) {
    if (!p.relatedItem) continue;
    const relatedId = productIds.get(p.relatedItem);
    const pid = productIds.get(p.item);
    if (!relatedId || !pid) continue;
    await client.call("Product_Update", {
      ProductData: {
        Id: Number(pid),
        ItemNumber: p.item,
        LanguageISO: "DK",
        RelatedProducts: { item: [Number(relatedId)] },
        Type: soapProductType(p),
        TypeLabel: soapProductType(p),
      },
    });
    logger(`related ${p.item} -> ${p.relatedItem}`);
  }

  if (plan.completeness) {
    const pid2 = productIds.get(`${SENTINEL}P-2DIM`);
    if (pid2) {
      summary.seoRoundTrip = await seedProductSeo(client, pid2, logger);
    }
    summary.pageSeoWrite = PAGE_SEO_SKIP_REASON;
    logger(`page SEO write skipped: ${PAGE_SEO_SKIP_REASON}`);
    const coup = await seedLetterCoupon(client, logger);
    summary.coupons = coup.created;
    summary.couponsSkipped = coup.skipped;
    await seedWordCoupons(client, logger, summary);
    await seedDeliveryAndPunch(client, productIds, logger, summary);
    await seedB2bGroupPrice(client, productIds, logger, summary);
    await seedUkLayer(client, productIds, logger, summary);
    await seedBlogPosts(client, logger, summary);
  }

  if (plan.xl) {
    await seedRealXlLayers(client, catIds, defaultCategoryId, productIds, productTitles, summary, logger);
  }

  await seedCataloguePictures(client, productIds, productTitles, logger, summary);
  if (plan.completeness) {
    const pid2 = productIds.get(`${SENTINEL}P-2DIM`);
    if (pid2) await seedTwoDimVariantPicture(client, pid2, logger);
  }

  const b2bGroupId = summary.b2bGroupId || 0;

  // Users
  for (const u of plan.users) {
    const userGroupId = u.username === `${SENTINEL}user-b2b` && b2bGroupId
      ? b2bGroupId
      : u.groupId;
    await client.call("User_CreateOrUpdate", {
      UserData: {
        Username: u.username,
        Email: u.email,
        Firstname: u.first,
        Lastname: u.last,
        Company: u.company,
        Cvr: u.cvr,
        Ean: u.ean,
        UserGroupId: userGroupId,
      },
    });
    summary.users += 1;
    logger(`user ${u.username}`);
  }

  // Existing orders by ReferenceNumber (idempotency). Assert fields first (R4): default
  // projection may omit ReferenceNumber, which would make F16's already-created order look new.
  try {
    await client.call("Order_SetFields", { Fields: "Id,ReferenceNumber,Status,Total" });
  } catch {
    /* GetAll still runs; skip is best-effort */
  }
  let existing = [];
  try {
    existing = arr((await client.call("Order_GetAll")).result);
  } catch {
    existing = [];
  }
  const byRef = new Map(existing.map((o) => [s(o.ReferenceNumber), o]));

  const currencies = arr((await client.call("Currency_GetAll")).result);
  const currencyId = Number(currencies[0]?.Id) || 1;
  const payments = arr((await client.call("Payment_GetAll")).result);
  const paymentId = Number(payments[0]?.Id) || 10;
  const deliveries = arr((await client.call("Delivery_GetAll")).result);
  const deliveryId = Number(deliveries[0]?.Id) || 20;
  const countries = arr((await client.call("Product_GetDeliveryCountryAll")).result);
  const countryId = Number(countries.find((c) => c.Primary === "true" || c.Primary === true)?.Id || countries[0]?.Id) || 45;

  const orderIdByRef = new Map();
  for (const o of plan.orders) {
    if (byRef.has(o.ref) || orderIdByRef.has(o.ref)) {
      summary.ordersSkipped += 1;
      logger(`order ${o.ref} already seeded — skip create`);
      continue;
    }
    const mainItem = plan.products[0].item;
    const productId = productIds.get(mainItem);
    const linePrice = o.lineNet; // NET (R1)
    const guest = o.guest === true;
    const srcUser = plan.users[0];
    const orderData = {
      CurrencyId: currencyId,
      LanguageISO: "DK",
      PaymentId: paymentId,
      DeliveryId: deliveryId,
      ReferenceNumber: o.ref,
      Origin: o.originRef ? String(orderIdByRef.get(o.originRef) || byRef.get(o.originRef)?.Id || "") : undefined,
      OrderLines: {
        item: {
          ProductId: Number(productId),
          Amount: o.qty,
          Price: linePrice,
        },
      },
      OrderCustomer: {
        Firstname: guest ? "Gæst" : srcUser.first,
        Lastname: guest ? String(o.ref).slice(-4) : srcUser.last,
        Email: guest ? `gaest-${String(o.ref).toLowerCase()}@example.invalid` : srcUser.email,
        Address: guest ? "Havnegade 12, 3. th" : (srcUser.address || "Søndergade 14"),
        Zip: guest ? "8000" : (srcUser.zip || "8000"),
        City: guest ? "Aarhus C" : (srcUser.city || "Aarhus C"),
        Phone: guest ? "21436587" : (srcUser.phone || "+45 21 43 65 87"),
        Country: countryId,
      },
    };
    const created = await client.call("Order_Create", { OrderData: orderData }).catch((e) => {
      // F16: Order_Create throws AFTER succeeding. Never retry.
      if (e?.kind === "LINE_ERRORS" && e.orderId) return { result: e.orderId, lineErrors: true };
      throw e;
    });
    const orderId = typeof created === "object" ? created.result : created;
    orderIdByRef.set(o.ref, orderId);
    summary.orders += 1;
    if (created?.lineErrors) logger(`order ${o.ref} LINE_ERRORS but exists as ${orderId} (F16 — not retried)`);

    if (o.paid) {
      // Transaction Status=1 is paid capture — NOT order status 1 (F37).
      await client.call("Order_SetTransactionCode", {
        TransactionData: {
          OrderId: orderId,
          PaymentId: paymentId,
          Status: 1,
          Amount: Math.round(Math.abs(linePrice) * o.qty * 100), // øre
          Currency: String(currencyId),
          TransactionNumber: 0,
          Cardtype: "seed",
          Errorcode: 0,
          Actioncode: 0,
          Date: "2020-01-15 12:00:00",
        },
      });
    }

    for (const st of o.statusWalk || []) {
      if (Number(st) === 1) {
        throw new Error("F37: seed must never Order_UpdateStatus Status=1");
      }
      await client.call("Order_UpdateStatus", { OrderId: orderId, Status: st });
    }
    logger(`order ${o.ref} -> ${orderId}`);
  }

  return summary;
}

const SEED_DT_IN = "1-2 hverdage";
const SEED_DT_OUT = "2-3 uger";
const MERCHANT_CAT_TITLES = new Set(["Bolig", "Tekstiler", "Keramik", "Garn"]);

function isProtectedProductId(id) {
  const n = Number(id);
  return n >= 1 && n <= 6;
}

function isSeedItemNumber(item) {
  return s(item).startsWith(SENTINEL);
}

/** Inverse of seedDanDomain: wipe DDSEED-* sentinels. Same identity gate as seed. */
export async function resetDanDomainSentinels(client, cfg, logger = () => {}) {
  await assertShopIdentity(client, cfg);

  const deleted = { products: 0, coupons: 0, pages: 0, users: 0, groups: 0, extraBuy: 0, deliveryTimes: 0 };
  let skippedDeliveryTimes = false;

  try {
    await client.call("Product_SetFields", { Fields: "Id,ItemNumber,Title,DeliveryTimeId" });
  } catch { /* default projection may already include ItemNumber */ }
  try {
    await client.call("User_SetFields", { Fields: "Id,Username,UserGroupId" });
  } catch { /* Username is on the User type; default may already include it */ }

  const products = arr((await client.call("Product_GetAll")).result);
  const seedProds = products.filter((p) => isSeedItemNumber(p.ItemNumber) && !isProtectedProductId(p.Id));
  const protectedProds = products.filter((p) => isProtectedProductId(p.Id) || !isSeedItemNumber(p.ItemNumber));
  const seedDtIds = [...new Set(seedProds.map((p) => Number(p.DeliveryTimeId)).filter((n) => n > 0))];

  const ebCats = arr((await client.call("Product_GetAllExtraBuyCategory")).result);
  for (const cat of ebCats.filter((c) => s(c.Title) === "DDSEED Køb også")) {
    const catId = Number(cat.Id);
    for (const p of products) {
      let rels = [];
      try {
        rels = arr((await client.call("Product_GetExtraBuyRelations", { ProductId: Number(p.Id) })).result);
      } catch {
        continue;
      }
      for (const r of rels) {
        if (Number(r.ExtraBuyCategoryId) === catId) {
          await client.call("Product_DeleteExtraBuyRelation", { ProductExtraBuyRelationId: Number(r.Id) });
        }
      }
    }
    await client.call("Product_DeleteExtraBuyCategory", { ProductExtraBuyCategoryId: catId });
    deleted.extraBuy += 1;
  }

  const discounts = arr((await client.call("Discount_GetAll")).result);
  for (const d of discounts) {
    if (s(d.Code).startsWith(`${SENTINEL}COUPON`)) {
      await client.call("Discount_Delete", { DiscountId: Number(d.Id) });
      deleted.coupons += 1;
    }
  }

  let pageHit = null;
  try {
    pageHit = (await client.call("PageText_GetByLink", { PageTextLink: PAGE_LINK })).result;
  } catch {
    pageHit = null;
  }
  const pageId = Number(arr(pageHit)[0]?.Id);
  if (pageId > 0) {
    await client.call("PageText_Delete", { PageTextId: pageId });
    deleted.pages += 1;
  }

  const users = arr((await client.call("User_GetAll")).result);
  for (const u of users) {
    if (s(u.Username).startsWith(SENTINEL)) {
      await client.call("User_Delete", { UserId: Number(u.Id) });
      deleted.users += 1;
    }
  }
  const groups = arr((await client.call("User_GetGroupAll")).result);
  for (const g of groups) {
    if (s(g.Title) === "DDSEED B2B") {
      await client.call("User_DeleteGroup", { UserGroupId: Number(g.Id) });
      deleted.groups += 1;
    }
  }

  for (const p of seedProds) {
    await client.call("Product_Delete", { ProductId: Number(p.Id) });
    deleted.products += 1;
  }

  let allDt = [];
  try {
    allDt = arr((await client.call("Product_GetDeliveryTimeAll")).result);
  } catch {
    allDt = [];
  }
  const dtById = new Map(allDt.map((d) => [Number(d.Id), d]));
  const matchSeedDt = (dt) => dt && s(dt.TitleInStock) === SEED_DT_IN && s(dt.TitleNoStock) === SEED_DT_OUT;
  const matchingIds = [];
  for (const id of seedDtIds) {
    let dt = dtById.get(id);
    if (!dt) {
      try {
        dt = (await client.call("Product_GetDeliveryTime", { DeliveryTimeId: id })).result;
      } catch {
        dt = null;
      }
    }
    if (matchSeedDt(dt)) matchingIds.push(id);
  }
  for (const p of protectedProds) {
    const id = Number(p.DeliveryTimeId);
    if (!id) continue;
    if (matchingIds.includes(id)) {
      skippedDeliveryTimes = true;
      break;
    }
    if (matchSeedDt(dtById.get(id))) {
      skippedDeliveryTimes = true;
      break;
    }
  }
  if (!skippedDeliveryTimes) {
    for (const id of matchingIds) {
      await client.call("Product_DeleteDeliveryTime", { ProductDeliveryTimeId: id });
      deleted.deliveryTimes += 1;
    }
  } else {
    logger("delivery time skip: seed titles also sit on a non-seed product");
  }

  const cats = arr((await client.call("Category_GetAll")).result);
  for (const c of cats) {
    const id = Number(c.Id);
    const title = s(c.Title);
    if (id === 11 || MERCHANT_CAT_TITLES.has(title)) continue;
    if (title.startsWith("DDSEED")) {
      await client.call("Category_Delete", { CategoryId: id });
    }
  }

  const after = arr((await client.call("Product_GetAll")).result);
  const ddseedProducts = after.filter((p) => isSeedItemNumber(p.ItemNumber) && !isProtectedProductId(p.Id));
  const products1to6 = after.filter((p) => isProtectedProductId(p.Id));
  logger(`reset sentinels: products=${deleted.products} remainingSeed=${ddseedProducts.length}`);

  return {
    identityOk: true,
    deleted,
    remaining: { ddseedProducts, products1to6 },
    skippedOrders: true,
    skippedDeliveryTimes,
  };
}
