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
 * Ticket P7D R1: the longest span a SINGLE `MadgwickAhrs.update()` call may
 * cover. One update is one normalised-gradient step, which rotates the
 * attitude by `2 * beta * dt` radians towards the accelerometer regardless of
 * how far away it actually is -- a correction bounded only by the clock, not
 * by the physics. {@link UPDATE_INTERVAL_MS} is the cadence this provider
 * asks the sensors for and therefore the cadence the gain was chosen against:
 * 0.008 rad (0.46 deg) per step. Anything longer is split into steps of at
 * most this, so the correction converges on the measurement instead of
 * overshooting it. At the nominal rate `steps` is 1 and the arithmetic is
 * bit-for-bit what it was.
 */
const FUSION_MAX_UPDATE_MS = UPDATE_INTERVAL_MS;

/**
 * Ticket P7D R1: hard ceiling on the substeps one accelerometer callback may
 * run, so a pathological interval cannot turn a sensor callback into a long
 * loop. 64 covers 2.56 s at the nominal cadence -- and the FIRST interval
 * longer than {@link MAX_FUSION_GAP_MS} is reseeded, not integrated, so an
 * interval big enough to hit this ceiling only ever occurs in the sustained
 * slow-delivery regime that {@link GForceFusionDiagnostics.degraded} already
 * reports. Past the ceiling the substep grows, but a bounded overshoot beaten
 * down 64-fold is still the point of the split.
 */
const FUSION_MAX_SUBSTEPS = 64;

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
   * Ticket P7R E3 (binding): gyroscope CAPTURE, split off from Madgwick
   * FUSION. Read ONCE per `start()` and frozen for that run, exactly like
   * {@link imuFusionEnabled}.
   *
   * WHY THE SPLIT. Before this, one flag decided two unrelated things: whether
   * the gyroscope is subscribed to at all (capture), and whether the gravity
   * separation behind `latG`/`longG` is replaced by a `MadgwickAhrs` estimate
   * (fusion). They carry completely different risk. Capture is ADDITIVE -- it
   * adds the `yawRateDps` channel and changes no existing value -- while
   * fusion REPLACES the estimator behind the two channels that are already
   * field-proven, on a sign convention that has never been checked against a
   * real corner. Tying them together meant the only way to record a yaw trace
   * was to also swap the estimator on the day the recording matters.
   *
   * With capture ON and fusion OFF, `ahrs` stays `null`, `handleReading` runs
   * the pre-P6a low-pass path value-for-value, and `yawRateDps` is projected
   * onto the LOW-PASS gravity direction instead of the fused one -- see
   * {@link handleGyroReading}'s capture-only branch for what that projection
   * is and is not evidence of.
   *
   * Absent is `false` (capture off), so every existing caller that wires only
   * `imuFusionEnabled` behaves exactly as it did.
   */
  imuGyroCaptureEnabled?: () => boolean;
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
 *
 * TICKET P7D R6 -- TWO KINDS OF FIELD, AND THEY BEHAVE DIFFERENTLY AT `stop()`.
 * {@link fusionActive}, {@link seeded} and {@link degraded} are LIVE STATE:
 * they describe the filter as it is right now, so `stop()` -- which tears the
 * filter down -- makes all three false. The three COUNTERS are the tally for
 * the run that just happened: they are zeroed by `start()`, accumulate over
 * that run, and are RETAINED after `stop()` until the next `start()` clears
 * them. That retention is deliberate, and it is the half of this contract
 * that changed: the earlier text promised all zeroes whenever fusion was
 * inactive, which would have meant a session's diagnostics were destroyed at
 * the exact moment a caller has reason to read them -- the session ended, was
 * the IMU data any good? A counter that forgets the session it is diagnosing
 * diagnoses nothing. Nothing leaks between runs, because `start()` resets
 * every one of them.
 */
