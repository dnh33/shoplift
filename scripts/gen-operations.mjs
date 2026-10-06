#!/usr/bin/env node
// scripts/gen-operations.mjs — emits src/dandomain/operations.js from the WSDL.
//
// WHY THIS SCRIPT EXISTS (R27): three operations were already broken by hand-guessed
// argument names. Unknown argument names are SILENTLY DROPPED by the server and come
// back as a PHP arity error ("Too few arguments to function WebService::X()"), not as
// NOSUCHPARAM (R17). The only defence is a surface transcribed mechanically from the
// WSDL, so src/dandomain/operations.js is generated and must never be hand-edited.
//
// WHY IT PARSES INSTEAD OF GREPS (F1, R6/R18): the WSDL puts WSDL elements in the
// DEFAULT namespace (<definitions>, <operation> — not <wsdl:operation>) while the schema
// uses the xsd: prefix. This parser resolves namespace URIs from in-scope xmlns
// declarations rather than trusting prefixes, so a re-fetched WSDL that switches to
// <wsdl:operation> or a different schema prefix still generates the same surface.
// It is a real stack parser, not a regex walker. R6/R18/R26 recorded what regex walking
// does to this API's RESPONSES (collapsed records, sibling fields hoisted into parallel
// arrays); nothing was probed about regex-walking the WSDL, but it is the same technique
// against the same kind of deeply repeated document, so it is not used here either.
//
// WHY THE ENDPOINT IS READ, NOT WRITTEN (F1): soap:address is the only source of truth
// for the SOAP endpoint. Nothing here hardcodes a URL.
//
// Usage: node scripts/gen-operations.mjs [wsdlPath] [outPath]
// Deterministic: same WSDL bytes in, byte-identical file out (no timestamps).

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const WSDL_NS = "http://schemas.xmlsoap.org/wsdl/";
const SOAP_NS = "http://schemas.xmlsoap.org/wsdl/soap/";
const XSD_NS = "http://www.w3.org/2001/XMLSchema";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/* ------------------------------------------------------------------ *
 * Minimal namespace-aware XML parser (stack based, boundary preserving)
 * ------------------------------------------------------------------ */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

// Find the ">" that closes a tag, ignoring ">" inside quoted attribute values.
function findTagEnd(src, from) {
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "\"" || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  throw new Error(`Unterminated tag starting at offset ${from}`);
}

function parseAttrs(raw) {
  const attrs = [];
  const re = /([^\s=/][^\s=]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    attrs.push({ name: m[1], value: decodeEntities(m[3] !== undefined ? m[3] : m[4]) });
  }
  return attrs;
}

function splitQName(q) {
  const i = q.indexOf(":");
  return i === -1 ? { prefix: "", local: q } : { prefix: q.slice(0, i), local: q.slice(i + 1) };
}

// Parses `src` into a tree of { uri, local, attrs, ns, children, parent }.
// `ns` is the in-scope prefix -> URI map, shared with the parent when unchanged.
function parseXml(src) {
  const root = { uri: null, local: "#document", attrs: {}, ns: { "": "", xml: "http://www.w3.org/XML/1998/namespace" }, children: [], parent: null };
  const stack = [root];
  let i = 0;

  const top = () => stack[stack.length - 1];
  const addText = (raw) => {
    if (raw === "") return;
    const parent = top();
    if (parent === root) return; // whitespace outside the document element
    parent.children.push({ uri: null, local: "#text", value: decodeEntities(raw), children: [] });
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { addText(src.slice(i)); break; }
    if (lt > i) addText(src.slice(i, lt));
    i = lt;

    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end === -1) throw new Error(`Unterminated comment at ${i}`);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      if (end === -1) throw new Error(`Unterminated CDATA at ${i}`);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end === -1) throw new Error(`Unterminated processing instruction at ${i}`);
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      i = findTagEnd(src, i) + 1;
      continue;
    }

    const gt = findTagEnd(src, i);
    const inner = src.slice(i + 1, gt);
    i = gt + 1;

    if (inner[0] === "/") {
      const { local, prefix } = splitQName(inner.slice(1).trim());
      const node = top();
      if (stack.length === 1) throw new Error(`Close tag </${inner.slice(1)}> with no open element`);
      const openName = node.prefix ? `${node.prefix}:${node.local}` : node.local;
      if (node.local !== local || (node.prefix || "") !== (prefix || "")) {
        throw new Error(`Mismatched close tag: <${openName}> closed by </${inner.slice(1).trim()}>`);
      }
      stack.pop();
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const wsAt = body.search(/[\s]/);
    const rawName = (wsAt === -1 ? body : body.slice(0, wsAt)).trim();
    const attrList = wsAt === -1 ? [] : parseAttrs(body.slice(wsAt));
    const { prefix, local } = splitQName(rawName);

    const parent = top();
    let ns = parent.ns;
    let declared = false;
    for (const a of attrList) {
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) {
        if (!declared) { ns = Object.assign(Object.create(null), ns); declared = true; }
        ns[a.name === "xmlns" ? "" : a.name.slice(6)] = a.value;
      }
    }
    if (prefix && ns[prefix] === undefined && prefix !== "xml") {
      throw new Error(`Undeclared namespace prefix "${prefix}" on <${rawName}>`);
    }

    const attrs = Object.create(null);
    for (const a of attrList) {
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
      // Unprefixed attribute names are in no namespace (XML Namespaces 1.0 §6.2).
      attrs[a.name] = a.value;
    }

    const node = {
      uri: prefix ? ns[prefix] : (ns[""] || ""),
      prefix,
      local,
      attrs,
      ns,
      children: [],
      parent,
    };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) {
    const open = stack[stack.length - 1];
    throw new Error(`Unclosed element <${open.local}> at end of document`);
  }
  const docEl = root.children.find((c) => c.uri !== null);
  if (!docEl) throw new Error("No document element found");
  return docEl;
}

