/**
 * src/dandomain/client.js — the tri-transport DanDomain (Hostedshop) source client.
 *
 * This is the ONE object the exporter talks to. SOAP is implemented here; the FTPS and GraphQL
 * transports are *promoted*, not rewritten, and hang off `client.ftp()` / `client.graphql()`.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 * =====================================
 * Every guard below is a P1 finding that was paid for with a live probe. None of them is
 * defensive programming for its own sake, and none of them can be "simplified" without
 * re-buying the finding.
 *
 * F2 — Solution_SetEncoding is UNREACHABLE THROUGH THIS CLIENT.
 *   The API is UTF-8-native; asking it for UTF-8 makes it convert twice — it mojibakes reads and
 *   IRREVERSIBLY DESTROYS WRITES ("Æblegrød" -> "?r? ??? ???"). The project's own design doc says
 *   to call it. The design doc is wrong. `call()` refuses every name in
 *   operations.FORBIDDEN_OPERATIONS *before the throttle and before the socket*, so there is no
 *   code path — not a retry, not a replay, not a re-assertion — that can emit it. The offline
 *   mock implements the harm (scripts/probe-dandomain.mock.mjs:30/36 flips "Genåbnet" to
 *   "GenÃ¥bnet" once SetEncoding has been called), which is what test/client.test.mjs uses to
 *   show the guard is load-bearing rather than decorative.
 *   Reads are decoded EXPLICITLY as UTF-8 (never from the declared charset) by xml.js, and a
 *   double-encoded response throws EncodingError by default.
 *
 * R17/R27 — argument NAMES are validated before anything is sent.
 *   Unknown argument elements are SILENTLY DROPPED by the server. They do not fault as
 *   NOSUCHPARAM; the call simply arrives short and PHP answers
 *     "Too few arguments to function WebService::Order_GetAllWithPagination(), 0 passed in
 *      /code/smartweb/latest/api/service.php on line 108 and exactly 2 expected"
 *   (data/probes/gaps.json faults[0], code "Receiver" — NOT an AUTH/PARAM code). That recording
 *   is a call to Order_GetAllWithPagination with args {Start, Length} when the WSDL declares
 *   {Page, PageSize}. `call()` runs operations.validateArgs() first and throws
 *   ArgumentNameError WITHOUT a request, so this exact recording cannot happen again; and if a
 *   drifted server produces the message anyway, classifyFault() regexes it into a FATAL NAME
 *   error instead of a transient.
 *
 * R4 — field sets are validated before sending, remembered, and RE-ASSERTED.
 *   One invalid field name faults the whole *_SetFields call AND the session silently keeps the
 *   PREVIOUS field set, so the next read succeeds with the wrong shape and no error. So:
 *     (a) setFields() validates against operations.TYPES BEFORE the wire;
 *     (b) the remembered set is only updated AFTER the server accepted it — a faulted
 *         *_SetFields leaves the memory holding the set the session actually still has;
 *     (c) every remembered set is re-asserted after ANY fault and after ANY reconnect, because
 *         a new session has the DEFAULT field set (Id only) and the replayed read would return
 *         a smaller record with no error at all.
 *   There are SIX field-set operations, not four (operations.FIELD_SET_OPERATIONS, selected by
 *   argument shape): Order_SetOrderLineFields and Product_SetVariantFields are easy to miss and
 *   are exactly the two that silently degrade order lines and variants after a replay.
 *
 * F16 — Order_Create can THROW AFTER SUCCEEDING.
 *   Fault `lineErrors` with "Order: 4 created. Following products were not included…". THE ORDER
 *   EXISTS. Retrying duplicates it. classifyFault() gives that fault kind LINE_ERRORS with
 *   created:true, retryable:false and the id parsed out with the brief's own
 *   /Order:\s*(\d+)\s*created/, and the replay policy below can never replay a create anyway.
 *
 * F3 — fault codes exceed the documented five.
 *   xml.js already reads the app code from Subcode/Value when present, else Code/Value. Anything
 *   this classifier does not recognise is NAMED-FATAL: kind UNKNOWN, the real code preserved,
 *   fatal:true, retryable:false. Unknown never means "probably transient, try again".
 *
 * SESSION — replay is allow-listed from the WSDL, not from a hopeful name check.
 *   "Only ever replay idempotent reads." An operation is replayable only when TWO independent
 *   WSDL-derived signals agree: its name's verb segment is Get/Has/Search AND its own
 *   <documentation> opens with a read verb (Returns/Checks/Retrieve/Equal/Searches). Today that
 *   is 117 of 247 operations and the two signals agree on all 247 — REPLAY_SIGNAL_DISAGREEMENTS
 *   is empty and a test asserts it. If a future WSDL makes them disagree the operation becomes
 *   NON-replayable (fail-safe) and shows up in that array. The per-call option can turn replay
 *   OFF; it can never turn it ON for a write, mirroring the same rule in graphql.js.
 *
 * R26/R28 — the field audit is WHOLE-BATCH and never decides from record 1.
 *   Fields are omitted PER RECORD when empty: SeoLink came back on 8 of 618 products
 *   (data/probes/scale.json pages[].productMarkers.SeoLink === 8 at every page size). A field on
 *   ZERO records is a truncated column; a field on SOME records is an empty value and is NOT an
 *   error. Deciding from record 1 calls SeoLink truncated on this very shop — that is R28, the
 *   false positive that reached the requirements table. And with ZERO records nothing is
 *   decidable at all: the audit returns decidable:false and raises nothing, which is the
 *   correction the probe itself already had to make (probe-dandomain.mjs:155-167, "truncated:
 *   null, not true" — gaps.json sections.customers.audit).
 *   The rule is ENFORCED, not merely offered: readAll() audits its accumulated batch against the
 *   remembered field set for the result's own WSDL type (recordTypeOf) and raises
 *   FieldSetTruncatedError by default. It is deliberately NOT done per call(): a single page is
 *   not the whole batch, and auditing one is the same too-small-a-sample mistake as record 1.
 *   AND IT RECURSES (R3). The records are not flat, and R3's actual recorded truncation —
 *   PacketId and Status missing on ORDER LINES — is one level down, so a top-level-only audit
 *   would miss the defect that motivated the rule. readAll() hands auditBatch() the result's
 *   record type AND every remembered field set, so Order.OrderLines are audited against the
 *   OrderLine set, Product.Variants against the ProductVariant set, and the collections with no
 *   *_SetFields operation at all (Product.Pictures, Product.StockLocations) are SURVEYED rather
 *   than skipped. The verdicts are per record type in `audit.nested` / `audit.truncatedByType`.
 *
 * H1/H2 — a paged walk stops on ZERO ROWS or a KNOWN TOTAL, never on a short page; and readAll()
 *   SURFACES that verdict. See readPages() for the stop conditions and why an empty window after
 *   a FULL page is corroborated while one after a SHORT page is not. `for await` discards a
 *   generator's return value, so readAll() drives the iterator by hand — a completeness verdict
 *   the caller cannot read is not a verdict, and the previous version reported a hardcoded
 *   `complete: true` even for the one outcome that is not complete.
 *
 * H4 — a fault is NEVER deleted by the recovery that follows it.
 *   A fault triggers a recovery (the single AUTH reconnect, or R4's re-assertion loop). When the
 *   recovery ALSO fails, letting its exception propagate throws away the diagnosis: the operator
 *   sees "could not re-assert Product" and never learns the read faulted INTERNAL. So call() wraps
 *   both in PostFaultReassertError with `.originalFault`, `.reassertError` and `.phase`. It is not
 *   a DanDomainFaultError, because after a failed recovery the record shape is UNKNOWN and that is
 *   strictly worse than the fault a caller might otherwise switch on.
 *
 * H6 — bounded, jittered retry for TRANSPORT failures ONLY, and resumable paged reads.
 *   See SOAP_RETRY_DEFAULTS and #sendWithTransportRetry: never a named fault (the server already
 *   decided), never an operation off the REPLAYABLE allow-list (F16: a transport error says
 *   nothing about whether the create landed), and `{ replay: false }` switches both repeat
 *   mechanisms off together. Every error out of a walk carries `.resume`, so a 10k export that
 *   dies at product 9,000 restarts there.
 *
 * R6/R18/R26 — parsing goes through xml.js. No regex walker, ever.
 *   The naive walker reported ONE record for a 618-product page (scale.json parsedLength:1) and
 *   the ids derived from that shape produced a real server fault. `call()` hands raw BYTES to
 *   parseSoapResponse and asks for asRecords() only where the WSDL types the result ArrayOf*
 *   (OPERATIONS[op].resultItemType), so "is this a list?" is a schema fact, not a guess.
 *
 * R1/R2/F30/R8 — money is NOT touched here.
 *   Nothing coerces numbers, nothing sums, nothing reads Order.Vat or OrderLine.VatRate. Values
 *   come back as the strings the wire carried so that Product.Price (VAT-INCLUSIVE) versus
 *   OrderLine (NET), OrderTransaction.Amount (øre) versus OrderLine.Amount (a QUANTITY) stay the
 *   caller's decision. Foreclosing that here is how a unit bug becomes invisible.
 *
 * WHAT IS DELIBERATELY NOT DECIDED HERE (see the return value / the notes on each member)
 *   - The SOAP request-body encoding for non-ASCII WRITES is UNRESOLVED. See requestEncoding.
 *   - Whether the page-number base holds on a SECOND SHOP. It is 1 on shop000000 on two
 *     independent methods (SOAP_PAGE_BASE / data/probes/pagebase.json) and that recorded value is
 *     the default, but no other shop has been asked. `{ pageBase: "detect" }` settles it against
 *     the shop in hand, `createClient({ defaultPageBase: null })` refuses until someone does, and
 *     a `startPage` still does NOT stand in for a base — that route is how the old unverified
 *     default used to stay reachable.
 *   - No SOAP rate limit was ever observed, so the token bucket defaults to unpaced. See
 *     SOAP_RATE_EVIDENCE.
 *
 * Zero dependencies (Node >= 20 built-ins and global fetch only), ESM, pure: no top-level side
 * effects, no process.exit, nothing written to stdout. Errors are thrown, never printed.
 */

import {
  ENDPOINT, FIELD_SET_OPERATIONS, FORBIDDEN_OPERATIONS, OPERATIONS, SET_FIELDS_TYPE, SOURCE,
  TYPE_DETAILS,
  argNamesFor, operationFor, operationNames, orderedArgs, validateArgs, validateFields,
} from "./operations.js";
import { SOURCE_SNIPPET_LIMIT, SoapFaultError, XmlParseError, asRecords, decodeResponseBytes, parseSoapResponse } from "./xml.js";
import { createGraphQLClient } from "./graphql.js";
import { ftpsConnect, parseList } from "./ftp.js";

// ---------------------------------------------------------------------------------------------
// Errors. Every one of them names the finding it enforces, because the message is what a future
// operator sees at 2am and it has to be enough to stop them "fixing" it by removing the guard.
// ---------------------------------------------------------------------------------------------

export class DanDomainClientError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, info);
  }
}

/** F2. Thrown before the throttle and before the socket: the call never happens. */
export class ForbiddenOperationError extends DanDomainClientError {}

/** R17/R27. Unknown or missing ARGUMENT names, caught before the wire. */
export class ArgumentNameError extends DanDomainClientError {}

/** R4. A *_SetFields list that does not validate against the WSDL type. Never sent. */
export class FieldListError extends DanDomainClientError {}

/** R4. A remembered field set could not be re-established; the session's shape is now unknown. */
export class FieldSetReassertError extends DanDomainClientError {}

/**
 * R4 + the recovery-ordering rule. A fault happened AND the recovery from it (the reconnect, or
 * the re-assertion loop) ALSO failed. Two independent things are wrong and both are reported:
 * `.originalFault` is the DanDomainFaultError that started it — the diagnosis, which a recovery
 * failure must never be allowed to delete — and `.reassertError` is the recovery failure itself.
 * It is its own class, not a DanDomainFaultError, because the session's record shape is now
 * UNKNOWN and that is strictly worse than the fault: a caller who handles faults by kind must not
 * silently treat this as one of them.
 */
export class PostFaultReassertError extends FieldSetReassertError {}

/** R26. A requested field was absent from EVERY record in the batch: a truncated column. */
export class FieldSetTruncatedError extends DanDomainClientError {}

/** A classified SOAP fault. `.kind` is the decision; `.code` is what the server actually said. */
export class DanDomainFaultError extends DanDomainClientError {}

/** Transport-level failure: no response, a non-SOAP body, or an HTTP status with no fault in it. */
export class SoapTransportError extends DanDomainClientError {}

/** A paged read that cannot be proven complete. Never returned as a short success. */
export class PaginationError extends DanDomainClientError {}

/**
 * A page came back with ZERO rows where zero rows does not prove the data ended: either the walk
 * refused to guess (emptyPage:"error"), or the corroborating read past it FOUND ROWS, which makes
 * the empty page a HOLE in the server's answers rather than the end of the catalogue. Carries
 * `.resume` so the caller can restart at exactly the cursor that answered empty.
 */
export class EmptyPageError extends PaginationError {}

/**
 * A page-NUMBER walk was started without an explicit page base. SOAP_PAGE_BASE.verified is false:
 * P1 never proved whether `Page` is 0-based or 1-based, and guessing 1 against a 0-based server
 * skips the entire first page with no error. Refused instead of assumed.
 */
export class PageBaseUnverifiedError extends PaginationError {}

/** Empirical page-base detection could not decide. Nothing is guessed and nothing is walked. */
export class PageBaseUndecidableError extends PaginationError {}

/** The unresolved non-ASCII write question, refused rather than silently mangled. */
export class UnresolvedWriteEncodingError extends DanDomainClientError {}

// ---------------------------------------------------------------------------------------------
// Fault classification (R4, R17/R27, F3, F16, session)
// ---------------------------------------------------------------------------------------------

export const FAULT_KIND = Object.freeze({
  /** R4 — the FIELD list is wrong. Fatal. Never retry: the session kept its previous field set. */
  NOSUCHPARAM: "NOSUCHPARAM",
  /** R17/R27 — an ARGUMENT name was wrong, dropped in flight, and PHP complained about arity. */
  ARITY: "ARITY",
  /** Session — reconnect once, then replay IDEMPOTENT READS ONLY. */
  AUTH: "AUTH",
  /** F16 — the order was CREATED. Never retry. Parse the id. */
  LINE_ERRORS: "LINE_ERRORS",
  /** F3 — codes exceed the documented five. Anything unrecognised is named-fatal. */
  UNKNOWN: "UNKNOWN",
});

