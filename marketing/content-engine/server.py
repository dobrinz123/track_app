"""Local studio UI: browse clips, copy captions, generate a new clip on demand.

  python server.py            -> http://127.0.0.1:8765

Standard library only. Binds to 127.0.0.1, so it is reachable from this PC only.
"""
from __future__ import annotations

import json
import re
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import run
from engine.llm import BudgetExceeded
from engine.posts import INTRO_SERIES, ensure_intro_series
from engine.research import research

HOST, PORT = "127.0.0.1", 8765
UI = run.ROOT / "ui" / "index.html"
VOICES_UI = run.ROOT / "ui" / "voices.html"
LAB = run.ROOT / "voice-lab"
MEDIA = {"video.mp4": "video/mp4", "thumbnail.jpg": "image/jpeg"}
TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".wav": "audio/wav", ".mp3": "audio/mpeg",
         ".png": "image/png", ".pdf": "application/pdf"}
POSTS_UI = run.ROOT / "ui" / "posts.html"

JOB = {"running": False, "steps": [], "error": None, "made": []}
JOB_LOCK = threading.Lock()


def generate(topic: str | None) -> None:
    """One clip: from the typed topic if given, else the next idea in the backlog (researching if empty)."""
    def step(msg: str) -> None:
        JOB["steps"].append(msg)

    try:
        cfg, state, llm, facts = run.load()
        if topic:
            circuit = "tmr" if re.search(r"transilvania|tmr", topic, re.I) else (
                "motorpark" if re.search(r"motorpark", topic, re.I) else None)
            idea_id = state.add_idea("custom", topic[:70], topic[:300], circuit)
            idea = next(i for i in state.ideas("new") if i["id"] == idea_id)
        else:
            backlog = state.ideas("new")
            if not backlog:
                step("Caut idei noi (Haiku)...")
                research(llm, state, facts, cfg, run.OUT / "cache")
                backlog = state.ideas("new")
            if not backlog:
                raise RuntimeError("no new ideas could be generated")
            idea = backlog[0]
        step(f"Idee: {idea['title']}")
        JOB["made"] = run.produce_one(cfg, state, llm, facts, idea, on_step=step)
        if not JOB["made"]:
            raise RuntimeError("the script failed the claim check twice; see out/engine.log")
        step("Gata.")
    except BudgetExceeded as exc:
        JOB["error"] = f"Bugetul zilnic LLM a fost atins ({exc})."
    except Exception as exc:
        JOB["error"] = f"{type(exc).__name__}: {exc}"
        run.log(f"ui generate failed: {traceback.format_exc(limit=4)}")
    finally:
        JOB["running"] = False


def generate_post(topic: str | None, fmt: str) -> None:
    """One image post: from the typed topic, else the next idea no post has used yet."""
    def step(msg: str) -> None:
        JOB["steps"].append(msg)

    try:
        cfg, state, llm, facts = run.load()
        if topic:
            idea_id = state.add_idea("custom", topic[:70], topic[:300], None)
            state.set_idea_status(idea_id, "done")  # typed topics are not left in the clip backlog
            idea = next(i for i in state.ideas() if i["id"] == idea_id)
        else:
            ensure_intro_series(state)  # the product introduction goes out first
            pool = state.ideas_without_post()
            if not pool:
                step("Caut idei noi (Haiku)...")
                research(llm, state, facts, cfg, run.OUT / "cache")
                pool = state.ideas_without_post()
            if not pool:
                raise RuntimeError("no idea available for a post")
            idea = pool[0]
        step(f"Idee: {idea['title']}")
        pid = run.produce_post(cfg, state, llm, facts, idea, fmt, on_step=step)
        if pid is None:
            raise RuntimeError("the post failed the claim check twice; see out/engine.log")
        JOB["made"] = [pid]
        step("Gata.")
    except BudgetExceeded as exc:
        JOB["error"] = f"Bugetul zilnic LLM a fost atins ({exc})."
    except Exception as exc:
        JOB["error"] = f"{type(exc).__name__}: {exc}"
        run.log(f"ui post generate failed: {traceback.format_exc(limit=4)}")
    finally:
        JOB["running"] = False


