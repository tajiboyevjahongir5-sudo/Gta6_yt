#!/usr/bin/env python3
"""Find a streamer's webcam overlay in a gameplay video.
A webcam shows the same face at (almost) the same place and size in most frames; faces in the game move around.
usage: facecam.py <video> [--samples 24]
prints JSON: {"found": true, "x":..,"y":..,"w":..,"h":.., "face": [x,y,w,h], "hits": 17, "samples": 24, "width": W, "height": H}
(x,y,w,h = the region to show as the webcam, in source pixels)"""
import argparse, json, sys
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("video"); ap.add_argument("--samples", type=int, default=24)
a = ap.parse_args()

cap = cv2.VideoCapture(a.video)
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
cascades = [cv2.CascadeClassifier(cv2.data.haarcascades + f) for f in
            ("haarcascade_frontalface_default.xml", "haarcascade_frontalface_alt2.xml")]

faces = []  # (frame index, x, y, w, h)
used = 0
edge_sum = None  # how often each pixel is an edge: the overlay's frame lines are edges in every frame, game edges move
v_sum = v_sq = None   # temporal variance: gameplay changes all the time, the webcam's room doesn't
gx_sum = gy_sum = None  # mean |gradient|: where webcam meets gameplay the picture "jumps" at the same place in every frame
ES = 0.5         # edge map scale
for k in range(a.samples):
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(n * (0.04 + 0.92 * k / max(1, a.samples - 1))))
    ok, frame = cap.read()
    if not ok:
        continue
    used += 1
    scale = 720 / H if H > 720 else 1.0  # detect on <=720p for speed
    small = cv2.resize(frame, None, fx=scale, fy=scale) if scale != 1.0 else frame
    gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
    found = []
    for c in cascades:
        found = c.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(int(0.04 * gray.shape[0]),) * 2)
        if len(found):
            break
    for (x, y, w, h) in found:
        faces.append((k, x / scale, y / scale, w / scale, h / scale))
    # edges in every colour channel: a purple frame on green gameplay has almost the same brightness,
    # so it's invisible in grey but clear in the red/blue channels
    sm = cv2.resize(frame, None, fx=ES, fy=ES)
    e = np.zeros(sm.shape[:2], np.uint8)
    for ch in cv2.split(sm): e |= cv2.Canny(ch, 50, 140)
    e = e.astype(np.float32) / 255
    edge_sum = e if edge_sum is None else edge_sum + e
    g = cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY).astype(np.float32)
    c3 = sm.astype(np.float32)
    dx, dy = np.abs(np.diff(c3, axis=1)).max(axis=2), np.abs(np.diff(c3, axis=0)).max(axis=2)
    dx = np.pad(dx, ((0, 0), (0, 1))); dy = np.pad(dy, ((0, 1), (0, 0)))
    gx_sum = dx if gx_sum is None else gx_sum + dx
    v_sum = g if v_sum is None else v_sum + g
    v_sq = g * g if v_sq is None else v_sq + g * g
    gy_sum = dy if gy_sum is None else gy_sum + dy

def out(obj):
    print(json.dumps(obj)); sys.exit(0)

if used < 4 or not faces:
    out({"found": False, "samples": used, "width": W, "height": H})

# cluster: faces whose centre and size agree across frames
best, best_hits = None, 0
for f in faces:
    cx, cy, s = f[1] + f[3] / 2, f[2] + f[4] / 2, f[3]
    frames = {g[0] for g in faces
              if abs(g[1] + g[3] / 2 - cx) < 0.05 * W and abs(g[2] + g[4] / 2 - cy) < 0.05 * H and 0.7 < g[3] / s < 1.4}
    if len(frames) > best_hits:
        best_hits, best = len(frames), f
if best_hits < max(3, 0.35 * used):
    out({"found": False, "reason": "no steady face", "hits": best_hits, "samples": used, "width": W, "height": H})

