# Final Delivery Report — Circuit Timer (Transilvania Motor Ring)

Date: 2026-08-06 · Author: Fable 5 (lead architect/orchestrator) · Final HEAD: c3ca773 (27 commits from empty repo)

## What was built

A production-quality, offline-first, iOS-primary mobile track-session app for Transilvania Motor Ring: phone-GNSS lap and sector timing with a Learn (calibration) lap, personal-best reference laps with full telemetry, a live delta display, session history, deterministic replay tooling, and an advisory (non-official-timing) posture throughout.

## Architecture implemented

npm-workspaces monorepo (ADR-0001):
- **`packages/core`** — pure TypeScript domain, zero React/Expo imports (lint-enforced, verifier-proven): geometry (local ENU projection, hinted polyline projection with periodic audit, progress unwrapping, directed-gate segment intersection with interpolated crossing times), circuit-profile schema/validation/migrations (zod, capped inputs), continuity-constrained track matcher, telemetry quality evaluator, Learn calibration engine (bounded bias, coverage bins, direction detection), 12-state pure session reducer, crossing detector + lap/sector timing engines (8 invalid-reason codes), reference-lap resampling + PB rules + live-delta engine, contract-tested persistence (in-memory reference + SQL implementation with proven parity), SessionController (production orchestrator: watchdog, checkpointing, recovery, PB atomicity), deterministic fixtures (15 adversarial scenarios, seeded PRNG) + replay harness that streams them through the production pipeline.
- **`apps/mobile`** — Expo SDK 57 app: 13 screens including the portrait driving dashboard (dominant green/red/neutral delta, long-press-only session end, no modals while timing), GNSS/replay location providers, iOS-hardened Core Location config (ADR-0003), expo-sqlite persistence, on-device DevReplay running real fixtures through the real controller, delete-my-data UI, diagnostics surfaces, OSM ODbL attribution in UI.

## Agents and models used

- **Fable 5 (LEAD)** — architecture, contracts, ADRs, tickets, all verification gating, integration fixes, this report. Wrote no feature code beyond two small verifier-mandated tests and test relocations.
- **Sonnet workers (9 dispatches)** — scaffold, state machine, in-memory + SQLite persistence, platform layer, iOS hardening, full UI, integration (SessionController wiring), docs, two fix waves.
- **Haiku scouts (2)** — circuit research, platform research.
- **Codex (gpt-5.6-sol, 8 dispatches)** — geometry, timing engines, profile schema, TMR profile generator, calibration/matching, reference/delta, fixtures/replay, performance pass; plus read-only final cross-review. (ChatGPT-subscription billing, consented via mission spec.)
- **Independent verifiers** — Claude foreman-verifier: core-group gate (PASS_WITH_NOTES) and final 18-row DoD matrix (PASS_WITH_NOTES); Codex read-only final cross-review; independent Sonnet security review (0 critical/high; all 6 medium/low findings fixed with tests).

## Objective results (all reproduced by the lead, not worker-claimed)

- **515/515 tests passing** across 29 files: unit, property-based (fast-check), contract-parity, and 18 end-to-end replay scenarios through the production pipeline.
- `npm run typecheck` (strict, both workspaces), `npm run lint`, `expo export` iOS + Android: all green.
- **Performance** (docs/verification/performance.md): matcher 390k+ matches/s (3.67–4.32× measured improvement from hint-first search, ratio-asserted in CI-style benchmark), delta engine ~1.9M ops/s, 5-lap pipeline 2.35 ms, bounded memory (0.72 MiB per 3,600-sample session result).
- **Offline proof**: zero network-call sites (audited grep, twice independently); TMR profile statically inlined — verified by scanning the compiled Hermes bytecode for profile-only strings.
- **Determinism**: TMR profile regenerates byte-identically from archived OSM data; fixture replays are byte-deterministic per seed.

## Circuit data: sources and confidence

Geometry: OpenStreetMap way 488429454 (circuit, 150 nodes, closed, computed 3706.5 m — within 0.05% of the independently verified 3.708 km) and way 488429716 (pit lane), retrieved 2026-08-06, archived in `data/osm/`, ODbL 1.0 attribution in-profile and in-UI (ADR-0002). Start/finish, sector, and pit gates are **app-defined, deterministic, versioned — never presented as official**. Research packet with per-claim confidence tags: docs/research/transilvania-motor-ring.md. No coordinates were fabricated anywhere; the only non-OSM geometry is the clearly-synthetic `dev-test-ring` test fixture.

## Known limitations (full list: docs/known-limitations.md)

~1 Hz GNSS bounds precision (~±0.3 s vs professional timing); geometry/gates unvalidated on-site; foreground-only sessions; iOS mocked-location detection gap; no calibration-stall timeout; native builds require EAS cloud (no local Xcode); mobile UI handlers verified by inspection, not automated UI tests (no RN test infra in MVP).

## Items requiring physical track validation

docs/verification/real-track-validation-checklist.md — 16-item printable protocol (standalone EAS build mandatory, airplane-mode offline test, GNSS rate/accuracy, thermal, crossings over ≥10 laps, independent-timer comparison, PB replacement, battery). This is the gate between "verified in replay" and "trusted on track."

## Running the app (Windows host, iPhone) — full guide: docs/ios-no-mac-workflow.md

- Dev loop: `npm install` → `cd apps/mobile` → `npx expo start` → scan QR with iPhone (Expo Go; all deps Go-compatible).
- Replay demo on device: Settings → Dev Replay (dev builds) → pick a fixture → the production controller drives the real dashboard.
- On-track build (required for circuit use): `eas build --platform ios --profile preview` (cloud macOS builders) → install via TestFlight (Apple Developer, $99/yr — the only paid dependency) or free sideload (AltStore/Sideloadly, 7-day resign cycle).
- Verification gates: `npm run typecheck && npm test && npm run lint`; `npm run generate:tmr` regenerates the circuit profile byte-identically.

## Verification chain

Every work package: worker report → lead re-ran deterministic gates → committed. Core group + final state additionally blind-verified by fresh-context verifiers holding original tickets (never worker narratives), with adversarial probes. All security findings (6) and all verifier findings (4) fixed and re-verified. The Codex final review's single HIGH was a sandbox write-denial artifact, not an application defect — the same gates pass in the real workspace, reproduced by two independent runners.
