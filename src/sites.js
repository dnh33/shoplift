import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readJson, writeJson } from "./util/fsx.js";

/**
 * Site registry — config/sites.json (gitignored).
 * Named WordPress/DanDomain + Shopify connection profiles, so one install of the tool
 * manages every client migration. "Activating" a pair generates the runtime
 * config/migration.config.json the pipeline stages consume, with a data dir
 * namespaced per pair so ledgers/exports never collide between projects.
 *
 * Secrets note: profiles hold credentials in plaintext on the local machine
 * (as does .env). Values may reference environment variables as ${VAR} —
 * they're expanded when the runtime config is loaded, not stored expanded.
 */
const FILE = (root) => path.join(root, "config", "sites.json");

export function loadSites(root) {
  const sites = readJson(FILE(root), null) || { wordpress: {}, shopify: {}, dandomain: {}, pairs: {}, activePair: null };
  sites.dandomain = sites.dandomain || {}; // registries written before the dandomain kind existed lack the bucket
  sites.pairs = sites.pairs || {};
  // adopt legacy shape: activePair used to carry its own dataDir
  if (sites.activePair?.dataDir) {
    const key = `${sites.activePair.source}__${sites.activePair.target}`;
    sites.pairs[key] = sites.pairs[key] || { dataDir: sites.activePair.dataDir, createdAt: new Date().toISOString() };
    delete sites.activePair.dataDir;
  }
  return sites;
}

export const pairKey = (source, target) => `${source}__${target}`;

export const normalizeUrl = (url) => {
  let u = String(url || "").trim();
  if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/$/, "");
};

export function saveSites(root, sites) {
  writeJson(FILE(root), sites);
  return FILE(root);
}

export const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";

/**
 * Field sets per kind — also the allow-list. Required fields sit first (null
 * sentinel) so a written profile keys in a stable order.
 *
 * Credentials default to ${VAR} references, never literals: an agent can
 * register a site without ever handling the real secret. The human puts the
 * value in .env, and it's expanded when the runtime config is loaded.
 */
const FIELDS = {
  wordpress: { baseUrl: null, adapter: "woocommerce", consumerKey: "${WC_CONSUMER_KEY}", consumerSecret: "${WC_CONSUMER_SECRET}", wpUser: "${WP_APP_USER}", wpAppPassword: "${WP_APP_PASSWORD}" },
  shopify: { shop: null, apiVersion: "2026-07", clientId: "${SHOPIFY_CLIENT_ID}", clientSecret: "${SHOPIFY_CLIENT_SECRET}", adminAccessToken: "" },
  // DanDomain (Hostedshop) source. `tenant` is the mywebshop.io/sfstatic
  // subdomain (R14/R21); `storefrontUrl` must be the STOREFRONT host — the
  // admin host {tenant}.webshop.dandomain.dk answers 200 for every path
  // (R39/R41). Either one derives the other. `shopId` is what the seed/doctor
  // identity gate compares against Solution_GetWebinfo.SolutionId; it defaults
  // to the tenant, which is what shop000000 reports. Credentials are the SOAP
  // API user — same ${VAR}-pointer policy as wordpress.
  dandomain: { storefrontUrl: null, tenant: null, shopId: null, username: "${DD_SOAP_USERNAME}", password: "${DD_SOAP_PASSWORD}" }
};

/**
 * Write a profile into the registry object (caller saves). Every rejection is
 * prefixed `Missing config:` so it classifies to exit 2 (USAGE), not a crash.
 */
