#!/usr/bin/env python3
"""Speech -> word timestamps for Shorts subtitles (faster-whisper, runs on CPU).
usage: transcribe.py <media> [--model small] [--lang uz|ru|en|auto] [--to en]
--to en: if the speech is not English, Whisper translates it to English (timestamps stay on the audio)
prints JSON: {"language": "uz", "words": [{"start": 0.1, "end": 0.4, "word": "salom"}, ...]}"""
import argparse, json, sys

ap = argparse.ArgumentParser()
ap.add_argument("media")
ap.add_argument("--model", default="small")
ap.add_argument("--lang", default="auto")
ap.add_argument("--to", default="")
a = ap.parse_args()

from faster_whisper import WhisperModel

model = WhisperModel(a.model, device="cpu", compute_type="int8")
opts = dict(word_timestamps=True, vad_filter=True, beam_size=5)  # vad: skip game noise / music with no speech
segments, info = model.transcribe(a.media, language=None if a.lang == "auto" else a.lang, **opts)
task = "transcribe"
if a.to == "en" and info.language != "en":
    # Whisper's built-in speech -> English translation
    segments, _ = model.transcribe(a.media, language=info.language, task="translate", **opts)
    task = "translate"
words = []
for seg in segments:
    if seg.no_speech_prob > 0.6:
        continue
    for w in seg.words or []:
        t = w.word.strip()
        if t and w.probability > 0.2:
            words.append({"start": round(w.start, 2), "end": round(w.end, 2), "word": t})
json.dump({"language": info.language, "task": task, "words": words}, sys.stdout, ensure_ascii=False)
