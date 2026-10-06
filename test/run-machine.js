#!/usr/bin/env node
/**
 * Offline machine-interface tests: --json envelopes, exit codes, stdout purity.
 * Uses the fixture adapter config (dryRun: true) — no network, no store.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? (passed++, console.log(`  ✓ ${name}`)) : (failed++, console.error(`  ✗ ${name}`)); };

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");
const CFG = path.join(ROOT, "test", "fixture.config.json");

/** Run the CLI, capture { code, stdout, stderr }. Never throws on non-zero exit. */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const parse = (out) => JSON.parse(out.trim().split("\n").pop());

console.log("— machine mode: exit-code map —");
const { EXIT, classifyError, elapsedS } = await import("../src/util/machine.js");
ok(EXIT.OK === 0 && EXIT.USAGE === 2 && EXIT.CONNECT === 3 && EXIT.PARTIAL === 4 && EXIT.VERIFY === 5, "EXIT taxonomy frozen");
ok(classifyError(new Error("\"x.myshopify.com\" is NOT a development store — wipe refuses")).code === "WIPE_GATE", "wipe gate classified");
ok(classifyError(new Error("Protected Customer Data access is not enabled")).code === "PCD_NOT_APPROVED", "PCD classified");
ok(classifyError(new Error("getaddrinfo EAI_AGAIN example.com")).exit === EXIT.CONNECT, "network errors -> CONNECT");
ok(classifyError(new Error("something exploded")).exit === 1, "unknown -> CRASH");
ok(classifyError(new Error('GraphQL errors: [{"message":"Handle is already taken","id":"gid://shopify/Product/8402103401472"}]')).exit === EXIT.CRASH, "GID digits do not trigger CONNECT");
{
  // CONFIG_MISSING is the error a cold-start caller hits first, so its hint has
  // to name the concrete next step, not just "check your config".
  const h = classifyError(new Error("Missing config: nothing is set up")).hint;
  ok(/config\/migration\.config\.example\.json/.test(h), "CONFIG_MISSING hint names the example config file to copy");
  ok(/sites_add/.test(h) && /sites_activate/.test(h), "CONFIG_MISSING hint names the sites_add -> sites_activate route as the alternative");
  ok(/doctor --json/.test(h), "CONFIG_MISSING hint keeps the `doctor --json` pointer");
}

// D4 (2026-07-28 live MCP test): a sub-second call used to round to
// elapsedS:0 via toFixed(1) — indistinguishable from a call whose duration
// was never measured. Assert the exact rounding contract deterministically
// against the pure function (envelope()'s own live-timer path is covered by
// the CLI/MCP envelope assertions below/in run-mcp.js, but timing a real
// process is inherently non-deterministic — this pins the actual boundary
// logic without relying on wall-clock luck).
console.log("— machine mode: elapsedS (D4) —");
ok(elapsedS(42) === 0.042, `sub-second durations keep 3 decimals, never round to 0 (elapsedS(42) = ${elapsedS(42)})`);
ok(elapsedS(999) === 0.999, `just under 1s still uses 3 decimals (elapsedS(999) = ${elapsedS(999)})`);
ok(elapsedS(1000) === 1, `exactly 1s switches to 1-decimal precision (elapsedS(1000) = ${elapsedS(1000)})`);
ok(elapsedS(2500) === 2.5, `durations >= 1s keep 1 decimal, as before (elapsedS(2500) = ${elapsedS(2500)})`);
ok(elapsedS(1) === 0.001, `a near-instant call is still non-zero (elapsedS(1) = ${elapsedS(1)})`);
ok(typeof elapsedS(42) === "number", "elapsedS stays a number, never a string");

console.log("— collectStatus aggregates offline state —");
{
  // fixture data-test dir is produced by run-fixtures.js earlier in `npm test`;
  // produce it here too so this file is standalone-runnable.
  execFileSync(process.execPath, [path.join(ROOT, "test", "run-fixtures.js")], { stdio: "ignore" });
  const { loadConfig } = await import("../src/config.js");
  const { collectStatus } = await import("../src/stages/status.js");
  const { writeJson } = await import("../src/util/fsx.js");
  const cfg = loadConfig(CFG);
  // Setup-time cleanup, not just teardown: the verify-report.json written at
  // the end of this block is removed in a `finally`, which does NOT run if the
  // suite is interrupted (Ctrl-C, CI step timeout, an agent's command timeout).
  // A leftover file then fails the `st.verify === null` assertion below on the
  // NEXT run — a crashed run silently poisoning the following one, which reads
  // as a code regression. run-fixtures.js never emits a verify-report, so
  // removing one here can only ever delete a stale artifact.
  // try/catch because this is opportunistic hygiene, not an assertion: on some
  // mounts (e.g. a Windows drive mounted into a Linux container) unlink returns
  // EPERM, and `force:true` only swallows ENOENT — an unguarded rmSync here
  // would turn a cosmetic pre-clean into a suite-killing crash.
  try { fs.rmSync(path.join(cfg.paths.data, "verify-report.json"), { force: true }); } catch { /* stale file stays; the assertion below reports it */ }
  const st = collectStatus(cfg);
  ok(st.pair.dataDir.endsWith("data-test"), "pair block present");
  ok(st.exported?.counts?.products === 8, "exported counts read");
  ok(st.transformed?.counts?.products === 7 && st.transformed?.severities?.action === 4, "transformed counts + severities read");
  ok(Array.isArray(st.warnings.actions) && st.warnings.actions.length === 4, "action warnings included in full");
  // D3: collectStatus's OWN default (no options object) stays verbose:true —
  // this is the exact call cli.js's human `status` renderer makes
  // (cli.js:134, `collectStatus(cfg)`), which prints w.message for each
  // action; it must not silently lose that text. api.status is the layer
  // that changes its default to false (asserted separately below).
  ok(st.warnings.actions.every((w) => typeof w.message === "string" && w.message.length > 0), "collectStatus(cfg) with no options keeps full message text (the CLI TTY path must not lose information)");
  const stTerse = collectStatus(cfg, { verbose: false });
  ok(stTerse.warnings.actions.length === 4 && stTerse.warnings.actions.every((w) => !("message" in w) && typeof w.entity === "string" && typeof w.code === "string" && typeof w.severity === "string" && w.id !== undefined),
    "collectStatus(cfg, {verbose:false}) drops message but keeps entity/id/code/severity");
  ok(st.warnings.handled === 7 && st.warnings.info === 8, "handled/info reduced to counts");
  ok(typeof st.ledger.products === "number", "ledger counts present");
  ok(st.verify === null, "verify block null-safe (no report on disk)");

  // no run-fixtures.js output includes a verify-report.json (it's written only
  // by the live `runVerify` stage against a real store) — write one directly
  // so the verify: mapping in collectStatus is actually exercised.
  const vp = path.join(cfg.paths.data, "verify-report.json");
  writeJson(vp, { verifiedAt: "2026-01-01T00:00:00Z", ok: false, counts: { products: 7 }, failures: ["x"], dirtyTarget: true });
  try {
    const st2 = collectStatus(loadConfig(CFG));
    ok(st2.verify.ok === false && st2.verify.counts.products === 7 && st2.verify.dirtyTarget === true, "verify block maps fields");
  } finally {
    fs.rmSync(vp, { force: true });
  }
}

