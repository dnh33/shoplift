// test/operations.test.mjs — tests for the PINNED operation surface and its generator.
//
// Every test here is written so it FAILS if the thing it guards is removed:
//   - the three R27 operations that were broken by hand-guessed argument names
//   - R4's real field-list case (Product_SetFields "Id,Files")
//   - F1's endpoint-from-soap:address (compared against the WSDL, not against a constant)
//   - R27's "generated, never hand-edited" rule (regenerate and diff, byte for byte)
//   - F1's default-namespace WSDL (re-run the generator on a wsdl:-prefixed copy)
//
// Run: node --test test/operations.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OPERATIONS,
  OPERATION_COUNT,
  TYPES,
  TYPE_COUNT,
  TYPE_DETAILS,
  ENUMS,
  ENDPOINT,
  SOURCE,
  FIELD_SET_OPERATIONS,
  SET_FIELDS_TYPE,
  FORBIDDEN_OPERATIONS,
  argNamesFor,
  orderedArgs,
  validateArgs,
  validateFields,
  fieldsFor,
  hasOperation,
  hasType,
  operationFor,
  operationNames,
} from "../src/dandomain/operations.js";

const MODULE_PATH = fileURLToPath(new URL("../src/dandomain/operations.js", import.meta.url));
const GENERATOR_PATH = fileURLToPath(new URL("../scripts/gen-operations.mjs", import.meta.url));
const WSDL_PATH = fileURLToPath(new URL("../data/probes/service.wsdl", import.meta.url));
const GAPS_PATH = fileURLToPath(new URL("../data/probes/gaps.json", import.meta.url));

/** Run the generator over a rewritten WSDL. Returns { status, stderr, text }. */
function generateFrom(rewrite, tag) {
  const wsdl = readFileSync(WSDL_PATH, "utf8");
  const mutated = rewrite(wsdl);
  assert.notEqual(mutated, wsdl, `fixture rewrite "${tag}" did not apply`);
  const dir = mkdtempSync(join(tmpdir(), `ops-${tag}-`));
  const src = join(dir, "fixture.wsdl");
  const out = join(dir, "operations.js");
  writeFileSync(src, mutated, "utf8");
  const run = spawnSync(process.execPath, [GENERATOR_PATH, src, out], { encoding: "utf8" });
  return { status: run.status, stderr: run.stderr, text: run.status === 0 ? readFileSync(out, "utf8") : "" };
}

/* ------------------------------------------------------------------ *
 * The pinned counts and the three R27 operations
 * ------------------------------------------------------------------ */

test("OPERATION_COUNT is the WSDL's 247, not the doc app's 249 (F1)", () => {
  assert.equal(OPERATION_COUNT, 247);
  assert.equal(Object.keys(OPERATIONS).length, 247);
  assert.equal(operationNames().length, 247);
});

test("Order_GetAllWithPagination takes exactly Page, PageSize in order (R17/R27)", () => {
  assert.deepEqual(argNamesFor("Order_GetAllWithPagination"), ["Page", "PageSize"]);
});

test("Product_DeleteAllDiscounts takes exactly ProductItemNumber (R17/R27)", () => {
  assert.deepEqual(argNamesFor("Product_DeleteAllDiscounts"), ["ProductItemNumber"]);
});

test("PageText_GetByIds takes one STRING PageTextIds, not an array (R17/R27)", () => {
  assert.deepEqual(argNamesFor("PageText_GetByIds"), ["PageTextIds"]);
  const [arg] = OPERATIONS.PageText_GetByIds.args;
  assert.equal(arg.type, "xsd:string");
  assert.ok(!arg.type.startsWith("tns:Array"), "PageTextIds must not be an array type");
  assert.equal(arg.repeats, undefined, "PageTextIds is a single element, not a repeated one");
  // The RESULT is an array; only the argument is a string. Getting this backwards is
  // how an id list ends up serialised as repeated elements and silently dropped.
  assert.equal(OPERATIONS.PageText_GetByIds.resultType, "tns:ArrayOfPagetext");
  assert.equal(OPERATIONS.PageText_GetByIds.resultItemType, "tns:PageText");
});

/* ------------------------------------------------------------------ *
 * R4 — field lists
 * ------------------------------------------------------------------ */

test("TYPES.Product carries VatGroupId; TYPES.User has 56 fields (R4)", () => {
  assert.ok(TYPES.Product.includes("VatGroupId"));
  assert.equal(TYPES.User.length, 56);
  assert.equal(TYPE_COUNT, Object.keys(TYPES).length);
});

test("validateFields rejects Product 'Id,Files' — R4's real case", () => {
  // "Files" reads like a Product field (Pictures and Variants are), and there IS a
  // Product_GetFiles operation — but Files is not on the Product type, so this exact
  // list faults Product_SetFields and leaves the session on its PREVIOUS field set.
  const r = validateFields("Product", "Id,Files");
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalid, ["Files"]);
  assert.ok(!TYPES.Product.includes("Files"));
  assert.ok(hasType("ProductFile"), "the confusion is real: a ProductFile type exists");
});

