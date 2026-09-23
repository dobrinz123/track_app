# Prompt audit, 2026-09-23

Proposed diff: `docs/audits/prompt-audit-2026-09-23.patch`. Applied in full on 2026-09-23.

## Assumptions

- **Scope.** The request named no files, so the scope is every file that reaches an agent as instructions. Four of them are still in use:
  - `apps/mobile/AGENTS.md`, which is loaded into every session through `apps/mobile/CLAUDE.md` (`@AGENTS.md`).
  - `docs/HANDOFF.md`
  - `docs/NEXT-CIRCUIT-PLAYBOOK.md`
  - `docs/roadmap/phase-5-llm-corner-analysis.md`
- **Out of scope:**
  - The 190 files in `.foreman/scratch/ticket-*.md`. These are tickets that were already sent to workers, so editing them changes nothing. Many of them went to Codex (`gpt-5.6-sol`), which is a non-Anthropic model. A grep found no dated patterns in them (no think-step-by-step, scratchpad, narration suppressors, word caps or grader wording). Their MUST NOT and write-set lines are scope constraints and should stay.
  - `.foreman/ledger.md`, which is history rather than instructions.
- **The app makes no runtime LLM calls.** No code imports an SDK or builds a request. So the request-config checks found nothing: no `thinking`, `budget_tokens`, sampling parameters, prefill or `tool_choice`, and no tool definitions or system prompts.
- **Target model: Claude Fable 5.** The ledger names it as the LEAD seat, and it is the newest model any repo document points to. All the findings below also hold for Claude Fable 5.1 and Claude Opus 5.5.
- **No git blame provenance.** Every file in scope arrived in one bulk commit (`b282af0`) or the handoff commit (`966887d`), so blame doesn't say why any line was added.

## Summary

| Group | Findings | In diff |
|---|---|---|
| 1 Dated prompt text | 3 | 2 |
| 2 Brittle skill/rule files | 3 | 2 |
| 3 Tool descriptions | 0 (none exist) | 0 |
| 4 Request config / architecture | 0 (no LLM calls) | 0 |

Most of this surface is context that only the owner knows: field lessons, invariants, the reasons behind each rule. By the keep list it is not cruft. The three findings that matter most:

1. **`phase-5-llm-corner-analysis.md` contradicts itself.** Sections 0–4 tell a fresh agent to build an LLM pipeline and a backend. The reversal to a deterministic engine only appears at the very bottom of the file. The file's own header says "Read this before touching telemetry, coaching, or session export". An agent that follows it can start building the pipeline that was cancelled.
2. **`apps/mobile/AGENTS.md` is loaded on every turn in `apps/mobile`.** It says, in capitals and with no reason given, to read the Expo docs "before writing any code". That applies even to the 51 pure-logic session modules that never touch Expo. The part worth keeping is the reason: SDK 57 is newer than the model's training data. The rewrite keeps that and limits the rule to changes that touch Expo or React Native APIs.
3. **`NEXT-CIRCUIT-PLAYBOOK.md` §0 depends on a `/fable-foreman` skill that doesn't exist** in the repo or this environment. It also fixes the worker tier as "Sonnet-class", but the ledger shows Opus workers too (for example P4h-FIX2).

## Findings

| # | Location | Evidence | Pattern | Why obsolete for the target model | Confidence | Action |
|---|---|---|---|---|---|---|
| 1 | `docs/roadmap/phase-5-llm-corner-analysis.md:1-113` vs `:115-121` | §3 step 4 "Session export + LLM analysis…", "Decision: no user API keys… our own backend"; later "REVISION… deterministic analysis engine, not an LLM" | G2 time-sensitive content / conflicting duplicates; G1d patch accretion | Current models follow instructions literally and read files top-down. A mandate early in the file is acted on before the retraction at the end is seen, and the two versions disagree. The shipped code (`packages/core/src/coaching/*`, `docs/architecture/analysis-engine.md`) matches only the revision. | Medium | `add`: a status banner under the header (hunk 4) |
| 2 | `apps/mobile/AGENTS.md:1-3` | `# Expo HAS CHANGED` / `Read the exact versioned docs … before writing any code.` | G1a pressure language (capitals, no "because"); G1a blanket default that over-triggers | Current models respond closely to instructions, so an unscoped "before writing any code" makes them fetch docs for edits that don't touch Expo. The real reason (a stale training prior on SDK 57) was only implied. | Medium | `rewrite` (hunk 1) |
| 3 | `docs/NEXT-CIRCUIT-PLAYBOOK.md:10-11` | `Use the fable-foreman skill (/fable-foreman)… Sonnet-class workers implement` | G2 volatile specifics (a skill that no longer exists); G2 pinned model names | A dangling skill name sends the agent looking for a skill it can't load. A pinned worker tier goes stale at the next model release and already disagrees with the ledger. The process itself (lead plans and verifies, workers implement, cross-family review) and its reason stay. | Medium | `rewrite` (hunk 3) |
| 4 | `docs/HANDOFF.md:36` | `The owner states this repeatedly and means it.` | G1a emphasis / G1c repetition as reinforcement | Rule 1 is already in bold, and line 33 gives the reason. The extra sentence adds pressure but no information. On current models, that pressure makes their behavior around the rule more rigid and cautious. | Medium | `remove` (hunk 2) |
| 5 | `docs/HANDOFF.md:16`, `docs/NEXT-CIRCUIT-PLAYBOOK.md:4` | `**Read these before doing anything.**` / `**Read this before touching anything.**` | G1a blanket mandate | A fresh session gets three "read before anything" orders, each covering several large documents. For small tasks that means reading far more than needed. It may still be what the owner wants from a handoff, so there's no edit. Consider scoping it to "the maps for the area you are changing". | Low | `rewrite`: applied in a follow-up, scoped to the area being changed |
| 6 | `docs/NEXT-CIRCUIT-PLAYBOOK.md:8` | `(non-negotiable process)` | G1a pressure language | Idiom only. The bullets under it already give their reasons. | Low | `remove`: applied in a follow-up |
| 7 | `.claude/settings.local.json:4-42` | `Bash(git -C "D:\\CODE\\APLICTIE_Circuit" status)`, `Bash(git commit -q -m 'WP0: baseline…')` | G2 recency trap / volatile specifics | These are one-off permission entries from a Windows machine and one early session. They aren't prompt text and aren't cruft for the model, but the file is committed even though `*.local.json` files are usually gitignored. | Low | `remove`: 14 one-off entries pruned in a follow-up; the file stays tracked, because untracking it would delete it from existing clones on their next pull |

## Kept deliberately

Grep matched these lines, but the keep list protects them:

- HANDOFF rules 2–7. Each is a prohibition against a failure that has actually happened in this project, and each states its reason.
- Playbook §0:
  - the real-exit-code gates (red commits shipped before the rule existed)
  - "No facts from memory" (the hardware NO-GO)
  - the install-slot rule (a fragile, costly operation)
- The read-only vehicle-bus rules in the phase-5 doc (a safety constraint).
- The dispatch-ticket formats (DONE / DONE_WITH_CONCERNS / BLOCKED, write sets, "No subagents"). These are scope and contract lines, not dated steering.

## Verification

- `git apply --check` passes against `966887d`.
- The patch changes no code, test or model ID, and no test or tool matches on the edited lines.
- There is no eval suite for agent behavior in this repo, so none of this was checked with a behavioral probe. Before taking hunk 1, check it with one: in a fresh session, ask for an edit to a pure module under `apps/mobile/src/session/` and confirm the agent does not fetch Expo docs for that edit. Then ask for an `expo-location` change and confirm that it does.
