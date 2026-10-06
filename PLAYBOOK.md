# WordPress → Shopify Migration Playbook

Current as of **July 2026**. Companion to the SHOPLIFT pipeline in this repo. The pipeline automates the data; this playbook covers everything around it — scoping, store setup, SEO, go-live — and states explicitly what cannot be automated.

---

## 1. Choose the right tool for the job

Not every migration needs the full pipeline. Pick the lightest tool that covers the scope:

| Situation | Recommended approach |
|---|---|
| Small store, products + customers only, no order history | **Shopify's free Store Migration app** (Shopify-built, connects to WooCommerce directly). Imports products (titles, descriptions, variants, pricing, inventory levels, images, SKUs/barcodes) and customers (names, emails, phones, billing/shipping addresses) — and nothing else. Per Shopify, it does **not** import orders and order history, collections, navigation menus, SEO data, blog posts and pages, reviews, or integrations/apps. Two gotchas even on what it does cover: it "sets prices to the highest price for a product" and "doesn't import inventory by location", both needing manual repair afterwards. |
| Spreadsheet-comfortable team, one-off migration, wants a UI | **Matrixify** (Shopify app, Excel/CSV based, covers nearly all entities incl. orders) |
| Hands-off, budget available | Managed services: **Cart2Cart**, **LitExtension** |
| Agency doing repeated migrations, full control, order history, SEO fidelity, repeatable per client | **This pipeline** — config-driven, resumable, auditable, GraphQL-native |

The pipeline exists because the app-based options are either incomplete or manual per run. The gap is concrete: of this pipeline's eight entities, only products and customers are covered by Shopify's Store Migration app at all. Collections, orders, pages and articles are on Shopify's own list of what that app does not import (along with navigation menus, SEO data and reviews); discounts and redirects appear nowhere in its supported set either. And on the two that do overlap, the app flattens variant pricing to the highest price and ignores per-location inventory. Everything below assumes the pipeline, but sections 2, 3, 6–9 apply to any method.

## 2. Pre-migration audit (week 0)

Do this before quoting a timeline. A standard store (few hundred products, standard theme) typically takes **3–6 weeks end to end**; the audit tells you which side of that range you're on.

**Data inventory.** Record counts in WP admin: products (by type — simple/variable/grouped/external), categories, customers, orders (by status and year), coupons, posts, pages, media. These counts are your reconciliation baseline; the pipeline's `verify` stage compares against them.

**Product model check.** Shopify allows max **3 options per product** and (since Oct 2025, on the current product model) up to **2048 variants** and **250 media files** per product. Woo products with 4+ variation attributes or extreme variant counts need restructuring — the pipeline merges excess attributes into option 3 and flags each case in `warnings.jsonl`, but review these by hand.

**Product types.** Woo *grouped* and *external/affiliate* products have no Shopify equivalent. Grouped → recreate as a collection or use a bundle app; external → drop or link out from a page. The pipeline skips them with a warning.

**Plugin → app mapping.** List every active WP plugin, mark the ones with customer-facing function (subscriptions, bookings, wishlists, loyalty, B2B pricing, multilingual, reviews) and find the Shopify app equivalent for each. This list usually drives the project cost more than the data does. Common ones: WooCommerce Subscriptions → a Shopify subscriptions app (contracts do NOT migrate automatically — see §5); WPML/Polylang → Shopify Markets + Translate & Adapt; product reviews → Judge.me / Yotpo (both have WooCommerce CSV importers).

**Theme.** Shopify themes are Liquid; nothing transfers. Pick an OS 2.0 theme or budget a custom build. Content in page builders (Elementor, Divi, WPBakery) exports as shortcode soup — the pipeline strips shortcodes, but builder-heavy pages must be rebuilt in the theme editor or an app like PageFly/Shogun.

**SEO baseline.** Export current rankings/URLs: Search Console top pages, a crawl (Screaming Frog) of all indexed URLs. This is the input for redirect QA at go-live.

