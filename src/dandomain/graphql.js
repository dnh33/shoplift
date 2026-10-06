/**
 * src/dandomain/graphql.js — GraphQL transport for the DanDomain (Hostedshop) API.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 * -------------------------------------
 * P1 probed this API live (scripts/probe-dandomain.mjs, sections `graphql`, `gqldeep`,
 * `gqlshapes`). Three of its findings are structural — they decide the shape of this module,
 * and none of them can be recovered by reading the vendor documentation:
 *
 *   F12  Auth is OAuth2 client-credentials against `{tenant}.mywebshop.io/auth/oauth/token`
 *        (form-urlencoded, not JSON), and the token comes back with an `expires_in`. The token
 *        is therefore CACHED and refreshed from the server's own number — never from a constant
 *        in this file (invariant #3: no shop- or plan-dependent magic numbers). See TokenCache.
 *
 *   F23  There are TWO query conventions on one schema and a client must implement BOTH:
 *          A) input-wrapped:   query(input: XInput) -> XPayload { content, errors }
 *          B) top-level args:  query(pagination, search, sorting) -> XPagination { pagination, data }
 *        The docs describe (B) as universal. It is not: the `gqlshapes` probe was written
 *        precisely because `pagination:{limit,page}` is REJECTED by giftCards/redirects/
 *        blogPosts while invoices accepts it. So the convention is never inferred at runtime and
 *        never hand-coded per query — it is DERIVED from the recorded introspection
 *        (data/probes/gqlshapes.json) by buildRegistry() and pinned in QUERY_REGISTRY below.
 *        test/graphql.test.mjs re-derives the table from that artifact and diffs it, so a hand
 *        edit to the table fails the build. Derivation rule, in full:
 *            arg named `input`      -> Convention A
 *            else arg named `pagination` -> Convention B
 *            else                   -> no pagination convention (id lookups, arg-less queries,
 *                                      and statisticsCustomers/statisticsTopProducts, which take
 *                                      range/groupBy/limit directly — see NOTE-STATS below).
 *
 *   F23  (second half) BOTH error channels must be read. A Convention-A payload carries its own
 *        `errors` list and the HTTP call is still 200 with `data` present. Reading only the
 *        top-level `errors` array turns a per-query failure into a silently EMPTY result set —
 *        for a migration that is a shop that "has no redirects" rather than a shop whose redirect
 *        query was refused. readQueryPayload() checks the payload channel BEFORE it reads rows,
 *        and throws GraphQLPayloadError. There is a test that fails without that check.
 *
 *   F27  The documented rate limit (5 req/s) was NOT enforced live. The burst probe fired 12
 *        rapid calls and recorded each one's status, `retry-after` and `x-ratelimit-remaining`
 *        (scripts/probe-dandomain.mjs, probeGqlDeep) — and the finding is that the documented
 *        limit did not bite. So there may be NO signal at all: no 429, no header, nothing to
 *        react to. That is the reason this client PACES (a fixed minimum interval, applied
 *        unconditionally to every request including the token mint) instead of REACTING.
 *        Retry-on-429 logic would be dead code that assumes a signal the server may never send,
 *        and the failure it is supposed to prevent would arrive as something else entirely.
 *        If a 429 does show up it is surfaced as GraphQLHttpError with any Retry-After parsed
 *        onto it — reported, never silently slept-and-retried.
 *
 * TWO SELECTION DEFAULTS THAT LOOK TIMID AND ARE NOT (R4, by analogy)
 * -------------------------------------------------------------------
 * R4 on the SOAP side: one invalid field name faults the WHOLE call. GraphQL is worse — one
 * unknown subfield is a validation error that fails the entire document, so an over-eager
 * default selection would break every query on this transport. The introspection we actually
 * hold resolves `errors` only to `NON_NULL` (the probe's type walk stops three levels down) and
 * PaginationData's field list was never captured; the only pagination subfield P1 ever ran live
 * is `total` (`{redirects{content{...}pagination{total}}}` and `{...pagination{total}}`).
 * Therefore:
 *   - DEFAULT_ERROR_SELECTION = "__typename" — always legal on an object type and enough to
 *     DETECT a non-empty error channel, which is the load-bearing requirement. Callers who know
 *     the concrete error type pass errorSelection:"message field" and get detail.
 *   - DEFAULT_PAGINATION_SELECTION = "total" — the only field proven to exist.
 * Both are options, not constants baked into the document builder.
 *
 * NOTE-A-INPUT: the `*Input` TYPES were never introspected (the probe captured query args and
 * payload fields only). So the NAME of the pagination field inside a Convention-A input is an
 * assumption — A_INPUT_PAGINATION_FIELD — flagged here, overridable per call, and listed as an
 * open item in the P1b return value. If it is wrong the server answers with a validation error
 * and this client throws; it cannot degrade into a quiet empty page.
 *
 * NOTE-STATS: BRIEF.md names NO entity — its entire GraphQL rule is "TWO query conventions and
 * you must implement both, plus BOTH error channels (F12, F23)". The split therefore comes from
 * the recorded schema alone, and it is not uniform even within one family: three statistics
 * queries take an input (statisticsDeliveryMethods, statisticsOrdersV2, statisticsPaymentMethods)
 * and fall out as Convention A, while statisticsCustomers(range,groupBy,stat,sites) and
 * statisticsTopProducts(range,limit,sites) take neither `input` nor `pagination` and fall out as
 * no-convention. Written down because a reader who assumes "statistics* is A" would otherwise
 * think the registry is wrong — not because any requirement said so.
 *
 * LITERALS, NOT VARIABLES: arguments are serialised as GraphQL literals. Reason: the recorded
 * introspection unwrapped NON_NULL when it stringified arg types (`tname()` in the probe), so we
 * do not know which args are `T` and which are `T!`. A `query($input: T)` declaration used in a
 * `T!` position is a hard validation error, and we would be guessing on 59 queries. Literals have
 * no such coupling and they are the form P1 actually executed against the live shop.
 *
 * Invariants honoured: zero runtime dependencies (global fetch is INJECTED so this is testable
 * with no network, and resolved at call time so importing the module never touches globals);
 * ESM; pure module — no top-level side effects, no process.exit, nothing written to stdout;
 * every failure is thrown as a typed Error carrying its evidence.
 *
 * Encoding: responses are decoded EXPLICITLY as UTF-8 from bytes with fatal:true (the declared
 * charset is not trusted — F2), so a non-UTF-8 body raises GraphQLEncodingError instead of being
 * silently rewritten with U+FFFD, which is not reversible. The body is then screened with the
 * mojibake detector, which catches the OTHER direction (valid UTF-8 that is itself
 * double-encoded). The detector is duplicated from src/dandomain/xml.js rather than imported: it
 * is one regex, and this transport must not take a load-time dependency on the SOAP reader.
 */

/** OAuth2 client-credentials token endpoint (F12). Path only — the host is per tenant. */
export const AUTH_PATH = "/auth/oauth/token";

/** The two GraphQL endpoints the probe found on the tenant host. */
export const GRAPHQL_PATHS = {
  public: "/api/graphql",
  experimental: "/api/graphql/experimental",
};

/** Endpoint labels, in the order buildRegistry() walks them (public wins ties). */
export const ENDPOINT_LABELS = ["public", "experimental"];

/** Convention tags (F23). A = input-wrapped payload, B = top-level args + *Pagination return. */
export const CONVENTION = {
  A: "input-wrapped",
  B: "top-level-args",
  NONE: "no-pagination-convention",
};

/**
 * Documented rate limit. F27: it was NOT observed to be enforced (12-call burst, all 200, no
 * retry-after header). We pace to it anyway because the absence of a 429 is not evidence of the
 * absence of a limit — it is evidence that we would get no warning before whatever the limit
 * actually does. Overridable via `minIntervalMs`.
 */
export const DOCUMENTED_RATE_PER_SECOND = 5;
export const DEFAULT_MIN_INTERVAL_MS = 1000 / DOCUMENTED_RATE_PER_SECOND;

/**
 * Clock-safety margin subtracted from the server's own expires_in. Not a shop/plan value, and
 * CLAMPED at mint time to half the token's actual lifetime — see #mintToken.
 */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

/**
 * F2 — double-encoding detector. This is the PROBE's form (scripts/probe-dandomain.mjs:92) and
 * matches src/dandomain/xml.js's MOJIBAKE_RE; BRIEF.md quotes only the `Ã` half, but
 * U+0080–U+00BF double-encodes to `Â`+char, which is nbsp / ° / © / » / ± / ½ — ordinary
 * characters in Danish shop text. Kept local rather than imported; see the header.
 */
export const MOJIBAKE_RE = /Ã[\x80-\xBF]|Â[\x80-\xBF]/;

