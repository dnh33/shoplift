#!/usr/bin/env node
/**
 * probe-selfcheck.mjs — mechanical audit of the probe artifacts against the write-up.
 * Zero dependencies, offline, no credentials. Run: node scripts/probe-selfcheck.mjs
 *
 * WHY THIS EXISTS
 * Three adversarial reviews of this project each changed material claims. Reviewing harder is
 * not a fix — a review is a person, and people are the expensive, late part of the loop. Two of
 * the four round-3 failures were catchable by a script, so they should be caught by a script:
 *
 *   1. UNWRITTEN SECTIONS. `gapsw` ran a `thumbPathOracle` section that answered a question
 *      round 2 had explicitly deferred, and the write-up omitted it entirely. Nothing checked
 *      that every recorded section reached the document. P1's deliverable IS the write-up, so
 *      an unwritten section is unshipped work, not untidiness.
 *
 *   2. STRONG WORDS ON WEAK EVIDENCE. "verified", "confirmed", "proven" were attached to reply
 *      codes (`DELE -> 250`) rather than to a re-query. That is the repo's own D15 lesson —
 *      `0 failed` is not evidence — recurring in a new costume.
 *
 *   3. CONSTRUCTED DEMONSTRATIONS (heuristic). R22 "proved" that lowest-wins publishes a B2B
 *      price using 42 and 90 — both hardcoded in the probe. A finding whose decisive number is
 *      a literal in the probe source is a demonstration of possibility, not a discovery.
 *
 * This is advisory: it prints findings and exits 0 unless --strict. Some flags are legitimate
 * (a verdict can honestly say CONFIRMED when a cross-check field is present). The point is that
 * every strong claim has to look someone in the eye once, cheaply, before a human is spent on it.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBES = path.join(ROOT, "data", "probes");
const DOCS = ["docs/PLAYBOOK-dandomain.md"]
  .map((f) => path.join(ROOT, f)).filter(existsSync);

if (!existsSync(PROBES)) { console.error("no data/probes — nothing to check"); process.exit(0); }
const docText = DOCS.map((f) => readFileSync(f, "utf8")).join("\n");
const probeSrc = (() => { try { return readFileSync(path.join(ROOT, "scripts", "probe-dandomain.mjs"), "utf8"); } catch { return ""; } })();

// Words that assert the reader may stop thinking. Each needs an independent check beside it.
// NEGATED forms are not claims — the first run flagged "NONE of the candidate bases resolved",
// which is the opposite of an assertion. Strip negated occurrences before testing.
const STRONG = /\b(CONFIRMED|VERIFIED|PROVEN|CLOSED END TO END|HAZARD CONFIRMED|RESOLVED)\b/i;
const deNegate = (t) => String(t)
  .replace(/\b(NO|NONE|NOT|NEVER|UN)\s*\w*\s*(CONFIRMED|VERIFIED|PROVEN|RESOLVED)/gi, " ")
  .replace(/\b(UN|NOT[- ])?(CONFIRMED|VERIFIED|PROVEN|RESOLVED)\b(?=[^.]*\b(until|unless|BROKEN|UNRESOLVED|stays|remains)\b)/gi, " ");
// Field names that constitute an independent check: a second channel agreeing, or a re-read.
const CROSSCHECK = /(reQuer|requer|actuallyCleared|byteCountMatchesFtp|sizeMatchesListing|markersAgree|parserAgreesWithRaw|roundTrip|identical|rowsAfterReQuery|distinguishable|boundToProduct|looksPng|consentDateSurvives)/i;

/** Artifacts whose verdicts a later probe replaced. Citing these is a live trap: `media.json`
 *  still says "media export is BROKEN until the real base is found", which imgurl/ftp disproved. */
const SUPERSEDED = {
  media: "imgurl.json + ftp.json (R14: the base is {tenant}.sfstatic.io/upload_dir/pics/)",
  vat: "vatserver.json (R1: the original vat probe supplied its own line price — tautological)",
};

const findings = [];
const add = (sev, artifact, msg, fix) => findings.push({ sev, artifact, msg, fix });

/** Section keys an artifact recorded — the unit that must reach the write-up. */
function sectionsOf(json) {
  if (json && typeof json === "object" && json.sections && typeof json.sections === "object") return Object.keys(json.sections);
  if (json && typeof json === "object" && json.channels && typeof json.channels === "object") {
    return Object.keys(json.channels).filter((k) => !k.startsWith("page:"));
  }
  return [];
}
/** camelCase -> the words a human would have written, so the doc match is not brittle. */
const words = (k) => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_-]+/).filter((w) => w.length > 3);
const mentioned = (key) => {
  const lower = docText.toLowerCase();
  if (lower.includes(key.toLowerCase())) return true;
  const w = words(key);
  return w.length > 0 && w.every((x) => lower.includes(x));
};

