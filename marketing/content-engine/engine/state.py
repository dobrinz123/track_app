"""SQLite ledger: ideas, videos, LLM usage. One file, no server."""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
from pathlib import Path

SCHEMA = """
create table if not exists ideas(
  id integer primary key, pillar text, title text, angle text, circuit text,
  status text default 'new', created text);
create table if not exists videos(
  id integer primary key, idea_id integer, lang text, dir text,
  status text, created text, published text, url text, note text);
create table if not exists usage(
  ts text, day text, task text, model text, input_tokens integer,
  output_tokens integer, cost_usd real, cached integer);
"""


def now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def today() -> str:
    return dt.date.today().isoformat()


class State:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        cols = {r["name"] for r in self.db.execute("pragma table_info(videos)")}
        if "voice" not in cols:  # added with voice rotation
            self.db.execute("alter table videos add column voice text")
            self.db.commit()

    # ideas
    def add_idea(self, pillar: str, title: str, angle: str, circuit: str | None) -> int:
        cur = self.db.execute(
            "insert into ideas(pillar,title,angle,circuit,created) values(?,?,?,?,?)",
            (pillar, title, angle, circuit or "", now()))
        self.db.commit()
        return cur.lastrowid

    def ideas(self, status: str | None = None) -> list[sqlite3.Row]:
        if status:
            return self.db.execute("select * from ideas where status=? order by id", (status,)).fetchall()
        return self.db.execute("select * from ideas order by id").fetchall()

    def set_idea_status(self, idea_id: int, status: str) -> None:
        self.db.execute("update ideas set status=? where id=?", (status, idea_id))
        self.db.commit()

    def pillar_counts(self) -> dict[str, int]:
        rows = self.db.execute("select pillar, count(*) n from ideas group by pillar").fetchall()
        return {r["pillar"]: r["n"] for r in rows}

    # videos
    def add_video(self, idea_id: int, lang: str, folder: str, status: str, note: str = "",
                  voice: str = "") -> int:
        cur = self.db.execute(
            "insert into videos(idea_id,lang,dir,status,created,note,voice) values(?,?,?,?,?,?,?)",
            (idea_id, lang, folder, status, now(), note, voice))
        self.db.commit()
        return cur.lastrowid

    def videos(self, status: str | None = None) -> list[sqlite3.Row]:
        q = "select v.*, i.title from videos v left join ideas i on i.id=v.idea_id"
        if status:
            return self.db.execute(q + " where v.status=? order by v.id", (status,)).fetchall()
        return self.db.execute(q + " order by v.id").fetchall()

    def voice_history(self, lang: str) -> list[str]:
        rows = self.db.execute(
            "select voice from videos where lang=? and voice is not null and voice != '' order by id", (lang,))
        return [r["voice"] for r in rows]

    def video(self, vid: int) -> sqlite3.Row | None:
        return self.db.execute("select * from videos where id=?", (vid,)).fetchone()

    def set_video(self, vid: int, **fields) -> None:
        keys = ", ".join(f"{k}=?" for k in fields)
        self.db.execute(f"update videos set {keys} where id=?", (*fields.values(), vid))
        self.db.commit()

    # usage
    def log_usage(self, task: str, model: str, usage: dict, cost: float, cached: bool) -> None:
        self.db.execute(
            "insert into usage values(?,?,?,?,?,?,?,?)",
            (now(), today(), task, model, usage.get("input_tokens", 0),
             usage.get("output_tokens", 0), cost, int(cached)))
        self.db.commit()

    def spent_today(self) -> float:
        row = self.db.execute("select coalesce(sum(cost_usd),0) s from usage where day=?", (today(),)).fetchone()
        return float(row["s"])

    def usage_summary(self) -> dict:
        rows = self.db.execute(
            "select day, count(*) calls, sum(cached) cache_hits, sum(input_tokens) tin, "
            "sum(output_tokens) tout, round(sum(cost_usd),4) usd from usage group by day order by day desc limit 7"
        ).fetchall()
        return [dict(r) for r in rows]


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)
