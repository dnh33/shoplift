import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { loadConfig, loadDotEnv } from "./config.js";
import { runExport } from "./stages/export.js";
import { runTransform } from "./transform/index.js";
import { runImport } from "./import/index.js";
import { runVerify } from "./stages/verify.js";
import { runDoctor } from "./stages/doctor.js";
import { upsertEnvFile, readEnvFile } from "./util/env.js";
import { readJson, readJsonl } from "./util/fsx.js";
import { openIdMap } from "./util/idmap.js";
import { loadSites, saveSites, seedFromCurrentConfig, addProfile, activatePair, slugify, normalizeUrl, pairStatus } from "./sites.js";
import { bootstrapWordPress } from "./wp-bootstrap.js";
import { banner, c, chip, kv, menuRow, section, hr, spinner, clearScreen, isTTY, panel, link, setTitle, enterAltScreen, exitAltScreen, showCursor, bootSequence, padv, miniBrand } from "./ui.js";
import { PKG_ROOT } from "./paths.js";
import { log } from "./log.js";
import { DD_TIERS } from "./seed-dandomain.js";

const ROOT = PKG_ROOT;
const mask = (v) => (v && v.length > 6 ? v.slice(0, 4) + "…" + v.slice(-3) : v ? "•••" : c.dim("(empty)"));

/** Active pair is DanDomain when adapter or kind says so (LINK box already uses adapter). */
export function isDanDomainSource(cfg) {
  return cfg?.source?.adapter === "dandomain" || cfg?.source?.kind === "dandomain";
}

export function exportMenuHint(cfg) {
  return isDanDomainSource(cfg) ? "DanDomain → data/raw" : "WordPress → data/raw";
}

export function seedMenuHint(cfg) {
  return isDanDomainSource(cfg) ? `${Object.keys(DD_TIERS).join("/")} on source` : "light/medium/heavy/real on source";
}

/** Tier list the [g] seed prompt prints. Pass seed.js TIERS so the WP list stays that module's object. */
export function seedTiersForMenu(cfg, wpTiers) {
  if (isDanDomainSource(cfg)) {
    return Object.fromEntries(Object.entries(DD_TIERS).map(([k, v]) => [k, v.label]));
  }
  return wpTiers;
}

/** Which source-credential block the wizard collects. WP/fixture/missing stay wordpress. */
export function wizardSourceKind(cfg) {
  return isDanDomainSource(cfg) ? "dandomain" : "wordpress";
}

export function doctorMenuHint(cfg) {
  return isDanDomainSource(cfg) ? "SOAP · storefront · Shopify" : "connections · PCD · currency";
}

/** Word-wrap with hanging indent — action items must never be truncated. */
const wrapText = (text, width, indent) => {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? indent + l : l)).join("\n");
};

/**
 * Queued line reader. node:readline's question() DROPS lines that arrive
 * while no question is pending — which happens with piped input and with
 * users pasting several answers at once. A persistent 'line' listener +
 * queue never loses input; returns null once stdin ends.
 */
function createPrompter() {
  const rl = readline.createInterface({ input, output });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (l) => { const w = waiters.shift(); w ? w(l) : queue.push(l); });
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()(null); });
  return {
    async question(prompt) {
      showCursor(); // cursor is hidden during full-screen renders
      output.write(prompt);
      if (queue.length) { const l = queue.shift(); output.write(c.dim(l) + "\n"); return l; }
      if (closed) return null;
      return new Promise((res) => waiters.push(res));
    },
    close() { rl.close(); }
  };
}

