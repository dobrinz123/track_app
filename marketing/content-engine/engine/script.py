"""Script writer: one call per (idea, language); at most one small repair call if the guard objects."""
from __future__ import annotations

from .brand import system_prompt
from .guard import check_script
from .llm import LLM

SCENE_KINDS = ["hook", "point", "track", "coach", "pit", "report", "timer", "cta"]
MOMENT_SCENE = {"live": "coach", "pits": "pit", "after": "report"}

SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": SCENE_KINDS},
                    "voice": {"type": "string", "description": "spoken line(s) for this scene"},
                    "onscreen": {"type": "string", "description": "big on-screen words, max 7"},
                },
                "required": ["kind", "voice", "onscreen"],
                "additionalProperties": False,
            },
        },
        "caption": {"type": "string", "description": "post caption, 1-3 short lines, no hashtags"},
        "hashtags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "scenes", "caption", "hashtags"],
    "additionalProperties": False,
}

LANG_NAMES = {"ro": "Romanian (natural, spoken, correct diacritics ă â î ș ț)", "en": "English"}

FORMAT_RULES = """Format - a vertical faceless short, 25-45 seconds:
- 4 to 8 scenes. Scene 1 kind=hook: a pattern-interrupt line under 12 words that names the viewer's problem.
- Middle scenes: kind=point for a teaching beat; kind=track shows the circuit map - once if a circuit is given,
  never otherwise. Product shots (1-3 per video; 3 only when touring all three moments), each on the line that talks about it:
  kind=coach = the live coaching strip + a spoken callout (while driving);
  kind=pit = the Pit view, "where you are losing the most" (between sessions);
  kind=report = the corner-by-corner report (after the session);
  kind=timer = the lap timer / live delta (only as a secondary shot, never the main one).
- The video must land on the coaching moment named in the brief and include its product shot.
- Last scene kind=cta, and its voice line is exactly the CTA given below.
- Total voice-over 60-110 words. Short sentences, one idea each, written to be heard not read.
- onscreen = the 2-6 word punchline of that scene, never a copy of the voice line.
- 3-6 hashtags without the # sign, mixing broad (trackday) and niche (lap timer) tags."""


def write_script(llm: LLM, facts: dict, cfg: dict, idea, lang: str) -> tuple[dict, list[str]]:
    system = system_prompt(facts, "scriptwriter") + "\n" + FORMAT_RULES
    circuit = {"tmr": "Transilvania Motor Ring", "motorpark": "MotorPark Romania"}.get(idea["circuit"] or "", "none")
    moment = idea_moment(idea)
    prompt = (
        f"Language: {LANG_NAMES[lang]}.\nPillar: {idea['pillar']}\nIdea: {idea['title']}\n"
        f"Insight to deliver: {idea['angle']}\nCircuit: {circuit}\n"
        f"Coaching moment to land on: {moment or 'pick the one that fits best'}"
        f"{' (use a kind=' + MOMENT_SCENE[moment] + ' scene)' if moment else ''}\n"
        f"CTA voice line: {facts['cta'][lang]}"
    )
    model = cfg["llm"]["writer_model"]
    script = llm.json("script", model, system, prompt, SCRIPT_SCHEMA)
    need = MOMENT_SCENE.get(moment) if moment else None
    problems = check_script(script, facts["launch_status"], idea["circuit"] or None, need)
    problems += fact_check(llm, facts, cfg, script)
    if problems:
        repair = (prompt + "\n\nYour previous draft broke these rules; return the full corrected script:\n- "
                  + "\n- ".join(problems) + "\nPrevious draft scenes:\n"
                  + "\n".join(f"[{s['kind']}] {s['voice']} || {s['onscreen']}" for s in script["scenes"]))
        script = llm.json("script-repair", model, system, repair, SCRIPT_SCHEMA)
        problems = check_script(script, facts["launch_status"], idea["circuit"] or None, need)
        problems += fact_check(llm, facts, cfg, script)
    return script, problems


FACT_SCHEMA = {
    "type": "object",
    "properties": {"unsupported": {"type": "array", "items": {"type": "string"},
                                   "description": "each claim about TRACE, or number/statistic, not backed by the fact sheet"}},
    "required": ["unsupported"],
    "additionalProperties": False,
}


def fact_check(llm: LLM, facts: dict, cfg: dict, script: dict) -> list[str]:
    """Cheap-model check of every product claim and number against the fact sheet.

    The regex guard catches forbidden phrases; this catches plausible-sounding inventions
    ("a 9 is a hairpin", "the strip shows your lift point", made-up mph figures).
    General, well-known driving technique is allowed; claims about TRACE and statistics are not.
    """
    coach = "\n".join(f"- [{m}] {line}" for m, lines in facts["coaching"].items() for line in lines)
    feats = "\n".join(f"- {f}" for f in facts["features"])
    system = ("You are a strict fact-checker for a product video script. FACT SHEET (the only true statements "
              f"about the product):\n{coach}\n{feats}\nList every sentence that claims something about TRACE "
              "that the fact sheet does not support, and every specific number or statistic that is not in the "
              "fact sheet (illustrative on-screen values excluded). General driving technique that any "
              "instructor would teach is fine. Return an empty list if everything is supported.")
    lines = "\n".join(f"[{s['kind']}] {s['voice']} || {s['onscreen']}" for s in script["scenes"])
    out = llm.json("fact-check", cfg["llm"]["research_model"], system, lines + "\nCaption: " + script["caption"],
                   FACT_SCHEMA)
    return [f"unsupported claim: {u}" for u in out["unsupported"]]


def idea_moment(idea) -> str | None:
    """Ideas carry their coaching moment as an angle prefix: "[pits] ..."."""
    angle = idea["angle"] or ""
    if angle.startswith("[") and "]" in angle:
        m = angle[1:angle.index("]")]
        return m if m in MOMENT_SCENE else None
    return None