test("validateFields accepts a good list, in string and array form (R4)", () => {
  assert.deepEqual(validateFields("Product", "Id,ItemNumber,Price,VatGroupId"), { ok: true, invalid: [] });
  assert.deepEqual(validateFields("Product", ["Id", "SeoLink"]), { ok: true, invalid: [] });
  assert.deepEqual(validateFields("Product", "Id, ItemNumber "), { ok: true, invalid: [] });
});

test("validateFields flags every bad name, not just the first (R4)", () => {
  const r = validateFields("Order", "Id,Vat,Nope,Total,AlsoNope");
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalid, ["Nope", "AlsoNope"]);
});

test("validateFields flags an empty token from a trailing/double comma (R4)", () => {
  // "Id,,Price" would send an empty field name; the API faults on it like any bad name.
  assert.deepEqual(validateFields("Product", "Id,,Price").invalid, [""]);
  assert.deepEqual(validateFields("Product", "Id,").invalid, [""]);
});

test("validateFields throws on an unknown type rather than passing the list through (R4)", () => {
  assert.throws(() => validateFields("Prodcut", "Id"), /Unknown DanDomain type "Prodcut"/);
  assert.throws(() => fieldsFor("NoSuchType"), /Unknown DanDomain type/);
  // Inherited Object properties are not types.
  assert.equal(hasType("constructor"), false);
  assert.throws(() => validateFields("toString", "Id"), /Unknown DanDomain type/);
});

/* ------------------------------------------------------------------ *
 * R17/R27 — argument validation
 * ------------------------------------------------------------------ */

