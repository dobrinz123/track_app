import { describe, expect, it } from 'vitest';

import type { LocalPoint, LocationSample } from '../../src/contracts';
import { polylineLength, projectOntoPolyline } from '../../src/geometry';
import { TrackMatcher } from '../../src/matching';
import { makeTestProfile, validateProfile } from '../../src/profile';

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

describe('TrackMatcher hinted projection audits', () => {
  it('keeps the validated-profile hint fast path projection-equivalent to the geometry helper', () => {
    const validated = validateProfile(makeTestProfile());
    if (!validated.ok) throw new Error(validated.errors.join(', '));
    const runtime = validated.runtime;
    const totalLengthM = polylineLength(runtime.centerline);
    const startOffsetM = runtime.startFinishGate.distanceM;
    const matcher = new TrackMatcher(runtime, {
      auditIntervalSamples: 10_000,
      quality: {
        unreliableSpeedMps: Number.MAX_VALUE,
        invalidSpeedMps: Number.MAX_VALUE,
      },
    });

    let previous = matcher.match(sample(runtime.centerline[0]!, 0, runtime.projection));
    expect(previous).not.toBeNull();
    for (let index = 1; index <= 500; index += 1) {
      const vertex = runtime.centerline[index % runtime.centerline.length]!;
      const point = {
        e: vertex.e + Math.sin(index * 0.7) * 3,
        n: vertex.n + Math.cos(index * 0.7) * 3,
      };
      const rawHintDistanceM = modulo((previous?.distanceM ?? 0) + startOffsetM, totalLengthM);
      const currentSample = sample(point, index * 1_000, runtime.projection);
      const projectedSample = runtime.projection.toLocal(currentSample);
      const expected = projectOntoPolyline(
        projectedSample,
        runtime.centerline,
        runtime.cumulativeDistancesM,
        true,
        { distanceM: rawHintDistanceM, windowM: 150 },
      );
      const actual = matcher.match(currentSample);

      expect(actual?.distanceM).toBe(modulo(expected.distanceM - startOffsetM, totalLengthM));
      expect(actual?.lateralM).toBe(expected.lateralM);
      previous = actual;
    }
  });

  it('requires a positive integer audit interval', () => {
    const validated = validateProfile(makeTestProfile());
    if (!validated.ok) throw new Error(validated.errors.join(', '));
    expect(() => new TrackMatcher(validated.runtime, { auditIntervalSamples: 0 })).toThrow(
      'auditIntervalSamples must be a positive integer',
    );
    expect(() => new TrackMatcher(validated.runtime, { auditIntervalSamples: 2.5 })).toThrow(
      'auditIntervalSamples must be a positive integer',
    );
  });
});

function sample(
  point: LocalPoint,
  tMono: number,
  projection: { toLatLon(point: LocalPoint): { lat: number; lon: number } },
): LocationSample {
  return {
    ...projection.toLatLon(point),
    tMono,
    accuracyM: 3,
    source: 'replay',
  };
}
