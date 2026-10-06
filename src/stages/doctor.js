import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { createShopifyClient } from "../shopify/client.js";
import { PKG_ROOT } from "../paths.js";
import { c, chip, section } from "../ui.js";
import { log } from "../log.js";
import { readJsonl } from "../util/fsx.js";
import { storefrontOrigin, isAdminHost, productPath, containsItemNumber } from "../dandomain/urls.js";

/**
 * Connection tester — verifies all three legs before any real run:
 *   1. WordPress REST reachable
 *   2. WooCommerce REST auth (consumer key/secret or application password)
 *   3. Shopify Admin API auth (client credentials or legacy token)
 * Exit code 0 only if everything needed for the enabled entities works.
 */
export async function probeStorefrontContainment({ url, sku, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${url} HTTP ${res.status} does not contain item number ${sku} — a 200 is not evidence on this platform (R39). Check the URL grammar for this shop/theme.`);
  }
  if (!containsItemNumber(body, sku)) {
    throw new Error(`${url} HTTP ${res.status} does not contain item number ${sku} — a 200 is not evidence on this platform (R39). Check the URL grammar for this shop/theme.`);
  }
  return `containment ok: ${sku} in ${url}`;
}

export async function runDoctor(cfg) {
  const results = [];
  // A check can return a plain detail string, or `{ warn: true, detail, lines }`.
  // The warn state exists because not every finding is a connection failure: an
  // active WPML install is not something to exit 3 over, but it is not a green
  // tick either. Folding it into `ok` with a footnote would make it exactly the
  // kind of skimmable note that let D15 through, so it renders with a warn chip
  // and stays distinguishable in the envelope (`{ ok: true, warn: true }`).
  const check = async (name, fn) => {
    try {
      const out = await fn();
      const warn = Boolean(out && typeof out === "object" && out.warn);
      const detail = warn ? out.detail : out;
      results.push({ name, ok: true, ...(warn ? { warn: true } : {}), detail, ...(warn && out.risks ? { risks: out.risks } : {}) });
      console.log(`  ${warn ? chip.warn() : chip.ok()} ${c.white(name.padEnd(42))} ${detail ? (warn ? c.yellow(detail) : c.gray(detail)) : ""}`);
      for (const line of (warn && out.lines) || []) console.log(`  ${" ".padEnd(44)}${c.dim(line)}`);
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
      console.log(`  ${chip.fail()} ${c.white(name.padEnd(42))}${c.red(e.message.slice(0, 160))}`);
    }
  };

  console.log(section("doctor"));

  // loadDotEnv never overwrites an existing process.env key (config.js), which
  // is right for letting real env vars win — but it means a LONG-RUNNING
  // process (the MCP server) keeps the first .env it ever read. Rotate
  // credentials and the server silently keeps using the old ones; the symptom
  // is an HTTP 401 that looks exactly like wrong keys. Observed live: a
  // rebuilt test site failed 2/5 through the MCP server while a fresh CLI
  // process passed 5/5 against the same files.
  //
  // Only appears when it is actually true, so a normal run still shows the
  // five connection checks. It fails rather than warns because the statement
  // "this process is not using the credentials on disk" is a real fault: every
  // check below it is testing something other than your current config.
  // The same trap applies to CODE, and it is harder to spot: ESM caches a
  // module on first import, so an MCP server that has already run a stage keeps
  // executing the version it loaded. Observed twice — once with rotated
  // credentials (401s that looked like wrong keys), once with a transform fix
  // that silently did not apply while the offline suite proved it worked.
  // Check both, name whichever is stale.
  const processStarted = Date.now() - process.uptime() * 1000;
  const newest = (p) => {
    try {
      const st = statSync(p);
      if (!st.isDirectory()) return { path: p, at: st.mtimeMs };
      let best = { path: p, at: 0 };
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const hit = newest(path.join(p, e.name));
        if (hit && hit.at > best.at) best = hit;
      }
      return best;
    } catch { return null; }
  };
  const candidates = [newest(path.join(PKG_ROOT, ".env")), newest(path.join(PKG_ROOT, "src"))]
    .filter((c) => c && c.at > processStarted)
    .sort((a, b) => b.at - a.at);
  if (candidates.length) {
    const { path: stalePath, at } = candidates[0];
    await check("process freshness (.env + src/)", async () => {
      throw new Error(`${path.relative(PKG_ROOT, stalePath) || ".env"} changed ${Math.round((Date.now() - at) / 1000)}s after this process started — this process is running STALE ${stalePath.endsWith(".env") ? "credentials" : "code"} (ESM caches modules; dotenv never overwrites). Restart the MCP server, or use the CLI, before trusting anything below.`);
    });
  }

  const base = (cfg.source?.baseUrl || "").replace(/\/$/, "");
  const isDanDomain = cfg.source?.adapter === "dandomain" || cfg.source?.kind === "dandomain";

  if (cfg.source && !isDanDomain) {
    await check("WordPress REST (/wp-json)", async () => {
      if (!base) throw new Error("source.baseUrl not set — run the setup wizard");
      const res = await fetch(`${base}/wp-json/`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.name ? `site: "${data.name}"` : "ok";
    });
  }

  if (cfg.source?.adapter === "woocommerce") {
    await check("WooCommerce REST auth (wc/v3)", async () => {
      const wc = cfg.source.woocommerce || {};
      if (!wc.consumerKey || !wc.consumerSecret) throw new Error("consumer key/secret empty — run the setup wizard");
      const auth = "Basic " + Buffer.from(`${wc.consumerKey}:${wc.consumerSecret}`).toString("base64");
      const res = await fetch(`${base}/wp-json/wc/v3/products?per_page=1`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} — check keys (or WooCommerce not installed?)`);
      // Status 200 is NOT proof this is the WooCommerce API. A parked domain,
      // an expired staging host or a captive portal all answer 200 with an
      // HTML page, and this check used to pass on them — it only read a header
      // and never touched the body, so it reported ok while the neighbouring
      // checks (which call .json()) correctly failed. Observed live: a lapsed
      // TasteWP site serving the vendor's own landing page.
      const body = await res.text();
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { throw new Error(`${base} answered 200 but not JSON — WooCommerce REST is not responding here (site parked, expired, or behind a login/portal?)`); }
      if (!Array.isArray(parsed)) throw new Error("wc/v3/products did not return a list — not the WooCommerce REST API");
      return `products visible: ${res.headers.get("x-wp-total") ?? String(parsed.length)}`;
    });
  }

  // What does this store actually RUN? The live test matrix is one source shape
  // (WooCommerce, USD, no extras). A client store is not that, and a plugin
  // holding subscriptions or gift-card balances is a scoping fact you want
  // before quoting, not a discovery after go-live. Costs one authenticated GET.
  const wpc = cfg.source?.wpContent;
  if (base && wpc?.username && wpc?.appPassword && !isDanDomain) {
    await check("WordPress plugins (what will NOT migrate)", async () => {
      const auth = "Basic " + Buffer.from(`${wpc.username}:${wpc.appPassword}`).toString("base64");
      const res = await fetch(`${base}/wp-json/wp/v2/plugins`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
      // Not an error worth failing on: plugin listing needs a capability the app
      // password may not carry, and every OTHER check still tells the truth.
      if (res.status === 401 || res.status === 403) return "not readable with these credentials (needs an admin application password) — plugin data loss NOT assessed";
      if (!res.ok) throw new Error(`HTTP ${res.status} reading /wp/v2/plugins`);
      const { assessPlugins, UNKNOWN_NOTE } = await import("../sources/plugin-risks.js");
      const { active, risks, unrecognised } = assessPlugins(await res.json());
      // "none known to hold data this tool drops" reads as reassurance, and on a
      // store with 30 exotic plugins it would be reassurance about nothing —
      // the same shape of misleading-but-true as "counts reconciled, spot-checks
      // passed". Say how many were merely UNRECOGNISED.
      if (!risks.length) {
        return unrecognised.length
          ? `${active} active; 0 match a known-lossy rule, ${unrecognised.length} unrecognised (unknown, not verified safe)`
          : `${active} active; all recognised, none lossy`;
      }
      return {
        warn: true,
        detail: `${risks.length} of ${active} active plugin(s) hold data that will NOT migrate`,
        risks,
        lines: [...risks.map((r) => `${r.name}: ${r.loses}`),
          ...(unrecognised.length ? [`unrecognised: ${unrecognised.slice(0, 6).join(", ")}${unrecognised.length > 6 ? ` +${unrecognised.length - 6}` : ""}`] : []),
          UNKNOWN_NOTE]
      };
    });
  }

  // Source-probe registry keyed by kind (PLAN §7). DanDomain probes run before
  // the R39 containment check so a generation/platform failure is named first.
  if (isDanDomain) {
    const { probeDanDomainSource } = await import("./doctor-dandomain.js");
    const dd = cfg.source?.dandomain || {};
    let ddClient = null;
    try {
      const { createClient } = await import("../dandomain/client.js");
      if (dd.username && dd.password) {
        ddClient = createClient({
          username: dd.username,
          password: dd.password,
          ...(dd.endpoint ? { endpoint: dd.endpoint } : {}),
          ...(dd.timeoutMs ? { timeoutMs: dd.timeoutMs } : {}),
        });
      }
    } catch { /* probe builds its own when deps.client absent */ }
    await probeDanDomainSource(cfg, check, {
      client: ddClient || undefined,
      shopifyClient: null,
    });
  }

  if (isDanDomain) {
    await check("DanDomain storefront URL grammar (R39/R41)", async () => {
      const origin = storefrontOrigin(cfg.source?.baseUrl);
      if (!origin) throw new Error("source.baseUrl not set — cannot compose storefront URLs");
      let adminNote = "";
      try {
        const host = new URL(cfg.source.baseUrl.includes("://") ? cfg.source.baseUrl : `https://${cfg.source.baseUrl}`).hostname;
        if (isAdminHost(host)) adminNote = ` (composed on storefront ${origin}; ${host} is admin — R39)`;
      } catch { /* origin already validated */ }
      const rawProducts = cfg.paths?.raw ? path.join(cfg.paths.raw, "products.jsonl") : "";
      if (!rawProducts || !existsSync(rawProducts)) {
        return { warn: true, detail: "no raw/products.jsonl yet — run export, then re-run doctor to confirm a product page CONTAINS the item number (R39: HTTP 200 is not evidence)" };
      }
      const products = readJsonl(rawProducts);
      const p = products.find((x) => {
        const meta = Object.fromEntries((x.meta_data || []).map((m) => [m.key, m.value]));
        return x.sku && x.slug && meta._dd_main_category_id && meta._dd_main_category_slug;
      });
      if (!p) {
        return { warn: true, detail: "no exported product has sku + SeoLink + main category — cannot confirm grammar by containment" };
      }
      const meta = Object.fromEntries((p.meta_data || []).map((m) => [m.key, m.value]));
      const oldPath = productPath({ catId: meta._dd_main_category_id, catSlug: meta._dd_main_category_slug, prodId: p.id, prodSlug: p.slug });
      const url = `${origin}${oldPath}/`;
      await probeStorefrontContainment({ url, sku: p.sku });
      return `containment ok: ${p.sku} in ${oldPath}${adminNote}`;
    });
  }

  let shopifyClient = null;
  if (cfg.shopify) await check("Shopify Admin API auth", async () => {
    const s = cfg.shopify || {};
    if (!s.shop || s.shop.includes("your-store")) throw new Error("shopify.shop not set — run the setup wizard");
    if (!s.adminAccessToken && !(s.clientId && s.clientSecret)) throw new Error("no credentials — set client ID/secret (Dev Dashboard) or legacy token");
    shopifyClient = createShopifyClient(s);
    const data = await shopifyClient.graphql(`{ shop { name currencyCode plan { partnerDevelopment } } }`);
    return `shop: "${data.shop.name}" (${data.shop.currencyCode}${data.shop.plan?.partnerDevelopment ? ", dev store" : ""})`;
  });

  // currency alignment: source orders keep their currency; a mismatch with the
  // Shopify store currency is a launch problem you want to know about NOW
  if (shopifyClient && cfg.source?.adapter === "woocommerce" && cfg.source?.woocommerce?.consumerKey) {
    await check("Currency alignment (Woo vs Shopify)", async () => {
      const wc = cfg.source.woocommerce;
      const auth = "Basic " + Buffer.from(`${wc.consumerKey}:${wc.consumerSecret}`).toString("base64");
      const res = await fetch(`${base}/wp-json/wc/v3/settings/general`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`could not read Woo settings (HTTP ${res.status})`);
      const wooCurrency = (await res.json()).find((s) => s.id === "woocommerce_currency")?.value;
      const shopData = await shopifyClient.graphql(`{ shop { currencyCode } }`);
      const shopCurrency = shopData.shop.currencyCode;
      if (wooCurrency && wooCurrency !== shopCurrency) {
        throw new Error(`source is ${wooCurrency} but the Shopify store is ${shopCurrency} — set the store currency in Shopify admin (Settings → Store details) BEFORE importing; it locks after the first sale`);
      }
      return `both ${shopCurrency}`;
    });
  }

  if (shopifyClient) {
    await check("Protected Customer Data access (needed for customers/orders)", async () => {
      try { await shopifyClient.graphql(`{ customers(first: 1) { nodes { id } } }`); return "granted"; }
      catch (e) {
        if (/not approved to access|ACCESS_DENIED/i.test(e.message)) {
          throw new Error("NOT enabled — Dev Dashboard -> app -> API access -> Protected customer data (+ Name/Address/Email/Phone). Customers/orders import will be blocked until then.");
        }
        throw e;
      }
    });
  }

  // PLAN §7 — gift-card / B2B scope checks only when the matching import flag is on.
  if (isDanDomain && shopifyClient && cfg.options?.importGiftCards) {
    await check("Shopify write_gift_cards scope (flag on)", async () => {
      const data = await shopifyClient.graphql(`{ currentAppInstallation { accessScopes { handle } } }`);
      const scopes = (data.currentAppInstallation?.accessScopes || []).map((s) => s.handle);
      if (!scopes.includes("write_gift_cards")) {
        throw new Error("importGiftCards is on but app lacks write_gift_cards — enable the scope or turn the flag off");
      }
      return "write_gift_cards granted";
    });
  }
  if (isDanDomain && shopifyClient && cfg.options?.importB2bPricing) {
    await check("Shopify B2B / plan (flag on)", async () => {
      const data = await shopifyClient.graphql(`{ shop { name plan { partnerDevelopment shopifyPlus } } }`);
      const plan = data.shop?.plan || {};
      if (!plan.shopifyPlus && !plan.partnerDevelopment) {
        return { warn: true, detail: "importB2bPricing is on but shop plan may lack B2B catalogs — verify Plus/B2B before import" };
      }
      return `B2B flag on · plan ok (${data.shop?.name})`;
    });
  }

  const failed = results.filter((r) => !r.ok);
  const warned = results.filter((r) => r.ok && r.warn);
  // Warnings do NOT affect ok/exit: they are scoping facts, not broken plumbing.
  // But "all connections OK" alone would bury them, so the verdict names them.
  const warnNote = warned.length ? ` ${c.yellow(`(+${warned.length} data-loss warning(s) — see above)`)}` : "";
  console.log(failed.length
    ? `\n  ${chip.warn()} ${c.yellow(`doctor: ${failed.length} problem(s) found`)}${warnNote}`
    : `\n  ${chip.ok()} ${c.green("doctor: all connections OK")}${warnNote}`);
  return { ok: failed.length === 0, results };
}
