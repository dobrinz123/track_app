"""Post packages and (opt-in) publishing.

Every rendered video becomes a self-contained folder: video.mp4, thumbnail.jpg, script.json and
post.json with a ready caption per platform. Nothing leaves the machine unless the video is
approved (manually, or `auto_approve: true`) AND a platform is enabled in config.yaml.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import requests

PLATFORM_LIMITS = {"tiktok": 2200, "instagram": 2200, "youtube": 5000}


def build_post(script: dict, lang: str) -> dict:
    tags = [t.lstrip("#").replace(" ", "") for t in script.get("hashtags", [])][:6]
    tag_line = " ".join(f"#{t}" for t in tags)
    caption = script["caption"].strip()
    post = {"lang": lang, "title": script["title"][:95], "hashtags": tags, "platforms": {}}
    for name, limit in PLATFORM_LIMITS.items():
        text = f"{caption}\n\n{tag_line}"
        if name == "youtube":
            text = f"{caption}\n\n{tag_line} #shorts"
        post["platforms"][name] = text[:limit]
    return post


def write_package(folder: Path, script: dict, post: dict) -> None:
    (folder / "script.json").write_text(json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8")
    (folder / "post.json").write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
    for name, text in post["platforms"].items():
        (folder / f"caption_{name}.txt").write_text(text, encoding="utf-8")


def export_ready(folder: Path, ready_root: Path, vid: int) -> Path:
    """Copy an approved package to out/ready/<id>/ for manual upload (TikTok / Instagram)."""
    dest = ready_root / f"{vid:04d}"
    dest.mkdir(parents=True, exist_ok=True)
    for f in folder.iterdir():
        if f.suffix in (".mp4", ".jpg", ".txt", ".json"):
            shutil.copy2(f, dest / f.name)
    return dest


# ---------------------------------------------------------------- YouTube (official Data API v3)

def _youtube_token() -> str:
    missing = [k for k in ("YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN") if not os.environ.get(k)]
    if missing:
        raise RuntimeError(f"YouTube upload needs env vars: {', '.join(missing)}")
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": os.environ["YT_CLIENT_ID"], "client_secret": os.environ["YT_CLIENT_SECRET"],
        "refresh_token": os.environ["YT_REFRESH_TOKEN"], "grant_type": "refresh_token"}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def upload_youtube(folder: Path, privacy: str) -> str:
    post = json.loads((folder / "post.json").read_text(encoding="utf-8"))
    token = _youtube_token()
    meta = {
        "snippet": {"title": post["title"], "description": post["platforms"]["youtube"],
                    "tags": post["hashtags"], "categoryId": "2"},  # 2 = Autos & Vehicles
        "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
    }
    video = folder / "video.mp4"
    init = requests.post(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(video.stat().st_size)},
        data=json.dumps(meta), timeout=60)
    init.raise_for_status()
    with video.open("rb") as fh:
        up = requests.put(init.headers["Location"], headers={"Content-Type": "video/mp4"}, data=fh, timeout=600)
    up.raise_for_status()
    return f"https://youtube.com/shorts/{up.json()['id']}"
