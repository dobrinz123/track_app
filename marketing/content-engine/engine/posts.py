"""Static image posts (single image or carousel): writer, checks and captions.

Same discipline as the clips: one cheap-model call writes the post as JSON, the regex guard and
the fact-check reject unsupported claims, one repair call at most.
"""
from __future__ import annotations

from .brand import system_prompt
from .guard import check_text
from .llm import LLM
from .script import fact_check, idea_moment

# Real app screens available for slides (captured from the app; see marketing/landing/screens).
SCREENS = ["live-brake", "live-corner", "pit-view", "report", "circuits", "learn-lap"]
MOMENT_SCREENS = {"live": {"live-brake", "live-corner"}, "pits": {"pit-view"}, "after": {"report"}}
SLIDE_KINDS = ["cover", "point", "screen", "cta"]

POST_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "slides": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": SLIDE_KINDS},
                    "title": {"type": "string", "description": "big slide text, max 9 words"},
                    "body": {"type": "string", "description": "supporting text, max 32 words; empty on cta"},
                    "screen": {"type": "string", "enum": SCREENS + ["none"],
                               "description": "app screen shown on cover/screen slides, else none"},
                },
                "required": ["kind", "title", "body", "screen"],
                "additionalProperties": False,
            },
        },
        "caption": {"type": "string", "description": "post caption, 2-5 short lines, no hashtags"},
        "hashtags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "slides", "caption", "hashtags"],
    "additionalProperties": False,
}

POST_RULES = """Format - a static social post (Instagram / Facebook / LinkedIn / X), read not heard:
- CAROUSEL: 5 to 8 slides. Slide 1 kind=cover: a hook that names the beginner's problem (max 9 words),
  body = one line promise, and a screen. Middle: kind=point = one idea per slide (title max 9 words,
  body max 32 words); kind=screen = the app screen that proves the point, the title says what to look at.
  Last slide kind=cta: title is the CTA line given below, body empty, screen none.
- SINGLE: exactly 1 slide, kind=cover, with a screen; the caption carries the explanation.
- Screens: live-corner (next-corner strip), live-brake (BRAKE IN strip + voice cue), pit-view (where you
  are losing the most), report (corner-by-corner report), circuits (circuit list, learn a new track),
  learn-lap (the one recognition lap). Use the screen of the coaching moment the post is about.
- Write for skimming: short lines, concrete, no hype, no emojis, no invented numbers or statistics.
- 4-8 hashtags without the # sign, broad (trackday) + niche (drivingcoach)."""


def check_post(post: dict, launch_status: str, fmt: str, moment: str | None) -> list[str]:
    problems: list[str] = []
    slides = post.get("slides", [])
    kinds = [s.get("kind") for s in slides]
    if fmt == "single":
        if len(slides) != 1 or kinds[:1] != ["cover"]:
            problems.append("a single post has exactly one slide, kind=cover")
    else:
        if not 5 <= len(slides) <= 8:
            problems.append(f"a carousel needs 5-8 slides, has {len(slides)}")
        if kinds[:1] != ["cover"]:
            problems.append("slide 1 must be kind=cover")
        if kinds[-1:] != ["cta"]:
            problems.append("the last slide must be kind=cta")
    shown = {s.get("screen") for s in slides if s.get("kind") in ("cover", "screen")}
    if not shown & set(SCREENS):
        problems.append("show at least one app screen (cover or screen slide)")
    if moment and not shown & MOMENT_SCREENS[moment]:
        problems.append(f"this post is about the '{moment}' moment: show {sorted(MOMENT_SCREENS[moment])[0]}")
    for i, s in enumerate(slides, 1):
        if len(s.get("title", "").split()) > 10:
            problems.append(f"slide {i}: title over 9 words")
        if len(s.get("body", "").split()) > 36:
            problems.append(f"slide {i}: body over 32 words")
        for p in check_text(s.get("title", "") + " \n " + s.get("body", ""), launch_status):
            problems.append(f"slide {i}: {p}")
    for p in check_text(post.get("caption", ""), launch_status):
        problems.append(f"caption: {p}")
    return sorted(set(problems))


def _as_script(post: dict) -> dict:
    """fact_check() reads scenes; a slide is a scene whose 'voice' is its body."""
    return {"scenes": [{"kind": s["kind"], "voice": s["body"], "onscreen": s["title"]} for s in post["slides"]],
            "caption": post["caption"]}


