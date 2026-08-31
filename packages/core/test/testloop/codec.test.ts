import { describe, expect, it } from 'vitest';

import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';
import { buildTestLoopCircuit, decodeLearnedCircuit, encodeLearnedCircuit } from '../../src/testloop';

import { rectangleLoopSamples } from './traces';

const OPTIONS = {
  circuitId: 'learned-codec-1',
  displayName: 'Bucla de acasă',
  createdAtUtc: '2026-08-31T10:00:00.000Z',
};

function learn() {
  const result = buildTestLoopCircuit(rectangleLoopSamples(), OPTIONS);
  if (!result.ok) throw new Error(`fixture did not learn a loop: ${result.reason}`);
  return result;
}

/** Ticket P5d T4/T6: a learned circuit has to survive a restart, or it was never a circuit. */
describe('learned circuit codec (P5d T4)', () => {
  it('round-trips the profile and the corner set through storage', () => {
    const learned = learn();
    const decoded = decodeLearnedCircuit(encodeLearnedCircuit(learned.profile, learned.corners));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.profile).toEqual(learned.profile);
    expect(decoded.corners).toEqual(learned.corners);
    expect(decoded.cornersRecovered).toBe(false);
    expect(decoded.cornerAnalysisVersion).toBe(CORNER_ANALYSIS_VERSION);
    // The runtime companion is rebuilt, not stored -- and it is the real one.
    expect(decoded.runtime.centerline.length).toBe(learned.profile.centerline.length);
    expect(decoded.runtime.startFinishGate.gate.id).toBe('sf');
  });

  it('refuses stored geometry that claims to be anything but ad-hoc', () => {
    const learned = learn();
    const forged = encodeLearnedCircuit(
      { ...learned.profile, geometryStatus: 'official' },
      learned.corners,
    );

    const decoded = decodeLearnedCircuit(forged);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.errors).toContain('NOT_LEARNED_GEOMETRY');
  });

  it('names its failures instead of throwing', () => {
    expect(decodeLearnedCircuit('not json')).toEqual({ ok: false, errors: ['INVALID_JSON'] });
    expect(decodeLearnedCircuit('{"nope":1}')).toEqual({ ok: false, errors: ['INVALID_ENVELOPE'] });
  });

  it('salvages a stored circuit whose corner set is empty, and says it did', () => {
    const learned = learn();
    const decoded = decodeLearnedCircuit(encodeLearnedCircuit(learned.profile, []));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.cornersRecovered).toBe(true);
    expect(decoded.corners.length).toBeGreaterThan(0);
  });
});
