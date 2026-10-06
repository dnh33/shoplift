---
name: shoplift-operator
description: Operate the SHOPLIFT WooCommerce→Shopify migration pipeline. Use when the user asks to migrate a WordPress/WooCommerce store to Shopify, run/resume/verify a migration, seed test shops, check migration status, or wipe a test store. Requires the shoplift repo (cli.js) on disk.
---

# SHOPLIFT operator

You drive a real migration tool with a machine interface. Read `docs/MACHINE-CONTRACT.md` in the
repo root FIRST — it is the authoritative contract (envelopes, exit codes, rules).

## Quick reference

- Locate the repo (contains `src/cli.js` and `docs/MACHINE-CONTRACT.md`). All commands run from its root.
- First command, always: `node src/cli.js status --json` → parse the (single) stdout line.
- The stage name must come first: `<stage> --json`, never `--json <stage>` — a flag
  placed before the stage is consumed as the stage name and you get USAGE text on
  stdout instead of an envelope.
- The envelope (full shape, `docs/MACHINE-CONTRACT.md`'s "The machine contract" is canonical):
  `{ tool, v, command, ok, exit, elapsedS?, data, error: { code, message, hint } | null }`.
  Branch on `exit`.
  A crash before the envelope is written can leave stdout empty even at exit 1 —
  check for output before parsing it.
- Full pipeline: `node src/cli.js all --json` (one envelope; order import can take
  15+ min — that is Shopify's ~4-5/min creation rate limit, not a hang; progress
  goes to stderr).
- NEVER wipe anything unless the user explicitly asked. Wipes need `--yes` (no
  interactive fallback in `--json` mode) and refuse production Shopify stores by
  design. The wipe envelope's `command` field is `wipe_shopify` or `wipe_wordpress`,
  never `"wipe"`.
- After `transform --json`, relay `data.actions` verbatim (always carries the full
  `message` text). After `verify --json`, relay `data.failures` (and `data.counts`)
  verbatim. `status --json`/MCP `migration_status` carries the punch list at
  `data.warnings.actions` too, but **without `message` by default** — only
  `entity`/`id`/`code`/`severity` — since status is the "run this first" tool and a
  real store's full action text can run ~4KB per call. Pass `verbose: true` (MCP)
  when you need the human-readable text from `status` itself; the three commands
  use different key paths regardless, don't assume one shape across all of them.
- `sites` has no `--json` surface (`sites --json` exits 2, USAGE). Edit
  `config/sites.json` directly, or use the `sites_list`/`sites_activate` MCP tools
  (`node src/mcp-server.js`, bin: `shoplift-mcp`).
- `--config <path>` targets a specific config file instead of the active pair's
  default (`config/migration.config.json`) — useful for driving multiple
  source→target pairs without switching the single active pair each time.
- **MCP clients: use async jobs for anything that might run long.** MCP
  clients have been observed abandoning a `tools/call` request (`-32001`)
  after ~60s and closing stdin — the server keeps working and finishes
  correctly, but the result is lost if you were waiting synchronously.
  `migration_all`, `migration_import`, `migration_seed`, `wipe_shopify`, and
  `wipe_wordpress` accept `async: true`: it returns `{ jobId, status:
  "running" }` immediately instead of blocking. Poll `migration_job_status
  { jobId }` every few seconds; once `status` is `"done"` or `"failed"`, the
  response carries the full envelope the synchronous call would have
  returned at `data.envelope` — read it exactly like a normal response.
  `migration_job_list` (no args) shows all known jobs. Full contract in
  `docs/MACHINE-CONTRACT.md`'s "Async jobs" section.
- **MCP tool results carry TWO content blocks — parse the right one.**
  `content[0]` is a short markdown status line for the human (e.g.
  `✅ import — 14m 0s` / counts, or `❌ transform — exit 2 · CODE` + message) —
  never parse it for control flow, its wording isn't a contract. `content[1]`
  is the same JSON envelope documented above — that's what you parse, or read
  `structuredContent` on the result (the identical envelope as a real object,
  no `JSON.parse` needed). Both blocks are always present, success or error.
  If you declared `capabilities: { logging: {} }` at `initialize`, you'll also
  get live `notifications/message` frames streaming stage progress during a
  long call (and `notifications/progress` heartbeats carry a real `total` for
  `migration_import` once one is knowable) — full detail in docs/MACHINE-CONTRACT.md's
  "Transparency" section.

## Failure playbook

| exit | meaning | your move |
|---|---|---|
| 1 | crash before an envelope was written | stdout may be EMPTY — read stderr; re-run with `--verbose` |
| 2 | usage/config/gate | fix flags/config; read `error.hint` |
| 3 | connection/auth/PCD | run `doctor --json`, relay `error.hint` (PCD has a settings path, PLAYBOOK §3.3) |
| 4 | partial import | re-run the same import later; failures ledger names the rest |
| 5 | verify failed | show `data.counts` + `data.dirtyTarget`/`data.staleTarget` to the user |
