<div align="center">

```
 0100111 01 00110 1101001 010 1 011011 0010111 01001 10 1101 0 01110 100
  ████ █   █  ███  ████  █     █████ █████ █████
 █     █   █ █   █ █   █ █       █   █       █
  ███  █████ █   █ ████  █       █   ████    █
     █ █   █ █   █ █     █       █   █       █
 ████  █   █  ███  █     █████ █████ █       █

 ▓▒░ store extraction & relocation suite  v1.337 ░▒▓
```

**A WordPress-to-Shopify migration pipeline.** It is config-driven, resumable, and auditable.

![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-5FA04E?logo=node.js&logoColor=white)
![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-00C250)
![Shopify Admin API](https://img.shields.io/badge/Shopify%20Admin%20API-2026--07%20GraphQL-95BF47?logo=shopify&logoColor=white)
![Offline tests](https://img.shields.io/badge/offline%20tests-1320%20assertions-00C250)
![Licence](https://img.shields.io/badge/licence-MIT-6E7681)

</div>

---

SHOPLIFT needs Node.js version 20 or later. It has **zero runtime dependencies**. It uses the Shopify **GraphQL Admin API** for all operations (the REST Admin API is legacy). Agencies can use SHOPLIFT for repeated client work: one config file per client, resumable runs, and an audit trail. SHOPLIFT migrates data from WooCommerce, from Easy Digital Downloads, and from WordPress posts and pages.

| | |
|---|---|
| **[SETUP.md](SETUP.md)** | Cold start without the interactive menu: `.env`, profile registration, pair activation, and the checks to pass first. Written for an AI agent. |
| **[PLAYBOOK.md](PLAYBOOK.md)** | The migration workflow: scoping, store setup, SEO, go-live, and the tasks that automation cannot do. |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How the tool is built: layers, the ten invariants, and extension points. |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | Setup steps, ground rules, testing, and files that must never be committed. |
| **[SECURITY.md](.github/SECURITY.md)** | Where credentials live, operating rules, and accepted risks. |

This README describes how to operate the pipeline.

## Install and run

```bash
git clone <this repo> shoplift && cd shoplift   # Node 20+, no npm install needed
cp .env.example .env                            # fill in the credentials you need; .env is gitignored
npm test                                        # offline check, no store needed
node src/cli.js doctor                          # checks the active source and the Shopify target
```

Credentials live only in your local `.env` and in the gitignored `config/` files. They are never sent anywhere except the stores you configure. See [SETUP.md](SETUP.md) for the full setup.

**Licence:** MIT. See [LICENSE](LICENSE).

## Pipeline

```
 EXPORT                TRANSFORM                IMPORT                    VERIFY
 WP/Woo REST APIs  →   data/raw/*.jsonl    →    Shopify Admin GraphQL  →  reconciliation
 (read-only)           data/transformed/*      (resumable, idempotent)    report
                       + warnings.jsonl
                       + redirects.csv
```

SHOPLIFT migrates these entities: products (with variants, images, and SEO data), categories (mapped to collections), customers, orders (historical, with the original dates kept), coupons (mapped to discount codes), posts (mapped to blog articles), pages, and 301 redirects.

SHOPLIFT supports four sources: `woocommerce` (full support), `edd` (Easy Digital Downloads), `dandomain` (DanDomain / Hostedshop), and `fixture` (offline test data). To add support for another WordPress commerce plugin, write an adapter that normalizes the plugin's data to the WooCommerce shape. See `src/sources/edd.js` (about 100 lines) as an example, then register the new adapter in `src/sources/index.js`.

## Quickstart

```bash
node src/cli.js        # interactive menu: sites, wizard, doctor, all stages
node src/cli.js sites  # jump straight to the site manager
```

The **site manager** (`[s]`) keeps named WordPress, DanDomain, and Shopify connection profiles in `config/sites.json` (this file is gitignored). From the site manager you can add, edit, or delete stores; test any profile's connection; and activate a source-to-target pair. Activating a pair generates the runtime config and creates a data directory for that pair (`data/<source>__<target>/`), so ledgers and exports never collide between client projects.

SHOPLIFT remembers each pair's data directory permanently: switching between clients and back always finds the old ledger and history. The Pairs list shows each migration's last staged, imported, and verified timestamps, and the command `p p2` re-activates a pair directly. When you add a WordPress site, the site manager can **self-configure from an admin login**: it creates a WordPress application password and installs WooCommerce through the API, with no manual key creation.

The site manager needs a terminal. For a non-interactive setup, use the `sites-add`, `sites-activate` and `sites-list` commands with `--json`, or the same tools over MCP. **[SETUP.md](SETUP.md)** gives that sequence, written for an AI agent that configures the tool unattended.

The **wizard** (`[w]`) enters credentials for the active pair: WordPress app-password / Woo keys on a WordPress source, or `DD_SOAP_*` SOAP credentials on a DanDomain source. **doctor** checks the active source (WordPress REST + WooCommerce, or DanDomain SOAP + storefront) and Shopify (auth, currency, Protected Customer Data) before any stage runs. **Seed** (`[g]`) offers `light`/`medium`/`heavy`/`real`/`real-xl` on WordPress and `dd-light`/`dd-medium`/`dd-heavy`/`dd-real`/`dd-real-xl` on DanDomain.

The UI uses hand-rolled ANSI output, with no external dependencies: spinners appear during exports, and progress bars appear during imports. The UI degrades to plain text automatically when piped or run in CI, and it respects the `NO_COLOR` environment variable.

The following commands do the same tasks for use in scripts or in CI:

```bash
npm test                           # offline sanity check, no store needed
node src/cli.js doctor
node src/cli.js export
node src/cli.js transform          # review data/transformed/warnings.jsonl !
node src/cli.js import --dry-run   # preview
node src/cli.js import --entities products,collections
node src/cli.js import --entities customers,discounts,pages,articles
node src/cli.js import --entities orders
node src/cli.js import --entities redirects   # at go-live only
node src/cli.js verify
```

## Creating the Shopify app (2026)

Since January 1, 2026, you create new Shopify apps in the **Dev Dashboard** ([dev.shopify.com](https://dev.shopify.com)), not in the store admin. Two routes are available:

- **Dashboard**: Create the app. Set the Admin API scopes listed in `.env.example`. Install the app on the store. Copy the Client ID and Secret into `.env`.
- **Shopify CLI (config-as-code)**: Run `npm i -g @shopify/cli@latest && shopify app deploy` in the repo root. This creates the app from `shopify.app.toml` with the exact scopes preset. Then install the app on the store and copy the credentials from the Dev Dashboard.

The pipeline exchanges the Client ID and Secret for 24-hour offline tokens automatically, through the client credentials grant, and refreshes the tokens during a run. Legacy custom apps (with `shpat_` tokens) created before 2026 still work, through the `SHOPIFY_ADMIN_TOKEN` variable.

Helper script: `scripts/bootstrap-wp.mjs` sets up a WordPress test site end to end. It installs WooCommerce through the API, seeds edge-case test data, and writes the `.env` file and config. See the script header for details.

## Key behaviors

- **Resumable and idempotent**: `data/state/idmap.json` records every imported record in a ledger. Products upsert by handle, customers upsert by email, and orders upsert by the source ID. If you re-run an import, SHOPLIFT skips records that already landed. SHOPLIFT writes failures to `data/state/failed-*.jsonl`, together with Shopify's `userErrors`.
- **Bulk operations where they matter**: Products and customers use Shopify bulk operations (a staged JSONL upload with no rate-limit cost). Orders, discounts, and content run one record at a time, with automatic cost-based pacing read from `throttleStatus`.
- **Safe order import**: Order import sets `inventoryBehaviour: BYPASS`, sends no receipts or fulfillment emails, and keeps the original order dates. You must also disable auto-fulfillment in the Shopify admin (see PLAYBOOK.md, section 3).
- **Nothing writes to WordPress**: the source site stays intact, so you can roll back at any time.
- **API version**: The Shopify API version is pinned in the config file (`2026-07`, the current stable version). All GraphQL documents live in `src/shopify/mutations.js` and are verified against the shopify.dev 2026-07 schema docs. On each quarterly version bump, check that one file against the changelog. Tip: every shopify.dev reference page has an LLM-friendly text version at the same URL with `.txt` added.

## Agent interface (machine mode)

Every stage can output JSON, for AI agents and for scripts. The command
`node src/cli.js <stage> --json` emits one envelope on stdout
(`{ tool, v, command, ok, exit, elapsedS?, data, error }`), sends all prose
output to stderr, and exits with one of six fixed codes: 0 for OK, 1 for a
crash, 2 for a usage error, 3 for a connection failure, 4 for a partial
result, and 5 for a failed verification. The command `all --json` follows
the same rule: it emits one envelope, with each stage's results nested
under `data` (there is no JSONL or multi-line mode). The command
`status --json` combines every state file into one report.

An MCP server (`node src/mcp-server.js`, with the bin name `shoplift-mcp`)
exposes the same commands as 16 tools over stdio JSON-RPC. See `docs/MACHINE-CONTRACT.md`,
section "Installing as an MCP server", for the config block and for where
the config goes in Claude Code and in other clients. The full agent
contract lives in `docs/MACHINE-CONTRACT.md`. The directory `skills/shoplift-operator/`
packages the contract as an installable skill.

## Layout

```
src/cli.js               entry point
src/sources/             woocommerce | edd | fixture adapters (+ wp-content for posts/pages)
src/stages/export.js     WP → data/raw
src/transform/           raw → Shopify GraphQL inputs (pure, offline, warnings)
src/shopify/             GraphQL client (throttle-aware), mutations, bulk-operation flow
src/import/              per-entity importers in dependency order
src/stages/verify.js     post-import reconciliation
fixtures/ + test/        6 offline test suites, 1320 assertions total: npm test
                          (132 fixtures + 71 import-sim + 180 machine
                          + 243 MCP + 630 dandomain + 64 probe-kit)
```
