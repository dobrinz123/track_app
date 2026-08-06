TASK: Implement the mobile platform integration layer in apps/mobile: location/motion providers, monotonic clock, permissions flow, preflight checks, lifecycle handling, and native config — per the researched platform constraints.

EXPECTED OUTCOME: `npm run typecheck`, `npm run lint` pass from repo root; `npx expo export --platform android --output-dir dist-export` exits 0 from apps/mobile. Paste decisive output. (No device/emulator available — runtime behavior is validated later on hardware; your job is correct API usage per current Expo SDK docs.)

CONTEXT: Read first: docs/architecture/contracts.md (LocationProvider, MonotonicClock, LocationSample, FixSource — binding, from @circuit/core); .foreman/scratch/platform-research.md (sourced platform evidence: Expo SDK 57, ~1 Hz GNSS foreground, performance.now() monotonic, Android 14+ FOREGROUND_SERVICE_TYPE_LOCATION, iOS Info.plist keys); docs/decisions/ADR-0001-stack.md. Existing app shell: apps/mobile (blank TS Expo app importing @circuit/core).

CONSTRAINTS: all code under apps/mobile/src/platform/ (new). You may edit apps/mobile/app.json (config plugins/permissions), apps/mobile/package.json (add ONLY: expo-location, expo-sensors, expo-keep-awake, expo-sqlite, expo-task-manager — via `npx expo install` so versions match SDK 57), apps/mobile/App.tsx minimally if wiring proof requires it. Root package-lock.json will change via install — that is in your write set. TypeScript strict. Do NOT touch packages/core/** at all (concurrent workers own it).

MUST DO:
1. `GnssLocationProvider implements LocationProvider` (from @circuit/core): expo-location watchPositionAsync, Accuracy.BestForNavigation, timeInterval 0/distanceInterval 0 (max rate); maps expo samples → LocationSample with tMono = performance.now() AT RECEIPT plus documented caveat comment (expo timestamp is wall-clock; we stamp arrival), tUtc = sample.timestamp; accuracyM, speedMps, headingDeg, altitudeM mapped when present; source 'gnss'. Mock-location flag: where exposed (Android `mocked`), reject sample (do not emit) and count it — expose a diagnostics counter.
2. `PerformanceNowClock implements MonotonicClock`.
3. `ReplayLocationProvider implements LocationProvider` (app-side dev tool): constructed with LocationSample[], emits at real-time pace or accelerated factor; source 'replay'. (Core-side replay harness is a separate package concern — this one is for the dev UI.)
4. `MotionCapture`: expo-sensors Accelerometer at 10 Hz behind a start/stop interface, buffered, optional (failure to start must not break the session).
5. `permissions.ts`: request flow — foreground location permission with rationale copy; NO background permission request in MVP (foreground-only sessions; document why — Play policy friction, not needed with keep-awake foreground use). Expose `getPermissionState()`.
6. `preflight.ts`: async checks returning a typed report: location services enabled, permission granted, GNSS fix acquired within timeout (subscribe until first sample with accuracyM <= 25 or 30 s timeout), battery not critically low if expo-battery available WITHOUT adding the dep (skip check if module absent — do not add it), keep-awake activatable. Pure decision function `evaluatePreflight(inputs): { pass: boolean; failures: string[] }` separated from the async collectors so it is trivially testable later.
7. `lifecycle.ts`: AppState listener utility that invokes callbacks on active/background transitions; used later for checkpoint-on-background.
8. app.json: expo-location config plugin with locationWhenInUsePermission string explaining track-session usage; Android permissions ACCESS_FINE_LOCATION + ACCESS_COARSE_LOCATION + FOREGROUND_SERVICE + FOREGROUND_SERVICE_LOCATION; iOS NSLocationWhenInUseUsageDescription; UIBackgroundModes NOT added (foreground-only MVP — document). Keep-awake needs no plugin.
9. Every module exports through apps/mobile/src/platform/index.ts. Add concise JSDoc on each public API stating the platform caveat sources (reference platform-research.md by path).

MUST NOT: add any dependency beyond the five listed; touch packages/core; add background-location config; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes.

WRITE SET: apps/mobile/src/platform/**, apps/mobile/app.json, apps/mobile/package.json, apps/mobile/App.tsx (minimal), package-lock.json.
