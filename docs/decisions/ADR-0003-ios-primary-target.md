# ADR-0003 — iOS is the primary target platform

Date: 2026-08-06 · Status: Accepted · Decider: user (product decision), implemented by Fable 5

## Context

User decision: the app will be used on iOS. Architecture remains cross-platform (Expo/RN), but iOS configuration, permissions, timing behavior, docs, and validation must be complete, verified, and treated as primary.

## Decision

1. **Core Location configuration** (via expo-location, which wraps CLLocationManager):
   - `accuracy: BestForNavigation` (CL `kCLLocationAccuracyBestForNavigation` — intended for vehicular navigation, uses additional sensor fusion).
   - `activityType: AutomotiveNavigation` and `pausesUpdatesAutomatically: false` — **amended 2026-08-06 after WP12b source-level verification:** expo-location SDK 57 does NOT expose either option on the foreground `watchPositionAsync` path (they are wired only into the background-task consumer, which requires the forbidden `UIBackgroundModes: location`). Resolution: accept the SDK gap on the foreground path; mitigate CL's default auto-pause risk (stationary periods, e.g. long pit stops) with a **session watchdog** (binding on WP14 integration): while a session is active and not `paused`, if no location sample arrives for > 5 s, stop and restart the watch subscription (resets CL pause state), incrementing a `watchRestarts` diagnostics counter. Revisit with a custom config plugin only if physical validation shows persistent pause/resume gaps (breaks Expo Go dev loop — ADR-0004 trade-off).
   - Foreground-only: **no** `UIBackgroundModes: location`. The driving screen holds keep-awake; sessions are foreground by design (MVP). Background modes are only added if a future product decision requires timing to survive app backgrounding.
2. **Info.plist**: `NSLocationWhenInUseUsageDescription` with honest, specific copy; **no** Always-authorization keys. Reduced-accuracy: request full accuracy via `NSLocationTemporaryUsageDescriptionDictionary` (purpose key `TrackSession`) when the user has Precise Location off — precise location is functionally required; preflight detects reduced accuracy and explains.
3. **Monotonic timing on iOS**: `performance.now()` under Hermes/JSI is monotonic (mach_continuous_time-derived); samples are stamped at receipt. Wall-clock (`Date.now`, CLLocation.timestamp) remains metadata only. Note: `performance.now()` origin resets per process launch — checkpoint recovery must never mix tMono across launches (recovery treats restored laps as historical, never resumes an in-flight lap timer).
4. **Thermal/battery (iOS)**: continuous BestForNavigation GNSS + screen-on is a high-drain profile (research packet: 5–10%/hour class); iOS thermal throttling can reduce GNSS quality — diagnostics screen surfaces `ProcessInfo.thermalState` if exposed by an Expo API, else documents observation guidance; validation checklist includes thermal observation on-device.
5. **Verification gates** now include `npx expo export --platform ios` alongside android export. Native iOS build (Xcode/EAS) documented as the out-of-machine step with exact commands.
6. **Docs are iOS-first**: run instructions, permission setup, and the real-track validation checklist lead with iOS; Android remains supported and documented second.

## Consequences

- WP12b (iOS platform hardening) added; WP14 integration + docs deliverables reordered iOS-first.
- Physical validation on an iPhone is the reference validation pass.