function kids(node, uri, local) {
  return node.children.filter((c) => c.uri === uri && c.local === local);
}
function kid(node, uri, local) {
  const found = kids(node, uri, local);
  if (found.length > 1) throw new Error(`Expected at most one <${local}> under <${node.local}>, found ${found.length}`);
  return found[0] || null;
}
function attr(node, name) {
  return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
}
// Resolve a QName that appears in an ATTRIBUTE VALUE (type="xsd:string",
// element="tns:Foo"). Unprefixed values resolve to the in-scope default namespace,
// which is what XSD requires — and why this cannot be done with a prefix string match.
function resolveQName(node, value, what) {
  if (value === null) throw new Error(`Missing QName attribute (${what}) on <${node.local}>`);
  const { prefix, local } = splitQName(value.trim());
  const uri = prefix ? node.ns[prefix] : (node.ns[""] || "");
  if (prefix && uri === undefined) throw new Error(`Undeclared prefix in QName "${value}" (${what})`);
  return { uri: uri || "", local };
}

/* ------------------------------------------------------------------ *
 * WSDL -> model
 * ------------------------------------------------------------------ */

function build(wsdlText) {
  const defs = parseXml(wsdlText);
  if (defs.uri !== WSDL_NS || defs.local !== "definitions") {
    throw new Error(`Root element is <${defs.local}> in ${defs.uri}, expected <definitions> in ${WSDL_NS}`);
  }
  const tns = attr(defs, "targetNamespace");
  if (!tns) throw new Error("<definitions> has no targetNamespace");

  // --- schema ---------------------------------------------------------
  const typesEl = kid(defs, WSDL_NS, "types");
  if (!typesEl) throw new Error("<definitions> has no <types>");
  const schemas = kids(typesEl, XSD_NS, "schema");
  if (schemas.length === 0) throw new Error("<types> contains no <xsd:schema>");

  const elements = new Map();      // top-level xsd:element, by local name
  const complexTypes = new Map();  // named xsd:complexType
  const simpleTypes = new Map();   // named xsd:simpleType
  for (const schema of schemas) {
    const schemaTns = attr(schema, "targetNamespace") || tns;
    if (schemaTns !== tns) throw new Error(`Schema targetNamespace ${schemaTns} != definitions targetNamespace ${tns}`);
    for (const el of kids(schema, XSD_NS, "element")) {
      const name = attr(el, "name");
      if (!name) throw new Error("Top-level xsd:element with no name");
      if (elements.has(name)) throw new Error(`Duplicate top-level element ${name}`);
      elements.set(name, el);
    }
    for (const ct of kids(schema, XSD_NS, "complexType")) {
      const name = attr(ct, "name");
      if (!name) throw new Error("Top-level xsd:complexType with no name");
      if (complexTypes.has(name)) throw new Error(`Duplicate complexType ${name}`);
      complexTypes.set(name, ct);
    }
    for (const st of kids(schema, XSD_NS, "simpleType")) {
      const name = attr(st, "name");
      if (!name) throw new Error("Top-level xsd:simpleType with no name");
      simpleTypes.set(name, st);
    }
  }

  // Canonical type label: "xsd:int" for builtins, "tns:Product" for schema types.
  // Derived from the RESOLVED namespace URI, not from the prefix spelled in the file.
  function typeLabel(node, raw, what) {
    if (raw === null) return null;
    const q = resolveQName(node, raw, what);
    if (q.uri === XSD_NS) return `xsd:${q.local}`;
    if (q.uri === tns) return `tns:${q.local}`;
    throw new Error(`Type ${raw} (${what}) resolves to unknown namespace ${q.uri}`);
  }

  // The single particle (<xsd:sequence> / <xsd:all>) of a complexType, or null.
  function particleOf(ct) {
    const seq = kids(ct, XSD_NS, "sequence");
    const all = kids(ct, XSD_NS, "all");
    if (seq.length + all.length > 1) throw new Error("complexType with more than one particle");
    if (seq.length === 1) return { kind: "sequence", node: seq[0] };
    if (all.length === 1) return { kind: "all", node: all[0] };
    for (const c of ct.children) {
      if (c.uri === XSD_NS && (c.local === "complexContent" || c.local === "simpleContent" || c.local === "choice")) {
        throw new Error(`Unsupported particle <xsd:${c.local}> — generator must be taught this shape`);
      }
    }
    return null; // <xsd:complexType /> — a no-argument operation
  }

  function fieldsOf(particle) {
    if (!particle) return [];
    return kids(particle.node, XSD_NS, "element").map((el) => {
      const name = attr(el, "name");
      if (!name) throw new Error("xsd:element with no name inside a particle");
      const type = typeLabel(el, attr(el, "type"), `type of ${name}`);
      if (type === null) throw new Error(`Element ${name} has an inline (anonymous) type — generator must be taught this shape`);
      const minOccurs = attr(el, "minOccurs");
      const maxOccurs = attr(el, "maxOccurs");
      return {
        name,
        type,
        nillable: attr(el, "nillable") === "true",
        // minOccurs defaults to 1: absent means the server expects the argument.
        required: minOccurs === null ? true : Number(minOccurs) > 0,
        repeats: maxOccurs !== null && maxOccurs !== "1",
      };
    });
  }

  // --- named types ------------------------------------------------------
  const TYPES = {};
  const TYPE_DETAILS = {};
  for (const [name, ct] of complexTypes) {
    const particle = particleOf(ct);
    const fields = fieldsOf(particle);
    // An "ArrayOfX" wrapper is detected structurally (one repeating child), never by
    // its name — the name is a convention, the particle is the fact.
    const repeating = fields.filter((f) => f.repeats);
    const isArray = particle && particle.kind === "sequence" && fields.length === 1 && repeating.length === 1;
    TYPES[name] = fields.map((f) => f.name);
    TYPE_DETAILS[name] = {
      kind: particle ? particle.kind : "empty",
      arrayOf: isArray ? fields[0].type : null,
      itemElement: isArray ? fields[0].name : null,
      fields,
    };
  }

  const ENUMS = {};
  for (const [name, st] of simpleTypes) {
    const restriction = kid(st, XSD_NS, "restriction");
    if (!restriction) continue;
    ENUMS[name] = {
      base: typeLabel(restriction, attr(restriction, "base"), `base of ${name}`),
      values: kids(restriction, XSD_NS, "enumeration").map((e) => attr(e, "value")),
    };
  }

  // --- messages ---------------------------------------------------------
  const messages = new Map();
  for (const msg of kids(defs, WSDL_NS, "message")) {
    const name = attr(msg, "name");
    if (!name) throw new Error("<message> with no name");
    const parts = kids(msg, WSDL_NS, "part").map((p) => {
      const elAttr = attr(p, "element");
      if (elAttr === null) throw new Error(`<part> of message ${name} has no element= (rpc/encoded parts unsupported)`);
      const q = resolveQName(p, elAttr, `element of message ${name}`);
      if (q.uri !== tns) throw new Error(`Message ${name} references element outside tns: ${elAttr}`);
      return { name: attr(p, "name"), element: q.local };
    });
    if (parts.length !== 1) throw new Error(`Message ${name} has ${parts.length} parts, expected exactly 1`);
    messages.set(name, parts[0].element);
  }

  // --- binding (soapAction) --------------------------------------------
  const bindings = kids(defs, WSDL_NS, "binding");
  if (bindings.length !== 1) throw new Error(`Expected exactly 1 <binding>, found ${bindings.length}`);
  const binding = bindings[0];
  const soapBinding = kid(binding, SOAP_NS, "binding");
  const style = soapBinding ? attr(soapBinding, "style") : null;
  const transport = soapBinding ? attr(soapBinding, "transport") : null;
  const soapActions = new Map();
  for (const op of kids(binding, WSDL_NS, "operation")) {
    const name = attr(op, "name");
    if (!name) throw new Error("<operation> in <binding> with no name");
    if (soapActions.has(name)) throw new Error(`Duplicate binding operation ${name}`);
    const so = kid(op, SOAP_NS, "operation");
    soapActions.set(name, so ? attr(so, "soapAction") : null);
  }

  // --- service / endpoint (F1) ------------------------------------------
  const services = kids(defs, WSDL_NS, "service");
  if (services.length !== 1) throw new Error(`Expected exactly 1 <service>, found ${services.length}`);
  const ports = kids(services[0], WSDL_NS, "port");
  const bindingName = attr(binding, "name");
  const soapPorts = ports.filter((p) => kid(p, SOAP_NS, "address") !== null);
  if (soapPorts.length !== 1) throw new Error(`Expected exactly 1 SOAP port, found ${soapPorts.length}`);
  const portBinding = resolveQName(soapPorts[0], attr(soapPorts[0], "binding"), "port binding");
  if (portBinding.local !== bindingName) throw new Error(`Port binds ${portBinding.local}, not ${bindingName}`);
  const endpoint = attr(kid(soapPorts[0], SOAP_NS, "address"), "location");
  if (!endpoint) throw new Error("<soap:address> has no location");

  // --- portType operations ----------------------------------------------
  const portTypes = kids(defs, WSDL_NS, "portType");
  if (portTypes.length !== 1) throw new Error(`Expected exactly 1 <portType>, found ${portTypes.length}`);
  const bindingType = resolveQName(binding, attr(binding, "type"), "binding type");
  const portTypeName = attr(portTypes[0], "name");
  if (bindingType.local !== portTypeName) throw new Error(`Binding types ${bindingType.local}, portType is ${portTypeName}`);

  const OPERATIONS = {};
  const requestParticleKinds = new Set();
  for (const op of kids(portTypes[0], WSDL_NS, "operation")) {
    const name = attr(op, "name");
    if (!name) throw new Error("<operation> in <portType> with no name");
    if (Object.prototype.hasOwnProperty.call(OPERATIONS, name)) throw new Error(`Duplicate operation ${name}`);
    if (!soapActions.has(name)) throw new Error(`Operation ${name} is in <portType> but not in <binding>`);

    const inNode = kid(op, WSDL_NS, "input");
    const outNode = kid(op, WSDL_NS, "output");
    if (!inNode) throw new Error(`Operation ${name} has no <input>`);

    const inMsg = resolveQName(inNode, attr(inNode, "message"), `input of ${name}`);
    const reqElName = messages.get(inMsg.local);
    if (!reqElName) throw new Error(`Operation ${name}: unknown input message ${inMsg.local}`);
    const reqEl = elements.get(reqElName);
    if (!reqEl) throw new Error(`Operation ${name}: input message points at missing element ${reqElName}`);
    if (attr(reqEl, "type") !== null) throw new Error(`Request element ${reqElName} uses type= instead of an inline complexType`);
    const reqCt = kid(reqEl, XSD_NS, "complexType");
    if (!reqCt) throw new Error(`Request element ${reqElName} has no complexType`);
    const reqParticle = particleOf(reqCt);
    const args = fieldsOf(reqParticle);
    if (args.length > 0) requestParticleKinds.add(reqParticle.kind);

    let responseElement = null;
    let resultElement = null;
    let resultType = null;
    let resultItemType = null;
    let resultItemElement = null;
    if (outNode) {
      const outMsg = resolveQName(outNode, attr(outNode, "message"), `output of ${name}`);
      responseElement = messages.get(outMsg.local);
      if (!responseElement) throw new Error(`Operation ${name}: unknown output message ${outMsg.local}`);
      const resEl = elements.get(responseElement);
      if (!resEl) throw new Error(`Operation ${name}: output message points at missing element ${responseElement}`);
      const resCt = kid(resEl, XSD_NS, "complexType");
      if (!resCt) throw new Error(`Response element ${responseElement} has no complexType`);
      const resFields = fieldsOf(particleOf(resCt));
      if (resFields.length > 1) throw new Error(`Response element ${responseElement} has ${resFields.length} children, expected 0 or 1`);
      if (resFields.length === 1) {
        resultElement = resFields[0].name;
        resultType = resFields[0].type;
        if (resultType.startsWith("tns:")) {
          const det = TYPE_DETAILS[resultType.slice(4)];
          if (!det) throw new Error(`Response ${responseElement} references unknown type ${resultType}`);
          if (det.arrayOf) {
            resultItemType = det.arrayOf;
            resultItemElement = det.itemElement;
          }
        }
      }
    }

    for (const a of args) {
      if (a.type.startsWith("tns:")) {
        const local = a.type.slice(4);
        if (!TYPE_DETAILS[local] && !ENUMS[local]) throw new Error(`Operation ${name} arg ${a.name} has unknown type ${a.type}`);
      }
    }

    OPERATIONS[name] = {
      soapAction: soapActions.get(name),
      requestElement: reqElName,
      args,
      responseElement,
      resultElement,
      resultType,
      resultItemType,
      resultItemElement,
      documentation: textOf(kid(op, WSDL_NS, "documentation")),
    };
  }

  for (const name of soapActions.keys()) {
    if (!Object.prototype.hasOwnProperty.call(OPERATIONS, name)) {
      throw new Error(`Operation ${name} is in <binding> but not in <portType>`);
    }
  }

  return {
    endpoint,
    style,
    transport,
    targetNamespace: tns,
    requestParticleKinds,
    OPERATIONS,
    TYPES,
    TYPE_DETAILS,
    ENUMS,
  };
}

