# Circuit Timer

An **advisory, recreational** GNSS lap-timing app for the Transilvania Motor Ring (Cerghid, Mureș County, Romania) — not an official timing system, and no substitute for organizer or FIM/FIA timing. It's a React Native / Expo app (iOS-first, Android supported) backed by a pure TypeScript timing/geometry core.

See `docs/decisions/ADR-0001-stack.md` for the stack decision, `docs/decisions/ADR-0003-ios-primary-target.md` for why iOS is the primary target, and `docs/architecture/contracts.md` for the binding module contracts.

## Quickstart (Windows + iPhone, free sideload path)

Expo Go is retired for this app's SDK — there's no more QR-code dev loop. Both
development and on-track use now go through a sideloaded standalone build. See
[`docs/ios-no-mac-workflow.md`](docs/ios-no-mac-workflow.md) for the full,
beginner-proof guide: the GitHub Actions workflow that builds unsigned `.ipa`
artifacts, and installing/re-signing them on Windows with Sideloadly and a free
Apple ID (no paid Apple Developer account required).

```
npm install
```

Then follow [`docs/ios-no-mac-workflow.md`](docs/ios-no-mac-workflow.md) §b onward to
build via CI, sideload to your iPhone, and (§e) run the dev-client build against
`npx expo start` from `apps/mobile` for fast iteration.

## Monorepo layout

npm workspaces (`packages/*`, `apps/*`):

```
packages/core/    @circuit/core — pure TypeScript domain package (geometry, timing,
                  calibration, session-state contracts). Zero React/React
                  Native/Expo imports, enforced by an ESLint no-restricted-imports
                  rule. Vitest + fast-check for unit/property tests, Zod for schema
                  validation.
apps/mobile/      mobile — Expo (TypeScript) app. Imports @circuit/core via
                  the workspace; Metro is configured for monorepo resolution.
```

## Prerequisites

