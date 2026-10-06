# SHOPLIFT machine contract: operating SHOPLIFT as an AI agent

SHOPLIFT migrates WooCommerce/WordPress stores to Shopify. You (the agent) drive it
through the machine interface; humans use the TTY menu. Everything below is the
contract you can rely on — verified against the shipped code, not the plan.

**Not configured yet? Read [SETUP.md](SETUP.md) first.** It is the file-based,
no-TTY cold start: `.env`, `sites_add`, `sites_activate`, `doctor`, and the
verification checklist to clear before you touch a real store. This file assumes
setup is already done. New machine or DanDomain client pair: SETUP.md
“New machine” and “DanDomain client pair (LLM)”, then this file’s machine contract.

## The machine contract

Every command: `node src/cli.js <stage> --json [flags]`

**Flag order is load-bearing.** The stage name MUST be `argv[2]` — the very next
token after `cli.js`. Flags are only read from `argv[3]` onward. Put `--json` (or
any flag) before the stage and it is silently consumed AS the stage name instead:
`node src/cli.js --json status` exits `1` and dumps the full USAGE text to
**stdout** — outside the machine contract entirely, no envelope, nothing to parse.
Always write `<stage> --json`, never `--json <stage>`.

- stdout: exactly one JSON envelope per command, one line, then the process exits.
  This is true for `all` too — one envelope, with per-stage results nested under
  `data` (there is no JSONL/multi-line mode for any command).
- `--config <path>`: use a specific config file instead of the default
  `config/migration.config.json`, resolved from the agent's own cwd (ARCHITECTURE.md
  invariant #7 — the one exception to package-relative paths). Lets an agent drive
  several source→target pairs by config path instead of switching the single active
  pair with `sites_activate`.
- stderr: human prose — never parse it.
- Envelope: `{ tool:"shoplift", v:1, command, ok, exit, elapsedS?, data, error }`
  where `error` is `null` or `{ code, message, hint }`.
- `command` echoes what the caller invoked **on this surface** — it is not a
  fixed, cross-surface name. On the CLI it is the stage name (`transform`); on
  MCP it is the tool name (`migration_transform`). The same underlying
  operation therefore reports a different `command` string depending on which
  transport called it — correlate a response to the request you sent, not to
  the other transport's name for the same thing.
- `elapsedS` keeps one decimal for durations ≥ 1s, but three decimals for
  sub-second calls (e.g. `0.042`) — a fast call reads as fast, never as `0`.
- Exit codes (branch on these, not on text):
  `0` OK · `1` unexpected crash · `2` usage/config/gate (incl. missing confirm)
  · `3` connection/auth (incl. PCD_NOT_APPROVED) · `4` partial import failures
  · `5` verify failed (dirty/stale/spot-check).
- **Exit `1` can mean an EMPTY stdout.** If something throws before the envelope is
  written, the outer handler prints to stderr and exits 1 with nothing on stdout.
  `api.js` itself never throws (everything is caught and turned into an envelope),
  so this is rare — but don't assume stdout is non-empty just because the process
  ran; check for output before you parse it.
- On Windows, a native crash during a network-error `verify` has been observed to
  yield exit `127` instead of the documented `5` — pre-existing, platform-specific,
  not part of the exit-code contract above.

## Commands

12 commands have a machine (`--json`) surface. The bare `sites` command does not —
it is the interactive profile manager, TTY only. Its agent-drivable equivalents
are the three `sites-*` commands below (also reachable as MCP tools). In `--json`
mode the CLI accepts the underscore spelling too, so `sites_add` and `sites-add`
are the same command.

