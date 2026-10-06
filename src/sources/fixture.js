import path from "node:path";
import { readJson } from "../util/fsx.js";
import { PKG_ROOT } from "../paths.js";

/**
 * Fixture adapter — reads WooCommerce-shaped JSON from ./fixtures.
 * Used by `npm test` for a full offline export -> transform run,
 * and handy as a dry-run smoke test on machines without store access.
 */
export function createFixtureAdapter(cfg, fixtureDir = path.join(PKG_ROOT, "fixtures")) {
  const load = (name) => readJson(path.join(fixtureDir, `${name}.json`), []);
  const gen = (name) => async function* () { yield* load(name); };
  return {
    name: "fixture",
    products: gen("woo-products"),
    categories: gen("woo-categories"),
    customers: gen("woo-customers"),
    orders: gen("woo-orders"),
    coupons: gen("woo-coupons"),
    reviews: gen("woo-reviews"),
    posts: gen("wp-posts"),
    pages: gen("wp-pages"),
    async settings() { return { currency: "DKK", weightUnit: "kg" }; }
  };
}
