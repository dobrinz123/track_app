import {
  MadgwickAhrs,
  type Quaternion,
  type TelemetrySample,
  type Vector3,
} from '@circuit/core';

/**
 * G-force telemetry provider (Telemetry addendum — channel revision,
 * 2026-08-11, binding): "device accelerometer (expo-sensors), NOT OBD;
 * gravity isolated via low-pass (alpha 0.8), linear accel projected off the
 * gravity vector; portrait mount assumed... Unit: g. ~25 Hz, recorded through
 * the SAME TelemetrySample/recorder path."
 *
 * Built ON `platform/motionCapture.ts`'s idioms (expo-sensors' `Accelerometer`
 * `isAvailableAsync()`/`setUpdateInterval()`/`addListener()` shape, the
 * "optional capability -- a failure to start never throws, it just means no
 * data" philosophy) rather than importing that module directly: `motionCapture.ts`
 * buffers raw samples for later polling and imports `expo-sensors` EAGERLY at
 * module top level, neither of which fits here -- this provider needs a live
 * per-sample callback (to run the gravity filter and emit `TelemetrySample`s
 * as they happen), and `expo-sensors` must stay a LAZY import (dynamic,
 * inside `start()`) so importing this module (which `composition.ts` does
 * unconditionally, alongside the OBD `telemetryProvider`) never pulls in the
 * native module under vitest.
 *
 * PORTRAIT MOUNT ASSUMPTION (documented limitation, per the addendum, until
 * the P4c ESP32/IMU device): the device is assumed mounted in portrait
 * orientation, screen facing the driver -- `latG` (lateral, left/right) is
 * read off the accelerometer's own X axis, `longG` (longitudinal,
 * forward/back) off its Y axis. A landscape-mounted device would need its
 * axes swapped; this provider does not attempt to detect or correct for that.
 *
 * UNIT NOTE (deviation from a literal reading of the addendum's own type
 * comment, "unit g... divide by 9.81 m/s^2" -- verified against the exact
 * versioned Expo SDK 57 docs per `apps/mobile/AGENTS.md`'s standing
 * instruction): `expo-sensors`' `Accelerometer` measurements are ALREADY in
 * g-force units (1g = 9.81 m/s^2), not raw m/s^2 -- see
 * https://docs.expo.dev/versions/v57.0.0/sdk/accelerometer/ ("Each of these
 * keys represents the acceleration along that particular axis in g-force").
 * Both the raw reading and the low-pass gravity estimate are therefore
 * already in g, so `linear = raw - gravity` is already in g with no further
 * division needed -- applying `/ 9.81` on top would silently shrink every
 * value roughly tenfold. `computeLinearAcceleration()` below performs no
 * unit conversion for exactly this reason; see its own doc comment and
 * `gforceProvider.test.ts`'s "no re-scaling" test, which pins this decision.
 *
 * TICKET P6a — IMU FUSION, BEHIND `imuFusionEnabled` (DEFAULT OFF): with the
 * setting on, this provider additionally subscribes to `expo-sensors`'
 * `Gyroscope`, emits the new `yawRateDps` telemetry channel, and replaces the
 * low-pass gravity estimate below with `@circuit/core`'s `MadgwickAhrs`
 * gravity vector. With it OFF -- the default, and what every field-confirmed
 * recording so far was made with -- the gyroscope is never subscribed to, no
 * `yawRateDps` row is ever produced, and the accelerometer path runs the exact
 * code it always did (`handleReading` branches around the fusion path rather
 * than replacing it). The setting is read ONCE per `start()` and frozen for
 * that run. See `handleFusedReading` for the gyro/accelerometer pairing, the
 * seeding of the initial attitude, and the freshness/gap policies; and
 * `handleGyroReading` for why `yawRateDps` is projected onto the ESTIMATED
 * vertical rather than read off a chosen device axis (ticket P6a-FIX1 H1 --
 * the mount is a physical fact nobody has measured, so the channel is built
 * not to depend on it). The latG/longG axis mapping is deliberately NOT
 * touched by that: it is the pre-existing, separately-owned question.
 *
 * MUST NOT interact with lap timing in any way (same binding as the OBD
 * telemetry provider): this module never touches `SessionFacade`/
 * `SessionController` -- `composition.ts` only ever consumes its samples in
 * the OUTBOUND direction (G samples -> recorder). A missing/unavailable
 * accelerometer can only ever leave this provider silently emitting nothing;
 * it can never delay or invalidate a lap, and it starts/stops independently
 * of the OBD provider (a dead/absent OBD adapter never stops G recording,
 * and a missing accelerometer never affects OBD recording) -- both simply
 * feed the SAME `TelemetryRecorder` from `composition.ts`.
 */

const UPDATE_INTERVAL_MS = 40; // ~25 Hz per the addendum.
const GRAVITY_LOW_PASS_ALPHA = 0.8;
/** Radians per second -> degrees per second, for the `yawRateDps` channel. */
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Ticket P6a-FIX1 M2: how old the held gyroscope reading may be and still be
 * integrated. Three nominal intervals (3 x 40 ms) -- the original ticket's
 * own reasoning was that a hold of at most one interval is harmless, and this
 * makes that bound REAL while leaving room for ordinary iOS delivery jitter.
 * Past it the rotation rate is treated as ZERO (the filter then levels on the
 * accelerometer alone) rather than assumed to have continued: a sensor that
 * stopped reporting is not a sensor reporting the same thing forever.
 */
const GYRO_MAX_AGE_MS = 3 * UPDATE_INTERVAL_MS;

/**
 * Ticket P6a-FIX1 M3: the accelerometer gap beyond which the filter is
 * RESEEDED from the current reading instead of integrating across the gap.
 * 500 ms is 12.5 nominal intervals: far outside any plausible scheduling
 * jitter at a requested 40 ms, so a gap this long means the stream actually
 * broke (app backgrounded, sensor suspended, session paused). Integrating a
 * held rotation rate across such a gap fabricates attitude -- an independent
 * review measured -0.68966 g on longG from a level, stationary sample after a
 * five-second gap. Reseeding also re-levels the filter, which is exactly what
 * is wanted after a pause.
 */