| Command | What it does | Notes |
|---|---|---|
| `status --json` | Aggregate state: counts, ledger, verify verdict, ACTION warnings | Run this FIRST, always — `data.warnings.actions` entries carry `entity`/`id`/`code`/`severity` by default; the CLI has no flag to request the full `message` text on this surface (transform's `data.actions` still carries it, see rule 4) |
| `doctor --json` | Connection checks WP + Woo + Shopify | exit 3 on any failure |
| `export --json` | WP → data/raw/ | read-only on the source |
| `transform --json` | raw → Shopify inputs + warnings | offline, deterministic, re-runnable |
| `import --json [--entities a,b] [--dry-run]` | push to Shopify | resumable; exit 4 = partial, re-run to retry failures |
| `verify --json` | reconcile counts + spot checks | exit 5 = investigate data.counts |
| `all --json` | export→transform→import→verify | single envelope; data = per-stage results (not JSONL). A stage that did not run is `null` — with `--dry-run`, `data.verify` is `null` by design (verifying an import that wrote nothing would report a false failure) |
| `seed --json --tier light\|medium\|heavy\|real\|real-xl\|dd-light\|dd-medium\|dd-heavy\|dd-real\|dd-real-xl [--wipe-first --yes]` | fabricate test data on the source | WP tiers: `real` and `real-xl` are standalone: use `--wipe-first`. `real-xl` is a superset of `real` (~350 products incl. one with 120+ variants, plus unicode/oversize/price/HTML/media probes) and imports slower. `--wipe-first` DELETES ALL WP content first and requires `--yes` (same gate as `wipe --wp`). DanDomain source (`adapter`/`kind` dandomain): `dd-light` / `dd-medium` / `dd-heavy` / `dd-real` / `dd-real-xl` (idempotent SOAP upserts; omit `--wipe-first`). `dd-real` and `dd-real-xl` are standalone. `dd-real` is the messy Example Hostedshop; `dd-real-xl` is that shop plus scale (120-variant yarn probe). Same command; the active config picks the seeder. |
| `wipe --json --yes` | DELETE ALL on the Shopify target | envelope `command` is `wipe_shopify`; refuses non-dev stores (exit 2, WIPE_GATE); `--yes` is required in machine mode — there is no interactive fallback |
| `wipe --wp --json --yes` | DELETE ALL on the WP SOURCE | envelope `command` is `wipe_wordpress`; test sites only — refuses (exit 2, `WP_WIPE_GATE`) once `data/raw/summary.json` exists for the active pair; the only override is `source.allowDestructive: true` in the config file. A DanDomain pair is refused immediately (same code; message names DanDomain — this tool never wipes a DanDomain shop) |
| `sites-add --json --kind wordpress\|shopify\|dandomain [--name n] [--base-url u] [--shop s] [--tenant t] [--storefront-url u] [--shop-id id] [--overwrite]` | register a profile in `config/sites.json` | envelope `command` is `sites_add`; credential fields default to `${ENV_VAR}` refs — the CLI has NO credential flags (argv leaks to the process list); pass literal secrets only via the MCP tool, or put values in `.env`. `--kind dandomain` needs `--tenant` or `--storefront-url` (each derives the other; `--shop-id` defaults to the tenant). Refuses an existing name unless `--overwrite` (exit 2). Omitted `--name` derives from the host's first label (`www.x.com` → `www`) — always pass it. SETUP.md §Step 3 |
| `sites-activate --json --source a --target b` | activate a pair | GENERATES `config/migration.config.json`; each pair keeps its data dir (`data/<a>__<b>`) forever. A dandomain source generates the dandomain config form (`pageBase: "detect"`, `wpContent.enabled: false`); `source.allowDestructive` is never generated and a hand-added one is dropped on re-activation |
| `sites-list --json` | registered profiles, pairs, active pair | local, no network |
| `sites` (no --json) | interactive profile manager | `sites --json` returns exit 2 USAGE today — use `sites-list`/`sites-add`/`sites-activate` instead |

`--adapter` exists as a flag but only takes effect on the human (non-`--json`) code
path — under `--json` it is rejected (exit 2, `USAGE`). Set the adapter via
`source.adapter` in the config file when driving the tool in machine mode.

`--entities` (CLI: `--entities a,b,c`; MCP/api: `entities: ["a","b"]`) filters
which of the 8 configured entities a command touches. Omitted/`undefined` means
"all entities configured `true` in the config file" (the default, unchanged).
`entities: []` — an explicit empty array — means "run nothing": the command
still exits 0 but every count is zero. This is a deliberate behavior, not the
same as omitting the field; do not pass `[]` unless you mean a no-op. An
unknown entity name anywhere in the array is rejected as `CONFIG_MISSING`
(exit 2), never silently dropped or escalated to "everything".

## Ground rules

1. NEVER run `wipe` (either side) unless the user explicitly asked for a reset.
2. `import` is idempotent (ledger + upserts + existence checks). A failed or
   interrupted run is RESUMED by re-running the same command — never "cleaned up" first.
3. Order imports are slow by design: Shopify's order-creation limit is ~4–5/min on
   dev stores. 50 orders ≈ 12–15 min. Do not add your own retry loop on top —
   the importer already defers and retries.
4. `transform` warnings are the product: `action` = human must decide,
   `handled` = tool already fixed it, `info` = platform fact to relay once.
   Read the punch list from `status --json` → `data.warnings.actions`
   (`entity`/`id`/`code`/`severity` only by default — a real store's action
   list runs ~4KB of prose you pay on every status call otherwise). Get the
   human-readable `message` text either from `transform --json` →
   `data.actions` (always full), or from MCP `migration_status` with
   `verbose: true`.
5. Customers/orders need Protected Customer Data approval on the app
   (exit 3, `PCD_NOT_APPROVED`, hint carries the fix). PLAYBOOK §3.3.
6. State lives under the pair's data dir (`data/…`): `raw/`, `transformed/`,
   `state/idmap.json` (the ledger), `state/failed-*.jsonl`, `verify-report.json`.
   Prefer `status --json` over reading files.

## Recipes

Fresh migration:
`doctor --json` → `export --json` → `transform --json` (its own `data.actions`
lists the same punch list, but `status --json` is the canonical read) →
`status --json` → review `data.warnings.actions` with the user →
`import --json --entities products,collections` → `import --json` (rest) →
`verify --json` → hand over the action list.

Rehearsal on a test pair: `wipe --json --yes` → `seed --json --tier real --wipe-first --yes`
→ `all --json` → `verify --json` (expect exit 0 with the seeded action items present).

Resume after crash/rate-limit: just re-run the same `import --json`; exit 4 →
re-run again later; the failed ledger names what's left.

## MCP

`src/mcp-server.js` speaks stdio JSON-RPC 2.0 (`node src/mcp-server.js [--config
path]`, bin: `shoplift-mcp`) and exposes these 16 tools, wrapping the same
`api.js` core the CLI's `--json` mode uses:

`migration_status`, `migration_doctor`, `migration_export`, `migration_transform`,
`migration_import`, `migration_verify`, `migration_all`, `migration_seed`,
`wipe_shopify`, `wipe_wordpress`, `sites_list`, `sites_activate`, `sites_add`,
`migration_job_status`, `migration_job_list`, `dandomain_probe`.

The naming is not uniformly prefixed: the eight non-destructive/aggregate commands
take `migration_`, the two wipe tools take `wipe_`, the three site-profile tools
take `sites_`, the two job tools take `migration_job_`, and the DanDomain
source investigation gets `dandomain_probe` (see docs/PLAYBOOK-dandomain.md; it
spawns `scripts/probe-dandomain.mjs` and needs `write:true`+`confirm:true` for
the probes that create scratch data on the source shop). The server does not
need `config/migration.config.json` to exist at startup, so `sites_add` and
`sites_activate` work over MCP on a cold clone (SETUP.md). The two `wipe_*` tools
require `confirm: true`, mirroring `--yes` on the CLI. `migration_seed` also
requires `confirm: true` whenever `wipeFirst: true` is set — it wipes the WP
source the same way `wipe_wordpress` does, and is gated identically. Both
transports return the same envelope shape (see "The machine contract" above:
`{ tool, v, command, ok, exit, elapsedS?, data, error }`) since both call into
`api.js` — pick whichever fits the agent runtime: the CLI (`node src/cli.js
<stage> --json`, documented above) for a subprocess-per-command model, the MCP
server for a persistent stdio session.

### Async jobs — avoiding client request timeouts

**Why this exists:** live testing found MCP clients (observed: Claude Desktop)
abandon a `tools/call` request after ~60s with error `-32001`, then close
stdin. The server keeps working and the stage completes correctly — the
client just stops listening, so the result envelope is silently discarded.
`migration_all` can run 15+ minutes (Shopify caps order creation at ~4-5/min
on dev stores); `migration_import`, `migration_seed`, and both wipes routinely
exceed 60s too. A `notifications/progress` heartbeat exists for clients that
opt in via `_meta.progressToken`, but it cannot fix a client that never sends
one — the async job pattern below is the fix that works regardless of client
behavior.

Eight tools that do real work against a live system accept an `async: true`
argument: `migration_export`, `migration_transform`, `migration_import`,
`migration_verify`, `migration_all`, `migration_seed`, `wipe_shopify`,
`wipe_wordpress`. (`migration_status`, `migration_doctor`, `sites_list`,
`sites_activate`, `sites_add` stay synchronous-only — they're local/fast or a
bounded network round-trip, not a multi-minute stage.)

- `async` absent or `false` → identical behavior to today: the call blocks
  until the stage finishes and returns the normal envelope.
- `async: true` → returns immediately with `{ jobId, status: "running", tool,
  startedAt }` in the standard envelope (`ok: true, exit: 0`). The work
  continues in the background, serialized exactly like a synchronous call
  (ground rule 2/invariant #1 — the ledger is still never touched by two
  concurrent writers).
- Poll `migration_job_status { jobId }` every few seconds. While running it
  reports `{ status: "running", ... }`; once finished (`status` is `"done"`
  or `"failed"`) it ALSO hoists `data.ok`/`data.exit` — the same `ok`/`exit`
  the synchronous call's envelope would carry — straight onto `data`, so you
  can branch (`if (!data.ok)`) without descending into `data.envelope` first.
  `data.envelope` still carries the **full envelope the synchronous call
  would have returned**, unchanged — read `data.envelope.data` /
  `data.envelope.error` for the actual result. `data.status: "failed"` (and
  the separate `data.error` string) means the call threw unexpectedly past
  `api.js`'s own error handling — a stage that finished with a non-zero exit
  (e.g. 4 PARTIAL, 5 VERIFY) is still `status: "done"`, `data.error: null`,
  with the real outcome in `data.envelope`/`data.exit`. Job-level failure
  (`data.error`) and command-level non-zero exit (`data.exit`) are two
  different axes — do not conflate them.
- `migration_job_status` on an unknown `jobId` returns exit 2 (`JOB_NOT_FOUND`),
  not a throw. `migration_job_list` (no args) lists known jobs — id, tool,
  status, startedAt, elapsedS, newest first — completed jobs stay queryable
  for the life of the process (capped at the most recent 100).
- The `confirm: true` gate on both wipes (and on `migration_seed` with
  `wipeFirst: true`) is checked **before** a job is created — a rejected gate
  always fails synchronously on the original request with `CONFIRM_REQUIRED`,
  never as a background job that immediately "fails."
- Two async jobs queued back to back run one after the other, never
  concurrently — starting a job never creates a second concurrent writer
  against `state/idmap.json`.

**Recommended operating procedure:** use `async: true` for `migration_all`,
`migration_import`, `migration_seed`, and the two wipes — these are the tools
most likely to outlive a client's request timeout. Poll `migration_job_status`
every few seconds until `status` is `"done"` or `"failed"`, then read the
result the same way you would a synchronous call's envelope. `migration_export`,
`migration_transform`, and `migration_verify` support `async: true` too but
are usually fast enough that the synchronous call is simpler.

### Transparency — two content blocks, structured content, live log/progress

**2026-07-28**: every `tools/call` result now carries **two** `content` blocks,
plus `structuredContent`, so an MCP client can render a long-running migration
instead of showing nothing for 14 minutes then dumping raw JSON:

- `content[0]` — a short markdown status line (`annotations.audience:["user"]`).
  Human-facing only: `✅ import — 14m 0s` / counts / `0 failed`, or on failure
  `❌ transform — exit 2 · CONFIG_MISSING` + the message. **Do not parse this
  for control flow** — its wording is not a stable contract.
- `content[1]` — the same JSON envelope this section has always documented
  (`annotations.audience:["assistant"]`), unchanged in shape, just one index
  later than before. **This is what an agent parses.**
- `structuredContent` — the identical envelope as a real object (not a
  string), deep-equal to `JSON.parse(content[1].text)`. Prefer this over
  parsing `content[1].text` yourself when your client surfaces it — same
  data, no `JSON.parse` needed. Every tool also declares `outputSchema`
  describing the envelope's outer shape (`tool`/`v`/`command`/`ok`/`exit`/
  `elapsedS`/`data`/`error`) — `data`'s inner shape still depends on which
  tool ran and whether it succeeded, see that tool's own description.

