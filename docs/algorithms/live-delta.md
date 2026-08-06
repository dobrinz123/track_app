# Live delta

How a reference (personal-best) lap is built and resampled
(`packages/core/src/reference/build-reference-lap.ts`), how it decides PB replacement
(`packages/core/src/reference/personal-best.ts`), and how the live dashboard's "gap to reference"
readout is computed and smoothed each sample (`packages/core/src/reference/live-delta-engine.ts`).

## Reference resampling (10 m grid, monotone clamp)

`buildReferenceLap()` turns one completed `LapRecord` plus its matched telemetry into a
`ReferenceLap` on a **fixed distance grid**, default step `gridStepM = 10` meters
(`build-reference-lap.ts:192`; grid points are `0, 10, 20, …, totalLengthM` with the final point
always exactly `totalLengthM`, see `gridFor()`).

Building the grid (`interpolationPoints`/`interpolate`, `build-reference-lap.ts:93-160`):

1. Telemetry samples (accepting `distanceM` or `unwrappedProgressM`, whichever the caller supplied)
   are filtered to the lap's own `[tStart, tEnd]` window and sorted by time.
2. Each sample's raw distance is **monotone-clamped**: `monotoneDistanceM = max(runningMax,
   boundedDistanceM)` — distance along the grid can only ever increase as elapsed time increases,
   never regress, even if the raw matched distance briefly wobbles backward. Endpoint snapping
   treats any raw distance within a tiny epsilon of `0` or `totalLengthM` as exactly that value.
3. Samples landing on the same monotone distance collapse into one point, keeping the **later**
   (larger) elapsed time.
4. The point list is anchored so it always starts at `(0, 0)` and ends at `(totalLengthM,
   lap.durationMs)` — synthesizing those endpoints if the real telemetry didn't quite reach them.
5. Elapsed time at every grid distance is found by binary-search interpolation (`interpolate()`)
   against the anchored point list, then **clamped again to be non-decreasing across the grid**
   (`elapsedMsAtGrid.push(max(previousElapsedMs, interpolate(...)))`, `build-reference-lap.ts:236-238`) —
   belt-and-suspenders on top of step 2's per-sample clamp.

**Coverage gate**: build fails with `INSUFFICIENT_COVERAGE` unless at least 95% of grid points fall
within `[firstSampleDistance, lastSampleDistance]` (`build-reference-lap.ts:216-219`). Other
failure codes: `INVALID_SOURCE_LAP` (lap not `valid`, non-finite/non-positive timing fields),
`INVALID_TOTAL_LENGTH`, `INVALID_GRID_STEP`, `INVALID_PROVENANCE` (any of `circuitId`/`layoutId`/
`userId`/`recordedAtUtc`/`sessionId`/`appVersion`/`algorithmVersion`/`schemaVersion` missing or
invalid), `INSUFFICIENT_TELEMETRY` (fewer than 2 usable telemetry points).

## PB replacement rules table

`shouldReplacePb(current, candidate)` (`personal-best.ts:110-138`) — **every** row must hold for a
candidate to replace the stored PB (mirrors the binding table in `docs/architecture/contracts.md`
"PB replacement rules"):

| Rule | Check |
|---|---|
| Same circuit/layout identity | `current === null` or `circuitId`/`layoutId`/`layoutVersion` all match |
| Lap validity | `lap.valid === true` |
| Quality floor | `lap.quality` is `'good'` or `'degraded'` — never `'unreliable'`/`'invalid'` |
| Not a pit lap | `!lap.invalidReasons.includes('PIT_TRANSIT')` |
| Sectors complete & ordered | `sectorTimes` non-empty, each `sectorIndex === its array index`, each `durationMs` finite and `>= 0`, and the sector durations sum to within 1 ms of `durationMs` (`sectorsAreCompleteAndOrdered`) — optionally exact-count-checked against `expectedSectorCount` |
| Strictly faster | `current === null` or `reference.durationMs < current.durationMs` |
| Full telemetry | caller-asserted `fullTelemetry === true` **and** `hasFullReferenceGrid(reference)` (grid starts at `(0,0)`, is strictly increasing in both distance and time, and its last point is within 1 ms of `durationMs`) |
| Provenance present | `hasProvenance(reference)` — every provenance field non-empty/finite, `lapNumber` a positive integer |
| Duration sanity | `lap.durationMs > 0` and `|reference.durationMs - lap.durationMs| <= 1` ms |

`SessionController.maybeReplacePb()` (`sessionController.ts:500-532`) calls this immediately after
every completed valid lap (never deferred to session end) with `fullTelemetry: true` and
`expectedSectorCount = sectorGates.length + 1`, and — if it replaces — writes the new reference via
`repository.putReferenceLap()` (atomic write-new-then-swap, see `docs/persistence-model.md`) and
immediately re-feeds the live delta engine with the new reference (`this.core.setReference(candidate)`).

## Delta computation

`LiveDeltaEngine.onMatch(match, lapElapsedMs)` (`live-delta-engine.ts:182-230`), called once per
matched sample (not for the sample that itself completes a start/finish crossing —
`SessionPipelineCore`/`ReplayHarness` skip delta computation on a `completingStartFinish` sample so
the delta is never computed against a lap that has just ended):

```
rawDeltaMs = max(0, lapElapsedMs) - referenceElapsedAt(reference, match.distanceM)
displayedDeltaMs += alpha * (rawDeltaMs - displayedDeltaMs)   // EMA, see below
```

`referenceElapsedAt(reference, distanceM)` (`live-delta-engine.ts:102-135`) binary-searches the
reference's grid, wraps `distanceM` into `[0, totalLengthM)` (snapping to `totalLengthM` itself
near the endpoint) and linearly interpolates between the two bracketing grid points.

## Sign convention

**Negative = faster than reference; positive = slower** (binding, `docs/architecture/contracts.md`
conventions). This flows straight from the subtraction above: a smaller `lapElapsedMs` than the
reference's elapsed-at-this-distance yields a negative `rawDeltaMs`. `DeltaDisplay.tsx` renders
negative as green with a leading minus, positive as red, `display === 'neutral'` as gray.

## EMA display smoothing

`displayedDeltaMs` is an exponential moving average of `rawDeltaMs`, `alpha = 0.3` by default
(`DEFAULT_ALPHA`, `live-delta-engine.ts:18,152`) — configurable via `LiveDeltaEngineConfig.alpha`
(alias `smoothingAlpha`). The EMA only advances on non-regressed samples (see "staleness/regression
handling" below); on a regressed sample the previously-displayed value is held. `rawDeltaMs` (the
unsmoothed value) is tracked separately and surfaces only in `estimatedLapMs` (below).

## Confidence / neutral rules

Displayed `confidence` starts as `min(clamp01(match.confidence), referenceCompleteness)` — capped by
how complete the reference lap's own grid coverage is (`referenceCompleteness()`,
`live-delta-engine.ts:58-100`: the smaller of spatial and temporal grid coverage, `0` if the grid is
degenerate). It's further discounted by staleness and regression (below). The dashboard shows
`display: 'neutral'` (gray, no faster/slower claim) whenever **any** of:

- the inter-sample gap is stale (`gapMs > staleGapMs`, default 5,000 ms);
- `confidence < confidenceThreshold` (default 0.4);
- match quality is not `'good'`/`'degraded'` (i.e. `'unreliable'`/`'invalid'`).

Otherwise `display` is `'faster'`/`'slower'` unless `|deltaMs| <= deadbandMs` (default 50 ms; the
app's `deltaDeadbandMs` setting, default 100 ms, is a separate UI-layer deadband on top of this
engine default — see `apps/mobile/src/session/settingsStore.ts`), in which case it's `'neutral'`.

## Staleness / regression handling

- **Sparse-gap confidence decay**: once the inter-sample gap exceeds `sparseGapMs` (default 3,000
  ms), confidence is linearly decayed toward zero as the gap grows from `sparseGapMs` toward
  `staleGapMs` (default 5,000 ms) — `confidence *= clamp01(1 - (gapMs - sparseGapMs) / (staleGapMs -
  sparseGapMs))`. Past `staleGapMs`, `display` is forced `'neutral'` outright (see above).
- **Progress regression**: if `match.unwrappedProgressM` has gone backward since the last matched
  sample, `confidence *= regressionConfidenceFactor` (default 0.5) and — critically — **the raw
  delta and EMA are not updated at all** for that sample (`if (!regressed) { … }`,
  `live-delta-engine.ts:198-207`); the previously displayed value is held unchanged until forward
  progress resumes.
- `setReference()`/`reset()` both clear all live state (`displayedDeltaMs`, `rawDeltaMs`,
  `lastTMono`, `lastUnwrappedProgressM`) — every new lap and every PB replacement starts the EMA
  fresh rather than carrying a stale smoothed value across the boundary. `SessionPipelineCore`
  calls `deltaEngine.reset()` on every forward start/finish crossing (`pipelineCore.ts:340`).

## Estimated-lap gating

`estimatedLapMs` (an estimate of the full lap time if the current pace holds) is only included in
the `DeltaUpdate` when confidence is `>= 0.6` (a separate, higher bar than the 0.4 display
threshold) and a raw delta has actually been computed this call:
`estimatedLapMs = reference.durationMs + rawDeltaMs` (`live-delta-engine.ts:221-229`). The
`DeltaUpdate` contract (`contracts.ts`) documents this field as "clearly an estimate" — the UI must
never present it as a committed lap time.
