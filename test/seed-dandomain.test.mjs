/**
 * P4 — DanDomain seed gates + idempotent upsert markers (mock SOAP).
 * Live shop000000 idempotency is the parent's job.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DD_TIERS,
  STANDALONE_DD_TIERS,
  FORBIDDEN_SEED_OPS,
  assertSeedGates,
  seedDanDomain,
  resetDanDomainSentinels,
  isScratchDanDomainShopId,
  SENTINEL,
} from "../src/seed-dandomain.js";

function mockClient(webinfo = { SolutionId: "105698" }, opts = {}) {
  const calls = [];
  const products = new Map();
  const users = new Map();
  const ordersByRef = new Map();
  const variantTypes = new Map();
  const variantValues = new Map();
  const pictures = new Map();
  const productMeta = new Map();
  const discounts = new Map();
  const categories = new Map();
  const pagesByLink = new Map();
  const groups = new Map();
  const productDiscounts = new Map();
  const productRows = new Map();
  const extraBuyCats = new Map();
  const extraBuyRels = [];
  const deliveryTimes = new Map();
  const additionalTypes = opts.additionalTypes ?? [];
  let nextId = 100;
  for (const p of opts.inventory?.products || []) {
    const id = Number(p.Id);
    productRows.set(id, { ...p, Id: String(p.Id) });
    if (p.ItemNumber) products.set(p.ItemNumber, id);
  }
  for (const d of opts.inventory?.discounts || []) {
    discounts.set(d.Code, { ...d, Id: Number(d.Id) });
  }
  for (const pg of opts.inventory?.pages || []) {
    pagesByLink.set(pg.Link, { ...pg, Id: String(pg.Id) });
  }
  for (const u of opts.inventory?.users || []) {
    users.set(u.Username, Number(u.Id));
  }
  for (const g of opts.inventory?.groups || []) {
    groups.set(Number(g.Id), g.Title);
  }
  for (const c of opts.inventory?.extraBuyCats || []) {
    extraBuyCats.set(Number(c.Id), { ...c, Id: Number(c.Id) });
  }
  for (const r of opts.inventory?.extraBuyRels || []) {
    extraBuyRels.push({ ...r, Id: Number(r.Id) });
  }
  for (const d of opts.inventory?.deliveryTimes || []) {
    deliveryTimes.set(Number(d.Id), { ...d, Id: Number(d.Id) });
  }
  for (const o of opts.inventory?.orders || []) {
    ordersByRef.set(o.ReferenceNumber, Number(o.Id));
  }
  for (const c of opts.inventory?.categories || []) {
    categories.set(c.Title, Number(c.Id));
  }
  const client = {
    calls,
    products,
    users,
    ordersByRef,
    categories,
    ftpOptions: null,
    languages: [{ LanguageISO: "DK" }],
    async call(op, args = {}) {
      calls.push({ op, args });
      if (FORBIDDEN_SEED_OPS.includes(op)) {
        throw new Error(`FORBIDDEN seed op invoked: ${op}`);
      }
      if (op === "Solution_Connect") return { result: true };
      if (op === "Solution_GetWebinfo") return { result: webinfo };
      if (op === "Solution_GetLanguages") {
        return { result: client.languages ?? [{ LanguageISO: "DK" }] };
      }
      if (op === "Solution_SetLanguage") return { result: true };
      if (op === "Currency_GetAll") return { result: [{ Id: "1", Iso: "DKK" }] };
      if (op === "Payment_GetAll") return { result: [{ Id: "10", Title: "Invoice" }] };
      if (op === "Delivery_GetAll") return { result: [{ Id: "20", Title: "Post" }] };
      if (op === "VatGroup_GetAll") {
        return { result: [{ Id: "1", Name: "25%", VatPercentage: "25" }, { Id: "2", Name: "0%", VatPercentage: "0" }] };
      }
      if (op === "Product_GetDeliveryCountryAll") {
        return { result: [{ Id: "45", Iso: "DK", Primary: "true" }] };
      }
      if (op === "OrderStatusCode_GetAll") {
        return { result: [{ Id: "0", Title: "Kladde" }, { Id: "2", Title: "Behandlet" }, { Id: "3", Title: "Afsendt" }] };
      }
      if (op === "Category_CreateOrUpdate") {
        const title = args.CategoryData?.Title;
        if (!categories.has(title)) categories.set(title, ++nextId);
        return { result: categories.get(title) };
      }
      if (op === "Category_GetAll") {
        const rows = [...categories.entries()].map(([Title, Id]) => ({ Id: String(Id), Title }));
        return { result: rows.length ? rows : [{ Id: "50", Title: "Bolig" }] };
      }
      if (op === "Product_CreateOrUpdate") {
        const item = args.ProductData?.ItemNumber;
        if (!products.has(item)) products.set(item, ++nextId);
        return { result: products.get(item) };
      }
      if (op === "Product_CreateOrUpdateVariant") {
        const item = args.VariantData?.ItemNumber;
        if (opts.faultYarnVariants && String(item || "").includes("XL-YARN-")) {
          throw new Error("CONSTRUCTED: Hostedshop variant cap");
        }
        if (!products.has(item)) products.set(item, ++nextId);
        return { result: products.get(item) };
      }
      if (op === "Product_GetVariantTypeAll") {
        return { result: [{ Id: "1", Title: "Size" }, ...[...variantTypes.entries()].map(([title, id]) => ({ Id: String(id), Title: title }))] };
      }
      if (op === "Product_CreateOrUpdateVariantType") {
        const title = args.VariantTypeData?.Title;
        if (!variantTypes.has(title)) variantTypes.set(title, ++nextId);
        return { result: variantTypes.get(title) };
      }
      if (op === "Product_CreateOrUpdateVariantTypeValue") {
        const key = `${args.VariantTypeValueData?.ProductVariantTypeId}:${args.VariantTypeValueData?.Title}`;
        if (!variantValues.has(key)) variantValues.set(key, ++nextId);
        return { result: variantValues.get(key) };
      }
      if (op === "Product_GetVariantTypeValuesByType") {
        const typeId = String(args.VariantTypeId);
        const created = [...variantValues.entries()]
          .filter(([k]) => k.startsWith(`${typeId}:`))
          .map(([k, id]) => ({ Id: String(id), Title: k.split(":")[1], ProductVariantTypeId: typeId }));
        if (created.length) return { result: created };
        if (typeId === "1") return { result: [{ Id: "4", Title: "S" }] };
        return { result: [] };
      }
      if (op === "Product_GetPictures") {
        return { result: pictures.get(Number(args.ProductId)) || [] };
      }
      if (op === "Product_CreatePicture") {
        const pid = Number(args.PictureData?.ProductId);
        const id = ++nextId;
        const row = { Id: String(id), FileName: args.PictureData?.FileName, Sorting: args.PictureData?.Sorting };
        pictures.set(pid, [...(pictures.get(pid) || []), row]);
        return { result: id };
      }
      if (op === "Product_UpdateVariant") {
        return { result: [args.VariantData?.Id || products.get(args.VariantData?.ItemNumber) || 0] };
      }
      if (op === "Product_Update") {
        const item = args.ProductData?.ItemNumber;
        productMeta.set(item, args.ProductData);
        return { result: [products.get(item) || ++nextId] };
      }
      if (op === "Product_GetByItemNumber") {
        const item = args.ItemNumber;
        const id = products.get(item);
        return { result: id ? [{ Id: id, ItemNumber: item, ...(productMeta.get(item) || {}) }] : [] };
      }
      if (op === "Product_CreateDeliveryTime") {
        const id = ++nextId;
        deliveryTimes.set(id, { Id: id, ...args.DeliveryTimeData });
        return { result: id };
      }
      if (op === "Product_CreateExtraBuyCategory") {
        const id = ++nextId;
        extraBuyCats.set(id, { Id: id, ...args.ExtraBuyCategoryData });
        return { result: id };
      }
      if (op === "Product_CreateExtraBuyRelation") {
        const id = ++nextId;
        extraBuyRels.push({ Id: id, ...args.ExtraBuyRelationData });
        return { result: id };
      }
      if (op === "PageText_Create") {
        const link = args.PageTextData?.Link;
        const id = ++nextId;
        pagesByLink.set(link, { Id: String(id), Link: link, LanguageISO: args.PageTextData?.LanguageISO });
        return { result: id };
      }
      if (op === "PageText_GetByLink") {
        const row = pagesByLink.get(args.PageTextLink);
        return { result: row || null };
      }
      if (op === "PageText_SetFields") return { result: true };
      if (op === "PageText_GetByFolder") {
        // fixtures/dandomain/raw/pages.json — folder 3 is Om os (CategoryId 3, ParentId 0).
        // There is no PageText_GetAll (R15); GetByFolder is the enumeration path.
        const fid = Number(args.FolderId);
        if (fid === 3) {
          return {
            result: [{
              Id: "3",
              CategoryId: "3",
              ParentId: "0",
              Title: "Om os",
              Link: "om-os",
            }],
          };
        }
        return { result: [] };
      }
      if (op === "Product_GetAdditionalTypesAll") return { result: additionalTypes };
      if (op === "Product_AddAdditionalType") return { result: true };
      if (op === "Discount_GetAll") {
        return { result: [...discounts.values()] };
      }
      if (op === "Discount_Create") {
        const data = args.DiscountData || {};
        const code = data.Code;
        if (discounts.has(code)) throw new Error(`duplicate Discount_Create for ${code}`);
        const id = ++nextId;
        discounts.set(code, { Id: id, Code: code, Type: data.Type, Title: data.Title, Value: data.Value });
        return { result: id };
      }
      if (op === "User_CreateOrUpdate") {
        const u = args.UserData?.Username;
        if (!users.has(u)) users.set(u, ++nextId);
        return { result: users.get(u) };
      }
      if (op === "User_GetGroupAll") {
        return { result: [...groups.entries()].map(([Id, Title]) => ({ Id: String(Id), Title })) };
      }
      if (op === "User_CreateGroup") {
        const id = 44;
        groups.set(id, args.UserGroupData?.Title);
        return { result: id };
      }
      if (op === "Product_GetDiscounts") {
        return { result: productDiscounts.get(Number(args.ProductId)) || [] };
      }
      if (op === "Product_CreateDiscount") {
        const id = ++nextId;
        const row = { Id: String(id), ...args.ProductDiscountData };
        const pid = Number(args.ProductDiscountData?.ProductId);
        productDiscounts.set(pid, [...(productDiscounts.get(pid) || []), row]);
        return { result: id };
      }
      if (op === "Order_GetAll") {
        return { result: [...ordersByRef.entries()].map(([ref, id]) => ({ Id: id, ReferenceNumber: ref, Status: "0" })) };
      }
      if (op === "Order_Create") {
        const ref = args.OrderData?.ReferenceNumber;
        if (ordersByRef.has(ref)) throw new Error(`duplicate Order_Create for ${ref}`);
        const id = ++nextId;
        ordersByRef.set(ref, id);
        return { result: id };
      }
      if (op === "Order_SetTransactionCode") return { result: 1 };
      if (op === "Order_UpdateStatus") {
        const st = Number(args.Status);
        if (st === 1) throw new Error("F37: never Order_UpdateStatus Status=1");
        return { result: true };
      }
      if (op === "Order_SetFields" || op === "Product_SetFields") return { result: true };
      if (op === "Order_Delete") throw new Error("Order_Delete is not in the WSDL");
      if (op === "Product_GetAll") {
        if (productRows.size) return { result: [...productRows.values()] };
        return { result: [...products.entries()].map(([ItemNumber, Id]) => ({ Id: String(Id), ItemNumber })) };
      }
      if (op === "Product_Delete") {
        const id = Number(args.ProductId);
        productRows.delete(id);
        for (const [item, pid] of [...products.entries()]) {
          if (Number(pid) === id) products.delete(item);
        }
        return { result: true };
      }
      if (op === "Discount_Delete") {
        const id = Number(args.DiscountId);
        for (const [code, row] of [...discounts.entries()]) {
          if (Number(row.Id) === id) discounts.delete(code);
        }
        return { result: true };
      }
      if (op === "PageText_Delete") {
        const id = String(args.PageTextId);
        for (const [link, row] of [...pagesByLink.entries()]) {
          if (String(row.Id) === id) pagesByLink.delete(link);
        }
        return { result: true };
      }
      if (op === "User_GetAll") {
        return { result: [...users.entries()].map(([Username, Id]) => ({ Id: String(Id), Username })) };
      }
      if (op === "User_Delete") {
        const id = Number(args.UserId);
        for (const [name, uid] of [...users.entries()]) {
          if (Number(uid) === id) users.delete(name);
        }
        return { result: true };
      }
      if (op === "User_DeleteGroup") {
        groups.delete(Number(args.UserGroupId));
        return { result: true };
      }
      if (op === "Product_GetAllExtraBuyCategory") return { result: [...extraBuyCats.values()] };
      if (op === "Product_GetExtraBuyCategory") {
        return { result: extraBuyCats.get(Number(args.ExtraBuyCategoryId)) || null };
      }
      if (op === "Product_GetExtraBuyRelations") {
        const pid = Number(args.ProductId);
        return { result: extraBuyRels.filter((r) => Number(r.ProductId) === pid) };
      }
      if (op === "Product_DeleteExtraBuyRelation") {
        const id = Number(args.ProductExtraBuyRelationId);
        const idx = extraBuyRels.findIndex((r) => Number(r.Id) === id);
        if (idx >= 0) extraBuyRels.splice(idx, 1);
        return { result: true };
      }
      if (op === "Product_DeleteExtraBuyCategory") {
        extraBuyCats.delete(Number(args.ProductExtraBuyCategoryId));
        return { result: true };
      }
      if (op === "Product_GetDeliveryTimeAll") return { result: [...deliveryTimes.values()] };
      if (op === "Product_GetDeliveryTime") {
        return { result: deliveryTimes.get(Number(args.DeliveryTimeId)) || null };
      }
      if (op === "Product_DeleteDeliveryTime") {
        deliveryTimes.delete(Number(args.ProductDeliveryTimeId));
        return { result: true };
      }
      if (op === "Category_Delete") {
        const id = Number(args.CategoryId);
        for (const [title, cid] of [...categories.entries()]) {
          if (Number(cid) === id) categories.delete(title);
        }
        return { result: true };
      }
      return { result: null };
    },
  };
  return client;
}

const NO_FTPS_CFG_MSG = "no FTPS configuration — construct the client with { ftp: { host, user, pass } } (R10/R11)";

/** Same shape as DanDomainClient#ftp(): throws until ftpOptions is wired. */
function attachLiveShapedFtp(client, stored = []) {
  client.ftp = function ftp() {
    if (!this.ftpOptions?.host || !this.ftpOptions?.user || !this.ftpOptions?.pass) {
      throw new Error(NO_FTPS_CFG_MSG);
    }
    return {
      async connect() {
        return {
          async xferOut(command, payload) {
            stored.push({ command, bytes: payload?.length });
            return { finCode: 226, sentBytes: payload.length };
          },
        };
      },
      quit() {},
    };
  };
  return stored;
}

