/**
 * P4 — DanDomain doctor: generation guard, F21 profile, R14 media, R21 caveat.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  probeDanDomainSource,
  deriveDanDomainProfile,
  verifyMediaBase,
  CLASSIC_WEBAPI_FINGERPRINT,
} from "../src/stages/doctor-dandomain.js";

function mockSoap(handlers) {
  const calls = [];
  return {
    calls,
    async call(op, args) {
      calls.push({ op, args });
      if (handlers[op]) return handlers[op](args);
      throw new Error(`unexpected op ${op}`);
    },
  };
}

describe("deriveDanDomainProfile (F21)", () => {
  test("derives config from census payloads", () => {
    const profile = deriveDanDomainProfile({
      webinfo: { SolutionId: "105698", ProductPricesWithVat: "true", ShowProductPricesWithVat: "true" },
      languages: [{ LanguageISO: "DK", Primary: "true", Title: "Dansk" }, { LanguageISO: "EN", Primary: "false" }],
      sites: [{ Id: "1", Title: "Main" }],
      currencies: [{ Id: "1", Iso: "DKK", Decimal: ",", Point: ".", DecimalCount: "2" }],
      vatGroups: [{ Id: "1", Name: "25", VatPercentage: "25" }],
      statuses: [{ Id: "0", Title: "Kladde" }, { Id: "42", Title: "Custom" }],
      payments: [{ Id: "1", Title: "Invoice" }],
      deliveries: [{ Id: "2", Title: "Post" }],
      countries: [{ Id: "45", Iso: "DK", Primary: "true" }],
      units: [{ Id: "1", Title: "stk" }],
      userGroups: [{ Id: "7", Title: "B2B" }],
      modules: { blog: "true", giftcard: "false" },
    });
    assert.equal(profile.solutionId, "105698");
    assert.equal(profile.generation, "hostedshop (modern)");
    assert.equal(profile.vatBasis, "INCLUSIVE");
    assert.equal(profile.multiLanguage, true);
    assert.equal(profile.currency, "DKK");
    assert.equal(profile.b2bPricingInPlay, true);
    assert.deepEqual(profile.modulesReporting, ["blog"]);
    assert.equal(profile.customOrderStatuses.length, 1);
  });
});

describe("verifyMediaBase (R14/R32)", () => {
  test("sends WSDL ImagePath args, not FileName (R17 / probe imgurl)", async () => {
    const calls = [];
    const client = {
      async call(op, args = {}) {
        calls.push({ op, args: { ...args } });
        if (args.FileName != null || args.ImagePath == null) {
          throw new Error(
            'Solution_CreateThumb: unknown argument name(s) ["FileName"]; missing required argument(s) ["ImagePath","ThumbWidth","ThumbHeight","Crop","Greyscale","Watermark"]',
          );
        }
        return { result: `/upload_dir/pics/${String(args.ImagePath).replace(/^pics\//, "")}` };
      },
    };
    const detail = await verifyMediaBase(client, { probeFile: "pics/product-1.png" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, "Solution_CreateThumb");
    assert.equal(calls[0].args.ImagePath, "pics/product-1.png");
    assert.equal(calls[0].args.FileName, undefined);
    assert.equal(calls[0].args.ThumbWidth, 60);
    assert.equal(calls[0].args.ThumbHeight, 60);
    assert.equal(calls[0].args.Crop, false);
    assert.equal(calls[0].args.Greyscale, false);
    assert.equal(calls[0].args.Watermark, false);
    assert.match(detail, /media base ok/i);
  });

  test("blank.gif is a hard failure", async () => {
    const client = mockSoap({
      Solution_CreateThumb: () => ({ result: "/_design/common/img/blank.gif" }),
    });
    await assert.rejects(
      () => verifyMediaBase(client, { probeFile: "pics/seed-probe.jpg" }),
      /blank\.gif/i,
    );
  });

  test("non-blank thumb path passes", async () => {
    const client = mockSoap({
      Solution_CreateThumb: () => ({ result: "/upload_dir/_thumbs/pics/seed-probe.jpg" }),
    });
    const detail = await verifyMediaBase(client, { probeFile: "pics/seed-probe.jpg" });
    assert.match(detail, /_thumbs|ok/i);
  });
});

describe("probeDanDomainSource", () => {
  test("generation guard: Connect is not sent without Username and Password", async () => {
    const results = [];
    const check = async (name, fn) => {
      try {
        const out = await fn();
        results.push({ name, ok: true, detail: typeof out === "object" ? out.detail : out, warn: out?.warn });
      } catch (e) {
        results.push({ name, ok: false, detail: e.message });
      }
    };
    const calls = [];
    const client = {
      async call(op, args = {}) {
        calls.push({ op, args: args && typeof args === "object" ? { ...args } : args });
        if (op === "Solution_Connect") {
          if (!args?.Username || !args?.Password) {
            throw new Error(
              'Solution_Connect: missing required argument(s) ["Username","Password"]; declared arguments are ["Username","Password"]. Unknown names are DROPPED in flight — a NAME error, not a transient (R17/R27). No request was sent.',
            );
          }
          return { result: true };
        }
        if (op === "Solution_GetWebinfo") return { result: { SolutionId: "shop000000", ProductPricesWithVat: "true" } };
        if (op === "Solution_GetLanguages") return { result: [{ LanguageISO: "DK", Primary: "true" }] };
        if (op === "Sites_GetAll") return { result: [] };
        if (op === "Currency_GetAll") return { result: [{ Iso: "DKK" }] };
        if (op === "VatGroup_GetAll") return { result: [] };
        if (op === "OrderStatusCode_GetAll") return { result: [] };
        if (op === "Payment_GetAll") return { result: [] };
        if (op === "Delivery_GetAll") return { result: [] };
        if (op === "Product_GetDeliveryCountryAll") return { result: [] };
        if (op === "Product_GetUnitAll") return { result: [] };
        if (op === "User_GetGroupAll") return { result: [] };
        if (op === "Solution_HasModule") return { result: "false" };
        if (op === "Solution_CreateThumb") return { result: "/ok.jpg" };
        throw new Error(`unexpected op ${op}`);
      },
    };
    const cfg = {
      source: {
        kind: "dandomain",
        dandomain: { shopId: "shop000000", username: "api-user", password: "secret" },
        baseUrl: "https://shop000000.mywebshop.io",
      },
      options: {},
    };
    await probeDanDomainSource(cfg, check, { client, fetchImpl: async () => new Response("ok", { status: 200 }) });
    const gen = results.find((r) => /generation/i.test(r.name));
    assert.equal(gen?.ok, true, gen?.detail);
    const connect = calls.find((c) => c.op === "Solution_Connect");
    assert.ok(connect, "generation guard must invoke Solution_Connect");
    assert.equal(connect.args?.Username, "api-user");
    assert.equal(connect.args?.Password, "secret");
  });

  test("generation guard: Connect success = modern", async () => {
    const results = [];
    const check = async (name, fn) => {
      try {
        const out = await fn();
        results.push({ name, ok: true, detail: typeof out === "object" ? out.detail : out, warn: out?.warn });
      } catch (e) {
        results.push({ name, ok: false, detail: e.message });
      }
    };
    const client = mockSoap({
      Solution_Connect: () => ({ result: true }),
      Solution_GetWebinfo: () => ({
        result: { SolutionId: "105698", ProductPricesWithVat: "true", ShowProductPricesWithVat: "true" },
      }),
      Solution_GetLanguages: () => ({ result: [{ LanguageISO: "DK", Primary: "true" }] }),
      Sites_GetAll: () => ({ result: [{ Id: "1" }] }),
      Currency_GetAll: () => ({ result: [{ Id: "1", Iso: "DKK" }] }),
      VatGroup_GetAll: () => ({ result: [{ Id: "1", VatPercentage: "25" }] }),
      OrderStatusCode_GetAll: () => ({ result: [{ Id: "0", Title: "Kladde" }] }),
      Payment_GetAll: () => ({ result: [] }),
      Delivery_GetAll: () => ({ result: [] }),
      Product_GetDeliveryCountryAll: () => ({ result: [] }),
      Product_GetUnitAll: () => ({ result: [] }),
      User_GetGroupAll: () => ({ result: [] }),
      Solution_HasModule: ({ module }) => ({ result: module === "blog" ? "true" : "false" }),
      Solution_CreateThumb: () => ({ result: "/upload_dir/_thumbs/x.jpg" }),
    });
    const cfg = {
      source: { kind: "dandomain", dandomain: { shopId: "105698", tenant: "shop000000" }, baseUrl: "https://shop000000.webshop.dandomain.dk" },
      options: {},
      paths: {},
    };
    const out = await probeDanDomainSource(cfg, check, { client, fetchImpl: async () => new Response("ok", { status: 200 }) });
    const gen = results.find((r) => /generation/i.test(r.name));
    assert.equal(gen?.ok, true);
    assert.match(gen.detail, /modern|hostedshop/i);
    assert.ok(out.profile?.solutionId === "105698");
    const caveat = results.find((r) => /read-only|R21|caveat/i.test(r.name));
    assert.equal(caveat?.ok, true);
    assert.equal(caveat?.warn, true);
    assert.match(caveat.detail, /_thumbs|placeholders|not read-only/i);
  });

  test("generation guard: Connect failure probes classic WEBAPI and names platform", async () => {
    const results = [];
    const check = async (name, fn) => {
      try {
        const out = await fn();
        results.push({ name, ok: true, detail: typeof out === "object" ? out.detail : out, warn: out?.warn });
      } catch (e) {
        results.push({ name, ok: false, detail: e.message });
      }
    };
    const client = mockSoap({
      Solution_Connect: () => { throw new Error("AUTH failed"); },
    });
    let classicHit = false;
    const fetchImpl = async (url) => {
      if (String(url).includes("WEBAPI") || String(url).includes("webapi")) {
        classicHit = true;
        return new Response(CLASSIC_WEBAPI_FINGERPRINT, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };
    const cfg = {
      source: {
        kind: "dandomain",
        baseUrl: "https://old.example.dk",
        dandomain: { endpoint: "https://old.example.dk/admin/webapi/endpoints/v1_1/ProductService.asmx" },
      },
      options: {},
    };
    await probeDanDomainSource(cfg, check, { client, fetchImpl });
    const gen = results.find((r) => /generation/i.test(r.name));
    assert.equal(gen?.ok, false);
    assert.match(gen.detail, /classic|WS8|WEBAPI/i);
    assert.equal(classicHit, true);
  });

  test("Shopify gift-card / B2B scope checks only when flags on", async () => {
    const results = [];
    const check = async (name, fn) => {
      try {
        const out = await fn();
        results.push({ name, ok: true, detail: typeof out === "object" ? out.detail : out });
      } catch (e) {
        results.push({ name, ok: false, detail: e.message });
      }
    };
    const client = mockSoap({
      Solution_Connect: () => ({ result: true }),
      Solution_GetWebinfo: () => ({ result: { SolutionId: "1", ProductPricesWithVat: "true" } }),
      Solution_GetLanguages: () => ({ result: [] }),
      Sites_GetAll: () => ({ result: [] }),
      Currency_GetAll: () => ({ result: [{ Iso: "DKK" }] }),
      VatGroup_GetAll: () => ({ result: [] }),
      OrderStatusCode_GetAll: () => ({ result: [] }),
      Payment_GetAll: () => ({ result: [] }),
      Delivery_GetAll: () => ({ result: [] }),
      Product_GetDeliveryCountryAll: () => ({ result: [] }),
      Product_GetUnitAll: () => ({ result: [] }),
      User_GetGroupAll: () => ({ result: [] }),
      Solution_HasModule: () => ({ result: "false" }),
      Solution_CreateThumb: () => ({ result: "/ok.jpg" }),
    });
    const shopify = {
      async graphql(q) {
        if (q.includes("appInstallation") || q.includes("accessScopes")) {
          return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }] } };
        }
        if (q.includes("shop {")) return { shop: { name: "t", plan: { partnerDevelopment: true, shopifyPlus: false } } };
        return {};
      },
    };
    const cfgOff = {
      source: { kind: "dandomain", dandomain: { shopId: "1" }, baseUrl: "https://x.webshop.dandomain.dk" },
      options: { importGiftCards: false, importB2bPricing: false },
    };
    await probeDanDomainSource(cfgOff, check, { client, shopifyClient: shopify });
    assert.equal(results.some((r) => /gift.?card.?scope|write_gift_cards/i.test(r.name)), false);
    assert.equal(results.some((r) => /B2B|b2b/i.test(r.name)), false);

    results.length = 0;
    const cfgOn = {
      ...cfgOff,
      options: { importGiftCards: true, importB2bPricing: true },
    };
    await probeDanDomainSource(cfgOn, check, { client, shopifyClient: shopify });
    const gc = results.find((r) => /gift.?card|write_gift_cards/i.test(r.name));
    assert.ok(gc);
    assert.equal(gc.ok, false);
    const b2b = results.find((r) => /B2B|b2b/i.test(r.name));
    assert.ok(b2b);
  });
});