// api.all deliberately SKIPS verify when dryRun is set — verifying an import
// that wrote nothing would compare the source against an untouched store and
// report a false failure. Correct, but it was undocumented and untested: the
// tool description promised four stages and silently delivered three, leaving
// `verify: null` for the caller to interpret. A deliberate branch with no test
// is one refactor away from changing silently.
// Found live: a lapsed TasteWP staging site started serving the vendor's own
// landing page. HTTP 200 + HTML. The WordPress-REST and currency checks call
// .json() so they failed correctly, but the WooCommerce check only read
// res.ok and an x-wp-total header — it never touched the body — so it went
// GREEN against a site where WooCommerce did not exist. A check that passes on
// a parked domain is worse than no check.
// loadDotEnv never overwrites an existing process.env key, so a long-running
// process keeps the first .env it ever read. Rotating credentials then shows
// up as an HTTP 401 that looks like wrong keys. Observed live: the MCP server
// failed 2/5 against a rebuilt test site while a fresh CLI process passed 5/5
// on the same files. doctor now says so instead of leaving you to guess.
console.log("— doctor: reports a stale process (.env or src/ newer than start) —");
{
  const { runDoctor } = await import("../src/stages/doctor.js");
  const { PKG_ROOT } = await import("../src/paths.js");
  const envPath = path.join(PKG_ROOT, ".env");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 500 }); // every check fails; irrelevant here
  const cfg = { source: { adapter: "woocommerce", baseUrl: "https://x.example", woocommerce: { consumerKey: "k", consumerSecret: "s" } } };
  const freshness = (r) => r.results.find((x) => x.name === "process freshness (.env + src/)");

  const existed = fs.existsSync(envPath);
  const original = existed ? fs.statSync(envPath) : null;
  if (!existed) fs.writeFileSync(envPath, "");
  try {
    fs.utimesSync(envPath, new Date(), new Date()); // "modified just now" = after this process started
    const stale = freshness(await runDoctor(cfg));
    ok(stale !== undefined && stale.ok === false, "a .env touched after process start surfaces a failing freshness check");
    ok(/STALE/i.test(stale?.detail || "") && /\.env/.test(stale?.detail || ""), `the message names .env as the stale thing (got ${JSON.stringify(stale?.detail?.slice(0, 60))})`);

    // Backdate it to well before this process began: the check must vanish
    // entirely, so a normal run still shows only the connection checks.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(envPath, old, old);
    ok(freshness(await runDoctor(cfg)) === undefined, "with nothing newer than process start the check vanishes — no noise on a normal run");
  } finally {
    globalThis.fetch = realFetch;
    if (!existed) fs.rmSync(envPath, { force: true });
    else fs.utimesSync(envPath, original.atime, original.mtime); // leave mtime exactly as found
  }
}

