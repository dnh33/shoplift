/**
 * WooCommerce order -> Shopify orderCreate input (GraphQL Admin API).
 *
 * Facts this mapping is built on (July 2026):
 *  - orderCreate exists for importing orders from external systems; requires
 *    an app with an offline token and write_orders scope.
 *  - transactions[].processedAt may be backdated; kind SALE / status SUCCESS
 *    marks the order paid at the historical date.
 *  - fulfillmentStatus: FULFILLED marks the whole order fulfilled on create.
 *  - only ONE discount code can be attached per order — multi-coupon Woo
 *    orders keep total-level accuracy via price already-discounted lines +
 *    a note, and get flagged in warnings.
 *  - options { inventoryBehaviour: BYPASS, sendReceipt/sendFulfillmentReceipt:
 *    false } prevent stock changes and customer emails during import.
 */
import { truncateTitle, TITLE_MAX } from "./html.js";

const money = (amount, currencyCode) => ({ shopMoney: { amount: String(Number(amount || 0).toFixed(2)), currencyCode } });

/**
 * Shopify orderCreate (Admin GraphQL 2026-01): lineItems.priceSet and
 * shippingLines.priceSet are TAX-EXCLUSIVE (NET). taxLines[].priceSet is
 * additional tax. Shopify adds them. The SALE transaction is GROSS.
 * Documented example: 74.99 × 3 + 13.50 tax = 238.47 transaction.
 * Sending a GROSS shipping priceSet AND taxLines double-counts VAT.
 * Woo shipping_lines.total is already net; DanDomain emits net + taxes[].
 */
const mapTaxLines = (taxes, order, currency, parentNet) => (taxes || []).filter((t) => Number(t.total)).map((t) => {
  const tl = (order.tax_lines || []).find((x) => x.rate_id === t.id);
  let rate = Number(tl?.rate_percent || 0) / 100;
  if (!tl && Number(parentNet) > 0) rate = Number(t.total) / Number(parentNet);
  return {
    title: tl?.label || "Tax",
    priceSet: money(t.total, currency),
    rate
  };
});

const WP_PROVENANCE = { productIdTag: "wp-id-", orderTag: "wc-order-", statusTag: "wc-status-", orderNamePrefix: "#WP" };

const FINANCIAL_FROM_STATUS = { refunded: "REFUNDED", cancelled: "VOIDED", failed: "PENDING", pending: "PENDING", "on-hold": "PENDING" };

const mapAddr = (a) => (!a || (!a.address_1 && !a.city) ? undefined : {
  firstName: a.first_name || undefined, lastName: a.last_name || undefined, company: a.company || undefined,
  address1: a.address_1 || undefined, address2: a.address_2 || undefined, city: a.city || undefined,
  zip: a.postcode || undefined, provinceCode: a.state || undefined, countryCode: a.country || undefined, phone: a.phone || undefined
});

