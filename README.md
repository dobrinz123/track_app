# Circuit Timer

An **advisory, recreational** GNSS lap-timing app for the Transilvania Motor Ring (Cerghid, Mureș County, Romania) — not an official timing system, and no substitute for organizer or FIM/FIA timing. It's a React Native / Expo app (iOS-first, Android supported) backed by a pure TypeScript timing/geometry core.

See `docs/decisions/ADR-0001-stack.md` for the stack decision, `docs/decisions/ADR-0003-ios-primary-target.md` for why iOS is the primary target, and `docs/architecture/contracts.md` for the binding module contracts.

## Quickstart (Windows + iPhone via Expo Go)

Fast dev loop only — see [`docs/ios-no-mac-workflow.md`](docs/ios-no-mac-workflow.md) for the full guide, including the standalone build required for actual on-track use.

```
npm install
cd apps/mobile
npx expo start
```

Scan the printed QR code with the iPhone's **Camera app** to open the project in **Expo Go**. On a restrictive network, use `npx expo start --tunnel` instead.

**On-track use requires a standalone build, not Expo Go** — there's no PC, Metro, or Wi-Fi at the circuit. Build and install it via EAS (TestFlight, or a free sideload with AltStore/Sideloadly); see [`docs/ios-no-mac-workflow.md`](docs/ios-no-mac-workflow.md) §4–7 for both install paths and offline operation.

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

To run the app itself: Expo Go on a physical device (see Quickstart above and
`docs/ios-no-mac-workflow.md`), or `npm run ios` / `npm run android` / `npm run web`
from `apps/mobile` with the relevant SDK/simulator installed.

## Docs index

- [`docs/ios-no-mac-workflow.md`](docs/ios-no-mac-workflow.md) — canonical Windows-host,
  iPhone-device workflow: Expo Go dev loop, EAS standalone builds (paid TestFlight and
  free sideloading paths), offline on-track operation, troubleshooting.
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
  Expo Go development + EAS cloud builds, standalone-build-primary amendment, sideloading.

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
