# Implementation Plan

Orchestrated build (foreman model: Fable 5 lead; Sonnet/Haiku/Codex workers). Task states live in `.foreman/ledger.md`.

## Work packages & sequencing

| WP | Scope | Seat | Depends on |
|----|-------|------|-----------|
| WP0 | Baseline docs, ADR-0001, contracts, plan, ledger | LEAD | — |
| WP1 | Monorepo scaffold: workspaces, `packages/core` (contracts materialized), `apps/mobile` Expo app shell, Vitest/ESLint/Prettier/tsc, verify scripts, README skeleton | Sonnet | WP0 |
| WP2 | Transilvania Motor Ring research packet + `docs/research/transilvania-motor-ring.md` | Haiku (scout) | — |
| WP3 | Mobile platform research packet (expo-location/permissions/background/battery) | Haiku (scout) | — |
| WP4 | Circuit-profile schema (zod), validation, migrations, dev-only TMR profile generator + profile loading | Codex | WP1 |
| WP5 | Geometry core: ENU projection, polyline projection w/ continuity, unwrapping, directed gate crossing + interpolation; unit + property tests | Codex | WP1 |
| WP6 | Timing core: crossing detector guards, lap/sector engines, monotonic clock; unit + property tests | Codex | WP5 |
| WP7 | Calibration engine + telemetry quality evaluator; tests | Codex | WP5 |
| WP8 | Session state machine (pure reducer) + tests | Sonnet | WP1 |
| WP9 | Reference-lap resampling + live-delta engine; tests | Codex | WP6 |
| WP10 | Deterministic fixtures (all adversarial scenarios) + ReplayHarness through production pipeline + integration tests | Codex | WP4–WP9 |
| WP11 | Persistence: SQLite repository (app) + in-memory impl (core tests), checkpointing, PB atomic update; tests | Sonnet | WP4, WP9 |
| WP12 | Location/motion providers, permissions, preflight checks, platform config (plugins, foreground service), lifecycle recovery | Sonnet | WP1, WP3 |
| WP13 | UI: all 13 surfaces, view models, active dashboard, dev replay screen | Sonnet | WP8, WP10, WP11 |
| WP14 | Integration wiring + full docs set + validation checklist | Sonnet | all |
| WP15 | Security/privacy review (read-only) | Codex reviewer | WP14 |
| WP16 | Final independent verification (blind) | foreman-verifier + Codex read-only | WP14 |

Parallelization only with disjoint write sets (see ledger). Verification gates after each integration group: `npm run typecheck && npm test && npm run lint`, Metro export for the app, then blind verifier per group.

## Verification strategy

1. Deterministic: typecheck, lint, unit/property/integration suites, Metro bundle export.
2. Blind verifier (fresh context, original ticket text) per integration group.
3. Cross-family: Codex reviews Claude-authored groups and vice versa where practical.
4. Final adversarial verifier before sign-off; findings batched into fix waves.