let booted = false;
async function bootOnce(cfg, sites) {
  if (booted || !isTTY) { booted = true; return; }
  booted = true;
  clearScreen();
  console.log("");
  await bootSequence([
    ["uplink established", cfg?.source?.baseUrl?.replace(/^https?:\/\//, "") || "no source configured"],
    ["target locked", cfg?.shopify?.shop || "no target configured"],
    ["ledger mounted", cfg ? path.relative(ROOT, cfg.paths.state) : "—"],
    ["shoplift kernel v1.337", "READY"]
  ]);
}

export async function runMenu(configPath) {
  const rl = createPrompter();
  const ask = async (q, def = "") => {
    const suffix = def !== "" && def !== undefined ? ` ${c.dim(`[${def}]`)}` : "";
    const a = ((await rl.question(`  ${chip.prompt()} ${q}${suffix}: `)) ?? "").trim();
    return a === "" ? def : a;
  };

  const cfgFile = path.resolve(configPath);
  const loadOrNull = () => { try { return existsSync(cfgFile) ? loadConfig(cfgFile) : null; } catch (e) { log.error(e.message); return null; } };
  // results stay on screen until acknowledged; then a clean redraw (interactive only)
  const pause = async () => { if (isTTY) await rl.question(c.gray("\n  ↵ enter to continue ")); };

  {
    const cfg0 = loadOrNull();
    if (isTTY) { enterAltScreen(); setTitle(`SHOPLIFT ${cfg0?.source?.baseUrl ? "— " + cfg0.source.baseUrl.replace(/^https?:\/\//, "") + " → " + (cfg0.shopify?.shop || "?") : ""}`); }
    process.once("SIGINT", () => { exitAltScreen(); process.exit(130); });
    await bootOnce(cfg0, loadSites(ROOT));
  }

  let firstDraw = true;
  try { for (;;) {
    const cfg = loadOrNull();
    const sites = loadSites(ROOT);
    clearScreen();
    // identity earns its 8 rows once — redraws get a one-line brand bar
    console.log(firstDraw ? banner() : miniBrand(c.muted(cfg ? `${cfg.source.baseUrl.replace(/^https?:\/\//, "")} ${"→"} ${cfg.shopify?.shop || "?"}` : "no active pair")));
    firstDraw = false;
    if (cfg) {
      const auth = cfg.shopify?.clientId ? "client credentials" : cfg.shopify?.adminAccessToken ? "legacy token" : c.danger("NO CREDENTIALS");
      const pair = sites.activePair;
      const rows = [
        `${c.muted("source".padEnd(7))}${c.dim(c.muted("│"))} ${pair ? c.accent(pair.source) + " " + chip.arrow() + " " : ""}${link(c.text(cfg.source.baseUrl || "(not set)"), cfg.source.baseUrl || "#")} ${c.muted(`(${cfg.source.adapter})`)}`,
        `${c.muted("target".padEnd(7))}${c.dim(c.muted("│"))} ${pair ? c.accent(pair.target) + " " + chip.arrow() + " " : ""}${link(c.text(cfg.shopify?.shop || "(not set)"), `https://${cfg.shopify?.shop}/admin`)} ${c.muted(`· ${cfg.shopify?.apiVersion} · ${auth}`)}`
      ];
      const t = readJson(path.join(cfg.paths.transformed, "summary.json"), null);
      if (t) {
        const staged = Object.entries(t.counts).map(([k, v]) => `${c.muted(k)}:${c.text(v)}`).join("  ");
        const act = t.severities ? t.severities.action : t.warnings;
        const notes = t.severities ? t.severities.handled + t.severities.info : 0;
        // absence of alarm ≠ presence of confirmation — the clean state is explicit
        const state = act ? `  ${chip.warn()} ${c.warn(act + " action")}` : `  ${chip.ok()} ${c.ok("clean")}`;
        rows.push(`${c.muted("staged".padEnd(7))}${c.dim(c.muted("│"))} ${staged}${state}${notes ? c.muted(`  +${notes} notes`) : ""}`);
      }
      console.log(panel("link", rows));
    } else {
      console.log(panel("link", [c.warn("no active config — open [s] Sites or [w] Wizard")]));
    }

    const leftCol = [
      section("run").slice(1),
      menuRow("1", "Doctor", doctorMenuHint(cfg)),
      menuRow("2", "Export", exportMenuHint(cfg)),
      menuRow("3", "Transform", "→ Shopify inputs + warnings"),
      menuRow("4", "Import", "waves · live or dry-run"),
      menuRow("5", "Verify", "reconcile + spot-checks"),
      menuRow("6", "Status", "counts · warnings · failures"),
      menuRow("7", "Full pipeline", "the whole heist, end to end")
    ];
    const rightCol = [
      section("ops").slice(1),
      menuRow("s", "Sites", "profiles · pairs · clients"),
      menuRow("w", "Wizard", "credentials for active pair"),
      menuRow("g", "Seed data", seedMenuHint(cfg)),
      menuRow("x", "Wipe target", "dev-store reset"),
      menuRow("q", "Quit", "vanish without a trace")
    ];
    if ((process.stdout.columns || 100) >= 112) {
      console.log("");
      for (let i = 0; i < Math.max(leftCol.length, rightCol.length); i++) {
        console.log(padv(leftCol[i] ?? "", 60) + (rightCol[i] ?? ""));
      }
    } else {
      console.log("");
      for (const l of [...leftCol, "", ...rightCol]) console.log(l);
    }

    const choice = ((await rl.question(`\n  ${chip.prompt()} `)) ?? "q").trim().toLowerCase();
    try {
      if (choice === "q") break;
      else if (choice === "s") await sitesMenu(rl, ask, cfgFile);
      else if (choice === "w") await wizard(ask, cfgFile);
      else if (!cfg) console.log(`  ${chip.warn()} no active config — use ${c.cyan("[s]")} or ${c.cyan("[w]")} first`);
      else if (choice === "g") {
        if (isDanDomainSource(cfg)) {
          const { seedDanDomain, DD_TIERS } = await import("./seed-dandomain.js");
          const { createClient } = await import("./dandomain/client.js");
          const dd = cfg.source.dandomain || {};
          if (!dd.username || !dd.password) { console.log(`  ${chip.warn()} DanDomain seed needs SOAP username/password (DD_SOAP_* in .env)`); continue; }
          const tiers = seedTiersForMenu(cfg);
          for (const [t, d] of Object.entries(tiers)) console.log(`      ${c.cyan(t.padEnd(9))} ${c.gray(d)}`);
          const tier = (await ask("tier", "dd-light")).toLowerCase();
          if (!DD_TIERS[tier]) { console.log(`  ${chip.warn()} unknown tier`); continue; }
          if ((await ask(`seed "${tier}" onto ${cfg.source.baseUrl}? creates real store data (y/N)`, "n")).toLowerCase().startsWith("y")) {
            const client = createClient({
              username: dd.username,
              password: dd.password,
              requestEncoding: "utf-8",
              ...(dd.endpoint ? { endpoint: dd.endpoint } : {}),
              ...(dd.timeoutMs ? { timeoutMs: dd.timeoutMs } : {}),
              ...(dd.ftp ? { ftp: dd.ftp } : {}),
            });
            const sp = spinner(`seeding ${tier}…`);
            try {
              const summary = await seedDanDomain({ client, cfg, tier, logger: (m) => sp.update(`seed ${tier}: ${m}`) });
              const { writeJson } = await import("./util/fsx.js");
              writeJson(path.join(cfg.paths.state, "seed-report.json"), { tier, seededAt: new Date().toISOString(), summary });
              sp.succeed(`"${tier}" dataset ready — next: [2] Export (or [7] full pipeline)`);
              console.log(`  ${c.gray("report:")} ${path.join(cfg.paths.state, "seed-report.json")}`);
            } catch (e) { sp.fail(`seed: ${e.message.slice(0, 140)}`); }
          }
          continue;
        }
        const { seedDataset, TIERS, STANDALONE_TIERS } = await import("./seed.js");
        const { createWpApi } = await import("./wp-bootstrap.js");
        const user = cfg.source.wpContent?.username || cfg.source.woocommerce?.consumerKey;
        const pass = cfg.source.wpContent?.appPassword || cfg.source.woocommerce?.consumerSecret;
        if (!user || !pass) { console.log(`  ${chip.warn()} active config has no WP credentials with write access — run the wizard first`); continue; }
        for (const [t, d] of Object.entries(TIERS)) console.log(`      ${c.cyan(t.padEnd(9))} ${c.gray(d)}`);
        const tier = (await ask("tier", "light")).toLowerCase();
        if (!TIERS[tier]) { console.log(`  ${chip.warn()} unknown tier`); continue; }
        if ((await ask(`seed "${tier}" onto ${cfg.source.baseUrl}? creates real store data (y/N)`, "n")).toLowerCase().startsWith("y")) {
          const api = createWpApi({ site: cfg.source.baseUrl, username: user, password: pass });
          if (STANDALONE_TIERS.has(tier) && (await ask(`"${tier}" is STANDALONE — wipe ${cfg.source.baseUrl} first? recommended (y/N)`, "n")).toLowerCase().startsWith("y")) {
            const { wipeWordPress } = await import("./seed.js");
            const wsp = spinner("wiping WP source…");
            try { const r = await wipeWordPress({ api, cfg, logger: (m) => wsp.update(`wipe: ${m}`) }); wsp.succeed(`WP wiped — ${JSON.stringify(r)}`); }
            catch (e) { wsp.fail(`WP wipe: ${e.message.slice(0, 120)} — aborting seed`); continue; }
          }
          const sp = spinner(`seeding ${tier}…`);
          try {
            const summary = await seedDataset({ api, site: cfg.source.baseUrl, tier, logger: (m) => sp.update(`seed ${tier}: ${m}`) });
            sp.succeed(`"${tier}" dataset ready — next: [2] Export (or [8] full pipeline)`);
            if (summary.real) {
              const { writeJson } = await import("./util/fsx.js");
              writeJson(path.join(cfg.paths.state, "seed-report.json"), { tier, seededAt: new Date().toISOString(), summary });
              console.log(`  ${c.gray("probes:")} ${JSON.stringify(summary.real.probes)}`);
              console.log(`  ${c.gray("report:")} ${path.join(cfg.paths.state, "seed-report.json")}`);
            }
          } catch (e) { sp.fail(`seed: ${e.message.slice(0, 140)}`); }
        }
      }
      else if (choice === "x") {
        const { runWipe } = await import("./stages/wipe.js");
        await runWipe(cfg, { ask });
      }
      else if (choice === "1") await runDoctor(cfg);
      else if (choice === "2") await runExport(cfg, cfg.entities);
      else if (choice === "3") await runTransform(cfg, cfg.entities);
      else if (choice === "4") await importMenu(ask, cfg);
      else if (choice === "5") await runVerify(cfg);
      else if (choice === "6") status(cfg);
      else if (choice === "7") {
        const mode = await ask("mode — 1) LIVE import  2) dry-run simulation", "1");
        cfg.options.dryRun = mode === "2"; // explicit choice wins over config
        await runExport(cfg, cfg.entities);
        await runTransform(cfg, cfg.entities);
        await runImport(cfg, cfg.entities);
        if (!cfg.options.dryRun) await runVerify(cfg);
        else console.log(`\n  ${chip.warn()} ${c.warn("verify skipped — dry-run wrote nothing to Shopify. Re-run with mode 1 for the real import.")}`);
      }
    } catch (e) {
      log.error(e.message);
      console.log(c.muted("  (returned to menu — nothing else was run)"));
    } finally {
      // `continue` inside handlers must never skip this — warnings/errors have
      // to stay on screen until acknowledged, or the redraw wipes them
      if (!["q", "s", ""].includes(choice)) await pause();
    }
  } } finally {
    exitAltScreen();
    rl.close();
  }
}

/** Direct entry: `node src/cli.js sites` */
export async function runSites(configPath) {
  const rl = createPrompter();
  const ask = async (q, def = "") => {
    const suffix = def !== "" && def !== undefined ? ` ${c.dim(`[${def}]`)}` : "";
    const a = ((await rl.question(`  ${chip.prompt()} ${q}${suffix}: `)) ?? "").trim();
    return a === "" ? def : a;
  };
  if (isTTY) { enterAltScreen(); setTitle("SHOPLIFT — site manager"); }
  process.once("SIGINT", () => { exitAltScreen(); process.exit(130); });
  try { await sitesMenu(rl, ask, path.resolve(configPath)); }
  finally { exitAltScreen(); rl.close(); }
}

// ═══════════════════════ site manager ═══════════════════════
async function sitesMenu(rl, ask, cfgFile) {
  loadDotEnv(ROOT); // profiles may reference ${ENV_VARS}; resolve them even without an active config
  const pause = async () => { if (isTTY) await rl.question(c.gray("\n  ↵ enter to continue ")); };
  const seedIfEmpty = () => {
    const sites = loadSites(ROOT);
    if (!Object.keys(sites.wordpress).length && !Object.keys(sites.shopify).length && !Object.keys(sites.dandomain || {}).length) {
      const seeded = seedFromCurrentConfig(ROOT, sites);
      if (seeded?.src || seeded?.tgt) { saveSites(ROOT, sites); console.log(`  ${chip.ok()} imported current config into the registry`); }
    }
    return sites;
  };

  let firstDraw = true;
  for (;;) {
    const sites = seedIfEmpty();
    const wpNames = Object.keys(sites.wordpress);
    const ddNames = Object.keys(sites.dandomain || {});
    const shNames = Object.keys(sites.shopify);

    clearScreen();
    console.log(firstDraw ? banner() : miniBrand(c.muted("site manager")));
    firstDraw = false;
    console.log(section("site manager"));
    console.log(`  ${c.gray("WordPress")}`);
    wpNames.length
      ? wpNames.forEach((n, i) => console.log(menuRow(`w${i + 1}`, n, `${sites.wordpress[n].baseUrl} · ${sites.wordpress[n].adapter}${sites.activePair?.source === n ? "  " + c.green("● active source") : ""}`)))
      : console.log(c.dim("      (none)"));
    console.log(`  ${c.gray("DanDomain")}`);
    ddNames.length
      ? ddNames.forEach((n, i) => console.log(menuRow(`d${i + 1}`, n, `${sites.dandomain[n].storefrontUrl} · dandomain${sites.activePair?.source === n ? "  " + c.green("● active source") : ""}`)))
      : console.log(c.dim("      (none)"));
    console.log(`  ${c.gray("Shopify")}`);
    shNames.length
      ? shNames.forEach((n, i) => console.log(menuRow(`s${i + 1}`, n, `${sites.shopify[n].shop}${sites.activePair?.target === n ? "  " + c.green("● active target") : ""}`)))
      : console.log(c.dim("      (none)"));

    const pairs = pairStatus(ROOT, sites);
    if (pairs.length) {
      console.log(`  ${c.gray("Pairs")}`);
      pairs.forEach((p, i) => {
        const status = [
          p.transformedAt ? `staged ${p.transformedAt}` : null,
          p.importedAt ? `imported ${p.importedAt}` : null,
          p.verifiedAt ? `verify ${p.verifyOk ? "✓" : "✗"} ${p.verifiedAt}` : null
        ].filter(Boolean).join(" · ") || "no runs yet";
        console.log(menuRow(`p${i + 1}`, `${p.source}→${p.target}`.slice(0, 17), `${status}${p.active ? "  " + c.green("● active") : ""}`));
      });
    }
    console.log("");
    console.log(menuRow("a", "Add WordPress", "new source profile"));
    console.log(menuRow("D", "Add DanDomain", "new source profile (Hostedshop webshop)"));
    console.log(menuRow("A", "Add Shopify", "new target profile"));
    console.log(menuRow("e", "Edit", "e w1 / e d1 / e s2 — update a profile"));
    console.log(menuRow("d", "Delete", "d w1 / d d1 / d s2 — remove a profile"));
    console.log(menuRow("p", "Pair + activate", "choose source+target, write runtime config"));
    console.log(menuRow("t", "Test", "t w1 / t d1 / t s2 — connection check one profile"));
    console.log(menuRow("g", "Generate data", `g w1 — WP tiers · g d1 — ${Object.keys(DD_TIERS).join("/")}`));
    console.log(menuRow("x", "Wipe store", "x s1 (Shopify dev) / x w1 (WP test) — no DanDomain wipe"));
    console.log(menuRow("b", "Back"));
    console.log(`  ${c.muted("commands take refs: e w1 · t d1 · t s2 · g w1 · g d1 · x s1 · p p1 — or type the command alone and pick")}`);

    const raw = ((await rl.question(`\n  ${chip.prompt()} sites ${c.dim("»")} `)) ?? "b").trim();
    const [cmd, ref] = raw.split(/\s+/);
    const resolve = (r) => {
      if (!r) return null;
      const kind = r[0] === "w" ? "wordpress" : r[0] === "s" ? "shopify" : r[0] === "d" ? "dandomain" : null;
      const idx = Number(r.slice(1)) - 1;
      const name = kind === "wordpress" ? wpNames[idx] : kind === "shopify" ? shNames[idx] : kind === "dandomain" ? ddNames[idx] : null;
      return kind && name ? { kind, name } : null;
    };

    try {
      if (cmd === "b" || cmd === "") return;

      else if (cmd === "a") {
        const url = normalizeUrl(await ask("WordPress URL", "https://"));
        if (!url || url === "https:/") { console.log(`  ${chip.warn()} need a URL`); continue; }
        const name = slugify(await ask("profile name", slugify(new URL(url).hostname.split(".")[0])));
        const adapter = (await ask("adapter (woocommerce/edd)", "woocommerce")).toLowerCase();

        const auto = (await ask("got a WP admin login? auto-setup mints API credentials for you (Y/n)", "y")).toLowerCase() !== "n";
        if (auto) {
          const adminUser = await ask("WP admin username");
          const adminPass = await ask("WP admin password");
          const wantWoo = adapter === "woocommerce" && (await ask("install/activate WooCommerce if missing? (Y/n)", "y")).toLowerCase() !== "n";
          const sp = spinner(`bootstrapping ${name}…`);
          try {
            const r = await bootstrapWordPress({ site: url, username: adminUser, password: adminPass, installWoo: wantWoo, logger: (m) => sp.update(`${name}: ${m}`) });
            sp.succeed(`${name}: app password minted${r.wooActive ? ", WooCommerce active" : ""}${r.wooAuthOk ? ", wc/v3 auth OK" : ""}`);
            sites.wordpress[name] = { baseUrl: url, adapter, consumerKey: r.username, consumerSecret: r.appPassword, wpUser: r.username, wpAppPassword: r.appPassword };
            if (r.wooActive && !r.wooAuthOk) console.log(`  ${chip.warn()} wc/v3 rejected the app password — create consumer keys manually and edit this profile (${c.cyan("e")})`);
          } catch (e) {
            sp.fail(`${name}: ${e.message.slice(0, 140)}`);
            continue;
          }
        } else {
          console.log(c.gray("      keys: WC consumer key/secret — or WP username + application password"));
          const ck = await ask("consumer key / WP user");
          const cs = await ask("consumer secret / app password");
          const wpUser = await ask("WP user for content export", ck);
          const wpPass = await ask("WP app password for content", cs);
          sites.wordpress[name] = { baseUrl: url, adapter, consumerKey: ck, consumerSecret: cs.replaceAll(" ", ""), wpUser, wpAppPassword: wpPass.replaceAll(" ", "") };
        }
        saveSites(ROOT, sites);
        console.log(`  ${chip.ok()} saved ${c.magenta(name)} ${c.gray(`— test it: ${c.cyan(`t w${Object.keys(sites.wordpress).indexOf(name) + 1}`)}`)}`);
      }

      else if (cmd === "A") {
        const shop = normalizeShop(await ask("myshopify.com domain", "xxx.myshopify.com"));
        const name = slugify(await ask("profile name", slugify(shop.replace(".myshopify.com", ""))));
        const mode = await ask("auth — 1) client credentials (2026+)  2) legacy shpat token", "1");
        const def = { shop, apiVersion: await ask("API version", "2026-07"), clientId: "", clientSecret: "", adminAccessToken: "" };
        if (mode === "2") def.adminAccessToken = await ask("shpat_ token");
        else { def.clientId = await ask("Client ID"); def.clientSecret = await ask("Client secret"); }
        sites.shopify[name] = def;
        saveSites(ROOT, sites);
        console.log(`  ${chip.ok()} saved ${c.magenta(name)}`);
      }

      else if (cmd === "D") {
        const given = (await ask("DanDomain storefront URL or tenant (shopNNNNN)")).trim();
        if (!given) { console.log(`  ${chip.warn()} need a storefront URL or tenant`); continue; }
        const field = given.includes(".") ? { storefrontUrl: given } : { tenant: given };
        const tenant = given.includes(".") ? new URL(normalizeUrl(given)).hostname.split(".")[0] : given;
        const name = slugify(await ask("profile name", slugify(tenant)));
        const shopId = await ask("shop id (Solution_GetWebinfo SolutionId)", tenant);
        console.log(c.gray("      keep the ${VAR} defaults and put the real values in .env — or paste literals"));
        const username = await ask("SOAP API username", "${DD_SOAP_USERNAME}");
        const password = (await ask("SOAP API password", "${DD_SOAP_PASSWORD}"));
        addProfile(sites, { kind: "dandomain", name, ...field, shopId, username, password: /^\$\{/.test(password) ? password : password.replaceAll(" ", ""), overwrite: true });
        saveSites(ROOT, sites);
        console.log(`  ${chip.ok()} saved ${c.magenta(name)} ${c.gray(`— test it: ${c.cyan(`t d${Object.keys(sites.dandomain).indexOf(name) + 1}`)}`)}`);
      }

      else if (cmd === "e") {
        const hit = resolve(ref) || resolve(await ask("which? (w1/d1/s1)"));
        if (!hit) { console.log(`  ${chip.warn()} unknown reference`); continue; }
        const def = sites[hit.kind][hit.name];
        for (const key of Object.keys(def)) {
          const secret = /secret|password|token/i.test(key);
          const shown = secret ? mask(def[key]) : def[key];
          const v = await ask(`${hit.name}.${key} ${secret ? `(${shown})` : ""}`, secret ? def[key] : def[key]);
          def[key] = typeof v === "string" && /password|secret/i.test(key) ? v.replaceAll(" ", "") : v;
        }
        saveSites(ROOT, sites);
        console.log(`  ${chip.ok()} updated ${c.magenta(hit.name)}`);
      }

      else if (cmd === "d") {
        const hit = resolve(ref) || resolve(await ask("which? (w1/d1/s1)"));
        if (!hit) { console.log(`  ${chip.warn()} unknown reference`); continue; }
        const sure = await ask(`delete ${hit.name}? this only removes the profile, not any store data (y/N)`, "n");
        if (sure.toLowerCase().startsWith("y")) {
          delete sites[hit.kind][hit.name];
          if (sites.activePair?.source === hit.name || sites.activePair?.target === hit.name) sites.activePair = null;
          // drop pair entries referencing the deleted profile (their data dirs stay on disk)
          for (const key of Object.keys(sites.pairs || {})) {
            const [s, t] = key.split("__");
            if (s === hit.name || t === hit.name) delete sites.pairs[key];
          }
          saveSites(ROOT, sites);
          console.log(`  ${chip.ok()} deleted ${hit.name}`);
        }
      }

      else if (cmd === "p") {
        let src, tgt;
        if (ref?.startsWith("p")) {
          // quick reactivate: p p2
          const row = pairStatus(ROOT, sites)[Number(ref.slice(1)) - 1];
          if (!row) { console.log(`  ${chip.warn()} unknown pair`); continue; }
          ({ source: src, target: tgt } = row);
        } else {
          if ((!wpNames.length && !ddNames.length) || !shNames.length) { console.log(`  ${chip.warn()} need at least one source (WordPress or DanDomain) and one Shopify profile`); continue; }
          const srcPick = await ask(`source (${[wpNames.length ? `w1-w${wpNames.length}` : null, ddNames.length ? `d1-d${ddNames.length}` : null].filter(Boolean).join(" / ")})`, wpNames.length ? "w1" : "d1");
          src = /^[wd]\d/i.test(srcPick) ? resolve(srcPick.toLowerCase())?.name : wpNames[Number(srcPick) - 1];
          tgt = shNames[Number(await ask(`target # (1-${shNames.length})`, "1")) - 1];
        }
        if (!src || !tgt) { console.log(`  ${chip.warn()} invalid selection`); continue; }
        const { dataDir } = activatePair(ROOT, sites, src, tgt);
        console.log(`  ${chip.ok()} active: ${c.magenta(src)} ${chip.arrow()} ${c.magenta(tgt)}  ${c.gray(`(data: ${dataDir})`)}`);
        if ((await ask("run doctor now? (Y/n)", "y")).toLowerCase() !== "n") {
          try { await runDoctor(loadConfig(cfgFile)); } catch (e) { log.error(e.message); }
        }
      }

      else if (cmd === "g") {
        const defaultSeedRef = sites.activePair?.source && ddNames.includes(sites.activePair.source)
          ? `d${ddNames.indexOf(sites.activePair.source) + 1}`
          : sites.activePair?.source && wpNames.includes(sites.activePair.source)
            ? `w${wpNames.indexOf(sites.activePair.source) + 1}`
            : wpNames.length ? "w1" : "d1";
        const hit = resolve(ref) || resolve(await ask("which site? (w1 / d1)", defaultSeedRef));
        if (!hit || (hit.kind !== "wordpress" && hit.kind !== "dandomain")) { console.log(`  ${chip.warn()} pick a WordPress (w1) or DanDomain (d1) profile`); continue; }
        if (hit.kind === "dandomain") {
          const { seedDanDomain, DD_TIERS } = await import("./seed-dandomain.js");
          const { createClient } = await import("./dandomain/client.js");
          const dd = sites.dandomain[hit.name];
          const user = expand(dd.username);
          const pass = expand(dd.password);
          if (!user || !pass) { console.log(`  ${chip.warn()} profile has no SOAP credentials — put DD_SOAP_* in .env or edit it first (${c.cyan(`e ${ref || "d1"}`)})`); continue; }
          const tiers = seedTiersForMenu({ source: { adapter: "dandomain", kind: "dandomain" } });
          for (const [t, d] of Object.entries(tiers)) console.log(`      ${c.cyan(t.padEnd(9))} ${c.gray(d)}`);
          const tier = (await ask("tier", "dd-light")).toLowerCase();
          if (!DD_TIERS[tier]) { console.log(`  ${chip.warn()} unknown tier`); continue; }
          if ((await ask(`seed "${tier}" onto ${dd.storefrontUrl}? creates real store data (y/N)`, "n")).toLowerCase().startsWith("y")) {
            const activeCfg = existsSync(cfgFile) ? loadConfig(cfgFile) : null;
            const seedCfg = (activeCfg && isDanDomainSource(activeCfg) && sites.activePair?.source === hit.name)
              ? activeCfg
              : { source: { adapter: "dandomain", kind: "dandomain", baseUrl: dd.storefrontUrl, dandomain: { username: user, password: pass, tenant: dd.tenant, shopId: dd.shopId || dd.tenant } } };
            const client = createClient({ username: user, password: pass, requestEncoding: "utf-8" });
            const sp = spinner(`seeding ${tier} on ${hit.name}…`);
            try {
              const summary = await seedDanDomain({ client, cfg: seedCfg, tier, logger: (m) => sp.update(`${hit.name}: ${m}`) });
              sp.succeed(`${hit.name}: "${tier}" dataset ready — run export when you like`);
              if (activeCfg?.paths?.state && sites.activePair?.source === hit.name) {
                const { writeJson } = await import("./util/fsx.js");
                writeJson(path.join(activeCfg.paths.state, "seed-report.json"), { tier, seededAt: new Date().toISOString(), summary });
              }
            } catch (e) { sp.fail(`${hit.name}: ${e.message.slice(0, 140)}`); }
          }
          continue;
        }
        const { seedDataset, TIERS, STANDALONE_TIERS } = await import("./seed.js");
        const { createWpApi } = await import("./wp-bootstrap.js");
        const wp = sites.wordpress[hit.name];
        const user = expand(wp.wpUser || wp.consumerKey);
        const pass = expand(wp.wpAppPassword || wp.consumerSecret);
        if (!user || !pass) { console.log(`  ${chip.warn()} profile has no WP credentials with write access — edit it first (${c.cyan(`e ${ref || "w1"}`)})`); continue; }
        for (const [t, d] of Object.entries(TIERS)) console.log(`      ${c.cyan(t.padEnd(9))} ${c.gray(d)}`);
        const tier = (await ask("tier", "light")).toLowerCase();
        if (!TIERS[tier]) { console.log(`  ${chip.warn()} unknown tier`); continue; }
        if ((await ask(`seed "${tier}" onto ${wp.baseUrl}? creates real store data (y/N)`, "n")).toLowerCase().startsWith("y")) {
          const api = createWpApi({ site: wp.baseUrl, username: user, password: pass });
          if (STANDALONE_TIERS.has(tier) && (await ask(`"${tier}" is STANDALONE — wipe ${wp.baseUrl} first? recommended (y/N)`, "n")).toLowerCase().startsWith("y")) {
            const { wipeWordPress } = await import("./seed.js");
            const activeCfg = existsSync(cfgFile) ? loadConfig(cfgFile) : null; // gate checks the active pair's data/raw/summary.json
            const wsp = spinner(`wiping ${hit.name}…`);
            try { const r = await wipeWordPress({ api, cfg: activeCfg, logger: (m) => wsp.update(`wipe: ${m}`) }); wsp.succeed(`${hit.name} wiped — ${JSON.stringify(r)}`); }
            catch (e) { wsp.fail(`${hit.name} wipe: ${e.message.slice(0, 120)} — aborting seed`); continue; }
          }
          const sp = spinner(`seeding ${tier} on ${hit.name}…`);
          try {
            const summary = await seedDataset({ api, site: wp.baseUrl, tier, logger: (m) => sp.update(`${hit.name}: ${m}`) });
            sp.succeed(`${hit.name}: "${tier}" dataset ready — run export when you like`);
            if (summary.real?.probes) console.log(`  ${c.gray("probes:")} ${JSON.stringify(summary.real.probes)}`);
          } catch (e) { sp.fail(`${hit.name}: ${e.message.slice(0, 140)}`); }
        }
      }

      else if (cmd === "x") {
        const hit = resolve(ref) || resolve(await ask("which store? (s1 = Shopify target, w1 = WordPress source)", "s1"));
        if (!hit) { console.log(`  ${chip.warn()} unknown reference — use s1/w1 style refs`); continue; }
        if (hit.kind === "dandomain") { console.log(`  ${chip.warn()} no wipe for DanDomain sources — this tool never writes to a DanDomain shop outside the probe kit`); continue; }
        if (hit.kind === "wordpress") {
          const wp = sites.wordpress[hit.name];
          const user = expand(wp.wpUser || wp.consumerKey);
          const pass = expand(wp.wpAppPassword || wp.consumerSecret);
          if (!user || !pass) { console.log(`  ${chip.warn()} profile has no WP credentials with write access — edit it first`); continue; }
          console.log(`  ${chip.warn()} ${c.warn("deletes ALL products, orders, coupons, non-admin customers, posts & pages — TEST SITES ONLY (no production gate exists for WordPress)")}`);
          if ((await ask(`wipe ${wp.baseUrl}? (y/N)`, "n")).toLowerCase().startsWith("y")) {
            const { wipeWordPress } = await import("./seed.js");
            const { createWpApi } = await import("./wp-bootstrap.js");
            const activeCfg = existsSync(cfgFile) ? loadConfig(cfgFile) : null; // gate checks the active pair's data/raw/summary.json
            const sp = spinner(`wiping ${hit.name}…`);
            try {
              const s = await wipeWordPress({ api: createWpApi({ site: wp.baseUrl, username: user, password: pass }), cfg: activeCfg, logger: (m) => sp.update(`${hit.name}: ${m}`) });
              sp.succeed(`${hit.name} wiped ${JSON.stringify(s)} — reseed with ${c.key(`g ${ref || "w1"}`)}, then re-export`);
            } catch (e) { sp.fail(`${hit.name}: ${e.message.slice(0, 140)}`); }
          }
          continue;
        }
        const { runWipe } = await import("./stages/wipe.js");
        const sh = sites.shopify[hit.name];
        await runWipe({
          shopify: { shop: sh.shop, apiVersion: sh.apiVersion || "2026-07", clientId: expand(sh.clientId), clientSecret: expand(sh.clientSecret), adminAccessToken: expand(sh.adminAccessToken) }
        }, { ask });
        // clear the ledger of every pair that targets this store
        for (const [key, p] of Object.entries(sites.pairs || {})) {
          if (key.split("__")[1] !== hit.name) continue;
          try {
            rmSync(path.resolve(ROOT, p.dataDir, "state"), { recursive: true, force: true });
            rmSync(path.resolve(ROOT, p.dataDir, "verify-report.json"), { force: true });
            console.log(`  ${chip.ok()} cleared ledger for pair ${c.magenta(key)} ${c.dim(`(${p.dataDir}/state)`)}`);
          } catch (e) { console.log(`  ${chip.warn()} clear ${p.dataDir}/state manually (${e.message.slice(0, 60)})`); }
        }
      }

      else if (cmd === "t") {
        const hit = resolve(ref) || resolve(await ask("which? (w1/d1/s1)"));
        if (!hit) { console.log(`  ${chip.warn()} unknown reference`); continue; }
        if (hit.kind === "wordpress") {
          const wp = sites.wordpress[hit.name];
          await runDoctor({ source: { baseUrl: wp.baseUrl, adapter: wp.adapter, woocommerce: { consumerKey: expand(wp.consumerKey), consumerSecret: expand(wp.consumerSecret) } } });
        } else if (hit.kind === "dandomain") {
          const dd = sites.dandomain[hit.name];
          await runDoctor({ source: { adapter: "dandomain", kind: "dandomain", baseUrl: dd.storefrontUrl, dandomain: { username: expand(dd.username), password: expand(dd.password), tenant: dd.tenant, shopId: dd.shopId, pageBase: "detect", storefrontUrl: dd.storefrontUrl, throttle: { capacity: 1, refillPerSecond: 4 } } } });
        } else {
          const sh = sites.shopify[hit.name];
          await runDoctor({ shopify: { shop: sh.shop, apiVersion: sh.apiVersion, clientId: expand(sh.clientId), clientSecret: expand(sh.clientSecret), adminAccessToken: expand(sh.adminAccessToken) } });
        }
      }
    } catch (e) {
      log.error(e.message);
    } finally {
      if (cmd && cmd !== "b") await pause(); // runs even on `continue` — messages stay visible
    }
  }
}

const expand = (v) => String(v || "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? "");

/** "https://xxx.myshopify.com/admin" / "xxx.myshopify.com/" -> "xxx.myshopify.com" */
const normalizeShop = (s) => String(s || "").trim().replace(/^https?:\/\//i, "").split("/")[0];

// ═══════════════════════ quick wizard (active config + .env) ═══════════════════════
async function wizard(ask, cfgFile) {
  console.log(section("wizard"));
  console.log(c.gray("  Enter keeps the shown default · secrets land in .env"));
  if (!existsSync(cfgFile)) {
    copyFileSync(path.join(ROOT, "config", "migration.config.example.json"), cfgFile);
    console.log(`  ${chip.ok()} created ${path.relative(ROOT, cfgFile)} from example`);
  }
  const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
  const env = readEnvFile(ROOT);
  const envUpdates = {};

  if (wizardSourceKind(cfg) === "dandomain") {
    console.log(c.gray("  DanDomain pair — SOAP credentials land in DD_SOAP_* (not a WordPress app password)"));
    const user = await ask(`SOAP API username (${mask(env.DD_SOAP_USERNAME)})`, env.DD_SOAP_USERNAME || "");
    const pass = await ask(`SOAP API password (${mask(env.DD_SOAP_PASSWORD)})`, env.DD_SOAP_PASSWORD || "");
    if (user) envUpdates.DD_SOAP_USERNAME = user;
    if (pass) envUpdates.DD_SOAP_PASSWORD = pass.replaceAll(" ", "");
    cfg.source.dandomain = cfg.source.dandomain || {};
    cfg.source.dandomain.username = "${DD_SOAP_USERNAME}";
    cfg.source.dandomain.password = "${DD_SOAP_PASSWORD}";
  } else {
    cfg.source.baseUrl = normalizeUrl(await ask("WordPress site URL", cfg.source.baseUrl || "https://"));
    const ck = await ask(`WC consumer key or WP username (${mask(env.WC_CONSUMER_KEY)})`, env.WC_CONSUMER_KEY || "");
    const cs = await ask(`WC consumer secret or app password (${mask(env.WC_CONSUMER_SECRET)})`, env.WC_CONSUMER_SECRET || "");
    if (ck) envUpdates.WC_CONSUMER_KEY = ck;
    if (cs) envUpdates.WC_CONSUMER_SECRET = cs.replaceAll(" ", "");
    const content = (await ask("migrate posts/pages too? (Y/n)", "y")).toLowerCase() !== "n";
    cfg.source.wpContent.enabled = content;
    if (content) {
      const wu = await ask(`WP username for content export (${mask(env.WP_APP_USER)})`, env.WP_APP_USER || ck || "");
      const wpw = await ask(`WP application password (${mask(env.WP_APP_PASSWORD)})`, env.WP_APP_PASSWORD || "");
      if (wu) envUpdates.WP_APP_USER = wu;
      if (wpw) envUpdates.WP_APP_PASSWORD = wpw.replaceAll(" ", "");
    }
  }

  cfg.shopify.shop = normalizeShop(await ask("Shopify store domain", cfg.shopify.shop === "your-store.myshopify.com" ? "" : cfg.shopify.shop));
  const mode = await ask("Shopify auth — 1) client credentials (recommended)  2) legacy shpat token", env.SHOPIFY_ADMIN_TOKEN && !env.SHOPIFY_CLIENT_ID ? "2" : "1");
  if (mode === "2") {
    const tok = await ask(`admin token shpat_… (${mask(env.SHOPIFY_ADMIN_TOKEN)})`, env.SHOPIFY_ADMIN_TOKEN || "");
    if (tok) envUpdates.SHOPIFY_ADMIN_TOKEN = tok;
  } else {
    const cid = await ask(`Client ID (${mask(env.SHOPIFY_CLIENT_ID)})`, env.SHOPIFY_CLIENT_ID || "");
    const csec = await ask(`Client secret (${mask(env.SHOPIFY_CLIENT_SECRET)})`, env.SHOPIFY_CLIENT_SECRET || "");
    if (cid) envUpdates.SHOPIFY_CLIENT_ID = cid;
    if (csec) envUpdates.SHOPIFY_CLIENT_SECRET = csec;
  }
  cfg.shopify.clientId = "${SHOPIFY_CLIENT_ID}";
  cfg.shopify.clientSecret = "${SHOPIFY_CLIENT_SECRET}";
  cfg.shopify.adminAccessToken = "${SHOPIFY_ADMIN_TOKEN}";

  const { LOCALES } = await import("./locales.js");
  console.log(`  ${c.muted("store locale controls merchant-facing text (order notes, blog defaults) + localized redirect paths:")}`);
  console.log(`  ${Object.entries(LOCALES).map(([k, v]) => `${c.key(k)} ${c.muted(v.label)}`).join(c.dim(c.muted("  ·  ")))}`);
  const loc = (await ask("store locale", cfg.options.locale || "da")).toLowerCase();
  cfg.options.locale = LOCALES[loc] ? loc : "da";
  const L = LOCALES[cfg.options.locale];

  cfg.shopify.blog = cfg.shopify.blog || {};
  cfg.shopify.blog.handle = await ask("blog handle for imported posts", cfg.shopify.blog.handle || L.blog.handle);
  cfg.shopify.blog.title = await ask("blog title", cfg.shopify.blog.title || L.blog.title);
  cfg.options.productStatus = (await ask("import products as DRAFT or ACTIVE", cfg.options.productStatus || "DRAFT")).toUpperCase() === "ACTIVE" ? "ACTIVE" : "DRAFT";

  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  if (Object.keys(envUpdates).length) upsertEnvFile(ROOT, envUpdates);
  console.log(`  ${chip.ok()} saved ${path.relative(ROOT, cfgFile)}${Object.keys(envUpdates).length ? " + .env" : ""} — next: ${c.cyan("[1] Doctor")}`);
}

// ═══════════════════════ import submenu ═══════════════════════
const WAVES = {
  1: ["products", "collections"],
  2: ["customers", "discounts", "pages", "articles"],
  3: ["orders"],
  4: ["redirects"]
};

async function importMenu(ask, cfg) {
  const available = Object.entries(cfg.entities).filter(([, v]) => v).map(([k]) => k);
  console.log(section("import"));
  console.log(`  ${c.gray("staged entities:")} ${available.map((e) => c.white(e)).join(c.dim(" · "))}`);
  console.log(menuRow("1", "wave 1", "products, collections — review in admin after"));
  console.log(menuRow("2", "wave 2", "customers, discounts, pages, articles"));
  console.log(menuRow("3", "wave 3", "orders (history)"));
  console.log(menuRow("4", "wave 4", "redirects — go-live only"));
  console.log(menuRow("all", "everything", "dependency-ordered single run"));
  const pick = (await ask("wave / entities (comma list)", "all")).trim();
  const entities = { ...cfg.entities };
  if (pick !== "all") {
    const chosen = WAVES[pick] ?? pick.split(",").map((s) => s.trim());
    const set = new Set(chosen);
    for (const k of Object.keys(entities)) entities[k] = set.has(k) && cfg.entities[k];
  }
  const mode = await ask("mode — 1) LIVE import  2) dry-run simulation", "1");
  const cfg2 = structuredClone(cfg);
  cfg2.options.dryRun = mode === "2";
  await runImport(cfg2, entities);
}

// ═══════════════════════ status ═══════════════════════
function status(cfg) {
  const raw = readJson(path.join(cfg.paths.raw, "summary.json"), null);
  const t = readJson(path.join(cfg.paths.transformed, "summary.json"), null);
  const imp = readJson(path.join(cfg.paths.state, "import-report.json"), null);
  console.log(section("status"));
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${c.gray(k)}:${c.white(typeof v === "object" ? JSON.stringify(v) : v)}`).join("  ");
  console.log(kv("exported", raw ? `${fmt(raw.counts)} ${c.dim(`(${raw.exportedAt?.slice(0, 16)})`)}` : c.dim("never"), 12));
  console.log(kv("transformed", t ? `${fmt(t.counts)} ${c.dim(`(${t.transformedAt?.slice(0, 16)})`)}` : c.dim("never"), 12));
  // "migrated" = cumulative ledger truth (what exists in Shopify from this pair);
  // "last run" = only what that run newly created — zeros after idempotent re-runs are correct
  const led = openIdMap(cfg.paths.state);
  const migrated = { products: led.count("products"), collections: led.count("collections"), customers: led.count("customers"), discounts: led.count("discounts"), articles: led.count("articles"), pages: led.count("pages"), orders: led.count("orders") };
  console.log(kv("migrated", `${fmt(migrated)} ${c.dim("(ledger — cumulative)")}`, 12));
  console.log(kv("last run", imp ? `${fmt(Object.fromEntries(Object.entries(imp.results).map(([k, v]) => [k, v.imported ?? v.created ?? v])))} ${c.dim(`(new that run, ${imp.finishedAt?.slice(0, 16)})`)}` : c.dim("never"), 12));
  const warnings = readJsonl(path.join(cfg.paths.transformed, "warnings.jsonl"));
  if (warnings.length) {
    const sev = (w) => w.severity || "action";
    const actions = warnings.filter((w) => sev(w) === "action");
    const handled = warnings.filter((w) => sev(w) === "handled");
    const info = warnings.filter((w) => sev(w) === "info");
    if (actions.length) {
      console.log(`\n  ${chip.warn()} ${c.warn(`${actions.length} ACTION — a human must do something:`)}`);
      const cols = process.stdout.columns || 110;
      for (const w of actions.slice(0, 8)) {
        const indent = " ".repeat(8 + w.code.length); // aligns under the message, past "     [CODE] "
        console.log(`     ${c.dim(`[${w.code}]`)} ${c.text(wrapText(w.message, Math.max(40, cols - indent.length - 2), indent))}`);
      }
      if (actions.length > 8) console.log(c.dim(`     … +${actions.length - 8} more in data/transformed/warnings.jsonl`));
    } else {
      console.log(`\n  ${chip.ok()} ${c.ok("no action items — migration is clean")}`);
    }
    if (handled.length) console.log(`  ${chip.ok()} ${c.muted(`${handled.length} auto-handled by the tool (receipts in warnings.jsonl)`)}`);
    if (info.length) console.log(`  ${c.dim(c.muted("ℹ"))} ${c.muted(`${info.length} platform facts (nothing to do, tell the client once)`)}`);
  }
  for (const entity of ["products", "customers", "orders", "discounts", "content"]) {
    const rows = readJsonl(path.join(cfg.paths.state, `failed-${entity}.jsonl`));
    if (rows.length) console.log(`  ${chip.fail()} ${c.red(`${rows.length} failed ${entity}`)} ${c.dim(`— data/state/failed-${entity}.jsonl`)}`);
  }
  console.log("\n" + hr());
}
