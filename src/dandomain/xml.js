/**
 * src/dandomain/xml.js — record-boundary-preserving XML reader for the Hostedshop SOAP API.
 *
 * WHY THIS FILE EXISTS AT ALL (R6, R18, R26)
 * ------------------------------------------
 * P1 probed with a regex walker (scripts/probe-dandomain.mjs:119). It looked adequate and was
 * not. Its match rule was
 *     /<(?:\w+:)?([\w.]+)(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?\1>|.../g
 * — a LAZY body with a backreferenced close tag. XML that nests an element inside another
 * element of the SAME NAME defeats it, and this API does that on every list-valued field,
 * because every `ArrayOf*` type in service.wsdl is `<xsd:sequence><xsd:element name="item"
 * maxOccurs="unbounded"/></xsd:sequence>`. So a `<item>` record that contains an
 * `ArrayOfInt`/`ArrayOfProductVariantStockLocation` field contains a nested `<item>`, and the
 * walker's record ended at the FIRST inner `</item>`. Everything after that inner close was
 * re-scanned as if it were a sibling of the records. Three recorded consequences, all of which
 * this module is tested against (test/xml.test.mjs):
 *
 *   1. data/probes/gaps.json sections.variants.audit.returned ==
 *        ["item","MinAmount","Title","Unit","StockLocations"]
 *      Fields were HOISTED OUT of their record into parallel arrays: Title became
 *      ["Small","Medium","Large"] at the top level, so no variant had a Title any more and 22
 *      of 26 requested fields were reported "missing" while sitting inside the truncated
 *      records. That false "truncated" verdict is exactly the R28 trap.
 *   2. Same file: StockLocations == [{...},[{...}],[{...}]] — one field, three DIFFERENT shapes.
 *      Cause: the walker decided "is this key already an array?" by `Array.isArray(out[k])`,
 *      which cannot tell an accumulator from a VALUE that is itself an array. First write stored
 *      an array-valued field, the second write pushed INTO that value. This module therefore
 *      decides cardinality from the child-count of ONE parent element, never from the shape of
 *      what is already stored, and never from a sibling record (see elementValue()).
 *   3. data/probes/scale.json pages[].parsedLength == 1 for pages of 50…618 products, while the
 *      raw markers counted 50…618. A 618-product page parsed as ONE object. Ids derived from
 *      that shape were passed back to the server and produced a real server fault (R18).
 *
 * So: a real tokenizer with a stack. No regex may decide where an element ends.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * - No type coercion. "199", "true", "0" stay strings. The recorded samples are strings, ids
 *   must survive round-tripping (R18), and Product.Price is VAT-inclusive money (R1) that must
 *   not be floated behind the caller's back.
 * - No field defaulting or shape normalising. Fields are omitted PER RECORD when empty (R26:
 *   SeoLink came back on 8 of 618 products). A record without SeoLink must come out WITHOUT the
 *   key, so the batch-wide "zero records => truncated column / some records => empty value"
 *   scan stays possible. Inventing `SeoLink: null` would destroy that evidence.
 * - No HTML entity decoding. XML's five predefined entities and numeric character references
 *   are decoded because that is XML syntax; `&oslash;` is left LITERAL. gaps.json
 *   sections.htmlEntities: "the client needs a per-field entity-decode step, not a global one —
 *   decoding globally would corrupt any field that legitimately contains an ampersand sequence."
 * - No fault classification. parseSoapResponse throws SoapFaultError carrying the code exactly
 *   as F3 says to read it (Subcode/Value when present, else Code/Value) and the reason string
 *   VERBATIM, because the client has to regex `/Order:\s*(\d+)\s*created/` out of it (F16).
 *   Deciding fatal-vs-transient is the client's job, not the parser's.
 * - No `Solution_SetEncoding` anywhere near it (F2). Bytes are decoded as UTF-8 explicitly and
 *   every response is screened for double-encoding, which THROWS by default (see MOJIBAKE_RE).
 * - No trimming of character data by default. The probe trimmed every text node
 *   (probe-dandomain.mjs:127 `x = x.trim()`), so its recordings cannot tell you whether the wire
 *   is padded; this module keeps what arrived. That is safe HERE only because the payload is
 *   compact — scale.json records 488 bytes per 18-field product, which a pretty-printed record
 *   could not fit — and because R18's recorded harm was a derived id that no longer round-tripped.
 *   `trimText: true` is all-or-nothing: it also trims PageText.Text HTML and CDATA, so a caller
 *   who wants "trim scalars, keep Text verbatim" has to trim per field itself.
 *
 * KNOWN STRICTNESS COSTS (both deliberate, neither free)
 * ------------------------------------------------------
 * - parseSoapResponse throws when the expected <OpResponse> is absent.
 * - ONE malformed character anywhere aborts an ENTIRE page: `<Text><p>hej<br>der</p></Text>`
 *   throws "mismatched closing tag </p>, expected </br>", and a 618-record page yields no
 *   partial results. Whether this server ever emits unescaped HTML cannot be settled from
 *   data/probes (only PARSED output was recorded), so it is open rather than known-safe.
 *   XmlParseError therefore carries `.source` (truncated) the way SoapFaultError carries `.raw`,
 *   so the body is not lost with the records.
 *
 * Zero dependencies, ESM, pure: no top-level side effects, nothing printed, errors thrown.
 */