export interface GForceFusionDiagnostics {
  /** LIVE: is IMU fusion running right now (the frozen flag value)? False after `stop()`. */
  fusionActive: boolean;
  /** LIVE: has the filter got a real attitude estimate right now? False after `stop()`. */
  seeded: boolean;
  /** COUNTER: stream-break reseeds this run -- see `MAX_FUSION_GAP_MS`. Survives `stop()`. */
  reseeds: number;
  /** COUNTER: fused updates this run whose accelerometer interval was longer than the fused path expects. Survives `stop()`. */
  slowIntervals: number;
  /** COUNTER: fused updates this run that had NO timestamped gyroscope evidence to integrate. Survives `stop()`. */
  gyroStarvedUpdates: number;
  /**
   * LIVE (false after `stop()`). True while the fused estimate cannot be
   * trusted as a fusion: the
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
  /**
   * Ticket P6a-FIX2 M7: whether the fused path is actually fusing. Always
   * safe to call, before `start()` and after `stop()` alike. All zeroes and
   * `degraded: false` until the first fused run; after one, the three
   * counters hold that run's tally until the next `start()` (ticket P7D R6 --
   * see {@link GForceFusionDiagnostics}).
   */
  getFusionDiagnostics(): GForceFusionDiagnostics;
}

async function defaultAccelerometerSource(): Promise<AccelerometerSource> {
  const { Accelerometer } = await import('expo-sensors');
  return Accelerometer as unknown as AccelerometerSource;
}

/**
 * Ticket P6a-FIX2 H1: the platform's accelerometer sign convention, loaded on
 * exactly the same terms as the sensors above -- a LAZY import inside
 * `start()`, never a module-level import.
 *
 * BUILD-14 CRASH (2026-09-24): IT MUST NEVER BE `import('react-native')`. A
 * dynamic import of a CommonJS package becomes Metro's `importAll`, which
 * copies EVERY enumerable export -- and React Native's index exports ~100 lazy
 * getters, each `require`-ing a module the app may never have loaded. Metro
 * loads a module the first time through `guardedLoadModule`, and a module
 * that throws while loading goes straight to `ErrorUtils.reportFatalError`,
 * NOT to the `catch` below: on the iOS release build that was a SIGABRT
 * (`RCTExceptionsManager reportFatal`) the moment the gyroscope started,
 * i.e. on "Start Calibration" whenever gyro capture or IMU fusion was on.
 * `Platform` is read from `expo-modules-core` instead: an ES module (Metro
 * returns its exports as-is, no getter walk) that `expo-sensors` has already
 * loaded by the time this runs, so no module is initialised here at all.
 *
 * It has to be lazy for the same reason `expo-sensors` does, and for one more:
 * `composition.ts` imports this module and is itself imported directly by
 * vitest, where any reference to `react-native` makes Vite try to parse React
 * Native's Flow-typed source and fail the file outright. Most tests inject
 * `accelerometerRestVector` instead, so this line is not reached by them;
 * `test/session/imuRestVectorResolution.test.ts` drives it directly, on all
 * three of its outcomes (resolved, rejected, delayed).
 *
 * TICKET P7D R4 -- AN UNRESOLVED CONVENTION IS `null`, NEVER A GUESS. The
 * earlier version answered with the iOS convention when the import failed.
 * That is right for the platform TRACE ships on and INVERTS EVERY ROTATION on
 * the other one: a right turn on Android would read -90 deg/s, and nothing
 * downstream can tell an inverted yaw from a real one. An ABSENT `yawRateDps`
 * has a tested GNSS course-over-ground fallback in `coaching/cleanLap.ts`; an
 * inverted one has nothing at all. So an unresolved convention SUPPRESSES the
 * channel (see {@link handleGyroReading}) rather than picking a side, while
 * latG/longG -- which are convention-independent, see {@link emitLinear} --
 * keep flowing exactly as before. Note `Platform.OS` being anything other
 * than `'android'` is still a RESOLVED answer (iOS); only a rejected import,
 * or one whose `Platform.OS` is not a string, is unresolved.
 */
