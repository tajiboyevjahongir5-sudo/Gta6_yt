#!/usr/bin/env python3
"""Render an animated emoji as a transparent PNG sequence (pop in -> wiggle/bounce -> fade out).
usage: emoji_anim.py <emoji> <out_dir> [--size 300] [--dur 1.4] [--fps 30]
Uses the Noto Color Emoji font (Apache 2.0) that ships with most Linux distros (fonts-noto-color-emoji)."""
import argparse, math, os, sys
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("emoji"); ap.add_argument("out")
ap.add_argument("--size", type=int, default=300); ap.add_argument("--dur", type=float, default=1.4)
ap.add_argument("--fps", type=int, default=30)
ap.add_argument("--font", default=os.environ.get("EMOJI_FONT", "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"))
a = ap.parse_args()

font = ImageFont.truetype(a.font, 109)  # CBDT color fonts only render at their native size
glyph = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
ImageDraw.Draw(glyph).text((10, 10), a.emoji, font=font, embedded_color=True)
box = glyph.getbbox()
if not box:
    sys.exit("emoji not in font")
glyph = glyph.crop(box).resize((a.size, a.size), Image.LANCZOS)

os.makedirs(a.out, exist_ok=True)
canvas = int(a.size * 1.6)  # room for overshoot + rotation
n = int(a.dur * a.fps)
for i in range(n):
    t = i / a.fps
    # scale: 0 -> 1.25 (overshoot) -> 1.0, elastic pop in the first 0.25s
    if t < 0.12:
        s = 1.25 * (t / 0.12)
    elif t < 0.25:
        s = 1.25 - 0.25 * ((t - 0.12) / 0.13)
    else:
        s = 1.0 + 0.04 * math.sin(2 * math.pi * 3 * t)  # breathing
    ang = 12 * math.sin(2 * math.pi * 2.2 * t) * max(0.0, 1 - t / a.dur)  # wiggle that settles
    lift = -18 * abs(math.sin(2 * math.pi * 1.6 * t)) if t > 0.25 else 0  # small bounce
    alpha = 1.0 if t < a.dur - 0.25 else max(0.0, (a.dur - t) / 0.25)
    if t >= a.dur - 0.25:
        s *= 1 + 0.3 * (1 - alpha)  # grows while fading out
    sz = max(2, int(a.size * s))
    g = glyph.resize((sz, sz), Image.LANCZOS).rotate(ang, resample=Image.BICUBIC, expand=True)
    if alpha < 1:
        g.putalpha(g.getchannel("A").point(lambda v: int(v * alpha)))
    frame = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    frame.alpha_composite(g, ((canvas - g.width) // 2, (canvas - g.height) // 2 + int(lift)))
    frame.save(os.path.join(a.out, "%03d.png" % i))
print(n)
