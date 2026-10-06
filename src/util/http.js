import { log } from "../log.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with retry + exponential backoff. Retries on 429, 5xx and network errors.
 * Returns the Response (caller decides how to parse).
 */
export async function fetchRetry(url, options = {}, { retries = 5, baseDelay = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after")) * 1000 || baseDelay * 2 ** attempt;
        log.warn(`HTTP ${res.status} on ${url.toString().slice(0, 120)} — retrying in ${Math.round(retryAfter / 1000)}s`);
        await sleep(retryAfter);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      const delay = baseDelay * 2 ** attempt;
      log.warn(`Network error (${e.message}) — retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
  throw lastErr || new Error(`Failed after ${retries} retries: ${url}`);
}

export async function fetchJson(url, options = {}, retryOpts) {
  const res = await fetchRetry(url, options, retryOpts);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.toString().slice(0, 160)}\n${text.slice(0, 500)}`);
  try { return { data: JSON.parse(text), headers: res.headers }; }
  catch { throw new Error(`Non-JSON response from ${url.toString().slice(0, 160)}: ${text.slice(0, 300)}`); }
}

export { sleep };