const MAX_FUSION_GAP_MS = 500;

/**
 * Ticket P6a-FIX2 M5: how old the ATTITUDE estimate may be before
 * `yawRateDps` stops being emitted. The vertical the gyroscope is projected
 * onto is only refreshed by accelerometer samples, so once those stop the
 * estimate freezes -- and a mount that is moved meanwhile makes a real yaw
 * project onto a vertical that no longer exists, reading zero or the wrong
 * sign. The same {@link MAX_FUSION_GAP_MS} threshold: past the point where
 * the fused path would call the stream broken, the vertical is not evidence
 * any more either.
 */
const ATTITUDE_MAX_AGE_MS = MAX_FUSION_GAP_MS;

/**
 * Ticket P6a-FIX2 M7: how many CONSECUTIVE over-threshold accelerometer
 * intervals it takes to call the delivery rate "sustainedly slow" rather than
 * "one broken stream". The first such interval is a break and is reseeded
 * (M3); from the second on, reseeding every sample is itself the bug -- it
 * pins the attitude to the raw accelerometer direction, which cannot tell a
 * tilt from a lateral acceleration, and silently reports a tenth of the real
 * lateral g. Sustained slow delivery therefore integrates normally instead,
 * and raises {@link GForceFusionDiagnostics.degraded}.
 */
const SUSTAINED_SLOW_INTERVALS = 2;

/**
 * Ticket P6a-FIX2 M7: consecutive fused updates with no gyroscope evidence
 * before the fusion is called degraded -- one second at the nominal rate, so
 * an ordinary delivery hiccup does not flip the flag.
 */
const DEGRADED_GYRO_STARVED_UPDATES = 25;

/**
 * Ticket P6a-FIX1 M1: an accelerometer reading may seed the filter's attitude
 * only if its magnitude is plausibly gravity. A reading taken mid-bump or
 * mid-braking carries the vehicle's own acceleration, and seeding from it
 * would tilt the whole estimate. Generous on purpose (0.5 g .. 1.5 g): this
 * rejects a clearly unusable sample, it is not a calibration.
 */
const SEED_MIN_G = 0.5;
const SEED_MAX_G = 1.5;

export interface AccelerometerReading {
  x: number;
  y: number;
  z: number;
}

/**
 * Ticket P6a: one `expo-sensors` `Gyroscope` reading, "rotation rates along
 * the x, y, and z axes in radians per second" -- VERIFIED against the exact
 * versioned Expo SDK 57 docs per `apps/mobile/AGENTS.md`'s standing
 * instruction (https://docs.expo.dev/versions/v57.0.0/sdk/gyroscope/), the
 * same way this module's UNIT NOTE verified the accelerometer's `g`. The unit
 * matters twice over: `MadgwickAhrs.update()` wants rad/s (so the reading is
 * passed through UNCONVERTED), and the `yawRateDps` channel wants deg/s (so
 * only the emitted value is scaled by {@link RAD_TO_DEG}).
 */
export type GyroscopeReading = AccelerometerReading;

/**
 * Ticket P6a-FIX2 H1 (HIGH) -- WHICH WAY AN ACCELEROMETER AT REST POINTS.
 *
 * The two mobile platforms disagree, `expo-sensors` does NOT reconcile them,
 * and the difference silently reverses every measured rotation. Verified at
 * the source in this repo's own `node_modules`:
 *
 *   `'down'` -- iOS. `ios/AccelerometerModule.swift` forwards
 *     `CMAccelerometerData.acceleration` UNCHANGED, and Core Motion reports a
 *     face-up device at rest as `z = -1`. The at-rest vector points at the
 *     EARTH. THIS IS THE PLATFORM TRACE SHIPS ON.
 *   `'up'` -- Android. `AccelerometerModule.kt` divides
 *     `Sensor.TYPE_ACCELEROMETER` by `GRAVITY_EARTH` with no sign change, and
 *     Android reports specific force, so the same device reads `+1`. The
 *     at-rest vector points at the SKY.
 *
 * This is a property of the SENSOR, so it is named, injected and tested --
 * never sniffed inside the projection where a test cannot reach it.
 */
export type AccelerometerRestVector = 'up' | 'down';

/** iOS: Core Motion, forwarded unchanged -- a device at rest reads towards the earth. */
export const IOS_ACCELEROMETER_REST_VECTOR: AccelerometerRestVector = 'down';
/** Android: specific force, rescaled only -- a device at rest reads towards the sky. */
export const ANDROID_ACCELEROMETER_REST_VECTOR: AccelerometerRestVector = 'up';

/**
 * The factor the projection of the gyroscope onto `MadgwickAhrs.gravity()`
 * must be multiplied by to come out in the COMPASS sense (a right turn
 * positive), given which way the accelerometer's at-rest reading points.
 *
 * DERIVED, not pattern-matched. Write `v` for `gravity()` -- the filter's
 * estimate of the accelerometer's own at-rest direction -- and `u` for true
 * UP in sensor coordinates. By the definition above, `u = v` when the rest
 * vector points up and `u = -v` when it points down.
 *
 * A RIGHT turn is clockwise seen from above. By the right-hand rule the
 * angular-velocity vector of a clockwise-from-above rotation points DOWN,
 * i.e. along `-u`. So during a right turn `w . u < 0`, while the compass
 * heading rate the channel must report is POSITIVE. The compass-sense rate is
 * therefore always `-(w . u)`, and substituting for `u`:
 *
 *   rest vector UP   (Android):  u =  v  ->  rate = -(w . v)   ->  factor -1
 *   rest vector DOWN (iOS):      u = -v  ->  rate = +(w . v)   ->  factor +1
 *
 * Worked check against the reviewer's iOS counter-example: an upright iPhone
 * at rest reads `{x: 0, y: -1, z: 0}`, so `v = (0,-1,0)` and (pointing down)
 * `u = (0,1,0)` -- device +y is skyward, which is what "upright" means. A
 * 90 deg/s right turn is `w = (0, -pi/2, 0)`: `w . u = -pi/2 < 0`, correct for
 * a right turn, and `rate = -(w . u) = +90 deg/s`. Via this factor:
 * `+1 * (w . v) = +1 * (pi/2) = +90 deg/s`. The pre-fix code computed
 * `-(w . v) = -90 deg/s` -- exactly the inversion that was measured.
 */
