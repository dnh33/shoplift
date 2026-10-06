#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { runExport } from "./stages/export.js";
import { runTransform } from "./transform/index.js";
import { runImport } from "./import/index.js";
import { runVerify } from "./stages/verify.js";
import { runDoctor } from "./stages/doctor.js";
import { runMenu, runSites } from "./menu.js";
import { PKG_ROOT } from "./paths.js";
import path from "node:path";
import { log } from "./log.js";

const USAGE = `
SHOPLIFT — store extraction & relocation suite (WordPress / DanDomain -> Shopify)

Usage:
  node src/cli.js              interactive menu (wizard, doctor, stages)
  node src/cli.js <stage> [options]

Stages:
  export      Pull raw data from the source (WordPress or DanDomain) -> data/raw/
  transform   Map raw data to Shopify inputs -> data/transformed/  (offline)
  import      Push to Shopify Admin GraphQL API (resumable)
  verify      Reconcile counts + spot-check prices post-import
  doctor      Test source (WP/Woo or DanDomain SOAP) and Shopify connections
  status      Aggregate migration state as one report (--json for machines)
  sites       Manage WordPress/DanDomain/Shopify profiles + active pair (interactive)
  seed        Create test data on the source store
              (WP: --tier light|medium|heavy|real|real-xl; DanDomain: dd-light|dd-medium|dd-heavy|dd-real|dd-real-xl)
  wipe        DELETE ALL data on the target Shopify store (dev stores only, asks confirmation; --yes to skip)
  all         export -> transform -> import -> verify

Machine-mode only (--json), for scripts and AI agents — see SETUP.md:
  sites-list      List profiles, pairs and the active pair
  sites-add       Register a profile: --kind wordpress --base-url <url>
                  or --kind shopify --shop <store>  [--name x] [--overwrite]
                  or --kind dandomain --tenant <shopNNNNN> (or --storefront-url <url>) [--shop-id <id>]
                  Credentials default to \${ENV_VAR} refs; put values in .env
  sites-activate  Activate a pair: --source <name> --target <name>

Options:
  --config <path>       Config file (default: config/migration.config.json)
  --entities a,b,c      Limit to specific entities: products, collections,
                        customers, orders, discounts, pages, articles, redirects
  --dry-run             Import stage logs what it would do; no writes to Shopify
  --verbose             Debug logging
  --json                Machine mode: one JSON envelope on stdout, prose to stderr,
                        deterministic exit codes (0 ok · 2 usage · 3 connection ·
                        4 partial failures · 5 verify failed)
  --wp                  With wipe: wipe the WordPress SOURCE instead of Shopify
  --wipe-first          With seed: wipe the WP source before seeding (requires --yes)

Typical run order for a real migration (see PLAYBOOK.md):
  1. export + transform, review data/transformed/warnings.jsonl
  2. import --entities products,collections   -> review in Shopify admin
  3. import --entities customers,discounts,pages,articles
  4. import --entities orders
  5. import --entities redirects              -> last, at go-live
  6. verify
`;

