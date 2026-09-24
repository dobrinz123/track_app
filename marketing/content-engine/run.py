"""TRACE faceless content engine — command line.

  python run.py daily                 research if the backlog is low, produce, publish approved (the scheduled job)
  python run.py research              add a batch of ideas (one cheap-model call)
  python run.py produce [--count N]   script + voice + render the next N ideas
  python run.py demo                  render samples/demo_script.json, no LLM (smoke test)
  python run.py status                ideas, videos, and LLM spend
  python run.py approve ID... | reject ID...
  python run.py publish               upload/export every approved video
  python run.py rerender [ID...]      re-voice existing clips with the current voice setting (no LLM cost)
                 [--keep-voice]      ...or keep each clip's voice and only re-render (e.g. new music/visuals)
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import traceback
from pathlib import Path

import yaml

from engine.brand import load_facts
from engine.llm import LLM, BudgetExceeded
from engine.publish import build_post, export_ready, upload_youtube, write_package
from engine.render import render_video
from engine.post_render import render_post
from engine.posts import post_captions, write_post
from engine.research import research
from engine.script import write_script
from engine.state import State, now
from engine.voices import pick_voice, voice_key, voice_label

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
OUT = ROOT / "out"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def load():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
    state = State(OUT / "state.db")
    llm = LLM(cfg["llm"], state, OUT / "cache")
    return cfg, state, llm, load_facts(ROOT)


def log(msg: str) -> None:
    line = f"[{now()}] {msg}"
    print(line)
    OUT.mkdir(exist_ok=True)
    with (OUT / "engine.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40]


def finish_post(script: dict, lang: str, voice: dict, folder: Path) -> dict:
    """Captions per platform + the licence credits (CC BY voice / music) that must travel with the video."""
    post = build_post(script, lang)
    post["voice"] = voice_label(voice)
    credits = [voice["credit"]] if voice.get("credit") else []
    music = folder / "music.json"
    if music.exists():
        m = json.loads(music.read_text(encoding="utf-8"))
        post["music"] = m.get("title") or m.get("file")
        if m.get("credit"):
            credits.append(m["credit"])
    if credits:
        post["credits"] = credits
        post["platforms"] = {k: t + "\n\n" + "\n".join(credits) for k, t in post["platforms"].items()}
    return post


def cmd_research(cfg, state, llm, facts) -> None:
    ids = research(llm, state, facts, cfg, OUT / "cache")
    log(f"research: +{len(ids)} ideas")


def produce_one(cfg, state, llm, facts, idea, on_step=lambda msg: None) -> list[int]:
    status = "approved" if cfg["publish"].get("auto_approve") else "review"
    made = []
    for lang in cfg["languages"]:
        folder = OUT / "videos" / f"{idea['id']:04d}-{lang}-{slug(idea['title'])}"
        on_step(f"Scriu scriptul ({lang})...")
        script, problems = write_script(llm, facts, cfg, idea, lang)
        if problems:
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "rejected_script.json").write_text(json.dumps(
                {"script": script, "problems": problems}, ensure_ascii=False, indent=2), encoding="utf-8")
            state.add_video(idea["id"], lang, str(folder), "rejected", "; ".join(problems))
            log(f"idea {idea['id']} [{lang}]: script rejected by guard: {problems}")
            continue
        voice = pick_voice(cfg["voices"][lang], state.voice_history(lang))
        run_cfg = copy.deepcopy(cfg)
        run_cfg["voices"][lang] = voice
        on_step(f"Voce ({voice_label(voice)}) + randare: '{script['title']}'...")
        render_video(script, lang, idea["circuit"] or None, run_cfg, REPO, folder, ROOT)
        post = finish_post(script, lang, voice, folder)
        write_package(folder, script, post)
        vid = state.add_video(idea["id"], lang, str(folder), status, voice=voice_key(voice))
        made.append(vid)
        log(f"video {vid} [{lang}] '{script['title']}' -> {status}")
    state.set_idea_status(idea["id"], "done")
    return made


def cmd_produce(cfg, state, llm, facts, count: int) -> None:
    for idea in state.ideas("new")[:count]:
        try:
            produce_one(cfg, state, llm, facts, idea)
        except BudgetExceeded:
            raise
        except Exception as exc:
            state.set_idea_status(idea["id"], "failed")
            log(f"idea {idea['id']} failed: {exc}\n{traceback.format_exc(limit=3)}")


def cmd_publish(cfg, state) -> None:
    yt = cfg["publish"].get("youtube", {})
    for v in state.videos("approved"):
        folder = Path(v["dir"])
        dest = export_ready(folder, OUT / "ready", v["id"])
        url, note = "", f"package ready: {dest}"
        if yt.get("enabled"):
            try:
                url = upload_youtube(folder, yt.get("privacy", "private"))
                note = "youtube uploaded"
            except Exception as exc:
                log(f"video {v['id']}: youtube upload failed: {exc}")
                continue
        state.set_video(v["id"], status="published" if url else "exported", published=now(), url=url, note=note)
        log(f"video {v['id']}: {note} {url}")


def cmd_daily(cfg, state, llm, facts) -> None:
    try:
        if len(state.ideas("new")) < cfg["research"]["min_backlog"]:
            cmd_research(cfg, state, llm, facts)
        cmd_produce(cfg, state, llm, facts, cfg["daily"]["videos_per_run"])
    except BudgetExceeded as exc:
        log(f"stopped: {exc}")
    cmd_publish(cfg, state)


def produce_post(cfg, state, llm, facts, idea, fmt: str, on_step=lambda msg: None) -> int | None:
    """One image post (fmt: 'carousel' | 'single'): write, check, render slides + LinkedIn PDF, package."""
    status = "approved" if cfg["publish"].get("auto_approve") else "review"
    folder = OUT / "posts" / f"{idea['id']:04d}-{fmt}-{slug(idea['title'])}"
    on_step(f"Scriu postarea ({fmt})...")
    post, problems = write_post(llm, facts, cfg, idea, fmt)
    folder.mkdir(parents=True, exist_ok=True)
    if problems:
        (folder / "rejected_post.json").write_text(json.dumps(
            {"post": post, "problems": problems}, ensure_ascii=False, indent=2), encoding="utf-8")
        pid = state.add_post(idea["id"], fmt, str(folder), "rejected", "; ".join(problems))
        log(f"post {pid} [{fmt}] rejected by guard: {problems}")
        return None
    on_step(f"Randez {len(post['slides'])} slide-uri: '{post['title']}'...")
    slides = render_post(post, folder, REPO)
    if len(slides) > 1:  # LinkedIn shows carousels as a document: one PDF, one page per slide
        from PIL import Image
        pages = [Image.open(p).convert("RGB") for p in slides]
        pages[0].save(folder / "linkedin_carousel.pdf", save_all=True, append_images=pages[1:])
    meta = {"title": post["title"], "format": fmt, "slides": [p.name for p in slides],
            "platforms": post_captions(post)}
    (folder / "post.json").write_text(json.dumps({**meta, "source": post}, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    pid = state.add_post(idea["id"], fmt, str(folder), status)
    log(f"post {pid} [{fmt}] '{post['title']}' -> {status}")
    return pid


def cmd_rerender(cfg, state, ids: list[int], keep_voice: bool = False) -> None:
    """Re-voice existing clips with the configured voice(s); scripts are kept, so no LLM cost.

    Voices are dealt round-robin over the clips of this pass (config order), then recorded, so the
    next new clip continues the rotation from where this pass left off.
    """
    targets = [v for v in state.videos() if (not ids or v["id"] in ids)
               and (Path(v["dir"]) / "script.json").exists() and v["status"] != "rejected"]
    history: list[str] = []
    for v in targets:
        folder = Path(v["dir"])
        script = json.loads((folder / "script.json").read_text(encoding="utf-8"))
        idea = next((i for i in state.ideas() if i["id"] == v["idea_id"]), None)
        voices = cfg["voices"][v["lang"]]
        pool = voices if isinstance(voices, list) else [voices]
        same = next((x for x in pool if voice_key(x) == v["voice"]), None) if keep_voice else None
        voice = same or pick_voice(voices, history)
        history.append(voice_key(voice))
        run_cfg = copy.deepcopy(cfg)
        run_cfg["voices"][v["lang"]] = voice
        try:
            render_video(script, v["lang"], (idea["circuit"] if idea else "") or None, run_cfg, REPO, folder, ROOT)
        except Exception as exc:
            log(f"video {v['id']}: re-render failed: {exc}")
            continue
        post = finish_post(script, v["lang"], voice, folder)
        write_package(folder, script, post)
        state.set_video(v["id"], voice=voice_key(voice))
        log(f"video {v['id']}: re-voiced with {voice_label(voice)}")


def cmd_status(state) -> None:
    ideas = state.ideas()
    print(f"ideas: {len(ideas)} total, {len(state.ideas('new'))} in backlog")
    for v in state.videos():
        print(f"  video {v['id']:>4} [{v['lang']}] {v['status']:<9} {(v['title'] or '')[:60]}")
    print("LLM spend (last 7 days):")
    for row in state.usage_summary():
        print(f"  {row['day']}: {row['calls']} calls ({row['cache_hits']} cached), "
              f"{row['tin']} in / {row['tout']} out tokens, ${row['usd']}")


def cmd_demo(cfg) -> None:
    script = json.loads((ROOT / "samples/demo_script.json").read_text(encoding="utf-8"))
    run_cfg = copy.deepcopy(cfg)
    run_cfg["voices"]["en"] = pick_voice(cfg["voices"]["en"], [])
    path = render_video(script, "en", None, run_cfg, REPO, OUT / "demo", ROOT)
    print(path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["daily", "research", "produce", "publish", "status", "approve", "reject",
                                        "demo", "rerender"])
    ap.add_argument("ids", nargs="*", type=int)
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--keep-voice", action="store_true", help="rerender: keep each clip's current voice")
    a = ap.parse_args()
    cfg, state, llm, facts = load()
    if a.command == "daily":
        cmd_daily(cfg, state, llm, facts)
    elif a.command == "research":
        cmd_research(cfg, state, llm, facts)
    elif a.command == "produce":
        cmd_produce(cfg, state, llm, facts, a.count)
    elif a.command == "publish":
        cmd_publish(cfg, state)
    elif a.command == "status":
        cmd_status(state)
    elif a.command in ("approve", "reject"):
        for vid in a.ids:
            v = state.video(vid)
            if not v or v["status"] not in ("review", "approved"):
                print(f"video {vid}: not in review (status: {v['status'] if v else 'missing'}), skipped")
                continue
            state.set_video(vid, status="approved" if a.command == "approve" else "rejected")
            print(f"video {vid}: {a.command}d")
    elif a.command == "demo":
        cmd_demo(cfg)
    elif a.command == "rerender":
        cmd_rerender(cfg, state, a.ids, a.keep_voice)


if __name__ == "__main__":
    main()