function textOf(node) {
  if (!node) return null;
  // <documentation> holds text only in this WSDL; collapse its wrapping whitespace.
  const raw = node.children.filter((c) => c.local === "#text").map((c) => c.value).join("");
  const s = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/* ------------------------------------------------------------------ *
 * Emission
 * ------------------------------------------------------------------ */

const q = (s) => JSON.stringify(s);

function emitArg(a, indent) {
  const parts = [
    `"name": ${q(a.name)}`,
    `"type": ${q(a.type)}`,
    `"nillable": ${a.nillable}`,
    `"required": ${a.required}`,
  ];
  if (a.repeats) parts.push(`"repeats": true`);
  return `${indent}{ ${parts.join(", ")} }`;
}

function emitOperations(ops) {
  const out = ["export const OPERATIONS = {"];
  const names = Object.keys(ops);
  names.forEach((name, idx) => {
    const op = ops[name];
    const lines = [];
    lines.push(`  ${q(name)}: {`);
    lines.push(`    "soapAction": ${q(op.soapAction)},`);
    lines.push(`    "requestElement": ${q(op.requestElement)},`);
    if (op.args.length === 0) {
      lines.push(`    "args": [],`);
    } else {
      lines.push(`    "args": [`);
      op.args.forEach((a, i) => {
        lines.push(emitArg(a, "      ") + (i === op.args.length - 1 ? "" : ","));
      });
      lines.push(`    ],`);
    }
    lines.push(`    "responseElement": ${q(op.responseElement)},`);
    lines.push(`    "resultElement": ${q(op.resultElement)},`);
    lines.push(`    "resultType": ${q(op.resultType)},`);
    if (op.resultItemType) {
      lines.push(`    "resultItemType": ${q(op.resultItemType)},`);
      lines.push(`    "resultItemElement": ${q(op.resultItemElement)},`);
    }
    lines.push(`    "documentation": ${q(op.documentation)}`);
    lines.push(`  }${idx === names.length - 1 ? "" : ","}`);
    out.push(lines.join("\n"));
  });
  out.push("};");
  return out.join("\n");
}

function emitTypes(types) {
  const out = ["export const TYPES = {"];
  const names = Object.keys(types);
  names.forEach((name, idx) => {
    const fields = types[name];
    const comma = idx === names.length - 1 ? "" : ",";
    if (fields.length === 0) {
      out.push(`  ${q(name)}: []${comma}`);
      return;
    }
    const oneLine = `  ${q(name)}: [${fields.map(q).join(", ")}]${comma}`;
    if (oneLine.length <= 110) {
      out.push(oneLine);
      return;
    }
    out.push(`  ${q(name)}: [`);
    // wrap at ~100 columns so long records stay diffable
    let line = "   ";
    for (let i = 0; i < fields.length; i++) {
      const tok = ` ${q(fields[i])}${i === fields.length - 1 ? "" : ","}`;
      if (line.length + tok.length > 100) { out.push(line); line = "   "; }
      line += tok;
    }
    if (line.trim() !== "") out.push(line);
    out.push(`  ]${comma}`);
  });
  out.push("};");
  return out.join("\n");
}

function emitTypeDetails(details) {
  const out = ["export const TYPE_DETAILS = {"];
  const names = Object.keys(details);
  names.forEach((name, idx) => {
    const d = details[name];
    out.push(`  ${q(name)}: {`);
    out.push(`    "kind": ${q(d.kind)},`);
    out.push(`    "arrayOf": ${q(d.arrayOf)},`);
    out.push(`    "itemElement": ${q(d.itemElement)},`);
    if (d.fields.length === 0) {
      out.push(`    "fields": []`);
    } else {
      out.push(`    "fields": [`);
      d.fields.forEach((f, i) => {
        out.push(emitArg(f, "      ") + (i === d.fields.length - 1 ? "" : ","));
      });
      out.push(`    ]`);
    }
    out.push(`  }${idx === names.length - 1 ? "" : ","}`);
  });
  out.push("};");
  return out.join("\n");
}

function emitEnums(enums) {
  const out = ["export const ENUMS = {"];
  const names = Object.keys(enums);
  names.forEach((name, idx) => {
    const e = enums[name];
    out.push(`  ${q(name)}: { "base": ${q(e.base)}, "values": [${e.values.map(q).join(", ")}] }${idx === names.length - 1 ? "" : ","}`);
  });
  out.push("};");
  return out.join("\n");
}

function render(model, meta) {
  const opCount = Object.keys(model.OPERATIONS).length;
  const typeCount = Object.keys(model.TYPES).length;
  const allArgs = Object.values(model.OPERATIONS).flatMap((o) => o.args);
  const argCount = allArgs.length;
  const nillableCount = allArgs.filter((a) => a.nillable).length;
  const nillableOps = Object.values(model.OPERATIONS).filter((o) => o.args.some((a) => a.nillable)).length;
  // ARGUMENT SHAPE, not the name. A suffix match on "_SetFields" found four of the six
  // operations that change a session's field set: it missed Order_SetOrderLineFields and
  // Product_SetVariantFields, both of which the live probe actually called
  // (scripts/probe-dandomain.mjs:880/943 and :1634; gaps.json sections.variants
  // .setVariantFieldsOk === true). Under R4 a client must re-assert EVERY field set after a
  // fault or reconnect, so a list that is short by two means the OrderLine and ProductVariant
  // field sets silently fall back to Id-only after any AUTH replay — the exact silent-shrink
  // failure R4 describes. The shape below is what all six actually share.
  const fieldSetOps = Object.keys(model.OPERATIONS).filter((n) => {
    const args = model.OPERATIONS[n].args;
    return args.length === 1 && args[0].name === "Fields" && args[0].type === "xsd:string";
  });
  // F2 policy, not WSDL data — see the comment emitted with it below. Verified against
  // the WSDL so a renamed operation turns the ban into a build failure, not a silent hole.
  const forbiddenOps = ["Solution_SetEncoding"];
  for (const n of forbiddenOps) {
    if (!Object.prototype.hasOwnProperty.call(model.OPERATIONS, n)) {
      throw new Error(`FORBIDDEN_OPERATIONS lists ${n}, which this WSDL does not declare — the F2 ban is stale`);
    }
  }
  for (const n of fieldSetOps) {
    const args = model.OPERATIONS[n].args;
    if (args.length !== 1 || args[0].type !== "xsd:string") {
      throw new Error(`${n} does not take a single xsd:string argument — check the R4 assumption`);
    }
  }
  // Every operation the WSDL NAMES *_SetFields must be caught by the shape rule too. If the
  // vendor ever adds a *_SetFields that takes something else, this fails the build instead of
  // quietly dropping it out of the R4 re-assert list.
  for (const n of Object.keys(model.OPERATIONS)) {
    if (n.endsWith("_SetFields") && !fieldSetOps.includes(n)) {
      throw new Error(`${n} is named *_SetFields but does not take a single xsd:string "Fields" argument`);
    }
  }
  // R4 — which complexType each field set validates against. This is NOT a name inference:
  // the WSDL states it in the operation's own <documentation> ("Sets the outputformat for all
  // methods returning ProductVariant Objects"), which is why Product_SetVariantFields resolves
  // to ProductVariant and not to Product. Parsed, then hard-checked against TYPES below, so a
  // reworded or removed documentation string fails the build rather than leaving callers to
  // guess a type name that validateFields() would then green-light against the wrong list.
  const setFieldsType = {};
  for (const n of fieldSetOps) {
    const doc = model.OPERATIONS[n].documentation ?? "";
    const m = doc.match(/returning (\w+) Objects/);
    if (!m) {
      throw new Error(`${n} documentation does not say which type it formats ("returning X Objects"): ${JSON.stringify(doc)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(model.TYPES, m[1])) {
      throw new Error(`${n} documentation names type ${m[1]}, which is not a complexType in this WSDL`);
    }
    setFieldsType[n] = m[1];
  }
  const header = `// src/dandomain/operations.js — PINNED DanDomain (Hostedshop) SOAP operation surface.
//
// !!! GENERATED FILE — DO NOT EDIT BY HAND. !!!
// Regenerate with:  node scripts/gen-operations.mjs
// Source WSDL:      ${meta.wsdlRel}
// WSDL sha256:      ${meta.sha256}
// WSDL bytes:       ${meta.bytes}
// Generator:        ${meta.generatorRel}
// No timestamp is emitted on purpose: the same WSDL must produce a byte-identical file,
// so any diff here is a real API change (or a hand edit, which is a bug).
//
// WHY THIS FILE EXISTS
//
// R17/R27 — Unknown ARGUMENT names are silently dropped by the server. They do not fault
//   as NOSUCHPARAM; the call arrives with fewer arguments and PHP answers
//   "Too few arguments to function WebService::X(), 0 passed ... exactly 2 expected".
//   That is a NAME error, not a transient, and it has already broken three operations
//   that were called with hand-guessed argument names. OPERATIONS[op].args is the
//   transcribed truth: names, order, xsd type and nillable. validateArgs() is the
//   pre-flight check.
//
//   WHAT "required" IS NOT. Every one of the ${argCount} arguments in this WSDL omits
//   minOccurs, so \`required\` is true for all of them and carries NO information about
//   what the PHP implementation will accept. The WSDL's only per-argument optionality
//   signal is nillable="true" (${nillableCount} arguments across ${nillableOps} operations), and the
//   live probe settled one of them: data/probes/gaps.json sections.orderGetByDate records
//   Order_GetByDate called with Start+End and NO Status element at all —
//   {"label":"Status omitted","ok":true,"count":20}, plus "statusIsOptionalInPractice":true
//   and "omittingStatusReturnsEverything":true. So validateArgs() splits the two: an absent
//   NON-nillable argument goes in missingRequired[] and fails .ok; an absent NILLABLE one
//   goes in missingNillable[] as an advisory and does NOT fail .ok. Gating on .ok with the
//   old rule made the date-window order read impossible without inventing a Status — and
//   the same probe shows Status:"0" returns 19 of 20 orders (order 17, status 99, is
//   silently lost). Only Order_GetByDate/Status was probed; the other ${nillableCount - 1} nillable
//   arguments are treated the same way by inference from the WSDL, not from a live call.
//
// R4 — One invalid field name faults the whole *_SetFields call AND the session silently
//   keeps the PREVIOUS field set, so the next read succeeds with the wrong shape and no
//   error. TYPES maps every complexType to its exact field list so a field list can be
//   validated with validateFields() BEFORE it is sent. NOSUCHPARAM is fatal; never retry.
//
// F1 — ENDPOINT is read from the WSDL's <soap:address location=...>. It is never
//   hardcoded, and the WSDL uses the DEFAULT namespace (<definitions>, <operation>),
//   which is why the generator resolves namespace URIs instead of matching "wsdl:"
//   prefixes. This WSDL declares ${opCount} operations — counted in <portType> and
//   cross-checked against <binding>, which the generator requires to agree name for
//   name. The doc app's 249 is wrong (F1); this number is not typed in anywhere, it
//   is whatever the WSDL says.
//
// This module is pure data plus pure functions: no I/O, no network, no stdout, and it
// throws rather than guessing when asked about something the WSDL does not define —
// a helper that returned [] for an unknown operation would reintroduce exactly the
// silent-drop failure (R27) this file was written to stop.

export const SOURCE = {
  "wsdl": ${q(meta.wsdlRel)},
  "sha256": ${q(meta.sha256)},
  "bytes": ${meta.bytes},
  "generator": ${q(meta.generatorRel)},
  "targetNamespace": ${q(model.targetNamespace)},
  "style": ${q(model.style)},
  "transport": ${q(model.transport)}
};

// F1: the endpoint, exactly as the WSDL advertises it. Do not hardcode this elsewhere.
export const ENDPOINT = ${q(model.endpoint)};

export const OPERATION_COUNT = ${opCount};
export const TYPE_COUNT = ${typeCount};

// R4: the only operations that change a session's field set — ALL ${fieldSetOps.length} of them. Every one
// takes a single comma-separated "Fields" string, and one bad name in it faults the call
// while the session keeps its PREVIOUS field set. Selected by ARGUMENT SHAPE (one argument
// named Fields of type xsd:string), not by the "_SetFields" name suffix: the suffix misses
// Order_SetOrderLineFields and Product_SetVariantFields, both of which the live probe called
// (probe-dandomain.mjs:880/943, :1634; gaps.json sections.variants.setVariantFieldsOk).
// R4 says the client MUST re-assert EVERY field set after any fault or reconnect, so a short
// list means the OrderLine and ProductVariant formats silently fall back to Id-only after an
// AUTH replay and the next read returns a smaller record with no error.
export const FIELD_SET_OPERATIONS = [${fieldSetOps.map(q).join(", ")}];

// R4: which complexType each field set is validated against. Read from the WSDL's own
// <documentation> for the operation ("Sets the outputformat for all methods returning
// ProductVariant Objects"), NOT inferred from the operation name — that is how
// Product_SetVariantFields resolves to ProductVariant rather than Product. The generator
// fails the build if a documentation string stops naming a type, or names one that is not a
// complexType here, so this cannot rot into a wrong-but-plausible mapping. Use it to pick the
// argument for validateFields(): every one of the ${typeCount} complexTypes is a legal argument to
// that function, including the *Create/*Update inputs and the ArrayOf* wrappers, so a guessed
// type name is green-lit silently.
export const SET_FIELDS_TYPE = {
${fieldSetOps.map((n) => `  ${q(n)}: ${q(setFieldsType[n])}`).join(",\n")}
};

// F2 — the ONE thing in this file that is not transcribed from the WSDL, and it is here
// precisely because the WSDL advertises the call as if it were safe. Solution_SetEncoding
// must NEVER be called: the API is UTF-8-native, so asking it for UTF-8 makes it convert
// twice — it mojibakes reads and IRREVERSIBLY destroys writes ("Æblegrød" -> "?r? ??? ???").
// The design doc says to call it; the design doc is wrong. The generator verifies each
// name below still exists in the WSDL, so this list cannot rot into a no-op.
export const FORBIDDEN_OPERATIONS = [${forbiddenOps.map(q).join(", ")}];
`;

  const kinds = [...model.requestParticleKinds].sort();
  const orderNote = kinds.length === 1 && kinds[0] === "sequence"
    ? `//                      WSDL's own: every request wrapper that takes arguments is an
//                      <xsd:sequence>, so the order is part of the schema. A name that is
//                      not in this list is dropped in flight and comes back as an arity
//                      error (R17/R27).`
    : `//                      WSDL's own document order (request particles seen: ${kinds.join(", ")}).
//                      A name that is not in this list is dropped in flight and comes back
//                      as an arity error (R17/R27).`;
  const opsDoc = `
// Every operation the WSDL declares, in WSDL document order.
//   args             — argument names IN ORDER, with xsd type, nillable and required
//                      (required === minOccurs is absent or > 0). The order is the
${orderNote}
//   responseElement  — name of the response wrapper element
//   resultElement    — name of the single child holding the result (null for void)
//   resultType       — xsd builtin ("xsd:boolean") or schema type ("tns:ArrayOfOrder")
//   resultItemType   — for array results, the type of the repeated child (structurally
//                      detected from the wrapper's particle, not from its name)
`;

  const typesDoc = `
// R4: complexType -> exact field list. Validate every *_SetFields list against this
// BEFORE sending; one bad name faults the call and leaves the session on its previous
// field set, which then reads a smaller record with no error at all.
`;

  const detailsDoc = `
// The same types with their field types, for callers that need more than the names
// (e.g. deciding whether a field is a nested record or an array wrapper).
//   kind       — "all" | "sequence" | "empty"
//   arrayOf    — item type when this type is an array wrapper, else null
//   itemElement— name of the repeated child element ("item"), else null
`;

  const enumsDoc = `
// xsd:simpleType restrictions (enumerations) referenced by the operations above.
`;

  const helpers = `
function own(obj, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
}

/** True when the WSDL declares this operation. Use it instead of catching. */
export function hasOperation(op) {
  return own(OPERATIONS, op);
}

/** True when the WSDL declares this complexType. */
export function hasType(typeName) {
  return own(TYPES, typeName);
}

/** The operation's spec. Throws on an unknown name (R27: never guess). */
export function operationFor(op) {
  if (!own(OPERATIONS, op)) {
    throw new Error(\`Unknown DanDomain operation "\${op}" — not in the WSDL (\${OPERATION_COUNT} operations)\`);
  }
  return OPERATIONS[op];
}

/**
 * Argument names, in the order the WSDL declares them.
 * R17/R27: callers must build their request from this, not from memory of the docs.
 */
export function argNamesFor(op) {
  return operationFor(op).args.map((a) => a.name);
}

/** The declared field names of a complexType. Throws on an unknown type (R4). */
export function fieldsFor(typeName) {
  if (!own(TYPES, typeName)) {
    throw new Error(\`Unknown DanDomain type "\${typeName}" — not in the WSDL\`);
  }
  return TYPES[typeName];
}

/**
 * Pre-flight an argument object against the WSDL (R17/R27).
 *
 * unknown[]         — names the server would SILENTLY DROP, which then surfaces as a PHP
 *                     arity error ("Too few arguments to function WebService::X()"). This is
 *                     the half backed by three real breakages, and the half that fails .ok.
 * missingRequired[] — declared, NON-nillable arguments that are absent.
 * missingNillable[] — declared, nillable arguments that are absent. ADVISORY ONLY; it does
 *                     not fail .ok. minOccurs is absent on all ${argCount} arguments in this
 *                     WSDL, so "declared" is not the same as "PHP requires it", and
 *                     data/probes/gaps.json sections.orderGetByDate proves the difference:
 *                     Order_GetByDate sent with Start+End and no Status element at all came
 *                     back ok with all 20 orders ("statusIsOptionalInPractice": true). Only
 *                     that one argument was probed live; the rest are grouped with it because
 *                     nillable="true" is the WSDL's only optionality signal.
 *
 * CALLER CONTRACT — this function's undefined/null rule is a REQUIREMENT ON THE SERIALISER,
 * not an observation about one. A key whose value is \`undefined\` is treated as ABSENT, so the
 * serialiser must DROP such keys instead of emitting an empty element for them; \`null\` is
 * treated as PRESENT, so the serialiser must emit the element. The probe's serialiser
 * (scripts/probe-dandomain.mjs:58) does not honour the first half — it walks Object.entries
 * and maps both null and undefined to "", emitting <Status></Status> either way. Against that
 * serialiser this function's missing* lists are conservative rather than wrong (an empty
 * element behaves like omission for Order_GetByDate — gaps.json "Status empty string": ok,
 * count 20), but unknown[] is the only half that is exactly right. Nothing here emits XML and
 * no xsi:nil was ever observed on the wire; use orderedArgs() to build the element list so the
 * contract lives in one place.
 */
export function validateArgs(op, argsObject) {
  const spec = operationFor(op);
  const provided = new Set();
  if (argsObject !== null && argsObject !== undefined) {
    if (typeof argsObject !== "object") {
      throw new TypeError(\`validateArgs("\${op}", ...) expects an object of arguments\`);
    }
    for (const key of Object.keys(argsObject)) {
      if (argsObject[key] !== undefined) provided.add(key);
    }
  }
  const declared = new Set(spec.args.map((a) => a.name));
  const unknown = [...provided].filter((name) => !declared.has(name));
  const absent = spec.args.filter((a) => !provided.has(a.name));
  const missingRequired = absent.filter((a) => !a.nillable).map((a) => a.name);
  const missingNillable = absent.filter((a) => a.nillable).map((a) => a.name);
  return {
    ok: unknown.length === 0 && missingRequired.length === 0,
    unknown,
    missingRequired,
    missingNillable,
  };
}

/**
 * The elements a request body must contain, IN WSDL ORDER, for the given arguments (R17).
 *
 * This exists so the undefined/null contract validateArgs() assumes is enforceable in one
 * testable place instead of being restated in every serialiser: keys whose value is
 * \`undefined\` are dropped (the server must not see the element), \`null\` is kept (the element
 * is sent). Unknown names are NOT silently discarded — they are returned in \`unknown\` so the
 * caller cannot ship a request that the server will quietly shorten into an arity error.
 * Order matters: every request wrapper in this WSDL is an <xsd:sequence>.
 */
export function orderedArgs(op, argsObject) {
  const spec = operationFor(op);
  const source = argsObject == null ? {} : argsObject;
  if (typeof source !== "object") {
    throw new TypeError(\`orderedArgs("\${op}", ...) expects an object of arguments\`);
  }
  const elements = [];
  for (const a of spec.args) {
    if (!Object.prototype.hasOwnProperty.call(source, a.name)) continue;
    const value = source[a.name];
    if (value === undefined) continue;
    elements.push({ name: a.name, type: a.type, nillable: a.nillable, value });
  }
  const declared = new Set(spec.args.map((a) => a.name));
  const unknown = Object.keys(source).filter((k) => source[k] !== undefined && !declared.has(k));
  return { elements, unknown };
}

/**
 * Pre-flight a *_SetFields list against a complexType (R4).
 * Accepts the comma-separated string the API itself takes, or an array of names.
 * An empty token (from "Id,,Files" or a trailing comma) is reported as invalid: it is not a
 * field name, so this refuses locally. Whether the server tolerates an empty token was never
 * probed — no probe in data/probes/ ever sent a doubled or trailing comma — so this is a
 * fail-safe local choice, not a transcribed API fact.
 *
 * The type name is the CALLER's: use SET_FIELDS_TYPE[op] to get the one the WSDL's own
 * documentation binds to that operation. All ${typeCount} complexTypes are legal arguments
 * here, including the *Create/*Update inputs and the ArrayOf* wrappers, so a wrong-but-real
 * type name returns ok:true.
 */
export function validateFields(typeName, fieldList) {
  const known = new Set(fieldsFor(typeName));
  let names;
  if (typeof fieldList === "string") {
    names = fieldList.split(",").map((f) => f.trim());
  } else if (Array.isArray(fieldList)) {
    names = fieldList.map((f) => (typeof f === "string" ? f.trim() : f));
  } else {
    throw new TypeError(\`validateFields("\${typeName}", ...) expects a comma-separated string or an array\`);
  }
  const invalid = names.filter((f) => typeof f !== "string" || !known.has(f));
  return { ok: invalid.length === 0, invalid };
}

/** All operation names, in WSDL document order. */
export function operationNames() {
  return Object.keys(OPERATIONS);
}

// The surface is PINNED: freezing makes an accidental runtime mutation throw in strict
// mode (ESM is always strict) instead of quietly corrupting every later call. Pure
// in-module work — no I/O, no globals touched.
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}
deepFreeze(OPERATIONS);
deepFreeze(TYPES);
deepFreeze(TYPE_DETAILS);
deepFreeze(ENUMS);
deepFreeze(SOURCE);
deepFreeze(FIELD_SET_OPERATIONS);
deepFreeze(SET_FIELDS_TYPE);
deepFreeze(FORBIDDEN_OPERATIONS);
`;

  return [
    header,
    opsDoc + emitOperations(model.OPERATIONS),
    typesDoc + emitTypes(model.TYPES),
    detailsDoc + emitTypeDetails(model.TYPE_DETAILS),
    enumsDoc + emitEnums(model.ENUMS),
    helpers,
  ].join("\n") + "";
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const wsdlPath = process.argv[2] || fileURLToPath(new URL("../data/probes/service.wsdl", import.meta.url));
const outPath = process.argv[3] || fileURLToPath(new URL("../src/dandomain/operations.js", import.meta.url));
const rel = (p) => {
  const sliced = p.startsWith(repoRoot) ? p.slice(repoRoot.length) : p;
  return sliced.replaceAll("\\", "/");
};

const bytes = readFileSync(wsdlPath);
const model = build(bytes.toString("utf8"));
const text = render(model, {
  wsdlRel: rel(wsdlPath),
  generatorRel: rel(fileURLToPath(import.meta.url)),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});
writeFileSync(outPath, text, "utf8");

process.stdout.write(
  `gen-operations: ${Object.keys(model.OPERATIONS).length} operations, ` +
  `${Object.keys(model.TYPES).length} types, ${Object.keys(model.ENUMS).length} enums\n` +
  `gen-operations: endpoint ${model.endpoint}\n` +
  `gen-operations: wrote ${rel(outPath)} (${Buffer.byteLength(text, "utf8")} bytes)\n`
);
