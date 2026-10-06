# SETUP.md — cold start without the interactive menu

## Who this file is for

This file is for an AI agent that must configure SHOPLIFT unattended, and for the
human who supplies the credentials. Every step is a file edit or a `--json`
command. No step needs the interactive site manager (`node src/cli.js sites`),
which draws an alternate screen and reads single keystrokes. An agent cannot
drive that screen. README.md shows the human path. docs/MACHINE-CONTRACT.md shows how to
operate the pipeline after setup. This file shows only the setup.

Read docs/MACHINE-CONTRACT.md before you run a stage. Nothing in this file changes the machine
contract in docs/MACHINE-CONTRACT.md.

## New machine — clone on a different computer

Do this when you clone the repo on a new computer (new Cursor install, new job
laptop). Goal: the tool starts with every key name present, and **no secret
travels through git**.

1. **Clone this repo.** SHOPLIFT already exists here. Do not scaffold a new
   product. `.env` is gitignored. Git never contains it. Do not run
   `git add .env`.
2. **Copy `.env` from a private store** into the repository root. Use a USB
   drive, a password manager, or 1Password. Do **not** copy `.env` from git, and
   do **not** commit it. If you have no private copy yet, copy `.env.example` to
   `.env` (Step 2) and fill the values by hand.
3. **Runtime.** Node.js 20 or later. Do **not** run `npm install` (zero runtime
   dependencies). On Windows, use a **native** shell on a local disk. A mounted
   drive refuses `unlink` in `test/run-import-sim.js` (EPERM). That failure is
   the mount, not a missing key.
4. **Register a new pair.** `config/sites.json` and
   `config/migration.config.json` are gitignored. A clone does not bring the
   old trial pair. For a real client DanDomain shop plus a **new** Shopify
   shop, run `sites_add` then `sites_activate` with **new profile names**. Do
   **not** reuse the trial pair `shop000000` → `example-store`, and do
   **not** reuse `data/shop000000__example-store`. Each pair keeps its own
   data directory forever.
5. **P6 flags stay off on a new pair.** `sites_activate` for a **new** pair
   generates the config from `migration.config.example.json`, then **strips**
   `options.importB2bPricing`, `importRefunds`, `importGiftCards`,
   `importTranslations`, and `source.dandomain.multiLanguage`.
   `options.giftCardsCsv` is not generated. The new pair therefore starts with
   those capabilities off. Re-activating the **same** pair keeps flags you set
   by hand. Do **not** turn the flags on for a real client shop unless the
   operator asks.
6. **`doctor --json` before any write.** Export is read-only on DanDomain.
   Do not `seed`, `wipe`, or `import` until the human asks. A client source
   stays read-only until that ask (O10).
