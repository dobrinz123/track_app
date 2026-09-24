"""Voice-over with per-word timings, one audio file per scene.

Engines (voices.<lang>.engine in config.yaml):
- edge (default): free Microsoft neural voices via edge-tts; timings from WordBoundary events.
- kokoro / piper / chatterbox: local neural models, each in its own venv under voice-lab/
  (torch never enters this process). Timings come from faster-whisper, aligned back onto the
  script's own words so captions show exactly what was written.
Each scene is synthesised separately so a scene's on-screen duration is exactly its audio length.
"""
from __future__ import annotations

import asyncio
import difflib
import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

TICKS = 10_000_000  # edge-tts offsets are in 100 ns units


@dataclass
class Word:
    text: str
    start: float
    end: float


async def _synth(text: str, voice: str, rate: str, mp3: Path) -> list[Word]:
    import edge_tts

    com = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    words: list[Word] = []
    with mp3.open("wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / TICKS
                words.append(Word(chunk["text"], start, start + chunk["duration"] / TICKS))
    return words


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True).stdout
    return float(json.loads(out)["format"]["duration"])


_whisper = None


def _whisper_words(mp3: Path, lang: str) -> list[Word]:
    global _whisper
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return []
    if _whisper is None:
        _whisper = WhisperModel("small", device="cpu", compute_type="int8")
    segments, _ = _whisper.transcribe(str(mp3), language=lang, word_timestamps=True)
    return [Word(w.word.strip(), w.start, w.end) for s in segments for w in (s.words or [])]


def _even_words(text: str, duration: float) -> list[Word]:
    toks = text.split()
    step = duration / max(1, len(toks))
    return [Word(t, i * step, (i + 1) * step) for i, t in enumerate(toks)]


def _norm(w: str) -> str:
    return re.sub(r"[^a-z0-9]", "", w.lower())


def align_to_script(text: str, heard: list[Word], duration: float) -> list[Word]:
    """Give each word of the script a time, taken from the matching recognised word.

    Recognition may split or respell words (MotorPark -> Motor Park); unmatched script words are
    interpolated between their matched neighbours, so every written word gets a timing.
    """
    script = text.split()
    if not heard:
        return _even_words(text, duration)
    sm = difflib.SequenceMatcher(a=[_norm(w) for w in script], b=[_norm(h.text) for h in heard], autojunk=False)
    times: list = [None] * len(script)
    for block in sm.get_matching_blocks():
        for k in range(block.size):
            h = heard[block.b + k]
            times[block.a + k] = (h.start, h.end)
    i = 0
    while i < len(script):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(script) and times[j] is None:
            j += 1
        t0 = times[i - 1][1] if i > 0 else 0.0
        t1 = times[j][0] if j < len(script) else duration
        step = max(0.0, t1 - t0) / (j - i)
        for k in range(i, j):
            times[k] = (t0 + (k - i) * step, t0 + (k - i + 1) * step)
        i = j
    return [Word(w, a, b) for w, (a, b) in zip(script, times)]


VENVS = {"kokoro": "voice-lab/.venv", "piper": "voice-lab/.venv", "chatterbox": "voice-lab/.venv-cb"}
ENGINE_ROOT = Path(__file__).resolve().parents[1]


def _local_batch(texts: list[str], voice_cfg: dict, out_dir: Path) -> list[Path]:
    engine = voice_cfg["engine"]
    py = ENGINE_ROOT / VENVS[engine] / "Scripts" / "python.exe"
    if not py.exists():
        raise RuntimeError(f"voice engine '{engine}' is not installed ({py} missing); see voice-lab/README.md")
    with tempfile.TemporaryDirectory() as tmp:
        tj = Path(tmp) / "texts.json"
        tj.write_text(json.dumps(texts, ensure_ascii=False), encoding="utf-8")
        proc = subprocess.run([str(py), str(ENGINE_ROOT / "voice-lab/synth.py"), "--engine", engine,
                               "--voice", voice_cfg["voice"], "--speed", str(voice_cfg.get("speed", 1.0)),
                               "--texts-json", str(tj), "--out-dir", str(out_dir)],
                              capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            raise RuntimeError(f"{engine} synthesis failed: {proc.stderr[-800:]}")
    return [out_dir / f"{i:02d}.wav" for i in range(len(texts))]


def synthesize_scenes(texts: list[str], lang: str, voice_cfg: dict, out_dir: Path) -> list[tuple[Path, float, list[Word]]]:
    """One audio file per scene: [(path, duration_s, words_with_times)]."""
    out_dir.mkdir(parents=True, exist_ok=True)
    engine = voice_cfg.get("engine", "edge")
    results = []
    if engine == "edge":
        for i, text in enumerate(texts):
            mp3 = out_dir / f"voice_{i:02d}.mp3"
            words = asyncio.run(_synth(text, voice_cfg["voice"], voice_cfg.get("rate", "+0%"), mp3))
            duration = probe_duration(mp3)
            if not words:
                words = align_to_script(text, _whisper_words(mp3, lang), duration)
            results.append((mp3, duration, words))
        return results
    for text, wav in zip(texts, _local_batch(texts, voice_cfg, out_dir)):
        duration = probe_duration(wav)
        results.append((wav, duration, align_to_script(text, _whisper_words(wav, lang), duration)))
    return results


def synthesize(text: str, lang: str, voice_cfg: dict, mp3: Path) -> tuple[float, list[Word]]:
    """Single edge-tts utterance (kept for quick checks)."""
    words = asyncio.run(_synth(text, voice_cfg["voice"], voice_cfg.get("rate", "+0%"), mp3))
    duration = probe_duration(mp3)
    if not words:
        words = _whisper_words(mp3, lang) or _even_words(text, duration)
    return duration, words
