# Security

SHOPLIFT moves customer and order data between WordPress, DanDomain and Shopify
stores, and it holds credentials for them while it runs. Treat every run as
production access to someone else's business.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of this
repository, choose **Report a vulnerability**, and describe the problem there.
Do not open a public issue for a security problem, and do not include live
credentials or customer data in the report. Describe the exposure; do not
demonstrate it with real values.

## What the tool holds

Credentials live only in your local `.env` file (and in the gitignored files under
`config/`). Nothing is sent anywhere except the stores you configure.

| Secret | Where it lives | Committed? |
|---|---|---|
| WooCommerce consumer key/secret | `.env` | No, gitignored |
| WP application password | `.env` | No, gitignored |
| DanDomain SOAP / FTP credentials | `.env` | No, gitignored |
| Shopify client ID/secret (or legacy `shpat_` token) | `.env` | No, gitignored |
| Store URLs and pair registry | `config/sites.json` | No, gitignored |
| Active runtime config | `config/migration.config.json` | No, gitignored |
| Exported customer/order data | `data/<source>__<target>/` | No, gitignored |

`config/sites.json` and `config/migration.config.json` reference secrets as
`${ENV_VAR}` rather than storing them inline. Nothing enforces this automatically.
`.gitignore` is the only guard, so check `git status` before committing.

Shopify access tokens minted through the client credentials grant are **offline
tokens valid for 24 hours**; the pipeline refreshes them mid-run and never
persists them to disk.

## Operating rules

- **Nothing writes to the source store.** The source install stays intact so any
  migration can be rolled back by pointing DNS back. Scripts under `scripts/`
  that seed test data are the deliberate exception and are for dev stores only.
- **`wipe` refuses non-dev stores unconditionally.** There is no override flag,
  by design (ARCHITECTURE.md invariant #4).
- **Least privilege.** The app needs exactly the scopes in `.env.example`.
  Read-only WooCommerce keys are enough for export.
- **Protected Customer Data.** Importing customers and orders requires approved
  PCD access on the Shopify app. The `doctor` stage probes for it before any
  import runs, because mutations still execute when responses are redacted.
- **Rotate after a migration.** When a migration finishes, revoke the
  WooCommerce keys and the WP application password, and uninstall the Shopify
  app from the store.

## Known accepted risks

Documented in ARCHITECTURE.md, section "Known trade-offs":

- Credentials sit in plaintext in gitignored files. Run SHOPLIFT on a machine you
  control and protect that machine accordingly.
- `fetchRetry` retries POSTs on 5xx and can therefore double-send. This is made
  safe by idempotency (invariant #1) rather than by not retrying.
