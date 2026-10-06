# Contributing

This is the short version of what "done" means here.

## Setup

```bash
git clone https://github.com/dnh33/shoplift.git && cd shoplift
node --version   # must be >= 20
npm test         # offline suite — no store, no credentials, no install step
```

There is no `npm install`. Zero runtime dependencies is an invariant
(ARCHITECTURE.md #6) — `dependencies` in `package.json` stays empty.

For anything that talks to a store, copy `.env.example` → `.env`, then
`node src/cli.js sites` to register a WordPress + Shopify pair, and
`node src/cli.js doctor` to confirm all five connection checks (WordPress REST,
WooCommerce auth, Shopify auth, currency alignment, Protected Customer Data
access) before you run a stage.

## Read first

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — layers, the ten invariants, extension
  points. The invariants are not style preferences; each one exists because
  breaking it produced a real incident.
- **[PLAYBOOK.md](PLAYBOOK.md)** — what the operator actually does. If you change
  operator-facing behavior, §9 is where live findings get written down.

## Ground rules

1. **Idempotency is not optional.** Every importer must survive a re-run without
   duplicating. HTTP retries and PCD-redacted responses make "did it apply?"
   genuinely ambiguous, so the ledger (`data/state/idmap.json`) is the answer,
   not the API response.
2. **Never write to WordPress.** The source install is the rollback path. The
   `seed` stage and `scripts/` are the deliberate exception, dev stores only.
3. **Lossy decisions become warnings, not silence.** If a mapping has to drop or
   reshape something, emit a `warnings.jsonl` line. Operator-facing warnings are
   always English; merchant-facing generated text goes through `locales.js`.
4. **No new dependencies.** Native `fetch`, `readline`, ANSI. If you think you
   need one, that's an ARCHITECTURE.md discussion first.
5. **Everything degrades when piped.** Colors, spinners, bars, alt-screen — all
   no-op when stdout isn't a TTY, so CI and scripts see clean logs.

## Testing

```bash
npm test                          # offline suites, no store needed
node test/run-fixtures.js         # fixture adapter -> export -> transform, mapping edge cases, field limits (132)
node test/run-import-sim.js       # mock Shopify: idempotency, throttling, deferred retries, redirect skip, ledger write batching, P4/P6 flag-gated importers (71)
node test/run-machine.js          # --json envelopes, exit codes, stdout purity, wipe + sites gates, plugin data-loss scan, TTY menu seed/export copy (180)
node test/run-mcp.js              # MCP server: handshake, tools, async jobs, arg redaction, summaries, tier enum (243)
node test/run-dandomain.mjs       # DanDomain source: SOAP client, XML record parser, FTPS, GraphQL, generated operations, the sources/dandomain.js adapter, URL grammar (630)
node scripts/probe-dandomain.test.mjs  # probe kit's own core: envelopes, FTPS against a loopback mock, page-base decision table (64)
```

New mapping behavior needs a fixture assertion. New import behavior needs an
import-sim assertion. A live-only fix with no offline test is a fix that will
regress — if it genuinely can't be tested offline, say so in the PR and explain
why.

Live validation runs against a dev store: `seed --tier light|medium|heavy|real|real-xl`
fabricates a dataset, `wipe` resets the target, and
`scripts/run-real-tier-live.mjs` runs the full real-tier matrix unattended.

## Commits and PRs

Conventional-ish prefixes (`fix:`, `feat:`, `docs:`, `ci:`, `refactor:`) — keep
the subject under ~72 chars and say what changed, not what file you touched.

Branch off `main`, open a PR, fill in the template. The invariant checklist is
the part that matters; the rest is bookkeeping.

## What not to commit

`.env`, `config/sites.json`, `config/migration.config.json`, and anything under
`data/` or `data-test/` are gitignored. Client store names,
customer emails, and real order data must never appear in fixtures, tests, issue
bodies, or commit messages.
