import path from "node:path";
import { readJsonl, jsonlWriter } from "../util/fsx.js";
import { runBulkMutation } from "../shopify/bulk.js";
import { CUSTOMER_SET, METAFIELDS_SET } from "../shopify/mutations.js";
import { log } from "../log.js";

/**
 * Customer import via customerSet with an email identifier — a true upsert,
 * so re-runs update rather than duplicate. Small sets run as individual
 * calls; larger sets go through one bulk operation.
 * Passwords are never migrated (see PLAYBOOK — account activation flow).
 *
 * DanDomain CVR/EAN (and similar) arrive as line._metafields and are written
 * with metafieldsSet after the customer GID is known. CustomerSetInput has no
 * metafields field. Re-runs still apply metafields for ledgered customers.
 */

async function applyCustomerMetafields(client, ownerId, metafields, failed, email) {
  if (!ownerId || !metafields?.length) return;
  try {
    await client.mutate("metafieldsSet", METAFIELDS_SET, {
      metafields: metafields.map((m) => ({
        ownerId,
        namespace: m.namespace,
        key: m.key,
        type: m.type,
        value: m.value,
      })),
    });
  } catch (e) {
    failed.write({ email, error: `metafieldsSet: ${e.message}`, userErrors: e.userErrors });
    log.warn(`  customer metafields FAILED ${email}: ${e.message.slice(0, 160)}`);
  }
}

function customerSetVars(line) {
  const { _metafields, ...vars } = line;
  return { vars, metafields: _metafields };
}

export async function importCustomers(cfg, client, idmap) {
  const lines = readJsonl(path.join(cfg.paths.transformed, "customers.jsonl"));
  if (!lines.length) { log.info("No customers to import"); return { imported: 0, failed: 0 }; }

  const pending = lines.filter((l) => !idmap.has("customers", l.identifier.email));
  log.info(`Customers: ${lines.length} total, ${pending.length} to import`);
  if (cfg.options.dryRun) { log.info(`[dry-run] would import ${pending.length} customers`); return { imported: 0, failed: 0, dryRun: true }; }

  const failed = jsonlWriter(path.join(cfg.paths.state, "failed-customers.jsonl"));
  let imported = 0;

  if (pending.length <= 100) {
    for (const line of pending) {
      const { vars } = customerSetVars(line);
      try {
        const res = await client.mutate("customerSet", CUSTOMER_SET, vars);
        idmap.set("customers", line.identifier.email, res.customer.id);
        imported++;
        if (imported % 25 === 0) log.info(`  customers: ${imported}/${pending.length}`);
      } catch (e) {
        failed.write({ email: line.identifier.email, error: e.message, userErrors: e.userErrors });
      }
    }
    idmap.save();
  } else if (pending.length) {
    const tmp = path.join(cfg.paths.state, "bulk-customers.jsonl");
    const w = jsonlWriter(tmp);
    for (const line of pending) {
      const { vars } = customerSetVars(line);
      w.write(vars);
    }
    await w.close();
    const op = await runBulkMutation(client, { jsonlFile: tmp, mutation: CUSTOMER_SET, label: "customers" });
    for (const row of op.results) {
      const payload = row.data?.customerSet ?? row.customerSet ?? row;
      if (payload?.customer?.id) { idmap.set("customers", payload.customer.email, payload.customer.id); imported++; }
      else if (payload?.userErrors?.length) failed.write({ line: row.__lineNumber, userErrors: payload.userErrors });
    }
    idmap.save();
  }

  // Metafields after GIDs exist (CustomerSetInput has none). Covers new imports,
  // bulk results, and ledger skips so a resume still lands CVR/EAN.
  for (const line of lines) {
    const { metafields } = customerSetVars(line);
    if (!metafields?.length) continue;
    const ownerId = idmap.get("customers", line.identifier.email);
    if (!ownerId) continue;
    await applyCustomerMetafields(client, ownerId, metafields, failed, line.identifier.email);
  }

  await failed.close();
  log.info(`Customers: ${imported} imported, ${failed.count} failed`);
  return { imported, failed: failed.count };
}
