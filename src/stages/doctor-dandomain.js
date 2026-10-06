/**
 * DanDomain doctor probes (P4 / PLAN §7) — generation guard, F21 profile,
 * R14/R32 media base, R21 read-only caveat. R39 containment stays in doctor.js.
 */
export const CLASSIC_WEBAPI_FINGERPRINT = "ProductService.asmx";

const STOCK_STATUS_IDS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "99", "100"]);

function s(v) {
  return v == null ? "" : String(v).trim();
}
function arr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object" && v.item != null) return Array.isArray(v.item) ? v.item : [v.item];
  return [v];
}
function bool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** F21 — derive operator-facing profile from census payloads (no live calls). */
export function deriveDanDomainProfile(census) {
  const webinfo = census.webinfo || {};
  const languages = arr(census.languages);
  const currencies = arr(census.currencies);
  const statuses = arr(census.statuses);
  const userGroups = arr(census.userGroups);
  const modules = census.modules || {};
  const primary = languages.find((l) => bool(l.Primary)) || languages[0];
  const customOrderStatuses = statuses.filter((st) => !STOCK_STATUS_IDS.has(s(st.Id)));
  const modulesReporting = Object.entries(modules)
    .filter(([, v]) => bool(v) || v === "true")
    .map(([k]) => k);
  return {
    solutionId: s(webinfo.SolutionId) || null,
    generation: "hostedshop (modern)",
    vatBasis: bool(webinfo.ProductPricesWithVat) ? "INCLUSIVE" : "EXCLUSIVE",
    multiLanguage: languages.length > 1,
    primaryLanguage: s(primary?.LanguageISO) || null,
    currency: currencies.length === 1 ? s(currencies[0].Iso) : null,
    b2bPricingInPlay: userGroups.length > 0,
    modulesReporting,
    customOrderStatuses: customOrderStatuses.map((st) => ({ id: s(st.Id), title: s(st.Title) })),
    sites: arr(census.sites).length,
    vatGroups: arr(census.vatGroups).length,
    payments: arr(census.payments).length,
    deliveries: arr(census.deliveries).length,
    countries: arr(census.countries).length,
    units: arr(census.units).length,
  };
}

/**
 * R14/R32 — Solution_CreateThumb(ImagePath, …); blank.gif is a hard failure.
 * Argument names are the WSDL / recorded probe (`imgurl` / gapsw), never FileName (R17).
 */
export async function verifyMediaBase(client, { probeFile = "pics/product-1.png" } = {}) {
  const res = await client.call("Solution_CreateThumb", {
    ImagePath: probeFile,
    ThumbWidth: 60,
    ThumbHeight: 60,
    Crop: false,
    Greyscale: false,
    Watermark: false,
  });
  const path = s(res?.result ?? res);
  if (/\/_design\/common\/img\/blank\.gif/i.test(path)) {
    throw new Error(
      `media base verification failed: Solution_CreateThumb returned blank.gif (${path}). ` +
        `Wrong upload_dir prefix — hard failure (R14/R32), not a miss.`
    );
  }
  return `media base ok: ${path}`;
}

async function probeClassicWebapi(baseUrl, fetchImpl) {
  const roots = [
    `${String(baseUrl || "").replace(/\/$/, "")}/admin/webapi/endpoints/v1_1/ProductService.asmx`,
    `${String(baseUrl || "").replace(/\/$/, "")}/WEBAPI/`,
  ];
  for (const url of roots) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
      const body = await res.text();
      if (res.ok && body.includes(CLASSIC_WEBAPI_FINGERPRINT)) {
        return { classic: true, url, bodySnippet: body.slice(0, 80) };
      }
      if (body.includes(CLASSIC_WEBAPI_FINGERPRINT)) {
        return { classic: true, url, bodySnippet: body.slice(0, 80) };
      }
    } catch {
      /* try next */
    }
  }
  return { classic: false };
}

/**
 * Full DanDomain source probe registry entry.
 * @param {object} cfg
 * @param {Function} check — doctor check(name, fn)
 * @param {{ client, fetchImpl?, shopifyClient? }} deps
 */
