#!/usr/bin/env python3
"""Render .github/assets/social-preview.png (1280x640, GitHub's recommended size).

The logo is not a lookalike: the glyph bitmaps and the phosphor gradient below are
copied from src/ui.js, and the diagonal light-sweep uses the same formula as
banner(). If the terminal brand changes, change it there first, then re-run:

    python .github/assets/make-social-preview.py

Requires Pillow. Upload the result under repo Settings -> Social preview
(GitHub has no API for it).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# --- from src/ui.js: GLYPHS ---
GLYPHS = {
    "S": [" ████", "█    ", " ███ ", "    █", "████ "],
    "H": ["█   █", "█   █", "█████", "█   █", "█   █"],
    "O": [" ███ ", "█   █", "█   █", "█   █", " ███ "],
    "P": ["████ ", "█   █", "████ ", "█    ", "█    "],
    "L": ["█    ", "█    ", "█    ", "█    ", "█████"],
    "I": ["█████", "  █  ", "  █  ", "  █  ", "█████"],
    "F": ["█████", "█    ", "████ ", "█    ", "█    "],
    "T": ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
}

# --- from src/ui.js: GRADIENT, reversed to dark -> bright as banner() does ---
RAMP = [(0, 143, 37), (0, 194, 50), (0, 255, 65), (102, 255, 126), (182, 255, 198)]

# --- from src/ui.js: RAIN ---
RAIN = "0100111 01 00110 1101001 010 1 011011 0010111 01001 10 1101 0 01110 100"

WORD = "SHOPLIFT"
W, H = 1280, 640
BG = (7, 12, 9)

OUT = Path(__file__).resolve().parent / "social-preview.png"


def render_word(word):
    """src/ui.js renderWord(): glyphs joined with a single-column gap."""
    rows = ["", "", "", "", ""]
    for ch in word:
        g = GLYPHS[ch]
        for r in range(5):
            rows[r] += g[r] + " "
    return rows


def sweep_color(col, row, width):
    """src/ui.js banner(): dark lower-left rising to white-hot upper-right."""
    t = (col / width) * 0.72 + ((4 - row) / 4) * 0.28
    return RAMP[max(0, min(4, int(t * 5)))]


def load_font(size, bold=False):
    for name in (["seguisb.ttf", "segoeuib.ttf"] if bold else []) + [
        "consola.ttf", "SegoeUI.ttf", "segoeui.ttf", "DejaVuSansMono.ttf", "Arial.ttf"
    ]:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Faint scanlines — the CRT texture the TUI implies.
    for y in range(0, H, 4):
        d.line([(0, y), (W, y)], fill=(10, 18, 13))

    rows = render_word(WORD)
    cols = len(rows[0])

    # Size the blocks to the canvas rather than hardcoding: 8 glyphs x 6 columns
    # is 48 cells, which overflows 1280px at any cell size above ~22.
    side_margin = 70
    pitch = (W - 2 * side_margin) // cols       # cell + gap
    gap = max(2, pitch // 8)
    cell = pitch - gap
    art_w = cols * pitch - gap
    art_h = 5 * pitch - gap
    x0 = (W - art_w) // 2
    y0 = 196

    for r, row in enumerate(rows):
        for col, ch in enumerate(row):
            if ch == " ":
                continue
            c = sweep_color(col, r, cols)
            x = x0 + col * pitch
            y = y0 + r * pitch
            d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=c)

    mono_sm = load_font(20)
    mono_md = load_font(26)

    # Binary-rain strip above the logo.
    d.text((x0, y0 - 52), RAIN[:70], font=mono_sm, fill=(24, 54, 33))

    def centered(text, y, font, fill):
        w = d.textbbox((0, 0), text, font=font)[2]
        d.text(((W - w) // 2, y), text, font=font, fill=fill)

    centered("▓▒░  store extraction & relocation suite  ░▒▓",
             y0 + art_h + 46, mono_md, (0, 255, 65))
    centered("WordPress → Shopify   ·   resumable   ·   auditable",
             y0 + art_h + 92, mono_sm, (118, 150, 128))

    # Divider + spec strip, closing the lower third instead of leaving it empty.
    d.line([(W // 2 - 220, H - 104), (W // 2 + 220, H - 104)], fill=(22, 48, 30))
    centered("zero runtime dependencies   ·   Node ≥ 20   ·   GraphQL Admin API 2026-07",
             H - 74, mono_sm, (78, 104, 86))

    img.save(OUT, "PNG", optimize=True)
    print(f"{OUT}  {OUT.stat().st_size / 1024:.0f} KB  {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    main()
