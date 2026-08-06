# Privacy

What this app collects, where it goes, what stays on the device, and how a driver can remove their
data. This document describes the app as implemented — see `docs/persistence-model.md` for the
storage layer this summarizes, and `docs/known-limitations.md` for the gaps called out below.

## Data inventory

| Data | Collected when | Stored where | Sent over the network? |
|---|---|---|---|
| Precise GNSS location (`lat`/`lon`/`accuracyM`/`speedMps`/`headingDeg`/`altitudeM`) | continuously while a session is active (calibration + timed laps), foreground only | on-device SQLite, per-lap, in the `telemetry` table (`docs/persistence-model.md`) | never |
| Personal-best reference lap (resampled distance/time grid + provenance) | whenever a valid lap beats the stored PB | on-device SQLite `reference_laps` table | never |
| Session/lap summaries (times, sector times, validity) | at session end / per lap | on-device SQLite `sessions`/`laps` tables | never |
| App settings (units, delta deadband, coverage bins) | on user change | on-device SQLite `settings` table (v2) | never |
| GNSS diagnostics (sample-interval/accuracy rolling windows, mocked-sample count, reduced-accuracy flag) | continuously while the location provider runs | in-memory only (`GnssLocationProvider.getDiagnostics()`) — not persisted, not currently surfaced in any UI (see `docs/known-limitations.md`) | never |

**Precise location is persisted locally only, per session, and is never transmitted anywhere.**
This is a structural property of the codebase, not a policy statement: `docs/architecture/current-state.md`'s
recorded offline audit found **zero** `fetch(`/`XMLHttpRequest`/`axios`/`WebSocket` occurrences
anywhere in `apps/mobile/src` or `packages/core/src`, and no `expo-updates`, analytics, or
network-library imports or dependencies anywhere in the project. The circuit profile itself is a
statically bundled JSON asset compiled into the app bundle (verified by scanning the compiled
Hermes bytecode for JSON-only strings, e.g. the OSM license string, present only in the asset and
never fetched — `docs/architecture/current-state.md`), so even circuit geometry involves no runtime
network call. The real-track validation checklist's item 16 (airplane-mode-with-GPS test) is the
physical confirmation of this property on-device.

**No analytics, no telemetry-to-a-server, no crash reporting.** There is no analytics SDK, no
remote logging, and no third-party data-collection dependency anywhere in `package.json` for either
workspace.

## Permission posture

- **Foreground location only.** `apps/mobile/src/platform/permissions.ts` requests only
  `Location.requestForegroundPermissionsAsync()`; `Location.requestBackgroundPermissionsAsync()` is
  never called, deliberately (see its doc comment: Google Play's background-location policy
  friction, and the app's foreground-only session design — ADR-0003 §1). No `UIBackgroundModes:
  location` capability is declared.
- **Rationale copy shown before prompting**: *"Circuit Timer needs your location while the app is
  open, to time your laps and sectors on track. Location is only used during an active session and
  never in the background."* (`LOCATION_PERMISSION_RATIONALE`, `permissions.ts`).
- **No Always-authorization keys** in `Info.plist` (ADR-0003 §2) — only
  `NSLocationWhenInUseUsageDescription`.
- **Precise Location enforcement**: iOS 14+'s reduced-accuracy mode (`~1900 m` radius) is
  functionally unusable for lap timing, so `PreflightScreen`/`preflight.ts` treats
  `PRECISE_LOCATION_OFF` as a hard preflight failure rather than a silent degradation, with
  in-app instructions (`PRECISE_LOCATION_INSTRUCTIONS`) pointing to Settings → Privacy & Security →
  Location Services → Circuit Timer → Precise Location.
- **No microphone, camera, contacts, photo library, or any other sensitive permission** is
  requested anywhere in the app.

## Deletion path

`LocalSessionRepository.deleteUserData(userId)` is implemented in both backing repositories
(`InMemorySessionRepository`, `SqlSessionRepository`) and removes, atomically: every session,
lap, checkpoint, and telemetry row the user owns (including orphaned checkpoints/telemetry for a
session that was never fully saved, swept by the `${userId}--` sessionId prefix), plus the user's
stored reference lap — see `docs/persistence-model.md` for the exact coverage.

**As of this writing there is no UI entry point for it.** Nothing in `apps/mobile/src` calls
`deleteUserData` — there is no "Delete my data" control on `SettingsScreen` or elsewhere. A driver
who wants their on-device data removed today has to uninstall the app (which deletes the app's
private SQLite database along with it, the platform's normal app-data lifecycle) — the in-app
programmatic deletion path exists in the repository layer but is not yet reachable from the UI.
See `docs/known-limitations.md`.

## Diagnostics content

`GnssLocationProvider.getDiagnostics()` (`apps/mobile/src/platform/gnssLocationProvider.ts`)
computes, from an in-memory rolling window of the last 300 emitted samples:

- total samples emitted;
- Android-only rejected-mocked-location count (always 0 on iOS — no equivalent SDK flag exists
  there);
- a histogram of inter-sample arrival gaps, bucketed at `<200ms, <500ms, <1000ms, <2000ms,
  <5000ms, ≥5000ms`;
- min/p50/p95 of reported horizontal accuracy over the window;
- the iOS reduced-accuracy authorization flag snapshotted at session start.

None of this is persisted to disk and none of it leaves the device — it lives only in the
`GnssLocationProvider` instance's memory for the current process lifetime. As noted in
`docs/known-limitations.md`, there is currently no screen that reads or displays it; the
validation checklist's "diagnostics export" item currently has nothing to screenshot.

## Advisory-tool disclaimer

Shown on `SettingsScreen`'s About card and stated in the README and the real-track validation
checklist header: **this app is advisory and recreational, not an official or certified timing
system** — it does not replace organizer or FIM/FIA timing, and must not be relied on for
competitive scoring or safety-critical decisions. This applies to every timing/geometry claim the
app makes, not just to the data-handling practices described above: circuit geometry is
community-derived from OpenStreetMap and start/finish/sector gates are app-defined
(`docs/decisions/ADR-0002-circuit-geometry-source.md`), and GNSS-derived timing has an inherent
precision ceiling (`docs/known-limitations.md`).