function parseArgs(argv) {
  // default config lives in the package; explicit --config resolves from the user's cwd
  const args = { stage: argv[2], config: path.join(PKG_ROOT, "config", "migration.config.json"), entities: null, dryRun: false };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") args.config = argv[++i];
    else if (a === "--entities") args.entities = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--tier") args.tier = argv[++i];
    else if (a === "--yes") args.yes = true;
    else if (a === "--json") args.json = true;
    else if (a === "--wp") args.wp = true;
    else if (a === "--wipe-first") args.wipeFirst = true;
    else if (a === "--verbose") log.setLevel("debug");
    else if (a === "--adapter") args.adapter = argv[++i];
    // sites-* machine-mode flags. Deliberately NO credential flags: argv is
    // visible in the process list and lands in shell history, so a literal
    // secret must never be passable here. The ${ENV_VAR} defaults sites_add
    // applies are the supported path from the CLI — put real values in .env.
    // A caller that genuinely holds literal credentials uses the MCP tool.
    else if (a === "--kind") args.kind = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--shop") args.shop = argv[++i];
    else if (a === "--tenant") args.tenant = argv[++i];
    else if (a === "--storefront-url") args.storefrontUrl = argv[++i];
    else if (a === "--shop-id") args.shopId = argv[++i];
    else if (a === "--source") args.source = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--overwrite") args.overwrite = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.json) {
    const { machine, emit, envelope, EXIT } = await import("./util/machine.js");
    machine.enable();
    // Parsed and silently ignored is worse than either implementing or
    // rejecting it: --adapter only takes effect on the human code path
    // (below, after config load) — in --json mode it never reaches
    // cfg.source.adapter, so a caller that passes it would silently get the
    // config file's adapter instead. Reject loudly rather than let that lie.
    if (args.adapter) {
      emit(envelope(String(args.stage), { ok: false, exit: EXIT.USAGE, error: { code: "USAGE", message: "--adapter is not supported in --json mode", hint: "The adapter comes from source.adapter in the config file, not a CLI flag, when running --json." } }));
      process.exit(EXIT.USAGE);
    }
    const { createApi } = await import("./api.js");
    const api = createApi(args.config);
    const t0 = Date.now();
    const commands = {
      status: () => api.status({}),
      doctor: () => api.doctor({}),
      export: () => api.export({ entities: args.entities }),
      transform: () => api.transform({ entities: args.entities }),
      import: () => api.import({ entities: args.entities, dryRun: args.dryRun }),
      verify: () => api.verify({}),
      all: () => api.all({ entities: args.entities, dryRun: args.dryRun }),
      seed: () => api.seed({ tier: args.tier || "light", wipeFirst: args.wipeFirst === true, confirm: args.yes === true }),
      wipe: () => (args.wp ? api.wipeWordpress({ confirm: args.yes === true }) : api.wipeShopify({ confirm: args.yes === true })),
      // Site management was previously reachable only from the interactive TTY
      // menu (menu.js runSites), which no agent can drive, and from MCP. These
      // three close that gap for the --json CLI path.
      "sites-list": () => api.sitesList({}),
      "sites-activate": () => api.sitesActivate({ source: args.source, target: args.target }),
      // Only keys the caller actually supplied are forwarded: sites_add
      // rejects field names that don't belong to the given kind, so passing
      // e.g. `baseUrl: undefined` alongside kind:"shopify" would be read as a
      // wrong-kind field rather than an absent one.
      "sites-add": () => api.sitesAdd(Object.fromEntries(Object.entries({
        kind: args.kind, name: args.name, baseUrl: args.baseUrl, shop: args.shop,
        tenant: args.tenant, storefrontUrl: args.storefrontUrl, shopId: args.shopId,
        overwrite: args.overwrite === true ? true : undefined
      }).filter(([, v]) => v !== undefined)))
    };
    // Accept the MCP tool spelling too (sites_list === sites-list). An agent
    // that reads a tool name from docs/MACHINE-CONTRACT.md and types it at the CLI should get
    // the command, not a usage error over a punctuation difference.
    if (typeof args.stage === "string" && args.stage.includes("_")) {
      const hyphenated = args.stage.replace(/_/g, "-");
      if (commands[hyphenated]) args.stage = hyphenated;
    }
    if (!commands[args.stage]) {
      emit(envelope(String(args.stage), { ok: false, exit: EXIT.USAGE, error: { code: "USAGE", message: `unknown command "${args.stage}" in --json mode`, hint: `valid: ${Object.keys(commands).join(", ")}` } }));
      process.exit(EXIT.USAGE);
    }
    const res = await commands[args.stage]();
    emit(envelope(res.command, { ...res, t0 }));
    process.exit(res.exit);
  }
  if (!args.stage || args.stage === "menu") {
    await runMenu(args.config);
    return;
  }
  if (args.stage === "sites") {
    await runSites(args.config);
    return;
  }
  if (["help", "--help", "-h"].includes(args.stage) || !["export", "transform", "import", "verify", "doctor", "status", "seed", "wipe", "all"].includes(args.stage)) {
    console.log(USAGE);
    process.exit(["help", "--help", "-h"].includes(args.stage) ? 0 : 1);
  }

  const cfg = loadConfig(args.config);
  if (args.dryRun) cfg.options.dryRun = true;
  if (args.adapter) cfg.source.adapter = args.adapter;

  let entities = { ...cfg.entities };
  if (args.entities) {
    entities = Object.fromEntries(Object.keys(entities).map((k) => [k, args.entities.includes(k)]));
  }

  const t0 = Date.now();
  if (args.stage === "doctor") { const { ok } = await runDoctor(cfg); process.exit(ok ? 0 : 1); }
  if (args.stage === "status") {
    const { collectStatus } = await import("./stages/status.js");
    const st = collectStatus(cfg);
    for (const [k, v] of Object.entries({ exported: st.exported?.counts, transformed: st.transformed?.counts, ledger: st.ledger, verify: st.verify ? { ok: st.verify.ok } : null })) {
      log.info(`${k}: ${v ? JSON.stringify(v) : "—"}`);
    }
    for (const w of st.warnings.actions) log.warn(`[${w.code}] ${w.message}`);
    log.info(`${st.warnings.actions.length} action / ${st.warnings.handled} handled / ${st.warnings.info} info — full detail: status --json`);
    return;
  }
  if (args.stage === "wipe") {
    if (args.wp) {
      const isDd = cfg.source?.adapter === "dandomain" || cfg.source?.kind === "dandomain";
      if (isDd) {
        log.error("wipe --wp refuses a DanDomain pair — this tool never deletes DanDomain source data (use the Hostedshop admin or the probe kit). The data/raw/summary.json source-wipe gate is for WordPress test sites only.");
        process.exit(2);
      }
      const { wipeWordPress } = await import("./seed.js");
      const { createWpApi } = await import("./wp-bootstrap.js");
      const user = cfg.source.wpContent?.username || cfg.source.woocommerce?.consumerKey;
      const pass = cfg.source.wpContent?.appPassword || cfg.source.woocommerce?.consumerSecret;
      if (!user || !pass) { log.error("no WP write credentials in the active config"); process.exit(2); }
      const host = new URL(cfg.source.baseUrl).host;
      if (!args.yes) {
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`Wipe ALL WooCommerce/WP content on ${host}? Type the host to confirm: `);
        rl.close();
        if (answer.trim() !== host) { log.warn("confirmation did not match — aborted"); process.exit(2); }
      }
      const api = createWpApi({ site: cfg.source.baseUrl, username: user, password: pass });
      const summary = await wipeWordPress({ api, cfg, logger: (m) => log.info(m) });
      log.info(`WP wiped: ${JSON.stringify(summary)}`);
    } else {
      const { runWipe } = await import("./stages/wipe.js");
      await runWipe(cfg, { yes: args.yes });
    }
    log.info(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }
  if (args.stage === "seed") {
    const isDd = cfg.source?.adapter === "dandomain" || cfg.source?.kind === "dandomain";
    if (isDd) {
      const { seedDanDomain, DD_TIERS } = await import("./seed-dandomain.js");
      const { createClient } = await import("./dandomain/client.js");
      const { spinner } = await import("./ui.js");
      const tier = args.tier || "dd-light";
      if (!DD_TIERS[tier]) { log.error(`--tier must be one of: ${Object.keys(DD_TIERS).join(", ")} (DanDomain)`); process.exit(1); }
      if (args.wipeFirst) {
        log.error("DanDomain seed has no source wipe — omit --wipe-first; upserts are idempotent");
        process.exit(2);
      }
      const dd = cfg.source.dandomain || {};
      if (!dd.username || !dd.password) { log.error("DanDomain seed needs source.dandomain username/password"); process.exit(1); }
      const client = createClient({
        username: dd.username,
        password: dd.password,
        requestEncoding: "utf-8",
        ...(dd.endpoint ? { endpoint: dd.endpoint } : {}),
        ...(dd.timeoutMs ? { timeoutMs: dd.timeoutMs } : {}),
        ...(dd.ftp ? { ftp: dd.ftp } : {}),
      });
      const sp = spinner(`seeding "${tier}" on DanDomain…`);
      try {
        const summary = await seedDanDomain({ client, cfg, tier, logger: (m) => sp.update(`seed ${tier}: ${m}`) });
        const { writeJson } = await import("./util/fsx.js");
        writeJson(path.join(cfg.paths.state, "seed-report.json"), { tier, seededAt: new Date().toISOString(), summary });
        sp.succeed(`seeded "${tier}" — ${JSON.stringify(summary)}`);
      } catch (e) { sp.fail(`seed failed: ${e.message.slice(0, 160)}`); process.exit(1); }
      log.info(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }
    const { seedDataset, TIERS } = await import("./seed.js");
    const { createWpApi } = await import("./wp-bootstrap.js");
    const { spinner } = await import("./ui.js");
    const tier = args.tier || "light";
    if (!TIERS[tier]) { log.error(`--tier must be one of: ${Object.keys(TIERS).join(", ")}`); process.exit(1); }
    // --wipe-first deletes ALL WordPress content (seed.js:wipeWordPress) — gate
    // it before doing anything else, same as `wipe`. No interactive fallback
    // (invariant #9): --yes is the only way through, deliberately.
    if (args.wipeFirst && !args.yes) { log.error("--wipe-first requires --yes (it DELETES ALL WooCommerce/WP content on the source site first)"); process.exit(2); }
    const user = cfg.source.wpContent?.username || cfg.source.woocommerce?.consumerKey;
    const pass = cfg.source.wpContent?.appPassword || cfg.source.woocommerce?.consumerSecret;
    if (!user || !pass) { log.error("Seeding needs WP credentials with write access (application password) in the active config"); process.exit(1); }
    if (args.wipeFirst) {
      const { wipeWordPress } = await import("./seed.js");
      const wapi = createWpApi({ site: cfg.source.baseUrl, username: user, password: pass });
      log.info("wiping WP source first (--wipe-first)…");
      log.info(`WP wiped: ${JSON.stringify(await wipeWordPress({ api: wapi, cfg, logger: () => {} }))}`);
    }
    const api = createWpApi({ site: cfg.source.baseUrl, username: user, password: pass });
    const sp = spinner(`seeding "${tier}" dataset on ${cfg.source.baseUrl}…`);
    try {
      const summary = await seedDataset({ api, site: cfg.source.baseUrl, tier, logger: (m) => sp.update(`seed ${tier}: ${m}`) });
      const { writeJson } = await import("./util/fsx.js");
      writeJson(path.join(cfg.paths.state, "seed-report.json"), { tier, seededAt: new Date().toISOString(), summary });
      sp.succeed(`seeded "${tier}" — ${JSON.stringify({ ...summary, light: summary.light ? "ok" : undefined })}`);
      if (summary.real?.probes) log.info(`  probes: ${JSON.stringify(summary.real.probes)}`);
      log.info(`  seed report -> ${path.join(cfg.paths.state, "seed-report.json")}`);
    } catch (e) { sp.fail(`seed failed: ${e.message.slice(0, 160)}`); process.exit(1); }
    log.info(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }
  if (args.stage === "export" || args.stage === "all") await runExport(cfg, entities);
  if (args.stage === "transform" || args.stage === "all") await runTransform(cfg, entities);
  if (args.stage === "import" || args.stage === "all") await runImport(cfg, entities);
  if (args.stage === "verify" || (args.stage === "all" && !cfg.options.dryRun)) await runVerify(cfg);
  else if (args.stage === "all" && cfg.options.dryRun) log.warn("verify skipped — dry-run wrote nothing to Shopify");
  log.info(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { log.error(e.stack || e.message); process.exit(1); });