export function addProfile(sites, { kind, name, overwrite = false, ...fields } = {}) {
  // Every rejection here classifies as CONFIG_MISSING, whose default hint is
  // about cold start — misleading for "that name is taken" or "unknown field".
  // `_hint` overrides it (api.js wrap()). Registration problems are all fixed
  // the same way: look at what is registered, then consult SETUP.md step 3.
  const reject = (msg) => { const e = new Error(`Missing config: ${msg}`); e._hint = "Registration problem, not a missing config file. `sites_list` shows the registered profile names; SETUP.md step 3 documents the fields for each kind."; throw e; };
  const defaults = FIELDS[kind];
  if (!defaults) reject('kind must be "wordpress", "shopify" or "dandomain"');
  // unknown keys are rejected, not ignored — a typo'd credential field that
  // silently vanished would look like a working profile until the first call
  for (const k of Object.keys(fields))
    if (!(k in defaults)) reject(`unknown field "${k}" for ${kind} profile (allowed: ${Object.keys(defaults).join(", ")})`);

  const profile = { ...defaults };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) profile[k] = v;

  let derived;
  if (kind === "wordpress") {
    if (!profile.baseUrl) reject("wordpress profile needs baseUrl");
    profile.baseUrl = normalizeUrl(profile.baseUrl);
    let hostname;
    try { hostname = new URL(profile.baseUrl).hostname; }
    catch { reject(`wordpress profile baseUrl is not a valid URL: ${profile.baseUrl}`); }
    derived = slugify(hostname.split(".")[0]);
  } else if (kind === "dandomain") {
    if (!profile.tenant && !profile.storefrontUrl) reject("dandomain profile needs tenant or storefrontUrl");
    if (profile.storefrontUrl) {
      profile.storefrontUrl = normalizeUrl(profile.storefrontUrl);
      let hostname;
      try { hostname = new URL(profile.storefrontUrl).hostname; }
      catch { reject(`dandomain profile storefrontUrl is not a valid URL: ${profile.storefrontUrl}`); }
      if (!profile.tenant) profile.tenant = hostname.split(".")[0];
    } else {
      profile.storefrontUrl = `https://${profile.tenant}.mywebshop.io`;
    }
    if (!profile.shopId) profile.shopId = profile.tenant;
    derived = slugify(profile.tenant);
  } else {
    if (!profile.shop) reject("shopify profile needs shop");
    // accept "mystore" or "mystore.myshopify.com" (or a pasted admin URL) —
    // always store the full myshopify host the Admin API expects
    const bare = String(profile.shop).trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.myshopify\.com$/i, "");
    if (!bare) reject("shopify profile needs shop");
    profile.shop = `${bare}.myshopify.com`;
    derived = slugify(bare);
  }

  // profile names become pair keys, and pair keys become data dir names —
  // slugify even an explicitly supplied name so that stays true
  const key = name ? slugify(name) : derived;
  const bucket = sites[kind] || (sites[kind] = {});
  const existed = Object.prototype.hasOwnProperty.call(bucket, key);
  if (existed && overwrite !== true) reject(`profile "${key}" already exists; pass overwrite:true to replace it`);
  bucket[key] = profile;
  return { name: key, created: !existed, profile };
}