export function yawRateProjectionSign(restVector: AccelerometerRestVector): 1 | -1 {
  return restVector === 'down' ? 1 : -1;
}

export interface AccelerometerSubscription {
  remove(): void;
}

/** The subset of `expo-sensors`' `Accelerometer` API this provider needs -- a real `Accelerometer` module satisfies this structurally, no wrapping required. */
export interface AccelerometerSource {
  isAvailableAsync(): Promise<boolean>;
  setUpdateInterval(intervalMs: number): void;
  addListener(listener: (reading: AccelerometerReading) => void): AccelerometerSubscription;
}

/** The same structural subset for `expo-sensors`' `Gyroscope` (ticket P6a). */
export interface GyroscopeSource {
  isAvailableAsync(): Promise<boolean>;
  setUpdateInterval(intervalMs: number): void;
  addListener(listener: (reading: GyroscopeReading) => void): AccelerometerSubscription;
}

export interface GForceProviderDeps {
  /** SAME injected monotonic clock the OBD `telemetryProvider` stamps `TelemetrySample.tMonoMs` with (never `Date.now()`) -- `composition.ts` wires both from the same clock instance so every telemetry channel shares one time base. */
  monotonicNow: () => number;
  /**
   * Test seam; defaults to a lazy `expo-sensors` `Accelerometer` load (never
   * imported eagerly -- see this module's own doc comment). Overriding this
   * in a test means the real dynamic `import('expo-sensors')` line below is
   * never reached at all.
   */
  accelerometerSource?: () => Promise<AccelerometerSource>;
  /** The same test seam for the gyroscope; defaults to the same lazy `expo-sensors` load. */
  gyroscopeSource?: () => Promise<GyroscopeSource>;
  /**
   * Ticket P6a (binding): the `imuFusionEnabled` setting, read ONCE per
   * `start()` and FROZEN for that run -- a setting flipped mid-session never
   * swaps the gravity estimator underneath a lap already being recorded, the
   * same "frozen for its whole lifetime" discipline `Elm327Config`'s
   * `accelPedalPidSource` follows.
   *
   * Absent or `false` (the default) is the PRE-P6a provider, unchanged in
   * every respect: only the accelerometer is subscribed to, gravity comes from
   * {@link computeLinearAcceleration}'s low-pass, and NO `yawRateDps` sample is
   * ever emitted. `true` switches the gravity estimate to a `MadgwickAhrs`
   * fusion of gyroscope + accelerometer AND starts capturing the gyroscope.
   */
  imuFusionEnabled?: () => boolean;
  /**
   * Ticket P6a-FIX2 H1 (binding): which way this device's accelerometer reads
   * at rest -- see {@link AccelerometerRestVector}. `composition.ts` resolves
   * it once from `Platform.OS`; tests inject it directly, which is the whole
   * point of it being a dependency rather than a platform sniff inside the
   * projection.
   *
   * Defaults to {@link IOS_ACCELEROMETER_REST_VECTOR} -- the platform TRACE
   * ships on -- so an omission is never silently wrong for the shipping
   * build. It affects ONLY the sign of `yawRateDps`; latG/longG are
   * convention-independent (see {@link handleFusedReading}).
   */
  accelerometerRestVector?: AccelerometerRestVector;
}

/**
 * Ticket P6a-FIX2 M7: what the fused path is actually managing to do, as
 * opposed to what the flag says it is doing. "Fusion is on but not fusing"
 * must not look identical to healthy operation from the outside.
 */
export interface GForceFusionDiagnostics {
  /** Is IMU fusion running at all this session (the frozen flag value)? */
  fusionActive: boolean;
  /** Has the filter got a real attitude estimate right now? */
  seeded: boolean;
  /** Stream-break reseeds so far -- see `MAX_FUSION_GAP_MS`. */
  reseeds: number;
  /** Fused updates whose accelerometer interval was longer than the fused path expects. */
  slowIntervals: number;
  /** Fused updates that had NO timestamped gyroscope evidence to integrate. */
  gyroStarvedUpdates: number;
  /**
   * True while the fused estimate cannot be trusted as a fusion: the
   * accelerometer is sustainedly slower than the fused path needs, or the
   * gyroscope has contributed nothing for a while. In this state the attitude
   * is effectively accelerometer-only, which cannot tell a tilt from a
   * sustained lateral acceleration. `yawRateDps` is SUPPRESSED while it holds
   * (see {@link handleGyroReading}); latG/longG keep flowing.
   */
  degraded: boolean;
}

export interface GForceProvider {
  /** No-op if already running. Never throws -- an unavailable/failed accelerometer just means no latG/longG samples this session (optional capability, mirrors `motionCapture.ts`). */
  start(): void;
  /** Tears down the active subscription (if any). Idempotent; safe to call even if `start()` was never called. */
  stop(): Promise<void>;
  onSample(cb: (s: TelemetrySample) => void): () => void;
  /** Ticket P6a-FIX2 M7: whether the fused path is actually fusing. Always safe to call; all zeroes while fusion is off. */
  getFusionDiagnostics(): GForceFusionDiagnostics;
}

async function defaultAccelerometerSource(): Promise<AccelerometerSource> {
  const { Accelerometer } = await import('expo-sensors');
  return Accelerometer as unknown as AccelerometerSource;
}

