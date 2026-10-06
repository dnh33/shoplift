/**
 * O7 observation — read-only Product_GetDiscounts for shop000000 products 1 and 5.
 * Merchant-configured Prislinjer. Does not write, wipe, seed, or close O7.
 * Never prints secrets. Never SetEncoding.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "../src/dandomain/client.js";
import { asRecords } from "../src/dandomain/xml.js";
import { TYPES } from "../src/dandomain/operations.js";
import { publicPrice } from "../src/sources/dandomain.js";

const envPath = path.resolve(".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

const user = process.env.DD_SOAP_USERNAME;
const pass = process.env.DD_SOAP_PASSWORD;
if (!user || !pass) {
  console.log(JSON.stringify({ ok: false, error: "missing DD_SOAP credentials in env" }));
  process.exit(2);
}

function arr(v) {
  return asRecords(v);
}

function pick(row, keys) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const k of keys) out[k] = row[k] ?? null;
  return out;
}

const DISCOUNT_KEYS = [
  "Id", "ProductId", "ProductVariantId", "Amount", "Price", "Discount", "Currency",
  "DiscountType", "UserType", "UserId", "Date", "DateFrom", "DateTo", "Accumulate", "Site",
  "Language",
];

const PRODUCT_KEYS = [
  "Id", "Title", "Price", "BuyingPrice", "Discount", "DiscountType", "GuidelinePrice", "MinAmount",
];

const VARIANT_KEYS = [
  "Id", "ProductId", "Title", "Price", "BuyingPrice", "Discount", "DiscountType", "Sorting",
  "VariantTypeValues", "MinAmount",
];

const client = createClient({ username: user, password: pass });
await client.connect();

await client.call("Product_SetFields", {
  Fields: [...PRODUCT_KEYS, "Discounts", "Variants"].join(","),
});
await client.call("Product_SetVariantFields", {
  Fields: VARIANT_KEYS.join(","),
});

const groups = arr((await client.call("User_GetGroupAll")).result).map((g) => ({
  Id: g?.Id ?? null,
  Title: g?.Title ?? null,
}));

const ids = [1, 5];
const products = [];

for (const id of ids) {
  const byId = await client.call("Product_GetById", { ProductId: id });
  const discounts = await client.call("Product_GetDiscounts", { ProductId: id });
  const variants = await client.call("Product_GetVariants", { ProductId: id });
  let accumulative = null;
  try {
    accumulative = await client.call("Product_GetDiscountsAccumulative", { ProductId: id });
  } catch (e) {
    accumulative = { ok: false, error: e.message };
  }

  const product = byId.result && typeof byId.result === "object" ? byId.result : null;
  const discountRows = arr(discounts.result).map((r) => pick(r, DISCOUNT_KEYS));
  const variantRows = arr(variants.result).map((r) => pick(r, VARIANT_KEYS));
  const nestedDiscounts = arr(product?.Discounts).map((r) => pick(r, DISCOUNT_KEYS));
  const pp = publicPrice({ ...product, Discounts: discountRows });

  const variantIdValues = [...new Set(discountRows.map((r) => String(r.ProductVariantId ?? "")))];
  const alleVarianterCandidates = discountRows.filter((r) => {
    const v = r.ProductVariantId;
    return v === "" || v === null || v === undefined || String(v) === "0";
  });

  products.push({
    productId: id,
    getByIdOk: byId.ok !== false,
    product: pick(product, PRODUCT_KEYS),
    nestedDiscountCount: nestedDiscounts.length,
    nestedDiscounts,
    getDiscountsOk: discounts.ok !== false,
    discountCount: discountRows.length,
    discounts: discountRows,
    variants: variantRows,
    accumulativeOk: accumulative?.ok !== false && !accumulative?.error,
    accumulativeCount: arr(accumulative?.result).length,
    accumulative: arr(accumulative?.result),
    accumulativeError: accumulative?.error ?? null,
    variantIdValuesOnDiscountRows: variantIdValues,
    rowsWithEmptyOrZeroVariantId: alleVarianterCandidates,
    publicPriceR42: {
      price: pp.price,
      source: pp.source,
      rows: pp.rows,
      dropped: pp.dropped,
      unknownScope: pp.unknownScope,
      variantScopedRows: pp.variantScopedRows,
    },
  });
}

const out = {
  ok: true,
  shop: "shop000000",
  observedAt: new Date().toISOString(),
  write: false,
  operations: [
    "Product_SetFields",
    "Product_SetVariantFields",
    "Product_GetById",
    "Product_GetDiscounts",
    "Product_GetVariants",
    "Product_GetDiscountsAccumulative",
    "User_GetGroupAll",
  ],
  note: "Session SetFields only. No Product_Create/Update/Delete. O7 stays OPEN (trial admin ≠ client shop).",
  groups,
  products,
};

mkdirSync("data/probes", { recursive: true });
writeFileSync("data/probes/o7-prislinjer.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  ok: true,
  shop: out.shop,
  observedAt: out.observedAt,
  groups: out.groups,
  products: out.products.map((p) => ({
    productId: p.productId,
    title: p.product?.Title,
    productPrice: p.product?.Price,
    buyingPrice: p.product?.BuyingPrice,
    guidelinePrice: p.product?.GuidelinePrice,
    discountCount: p.discountCount,
    discounts: p.discounts,
    variants: p.variants.map((v) => ({ Id: v.Id, Title: v.Title, Price: v.Price })),
    variantIdValuesOnDiscountRows: p.variantIdValuesOnDiscountRows,
    publicPriceR42: p.publicPriceR42,
    accumulativeCount: p.accumulativeCount,
  })),
}));
