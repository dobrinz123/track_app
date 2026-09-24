"""Deterministic claim/safety guard. Runs on every script before any audio or video is made.

It is free (no tokens) and it is the reason a repair call only needs the list of violations
instead of a second full review by a model.
"""
from __future__ import annotations

import re

NEGATION = re.compile(r"\b(not|never|no|don'?t|nu|niciodată|fără|evită|avoid)\b", re.I)

# (pattern, message). Checked against every voice line, on-screen text and the post caption.
# NEGATABLE entries pass when negated nearby ("it is NOT official timing" is an honest disclaimer).
NEGATABLE = [
    (r"\bofficial\b|\boficial", "claims official timing"),
    (r"\bmakes? you safe|\bsafer driver|\bte (face|ține) în siguranță", "safety promise"),
    (r"\breplaces? (an |your )?instructor|\bînlocuiește instructorul", "replaces an instructor"),
]
ALWAYS_BANNED = [
    (r"\bcertif|\brace[- ]grade|\bhomolog", "claims certified / race-grade accuracy"),
    (r"\b\d+([.,]\d+)?\s?(ms|milliseconds?|milisecunde|cm|centimet)", "states an accuracy number"),
    (r"\b(accurate|precis)\w*\s+(to|la|până la)\s+\d", "states an accuracy number"),
    (r"\bguarante|\bgarant", "makes a guarantee"),
    (r"\b(100|99)\s?%", "absolute percentage claim"),
    (r"\b(thousands|millions|mii de|milioane de)\s+(of\s+)?(drivers|users|pilo|utilizator|șoferi)", "user-count claim"),
    (r"\bmy (best )?lap|\bI (did|set|ran|lapped)|\bam (scos|făcut) un tur", "first-person lap testimonial"),
    (r"\b(artificial intelligence|machine learning)\b|\bA\.?I\.?(-| )?(powered|coach|driven)\b", "claims AI"),
    (r"\b(moves?|shifts?|adjusts?) (your )?(brak\w*|cue)\w*( points?| markers?)? "
     r"(for you|automatically|live|while you drive)", "claims the app moves braking points by itself"),
]
PUBLIC_ROAD = re.compile(
    r"\b(public roads?|on the street|highway|motorway|autostrad\w*|drum(ul|uri)? public\w*|pe stradă|în trafic)", re.I)
STORE_CLAIM = re.compile(
    r"\b(download (it )?(now|today)|available (now|on the)|app store|google play|descarcă(-o)? (acum|azi)|"
    r"disponibil\w* (acum|în))", re.I)


def _negated(text: str, start: int) -> bool:
    window = text[max(0, start - 40):start]
    return bool(NEGATION.search(window))


def check_text(text: str, launch_status: str) -> list[str]:
    problems = []
    for pat, msg in ALWAYS_BANNED:
        if re.search(pat, text, re.I):
            problems.append(msg)
    for pat, msg in NEGATABLE:
        for m in re.finditer(pat, text, re.I):
            if not _negated(text, m.start()):
                problems.append(msg)
    for m in PUBLIC_ROAD.finditer(text):
        if not _negated(text, m.start()):
            problems.append(f"mentions '{m.group(0)}' without saying track-only")
    if launch_status != "live" and STORE_CLAIM.search(text):
        problems.append("says the app is downloadable, but it is not launched yet")
    return problems


PRODUCT_SHOTS = ("coach", "pit", "report", "timer")
COACHING_SHOTS = ("coach", "pit", "report")


def check_script(script: dict, launch_status: str, circuit: str | None = None,
                 required_shot: str | None = None) -> list[str]:
    problems: list[str] = []
    scenes = script.get("scenes", [])
    kinds = [s.get("kind") for s in scenes]
    if not any(k in COACHING_SHOTS for k in kinds):
        problems.append("needs a coaching product shot: a scene of kind=coach, pit or report")
    if sum(k in PRODUCT_SHOTS for k in kinds) > 3:
        problems.append("at most 3 product shots (coach/pit/report/timer) per video")
    if required_shot and required_shot not in kinds:
        problems.append(f"this video is about that coaching moment, so include a scene of kind={required_shot}")
    if circuit and "track" not in kinds:
        problems.append("a circuit is given, so include one scene of kind=track")
    if not circuit and "track" in kinds:
        problems.append("no circuit is given, so do not use kind=track")
    if not 4 <= len(scenes) <= 8:
        problems.append(f"needs 4-8 scenes, has {len(scenes)}")
    if scenes and scenes[0].get("kind") != "hook":
        problems.append("first scene must be kind=hook")
    if scenes and scenes[-1].get("kind") != "cta":
        problems.append("last scene must be kind=cta")
    words = sum(len(s.get("voice", "").split()) for s in scenes)
    if not 55 <= words <= 125:
        problems.append(f"voice-over must be 55-125 words total (about 25-45 s), has {words}")
    for i, s in enumerate(scenes, 1):
        if len(s.get("onscreen", "").split()) > 7:
            problems.append(f"scene {i}: on-screen text over 7 words")
        for p in check_text(s.get("voice", "") + " \n " + s.get("onscreen", ""), launch_status):
            problems.append(f"scene {i}: {p}")
    for p in check_text(script.get("caption", ""), launch_status):
        problems.append(f"caption: {p}")
    return sorted(set(problems))
