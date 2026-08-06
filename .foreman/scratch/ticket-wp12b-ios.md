TASK: Harden the platform layer and app config for iOS as the PRIMARY target, per ADR-0003. Cross-platform behavior must not regress.

EXPECTED OUTCOME: `npm run typecheck`, `npm run lint` pass from repo root; BOTH `npx expo export --platform ios` AND `npx expo export --platform android` exit 0 in apps/mobile producing .hbc bundles. Paste decisive output.

CONTEXT: Read first: docs/decisions/ADR-0003-ios-primary-target.md (binding), apps/mobile/src/platform/ (existing GnssLocationProvider, preflight, permissions), apps/mobile/app.json, .foreman/scratch/platform-research.md §iOS. Expo SDK 57 — verify exact expo-location option names against the installed package's TypeScript types (node_modules/expo-location/build/*.d.ts) rather than memory.

CONSTRAINTS: Write set below; no new dependencies; do NOT run npm install (lockfile owned by a concurrent worker); do NOT touch apps/mobile/src/persistence/** or packages/core/**. TypeScript strict.

MUST DO:
1. GnssLocationProvider: add iOS-directed options per ADR-0003 — accuracy BestForNavigation (already), activityType AutomotiveNavigation, pausesUpdatesAutomatically:false — passing exactly the option names expo-location SDK 57 supports (check the .d.ts; if an option is Android/iOS-specific, document per-platform applicability inline). Verify `mayShowUserSettingsDialog` etc. only if present in types.
2. permissions.ts / preflight.ts: detect iOS reduced-accuracy (`LocationPermissionResponse.ios.scope` / `accuracy` fields per SDK types); if reduced ('reduced' vs 'full'), attempt `Location.enableNetworkProviderAsync`-equivalent? NO — the correct API is requesting temporary full accuracy: use expo-location's `useForegroundPermissions`/`requestForegroundPermissionsAsync` response and, if reduced, surface preflight failure 'PRECISE_LOCATION_OFF' with instructions (Settings > Privacy > Location > app > Precise Location). If expo-location SDK 57 exposes a temporary-full-accuracy request API, wire it; if not, document the gap and rely on the Info.plist temporary-usage dictionary + preflight messaging.
3. app.json: add `NSLocationTemporaryUsageDescriptionDictionary` with purpose key `TrackSession` and honest copy; confirm NSLocationWhenInUseUsageDescription copy is specific ("records your position on track during an active session to time laps and sectors"); NO UIBackgroundModes; NO Always keys (verify current suppression still holds); set `ios.supportsTablet` false if not already decided (portrait-first phone app), `ios.requireFullScreen` true, orientation 'portrait' at root if not set.
4. clock.ts: add JSDoc documenting iOS monotonicity semantics per ADR-0003 §3 (performance.now under Hermes, per-launch origin, recovery rule).
5. preflight.ts: add thermal-state check IF an Expo/RN API is available without new deps (check expo-device / expo-constants types already installed — if none expose thermal state, implement as 'not available' with a documented TODO and no fake data).
6. Add `export:ios` and `export:android` npm scripts in apps/mobile/package.json (no install needed) and run both exports as your verification.
7. Diagnostics: extend GnssDiagnostics counter object with fields the iOS validation will need: observed sample intervals histogram (last 300), accuracyM distribution summary (min/p50/p95), mocked-rejected count (existing), reducedAccuracy flag. Pure TS, no UI changes.

MUST NOT: add dependencies or run npm install; touch persistence/core; add background location; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions (esp. exact SDK 57 API names found in the .d.ts), commands + pasted results, limitations, integration notes.

WRITE SET: apps/mobile/src/platform/**, apps/mobile/app.json, apps/mobile/package.json (scripts only), apps/mobile/App.tsx (only if wiring proof requires).
