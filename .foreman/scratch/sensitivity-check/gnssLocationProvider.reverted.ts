import * as Location from 'expo-location';
import type { LocationProvider, LocationSample } from '@circuit/core';
import { getPermissionState } from './permissions';

/** Rolling-window size for the histogram/distribution diagnostics (MUST DO #7). */
const DIAGNOSTICS_WINDOW_SIZE = 300;

/** Upper bounds (ms, exclusive) of the fixed inter-sample-interval buckets; the final bucket is open-ended. */
const INTERVAL_BUCKET_UPPER_BOUNDS_MS = [200, 500, 1000, 2000, 5000];

/** One bucket of {@link GnssDiagnostics.sampleIntervalHistogramMs}. */
export interface SampleIntervalBucket {
  /** Inclusive lower bound in ms. */
  minMs: number;
  /** Exclusive upper bound in ms, or `null` for the open-ended last bucket. */
  maxMs: number | null;
  count: number;
}

/** min/p50/p95 summary for {@link GnssDiagnostics.accuracyDistributionM}. */
export interface AccuracyDistributionSummary {
  /** Number of windowed samples the summary is derived from (0 when none reported `accuracyM`). */
  sampleCount: number;
  minM: number | null;
  p50M: number | null;
  p95M: number | null;
}

/**
 * Counters and rolling-window summaries the iOS validation pass (ADR-0003 §5)
 * needs, plus the pre-existing mock-GPS counter. Exposed so the UI /
 * diagnostics screen can surface GNSS health to the driver.
 */
export interface GnssDiagnostics {
  samplesEmitted: number;
  /**
   * Android-only rejection counter (see the class doc's "Mock-location
   * handling" note) — always 0 on iOS, which has no equivalent flag in the
   * current SDK.
   */
  samplesRejectedMocked: number;
  /** Histogram of inter-sample arrival gaps (`tMono` deltas) over the last {@link DIAGNOSTICS_WINDOW_SIZE} emitted samples. */
  sampleIntervalHistogramMs: SampleIntervalBucket[];
  /** min/p50/p95 of `accuracyM` over the last {@link DIAGNOSTICS_WINDOW_SIZE} emitted samples that reported it. */
  accuracyDistributionM: AccuracyDistributionSummary;
  /**
   * iOS accuracy-authorization snapshot taken at {@link GnssLocationProvider.start}
   * time (`PermissionOutcome.iosAccuracy === 'reduced'`, see `permissions.ts`).
   * `false` on Android/web or before `start()` has run.
   */
  reducedAccuracy: boolean;
}

/**
 * Buckets a window of inter-sample-interval readings (ms) into fixed ranges.
 * Pure function — no I/O — per MUST DO #7.
 */
