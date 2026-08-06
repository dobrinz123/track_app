# Circuit Timer

Offline-capable GNSS track lap-timing app (React Native / Expo + a pure TypeScript
timing/geometry core). See `docs/decisions/ADR-0001-stack.md` for the stack decision
and `docs/architecture/contracts.md` for the binding module contracts.

## Monorepo layout

npm workspaces (`packages/*`, `apps/*`):

```
packages/core/    @circuit/core — pure TypeScript domain package (geometry, timing,
                  calibration, session-state contracts). Zero React/React
                  Native/Expo imports, enforced by an ESLint no-restricted-imports
                  rule. Vitest + fast-check for unit/property tests, Zod for schema
                  validation.
apps/mobile/      mobile — Expo (TypeScript) app shell. Imports @circuit/core via
                  the workspace; Metro is configured for monorepo resolution.
```

## Prerequisites

- Node.js 24.x and npm 11.x
- No Android SDK / Xcode / Flutter required for typecheck, test, lint, or the
  Metro export step below. Native builds (APK/IPA) additionally require Android
  Studio / Xcode or [EAS Build](https://docs.expo.dev/build/introduction/), which
  are out of scope for this machine.

## Install

```
npm install
```

Installs and links all workspaces from the repo root (do not `npm install` inside
individual packages).

## Run / verify

From the repo root:

```
npm run typecheck   # tsc --noEmit across all workspaces
npm test             # vitest run in packages/core
npm run lint          # eslint . (flat config, applied to both workspaces)
npm run format         # prettier --write .
```

To verify the mobile app bundles correctly with Metro (no Android SDK needed):

```
cd apps/mobile
npx expo export --platform android --output-dir dist-export
```

To run the app itself (requires Android SDK/emulator, Xcode/simulator, or the
Expo Go app on a physical device):

```
cd apps/mobile
npm run android   # or: npm run ios / npm run web
```

## Known limitations

- Native binaries are not built or verified on this machine; only the Metro
  (JS bundle) export is machine-verifiable here, per ADR-0001.
- `apps/mobile` is a minimal scaffold shell (single screen proving
  `@circuit/core` wiring) — no feature UI or domain logic is implemented yet.
