"""Editor feedback on rejected clips and posts.

A rejection names WHY (checkboxes + a free note). Idea-level reasons retire the idea for good;
execution-level reasons regenerate the same idea with the notes sent to the writer. Recurring
notes are summarised into every future writer prompt, so the engine stops repeating them.
"""
from __future__ import annotations

# id -> (label shown in Studio, what the writer is told). Kept short: this text reaches prompts.
IDEA_REASONS = {
    "idea-weak": ("Idee proastă / neinteresantă", "the topic itself was not interesting"),
    "idea-duplicate": ("Repetă alt clip / altă postare", "it repeated a topic already covered"),
    "idea-not-diff": ("Nu arată diferențiatorul", "it did not show TRACE's coaching (live / pits / after)"),
    "idea-audience": ("Nu e pentru începători", "it was not useful for track-day beginners"),
}
EXEC_REASONS = {
    "hook": ("Hook slab", "the opening hook was weak: make the first line name a concrete beginner problem"),
    "too-long": ("Prea mult text / prea lung", "too much text: cut words, one idea per scene/slide"),
    "unclear": ("Neclar / greu de urmărit", "hard to follow: simpler words, clearer order"),
    "claim": ("Afirmație greșită", "it made a claim the fact sheet does not support"),
    "visual": ("Ecran / vizual nepotrivit", "the app screen shown did not match what was being said"),
    "cta": ("CTA slab", "the ending/call to action was weak"),
    "caption": ("Descriere slabă", "the caption was weak: lead with the problem, then the fix"),
}
VIDEO_ONLY = {
    "pace": ("Ritm prea lent / prea rapid", "the pacing was off: shorter sentences, fewer scenes"),
    "voice": ("Voce nepotrivită", "(voice) - another voice is picked on regeneration"),
    "music": ("Muzică nepotrivită", "(music) - another track is picked on regeneration"),
}


def reason_catalog(kind: str) -> dict:
    exec_reasons = dict(EXEC_REASONS)
    if kind == "video":
        exec_reasons.update(VIDEO_ONLY)
    return {
        "idea": [{"id": k, "label": v[0]} for k, v in IDEA_REASONS.items()],
        "exec": [{"id": k, "label": v[0]} for k, v in exec_reasons.items()],
    }


def is_idea_problem(reasons: list[str]) -> bool:
    return any(r in IDEA_REASONS for r in reasons)


def writer_notes(reasons: list[str], comment: str) -> str:
    """Notes for regenerating one item (execution feedback only)."""
    all_exec = {**EXEC_REASONS, **VIDEO_ONLY}
    lines = [all_exec[r][1] for r in reasons if r in all_exec and not all_exec[r][1].startswith("(")]
    if comment.strip():
        lines.append(f"editor's note: {comment.strip()[:400]}")
    return "\n".join(f"- {line}" for line in lines)


def recurring_notes(state, limit: int = 4) -> str:
    """The most frequent execution reasons so far, as a short standing instruction for the writer."""
    counts = state.feedback_reason_counts()
    all_exec = {**EXEC_REASONS, **VIDEO_ONLY}
    top = [(r, n) for r, n in counts if r in all_exec and not all_exec[r][1].startswith("(")][:limit]
    if not top:
        return ""
    return "Recurring editor feedback on earlier drafts (avoid repeating it):\n" + "\n".join(
        f"- {all_exec[r][1]} ({n}x)" for r, n in top)
