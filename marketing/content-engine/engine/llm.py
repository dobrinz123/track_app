"""LLM access with the token-saving measures in one place.

- Structured output via JSON Schema: no free-text parsing, no "please fix your JSON" retries.
- Content-addressed disk cache: an identical (model, system, prompt, schema) is never paid for twice.
- Daily budget: a call is refused once today's spend reaches `daily_budget_usd`.
- claude-cli backend: runs `claude -p` in an empty directory with no tools, no settings, no MCP and
  a custom system prompt, so the fixed overhead per call is ~1.3k input tokens instead of a full
  Claude Code context. Uses the local Claude Code login, so no API key lives in this program.
- anthropic-api backend: marks the system prompt with cache_control, which pays off once the
  brand brief grows past the model's minimum cacheable length.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from .state import State

API_MODELS = {"haiku": "claude-haiku-4-5", "sonnet": "claude-sonnet-5", "opus": "claude-opus-5-5"}
# USD per million tokens (input, output), first-party list prices as of 2026-06; used only for the
# API backend's cost estimate (the CLI backend reports its own cost).
API_PRICES = {"haiku": (1.0, 5.0), "sonnet": (2.0, 10.0), "opus": (4.0, 20.0)}


class BudgetExceeded(RuntimeError):
    pass


class LLM:
    def __init__(self, cfg: dict, state: State, cache_dir: Path):
        self.cfg = cfg
        self.state = state
        self.cache_dir = cache_dir
        cache_dir.mkdir(parents=True, exist_ok=True)
        self.workdir = Path(tempfile.gettempdir()) / "trace-content-engine-empty"
        self.workdir.mkdir(exist_ok=True)

    def json(self, task: str, model: str, system: str, prompt: str, schema: dict) -> dict:
        key = hashlib.sha256(json.dumps([model, system, prompt, schema], sort_keys=True).encode()).hexdigest()
        hit = self.cache_dir / f"{key[:32]}.json"
        max_age = self.cfg.get("cache_days", 14) * 86400
        if hit.exists() and time.time() - hit.stat().st_mtime < max_age:
            self.state.log_usage(task, model, {}, 0.0, cached=True)
            return json.loads(hit.read_text(encoding="utf-8"))

        budget = float(self.cfg.get("daily_budget_usd", 0.5))
        if self.state.spent_today() >= budget:
            raise BudgetExceeded(f"daily LLM budget ${budget:.2f} reached")

        backend = self.cfg.get("backend", "claude-cli")
        if backend == "anthropic-api":
            data, usage, cost = self._api(model, system, prompt, schema)
        else:
            data, usage, cost = self._cli(model, system, prompt, schema)
        self.state.log_usage(task, model, usage, cost, cached=False)
        hit.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return data

    def _cli(self, model: str, system: str, prompt: str, schema: dict):
        exe = shutil.which("claude")
        if not exe:
            raise RuntimeError("`claude` CLI not found on PATH (install Claude Code or use backend: anthropic-api)")
        cmd = [exe, "-p", "--model", model, "--output-format", "json",
               "--system-prompt", system, "--tools", "", "--setting-sources", "",
               "--strict-mcp-config", "--no-session-persistence",
               "--json-schema", json.dumps(schema, separators=(",", ":"))]
        # Prompt goes through stdin: no Windows command-line length limit, no quoting issues.
        env = dict(os.environ)
        if not self.cfg.get("thinking", False):
            # Short structured tasks gain nothing from extended thinking; measured: output tokens halve.
            env["MAX_THINKING_TOKENS"] = "0"
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                              cwd=self.workdir, timeout=300, env=env)
        if proc.returncode != 0:
            raise RuntimeError(f"claude CLI failed ({proc.returncode}): {proc.stderr[-600:] or proc.stdout[-600:]}")
        out = json.loads(proc.stdout)
        if out.get("is_error") or out.get("structured_output") is None:
            raise RuntimeError(f"claude CLI returned no structured output: {str(out.get('result'))[:400]}")
        return out["structured_output"], out.get("usage", {}), float(out.get("total_cost_usd", 0.0))

    def _api(self, model: str, system: str, prompt: str, schema: dict):
        import anthropic  # optional dependency, only for this backend

        client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        msg = client.messages.create(
            model=API_MODELS.get(model, model), max_tokens=8000,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": prompt}])
        if msg.stop_reason in ("refusal", "max_tokens"):
            raise RuntimeError(f"API stop_reason={msg.stop_reason}")
        text = next(b.text for b in msg.content if b.type == "text")
        u = msg.usage
        usage = {"input_tokens": u.input_tokens + (u.cache_read_input_tokens or 0), "output_tokens": u.output_tokens}
        pin, pout = API_PRICES.get(model, API_PRICES["sonnet"])
        cost = (u.input_tokens * pin + (u.cache_read_input_tokens or 0) * pin * 0.1
                + (u.cache_creation_input_tokens or 0) * pin * 1.25 + u.output_tokens * pout) / 1e6
        return json.loads(text), usage, cost
