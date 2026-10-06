/**
 * wp-bootstrap.js — programmatic WordPress setup from an admin login.
 * Used by scripts/bootstrap-wp.mjs and the site manager's "Add WordPress"
 * flow. Runs on machines with normal internet access (not the sandbox).
 *
 * Given site URL + admin username/password it can:
 *   1. log in (cookie session, wp-login.php)
 *   2. mint a WP Application Password (works for WP REST *and* WooCommerce
 *      REST via HTTP Basic on HTTPS — no manual consumer keys needed)
 *   3. install + activate WooCommerce via wp/v2/plugins (optional)
 *   4. verify wc/v3 accepts the application password
 */

/** Authenticated WP REST helper from basic-auth credentials (app password or Woo keys). */
export function createWpApi({ site, username, password }) {
  const SITE = String(site).replace(/\/$/, "");
  const BASIC = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  return async (method, route, payload, { ok = [200, 201], timeoutMs = 180000 } = {}) => {
    const res = await fetch(`${SITE}/wp-json/${route}`, {
      method,
      headers: { Authorization: BASIC, "Content-Type": "application/json", "User-Agent": "shoplift/1.337" },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    if (!ok.includes(res.status)) {
      const err = new Error(`HTTP ${res.status} on ${route}: ${JSON.stringify(data).slice(0, 200)}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };
}

export async function bootstrapWordPress({ site, username, password, installWoo = true, logger = () => {} }) {
  const SITE = String(site).replace(/\/$/, "");

  // ---- cookie jar ----
  const jar = new Map();
  const storeCookies = (res) => {
    for (const ck of res.headers.getSetCookie?.() || []) {
      const [pair] = ck.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const hit = async (url, opts = {}) => {
    const res = await fetch(url, {
      redirect: "manual", ...opts,
      headers: { "User-Agent": "shoplift/1.337", Cookie: cookieHeader(), ...(opts.headers || {}) }
    });
    storeCookies(res);
    return res;
  };

  // ---- 1. login ----
  jar.set("wordpress_test_cookie", "WP%20Cookie%20check");
  await hit(`${SITE}/wp-login.php`);
  const body = new URLSearchParams({ log: username, pwd: password, "wp-submit": "Log In", redirect_to: `${SITE}/wp-admin/`, testcookie: "1" });
  const loginRes = await hit(`${SITE}/wp-login.php`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString()
  });
  if (![...jar.keys()].some((k) => k.startsWith("wordpress_logged_in"))) {
    const html = loginRes.status === 200 ? await loginRes.text() : "";
    const reason = html.match(/<div id="login_error">([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, " ").trim();
    throw new Error(`WordPress login failed (HTTP ${loginRes.status}). ${reason || "Check username/password."}`);
  }
  logger("logged in (cookie session)");

  // ---- 2. application password ----
  const nres = await hit(`${SITE}/wp-admin/admin-ajax.php?action=rest-nonce`);
  const nonce = (await nres.text()).trim();
  if (!/^[a-f0-9]{8,12}$/i.test(nonce)) throw new Error(`Could not get a REST nonce (got: ${nonce.slice(0, 60)})`);
  const apRes = await hit(`${SITE}/wp-json/wp/v2/users/me/application-passwords`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WP-Nonce": nonce },
    body: JSON.stringify({ name: `shoplift-${Date.now()}` })
  });
  const apData = await apRes.json().catch(() => ({}));
  if (!apData.password) throw new Error(`Application password creation failed: ${JSON.stringify(apData).slice(0, 300)}`);
  const appPassword = apData.password.replaceAll(" ", "");
  logger("application password created");

  // ---- authed REST helper ----
  const BASIC = "Basic " + Buffer.from(`${username}:${appPassword}`).toString("base64");
  const api = async (method, route, payload, { ok = [200, 201], timeoutMs = 120000 } = {}) => {
    const res = await fetch(`${SITE}/wp-json/${route}`, {
      method,
      headers: { Authorization: BASIC, "Content-Type": "application/json", "User-Agent": "shoplift/1.337" },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    if (!ok.includes(res.status)) {
      const err = new Error(`HTTP ${res.status} on ${route}: ${JSON.stringify(data).slice(0, 200)}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };

  // ---- 3. WooCommerce ----
  let wooActive = false;
  if (installWoo) {
    const existing = await api("GET", "wp/v2/plugins?search=woocommerce").catch(() => []);
    const woo = Array.isArray(existing) ? existing.find((p) => p.plugin?.includes("woocommerce")) : null;
    if (woo?.status === "active") { wooActive = true; logger("WooCommerce already active"); }
    else if (woo) { await api("POST", `wp/v2/plugins/${encodeURIComponent(woo.plugin)}`, { status: "active" }); wooActive = true; logger("WooCommerce activated"); }
    else {
      logger("installing WooCommerce (can take a minute)…");
      await api("POST", "wp/v2/plugins", { slug: "woocommerce", status: "active" }, { timeoutMs: 300000 });
      wooActive = true;
      logger("WooCommerce installed + activated");
    }
  }

  // ---- 4. verify wc/v3 auth ----
  let wooAuthOk = false;
  if (wooActive) {
    for (let i = 0; i < 6; i++) {
      try { await api("GET", "wc/v3/products?per_page=1"); wooAuthOk = true; break; }
      catch (e) {
        if (e.status === 401 || e.status === 403) break; // app password rejected for wc/v3 — needs manual consumer keys
        await new Promise((r) => setTimeout(r, 5000)); // routes may need a beat after activation
      }
    }
    logger(wooAuthOk ? "wc/v3 accepts the application password" : "wc/v3 did not accept the application password — create consumer keys in WooCommerce → Settings → Advanced → REST API");
  }

  return { site: SITE, username, appPassword, wooActive, wooAuthOk, api };
}
