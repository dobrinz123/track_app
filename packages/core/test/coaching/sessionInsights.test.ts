import { describe, expect, it } from 'vitest';

import { analyzeSession, MIN_CLEAN_LAPS_FOR_COMPARISON } from '../../src/coaching';
import type { SessionAnalysisContext, SessionLapInput } from '../../src/coaching';
import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';

import { SYNTHETIC_CORNER, SYNTHETIC_TOTAL_LENGTH_M, syntheticLap } from './syntheticLap';
import type { SyntheticLapOptions } from './syntheticLap';

const CORNERS = [SYNTHETIC_CORNER];
const CONTEXT: SessionAnalysisContext = {
  totalLengthM: SYNTHETIC_TOTAL_LENGTH_M,
  circuitId: 'synthetic-oval',
  circuitName: 'Synthetic Oval',
};

let clock = 0;

function lapInput(lapNumber: number, options: SyntheticLapOptions = {}): SessionLapInput {
  const samples = syntheticLap({ ...options, tStartMs: clock });
  const first = samples[0];
  const last = samples[samples.length - 1];
  clock = (last?.tMonoMs ?? 0) + 1_000;
  return {
    lap: {
      lapNumber,
      durationMs: (last?.tMonoMs ?? 0) - (first?.tMonoMs ?? 0),
      valid: true,
      invalidReasons: [],
      quality: 'good',
    },
    samples,
    sectorTimes: [
      { sectorIndex: 0, durationMs: Math.round(((last?.tMonoMs ?? 0) - (first?.tMonoMs ?? 0)) / 2) },
      {
        sectorIndex: 1,
        durationMs:
          (last?.tMonoMs ?? 0) -
          (first?.tMonoMs ?? 0) -
          Math.round(((last?.tMonoMs ?? 0) - (first?.tMonoMs ?? 0)) / 2),
      },
    ],
  };
}

/** Three laps that differ in braking point and corner speed, like real laps do. */
function threeLapSession(): SessionLapInput[] {
  clock = 0;
  return [
    lapInput(1, { profileShiftM: 0 }),
    lapInput(2, { profileShiftM: 14, speedScale: 1.02 }),
    lapInput(3, { profileShiftM: -10, speedScale: 0.98 }),
  ];
}

