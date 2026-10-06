/**
 * ui.js — zero-dependency terminal theme: "PHOSPHOR" (Matrix × 1337 console).
 *
 * Design system:
 *   One hue, many intensities. Green carries all structure and hierarchy via
 *   brightness; the only other hues are semantic interrupts (amber = caution,
 *   red = failure) — like a CRT-era operator console. Never more than one
 *   bright element per line; color IS information.
 *
 * 24-bit ANSI (Windows Terminal, macOS, Linux). Honors NO_COLOR and degrades
 * to plain text when stdout isn't a TTY (pipes, CI, tests).
 */
import { machine } from "./util/machine.js";

const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const fg = (r, g, b) => (s) => (TTY ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : String(s));
const wrap = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));

// ---- palette ----
const MATRIX = fg(0, 255, 65);      // canonical Matrix green — keys, success, prompt, active
const PHOSPHOR = fg(157, 255, 176); // pale glow — identities, brand emphasis
const TEXT = fg(208, 245, 216);     // green-tinted white — primary content
const MUTED = fg(114, 147, 124);    // desaturated moss — readable secondary text (≥4.5:1 on black)
const AMBER = fg(255, 179, 0);      // CRT amber — warnings only
const RED = fg(255, 77, 77);        // failure only
const DEEP = fg(0, 143, 37);        // darker green — gradients, secondary fill

export const c = {
  // semantic roles
  key: MATRIX,       // interactive keys / commands
  accent: PHOSPHOR,  // names, identity, brand
  text: TEXT,        // primary content
  muted: MUTED,      // secondary content, structure
  ok: MATRIX,
  warn: AMBER,
  danger: RED,
  deep: DEEP,
  dim: wrap(2),
  bold: wrap(1),
  inv: wrap(7),
  // legacy aliases — remapped into the green system so no call site can ever
  // render pink/magenta/blue again
  cyan: MATRIX,
  magenta: PHOSPHOR,
  green: MATRIX,
  yellow: AMBER,
  red: RED,
  blue: DEEP,
  gray: MUTED,
  white: TEXT
};

export const chip = {
  ok: () => c.ok("✓"),
  fail: () => c.danger("✗"),
  warn: () => c.warn("⚠"),
  arrow: () => DEEP("→"),
  prompt: () => c.key("▸")
};

// ---- pixel block font (5 rows), used for the big banner ----
const GLYPHS = {
  W: ["█   █", "█   █", "█ █ █", "█ █ █", " █ █ "],
  P: ["████ ", "█   █", "████ ", "█    ", "█    "],
  2: ["████ ", "    █", " ███ ", "█    ", "█████"],
  S: [" ████", "█    ", " ███ ", "    █", "████ "],
  H: ["█   █", "█   █", "█████", "█   █", "█   █"],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
  F: ["█████", "█    ", "████ ", "█    ", "█    "],
  Y: ["█   █", " █ █ ", "  █  ", "  █  ", "  █  "],
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  " ": ["  ", "  ", "  ", "  ", "  "]
};

const renderWord = (word) => {
  const rows = ["", "", "", "", ""];
  for (const ch of word) {
    const g = GLYPHS[ch] || GLYPHS[" "];
    for (let r = 0; r < 5; r++) rows[r] += g[r] + " ";
  }
  return rows;
};

const COMPACT_LINES = [
  "╦ ╦╔═╗┌─┐  ╔═╗╦ ╦╔═╗╔═╗╦╔═╗╦ ╦",
  "║║║╠═╝ ┌┘  ╚═╗╠═╣║ ║╠═╝║╠╣ ╚╦╝",
  "╚╩╝╩   └─  ╚═╝╩ ╩╚═╝╩  ╩╚   ╩ "
];

// phosphor-decay gradient: bright at the top of the tube, fading down
const GRADIENT = [fg(182, 255, 198), fg(102, 255, 126), fg(0, 255, 65), fg(0, 194, 50), fg(0, 143, 37)];

// fixed dim binary-rain strip (deterministic — no per-render flicker)
const RAIN = "0100111 01 00110 1101001 010 1 011011 0010111 01001 10 1101 0 01110 100";

/**
 * Banner: pixel "WP2 SHOPIFY" with vertical phosphor-decay gradient and a dim
 * digital-rain strip. Compact box-drawing variant on narrow terminals.
 */
