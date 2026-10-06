import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/** Minimal .env loader (no dependency). Does not override existing env vars. */
export function loadDotEnv(dir) {
  const p = path.join(dir, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/** Recursively substitute ${VAR} with environment values. */
function expandEnv(node) {
  if (typeof node === "string") {
    return node.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(node)) return node.map(expandEnv);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) if (!k.startsWith("$")) out[k] = expandEnv(v);
    return out;
  }
  return node;
}

export function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  loadDotEnv(path.dirname(path.dirname(abs))); // project root .env
  loadDotEnv(process.cwd());
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const cfg = expandEnv(raw);

  cfg.paths = cfg.paths || {};
  cfg.paths.data = path.resolve(path.dirname(abs), "..", cfg.paths.data || "./data");
  cfg.paths.raw = path.join(cfg.paths.data, "raw");
  cfg.paths.transformed = path.join(cfg.paths.data, "transformed");
  cfg.paths.state = path.join(cfg.paths.data, "state");
  cfg.entities = { products: true, collections: true, customers: true, orders: true, discounts: true, pages: true, articles: true, redirects: true, ...(cfg.entities || {}) };
  cfg.options = { productStatus: "DRAFT", weightUnit: "KILOGRAMS", trackInventory: true, productsBulkThreshold: 25, stripShortcodes: true, rewriteInternalLinks: true, dryRun: false, skipExpiredCoupons: true, locale: "da", ...(cfg.options || {}) };
  cfg.options.orders = { markFulfilledWhenComplete: true, importCancelled: false, tag: "wp-import", ...(cfg.options.orders || {}) };
  return cfg;
}

export function requireShopify(cfg) {
  const s = cfg.shopify || {};
  const missing = [];
  if (!s.shop) missing.push("shopify.shop");
  if (!s.apiVersion) missing.push("shopify.apiVersion");
  const hasLegacyToken = Boolean(s.adminAccessToken);
  const hasClientCreds = Boolean(s.clientId && s.clientSecret);
  if (!hasLegacyToken && !hasClientCreds) {
    missing.push("credentials: either shopify.adminAccessToken (SHOPIFY_ADMIN_TOKEN, legacy custom app) or shopify.clientId + shopify.clientSecret (SHOPIFY_CLIENT_ID/SECRET, Dev Dashboard app)");
  }
  if (missing.length) throw new Error(`Missing Shopify config: ${missing.join(", ")}`);
  return s;
}