## 3. Shopify store preparation

Create the store and configure before importing anything:

1. **Plan**: any plan works with this pipeline (it uses a custom app token). API throughput scales with plan — the GraphQL cost-limit restore rate is higher on Advanced and much higher on Plus — which mainly matters for the per-call order import on large histories.
   **Agency pattern (recommended)**: create the client's new store as a **partner development store** in your Partner org. During the build phase it's free, order-import rate limits are the only pain, `wipe` works — so you can rehearse the migration as many times as it takes. When the migration is accepted, transfer the store to the client (it moves onto a paid plan); `plan.partnerDevelopment` flips off and `wipe` locks itself out of that store forever — the safety gate follows the store's lifecycle automatically. If the client already created a paid store themselves, rehearse on your own dev store instead and run the import into their store once — imports are idempotent and resumable, so a failed run is resumed, never wiped. NB: on a paid store, grant the app **Protected Customer Data** access early — outside dev stores that flow can involve review time, and customers/orders won't import without it (the doctor catches this).
2. **App + credentials** (changed Jan 1, 2026 — legacy custom apps can no longer be created by shop owners): create the app in the **Dev Dashboard** ([dev.shopify.com](https://dev.shopify.com)) → configure Admin API access scopes: `write_products`, `write_customers`, `write_orders`, `write_discounts`, `write_content`, `write_files`, `write_inventory`, `read_locations`, `read_publications`, `write_publications` → release the version → install the app on the store → copy **Client ID + Client Secret** from the app's Settings page into `.env` (`SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`). The pipeline exchanges these for 24h offline access tokens automatically ([client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant)) — offline tokens are what `orderCreate` requires. Legacy custom apps created before the cutoff still work: put their permanent `shpat_` token in `SHOPIFY_ADMIN_TOKEN` instead.
3. **Protected Customer Data (required before customers/orders import)**: in the app's dashboard → **API access** → *Protected customer data access*, enable **Protected customer data** plus the **Name, Address, Email, Phone** fields (any applicable reason). Apps installed only on dev stores get access immediately after saving — no review. Without this, customer/order API responses are redacted; dangerously, **mutations still execute** while their responses error, which can duplicate orders on retry. The pipeline guards against this (doctor check, import pre-flight, per-order existence check), and `scripts/cleanup-duplicate-orders.mjs` removes any duplicates that predate the guards.
4. **Critical settings before order import**:
   - Settings → Checkout → order processing: **auto-fulfillment OFF** ("Don't fulfill any of the order's line items automatically"). Belt-and-suspenders with the pipeline's `sendReceipt/sendFulfillmentReceipt: false` — this prevents historical orders emailing customers.
   - Settings → Notifications: consider disabling staff order notifications during import.
   - Taxes: EU/DK stores — set "All prices include tax" to match how Woo prices were entered, and configure VAT registrations *before* spot-checking imported prices.
   - Markets/currencies, shipping zones, payment providers: configure any time before go-live; not needed for import.
5. **Locations**: if multi-location, set `shopify.primaryLocationId` in the config; otherwise the pipeline auto-detects the shop's primary location for inventory.

## 4. Running the pipeline

Full reference in `README.md`. The operational sequence for a real client:
Agents (Claude etc.) drive the same sequence through the machine interface — see `docs/MACHINE-CONTRACT.md`.

1. `node src/cli.js export` — snapshot the WP site to `data/raw/`. Run against the live site; read-only. For big order histories set `source.woocommerce.ordersAfter` to bound the export.
2. `node src/cli.js transform` — offline mapping to `data/transformed/`. **Read `warnings.jsonl` line by line** — it is the punch list of everything that won't migrate cleanly (grouped products, >3 options, multi-coupon orders, scoped coupons, refunds).
3. Import in waves, reviewing in admin between each:
   - `import --entities products,collections` → spot-check products (prices incl/excl VAT, images, variants, inventory) while they're still `DRAFT` (default `productStatus`).
   - `import --entities customers,discounts,pages,articles`
   - `import --entities orders` → per-order `orderCreate` calls; historical dates preserved via backdated `processedAt` transactions; no emails, no inventory movement (`inventoryBehaviour: BYPASS`).
   - `import --entities redirects` → **only at go-live** (§7).
4. `node src/cli.js verify` — count reconciliation + random price spot-checks + failure roll-up.

Every import step is resumable: `data/state/idmap.json` records what already landed; re-running skips it. Failures land in `data/state/failed-*.jsonl` with the exact `userErrors` from Shopify.

**Images**: product/article images are imported by URL (`originalSource`) — Shopify downloads them from the WP site during import, so **the WP site must stay online until imports finish**. Images inside post/page body HTML keep pointing at the old domain; either keep serving `wp-content/uploads` (e.g. from a subdomain) or re-upload body images via Files and update links during theme build.

**Order of magnitude**: products and customers go through Shopify bulk operations (staged JSONL upload + `bulkOperationRunMutation` — max 100 MB per file, runs async, effectively free of rate-limit cost). Orders run one `orderCreate` per order, auto-paced from the API's live throttle feedback; expect roughly 2–5 orders/second on standard plans.

## 5. What does NOT migrate automatically (client-facing list)

Communicate this list at kickoff — it sets expectations and scopes the manual work:

- **Passwords.** Woo password hashes cannot be imported. Customers are created without login; run a re-activation campaign at launch (Shopify's "account invite" emails, or new-style customer accounts with email codes — no password at all).
- **Theme/design and navigation menus.** Rebuilt in Liquid/theme editor. Menus are quick manual work in Navigation.
- **Plugin functionality.** Each plugin from the §2 mapping is its own workstream.
- **Refund objects.** Refunded Woo orders import as paid orders tagged `wc-status-refunded` (noted on the order); Shopify's API cannot backdate refund records. Financial reports in Shopify start clean from go-live; treat WP as the system of record for pre-migration accounting.
- **Multi-coupon order detail.** Shopify orders accept one discount code; extra codes are preserved in the order note and tags.
- **Subscriptions/recurring contracts.** Active WooCommerce Subscriptions need a dedicated app migration (e.g. via the app's own import flow) and usually payment-method re-collection unless the gateway supports token migration.
- **Saved payment methods.** Card tokens live with the PSP. Token migration is a gateway-to-gateway project (e.g. Stripe → Shopify Payments token export) — start that conversation early if subscriptions or saved cards matter.
- **Product reviews.** Export from the Woo review plugin, import via Judge.me/Yotpo's own importers.
- **Email marketing consent.** Woo core has no provable opt-in trail; the pipeline deliberately does not set consent. Migrate lists in the ESP (Klaviyo/Mailchimp) and sync to Shopify from there.
- **Transactional email templates, gift cards, wishlists, blog comments.**

## 6. SEO strategy

The redirect map is generated from real permalinks in the export (`data/transformed/redirects.csv`), covering products (`/produkt/... → /products/...`), categories (`→ /collections/...`), posts (`→ /blogs/<blog>/...`), pages (`→ /pages/...`) plus structural paths (`/shop`, `/my-account`). Shopify redirects match on path only, which is exactly right for a domain move.

- Meta titles/descriptions from Yoast/Rank Math carry over: products via the native `seo` field, pages/articles via the theme-standard `global.title_tag` / `global.description_tag` metafields.
- Shopify URL structure is fixed (`/products/`, `/collections/`, `/pages/`, `/blogs/`) — do not fight it; redirect into it.
- Keep handles identical to WP slugs (the pipeline does, transliterating æ/ø/å) so URLs change only in prefix.
- After go-live: submit the new sitemap (`/sitemap.xml`) in Search Console, monitor Crawl stats + 404s, and top up redirects in admin (Content → Menus → URL redirects) as stragglers appear. Expect some ranking wobble for 2–6 weeks; permanent losses usually trace to a missing redirect or removed content, not the platform.

## 7. Go-live runbook

1. Freeze content/orders on WP (maintenance mode for checkout, or announce a cutover window; for zero-downtime, do a delta export/import of orders+customers created since the main run — `ordersAfter` config makes this a 10-minute job).
2. Final delta: `export` → `transform` → `import --entities orders,customers`.
3. `import --entities redirects`.
4. Activate products (if imported as DRAFT): bulk-select in admin → Set as active.
5. Point DNS: apex + www to Shopify (admin shows the current required records; Shopify handles TLS). Lower TTL a day ahead.
6. Set the primary domain in Shopify, enable "redirect all traffic to primary domain."
7. Keep the WP site reachable on an internal subdomain (blocked from indexing) for 30–60 days as reference, and to keep serving `wp-content/uploads` if body images still point there. Then archive a full backup and decommission.
8. Test the money path live: place a real order, refund it, test the top 5 redirect URLs, run `verify`.

**Rollback**: DNS back to the old host (why you lowered TTL). WP stays intact through the whole project — the pipeline never writes to WordPress.

## 8. Post-migration QA checklist

`verify` covers counts and price spot-checks. Manual pass: variant switching + add-to-cart on the 10 best-selling products; VAT display on product/cart/checkout; a historical order's totals vs the same order in Woo; customer account invite flow; discount code at checkout; blog layout/images; contact/legal pages; mobile nav; Search Console coverage after 1 week.

## 9. API facts this pipeline is built on (July 2026)

- REST Admin API is **legacy since Oct 1, 2024**; new public apps must be GraphQL-only since April 2025, and legacy REST product endpoints are being removed in waves from version 2025-10 onward. The pipeline is 100% GraphQL Admin API, default-pinned to `2026-07`, the current stable (quarterly versions, each supported 12 months — bump `shopify.apiVersion` and re-run `npm test` quarterly). All input-object shapes in `src/shopify/mutations.js` were verified against the 2026-07 schema docs.
- `productSet`: upsert by handle, current product model, ≤3 options / ≤2048 variants / ≤250 media / ≤50k inventory quantities per call; sync for small batches, JSONL bulk for large.
- Bulk operations: staged JSONL ≤100 MB, 24 h window, one connection field per mutation, up to 5 concurrent bulk mutations per app per shop (since 2026-01), negligible rate-limit cost.
- `customerSet` upserts by email identifier (idempotent re-runs).
- `orderCreate`: offline-token apps; backdatable transaction `processedAt`; `fulfillmentStatus: FULFILLED` on create; one discount code per order; `options { inventoryBehaviour: BYPASS, sendReceipt: false, sendFulfillmentReceipt: false }`.
- Redirects: staged CSV upload → `urlRedirectImportCreate` → `urlRedirectImportSubmit` (same CSV works for manual admin upload).
- Content: `blogCreate` / `articleCreate` / `pageCreate` mutations (GraphQL content APIs).
- Rate limiting is cost-based per plan; the client paces itself from `extensions.cost.throttleStatus` rather than hardcoded numbers.
- **Live-discovered (not prominent in docs):** `orderCreate` has a separate order-*creation* rate limit surfacing as a `"Too many attempts"` userError (harsh on dev stores, ~4-5/min; production is more generous) — the importer auto-paces and retries. Option names reject the literal sequence `" / "` (merged >3-attribute options use `" & "`).
- **Live-discovered during the `real` tier run (2026-07-27, Example Living dataset):**
  - `orderCreate` accepted an order in a NON-store currency (EUR into a USD store) and an order with no billing address and no email — both imported cleanly on a dev store. Foreign-currency history is importable; decide per-migration whether you *want* that or prefer converting.
  - Woo REST enforces hygiene the wild DB doesn't: it **trims whitespace in SKUs**, **rejects duplicate SKUs** (`product_invalid_sku`) and **normalizes away `sale_price > regular_price`** — so those three messes only enter stores via CSV/DB imports. The transform still guards all three (fixture-proven) because real old stores have them.
  - Woo REST **ignores backdated `date_created`** on order create (stores "now"). Historic order dates therefore can't be fabricated via REST — they only exist in genuine exports. Consequence: Shopify-side backdated `processedAt` remains proven by fixtures, not live.
  - Force-deleting a Woo product **NULLs the SKU on existing order lines** — ghost lines arrive title-only at the source already; the importer's missing-SKU tolerance (custom line item) is the right shape.
  - Partial refunds seed cleanly via `POST orders/{id}/refunds` with `api_refund: false`; they surface as `refunds[]` on the order while status stays completed/processing → the transform's `REFUND_PARTIAL` note + full-value import is the correct treatment.
  - WP term slugs may contain underscores, so two distinct Woo slugs can collapse into ONE Shopify handle (`strikke_tilbehoer` + `strikke-tilbehoer`); same for a grouped product named like a category. Collections then **merge silently on import** — live: 20 collection inputs → 18 collections, deterministic. The `HANDLE_COLLISION` warning exists precisely for this.
  - Wiping a store deletes the auto-created "Home page" collection permanently — after a wipe, do NOT expect the usual +1 in verify's collection count.
  - TasteWP ships US/USD/lbs defaults; the pipeline just propagates source settings (weights imported as POUNDS, prices as USD). Set `woocommerce_currency`/units on the test site first if the demo must look Danish.
- WooCommerce REST v3: HTTPS basic auth with consumer key/secret, `per_page` ≤100, pagination via `X-WP-Total(-Pages)`/Link headers.

### Sources

- [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning) · [REST deprecation guide](https://www.lazertechnologies.com/insights/shopifys-rest-api-deprecation-and-graphql-migration-guide) · [Deprecated REST endpoints](https://shopify.dev/docs/api/admin-rest/latest/resources/deprecated-api-calls)
- [Bulk import with the GraphQL Admin API](https://shopify.dev/docs/api/usage/bulk-operations/imports) · [bulkOperationRunMutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkoperationrunmutation) · [Bulk operations guide (2026 limits)](https://tenten.co/shopify/shopify-bulk-operations-api-2026/)
- [2048-variant limit GA](https://shopify.dev/changelog/the-product-variant-limit-is-now-2048-for-all-merchants) · [productSet inventory limits](https://shopify.dev/changelog/productset-limit-for-inventory-quantities)
- [customerSet upserts](https://shopify.dev/changelog/productset-and-customerset-mutations-now-support-upserts) · [customerSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/customerSet)
- [orderCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCreate) · [OrderCreateOrderInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ordercreateorderinput) · [B2B order import](https://shopify.dev/docs/apps/build/b2b/import-orders) · [Order import guide](https://firebearstudio.com/blog/how-to-import-orders-into-shopify.html)
- [urlRedirectImportCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/urlRedirectImportCreate) · [URL redirects help](https://help.shopify.com/en/manual/online-store/menus-and-links/url-redirect)
- [articleCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/articleCreate) · [pageCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/pageCreate) · [blogCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/blogcreate)
- [Shopify API limits](https://shopify.dev/docs/api/usage/limits) · [Rate-limit strategies (2026)](https://no7software.co.uk/blog/shopify-admin-graphql-rate-limits-production)
- [Store Migration app (Shopify)](https://www.shopify.com/blog/store-migration-shopify-app) · [WooCommerce→Shopify tooling compared (2026)](https://wearepresta.com/woocommerce-to-shopify-migration-tools-compared-what-actually-works-in-2026/) · [Matrixify orders](https://matrixify.app/documentation/orders/) · [Woo→Shopify guide (Bluehost 2026)](https://www.bluehost.com/blog/migrate-from-woocommerce-to-shopify/)
- [WooCommerce REST API docs](https://woocommerce.github.io/woocommerce-rest-api-docs/) · [Woo REST integration guide 2026](https://www.cloudways.com/blog/woocommerce-rest-api/)
