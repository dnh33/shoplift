import { createClient, FieldListError, graphqlOptionsFromEnv } from "../dandomain/client.js";
import { asRecords } from "../dandomain/xml.js";
import { decodeHtmlEntities } from "../util/entities.js";
import { storefrontOrigin, productPath, categoryPath } from "../dandomain/urls.js";
import { log } from "../log.js";

/** Adapter-provided provenance prefix (PLAN D9). Existence-check tags in
 *  import/orders.js accept both this and the WordPress `wc-order-` default. */
export const PROVENANCE = Object.freeze({
  productIdTag: "dd-id-",
  orderTag: "dd-order-",
  statusTag: "dd-status-",
  orderNamePrefix: "#DD"
});

/**
 * DanDomain Webshop (Hostedshop) source adapter — SOAP reads normalised to the
 * WooCommerce record shape the transform stage already consumes (PLAN D1).
 *
 * Every rule with an R-number or an F-number below cost a live probe against
 * shop000000 and is written up in docs/PLAYBOOK-dandomain.md. Later sections of
 * that document supersede earlier ones; the citations here are the SURVIVING
 * ones. The five that would each ship as a money or data defect if dropped:
 *
 *   R1  `Product.Price` is VAT-INCLUSIVE. Order lines and `Order.Total` are NET.
 *       Two bases, one field name `Price`, on the two sides of the same API.
 *   R2  Tax rate is nowhere in the order. `Order.Vat` and `OrderLine.VatRate`
 *       are ALWAYS 0 — derive from the product's `VatGroupId` + the shop basis.
 *   F30 `OrderTransaction.Amount` is ØRE. `OrderLine.Amount` is a QUANTITY.
 *   R42 The public price is the cheapest `guest` / `UserId "0"` row; only if
 *       none exists, cheapest `{all,""}` / `UserId "0"`; then `Product.Price`.
 *       R22 dropped `guest`. R29 added it to a cheapest-of-public pool. The
 *       anonymous storefront showed `guest` WINS outright — a product with
 *       `all` at 2221 and `guest` at 1117 renders `1.117,00`.
 *   R19 `Product_GetTags` returns REVIEWS carrying `UserEmail`. Mapping it onto
 *       Shopify tags because of the name would publish reviewer email addresses.
 *
 * What this adapter deliberately does NOT provide:
 *   - `reviews()` — PLAN §11. Reviews arrive inline with the product read and
 *     are COUNTED and DROPPED here (R19); nothing carrying a reviewer email is
 *     ever written to data/raw/.
 *
 * `posts()` reads GraphQL `blogPosts` (experimental, Convention A). SOAP Blog_*
 * is NOT-IN-WSDL. BlogPost has no title — recorded content is
 * `translations.data` (`BlogPostTranslationData`: title/text/textList/seo*).
 */

// The verified CDN base is `https://{tenant}.sfstatic.io/upload_dir/` (R14,
// corroborated from the server's own mouth by `Solution_CreateThumb` in R32).
// Products resolve under `pics/`, categories under `shop/category/` (R21).
// NEVER resolve a FileName by walking the FTP archive: `product-5.png` exists in
// BOTH /pics and /shop at identical byte sizes, and the archive also holds the
// shop's generated `_thumbs/` and `placeholders/` caches, which a walk would
// import as product images with a clean-looking run (R21).
export const MEDIA_HOST = (tenant) => `https://${tenant}.sfstatic.io`;
export const MEDIA_PREFIX = "/upload_dir/";
export const PRODUCT_MEDIA_DIR = "pics/";
export const CATEGORY_MEDIA_DIR = "shop/category/";

/** DanDomain order status id -> Woo status. Ids are STOCK ids read from this
 *  platform (`OrderStatusCode_GetAll`); a shop with custom statuses overrides
 *  through `source.dandomain.statusMap`, and any id not covered by either is
 *  reported rather than guessed. */
export const DEFAULT_STATUS_MAP = Object.freeze({
  0: "pending",       // Ikke modtaget
  1: "processing",    // Ordre modtaget
  2: "processing",    // Under behandling
  3: "completed",     // Afsendt
  4: "processing",    // Genåbnet
  5: "cancelled",     // Annulleret
  6: "processing",    // Klar til afhentning
  7: "processing",    // Delvist afsendt — Shopify has no partial-fulfilment import here
  8: "completed",     // Afhentet
  99: "draft",        // Kladde
  100: "credit-note"  // Kreditnota — see F38: identify by Origin, not by this id
});

/** Statuses whose orders are not migrated by default (PLAN §3). */
export const DEFAULT_SKIP_STATUSES = Object.freeze(["draft"]);

/**
 * PRODUCT field set. The nested names are EXACTLY R4's live-verified list —
 * `Files`, `ProductFiles` and `DeliveryTimes` are WSDL-plausible and faulted the
 * whole call. Everything here is negotiated at runtime anyway (see
 * `negotiateFieldSet`), so a shop on a different API generation degrades with a
 * named warning instead of failing the export.
 */
export const PRODUCT_FIELDS = [
  "Id", "CategoryId", "SecondaryCategoryIds", "ProducerId", "Online", "Status", "DisableOnEmpty",
  "CallForPrice", "Stock", "StockLow", "OutOfStockBuy", "ItemNumber", "ItemNumberSupplier",
  "Url", "Weight", "BuyingPrice", "Price", "Discount", "DiscountType", "GuidelinePrice",
  "DeliveryTimeId", "Ean", "DateCreated", "DateUpdated", "LanguageISO", "Title",
  "SeoTitle", "SeoDescription", "SeoKeywords", "SeoLink", "SeoCanonical",
  "Description", "DescriptionShort", "DescriptionLong", "MinAmount", "Sorting",
  "UnitId", "VatGroupId", "Type", "TypeLabel", "RelatedProductIds", "UserGroupAccessIds",
  "FocusFrontpage", "FocusCart",
  // nested — R4's verified set
  "Variants", "Pictures", "CustomData", "Discounts", "Tags", "SecondaryCategories",
  "StockLocations", "VariantTypes"
];

export const VARIANT_FIELDS = [
  "Id", "ProductId", "Stock", "StockLow", "Price", "BuyingPrice", "ItemNumber",
  "ItemNumberSupplier", "Weight", "DeliveryTimeId", "Description", "DescriptionLong",
  "Status", "DisableOnEmpty", "Discount", "DiscountType", "Ean", "PictureId", "PictureIds",
  "Sorting", "VariantTypeValues", "MinAmount", "Title", "StockLocations"
];

export const ORDER_FIELDS = [
  "Id", "InvoiceNumber", "CurrencyId", "Currency", "CustomerId", "Customer", "UserId",
  "Site", "LanguageISO", "Status", "PaymentId", "Payment", "Transactions", "Vat", "Total",
  "OrderComment", "OrderCommentExternal", "CustomerComment", "DeliveryComment", "DeliveryTime",
  "TrackingCode", "DateDelivered", "DateDue", "DateSent", "DateUpdated", "OrderLines",
  "PackingId", "DeliveryId", "Delivery", "DiscountCodes", "ReferenceNumber", "Origin", "ReferralCode"
];

export const ORDER_LINE_FIELDS = [
  "Id", "OrderId", "ProductId", "VariantId", "Amount", "PacketTitle", "PacketId",
  "ProductTitle", "VariantTitle", "AdditionalTitle", "ItemNumber", "ItemNumberSupplier",
  "Discount", "DiscountRounded", "Price", "PriceRounded", "ServiceType", "BuyPrice",
  "StockStatus", "Status", "TrackingCode", "Weight", "OfflineProduct", "VatRate",
  "StockLocationId", "DeliveryId", "Unit"
];

export const USER_FIELDS = [
  "Id", "Username", "UserGroupId", "Type", "Company", "Cvr", "Ean", "Firstname", "Lastname",
  "Sex", "Address", "Address2", "Zip", "City", "Country", "CountryCode", "Currency", "Phone",
  "Mobile", "Fax", "Email", "Url", "DiscountGroupId", "Newsletter", "Referer", "BirthDate",
  "DateCreated", "DateUpdated", "Approved", "LanguageISO", "Description", "Number", "Site",
  "ShippingType", "ShippingFirstname", "ShippingLastname", "ShippingCompany", "ShippingCvr",
  "ShippingEan", "ShippingAddress", "ShippingAddress2", "ShippingZip", "ShippingCity",
  "ShippingCountry", "ShippingCountryCode", "ShippingState", "ShippingPhone", "ShippingMobile",
  "ShippingEmail", "ShippingReferenceNumber", "Consent", "ConsentDate"
  // `Password` is in the 56-field WSDL type and is deliberately NOT requested.
  // A migration cannot use it (Shopify hashes differently) and reading it would
  // put credential material into data/raw/*.jsonl.
];

export const PAGE_FIELDS = [
  "Id", "CategoryId", "Sorting", "ParentId", "ShowInMenu", "Target", "UpdatedDate",
  "LanguageISO", "Title", "Headline", "Link", "Text", "Text2", "Text3", "Visible",
  "SeoKeywords", "SeoDescription", "SeoTitle", "Pictures"
];

/** Recorded BlogPostTranslationData scalars (completeness-blog.json / gqldeep 2026-08-18).
 *  There is no `body`, `handle`, or `excerpt` on this type. `translations { __typename }`
 *  returned HTTP 500; `translations { data { … } }` returned 200. */
export const BLOG_POST_TRANSLATION_DATA_FIELDS = Object.freeze([
  "title", "text", "textList", "seoTitle", "seoKeywords", "seoDescription",
]);
export const BLOG_POST_LANGUAGE_FIELDS = Object.freeze(["iso", "name", "primary"]);
export const BLOG_POST_SELECTION = `id addedBy createdAt pageId translations { data { ${BLOG_POST_TRANSLATION_DATA_FIELDS.join(" ")} } language { ${BLOG_POST_LANGUAGE_FIELDS.join(" ")} } }`;

/** The `UserType` values the server's own fault message enumerates (R22). */
export const USER_TYPE_VOCABULARY = Object.freeze(["all", "guest", "user", "group"]);
/** R29: the scopes a logged-out visitor can be served from. `""` is included
 *  because the server accepts and stores it; `"0"` is NOT — it is accepted too,
 *  but it is outside the vocabulary and therefore UNKNOWN SCOPE, never public. */
export const PUBLIC_USER_TYPES = Object.freeze(["all", "guest", ""]);
/** R42 — and `guest` does not merely COUNT, it WINS. Read off the anonymous
 *  storefront: a product carrying `all`/UserId 0 at 2221 and `guest`/UserId 0 at
 *  1117 renders `1.117,00` on its own product page and neither of the other two
 *  numbers. So a `guest` row is what a logged-out visitor is charged, whether or
 *  not it is the cheapest — "cheapest of {all, guest}" would pick the wrong one
 *  on any shop whose guest price is the HIGHER of the two. */
export const PREFERRED_PUBLIC_USER_TYPE = "guest";

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

const arr = (v) => asRecords(v);
const s = (v) => (v === null || v === undefined ? "" : String(v));
/** Text out of this API can be entity-encoded and raw UTF-8 in the SAME field on
 *  adjacent rows (the F1-F38 adversarial review found `Kontooverf&oslash;rsel`
 *  beside `Ingen betaling nødvendig`). Decode every human-readable string. */
const txt = (v) => decodeHtmlEntities(s(v));
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v) => { const t = typeof v === "string" ? v.trim() : v; return t === true || t === "true" || t === "1" || t === 1; };
const money2 = (n) => (n === null || n === undefined ? null : String(Number(n).toFixed(2)));

/** O16 — SOAP has no batch GetVariantTypeValues / Order_GetLines. Cap in-flight. */
const REFETCH_CONCURRENCY = 8;
async function mapBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...await Promise.all(chunk.map((item, j) => fn(item, i + j))));
  }
  return out;
}

/** Milliseconds for a `ddDate` result, treating a naked timestamp as UTC. The
 *  naive `Date.parse(x + "Z")` yields NaN when `x` already ends in `Z`, and NaN
 *  makes every comparison false — which reads as "no bound", i.e. the opposite
 *  of what a date window means. */
export function utcMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(HAS_ZONE.test(iso) ? iso : iso + "Z");
  return Number.isNaN(ms) ? null : ms;
}

/** Does this timestamp already state a zone? `Z`, `z`, `+02:00`, `+0200`, `-05`. */
const HAS_ZONE = /[Zz]$|[+-]\d{2}(:?\d{2})?$/;

/** `0000-00-00 00:00:00` is this platform's zero-date and breaks every naive
 *  parser (F19/F32). It means "never", not "the year 0". */
export function ddDate(v) {
  const raw = s(v).trim();
  if (!raw || /^0{4}-0{2}-0{2}/.test(raw)) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  // A timestamp that ALREADY carries a zone keeps it. The naive
  // `endsWith("Z") ? iso : iso + "Z"` appends a second zone to `…+02:00`, which
  // `Date.parse` rejects — so every offset-bearing date became null, silently,
  // one function upstream of the `utcMs` guard that exists for exactly this.
  // A dropped DateCreated is invisible; a dropped price-line window sets today's
  // price from a campaign that ended in 2020.
  return utcMs(iso) === null ? null : iso;
}

/** Danish-aware slug, matching what this platform's storefront serves when a
 *  row has no explicit `SeoLink` (R41: category 9, `SeoLink: null`, served at
 *  `/shop/9-probe-kategori/`). */
