import { describe, expect, it } from 'vitest';

import type { Corner, LocationSample } from '../../src/contracts';
import { analyzeCorners } from '../../src/corners';
import { assessGeometryDeviation } from '../../src/geometryValidation';
import type { ValidationTrace } from '../../src/geometryValidation';
import { polylineLength } from '../../src/geometry';
import { makeTestProfile, validateProfile } from '../../src/profile';
import type { RuntimeProfile } from '../../src/profile';

function testRuntime(): RuntimeProfile {
  const result = validateProfile(makeTestProfile());
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.runtime;
}

function pointAt(runtime: RuntimeProfile, distanceM: number, lateralM: number) {
  const line = runtime.centerline;
  const cumulative = runtime.cumulativeDistancesM;
  const total = polylineLength(line);
  const target = ((distanceM % total) + total) % total;
  for (let index = 0; index < line.length; index += 1) {
    const a = line[index];
    const b = line[(index + 1) % line.length];
    if (a === undefined || b === undefined) break;
    const start = cumulative[index] ?? 0;
    const length = Math.hypot(b.e - a.e, b.n - a.n);
    if (target <= start + length || index === line.length - 1) {
      const t = length === 0 ? 0 : Math.min(1, Math.max(0, (target - start) / length));
      const leftE = -(b.n - a.n) / length;
      const leftN = (b.e - a.e) / length;
      return runtime.projection.toLatLon({
        e: a.e + t * (b.e - a.e) + leftE * lateralM,
        n: a.n + t * (b.n - a.n) + leftN * lateralM,
      });
    }
  }
  throw new Error('distance not found');
}

function lapSamples(
  runtime: RuntimeProfile,
  lateralAt: (distanceM: number) => number,
  accuracyM = 3,
): LocationSample[] {
  const total = polylineLength(runtime.centerline);
  const samples: LocationSample[] = [];
  for (let distanceM = 0; distanceM < total; distanceM += 5) {
    const point = pointAt(runtime, distanceM, lateralAt(distanceM));
    samples.push({ tMono: distanceM, lat: point.lat, lon: point.lon, accuracyM, source: 'gnss' });
  }
  return samples;
}

function racingLine(distanceM: number): number {
  return 3 * Math.sin(distanceM / 40);
}

function drivers(runtime: RuntimeProfile, count: number, lapsEach: number): ValidationTrace[] {
  return Array.from({ length: count }, (_, index) => ({
    driverId: `driver-${index + 1}`,
    cleanLapCount: lapsEach,
    samples: lapSamples(runtime, (distanceM) => racingLine(distanceM + index * 17)),
  }));
}

function firstCorner(corners: readonly Corner[]): Corner {
  const corner = corners[0];
  if (corner === undefined) throw new Error('test ring has no corners');
  return corner;
}