/** Memoised ftp() facade: first session ECONNRESET on STOR N, later sessions succeed. */
function attachResettingFtp(client, { failAtStor = 3 } = {}) {
  const stored = [];
  const quits = [];
  let connectCount = 0;
  let failedOnce = false;
  const facade = {
    async connect() {
      if (!client.ftpOptions?.host || !client.ftpOptions?.user || !client.ftpOptions?.pass) {
        throw new Error(NO_FTPS_CFG_MSG);
      }
      connectCount += 1;
      const sessionId = connectCount;
      return {
        async xferOut(command, payload) {
          stored.push({ command, bytes: payload?.length, session: sessionId });
          if (!failedOnce && stored.length === failAtStor) {
            failedOnce = true;
            const err = new Error("read ECONNRESET");
            err.code = "ECONNRESET";
            throw err;
          }
          return { finCode: 226, sentBytes: payload.length };
        },
      };
    },
    quit() { quits.push(connectCount); },
  };
  client.ftp = () => facade;
  return { stored, quits, getConnectCount: () => connectCount };
}

function withFtpEnvCleared(fn) {
  const prev = {
    DD_FTP_HOST: process.env.DD_FTP_HOST,
    DD_FTP_USER: process.env.DD_FTP_USER,
    DD_FTP_PASSWORD: process.env.DD_FTP_PASSWORD,
  };
  delete process.env.DD_FTP_HOST;
  delete process.env.DD_FTP_USER;
  delete process.env.DD_FTP_PASSWORD;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function baseCfg(tmp, extra = {}) {
  return {
    paths: { raw: path.join(tmp, "raw"), state: path.join(tmp, "state") },
    source: {
      adapter: "dandomain",
      kind: "dandomain",
      allowDestructive: false,
      baseUrl: "https://shop000000.webshop.dandomain.dk",
      dandomain: {
        shopId: "105698",
        tenant: "shop000000",
        username: "api",
        password: "x",
        ...extra.dandomain,
      },
      ...extra.source,
    },
    ...extra,
  };
}

describe("DD_TIERS", () => {
  test("exposes five Hostedshop sizes; standalone is real + real-xl only", () => {
    assert.deepEqual(Object.keys(DD_TIERS), [
      "dd-light", "dd-medium", "dd-heavy", "dd-real", "dd-real-xl",
    ]);
    assert.equal(STANDALONE_DD_TIERS.has("dd-real"), true);
    assert.equal(STANDALONE_DD_TIERS.has("dd-real-xl"), true);
    assert.equal(STANDALONE_DD_TIERS.has("dd-light"), false);
    assert.equal(STANDALONE_DD_TIERS.has("dd-medium"), false);
    assert.equal(STANDALONE_DD_TIERS.has("dd-heavy"), false);
    assert.equal(STANDALONE_DD_TIERS.size, 2);
  });

  test("unknown tier lists all five DD keys", async () => {
    const client = mockClient();
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    await assert.rejects(
      () => seedDanDomain({ client, cfg, tier: "dd-nope", logger() {} }),
      (err) => {
        const msg = String(err.message);
        for (const k of ["dd-light", "dd-medium", "dd-heavy", "dd-real", "dd-real-xl"]) {
          assert.ok(msg.includes(k), k);
        }
        assert.equal(/light\|medium\|heavy/.test(msg), false, "must not list WP tier names");
        return true;
      },
    );
  });
});

describe("assertSeedGates", () => {
  test("refuses when data/raw/summary.json exists without allowDestructive", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      mkdirSync(path.join(tmp, "raw"), { recursive: true });
      writeFileSync(path.join(tmp, "raw", "summary.json"), "{}");
      const cfg = baseCfg(tmp);
      assert.throws(() => assertSeedGates(cfg), /summary\.json|allowDestructive/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("allows when allowDestructive is true", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      mkdirSync(path.join(tmp, "raw"), { recursive: true });
      writeFileSync(path.join(tmp, "raw", "summary.json"), "{}");
      const cfg = baseCfg(tmp, { source: { allowDestructive: true } });
      cfg.source.allowDestructive = true;
      assert.doesNotThrow(() => assertSeedGates(cfg));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("shop-identity gate: refuses when config shopId disagrees with GetWebinfo", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      cfg.source.dandomain.shopId = "999999";
      const client = mockClient({ SolutionId: "105698" });
      await assert.rejects(
        () => seedDanDomain({ client, cfg, tier: "dd-light", logger: () => {} }),
        /shop.?id|SolutionId|identity/i,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("shop-identity gate: refuses when shopId is missing from config", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      delete cfg.source.dandomain.shopId;
      const client = mockClient();
      await assert.rejects(
        () => seedDanDomain({ client, cfg, tier: "dd-light", logger: () => {} }),
        /shop.?id|SolutionId|identity/i,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("seedDanDomain idempotency markers", () => {
  test("dd-light upserts sentinel products/users; re-run does not Order_Create twice", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      const client = mockClient();
      const a = await seedDanDomain({ client, cfg, tier: "dd-light", logger: () => {} });
      const creates1 = client.calls.filter((c) => c.op === "Order_Create").length;
      const prodUpserts1 = client.calls.filter((c) => c.op === "Product_CreateOrUpdate").length;
      assert.ok(prodUpserts1 >= 1, "at least one Product_CreateOrUpdate");
      assert.ok(creates1 >= 1, "at least one Order_Create");
      assert.ok(a.products > 0);
      const firstProd = client.calls.find((c) => c.op === "Product_CreateOrUpdate");
      assert.ok(firstProd.args.ProductData?.CategoryId, "Product_CreateOrUpdate requires CategoryId (live PRODUCT fault)");

      const b = await seedDanDomain({ client, cfg, tier: "dd-light", logger: () => {} });
      const creates2 = client.calls.filter((c) => c.op === "Order_Create").length;
      assert.equal(creates2, creates1, "re-run must not create duplicate orders (ReferenceNumber sentinel)");
      assert.equal(b.ordersSkipped, creates1);
      const items = client.calls
        .filter((c) => c.op === "Product_CreateOrUpdate")
        .map((c) => c.args.ProductData?.ItemNumber);
      assert.ok(items.every((i) => String(i).startsWith(SENTINEL)), "ItemNumbers are sentinel-prefixed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("order line prices are NET (not product gross) — R1", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      const client = mockClient();
      await seedDanDomain({ client, cfg, tier: "dd-light", logger: () => {} });
      const order = client.calls.find((c) => c.op === "Order_Create");
      const lines = order.args.OrderData.OrderLines.item;
      const line = Array.isArray(lines) ? lines[0] : lines;
      // Product Price is gross 125; VAT 25% → net line must be 100, never 125.
      assert.equal(Number(line.Price), 100);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("never calls gateway/email ops; never UpdateStatus(1)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      const client = mockClient();
      await seedDanDomain({ client, cfg, tier: "dd-real", logger: () => {} });
      for (const op of FORBIDDEN_SEED_OPS) {
        assert.equal(client.calls.some((c) => c.op === op), false, op);
      }
      const bad = client.calls.filter((c) => c.op === "Order_UpdateStatus" && Number(c.args.Status) === 1);
      assert.equal(bad.length, 0, "F37: no status 1");
      const v = client.calls.find((c) => c.op === "Product_CreateOrUpdateVariant");
      assert.ok(v, "dd-real creates a variant");
      assert.ok(v.args.VariantData?.VariantTypeValues, "variant requires VariantTypeValues");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("session uses client.connect(), not call(Solution_Connect) without credentials (R17)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      const client = mockClient();
      client.connect = async () => {
        client.calls.push({ op: "connect" });
        return { ok: true };
      };
      const orig = client.call.bind(client);
      client.call = async (op, args = {}) => {
        if (op === "Solution_Connect" && (args.Username == null || args.Password == null)) {
          throw new Error('Solution_Connect: missing required argument(s) ["Username","Password"]');
        }
        return orig(op, args);
      };
      await seedDanDomain({ client, cfg, tier: "dd-light", logger: () => {} });
      assert.ok(client.calls.some((c) => c.op === "connect"), "must call client.connect()");
      assert.equal(
        client.calls.filter((c) => c.op === "Solution_Connect").length,
        0,
        "must not call Solution_Connect without Username/Password (R17)",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("paid orders use Order_SetTransactionCode Status=1 (transaction ≠ order status)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      const client = mockClient();
      await seedDanDomain({ client, cfg, tier: "dd-light", logger: () => {} });
      const tx = client.calls.find((c) => c.op === "Order_SetTransactionCode");
      assert.ok(tx, "Order_SetTransactionCode for paid");
      assert.equal(Number(tx.args.TransactionData.Status), 1);
      assert.match(String(tx.args.TransactionData.Currency), /^\d+$/, "Currency is numeric id (server: DKK is not a number)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dd-real seeds 2-dim variants, SEO Product_Update, letter coupon; skips page SEO write", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      const client = mockClient();
      const stored = [];
      client.ftp = () => ({
        async connect() {
          return {
            async xferOut(command, payload) {
              stored.push({ command, bytes: payload?.length });
              return { finCode: 226, sentBytes: payload.length };
            },
          };
        },
        quit() {},
      });
      const a = await seedDanDomain({ client, cfg, tier: "dd-real", logger: () => {} });
      const items = client.calls
        .filter((c) => c.op === "Product_CreateOrUpdate")
        .map((c) => c.args.ProductData?.ItemNumber);
      assert.ok(items.includes(`${SENTINEL}P-2DIM`), "2-dim product sentinel");
      const v2 = client.calls.filter((c) => c.op === "Product_CreateOrUpdateVariant"
        && String(c.args.VariantData?.ItemNumber || "").startsWith(`${SENTINEL}P-2DIM-`));
      assert.equal(v2.length, 6, "2 option dims × 3 values");
      const skus = v2.map((c) => c.args.VariantData.ItemNumber);
      assert.equal(new Set(skus).size, 6);
      assert.ok(v2.every((c) => Array.isArray(c.args.VariantData.VariantTypeValues?.item)
        && c.args.VariantData.VariantTypeValues.item.length === 2));
      const prices = new Set(v2.map((c) => Number(c.args.VariantData.Price)));
      const stocks = new Set(v2.map((c) => Number(c.args.VariantData.Stock)));
      assert.ok(prices.size >= 2, "per-variant prices");
      assert.ok(stocks.size >= 2, "per-variant stock");

      const seo = client.calls.find((c) => c.op === "Product_Update"
        && c.args.ProductData?.ItemNumber === `${SENTINEL}P-2DIM`);
      assert.ok(seo, "Product_Update writes SEO on 2DIM");
      assert.ok(seo.args.ProductData.SeoTitle);
      assert.ok(seo.args.ProductData.SeoDescription);
      assert.ok(seo.args.ProductData.SeoLink);

      const pageSeo = client.calls.filter((c) => c.op === "PageText_Update");
      assert.equal(pageSeo.length, 0, "PageText_Update lacks SEO fields in WSDL — do not call it");

      const pics = client.calls.filter((c) => c.op === "Product_CreatePicture");
      const dimId = Number(client.products.get(`${SENTINEL}P-2DIM`));
      const dimPics = pics.filter((c) => Number(c.args.PictureData.ProductId) === dimId);
      assert.equal(dimPics.length, 3, "2DIM still STORS three files");
      assert.deepEqual(dimPics.map((c) => c.args.PictureData.FileName), [
        "ddseed-2dim-1.png", "ddseed-2dim-2.png", "ddseed-2dim-3.png",
      ]);
      const sortings = dimPics.map((c) => Number(c.args.PictureData.Sorting));
      assert.equal(new Set(sortings).size, 3, "distinct Sorting");
      assert.ok(pics.every((c) => c.args.PictureData.ImageAltTexts?.item?.Text
        || c.args.PictureData.ImageAltTexts?.item?.[0]?.Text));
      assert.equal(
        pics[0].args.PictureData.ImageAltTexts.item.LanguageAccess
          || pics[0].args.PictureData.ImageAltTexts.item[0]?.LanguageAccess,
        "DK_1",
        "ImageAltText.LanguageAccess is LANGUAGE-ISO_SITE-ID (followup-2), not LanguageISO",
      );
      assert.ok(stored.every((s) => String(s.command).startsWith("STOR /pics/")));
      assert.ok(stored.every((s) => !/_thumbs|placeholders/.test(s.command)));

      const coupon = client.calls.find((c) => c.op === "Discount_Create");
      assert.ok(coupon);
      assert.equal(coupon.args.DiscountData.Code, `${SENTINEL}COUPON-X`);
      assert.equal(coupon.args.DiscountData.Type, "x");
      assert.equal(a.coupons, 1);

      const creates1 = client.calls.filter((c) => c.op === "Discount_Create").length;
      const pics1 = client.calls.filter((c) => c.op === "Product_CreatePicture").length;
      await seedDanDomain({ client, cfg, tier: "dd-real", logger: () => {} });
      assert.equal(client.calls.filter((c) => c.op === "Discount_Create").length, creates1);
      assert.equal(client.calls.filter((c) => c.op === "Product_CreatePicture").length, pics1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dd-real Example titles; ItemNumbers stay sentinel; order customer is Mette Hansen", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      const client = mockClient();
      await seedDanDomain({ client, cfg, tier: "dd-real", logger: () => {} });

      const prodCalls = client.calls.filter((c) => c.op === "Product_CreateOrUpdate");
      const items = prodCalls.map((c) => c.args.ProductData?.ItemNumber);
      const titles = prodCalls.map((c) => c.args.ProductData?.Title);
      assert.ok(items.every((i) => String(i).startsWith(SENTINEL)), "SKU keys stay DDSEED-");
      assert.ok(items.includes(`${SENTINEL}P-SIMPLE`));
      assert.ok(items.includes(`${SENTINEL}P-2DIM`));
      assert.ok(items.includes(`${SENTINEL}P-AEOEAA`));
      assert.ok(titles.includes("Uldplaid Grå"), "Example simple name");
      assert.ok(titles.includes("Plaid Ærø æøå"), "æøå probe keeps Danish letters");
      assert.ok(titles.includes("Plaid Farve × Størrelse"), "2-dim keeps adversarial title");
      assert.equal(titles.some((t) => /DD Seed|DDSEED /i.test(String(t))), false, "no probe-style product titles");
      assert.ok(prodCalls.every((c) => String(c.args.ProductData?.Description || "").trim()), "every product has a description");
      assert.ok(prodCalls.length >= 100, "dd-real is a messy Hostedshop, not twelve named sentinels");

      const cat = client.calls.find((c) => c.op === "Category_CreateOrUpdate");
      assert.equal(cat.args.CategoryData?.Title, "Bolig");
      const catTitles = client.calls
        .filter((c) => c.op === "Category_CreateOrUpdate")
        .map((c) => c.args.CategoryData?.Title);
      assert.ok(catTitles.includes("Tekstiler"));
      assert.ok(catTitles.includes("Keramik"));
      assert.ok(catTitles.includes("Garn"));

      const order = client.calls.find((c) => c.op === "Order_Create");
      const cust = order.args.OrderData.OrderCustomer;
      assert.equal(cust.Firstname, "Mette");
      assert.equal(cust.Lastname, "Hansen");
      assert.match(String(cust.Email), /@example\.invalid$/);
      assert.ok(cust.Address);
      assert.ok(cust.City);
      assert.equal(cust.CountryCode, undefined, "CountryCode 'DK' is PARAM: not a number (live 2026-08-17)");
      assert.equal(cust.Firstname === "Seed" || cust.Lastname === "Customer", false);

      const seo = client.calls.find((c) => c.op === "Product_Update"
        && c.args.ProductData?.ItemNumber === `${SENTINEL}P-2DIM`);
      assert.match(String(seo.args.ProductData.SeoTitle), /Example Living/);
      assert.match(String(seo.args.ProductData.SeoDescription), /FIELD_SET_TRUNCATED/);

      const coupon = client.calls.find((c) => c.op === "Discount_Create");
      assert.equal(coupon.args.DiscountData.Code, `${SENTINEL}COUPON-X`);
      assert.match(String(coupon.args.DiscountData.Title), /Example/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dd-real Product_CreateOrUpdate Type is a SOAP enum, not a TypeLabel word", async () => {
    const allowed = [
      "normal",
      "file-sale",
      "gift-card-with-code",
      "gift-card-without-code",
      "discontinued",
      "call-for-price",
    ];
    const client = mockClient();
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: { raw: path.join(os.tmpdir(), "no-raw") } };
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    const payloads = client.calls
      .filter((c) => c.op === "Product_CreateOrUpdate" || c.op === "Product_Update")
      .map((c) => c.args.ProductData)
      .filter((d) => d?.ItemNumber);
    assert.ok(payloads.length > 0, "dd-real must send product payloads");
    for (const data of payloads) {
      const soapType = data.Type != null && data.Type !== "" ? data.Type : data.TypeLabel;
      if (soapType == null || soapType === "") continue;
      assert.equal(
        allowed.includes(String(soapType)),
        true,
        `${data.ItemNumber}: Type=${JSON.stringify(data.Type)} TypeLabel=${JSON.stringify(data.TypeLabel)} — Type must be one of ${allowed.join(", ")}`,
      );
      if (data.TypeLabel != null && data.TypeLabel !== "" && (data.Type == null || data.Type === "")) {
        assert.equal(
          allowed.includes(String(data.TypeLabel)),
          true,
          `${data.ItemNumber}: ProductCreateUpdate has TypeLabel not Type; TypeLabel=${JSON.stringify(data.TypeLabel)} is not an allowed Type enum`,
        );
      }
    }
    const creates = client.calls.filter((c) => c.op === "Product_CreateOrUpdate");
    const byItem = (item) => creates.find((c) => c.args.ProductData?.ItemNumber === item)?.args.ProductData;
    const pdf = byItem(`${SENTINEL}P-0VAT`);
    const pakke = byItem(`${SENTINEL}P-PAKKE`);
    const simple = byItem(`${SENTINEL}P-SIMPLE`);
    assert.ok(pdf, "P-0VAT create");
    assert.ok(pakke, "P-PAKKE create");
    assert.equal(pdf.Type ?? pdf.TypeLabel, "file-sale");
    assert.equal(pakke.Type ?? pakke.TypeLabel, "normal");
    if (simple?.Type != null && simple.Type !== "") {
      assert.equal(allowed.includes(String(simple.Type)), true);
    }
    if (simple?.TypeLabel != null && simple.TypeLabel !== "") {
      assert.equal(allowed.includes(String(simple.TypeLabel)), true);
    }
  });

  test("completeness — dd-real upserts DescriptionLong, Weight, TypeLabel, variant PictureId", async () => {
    const client = mockClient();
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: { raw: path.join(os.tmpdir(), "no-raw") } };
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    const creates = client.calls.filter((c) => c.op === "Product_CreateOrUpdate");
    const pakke = creates.find((c) => c.args.ProductData?.ItemNumber === `${SENTINEL}P-PAKKE`);
    const pdf = creates.find((c) => c.args.ProductData?.ItemNumber === `${SENTINEL}P-0VAT`);
    const simple = creates.find((c) => c.args.ProductData?.ItemNumber === `${SENTINEL}P-SIMPLE`);
    assert.ok(simple?.args.ProductData.DescriptionLong, "DescriptionLong must be sent (adapter reads it first)");
    assert.equal(typeof simple.args.ProductData.Weight, "number");
    assert.ok(simple.args.ProductData.Weight > 0);
    assert.equal(pakke?.args.ProductData.Type, "normal");
    assert.equal(pakke?.args.ProductData.TypeLabel, "normal");
    assert.equal(pdf?.args.ProductData.Type, "file-sale");
    assert.equal(pdf?.args.ProductData.TypeLabel, "file-sale");
    const variants = client.calls.filter((c) => c.op === "Product_CreateOrUpdateVariant");
    const twoDim = variants.filter((c) => String(c.args.VariantData?.ItemNumber || "").startsWith(`${SENTINEL}P-2DIM`));
    assert.ok(twoDim.length >= 1);
    assert.ok(
      twoDim.some((c) => c.args.VariantData.PictureId != null || c.args.VariantData.Weight != null),
      "2-dim variants must carry PictureId and/or Weight",
    );
    const related = client.calls.find((c) => c.op === "Product_Update"
      && c.args.ProductData?.ItemNumber === `${SENTINEL}P-PAKKE`
      && c.args.ProductData?.RelatedProducts);
    assert.ok(related, "P-PAKKE Product_Update sends RelatedProducts after simple exists");
    assert.equal(related.args.ProductData.Type, "normal");
    assert.equal(related.args.ProductData.TypeLabel, "normal");
  });

  test("seed variant payloads must not include PictureId 0", async () => {
    const client = mockClient();
    client.ftp = () => ({
      async connect() {
        return {
          async xferOut() {
            return { finCode: 226, sentBytes: 1 };
          },
        };
      },
      quit() {},
    });
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });

    const creates = client.calls.filter((c) => c.op === "Product_CreateOrUpdateVariant");
    assert.ok(creates.length >= 6, "2-dim variants are created");
    for (const c of creates) {
      const vd = c.args.VariantData || {};
      assert.notEqual(vd.PictureId, 0, `${vd.ItemNumber}: create must not send PictureId 0`);
      assert.notEqual(String(vd.PictureId), "0", `${vd.ItemNumber}: create must not send PictureId "0"`);
      if (vd.PictureId != null) {
        assert.ok(Number(vd.PictureId) > 0, `${vd.ItemNumber}: PictureId on create must be a real id`);
      }
      const ids = vd.PictureIds?.item ?? vd.PictureIds;
      if (ids != null) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
          assert.notEqual(Number(id), 0, `${vd.ItemNumber}: PictureIds must not include 0`);
        }
      }
    }

    const sortS = creates.find((c) => c.args.VariantData?.ItemNumber === `${SENTINEL}P-2DIM-SORT-S`);
    assert.ok(sortS, "SORT-S create");
    assert.equal("PictureId" in sortS.args.VariantData, false, "SORT-S create omits PictureId");
    assert.equal("PictureIds" in sortS.args.VariantData, false, "SORT-S create omits PictureIds");

    const bind = client.calls.find((c) => c.op === "Product_UpdateVariant"
      && c.args.VariantData?.ItemNumber === `${SENTINEL}P-2DIM-SORT-S`);
    assert.ok(bind, "SORT-S PictureId bind after pictures");
    assert.ok(Number(bind.args.VariantData.PictureId) > 0, "bind uses recorded picture Id, not 0");
  });

  test("completeness — dd-real seeds ExtraBuy, delivery time, and a CMS page", async () => {
    const client = mockClient();
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(client.calls.some((c) => c.op === "Product_CreateDeliveryTime"), true);
    assert.equal(client.calls.some((c) => c.op === "Product_CreateExtraBuyCategory"), true);
    assert.equal(client.calls.some((c) => c.op === "Product_CreateExtraBuyRelation"), true);
    assert.equal(client.calls.some((c) => c.op === "PageText_Create"), true);
    const page = client.calls.find((c) => c.op === "PageText_Create");
    assert.equal(page.args.PageTextData.Link, "ddseed-page-handel");
    assert.equal(page.args.PageTextData.LanguageISO, "DK");
    assert.ok(summary.pages >= 1);

    const byLink = client.calls.find((c) => c.op === "PageText_GetByLink");
    assert.ok(byLink, "idempotency keys PageText_GetByLink");
    assert.equal(byLink.args.PageTextLink, "ddseed-page-handel");
    assert.equal(byLink.args.Link, undefined, "WSDL arg is PageTextLink, not Link (R17)");

    const dt = client.calls.find((c) => c.op === "Product_CreateDeliveryTime");
    assert.equal(dt.args.DeliveryTimeData.TitleInStock, "1-2 hverdage");
    assert.equal(dt.args.DeliveryTimeData.TitleNoStock, "2-3 uger");
    assert.equal(dt.args.DeliveryTimeData.LanguageISO, "DK");
    const dtBind = client.calls.find((c) => c.op === "Product_Update"
      && c.args.ProductData?.ItemNumber === `${SENTINEL}P-SIMPLE`
      && c.args.ProductData?.DeliveryTimeId != null);
    assert.ok(dtBind, "P-SIMPLE Product_Update binds DeliveryTimeId");
    assert.ok(Number(dtBind.args.ProductData.DeliveryTimeId) > 0);

    const ebc = client.calls.find((c) => c.op === "Product_CreateExtraBuyCategory");
    assert.equal(ebc.args.ExtraBuyCategoryData.Title, "DDSEED Køb også");
    const rel = client.calls.find((c) => c.op === "Product_CreateExtraBuyRelation");
    assert.equal(Number(rel.args.ExtraBuyRelationData.ProductId), client.products.get(`${SENTINEL}P-SIMPLE`));
    assert.equal(Number(rel.args.ExtraBuyRelationData.RelationProductId), client.products.get(`${SENTINEL}P-SKAAL`));
    assert.ok(Number(rel.args.ExtraBuyRelationData.ExtraBuyCategoryId) > 0);

    assert.ok(summary.deliveryTimes >= 1);
    assert.ok(summary.extraBuy >= 1);
    assert.equal(summary.tilvalgAttached, 0, "empty GetAdditionalTypesAll must not attach");
    assert.equal(client.calls.some((c) => c.op === "Product_AddAdditionalType"), false);
    assert.equal(client.calls.some((c) => c.op === "Product_CreateAdditionalType"), false);
    assert.equal(client.calls.some((c) => c.op === "Product_GetAdditionals"), false);

    const pages1 = client.calls.filter((c) => c.op === "PageText_Create").length;
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(client.calls.filter((c) => c.op === "PageText_Create").length, pages1);
  });

  test("PageText_Create must not send a product-category id as CategoryId", async () => {
    const client = mockClient();
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    const page = client.calls.find((c) => c.op === "PageText_Create");
    assert.ok(page, "PageText_Create");
    const data = page.args.PageTextData || {};
    const catId = Number(data.CategoryId);
    const parentId = Number(data.ParentId);
    assert.equal("CategoryId" in data, true);
    assert.equal("ParentId" in data, true);
    assert.ok(
      catId > 0 || parentId > 0,
      `server: Either CategoryId or ParentId must be set — got CategoryId=${data.CategoryId} ParentId=${data.ParentId}`,
    );
    const productCatIds = new Set([...client.categories.values()].map(Number));
    assert.ok(productCatIds.size > 0, "seed recorded product categories via Category_CreateOrUpdate");
    assert.equal(
      productCatIds.has(catId),
      false,
      `live: Parent Category with id ${catId} does not exist — product Category_CreateOrUpdate ids are not PageText parents`,
    );
    assert.equal(parentId, 0, "ParentId 0 is the documented page-tree root (fixtures/pages.json)");
    assert.equal(
      client.calls.some((c) => c.op === "PageText_GetByFolder"),
      true,
      "there is no PageText_GetAll — copy CategoryId from PageText_GetByFolder (R15)",
    );
    assert.equal(catId, 3, "CategoryId is copied from existing page Om os (GetByFolder folder 3)");
  });

  test("dd-real pictures: cfg ftp options are wired and STOR runs", async () => {
    await withFtpEnvCleared(async () => {
      const client = mockClient();
      const stored = attachLiveShapedFtp(client);
      const cfg = {
        source: {
          dandomain: {
            shopId: "105698",
            ftp: { host: "ftps.example.test", user: "seed-user", pass: "seed-pass" },
          },
          allowDestructive: true,
        },
        paths: {},
      };
      const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
      assert.equal(client.ftpOptions?.host, "ftps.example.test");
      assert.ok(stored.length >= 1, "STOR attempted when ftp options exist");
      assert.ok(stored.every((row) => String(row.command).startsWith("STOR /pics/")));
      assert.ok(stored.every((row) => !/_thumbs|placeholders/.test(row.command)), "R21: do not touch _thumbs/ or placeholders/");
      assert.ok(summary.pictures >= 1);
    });
  });

  test("dd-real pictures: DD_FTP_* env wires ftp when config omits the block", async () => {
    await withFtpEnvCleared(async () => {
      process.env.DD_FTP_HOST = "ftps.env.test";
      process.env.DD_FTP_USER = "env-user";
      process.env.DD_FTP_PASSWORD = "env-pass";
      const client = mockClient();
      const stored = attachLiveShapedFtp(client);
      const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
      const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
      assert.equal(client.ftpOptions?.host, "ftps.env.test");
      assert.ok(stored.length >= 1, "STOR attempted from env ftp options");
      assert.ok(stored.every((row) => String(row.command).startsWith("STOR /pics/")));
      assert.ok(summary.pictures >= 1);
    });
  });

  test("dd-real pictures skip when ftp is omitted (recorded live message)", async () => {
    await withFtpEnvCleared(async () => {
      const client = mockClient();
      attachLiveShapedFtp(client);
      const logs = [];
      const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
      const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger: (m) => logs.push(m) });
      const skip = logs.find((m) => String(m).startsWith("pictures skip:"));
      assert.ok(skip, "skip path kept");
      assert.match(skip, /FTPS connect failed/);
      assert.match(skip, /no FTPS configuration — construct the client with \{ ftp: \{ host, user, pass \} \} \(R10\/R11\)/);
      assert.equal(summary.pictures, 0);
      assert.equal(client.calls.some((c) => c.op === "Product_CreatePicture"), false);
    });
  });

  test("dd-real binds one catalogue PNG per DDSEED product; 2DIM still STORS 3", async () => {
    await withFtpEnvCleared(async () => {
      const client = mockClient();
      const stored = attachLiveShapedFtp(client);
      const cfg = {
        source: {
          dandomain: {
            shopId: "105698",
            ftp: { host: "ftps.example.test", user: "seed-user", pass: "seed-pass" },
          },
          allowDestructive: true,
        },
        paths: {},
      };
      const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
      const items = productCreates(client).map((c) => String(c.args.ProductData.ItemNumber));
      const pics = client.calls.filter((c) => c.op === "Product_CreatePicture");
      const byProduct = new Map();
      for (const c of pics) {
        const pid = Number(c.args.PictureData.ProductId);
        byProduct.set(pid, (byProduct.get(pid) || []).concat(c.args.PictureData.FileName));
      }
      for (const item of items) {
        const pid = Number(client.products.get(item));
        assert.ok((byProduct.get(pid) || []).length >= 1, `${item} needs at least one CreatePicture`);
      }
      const dimId = Number(client.products.get(`${SENTINEL}P-2DIM`));
      assert.deepEqual(byProduct.get(dimId), ["ddseed-2dim-1.png", "ddseed-2dim-2.png", "ddseed-2dim-3.png"]);
      const filesaleId = Number(client.products.get(`${SENTINEL}P-0VAT`));
      assert.ok((byProduct.get(filesaleId) || []).length >= 1, "filsalg still gets a PNG");
      const names = pics.map((c) => c.args.PictureData.FileName);
      assert.equal(new Set(names).size, names.length, "FileNames unique per bind");
      assert.equal(pics.length, items.length + 2, "one bind per product, 2DIM keeps two extra");
      assert.equal(summary.pictures, pics.length);
      assert.equal(stored.length, pics.length);
      assert.ok(stored.every((s) => String(s.command).startsWith("STOR /pics/")));
      assert.ok(stored.every((s) => !/_thumbs|placeholders/.test(s.command)));
      assert.ok(pics.every((c) => c.args.PictureData.ImageAltTexts?.item?.LanguageAccess === "DK_1"));
      const gen = pics.find((c) => c.args.PictureData.FileName === "ddseed-p-gen-0001.png");
      assert.ok(gen, "GEN FileName is ddseed-<item-slug>.png");
    });
  });

  test("dd-real pictures: ECONNRESET on STOR N reconnects and continues", async () => {
    await withFtpEnvCleared(async () => {
      const client = mockClient();
      const ftp = attachResettingFtp(client, { failAtStor: 3 });
      const logs = [];
      const cfg = {
        source: {
          dandomain: {
            shopId: "105698",
            ftp: { host: "ftps.example.test", user: "seed-user", pass: "seed-pass" },
          },
          allowDestructive: true,
        },
        paths: {},
      };
      const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger: (m) => logs.push(m) });
      assert.ok(ftp.getConnectCount() >= 2, "reconnects after ECONNRESET");
      assert.ok(ftp.quits.length >= 1, "quits the dead session before reconnect");
      assert.ok(ftp.stored.some((row) => row.session >= 2), "later STORs use a new FTPS session");
      const pics = client.calls.filter((c) => c.op === "Product_CreatePicture");
      const items = productCreates(client).map((c) => String(c.args.ProductData.ItemNumber));
      assert.equal(pics.length, items.length + 2, "all binds after reconnect, 2DIM keeps two extra");
      assert.equal(summary.pictures, pics.length);
      assert.ok(summary.users >= 1, "seed continues to users after picture reconnect");
      const names = pics.map((c) => c.args.PictureData.FileName);
      assert.equal(new Set(names).size, names.length, "FileNames unique per bind");
      assert.ok(ftp.stored.every((row) => String(row.command).startsWith("STOR /pics/")));
      assert.ok(ftp.stored.every((row) => !/_thumbs|placeholders/.test(row.command)));
      const sizes = new Set(ftp.stored.map((row) => row.bytes));
      assert.equal(sizes.size, 1, "reuse PNG_1X1 bytes");
      assert.ok(pics.every((c) => c.args.PictureData.ImageAltTexts?.item?.LanguageAccess === "DK_1"));
      assert.ok(logs.some((m) => /STOR reset/i.test(String(m)) && /ECONNRESET/.test(String(m))));
    });
  });

  test("dd-real-xl yarn parent gets a catalogue PNG", async () => {
    await withFtpEnvCleared(async () => {
      const client = mockClient();
      attachLiveShapedFtp(client);
      const cfg = {
        source: {
          dandomain: {
            shopId: "105698",
            ftp: { host: "ftps.example.test", user: "seed-user", pass: "seed-pass" },
          },
          allowDestructive: true,
        },
        paths: {},
      };
      await seedDanDomain({ client, cfg, tier: "dd-real-xl", logger() {} });
      const yarnId = Number(client.products.get(`${SENTINEL}P-XL-YARN`));
      assert.ok(yarnId, "yarn parent stored");
      const yarnPics = client.calls.filter((c) => c.op === "Product_CreatePicture"
        && Number(c.args.PictureData.ProductId) === yarnId);
      assert.equal(yarnPics.length, 1);
      assert.equal(yarnPics[0].args.PictureData.FileName, "ddseed-p-xl-yarn.png");
    });
  });

  test("completeness — dd-real attaches tilvalg only when GetAdditionalTypesAll returns rows", async () => {
    const client = mockClient({ SolutionId: "105698" }, { additionalTypes: [{ Id: "9", Title: "Gavepapir" }] });
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    const add = client.calls.find((c) => c.op === "Product_AddAdditionalType");
    assert.ok(add, "attach existing type — do not invent Product_CreateAdditionalType");
    assert.equal(Number(add.args.AdditionalTypeId), 9);
    assert.equal(Number(add.args.ProductId), client.products.get(`${SENTINEL}P-SIMPLE`));
    assert.equal(summary.tilvalgAttached, 1);
    assert.equal(client.calls.some((c) => c.op === "Product_CreateAdditionalType"), false);
    assert.equal(client.calls.some((c) => c.op === "Product_GetAdditionals"), false);
  });

  test("completeness — dd-light does not seed punch-list ExtraBuy, delivery, pages, or B2B group prices", async () => {
    const client = mockClient();
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    await seedDanDomain({ client, cfg, tier: "dd-light", logger() {} });
    for (const op of [
      "Product_CreateDeliveryTime",
      "Product_CreateExtraBuyCategory",
      "Product_CreateExtraBuyRelation",
      "PageText_Create",
      "Product_AddAdditionalType",
      "User_CreateGroup",
      "Product_CreateDiscount",
    ]) {
      assert.equal(client.calls.some((c) => c.op === op), false, op);
    }
  });

  test("completeness — dd-real creates a B2B group and a group ProductDiscount", async () => {
    const client = mockClient();
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    const g = client.calls.find((c) => c.op === "User_CreateGroup");
    assert.equal(g?.args.UserGroupData.Title, "DDSEED B2B");
    assert.equal(g.args.UserGroupData.Producer, false);
    const d = client.calls.find((c) => c.op === "Product_CreateDiscount");
    assert.equal(d?.args.ProductDiscountData.UserType, "group");
    assert.equal(d.args.ProductDiscountData.Price, 150);
    assert.notEqual(d.args.ProductDiscountData.UserId, 0);
    assert.notEqual(String(d.args.ProductDiscountData.UserId), "0");
    assert.equal(d.args.ProductDiscountData.DiscountType, "a");
    assert.equal(d.args.ProductDiscountData.ProductVariantId, 0);
    const simple = client.calls.find((c) => c.op === "Product_CreateOrUpdate"
      && c.args.ProductData?.ItemNumber === `${SENTINEL}P-SIMPLE`);
    assert.equal(simple.args.ProductData.Price, 125, "public list price stays R42 gross 125");
    const b2b = client.calls.find((c) => c.op === "User_CreateOrUpdate"
      && c.args.UserData?.Username === `${SENTINEL}user-b2b`);
    assert.equal(b2b.args.UserData.UserGroupId, d.args.ProductDiscountData.UserId);
    assert.notEqual(b2b.args.UserData.UserGroupId, 7);

    const groups1 = client.calls.filter((c) => c.op === "User_CreateGroup").length;
    const prices1 = client.calls.filter((c) => c.op === "Product_CreateDiscount").length;
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(client.calls.filter((c) => c.op === "User_CreateGroup").length, groups1);
    assert.equal(client.calls.filter((c) => c.op === "Product_CreateDiscount").length, prices1);
  });

  test("completeness — dd-real seeds word-type coupons percent and amount", async () => {
    const client = mockClient();
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    const creates = client.calls.filter((c) => c.op === "Discount_Create").map((c) => c.args.DiscountData);
    assert.equal(creates.some((d) => d.Code === `${SENTINEL}COUPON-PERCENT` && d.Type === "percent"), true);
    assert.equal(creates.some((d) => d.Code === `${SENTINEL}COUPON-AMOUNT` && d.Type === "amount"), true);
    assert.equal(creates.some((d) => d.Code === `${SENTINEL}COUPON-X` && d.Type === "x"), true);
    const pct = creates.find((d) => d.Code === `${SENTINEL}COUPON-PERCENT`);
    const amt = creates.find((d) => d.Code === `${SENTINEL}COUPON-AMOUNT`);
    assert.equal(pct.Value, 10);
    assert.equal(amt.Value, 25);
    assert.equal(creates.some((d) => d.Type === "a" || d.Type === "p"), false, "do not seed coupon Type a/p (R37)");
    const storedPct = summary.wordCoupons.find((w) => w.code === `${SENTINEL}COUPON-PERCENT`);
    const storedAmt = summary.wordCoupons.find((w) => w.code === `${SENTINEL}COUPON-AMOUNT`);
    assert.equal(storedPct?.storedType, "percent", "offline mock stores Type as sent");
    assert.equal(storedAmt?.storedType, "amount", "offline mock stores Type as sent");
    const n1 = client.calls.filter((c) => c.op === "Discount_Create").length;
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(client.calls.filter((c) => c.op === "Discount_Create").length, n1);
  });

  test("completeness — dd-real writes a UK title when GetLanguages includes UK", async () => {
    const client = mockClient({ SolutionId: "105698" });
    client.languages = [{ LanguageISO: "DK" }, { LanguageISO: "UK" }];
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(client.calls.some((c) => c.op === "Solution_SetLanguage" && c.args.LanguageISO === "UK"), true);
    const ukUpdate = client.calls.find((c) =>
      c.op === "Product_Update" && c.args.ProductData?.Title === "Grey wool throw");
    assert.ok(ukUpdate);
    assert.equal(ukUpdate.args.ProductData.LanguageISO, "UK");
    assert.equal(ukUpdate.args.ProductData.DescriptionLong, "<p>Classic grey wool throw.</p>");
    assert.equal(ukUpdate.args.ProductData.ItemNumber, `${SENTINEL}P-SIMPLE`);
    const setLang = client.calls.filter((c) => c.op === "Solution_SetLanguage");
    assert.equal(setLang[0]?.args.LanguageISO, "UK");
    assert.equal(setLang.at(-1)?.args.LanguageISO, "DK");
    assert.equal(summary.i18n, 1);
    assert.equal(client.calls.some((c) => c.op === "Solution_CreateLanguage" || c.op === "Language_Create" || c.op === "Sites_Create"), false);
  });

  test("completeness — dd-real skips UK strings when GetLanguages is DK-only", async () => {
    const client = mockClient({ SolutionId: "105698" });
    const cfg = { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(summary.i18n, 0);
    assert.equal(client.calls.some((c) => c.op === "Solution_SetLanguage"), false);
    assert.equal(client.calls.some((c) =>
      c.op === "Product_Update" && c.args.ProductData?.Title === "Grey wool throw"), false);
    assert.equal(client.calls.some((c) => c.op === "Solution_CreateLanguage" || c.op === "Language_Create"), false);
  });

  test("F16: Order_Create LINE_ERRORS keeps the created id; never retries", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-seed-"));
    try {
      const cfg = baseCfg(tmp);
      const client = mockClient();
      const orig = client.call.bind(client);
      let creates = 0;
      client.call = async (op, args = {}) => {
        if (op === "Order_Create") {
          creates += 1;
          const err = Object.assign(new Error("lineErrors: Order: 21 created."), {
            kind: "LINE_ERRORS",
            created: true,
            orderId: 21,
          });
          throw err;
        }
        return orig(op, args);
      };
      const a = await seedDanDomain({ client, cfg, tier: "dd-light", logger: () => {} });
      assert.equal(creates, 1, "must not retry Order_Create after LINE_ERRORS");
      assert.equal(a.orders, 1);
      const tx = client.calls.find((c) => c.op === "Order_SetTransactionCode");
      assert.equal(Number(tx?.args?.TransactionData?.OrderId), 21);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function productCreates(client) {
  return client.calls.filter((c) => c.op === "Product_CreateOrUpdate");
}

function seedCfg() {
  return { source: { dandomain: { shopId: "105698" }, allowDestructive: true }, paths: {} };
}

describe("DanDomain seed ladder", () => {
  test("dd-medium product creates = light + ~60 generated", async () => {
    const cfg = seedCfg();
    const light = mockClient();
    const medium = mockClient();
    const a = await seedDanDomain({ client: light, cfg, tier: "dd-light", logger() {} });
    const b = await seedDanDomain({ client: medium, cfg, tier: "dd-medium", logger() {} });
    assert.ok(b.products >= a.products + 55 && b.products <= a.products + 65);
    assert.ok(productCreates(medium).some((c) => String(c.args.ProductData.ItemNumber).startsWith(`${SENTINEL}P-M-`)));
    assert.equal(medium.calls.some((c) => c.op === "Product_CreateExtraBuyCategory"), false);
    assert.equal(medium.calls.some((c) => c.op === "Product_CreateDeliveryTime"), false);
    assert.equal(medium.calls.some((c) => c.op === "PageText_Create"), false);
  });

  test("dd-heavy includes medium + ~280 generated and a >3-dim variant probe", async () => {
    const cfg = seedCfg();
    const medium = mockClient();
    const heavy = mockClient();
    const m = await seedDanDomain({ client: medium, cfg, tier: "dd-medium", logger() {} });
    const h = await seedDanDomain({ client: heavy, cfg, tier: "dd-heavy", logger() {} });
    assert.ok(h.products >= m.products + 270);
    const monster = heavy.calls.filter((c) => c.op === "Product_CreateOrUpdateVariant"
      && String(c.args.VariantData?.ItemNumber || "").includes("H-MONSTER"));
    assert.ok(monster.length >= 1);
    const vals = monster[0].args.VariantData.VariantTypeValues?.item;
    assert.ok(Array.isArray(vals) && vals.length >= 4, ">3-dim payload");
    const titles = productCreates(heavy).map((c) => c.args.ProductData.Title);
    assert.ok(titles.some((t) => /æ|ø|å/i.test(String(t))));
    assert.ok(productCreates(heavy).some((c) => String(c.args.ProductData.DescriptionLong || "").length > 400
      || String(c.args.ProductData.Description || "").includes("MsoNormal")
      || String(c.args.ProductData.Description || "").includes("et_pb_")));
  });

  test("completeness extras fire on dd-real-xl (superset of dd-real)", async () => {
    const cfg = seedCfg();
    const xl = mockClient();
    await seedDanDomain({ client: xl, cfg, tier: "dd-real-xl", logger() {} });
    assert.equal(xl.calls.some((c) => c.op === "Product_CreateExtraBuyCategory"), true);
    assert.equal(xl.calls.some((c) => c.op === "Product_CreateDeliveryTime"), true);
    assert.ok(productCreates(xl).some((c) => c.args.ProductData.ItemNumber === `${SENTINEL}P-2DIM`));
    assert.ok(productCreates(xl).some((c) => c.args.ProductData.ItemNumber === `${SENTINEL}P-SIMPLE`));
    assert.equal(xl.calls.some((c) => c.op === "Order_Delete"), false);
  });

  function mockBlogGraphql({
    mutationName = "blogPostCreate",
    existingTitles = [],
    languages = [{ id: "1", iso: "DK", name: "Dansk", primary: true }, { id: "2", iso: "UK", name: "English", primary: false }],
    pages = [
      { id: "20", type: "BLOG", translations: [{ data: { title: "DDSEED-PAGE-BLOG" } }] },
      { id: "11", type: "NEWS", translations: [{ data: { title: "Nyheder" } }] },
    ],
    users = [{ id: "1", username: "Admin" }],
    existingAddedBy = "Admin",
  } = {}) {
    const executes = [];
    const calls = [];
    const pageRows = pages.map((p) => ({ ...p }));
    const posts = existingTitles.map((title, i) => ({
      id: String(i + 1),
      addedBy: existingAddedBy,
      pageId: 11,
      translations: [{ data: { title, text: "<p>x</p>" }, language: { iso: "DK", primary: true } }],
    }));
    return {
      executes,
      calls,
      graphql() {
        return {
          async query() {
            return { rows: posts };
          },
          async execute({ document, variables }) {
            executes.push(document);
            calls.push({ document, variables });
            const doc = String(document);
            if (doc.includes("mutationType")) {
              return { data: { __schema: { mutationType: { fields: [{ name: mutationName, args: [{ name: "input", type: { name: "BlogPostCreateInput" } }] }] } } } };
            }
            if (doc.includes("__type") && doc.includes("BlogPostCreateInput")) {
              return { data: { __type: { inputFields: [
                { name: "addedBy", type: { name: "String", kind: "NON_NULL" } },
                { name: "pageId", type: { name: "ID", kind: "NON_NULL" } },
                { name: "translations", type: { name: null, kind: "LIST" } },
              ] } } };
            }
            if (doc.includes("languages(")) {
              return { data: { languages: { content: languages, errors: [] } } };
            }
            if (doc.includes("pageCreate")) {
              const input = variables?.input || {};
              const id = String(100 + pageRows.length);
              pageRows.push({
                id,
                type: input.type,
                translations: input.translations || [{ data: { title: input.type } }],
              });
              return { data: { pageCreate: { content: { id, type: input.type }, errors: [] } } };
            }
            if (doc.includes("pages(")) {
              return { data: { pages: { content: pageRows, errors: [] } } };
            }
            if (doc.includes("users(")) {
              return { data: { users: { data: users, pagination: { total: users.length } } } };
            }
            if (doc.includes("mutation") && doc.includes(mutationName)) {
              const id = String(posts.length + 1);
              const title = variables?.input?.translations?.[0]?.data?.title || "created";
              posts.push({ id, translations: [{ data: { title } }] });
              return { data: { [mutationName]: { content: { id }, errors: [] } } };
            }
            return { data: {} };
          },
        };
      },
    };
  }

  test("dd-real seeds GraphQL blog posts when blogPostCreate is on mutationType", async () => {
    const cfg = seedCfg();
    const gql = mockBlogGraphql();
    const client = mockClient();
    client.graphql = gql.graphql;
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(summary.blogMutation, "blogPostCreate");
    assert.equal(summary.blogPosts, 2);
    assert.ok(gql.executes.some((d) => /mutationType/.test(d)), "seed introspects mutationType before create");
    const titles = gql.calls
      .filter((c) => /blogPostCreate/.test(c.document) && !/pageCreate/.test(c.document))
      .map((c) => c.variables?.input?.translations?.[0]?.data?.title);
    assert.ok(titles.includes("DDSEED-BLOG-HYGGE"), "create uses sentinel DDSEED-BLOG-HYGGE");
    assert.ok(titles.includes("DDSEED-NEWS-VELKOMMEN"), "create uses sentinel DDSEED-NEWS-VELKOMMEN");
  });

  test("dd-real blogPostCreate variables include addedBy, pageId, languageId (not language)", async () => {
    const cfg = seedCfg();
    const gql = mockBlogGraphql();
    const client = mockClient();
    client.graphql = gql.graphql;
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    const creates = gql.calls.filter((c) => {
      const d = String(c.document);
      return /mutation/.test(d) && /blogPostCreate/.test(d) && !/pageCreate/.test(d);
    });
    assert.equal(creates.length, 2);
    for (const c of creates) {
      const input = c.variables?.input;
      assert.ok(input, "blogPostCreate is called with GraphQL variables.input");
      assert.equal(typeof input.addedBy, "string");
      assert.ok(String(input.addedBy).length > 0, "addedBy is a non-empty String!");
      assert.ok(input.pageId, "pageId is provided");
      const layer = input.translations?.[0];
      assert.ok(layer?.languageId, "languageId is provided");
      assert.equal(layer.language, undefined, "BlogPostTranslationInput has languageId, not language");
    }
    const hygge = creates.find((c) => c.variables.input.translations[0].data.title === "DDSEED-BLOG-HYGGE");
    const news = creates.find((c) => c.variables.input.translations[0].data.title === "DDSEED-NEWS-VELKOMMEN");
    assert.ok(hygge, "HYGGE title is in variables");
    assert.ok(news, "VELKOMMEN title is in variables");
    assert.equal(String(hygge.variables.input.pageId), "20");
    assert.equal(String(news.variables.input.pageId), "11");
    assert.equal(String(hygge.variables.input.translations[0].languageId), "1");
    assert.match(String(hygge.variables.input.translations[0].data.text), /[æøå]/i);
  });

  test("dd-real blog seed pageCreates BLOG host page when none exists", async () => {
    const cfg = seedCfg();
    const gql = mockBlogGraphql({
      pages: [{ id: "11", type: "NEWS", translations: [{ data: { title: "Nyheder" } }] }],
    });
    const client = mockClient();
    client.graphql = gql.graphql;
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    const createdPages = gql.calls.filter((c) => /pageCreate/.test(c.document));
    assert.equal(createdPages.length, 1);
    assert.equal(createdPages[0].variables.input.type, "BLOG");
    assert.equal(createdPages[0].variables.input.translations[0].data.title, "DDSEED-PAGE-BLOG");
    assert.equal(createdPages[0].variables.input.translations[0].languageId, "1");
    assert.equal(summary.blogPagesCreated.length, 1);
    assert.equal(summary.blogPagesCreated[0].type, "BLOG");
    const hygge = gql.calls.find((c) => c.variables?.input?.translations?.[0]?.data?.title === "DDSEED-BLOG-HYGGE");
    assert.equal(String(hygge.variables.input.pageId), String(summary.blogPagesCreated[0].id));
    assert.equal(summary.blogPosts, 2);
  });

  test("dd-real display Danish uses æøå; SKU and SeoLink stay ASCII", async () => {
    const cfg = seedCfg();
    const gql = mockBlogGraphql();
    const client = mockClient();
    client.graphql = gql.graphql;
    await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });

    const prods = productCreates(client);
    const titles = prods.map((c) => String(c.args.ProductData.Title));
    const items = prods.map((c) => String(c.args.ProductData.ItemNumber));
    const seos = prods.map((c) => String(c.args.ProductData.SeoLink || ""));
    assert.ok(titles.some((t) => /[æøå]/i.test(t)), "at least one product title has Danish letters");
    assert.ok(items.every((i) => /^[\x00-\x7F]+$/.test(i)), "ItemNumbers stay ASCII");
    assert.ok(seos.every((s) => s === "" || /^[\x00-\x7F]+$/.test(s)), "SeoLinks stay ASCII");
    assert.ok(titles.every((t) => !/&(?:aelig|oslash|aring);/i.test(t)), "titles are Unicode, not HTML entities");

    const catTitles = client.calls
      .filter((c) => c.op === "Category_CreateOrUpdate")
      .map((c) => c.args.CategoryData.Title);
    assert.ok(catTitles.includes("Tilbehør"));
    assert.ok(catTitles.includes("Tilbehoer"), "ASCII near-dup collision probe kept");

    const hygge = gql.calls.find((c) => c.variables?.input?.translations?.[0]?.data?.title === "DDSEED-BLOG-HYGGE");
    assert.ok(hygge, "blog create carries sentinel title");
    assert.match(String(hygge.variables.input.translations[0].data.text), /[æøå]/i, "blog body uses real Danish letters");
    assert.equal(/&(?:aelig|oslash|aring);/i.test(String(hygge.variables.input.translations[0].data.text)), false);

    const page = client.calls.find((c) => c.op === "PageText_Create");
    assert.ok(page, "PageText_Create");
    assert.equal(page.args.PageTextData.Link, "ddseed-page-handel");
    assert.match(String(page.args.PageTextData.Text), /[æøå]/i, "page body uses real Danish letters");
    assert.equal(/&(?:aelig|oslash|aring);/i.test(String(page.args.PageTextData.Text)), false);
  });

  test("dd-real blog seed is idempotent on sentinel titles", async () => {
    const cfg = seedCfg();
    const gql = mockBlogGraphql({ existingTitles: ["DDSEED-BLOG-HYGGE", "DDSEED-NEWS-VELKOMMEN"] });
    const client = mockClient();
    client.graphql = gql.graphql;
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(summary.blogPosts, 2);
    assert.equal(summary.blogPostsSkipped, 2);
    assert.equal(gql.calls.filter((c) => /mutation/.test(c.document) && /blogPostCreate/.test(c.document) && !/pageCreate/.test(c.document)).length, 0);
  });

  test("dd-real records blog mutation absent and does not invent a create", async () => {
    const cfg = seedCfg();
    const gql = mockBlogGraphql({ mutationName: "unrelatedCreate" });
    const client = mockClient();
    client.graphql = gql.graphql;
    const summary = await seedDanDomain({ client, cfg, tier: "dd-real", logger() {} });
    assert.equal(summary.blogMutation, null);
    assert.equal(summary.blogPosts, 0);
    assert.match(String(summary.blog?.reason || ""), /recorded absent|not present/i);
    assert.equal(gql.executes.some((d) => /mutation\s*\{/.test(d) && /unrelatedCreate/.test(d) === false && /blogPostCreate/.test(d)), false);
  });

  test("dd-real-xl requests 120 variants on DDSEED-P-XL-YARN and continues if variant create faults", async () => {
    const cfg = seedCfg();
    const okClient = mockClient();
    const summary = await seedDanDomain({ client: okClient, cfg, tier: "dd-real-xl", logger() {} });
    const yarnVars = okClient.calls.filter((c) => c.op === "Product_CreateOrUpdateVariant"
      && String(c.args.VariantData?.ItemNumber || "").startsWith(`${SENTINEL}P-XL-YARN-`));
    assert.equal(yarnVars.length, 120);
    assert.equal(yarnVars[0].args.VariantData.VariantTypeValues.item.length, 2, "Hostedshop 2 axes, not Woo 3");
    assert.equal(summary.xlYarn.requested, 120);
    assert.equal(summary.xlYarn.stored, 120);

    const fault = mockClient({ SolutionId: "105698" }, { faultYarnVariants: true });
    const probe = await seedDanDomain({ client: fault, cfg, tier: "dd-real-xl", logger() {} });
    assert.equal(probe.xlYarn.requested, 120);
    assert.ok(probe.xlYarn.stored < 120);
    assert.ok(probe.products >= 100, "seed continues after variant faults");
  });

  test("forbidden seed ops list is unchanged", () => {
    assert.deepEqual([...FORBIDDEN_SEED_OPS], [
      "Order_CompleteTransaction",
      "Order_CancelTransaction",
      "Order_LowerTransaction",
      "Order_SendEmail",
      "Order_SendStatusEmail",
      "Order_SendReceiptEmail",
      "Solution_SetEncoding",
    ]);
  });
});

function sentinelInventory(overrides = {}) {
  return {
    products: [
      { Id: 1, ItemNumber: "1001", Title: "Demo 1" },
      { Id: 2, ItemNumber: "1002", Title: "Demo 2" },
      { Id: 3, ItemNumber: "DDSEED-MUTANT", Title: "mutant on protected id" },
      { Id: 4, ItemNumber: "1004", Title: "Demo 4" },
      { Id: 5, ItemNumber: "1005", Title: "Demo 5" },
      { Id: 6, ItemNumber: "1006", Title: "Demo 6" },
      { Id: 101, ItemNumber: `${SENTINEL}P-SIMPLE`, Title: "Uldplaid Grå", DeliveryTimeId: 77 },
      { Id: 102, ItemNumber: `${SENTINEL}P-SKAAL`, Title: "Skål stentøj" },
    ],
    discounts: [
      { Id: 201, Code: `${SENTINEL}COUPON-X`, Type: "x" },
      { Id: 202, Code: `${SENTINEL}COUPON-PERCENT`, Type: "percent" },
      { Id: 203, Code: "SUMMER10", Type: "percent" },
    ],
    pages: [{ Id: 301, Link: "ddseed-page-handel", Title: "Handel og levering" }],
    users: [
      { Id: 401, Username: `${SENTINEL}user-mette` },
      { Id: 402, Username: `${SENTINEL}user-b2b` },
    ],
    groups: [
      { Id: 44, Title: "DDSEED B2B" },
      { Id: 7, Title: "Retail" },
    ],
    extraBuyCats: [
      { Id: 55, Title: "DDSEED Køb også" },
      { Id: 56, Title: "Merchant extras" },
    ],
    extraBuyRels: [
      { Id: 61, ProductId: 101, RelationProductId: 102, ExtraBuyCategoryId: 55 },
    ],
    deliveryTimes: [
      { Id: 77, TitleInStock: "1-2 hverdage", TitleNoStock: "2-3 uger" },
      { Id: 88, TitleInStock: "3-5 dage", TitleNoStock: "4-6 uger" },
    ],
    orders: [{ Id: 900, ReferenceNumber: "F16-EMPTY", OrderLines: [] }],
    categories: [
      { Id: 11, Title: "Bolig" },
      { Id: 12, Title: "Tekstiler" },
      { Id: 13, Title: "Keramik" },
      { Id: 14, Title: "Garn" },
      { Id: 99, Title: "DDSEED OnlyCat" },
    ],
    ...overrides,
  };
}

describe("resetDanDomainSentinels", () => {
  test("calls Solution_GetWebinfo first; throws if shopId disagrees", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-reset-"));
    try {
      const cfg = baseCfg(tmp);
      cfg.source.dandomain.shopId = "999999";
      const client = mockClient({ SolutionId: "105698" }, { inventory: sentinelInventory() });
      await assert.rejects(
        () => resetDanDomainSentinels(client, cfg),
        /shop.?id|SolutionId|identity/i,
      );
      assert.equal(client.calls[0]?.op, "Solution_GetWebinfo");
      assert.equal(client.calls.some((c) => c.op === "Product_Delete"), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("throws when shopId is missing from config", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-reset-"));
    try {
      const cfg = baseCfg(tmp);
      delete cfg.source.dandomain.shopId;
      const client = mockClient({ SolutionId: "105698" }, { inventory: sentinelInventory() });
      await assert.rejects(
        () => resetDanDomainSentinels(client, cfg),
        /shop.?id|SolutionId|identity/i,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("deletes DDSEED sentinels; never 1–6; never orders/forbidden; re-query empty", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-reset-"));
    try {
      const cfg = baseCfg(tmp);
      const ftpCmds = [];
      const client = mockClient({ SolutionId: "105698" }, { inventory: sentinelInventory() });
      client.ftp = () => ({
        async connect() {
          return {
            async xferOut(command) { ftpCmds.push(command); },
            async dele(p) { ftpCmds.push(`DELE ${p}`); },
          };
        },
        quit() {},
      });
      const summary = await resetDanDomainSentinels(client, cfg, () => {});

      assert.equal(client.calls[0]?.op, "Solution_GetWebinfo");
      assert.equal(summary.identityOk, true);
      assert.equal(summary.skippedOrders, true);
      assert.equal(summary.deleted.products, 2);
      assert.equal(summary.deleted.coupons, 2);
      assert.equal(summary.deleted.pages, 1);
      assert.equal(summary.deleted.users, 2);
      assert.equal(summary.deleted.groups, 1);
      assert.equal(summary.deleted.extraBuy, 1);
      assert.equal(summary.deleted.deliveryTimes, 1);
      assert.equal(summary.skippedDeliveryTimes, false);
      assert.deepEqual(summary.remaining.ddseedProducts, []);
      const demoIds = summary.remaining.products1to6.map((p) => Number(p.Id)).sort((a, b) => a - b);
      assert.deepEqual(demoIds, [1, 2, 3, 4, 5, 6]);

      const delIds = client.calls.filter((c) => c.op === "Product_Delete").map((c) => Number(c.args.ProductId));
      for (const id of [1, 2, 3, 4, 5, 6]) {
        assert.equal(delIds.includes(id), false, `must not Product_Delete id ${id}`);
      }
      assert.ok(delIds.includes(101));
      assert.ok(delIds.includes(102));
      assert.ok(client.calls.filter((c) => c.op === "Product_Delete").every((c) => "ProductId" in c.args));

      for (const op of [...FORBIDDEN_SEED_OPS, "Order_Delete"]) {
        assert.equal(client.calls.some((c) => c.op === op), false, op);
      }
      assert.equal(client.calls.some((c) => c.op === "Order_UpdateStatus"), false);
      assert.equal(client.calls.some((c) => c.op === "Order_CompleteTransaction"), false);
      assert.ok(client.ordersByRef.has("F16-EMPTY"));

      assert.equal(ftpCmds.some((c) => /_thumbs|placeholders/.test(String(c))), false);

      const couponIds = client.calls.filter((c) => c.op === "Discount_Delete").map((c) => Number(c.args.DiscountId));
      assert.ok(couponIds.includes(201));
      assert.ok(couponIds.includes(202));
      assert.equal(couponIds.includes(203), false);
      assert.ok(client.calls.filter((c) => c.op === "Discount_Delete").every((c) => "DiscountId" in c.args));

      const byLink = client.calls.find((c) => c.op === "PageText_GetByLink");
      assert.equal(byLink.args.PageTextLink, "ddseed-page-handel");
      const pageDel = client.calls.find((c) => c.op === "PageText_Delete");
      assert.equal(Number(pageDel.args.PageTextId), 301);

      const relDel = client.calls.findIndex((c) => c.op === "Product_DeleteExtraBuyRelation");
      const catDel = client.calls.findIndex((c) => c.op === "Product_DeleteExtraBuyCategory");
      assert.ok(relDel >= 0, "delete ExtraBuy relation");
      assert.ok(catDel >= 0, "delete ExtraBuy category");
      assert.ok(relDel < catDel, "relations before category");
      assert.equal(Number(client.calls[relDel].args.ProductExtraBuyRelationId), 61);
      assert.equal(Number(client.calls[catDel].args.ProductExtraBuyCategoryId), 55);
      assert.equal(
        client.calls.some((c) => c.op === "Product_DeleteExtraBuyCategory" && Number(c.args.ProductExtraBuyCategoryId) === 56),
        false,
      );

      const userDelIdx = client.calls.findIndex((c) => c.op === "User_Delete");
      const groupDelIdx = client.calls.findIndex((c) => c.op === "User_DeleteGroup");
      assert.ok(userDelIdx >= 0 && groupDelIdx > userDelIdx, "users before group");
      assert.equal(Number(client.calls[groupDelIdx].args.UserGroupId), 44);
      assert.equal(
        client.calls.some((c) => c.op === "User_DeleteGroup" && Number(c.args.UserGroupId) === 7),
        false,
      );

      const dtDel = client.calls.find((c) => c.op === "Product_DeleteDeliveryTime");
      assert.equal(Number(dtDel.args.ProductDeliveryTimeId), 77);

      const catDels = client.calls.filter((c) => c.op === "Category_Delete").map((c) => Number(c.args.CategoryId));
      assert.ok(catDels.includes(99));
      for (const id of [11, 12, 13, 14]) {
        assert.equal(catDels.includes(id), false, `must not Category_Delete id ${id}`);
      }

      const after = (await client.call("Product_GetAll")).result;
      const leftoverSeed = after.filter((p) => String(p.ItemNumber).startsWith(SENTINEL) && !(Number(p.Id) >= 1 && Number(p.Id) <= 6));
      assert.deepEqual(leftoverSeed, []);
      assert.equal(after.filter((p) => Number(p.Id) >= 1 && Number(p.Id) <= 6).length, 6);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("isScratchDanDomainShopId: live config shop000000 and numeric 105698 only", () => {
    assert.equal(isScratchDanDomainShopId("105698"), true);
    assert.equal(isScratchDanDomainShopId("shop000000"), true);
    assert.equal(isScratchDanDomainShopId("999999"), false);
    assert.equal(isScratchDanDomainShopId("shop999999"), false);
    assert.equal(isScratchDanDomainShopId(""), false);
  });

  test("reset accepts live config shopId shop000000 when GetWebinfo matches", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-reset-"));
    try {
      const cfg = baseCfg(tmp);
      cfg.source.dandomain.shopId = "shop000000";
      const client = mockClient({ SolutionId: "shop000000" }, { inventory: sentinelInventory() });
      const summary = await resetDanDomainSentinels(client, cfg);
      assert.equal(summary.identityOk, true);
      assert.equal(summary.deleted.products, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("sentinel cleaner matches DDSEED-* including GEN/M/H/XL prefixes", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-reset-"));
    try {
      const cfg = baseCfg(tmp);
      const inv = sentinelInventory({
        products: [
          ...sentinelInventory().products,
          { Id: 201, ItemNumber: `${SENTINEL}P-GEN-0001`, Title: "Plaid Grå No. 0001" },
          { Id: 202, ItemNumber: `${SENTINEL}P-M-0001`, Title: "Pude Natur No. 0001" },
          { Id: 203, ItemNumber: `${SENTINEL}P-H-0001`, Title: "Skål Ærø" },
          { Id: 204, ItemNumber: `${SENTINEL}P-XL-YARN`, Title: "Example garn 120" },
        ],
      });
      const client = mockClient({ SolutionId: "105698" }, { inventory: inv });
      await resetDanDomainSentinels(client, cfg);
      const delIds = client.calls.filter((c) => c.op === "Product_Delete").map((c) => Number(c.args.ProductId));
      for (const id of [201, 202, 203, 204]) {
        assert.ok(delIds.includes(id), `must Product_Delete ${id}`);
      }
      for (const id of [1, 2, 3, 4, 5, 6]) {
        assert.equal(delIds.includes(id), false, `must not Product_Delete id ${id}`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("skips delivery-time delete when the same titles sit on a non-seed product", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dd-reset-"));
    try {
      const cfg = baseCfg(tmp);
      const inv = sentinelInventory();
      inv.products = inv.products.map((p) => (Number(p.Id) === 1 ? { ...p, DeliveryTimeId: 77 } : p));
      const client = mockClient({ SolutionId: "105698" }, { inventory: inv });
      const summary = await resetDanDomainSentinels(client, cfg);
      assert.equal(summary.skippedDeliveryTimes, true);
      assert.equal(summary.deleted.deliveryTimes, 0);
      assert.equal(client.calls.some((c) => c.op === "Product_DeleteDeliveryTime"), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
