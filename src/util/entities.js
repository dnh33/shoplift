/**
 * HTML entity decoding, at FOUNDATION level so both the transform layer and the
 * source adapters can use one implementation.
 *
 * It lives here because of a live finding, not for tidiness: one DanDomain
 * `Payment_GetAll` response carried `Kontooverf&oslash;rsel` and
 * `Ingen betaling nødvendig` in the SAME field on ADJACENT rows — entity-encoded
 * and raw UTF-8 together (PLAYBOOK, adversarial review of F1-F38). The mojibake
 * detector in `dandomain/xml.js` cannot see `&oslash;`, so an adapter that does
 * not decode ships "Kontooverf&oslash;rsel" into Shopify as a payment title.
 *
 * NAMED entities beyond the XML five are therefore in scope. The set below is
 * the Latin-1 supplement plus the handful of typographic entities a Danish or
 * German shop actually emits — not a full HTML5 table, which would be a
 * dependency-sized artefact for a handful of real cases.
 *
 * RELATIONSHIP TO `transform/html.js#decodeEntities`. That one stays exactly as
 * it is and keeps serving the WordPress path: P2's contract was that the Woo
 * path comes out bit-identical, and widening a decoder that feeds `toHandle`
 * would change Shopify handles for any Woo shop whose titles contain `&oslash;`.
 *
 * This one is NOT a superset of it, and an earlier version of this comment said
 * it was. The counter-example is `&amp;lt;`, six characters meaning the literal
 * text `&lt;`. The narrow decoder replaces `&amp;` first and then `&lt;` on the
 * result, yielding `<` — it invents a tag delimiter the source never had. This
 * one resolves in a single pass and yields `&lt;`, which is right. So the two
 * decoders DISAGREE on double-encoded input, and the wide one is correct there.
 *
 * What is actually pinned, in `test/source-dandomain.test.mjs`, is the narrower
 * claim that holds: on SINGLY-encoded input the wide decoder agrees with the
 * narrow one and additionally resolves the Latin-1 names. The double-encoded
 * divergence is asserted too, explicitly, so the difference is a recorded
 * decision rather than a drift nobody noticed. Claiming "superset" and testing
 * only the happy direction is how a false invariant survives review.
 */
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å",
  auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", szlig: "ß",
  eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", ecirc: "ê", Ecirc: "Ê",
  agrave: "à", Agrave: "À", acirc: "â", Acirc: "Â", ccedil: "ç", Ccedil: "Ç",
  iacute: "í", Iacute: "Í", oacute: "ó", Oacute: "Ó", uacute: "ú", Uacute: "Ú",
  // No `ntilde_` key: the capture group is /[a-zA-Z][a-zA-Z0-9]{1,31}/, which has
  // no `_`, so such a key is unreachable by construction. It was dead weight that
  // read as coverage.
  ntilde: "ñ", Ntilde: "Ñ",
  copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
  hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", middot: "·", bull: "•", times: "×", divide: "÷", frac12: "½"
};

/**
 * Decode `&amp;`, `&#233;`, `&#xe9;` and the named set above.
 *
 * `&amp;` is resolved in the SAME pass as everything else, deliberately: a
 * sequential `.replace(/&amp;/g,"&")` followed by other replacements turns the
 * literal text `&amp;oslash;` — which means the six characters "&oslash;" — into
 * "ø", inventing a character the source never had. One pass cannot double-decode.
 */
export function decodeHtmlEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === "#") {
      // Only lower-case `x` is tested: the capture group is `#x[0-9a-fA-F]+`, so
      // `&#X41;` never reaches here at all. A `body[1] === "X"` arm looked like it
      // handled the upper-case form and handled nothing. If `&#X41;` must decode,
      // the REGEX is what widens — `[xX]` — not this branch.
      const cp = body[1] === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
      try { return String.fromCodePoint(cp); } catch { return whole; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : whole;
  });
}
