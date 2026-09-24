"""Product truth -> one compact, byte-stable system prompt.

Byte-stability matters: the same system text on every call is what lets the API backend's prompt
cache (and our own disk cache) hit. Nothing volatile (dates, counts) may go in here.
"""
from __future__ import annotations

from pathlib import Path

import yaml


def load_facts(root: Path) -> dict:
    return yaml.safe_load((root / "brand" / "facts.yaml").read_text(encoding="utf-8"))


def system_prompt(facts: dict, role: str) -> str:
    feats = "\n".join(f"- {f}" for f in facts["features"])
    coach = "\n".join(f"- [{moment}] {line}" for moment, lines in facts["coaching"].items() for line in lines)
    never = "\n".join(f"- {n}" for n in facts["never_claim"])
    pillars = "\n".join(f"- {p['id']}: {p['brief']}" for p in facts["pillars"])
    return (
        f"You are the {role} for {facts['product']}, a faceless short-video channel.\n"
        f"Product: {facts['one_liner']['en']}\n"
        f"Launch status: {facts['launch_status']}.\n"
        f"Audience: {facts['audience']}\nTone: {facts['tone']}\n"
        f"WHAT MAKES TRACE DIFFERENT (lead with this): {facts['differentiator']}\n"
        f"COACHING - the three moments (live / pits / after), the core of every video:\n{coach}\n"
        f"OTHER FEATURES:\n{feats}\n"
        "These coaching and feature lines are the only product claims allowed.\n"
        f"NEVER CLAIM:\n{never}\n"
        f"CONTENT PILLARS:\n{pillars}\n"
        "Safety: all driving advice is for closed circuits / track days only. "
        "Teach beginners; never glorify risk. Never invent statistics, quotes, people or lap times."
    )