/**
 * F2's double-encoding detector.
 *
 * BRIEF.md quotes the narrow form `/Ã[\x80-\xBF]/`; the probe that produced the live evidence
 * ran the WIDER `/Ã[\x80-\xBF]|Â[\x80-\xBF]/` (scripts/probe-dandomain.mjs:92). The wide form is
 * used here because the half the brief omits is not decorative: U+0080–U+00BF double-encodes to
 * `Â`+char, which covers nbsp (from `&nbsp;` in CMS HTML), °, ©, », ±, ½ — all ordinary in Danish
 * shop text, and PageText.Text is raw HTML. With the narrow form "20Â kr" and "12Â°C" are
 * double-encoded and report clean. The narrow form stays exported as MOJIBAKE_BRIEF_RE so the
 * brief's exact rule remains checkable. Non-global on purpose: .test() must be stateless.
 */
export const MOJIBAKE_RE = /Ã[\x80-\xBF]|Â[\x80-\xBF]/;

/** The detector exactly as BRIEF.md writes it — a strict subset of MOJIBAKE_RE. */
export const MOJIBAKE_BRIEF_RE = /Ã[\x80-\xBF]/;

/** The child element name every `ArrayOf*` complexType in service.wsdl uses. */
export const ARRAY_ITEM = "item";

/**
 * Malformed XML. Carries `.source` — a truncated copy of the document that failed — because one
 * bad character aborts a whole page and without the body there is nothing left to diagnose from:
 * not the 617 good records, not an nginx error page that arrived instead of SOAP.
 */
export class XmlParseError extends Error {
  constructor(message, position = -1, context = "", source = null) {
    super(position >= 0 ? `${message} (at offset ${position}${context ? `, near ${JSON.stringify(context)}` : ""})` : message);
    this.name = "XmlParseError";
    this.position = position;
    this.context = context;
    this.source = typeof source === "string" ? source.slice(0, SOURCE_SNIPPET_LIMIT) : null;
    this.sourceTruncated = typeof source === "string" && source.length > SOURCE_SNIPPET_LIMIT;
  }
}

/** How much of a failing document XmlParseError keeps. Enough to see a fault or an HTML page. */
export const SOURCE_SNIPPET_LIMIT = 4000;

/** Thrown by parseSoapResponse when the Body carries a Fault. Classification is the client's. */
export class SoapFaultError extends Error {
  constructor(fault, raw) {
    super(`SoapFault ${fault.appCode}: ${fault.reason}`);
    this.name = "SoapFaultError";
    this.code = fault.appCode; // F3: Subcode/Value when present, else Code/Value
    this.faultCode = fault.code;
    this.subcode = fault.subcode;
    this.reason = fault.reason;
    this.detail = fault.detail;
    this.raw = raw;
  }
}

/**
 * Thrown by parseSoapResponse when a response is double-encoded (F2: "fail loudly"). This is the
 * DEFAULT; a caller who is surveying rather than migrating opts out with
 * { failOnMojibake: false } and reads the `mojibake` boolean off the returned object instead.
 * The default is this way round because the alternative is a boolean the client can forget to
 * read, and the cost of forgetting is corrupted product titles migrated with no error anywhere.
 */