/**
 * Ticket P6a-FIX2 H1: the platform's accelerometer sign convention, loaded on
 * exactly the same terms as the sensors above -- a LAZY `import('react-native')`
 * inside `start()`, never a module-level import.
 *
 * It has to be lazy for the same reason `expo-sensors` does, and for one more:
 * `composition.ts` imports this module and is itself imported directly by
 * vitest, where any reference to `react-native` makes Vite try to parse React
 * Native's Flow-typed source and fail the file outright. Every test injects
 * `accelerometerRestVector` instead, so this line is never reached under
 * vitest. A failure to load degrades to the platform TRACE ships on.
 */
async function defaultAccelerometerRestVector(): Promise<AccelerometerRestVector> {
  try {
    const { Platform } = (await import('react-native')) as { Platform?: { OS?: string } };
    return Platform?.OS === 'android'
      ? ANDROID_ACCELEROMETER_REST_VECTOR
      : IOS_ACCELEROMETER_REST_VECTOR;
  } catch {
    return IOS_ACCELEROMETER_REST_VECTOR;
  }
}

/** Ticket P6a: the gyroscope's own lazy load, on exactly the same terms as the accelerometer's above. */
async function defaultGyroscopeSource(): Promise<GyroscopeSource> {
  const { Gyroscope } = await import('expo-sensors');
  return Gyroscope as unknown as GyroscopeSource;
}

/** A sensor reading that can safely be fed to `MadgwickAhrs.update()` (which throws `RangeError` on anything else). */
function isFiniteReading(reading: AccelerometerReading): boolean {
  return Number.isFinite(reading.x) && Number.isFinite(reading.y) && Number.isFinite(reading.z);
}

/**
 * Ticket P6a-FIX1 M1: the quaternion whose {@link MadgwickAhrs.gravity} equals
 * the given measured up-direction, i.e. the attitude the phone is actually
 * mounted at -- returned so the filter can START there instead of at identity.
 *
 * WHY THIS IS NEEDED. `MadgwickAhrs` starts at the identity quaternion, whose
 * `gravity()` is `(0, 0, 1)`: "the phone is lying flat, screen up". For any
 * other mount that is simply wrong, and the filter has to walk the error off
 * at the `beta` gain (0.1 rad/s) while every sample in between is emitted as
 * a fictitious linear acceleration. An independent review measured the cost:
 * a perfectly still phone reading `{x: 0, y: -1, z: 0}` produced -0.80245 g on
 * longG a full second in, at 25 Hz. Seeding removes the transient entirely --
 * a still phone reads ~0 from its very first fused sample.
 *
 * THE GEOMETRY. `gravity()` is the third row of the rotation matrix of `q`,
 * i.e. the earth-frame up axis expressed in the SENSOR frame. So the seed is
 * the shortest-arc rotation carrying the measured direction `up` onto the
 * earth's `+z`, and the standard shortest-arc construction for unit vectors
 * `a -> b` is `q = normalise(( 1 + a.b , a x b ))`, here with `b = (0,0,1)`:
 *
 *   w = 1 + up.z,   (x, y, z) = up x (0,0,1) = (up.y, -up.x, 0)
 *
 * ANTIPARALLEL CASE (explicitly handled, per the ticket). When `up` is exactly
 * `(0, 0, -1)` -- the phone mounted upside down relative to the assumed
 * reference -- the cross product vanishes and `w` is 0, so the formula above
 * degenerates to the zero quaternion and the rotation AXIS is undefined: every
 * axis perpendicular to `up` is an equally valid 180 degree turn. The
 * magnitude of the unnormalised quaternion is `sqrt(2 * (1 + up.z))`, so
 * `1 + up.z` is exactly the quantity that collapses; below
 * {@link ANTIPARALLEL_EPSILON} we pick one such axis explicitly (the x axis,
 * `q = (0, 1, 0, 0)`) rather than let `reset()` throw on a zero-magnitude
 * quaternion. That quaternion's `gravity()` is `(0, 0, -1)` -- the answer we
 * want -- and any perpendicular axis would do equally well, because the yaw
 * it leaves undetermined is exactly the yaw a 6-axis filter cannot observe.
 *
 * `null` means "this reading cannot seed anything" (not finite, or not
 * plausibly gravity) and the caller must keep waiting.
 */
const ANTIPARALLEL_EPSILON = 1e-9;

export function seedOrientationFromGravity(
  measured: AccelerometerReading,
): Quaternion | null {
  if (!isFiniteReading(measured)) return null;
  const magnitude = Math.sqrt(
    measured.x * measured.x + measured.y * measured.y + measured.z * measured.z,
  );
  if (!(magnitude >= SEED_MIN_G) || !(magnitude <= SEED_MAX_G)) return null;
  const up = { x: measured.x / magnitude, y: measured.y / magnitude, z: measured.z / magnitude };
  const w = 1 + up.z;
  if (w <= ANTIPARALLEL_EPSILON) {
    // Exactly (or numerically) upside down: axis undefined, pick one.
    return { w: 0, x: 1, y: 0, z: 0 };
  }
  return { w, x: up.y, y: -up.x, z: 0 }; // `reset()` normalises.
}

/**
 * Pure gravity low-pass filter + linear-acceleration isolation (exported so
 * its exact numeric behavior can be pinned by hand-computed test vectors,
 * independent of the accelerometer plumbing around it). Standard
 * complementary-filter formula: `gravity' = alpha*gravity + (1-alpha)*raw`,
 * `linear = raw - gravity'` (using the JUST-UPDATED gravity estimate, not the
 * previous one). See this module's own "UNIT NOTE" above for why no `/ 9.81`
 * conversion happens here -- both `raw` and the returned values are in g.
 */