test("validateArgs catches the wrong-case name that becomes a PHP arity error (R17/R27)", () => {
  const r = validateArgs("Order_GetAllWithPagination", { page: 1, PageSize: 100 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknown, ["page"]);
  assert.deepEqual(r.missingRequired, ["Page"]);
});

test("validateArgs accepts the exact declared set", () => {
  assert.deepEqual(
    validateArgs("Order_GetAllWithPagination", { Page: 1, PageSize: 100 }),
    { ok: true, unknown: [], missingRequired: [], missingNillable: [] },
  );
});

test("validateArgs treats undefined as absent and null as present (R17)", () => {
  // Order_GetAllWithPagination: BOTH arguments are non-nillable, so an absent one really is a
  // missingRequired. Order_GetByDate cannot show this — all three of ITS arguments are
  // nillable and the probe proved the server accepts them omitted (next test).
  assert.equal(OPERATIONS.Order_GetAllWithPagination.args.every((a) => !a.nillable), true);
  const dropped = validateArgs("Order_GetAllWithPagination", { Page: 1, PageSize: undefined });
  assert.equal(dropped.ok, false);
  assert.deepEqual(dropped.missingRequired, ["PageSize"]);
  assert.deepEqual(dropped.missingNillable, []);
  assert.deepEqual(dropped.unknown, []);
  // null is still an element on the wire, so PHP's argument count is satisfied.
  const nils = validateArgs("Order_GetAllWithPagination", { Page: null, PageSize: null });
  assert.equal(nils.ok, true);
  assert.deepEqual(nils.missingRequired, []);
  assert.equal(OPERATIONS.Order_GetByDate.args.find((a) => a.name === "Status").nillable, true);
});

test("an omitted NILLABLE argument does not fail .ok — the probe proved the server takes it (R17)", () => {
  // data/probes/gaps.json sections.orderGetByDate, "Status omitted": ok true, count 20,
  // statusIsOptionalInPractice true, omittingStatusReturnsEverything true. The probe's
  // serialiser walks Object.entries, so with no Status key there is no <Status> element at
  // all. Refusing that call locally made the date-window order read impossible without
  // inventing a Status — and the same recording shows Status:"0" returns 19 of 20 orders
  // (order 17, status 99, silently lost). This test reads the recording, not a copy of it.
  const gaps = JSON.parse(readFileSync(GAPS_PATH, "utf8"));
  const omitted = gaps.sections.orderGetByDate.tried.find((t) => t.label === "Status omitted");
  assert.ok(omitted, "the probe recording must still contain the Status-omitted call");
  assert.equal(omitted.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(omitted.args, "Status"), false);
  assert.equal(gaps.sections.orderGetByDate.statusIsOptionalInPractice, true);

  const r = validateArgs("Order_GetByDate", omitted.args);
  assert.equal(r.ok, true, "a call the live server accepted must not be refused locally");
  assert.deepEqual(r.missingRequired, []);
  assert.deepEqual(r.missingNillable, ["Status"], "still reported, as an advisory");
  // Same for the paginated twin, which a real date-window export would use.
  const paged = validateArgs("Order_GetByDateWithPagination", { ...omitted.args, Page: 1, PageSize: 100 });
  assert.equal(paged.ok, true);
  assert.deepEqual(paged.missingNillable, ["Status"]);
});

test("`required` carries no information in this WSDL — nillable is the only optionality signal", () => {
  // Every argument omits minOccurs, so required===true everywhere: a rule that equates
  // "declared" with "PHP requires it" is vacuous, which is exactly what the probe caught.
  const all = Object.values(OPERATIONS).flatMap((o) => o.args);
  assert.equal(all.length, 298);
  assert.equal(all.every((a) => a.required === true), true, "required is a constant in this WSDL");
  assert.equal(all.filter((a) => a.nillable).length, 22);
});

test("orderedArgs enforces the serialisation contract validateArgs assumes (R17)", () => {
  // undefined-valued keys must never reach the wire (that is what makes them "absent");
  // null-valued keys must; and the order is the WSDL's <xsd:sequence>, not the caller's.
  const { elements, unknown } = orderedArgs("Order_GetByDate", {
    Status: null, Start: "2019-01-01 00:00:00", End: undefined, Bogus: "x",
  });
  assert.deepEqual(elements.map((e) => e.name), ["Start", "Status"]);
  assert.deepEqual(elements.map((e) => e.value), ["2019-01-01 00:00:00", null]);
  assert.deepEqual(unknown, ["Bogus"], "an unknown name is reported, never silently dropped (R27)");
  assert.deepEqual(
    orderedArgs("Order_GetAllWithPagination", { PageSize: 100, Page: 1 }).elements.map((e) => e.name),
    ["Page", "PageSize"],
  );
  assert.throws(() => orderedArgs("Order_GetByDate", "Start=1"), TypeError);
  assert.throws(() => orderedArgs("Order_GetByDates", {}), /Unknown DanDomain operation/);
});

test("validateArgs refuses a non-object argument bag instead of reading it as empty", () => {
  assert.throws(() => validateArgs("Order_GetByDate", "Start,End"), TypeError);
  assert.throws(() => validateArgs("Order_GetByDate", 7), TypeError);
  assert.equal(validateArgs("Order_GetByDate", null).ok, true); // null means "no arguments"
});

test("validateArgs handles no-argument operations", () => {
  assert.deepEqual(argNamesFor("Solution_GetWebinfo"), []);
  assert.equal(validateArgs("Solution_GetWebinfo", {}).ok, true);
  assert.equal(validateArgs("Solution_GetWebinfo", undefined).ok, true);
  assert.deepEqual(validateArgs("Solution_GetWebinfo", { Extra: 1 }).unknown, ["Extra"]);
});

test("unknown operations throw instead of returning an empty arg list (R27)", () => {
  // Returning [] here is exactly the silent drop this module exists to prevent.
  assert.throws(() => argNamesFor("Order_GetAllWithPaging"), /Unknown DanDomain operation/);
  assert.throws(() => validateArgs("Product_DeleteAllDiscount", {}), /Unknown DanDomain operation/);
  // Order has *_WithPagination; Product does NOT. Symmetry is not a licence to guess.
  assert.throws(() => operationFor("Product_GetAllWithPagination"), /Unknown DanDomain operation/);
  assert.equal(hasOperation("Order_GetAllWithPagination"), true);
  assert.equal(hasOperation("Order_GetAllWithPaging"), false);
  assert.equal(hasOperation("hasOwnProperty"), false);
});

test("PageText_GetById and PageText_GetByIds are different calls (R27)", () => {
  // Both exist. One takes an int, the other a comma-string of ids. Passing the plural
  // name's argument to the singular operation is the R27 failure mode exactly.
  assert.deepEqual(argNamesFor("PageText_GetById"), ["PageTextId"]);
  assert.equal(OPERATIONS.PageText_GetById.args[0].type, "xsd:int");
  assert.deepEqual(argNamesFor("PageText_GetByIds"), ["PageTextIds"]);
  assert.equal(OPERATIONS.PageText_GetByIds.args[0].type, "xsd:string");
  assert.deepEqual(validateArgs("PageText_GetById", { PageTextIds: "1,2" }), {
    ok: false, unknown: ["PageTextIds"], missingRequired: ["PageTextId"], missingNillable: [],
  });
});

test("products paginate with Start/Length, orders with Page/PageSize (R17)", () => {
  assert.deepEqual(argNamesFor("Product_GetAllWithLimit"), ["Start", "Length"]);
  assert.deepEqual(argNamesFor("Order_GetAllWithPagination"), ["Page", "PageSize"]);
  assert.deepEqual(argNamesFor("Order_GetByDateWithPagination"), ["Start", "End", "Status", "Page", "PageSize"]);
  // Calling the product pager with the order pager's argument names drops both.
  const r = validateArgs("Product_GetAllWithLimit", { Page: 0, PageSize: 100 });
  assert.deepEqual(r.unknown, ["Page", "PageSize"]);
  assert.deepEqual(r.missingRequired, ["Start", "Length"]);
});

test("FIELD_SET_OPERATIONS lists ALL SIX field-set calls, each a single string (R4)", () => {
  // The "_SetFields" name suffix finds only four. Order_SetOrderLineFields and
  // Product_SetVariantFields are field-set calls too — the live probe used both
  // (probe-dandomain.mjs:880/943 and :1634) — and under R4 the client must re-assert EVERY
  // field set after a fault or reconnect, so a list short by two means the OrderLine and
  // ProductVariant formats silently drop back to Id-only after an AUTH replay.
  assert.deepEqual(FIELD_SET_OPERATIONS, [
    "User_SetFields", "Order_SetFields", "Order_SetOrderLineFields",
    "Product_SetFields", "Product_SetVariantFields", "PageText_SetFields",
  ]);
  for (const op of FIELD_SET_OPERATIONS) {
    assert.deepEqual(argNamesFor(op), ["Fields"]);
    assert.equal(OPERATIONS[op].args[0].type, "xsd:string");
  }
  // Derived independently here, from the surface itself: the list is exactly the operations
  // whose ONLY argument is Fields:xsd:string. A name-based list cannot satisfy this.
  const byShape = Object.entries(OPERATIONS)
    .filter(([, o]) => o.args.length === 1 && o.args[0].name === "Fields" && o.args[0].type === "xsd:string")
    .map(([n]) => n);
  assert.deepEqual([...FIELD_SET_OPERATIONS], byShape);
  assert.equal(byShape.filter((n) => !n.endsWith("_SetFields")).length, 2);
});

test("SET_FIELDS_TYPE comes from the WSDL's documentation, not from the operation name (R4)", () => {
  // The binding IS in the WSDL — every one of these operations documents itself as
  // "Sets the outputformat for all methods returning <Type> Objects". That string is why
  // Product_SetVariantFields maps to ProductVariant and not to Product.
  assert.deepEqual(SET_FIELDS_TYPE, {
    User_SetFields: "User",
    Order_SetFields: "Order",
    Order_SetOrderLineFields: "OrderLine",
    Product_SetFields: "Product",
    Product_SetVariantFields: "ProductVariant",
    PageText_SetFields: "PageText",
  });
  assert.deepEqual(Object.keys(SET_FIELDS_TYPE), [...FIELD_SET_OPERATIONS]);
  for (const [op, typeName] of Object.entries(SET_FIELDS_TYPE)) {
    assert.equal(hasType(typeName), true, `${op} maps to a type that is not in the WSDL`);
    // Re-derive from the transcribed documentation so a hand edit to either side fails.
    const m = /returning (\w+) Objects/.exec(OPERATIONS[op].documentation ?? "");
    assert.ok(m, `${op} documentation no longer names its type`);
    assert.equal(m[1], typeName);
  }
  // The mapping is load-bearing because validateFields() cannot detect a wrong guess:
  // every complexType is a legal argument, including wrappers and *Update inputs.
  assert.equal(validateFields("ProductUpdate", "Id").ok, true);
  assert.equal(validateFields("ArrayOfProduct", "item").ok, true);
  assert.equal(validateFields(SET_FIELDS_TYPE.Product_SetVariantFields, "PictureIds,StockLocations").ok, true);
  // ...and Product's own field list does NOT contain the variant fields, so guessing
  // "Product" for Product_SetVariantFields would fault the call under R4.
  assert.equal(validateFields("Product", "PictureIds").ok, false);
});

test("Solution_SetEncoding is in the WSDL and on the forbidden list (F2)", () => {
  // The surface must report the WSDL truthfully — the operation exists...
  assert.equal(hasOperation("Solution_SetEncoding"), true);
  assert.deepEqual(argNamesFor("Solution_SetEncoding"), ["Encoding"]);
  // ...and must carry the finding that says never to call it.
  assert.deepEqual(FORBIDDEN_OPERATIONS, ["Solution_SetEncoding"]);
  for (const op of FORBIDDEN_OPERATIONS) assert.equal(hasOperation(op), true, `${op} ban is stale`);
});

/* ------------------------------------------------------------------ *
 * F1 — endpoint and structural integrity against the WSDL itself
 * ------------------------------------------------------------------ */

test("ENDPOINT is the WSDL's soap:address, read from the WSDL at test time (F1)", () => {
  const wsdl = readFileSync(WSDL_PATH, "utf8");
  const m = wsdl.match(/<soap:address\s+location="([^"]+)"/);
  assert.ok(m, "the WSDL must declare a soap:address");
  assert.equal(ENDPOINT, m[1]);
  assert.match(ENDPOINT, /^https:\/\//);
});

test("SOURCE pins the exact WSDL bytes the surface was generated from", () => {
  const bytes = readFileSync(WSDL_PATH);
  assert.equal(SOURCE.bytes, bytes.length);
  assert.equal(SOURCE.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(SOURCE.style, "document");
});

test("every operation is complete and internally consistent", () => {
  const wsdl = readFileSync(WSDL_PATH, "utf8");
  for (const [name, op] of Object.entries(OPERATIONS)) {
    assert.ok(op.soapAction, `${name} has no soapAction`);
    assert.ok(op.requestElement, `${name} has no requestElement`);
    assert.ok(op.responseElement, `${name} has no responseElement`);
    assert.ok(Array.isArray(op.args), `${name} has no args array`);
    const seen = new Set();
    for (const a of op.args) {
      assert.ok(a.name && typeof a.name === "string", `${name} has a nameless argument`);
      assert.equal(seen.has(a.name), false, `${name} declares ${a.name} twice`);
      seen.add(a.name);
      assert.match(a.type, /^(xsd|tns):/, `${name}.${a.name} has an unresolved type ${a.type}`);
      if (a.type.startsWith("tns:")) {
        const local = a.type.slice(4);
        assert.ok(hasType(local) || local in ENUMS, `${name}.${a.name} points at missing type ${local}`);
      }
      assert.equal(typeof a.nillable, "boolean");
      assert.equal(typeof a.required, "boolean");
    }
    // The WSDL must actually contain this operation name (guards a fabricated entry).
    assert.ok(wsdl.includes(`<operation name="${name}"`), `${name} is not in the WSDL`);
  }
});

test("array results are transcribed for this WSDL", () => {
  assert.equal(OPERATIONS.Product_GetAll.resultType, "tns:ArrayOfProduct");
  assert.equal(OPERATIONS.Product_GetAll.resultItemType, "tns:Product");
  assert.equal(OPERATIONS.Product_GetAll.resultItemElement, "item");
  assert.deepEqual(TYPES.ArrayOfProduct, ["item"]);
  assert.equal(TYPE_DETAILS.ArrayOfProduct.arrayOf, "tns:Product");
  // A scalar result must NOT be marked as an array.
  assert.equal(OPERATIONS.Solution_Connect.resultType, "xsd:boolean");
  assert.equal(OPERATIONS.Solution_Connect.resultItemType, undefined);
  assert.equal(TYPE_DETAILS.Product.arrayOf, null);
});

test("array detection follows the PARTICLE when the name disagrees with it", () => {
  // In service.wsdl the two rules agree exactly — all 54 structurally-detected wrappers are
  // also named ArrayOf*, so no assertion over this WSDL can tell them apart. (Verified: a
  // generator that used /^ArrayOf/ instead of the particle produced a byte-identical file.)
  // This fixture makes them disagree in both directions.
  assert.equal(
    Object.entries(TYPE_DETAILS).filter(([, d]) => d.arrayOf !== null).length,
    Object.keys(TYPE_DETAILS).filter((n) => /^ArrayOf/i.test(n)).length,
  );
  const { status, stderr, text } = generateFrom(
    (wsdl) => wsdl
      // (1) a wrapper whose NAME is not ArrayOf* but whose particle repeats.
      .replace(/ArrayOfProduct\b/g, "BatchOfProduct")
      // (2) a type NAMED ArrayOf* whose single child does NOT repeat.
      .replace(
        /(<xsd:complexType name="ArrayOfString">\s*<xsd:sequence>\s*<xsd:element name="item" type="xsd:string" minOccurs="0")\s*maxOccurs="unbounded"/,
        "$1",
      ),
    "array-shape",
  );
  assert.equal(status, 0, `generator failed on the array fixture: ${stderr}`);
  // Structure wins: the renamed wrapper is still an array...
  assert.match(text, /"BatchOfProduct": \{\n\s+"kind": "sequence",\n\s+"arrayOf": "tns:Product",\n\s+"itemElement": "item"/);
  assert.match(text, /"resultType": "tns:BatchOfProduct",\n\s+"resultItemType": "tns:Product"/);
  // ...and the ArrayOf*-named type whose child does not repeat is NOT one.
  assert.match(text, /"ArrayOfString": \{\n\s+"kind": "sequence",\n\s+"arrayOf": null,\n\s+"itemElement": null/);
  assert.equal(/"resultType": "tns:ArrayOfString",\n\s+"resultItemType": "xsd:string"/.test(text), false);
});

test("soapAction is transcribed from the binding, not synthesised as tns#name", () => {
  // Every soapAction in service.wsdl happens to equal `${targetNamespace}#${name}`, so a
  // generator that synthesised them would produce the same file. Move one and check it moves.
  for (const [name, op] of Object.entries(OPERATIONS)) {
    assert.equal(op.soapAction, `${SOURCE.targetNamespace}#${name}`);
  }
  const { status, stderr, text } = generateFrom(
    (wsdl) => wsdl.replace(
      'soapAction="https://api.hostedshop.io/service.php#Order_GetById"',
      'soapAction="urn:elsewhere/OrderGetById"',
    ),
    "soapaction",
  );
  assert.equal(status, 0, `generator failed on the soapAction fixture: ${stderr}`);
  assert.match(text, /"Order_GetById": \{\n\s+"soapAction": "urn:elsewhere\/OrderGetById"/);
});

test("TYPE_DETAILS.fields is the full typed field list, not decoration", () => {
  // 163 KB of this file is TYPE_DETAILS.fields. Nothing used to read it: a generator that
  // emitted `"fields": []` for all 178 types left the suite green.
  assert.equal(Object.keys(TYPE_DETAILS).length, TYPE_COUNT);
  for (const [name, detail] of Object.entries(TYPE_DETAILS)) {
    assert.deepEqual(detail.fields.map((f) => f.name), TYPES[name], `${name}.fields disagrees with TYPES`);
    for (const f of detail.fields) {
      assert.match(f.type, /^(xsd|tns):/, `${name}.${f.name} has an unresolved type`);
      if (f.type.startsWith("tns:")) {
        const local = f.type.slice(4);
        assert.ok(hasType(local) || local in ENUMS, `${name}.${f.name} points at missing type ${local}`);
      }
      assert.equal(typeof f.nillable, "boolean");
      assert.equal(typeof f.required, "boolean");
    }
  }
  assert.equal(Object.values(TYPE_DETAILS).reduce((n, d) => n + d.fields.length, 0) > 1000, true);
  // Spot-checks with real values behind them.
  assert.deepEqual(
    TYPE_DETAILS.Product.fields.find((f) => f.name === "LanguageAccess"),
    { name: "LanguageAccess", type: "tns:ArrayOfString", nillable: false, required: false },
  );
  assert.deepEqual(
    TYPE_DETAILS.ArrayOfProduct.fields,
    [{ name: "item", type: "tns:Product", nillable: false, required: false, repeats: true }],
  );
  // R2: Order.Vat and OrderLine.VatRate exist in the WSDL (they are always 0 — never read
  // them), so the transcription must show them rather than quietly tidying them away.
  assert.ok(TYPE_DETAILS.Order.fields.some((f) => f.name === "Vat"));
  assert.ok(TYPE_DETAILS.OrderLine.fields.some((f) => f.name === "VatRate"));
});

test("ENUMS transcribes the WSDL's simpleType restrictions", () => {
  // An empty ENUMS also left the suite green. This reads the WSDL back.
  const wsdl = readFileSync(WSDL_PATH, "utf8");
  const names = [...wsdl.matchAll(/<xsd:simpleType name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(Object.keys(ENUMS).sort(), [...new Set(names)].sort());
  assert.deepEqual(ENUMS.AssociationType, { base: "xsd:string", values: ["INCLUSION", "EXCLUSION"] });
  for (const [name, e] of Object.entries(ENUMS)) {
    assert.ok(e.values.length > 0, `${name} has no enumeration values`);
    for (const v of e.values) {
      assert.match(wsdl, new RegExp(`<xsd:enumeration value="${v}"\\s*/>`), `${name} value ${v} is not in the WSDL`);
    }
  }
  // ENUMS is reachable: at least one argument or field is typed by one of these.
  const used = Object.values(OPERATIONS).flatMap((o) => o.args)
    .concat(Object.values(TYPE_DETAILS).flatMap((d) => d.fields))
    .filter((a) => a.type.startsWith("tns:") && a.type.slice(4) in ENUMS);
  assert.ok(used.length > 0, "no argument or field uses an enum — then ENUMS should be dropped");
});

test("the surface is pinned: it cannot be mutated at runtime", () => {
  assert.throws(() => { OPERATIONS.Order_GetAllWithPagination.args.push({ name: "Nope" }); }, TypeError);
  assert.throws(() => { TYPES.Product.push("Files"); }, TypeError);
  assert.throws(() => { OPERATIONS.Invented = { args: [] }; }, TypeError);
  assert.throws(() => { FORBIDDEN_OPERATIONS.pop(); }, TypeError);
  assert.throws(() => { FIELD_SET_OPERATIONS.push("Nope_SetFields"); }, TypeError);
  assert.deepEqual(argNamesFor("Order_GetAllWithPagination"), ["Page", "PageSize"]);
});

/* ------------------------------------------------------------------ *
 * R27 — the file is generated, never hand-edited
 * ------------------------------------------------------------------ */

test("regenerating from the WSDL reproduces the committed file byte for byte (R27)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-regen-"));
  const out = join(dir, "operations.js");
  const run = spawnSync(process.execPath, [GENERATOR_PATH, WSDL_PATH, out], { encoding: "utf8" });
  assert.equal(run.status, 0, `generator failed: ${run.stderr}`);
  assert.equal(
    readFileSync(out, "utf8"),
    readFileSync(MODULE_PATH, "utf8"),
    "src/dandomain/operations.js differs from generator output — it was hand-edited (R27) " +
    "or the generator changed without being re-run",
  );
});

test("importing the module writes nothing to stdout and has no side effects (invariant 4)", () => {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import ${JSON.stringify(pathToFileURL(MODULE_PATH).href)}`],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
});

test("the module has zero runtime dependencies (invariant 1)", () => {
  const src = readFileSync(MODULE_PATH, "utf8");
  assert.equal(/^\s*import\s/m.test(src), false, "operations.js must not import anything");
  assert.equal(/require\(/.test(src), false);
});

/* ------------------------------------------------------------------ *
 * F1 — the generator reads namespaces, not prefixes
 * ------------------------------------------------------------------ */

test("the generator produces the same surface from a wsdl:-prefixed WSDL (F1)", () => {
  // This WSDL puts WSDL elements in the DEFAULT namespace. A prefix-matching generator
  // would break the moment the shop's WSDL is re-fetched with explicit prefixes. Rewrite
  // it to <wsdl:definitions> with a hostile default namespace and re-generate.
  const wsdl = readFileSync(WSDL_PATH, "utf8");
  assert.ok(wsdl.includes('xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"'), "fixture needs the wsdl prefix declared");
  const prefixed = wsdl
    // WSDL elements move out of the default namespace, and the default becomes a trap.
    .replace('xmlns="http://schemas.xmlsoap.org/wsdl/"', 'xmlns="urn:trap-if-you-match-prefixes"')
    .replace(
      /<(\/?)(definitions|types|message|part|portType|operation|input|output|binding|service|port|documentation)(?=[\s/>])/g,
      "<$1wsdl:$2",
    )
    // ...and every other prefix is renamed, so only URI resolution can still read this.
    .replace("xmlns:xsd=", "xmlns:s=").replaceAll("xsd:", "s:")
    .replace("xmlns:tns=", "xmlns:t=").replaceAll("tns:", "t:")
    .replace("xmlns:soap=", "xmlns:sp=").replaceAll("soap:", "sp:");
  assert.ok(prefixed.includes("<wsdl:operation name=\"Order_GetAllWithPagination\">"));
  assert.ok(!/<operation name=/.test(prefixed), "rewrite must leave no unprefixed <operation>");
  assert.ok(!/xsd:|tns:|<soap:/.test(prefixed), "rewrite must leave no original prefixes");
  assert.ok(prefixed.includes('<s:element name="Page" type="s:int" />'));

  const dir = mkdtempSync(join(tmpdir(), "ops-ns-"));
  const src = join(dir, "prefixed.wsdl");
  const out = join(dir, "operations.js");
  writeFileSync(src, prefixed, "utf8");
  const run = spawnSync(process.execPath, [GENERATOR_PATH, src, out], { encoding: "utf8" });
  assert.equal(run.status, 0, `generator failed on prefixed WSDL: ${run.stderr}`);

  const text = readFileSync(out, "utf8");
  // Same endpoint, same operation count, same argument lists — only SOURCE metadata
  // (path, sha256, byte count) may differ.
  assert.ok(text.includes(`export const ENDPOINT = ${JSON.stringify(ENDPOINT)};`));
  assert.ok(text.includes(`export const OPERATION_COUNT = ${OPERATION_COUNT};`));
  const committed = readFileSync(MODULE_PATH, "utf8");
  const body = (t) => t.slice(t.indexOf("export const OPERATIONS = {"));
  assert.equal(body(text), body(committed), "prefixed WSDL produced a different surface");
});

/* ------------------------------------------------------------------ *
 * The generator's guards — each one proved to bite, on a hostile WSDL
 *
 * These guards all worked, and deleting any of them left the suite green: nothing exercised
 * them. Each test below rewrites service.wsdl into the shape the guard exists to catch and
 * asserts the build FAILS with that guard's message. Without them the guards are decoration.
 * ------------------------------------------------------------------ */

test("F1: an operation in <binding> but not in <portType> fails the build", () => {
  // This IS the doc app's 249-vs-247 scenario: the two lists must agree name for name, and
  //247 must be whatever the WSDL says rather than a number anyone typed in.
  const { status, stderr } = generateFrom(
    (wsdl) => wsdl.replace(
      '\t\t<operation name="Solution_GetWebinfo">\n\t\t\t<soap:operation',
      '\t\t<operation name="Solution_GetPhantom">\n\t\t\t<soap:operation\n' +
      '\t\t\t\tsoapAction="https://api.hostedshop.io/service.php#Solution_GetPhantom" />\n' +
      '\t\t\t<input>\n\t\t\t\t<soap:body use="literal" />\n\t\t\t</input>\n' +
      '\t\t\t<output>\n\t\t\t\t<soap:body use="literal" />\n\t\t\t</output>\n\t\t</operation>\n' +
      '\t\t<operation name="Solution_GetWebinfo">\n\t\t\t<soap:operation',
    ),
    "binding-only",
  );
  assert.notEqual(status, 0, "generator accepted an operation that only exists in <binding>");
  assert.match(stderr, /Operation Solution_GetPhantom is in <binding> but not in <portType>/);
});

test("F1: an operation in <portType> but not in <binding> fails the build", () => {
  const { status, stderr } = generateFrom(
    (wsdl) => wsdl.replace(
      '\t\t<operation name="Product_GetUnitById">',
      '\t\t<operation name="Product_GetPhantom">\n' +
      '\t\t\t<input message="tns:Product_GetUnitByIdIn" />\n' +
      '\t\t\t<output message="tns:Product_GetUnitByIdOut" />\n\t\t</operation>\n' +
      '\t\t<operation name="Product_GetUnitById">',
    ),
    "porttype-only",
  );
  assert.notEqual(status, 0, "generator accepted an operation that only exists in <portType>");
  assert.match(stderr, /Operation Product_GetPhantom is in <portType> but not in <binding>/);
});

test("F2: the forbidden-operations ban cannot rot into a no-op", () => {
  // If the vendor renames Solution_SetEncoding, a ban listing the old name silently protects
  // nothing — and F2 is the finding that costs irreversibly destroyed writes.
  const { status, stderr } = generateFrom(
    (wsdl) => wsdl.replaceAll("Solution_SetEncoding", "Solution_SetCharset"),
    "stale-ban",
  );
  assert.notEqual(status, 0, "generator accepted a WSDL where the F2 ban matches nothing");
  assert.match(stderr, /FORBIDDEN_OPERATIONS lists Solution_SetEncoding, which this WSDL does not declare/);
});

test("R4: a *_SetFields operation that stops taking one Fields string fails the build", () => {
  const { status, stderr } = generateFrom(
    (wsdl) => wsdl.replace(
      '<xsd:element name="Product_SetFields">\n\t\t\t\t<xsd:complexType>\n\t\t\t\t\t<xsd:sequence>\n\t\t\t\t\t\t<xsd:element name="Fields" type="xsd:string" />',
      '<xsd:element name="Product_SetFields">\n\t\t\t\t<xsd:complexType>\n\t\t\t\t\t<xsd:sequence>\n\t\t\t\t\t\t<xsd:element name="Fields" type="xsd:int" />',
    ),
    "setfields-shape",
  );
  assert.notEqual(status, 0, "generator accepted a *_SetFields that is not a single string");
  assert.match(stderr, /Product_SetFields is named \*_SetFields but does not take a single xsd:string "Fields" argument/);
});

test("R4: a *_SetFields whose documentation stops naming its type fails the build", () => {
  // SET_FIELDS_TYPE is parsed from that sentence. If it changes, the mapping must not be
  // guessed from the operation name — that is how Product_SetVariantFields would become
  // "Product" and green-light a field list that faults the call.
  const { status, stderr } = generateFrom(
    (wsdl) => wsdl.replace(
      "<documentation>Sets the output format for all methods returning\n\t\t\t\tProductVariant Objects. If not set, the output format includes the\n\t\t\t\tId</documentation>",
      "<documentation>Sets the output format for variants.</documentation>",
    ),
    "setfields-doc",
  );
  assert.notEqual(status, 0, "generator accepted a field-set operation with no type in its docs");
  assert.match(stderr, /Product_SetVariantFields documentation does not say which type it formats/);
});

test("the generator fails loudly on a WSDL it cannot resolve (no silent guessing)", () => {
  const wsdl = readFileSync(WSDL_PATH, "utf8");
  const broken = wsdl.replace(
    '<message name="Order_GetByIdIn">',
    '<message name="Order_GetByIdIn_TYPO">',
  );
  assert.notEqual(broken, wsdl, "fixture rewrite did not apply");
  const dir = mkdtempSync(join(tmpdir(), "ops-broken-"));
  const src = join(dir, "broken.wsdl");
  writeFileSync(src, broken, "utf8");
  const run = spawnSync(
    process.execPath,
    [GENERATOR_PATH, src, join(dir, "operations.js")],
    { encoding: "utf8" },
  );
  assert.notEqual(run.status, 0, "generator accepted a WSDL with a dangling input message");
  assert.match(run.stderr, /unknown input message Order_GetByIdIn/);
});
