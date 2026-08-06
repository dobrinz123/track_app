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
| WP1 | DISPATCHED (Sonnet, background) | package.json, .gitignore, README.md, tsconfig*, eslint/prettier configs, packages/core/**, apps/mobile/** | wave1-scaffold |
| WP2 | ACCEPTED (DONE_WITH_CONCERNS; concerns dispositioned — see Decisions) | docs/research/**, data/osm/** | wave1-circuit |
| WP3 | ACCEPTED (DONE; scout report consumed) | .foreman/scratch/platform-research.md | wave1-platform |
| WP4–WP16 | PENDING | see plan | — |

## Attempts
(append-only)
- WP0 | 1 | LEAD | — | DONE | n/a | docs written | 2026-08-06
- WP3 | 1 | Haiku scout | ticket inline | DONE→ACCEPTED | n/a (read-only) | .foreman/scratch/platform-research.md (Expo SDK 57, 1Hz GNSS, perf.now monotonic) | 2026-08-06

## Decisions
- WP2 concerns dispositioned: (a) no public pit/SF/sector data → gates are app-defined + versioned per ADR-0002, never labeled official; (b) turn-count conflict (17 vs 10) → not modeled in MVP, documented; (c) OSM IDs missing → resolved by LEAD Overpass query: way 488429454 (circuit, closed, ~3706 m ≈ verified 3.708 km) + way 488429716 (pit lane); raw JSON archived in data/osm/, ODbL attribution mandated (ADR-0002). New task WP4b: deterministic TMR profile generator from OSM data.
- Stack: Expo/RN + TS monorepo (ADR-0001) — local verifiability + worker proficiency.
- Codex consent: granted in mission spec ("Codex agents — algorithmic and verification work"); billing = ChatGPT subscription.
- Contracts authored by LEAD in docs/architecture/contracts.md; workers materialize verbatim.
- Verifier cadence: blind verification per integration group (core group, app group, final), not per micro-ticket — logged as a deliberate batching decision.

## Scratch
.foreman/scratch/