/** Import the current migration.config.json + env into the registry (first run). */
export function seedFromCurrentConfig(root, sites) {
  const cfgFile = path.join(root, "config", "migration.config.json");
  if (!existsSync(cfgFile)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
    let src = null, tgt = null;
    const isDd = cfg.source?.adapter === "dandomain" || cfg.source?.kind === "dandomain";
    if (isDd && cfg.source?.dandomain?.tenant) {
      // A dandomain config must land in the dandomain bucket — reading
      // source.baseUrl unconditionally would register the shop as a WORDPRESS
      // profile, which later activates into a woocommerce config against a
      // shop with no /wp-json.
      const dd = cfg.source.dandomain;
      src = slugify(dd.tenant);
      sites.dandomain = sites.dandomain || {};
      sites.dandomain[src] = sites.dandomain[src] || {
        storefrontUrl: dd.storefrontUrl || cfg.source.baseUrl || `https://${dd.tenant}.mywebshop.io`,
        tenant: dd.tenant,
        shopId: dd.shopId || dd.tenant,
        username: dd.username || "${DD_SOAP_USERNAME}",
        password: dd.password || "${DD_SOAP_PASSWORD}"
      };
    } else if (cfg.source?.baseUrl && !cfg.source.baseUrl.includes("example")) {
      src = slugify(new URL(cfg.source.baseUrl).hostname.split(".")[0]);
      sites.wordpress[src] = sites.wordpress[src] || {
        baseUrl: cfg.source.baseUrl,
        adapter: cfg.source.adapter || "woocommerce",
        consumerKey: cfg.source.woocommerce?.consumerKey || "${WC_CONSUMER_KEY}",
        consumerSecret: cfg.source.woocommerce?.consumerSecret || "${WC_CONSUMER_SECRET}",
        wpUser: cfg.source.wpContent?.username || "${WP_APP_USER}",
        wpAppPassword: cfg.source.wpContent?.appPassword || "${WP_APP_PASSWORD}"
      };
    }
    if (cfg.shopify?.shop && !cfg.shopify.shop.includes("your-store")) {
      tgt = slugify(cfg.shopify.shop.replace(".myshopify.com", ""));
      sites.shopify[tgt] = sites.shopify[tgt] || {
        shop: cfg.shopify.shop,
        apiVersion: cfg.shopify.apiVersion || "2026-07",
        clientId: cfg.shopify.clientId || "${SHOPIFY_CLIENT_ID}",
        clientSecret: cfg.shopify.clientSecret || "${SHOPIFY_CLIENT_SECRET}",
        adminAccessToken: cfg.shopify.adminAccessToken || ""
      };
    }
    if (src && tgt) {
      sites.activePair = { source: src, target: tgt };
      sites.pairs[pairKey(src, tgt)] = sites.pairs[pairKey(src, tgt)] || { dataDir: cfg.paths?.data || "./data", createdAt: new Date().toISOString() };
    }
    return { src, tgt };
  } catch { return null; }
}