export function computeLinearAcceleration(
  gravity: AccelerometerReading,
  raw: AccelerometerReading,
  alpha: number = GRAVITY_LOW_PASS_ALPHA,
): { gravity: AccelerometerReading; linear: AccelerometerReading } {
  const nextGravity: AccelerometerReading = {
    x: alpha * gravity.x + (1 - alpha) * raw.x,
    y: alpha * gravity.y + (1 - alpha) * raw.y,
    z: alpha * gravity.z + (1 - alpha) * raw.z,
  };
  const linear: AccelerometerReading = {
    x: raw.x - nextGravity.x,
    y: raw.y - nextGravity.y,
    z: raw.z - nextGravity.z,
  };
  return { gravity: nextGravity, linear };
}

/**
 * Ticket P6a-FIX2 V1 (binding) -- THE ONE ROUTE A G-FORCE SAMPLE TAKES INTO
 * THE APP, extracted so it is EXECUTABLE by a test instead of correct only by
 * inspection.
 *
 * The property this protects is the product's most important one: the G-force
 * provider must not be able to influence lap timing. That used to be
 * guaranteed by the shape of `composition.ts`'s `startTelemetryRecording` --
 * the subscription's callback did one thing, `recorder.record(...)` -- but a
 * test could only assert it about a hand-written COPY of that callback, so a
 * leak introduced in composition would not have failed anything.
 *
 * So the callback is this function, `startTelemetryRecording` calls it, and
 * the tests drive this same function with a recording sink of their own. It
 * lives HERE rather than in `composition.ts` for a mechanical reason worth
 * recording: `composition.ts` reaches `react-native` through `src/platform`,
 * whose Flow-typed source Vite cannot parse, so importing composition from a
 * test requires mocking half the app -- while this module is deliberately
 * `react-native`-free and imports directly. A seam nobody can run is not a
 * seam.
 *
 * The body is deliberately trivial and deliberately total: a sample is tagged
 * with the current lap number and handed to `record`, and NOTHING else
 * happens to it. No facade, no `SessionController`, no location stream -- and
 * since this is the only route `startTelemetryRecording` gives a G sample,
 * adding any of those would now change code a test runs.
 *
 * Returns the unsubscribe handle, exactly as `provider.onSample` does.
 */
export function connectGForceRecording(deps: {
  provider: Pick<GForceProvider, 'onSample'>;
  /** Where a sample goes. In production: the session's `TelemetryRecorder`. */
  record: (sample: TelemetrySample, lapNumber: number | null) => void;
  /** The lap a sample belongs to, read at DELIVERY time (`null` = no lap in progress). */
  currentLapNumber: () => number | null;
}): () => void {
  return deps.provider.onSample((sample) => {
    deps.record(sample, deps.currentLapNumber());
  });
}

