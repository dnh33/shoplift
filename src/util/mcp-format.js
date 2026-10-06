/**
 * T3 — human-readable one-glance summaries for MCP tool results.
 *
 * Pure function of (toolName, envelope) -> markdown string. No I/O, no
 * console output (it must never itself become another log line — see the
 * feedback-loop guard in mcp-server.js). Never throws: a shape it doesn't
 * recognize falls through to the generic one-liner rather than breaking the
 * whole tools/call response — the JSON block (structuredContent + text) is
 * always the source of truth; this is a best-effort status line on top of it.
 */
// machine.js has no top-level side effects (console patching happens only in
// machine.enable()), so importing it here keeps this module import-safe while
// letting the CLI and the MCP summary share one action-code formatter.
import { formatActionCodes } from "./machine.js";

function fmtElapsed(s) {
  if (typeof s !== "number" || !Number.isFinite(s)) return "?";
  if (s < 1) return `${s}s`;
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function countsLine(entries) {
  return entries
    .filter(([, n]) => n !== undefined && n !== null)
    .map(([label, n]) => `${n} ${label}`)
    .join(" · ");
}

function header(ok, label, env) {
  return ok
    ? `✅ ${label} — ${fmtElapsed(env.elapsedS)}`
    : `❌ ${label} — exit ${env.exit} · ${env.error?.code || "ERROR"}`;
}

function genericFallback(label, env) {
  // This is the last line of defence AND what formatSummary's catch block
  // calls, so it must not be able to throw on any input — a fallback that
  // fails the same way as the thing it catches is not a fallback.
  if (!env || typeof env !== "object") return `❔ ${label} — no result envelope`;
  if (env.ok) return header(true, label, env);
  const msg = env.error?.message ? `\n${env.error.message}` : "";
  return `${header(false, label, env)}${msg}`;
}

function jobStarted(label, env) {
  return `⏳ ${label} — job ${env.data.jobId} started, poll migration_job_status`;
}

function importCounts(results = {}) {
  return countsLine([
    ["products", results.products?.imported],
    ["collections", results.collections?.imported],
    ["customers", results.customers?.imported],
    ["discounts", results.discounts?.imported],
    ["content", results.content ? (results.content.articles || 0) + (results.content.pages || 0) : undefined],
    ["orders", results.orders?.imported],
    ["redirects", results.redirects?.created ?? results.redirects?.updated]
  ]);
}

function importFailedTotal(results = {}) {
  return Object.values(results).reduce((s, r) => s + (Number(r?.failed) || 0), 0);
}

const FORMATTERS = {
  migration_status: (env) => {
    if (!env.ok) return genericFallback("status", env);
    const d = env.data || {};
    const actions = d.warnings?.actions?.length ?? 0;
    const pair = d.pair ? `${d.pair.source || "?"} -> ${d.pair.target || "?"}` : "no active pair";
    return `${header(true, "status", env)}\n${pair} · ${actions} action warning(s) pending`;
  },

  // doctor exists to DIAGNOSE, so the summary must carry the diagnosis. Listing
  // bare check names (the previous behaviour) forced the reader into the JSON
  // block for the one field that actually says what to do — `detail` is where
  // "is the app installed on <shop>?" lives. Show the ratio, then one line per
  // failing check with its detail.
  migration_doctor: (env) => {
    const results = env.data?.results || [];
    if (!env.ok) {
      const failing = results.filter((r) => !r.ok);
      if (!failing.length) return `${header(false, "doctor", env)}\n${env.error?.message || "failed"}`;
      const lines = failing.map((r) => `  • ${r.name}: ${String(r.detail || "failed").replace(/\s+/g, " ").slice(0, 160)}`);
      return `${header(false, "doctor", env)}\n${failing.length} of ${results.length} checks failed\n${lines.join("\n")}`;
    }
    // A passing doctor can still carry data-loss warnings (active plugins whose
    // data does not migrate). Those are not connection failures, so they must not
    // change ok/exit — but "5 check(s) OK" alone would hide a store running
    // WooCommerce Subscriptions, which is a scoping fact, not a footnote.
    const warned = results.filter((r) => r.ok && r.warn);
    const warnLines = warned.map((r) => `  ⚠ ${r.name}: ${String(r.detail || "").replace(/\s+/g, " ").slice(0, 200)}`
      + (Array.isArray(r.risks) ? r.risks.map((k) => `\n      • ${k.name}: ${k.loses}`).join("") : ""));
    return `${header(true, "doctor", env)}\n${results.length} check(s) OK`
      + (warned.length ? `\n${warned.length} data-loss warning(s):\n${warnLines.join("\n")}` : "");
  },

  migration_export: (env) => {
    if (env.data?.status === "running") return jobStarted("export", env);
    if (!env.ok) return genericFallback("export", env);
    return `${header(true, "export", env)}\n${countsLine(Object.entries(env.data?.counts || {}))}`;
  },

  migration_transform: (env) => {
    if (env.data?.status === "running") return jobStarted("transform", env);
    if (!env.ok) return genericFallback("transform", env);
    const d = env.data || {};
    const sev = d.severities || {};
    return `${header(true, "transform", env)}\n${countsLine(Object.entries(d.counts || {}))}\n${sev.action || 0} action · ${sev.handled || 0} handled · ${sev.info || 0} info warning(s)`;
  },

  migration_import: (env) => {
    if (env.data?.status === "running") return jobStarted("import", env);
    if (!env.ok && env.exit !== 4) return genericFallback("import", env); // exit 4 = PARTIAL, still has counts worth showing
    const results = env.data?.results || {};
    const icon = env.ok ? "✅" : "⚠️";
    return `${icon} import — ${fmtElapsed(env.elapsedS)}\n${importCounts(results)}\n${importFailedTotal(results)} failed`;
  },

  migration_verify: (env) => {
    if (env.data?.status === "running") return jobStarted("verify", env);
    if (!env.ok) {
      const d = env.data || {};
      const reason = d.dirtyTarget ? "dirty target" : d.staleTarget ? "stale ledger" : "spot-check/failures";
      return `${header(false, "verify", env)}\n${reason}`;
    }
    // "counts reconciled, spot-checks passed" was the WHOLE summary an agent got
    // for a store shipping a product at 0.00 (D15). Verify's verdict is about
    // whether the migration LANDED; the action items are what still needs a
    // human. An agent that reads only this line must learn both.
    const d = env.data || {};
    const actions = Number(d.warnings) || 0;
    const codes = actions ? ` (${formatActionCodes(d.actionCodes)})` : "";
    return `${header(true, "verify", env)}\ncounts reconciled, spot-checks passed`
      + (actions ? `\n${actions} item(s) need a human before go-live${codes} — migration_status returns the full list` : "");
  },

  migration_all: (env) => {
    if (env.data?.status === "running") return jobStarted("all", env);
    const stages = env.data || {};
    if (!env.ok) {
      const failedStage = Object.entries(stages).find(([, v]) => v && v.ok === false)?.[0];
      return `${header(false, "all", env)}\nfailed at ${failedStage || "?"} · ${env.error?.message || ""}`;
    }
    const importRes = stages.import?.data?.results;
    const line = importRes ? importCounts(importRes) : "";
    return `${header(true, "all", env)}${line ? `\n${line}` : ""}`;
  },

  migration_seed: (env) => {
    if (env.data?.status === "running") return jobStarted("seed", env);
    if (!env.ok) return genericFallback("seed", env);
    const d = env.data || {};
    return `${header(true, "seed", env)}\ntier ${d.tier}${d.wiped ? " · wp wiped first" : ""}`;
  },

  wipe_shopify: (env) => {
    if (env.data?.status === "running") return jobStarted("wipe_shopify", env);
    if (!env.ok) return genericFallback("wipe_shopify", env);
    return `${header(true, "wipe_shopify", env)}\nShopify target wiped`;
  },

  wipe_wordpress: (env) => {
    if (env.data?.status === "running") return jobStarted("wipe_wordpress", env);
    if (!env.ok) return genericFallback("wipe_wordpress", env);
    return `${header(true, "wipe_wordpress", env)}\nWordPress source wiped`;
  },

  sites_list: (env) => {
    if (!env.ok) return genericFallback("sites_list", env);
    const d = env.data || {};
    const active = d.activePair ? `${d.activePair.source} -> ${d.activePair.target}` : "none";
    return `${header(true, "sites_list", env)}\n${(d.wordpress || []).length} wp · ${(d.dandomain || []).length} dandomain · ${(d.shopify || []).length} shopify · active: ${active}`;
  },

  // The profile in `data` is ALREADY redacted by api.js (literal secrets come
  // through as "<redacted>", ${VAR} references intact), so echoing the env
  // references here is safe — and it is the single most useful thing to show:
  // it tells the operator exactly which .env variables to fill in next.
  sites_add: (env) => {
    if (!env.ok) return genericFallback("sites_add", env);
    const d = env.data || {};
    const p = d.profile || {};
    const where = p.baseUrl || p.shop || p.storefrontUrl || p.tenant || "";
    const envVars = Object.values(p).filter((v) => typeof v === "string" && /^\$\{[A-Z0-9_]+\}$/.test(v));
    const needs = envVars.length ? `\nexpects in .env: ${envVars.join(" · ")}` : "";
    return `${header(true, "sites_add", env)}\n${d.created ? "registered" : "replaced"} ${d.kind} profile "${d.name}"${where ? ` (${where})` : ""}${needs}`;
  },

  sites_activate: (env) => {
    if (!env.ok) return genericFallback("sites_activate", env);
    return `${header(true, "sites_activate", env)}\nactive pair: ${env.data?.activated || "?"} — config/migration.config.json regenerated`;
  },

  migration_job_status: (env) => {
    if (!env.ok) return genericFallback("job_status", env);
    const d = env.data || {};
    if (d.status === "running") return `⏳ job_status — ${d.tool} still running (${fmtElapsed(d.elapsedS)})`;
    return `${d.ok ? "✅" : "❌"} job_status — ${d.tool} ${d.status} (${fmtElapsed(d.elapsedS)})`;
  },

  migration_job_list: (env) => {
    if (!env.ok) return genericFallback("job_list", env);
    const jobs = env.data?.jobs || [];
    const running = jobs.filter((j) => j.status === "running").length;
    return `${header(true, "job_list", env)}\n${jobs.length} job(s) tracked · ${running} running`;
  }
};

export function formatSummary(toolName, env) {
  try {
    const fmt = FORMATTERS[toolName];
    const out = fmt ? fmt(env) : genericFallback(toolName, env);
    return typeof out === "string" && out.trim().length > 0 ? out : genericFallback(toolName, env);
  } catch {
    // Second try/catch on purpose: genericFallback is what the primary path
    // already failed through, so calling it here can throw for the same
    // reason. The literal is the only branch guaranteed not to.
    try { return genericFallback(toolName, env); } catch { return `❔ ${toolName} — summary unavailable`; }
  }
}
