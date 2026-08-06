# Calibration (the Learn lap)

How `CalibrationEngine` (`packages/core/src/calibration/calibration-engine.ts`) turns one driven
lap into an accept/reject verdict plus a bounded position bias. Consumed live by
`SessionController.start('calibration')` (`packages/core/src/controller/sessionController.ts`) and
batch-driven by `runCalibration` (`packages/core/src/replay/replay-harness.ts`) for tests/replay.

## What calibration is for — and what it is NOT

Calibration answers one question: *is this lap's GNSS trace good enough, on-track enough, and in
the right direction to trust for lap timing?* It also estimates a small constant position offset
(the "bias") to correct systematic GNSS bias for this session.

**Calibration never creates or edits circuit geometry.** The centerline, gates, and sectors it
matches against come entirely from the `CircuitProfile`/`RuntimeProfile` passed into the engine's
constructor (built once, offline, by the profile generator — see `docs/adding-a-circuit.md`).
Calibration only decides whether *this session's* telemetry is trustworthy against that
already-fixed geometry, and computes a bounded per-session bias correction; it has no path back
into the stored profile.

## Feed loop

`feed(sample)` runs once per incoming `LocationSample`, in this order (`calibration-engine.ts:123-169`):

1. **Quality assessment** — `TelemetryQualityEvaluator.assess()` (see quality thresholds below).
2. **Track match** — an internal `TrackMatcher` (own instance, `corridorWidthM: 20` by default —
   see the note under "Corridor width" below) projects the sample onto the centerline.
3. **Accept/reject gate** — a sample is accepted only if quality is `'good'` or `'degraded'` AND a
   match exists AND `|lateralM| <= corridorWidthM`. Otherwise it's rejected and a reason is
   recorded (`OFF_CORRIDOR`, or the quality evaluator's own reason codes, or a fallback
   `INVALID_SAMPLE`/`LOW_QUALITY`).
4. **Coverage marking** — accepted samples mark the centerline bin(s) they fall in as covered
   (see "Coverage bins" below), including bins spanned between this and the previous accepted
   sample.
5. **Direction voting** — the signed forward/backward progress delta between consecutive accepted
   samples accumulates into `positiveDirectionM`/`negativeDirectionM`.
6. **Bias sample collection** — the projected point, lateral offset, and segment index are stored
   for the post-hoc bias solve in `finish()`.

## Quality thresholds

Calibration's `TrackMatcher` and its own `TelemetryQualityEvaluator` use the shared defaults from
`packages/core/src/matching/quality-evaluator.ts` (`DEFAULT_TELEMETRY_QUALITY_CONFIG`):

| Threshold | Value | Effect |
|---|---|---|
| `degradedAccuracyM` | 12 m | accuracy above this → `degraded` |
| `unreliableAccuracyM` | 25 m | accuracy above this → `unreliable` |
| `invalidAccuracyM` | 50 m | accuracy above this → `invalid` (`ACCURACY_ABOVE_50M`) |
| `degradedGapMs` | 1,500 ms | inter-sample gap above this → `degraded` |
| `unreliableGapMs` | 3,000 ms | inter-sample gap above this → `unreliable` |
| `unreliableSpeedMps` | 85 m/s | implied speed above this → `unreliable` |
| `invalidSpeedMps` | 120 m/s | implied speed above this → `invalid` (`IMPOSSIBLE_JUMP`) |

A sample is also `invalid` for missing/non-finite coordinates, a non-finite timestamp, a
duplicate/non-increasing timestamp versus the previous sample, or a negative/non-finite accuracy
value. Only `'good'` and `'degraded'` samples are eligible for calibration acceptance; `feed()`
still remembers `'unreliable'`/`degraded` (not `'invalid'`) samples as `previousQualitySample` so
the next gap/speed check has a valid anchor.

## Coverage bins

The centerline is divided into `Math.ceil(totalLengthM / coverageBinM)` bins, `coverageBinM = 25`
by default (`calibration-engine.ts:18,231`). A bin is a boolean — once covered, always covered
(coverage never regresses within a session). Beyond marking the single bin a sample lands in,
`markCoverageBetween()` also marks every bin on the straight-line path between the previous
accepted sample's progress and the current one, provided the step is not implausibly large
(`> max(100, coverageBinM * 4)` meters is treated as a jump and skipped, not marked). `coverageFraction`
is simply `covered bins / total bins`.

## Direction detection

Every pair of consecutive accepted samples contributes its signed unwrapped-progress delta to
`positiveDirectionM` or `negativeDirectionM` (deltas under 0.5 m are dropped as noise;
`calibration-engine.ts:146-153`). `directionDetected()` requires at least `coverageBinM` (25 m)
of combined voting evidence, then calls it `unknown` unless one direction holds **≥60%** of the
total voted distance — in which case the detected direction is the profile's own centerline
winding order (`clockwise`/`counterclockwise`, from the signed polygon area of the centerline) or
its reverse. `expectedDirection` defaults to that same centerline winding unless the caller
explicitly overrides `CalibrationConfig.direction`.

## Bounded bias estimation

`estimateBias()` (`calibration-engine.ts:299-328`) runs only once **≥10** accepted points exist;
otherwise it returns a zero bias. The estimate is a two-pass least-squares solve against each
point's lateral residual and the centerline's local normal vector:

1. Solve a 2×2 normal-equations system (`solveBias`) over *all* accepted points to get an initial
   bias estimate.
