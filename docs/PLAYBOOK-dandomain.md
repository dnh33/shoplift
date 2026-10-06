# PLAYBOOK — DanDomain (Hostedshop) live findings

The §9-analog for the DanDomain source: **facts established by running against a real shop**,
not by reading docs. Every entry cost a live probe. Do not re-litigate these from documentation
— DanDomain's docs are wrong or silent on most of them.

Shop: `shop000000` (Success plan demo, trial ~30 days from 2026-08-15).
Probe kit: `scripts/probe-dandomain.mjs` → raw evidence in `data/probes/*.json`.
Session: P1, 2026-08-15.

---

## F1 — WSDL: default namespace, 247 operations, endpoint ≠ WSDL URL

`https://api.hostedshop.io/service.wsdl` is a **439 KB complete document** using the
**default namespace** — tags are `<definitions>`, `<operation>`, NOT `<wsdl:operation>`.
A prefix-assuming parser silently finds zero operations.

- **247 operations** (DanDomain's own doc app claims 249 — treat the WSDL as authoritative).
- SOAP endpoint is **`https://api.hostedshop.io/service.php`** (from `soap:address`), not the
  `.wsdl` URL. Read it from the WSDL rather than hardcoding.
- Families: Product 109, Order 42, User 20, Solution 13, Category 11, PageText 9,
  DiscountGroup(+Product) 12, VatGroup 5, Discount 5, Currency 5, SEORedirect 3, Newsletter 3,
  Delivery 3, Sites 2, Payment 2, Page 2, OrderStatusCode 1.
- Confirms the research's structural claims: **no `SEORedirect_Create/Update`** (read+delete
  only), **no gift-card operations**, **no blog/news operations**, and `Order_LowerTransaction`
  exists in the WSDL though it is absent from the doc census.

## F2 — ENCODING (critical): never call `Solution_SetEncoding("UTF-8")`

**The API is UTF-8-native. Asking it for UTF-8 makes it convert twice.** Live matrix, same
Danish string written and read back four ways (`data/probes/encoding.json`, `encbytes.json`):

| `Solution_SetEncoding` | wire bytes | read | write |
|---|---|---|---|
| **not called** | latin1 | ✅ `Genåbnet` | ✅ stored intact |
| `ISO-8859-1` | latin1 | ✅ `Genåbnet` | ✅ stored intact |
| **not called** | UTF-8 | ✅ | ✅ stored intact |
| **`UTF-8`** | UTF-8 | ❌ `GenÃ¥bnet` | ❌ **`?r? ??? ???` — data destroyed** |

Byte-level check: stored titles decode correctly as **UTF-8**, and as mojibake under
windows-1252 — the storage is genuinely UTF-8.

**Client rules (non-negotiable):**
1. **Never call `Solution_SetEncoding`.** The session default is correct.
2. Decode every response explicitly as UTF-8 — do not trust `res.text()`/the declared charset.
3. Send UTF-8 with a matching XML declaration and `charset=utf-8`.
4. Keep a mojibake detector (`/Ã[\x80-\xBF]/`) in the client and fail loudly: silent
   `Ã¥` corruption across a whole catalogue is exactly the class of defect the WP build's
   D15 lesson warns about.

The `?` substitution is **irreversible** — a migration run with the wrong encoding does not
just display badly, it destroys the source data it writes (relevant only to seeding, but the
same call corrupts reads of a real client shop).

## F3 — Fault codes beyond the documented five

Docs list `AUTH / PARAM / NOSUCHPARAM / NOSUCHISO / INTERNAL`. Live, we also saw:

- **`PRODUCT`** — "A CategoryId must be set when creating a product" (no `Subcode`; the code
  sits directly in `Code/Value`).
- **`Internal`** (capital-I, distinct spelling from documented `INTERNAL`) — returned for
  *missing required fields* on `Order_Create`, not the expected `PARAM`.

**Client rule:** read the app code from `Subcode/Value` when present, else `Code/Value`;
treat **unknown codes as named-fatal**, never assume the documented set is complete.

## F4 — `Product_CreateOrUpdate` requires `CategoryId` (WSDL says optional)

The WSDL marks `CategoryId` `minOccurs="0"`; the server rejects creates without it
(fault `PRODUCT`). Updates via the same op also demanded it in our runs. **Always resolve a
category before writing a product.** Corollary: the WSDL's optionality flags are not a
reliable required-field contract — the fault matrix is.

## F5 — `Order_Create`: the real required set

`OrderCreate` mandates `CurrencyId`, `PaymentId`, `DeliveryId`, `OrderLines` (`{item:[...]}`),
`OrderCustomer`. Omitting any of them yields `Internal`, not a helpful `PARAM`.
`OrderCustomer` is the field name — **not** `Customer`. Transactions attach as a single
`OrderTransaction` object, not an array.

## F6 — `CountryCode` is typed string but must be a NUMBER

`OrderCustomerCreate.CountryCode` is `xsd:string` in the WSDL. Sending `"DK"` fails with
`PARAM: CountryCode 'DK' is not a number`. Resolve the numeric id from
`Product_GetDeliveryCountryAll` (`{Id, Iso, Code}`) — or GraphQL `deliveryCountries`.
**Open:** whether the server wants that `Id` or the `Code` — the probe now sweeps candidates;
close this on the next `ordercreate` run.

## F7 — The product `Url` field comes back EMPTY

`Product_SetFields("...,Url,SeoLink")` returns `SeoLink` populated but **`Url: ""`**, on both
seeded and pre-existing products. **The live URL is not readable from SOAP** — the redirect
map must be **composed** from base + category + id + slug, exactly as PLAN §5 assumed, and
that composition must be validated against real storefront URLs before P3 ships.

## F8 — `SEORedirect_GetAll` returned nothing after a rename

Renaming a product's `SeoLink` produced **no SOAP-visible redirect row** (`redirectsBefore`
and `redirectsAfter` both null/empty). Either the shop's redirect table is genuinely empty
and auto-redirects are internal-only, or they surface elsewhere. **Re-check via GraphQL
`redirects`** (F12) before concluding that rename history is unrecoverable.

## F9 — Language layers are sparse overlays, field is `LanguageISO`

With DK + UK layers active, reading a DK-authored product under the UK layer returns
`Title: null`, `SeoLink: null` — layers carry only what has been translated. The field name in
live payloads is **`LanguageISO`** (not `Iso`/`LanguageIso`), and `Solution_SetLanguage` takes
`LanguageISO`. Exporters must treat missing translations as "absent", not as empty strings,
and must not overwrite the primary layer's values with nulls.

## F10 — VAT basis: the setting is API-readable; prices are entered-inclusive

`Solution_GetWebinfo` exposes **`ProductPricesWithVat: "true"`** and
`ShowProductPricesWithVat` — the shop-level basis is machine-readable (the research phase
listed this as unknown). Products written at `Price: 100` into a **25%** and a **0%** VAT group
both read back `Price: 100`, i.e. **`Price` is the entered price**, VAT-inclusive when that
flag is true.

**Still open (do not write the money transform until closed):** confirm against the admin/
storefront that a 25% product entered at 100 displays 100 incl. (not 125), and determine how
`Order.Total`/`Order.Vat` are expressed. Products `PROBE-VAT-25` / `PROBE-VAT-00` exist for
this check.

## F11 — No page-size ceiling or throttling observed (small-shop caveat)

`Product_GetAllWithLimit` accepted `Length` up to **2500** without fault; a 20-call burst ran
at 30–48 ms with no back-off signal. The shop holds only a handful of products, so this
bounds nothing for a 10k catalogue — but there is no *low* hard cap. Keep the client's
conservative pacing (~4 rps) until a large shop says otherwise.

## F12 — GraphQL (Success plan): SOAP-first CONFIRMED, but GraphQL covers more than documented

OAuth2 client-credentials against **`https://shop000000.mywebshop.io/auth/oauth/token`**
(the `mywebshop.io` host, not the `webshop.dandomain.dk` storefront domain) works, and
**introspection is enabled** on both schemas — the artefact the research phase could not obtain.

- **public: 24 queries / 25 mutations · experimental: 53 queries / 49 mutations**
- **No `products` and no variant query in either schema.** Only `productCategories`.
  **→ SOAP-first for the catalogue is now proven, not inferred. PLAN D2 stands.**

What GraphQL *does* have, contradicting the research's documented-loss list:

| Capability | Previously | Introspected |
|---|---|---|
| Gift cards | export-only, manual CSV | `giftCards`, `giftCardById`, **`giftCardCreate`, `giftCardUpdate`** (public) |
| Redirects | SOAP read/delete only | **full CRUD** — `redirects`, `redirectCreate/Update/Duplicate/Delete` (public) |
| Blog/news | no API at all, crawl-only | **full CRUD** — `blogPosts`, `blogPostById`, `blogCategories`, `blogComments`, `blogPostCreate/Update`, `blogPostImageUpload` (experimental) |
| Webhooks | admin-UI only | `webhookCreate/Update/Delete`, `webhookLogs` (experimental) |
| Pages | SOAP `PageText_*` | also `pages`, `pageById`, `pageTypes`, `folders` (+CRUD) |
| Users / groups | SOAP `User_*` | also `users`, `userGroupsV2` (experimental) |
| Languages / sites | SOAP `Solution_GetLanguages` | `languages`, `languagesV2`, `displayLanguageById`, `sites` |
| Country ids | `Product_GetDeliveryCountryAll` | `deliveryCountries`, `deliveryCountryById` |
| Credit notes | hard, kreditnota-as-order | **`invoices`** query — investigate as the kreditnota channel |
| Verify data | counts only | `reportsCustomers`, `reportsProductsV2`, `statisticsOrdersV2`, `statisticsTopProducts` |
| SEO files | — | `robotsTxt`, `llmsTxt` (+CRUD) |

Both schemas also expose `orders`, `orderById`, `ordersByCustomerEmail`, `orderStatuses`,
`orderCreateV2`, `discounts`(+CRUD), `currencies`, `units`, `paymentMethods`, `apiLogsV2`.

**Architecture consequence:** the source is **dual-transport** — SOAP for the catalogue and
order/customer bulk reads, GraphQL for the entities SOAP cannot reach. The adapter must own
both clients behind one interface.

## F13 — What SOAP can and cannot provision (seeding constraints)

Creatable via SOAP: VAT groups (`VatGroup_Create`), currencies, categories, products,
variants, users, discounts, CMS pages, orders.
**Not creatable via any API:** language layers (`Solution_*` has no create; `Sites_*` is
read-only), delivery methods, payment methods. These stay **manual shop setup** and must be
documented as prerequisites for both seeding and any client onboarding.

## F14 — Demo/trial shop facts

DanDomain support (2026-08-15): **all webshop demos run the Success package**, and a demo may
create **up to 2 extra language layers**. So a trial shop is a valid proving ground for
Success-tier features (multi-location stock, custom fields, multi-language) — no paid shop
needed for P2–P5. Trial expiry (~2026-09-14) is the real deadline.

## F15 — Method note: our own false positive

The first GraphQL verdict reported "products AVAILABLE" because the probe matched entity
names by substring — `productCategories` matched `/^product/i`. The full introspection lists
proved the opposite. **Match entity names exactly; never let a heuristic summary stand in for
the raw list**, and always print the raw list alongside any verdict. (Same family of error as
trusting `0 failed`.)

---

## Standing operating notes

- ~~The storefront theme on this shop (`/heimdal/products/{id}`) is **JS-rendered** — HTML
  scraping returns a placeholder `<title>`.~~ **Corrected by R39/R41:** that URL is the ADMIN
  app, which is a JS shell; the STOREFRONT is `{tenant}.mywebshop.io` and it is
  server-rendered ISO-8859-1 HTML with prices in the markup. Verifying stored values
  through the API's bytes (`encbytes`) or GraphQL is still the safer habit, but
  "the storefront cannot be scraped" was a statement about the wrong host.
- `npm test` cannot run over the mounted Windows drive from a Linux VM (`EPERM` on unlink) —
  run it natively.
- The probe kit is exercised offline against `scripts/probe-dandomain.mock.mjs`; the mock now
  encodes F4/F5/F2 behaviour so these findings stay regression-tested without a live shop.

---

## F16 — `Order_Create` CREATES THE ORDER AND STILL THROWS (duplicate-order hazard)

Live fault: `lineErrors: "Order: 4 created. Following products were not included: Product: 7"`.
**The order exists.** The fault describes a partially-applied write, not a rejected one. Our
probe's candidate loop created orders 4 *and* 6 before we noticed.

