/**
 * Machine mode — the agent-facing contract:
 *   stdout carries EXACTLY one JSON envelope per command, including `all`
 *   (per-stage results nested under `data` — no JSONL/multi-line mode);
 *   every piece of human prose is rerouted to stderr;
 *   exit codes are a frozen taxonomy agents can branch on without parsing.
 */
export const EXIT = { OK: 0, CRASH: 1, USAGE: 2, CONNECT: 3, PARTIAL: 4, VERIFY: 5 };

const state = { on: false };
export const machine = {
  get on() { return state.on; },
  enable() {
    if (state.on) return;
    state.on = true;
    // Stages and ui print prose via console.log/warn — reroute wholesale so
    // stdout purity is guaranteed by construction, not by auditing call sites.
    console.log = (...a) => console.error(...a);
    console.warn = (...a) => console.error(...a);
  }
};

// D4 (2026-07-28 live MCP test): a sub-second call rounded to one decimal
// reports elapsedS:0 — indistinguishable from a call whose duration was never
// measured at all. Keep one decimal above 1s (durations that size don't need
// millisecond precision), but give sub-second calls three decimals so a fast
// call reads as fast (0.042), never as zero. Still a number, never a string.
export function elapsedS(ms) {
  const s = ms / 1000;
  return Number(s.toFixed(s < 1 ? 3 : 1));
}

export function envelope(command, { ok, exit, data = null, error = null, t0 = null }) {
  return {
    tool: "shoplift", v: 1, command, ok, exit,
    ...(t0 ? { elapsedS: elapsedS(Date.now() - t0) } : {}),
    data, error
  };
}

export function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

/** Map an error to { code, exit, hint } an agent can branch on. Order matters. */
export function classifyError(e) {
  const m = String(e?.message || e);
  if (/NOT a development store/i.test(m))
    return { code: "WIPE_GATE", exit: EXIT.USAGE, hint: "wipe only runs against partner development stores; no override exists (invariant #4)." };
  if (/wipeWordPress refuses/i.test(m))
    return { code: "WP_WIPE_GATE", exit: EXIT.USAGE, hint: "source-side wipe refuses once data/raw/summary.json exists for the active pair (this looks like a real migration source, not a scratch shop). The only override is source.allowDestructive:true in the config file — no CLI flag, no env var." };
  if (/protected customer data|not approved to access/i.test(m))
    return { code: "PCD_NOT_APPROVED", exit: EXIT.CONNECT, hint: "Enable Protected customer data + Name/Address/Email/Phone fields in the app's API access settings, then re-run. PLAYBOOK §3.3." };
  if (/missing shopify config|missing config|ENOENT|no WP write credentials|--tier must be/i.test(m))
    return { code: "CONFIG_MISSING", exit: EXIT.USAGE, hint: "Cold start: copy config/migration.config.example.json to config/migration.config.json and fill it in, or register profiles with sites_add then activate them with sites_activate (SETUP.md). Otherwise check --config path, .env values and flags; `doctor --json` gives a per-system breakdown." };
  if (/\b401\b|\b403\b|login failed|invalid_client|unauthoriz|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|blocked-by-allowlist|too many requests/i.test(m))
    return { code: "CONNECTION", exit: EXIT.CONNECT, hint: "Network or auth problem — run `doctor --json`." };
  return { code: "UNEXPECTED", exit: EXIT.CRASH, hint: "Re-run with --verbose. Stages are resumable; re-running is safe (invariant #1)." };
}

/**
 * Compact "what kind of attention" line: `ZERO_PRICE 6, DIGITAL_FILES 3, +2 more`.
 *
 * Shared by verify's human output and the MCP verify summary so the two can't
 * drift into telling an operator and an agent different things — which is
 * exactly what happened before D15's follow-up: the CLI printed the action
 * count while the MCP summary said only "counts reconciled, spot-checks
 * passed". Codes and counts, never message text: the messages live in
 * migration_status and warnings.jsonl, and a second copy is a second thing to
 * keep true. Highest count first so the biggest pile is never the one elided.
 */
export function formatActionCodes(codes, max = 4) {
  const entries = Object.entries(codes || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return "";
  const shown = entries.slice(0, max).map(([code, n]) => `${code} ${n}`);
  const rest = entries.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}