export function banner(tagline = "store extraction & relocation suite") {
  const width = process.stdout.columns || 100;
  let art;
  if (width >= 64) {
    // "SHOPLIFT" with a diagonal phosphor light-sweep: each cell colored by
    // position, dark lower-left rising to white-hot upper-right
    const rows = renderWord("SHOPLIFT");
    const W = rows[0].length;
    const ramp = [...GRADIENT].reverse(); // dark -> bright
    art = rows.map((row, r) =>
      "  " + [...row].map((ch, col) => {
        if (ch === " ") return " ";
        const t = (col / W) * 0.72 + ((4 - r) / 4) * 0.28;
        return ramp[Math.max(0, Math.min(4, Math.floor(t * 5)))](ch);
      }).join("")
    ).join("\n");
  } else {
    art = COMPACT_LINES.map((l, i) => "  " + GRADIENT[Math.min(i * 2, 4)](l)).join("\n");
  }
  const rain = c.dim(MUTED(RAIN.slice(0, Math.min(RAIN.length, Math.max(24, width - 6)))));
  return `\n  ${rain}\n${art}\n\n  ${c.dim(MUTED("▓▒░"))} ${MUTED(tagline)} ${c.key("v1.337")} ${c.dim(MUTED("░▒▓"))}\n`;
}

/** Pad to a visible width (ANSI-aware) — for column layouts. */
export const padv = (s, w) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));

/** One-line brand bar — identity earns its 8 rows once (boot); redraws use this. */
export const miniBrand = (extra = "") =>
  `\n  ${c.dim(MUTED("▓▒░"))} ${GRADIENT[2]("SHOPLIFT")} ${c.dim(MUTED("░▒▓"))}${extra ? `  ${extra}` : ""}  ${c.key("v1.337")}`;

/** Motion opt-out: NO_COLOR/pipes already disable; SHOPLIFT_NO_FX keeps color, kills animation. */
export const FX = TTY && !process.env.SHOPLIFT_NO_FX;

export const hr = (w = 56) => c.dim(MUTED("─".repeat(w)));

/** key/value context line: label right-padded, dim separator. */
export const kv = (label, value, pad = 8) => `  ${MUTED(label.padEnd(pad))}${c.dim(MUTED("│"))} ${value}`;

/** Menu row: [key] label — description */
export const menuRow = (key, label, desc = "", keyPad = 3) =>
  `  ${c.key(`[${key}]`.padEnd(keyPad + 2))} ${TEXT(label.padEnd(18))}${desc ? MUTED(desc) : ""}`;

/** Operator-console section: ──[ LABEL ]───────── */
export const section = (label, w = 56) => {
  const name = label.toUpperCase();
  const tail = Math.max(2, w - name.length - 8);
  return `\n  ${c.dim(MUTED("──["))} ${PHOSPHOR(name)} ${c.dim(MUTED("]" + "─".repeat(tail)))}`;
};

/**
 * Spinner with live label. Non-TTY: prints the label once, methods no-op.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spinner(label) {
  if (!TTY || machine.on) {
    return { update() {}, succeed(t) { console.log(`  ✓ ${t ?? label}`); }, fail(t) { console.log(`  ✗ ${t ?? label}`); }, stop() {} };
  }
  let text = label, i = 0, active = true;
  const render = () => process.stdout.write(`\r\x1b[2K  ${c.key(FRAMES[i = (i + 1) % FRAMES.length])} ${TEXT(String(text).slice(0, Math.max(10, (process.stdout.columns || 80) - 6)))}`);
  const timer = setInterval(render, 80);
  const end = (mark, t) => {
    if (!active) return; active = false;
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K  ${mark} ${TEXT(t ?? text)}\n`);
  };
  return {
    update(t) { text = t; },
    succeed(t) { end(chip.ok(), t); },
    fail(t) { end(chip.fail(), t); },
    stop() { if (active) { active = false; clearInterval(timer); process.stdout.write("\r\x1b[2K"); } }
  };
}

/**
 * Progress bar. The leading filled cell renders brighter than the trail —
 * the white-hot head of a rain streak. Non-TTY: logs every `logEvery`.
 */
