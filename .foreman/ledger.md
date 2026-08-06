# Foreman Ledger — Transilvania Motor Ring track-session app

BASELINE: (empty repo, git initialized 2026-08-06, branch main, no commits yet) | untracked: .claude/, docs/, .foreman/ | 2026-08-06

MODE: Codex-boosted Full (Agent tool ✓, real shell ✓, Codex CLI 0.145.0 ✓ ChatGPT-subscription login — consent: user's mission spec explicitly requests Codex workers; echo check passed, default seat)

SEATS: LEAD = Fable 5 (frontier). Claude: sonnet (WORKHORSE), haiku (FAST), opus/fable (FRONTIER). Codex: account-default = gpt-5.6-sol (observed in exec headers), ChatGPT login; treated as FRONTIER-class for algorithmic work; per-dispatch effort via `-c model_reasoning_effort`.

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
| WP1 | REPORTED(DONE) + LEAD deterministic checks passed (typecheck/test/lint green, commit 79e974b); blind verification batched into core-group gate | root configs, packages/core scaffold, apps/mobile | wave1-scaffold |
| WP5 | REPORTED(DONE) + LEAD gates green (287/287, commit dabbdc6); blind verification batched into core-group gate | packages/core/src/geometry/**, test/geometry/** | br3xpj3dd |
| WP6 | DISPATCHED (Codex, effort=high, background, log .foreman/scratch/wp6-codex-output.log) | packages/core/src/timing/** | wave2-timing |
| WP8 | REPORTED(DONE_WITH_CONCERNS) — concerns triaged: test placement accepted (vitest convention); geometry failures belong to in-flight WP5, judged at WP5 collection | packages/core/src/statemachine/**, test/statemachine/** | wave2-sm |
| WP11a | REPORTED(DONE) + LEAD verified slice (35/35, lint ✓, commit b6241b6); group gate pending | packages/core/src/persistence/**, test/persistence/** | wave2-persist |
| WP12 | REPORTED(DONE) + LEAD verified (mobile tsc ✓ eslint ✓ expo export 1.5MB hbc ✓, commit 73d0d9c) | apps/mobile/src/platform/**, app.json | wave2-platform |
| WP4 | REPORTED(DONE_WITH_CONCERNS→resolved: tests relocated by LEAD) + gates green 366/366, commit c8de532 | packages/core/src/profile/**, test/profile/** | wave3-schema |
| WP4b | DISPATCHED (Codex effort=high, background, log wp4b-codex-output.log) | packages/core/scripts/**, assets/**, root package.json | wave3-tmr |
| WP13a | REPORTED(DONE) + LEAD verified (tsc/lint/export 890-module 2MB hbc, commit b4c83bf) | apps/mobile/src/ui/**, src/session/**, App.tsx | wave3-ui |

NOTE: WP11b (SQLite adapter) intentionally held until WP4b collects — package-lock.json write overlap (concurrent npm installs). Facade integration notes: add speedKph to FacadeState at WP14; SessionHistoryStore interface lives outside SessionFacade (accepted design call).
| WP2 | ACCEPTED (DONE_WITH_CONCERNS; concerns dispositioned — see Decisions) | docs/research/**, data/osm/** | wave1-circuit |
| WP3 | ACCEPTED (DONE; scout report consumed) | .foreman/scratch/platform-research.md | wave1-platform |
| WP4–WP16 | PENDING | see plan | — |

## Attempts
(append-only)
- WP0 | 1 | LEAD | — | DONE | n/a | docs written | 2026-08-06
- WP3 | 1 | Haiku scout | ticket inline | DONE→ACCEPTED | n/a (read-only) | .foreman/scratch/platform-research.md (Expo SDK 57, 1Hz GNSS, perf.now monotonic) | 2026-08-06
- WP2 | 1 | Haiku scout | ticket inline | DONE_WITH_CONCERNS→ACCEPTED (concerns dispositioned in Decisions) | LEAD Overpass verification confirmed OSM ways | docs/research/transilvania-motor-ring.md, data/osm/ | 2026-08-06
- WP1 | 1 | Sonnet | ticket inline | DONE; LEAD re-ran typecheck+test+lint = green | typecheck ✓ test 2/2 ✓ lint ✓ expo export ✓ (worker) re-verified by LEAD | commit 79e974b | 2026-08-06
- WP5 | 1 | Codex effort=high | ticket-wp5-geometry.md | DISPATCHED | — | job br3xpj3dd → wp5-codex-output.log | 2026-08-06
- WP8 | 1 | Sonnet | ticket-wp8-statemachine.md | DONE_WITH_CONCERNS; 257 sm tests pass; concerns triaged by LEAD | worker: typecheck ✓ lint ✓ sm-suite 257/257 ✓ | pending group verification | 2026-08-06
- WP11a | 1 | Sonnet | ticket-wp11a-persistence-core.md | DISPATCHED | — | — | 2026-08-06

## Decisions
- WP2 concerns dispositioned: (a) no public pit/SF/sector data → gates are app-defined + versioned per ADR-0002, never labeled official; (b) turn-count conflict (17 vs 10) → not modeled in MVP, documented; (c) OSM IDs missing → resolved by LEAD Overpass query: way 488429454 (circuit, closed, ~3706 m ≈ verified 3.708 km) + way 488429716 (pit lane); raw JSON archived in data/osm/, ODbL attribution mandated (ADR-0002). New task WP4b: deterministic TMR profile generator from OSM data.
- Stack: Expo/RN + TS monorepo (ADR-0001) — local verifiability + worker proficiency.
- Codex consent: granted in mission spec ("Codex agents — algorithmic and verification work"); billing = ChatGPT subscription.
- Contracts authored by LEAD in docs/architecture/contracts.md; workers materialize verbatim.
- Verifier cadence: blind verification per integration group (core group, app group, final), not per micro-ticket — logged as a deliberate batching decision.

## Scratch
.foreman/scratch/