export class EncodingError extends Error {
  constructor(message, info) {
    super(message);
    this.name = "EncodingError";
    Object.assign(this, info);
  }
}

// ---------------------------------------------------------------------------
// entities
// ---------------------------------------------------------------------------

// Null-prototype: `&constructor;` must not resolve to Object.prototype.constructor.
const XML_ENTITIES = Object.assign(Object.create(null), { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" });
const ENTITY_RE = /&(#[Xx][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9._-]*);/g;

/**
 * Decode XML syntax only: the five predefined entities plus numeric character references.
 * Anything else (`&oslash;`, `&nbsp;`) is returned untouched — see the header note on
 * gaps.json sections.htmlEntities.
 */
export function unescapeXml(text) {
  if (typeof text !== "string" || text.indexOf("&") === -1) return text;
  return text.replace(ENTITY_RE, (whole, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    const decoded = XML_ENTITIES[body];
    return decoded === undefined ? whole : decoded;
  });
}

// ---------------------------------------------------------------------------
// decoding (F2)
// ---------------------------------------------------------------------------

// windows-1252 C1 replacements, used only if a response is NOT valid UTF-8. The probe used the
// same fallback (scripts/probe-dandomain.mjs:88). Hand-rolled because Node built without
// full-icu has no legacy decoder and we may not add dependencies.
const CP1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/**
 * The hand-rolled half, exported so it can be tested directly: on a Node built WITH full-icu the
 * fallback below is unreachable, so nothing would ever exercise CP1252_C1 and a wrong table would
 * sit here undetected until it ran on a stripped-down runtime. test/xml.test.mjs compares this
 * against TextDecoder("windows-1252") over all 256 byte values.
 */
export function decodeWindows1252Table(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_C1[b - 0x80] : b);
  }
  return out;
}

function decodeWindows1252(bytes) {
  try {
    return new TextDecoder("windows-1252").decode(bytes);
  } catch {
    return decodeWindows1252Table(bytes);
  }
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/**
 * Decode a response body. Strings pass through (the caller already decoded); bytes are decoded
 * as UTF-8 with fatal:true — the declared charset is NOT trusted (F2) — falling back to
 * windows-1252 only when the bytes are not valid UTF-8 at all.
 *
 * @returns {{ text: string, decodedAs: "utf-8"|"windows-1252"|"string", mojibake: boolean }}
 */
export function decodeResponseBytes(input) {
  let text;
  let decodedAs;
  const bytes = typeof input === "string" ? null : toBytes(input);
  if (bytes) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      decodedAs = "utf-8";
    } catch {
      text = decodeWindows1252(bytes);
      decodedAs = "windows-1252";
    }
  } else if (typeof input === "string") {
    text = input;
    decodedAs = "string";
  } else {
    throw new TypeError("decodeResponseBytes: expected a string, Uint8Array, Buffer or ArrayBuffer");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, decodedAs, mojibake: MOJIBAKE_RE.test(text) };
}

// ---------------------------------------------------------------------------
// tokenizer -> element tree
// ---------------------------------------------------------------------------

/**
 * Element node. `children` are elements only; `text` is the concatenation of this element's own
 * character data (entity-decoded for normal runs, verbatim for CDATA).
 */
function makeNode(name) {
  return { name, children: [], text: "", hasText: false, selfClosing: false, nil: false };
}

/** Strip a namespace prefix. F1: this API mixes prefixed and default-namespace tags. */
function localName(raw) {
  const c = raw.indexOf(":");
  return c === -1 ? raw : raw.slice(c + 1);
}

const ATTR_RE = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/**
 * True when the tag really carries xsi:nil="true" as an ATTRIBUTE. Attributes are otherwise
 * ignored (this API puts no data in them), so this runs only when the raw text contains "nil" —
 * a substring match alone would be fooled by `<a title='nil="true"'/>`.
 */
function hasNilAttribute(attrSrc) {
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrSrc))) {
    if (localName(m[1]) !== "nil") continue;
    const value = m[3] ?? m[4] ?? "";
    if (value === "true" || value === "1") return true;
  }
  return false;
}

