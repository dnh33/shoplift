/**
 * O11 live close — Product_SetVariantFields then Product_GetVariantById on shop000000.
 * Writes data/probes/o11.json. Never prints secrets.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "../src/dandomain/client.js";
import { TYPES } from "../src/dandomain/operations.js";

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
  console.log(JSON.stringify({ ok: false, error: "missing DD_SOAP_USERNAME / DD_SOAP_PASSWORD in env" }));
  process.exit(2);
}

const client = createClient({ username: user, password: pass });
await client.connect();

const pv = TYPES.ProductVariant;
const fieldList = Array.isArray(pv)
  ? pv.filter((x) => typeof x === "string")
  : (pv?.fields || []).map((f) => f.name).filter(Boolean);
await client.call("Product_SetVariantFields", { Fields: fieldList.join(",") });

const variants = await client.call("Product_GetVariants", { ProductId: 1 });
const rows = Array.isArray(variants.result)
  ? variants.result
  : variants.result?.item
    ? [].concat(variants.result.item)
    : [];
const vid = rows[0]?.Id;
if (!vid) {
  const out = { ok: false, error: "no variant on product 1", fieldCountRequested: fieldList.length };
  mkdirSync("data/probes", { recursive: true });
  writeFileSync("data/probes/o11.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
  process.exit(1);
}

const byId = await client.call("Product_GetVariantById", { VariantId: String(vid) });
const sample = byId.result;
const keys = sample && typeof sample === "object" ? Object.keys(sample) : [];
const out = {
  ok: true,
  shop: "shop000000",
  variantId: String(vid),
  setVariantFieldsOk: true,
  fieldCountRequested: fieldList.length,
  keysReturned: keys,
  keyCount: keys.length,
  onlyId: keys.length === 1 && keys[0] === "Id",
  sampleKeys: keys.slice(0, 30),
  closesO11: keys.length > 1,
  observation: keys.length > 1
    ? "After Product_SetVariantFields, Product_GetVariantById returned multiple fields (not only Id)."
    : "After Product_SetVariantFields, Product_GetVariantById still returned only Id (R25 stands).",
};
mkdirSync("data/probes", { recursive: true });
writeFileSync("data/probes/o11.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
