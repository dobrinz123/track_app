import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.captions import build_ass, chunk_words  # noqa: E402
from engine.guard import check_script, check_text  # noqa: E402
from engine.publish import build_post  # noqa: E402
from engine.research import is_duplicate, similarity  # noqa: E402
from engine.tts import Word  # noqa: E402
from engine.visuals import cumulative, fit, load_circuit, point_at  # noqa: E402

DEMO = json.loads((ROOT / "samples/demo_script.json").read_text(encoding="utf-8"))


def test_demo_script_passes_guard():
    assert check_script(DEMO, "pre-launch", None) == []


def test_guard_requires_a_coaching_shot_and_the_briefed_moment():
    timer_only = {**DEMO, "scenes": [s if s["kind"] in ("hook", "cta") else {**s, "kind": "point"} for s in DEMO["scenes"]]}
    timer_only["scenes"][1]["kind"] = "timer"
    assert any("coaching product shot" in p for p in check_script(timer_only, "pre-launch"))
    assert any("kind=pit" in p for p in check_script(
        {**DEMO, "scenes": [s for s in DEMO["scenes"] if s["kind"] != "pit"]}, "pre-launch", None, "pit"))


def test_guard_blocks_ai_and_self_moving_cue_claims():
    assert check_text("An AI-powered coach for your track day", "pre-launch")
    assert check_text("It moves your braking points automatically", "pre-launch")
    assert check_text("No AI guessing: every number comes from your laps.", "pre-launch") == []


def test_guard_blocks_store_claim_before_launch_only():
    assert check_text("Download it now on the App Store", "pre-launch")
    assert not [p for p in check_text("Download it now on the App Store", "live") if "downloadable" in p]


def test_guard_allows_negated_disclaimers():
    assert check_text("This is not official timing.", "pre-launch") == []
    assert check_text("Never try this on public roads.", "pre-launch") == []
    assert check_text("It is official timing.", "pre-launch")
    assert check_text("Try it on the highway.", "pre-launch")


def test_guard_blocks_numbers_and_testimonials():
    assert check_text("Accurate to 10 cm", "pre-launch")
    assert check_text("I set a lap of 2:01", "pre-launch")
    assert check_text("Trusted by thousands of drivers", "pre-launch")


def test_guard_requires_structure():
    bad = {"scenes": [{"kind": "point", "voice": "short", "onscreen": "x"}], "caption": ""}
    problems = check_script(bad, "pre-launch")
    assert any("hook" in p for p in problems) and any("coaching product shot" in p for p in problems)


def test_dedup():
    assert similarity("Brake before you turn", "Brake before you turn!") > 0.8
    assert is_duplicate("Brake before the turn", ["Brake before you turn"], 0.45)
    assert not is_duplicate("Live delta explained", ["Brake before you turn"], 0.45)


def test_captions_break_at_pauses_and_never_overlap():
    words = [Word("one", 0, .2), Word("two", .2, .4), Word("three", 1.0, 1.2), Word("four", 1.2, 1.35)]
    chunks = chunk_words(words)
    assert [w.text for w in chunks[0]] == ["one", "two"]
    ass = build_ass(words, 1080, 1920)
    events = [line for line in ass.splitlines() if line.startswith("Dialogue")]
    assert len(events) == 4
    # last word of a line may linger but must end before the next line starts
    assert "0:00:00.52" in events[1]


def test_post_has_hashtags_per_platform():
    post = build_post(DEMO, "en")
    assert "#trackday" in post["platforms"]["tiktok"]
    assert post["platforms"]["youtube"].endswith("#shorts")


def test_circuits_load_and_fit():
    repo = ROOT.parent.parent
    for cid in ("tmr", "motorpark"):
        c = load_circuit(repo, cid)
        pts = fit(c["xy"], 900, 900, 0, 0)
        assert all(-1 <= x <= 901 and -1 <= y <= 901 for x, y in pts)
        acc = cumulative(pts)
        assert point_at(pts, acc, 0) == pts[0]


def test_align_to_script_keeps_written_words_and_fills_gaps():
    from engine.tts import align_to_script
    heard = [Word("At", 0.0, 0.2), Word("Motor", 0.2, 0.5), Word("Park", 0.5, 0.8), Word("look", 0.9, 1.1),
             Word("ahead.", 1.1, 1.4)]
    out = align_to_script("At MotorPark, look ahead.", heard, 1.6)
    assert [w.text for w in out] == ["At", "MotorPark,", "look", "ahead."]
    assert out[0].start == 0.0 and out[2].start == 0.9
    assert 0.2 <= out[1].start < out[1].end <= 0.9  # unmatched word interpolated between neighbours


def test_rotation_picks_least_recently_used_voice():
    from engine.voices import pick_voice, voice_key
    a = {"engine": "kokoro", "voice": "am_michael"}
    b = {"engine": "chatterbox", "voice": "calm"}
    c = {"voice": "en-US-AndrewMultilingualNeural"}
    rot = [a, b, c]
    assert pick_voice(a, ["x"]) is a                       # single voice: always it
    assert pick_voice(rot, []) is a                        # nothing used yet: config order
    history = []
    seq = []
    for _ in range(6):
        v = pick_voice(rot, history)
        seq.append(voice_key(v))
        history.append(voice_key(v))
    assert seq[:3] == [voice_key(a), voice_key(b), voice_key(c)] and seq[3:] == seq[:3]
    # a voice never used before jumps the queue
    assert pick_voice(rot, [voice_key(a), voice_key(c)]) is b


def test_choose_voices_rewrites_only_the_en_line(tmp_path, monkeypatch):
    import shutil
    import yaml
    import server
    shutil.copy(ROOT / "config.yaml", tmp_path / "config.yaml")
    monkeypatch.setattr(server.run, "ROOT", tmp_path)
    server.choose_voices(["kokoro_am_michael", "chatterbox_calm"])
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text(encoding="utf-8"))
    assert [v["voice"] for v in cfg["voices"]["en"]] == ["am_michael", "calm"]
    assert cfg["voices"]["ro"]["voice"] == "ro-RO-EmilNeural"
    server.choose_voices(["edge_andrew_multilingual"])
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["voices"]["en"]["voice"] == "en-US-AndrewMultilingualNeural" and cfg["voices"]["en"]["rate"] == "+0%"


def test_feedback_routing_and_notes(tmp_path):
    from engine.feedback import is_idea_problem, recurring_notes, writer_notes
    from engine.state import State
    assert is_idea_problem(["idea-weak", "hook"]) and not is_idea_problem(["hook", "too-long"])
    notes = writer_notes(["hook", "voice", "claim"], "start with a question")
    assert "hook" in notes and "fact sheet" in notes and "start with a question" in notes
    assert "voice" not in notes.lower().split("editor")[0]  # voice/music are handled by picking, not by the writer
    st = State(tmp_path / "s.db")
    for _ in range(3):
        st.add_feedback("post", 1, 1, ["hook"], "", "regenerate")
    st.add_feedback("post", 2, 1, ["too-long"], "", "regenerate")
    rec = recurring_notes(st)
    assert rec.index("opening hook") < rec.index("too much text") and "(3x)" in rec


def test_fresh_dir_never_overwrites(tmp_path):
    import run
    base = tmp_path / "0007-en-brake"
    assert run.fresh_dir(base) == base
    base.mkdir()
    assert run.fresh_dir(base).name == "0007-en-brake-v2"
    (tmp_path / "0007-en-brake-v2").mkdir()
    assert run.fresh_dir(base).name == "0007-en-brake-v3"