**Importer rule (invariant #1, DanDomain edition):** on fault code `lineErrors`, parse the id
out of the message (`/Order:\s*(\d+)\s*created/`), treat the order as **created-but-incomplete**,
and **never retry the create**. Reconcile the missing lines separately. Any retry-on-fault
policy that ignores this will duplicate orders on a real migration — the same failure mode as
the WP build's duplicate-order incident (PLAYBOOK §3), reached by a different route.

## F17 — A product must be `Online:true` AND `Stock > 0` to be orderable

`Product_CreateOrUpdate` with only `Status:true` produces a product that `Order_Create`
refuses to put on a line (F16's `lineErrors`). Setting `Online:true` alone was not enough.
With `Online:true` + `Stock:100` (+ `OutOfStockBuy:"1"`) the line was accepted.

Consequences: (a) the **seeder** must set Online/Stock explicitly or its orders come out empty;
(b) `Status` and `Online` are **two different flags** and both matter — the export must carry
both, and the publish/draft mapping into Shopify has to decide which one it honours (verified
read-back: `Status:"true"`, `Online:"true"`, `DisableOnEmpty:"false"`).

## F18 — VAT BASIS: **INCLUSIVE** (closed 2026-08-15)

Method: product written at `Price: 100` into the **25%** VAT group, then placed on an order via
`Order_Create`; order read back with `Order_SetFields`.

**Result: `Total: 100`.** Entering 100 on a 25%-VAT product yields an order total of 100 → the
`Price` field is **VAT-inclusive**, consistent with `Solution_GetWebinfo.ProductPricesWithVat:
"true"`. The money transform may now be written.

**Caveat — do not trust `Order.Vat` on a fresh order:** it read back `0` despite the 25% group
(order `Status:"0"` = *Ikke modtaget*). VAT appears to be materialised later (invoice/status
progression). The transform must derive tax from the product's `VatGroupId` + the shop basis,
not from `Order.Vat` alone, and must re-check this on an *invoiced* order before go-live.

## F19 — Order field-name traps

- `Order_SetFields` **rejects `CurrencyIso`** with `NOSUCHPARAM`. The valid `Order` type has 35
  fields (WSDL `complexType name="Order"`): `Id, InvoiceNumber, CurrencyId, Currency, CustomerId,
  Customer, UserId, User, Site, LanguageISO, Status, PaymentId, Payment, Transactions, Vat,
  Total, OrderComment, OrderCommentExternal, CustomerComment, DeliveryComment, DeliveryTime,
  TrackingCode, DateDelivered, DateDue, DateSent, DateUpdated, OrderLines, PackingId, Packing,
  DeliveryId, Delivery, DiscountCodes, ReferenceNumber, Origin, ReferralCode`.
- **`Order.CurrencyId` is NOT the `Currency_GetAll` id.** We sent `CurrencyId: 1` (DKK) and read
  back `4`, then `5` on the next order — it increments per order, i.e. it points at a per-order
  currency snapshot row. **Read currency from the nested `Currency` object, never from
  `Order.CurrencyId`.**
- Server-assigned on create: `Status: "0"` (*Ikke modtaget*), `DateUpdated: "0000-00-00 00:00:00"`
  (a zero-date that will break naive date parsing — treat as null).
- `ReferenceNumber` round-trips intact, confirming it as the carrier for the source order number.

## F20 — `CountryCode` resolved

`OrderCustomerCreate.CountryCode` accepts the **numeric `Id`** from
`Product_GetDeliveryCountryAll` (`"1"` for DK on this shop). `"DK"` is rejected
(`PARAM: CountryCode 'DK' is not a number`); the ISO-3166 numeric `208` was also accepted by the
country check. Resolve per-shop via the delivery-country list — do not hardcode.

## F21 — The shop's own settings ARE the migration config (doctor prototype)

`probe profile` reads `Solution_GetWebinfo`, languages, sites, currencies, VAT groups, order
statuses, payment/delivery methods, delivery countries, units and customer groups, and derives
everything a migration would otherwise have to **ask the merchant**:

| Derived | shop000000 | Source |
|---|---|---|
| generation guard | `hostedshop (modern)` | `SolutionId` present |
| VAT basis | **INCLUSIVE** | `ProductPricesWithVat` |
| storefront VAT display | incl | `ShowProductPricesWithVat` |
| currency + format | DKK, `,` decimal / `.` thousands, 2dp | `Currency_GetAll` |
| language layers | DK (primary) + UK, both siteId 1 | `Solution_GetLanguages` |
| custom order statuses | none (all 11 are stock) | diff vs known ids |
| customer groups | 4 -> **B2B pricing in play** | `User_GetGroupAll` |
| country id for orders | 1 (DK) | `Product_GetDeliveryCountryAll` |

**Design consequence:** the DanDomain `doctor` stage should run this and auto-populate config
instead of prompting, and use the census to decide which warnings are even *relevant* to that
shop (no kundegruppe warnings on a shop with one group; no multi-language warnings on a
single-layer shop). Two incidental facts worth keeping: delivery countries carry `Tax` /
`CompanyTax` (25 for DK) — a second, independent VAT signal; and a customer group can be flagged
`Producer: true` ("Brands / Producenter"), i.e. groups double as brand records on some shops.

## F22 — `Solution_HasModule` vocabulary is discoverable (fault = invalid name)

Undocumented, but a sweep settles it: a **valid** module name returns `true`/`false`; an
**invalid** one raises fault code `MODULE`. So the vocabulary can be discovered by probing.

Confirmed valid on this Success-plan shop (all returning `true`): **`blog`, `news`, `multisite`,
`filesale`, `seo`, `api`**. Rejected as invalid names (NOT "feature absent"): newsletter,
giftcard(s), b2b, customergroup, usergroup, multilanguage, variant(s), discount, productfields,
customfields, stocklocation(s), packet, bundle, download, subscription, redirect, graphql,
webhook, review, extrabuy, additional.

**Do not read `MODULE` as "feature off"** — it means "no such module key". Feature presence for
everything else must be inferred from data (e.g. customer groups exist -> B2B in play), not from
`HasModule`. `blog`/`news` returning true also corroborates F12: this shop really does have blog
content, reachable via the GraphQL experimental schema.

## F23 — GraphQL has TWO query conventions; the documented one is not universal

The docs show `pagination:{limit,page}` + `{data, pagination}`. That shape applies to **some**
queries only. Introspection of both schemas (`data/probes/gqlshapes.json`) shows:

**Convention A — input-wrapped** (`query(input: XInput)` -> `XPayload { content: XPagination, errors }`):
`giftCards, redirects, blogPosts, blogCategories, blogComments, discounts, productCategories,
pages, folders, currencies, units, languages, languagesV2, sites, deliveryCountries,
deliveryMethods, ordersByCustomerEmail, apiLogsV2, statistics*/reports*`

**Convention B — top-level args** (`query(pagination: PaginationOptions, search: XSearchInput,
sorting: XSortingInput)` -> `XPagination { pagination: PaginationData, data: [...] }`):
`orders, users, invoices, domains, webhooks, webhookLogs, webhookAttempts`

**Singletons:** `orderById(id: ID) -> Order`, `productCategoryById(id: ID) -> ProductCategory`.

The client must implement both, and `errors` on Convention-A payloads is a **per-query** error
channel separate from the top-level GraphQL `errors` array — both must be checked. Sending the
wrong shape returns `Unknown argument "pagination"` rather than an empty result, so a naive
client fails loudly (good) but a docs-driven one fails on half the entities (the point).

## F24 — Gift cards are FULLY migratable (balance included) — closes item (i)

`GiftCard` type (public schema): `id, code, initialValue, usedValue, expirationDate,
createdDate, orderBoughtBy, status, vatRate, active, refunded, ordersUsedOn,
languageLayerAccess, updatedDate, lastSentDate, giftCardUsages, note, usageLogs`.

**Outstanding balance = `initialValue - usedValue`**, with `code`, expiry, status and a usage
log all readable, plus `giftCardCreate`/`giftCardUpdate` for writes. The research phase's
"export-only, manual CSV step, likely not API-seedable" is **wrong** — gift cards are fully
exportable *and* seedable. Drop the manual PLAYBOOK step from the design.

## F25 — Order/payment truth lives in GraphQL, not SOAP — closes item (f)

Experimental `Order` type: `id, comments, origin, totalItems, subTotal, total, trackingCodes,
userAutoAssigned, isPaid, numberOfParcels, deliveryDate, createdAt, sentAt, updatedAt, dueAt,
referralCode, giftCardUsages, siteId, currency, customer, delivery, discountCode, employee,
invoice, language, orderLines, payment, status, transactions, transactionEvents, user, wrapping`.

- **Capture state (item f): CLOSED** — `isPaid` plus `transactionEvents { id, amount, type, createdAt }`
  give the payment event log SOAP never exposed.
- **`createdAt` is present** — the real order date, which `Order_Create` would not let us set
  and SOAP's `Order` type does not cleanly expose (F19's zero-date).
- `origin` carries the kreditnota/delordre linkage; `subTotal`+`total` separate the money;
  `siteId`/`language` carry the layer.

**Design consequence:** for ORDER EXPORT, GraphQL is the better channel and SOAP the fallback —
the reverse of the catalogue. The adapter's dual transport is per-entity, not per-stage.

## F26 — `invoices` is NOT the credit-note channel — item (n) partially closed

`Invoice` does not exist as a type; the `invoices` query returns `OrderInvoicePagination` of
**`OrderInvoice { id, createdAt, dueAt, isPaid, order }`** — a thin payment-due pointer, not a
document. Kreditnota therefore remains **order-shaped**: an order carrying status id `100`
("Kreditnota"), linked to its parent through `origin`. Partition credit notes by status+origin
as PLAN §3 assumed; do not expect a separate invoice document.

**Still open on (n):** whether kreditnota copies draw from the same order-number sequence.

## F27 — Rate limits: the documented 5/s was not enforced

12 back-to-back GraphQL calls (~8/s sustained, ~120 ms each) all returned **200** with **no**
`Retry-After` and **no** `X-RateLimit-*` headers. The documented "5 calls/second" did not fire in
that window. Treat 5/s as a **courtesy ceiling** the client should still honour, but do not
build retry logic that assumes a 429 will arrive — there may be no signal at all before
something else breaks. Longer/heavier bursts remain unprobed.

## F28 — `DateCreated` IS honoured on upsert — closes item (b)

`Product_CreateOrUpdate` with `DateCreated: "2019-01-05 10:00:00"` reads back
`DateCreated: "2019-01-05 10:00:00"`. Historic product dates are seedable, so the `dd-real`
tier can reproduce an aged catalogue rather than one created "today".

## F29 — Backdated PAID transactions work — closes item (a)

`Order_Create` with a nested `OrderTransaction { Status: 1, Date: "2019-01-05 10:00:00",
TransactionNumber, Cardtype, ... }` stores the transaction verbatim:
`Transactions[0] = { Status: "1", Date: "2019-01-05 10:00:00", TransactionNumber: "987654" }`.

So although `OrderCreate` has no order-date field (F19), **payment history can be backdated**.
Combined with F28, seeded orders can carry a credible historic payment record.

## F30 — Transaction `Amount` is in MINOR UNITS (øre) — money trap

`OrderTransactionCreate.Amount` is `xsd:int`. Sending `100` stored `1`; sending `10000` stored
`100`. **The field is in minor units (øre/cents); the read-back is in major units.**

`Currency` on the same object is likewise **numeric** (the currency id), not an ISO string —
sending `"DKK"` fails with `PARAM: Currency 'DKK' is not a number`, the same trap as
`CountryCode` (F20). Two string-typed fields in one object that both demand numbers.

**Client rule:** multiply by 100 when writing transaction amounts, and never pass an ISO code
where the WSDL says `string` — check whether the server means an id first.

## F31 — Order-level `Vat` is ALWAYS 0 on created orders; mixed VAT is unrepresentable — closes item (e)

A 25%-only order and a mixed 25%+0% order both read back **`Vat: "0"`** while `Total` was
correct (100 and 150 respectively — inclusive, confirming F18 twice more). The order-level
`Vat` field is simply not populated at creation, and a single scalar could not express two
rates anyway.

**Transform rule:** derive tax per line from each product's `VatGroupId` and the shop's basis
(F21). Never read `Order.Vat`. Flag orders whose lines span multiple VAT groups
(`MIXED_VAT_ORDER`), because the source itself does not carry the breakdown.

## F32 — Order number == `Id` — closes item (d)

`Order_GetByNumber(Start: 12, End: 12)` returns the order whose `Id` is 12, with its
`ReferenceNumber` intact. On a shop whose admin sequence start has not been raised, order
number and primary key coincide. `ReferenceNumber` round-trips and remains the right carrier
for the SOURCE order number during migration.

Also confirmed here: `DateDelivered` holds the **creation timestamp** (e.g.
`2026-08-15 18:41:30`) while `DateSent`/`DateUpdated` are zero-dates — the field names do not
mean what they say (the doc-bug the research flagged). Treat `0000-00-00 00:00:00` as null.

## F33 — Renames do NOT create recoverable redirects — closes item (h)

GraphQL `redirects` (correct Convention-A syntax) returned `pagination.total: 0` both **before
and after** renaming a product's `SeoLink`. Together with F8 (SOAP showed nothing), the
conclusion is firm: **URL history is not recoverable from the platform.**

**Design consequence:** the redirect map can only be built from the CURRENT slug set. Any URL
the shop served before an earlier rename is lost to us. Offer an optional operator input
(Google Search Console export / crawl) for legacy URLs, and record the gap as a documented
loss rather than implying full historical coverage. `Redirect` does expose
`wasCreatedManually`, `sourceHasWildcard` and `isForced`, so *manually created* rules — when a
shop has them — are exportable and classifiable for the wildcard/forced lossy cases.

## F34 — Storefront URL grammar is THEME-DEPENDENT — closes item (g), reshapes P3

> **⚠ VOID — REPLACED BY R39 + R41 (round 5). Do not use this table.**
> Every one of the five rows was fetched against `{tenant}.webshop.dandomain.dk`,
> which is the ADMIN host: its root is DanDomain's login page and its
> `/heimdal/...` routes are an admin single-page app that answers 200 with the
> same 7,460-byte shell for every path, including invented ones. So the one 200
> is a catch-all (R39) and the four 404s are negatives about the admin app — the
> table is void in BOTH directions. The storefront is `{tenant}.mywebshop.io`
> and its grammar is `/shop/{catId}-{catSlug}/{prodId}-{prodSlug}/`, confirmed by
> CONTAINMENT rather than by a status code (R41). The conclusion that a URL
> grammar must be discovered per shop survives; the evidence below does not.

Probed five candidate shapes against the live storefront. Only one resolved:

| Path | Status |
|---|---|
| `/heimdal/products/15` | **200** |
| `/shop/9-probe-kategori/15-probe-deep-backdated/` | 404 |
| `/webshop/9-probe-kategori/15-probe-deep-backdated/` | 404 |
| `/products/15` | 404 |
| `/produkt/15` | 404 |

This shop serves `/{theme}/products/{id}` — **not** the
`/{base}/{catId}-{catSlug}/{prodId}-{prodSlug}/` grammar the research documented from a
different live shop. The URL pattern therefore varies by theme/shop generation and **must not
be hardcoded**.

**P3 design change:** the redirect stage must **discover** the grammar per shop — probe a known
product id against a candidate list (exactly as this probe does) and confirm a 200 before
generating thousands of redirects from an assumed pattern. A wrong assumption here silently
produces an entire redirect map that 404s.

## F35 — No API channel for product media upload — closes item (m)

`Product_CreatePicture` takes `ProductPictureCreate { ProductId, FileName, Sorting,
ImageAltTexts }` — a **filename**, not bytes. Same for `ProductFileCreate { ProductId,
FileName, Sorting }`. `Solution_CreateThumb(ImagePath, ...)` likewise operates on a path.
**The file must already exist on the server**; nothing in the 247-operation SOAP surface
uploads binary content, and GraphQL's only upload mutation is `blogPostImageUpload`
(blog-scoped).

Consequences, split by direction:
- **EXPORT is unaffected** — `Product_GetPictures` returns filenames that resolve to public
  URLs, and Shopify fetches media from a URL (`originalSource`), exactly as the WordPress
  source does. No binary handling needed.
- **SEEDING is affected** — the `dd-real` tier cannot create products with images via API.
  Either pre-place files through the admin file archive once and reference them by name, or
  seed image-less products and document the gap. This mirrors the WP source's known
  near-zero media coverage; it is a test-fidelity limitation, not a migration limitation.

## F36 — SOAP session survives at least 8 minutes idle — closes item (j)

Connected, idled **480 s** with no traffic, then called `Solution_GetWebinfo` again: succeeded,
no `AUTH` fault. The cookie session is not aggressively short-lived, so an exporter that pauses
between entity batches (or waits out a rate limiter) does not need to reconnect defensively.

Bound, not a limit: longer idles are untested. The client rule is unchanged and is what actually
makes this safe — **treat any `AUTH` fault as reconnect-once-and-replay**, and only ever replay
idempotent reads (never a create, per F16).

## F37 — Order emails: conditional, EXCEPT status "Ordre modtaget" which ALWAYS mails — closes item (c)

Our probe orders fired no customer email because they were created with **status `0`
("Ikke modtaget")**, and because a demo shop has no mail sending configured. But the mechanism
matters more than this shop's outcome. Per DanDomain's own help
([Ordrestatus](https://webshop-help.dandomain.dk/ordrestatus/)), a status change emails the
customer only when **both** hold:

1. the order's checkbox *"Send automatisk e-mail ved status ændring"* is enabled, **and**
2. *"Send e-mail til kunde"* is enabled on that status's e-mail template.

**The exception is the dangerous part**, quoted verbatim from the help: order status
*Ordre modtaget* "sender altid en mail til kunden uanset indstillingerne" — **status `1` always
emails the customer, regardless of settings.**

**Seeder rules (hard):**
- **Never call `Order_UpdateStatus` with status `1`** on any shop that could hold real customer
  addresses. Walk statuses from `0` upward and skip `1`, or seed only on a shop whose customer
  emails are synthetic.
- Keep the existing ban on `Order_Send*Email`.
- `Order_Create` itself did not email at status `0`; treat "created quiet" as true only for
  status `0`, not as a general property.
- On a **client** shop this is not merely a seeding concern: any tooling that touches order
  status during a migration rehearsal could mail that shop's real customers.

We got away with it by luck — the probe's status walk happened to select `codes[0]`, which is
`0`. Had `OrderStatusCode_GetAll` returned a different order, it would have set `1` and mailed
`probe-oc@example.com`.

## F38 — Kreditnota: linked by `Origin` + negative `Total`, NOT by status 100 — closes item (n)

Created a credit note in the admin ("opret kreditnota") on order **16**; it produced order **17**.
Read through both transports:

| | parent 16 | credit note 17 |
|---|---|---|
| `Id` | 16 | **17 — the next id, same sequence** |
| `Status` | `0` (Ikke modtaget) | **`99` (Kladde / draft)** |
| `Total` | `150` | **`-150`** |
| `Origin` | `""` | **`"16"`** |
| `ReferenceNumber` | `SRC-MIXED-VAT` | **`SRC-MIXED-VAT` (inherited!)** |
| GraphQL `subTotal` | 150 | −150 |
| `createdAt` | 18:41:31 | 19:29:56 |

**Three corrections to the design:**

1. **Do NOT identify credit notes by status `100`.** PLAN §3 assumed status 100 ("Kreditnota")
   marks them. A freshly created credit note carries status **`99` (Kladde/draft)** — 100
   presumably applies only once booked. **Partition on `Origin != ""` (plus a negative
   `Total`), not on status.** Identifying by status would have silently skipped every
   unbooked credit note on a client shop.
2. **`ReferenceNumber` is INHERITED by the credit note**, so it is not unique across documents
   and cannot serve alone as an idempotency key or as the source-order identifier. Key the
   ledger on `Id`; keep `ReferenceNumber` as a data field only.
3. **The credit amount is the negative `Total`** — the refund value falls straight out, and
   line ids are distinct (12/13 vs the parent's 10/11), so a partial credit is expressible as
   a subset of lines.

**Transform rule:** group source orders by `Origin`; any order with a non-empty `Origin` is a
credit document belonging to that parent, folded into the parent's Shopify order as a
`refundCreate` of `abs(Total)` (gate decision: real refunds in v1). Orders in draft status
(`99`) that are credit notes should still fold, with a warning noting they were unbooked at
export time. Both transports agree on `origin`/`total`, so either channel can drive this.

Shared numbering is now confirmed: credit notes consume order ids from the same sequence, so
an id gap in an export is not evidence of missing orders.

---

# ⚠ ADVERSARIAL REVIEW — 2026-08-15. P1 REOPENED. Read this before trusting anything above.

Two hostile reviewers audited F1–F38 against the raw probe JSON and the WSDL. They found that
the write-up **repeatedly reports the intended conclusion rather than the recorded result**.
Several probes' own `interpret`/`verdict` strings say "unresolved" / "check the admin" /
`reconnectWorked: null` while the corresponding finding claims closure.

**Verdict: NO-GO for P1b.** The findings below are DISPUTED or INVALIDATED until re-probed.
Findings not listed here survived audit; the strongest are those read directly from the WSDL or
introspection (F1, F35's absence claim, F13's negative half, F19's field list).

## INVALIDATED — these are wrong, not merely thin

**F18 / F31 — the VAT gate is NOT closed. This was the one hard gate.**
The probe sent its own line price: `OrderLines:{item:[{ProductId, Amount:1, Price:100}]}`.
`Total: 100` is therefore the sum of what the client submitted — **the exclusive hypothesis
predicts exactly the same number**. The server was never asked to price anything. Corroborating:
delivery costs 70 on this shop and `DeliveryId` is mandatory, yet `Total` was exactly 100 — so
`Total` is demonstrably not a materialised order total. **Do not write the money transform.**
Re-probe: create an order *omitting* `OrderLineCreate.Price` so the server prices it, then read
`Total`; and read `PROBE-VAT-25`'s price in the admin.

**F31's mechanism claim is factually wrong.** "A single scalar could not express two rates
anyway" — the WSDL has **`OrderLine.VatRate` (double) per line**, and `OrderLineCreate.Vat`.
Per-line VAT exists; the probe never sent or read it. `Vat: 0` is explained by not sending it.

**F24 — gift cards are NOT verified.** `gqldeep.json.giftCardsQuery` is three GraphQL errors
(`Unknown argument "pagination"`, `Cannot query field "data"`). **Zero gift cards were read.**
Balance = `initialValue − usedValue` is inferred from two field names, never computed.
`giftCardCreate` was never called and its input type never introspected — so "seedable" is
unproven, and if it mints a NEW code the migration is worthless (customers hold the old codes).
This is F15's error repeated, and it has already been promoted to a gate decision.

**F32 — "order number == Id" is circular.** The probe passed the Id *in* as the number
(`Order_GetByNumber({Start: paid.id, End: paid.id})`). It cannot distinguish "number equals id"
from "GetByNumber takes ids". Worse: `InvoiceNumber` was requested in three separate
`Order_SetFields` calls and appears in **zero** artifacts — it silently never returned.

**F13 — conflates "operation exists in the WSDL" with "we created one".** Only products,
categories and orders were demonstrably created. Variants, users, discounts, CMS pages and
currencies were never created live. F4 is the standing proof that WSDL readings are unsafe.

## SEVERE GAPS — silent-corruption channels

**Order lines were never read.** `Order_SetOrderLineFields` was called with field names that do
not exist (`Title`, `Vat` — the read type has `ProductTitle`, `VatRate`), the fault was
swallowed by a bare `catch`, and every "lines" result in every artifact is the default
projection `{Id, PacketLines, LineAddresses}`. **No line-level money data has ever been
observed**, yet PLAN §3 maps line items, discount lines and fee lines in detail.

**`*_SetFields` is not a contract.** A requested field can be absent from the response with no
error (`InvoiceNumber`). Combined with the above, this is a silent-truncation channel running
through every entity. **The client MUST diff requested vs returned keys on the first record of
each batch and raise `FIELD_SET_TRUNCATED`.**

**Price lines (rabatlinjer) — zero probes, live money-corruption path.** `Product_GetDiscounts`
was never called. `ProductDiscount` carries `UserType`/`UserId` — price lines are scoped to
customers/groups. PLAN §3's "lowest-wins" over an unfiltered set would **import a B2B price as
the public price**. This shop has 4 customer groups.

**HTML entities in API payloads.** One `Payment_GetAll` response contains both
`Kontooverf&oslash;rsel` and `Ingen betaling nødvendig` — entity-encoded and raw UTF-8, same
field, adjacent rows. F2's mojibake detector cannot see `&oslash;`, and `profile.json`'s derived
config has already copied the entity form through. Needs a per-field entity-decode allowlist.

**N+1 explosion, and F11 is false comfort.** Eight `Product_Get*` ops take a single `ProductId`;
order sub-reads are per-order and per-line. 10k products ≈ 110k calls; 50k orders ≈ 200k. At the
planned 4 rps that is 20+ hours. `limits.json` returned `"returned": 10` for **every** page size
(the shop has 10 products) — it bounds nothing. **The unasked architecture question:** can
`Product_SetFields` inline `Variants,Pictures,CustomData,Discounts`? `Order_SetFields`
demonstrably inlines `Transactions`. If products inline too the export is ~10 calls, not 110k.
Nobody tried. **Highest-ROI probe in the whole backlog.**

**Reconnect resets session field state.** F36's rule (AUTH → reconnect-and-replay) creates a NEW
session with the DEFAULT field set — so the replayed read returns a smaller record, silently.
`reconnectWorked` is `null`: the safety net was never executed.

**Entities with ZERO probes:** customers (0 read ops — 56-field type unverified, incl.
`Consent`/`ConsentDate` distinct from `Newsletter`, a GDPR question), variants and variant types,
discounts, discount groups, CMS pages (**and there is no `PageText_GetAll` — no SOAP enumeration
path exists**), product custom fields, images (**`Product_GetPictures` was never called**, so
F35's "export is unaffected" is an assumption with catalogue-wide blast radius), newsletter.

**`Product_GetTags` returns `{Rating, Text, UserEmail, DateCreated}`** — that is a review
record, not a tag. PLAN §11 dropped reviews as "no native review system found". Re-open.

## Method failures to fix before re-probing

1. **12 bare `catch` blocks** in the probe kit; at least one hid the total failure of an entity
   layer and let a false "closed" claim into this document. Convert every one to a recorded
   failure and re-run — expect more findings to fall.
2. **Artifacts mix clean and mojibake-corrupted captures** (`smoke.json`, `ordercreate.json`
   predate the decode fix). Triage before minting fixtures, or the corruption is frozen into the
   test suite.
3. **Every behavioural conclusion came from probe-created orders that never passed a checkout** —
   one currency, one delivery method, no shipping cost, no payment fee, no discount code,
   status 0. `Order.Delivery`, `Order.Payment`, `Order.DiscountCodes`, `Order.Customer` were
   never requested in any field list.
4. **Report the recorded result, not the intended one.** Where a probe's own output says
   inconclusive, the finding must say inconclusive.

---

# P1-REDO — round 1 results (2026-08-15, after the adversarial review)

Probes re-run with fault recording and a field-set audit. **The review was right**, and the
corrected probes changed several conclusions. These supersede the findings they name.

## R1 — VAT, done properly: product prices are INCL, order money is EX. **Supersedes F18/F31.**

The old probe supplied its own line `Price`, so `Total` was just its own input. Re-run with the
line carrying **no `Price`**, so the server prices from the product:

| order | line | server-priced line `Price` | `Total` |
|---|---|---|---|
| server-priced, 25% product entered at 100 | 1 × PROBE-VS-25 | **80** | **80** |
| client-priced (control), same product | 1 × PROBE-VS-25 @100 | 100 | 100 |
| mixed, server-priced | 25% @100 + 0% @100 | **80 + 100** | **180** |

100 ÷ 1.25 = 80. **`Product.Price` is VAT-INCLUSIVE** (F18's conclusion was right, but its
evidence was a tautology). **And the order side is NET: order-line `Price`/`PriceRounded` and
`Order.Total` are EX-VAT.**

**This is the defect F18 would have shipped:** a transform that copies a product's gross price
into an order line — or reads `Order.Total` as a gross total — inflates or deflates every
historical order by the VAT rate. Two different bases in one API, with the same field name
`Price` on both sides.

The control matters: when the client *supplies* a line price, the server stores it verbatim as
the net price. So a seeder must send **net** line prices, not the product's gross price.

## R2 — Tax rate is not in the order at all

Even on the server-priced order, `Order.Vat` = `0` **and** the per-line `VatRate` = `0`. The
rate is carried by the product's `VatGroupId` only. **Derive tax from the product's VAT group +
the shop basis; never read `Order.Vat` or `OrderLine.VatRate`.** (F31's conclusion survives; its
stated mechanism — "a scalar cannot express two rates" — was wrong, since `OrderLine.VatRate`
exists. It is simply never populated.)

## R3 — Silent field truncation, CONFIRMED and now detected

The new audit diffs requested vs returned keys on every read. On every order:
`InvoiceNumber` — **requested, never returned, no error.** On every order line: `PacketId` and
`Status` — same. This is the review's G2, reproduced deliberately.

**Client rule (mandatory):** after the first record of each batch, diff the requested field list
against the returned keys and raise `FIELD_SET_TRUNCATED` naming the missing fields. Without it,
an exporter silently drops columns it believes it asked for.

## R4 — One bad field name poisons the whole call, and the session keeps the OLD field set

`Product_SetFields` with a list containing a single invalid name (`Files`) faults **the entire
call** with `NOSUCHPARAM`. The session then **retains the previously-set field list**, and the
next read succeeds with the wrong shape **and no error**. Our first nested-inlining run was
invalidated exactly this way and would have been reported as "inlining does not work".

**Client rule:** validate every field name against the WSDL type before sending, treat any
`NOSUCHPARAM` as fatal, and re-assert the field set after any fault or reconnect.
Valid nested names on `Product`: `Variants, Pictures, CustomData, Discounts, Tags,
SecondaryCategories, StockLocations, VariantTypes`. **Invalid:** `Files`, `ProductFiles`,
`DeliveryTimes`.

## R5 — ARCHITECTURE: nested inlining WORKS. The export is a batch loop, not an N+1 crawler.

`Product_SetFields("Id,ItemNumber,Title,Price,Variants,Pictures,CustomData,Discounts,Tags,
SecondaryCategories,StockLocations,VariantTypes")` → `Product_GetAllWithLimit` returns those
arrays **inline**, populated: variants with ids, `Pictures` with `{Id, ProductId, FileName,
Sorting, ImageAltTexts}`, `StockLocations` with `{StockLocationId, DeliveryTimeId, Stock,
BuyPrice}` (per-location buy price), `VariantTypes` (e.g. "Størrelse").

This answers the review's highest-ROI question (G8). The projected ~110,000 calls for a 10k
catalogue collapse to a paged batch loop. **Design the exporter around inlined reads**; keep the
per-product `Product_Get*` ops only as fallbacks for whatever does not inline.

## R6 — The hand-rolled XML parser is NOT adequate for nested reads

On the inlined response the probe's naive parser collapsed repeated elements across records:
scalar ids came back as arrays (`Id: ["1","3"]`), sibling values were hoisted into parallel
arrays, and inlined category objects were merged into the product list. Passing a derived id
back to the server then produced a genuine server fault:
`Receiver: SOAP-ERROR: Encoding: Violation of encoding rules`.

**P1b requirement:** `client.js` needs a real XML parser that preserves record boundaries and
distinguishes "one child" from "many children" per element — not the probe's regex walker. This
is now an evidenced requirement, not a preference.

## R7 — MEDIA IS UNRESOLVED. **F35's "export is unaffected" is FALSE as stated.**

`Product_GetPictures` works and returns real rows — 6 products, `FileName` values
`product-1.png` … `product-6.png`. But **none of the candidate URL bases resolved**: all four
returned **404** (`/images/`, `/`, `/shop/files/`, and the `sw{n}.sfstatic.io/upload_dir/pics/`
form). So a filename is confirmed to exist and is **not yet resolvable to a fetchable URL**.

Blast radius: Shopify fetches media server-side from `originalSource`. A wrong base yields **zero
images across the entire catalogue** with a clean-looking import and no error. **Media export is
BLOCKED** until the real base is found — inspect an actual product page's `<img src>` on the
storefront, or find the CDN host in the theme.

## R8 — Full order shape is now known (first real read)

`Order_SetFields` with `Delivery,Payment,Customer,DiscountCodes` returns them as populated
nested objects: `Customer{...30 fields, CountryCode:"1" — the numeric id we sent, B2B:"false"}`,
`Delivery{DeliveryMethodId, Title, Price, BuyPrice, ServiceType, DroppointId}`,
`Payment{PaymentMethodId, Title, Price, Vat, ExternalId}`. Order lines carry 30 readable fields
incl. `ProductTitle, VariantTitle, ItemNumber, Amount (QUANTITY), Price/PriceRounded,
Discount/DiscountRounded, Weight, Unit, OfflineProduct, StockLocationId`.

Note the collision the review flagged: **`OrderLine.Amount` is a QUANTITY, while
`OrderTransaction.Amount` is MONEY IN ØRE (F30).** Same name, same API, different meaning and
different unit.

## R9 — CORRECTION to R7: media is NOT blocked. Two viable paths, FTP is the guaranteed one.

R7 overstated the problem by calling media "BLOCKED". What is unresolved is only the *cheap*
path — resolving `FileName` to a public URL. Two paths exist:

**Path A (cheap, unresolved): public URL → Shopify `originalSource`.** Shopify fetches media
server-side from a URL; this is what the WordPress source does and it moves no bytes. Four
candidate bases returned 404. **One cheap probe settles it:** open a product page on the
storefront and read the actual `<img src>` (or the JSON the `heimdal` theme fetches for a
product), then generalise the base. Do this before building anything heavier.

**Path B (guaranteed): FTP + Shopify staged uploads.** DanDomain shops expose the file archive
over FTP. Download the binaries, then push them through `stagedUploadsCreate` →
`productCreateMedia`. **This path is already proven in this codebase** — the WP redirect importer
uses staged uploads, so the client, retry handling and pinned mutations exist. Costs bandwidth
and a temp stage, but it is immune to a wrong CDN base and to hotlink protection.

**FTP also closes F35's seeding gap.** F35 established there is no API channel to upload product
media, so `dd-real` would have seeded image-less products. With FTP the seeder can pre-place
files and then reference them by `FileName` via `Product_CreatePicture` — which is exactly the
shape that operation expects (it takes a filename, not bytes).

**Design consequence:** the media importer should try Path A when a base is known and verified
(HTTP 200 + `content-type: image/*`), and fall back to Path B otherwise. `doctor` should probe
one known image URL and report which path this shop will use, so a wrong base surfaces before
the import rather than as a catalogue of missing images.

**Needed to close:** FTP credentials for shop000000 in the gitignored `.env`, and one real image
URL from a storefront product page.

## R10 — FTPS transport: hand-rolled, dependency-free. Spec for P1b.

Host: **`ftps.mywebshop.io`** — FTPS, so `node:tls` covers it and **invariant #6 (zero runtime
dependencies) holds**. Do NOT add an npm FTP client.

**Try both FTPS flavours, in this order:**
1. **Explicit (FTPES), port 21** — connect plain over `node:net`, send `AUTH TLS`, then upgrade
   the socket with `tls.connect({ socket })`. Most common for a `ftps.` host.
2. **Implicit, port 990** — `tls.connect` from the first byte.
Record which one answered in the site profile so `doctor` does not re-discover it every run.

**After the control channel is up:** `PBSZ 0`, `PROT P` (encrypt the data channel — many servers
refuse data transfers without it), `USER`/`PASS`, `TYPE I` (binary — text mode corrupts PNGs),
then `PASV` for each transfer. Parse the `227 (h1,h2,h3,h4,p1,p2)` reply for the data host/port;
**reuse the control connection's host** rather than the advertised IP when they differ (NAT).

**Only four commands are needed:** `LIST` (discover), `RETR` (download for export), `STOR`
(upload for seeding), `MLSD`/`SIZE` optional for metadata. Roughly 150–200 lines.

**Where it plugs in:**
- **Export:** fallback for R9 Path A — when a `FileName` has no verified public URL, `RETR` the
  bytes and push them through Shopify `stagedUploadsCreate` → `productCreateMedia` (a path this
  codebase already proves for redirect imports).
- **Seeding:** `STOR` files into the archive, then `Product_CreatePicture` references them by
  `FileName` — **this closes F35's "no API channel for media" gap entirely.**
- **First-run setup (adopted):** `sites_add --kind dandomain` takes FTP host /
  user / password as `${ENV}` refs alongside the SOAP and GraphQL credentials, and **`doctor`
  verifies them with one connect + `LIST`**. A wrong file archive then fails during setup, not
  three hours into an import as silently missing images.

**Credential handling:** `.env` only (`DD_FTP_HOST`, `DD_FTP_USER`, `DD_FTP_PASSWORD`), redacted
by the MCP call recorder exactly like the Shopify secrets.

**Test strategy:** the mock server pattern extends here — a tiny local FTPS listener for the
offline suite, so `client.js`'s FTP path has regression coverage without touching a live shop.
Live verification runs natively via the MCP (the sandbox has no egress).

**Untested as of this writing.** Nothing above has been executed against `ftps.mywebshop.io`;
it is a specification derived from the hostname and the protocol, and the first live connect may
correct it. Treat the flavour, the `PROT P` requirement and the PASV/NAT note as hypotheses to
confirm on the first run — that is exactly the discipline the adversarial review enforced.

---

# P1-REDO — round 2 (2026-08-15). FTPS live, media resolved, review gaps probed.

Evidence: `data/probes/ftp.json`, `imgurl.json`, `gaps.json`. New probes: `ftp`, `imgurl`,
`gaps` (all read-only except `ftp --write`). Offline coverage: `scripts/probe-dandomain.ftp-mock.mjs`
+ 26 new assertions in `scripts/probe-dandomain.test.mjs` (51 total, green).

**Where to look for a run that FAILED.** `save()` overwrites `data/probes/<name>.json` but
*appends* to `data/probes/probe-log.jsonl`. A failing run that a later successful run replaced is
gone from the per-probe artifact and still present in the log. Two findings below (R11, R15) cite
failures that live only in the log — an adversarial audit of this round flagged them as
"unrecorded quotes" precisely because it read the JSON and not the log. **Cite `probe-log.jsonl`
whenever the claim concerns a run that no longer exists in its own artifact.**

**This round was adversarially audited before sign-off, and the audit changed eight claims:**
an overstated F35 closure (R13), a flatly wrong account of why R7 failed (R14), two unstated
bounds (R19, R20), a dead instrumentation field (R11) and three softened generalisations. The
corrections are folded in below rather than listed separately — but note that the audit was
itself wrong on one point, and checking it was what produced the `probe-log.jsonl` note above.

## R11 — FTPS transport CONFIRMED, and R10's handshake ORDER was wrong

`ftps.mywebshop.io` answers **explicit FTPS on port 21** — `220 ProFTPD Server ready.`
TLS 1.2, `ECDHE-RSA-AES128-GCM-SHA256`, certificate `*.mywebshop.io` issued by *Sectigo Public
Server Authentication CA DV R36*, and **`authorized: true`** — the chain validates against the
system store, so `client.js` should keep certificate verification ON rather than inheriting the
probe's permissive setting.

Confirmed as specified in R10: `PBSZ 0` → `200`, `PROT P` → `200 Protection set to Private`,
`TYPE I` → `200`, `PASV` → `227`, `AUTH TLS` → `234` on the first try (no `AUTH SSL` fallback
needed), zero bytes lost across the upgrade (`leftoverBeforeUpgrade: 0`).

**CORRECTION — R10 got the data-channel handshake order wrong.** R10 implied: connect the PASV
socket, upgrade it, then transfer. Live, that hung on **every** LIST:

```
"tree": { "/": { "error": "secureConnect timeout after 20000ms" } }
```

**Evidence location:** that run is in `data/probes/probe-log.jsonl` (two occurrences), **not** in
`ftp.json` — the successful re-run overwrote the artifact. The recorded fact is the timeout. That
*ProFTPD requires* the post-1xx order is the **inference** drawn from it: we changed one thing and
the hang went away, we did not instrument the server. The working order is:

> `PASV` → TCP-connect the data port → **send `LIST`/`RETR`/`STOR`** → read `150` →
> **then** TLS-upgrade the data socket → transfer → read `226`.

This order is also safe against servers that handshake immediately, because the TLS client
speaks first either way. It is now the client's only code path, and the offline mock reproduces
the ProFTPD ordering so a regression cannot re-introduce the hang.

**The data channel REQUIRES control-session resumption.** `dataTls.sessionReused: true`. Passing
`session:` from the control socket is load-bearing, not defensive. One subtlety worth keeping:
the session ticket can arrive *after* `secureConnect`, so the client captures the `session` event
as well as calling `getSession()` — relying on `getSession()` alone can silently yield no ticket,
which presents as a refused data channel rather than as a missing option.

`FEAT`: `AUTH TLS · CCC · CLNT · CSID · EPRT · EPSV · HOST · LANG C.UTF-8* · MDTM · MFF · MFMT ·
MLST · PBSZ · PROT · RANG STREAM · REST STREAM · SIZE · SSCN · TVFS · UTF8`. `REST STREAM` means
resumable transfers are available if a large archive ever needs them.

**Two R10 items remain UNPROVEN, and must not be written up as confirmed:**
- **Implicit-on-990 was never tested** — the probe skips it once explicit connects
  (`"skipped": "a previous flavour already connected"`). The fallback path is code, not evidence.
- **The PASV/NAT rule was not exercised.** `advertisedDifferedFromControl: false` on all 12
  connections — this host advertises its own address. Reusing the control host stays in as
  defence (and the mock regression-tests it), but this shop did not demonstrate the need.

**Kit bug found by the audit and fixed:** `attempts[].authTlsFirstReply` read `null` on every
successful run, because the field was only assigned on the `AUTH TLS` *failure* path. The
`234` is still recorded — in `transcript[2]`, `"234 AUTH TLS successful"` — but the summary field
was dead. It now records the reply unconditionally plus `authSslFallbackUsed`. Same class of
silently-dead safety net as R18's `fieldAudit` bug; naming them is the point.

## R12 — The file archive layout, and how `FileName` resolves

Archive root (`LIST /`): `blog · calendar · docs · export · import · language · news · pics ·
private · shop · templates · users`.

**`Product_GetPictures.FileName` resolves to `/pics/{FileName}`.** `/pics/` holds
`product-1.png … product-6.png` plus `slide.png`. Also present: `/blog/featured-image.png`,
`/news/article.png` — blog and news media have an FTP path too.

`RETR /pics/product-1.png` → **71,236 bytes**, equal to the size `LIST` reported, first eight
bytes `89504e470d0a1a0a`. Binary mode is intact end to end.

**Not walked, and therefore unknown:** `/private`, `/shop`, `/templates`, `/users`,
`/docs/fortrydelsesformular`. The walk stops as soon as its target filenames are found. `/shop`
carries a **link count of 4** (`drwxrwxr-x 4`), i.e. two subdirectories, and the storefront serves
category images from `upload_dir/shop/category/…`, so **category media most likely lives under
`/shop` — unconfirmed.** (Read the link count, not the byte size: `/blog` is 152 bytes and holds
a file.)

## R13 — STOR round-trips. **The FTP half of F35's seeding gap is closed.**

`STOR /pics/shoplift-probe-<ts>.png` → `150` … `226`; `RETR` of the same path returned
`identical: true` against the 67 bytes sent; `DELE` → `250`, cleaned up. So the seeder **can**
pre-place binaries over FTPS.

**Bound — do not write this up as F35 closed outright.** `Product_CreatePicture` **was never
called.** That SOAP will bind an FTP-placed file by `FileName` is the shape the operation's
signature implies (F35), not something this probe demonstrated, and the file uploaded was a
67-byte placeholder rather than a real image. **The remaining half is one `--write` probe:
`STOR` a real image, then `Product_CreatePicture` referencing it, then read it back through
`Product_GetPictures` and fetch it over HTTP.** F35's "no API channel for media upload" stands as
a statement about SOAP; whether `dd-real` can seed images end to end is still open.

## R14 — MEDIA PATH A RESOLVED. **Supersedes R7 and R9. The HOST was wrong, not the path.**

| URL | Result |
|---|---|
| `https://shop000000.mywebshop.io/upload_dir/pics/product-5.png` | **200 `image/png`, 74896 bytes** |
| `https://shop000000.sfstatic.io/upload_dir/pics/product-5.png` | **200 `image/png`, 74896 bytes** |
| `https://shop000000.webshop.dandomain.dk/upload_dir/pics/product-5.png` | 404 |
| `…dandomain.dk/{pics,images,/}product-5.png` | 404 (all) |

74,896 bytes is exactly what FTP `LIST`ed for `/pics/product-5.png` — two independent channels
agreeing on a byte count, which is what makes this a fact rather than a hopeful `GET`.

**Why R7 failed — and R7 misreported its own result.** Three of R7's four candidates used
`webshop.dandomain.dk`, which does not serve media at all; those returned 404. **The fourth,
`sw105698.sfstatic.io/upload_dir/pics/`, had the path exactly right and only the tenant
subdomain wrong — and it did not return 404, it returned a transport error.** `media.json`
records `{"url": "https://sw105698.sfstatic.io/upload_dir/pics/product-5.png", "error": "fetch
failed"}` for both attempts: six 404s and two errors, not "all four 404". R7's own artifact
contradicts R7's sentence, and this write-up initially repeated the mistake — the same
report-the-intended-result failure the adversarial review exists to catch, caught this time by
re-reading `media.json` during the audit.

The lesson is sharper than "the base was wrong": R7 was **one hostname guess** away from
resolving media, and a `fetch failed` was written up as a 404. **A transport error and an HTTP
404 are different findings and must never be collapsed** — one means "no such file", the other
means "we never reached a server".

The real CDN host is **`{tenant}.sfstatic.io`** (i.e. `shop000000.sfstatic.io`), not
`sw{digits}.sfstatic.io`. No DNS was probed, so do not claim the `sw{digits}` family is fake —
it demonstrably exists: this shop's own front page loads DanDomain banners from
`sw10198.smartweb-static.com`, which resolves and answers. The likeliest reading is that R7's
`sw105698` simply was not this tenant's id.

**Honest caveat, recorded in the artifact as `observedInMarkup: false`:** no page ever referenced
a product `FileName`. The heimdal product pages are JS shells (7,460 bytes, zero image URLs).
The base was **derived** — FTP archive directory `/pics/` plus the `/upload_dir` prefix observed
on `slide.png` and the category thumbnails — and then **verified** by 200 + `image/*` + matching
byte count. It was not observed in the wild. (The derivation is recorded as
`imgurl.json.channels.derivedCdnPrefixes`, which reports the **derived CDN prefixes** it
recovered by matching files it knew were in the FTP archive: `["/upload_dir"]`.)

**And one cheaper confirmation was skipped:** `imgurl.json.channels.createThumb` reads
`{"skipped": "Solution_CreateThumb writes a thumbnail file — re-run with --write to use it as a
path oracle"}`. `Solution_CreateThumb(ImagePath, …)` returns `xsd:string`, so it is the server's
*own* statement of where an image lives. **Running `imgurl --write` would turn "derived" into
"the API told us" without depending on markup at all** — the cheapest remaining item in this area.

Two further details for the importer:
- The CDN also serves `_thumbs/` derivatives (`slide.w1200.png`,
  `category-3.w380.h380.backdrop.png`). **Import the original, never a derivative.**
- Category images sit under `upload_dir/shop/category/`, a different subtree from products.

**Which base to use.** The artifact's `resolvedBase` is
`https://shop000000.mywebshop.io/upload_dir/pics/` only because that URL was tested first; both
bases byte-match. **Prefer `{tenant}.sfstatic.io` — it is the host the storefront's own markup
uses for all 19 of its front-page images**, i.e. the actual CDN rather than the application
origin. Do not let a reader of `resolvedBase` conclude otherwise.

**Design consequence (refines R9):** Path A is viable, so the importer should prefer
`originalSource` and keep Path B (FTPS + `stagedUploadsCreate`) as the fallback. `doctor` must
verify the base **per shop** — 200 plus `content-type: image/*` — and **record the base it
verified** rather than inheriting either default, because this base was derived and a shop on a
different generation may differ.

## R15 — CMS pages DO enumerate over SOAP. Corrects the review's "no enumeration path exists"

There is genuinely no `PageText_GetAll`. But `PageText_GetByFolder(FolderId)` swept over 0–20
enumerates fine:

| Folder | Pages |
|---|---|
| 3 | Om os, Kontakt, Handelsbetingelser, Cookies |
| 6 | Nyheder |
| 8 | Produktkatalog |
| 0, 1 | 1 row each (title not extractable through the naive parser — see R18) |

**A folder-id sweep is a working SOAP enumeration path.** What is still unknown is the folder-id
*upper bound*; GraphQL `folders` (F12) answers that authoritatively and should drive the sweep
rather than a guessed range.

`PageText_GetByIds` takes `PageTextIds` as **`xsd:string`** (comma-separated), not an array.
Sending `{item:[…]}` produced `Receiver: SOAP-ERROR: Encoding: Violation of encoding rules` —
a guessed argument shape faulting exactly as R4 predicts. **That fault is in
`data/probes/probe-log.jsonl`, not in `gaps.json`**, which now records the corrected string-form
call (`byIdsOk: true`, `byIdsCount: 1`) because the successful re-run overwrote the artifact.

## R16 — `Order_GetByDate`'s `Status` argument IS optional. Closes the review's question.

| Call | Orders returned |
|---|---|
| `Status` omitted | **20** (ids 1–20) |
| `Status: ""` | 20 |
| `Status: "0"` | 19 (all but 17) |
| `Status: "99"` | 1 (order 17) |

19 + 1 = 20 exactly: the **two status values tried** partition this window, and omitting `Status`
returns the full set. **A date-window export does not need to loop every status id.** The feared
silent partial export does not occur on this server. (Bound: two of eleven status ids were tried,
on a 20-order shop.)

Incidentally this corroborates F38 from a third direction: order 17 is the credit note, and it
is the single order at status 99.

## R17 — Unrecognised ARGUMENT names are silently dropped. Extends R4 from fields to arguments.

`Order_GetAllWithPagination` takes `Page`/`PageSize`. Sending `Start`/`Length` did **not** raise
`NOSUCHPARAM`; the server replied

```
Too few arguments to function WebService::Order_GetAllWithPagination(),
0 passed in /code/smartweb/latest/api/service.php on line 108 and exactly 2 expected
```

— i.e. unknown elements are discarded *before* dispatch and the failure surfaces as an **arity
error**. With the correct names the call returns 20 orders. R4's rule ("validate names against
the WSDL") therefore applies to operation arguments as well as to `*_SetFields` lists, and the
client's fault classifier must recognise this PHP arity message as a name error, not a transient.

## R18 — R6 confirmed twice more, and **the field-set audit is unsafe on top of the naive parser**

`Product_GetVariants` and `PageText_GetByFolder`/`GetByIds` both come back collapsed. The audit
reports, for variants:

```
returned: ["item","MinAmount","Title","Unit","StockLocations"], truncated: true
```

…while the sample printed beside it shows `Id`, `ProductId`, `Stock`, `Price`, `BuyingPrice`,
`Discount` all present *inside* `item`. **The truncation is the parser's, not the server's.**
`StockLocations` came back as `[{…}, [{…}], [{…}]]` — scalar and array shapes mixed inside one
field, the same defect R6 recorded on products, now reproduced on two more entities.

**Requirement for P1b, sharper than R3 stated it:** the `FIELD_SET_TRUNCATED` audit must sit on
top of the real XML parser. Wired to the naive walker it fires on every nested read, and a safety
net that cries wolf is a safety net someone switches off.

The kit had the same class of bug in miniature: `fieldAudit` returned `truncated: true` for an
**empty** result set. The first `gaps` run therefore reported customers as truncated when the
recorded fact was "this shop has zero customers". It now returns `truncated: null` with
`sampleAvailable: false`. Reported here rather than quietly fixed, because it is precisely the
error the adversarial review exists to catch.

## R19 — The review's zero-probe entities: probed, mostly EMPTY, bounds stated

Every operation below **succeeded**; the counts are facts about this demo shop, not about the
entities. Do not promote "no rows" to "no such feature".

**Bound, stated up front:** `gaps.json.sections.scale` records **18 products and 20 orders**.
Every per-product sweep below covered products 1–6 — **a third of the catalogue**. Nothing in
this round bounds behaviour at 10k products; R5's batch-loop architecture remains **unmeasured at
scale**, and that is the largest untested assumption in the whole design.

| Entity | Op | Result |
|---|---|---|
| customers | `User_SetFields`(56) + `User_GetAll` | ok, **0 customers** |
| customer groups | `User_GetGroupAll` | 4 — Kunder · **Brands / Producenter (`Producer: true`)** · Kun nyhedsbrev tilmeldte · **Kunder B2B-login** |
| newsletter | `User_GetAllNewsletter` | ok, 0 |
| price lines | `Product_GetDiscounts` ×6 | ok, **0 rows** |
| discount groups | `DiscountGroup_GetAll`, `DiscountGroupProduct_GetAll`, `Product_GetDiscountsAccumulativeAll` | ok, 0 / 0 / 0 |
| voucher discounts | `Discount_GetAll` | ok, 0 |
| reviews | `Product_GetTags` ×6 | ok, 0 — **trap: this is NOT a tag API** (see below) |
| product custom fields | `Product_GetCustomDataTypeAll` | ok, 0 types |

**Customers: the GDPR question is still open.** `Consent`, `ConsentDate` and `Newsletter` are
three distinct fields in the 56-field WSDL type, but their runtime semantics are **unverified**
because no record exists to read. Closing this needs a `User_CreateOrUpdate` write probe.
(The probe redacts personal-field *values* to `<type:length>` and records only shape — the shape
is the finding, the data is not ours to keep.)

**Price lines: the money-corruption hazard is NEITHER confirmed NOR cleared.** `ProductDiscount`
carries `UserType`/`UserId` (16 fields), and PLAN §3's "lowest wins" over an unfiltered set would
publish a B2B price — but this shop has no price lines at all, so there is nothing to scope.
**This remains the highest-risk open item and needs a `--write` probe that creates a
group-scoped price line and reads it back.**

**`Product_GetTags` is a naming trap with a PII edge.** Its type is `Id, LanguageISO, Title,
UserId, Username, UserEmail, Rating, Text, DateCreated` — **product reviews carrying a customer
email address**, not tags. An adapter that maps `Product_GetTags` onto Shopify product tags
because of the name would publish reviewer emails as tags. Treat the payload as personal data,
and keep PLAN §11's review question open on this **type** evidence (the zero row count says only
that this shop has no reviews).

**Voucher discounts are richer than PLAN assumed**: 24 fields including `FreeGift`,
`DiscountCustomerGroupAssociation`, `MinimumCartValue`, `IsSingleUsePerCustomer`,
`DeliveryMethodIds`, `IsRestrictedToNewCustomer`. Worth re-reading PLAN's discount mapping
against this list before P2.

**HTML entities: NOT REPRODUCED.** `Payment_GetAll` was called explicitly this time and returned
raw UTF-8 with **zero** entity-encoded sequences; 69 responses scanned across the probe,
`mixedEncodingResponses: []`. The review's `Kontooverf&oslash;rsel` sits in an older artifact
captured before the decode fix. Treat the hazard as **open but unreproduced** — keep the
per-field decode plan, and do not claim the issue is gone.

## R20 — Variants: real data, and a swatch problem for P2

Products 1–4 return variant rows; products 5–6 return none. **The two products actually sampled,
1 and 2, carry 3 variants each — Small / Medium / Large. Products 3–4 were counted, not
sampled** (`perProduct[].count` is `1` for each, which is the collapsed wrapper of R18, not a
variant count).

A variant carries `Price: 199`, `BuyingPrice: 79`–`299`, `Discount: 49`, `DiscountType: "a"`,
`Stock`, `MinAmount`, `Unit {Id, LanguageISO, Title}` and `StockLocations [{StockLocationId,
DeliveryTimeId, Stock, BuyPrice}]` — **a per-location buy price**, as R5 also saw.

Three variant types exist: **Farve, Størrelse, Skostørrelse**.
`Product_GetVariantTypeValuesByType(1)` returns Sort / Rød / Grå / Gul / Hvid, each with a
**`Color` hex value** (`000000`, `FF0000`, `A1A1A1`, `FFFF00`, `FFFFFF`) and a `Picture` slot.

**BOUND — the link P2 actually needs is UNREAD, and this is the important part.**
`audit.missing` includes **`VariantTypeValues`**: it was requested in the 26-field set and came
back collapsed (R18). And values were fetched for **type 1 (Farve) only** — yet the variants on
products 1–4 are **Størrelse**, whose values were never queried. **Nothing recorded links a
variant row to a (type, value) pair.** Shopify's option model requires exactly that link, so it
must be read — with the real parser — before P2 maps options. The swatch question below is real
but secondary to this.

**Design consequence:** Shopify option *values* carry no colour or swatch natively. The `Color`
hex and `Picture` per option value are either a documented loss or a metafield/metaobject
decision, and that decision belongs in P2 rather than being discovered during an import.

`DiscountType: "a"` is an undecoded vocabulary. **Do not let the money transform touch variant
discounts until the code letters are decoded** — this is the same shape of trap as F30's øre.

## R21 — the "read-only" probes were NOT read-only against the shop. 33 files generated.

Found by re-walking the archive to check my own cleanup claim, not by any probe asserting it.

The `ftp --write` STOR test cleaned up correctly (`DELE` → `250`, and the file is verifiably
gone). But the **read-only `imgurl` probe wrote 33 files into the shop's file archive**, simply by
fetching storefront pages. All timestamps fall inside the probe window, and the first FTP walk —
taken minutes earlier — recorded `/pics` with a link count of 2, i.e. **no subdirectories at all**:

| Path | Files | Timestamp | Cause |
|---|---|---|---|
| `/pics/_thumbs/` | 16 (8 sizes × `.png` + `.png.webp`) | 19:23 | fetching the `mywebshop.io` front page |
| `/pics/placeholders/` | 2 (hashed names) | 19:23 | same |
| `/shop/category/_thumbs/` | 14 (`category-1..4` at `w380.h380` and `w1200`, png + webp) | 19:23, 19:25 | front page, then the one-hop crawl into category pages |
| `/pics/slide.w200.h200.png` | 1 | 19:28 | third `imgurl` run |

These are the shop's own lazily-generated derivative cache — the same files any visitor's browser
would trigger. Nothing was destroyed and nothing needs deleting (they regenerate on demand, and
removing them would itself be a destructive write to the source). **But the label was wrong, and
three design consequences follow.**

**1. A DanDomain export CANNOT be described as read-only against the source.** Several planned
stages fetch storefront pages: URL-grammar discovery (F34), redirect validation (P3), and
`doctor`'s media-base check (R14). Each writes into the client's file archive. This is the
DanDomain analogue of invariant #1, and the honest handling is to **declare it in `doctor` and in
the PLAYBOOK's go-live section** — a client must not discover it. It is benign; being undeclared
would not be.

**2. An FTP-driven media export must NEVER walk the archive.** `/pics/_thumbs/slide.w1200.png`
sits beside `/pics/slide.png`; a naive "upload everything under `/pics`" would import **16 junk
media entries for one slide image**, and would do so with a clean-looking run. **Drive media
export from `Product_GetPictures.FileName` only, and skip `_thumbs/` and `placeholders/`
explicitly.** This is D15's lesson in a new costume: the import would report zero failures.

**3. `FileName` is AMBIGUOUS across directories — R12 needs this correction.** `/shop/` holds
`product-1.png … product-6.png` and `slide.png` at **byte sizes identical to `/pics/`**. So the
bare `product-5.png` that `Product_GetPictures` returns exists in two places. R14's resolved base
(`/upload_dir/pics/`) is the one that serves, but nothing in the API says which directory a
`FileName` belongs to. **Resolve via the verified URL base, never by searching the archive for a
matching name.**

Also now confirmed (R12 listed these as unwalked): **category media is `/shop/category/category-N.png`**
— previously "most likely, unconfirmed". `/shop/files/` is empty but is presumably where
`Product_CreateFile` digital downloads land. `/templates/template007_1/` holds the theme source
(`meta.json`, `source/settings/settings_values.json`).

**Method note.** This finding exists only because the cleanup claim was checked against the shop
instead of against the `DELE` reply code. The probe's own walk had been *early-exiting* the moment
it found its target filenames, so it had never once looked inside `/pics/_thumbs`. The walk now
drains its queue. **A probe that stops as soon as it confirms what it expected cannot report what
it did not expect.**

---

# P1-REDO — round 3 (2026-08-15). The four write-gaps closed. P1 is DONE.

Evidence: `data/probes/gapsw.json`, `scale.json`. New probes: `gapsw`, `scale` (both `--write`).

## R22 — PRICE LINES: the B2B hazard is CONFIRMED, with numbers. Highest-risk item, now closed.

The shop had zero price lines, so the scoping had to be **created** to be observed. One carrier
product, a swept `UserType` vocabulary, and one deliberately DEARER public row:

| `UserType` sent | Result |
|---|---|
| `all`, `group` | accepted |
| `""` (empty), `"0"` | **accepted — although neither is in the server's own list** |
| `1`, `2`, `3`, `usergroup`, `customer` | `ProductDiscount: UserType must be one of all, guest, user, group` |
| `user` | `PARAM: No such id: 4 for UserId` |

**The vocabulary is `all · guest · user · group`** — stated verbatim by the server, which is the
first documented-by-fault enumeration we have. Three things follow that the WSDL does not say:

1. **`""` and `"0"` are accepted anyway** and stored as sent, with `UserId: 4` intact. The
   validator has undocumented passthrough values, so a reader must treat any `UserType` outside
   the four as **UNKNOWN SCOPE**, never as public.
2. **`UserType` and `UserId` are validated as a pair.** `user` + `UserId 4` was rejected because
   4 is not a *user* id; `group` + `UserId 4` was accepted because 4 *is* a group ("Kunder
   B2B-login"). So `UserId` means a different table depending on `UserType`.
3. **`all` + `UserId 4` was ACCEPTED** — a globally-scoped row carrying a group id. Contradictory
   rows are storable, so neither field alone identifies the public price.

**The hazard, read back from the server:**

```
Id 1  Price 42  UserType ""      UserId 4     <- cheapest
Id 2  Price 42  UserType "0"     UserId 4
Id 3  Price 42  UserType "all"   UserId 4     <- 'all' scope, group id
Id 4  Price 42  UserType "group" UserId 4
Id 5  Price 90  UserType "all"   UserId 0     <- the only genuinely public row
```

PLAN §3's **"lowest wins" over the unfiltered set selects row 1 at 42 — a B2B price — instead of
the public 90.** Confirmed, not inferred. On a real shop that publishes trade pricing to the
public storefront.

**Transform rule (hard):** the public price is the cheapest row satisfying
`UserType === "all" && UserId === "0"`, and nothing else. Any row whose `UserType` is outside
`{all, guest, user, group}` raises a warning rather than joining either bucket. The field audit
on `ProductDiscount` came back **clean** (16/16 fields returned), so the data to apply this rule
is all present.

## R23 — CUSTOMERS: Consent is independent of Newsletter, and the User read is TRUNCATED

Three synthetic customers on `example.invalid` (RFC 2606 — cannot route to a person).

- **`Consent` is INDEPENDENT of `Newsletter`.** The `Consent: true / Newsletter: false` case
  round-tripped exactly, so they are two different facts and a migration must carry both.
  **`ConsentDate` round-trips** (`2024-03-01 12:00:00`).
- **`ConsentDate: ""` is REJECTED:** `PARAM: ConsentDate '' is not a valid datetime
  (yyyy-mm-dd hh:mm:ss)`. An importer must supply a valid datetime or **omit the field entirely**
  — an empty string fails the create. This killed the `Consent: false` case, so **the
  consent-withheld path is still unprobed** and is the one remaining customer question.
- `User_GetAllNewsletter` returned 1 of the 2 created — it genuinely filters on `Newsletter`.

**And the serious one: the User read is silently truncated, on the shipping address.** All 56
WSDL fields were requested; **19 `Shipping*` fields plus `Description` and `Site` never came
back**, with no error. A migration that trusts `User_SetFields` would import every customer
without a delivery address and report nothing wrong. This is R3 on a new entity with real blast
radius — and the exact reason `FIELD_SET_TRUNCATED` has to be mandatory rather than advisory.

## R24 — F35 is CLOSED END TO END. `dd-real` can seed products with images.

R13 closed only the FTP half. The full chain now runs:

`STOR /pics/probe-media-<ts>.png` (150/226) → `Product_CreatePicture{ProductId, FileName,
Sorting}` (ok) → `Product_GetPictures` lists it as `Id 17` → `GET
https://shop000000.sfstatic.io/upload_dir/pics/probe-media-<ts>.png` → **200 `image/png`, 84
bytes — exactly the bytes stored.**

So an FTP-placed file binds by `FileName` and is served publicly. F35's "no API channel for media
upload" remains true of SOAP alone and is no longer a limit on the seeder. Cleanup verified:
picture 17 deleted, FTP file deleted.

## R25 — The variant → option link, READ. R20's swatch worry narrows.

`Product_GetVariantTypeValues(VariantId)` resolves 6/6 variants:

| Variant | → value | Type |
|---|---|---|
| 4, 5, 28 (product 1) | Small, Medium, **Large (value id 8)** | 2 = Størrelse |
| 6, 7, 8 (product 2) | Small, Medium, Large | 2 = Størrelse |

Two facts the Shopify option mapping needs:
- **Value ids are GLOBAL per type, not per product** — products 1 and 2 share value ids 4/5/8.
  So `option = variant type`, `option value = the shared value row`, exactly Shopify's model.
- **Variant id ≠ value id** (variant 28 → value 8). Do not assume a positional mapping.

`Color` was empty on all six, because Størrelse is not a colour type — so **R20's swatch problem
is confined to Farve-like types**, not variants in general. `Product_GetVariantById` returned
only `{Id: "4"}`, i.e. the variant field set did not apply to it — recorded, not chased.

## R26 — SCALE: R5 CONFIRMED at 618 products. Plus a NEW truncation mode.

`Product_CreateOrUpdateBulk` seeded 300 products in 6 calls of 50 (~160–490 ms each). The
catalogue is now **618 products** (18 original + 600 scratch, from two runs — the first used a
timestamped tag before the probe was made idempotent; the tag is now the stable `SCALE-PROBE`).

Fully-inlined nested read (`Variants,Pictures,CustomData,Discounts,Tags,SecondaryCategories,
StockLocations,VariantTypes`):

| Page size | Products returned | ms | ms/product | bytes/product |
|---|---|---|---|---|
| 50 | 50 | 151 | 3.02 | 556 |
| 100 | 100 | 212 | 2.12 | 520 |
| 250 | 250 | 387 | 1.55 | 500 |
| 500 | 500 | 708 | 1.42 | 490 |
| 1000 | **618 (whole catalogue)** | 745 | **1.21** | 488 |

**R5's paged-batch architecture holds beyond a toy catalogue.** Page sizes are honoured exactly
up to the catalogue size; no server cap appeared up to 1000. Extrapolated to 10k products that is
**~10 calls and ~12s of read time, against the ~110,000 calls the pre-R5 N+1 design implied.**

**Caveat, and it is a big one:** these products are near-empty. 488 bytes/product will be several
times larger on a real catalogue with long descriptions, variants and image rows, and the
extrapolation is linear. This bounds the **architecture**, not the wall-clock of a real migration.

**NEW FINDING — fields can be omitted PER RECORD, so R3's rule is insufficient.** The probe
counted three product-only markers to cross-check itself, and they disagreed:

```
VatGroupId: 618   Online: 618   SeoLink: 8
```

`SeoLink` was requested in the field set and returned on **8 of 618 records** — silently absent
from the other 610, presumably because it is empty. **R3 said to diff requested-vs-returned on
the first record of each batch. That is not enough**: record 1 here is a demo product that *has*
a SeoLink, so the batch check passes while 610 records quietly lack the column.

**Client rule (supersedes R3's wording):** treat a missing key as *absent-value*, not as
*missing-column*, and decide truncation by scanning the whole batch — a field returned on **zero**
records is a truncated column; a field returned on **some** is an empty value. Never conclude
"the column arrived" from record 1.

The probe also re-confirmed R6/R18 the hard way: the naive parser reported **one** record for
every page, so all counts above are taken from the response bytes. And a first attempt counted
`<item>` — which inflated 618 products to 1260, because nested `Variants`/`Pictures`/
`StockLocations` rows are `<item>` too. Both errors are recorded rather than quietly fixed.

## R27 — R17, third instance: `Product_DeleteAllDiscounts` takes `ProductItemNumber`

Cleanup faulted with the now-familiar arity error because the argument was guessed as
`ProductId`. The WSDL says **`ProductItemNumber` (`xsd:string`)** — the item number, not the id.
Three ops have now been caught this way (`Order_GetAllWithPagination`, `PageText_GetByIds`,
`Product_DeleteAllDiscounts`). **Generate `operations.js` argument names from the WSDL in P1b;
do not hand-write a single one.** (The orphaned rows were removed anyway — the carrier product
was deleted, which takes its discounts with it.)

---

# ADVERSARIAL REVIEW OF ROUND 3 + P1-REDO round 4 (2026-08-15). Read this before R22–R27.

Round 3 was written up and **declared P1 complete without the phase-gate review this project
requires**. The review then found four blockers. This section records them and the probe (`close`,
`data/probes/close.json`) that settled them. **R28–R31 supersede the R22–R27 statements they name.**

## R28 — **R23 WAS WRONG. The User read is NOT truncated.** My error, by my own forbidden method.

R23 claimed "the User read is silently truncated, on the shipping address — 19 `Shipping*` fields
never came back." That was **circular**: the create in `gapsw` never *sent* a single `Shipping*`
field, so their absence was exactly what R26 says to expect from an empty value. R23 reached its
conclusion with the record-1 method that **R26, seventy lines later, explicitly forbids.**

Re-probed with every field **populated** (`close.json.sections.userTruncation`):

```
returned: 56 of 56 fields    missing: []    truncated: false
ShippingFirstname · ShippingLastname · ShippingCompany · ShippingAddress · ShippingZip ·
ShippingCity · ShippingCountryCode · ShippingPhone · ShippingEmail · ShippingReferenceNumber ·
Description · Site   -> 12/12 present, all non-empty
```

**`User` round-trips all 56 fields.** There is no dropped column and `FIELD_SET_TRUNCATED` is not
implicated here. The count in R23 was also wrong: 19 was the *total* missing — **17** `Shipping*`
plus `Description` and `Site`.

The correct general statement is R26's, and this is the cleanest demonstration of it: **a missing
key means the value was empty, unless the field is missing across the entire batch.**

## R29 — **`guest` exists, and R22's public-price rule would have silently dropped it.**

R22 swept ten `UserType` values and **not `guest`** — despite quoting the server's own enumeration
`all · guest · user · group`. Its rule (`UserType==="all" && UserId==="0"`) gives `guest` no
branch: inside the vocabulary so it never warns, not `all`/`0` so it never counts. Silent drop.

Recorded (`close.json.sections.guestScope`):

```
guest + UserId 0  @55  -> accepted, read back UserType "guest"
guest + UserId 4  @56  -> accepted, read back UserType "guest"   (contradictory, and storable)
UserType OMITTED  @77  -> accepted, read back UserType "all"
```

**Two facts R22 missed:**
1. **An omitted `UserType` is stored as `"all"`.** So `all` is the server's *default*, not a
   positive marker of public scope — R22's public row was never explicitly marked public.
2. **`guest` rows are real and readable**, and `guest` is the likeliest name for the
   anonymous-shopper price. `all` and `guest` are both plausibly "public".

**Revised rule (supersedes R22's "hard" rule, and is still not confirmed against the storefront):**

> Public price = cheapest row with `UserId === "0"` **and** `UserType ∈ {"all", "guest", ""}`.
> A `guest` row must be **considered**, never dropped. Rows with `UserType ∈ {"user", "group"}`
> or any `UserId !== "0"` are scoped and must not set the public price. Any other `UserType`
> **warns**. Rows whose `DiscountType` is not `"b"` **warn** until the `a`/`b` vocabulary is
> decoded. If no row qualifies, fall back to `Product.Price` and warn.
> **Confirm by reading one product's price from the anonymous storefront before this ships.**

**And R22's demonstration was constructed, not discovered.** The probe hardcoded every scoped row
at 42 and the public row at 90; `min(42,42,42,42,90) = 42` is arithmetic on its own inputs, and
this shop has **zero real price lines**. What R22 genuinely established — and it is the
load-bearing part — is that the rows are **distinguishable**: `UserType` and `UserId` both survive
the round-trip with a clean 16/16 audit. The hazard is real because trade prices are normally
below public, but **no real B2B price line has been observed on this shop.** "Confirmed, not
inferred" was too strong; the *fix* is proven possible, the *bug* is not proven to fire here.

## R30 — `Product_DeleteAllDiscounts` works, and cleanup is now verified by RE-QUERY

R27 guessed `ProductId` and got the arity error; it then hand-waved that deleting the product
"takes its discounts with it" — never re-queried, and product 19 was by then unqueryable. With the
right argument: `Product_DeleteAllDiscounts{ProductItemNumber: "<item number>"}` → **3 rows before,
0 after a re-query.** Verified against the shop, not against a reply code.

**Standing correction to earlier cleanup claims:** the five price-line rows created on product 19
in round 3 were **never deleted and never re-queried**. They are presumed gone with the product;
that presumption is still untested and always was.

## R31 — Option-value ORDER, and the join R25 omitted

R25 named `Product_GetVariantTypeValues(VariantId)` as "the op the Shopify option mapping must
use". It returns only `{Id, Title, ProductVariantTypeId, Color}` — **no `Sorting`, no `Picture`,
no `LanguageISO`** — so on its own it cannot order Shopify option values.

The global list carries them (`close.json.sections.optionValueOrder`):

| Type | Values (Id · Title · Sorting) |
|---|---|
| 1 Farve | 1 Sort 1 · 2 Rød 2 · 3 Grå 3 · 6 Gul 4 · 7 Hvid 5 — each with a `Color` hex |
| 2 Størrelse | **4 Small 1 · 5 Medium 2 · 8 Large 3** |
| 3 Skostørrelse | 9 “38” 1 · 10 “39” 2 · 11 “40” 3 · 12 “41” 4 |

**Mapping rule:** link the variant with `Product_GetVariantTypeValues(VariantId)`, then **JOIN to
`Product_GetVariantTypeValuesByType(TypeId)`** for `Sorting`, `Picture` and `Color`. Neither op
alone is sufficient. Størrelse values sort 1/2/3 as Small/Medium/Large — an alphabetical fallback
would have produced Large/Medium/Small.

## R32 — the media path oracle round 3 ran and never wrote up

`gapsw.json.sections.thumbPathOracle` was executed and omitted from R22–R27 entirely.
`Solution_CreateThumb` answers where an image lives — **and fails silently when it does not**:

| `ImagePath` | Returned |
|---|---|
| `pics/product-1.png` | **`/upload_dir/pics/product-1.w60.h60.png`** ✅ |
| `/pics/product-1.png` | `/upload_dir//pics/…` — malformed double slash |
| `product-1.png`, `upload_dir/pics/product-1.png` | **`/_design/common/img/blank.gif`** with `ok: true` |

**This independently confirms R14's derived base from the server's own mouth** — `/upload_dir/pics/`
— and supplies `doctor` a cheap verification that needs no markup scraping. **Treat a `blank.gif`
return as a hard failure, not a miss**: it arrives with no fault, so a wrong prefix would otherwise
look like success.

## R33 — corrections to R26's scale numbers

- **Page size 1000 was never shown to be honoured.** It returned 618 — the whole catalogue — so no
  cap could be observed. The largest page size proven honoured below catalogue size is **500**. On
  that basis a 10k catalogue is **~20 calls**, not 10. No ceiling has been located.
- **The timings are single noisy samples.** `probe-log.jsonl` records the *identical* 301,592-byte
  read at **397 ms, 908 ms and 745 ms** across three runs — a >2× spread. Read it as
  **~1.2–1.5 ms/product, ~12–15 s per 10k**, not 1.21 and 12.
- **Three counting methods are in the log, not two.** Run 1 trusted the parser (`catalogueSize: 1`,
  projecting *1420 s over 200 calls* — 118× wrong), run 2 counted `<item>` (1260), run 3 counted
  product-only markers (618, correct).
- R26 asserted "record 1 here is a demo product that *has* a SeoLink". **Record identity is not
  recorded anywhere.** The per-record-omission rule survives regardless — 8 is neither 0 nor 618 —
  but the illustration is unsupported: either way, record 1 cannot decide it.
- The 618 count itself is **solid**: `VatGroupId` and `Online` agree exactly at 50/100/250/500/618,
  and 618 = 18 + 300 + 300 across the two tagged runs.

## Method note — what this round cost, and why the rule exists

Round 3 produced five genuine findings and **three claims that did not survive contact with a
hostile reader**: a truncation that was my own circular construction (R23/R28), a rule with a
silent hole (R22/R29), and two "verified" cleanups that were never re-queried (R27/R30). Plus one
whole recorded section left unwritten (R32).

Every one was catchable from the artifacts alone. The phase-gate review is not ceremony — it has
now changed material claims in **all three** rounds it has been run on, and the one round that
skipped it is the round that shipped a wrong rule into the client's requirements table.

---

# ROUND 4 — the SOAP page base, closed before P2 (2026-08-16)

One question, asked because H3 made `client.js` refuse to page without an explicit base, which
gated P2's whole read path. It produced two findings, one of which is not about paging at all.

## R34 — **THE PAGE BASE IS 1.** Settles H3. `data/probes/pagebase.json`

Two methods that can fail independently, and neither is the client's own detector — testing
`detectPageBase` with `detectPageBase` would have proved nothing.

**1. A walk checked against an INDEPENDENT truth set.** `Order_GetByDate` with `Status` omitted
(R16) returned all 20 orders. Walking `Order_GetAllWithPagination` at `PageSize: 5`:

| walk from | pages | collected | unique | duplicates | missing | extra | reproduces truth |
|---|---|---|---|---|---|---|---|
| 0 | `Page=0` faulted immediately | 0 | 0 | 0 | 20 | 0 | no |
| 1 | 5, 5, 5, 5, 0 | 20 | 20 | 0 | 0 | 0 | **yes** |

The decision is a set comparison against a *different operation*, not a reply code.

**2. The server said so, four times.** `Page=0` is refused with
`PARAM: SoapFault PARAM: Page must be greater than 0` on `Order_GetAllWithPagination`,
`Order_GetByDateWithPagination`, `Order_GetByDateUpdatedWithPagination` and
`Order_GetByStatusWithPagination` — four entry points into one validator in `service.php`. That is
a platform property, not one operation's quirk.

**What is NOT proved, and is recorded as such:**

- **One shop** (shop000000). No second shop has been asked.
- `Product_GetDiscountsAccumulativeAllWithPagination` is **SILENT, not agreeing** — both candidate
  first pages returned zero rows because the shop has no accumulative discounts. An empty result
  set cannot tell a 0-based server from a 1-based one, so it is listed as silent and kept out of
  the agreement count. 4 of 5 answered; the verdict says 4, not 5.

**What shipped.** `SOAP_PAGE_BASE` is now `{ verified: true, value: 1 }` and carries `scope`
(shops, agreed, silent) and `openQuestion` so the claim cannot read wider than the evidence.
`readAll(op, { pageSize })` works again. The safety valves stay:

| route | precedence | evidence `source` |
|---|---|---|
| `{ pageBase: 0 \| 1 }` on the call | wins | `caller` |
| `{ pageBase: "detect" }` | asks the server, 1–2 requests | `detect`, `verifiedAgainstThisShop: true` |
| `createClient({ defaultPageBase })` | per client | `client-default` |
| nothing | the recorded value | `recorded-default`, `verifiedAgainstThisShop: **false**` |
| `createClient({ defaultPageBase: null })` | restores H3's refusal | throws, sends nothing |

The residual risk is **pinned by a test that asserts the loss happens**: against a 0-based double,
the default reads 15 of 25 records and still reports `complete: true`. That test exists so nobody
can later describe the default as safe in general. `defaultPageBase: null` is the supported way to
onboard a shop that has not proved its own base.

**A note on the earlier spot-check.** The first run of this probe settled one operation and then
"confirmed" a second by sending it `Page: 1` and observing rows. That check could not have failed —
a 0-based server answers `Page=1` with its second page, rows and all — so it proved nothing. It was
the same shape as R22's constructed demonstration and R30's reply-code cleanup: a proxy standing in
for the thing. The sweep replaced it with the same two-observation table applied to every operation
the WSDL declares.

## R35 — **`nillable` is NOT `omissible`.** A new class of arity fault. Found by R34's sweep

`Status` is `nillable="true"` on the three `*WithPagination` operations that declare it, and
`validateArgs` therefore lets it be absent. The server does not:

```
Too few arguments to function WebService::Order_GetByStatusWithPagination(),
2 passed in /code/smartweb/latest/api/service.php on line 108 and exactly 3 expected
```

3 of 3 operations, both page numbers. **The WSDL's `nillable` describes the VALUE (it may be null),
not the presence — PHP counts POSITIONS.**

And it is **per-operation, not derivable from the schema**: omitting `Status` on `Order_GetByDate`
*works* (R16 — that is exactly how R34's truth set was built). So `validateArgs` stays permissive;
what changed is the **diagnosis**. `classifyFault` says "an ARGUMENT NAME was wrong", which for
this cause sends a reader hunting for a misspelling that is not there. An `ARITY` fault on a call
that omitted nillable arguments now carries `.omittedNillableArgs` and `.omittedNillableWhy`.

This is R17/R27's third mechanism: the same PHP message, now from a *legal* call.

**Consequence for P2:** send `Status` explicitly on every `*WithPagination` order read. It is not
optional there whatever the WSDL says.

## Method note — round 4

The round's own first draft carried the weak spot-check described in R34, and a verdict that read
clean over 12 recorded faults. Both were caught before a human saw them: the first by asking "could
this observation have come out the other way?", the second by `scripts/probe-selfcheck.mjs`, whose
rule is that a probe recording faults must name them in its verdict. The faults here *are* the
evidence — 6 are the server rejecting `Page=0`, 6 are R35 — and a verdict that omitted them would
have hidden a whole finding.

The decision table itself (`classifyPageProbes`) is exported and has **13 offline assertions**,
including the four rows that must refuse to decide. Live output cannot check a decision table: a
mis-ordered branch returns a confident base that looks exactly like a correct one.

**And the checker had the same disease.** `probe-selfcheck.mjs`'s "faults recorded under a clean
verdict" rule listed `NOT ` among the words that count as discussing a fault. Case-insensitively
that matches the word *not* in any sentence, so pagebase.json's original verdict — "decided ... by
a set comparison, **not** by a reply code" — passed while naming none of its 12 faults. Tightened
to words that only appear when faults are being discussed. The tightening immediately surfaced a
second artifact (`nested.json`, 3 NOSUCHPARAM faults) whose verdict is silent about them — those
three are written up at PLAYBOOK:709, so nothing was lost there, but the rule had been reporting a
clean bill of health it had not earned. A net that matches ordinary prose is worse than no net.

---

# ROUND 5 — the P2 cheap wins, the storefront, and F34's death (2026-08-16)

Four questions the P2 start prompt listed as "cheap wins, currently open and
non-blocking", run as `probe p2`, then `p2b`, then `p2c`. Evidence:
`data/probes/p2.json`, `p2b.json`, `p2c.json`.

**This round's own first write-up did not survive its adversarial review**, and
the corrections are folded in below rather than appended: R39 originally kept
half of F34's table, and R40 originally blamed a cause that R39 had just
disproved. The reviewer's decisive move was to re-read `imgurl.json` — a
round-2 artifact — which had contained the answer to both since 2026-08-15.
R41 and R42 are what asking the question on the right host produced.

## R36 — `folders`: 4 folders, max id 8. And the GraphQL list is NOT the whole sweep.

The first attempt sent the documented Convention-A shape and the server rejected
all three parts of it at once (`p2.json.sections.pageFolderBound.raw`):

```
Field "pagination" is not defined by type FoldersInput.
Cannot query field "data" on type "Folder".
Cannot query field "pagination" on type "Folder".
```

That is the server stating its own schema — the R22 method — so `p2b` re-derived
the query from the fault instead of guessing again, and introspected `Folder`
first rather than assuming its fields:

| | |
|---|---|
| `__type(name:"Folder").fields` | `id · sorting · languageLayerAccess · menuDisplaySettings · isLeaf · translations` |
| working query | `{ folders(input: {}) { content { id } errors { __typename } } }` |
| result | **4 folders: ids 1, 3, 6, 8** |

Three consequences:

1. **`folders` is Convention A with a NON-paginated `content`**, like `pages` —
   `content` IS the row list. `graphql.js` shipped it as
   `rowsPath ["content","data"]` + `contentPaginated: true` with
   `rowsPathVerified: false`, i.e. the generated snapshot flagged itself as a
   guess and the guess was wrong. Corrected through a new `LIVE_CORRECTIONS` map
   layered over the generated block, so regenerating from `gqlshapes.json` cannot
   silently revert it and "what introspection said" stays distinguishable from
   "what the server does".
2. **`Folder` carries no `name` or `title`** — that is what the introspection
   lists. (Nothing ever asked for one, so "a selection asking for a name would
   fault" is R4's rule extended to this transport, not an observation.)
3. **THE IMPORTANT ONE: the GraphQL list does not include folder 0, and folder 0
   holds a page.** `gaps.json.sections.pages.byFolder` records folder 0 with
   count 1. The likeliest reading is that 0 means "no folder" and only the SOAP
   side calls it a folder id. **Driving `PageText_GetByFolder` from the GraphQL
   list alone would silently drop that page**, so the adapter sweeps the GraphQL
   ids UNIONED with 0. A live answer that is *narrower* than the recorded sweep
   is exactly the shape of thing that looks like an upgrade and is a data loss.

## R37 — `DiscountType` is NOT validated, and it appears to store only the FIRST CHARACTER

The R22 method — send an invalid value, read the enumeration out of the fault —
does not work here, because there is no fault. Nine values were sent and **all
nine were accepted**, including `""` and `"zzz-not-a-type"`.

**What is RECORDED:** nine sends, and a read-back whose distinct `DiscountType`
values are `{ "", "%", "a", "b", "c", "p", "z" }` — seven distinct values from
nine sends of `a · b · c · p · % · amount · percent · zzz-not-a-type · ""`.

**What is INFERRED,** and labelled so because the probe did not record the
pairing (`p2.json.sections.discountType.storedAs` carries a `sentOrder: null`
field that was never populated, so the sent→stored link is reconstructed from an
assumed row order): that `amount`→`a`, `percent`→`p` and `zzz-not-a-type`→`z`,
i.e. **the column holds one character and truncates silently.** The distinct set
alone is enough for the load-bearing half — `z` and `%` are stored, and neither
is in any plausible vocabulary, so the field is unvalidated — and it makes the
one-character reading the only simple explanation for a `z`.

Either way the practical conclusion is the same and it is a negative one: **the
`a`/`b` meaning cannot be decoded from this API.** There is no enumeration to
provoke, and a writer that sends a word stores its initial with no error. To
close it properly, send ONE value per carrier product so the pairing is recorded
rather than assumed, or read the meaning off the admin.

Consequence for the money transform: a price line whose `DiscountType` is not
`"b"` still warns, and the warning is now known to be un-closeable by probing the
API alone.

## R38 — `Consent: false` round-trips when `ConsentDate` is OMITTED

R23 established that `ConsentDate: ""` is rejected (`PARAM: ConsentDate '' is not
a valid datetime`), which killed the `Consent: false` case that round. Omitting
the field entirely works:

```
create ok, no fault
read back: Consent "false" · Newsletter "false" · ConsentDate "0000-00-00 00:00:00"
```

Note the read-back: `ConsentDate` comes back as the **zero-date**, not absent —
so a consumer must treat `0000-00-00 00:00:00` as null (F19/F32) on this field
too. Cleanup verified by re-query (0 rows left).

**Bound, and it is the same bound R22 has:** this shop has **zero real
customers**. Every customer observation in this project — R28's 56-field
round-trip and R38's consent record alike — is a row the probe created on
`example.invalid`. The API's *behaviour* is what has been established; nothing
has been read off a customer a merchant entered.

## R39 — **F34 IS INVALIDATED, IN BOTH DIRECTIONS. `/heimdal/...` is the ADMIN app.**

F34 probed five candidate URL shapes and concluded that this shop serves
`/{theme}/products/{id}` because `/heimdal/products/15` returned **200**.

`p2b` fetched that URL and read the BODY rather than the status:

```
<title>...</title>
<meta name="robots" content="noindex, nofollow, nosnippet, noarchive"/>
<meta name="description" content="Manage your online store"/>
/heimdal/96962d7c/static/js/main.131b7558.js
```

That is DanDomain's **admin** single-page application, and it answers every path
under `/heimdal/` with the same 7,460 bytes:

| URL | Status | Bytes |
|---|---|---|
| `/heimdal/products/623` | 200 | 7460 |
| `/heimdal/products/623?format=json` | 200 | 7460 |
| `/heimdal/api/products/623` | 200 | **7460 — a path nobody claims exists** |
| (round 2, `imgurl.json`) `/heimdal/products/1`, `/2`, `/3` | 200 | 7460 each |

Six recorded paths, one byte count. **A catch-all route cannot distinguish a real
product URL from an invented one**, so F34's 200 is not evidence of a grammar.

**And the four 404s die with it.** The first draft of this section kept them "as
valid negatives"; an adversarial review pointed out that `probe-dandomain.mjs`
fetches all five F34 candidates against ONE base, and that base is
`{tenant}.webshop.dandomain.dk` — which `imgurl.json` recorded as **24,367 bytes
of DanDomain login banners redirecting to `?recover`**, i.e. the admin login.
Every row of F34's table was fetched against the admin host. The table is void in
both directions.

**Consequences:**

- **A 200 is not evidence on this platform.** Any URL discovery here must confirm
  the response CONTAINS the thing — its item number, its title — not that it
  answered. That rule is what R41 was then built on.
- F7 already established that `Product.Url` reads back empty, so the API does not
  state the URL either.
- R14's media base is unaffected: it was verified by matching byte counts against
  FTP, never by a 200.

## R40 — R29 is unconfirmable through the ADMIN host (and that was the wrong host)

Recorded honestly because the first two attempts failed, and because the reason
they failed was not the reason first written down.

Method: one carrier product at `Price 3771`, with two public-eligible price lines
— `all`/`UserId 0` at **2221** and `guest`/`UserId 0` at **1117**. Three mutually
distinct numbers, so whichever appears in an anonymous response IS the answer.

Twelve anonymous fetches across `p2` and `p2b` contained none of them. The first
write-up concluded "the storefront renders prices in the browser". **That was
wrong, twice over:** every one of those fetches went to
`{tenant}.webshop.dandomain.dk`, which R39 had just shown to be the admin app;
and the probe's verdict string was hardcoded to say "renders in the browser"
whenever no price was found, for any reason — a conclusion that could not come
out the other way.

What R40 actually establishes is narrower and still worth keeping: **an
`all`/UserId 0 row and a `guest`/UserId 0 row can coexist on one product and both
read back intact**, so R29's rule has something real to choose between. The
choosing was settled by R42, on the right host.

## R41 — **THE STOREFRONT, AND ITS URL GRAMMAR.** `data/probes/p2c.json`

**Which host is the shop** (`p2c.json.sections.hosts`, re-asked live; `imgurl.json`
had recorded the same distinction in round 2 and nobody read it that way):

| host | bytes | markers | what it is |
|---|---|---|---|
| `{tenant}.webshop.dandomain.dk` | 24,367 | `recover` present | **ADMIN** — DanDomain login, redirects to `?recover` |
| `{tenant}.mywebshop.io` | 158,991 | none | **STOREFRONT** — server-rendered, ISO-8859-1, 19 images |

**The URL grammar** (`p2c.json.sections.storefront`): a product created with a
**digit-free** slug and item number, in a known category.

| URL | Status | Contains the product? |
|---|---|---|
| `{shop}/shop/9-probe-kategori/` | 200 | no (category listing) |
| **`{shop}/shop/9-probe-kategori/625-probe-storefront-msvspfjo/`** | **200** | **YES — item number, slug and id all present** |
| `{shop}/shop/625-probe-storefront-msvspfjo/` | 404 | no |
| `{shop}/625-probe-storefront-msvspfjo` | 404 | no |

**The grammar is `https://{tenant}.mywebshop.io/shop/{catId}-{catSlug}/{prodId}-{prodSlug}/`,
and categories serve at `/shop/{catId}-{catSlug}/`.** Which is, note, close to the
grammar the research phase documented from a different shop and F34 declared
wrong — F34 was testing it against the admin host.

Two details P3 needs:

- **The category slug is derived from the TITLE when `SeoLink` is empty.**
  Category 9's `SeoLink` is `null` (`urls.json`) and it serves at
  `9-probe-kategori`. So a redirect map cannot read the slug off `SeoLink` alone.
- **A 200 is still not enough** (R39). The accepted URL is the one whose response
  CONTAINED the item number; the two 404s echo the requested slug back in their
  own bodies, so even "the page mentions the slug" is not containment.

**Bound: one shop, one theme.** `doctor` must repeat this containment check per
shop before P3 generates a redirect map from it.

**One recorded fault, and it is an answer rather than noise.** `p2c.json.faults`
holds `Category_SetFields -> ProcedureNotPresent: Procedure not present` — a
leftover no-op call in the probe. The operation genuinely does not exist, which
independently confirms what the WSDL says and what the adapter already does:
`Category` and `Discount` have no `*_SetFields`, so they are read on the server's
default projection and there is nothing to negotiate. The dead call is removed
from the probe; the fault stays in the artifact as the record.

## R42 — **R29 IS CONFIRMED, AND `guest` WINS.** Not "is included" — wins.

Same run, same product. The product page — the 200 that contains the item
number — contains **`1.117,00`** and neither `2.221,00` nor `3.771,00`.

```
needleCollisions: { listFmt:false, allFmt:false, guestFmt:false,
                    list:false, all:false, guest:false }   -> needlesAreClean: true
product page found: { guestFmt: true, allFmt: false, listFmt: false, itemNumber: true }
```

**The rule (supersedes R22 and R29's "cheapest of {all, guest, ''}"):**

> The public price is the cheapest row with `UserId === "0"` and
> `UserType === "guest"`. Only when no such row exists does the cheapest
> `{all, ""}`/`UserId 0` row apply, and only then does `Product.Price`.
> A `guest` row wins **whether or not it is the cheaper one** — "cheapest of the
> public rows" gives the same answer here only by accident, and the opposite
> answer on any shop whose guest price is the higher of the two.

**The false positive this nearly shipped, recorded because it is the whole
method.** The first `p2c` run put a millisecond timestamp in the product's slug —
`probe-storefront-1786884111771` — and reported **GUEST**. The string
`1786884111771` CONTAINS `1117`. The hit was the probe's own URL, echoed back by
the page. It was caught by noticing that the two 404 pages ALSO reported a guest
hit, which no price could explain. Three changes make the second run evidence:

1. **Digit-free identifiers.** The slug and item number carry no numerals, so a
   numeric hit cannot come from them.
2. **The FORMATTED needle.** The shop renders DKK as `1.117,00`
   (`profile.json.currencyFormat`), and the formatted form cannot occur by
   accident; the raw number is recorded alongside but does not decide.
3. **An explicit collision self-check**, computed BEFORE any result is read:
   `needleCollisions` tests every price needle against the probe's own
   identifiers, and the verdict REFUSES to decide unless all six are false.

This is the fourth time in this project a check has been caught proving nothing —
R22's constructed demonstration, R30's reply-code cleanup, R34's first
spot-check, and now this one. The question that catches all four is the same:
**could this observation have come out the other way?**

## Method note — round 5

Three of the four "cheap wins" were designed so a negative result is itself a
finding, and three returned one. The two that went furthest went differently:

- **`folders` failed on a guessed query shape, the server's error named the
  schema, and re-deriving from the error produced both the answer and a
  correction to `graphql.js`.** The same move as R22's `UserType` vocabulary.
- **R41 and R42 exist because an adversarial reviewer re-read a round-2
  artifact.** `imgurl.json` had held the storefront/admin distinction, and the
  `/shop/{catId}-{catSlug}/` 200s, since the day it was written. Two rounds of
  probing had walked past it, and one round of write-up had built a conclusion on
  top of it pointing the wrong way. **The cheapest evidence in this project is
  the evidence already on disk**, and it is the evidence nobody re-reads.

R39 in turn exists only because a probe recorded a response BODY it was not asked
to analyse — it was collecting markup so the next round would know what the theme
fetched. **A probe that records what it saw, rather than only what it was asked,
is where the unasked question gets answered.**

## Method note — P2 review round 3

Round 3 reviewed round 2's fixes, on the rule round 2 itself established. It
found more, and the two worst were both money defects that had been read past
twice. Neither was found by reading them a third time.

**They were found by writing the test for a surviving mutant.** A mutation pass
had left ten mutants alive on `src/sources/dandomain.js`. A live mutant says
something precise: *no assertion in this suite can tell this line from its
opposite.* Sitting down to build an input that WOULD tell them apart is a
different act from re-reading the line, because it forces the behaviour to be
stated as a number before the code is consulted — and twice the number the code
produced was not the number the comment on that same line promised:

- `applyPublic` returned the price LINE for every caller when `Product.Price`
  was empty, 0 or negative. The comment directly above it described keeping each
  variant's own price and named the exact loss — "a 300 DKK variant sold at 55".
  The code had never done that. The comment had been right since round 2 and
  nobody had compared the two.
- The variant branch used `publicPrice(...).rows > 0` as the test for "this
  variant has a price line of its own". `publicPrice` FALLS BACK to the
  product-level rows when a variant has none, so that count is above zero either
  way. A variant priced 400 with its own 120 line came out at
  400 × (120/199) = **241.21** — neither the line, nor its own price, nor the
  product's.

**A surviving mutant is not only an untested line. It is a line whose behaviour
nobody has ever had to state out loud** — and in a file where the comments carry
the findings, a line nobody has stated is a line where the comment and the code
can disagree indefinitely.

Killing them is also a claim that has to be measured. Each of the ten mutations
was re-applied to the shipping file and the suite re-run: every one went red, in
the test named for it. Six more were then applied to round 3's OWN fixes,
including one reverting `variantScoped` to `rows`; all six died too. Writing a
test called "M3" and not re-running the mutant would have been the same species
of unearned green this playbook has now recorded five times.

Two smaller findings from the same round are worth keeping for their shape:

- **A test can pin a claim the project has already disproved.** `publicPrice`
  still returned `confirmed: false` two rounds after R42 confirmed the rule
  against the storefront — and an assertion held it there, named "the rule
  reports itself as UNCONFIRMED". It was correct on the day it was written.
  Nothing re-reads a green assertion.
- **A header can assert an invariant that is false.** `util/entities.js` claimed
  to be a strict SUPERSET of `transform/html.js#decodeEntities`, with a test that
  only checked the agreeing direction. `&amp;lt;` is six characters meaning the
  literal text `&lt;`; the narrow decoder resolves `&amp;` first and invents a
  `<`. The wide one is right, the CLAIM was wrong, and the test could not see it
  because it only tried inputs where the two agree. Testing only the happy
  direction of an invariant is how a false invariant survives review.

## P2 leftover close — live currency list (2026-08-17)

Read-only `dandomain_probe` `smoke` this session re-recorded `Currency_GetAll`.
**What is RECORDED:** one row. Iso `DKK`. Rate (`Currency`) `"1"`. Keys
`Id, Iso, Symbol, SymbolPlace, Currency, Decimal, DecimalCount, Point, Round,
RoundOn, Title`. No `Primary`. SOAP `Sites_GetAll` still has no Valuta.
GraphQL schema census lists `currencies`, `currencyById`, `currencyCodes`
(`gqlshapes.json`; `src/dandomain/graphql.js` registry flags
`payloadTypeIntrospected: false`). gqldeep's `{currencies{data{__typename}}}`
burst is a rate-limit ping, not a shop-default field.

A 1-row shop cannot settle which field means default. Live default-currency
field on shop000000 = **silent / inconclusive**. N-row unit tests in
`test/source-dandomain.test.mjs` remain the multi-row evidence. No second
currency was created on this shop.

# P5 — live matrix recorded (2026-08-17). Later section; STATUS is the tracker.

Clean-target rehearsal: shop000000 → `example-store` (partner development).
Wipe Shopify only (job `3a29ac0f-…`, exit 0). Seed `dd-real` additive. **CLI
only** after MCP `migration_export` failed in 0.03s (`removeFile` missing —
stale ESM). Do not wipe again. Do not mark P5 complete.

**Recorded exits:** doctor **3** (R39 404 on
`/shop/9-probe-kategori/10-probe-url-renamed/` item `PROBE-URL-A`; does not
block export). export **0** (24.4s): 623 products, 8 categories, 2 customers,
22 orders, 7 pages. transform **0**: 623/8/2/22/7/11, 949 warnings, 944 action.
import products+collections **4** then **0** (274 `HANDLE_NOT_UNIQUE`). import
rest **4** (orders 13 imported / 9 empty-line failed: #DD1–8 + #DD21). verify
**5**. idempotent import **4**: 0 new rows; Shopify 349 products, 6 customers,
13 orders, 8 collections. Zero duplicates.

**D15:** `dd-id-1/4/6` DRAFT 199/599/899, `compareAtPrice` null. `PROBE-VAT-25`
100.00. `DDSEED-P-SIMPLE` 125.00. `#DD9` 125 = 100 NET + 25 taxLines (O13).
`#DD22` qty 2 × unit 100 = 200. Redirects are `/shop/…` on
`{tenant}.mywebshop.io` grammar. No transformed `"price":"0.00"`.

**O-items this pass:** O2 CLOSE (order 25 Total 75 POST-discount). O4 CLOSE
(`ORDER_LINE_PRICE_BASIS` UNIT via order 22). O8 CLOSE (`dd-real` + export
customers 2). O1 OPEN (sent `b` stored `a`). O7 OPEN (trial ≠ client;
prislinjer in admin after this export). O9 OPEN (seed `descLen` 0). O10 OPEN
(no implicit-990 shop). O12 OPEN (verify exit 5).

Human O7 prislinjer: if they land after this snapshot, re-export; do not
auto-close O7 on trial-shop probe lines. Probe order 25 left on source. Never
status 1. Never `SetEncoding`.

# P5 — clean re-run after SCALE delete (2026-08-17 evening). Later section.

Authorized SCALE `Product_Delete` on shop000000: identity gate
`Solution_GetWebinfo` SolutionId `shop000000`. Before 623 / 600 SCALE / 23 kept.
Deleted 600, failed 0. Re-query **23**, remainingScale **0**. Kept 1–18 +
626–630. Products 1 and 5 (prislinjer) untouched. Evidence:
`data/probes/p5-scale-delete.json`.

Second Shopify wipe (26 silent `-1` handles): CLI exit **0**, 171.5s.

WP-parity importer: collapse duplicate handles to last writer before bulk
(`src/import/products.js` `collapsePendingByHandle`). import-sim 59 pass.

Re-export after Prislinjer: 23 products, public 199/399 not 150/120/299.
Transform 47 action (HANDLE_COLLISION 0). Import products 23/0 collections 8.
Orders 14/9 empty-line. Verify products 23=23, spot 10/10, failures.orders 9
only. D15 `dd-id-1` 199.00 / `dd-id-5` 399.00, compareAtPrice null (WP sale
mapping; do not invent Discount→compareAt). MCP `migration_status` 0.016s and
`migration_verify` exit 5 — stale `removeFile` cache gone.

O1 CLOSED from Hostedshop help: `"a" (fast beløb (amount)) "p" (procent)`.
O7/O9/O10/O12 remain OPEN. P5 not complete.

# P5 — COMPLETE (2026-08-17 22:06). Later section.

Human approvals: O12 closed (classified verify exit 5; F16 empty orders only; D15
clean). O7 left OPEN. O7/O9/O10 re-gated to extra gate `CLIENT` (first client
migration, job 2026-08-20). Not a P6 phase.

SCALE delete 623→23, 0 SCALE remaining. Wipe #2 exit 0. Re-export 23 products,
prislinjer dropped as group UserId 4, public 199/399. Import 23 products, 8
collections, 7 pages, 14 orders, 9 empty-line refused. Spot 10/10. Idempotent
0 new rows. MCP post-reload: `mcp-p5-prove.json`. Importer
`collapsePendingByHandle` last-writer. P5 ✅. Do not start P6.

# P6 — operator steps (capability close)

## Gift cards (F24 dead — no GraphQL export)

DanDomain gift-card balances are **not** read from the experimental GraphQL schema
(F24: zero rows were ever read; do not invent a query). When a shop has gift cards to
carry over:

1. Export active gift-card codes from the DanDomain admin (CSV or manual list).
2. Place `transformed/gift-cards.csv` with columns `code,initial_value,note` (one card per row).
3. Set `options.importGiftCards: true` in the migration config (off by default).
4. Run `import --json` (or include in `all`). Without the CSV the importer emits
   `GIFT_CARDS_MANUAL` — no codes are invented.

Doctor checks `write_gift_cards` scope only when the flag is on.

# Seed ladder (2026-08-18). Later section — operator how-to.

Five Hostedshop sizes. **Same names** on MCP `migration_seed`, CLI
`seed --json --tier`, and TTY `[g]`:

| Tier | Meaning |
|---|---|
| `dd-light` | LIGHT scratch (edge/capability; few SKUs). Do not inflate. |
| `dd-medium` | `dd-light` + ~60 generated SOAP products + extra users/orders. Cumulative. |
| `dd-heavy` | `dd-medium` + ~280 generated + pathological HTML/æøå + a >3-dim variant probe. Cumulative. |
| `dd-real` | STANDALONE messy Example Hostedshop (client-shop bar) + completeness extras (2DIM, filsalg, ExtraBuy, B2B group vs R42 public, word coupons, letter-x, CMS page, UK layer). |
| `dd-real-xl` | STANDALONE. Runs `dd-real`, then long-tail + one 120-variant yarn product (10 Farve × 12 Størrelse, probe-wrapped). Top tier = realistic client Hostedshop rehearsal, not WP `real-xl` SKU counts. |

SOAP upsert. **Omit `wipeFirst`.** `wipe_wordpress` refuses a DanDomain pair.
Cursor live path: MCP `project-0-wordpress-to-shopify-shoplift`, `async: true`
on long stages, poll `migration_job_status`. Never `Solution_SetEncoding`.
Never hand-edit `src/dandomain/operations.js`. Never wipe unless the human asked.
The 18-product 2026-08-18 MCP run is capability-close evidence, not this `dd-real`.

