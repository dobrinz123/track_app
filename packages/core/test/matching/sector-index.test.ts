import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleAtLapDistance } from '../../src/fixtures';
import { TrackMatcher } from '../../src/matching';
import { loadProfileFromJson } from '../../src/profile';

// Closes final-verification DoD row 5 gap: TrackMatch.sectorIndex had no
// committed assertion. App sectors on the TMR profile are defined at 1/3 and
// 2/3 of the lap distance (ADR-0002), so distances well inside each third
// must report sector 0, 1, and 2 respectively.
describe('TrackMatcher sectorIndex', () => {
  it('reports the app-defined sector for distances inside each third of the lap', () => {
    const json = readFileSync(
      new URL('../../assets/circuits/transilvania-motor-ring.v1.json', import.meta.url),
      'utf8',
    );
    const loaded = loadProfileFromJson(json);
    if (!loaded.ok) throw new Error(loaded.errors.join(', '));
    const { profile, runtime } = loaded;
    const third = profile.totalLengthM / 3;

    const cases: Array<{ distanceM: number; expectedSector: number }> = [
      { distanceM: third * 0.5, expectedSector: 0 },
      { distanceM: third * 1.5, expectedSector: 1 },
      { distanceM: third * 2.5, expectedSector: 2 },
    ];

    for (const { distanceM, expectedSector } of cases) {
      // Fresh matcher per case: the first match performs a full search, so no
      // continuity hint is needed and no teleport guard can interfere.
      const matcher = new TrackMatcher(runtime);
      const match = matcher.match(
        sampleAtLapDistance(profile, distanceM, 0, { lateralOffsetM: 0, accuracyM: 3 }),
      );
      expect(match, `distance ${distanceM}`).not.toBeNull();
      expect(match?.sectorIndex, `distance ${distanceM}`).toBe(expectedSector);
    }
  });
});
