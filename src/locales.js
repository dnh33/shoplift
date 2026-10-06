/**
 * locales.js — store-locale presets for the languages common in Danish
 * e-commerce work (da default, plus en/de/sv/no).
 *
 * What a locale controls (pipeline-GENERATED, merchant-facing artifacts):
 *  - note text written onto imported orders/customers in Shopify admin
 *  - default blog title/handle for migrated posts
 *  - structural redirects for localized WooCommerce paths (/butik, /kurv, …)
 *  - fallback weight unit when the source store doesn't report one
 *
 * What it does NOT control (facts that flow from data or Shopify admin):
 *  - order currency (always taken from each source order)
 *  - Shopify store currency/locale (set in Shopify admin when creating the
 *    store — doctor cross-checks alignment)
 *  - operator-facing warnings/logs (always English — that's us, not clients)
 */
export const LOCALES = {
  da: {
    label: "Dansk",
    weightUnit: "KILOGRAMS",
    blog: { title: "Nyheder", handle: "nyheder" },
    structural: [["/butik", "/collections/all"], ["/kurv", "/cart"], ["/kasse", "/checkout"], ["/min-konto", "/account"]],
    orderNote: (w) => `Importeret fra WordPress. Oprindelig ordre ${w.number} (id ${w.id}), status "${w.status}".`,
    couponNote: (codes, total, cur) => `Rabatkoder: ${codes} (rabat ${total} ${cur})`,
    refundNote: (amt, cur) => `Delvis refusion i WooCommerce: ${amt} ${cur} — ikke genskabt her; ordren er importeret til fuld værdi.`,
    customerNoteLabel: "Kundenote",
    customerNote: (id) => `Importeret fra WordPress (bruger ${id})`
  },
  en: {
    label: "English",
    weightUnit: "KILOGRAMS",
    blog: { title: "News", handle: "news" },
    structural: [],
    orderNote: (w) => `Imported from WordPress. Original order ${w.number} (id ${w.id}), status "${w.status}".`,
    couponNote: (codes, total, cur) => `Coupons: ${codes} (discount ${total} ${cur})`,
    refundNote: (amt, cur) => `Partial refund in WooCommerce: ${amt} ${cur} — not recreated here; order imported at full value.`,
    customerNoteLabel: "Customer note",
    customerNote: (id) => `Imported from WordPress (user ${id})`
  },
  de: {
    label: "Deutsch",
    weightUnit: "KILOGRAMS",
    blog: { title: "Neuigkeiten", handle: "neuigkeiten" },
    structural: [["/warenkorb", "/cart"], ["/kasse", "/checkout"], ["/mein-konto", "/account"]],
    orderNote: (w) => `Importiert aus WordPress. Ursprüngliche Bestellung ${w.number} (ID ${w.id}), Status "${w.status}".`,
    couponNote: (codes, total, cur) => `Gutscheine: ${codes} (Rabatt ${total} ${cur})`,
    refundNote: (amt, cur) => `Teilerstattung in WooCommerce: ${amt} ${cur} — hier nicht neu angelegt; Bestellung zum vollen Wert importiert.`,
    customerNoteLabel: "Kundennotiz",
    customerNote: (id) => `Importiert aus WordPress (Benutzer ${id})`
  },
  sv: {
    label: "Svenska",
    weightUnit: "KILOGRAMS",
    blog: { title: "Nyheter", handle: "nyheter" },
    structural: [["/varukorg", "/cart"], ["/kassa", "/checkout"], ["/mitt-konto", "/account"]],
    orderNote: (w) => `Importerad från WordPress. Ursprunglig order ${w.number} (id ${w.id}), status "${w.status}".`,
    couponNote: (codes, total, cur) => `Rabattkoder: ${codes} (rabatt ${total} ${cur})`,
    refundNote: (amt, cur) => `Delåterbetalning i WooCommerce: ${amt} ${cur} — inte återskapad här; ordern importerad till fullt värde.`,
    customerNoteLabel: "Kundnotering",
    customerNote: (id) => `Importerad från WordPress (användare ${id})`
  },
  no: {
    label: "Norsk",
    weightUnit: "KILOGRAMS",
    blog: { title: "Nyheter", handle: "nyheter" },
    structural: [["/handlekurv", "/cart"], ["/kasse", "/checkout"], ["/min-konto", "/account"], ["/butikk", "/collections/all"]],
    orderNote: (w) => `Importert fra WordPress. Opprinnelig ordre ${w.number} (id ${w.id}), status "${w.status}".`,
    couponNote: (codes, total, cur) => `Rabattkoder: ${codes} (rabatt ${total} ${cur})`,
    refundNote: (amt, cur) => `Delvis refusjon i WooCommerce: ${amt} ${cur} — ikke gjenskapt her; ordren er importert til full verdi.`,
    customerNoteLabel: "Kundenotat",
    customerNote: (id) => `Importert fra WordPress (bruker ${id})`
  }
};

export const localeOf = (cfg) => {
  const L = LOCALES[cfg?.options?.locale] || LOCALES.da;
  const src = cfg?.source?.adapter || cfg?.source?.kind;
  if (src !== "dandomain") return L;
  return {
    ...L,
    orderNote: (w) => L.orderNote(w).replaceAll("WordPress", "DanDomain"),
    customerNote: (id) => L.customerNote(id).replaceAll("WordPress", "DanDomain"),
  };
};