def post_payload(state) -> list[dict]:
    items = []
    for row in reversed(state.posts()):
        folder = Path(row["dir"])
        meta_file = folder / "post.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
        items.append({
            "id": row["id"], "format": row["format"], "status": row["status"], "created": row["created"],
            "title": meta.get("title") or row["title"], "note": row["note"],
            "slides": [f"/media/post/{row['id']}/{n}" for n in meta.get("slides", [])],
            "pdf": f"/media/post/{row['id']}/linkedin_carousel.pdf" if (folder / "linkedin_carousel.pdf").exists() else None,
            "captions": meta.get("platforms", {}),
        })
    return items


def video_payload(state) -> list[dict]:
    items = []
    for v in reversed(state.videos()):
        folder = Path(v["dir"])
        post_file = folder / "post.json"
        post = json.loads(post_file.read_text(encoding="utf-8")) if post_file.exists() else None
        items.append({
            "id": v["id"], "lang": v["lang"], "status": v["status"], "created": v["created"],
            "title": (post or {}).get("title") or v["title"], "note": v["note"], "url": v["url"],
            "voice": (post or {}).get("voice") or (v["voice"] if "voice" in v.keys() else None),
            "captions": (post or {}).get("platforms", {}),
            "hasVideo": (folder / "video.mp4").exists(),
        })
    return items


def voices_payload() -> dict:
    sys_path = str(LAB)
    import sys
    if sys_path not in sys.path:
        sys.path.insert(0, sys_path)
    import importlib

    import candidates
    importlib.reload(candidates)
    checks = json.loads((LAB / "checks.json").read_text(encoding="utf-8")) if (LAB / "checks.json").exists() else {}
    cfg, _, _, _ = run.load()
    current = cfg["voices"]["en"]
    current_list = current if isinstance(current, list) else [current]
    items = []
    for c in candidates.CANDIDATES:
        sample = next((f.name for f in (LAB / "samples").glob(c["id"] + ".*")), None)
        if not sample:
            continue
        clip = (LAB / "clips" / f"{c['id']}.mp4").exists()
        chk = checks.get(sample, {})
        e = c["engine"] or {}
        is_current = bool(e) and any(all(cur.get(k, "edge" if k == "engine" else None) == v
                                         for k, v in e.items() if k != "rate") for cur in current_list)
        items.append({**c, "sample": sample, "clip": clip, "seconds": chk.get("seconds"), "wer": chk.get("wer"),
                      "current": is_current})
    return {"candidates": items, "rotation": isinstance(current, list),
            "text": (LAB / "sample_text.txt").read_text(encoding="utf-8")}


def _flow(c: dict) -> str:
    fields = {**c["engine"], "name": c["name"]}
    return "{ " + ", ".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fields.items()) + " }"


