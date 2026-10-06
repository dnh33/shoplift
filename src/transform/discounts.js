/**
 * WooCommerce coupon -> Shopify discountCodeBasicCreate input.
 * percent      -> percentage discount
 * fixed_cart   -> fixed amount, applies once to the order
 * fixed_product-> fixed amount per matching item (appliesOnEachItem)
 */
export function transformCoupon(c, ctx) {
  const warnings = [];
  const now = new Date();
  const expired = c.date_expires && new Date(c.date_expires) < now;
  if (expired && ctx.cfg.options.skipExpiredCoupons) {
    return { discount: null, warnings, skipped: true };
  }

  const KNOWN = new Set(["percent", "fixed_cart", "fixed_product", "free_shipping"]);
  if (!KNOWN.has(c.discount_type)) {
    warnings.push({ entity: "coupon", id: c.id, code: "COUPON_TYPE_UNKNOWN", severity: "action", message: `Coupon "${c.code}" has discount_type ${JSON.stringify(c.discount_type)} — not a Shopify money-off type. Skipped; it is not imported as a fixed amount.` });
    return { discount: null, warnings, skipped: true };
  }

  let customerGetsValue;
  const amount = Number(c.amount || 0);
  if (c.discount_type === "percent") {
    customerGetsValue = { percentage: Math.min(1, amount / 100) };
  } else {
    customerGetsValue = { discountAmount: { amount: String(amount.toFixed(2)), appliesOnEachItem: c.discount_type === "fixed_product" } };
  }

  if (c.product_ids?.length) {
    warnings.push({ entity: "coupon", id: c.id, code: "SCOPED_COUPON", severity: "handled", message: `Coupon "${c.code}" is product-restricted in Woo. The restriction is re-applied automatically at import if those products were migrated.` });
  }
  if (c.product_categories?.length) {
    warnings.push({ entity: "coupon", id: c.id, code: "SCOPED_COUPON_CATEGORY", severity: "action", message: `Coupon "${c.code}" is category-restricted in Woo — re-create the collection restriction manually in Shopify admin (Discounts).` });
  }

  const discount = {
    title: c.code,
    code: c.code,
    startsAt: c.date_created_gmt ? c.date_created_gmt + "Z" : now.toISOString(),
    ...(c.date_expires ? { endsAt: new Date(c.date_expires).toISOString() } : {}),
    customerSelection: { all: true },
    customerGets: { value: customerGetsValue, items: { all: true } },
    ...(c.usage_limit ? { usageLimit: c.usage_limit } : {}),
    appliesOncePerCustomer: Number(c.usage_limit_per_user) === 1,
    ...(Number(c.minimum_amount) > 0 ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(Number(c.minimum_amount).toFixed(2)) } } } : {})
  };

  return { discount, warnings, code: c.code, wooId: c.id, productIds: c.product_ids || [] };
}