export function createGForceProvider(deps: GForceProviderDeps): GForceProvider {
  const { monotonicNow } = deps;
  const getAccelerometerSource = deps.accelerometerSource ?? defaultAccelerometerSource;
  const getGyroscopeSource = deps.gyroscopeSource ?? defaultGyroscopeSource;
  /**
   * Ticket P6a-FIX2 H1: the yaw projection sign, derived from the
   * accelerometer's at-rest direction -- never a hardcoded negation, and
   * never sniffed from `Platform.OS` inside the projection where no test
   * could reach it.
   *
   * An injected `accelerometerRestVector` wins and is used as-is (every test
   * does this, and an app that knows its platform can too). With none
   * injected, `startGyroscope` resolves it from the real platform BEFORE it
   * subscribes, so no `yawRateDps` sample is ever emitted under an
   * unresolved convention. The initial value is only the safe default for the
   * platform this app ships on.
   */
  let yawSign = yawRateProjectionSign(deps.accelerometerRestVector ?? IOS_ACCELEROMETER_REST_VECTOR);
  const sampleListeners = new Set<(s: TelemetrySample) => void>();

  let subscription: AccelerometerSubscription | null = null;
  let gravity: AccelerometerReading = { x: 0, y: 0, z: 0 };
  let running = false;
  /** Generation guard (mirrors `telemetryProvider.ts`'s own `SessionGeneration` pattern): a `stop()` that races an in-flight async `start()` (still awaiting `isAvailableAsync()`/the lazy import) must prevent that stale attempt from installing a subscription after the fact. */
  let generation = 0;

  // --- Ticket P6a: IMU fusion state. All of it is inert while `fusionActive`
  // is false, which is what `imuFusionEnabled` defaults to. ----------------
  /** `imuFusionEnabled` as of the last `start()`, frozen for that run. */
  let fusionActive = false;
  /** The filter for THIS run; rebuilt by every fusion `start()`, so a new session never integrates across the gap to the previous one. */
  let ahrs: MadgwickAhrs | null = null;
  /** The gyroscope's own subscription -- separate from the accelerometer's, and only ever installed while `fusionActive`. */
  let gyroSubscription: AccelerometerSubscription | null = null;
  /**
   * Most recent gyroscope reading (rad/s) WITH the monotonic time it arrived,
   * or `null` before the first one. Ticket P6a-FIX1 M2: the timestamp is the
   * fix -- an untimed "latest" reading is reused forever, so a gyroscope that
   * simply stops delivering gets its last rate integrated indefinitely (an
   * independent review measured a level, stationary phone reading -0.98971 g
   * on longG two seconds after one 1 rad/s sample).
   */
  let latestGyro: { reading: GyroscopeReading; atMs: number } | null = null;
  /**
   * Ticket P6a-FIX2 M6: the rotation the timestamped gyroscope intervals
   * ACTUALLY support since the last fused update, in radians, plus the span
   * they cover. A gyroscope reading is evidence about the interval it ends,
   * not about however long the accelerometer happened to be silent -- the
   * pre-fix code applied the newest reading across the whole accelerometer
   * gap, which manufactured -0.4705882353 g out of a 500 ms silence followed
   * by one 1 rad/s sample.
   */
  let gyroRotation = { x: 0, y: 0, z: 0 };
  let gyroCoveredMs = 0;
  /** `monotonicNow()` at the previous fused update, for `dt`. Never `Date.now()`. */
  let lastFusionMs: number | null = null;
  // --- P6a-FIX2 M7: is the fused path actually fusing? -------------------
  let reseeds = 0;
  let slowIntervals = 0;
  let consecutiveSlowIntervals = 0;
  let gyroStarvedUpdates = 0;
  let consecutiveGyroStarvedUpdates = 0;
  /**
   * Ticket P6a-FIX1 M1: has the filter been given a real starting attitude
   * yet? Until it has, NOTHING fused is emitted -- no latG/longG and no
   * yawRateDps -- because both are derived from an attitude estimate that does
   * not exist. Seeding is done by {@link seedOrientation} from the first
   * plausible accelerometer reading, and redone after a stream break (M3).
   */
  let seeded = false;

  function emit(channel: 'latG' | 'longG' | 'yawRateDps', value: number): void {
    const sample: TelemetrySample = { channel, value, tMonoMs: monotonicNow() };
    for (const listener of [...sampleListeners]) listener(sample);
  }

  /**
   * Ticket P6a: the `imuFusionEnabled` gravity estimate, replacing
   * {@link computeLinearAcceleration}'s low-pass for this run only.
   *
   * PAIRING (the decision this ticket asks to be documented). The gyroscope
   * and the accelerometer arrive on two independent `expo-sensors` listeners,
   * both asked for the same ~25 Hz interval but never synchronised by the
   * platform. They are paired ACCELEROMETER-DRIVEN, hold-last-gyro: every
   * accelerometer reading runs exactly one `MadgwickAhrs.update()` using the
   * most recent gyroscope reading, and a gyroscope reading on its own never
   * advances the filter. Three reasons:
   *  - the latG/longG channels keep the EXACT cadence, count and `tMonoMs`
   *    stamping they have today (one accelerometer reading -> one latG + one
   *    longG), so the only thing the flag changes is the gravity vector;
   *  - `update()` needs both vectors at once, and the accelerometer is the one
   *    whose sample the output is computed FROM -- resampling it onto the gyro
   *    clock would interpolate the very signal being measured;
   *  - at a nominal 25 Hz the hold is at most one 40 ms interval of gyro age,
   *    which is well inside the attitude error the 0.1 `beta` gain already
   *    absorbs.
   * Until the first gyroscope reading arrives (or on a device with no
   * gyroscope at all) the zero rotation rate is used, which degrades the
   * filter to an accelerometer-only levelling -- never a throw, never a gap in
   * latG/longG.
   *
   * `dt` comes from the SAME injected monotonic clock every sample is stamped
   * with (never `Date.now()`). The first reading of a run, and any pair whose
   * clock delta is not strictly positive, fall back to the nominal
   * {@link UPDATE_INTERVAL_MS} rather than letting `update()` reject a
   * non-positive `dtSeconds`.
   *
   * UNITS AND AXES ARE PRESERVED EXACTLY: `MadgwickAhrs.gravity()` is a UNIT
   * vector in the sensor frame, the accelerometer reading is already in `g`
   * (this module's UNIT NOTE), and one `g` of gravity is one unit -- so
   * `raw - gravity()` is in `g` with no conversion, exactly like the low-pass
   * path. The portrait mount assumption is unchanged too: latG is still the
   * device X axis and longG still the device Y axis.
   */
  /** P6a-FIX2 M7: is the fused estimate currently something other than a real fusion? */
  function isDegraded(): boolean {
    return (
      consecutiveSlowIntervals >= SUSTAINED_SLOW_INTERVALS ||
      consecutiveGyroStarvedUpdates >= DEGRADED_GYRO_STARVED_UPDATES
    );
  }

  function handleFusedReading(raw: AccelerometerReading): void {
    const filter = ahrs;
    if (filter === null || !isFiniteReading(raw)) return;
    const now = monotonicNow();

    const elapsedMs = lastFusionMs === null ? null : now - lastFusionMs;

    // --- M3 / M7: is this a broken stream, or just a slow one? ------------
    // A single over-threshold interval is a break (backgrounded app,
    // suspended sensor) and is reseeded rather than integrated across. A RUN
    // of them is not a break at all -- it is the delivery rate -- and
    // reseeding every sample would pin the attitude to the raw accelerometer
    // direction, which cannot tell a tilt from a lateral acceleration and
    // reports a tenth of the real lateral g. From the second consecutive slow
    // interval on, integrate normally and raise `degraded` instead. This is
    // safe precisely because M6 below bounds the rotation to what the
    // gyroscope actually evidences, so a long interval no longer fabricates
    // attitude the way it once did.
    const slow = elapsedMs !== null && elapsedMs > MAX_FUSION_GAP_MS;
    if (slow) {
      slowIntervals += 1;
      consecutiveSlowIntervals += 1;
    } else if (elapsedMs !== null) {
      consecutiveSlowIntervals = 0;
    }
    const streamBroke = slow && consecutiveSlowIntervals < SUSTAINED_SLOW_INTERVALS;
    if (streamBroke) {
      seeded = false;
      latestGyro = null;
      gyroRotation = { x: 0, y: 0, z: 0 };
      gyroCoveredMs = 0;
    }

    if (!seeded) {
      // M1: seed from a plausible gravity reading, and emit NOTHING until one
      // arrives -- a fused value without an attitude estimate is a guess.
      const seed = seedOrientationFromGravity(raw);
      if (seed === null) return;
      filter.reset(seed);
      seeded = true;
      if (elapsedMs !== null) reseeds += 1;
      lastFusionMs = now;
      gyroRotation = { x: 0, y: 0, z: 0 };
      gyroCoveredMs = 0;
      // The seeded attitude explains THIS reading exactly, so the linear
      // acceleration it implies is the honest one for this sample -- no
      // integration has happened and none is needed.
      emitLinear(raw, filter.gravity());
      return;
    }

    // M3: a duplicate or backward timestamp means NO time passed. Substituting
    // a nominal 40 ms (what the first version did) invents integration time --
    // 25 callbacks sharing one timestamp fabricated a whole second of rotation.
    // The accelerometer sample is still real, so it is still reported, using
    // the attitude estimate unchanged.
    if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      emitLinear(raw, filter.gravity());
      return;
    }
    lastFusionMs = now;

    // --- M6: integrate exactly the rotation the gyroscope evidences -------
    // `gyroRotation` is the sum of (rate x its own interval) over the
    // timestamped gyroscope intervals that closed since the last fused
    // update. Dividing it by this accelerometer interval gives the AVERAGE
    // rate which, applied over that interval, reproduces precisely that
    // rotation and no more. The accelerometer correction inside `update()`
    // is independent of the gyroscope term, so it still runs over the full
    // interval, which is what it should do.
    const dtSeconds = elapsedMs / 1_000;
    const hasGyroEvidence = gyroCoveredMs > 0;
    if (hasGyroEvidence) {
      consecutiveGyroStarvedUpdates = 0;
    } else {
      gyroStarvedUpdates += 1;
      consecutiveGyroStarvedUpdates += 1;
    }
    const gyro = hasGyroEvidence
      ? {
          x: gyroRotation.x / dtSeconds,
          y: gyroRotation.y / dtSeconds,
          z: gyroRotation.z / dtSeconds,
        }
      : { x: 0, y: 0, z: 0 };
    gyroRotation = { x: 0, y: 0, z: 0 };
    gyroCoveredMs = 0;

    try {
      filter.update(gyro, raw, dtSeconds);
    } catch {
      // `update()` validates its own inputs with `RangeError`. All of them are
      // pre-checked above, so this is defense in depth only: a sensor sample
      // must never escape into the native event emitter as a throw.
      return;
    }
    emitLinear(raw, filter.gravity());
  }

  /**
   * latG/longG from the raw sample and the estimated vertical.
   *
   * CONVENTION-INDEPENDENT, deliberately (ticket P6a-FIX2 H1): `gravity()`
   * converges on whatever the accelerometer reports at rest, so subtracting it
   * from the raw sample removes exactly that component and leaves the
   * vehicle's own linear acceleration -- whether the platform's rest vector
   * points up (Android) or down (iOS). Only the YAW projection needs to know
   * which, because a dot product carries the sign through. This path is
   * therefore NOT touched by the rest-vector setting, and the portrait axis
   * mapping (latG = device X, longG = device Y) is unchanged from the
   * pre-P6a provider.
   */
  function emitLinear(raw: AccelerometerReading, estimatedVertical: Vector3): void {
    emit('latG', raw.x - estimatedVertical.x);
    emit('longG', raw.y - estimatedVertical.y);
  }

  /**
   * Ticket P6a: the `yawRateDps` channel, emitted at the GYROSCOPE's own rate
   * rather than resampled onto the accelerometer's -- it is a directly
   * measured channel and `coaching/cleanLap.ts` integrates it against its own
   * `tMonoMs` stamps, so inventing intermediate values would only blur it.
   *
   * TICKET P6a-FIX1 H1 -- MOUNT-INDEPENDENT YAW AXIS. The first version read
   * the yaw rate off a FIXED device axis, which required knowing how the phone
   * is physically clamped in the car -- a fact nobody has measured, and one
   * two careful readers can disagree about in good faith. So no axis is
   * chosen. Yaw is rotation about the VERTICAL, whatever the mount makes
   * vertical in sensor coordinates, and `MadgwickAhrs.gravity()` estimates
   * exactly that direction; a dot product extracts the component about it. A
   * flat mount then recovers device z and an upright mount device y, from one
   * line, with no assumption in it.
   *
   * TICKET P6a-FIX2 H1 -- AND THE SIGN IS NOT UNIVERSAL. `gravity()` points
   * wherever the SENSOR says it does at rest, and the two platforms are
   * opposite: Core Motion reports a face-up device as z = -1 (the vector
   * points DOWN) while Android reports specific force, +1 (it points UP).
   * Negating unconditionally, as the first fix did, is right on Android and
   * inverts every rotation on iOS -- the platform this app ships on. The
   * convention is therefore an injected value and the sign is DERIVED from it;
   * see {@link yawRateProjectionSign} for the derivation and the worked iOS
   * case.
   *
   * P6a-FIX1 M1 / P6a-FIX2 M5: nothing is emitted before the filter is seeded,
   * and nothing once the attitude estimate has gone STALE. The vertical is
   * refreshed only by accelerometer samples; when those stop the estimate
   * freezes, and a mount rotated meanwhile would project a real yaw onto a
   * vertical that no longer exists -- reading zero, or the wrong sign.
   * Emitting nothing is the honest answer, because `cleanLap.ts` has a tested
   * GNSS course-over-ground fallback for an absent yaw channel.
   *
   * P6a-FIX2 M7: also suppressed while the fusion is DEGRADED. There the
   * attitude is effectively accelerometer-only, so a sustained lateral
   * acceleration tilts the estimated vertical and the projection loses a
   * measurable fraction of the true yaw (an independent review measured a
   * nominal 90 deg/s reading 80.5). A silently 11%-wrong yaw is worse than no
   * yaw, precisely because that fallback exists.
   */
  function handleGyroReading(reading: GyroscopeReading): void {
    if (!isFiniteReading(reading)) return;
    const now = monotonicNow();

    // --- P6a-FIX2 M6: close the interval this reading ENDS ----------------
    // The PREVIOUS reading is the rate that held over the span just elapsed
    // (zero-order hold backwards -- the causally honest choice, since the new
    // reading is evidence about now, not about the span behind it). A span
    // longer than the freshness limit means the gyroscope itself had a gap,
    // and nothing is accumulated across it. This is what stops a single fresh
    // reading being smeared over an arbitrarily long accelerometer silence.
    const previous = latestGyro;
    if (previous !== null) {
      const spanMs = now - previous.atMs;
      if (spanMs > 0 && spanMs <= GYRO_MAX_AGE_MS) {
        const spanSeconds = spanMs / 1_000;
        gyroRotation = {
          x: gyroRotation.x + previous.reading.x * spanSeconds,
          y: gyroRotation.y + previous.reading.y * spanSeconds,
          z: gyroRotation.z + previous.reading.z * spanSeconds,
        };
        gyroCoveredMs += spanMs;
      }
    }
    latestGyro = { reading, atMs: now };

    const filter = ahrs;
    if (filter === null || !seeded) return;
    // M5: the vertical must be current evidence, not a frozen memory.
    if (lastFusionMs === null || now - lastFusionMs > ATTITUDE_MAX_AGE_MS) return;
    // M7: and the fusion must actually be fusing.
    if (isDegraded()) return;
    const vertical = filter.gravity();
    const aboutVertical =
      reading.x * vertical.x + reading.y * vertical.y + reading.z * vertical.z;
    emit('yawRateDps', yawSign * aboutVertical * RAD_TO_DEG);
  }

  function handleReading(raw: AccelerometerReading): void {
    // Ticket P6a: branch AROUND the field-confirmed path, never through a
    // rewrite of it -- with `imuFusionEnabled` off (the default) everything
    // below this line is byte-for-byte the pre-P6a provider.
    if (fusionActive) {
      handleFusedReading(raw);
      return;
    }
    const result = computeLinearAcceleration(gravity, raw);
    gravity = result.gravity;
    // Portrait mount assumption (see module doc comment): latG off the
    // device X axis, longG off the device Y axis.
    emit('latG', result.linear.x);
    emit('longG', result.linear.y);
  }

  /**
   * Ticket P6a: the gyroscope subscription, started only while
   * `imuFusionEnabled` is on. Deliberately a MIRROR of the accelerometer's own
   * start below -- same lazy source, same `isAvailableAsync()` check, same
   * generation guard, same swallow-everything `catch`: an unavailable or
   * failing gyroscope means no `yawRateDps` samples and an accelerometer-only
   * attitude estimate, never a throw and never a broken session (the optional
   * capability contract `motionCapture.ts` sets).
   */
  async function startGyroscope(myGeneration: number): Promise<void> {
    try {
      // P6a-FIX2 H1: settle the sign convention BEFORE any sample can be
      // emitted under the wrong one. Only when the caller did not state it.
      if (deps.accelerometerRestVector === undefined) {
        const resolved = await defaultAccelerometerRestVector();
        if (!running || myGeneration !== generation) return;
        yawSign = yawRateProjectionSign(resolved);
      }
      const gyroscope = await getGyroscopeSource();
      const available = await gyroscope.isAvailableAsync();
      if (!available || !running || myGeneration !== generation) return;
      gyroscope.setUpdateInterval(UPDATE_INTERVAL_MS);
      const sub = gyroscope.addListener((reading) => {
        if (!running || myGeneration !== generation) return;
        handleGyroReading(reading);
      });
      if (!running || myGeneration !== generation) {
        sub.remove();
        return;
      }
      gyroSubscription = sub;
    } catch {
      // Optional capability, exactly as for the accelerometer.
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      gravity = { x: 0, y: 0, z: 0 };
      // Ticket P6a: read ONCE here and frozen for this run (see
      // `GForceProviderDeps.imuFusionEnabled`). Everything in the fusion block
      // is reset with it, so a run never integrates across the gap to the
      // previous one.
      fusionActive = deps.imuFusionEnabled?.() ?? false;
      ahrs = fusionActive ? new MadgwickAhrs() : null;
      latestGyro = null;
      lastFusionMs = null;
      // P6a-FIX1 M1: every run re-seeds from its own first plausible reading.
      seeded = false;
      // P6a-FIX2 M6/M7: a run never inherits the previous run's gyro evidence
      // or its health counters.
      gyroRotation = { x: 0, y: 0, z: 0 };
      gyroCoveredMs = 0;
      reseeds = 0;
      slowIntervals = 0;
      consecutiveSlowIntervals = 0;
      gyroStarvedUpdates = 0;
      consecutiveGyroStarvedUpdates = 0;
      const myGeneration = ++generation;
      if (fusionActive) void startGyroscope(myGeneration);
      void (async () => {
        try {
          const accelerometer = await getAccelerometerSource();
          const available = await accelerometer.isAvailableAsync();
          if (!available || !running || myGeneration !== generation) return;
          accelerometer.setUpdateInterval(UPDATE_INTERVAL_MS);
          const sub = accelerometer.addListener((reading) => {
            if (!running || myGeneration !== generation) return;
            handleReading(reading);
          });
          if (!running || myGeneration !== generation) {
            // A stop() raced in while the above awaits were pending -- never
            // leave a subscription running past it.
            sub.remove();
            return;
          }
          subscription = sub;
        } catch {
          // Optional capability (mirrors `motionCapture.ts`): a failure to
          // load/start the accelerometer must never throw or affect anything
          // else -- it just means no latG/longG samples this session.
        }
      })();
    },

    async stop(): Promise<void> {
      running = false;
      generation += 1;
      subscription?.remove();
      subscription = null;
      // Ticket P6a: the gyroscope is torn down on exactly the same terms. A
      // no-op for every non-fusion run (nothing was ever subscribed).
      gyroSubscription?.remove();
      gyroSubscription = null;
      fusionActive = false;
      ahrs = null;
      latestGyro = null;
      lastFusionMs = null;
      seeded = false;
      gyroRotation = { x: 0, y: 0, z: 0 };
      gyroCoveredMs = 0;
    },

    onSample(cb) {
      sampleListeners.add(cb);
      return () => sampleListeners.delete(cb);
    },

    /**
     * Ticket P6a-FIX2 M7: the fused path's own health. All zeroes and
     * `degraded: false` while fusion is off, so a caller never has to ask
     * whether the numbers mean anything.
     */
    getFusionDiagnostics(): GForceFusionDiagnostics {
      return {
        fusionActive,
        seeded,
        reseeds,
        slowIntervals,
        gyroStarvedUpdates,
        degraded: fusionActive && isDegraded(),
      };
    },
  };
}