/**
 * R17/R27's PHP arity message, as recorded verbatim in data/probes/gaps.json faults[0]:
 *   "Too few arguments to function WebService::Order_GetAllWithPagination(), 0 passed in
 *    /code/smartweb/latest/api/service.php on line 108 and exactly 2 expected"
 * The class/`::` prefix and the file/line tail vary, and PHP writes "at least N expected" for
 * functions with optional parameters, so both tails are accepted. The captured groups are the
 * evidence the caller needs: which function, how many arrived, how many it wanted.
 */
export const PHP_ARITY_RE =
  /Too few arguments to function\s+(?:([A-Za-z_\\][\w\\]*)::)?([A-Za-z_]\w*)\(\)\s*,\s*(\d+)\s+passed\b[\s\S]*?\b(?:exactly|at least)\s+(\d+)\s+expected/i;

/** F16, the brief's own regex. The order EXISTS; this pulls its id out of the fault reason. */
export const ORDER_CREATED_RE = /Order:\s*(\d+)\s*created/;

/** R4. Matched against the app code first; the reason is only a fallback for a drifted server. */
export const NOSUCHPARAM_RE = /\bNOSUCHPARAM\b/i;

/**
 * The AUTH reason as the offline mock states it (scripts/probe-dandomain.mock.mjs:25/28):
 * "A valid authentication has not been performed with the service". The primary signal is the
 * app CODE ("AUTH"); this exists so a server that keeps the sentence but renames the code is
 * still recognised. Overridable per call so a new phrasing does not need a code change.
 */
export const AUTH_REASON_RE = /valid authentication has not been performed/i;

/**
 * Classify a SOAP fault. PURE — takes a SoapFaultError (or any `{code, reason}`) and returns a
 * decision; it never talks to the network and never mutates its input.
 *
 * ORDER MATTERS and it is deliberate. Two of the five kinds are recognised by their REASON TEXT
 * rather than their code, because the recordings show the code is not diagnostic: the arity
 * message arrived under code "Receiver" (gaps.json faults[0]), not NOSUCHPARAM and not PARAM. So
 * the message-based tests run FIRST, most-dangerous-to-misread first:
 *   1. LINE_ERRORS — misreading this one duplicates a real order (F16). It wins over everything.
 *   2. ARITY       — a NAME error, not a transient. Must never be retried (R17/R27).
 *   3. NOSUCHPARAM — the field list is wrong (R4). Fatal.
 *   4. AUTH        — the only recoverable kind, and only for idempotent reads.
 *   5. UNKNOWN     — named-fatal (F3). The code is preserved so the operator sees what it was.
 *
 * @param {{code?: string, reason?: string, message?: string}} fault
 * @param {{authReason?: RegExp}} [options]
 * @returns {{kind: string, code: string|null, reason: string, fatal: boolean, retryable: boolean,
 *            reconnect: boolean, created?: boolean, orderId?: number|null, argity?: object,
 *            why: string}}
 */
export function classifyFault(fault, options = {}) {
  if (fault === null || typeof fault !== "object") {
    throw new TypeError("classifyFault expects a SoapFaultError or a { code, reason } object");
  }
  const code = typeof fault.code === "string" ? fault.code : null;
  const reason = typeof fault.reason === "string" ? fault.reason : (typeof fault.message === "string" ? fault.message : "");
  const authReason = options.authReason ?? AUTH_REASON_RE;
  const base = { code, reason };

  // 1. F16 — the order EXISTS. Recognised by the app code `lineErrors` OR by the sentence itself,
  //    because getting this wrong creates a duplicate order and no other kind costs that.
  const created = ORDER_CREATED_RE.exec(reason);
  if ((code !== null && code.toLowerCase() === "lineerrors") || created) {
    return {
      ...base,
      kind: FAULT_KIND.LINE_ERRORS,
      fatal: true,
      retryable: false,
      reconnect: false,
      created: Boolean(created),
      orderId: created ? Number(created[1]) : null,
      why: "F16: Order_Create threw AFTER succeeding — the order exists. Never retry; use .orderId.",
    };
  }

  // 2. R17/R27 — unknown ARGUMENT names were silently dropped and PHP complained about arity.
  const arity = PHP_ARITY_RE.exec(reason);
  if (arity) {
    return {
      ...base,
      kind: FAULT_KIND.ARITY,
      fatal: true,
      retryable: false,
      reconnect: false,
      arity: {
        klass: arity[1] ?? null,
        operation: arity[2],
        passed: Number(arity[3]),
        expected: Number(arity[4]),
      },
      why: "R17/R27: an ARGUMENT NAME was wrong. The server dropped the unknown elements and PHP " +
        "reported arity. This is a name error, not a transient — fix the names against the WSDL.",
    };
  }

  // 3. R4 — the FIELD list is wrong.
  if ((code !== null && NOSUCHPARAM_RE.test(code)) || NOSUCHPARAM_RE.test(reason)) {
    return {
      ...base,
      kind: FAULT_KIND.NOSUCHPARAM,
      fatal: true,
      retryable: false,
      reconnect: false,
      why: "R4: NOSUCHPARAM means the FIELD list is wrong. Never retry — and note the session is " +
        "still on its PREVIOUS field set, so the next read will succeed with the wrong shape.",
    };
  }

  // 4. Session — the only recoverable kind.
  if ((code !== null && code.toUpperCase() === "AUTH") || authReason.test(reason)) {
    return {
      ...base,
      kind: FAULT_KIND.AUTH,
      fatal: false,
      retryable: true,
      reconnect: true,
      why: "Session: reconnect ONCE and replay — idempotent reads only, and only after every " +
        "remembered field set has been re-asserted (R4: a new session has the DEFAULT field set).",
    };
  }

  // 5. F3 — anything else is named-fatal. The code is kept; it is not assumed transient.
  return {
    ...base,
    kind: FAULT_KIND.UNKNOWN,
    fatal: true,
    retryable: false,
    reconnect: false,
    why: `F3: fault codes exceed the documented five. "${code ?? "?"}" is not recognised, so it is ` +
      "treated as NAMED-FATAL rather than as something to retry.",
  };
}

// ---------------------------------------------------------------------------------------------
// Replay policy (session rule + F16). Derived from the WSDL, cross-checked, fail-safe.
// ---------------------------------------------------------------------------------------------

/** Verb segments of an `Entity_Verb…` operation name that denote a read. Get:115 Has:1 Search:1. */
export const READ_NAME_VERBS = Object.freeze(["Get", "Has", "Search"]);

/**
 * Leading word of the operation's own <documentation> that denotes a read. These are the exact
 * five that occur across the 117 name-read operations (Returns:113, Checks:1, Retrieve:1,
 * Equal:1, Searches:1); the other 130 open with Creates/Updates/Deletes/Sets/Adds/Removes/
 * Upates[sic]/Sends/Cancels/Connects/Enables/Completes/Lowers/Activates/Uploads. No synonym is
 * added speculatively: a verb that is not on this list makes the operation NON-replayable, which
 * is the safe direction, and it surfaces in REPLAY_SIGNAL_DISAGREEMENTS instead of silently
 * widening what may be replayed after a re-auth.
 */
export const READ_DOC_VERBS = Object.freeze(["Returns", "Checks", "Retrieve", "Equal", "Searches"]);

/**
 * The two signals for one operation, as a PURE function of its name and its documentation.
 *
 * Exported, and kept out of the loop below, on purpose: on the pinned WSDL the two signals agree
 * everywhere, so a version of this that consulted only ONE of them would produce an identical
 * allow-list and no test over the real 247 operations could tell the difference. This function
 * can be handed a DISAGREEING pair — which is exactly the case the cross-check exists for — so
 * the rule is checkable instead of merely stated.
 *
 * `replayable` is the AND: a write that happens to be named `X_Get…`, or a read whose
 * documentation opens with "Creates", is NOT replayable. Fail-safe in the direction that matters,
 * because the cost of being wrong is F16's duplicated order.
 */
export function replaySignalsFor(name, documentation) {
  const under = typeof name === "string" ? name.indexOf("_") : -1;
  const verb = under === -1 ? "" : name.slice(under + 1);
  const byName = under !== -1 && READ_NAME_VERBS.some(
    (v) => verb === v || (verb.startsWith(v) && /^[A-Z]/.test(verb.slice(v.length))),
  );
  const first = typeof documentation === "string" ? documentation.trim().split(/\s+/)[0] : "";
  const byDoc = READ_DOC_VERBS.includes(first);
  return { byName, byDoc, replayable: byName && byDoc };
}

const _replayable = new Set();
const _disagreements = [];
for (const op of operationNames()) {
  const sig = replaySignalsFor(op, OPERATIONS[op].documentation);
  if (sig.byName !== sig.byDoc) {
    _disagreements.push({ op, byName: sig.byName, byDoc: sig.byDoc, documentation: OPERATIONS[op].documentation ?? null });
  }
  // The F2 ban and the six session-mutating *_SetFields operations are excluded belt-and-braces
  // even though neither is name-read.
  if (sig.replayable && !FORBIDDEN_OPERATIONS.includes(op) && !FIELD_SET_OPERATIONS.includes(op)) {
    _replayable.add(op);
  }
}

/** The operations an AUTH reconnect may replay. Frozen; derived, not typed in. */
export const REPLAYABLE_OPERATIONS = Object.freeze(new Set(_replayable));

/**
 * Operations where the NAME signal and the DOCUMENTATION signal disagree. Empty against the
 * pinned WSDL. A non-empty array is API drift, and every entry in it is treated as NOT
 * replayable — test/client.test.mjs asserts it is empty so drift is loud instead of silent.
 */
export const REPLAY_SIGNAL_DISAGREEMENTS = Object.freeze(_disagreements);

/** True when an AUTH reconnect is allowed to replay this operation. Throws on an unknown name. */
export function isReplayable(op) {
  operationFor(op); // R27: never answer a question about an operation the WSDL does not declare.
  return REPLAYABLE_OPERATIONS.has(op);
}

// ---------------------------------------------------------------------------------------------
// Throttle: a token bucket, plus a concurrency gate.
// ---------------------------------------------------------------------------------------------

/**
 * What P1 actually measured about SOAP rate limiting: nothing enforced it.
 * scale.json ran 6 sequential 50-product creates plus 5 whole-catalogue page reads and records
 * `faults: []`; gaps.json scanned 69 responses and records exactly one fault (the arity one).
 * No 429, no retry-after, no rising latency wall. The burst probe's own output
 * (probe-dandomain.mjs:1039 -> limits.json) is NOT in data/probes/, so this repo cannot even
 * quote it. Therefore the bucket exists, is fully implemented and is tested — but its default
 * refill is Infinity (unpaced), because inventing "5 requests/second" for SOAP would be a
 * fabricated constant, and the brief forbids magic numbers that were not discovered.
 * Set { throttle: { refillPerSecond, capacity } } once a real limit is known.
 */
export const SOAP_RATE_EVIDENCE = Object.freeze({
  observedLimit: null,
  sequentialCallsWithoutThrottling: "scale.json (11 calls, faults: []) + gaps.json (69 responses, 1 fault)",
  retryAfterSeen: false,
  burstProbeOutput: "data/probes/limits.json — not present in this repo",
  default: "unpaced (refillPerSecond: Infinity); configure a rate before running against a real shop",
});

/**
 * Concurrency default. ONE in flight at a time, and this is an R4 consequence rather than
 * politeness: the field set is SESSION-global state, so a *_SetFields (or a post-fault
 * re-assertion) racing an in-flight read changes that read's record shape mid-flight, with no
 * error anywhere. Raise it only for a client that never calls setFields().
 */
export const DEFAULT_MAX_CONCURRENT = 1;

/**
 * BOUNDED RETRY FOR TRANSPORT FAILURES ONLY.
 *
 * A 10k-product export is hundreds of round trips; one dropped socket at product 9,000 must not
 * cost the whole walk. So a TRANSPORT-level failure (no response, a socket error, a timeout, an
 * HTTP status with no SOAP in the body) is retried, and NOTHING else is:
 *
 *   - a NAMED FAULT is never retried. It is a decision the server already made, and R4's
 *     NOSUCHPARAM in particular is fatal by rule. The one recoverable fault kind (AUTH) has its
 *     own single reconnect-and-replay path, which is not this.
 *   - an operation that is not on the WSDL-derived REPLAYABLE allow-list is never retried, which
 *     is what keeps F16 true: a transport error carries NO information about whether the server
 *     already created the order, so re-sending Order_Create is how you get two orders.
 *   - `{ replay: false }` on a call disables this too. One switch, both repeat mechanisms.
 *
 * THESE THREE NUMBERS ARE LOCAL POLICY, NOT PROBED FACTS, and they are here rather than inline so
 * that is visible. P1 measured no rate limit and no transient at all (SOAP_RATE_EVIDENCE), so
 * there is nothing to derive a "correct" backoff from; these are ordinary conservative defaults
 * and every one of them is overridable per client and per call. The jitter is FULL jitter
 * (random() * cappedDelay) so a fleet of retrying exporters cannot resynchronise into a thundering
 * herd — `random` and `sleep` are injected so a test can pin both.
 */
export const SOAP_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5000,
});

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the retry policy for one call: SOAP_RETRY_DEFAULTS, overridden by the client's
 * `{ retry }`, overridden by the call's `{ retry }`. `sleep` and `random` are injected rather than
 * captured so a test can pin the backoff exactly instead of waiting on a real timer; the defaults
 * are the real ones. Nonsense values fall back to the default instead of disabling the bound —
 * `maxAttempts: 0` must not mean "never send the request at all".
 */
export function resolveRetryPolicy(...layers) {
  const merged = Object.assign({}, SOAP_RETRY_DEFAULTS, ...layers.map((l) => l ?? {}));
  const int = (value, fallback, min) =>
    (Number.isFinite(value) && value >= min ? Math.floor(value) : fallback);
  return {
    maxAttempts: int(merged.maxAttempts, SOAP_RETRY_DEFAULTS.maxAttempts, 1),
    baseDelayMs: int(merged.baseDelayMs, SOAP_RETRY_DEFAULTS.baseDelayMs, 0),
    maxDelayMs: int(merged.maxDelayMs, SOAP_RETRY_DEFAULTS.maxDelayMs, 0),
    sleep: typeof merged.sleep === "function" ? merged.sleep : realSleep,
    random: typeof merged.random === "function" ? merged.random : Math.random,
  };
}

/**
 * FULL jitter, as the header above says: `random() * min(base * 2^n, cap)`. The exponent is the
 * number of attempts already spent, so the first wait is `base` and every one after it doubles
 * until the cap. Multiplying by random() (rather than adding a wobble to a fixed delay) is what
 * stops a fleet of exporters that all died on the same outage from resynchronising on the way back.
 */
function backoffDelay(policy, attemptsSoFar) {
  const ceiling = Math.min(policy.baseDelayMs * (2 ** (attemptsSoFar - 1)), policy.maxDelayMs);
  return policy.random() * ceiling;
}

