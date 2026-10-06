import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

/** Read .env into an object (without mutating process.env). */
export function readEnvFile(rootDir) {
  const p = path.join(rootDir, ".env");
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Insert or update keys in .env, preserving all other lines/comments. */
export function upsertEnvFile(rootDir, updates) {
  const p = path.join(rootDir, ".env");
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null) continue;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
  }
  writeFileSync(p, text.trimEnd() + "\n");
  // also make the values live for the current process
  for (const [k, v] of Object.entries(updates)) if (v !== undefined && v !== null) process.env[k] = String(v);
  return p;
}
