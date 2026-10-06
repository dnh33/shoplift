import { fetchRetry, sleep } from "../util/http.js";
import { log } from "../log.js";

/**
 * Shopify Admin GraphQL client (the REST Admin API is legacy since Oct 2024;
 * all imports here use GraphQL only).
 *
 * Rate limiting is cost-based, not request-based. Every response carries
 * extensions.cost.throttleStatus { maximumAvailable, currentlyAvailable,
 * restoreRate } — the client paces itself from those live numbers instead of
 * hardcoding plan limits (which differ on Basic/Advanced/Plus).
 */
export function createShopifyClient({ shop, adminAccessToken, apiVersion, clientId, clientSecret }) {
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  let lastCost = null;

  // --- token management ---
  // Two auth modes (2026):
  //  a) legacy custom app: permanent shpat_ token (adminAccessToken)
  //  b) Dev Dashboard app: client credentials grant — exchange clientId+secret
  //     for a 24h offline token at /admin/oauth/access_token, refresh on expiry.
  let token = adminAccessToken || null;
  let tokenExp = adminAccessToken ? Infinity : 0;

  async function ensureToken() {
    if (token && Date.now() < tokenExp - 120000) return token;
    if (!clientId || !clientSecret) {
      throw new Error("No Shopify credentials: set shopify.adminAccessToken (legacy custom app) or shopify.clientId + clientSecret (Dev Dashboard app)");
    }
    const res = await fetchRetry(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString()
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`Client credentials grant failed (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 300)} — is the app installed on ${shop}?`);
    }
    token = body.access_token;
    tokenExp = Date.now() + (body.expires_in || 86399) * 1000;
    log.info(`Shopify access token minted via client credentials (${body.scope ? body.scope.split(",").length + " scopes" : "?"}, valid ~24h)`);
    return token;
  }

  async function graphql(query, variables = {}, { attempt = 0 } = {}) {
    // Preemptive pacing: if the bucket is under 20% after the previous call, wait for refill.
    if (lastCost && lastCost.currentlyAvailable < lastCost.maximumAvailable * 0.2) {
      const waitMs = Math.ceil(((lastCost.maximumAvailable * 0.5 - lastCost.currentlyAvailable) / lastCost.restoreRate) * 1000);
      if (waitMs > 0) { log.debug(`Throttle: waiting ${waitMs}ms for cost bucket refill`); await sleep(Math.min(waitMs, 20000)); }
    }

    const res = await fetchRetry(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await ensureToken() },
      body: JSON.stringify({ query, variables })
    });

    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && clientId && attempt === 0) {
      token = null; tokenExp = 0; // token expired mid-run — mint a fresh one and retry once
      return graphql(query, variables, { attempt: 1 });
    }
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);

    lastCost = body.extensions?.cost?.throttleStatus || lastCost;

    if (body.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < 6) {
        const cost = body.extensions?.cost;
        const need = cost?.requestedQueryCost || 400;
        const waitMs = Math.ceil((need / (cost?.throttleStatus?.restoreRate || 50)) * 1000) + 250;
        log.debug(`THROTTLED — retrying in ${waitMs}ms`);
        await sleep(waitMs);
        return graphql(query, variables, { attempt: attempt + 1 });
      }
      throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 600)}`);
    }
    return body.data;
  }

  /** Runs a mutation and throws a readable error if userErrors came back. */
  async function mutate(mutationName, query, variables) {
    const data = await graphql(query, variables);
    const payload = data?.[mutationName];
    const userErrors = payload?.userErrors || [];
    if (userErrors.length) {
      const err = new Error(`${mutationName} userErrors: ${JSON.stringify(userErrors).slice(0, 600)}`);
      err.userErrors = userErrors;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  return { graphql, mutate, shop, apiVersion };
}

/** Resolve the shop's primary location gid (needed for inventoryQuantities). */
export async function getPrimaryLocationId(client, configured) {
  if (configured) return configured;
  const data = await client.graphql(`{ location { id name } }`);
  if (!data?.location?.id) throw new Error("Could not resolve primary location — set shopify.primaryLocationId in config");
  log.info(`Using location: ${data.location.name} (${data.location.id})`);
  return data.location.id;
}