Both blocks are always present, on every path including errors — never
conditional. Older clients that only read `content[0].text` as "the" result
will see the summary line, not JSON; clients that don't know about
`structuredContent` at all are unaffected (additive field).

**Live log stream (opt-in).** The server declares the `logging` capability
and emits stage prose as `notifications/message` (RFC 5424 levels — stage
`console.log` → `info`, `console.warn` → `warning`), the same prose a human
running this directly sees on stderr, mirrored so an MCP client can show it
live. Since the MCP spec defines no formal client-side "I want logs"
capability, this server's opt-in signal is a `logging` key in the client's
own `capabilities` object at `initialize` (e.g. `capabilities: { logging: {}
}`) — a client that doesn't send this gets zero notifications (today's
behavior, unaffected). Send `logging/setLevel { level }` (any RFC 5424 level)
to raise/lower verbosity; default is `info`. Each notification's `logger`
field names the MCP tool that produced it.

**Progress with a real total.** `notifications/progress` heartbeats (see
above) now carry `total` in addition to `progress` for `migration_import`
specifically — `total` is the entity count `transform` already wrote to
`data/transformed/summary.json`, `progress` is how many have landed in
`state/idmap.json` so far (read-only; `redirects` isn't counted here — its
ledger doesn't keep one entry per redirect). Every other tool keeps the
original elapsed-seconds-only heartbeat, with `total` simply absent — never
fabricated.

## Installing as an MCP server

`src/mcp-server.js` is a stdio JSON-RPC 2.0 server — it works with any MCP
client that supports a stdio transport (Claude Code, OpenCode, Claude Desktop,
and others), not just Claude Code. The client launches it as a child process
and talks newline-delimited JSON-RPC over its stdin/stdout; there is no HTTP
port and no install step beyond having `node` (zero runtime dependencies).

Standard config block — both paths must be absolute (the server does not
resolve anything relative to a shell's cwd):

```json
{
  "mcpServers": {
    "shoplift": {
      "command": "node",
      "args": ["/absolute/path/to/shoplift/src/mcp-server.js", "--config", "/absolute/path/to/shoplift/config/migration.config.json"]
    }
  }
}
```

Where that JSON goes depends on the client:

- **Claude Code**: project-scoped MCP servers live in a `.mcp.json` file at
  the project root (same shape as above), or register one with
  `claude mcp add shoplift -- node /absolute/path/to/src/mcp-server.js --config /absolute/path/to/config/migration.config.json`.
  The exact `claude mcp` flags (scope, project vs. user) have shifted across
  releases — run `claude mcp --help` to confirm the current ones rather than
  trusting this text blindly.
- **Any other MCP client** (OpenCode, Claude Desktop, etc.): the `mcpServers`
  block above is the de facto standard shape most clients expect; the config
  file's *location* is client-specific — check that client's own docs. The
  block itself does not change.

The server negotiates `protocolVersion` per the MCP spec: it echoes back
whatever the client requested if that version is one of `2025-06-18` /
`2025-03-26` / `2024-11-05`, and otherwise replies with `2025-06-18` (its
newest supported). Its actual surface — `tools/list` + `tools/call` returning
`content[].text` — is simple enough to be genuinely version-agnostic across
that range.

Do not install or register this yourself on the operator's behalf — this
section documents the config shape; the operator wires it into their own
client.