describe('analyzeSession: shape and honesty', () => {
  it('classifies every lap, keeps the analysis version and reports observations only', () => {
    const insights = analyzeSession(threeLapSession(), CORNERS, CONTEXT);
    expect(insights.analysisVersion).toBe(CORNER_ANALYSIS_VERSION);
    expect(insights.observationsOnly).toBe(true);
    expect(insights.lapCount).toBe(3);
    expect(insights.cleanLapCount).toBe(3);
    expect(insights.laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 3]);
    expect(insights.corners).toHaveLength(1);
    expect(insights.corners[0]?.perLap.map((row) => row.lapNumber)).toEqual([1, 2, 3]);
  });

  it('picks the fastest clean lap as the reference and names the median lap', () => {
    const session = threeLapSession();
    const insights = analyzeSession(session, CORNERS, CONTEXT);
    const fastest = [...session].sort((a, b) => a.lap.durationMs - b.lap.durationMs)[0];
    expect(insights.referenceLapNumber).toBe(fastest?.lap.lapNumber);
    expect(insights.referenceDurationMs).toBe(fastest?.lap.durationMs);
    expect(insights.medianCleanLapNumber).not.toBeNull();
  });

  it('reports the brake and lift point of every corner on every lap (priority 3)', () => {
    const corner = analyzeSession(threeLapSession(), CORNERS, CONTEXT).corners[0];
    expect(corner?.perLap).toHaveLength(3);
    for (const row of corner?.perLap ?? []) {
      expect(row.brakeStartM).not.toBeNull();
      expect(row.brakeSource).toBe('gpsSpeed');
      expect(row.liftPointM).not.toBeNull();
      expect(row.minSpeedKph).not.toBeNull();
      expect(row.exitSpeedKph).not.toBeNull();
    }
    // The braking points really do differ lap to lap (14 m later on lap 2).
    const brakePoints = (corner?.perLap ?? []).map((row) => row.brakeStartM ?? 0);
    expect(Math.max(...brakePoints) - Math.min(...brakePoints)).toBeGreaterThan(15);
  });

  it('scores consistency from the spread of brake point, min speed and corner time (priority 2)', () => {
    const insights = analyzeSession(threeLapSession(), CORNERS, CONTEXT);
    const consistency = insights.corners[0]?.consistency;
    expect(consistency?.lapCount).toBe(3);
    expect(consistency?.brakeSpreadM ?? 0).toBeGreaterThan(0);
    expect(consistency?.minSpeedSpreadKph ?? -1).toBeGreaterThanOrEqual(0);
    expect(consistency?.score ?? -1).toBeGreaterThanOrEqual(0);
    expect(consistency?.score ?? 101).toBeLessThanOrEqual(100);
    expect(insights.consistencyRanking.map((entry) => entry.cornerId)).toEqual([1]);
    expect(insights.lapTimeConsistency?.lapCount).toBe(3);
    expect(insights.lapTimeConsistency?.bestMs).toBe(insights.referenceDurationMs);
  });

  it('ranks time loss per corner against the driver’s own best clean lap (priority 1)', () => {
    const insights = analyzeSession(threeLapSession(), CORNERS, CONTEXT);
    const finding = insights.timeLossRanking[0];
    expect(finding?.cornerId).toBe(1);
    expect(finding?.referenceLapNumber).toBe(insights.referenceLapNumber);
    expect(finding?.medianLapNumber).toBe(insights.medianCleanLapNumber);
    expect(finding?.deltaMs).not.toBeNull();
    expect(finding?.bestSectorMs).not.toBeNull();
    expect(finding?.bestSectorLapNumber).not.toBeNull();
  });

  it('reports min and exit speed per corner per lap (priority 4)', () => {
    const corner = analyzeSession(threeLapSession(), CORNERS, CONTEXT).corners[0];
    const minSpeeds = (corner?.perLap ?? []).map((row) => row.minSpeedKph ?? 0);
    expect(minSpeeds.every((value) => value > 0)).toBe(true);
    expect(corner?.envelope?.highestMinSpeedKph).toBe(Math.max(...minSpeeds));
    expect(corner?.envelope?.evidenceLapIds).toEqual([1, 2, 3]);
  });

  it('ranks the track sectors against the reference lap when sector times are given', () => {
    const insights = analyzeSession(threeLapSession(), CORNERS, CONTEXT);
    expect(insights.sectorTimeLoss.map((entry) => entry.sectorIndex).sort()).toEqual([0, 1]);
    for (const sector of insights.sectorTimeLoss) {
      expect(sector.referenceLapNumber).toBe(insights.referenceLapNumber);
      expect(sector.lostMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic and independent of the order the laps arrive in', () => {
    const session = threeLapSession();
    const forward = analyzeSession(session, CORNERS, CONTEXT);
    const reversed = analyzeSession([...session].reverse(), CORNERS, CONTEXT);
    expect(JSON.stringify(reversed)).toEqual(JSON.stringify(forward));
  });
});

describe('analyzeSession: honesty gates', () => {
  it('degrades to per-lap facts with fewer than two clean laps', () => {
    clock = 0;
    const insights = analyzeSession([lapInput(1)], CORNERS, CONTEXT);
    expect(MIN_CLEAN_LAPS_FOR_COMPARISON).toBe(2);
    expect(insights.cleanLapCount).toBe(1);
    expect(insights.timeLossRanking).toEqual([]);
    expect(insights.consistencyRanking).toEqual([]);
    expect(insights.lapTimeConsistency).toBeNull();
    expect(insights.sectorTimeLoss).toEqual([]);
    expect(insights.limitations.map((entry) => entry.code)).toContain('FEW_CLEAN_LAPS');
    // The per-lap facts are still there.
    expect(insights.corners[0]?.perLap[0]?.brakeStartM).not.toBeNull();
  });

  it('states that no clean lap exists and excludes the anomalous lap from the envelope', () => {
    clock = 0;
    const dirty = lapInput(1, { lateralM: () => 40 });
    const insights = analyzeSession([dirty], CORNERS, CONTEXT);
    expect(insights.cleanLapCount).toBe(0);
    expect(insights.referenceLapNumber).toBeNull();
    expect(insights.laps[0]?.reasons).toContain('offTrack');
    expect(insights.envelope.cleanLapIds).toEqual([]);
    expect(insights.limitations.map((entry) => entry.code)).toContain('NO_CLEAN_LAPS');
  });

  it('lists the channels this session did not have', () => {
    clock = 0;
    const insights = analyzeSession(threeLapSession(), CORNERS, CONTEXT);
    const missing = insights.limitations.find((entry) => entry.code === 'MISSING_CHANNELS');
    expect(missing?.channels).toContain('accelPedalPct');
    expect(missing?.channels).toContain('latG');
    expect(insights.availability.available).toEqual(['speedKph']);
  });

  it('honours unsupportedChannels and names them as a limitation', () => {
    clock = 0;
    const session = [
      lapInput(1, { channels: 'all' }),
      lapInput(2, { channels: 'all', profileShiftM: 12 }),
    ];
    const insights = analyzeSession(session, CORNERS, {
      ...CONTEXT,
      unsupportedChannels: ['latG'],
    });
    expect(insights.availability.unsupported).toEqual(['latG']);
    expect(insights.corners[0]?.perLap[0]?.maxLatG).toBeNull();
    expect(insights.limitations.map((entry) => entry.code)).toContain('UNSUPPORTED_CHANNELS');
  });

  it('flags unvalidated circuit geometry when the caller says so', () => {
    clock = 0;
    const insights = analyzeSession(threeLapSession(), CORNERS, {
      ...CONTEXT,
      geometryValidated: false,
    });
    expect(insights.geometryValidated).toBe(false);
    expect(insights.limitations.map((entry) => entry.code)).toContain('GEOMETRY_UNVALIDATED');
  });

  it('flags poor GNSS quality with the lap numbers that had it', () => {
    clock = 0;
    const insights = analyzeSession(
      [lapInput(1, { accuracyM: 60 }), lapInput(2), lapInput(3)],
      CORNERS,
      CONTEXT,
    );
    const gnss = insights.limitations.find((entry) => entry.code === 'GNSS_QUALITY');
    expect(gnss?.lapNumbers).toEqual([1]);
    expect(insights.cleanLapCount).toBe(2);
  });

  it('refuses a non-positive circuit length', () => {
    expect(() => analyzeSession([], CORNERS, { ...CONTEXT, totalLengthM: 0 })).toThrow(RangeError);
  });

  it('produces an empty but well-formed analysis for a session with no laps', () => {
    const insights = analyzeSession([], CORNERS, CONTEXT);
    expect(insights.lapCount).toBe(0);
    expect(insights.corners).toHaveLength(1);
    expect(insights.corners[0]?.perLap).toEqual([]);
    expect(insights.limitations.map((entry) => entry.code)).toContain('NO_CLEAN_LAPS');
  });
});
