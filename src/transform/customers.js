/**
 * WooCommerce customer -> Shopify customerSet input (upsert by email).
 * customerSet with an email identifier is idempotent: re-runs update instead
 * of duplicating. Passwords can never be migrated (hashed differently);
 * customers activate their account on the new store (see PLAYBOOK).
 *
 * DanDomain CVR/EAN ride as `_metafields` on the transformed line — applied via
 * metafieldsSet after customerSet (CustomerSetInput has no metafields field).
 */
import { customerMetafieldsFromMeta } from "./dd-metafields.js";

const addr = (a, fallbackName) => {
  if (!a || (!a.address_1 && !a.city && !a.postcode)) return null;
  return {
    firstName: a.first_name || fallbackName?.first || undefined,
    lastName: a.last_name || fallbackName?.last || undefined,
    company: a.company || undefined,
    address1: a.address_1 || undefined,
    address2: a.address_2 || undefined,
    city: a.city || undefined,
    zip: a.postcode || undefined,
    provinceCode: a.state || undefined,
    countryCode: a.country || undefined,
    phone: a.phone || undefined
  };
};

export function transformCustomer(c, ctx) {
  const warnings = [];
  const L = ctx?.L;
  if (!c.email) {
    warnings.push({ entity: "customer", id: c.id, code: "NO_EMAIL", severity: "info", message: `Customer ${c.id} has no email — skipped (a Shopify customer without email can't log in or be reached; nothing to do).` });
    return { line: null, warnings };
  }
  const billing = addr(c.billing, { first: c.first_name, last: c.last_name });
  const shipping = addr(c.shipping, { first: c.first_name, last: c.last_name });
  const addresses = [];
  if (billing) addresses.push(billing);
  if (shipping && JSON.stringify(shipping) !== JSON.stringify(billing)) addresses.push(shipping);

  const metafields = customerMetafieldsFromMeta(c.meta_data);
  if (metafields.some((m) => m.key === "ean")) {
    warnings.push({
      entity: "customer",
      id: c.id,
      code: "EAN_INVOICING",
      severity: "handled",
      message: `Customer ${c.id} carries a Danish public-sector EAN — landed as customer metafield dandomain.ean. Rebuild any e-invoicing workflow (app or manual); Shopify has no native EAN-invoice field.`,
    });
  }

  const input = {
    firstName: c.first_name || c.billing?.first_name || undefined,
    lastName: c.last_name || c.billing?.last_name || undefined,
    email: c.email,
    phone: undefined, // Woo phone strings are rarely E.164; invalid values reject the whole row. Kept on address instead.
    note: L ? L.customerNote(c.id) : `Imported from WordPress (user ${c.id})`,
    tags: ["wp-import"],
    ...(addresses.length ? { addresses } : {})
  };
  // Marketing consent is NOT set: WooCommerce core doesn't record provable
  // opt-in. Export lists from the actual ESP (Mailchimp/Klaviyo) instead.
  const line = { input, identifier: { email: c.email } };
  if (metafields.length) line._metafields = metafields;
  return { line, warnings, email: c.email, wooId: c.id };
}