const files = readdirSync(PROBES).filter((f) => f.endsWith(".json") && f !== "operations-census.json");
for (const f of files) {
  let json;
  try { json = JSON.parse(readFileSync(path.join(PROBES, f), "utf8")); }
  catch (e) { add("WARN", f, `unparseable: ${e.message}`, "re-run the probe"); continue; }
  const name = f.replace(/\.json$/, "");
  if (SUPERSEDED[name]) {
    add("NOTE", name, `SUPERSEDED by ${SUPERSEDED[name]} — its verdict is stale and citing it would mislead`,
      "do not quote this artifact's verdict; it is kept as a record of what was recorded at the time");
    continue;
  }

  // --- 1. every recorded section must appear in the write-up
  for (const key of sectionsOf(json)) {
    if (!mentioned(key)) {
      add("HIGH", name, `section "${key}" was RECORDED but appears in no doc`,
        "write it up, or state in the artifact why it was intentionally not reported");
    }
  }

  // --- 2. strong words need an independent check in the same artifact
  const verdict = deNegate(json?.verdict ?? "");
  if (STRONG.test(verdict)) {
    const blob = JSON.stringify(json);
    if (!CROSSCHECK.test(blob)) {
      add("HIGH", name, `verdict asserts "${(verdict.match(STRONG) || [])[0]}" but the artifact carries no independent-check field`,
        "re-query the target, or downgrade the wording to what a reply code actually supports (D15)");
    }
  }
  // a verdict that says a thing was deleted/cleaned, with no re-query field anywhere
  // the re-query marker may sit in a section rather than in cleanup{} — search the whole artifact
  if (/\b(deleted|cleaned|removed)\b/i.test(JSON.stringify(json?.cleanup ?? "")) &&
      !/reQuer|rowsAfterReQuery|actuallyCleared/i.test(JSON.stringify(json))) {
    add("MED", name, "cleanup is reported from return values, not from a re-query",
      "re-read the target after deleting; a reply code is not a state observation");
  }

  // --- 3. heuristic: decisive numbers that are literals in the probe source
  if (probeSrc && verdict) {
    const nums = [...new Set((verdict.match(/(?<![\w.])\d{2,6}(?![\w.])/g) || []))]
      .filter((n) => Number(n) > 9 && Number(n) < 100000);
    const constructed = nums.filter((n) => new RegExp(`[:\\s(]${n}\\b`).test(probeSrc));
    if (constructed.length >= 2) {
      add("MED", name, `verdict leans on number(s) [${constructed.join(", ")}] that also appear as literals in the probe source`,
        "label the finding CONSTRUCTED (a demonstration of possibility), not discovered — or re-run against values the probe did not choose");
    }
  }

  // --- 4. a probe that recorded faults but whose verdict never mentions them
  //
  // The alternatives have to be words that only turn up when faults are being DISCUSSED. The first
  // cut carried a bare `NOT `, which case-insensitively matches the word "not" anywhere in a
  // sentence: pagebase.json's original verdict — "decided ... not by a reply code" — sailed
  // through while naming none of its 12 faults. A net that matches ordinary prose reports nothing
  // and reads like a clean bill of health, which is worse than having no net.
  const faults = Array.isArray(json?.faults) ? json.faults.length : 0;
  if (faults > 0 && !/fault|error|refus|reject|unresolved|could not|did not|failed|rejecting/i.test(verdict)) {
    add("MED", name, `${faults} recorded fault(s) but the verdict reads clean`,
      "state the faults in the verdict, or explain why they are expected controls");
  }
}

// --- report
const order = { HIGH: 0, MED: 1, WARN: 2, NOTE: 3 };
findings.sort((a, b) => order[a.sev] - order[b.sev] || a.artifact.localeCompare(b.artifact));
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nprobe-selfcheck — ${files.length} artifacts, ${DOCS.length} docs\n`);
if (!findings.length) console.log("  no findings.\n");
for (const f of findings) {
  console.log(`  ${pad(f.sev, 5)} ${pad(f.artifact, 12)} ${f.msg}`);
  console.log(`  ${pad("", 5)} ${pad("", 12)} -> ${f.fix}\n`);
}
const high = findings.filter((f) => f.sev === "HIGH").length;
console.log(`  ${findings.length} finding(s), ${high} high.\n`);
process.exit(process.argv.includes("--strict") && high ? 1 : 0);
