import { describe, expect, it } from 'vitest';

import type { LocalPoint, LocationSample } from '../../src/contracts';
import { polylineCumulative, polylineLength } from '../../src/geometry';
import { TrackMatcher } from '../../src/matching';
import { makeTestProfile, validateProfile, type RuntimeProfile } from '../../src/profile';

function fixture(): { runtime: RuntimeProfile; localSample: (point: LocalPoint, t: number, accuracy?: number) => LocationSample } {
  const validated = validateProfile(makeTestProfile());
  if (!validated.ok) throw new Error(validated.errors.join(','));
  return {
    runtime: validated.runtime,
    localSample: (point, tMono, accuracyM = 3) => ({
      ...validated.runtime.projection.toLatLon(point),
      tMono,
      accuracyM,
      source: 'replay',
    }),
  };
}

describe('TrackMatcher', () => {
  it('rejects invalid quality samples and reports bounded, smoothed confidence', () => {
    const { runtime, localSample } = fixture();
    const matcher = new TrackMatcher(runtime, { corridorWidthM: 20 });
    const first = matcher.match(localSample(runtime.centerline[0] as LocalPoint, 0));
    expect(first?.confidence).toBeGreaterThan(0.8);
    expect(matcher.match(localSample(runtime.centerline[1] as LocalPoint, 0))).toBeNull();

    const point = runtime.centerline[2] as LocalPoint;
    const glitch = matcher.match(localSample({ e: point.e * 1.06, n: point.n * 1.06 }, 1_000, 20));
    expect(glitch?.confidence).toBeGreaterThan(0);
    expect(glitch?.confidence).toBeLessThanOrEqual(1);
    expect(glitch?.confidence).toBeLessThan(first?.confidence ?? 1);
  });

  it('enters lost mode after consecutive off-corridor fixes and re-acquires by full search', () => {
    const { runtime, localSample } = fixture();
    const matcher = new TrackMatcher(runtime, {
      corridorWidthM: 20,
      offCorridorLimit: 2,
      windowM: 30,
      confidenceEmaAlpha: 0.05,
    });
    const start = runtime.centerline[0] as LocalPoint;
    matcher.match(localSample(start, 0));
    matcher.match(localSample({ e: start.e + 40, n: start.n }, 1_000));
    matcher.match(localSample({ e: start.e + 45, n: start.n }, 2_000));

    const opposite = runtime.centerline[40] as LocalPoint;
    const reacquired = matcher.match(localSample(opposite, 20_000));
    expect(reacquired).not.toBeNull();
    expect(reacquired?.distanceM).toBeCloseTo(runtime.cumulativeDistancesM[40] ?? 0, 0);
    expect(Math.abs(reacquired?.lateralM ?? 99)).toBeLessThan(1);
  });

  it('detects a nearer pit polyline while retaining centerline lateral distance', () => {
    const { runtime, localSample } = fixture();
    const pitPolyline = runtime.centerline.slice(0, 11).map((point) => ({
      e: point.e * 0.97,
      n: point.n * 0.97,
    }));
    const withPit: RuntimeProfile = {
      ...runtime,
      pitLane: {
        polyline: pitPolyline,
        cumulativeDistancesM: polylineCumulative(pitPolyline),
        entryGate: runtime.startFinishGate,
        exitGate: runtime.sectorGates[0] ?? runtime.startFinishGate,
      },
    };
    const matcher = new TrackMatcher(withPit, { corridorWidthM: 20, pitCorridorWidthM: 20 });
    const pitPoint = pitPolyline[5] as LocalPoint;
    const match = matcher.match(localSample(pitPoint, 0));
    expect(match?.onPitLane).toBe(true);
    expect(Math.abs(match?.lateralM ?? 0)).toBeGreaterThan(1);
  });

  it('flags a large projection regression without corresponding reverse motion evidence', () => {
    const line: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 100, n: 0 },
      { e: 100, n: 100 },
      { e: 0, n: 100 },
    ];
    const projection = {
      origin: { lat: 0, lon: 0 },
      toLocal: ({ lat, lon }: { lat: number; lon: number }) => ({ e: lon, n: lat }),
      toLatLon: ({ e, n }: LocalPoint) => ({ lat: n, lon: e }),
    };
    const gate = {
      gate: { id: 'sf', kind: 'startFinish' as const, a: { lat: -1, lon: 0 }, b: { lat: 1, lon: 0 } },
      a: { e: 0, n: -1 },
      b: { e: 0, n: 1 },
      distanceM: 0,
    };
    const runtime: RuntimeProfile = {
      projection,
      centerline: line,
      cumulativeDistancesM: polylineCumulative(line),
      startFinishGate: gate,
      sectorGates: [],
    };
    expect(polylineLength(line)).toBe(400);
    const matcher = new TrackMatcher(runtime, {
      corridorWidthM: 100,
      confidenceThreshold: 2,
      quality: { invalidSpeedMps: Number.MAX_VALUE, unreliableSpeedMps: Number.MAX_VALUE },
    });
    matcher.match({ tMono: 0, lat: 50, lon: 100, source: 'replay' });
    const regressed = matcher.match({ tMono: 1_000, lat: 0, lon: 100, source: 'replay' });
    expect(regressed?.quality.reasons).toContain('PROGRESS_REGRESSION');
    expect(regressed?.confidence).toBeLessThan(1);
  });
});