def write_post(llm: LLM, facts: dict, cfg: dict, idea, fmt: str) -> tuple[dict, list[str]]:
    system = system_prompt(facts, "social post writer") + "\n" + POST_RULES
    moment = idea_moment(idea)
    prompt = (
        f"Format: {fmt.upper()}.\nLanguage: English.\nPillar: {idea['pillar']}\nIdea: {idea['title']}\n"
        f"Insight to deliver: {idea['angle']}\n"
        f"Coaching moment: {moment or 'pick the one that fits best'}\n"
        f"CTA line (last carousel slide title): {facts['cta']['en']}"
    )
    model = cfg["llm"]["writer_model"]
    asked = [prompt]
    post = llm.json(f"post-{fmt}", model, system, prompt, POST_SCHEMA)
    problems = check_post(post, facts["launch_status"], fmt, moment) + fact_check(llm, facts, cfg, _as_script(post))
    for _ in range(2):  # two cheap repair rounds (a too-long title is a one-line fix)
        if not problems:
            break
        repair = (prompt + "\n\nYour previous draft broke these rules; return the full corrected post:\n- "
                  + "\n- ".join(problems) + "\nPrevious slides:\n"
                  + "\n".join(f"[{s['kind']}/{s['screen']}] {s['title']} || {s['body']}" for s in post["slides"]))
        asked.append(repair)
        post = llm.json(f"post-{fmt}-repair", model, system, repair, POST_SCHEMA)
        problems = check_post(post, facts["launch_status"], fmt, moment) + fact_check(llm, facts, cfg, _as_script(post))
    if problems:  # never keep a rejected answer in the cache, or every retry would replay it
        for p in asked:
            llm.forget(model, system, p, POST_SCHEMA)
    return post, problems


X_LIMIT = 280


def post_captions(post: dict) -> dict:
    tags = [t.lstrip("#").replace(" ", "") for t in post.get("hashtags", [])][:8]
    caption = post["caption"].strip()
    long_tags = " ".join(f"#{t}" for t in tags)
    out = {
        "instagram": f"{caption}\n\n{long_tags}",
        "facebook": f"{caption}\n\n{' '.join(f'#{t}' for t in tags[:3])}",
        "linkedin": f"{caption}\n\n{' '.join(f'#{t}' for t in tags[:5])}",
    }
    first = caption.split("\n")[0]
    x = f"{first}\n\n{' '.join(f'#{t}' for t in tags[:2])}"
    out["x"] = x if len(x) <= X_LIMIT else first[:X_LIMIT - 1].rstrip() + "…"
    return out


# The first posts introduce the product: what TRACE is and its differentiator, one moment at a time.
# They are generated before any ordinary idea (see State.ideas_without_post ordering).
INTRO_SERIES = [
    ("What TRACE is: a coach at three moments",
     "[tour] Introduce TRACE to people who have never heard of it: lap timers only give numbers; TRACE coaches "
     "beginners at three moments - while driving (live corner strip and short callouts), in the pits (the three "
     "corners costing the most) and after the session (corner-by-corner report). One screen slide per moment: "
     "live-brake, pit-view, report."),
    ("S1 Live: coached before every corner",
     "[live] Explain the live coaching: before each corner the strip shows corner number, how tight it is (1-6), "
     "target speed and metres left; optional voice says Brake hard / Brake / Lift so eyes stay on the track."),
    ("S2 Pits: the three corners costing you most",
     "[pits] Explain the Pit view between sessions: it ranks where you are losing the most and shows brake points "
     "lap by lap, so you change one thing, not ten. It is part of the optional trackday suggestions."),
    ("S3 After: every corner, lap by lap",
     "[after] Explain the after-session report: every corner, lap by lap - time lost, consistency, entry and exit "
     "speed - against your own best clean lap; share a one-page report in English or Romanian."),
    ("Why a coach, not just a lap timer",
     "[tour] Contrast a lap timer (a time and a delta, you guess the rest) with TRACE (where you lose time, what the "
     "next corner needs, what to change next session). Every number comes from your own laps. Show live-corner, "
     "pit-view and report."),
]


def ensure_intro_series(state) -> None:
    """Seed the intro ideas once (idempotent by title)."""
    have = {r["title"] for r in state.ideas()}
    for title, angle in INTRO_SERIES:
        if title not in have:
            iid = state.add_idea("intro", title, angle, None)
            state.set_idea_status(iid, "done")  # posts only: keeps them out of the clip backlog