def choose_voices(ids: list[str]) -> list[dict]:
    """One id -> fixed voice; several -> rotation. Rewrites the single `voices.en` line of config.yaml."""
    import sys
    if str(LAB) not in sys.path:
        sys.path.insert(0, str(LAB))
    import candidates
    chosen = []
    for cid in ids:
        c = next((c for c in candidates.CANDIDATES if c["id"] == cid), None)
        if not c or not c["engine"]:
            raise KeyError(f"{cid} cannot be selected")
        chosen.append(c)
    if not chosen:
        raise ValueError("no voice selected")
    if len(chosen) == 1:
        line = f"  en: {_flow(chosen[0])}   # chosen in Studio > Voci"
    else:
        line = f"  en: [{', '.join(_flow(c) for c in chosen)}]   # rotation, chosen in Studio > Voci"
    cfg_path = run.ROOT / "config.yaml"
    text = cfg_path.read_text(encoding="utf-8")
    new, n = re.subn(r"(?m)^  en: [\[{].*$", lambda _: line, text)
    if n != 1:
        raise RuntimeError("could not find the voices.en line in config.yaml")
    cfg_path.write_text(new, encoding="utf-8")
    return chosen


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            self._page(UI)
        elif path == "/api/videos":
            _, state, _, _ = run.load()
            self._json({"videos": video_payload(state), "backlog": len(state.ideas("new")),
                        "spend": state.usage_summary()[:1]})
        elif path == "/api/job":
            self._json(JOB)
        elif path == "/posts":
            self._page(POSTS_UI)
        elif path == "/api/posts":
            _, state, _, _ = run.load()
            ensure_intro_series(state)
            done = {r["idea_id"] for r in state.posts() if r["status"] != "rejected"}
            intro_left = [r["title"] for r in state.ideas() if r["pillar"] == "intro" and r["id"] not in done]
            self._json({"posts": post_payload(state), "fresh": len(state.ideas_without_post()),
                        "intro_left": intro_left, "intro_total": len(INTRO_SERIES)})
        elif m := re.fullmatch(r"/media/post/(\d+)/(slide_\d\d\.png|linkedin_carousel\.pdf)", path):
            _, state, _, _ = run.load()
            row = state.post(int(m.group(1)))
            self._send_file(Path(row["dir"]) / m.group(2) if row else None)
        elif path == "/voices":
            self._page(VOICES_UI)
        elif path == "/api/voices":
            self._json(voices_payload())
        elif m := re.fullmatch(r"/lab/(samples|clips)/([\w.-]+)", path):
            self._send_file(LAB / m.group(1) / m.group(2))
        elif m := re.fullmatch(r"/media/(\d+)/(video\.mp4|thumbnail\.jpg)", path):
            _, state, _, _ = run.load()
            v = state.video(int(m.group(1)))
            self._send_file(Path(v["dir"]) / m.group(2) if v else None)
        else:
            self.send_error(404)

    def _page(self, path: Path):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, f: Path | None):
        if not f or not f.exists() or f.suffix not in TYPES:
            return self.send_error(404)
        size = f.stat().st_size
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng and (m := re.match(r"bytes=(\d*)-(\d*)", rng)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else end
            elif m.group(2):  # suffix range: last N bytes
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", TYPES[f.suffix])
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with f.open("rb") as fh:
            fh.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = fh.read(min(1 << 16, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (ConnectionResetError, BrokenPipeError):
                pass  # the browser cancelled a range request while seeking

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/generate":
            topic = (self._body().get("topic") or "").strip() or None
            with JOB_LOCK:
                if JOB["running"]:
                    return self._json({"error": "O generare rulează deja."}, 409)
                JOB.update(running=True, steps=[], error=None, made=[])
            threading.Thread(target=generate, args=(topic,), daemon=True).start()
            self._json({"ok": True})
        elif path == "/api/posts/generate":
            body = self._body()
            topic = (body.get("topic") or "").strip() or None
            fmt = body.get("format") if body.get("format") in ("carousel", "single") else "carousel"
            with JOB_LOCK:
                if JOB["running"]:
                    return self._json({"error": "O generare rulează deja."}, 409)
                JOB.update(running=True, steps=[], error=None, made=[])
            threading.Thread(target=generate_post, args=(topic, fmt), daemon=True).start()
            self._json({"ok": True})
        elif m := re.fullmatch(r"/api/posts/(\d+)/status", path):
            status = self._body().get("status")
            if status not in ("review", "approved", "rejected", "posted"):
                return self._json({"error": "bad status"}, 400)
            _, state, _, _ = run.load()
            if not state.post(int(m.group(1))):
                return self._json({"error": "no post"}, 404)
            state.set_post(int(m.group(1)), status=status)
            self._json({"ok": True})
        elif path == "/api/voices/choose":
            body = self._body()
            try:
                chosen = choose_voices(body.get("ids") or [body.get("id", "")])
            except Exception as exc:
                return self._json({"error": str(exc)}, 400)
            self._json({"ok": True, "names": [c["name"] for c in chosen]})
        elif m := re.fullmatch(r"/api/videos/(\d+)/status", path):
            status = self._body().get("status")
            if status not in ("review", "approved", "rejected", "posted"):
                return self._json({"error": "bad status"}, 400)
            _, state, _, _ = run.load()
            v = state.video(int(m.group(1)))
            if not v or v["status"] == "rejected" and not (Path(v["dir"]) / "video.mp4").exists():
                return self._json({"error": "no video"}, 404)
            state.set_video(int(m.group(1)), status=status)
            self._json({"ok": True})
        else:
            self.send_error(404)


def main():
    import sys

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"TRACE Studio: {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