- Node.js 24.x and npm 11.x.
- No Android SDK / Xcode / Flutter required for typecheck, test, lint, or the
  Metro export steps below. Native builds (APK/IPA) additionally require Android
  Studio / Xcode (out of scope on this Windows build machine) or
  [EAS Build](https://docs.expo.dev/build/introduction/), which runs in the cloud
  and needs neither — see `docs/ios-no-mac-workflow.md` for the iOS path.

## Install

```
npm install
```

Installs and links all workspaces from the repo root (do not `npm install` inside
individual packages).

## Verification commands

From the repo root:

```
npm run typecheck   # tsc --noEmit across all workspaces
npm test             # vitest run in packages/core
npm run lint          # eslint . (flat config, applied to both workspaces)
npm run format         # prettier --write .
```

To verify the mobile app bundles correctly with Metro (no Android SDK / Xcode needed —
both platforms are machine-verifiable gates per `docs/decisions/ADR-0003-ios-primary-target.md` §5):

```
cd apps/mobile
npx expo export --platform ios --output-dir dist-export
npx expo export --platform android --output-dir dist-export
```

To run the app itself on an iPhone: a sideloaded dev-client build (see Quickstart above
and `docs/ios-no-mac-workflow.md`), or `npm run ios` / `npm run android` / `npm run web`
from `apps/mobile` with the relevant SDK/simulator installed.

## Docs index

- [`docs/ios-no-mac-workflow.md`](docs/ios-no-mac-workflow.md) — canonical Windows-host,
  iPhone-device workflow: free unsigned-`.ipa` CI builds + Sideloadly (dev-client and
  release, no paid account), offline on-track operation, troubleshooting.
- [`docs/verification/real-track-validation-checklist.md`](docs/verification/real-track-validation-checklist.md) —
  printable physical validation protocol at Transilvania Motor Ring.
- [`docs/verification/baseline.md`](docs/verification/baseline.md) — repository state at project start.
- [`docs/architecture/contracts.md`](docs/architecture/contracts.md) — binding module contracts (canonical interfaces).
- [`docs/architecture/current-state.md`](docs/architecture/current-state.md) — living summary of the target architecture.
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — work-package breakdown and verification strategy.
- [`docs/research/transilvania-motor-ring.md`](docs/research/transilvania-motor-ring.md) — circuit research packet
  (location, length, OSM geometry addendum, known gaps).
- [`docs/decisions/ADR-0001-stack.md`](docs/decisions/ADR-0001-stack.md) — mobile stack: React Native (Expo) + TypeScript monorepo.
- [`docs/decisions/ADR-0002-circuit-geometry-source.md`](docs/decisions/ADR-0002-circuit-geometry-source.md) — circuit geometry
  provenance (OSM-derived centerline, app-defined gates) and license attribution.
- [`docs/decisions/ADR-0003-ios-primary-target.md`](docs/decisions/ADR-0003-ios-primary-target.md) — iOS as the primary
  target platform: Location configuration, Info.plist, monotonic timing, thermal/battery, verification gates.
- [`docs/decisions/ADR-0004-no-mac-ios-workflow.md`](docs/decisions/ADR-0004-no-mac-ios-workflow.md) — iOS without a Mac:
  original Expo Go development + EAS cloud builds decision; dev-loop portion superseded by ADR-0005.
- [`docs/decisions/ADR-0005-free-install-path.md`](docs/decisions/ADR-0005-free-install-path.md) — free iOS install
  path: GitHub Actions unsigned `.ipa` builds + Sideloadly (free Apple ID), replacing the retired Expo Go dev loop.
- [`docs/algorithms/calibration.md`](docs/algorithms/calibration.md) — the Learn-lap calibration engine: quality
  thresholds, coverage bins, direction detection, bounded bias estimation, acceptance criteria, confidence blend.
- [`docs/algorithms/timing-and-crossings.md`](docs/algorithms/timing-and-crossings.md) — directed-gate crossing
  semantics, rearm/debounce, lap/sector validity rules and invalid-reason codes, monotonic-time rules.
- [`docs/algorithms/live-delta.md`](docs/algorithms/live-delta.md) — reference-lap resampling, PB replacement rules,
  live delta computation, EMA smoothing, confidence/staleness handling, sign convention.
- [`docs/persistence-model.md`](docs/persistence-model.md) — SQL table schema (v1/v2), migration approach, checkpoint
  cadence, ADR-0003 §3 recovery flow, `sessionId` convention, `deleteUserData` coverage, retention.
- [`docs/testing-and-replay.md`](docs/testing-and-replay.md) — test architecture (unit/property/contract/integration),
  the fixture catalog, how to run the suites, using `DevReplayScreen` on-device, determinism rules.
- [`docs/known-limitations.md`](docs/known-limitations.md) — an honest list of the app's real constraints and
  implementation gaps.
- [`docs/privacy.md`](docs/privacy.md) — data inventory, permission posture, deletion path, diagnostics content,
  the advisory-tool disclaimer.
- [`docs/adding-a-circuit.md`](docs/adding-a-circuit.md) — onboarding a future circuit: profile schema, provenance
  rules, the generator-script pattern, validation gates, `layoutVersion` discipline.

## License / attribution

Circuit centerline and pit-lane geometry are derived from OpenStreetMap (way `488429454` and way `488429716`),
© OpenStreetMap contributors, licensed under the **Open Database License (ODbL) 1.0**. Start/finish and sector
gates are **app-defined**, not official — see `docs/decisions/ADR-0002-circuit-geometry-source.md` for full
provenance and the attribution requirement.

## Known limitations

- Native binaries are not built or verified on this machine; only the Metro
  (JS bundle) export is machine-verifiable here, per `docs/decisions/ADR-0001-stack.md`.
  Native builds (APK/IPA) run via EAS Build in the cloud.
- Circuit geometry is community-derived (OpenStreetMap), and start/finish/sector gates
  are app-defined, not sourced from official circuit or FIM/FIA documentation — see
  `docs/decisions/ADR-0002-circuit-geometry-source.md`. Physical on-track validation
  (`docs/verification/real-track-validation-checklist.md`) is the reference check against
  this gap.