/** See "TWO SELECTION DEFAULTS" in the header. */
export const DEFAULT_ERROR_SELECTION = "__typename";
export const DEFAULT_PAGINATION_SELECTION = "total";

/** NOTE-A-INPUT: unverified. The name of the pagination member inside a Convention-A input. */
export const A_INPUT_PAGINATION_FIELD = "pagination";

/** Pagination arguments are 1-based in every recorded probe call (`pagination:{limit:5,page:1}`). */
export const FIRST_PAGE = 1;

// ---------------------------------------------------------------------------------------------
// Errors. Nothing here prints; every error carries the evidence a caller would otherwise log.
// ---------------------------------------------------------------------------------------------

export class GraphQLTransportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, details);
  }
}

/** Token endpoint refused or answered something that is not a bearer token (F12). */
export class GraphQLAuthError extends GraphQLTransportError {}

/** Non-2xx from the GraphQL endpoint. Carries `status`, and `retryAfterMs` when the server sent one. */
export class GraphQLHttpError extends GraphQLTransportError {}

/** Channel 1 — the top-level `errors` array of a GraphQL response (F23). */
export class GraphQLQueryError extends GraphQLTransportError {}

/** Channel 2 — a Convention-A payload's own `errors` list while HTTP was 200 (F23). */
export class GraphQLPayloadError extends GraphQLTransportError {}

/** The response parsed but did not have the shape the schema promises. */
export class GraphQLShapeError extends GraphQLTransportError {}

/** The server did not honour `page`, or a page walk could not be proven complete. */
export class GraphQLPaginationError extends GraphQLTransportError {}

/** Response bytes were not clean UTF-8 (F2). */
export class GraphQLEncodingError extends GraphQLTransportError {}

// ---------------------------------------------------------------------------------------------
// Registry — derived from data/probes/gqlshapes.json, pinned below, diffed by the test.
// ---------------------------------------------------------------------------------------------

/** Split "name:Type" as recorded by the probe. The type may itself contain no colon. */
function splitPair(pair) {
  const i = String(pair).indexOf(":");
  return i < 0 ? [String(pair), null] : [String(pair).slice(0, i), String(pair).slice(i + 1)];
}

/**
 * Where the rows and the page metadata live, per convention.
 *
 * Convention B: the query's RETURN TYPE is the pagination container itself
 * (`orders -> OrderPagination { pagination: PaginationData, data: [...] }`).
 *
 * Convention A: the payload wraps `content`, and `content` is NOT always a container. Recorded
 * fact, and the reason this is data-driven: giftCards/redirects/discounts/blogPosts have
 * `content: <X>Pagination` (rows under content.data) while productCategories has
 * `content: ProductCategory` and pages has `content: Page` — a BARE LIST, no page metadata at
 * all. A client that assumes `content.data` everywhere reads undefined rows on two of the
 * entities the migration needs most.
 */
function payloadShapeFor(convention, returns, payload) {
  if (convention === CONVENTION.B) {
    // Fully recorded for the six B payloads P1 introspected: gqlshapes.json lists
    // `pagination:PaginationData` and `data:NON_NULL` as members of OrderPagination itself, so
    // BOTH the member names and their positions are evidence here.
    return {
      rowsPath: ["data"],
      paginationPath: ["pagination"],
      contentPaginated: null,
      payloadTypeIntrospected: Boolean(payload),
      rowsPathVerified: Boolean(payload),
    };
  }
  if (convention !== CONVENTION.A) {
    return {
      rowsPath: null, paginationPath: null, contentPaginated: null,
      payloadTypeIntrospected: Boolean(payload), rowsPathVerified: false,
    };
  }
  const fields = payload?.fields ?? null;
  if (!fields) {
    // Payload not introspected by P1 at all. Assume the common container shape, but SAY SO.
    return {
      rowsPath: ["content", "data"], paginationPath: ["content", "pagination"], contentPaginated: true,
      payloadTypeIntrospected: false, rowsPathVerified: false,
    };
  }
  const contentField = fields.find((f) => splitPair(f)[0] === "content");
  const contentType = contentField ? splitPair(contentField)[1] : null;
  const paginated = contentType ? /Pagination$/.test(contentType) : true;
  // rowsPathVerified is FALSE for every Convention-A query, including these. What P1 recorded is
  // the NAME of the content type ("content":"GiftCardPagination") and nothing inside it:
  // GiftCardPagination / RedirectPagination / DiscountPagination / BlogPostPagination were never
  // introspected. So `data` and `pagination` as the container's members — and `total` inside that
  // pagination — are an ANALOGY from the Convention-B containers, not evidence. What IS evidence
  // is whether `content` is a container at all, which is exactly what the /Pagination$/ test
  // reads off the recorded type NAME: giftCards/redirects/discounts/blogPosts have a container,
  // productCategories ("content":"ProductCategory") and pages ("content":"Page") have a bare list.
  return paginated
    ? {
      rowsPath: ["content", "data"], paginationPath: ["content", "pagination"], contentPaginated: true,
      payloadTypeIntrospected: true, rowsPathVerified: false,
    }
    : {
      rowsPath: ["content"], paginationPath: null, contentPaginated: false,
      payloadTypeIntrospected: true, rowsPathVerified: true,
    };
}

