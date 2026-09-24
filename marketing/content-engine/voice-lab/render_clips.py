"""Render the same finished clip once per voice candidate -> voice-lab/clips/<id>.mp4.

  python voice-lab/render_clips.py [id ...]      (system Python, from marketing/content-engine)
"""
from __future__ import annotations

import copy
import glob
import json
import shutil
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "voice-lab"))

import yaml  # noqa: E402

from candidates import CANDIDATES  # noqa: E402
from engine.render import render_video  # noqa: E402

cfg = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
script = json.loads(Path(glob.glob(str(ROOT / "out/videos/0009*/script.json"))[0]).read_text(encoding="utf-8"))
clips = ROOT / "voice-lab/clips"
clips.mkdir(exist_ok=True)
wanted = set(sys.argv[1:])

for c in CANDIDATES:
    if wanted and c["id"] not in wanted:
        continue
    if not list((ROOT / "voice-lab/samples").glob(c["id"] + ".*")):
        continue  # no sample -> engine not installed
    if (clips / f"{c['id']}.mp4").exists() and not wanted:
        continue
    run_cfg = copy.deepcopy(cfg)
    run_cfg["voices"]["en"] = c["engine"]
    work = ROOT / "voice-lab/_work" / c["id"]
    t = time.time()
    try:
        out = render_video(script, "en", "motorpark", run_cfg, ROOT.parent.parent, work, ROOT)
        shutil.copy2(out, clips / f"{c['id']}.mp4")
        print(f"{c['id']}: ok in {time.time() - t:.0f}s", flush=True)
    except Exception:
        print(f"{c['id']}: FAILED\n{traceback.format_exc(limit=3)}", flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