function isNameChar(code) {
  // everything that is not whitespace, '/', '>' or '<'
  return code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 47 && code !== 62 && code !== 60;
}

function appendText(node, raw, decode) {
  if (raw === "") return;
  if (!node.hasText && /\S/.test(raw)) node.hasText = true;
  node.text += decode ? unescapeXml(raw) : raw;
}

/**
 * Tokenize `src` into a tree of element nodes. Malformed input THROWS — the whole point of this
 * module is that a wrong shape must never be returned silently (R6/R18).
 *
 * @returns {object} a synthetic "#document" node whose children are the top-level elements.
 */
export function parseElements(src) {
  if (typeof src !== "string") throw new TypeError("parseElements: expected a string");
  try {
    return tokenize(src);
  } catch (e) {
    // Attach the body the way SoapFaultError carries .raw: one malformed field aborts the whole
    // page, so the failing document is the only evidence left.
    if (e instanceof XmlParseError && e.source === null) {
      e.source = src.slice(0, SOURCE_SNIPPET_LIMIT);
      e.sourceTruncated = src.length > SOURCE_SNIPPET_LIMIT;
    }
    throw e;
  }
}

function tokenize(src) {
  const root = makeNode("#document");
  const stack = [root];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], src.slice(i), true);
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], src.slice(i, lt), true);

    // <![CDATA[ ... ]]> — verbatim, no entity decoding (page Text fields carry raw HTML)
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlParseError("unterminated CDATA section", lt, src.slice(lt, lt + 40));
      appendText(stack[stack.length - 1], src.slice(lt + 9, end), false);
      i = end + 3;
      continue;
    }
    // <!-- comment -->
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlParseError("unterminated comment", lt, src.slice(lt, lt + 40));
      i = end + 3;
      continue;
    }
    // <!DOCTYPE ...> (possibly with an internal subset)
    if (src.startsWith("<!", lt)) {
      const gt = src.indexOf(">", lt);
      const br = src.indexOf("[", lt);
      if (gt !== -1 && br !== -1 && br < gt) {
        const end = src.indexOf("]>", br);
        if (end === -1) throw new XmlParseError("unterminated declaration", lt, src.slice(lt, lt + 40));
        i = end + 2;
        continue;
      }
      if (gt === -1) throw new XmlParseError("unterminated declaration", lt, src.slice(lt, lt + 40));
      i = gt + 1;
      continue;
    }
    // <?xml ... ?> / processing instruction
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlParseError("unterminated processing instruction", lt, src.slice(lt, lt + 40));
      i = end + 2;
      continue;
    }
    // </close>
    if (src.charCodeAt(lt + 1) === 47 /* / */) {
      const gt = src.indexOf(">", lt);
      if (gt === -1) throw new XmlParseError("unterminated closing tag", lt, src.slice(lt, lt + 40));
      const name = localName(src.slice(lt + 2, gt).trim());
      if (stack.length === 1) throw new XmlParseError(`unexpected closing tag </${name}> outside any element`, lt, src.slice(lt, lt + 40));
      const open = stack[stack.length - 1];
      if (open.name !== name) {
        throw new XmlParseError(`mismatched closing tag </${name}>, expected </${open.name}>`, lt, src.slice(lt, lt + 40));
      }
      stack.pop();
      i = gt + 1;
      continue;
    }
    // <open ...> or <open .../>
    let j = lt + 1;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    const rawName = src.slice(lt + 1, j);
    if (rawName === "") throw new XmlParseError("malformed tag", lt, src.slice(lt, lt + 40));
    let k = j;
    let quote = 0;
    for (; k < n; k++) {
      const c = src.charCodeAt(k);
      if (quote) {
        if (c === quote) quote = 0;
        continue;
      }
      if (c === 34 /* " */ || c === 39 /* ' */) { quote = c; continue; }
      if (c === 62 /* > */) break;
    }
    if (k >= n) throw new XmlParseError(`unterminated tag <${localName(rawName)}>`, lt, src.slice(lt, lt + 40));
    const selfClosing = src.charCodeAt(k - 1) === 47 /* / */;
    const attrs = src.slice(j, selfClosing ? k - 1 : k);
    const node = makeNode(localName(rawName));
    node.selfClosing = selfClosing;
    if (attrs.indexOf("nil") !== -1 && hasNilAttribute(attrs)) node.nil = true;
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = k + 1;
  }
  if (stack.length !== 1) {
    const open = stack[stack.length - 1];
    throw new XmlParseError(`unclosed element <${open.name}> at end of input`, n, "");
  }
  return root;
}

