import { c } from "./ui.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[process.env.LOG_LEVEL || "info"] ?? 20;

function ts() { return c.gray(`[${new Date().toISOString().slice(11, 19)}]`); }

export const log = {
  setLevel(l) { threshold = LEVELS[l] ?? threshold; },
  debug: (...a) => { if (threshold <= 10) console.log(ts(), c.gray("DEBUG"), ...a); },
  info: (...a) => { if (threshold <= 20) console.log(ts(), ...a); },
  warn: (...a) => { if (threshold <= 30) console.warn(ts(), c.yellow("WARN"), ...a); },
  error: (...a) => { if (threshold <= 40) console.error(ts(), c.red("ERROR"), ...a); }
};
