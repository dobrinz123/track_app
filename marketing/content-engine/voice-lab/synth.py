"""Local neural TTS worker. Runs INSIDE the model's own venv (see voice-lab/README.md) and writes WAV files.

  <venv>/python synth.py --engine kokoro --voice am_michael --texts-json scenes.json --out-dir dir/
  -> dir/00.wav, dir/01.wav, ... one per text; the model is loaded once for all of them.

Kept dependency-free on the engine side so the main pipeline (system Python) never imports torch.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import soundfile as sf


def chunks(text: str, max_words: int) -> list[str]:
    out, cur = [], ""
    for s in re.split(r"(?<=[.!?])\s+", text.strip()):
        if cur and len((cur + " " + s).split()) > max_words:
            out.append(cur)
            cur = s
        else:
            cur = (cur + " " + s).strip()
    if cur:
        out.append(cur)
    return out


def kokoro(voice: str, speed: float):
    from kokoro import KPipeline

    pipe = KPipeline(lang_code="b" if voice.startswith("b") else "a", repo_id="hexgrad/Kokoro-82M")

    def say(text):
        return np.concatenate([np.asarray(a) for _, _, a in pipe(text, voice=voice, speed=speed)]), 24000
    return say


def chatterbox(voice: str, speed: float):
    import torch

    if voice == "turbo":
        from chatterbox.tts_turbo import ChatterboxTurboTTS as M
        model, kw = M.from_pretrained(device="cuda"), {}
    else:
        from chatterbox.tts import ChatterboxTTS as M
        model = M.from_pretrained(device="cuda")
        kw = {"exaggeration": 0.35, "cfg_weight": 0.4} if voice == "calm" else {}
    gap = np.zeros(int(model.sr * 0.15), dtype=np.float32)

    def say(text):
        torch.manual_seed(7)  # same seed per call keeps the delivery consistent across scenes
        parts = []
        for c in chunks(text, 28):  # Chatterbox is tuned for short utterances
            parts += [model.generate(c, **kw).squeeze(0).cpu().numpy(), gap]
        return np.concatenate(parts[:-1]), model.sr
    return say


def piper(voice: str, speed: float):
    """voice = "<model file stem>:<speaker id>", e.g. "en_GB-vctk-medium:20" (model in voice-lab/models/)."""
    from piper import PiperVoice
    from piper.config import SynthesisConfig

    stem, _, spk = voice.partition(":")
    model = PiperVoice.load(str(Path(__file__).resolve().parent / "models" / f"{stem}.onnx"))
    cfg = SynthesisConfig(speaker_id=int(spk) if spk else None, length_scale=1.0 / speed)

    def say(text):
        parts = [c.audio_float_array for c in model.synthesize(text, syn_config=cfg)]
        return np.concatenate(parts), model.config.sample_rate
    return say


ENGINES = {"kokoro": kokoro, "chatterbox": chatterbox, "piper": piper}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=ENGINES)
    ap.add_argument("--voice", required=True)
    ap.add_argument("--texts-json", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--speed", type=float, default=1.0)
    a = ap.parse_args()
    texts = json.load(open(a.texts_json, encoding="utf-8"))
    say = ENGINES[a.engine](a.voice, a.speed)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for i, text in enumerate(texts):
        audio, sr = say(text)
        sf.write(out / f"{i:02d}.wav", audio, sr)


if __name__ == "__main__":
    main()
