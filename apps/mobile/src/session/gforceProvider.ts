import type { TelemetrySample } from '@circuit/core';

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

export interface AccelerometerReading {
  x: number;
  y: number;
  z: number;
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
  const sampleListeners = new Set<(s: TelemetrySample) => void>();

  let subscription: AccelerometerSubscription | null = null;
  let gravity: AccelerometerReading = { x: 0, y: 0, z: 0 };
  let running = false;
  /** Generation guard (mirrors `telemetryProvider.ts`'s own `SessionGeneration` pattern): a `stop()` that races an in-flight async `start()` (still awaiting `isAvailableAsync()`/the lazy import) must prevent that stale attempt from installing a subscription after the fact. */
  let generation = 0;

  function emit(channel: 'latG' | 'longG', value: number): void {
    const sample: TelemetrySample = { channel, value, tMonoMs: monotonicNow() };
    for (const listener of [...sampleListeners]) listener(sample);
  }

  function handleReading(raw: AccelerometerReading): void {
    const result = computeLinearAcceleration(gravity, raw);
    gravity = result.gravity;
    // Portrait mount assumption (see module doc comment): latG off the
    // device X axis, longG off the device Y axis.
    emit('latG', result.linear.x);
    emit('longG', result.linear.y);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      gravity = { x: 0, y: 0, z: 0 };
      const myGeneration = ++generation;
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
    },

    onSample(cb) {
      sampleListeners.add(cb);
      return () => sampleListeners.delete(cb);
    },
  };
}
