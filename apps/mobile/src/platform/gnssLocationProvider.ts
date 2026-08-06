import * as Location from 'expo-location';
import type { LocationProvider, LocationSample } from '@circuit/core';

/**
 * Counters for samples the provider observed but did not emit, plus the total
 * accepted count. Exposed so the UI / diagnostics screen can surface mock-GPS
 * activity to the driver (a spoofed/mocked fix invalidates lap-timing integrity).
 */
export interface GnssDiagnostics {
  samplesEmitted: number;
  samplesRejectedMocked: number;
}

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
  private diagnostics: GnssDiagnostics = { samplesEmitted: 0, samplesRejectedMocked: 0 };

  async start(): Promise<void> {
    if (this.subscription) return;
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

  /** Diagnostics counter — see {@link GnssDiagnostics}. */
  getDiagnostics(): GnssDiagnostics {
    return { ...this.diagnostics };
  }

  private handleLocation(location: Location.LocationObject): void {
    if (location.mocked === true) {
      this.diagnostics.samplesRejectedMocked += 1;
      return;
    }

    const sample: LocationSample = {
      tMono: performance.now(),
      tUtc: location.timestamp,
      lat: location.coords.latitude,
      lon: location.coords.longitude,
      source: 'gnss',
    };
    if (location.coords.accuracy !== null) sample.accuracyM = location.coords.accuracy;
    if (location.coords.speed !== null) sample.speedMps = location.coords.speed;
    if (location.coords.heading !== null) sample.headingDeg = location.coords.heading;
    if (location.coords.altitude !== null) sample.altitudeM = location.coords.altitude;

    this.diagnostics.samplesEmitted += 1;
    for (const listener of this.listeners) listener(sample);
  }
}