2. Compute each point's residual against that initial estimate, sort by residual, and **trim the
   outer 10% on each side** (a crude but cheap outlier rejection).
3. Re-solve on the trimmed set to get the candidate bias.

The candidate is **only applied if both** of the following hold — otherwise the bias is zero:

- **Magnitude gate**: `1.5 <= |candidate| <= 8` meters (`calibration-engine.ts:323`). Anything
  smaller is treated as noise not worth correcting; anything larger is treated as an untrustworthy
  solve rather than genuine GNSS bias.
- **Improvement gate**: the p95 of `|lateralM|` after applying the candidate bias must be `<= 80%`
  of the p95 before (`before > 0 && after <= before * 0.8`, `calibration-engine.ts:325-327`) — the
  correction must measurably tighten the lateral spread, not just move it.

## Acceptance criteria

`finish()` (`calibration-engine.ts:179-220`) computes `failureReasons` — the lap is `accepted`
only when this list is empty:

| Failure code | Condition |
|---|---|
| `INSUFFICIENT_COVERAGE` | `coverageFraction < 0.95` |
| `WRONG_DIRECTION` | `directionDetected !== expectedDirection` |
| `POOR_GNSS` | rejected-sample fraction `> 0.3` of all samples fed |
| `RATE_TOO_LOW` | observed sample rate `< 0.5` Hz |
| `COVERAGE_GAP` | the single longest run of uncovered bins exceeds 100 m |

`CANCELLED` is added separately by `SessionController.rejectCalibration()` when the driver
long-presses cancel mid-lap (`sessionController.ts:317-330`) — it is not produced by
`CalibrationEngine` itself.

### Why the live auto-finish threshold (98%) is above the acceptance bar (95%)

`SessionController` auto-calls `finish()` once live coverage reaches **98%**
(`CALIBRATION_COMPLETE_COVERAGE_FRACTION`, `sessionController.ts:81`), not the moment it crosses
the 95% acceptance bar above. Verbatim from the code comment (`sessionController.ts:67-80`):

> Calibration is treated as "done" once the Learn lap has observed this much of the centerline.
> Deliberately set ABOVE `CalibrationEngine.finish()`'s own >=95% `INSUFFICIENT_COVERAGE` bar
> (`calibration-engine.ts`): finishing the instant coverage first crosses 95% cuts the lap short by
> a handful of samples relative to driving it to a natural close, which measurably changes the
> verdict on other criteria that keep firming up until the lap actually completes (direction-vote
> confidence, observed sample rate, rejected-sample fraction) — confirmed by feeding a full
> recognition lap through this exact finish-on-threshold logic in
> `packages/core/test/controller/sessionController.test.ts`. Coverage bins are monotonically set
> (never unset), so this can only be reached once and never regresses.

There is no calibration-stall timeout: if coverage never reaches 98% the Learn lap simply keeps
running until the driver manually cancels it (see `docs/known-limitations.md`).

## Confidence blend

`confidence` (independent of `accepted`) is a weighted blend, each term clamped to `[0,1]`
(`calibration-engine.ts:208-212`):

```
confidence = coverageFraction * 0.45
           + (samplesAccepted / totalSamples) * 0.30
           + clamp01(1 - p95LateralM / corridorWidthM) * 0.25
```

A confidence value is always produced, even on a rejected calibration — it's shown regardless of
`accepted` on the calibration result screen for accepted results (`CalibrationResultScreen.tsx`).

## Failure codes and their user-facing meaning

`CalibrationResultScreen.tsx` (`REASON_COPY`) maps failure codes to driver-facing copy:

| Code | User-facing message |
|---|---|
| `INSUFFICIENT_COVERAGE` | "The lap didn't cover enough of the circuit to calibrate confidently." |
| *(all other codes)* | falls back to a generic humanizer — the code with underscores replaced by spaces, lowercased (e.g. `WRONG_DIRECTION` → "wrong direction") |

**Implementation note (reported, not fixed — out of this ticket's scope):** `REASON_COPY` also
defines bespoke copy for `ACCURACY_ABOVE_20M`, `DIRECTION_UNCERTAIN`, and `LOW_SAMPLE_RATE`, but
`CalibrationEngine.finish()` never emits any of those three codes — the real codes it emits for
those situations are `POOR_GNSS`, `WRONG_DIRECTION`, and `RATE_TOO_LOW` respectively. Those three
`REASON_COPY` entries are currently dead, and `WRONG_DIRECTION`/`POOR_GNSS`/`RATE_TOO_LOW`/
`COVERAGE_GAP`/`CANCELLED` all fall through to the generic humanizer instead of bespoke copy.

## Corridor width — a wiring note

`CalibrationEngine`'s and `TrackMatcher`'s own `corridorWidthM` default independently to **20
meters** (`DEFAULT_CONFIG.corridorWidthM` in both `calibration-engine.ts` and `track-matcher.ts`).
The circuit profile's own `corridorWidthM` (15 m for Transilvania Motor Ring, see
`docs/adding-a-circuit.md`) is used only by profile *validation* (`profile/validation.ts`'s
`CORRIDOR_WIDTH_OUT_OF_RANGE` bound check and its gate-endpoint-distance tolerance) — it is never
passed into the live `CalibrationConfig`/`TrackMatcherConfig` corridor width anywhere in
`apps/mobile/src/session/composition.ts`. Both the calibration and live-matching corridor in
production therefore run at the 20 m default, not the profile's 15 m value.
