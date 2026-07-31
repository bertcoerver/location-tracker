#!/usr/bin/env python3
"""Render the PNG app icons from the same geometry as icon.svg.

Run when the mark changes: `python3 icons/render.py`. The PNGs are committed —
GitHub Pages serves this repo as-is, so nothing builds at deploy time.

The geometry is duplicated from icon.svg rather than parsed out of it because the
alternative is a dependency on an SVG rasteriser for four small circles. Keep the
two in step; icon.svg stays the readable source of truth.
"""

from PIL import Image, ImageDraw

BG = (26, 26, 25, 255)      # dark --surface-1
ACCENT = (235, 104, 52)     # --accent
SS = 8                      # supersampling factor, for clean circle edges

# (radius, stroke width or None for filled, opacity) in the 512-unit viewBox.
# Opacities run a little hotter than icon.svg's, because the icon is read at
# 48 px on a home screen far more often than at 512, and the faintest ring has to
# survive that.
RINGS = [(150, 10, 0.34), (104, 12, 0.58), (58, None, 1.0)]


def over(colour, opacity):
    """`colour` at `opacity` composited onto BG, returned opaque.

    Pillow's draw operations REPLACE pixels rather than blending into them, so a
    translucent stroke would punch its alpha straight through the background and
    the ring would come out pale against whatever the viewer happens to be. The
    blend has to happen here."""
    return tuple(
        round(c * opacity + b * (1 - opacity)) for c, b in zip(colour, BG[:3])
    ) + (255,)


def draw(size, scale=1.0):
    """The mark at `size` px. `scale` shrinks the art but not the background,
    which is how the maskable variant buys its extra margin."""
    d = size * SS
    img = Image.new("RGBA", (d, d), BG)
    dr = ImageDraw.Draw(img)
    c = d / 2
    k = d / 512 * scale

    for radius, width, opacity in RINGS:
        r = radius * k
        box = (c - r, c - r, c + r, c + r)
        colour = over(ACCENT, opacity)
        if width is None:
            dr.ellipse(box, fill=colour)
        else:
            # `width` is centred on the path in SVG but drawn inward by Pillow,
            # so nudge the radius out by half of it to land in the same place.
            w = max(1, round(width * k))
            box = (c - r - w / 2, c - r - w / 2, c + r + w / 2, c + r + w / 2)
            dr.ellipse(box, outline=colour, width=w)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os

    here = os.path.dirname(os.path.abspath(__file__))
    for name, size, scale in [
        ("icon-192.png", 192, 1.0),
        ("icon-512.png", 512, 1.0),
        ("icon-512-maskable.png", 512, 0.78),
        # iOS masks this one itself, and never composites it over anything, so it
        # wants the full-bleed square with no transparency of its own.
        ("apple-touch-icon.png", 180, 1.0),
    ]:
        path = os.path.join(here, name)
        img = draw(size, scale)
        if name == "apple-touch-icon.png":
            img = img.convert("RGB")
        img.save(path, optimize=True)
        print(f"{name}  {size}x{size}")