export function progress(label, total, { logEvery = 25 } = {}) {
  let n = 0;
  if (!TTY || machine.on) {
    return {
      tick() { if (++n % logEvery === 0) console.log(`  ${label}: ${n}/${total}`); },
      done(msg) { console.log(`  ✓ ${msg ?? `${label}: ${n}/${total}`}`); }
    };
  }
  const W = 22;
  const draw = (suffix = "") => {
    const filled = total ? Math.round((n / total) * W) : W;
    const body = Math.max(0, filled - 1);
    const bar =
      DEEP("▓".repeat(body)) +
      (filled > 0 ? PHOSPHOR("█") : "") +
      c.dim(MUTED("░".repeat(W - filled)));
    // clamp so long suffixes can't wrap and leave \r ghost fragments
    const budget = Math.max(0, (process.stdout.columns || 80) - W - String(`${n}/${total}`).length - label.length - 8);
    const s = String(suffix).slice(0, budget);
    process.stdout.write(`\r\x1b[2K  ${bar} ${TEXT(`${n}/${total}`)} ${MUTED(label)} ${c.dim(MUTED(s))}`);
  };
  draw();
  return {
    tick(suffix) { n++; draw(suffix ?? ""); },
    done(msg) { process.stdout.write(`\r\x1b[2K  ${chip.ok()} ${TEXT(msg ?? `${label}: ${n}/${total}`)}\n`); }
  };
}

/** Clear screen + scrollback (TTY only, no-op when piped). */
export const clearScreen = () => { if (TTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); };

// ---- terminal craft ----

/** Visible width of a string (ANSI + OSC sequences stripped). */
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07)/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, "");
const vw = (s) => stripAnsi(s).length;

/** OSC-8 clickable hyperlink (Windows Terminal, iTerm2, most modern emulators). */
export const link = (text, url) => (TTY ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text);

/** Set the terminal window/tab title (OSC 2). */
export const setTitle = (t) => { if (TTY) process.stdout.write(`\x1b]2;${t}\x07`); };

/** Alternate screen buffer: the menu lives in its own screen; quitting restores the shell exactly as it was. */
export const enterAltScreen = () => { if (TTY) process.stdout.write("\x1b[?1049h\x1b[?25l"); };
export const exitAltScreen = () => { if (TTY) process.stdout.write("\x1b[?25h\x1b[?1049l"); };
export const showCursor = () => { if (TTY) process.stdout.write("\x1b[?25h"); };
export const hideCursor = () => { if (TTY) process.stdout.write("\x1b[?25l"); };

/**
 * Rounded framed panel with a bracket title:
 *   ╭─[ LINK ]──────────────╮
 *   │ …lines…               │
 *   ╰───────────────────────╯
 */
export function panel(title, lines, minWidth = 56) {
  const inner = Math.max(minWidth, ...lines.map(vw)) + 2;
  const name = ` ${PHOSPHOR(title.toUpperCase())} `;
  const top = c.dim(MUTED("╭─[")) + name + c.dim(MUTED("]" + "─".repeat(Math.max(0, inner - vw(title) - 5)) + "╮"));
  const bottom = c.dim(MUTED("╰" + "─".repeat(inner) + "╯"));
  const body = lines.map((l) => `${c.dim(MUTED("│"))} ${l}${" ".repeat(Math.max(0, inner - vw(l) - 1))}${c.dim(MUTED("│"))}`);
  return ["  " + top, ...body.map((b) => "  " + b), "  " + bottom].join("\n");
}

/** Background-fill verdict block: ` ✓ VERIFY OK ` on a solid dark field. */
export const verdict = (ok, text) => {
  if (!TTY) return `${ok ? "✓" : "✗"} ${text}`;
  const bg = ok ? "\x1b[48;2;0;61;23m" : "\x1b[48;2;80;10;10m";
  const fgc = ok ? "\x1b[38;2;157;255;176m" : "\x1b[38;2;255;170;170m";
  return `${bg}${fgc}\x1b[1m  ${ok ? "✓" : "✗"} ${text}  \x1b[0m`;
};

/** One-time typed boot sequence (Matrix console feel). Instant when piped. */
export async function bootSequence(rows, { delay = 55 } = {}) {
  const W = 34;
  for (const [label, value] of rows) {
    const dots = "·".repeat(Math.max(2, W - label.length));
    if (TTY) {
      process.stdout.write(`  ${MUTED("> " + label + " " + dots + " ")}`);
      if (FX) await new Promise((r) => setTimeout(r, delay));
      process.stdout.write(`${value === "READY" ? MATRIX(value) : TEXT(value)}\n`);
    } else {
      console.log(`  > ${label} ${dots} ${value}`);
    }
  }
  if (FX) await new Promise((r) => setTimeout(r, 140));
}

export const isTTY = TTY;