/**
 * A token bucket. `capacity` tokens, refilled at `refillPerSecond`, one token per request.
 * Admission is FIFO-serialised through a promise chain so N concurrent callers cannot all read
 * "there is a token" before any of them takes it.
 *
 * `now` and `sleep` are injected so tests drive a fake clock and the suite runs in milliseconds.
 */
export function createTokenBucket({ capacity = 1, refillPerSecond = Infinity, now = Date.now, sleep = realSleep } = {}) {
  if (!(Number.isFinite(capacity) && capacity >= 1)) throw new RangeError("token bucket capacity must be a finite number >= 1");
  if (!(refillPerSecond > 0)) throw new RangeError("token bucket refillPerSecond must be > 0 (use Infinity for unpaced)");
  let tokens = capacity;
  let last = now();
  let chain = Promise.resolve();
  const stats = { takes: 0, waits: 0, waitedMs: 0 };

  function refill() {
    const t = now();
    const elapsed = Math.max(0, t - last);
    last = t;
    if (refillPerSecond === Infinity) { tokens = capacity; return; }
    tokens = Math.min(capacity, tokens + (elapsed / 1000) * refillPerSecond);
  }

  async function admit() {
    refill();
    let waited = 0;
    if (tokens < 1) {
      waited = Math.ceil(((1 - tokens) / refillPerSecond) * 1000);
      stats.waits += 1;
      stats.waitedMs += waited;
      await sleep(waited);
      refill();
      // A fake clock that does not advance during sleep would otherwise deadlock the bucket.
      if (tokens < 1) tokens = 1;
    }
    tokens -= 1;
    stats.takes += 1;
    return { waitedMs: waited };
  }

  return {
    take() {
      const p = chain.then(admit);
      chain = p.then(() => {}, () => {});
      return p;
    },
    stats: () => ({ ...stats }),
    get tokens() { return tokens; },
    capacity,
    refillPerSecond,
  };
}

/** FIFO concurrency gate. Separate from the bucket: rate and parallelism are different limits. */
export function createGate(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
  if (!(Number.isFinite(maxConcurrent) && maxConcurrent >= 1)) throw new RangeError("maxConcurrent must be >= 1");
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < maxConcurrent) { active += 1; return; }
      await new Promise((resolve) => queue.push(resolve));
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      const next = queue.shift();
      if (next) next();
    },
    get active() { return active; },
    get queued() { return queue.length; },
    maxConcurrent,
  };
}

// ---------------------------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------------------------

/**
 * F2's chokepoint. Called at the front door (call()) AND immediately before the socket (#send),
 * because #send is also reached by connect() and by the R4 re-assertion loop and a guard that
 * only covers one of three entrances is not a guard. The list is operations.FORBIDDEN_OPERATIONS
 * — the generator verifies each name still exists in the WSDL, so the ban cannot rot into a
 * no-op against a renamed operation.
 */
function assertNotForbidden(op) {
  if (!FORBIDDEN_OPERATIONS.includes(op)) return;
  throw new ForbiddenOperationError(
    `${op} is FORBIDDEN (F2). The API is UTF-8-native: asking it to set an encoding makes it ` +
    'convert twice — it mojibakes reads and IRREVERSIBLY DESTROYS WRITES ("Æblegrød" -> ' +
    '"?r? ??? ???"). The project design doc instructs this call; the design doc is wrong. ' +
    "No request was sent.",
    { op, forbidden: [...FORBIDDEN_OPERATIONS] },
  );
}

export const SOAP_ENV_NS = "http://www.w3.org/2003/05/soap-envelope";

/** XML text escaping — the same five characters the probe escaped (probe-dandomain.mjs:58). */
export function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

const NCNAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Serialise one element.
 *
 * THE undefined/null CONTRACT (operations.js validateArgs header). `undefined` means ABSENT and
 * the element is DROPPED; `null` means PRESENT-AND-EMPTY and the element is emitted as
 * `<X></X>`. The probe's serialiser mapped BOTH to "" (probe-dandomain.mjs:58-62), which is why
 * that header calls this a requirement on the serialiser rather than an observation about one.
 * No xsi:nil is ever emitted: no probe recorded one on the wire, and gaps.json
 * sections.orderGetByDate shows the empty element behaving exactly like omission
 * ("Status empty string" -> ok, count 20).
 *
 * ARRAYS repeat the element name. An `ArrayOf*`-typed field is NOT that shape — service.wsdl
 * models every list as a wrapper containing repeated `<item>` — so it must be written as
 * `{ OrderLines: { item: [line, line] } }`, which is how the probe sent it
 * (probe-dandomain.mjs:938). buildEnvelope() refuses a bare array for a top-level `tns:ArrayOf*`
 * argument rather than emitting the wrong shape silently.
 *
 * NON-PLAIN OBJECTS ARE REFUSED. `new Date()` has no own enumerable keys, so a naive walker
 * turns it into `<Start></Start>` and the date is gone with no error — the same class of defect
 * the GraphQL literal serialiser was caught with. The API wants
 * "2019-01-01 00:00:00" strings (gaps.json sections.orderGetByDate.tried[].args), so the fix is
 * named in the error rather than guessed at here.
 */
function serialiseElement(name, value, path) {
  if (!NCNAME_RE.test(name)) {
    throw new ArgumentNameError(`"${name}" is not a legal XML element name (at ${path})`, { element: name, path });
  }
  if (value === undefined) return "";
  if (value === null) return `<${name}></${name}>`;
  if (Array.isArray(value)) return value.map((v, i) => serialiseElement(name, v, `${path}[${i}]`)).join("");
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new ArgumentNameError(
        `${path} is a ${value.constructor?.name ?? "non-plain object"}; the SOAP serialiser only accepts ` +
        "plain objects, arrays and scalars. A Date has no enumerable own keys and would silently " +
        'serialise to an EMPTY element — send the string the API records instead (e.g. "2019-01-01 00:00:00").',
        { path, got: value.constructor?.name ?? "object" },
      );
    }
    const inner = Object.entries(value).map(([k, v]) => serialiseElement(k, v, `${path}/${k}`)).join("");
    return `<${name}>${inner}</${name}>`;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new ArgumentNameError(`${path} is a ${typeof value}, which has no SOAP representation`, { path, got: typeof value });
  }
  return `<${name}>${escapeXml(value)}</${name}>`;
}

/**
 * Build the SOAP 1.2 envelope for one operation.
 *
 * Argument ORDER is the WSDL's, via operations.orderedArgs(): every request wrapper in this WSDL
 * is an <xsd:sequence>, so order is part of the schema and not a stylistic choice. The operation
 * element is `m:<Op>` bound to the WSDL's targetNamespace, exactly as the probe sent it.
 */
export function buildEnvelope(op, args = {}, { namespace = SOURCE.targetNamespace, encoding = "UTF-8" } = {}) {
  const spec = operationFor(op);
  const { elements, unknown } = orderedArgs(op, args);
  if (unknown.length) {
    throw new ArgumentNameError(
      `${op}: unknown argument name(s) ${JSON.stringify(unknown)} — the server DROPS these silently ` +
      `and answers with a PHP arity error (R17/R27). Declared: ${JSON.stringify(argNamesFor(op))}`,
      { op, unknown },
    );
  }
  const declaredType = new Map(spec.args.map((a) => [a.name, a.type]));
  let body = "";
  for (const el of elements) {
    const type = declaredType.get(el.name) ?? "";
    if (Array.isArray(el.value) && /^tns:ArrayOf/i.test(type)) {
      throw new ArgumentNameError(
        `${op}.${el.name} is typed ${type}: an ArrayOf* argument is a WRAPPER holding repeated ` +
        `<item> elements, not a repeated <${el.name}>. Send { ${el.name}: { item: [...] } } ` +
        "(probe-dandomain.mjs:938 sends it that way).",
        { op, argument: el.name, type },
      );
    }
    body += serialiseElement(el.name, el.value, `${op}.${el.name}`);
  }
  return `<?xml version="1.0" encoding="${encoding}"?>` +
    `<env:Envelope xmlns:env="${SOAP_ENV_NS}"><env:Body>` +
    `<m:${op} xmlns:m="${namespace}">${body}</m:${op}>` +
    "</env:Body></env:Envelope>";
}

/**
 * Encode the request body.
 *
 * "utf-8" is the default and matches the probe's default (probe-dandomain.mjs:70). "latin1" is
 * ISO-8859-1 exactly as the probe's alternative wire produced it (`Buffer.from(s, "latin1")`):
 * one byte per code point, and a code point above U+00FF has no representation, so it throws
 * instead of being replaced by "?". See requestEncoding on the client for why this is a knob and
 * not a decision.
 */
function encodeRequestBody(xml, encoding) {
  if (encoding === "utf-8") return new TextEncoder().encode(xml);
  if (encoding !== "latin1") throw new RangeError(`unknown requestEncoding "${encoding}" (use "utf-8" or "latin1")`);
  const out = new Uint8Array(xml.length);
  for (let i = 0; i < xml.length; i++) {
    const cp = xml.charCodeAt(i);
    if (cp > 0xff) {
      throw new UnresolvedWriteEncodingError(
        `requestEncoding "latin1" cannot represent U+${cp.toString(16).toUpperCase().padStart(4, "0")} ` +
        `at offset ${i}; refusing to substitute "?" (F2: a silently substituted character is exactly ` +
        "the write corruption the forbidden encoding call causes).",
        { offset: i, codePoint: cp },
      );
    }
    out[i] = cp;
  }
  return out;
}

const NON_ASCII_RE = /[^\x00-\x7F]/;

// ---------------------------------------------------------------------------------------------
// Field sets (R4)
// ---------------------------------------------------------------------------------------------

/**
 * type -> the operation that sets its field set. The inverse of operations.SET_FIELDS_TYPE, which
 * the generator parses from each operation's own <documentation> ("…returning ProductVariant
 * Objects") rather than from the operation name — which is how Product_SetVariantFields resolves
 * to ProductVariant and not to Product. All six are here; the four-name version of this list is
 * what silently degrades OrderLine and ProductVariant records after a replay.
 */
export const FIELD_SET_OP_FOR_TYPE = Object.freeze(
  Object.fromEntries(Object.entries(SET_FIELDS_TYPE).map(([op, type]) => [type, op])),
);

function normaliseFieldList(fieldList) {
  if (typeof fieldList === "string") return fieldList.split(",").map((f) => f.trim());
  if (Array.isArray(fieldList)) return fieldList.map((f) => (typeof f === "string" ? f.trim() : f));
  throw new TypeError("a field list must be a comma-separated string or an array of names");
}

/** "tns:OrderLine" -> "OrderLine". The WSDL prefixes everything; the audit speaks type names. */
const bareType = (t) => (typeof t === "string" ? t.replace(/^[^:]+:/, "") : null);

/**
 * The NESTED record collections of one complexType, from the WSDL — never a hand-written map.
 *
 * R26's audit is a rule about a batch of RECORDS, and the records this API returns are not flat:
 * an Order carries its OrderLines, a Product carries Variants, Pictures and StockLocations. R3's
 * real recorded truncation — PacketId and Status missing on ORDER LINES — lives one level down,
 * so a top-level-only audit would not have caught the defect that motivated it.
 *
 * A field qualifies when its declared type is `tns:ArrayOf*` AND that wrapper's item type is
 * itself a complexType WITH FIELDS. That second half is what keeps `ArrayOfInt` /`ArrayOfString`
 * (RelatedProductIds, LanguageAccess, PictureIds) out: those are lists of SCALARS, and auditing
 * "fields" on a string is meaningless.
 *
 * @param {string} type e.g. "Order"
 * @returns {Array<{field: string, recordType: string}>}
 */
export function nestedRecordTypes(type) {
  const detail = TYPE_DETAILS[type];
  if (!detail || !Array.isArray(detail.fields)) return [];
  const out = [];
  for (const field of detail.fields) {
    const wrapper = TYPE_DETAILS[bareType(field.type) ?? ""];
    if (!wrapper || !wrapper.arrayOf) continue;
    const item = bareType(wrapper.arrayOf);
    const itemDetail = item ? TYPE_DETAILS[item] : null;
    if (!itemDetail || !Array.isArray(itemDetail.fields) || itemDetail.fields.length === 0) continue;
    if (itemDetail.arrayOf) continue; // an array of arrays is not a record collection
    out.push({ field: field.name, recordType: item });
  }
  return out;
}

/** Count field presence across a batch. The whole batch, never record 1 (R26). */
function countFields(records, requested) {
  const counts = new Map(requested.map((f) => [f, 0]));
  const seen = new Map();
  const extra = new Set();
  let objectRecords = 0;
  for (const rec of records) {
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) continue;
    objectRecords += 1;
    for (const key of Object.keys(rec)) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
      else extra.add(key);
    }
  }
  return { counts, seen, extra, objectRecords };
}

/** The verdict for ONE batch of records of ONE type. Shared by the top level and every nesting. */
function verdict(requested, records) {
  const { counts, seen, extra, objectRecords } = countFields(records, requested);
  const decidable = objectRecords > 0;
  const presentOnAll = [];
  const partial = [];
  const truncated = [];
  for (const field of requested) {
    const n = counts.get(field);
    if (n === 0) truncated.push(field);
    else if (n === objectRecords) presentOnAll.push(field);
    else partial.push({ field, present: n, of: objectRecords });
  }
  return {
    requested,
    recordCount: records.length,
    objectRecords,
    decidable,
    presentOnAll: decidable ? presentOnAll : [],
    partial: decidable ? partial : [],
    // Undecidable means undecidable. An empty batch says nothing about the field set (R28).
    truncated: decidable ? truncated : [],
    extra: [...extra],
    fieldsSeen: [...seen].map(([field, present]) => ({ field, present, of: objectRecords })),
  };
}

/**
 * Gather one nested collection across the WHOLE batch.
 *
 * R26 is a whole-batch rule at every depth: "PacketId is missing" is only decidable over every
 * order line of every order, not over one order's lines. xml.js gives `<OrderLines><item>…</item>
 * </OrderLines>` as an array; an empty `<OrderLines/>` is null and `<OrderLines></OrderLines>` is
 * "". One level of nesting is flattened because that is the recorded R6/R18 collapse shape
 * (gaps.json sections.variants.sample), which must be counted rather than silently skipped.
 */
function gatherNested(records, field) {
  const out = [];
  for (const rec of records) {
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) continue;
    const value = rec[field];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (Array.isArray(item)) out.push(...item);
        else out.push(item);
      }
    } else out.push(value);
  }
  return out;
}

