import { MadgwickAhrs, type Quaternion, type TelemetrySample } from '@circuit/core';

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
}

export interface GForceProvider {
  /** No-op if already running. Never throws -- an unavailable/failed accelerometer just means no latG/longG samples this session (optional capability, mirrors `motionCapture.ts`). */
  start(): void;
  /** Tears down the active subscription (if any). Idempotent; safe to call even if `start()` was never called. */
  stop(): Promise<void>;
  onSample(cb: (s: TelemetrySample) => void): () => void;
}

async function defaultAccelerometerSource(): Promise<AccelerometerSource> {
  const { Accelerometer } = await import('expo-sensors');
  return Accelerometer as unknown as AccelerometerSource;
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

export function createGForceProvider(deps: GForceProviderDeps): GForceProvider {
  const { monotonicNow } = deps;
  const getAccelerometerSource = deps.accelerometerSource ?? defaultAccelerometerSource;
  const getGyroscopeSource = deps.gyroscopeSource ?? defaultGyroscopeSource;
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
  /** `monotonicNow()` at the previous fused update, for `dt`. Never `Date.now()`. */
  let lastFusionMs: number | null = null;
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
  function handleFusedReading(raw: AccelerometerReading): void {
    const filter = ahrs;
    if (filter === null || !isFiniteReading(raw)) return;
    const now = monotonicNow();

    // --- M1/M3: decide whether this sample advances the filter, seeds it, or
    // does neither. ---------------------------------------------------------
    const elapsedMs = lastFusionMs === null ? null : now - lastFusionMs;
    // M3: a gap this long is a broken stream, not jitter -- reseed rather than
    // integrate across it (and drop the held gyro, which is far past its own
    // freshness limit by then anyway).
    const streamBroke = elapsedMs !== null && elapsedMs > MAX_FUSION_GAP_MS;
    if (streamBroke) {
      seeded = false;
      latestGyro = null;
    }
    if (!seeded) {
      // M1: seed from a plausible gravity reading, and emit NOTHING until one
      // arrives -- a fused value without an attitude estimate is a guess.
      const seed = seedOrientationFromGravity(raw);
      if (seed === null) return;
      filter.reset(seed);
      seeded = true;
      lastFusionMs = now;
      // The seeded attitude explains THIS reading exactly, so the linear
      // acceleration it implies is the honest one for this sample -- no
      // integration has happened and none is needed.
      const seededGravity = filter.gravity();
      emit('latG', raw.x - seededGravity.x);
      emit('longG', raw.y - seededGravity.y);
      return;
    }

    // M3: a duplicate or backward timestamp means NO time passed. Substituting
    // a nominal 40 ms (what the first version did) invents integration time --
    // 25 callbacks sharing one timestamp fabricated a whole second of rotation.
    // The accelerometer sample is still real, so it is still reported, using
    // the attitude estimate unchanged.
    if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      const held = filter.gravity();
      emit('latG', raw.x - held.x);
      emit('longG', raw.y - held.y);
      return;
    }
    lastFusionMs = now;

    // M2: the held gyro rate is only integrated while it is FRESH. Past
    // `GYRO_MAX_AGE_MS` the rotation rate is taken as zero and the filter
    // levels on the accelerometer alone.
    const gyroHold = latestGyro;
    const gyro =
      gyroHold !== null && now - gyroHold.atMs <= GYRO_MAX_AGE_MS
        ? gyroHold.reading
        : { x: 0, y: 0, z: 0 };

    try {
      filter.update(gyro, raw, elapsedMs / 1_000);
    } catch {
      // `update()` validates its own inputs with `RangeError`. All of them are
      // pre-checked above, so this is defense in depth only: a sensor sample
      // must never escape into the native event emitter as a throw.
      return;
    }
    const estimated = filter.gravity();
    emit('latG', raw.x - estimated.x);
    emit('longG', raw.y - estimated.y);
  }

  /**
   * Ticket P6a: the `yawRateDps` channel, emitted at the GYROSCOPE's own rate
   * rather than resampled onto the accelerometer's -- it is a directly
   * measured channel and `coaching/cleanLap.ts` integrates it against its own
   * `tMonoMs` stamps, so inventing intermediate values would only blur it.
   *
   * TICKET P6a-FIX1 H1 (HIGH) -- MOUNT-INDEPENDENT YAW AXIS. The first version
   * read the yaw rate off a FIXED device axis (z), reasoning from the
   * pre-existing latG=x / longG=y mapping that the mount must be flat. An
   * independent reviewer argued just as consistently for y, reasoning from the
   * word "portrait" (upright, where the device z axis points out through the
   * screen and y is vertical). Both readings of the evidence are sound and
   * NEITHER is decidable from the source, because the answer is a physical
   * fact about how the phone is clamped in the car that nobody has measured.
   * So no axis is chosen at all.
   *
   * Instead the rate is PROJECTED onto the vertical direction the filter has
   * already estimated. Yaw is rotation about the vertical, whatever the mount
   * happens to make "vertical" in sensor coordinates, and a dot product with
   * a unit vector extracts exactly that component. A flat mount then recovers
   * the old z reading and an upright mount recovers y, from the same line of
   * code, with no assumption in it. The reviewer's own counter-example --
   * `{x: 0, y: -PI/2, z: 0}` with the phone upright, a 90 deg/s RIGHT turn,
   * which the fixed-z version recorded as 0 -- now reads +90 deg/s.
   *
   * WHICH VECTOR, AND THE SIGN. `MadgwickAhrs.gravity()` is named for the
   * quantity it references but it points UP: the filter drives it towards the
   * NORMALISED ACCELEROMETER READING, and an accelerometer at rest measures
   * the specific force holding the device up (+1 g on the axis pointing at the
   * sky), not the downward acceleration of gravity. That is also why the same
   * vector is subtracted, unnegated, to isolate linear acceleration. So this
   * projects onto +`gravity()`, the UP direction -- and then NEGATES.
   *
   * The negation is the compass convention. A gyroscope is right-handed, so a
   * positive rate about the UP axis is counterclockwise seen from above, which
   * is a LEFT turn. `cleanLap.ts` compares the integral of this channel
   * against GNSS course over ground, which grows CLOCKWISE (a RIGHT turn is
   * positive). One of the two has to be flipped to share a sense, and it is
   * this one. Pinned by a test that encodes an actual right turn, in both a
   * flat and an upright mount.
   *
   * P6a-FIX1 M1: nothing is emitted before the filter is seeded -- an
   * unseeded estimate would project onto a GUESSED vertical, which is the very
   * thing this fix exists to avoid.
   */
  function handleGyroReading(reading: GyroscopeReading): void {
    if (!isFiniteReading(reading)) return;
    const now = monotonicNow();
    // Timestamped (M2) even when nothing is emitted: the fused update needs
    // its age, and freshness is judged from when it ARRIVED.
    latestGyro = { reading, atMs: now };
    const filter = ahrs;
    if (filter === null || !seeded) return;
    const up = filter.gravity();
    const aboutUp = reading.x * up.x + reading.y * up.y + reading.z * up.z;
    emit('yawRateDps', -aboutUp * RAD_TO_DEG);
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
    },

    onSample(cb) {
      sampleListeners.add(cb);
      return () => sampleListeners.delete(cb);
    },
  };
}
