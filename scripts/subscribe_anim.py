#!/usr/bin/env python3
"""Animated "subscribe" end card (like the classic green-screen ones, but drawn here and transparent):
button pops in -> cursor clicks it -> SUBSCRIBED -> cursor clicks the bell -> bell rings -> fade out.
usage: subscribe_anim.py <out_dir> --text SUBSCRIBE --done SUBSCRIBED --channel "Name" [--logo logo.png] [--font Bold.ttf]
writes 000.png… (RGBA, 1000x420, 30 fps) and prints JSON {"frames":N,"fps":30,"clicks":[t1,t2],"w":1000,"h":420}"""
import argparse, json, math, os
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("out"); ap.add_argument("--text", default="SUBSCRIBE"); ap.add_argument("--done", default="SUBSCRIBED")
ap.add_argument("--channel", default=""); ap.add_argument("--logo", default="")
ap.add_argument("--font", default="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
ap.add_argument("--emoji-font", default=os.environ.get("EMOJI_FONT", "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"))
a = ap.parse_args()

W, H, FPS, D = 1000, 420, 30, 3.4
CLICK1, CLICK2 = 1.15, 2.0
os.makedirs(a.out, exist_ok=True)
font = lambda size: ImageFont.truetype(a.font, size)
ease = lambda t: 1 - (1 - max(0, min(1, t))) ** 3

# --- pieces ------------------------------------------------------------------------------------------------
def button(text, color):
    f = font(54); tw = f.getbbox(text)[2]
    bw, bh = max(430, tw + 110), 128
    im = Image.new("RGBA", (bw + 16, bh + 16), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((8, 14, bw + 8, bh + 14), 22, fill=(0, 0, 0, 90))            # shadow
    d.rounded_rectangle((8, 8, bw + 8, bh + 8), 22, fill=color)
    d.text(((bw + 16 - tw) / 2, 8 + (bh - 62) / 2), text, font=f, fill="white")
    return im

def bell(filled):
    s = 112
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.ellipse((0, 0, s - 1, s - 1), fill=(255, 255, 255, 255) if filled else (40, 40, 40, 235), outline=(255, 255, 255, 255), width=4)
    try:
        ef = ImageFont.truetype(a.emoji_font, 109)
        g = Image.new("RGBA", (140, 140), (0, 0, 0, 0)); ImageDraw.Draw(g).text((10, 10), "🔔", font=ef, embedded_color=True)
        g = g.crop(g.getbbox()).resize((66, 66), Image.LANCZOS)
        im.alpha_composite(g, ((s - 66) // 2, (s - 66) // 2))
    except Exception:
        d.text((s / 2 - 18, s / 2 - 30), "!", font=font(56), fill="black" if filled else "white")
    return im

def cursor():
    pts = [(0, 0), (0, 64), (16, 49), (28, 76), (40, 71), (28, 45), (50, 45)]
    im = Image.new("RGBA", (64, 90), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.polygon([(x + 6, y + 6) for x, y in pts], fill=(0, 0, 0, 110))
    d.polygon(pts, fill="white", outline="black"); d.line(pts + [pts[0]], fill="black", width=3)
    return im

def avatar():
    if not a.logo or not os.path.exists(a.logo): return None
    s = 84; lg = Image.open(a.logo).convert("RGBA").resize((s, s), Image.LANCZOS)
    m = Image.new("L", (s, s), 0); ImageDraw.Draw(m).ellipse((0, 0, s - 1, s - 1), fill=255)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0)); out.paste(lg, (0, 0), m); return out

btn_red, btn_gray = button(a.text, (230, 33, 23, 255)), button(a.done + "  ✓", (90, 90, 90, 255))
bell_off, bell_on, cur, av = bell(False), bell(True), cursor(), avatar()
gap = 26
row_w = max(btn_red.width, btn_gray.width) + gap + bell_off.width
bx, by = (W - row_w) // 2, 150                 # button top-left
bellx, belly = bx + max(btn_red.width, btn_gray.width) + gap, by + (btn_red.height - bell_off.height) // 2
btn_c = (bx + btn_red.width / 2, by + btn_red.height / 2)
bell_c = (bellx + bell_off.width / 2, belly + bell_off.height / 2)

def name_strip():
    if not a.channel: return None
    f = font(46); tw = f.getbbox(a.channel)[2]
    w = tw + (av.width + 18 if av else 0)
    im = Image.new("RGBA", (w + 8, 96), (0, 0, 0, 0)); d = ImageDraw.Draw(im); x = 0
    if av: im.alpha_composite(av, (0, 6)); x = av.width + 18
    d.text((x + 3, 27), a.channel, font=f, fill=(0, 0, 0, 160)); d.text((x, 24), a.channel, font=f, fill="white")
    return im
strip = name_strip()

def path(t, p0, p1, t0, t1):
    k = ease((t - t0) / (t1 - t0)); return (p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k)

n = int(D * FPS)
for i in range(n):
    t = i / FPS
    fr = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    # pop-in of the whole card
    pop = 1.0 if t > 0.32 else (0.6 + 0.55 * ease(t / 0.22) if t < 0.22 else 1.15 - 0.15 * ease((t - 0.22) / 0.1))
    alpha = min(1.0, t / 0.15) * (1.0 if t < D - 0.45 else max(0.0, (D - t) / 0.45))
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if strip: card.alpha_composite(strip, ((W - strip.width) // 2, 34))
    pressed = CLICK1 <= t < CLICK1 + 0.12
    b = btn_gray if t >= CLICK1 + 0.06 else btn_red
    if pressed: b = b.resize((int(b.width * 0.94), int(b.height * 0.94)), Image.LANCZOS)
    card.alpha_composite(b, (int(btn_c[0] - b.width / 2), int(btn_c[1] - b.height / 2)))
    bl = bell_on if t >= CLICK2 + 0.05 else bell_off
    if t >= CLICK2 + 0.05:  # ring: decaying wobble
        ang = 22 * math.sin((t - CLICK2) * 2 * math.pi * 3.2) * max(0.0, 1 - (t - CLICK2) / 0.9)
        bl = bl.rotate(ang, resample=Image.BICUBIC, expand=False)
    card.alpha_composite(bl, (bellx, belly))
    if pop != 1.0:
        cw, ch = int(W * pop), int(H * pop)
        sc = card.resize((cw, ch), Image.LANCZOS); card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        card.alpha_composite(sc.crop((max(0, (cw - W) // 2), max(0, (ch - H) // 2), max(0, (cw - W) // 2) + min(W, cw), max(0, (ch - H) // 2) + min(H, ch))),
                             (max(0, (W - cw) // 2), max(0, (H - ch) // 2)))
    fr.alpha_composite(card)
    # cursor: in from the bottom-right, click the button, move to the bell, click, leave
    if 0.45 <= t < D - 0.3:
        if t < CLICK1: p = path(t, (W + 40, H + 40), (btn_c[0] + 20, btn_c[1] + 10), 0.45, CLICK1 - 0.05)
        elif t < 1.55: p = (btn_c[0] + 20, btn_c[1] + 10)
        elif t < CLICK2: p = path(t, (btn_c[0] + 20, btn_c[1] + 10), (bell_c[0] + 8, bell_c[1] + 10), 1.55, CLICK2 - 0.05)
        else: p = path(t, (bell_c[0] + 8, bell_c[1] + 10), (W + 60, bell_c[1] + 120), CLICK2 + 0.35, D - 0.3)
        c = cur.resize((54, 76), Image.LANCZOS) if (CLICK1 <= t < CLICK1 + 0.12 or CLICK2 <= t < CLICK2 + 0.12) else cur
        fr.alpha_composite(c, (int(p[0]), int(p[1])))
    if alpha < 1:
        fr.putalpha(fr.getchannel("A").point(lambda v: int(v * alpha)))
    fr.save(os.path.join(a.out, "%03d.png" % i))
print(json.dumps({"frames": n, "fps": FPS, "clicks": [CLICK1, CLICK2], "w": W, "h": H}))
