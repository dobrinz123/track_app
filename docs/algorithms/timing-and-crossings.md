# Timing and crossings

How a stream of matched `LocationSample`s becomes directed gate crossings
(`packages/core/src/timing/crossing-detector.ts`) and how crossings become lap/sector records
(`packages/core/src/timing/lap-timing-engine.ts`), driven per-sample by
`SessionPipelineCore.ingest()` (`packages/core/src/controller/pipelineCore.ts`) — the single
pipeline both the live `SessionController` and the batch `runSessionPipeline`/`ReplayHarness` use.

## Directed-gate semantics

A gate is a fixed segment `a -> b` (local ENU meters, projected once from the profile's lat/lon
gate endpoints — `ProjectedGate` in `crossing-detector.ts`). A crossing is detected by
**segment–segment intersection** (`segmentIntersection`, `packages/core/src/geometry/intersection.ts`)
between the gate segment and the motion segment `prevPosition -> currPosition` for one sample step.

- **Intersection**: computed via orientation determinants (`t`, `u` parameters along each segment),
  inclusive of segment endpoints within a tiny epsilon tolerance
  (`Number.EPSILON * 32`). Parallel, collinear, or zero-length segments never intersect (return
  `null`).
- **Crossing direction sign** (`crossingDirection`, `intersection.ts:73-96`): the gate vector is
  `b - a`; the motion vector is `currPosition - prevPosition`. Direction is the sign of
  `cross(gateVector, motionVector)`: **positive → `'forward'`**, negative → `'reverse'`. Only
  `'forward'` crossings count toward timing. A motion vector that is exactly parallel to the gate
  (`cross` within tolerance of zero) throws `RangeError` — this only happens for a
  precisely-tangent motion step, an edge case guarded against, not expected in normal telemetry.
- **Interpolated `tCross`** (`interpolateCrossingTime`, `intersection.ts:112-133`): linear
  interpolation of `prevSample.tMono`/`currSample.tMono` by the intersection's `t` parameter, with
  IEEE-754 rounding correction so an interior `t` (`0 < t < 1`) can never round onto exactly
  `tPrev` or `tCurr` — the result is nudged to the nearest representable interior float, or the
  function throws if the interval genuinely has no representable interior value.

Gate placement geometry (which vector direction counts as forward) is generated once by the
profile generator; see "Gate crossing semantics (binding)" in `docs/architecture/contracts.md` and
`docs/adding-a-circuit.md`.

## Rearm / debounce

`CrossingDetector.update()` tracks, per gate id, the unwrapped lap-distance of the last **forward**
crossing of that gate (`lastForwardProgressByGate`). A new crossing of the same gate is suppressed
(skipped entirely — not even recorded as a reverse crossing) unless the new crossing's unwrapped
progress has advanced at least `minRearmDistanceM` (default **50 m**) past the last recorded
forward crossing. This is what makes the `startLineJitterLap` fixture — five ±3 m oscillations
across the start/finish line — count as exactly one forward crossing rather than five
(`packages/core/src/fixtures/scenarios.ts`, `startLineJitterLap`).

Only a **forward** crossing updates `lastForwardProgressByGate`; a reverse crossing of the same
gate is still emitted as an event (so `LapTimingEngine`/state machine can react to it) but does not
reset the rearm baseline.

## Guards before a crossing is even attempted

`CrossingDetector.update()` (`crossing-detector.ts:67-79`) refuses to look for a crossing at all
when:

- there is no previous match (`prev === null`) or previous sample (`prevSample === null`) — the
  very first sample of a session/lap can never itself be a crossing;
- either the previous or current match's quality level is `'invalid'`;
- the straight-line motion step exceeds `maxStepM` (default **120 m**) — an implausibly large jump
  between consecutive samples is never treated as having crossed anything, precisely to avoid
  phantom crossings from GNSS teleports (see `impossibleJumpLap` in `scenarios.ts`, which relies on
  this guard via the quality evaluator's own `IMPOSSIBLE_JUMP` rejection upstream);
- either endpoint of the motion step is currently `onPitLane` **and** the gate being tested is a
  timing gate (`kind === 'startFinish' || 'sector'`) — pit-lane transit never fires start/finish or
  sector crossings, only pit entry/exit gates remain live while on pit lane.

Crossing **confidence** is `min(prev.confidence, curr.confidence)`, further capped at **0.3** if
either endpoint's quality was `'unreliable'` (`UNRELIABLE_CONFIDENCE_CAP`,
`crossing-detector.ts:25,105-114`).

## Progress-regression penalty (matcher-level, upstream of crossings)

Before crossings are even computed, `TrackMatcher.match()` applies its own guard: if unwrapped
progress goes **backward** by more than `progressRegressionM` (default 30 m) since the previous
match, and there's no independent forward-motion evidence
(`hasReverseEvidence` — real backward displacement along the local tangent exceeding
`reverseEvidenceM`, default 3 m), the match is tagged `PROGRESS_REGRESSION` and its target
confidence is multiplied by `0.4` (`track-matcher.ts:140-148`).

## Lap/sector validity rules

`LapTimingEngine.onCrossing()` (`lap-timing-engine.ts`) only reacts to **forward** crossings
(`event.direction !== 'forward'` is ignored outright) with finite `tCross`/`lapDistanceM`. A lap
opens on a forward start/finish crossing while no lap is active; every subsequent crossing accrues
onto the active lap until the next forward start/finish crossing completes it and immediately opens
the next one (`lapNumber` increments by one, sector state resets).