async function defaultAccelerometerRestVector(): Promise<AccelerometerRestVector | null> {
  try {
    const { Platform } = (await import('expo-modules-core')) as { Platform?: { OS?: string } };
    if (typeof Platform?.OS !== 'string') return null;
    return Platform.OS === 'android'
      ? ANDROID_ACCELEROMETER_REST_VECTOR
      : IOS_ACCELEROMETER_REST_VECTOR;
  } catch {
    return null;
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
   * An injected `accelerometerRestVector` wins and is used as-is (most tests
   * do this, and an app that knows its platform can too). With none injected,
   * `startGyroscope` resolves it from the real platform BEFORE it subscribes,
   * so no `yawRateDps` sample is ever emitted under an unresolved convention.
   *
   * Ticket P7D R4: `null` MEANS UNRESOLVED, and while it holds `yawRateDps`
   * is suppressed. It is the starting value whenever the caller did not state
   * the convention, and it is what a failed platform resolution leaves
   * behind. The previous code started from -- and fell back to -- the iOS
   * sign, which is a guess that reads every Android rotation backwards.
   */
  let yawSign: 1 | -1 | null =
    deps.accelerometerRestVector === undefined
      ? null
      : yawRateProjectionSign(deps.accelerometerRestVector);
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
  /**
   * Ticket P7R E3: `imuGyroCaptureEnabled` as of the last `start()`, frozen
   * for that run the same way. Independent of {@link fusionActive}: capture
   * decides only whether the gyroscope is SUBSCRIBED and whether
   * `yawRateDps` is emitted; it never touches `ahrs` or the gravity
   * separation behind `latG`/`longG`.
   */
  let captureActive = false;
  /**
   * Ticket P7R E3: `monotonicNow()` at the last LOW-PASS (non-fused)
   * accelerometer reading, or `null` when none has arrived this run. Only
   * maintained while capture-only is in effect, so a run with capture off is
   * byte-for-byte the path it always was -- not even an extra clock read.
   *
   * It answers the same question {@link lastFusionMs} answers for the fused
   * path: is the vertical the gyroscope is about to be projected onto still
   * CURRENT EVIDENCE? The low-pass gravity estimate is refreshed only by
   * accelerometer samples; once those stop it freezes, and a mount moved
   * meanwhile projects a real yaw onto a vertical that no longer exists.
   */
  let lastAccelMs: number | null = null;
  /** The filter for THIS run; rebuilt by every fusion `start()`, so a new session never integrates across the gap to the previous one. */
  let ahrs: MadgwickAhrs | null = null;
  /** The gyroscope's own subscription -- separate from the accelerometer's, and installed while `fusionActive` OR `captureActive` (ticket P7R E3). */
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

  /**
   * Ticket P7R E3: returns the stamp it used. The capture-only path needs to
   * know when the low-pass vertical was last refreshed, and taking that from
   * the emit that already happened costs NO additional `monotonicNow()` call
   * -- so the clock-call sequence of the pre-P7R accelerometer path is
   * preserved exactly, stamps included, whatever the new flag is set to.
   */
  function emit(channel: 'latG' | 'longG' | 'yawRateDps', value: number): number {
    const tMonoMs = monotonicNow();
    const sample: TelemetrySample = { channel, value, tMonoMs };
    for (const listener of [...sampleListeners]) listener(sample);
    return tMonoMs;
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
      // Ticket P7D R2: the seed states the attitude AS OF `now`, so every
      // rotation before `now` is already accounted for in it. Clearing the
      // accumulator above is not enough -- the HELD gyro reading keeps its own
      // older timestamp, and the next gyro sample closes its interval from
      // there, re-applying rotation the seed already absorbed. Measured: a
      // 1 rad/s gyro at 0 ms, a seed at 100 ms and the next matching pair at
      // 120 ms integrated 120 ms of rotation where only 20 ms remained, and a
      // phone in pure rotation reported -0.1022215785 g of longG. The reading
      // itself is still the best estimate of the rate now, so it is CLIPPED to
      // the seed instant rather than discarded -- that keeps the real 20 ms.
      if (latestGyro !== null) latestGyro = { reading: latestGyro.reading, atMs: now };
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

    // --- P7D R1: bound the accelerometer correction to one filter step -----
    // `MadgwickAhrs.update()` takes ONE normalised-gradient step per call, and
    // a normalised gradient has a fixed LENGTH: the attitude is rotated by
    // `2 * beta * dt` radians towards the measured gravity whatever the actual
    // disagreement is. That is a rate limit, and it is only sane while `dt` is
    // the cadence the filter was tuned for. Fed a whole 1 s interval it turns
    // the estimate by 0.2 rad -- far past a disagreement of, say, 0.001 rad --
    // and then turns it back on the next sample. Measured on the reviewer's
    // scenario: 1 Hz delivery of {x:0,y:0,z:1} then {x:0.001,y:0,z:1}
    // alternating latG of 0.19702 g and -0.0000377 g on a still phone.
    // Splitting the interval into steps no longer than the cadence this
    // provider itself requests restores the filter's design regime: the
    // correction converges on the measurement instead of overshooting it, and
    // the residual is bounded by ONE substep's rotation rather than the whole
    // interval's. The GYRO term is untouched by the split -- the same average
    // rate applied over `steps` substeps of `dtSeconds / steps` integrates to
    // exactly the same rotation, which is the rotation `gyroRotation` actually
    // evidenced. The substep count is capped because this runs on a sensor
    // callback and the interval is whatever the OS handed us.
    const steps = Math.min(
      Math.max(1, Math.ceil(elapsedMs / FUSION_MAX_UPDATE_MS)),
      FUSION_MAX_SUBSTEPS,
    );
    const stepSeconds = dtSeconds / steps;
    try {
      for (let step = 0; step < steps; step += 1) filter.update(gyro, raw, stepSeconds);
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
    // --- Ticket P7R E3: CAPTURE WITHOUT FUSION --------------------------
    // `ahrs` is null exactly when fusion is off, so this is the capture-only
    // run. The channel still has to be projected onto the VERTICAL (the mount
    // is unmeasured -- P6a-FIX1 H1 -- so no device axis may be assumed), and
    // with no Madgwick estimate the vertical is the LOW-PASS gravity the
    // accelerometer path is already maintaining for `latG`/`longG`. Read, not
    // written: this branch never touches `gravity`.
    //
    // WHAT THIS PROJECTION IS EVIDENCE OF, HONESTLY. The low-pass estimate
    // cannot tell a tilt from a sustained lateral acceleration, so through a
    // long corner the vertical leans and the projected MAGNITUDE is
    // attenuated -- the same effect `isDegraded()` suppresses the fused
    // channel for. The SIGN and the timing of a rotation survive that
    // attenuation, and settling the sign convention against a real corner is
    // precisely what this capture exists to make possible. Consumers treat
    // the channel as one signal among several (`cornerMetrics` thresholds on
    // `Math.abs`; `cleanLap` falls back to GNSS course over ground wherever
    // the gyro does not adequately cover a window), and NOTHING derives
    // `latG`/`longG` from it.
    if (filter === null) {
      if (!captureActive) return;
      // The same freshness rule the fused path applies (M5), against the
      // low-pass vertical's own last refresh.
      if (lastAccelMs === null || now - lastAccelMs > ATTITUDE_MAX_AGE_MS) return;
      // P7D R4: and the sign convention must be KNOWN -- identical reasoning
      // to the fused branch below.
      if (yawSign === null) return;
      // The low-pass estimate starts at the zero vector and converges on
      // gravity over the first few readings, so it is not a direction at all
      // until its magnitude is plausibly gravity. Same generous band
      // `seedOrientationFromGravity` uses to reject an unusable seed.
      const magnitude = Math.sqrt(gravity.x * gravity.x + gravity.y * gravity.y + gravity.z * gravity.z);
      if (!(magnitude >= SEED_MIN_G) || !(magnitude <= SEED_MAX_G)) return;
      const aboutLowPassVertical =
        (reading.x * gravity.x + reading.y * gravity.y + reading.z * gravity.z) / magnitude;
      emit('yawRateDps', yawSign * aboutLowPassVertical * RAD_TO_DEG);
      return;
    }
    if (!seeded) return;
    // M5: the vertical must be current evidence, not a frozen memory.
    if (lastFusionMs === null || now - lastFusionMs > ATTITUDE_MAX_AGE_MS) return;
    // M7: and the fusion must actually be fusing.
    if (isDegraded()) return;
    // P7D R4: and the sign convention must be KNOWN. An unresolved platform
    // read leaves this null; emitting under a guessed convention would report
    // every rotation backwards on the platform the guess is wrong for, which
    // is strictly worse than the absent channel `cleanLap.ts` already falls
    // back from. Note this sits BELOW the interval accumulation above on
    // purpose: the gyroscope keeps feeding the attitude estimate that
    // latG/longG are derived from either way.
    if (yawSign === null) return;
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
    const latStamp = emit('latG', result.linear.x);
    emit('longG', result.linear.y);
    // Ticket P7R E3: the low-pass vertical was just refreshed. Recorded from
    // the stamp the latG emit ALREADY took, so this path makes exactly the
    // same clock calls, in the same order, as it did before the flag existed
    // -- capture on or off, the latG/longG values and stamps are untouched.
    lastAccelMs = latStamp;
  }

  /**
   * Ticket P6a: the gyroscope subscription, started while `imuFusionEnabled`
   * OR `imuGyroCaptureEnabled` is on (ticket P7R E3 split the two).
   * Deliberately a MIRROR of the accelerometer's own
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
        // P7D R4: a failed resolution leaves `yawSign` null, which suppresses
        // `yawRateDps` for this run. The gyroscope is still subscribed --
        // its rotation feeds the attitude estimate that latG/longG come from,
        // and those do not depend on the convention.
        yawSign = resolved === null ? null : yawRateProjectionSign(resolved);
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
      // Ticket P7R E3: read on exactly the same terms, and INDEPENDENTLY --
      // `ahrs` below stays tied to `fusionActive` alone.
      captureActive = deps.imuGyroCaptureEnabled?.() ?? false;
      ahrs = fusionActive ? new MadgwickAhrs() : null;
      lastAccelMs = null;
      // P7D R4: a run never inherits the previous run's resolved convention
      // either -- if this run's resolution fails, `yawRateDps` is suppressed
      // for it, rather than silently reusing a sign nobody confirmed.
      yawSign =
        deps.accelerometerRestVector === undefined
          ? null
          : yawRateProjectionSign(deps.accelerometerRestVector);
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
      // Ticket P7R E3: the gyroscope is subscribed for EITHER reason -- to
      // capture `yawRateDps`, or to feed the fused attitude estimate.
      if (fusionActive || captureActive) void startGyroscope(myGeneration);
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
      // no-op for every run with both fusion and capture off (ticket P7R E3)
      // -- nothing was ever subscribed.
      gyroSubscription?.remove();
      gyroSubscription = null;
      fusionActive = false;
      captureActive = false;
      lastAccelMs = null;
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
     * Ticket P6a-FIX2 M7: the fused path's own health.
     *
     * Ticket P7D R6: `fusionActive`, `seeded` and `degraded` are LIVE state
     * and are all false once `stop()` has torn the filter down; `reseeds`,
     * `slowIntervals` and `gyroStarvedUpdates` are the RUN's tally and are
     * retained past `stop()` so the session that just ended can still be
     * judged. `start()` zeroes all six, so no run ever reads another's
     * numbers. A provider that has never fused reports all zeroes.
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
