#!/usr/bin/env node
/**
 * bootstrap-wp.mjs — one-shot setup of a WordPress test site for SHOPLIFT.
 * Runs on YOUR machine (needs normal internet access). Node >= 20, no deps.
 *
 * Login → application password → WooCommerce install → wc/v3 auth check live
 * in src/wp-bootstrap.js; tiered demo data lives in src/seed.js. Both are also
 * available from the CLI (site manager / `node src/cli.js seed`).
 *
 * Usage:
 *   node scripts/bootstrap-wp.mjs <siteUrl> <username> <password> [--seed] [--tier light|medium|heavy]
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapWordPress } from "../src/wp-bootstrap.js";
import { seedDataset } from "../src/seed.js";
import { loadSites, saveSites, addProfile, activatePair, slugify } from "../src/sites.js";

const [site0, username, password] = process.argv.slice(2);
const SEED = process.argv.includes("--seed");
const tierIdx = process.argv.indexOf("--tier");
const TIER = tierIdx > -1 ? process.argv[tierIdx + 1] : "light";
if (!site0 || !username || !password) {
  console.error("Usage: node scripts/bootstrap-wp.mjs <siteUrl> <username> <password> [--seed] [--tier light|medium|heavy]");
  process.exit(1);
}
const SITE = site0.replace(/\/$/, "");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function writeEnvAndConfig(appPassword, wooAuthOk) {
  const envPath = path.join(ROOT, ".env");
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const set = (k, v) => {
    env = env.match(new RegExp(`^${k}=`, "m")) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : env + `\n${k}=${v}`;
  };
  set("WP_APP_USER", username);
  set("WP_APP_PASSWORD", appPassword);
  if (wooAuthOk) { set("WC_CONSUMER_KEY", username); set("WC_CONSUMER_SECRET", appPassword); }
  writeFileSync(envPath, env.trim() + "\n");
  log(`✓ wrote ${envPath}`);

  // Register in the site registry and let activatePair generate the runtime
  // config. This script used to rebuild migration.config.json straight from
  // the example template, which FLATTENED the Shopify half every time it ran —
  // pointing an existing pair at a rebuilt test site silently reset
  // shopify.shop to the placeholder. Config generation now has exactly one
  // owner (sites.js activatePair), the same one `sites_activate` uses.
  const sites = loadSites(ROOT);
  const name = slugify(new URL(SITE).hostname.split(".")[0]);
  const { created } = addProfile(sites, { kind: "wordpress", name, baseUrl: SITE, overwrite: true });
  saveSites(ROOT, sites);
  log(`✓ ${created ? "registered" : "updated"} wordpress profile "${name}" (credentials stay as \${ENV} refs — real values live in .env)`);

  // Prefer the pair already in use; otherwise any registered Shopify profile.
  const target = sites.activePair?.target && sites.shopify?.[sites.activePair.target]
    ? sites.activePair.target
    : Object.keys(sites.shopify || {})[0];

  if (target) {
    const { cfgFile, dataDir } = activatePair(ROOT, sites, name, target);
    log(`✓ activated ${name} -> ${target}`);
    log(`✓ wrote ${cfgFile} from BOTH profiles (data dir ${dataDir})`);
  } else {
    // Fresh clone: no Shopify profile exists yet, so there is no pair to
    // activate. Fall back to a starter config so the source half is usable.
    const cfgPath = path.join(ROOT, "config", "migration.config.json");
    const cfg = JSON.parse(readFileSync(path.join(ROOT, "config", "migration.config.example.json"), "utf8"));
    cfg.source.baseUrl = SITE;
    cfg.source.woocommerce.consumerKey = "${WC_CONSUMER_KEY}";
    cfg.source.woocommerce.consumerSecret = "${WC_CONSUMER_SECRET}";
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    log(`✓ wrote ${cfgPath} — no Shopify profile registered yet`);
    log(`  next: sites-add --kind shopify --shop <store>, then sites-activate --source ${name} --target <store>`);
  }
}

try {
  log(`Bootstrapping ${SITE} ...`);
  const { appPassword, wooAuthOk, api } = await bootstrapWordPress({ site: SITE, username, password, installWoo: true, logger: (m) => log(`✓ ${m}`) });
  if (SEED && wooAuthOk) {
    const summary = await seedDataset({ api, site: SITE, tier: TIER, logger: (m) => log(`  ${m}`) });
    log(`✓ seeded "${TIER}" dataset: ${JSON.stringify(summary.light ? { ...summary, light: "ok" } : summary)}`);
  } else if (SEED) log("! skipping seed until Woo auth works");
  writeEnvAndConfig(appPassword, wooAuthOk);
  log("DONE. Next: node src/cli.js export && node src/cli.js transform");
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exit(1);
}