// ---------------------------------------------------------------------------
// element tree -> values
// ---------------------------------------------------------------------------

function normaliseOptions(options = {}) {
  const names = new Set();
  const paths = new Set();
  for (const entry of options.arrayElements ?? []) {
    if (typeof entry !== "string" || entry === "") continue;
    (entry.indexOf("/") === -1 ? names : paths).add(entry);
  }
  return {
    arrayNames: names,
    arrayPaths: paths,
    trimText: options.trimText === true,
    nilAsNull: options.nilAsNull !== false,
    basePath: typeof options.path === "string" ? options.path : "",
  };
}

/**
 * Assign a data-derived key. `<__proto__>` is a legal XML name, and `obj["__proto__"] = v` on a
 * plain object mutates the prototype instead of adding a field — the record would come back
 * missing that key. Records stay plain objects (callers deep-compare and JSON them), so the one
 * dangerous name gets defined explicitly rather than swapping in a null-prototype object.
 */
function setKey(target, key, value) {
  if (key === "__proto__") Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  else target[key] = value;
}

/**
 * Does a caller hint name this element?
 *
 * A bare name matches AT EVERY DEPTH, which is why the hint is only ever allowed to turn an
 * EMPTY element into [] (see elementValue). Three field names in service.wsdl are `ArrayOf*` on
 * one type and a scalar on another, and one of the collisions fires INSIDE A SINGLE RESPONSE:
 *
 *   LanguageAccess  ArrayOfString on Product/User/Category/PageText/...  xsd:string on ImageAltText
 *   ShowInMenu      ArrayOfInt    on Category                            xsd:boolean on PageText
 *   Access          ArrayOfString on ProductDeliveryCountry              xsd:string on its
 *                                                                        Create/Update inputs
 *
 * Product -> Pictures -> ProductPicture -> ImageAltTexts -> ImageAltText.LanguageAccess is the
 * scalar one, and `Pictures` is in the field set the recorded scale probe requested
 * (probe-dandomain.mjs:2018). Deriving the hint list from TYPE_DETAILS[Product] — the obvious
 * wiring — therefore used to turn that nested "DK" into ["DK"]. Use the "Parent/Child" path form
 * for those three; a bare name is fine for anything else.
 */
function isForcedArray(path, name, opts) {
  if (opts.arrayNames.size !== 0 && opts.arrayNames.has(name)) return true;
  if (opts.arrayPaths.size === 0) return false;
  if (opts.arrayPaths.has(path)) return true;
  for (const p of opts.arrayPaths) if (path.endsWith(`/${p}`)) return true;
  return false;
}

/**
 * Convert one element to a value.
 *
 * Cardinality rules, in force order. Every one of them is decided from THIS element's own
 * children — never from a sibling record, never from what a key already holds:
 *
 *   a) all children are named `item`  -> array, even for exactly one child. service.wsdl models
 *      every list as `ArrayOf*` = a sequence of `item`, so `<StockLocations><item>…</item>
 *      </StockLocations>` is a one-element array, not an object. This is the "ONE child vs MANY"
 *      rule; it is what makes a single-variant product still parse as a list.
 *   b) a name repeats among the children -> array of exactly those occurrences, in document
 *      order, scoped to this element.
 *   c) a name occurs once -> scalar/object. A sibling record having two of them changes nothing.
 *   d) options.arrayElements describes an ELEMENT'S OWN value, for elements the WSDL types as
 *      `ArrayOf*` but the server emitted EMPTY: an empty list arrives as `<PictureIds/>`, which
 *      without schema knowledge is indistinguishable from "no value". Default is null. It never
 *      changes how the PARENT stores the key — that would double-wrap a single hinted child —
 *      and it only ever applies to an element with NO children and NO character data. A hinted
 *      element that CARRIES TEXT keeps its scalar shape: the hint's whole job is the empty case,
 *      and a bare name matches at every depth, so wrapping text would silently corrupt the
 *      colliding scalar fields listed on isForcedArray() above (ImageAltText.LanguageAccess
 *      "DK" -> ["DK"], nested inside a Product read that hinted Product.LanguageAccess).
 *
 * Empty forms are kept distinct because the recorded sample distinguishes them:
 * `<ItemNumber></ItemNumber>` -> "" and `<PictureIds/>` -> null (gaps.json variants sample).
 */
