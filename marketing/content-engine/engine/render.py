"""Script -> finished vertical MP4 (voice, karaoke captions, optional music bed, thumbnail)."""
from __future__ import annotations

import json
import random
import shutil
import subprocess
from pathlib import Path

from .captions import build_ass
from .tts import Word, synthesize_scenes
from .visuals import Renderer

GAP = 0.18  # breath between scenes, seconds


def _credits(music_dir: Path) -> dict:
    f = music_dir / "credits.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def pick_track(music_dir: Path) -> Path | None:
    """Random bed, never the same track twice in a row (last pick remembered in the folder)."""
    tracks = sorted(music_dir.glob("*.mp3"))
    if not tracks:
        return None
    last_file = music_dir / ".last_pick"
    last = last_file.read_text(encoding="utf-8").strip() if last_file.exists() else ""
    choices = [t for t in tracks if t.name != last] or tracks
    track = random.choice(choices)
    last_file.write_text(track.name, encoding="utf-8")
    return track


def render_video(script: dict, lang: str, circuit_id: str | None, cfg: dict, repo_root: Path,
                 out_dir: Path, engine_root: Path) -> Path:
    vcfg = cfg["video"]
    W, H, FPS = vcfg["width"], vcfg["height"], vcfg["fps"]
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. voice per scene -> exact scene lengths and absolute word timings
    all_words: list[Word] = []
    durations: list[float] = []
    clips: list[Path] = []
    t0 = 0.0
    voiced = synthesize_scenes([sc["voice"] for sc in script["scenes"]], lang, cfg["voices"][lang],
                               out_dir / "voice_parts")
    for clip, dur, words in voiced:
        dur += GAP
        all_words += [Word(w.text, w.start + t0, w.end + t0) for w in words]
        durations.append(dur)
        clips.append(clip)
        t0 += dur
    total = t0

    # 2. one continuous voice track with the per-scene gaps baked in
    inputs, pads = [], []
    for i, (clip, dur) in enumerate(zip(clips, durations)):
        inputs += ["-i", str(clip)]
        pads.append(f"[{i}:a]apad,atrim=0:{dur:.3f}[a{i}]")
    concat = "".join(f"[a{i}]" for i in range(len(clips)))
    # loudnorm: engines differ a lot in level (Piper is quiet, edge is hot); -16 LUFS is the shorts norm
    fc = ";".join(pads) + f";{concat}concat=n={len(clips)}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", fc, "-map", "[out]",
                    "-ar", "48000", "voice.wav"], cwd=out_dir, check=True)

    # 3. captions
    (out_dir / "captions.ass").write_text(build_ass(all_words, W, H), encoding="utf-8")

    # 4. frames piped straight into the encoder (no temp PNGs on disk)
    music_dir = engine_root / vcfg.get("music_dir", "assets/music")
    track = pick_track(music_dir)
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-", "-i", "voice.wav"]
    (out_dir / "music.json").unlink(missing_ok=True)
    if track:
        cmd += ["-stream_loop", "-1", "-i", str(track)]
        # Level the bed on its own (tracks differ by 10+ dB), then sit it well under the -16 LUFS voice.
        audio = (f"[2:a]loudnorm=I={vcfg.get('music_lufs', -31)}:TP=-3,afade=t=in:d=0.8,"
                 f"afade=t=out:st={max(0, total - 1.5):.2f}:d=1.5[m];"
                 "[1:a][m]amix=inputs=2:duration=first:normalize=0[a]")
        credits = _credits(music_dir)
        (out_dir / "music.json").write_text(json.dumps(
            {"file": track.name, **credits.get(track.name, {})}, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        audio = "[1:a]anull[a]"
    cmd += ["-filter_complex", f"[0:v]ass=captions.ass[v];{audio}", "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", str(vcfg.get("crf", 20)), "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-t", f"{total:.3f}", "-movflags", "+faststart", "video.mp4"]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE, cwd=out_dir)

    renderer = Renderer(W, H, repo_root, lang)
    point_idx = 0
    elapsed = 0.0
    thumb_saved = False
    try:
        for scene, dur in zip(script["scenes"], durations):
            st = renderer.prepare(scene, dur, circuit_id)
            if scene["kind"] == "point":
                point_idx += 1
                st["index"] = point_idx
            n = max(1, round(dur * FPS))
            for k in range(n):
                t = k / FPS
                img = renderer.frame(st, t, (elapsed + t) / total)
                if not thumb_saved and scene["kind"] == "hook" and t >= 0.8:
                    img.convert("RGB").save(out_dir / "thumbnail.jpg", quality=90)
                    thumb_saved = True
                enc.stdin.write(img.convert("RGB").tobytes())
            elapsed += dur
    finally:
        enc.stdin.close()
        code = enc.wait()
    if code != 0:
        raise RuntimeError(f"ffmpeg encode failed ({code})")
    shutil.rmtree(out_dir / "voice_parts", ignore_errors=True)
    return out_dir / "video.mp4"
