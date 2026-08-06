import { describe, expect, it } from 'vitest';
import { polylineCumulative, projectOntoPolyline } from '../../src/geometry';

describe('hinted projection performance', () => {
  it('runs 10,000 projections on a 500-vertex loop in under two seconds', () => {
    const vertexCount = 500;
    const loop = Array.from({ length: vertexCount }, (_, index) => {
      const angle = (index / vertexCount) * Math.PI * 2;
      return { e: Math.cos(angle) * 1_000, n: Math.sin(angle) * 1_000 };
    });
    const cumulative = polylineCumulative(loop);
    const approximateTotal = cumulative[cumulative.length - 1] ?? 0;

    // Warm up the optimizing compiler outside the measured region.
    for (let index = 0; index < 100; index += 1) {
      projectOntoPolyline({ e: 1_005, n: 0 }, loop, cumulative, true, {
        distanceM: 0,
        windowM: 50,
      });
    }

    const startedAt = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      const fraction = index / 10_000;
      const angle = fraction * Math.PI * 2;
      projectOntoPolyline(
        { e: Math.cos(angle) * 1_005, n: Math.sin(angle) * 1_005 },
        loop,
        cumulative,
        true,
        { distanceM: fraction * approximateTotal, windowM: 50 },
      );
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
  });
});