# median face box of the cluster
cx0, cy0, s0 = best[1] + best[3] / 2, best[2] + best[4] / 2, best[3]
cl = [g for g in faces if abs(g[1] + g[3] / 2 - cx0) < 0.05 * W and abs(g[2] + g[4] / 2 - cy0) < 0.05 * H and 0.7 < g[3] / s0 < 1.4]
med = lambda i: sorted(g[i] for g in cl)[len(cl) // 2]
fx, fy, fw, fh = med(1), med(2), med(3), med(4)

# the whole video is a webcam (face is huge): no split layout
if fh > 0.38 * H:
    out({"found": False, "reason": "face fills the frame", "hits": best_hits, "samples": used, "width": W, "height": H})

# webcam overlay ≈ face with shoulders and some room: ~3.4 face widths wide, ~2.6 face heights tall, face a bit above centre
bw, bh = fw * 2.7, fh * 2.3
x, y = fx + fw / 2 - bw / 2, fy + fh * 0.45 - bh * 0.42
# refine with the overlay's own border: a line that is an edge in most frames, just outside the face
if edge_sum is not None:
    stable = edge_sum / used                      # 0..1, fraction of frames where the pixel is an edge
    eh, ew = stable.shape
    gx_avg, gy_avg = gx_sum / used, gy_sum / used
    tstd = np.sqrt(np.maximum(v_sq / used - (v_sum / used) ** 2, 0))  # how much each pixel changes over time
    def contrast(axis, pos, outward, a0, a1):
        # a real border has busy gameplay on the outer side; a line inside the webcam has calm room on both sides
        p = int(pos * ES); k0, k1 = 3, 18
        if axis == 'x':
            o = tstd[a0:a1, max(0, p + k0 * outward if outward > 0 else p - k1):max(0, p + k1 if outward > 0 else p - k0)]
            i = tstd[a0:a1, max(0, p - k1 if outward > 0 else p + k0):max(0, p - k0 if outward > 0 else p + k1)]
        else:
            o = tstd[max(0, p + k0 if outward > 0 else p - k1):max(0, p + k1 if outward > 0 else p - k0), a0:a1]
            i = tstd[max(0, p - k1 if outward > 0 else p + k0):max(0, p - k0 if outward > 0 else p + k1), a0:a1]
        if not o.size or not i.size: return False
        return float(o.mean()) > 1.5 * float(i.mean()) + 2
    def line(axis, lo, hi, a0, a1, near_hi):
        # border between lo..hi (source px), measured along a0..a1 on the other axis. Candidates: drawn frame lines
        # (edge in most frames) and soft borders (average brightness jump); keep those with busy gameplay outside,
        # nearest to the face first.
        lo, hi = int(max(0, lo) * ES), int(min((W if axis == 'x' else H), hi) * ES)
        a0, a1 = int(max(0, a0) * ES), int(a1 * ES)
        if hi - lo < 3 or a1 - a0 < 4: return None
        prof = stable[a0:min(a1, eh), lo:hi].mean(axis=0) if axis == 'x' else stable[lo:hi, a0:min(a1, ew)].mean(axis=1)
        grad = gx_avg[a0:min(a1, eh), lo:hi].mean(axis=0) if axis == 'x' else gy_avg[lo:hi, a0:min(a1, ew)].mean(axis=1)
        base = float(np.median(grad)) + 1e-3
        cand = sorted(set(np.nonzero(prof > 0.45)[0].tolist()) | set(np.nonzero((grad > 3.0 * base) & (grad > 12))[0].tolist()),
                      reverse=near_hi)
        outward = -1 if near_hi else 1          # L/T: gameplay is on the lower side, R/B: on the higher side
        for c in cand:
            # a strong unbroken line (a drawn webcam frame, e.g. a coloured border) is the border even when the
            # gameplay next to it is calm; weaker lines must have busy gameplay on their outer side
            if prof[c] >= 0.6 or contrast(axis, (lo + c) / ES, outward, a0, min(a1, eh if axis == 'x' else ew)): return (lo + c) / ES
        return None
    fy0, fy1, fx0, fx1 = fy - fh * 0.3, fy + fh * 1.3, fx - fw * 0.3, fx + fw * 1.3
    L = line('x', fx - fw * 3.0, fx - fw * 0.25, fy0, fy1, True)
    R = line('x', fx + fw * 1.25, fx + fw * 4.0, fy0, fy1, False)
    T = line('y', fy - fh * 2.0, fy - fh * 0.15, fx0, fx1, True)
    B = line('y', fy + fh * 1.15, fy + fh * 3.0, fx0, fx1, False)
    pad = 2 / ES  # stay just inside the border line
    if L is not None: bw -= (L + pad) - x; x = L + pad
    if R is not None: bw = (R - pad) - x
    if T is not None: bh -= (T + pad) - y; y = T + pad
    if B is not None: bh = (B - pad) - y
    refined = [v is not None for v in (L, R, T, B)]
else:
    refined = [False] * 4

# overlays sit in corners/edges: snap to the frame edge when close
snap = 0.06
if not refined[0] and x < snap * W: bw += x; x = 0
if not refined[2] and y < snap * H: bh += y; y = 0
if not refined[1] and W - (x + bw) < snap * W: bw = W - x
if not refined[3] and H - (y + bh) < snap * H: bh = H - y
x, y = max(0, x), max(0, y)
bw, bh = min(bw, W - x), min(bh, H - y)
out({"found": True, "x": int(x), "y": int(y), "w": int(bw), "h": int(bh), "face": [int(fx), int(fy), int(fw), int(fh)],
     "border": refined, "hits": best_hits, "samples": used, "width": W, "height": H})