function sameArgs(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * Derive the whole query registry from a parsed data/probes/gqlshapes.json.
 *
 * Pure, exported, and the single source of truth for QUERY_REGISTRY: the test re-runs it over
 * the artifact and deep-equals the pinned table, so the table cannot drift from the probe and
 * cannot be "fixed" by hand.
 */
export function buildRegistry(shapes) {
  const out = {};
  for (const label of ENDPOINT_LABELS) {
    const section = shapes?.[label];
    if (!section) continue;
    const payloads = section.payloads ?? {};
    for (const q of section.queries ?? []) {
      const args = {};
      for (const a of q.args ?? []) {
        const [n, t] = splitPair(a);
        args[n] = t;
      }
      const convention = "input" in args ? CONVENTION.A : "pagination" in args ? CONVENTION.B : CONVENTION.NONE;
      const shape = payloadShapeFor(convention, q.returns, payloads[q.name]);
      const entry = {
        name: q.name,
        convention,
        returns: q.returns ?? null,
        args,
        endpoints: [label],
        payloadType: payloads[q.name]?.payloadType ?? null,
        ...shape,
      };
      const prev = out[q.name];
      if (!prev) {
        out[q.name] = entry;
        continue;
      }
      if (prev.convention !== entry.convention || prev.returns !== entry.returns || !sameArgs(prev.args, entry.args)) {
        throw new GraphQLShapeError(`query ${q.name} has different signatures on ${prev.endpoints.join("+")} and ${label}`, {
          query: q.name,
          previous: { convention: prev.convention, returns: prev.returns, args: prev.args },
          current: { convention: entry.convention, returns: entry.returns, args: entry.args },
        });
      }
      if (prev.payloadTypeIntrospected && entry.payloadTypeIntrospected && prev.contentPaginated !== entry.contentPaginated) {
        throw new GraphQLShapeError(`query ${q.name} has different payload shapes per endpoint`, { query: q.name });
      }
      prev.endpoints = [...prev.endpoints, label];
      if (!prev.payloadTypeIntrospected && entry.payloadTypeIntrospected) {
        prev.rowsPath = entry.rowsPath;
        prev.paginationPath = entry.paginationPath;
        prev.contentPaginated = entry.contentPaginated;
        prev.payloadTypeIntrospected = true;
        prev.rowsPathVerified = entry.rowsPathVerified;
        prev.payloadType = entry.payloadType;
      }
    }
  }
  return out;
}

/**
 * PINNED registry — generated by buildRegistry(data/probes/gqlshapes.json). Do not hand-edit:
 * test/graphql.test.mjs regenerates it from the artifact and diffs, and a hand edit fails there.
 * TWO honesty flags, because they are not the same question:
 *   payloadTypeIntrospected — P1 recorded this payload type's field list at all.
 *   rowsPathVerified        — the RECORDED evidence actually names the members in `rowsPath`.
 * These come apart on every Convention-A container. gqlshapes.json records
 * `"giftCards": {"payloadType":"GiftCardsPayload","fields":["content:GiftCardPagination", ...]}`
 * and stops there: GiftCardPagination itself was never introspected, so `content.data` and
 * `content.pagination` — and `total` inside that pagination — are an ANALOGY from the
 * Convention-B containers, not evidence. rowsPathVerified is therefore FALSE for all 33
 * paginated Convention-A queries, including the ones whose payload type WAS introspected. It is
 * true only where the recording settles the whole path: Convention B (`pagination:PaginationData`
 * and `data:NON_NULL` are recorded members of OrderPagination) and the bare-list Convention-A
 * payloads, where `content` is the row list itself ("content":"ProductCategory", "content":"Page").
 */
export const GENERATED_QUERY_REGISTRY = /* BEGIN GENERATED by buildRegistry(data/probes/gqlshapes.json) */ {
  apiLogsV2: { name: "apiLogsV2", convention: "input-wrapped", returns: "ApiLogsV2Payload", args: { input: "ApiLogsV2Input" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  currencies: { name: "currencies", convention: "input-wrapped", returns: "CurrenciesPayload", args: { input: "CurrenciesInput" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  currencyById: { name: "currencyById", convention: "input-wrapped", returns: "CurrencyByIdPayload", args: { input: "CurrencyByIdInput" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  currencyCodes: { name: "currencyCodes", convention: "no-pagination-convention", returns: "CurrencyCodesPayload", args: {}, endpoints: ["public","experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  discounts: { name: "discounts", convention: "input-wrapped", returns: "DiscountsPayload", args: { input: "DiscountsInput" }, endpoints: ["public"], payloadType: "DiscountsPayload", rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: true, rowsPathVerified: false },
  discountById: { name: "discountById", convention: "input-wrapped", returns: "DiscountByIdPayload", args: { input: "DiscountByIdInput" }, endpoints: ["public"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  generateDiscountCode: { name: "generateDiscountCode", convention: "no-pagination-convention", returns: "GenerateDiscountCodePayload", args: {}, endpoints: ["public"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  domains: { name: "domains", convention: "top-level-args", returns: "DomainPagination", args: { pagination: "PaginationOptions", search: "DomainSearchInput", sorting: "DomainSortingInput" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: ["data"], paginationPath: ["pagination"], contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  llmsTxt: { name: "llmsTxt", convention: "no-pagination-convention", returns: "LlmsTxtPayload", args: {}, endpoints: ["public","experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  robotsTxt: { name: "robotsTxt", convention: "no-pagination-convention", returns: "RobotsTxtPayload", args: {}, endpoints: ["public","experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  giftCards: { name: "giftCards", convention: "input-wrapped", returns: "GiftCardsPayload", args: { input: "GiftCardsInput" }, endpoints: ["public"], payloadType: "GiftCardsPayload", rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: true, rowsPathVerified: false },
  giftCardById: { name: "giftCardById", convention: "input-wrapped", returns: "GiftCardByIdPayload", args: { input: "GiftCardByIdInput" }, endpoints: ["public"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  orders: { name: "orders", convention: "top-level-args", returns: "OrderPagination", args: { pagination: "PaginationOptions", search: "OrderSearchInput", sorting: "OrderSortingInput" }, endpoints: ["public","experimental"], payloadType: "OrderPagination", rowsPath: ["data"], paginationPath: ["pagination"], contentPaginated: null, payloadTypeIntrospected: true, rowsPathVerified: true },
  orderById: { name: "orderById", convention: "no-pagination-convention", returns: "Order", args: { id: "ID" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  ordersByCustomerEmail: { name: "ordersByCustomerEmail", convention: "input-wrapped", returns: "OrdersByCustomerEmailPayload", args: { input: "OrdersByCustomerEmailInput" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  orderStatuses: { name: "orderStatuses", convention: "no-pagination-convention", returns: "NON_NULL", args: {}, endpoints: ["public","experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  invoices: { name: "invoices", convention: "top-level-args", returns: "OrderInvoicePagination", args: { pagination: "PaginationOptions", search: "OrderInvoiceSearchInput", sorting: "OrderInvoiceSortingInput" }, endpoints: ["public","experimental"], payloadType: "OrderInvoicePagination", rowsPath: ["data"], paginationPath: ["pagination"], contentPaginated: null, payloadTypeIntrospected: true, rowsPathVerified: true },
  paymentMethods: { name: "paymentMethods", convention: "no-pagination-convention", returns: "PaymentMethodsPayload", args: {}, endpoints: ["public","experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  productCategories: { name: "productCategories", convention: "input-wrapped", returns: "ProductCategoriesPayload", args: { input: "ProductCategoriesInput" }, endpoints: ["public","experimental"], payloadType: "ProductCategoriesPayload", rowsPath: ["content"], paginationPath: null, contentPaginated: false, payloadTypeIntrospected: true, rowsPathVerified: true },
  productCategoryTree: { name: "productCategoryTree", convention: "input-wrapped", returns: "ProductCategoryTreePayload", args: { input: "ProductCategoryTreeInput" }, endpoints: ["public"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  redirects: { name: "redirects", convention: "input-wrapped", returns: "RedirectsPayload", args: { input: "RedirectsInput" }, endpoints: ["public","experimental"], payloadType: "RedirectsPayload", rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: true, rowsPathVerified: false },
  redirectById: { name: "redirectById", convention: "input-wrapped", returns: "RedirectByIdPayload", args: { input: "RedirectByIdInput" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  unitById: { name: "unitById", convention: "input-wrapped", returns: "UnitByIdPayload", args: { input: "UnitByIdInput" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  units: { name: "units", convention: "input-wrapped", returns: "UnitsPayload", args: { input: "UnitsInput" }, endpoints: ["public","experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  webhookActivity: { name: "webhookActivity", convention: "no-pagination-convention", returns: "WebhookActivity", args: { webhookId: "ID", period: "DateTimeRangeInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  webhookAttempts: { name: "webhookAttempts", convention: "top-level-args", returns: "WebhookAttemptsGroupPagination", args: { pagination: "PaginationOptions", sorting: "WebhookAttemptsGroupSorting", search: "WebhookAttemptsGroupSearch", filters: "WebhookAttemptsGroupSearch" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["data"], paginationPath: ["pagination"], contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  webhookEvents: { name: "webhookEvents", convention: "no-pagination-convention", returns: "NON_NULL", args: {}, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  webhookLogs: { name: "webhookLogs", convention: "top-level-args", returns: "WebhookLogEntryPagination", args: { pagination: "PaginationOptions", sorting: "WebhookLogEntrySorting", search: "WebhookLogEntrySearch" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["data"], paginationPath: ["pagination"], contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  webhooks: { name: "webhooks", convention: "top-level-args", returns: "WebhookPagination", args: { pagination: "PaginationOptions", sorting: "WebhookSortingInput", search: "WebhookSearch" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["data"], paginationPath: ["pagination"], contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  webhooksHashKey: { name: "webhooksHashKey", convention: "no-pagination-convention", returns: "String", args: {}, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  blogPosts: { name: "blogPosts", convention: "input-wrapped", returns: "BlogPostsPayload", args: { input: "BlogPostsInput" }, endpoints: ["experimental"], payloadType: "BlogPostsPayload", rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: true, rowsPathVerified: false },
  blogPostById: { name: "blogPostById", convention: "input-wrapped", returns: "BlogPostByIdPayload", args: { input: "BlogPostByIdInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  blogCategories: { name: "blogCategories", convention: "input-wrapped", returns: "BlogCategoriesPayload", args: { input: "BlogCategoriesInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  blogComments: { name: "blogComments", convention: "input-wrapped", returns: "BlogCommentsPayload", args: { input: "BlogCommentsInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  deliveryMethods: { name: "deliveryMethods", convention: "no-pagination-convention", returns: "DeliveryMethodsPayload", args: {}, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  deliveryMethodById: { name: "deliveryMethodById", convention: "input-wrapped", returns: "DeliveryMethodByIdPayload", args: { input: "DeliveryMethodByIdInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  deliveryCountries: { name: "deliveryCountries", convention: "input-wrapped", returns: "DeliveryCountriesPayload", args: { input: "DeliveryCountriesInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  deliveryCountryById: { name: "deliveryCountryById", convention: "input-wrapped", returns: "DeliveryCountryByIdPayload", args: { input: "DeliveryCountryByIdInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  couriers: { name: "couriers", convention: "no-pagination-convention", returns: "CouriersPayload", args: {}, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  languages: { name: "languages", convention: "input-wrapped", returns: "LanguagesPayload", args: { input: "LanguagesInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  displayLanguageById: { name: "displayLanguageById", convention: "input-wrapped", returns: "DisplayLanguageByIdPayload", args: { input: "DisplayLanguageByIdInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  languagesV2: { name: "languagesV2", convention: "input-wrapped", returns: "LanguagesV2Payload", args: { input: "LanguagesV2Input" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  languageById: { name: "languageById", convention: "input-wrapped", returns: "LanguageByIdPayload", args: { input: "LanguageByIdInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  pages: { name: "pages", convention: "input-wrapped", returns: "PagesPayload", args: { input: "PagesInput" }, endpoints: ["experimental"], payloadType: "PagesPayload", rowsPath: ["content"], paginationPath: null, contentPaginated: false, payloadTypeIntrospected: true, rowsPathVerified: true },
  pageById: { name: "pageById", convention: "input-wrapped", returns: "PageByIdPayload", args: { input: "PageByIdInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  pageTypes: { name: "pageTypes", convention: "no-pagination-convention", returns: "PageTypesPayload", args: {}, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  folders: { name: "folders", convention: "input-wrapped", returns: "FoldersPayload", args: { input: "FoldersInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  folderById: { name: "folderById", convention: "input-wrapped", returns: "FolderByIdPayload", args: { input: "FolderByIdInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  productCategoryById: { name: "productCategoryById", convention: "no-pagination-convention", returns: "ProductCategory", args: { id: "ID" }, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  sites: { name: "sites", convention: "input-wrapped", returns: "SitesPayload", args: { input: "SitesInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  statisticsCustomers: { name: "statisticsCustomers", convention: "no-pagination-convention", returns: "CustomerStatistics", args: { range: "DateTimeRangeInput", groupBy: "StatisticsGrouping", stat: "CustomerStatisticsType", sites: "ID" }, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  statisticsDeliveryMethods: { name: "statisticsDeliveryMethods", convention: "input-wrapped", returns: "StatisticsDeliveryMethodsPayload", args: { input: "StatisticsDeliveryMethodsInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  statisticsOrdersV2: { name: "statisticsOrdersV2", convention: "input-wrapped", returns: "StatisticsOrdersV2Payload", args: { input: "StatisticsOrdersV2Input" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  statisticsPaymentMethods: { name: "statisticsPaymentMethods", convention: "input-wrapped", returns: "StatisticsPaymentMethodsPayload", args: { input: "StatisticsPaymentMethodsInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  statisticsTopProducts: { name: "statisticsTopProducts", convention: "no-pagination-convention", returns: "TopProductStatistics", args: { range: "DateTimeRangeInput", limit: "Int", sites: "ID" }, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
  reportsCustomers: { name: "reportsCustomers", convention: "input-wrapped", returns: "ReportsCustomersPayload", args: { input: "ReportsCustomersInput" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  reportsProductsV2: { name: "reportsProductsV2", convention: "input-wrapped", returns: "ReportsProductsV2Payload", args: { input: "ReportsProductsV2Input" }, endpoints: ["experimental"], payloadType: null, rowsPath: ["content","data"], paginationPath: ["content","pagination"], contentPaginated: true, payloadTypeIntrospected: false, rowsPathVerified: false },
  users: { name: "users", convention: "top-level-args", returns: "UserPagination", args: { pagination: "PaginationOptions", search: "UserSearchInput", sorting: "UserSortingInput" }, endpoints: ["experimental"], payloadType: "UserPagination", rowsPath: ["data"], paginationPath: ["pagination"], contentPaginated: null, payloadTypeIntrospected: true, rowsPathVerified: true },
  userGroupsV2: { name: "userGroupsV2", convention: "no-pagination-convention", returns: "UserGroupV2", args: {}, endpoints: ["experimental"], payloadType: null, rowsPath: null, paginationPath: null, contentPaginated: null, payloadTypeIntrospected: false, rowsPathVerified: false },
} /* END GENERATED */;

/**
 * LIVE CORRECTIONS — entries the SERVER has since contradicted, kept separate from the
 * generated block so that regenerating from `gqlshapes.json` cannot silently revert them and
 * so that "what introspection said" and "what the server does" stay distinguishable.
 *
 * Every entry needs a recorded live observation, quoted. Introspection of a payload TYPE was
 * never available for these — that is exactly why they shipped `rowsPathVerified: false`.
 */
export const LIVE_CORRECTIONS = Object.freeze({
  /**
   * R36 — `folders` is Convention A with a NON-paginated `content`, like `pages`.
   *
   * The generated entry guessed the paginated shape (`content { data pagination }` plus an
   * `input.pagination`) because no payload type was introspected. The server rejected all three
   * parts of that guess at once (`data/probes/p2.json.sections.pageFolderBound.raw`):
   *
   *   Field "pagination" is not defined by type FoldersInput.
   *   Cannot query field "data" on type "Folder".
   *   Cannot query field "pagination" on type "Folder".
   *
   * i.e. `content` IS the row list and its rows are `Folder`. The corrected query then returned
   * four folders (`data/probes/p2b.json.sections.folders`), and `__type(name:"Folder")` lists
   * `id · sorting · languageLayerAccess · menuDisplaySettings · isLeaf · translations` — note
   * there is no `name` or `title`, so a selection asking for one would fault.
   */
  folders: { rowsPath: ["content"], paginationPath: null, contentPaginated: false, rowsPathVerified: true, liveCorrected: "R36 (data/probes/p2.json + p2b.json)" },
});

/** The generated snapshot with the live corrections applied. This is what the client uses. */
export const QUERY_REGISTRY = Object.freeze(Object.fromEntries(
  Object.entries(GENERATED_QUERY_REGISTRY).map(([name, entry]) => [
    name, LIVE_CORRECTIONS[name] ? { ...entry, ...LIVE_CORRECTIONS[name] } : entry,
  ]),
));

export const QUERY_COUNT = Object.keys(QUERY_REGISTRY).length;

/** Queries grouped by convention — the "expose which convention each query uses" surface. */
export function queriesByConvention(registry = QUERY_REGISTRY) {
  const out = { [CONVENTION.A]: [], [CONVENTION.B]: [], [CONVENTION.NONE]: [] };
  for (const name of Object.keys(registry).sort()) out[registry[name].convention].push(name);
  return out;
}

export function describeQuery(name, registry = QUERY_REGISTRY) {
  return registry[name] ?? null;
}

/** Convention tag for a known query; null when the schema snapshot does not know the name. */
export function conventionOf(name, registry = QUERY_REGISTRY) {
  return registry[name]?.convention ?? null;
}

export function endpointsFor(name, registry = QUERY_REGISTRY) {
  return registry[name]?.endpoints ?? [];
}

/** Public endpoint if the query exists there, else experimental. Explicit `endpoint` always wins. */
export function defaultEndpointFor(name, registry = QUERY_REGISTRY) {
  const eps = endpointsFor(name, registry);
  if (!eps.length) return null;
  return eps.includes("public") ? "public" : eps[0];
}

function requireEntry(name, registry, overrides = {}) {
  const known = registry[name];
  if (known) return known;
  // Unknown query: usable only if the caller states the convention explicitly. We never guess
  // one, because guessing wrong is the exact failure gqlshapes.json was written to prevent.
  if (overrides.convention) {
    const convention = overrides.convention;
    return {
      name,
      convention,
      returns: null,
      args: null, // null = "arg names unknown", which disables arg-name validation for this call
      endpoints: [],
      payloadType: null,
      ...payloadShapeFor(convention, null, null),
    };
  }
  throw new GraphQLShapeError(
    `unknown query "${name}" — it is not in the recorded schema (data/probes/gqlshapes.json). ` +
      "Pass { convention: CONVENTION.A | CONVENTION.B } to query it anyway.",
    { query: name },
  );
}

// ---------------------------------------------------------------------------------------------
// GraphQL literal serialisation (see "LITERALS, NOT VARIABLES" in the header).
// ---------------------------------------------------------------------------------------------

const ENUM = Symbol("graphql-enum");

/** Wrap a value so it serialises as a bare GraphQL enum token instead of a string. */
export function gqlEnum(value) {
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(String(value))) {
    throw new GraphQLShapeError(`not a legal GraphQL enum token: ${String(value)}`, { value });
  }
  return { [ENUM]: String(value) };
}

function escapeGraphQLString(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\"") out += "\\\"";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c === 0x7f) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out;
}

/**
 * Serialise a JS value as a GraphQL literal. Object keys are emitted UNQUOTED — the classic bug
 * here is reaching for JSON.stringify, which produces `{"limit":5}` and is not valid GraphQL.
 */
export function toGraphQLLiteral(value) {
  if (value === null) return "null";
  if (value === undefined) return null; // caller drops the member entirely
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GraphQLShapeError(`cannot serialise non-finite number: ${value}`, { value });
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return `"${escapeGraphQLString(value)}"`;
  if (Array.isArray(value)) return `[${value.map((v) => toGraphQLLiteral(v) ?? "null").join(", ")}]`;
  if (typeof value === "object") {
    if (ENUM in value) return value[ENUM];
    // Object.entries() only sees OWN ENUMERABLE keys, so a Date, Map, Set or URL serialises to
    // `{}` — silently, and `{}` is a legal-looking input object. DateTimeRangeInput is a real
    // argument type in the recorded schema (statisticsCustomers.range, webhookActivity.period),
    // so `{from: new Date(...)}` is the obvious thing for a caller to write and it used to emit
    // `range: {from: {}, to: {}}`. Refuse anything that is not a plain object.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const kind = value instanceof Date ? "Date" : (value.constructor?.name ?? "object");
      throw new GraphQLShapeError(
        `cannot serialise a ${kind} as a GraphQL literal — it has no own enumerable properties and ` +
        "would become {}. Convert it yourself (a Date usually wants .toISOString()) so the format " +
        "is a decision and not an accident.",
        { value, kind },
      );
    }
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      const lit = toGraphQLLiteral(v);
      if (lit !== null) parts.push(`${k}: ${lit}`);
    }
    return `{${parts.join(", ")}}`;
  }
  throw new GraphQLShapeError(`cannot serialise ${typeof value} as a GraphQL literal`, { value });
}

/** `(a: 1, b: "x")`, or "" when every argument is undefined. */
export function formatArguments(args) {
  const parts = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    const lit = toGraphQLLiteral(v);
    if (lit !== null) parts.push(`${k}: ${lit}`);
  }
  return parts.length ? `(${parts.join(", ")})` : "";
}

// ---------------------------------------------------------------------------------------------
// Document builder.
// ---------------------------------------------------------------------------------------------

/** Re-indent a block under `pad`, preserving its own relative nesting (dedent, then prefix). */
function indent(text, pad) {
  const lines = String(text)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.replace(/\s+$/, ""));
  if (!lines.length) return "";
  const common = Math.min(...lines.map((l) => l.length - l.trimStart().length));
  return lines.map((l) => pad + l.slice(common)).join("\n");
}

/**
 * Build the query document for one page of one query, in the query's own convention.
 *
 * Convention A:  query { giftCards(input: {...}) { content { data {SEL} pagination {PSEL} } errors {ESEL} } }
 * Convention A (bare-list content, e.g. pages/productCategories):
 *                query { pages(input: {...}) { content {SEL} errors {ESEL} } }
 * Convention B:  query { orders(pagination: {...}, search: {...}) { data {SEL} pagination {PSEL} } }
 *
 * Options:
 *   selection            row selection set (required unless payloadSelection is given)
 *   payloadSelection     replaces the entire payload body — for payloads that are neither
 *                        content-wrapped nor *Pagination (statistics*, reports*)
 *   input                Convention A: the input object (pagination is merged into it)
 *   args                 Convention B: extra top-level args (search, sorting, filters, ...);
 *                        names are validated against the recorded schema (R17/R27 lesson: a
 *                        wrong ARGUMENT name does not come back as a clean "no such param")
 *   page, limit          pagination; `limit` is omitted when undefined so the server's own
 *                        default page size applies and can be discovered from the response
 *   paginationSelection  default "total" (the only PaginationData field P1 ever ran)
 *   errorSelection       default "__typename"; pass "" for a scalar `errors` list
 *   inputPaginationField default A_INPUT_PAGINATION_FIELD (unverified — see NOTE-A-INPUT)
 */
export function buildQueryDocument(name, options = {}) {
  const registry = options.registry ?? QUERY_REGISTRY;
  const entry = requireEntry(name, registry, options);
  const convention = options.convention ?? entry.convention;
  const {
    selection,
    payloadSelection,
    input,
    args = {},
    page,
    limit,
    paginationSelection = DEFAULT_PAGINATION_SELECTION,
    errorSelection = DEFAULT_ERROR_SELECTION,
    inputPaginationField = A_INPUT_PAGINATION_FIELD,
  } = options;
  const contentPaginated = options.contentPaginated ?? entry.contentPaginated ?? true;

  if (!payloadSelection && !String(selection ?? "").trim()) {
    throw new GraphQLShapeError(
      `query "${name}" needs a selection set — this client never guesses field names (R4: one ` +
        "wrong field name faults the whole call).",
      { query: name },
    );
  }

  // R17/R27: an unknown ARGUMENT name is the failure mode that bit three operations on the SOAP
  // side, and on this transport it costs a whole round trip to find out. Reject locally instead.
  if (entry.args) {
    const allowed = new Set(Object.keys(entry.args));
    for (const k of Object.keys(args)) {
      if (!allowed.has(k)) {
        throw new GraphQLShapeError(
          `query "${name}" has no argument "${k}" (schema args: ${[...allowed].join(", ") || "none"})`,
          { query: name, argument: k, allowed: [...allowed] },
        );
      }
    }
    if (convention === CONVENTION.A && !allowed.has("input") && (input !== undefined || page !== undefined || limit !== undefined)) {
      throw new GraphQLShapeError(`query "${name}" takes no input argument`, { query: name });
    }
  }

  const pagination = {};
  if (page !== undefined) pagination.page = page;
  if (limit !== undefined) pagination.limit = limit;
  const hasPagination = Object.keys(pagination).length > 0;

  let callArgs;
  let body;
  const errorBlock = errorSelection === "" ? "errors" : `errors { ${errorSelection} }`;

  // `...args` is spread last, so a caller-supplied args.input / args.pagination would overwrite
  // the merged one and take page/limit with it — silently, because both names are legal schema
  // arguments so the arg-name validator waves them through. Inside fetchAll that produces
  // identical requests for every page, which the repeat guard then reports as "the server is
  // ignoring page". Refuse the collision instead of picking a winner.
  if (convention === CONVENTION.A && args && "input" in args && (input !== undefined || hasPagination)) {
    throw new GraphQLShapeError(
      `query "${name}" was given both args.input and input/page/limit — args.input would silently ` +
      "replace the merged pagination. Put everything in `input`, or drop page/limit.",
      { query: name, argument: "input" },
    );
  }
  if (convention === CONVENTION.B && args && "pagination" in args && hasPagination) {
    throw new GraphQLShapeError(
      `query "${name}" was given both args.pagination and page/limit — args.pagination would ` +
      "silently replace the computed one. Use one or the other.",
      { query: name, argument: "pagination" },
    );
  }

  if (convention === CONVENTION.A) {
    const merged = { ...(input ?? {}) };
    if (hasPagination) merged[inputPaginationField] = { ...(merged[inputPaginationField] ?? {}), ...pagination };
    callArgs = Object.keys(merged).length || input !== undefined ? { input: merged, ...args } : { ...args };
    if (payloadSelection) {
      body = String(payloadSelection).trim();
    } else if (contentPaginated) {
      body = `content {\n  data {\n${indent(selection, "    ")}\n  }\n  pagination { ${paginationSelection} }\n}\n${errorBlock}`;
    } else {
      body = `content {\n${indent(selection, "  ")}\n}\n${errorBlock}`;
    }
  } else if (convention === CONVENTION.B) {
    callArgs = { ...(hasPagination ? { pagination } : {}), ...args };
    body = payloadSelection
      ? String(payloadSelection).trim()
      : `data {\n${indent(selection, "  ")}\n}\npagination { ${paginationSelection} }`;
  } else {
    // No pagination convention: pass whatever args the schema declares, select the payload as-is.
    if (page !== undefined || limit !== undefined) {
      throw new GraphQLShapeError(
        `query "${name}" declares no pagination argument (schema args: ${Object.keys(entry.args ?? {}).join(", ") || "none"})`,
        { query: name },
      );
    }
    callArgs = { ...args };
    body = payloadSelection ? String(payloadSelection).trim() : String(selection).trim();
  }

  return `query {\n  ${name}${formatArguments(callArgs)} {\n${indent(body, "    ")}\n  }\n}`;
}

// ---------------------------------------------------------------------------------------------
// Response reading — BOTH error channels (F23).
// ---------------------------------------------------------------------------------------------

/** Channel 1. Non-empty top-level `errors` throws even when `data` is populated. */
export function assertNoTopLevelErrors(body, context = {}) {
  if (!body || typeof body !== "object") {
    throw new GraphQLShapeError("GraphQL response was not a JSON object", { ...context, body });
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new GraphQLQueryError(`GraphQL returned ${body.errors.length} top-level error(s): ${summariseErrors(body.errors)}`, {
      ...context,
      channel: "top-level",
      errors: body.errors,
      data: body.data ?? null,
    });
  }
}

function summariseErrors(errors) {
  return errors
    .map((e) => (typeof e === "string" ? e : e?.message ?? JSON.stringify(e)))
    .join("; ")
    .slice(0, 500);
}

/**
 * Read one query's payload out of a GraphQL response body and hand back rows + page metadata.
 *
 * Order matters and is the point of the function:
 *   1. top-level errors (channel 1)
 *   2. data present at all
 *   3. the payload's OWN errors (channel 2) — BEFORE rows, so a 200 with an error payload can
 *      never be mistaken for "this shop has none of these"
 *   4. rows, read from the shape the payload actually has (content container / bare list / data)
 */
export function readQueryPayload(name, body, options = {}) {
  const registry = options.registry ?? QUERY_REGISTRY;
  const context = { query: name, endpoint: options.endpoint ?? null, httpStatus: options.httpStatus ?? null };
  assertNoTopLevelErrors(body, context);

  const data = body.data;
  if (data === null || data === undefined) {
    throw new GraphQLShapeError(`GraphQL response for "${name}" carried no data and no errors`, { ...context, body });
  }
  if (!(name in data)) {
    throw new GraphQLShapeError(`GraphQL response has no field "${name}" (got: ${Object.keys(data).join(", ") || "nothing"})`, {
      ...context,
      body,
    });
  }
  const payload = data[name];
  if (payload === null || payload === undefined) {
    throw new GraphQLShapeError(`GraphQL returned a null payload for "${name}" with no errors reported`, { ...context, body });
  }

  // Channel 2 (F23). Checked for every convention: it costs nothing on a Convention-B payload,
  // which has no `errors` member, and it is the whole ballgame on Convention A.
  if (payload && typeof payload === "object" && Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new GraphQLPayloadError(
      `query "${name}" reported ${payload.errors.length} payload error(s) while HTTP was ` +
        `${context.httpStatus ?? "2xx"}: ${summariseErrors(payload.errors)}`,
      { ...context, channel: "payload", errors: payload.errors, payload },
    );
  }

  const entry = registry[name] ?? null;
  const convention = options.convention ?? entry?.convention ?? null;

  // Rows are read from the value that ACTUALLY came back, not from the pinned path: the registry
  // drives the DOCUMENT, the reader sniffs the RESPONSE. That asymmetry is deliberate — for every
  // paginated Convention-A query the pinned rowsPath is inference (rowsPathVerified:false), so
  // trusting it over the wire would be trusting an analogy. `content` is a container for
  // giftCards/redirects/discounts/blogPosts and a bare list for pages/productCategories.
  //
  // The pinned path is still USED: `rowsPath` below reports where the rows were actually found,
  // and a disagreement with the registry is reported (and, where the registry entry is backed by
  // recorded evidence, refused). That mismatch is the schema-drift signal a later phase wants,
  // and without it the pinned table constrained the document and nothing else.
  let rows = null;
  let pagination = null;
  let container = null;
  let rowsPath = null;

  const finish = (result) => withPathCheck(result, entry, context);

  if (convention === CONVENTION.B || (convention === null && Array.isArray(payload?.data))) {
    container = payload;
    rowsPath = ["data"];
  } else if (convention === CONVENTION.A || payload?.content !== undefined) {
    const content = payload?.content;
    if (content === null || content === undefined) {
      // No content and no errors: a real, empty answer only if the payload really has the field.
      if (payload && typeof payload === "object" && "content" in payload) {
        return finish({ name, convention, payload, rows: [], pagination: null, rowsPath: ["content"] });
      }
      return finish({ name, convention, payload, rows: null, pagination: null, rowsPath: null });
    }
    if (Array.isArray(content)) {
      return finish({ name, convention, payload, rows: content, pagination: null, rowsPath: ["content"] });
    }
    container = content;
    rowsPath = ["content", "data"];
  } else {
    return finish({ name, convention, payload, rows: null, pagination: null, rowsPath: null });
  }

  if (container && typeof container === "object" && Array.isArray(container.data)) {
    rows = container.data;
    pagination = container.pagination ?? null;
  } else if (container && typeof container === "object" && container.data === null) {
    rows = [];
    pagination = container.pagination ?? null;
  } else {
    throw new GraphQLShapeError(
      `query "${name}" returned a payload with no row list where one was expected ` +
        `(looked at ${JSON.stringify(entry?.rowsPath ?? ["data"])})`,
      { ...context, payload },
    );
  }
  return finish({ name, convention, payload, rows, pagination, rowsPath });
}

/**
 * Compare where the rows were actually found against where the pinned registry said they would
 * be. Throws when the registry entry is backed by recorded evidence (rowsPathVerified) and the
 * wire disagrees — that is a real schema change, not a shape this client was allowed to guess at.
 * Otherwise it only REPORTS, because for a paginated Convention-A query the pinned path is an
 * analogy from the Convention-B containers and the wire is the better witness.
 */
function withPathCheck(result, entry, context) {
  const expected = entry?.rowsPath ?? null;
  const actual = result.rowsPath;
  const matched = expected === null || actual === null
    ? null
    : expected.length === actual.length && expected.every((k, i) => k === actual[i]);
  if (matched === false && entry?.rowsPathVerified) {
    throw new GraphQLShapeError(
      `query "${result.name}" returned its rows at ${JSON.stringify(actual)} but the recorded ` +
        `schema puts them at ${JSON.stringify(expected)} — the payload shape changed`,
      { ...context, expected, actual, payload: result.payload, reason: "rows-path-drift" },
    );
  }
  return { ...result, rowsPathMatchedRegistry: matched };
}

// ---------------------------------------------------------------------------------------------
// Pacing (F27) and the token cache (F12).
// ---------------------------------------------------------------------------------------------

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialising pacer: every request waits until `minIntervalMs` has passed since the previous
 * request STARTED, regardless of concurrency. `now`/`sleep` are injected so tests drive a fake
 * clock and the suite runs in milliseconds.
 */
export function createPacer({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = Date.now, sleep = realSleep } = {}) {
  let last = null;
  let chain = Promise.resolve();
  return {
    get lastAt() {
      return last;
    },
    async wait() {
      const turn = chain.then(async () => {
        if (last !== null) {
          const waitMs = minIntervalMs - (now() - last);
          if (waitMs > 0) await sleep(waitMs);
        }
        last = now();
      });
      chain = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------------------------

/**
 * F2: decode explicitly as UTF-8 and FAIL when the bytes are not UTF-8, the way xml.js does
 * (xml.js:170 uses fatal:true too). A non-fatal decoder turns windows-1252 "Æblegrød"
 * (C6 62 6C 65 67 72 F8 64 — the byte pattern P1's encbytes probe proved this platform stores
 * natively) into "�blegr�d" with no error, and U+FFFD is not reversible. MOJIBAKE_RE
 * only catches the other direction (valid UTF-8 that is itself double-encoded), so without this
 * the whole "do not trust the declared charset" rule has no failure mode at all.
 */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    throw new GraphQLEncodingError(
      "response bytes are not valid UTF-8 — refusing to decode with replacement characters (F2)",
      { bytes: bytes.length, sample: describeBadUtf8(bytes), cause: e },
    );
  }
}

/** Where the UTF-8 decode first fails, plus the offending bytes, for the error's evidence. */
function describeBadUtf8(bytes) {
  const strict = new TextDecoder("utf-8", { fatal: true });
  let lo = 0;
  let hi = bytes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      strict.decode(bytes.subarray(0, mid));
      lo = mid + 1;
    } catch {
      hi = mid;
    }
  }
  const at = Math.max(0, hi - 1);
  const window = [...bytes.subarray(Math.max(0, at - 4), at + 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return `first invalid byte near offset ${at}: ${window}`;
}

function parseRetryAfterMs(headerValue, now) {
  if (headerValue === null || headerValue === undefined || headerValue === "") return null;
  const secs = Number(headerValue);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(String(headerValue));
  return Number.isFinite(when) ? Math.max(0, when - now) : null;
}

function headerOf(res, name) {
  try {
    return res?.headers?.get ? res.headers.get(name) : null;
  } catch {
    return null;
  }
}

/** A mutation must never be auto-replayed after a re-auth (the SOAP rule, F16/session, applies). */
export function isMutationDocument(document) {
  return /^\s*(?:#[^\n]*\n\s*)*mutation\b/.test(String(document));
}

export class DanDomainGraphQLClient {
  #fetch;
  #now;
  #pacer;
  #token = null; // { accessToken, tokenType, expiresAt|null }
  #minting = null;
  #tokenMints = 0;

  /**
   * @param {object} opts
   * @param {string} opts.tenant        shop tenant; host defaults to https://{tenant}.mywebshop.io
   * @param {string} [opts.baseUrl]     full origin override (wins over `tenant`)
   * @param {string} opts.clientId      OAuth2 client id (F12)
   * @param {string} opts.clientSecret  OAuth2 client secret (F12)
   * @param {Function} [opts.fetchImpl] injected fetch; defaults to globalThis.fetch AT CALL TIME
   * @param {number} [opts.minIntervalMs] pacing floor (F27)
   * @param {Function} [opts.now]       injectable clock (tests)
   * @param {Function} [opts.sleep]     injectable sleep (tests)
   */
  constructor(opts = {}) {
    const { tenant, baseUrl, clientId, clientSecret } = opts;
    if (!baseUrl && !tenant) throw new GraphQLShapeError("a tenant (or baseUrl) is required");
    if (!clientId || !clientSecret) throw new GraphQLShapeError("clientId and clientSecret are required (F12: OAuth2 client-credentials)");
    this.tenant = tenant ?? null;
    this.baseUrl = String(baseUrl ?? `https://${tenant}.mywebshop.io`).replace(/\/+$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = opts.scope ?? "";
    this.registry = opts.registry ?? QUERY_REGISTRY;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.tokenSkewMs = opts.tokenSkewMs ?? TOKEN_EXPIRY_SKEW_MS;
    this.mojibakeCheck = opts.mojibakeCheck ?? true;
    this.defaultErrorSelection = opts.errorSelection ?? DEFAULT_ERROR_SELECTION;
    this.defaultPaginationSelection = opts.paginationSelection ?? DEFAULT_PAGINATION_SELECTION;
    this.inputPaginationField = opts.inputPaginationField ?? A_INPUT_PAGINATION_FIELD;
    this.pageSize = opts.pageSize ?? undefined; // undefined => omit `limit`, discover from response
    this.maxPages = opts.maxPages ?? Infinity;
    this.#fetch = opts.fetchImpl ?? null;
    this.#now = opts.now ?? Date.now;
    this.#pacer = createPacer({
      minIntervalMs: opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      now: this.#now,
      sleep: opts.sleep ?? realSleep,
    });
  }

  /** Resolved at call time so importing this module never reads a global (invariant #4). */
  get fetchImpl() {
    const f = this.#fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new GraphQLShapeError("no fetch implementation available — pass { fetchImpl }");
    return f;
  }

  /** How many times a token was minted from the server. Lets a caller (and the test) prove reuse. */
  get tokenMints() {
    return this.#tokenMints;
  }

  /**
   * When the cached token stops being used (server `expires_in` minus the clamped skew), or null
   * when the server gave no lifetime. Exposed so a pathological value is VISIBLE instead of just
   * expensive: a caller can compare it to now() rather than discover the re-mint-per-request
   * behaviour from a latency graph.
   */
  get tokenExpiresAt() {
    return this.#token?.expiresAt ?? null;
  }

  urlFor(endpoint = "public") {
    const path = GRAPHQL_PATHS[endpoint];
    if (!path) throw new GraphQLShapeError(`unknown GraphQL endpoint "${endpoint}" (known: ${Object.keys(GRAPHQL_PATHS).join(", ")})`);
    return this.baseUrl + path;
  }

  /** Drop the cached token. Used by the 401 replay and available to callers. */
  invalidateToken() {
    this.#token = null;
  }

  /**
   * F12 — mint once, reuse until the server's own `expires_in` (minus a clock skew margin) says
   * otherwise. Concurrent callers share one in-flight mint; a 401 later forces a refresh.
   */
  async token({ force = false } = {}) {
    if (!force && this.#token && !this.#isExpired(this.#token)) return this.#token.accessToken;
    if (this.#minting) return this.#minting;
    this.#minting = this.#mintToken().finally(() => {
      this.#minting = null;
    });
    return this.#minting;
  }

  #isExpired(token) {
    if (token.expiresAt === null) return false; // server sent no expires_in: reuse until a 401
    return this.#now() >= token.expiresAt;
  }

  async #mintToken() {
    const url = this.baseUrl + AUTH_PATH;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scope,
    });
    await this.#pacer.wait();
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        signal: this.#signal(),
      });
    } catch (e) {
      throw new GraphQLAuthError(`token request to ${url} failed: ${e.message}`, { url, cause: e });
    }
    const text = await this.#readBody(res, { url });
    if (!res.ok) {
      throw new GraphQLAuthError(`token endpoint answered ${res.status}`, { url, status: res.status, body: text.slice(0, 500) });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new GraphQLAuthError("token endpoint answered with non-JSON", { url, status: res.status, body: text.slice(0, 500) });
    }
    const accessToken = json?.access_token;
    if (!accessToken || typeof accessToken !== "string") {
      throw new GraphQLAuthError("token response carried no access_token", { url, status: res.status, keys: Object.keys(json ?? {}) });
    }
    const expiresIn = Number(json?.expires_in);
    // The skew is CLAMPED to half the lifetime. Unclamped, a short-lived token (expires_in 10
    // against a 30 s skew) is born already expired and is re-minted before every single request
    // — each mint consuming a paced slot, so throughput silently halves with nothing to see.
    // The real expires_in for this tenant is not in this workspace (graphql.json is absent), so
    // the clamp is protection against a value we cannot check, not a tuned constant.
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : null;
    const skewMs = lifetimeMs === null ? this.tokenSkewMs : Math.min(this.tokenSkewMs, Math.floor(lifetimeMs / 2));
    const expiresAt = lifetimeMs === null ? null : this.#now() + lifetimeMs - skewMs;
    this.#token = { accessToken, tokenType: json?.token_type ?? "Bearer", expiresAt, expiresIn: Number.isFinite(expiresIn) ? expiresIn : null };
    this.#tokenMints += 1;
    return accessToken;
  }

  #signal() {
    return this.timeoutMs && typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(this.timeoutMs) : undefined;
  }

  /**
   * Read a response body as BYTES and decode it explicitly as UTF-8 (F2 — the declared charset
   * is not trusted), then screen for double-encoding. Falls back to res.text() for fetch stubs
   * or runtimes that do not expose arrayBuffer().
   */
  async #readBody(res, context) {
    let text;
    if (typeof res?.arrayBuffer === "function") {
      text = decodeUtf8(new Uint8Array(await res.arrayBuffer()));
    } else if (typeof res?.text === "function") {
      text = await res.text();
    } else {
      throw new GraphQLShapeError("fetch response exposes neither arrayBuffer() nor text()", context);
    }
    if (this.mojibakeCheck && MOJIBAKE_RE.test(text)) {
      const at = text.search(MOJIBAKE_RE);
      throw new GraphQLEncodingError("response contains double-encoded UTF-8 (mojibake) — refusing to parse (F2)", {
        ...context,
        sample: text.slice(Math.max(0, at - 40), at + 40),
      });
    }
    return text;
  }

  /**
   * POST one document. Enforces pacing (F27), the bearer token (F12) and error channel 1.
   * Returns { body, data, httpStatus, document, endpoint }.
   */
  async execute(options = {}) {
    const { document, endpoint = "public", variables, operationName } = options;
    if (!document || typeof document !== "string") throw new GraphQLShapeError("execute() needs a document string");
    // F16 / the session rule are absolute: only idempotent reads are ever replayed. The option
    // can turn replay OFF; it can never turn it ON for a mutation, or a config file could
    // re-enable exactly the double-create the rule forbids.
    const allowReauth = (options.allowReauth ?? true) && !isMutationDocument(document);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const token = await this.token();
      await this.#pacer.wait();
      const url = this.urlFor(endpoint);
      const payload = { query: document };
      if (variables !== undefined) payload.variables = variables;
      if (operationName !== undefined) payload.operationName = operationName;
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
          signal: this.#signal(),
        });
      } catch (e) {
        throw new GraphQLHttpError(`GraphQL request to ${url} failed: ${e.message}`, { url, endpoint, document, cause: e });
      }
      const text = await this.#readBody(res, { url, endpoint, document });

      if (res.status === 401 && allowReauth && attempt === 1) {
        // Mirrors the SOAP session rule: re-auth once and replay, idempotent reads only.
        this.invalidateToken();
        continue;
      }
      if (!res.ok) {
        throw new GraphQLHttpError(`GraphQL endpoint answered ${res.status}`, {
          url,
          endpoint,
          status: res.status,
          // F27: recorded, not acted on. There is no retry loop keyed to this value on purpose.
          retryAfterMs: parseRetryAfterMs(headerOf(res, "retry-after"), this.#now()),
          rateLimitRemaining: headerOf(res, "x-ratelimit-remaining"),
          document,
          body: text.slice(0, 500),
        });
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new GraphQLShapeError("GraphQL endpoint answered with non-JSON", {
          url,
          endpoint,
          status: res.status,
          document,
          body: text.slice(0, 500),
        });
      }
      assertNoTopLevelErrors(body, { endpoint, document, httpStatus: res.status });
      return { body, data: body.data ?? null, httpStatus: res.status, document, endpoint };
    }
  }

  /** One page of one query, in that query's convention. Both error channels are enforced. */
  async query(name, options = {}) {
    const registry = options.registry ?? this.registry;
    const endpoint = options.endpoint ?? defaultEndpointFor(name, registry) ?? "public";
    const document = buildQueryDocument(name, {
      registry,
      errorSelection: this.defaultErrorSelection,
      paginationSelection: this.defaultPaginationSelection,
      inputPaginationField: this.inputPaginationField,
      ...options,
    });
    const { body, httpStatus } = await this.execute({ document, endpoint, allowReauth: options.allowReauth });
    const read = readQueryPayload(name, body, { registry, endpoint, httpStatus, convention: options.convention });
    return { ...read, document, endpoint, httpStatus };
  }

  /**
   * Walk every page of a query, in either convention, and yield them one at a time.
   *
   * Stop conditions, in order — all of which either PROVE the walk is complete or throw. The one
   * thing this loop must never do is stop early and quietly, because a short read here becomes a
   * migration that silently drops rows.
   *   - a page comes back empty                                        -> done
   *   - `pagination.total` is known and we have that many rows         -> done
   *   - the page is shorter than the OBSERVED page size                -> done  (see below)
   *   - a page repeats the previous page (server ignored `page`):
   *        total known and rows still missing -> GraphQLPaginationError
   *        total unknown                      -> done, flagged paginationHonoured:false
   *   - maxPages reached with work outstanding                         -> GraphQLPaginationError
   *
   * WHY "OBSERVED". A short page only proves the end of the data if you know how long a full page
   * is, and the caller's `limit` is a REQUEST, not a fact: a server that caps pages below the
   * requested limit (50 rows when 100 was asked for) makes page 1 look short and ends every walk
   * after one request. Measured against a 120-row shop with limit:100 and a 50-row cap: 50 rows
   * read, one request, complete:true. So the page size is taken from page 1's ACTUAL row count
   * and the caller's limit is only an upper bound. A server-side cap is ordinary; being wrong
   * about it silently costs 70 of 120 rows. If `total` is known and rows are still outstanding
   * this throws instead of returning short, exactly as the repeated-page branch already does for
   * the same condition.
   *
   * AND `total` IS CORROBORATION, NOT PROOF. PaginationData was never introspected
   * (data/probes/gqlshapes.json records only `pagination:PaginationData` on the container), so
   * nothing here knows whether `total` counts ROWS or PAGES. If it is a page count, `seen>=total`
   * fires on page 1 of 5 and reports a complete walk over 20% of the shop. The free contradiction
   * check is that a page cannot hold more rows than the total ROW count — when it does, `total`
   * is not a row count and this throws rather than believing it. That check is a detector, NOT a
   * proof: it cannot fire when the page size is smaller than the page count (7 pages of 3 rows
   * against total:7 looks consistent either way), so a page-counting `total` can still end a walk
   * early. Settling it needs one live call — `orders(pagination:{limit:1,page:1}){pagination
   * {total}}` against a shop with a known order count — and that is on the P1c probe list.
   */
  async *paginate(name, options = {}) {
    const registry = options.registry ?? this.registry;
    const convention = options.convention ?? registry[name]?.convention ?? null;
    if (convention === CONVENTION.NONE) {
      throw new GraphQLPaginationError(
        `query "${name}" declares no pagination argument (schema args: ` +
          `${Object.keys(registry[name]?.args ?? {}).join(", ") || "none"}) — use query() instead`,
        { query: name, convention },
      );
    }
    const limit = options.limit ?? options.pageSize ?? this.pageSize;
    const maxPages = options.maxPages ?? this.maxPages;
    let page = options.startPage ?? FIRST_PAGE;
    let seen = 0;
    let pagesFetched = 0;
    // The page size the SERVER is actually using. Discovered from page 1; the caller's `limit`
    // is only an upper bound, because a server-side cap makes every page look short.
    let observedLimit = null;
    let previousSignature = null;

    for (;;) {
      const result = await this.query(name, { ...options, registry, page, limit });
      pagesFetched += 1;
      const rows = result.rows;
      if (rows === null) {
        throw new GraphQLPaginationError(`query "${name}" returned no row list — it is not a paginated query`, {
          query: name,
          payload: result.payload,
        });
      }
      const total = Number.isFinite(Number(result.pagination?.total)) ? Number(result.pagination.total) : null;
      // `total` has never been introspected: it may be a ROW count or a PAGE count. One page
      // holding more rows than the claimed total settles it — and settles it as "do not trust
      // this number to end the walk". Free, and it is the difference between reading a 250-row
      // shop and reading 50 rows of it while reporting complete:true.
      if (total !== null && rows.length > total) {
        throw new GraphQLPaginationError(
          `query "${name}" returned ${rows.length} rows on page ${page} while pagination.total is ` +
            `${total} — total cannot be a row count here (PaginationData was never introspected; ` +
            "it may be a page count), so it must not be used to end the walk",
          { query: name, page, total, rows: rows.length, reason: "total-is-not-a-row-count" },
        );
      }
      const signature = rowSignature(rows);
      const repeated = rows.length > 0 && previousSignature !== null && signature === previousSignature;

      if (repeated) {
        if (total !== null && seen < total) {
          throw new GraphQLPaginationError(
            `query "${name}" returned the same rows for page ${page - 1} and page ${page} while ` +
              `${total - seen} of ${total} rows are still unread — the server is ignoring \`page\``,
            { query: name, page, total, seen },
          );
        }
        yield { rows: [], pagination: result.pagination ?? null, page, document: result.document, paginationHonoured: false, repeated: true };
        return;
      }

      seen += rows.length;
      previousSignature = signature;
      yield { rows, pagination: result.pagination ?? null, page, document: result.document, paginationHonoured: true, repeated: false };

      if (rows.length === 0) return;
      if (total !== null && seen >= total) return;
      // Page size: OBSERVED from page 1, never assumed from what the caller asked for.
      if (observedLimit === null) observedLimit = rows.length;
      if (rows.length < observedLimit) {
        // Short page. That ends the walk only if nothing says rows are still outstanding.
        if (total !== null && seen < total) {
          throw new GraphQLPaginationError(
            `query "${name}" returned a short page (${rows.length} of ${observedLimit}) on page ${page} ` +
              `while ${total - seen} of ${total} rows are still unread — a short page is not proof ` +
              "that the data ended",
            { query: name, page, total, seen, rows: rows.length, observedLimit, reason: "short-page-with-rows-outstanding" },
          );
        }
        return;
      }
      if (pagesFetched >= maxPages) {
        throw new GraphQLPaginationError(`query "${name}" hit maxPages=${maxPages} with more rows outstanding`, {
          query: name,
          pagesFetched,
          seen,
          total,
        });
      }
      page += 1;
    }
  }

  /**
   * Every row of a query, with the evidence that the walk was complete.
   *
   * Throws when `total` is known and fewer rows than that came back. A boolean nobody reads is
   * how "this shop has no redirects" gets written into a migration; the flags stay on the result
   * for the cases that cannot be decided (total unknown), but a KNOWN shortfall is an error.
   */
  async fetchAll(name, options = {}) {
    const rows = [];
    let pages = 0;
    let total = null;
    let paginationHonoured = true;
    for await (const p of this.paginate(name, options)) {
      pages += 1;
      rows.push(...p.rows);
      if (p.pagination && Number.isFinite(Number(p.pagination.total))) total = Number(p.pagination.total);
      if (!p.paginationHonoured) paginationHonoured = false;
    }
    if (total !== null && rows.length < total && options.allowIncomplete !== true) {
      throw new GraphQLPaginationError(
        `query "${name}" read ${rows.length} of ${total} rows in ${pages} page(s) — the server ` +
          "reported more rows than the walk produced; refusing to report a partial read as a result " +
          "(pass { allowIncomplete: true } to get the rows anyway)",
        { query: name, pages, rows: rows.length, total, paginationHonoured, reason: "short-of-total" },
      );
    }
    return { rows, pages, total, paginationHonoured, complete: total === null ? paginationHonoured : rows.length >= total };
  }
}

/**
 * Cheap "is this the same page again?" probe.
 *
 * Ids when the rows have them. Without ids it falls back to comparing the whole page by value,
 * which CAN false-positive: three genuinely different pages of `[{title:"Sale"},{title:"Sale"}]`
 * (a keyless selection over a shop with repeated titles) look like a repeat, and the guard then
 * stops the walk after 2 of 6 rows. It is reported — paginationHonoured:false, complete:false —
 * rather than silent, and selecting `id` removes it entirely.
 *
 * The guard is NOT simply switched off for keyless pages, which would be the obvious fix. Two
 * reasons: `maxPages` defaults to Infinity, so without the guard a server that really does ignore
 * `page` spins forever on a keyless selection instead of returning a wrong answer; and the other
 * candidate signal — the page number echoed back by the server — is not available, because the
 * only pagination subfield P1 ever ran live is `total` (see DEFAULT_PAGINATION_SELECTION). A
 * bounded, reported over-stop beats an unbounded hang, so the guard stays and the cost is written
 * down here. Set `maxPages` and select `id` if you need the other trade.
 */
function rowSignature(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "[]";
  const ids = rows.map((r) => (r && typeof r === "object" && "id" in r ? r.id : undefined));
  if (ids.every((v) => v !== undefined)) return `ids:${JSON.stringify(ids)}`;
  try {
    return `rows:${JSON.stringify(rows)}`;
  } catch {
    return `len:${rows.length}`;
  }
}

export function createGraphQLClient(options) {
  return new DanDomainGraphQLClient(options);
}
