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
ap.add_argument("--context", default="", help="title/topic words that help recognition (names, game terms)")
a = ap.parse_args()

import wave
import numpy as np
from faster_whisper import WhisperModel

# The caller hands us a 16 kHz mono WAV made by ffmpeg. Load it ourselves instead of letting faster-whisper decode it
# with PyAV: newer PyAV releases dropped an argument faster-whisper passes ("metadata_errors") and decoding fails.
def load_audio(path):
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit("expected 16 kHz mono 16-bit wav")
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0

model = WhisperModel(a.model, device="cpu", compute_type="int8")
opts = dict(word_timestamps=True, vad_filter=True, beam_size=5,  # vad: skip game noise / music with no speech
            vad_parameters=dict(min_silence_duration_ms=300), condition_on_previous_text=False,
            initial_prompt=(a.context[:200] or None))
audio = load_audio(a.media)
segments, info = model.transcribe(audio, language=None if a.lang == "auto" else a.lang, **opts)
task = "transcribe"
if a.to == "en" and info.language != "en":
    # Whisper's built-in speech -> English translation
    segments, _ = model.transcribe(audio, language=info.language, task="translate", **opts)
    task = "translate"
words = []
for seg in segments:
    if seg.no_speech_prob > 0.85:
        continue
    for w in seg.words or []:
        t = w.word.strip()
        if t and w.probability > 0.02:
            words.append({"start": round(w.start, 2), "end": round(w.end, 2), "word": t})
# exact speech ranges (Silero VAD, bundled with faster-whisper): where someone is talking, to the millisecond
speech = []
try:
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    for r in get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=280, speech_pad_ms=80, min_speech_duration_ms=180)):
        speech.append([round(r["start"] / 16000, 2), round(r["end"] / 16000, 2)])
except Exception:
    pass
json.dump({"language": info.language, "task": task, "words": words, "speech": speech}, sys.stdout, ensure_ascii=False)