7. **MCP.** Point the client at **absolute** paths (docs/MACHINE-CONTRACT.md, "Installing as
   an MCP server"). Relative paths and `${SHOPLIFT_HOME:-.}` fail when the
   client's working directory is not the clone. Do not copy that chapter here.
8. **Flag order.** `node src/cli.js <stage> --json`. Never `--json <stage>`
   (docs/MACHINE-CONTRACT.md, "The machine contract").

Then continue at Step 1 below if you still need to prove the runtime, or at
Step 3 if `.env` is already in place and `npm test` already passed on this
machine.

### DanDomain client pair (LLM)

WordPress setup stays Steps 2–5 below. Use this subsection when the source is a
**real client** DanDomain shop and the target is a **new** Shopify shop. Pair
rules, P6 flags, and “do not copy trial `data/`” are in **New machine** above.

After `doctor --json` (exit 0), the next source step is `export --json` (the
read-only DanDomain step). Do not `seed`, `wipe`, or `wipe --wp` on a client
shop. `wipe_wordpress` refuses a DanDomain pair at once (exit 2, `WP_WIPE_GATE`).
Do not import until the human asks. Client go-live (O10) stays CLIENT.

MCP in Cursor: `GetMcpTools` then `CallMcpTool`. Do not invent tool schemas.
Long stages (`migration_export`, `migration_import`, `migration_all`,
`migration_seed`, both wipes): `async: true`, then poll `migration_job_status`
(docs/MACHINE-CONTRACT.md, “Async jobs”).

## Prerequisites

- Node.js version 20 or later (`package.json` → `engines.node: ">=20.0.0"`).
- Do **not** run `npm install`. SHOPLIFT has zero runtime dependencies. This is
  invariant #6 in ARCHITECTURE.md. `package.json` declares no `dependencies` and
  no `devDependencies`. A `node_modules/` directory is not necessary.
- Write access to the repository root, to `config/` and to `data/`.
- `npm test` is the offline check. It needs no WordPress site and no Shopify
  store. Run it before you touch a real store.

## The cold-start sequence

Do the five steps in this order. Each step gives the command, and the exit code
that means success.

### Step 1 — check the runtime

```bash
node -v      # must print v20.0.0 or a later version
npm test     # exit 0
```

`npm test` runs six offline suites (`test/run-fixtures.js`,
`test/run-import-sim.js`, `test/run-machine.js`, `test/run-mcp.js`,
`test/run-dandomain.mjs` and `scripts/probe-dandomain.test.mjs`). Each prints
one line in the form `<n> passed, 0 failed`; the DanDomain runner prints a
per-suite table first and its own total last, and the probe kit prints
`all green`. Every suite must report `0 failed`, and the command must exit
`0`. Do not continue if a suite fails. A failing suite means the tool is
damaged, not that the configuration is wrong.

The DanDomain suites need the **pinned** probe artifacts under
`data/probes/` (`service.wsdl`, `gaps.json`, `scale.json`, `gqlshapes.json`,
`pagebase.json`, `completeness-blog.json`). Those files are tracked in git —
see `data/probes/README.md`. Live probe runs write other files into the same
directory; those stay gitignored. You do **not** need a DanDomain shop for
Step 1.

On Windows, run this in a native shell, NOT over a mounted drive: the mount
refuses the unlink in `test/run-import-sim.js` and the suite dies with EPERM
for a reason that has nothing to do with your setup.

### Step 2 — make the `.env` file

Prefer a **private copy** of an existing `.env` (USB, password manager, 1Password)
into the repository root. Git does not contain `.env`. Never `git add .env`.

If you have no private copy, start from the example (names only, empty values):

```bash
cp .env.example .env                    # POSIX shell
Copy-Item .env.example .env             # Windows PowerShell
```

Put `.env` in the repository root. The configuration loader reads the `.env` in
the repository root and the `.env` in the current directory
(`src/config.js` → `loadDotEnv`). `.env` is in `.gitignore`. Never commit it.

WordPress → Shopify needs the Woo/WP keys plus one Shopify mode. A DanDomain
source needs the SOAP pair instead of the four WordPress keys. FTP and GraphQL
keys are for the seeder, media, and GraphQL fallback — not for a read-only
export. The human obtains each one as follows.

| Variable | What it is | How the human obtains it |
|---|---|---|
| `WC_CONSUMER_KEY` | WooCommerce REST API key | WP Admin → WooCommerce → Settings → Advanced → REST API. Read access is enough. |
| `WC_CONSUMER_SECRET` | WooCommerce REST API secret | Shown once, together with the key above. |
| `WP_APP_USER` | WordPress user name | The WordPress account that owns the application password below. |
| `WP_APP_PASSWORD` | WordPress application password | WP Admin → Users → Profile → Application Passwords. Necessary only to export drafts and private content. Public posts and pages export without it. `seed` and `wipe --wp` need it, because they write to WordPress. |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard app Client ID | dev.shopify.com → create the app → set the Admin API scopes → install the app on the store → app Settings → copy the Client ID. |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard app Client Secret | Same page as the Client ID. |
| `SHOPIFY_ADMIN_TOKEN` | Legacy custom-app token (`shpat_…`) | Only for apps created before 1 January 2026. Use this **or** the Client ID and Secret, not both. |
| `DD_SOAP_USERNAME` | DanDomain SOAP API user | DanDomain admin → Indstillinger → API. Canonical name (`sites_add` / doctor / export). Only for a DanDomain source. |
| `DD_SOAP_PASSWORD` | DanDomain SOAP API password | Same page. Avoid `! , €` in the password — the SOAP layer mangles them (P1 finding). |
| `DD_FTP_HOST` | Hostedshop FTPS host | Default `ftps.mywebshop.io`. Seeder pictures and the ftp probe. Not required for read-only export. |
| `DD_FTP_USER` | FTPS user | Same Hostedshop FTP account. |
| `DD_FTP_PASSWORD` | FTPS password | Same account. |
| `DD_GQL_CLIENT_ID` | DanDomain GraphQL client id | Optional. Client fallback when the generated config has no `graphql` block. |
| `DD_GQL_CLIENT_SECRET` | DanDomain GraphQL client secret | Same as the client id. |
| `DD_GQL_TENANT` | GraphQL tenant (`shopNNNNN`) | Optional fallback tenant for GraphQL. `sites_activate` already stores the profile tenant. |
| `DD_PROBE_SHOP` | Probe-kit write-consent shop id | **Scratch shops only.** Do not set this to a real client shop. Not required for `doctor` or export. |

The Admin API scopes are the same for both Shopify modes: `write_products`,
`write_customers`, `write_orders`, `write_discounts`, `write_content`,
`write_files`, `write_inventory`, `read_locations`, `read_publications`,
`write_publications`.

**An unset variable expands to an empty string, not to an error**
(`src/config.js` → `expandEnv`). A forgotten value therefore shows up as a
`doctor` failure, not as a load failure. Step 5 catches it.

### Step 3 — register the two profiles

`config/sites.json` holds named source profiles (WordPress or DanDomain) and
named Shopify profiles. `sites_add` writes one profile. The file is gitignored.

**Register profiles with `${VAR}` pointers, not with secrets.** Every credential
field of a new profile defaults to an environment-variable reference:
`${WC_CONSUMER_KEY}`, `${WC_CONSUMER_SECRET}`, `${WP_APP_USER}`,
`${WP_APP_PASSWORD}`, `${SHOPIFY_CLIENT_ID}`, `${SHOPIFY_CLIENT_SECRET}`. The
reference is stored as text. It expands when the runtime config loads. Therefore
an agent registers a site without ever holding a real secret: the agent writes
the pointer, and the human writes the value into `.env`. This is the recommended
path. Use it unless a specific reason prevents it.

The CLI enforces this path. `sites-add` has **no** credential flags, because
`argv` is visible in the process list and in shell history. From the CLI you can
set only `--kind`, `--name`, `--base-url`, `--shop`, `--tenant`,
`--storefront-url`, `--shop-id` and `--overwrite`. Every credential field keeps
its `${VAR}` default.

**CLI form:**

```bash
node src/cli.js sites-add --json --kind wordpress --name clientwp --base-url https://shop.example.com
node src/cli.js sites-add --json --kind dandomain --name clientdd --tenant shopNNNNN
node src/cli.js sites-add --json --kind shopify   --name clientshop --shop clientshop
```

The stage name must be `argv[2]`. Put `--json` after it, never before it
(docs/MACHINE-CONTRACT.md → "The machine contract"). The CLI also accepts the underscore
spelling `sites_add`, `sites_list` and `sites_activate`, so a tool name copied
from the MCP list works at the CLI too.

A successful call exits `0` and writes one envelope:

```json
{"tool":"shoplift","v":1,"command":"sites_add","ok":true,"exit":0,"elapsedS":0.012,
 "data":{"kind":"wordpress","name":"clientwp","created":true,
         "profile":{"baseUrl":"https://shop.example.com","adapter":"woocommerce",
                    "consumerKey":"${WC_CONSUMER_KEY}","consumerSecret":"${WC_CONSUMER_SECRET}",
                    "wpUser":"${WP_APP_USER}","wpAppPassword":"${WP_APP_PASSWORD}"}},
 "error":null}
```

**MCP form** — the tool is `sites_add`. It accepts the same two required fields
and, unlike the CLI, the credential fields as well:

```json
{ "kind": "wordpress", "name": "clientwp", "baseUrl": "https://shop.example.com" }
{ "kind": "dandomain", "name": "clientdd", "tenant": "shopNNNNN" }
{ "kind": "shopify",   "name": "clientshop", "shop": "clientshop" }
```

Full field list:

| Field | Kind | Default | Note |
|---|---|---|---|
| `kind` | all | — | Required. `"wordpress"`, `"shopify"` or `"dandomain"`. |
| `name` | both | derived | Profile name. Always slugified. |
| `overwrite` | both | `false` | `true` replaces a profile of the same name. |
| `baseUrl` | wordpress | — | **Required** for `kind:"wordpress"`. `https://` is added when the scheme is absent. |
| `adapter` | wordpress | `"woocommerce"` | Set `"edd"` for Easy Digital Downloads. MCP only — the CLI has no flag for it. |
| `consumerKey` | wordpress | `${WC_CONSUMER_KEY}` | MCP only. |
| `consumerSecret` | wordpress | `${WC_CONSUMER_SECRET}` | MCP only. |
| `wpUser` | wordpress | `${WP_APP_USER}` | MCP only. |
| `wpAppPassword` | wordpress | `${WP_APP_PASSWORD}` | MCP only. |
| `shop` | shopify | — | **Required** for `kind:"shopify"`. Give `"mystore"` or `"mystore.myshopify.com"`. The profile always stores the full `mystore.myshopify.com` host. |
| `apiVersion` | shopify | `"2026-07"` | MCP only. |
| `clientId` | shopify | `${SHOPIFY_CLIENT_ID}` | MCP only. |
| `clientSecret` | shopify | `${SHOPIFY_CLIENT_SECRET}` | MCP only. |
| `adminAccessToken` | shopify | `""` (empty) | MCP only. For the legacy mode, set it to `"${SHOPIFY_ADMIN_TOKEN}"`. |
| `tenant` | dandomain | derived | The `shopNNNNN` subdomain. **Give `tenant` or `storefrontUrl`** — each derives the other. |
| `storefrontUrl` | dandomain | derived | The STOREFRONT host `https://{tenant}.mywebshop.io`. Never the admin host `{tenant}.webshop.dandomain.dk` — it answers `200` for every path (R39/R41). |
| `shopId` | dandomain | the tenant | What `doctor` and `seed` compare against `Solution_GetWebinfo.SolutionId` (the shop-identity gate). |
| `username` | dandomain | `${DD_SOAP_USERNAME}` | SOAP API user. MCP only. |
| `password` | dandomain | `${DD_SOAP_PASSWORD}` | SOAP API password. MCP only. |

The response redacts a credential field that holds a literal value. It passes a
`${VAR}` reference through unchanged, because a pointer is not a secret and the
agent must be able to tell the human which variable to fill in.

Two rules to obey:

1. **Always give `--name`.** An omitted name comes from the first label of the
   host name. `https://www.example.com` therefore gives the name `www`, and
   `https://shop.example.com` gives `shop`. An explicit name prevents this.
   The name becomes part of the pair key, and the pair key becomes the data
   directory name.
2. **A duplicate name is refused.** `sites_add` exits `2` with
   `CONFIG_MISSING` when the name exists. Send `overwrite: true`
   (CLI: `--overwrite`) only when you intend to replace the profile.

An unknown field name is also refused with exit `2`. It is never ignored.

### Step 4 — activate the pair

```bash
node src/cli.js sites-activate --json --source clientwp --target clientshop
```

Activation is the step that makes the tool runnable. It:

- generates `config/migration.config.json` from
  `config/migration.config.example.json`, with the two profiles merged in and the
  `$…` annotation keys removed;
- records the pair's data directory as `./data/clientwp__clientshop` in
  `config/sites.json`, and writes that path into `paths.data` of the generated
  config. The stages make the directory when they first write to it;
- sets the pair as the active pair.

Each pair keeps its data directory forever. Activate an old pair again and the
tool finds the old ledger, the old exports and the old reports.

Re-activating the **same** pair keeps the existing `config/migration.config.json`
and only refreshes the profile fields, so hand edits survive. Activating a
**different** pair regenerates the file from the example.

A pair whose source is a **DanDomain** profile generates the DanDomain form of
the config: `source.adapter` and `source.kind` are `"dandomain"`, the
`source.dandomain` block carries the tenant, the shopId and the `${VAR}` SOAP
credentials with `pageBase: "detect"` (the page base is proved against the shop
on the first export — R34), and `source.wpContent.enabled` is `false`. `doctor`,
`status` and the four stages read this form exactly like the WordPress one.
`source.allowDestructive` is never generated, and re-activation **drops** a
hand-added one — re-stating it per activation is deliberate friction on the
source-side wipe gate. The source block is rebuilt on every activation; hand
edits inside `source` do not survive on a DanDomain pair, while `entities`,
`options` and `shopify` edits do.

**P6 flags on a new pair.** Activation of a **different** pair (or the first
activation on a new machine) copies the example, then **deletes**
`options.importB2bPricing`, `importRefunds`, `importGiftCards`,
`importTranslations`, and `source.dandomain.multiLanguage`.
`options.giftCardsCsv` is not written. Those capabilities therefore start
**off**. Re-activating the **same** pair keeps flags the operator already set.
Do not turn them on for a real client shop unless the operator asks.

A real client DanDomain shop plus a new Shopify shop is a **new pair**. Do not
reuse `shop000000` → `example-store` or that pair's `data/` directory.

Edit `config/migration.config.json` directly for anything `sites_add` does not
cover. It is plain JSON. The fields you are most likely to change are
`options.locale`, `options.productStatus`, `options.weightUnit`,
`source.woocommerce.orderStatuses`, `source.woocommerce.ordersAfter`,
`shopify.blog`, and the eight flags under `entities` (`products`, `collections`,
`customers`, `orders`, `discounts`, `pages`, `articles`, `redirects`).

### Step 5 — run `doctor`

```bash
node src/cli.js doctor --json
```

`doctor` runs up to five checks, in this order:

1. WordPress REST — `GET {baseUrl}/wp-json/`
2. WooCommerce REST authentication (`wc/v3`) — runs when the adapter is
   `woocommerce`
3. Shopify Admin API authentication
4. Currency alignment, WooCommerce against Shopify
5. Protected Customer Data access, which `customers` and `orders` need

Checks 4 and 5 run only after check 3 succeeds. Check 4 also needs the
WooCommerce key. A complete WooCommerce-to-Shopify configuration therefore gives
five entries in `data.results`, each one `{ name, ok, detail }`.

A **DanDomain** pair skips WordPress and WooCommerce. It checks SOAP identity,
storefront, and Shopify instead. Every entry in `data.results` must still show
`"ok": true`.

`doctor` exits `0` only when every check passes. Any failure gives exit `3`.
**Every check must pass before you run any stage.** Do not run `export`,
`import` or `all` against a store while `doctor` reports a problem.

## What the agent can do alone, and what needs the human

An agent can do all five steps above alone, given the credential values.

An agent that has browser automation — Playwright, or a browser extension acting
in a session the human already signed in to — can also obtain most of the
credentials. It can open the Shopify Dev Dashboard, create the app, set the
Admin API scopes, install the app on the store, and copy the Client ID and
Secret. It can open the WordPress admin, create a WooCommerce REST key pair, and
create an application password. These are ordinary web forms. They are not
closed to an agent.

The agent cannot complete a step that needs one of the following:

- a second factor that a person must approve on a personal device;
- acceptance of a legal agreement, such as the Shopify Partner Program terms,
  the app terms, or the Protected Customer Data declaration;
- a store, a plan or a payment method that the human has not yet created;
- a secret held in a password manager or a vault that the agent cannot open.

Ask the human for those. Do not try to work around them.

Two related rules:

- **Prefer the pointer.** Register profiles with the `${VAR}` defaults and ask
  the human to fill in `.env`. The agent then never holds a secret at all.
- **If the agent does hold a literal secret, write it into `.env`.** Do not put
  it on a command line, and do not paste it into `config/sites.json` by hand.
  The CLI has no credential flags for exactly this reason.

For a **test** WordPress site there is a second, fully non-interactive path:

```bash
node scripts/bootstrap-wp.mjs <siteUrl> <username> <password> [--seed] [--tier light|medium|heavy]
```

It signs in, creates an application password, installs WooCommerce through the
API, and writes `.env`. Use it on scratch sites only. It **overwrites**
`config/migration.config.json` from the example file, so run it before Step 4,
never after.

## Verification checklist

Run these three commands, in this order, before you touch a real store.

1. **The pair is registered and active.**
   ```bash
   node src/cli.js sites-list --json
   ```
   Exit `0`. `data.shopify` contains the target name. A WordPress source name is
   in `data.wordpress`; a DanDomain source name is in `data.dandomain`
   (`data.wordpress` may be empty). `data.activePair` equals
   `{ "source": "clientwp", "target": "clientshop" }` or, for a DanDomain pair,
   `{ "source": "clientdd", "target": "clientshop" }`. `data.status` holds one
   row with `"active": true` and the expected `dataDir`.

2. **Every connection works.**
   ```bash
   node src/cli.js doctor --json
   ```
   Exit `0`, and every entry of `data.results` has `"ok": true`. See Step 5 for
   how many entries to expect.

3. **The config loads and the state paths resolve.**
   ```bash
   node src/cli.js status --json
   ```
   Exit `0`. The envelope carries `"tool":"shoplift"`, `"v":1`, `"ok":true`,
   `"error":null`. On a fresh pair `data.exported`, `data.transformed` and
   `data.verify` are `null`, every `data.ledger` count is `0`, and `data.pair`
   names the source URL, the adapter, the target shop and the data directory.
   A correct `data.pair` proves the whole chain: `.env` → `sites.json` →
   `migration.config.json` → paths.

Setup is complete when all three pass. Now follow the recipes in docs/MACHINE-CONTRACT.md.

## Failure modes

Branch on the exit code, never on text. The taxonomy is frozen
(`src/util/machine.js`): `0` OK, `1` crash, `2` usage, `3` connection,
`4` partial, `5` verify failed.

| `error.code` | Exit | What it means | What to do |
|---|---|---|---|
| `CONFIG_MISSING` | 2 | The config file is absent, or a required field is empty, or an argument was rejected. On a cold start it almost always means `config/migration.config.json` does not exist yet. | Do Steps 3 and 4: register the profiles with `sites_add`, then run `sites_activate`. Alternatively copy `config/migration.config.example.json` to `config/migration.config.json` and fill it in. Then run `doctor --json`. |
| `CONNECTION` | 3 | A network or authentication failure: HTTP 401 or 403, `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`, or a rate limit. | Run `doctor --json` and read `data.results` for the failing leg. An empty credential usually means a missing `.env` value, because an unset `${VAR}` expands to an empty string. |
| `PCD_NOT_APPROVED` | 3 | The app has no Protected Customer Data approval. `customers` and `orders` cannot import. | The human enables Protected customer data, plus the Name, Address, Email and Phone fields, in the app's API access settings. PLAYBOOK §3.3. |
| `USAGE` | 2 | An unknown command, or `--adapter` in `--json` mode. | Check that the stage name is `argv[2]` and that flags come after it. Set the adapter in the config file, or through `sites_add`. |
| `CONFIRM_REQUIRED` | 2 | A destructive command ran without `confirm: true` (`--yes` on the CLI). | Deliberate friction. Send it only when the user asked for the reset. |
| `WIPE_GATE` | 2 | `wipe_shopify` refused, because the target is not a development store. | No override exists. This is invariant #4. |
| `WP_WIPE_GATE` | 2 | `wipe_wordpress` refused, because `data/raw/summary.json` exists for this pair, **or** the active pair is DanDomain (refused immediately; the message names DanDomain). | WordPress: the source looks like a real migration source. The only override is `source.allowDestructive: true` in the config file. DanDomain: no override — this tool never wipes a DanDomain shop. |
| `PARTIAL_FAILURES` | 4 | Some records failed to import. | Re-run the same `import`. It is idempotent, and it retries exactly the failures. |
| `VERIFY_FAILED` | 5 | Reconciliation failed. | Read `data.counts` and `data.failures`. |
| `UNEXPECTED` | 1 | An unclassified error. | Re-run with `--verbose`. Stages are resumable. |

Two more rules from docs/MACHINE-CONTRACT.md that apply during setup:

- Exit `1` can come with **empty stdout**. Check that stdout has content before
  you parse it.
- `node src/cli.js --json status` is not the same command as
  `node src/cli.js status --json`. The first form treats `--json` as the stage
  name, prints the usage text to **stdout**, and exits `1`. Always write the
  stage first.

## Safety

Three commands destroy data. Never run one against a production store.

| Command | MCP tool | Gate |
|---|---|---|
| `seed --wipe-first` | `migration_seed` with `wipeFirst: true` | `confirm: true` (`--yes`). It deletes all WooCommerce and WordPress content on the source before it seeds. |
| `wipe --yes` | `wipe_shopify` | `confirm: true`. It also refuses any store that is not a Partner development store. There is no override. |
| `wipe --wp --yes` | `wipe_wordpress` | `confirm: true`. It also refuses once `data/raw/summary.json` exists for the active pair. A DanDomain pair is refused immediately (exit 2, `WP_WIPE_GATE`) — this tool never wipes a DanDomain shop. |

Run them only when the user explicitly asks for a reset (docs/MACHINE-CONTRACT.md, ground rule
1). Nothing else in the pipeline writes to WordPress: `export` is read-only on
the source.

## Optional — install the MCP server

`src/mcp-server.js` is a stdio JSON-RPC 2.0 server. It exposes 16 tools, which
wrap the same core the CLI's `--json` mode uses. It needs no install step beyond
`node`. It does **not** need `config/migration.config.json` to exist at startup,
so you can start it before Step 4 and use `sites_add` and `sites_activate` from
it.

The repository ships a `.mcp.json` for Claude Code:

```json
{
  "mcpServers": {
    "shoplift": {
      "command": "node",
      "args": [
        "${SHOPLIFT_HOME:-.}/src/mcp-server.js",
        "--config",
        "${SHOPLIFT_HOME:-.}/config/migration.config.json"
      ]
    }
  }
}
```

**Set `SHOPLIFT_HOME` to the absolute path of your clone** before you start the
client, for example `SHOPLIFT_HOME=/home/me/shoplift`. Claude Code expands
`${VAR}` and `${VAR:-default}` in `command` and `args`. The `.` fallback works
only when the client starts the server with the repository root as the working
directory. An absolute `SHOPLIFT_HOME` always works. If your client does not
expand environment variables (Cursor is in this group), replace both
`${SHOPLIFT_HOME:-.}` occurrences with the **absolute** path of your clone —
for example `D:\\wordpress-to-shopify\\src\\mcp-server.js` and
`D:\\wordpress-to-shopify\\config\\migration.config.json`. Relative paths
break when the client's working directory is not the clone.

For other MCP clients, and for the full tool contract, see docs/MACHINE-CONTRACT.md, section
"Installing as an MCP server". An LLM in Cursor calls `GetMcpTools` then
`CallMcpTool` (do not invent schemas). Long stages use `async: true` and poll
`migration_job_status` (docs/MACHINE-CONTRACT.md, "Async jobs") — do not copy that chapter here.
