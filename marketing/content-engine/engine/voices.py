"""Voice selection: one fixed voice, or a rotation so the channel does not sound like one machine.

`voices.<lang>` in config.yaml is either one voice config or a list of them. With a list, each new
clip gets the voice that was used least recently (never-used voices first), so consecutive clips
differ and every voice gets its turn.
"""
from __future__ import annotations


def voice_key(v: dict) -> str:
    return f"{v.get('engine', 'edge')}:{v['voice']}"


def voice_label(v: dict) -> str:
    return v.get("name") or voice_key(v)


def pick_voice(voices_cfg, history: list[str]) -> dict:
    """history = voice keys of past clips, oldest first."""
    if isinstance(voices_cfg, dict):
        return voices_cfg
    if not voices_cfg:
        raise ValueError("voices list is empty")
    last_used = {k: i for i, k in enumerate(history)}
    # never used -> -1, so it wins; ties keep config order
    return min(voices_cfg, key=lambda v: last_used.get(voice_key(v), -1))