console.log("— doctor: WooCommerce check rejects 200-with-HTML (parked/expired host) —");
{
  const { runDoctor } = await import("../src/stages/doctor.js");
  const realFetch = globalThis.fetch;
  const cfg = { source: { adapter: "woocommerce", baseUrl: "https://parked.example", woocommerce: { consumerKey: "ck_x", consumerSecret: "cs_x" } } };
  const LANDING = '<!DOCTYPE html><html><head><title>Buy this domain</title></head><body></body></html>';
  const wcCheck = (r) => r.results.find((x) => x.name.startsWith("WooCommerce REST auth"));

  const stub = (wcBody, wcJson) => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/wc/v3/products")) return new Response(wcBody, { status: 200, headers: wcJson ? { "content-type": "application/json" } : { "content-type": "text/html" } });
      return new Response(LANDING, { status: 200, headers: { "content-type": "text/html" } }); // /wp-json — parked too
    };
  };

  try {
    stub(LANDING, false);
    const parked = wcCheck(await runDoctor(cfg));
    ok(parked?.ok === false, "a parked host answering 200 with HTML FAILS the WooCommerce check");
    ok(/not JSON|not the WooCommerce REST API/.test(parked?.detail || ""), `the failure says what is actually wrong (got ${JSON.stringify(parked?.detail?.slice(0, 60))})`);

    stub('{"code":"woocommerce_rest_cannot_view"}', true); // valid JSON, but an object not a list
    ok(wcCheck(await runDoctor(cfg))?.ok === false, "valid JSON that is not a product LIST also fails — 200 + JSON is not proof either");

    stub('[{"id":1,"name":"Real product"}]', true);
    const good = wcCheck(await runDoctor(cfg));
    ok(good?.ok === true, "a real wc/v3 products array still passes");
    ok(/products visible:/.test(good?.detail || ""), "the passing detail still reports a product count");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("— api.all: dryRun skips verify, and says so —");
{
  const { createApi } = await import("../src/api.js");
  const api = createApi(CFG);
  const dry = await api.all({ dryRun: true });
  ok(dry.ok === true && dry.exit === 0, `all(dryRun) succeeds (exit ${dry.exit})`);
  ok(dry.data.export?.ok === true && dry.data.transform?.ok === true && dry.data.import?.ok === true, "all(dryRun) still runs export, transform and import");
  ok(dry.data.verify === null, "all(dryRun) leaves verify null rather than verifying an import that wrote nothing");
  ok(dry.data.import?.data?.results?.products?.dryRun === true, "the import stage inside all() actually honoured dryRun");

  // The complement: without dryRun, verify MUST be attempted — otherwise the
  // assertion above would also pass on a build that never verifies at all.
  const wet = await api.all({ dryRun: false });
  ok(wet.data.verify !== null, "all() WITHOUT dryRun does attempt verify (guards against the skip becoming unconditional)");
}

// A dry run overwrites the SAME import-report.json a real import writes, so
// status.lastImport shows zeros afterwards. Without a top-level marker that is
// indistinguishable from a real import that wrote nothing — and the per-entity
// `dryRun` flags cannot carry the signal (importContent sets none, and an
// --entities subset can yield a report where no group has one).
console.log("— import report declares dryRun, and status forwards it —");
{
  const { createApi } = await import("../src/api.js");
  const { collectStatus } = await import("../src/stages/status.js");
  const { loadConfig } = await import("../src/config.js");
  const api = createApi(CFG);

  const reportPath = path.join(ROOT, "data-test", "state", "import-report.json");
  await api.import({ dryRun: true });
  const dryReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  ok(dryReport.dryRun === true, "a dry-run import writes dryRun:true at the TOP level of import-report.json");
  ok(collectStatus(loadConfig(CFG)).lastImport?.dryRun === true, "status.lastImport forwards dryRun:true — the field an agent actually branches on");
  ok("dryRun" in dryReport, "the flag is always written, so its absence never has to be interpreted");

  // The real-import case cannot run offline: a non-dry import resolves the
  // primary location over the network (import/index.js), and the fixture
  // config pins options.dryRun:true anyway — api.import can turn dryRun ON but
  // deliberately never OFF, so a dry config cannot be un-dried by a caller.
  // What IS testable, and is the actual compatibility risk, is a report
  // written before this field existed: it must read as false, not undefined.
  const legacy = { ...dryReport };
  delete legacy.dryRun;
  fs.writeFileSync(reportPath, JSON.stringify(legacy));
  ok(collectStatus(loadConfig(CFG)).lastImport?.dryRun === false, "a pre-existing report with no dryRun field reports false, never undefined");
  fs.writeFileSync(reportPath, JSON.stringify(dryReport)); // leave state as the suite found it
}

console.log("— api core returns results, never exits —");
{
  const { createApi } = await import("../src/api.js");
  const api = createApi(CFG);
  const st = await api.status({});
  ok(st.ok === true && st.exit === 0 && st.data.transformed.counts.products === 7, "api.status envelope-shaped result");
  // D3: api.status's own default is verbose:false (a documented contract
  // change from the old always-full behavior) — data.warnings.actions keeps
  // entity/id/code/severity but drops the long message text unless the
  // caller opts in. collectStatus's OWN default stays verbose:true so the
  // CLI's human `status` renderer (cli.js, calls collectStatus(cfg) with no
  // options) is untouched — asserted separately above.
  ok(Array.isArray(st.data.warnings.actions) && st.data.warnings.actions.length === 4 && st.data.warnings.actions.every((w) => !("message" in w) && typeof w.code === "string" && typeof w.entity === "string"),
    "api.status({}) defaults to verbose:false — actions carry entity/id/code/severity, no message");
  const stVerbose = await api.status({ verbose: true });
  ok(stVerbose.data.warnings.actions.length === 4 && stVerbose.data.warnings.actions.every((w) => typeof w.message === "string" && w.message.length > 0),
    "api.status({verbose:true}) restores the full message text");
  const tr = await api.transform({});
  ok(tr.ok === true && tr.data.counts.products === 7 && tr.data.warningsByCode.ZERO_PRICE === 1, "api.transform returns counts + byCode");
  const wipeNoConfirm = await api.wipeShopify({});
  ok(wipeNoConfirm.ok === false && wipeNoConfirm.exit === 2 && wipeNoConfirm.error.code === "CONFIRM_REQUIRED", "wipe without confirm refused as USAGE");
  const badTier = await api.seed({ tier: "bogus" });
  ok(badTier.ok === false && badTier.exit === 2, "bad tier is USAGE, not crash");

  // I1 — entities must be a validated array, not advisory. A non-array (e.g. a
  // bare string, the common LLM shape error) or an unknown entity name must be
  // rejected as USAGE, never silently escalate to "all entities enabled".
  const entitiesString = await api.transform({ entities: "products" });
  ok(entitiesString.ok === false && entitiesString.exit === 2 && entitiesString.error?.code === "CONFIG_MISSING", "entities as a bare string -> exit 2 CONFIG_MISSING, not silent 'all entities'");
  const entitiesUnknown = await api.transform({ entities: ["bogus-entity"] });
  ok(entitiesUnknown.ok === false && entitiesUnknown.exit === 2 && entitiesUnknown.error?.code === "CONFIG_MISSING", "unknown entity name in array -> exit 2 CONFIG_MISSING");
  const entitiesOmitted = await api.transform({});
  ok(entitiesOmitted.ok === true && entitiesOmitted.data.counts.products === 7, "entities omitted (undefined) -> unchanged: still means all configured entities");
  const entitiesEmpty = await api.transform({ entities: [] });
  ok(entitiesEmpty.ok === true && Object.keys(entitiesEmpty.data.counts).length === 0, "entities: [] -> explicit empty selection (nothing runs, empty counts), not 'everything'");

  // C1 — api.seed's wipeFirst must be gated the same way wipeShopify/wipeWordpress
  // are: confirm:true required BEFORE any WP call. The fixture config carries no
  // WP write credentials, so if the gate does NOT fire first, the call still fails
  // (via wpApi's credential check) but with the WRONG error code (CONFIG_MISSING
  // instead of CONFIRM_REQUIRED) — that distinguishes "gated" from "merely broken".
  const seedWipeNoConfirm = await api.seed({ tier: "light", wipeFirst: true });
  ok(seedWipeNoConfirm.ok === false && seedWipeNoConfirm.exit === 2 && seedWipeNoConfirm.error?.code === "CONFIRM_REQUIRED", "seed wipeFirst:true without confirm -> CONFIRM_REQUIRED (gated BEFORE any WP call), not CONFIG_MISSING");
  const seedWipeFalseNoConfirm = await api.seed({ tier: "light", wipeFirst: false });
  ok(seedWipeFalseNoConfirm.error?.code !== "CONFIRM_REQUIRED", "seed wipeFirst:false is still ungated (not newly required to confirm)");
  const seedWipeConfirmed = await api.seed({ tier: "light", wipeFirst: true, confirm: true });
  ok(seedWipeConfirmed.error?.code !== "CONFIRM_REQUIRED" && seedWipeConfirmed.exit === 2, "seed wipeFirst:true + confirm:true passes the gate (fails later only because the fixture config has no WP creds — no network ever reached)");

  // WP fixture + a DanDomain tier name must stay on the WP seeder (unknown
  // WP tier), never silently route to seed-dandomain.js.
  const wpDdTier = await api.seed({ tier: "dd-light" });
  ok(wpDdTier.ok === false && wpDdTier.exit === 2 && /light|medium|heavy/.test(wpDdTier.error?.message || "") && !/DanDomain source/i.test(wpDdTier.error?.message || ""),
    "fixture/WP seed + dd-light is an unknown WP tier (USAGE), not a DanDomain route");
}

console.log("— api.seed DanDomain routing (TTY menu uses the same handler) —");
{
  // Isolated config: loadConfig resolves paths.data relative to the config
  // file's parent, so nest it under tmp/config/. Literal SOAP placeholders
  // (not ${VAR}) so a mistaken live call cannot pick up .env credentials.
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shoplift-dd-seed-"));
  fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
  const ddCfgPath = path.join(tmp, "config", "migration.config.json");
  fs.writeFileSync(ddCfgPath, JSON.stringify({
    source: {
      adapter: "dandomain",
      kind: "dandomain",
      baseUrl: "https://shop000000.mywebshop.io",
      dandomain: { username: "dd-selftest-user", password: "dd-selftest-pass", tenant: "shop000000", shopId: "shop000000" }
    },
    shopify: { shop: "test.myshopify.com", adminAccessToken: "test-token", apiVersion: "2026-07" },
    paths: { data: "./data" }
  }));
  const { createApi } = await import("../src/api.js");
  const ddApi = createApi(ddCfgPath);
  try {
    const wpTierOnDd = await ddApi.seed({ tier: "light" });
    ok(wpTierOnDd.ok === false && wpTierOnDd.exit === 2 && /dd-light|dd-real/.test(wpTierOnDd.error?.message || "") && !/no WP write credentials/i.test(wpTierOnDd.error?.message || ""),
      "dandomain source + WP tier 'light' is unknown DD tier (USAGE), never the WP credential gate");
    const wipeOnDd = await ddApi.seed({ tier: "dd-light", wipeFirst: true, confirm: true });
    ok(wipeOnDd.ok === false && /does not implement a source wipe|no source wipe/i.test(wipeOnDd.error?.message || "") && !/no WP write credentials/i.test(wipeOnDd.error?.message || ""),
      "dandomain seed + wipeFirst refuses the DD no-wipe rule, never asks for WP credentials");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("— TTY menu: source-aware export + seed copy —");
{
  const { isDanDomainSource, exportMenuHint, seedMenuHint, seedTiersForMenu, wizardSourceKind, doctorMenuHint } = await import("../src/menu.js");
  const wp = { source: { adapter: "woocommerce", kind: "wordpress", baseUrl: "https://wp.example.com" } };
  const dd = { source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://shop000000.mywebshop.io" } };
  const fixture = { source: { adapter: "fixture", baseUrl: "https://www.example-shop.com" } };

  ok(isDanDomainSource(dd) === true && isDanDomainSource({ source: { kind: "dandomain" } }) === true, "isDanDomainSource is true for adapter or kind");
  ok(isDanDomainSource(wp) === false && isDanDomainSource(fixture) === false && isDanDomainSource(null) === false, "isDanDomainSource is false for wordpress, fixture, and missing config");

  ok(exportMenuHint(wp) === "WordPress → data/raw" && exportMenuHint(fixture) === "WordPress → data/raw" && exportMenuHint(null) === "WordPress → data/raw",
    "export row stays 'WordPress → data/raw' on WP/fixture/no-config");
  ok(exportMenuHint(dd) === "DanDomain → data/raw", "export row is 'DanDomain → data/raw' on a dandomain pair");

  ok(seedMenuHint(wp) === "light/medium/heavy/real on source", "seed row hint stays the WP tier list on a wordpress pair");
  ok(seedMenuHint(dd) === "dd-light/dd-medium/dd-heavy/dd-real/dd-real-xl on source", "seed row hint lists all five DD tiers on a dandomain pair");

  const { TIERS } = await import("../src/seed.js");
  const wpTiers = seedTiersForMenu(wp, TIERS);
  const ddTiers = seedTiersForMenu(dd, TIERS);
  ok(wpTiers === TIERS && wpTiers.light && wpTiers.medium && wpTiers.heavy && wpTiers.real && wpTiers["real-xl"] && !wpTiers["dd-light"],
    "WP seed menu offers light/medium/heavy/real/real-xl, never dd-* (same TIERS object)");
  ok(ddTiers["dd-light"] && ddTiers["dd-medium"] && ddTiers["dd-heavy"] && ddTiers["dd-real"] && ddTiers["dd-real-xl"] && !ddTiers.light && !ddTiers.medium && !ddTiers.heavy && !ddTiers.real && !ddTiers["real-xl"],
    "DanDomain seed menu offers the five dd-* sizes, never WP names");
  ok(/Example/i.test(ddTiers["dd-real"]), "dd-real description names the Example-parity catalogue");

  ok(wizardSourceKind(dd) === "dandomain", "wizard on a dandomain pair collects SOAP (DD_SOAP_*) fields, not WP app-password fields");
  ok(wizardSourceKind(wp) === "wordpress" && wizardSourceKind(fixture) === "wordpress" && wizardSourceKind(null) === "wordpress",
    "wizard on WP/fixture/no-config stays on WordPress fields (bit-identical)");
  ok(doctorMenuHint(dd) === "SOAP · storefront · Shopify" && doctorMenuHint(wp) === "connections · PCD · currency",
    "doctor row hint is source-aware; WP copy is unchanged");
}

console.log("— WP wipe gate: source-side counterpart to the Shopify dev-store gate (invariant #4) —");
{
  // Unit-level: exercise seed.js's wipeWordPress() gate directly with a stub
  // `api` fn (every GET returns []) so wipe loops no-op on the first call —
  // fully offline, no network, no real WP call whatsoever, even when the gate
  // allows through.
  const { wipeWordPress } = await import("../src/seed.js");
  const { classifyError } = await import("../src/util/machine.js");
  const noopApi = async () => [];
  const gatedDir = path.join(ROOT, "test", `tmp-wpgate-gated-${process.pid}`);
  const freshDir = path.join(ROOT, "test", `tmp-wpgate-fresh-${process.pid}`);
  fs.mkdirSync(path.join(gatedDir, "raw"), { recursive: true });
  fs.writeFileSync(path.join(gatedDir, "raw", "summary.json"), "{}");
  fs.mkdirSync(freshDir, { recursive: true }); // no raw/ dir at all -> never exported from
  try {
    let threw = null;
    try { await wipeWordPress({ api: noopApi, cfg: { paths: { raw: path.join(gatedDir, "raw") }, source: { baseUrl: "https://gated.example" } } }); }
    catch (e) { threw = e; }
    ok(threw !== null, "wipeWordPress() throws when data/raw/summary.json exists for the active pair");
    ok(threw && classifyError(threw).code === "WP_WIPE_GATE" && classifyError(threw).exit === 2, "the throw classifies as WP_WIPE_GATE, exit 2 (mirrors WIPE_GATE's shape)");

    const freshSummary = await wipeWordPress({ api: noopApi, cfg: { paths: { raw: path.join(freshDir, "raw") }, source: { baseUrl: "https://fresh.example" } } });
    ok(freshSummary && typeof freshSummary === "object", "wipeWordPress() allows when data/raw/summary.json does NOT exist (never exported from — scratch shop)");

    const overriddenSummary = await wipeWordPress({ api: noopApi, cfg: { paths: { raw: path.join(gatedDir, "raw") }, source: { baseUrl: "https://gated.example", allowDestructive: true } } });
    ok(overriddenSummary && typeof overriddenSummary === "object", "wipeWordPress() allows regardless of raw/summary.json when source.allowDestructive:true (the only override)");

    const noCfgSummary = await wipeWordPress({ api: noopApi });
    ok(noCfgSummary && typeof noCfgSummary === "object", "wipeWordPress() is ungated when called with no cfg (back-compat for callers with no active pair to check)");
  } finally {
    fs.rmSync(gatedDir, { recursive: true, force: true });
    fs.rmSync(freshDir, { recursive: true, force: true });
  }

  // Integration-level: the SAME gate reached through the real api.wipeWordpress
  // / api.seed({wipeFirst}) command paths, against the already-populated
  // data-test/ dir (raw/summary.json was written by run-fixtures.js above in
  // this same process) — proves "gate at the wipeWordPress boundary, not at
  // each call site" actually holds for the shipped call sites, not just a
  // direct unit call. wpApi() needs SOME credential present to get past its
  // own check (api.js:35) and reach the seed.js gate at all — fake creds are
  // fine because the gate throws before wipeWordPress ever issues a real HTTP
  // call (confirmed above: noopApi is never invoked when the gate fires).
  const rawFixture = JSON.parse(fs.readFileSync(CFG, "utf8"));
  const fakeCredsCfgPath = path.join(ROOT, "test", `tmp-wpgate-creds-${process.pid}.config.json`);
  fs.writeFileSync(fakeCredsCfgPath, JSON.stringify({
    ...rawFixture,
    source: { ...rawFixture.source, wpContent: { ...rawFixture.source.wpContent, username: "wpgate-test-user", appPassword: "wpgate-test-pass" } }
  }, null, 2));
  try {
    const { createApi } = await import("../src/api.js");
    const gatedApi = createApi(fakeCredsCfgPath);

    const wipeGated = await gatedApi.wipeWordpress({ confirm: true });
    ok(wipeGated.ok === false && wipeGated.exit === 2 && wipeGated.error?.code === "WP_WIPE_GATE", "api.wipeWordpress({confirm:true}) hits WP_WIPE_GATE through the real command path (data-test/raw/summary.json exists, no allowDestructive)");

    const wipeGatedNoConfirm = await gatedApi.wipeWordpress({});
    ok(wipeGatedNoConfirm.ok === false && wipeGatedNoConfirm.exit === 2 && wipeGatedNoConfirm.error?.code === "CONFIRM_REQUIRED", "confirm gate still fires independently — without confirm:true it's CONFIRM_REQUIRED, not WP_WIPE_GATE (neither gate substitutes for the other)");

    const seedWipeFirstGated = await gatedApi.seed({ tier: "light", wipeFirst: true, confirm: true });
    ok(seedWipeFirstGated.ok === false && seedWipeFirstGated.exit === 2 && seedWipeFirstGated.error?.code === "WP_WIPE_GATE", "api.seed({wipeFirst:true, confirm:true}) also hits WP_WIPE_GATE — the seed.js boundary gates every route, not just wipe_wordpress");
  } finally {
    fs.rmSync(fakeCredsCfgPath, { force: true });
  }

  // DanDomain pair: wipe --wp / wipe_wordpress must refuse with DanDomain in
  // the message (WP_WIPE_GATE), never "no WP write credentials".
  {
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shoplift-dd-wipe-"));
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "data", "raw"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "data", "raw", "summary.json"), "{}");
    const ddWipeCfg = path.join(tmp, "config", "migration.config.json");
    fs.writeFileSync(ddWipeCfg, JSON.stringify({
      source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://shop000000.mywebshop.io", dandomain: { username: "dd-selftest-user", password: "dd-selftest-pass", tenant: "shop000000", shopId: "shop000000" } },
      shopify: { shop: "test.myshopify.com", adminAccessToken: "test-token", apiVersion: "2026-07" },
      paths: { data: "./data" }
    }));
    try {
      let threw = null;
      try { await wipeWordPress({ api: noopApi, cfg: { paths: { raw: path.join(tmp, "data", "raw") }, source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://shop000000.mywebshop.io" } } }); }
      catch (e) { threw = e; }
      ok(threw && /DanDomain/i.test(threw.message) && /wipeWordPress refuses/i.test(threw.message),
        "wipeWordPress() on a dandomain cfg refuses and names DanDomain (summary.json gate is WP-only)");
      ok(threw && classifyError(threw).code === "WP_WIPE_GATE" && classifyError(threw).exit === 2,
        "the DanDomain refuse classifies as WP_WIPE_GATE, exit 2");

      const { createApi } = await import("../src/api.js");
      const ddWipeApi = createApi(ddWipeCfg);
      const wipeDd = await ddWipeApi.wipeWordpress({ confirm: true });
      ok(wipeDd.ok === false && wipeDd.exit === 2 && wipeDd.error?.code === "WP_WIPE_GATE" && /DanDomain/i.test(wipeDd.error?.message || "") && !/no WP write credentials/i.test(wipeDd.error?.message || ""),
        "api.wipeWordpress on a dandomain pair is WP_WIPE_GATE naming DanDomain, never the WP credential gate");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

console.log("— cli --json: envelopes, exit codes, stdout purity —");
{
  const r1 = run(["transform", "--config", CFG, "--json"]);
  ok(r1.code === 0, "transform --json exits 0");
  const env1 = parse(r1.stdout);
  ok(env1.tool === "shoplift" && env1.v === 1 && env1.command === "transform" && env1.ok === true, "envelope header");
  ok(env1.data.counts.products === 7, "envelope carries counts");
  ok(r1.stdout.trim().split("\n").every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), "stdout is pure JSON");

  const r2 = run(["import", "--config", CFG, "--json"]); // fixture config has dryRun: true
  ok(r2.code === 0 && parse(r2.stdout).command === "import", "dry-run import --json exits 0");

  const r3 = run(["status", "--config", CFG, "--json"]);
  ok(r3.code === 0 && parse(r3.stdout).data.transformed.counts.products === 7, "status --json aggregates");

  const r4 = run(["frobnicate", "--json"]);
  ok(r4.code === 2 && parse(r4.stdout).error.code === "USAGE", "unknown stage -> exit 2 + USAGE envelope");

  const help = run(["help"]);
  ok(help.code === 0 && /DanDomain/.test(help.stdout) && /dd-light/.test(help.stdout) && /WordPress or DanDomain/.test(help.stdout),
    "human USAGE names DanDomain, dd-light…dd-real-xl, and a source-aware export line");

  const r5 = run(["status", "--config", path.join(ROOT, "nope.json"), "--json"]);
  ok(r5.code === 2 && parse(r5.stdout).error.code === "CONFIG_MISSING", "bad config -> exit 2 + CONFIG_MISSING");

  const r6 = run(["wipe", "--config", CFG, "--json"]);
  ok(r6.code === 2 && parse(r6.stdout).error.code === "CONFIRM_REQUIRED", "wipe --json without --yes refused");
  ok(parse(r6.stdout).command === "wipe_shopify", "wipe --json reports the Shopify target");

  const r7 = run(["wipe", "--wp", "--config", CFG, "--json"]);
  ok(r7.code === 2 && parse(r7.stdout).command === "wipe_wordpress", "wipe --wp --json reports the WordPress target");
}

console.log("— exit-code coverage: 4 PARTIAL, 5 VERIFY (offline — fetch fully intercepted, no network) —");
{
  // The fixture config hardcodes dryRun:true, and dryRun short-circuits every
  // importer before it touches the network (see import/products.js:31) — so
  // EXIT.PARTIAL is unreachable through the fixture config as-is. We need a
  // sibling config with dryRun:false to reach the real import path, while
  // keeping the run fully offline by replacing global.fetch outright: no
  // socket ever opens, so this is not "the network" in the sense invariant
  // testing cares about — it's a stand-in Shopify at the fetch boundary.
  //
  // Note on the brief's suggested technique for exit 5: pre-writing a
  // verify-report.json (as collectStatus's test above does) does NOT drive
  // api.verify()'s exit code, because api.verify() calls the LIVE runVerify()
  // stage, which unconditionally recomputes and overwrites that file from a
  // fresh Shopify read — a pre-seeded file has zero effect on what it
  // returns. runVerify has no fixture/offline adapter (unlike the WP source
  // side), so the only offline route to a genuine api.verify() call is the
  // same fetch-interception used for PARTIAL below. That's what this block
  // does, and it exercises the real code at api.js:80-86, not a fabricated
  // classifier result.
  const rawFixture = JSON.parse(fs.readFileSync(CFG, "utf8"));
  const tmpCfgPath = path.join(ROOT, "test", `tmp-exitcov-${process.pid}.config.json`);
  const partialDataDir = path.join(ROOT, "data-test-partial");
  fs.writeFileSync(tmpCfgPath, JSON.stringify({
    ...rawFixture,
    options: { ...rawFixture.options, dryRun: false },
    shopify: { ...rawFixture.shopify, primaryLocationId: "gid://shopify/Location/999" }, // avoids the location-lookup network call
    paths: { data: "./data-test-partial" }
  }, null, 2));

  const origFetch = globalThis.fetch;
  try {
    fs.rmSync(partialDataDir, { recursive: true, force: true });
    const { createApi } = await import("../src/api.js");
    const api2 = createApi(tmpCfgPath);

    // export + transform stay on the fixture WP adapter — genuinely offline,
    // no mocking needed (same mechanism run-fixtures.js already proves).
    await api2.export({ entities: ["products"] });
    await api2.transform({ entities: ["products"] });

    // Stand-in Shopify: every productSet call fails, so import produces
    // real per-entity failures; QUERY_COUNTS/QUERY_VARIANT_BY_SKU return
    // numbers consistent with "nothing landed" so only the failure roll-up
    // (not a dirty/stale target) drives verify's ok:false.
    globalThis.fetch = async (_url, opts) => {
      const q = JSON.parse(opts.body).query || "";
      let data = {};
      if (q.includes("mutation productSet")) data = { productSet: { userErrors: [{ field: ["input"], message: "mock: forced import failure" }] } };
      else if (q.includes("productsCount")) data = { productsCount: { count: 0 }, customersCount: { count: 0 }, ordersCount: { count: 0, precision: "EXACT" }, collectionsCount: { count: 0 } };
      else if (q.includes("productVariants")) data = { productVariants: { nodes: [] } };
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const imp = await api2.import({ entities: ["products"] });
    ok(imp.exit === EXIT.PARTIAL && imp.ok === false, "api.import -> EXIT.PARTIAL (4) when an entity has failed > 0, offline (fetch fully mocked)");
    // Transform emits 7 products; HANDLE_COLLISION collapses one duplicate handle to last writer
    // before productSet (WP overwrite semantics), so 6 unique handles are sent and all fail.
    ok(imp.error?.code === "PARTIAL_FAILURES" && imp.data.results.products.failed === 6 && imp.data.results.products.imported === 0, "PARTIAL envelope names the failed count from the real import pipeline");

    const ver = await api2.verify({});
    ok(ver.exit === EXIT.VERIFY && ver.ok === false, "api.verify -> EXIT.VERIFY (5) when the recomputed report is not ok, offline (fetch fully mocked)");
    ok(ver.error?.code === "VERIFY_FAILED" && ver.data.failures.products === 6 && ver.data.ok === false, "VERIFY envelope carries the real failure roll-up (data.failures), not a fabricated verdict");
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(partialDataDir, { recursive: true, force: true });
    fs.rmSync(tmpCfgPath, { force: true });
  }
}

console.log("— exit-code coverage: 3 CONNECT — NOT closed offline (see note) —");
console.log("  CONNECT requires a genuine network failure (DNS/refused/timeout/401/403/etc, classifyError()");
console.log("  in src/util/machine.js:41). classifyError() is already unit-tested above (\"network errors -> CONNECT\"),");
console.log("  and doctor/import/verify already route real connection errors through it (api.js:48-53, 111-126).");
console.log("  Reaching it end-to-end needs either a live network failure or a fake HTTP server — both are out of");
console.log("  scope for an offline suite that must never touch the network; not closing it here is a deliberate");
console.log("  choice, not an oversight.");

// DEFECT-3 (live, 2026-07-28) — wipeWordPress aborted the ENTIRE wipe on the
// first row WooCommerce refused to delete. util/http.js retries 429/5xx and
// network errors but rethrows 4xx, so one bad product killed the loop: it took
// out all orders and coupons, died 38 of 119 products in, and left a live
// source that was neither the old dataset nor a clean slate — then the seed
// that was supposed to run next never started. Driven with a stub `api` so this
// stays offline. Asserts the tolerant path AND that the loop still terminates,
// since "retry until the list is empty" over an undeletable row is an infinite
// loop if the batch-level stop is ever removed.
console.log("— wipeWordPress tolerates per-item delete failures (DEFECT-3) —");
{
  const { wipeWordPress } = await import("../src/seed.js");
  /** @param {Set<number>} undeletable ids whose DELETE always 4xxs */
  const stubApi = (ids, undeletable) => {
    let remaining = [...ids];
    let calls = 0;
    const api = async (method, route) => {
      if (++calls > 500) throw new Error("runaway loop — wipe did not converge");
      if (method === "GET") return route.startsWith("wc/v3/products?") ? remaining.map((id) => ({ id })) : [];
      const id = Number(route.split("/").pop().split("?")[0]);
      if (undeletable.has(id)) { const e = new Error(`HTTP 403 woocommerce_rest_cannot_delete ${id}`); throw e; }
      remaining = remaining.filter((x) => x !== id);
      return { id, deleted: true };
    };
    return { api, remainingAfter: () => remaining };
  };

  {
    const { api, remainingAfter } = stubApi([1, 2, 3, 4], new Set([3]));
    const summary = await wipeWordPress({ api, cfg: null });
    ok(summary.products === 3, `one undeletable row does not abort the wipe — 3 of 4 products deleted (got ${summary.products})`);
    ok(Array.isArray(summary.failures) && summary.failures.length === 1 && summary.failures[0].id === 3, "the skipped row is reported in summary.failures with its id");
    ok(/403|cannot_delete/.test(summary.failures[0].error), "the failure carries the underlying HTTP error, not a generic message");
    ok(remainingAfter().length === 1, "only the undeletable row is left behind");
    ok(summary.customers === 0 && summary.posts === 0 && summary.pages === 0, "later stages (customers, posts, pages) still run — before the fix they were never reached");
  }

  {
    // every row fails -> systemic (auth revoked, host blocking), not bad data.
    // Must stop rather than re-fetch the same undeletable page forever.
    const { api } = stubApi([1, 2, 3], new Set([1, 2, 3]));
    const summary = await wipeWordPress({ api, cfg: null });
    ok(summary.products === 0 && summary.failures.length === 3, "a fully failing batch stops instead of looping (0 deleted, all 3 recorded)");
  }
}

// addProfile is pure (the caller saves), so the whole defaults/validation
// surface can be exercised against a throwaway object — no filesystem at all.
console.log("— addProfile: ${VAR} credential defaults, normalization, validation —");
{
  const { addProfile } = await import("../src/sites.js");
  const reg = { wordpress: {}, shopify: {}, pairs: {}, activePair: null };
  const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  const wp = addProfile(reg, { kind: "wordpress", baseUrl: "shop.example.com/" });
  ok(wp.name === "shop" && wp.created === true, `wordpress name derived from the first hostname label (got "${wp.name}")`);
  ok(wp.profile.baseUrl === "https://shop.example.com", `baseUrl normalized — scheme added, trailing slash dropped (got "${wp.profile.baseUrl}")`);
  ok(wp.profile.adapter === "woocommerce", "adapter defaults to woocommerce");
  ok(wp.profile.consumerKey === "${WC_CONSUMER_KEY}" && wp.profile.consumerSecret === "${WC_CONSUMER_SECRET}" && wp.profile.wpUser === "${WP_APP_USER}" && wp.profile.wpAppPassword === "${WP_APP_PASSWORD}",
    "a wordpress profile given ONLY baseUrl gets all four credential fields as verbatim ${VAR} references — registering a site never requires the agent to hold the real secret");
  ok(reg.wordpress.shop === wp.profile, "the profile is written into the registry object under its derived name");

  const sh = addProfile(reg, { kind: "shopify", shop: "mystore" });
  ok(sh.profile.shop === "mystore.myshopify.com", `a bare shop name is stored as the full myshopify host (got "${sh.profile.shop}")`);
  ok(sh.name === "mystore", `shopify name derived from the shop with .myshopify.com stripped (got "${sh.name}")`);
  ok(addProfile(reg, { kind: "shopify", shop: "other.myshopify.com" }).profile.shop === "other.myshopify.com", "an already-qualified shop is not double-suffixed");
  ok(sh.profile.apiVersion === "2026-07" && sh.profile.clientId === "${SHOPIFY_CLIENT_ID}" && sh.profile.clientSecret === "${SHOPIFY_CLIENT_SECRET}" && sh.profile.adminAccessToken === "",
    "shopify defaults: pinned apiVersion, ${VAR} client creds, empty admin token");

  const dup = thrown(() => addProfile(reg, { kind: "wordpress", baseUrl: "https://shop.example.com" }));
  ok(dup !== null && /already exists/.test(dup.message), "adding an existing name without overwrite throws instead of clobbering");
  ok(dup && classifyError(dup).code === "CONFIG_MISSING" && classifyError(dup).exit === EXIT.USAGE, "that throw classifies as CONFIG_MISSING / exit 2, not a crash");
  const over = addProfile(reg, { kind: "wordpress", baseUrl: "https://shop.example.com", adapter: "edd", overwrite: true });
  ok(over.created === false && reg.wordpress.shop.adapter === "edd", "overwrite:true replaces in place and reports created:false");

  for (const [label, params] of [
    ["wordpress without baseUrl", { kind: "wordpress", name: "nourl" }],
    ["shopify without shop", { kind: "shopify", name: "noshop" }],
    ["unknown field key", { kind: "wordpress", name: "typo", baseUrl: "x.example.com", consumerkey: "oops" }],
    ["unknown kind", { kind: "magento", name: "nope" }]
  ]) {
    const e = thrown(() => addProfile(reg, params));
    ok(e !== null && classifyError(e).exit === EXIT.USAGE && classifyError(e).code === "CONFIG_MISSING", `${label} -> CONFIG_MISSING / exit 2`);
  }
  const typo = thrown(() => addProfile(reg, { kind: "wordpress", name: "typo", baseUrl: "x.example.com", consumerkey: "oops" }));
  ok(/unknown field "consumerkey"/.test(typo.message) && /allowed: /.test(typo.message), "a typo'd credential field is named and the allowed set listed — never silently dropped");

  // DanDomain is a first-class source kind (post-P5 integration parity): the
  // registry accepts it with the same ${VAR}-pointer credential policy as
  // WordPress, and derives what it can rather than asking for everything.
  const ddT = addProfile(reg, { kind: "dandomain", tenant: "shop000000" });
  ok(ddT.name === "shop000000" && ddT.created === true, `dandomain name derived from the tenant (got "${ddT.name}")`);
  ok(ddT.profile.storefrontUrl === "https://shop000000.mywebshop.io", `storefrontUrl derived from the tenant on the STOREFRONT host, never the admin host (R39/R41) (got "${ddT.profile.storefrontUrl}")`);
  ok(ddT.profile.shopId === "shop000000", "shopId defaults to the tenant (the seed/doctor identity gate still verifies it against Solution_GetWebinfo)");
  ok(ddT.profile.username === "${DD_SOAP_USERNAME}" && ddT.profile.password === "${DD_SOAP_PASSWORD}",
    "a dandomain profile given ONLY the tenant gets both SOAP credentials as verbatim ${VAR} references — same policy as wordpress");
  ok(reg.dandomain.shop000000 === ddT.profile, "the profile is written into the registry's dandomain bucket under its derived name");

  const ddU = addProfile(reg, { kind: "dandomain", storefrontUrl: "shop201.mywebshop.io/" });
  ok(ddU.name === "shop201" && ddU.profile.tenant === "shop201", `tenant + name derived from the storefront hostname's first label (got "${ddU.name}"/"${ddU.profile.tenant}")`);
  ok(ddU.profile.storefrontUrl === "https://shop201.mywebshop.io", `storefrontUrl normalized — scheme added, trailing slash dropped (got "${ddU.profile.storefrontUrl}")`);

  for (const [label, params] of [
    ["dandomain without tenant or storefrontUrl", { kind: "dandomain", name: "dd-nothing" }],
    ["dandomain with an unknown field", { kind: "dandomain", tenant: "shop9", endpoint: "oops" }]
  ]) {
    const e = thrown(() => addProfile(reg, params));
    ok(e !== null && classifyError(e).exit === EXIT.USAGE && classifyError(e).code === "CONFIG_MISSING", `${label} -> CONFIG_MISSING / exit 2`);
  }
}

// activatePair writes the runtime config from the example template, so this is
// where a new source kind can silently corrupt the WP path. Two contracts:
// the wordpress output is BYTE-IDENTICAL to the pre-dandomain pin, and the
// dandomain output deep-equals the shape the live shop000000 pair runs on
// (the previously hand-written config, minus allowDestructive — which must
// never be generated). Isolated in a temp root: activatePair resolves the
// example template and writes the config relative to the root it is given.
console.log("— activatePair: generated runtime config (WP byte-pin + dandomain) —");
{
  const { addProfile, activatePair, seedFromCurrentConfig } = await import("../src/sites.js");
  const os = await import("node:os");
  const mkroot = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shoplift-activate-"));
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "config", "migration.config.example.json"), path.join(tmp, "config", "migration.config.example.json"));
    return tmp;
  };
  // key-order-insensitive comparison — equivalence is structural, not textual
  const sorted = (v) => JSON.stringify(v, (k, val) =>
    val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val, 2);

  {
    const tmp = mkroot();
    const sites = { wordpress: {}, shopify: {}, pairs: {}, activePair: null };
    addProfile(sites, { kind: "wordpress", baseUrl: "https://pin.example.com" });
    addProfile(sites, { kind: "shopify", shop: "pin-target" });
    activatePair(tmp, sites, "pin", "pin-target");
    const got = fs.readFileSync(path.join(tmp, "config", "migration.config.json"), "utf8");
    const pin = fs.readFileSync(path.join(ROOT, "fixtures", "sites", "wp-activate.pin.json"), "utf8");
    ok(got === pin, "wordpress->shopify activation output is BYTE-IDENTICAL to the pre-dandomain pin (fixtures/sites/wp-activate.pin.json)");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  {
    const tmp = mkroot();
    const cfgFile = path.join(tmp, "config", "migration.config.json");
    const sites = { wordpress: {}, shopify: {}, pairs: {}, activePair: null };
    addProfile(sites, { kind: "dandomain", tenant: "shop000000" });
    addProfile(sites, { kind: "shopify", shop: "example-store", adminAccessToken: "${SHOPIFY_ADMIN_TOKEN}" });
    const { dataDir } = activatePair(tmp, sites, "shop000000", "example-store");
    const raw = fs.readFileSync(cfgFile, "utf8");
    const got = JSON.parse(raw);
    // the shape the live shop000000 pair ran P5 on (hand-written config),
    // minus source.allowDestructive
    const expected = {
      source: {
        adapter: "dandomain",
        kind: "dandomain",
        baseUrl: "https://shop000000.mywebshop.io",
        dandomain: {
          username: "${DD_SOAP_USERNAME}",
          password: "${DD_SOAP_PASSWORD}",
          tenant: "shop000000",
          shopId: "shop000000",
          pageSize: 100,
          pageBase: "detect",
          skipInactiveCoupons: true,
          weightUnit: "kg",
          storefrontUrl: "https://shop000000.mywebshop.io",
          mediaProbeFile: "pics/product-1.png",
          throttle: { capacity: 1, refillPerSecond: 4 },
          timeoutMs: 60000
        },
        wpContent: { enabled: false }
      },
      shopify: {
        shop: "example-store.myshopify.com",
        clientId: "${SHOPIFY_CLIENT_ID}",
        clientSecret: "${SHOPIFY_CLIENT_SECRET}",
        adminAccessToken: "${SHOPIFY_ADMIN_TOKEN}",
        apiVersion: "2026-07",
        primaryLocationId: "",
        blog: { title: "News", handle: "news" }
      },
      entities: { products: true, collections: true, customers: true, orders: true, discounts: true, pages: true, articles: true, redirects: true },
      options: {
        locale: "da", productStatus: "DRAFT", weightUnit: "KILOGRAMS", trackInventory: true,
        importImagesFrom: "source-url", productsBulkThreshold: 25,
        orders: { markFulfilledWhenComplete: true, importCancelled: false, tag: "dd-import" },
        skipExpiredCoupons: true, stripShortcodes: true, rewriteInternalLinks: true, dryRun: false
      },
      paths: { data: "./data/shop000000__example-store" }
    };
    ok(sorted(got) === sorted(expected), "a dandomain->shopify activation generates the config shape the live shop000000 pair runs on");
    ok(!raw.includes("allowDestructive"), "allowDestructive NEVER appears in a generated config — re-stating it is deliberate friction (wipe gate)");
    ok(!/"\$[A-Za-z]/.test(raw), "example $-annotations are stripped from the generated config (while ${VAR} pointers stay pointers)");
    ok(dataDir === "./data/shop000000__example-store", `the pair keeps its namespaced data dir (got "${dataDir}")`);

    // Re-activating the SAME pair reuses the existing config (manual tweaks to
    // entities/options survive) but REBUILDS the source block — a hand-added
    // allowDestructive must not survive activation (docs/MACHINE-CONTRACT.md: sites_activate
    // regenerates the config and drops it).
    const tweaked = JSON.parse(raw);
    tweaked.source.allowDestructive = true;
    tweaked.entities.orders = false;
    fs.writeFileSync(cfgFile, JSON.stringify(tweaked, null, 2));
    activatePair(tmp, sites, "shop000000", "example-store");
    const re = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    ok(re.source.allowDestructive === undefined, "re-activating the same dandomain pair DROPS a hand-added source.allowDestructive");
    ok(re.entities.orders === false, "…while a manual entities tweak on the same pair survives re-activation, as on the wordpress path");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  {
    // seedFromCurrentConfig imports a hand-written config into an empty
    // registry. Before the dandomain kind existed it read cfg.source.baseUrl
    // unconditionally and would register a DanDomain shop AS A WORDPRESS
    // PROFILE — a wrong-bucket entry that later activates into a woocommerce
    // config against a shop with no /wp-json.
    const tmp = mkroot();
    fs.writeFileSync(path.join(tmp, "config", "migration.config.json"), JSON.stringify({
      source: { adapter: "dandomain", kind: "dandomain", baseUrl: "https://shop000000.mywebshop.io", dandomain: { username: "${DD_SOAP_USERNAME}", password: "${DD_SOAP_PASSWORD}", tenant: "shop000000", shopId: "shop000000" } },
      shopify: { shop: "example-store.myshopify.com" },
      paths: { data: "./data/shop000000__example-store" }
    }, null, 2));
    const sites = { wordpress: {}, shopify: {}, dandomain: {}, pairs: {}, activePair: null };
    const seeded = seedFromCurrentConfig(tmp, sites);
    ok(seeded?.src === "shop000000" && !!sites.dandomain.shop000000 && !sites.wordpress.shop000000,
      "seedFromCurrentConfig registers a dandomain config in the dandomain bucket, never as a wordpress profile");
    ok(sites.dandomain.shop000000?.tenant === "shop000000" && sites.dandomain.shop000000?.username === "${DD_SOAP_USERNAME}",
      "…carrying the tenant and the ${VAR} credential pointers from the config");
    ok(seeded?.tgt === "example-store" && sites.activePair?.source === "shop000000", "…and the pair becomes the registry's active pair");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// api.sitesAdd writes to <PKG_ROOT>/config/sites.json, and paths.js resolves
// PKG_ROOT from its own module location, so a test cannot point it elsewhere.
// Snapshot the exact bytes and restore them in a finally; every test profile is
// named `shoplift-selftest-<pid>-*` so a run killed mid-block leaves an
// obviously disposable entry rather than damaged real state.
console.log("— api.sitesAdd: envelope, exit codes, secret redaction —");
{
  const SITES = path.join(ROOT, "config", "sites.json");
  const before = fs.existsSync(SITES) ? fs.readFileSync(SITES) : null;
  const WP = `shoplift-selftest-${process.pid}-wp`;
  const SH = `shoplift-selftest-${process.pid}-sh`;
  const REAL_SECRET = "shpat-selftest-real-credential-value";
  const { createApi } = await import("../src/api.js");
  const api3 = createApi(CFG);
  try {
    const added = await api3.sitesAdd({ kind: "wordpress", name: WP, baseUrl: "selftest.example.com" });
    ok(added.ok === true && added.exit === 0 && added.command === "sites_add", "sites_add returns an envelope-shaped result");
    ok(added.data.kind === "wordpress" && added.data.name === WP && added.data.created === true, "response names the kind/profile it created");
    ok(added.data.profile.consumerKey === "${WC_CONSUMER_KEY}" && added.data.profile.wpAppPassword === "${WP_APP_PASSWORD}",
      "${VAR} pointers are returned verbatim — they are not secrets, and the agent needs them to tell the human which .env keys to fill in");

    const withSecret = await api3.sitesAdd({ kind: "shopify", name: SH, shop: "selftest-store", adminAccessToken: REAL_SECRET, clientSecret: REAL_SECRET });
    ok(withSecret.ok === true && withSecret.data.profile.adminAccessToken === "<redacted>" && withSecret.data.profile.clientSecret === "<redacted>", "a real (non-${VAR}) credential is masked in the response");
    ok(!JSON.stringify(withSecret).includes(REAL_SECRET), "the raw secret appears NOWHERE in the returned envelope (results land in an LLM context and in the MCP call log)");
    ok(withSecret.data.profile.shop === "selftest-store.myshopify.com" && withSecret.data.profile.apiVersion === "2026-07" && withSecret.data.profile.clientId === "${SHOPIFY_CLIENT_ID}",
      "non-secret fields and untouched ${VAR} pointers still pass through unredacted");
    const onDisk = JSON.parse(fs.readFileSync(SITES, "utf8"));
    ok(onDisk.shopify[SH].adminAccessToken === REAL_SECRET && onDisk.shopify[SH].clientSecret === REAL_SECRET,
      "...while the registry on disk holds the REAL value — redaction is response-only, so the profile stays usable");

    // dandomain through the same surface: envelope, ${VAR} pointers, and the
    // SOAP password (the one new secret-bearing field) redacted when literal.
    const DD = `shoplift-selftest-${process.pid}-dd`;
    const ddAdd = await api3.sitesAdd({ kind: "dandomain", name: DD, tenant: "selftest105698", password: REAL_SECRET });
    ok(ddAdd.ok === true && ddAdd.data.kind === "dandomain" && ddAdd.data.created === true, "sites_add accepts kind dandomain and returns the envelope");
    ok(ddAdd.data.profile.password === "<redacted>" && ddAdd.data.profile.username === "${DD_SOAP_USERNAME}",
      "a literal SOAP password is masked in the response while the ${VAR} username pointer passes through");
    ok(!JSON.stringify(ddAdd).includes(REAL_SECRET), "the raw SOAP password appears NOWHERE in the returned envelope");
    const lst = await api3.sitesList({});
    ok(Array.isArray(lst.data.dandomain) && lst.data.dandomain.includes(DD), "sites_list reports the dandomain bucket alongside wordpress and shopify");

    const dup = await api3.sitesAdd({ kind: "wordpress", name: WP, baseUrl: "selftest.example.com" });
    ok(dup.ok === false && dup.exit === 2 && dup.error.code === "CONFIG_MISSING" && /already exists/.test(dup.error.message), "duplicate profile -> exit 2 CONFIG_MISSING, never a silent overwrite");
    const over = await api3.sitesAdd({ kind: "wordpress", name: WP, baseUrl: "selftest2.example.com", overwrite: true });
    ok(over.ok === true && over.data.created === false && over.data.profile.baseUrl === "https://selftest2.example.com", "overwrite:true succeeds and reports created:false");

    for (const [label, params] of [
      ["wordpress without baseUrl", { kind: "wordpress", name: `${WP}-x` }],
      ["shopify without shop", { kind: "shopify", name: `${SH}-x` }],
      ["unknown field key", { kind: "wordpress", name: `${WP}-x`, baseUrl: "x.example.com", consumerkey: "oops" }],
      ["unknown kind", { kind: "magento", name: `${WP}-x` }]
    ]) {
      const res = await api3.sitesAdd(params);
      ok(res.ok === false && res.exit === 2 && res.error.code === "CONFIG_MISSING", `sites_add: ${label} -> exit 2 CONFIG_MISSING`);
      // CONFIG_MISSING's default hint is about cold start (copy the example
      // config). For a registration problem that is wrong advice, so these
      // errors override it via `_hint`. Found by driving the live MCP tool:
      // the message said "pass overwrite:true" while the hint said "copy
      // migration.config.example.json".
      ok(/sites_list|SETUP\.md step 3/.test(res.error.hint) && !/migration\.config\.example/.test(res.error.hint),
        `sites_add: ${label} -> hint is about registration, not cold start`);
    }

    // A profile name that isn't registered is a USAGE error the caller can fix
    // by looking at sites_list — NOT an UNEXPECTED crash. This previously
    // returned exit 1 with "re-run with --verbose; stages are resumable",
    // which is wrong advice at the step right after sites_add.
    for (const [label, params] of [
      ["unknown source", { source: "no-such-source-xyz", target: "no-such-target-xyz" }],
      ["unknown target", { source: WP, target: "no-such-target-xyz" }]
    ]) {
      const res = await api3.sitesActivate(params);
      ok(res.ok === false && res.exit === 2 && res.error.code === "CONFIG_MISSING", `sites_activate: ${label} -> exit 2 USAGE, not exit 1 CRASH`);
      ok(/Registered (wordpress|shopify) profiles:/.test(res.error.hint), `sites_activate: ${label} -> hint lists the profiles that DO exist`);
    }
  } finally {
    if (before === null) fs.rmSync(SITES, { force: true });
    else fs.writeFileSync(SITES, before);
  }
}


// The live test matrix is ONE source shape: WooCommerce, USD, no extras. Client
// stores run WPML, Subscriptions, gift cards. We cannot test against those
// speculatively (commercial, not installable, each its own data model) — but we
// can read what a store actually runs and say what will be left behind, before
// anyone quotes the job. Invariant 5 applied to the engagement.
console.log("— plugin data-loss scan (pure assessment) —");
{
  const { assessPlugins, KNOWN_LOSSY, UNKNOWN_NOTE } = await import("../src/sources/plugin-risks.js");

  const real = [
    { plugin: "woocommerce/woocommerce", name: "WooCommerce", status: "active" },
    { plugin: "sitepress-multilingual-cms/sitepress.php", name: "WPML", status: "active" },
    { plugin: "woocommerce-subscriptions/woocommerce-subscriptions.php", name: "Subscriptions", status: "active" },
    { plugin: "backup-backup/backup-backup", name: "Backup Migration", status: "active" },
    { plugin: "woocommerce-bookings/bookings.php", name: "Bookings", status: "inactive" }
  ];
  const a = assessPlugins(real);
  ok(a.active === 4, `only ACTIVE plugins are assessed (got ${a.active})`);
  ok(a.risks.length === 2, `WPML and Subscriptions are flagged (got ${a.risks.length})`);
  ok(!a.risks.some((r) => r.dir === "woocommerce"), "WooCommerce itself is not a risk — it is the thing we migrate");
  ok(!a.risks.some((r) => /bookings/.test(r.dir)), "an INACTIVE lossy plugin is not flagged — it holds no live data path");
  ok(a.unrecognised.includes("Backup Migration"), "an unrecognised active plugin is reported as unrecognised, not silently treated as safe");
  ok(a.risks.every((r) => r.loses && r.loses.length > 10), "every risk states WHAT is lost, not just that something is");
  // A clean result must not read as reassurance when most plugins were simply
  // unrecognised — that is 'counts reconciled, spot-checks passed' wearing a hat.
  const mostlyUnknown = assessPlugins([
    { plugin: "woocommerce/woocommerce", name: "WooCommerce", status: "active" },
    { plugin: "weird-plugin-a/a.php", name: "Weird A", status: "active" },
    { plugin: "weird-plugin-b/b.php", name: "Weird B", status: "active" }
  ]);
  ok(mostlyUnknown.risks.length === 0 && mostlyUnknown.unrecognised.length === 2,
    "a store with no KNOWN-lossy plugins still reports how many were unrecognised, so 'clean' cannot be mistaken for 'verified safe'");

  ok(/UNKNOWN, not safe/.test(UNKNOWN_NOTE), "the scan says outright that it is not exhaustive — claiming completeness would be the overclaim this exists to prevent");

  ok(assessPlugins([{ plugin: "x/x.php", name: "Copy &amp; Delete Posts", status: "active" }]).unrecognised[0] === "Copy & Delete Posts",
    "WP's HTML-escaped plugin names are decoded before reaching operator-facing output");
  ok(assessPlugins(null).risks.length === 0 && assessPlugins(undefined).active === 0, "a missing plugin payload assesses to nothing rather than throwing");
  ok(assessPlugins([{ status: "active" }]).unrecognised.length === 1, "a malformed plugin entry still counts as unrecognised rather than crashing the scan");
  ok(new Set(KNOWN_LOSSY.map((k) => k.dir)).size === KNOWN_LOSSY.length, "no duplicate plugin directories in the table (a dupe would double-report)");
  ok(KNOWN_LOSSY.every((k) => k.dir === k.dir.toLowerCase()), "table dirs are lowercase — matching lowercases the plugin dir");

  // the summary an agent reads must surface these; a passing doctor used to end at "N check(s) OK"
  const { formatSummary } = await import("../src/util/mcp-format.js");
  const sum = formatSummary("migration_doctor", { command: "migration_doctor", ok: true, exit: 0, elapsedS: 3,
    data: { ok: true, results: [
      { name: "WordPress REST (/wp-json)", ok: true, detail: 'site: "x"' },
      { name: "WordPress plugins (what will NOT migrate)", ok: true, warn: true, detail: "2 of 4 active plugin(s) hold data that will NOT migrate", risks: a.risks }
    ] } });
  ok(/data-loss warning/.test(sum), "a PASSING doctor still reports data-loss warnings to an agent");
  ok(/WPML/.test(sum) && /Subscriptions/.test(sum), "the summary names the actual plugins, not just a count");
  const clean = formatSummary("migration_doctor", { command: "migration_doctor", ok: true, exit: 0, elapsedS: 3, data: { ok: true, results: [{ name: "a", ok: true }] } });
  ok(!/data-loss warning/.test(clean), "a store with no risky plugins says nothing about data loss");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
