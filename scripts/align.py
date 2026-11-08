#!/usr/bin/env python3
"""Forced alignment: KNOWN text -> exact word times in the audio, with Whisper's own aligner (cross-attention + DTW).
Recognition is not used at all here: the correct text (written by the AI) is laid onto the audio, so every word gets
the moment it is actually spoken.
usage: align.py <16k mono wav> <segments.json> [--model large-v3-turbo] [--lang uz]
segments.json: [{"a": 1.20, "b": 3.85, "text": "salom do'stlar"}, ...]  (speech ranges in seconds)
prints JSON: {"words": [{"word": "salom", "start": 1.31, "end": 1.62, "seg": 0}, ...]}"""
import argparse, json, sys, wave
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import pad_or_trim
from faster_whisper.tokenizer import Tokenizer

ap = argparse.ArgumentParser()
ap.add_argument("media"); ap.add_argument("segments")
ap.add_argument("--model", default="large-v3-turbo"); ap.add_argument("--lang", default="uz")
a = ap.parse_args()

with wave.open(a.media, "rb") as w:
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
SR = 16000
segs = [s for s in json.load(open(a.segments)) if str(s.get("text", "")).strip()]
model = WhisperModel(a.model, device="cpu", compute_type="int8")
lang = a.lang if a.lang in ("uz", "ru", "en", "tr", "kk", "de", "es") else None
tok = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language=lang or "en")
fe = model.feature_extractor

# windows of <= 28 s (Whisper sees 30 s at a time), made of whole speech ranges
windows, cur = [], []
for i, s in enumerate(segs):
    if cur and s["b"] + 0.3 - (segs[cur[0]]["a"] - 0.3) > 28:
        windows.append(cur); cur = []
    cur.append(i)
if cur: windows.append(cur)

out = []
for win in windows:
    t0 = max(0.0, segs[win[0]]["a"] - 0.3)
    t1 = min(len(audio) / SR, max(segs[i]["b"] for i in win) + 0.3, t0 + 29.5)
    chunk = audio[int(t0 * SR):int(t1 * SR)]
    if len(chunk) < SR * 0.2: continue
    feats = fe(chunk)
    num_frames = feats.shape[-1]
    enc = model.encode(pad_or_trim(feats)[None] if feats.ndim == 2 else pad_or_trim(feats))
    # the words of the window, each remembering its range
    words = []
    for i in win:
        for wd in str(segs[i]["text"]).split():
            words.append((wd, i))
    text = " " + " ".join(w for w, _ in words)
    tokens = tok.encode(text)
    try:
        res = model.find_alignment(tok, [tokens], enc, num_frames)[0]
    except Exception as e:
        print(f"align failed: {e}", file=sys.stderr); continue
    # Whisper's word split -> our words, by character position
    bounds, pos = [], 0
    for wd, i in words:
        st = text.index(wd, pos); bounds.append((st, st + len(wd), i, wd)); pos = st + len(wd)
    acc, wi = 0, 0
    starts = [None] * len(words); ends = [None] * len(words)
    for r in res:
        c0, c1 = acc, acc + len(r["word"]); acc = c1
        for k in range(len(words)):
            s0, s1, _, _ = bounds[k]
            if s0 < c1 and s1 > c0:  # overlap
                if starts[k] is None: starts[k] = t0 + float(r["start"])
                ends[k] = t0 + float(r["end"])
    for k, (s0, s1, i, wd) in enumerate(bounds):
        if starts[k] is None: continue
        out.append({"word": wd, "start": round(starts[k], 3), "end": round(ends[k], 3), "seg": i})
json.dump({"words": out}, sys.stdout, ensure_ascii=False)
