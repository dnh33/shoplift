import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  storefrontOrigin,
  isAdminHost,
  productPath,
  categoryPath,
  containsItemNumber,
} from "../src/dandomain/urls.js";

/**
 * R41 grammar + R39 containment, offline. A 200 is not evidence; the admin
 * host is not the storefront. These functions have no network.
 */

describe("DanDomain URL grammar (R41)", () => {
  test("products compose on the storefront host, never the admin host", () => {
    assert.equal(
      productPath({ catId: 9, catSlug: "probe-kategori", prodId: 625, prodSlug: "probe-storefront-msvspfjo" }),
      "/shop/9-probe-kategori/625-probe-storefront-msvspfjo",
    );
    assert.equal(categoryPath({ catId: 9, catSlug: "probe-kategori" }), "/shop/9-probe-kategori");
  });

  test("an admin host is rewritten to {tenant}.mywebshop.io (R39)", () => {
    assert.equal(isAdminHost("shop000000.webshop.dandomain.dk"), true);
    assert.equal(isAdminHost("shop000000.mywebshop.io"), false);
    assert.equal(
      storefrontOrigin("https://shop000000.webshop.dandomain.dk"),
      "https://shop000000.mywebshop.io",
    );
    assert.equal(
      storefrontOrigin("https://shop000000.mywebshop.io/"),
      "https://shop000000.mywebshop.io",
    );
  });

  test("a missing product slug refuses to invent a storefront path (D9)", () => {
    assert.equal(
      productPath({ catId: 1, catSlug: "demo-kategori", prodId: 2, prodSlug: null }),
      null,
    );
    assert.equal(productPath({ catId: 1, catSlug: "demo-kategori", prodId: 2, prodSlug: "" }), null);
  });
});

describe("R39 containment — a 200 is not a product page", () => {
  test("the admin SPA shell does not count even though it is 200", () => {
    // Recorded p2.json publicPrice: 7460-byte JS shell for every /heimdal path.
    const adminShell = `<!doctype html><html><script>/* heimdal spa ${"x".repeat(7400)} */</script></html>`;
    assert.equal(containsItemNumber(adminShell, "PROBE-VS-25"), false);
  });

  test("the page must CONTAIN the product's item number", () => {
    const html = `<html><body><h1>Probe</h1><span class="sku">PROBE-VS-25</span></body></html>`;
    assert.equal(containsItemNumber(html, "PROBE-VS-25"), true);
    assert.equal(containsItemNumber(html, "GONE-1"), false);
  });

  test("a needle that is a substring of the probe's own slug is not a hit", () => {
    // p2c nearly shipped GUEST from timestamp 1786884111771 containing 1117.
    const html = `<html>/shop/9-x/625-probe-1786884111771/</html>`;
    assert.equal(containsItemNumber(html, "1117"), false, "digit-only needles shorter than 5 are refused");
  });
});
