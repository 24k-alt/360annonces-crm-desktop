"""Generates NSIS branding + app icon source (Twenty-style tokens, 360annonces monogram).
Run: python make-assets.py   (needs Pillow). Optional: INTER_TTF=path/to/Inter-Bold.ttf
Outputs next to this file: header.bmp 150x57, sidebar.bmp 164x314, app-icon.png 1024x1024 (24-bit BMPs, as NSIS wants)."""
import os, math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent
BLUE, BLUE_DK, BORDER, TEXT, TEXT2 = "#3e63dd", "#2f4cb3", "#ebebeb", "#333333", "#666666"  # twenty-tokens.ts
FONTS = [os.environ.get("INTER_TTF", ""), "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/seguisb.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]

def font(size):
    for f in FONTS:
        if f and Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

def gradient(w, h, c1, c2):
    im = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(rgb(c1), rgb(c2), y / max(1, h - 1)))
    return im

def monogram(size, bg=True, fg="#ffffff"):
    """Rounded tile (diagonal blue gradient) + open 360-degree ring with arrowhead + bold '3'. Drawn at 4x, downsampled."""
    S = size * 4
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    if bg:
        g = gradient(S, S, "#5b7ae8", BLUE_DK).rotate(0)
        mask = Image.new("L", (S, S), 0)
        m = int(S * 0.06)
        ImageDraw.Draw(mask).rounded_rectangle([m, m, S - m, S - m], radius=int(S * 0.22), fill=255)
        im.paste(g, (0, 0), mask)
    d = ImageDraw.Draw(im)
    cx = cy = S / 2
    r, w = S * 0.30, max(2, int(S * 0.045))
    box = [cx - r, cy - r, cx + r, cy + r]
    d.arc(box, start=-70, end=225, fill=fg, width=w)           # gap at top-right = "360" orbit
    a = math.radians(-70)                                       # arrowhead at the arc start
    tx, ty = cx + r * math.cos(a), cy + r * math.sin(a)
    d.ellipse([tx - w * 1.05, ty - w * 1.05, tx + w * 1.05, ty + w * 1.05], fill=fg)
    f = font(int(S * 0.34))
    d.text((cx, cy + S * 0.01), "3", font=f, fill=fg, anchor="mm")
    return im.resize((size, size), Image.LANCZOS)

def wordmark(d, xy, size, color, sub=None):
    f = font(size)
    d.text(xy, "360annonces", font=f, fill=color)
    return xy

def header():  # NSIS header: title text is drawn left by NSIS on this bitmap, logo goes right
    im = Image.new("RGB", (150, 57), "#ffffff")
    d = ImageDraw.Draw(im)
    d.line([(0, 56), (150, 56)], fill=rgb(BORDER))
    im.paste(monogram(44, True), (100, 6), monogram(44, True))
    return im

def sidebar():
    im = gradient(164, 314, "#4a6be0", "#2a418f")
    d = ImageDraw.Draw(im)
    d.ellipse([-70, 190, 150, 410], outline=(255, 255, 255), width=1)  # subtle orbit motif
    d.ellipse([-20, 230, 190, 440], outline=lerp(rgb("#4a6be0"), (255, 255, 255), .25), width=1)
    logo = monogram(76, False)
    im.paste(logo, (20, 28), logo)
    d.text((20, 126), "360annonces", font=font(19), fill="#ffffff")
    d.text((20, 152), "CRM pour agences", font=font(11), fill=lerp(rgb("#ffffff"), rgb("#4a6be0"), .25))
    return im

def icon():
    im = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    m = monogram(1024, True)
    im.alpha_composite(m)
    return im

if __name__ == "__main__":
    header().save(OUT / "header.bmp", format="BMP")
    sidebar().save(OUT / "sidebar.bmp", format="BMP")
    icon().save(OUT / "app-icon.png")
    for n in ("header.bmp", "sidebar.bmp", "app-icon.png"):
        im = Image.open(OUT / n); print(n, im.size, im.mode, im.format)