export function transformOrder(w, ctx) {
  const warnings = [];
  const o = ctx.cfg.options.orders;
  const L = ctx.L;
  if (w.status === "cancelled" && !o.importCancelled) return { order: null, warnings };

  const currency = w.currency || "USD";
  const processedAt = (w.date_paid_gmt || w.date_created_gmt || w.date_created || new Date().toISOString()).replace(/(?<!Z)$/, "Z");
  const paid = Boolean(w.date_paid_gmt || w.date_paid) || ["completed", "processing", "refunded"].includes(w.status);
  if (paid && !(Number(w.total) > 0)) {
    warnings.push({ entity: "order", id: w.id, code: "ZERO_TOTAL_PAID", severity: "info", message: `Order ${w.number} is marked paid with a total of ${w.total} — Shopify rejects a zero-value SALE transaction, so the order imports with no transaction attached. Expected for 100% discounts, free samples and comped orders; check it is not a data error.` });
  }
  const longTitles = (w.line_items || []).filter((li) => String(li.name || "").length > TITLE_MAX).length;
  if (longTitles) {
    warnings.push({ entity: "order", id: w.id, code: "TITLE_TRUNCATED", severity: "handled", message: `Order ${w.number}: ${longTitles} line item title(s) exceeded Shopify's ${TITLE_MAX}-character limit and were truncated — the order imports, but the line text differs from the source.` });
  }

  // Woo stores a line TOTAL; Shopify wants a UNIT price. Reconstructing it means
  // dividing, and the quotient has to round to 2 decimals — so qty x unit no
  // longer equals the line total the shop actually charged. One cent per line is
  // invisible; an order with 32 lines accumulates a visible discrepancy against
  // the source, and Shopify computes the order total from the lines. Measure the
  // drift we are about to introduce so it is declared rather than discovered
  // during a bookkeeping reconciliation (live real-xl, order #WP1489: +0.01).
  let exactLineTotal = 0, roundedLineTotal = 0;

  const lineItems = (w.line_items || []).map((li) => {
    const qty = Math.max(1, Number(li.quantity || 1));
    // Woo line "total" is post-discount; subtotal is pre-discount. Using
    // subtotal/qty as unit price keeps Shopify's math consistent with the
    // order-level discount note below.
    const lineTotal = Number(li.subtotal ?? li.total ?? 0);
    const unit = lineTotal / qty;
    exactLineTotal += lineTotal;
    roundedLineTotal += Number(unit.toFixed(2)) * qty;
    return {
      title: truncateTitle(li.name || "Item"),
      quantity: qty,
      sku: (li.sku || "").trim() || undefined,
      priceSet: money(unit, currency),
      requiresShipping: true,
      taxLines: mapTaxLines(li.taxes, w, currency, li.subtotal ?? li.total),
      _sku: (li.sku || "").trim() || null, _variationId: li.variation_id, _productId: li.product_id
    };
  });

  const lineDrift = roundedLineTotal - exactLineTotal;
  if (Math.abs(lineDrift) >= 0.005) {
    warnings.push({ entity: "order", id: w.id, code: "ORDER_TOTAL_DRIFT", severity: "handled", message: `Order ${w.number}: reconstructing per-unit prices from ${(w.line_items || []).length} line totals rounds to ${lineDrift > 0 ? "+" : ""}${lineDrift.toFixed(2)} ${currency} against the source total (${w.total}). The order imports; expect a ${Math.abs(lineDrift).toFixed(2)} difference when reconciling this order against Woo.` });
  }

  // Woo fee lines (gift wrap, payment fees, ...) become custom line items so
  // order totals still reconcile in Shopify.
  for (const fee of w.fee_lines || []) {
    const total = Number(fee.total || 0);
    if (total > 0) {
      lineItems.push({ title: truncateTitle(fee.name || "Fee"), quantity: 1, priceSet: money(total, currency), requiresShipping: false, taxLines: mapTaxLines(fee.taxes, w, currency, fee.total) });
    } else if (total < 0) {
      warnings.push({ entity: "order", id: w.id, code: "NEGATIVE_FEE", severity: "action", message: `Order ${w.number}: negative fee "${fee.name}" (${fee.total}) can't become a line item — total preserved via transaction, but line math won't add up. Review in Shopify.` });
    }
  }

  if (!lineItems.length) {
    warnings.push({ entity: "order", id: w.id, code: "ORDER_EMPTY_UNLANDABLE", severity: "handled", message: `Order ${w.number}: no line items — Shopify orderCreate requires at least one. Import skips this order; lines are not fabricated.` });
  }

  // partial refunds: Woo lists them on the order as refunds[] (negative totals)
  // while the status stays completed/processing. Shopify refund objects can't be
  // backdated/recreated, so the order imports at FULL value — the note + info
  // warning keep the money trail honest for bookkeeping.
  const partialRefunds = (w.refunds || []).filter((r) => Number(r.total || 0) !== 0);
  const refundedTotal = partialRefunds.reduce((s, r) => s + Math.abs(Number(r.total || 0)), 0);
  if (partialRefunds.length && w.status !== "refunded") {
    warnings.push({ entity: "order", id: w.id, code: "REFUND_PARTIAL", severity: "info", message: `Order ${w.number}: ${partialRefunds.length} partial refund(s) totaling ${refundedTotal.toFixed(2)} ${w.currency || ""} — imported at full value with a note; the refund itself is not recreated (platform fact).` });
  }

  // multi-currency plugins leave orders in non-store currencies. The currency
  // rides along verbatim; whether orderCreate ACCEPTS it is store-dependent —
  // see PLAYBOOK for the probe outcome.
  if (ctx.storeCurrency && w.currency && w.currency !== ctx.storeCurrency) {
    warnings.push({ entity: "order", id: w.id, code: "CURRENCY_MISMATCH", severity: "info", message: `Order ${w.number} is in ${w.currency} but the store currency is ${ctx.storeCurrency} — orderCreate may reject or re-denominate it. If it fails, decide: import in store currency (converted) or skip historical foreign-currency orders.` });
  }

  const couponCodes = (w.coupon_lines || []).map((c) => c.code).filter(Boolean);
  if (couponCodes.length > 1) {
    warnings.push({ entity: "order", id: w.id, code: "MULTI_DISCOUNT", severity: "info", message: `Order ${w.number}: ${couponCodes.length} coupons used; Shopify orderCreate accepts one code. First code kept, all noted on the order.` });
  }
  const prov = ctx.provenance || WP_PROVENANCE;
  const discountTotal = Number(w.discount_total || 0);

  const order = {
    sourceIdentifier: String(w.id),
    name: w.number ? `${prov.orderNamePrefix}${w.number}` : undefined,
    email: w.billing?.email || undefined,
    processedAt,
    currency,
    ...(FINANCIAL_FROM_STATUS[w.status] && !paid ? { financialStatus: FINANCIAL_FROM_STATUS[w.status] } : {}),
    ...(w.status === "completed" && o.markFulfilledWhenComplete ? { fulfillmentStatus: "FULFILLED" } : {}),
    note: [
      L.orderNote(w),
      couponCodes.length ? L.couponNote(couponCodes.join(", "), w.discount_total, currency) : null,
      partialRefunds.length && w.status !== "refunded" ? L.refundNote(refundedTotal.toFixed(2), currency) : null,
      w.customer_note ? `${L.customerNoteLabel}: ${w.customer_note}` : null
    ].filter(Boolean).join("\n"),
    tags: [o.tag, `${prov.statusTag}${w.status}`, `${prov.orderTag}${w.number || w.id}`].filter(Boolean),
    billingAddress: mapAddr(w.billing),
    shippingAddress: mapAddr(w.shipping) || mapAddr(w.billing),
    lineItems,
    ...(discountTotal > 0 ? {
      discountCode: { itemFixedDiscountCode: { code: couponCodes[0] || "WP-DISCOUNT", amountSet: money(discountTotal, currency) } }
    } : {}),
    shippingLines: (w.shipping_lines || []).map((s) => {
      const taxLines = mapTaxLines(s.taxes, w, currency, s.total);
      return {
        title: s.method_title || "Shipping",
        priceSet: money(s.total, currency),
        ...(taxLines.length ? { taxLines } : {})
      };
    }),
    // Shopify rejects a SALE transaction of zero ("Transactions Amount must be
    // greater than zero for sale transactions"), which killed an entire order
    // on import (real-xl, 2026-07-29). Zero-total orders are legitimate and
    // common — a 100% discount code, a free sample, a comped replacement — so
    // the order must still import; it just carries no transaction.
    ...(paid && Number(w.total) > 0 ? {
      transactions: [{
        kind: "SALE", status: "SUCCESS",
        gateway: w.payment_method_title || w.payment_method || "import",
        amountSet: money(w.total, currency),
        processedAt
      }]
    } : {})
  };

  if (w.status === "refunded") {
    warnings.push({ entity: "order", id: w.id, code: "REFUND_NOT_RECREATED", severity: "info", message: `Order ${w.number} was refunded in Woo. It is imported as paid + tagged wc-status-refunded; the refund itself is not recreated (Shopify refund objects can't be backdated — platform fact).` });
  }

  return { order, warnings, wooId: w.id };
}