/** Field sets keyed by type, accepted as a Map or a plain object, normalised to lists. */
function normaliseFieldSets(fieldSets) {
  const out = new Map();
  if (!fieldSets) return out;
  const entries = fieldSets instanceof Map ? [...fieldSets] : Object.entries(fieldSets);
  for (const [type, list] of entries) {
    if (list === undefined || list === null) continue;
    out.set(type, normaliseFieldList(list).filter((f) => typeof f === "string" && f !== ""));
  }
  return out;
}

/**
 * Recurse into every nested record collection the WSDL declares for `type`, reporting PER RECORD
 * TYPE. A nesting is AUDITED when a field set is remembered for its type (the six *_SetFields
 * types) and SURVEYED otherwise — Product.Pictures and Product.StockLocations have no
 * *_SetFields operation at all, so there is no requested list to compare against, but their shape
 * is still reported instead of being invisible.
 */
function auditNested(type, records, fieldSets, { maxDepth, path = "", depth = 0, seenTypes = new Set() }) {
  if (!type || depth >= maxDepth || seenTypes.has(type)) return [];
  const out = [];
  const nextSeen = new Set(seenTypes).add(type);
  for (const { field, recordType } of nestedRecordTypes(type)) {
    const nested = gatherNested(records, field);
    const here = path ? `${path}.${field}` : field;
    const requested = fieldSets.get(recordType) ?? null;
    const settable = Object.prototype.hasOwnProperty.call(FIELD_SET_OP_FOR_TYPE, recordType);
    out.push({
      path: here,
      field,
      recordType,
      audited: requested !== null,
      reason: requested !== null
        ? null
        : (settable
          ? `no field set has been remembered for ${recordType} — call setFields("${recordType}", …) to audit it`
          : `${recordType} has no *_SetFields operation, so nothing was requested for it; reported as a survey`),
      ...verdict(requested ?? [], nested),
    });
    out.push(...auditNested(recordType, nested, fieldSets, { maxDepth, path: here, depth: depth + 1, seenTypes: nextSeen }));
  }
  return out;
}

/**
 * THE WHOLE-BATCH FIELD AUDIT (R26; R28 is the false positive it exists to prevent).
 *
 * `*_SetFields` is not a contract (R3): a requested field can be absent from the response with no
 * error. But fields are ALSO omitted PER RECORD when empty — SeoLink came back on 8 of 618
 * products at every page size (scale.json pages[].productMarkers.SeoLink). So:
 *
 *   present on ZERO records  -> a TRUNCATED COLUMN. The field set did not take. Raise.
 *   present on SOME records  -> an EMPTY VALUE on the others. Not an error. Reported, never raised.
 *   present on ALL records   -> fine.
 *   NO records at all        -> NOTHING IS DECIDABLE. decidable:false, truncated:[], no raise.
 *
 * The last line is not defensive padding: the probe's first cut returned truncated:true for an
 * empty result set and "customers are silently truncated" would have entered the findings when
 * the recorded fact was "this shop has zero customers" (probe-dandomain.mjs:155-167;
 * gaps.json sections.customers.audit.truncated === null with sampleAvailable false).
 *
 * And NEVER FROM RECORD 1. On this very shop, record 1 has no SeoLink; a first-record audit calls
 * SeoLink a truncated column and the migration then "knows" product URLs are unavailable.
 *
 * AND IT RECURSES. The records are not flat: R3's real recorded truncation (PacketId and Status
 * missing on ORDER LINES) is a NESTED case, so an audit that only looked at the top level would
 * not have caught the defect that motivated it. With `recordType` and `fieldSets` the same three
 * verdicts are applied to every nested record collection the WSDL declares — Order.OrderLines,
 * Product.Variants, Product.Pictures, Product.StockLocations — reported PER RECORD TYPE in
 * `nested`, with the raise driven by `truncatedByType` so a nested truncated column is as fatal
 * as a top-level one.
 *
 * @param {string|string[]} requestedFields the list handed to *_SetFields
 * @param {object[]} records the WHOLE batch, parsed by xml.js (one object per record)
 * @param {object} [options]
 *   throwOnTruncation boolean  pass false to survey instead of raising
 *   recordType        string   the WSDL complexType of `records`; required for recursion
 *   fieldSets         object   type -> requested field list, for the nested types
 *   maxDepth          number   nesting levels to walk (default 3)
 * @returns {{requested: string[], recordCount: number, objectRecords: number, decidable: boolean,
 *            presentOnAll: string[], partial: Array<{field: string, present: number, of: number}>,
 *            truncated: string[], extra: string[], recordType: string|null, nested: object[],
 *            truncatedByType: Array<{recordType: string|null, path: string, fields: string[],
 *            records: number}>}}
 * @throws {FieldSetTruncatedError} when a requested field is on ZERO of a non-empty batch, at ANY
 *   depth
 */
export function auditBatch(requestedFields, records, options = {}) {
  const requested = normaliseFieldList(requestedFields).filter((f) => typeof f === "string" && f !== "");
  if (!Array.isArray(records)) {
    throw new TypeError("auditBatch expects the WHOLE batch as an array of records (R26: never decide from record 1)");
  }
  const recordType = typeof options.recordType === "string" ? options.recordType : null;
  const fieldSets = normaliseFieldSets(options.fieldSets);
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 3;
  const nested = recordType ? auditNested(recordType, records, fieldSets, { maxDepth }) : [];

  const audit = { ...verdict(requested, records), recordType, nested };
  audit.truncatedByType = [
    ...(audit.truncated.length ? [{ recordType, path: "", fields: [...audit.truncated], records: audit.objectRecords }] : []),
    ...nested.filter((n) => n.truncated.length > 0)
      .map((n) => ({ recordType: n.recordType, path: n.path, fields: [...n.truncated], records: n.objectRecords })),
  ];

  if (audit.truncatedByType.length > 0 && options.throwOnTruncation !== false) {
    const where = audit.truncatedByType
      .map((t) => `${t.path === "" ? (t.recordType ?? "the batch") : `${t.path} (${t.recordType})`}: ` +
        `${JSON.stringify(t.fields)} on 0 of ${t.records}`)
      .join("; ");
    throw new FieldSetTruncatedError(
      `FIELD_SET_TRUNCATED: requested field(s) were absent from ALL records of a record type — ` +
      `${where}. That is a truncated column, not an empty value (R26); a NESTED one is R3's own ` +
      "recorded case (PacketId and Status missing on order lines). The field set did not take; " +
      "do not migrate this batch.",
      {
        audit,
        truncated: audit.truncated,
        truncatedByType: audit.truncatedByType,
        code: "FIELD_SET_TRUNCATED",
      },
    );
  }
  return audit;
}

// ---------------------------------------------------------------------------------------------
// Paged reads
// ---------------------------------------------------------------------------------------------

export const PAGINATION_STYLE = Object.freeze({ OFFSET: "offset", PAGE: "page" });

/**
 * Which pagination shape an operation declares, read from its WSDL argument names.
 *
 * THE TRAP: `Start` is NOT an offset in four of the six paginated operations.
 * Order_GetByDateWithPagination and friends take (Start, End, Status, Page, PageSize) where
 * Start/End are DATE STRINGS ("2019-01-01 00:00:00" — gaps.json sections.orderGetByDate). Only
 * Product_GetAllWithLimit's (Start, Length) is an offset pair. That is why the offset rule
 * requires Start AND Length together, and why Page/PageSize is tested first.
 */
export function paginationStyleFor(op) {
  const names = argNamesFor(op);
  if (names.includes("Page") && names.includes("PageSize")) return PAGINATION_STYLE.PAGE;
  if (names.includes("Start") && names.includes("Length")) return PAGINATION_STYLE.OFFSET;
  return null;
}

/** The operations this client can page. Derived from the WSDL, not a hand-kept list. */
export const PAGINATED_OPERATIONS = Object.freeze(operationNames().filter((op) => paginationStyleFor(op) !== null));

/**
 * The complexType one record of a list operation is, from the WSDL's own resultItemType
 * ("tns:Product" -> "Product"), or null for a non-list operation. This is what lets readAll()
 * pick the right remembered field set to audit against (R26) without a hand-written op->type map.
 */
export function recordTypeOf(op) {
  const item = operationFor(op).resultItemType;
  return typeof item === "string" ? item.replace(/^[^:]+:/, "") : null;
}

/**
 * THE PAGE-NUMBER BASE IS 1, AND THE EVIDENCE TRAVELS WITH IT RATHER THAN BEING A COMMENT.
 *
 * History, because the shape of this object is the history. The first version of this file
 * ASSUMED 1 and used it as a silent default. Against a 0-based server that skips the entire first
 * page and still reports a complete read, which is the exact class of loss this client exists to
 * prevent, so H3 removed the assumption and made `readPages` refuse to start without an explicit
 * `pageBase`. At that point nothing in data/probes/ settled the question: P1's only recording of a
 * *WithPagination call was the PHP arity fault (gaps.json faults[0]), which never reached the
 * paging code. The refusal was correct FOR THAT STATE OF THE EVIDENCE.
 *
 * data/probes/pagebase.json then settled it, by two methods that can fail independently:
 *
 *   1. A WALK CHECKED AGAINST AN INDEPENDENT TRUTH SET. Order_GetByDate (Status omitted — R16)
 *      returned all 20 orders. Walking Order_GetAllWithPagination from page 1 at PageSize 5 gave
 *      5+5+5+5+0 rows = the same 20 ids, 0 duplicates, 0 missing, 0 extra. Walking from page 0
 *      never started. The decision is a set comparison against a DIFFERENT operation, not a reply
 *      code, and not this client's own detectPageBase — testing the detector with the detector
 *      would have proved nothing.
 *   2. THE SERVER SAID SO, FOUR TIMES. `Page=0` is refused with
 *      `PARAM: Page must be greater than 0` on Order_GetAllWithPagination,
 *      Order_GetByDateWithPagination, Order_GetByDateUpdatedWithPagination and
 *      Order_GetByStatusWithPagination — four entry points into the same validator in
 *      service.php. That is a platform property, not one operation's quirk.
 *
 * WHAT IS STILL NOT PROVED, and why `detect` and the override stay:
 *   - ONE SHOP (shop000000). A second shop has never been asked.
 *   - Product_GetDiscountsAccumulativeAllWithPagination is SILENT, not agreeing: both candidate
 *     first pages returned zero rows because the shop has no accumulative discounts. An empty
 *     result set answers nothing, and it is recorded as silent rather than folded into the count.
 *
 * The OFFSET style needs no such decision: the probe called Product_GetAllWithLimit with Start:0
 * and got the catalogue (probe-dandomain.mjs:218), so 0-based offsets are recorded fact.
 */
export const SOAP_PAGE_BASE = Object.freeze({
  verified: true,
  value: 1,
  candidates: Object.freeze([0, 1]),
  source: "data/probes/pagebase.json",
  why: "Two independent methods on shop000000. (1) Walking Order_GetAllWithPagination from page 1 " +
    "reproduced an INDEPENDENT 20-order truth set from Order_GetByDate exactly once per record " +
    "(0 duplicates, 0 missing, 0 extra); walking from page 0 never started. (2) The server refuses " +
    'Page=0 in its own words — "PARAM: Page must be greater than 0" — on FOUR different ' +
    "*WithPagination operations, i.e. from one shared validator in service.php.",
  scope: Object.freeze({
    shops: Object.freeze(["shop000000"]),
    agreed: Object.freeze([
      "Order_GetAllWithPagination",
      "Order_GetByDateWithPagination",
      "Order_GetByDateUpdatedWithPagination",
      "Order_GetByStatusWithPagination",
    ]),
    /** Asked and answered nothing: the shop has no rows for it, and an empty result set cannot
     *  distinguish a 0-based server from a 1-based one. Not counted as agreement. */
    silent: Object.freeze(["Product_GetDiscountsAccumulativeAllWithPagination"]),
  }),
  openQuestion: "no SECOND SHOP has been asked. If a future source shop is 0-based, defaulting to 1 " +
    "skips its first page silently — so the default is overridable per client and per call, and " +
    '{ pageBase: "detect" } settles it against that shop for 1-2 extra requests.',
  howToOverride: 'per call: { pageBase: 0 | 1 | "detect" }. Per client: ' +
    'createClient({ defaultPageBase: 0 | 1 | "detect" | null }) — null restores H3\'s refusal, so a ' +
    "new shop can be made to prove its own base before anything is exported.",
});

/**
 * Cheap "did the server give me the same page again?" probe. Ids when every record has one
 * (`Id`, the SOAP spelling, or `id`), otherwise the whole page by value — which CAN false
 * positive on a keyless selection whose rows repeat, exactly as documented on graphql.js's
 * rowSignature. Here it fires as a loud PaginationError rather than a silent short read, so a
 * false positive costs a failed export and never a quietly truncated one.
 */