export async function probeDanDomainSource(cfg, check, deps = {}) {
  const { client, fetchImpl = globalThis.fetch, shopifyClient = null } = deps;
  const dd = cfg.source?.dandomain || {};
  let profile = null;
  let modern = false;

  await check("DanDomain generation guard", async () => {
    try {
      // Same login the export adapter uses (`client.connect()`). A bare
      // `call("Solution_Connect")` omits Username/Password; validateArgs
      // refuses before any request (live P5 doctor, 2026-08-17). Test
      // doubles that only stub `call` get the same two args `connect()` sends.
      if (typeof client.connect === "function") await client.connect();
      else await client.call("Solution_Connect", { Username: dd.username, Password: dd.password });
      modern = true;
      return "hostedshop (modern) — Solution_Connect ok";
    } catch (e) {
      const classic = await probeClassicWebapi(cfg.source?.baseUrl || dd.endpoint, fetchImpl);
      if (classic.classic) {
        throw new Error(
          `classic WS8 / WEBAPI fingerprint at ${classic.url} — this is NOT Hostedshop modern. ` +
            `Do not migrate with the DanDomain SOAP adapter. Connect failed: ${e.message}`
        );
      }
      throw new Error(
        `Solution_Connect failed (${e.message}) and no classic WEBAPI fingerprint found — ` +
          `cannot name the platform generation. Fix credentials or endpoint.`
      );
    }
  });

  if (modern) {
    const census = {
      webinfo: {},
      languages: [],
      sites: [],
      currencies: [],
      vatGroups: [],
      statuses: [],
      payments: [],
      deliveries: [],
      countries: [],
      units: [],
      userGroups: [],
      modules: {},
    };

    await check("DanDomain F21 profile auto-config", async () => {
      census.webinfo = (await client.call("Solution_GetWebinfo")).result || {};
      census.languages = arr((await client.call("Solution_GetLanguages")).result);
      try { census.sites = arr((await client.call("Sites_GetAll")).result); } catch { /* optional */ }
      census.currencies = arr((await client.call("Currency_GetAll")).result);
      census.vatGroups = arr((await client.call("VatGroup_GetAll")).result);
      census.statuses = arr((await client.call("OrderStatusCode_GetAll")).result);
      census.payments = arr((await client.call("Payment_GetAll")).result);
      census.deliveries = arr((await client.call("Delivery_GetAll")).result);
      try { census.countries = arr((await client.call("Product_GetDeliveryCountryAll")).result); } catch { /* */ }
      try { census.units = arr((await client.call("Product_GetUnitAll")).result); } catch { /* */ }
      census.userGroups = arr((await client.call("User_GetGroupAll")).result);
      for (const mod of ["blog", "giftcard", "news"]) {
        try {
          const r = await client.call("Solution_HasModule", { module: mod });
          census.modules[mod] = r?.result;
        } catch {
          census.modules[mod] = false;
        }
      }
      profile = deriveDanDomainProfile(census);
      if (dd.shopId && s(census.webinfo.SolutionId) && s(dd.shopId) !== s(census.webinfo.SolutionId)) {
        throw new Error(
          `shop id mismatch: config ${dd.shopId} vs Solution_GetWebinfo ${census.webinfo.SolutionId}`
        );
      }
      return `solution ${profile.solutionId} · ${profile.vatBasis} · ${profile.currency || "currency?"} · langs ${census.languages.length}`;
    });

    await check("DanDomain media base (R14/R32)", async () => {
      const file = dd.mediaProbeFile || "pics/product-1.png";
      return verifyMediaBase(client, { probeFile: file });
    });

    await check("DanDomain export read-only caveat (R21)", async () => {
      return {
        warn: true,
        detail:
          "export is NOT read-only: storefront fetches and doctor media checks generate _thumbs/ and placeholders/ in the FTP-visible archive — benign, self-regenerating, do not delete (R21)",
      };
    });
  }

  const flags = cfg.options || {};
  if (flags.importGiftCards && shopifyClient) {
    await check("Shopify write_gift_cards scope", async () => {
      const data = await shopifyClient.graphql(`{ currentAppInstallation { accessScopes { handle } } }`);
      const scopes = (data?.currentAppInstallation?.accessScopes || []).map((x) => x.handle);
      if (!scopes.includes("write_gift_cards")) {
        throw new Error("importGiftCards is on but app lacks write_gift_cards scope");
      }
      return "write_gift_cards present";
    });
  }
  if (flags.importB2bPricing && shopifyClient) {
    await check("Shopify B2B plan capability", async () => {
      const data = await shopifyClient.graphql(`{ shop { name plan { partnerDevelopment shopifyPlus } } }`);
      const plan = data?.shop?.plan || {};
      if (!plan.shopifyPlus && !plan.partnerDevelopment) {
        throw new Error("importB2bPricing is on but shop plan does not look B2B-capable (no Plus)");
      }
      // Dev stores often partnerDevelopment without Plus — warn rather than hard-fail when Plus missing
      if (!plan.shopifyPlus) {
        return { warn: true, detail: "B2B catalogs usually need Plus; partnerDevelopment store — verify before go-live" };
      }
      return "Plus plan ok for B2B";
    });
  }

  return { profile, modern };
}
