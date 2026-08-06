import { Accelerometer, type AccelerometerMeasurement } from 'expo-sensors';
import type { EventSubscription } from 'expo-modules-core';

export type MotionSample = AccelerometerMeasurement;

export interface MotionCaptureOptions {
  /** Sensor update interval; default 100ms = 10Hz per ticket spec. */
  updateIntervalMs?: number;
  /** Ring-buffer cap so an unbounded session can't grow memory forever. */
  bufferLimit?: number;
}

export interface MotionCapture {
  /**
   * Starts sampling. Never throws — failures (sensor unavailable, permission
   * denied, etc.) resolve to `false` so a driving session can proceed without
   * motion data rather than being aborted by an optional capability.
   */
  start(): Promise<boolean>;
  stop(): void;
  getBuffer(): MotionSample[];
  clearBuffer(): void;
  isRunning(): boolean;
}

const DEFAULT_UPDATE_INTERVAL_MS = 100; // 10 Hz, per MUST DO #4
const DEFAULT_BUFFER_LIMIT = 36_000; // ~1 hour of samples at 10 Hz

/**
 * Optional accelerometer capture behind a start/stop interface, per
 * `.foreman/scratch/platform-research.md` §8 (expo-sensors `setUpdateInterval`,
 * Android 12+ 200Hz system cap — well above the 10Hz used here so no
 * `HIGH_SAMPLING_RATE_SENSORS` permission is needed).
 *
 * Explicitly optional per MUST DO #4: a failure to start (device has no
 * accelerometer, `isAvailableAsync()` false, or the native call throws) must
 * not break the timing session, so every failure path resolves `false`
 * instead of throwing.
 */
export function createMotionCapture(options: MotionCaptureOptions = {}): MotionCapture {
  const updateIntervalMs = options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
  const bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;

  let subscription: EventSubscription | null = null;
  let buffer: MotionSample[] = [];

  return {
    async start(): Promise<boolean> {
      if (subscription) return true;
      try {
        const available = await Accelerometer.isAvailableAsync();
        if (!available) return false;
        Accelerometer.setUpdateInterval(updateIntervalMs);
        subscription = Accelerometer.addListener((measurement) => {
          buffer.push(measurement);
          if (buffer.length > bufferLimit) buffer.shift();
        });
        return true;
      } catch {
        subscription = null;
        return false;
      }
    },
    stop(): void {
      subscription?.remove();
      subscription = null;
    },
    getBuffer(): MotionSample[] {
      return buffer.slice();
    },
    clearBuffer(): void {
      buffer = [];
    },
    isRunning(): boolean {
      return subscription !== null;
    },
  };
}