function pageSignature(records) {
  if (!Array.isArray(records) || records.length === 0) return "[]";
  const ids = records.map((r) => (r && typeof r === "object" ? (r.Id ?? r.id) : undefined));
  if (ids.every((v) => v !== undefined)) return `ids:${JSON.stringify(ids)}`;
  try {
    return `rows:${JSON.stringify(records)}`;
  } catch {
    return `len:${records.length}`;
  }
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

/**
 * The tri-transport facade.
 *
 * SOAP is implemented here; `ftp()` and `graphql()` hand back the other two transports built from
 * the same configuration object, lazily, so constructing a client opens nothing.
 */
export class DanDomainClient {
  #password;
  #fetch;
  #bucket;
  #gate;
  #fieldSets = new Map(); // type -> { op, fields[], sent } — insertion order IS re-assertion order
  #connecting = null;
  #reasserting = false;
  #graphqlClient = null;
  #ftpFacade = null;

  /**
   * @param {object} options
   * @param {string} options.username SOAP employee username (app access "API")
   * @param {string} options.password SOAP password
   * @param {string} [options.endpoint] defaults to operations.ENDPOINT, which is read from the
   *   WSDL's <soap:address> (F1). Never hardcode a URL over this.
   * @param {Function} [options.fetchImpl] injected fetch; resolved at CALL time, so importing
   *   this module never touches a global
   * @param {number} [options.timeoutMs=30000]
   * @param {"utf-8"|"latin1"} [options.requestEncoding] see the note below
   * @param {boolean} [options.refuseNonAsciiWrites=true] see the note below
   * @param {boolean} [options.reassertOnFault=true] R4; see reassertFieldSets()
   * @param {{capacity?: number, refillPerSecond?: number, now?: Function, sleep?: Function}} [options.throttle]
   * @param {number} [options.maxConcurrent=1] R4: the field set is session-global state
   * @param {0|1|"detect"|null} [options.defaultPageBase] page base when a call names none.
   *   Defaults to SOAP_PAGE_BASE.value; null restores H3's refusal for an unproved shop.
   * @param {object} [options.graphql] { tenant|baseUrl, clientId, clientSecret, … } or { client }
   * @param {object} [options.ftp] { host, user, pass, modes?, port?, tlsOptions?, … }
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint ?? ENDPOINT;
    this.namespace = options.namespace ?? SOURCE.targetNamespace;
    this.username = options.username ?? null;
    this.#password = options.password ?? null;
    this.#fetch = options.fetchImpl ?? null;
    this.timeoutMs = options.timeoutMs ?? 30000;

    /**
     * REQUEST-BODY ENCODING IS UNRESOLVED FOR NON-ASCII WRITES, and this client refuses rather
     * than guesses.
     *
     * The one recorded live attempt (probe-dandomain.mjs:74-76) sent UTF-8 bytes and the shop
     * stored "Æblegrød" as "?blegr?d" — Hostedshop is a windows-1252/latin1 stack. The obvious
     * remedy, Solution_SetEncoding("UTF-8"), is F2 and is strictly worse ("?r? ??? ???",
     * irreversible). Sending latin1 bytes instead was left as a probe VARIABLE and no recording
     * shows it succeeding either. So P1 knows how to break this and does not know how to do it.
     *
     * Consequence: with the default settings, a MUTATING call whose body contains a non-ASCII
     * character throws UnresolvedWriteEncodingError. Reads are untouched (a read cannot corrupt
     * stored data), and setting `requestEncoding` explicitly is the deliberate opt-in that says
     * "I have probed this, I accept the outcome". This is a LOCAL POLICY, clearly not a probed
     * fact — but silently writing "?" into a customer's product title is not recoverable, and an
     * exception is.
     */
    this.requestEncoding = options.requestEncoding ?? "utf-8";
    this.requestEncodingExplicit = options.requestEncoding !== undefined;
    this.refuseNonAsciiWrites = options.refuseNonAsciiWrites !== false;
    this.reassertOnFault = options.reassertOnFault !== false;

    this.#bucket = createTokenBucket({
      capacity: options.throttle?.capacity ?? 1,
      refillPerSecond: options.throttle?.refillPerSecond ?? Infinity,
      now: options.throttle?.now,
      sleep: options.throttle?.sleep,
    });
    this.#gate = createGate(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);

    /**
     * H6 — the bounded transport retry. See SOAP_RETRY_DEFAULTS for why the three numbers are
     * local policy rather than probed facts, and #sendWithTransportRetry for what is and is not
     * eligible. `{ retry: { sleep, random } }` is how a test pins the backoff.
     */
    this.retryOptions = options.retry ?? null;

    /** Session cookies, name -> value. Public so a test (or an operator) can inspect or break it. */
    this.cookies = new Map();
    this.connectedAt = null;
    this.stats = {
      requests: 0, faults: 0, reconnects: 0, replays: 0, fieldSetAsserts: 0, bytesIn: 0,
      /** H6: attempts spent re-sending after a TRANSPORT failure. Never a fault, never a create. */
      transportRetries: 0,
    };

    /**
     * The page-number base a PAGE-style walk uses when the call does not name one.
     *
     * Defaults to SOAP_PAGE_BASE.value (1, recorded in data/probes/pagebase.json against
     * shop000000 by two independent methods). `null` restores H3's refusal — a walk with no
     * explicit `{ pageBase }` then throws PageBaseUnverifiedError and sends nothing, which is what
     * a NEW SHOP should be onboarded with until it has proved its own base. `"detect"` makes every
     * walk ask the server instead of trusting the recorded value.
     *
     * `defaultPageBaseExplicit` is what lets the walk's evidence distinguish "an operator chose
     * this for this shop" from "the repo's recorded default was used" — the second is a weaker
     * claim and must not be reported as the first.
     */
    this.defaultPageBase = options.defaultPageBase !== undefined
      ? options.defaultPageBase
      : (SOAP_PAGE_BASE.verified ? SOAP_PAGE_BASE.value : null);
    this.defaultPageBaseExplicit = options.defaultPageBase !== undefined;
    if (![0, 1, "detect", null].includes(this.defaultPageBase)) {
      throw new PaginationError(
        `defaultPageBase must be 0, 1, "detect" or null, got ${JSON.stringify(this.defaultPageBase)}.`,
        { defaultPageBase: this.defaultPageBase },
      );
    }

    this.graphqlOptions = options.graphql ?? null;
    this.ftpOptions = options.ftp ?? null;
    this.authReason = options.authReason ?? AUTH_REASON_RE;
  }

  /** Resolved at call time, so importing this module never reads a global (invariant #4). */
  get fetchImpl() {
    const f = this.#fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new SoapTransportError("no fetch implementation available — pass { fetchImpl }");
    return f;
  }

  get throttle() { return this.#bucket; }

  get connected() { return this.cookies.size > 0; }

  /** A snapshot of the remembered field sets, in re-assertion order. */
  fieldSets() {
    return [...this.#fieldSets.entries()].map(([type, v]) => ({ type, op: v.op, fields: [...v.fields], sent: v.sent }));
  }

  /** The field list currently believed active for a type, or null. */
  activeFields(type) {
    const entry = this.#fieldSets.get(type);
    return entry ? [...entry.fields] : null;
  }

  // -------------------------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------------------------

  /**
   * Solution_Connect, store cookies. NOTHING ELSE — specifically, never Solution_SetEncoding (F2).
   *
   * Re-asserts every remembered field set afterwards, because a NEW SESSION HAS THE DEFAULT FIELD
   * SET (R4: "the output format includes the Id" and nothing more). On a first connect there is
   * nothing to re-assert and this costs no calls.
   *
   * Concurrent callers share one in-flight connect.
   */
  async connect() {
    if (this.#connecting) return this.#connecting;
    if (!this.username || !this.#password) {
      throw new DanDomainClientError("connect() needs { username, password }");
    }
    const run = (async () => {
      this.cookies.clear(); // a stale cookie must not travel with the login
      let res;
      try {
        res = await this.#send("Solution_Connect", { Username: this.username, Password: this.#password }, {});
      } catch (err) {
        if (!(err instanceof SoapFaultError)) throw err;
        this.stats.faults += 1;
        const cls = classifyFault(err, { authReason: this.authReason });
        // An AUTH fault ON THE LOGIN ITSELF is bad credentials, not a stale session. Reconnecting
        // would loop forever, so this is the one place the AUTH kind is NOT recoverable.
        throw this.#faultError("Solution_Connect", err, cls, {
          reconnected: false,
          replayed: false,
          retryable: false,
          duringConnect: true,
        });
      }
      this.connectedAt = Date.now();
      // R4: a NEW SESSION HAS THE DEFAULT FIELD SET. Re-assert inside the shared promise so a
      // concurrent caller cannot read through a half-configured session.
      await this.reassertFieldSets("connect");
      return { ok: true, result: res.result, cookies: [...this.cookies.keys()] };
    })();
    this.#connecting = run.finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  /**
   * R4 — re-establish every remembered field set. Called after a reconnect and (by default) after
   * ANY fault, because the brief's rule is written that way: "the client MUST re-assert every
   * field set after any fault or reconnect, or the replayed read silently returns a smaller
   * record". Re-asserting after a non-AUTH fault is usually redundant — the session is intact —
   * and it costs one round trip per remembered type. That cost is the price of never having to
   * reason about which faults did and did not reset the session; set { reassertOnFault: false }
   * to take the other trade deliberately.
   *
   * Re-entrant calls are suppressed: while re-asserting, a fault does not trigger another
   * re-assertion and an AUTH fault does not trigger a nested reconnect. A failure here is FATAL
   * (FieldSetReassertError) rather than swallowed — continuing with an unknown record shape is
   * precisely the silent-smaller-record failure this exists to stop.
   */
  async reassertFieldSets(why = "manual") {
    if (this.#fieldSets.size === 0 || this.#reasserting) return { asserted: [], skipped: true, why };
    this.#reasserting = true;
    const asserted = [];
    try {
      for (const [type, entry] of this.#fieldSets) {
        try {
          await this.#send(entry.op, { Fields: entry.sent }, {});
        } catch (cause) {
          throw new FieldSetReassertError(
            `could not re-assert the ${type} field set via ${entry.op} after ${why}: ${cause.message}. ` +
            "The session's record shape is now UNKNOWN — a read from here would silently return a " +
            "different shape with no error (R4).",
            { type, op: entry.op, fields: [...entry.fields], why, cause },
          );
        }
        this.stats.fieldSetAsserts += 1;
        asserted.push(type);
      }
    } finally {
      this.#reasserting = false;
    }
    return { asserted, skipped: false, why };
  }

  /**
   * R4 — set (and remember) a field set for one of the six field-set types.
   *
   * This is a thin wrapper: the validation and the remembering both live in call(), so a caller
   * who reaches for `call("Product_SetFields", …)` directly gets exactly the same protection.
   * That matters — a field set established through an unguarded path would be unvalidated AND
   * unremembered, so it would silently revert to the default on the next reconnect.
   *
   * @param {string} type e.g. "Product", "OrderLine", "ProductVariant"
   * @param {string|string[]} fieldList
   */
  async setFields(type, fieldList) {
    const op = FIELD_SET_OP_FOR_TYPE[type];
    if (!op) {
      throw new FieldListError(
        `"${type}" has no *_SetFields operation. The six field-set types are ` +
        `${JSON.stringify(Object.keys(FIELD_SET_OP_FOR_TYPE))} (operations.SET_FIELDS_TYPE, parsed ` +
        "from each operation's own WSDL documentation).",
        { type },
      );
    }
    const fields = normaliseFieldList(fieldList);
    await this.call(op, { Fields: fields.join(",") });
    return { type, op, ...this.#fieldSets.get(type), fields: [...fields] };
  }

  /**
   * R4 — the pre-flight every *_SetFields call goes through, wherever it was called from.
   * Validated against the complexType the WSDL's own documentation binds to that operation
   * (SET_FIELDS_TYPE), because the operation NAME does not give it: Product_SetVariantFields
   * validates against ProductVariant, not Product.
   */
  #checkFieldSetCall(op, args) {
    const type = SET_FIELDS_TYPE[op];
    const list = args?.Fields;
    if (typeof list !== "string" && !Array.isArray(list)) {
      throw new FieldListError(
        `${op} takes a single comma-separated "Fields" string; got ${typeof list}.`,
        { op, type },
      );
    }
    const check = validateFields(type, list);
    if (!check.ok) {
      throw new FieldListError(
        `${op}: ${JSON.stringify(check.invalid)} ${check.invalid.length === 1 ? "is not a field" : "are not fields"} ` +
        `of ${type}. Sending it would fault the whole call AND leave the session on its PREVIOUS ` +
        "field set, so the next read would succeed with the wrong shape and no error (R4). " +
        "No request was sent.",
        { type, op, invalid: check.invalid },
      );
    }
  }

  /** Forget a remembered field set (it is NOT reset on the server — that needs another call). */
  forgetFieldSet(type) {
    return this.#fieldSets.delete(type);
  }

  // -------------------------------------------------------------------------------------------
  // The call
  // -------------------------------------------------------------------------------------------

  /**
   * Call one SOAP operation.
   *
   * Order of operations, and every step is load-bearing:
   *   1. F2   — refuse FORBIDDEN_OPERATIONS. Before the throttle, before the socket.
   *   2. R27  — refuse an operation the WSDL does not declare (operationFor throws).
   *   3. R17  — validateArgs: unknown names and absent NON-nillable arguments fail here, with no
   *             request. Absent NILLABLE arguments are advisory only (gaps.json proves
   *             Order_GetByDate works with Status omitted entirely).
   *   4. build the envelope in WSDL sequence order, honouring the undefined/null contract.
   *   5. throttle (token bucket) and gate (concurrency).
   *   6. POST, capture cookies, read raw BYTES.
   *   7. parse via xml.js: explicit UTF-8, mojibake throws, asRecords only where the WSDL says
   *      the result is ArrayOf*.
   *   8. classify any fault; AUTH may reconnect once and replay IDEMPOTENT READS ONLY.
   *
   * @param {string} op
   * @param {object} [args]
   * @param {object} [options]
   *   replay          boolean  false disables the AUTH replay for this call. It can never ENABLE
   *                            replay for a write — see isReplayable().
   *   parse           object   forwarded to xml.js parseSoapResponse (arrayElements, trimText,
   *                            failOnMojibake, nilAsNull)
   *   timeoutMs       number
   *   signal          AbortSignal
   *   reassertOnFault boolean  overrides the client default for this call
   * @returns {Promise<{op: string, result: *, records: object[]|null, isList: boolean,
   *                    ms: number, status: number, mojibake: boolean, decodedAs: string,
   *                    text: string, replayed: boolean}>}
   */
  async call(op, args = {}, options = {}) {
    // 1. F2 — the design doc says to call this. The design doc is wrong.
    assertNotForbidden(op);
    // 2. R27 — never guess about an operation the WSDL does not declare.
    operationFor(op);

    // 3. R17/R27 — argument NAMES, before the wire.
    const check = validateArgs(op, args);
    if (!check.ok) {
      throw new ArgumentNameError(
        `${op}: ${check.unknown.length ? `unknown argument name(s) ${JSON.stringify(check.unknown)}; ` : ""}` +
        `${check.missingRequired.length ? `missing required argument(s) ${JSON.stringify(check.missingRequired)}; ` : ""}` +
        `declared arguments are ${JSON.stringify(argNamesFor(op))}. Unknown names are DROPPED in ` +
        'flight and come back as "Too few arguments to function WebService::' + op + '()" — a NAME ' +
        "error, not a transient (R17/R27, gaps.json faults[0]). No request was sent.",
        { op, ...check },
      );
    }

    // R4 — a *_SetFields list is validated here, not only in setFields(), so there is no path
    // that can put an unvalidated (or unremembered) field set on the session.
    const isFieldSetCall = FIELD_SET_OPERATIONS.includes(op);
    if (isFieldSetCall) this.#checkFieldSetCall(op, args);

    const replayAllowed = isReplayable(op) && options.replay !== false;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await this.#sendWithTransportRetry(op, args, options, replayAllowed);
        if (isFieldSetCall) {
          // Only AFTER the server accepted it. A faulted *_SetFields leaves the session on its
          // PREVIOUS field set, so the memory must still describe that previous set (R4).
          const type = SET_FIELDS_TYPE[op];
          const fields = normaliseFieldList(args.Fields);
          this.#fieldSets.set(type, { op, fields, sent: fields.join(",") });
          this.stats.fieldSetAsserts += 1;
        }
        return { ...res, replayed: attempt > 1 };
      } catch (err) {
        if (!(err instanceof SoapFaultError)) throw err;
        this.stats.faults += 1;
        const cls = classifyFault(err, { authReason: this.authReason });

        /**
         * R34 — NILLABLE IS NOT OMISSIBLE, and the arity message does not say so.
         *
         * validateArgs (above) lets a `nillable="true"` argument be absent, on the reading that
         * nillable means optional. The WSDL's nillable describes the VALUE (it may be null), and
         * PHP counts POSITIONS: data/probes/pagebase.json recorded that omitting the nillable
         * `Status` on all THREE *WithPagination operations that declare it returns
         * "Too few arguments … 4 passed … exactly 5 expected", not an empty selection. Meanwhile
         * omitting it on Order_GetByDate DOES work (R16 — that is how pagebase.json built its
         * truth set), so the rule is PER-OPERATION and cannot be read out of the schema. The
         * validator therefore stays permissive and the DIAGNOSIS is fixed instead: classifyFault
         * says "an ARGUMENT NAME was wrong", which for this cause sends the reader hunting for a
         * misspelling that is not there.
         */
        const arityHint = cls.kind === FAULT_KIND.ARITY && check.missingNillable.length
          ? {
            omittedNillableArgs: check.missingNillable,
            omittedNillableWhy:
              `this call omitted ${JSON.stringify(check.missingNillable)}, declared nillable by the ` +
              "WSDL. Nillable describes the VALUE, not the presence: PHP counts positional " +
              "arguments, so an OMITTED nillable argument produces the same arity fault as a " +
              "misspelled one. Recorded on Order_GetByDateWithPagination, " +
              "Order_GetByDateUpdatedWithPagination and Order_GetByStatusWithPagination " +
              "(data/probes/pagebase.json statusOnPaginatedVariants). Send the argument " +
              "explicitly before looking for a typo.",
          }
          : {};

        // Session: reconnect ONCE, then replay idempotent reads only (F16 forbids replaying a
        // create, and the replay allow-list is derived from the WSDL, not from this call site).
        if (cls.kind === FAULT_KIND.AUTH && attempt === 1 && !this.#reasserting && !this.#connecting && this.username) {
          this.stats.reconnects += 1;
          try {
            await this.connect(); // connect() re-asserts every remembered field set (R4)
          } catch (recovery) {
            // H4 — the RECOVERY failed. The AUTH fault is the diagnosis and must survive; the
            // reconnect failure is a second, different problem and gets its own named error.
            throw this.#postFaultError(op, this.#faultError(op, err, cls, { reconnected: false, replayed: false, ...arityHint }), recovery, "reconnect");
          }
          if (replayAllowed) {
            this.stats.replays += 1;
            continue;
          }
          throw this.#faultError(op, err, cls, { reconnected: true, replayed: false, ...arityHint });
        }

        // R4 — re-assert after ANY fault. Suppressed while re-asserting (no recursion) and
        // skipped when the AUTH branch above already reconnected (which re-asserts).
        const reassert = options.reassertOnFault ?? this.reassertOnFault;
        if (reassert && !this.#reasserting) {
          try {
            await this.reassertFieldSets(`fault:${cls.kind}`);
          } catch (recovery) {
            // H4 — same rule one branch down: the original fault is never replaced by the failure
            // of the thing that ran to recover from it.
            throw this.#postFaultError(op, this.#faultError(op, err, cls, { reconnected: false, replayed: attempt > 1, ...arityHint }), recovery, "reassert");
          }
        }
        throw this.#faultError(op, err, cls, { reconnected: false, replayed: attempt > 1, ...arityHint });
      }
    }
  }

  /**
   * H6 — ONE operation, retried at the TRANSPORT level only.
   *
   * `#send` throws SoapFaultError for anything the server decided and SoapTransportError for
   * everything else (no response, a socket error, a timeout, an HTTP status carrying no SOAP).
   * Only the second kind is repeated, and only when the operation is on the WSDL-derived
   * REPLAYABLE allow-list — a transport error carries NO information about whether the server
   * already acted, so re-sending Order_Create is exactly how F16's "throws after succeeding"
   * becomes two orders. A refusal is not silent: the error carries `.retryRefusedBecause`.
   *
   * The caller's `{ replay: false }` disables this too, because "do not repeat this call" should
   * be one switch and not two.
   */
  async #sendWithTransportRetry(op, args, options, repeatAllowed) {
    const policy = resolveRetryPolicy(this.retryOptions, options.retry);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const res = await this.#send(op, args, options);
        res.transportAttempts = attempts;
        return res;
      } catch (err) {
        if (!(err instanceof SoapTransportError)) throw err; // a FAULT is a decision, never a blip
        err.transportAttempts = attempts;
        if (!repeatAllowed) {
          err.retryRefusedBecause =
            `${op} is not replayable (it is not on the WSDL-derived REPLAYABLE_OPERATIONS ` +
            "allow-list, or the caller passed { replay: false }). A transport error says NOTHING " +
            "about whether the server already acted — re-sending a create is how F16's " +
            '"Order: N created" fault becomes two orders. Sent exactly once.';
          throw err;
        }
        if (attempts >= policy.maxAttempts) {
          err.retryRefusedBecause =
            `the bounded transport retry is exhausted (maxAttempts ${policy.maxAttempts}).`;
          err.message =
            `${err.message} — gave up after ${attempts} attempt(s) of bounded, jittered transport retry`;
          throw err;
        }
        this.stats.transportRetries += 1;
        await policy.sleep(backoffDelay(policy, attempts));
      }
    }
  }

  /**
   * H4 — TWO things are wrong and BOTH are reported.
   *
   * A fault triggers a recovery (the single AUTH reconnect, or R4's field-set re-assertion). When
   * the recovery ALSO fails, the naive shape is to let the recovery's exception propagate — and
   * that DELETES the diagnosis: the operator sees "could not re-assert Product" and never learns
   * that the read faulted with INTERNAL in the first place. So the original fault is carried on
   * `.originalFault`, the recovery failure on `.reassertError`, `.phase` says which recovery it
   * was, and the message contains both. It is deliberately NOT a DanDomainFaultError: after a
   * failed recovery the session's record shape is UNKNOWN, which is strictly worse than the fault,
   * and a caller who switches on fault kinds must not be able to treat it as one of them.
   */
  #postFaultError(op, originalFault, recoveryError, phase) {
    const what = phase === "reconnect" ? "the AUTH reconnect" : "the R4 field-set re-assertion";
    return new PostFaultReassertError(
      `${originalFault.message} — AND ${what} that ran to recover from it ALSO FAILED: ` +
      `${recoveryError.message} Two independent things are wrong: the original fault is on ` +
      "`.originalFault` (it is the diagnosis and a failed recovery must never delete it) and the " +
      "recovery failure is on `.reassertError`.",
      {
        op,
        phase,
        originalFault,
        reassertError: recoveryError,
        // Copied up so the shape a plain FieldSetReassertError has is not lost by the wrapping.
        type: recoveryError.type ?? null,
        fields: recoveryError.fields ?? null,
        kind: originalFault.kind,
        code: originalFault.code,
        reason: originalFault.reason,
        cause: recoveryError,
      },
    );
  }

  #faultError(op, fault, cls, extra) {
    return new DanDomainFaultError(`${op} faulted [${cls.kind}] ${cls.code ?? "?"}: ${cls.reason}`, {
      op,
      kind: cls.kind,
      code: cls.code,
      reason: cls.reason,
      fatal: cls.fatal,
      retryable: cls.retryable,
      created: cls.created ?? false,
      orderId: cls.orderId ?? null,
      arity: cls.arity ?? null,
      why: cls.why,
      detail: fault.detail ?? null,
      raw: fault.raw,
      cause: fault,
      ...extra,
    });
  }

  /** One HTTP round trip. No fault classification, no replay — call() owns those. */
  async #send(op, args, options) {
    // F2 again. UNREACHABLE from the current public surface — connect() passes a literal and the
    // R4 re-assertion loop passes a remembered *_SetFields name — and deliberately kept anyway:
    // #send is the socket, and a future code path that reaches it without going through call()
    // must not be able to emit the one call that destroys data. test/client.test.mjs asserts both
    // entrances are guarded structurally, since no behavioural test can reach this one.
    assertNotForbidden(op);
    const spec = operationFor(op);
    const encoding = this.requestEncoding;
    const xml = buildEnvelope(op, args, {
      namespace: this.namespace,
      encoding: encoding === "latin1" ? "ISO-8859-1" : "UTF-8",
    });

    // The unresolved non-ASCII WRITE question. Reads are exempt: a read cannot corrupt the shop.
    if (this.refuseNonAsciiWrites && !this.requestEncodingExplicit && !REPLAYABLE_OPERATIONS.has(op) && NON_ASCII_RE.test(xml)) {
      throw new UnresolvedWriteEncodingError(
        `${op} is a WRITE carrying non-ASCII characters and the request encoding has not been ` +
        "resolved for this shop. The one live attempt sent UTF-8 bytes and stored \"Æblegrød\" as " +
        '"?blegr?d" (probe-dandomain.mjs:74-76); the F2 encoding call is worse still. Choose ' +
        'deliberately with { requestEncoding: "utf-8" } or { requestEncoding: "latin1" }, or set ' +
        "{ refuseNonAsciiWrites: false }. No request was sent.",
        { op, requestEncoding: encoding },
      );
    }

    const body = encodeRequestBody(xml, encoding);
    const charset = encoding === "latin1" ? "iso-8859-1" : "utf-8";
    const headers = {
      // F1: the SOAPAction comes from the WSDL's binding, not from a `${ns}#${op}` guess.
      "content-type": `application/soap+xml; charset=${charset}; action="${spec.soapAction}"`,
    };
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.cookie = cookie;

    await this.#bucket.take();
    await this.#gate.acquire();
    const started = Date.now();
    let res;
    try {
      try {
        res = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers,
          body,
          signal: options.signal ?? this.#timeoutSignal(options.timeoutMs ?? this.timeoutMs),
        });
      } catch (cause) {
        throw new SoapTransportError(`${op}: request to ${this.endpoint} failed: ${cause.message}`, { op, cause });
      }
      this.stats.requests += 1;
      this.#storeCookies(res);

      // Raw BYTES, never res.text(): the declared charset is not trusted (F2) and xml.js decodes
      // UTF-8 explicitly with a windows-1252 fallback.
      let bytes;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (cause) {
        throw new SoapTransportError(`${op}: could not read the response body: ${cause.message}`, { op, cause });
      }
      this.stats.bytesIn += bytes.byteLength;

      const isList = Boolean(spec.resultItemType);
      let parsed;
      try {
        parsed = parseSoapResponse(bytes, op, { resultIsArray: isList, ...(options.parse ?? {}) });
      } catch (err) {
        // A SOAP 1.2 fault legitimately arrives with HTTP 500, so the fault path must survive a
        // non-2xx status. Only a body that is not parseable SOAP becomes a transport error.
        if (err instanceof XmlParseError && !res.ok) {
          // `.source` is only set for a MALFORMED document; "well-formed but not SOAP" (an nginx
          // 502 page is valid XML) arrives without it, so the snippet is taken from the bytes.
          throw new SoapTransportError(`${op}: HTTP ${res.status} and the body is not SOAP`, {
            op,
            status: res.status,
            body: err.source ?? decodeResponseBytes(bytes).text.slice(0, SOURCE_SNIPPET_LIMIT),
            cause: err,
          });
        }
        throw err;
      }
      // A SOAP 1.2 fault carried by HTTP 500 has ALREADY thrown above (parseSoapResponse raises
      // SoapFaultError before this line), so reaching here with a bad status means the body parsed
      // as a normal response while the transport said failure. That is not a fault to classify.
      if (!res.ok) {
        throw new SoapTransportError(`${op}: HTTP ${res.status} with a parseable but non-fault body`, {
          op, status: res.status, body: parsed.text.slice(0, SOURCE_SNIPPET_LIMIT),
        });
      }
      return {
        op,
        result: parsed.result,
        records: isList ? asRecords(parsed.result) : null,
        isList,
        ms: Date.now() - started,
        status: res.status,
        mojibake: parsed.mojibake,
        decodedAs: parsed.decodedAs,
        text: parsed.text,
      };
    } finally {
      this.#gate.release();
    }
  }

  #timeoutSignal(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
  }

  #storeCookies(res) {
    let raw = [];
    try {
      raw = typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      if (raw.length === 0) {
        const single = res.headers?.get?.("set-cookie");
        if (single) raw = [single];
      }
    } catch { raw = []; }
    for (const line of raw) {
      const m = /^\s*([^=;\s]+)=([^;]*)/.exec(line);
      if (m) this.cookies.set(m[1], m[2]);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Paged reads
  // -------------------------------------------------------------------------------------------

  /**
   * Establish the PAGE-NUMBER BASE empirically, because SOAP_PAGE_BASE.verified is false.
   *
   * Two probes, and a decision only where the two answers can only mean one thing:
   *
   *   page 0 FAULTS (anything but AUTH)      -> 1-based. The server rejected page 0 outright.
   *   page 0 empty,     page 1 has rows      -> 1-based. Page 0 is not a page.
   *   page 0 has rows,  page 1 empty         -> 0-based. A 1-based server clamping 0 onto 1 would
   *                                             have answered page 1 with those same rows.
   *   both have rows, DIFFERENT rows         -> 0-based. Page 0 is real data, page 1 is the next.
   *   both have rows, the SAME rows          -> UNDECIDABLE. The server clamps; either base could
   *                                             produce this. Throws — a guess here silently drops
   *                                             or duplicates a whole page.
   *   both empty                             -> the RESULT SET is empty. Both candidate first
   *                                             pages answered zero rows, which is the same
   *                                             two-observation corroboration readPages uses to
   *                                             end a walk. `decided` stays false and the walk
   *                                             returns zero records rather than claiming a base.
   *
   * An AUTH fault is re-thrown rather than read as evidence: it is a session problem, not a
   * statement about page numbering (call() has already tried its one reconnect by then).
   *
   * @returns {Promise<{base: number, decided: boolean, why: string, probes: object[]}>}
   */
  async detectPageBase(op, options = {}) {
    if (paginationStyleFor(op) !== PAGINATION_STYLE.PAGE) {
      throw new PaginationError(`${op} is not a Page/PageSize operation; there is no page base to detect.`, { op });
    }
    const pageSize = options.pageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new PaginationError(`detectPageBase("${op}") requires an explicit integer pageSize >= 1.`, { op, pageSize });
    }
    const args = options.args ?? {};
    const probe = async (page) => {
      const res = await this.call(op, { ...args, Page: page, PageSize: pageSize }, options.call ?? {});
      const records = res.records ?? asRecords(res.result);
      return { page, rows: records.length, signature: pageSignature(records) };
    };

    let zero = null;
    let zeroFault = null;
    try {
      zero = await probe(0);
    } catch (err) {
      if (!(err instanceof DanDomainFaultError) || err.kind === FAULT_KIND.AUTH) throw err;
      zeroFault = err;
    }
    if (zeroFault) {
      return {
        base: 1, decided: true,
        why: `Page=0 faulted [${zeroFault.kind}] ${zeroFault.code ?? "?"}, so 0 is not a page number on this server.`,
        probes: [{ page: 0, fault: zeroFault.code ?? null, kind: zeroFault.kind }],
      };
    }
    const one = await probe(1);
    const probes = [zero, one];
    if (zero.rows === 0 && one.rows === 0) {
      return {
        base: 1, decided: false,
        why: "both candidate first pages (0 and 1) returned ZERO rows: the result set is empty, so " +
          "no base is decidable and none is claimed. Nothing can be lost by walking from 1.",
        probes,
      };
    }
    if (zero.rows === 0) return { base: 1, decided: true, why: "Page=0 returned zero rows and Page=1 returned rows.", probes };
    if (one.rows === 0) return { base: 0, decided: true, why: "Page=0 returned rows and Page=1 returned none: page 0 is the first page.", probes };
    if (zero.signature === one.signature) {
      throw new PageBaseUndecidableError(
        `${op}: Page=0 and Page=1 returned the SAME page (${zero.rows} identical records). The server ` +
        "clamps out-of-range page numbers, so this cannot tell a 0-based server from a 1-based one — " +
        "and guessing drops or duplicates an entire page. Probe the shop and pass { pageBase: 0 } or " +
        "{ pageBase: 1 } explicitly.",
        { op, probes, pageSize },
      );
    }
    return { base: 0, decided: true, why: "Page=0 and Page=1 returned DIFFERENT rows, so page 0 is a real first page.", probes };
  }

  /**
   * Where the base comes from, in precedence order: the call, then the client's default, then
   * nothing — and "nothing" is still a refusal, not a guess.
   *
   * H3 originally made an explicit `pageBase` MANDATORY, because SOAP_PAGE_BASE.verified was false
   * and a wrong guess loses a whole page in silence. pagebase.json has since settled the base at 1
   * on two independent methods, so the client now carries that recorded value as its default and
   * `readAll(op, { pageSize })` works again. What did NOT change:
   *
   *   - An explicit `{ pageBase }` on the call always wins, and `"detect"` still asks the server.
   *   - `defaultPageBase: null` restores the refusal wholesale, which is the switch to throw for a
   *     shop that has not proved its own base. That path is not dead code — it is the supported way
   *     to onboard a new shop, and the tests exercise it.
   *   - `startPage` STILL DOES NOT SUBSTITUTE for a base. An earlier version returned early
   *     whenever startPage was an integer, reasoning that "a caller who names a page number has
   *     already made the base decision" — which is false. It is retained as a rule because a
   *     resume must carry both, which is why `resume.restart` is `{ startPage, pageBase }`.
   *
   * The evidence for whichever branch fired travels out in the walk's `pageBaseEvidence`, so a
   * reader of an export can always tell a base the SERVER confirmed from one this repo assumed.
   */
  async #resolvePageBase(op, options, pageSize) {
    const given = options.pageBase ?? this.defaultPageBase;
    const fromCaller = options.pageBase !== undefined && options.pageBase !== null;
    const startPage = options.startPage;
    const resuming = startPage !== undefined && startPage !== null;
    if (resuming && (!Number.isInteger(startPage) || startPage < 0)) {
      throw new PaginationError(
        `startPage must be a non-negative integer page number, got ${JSON.stringify(startPage)}.`,
        { op, startPage },
      );
    }

    let base = null;
    let evidence = null;
    if (given === 0 || given === 1) {
      base = given;
      evidence = fromCaller
        ? { decided: true, source: "caller", why: `the caller declared pageBase ${given}` }
        : {
          decided: true,
          source: this.defaultPageBaseExplicit ? "client-default" : "recorded-default",
          why: this.defaultPageBaseExplicit
            ? `this client was constructed with defaultPageBase ${given}`
            : `SOAP_PAGE_BASE: ${SOAP_PAGE_BASE.why}`,
          // Named so a consumer can see the residual risk without reading this file: the base was
          // NOT established against the shop being read right now.
          verifiedAgainstThisShop: false,
          scope: SOAP_PAGE_BASE.scope,
          openQuestion: SOAP_PAGE_BASE.openQuestion,
        };
    } else if (given === "detect") {
      const d = await this.detectPageBase(op, { pageSize, args: options.args ?? {}, call: options.call });
      base = d.base;
      evidence = { ...d, source: "detect", verifiedAgainstThisShop: d.decided };
    } else {
      throw new PageBaseUnverifiedError(
        `${op} is a Page/PageSize operation and this client has no page-number base to use ` +
        `(defaultPageBase is ${JSON.stringify(this.defaultPageBase ?? null)}). Assuming 1 against a ` +
        "0-based server skips the ENTIRE first page and still reports a complete read, so nothing " +
        'is assumed. Pass { pageBase: 0 } or { pageBase: 1 }, or { pageBase: "detect" } to ' +
        `establish it against this shop (1-2 extra requests). Got ${JSON.stringify(options.pageBase ?? null)}.` +
        (resuming
          ? ` A startPage (${startPage}) is NOT a substitute: resuming at a page number still needs `
            + "to know which page number is the first one, which is why `resume.restart` carries " +
            "pageBase alongside startPage."
          : "") +
        " No request was sent.",
        { op, pageBase: options.pageBase ?? null, startPage: resuming ? startPage : null, evidence: SOAP_PAGE_BASE },
      );
    }

    if (resuming && startPage < base) {
      throw new PaginationError(
        `startPage ${startPage} is below the page base ${base}: there is no such page, so the walk ` +
        "would read a window the server never numbered. Resume from `resume.restart`.",
        { op, startPage, pageBase: base },
      );
    }
    return { base, evidence, cursor: resuming ? startPage : base };
  }

  /** Attach resume state to whatever came out of a walk, without hiding the original error. */
  #withResume(err, state) {
    if (err && typeof err === "object" && err.resume === undefined) {
      try { err.resume = state; } catch { /* a frozen error is still worth throwing */ }
    }
    return err;
  }

  /**
   * Walk a paginated operation, yielding one page at a time.
   *
   * THE STOP CONDITION IS "THE SERVER RETURNED ZERO ROWS" OR "A KNOWN TOTAL WAS REACHED".
   * It is NOT "this page was smaller than the first", and that distinction is the whole point:
   *
   *   - A SHORT PAGE PROVES NOTHING. The previous version ended the walk on any page shorter than
   *     page 1. On the 618-product shop every probe fit in one page so it never fired; on a 10k
   *     shop a single short page in the MIDDLE of the read — a server hiccup, a filtered window,
   *     a per-request cap that moved — silently truncates the export and reports success. A short
   *     page is now just a page: it is counted (`shortPages`), the cursor advances by the rows
   *     RECEIVED (never by the rows requested), and the walk continues.
   *   - AN EMPTY PAGE AFTER A **FULL** PAGE PROVES NOTHING EITHER, and that asymmetry is load-
   *     bearing rather than a convenience. A page that came back SHORT has already told us the
   *     server ran out of rows inside that window, so a zero-row answer at the next window is the
   *     end and costs no extra request. A page that came back FULL says the opposite — the server
   *     had at least `pageSize` rows a moment ago — so zero rows immediately after it is
   *     suspicious, and the walk asks ONE independent question at the NEXT window before it
   *     believes anything: nothing there ends the walk; ROWS there mean the empty window was a
   *     HOLE in the server's answers and raise EmptyPageError instead of silently truncating.
   *     `{ emptyPage: "error" }` refuses to spend even that request and hands the decision to the
   *     caller; `{ emptyPage: "confirm" }` re-reads THE SAME window instead (a transient hole
   *     heals and the walk continues, counted in `emptyPagesRetried`); `{ emptyPage: "stop" }` is
   *     the old single-signal behaviour, has to be asked for BY NAME, and returns `complete:false`.
   *   - A KNOWN TOTAL is the only other proof of completeness, and it can only come from the
   *     CALLER: this WSDL has no count operation (there is no Product_GetCount to derive one
   *     from), so `expectedTotal` is an input, not a discovery. Reaching it ends the walk with
   *     nothing left to confirm; running out of rows BEFORE it, or overshooting it, is an error.
   *
   * Two conditions still throw rather than truncate: a page that repeats the previous page's
   * identity (the server is ignoring the pagination argument), and maxPages while data is still
   * coming.
   *
   * EVERY error out of this walk carries `.resume` — `{ op, style, cursor, pageSize, pagesDone,
   * recordsDone, restart }` — so a 10k export that dies at product 9,000 restarts at 9,000 and not
   * at zero. `restart` is literally the options to merge back in: `{ start: 9000 }` for the offset
   * style, `{ startPage: n, pageBase }` for the page style (H3: the base travels WITH the page
   * number, because a page number without a base is the unverified default all over again).
   *
   * The generator's RETURN value is the walk's verdict — `stoppedBecause`, `complete`, the page
   * counters and the resume state. `for await` throws it away, which is why readAll() drives the
   * iterator by hand: a completeness verdict nobody can read is not a verdict.
   *
   * @param {string} op one of PAGINATED_OPERATIONS
   * @param {object} options
   *   pageSize      number  REQUIRED. No default: the right size is shop-dependent (scale.json
   *                         measured 50…1000 on a 618-product shop) and a hardcoded one would be
   *                         a magic number.
   *   args          object  the operation's non-pagination arguments (dates, status, …)
   *   start         number  offset style only; default 0 (recorded: probe-dandomain.mjs:218)
   *   pageBase      0|1|"detect"  page style only, REQUIRED (H3 — SOAP_PAGE_BASE is unverified)
   *   startPage     number  page style only; resume here. Needs pageBase as well.
   *   expectedTotal number  a total the CALLER knows; the walk verifies it instead of trusting it
   *   emptyPage     "probe"|"confirm"|"error"|"stop"  what a zero-row page means. Default "probe".
   *   maxPages      number  default Infinity
   *   call          object  forwarded to call()
   */
  async *readPages(op, options = {}) {
    const style = options.style ?? paginationStyleFor(op);
    if (!style) {
      throw new PaginationError(
        `${op} declares no pagination arguments (${JSON.stringify(argNamesFor(op))}). The WSDL's ` +
        `paginated operations are ${JSON.stringify(PAGINATED_OPERATIONS)} — use call() for the rest.`,
        { op },
      );
    }
    const pageSize = options.pageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new PaginationError(
        `readPages("${op}") requires an explicit integer pageSize >= 1. There is no default: ` +
        "the workable size is shop-dependent (scale.json measured 50/100/250/500/1000 against a " +
        "618-product shop) and a hardcoded one would be a magic number.",
        { op, pageSize },
      );
    }
    const maxPages = options.maxPages ?? Infinity;
    const extraArgs = options.args ?? {};
    const expectedTotal = options.expectedTotal ?? null;
    if (expectedTotal !== null && (!Number.isInteger(expectedTotal) || expectedTotal < 0)) {
      throw new PaginationError(`expectedTotal must be a non-negative integer, got ${JSON.stringify(expectedTotal)}`, { op, expectedTotal });
    }
    const emptyPage = options.emptyPage ?? "probe";
    if (!["probe", "confirm", "error", "stop"].includes(emptyPage)) {
      throw new PaginationError(
        `unknown emptyPage policy ${JSON.stringify(emptyPage)}. "probe" (default) corroborates a ` +
        'zero-row page that followed a FULL one with a read past it, "confirm" re-reads the same ' +
        'window instead, "error" hands the decision to you, "stop" is the single-signal behaviour ' +
        "and returns complete:false.",
        { op, emptyPage },
      );
    }

    let pageBase = null;
    let pageBaseEvidence = null;
    let cursor;
    if (style === PAGINATION_STYLE.OFFSET) {
      cursor = options.start ?? 0;
      if (!Number.isInteger(cursor) || cursor < 0) {
        throw new PaginationError(`start must be a non-negative integer offset, got ${JSON.stringify(cursor)}`, { op, start: cursor });
      }
    } else {
      const resolved = await this.#resolvePageBase(op, options, pageSize);
      pageBase = resolved.base;
      pageBaseEvidence = resolved.evidence;
      cursor = resolved.cursor;
    }

    const label = (c) => (style === PAGINATION_STYLE.OFFSET ? `Start=${c}` : `Page=${c}`);
    const argsFor = (c) => (style === PAGINATION_STYLE.OFFSET
      ? { ...extraArgs, Start: c, Length: pageSize }
      : { ...extraArgs, Page: c, PageSize: pageSize });
    // H1: the cursor advances by the rows RECEIVED, never by the rows requested — a 100-row answer
    // to a 250-row request moves the offset 100, or the 150 rows the server did not send this time
    // are skipped for good. `received === 0` is the corroborating probe past an empty window,
    // which has to move by a whole page or it would just re-read the same empty one.
    const nextCursor = (c, received) => (style === PAGINATION_STYLE.OFFSET ? c + (received > 0 ? received : pageSize) : c + 1);

    let observed = null;
    let previous = null;
    let pages = 0;
    let total = 0;
    let shortPages = 0;
    let emptyProbes = 0;
    let emptyPagesRetried = 0;
    let pageReads = 0;
    let roundTrips = 0;
    // null until the first page comes back. `>= pageSize` is what makes a following empty window
    // suspicious rather than credible — see the header.
    let lastPageRows = null;
    let stoppedBecause = null;
    const startedAt = cursor;

    const state = () => ({
      op,
      style,
      pageSize,
      cursor,
      pageBase,
      pagesDone: pages,
      recordsDone: total,
      startedAt,
      restart: style === PAGINATION_STYLE.OFFSET ? { start: cursor } : { startPage: cursor, pageBase },
    });
    const summary = () => ({
      stoppedBecause,
      pages,
      records: total,
      shortPages,
      // `requests` counts the PAGE WINDOWS the walk asked for (including the final zero-row one).
      // `roundTrips` counts every HTTP request it made, so the corroboration reads below are
      // visible rather than hidden — they are reported separately and never folded into `requests`.
      requests: pageReads,
      roundTrips,
      emptyProbes,
      emptyPagesRetried,
      observedPageSize: observed,
      pageBase,
      pageBaseEvidence,
      complete: stoppedBecause === "zero-rows" || stoppedBecause === "known-total",
      resume: state(),
    });

    /** One request, with the walk's resume state welded onto anything that comes out of it. */
    let last = null;
    const read = async (at, { corroboration = false } = {}) => {
      let res;
      roundTrips += 1;
      if (!corroboration) pageReads += 1;
      try {
        res = await this.call(op, argsFor(at), options.call ?? {});
      } catch (err) {
        throw this.#withResume(err, state());
      }
      last = res;
      return res.records ?? asRecords(res.result);
    };

    for (;;) {
      let records = await read(cursor);

      if (records.length === 0) {
        // H2. "Zero rows here" and "no more rows anywhere" are different claims. Which of them a
        // zero-row window supports depends on what the PREVIOUS window said — see the header.
        if (emptyPage === "error") {
          throw this.#withResume(new EmptyPageError(
            `${op} returned an empty page at ${label(cursor)} after ${total} record(s). An empty page ` +
            "is not proof that the data ended, and { emptyPage: \"error\" } says not to guess: either " +
            'resume from `.resume.restart`, or run with the default { emptyPage: "probe" } to have the ' +
            "walk corroborate it with a read past this window.",
            { op, style, cursor, pages, records: total },
          ), state());
        }
        if (emptyPage === "stop") {
          stoppedBecause = "unconfirmed-empty-page";
          return summary();
        }

        let recovered = null;
        if (emptyPage === "confirm") {
          // Re-ask THE SAME window. A transient hole answers differently the second time, and the
          // walk keeps those rows instead of ending 368 products early on one bad answer.
          const again = await read(cursor, { corroboration: true });
          emptyProbes += 1;
          if (again.length > 0) {
            emptyPagesRetried += 1;
            recovered = again;
          }
        } else if (lastPageRows !== null && lastPageRows >= pageSize) {
          // "probe": the previous window was FULL, so the server had at least pageSize rows a
          // moment ago and "it ended exactly here" needs a second opinion. A SHORT previous page
          // already carried that opinion, which is why this branch does not run after one — the
          // walk must not spend a request to re-learn something it was just told.
          const beyond = nextCursor(cursor, 0);
          const after = await read(beyond, { corroboration: true });
          emptyProbes += 1;
          if (after.length > 0) {
            throw this.#withResume(new EmptyPageError(
              `${op} returned an empty page at ${label(cursor)} but ${after.length} record(s) at ` +
              `${label(beyond)} — that is a HOLE in the server's answers, not the end of the data. ` +
              `Stopping here would have silently truncated the read at ${total} record(s). Resume from ` +
              "`.resume.restart` once the shop is behaving, or re-read that window on its own.",
              { op, style, cursor, beyond, pages, records: total, rowsBeyond: after.length },
            ), state());
          }
        }

        if (recovered === null) {
          if (expectedTotal !== null && total < expectedTotal) {
            throw this.#withResume(new PaginationError(
              `${op} ran out of records at ${total} but the caller's known total is ${expectedTotal} — ` +
              `${expectedTotal - total} record(s) are missing. The window at ${label(cursor)} came back ` +
              "empty, so this is the server's answer, not a paging bug. Refusing to report a short " +
              "read as complete.",
              { op, style, cursor, pages, records: total, expectedTotal },
            ), state());
          }
          stoppedBecause = "zero-rows";
          return summary();
        }
        records = recovered;
      }

      const signature = pageSignature(records);
      if (previous !== null && signature === previous) {
        throw this.#withResume(new PaginationError(
          `${op} returned the SAME page twice at ${label(cursor)} ` +
          `(${records.length} records, page ${pages + 1}) — the server is ignoring the pagination ` +
          "argument. Refusing to loop or to report a duplicated read as a result.",
          { op, style, cursor, pages, records: records.length, seen: total },
        ), state());
      }
      previous = signature;
      pages += 1;
      total += records.length;
      const short = records.length < pageSize;
      if (short) shortPages += 1;
      if (observed === null) observed = records.length;
      lastPageRows = records.length;

      if (expectedTotal !== null && total > expectedTotal) {
        throw this.#withResume(new PaginationError(
          `${op} has returned ${total} record(s), MORE than the caller's known total of ${expectedTotal}. ` +
          "Either the total is stale or the server is repeating rows; neither can be resolved here.",
          { op, style, cursor, pages, records: total, expectedTotal },
        ), state());
      }

      const at = cursor;
      cursor = nextCursor(cursor, records.length);
      yield {
        records,
        page: pages,
        cursor: at,
        nextCursor: cursor,
        requested: pageSize,
        short,
        observedPageSize: observed,
        resume: state(),
        raw: last,
      };

      // A known total is the one signal that ends a walk without a confirming read: the caller
      // told us how many rows there are and we have them all.
      if (expectedTotal !== null && total === expectedTotal) {
        stoppedBecause = "known-total";
        return summary();
      }
      if (pages >= maxPages) {
        throw this.#withResume(new PaginationError(
          `${op} hit maxPages=${maxPages} after ${total} record(s) with more data still coming — ` +
          "stopping here would silently truncate the read.",
          { op, pages, records: total, maxPages },
        ), state());
      }
    }
  }

  /**
   * Every record of a paginated operation, WITH the R26 whole-batch field audit applied.
   *
   * THE WALK'S VERDICT IS ON THE RESULT, not swallowed. `for await` discards a generator's return
   * value, so the previous version consumed readPages() with one and then reported a hardcoded
   * `complete: true` — which made H1/H2's whole stop-condition analysis invisible to every caller
   * and, worse, reported `complete: true` for the one outcome that is NOT complete
   * (`{ emptyPage: "stop" }`, which stops on an unconfirmed empty page). So the iterator is driven
   * by hand and `stoppedBecause`, `complete`, `requests`/`roundTrips`, `shortPages`,
   * `emptyProbes`, `emptyPagesRetried`, `pageBase`, `pageBaseEvidence` and `resume` are all
   * surfaced. Every other incomplete outcome still throws.
   *
   * THE AUDIT IS ON BY DEFAULT, and that is the point. R26 is a rule about a WHOLE BATCH, and
   * readAll() is the only place in this client that has one — a per-page audit would re-create
   * the very "decide from too small a sample" mistake R28 is. The record type comes from the
   * WSDL (OPERATIONS[op].resultItemType, e.g. "tns:Product"); if a field set is remembered for
   * that type, the accumulated records are audited against it — AND, through recordTypeOf +
   * the remembered field sets, so is every nested record collection the WSDL declares beneath it
   * (R3's own recorded truncation is on ORDER LINES, one level down). A field on ZERO records of
   * any record type raises FieldSetTruncatedError instead of being migrated as an absent column.
   * With no remembered field set there is nothing to audit against and `audit` is null. Pass
   * { audit: false } to survey a shop without the rule, or { audit: { throwOnTruncation: false } }
   * to get the verdict on the result instead of as an exception.
   */
  async readAll(op, options = {}) {
    const records = [];
    let pages = 0;
    let observedPageSize = null;
    // `pages` counts pages that HELD records; `walk.requests` counts page windows asked for, and
    // the two differ by one whenever the last page was followed by an empty one. That confirming
    // request is deliberate — a page that is exactly the observed size does not prove the data
    // ended — and it is reported rather than hidden, so nobody reads "1 page" as "1 call".
    const iterator = this.readPages(op, options);
    let walk = null;
    for (;;) {
      const step = await iterator.next();
      if (step.done) { walk = step.value ?? null; break; }
      pages += 1;
      if (observedPageSize === null) observedPageSize = step.value.records.length;
      records.push(...step.value.records);
    }
    let audit = null;
    if (options.audit !== false) {
      const type = recordTypeOf(op);
      if (type !== null && this.#fieldSets.has(type)) {
        audit = this.auditAgainstFieldSet(type, records, options.audit === true ? {} : (options.audit ?? {}));
      }
    }
    return {
      records,
      pages,
      requests: walk?.requests ?? 0,
      roundTrips: walk?.roundTrips ?? 0,
      observedPageSize,
      // The walk's own verdict, never a constant: "zero-rows" and "known-total" are complete,
      // "unconfirmed-empty-page" is not.
      complete: walk?.complete ?? false,
      stoppedBecause: walk?.stoppedBecause ?? null,
      shortPages: walk?.shortPages ?? 0,
      emptyProbes: walk?.emptyProbes ?? 0,
      emptyPagesRetried: walk?.emptyPagesRetried ?? 0,
      pageBase: walk?.pageBase ?? null,
      pageBaseEvidence: walk?.pageBaseEvidence ?? null,
      resume: walk?.resume ?? null,
      auditedType: audit ? recordTypeOf(op) : null,
      audit,
    };
  }

  /** The remembered field sets as the plain `type -> string[]` map the audit's recursion wants. */
  #rememberedFieldSets() {
    return new Map([...this.#fieldSets].map(([type, entry]) => [type, [...entry.fields]]));
  }

  /**
   * R26 — audit a whole batch against the field list that was requested for `type`, using the
   * remembered set so the two cannot drift apart.
   *
   * `recordType` and the whole remembered map are handed down so the audit RECURSES: an Order's
   * OrderLines are audited against the OrderLine field set, a Product's Variants against the
   * ProductVariant one, and collections with no *_SetFields operation (Product.Pictures,
   * Product.StockLocations) are surveyed. Passing only `entry.fields` — which is what this used to
   * do — silently limited the rule to the top level, and R3's actual recorded truncation
   * (PacketId and Status missing on every ORDER LINE) is nested, so the audit would have missed
   * the very defect it was built for. Both are overridable through `options`.
   */
  auditAgainstFieldSet(type, records, options = {}) {
    const entry = this.#fieldSets.get(type);
    if (!entry) {
      throw new FieldListError(`no field set has been set for "${type}" — call setFields() first`, { type });
    }
    return auditBatch(entry.fields, records, {
      recordType: type,
      fieldSets: this.#rememberedFieldSets(),
      ...options,
    });
  }

  /** R26 — the standalone whole-batch audit, as a method for convenience. */
  auditBatch(requestedFields, records, options = {}) {
    return auditBatch(requestedFields, records, options);
  }

  // -------------------------------------------------------------------------------------------
  // The other two transports
  // -------------------------------------------------------------------------------------------

  /**
   * The GraphQL transport (F12/F23), built lazily from `options.graphql`.
   *
   * It keeps its OWN pacer: the GraphQL API has a documented 5 req/s
   * (graphql.js DOCUMENTED_RATE_PER_SECOND) while SOAP has no observed limit at all
   * (SOAP_RATE_EVIDENCE), so sharing one bucket would either throttle SOAP on GraphQL's evidence
   * or spend GraphQL's budget on SOAP traffic. Two transports, two limits.
   */
  graphql() {
    if (this.#graphqlClient) return this.#graphqlClient;
    const opts = this.graphqlOptions;
    if (!opts) {
      throw new DanDomainClientError(
        "no GraphQL configuration — construct the client with { graphql: { tenant, clientId, clientSecret } } " +
        "(F12: OAuth2 client-credentials), or { graphql: { client } } to inject one.",
      );
    }
    this.#graphqlClient = opts.client ?? createGraphQLClient(opts);
    return this.#graphqlClient;
  }

  /**
   * The FTPS transport (R10/R11), built lazily from `options.ftp`. PROMOTED, not rewritten:
   * ftp.js is live-tested and every non-obvious rule (upgrade the data channel AFTER the transfer
   * command's 1xx, pass the control TLS session captured from the `session` EVENT, reuse the
   * control host over the advertised PASV IP, TYPE I, certificate verification ON) lives there.
   *
   * The one thing ftpsConnect() explicitly leaves to its caller is R10's flavour order — "try
   * explicit-on-21 first, implicit-on-990 second — that is the CALLER's loop" — so that loop is
   * here, and every failed attempt is kept with its `.stage` and its redacted transcript instead
   * of being collapsed into one message.
   *
   * WHAT THE SESSION HANDED BACK BY `session` NOW GUARANTEES (it used to guarantee none of it):
   *   - `xferIn`/`xferOut` REJECT unless the server's final reply is 2xx, so a truncated image
   *     cannot reach the media export looking complete. The error carries `.reply` and `.partial`.
   *   - after a failed transfer the session is either still in step or marked `.broken`, and a
   *     broken session refuses commands rather than answering with the previous reply.
   *   - one transfer at a time. Parallelising a media walk over ONE session throws; open one
   *     session per concurrent transfer.
   *   - `parseList` entries carry `name` (latin1 wire bytes — use this for RETR) AND `nameUtf8`
   *     (use this to match a SOAP `FileName`, which is UTF-8 per F2).
   */
  ftp() {
    if (this.#ftpFacade) return this.#ftpFacade;
    const cfg = this.ftpOptions;
    if (!cfg) {
      throw new DanDomainClientError("no FTPS configuration — construct the client with { ftp: { host, user, pass } } (R10/R11)");
    }
    let session = null;
    const facade = {
      config: cfg,
      /** R10 order, as a loop over the configured flavours. Certificate verification stays ON. */
      async connect(overrides = {}) {
        const settings = { ...cfg, ...overrides };
        const modes = settings.modes ?? (settings.mode ? [settings.mode] : ["explicit", "implicit"]);
        const attempts = [];
        for (const mode of modes) {
          try {
            const s = await ftpsConnect({
              host: settings.host,
              user: settings.user,
              pass: settings.pass,
              mode,
              port: settings.port ?? (mode === "implicit" ? settings.implicitPort : settings.explicitPort),
              timeoutMs: settings.timeoutMs ?? 20000,
              rejectUnauthorized: settings.rejectUnauthorized !== false,
              tlsOptions: settings.tlsOptions,
              logger: settings.logger,
            });
            session = s;
            facade.attempts = attempts;
            facade.mode = mode;
            return s;
          } catch (e) {
            attempts.push({ mode, stage: e.stage ?? null, message: e.message, transcript: e.transcript ?? null });
          }
        }
        facade.attempts = attempts;
        throw new DanDomainClientError(
          `FTPS login failed for every configured flavour (${modes.join(", ")}). Each attempt's ` +
          "`stage` names the wrong assumption: tcp-connect = firewall/port, tls-connect / " +
          "tls-upgrade = TLS or certificate, greeting = the server did not answer 220, " +
          "command = auth, login or PROT.",
          { attempts, host: settings.host, modes },
        );
      },
      /** The live session, or null. */
      get session() { return session; },
      /** Best-effort close; never throws. */
      quit() { try { session?.quit(); } catch { /* quit() is already best-effort */ } session = null; },
      parseList,
      attempts: [],
      mode: null,
    };
    this.#ftpFacade = facade;
    return facade;
  }
}

/** GraphQL OAuth from config, else DD_GQL_* / DD_TENANT. Never logs secrets. */
export function graphqlOptionsFromEnv(dd = {}) {
  if (dd.graphql?.client) return dd.graphql;
  if (dd.graphql?.clientId && dd.graphql?.clientSecret) {
    return { tenant: dd.graphql.tenant || dd.tenant, ...dd.graphql };
  }
  const clientId = String(process.env.DD_GQL_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.DD_GQL_CLIENT_SECRET || "").trim();
  const tenant = String(dd.tenant || dd.graphql?.tenant || process.env.DD_GQL_TENANT || process.env.DD_TENANT || "").trim();
  if (clientId && clientSecret && tenant) return { tenant, clientId, clientSecret };
  return null;
}

export function createClient(options) {
  return new DanDomainClient(options);
}
