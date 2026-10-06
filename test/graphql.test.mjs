/**
 * test/graphql.test.mjs — acceptance tests for src/dandomain/graphql.js.
 *
 * There is no network in this environment and there is no network in CI, so every test drives an
 * INJECTED fetch stub and an INJECTED clock. Nothing here sleeps for real.
 *
 * The tests are written so that each one FAILS if the rule it guards is removed. Where the
 * failure would otherwise be silent (the dangerous case), the test also asserts what a NAIVE
 * client would have returned from the same bytes — see the "negative control" assertions in
 * "error channels" and "content shapes". Those are the ones that matter: a per-query error
 * arriving with HTTP 200 looks exactly like an empty shop unless someone checks.
 *
 * Run: node --test test/graphql.test.mjs
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTH_PATH,
  GRAPHQL_PATHS,
  CONVENTION,
  DOCUMENTED_RATE_PER_SECOND,
  DEFAULT_MIN_INTERVAL_MS,
  TOKEN_EXPIRY_SKEW_MS,
  DEFAULT_ERROR_SELECTION,
  DEFAULT_PAGINATION_SELECTION,
  MOJIBAKE_RE,
  QUERY_REGISTRY,
  GENERATED_QUERY_REGISTRY,
  LIVE_CORRECTIONS,
  QUERY_COUNT,
  buildRegistry,
  queriesByConvention,
  conventionOf,
  describeQuery,
  endpointsFor,
  defaultEndpointFor,
  buildQueryDocument,
  toGraphQLLiteral,
  formatArguments,
  gqlEnum,
  readQueryPayload,
  assertNoTopLevelErrors,
  createPacer,
  isMutationDocument,
  DanDomainGraphQLClient,
  createGraphQLClient,
  GraphQLAuthError,
  GraphQLHttpError,
  GraphQLQueryError,
  GraphQLPayloadError,
  GraphQLShapeError,
  GraphQLPaginationError,
  GraphQLEncodingError,
} from "../src/dandomain/graphql.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "src", "dandomain", "graphql.js");
const SHAPES = JSON.parse(readFileSync(path.join(ROOT, "data", "probes", "gqlshapes.json"), "utf8"));

const TENANT = "probeshop";
const ORIGIN = `https://${TENANT}.mywebshop.io`;

// ---------------------------------------------------------------------------------------------
// Harness: fetch stub + fake clock. Both injected; nothing touches the network or the real clock.
// ---------------------------------------------------------------------------------------------

function makeResponse({ status = 200, json, text, bytes, headers = {}, noArrayBuffer = false }) {
  const body = bytes !== undefined ? null : text !== undefined ? text : JSON.stringify(json ?? {});
  const buf = bytes ?? new TextEncoder().encode(body);
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => lower[String(k).toLowerCase()] ?? null },
    text: async () => new TextDecoder().decode(buf),
  };
  if (!noArrayBuffer) {
    res.arrayBuffer = async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  return res;
}

/**
 * @param {object} routes
 * @param {Function} [routes.token]   ({ form, calls }) => response spec
 * @param {Function} routes.graphql   ({ url, document, endpoint, calls }) => response spec
 */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const isToken = String(url).endsWith(AUTH_PATH);
    const record = { url: String(url), init, isToken };
    if (isToken) {
      record.form = Object.fromEntries(new URLSearchParams(String(init.body)));
    } else {
      record.payload = JSON.parse(String(init.body));
      record.document = record.payload.query;
      record.authorization = init.headers?.authorization ?? null;
    }
    calls.push(record);
    const handler = isToken ? routes.token ?? defaultTokenRoute : routes.graphql;
    if (typeof handler !== "function") throw new Error(`stub has no handler for ${url}`);
    const spec = await handler({ ...record, calls });
    return makeResponse(spec ?? {});
  };
  impl.calls = calls;
  impl.tokenCalls = () => calls.filter((c) => c.isToken);
  impl.gqlCalls = () => calls.filter((c) => !c.isToken);
  return impl;
}

let tokenSerial = 0;
function defaultTokenRoute() {
  tokenSerial += 1;
  return { json: { access_token: `tok-${tokenSerial}`, token_type: "Bearer", expires_in: 3600 } };
}

/** assert.throws()/assert.rejects() do not hand the error back; these do. */
function catches(fn, type) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof type, `expected ${type.name}, got ${e?.name}: ${e?.message}`);
    return e;
  }
  assert.fail(`expected ${type.name}, nothing thrown`);
}

async function catchesAsync(fn, type) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof type, `expected ${type.name}, got ${e?.name}: ${e?.message}`);
    return e;
  }
  assert.fail(`expected ${type.name}, nothing thrown`);
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const slept = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    slept,
    at: () => t,
  };
}

function client(routes, opts = {}) {
  const clock = opts.clock ?? fakeClock();
  const fetchImpl = typeof routes === "function" ? routes : stubFetch(routes);
  const c = new DanDomainGraphQLClient({
    tenant: TENANT,
    clientId: "cid",
    clientSecret: "csecret",
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    minIntervalMs: opts.minIntervalMs ?? 0, // pacing has its own suite; keep the rest instant
    ...opts,
  });
  return { c, fetchImpl, clock };
}

/** Convention-A response body: payload { content: { data, pagination }, errors }. */
const aBody = (name, rows, total, errors = []) => ({
  data: { [name]: { content: { data: rows, pagination: total === null ? null : { total } }, errors } },
});
/** Convention-A response body where `content` is a BARE LIST (pages, productCategories). */
const aBareBody = (name, rows, errors = []) => ({ data: { [name]: { content: rows, errors } } });
/** Convention-B response body: payload { data, pagination }. */
const bBody = (name, rows, total) => ({ data: { [name]: { data: rows, pagination: total === null ? null : { total } } } });

const pageOf = (doc) => Number(/page:\s*(\d+)/.exec(doc)?.[1] ?? NaN);