function elementValue(node, path, opts) {
  const kids = node.children;
  const forced = isForcedArray(path, node.name, opts);

  if (kids.length === 0) {
    if (opts.nilAsNull && node.nil) return forced ? [] : null;
    if (node.selfClosing) return forced ? [] : null;
    const text = opts.trimText ? node.text.trim() : node.text;
    // Empty (or whitespace-only) + hinted -> the empty list the hint exists for. Anything else
    // is a value, and a value is never wrapped: see the note on rule (d).
    if (forced && node.text.trim() === "") return [];
    return text;
  }

  let allItems = true;
  for (const kid of kids) {
    if (kid.name !== ARRAY_ITEM) { allItems = false; break; }
  }
  if (allItems) {
    // "Mixed content is never silently dropped" has to hold here too. An ArrayOf* wrapper with
    // character data beside its <item> rows is a shape service.wsdl cannot produce, and the rows
    // branch has nowhere to put the text — so this fails loudly instead of discarding it. (Pure
    // whitespace does not set hasText, so a pretty-printed list is unaffected.)
    if (node.hasText) {
      throw new XmlParseError(
        `character data beside <${ARRAY_ITEM}> rows in <${node.name}> — an ArrayOf* wrapper cannot ` +
        `hold text, and dropping it would lose data: ${JSON.stringify(node.text.trim().slice(0, 80))}`,
      );
    }
    const itemPath = path ? `${path}/${ARRAY_ITEM}` : ARRAY_ITEM;
    return kids.map((kid) => elementValue(kid, itemPath, opts));
  }

  // Count first, THEN fill. The recorded [{…},[{…}],[{…}]] shape came from deciding
  // "should this key be an array?" by inspecting the value already stored — which cannot tell
  // an accumulator from a field whose value is itself a list. The child count can.
  //
  // Only repetition buckets. A forced-array hint describes the CHILD's own value (an empty
  // ArrayOf* element), never the parent's key, or a hinted single child would come out double
  // wrapped as [[]]. Repetition is the only other source of arrays, and in service.wsdl every
  // one of the 54 `maxOccurs="unbounded"` elements is named `item` — which rule (a) above
  // already covers — so nothing schema-driven is lost here.
  const counts = new Map();
  for (const kid of kids) counts.set(kid.name, (counts.get(kid.name) ?? 0) + 1);
  const out = {};
  for (const kid of kids) {
    const childPath = path ? `${path}/${kid.name}` : kid.name;
    const value = elementValue(kid, childPath, opts);
    if (counts.get(kid.name) > 1) {
      let bucket = Object.prototype.hasOwnProperty.call(out, kid.name) ? out[kid.name] : null;
      if (bucket === null) setKey(out, kid.name, (bucket = []));
      bucket.push(value);
    } else {
      setKey(out, kid.name, value);
    }
  }
  if (node.hasText) out["#text"] = opts.trimText ? node.text.trim() : node.text; // mixed content is never silently dropped
  return out;
}

/**
 * Parse an XML fragment (zero or more sibling elements, optionally with text) into values.
 *
 * @param {string} fragment
 * @param {{arrayElements?: string[], trimText?: boolean, nilAsNull?: boolean, path?: string}} [options]
 * @returns {*} array | object | string | null
 */
export function parseXml(fragment, options) {
  const opts = normaliseOptions(options);
  const doc = parseElements(fragment ?? "");
  if (doc.children.length === 0) return opts.trimText ? doc.text.trim() : doc.text;
  // A fragment of N sibling <item> elements IS N records — the whole point (scale.json).
  return elementValue(doc, opts.basePath, opts);
}

// ---------------------------------------------------------------------------
// SOAP envelope
// ---------------------------------------------------------------------------

/** First match wins. A SOAP 1.2 Reason with two xml:lang Texts yields the first one only. */
function findChild(node, name) {
  for (const kid of node.children) if (kid.name === name) return kid;
  return null;
}

