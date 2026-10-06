# Architecture

How SHOPLIFT is put together, the invariants that keep it reliable, and where to extend it. Verified against the dependency graph (48 modules, zero cycles, zero layering violations).

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  ENTRY        cli.js (stages + flags + --json)  menu.js (TUI)│
│               mcp-server.js (stdio JSON-RPC)  api.js (core)  │
├──────────────────────────────────────────────────────────────┤
│  ORCHESTRATION  stages/export · transform/index ·            │
│                 import/index · stages/{verify,doctor,wipe}   │
│                 seed.js (tiered test data)                   │
├──────────────────────────────────────────────────────────────┤
│  ADAPTERS/API   sources/* (WP-side)   shopify/* (client,     │
│                 mutations, bulk)      wp-bootstrap.js        │
├──────────────────────────────────────────────────────────────┤
│  FOUNDATION     util/* · ui.js · log.js · locales.js ·       │
│                 config.js · sites.js · paths.js              │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point downward only. `ui.js` is safe at every layer because it degrades to plain text when stdout isn't a TTY.

## The pipeline: staged, file-mediated

Stages communicate exclusively through files under the pair's data dir — never in memory. Any stage can be re-run, inspected, or diffed independently.

```
EXPORT ──▶ data/raw/*.jsonl + summary.json      (raw WP snapshots, read-only source)
TRANSFORM ─▶ data/transformed/*.jsonl|json|csv   (Shopify GraphQL inputs + warnings.jsonl)   [pure, offline]
IMPORT ──▶ Shopify + data/state/idmap.json       (id-ledger) + failed-*.jsonl + import-report.json
VERIFY ──▶ data/verify-report.json               (counts, spot-checks, roll-ups)
```

Contracts: transform is deterministic and network-free; everything questionable becomes a line in `warnings.jsonl` (operator-facing, always English) rather than a silent decision. Merchant-facing generated text is localized via `locales.js` (`options.locale`).

## Invariants (do not break these)

1. **Idempotent imports.** Every importer must survive re-runs without duplicating: products/customers upsert (`productSet`/`customerSet`), orders use ledger + existence-check-by-tag, discounts check for duplicates, content checks handles, redirects keep an import ledger. Reason: HTTP retries and redacted responses (PCD) make "did it apply?" ambiguous — see the duplicate-order incident in PLAYBOOK §3.
2. **GraphQL only, one version pin.** All documents live in `shopify/mutations.js`, pinned via `shopify.apiVersion`. Quarterly bump = check that one file (shopify.dev reference pages serve markdown at URL + `.txt`).
3. **Rate limits are learned, not hardcoded.** The client paces from `extensions.cost.throttleStatus`; order import additionally handles `orderCreate`'s separate creation limit with a deferred-retry queue. Plan-dependent numbers never appear in code.
4. **Destructive operations gate on store class.** `wipe` refuses non-dev Shopify stores unconditionally — no override flag exists, by design. The WordPress source side has the same shape: `wipeWordPress` (`seed.js`) refuses once `data/raw/summary.json` exists for the active pair (this source has been exported from — it's a migration source, not a scratch shop). The only override is an explicit `source.allowDestructive: true` in the config file — no CLI flag, no env var, mirroring the Shopify gate's no-override design exactly.
5. **PCD pre-flight before customers/orders.** Mutations execute even when responses are redacted; importing without the probe risks silent duplicates.
6. **Zero runtime dependencies, Node ≥ 20.** Native fetch, readline, ANSI. New capabilities must justify breaking this.
7. **cwd-independence.** Package-relative paths come from `paths.js` (`PKG_ROOT`); only explicit `--config` arguments resolve from the user's cwd. `data` dirs resolve relative to the config file.
8. **Non-TTY degradation.** Everything (colors, spinners, bars, boot, alt-screen, pauses) no-ops or goes plain when piped — scripting and CI see clean logs. Interactive-only affordances must check `isTTY`.
9. **Interactive flows are drop-proof.** All menu/sites stdin goes through the queued prompter (`menu.js createPrompter`) because readline drops lines arriving between questions (pastes, pipes). Known exception: `wipe`'s standalone CLI confirmation is a single one-shot readline question (no follow-up prompt exists to lose input to); multi-question flows must never use raw readline.
10. **Machine mode owns stdout.** With `--json` (and always in the MCP server, which
    calls `machine.enable()` at startup) `console.log`/`console.warn` are rerouted to
    `console.error` at enable-time (`util/machine.js`), so all prose lands on stderr;
    TTY spinners/progress bars (`ui.js`) degrade to plain log lines instead of
    animating. stdout carries only the JSON envelope(s) agents parse. Exit codes are
    frozen: 0/1/2/3/4/5 = ok/crash/usage/connection/partial/verify-failed.

## State model

- `config/sites.json` — profile registry (WP sites, Shopify stores, pairs). Secrets allowed here or as `${ENV}` refs; gitignored.
- `config/migration.config.json` — the ACTIVE pair's runtime config, generated by `activatePair` or edited by the wizard; gitignored.
- `data/<source>__<target>/` — permanent per-pair workspace (registry remembers it forever; switching pairs never orphans a ledger).
- `data/state/idmap.json` — namespaced ledger (`products`, `variantsBySku`, `customers`, `orders`, `collections`, `blogs`, `articles`, `pages`, `discounts`, `redirects`). The single source of "already migrated."

## Extension points

- **New WP commerce plugin** → adapter in `sources/` normalizing to the WooCommerce shape; register in `sources/index.js` (see `edd.js`, ~100 lines).
- **New language** → entry in `locales.js` (notes, blog defaults, structural redirect paths).
- **New test tier** → add it to `TIERS` in `seed.js` (the single source of truth — `api.seed` validates against it and `test/run-mcp.js` asserts the MCP enum still matches). light/medium/heavy are cumulative + idempotent via sentinel SKUs. Standalone tiers assume a clean site and are listed in `STANDALONE_TIERS`, which is what the menu's wipe-first prompt reads: `real` (`seed-real.js`, a realistic Danish SMB shop with runtime probes) and `real-xl` (`seed-real-xl.js`, a strict superset — it calls `seedReal` then layers scale and quirk probes, so the superset relationship holds as `real` evolves).
- **New Shopify entity** → transform module (pure, warnings for anything lossy) + import module (idempotent, ledger-backed) + wire into `transform/index.js` / `import/index.js` dependency order.

## Testing model

`npm test` runs six offline suites, 1320 assertions total, no store needed: `test/run-fixtures.js` (132) — fixture adapter → export → transform, every mapping edge case and Shopify field limits; `test/run-import-sim.js` (71) — mock-Shopify import sim (retries, dedup, validation failures, persistent failures, ledgering, redirect skip semantics, P4/P6 flag-gated B2B/refunds/blog/gift/translations); `test/run-machine.js` (180) — `--json` envelopes, exit-code taxonomy, `collectStatus`, `api.js` core, stdout purity, the WP source-side wipe gate, site-profile registration (all three kinds incl. dandomain, with the generated-config byte-pin for the WP path), credential redaction, usage-vs-crash classification, all()'s dryRun stage-skip, the import report's dryRun marker and doctor's response-shape and .env-freshness checks, TTY menu source-aware seed/export copy; `test/run-mcp.js` (243) — the MCP server's JSON-RPC handshake, protocolVersion negotiation, tool listing, error framing, `--config` validation, close-mid-flight draining, async jobs, the log-notification stream, structured content, progress totals, call-recorder fidelity, credential redaction in the recorder, the human-readable summary block, and the seed-tier enum matching TIERS ∪ DD_TIERS; `test/run-dandomain.mjs` (630) — the DanDomain source client across twelve sub-suites (generated WSDL operations, the record-boundary XML parser, the SOAP session/fault/field-set/pagination client, the hand-rolled FTPS transport against a loopback mock, the GraphQL client's two query conventions, the `sources/dandomain.js` adapter driven end to end from recorded SOAP envelopes through the real transform, the R41/R39 URL grammar helpers, the STATUS open-items register, O14–O18/O15 resume/O16 batch/O17 date windows, fsx drain, seed gates, doctor-dandomain, P6 capability-close pins); `scripts/probe-dandomain.test.mjs` (64) — the probe kit's own pure core, the FTPS transport it was promoted from, and the page-base decision table. The last two joined `npm test` on 2026-08-16; they had been runnable-but-unrun, which is the state a suite rots in. Live behavior is validated against a disposable WooCommerce staging site paired with a Shopify development store (the source is rebuilt whenever the staging host lapses); `seed --tier` fabricates light/medium/heavy/real/real-xl datasets, `wipe` resets the target, `scripts/run-real-tier-live.mjs` runs the full real-tier verification matrix unattended. Anything discovered live that docs didn't say gets written into PLAYBOOK §9.

## Known trade-offs (accepted deliberately)

- `menu.js` is large (~550 lines) — it's the composition root for all interactive flows; splitting it would scatter the prompt/pause/screen lifecycle that must stay consistent.
- Plaintext credentials in gitignored files — acceptable when you run the tool on a machine you control; revisit if that stops being true.
- `fetchRetry` retries POSTs on 5xx, which can double-send — made safe by invariant #1 rather than by never retrying.
- Bulk path is used for products only; customers bulk exists but small sets run per-call for better error locality.

## Not built, deliberately (scope, not defects)

These are **untested scope**, not outstanding bugs. Recording them here so the
question "is it done?" has a definite answer: for the tested scope, yes. This
list is what would have to change for that scope to grow. Do not treat an item
here as a defect, and do not re-open them speculatively — each has a trigger.

| Not built | Why not | Trigger to build it |
|---|---|---|
| Plugin data migration (WPML, Subscriptions, Bundles, Memberships, gift cards) | The important ones are commercial: not installable from the .org repo, each with its own data model. Free lookalikes would manufacture confidence rather than earn it. `doctor` detects and declares them instead (`sources/plugin-risks.js`) | A real client store whose actual plugin list defines the work |
| A 10k+ product / 50k order live scale tier | Orders are the hard ceiling: dev stores accept ~4–5/min, so 50k orders is ~7 days of wall clock. 10k products needs local WP; free hosts choke. The scale risks worth guarding are cheaper to catch offline — that is how the O(n²) ledger writes were found | A client catalogue big enough that the offline bounds stop being convincing |
| Streaming `readJsonl` | It loads whole files into memory as parsed objects. Real but never observed biting; fixing it properly means choosing streaming vs. a documented ceiling with a warning | A measured OOM, or a catalogue where the offline bound is exceeded |
| Images in the seed | Only 1 of 348 seeded products carries an image, so the media path has near-zero live coverage. But the mapping is nearly pass-through (`originalSource: img.src`; Shopify fetches), so there is little of ours to get wrong | Wanting real confidence in media before a client go-live |
| `failed` counter on `importCollections` | It is the only importer without one, and it does not increment `imported` when it adopts an existing collection by handle — so "already existed" and "failed to create" both just make the count come up short. Never observed firing | The first time a collection create actually fails |

The ledger's write cost is **improved, not solved**: batching cut it ~13× but it
is still O(n²) (whole-file rewrite). Measured comfortable to ~50k records.

### If one plugin integration ever gets built, build Redirection first

Of everything in the table above, importing **Redirection**'s rules is the only
plugin integration that is both high-value and fully verifiable, so it does not
belong in the same bucket as WPML:

- **Free and .org-hosted, 2,000,000 active installs** (confirmed against the .org
  plugin API). `POST /wp/v2/plugins {slug:"redirection"}` can install it on a test
  site, so unlike the commercial plugins the mapping can be *proven* rather than
  approximated against a free lookalike.
- It exposes `GET /wp-json/redirection/v1/redirect` plus a CSV export endpoint,
  and the existing WooCommerce application password already carries the capability.
- **The data can already get in today.** `redirects.csv` is the importer's input
  and Redirection exports CSV — so this is automation plus safety warnings, not a
  missing capability. That is why `doctor` says "export them and merge into
  redirects.csv" rather than "unsupported".

Maps cleanly: enabled rules with a plain-path source, a URL target, and a 301.
Everything below needs a warning rather than silent loss:

| Redirection feature | Why it cannot map |
|---|---|
| regex sources | Shopify redirects are exact-path only and regex cannot be expanded — and a real share of accumulated rules are regex |
| `410` / `404` "gone" actions | no Shopify equivalent |
| `302` / `307` | Shopify does 301 only, so the meaning changes |
| conditional matches (login state, role, referrer, user agent, cookie, IP) | Shopify has no concept of any of these |
| targets pointing at WP paths that moved | must be rewritten through the same handle map `transform/redirects.js` builds, or they 301 straight into a 404 |
| collisions with the ~385 derived rows | needs an explicit precedence rule |

Roughly a day done properly: a reader, the mapping with per-case warnings, merge
and precedence, fixtures, and a live run against seeded regex and 410 rules so the
warnings are actually exercised. **Trigger:** a real client store running it — its
rule set is what the regex and conditional warnings should be designed against.

Other redirect plugins (Rank Math, Yoast Premium, AIOSEO, Safe Redirect Manager)
each store rules differently and would each need their own reader. Redirection
alone covers the largest share, which is why it is the one worth doing first.