describe('assessGeometryDeviation', () => {
  const runtime = testRuntime();
  const corners = analyzeCorners(runtime);

  it('marks matching traces from enough drivers as a community-verified candidate', () => {
    const report = assessGeometryDeviation(runtime, corners, drivers(runtime, 3, 8), {
      onTrackLateralM: 10,
    });

    expect(report.verdict).toBe('community-verified-candidate');
    expect(report.reasons).toEqual([]);
    expect(report.driverCount).toBe(3);
    expect(report.cleanLapCount).toBe(24);
    expect(report.overall.outsideFraction).toBe(0);
    expect(report.overall.p95AbsLateralM).toBeLessThanOrEqual(3.01);
    expect(report.corners).toHaveLength(corners.length);
    for (const corner of report.corners) {
      expect(corner.driverCount).toBe(3);
    }
  });

  it('asks for more evidence when too few drivers or laps are present', () => {
    const report = assessGeometryDeviation(runtime, corners, drivers(runtime, 2, 5), {
      onTrackLateralM: 10,
    });

    expect(report.verdict).toBe('insufficient-evidence');
    expect(report.reasons).toContain('DRIVERS_BELOW_MIN');
    expect(report.reasons).toContain('CLEAN_LAPS_BELOW_MIN');
  });

  it('flags the corner where every driver runs outside the mapped line', () => {
    const corner = firstCorner(corners);
    const shifted = (distanceM: number): number =>
      distanceM >= corner.entryDistanceM && distanceM <= corner.exitDistanceM
        ? 18
        : racingLine(distanceM);
    const traces: ValidationTrace[] = ['a', 'b', 'c'].map((driverId) => ({
      driverId,
      cleanLapCount: 10,
      samples: lapSamples(runtime, shifted),
    }));

    const report = assessGeometryDeviation(runtime, corners, traces, { onTrackLateralM: 10 });

    expect(report.verdict).toBe('geometry-mismatch');
    expect(report.reasons).toContain(`CORNER_${corner.id}_OUTSIDE_FRACTION_ABOVE_MAX`);
    const flagged = report.corners.find((entry) => entry.cornerId === corner.id);
    expect(flagged?.medianSignedLateralM).toBeGreaterThan(17);
  });

  it('rejects samples with poor or missing accuracy', () => {
    const traces = drivers(runtime, 3, 8);
    const noisy: ValidationTrace = {
      driverId: 'noisy',
      cleanLapCount: 0,
      samples: [
        ...lapSamples(runtime, racingLine, 25),
        ...lapSamples(runtime, racingLine).map(({ accuracyM: _accuracyM, ...rest }) => rest),
      ],
    };

    const report = assessGeometryDeviation(runtime, corners, [...traces, noisy], {
      onTrackLateralM: 10,
    });

    expect(report.rejectedForAccuracy).toBe(noisy.samples.length);
    expect(report.driverCount).toBe(3);
    expect(report.verdict).toBe('community-verified-candidate');
  });

  it('excludes samples far beyond the corridor, such as the paddock', () => {
    const traces = drivers(runtime, 3, 8);
    const paddock = pointAt(runtime, 100, 200);
    const withPaddock: ValidationTrace = {
      driverId: 'driver-1',
      cleanLapCount: 0,
      samples: [{ tMono: 0, lat: paddock.lat, lon: paddock.lon, accuracyM: 2, source: 'gnss' }],
    };

    const report = assessGeometryDeviation(runtime, corners, [...traces, withPaddock], {
      onTrackLateralM: 10,
    });

    expect(report.rejectedBeyondCorridor).toBe(1);
    expect(report.verdict).toBe('community-verified-candidate');
  });

  it('reports no usable samples for empty input', () => {
    const report = assessGeometryDeviation(runtime, corners, [], { onTrackLateralM: 10 });

    expect(report.verdict).toBe('insufficient-evidence');
    expect(report.reasons).toContain('NO_USABLE_SAMPLES');
    expect(report.overall.sampleCount).toBe(0);
  });

  it('rejects invalid configuration and traces', () => {
    expect(() => assessGeometryDeviation(runtime, corners, [], { onTrackLateralM: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      assessGeometryDeviation(runtime, corners, [], { onTrackLateralM: 10, excludeBeyondM: 5 }),
    ).toThrow(RangeError);
    expect(() =>
      assessGeometryDeviation(runtime, corners, [], { onTrackLateralM: 10, maxOutsideFraction: 2 }),
    ).toThrow(RangeError);
    expect(() =>
      assessGeometryDeviation(
        runtime,
        corners,
        [{ driverId: 'x', cleanLapCount: -1, samples: [] }],
        { onTrackLateralM: 10 },
      ),
    ).toThrow(RangeError);
    expect(() =>
      assessGeometryDeviation(
        runtime,
        corners,
        [{ driverId: ' ', cleanLapCount: 1, samples: [] }],
        {
          onTrackLateralM: 10,
        },
      ),
    ).toThrow(RangeError);
  });
});
