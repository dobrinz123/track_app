# Review ticket P5a-REV3 — Codex read-only bounded re-verify of P5a-FIX2 (+ follow-up a/b/c)
Commit 3f0f20b (diff vs 6668300, packages/core/src/coaching/** + tests). Read-only; do not run tests. Re-verify ONLY: Z1 (S/F-anchored grid, t(s)=ΣΔs/v integral, drift flag), Z2 (coverage-fraction availability ≥ 90 %), Z3 (yaw tolerance 8 m / 400 ms, 1 Hz evaluation, unavailable above 1 s interval), Z4 (IMU brake needs speed at both endpoints), Z5 (seam-aware steering derivative), plus (a) 1 Hz-safe lap completeness via the ≤ 60 m span rule, (b) TIME_INTEGRATION_DRIFT limitation + RO/EN sentence, (c) fullThrottleFraction per run. FIXED / PARTIAL / NOT FIXED with file:line evidence and a concrete failure scenario for anything not FIXED; then any NEW HIGH/MEDIUM introduced by this diff only. Output: Table, NEW, Clean.

The sandbox may block process execution — do NOT rely on running git/shell. The full diff of the fix (src only) follows; the referenced source files may also be read directly if file reading works.
```diff
diff --git a/packages/core/src/coaching/cleanLap.ts b/packages/core/src/coaching/cleanLap.ts
index 04f5cf9..e916c31 100644
--- a/packages/core/src/coaching/cleanLap.ts
+++ b/packages/core/src/coaching/cleanLap.ts
@@ -1,405 +1,546 @@
-import { assertPositiveLength, normalizeDistance } from './distanceDomain';
+import { assertPositiveLength, forwardDistance, normalizeDistance } from './distanceDomain';
 import {
   GRAVITY_MPS2,
   type ClassifiableLap,
   type CornerLapSample,
   type LapAnomalyReason,
   type LapCheckId,
   type LapClassification,
   type LapStatus,
 } from './types';
 
 /**
  * Clean-lap classification -- `docs/architecture/analysis-engine.md` §3.
  *
  * A lap is CLEAN unless it is incomplete, went off track, shows a yaw or
  * deceleration spike, or its GNSS quality is too poor to trust. Only clean laps
  * feed the reference lap and the demonstrated envelope (Phase 5 safety contract
  * rule 2); anomalous laps are still reported as facts, with their reason.
  *
  * Every check states whether it could run at all: a lap whose samples carry no
  * lateral offset cannot be tested for off-track, and the report says so instead
  * of pretending the lap was clean on that axis.
  */
 
 export interface ClassifyLapOptions {
   totalLengthM: number;
   /** |lateral| beyond this is off track, metres. Default 15. */
   corridorHalfWidthM?: number;
   /** GNSS accuracy above this is poor, metres. Default 25. */
   poorAccuracyM?: number;
   /** Fraction of the lap allowed to exceed `poorAccuracyM`. Default 0.05. */
   poorAccuracyFraction?: number;
   /** Sample gap above this makes the lap anomalous, ms. Default 1500. */
   maxSampleGapMs?: number;
   /** |longitudinal g| above this is an implausible spike. Default 1.2. */
   decelSpikeG?: number;
   /**
    * How far the measured yaw rate may exceed the yaw the track's own curvature
    * implies before it counts as a spike, degrees/second. Default 150.
    */
   yawSpikeDps?: number;
   /**
    * A yaw excess only counts as a spike when the lateral acceleration it
    * implies (`excess * speed`) is beyond what any car can hold, in g.
    * Default 2. Course-over-ground noise at crawling speed fails this test.
    */
   yawSpikeLatG?: number;
   /**
    * How long the yaw excess must hold to count as a spike, milliseconds.
    * Default 200. Measured as a DURATION, so the rule does not change with the
    * sample rate.
    */
   yawSpikeMs?: number;
   /** Fraction of the lap distance that must be covered by samples. Default 0.9. */
   minCoverageFraction?: number;
+  /**
+   * Fraction of the LAP DISTANCE a check's own evidence must span before the
+   * check counts as available. Default 0.9: a lateral offset recorded only for
+   * the first 100 m of a 1000 m lap proves nothing about the other 900.
+   */
+  minCheckCoverageFraction?: number;
+  /**
+   * Largest distance between two consecutive readings of a channel that still
+   * counts as continuous evidence, metres. Default 60 (the analysis grid's own
+   * bridging distance: 1.5 s at 150 km/h).
+   */
+  checkBridgeM?: number;
 }
 
 /** Fixed reporting/priority order: the first reason present becomes `reason`. */
 const REASON_PRIORITY: readonly LapAnomalyReason[] = Object.freeze([
   'incomplete',
   'offTrack',
   'yawSpike',
   'decelSpike',
   'gnssPoor',
 ]);
 
 /** Number of coverage buckets the lap distance is split into. */
 const COVERAGE_BUCKETS = 100;
 
 /**
  * Checks the Phase 5 safety contract (rule 2) requires before a lap may be
  * called CLEAN: "on-track, no yaw/decel anomaly, valid GNSS quality", plus the
  * coverage that proves the lap was actually driven. A lap that passes every
  * check it COULD run but could not run one of these is `unverified`.
  */
 const REQUIRED_CHECKS: readonly LapCheckId[] = Object.freeze([
   'offTrack',
   'yawSpike',
   'decelSpike',
   'gnssPoor',
   'coverage',
 ] as const);
 
 function wrappedHeadingDelta(from: number, to: number): number {
   let delta = (to - from) % 360;
   if (delta > 180) delta -= 360;
   if (delta <= -180) delta += 360;
   return delta;
 }
 
 function formatMetres(value: number): string {
   return `${Math.round(value)} m`;
 }
 
 function finite(value: number | undefined): value is number {
   return value !== undefined && Number.isFinite(value);
 }
 
 /**
- * How far the implied-yaw window may be widened, in samples, to absorb the
- * projection lag between the car's own heading and the centreline vertex it is
- * crossing.
+ * How far the implied-yaw window may be widened to absorb the projection lag
+ * between the car's own heading and the centreline vertex it is crossing.
+ * Expressed in METRES and MILLISECONDS, never in samples: the projection
+ * uncertainty is a few metres of track whatever the GNSS rate is, and a sample
+ * tolerance would silently become 16 m at 5 Hz and 40 m/s -- wide enough to
+ * borrow a 35 degree OSM vertex from the next straight and explain away a spin.
  */
-const YAW_IMPLIED_TOLERANCE_SAMPLES = 2;
+const YAW_IMPLIED_TOLERANCE_M = 8;
+const YAW_IMPLIED_TOLERANCE_MS = 400;
+/**
+ * Longest median sample interval the yaw rule can still say anything with. At
+ * 1 Hz a 200 ms window becomes a 1 s window and the check still runs; slower
+ * than that, a spin can start and end between two fixes, so the check is
+ * reported UNAVAILABLE (-> the lap is unverified) instead of "no spike found".
+ */
+const YAW_MAX_SAMPLE_INTERVAL_MS = 1_000;
 
 /**
  * Degrees of the measured turn that the centreline cannot explain, minimised
  * over the tolerated window widenings. Returns the measured turn itself when no
  * centreline heading is available (implied yaw 0).
  */
 function smallestUnexplainedTurn(
   samples: readonly CornerLapSample[],
   from: number,
   to: number,
   measuredTurn: number,
+  totalLengthM: number,
 ): number {
   let best = Math.abs(measuredTurn);
-  for (let a = Math.max(0, from - YAW_IMPLIED_TOLERANCE_SAMPLES); a <= from; a += 1) {
-    const start = samples[a];
-    if (start === undefined || !finite(start.centrelineHeadingDeg)) continue;
-    for (
-      let b = to;
-      b <= Math.min(samples.length - 1, to + YAW_IMPLIED_TOLERANCE_SAMPLES);
-      b += 1
-    ) {
-      const finish = samples[b];
-      if (finish === undefined || !finite(finish.centrelineHeadingDeg)) continue;
-      const implied = wrappedHeadingDelta(start.centrelineHeadingDeg, finish.centrelineHeadingDeg);
+  const start = samples[from];
+  const finish = samples[to];
+  if (start === undefined || finish === undefined) return best;
+  const withinTolerance = (probe: CornerLapSample, edge: CornerLapSample): boolean => {
+    const gapM = Math.min(
+      forwardDistance(probe.distanceM, edge.distanceM, totalLengthM),
+      forwardDistance(edge.distanceM, probe.distanceM, totalLengthM),
+    );
+    return gapM <= YAW_IMPLIED_TOLERANCE_M &&
+      Math.abs(probe.tMonoMs - edge.tMonoMs) <= YAW_IMPLIED_TOLERANCE_MS;
+  };
+  for (let a = from; a >= 0; a -= 1) {
+    const before = samples[a];
+    if (before === undefined || !withinTolerance(before, start)) break;
+    if (!finite(before.centrelineHeadingDeg)) continue;
+    for (let b = to; b < samples.length; b += 1) {
+      const after = samples[b];
+      if (after === undefined || !withinTolerance(after, finish)) break;
+      if (!finite(after.centrelineHeadingDeg)) continue;
+      const implied = wrappedHeadingDelta(before.centrelineHeadingDeg, after.centrelineHeadingDeg);
       const unexplained = Math.abs(measuredTurn - implied);
       if (unexplained < best) best = unexplained;
     }
   }
   return best;
 }
 
 interface YawEvaluation {
-  /** False when the samples carry neither a gyro channel nor two headings. */
+  /**
+   * False when the samples carry neither a gyro channel nor two headings, or
+   * when the sample rate is too low for the rule to mean anything.
+   */
   available: boolean;
+  /** Which signal the measured turn came from -- the one coverage is judged on. */
+  source: 'yawRateDps' | 'headingDeg' | null;
   /** Worst excess over the implied yaw that satisfied every guard, deg/s. */
   worstDps: number | null;
+  /** The duration window the rule actually used, ms. */
+  windowMs: number;
+}
+
+/** Median of the positive intervals between consecutive samples, ms. */
+function medianSampleIntervalMs(samples: readonly CornerLapSample[]): number | null {
+  const intervals: number[] = [];
+  for (let index = 0; index + 1 < samples.length; index += 1) {
+    const current = samples[index];
+    const next = samples[index + 1];
+    if (current === undefined || next === undefined) continue;
+    const dt = next.tMonoMs - current.tMonoMs;
+    if (dt > 0 && Number.isFinite(dt)) intervals.push(dt);
+  }
+  if (intervals.length === 0) return null;
+  intervals.sort((a, b) => a - b);
+  return intervals[Math.floor((intervals.length - 1) / 2)] ?? null;
 }
 
 /** Degrees the gyro says the car turned between two indices. */
 function integratedGyroTurn(
   samples: readonly CornerLapSample[],
   from: number,
   to: number,
 ): number | null {
   let total = 0;
   for (let index = from; index < to; index += 1) {
     const sample = samples[index];
     const next = samples[index + 1];
     if (sample === undefined || next === undefined) return null;
     const rate = sample.channels?.yawRateDps;
     if (!finite(rate)) return null;
     const dtSeconds = (next.tMonoMs - sample.tMonoMs) / 1_000;
     if (!(dtSeconds > 0)) return null;
     total += rate * dtSeconds;
   }
   return total;
 }
 
 /**
  * Yaw anomaly per `analysis-engine.md` §3: the yaw the car ACTUALLY turned
  * through -- the recorded gyro when the session has one, else the GNSS course
  * over ground -- against the yaw the CENTRELINE's own curvature implies over
  * the same stretch. A car following a hairpin turns fast and is not sliding; a
  * car turning fast where the track does not is.
  *
  * Both signals are compared over a fixed DURATION window rather than per sample
  * interval: the rule is then identical at 5 Hz and at 20 Hz, and the shared
  * turn across a centreline vertex cancels instead of appearing as a spike in
  * one signal only. With no centreline heading the implied yaw is 0, so the
  * check degrades to an absolute-rate rule -- never to attributing yaw to a
  * track it cannot see -- and the implausible-lateral-g guard still applies.
  */
 function evaluateYaw(
   samples: readonly CornerLapSample[],
   yawSpikeMs: number,
   yawSpikeDps: number,
   yawSpikeLatG: number,
+  totalLengthM: number,
 ): YawEvaluation {
   let gyroCount = 0;
   let headingCount = 0;
   for (const sample of samples) {
     if (finite(sample.channels?.yawRateDps)) gyroCount += 1;
     if (finite(sample.headingDeg)) headingCount += 1;
   }
   const useGyro = gyroCount >= 2;
-  if (!useGyro && headingCount < 2) return { available: false, worstDps: null };
+  const source = useGyro ? 'yawRateDps' : headingCount >= 2 ? 'headingDeg' : null;
+  if (source === null) {
+    return { available: false, source: null, worstDps: null, windowMs: yawSpikeMs };
+  }
+  // The rule is a DURATION rule, so a rate that cannot resolve that duration
+  // widens the window to one sample interval instead of skipping every window
+  // and reporting "no spike" -- and below `YAW_MAX_SAMPLE_INTERVAL_MS` it
+  // reports that it cannot judge at all.
+  const intervalMs = medianSampleIntervalMs(samples);
+  if (intervalMs === null || intervalMs > YAW_MAX_SAMPLE_INTERVAL_MS) {
+    return { available: false, source, worstDps: null, windowMs: yawSpikeMs };
+  }
+  const windowMs = Math.max(yawSpikeMs, intervalMs);
+  const maxWindowMs = Math.max(yawSpikeMs * 4, windowMs * 1.5);
 
   let worstDps: number | null = null;
   for (let index = 0; index < samples.length; index += 1) {
     const start = samples[index];
     if (start === undefined) continue;
     let end = index + 1;
-    while (end < samples.length && (samples[end]?.tMonoMs ?? 0) - start.tMonoMs < yawSpikeMs) {
+    while (end < samples.length && (samples[end]?.tMonoMs ?? 0) - start.tMonoMs < windowMs) {
       end += 1;
     }
     const finish = samples[end];
     if (finish === undefined) continue;
     const spanMs = finish.tMonoMs - start.tMonoMs;
     // The window must be the duration the rule asks for, and must not straddle
     // a data gap (which is already reported on its own).
-    if (spanMs < yawSpikeMs || spanMs > yawSpikeMs * 4) continue;
+    if (spanMs < windowMs || spanMs > maxWindowMs) continue;
     const measuredTurn = useGyro
       ? integratedGyroTurn(samples, index, end)
       : finite(start.headingDeg) && finite(finish.headingDeg)
         ? wrappedHeadingDelta(start.headingDeg, finish.headingDeg)
         : null;
     if (measuredTurn === null) continue;
     // The projected distance carries a few metres of GNSS/projection
     // uncertainty, and a catalog centreline turns in discrete vertex steps (a
     // single OSM vertex can be worth 35 degrees). Comparing two step functions
     // whose phase differs by a metre or two would invent a spin at every such
     // vertex, so the implied turn is taken over the window WIDENED by up to
     // `YAW_IMPLIED_TOLERANCE_SAMPLES` on each side and the reading that best
     // explains the measured turn wins. Nothing is widened for the measurement
     // itself, so a real rotation the track does not ask for still stands out.
-    const excessDeg = smallestUnexplainedTurn(samples, index, end, measuredTurn);
+    const excessDeg = smallestUnexplainedTurn(samples, index, end, measuredTurn, totalLengthM);
     const excessDps = excessDeg / (spanMs / 1_000);
     const speedMps = finite(start.speedKph) ? start.speedKph / 3.6 : null;
     const excessLatG =
       speedMps === null ? null : (((excessDps * Math.PI) / 180) * speedMps) / GRAVITY_MPS2;
     if (excessDps <= yawSpikeDps) continue;
     if (excessLatG !== null && excessLatG <= yawSpikeLatG) continue;
     if (worstDps === null || excessDps > worstDps) worstDps = excessDps;
   }
-  return { available: true, worstDps };
+  return { available: true, source, worstDps, windowMs };
+}
+
+/**
+ * Fraction of the LAP DISTANCE over which a channel is continuous evidence:
+ * the lap is split into `COVERAGE_BUCKETS` cells and every cell a pair of
+ * consecutive readings no more than `bridgeM` apart spans is counted. "The
+ * channel appeared once" is not evidence about the rest of the lap.
+ */
+function channelCoverageFraction(
+  samples: readonly CornerLapSample[],
+  carries: (sample: CornerLapSample) => boolean,
+  totalLengthM: number,
+  bridgeM: number,
+): number {
+  const bucketM = totalLengthM / COVERAGE_BUCKETS;
+  const buckets = new Array<boolean>(COVERAGE_BUCKETS).fill(false);
+  let previous: CornerLapSample | null = null;
+  for (const sample of samples) {
+    if (!Number.isFinite(sample.distanceM) || !carries(sample)) continue;
+    const from = normalizeDistance(sample.distanceM, totalLengthM);
+    buckets[Math.min(COVERAGE_BUCKETS - 1, Math.floor(from / bucketM))] = true;
+    if (previous !== null) {
+      const span = forwardDistance(previous.distanceM, sample.distanceM, totalLengthM);
+      if (span <= bridgeM) {
+        const start = normalizeDistance(previous.distanceM, totalLengthM);
+        const first = Math.floor(start / bucketM);
+        const steps = Math.floor(((start % bucketM) + span) / bucketM);
+        for (let step = 0; step <= steps; step += 1) {
+          buckets[(first + step) % COVERAGE_BUCKETS] = true;
+        }
+      }
+    }
+    previous = sample;
+  }
+  return buckets.filter(Boolean).length / COVERAGE_BUCKETS;
 }
 
 /**
  * Classifies ONE lap as clean or anomalous from its record plus its projected
  * samples. Pure and deterministic: the same inputs always produce the same
  * classification, including the order of `reasons`.
  */
 export function classifyLap(
   lap: ClassifiableLap,
   samples: readonly CornerLapSample[],
   options: ClassifyLapOptions,
 ): LapClassification {
   assertPositiveLength(options.totalLengthM);
   const corridorHalfWidthM = options.corridorHalfWidthM ?? 15;
   const poorAccuracyM = options.poorAccuracyM ?? 25;
   const poorAccuracyFraction = options.poorAccuracyFraction ?? 0.05;
   const maxSampleGapMs = options.maxSampleGapMs ?? 1_500;
   const decelSpikeG = options.decelSpikeG ?? 1.2;
   const yawSpikeDps = options.yawSpikeDps ?? 150;
   const yawSpikeLatG = options.yawSpikeLatG ?? 2;
   const yawSpikeMs = options.yawSpikeMs ?? 200;
   const minCoverageFraction = options.minCoverageFraction ?? 0.9;
+  const minCheckCoverageFraction = options.minCheckCoverageFraction ?? 0.9;
+  const checkBridgeM = options.checkBridgeM ?? 60;
 
   const reasons = new Set<LapAnomalyReason>();
   const unavailable = new Set<LapCheckId>();
   const details: string[] = [];
 
   // --- the lap record itself ------------------------------------------------
   if (!lap.valid) {
     reasons.add('incomplete');
     const listed = lap.invalidReasons.length > 0 ? lap.invalidReasons.join(', ') : 'no reason given';
     details.push(`lap record is invalid (${listed})`);
   }
   // A lap time that is not a finite positive number of milliseconds is not a
   // lap time: it must never reach the reference selection or the report text.
   if (!Number.isFinite(lap.durationMs) || lap.durationMs <= 0) {
     reasons.add('incomplete');
     details.push('lap duration is not a finite, positive number of milliseconds');
   }
 
   // --- coverage -------------------------------------------------------------
-  const buckets = new Array<boolean>(COVERAGE_BUCKETS).fill(false);
   let sampleCount = 0;
   for (const sample of samples) {
     if (!Number.isFinite(sample.distanceM) || !Number.isFinite(sample.tMonoMs)) continue;
     sampleCount += 1;
-    const wrapped = normalizeDistance(sample.distanceM, options.totalLengthM);
-    const bucket = Math.min(
-      COVERAGE_BUCKETS - 1,
-      Math.floor((wrapped / options.totalLengthM) * COVERAGE_BUCKETS),
-    );
-    buckets[bucket] = true;
   }
-  const coverageFraction = buckets.filter(Boolean).length / COVERAGE_BUCKETS;
+  // The SAME rule the per-check coverage uses: two consecutive fixes no further
+  // apart than `checkBridgeM` cover the track between them. Counting "a fix
+  // landed in this 1 % of the lap" instead would call every 1 Hz lap incomplete
+  // -- at 40 m/s a 1 Hz receiver reports one fix per 4 % of a 1 km circuit, and
+  // 1 Hz is what the shipped app records on iPhone.
+  const coverageFraction = channelCoverageFraction(
+    samples,
+    (sample) => Number.isFinite(sample.tMonoMs),
+    options.totalLengthM,
+    checkBridgeM,
+  );
   if (sampleCount === 0) {
     unavailable.add('coverage');
     reasons.add('incomplete');
     details.push('no usable samples for this lap');
   } else if (coverageFraction < minCoverageFraction) {
     reasons.add('incomplete');
     details.push(
       `samples cover ${Math.round(coverageFraction * 100)}% of the lap ` +
         `(minimum ${Math.round(minCoverageFraction * 100)}%)`,
     );
   }
 
   // --- per-sample checks ----------------------------------------------------
   let worstAccuracyM: number | null = null;
   let poorAccuracyCount = 0;
   let accuracyCount = 0;
   let worstLateralM: number | null = null;
   let lateralCount = 0;
-  const yaw = evaluateYaw(samples, yawSpikeMs, yawSpikeDps, yawSpikeLatG);
+  const yaw = evaluateYaw(samples, yawSpikeMs, yawSpikeDps, yawSpikeLatG, options.totalLengthM);
+  // Availability is a COVERAGE question, not an existence one: a check may only
+  // speak for the lap if its evidence spans the lap (§3 / safety contract 2).
+  const coverageOf = (carries: (sample: CornerLapSample) => boolean): number =>
+    channelCoverageFraction(samples, carries, options.totalLengthM, checkBridgeM);
+  const checkCoverage: Record<LapCheckId, number> = {
+    offTrack: coverageOf((sample) => finite(sample.lateralM)),
+    yawSpike:
+      yaw.source === 'yawRateDps'
+        ? coverageOf((sample) => finite(sample.channels?.yawRateDps))
+        : coverageOf((sample) => finite(sample.headingDeg)),
+    decelSpike: coverageOf((sample) => finite(sample.speedKph)),
+    gnssPoor: coverageOf((sample) => finite(sample.accuracyM)),
+    coverage: coverageFraction,
+  };
   let speedCount = 0;
   let worstDecelG: number | null = null;
   let observedMaxGapMs: number | null = null;
 
   for (let index = 0; index < samples.length; index += 1) {
     const sample = samples[index];
     if (sample === undefined) continue;
     const next = samples[index + 1];
 
     if (sample.accuracyM !== undefined && Number.isFinite(sample.accuracyM)) {
       accuracyCount += 1;
       if (worstAccuracyM === null || sample.accuracyM > worstAccuracyM) {
         worstAccuracyM = sample.accuracyM;
       }
       if (sample.accuracyM > poorAccuracyM) poorAccuracyCount += 1;
     }
     if (sample.lateralM !== undefined && Number.isFinite(sample.lateralM)) {
       lateralCount += 1;
       const magnitude = Math.abs(sample.lateralM);
       if (worstLateralM === null || magnitude > worstLateralM) worstLateralM = magnitude;
     }
     if (next === undefined) continue;
     const dtSeconds = (next.tMonoMs - sample.tMonoMs) / 1_000;
     if (dtSeconds > 0) {
       const gapMs = dtSeconds * 1_000;
       if (observedMaxGapMs === null || gapMs > observedMaxGapMs) observedMaxGapMs = gapMs;
       const speed = sample.speedKph;
       const nextSpeed = next.speedKph;
       if (
         speed !== undefined &&
         nextSpeed !== undefined &&
         Number.isFinite(speed) &&
         Number.isFinite(nextSpeed)
       ) {
         speedCount += 1;
         const accelG = (nextSpeed - speed) / 3.6 / dtSeconds / GRAVITY_MPS2;
         if (accelG < 0 && (worstDecelG === null || -accelG > worstDecelG)) worstDecelG = -accelG;
       }
     }
   }
 
-  if (lateralCount === 0) unavailable.add('offTrack');
-  else if (worstLateralM !== null && worstLateralM > corridorHalfWidthM) {
+  // What a check DID see is always reported: an excursion observed over the
+  // first 100 m is a fact even when the rest of the lap carries no evidence.
+  // Thin coverage only removes the right to call the lap clean.
+  if (lateralCount === 0 || checkCoverage.offTrack < minCheckCoverageFraction) {
+    unavailable.add('offTrack');
+  }
+  if (worstLateralM !== null && worstLateralM > corridorHalfWidthM) {
     reasons.add('offTrack');
     details.push(
       `lateral offset reached ${formatMetres(worstLateralM)} (corridor ${formatMetres(corridorHalfWidthM)})`,
     );
   }
 
-  if (!yaw.available) unavailable.add('yawSpike');
-  else if (yaw.worstDps !== null) {
+  if (!yaw.available || checkCoverage.yawSpike < minCheckCoverageFraction) {
+    unavailable.add('yawSpike');
+  }
+  if (yaw.worstDps !== null) {
     reasons.add('yawSpike');
     details.push(
       `yaw rate exceeded the implied (centreline) yaw by ${Math.round(yaw.worstDps)} deg/s ` +
-        `over ${yawSpikeMs} ms (limit ${yawSpikeDps} deg/s)`,
+        `over ${Math.round(yaw.windowMs)} ms (limit ${yawSpikeDps} deg/s)`,
     );
   }
 
-  if (speedCount === 0) unavailable.add('decelSpike');
-  else if (worstDecelG !== null && worstDecelG > decelSpikeG) {
+  if (speedCount === 0 || checkCoverage.decelSpike < minCheckCoverageFraction) {
+    unavailable.add('decelSpike');
+  }
+  if (worstDecelG !== null && worstDecelG > decelSpikeG) {
     reasons.add('decelSpike');
     details.push(
       `deceleration reached ${worstDecelG.toFixed(2)} g (limit ${decelSpikeG.toFixed(2)} g)`,
     );
   }
 
-  if (accuracyCount === 0) unavailable.add('gnssPoor');
-  else if (poorAccuracyCount / accuracyCount > poorAccuracyFraction) {
+  if (accuracyCount === 0 || checkCoverage.gnssPoor < minCheckCoverageFraction) {
+    unavailable.add('gnssPoor');
+  }
+  if (accuracyCount > 0 && poorAccuracyCount / accuracyCount > poorAccuracyFraction) {
     reasons.add('gnssPoor');
     const percent = Math.round((poorAccuracyCount / accuracyCount) * 100);
     details.push(`${percent}% of fixes worse than ${formatMetres(poorAccuracyM)}`);
   }
   if (observedMaxGapMs !== null && observedMaxGapMs > maxSampleGapMs) {
     reasons.add('gnssPoor');
     details.push(`sample gap of ${Math.round(observedMaxGapMs)} ms (limit ${maxSampleGapMs} ms)`);
   }
 
   const ordered = REASON_PRIORITY.filter((reason) => reasons.has(reason));
   const first = ordered[0] ?? null;
   const unavailableChecks = REQUIRED_CHECKS.filter((check) => unavailable.has(check));
   // An unavailable required check can never be reported as "clean": the lap did
   // not fail, but the evidence to call it clean was not there either.
   const status: LapStatus =
     ordered.length > 0 ? 'anomalous' : unavailableChecks.length > 0 ? 'unverified' : 'clean';
+  // The evidence percentage belongs in the sentence: "could not run" reads very
+  // differently from "ran over 11 % of the lap".
+  const listUnavailable = (): string =>
+    unavailableChecks
+      .map((check) => `${check} (evidence over ${Math.round(checkCoverage[check] * 100)} % of the lap)`)
+      .join(', ');
   const detail =
     details.length > 0
       ? details.join('; ')
       : status === 'unverified'
-        ? `no anomaly detected, but these checks could not run: ${unavailableChecks.join(', ')}`
+        ? `no anomaly detected, but these checks could not run: ${listUnavailable()}`
         : 'no anomaly detected';
   return {
     lapNumber: lap.lapNumber,
     status,
     clean: status === 'clean',
     reason: first,
     reasons: ordered,
     detail,
     unavailableChecks: [...unavailableChecks],
+    checkCoverage,
     coverageFraction,
     worstAccuracyM,
     maxSampleGapMs: observedMaxGapMs,
   };
 }
diff --git a/packages/core/src/coaching/cornerMetrics.ts b/packages/core/src/coaching/cornerMetrics.ts
index 58595a0..43cc3bb 100644
--- a/packages/core/src/coaching/cornerMetrics.ts
+++ b/packages/core/src/coaching/cornerMetrics.ts
@@ -638,86 +638,87 @@ function detectLift(
       });
       if (found !== null) return { index: found, source: channel };
     }
   }
   if (series.accelSource === null) return null;
   const found = firstSustained(series, run, options.sustainMs, (index) => {
     const value = series.accelG[index];
     return value !== null && value !== undefined && value <= -options.liftThresholdG;
   });
   return found === null ? null : { index: found, source: 'decelOnset' };
 }
 
 /**
  * Braking onset: the brake channel when the vehicle profile provides one, then
  * the IMU (cross-checked against `dv/ds` -- a steady longitudinal bias with no
  * speed change is a tilted phone, not a brake application), then the GPS speed
  * derivative.
  */
 function detectBrake(
   series: LapSeries,
   run: Run,
   options: ResolvedOptions,
 ): { index: number; source: 'brakePct' | 'longG' | 'gpsSpeed' } | null {
   const brake = series.channels.get('brakePct');
   if (hasValue(brake, run) && brake !== undefined) {
     const found = firstSustained(series, run, options.sustainMs, (index) => {
       const value = brake[index];
       return value !== null && value !== undefined && value > BRAKE_ON_PCT;
     });
     if (found !== null) return { index: found, source: 'brakePct' };
   }
 
   const longG = series.channels.get('longG');
   if (hasValue(longG, run) && longG !== undefined) {
     const found = firstSustained(series, run, options.sustainMs, (index) => {
       const value = longG[index];
       return value !== null && value !== undefined && value <= -options.brakeThresholdG;
     });
     if (found !== null) {
       const startSpeed = series.speedKph[found] ?? null;
-      const endSpeed =
-        startSpeed === null
-          ? null
-          : valueAfterSustain(series, run, found, options.sustainMs, series.speedKph);
+      const endSpeed = valueAfterSustain(series, run, found, options.sustainMs, series.speedKph);
+      // A MISSING speed is not a confirmation. Without a speed at both ends of
+      // the sustain window there is no dv/ds to tell a real brake application
+      // from a phone lying in the cradle at an angle, so the IMU estimator
+      // stands down and the speed-derivative estimator below gets its turn.
       const confirmed =
-        startSpeed === null || endSpeed === null || endSpeed <= startSpeed - BRAKE_SPEED_DROP_KPH;
+        startSpeed !== null && endSpeed !== null && endSpeed <= startSpeed - BRAKE_SPEED_DROP_KPH;
       if (confirmed) return { index: found, source: 'longG' };
     }
   }
 
   const speedAccelG = series.speedAccelG;
   if (speedAccelG === null) return null;
   const found = firstSustained(series, run, options.sustainMs, (index) => {
     const value = speedAccelG[index];
     return value !== null && value !== undefined && value <= -options.brakeThresholdG;
   });
   return found === null ? null : { index: found, source: 'gpsSpeed' };
 }
 
 /**
  * Throttle-on, searched only AFTER the minimum speed (`s_vmin`, design §4): a
  * driver already on the pedal at the apex while the car is still slowing has
  * not got back on the power yet. Every estimator in the chain is tried --
  * pedal, then throttle plate, then the acceleration onset -- so an available
  * but non-triggering channel does not silence the metric.
  */
 function detectThrottleOn(
   series: LapSeries,
   run: Run,
   options: ResolvedOptions,
 ): { index: number; source: 'accelPedalPct' | 'throttlePct' | 'accelOnset' } | null {
   for (const channel of ['accelPedalPct', 'throttlePct'] as const) {
     const values = series.channels.get(channel);
     if (!hasValue(values, run) || values === undefined) continue;
     const found = firstSustained(series, run, options.sustainMs, (index) => {
       const value = values[index];
       return value !== null && value !== undefined && value > THROTTLE_ON_PCT;
     });
     if (found !== null) return { index: found, source: channel };
   }
   if (series.accelSource === null) return null;
   const found = firstSustained(series, run, options.sustainMs, (index) => {
     const value = series.accelG[index];
     return value !== null && value !== undefined && value >= THROTTLE_ON_G;
   });
   return found === null ? null : { index: found, source: 'accelOnset' };
@@ -1100,118 +1101,131 @@ export function computeCornerMetrics(
         const speed = series.speedKph[index];
         if (speed !== null && speed !== undefined && (minSpeed === null || speed < minSpeed)) {
           minSpeed = speed;
           minSpeedIndex = index;
         }
         const latG = latGSeries?.[index] ?? null;
         if (latG !== null) {
           const magnitude = Math.abs(latG);
           if (maxLatG === null || magnitude > maxLatG) maxLatG = magnitude;
           const longG = longGSeries?.[index] ?? null;
           if (longG !== null) {
             const combined = Math.hypot(latG, longG);
             if (frictionMax === null || combined > frictionMax) frictionMax = combined;
           }
         }
       }
       base.minSpeedKph = minSpeed;
       base.maxLatG = maxLatG;
       base.maxLatGSource = maxLatG === null ? null : 'imu';
       base.frictionCircleMaxG = frictionMax;
       if (minSpeedIndex !== null) {
         const distance = series.distanceM[minSpeedIndex];
         if (distance !== undefined) {
           minSpeedDistanceM = distance;
           base.minSpeedPositionM = distance;
           const fromApex = forwardDistance(apexM, distance, totalLengthM);
           base.minSpeedVsApexM = fromApex > totalLengthM / 2 ? fromApex - totalLengthM : fromApex;
         }
       }
 
       const steering = series.channels.get('steeringDeg');
       if (hasValue(steering, run) && steering !== undefined) {
         let sumSquares = 0;
         let samplesCounted = 0;
         let corrections = 0;
         let previousSign = 0;
         for (let position = 0; position + 1 < run.indices.length; position += 1) {
           const index = run.indices[position];
           const nextIndex = run.indices[position + 1];
           if (index === undefined || nextIndex === undefined) continue;
+          // The two halves of a corner that wraps the start/finish line are
+          // joined into one run, but the join is VIRTUAL: the entries either
+          // side of it are a lap apart. A steering derivative -- and a
+          // correction -- may only be measured inside a contiguous run, so the
+          // seam is skipped and the correction chain restarts after it.
+          if (nextIndex !== index + 1) {
+            previousSign = 0;
+            continue;
+          }
           const current = steering[index];
           const next = steering[nextIndex];
           const dCurrent = series.distanceM[index];
           const dNext = series.distanceM[nextIndex];
           if (current === null || next === null || current === undefined || next === undefined) continue;
           if (dCurrent === undefined || dNext === undefined) continue;
           const stepM = forwardDistance(dCurrent, dNext, totalLengthM);
           if (!(stepM > 0) || stepM > totalLengthM / 2) continue;
           const rate = (next - current) / stepM;
           sumSquares += rate * rate;
           samplesCounted += 1;
           const delta = next - current;
           if (Math.abs(delta) > STEERING_DEADBAND_DEG) {
             const sign = delta > 0 ? 1 : -1;
             if (previousSign !== 0 && sign !== previousSign) corrections += 1;
             previousSign = sign;
           }
         }
         if (samplesCounted > 0) {
           base.steeringSmoothness = Math.sqrt(sumSquares / samplesCounted);
           base.steeringCorrections = corrections;
         }
       }
     }
 
     // --- exit zone ----------------------------------------------------------
     if (exitZone.run !== null) {
       // Throttle-on is only meaningful after the minimum speed. A minimum speed
       // that sits BEFORE the exit zone starts (the apex) restricts nothing:
       // the whole exit zone is already "after s_vmin".
       const vminOffsetM =
         minSpeedDistanceM === null
           ? 0
           : forwardDistance(exitZone.startM, minSpeedDistanceM, totalLengthM);
       const offsetM = vminOffsetM > totalLengthM / 2 ? 0 : vminOffsetM;
       const afterVmin =
         offsetM <= 0
           ? exitZone.run
           : runFromOffset(exitZone.run, series, exitZone.startM, offsetM, totalLengthM);
       if (afterVmin !== null) {
         const throttleOn = detectThrottleOn(series, afterVmin, resolved);
         if (throttleOn !== null) {
           const distance = series.distanceM[throttleOn.index];
           if (distance !== undefined) {
             const fromApex = forwardDistance(apexM, distance, totalLengthM);
             base.throttleOnM = fromApex > totalLengthM / 2 ? fromApex - totalLengthM : fromApex;
             base.throttleOnSource = throttleOn.source;
           }
         }
       }
       const pedal = (['accelPedalPct', 'throttlePct'] as const).find((channel) =>
         hasValue(series.channels.get(channel), exitZone.run),
       );
       if (pedal !== undefined) {
         const values = series.channels.get(pedal) ?? [];
         let fullM = 0;
         let totalM = 0;
         for (let position = 0; position + 1 < exitZone.run.indices.length; position += 1) {
           const index = exitZone.run.indices[position];
           const nextIndex = exitZone.run.indices[position + 1];
           if (index === undefined || nextIndex === undefined) continue;
+          // The join between the two halves of a wrapping exit zone is virtual:
+          // it is not a metre of track, so it is neither driven distance nor
+          // full-throttle distance. Each contiguous run is accumulated on its own.
+          if (nextIndex !== index + 1) continue;
           const dCurrent = series.distanceM[index];
           const dNext = series.distanceM[nextIndex];
           if (dCurrent === undefined || dNext === undefined) continue;
           const stepM = forwardDistance(dCurrent, dNext, totalLengthM);
           if (!(stepM > 0) || stepM > totalLengthM / 2) continue;
           totalM += stepM;
           const value = values[index];
           if (value !== null && value !== undefined && value >= FULL_THROTTLE_PCT) fullM += stepM;
         }
         if (totalM > 0) base.fullThrottleFraction = fullM / totalM;
       }
     }
 
     base.quality.ok = base.quality.flags.length === 0;
     return base;
   });
 }
diff --git a/packages/core/src/coaching/distanceDomain.ts b/packages/core/src/coaching/distanceDomain.ts
index 1630ffa..d8fa3e1 100644
--- a/packages/core/src/coaching/distanceDomain.ts
+++ b/packages/core/src/coaching/distanceDomain.ts
@@ -230,93 +230,109 @@ export function joinTelemetryChannels(
 
   const latest = new Map<CoachingChannelId, { value: number; tMonoMs: number }>();
   let cursor = 0;
   return samples.map((sample) => {
     while (cursor < ordered.length) {
       const entry = ordered[cursor];
       if (entry === undefined || entry.tMonoMs > sample.tMonoMs) break;
       latest.set(entry.channel, { value: entry.value, tMonoMs: entry.tMonoMs });
       cursor += 1;
     }
     const channels: Partial<Record<CoachingChannelId, number>> = { ...(sample.channels ?? {}) };
     for (const channel of ANALYSIS_CHANNELS) {
       const entry = latest.get(channel);
       if (entry !== undefined && sample.tMonoMs - entry.tMonoMs <= maxStalenessMs) {
         channels[channel] = entry.value;
       }
     }
     return Object.keys(channels).length === 0 ? { ...sample } : { ...sample, channels };
   });
 }
 
 // ---------------------------------------------------------------------------
 // 3. Resampling onto the distance grid
 // ---------------------------------------------------------------------------
 
 export interface DistanceGridOptions {
   totalLengthM: number;
   /** Grid spacing, metres. Default `DEFAULT_GRID_STEP_M` (1 m). */
   stepM?: number;
   /** Largest sample-to-sample distance still bridged by interpolation. */
   maxBridgeM?: number;
   /** Channels to resample. Default: every analysis channel present in the samples. */
   channels?: readonly CoachingChannelId[];
 }
 
 export interface DistanceGrid {
   stepM: number;
   totalLengthM: number;
   /** Grid distances from S/F, metres: `[0, stepM, 2*stepM, ...]`. */
   distanceM: number[];
-  /** Milliseconds since the lap's first projected sample, per grid point. */
+  /**
+   * `t(s)`: milliseconds since THIS LAP's start/finish crossing, per grid point.
+   * The origin is the line, never the first recorded fix, so two laps sliced at
+   * different points are still directly comparable.
+   */
   elapsedMs: (number | null)[];
   speedKph: (number | null)[];
   /** Resampled channel values, keyed by channel id; every array is grid-length. */
   channels: Partial<Record<CoachingChannelId, (number | null)[]>>;
   /** True where `elapsedMs` came from real samples close enough to interpolate. */
   covered: boolean[];
-  /** Lap distance of the first projected sample (the `elapsedMs` origin). */
+  /** Lap distance the clock is anchored at: the start/finish line, 0 m. */
   originDistanceM: number;
-  /** Monotonic timestamp of that first sample. */
+  /** Monotonic timestamp of that crossing (interpolated between the two fixes around it). */
   originTMonoMs: number;
   /** Fraction of grid points covered, 0..1. */
   coverageFraction: number;
+  /**
+   * `∫ds/v(s)` over the covered lap MINUS the measured span between the same two
+   * points, milliseconds. Positive = the integral is slower than the clock.
+   * `null` when the profile could not be integrated (no speed somewhere).
+   */
+  timeIntegrationDriftMs: number | null;
+  /**
+   * True when `|timeIntegrationDriftMs|` is more than
+   * `TIME_INTEGRATION_DRIFT_TOLERANCE` of the measured span: the speed profile
+   * and the timestamps disagree, and `t(s)` is only as good as the speeds.
+   */
+  timeIntegrationDriftExceeded: boolean;
 }
 
 interface UnwrappedSample {
   du: number;
   tMonoMs: number;
   speedKph: number | null;
   channels: Readonly<Partial<Record<CoachingChannelId, number>>>;
 }
 
 function unwrapSamples(
   samples: readonly CornerLapSample[],
   totalLengthM: number,
 ): UnwrappedSample[] {
   const out: UnwrappedSample[] = [];
   let previous: CornerLapSample | undefined;
   let du = 0;
   for (const sample of samples) {
     if (!Number.isFinite(sample.distanceM) || !Number.isFinite(sample.tMonoMs)) {
       throw new RangeError('every sample needs a finite tMonoMs and distanceM');
     }
     if (previous === undefined) {
       du = normalizeDistance(sample.distanceM, totalLengthM);
     } else {
       const forward = forwardDistance(previous.distanceM, sample.distanceM, totalLengthM);
       const step = forward > totalLengthM / 2 ? forward - totalLengthM : forward;
       du += Math.max(0, step);
     }
     const last = out[out.length - 1];
     const speedKph = sample.speedKph;
     out.push({
       du: last === undefined ? du : Math.max(du, last.du),
       tMonoMs: sample.tMonoMs,
       speedKph: speedKph === undefined || !Number.isFinite(speedKph) ? null : speedKph,
       channels: sample.channels ?? {},
     });
     previous = sample;
   }
   return out;
 }
 
@@ -324,337 +340,433 @@ function interpolateAt(
   points: readonly { du: number; value: number }[],
   target: number,
   maxBridgeM: number,
 ): number | null {
   if (points.length === 0) return null;
   const first = points[0];
   const last = points[points.length - 1];
   if (first === undefined || last === undefined) return null;
   if (target < first.du || target > last.du) return null;
   let low = 0;
   let high = points.length - 1;
   while (high - low > 1) {
     const mid = (low + high) >> 1;
     const point = points[mid];
     if (point === undefined) return null;
     if (point.du <= target) low = mid;
     else high = mid;
   }
   const a = points[low];
   const b = points[high];
   if (a === undefined || b === undefined) return null;
   if (b.du - a.du > maxBridgeM) return null;
   if (b.du === a.du) return a.value;
   const ratio = (target - a.du) / (b.du - a.du);
   return a.value + (b.value - a.value) * ratio;
 }
 
 /** Half-width of the moving average applied to a ds/dt speed profile, metres. */
 const SPEED_SMOOTHING_HALF_WIDTH_M = 7;
 /** Below this the car is standing still and `ds/v` cannot carry the clock. */
 const MIN_INTEGRATION_SPEED_MPS = 0.05;
 
 /**
  * Fills the grid speed where GNSS Doppler was absent, from `ds/dt` of the
  * timestamp curve, and smooths ONLY those derived values (the Doppler speed is
  * a measurement and is never altered) -- `analysis-engine.md` §2.2.
  */
 function fillDerivedSpeed(
   order: readonly number[],
   targets: readonly (number | null)[],
-  elapsedMs: readonly (number | null)[],
+  measuredAbsMs: readonly (number | null)[],
   speedKph: (number | null)[],
   stepM: number,
 ): void {
   const derived: (number | null)[] = new Array<number | null>(order.length).fill(null);
   for (let position = 0; position < order.length; position += 1) {
     const index = order[position];
     if (index === undefined || speedKph[index] !== null) continue;
     const before = order[Math.max(0, position - 1)];
     const after = order[Math.min(order.length - 1, position + 1)];
     if (before === undefined || after === undefined || before === after) continue;
     const ds = (targets[after] ?? 0) - (targets[before] ?? 0);
-    const dtMs = (elapsedMs[after] ?? 0) - (elapsedMs[before] ?? 0);
+    const dtMs = (measuredAbsMs[after] ?? 0) - (measuredAbsMs[before] ?? 0);
     if (!(ds > 0) || !(dtMs > 0)) continue;
     derived[position] = (ds / (dtMs / 1_000)) * 3.6;
   }
   const window = Math.max(1, Math.round(SPEED_SMOOTHING_HALF_WIDTH_M / stepM));
   for (let position = 0; position < order.length; position += 1) {
     const index = order[position];
     if (index === undefined || derived[position] === null) continue;
     let sum = 0;
     let count = 0;
     for (let probe = position - window; probe <= position + window; probe += 1) {
       const value = probe < 0 || probe >= order.length ? null : derived[probe];
       if (value === null || value === undefined) continue;
       sum += value;
       count += 1;
     }
     speedKph[index] = count === 0 ? (derived[position] ?? null) : sum / count;
   }
 }
 
+/** Relative disagreement between the integral and the clock that gets reported. */
+export const TIME_INTEGRATION_DRIFT_TOLERANCE = 0.02;
+
+interface TimeIntegration {
+  /** `elapsedMs` written for every covered grid point. */
+  originTMonoMs: number;
+  driftMs: number;
+  measuredMs: number;
+}
+
 /**
- * Turns `t(s)` into the integral the design asks for: `t(s) = sum ds / v(s)`.
+ * `t(s) = sum ds / v(s)`, anchored at the start/finish crossing
+ * (`analysis-engine.md` line 29). The measured timestamps do NOT distribute the
+ * time -- they only place the whole curve on the real clock and then VALIDATE
+ * it: the difference between the integral and the measured span is reported as
+ * `timeIntegrationDriftMs`. So 10 m covered at 20 m/s contribute 0.5 s even when
+ * the two fixes around them are 2 s apart.
  *
- * The speed profile decides HOW the time is distributed inside each pair of
- * real samples (so sub-sample resolution follows the physics, not timestamp
- * jitter), while the measured timestamps still anchor both ends of every
- * interval -- a standstill, where `ds/v` carries no clock at all, therefore
- * keeps its real duration. Where no speed profile exists the linear-in-distance
- * interpolation stands.
+ * The one thing `ds/v` cannot express is time that passes without distance: a
+ * standstill. Its measured duration is added at the distance where it happened,
+ * which is a measurement too, not an interpolation.
  */
-function integrateElapsedFromSpeed(
+function integrateElapsed(
   order: readonly number[],
   targets: readonly (number | null)[],
   elapsedMs: (number | null)[],
   speedKph: readonly (number | null)[],
   unwrapped: readonly UnwrappedSample[],
-  originTMonoMs: number,
-): void {
-  if (order.length < 2) return;
-  // Cumulative "model time" (seconds) along the grid: sum of ds / v.
+  measuredAbs: readonly (number | null)[],
+  anchorDu: number,
+): TimeIntegration | null {
+  if (order.length < 2) return null;
+  const duAt = (position: number): number => targets[order[position] as number] ?? 0;
+  const speedAt = (position: number): number | null => {
+    const value = speedKph[order[position] as number];
+    return value === null || value === undefined || !Number.isFinite(value) ? null : value;
+  };
+
+  // 1. the integral itself, seconds.
   const model: number[] = new Array<number>(order.length).fill(0);
   for (let position = 1; position < order.length; position += 1) {
-    const previous = order[position - 1];
-    const current = order[position];
-    if (previous === undefined || current === undefined) return;
-    const ds = (targets[current] ?? 0) - (targets[previous] ?? 0);
-    const a = speedKph[previous];
-    const b = speedKph[current];
-    if (a === null || a === undefined || b === null || b === undefined || !(ds > 0)) return;
+    const ds = duAt(position) - duAt(position - 1);
+    const a = speedAt(position - 1);
+    const b = speedAt(position);
+    if (a === null || b === null || !(ds > 0)) return null;
     const mean = Math.max(MIN_INTEGRATION_SPEED_MPS, (a + b) / 2 / 3.6);
     model[position] = (model[position - 1] ?? 0) + ds / mean;
   }
-  const modelAt = (du: number): number | null => {
+
+  // 2. time spent standing still, where `ds/v` carries no clock at all.
+  const stalls: { du: number; ms: number }[] = [];
+  for (let index = 0; index + 1 < unwrapped.length; index += 1) {
+    const a = unwrapped[index];
+    const b = unwrapped[index + 1];
+    if (a === undefined || b === undefined) continue;
+    const ms = b.tMonoMs - a.tMonoMs;
+    if (b.du > a.du || !(ms > 0)) continue;
+    stalls.push({ du: a.du, ms });
+  }
+  const stalledBefore = (du: number): number => {
+    let total = 0;
+    for (const stall of stalls) if (stall.du < du) total += stall.ms;
+    return total;
+  };
+  const timeAt = (position: number): number =>
+    (model[position] ?? 0) * 1_000 + stalledBefore(duAt(position));
+
+  // 3. the same curve at an arbitrary distance -- the start/finish crossing sits
+  //    between two grid points, or (a lap sliced a few metres late) just before
+  //    the first one, where the nearest speed extrapolates it.
+  const lastPosition = order.length - 1;
+  const timeAtDu = (du: number): number => {
+    if (du <= duAt(0)) {
+      const speed = speedAt(0);
+      const mps = speed === null ? null : Math.max(MIN_INTEGRATION_SPEED_MPS, speed / 3.6);
+      return timeAt(0) - (mps === null ? 0 : ((duAt(0) - du) / mps) * 1_000);
+    }
+    if (du >= duAt(lastPosition)) {
+      const speed = speedAt(lastPosition);
+      const mps = speed === null ? null : Math.max(MIN_INTEGRATION_SPEED_MPS, speed / 3.6);
+      return timeAt(lastPosition) + (mps === null ? 0 : ((du - duAt(lastPosition)) / mps) * 1_000);
+    }
     let low = 0;
-    let high = order.length - 1;
-    const firstTarget = targets[order[0] as number] ?? 0;
-    const lastTarget = targets[order[order.length - 1] as number] ?? 0;
-    if (du <= firstTarget) return model[0] ?? 0;
-    if (du >= lastTarget) return model[order.length - 1] ?? 0;
+    let high = lastPosition;
     while (high - low > 1) {
       const mid = (low + high) >> 1;
-      if ((targets[order[mid] as number] ?? 0) <= du) low = mid;
+      if (duAt(mid) <= du) low = mid;
       else high = mid;
     }
-    const lowTarget = targets[order[low] as number] ?? 0;
-    const highTarget = targets[order[high] as number] ?? 0;
-    const lowModel = model[low] ?? 0;
-    const highModel = model[high] ?? 0;
-    if (highTarget === lowTarget) return lowModel;
-    return lowModel + ((highModel - lowModel) * (du - lowTarget)) / (highTarget - lowTarget);
+    const span = duAt(high) - duAt(low);
+    if (!(span > 0)) return timeAt(low);
+    return timeAt(low) + ((timeAt(high) - timeAt(low)) * (du - duAt(low))) / span;
   };
 
-  let cursor = 0;
-  for (const index of order) {
-    const target = targets[index];
-    if (target === null || target === undefined) continue;
-    while (cursor + 1 < unwrapped.length && (unwrapped[cursor + 1]?.du ?? 0) < target) cursor += 1;
-    const a = unwrapped[cursor];
-    const b = unwrapped[cursor + 1];
-    if (a === undefined || b === undefined) continue;
-    if (target < a.du || target > b.du) continue;
-    const spanMs = b.tMonoMs - a.tMonoMs;
-    const modelA = modelAt(a.du);
-    const modelB = modelAt(b.du);
-    if (modelA === null || modelB === null) continue;
-    const modelSpan = modelB - modelA;
-    if (!(modelSpan > 0) || !Number.isFinite(spanMs)) continue;
-    const fraction = ((modelAt(target) ?? modelA) - modelA) / modelSpan;
-    if (!Number.isFinite(fraction)) continue;
-    elapsedMs[index] = a.tMonoMs + fraction * spanMs - originTMonoMs;
+  const anchorMs = timeAtDu(anchorDu);
+  for (let position = 0; position < order.length; position += 1) {
+    elapsedMs[order[position] as number] = timeAt(position) - anchorMs;
   }
+
+  const firstMeasured = measuredAbs[order[0] as number];
+  const lastMeasured = measuredAbs[order[lastPosition] as number];
+  const measuredMs =
+    firstMeasured === null ||
+    firstMeasured === undefined ||
+    lastMeasured === null ||
+    lastMeasured === undefined
+      ? 0
+      : lastMeasured - firstMeasured;
+  return {
+    originTMonoMs: (firstMeasured ?? 0) - (timeAt(0) - anchorMs),
+    driftMs: timeAt(lastPosition) - timeAt(0) - measuredMs,
+    measuredMs,
+  };
+}
+
+/**
+ * The start/finish crossing this lap's clock is anchored at, as unwrapped
+ * distance. A lap handed over with a lead-in from the previous lap crosses the
+ * line twice; the crossing that starts THIS lap is the one whose forward lap
+ * covers the most of the samples, and mapping every grid point off that single
+ * crossing is what keeps `t(s)` monotone from 0 m to the flag.
+ */
+function chooseAnchorDu(
+  firstDu: number,
+  lastDu: number,
+  totalLengthM: number,
+  stepM: number,
+  gridSize: number,
+): number {
+  let bestAnchor = 0;
+  let bestCount = -1;
+  const lastTurn = Math.max(0, Math.floor(lastDu / totalLengthM));
+  for (let turn = 0; turn <= lastTurn; turn += 1) {
+    const anchor = turn * totalLengthM;
+    let count = 0;
+    for (let index = 0; index < gridSize; index += 1) {
+      const target = anchor + index * stepM;
+      if (target >= firstDu && target <= lastDu) count += 1;
+    }
+    if (count > bestCount) {
+      bestCount = count;
+      bestAnchor = anchor;
+    }
+  }
+  return bestAnchor;
 }
 
 /**
  * Resamples one lap onto a fixed distance grid. Grid points outside the
  * sampled distance range, or inside a gap wider than `maxBridgeM`, are `null`
  * (and `covered[k] === false`) -- never guessed.
  */
 export function resampleLapToDistanceGrid(
   samples: readonly CornerLapSample[],
   options: DistanceGridOptions,
 ): DistanceGrid {
   assertPositiveLength(options.totalLengthM);
   const stepM = options.stepM ?? DEFAULT_GRID_STEP_M;
   if (!Number.isFinite(stepM) || stepM <= 0) {
     throw new RangeError('stepM must be a positive, finite number of metres');
   }
   const maxBridgeM = options.maxBridgeM ?? DEFAULT_MAX_BRIDGE_M;
   if (!Number.isFinite(maxBridgeM) || maxBridgeM <= 0) {
     throw new RangeError('maxBridgeM must be a positive, finite number of metres');
   }
   const totalLengthM = options.totalLengthM;
   const gridSize = Math.max(1, Math.ceil(totalLengthM / stepM));
   const distanceM = Array.from({ length: gridSize }, (_, index) => index * stepM);
   const unwrapped = unwrapSamples(samples, totalLengthM);
   const first = unwrapped[0];
   const last = unwrapped[unwrapped.length - 1];
 
   const requested =
     options.channels ??
     ANALYSIS_CHANNELS.filter((channel) =>
       unwrapped.some((sample) => Number.isFinite(sample.channels[channel])),
     );
   const channelPoints = new Map<CoachingChannelId, { du: number; value: number }[]>();
   for (const channel of requested) {
     channelPoints.set(
       channel,
       unwrapped
         .filter((sample) => Number.isFinite(sample.channels[channel]))
         .map((sample) => ({ du: sample.du, value: sample.channels[channel] as number })),
     );
   }
 
   const elapsedMs: (number | null)[] = new Array<number | null>(gridSize).fill(null);
   const speedKph: (number | null)[] = new Array<number | null>(gridSize).fill(null);
   const covered: boolean[] = new Array<boolean>(gridSize).fill(false);
   const channels: Partial<Record<CoachingChannelId, (number | null)[]>> = {};
   for (const channel of requested) {
     channels[channel] = new Array<number | null>(gridSize).fill(null);
   }
 
   if (first === undefined || last === undefined) {
     return {
       stepM,
       totalLengthM,
       distanceM,
       elapsedMs,
       speedKph,
       channels,
       covered,
       originDistanceM: 0,
       originTMonoMs: 0,
       coverageFraction: 0,
+      timeIntegrationDriftMs: null,
+      timeIntegrationDriftExceeded: false,
     };
   }
 
   const timePoints = unwrapped.map((sample) => ({ du: sample.du, value: sample.tMonoMs }));
   const speedPoints = unwrapped
     .filter((sample) => sample.speedKph !== null)
     .map((sample) => ({ du: sample.du, value: sample.speedKph as number }));
 
-  // --- pass 1: coverage, the timestamp-interpolated time, Doppler speed ------
+  // --- pass 1: coverage, the measured time, Doppler speed --------------------
+  // Every grid point is measured off ONE start/finish crossing, so grid index 0
+  // is this lap's beginning and grid index n-1 its end -- never the lead-in of
+  // the previous lap that happens to sit at the same distance.
+  const anchorDu = chooseAnchorDu(first.du, last.du, totalLengthM, stepM, gridSize);
   const targets: (number | null)[] = new Array<number | null>(gridSize).fill(null);
+  const measuredAbs: (number | null)[] = new Array<number | null>(gridSize).fill(null);
   let coveredCount = 0;
   for (let index = 0; index < gridSize; index += 1) {
-    const base = index * stepM;
-    // The lap may start anywhere; try the wrap offsets that can land inside the
-    // sampled span, smallest first, so the mapping is deterministic.
-    let target: number | null = null;
-    for (let turn = Math.floor((first.du - base) / totalLengthM); ; turn += 1) {
-      const candidate = base + turn * totalLengthM;
-      if (candidate > last.du) break;
-      if (candidate >= first.du) {
-        target = candidate;
-        break;
-      }
-    }
-    if (target === null) continue;
+    const target = anchorDu + index * stepM;
+    if (target < first.du || target > last.du) continue;
     const t = interpolateAt(timePoints, target, maxBridgeM);
     if (t === null) continue;
     targets[index] = target;
-    elapsedMs[index] = t - first.tMonoMs;
+    measuredAbs[index] = t;
     covered[index] = true;
     coveredCount += 1;
     speedKph[index] = interpolateAt(speedPoints, target, maxBridgeM);
     for (const channel of requested) {
       const points = channelPoints.get(channel);
       const series = channels[channel];
       if (points === undefined || series === undefined) continue;
       series[index] = interpolateAt(points, target, maxBridgeM);
     }
   }
 
-  // Grid points in TRAVEL order (a lap may start anywhere on the grid).
+  // Grid points in travel order -- the targets increase with the grid index.
   const order = distanceM
     .map((_value, index) => index)
-    .filter((index) => covered[index] === true)
-    .sort((a, b) => (targets[a] ?? 0) - (targets[b] ?? 0));
+    .filter((index) => covered[index] === true);
 
-  fillDerivedSpeed(order, targets, elapsedMs, speedKph, stepM);
-  integrateElapsedFromSpeed(order, targets, elapsedMs, speedKph, unwrapped, first.tMonoMs);
+  fillDerivedSpeed(order, targets, measuredAbs, speedKph, stepM);
+  const integration = integrateElapsed(
+    order,
+    targets,
+    elapsedMs,
+    speedKph,
+    unwrapped,
+    measuredAbs,
+    anchorDu,
+  );
+  // No usable speed profile: the measured clock stands in for the integral, and
+  // no drift is claimed. The crossing is still the origin.
+  const fallbackOrigin =
+    interpolateAt(timePoints, anchorDu, maxBridgeM) ??
+    measuredAbs[order[0] ?? -1] ??
+    first.tMonoMs;
+  if (integration === null) {
+    for (const index of order) {
+      const measured = measuredAbs[index];
+      if (measured !== null && measured !== undefined) elapsedMs[index] = measured - fallbackOrigin;
+    }
+  }
 
   return {
     stepM,
     totalLengthM,
     distanceM,
     elapsedMs,
     speedKph,
     channels,
     covered,
-    originDistanceM: normalizeDistance(first.du, totalLengthM),
-    originTMonoMs: first.tMonoMs,
+    originDistanceM: 0,
+    originTMonoMs: integration?.originTMonoMs ?? fallbackOrigin,
     coverageFraction: coveredCount / gridSize,
+    timeIntegrationDriftMs: integration?.driftMs ?? null,
+    timeIntegrationDriftExceeded:
+      integration !== null &&
+      integration.measuredMs > 0 &&
+      Math.abs(integration.driftMs) > TIME_INTEGRATION_DRIFT_TOLERANCE * integration.measuredMs,
   };
 }
 
 // ---------------------------------------------------------------------------
 // 4. Delta curve
 // ---------------------------------------------------------------------------
 
 /**
  * `dt(s) = t_lap(s) - t_ref(s)` on the shared grid. `null` wherever either lap
  * has no covered value. Both grids must share step and circuit length.
  */
 export function deltaCurveMs(lap: DistanceGrid, reference: DistanceGrid): (number | null)[] {
   if (lap.stepM !== reference.stepM || lap.totalLengthM !== reference.totalLengthM) {
     throw new RangeError('delta needs two grids with the same stepM and totalLengthM');
   }
   return lap.elapsedMs.map((value, index) => {
     const other = reference.elapsedMs[index];
     if (value === null || other === null || other === undefined) return null;
     return value - other;
   });
 }
 
 /**
  * Time gained (negative) or lost (positive) between two lap distances: the
  * change of the delta curve across the segment, which is independent of where
  * each lap's `elapsedMs` origin sits. `null` when an end is uncovered.
  *
  * A segment that crosses the start/finish line is TWO stretches of the curve --
  * `startM -> end of lap` and `start of lap -> endM` -- and its contribution is
  * their sum. Subtracting `delta[endM] - delta[startM]` across the line instead
  * would report a slower-everywhere lap as having GAINED almost a full lap's
- * delta on that sector.
+ * delta on that sector. Both terms only mean anything because each grid's
+ * `t(s)` is anchored at ITS OWN start/finish crossing: "start of lap" is then
+ * 0 m for every lap, however many metres after the line its first fix landed.
  */
 export function deltaOverSegmentMs(
   delta: readonly (number | null)[],
   startM: number,
   endM: number,
   grid: Pick<DistanceGrid, 'stepM' | 'totalLengthM'>,
 ): number | null {
   assertPositiveLength(grid.totalLengthM);
   if (delta.length === 0) return null;
   const indexOf = (distance: number): number => {
     const wrapped = normalizeDistance(distance, grid.totalLengthM);
     return Math.min(delta.length - 1, Math.max(0, Math.round(wrapped / grid.stepM) % delta.length));
   };
   const at = (index: number): number | null => {
     const value = delta[index];
     return value === null || value === undefined || !Number.isFinite(value) ? null : value;
   };
   const startValue = at(indexOf(startM));
   const endValue = at(indexOf(endM));
   if (startValue === null || endValue === null) return null;
   if (!windowWraps(startM, endM, grid.totalLengthM)) return endValue - startValue;
   // The lap's own last and first covered grid points stand for "end of lap" and
   // "start of lap": the delta accumulated between them is a full lap's worth.
   let lapEndIndex = -1;
   for (let index = delta.length - 1; index >= 0; index -= 1) {
     if (at(index) !== null) {
       lapEndIndex = index;
       break;
     }
   }
   let lapStartIndex = -1;
   for (let index = 0; index < delta.length; index += 1) {
     if (at(index) !== null) {
       lapStartIndex = index;
       break;
     }
   }
   if (lapEndIndex < indexOf(startM) || lapStartIndex > indexOf(endM)) return null;
   const lapEndValue = at(lapEndIndex);
   const lapStartValue = at(lapStartIndex);
diff --git a/packages/core/src/coaching/reportText.ts b/packages/core/src/coaching/reportText.ts
index fd4f5bc..9d919b8 100644
--- a/packages/core/src/coaching/reportText.ts
+++ b/packages/core/src/coaching/reportText.ts
@@ -316,99 +316,119 @@ function overviewLines(insights: SessionInsights, language: ReportLanguage): str
         ? `Tururi excluse din comparații: ${lapList(anomalous.map((lap) => lap.lapNumber), language)} (${why.join('; ')}).`
         : `Laps excluded from the comparisons: ${lapList(anomalous.map((lap) => lap.lapNumber), language)} (${why.join('; ')}).`,
     );
   }
   // An unverified lap is not an anomalous lap: nothing went wrong on it, the
   // data simply cannot prove it was clean. Saying "unspecified reason" would be
   // an invented fault.
   const unverified = insights.laps.filter((lap) => lap.status === 'unverified');
   if (unverified.length > 0) {
     const checks = [...new Set(unverified.flatMap((lap) => lap.unavailableChecks))];
     lines.push(
       ro
         ? `Tururile ${lapList(unverified.map((lap) => lap.lapNumber), language)} nu au putut fi verificate (lipsesc datele pentru: ${checkNames(checks, language)}), așa că nu intră în comparații.`
         : `Laps ${lapList(unverified.map((lap) => lap.lapNumber), language)} could not be verified (no data for: ${checkNames(checks, language)}), so they stay out of the comparisons.`,
     );
   }
   if (insights.availability.available.length > 0) {
     lines.push(
       ro
         ? `Canale folosite: ${channelNames(insights.availability.available, language)}.`
         : `Channels used: ${channelNames(insights.availability.available, language)}.`,
     );
   }
   return lines;
 }
 
 function limitationLine(limitation: Limitation, language: ReportLanguage): string {
   const ro = language === 'ro';
   switch (limitation.code) {
     case 'NO_CLEAN_LAPS':
       return ro
         ? 'Niciun tur curat: nu pot compara tururi între ele, doar raporta ce s-a măsurat pe fiecare.'
         : 'No clean lap: laps cannot be compared with each other, only reported one by one.';
     case 'FEW_CLEAN_LAPS':
       return ro
         ? `Doar ${limitation.count ?? 0} tur curat: comparațiile și scorurile de constanță au nevoie de cel puțin 2, așa că raportul rămâne la fapte.`
         : `Only ${limitation.count ?? 0} clean lap: comparisons and consistency scores need at least 2, so the report stays at facts.`;
     case 'UNVERIFIED_LAPS': {
       const laps = limitation.lapNumbers ?? [];
       const one = laps.length === 1;
+      const checks = checkNames(limitation.checks ?? [], language);
+      const percent = limitation.coveragePercent ?? 0;
+      // Evidence that stops after a tenth of the lap is not "no data": the
+      // report says how much of the lap it actually covered.
+      const evidenceRo =
+        percent <= 0
+          ? `lipsesc datele pentru ${checks}`
+          : `datele pentru ${checks} acoperă doar ${percent} % din tur`;
+      const evidenceEn =
+        percent <= 0
+          ? `there is no data for ${checks}`
+          : `the data for ${checks} covers only ${percent} % of the lap`;
       return ro
-        ? `${one ? 'Turul' : 'Tururile'} ${lapList(laps, language)} nu ${one ? 'a putut fi verificat' : 'au putut fi verificate'}: lipsesc datele pentru ${checkNames(limitation.checks ?? [], language)}, așa că ${one ? 'nu poate fi declarat curat' : 'nu pot fi declarate curate'} și ${one ? 'nu intră' : 'nu intră'} în comparații.`
-        : `${one ? 'Lap' : 'Laps'} ${lapList(laps, language)} could not be verified: there is no data for ${checkNames(limitation.checks ?? [], language)}, so ${one ? 'it cannot be called clean' : 'they cannot be called clean'} and ${one ? 'it stays' : 'they stay'} out of the comparisons.`;
+        ? `${one ? 'Turul' : 'Tururile'} ${lapList(laps, language)} nu ${one ? 'a putut fi verificat' : 'au putut fi verificate'}: ${evidenceRo}, așa că ${one ? 'nu poate fi declarat curat' : 'nu pot fi declarate curate'} și ${one ? 'nu intră' : 'nu intră'} în comparații.`
+        : `${one ? 'Lap' : 'Laps'} ${lapList(laps, language)} could not be verified: ${evidenceEn}, so ${one ? 'it cannot be called clean' : 'they cannot be called clean'} and ${one ? 'it stays' : 'they stay'} out of the comparisons.`;
     }
     case 'UNSUPPORTED_CHANNELS':
       return ro
         ? `Mașina/adaptorul nu oferă: ${channelNames(limitation.channels ?? [], language)} — metricile care depind de ele lipsesc.`
         : `Your car/adapter does not provide: ${channelNames(limitation.channels ?? [], language)} — the metrics that need them are absent.`;
     case 'MISSING_CHANNELS':
       return ro
         ? `Nu au fost înregistrate: ${channelNames(limitation.channels ?? [], language)} — s-a folosit estimarea din GPS/IMU acolo unde există.`
         : `Not recorded in this session: ${channelNames(limitation.channels ?? [], language)} — the GPS/IMU estimator was used where one exists.`;
     case 'GNSS_QUALITY': {
       const laps = limitation.lapNumbers ?? [];
       const one = laps.length === 1;
       return ro
         ? `Calitate GPS slabă în ${one ? 'turul' : 'tururile'} ${lapList(laps, language)} — punctele de frânare de acolo sunt aproximative.`
         : `Poor GPS quality on ${one ? 'lap' : 'laps'} ${lapList(laps, language)} — braking points there are approximate.`;
     }
+    case 'TIME_INTEGRATION_DRIFT': {
+      const laps = limitation.lapNumbers ?? [];
+      const one = laps.length === 1;
+      const gap = seconds(Math.abs(limitation.driftMs ?? 0), language);
+      return ro
+        ? `În ${one ? 'turul' : 'tururile'} ${lapList(laps, language)} viteza înregistrată și ceasul nu sunt de acord (${gap} pe tur), așa că timpii pe distanță de acolo sunt la fel de buni ca semnalul de viteză.`
+        : `On ${one ? 'lap' : 'laps'} ${lapList(laps, language)} the recorded speed and the clock disagree (${gap} over the lap), so the time-at-distance there is only as good as the speed signal.`;
+    }
     case 'GEOMETRY_UNVALIDATED':
       return ro
         ? 'Geometria circuitului nu este validată pe teren, deci pozițiile virajelor (și distanțele față de ele) sunt aproximative.'
         : 'This circuit geometry has not been validated on track, so corner positions (and the distances to them) are approximate.';
     case 'CORNER_COVERAGE': {
       const cornerIds = limitation.cornerIds ?? [];
       const one = cornerIds.length === 1;
       return ro
         ? `${one ? 'Virajul' : 'Virajele'} ${lapList(cornerIds, language)} nu ${one ? 'a fost măsurat' : 'au fost măsurate'} curat în niciun tur.`
         : `${one ? 'Corner' : 'Corners'} ${lapList(cornerIds, language)} ${one ? 'was' : 'were'} not cleanly measured on any lap.`;
     }
     default:
       return '';
   }
 }
 
 function timeLossLine(finding: TimeLossFinding, language: ReportLanguage): string | null {
   const ro = language === 'ro';
   const parts: string[] = [];
   if (finding.deltaMs !== null) {
     parts.push(
       ro
         ? `pe turul ${finding.comparisonLapNumber} ${gainOrLoss(finding.deltaMs, language)} față de turul ${finding.referenceLapNumber}`
         : `on lap ${finding.comparisonLapNumber} ${gainOrLoss(finding.deltaMs, language)} against lap ${finding.referenceLapNumber}`,
     );
   }
   if (
     finding.sectorLossMs !== null &&
     finding.bestSectorMs !== null &&
     finding.bestSectorLapNumber !== null &&
     finding.comparisonSectorMs !== null
   ) {
     parts.push(
       finding.sectorLossMs > 0
         ? ro
           ? `ai trecut virajul în ${seconds(finding.comparisonSectorMs, language)}, cu ${seconds(finding.sectorLossMs, language)} mai mult decât cel mai bun al tău (${seconds(finding.bestSectorMs, language)}, turul ${finding.bestSectorLapNumber})`
           : `you took ${seconds(finding.comparisonSectorMs, language)} through it, ${seconds(finding.sectorLossMs, language)} more than your own best (${seconds(finding.bestSectorMs, language)} on lap ${finding.bestSectorLapNumber})`
         : ro
           ? `ai trecut virajul în ${seconds(finding.comparisonSectorMs, language)}, cel mai bun timp al tău prin el`
           : `you took ${seconds(finding.comparisonSectorMs, language)} through it, your own best time there`,
diff --git a/packages/core/src/coaching/sessionInsights.ts b/packages/core/src/coaching/sessionInsights.ts
index 592185c..0c60bb8 100644
--- a/packages/core/src/coaching/sessionInsights.ts
+++ b/packages/core/src/coaching/sessionInsights.ts
@@ -60,80 +60,82 @@ export interface SessionLapInput {
   /** The timing engine's lap record (a `LapRecord` satisfies `ClassifiableLap`). */
   lap: ClassifiableLap;
   /** Projected, time-ordered samples of that lap. */
   samples: readonly CornerLapSample[];
   /** Optional sector times from the timing engine. */
   sectorTimes?: readonly { sectorIndex: number; durationMs: number }[];
 }
 
 export interface SessionAnalysisContext {
   totalLengthM: number;
   circuitId: string;
   circuitName?: string;
   layoutId?: string;
   /** Channels this vehicle/session does not provide; never read. */
   unsupportedChannels?: readonly CoachingChannelId[];
   /**
    * False when the circuit geometry has not been validated in the field
    * (MotorPark today) -- corner positions are then approximate and the report
    * says so.
    */
   geometryValidated?: boolean;
   cornerMetrics?: Omit<Partial<CornerMetricsOptions>, 'totalLengthM' | 'unsupportedChannels'>;
   cleanLap?: Omit<Partial<ClassifyLapOptions>, 'totalLengthM'>;
   /** Distance-grid step for the delta curve, metres. Default 1. */
   gridStepM?: number;
 }
 
 export interface LapInsight {
   lapNumber: number;
   durationMs: number;
   valid: boolean;
   /** `clean` / `unverified` / `anomalous` -- see `LapStatus`. */
   status: LapStatus;
   /** True only for `status === 'clean'`. */
   clean: boolean;
   reason: LapAnomalyReason | null;
   reasons: LapAnomalyReason[];
   detail: string;
   /** Safety checks this lap's samples could not support. */
   unavailableChecks: LapCheckId[];
+  /** Fraction of the lap distance each safety check had evidence over, 0..1. */
+  checkCoverage: Record<LapCheckId, number>;
   coverageFraction: number;
   corners: CornerMetrics[];
 }
 
 export interface CornerLapRow {
   lapNumber: number;
   clean: boolean;
   brakeStartM: number | null;
   brakeSource: CornerMetrics['brakeSource'];
   liftPointM: number | null;
   liftSource: CornerMetrics['liftSource'];
   peakDecelG: number | null;
   minSpeedKph: number | null;
   exitSpeedKph: number | null;
   sectorMs: number | null;
   throttleOnM: number | null;
   maxLatG: number | null;
   frictionCircleMaxG: number | null;
   /** Time lost (+) or gained (-) against the reference lap over this corner, ms. */
   deltaMs: number | null;
   qualityOk: boolean;
 }
 
 export type TimeLossCause =
   | 'EARLIER_BRAKE'
   | 'EARLIER_LIFT'
   | 'LOWER_MIN_SPEED'
   | 'LOWER_EXIT_SPEED'
   | 'LATER_THROTTLE';
 
 export interface TimeLossFinding {
   cornerId: number;
   /** The reference (best clean) lap this corner is measured against. */
   referenceLapNumber: number;
   /**
    * The REPRESENTATIVE clean lap whose loss against the reference is ranked:
    * the median clean lap from three laps up, and the other clean lap when the
    * session has exactly the two the honesty gate requires.
    */
   comparisonLapNumber: number;
@@ -175,91 +177,103 @@ export interface ConsistencyFinding {
 export interface SectorLossFinding {
   sectorIndex: number;
   referenceLapNumber: number;
   referenceMs: number;
   /** The same representative lap the corner ranking compares (see `TimeLossFinding`). */
   comparisonLapNumber: number;
   comparisonMs: number;
   /** `comparisonMs - referenceMs`: positive = lost, negative = gained. */
   lostMs: number;
 }
 
 export interface CornerInsight {
   cornerId: number;
   entryDistanceM: number;
   apexDistanceM: number;
   exitDistanceM: number;
   direction: Corner['direction'];
   severity: Corner['severity'];
   advisorySpeedKph: number;
   /** Rows for every lap, clean or not, ordered by lap number. */
   perLap: CornerLapRow[];
   cleanLapCount: number;
   bestSectorMs: number | null;
   bestSectorLapNumber: number | null;
   medianSectorMs: number | null;
   worstSectorMs: number | null;
   worstSectorLapNumber: number | null;
   envelope: CornerEnvelope | null;
   consistency: ConsistencyFinding | null;
   timeLoss: TimeLossFinding | null;
 }
 
 export type LimitationCode =
   | 'NO_CLEAN_LAPS'
   | 'FEW_CLEAN_LAPS'
   | 'UNVERIFIED_LAPS'
   | 'UNSUPPORTED_CHANNELS'
   | 'MISSING_CHANNELS'
   | 'GNSS_QUALITY'
   | 'GEOMETRY_UNVALIDATED'
-  | 'CORNER_COVERAGE';
+  | 'CORNER_COVERAGE'
+  | 'TIME_INTEGRATION_DRIFT';
 
 export interface Limitation {
   code: LimitationCode;
   /** Counts referenced by the rendered sentence (laps, corners, ...). */
   count?: number;
   channels?: CoachingChannelId[];
   lapNumbers?: number[];
   cornerIds?: number[];
   /** Safety checks that could not run (`UNVERIFIED_LAPS`). */
   checks?: LapCheckId[];
+  /**
+   * Percentage of the lap distance the WEAKEST unavailable check had evidence
+   * over (`UNVERIFIED_LAPS`): "no data" and "data for 11 % of the lap" are two
+   * different statements and the report has to make the right one.
+   */
+  coveragePercent?: number;
+  /**
+   * Largest disagreement between the integrated `t(s)` and the recorded clock
+   * on any lap, milliseconds (`TIME_INTEGRATION_DRIFT`).
+   */
+  driftMs?: number;
 }
 
 export interface LapTimeConsistency {
   lapCount: number;
   bestMs: number;
   bestLapNumber: number;
   medianMs: number;
   worstMs: number;
   worstLapNumber: number;
   spreadMs: number;
   score: number;
 }
 
 export interface SessionInsights {
   analysisVersion: number;
   circuitId: string;
   circuitName: string | null;
   layoutId: string | null;
   totalLengthM: number;
   geometryValidated: boolean;
   /** V1 states observations only -- no suggestions are produced. */
   observationsOnly: true;
   lapCount: number;
   cleanLapCount: number;
   laps: LapInsight[];
   referenceLapNumber: number | null;
   referenceDurationMs: number | null;
   medianCleanLapNumber: number | null;
   /** The representative clean lap every comparison in this report uses. */
   comparisonLapNumber: number | null;
   corners: CornerInsight[];
   /** Corners ranked by time lost on the representative clean lap, worst first. */
   timeLossRanking: TimeLossFinding[];
   /** Corners ranked by consistency score, least consistent first (same basis only). */
   consistencyRanking: ConsistencyFinding[];
   sectorTimeLoss: SectorLossFinding[];
   lapTimeConsistency: LapTimeConsistency | null;
   envelope: DemonstratedEnvelope;
   availability: ChannelAvailability;
   limitations: Limitation[];
@@ -314,80 +328,81 @@ export function analyzeSession(
   laps: readonly SessionLapInput[],
   corners: readonly Corner[],
   context: SessionAnalysisContext,
 ): SessionInsights {
   assertPositiveLength(context.totalLengthM);
   const totalLengthM = context.totalLengthM;
   const unsupportedChannels = context.unsupportedChannels ?? [];
   const metricsOptions: CornerMetricsOptions = {
     ...(context.cornerMetrics ?? {}),
     totalLengthM,
     unsupportedChannels,
   };
   const orderedCorners = [...corners].sort((a, b) => a.id - b.id);
   const orderedLaps = [...laps].sort((a, b) => a.lap.lapNumber - b.lap.lapNumber);
   // Lap numbers key every comparison, the envelope and the report sentences: a
   // duplicate would silently make one lap stand for two different drives.
   const seenLapNumbers = new Set<number>();
   for (const entry of orderedLaps) {
     if (seenLapNumbers.has(entry.lap.lapNumber)) {
       throw new RangeError(`duplicate lap number ${entry.lap.lapNumber} in the session`);
     }
     seenLapNumbers.add(entry.lap.lapNumber);
   }
 
   // --- per lap ---------------------------------------------------------------
   const lapInsights: LapInsight[] = orderedLaps.map((entry) => {
     const classification = classifyLap(entry.lap, entry.samples, {
       ...(context.cleanLap ?? {}),
       totalLengthM,
     });
     return {
       lapNumber: entry.lap.lapNumber,
       durationMs: entry.lap.durationMs,
       valid: entry.lap.valid,
       status: classification.status,
       clean: classification.clean,
       reason: classification.reason,
       reasons: classification.reasons,
       detail: classification.detail,
       unavailableChecks: classification.unavailableChecks,
+      checkCoverage: classification.checkCoverage,
       coverageFraction: classification.coverageFraction,
       corners: computeCornerMetrics(entry.samples, orderedCorners, metricsOptions),
     };
   });
 
   const cleanLaps = lapInsights.filter((lap) => lap.clean);
   const envelope = buildDemonstratedEnvelope(
     cleanLaps.map((lap) => ({ lapNumber: lap.lapNumber, corners: lap.corners })),
   );
 
   const availability = channelAvailability(
     orderedLaps.flatMap((entry) => [...entry.samples]),
     unsupportedChannels,
   );
 
   // --- reference and median clean laps ---------------------------------------
   const comparable = cleanLaps.length >= MIN_CLEAN_LAPS_FOR_COMPARISON;
   const reference =
     cleanLaps.length === 0
       ? null
       : cleanLaps.reduce((best, lap) =>
           lap.durationMs < best.durationMs ||
           (lap.durationMs === best.durationMs && lap.lapNumber < best.lapNumber)
             ? lap
             : best,
         );
   const medianLap = comparable ? lowerMedianOf(cleanLaps, (lap) => lap.durationMs) : null;
   // The lap the report compares against the reference. With three or more clean
   // laps that is the median; with exactly the two the honesty gate requires,
   // the median IS the reference, so the other clean lap is the representative
   // one -- otherwise the minimum session that passes the gate would produce an
   // empty priority-1 report.
   const comparisonLap: LapInsight | null =
     !comparable || reference === null
       ? null
       : (() => {
           if (medianLap !== null && medianLap.lapNumber !== reference.lapNumber) return medianLap;
           const rest = [...cleanLaps]
             .filter((lap) => lap.lapNumber !== reference.lapNumber)
             .sort((a, b) => a.durationMs - b.durationMs || a.lapNumber - b.lapNumber);
@@ -661,85 +676,107 @@ export function analyzeSession(
     const best = cleanLaps.reduce((accumulator, lap) =>
       lap.durationMs < accumulator.durationMs ? lap : accumulator,
     );
     const worst = cleanLaps.reduce((accumulator, lap) =>
       lap.durationMs > accumulator.durationMs ? lap : accumulator,
     );
     const median = lowerMedianOf(cleanLaps, (lap) => lap.durationMs);
     if (spreadMs !== null && median !== null) {
       lapTimeConsistency = {
         lapCount: cleanLaps.length,
         bestMs: best.durationMs,
         bestLapNumber: best.lapNumber,
         medianMs: median.durationMs,
         worstMs: worst.durationMs,
         worstLapNumber: worst.lapNumber,
         spreadMs,
         score: Math.round(subScore(spreadMs, CONSISTENCY_LAP_SPREAD_MS) ?? 0),
       };
     }
   }
 
   // --- honesty gates ------------------------------------------------------------
   const limitations: Limitation[] = [];
   if (cleanLaps.length === 0) {
     limitations.push({ code: 'NO_CLEAN_LAPS', count: 0 });
   } else if (!comparable) {
     limitations.push({ code: 'FEW_CLEAN_LAPS', count: cleanLaps.length });
   }
   // A lap whose safety checks could not run is neither clean nor anomalous, and
   // the report has to say which evidence was missing rather than stay silent.
   const unverifiedLaps = lapInsights.filter((lap) => lap.status === 'unverified');
   if (unverifiedLaps.length > 0) {
     const checkOrder: readonly LapCheckId[] = [
       'offTrack',
       'yawSpike',
       'decelSpike',
       'gnssPoor',
       'coverage',
     ];
     const seen = new Set(unverifiedLaps.flatMap((lap) => lap.unavailableChecks));
+    const coverages = unverifiedLaps.flatMap((lap) =>
+      lap.unavailableChecks.map((check) => lap.checkCoverage[check] ?? 0),
+    );
     limitations.push({
       code: 'UNVERIFIED_LAPS',
       count: unverifiedLaps.length,
       lapNumbers: unverifiedLaps.map((lap) => lap.lapNumber),
       checks: checkOrder.filter((check) => seen.has(check)),
+      coveragePercent: Math.round(Math.min(...coverages, 1) * 100),
+    });
+  }
+  // `t(s)` is the integral of ds/v; when a lap's own timestamps disagree with
+  // that integral by more than the tolerance, the delta curve built from it is
+  // only as good as the speed channel, and the report has to say so.
+  const driftingLaps = orderedLaps
+    .map((entry) => ({ lapNumber: entry.lap.lapNumber, grid: grids.get(entry.lap.lapNumber) }))
+    .filter((entry) => entry.grid?.timeIntegrationDriftExceeded === true);
+  if (driftingLaps.length > 0) {
+    const worst = driftingLaps.reduce(
+      (best, entry) => Math.max(best, Math.abs(entry.grid?.timeIntegrationDriftMs ?? 0)),
+      0,
+    );
+    limitations.push({
+      code: 'TIME_INTEGRATION_DRIFT',
+      count: driftingLaps.length,
+      lapNumbers: driftingLaps.map((entry) => entry.lapNumber),
+      driftMs: Math.round(worst),
     });
   }
   if (availability.unsupported.length > 0) {
     limitations.push({ code: 'UNSUPPORTED_CHANNELS', channels: availability.unsupported });
   }
   if (availability.missing.length > 0) {
     limitations.push({ code: 'MISSING_CHANNELS', channels: availability.missing });
   }
   const poorGnssLaps = lapInsights
     .filter((lap) => lap.reasons.includes('gnssPoor'))
     .map((lap) => lap.lapNumber);
   if (poorGnssLaps.length > 0) {
     limitations.push({ code: 'GNSS_QUALITY', lapNumbers: poorGnssLaps, count: poorGnssLaps.length });
   }
   if (context.geometryValidated === false) {
     limitations.push({ code: 'GEOMETRY_UNVALIDATED' });
   }
   const uncovered = cornerInsights
     .filter((corner) => corner.perLap.every((row) => !row.qualityOk))
     .map((corner) => corner.cornerId);
   if (uncovered.length > 0) {
     limitations.push({ code: 'CORNER_COVERAGE', cornerIds: uncovered, count: uncovered.length });
   }
 
   return {
     analysisVersion: CORNER_ANALYSIS_VERSION,
     circuitId: context.circuitId,
     circuitName: context.circuitName ?? null,
     layoutId: context.layoutId ?? null,
     totalLengthM,
     geometryValidated: context.geometryValidated ?? true,
     observationsOnly: true,
     lapCount: lapInsights.length,
     cleanLapCount: cleanLaps.length,
     laps: lapInsights,
     referenceLapNumber: reference?.lapNumber ?? null,
     referenceDurationMs: reference?.durationMs ?? null,
     medianCleanLapNumber: medianLap?.lapNumber ?? null,
     comparisonLapNumber: comparisonLap?.lapNumber ?? null,
     corners: cornerInsights,
diff --git a/packages/core/src/coaching/types.ts b/packages/core/src/coaching/types.ts
index d7fcc48..623ebb3 100644
--- a/packages/core/src/coaching/types.ts
+++ b/packages/core/src/coaching/types.ts
@@ -147,55 +147,61 @@ export interface ChannelAvailability {
   unsupported: CoachingChannelId[];
   /** Analysis channels neither observed nor declared unsupported. */
   missing: CoachingChannelId[];
 }
 
 /** The subset of `LapRecord` lap classification needs (a `LapRecord` satisfies it). */
 export interface ClassifiableLap {
   lapNumber: number;
   durationMs: number;
   valid: boolean;
   invalidReasons: readonly string[];
   quality: string;
 }
 
 /** Why a lap is not clean. */
 export type LapAnomalyReason = 'incomplete' | 'offTrack' | 'yawSpike' | 'decelSpike' | 'gnssPoor';
 
 /** Checks that could not run because the samples lack the required field. */
 export type LapCheckId = 'offTrack' | 'yawSpike' | 'decelSpike' | 'gnssPoor' | 'coverage';
 
 /**
  * Three-valued lap status. `unverified` is the honest middle: no anomaly was
  * found, but at least one of the checks the safety contract requires
  * ("on-track, no yaw/decel anomaly, valid GNSS quality") could not run, so the
  * lap is NOT established as clean and never feeds the reference or the
  * demonstrated envelope.
  */
 export type LapStatus = 'clean' | 'unverified' | 'anomalous';
 
 export interface LapClassification {
   lapNumber: number;
   status: LapStatus;
   /** True only for `status === 'clean'`. */
   clean: boolean;
   /** Highest-priority reason, or `null` when the lap is clean. */
   reason: LapAnomalyReason | null;
   /** Every reason found, in the fixed priority order. */
   reasons: LapAnomalyReason[];
   /** Human-readable, deterministic evidence string (never empty, never "NaN"). */
   detail: string;
-  /** Checks skipped for lack of input fields. */
+  /** Checks skipped because their evidence did not span the lap. */
   unavailableChecks: LapCheckId[];
+  /**
+   * Fraction of the LAP DISTANCE each required check had continuous evidence
+   * over, 0..1. A check below `minCheckCoverageFraction` is unavailable, and the
+   * number is what the report quotes instead of a bare "no data".
+   */
+  checkCoverage: Record<LapCheckId, number>;
   /** Fraction of the lap distance covered by samples, 0..1. */
   coverageFraction: number;
   /** Worst reported accuracy over the lap, metres. */
   worstAccuracyM: number | null;
   /** Largest gap between consecutive samples, milliseconds. */
   maxSampleGapMs: number | null;
 }
 
 /** One clean lap's corner metrics, the input to the demonstrated envelope. */
 export interface CleanLapMetrics {
   lapNumber: number;
   corners: CornerMetrics[];
 }
```
