"""Render post slides: one HTML page per slide, screenshotted by headless Chrome/Edge.

HTML/CSS gives real typography (the app's own Space Grotesk / Inter / JetBrains Mono) and lets
slides reuse the real app captures in marketing/landing/screens. No Python browser library: the
browser's own --screenshot flag does the work (about 1.5 s per slide).
"""
from __future__ import annotations

import html
import shutil
import subprocess
from pathlib import Path

W, H = 1080, 1350  # 4:5, the portrait size Instagram, Facebook and LinkedIn all accept

BROWSERS = [
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
]

# Highlight boxes on each app screen, in % of the 390x844 frame (same as the landing page).
HOT = {
    "circuits": (41.5, 6, 88, 14), "learn-lap": (23, 18, 64, 26), "live-corner": (5.4, 3, 94, 8.6),
    "live-brake": (5.4, 3, 94, 8.6), "pit-view": (21, 3, 94, 45), "report": (42, 5, 90, 14.5),
}
MOMENT_TAG = {"live-corner": "S1 · LIVE", "live-brake": "S1 · LIVE", "pit-view": "S2 · PITS",
              "report": "S3 · AFTER", "circuits": "GRID", "learn-lap": "OUT-LAP"}


def browser() -> str:
    for p in BROWSERS:
        if p.exists():
            return str(p)
    found = shutil.which("chrome") or shutil.which("msedge")
    if not found:
        raise RuntimeError("no Chrome or Edge found for rendering post slides")
    return found


CSS = f"""
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;700&family=Space+Grotesk:wght@500;700&display=block');
* {{ box-sizing: border-box; margin: 0; }}
html, body {{ width: {W}px; height: {H}px; overflow: hidden; }}
body {{ background: #0A0A0C; color: #F2F2F4; font-family: Inter, 'Segoe UI', sans-serif; position: relative; }}
.shade {{ position: absolute; left: 0; right: 0; bottom: 0; height: 190px; z-index: 4; background: linear-gradient(transparent, #0A0A0C 70%); }}
.grid {{ position: absolute; inset: 0; background:
   radial-gradient(70% 45% at 50% -5%, rgba(255,179,0,.16), transparent 70%),
   repeating-linear-gradient(0deg, transparent 0 89px, #111116 89px 90px),
   repeating-linear-gradient(90deg, transparent 0 89px, #111116 89px 90px); }}
.pad {{ position: absolute; inset: 0; padding: 88px 84px 120px; display: flex; flex-direction: column; gap: 30px; }}
.tag {{ align-self: flex-start; font: 700 26px 'JetBrains Mono', monospace; letter-spacing: .12em; color: #FFB300;
        background: rgba(255,179,0,.13); padding: 10px 18px; border-radius: 12px; }}
h1 {{ font: 700 96px/1.02 'Space Grotesk', sans-serif; letter-spacing: -.025em; }}
h1 em {{ font-style: normal; color: #FFB300; }}
h2 {{ font: 700 78px/1.05 'Space Grotesk', sans-serif; letter-spacing: -.02em; }}
.body {{ font: 400 40px/1.42 Inter, sans-serif; color: #B4B4BD; max-width: 880px; }}
.num {{ font: 700 150px/1 'JetBrains Mono', monospace; color: #FFB300; letter-spacing: -.04em; }}
.foot {{ z-index: 5; position: absolute; left: 84px; right: 84px; bottom: 56px; display: flex; align-items: center; gap: 14px;
         font: 700 30px 'Space Grotesk', sans-serif; letter-spacing: .1em; }}
.foot .count {{ margin-left: auto; font: 500 26px 'JetBrains Mono', monospace; color: #9A9AA3; letter-spacing: .06em; }}
.foot .swipe {{ font: 500 26px 'JetBrains Mono', monospace; color: #FFB300; letter-spacing: .06em; margin-left: 26px; }}
.logo {{ width: 44px; height: 44px; }}
.phone {{ position: relative; width: 470px; aspect-ratio: 390/844; border-radius: 62px; padding: 15px;
          background: linear-gradient(145deg,#2A2A30,#0E0E11 45%,#22222A);
          box-shadow: 0 50px 110px -30px rgba(255,179,0,.30), 0 0 0 2px #33333B inset; }}
.phone .scr {{ position: relative; width: 100%; height: 100%; border-radius: 48px; overflow: hidden; background: #000; }}
.phone img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
.hot {{ position: absolute; border: 4px solid #FFB300; border-radius: 20px;
        box-shadow: 0 0 0 999px rgba(0,0,0,.30), 0 0 36px rgba(255,179,0,.45); }}
.illus {{ position: absolute; bottom: -38px; left: 0; right: 0; text-align: center;
          font: 500 20px 'JetBrains Mono', monospace; letter-spacing: .1em; color: #6E6E78; }}
.cover-phone {{ position: absolute; right: 70px; bottom: -360px; transform: rotate(-6deg); }}
.cover-phone .illus {{ display: none; }}
.cover .pad {{ padding-right: 84px; }}
.cover h1 {{ max-width: 900px; }}
.cover .body {{ max-width: 560px; }}
.screen-slide .pad {{ align-items: center; text-align: center; gap: 44px; }}
.screen-slide .phone {{ width: 380px; }}
.screen-slide .pad {{ padding-top: 76px; }}
.screen-slide h2 {{ font-size: 64px; max-width: 900px; }}
.point .pad {{ justify-content: center; padding-bottom: 200px; }}
.cta .pad {{ align-items: center; justify-content: center; text-align: center; gap: 40px; }}
.cta .mark {{ width: 260px; height: 260px; }}
.cta h2 {{ max-width: 900px; }}
.stores {{ display: flex; gap: 22px; }}
.store {{ font: 700 30px 'Space Grotesk', sans-serif; padding: 20px 32px; border-radius: 20px;
          border: 2px solid #3A3A44; background: #18181E; }}
.store small {{ display: block; font: 500 18px 'JetBrains Mono', monospace; letter-spacing: .12em; color: #9A9AA3; }}
"""