/** A window around the first double-encoded sequence, for the error's evidence. */
function mojibakeSample(text) {
  const at = text.search(MOJIBAKE_RE);
  return at < 0 ? null : text.slice(Math.max(0, at - 40), at + 40);
}

function textOfPath(node, names) {
  let cur = node;
  for (const name of names) {
    cur = cur && findChild(cur, name);
    if (!cur) return null;
  }
  return cur.text;
}

function faultFromNode(faultNode) {
  // SOAP 1.2: Code/Value + optional Code/Subcode/Value, Reason/Text. SOAP 1.1: faultcode/faultstring.
  const codeNode = findChild(faultNode, "Code");
  const rawCode = codeNode ? findChild(codeNode, "Value")?.text ?? null : textOfPath(faultNode, ["faultcode"]);
  const subNode = codeNode ? findChild(codeNode, "Subcode") : null;
  const rawSub = subNode ? findChild(subNode, "Value")?.text ?? null : null;
  const reason = textOfPath(faultNode, ["Reason", "Text"]) ?? textOfPath(faultNode, ["faultstring"]) ?? "";
  const code = rawCode == null ? null : localName(rawCode.trim());
  const subcode = rawSub == null ? null : localName(rawSub.trim());
  const detailNode = findChild(faultNode, "Detail") ?? findChild(faultNode, "detail");
  return {
    code,
    subcode,
    // F3: fault codes exceed the documented five — read the app code from Subcode/Value when
    // present, else Code/Value, and let the caller treat unknown codes as named-fatal.
    appCode: subcode ?? code ?? "?",
    reason: reason.trim(), // verbatim otherwise: F16 needs /Order:\s*(\d+)\s*created/ to still match
    detail: detailNode ? elementValue(detailNode, "Detail", normaliseOptions()) : null,
  };
}

/**
 * Extract a SOAP fault without throwing. Returns null when the payload is not a fault.
 * Accepts a decoded string or raw bytes.
 */
export function readFault(input) {
  const { text } = typeof input === "string" ? { text: input } : decodeResponseBytes(input);
  if (text.indexOf("Fault") === -1) return null;
  let doc;
  try {
    doc = parseElements(text);
  } catch {
    return null;
  }
  const faultNode = findFaultNode(doc);
  return faultNode ? faultFromNode(faultNode) : null;
}

function findFaultNode(doc) {
  const roots = doc.children;
  const envelope = roots.find((r) => r.name === "Envelope");
  const body = envelope ? findChild(envelope, "Body") : null;
  const scope = body ?? envelope ?? { children: roots };
  return findChild(scope, "Fault");
}

/**
 * Normalise a list-operation result. Use ONLY where the WSDL types the result `ArrayOf*`.
 * This replaces the probe's `arr()` helper, whose `Array.isArray(x) ? x : [x]` turned the
 * collapsed 618-product object into "1 record" (scale.json parsedLength).
 *
 * An empty or whitespace-only STRING is zero records, not one. The live server self-closes an
 * empty list (`<Discount_GetAllResult/>` — gaps.json sections.discounts counts 0 from
 * `arr(all.result)` with no filter, which is only reachable via null), but the offline mock this
 * repo is built against writes `<ns1:XResult></ns1:XResult>`, which parses to "". Returning [""]
 * for that is one phantom record from an empty page — the exact scale.json parsedLength:1 failure
 * class this module exists to kill.
 */
export function asRecords(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim() === "") return [];
  return [value];
}

/**
 * Parse a SOAP response body and unwrap the doc/literal `<OpResponse><OpResult>` layer.
 *
 * @param {string|Uint8Array|ArrayBuffer} input raw bytes (preferred) or an already-decoded string
 * @param {string} [opName] the operation that was called, e.g. "Product_GetVariants"
 * @param {object} [options]
 *   arrayElements  string[]  element names (or "Parent/Child" path suffixes) the WSDL types as
 *                            ArrayOf*; makes an empty `<X/>` parse as [] instead of null. A hint
 *                            never wraps an element that carries text — see elementValue rule (d)
 *   resultIsArray  boolean   shorthand for adding "<op>Result" to arrayElements
 *   failOnMojibake boolean   DEFAULT TRUE (F2 "fail loudly"): a double-encoded response throws
 *                            EncodingError. Pass false to survey instead and read `.mojibake`
 *   trimText       boolean   trim character data (default false: HTML/Text fields stay verbatim)
 * @returns {{op: string|null, result: *, resultElement: string|null, mojibake: boolean,
 *            decodedAs: string, text: string}}
 * @throws {SoapFaultError} when the Body carries a Fault
 * @throws {XmlParseError}  when the XML is malformed or the expected response element is absent
 * @throws {EncodingError}  on mojibake unless failOnMojibake:false
 */
