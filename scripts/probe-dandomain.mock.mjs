#!/usr/bin/env node
// Mock Hostedshop SOAP server — offline test double for probe-dandomain.mjs and (later)
// src/dandomain/client.js. Speaks just enough canned SOAP 1.2 to exercise every probe:
// cookie-session enforcement (AUTH fault without the cookie), PARAM fault matrix on
// Order_Create, page-size fault at Length>500, wrapped results with <item> arrays.
// Usage: node scripts/probe-dandomain.mock.mjs [port]   (default 8722)
import { createServer } from "node:http";
const PORT = Number(process.argv[2] ?? 8722);
const env = (inner) => `<?xml version="1.0"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>${inner}</env:Body></env:Envelope>`;
const result = (op, inner) => env(`<ns1:${op}Response xmlns:ns1="mock"><ns1:${op}Result>${inner}</ns1:${op}Result></ns1:${op}Response>`);
const fault = (code, msg) => env(`<env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>${code}</env:Value></env:Subcode></env:Code><env:Reason><env:Text xml:lang="en">${msg}</env:Text></env:Reason></env:Fault>`);
const items = (arr) => arr.map((o) => `<item>${Object.entries(o).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</item>`).join("");

let ENCMODE = "none";
let LAST_TITLE = "";
const VATG = [{ Id: 1, Name: "0 %", VatPercentage: 0 }];
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const op = body.match(/<m:(\w+)/)?.[1] ?? "?";
    const send = (xml, extra = {}) => { res.writeHead(200, { "content-type": "application/soap+xml; charset=utf-8", ...extra }); res.end(xml); };
    const authed = /PHPSESSID=mock/.test(req.headers.cookie ?? "");
    if (op === "Solution_Connect") {
      if (!/<Username>u<\/Username>/.test(body)) return send(fault("AUTH", "A valid authentication has not been performed with the service"));
      ENCMODE = "none"; return send(result(op, ""), { "set-cookie": "PHPSESSID=mock; path=/" });
    }
    if (!authed) return send(fault("AUTH", "A valid authentication has not been performed with the service"));
    switch (op) {
      case "Solution_SetEncoding": { ENCMODE = body.match(/<Encoding>([^<]*)</)?.[1] ?? "none"; return send(result(op, "1")); }
      case "Solution_SetLanguage":
      case "Product_SetFields": case "Order_SetFields": return send(result(op, "1"));
      case "Solution_GetWebinfo": return send(result(op, "<ShopName>Mock demo shop000000</ShopName><Version>mock-1</Version>"));
      case "Solution_GetLanguages": return send(result(op, items([{ Id: 1, Iso: "DK", Title: "Dansk" }, { Id: 2, Iso: "UK", Title: "English" }])));
      case "Sites_GetAll": return send(result(op, items([{ Id: 1, Title: "Main", LanguageIso: "DK" }])));
      case "OrderStatusCode_GetAll": return send(result(op, items([{ Id: 1, Title: "Ordre modtaget" }, { Id: 4, Title: ENCMODE === "none" ? "Genåbnet" : "GenÃ¥bnet" }])));
      case "Currency_GetAll": return send(result(op, items([{ Id: 1, Iso: "DKK", IsDefault: "true" }])));
      case "VatGroup_GetAll": return send(result(op, items(VATG)));
      case "VatGroup_Create": { VATG.push({ Id: 2, Name: "25 % (probe)", VatPercentage: 25 }); return send(result(op, "2")); }
      case "Product_GetAllWithLimit": {
        const len = Number(body.match(/<Length>(\d+)<\/Length>/)?.[1] ?? 0);
        if (len > 500) return send(fault("INTERNAL", "An internal error in the service occured. Contact an administrator"));
        return send(result(op, items(Array.from({ length: Math.min(len, 3) }, (_, i) => ({ Id: 100 + i, ItemNumber: `MOCK-${i}` })))));
      }
      case "Product_CreateOrUpdate": {
        LAST_TITLE = body.match(/<Title>([^<]*)</)?.[1] ?? "";
        if (!/<CategoryId>/.test(body)) return send(fault("PRODUCT", "A CategoryId must be set when creating a product"));
        return send(result(op, "101"));
      }
      case "Product_GetByItemNumber": return send(result(op, items([{ Id: 101, ItemNumber: "PROBE-X", Title: LAST_TITLE, Price: 100, Status: 1, Url: "/shop/9-probe-kategori/101-probe-url-aeblegroed/", SeoLink: "probe-url-aeblegroed" }])));
      case "Category_CreateOrUpdate": return send(result(op, "9"));
      case "Category_GetAll": return send(result(op, items([{ Id: 9, Title: "Probe Kategori", Status: 1 }])));
      case "SEORedirect_GetAll": return send(result(op, items([{ Id: 1, LanguageIso: "DK", Source: "/shop/9-x/101-old/", Target: "/shop/9-x/101-new/", Type: 301 }])));
      case "Product_GetDeliveryCountryAll": return send(result(op, items([{ Id: 1, Iso: "DK", Code: "45", Primary: "true" }])));
      case "Payment_GetAll": return send(result(op, items([{ Id: 4, Title: "Bankoverførsel", Fee: 0 }])));
      case "Delivery_GetAll": return send(result(op, items([{ Id: 2, Title: "GLS pakkeshop", Price: 39 }])));
      case "Order_Create": {
        // Required per real WSDL (OrderCreate): CurrencyId, PaymentId, DeliveryId, OrderLines, OrderCustomer
        const missing = ["CurrencyId", "PaymentId", "DeliveryId", "OrderLines", "OrderCustomer"].filter((f) => !new RegExp(`<${f}>`).test(body));
        if (missing.length) return send(fault("PARAM", `Parameter error. Missing: ${missing.join(",")}`));
        return send(result(op, "5001"));
      }
      case "Order_GetById": return send(result(op, "<Id>5001</Id><ReferenceNumber>SRC-2019-0042</ReferenceNumber><Status>1</Status><Total>199</Total><Vat>39.8</Vat><CurrencyIso>DKK</CurrencyIso>"));
      case "Order_UpdateStatus": return send(result(op, "1"));
      default: return send(fault("PARAM", `mock: unhandled operation ${op}`));
    }
  });
}).listen(PORT, () => console.log(`mock hostedshop soap on http://127.0.0.1:${PORT}/ (user 'u', any password)`));
