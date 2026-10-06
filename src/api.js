import path from "node:path";
import { loadConfig } from "./config.js";
import { EXIT, classifyError } from "./util/machine.js";
import { writeJson } from "./util/fsx.js";

/**
 * Shared command core for machine consumers (cli --json, MCP server).
 * Every command: (params) => { command, ok, exit, data, error } — never
 * throws, never process.exit()s, never prints to stdout. Stage internals may
 * print prose; machine mode reroutes that to stderr.
 */
const wrap = (command, fn) => async (params = {}) => {
  try {
    const out = (await fn(params)) || {};
    const exit = out.exit ?? EXIT.OK;
    return { command, ok: exit === EXIT.OK, exit, data: out.data ?? null, error: out.error ?? null };
  } catch (e) {
    const { code, exit, hint } = classifyError(e);
    // classifyError picks a hint from the error CODE, which is right for the
    // common cases but wrong when several unrelated failures share one code.
    // CONFIG_MISSING covers both "there is no config yet" and "that profile
    // name is taken" — a cold-start hint sends the second caller off copying
    // example files. A thrown error may override with `_hint`, same escape
    // hatch `_data` already provides.
    return { command, ok: false, exit, data: e._data ?? null, error: { code, message: String(e.message || e).slice(0, 400), hint: e._hint || hint } };
  }
};

/**
 * Credential fields never echoed back verbatim: an api result lands in an
 * LLM's context window and in the MCP call log. The `${VAR}` exception is
 * deliberate — that value is a POINTER, not a secret, and the agent needs to
 * read it to tell the human which .env key to fill in.
 */
const SECRET_FIELDS = ["consumerKey", "consumerSecret", "wpAppPassword", "clientId", "clientSecret", "adminAccessToken", "password"];
const ENV_REF = /^\$\{[A-Z0-9_]+\}$/;
const redactProfile = (profile) => Object.fromEntries(Object.entries(profile).map(([k, v]) =>
  [k, !SECRET_FIELDS.includes(k) || v === "" || ENV_REF.test(String(v)) ? v : "<redacted>"]));