function computeIntervalHistogram(windowMs: number[]): SampleIntervalBucket[] {
  const bounds = [0, ...INTERVAL_BUCKET_UPPER_BOUNDS_MS];
  const buckets: SampleIntervalBucket[] = bounds.map((min, i) => ({
    minMs: min,
    maxMs: i + 1 < bounds.length ? bounds[i + 1] : null,
    count: 0,
  }));
  for (const ms of windowMs) {
    const bucket = buckets.find((b) => ms >= b.minMs && (b.maxMs === null || ms < b.maxMs));
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

/** Computes min/p50/p95 over a window of accuracy readings (meters). Pure function — no I/O — per MUST DO #7. */
function computeAccuracyDistribution(windowM: number[]): AccuracyDistributionSummary {
  if (windowM.length === 0) return { sampleCount: 0, minM: null, p50M: null, p95M: null };
  const sorted = [...windowM].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
  };
  return { sampleCount: sorted.length, minM: sorted[0], p50M: percentile(0.5), p95M: percentile(0.95) };
}

/**
 * `watchPositionAsync`'s options parameter type, per
 * `node_modules/expo-location/build/Location.types.d.ts`, is `LocationOptions`
 * — NOT `LocationTaskOptions` (the background-task type). `LocationOptions`
 * only has `accuracy`, `mayShowUserSettingsDialog` (Android-only),
 * `timeInterval`, and `distanceInterval`.
 *
 * ADR-0003 §1 calls for `activityType: AutomotiveNavigation` and
 * `pausesUpdatesAutomatically: false`, but those fields exist ONLY on
 * `LocationTaskOptions` (confirmed against the native iOS source too:
 * `node_modules/expo-location/ios/LocationOptions.swift` — the foreground
 * `LocationOptions` Record decodes only `accuracy`/`distanceInterval`;
 * `activityType`/`pausesUpdatesAutomatically` are read exclusively by
 * `EXLocationTaskConsumer.m`, the background-location-task consumer used by
 * `Location.startLocationUpdatesAsync`). That API requires the separate
 * `expo-task-manager` package -- deliberately NOT a dependency of this app
 * (removed as unused/unjustified attack surface; see the security review's
 * L3 finding) -- plus `UIBackgroundModes: location`, both of which ADR-0003
 * §1 explicitly forbids (foreground-only by design). So on the foreground `watchPositionAsync` path
 * this app uses, expo-location SDK 57 has no wiring for `activityType` or
 * `pausesUpdatesAutomatically` at all — adding them to this object would
 * either fail to type-check (excess-property check against `LocationOptions`)
 * or, if forced past TS, be silently ignored by the native foreground
 * streamer. This is a genuine SDK/ADR gap, not an omission here — flagged for
 * the ADR owner rather than faked.
 */
const WATCH_OPTIONS: Location.LocationOptions = {
  // BestForNavigation per ticket spec: highest precision + supplementary sensor
  // data. platform-research.md §9 notes this trades battery for accuracy versus
  // Accuracy.High; accepted here because lap-timing correctness dominates MVP.
  accuracy: Location.LocationAccuracy.BestForNavigation,
  // 0/0 requests the maximum rate the platform will deliver. platform-research.md
  // §1 documents this tops out around ~1 Hz in typical foreground conditions
  // (Android timeInterval is a *minimum* gap, not a guarantee of that rate; iOS
  // ignores timeInterval entirely and paces updates itself).
  timeInterval: 0,
  distanceInterval: 0,
};

/**
 * {@link LocationProvider} backed by `expo-location`'s foreground
 * `watchPositionAsync`. Foreground-only by design (see `permissions.ts` doc
 * comment and `.foreman/scratch/platform-research.md` §1/§3): no background
 * location is requested in the MVP.
 *
 * Timestamp caveat (platform-research.md §5): `expo-location`'s
 * `LocationObject.timestamp` is wall-clock ms since Unix epoch, subject to
 * device clock adjustments — it is stored only as `tUtc` metadata. `tMono` is
 * stamped with `performance.now()` **at the moment the sample is received in
 * JS**, not the true GNSS fix time (which expo-location does not expose
 * separately from `timestamp`). This introduces JS-thread scheduling jitter
 * into `tMono` but keeps it monotonic, which is the binding requirement for
 * every duration computed downstream (see `docs/architecture/contracts.md`).
 *
 * Mock-location handling (platform-research.md §3, "Mock Location Detection"):
 * Android exposes `LocationObject.mocked`; when `true` the sample is dropped
 * (never handed to subscribers) and counted in {@link GnssDiagnostics}. iOS
 * has no equivalent flag in the current SDK, so mocked-sample rejection is
 * Android-only; this is a known platform gap, not a bug here.
 */
export class GnssLocationProvider implements LocationProvider {
  private subscription: Location.LocationSubscription | null = null;
  private readonly listeners = new Set<(s: LocationSample) => void>();
  private samplesEmitted = 0;
  private samplesRejectedMocked = 0;
  private reducedAccuracy = false;
  /** Last accepted sample's `tMono`, used to derive the next inter-sample interval. */
  private lastTMono: number | null = null;
  /** Rolling window (newest last, bounded to {@link DIAGNOSTICS_WINDOW_SIZE}) of inter-sample intervals in ms. */
  private readonly intervalWindowMs: number[] = [];
  /** Rolling window (newest last, bounded to {@link DIAGNOSTICS_WINDOW_SIZE}) of `accuracyM` readings. */
  private readonly accuracyWindowM: number[] = [];
  async start(): Promise<void> {
    if (this.subscription) return;
    const permission = await getPermissionState();
    this.reducedAccuracy = permission.iosAccuracy === 'reduced';
    this.subscription = await Location.watchPositionAsync(WATCH_OPTIONS, (location) =>
      this.handleLocation(location),
    );
  }

  async stop(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
  }

  subscribe(cb: (s: LocationSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Diagnostics snapshot — see {@link GnssDiagnostics}. */
  getDiagnostics(): GnssDiagnostics {
    return {
      samplesEmitted: this.samplesEmitted,
      samplesRejectedMocked: this.samplesRejectedMocked,
      sampleIntervalHistogramMs: computeIntervalHistogram(this.intervalWindowMs),
      accuracyDistributionM: computeAccuracyDistribution(this.accuracyWindowM),
      reducedAccuracy: this.reducedAccuracy,
    };
  }

  /** Pushes `value` into a rolling window, evicting the oldest entry past {@link DIAGNOSTICS_WINDOW_SIZE}. */
  private pushWindowed(window: number[], value: number): void {
    window.push(value);
    if (window.length > DIAGNOSTICS_WINDOW_SIZE) window.shift();
  }

  private handleLocation(location: Location.LocationObject): void {
    if (location.mocked === true) {
      this.samplesRejectedMocked += 1;
      return;
    }

    const tMono = performance.now();
    const sample: LocationSample = {
      tMono,
      tUtc: location.timestamp,
      lat: location.coords.latitude,
      lon: location.coords.longitude,
      source: 'gnss',
    };
    if (location.coords.accuracy !== null) sample.accuracyM = location.coords.accuracy;
    if (location.coords.speed !== null) sample.speedMps = location.coords.speed;
    if (location.coords.heading !== null) sample.headingDeg = location.coords.heading;
    if (location.coords.altitude !== null) sample.altitudeM = location.coords.altitude;

    this.samplesEmitted += 1;
    if (this.lastTMono !== null) this.pushWindowed(this.intervalWindowMs, tMono - this.lastTMono);
    this.lastTMono = tMono;
    if (location.coords.accuracy !== null) this.pushWindowed(this.accuracyWindowM, location.coords.accuracy);

    for (const listener of this.listeners) listener(sample);
  }
}
