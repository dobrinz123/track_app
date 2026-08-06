# Real-Track Validation Checklist — Transilvania Motor Ring

Printable, iOS-first physical validation protocol. This is the reference validation pass for the app (ADR-0003 §Consequences: "Physical validation on an iPhone is the reference validation pass"). Circuit geometry is community-derived from OpenStreetMap and app-defined start/finish and sector gates (see `docs/decisions/ADR-0002-circuit-geometry-source.md`); this checklist is exactly how that advisory-recreational geometry gets validated against reality on-site at Transilvania Motor Ring (Cerghid, Mureș County, Romania — 46.43528°N 24.42694°E, `docs/research/transilvania-motor-ring.md`).

This app is **advisory and recreational**, not an official timing system. It does not replace organizer or FIM/FIA timing.

**Precondition — build type and install path:** this protocol assumes a **standalone EAS-built app** (never Expo Go — there is no PC/Metro/Wi-Fi on-track). Per the ADR-0004 Amendment, record which install path was used before starting: ☐ TestFlight/ad-hoc (Apple Developer Program, paid) ☐ Sideloaded `preview` build (AltStore/Sideloadly, free, 7-day signature — confirm not expired). See `docs/ios-no-mac-workflow.md` §5–6 for both paths.

---

## Session header (fill in before starting)

| Field | Value |
|---|---|
| Date | |
| Driver / operator | |
| Circuit / layout | Transilvania Motor Ring, full layout |
| **Device model** | |
| **iOS version** | |
| **Build type** | ☐ TestFlight standalone ☐ Ad-hoc standalone ☐ Sideloaded (`preview`, AltStore/Sideloadly) — REQUIRED for the reference pass, see note below ☐ Expo Go (dev/exploratory only, not a valid reference pass) |
| **Install path** | ☐ (a) Apple Developer Program + TestFlight/ad-hoc ☐ (b) Free sideload (AltStore/Sideloadly) — if (b), signature date: __________ (7-day expiry) |
| App version / build number | |
| **Phone mounting position** | |
| Weather / conditions | |
| Session duration (target) | |

> **Build-type requirement:** the reference validation pass **must** use a standalone EAS-built app — TestFlight/ad-hoc or a sideloaded `preview` `.ipa` — per `docs/decisions/ADR-0004-no-mac-ios-workflow.md` §3 and its Amendment: on-track sessions require offline operation (no Metro/PC/Wi-Fi at the circuit) and only a standalone build has ADR-0003's Info.plist and precise-accuracy configuration actually in effect. Expo Go is for development and replay verification only — it is not viable on-track and a session recorded in Expo Go does not satisfy this checklist's reference-pass requirement (see `docs/ios-no-mac-workflow.md` §3 for the Info.plist caveat).

---

## Checklist items

Each item lists the expected outcome and a pass/fail field. Record actual observed values where applicable.

### 1. GNSS update frequency
- **Expected:** ~1 Hz foreground update rate, as observed on the diagnostics screen.
- Observed rate: __________ Hz
- ☐ Pass ☐ Fail — notes: ______________________

### 2. Horizontal-accuracy distribution
- **Expected:** stable accuracy suitable for lap timing; record the distribution rather than a single pass/fail threshold.
- p50 horizontal accuracy: __________ m
- p95 horizontal accuracy: __________ m
- ☐ Pass ☐ Fail — notes: ______________________

### 3. Thermal behavior over a 30-minute session
- **Expected:** device remains usable for the full session; note any thermal throttling, brightness reduction, or app slowdown observed.
- Thermal state observed (start / mid / end): ______________________
- ☐ Pass ☐ Fail — notes: ______________________

### 4. Recognition-lap acceptance on first attempt
- **Expected:** the calibration/recognition lap is accepted on the first attempt under normal driving conditions.
- ☐ Pass ☐ Fail — notes: ______________________

### 5. Calibration failure messaging when aborting mid-lap
- **Expected:** aborting calibration mid-lap produces clear, honest failure messaging (not a silent failure or a misleading success).
- ☐ Pass ☐ Fail — notes: ______________________

### 6. Pit-lane transit → lap invalidated + pit states visited
- **Expected:** driving through the pit lane during a timed lap invalidates that lap, and the session/state machine visits the expected pit-related states (e.g. `inPit`).
- ☐ Pass ☐ Fail — notes: ______________________

### 7. Start/finish detection across ≥10 laps
- **Expected:** zero missed crossings, zero duplicate crossings, across at least 10 consecutive laps.
- Laps completed: __________ Missed: __________ Duplicated: __________
- ☐ Pass ☐ Fail — notes: ______________________

### 8. Sector crossing detection consistency
- **Expected:** each sector gate is crossed once per lap, consistently, across the session.
- ☐ Pass ☐ Fail — notes: ______________________

### 9. Stop-on-line no-duplicate test
- **Expected:** stopping the vehicle directly ON the start/finish line for 30 seconds produces no duplicate crossing events (the gate debounce/rearm logic holds).
- ☐ Pass ☐ Fail — notes: ______________________

### 10. Comparison against an independent timer
- **Expected:** agreement within approximately **±0.3 s** against a hand-timed or organizer-timed reference. Note: GNSS interpolation at ~1 Hz bounds achievable precision — this window reflects that constraint, not a defect if exceeded slightly.
- Independent timer type: ☐ Hand-timed ☐ Organizer timing
- Lap-by-lap deltas: ______________________
- ☐ Pass ☐ Fail — notes: ______________________

### 11. Live-delta stability
- **Expected:** no flicker greater than ±0.5 s between consecutive live-delta updates on steady (non-eventful) laps.
- ☐ Pass ☐ Fail — notes: ______________________

### 12. PB replacement after a genuinely faster lap
- **Expected:** a valid, genuinely faster lap replaces the stored personal best; an invalid or slower lap does not.
- ☐ Pass ☐ Fail — notes: ______________________

### 13. App backgrounding mid-lap → documented recovery behavior
- **Expected:** backgrounding the app mid-lap invalidates that lap, and the session remains recoverable afterward (per the foreground-only design in ADR-0003 §1).
- ☐ Pass ☐ Fail — notes: ______________________

### 14. Battery consumption per 30 minutes
- **Expected:** recorded for reference; no fixed pass/fail threshold.
- Battery % consumed: __________ %

### 15. Diagnostics export
- **Expected:** diagnostics screen export captured for the record.
- ☐ Screenshot attached

### 16. Offline operation (airplane-mode-with-GPS test)
- **Expected:** with airplane mode **ON** and Location Services **ON**, a full session (calibration through session end) completes with no degradation attributable to lack of network connectivity — confirming the app makes zero network calls on any session-critical path (per the ADR-0004 Amendment and `docs/ios-no-mac-workflow.md` §7).
- ☐ Pass ☐ Fail — notes: ______________________

---

## Footer

**Configurable-thresholds note:** all quality, accuracy, and timing thresholds referenced above must remain configurable rather than tuned to this one device or this one session — do not hard-code values discovered here as universal constants (mission constraint: the app must not be tuned to a single device).

**Sign-off**

| | |
|---|---|
| Overall result | ☐ Pass ☐ Pass with notes ☐ Fail |
| Validated by | |
| Date | |
| Signature | |

---

See also: `docs/ios-no-mac-workflow.md` (build/install instructions), `docs/decisions/ADR-0002-circuit-geometry-source.md` (geometry provenance), `docs/decisions/ADR-0003-ios-primary-target.md` (iOS configuration), `docs/decisions/ADR-0004-no-mac-ios-workflow.md` (build-type requirement).
