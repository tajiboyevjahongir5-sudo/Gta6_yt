#!/usr/bin/env python3
"""Precise forced alignment with Meta's MMS aligner (wav2vec2 CTC, 1100+ languages, Uzbek included; torchaudio MMS_FA).
Each LETTER of the known text is matched to 20 ms audio frames, so every word gets the exact moment it is spoken.
usage: mms_align.py <16k mono wav> <words.json> [model cache dir]
words.json: ["salom", "do'stlar,", ...]  (the whole clip's text, in order)
prints JSON: {"spans": [[start, end] | null, ...]}  (one per input word; null = nothing alignable, e.g. a number)"""
import json, os, sys, wave
if len(sys.argv) > 3: os.environ["TORCH_HOME"] = sys.argv[3]  # model cache on the data volume (downloaded once)
import numpy as np
import torch, torchaudio

CYR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюяўқғҳ",
               ["a", "b", "v", "g", "d", "e", "yo", "j", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "x", "s",
                "ch", "sh", "sh", "", "i", "", "e", "yu", "ya", "o", "q", "g", "h"]))
TR = {"ş": "sh", "ç": "ch", "ğ": "g", "ı": "i", "ö": "o", "ü": "u", "ä": "a", "é": "e", "ʻ": "'", "ʼ": "'", "‘": "'", "’": "'", "`": "'"}

wav_path, words_path = sys.argv[1], sys.argv[2]
with wave.open(wav_path, "rb") as w:
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
words = json.load(open(words_path))

bundle = torchaudio.pipelines.MMS_FA
model = bundle.get_model(with_star=False)
labels = set(bundle.get_dict(star=None).keys())
tokenizer, aligner = bundle.get_tokenizer(), bundle.get_aligner()

def norm(w):
    s = "".join(CYR.get(c, TR.get(c, c)) for c in w.lower())
    return "".join(c for c in s if c in labels and c != "-")

keep = [(i, norm(w)) for i, w in enumerate(words)]
keep = [(i, n) for i, n in keep if n.strip("'")]
spans = [None] * len(words)
if keep:
    wave_t = torch.from_numpy(audio).unsqueeze(0)
    with torch.inference_mode():
        emission, _ = model(wave_t)
    token_spans = aligner(emission[0], tokenizer([n for _, n in keep]))
    ratio = wave_t.size(1) / emission.size(1) / 16000
    for (i, _), ts in zip(keep, token_spans):
        if ts:
            spans[i] = [round(ts[0].start * ratio, 3), round(ts[-1].end * ratio, 3)]
json.dump({"spans": spans}, sys.stdout)