/** Generate config/migration.config.json for a source/target pair. */
export function activatePair(root, sites, sourceName, targetName) {
  const wp = sites.wordpress[sourceName];
  // a name present in both buckets resolves to wordpress — profile names are
  // pair keys, so registering the same name twice is already a caller mistake
  const dd = wp ? undefined : (sites.dandomain || {})[sourceName];
  const sh = sites.shopify[targetName];
  // Naming a profile that isn't registered is a USAGE error the caller can fix,
  // not a crash. Without the `Missing config:` prefix this classified as
  // UNEXPECTED/exit 1, whose hint ("re-run with --verbose, stages are
  // resumable") is actively wrong advice for a typo'd name — and this is the
  // step right after sites_add in the agent setup path, so it is the most
  // likely place to mistype one.
  if ((!wp && !dd) || !sh) {
    if (!wp && !dd) {
      const wpKnown = Object.keys(sites.wordpress || {});
      const ddKnown = Object.keys(sites.dandomain || {});
      const e = new Error(`Missing config: unknown source profile "${sourceName}"`);
      e._hint = `Registered wordpress profiles: ${wpKnown.length ? wpKnown.join(", ") : "(none)"}; dandomain profiles: ${ddKnown.length ? ddKnown.join(", ") : "(none)"}${wpKnown.length || ddKnown.length ? "" : " — register one with sites_add first"}. SETUP.md step 4.`;
      throw e;
    }
    const known = Object.keys(sites.shopify || {});
    const e = new Error(`Missing config: unknown shopify profile "${targetName}"`);
    e._hint = `Registered shopify profiles: ${known.length ? known.join(", ") : "(none — register one with sites_add first)"}. SETUP.md step 4.`;
    throw e;
  }

  const cfgFile = path.join(root, "config", "migration.config.json");
  const example = JSON.parse(readFileSync(path.join(root, "config", "migration.config.example.json"), "utf8"));
  const existing = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : null;

  // every pair keeps its data dir forever — re-activating an old client
  // migration always finds its ledger, exports and reports again
  const key = pairKey(sourceName, targetName);
  sites.pairs[key] = sites.pairs[key] || { dataDir: `./data/${key}`, createdAt: new Date().toISOString() };
  sites.pairs[key].lastActivatedAt = new Date().toISOString();
  const dataDir = sites.pairs[key].dataDir;

  const samePair = sites.activePair?.source === sourceName && sites.activePair?.target === targetName;
  const cfg = existing && samePair ? existing : structuredClone(example);
  if (dd) {
    // The source block is REBUILT, not merged: the example's source is a
    // WooCommerce template (its dandomain sub-block is the annotated ${VAR}
    // skeleton, not this shop), and on re-activation of the same pair the
    // rebuild is also what guarantees a hand-added `allowDestructive` never
    // survives an activation. Everything below source (entities, options,
    // shopify) keeps the same reuse semantics as the wordpress path.
    cfg.source = {
      adapter: "dandomain",
      kind: "dandomain",
      baseUrl: dd.storefrontUrl,
      dandomain: {
        username: dd.username || "${DD_SOAP_USERNAME}",
        password: dd.password || "${DD_SOAP_PASSWORD}",
        tenant: dd.tenant,
        shopId: dd.shopId || dd.tenant,
        pageSize: 100,
        // page bases are PROVED per shop, never assumed (R34): "detect"
        // settles it against this shop for 1-2 extra requests on first export
        pageBase: "detect",
        skipInactiveCoupons: true,
        weightUnit: "kg",
        storefrontUrl: dd.storefrontUrl,
        mediaProbeFile: "pics/product-1.png",
        throttle: { capacity: 1, refillPerSecond: 4 },
        timeoutMs: 60000
      },
      wpContent: { enabled: false }
    };
    if (!(existing && samePair)) cfg.options.orders.tag = "dd-import";
  } else {
    cfg.source.adapter = wp.adapter || "woocommerce";
    cfg.source.baseUrl = wp.baseUrl;
    cfg.source.woocommerce = { ...(cfg.source.woocommerce || {}), consumerKey: wp.consumerKey, consumerSecret: wp.consumerSecret };
    cfg.source.wpContent = { ...(cfg.source.wpContent || {}), username: wp.wpUser || "", appPassword: wp.wpAppPassword || "" };
  }
  cfg.shopify = { ...(cfg.shopify || {}), shop: sh.shop, apiVersion: sh.apiVersion || "2026-07", clientId: sh.clientId || "", clientSecret: sh.clientSecret || "", adminAccessToken: sh.adminAccessToken || "" };
  cfg.paths = { ...(cfg.paths || {}), data: dataDir };

  // strip example annotations
  const clean = JSON.parse(JSON.stringify(cfg, (k, v) => (k.startsWith("$") ? undefined : v)));
  // P6 flags live on the example config only. A NEW activation must not generate
  // them (even as false). Re-activating the same pair keeps operator-set flags,
  // matching entities/options reuse.
  if (!(existing && samePair)) {
    for (const f of ["importB2bPricing", "importRefunds", "importGiftCards", "importTranslations"]) {
      delete clean.options?.[f];
    }
    delete clean.source?.dandomain?.multiLanguage;
  }
  writeFileSync(cfgFile, JSON.stringify(clean, null, 2));

  sites.activePair = { source: sourceName, target: targetName };
  saveSites(root, sites);
  return { cfgFile, dataDir };
}

/** Last-run info per pair, read from each pair's own data dir. */
export function pairStatus(root, sites) {
  const rows = [];
  for (const [key, p] of Object.entries(sites.pairs || {})) {
    const [source, target] = key.split("__");
    const dir = path.resolve(root, p.dataDir || `./data/${key}`);
    const t = readJson(path.join(dir, "transformed", "summary.json"), null);
    const imp = readJson(path.join(dir, "state", "import-report.json"), null);
    const ver = readJson(path.join(dir, "verify-report.json"), null);
    rows.push({
      key, source, target, dataDir: p.dataDir,
      active: sites.activePair?.source === source && sites.activePair?.target === target,
      transformedAt: t?.transformedAt?.slice(5, 16).replace("T", " "),
      importedAt: imp?.finishedAt?.slice(5, 16).replace("T", " "),
      verifiedAt: ver?.verifiedAt?.slice(5, 16).replace("T", " "),
      verifyOk: ver?.ok
    });
  }
  return rows;
}
