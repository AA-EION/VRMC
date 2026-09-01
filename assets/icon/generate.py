# SPDX-License-Identifier: GPL-3.0-only
"""
Generate the VRMC app icon at every size the platforms need.

The mark is a pad grid whose lit pads form a V — the instrument and the initial
in one shape. It has to survive being drawn at 16 pixels in a Windows tray, so
the geometry is tuned per size rather than scaled from one master: at small
sizes the pads grow and the gaps shrink, keeping the V readable when a
proportional scale-down would turn it to mush.
"""
from PIL import Image, ImageDraw, ImageFilter

# Grid of lit pads forming a V. Row 0 is the top.
V_PATTERN = [
    (0, 0), (0, 4),
    (1, 0), (1, 4),
    (2, 1), (2, 3),
    (3, 1), (3, 3),
    (4, 2),
]
GRID = 5

# Palette, matching the client's own accent.
LIT = (0x63, 0xE0, 0xFF)
UNLIT = (0x27, 0x2E, 0x45)
BG_TOP = (0x18, 0x1D, 0x2C)
BG_BOTTOM = (0x0A, 0x0C, 0x14)


def _rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def _bold_v(draw, s: int, colour) -> None:
    """
    A single thick V, for sizes where the grid stops reading.

    Below about 64 pixels a five-column grid gives each pad only a few pixels
    and the shape collapses into texture. Small icons need their own
    artwork rather than a scaled-down master, so here the V is drawn as one
    stroke and the grid is dropped entirely.
    """
    m = s * 0.24
    top = m
    bottom = s - m
    left = m
    right = s - m
    width = int(s * 0.19)
    draw.line(
        [(left, top), (s / 2, bottom), (right, top)],
        fill=colour + (255,),
        width=width,
        joint="curve",
    )
    # Round the open ends; PIL's line caps are square.
    r = width / 2
    for x, y in ((left, top), (right, top), (s / 2, bottom)):
        draw.ellipse((x - r, y - r, x + r, y + r), fill=colour + (255,))


def render(size: int, *, tray: bool = False, bg: bool = True) -> Image.Image:
    """
    Draw the icon at `size` pixels.

    `tray` renders a flat monochrome-friendly version: macOS template images and
    Windows tray icons sit on backgrounds we do not control, so the tile is
    dropped and only the V remains.
    """
    # Supersample, then downscale. Rounded corners and small pads alias badly
    # when drawn directly at 16 or 32 pixels.
    scale = 8 if size <= 64 else 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if bg and not tray:
        # Vertical gradient tile. Drawn as rows into a separate image so the
        # rounded mask stays crisp.
        grad = Image.new("RGBA", (s, s))
        gd = ImageDraw.Draw(grad)
        for y in range(s):
            t = y / max(1, s - 1)
            gd.line(
                [(0, y), (s, y)],
                fill=tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
                + (255,),
            )
        mask = Image.new("L", (s, s), 0)
        _rounded(ImageDraw.Draw(mask), (0, 0, s - 1, s - 1), int(s * 0.225), 255)
        img.paste(grad, (0, 0), mask)

    # Up to 48 pixels the grid is replaced by a single bold V. The crossover
    # was picked by eye: at 48 the pads are about six pixels and the shape is
    # texture rather than a letter; by 64 the grid reads.
    if size <= 48:
        _bold_v(draw, s, LIT)
        return img.resize((size, size), Image.LANCZOS)

    # Pads. A tighter margin and bigger pads at small sizes keep the V legible.
    small = size <= 32
    margin = s * (0.13 if small else 0.17)
    gap_ratio = 0.16 if small else 0.24
    span = s - margin * 2
    pitch = span / GRID
    pad = pitch * (1 - gap_ratio)
    pad_radius = pad * 0.26

    lit_cells = set(V_PATTERN)

    # Glow behind the lit pads, on the larger sizes only — at 16px it would
    # just smear the shape.
    if size >= 64 and not tray:
        glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        gdraw = ImageDraw.Draw(glow)
        for row, col in lit_cells:
            x = margin + col * pitch + (pitch - pad) / 2
            y = margin + row * pitch + (pitch - pad) / 2
            _rounded(gdraw, (x, y, x + pad, y + pad), pad_radius, LIT + (170,))
        glow = glow.filter(ImageFilter.GaussianBlur(radius=s * 0.022))
        img.alpha_composite(glow)

    for row in range(GRID):
        for col in range(GRID):
            x = margin + col * pitch + (pitch - pad) / 2
            y = margin + row * pitch + (pitch - pad) / 2
            box = (x, y, x + pad, y + pad)
            if (row, col) in lit_cells:
                _rounded(draw, box, pad_radius, LIT + (255,))
            elif not tray:
                _rounded(draw, box, pad_radius, UNLIT + (255,))

    return img.resize((size, size), Image.LANCZOS)


def svg() -> str:
    """The same geometry as editable source."""
    size = 512.0
    margin = size * 0.17
    span = size - margin * 2
    pitch = span / GRID
    gap = 0.24
    pad = pitch * (1 - gap)
    r = pad * 0.26
    lit = set(V_PATTERN)

    rects = []
    for row in range(GRID):
        for col in range(GRID):
            x = margin + col * pitch + (pitch - pad) / 2
            y = margin + row * pitch + (pitch - pad) / 2
            on = (row, col) in lit
            fill = "#63E0FF" if on else "#272E45"
            rects.append(
                f'  <rect x="{x:.2f}" y="{y:.2f}" width="{pad:.2f}" height="{pad:.2f}" '
                f'rx="{r:.2f}" fill="{fill}"'
                + (' filter="url(#glow)"' if on else "")
                + " />"
            )
    body = "\n".join(rects)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>VRMC</title>
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#181D2C"/>
      <stop offset="1" stop-color="#0A0C14"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#tile)"/>
{body}
</svg>
"""


def main() -> None:
    from pathlib import Path

    here = Path(__file__).parent
    (here / "vrmc.svg").write_text(svg(), encoding="utf-8")

    # Sizes each platform asks for. Windows .ico wants the small ones; macOS
    # .icns wants powers of two up to 1024.
    sizes = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024]
    pngs = {}
    for n in sizes:
        img = render(n)
        pngs[n] = img
        img.save(here / f"vrmc-{n}.png")

    # Multi-resolution .ico. Windows picks the closest size, so shipping the
    # small ones drawn with their own geometry beats letting it downscale 256.
    pngs[256].save(
        here / "vrmc.ico",
        format="ICO",
        sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)],
        append_images=[pngs[n] for n in (16, 24, 32, 48, 64, 128)],
    )

    # Tray glyph: no tile, just the V. It sits on a background the OS owns.
    for n in (16, 20, 24, 32, 44, 64):
        render(n, tray=True).save(here / f"vrmc-tray-{n}.png")

    try:
        pngs[1024].save(here / "vrmc.icns", format="ICNS")
        icns = "vrmc.icns"
    except Exception as exc:  # pragma: no cover - depends on Pillow build
        icns = f"skipped ({exc})"

    print("svg:  vrmc.svg")
    print("png:  " + ", ".join(f"vrmc-{n}.png" for n in sizes))
    print("ico:  vrmc.ico")
    print("icns: " + icns)
    print("tray: vrmc-tray-{16,20,24,32,44,64}.png")


if __name__ == "__main__":
    main()
