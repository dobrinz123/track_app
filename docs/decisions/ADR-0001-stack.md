# ADR-0001 — Mobile stack: React Native (Expo) + TypeScript monorepo

Date: 2026-08-06 · Status: Accepted · Decider: Fable 5 (lead architect)

## Context

The repository is empty (see `docs/verification/baseline.md`); no framework exists to preserve. The product is an offline-capable GNSS lap-timing app whose correctness lives in geometry/timing algorithms that must be testable deterministically, on this build machine (Windows 11, Node 24, **no Flutter SDK, no Android SDK/Xcode installed**).

## Options considered

1. **Flutter (Dart)** — excellent rendering performance and a strong single-codebase story. Rejected primarily because no Flutter SDK exists on the build machine: neither `flutter test`, analysis, nor builds could be run and verified during this orchestrated build, violating the "independently verify worker claims" rule. Dart is also a weaker seat for the available worker models than TypeScript.
2. **React Native via Expo (TypeScript)** — chosen.
3. Native Kotlin+Swift twin apps — rejected: doubled surface, no local verification possible, far beyond MVP need.

## Decision

- **npm workspaces monorepo**: `packages/core` (pure TypeScript domain — zero React/RN/Expo imports, enforced by lint) + `apps/mobile` (Expo app).
- **Expo SDK** with `expo-location` (fused/CoreLocation providers, background-capable via config plugins), `expo-sensors`, `expo-sqlite` for local-first persistence, `expo-keep-awake` for the driving screen.
- **Vitest + fast-check** for unit/property tests on core; **TypeScript strict** everywhere; ESLint + Prettier.
- **Zod** for circuit-profile schema validation and safe import parsing.
- Timing uses a `MonotonicClock` abstraction (`performance.now()`-backed), never wall-clock.

## Why this wins here

- Every timing/geometry/calibration algorithm runs and is verified on Node with zero mobile SDKs: `npm run typecheck`, `npm test`, and `npx expo export` (Metro bundle) constitute the machine-verifiable build gate.
- Deterministic replay (fixtures streamed through the production pipeline) is trivial when the pipeline is pure TS.
- The core package is UI-framework-independent by construction, satisfying the architecture requirement directly.

## Consequences

- Native binaries (APK/IPA) require Android Studio / Xcode or EAS Build; documented as an out-of-machine step in README and known limitations.
- Background location on Android needs a foreground service (config-plugin declared); real-device validation remains on the physical-track checklist.