LOGO_SVG = ('<svg class="logo" viewBox="0 0 32 32"><path d="M5 7h17l-2 5h-6l-5 15H4l5-15H3z" fill="#2A2A32" '
            'stroke="#8A8A94" stroke-width="1.2"/><path d="M9 27C12 17 15 11 21 8c4-2 7 0 5 3-2 3-7 2-10 3" '
            'fill="none" stroke="#FFB300" stroke-width="2.6" stroke-linecap="round"/></svg>')


def _phone(screens_dir: Path, screen: str, css_class: str = "") -> str:
    top, left, width, height = HOT[screen]
    img = (screens_dir / f"{screen}.webp").as_uri()
    return (f'<div class="phone {css_class}"><div class="scr"><img src="{img}">'
            f'<div class="hot" style="top:{top}%;left:{left}%;width:{width}%;height:{height}%"></div></div>'
            f'<div class="illus">REAL APP SCREEN · ILLUSTRATIVE VALUES</div></div>')


def _accent_last_words(title: str, n: int = 2) -> str:
    words = html.escape(title).split()
    if len(words) <= n:
        return f"<em>{' '.join(words)}</em>"
    return " ".join(words[:-n]) + " <em>" + " ".join(words[-n:]) + "</em>"


def slide_html(slide: dict, idx: int, total: int, screens_dir: Path, mark_uri: str, point_no: int = 1) -> str:
    kind, title, body = slide["kind"], slide["title"], html.escape(slide.get("body", ""))
    screen = slide.get("screen") if slide.get("screen") in HOT else None
    swipe = '<span class="swipe">SWIPE →</span>' if idx == 1 and total > 1 else ""
    count = f'<span class="count">{idx}/{total}</span>' if total > 1 else ""
    foot = f'<div class="foot">{LOGO_SVG}TRACE{swipe}{count}</div>'
    if kind == "cover":
        tag = f'<span class="tag">{MOMENT_TAG.get(screen, "TRACK COACH")}</span>'
        phone = _phone(screens_dir, screen, "cover-phone") if screen else ""
        inner = f'<div class="pad">{tag}<h1>{_accent_last_words(title)}</h1><p class="body">{body}</p></div>{phone}'
        cls = "cover"
    elif kind == "screen" and screen:
        inner = (f'<div class="pad"><span class="tag">{MOMENT_TAG[screen]}</span><h2>{html.escape(title)}</h2>'
                 f'{_phone(screens_dir, screen)}</div>')
        cls = "screen-slide"
    elif kind == "cta":
        inner = (f'<div class="pad"><img class="mark" src="{mark_uri}"><h2>{html.escape(title)}</h2>'
                 '<div class="stores"><div class="store"><small>SOON ON THE</small>App Store</div>'
                 '<div class="store"><small>SOON ON</small>Google Play</div></div></div>')
        cls = "cta"
    else:  # point
        inner = (f'<div class="pad"><span class="num">{point_no:02d}</span><h2>{html.escape(title)}</h2>'
                 f'<p class="body">{body}</p></div>')
        cls = "point"
    return (f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head>'
            f'<body class="{cls}"><div class="grid"></div>{inner}<div class="shade"></div>{foot}</body></html>')


def render_post(post: dict, out_dir: Path, repo_root: Path) -> list[Path]:
    out_dir = out_dir.resolve()
    repo_root = repo_root.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    screens_dir = repo_root / "marketing" / "landing" / "screens"
    mark_uri = (repo_root / "apps" / "mobile" / "assets" / "trace_logo_mark.png").as_uri()
    exe = browser()
    slides = post["slides"]
    paths = []
    point_no = 0
    for i, slide in enumerate(slides, 1):
        point_no += slide["kind"] == "point"
        page = out_dir / f"_slide_{i:02d}.html"
        page.write_text(slide_html(slide, i, len(slides), screens_dir, mark_uri, max(1, point_no)), encoding="utf-8")
        png = out_dir / f"slide_{i:02d}.png"
        subprocess.run([exe, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                        f"--window-size={W},{H}", "--virtual-time-budget=5000", f"--screenshot={png}",
                        page.as_uri()], check=True, capture_output=True, timeout=90)
        page.unlink(missing_ok=True)
        paths.append(png)
    return paths
