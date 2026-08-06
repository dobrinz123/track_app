import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE_ID } from '../src/index';
import type { LatLon, SessionState, TrackMatch } from '../src/index';

describe('contracts smoke', () => {
  it('exposes contract types usable at compile time and a trivial runtime shape', () => {
    const origin: LatLon = { lat: 45.7, lon: 25.5 };
    const state: SessionState = 'idle';

    // trivial runtime assertions proving the test runner executes
    expect(origin.lat).toBeCloseTo(45.7);
    expect(state).toBe('idle');
    expect(CORE_PACKAGE_ID).toBe('@circuit/core');
  });

  it('lets a TrackMatch-shaped object satisfy the contract', () => {
    const match: TrackMatch = {
      tMono: 0,
      distanceM: 0,
      progress: 0,
      unwrappedProgressM: 0,
      lateralM: 0,
      confidence: 1,
      sectorIndex: 0,
      quality: { level: 'good', reasons: [] },
      onPitLane: false,
    };
    expect(match.quality.level).toBe('good');
  });
});
