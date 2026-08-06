# Foreman Ledger — Transilvania Motor Ring track-session app

BASELINE: (empty repo, git initialized 2026-08-06, branch main, no commits yet) | untracked: .claude/, docs/, .foreman/ | 2026-08-06

MODE: Codex-boosted Full (Agent tool ✓, real shell ✓, Codex CLI 0.145.0 ✓ ChatGPT-subscription login — consent: user's mission spec explicitly requests Codex workers; echo check passed, default seat)

SEATS: LEAD = Fable 5 (frontier). Claude: sonnet (WORKHORSE), haiku (FAST), opus/fable (FRONTIER). Codex: account-default seat verified via echo ("ok", 3k tokens); treated as WORKHORSE/FRONTIER-class for algorithmic work; per-dispatch effort via `-c model_reasoning_effort`.

## Plan
See docs/implementation-plan.md (WP0–WP16).

## Routing
- WP1 scaffold → Sonnet: well-specified config-heavy work
- WP2, WP3 research → Haiku scouts (read-only web research, bounded)
- WP4–WP7, WP9, WP10 → Codex (algorithmic/geometry/timing/fixtures)
- WP8, WP11–WP14 → Sonnet (implementation with clear contracts)
- WP15 → Codex read-only reviewer; WP16 → foreman-verifier (Claude) + Codex read-only (cross-family)

## Tasks
| id | state | owned paths | job id |
|----|-------|-------------|--------|
| WP0 | DONE (LEAD) | docs/**, .foreman/ledger.md | — |
| WP1 | PENDING | package.json, .gitignore, README.md, tsconfig*, .eslintrc*, .prettierrc*, packages/core/**, apps/mobile/** | — |
| WP2 | PENDING | docs/research/**, .foreman/scratch/circuit-research* | — |
| WP3 | PENDING | .foreman/scratch/platform-research* | — |
| WP4–WP16 | PENDING | see plan | — |

## Attempts
(append-only)
- WP0 | 1 | LEAD | — | DONE | n/a | docs written | 2026-08-06

## Decisions
- Stack: Expo/RN + TS monorepo (ADR-0001) — local verifiability + worker proficiency.
- Codex consent: granted in mission spec ("Codex agents — algorithmic and verification work"); billing = ChatGPT subscription.
- Contracts authored by LEAD in docs/architecture/contracts.md; workers materialize verbatim.
- Verifier cadence: blind verification per integration group (core group, app group, final), not per micro-ticket — logged as a deliberate batching decision.

## Scratch
.foreman/scratch/