Guards applied out-of-band and folded into the lap's quality/invalid state as it's built:

- `event.tCross < lap.lastEventTime` → the crossing is ignored (silently dropped, no state change)
  — this is the monotonic-time guard at the lap-timing level.
- A start/finish crossing at or before `lap.tStart` is ignored (guards against re-processing the
  lap's own opening crossing).
- `markInvalid(reason)` — called externally by `SessionPipelineCore` for reasons detected outside
  the crossing stream itself (pit transit, reverse travel, low-quality windows, pause gaps) — just
  adds to the active lap's `invalidReasons` set; it never affects `durationMs`/`sectorTimes`.

### Invalid-reason code table

| Code | Where it's raised | Condition |
|---|---|---|
| `PIT_TRANSIT` | `lap-timing-engine.ts` (`startLap`/`observe`), `pipelineCore.ts` (pit-entry evidence) | the lap starts, or is observed, while `inPit` is true |
| `REVERSE_TRAVEL` | `lap-timing-engine.ts:206-209`; also `pipelineCore.ts:304-310` | `maxProgressM - event.lapDistanceM > reverseTravelThresholdM` (default 30 m), i.e. the lap's progress regresses by more than the threshold at any point |
| `LOW_QUALITY` | `lap-timing-engine.ts:198-216` (`checkLowQualityWindow`); also `pipelineCore.ts` (sample-gap paths) | quality stays `'unreliable'`/`'invalid'` continuously for longer than `lowQualityWindowMs` (default 10,000 ms) within the lap |
| `MISSED_SECTOR_GATE` | `lap-timing-engine.ts:243-252` (`completeLap`) | the observed sector-gate ids for the lap don't exactly match the profile's expected ids in order (missing, extra, or out of order) |
| `DUPLICATE_SECTOR_GATE` | `lap-timing-engine.ts:253-255` | the same sector-gate id was observed more than once within the lap |
| `SHORT_LAP` | `lap-timing-engine.ts:257-261` | `durationMs < minLapMs` (default 60,000 ms) **or** `distanceProgressedM < totalLengthM * 0.9` |
| `PAUSE_GAP` | `statemachine/reducer.ts:223-227` (`paused -> RESUME`), read into the active lap by `SessionPipelineCore.syncInvalidReasons()` | resuming from `paused` back into `timing` after a pause gap `> 30,000 ms` |
| `RECOVERY` | `sessionController.ts:409-436` (`restoreFromCheckpoint`) | a synthetic zero-duration placeholder lap appended when a checkpoint is restored mid-lap — see `docs/persistence-model.md` §Recovery flow |

A `LapRecord.valid` is `true` **iff** `invalidReasons` is empty (`lap-timing-engine.ts:269`).

## Monotonic-time rules, including the cross-launch rule

Every duration in the timing pipeline (`tMono`, `tCross`, `elapsedMs`, gap detection) is computed
from `MonotonicClock`/`performance.now()`-sourced timestamps, never wall clock
(`docs/architecture/contracts.md` conventions; `apps/mobile/src/platform/clock.ts`). Two binding
rules follow:

1. **Never decreasing within a stream.** `TelemetryQualityEvaluator` marks a sample `'invalid'`
   (`DUPLICATE_TIMESTAMP`/`NON_INCREASING_TIMESTAMP`) if its `tMono` does not strictly increase over
   the previous sample; `LapTimingEngine` separately drops any crossing whose `tCross` precedes the
   active lap's `lastEventTime`. Both guards exist because quality-level rejection and lap-level
   rejection see the timestamp stream at different points in the pipeline.
2. **Cross-launch rule (binding, ADR-0003 §3): `tMono` is only comparable within one process
   launch.** `performance.now()`'s origin resets on every fresh app launch (not every foreground
   resume) — a `tMono` recorded before an app kill and one recorded after are on unrelated
   timelines and must never be subtracted. This is why `SessionController.restoreFromCheckpoint()`
   never attempts to resume an in-flight lap's live timer: any lap that was open when a checkpoint
   was written is appended as a zero-duration, `invalid: false`-would-be-wrong-so-instead
   explicitly `invalidReasons: ['RECOVERY']` lap record with `tStart: tEnd: 0`, rather than
   diffing a new `performance.now()` reading against the old, incomparable one. See
   `docs/persistence-model.md` for the full recovery flow this rule drives.

## `SessionPipelineCore`'s per-sample gap handling (above the timing engine)

Two independent gap thresholds run in `SessionPipelineCore.ingest()` (`pipelineCore.ts:230-251`)
ahead of matching/crossing, both keyed off the raw inter-sample `tMono` gap:

- **> `pauseGapMs`** (default 30,000 ms): dispatches an inferred `PAUSE` immediately followed by
  `RESUME` — this is what lets a genuine multi-minute GNSS/app gap look like an explicit pause to
  the state machine (and thus pick up `PAUSE_GAP` via the same reducer path a manual pause would).
- **> 3,000 ms** (hardcoded, independent of `pauseGapMs`): dispatches `GNSS_LOST` then
  `GNSS_RECOVERED` around the gap; if the gap additionally exceeds `lowQualityGapMs` (default
  10,000 ms), the active lap is invalidated `LOW_QUALITY` directly (separately from
  `LapTimingEngine`'s own continuous-low-quality-window check described above — this is the
  discrete-gap variant of the same reason code).