export function slugify(title) {
  return s(title).toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The one place a `FileName` becomes a URL (R14/R21/R32). */
export function mediaUrl(base, dir, fileName) {
  const f = s(fileName).replace(/^\/+/, "");
  if (!f) return null;
  // Live Category_GetPictures.Name can be `category/category-N.png` while the
  // verified subtree is already `shop/category/` (R21). Join the leaf only —
  // a bare FileName still exists in both `/pics/` and `/shop/category/`.
  const leaf = f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f;
  if (!leaf) return null;
  return `${base.replace(/\/$/, "")}/${dir}${leaf}`;
}

/** The first alt text whose language matches, else the first one at all. */
const altOf = (picture, iso, fallback) => {
  const alts = arr(picture?.ImageAltTexts);
  const hit = alts.find((a) => !a?.LanguageAccess || s(a.LanguageAccess) === iso) ?? alts[0];
  return txt(hit?.Text) || fallback;
};

/** Picture Id -> row from a product's inline `Pictures` array (R14/R21). */
function pictureIndex(pics) {
  const m = new Map();
  for (const pic of arr(pics)) {
    const id = s(pic?.Id);
    if (id && id !== "0") m.set(id, pic);
  }
  return m;
}

/** Map variant PictureId / PictureIds onto Woo `image = { src, alt }` for transform. */
function variantImageFromPictures(pics, variant, mediaBase, iso, fallback) {
  if (!mediaBase) return undefined;
  const byId = pictureIndex(pics);
  const ids = [];
  const pid = s(variant?.PictureId);
  if (pid && pid !== "0") ids.push(pid);
  for (const x of arr(variant?.PictureIds)) {
    const id = s(x?.Id ?? x);
    if (id && id !== "0" && !ids.includes(id)) ids.push(id);
  }
  for (const id of ids) {
    const pic = byId.get(id);
    if (pic?.FileName) {
      const src = mediaUrl(mediaBase, PRODUCT_MEDIA_DIR, pic.FileName);
      if (src) return { src, alt: altOf(pic, iso, fallback) };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// R42 — the public price (R22 → R29 → R42; guest wins outright)
// ---------------------------------------------------------------------------------------------

/**
 * Choose the price a logged-out visitor is served, from a product's price lines
 * (`ProductDiscount` rows, inlined as `Discounts`).
 *
 * THE RULE (R22 -> R29 -> **R42**), and every clause of it is a recorded finding:
 *   - `guest` WINS OUTRIGHT. The cheapest `UserType === "guest"` / `UserId "0"`
 *     row is the public price WHETHER OR NOT it is the cheaper one. This
 *     SUPERSEDES R22 and R29's "cheapest of {all, guest, ''}", which returns the
 *     same answer on the recorded shop only by accident and the opposite answer
 *     on any shop whose guest price is the dearer of the two.
 *   - only when NO guest row qualifies does the cheapest `{all, ""}` / `UserId
 *     "0"` row apply, and only then `Product.Price`.
 *   - `user` / `group` / any `UserId !== "0"` is SCOPED. `all` + `UserId 4` is
 *     storable and IS scoped — neither field alone identifies the public price.
 *   - a `UserType` outside the vocabulary (including `"0"`, which the server
 *     accepts and stores) is UNKNOWN SCOPE, and unknown is never public.
 *   - `DiscountType` other than `"b"` warns: the `a`/`b` vocabulary is still
 *     undecoded (R20/R37), and this is the same shape of trap as F30's øre.
 *   - `Amount > 1` is a QUANTITY BREAK (mængderabat), not a unit price. Shopify
 *     product pricing cannot express it, so it never sets the price.
 *   - a date-windowed row outside its window is not in effect today.
 *   - no qualifying row -> fall back to `Product.Price` (which is the entered,
 *     VAT-inclusive consumer price, R1) and say so.
 *
 * WHAT `confirmed` MEANS, and what it does not. R29 was carried for two rounds as
 * a money rule that had never been checked against the channel it describes. R42
 * checked it: a product with `all`/0 at 2221 and `guest`/0 at 1117 renders
 * `1.117,00` on the anonymous storefront and neither of the other two. So the
 * RULE is now read from the storefront rather than inferred from what the server
 * accepts — `confirmed: true`, `confirmedBy: "R42"`.
 *
 * It is NOT a per-product verification, and it is ONE SHOP. A second shop whose
 * theme prices differently would break it, which is why O11 stays open with the
 * cheapest closing observation named. Reading `confirmed` as "this price is
 * right" would be the same over-read that made R34's page base look settled.
 */
export function publicPrice(product, { now = new Date(), listPrice = null, variantId = null } = {}) {
  const all = arr(product?.Discounts);
  const base = listPrice ?? num(product?.Price);
  // `ProductDiscount.ProductVariantId` is field 3 of the WSDL type and is on
  // every recorded row. A row naming a variant prices THAT VARIANT ONLY —
  // applying it to the product re-prices its siblings, which on a 3-variant
  // product is a 72 % markdown on two of them. `variantId: null` asks for the
  // PRODUCT-level rows; a variant asks for its own and falls back to those.
  const scoped = variantId === null
    ? all.filter((r) => !s(r.ProductVariantId) || s(r.ProductVariantId) === "0")
    : all.filter((r) => s(r.ProductVariantId) === s(variantId));
  const rows = (variantId !== null && scoped.length === 0)
    ? all.filter((r) => !s(r.ProductVariantId) || s(r.ProductVariantId) === "0")
    : scoped;
  const out = {
    price: base, source: "Product.Price", dropped: [], unknownScope: [],
    confirmed: true, confirmedBy: "R42", confirmedOnShops: 1,
    // Whether the rows considered were the VARIANT's own or the product-level
    // fallback. The caller needs this to know what the chosen price is quoted
    // against: a variant-scoped line is that variant's price, a product-level one
    // has to be applied as a ratio. `rows > 0` cannot answer it — the fallback
    // makes it true either way, which is how a variant-scoped line got scaled.
    variantScoped: variantId !== null && scoped.length > 0,
    rows: rows.length, variantScopedRows: all.length - all.filter((r) => !s(r.ProductVariantId) || s(r.ProductVariantId) === "0").length,
  };
  if (!rows.length) return out;

  // `ddDate` returns an ISO string that MAY already carry its own `Z`, so
  // appending one gives "…ZZ" and `Date.parse` returns NaN — and every
  // comparison against NaN is false, which reads as "in window". A price line
  // that expired in 2020 would then set today's price. One helper, used by both
  // callers, so the two cannot drift.
  const inWindow = (r) => {
    if (!bool(r.Date)) return true;
    const from = utcMs(ddDate(r.DateFrom)), to = utcMs(ddDate(r.DateTo));
    const t = now.getTime();
    if (from !== null && t < from) return false;
    if (to !== null && t > to) return false;
    return true;
  };

  let best = null;
  let bestGuest = null;
  for (const r of rows) {
    const type = s(r.UserType);
    const uid = s(r.UserId);
    const price = num(r.Price);
    const amount = num(r.Amount);
    // Checked on EVERY row, before any of them are dropped. The a/b vocabulary
    // being undecoded (R20) is a fact about the shop's pricing mechanism, not
    // about one row's audience — a scoped row using `a` says just as loudly
    // that this transform does not understand how the shop computes a price.
    if (s(r.DiscountType) && s(r.DiscountType) !== "b") out.undecodedDiscountType = s(r.DiscountType);
    const known = USER_TYPE_VOCABULARY.includes(type) || type === "";
    const reason =
      !known ? "unknown-scope"
        : !PUBLIC_USER_TYPES.includes(type) ? "customer-scoped"
          : uid !== "0" ? "customer-scoped"
            : amount !== null && amount > 1 ? "quantity-break"
              : !inWindow(r) ? "outside-date-window"
                : price === null ? "no-price"
                  : null;
    if (reason) {
      const entry = { id: s(r.Id), userType: type, userId: uid, price, amount, reason };
      out.dropped.push(entry);
      if (reason === "unknown-scope") out.unknownScope.push(entry);
      continue;
    }
    if (best === null || price < best) best = price;
    if (type === PREFERRED_PUBLIC_USER_TYPE && (bestGuest === null || price < bestGuest)) bestGuest = price;
  }
  // R42 — a `guest` row wins outright when one exists; only otherwise does the
  // cheapest of the remaining public rows apply.
  const chosen = bestGuest !== null ? bestGuest : best;
  if (chosen !== null) {
    out.source = "price-line";
    out.scope = bestGuest !== null ? "guest" : "all";
    out.price = chosen;
    // A public row DEARER than the entered price is not a mistake to swallow:
    // R42 says the storefront serves the guest row, so the row wins and the gap
    // is reported. Silently clamping to Product.Price would under-price the
    // catalogue on any shop whose price lines are the current ones.
    if (base !== null && chosen > base) out.dearerThanListPrice = { line: chosen, listPrice: base };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------------------------

export function createDanDomainAdapter(cfg, deps = {}) {
  const dd = cfg.source?.dandomain || {};
  const tenant = dd.tenant || "";
  const origin = storefrontOrigin(cfg.source?.baseUrl) || (tenant ? `https://${tenant}.mywebshop.io` : null);
  const mediaBase = dd.mediaBase || (tenant ? MEDIA_HOST(tenant) + MEDIA_PREFIX : null);
  const iso = dd.language || "";
  const pageSize = Number.isInteger(dd.pageSize) && dd.pageSize > 0 ? dd.pageSize : 250;
  const statusMap = { ...DEFAULT_STATUS_MAP, ...(dd.statusMap || {}) };
  const skipStatuses = new Set(dd.skipStatuses || DEFAULT_SKIP_STATUSES);
  const now = deps.now ? deps.now() : new Date();

  /**
   * THE THROTTLE, and why there is a default at all.
   *
   * The client's token bucket defaults to `refillPerSecond: Infinity` — correct
   * for a probe, wrong for an export that issues tens of thousands of requests
   * against a client's LIVE shop. F11 saw no throttling on a 20-call burst and
   * F27 recorded that the documented 5/s did not fire and that there may be no
   * signal at all before something else breaks; PLAN §2 therefore asks for a
   * conservative ~4 rps. Invariant #3 says plan-dependent numbers never appear
   * in code — this is not one: it is a COURTESY ceiling below the only published
   * figure, it is not derived from any plan tier, and it is overridable per
   * shop. Left unset, the adapter would hammer a merchant's shop flat out.
   */
  const throttle = dd.throttle ?? { capacity: 1, refillPerSecond: 4 };

  const makeClient = deps.createClient || createClient;
  const graphqlOpts = dd.graphql || graphqlOptionsFromEnv(dd);
  const client = deps.client || makeClient({
    username: dd.username,
    password: dd.password,
    throttle,
    ...(dd.endpoint ? { endpoint: dd.endpoint } : {}),
    ...(dd.timeoutMs ? { timeoutMs: dd.timeoutMs } : {}),
    ...(dd.pageBase !== undefined ? { defaultPageBase: dd.pageBase } : {}),
    ...(graphqlOpts ? { graphql: graphqlOpts } : {}),
    ...(dd.ftp ? { ftp: dd.ftp } : {})
  });

  /**
   * VALIDATED AT CONSTRUCTION, not on first use. The old version threw from
   * inside `orders()`, i.e. after the whole catalogue and the entire order
   * history had been read — measured at 14 SOAP calls on the fixtures and hours
   * on a real shop, with the accumulated warnings and `summary.json` thrown away
   * with it. A config typo is knowable before the first request.
   */
  const configuredLineBasis = (() => {
    const raw = dd.lineBasis;
    if (raw === undefined || raw === null || raw === "") return null;
    const v = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
    if (v !== "unit" && v !== "line") {
      throw new Error(
        `Missing config: source.dandomain.lineBasis must be "unit" or "line", got ${JSON.stringify(raw)}. ` +
        "It decides whether OrderLine.Price is a per-unit price or a whole-line total, which multiplies or divides " +
        "every historical order by its quantity — this adapter will not guess past a value you meant to set.",
      );
    }
    return v;
  })();

  const warnings = [];
  const seen = new Set();
  const perCode = new Map();
  const suppressed = new Map();
  /**
   * One code+id pair is one warning, however many records trip it — AND at most
   * `WARN_CAP_PER_CODE` of them.
   *
   * Several product and order codes key on the RECORD id, so the dedupe never
   * fires for them: a 10,000-product shop with customer-group pricing raises
   * 10,000 `PRICE_LINES_DROPPED` objects, and a shop tripping several codes was
   * measured at 60,000 warnings / 27 MB — which does not crash anything and
   * does destroy the channel. 60,000 messages is not a thing a human reviews,
   * and `status`/`menu` re-read the whole file on every render.
   *
   * The cap keeps the first N (with their ids, so they are actionable) and
   * replaces the tail with ONE roll-up carrying the true count. Silence would be
   * worse than noise; a count is neither.
   */
  const WARN_CAP_PER_CODE = 50;
  const warn = (code, message, { entity = "source", id = "all", severity = "action" } = {}) => {
    const key = `${code}|${entity}|${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const n = (perCode.get(code) ?? 0) + 1;
    perCode.set(code, n);
    if (n > WARN_CAP_PER_CODE) { suppressed.set(code, (suppressed.get(code) ?? 0) + 1); return; }
    warnings.push({ entity, id, code, severity, message });
  };
  const retractWarn = (code) => {
    for (const k of [...seen]) {
      if (String(k).startsWith(`${code}|`)) seen.delete(k);
    }
    for (let i = warnings.length - 1; i >= 0; i--) {
      if (warnings[i].code === code) warnings.splice(i, 1);
    }
    perCode.delete(code);
    suppressed.delete(code);
  };
  /** The roll-up rows, built when the warnings are drained. */
  const rollUps = () => [...suppressed.entries()].map(([code, n]) => {
    const first = warnings.find((w) => w.code === code);
    return {
      entity: first?.entity ?? "source", id: "all", code, severity: first?.severity ?? "action",
      message: `…and ${n} more record(s) raised ${code}, beyond the first ${WARN_CAP_PER_CODE} listed above (${n + WARN_CAP_PER_CODE} in total). They are capped so warnings.jsonl stays reviewable — a per-record code on a large catalogue produces tens of thousands of otherwise identical lines. The cap is a display limit, not a filter: every affected record is still exported.`,
    };
  });

  let connected = false;
  const connect = async () => { if (!connected) { await client.connect(); connected = true; } };

  /** R41 — the storefront URL grammar, for a WARNING MESSAGE only. It is never
   *  written into a record: the grammar is confirmed on ONE shop and a wrong
   *  guess produces a redirect map that 404s at scale (P3's job is to verify it
   *  per shop, by checking the response CONTAINS the product — R39 is that a 200
   *  alone is worthless here). A hint in prose costs nothing if it is wrong. */
  const storefrontHint = (productId) => {
    const base = dd.storefrontUrl || (tenant ? `https://${tenant}.mywebshop.io` : null);
    return base ? `${base}/shop/<catId>-<catSlug>/${productId}-<slug>/` : "(set source.dandomain.storefrontUrl to get a link here)";
  };

  // ------------------------------------------------------------------------------------------
  // field-set negotiation (R4 + R17/R27)
  // ------------------------------------------------------------------------------------------
  /**
   * R4: ONE unknown field name faults the entire `*_SetFields` call, and the
   * session then keeps the PREVIOUS field list, so the next read succeeds with
   * the wrong shape and no error. Three names were caught that way live, and
   * only ONE shop and ONE API generation has ever been observed — so a
   * hand-picked list is a bet on every future client shop having the same
   * columns.
   *
   * The server names the offender: `NOSUCHPARAM: No such fieldname: "Files"`.
   * So drop that name and retry, and record every drop as an ACTION warning.
   * Bounded, because a fault that does not name a field must not loop.
   */
  async function negotiateFieldSet(type, wanted, { maxDrops = 12 } = {}) {
    let fields = [...wanted];
    const dropped = [];
    for (let i = 0; i <= maxDrops; i++) {
      try {
        await client.setFields(type, fields);
        if (dropped.length) {
          warn("FIELD_SET_REJECTED",
            `The shop's API refused ${dropped.length} ${type} field name(s) — ${dropped.join(", ")} — and they were dropped so the export could continue. Every one is a column this migration does NOT carry. If any of them matters (a barcode, an SEO slug, a stock field), the shop is on an API generation this adapter has not seen and the mapping needs a look before go-live.`,
            { entity: "source", id: type });
        }
        return { fields, dropped };
      } catch (e) {
        const name = /No such fieldname:\s*"?([A-Za-z0-9_]+)"?/.exec(e?.message || "")?.[1];
        // A LOCAL validation failure names the field too, and is the same fix.
        const local = e instanceof FieldListError ? /"([A-Za-z0-9_]+)"/.exec(e.message || "")?.[1] : null;
        const bad = name || local;
        if (!bad || !fields.includes(bad)) throw e;
        fields = fields.filter((f) => f !== bad);
        dropped.push(bad);
        if (!fields.length) throw e;
      }
    }
    throw new Error(`could not negotiate a ${type} field set after ${maxDrops} rejected names (dropped: ${dropped.join(", ")})`);
  }

  /**
   * R26 — audit the WHOLE batch, and DO NOT abort on truncation.
   *
   * The client throws `FieldSetTruncatedError` by default, which is right for a
   * probe and wrong for an export: "absent on 0 of N records" is a truncated
   * column AND is exactly what a column nobody on this shop fills looks like.
   * `Ean` empty across a catalogue is not a reason to refuse the migration. So
   * the audit runs in verdict mode and the verdict becomes a loud ACTION
   * warning naming the fields and the record type — invariant 5, reshape
   * loudly, rather than either failing late or deciding silently.
   */
  function reportAudit(entityLabel, audit) {
    if (!audit || !audit.truncatedByType?.length) return;
    for (const t of audit.truncatedByType) {
      const where = t.path ? `${t.path} (${t.recordType})` : (t.recordType || entityLabel);
      warn("FIELD_SET_TRUNCATED",
        `${entityLabel}: field(s) ${t.fields.join(", ")} were requested but came back on 0 of ${t.records} ${where} records. On this platform a missing key normally means an EMPTY VALUE (R26) — absent across the WHOLE batch is the other case, a column the server did not send. Check one of these records in the shop admin: if the column has data there, this migration is dropping it.`,
        { entity: "source", id: `${entityLabel}:${where}` });
    }
  }

  const auditOpts = { audit: { throwOnTruncation: false } };

  /**
   * The walk's own verdict, which the client computes and this adapter used to
   * discard. `complete: false` means the loop stopped on a signal it could not
   * corroborate; `shortPages` means the server returned fewer rows than asked
   * for mid-walk, which on a 618-product shop can never happen and on a real one
   * is exactly the telemetry you want. Reporting a partial read as a whole
   * export is the failure this is here to prevent.
   */
  function reportWalk(entityLabel, walk) {
    if (walk.complete === false) {
      warn("WALK_INCOMPLETE",
        `The ${entityLabel} read stopped without proving it reached the end (stoppedBecause: ${JSON.stringify(walk.stoppedBecause)}) after ${walk.records.length} record(s) in ${walk.requests} page window(s). Treat the count as a FLOOR, not a total — reconcile it against the shop admin before importing.`,
        { entity: "source", id: entityLabel });
    }
    // The LAST page of any walk is legitimately short, and on a shop smaller
    // than one page the FIRST page is the last one — so `shortPages: 1` is the
    // ordinary case and warning on it would fire on every small shop. More than
    // one means a window came back short in the MIDDLE, which is H1's case: the
    // walk continues correctly, and it is worth saying because a server
    // truncating windows under load is how a large export loses records quietly.
    if (walk.shortPages > 1) {
      warn("WALK_SHORT_PAGES",
        `The ${entityLabel} read got ${walk.shortPages} page(s) shorter than the observed page size across ${walk.pages} page(s). One short page is the end of the data; more than one means the server returned a short window MID-WALK. The walk handled it correctly (H1: a short page never ends a walk), and it is reported because it is the signal that a server is truncating under load.`,
        { entity: "source", id: entityLabel, severity: "handled" });
    }
  }

  // ------------------------------------------------------------------------------------------
  // shop context, read once and shared
  // ------------------------------------------------------------------------------------------
  // Category and producer lookups, built once and shared by products() and
  // categories(). See the pushCat comment in products() for why the slug is not
  // optional decoration.
  const catIndex = new Map();
  const producerIndex = new Map();
  const missingCategory = new Set();
  const missingProducer = new Set();
  let catIndexPromise = null;
  function categoryIndex() {
    catIndexPromise = catIndexPromise || (async () => {
      await connect();
      const bySlug = new Map();
      for (const c of arr((await client.call("Category_GetAll")).result)) {
        if (!s(c.Id)) continue;
        if (catIndex.has(s(c.Id))) {
          // Two rows, one Id — plausible on a multi-language shop, and the
          // second silently overwrote the first, so one category vanished from
          // the export with no trace.
          warn("CATEGORY_DUPLICATE_ID",
            `Category_GetAll returned more than one row with Id ${s(c.Id)} ("${txt(catIndex.get(s(c.Id)).name)}" and "${txt(c.Title)}"). Only the LAST is exported — the others are lost. On a multi-language shop this is usually one category per language layer, and this export carries the primary layer only.`,
            { entity: "collection", id: s(c.Id) });
        }
        const slug = categorySlug(c);
        catIndex.set(s(c.Id), { id: s(c.Id), name: txt(c.Title), slug, row: c });
        // Keyed on the HANDLE, not the raw slug: Shopify is unique by handle and
        // `toHandle` lowercases and strips punctuation, so "Herre-Jakker" and
        // "herre-jakker" are two slugs and ONE collection. Comparing raw slugs
        // misses exactly the collisions that merge.
        const key = slugify(slug);
        bySlug.set(key, [...(bySlug.get(key) ?? []), c]);
      }
      // TWO CATEGORIES, ONE SLUG. `Herre > Jakker` and `Dame > Jakker` is the
      // ordinary shape of a DanDomain tree, and both slugify to `jakker`.
      // `import/collections.js` skips a handle it has already created, so ONE
      // collection is made, the other is dropped, and its products land in the
      // survivor — exit 0, no error. The slug cannot be silently disambiguated
      // (it is the storefront's own URL segment, which P3's redirect map needs
      // verbatim), so it is reported instead.
      for (const [slug, rows] of bySlug) {
        if (rows.length < 2) continue;
        if (new Set(rows.map((c) => s(c.Id))).size < rows.length) continue;  // already named above
        warn("CATEGORY_SLUG_COLLISION",
          `Categories ${rows.map((c) => `${s(c.Id)} "${txt(c.Title)}"`).join(" and ")} all resolve to the slug "${slug}". Shopify collections are unique by handle, so they MERGE into one on import — the last one wins the title and the others' products land in it. On this platform that is usually two same-named subcategories under different parents. Rename one in the shop, or accept the merge deliberately.`,
          { entity: "collection", id: slug });
      }
      return catIndex;
    })();
    return catIndexPromise;
  }

  /**
   * F21 — `Product.ProducerId` points at a USER, and `User_GetAll` is the only
   * read that names them. LAZY on purpose: a shop with no producers should not
   * pay for a full customer read to find that out, and on a 50k-customer shop
   * that read is not free. Loaded once, on the first product that has one.
   */
  /**
   * `User_GetAll` — read ONCE and shared, and always behind an asserted field
   * set.
   *
   * Two defects this shape prevents. (a) `producerNames()` runs inside
   * `products()`, which `runExport` walks BEFORE `customers()`, so the naive
   * version issued `User_GetAll` before `User_SetFields` was ever sent — R4's
   * own rule is that the session then keeps the PREVIOUS field list, which at
   * that point is the server default, and every brand comes back empty.
   * (b) The operation has no pagination: on a 20k-customer shop it is a single
   * ~28 MB response, and the naive version paid for it twice.
   */
  /**
   * O17 — `User_GetAll` has no pagination (~28 MB / 106 MB heap at 20k).
   * Chunk with `User_GetAllByDate(Start, End)` (WSDL). Year windows from 2000
   * through tomorrow; dedupe by Id. Never call User_GetAll on this path.
   */
  let usersPromise = null;
  function allUsers() {
    usersPromise = usersPromise || (async () => {
      await negotiateFieldSet("User", USER_FIELDS);
      const byId = new Map();
      const startYear = 2000;
      const end = new Date(now.getTime());
      end.setUTCDate(end.getUTCDate() + 1);
      const endYear = end.getUTCFullYear();
      for (let y = startYear; y <= endYear; y++) {
        const Start = `${y}-01-01 00:00:00`;
        const End = y === endYear
          ? `${end.toISOString().slice(0, 10)} 23:59:59`
          : `${y}-12-31 23:59:59`;
        const rows = arr((await client.call("User_GetAllByDate", { Start, End })).result);
        for (const u of rows) {
          const id = s(u.Id);
          if (!id || byId.has(id)) continue;
          byId.set(id, u);
          const label = txt(u.Company) || [txt(u.Firstname), txt(u.Lastname)].filter(Boolean).join(" ");
          if (label) producerIndex.set(id, label);
        }
      }
      return [...byId.values()];
    })();
    return usersPromise;
  }

  /**
   * R41 — the category slug the storefront uses. `SeoLink` when the shop set
   * one; otherwise the TITLE, transliterated — recorded live: category 9 has
   * `SeoLink: null` and serves at `/shop/9-probe-kategori/`.
   *
   * NEVER null. A null slug becomes the handle "item" three layers downstream
   * and every collection-membership lookup misses; that is the defect this whole
   * index exists to prevent, and `slugify` returns "" for a title with no
   * Latin-mappable characters at all (a Japanese or Greek category name). The id
   * fallback is ugly and correct — an operator can rename it, and nothing is
   * silently lost.
   */
  const categorySlug = (c) => s(c?.SeoLink) || slugify(txt(c?.Title)) || (s(c?.Id) ? `kategori-${s(c.Id)}` : null);

  let ctxPromise = null;
  function shopContext() {
    ctxPromise = ctxPromise || (async () => {
      await connect();
      const webinfo = (await client.call("Solution_GetWebinfo")).result || {};
      const currencies = arr((await client.call("Currency_GetAll")).result);
      const vatGroups = arr((await client.call("VatGroup_GetAll")).result);
      const languages = arr((await client.call("Solution_GetLanguages")).result);
      const groups = arr((await client.call("User_GetGroupAll")).result);

      // F20/F6 — `CountryCode` is a NUMERIC id resolved per shop. Read once
      // here rather than in whichever entity happens to run first.
      let countries = [];
      try { countries = arr((await client.call("Product_GetDeliveryCountryAll")).result); }
      catch (e) { log.debug(`dandomain: delivery countries unavailable (${e.message})`); }

      const vatById = new Map(vatGroups.map((g) => [s(g.Id), num(g.VatPercentage) ?? 0]));
      const primary = languages.find((l) => bool(l.Primary)) || languages[0] || null;
      // Currency_GetAll is unordered. WSDL Currency has no Primary (unlike
      // ProductDeliveryCountry / SolutionLanguage). SOAP Site is Id,
      // LanguageISO, Title, Sorting, Type — no Valuta. ShopWebinfo has no
      // currency field. Help-page primary is Site Standard, which SOAP cannot
      // read; the merchant is told to set that rate to 1, which is instruction
      // not an API identifier. One row has no alternative, so that row is the
      // shop currency. Otherwise leave it unset and say so — rate 1 and list
      // position 0 are not recorded defaults.
      const currency = currencies.length === 1 ? currencies[0] : null;
      if (currencies.length !== 1) {
        warn("CURRENCY_LIST_AMBIGUOUS",
          `Currency_GetAll returned ${currencies.length} row(s) (${currencies.map((c) => `${s(c.Iso)}@${s(c.Currency)}`).join(", ") || "none"}). WSDL Currency has no Primary; SOAP Site has no Valuta; ShopWebinfo has no currency field; help-page primary is Site Standard, unread here. Rate 1 is not a recorded default and list order is not. Shop currency is left unset. Check the Shopify shop currency before importing orders — a mismatch restates every historical total.`,
          { entity: "settings", id: "currency" });
      }

      // F10/F21 — the shop states its own VAT basis, machine-readable.
      const vatInclusive = bool(webinfo.ProductPricesWithVat);

      if (languages.length > 1 && !dd.multiLanguage && !cfg.options?.importTranslations) {
        warn("MULTI_LANGUAGE_PARTIAL",
          `The shop has ${languages.length} language layers (${languages.map((l) => s(l.LanguageISO)).join(", ")}). This export carries the primary layer only (${s(primary?.LanguageISO) || "?"}). Translated titles, descriptions and slugs on the other layers are NOT migrated — a layer holds only what has been translated (F9), so nothing is overwritten, it is simply not exported.`);
      }
      if (groups.length > 1) {
        warn("KUNDEGRUPPE_PRICING",
          `The shop has ${groups.length} customer groups (${groups.map((g) => txt(g.Title)).join(", ")}), so customer-group pricing may be in play. Group-scoped price lines are exported as data but never set a product's price (R29); Shopify B2B catalogs are a separate build. Check whether any group carries load-bearing trade prices before go-live.`,
          { severity: "action" });
      }
      let deliveryTimes = new Map();
      try {
        for (const dt of arr((await client.call("Product_GetDeliveryTimeAll")).result)) {
          const id = s(dt?.Id);
          if (id) deliveryTimes.set(id, txt(dt?.TitleInStock) || txt(dt?.TitleNoStock) || txt(dt?.Title) || txt(dt?.Name) || id);
        }
      } catch (e) {
        log.debug(`dandomain: Product_GetDeliveryTimeAll unavailable (${e.message})`);
      }
      let additionalTypesAll = [];
      try { additionalTypesAll = arr((await client.call("Product_GetAdditionalTypesAll")).result); }
      catch (e) { log.debug(`dandomain: Product_GetAdditionalTypesAll unavailable (${e.message})`); }
      let extraBuyCategories = [];
      try { extraBuyCategories = arr((await client.call("Product_GetAllExtraBuyCategory")).result); }
      catch (e) { log.debug(`dandomain: Product_GetAllExtraBuyCategory unavailable (${e.message})`); }
      return { webinfo, currencies, vatGroups, languages, groups, countries, vatById, primary, currency, vatInclusive, deliveryTimes, additionalTypesAll, extraBuyCategories };
    })();
    return ctxPromise;
  }

  /** ProductId -> VAT percentage. R2: the rate is on the PRODUCT, never on the
   *  order, so an order export needs the catalogue's VAT groups even when
   *  products are not being exported in the same run. One paged read of a
   *  three-field projection, which is far cheaper than the full catalogue. */
  let vatMapPromise = null;
  // Filled as a side effect of products() when both entities are exported in
  // one run, which is the normal case: runExport walks products before orders,
  // so the catalogue is read ONCE instead of twice.
  const vatCache = { byId: new Map(), bySku: new Map(), complete: false };
  const rememberVat = (p, vatById) => {
    const pct = vatById.get(s(p.VatGroupId)) ?? null;
    const entry = { pct, group: s(p.VatGroupId) };
    vatCache.byId.set(s(p.Id), entry);
    if (s(p.ItemNumber)) vatCache.bySku.set(s(p.ItemNumber), entry);
  };

  function productVatMap() {
    if (vatCache.complete) return Promise.resolve(vatCache);
    vatMapPromise = vatMapPromise || (async () => {
      const ctx = await shopContext();
      await negotiateFieldSet("Product", ["Id", "ItemNumber", "VatGroupId"]);
      // O14 — page walk; do not materialise via readAll.
      const iterator = client.readPages("Product_GetAllWithLimit", { pageSize, ...auditOpts });
      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
        for (const p of step.value.records) rememberVat(p, ctx.vatById);
      }
      vatCache.complete = true;
      return vatCache;
    })();
    return vatMapPromise;
  }

  // ------------------------------------------------------------------------------------------
  // products
  // ------------------------------------------------------------------------------------------

  /** R31 — a variant's option values. `Product_GetVariantTypeValues(VariantId)`
   *  gives the LINK but drops `Sorting`, `Picture` and `Color`, so it cannot
   *  order Shopify option values on its own; the per-type list carries them.
   *  Neither operation alone is sufficient — the JOIN is the mapping. */
  function variantOptionResolver() {
    const byType = new Map();   // typeId -> [{Id,Title,Sorting,Color,Picture}]
    const byValueId = new Map(); // valueId -> { typeId, title, sorting, color, picture }
    const byVariant = new Map();
    const typeTitle = new Map(); // typeId -> "Størrelse"
    let linkPath = null;
    let typesLoaded = false;
    let perVariantCalls = 0;

    /**
     * The option NAMES and every option VALUE, loaded once up front.
     *
     * `Product.VariantTypes` is declared `xsd:string` in the WSDL and came back
     * collapsed under the old parser (R20), so its shape is not something to bet
     * an option model on — `Product_GetVariantTypeAll` takes no arguments and
     * states the titles directly. Loading each type's VALUES here as well is
     * what makes R31's JOIN a map lookup instead of a per-variant request: a
     * variant's link gives a bare value id, and only the per-type list carries
     * the `Sorting` that decides Shopify's option order. A shop has a handful of
     * variant types and thousands of variants, so this is a handful of calls
     * against an N+1 over the catalogue.
     */
    const loadTypeTitles = async () => {
      if (typesLoaded) return typeTitle;
      typesLoaded = true;
      let types = [];
      try { types = arr((await client.call("Product_GetVariantTypeAll")).result); }
      catch (e) { log.debug(`dandomain: variant type titles unavailable (${e.message})`); return typeTitle; }
      for (const t of types) if (s(t.Id)) typeTitle.set(s(t.Id), txt(t.Title));
      for (const t of types) {
        if (!s(t.Id)) continue;
        try { await loadType(t.Id); }
        catch (e) { log.debug(`dandomain: variant type ${s(t.Id)} values unavailable (${e.message})`); }
      }
      return typeTitle;
    };

    const loadType = async (typeId) => {
      const key = s(typeId);
      if (byType.has(key)) return byType.get(key);
      const rows = arr((await client.call("Product_GetVariantTypeValuesByType", { VariantTypeId: Number(typeId) })).result);
      byType.set(key, rows);
      for (const v of rows) {
        byValueId.set(s(v.Id), {
          typeId: s(v.ProductVariantTypeId) || key,
          title: txt(v.Title),
          sorting: num(v.Sorting) ?? 0,
          color: s(v.Color) || null,
          picture: s(v.Picture) || null
        });
      }
      return rows;
    };

    const fetchOne = async (variant) => {
      const key = s(variant?.Id);
      if (byVariant.has(key)) return byVariant.get(key);
      perVariantCalls += 1;
      const rows = arr((await client.call("Product_GetVariantTypeValues", { VariantId: Number(key) })).result);
      const ids = rows.map((r) => s(r.Id)).filter(Boolean);
      for (const r of rows) {
        if (!byValueId.has(s(r.Id))) {
          byValueId.set(s(r.Id), { typeId: s(r.ProductVariantTypeId), title: txt(r.Title), sorting: null, color: s(r.Color) || null, picture: null });
        }
      }
      byVariant.set(key, ids);
      if (linkPath && linkPath !== "per-variant") linkPath = "mixed";
      else linkPath = linkPath || "per-variant";
      return ids;
    };

    /** Collect variants whose inline link is empty, then refetch in bounded batches. */
    const prefetchMissing = async (variants) => {
      const missing = [];
      for (const variant of variants) {
        const inline = arr(variant?.VariantTypeValues).map((v) => s(v?.Id ?? v)).filter(Boolean);
        if (inline.length) continue;
        const key = s(variant?.Id);
        if (!key || byVariant.has(key)) continue;
        missing.push(variant);
      }
      await mapBatches(missing, REFETCH_CONCURRENCY, fetchOne);
    };

    /** Value ids for one variant. Prefers the INLINE `VariantTypeValues` array —
     *  R20 recorded it collapsed, but that was the naive parser (R18), and with
     *  the real one it may simply be there. Falls back to the per-variant call.
     *  Which path was taken is recorded rather than assumed. */
    const valueIdsFor = async (variant) => {
      const inline = arr(variant?.VariantTypeValues).map((v) => s(v?.Id ?? v)).filter(Boolean);
      if (inline.length) {
        if (linkPath && linkPath !== "inline") linkPath = "mixed";
        else linkPath = linkPath || "inline";
        return inline;
      }
      return fetchOne(variant);
    };

    return {
      loadType, loadTypeTitles, valueIdsFor, prefetchMissing, byValueId,
      /** The Shopify option name for a variant type. Falls back to the type id
       *  rather than to a guessed label — a wrong option NAME merges two
       *  dimensions into one on Shopify. */
      nameOf(typeId) { return typeTitle.get(s(typeId)) || `Variant ${s(typeId)}`; },
      get linkPath() { return linkPath; },
      get perVariantCalls() { return perVariantCalls; },
      async describe(valueId) {
        const known = byValueId.get(s(valueId));
        if (known && known.sorting !== null) return known;
        if (known?.typeId) { await loadType(known.typeId); return byValueId.get(s(valueId)) ?? known; }
        return known ?? null;
      }
    };
  }

  async function* products(resume = null) {
    const ctx = await shopContext();  // shop-level warnings (languages, customer groups)
    await negotiateFieldSet("Product", PRODUCT_FIELDS);
    try { await negotiateFieldSet("ProductVariant", VARIANT_FIELDS); }
    catch (e) { warn("FIELD_SET_REJECTED", `ProductVariant field set could not be negotiated (${e.message}) — variants fall back to the server's default projection, which may omit price or stock.`, { id: "ProductVariant" }); }

    await categoryIndex();
    const options = variantOptionResolver();
    await options.loadTypeTitles();

    // O14 — drive readPages and yield per page (never await readAll first).
    // O15 — resume.restart carries { start } for Product_GetAllWithLimit offset style.
    const restart = resume?.restart && typeof resume.restart === "object" ? resume.restart : {};
    const iterator = client.readPages("Product_GetAllWithLimit", {
      pageSize,
      ...auditOpts,
      ...restart,
    });
    let walk = null;
    let pages = 0;
    let totalRecords = 0;
    const auditAcc = [];

    let reviewCount = 0;
    let variantsWithoutOptions = 0;
    let producerReadError = null;
    const missingCategory = new Set();
    const missingProducer = new Set();

    for (;;) {
      const step = await iterator.next();
      if (step.done) { walk = step.value ?? null; break; }
      pages += 1;
      const pageRecords = step.value.records || [];
      totalRecords += pageRecords.length;
      for (const p of pageRecords) auditAcc.push(p);
      await options.prefetchMissing(pageRecords.flatMap((p) => arr(p.Variants)));

      for (const p of pageRecords) {
        const id = s(p.Id);
        const listPrice = num(p.Price);
        rememberVat(p, ctx.vatById);

      // ---- price lines (R29/R42) ----
      const pp = publicPrice(p, { now, listPrice });
      // WHERE THE PUBLIC PRICE HAS TO LAND, and why this is not obvious.
      // `transform/products.js` prices a VARIABLE product from `_variations`
      // only — the top-level `price` is read for a simple product and discarded
      // for a variable one. So writing the R42 price at the top level alone
      // means the rule this project spent two probe rounds confirming never
      // reaches Shopify for any product with variants. The public price is
      // therefore applied to the VARIANTS too, as a delta from the list price.
      //
      // And it goes in `regular_price` when it is DEARER than Product.Price:
      // `transform/products.js` treats `sale_price > regular_price` as a
      // data-entry error and drops the sale, which would silently re-impose the
      // clamp R42 removed.
      // A RATIO NEEDS A USABLE BASE. With `Product.Price` empty, 0 or negative
      // there is no ratio, and copying `pp.price` onto every variant flattens a
      // product whose variants are deliberately priced apart — a 300 DKK variant
      // sold at 55. When the base is unusable the variants keep THEIR OWN prices
      // and the shop is told, which is lossy and visible rather than lossy and
      // silent.
      const scalable = listPrice !== null && listPrice > 0;
      /**
       * Apply a public price LINE to a base price.
       *
       * `ref` is the price the line was quoted AGAINST, and making it an argument
       * is the whole point — the two callers quote against different things:
       *   - a PRODUCT-level line is quoted against `Product.Price`, so a variant
       *     priced apart moves by the same RATIO instead of being flattened onto
       *     the line;
       *   - a VARIANT-scoped line (`ProductDiscount.ProductVariantId`) is quoted
       *     against that variant's own price and IS that variant's price. Scaling
       *     it by the product's ratio prices the variant at neither number.
       *
       * Both of the branches below were wrong before a mutation test went looking.
       * `!usable` used to return the line for EVERY caller, so a product with an
       * empty or zero Price copied its 55 DKK line onto a 300 DKK variant — the
       * flattening the comment right here claimed to prevent. And the variant
       * caller passed the product's ref, so a variant-scoped line was scaled.
       */
      const applyLine = (base, chosen, ref) => {
        if (chosen === null || chosen === undefined) return { regular: base, sale: null };
        if (base === null) return { regular: chosen, sale: null };
        const usable = ref !== null && ref > 0;
        if (!usable) {
          // No ratio exists. Where the base IS the unusable reference there is
          // nothing to keep and the line is the price; where the base is a real
          // price of its own it is KEPT, and the shop is told (below).
          return base === ref ? { regular: chosen, sale: null } : { regular: base, sale: null };
        }
        const scaled = base * (chosen / ref);
        // A line DEARER than its reference goes in `regular`, not `sale`:
        // transform/products.js drops a sale above regular as a data-entry error,
        // which would silently re-impose the clamp R42 removed.
        return chosen > ref ? { regular: scaled, sale: null } : { regular: base, sale: scaled };
      };
      const publicDelta = (base) => (pp.source !== "price-line" ? { regular: base, sale: null } : applyLine(base, pp.price, listPrice));
      const topPrice = publicDelta(listPrice);
      if (pp.source === "price-line" && !scalable && arr(p.Variants).length) {
        warn("PRICE_LINE_NOT_SCALABLE",
          `Product ${id} "${txt(p.Title)}" has a public price line but its own Price is ${JSON.stringify(s(p.Price))}, so there is no ratio to apply to its ${arr(p.Variants).length} variant(s). The variants keep their own prices and the price line is applied to the product only. Set a base price on the product, or check the variants on the storefront.`,
          { entity: "product", id });
      }
      if (pp.variantScopedRows) {
        warn("PRICE_LINES_VARIANT_SCOPED",
          `Product ${id} "${txt(p.Title)}" has ${pp.variantScopedRows} price line(s) scoped to a specific VARIANT (ProductDiscount.ProductVariantId). Each is applied to that variant alone; the product-level price comes from the unscoped rows. If a variant's storefront price looks wrong, this is the field to check.`,
          { entity: "product", id, severity: "handled" });
      }
      if (pp.dropped.length) {
        // Every reason accounted for. A warning whose job is accounting for
        // price lines must not leave rows unexplained — the first version
        // reported "1 scoped, 0, 0, 0" for four dropped rows.
        const byReason = new Map();
        for (const d of pp.dropped) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
        const breakdown = [...byReason.entries()].map(([r, n]) => `${n} ${r.replace(/-/g, " ")}`).join(", ");
        warn("PRICE_LINES_DROPPED",
          `Product ${id} "${txt(p.Title)}" has ${pp.rows} price line(s) at this scope; ${pp.dropped.length} do not set the public price (${breakdown}). Shopify carries ONE price per variant, so only the public one migrates. A customer-scoped line is a trade price: importing it as the public price would publish trade pricing to every visitor (R29).`,
          { entity: "product", id });
      }
      if (pp.dearerThanListPrice) {
        warn("PRICE_LINE_ABOVE_LIST",
          `Product ${id}: the public price line (${pp.dearerThanListPrice.line}) is DEARER than the product's own entered price (${pp.dearerThanListPrice.listPrice}). The price line was used, because R42 recorded that the storefront serves the price line rather than Product.Price — but the two disagreeing usually means one of them is stale. Check which one the shop actually shows.`,
          { entity: "product", id });
      }
      if (pp.unknownScope.length) {
        warn("PRICE_LINE_UNKNOWN_SCOPE",
          `Product ${id}: price line(s) carry a UserType outside the server's own vocabulary (${pp.unknownScope.map((u) => JSON.stringify(u.userType)).join(", ")}). The server accepts and stores these, so they are real rows whose audience is unknown — they were treated as NOT public. Check them in the shop admin.`,
          { entity: "product", id });
      }
      if (pp.undecodedDiscountType) {
        warn("DISCOUNT_TYPE_UNDECODED",
          `Product ${id}: a price line carries DiscountType ${JSON.stringify(pp.undecodedDiscountType)}. The a/b vocabulary on this platform is undecoded, and R37 established it cannot be decoded from the API at all — the field is an unvalidated ONE-CHARACTER column, so there is no enumeration to read out of a fault. The row's Price was used as-is and its Discount field was NOT applied. Check this product's price on the storefront: ${storefrontHint(id)}`,
          { entity: "product", id });
      }

      // R20/R37 — `Product.Discount` / `ProductVariant.Discount` and their
      // `DiscountType` are read and deliberately NOT applied: the a/b vocabulary
      // is undecoded and R37 proved the API cannot decode it. Dropping them
      // quietly would be the silent half of invariant 5, so the value is carried
      // in meta_data AND said out loud.
      const droppedDiscount = num(p.Discount) || arr(p.Variants).reduce((t, v) => t + (num(v.Discount) || 0), 0);
      if (droppedDiscount) {
        warn("PRODUCT_DISCOUNT_NOT_APPLIED",
          `Product ${id} "${txt(p.Title)}" carries a product- or variant-level Discount (${num(p.Discount) || 0} on the product, DiscountType ${JSON.stringify(s(p.DiscountType))}) that is NOT applied to the exported price. This platform's DiscountType is an unvalidated one-character column whose a/b meaning is undecoded (R20/R37), so applying it would be guessing at money. The product exports at its price-line or entered price; the raw values ride in meta_data. Check this product on the storefront: ${storefrontHint(id)}`,
          { entity: "product", id });
      }

      // ---- media (R14/R21) ----
      const pics = arr(p.Pictures).sort((a, b) => (num(a.Sorting) ?? 0) - (num(b.Sorting) ?? 0));
      const images = mediaBase
        ? pics.map((pic) => ({ src: mediaUrl(mediaBase, PRODUCT_MEDIA_DIR, pic.FileName), alt: altOf(pic, iso, txt(p.Title)) })).filter((i) => i.src)
        : [];
      if (!mediaBase && pics.length) {
        warn("MEDIA_BASE_UNKNOWN",
          `No media base is configured (source.dandomain.tenant or .mediaBase), so ${pics.length} product image(s) on product ${id} — and every other product's — cannot be turned into a URL. Shopify fetches media from a URL, so the catalogue would import with no images at all and no error. Set the tenant and re-run the export.`,
          { entity: "product", id: "all" });
      }

      // ---- reviews (R19) — counted, then dropped ----
      const tags = arr(p.Tags);
      reviewCount += tags.length;

      // ---- variants -> Woo attributes + _variations (R25/R31) ----
      const rawVariants = arr(p.Variants);
      const attributes = [];
      const variations = [];
      if (rawVariants.length) {
        const optionOrder = [];      // typeId in first-seen order
        const optionValues = new Map(); // typeId -> Map(valueId -> {title, sorting})
        const perVariant = [];
        for (const v of rawVariants) {
          const ids = await options.valueIdsFor(v);
          const described = [];
          for (const vid of ids) {
            const d = await options.describe(vid);
            if (!d) continue;
            const t = s(d.typeId);
            if (!optionValues.has(t)) { optionValues.set(t, new Map()); optionOrder.push(t); }
            optionValues.get(t).set(s(vid), { title: d.title, sorting: d.sorting ?? 0 });
            described.push({ typeId: t, valueId: s(vid), title: d.title });
          }
          if (!described.length) variantsWithoutOptions++;
          perVariant.push({ v, described });
        }

        // R31 — option VALUES are ordered by the per-type `Sorting`, never
        // alphabetically. Størrelse sorts Small=1 / Medium=2 / Large=3, and an
        // alphabetical fallback would have produced Large / Medium / Small.
        for (const t of optionOrder) {
          const values = [...optionValues.get(t).entries()]
            .sort((a, b) => (a[1].sorting ?? 0) - (b[1].sorting ?? 0) || a[1].title.localeCompare(b[1].title))
            .map(([, x]) => x.title);
          attributes.push({
            id: Number(t) || 0,
            name: options.nameOf(t),
            position: attributes.length,
            visible: true,
            variation: true,
            options: values
          });
        }

        for (const { v, described } of perVariant) {
          const vprice = num(v.Price);
          // The public-price rule applies PROPORTIONALLY to each variant: a
          // variant priced above or below the product carries its own number,
          // and the price line moves all of them by the same ratio. Copying
          // `pp.price` onto every variant would flatten a product whose variants
          // are deliberately priced apart.
          // The variant's OWN price lines win over the product's (R29 applied at
          // the scope the row names).
          const vpp = publicPrice(p, { now, listPrice: vprice ?? listPrice, variantId: s(v.Id) });
          const vbase = vprice ?? listPrice;
          // `vpp.rows` is NOT the test for "this variant has its own line":
          // publicPrice falls back to the product-level rows when the variant has
          // none, so `rows > 0` is true either way. `variantScoped` is the fact
          // that decides which reference the line was quoted against.
          const vp = vpp.source === "price-line" && vpp.variantScoped
            ? applyLine(vbase, vpp.price, vbase)      // the line IS this variant's price
            : publicDelta(vbase);                     // the product's line, applied by ratio
          const vimg = variantImageFromPictures(pics, v, mediaBase, iso, txt(v.Title) || txt(p.Title));
          variations.push({
            id: num(v.Id),
            sku: s(v.ItemNumber) || undefined,
            global_unique_id: s(v.Ean) || undefined,
            regular_price: money2(vp.regular),
            ...(vp.sale === null ? {} : { sale_price: money2(vp.sale) }),
            price: money2(vp.sale ?? vp.regular),
            stock_quantity: num(v.Stock),
            manage_stock: true,
            backorders: bool(p.OutOfStockBuy) ? "yes" : "no",
            weight: num(v.Weight) ?? num(p.Weight) ?? undefined,
            downloadable: false,
            virtual: false,
            attributes: described.map((d) => ({ name: options.nameOf(d.typeId), option: d.title })),
            ...(vimg ? { image: vimg } : {}),
            meta_data: [{ key: "_dd_variant_id", value: s(v.Id) }].concat(s(v.ItemNumberSupplier) ? [{ key: "_dd_supplier_item_number", value: s(v.ItemNumberSupplier) }] : [])
          });
        }
      }

      // ---- categories ----
      // The SLUG is load-bearing, not decoration: `transform/products.js` builds
      // `membership.categorySlugs` from it and `import/collections.js` looks each
      // one up in the collection ledger BY SLUG. A null slug becomes the handle
      // "item" (toHandle's fallback), every lookup misses, and the run finishes
      // with collections created, products created and NOT ONE product in a
      // collection — no error, no warning, exit 0. So the category rows are
      // joined here rather than left for a stage that has no way to fill them.
      const cats = [];
      const pushCat = (cid, main) => {
        const key = s(cid);
        if (!key || key === "0") return;
        const c = catIndex.get(key);
        cats.push({ id: Number(key), slug: c?.slug ?? null, name: c?.name ?? null, _main: main });
        if (!c) missingCategory.add(key);
      };
      pushCat(p.CategoryId, true);
      for (const sc of arr(p.SecondaryCategoryIds)) {
        const cid = s(sc?.Id ?? sc);
        if (cid && cid !== s(p.CategoryId)) pushCat(cid, false);
      }

      // F21 — a customer group flagged `Producer: true` doubles as the brand
      // record on this platform ("Brands / Producenter"), and `Product.ProducerId`
      // points at a USER. Without a name the transform emits `vendor: undefined`.
      let producer = null;
      if (s(p.ProducerId) && s(p.ProducerId) !== "0") {
        // A FAILED read is not the same finding as an id with no name. The old
        // version collapsed both into PRODUCER_NOT_FOUND at severity "handled",
        // so an HTTP 500 on User_GetAll lost every vendor in the catalogue and
        // reported it as though the shop's data were incomplete.
        try { await allUsers(); }
        catch (e) { producerReadError = producerReadError ?? e.message; }
        producer = producerIndex.get(s(p.ProducerId)) ?? null;
        if (!producer && !producerReadError) missingProducer.add(s(p.ProducerId));
      }

      // R4 note — `UserGroupAccessIds` is a WSDL field this adapter does NOT
      // request, so a product restricted to a B2B login group is indistinguishable
      // here from a public one and would import PUBLICLY VISIBLE. Requested and
      // reported below rather than assumed absent.
      const restricted = arr(p.UserGroupAccessIds).map((g) => s(g?.Id ?? g)).filter(Boolean);
      if (restricted.length) {
        warn("PRODUCT_GROUP_RESTRICTED",
          `Product ${id} "${txt(p.Title)}" is visible only to customer group(s) ${restricted.join(", ")} on the source. Shopify has no equivalent on a plain product, so it imports PUBLICLY VISIBLE unless you unpublish it or move it behind a B2B catalog. This is a disclosure risk, not just a mapping gap.`,
          { entity: "product", id });
      }

      // F17 — `Status` and `Online` are two DIFFERENT flags and both matter.
      // A product can be Status:true and Online:false; only the pair decides
      // whether a visitor can see it, so both ride along and the publish
      // decision uses the conjunction.
      const published = bool(p.Status) && bool(p.Online);
      const mainSlug = cats.find((c) => c._main)?.slug;
      const composed = origin ? productPath({ catId: s(p.CategoryId), catSlug: mainSlug, prodId: id, prodSlug: s(p.SeoLink) }) : null;

      const typeNum = s(p.Type);
      const typeLabel = s(p.TypeLabel).toLowerCase();
      const relatedIds = arr(p.RelatedProductIds).map((r) => s(r?.Id ?? r)).filter(Boolean);
      let productType = variations.length ? "variable" : "simple";
      let groupedProducts = [];
      let downloadable = false;
      let downloads = [];
      if (typeNum === "1" || /pakke|bundle/.test(typeLabel)) {
        productType = "grouped";
        groupedProducts = relatedIds.map((rid) => Number(rid)).filter((n) => Number.isFinite(n));
        warn("GROUPED_CONVERTED",
          `Product ${id} "${txt(p.Title)}" is a DanDomain pakkeprodukt (Type ${JSON.stringify(typeNum)}, TypeLabel ${JSON.stringify(s(p.TypeLabel))}). It exports as a Woo grouped product${groupedProducts.length ? ` with ${groupedProducts.length} related id(s)` : " without component ids on RelatedProductIds"} — transform converts it to a collection, not a buyable product.`,
          { entity: "product", id, severity: "handled" });
      } else if (typeLabel === "file-sale" || typeLabel === "filsalg") {
        downloadable = true;
        downloads = [{ name: txt(p.Title) || `product-${id}`, file: "(DanDomain filsalg — file bytes are not exported)" }];
      } else if ((typeNum && typeNum !== "0") || (typeLabel && typeLabel !== "normal" && !typeLabel.includes("gift-card"))) {
        warn("PRODUCT_TYPE_UNMAPPED",
          `Product ${id} "${txt(p.Title)}" carries Type ${JSON.stringify(typeNum)} / TypeLabel ${JSON.stringify(s(p.TypeLabel))} — no Shopify product-type mapping is applied. It imports as a standard product; check the storefront if this should be a bundle, digital download, or gift-card SKU.`,
          { entity: "product", id });
      }
      if (relatedIds.length && productType !== "grouped") {
        warn("RELATED_PRODUCTS_NOT_MIGRATED",
          `Product ${id} "${txt(p.Title)}" lists ${relatedIds.length} related product id(s) (${relatedIds.slice(0, 5).join(", ")}${relatedIds.length > 5 ? ", …" : ""}). Ids land on product metafield dandomain.related_product_ids — recreate recommendations in Search & Discovery or an app after go-live.`,
          { entity: "product", id, severity: "handled" });
      }
      if (s(p.SeoKeywords)) {
        warn("SEO_KEYWORDS_NOT_MIGRATED",
          `Product ${id} "${txt(p.Title)}" carries SeoKeywords (${JSON.stringify(txt(p.SeoKeywords).slice(0, 80))}${txt(p.SeoKeywords).length > 80 ? "…" : ""}). Keywords land on product metafield dandomain.seo_keywords for SEO workflows.`,
          { entity: "product", id, severity: "handled" });
      }
      let tilvalgRows = [];
      const deliveryTitle = ctx.deliveryTimes?.get(s(p.DeliveryTimeId));
      if (ctx.additionalTypesAll?.length) {
        try {
          const addTypes = arr((await client.call("Product_GetAdditionalTypes", { ProductId: num(p.Id) })).result);
          if (addTypes.length) {
            tilvalgRows = addTypes.map((t) => ({ id: s(t.Id), title: txt(t.Title) })).filter((t) => t.id || t.title);
            warn("TILVALG_NOT_MIGRATED",
              `Product ${id} "${txt(p.Title)}" has ${addTypes.length} tilvalg/add-on type(s) (${addTypes.map((t) => txt(t.Title) || s(t.Id)).slice(0, 3).join(", ")}). Payload lands on product metafield dandomain.tilvalg — rebuild options as line-item properties, an app, or manual variants.`,
              { entity: "product", id, severity: "handled" });
          }
        } catch (e) {
          log.debug(`dandomain: Product_GetAdditionalTypes(${id}) failed (${e.message})`);
        }
      }
      let extrabuyRels = [];
      if (ctx.extraBuyCategories?.length) {
        try {
          const rels = arr((await client.call("Product_GetExtraBuyRelations", { ProductId: num(p.Id) })).result);
          if (rels.length && productType !== "grouped") {
            extrabuyRels = rels.map((r) => ({
              id: s(r.Id),
              productId: s(r.ProductId),
              relationProductId: s(r.RelationProductId),
              categoryId: s(r.ExtraBuyCategoryId),
            })).filter((r) => r.relationProductId);
            warn("RELATED_PRODUCTS_NOT_MIGRATED",
              `Product ${id} "${txt(p.Title)}" has ${rels.length} ExtraBuy relation(s). Relations land on product metafield dandomain.extrabuy_relations — recreate recommendations in Search & Discovery or an app after go-live.`,
              { entity: "product", id, severity: "handled" });
          }
        } catch (e) {
          log.debug(`dandomain: Product_GetExtraBuyRelations(${id}) failed (${e.message})`);
        }
      }

      const record = {
        id: num(p.Id),
        name: txt(p.Title),
        slug: s(p.SeoLink) || null,
        // F7 — the product `Url` field comes back EMPTY on every product, so
        // there is no permalink to READ. P3 composes from the R41 grammar
        // `{tenant}.mywebshop.io/shop/{catId}-{catSlug}/{prodId}-{prodSlug}/`.
        // Empty SeoLink: no recorded product-slug fallback (D9) — permalink
        // stays null rather than inventing a path the storefront never served.
        // Doctor confirms the page CONTAINS the item number (R39: a 200 is not
        // evidence). Grammar proved on one shop, one theme.
        permalink: composed ? `${origin}${composed}/` : null,
        status: published ? "publish" : "draft",
        type: productType,
        ...(groupedProducts.length ? { grouped_products: groupedProducts } : {}),
        description: txt(p.DescriptionLong) || txt(p.Description) || "",
        short_description: txt(p.DescriptionShort) || "",
        sku: s(p.ItemNumber) || undefined,
        global_unique_id: s(p.Ean) || undefined,
        // R1 — `Product.Price` is the ENTERED price and is VAT-INCLUSIVE when
        // the shop's basis says so (F10/F21). It is the consumer price and maps
        // straight onto Woo's regular_price, which the transform treats the same
        // way. The NET side of this API is the ORDER side; the two must never
        // be mixed, and they carry the same field name.
        regular_price: money2(topPrice.regular),
        sale_price: topPrice.sale === null ? "" : money2(topPrice.sale),
        price: money2(pp.price),
        date_created_gmt: ddDate(p.DateCreated),
        date_modified_gmt: ddDate(p.DateUpdated),
        manage_stock: true,
        stock_quantity: num(p.Stock),
        backorders: bool(p.OutOfStockBuy) ? "yes" : "no",
        weight: num(p.Weight) ?? undefined,
        tax_status: "taxable",
        categories: cats,
        brands: producer ? [{ id: num(p.ProducerId), name: producer }] : [],
        images,
        // NOT p.Tags. R19: that field is REVIEWS carrying UserEmail.
        // Focus flags are real WSDL booleans (requested in PRODUCT_FIELDS) and
        // become merchandising tags — not review text.
        tags: [
          ...(bool(p.FocusFrontpage) ? [{ name: "dd-focus-frontpage" }] : []),
          ...(bool(p.FocusCart) ? [{ name: "dd-focus-cart" }] : []),
        ],
        attributes,
        _variations: variations,
        downloadable,
        virtual: false,
        ...(downloads.length ? { downloads } : {}),
        meta_data: [
          { key: "_dd_id", value: s(p.Id) },
          { key: "_dd_main_category_id", value: s(p.CategoryId) },
          ...(s(p.SeoLink) ? [{ key: "_dd_seo_link", value: s(p.SeoLink) }] : []),
          ...(s(p.SeoKeywords) ? [{ key: "_dd_seo_keywords", value: txt(p.SeoKeywords) }] : []),
          ...(relatedIds.length && productType !== "grouped"
            ? [{ key: "_dd_related_product_ids", value: JSON.stringify(relatedIds) }]
            : []),
          ...(extrabuyRels.length
            ? [{ key: "_dd_extrabuy_relations", value: JSON.stringify(extrabuyRels) }]
            : []),
          ...(tilvalgRows.length
            ? [{ key: "_dd_tilvalg", value: JSON.stringify(tilvalgRows) }]
            : []),
          ...(s(p.Ean) ? [{ key: "_barcode", value: s(p.Ean) }] : []),
          ...(s(p.ItemNumberSupplier) ? [{ key: "_dd_supplier_item_number", value: s(p.ItemNumberSupplier) }] : []),
          ...(s(p.UnitId) ? [{ key: "_dd_unit_id", value: s(p.UnitId) }] : []),
          ...(s(p.DeliveryTimeId) ? [{ key: "_delivery_time", value: s(p.DeliveryTimeId) }] : []),
          ...(deliveryTitle ? [{ key: "_delivery_time_title", value: deliveryTitle }] : []),
          ...(s(p.VatGroupId) ? [{ key: "_dd_vat_group_id", value: s(p.VatGroupId) }] : []),
          ...(mainSlug ? [{ key: "_dd_main_category_slug", value: mainSlug }] : []),
          ...(num(p.Discount) ? [{ key: "_dd_discount", value: s(p.Discount) }] : []),
          ...(s(p.DiscountType) ? [{ key: "_dd_discount_type", value: s(p.DiscountType) }] : []),
          ...(restricted.length ? [{ key: "_dd_user_group_access", value: restricted.join(",") }] : []),
          ...(bool(p.CallForPrice) ? [{ key: "_dd_call_for_price", value: "1" }] : []),
          ...(s(p.GuidelinePrice) ? [{ key: "_dd_guideline_price", value: s(p.GuidelinePrice) }] : []),
          ...(num(p.BuyingPrice) !== null ? [{ key: "_dd_buying_price", value: s(p.BuyingPrice) }] : []),
          ...(() => {
            const rows = arr(p.Discounts)
              .filter((d) => s(d.UserType) === "group" && s(d.UserId) && s(d.UserId) !== "0")
              .map((d) => ({
                userId: s(d.UserId),
                variantId: s(d.ProductVariantId),
                price: money2(num(d.Price)),
              }))
              .filter((d) => d.price !== null);
            return rows.length ? [{ key: "_dd_group_discounts", value: JSON.stringify(rows) }] : [];
          })(),
          // F17: both flags, because the pair is the fact.
          { key: "_dd_status", value: bool(p.Status) ? "1" : "0" },
          { key: "_dd_online", value: bool(p.Online) ? "1" : "0" },
          ...arr(p.CustomData).map((c) => ({ key: `_dd_custom_${s(c.ProductCustomTypeId) || s(c.Id)}`, value: txt(c.Title) })),
          ...arr(p.StockLocations).map((sl) => ({ key: `_dd_stock_location_${s(sl.StockLocationId)}`, value: s(sl.Stock) }))
        ],
        // SEO fields the transform's extractSeo() reads through the same shape
        // Yoast uses, so no transform change is needed for titles/descriptions.
        yoast_head_json: (s(p.SeoTitle) || s(p.SeoDescription))
          ? { title: txt(p.SeoTitle) || undefined, description: txt(p.SeoDescription) || undefined }
          : undefined
      };

      if (bool(p.CallForPrice)) {
        warn("CALL_FOR_PRICE",
          `Product ${id} "${txt(p.Title)}" is marked "ring for pris" (CallForPrice) — DanDomain hides its price and takes an enquiry instead. Shopify has no equivalent: it imports with its stored price (${money2(listPrice)}) VISIBLE. Unpublish it, or replace it with a contact form, before go-live.`,
          { entity: "product", id });
      }
      yield record;
      } // per product in page
    } // pages

    let audit = null;
    try {
      if (auditAcc.length && client.auditAgainstFieldSet) {
        audit = client.auditAgainstFieldSet("Product", auditAcc, { throwOnTruncation: false });
      }
    } catch (e) { log.debug(`dandomain: product audit skipped (${e.message})`); }
    const walkSummary = {
      ...(walk || {}),
      records: auditAcc,
      pages,
      audit,
      requests: walk?.requests ?? pages,
      complete: walk?.complete ?? false,
    };
    reportAudit("products", audit);
    reportWalk("products", walkSummary);
    log.debug(`dandomain: ${totalRecords} products in ${walkSummary.requests} request(s) across ${pages} page(s)`);

    // Only now: a half-drained generator has a half-built map, and an order
    // export reading that would derive tax from a partial catalogue.
    vatCache.complete = true;

    if (reviewCount) {
      warn("REVIEWS_NOT_MIGRATED",
        `${reviewCount} product review(s) exist on the source. Shopify has no native review import, so they do not migrate — export them to your review app (Judge.me/Yotpo/Loox) from the DanDomain admin. They are NOT written to data/raw/ on purpose: on this platform reviews arrive through Product_GetTags and carry the reviewer's EMAIL ADDRESS (R19), which is personal data with no business being in a migration snapshot.`,
        { entity: "reviews", id: "all", severity: "info" });
    }
    if (variantsWithoutOptions) {
      warn("VARIANT_OPTIONS_UNRESOLVED",
        `${variantsWithoutOptions} variant(s) could not be linked to any option value, so they carry no option name/value pair. Shopify needs that link to build the option model — these variants will land under a default option. Check them in the shop admin.`,
        { entity: "product", id: "all" });
    }
    if (missingCategory.size) {
      warn("CATEGORY_NOT_FOUND",
        `${missingCategory.size} category id(s) referenced by products do not exist in Category_GetAll (${[...missingCategory].slice(0, 8).join(", ")}). Those products carry a category with no slug, so they will NOT land in the matching Shopify collection — the collection importer looks each membership up BY SLUG and a miss is silent. Check whether the categories were deleted while products still point at them.`,
        { entity: "product", id: "all" });
    }
    if (producerReadError) {
      warn("PRODUCER_READ_FAILED",
        `The producer/brand lookup failed (${producerReadError}), so EVERY product with a producer imports with no vendor. This is a failed read, not missing data in the shop — the same call is what customers() uses, so an export that reaches the customers stage will fail there too.`,
        { entity: "product", id: "all" });
    }
    if (missingProducer.size) {
      warn("PRODUCER_NOT_FOUND",
        `${missingProducer.size} producer id(s) on products could not be resolved to a name (${[...missingProducer].slice(0, 8).join(", ")}), so those products import with NO vendor. On this platform producers are customer-group records flagged Producer:true (F21); if the shop uses brands, they are being lost here.`,
        { entity: "product", id: "all", severity: "handled" });
    }
    if (options.perVariantCalls > 0) {
      warn("VARIANT_OPTIONS_REFETCHED",
        `The inline variant->option link (ProductVariant.VariantTypeValues) was empty on ${options.perVariantCalls} variant(s) (link path ${options.linkPath ?? "per-variant"}), so those options were read with a separate Product_GetVariantTypeValues call. Correct, but it scales with VARIANTS, not products: a 10,000-product catalogue with 3 variants each is ~30,000 requests instead of ~40. Nothing is lost; this note exists so a slow export is explained rather than mysterious.`,
        { entity: "product", id: "all", severity: "handled" });
    }
    log.debug(`dandomain: variant option link path = ${options.linkPath ?? "none"}`);
  }

  // ------------------------------------------------------------------------------------------
  // categories
  // ------------------------------------------------------------------------------------------
  async function* categories() {
    const index = await categoryIndex();
    for (const { row: c } of index.values()) {
      let image = null;
      if (mediaBase) {
        try {
          const pics = arr((await client.call("Category_GetPictures", { CategoryId: Number(c.Id) })).result)
            .sort((a, b) => (num(a.Sorting) ?? 0) - (num(b.Sorting) ?? 0));
          // R21 — category media lives under a DIFFERENT subtree from products.
          if (pics[0]) image = { src: mediaUrl(mediaBase, CATEGORY_MEDIA_DIR, pics[0].Name), alt: altOf(pics[0], iso, txt(c.Title)) };
        } catch (e) { log.debug(`dandomain: category ${c.Id} pictures unavailable (${e.message})`); }
      }
      const slug = categorySlug(c);
      const catPath = origin ? categoryPath({ catId: s(c.Id), catSlug: slug }) : null;
      yield {
        id: num(c.Id),
        name: txt(c.Title),
        // DanDomain categories DO have real slugs, unlike Woo's category API
        // (PLAN D7) — and where `SeoLink` is empty the storefront derives one
        // from the TITLE (R41). Either way it must not be null: the collection
        // importer resolves product membership BY SLUG.
        slug,
        permalink: catPath ? `${origin}${catPath}/` : null,
        parent: num(c.ParentId) ?? 0,
        description: txt(c.Description) || "",
        display: "default",
        image,
        menu_order: num(c.Sorting) ?? 0,
        _dd: {
          seoLink: s(c.SeoLink) || null,
          status: bool(c.Status),
          descriptionBottom: txt(c.DescriptionBottom) || "",
          seoTitle: txt(c.SeoTitle) || "",
          seoDescription: txt(c.SeoDescripton) || "" // sic — the WSDL misspells it
        }
      };
    }
  }

  // ------------------------------------------------------------------------------------------
  // customers
  // ------------------------------------------------------------------------------------------
  async function* customers() {
    const ctx = await shopContext();
    const rows = await allUsers();   // one read, shared with the producer lookup
    let audit = null;
    try { audit = client.auditAgainstFieldSet("User", rows, { throwOnTruncation: false }); }
    catch (e) { log.debug(`dandomain: customer audit skipped (${e.message})`); }
    reportAudit("customers", audit);

    const groupTitle = new Map(ctx.groups.map((g) => [s(g.Id), txt(g.Title)]));
    let consented = 0, newsletter = 0;

    for (const u of rows) {
      const id = s(u.Id);
      const email = s(u.Email) || s(u.Username);
      const country = countryIso(u.CountryCode, ctx);
      const shipCountry = countryIso(u.ShippingCountryCode, ctx);
      const hasShipping = Boolean(s(u.ShippingAddress) || s(u.ShippingZip) || s(u.ShippingCity));
      if (bool(u.Consent)) consented++;
      if (bool(u.Newsletter)) newsletter++;
      if (s(u.Ean)) {
        warn("EAN_INVOICING",
          `Customer ${id} carries an EAN number (${s(u.Ean)}) — Danish public-sector e-invoicing. It exports as _dd_ean and lands as customer metafield dandomain.ean; rebuild any EAN-invoicing workflow (app or manual).`,
          { entity: "customer", id, severity: "handled" });
      }

      yield {
        id: num(u.Id),
        email,
        first_name: txt(u.Firstname),
        last_name: txt(u.Lastname),
        username: s(u.Username),
        date_created_gmt: ddDate(u.DateCreated),
        date_modified_gmt: ddDate(u.DateUpdated),
        billing: {
          first_name: txt(u.Firstname), last_name: txt(u.Lastname), company: txt(u.Company),
          address_1: txt(u.Address), address_2: txt(u.Address2), city: txt(u.City),
          postcode: s(u.Zip), state: "", country, email, phone: s(u.Phone) || s(u.Mobile)
        },
        shipping: hasShipping ? {
          first_name: txt(u.ShippingFirstname) || txt(u.Firstname),
          last_name: txt(u.ShippingLastname) || txt(u.Lastname),
          company: txt(u.ShippingCompany), address_1: txt(u.ShippingAddress),
          address_2: txt(u.ShippingAddress2), city: txt(u.ShippingCity),
          postcode: s(u.ShippingZip), state: s(u.ShippingState),
          country: shipCountry, phone: s(u.ShippingPhone) || s(u.ShippingMobile)
        } : {},
        meta_data: [
          { key: "_dd_id", value: id },
          ...(s(u.Cvr) ? [{ key: "_dd_cvr", value: s(u.Cvr) }] : []),
          ...(s(u.Ean) ? [{ key: "_dd_ean", value: s(u.Ean) }] : []),
          ...(s(u.Number) ? [{ key: "_dd_debtor_number", value: s(u.Number) }] : []),
          ...(s(u.UserGroupId) ? [{ key: "_dd_customer_group", value: groupTitle.get(s(u.UserGroupId)) || s(u.UserGroupId) }] : []),
          // R23 — Consent and Newsletter are SEPARATE facts that round-trip
          // independently. Both are carried; neither is inferred from the other.
          { key: "_dd_newsletter", value: bool(u.Newsletter) ? "1" : "0" },
          { key: "_dd_consent", value: bool(u.Consent) ? "1" : "0" },
          ...(ddDate(u.ConsentDate) ? [{ key: "_dd_consent_date", value: ddDate(u.ConsentDate) }] : []),
          ...(s(u.LanguageISO) ? [{ key: "_dd_language", value: s(u.LanguageISO) }] : [])
        ],
        _dd: { groupId: s(u.UserGroupId), approved: bool(u.Approved), newsletter: bool(u.Newsletter), consent: bool(u.Consent) }
      };
    }

    if (newsletter || consented) {
      warn("NEWSLETTER_CONSENT_IMPORTED",
        `${newsletter} customer(s) are newsletter subscribers and ${consented} carry an explicit consent flag. On this platform newsletter signup is double-opt-in by design, so the consent is provable — unlike WooCommerce, where this pipeline refuses to set marketing consent at all. The flags export as customer metafields; wiring them to Shopify marketing consent is a deliberate switch, not a default.`,
        { entity: "customer", id: "all", severity: "info" });
    }
  }

  const countryIso = (code, ctx) => {
    const c = s(code);
    if (!c) return "";
    if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
    // F20/F6 — CountryCode is a NUMERIC id resolved per shop, never an ISO code.
    const hit = (ctx.countries || []).find((x) => s(x.Id) === c);
    return hit ? s(hit.Iso).toUpperCase() : "";
  };

  // ------------------------------------------------------------------------------------------
  // orders
  // ------------------------------------------------------------------------------------------

  /**
   * How much of `Order.Total` this adapter is willing to believe, and why it
   * checks rather than trusts.
   *
   * RECORDED: `Order.Total` is NET (R1) and on the probe orders it equalled the
   * sum of the line prices EXCLUDING a mandatory 70-unit delivery charge — the
   * observation that killed F18 in the adversarial review. So the model is
   * "Total = sum of net lines", and the shipping and payment amounts live on
   * `Order.Delivery.Price` / `Order.Payment.Price`.
   *
   * NOT RECORDED: whether `OrderLine.Price` is a UNIT price or a LINE total.
   * Every probe order used quantity 1, where the two hypotheses predict the
   * SAME number — the exact shape of proxy-for-the-thing this project keeps
   * catching. So it is not assumed: an order that HAS a quantity above 1 tests
   * both against `Order.Total` and lets the shop's own data decide. Orders that
   * cannot decide inherit the shop-level verdict, and if nothing ever decides,
   * the unit reading is used and SAID SO in a warning.
   */
  function decideLineBasis(pairs) {
    // Configured basis wins: an operator who has checked one order in the admin
    // knows more than this heuristic does. It is READ here — the warning below
    // tells the operator to set it, and a remediation instruction that no code
    // consumes is worse than no instruction at all.
    if (configuredLineBasis) {
      return { basis: configuredLineBasis, source: "config", evidence: null, undecidable: 0, disagreed: [] };
    }
    let basis = null, evidence = null, undecidable = 0;
    const disagreed = [];
    // ACROSS THE WHOLE BATCH, before a single order is emitted. Deciding inside
    // the emit loop means every order yielded before the decisive one keeps the
    // default, so a shop whose basis turns out to be "line" exports its early
    // orders at quantity times their real value — and the warning then reports a
    // settled basis with no hint that anything used the other reading.
    for (const { order, lines } of pairs) {
      const total = num(order.Total);
      if (total === null || !lines.length) continue;
      if (!lines.some((l) => (num(l.Amount) ?? 1) > 1)) { undecidable++; continue; }
      const asUnit = lines.reduce((t, l) => t + (num(l.Price) ?? 0) * (num(l.Amount) ?? 1), 0);
      const asLine = lines.reduce((t, l) => t + (num(l.Price) ?? 0), 0);
      const tol = 0.005 * lines.length + 0.005;
      const unitFits = Math.abs(asUnit - total) <= tol;
      const lineFits = Math.abs(asLine - total) <= tol;
      const says = unitFits && !lineFits ? "unit" : lineFits && !unitFits ? "line" : null;
      if (says === null) { undecidable++; continue; }
      if (basis === null) { basis = says; evidence = { orderId: s(order.Id), total, asUnit, asLine }; }
      else if (says !== basis) disagreed.push(s(order.Id));
    }
    return { basis: basis ?? "unit", source: basis ? "decided" : "default", evidence, undecidable, disagreed };
  }

  async function* orders(resume = null) {
    const ctx = await shopContext();
    const vat = await productVatMap();
    await negotiateFieldSet("Order", ORDER_FIELDS);
    try { await negotiateFieldSet("OrderLine", ORDER_LINE_FIELDS); }
    catch (e) { warn("FIELD_SET_REJECTED", `OrderLine field set could not be negotiated (${e.message}) — order lines fall back to the server's default projection, which carries NO money fields at all.`, { id: "OrderLine" }); }

    const { op, args } = orderReadPlan(dd);
    // O14 — drive readPages (not readAll). O15 — merge resume.restart.
    const restart = resume?.restart && typeof resume.restart === "object" ? resume.restart : {};
    const iterator = client.readPages(op, {
      pageSize,
      args,
      ...(dd.pageBase !== undefined ? { pageBase: dd.pageBase } : {}),
      ...auditOpts,
      ...restart,
    });
    let walkMeta = null;
    const allRecords = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) { walkMeta = step.value ?? null; break; }
      for (const o of step.value.records || []) allRecords.push(o);
    }
    let audit = null;
    try {
      if (allRecords.length && client.auditAgainstFieldSet) {
        audit = client.auditAgainstFieldSet("Order", allRecords, { throwOnTruncation: false });
      }
    } catch (e) { log.debug(`dandomain: order audit skipped (${e.message})`); }
    const walk = {
      ...(walkMeta || {}),
      records: allRecords,
      audit,
      requests: walkMeta?.requests,
      complete: walkMeta?.complete ?? false,
      pageBase: walkMeta?.pageBase,
      pageBaseEvidence: walkMeta?.pageBaseEvidence,
    };
    reportAudit("orders", audit);
    reportWalk("orders", walk);
    if (walk.pageBaseEvidence && walk.pageBaseEvidence.verifiedAgainstThisShop === false) {
      warn("PAGE_BASE_UNVERIFIED",
        `Order paging used the RECORDED page base (${walk.pageBase}) rather than one proved against this shop. That base is confirmed on exactly one shop (R34). If it is wrong here, a walk silently skips an entire page and still reports a complete read. ${walk.records.length} order(s) were read in ${walk.requests} request(s) — reconcile that against the order count in the shop admin, or set source.dandomain.pageBase to "detect" and re-run.`,
        { entity: "order", id: "all" });
    }

    // ---- do the INLINED order lines actually carry money? ----
    // The one recorded order-line read (`vatserver.json`) came from a SEPARATE
    // `Order_GetLines` call made AFTER `Order_SetOrderLineFields`; the nested
    // `OrderLines` in the order read beside it holds the DEFAULT projection
    // `{Id, PacketLines, LineAddresses}` — no money at all — because the line
    // field set had not been asserted yet. So whether a nested read honours
    // that field set is UNRECORDED, and assuming it would silently import every
    // historical order with no prices and no error.
    //
    // Ask the data instead of assuming, then fall back. `Price` is the marker
    // because it is the field whose absence is the disaster.
    const inlineLines = walk.records.flatMap((o) => arr(o.OrderLines));
    const inlineHasMoney = inlineLines.some((l) => l && Object.prototype.hasOwnProperty.call(l, "Price"));
    const needsLineFetch = inlineLines.length > 0 && !inlineHasMoney;
    if (needsLineFetch) {
      warn("ORDER_LINES_REFETCHED",
        `The order read returned ${inlineLines.length} nested order line(s) with no Price field on any of them, i.e. the server's default line projection rather than the requested one. Lines are therefore re-read per order with Order_GetLines — correct, but one extra request per order, so a large order history will be slow. Nothing is lost; this note exists so the runtime is explained rather than mysterious.`,
        { entity: "order", id: "all", severity: "handled" });
    }
    const linesOf = async (o) => {
      if (!needsLineFetch) return arr(o.OrderLines);
      try { return arr((await client.call("Order_GetLines", { OrderId: Number(s(o.Id)) })).result); }
      catch (e) {
        warn("ORDER_LINES_UNREADABLE",
          `Order ${s(o.Id)}: its lines could not be read (${e.message}). The order is exported WITHOUT line items — check it in the shop admin before importing.`,
          { entity: "order", id: s(o.Id) });
        return [];
      }
    };

    // F38 — a credit note is an order whose `Origin` names its parent and whose
    // `Total` is negative. It is NOT identified by status 100: a freshly created
    // one carries status 99 (Kladde), so a status test silently skips every
    // unbooked credit note on a client shop.
    const creditNotes = new Map();
    for (const o of walk.records) {
      const origin = s(o.Origin);
      if (origin && origin !== "0") {
        if (!creditNotes.has(origin)) creditNotes.set(origin, []);
        creditNotes.get(origin).push(o);
      }
    }

    // PASS 1 — read every order's lines, then decide the money basis once.
    const eligible = [];
    for (const o of walk.records) {
      if (s(o.Origin) && s(o.Origin) !== "0") continue;
      eligible.push(o);
    }
    const pairs = needsLineFetch
      ? await mapBatches(eligible, REFETCH_CONCURRENCY, async (o) => ({ order: o, lines: await linesOf(o) }))
      : eligible.map((o) => ({ order: o, lines: arr(o.OrderLines) }));
    const basis = decideLineBasis(pairs);
    const mode = basis.basis;
    if (basis.disagreed.length) {
      warn("ORDER_LINE_PRICE_BASIS_CONFLICT",
        `Order(s) ${basis.disagreed.slice(0, 8).join(", ")} reconcile against the OPPOSITE line-price basis from the one this export used (${mode}). The shop is not internally consistent, or this adapter's model of Order.Total is wrong for it. Every amount on those orders is suspect — reconcile them against the shop admin before importing.`,
        { entity: "order", id: "all" });
    }

    const unresolvedVat = [];
    const ancillaryRateUnknown = [];
    const totalOracle = [];
    const quantityReshaped = [];
    let emitted = 0;
    for (const { order: o, lines } of pairs) {
      const id = s(o.Id);

      const statusId = s(o.Status);
      const wooStatus = statusMap[statusId] ?? null;
      if (wooStatus === null) {
        warn("ORDER_STATUS_UNMAPPED",
          `Order ${id} carries status id ${statusId}, which is not in the status map. It is exported as "pending" so nothing is lost, but its Shopify fulfilment state will be wrong. Add it to source.dandomain.statusMap — the shop's own list is readable with OrderStatusCode_GetAll.`,
          // Keyed by STATUS id, not by "all": a shop with three custom statuses
          // must hear about three, not about whichever one came first.
          { entity: "order", id: `status-${statusId}` });
      }
      const status = wooStatus ?? "pending";
      if (skipStatuses.has(status)) continue;

      // ---- money (R1/R2) ----
      const rates = new Map(); // vat group -> percentage
      let netLines = 0, taxTotal = 0;
      const lineItems = lines.map((l) => {
        // F30/R8 — a QUANTITY, not money. Shopify rejects a non-integer or a
        // non-positive quantity and fails the WHOLE order, and this platform
        // carries `OrderLine.Unit` (stk., kg, liter), so a fractional amount is
        // plausible on a weighed line — 2.5 kg of coffee is an ordinary order.
        //
        // ROUNDING THE QUANTITY CHANGES THE MONEY. 2.5 x 20 rounded to 3 x 20 is
        // 110 where the customer paid 100, and the order then trips
        // ORDER_TOTAL_MISMATCH blaming the shop for a discrepancy this adapter
        // created. So the LINE TOTAL is preserved exactly and the quantity is
        // collapsed to 1, with the original amount and unit recorded on the line
        // and reported. The money is right; the shape is lossy and declared.
        const rawQty = num(l.Amount);
        const wholeQty = rawQty !== null && Number.isInteger(rawQty) && rawQty >= 1 && rawQty <= 1e6;
        const qty = wholeQty ? rawQty : 1;
        // THE MULTIPLIER IS THE SOURCE AMOUNT, whatever its sign. Clamping a
        // negative or zero amount to 1 INVENTS money: a -1 x 20 return line
        // became +20, turning a 30 order into 75 and then tripping the total
        // check against the shop for a discrepancy this adapter created. The
        // export states what the source states; whether Shopify can accept it is
        // the import's problem, and the warning says so.
        const effectiveMultiplier = rawQty === null ? 1 : rawQty;
        if (rawQty !== null && !wholeQty) {
          quantityReshaped.push({ order: id, line: s(l.Id), from: rawQty, unit: txt(l.Unit), nonPositive: rawQty <= 0 });
        }
        const raw = num(l.Price) ?? 0;                          // NET (R1)
        // `mode === "unit"` means Price is PER UNIT, so the line total is
        // price x amount — using the FRACTIONAL amount, not the reshaped one.
        const net = mode === "unit" ? raw * effectiveMultiplier : raw;
        const disc = num(l.Discount) ?? 0;
        const netDiscount = mode === "unit" ? disc * effectiveMultiplier : disc;
        // R2 — the rate is NOT on the order. Both `Order.Vat` and
        // `OrderLine.VatRate` read 0 on every recorded order, including the
        // server-priced one. It comes from the product's VAT group.
        const key = s(l.ProductId);
        const v = vat.byId.get(key) || vat.bySku.get(s(l.ItemNumber)) || null;
        const pct = v?.pct ?? null;
        // The rate is DERIVED from the product's VAT group, so a line whose
        // product is gone — deleted years after the order, or an offline/manual
        // line (`OrderLine.OfflineProduct`) that never had one — has nothing to
        // derive from. Charging it 0 % understates the order by the VAT rate and
        // the run still reports success. That is D15's shape; say it out loud.
        if (pct === null) {
          unresolvedVat.push({ order: id, line: s(l.Id), productId: key, itemNumber: s(l.ItemNumber), offline: bool(l.OfflineProduct) });
        }
        if (v?.group) rates.set(s(v.group), pct);
        const lineTax = pct === null ? 0 : (net - netDiscount) * (pct / 100);
        netLines += net;
        taxTotal += lineTax;
        return {
          id: num(l.Id),
          name: txt(l.ProductTitle) + (s(l.VariantTitle) ? ` - ${txt(l.VariantTitle)}` : ""),
          product_id: num(l.ProductId),
          variation_id: num(l.VariantId) ?? 0,
          quantity: qty,
          sku: s(l.ItemNumber) || undefined,
          subtotal: money2(net),
          total: money2(net - netDiscount),
          taxes: pct === null ? [] : [{ id: Number(v.group) || 0, total: money2(lineTax) }],
          meta_data: [
            ...(s(l.PacketId) && s(l.PacketId) !== "0" ? [{ key: "_dd_packet_id", value: s(l.PacketId) }] : []),
              ...(s(l.Unit) ? [{ key: "_dd_unit", value: txt(l.Unit) }] : []),
            ...(rawQty !== null && !wholeQty ? [{ key: "_dd_source_amount", value: String(rawQty) }] : [])
          ]
        };
      });

      if (rates.size > 1) {
        warn("MIXED_VAT_ORDER",
          `Order ${id} spans ${rates.size} VAT groups. This platform does not carry a per-order VAT breakdown — Order.Vat and OrderLine.VatRate are always 0 (R2) — so the tax on each line was DERIVED from the product's VAT group. Reconcile this order against the shop's own invoice before trusting its tax figures in bookkeeping.`,
          { entity: "order", id });
      }

      const delivery = o.Delivery || {};
      const payment = o.Payment || {};
      const shippingNet = num(delivery.Price) ?? 0;
      const feeNet = num(payment.Price) ?? 0;
      // `OrderDelivery.Vat` and `OrderPayment.Vat` are xsd:BOOLEAN — they say
      // WHETHER VAT applies, never how much. R2 is that the rate is nowhere in
      // the order, so the rate used here is the one the order's own lines carry
      // (the highest, where they span groups: under-charging shipping VAT is the
      // costlier of the two errors). Dropping the flag — which is what this did
      // until an adversarial review — understates every order that has a shipping
      // charge by the VAT on it: 17.50 DKK on a 70 DKK delivery in a 25 % shop,
      // on every order in the history, with Shopify's own totals agreeing.
      // A rate of 0 is KNOWN to be zero; only `null` is unknown. Filtering on
      // `> 0` conflates them and raises an action-severity "the totals are
      // understated" on every order of a VAT-exempt shop, where the totals are
      // exactly right.
      const lineRates = [...rates.values()].filter((r) => r !== null);
      const ancillaryRate = lineRates.length ? Math.max(...lineRates) : null;
      let ancillaryGroupId = 0;
      for (const [group, pct] of rates) {
        if (pct === ancillaryRate) { ancillaryGroupId = Number(group) || 0; break; }
      }
      const ancillaryVat = (netAmount, applies) => {
        if (!netAmount || !applies) return 0;
        if (ancillaryRate === null) { ancillaryRateUnknown.push(id); return 0; }
        return netAmount * (ancillaryRate / 100);
      };
      const shippingVat = ancillaryVat(shippingNet, bool(delivery.Vat));
      const feeVat = ancillaryVat(feeNet, bool(payment.Vat));

      // F19 — read the currency from the NESTED object. `Order.CurrencyId` is
      // NOT the Currency_GetAll id: it increments per order, pointing at a
      // per-order snapshot row.
      const currency = s(o.Currency?.Iso) || s(ctx.currency?.Iso) || "";

      const paidTx = arr(o.Transactions).filter((t) => s(t.Status) === "1");
      // F30 — `OrderTransaction.Amount` is in ØRE. `AmountFull` is the major-unit
      // form, so prefer it and divide only when falling back to `Amount`.
      // `??` does NOT fall through on 0, so a server sending AmountFull 0 for an
      // unpopulated field would kill F30's øre fallback AND silently disable the
      // capture oracle below. Prefer AmountFull only when it is a real amount.
      const txAmount = (t) => {
        const full = num(t.AmountFull);
        if (full !== null && full !== 0) return full;
        const ore = num(t.Amount);
        return ore === null ? (full ?? null) : ore / 100;
      };
      const paidAt = paidTx.map((t) => ddDate(t.Date)).filter(Boolean).sort()[0] || null;

      const grossLines = lineItems.reduce((t, li) => t + Number(li.total), 0) + taxTotal;
      const grossTotal = grossLines + shippingNet + shippingVat + feeNet + feeVat;

      // The falsifier. If `Order.Total` is not the sum of the net lines, this
      // adapter's model of the order money is wrong ON THIS SHOP, and every
      // amount it derives is suspect. Better a loud mismatch than a quiet one.
      // Whether `Order.Total` is PRE- or POST-discount is unrecorded: every probe
      // order had Discount 0, where the two are the same number. So EITHER is
      // accepted, and only a mismatch against BOTH indicates a broken money
      // model. Firing on every discounted order would train the operator to
      // ignore the one check that matters.
      const declared = num(o.Total);
      const preDiscount = lineItems.reduce((t, li) => t + Number(li.subtotal), 0);
      const postDiscount = lineItems.reduce((t, li) => t + Number(li.total), 0);
      const tol = 0.01 * Math.max(1, lineItems.length);
      if (declared !== null && Math.abs(declared - preDiscount) > tol && Math.abs(declared - postDiscount) > tol) {
        warn("ORDER_TOTAL_MISMATCH",
          `Order ${id}: the source reports Total ${declared}, but its own lines sum to ${preDiscount.toFixed(2)} before discounts and ${postDiscount.toFixed(2)} after (both NET, R1) — neither matches. This adapter builds the Shopify total from the lines plus shipping and fees, so the imported order will read ${grossTotal.toFixed(2)} gross. Either this shop puts something else in Total, or a line was not read. Reconcile before go-live.`,
          { entity: "order", id });
      }

      // THE ORACLE. `OrderTransaction.AmountFull` is what was actually captured
      // from the customer — an independent statement of the gross total, from a
      // different corner of the API than the lines. When it disagrees with what
      // this adapter rebuilt, the money model is wrong FOR THIS SHOP and every
      // derived figure is suspect. This is the check that would have caught the
      // dropped shipping VAT above without costing an adversarial reviewer.
      const captured = paidTx.map(txAmount).filter((x) => x !== null && x > 0);
      if (captured.length) {
        const paidTotal = captured.reduce((t, x) => t + x, 0);
        if (Math.abs(paidTotal - grossTotal) > 0.02) {
          totalOracle.push({ order: id, captured: Number(paidTotal.toFixed(2)), rebuilt: Number(grossTotal.toFixed(2)) });
        }
      }

      // F38 — fold the credit notes.
      const notes = creditNotes.get(id) || [];
      const refunds = notes.map((n) => ({ id: num(n.Id), total: money2(num(n.Total) ?? 0), reason: txt(n.OrderComment) || undefined }));
      if (notes.length) {
        const draft = notes.filter((n) => s(n.Status) === "99").length;
        warn("REFUND_PARTIAL",
          `Order ${id} has ${notes.length} credit note(s) (order id ${notes.map((n) => s(n.Id)).join(", ")}) worth ${notes.reduce((t, n) => t + Math.abs(num(n.Total) ?? 0), 0).toFixed(2)} ${currency}${draft ? `, ${draft} of them still unbooked (Kladde)` : ""}. Shopify refunds cannot be backdated, so the order imports at full value with the credit recorded in its note — the money trail stays honest, the refund object is not recreated.`,
          { entity: "order", id, severity: "info" });
      }

      const cust = o.Customer || {};
      const custCountry = countryIso(cust.CountryCode, ctx);
      const shipCountry = countryIso(cust.ShippingCountryCode, ctx) || custCountry;

      emitted++;
      yield {
        id: num(o.Id),
        // F32 was CIRCULAR (the probe passed the id in as the number), and
        // `InvoiceNumber` never came back in any recorded read. So the order
        // number is the id unless the shop returns an invoice number, and
        // `ReferenceNumber` is data only: F38 proved a credit note INHERITS it,
        // so it is not unique across documents and can never be a ledger key.
        number: s(o.InvoiceNumber) || id,
        status,
        currency,
        date_created_gmt: ddDate(o.DateDelivered) || ddDate(o.DateUpdated),
        date_paid_gmt: paidAt,
        total: money2(grossTotal),
        total_tax: money2(taxTotal + shippingVat + feeVat),
        shipping_total: money2(shippingNet),
        discount_total: money2(lineItems.reduce((t, li) => t + (Number(li.subtotal) - Number(li.total)), 0)),
        payment_method: s(payment.PaymentMethodId),
        payment_method_title: txt(payment.Title),
        customer_id: num(o.UserId) ?? 0,
        customer_note: txt(o.CustomerComment),
        billing: {
          first_name: txt(cust.Firstname), last_name: txt(cust.Lastname), company: txt(cust.Company),
          address_1: txt(cust.Address), address_2: txt(cust.Address2), city: txt(cust.City),
          postcode: s(cust.Zip), state: s(cust.State), country: custCountry,
          email: s(cust.Email), phone: s(cust.Phone) || s(cust.Mobile)
        },
        shipping: s(cust.ShippingAddress) || s(cust.ShippingCity) ? {
          first_name: txt(cust.ShippingFirstname) || txt(cust.Firstname),
          last_name: txt(cust.ShippingLastname) || txt(cust.Lastname),
          company: txt(cust.ShippingCompany), address_1: txt(cust.ShippingAddress),
          address_2: txt(cust.ShippingAddress2), city: txt(cust.ShippingCity),
          postcode: s(cust.ShippingZip), state: s(cust.ShippingState), country: shipCountry
        } : {},
        line_items: lineItems,
        // O13 / Shopify orderCreate: shippingLines.priceSet is NET; taxLines are
        // additional VAT. The GROSS the customer paid is net+tax (and still
        // `order.total`). Folding VAT into `total` and omitting taxes[] made
        // transform send a gross priceSet with no taxLines — the order total
        // was right and the tax breakdown was understated. Woo-shaped: total
        // is NET, taxes[] carry the derived VAT (never Order.Vat — R2).
        shipping_lines: shippingNet || s(delivery.Title)
          ? [{
            id: num(delivery.Id) ?? 0,
            method_title: txt(delivery.Title) || "Levering",
            total: money2(shippingNet),
            total_tax: money2(shippingVat),
            taxes: shippingVat ? [{ id: ancillaryGroupId, total: money2(shippingVat) }] : []
          }]
          : [],
        fee_lines: feeNet ? [{
          id: num(payment.Id) ?? 0,
          name: txt(payment.Title) || "Gebyr",
          total: money2(feeNet),
          total_tax: money2(feeVat),
          taxes: feeVat ? [{ id: ancillaryGroupId, total: money2(feeVat) }] : []
        }] : [],
        tax_lines: [...rates.entries()].map(([group, pct]) => ({
          rate_id: Number(group) || 0,
          label: txt(ctx.vatGroups.find((g) => s(g.Id) === group)?.Name) || "Moms",
          rate_percent: pct ?? 0
        })),
        coupon_lines: arr(o.DiscountCodes).map((d) => ({ code: txt(d.Title) || s(d.DiscountId) })),
        refunds,
        meta_data: [
          { key: "_dd_id", value: id },
          ...(s(o.ReferenceNumber) ? [{ key: "_dd_reference_number", value: s(o.ReferenceNumber) }] : []),
          ...(s(o.Status) ? [{ key: "_dd_status_id", value: s(o.Status) }] : []),
          ...(s(o.TrackingCode) ? [{ key: "_dd_tracking_code", value: s(o.TrackingCode) }] : []),
          ...(s(o.LanguageISO) ? [{ key: "_dd_language", value: s(o.LanguageISO) }] : []),
          ...(bool(cust.B2B) ? [{ key: "_dd_b2b", value: "1" }] : []),
          ...(s(cust.Cvr) ? [{ key: "_dd_cvr", value: s(cust.Cvr) }] : []),
          ...(s(cust.Ean) ? [{ key: "_dd_ean", value: s(cust.Ean) }] : []),
          ...(paidTx.length ? [{ key: "_dd_transaction_amount", value: String(txAmount(paidTx[0]) ?? "") }] : [])
        ]
      };
    }

    if (unresolvedVat.length) {
      const offline = unresolvedVat.filter((u) => u.offline).length;
      warn("ORDER_LINE_VAT_UNRESOLVED",
        `${unresolvedVat.length} order line(s) across ${new Set(unresolvedVat.map((u) => u.order)).size} order(s) reference a product that is not in the catalogue (${unresolvedVat.slice(0, 5).map((u) => `order ${u.order} -> product ${u.productId || u.itemNumber || "?"}`).join(", ")}${offline ? `; ${offline} of them are OfflineProduct lines, which never had one` : ""}). The VAT rate on this platform comes from the PRODUCT (R2), so those lines carry NO TAX and their orders are understated by the VAT rate. Historical orders normally do reference deleted products — decide a default rate for them, or accept the understatement knowingly.`,
        { entity: "order", id: "all" });
    }
    if (ancillaryRateUnknown.length) {
      warn("SHIPPING_VAT_UNRESOLVED",
        `${new Set(ancillaryRateUnknown).size} order(s) charge shipping or a payment fee that the source flags as VAT-bearing, but none of their lines carries a VAT rate to derive it from. The shipping/fee VAT is 0 on those orders and the totals are understated. Orders affected (first few): ${[...new Set(ancillaryRateUnknown)].slice(0, 8).join(", ")}.`,
        { entity: "order", id: "all" });
    }
    if (quantityReshaped.length) {
      const np = quantityReshaped.filter((q) => q.nonPositive);
      warn("ORDER_QUANTITY_RESHAPED",
        `${quantityReshaped.length} order line(s) carry a quantity Shopify cannot accept as-is — non-integer, zero or negative (${quantityReshaped.slice(0, 4).map((q) => `order ${q.order}: ${q.from}${q.unit ? " " + q.unit : ""}`).join(", ")}). Each is exported as quantity 1 carrying the line's REAL total — price x the source amount, sign included — so the money matches the source exactly and only the unit count is lossy. The source amount rides on the line as _dd_source_amount.${np.length ? ` ${np.length} of them are ZERO OR NEGATIVE (order(s) ${[...new Set(np.map((q) => q.order))].slice(0, 5).join(", ")}): a negative line is a return the source folded into the order, and Shopify's orderCreate REJECTS a negative line price — those orders will fail at import until someone decides how to represent them. That is a real decision, not a rounding question.` : ""}`,
        { entity: "order", id: "all" });
    }
    if (totalOracle.length) {
      warn("ORDER_TOTAL_VS_CAPTURED",
        `${totalOracle.length} order(s) were rebuilt to a gross total that disagrees with what the payment transaction says was actually CAPTURED from the customer (${totalOracle.slice(0, 4).map((t) => `order ${t.order}: captured ${t.captured}, rebuilt ${t.rebuilt}`).join(", ")}). The transaction is an independent statement of the truth, from a different part of the API than the lines, so a disagreement means this adapter's money model is wrong FOR THIS SHOP — not that one order is odd. Reconcile before importing any of them.`,
        { entity: "order", id: "all" });
    }

    if (!emitted) return;
    if (basis.source === "config") {
      warn("ORDER_LINE_PRICE_BASIS",
        `OrderLine.Price was read as a ${basis.basis === "unit" ? "UNIT price" : "LINE total"} because source.dandomain.lineBasis says so. Nothing in the export was allowed to overrule that.`,
        { entity: "order", id: "all", severity: "info" });
    } else if (basis.source === "decided") {
      warn("ORDER_LINE_PRICE_BASIS",
        `OrderLine.Price on this shop is a ${basis.basis === "unit" ? "UNIT price" : "LINE total"}, decided by order ${basis.evidence?.orderId}: its own Total (${basis.evidence?.total}) matches the ${basis.basis} reading (${basis.basis === "unit" ? basis.evidence?.asUnit : basis.evidence?.asLine}) and not the other (${basis.basis === "unit" ? basis.evidence?.asLine : basis.evidence?.asUnit}). ${basis.undecidable} order(s) could not have decided it either way. The whole batch was read before any order was emitted, so this verdict applies to all of them.`,
        { entity: "order", id: "all", severity: "info" });
    } else {
      warn("ORDER_LINE_PRICE_BASIS_UNPROVEN",
        `No exported order could settle whether OrderLine.Price is a UNIT price or a LINE total: every order either had only single-quantity lines or did not reconcile against its own Total. The unit reading was used, which is the common convention but is NOT recorded fact on this platform — every probe order used quantity 1, where both readings predict the same number. Spot-check one multi-quantity order against the shop admin before go-live; if the line totals come out multiplied, set source.dandomain.lineBasis to "line" and re-export.`,
        { entity: "order", id: "all" });
    }
  }

  /**
   * Which paged order operation to call, and the R35 rule that governs it.
   *
   * `Order_GetAllWithPagination` declares only `Page`/`PageSize` — no `Status`
   * — so R35 does not apply to it. The DATE-WINDOWED variants declare a
   * `nillable` `Status`, and R35 is that `nillable` describes the VALUE, not the
   * presence: PHP counts POSITIONS, so omitting it is
   * `Too few arguments … exactly 5 expected` on 3 of 3 operations. It is
   * per-operation and NOT derivable from the WSDL — omitting the same argument
   * on `Order_GetByDate` works fine (R16). Hence: send it, explicitly, always.
   * `""` is the value R16 recorded as returning every status.
   */
  function orderReadPlan(conf) {
    const from = conf.ordersAfter, to = conf.ordersBefore;
    if (!from && !to) return { op: "Order_GetAllWithPagination", args: {} };
    return {
      op: "Order_GetByDateWithPagination",
      args: {
        Start: from || "1970-01-01 00:00:00",
        End: to || "2999-12-31 23:59:59",
        Status: conf.orderStatusFilter ?? ""   // R35 — explicit, never omitted
      }
    };
  }

  // ------------------------------------------------------------------------------------------
  // coupons
  // ------------------------------------------------------------------------------------------
  async function* coupons() {
    await connect();
    const rows = arr((await client.call("Discount_GetAll")).result);
    for (const d of rows) {
      const id = s(d.Id);
      const type = s(d.Type).toLowerCase();
      // The vocabulary is not documented and this shop has ZERO discounts, so
      // every branch below is a mapping of a shape the WSDL implies, not a
      // recorded behaviour. R37 makes the unknown case likelier than it looks:
      // `DiscountType` on this platform is an unvalidated ONE-CHARACTER column
      // that stores whatever initial you send, so "%", "a" and "z" are all live
      // possibilities on a real shop.
      // `Object.create(null)`, not a literal: `KNOWN["constructor"]` on a plain
      // object returns the Object function, which is truthy, so the guard below
      // would treat it as recognised and the coupon would export with no type.
      // Words only. R37 recorded that this platform stores a one-character
      // column with `sentOrder: null` — `"a"`/`"p"`/`"%"`/`"1"`/`"2"` cannot be
      // decoded from the API, and treating them as recognised Woo types made
      // COUPON_TYPE_UNKNOWN a dead warning. A 10 % code stored as `"a"` would
      // import as 10 kr off with no punch list.
      const KNOWN = Object.assign(Object.create(null), {
        percent: "percent",
        ship: "free_shipping", shipping: "free_shipping",
        product: "fixed_product", amount: "fixed_cart", kr: "fixed_cart" });
      const recognised = KNOWN[type] ?? (type.includes("percent") ? "percent"
        : type.includes("ship") ? "free_shipping"
          : type.includes("product") ? "fixed_product"
            : type.includes("amount") ? "fixed_cart" : null);
      // Unknown Type is NOT a Shopify money-off type. R37 recorded sentOrder:null
      // — letters cannot be decoded from the API. Mapping them as fixed_cart
      // would let transform apply kr-off. The Woo record still exists so the
      // punch list can name the code; discount_type is "unknown" so P3 cannot
      // treat it as percent/fixed_cart/fixed_product/free_shipping.
      const discountType = recognised ?? "unknown";
      // The guard tests the SOURCE value, not the mapped one. Testing a mapped
      // Woo name could never fail on the unknown path.
      if (recognised === null) {
        warn("COUPON_TYPE_UNKNOWN",
          `Discount ${id} "${txt(d.Title)}" has type ${JSON.stringify(s(d.Type))}, which this adapter does not recognise. It is exported with discount_type "unknown" and amount ${num(d.Value) ?? 0} — not as a Shopify money-off type. If it is really a percentage, do not enable a guessed mapping. (R37: this field is a one-character column with no server-side validation, so its value cannot be decoded from the API.)`,
          { entity: "coupon", id });
      }
      // `Discount.IsActive` is a WSDL field and nothing downstream reads it, so
      // a code the merchant switched off two years ago would go live on the new
      // store on day one. Same for a code whose StartDate is in the future.
      const startsAt = ddDate(d.StartDate) || ddDate(d.DateCreated);
      const startsMs = utcMs(startsAt);
      const future = startsMs !== null && startsMs > now.getTime();
      // An UNSET boolean arrives from this server as an EMPTY ELEMENT, which
      // parses to "" — not `undefined`. Testing `!== undefined` therefore reads
      // "the shop did not say" as "the shop said false", flags every discount
      // inactive, and with skipInactiveCoupons exports NONE of them. The shipped
      // fixtures show the platform doing exactly this (`<Limit></Limit>`,
      // `<SeoLink/>`). Only an explicit false counts as off.
      const activeStated = s(d.IsActive) !== "";
      if (activeStated && !bool(d.IsActive)) {
        warn("COUPON_INACTIVE",
          `Discount ${id} "${txt(d.Title)}" is switched OFF on the source (IsActive false) but Shopify has no imported-and-disabled state in this pipeline, so it arrives ACTIVE. Delete or disable it in Shopify, or set source.dandomain.skipInactiveCoupons.`,
          { entity: "coupon", id });
      }
      if (future) {
        warn("COUPON_NOT_STARTED",
          `Discount ${id} "${txt(d.Title)}" starts at ${startsAt} on the source — in the future. It imports with that start date, so check Shopify honours it rather than activating the code immediately.`,
          { entity: "coupon", id, severity: "handled" });
      }
      if (dd.skipInactiveCoupons && activeStated && !bool(d.IsActive)) continue;
      if (d.FreeGift && s(d.FreeGift.ProductId)) {
        warn("FREE_GIFT_DISCOUNT",
          `Discount ${id} "${txt(d.Title)}" gives a FREE GIFT (product ${s(d.FreeGift.ProductId)}). Shopify's native discounts cannot add a product to the cart, so this one does not migrate as-is — rebuild it as a Buy X Get Y discount or with an app.`,
          { entity: "coupon", id });
      }
      const groups = arr(d.DiscountCustomerGroupAssociation?.CustomerGroupIds).map((g) => s(g?.Id ?? g)).filter(Boolean);
      if (groups.length) {
        warn("SCOPED_COUPON_GROUP",
          `Discount ${id} "${txt(d.Title)}" is restricted to customer group(s) ${groups.join(", ")}. Shopify code discounts scope to customer SEGMENTS, which this pipeline does not create — the code imports unrestricted. Re-apply the restriction in Shopify admin, or leave it disabled.`,
          { entity: "coupon", id });
      }
      if (num(d.UseCount) !== null && num(d.UseCount) > 0) {
        warn("USES_REMAINING_IMPORTED",
          `Discount ${id} "${txt(d.Title)}" has already been used ${s(d.UseCount)} time(s). Shopify has no "already used" counter to import, so the code arrives with its full limit available. Reduce its usage limit by ${s(d.UseCount)} if the cap matters.`,
          { entity: "coupon", id, severity: "handled" });
      }

      const categories = arr(d.DiscountedProductCategories?.CategoryIds).map((c) => Number(s(c?.Id ?? c))).filter(Boolean);
      yield {
        id: num(d.Id),
        code: txt(d.Code) || txt(d.Title),
        amount: s(num(d.Value) ?? 0),
        discount_type: discountType,
        description: txt(d.Title),
        // `StartDate` is the platform's ACTIVATION date and the transform turns
        // this key into Shopify's `startsAt`, so it leads — `DateCreated` is the
        // fallback, not the other way round.
        date_created_gmt: startsAt,
        date_expires: ddDate(d.DateExpire),
        usage_limit: s(d.Limit) && num(d.Limit) !== null ? num(d.Limit) : null,
        usage_limit_per_user: bool(d.IsSingleUsePerCustomer) ? 1 : null,
        minimum_amount: money2(num(d.MinimumCartValue) ?? 0),
        product_ids: arr(d.ProductIds).map((x) => Number(s(x?.Id ?? x))).filter(Boolean),
        product_categories: categories,
        meta_data: [
          { key: "_dd_id", value: id },
          ...(bool(d.IsRestrictedToNewCustomer) ? [{ key: "_dd_new_customers_only", value: "1" }] : []),
          ...(groups.length ? [{ key: "_dd_customer_groups", value: groups.join(",") }] : []),
          ...(num(d.UseCount) !== null ? [{ key: "_dd_use_count", value: s(d.UseCount) }] : []),
          ...(activeStated ? [{ key: "_dd_is_active", value: bool(d.IsActive) ? "1" : "0" }] : []),
          ...(ddDate(d.StartDate) ? [{ key: "_dd_start_date", value: ddDate(d.StartDate) }] : [])
        ]
      };
    }
  }

  // ------------------------------------------------------------------------------------------
  // pages  (R15 — there is no PageText_GetAll; a folder-id sweep IS the path)
  // ------------------------------------------------------------------------------------------
  async function pageFolderIds() {
    if (Array.isArray(dd.pageFolderIds) && dd.pageFolderIds.length) {
      return { ids: dd.pageFolderIds.map(Number), source: "config" };
    }
    /**
     * R36 — GraphQL `folders` states the folder ids exactly, which is what R15
     * said the SOAP sweep can never do. Two things it does NOT do:
     *
     * 1. It does not list folder **0**, and folder 0 HELD A PAGE in the recorded
     *    SOAP sweep (`gaps.json.sections.pages.byFolder`: folder 0, count 1).
     *    The likeliest reading is that 0 means "no folder" and only the SOAP
     *    side calls it a folder id. Driving the sweep from the GraphQL list
     *    ALONE would therefore drop that page silently, so 0 is always added.
     * 2. `Folder` has no `name`/`title` field — `__type(name:"Folder")` lists
     *    `id · sorting · languageLayerAccess · menuDisplaySettings · isLeaf ·
     *    translations` — so `id` is the whole selection. Asking for a name
     *    faults the query (R4's rule, on the other transport).
     */
    try {
      const res = await client.graphql().query("folders", { endpoint: "experimental", selection: "id" });
      const ids = arr(res?.rows).map((r) => Number(r?.id)).filter((n) => Number.isFinite(n));
      if (ids.length) return { ids: [...new Set([0, ...ids])].sort((a, b) => a - b), source: "graphql" };
    } catch (e) { log.debug(`dandomain: GraphQL folders unavailable (${e.message}) — sweeping folder ids instead`); }
    const max = Number.isInteger(dd.pageFolderMax) ? dd.pageFolderMax : 20;
    return { ids: Array.from({ length: max + 1 }, (_, i) => i), source: "sweep" };
  }

  async function* pages() {
    await connect();
    await negotiateFieldSet("PageText", PAGE_FIELDS);
    const { ids, source } = await pageFolderIds();
    if (source === "sweep") {
      warn("PAGE_FOLDER_SWEEP",
        `CMS pages were enumerated by sweeping folder ids 0-${ids[ids.length - 1]}, because this platform has no PageText_GetAll (R15) and GraphQL folders was not available. A page in a folder above ${ids[ids.length - 1]} is NOT exported and nothing would report it missing. Configure source.dandomain.pageFolderIds, or enable GraphQL so the folder list can be read exactly.`,
        { entity: "page", id: "all" });
    }

    const emittedIds = new Set();
    const collected = [];
    for (const folderId of ids) {
      let rows;
      try { rows = arr((await client.call("PageText_GetByFolder", { FolderId: Number(folderId) })).result); }
      catch (e) { log.debug(`dandomain: folder ${folderId} unreadable (${e.message})`); continue; }
      for (const pg of rows) {
        const id = s(pg.Id);
        if (!id || emittedIds.has(id)) continue;
        emittedIds.add(id);
        collected.push(pg);
      }
    }
    let audit = null;
    try { audit = client.auditAgainstFieldSet("PageText", collected, { throwOnTruncation: false }); }
    catch (e) { log.debug(`dandomain: page audit skipped (${e.message})`); }
    reportAudit("pages", audit);

    for (const pg of collected) {
      const body = [txt(pg.Text), txt(pg.Text2), txt(pg.Text3)].filter(Boolean).join("\n");
      yield {
        id: num(pg.Id),
        slug: s(pg.Link) || null,
        // Same as products: composing a URL is P3's job, after it has verified
        // the grammar against THIS shop (R39/R41). A guess 404s at scale.
        link: null,
        status: num(pg.Visible) === 0 ? "draft" : "publish",
        date_gmt: ddDate(pg.UpdatedDate),
        title: { rendered: txt(pg.Title) || txt(pg.Headline) },
        content: { rendered: body },
        yoast_head_json: (s(pg.SeoTitle) || s(pg.SeoDescription))
          ? { title: txt(pg.SeoTitle) || undefined, description: txt(pg.SeoDescription) || undefined }
          : undefined,
        meta_data: [
          { key: "_dd_id", value: s(pg.Id) },
          ...(s(pg.Link) ? [{ key: "_dd_link", value: s(pg.Link) }] : []),
          ...(s(pg.ParentId) ? [{ key: "_dd_parent_id", value: s(pg.ParentId) }] : [])
        ]
      };
    }
  }

  // ------------------------------------------------------------------------------------------
  // settings + the blog decision
  // ------------------------------------------------------------------------------------------
  async function settings() {
    const ctx = await shopContext();

    // D5 — SOAP Blog_* is NOT-IN-WSDL. HasModule still records whether the
    // shop has blog/news. posts() retracts BLOG_NOT_EXPORTED after a successful
    // GraphQL blogPosts read (including empty). A GraphQL fault keeps the warning.
    // `Solution_HasModule` is authoritative for the module NAMES it accepts
    // (F22: an invalid name faults with MODULE, a valid one answers true/false).
    // The argument is `module`, lower-case, straight out of the WSDL: R17/R27
    // is that an unrecognised ARGUMENT name is silently DROPPED.
    const modules = {};
    for (const name of ["blog", "news"]) {
      try { modules[name] = bool((await client.call("Solution_HasModule", { module: name })).result); }
      catch (e) {
        modules[name] = null;
        log.debug(`dandomain: HasModule(${name}) failed (${e.message})`);
        warn("HAS_MODULE_FAILED",
          `Solution_HasModule(${name}) failed (${e.message}). That is not evidence the module is off — a transport or arity failure here used to skip BLOG_NOT_EXPORTED entirely, so a shop with blog/news could export with no operator signal (D5). Re-run the probe, or treat those URLs as staying on the old site.`,
          { entity: "articles", id: name });
      }
    }
    if (modules.blog || modules.news) {
      warn("BLOG_NOT_EXPORTED",
        `This shop has the ${[modules.blog && "blog", modules.news && "news"].filter(Boolean).join(" and ")} module enabled, and blog/news content is NOT exported in v1 (D5). There is no SOAP surface for it — the posts live behind the GraphQL experimental schema — so articles, their images and their URLs stay behind. Decide before go-live: rebuild them by hand, or keep the old site serving those URLs.`,
        { entity: "articles", id: "all" });
    }

    return {
      currency: s(ctx.currency?.Iso) || undefined,
      country: s(ctx.webinfo.Country) || undefined,
      // The WSDL carries `Weight` as a bare double with no unit anywhere in the
      // shop settings, so the unit is NOT readable. Left undefined so the
      // config default applies rather than asserting a unit nobody stated.
      weightUnit: dd.weightUnit || undefined,
      // Extra keys the transform ignores and the summary keeps, so a later
      // stage (doctor, verify, the money transform) can read what the shop said
      // about itself instead of asking a human (F21).
      vatBasis: ctx.vatInclusive ? "INCLUSIVE" : "EXCLUSIVE",
      vatBasisSource: "Solution_GetWebinfo.ProductPricesWithVat",
      vatGroups: ctx.vatGroups.map((g) => ({ id: s(g.Id), name: txt(g.Name), percentage: num(g.VatPercentage) })),
      languages: ctx.languages.map((l) => ({ iso: s(l.LanguageISO), title: txt(l.Title), primary: bool(l.Primary), siteId: s(l.SiteId) })),
      customerGroups: ctx.groups.map((g) => ({ id: s(g.Id), title: txt(g.Title), producer: bool(g.Producer) })),
      solutionId: s(ctx.webinfo.SolutionId) || undefined,
      modules,
      mediaBase: mediaBase || null,
      storefrontOrigin: origin || null,
      provenance: { ...PROVENANCE },
      redirects: { structural: [], wooCategoryBase: false, wooStructural: false },
      // R21 — a DanDomain export is NOT read-only against the source. Fetching
      // storefront pages makes the shop generate its thumbnail cache into the
      // FTP-visible archive (33 files during a read-only probe run). Benign and
      // self-regenerating, so nothing is cleaned up — but a client must be told
      // rather than discover it.
      sourceSideEffects: "Storefront fetches (URL-grammar discovery, media-base verification) make the shop generate its own thumbnail/placeholder cache into the file archive. Benign, self-regenerating, and never deleted by this tool — but a DanDomain export cannot be described as read-only against the source."
    };
  }

  async function* redirects() {
    await connect();
    let rows;
    try { rows = arr((await client.call("SEORedirect_GetAll")).result); }
    catch (e) {
      warn("SEO_REDIRECTS_UNREAD",
        `SEORedirect_GetAll failed (${e.message}). Manual SEO redirects are not in the map. F8 recorded an empty table after a rename on the probe shop — that is not evidence this shop has none.`,
        { entity: "redirect", id: "all" });
      return;
    }
    for (const r of rows) {
      const from = s(r.Source);
      const to = s(r.Target);
      if (!from || !to) continue;
      yield { id: num(r.Id), from, to, type: s(r.Type), language: s(r.LanguageIso) };
    }
  }

  const I18N_PRODUCT_FIELDS = [
    "Id", "LanguageISO", "Title", "Description", "DescriptionShort", "DescriptionLong",
    "SeoTitle", "SeoDescription", "SeoLink",
  ];

  /** Secondary language layers for transform → translations.jsonl (PLAN §11, flag-gated). */
  async function* translationLayers() {
    if (!dd.multiLanguage && !cfg.options?.importTranslations) return;
    const ctx = await shopContext();
    const primaryIso = s(ctx.primary?.LanguageISO);
    for (const lang of ctx.languages) {
      if (bool(lang.Primary)) continue;
      const iso = s(lang.LanguageISO);
      if (!iso) continue;
      await client.call("Solution_SetLanguage", { LanguageISO: iso });
      try { await negotiateFieldSet("Product", I18N_PRODUCT_FIELDS); }
      catch (e) {
        warn("I18N_FIELD_SET_REJECTED",
          `Product field set for language ${iso} could not be negotiated (${e.message}) — secondary-layer strings for this language are skipped.`,
          { entity: "product", id: iso });
        continue;
      }
      for await (const step of client.readPages("Product_GetAllWithLimit", { pageSize, ...auditOpts })) {
        for (const p of step.records || []) {
          yield {
            productId: s(p.Id),
            languageISO: iso,
            fields: {
              title: txt(p.Title) || undefined,
              bodyHtml: txt(p.DescriptionLong) || txt(p.Description) || undefined,
              seoTitle: txt(p.SeoTitle) || undefined,
              seoDescription: txt(p.SeoDescription) || undefined,
            },
          };
        }
      }
    }
    if (primaryIso) {
      try { await client.call("Solution_SetLanguage", { LanguageISO: primaryIso }); }
      catch (e) { log.debug(`dandomain: restore primary language failed (${e.message})`); }
    }
  }

  // Recorded nested path: BlogPost.translations is [BlogPostTranslation!]! with
  // `data: BlogPostTranslationData` and `language: DisplayLanguage`. Content
  // lives on `data` (title/text/textList/seo*), not on the translation object.
  function firstTranslation(row) {
    const t = row?.translations;
    const layers = Array.isArray(t)
      ? t.filter((x) => x && typeof x === "object")
      : (t && typeof t === "object" ? [t] : []);
    return layers.find((x) => bool(x.language?.primary)) || layers[0] || {};
  }

  function translationData(layer) {
    const d = layer?.data;
    return d && typeof d === "object" ? d : {};
  }

  async function* posts() {
    await connect();
    let rows = [];
    try {
      const gql = client.graphql?.();
      if (!gql?.query) {
        warn("BLOG_NOT_EXPORTED",
          "blogPosts GraphQL read failed (GraphQL client missing). Articles are not exported.",
          { entity: "articles", id: "all" });
        return;
      }
      const res = await gql.query("blogPosts", {
        endpoint: "experimental",
        selection: BLOG_POST_SELECTION,
      });
      rows = arr(res?.rows ?? res?.content?.data ?? res?.data);
    } catch (e) {
      warn("BLOG_NOT_EXPORTED",
        `blogPosts GraphQL read failed (${e.message}). Articles are not exported.`,
        { entity: "articles", id: "all" });
      return;
    }
    retractWarn("BLOG_NOT_EXPORTED");
    if (!rows.length) return;
    for (const row of rows) {
      const payload = translationData(firstTranslation(row));
      const title = BLOG_POST_TRANSLATION_DATA_FIELDS.includes("title") ? txt(payload.title) : "";
      const body = BLOG_POST_TRANSLATION_DATA_FIELDS.includes("text") ? txt(payload.text || "") : "";
      const excerpt = BLOG_POST_TRANSLATION_DATA_FIELDS.includes("textList") ? txt(payload.textList || "") : "";
      yield {
        id: num(row.id) ?? 0,
        slug: null,
        status: "publish",
        date_gmt: ddDate(row.createdAt) || s(row.createdAt || "").replace(/Z$/, "") || null,
        title: { rendered: title },
        content: { rendered: body },
        excerpt: { rendered: excerpt },
        link: null,
      };
    }
  }

  return {
    name: "dandomain",
    provenance: { ...PROVENANCE },
    products,
    categories,
    customers,
    orders,
    coupons,
    pages,
    redirects,
    settings,
    translationLayers,
    posts,
    warnings: () => [...warnings, ...rollUps()]
    // no reviews() — PLAN §11 + R19, counted inside products() and dropped.
  };
}