export function createApi(configPath) {
  const cfg = () => loadConfig(configPath);
  const entitiesOf = (c, list) => {
    if (list === undefined || list === null) return { ...c.entities }; // omitted -> all configured entities
    if (!Array.isArray(list) || !list.every((k) => Object.prototype.hasOwnProperty.call(c.entities, k)))
      throw new Error(`Missing config: entities must be an array of ${Object.keys(c.entities).join(", ")}`);
    return Object.fromEntries(Object.keys(c.entities).map((k) => [k, list.includes(k)])); // [] -> explicit empty selection
  };
  const wpApi = async (c) => {
    const { createWpApi } = await import("./wp-bootstrap.js");
    const user = c.source.wpContent?.username || c.source.woocommerce?.consumerKey;
    const pass = c.source.wpContent?.appPassword || c.source.woocommerce?.consumerSecret;
    if (!user || !pass) throw new Error("Missing config: no WP write credentials in the active config");
    return createWpApi({ site: c.source.baseUrl, username: user, password: pass });
  };
  const confirmGate = (params) => {
    if (params.confirm !== true) {
      return { exit: EXIT.USAGE, error: { code: "CONFIRM_REQUIRED", message: "destructive command requires confirm:true (--yes on the CLI)", hint: "This is deliberate friction. The dev-store gate still applies underneath for Shopify." } };
    }
    return null;
  };

  const api = {
    // D3: verbose:false (the default here) strips the long `message` prose
    // from data.warnings.actions — collectStatus's OWN default stays
    // verbose:true so the CLI's human `status` renderer (cli.js, calls
    // collectStatus(cfg) directly, no options) keeps printing full text.
    status: wrap("status", async ({ verbose = false } = {}) => {
      const { collectStatus } = await import("./stages/status.js");
      return { data: collectStatus(cfg(), { verbose }) };
    }),

    doctor: wrap("doctor", async () => {
      const { runDoctor } = await import("./stages/doctor.js");
      const res = await runDoctor(cfg());
      if (!res.ok) return { exit: EXIT.CONNECT, data: res, error: { code: "CONNECTION", message: "doctor reported failing connections", hint: "See data.results for the per-system breakdown." } };
      return { data: res };
    }),

    export: wrap("export", async ({ entities }) => {
      const c = cfg();
      const { runExport } = await import("./stages/export.js");
      return { data: await runExport(c, entitiesOf(c, entities)) };
    }),

    transform: wrap("transform", async ({ entities }) => {
      const c = cfg();
      const { runTransform } = await import("./transform/index.js");
      const { counts, severities, warnings } = await runTransform(c, entitiesOf(c, entities));
      const warningsByCode = {};
      for (const w of warnings) warningsByCode[w.code] = (warningsByCode[w.code] || 0) + 1;
      return { data: { counts, severities, warningsByCode, actions: warnings.filter((w) => (w.severity || "action") === "action") } };
    }),

    import: wrap("import", async ({ entities, dryRun }) => {
      const c = cfg();
      if (dryRun) c.options.dryRun = true;
      const { runImport } = await import("./import/index.js");
      const report = await runImport(c, entitiesOf(c, entities));
      const failedTotal = Object.values(report.results).reduce((s, r) => s + (Number(r?.failed) || 0), 0);
      if (failedTotal > 0) return { exit: EXIT.PARTIAL, data: report, error: { code: "PARTIAL_FAILURES", message: `${failedTotal} item(s) failed to import`, hint: "Failures are in data/state/failed-*.jsonl. Re-running import retries exactly these (ledger prevents duplicates)." } };
      return { data: report };
    }),

    verify: wrap("verify", async () => {
      const c = cfg();
      const { runVerify } = await import("./stages/verify.js");
      const report = await runVerify(c);
      if (!report.ok) return { exit: EXIT.VERIFY, data: report, error: { code: "VERIFY_FAILED", message: report.dirtyTarget ? "target holds unaccounted data (dirty)" : report.staleTarget ? "ledger is ahead of the source (stale)" : "spot-checks or failures broke verification", hint: "See data.counts / data.failures; verify-report.json has the full detail." } };
      return { data: report };
    }),

    all: wrap("all", async ({ entities, dryRun }) => {
      const stages = { export: null, transform: null, import: null, verify: null };
      for (const [name, run] of [["export", api.export], ["transform", api.transform], ["import", api.import], ["verify", api.verify]]) {
        if (name === "verify" && dryRun) break;
        const res = await run({ entities, dryRun });
        stages[name] = res;
        if (!res.ok) return { exit: res.exit, data: stages, error: res.error };
      }
      return { data: stages };
    }),

    seed: wrap("seed", async (params = {}) => {
      const { tier = "light", wipeFirst = false } = params;
      const c = cfg();
      const isDd = c.source?.adapter === "dandomain" || c.source?.kind === "dandomain";
      if (isDd) {
        const { seedDanDomain, DD_TIERS } = await import("./seed-dandomain.js");
        if (!DD_TIERS[tier]) {
          throw new Error(`--tier must be one of: ${Object.keys(DD_TIERS).join(", ")} (DanDomain source)`);
        }
        if (wipeFirst) { const gate = confirmGate(params); if (gate) return gate; }
        if (wipeFirst) {
          throw new Error(
            "DanDomain seed does not implement a source wipe yet — re-run uses CreateOrUpdate upserts (idempotent). " +
            "Omit wipeFirst, or wipe the scratch shop in the Hostedshop admin.",
          );
        }
        const { createClient } = await import("./dandomain/client.js");
        const dd = c.source.dandomain || {};
        const client = createClient({
          username: dd.username,
          password: dd.password,
          // PLAYBOOK F2: never SetEncoding. Explicit utf-8 opts into the non-ASCII write guard
          // (default refuses Æblegrød titles). Probe table: UTF-8 without SetEncoding stored intact.
          requestEncoding: "utf-8",
          ...(dd.endpoint ? { endpoint: dd.endpoint } : {}),
          ...(dd.timeoutMs ? { timeoutMs: dd.timeoutMs } : {}),
          ...(dd.ftp ? { ftp: dd.ftp } : {}),
        });
        const summary = await seedDanDomain({
          client,
          cfg: c,
          tier,
          logger: (m) => console.log(`  seed ${tier}: ${m}`),
        });
        writeJson(path.join(c.paths.state, "seed-report.json"), { tier, seededAt: new Date().toISOString(), summary });
        return { data: { tier, wiped: null, summary } };
      }
      const { seedDataset, wipeWordPress, TIERS } = await import("./seed.js");
      if (!TIERS[tier]) throw new Error(`--tier must be one of: ${Object.keys(TIERS).join(", ")}`);
      // wipeFirst deletes ALL WordPress content (src/seed.js:wipeWordPress) —
      // gate it exactly like wipeShopify/wipeWordpress below, and BEFORE any
      // WP call (wpApi/wipeWordPress/seedDataset).
      if (wipeFirst) { const gate = confirmGate(params); if (gate) return gate; }
      const api_ = await wpApi(c);
      let wiped = null;
      if (wipeFirst) wiped = await wipeWordPress({ api: api_, cfg: c, logger: (m) => console.log(`  wipe: ${m}`) });
      const summary = await seedDataset({ api: api_, site: c.source.baseUrl, tier, logger: (m) => console.log(`  seed ${tier}: ${m}`) });
      writeJson(path.join(c.paths.state, "seed-report.json"), { tier, seededAt: new Date().toISOString(), summary });
      return { data: { tier, wiped, summary } };
    }),

    wipeShopify: wrap("wipe_shopify", async (params) => {
      const gate = confirmGate(params);
      if (gate) return gate;
      const { runWipe } = await import("./stages/wipe.js");
      await runWipe(cfg(), { yes: true }); // dev-store gate inside runWipe stays authoritative
      return { data: { wiped: "shopify" } };
    }),

    wipeWordpress: wrap("wipe_wordpress", async (params) => {
      const gate = confirmGate(params);
      if (gate) return gate;
      const c = cfg();
      const { wipeWordPress } = await import("./seed.js");
      const isDd = c.source?.adapter === "dandomain" || c.source?.kind === "dandomain";
      // Refuse before wpApi() so a DanDomain pair is not reported as "no WP write credentials".
      if (isDd) await wipeWordPress({ api: async () => [], cfg: c });
      const summary = await wipeWordPress({ api: await wpApi(c), cfg: c, logger: (m) => console.log(`  wipe: ${m}`) });
      return { data: { wiped: "wordpress", summary } };
    }),

    sitesList: wrap("sites_list", async () => {
      const { loadSites, pairStatus } = await import("./sites.js");
      const { PKG_ROOT } = await import("./paths.js");
      const sites = loadSites(PKG_ROOT);
      return { data: { wordpress: Object.keys(sites.wordpress || {}), dandomain: Object.keys(sites.dandomain || {}), shopify: Object.keys(sites.shopify || {}), pairs: sites.pairs || {}, activePair: sites.activePair || null, status: pairStatus(PKG_ROOT, sites) } };
    }),

    sitesActivate: wrap("sites_activate", async ({ source, target }) => {
      if (!source || !target) throw new Error("Missing config: sites_activate needs { source, target } profile names");
      const { loadSites, saveSites, activatePair } = await import("./sites.js");
      const { PKG_ROOT } = await import("./paths.js");
      const sites = loadSites(PKG_ROOT);
      activatePair(PKG_ROOT, sites, source, target);
      sites.activePair = { source, target };
      saveSites(PKG_ROOT, sites);
      return { data: { activated: `${source}__${target}` } };
    }),

    sitesAdd: wrap("sites_add", async (params = {}) => {
      const { loadSites, saveSites, addProfile } = await import("./sites.js");
      const { PKG_ROOT } = await import("./paths.js");
      const sites = loadSites(PKG_ROOT);
      const { name, created, profile } = addProfile(sites, params);
      saveSites(PKG_ROOT, sites);
      // the registry keeps whatever was passed; only the RESPONSE is redacted
      return { data: { kind: params.kind, name, created, profile: redactProfile(profile) } };
    })
  };
  return api;
}