export function parseSoapResponse(input, opName = null, options = {}) {
  const { text, decodedAs, mojibake } = decodeResponseBytes(input);
  // F2 is imperative in the brief ("keep a mojibake detector and fail loudly"), and the cost of
  // getting it wrong is not recoverable: a double-encoded title migrated into Shopify looks like
  // data. So the throw is the default and the survey mode is the opt-in, not the other way round.
  if (mojibake && options.failOnMojibake !== false) {
    throw new EncodingError(
      `response is double-encoded (F2): ${MOJIBAKE_RE} matched${opName ? ` in ${opName}` : ""}. ` +
      "Never call Solution_SetEncoding — it makes the API convert twice. " +
      "Pass { failOnMojibake: false } to inspect it anyway.",
      { op: opName, decodedAs, mojibake: true, sample: mojibakeSample(text) },
    );
  }

  const doc = parseElements(text);
  const envelope = doc.children.find((r) => r.name === "Envelope") ?? null;
  let body = null;
  if (envelope) {
    body = findChild(envelope, "Body");
    if (!body) throw new XmlParseError("SOAP Envelope without a Body");
  }
  const scope = body ?? { name: "#fragment", children: doc.children, text: doc.text, hasText: doc.hasText };

  const faultNode = findChild(scope, "Fault");
  if (faultNode) throw new SoapFaultError(faultFromNode(faultNode), text);

  const wanted = opName ? `${opName}Response` : null;
  let responseNode = wanted ? findChild(scope, wanted) : null;
  if (!responseNode && opName) responseNode = findChild(scope, opName);
  if (!responseNode) {
    const candidates = scope.children.filter((c) => c.name.endsWith("Response"));
    if (candidates.length === 1 && !opName) responseNode = candidates[0];
    else if (!opName && scope.children.length === 1) responseNode = scope.children[0];
  }
  if (!responseNode) {
    const found = scope.children.map((c) => c.name).join(", ") || "(nothing)";
    throw new XmlParseError(`expected <${wanted ?? "*Response"}> in the SOAP Body, found: ${found}`);
  }

  const arrayElements = [...(options.arrayElements ?? [])];
  const resultName = opName ? `${opName}Result` : null;
  if (options.resultIsArray && resultName) arrayElements.push(resultName);
  const opts = normaliseOptions({ ...options, arrayElements });

  // Unwrap the doc/literal result wrapper: <OpResponse><OpResult>X</OpResult></OpResponse> -> X.
  // Exactly one child whose name is <op>Result — or, when the WSDL named the wrapper something
  // else, any single child ending in "Result". More than one child means the response is not
  // wrapped and every child is part of the result object.
  const kids = responseNode.children;
  let target = responseNode;
  let resultElement = null;
  if (kids.length === 1 && (kids[0].name === resultName || kids[0].name.endsWith("Result"))) {
    target = kids[0];
    resultElement = target.name;
  }

  const basePath = resultElement ?? responseNode.name;
  let result = elementValue(target, basePath, opts);
  // An empty RESULT wrapper means "nothing", whichever way the server spelled it. The live
  // server self-closes (`<Discount_GetAllResult/>` -> null) but the offline mock writes
  // `<ns1:XResult></ns1:XResult>` -> "", and "" then becomes one phantom record downstream.
  // Scoped to the unwrapped result element only: `<ItemNumber></ItemNumber>` inside a record
  // still parses to "" so the R26 empty-value-vs-missing-column distinction survives.
  if (resultElement !== null && typeof result === "string" && result.trim() === "") result = null;
  if (options.resultIsArray) result = asRecords(result);

  return { op: opName, result, resultElement, mojibake, decodedAs, text };
}
