# Current State

> Living document. Updated as integration groups land. Started 2026-08-06 from an empty repository (see `docs/verification/baseline.md`).

## Target architecture (summary)

Monorepo (npm workspaces):

- `packages/core` — pure TypeScript domain: circuit-profile schema and validation, geometry (local-plane projection, polyline projection, progress unwrapping, directed gate crossing), calibration engine, session state machine, lap/sector timing engines, reference-lap store logic, live-delta engine, telemetry quality evaluation, replay harness. **No React/React Native/Expo imports permitted.** Tested with Vitest (unit + property-based via fast-check) driven by deterministic telemetry fixtures.
- `apps/mobile` — Expo (React Native, TypeScript) application: UI surfaces, view models, platform adapters (`LocationProvider` via expo-location, `MotionProvider` via expo-sensors, persistence via expo-sqlite), session recovery, developer replay screen. Depends on `packages/core` only through its published contracts.

Dependency inversion: the core consumes `LocationSample` streams through the `LocationProvider` interface; production supplies GNSS, tests/dev supply the deterministic `ReplayLocationProvider` streaming fixtures through the **same** pipeline.

Full contracts: `docs/architecture/contracts.md`. Decisions: `docs/decisions/`.

## Status ledger

See `.foreman/ledger.md` for task-by-task status, ownership, and verification state.