// ---------------------------------------------------------------------------------------------
describe("registry (F23) — derived from data/probes/gqlshapes.json, never hand-written", () => {
  test("the pinned table is byte-for-byte what buildRegistry() derives from the probe", () => {
    // The GENERATED block, not the shipped registry: LIVE_CORRECTIONS sits on top of it, and
    // this assertion's job is that the generator still reproduces what was generated.
    assert.deepStrictEqual(buildRegistry(SHAPES), GENERATED_QUERY_REGISTRY);
    assert.equal(QUERY_COUNT, 59);
  });

  test("the convention split matches the entities named in the brief", () => {
    const A = [
      "giftCards", "redirects", "blogPosts", "discounts", "productCategories", "pages", "folders",
      "currencies", "languages", "sites", "deliveryCountries", "ordersByCustomerEmail",
      "statisticsDeliveryMethods", "statisticsOrdersV2", "statisticsPaymentMethods",
    ];
    const B = ["orders", "users", "invoices", "domains", "webhooks"];
    for (const name of A) assert.equal(conventionOf(name), CONVENTION.A, `${name} must be Convention A`);
    for (const name of B) assert.equal(conventionOf(name), CONVENTION.B, `${name} must be Convention B`);
    const byConv = queriesByConvention();
    assert.equal(byConv[CONVENTION.A].length, 35);
    assert.equal(byConv[CONVENTION.B].length, 7);
    assert.equal(byConv[CONVENTION.NONE].length, 17);
    // Every A query really does take `input`, every B query really does take `pagination`.
    for (const n of byConv[CONVENTION.A]) assert.ok("input" in QUERY_REGISTRY[n].args, n);
    for (const n of byConv[CONVENTION.B]) assert.ok("pagination" in QUERY_REGISTRY[n].args, n);
  });

  test("NOTE-STATS: the two statistics queries with no input are honestly NOT Convention A", () => {
    // The brief says "statistics*" uses A. The schema says two of them take range/groupBy/limit
    // directly. The registry reports the schema; this test exists so the deviation is visible.
    assert.equal(conventionOf("statisticsCustomers"), CONVENTION.NONE);
    assert.equal(conventionOf("statisticsTopProducts"), CONVENTION.NONE);
    assert.deepStrictEqual(Object.keys(QUERY_REGISTRY.statisticsCustomers.args), ["range", "groupBy", "stat", "sites"]);
  });

  test("row location is data-driven: content is a container for some A queries and a BARE LIST for others", () => {
    for (const n of ["giftCards", "redirects", "discounts", "blogPosts"]) {
      assert.equal(describeQuery(n).contentPaginated, true, n);
      assert.deepStrictEqual(describeQuery(n).rowsPath, ["content", "data"], n);
      assert.equal(describeQuery(n).payloadTypeIntrospected, true, n);
    }
    for (const n of ["pages", "productCategories"]) {
      assert.equal(describeQuery(n).contentPaginated, false, n);
      assert.deepStrictEqual(describeQuery(n).rowsPath, ["content"], n);
      assert.equal(describeQuery(n).payloadTypeIntrospected, true, n);
    }
    for (const n of ["orders", "users", "invoices"]) {
      assert.deepStrictEqual(describeQuery(n).rowsPath, ["data"], n);
      assert.deepStrictEqual(describeQuery(n).paginationPath, ["pagination"], n);
    }
  });

  test("the two honesty flags mean different things: no A container has a VERIFIED row path", () => {
    // All gqlshapes.json ever recorded for a Convention-A payload is the NAME of the content
    // type. Assert that against the artifact, so "verified" cannot be talked back up.
    for (const n of ["giftCards", "redirects", "discounts", "blogPosts"]) {
      const rec = SHAPES.public.payloads?.[n] ?? SHAPES.experimental.payloads?.[n];
      assert.ok(rec, `${n} payload was recorded`);
      const contentType = rec.fields.find((f) => f.startsWith("content:")).slice("content:".length);
      assert.match(contentType, /Pagination$/, `${n} content is a container`);
      // ...and that container type was itself never introspected, so its members are unknown.
      for (const section of [SHAPES.public, SHAPES.experimental]) {
        assert.equal(
          Object.values(section.payloads ?? {}).some((p) => p.payloadType === contentType), false,
          `${contentType} is now introspected — rowsPathVerified may finally be earnable for ${n}`,
        );
      }
      assert.equal(describeQuery(n).payloadTypeIntrospected, true, `${n}: the PAYLOAD type was recorded`);
      assert.equal(describeQuery(n).rowsPathVerified, false, `${n}: content.data is an ANALOGY, not evidence`);
    }
    // Convention B is genuinely verified: the container's own members ARE in the recording.
    assert.deepStrictEqual(SHAPES.public.payloads.orders.fields, ["pagination:PaginationData", "data:NON_NULL"]);
    for (const n of ["orders", "users", "invoices"]) assert.equal(describeQuery(n).rowsPathVerified, true, n);
    // ...as is a bare-list A payload, where `content` IS the row list.
    for (const n of ["pages", "productCategories"]) assert.equal(describeQuery(n).rowsPathVerified, true, n);
    // Not one paginated Convention-A query claims a verified row path — asserted against the
    // GENERATED snapshot, because that is the claim: INTROSPECTION never settled these.
    const A = Object.values(GENERATED_QUERY_REGISTRY).filter((e) => e.convention === CONVENTION.A);
    assert.equal(A.filter((e) => e.contentPaginated).length, 33);
    assert.equal(A.filter((e) => e.contentPaginated && e.rowsPathVerified).length, 0);
  });

  test("R36 — a LIVE correction sits on top of the generated snapshot, and says so", () => {
    // The generated guess: a paginated container. The server contradicted every part of it.
    assert.deepStrictEqual(GENERATED_QUERY_REGISTRY.folders.rowsPath, ["content", "data"]);
    assert.equal(GENERATED_QUERY_REGISTRY.folders.contentPaginated, true);
    assert.equal(GENERATED_QUERY_REGISTRY.folders.rowsPathVerified, false);
    // What ships, and what makes it different from a guess.
    assert.deepStrictEqual(describeQuery("folders").rowsPath, ["content"]);
    assert.equal(describeQuery("folders").contentPaginated, false);
    assert.equal(describeQuery("folders").rowsPathVerified, true);
    assert.match(describeQuery("folders").liveCorrected, /R36/);
    // Exactly one correction, and every correction names its evidence — a correction without a
    // recorded observation is the thing this file exists to prevent.
    assert.deepStrictEqual(Object.keys(LIVE_CORRECTIONS), ["folders"]);
    for (const [n, c] of Object.entries(LIVE_CORRECTIONS)) assert.match(c.liveCorrected ?? "", /data\/probes\//, n);
    // Everything else is untouched, byte for byte.
    for (const [n, e] of Object.entries(GENERATED_QUERY_REGISTRY)) {
      if (n === "folders") continue;
      assert.deepStrictEqual(QUERY_REGISTRY[n], e, n);
    }
  });

  test("payload shapes P1 never introspected are flagged, not silently asserted", () => {
    assert.equal(describeQuery("currencies").payloadTypeIntrospected, false);
    assert.equal(describeQuery("giftCards").payloadTypeIntrospected, true);
    const unverified = Object.values(QUERY_REGISTRY).filter((e) => e.convention === CONVENTION.A && !e.payloadTypeIntrospected);
    assert.equal(unverified.length, 29, "29 of the 35 Convention-A payloads were never introspected");
  });

  test("endpoint placement comes from the probe (public wins when a query exists on both)", () => {
    assert.deepStrictEqual(endpointsFor("orders"), ["public", "experimental"]);
    assert.deepStrictEqual(endpointsFor("pages"), ["experimental"]);
    assert.deepStrictEqual(endpointsFor("giftCards"), ["public"]);
    assert.equal(defaultEndpointFor("orders"), "public");
    assert.equal(defaultEndpointFor("pages"), "experimental");
    assert.equal(defaultEndpointFor("nosuchquery"), null);
  });

  test("a query whose signature differs per endpoint is a hard error, not a silent merge", () => {
    const doctored = structuredClone(SHAPES);
    const orders = doctored.experimental.queries.find((q) => q.name === "orders");
    orders.args = ["input:OrderInput"];
    assert.throws(() => buildRegistry(doctored), GraphQLShapeError);
  });
});

// ---------------------------------------------------------------------------------------------
describe("document builder (F23) — each query is asked in its OWN convention", () => {
  test("Convention A is input-wrapped and selects content + BOTH-channel errors", () => {
    const doc = buildQueryDocument("giftCards", { selection: "id\ncode", page: 1, limit: 50 });
    assert.match(doc, /giftCards\(input: \{pagination: \{page: 1, limit: 50\}\}\)/);
    assert.match(doc, /content \{/);
    assert.match(doc, /data \{/);
    assert.match(doc, /pagination \{ total \}/);
    assert.match(doc, /errors \{ __typename \}/);
    // ...and NOT the documented-but-rejected top-level pagination argument.
    assert.doesNotMatch(doc, /giftCards\(pagination:/);
  });

  test("completeness — blogPosts document is input-wrapped, not pagination:{limit,page}", () => {
    const doc = buildQueryDocument("blogPosts", {
      selection: "__typename",
      limit: 5,
      page: 1,
    });
    assert.match(doc, /blogPosts\s*\(\s*input:/);
    assert.doesNotMatch(doc, /blogPosts\s*\(\s*pagination:/);
  });

  test("completeness — gqldeep source does not send Convention-B blogPosts pagination", () => {
    const src = readFileSync(path.join(ROOT, "scripts", "probe-dandomain.mjs"), "utf8");
    const blogLine = src.split("\n").find((l) => l.includes("blogPostsQuery") && l.includes("gql("));
    assert.ok(blogLine, "gqldeep still assigns blogPostsQuery");
    assert.equal(
      /blogPosts\(pagination:/.test(blogLine),
      false,
      "gqldeep blogPostsQuery must not use pagination:{limit,page} (registry: input-wrapped)",
    );
    assert.match(
      src,
      /buildQueryDocument\s*\(\s*["']blogPosts["']/,
      "gqldeep blogPostsQuery must use graphql.js buildQueryDocument / input-wrapped",
    );
  });

  test("Convention B puts pagination/search/sorting at the top level and has no input wrapper", () => {
    const doc = buildQueryDocument("orders", {
      selection: "id",
      page: 2,
      limit: 10,
      args: { search: { isPaid: true }, sorting: { field: gqlEnum("CREATED_AT") } },
    });
    assert.match(doc, /orders\(pagination: \{page: 2, limit: 10\}, search: \{isPaid: true\}, sorting: \{field: CREATED_AT\}\)/);
    assert.doesNotMatch(doc, /input:/);
    assert.doesNotMatch(doc, /content \{/);
    assert.match(doc, /data \{/);
    assert.match(doc, /pagination \{ total \}/);
  });

  test("a bare-list Convention-A payload does not get a data{} wrapper", () => {
    const doc = buildQueryDocument("pages", { selection: "id\ntitle" });
    assert.match(doc, /content \{\n\s+id\n\s+title\n\s+\}/);
    assert.doesNotMatch(doc, /data \{/);
    assert.doesNotMatch(doc, /pagination \{/);
  });

  test("limit is omitted when the caller did not choose one (page size is discovered, not assumed)", () => {
    const doc = buildQueryDocument("orders", { selection: "id", page: 1 });
    assert.match(doc, /pagination: \{page: 1\}/);
    assert.doesNotMatch(doc, /limit/);
  });

  test("an unknown ARGUMENT name is rejected locally (R17/R27)", () => {
    const e = catches(() => buildQueryDocument("orders", { selection: "id", args: { serach: {} } }), GraphQLShapeError);
    assert.match(e.message, /has no argument "serach"/);
    assert.deepStrictEqual(e.allowed.sort(), ["pagination", "search", "sorting"]);
  });

  test("an unknown QUERY is refused unless the caller states the convention", () => {
    assert.throws(() => buildQueryDocument("productsSomeday", { selection: "id" }), GraphQLShapeError);
    const doc = buildQueryDocument("productsSomeday", { selection: "id", convention: CONVENTION.B, page: 1 });
    assert.match(doc, /productsSomeday\(pagination: \{page: 1\}\)/);
  });

  test("no selection means no document — this client never guesses field names (R4)", () => {
    assert.throws(() => buildQueryDocument("giftCards", {}), GraphQLShapeError);
    assert.throws(() => buildQueryDocument("giftCards", { selection: "   " }), GraphQLShapeError);
  });

  test("pagination on a query that declares none is refused", () => {
    assert.throws(() => buildQueryDocument("orderById", { selection: "id", args: { id: 1 }, page: 1 }), GraphQLShapeError);
    assert.match(buildQueryDocument("orderById", { selection: "id", args: { id: 17 } }), /orderById\(id: 17\)/);
  });

  test("selection sets keep their own nesting", () => {
    const doc = buildQueryDocument("orders", { selection: "id\ncustomer {\n  email\n}" });
    assert.match(doc, /customer \{\n\s+email\n\s+\}/);
  });

  test("errorSelection and paginationSelection are overridable knobs, not baked-in guesses", () => {
    assert.equal(DEFAULT_ERROR_SELECTION, "__typename");
    assert.equal(DEFAULT_PAGINATION_SELECTION, "total");
    const doc = buildQueryDocument("giftCards", { selection: "id", errorSelection: "message field", paginationSelection: "total page" });
    assert.match(doc, /errors \{ message field \}/);
    assert.match(doc, /pagination \{ total page \}/);
    // A scalar `errors` list needs a bare field with no sub-selection.
    assert.match(buildQueryDocument("giftCards", { selection: "id", errorSelection: "" }), /\n\s+errors\n/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("GraphQL literal serialisation", () => {
  test("object keys are UNQUOTED — JSON.stringify output is not valid GraphQL", () => {
    const value = { limit: 5, page: 1 };
    assert.equal(toGraphQLLiteral(value), "{limit: 5, page: 1}");
    assert.notEqual(toGraphQLLiteral(value), JSON.stringify(value));
  });

  test("strings are escaped, enums are bare, undefined members disappear, null survives", () => {
    assert.equal(toGraphQLLiteral('he said "hi"\nbye'), '"he said \\"hi\\"\\nbye"');
    assert.equal(toGraphQLLiteral({ a: undefined, b: null, c: gqlEnum("DESC") }), "{b: null, c: DESC}");
    assert.equal(toGraphQLLiteral([1, "x", true]), '[1, "x", true]');
    assert.equal(toGraphQLLiteral(String.fromCharCode(1)), '"\\u0001"', "control characters are \\uXXXX-escaped");
    assert.equal(toGraphQLLiteral("Æblegrød"), '"Æblegrød"');
  });

  test("non-serialisable values are refused rather than silently coerced", () => {
    assert.throws(() => toGraphQLLiteral(NaN), GraphQLShapeError);
    assert.throws(() => toGraphQLLiteral(() => {}), GraphQLShapeError);
    assert.throws(() => gqlEnum("not an enum"), GraphQLShapeError);
  });

  test("formatArguments drops an all-undefined argument list entirely", () => {
    assert.equal(formatArguments({ a: undefined }), "");
    assert.equal(formatArguments({}), "");
    assert.equal(formatArguments({ id: 4 }), "(id: 4)");
  });
});

// ---------------------------------------------------------------------------------------------
describe("token lifecycle (F12) — mint, reuse, refresh", () => {
  test("mints with OAuth2 client-credentials, form-urlencoded, against {tenant}.mywebshop.io", async () => {
    const { c, fetchImpl } = client({ graphql: () => ({ json: bBody("orders", [{ id: "1" }], 1) }) });
    await c.query("orders", { selection: "id" });
    const t = fetchImpl.tokenCalls();
    assert.equal(t.length, 1);
    assert.equal(t[0].url, `${ORIGIN}${AUTH_PATH}`);
    assert.equal(t[0].init.method, "POST");
    assert.equal(t[0].init.headers["content-type"], "application/x-www-form-urlencoded");
    assert.deepStrictEqual(t[0].form, { grant_type: "client_credentials", client_id: "cid", client_secret: "csecret", scope: "" });
    const g = fetchImpl.gqlCalls();
    assert.equal(g[0].url, `${ORIGIN}${GRAPHQL_PATHS.public}`);
    assert.match(g[0].authorization, /^Bearer tok-\d+$/);
  });

  test("the token is CACHED: three queries, one mint, same bearer on all three", async () => {
    const { c, fetchImpl } = client({ graphql: () => ({ json: bBody("orders", [{ id: "1" }], 1) }) });
    await c.query("orders", { selection: "id" });
    await c.query("orders", { selection: "id" });
    await c.query("orders", { selection: "id" });
    assert.equal(fetchImpl.tokenCalls().length, 1);
    assert.equal(c.tokenMints, 1);
    const auths = new Set(fetchImpl.gqlCalls().map((g) => g.authorization));
    assert.equal(auths.size, 1);
  });

  test("concurrent callers share one in-flight mint", async () => {
    const { c, fetchImpl } = client({ graphql: () => ({ json: bBody("orders", [], 0) }) });
    await Promise.all([c.query("orders", { selection: "id" }), c.query("orders", { selection: "id" }), c.token()]);
    assert.equal(fetchImpl.tokenCalls().length, 1);
  });

  test("refreshes when the server's own expires_in runs out — and not one tick before", async () => {
    const clock = fakeClock();
    let serial = 0;
    const { c, fetchImpl } = client(
      {
        token: () => ({ json: { access_token: `t${++serial}`, token_type: "Bearer", expires_in: 100 } }),
        graphql: () => ({ json: bBody("orders", [], 0) }),
      },
      { clock },
    );
    await c.query("orders", { selection: "id" });
    assert.equal(c.tokenMints, 1);

    // expires_in 100s, skew 30s => the cached token is good for 70s.
    assert.equal(TOKEN_EXPIRY_SKEW_MS, 30_000);
    clock.advance(69_000);
    await c.query("orders", { selection: "id" });
    assert.equal(c.tokenMints, 1, "must NOT refresh before the skew-adjusted expiry");

    clock.advance(2_000);
    await c.query("orders", { selection: "id" });
    assert.equal(c.tokenMints, 2, "must refresh once the skew-adjusted expiry has passed");
    const auths = fetchImpl.gqlCalls().map((g) => g.authorization);
    assert.deepStrictEqual(auths, ["Bearer t1", "Bearer t1", "Bearer t2"]);
  });

  test("a token with no expires_in is reused until a 401 forces a refresh", async () => {
    let serial = 0;
    let refused = 0;
    const { c, fetchImpl } = client({
      token: () => ({ json: { access_token: `n${++serial}` } }),
      graphql: ({ authorization }) => {
        if (authorization === "Bearer n1" && refused++ === 0) return { status: 401, json: { message: "expired" } };
        return { json: bBody("orders", [], 0) };
      },
    });
    await c.query("orders", { selection: "id" });
    assert.equal(c.tokenMints, 2, "401 invalidates the cache and the call is replayed once");
    const auths = fetchImpl.gqlCalls().map((g) => g.authorization);
    assert.deepStrictEqual(auths, ["Bearer n1", "Bearer n2"]);
  });

  test("a second 401 is reported, not looped", async () => {
    const { c, fetchImpl } = client({ graphql: () => ({ status: 401, json: { message: "nope" } }) });
    const e = await catchesAsync(() => c.query("orders", { selection: "id" }), GraphQLHttpError);
    assert.equal(fetchImpl.gqlCalls().length, 2);
    assert.equal(e.status, 401);
  });

  test("a failing token endpoint throws GraphQLAuthError with the evidence attached", async () => {
    const { c } = client({ token: () => ({ status: 401, text: "invalid_client" }), graphql: () => ({ json: {} }) });
    const e = await catchesAsync(() => c.token(), GraphQLAuthError);
    assert.equal(e.status, 401);
    assert.match(e.body, /invalid_client/);
  });

  test("a 200 token response with no access_token is an error, not an empty bearer", async () => {
    const { c } = client({ token: () => ({ json: { token_type: "Bearer" } }), graphql: () => ({ json: {} }) });
    await assert.rejects(() => c.token(), GraphQLAuthError);
  });

  test("a mutation document is never auto-replayed after a 401", async () => {
    assert.equal(isMutationDocument("mutation { x }"), true);
    assert.equal(isMutationDocument("query { x }"), false);
    const { c, fetchImpl } = client({ graphql: () => ({ status: 401, json: {} }) });
    await assert.rejects(() => c.execute({ document: "mutation { productCreate { id } }" }), GraphQLHttpError);
    assert.equal(fetchImpl.gqlCalls().length, 1, "reads may be replayed; writes may not");
  });
});

// ---------------------------------------------------------------------------------------------
describe("error channels (F23) — a 200 is not a success", () => {
  test("CHANNEL 2: a Convention-A payload error throws even though HTTP is 200 and data is present", async () => {
    const body = aBody("giftCards", [], 0, [{ __typename: "GiftCardError", message: "module not enabled" }]);
    const { c } = client({ graphql: () => ({ status: 200, json: body }) });

    // NEGATIVE CONTROL — what a client that only reads the top-level `errors` array would see:
    assert.equal(body.errors, undefined);
    assert.deepStrictEqual(body.data.giftCards.content.data, [], "the naive read is an EMPTY SHOP");

    const e = await catchesAsync(() => c.query("giftCards", { selection: "id" }), GraphQLPayloadError);
    assert.equal(e.channel, "payload");
    assert.equal(e.httpStatus, 200);
    assert.equal(e.query, "giftCards");
    assert.match(e.message, /module not enabled/);
  });

  test("CHANNEL 2 fires even when the payload also carries rows (partial result is still a failure)", () => {
    const body = aBody("redirects", [{ id: "1" }], 99, ["boom"]);
    const e = catches(() => readQueryPayload("redirects", body, { httpStatus: 200 }), GraphQLPayloadError);
    assert.match(e.message, /boom/);
  });

  test("an EMPTY payload errors list is not an error", () => {
    const read = readQueryPayload("giftCards", aBody("giftCards", [{ id: "7" }], 1, []), { httpStatus: 200 });
    assert.deepStrictEqual(read.rows, [{ id: "7" }]);
  });

  test("CHANNEL 1: a top-level errors array throws, even with partial data alongside it", async () => {
    const body = { errors: [{ message: 'Cannot query field "nope"' }], data: { orders: { data: [{ id: "1" }], pagination: { total: 1 } } } };
    const { c } = client({ graphql: () => ({ status: 200, json: body }) });
    const e = await catchesAsync(() => c.query("orders", { selection: "id" }), GraphQLQueryError);
    assert.equal(e.channel, "top-level");
    assert.match(e.message, /Cannot query field/);
    assert.throws(() => assertNoTopLevelErrors(body), GraphQLQueryError);
  });

  test("CHANNEL 1 is checked for Convention-B queries too (they have no payload channel)", async () => {
    const { c } = client({ graphql: () => ({ json: { errors: ["nope"], data: null } }) });
    await assert.rejects(() => c.query("invoices", { selection: "id" }), GraphQLQueryError);
  });

  test("a null payload with neither error channel populated is a shape error, not an empty result", async () => {
    const { c } = client({ graphql: () => ({ json: { data: { giftCards: null } } }) });
    await assert.rejects(() => c.query("giftCards", { selection: "id" }), GraphQLShapeError);
  });

  test("non-2xx is thrown with its body; a 429 is REPORTED, never silently retried (F27)", async () => {
    const { c, fetchImpl } = client({
      graphql: () => ({ status: 429, text: "slow down", headers: { "retry-after": "2", "x-ratelimit-remaining": "0" } }),
    });
    const e = await catchesAsync(() => c.query("orders", { selection: "id" }), GraphQLHttpError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterMs, 2000);
    assert.equal(e.rateLimitRemaining, "0");
    assert.equal(fetchImpl.gqlCalls().length, 1, "no retry loop is keyed to a 429 — F27 proved it may never come");
  });

  test("a non-JSON 200 is a shape error carrying the first bytes, not a crash", async () => {
    const { c } = client({ graphql: () => ({ text: "<html>maintenance</html>" }) });
    const e = await catchesAsync(() => c.query("orders", { selection: "id" }), GraphQLShapeError);
    assert.match(e.body, /maintenance/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("content shapes — rows are read from the shape the payload actually has", () => {
  test("Convention A container: rows under content.data, page metadata under content.pagination", () => {
    const read = readQueryPayload("giftCards", aBody("giftCards", [{ id: "a" }, { id: "b" }], 2), {});
    assert.equal(read.convention, CONVENTION.A);
    assert.equal(read.rows.length, 2);
    assert.deepStrictEqual(read.pagination, { total: 2 });
  });

  test("Convention A BARE LIST (pages/productCategories): content IS the row array", () => {
    const body = aBareBody("pages", [{ id: "1" }, { id: "2" }]);
    // NEGATIVE CONTROL: a client that hardcodes content.data reads undefined here.
    assert.equal(body.data.pages.content.data, undefined);
    const read = readQueryPayload("pages", body, {});
    assert.deepStrictEqual(read.rows, [{ id: "1" }, { id: "2" }]);
    assert.equal(read.pagination, null);
  });

  test("Convention B: rows under data, page metadata under pagination", () => {
    const read = readQueryPayload("orders", bBody("orders", [{ id: "9" }], 1), {});
    assert.equal(read.convention, CONVENTION.B);
    assert.deepStrictEqual(read.rows, [{ id: "9" }]);
    assert.deepStrictEqual(read.pagination, { total: 1 });
  });

  test("a payload that is neither (statistics*) is handed back whole with rows:null", () => {
    const body = { data: { statisticsOrdersV2: { errors: [], revenue: 42 } } };
    const read = readQueryPayload("statisticsOrdersV2", body, {});
    assert.equal(read.rows, null);
    assert.equal(read.payload.revenue, 42);
  });

  test("content:null with no errors is an empty page, not a crash", () => {
    const read = readQueryPayload("giftCards", { data: { giftCards: { content: null, errors: [] } } }, {});
    assert.deepStrictEqual(read.rows, []);
  });

  test("a container with no row list at all is a shape error", () => {
    assert.throws(
      () => readQueryPayload("orders", { data: { orders: { pagination: { total: 3 } } } }, {}),
      GraphQLShapeError,
    );
  });

  test("a response missing the queried field is a shape error", () => {
    assert.throws(() => readQueryPayload("orders", { data: { somethingElse: {} } }, {}), GraphQLShapeError);
  });
});

// ---------------------------------------------------------------------------------------------
describe("pagination — transparent in BOTH conventions", () => {
  test("Convention B walks pages until total is satisfied", async () => {
    const pages = { 1: [{ id: "1" }, { id: "2" }], 2: [{ id: "3" }, { id: "4" }], 3: [{ id: "5" }] };
    const { c, fetchImpl } = client({ graphql: ({ document }) => ({ json: bBody("orders", pages[pageOf(document)], 5) }) });
    const out = await c.fetchAll("orders", { selection: "id", limit: 2 });
    assert.deepStrictEqual(out.rows.map((r) => r.id), ["1", "2", "3", "4", "5"]);
    assert.equal(out.pages, 3);
    assert.equal(out.total, 5);
    assert.equal(out.complete, true);
    assert.deepStrictEqual(fetchImpl.gqlCalls().map((g) => pageOf(g.document)), [1, 2, 3]);
  });

  test("Convention A walks pages under content.data, with the page arg inside the input", async () => {
    const pages = { 1: [{ id: "a" }, { id: "b" }], 2: [{ id: "c" }] };
    const { c, fetchImpl } = client({ graphql: ({ document }) => ({ json: aBody("giftCards", pages[pageOf(document)], 3) }) });
    const out = await c.fetchAll("giftCards", { selection: "id", limit: 2 });
    assert.deepStrictEqual(out.rows.map((r) => r.id), ["a", "b", "c"]);
    assert.equal(out.pages, 2);
    assert.equal(out.complete, true);
    for (const g of fetchImpl.gqlCalls()) assert.match(g.document, /giftCards\(input: \{pagination: \{page: \d+, limit: 2\}\}\)/);
  });

  test("a bare-list Convention-A query paginates blind and stops on the first empty page", async () => {
    const pages = { 1: [{ id: "p1" }, { id: "p2" }], 2: [{ id: "p3" }, { id: "p4" }], 3: [] };
    const { c } = client({ graphql: ({ document }) => ({ json: aBareBody("pages", pages[pageOf(document)]) }) });
    const out = await c.fetchAll("pages", { selection: "id", limit: 2 });
    assert.deepStrictEqual(out.rows.map((r) => r.id), ["p1", "p2", "p3", "p4"]);
    assert.equal(out.pages, 3);
    assert.equal(out.total, null);
  });

  test("a short page ends the walk", async () => {
    const pages = { 1: [{ id: "1" }, { id: "2" }], 2: [{ id: "3" }] };
    const { c, fetchImpl } = client({ graphql: ({ document }) => ({ json: bBody("orders", pages[pageOf(document)], null) }) });
    const out = await c.fetchAll("orders", { selection: "id", limit: 2 });
    assert.equal(out.rows.length, 3);
    assert.equal(fetchImpl.gqlCalls().length, 2);
  });

  test("with no configured page size the page size is DISCOVERED from page 1", async () => {
    const pages = { 1: [{ id: "1" }, { id: "2" }, { id: "3" }], 2: [{ id: "4" }] };
    const { c, fetchImpl } = client({ graphql: ({ document }) => ({ json: bBody("orders", pages[pageOf(document)], null) }) });
    const out = await c.fetchAll("orders", { selection: "id" });
    assert.equal(out.rows.length, 4);
    assert.equal(fetchImpl.gqlCalls().length, 2);
    assert.doesNotMatch(fetchImpl.gqlCalls()[0].document, /limit/);
  });

  test("a server that IGNORES `page` while rows are outstanding throws — it never truncates quietly", async () => {
    const { c } = client({ graphql: () => ({ json: bBody("orders", [{ id: "1" }, { id: "2" }], 10) }) });
    // maxPages is only here so that DELETING the repeat guard fails this test instead of hanging
    // the suite — without the guard this walk never terminates, which is the point.
    const e = await catchesAsync(() => c.fetchAll("orders", { selection: "id", limit: 2, maxPages: 20 }), GraphQLPaginationError);
    assert.match(e.message, /ignoring `page`/);
    assert.equal(e.total, 10);
    assert.equal(e.seen, 2);
  });

  test("a repeated page with no total known stops the walk and says pagination was not honoured", async () => {
    const { c } = client({ graphql: () => ({ json: aBareBody("pages", [{ id: "x" }, { id: "y" }]) }) });
    // maxPages again only so that deleting the repeat guard fails loudly instead of spinning.
    const out = await c.fetchAll("pages", { selection: "id", limit: 2, maxPages: 20 });
    assert.deepStrictEqual(out.rows.map((r) => r.id), ["x", "y"]);
    assert.equal(out.paginationHonoured, false);
    assert.equal(out.complete, false);
  });

  test("maxPages with work outstanding is an error, not a short read", async () => {
    const pages = { 1: [{ id: "1" }], 2: [{ id: "2" }], 3: [{ id: "3" }] };
    const { c } = client({ graphql: ({ document }) => ({ json: bBody("orders", pages[pageOf(document)], 3) }) });
    await assert.rejects(() => c.fetchAll("orders", { selection: "id", limit: 1, maxPages: 2 }), GraphQLPaginationError);
  });

  test("paginating a non-paginated query is refused", async () => {
    const { c } = client({ graphql: () => ({ json: { data: { orderById: { id: "17" } } } }) });
    await assert.rejects(
      () => c.fetchAll("orderById", { selection: "id", args: { id: 17 } }),
      GraphQLPaginationError,
    );
  });

  test("a payload error on page 2 aborts the walk instead of returning page 1 as the whole shop", async () => {
    const { c } = client({
      graphql: ({ document }) =>
        pageOf(document) === 1
          ? { json: aBody("giftCards", [{ id: "a" }, { id: "b" }], 6) }
          : { json: aBody("giftCards", [], 6, [{ message: "rate exceeded" }]) },
    });
    await assert.rejects(() => c.fetchAll("giftCards", { selection: "id", limit: 2 }), GraphQLPayloadError);
  });

  test("paginate() yields pages one at a time for streaming callers", async () => {
    const pages = { 1: [{ id: "1" }], 2: [{ id: "2" }] };
    const { c } = client({ graphql: ({ document }) => ({ json: bBody("orders", pages[pageOf(document)], 2) }) });
    const seen = [];
    for await (const p of c.paginate("orders", { selection: "id", limit: 1 })) seen.push(p.page);
    assert.deepStrictEqual(seen, [1, 2]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("pacing (F27) — pace, do not react", () => {
  test("the documented rate is the default floor and it is applied to every request", async () => {
    assert.equal(DOCUMENTED_RATE_PER_SECOND, 5);
    assert.equal(DEFAULT_MIN_INTERVAL_MS, 200);
    const clock = fakeClock();
    const { c } = client({ graphql: () => ({ json: bBody("orders", [], 0) }) }, { clock, minIntervalMs: undefined });
    await c.query("orders", { selection: "id" });
    await c.query("orders", { selection: "id" });
    await c.query("orders", { selection: "id" });
    // 4 requests total (1 token + 3 GraphQL); the first is free, each later one waits the floor.
    assert.deepStrictEqual(clock.slept, [200, 200, 200]);
  });

  test("concurrent callers are serialised by the pacer, not stacked on the same instant", async () => {
    const clock = fakeClock();
    const { c } = client({ graphql: () => ({ json: bBody("orders", [], 0) }) }, { clock, minIntervalMs: 200 });
    await Promise.all([1, 2, 3].map(() => c.query("orders", { selection: "id" })));
    assert.deepStrictEqual(clock.slept, [200, 200, 200]);
  });

  test("time already spent counts against the interval", async () => {
    const clock = fakeClock();
    const { c } = client(
      {
        graphql: () => {
          clock.advance(150); // pretend the round trip took 150ms
          return { json: bBody("orders", [], 0) };
        },
      },
      { clock, minIntervalMs: 200 },
    );
    await c.query("orders", { selection: "id" });
    await c.query("orders", { selection: "id" });
    assert.deepStrictEqual(clock.slept, [200, 50]);
  });

  test("createPacer is usable and testable on its own", async () => {
    const clock = fakeClock();
    const pacer = createPacer({ minIntervalMs: 500, now: clock.now, sleep: clock.sleep });
    await pacer.wait();
    await pacer.wait();
    assert.deepStrictEqual(clock.slept, [500]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("encoding (F2) — decode as UTF-8 explicitly, fail loudly on mojibake", () => {
  test("Danish text survives a byte-level round trip", async () => {
    const { c } = client({ graphql: () => ({ json: bBody("orders", [{ id: "1", title: "Æblegrød" }], 1) }) });
    const out = await c.query("orders", { selection: "id title" });
    assert.equal(out.rows[0].title, "Æblegrød");
  });

  test("a double-encoded response is refused instead of being imported as garbage", async () => {
    const mojibake = JSON.stringify({ data: { orders: { data: [{ id: "1", title: "Ã†blegrÃ¸d" }], pagination: { total: 1 } } } });
    assert.ok(MOJIBAKE_RE.test(mojibake), "fixture really is mojibake");
    const { c } = client({ graphql: () => ({ text: mojibake }) });
    const e = await catchesAsync(() => c.query("orders", { selection: "id title" }), GraphQLEncodingError);
    assert.match(e.sample, /Ã/);
  });

  test("the check is a knob, so a shop with legitimately odd text can still be read", async () => {
    const mojibake = JSON.stringify({ data: { orders: { data: [{ id: "Ã¸" }], pagination: { total: 1 } } } });
    const { c } = client({ graphql: () => ({ text: mojibake }) }, { mojibakeCheck: false });
    const out = await c.query("orders", { selection: "id" });
    assert.equal(out.rows[0].id, "Ã¸");
  });

  test("a fetch stub without arrayBuffer() still works (text() fallback)", async () => {
    const { c } = client({ graphql: () => ({ json: bBody("orders", [{ id: "1" }], 1), noArrayBuffer: true }) });
    const out = await c.query("orders", { selection: "id" });
    assert.equal(out.rows.length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("module invariants", () => {
  test("fetch is resolved at CALL time, so importing the module never touches globals", () => {
    const saved = globalThis.fetch;
    try {
      // eslint-disable-next-line no-global-assign
      globalThis.fetch = undefined;
      const c = new DanDomainGraphQLClient({ tenant: TENANT, clientId: "a", clientSecret: "b" });
      assert.throws(() => c.fetchImpl, GraphQLShapeError);
      globalThis.fetch = () => {};
      assert.equal(typeof c.fetchImpl, "function");
    } finally {
      globalThis.fetch = saved;
    }
  });

  test("the module prints nothing and exits nothing (invariant #4)", () => {
    // Comments are stripped first — the header TALKS about process.exit, the code must not use it.
    const code = readFileSync(SRC, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /console\s*\./);
    assert.doesNotMatch(code, /process\.exit/);
    assert.doesNotMatch(code, /\bimport\s[^\n]*from\s+["']/, "zero runtime dependencies, no imports at all");
  });

  test("credentials and tenant are required up front", () => {
    assert.throws(() => new DanDomainGraphQLClient({ clientId: "a", clientSecret: "b" }), GraphQLShapeError);
    assert.throws(() => new DanDomainGraphQLClient({ tenant: TENANT, clientId: "a" }), GraphQLShapeError);
    const c = createGraphQLClient({ tenant: TENANT, clientId: "a", clientSecret: "b" });
    assert.equal(c.baseUrl, ORIGIN);
    assert.equal(c.urlFor("experimental"), `${ORIGIN}/api/graphql/experimental`);
    assert.throws(() => c.urlFor("private"), GraphQLShapeError);
  });

  test("baseUrl overrides the tenant host (the probe found a second host candidate)", () => {
    const c = createGraphQLClient({ tenant: TENANT, baseUrl: "https://x.webshop.dandomain.dk/", clientId: "a", clientSecret: "b" });
    assert.equal(c.baseUrl, "https://x.webshop.dandomain.dk");
  });

  test("the endpoint is chosen from the registry, and an explicit endpoint wins", async () => {
    const { c, fetchImpl } = client({ graphql: () => ({ json: aBareBody("pages", []) }) });
    await c.query("pages", { selection: "id" });
    assert.equal(fetchImpl.gqlCalls()[0].url, `${ORIGIN}${GRAPHQL_PATHS.experimental}`);
    await c.query("pages", { selection: "id", endpoint: "public" });
    assert.equal(fetchImpl.gqlCalls()[1].url, `${ORIGIN}${GRAPHQL_PATHS.public}`);
  });
});

// ---------------------------------------------------------------------------------------------
// The stop conditions must PROVE completeness. A short read here is a migration that drops rows.
// ---------------------------------------------------------------------------------------------
describe("pagination never stops early and quietly", () => {
  test("a server-side page CAP does not end the walk (limit is a request, not a fact)", async () => {
    // The caller asks for 100/page; the server caps at 50; the shop has 120 rows and does not
    // report a total. Treating the caller's limit as the page size read 50 and said complete.
    const all = Array.from({ length: 120 }, (_, i) => ({ id: String(i + 1) }));
    const CAP = 50;
    const { c, fetchImpl } = client({
      graphql: ({ document }) => {
        const p = pageOf(document);
        return { json: aBareBody("pages", all.slice((p - 1) * CAP, p * CAP)) };
      },
    });
    const out = await c.fetchAll("pages", { selection: "id", limit: 100 });
    assert.equal(out.rows.length, 120, "every row must be read despite the server's cap");
    assert.equal(out.pages, 3);
    assert.equal(fetchImpl.gqlCalls().length, 3);
    assert.equal(out.complete, true);
    assert.deepStrictEqual(out.rows.at(-1), { id: "120" });
  });

  test("a short page while `total` says rows are outstanding THROWS, like the repeat guard does", async () => {
    // Same condition as the repeated-page branch (total known, seen < total) — same answer.
    const page = (n, count) => Array.from({ length: count }, (_, i) => ({ id: `${n}-${i}` }));
    const { c } = client({
      graphql: ({ document }) => ({ json: bBody("orders", pageOf(document) === 1 ? page(1, 50) : page(2, 20), 120) }),
    });
    const err = await catchesAsync(() => c.fetchAll("orders", { selection: "id", limit: 100 }), GraphQLPaginationError);
    assert.match(err.message, /short page \(20 of 50\)/);
    assert.match(err.message, /50 of 120 rows are still unread/);
    assert.equal(err.reason, "short-page-with-rows-outstanding");
  });

  test("`total` that contradicts the rows on one page is refused, not believed", async () => {
    // PaginationData was never introspected: `total` may be a PAGE count. A page holding more
    // rows than the claimed total proves it is not a row count. Believing it read 50 of 250.
    const all = Array.from({ length: 250 }, (_, i) => ({ id: String(i + 1) }));
    const { c } = client({
      graphql: ({ document }) => {
        const p = pageOf(document);
        return { json: bBody("orders", all.slice((p - 1) * 50, p * 50), 5) }; // total = 5 PAGES
      },
    });
    const err = await catchesAsync(() => c.fetchAll("orders", { selection: "id", limit: 50 }), GraphQLPaginationError);
    assert.equal(err.reason, "total-is-not-a-row-count");
    assert.match(err.message, /50 rows on page 1 while pagination\.total is 5/);
    assert.match(err.message, /never introspected/);
  });

  test("fetchAll refuses to report a KNOWN shortfall as a result", async () => {
    // Page 1 empty while the server says 500 rows exist — a refused or filtered page. The old
    // code returned rows:[] complete:false and left it to a caller to notice.
    const { c } = client({ graphql: () => ({ json: bBody("orders", [], 500) }) });
    const err = await catchesAsync(() => c.fetchAll("orders", { selection: "id" }), GraphQLPaginationError);
    assert.equal(err.reason, "short-of-total");
    assert.match(err.message, /read 0 of 500 rows/);
    // The rows are still reachable for a caller who deliberately wants a partial read.
    const partial = await c.fetchAll("orders", { selection: "id", allowIncomplete: true });
    assert.deepStrictEqual(partial.rows, []);
    assert.equal(partial.complete, false);
    assert.equal(partial.total, 500);
  });

  test("a complete walk is still reported complete (the guards do not fire on healthy data)", async () => {
    const all = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1) }));
    const { c } = client({
      graphql: ({ document }) => {
        const p = pageOf(document);
        return { json: bBody("orders", all.slice((p - 1) * 3, p * 3), 7) };
      },
    });
    const out = await c.fetchAll("orders", { selection: "id", limit: 3 });
    assert.equal(out.rows.length, 7);
    assert.equal(out.pages, 3);
    assert.equal(out.complete, true);
    assert.equal(out.paginationHonoured, true);
  });

  test("the repeat guard's keyless false-positive is reported, and disappears with ids", async () => {
    // rowSignature falls back to comparing whole pages by value when rows carry no id, so three
    // genuinely different pages of identically-titled rows look like a repeat. Documented, and
    // visible in the flags rather than silent.
    const keyless = () => [{ title: "Sale" }, { title: "Sale" }];
    const { c } = client({ graphql: () => ({ json: aBody("giftCards", keyless(), null) }) });
    const out = await c.fetchAll("giftCards", { selection: "title", limit: 2 });
    assert.equal(out.rows.length, 2, "the guard stopped the walk after one usable page");
    assert.equal(out.paginationHonoured, false, "...and said so");
    assert.equal(out.complete, false);
    // With ids the same three pages walk properly, because the signature can tell them apart.
    const withIds = (n) => [{ id: `${n}a` }, { id: `${n}b` }];
    const { c: c2 } = client({
      graphql: ({ document }) => ({ json: aBody("giftCards", pageOf(document) <= 3 ? withIds(pageOf(document)) : [], null) }),
    });
    const good = await c2.fetchAll("giftCards", { selection: "id", limit: 2 });
    assert.equal(good.rows.length, 6);
    assert.equal(good.paginationHonoured, true);
    assert.equal(good.complete, true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("F2 — bytes are decoded as UTF-8 or the read FAILS", () => {
  // windows-1252 "Æblegrød": the byte pattern P1's encbytes probe proved this platform stores
  // natively. A non-fatal decoder turns it into U+FFFD, which is not reversible, and
  // MOJIBAKE_RE only catches the OTHER direction (valid UTF-8 that is itself double-encoded).
  const cp1252 = (s) => new Uint8Array([...s].map((ch) => {
    const cp = ch.codePointAt(0);
    return cp < 0x100 ? cp : 0x3f;
  }));

  test("a windows-1252 body throws GraphQLEncodingError instead of importing U+FFFD", async () => {
    const body = `{"data":{"orders":{"data":[{"title":"Æblegrød"}],"pagination":{"total":1}}}}`;
    const { c } = client({ graphql: () => ({ bytes: cp1252(body) }) });
    const err = await catchesAsync(() => c.query("orders", { selection: "title" }), GraphQLEncodingError);
    assert.match(err.message, /not valid UTF-8/);
    assert.match(err.sample, /first invalid byte near offset \d+/);
    // Prove the premise: those bytes really do decode to replacement characters non-fatally.
    assert.match(new TextDecoder("utf-8").decode(cp1252(body)), /�/);
    assert.equal(MOJIBAKE_RE.test(new TextDecoder("utf-8").decode(cp1252(body))), false,
      "the mojibake detector cannot catch this direction — only a fatal decode can");
  });

  test("the byte path is the one in use: a charset-obeying text() is never trusted", async () => {
    // The stub's arrayBuffer() returns the true UTF-8 bytes while its text() mimics a runtime
    // that obeyed `charset=iso-8859-1`. Only the arrayBuffer path yields correct Danish, so
    // deleting decodeUtf8() and falling through to res.text() fails here.
    const json = { data: { orders: { data: [{ title: "Æblegrød" }], pagination: { total: 1 } } } };
    const utf8 = new TextEncoder().encode(JSON.stringify(json));
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith(AUTH_PATH)) {
        const buf = new TextEncoder().encode(JSON.stringify({ access_token: "t", expires_in: 3600 }));
        return {
          ok: true, status: 200, headers: { get: () => null },
          arrayBuffer: async () => buf.buffer.slice(0),
          text: async () => new TextDecoder("windows-1252").decode(buf),
        };
      }
      void init;
      return {
        ok: true, status: 200, headers: { get: () => null },
        arrayBuffer: async () => utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength),
        // what a charset-obeying runtime would have handed back
        text: async () => new TextDecoder("windows-1252").decode(utf8),
      };
    };
    const c = new DanDomainGraphQLClient({
      tenant: TENANT, clientId: "c", clientSecret: "s", fetchImpl, minIntervalMs: 0,
      now: () => 0, sleep: async () => {},
    });
    const out = await c.query("orders", { selection: "title" });
    assert.deepStrictEqual(out.rows, [{ title: "Æblegrød" }]);
    assert.equal(new TextDecoder("windows-1252").decode(utf8).includes("Æblegrød"), false,
      "the text() fallback really would have corrupted this");
  });
});

// ---------------------------------------------------------------------------------------------
describe("arguments are refused rather than silently coerced", () => {
  test("a Date (and anything else with no own enumerable keys) is refused, not serialised as {}", () => {
    // DateTimeRangeInput is a real argument type in the recorded schema: statisticsCustomers.range
    // and webhookActivity.period. `{from: new Date(...)}` is the obvious thing to write, and it
    // used to emit `range: {from: {}, to: {}}` — a legal-looking document with no dates in it.
    assert.deepStrictEqual(Object.keys(QUERY_REGISTRY.statisticsCustomers.args), ["range", "groupBy", "stat", "sites"]);
    assert.equal(QUERY_REGISTRY.statisticsCustomers.args.range, "DateTimeRangeInput");
    const err = catches(() => toGraphQLLiteral(new Date("2024-01-01T00:00:00Z")), GraphQLShapeError);
    assert.match(err.message, /cannot serialise a Date/);
    assert.equal(err.kind, "Date");
    catches(() => toGraphQLLiteral(new Map([[1, 2]])), GraphQLShapeError);
    catches(() => toGraphQLLiteral(new Set([1])), GraphQLShapeError);
    catches(() => toGraphQLLiteral(new URL("https://x.test/")), GraphQLShapeError);
    // ...including nested inside an input, which is where it actually happens.
    catches(() => buildQueryDocument("statisticsCustomers", {
      selection: "count",
      args: { range: { from: new Date("2024-01-01T00:00:00Z") }, groupBy: gqlEnum("DAY") },
    }), GraphQLShapeError);
    // The conversion the caller has to make explicitly still works.
    assert.equal(
      toGraphQLLiteral({ from: new Date("2024-01-01T00:00:00Z").toISOString() }),
      "{from: \"2024-01-01T00:00:00.000Z\"}",
    );
    // Plain objects, null-prototype objects and arrays are untouched.
    assert.equal(toGraphQLLiteral({ a: 1 }), "{a: 1}");
    assert.equal(toGraphQLLiteral(Object.assign(Object.create(null), { a: 1 })), "{a: 1}");
    assert.equal(toGraphQLLiteral([{ a: 1 }]), "[{a: 1}]");
    assert.equal(toGraphQLLiteral(gqlEnum("DAY")), "DAY");
  });

  test("args.input / args.pagination cannot silently swallow page and limit", () => {
    // `...args` is spread after the merged input, so a caller-supplied `input` used to win —
    // and the arg-name validator waved it through because `input` is a legal schema argument.
    const err = catches(() => buildQueryDocument("giftCards", {
      selection: "id", page: 3, limit: 10, args: { input: { search: "x" } },
    }), GraphQLShapeError);
    assert.match(err.message, /both args\.input and input\/page\/limit/);
    catches(() => buildQueryDocument("orders", {
      selection: "id", page: 3, limit: 10, args: { pagination: { page: 1 } },
    }), GraphQLShapeError);
    // Merging through `input` is the supported way, and it keeps the pagination.
    const doc = buildQueryDocument("giftCards", { selection: "id", page: 3, limit: 10, input: { search: "x" } });
    assert.match(doc, /search: "x"/);
    assert.match(doc, /pagination: \{page: 3, limit: 10\}/);
    // args without the collision is still fine.
    assert.match(buildQueryDocument("orders", { selection: "id", page: 2, args: { search: { q: "a" } } }),
      /pagination: \{page: 2\}/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("replay, tokens and row-path drift", () => {
  test("allowReauth cannot switch a mutation's replay back ON (F16)", async () => {
    let mutationPosts = 0;
    const { c } = client({
      graphql: ({ document }) => {
        if (/^\s*mutation\b/.test(document)) mutationPosts += 1;
        return { status: 401, json: { errors: [{ message: "expired" }] } };
      },
    });
    await catchesAsync(
      () => c.execute({ document: "mutation { orderCreate { id } }", allowReauth: true }),
      GraphQLHttpError,
    );
    assert.equal(mutationPosts, 1, "a write is never replayed, whatever the option says");
    // The option can still turn replay OFF for a read.
    let readPosts = 0;
    const { c: c2 } = client({
      graphql: () => { readPosts += 1; return { status: 401, json: { errors: [{ message: "expired" }] } }; },
    });
    await catchesAsync(() => c2.execute({ document: "query { orders { data { id } } }", allowReauth: false }), GraphQLHttpError);
    assert.equal(readPosts, 1);
  });

  test("a pathological expires_in cannot cost a token mint per request", async () => {
    // expires_in 10 s against a 30 s skew was a token born expired: re-minted before EVERY
    // request, each mint consuming a paced slot. The skew is clamped to half the lifetime.
    const clock = fakeClock();
    const { c } = client({
      token: () => ({ json: { access_token: "short", expires_in: 10 } }),
      graphql: () => ({ json: bBody("orders", [{ id: "1" }], 1) }),
    }, { clock });
    await c.query("orders", { selection: "id" });
    await c.query("orders", { selection: "id" });
    assert.equal(c.tokenMints, 1, "the token must be reused inside its (clamped) lifetime");
    assert.equal(c.tokenExpiresAt, clock.at() + 5000, "10s lifetime, skew clamped to 5s — and visible");
    // A normal lifetime still gets the full skew.
    const { c: c2 } = client({
      token: () => ({ json: { access_token: "long", expires_in: 3600 } }),
      graphql: () => ({ json: bBody("orders", [{ id: "1" }], 1) }),
    }, { clock: fakeClock() });
    await c2.query("orders", { selection: "id" });
    assert.equal(c2.tokenExpiresAt, 1_700_000_000_000 + 3600 * 1000 - TOKEN_EXPIRY_SKEW_MS);
  });

  test("where the rows were found is reported, and contradicting the RECORDED shape throws", () => {
    // The pinned rowsPath drove the document and nothing else. Now the reader says which path it
    // used, so drift is visible — and where the recording actually settles the path (Convention
    // B, bare-list A), a disagreement is refused rather than sniffed around.
    const a = readQueryPayload("giftCards", aBody("giftCards", [{ id: "1" }], 1));
    assert.deepStrictEqual(a.rowsPath, ["content", "data"]);
    assert.equal(a.rowsPathMatchedRegistry, true);
    // giftCards' path is inference (rowsPathVerified:false), so a bare list is REPORTED...
    const drifted = readQueryPayload("giftCards", aBareBody("giftCards", [{ id: "z" }]));
    assert.deepStrictEqual(drifted.rows, [{ id: "z" }]);
    assert.deepStrictEqual(drifted.rowsPath, ["content"]);
    assert.equal(drifted.rowsPathMatchedRegistry, false, "the disagreement must be visible");
    // ...while `pages` IS recorded as a bare list, so a container there is a real schema change.
    const err = catches(() => readQueryPayload("pages", aBody("pages", [{ id: "1" }], 1)), GraphQLShapeError);
    assert.equal(err.reason, "rows-path-drift");
    assert.match(err.message, /the payload shape changed/);
    assert.equal(readQueryPayload("orders", bBody("orders", [{ id: "1" }], 1)).rowsPathMatchedRegistry, true);
  });
});
