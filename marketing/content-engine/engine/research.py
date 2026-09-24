"""Idea research: cheap model, one batched call, local dedup.

Token discipline:
- external pages are reduced to plain text by trafilatura, then to the few sentences that mention
  track-day keywords, then capped at `source_chars` — and the digest is cached per URL per day;
- past titles are deduplicated locally with character-trigram Jaccard (zero tokens);
- one call returns `ideas_per_call` ideas, so the fixed prompt overhead is paid once per batch.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import re
from pathlib import Path

from .brand import system_prompt
from .llm import LLM
from .state import State

KEYWORDS = re.compile(
    r"track ?day|lap|brak|corner|apex|racing line|circuit|tyre|tire|beginner|first time|nervous|"
    r"instructor|flag|pit|understeer|oversteer|timer|sector|delta|circuit|tur|frân|viraj|începăt",
    re.I)

IDEA_SCHEMA = {
    "type": "object",
    "properties": {
        "ideas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "pillar": {"type": "string"},
                    "title": {"type": "string", "description": "working title, English, <= 70 chars"},
                    "angle": {"type": "string", "description": "the one insight the video delivers, <= 160 chars"},
                    "circuit": {"type": "string", "enum": ["tmr", "motorpark", "none"]},
                    "moment": {"type": "string", "enum": ["live", "pits", "after"],
                               "description": "the coaching moment this video lands on"},
                },
                "required": ["pillar", "title", "angle", "circuit", "moment"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["ideas"],
    "additionalProperties": False,
}


def trigrams(text: str) -> set[str]:
    t = re.sub(r"[^a-z0-9ăâîșțşţ ]", "", text.lower())
    t = f"  {t} "
    return {t[i:i + 3] for i in range(len(t) - 2)}


def similarity(a: str, b: str) -> float:
    ta, tb = trigrams(a), trigrams(b)
    return len(ta & tb) / max(1, len(ta | tb))


def is_duplicate(title: str, existing: list[str], threshold: float) -> bool:
    return any(similarity(title, e) >= threshold for e in existing)


def digest_source(url: str, max_chars: int, cache_dir: Path) -> str:
    key = hashlib.sha1(f"{url}|{dt.date.today()}".encode()).hexdigest()[:20]
    hit = cache_dir / f"src-{key}.txt"
    if hit.exists():
        return hit.read_text(encoding="utf-8")
    try:
        import trafilatura

        raw = trafilatura.fetch_url(url)
        text = trafilatura.extract(raw or "", include_comments=False, include_tables=False) or ""
    except Exception as exc:  # a dead source must never stop the pipeline
        text = f"(source unavailable: {type(exc).__name__})"
    sentences = re.split(r"(?<=[.!?])\s+", text)
    kept = [s.strip() for s in sentences if KEYWORDS.search(s) and 30 < len(s) < 300]
    out = " ".join(kept)[:max_chars]
    cache_dir.mkdir(parents=True, exist_ok=True)
    hit.write_text(out, encoding="utf-8")
    return out


def research(llm: LLM, state: State, facts: dict, cfg: dict, cache_dir: Path) -> list[int]:
    rcfg = cfg["research"]
    existing = [r["title"] for r in state.ideas()]
    counts = state.pillar_counts()
    pillar_ids = [p["id"] for p in facts["pillars"]]
    # Steer toward the least-covered pillars so the channel stays balanced without extra calls.
    underfed = sorted(pillar_ids, key=lambda p: counts.get(p, 0))[:3]

    signals = [digest_source(u, rcfg.get("source_chars", 1200), cache_dir) for u in rcfg.get("sources", [])]
    signals = [s for s in signals if s and not s.startswith("(source unavailable")]

    recent = "; ".join(existing[-25:]) or "none yet"
    prompt = (
        f"Propose {rcfg['ideas_per_call']} short-video ideas. Favour these pillars: {', '.join(underfed)}.\n"
        f"Each idea = one specific beginner problem or lesson, resolved by ONE of TRACE's three coaching moments "
        f"(live while driving / in the pits between sessions / after the session). The coaching moment is the "
        f"point of the video, not an afterthought; do not make ideas that are only about lap times or delta. "
        f"Spread the batch across the three moments. Specific beats generic ('you brake 20 m earlier every lap "
        f"at the hairpin and never notice; the pit view shows it' beats 'track day tips').\n"
        f"Use circuit 'tmr' or 'motorpark' only for circuit-guide or when the circuit matters; else 'none'.\n"
        f"Already covered (do not repeat): {recent}\n"
    )
    if signals:
        prompt += "What people are currently asking (raw, may be noisy):\n" + "\n---\n".join(signals)

    data = llm.json("research", cfg["llm"]["research_model"], system_prompt(facts, "content researcher"),
                    prompt, IDEA_SCHEMA)
    added = []
    for idea in data["ideas"]:
        if idea["pillar"] not in pillar_ids:
            idea["pillar"] = underfed[0]
        if is_duplicate(idea["title"], existing, rcfg.get("dedup_threshold", 0.45)):
            continue
        existing.append(idea["title"])
        circuit = None if idea["circuit"] == "none" else idea["circuit"]
        angle = f"[{idea['moment']}] {idea['angle']}"  # the moment rides in the angle: no schema change
        added.append(state.add_idea(idea["pillar"], idea["title"], angle, circuit))
    return added
