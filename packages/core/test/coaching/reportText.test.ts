import { describe, expect, it } from 'vitest';

import { GRAVITY_MPS2, analyzeSession, buildReport, renderReport } from '../../src/coaching';
import type { SessionAnalysisContext, SessionInsights, SessionLapInput } from '../../src/coaching';

import { SYNTHETIC_CORNER, SYNTHETIC_TOTAL_LENGTH_M, syntheticLap } from './syntheticLap';
import type { SyntheticLapOptions } from './syntheticLap';

const CORNERS = [SYNTHETIC_CORNER];
const CONTEXT: SessionAnalysisContext = {
  totalLengthM: SYNTHETIC_TOTAL_LENGTH_M,
  circuitId: 'synthetic-oval',
  circuitName: 'Synthetic Oval',
};

/** No sentence may ever render a missing number. */
const FORBIDDEN = /undefined|NaN|null/;

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
  };
}

function session(options: { channels?: SyntheticLapOptions['channels'] } = {}): SessionInsights {
  clock = 0;
  const channels = options.channels;
  const laps = [
    lapInput(1, { channels, profileShiftM: 0 }),
    lapInput(2, { channels, profileShiftM: 14, speedScale: 1.02 }),
    lapInput(3, { channels, profileShiftM: -10, speedScale: 0.98 }),
  ];
  return analyzeSession(laps, CORNERS, CONTEXT);
}

describe('renderReport', () => {
  for (const language of ['ro', 'en'] as const) {
    it(`renders a ${language} report whose every sentence carries numbers and lap ids`, () => {
      const insights = session();
      const text = renderReport(insights, language);
      expect(text).not.toMatch(FORBIDDEN);
      expect(text.length).toBeGreaterThan(400);
      // Reference lap, its time, and the corner are all named.
      expect(text).toContain(String(insights.referenceLapNumber));
      expect(text).toMatch(language === 'ro' ? /Virajul 1/ : /Corner 1/);
      expect(text).toMatch(/\d/);
    });

    it(`ends the ${language} report with the fixed disclaimer and no suggestion`, () => {
      const report = buildReport(session(), language);
      expect(report.disclaimer.length).toBeGreaterThan(40);
      expect(report.text.endsWith(report.disclaimer)).toBe(true);
      // V1 is observations only: no imperative coaching verbs.
      const banned =
        language === 'ro' ? /frânează mai târziu|ar trebui să|încearcă să/i : /brake later|you should|try to/i;
      expect(report.text).not.toMatch(banned);
    });

    it(`keeps the ${language} report deterministic for identical input`, () => {
      expect(renderReport(session(), language)).toEqual(renderReport(session(), language));
    });
  }

  it('uses the Romanian decimal comma and the English decimal point', () => {
    const insights = session();
    expect(renderReport(insights, 'ro')).toMatch(/\d,\d/);
    expect(renderReport(insights, 'en')).toMatch(/\d\.\d/);
  });

  it('names the estimator behind every derived number', () => {
    const gps = renderReport(session(), 'en');
    expect(gps).toContain('estimated from GPS speed');
    const pedal = renderReport(session({ channels: 'pedal' }), 'en');
    expect(pedal).toContain('from the accelerator pedal');
  });

  it('writes the honesty gates as sentences the driver can read', () => {
    clock = 0;
    const single = analyzeSession([lapInput(1)], CORNERS, { ...CONTEXT, geometryValidated: false });
    const ro = renderReport(single, 'ro');
    const en = renderReport(single, 'en');
    expect(ro).toContain('Doar 1 tur curat');
    expect(ro).toContain('nu este validată pe teren');
    expect(en).toContain('Only 1 clean lap');
    expect(en).toContain('has not been validated on track');
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('states an excluded lap’s reason in the report’s own language', () => {
    clock = 0;
    const insights = analyzeSession(
      [lapInput(1), lapInput(2, { lateralM: () => 40 })],
      CORNERS,
      CONTEXT,
    );
    expect(insights.laps[1]?.reasons).toContain('offTrack');
    const ro = renderReport(insights, 'ro');
    expect(ro).toContain('turul 2: ieșire de pe traseu');
    expect(ro).not.toContain('lateral offset');
    expect(renderReport(insights, 'en')).toContain('lap 2: off-track excursion');
  });

  it('stays clean for a session with no laps at all', () => {
    const empty = analyzeSession([], CORNERS, CONTEXT);
    for (const language of ['ro', 'en'] as const) {
      const text = renderReport(empty, language);
      expect(text).not.toMatch(FORBIDDEN);
      expect(text.length).toBeGreaterThan(100);
    }
  });

  it('stays clean when a lap is anomalous and has no measurable corner', () => {
    clock = 0;
    const partial = lapInput(1);
    const trimmed: SessionLapInput = {
      ...partial,
      samples: partial.samples.filter((sample) => sample.distanceM < 300),
    };
    const insights = analyzeSession([trimmed], CORNERS, CONTEXT);
    for (const language of ['ro', 'en'] as const) {
      expect(renderReport(insights, language)).not.toMatch(FORBIDDEN);
    }
  });

  it('renders a NEGATIVE corner delta as a gain, never as "lost -0,20 s" (M5)', () => {
    clock = 0;
    // Lap 2 is slower overall (it coasts down the back straight) but brakes
    // later and carries more speed through the corner window.
    const laps = [
      lapInput(1),
      lapInput(2, {
        accelAt: (distanceM) => {
          if (distanceM < 420) return 0;
          if (distanceM < 600) return -3;
          if (distanceM < 660) return 0;
          if (distanceM < 760) return 2;
          return -2;
        },
      }),
    ];
    const insights = analyzeSession(laps, CORNERS, CONTEXT);
    expect(insights.referenceLapNumber).toBe(1);
    const finding = insights.timeLossRanking[0];
    expect(finding?.deltaMs ?? 0).toBeLessThan(0);

    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(ro).toContain('ai câștigat');
    expect(en).toContain('you gained');
    expect(ro).not.toMatch(/pierdut\s+[-−]/);
    expect(en).not.toMatch(/lost\s+[-−]/);
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('says a lap could not be verified instead of inventing a reason (H5)', () => {
    clock = 0;
    const stripped = [lapInput(1), lapInput(2, { profileShiftM: 10 })].map((entry) => ({
      ...entry,
      samples: entry.samples.map(({ tMonoMs, distanceM, speedKph }) => ({
        tMonoMs,
        distanceM,
        speedKph,
      })),
    }));
    const insights = analyzeSession(stripped, CORNERS, CONTEXT);
    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(ro).toContain('nu au putut fi verificate');
    expect(en).toContain('could not be verified');
    expect(ro).not.toContain('motiv nespecificat');
    expect(en).not.toContain('unspecified reason');
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('says HOW MUCH of the lap the missing evidence covered, in both languages (H5)', () => {
    clock = 0;
    const thin = [lapInput(1), lapInput(2, { profileShiftM: 10 })].map((entry) => ({
      ...entry,
      samples: entry.samples.map((sample) =>
        sample.distanceM <= 100
          ? sample
          : { tMonoMs: sample.tMonoMs, distanceM: sample.distanceM, speedKph: sample.speedKph },
      ),
    }));
    const insights = analyzeSession(thin, CORNERS, CONTEXT);
    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(ro).toContain('din tur');
    expect(en).toContain('% of the lap');
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('overview says "no data" only when an unavailable check truly has 0 % coverage (Q3)', () => {
    clock = 0;
    // Every safety channel besides speed is entirely absent: 0 % coverage.
    const stripped = [lapInput(1), lapInput(2, { profileShiftM: 10 })].map((entry) => ({
      ...entry,
      samples: entry.samples.map(({ tMonoMs, distanceM, speedKph }) => ({
        tMonoMs,
        distanceM,
        speedKph,
      })),
    }));
    const insights = analyzeSession(stripped, CORNERS, CONTEXT);
    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(en).toContain('no data for');
    expect(ro).toContain('lipsesc datele pentru');
    expect(en).not.toContain('insufficient data');
    expect(ro).not.toContain('date insuficiente');
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('overview says "insufficient data (covers X %)" for a check with partial coverage, not "no data" (Q3)', () => {
    clock = 0;
    // Every safety channel besides speed stops after the first 100 m of a
    // 1000 m lap: partial (~10 %) coverage, not zero.
    const thin = [lapInput(1), lapInput(2, { profileShiftM: 10 })].map((entry) => ({
      ...entry,
      samples: entry.samples.map((sample) =>
        sample.distanceM <= 100
          ? sample
          : { tMonoMs: sample.tMonoMs, distanceM: sample.distanceM, speedKph: sample.speedKph },
      ),
    }));
    const insights = analyzeSession(thin, CORNERS, CONTEXT);
    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(en).toMatch(/insufficient data \(covers \d+ ?%\)/);
    expect(ro).toMatch(/date insuficiente \(acoperă \d+ ?%\)/);
    // "no data" would contradict the coverage percentage the report also gives.
    expect(en).not.toContain('no data for');
    expect(ro).not.toContain('lipsesc datele pentru');
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('says when the integrated time disagrees with the recorded clock (M2)', () => {
    clock = 0;
    const laps = [lapInput(1), lapInput(2, { profileShiftM: 10 }), lapInput(3)];
    const drifting = laps.map((entry, index) => {
      if (index !== 1) return entry;
      const first = entry.samples[0]?.tMonoMs ?? 0;
      const samples = entry.samples.map((sample) => ({
        ...sample,
        tMonoMs: first + (sample.tMonoMs - first) * 1.05,
      }));
      const last = samples[samples.length - 1];
      return {
        ...entry,
        lap: { ...entry.lap, durationMs: (last?.tMonoMs ?? 0) - first },
        samples,
      };
    });
    const insights = analyzeSession(drifting, CORNERS, CONTEXT);
    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(ro).toContain('viteza înregistrată');
    expect(en).toContain('recorded speed');
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('renders heavy braking as a neutral label, never an exclusion (R2-1)', () => {
    clock = 0;
    const heavy = lapInput(1, {
      accelAt: (distanceM) => (distanceM >= 200 && distanceM < 220 ? -1.3 * GRAVITY_MPS2 : 0),
    });
    const insights = analyzeSession([heavy, lapInput(2, { profileShiftM: 10 })], CORNERS, CONTEXT);
    expect(insights.laps[0]?.status).toBe('clean');
    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(ro).toMatch(/Turul 1:.*frânare foarte tare/);
    expect(en).toMatch(/Lap 1:.*very hard braking/);
    // Never presented as an exclusion: this lap IS the/among the clean laps.
    expect(ro).not.toMatch(/Turul 1[^\n]*tur incomplet/);
    expect(en).not.toContain('Laps excluded from the comparisons: 1');
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('renders a slide/rotation label with its yaw excess, never as an anomaly reason (R2-1)', () => {
    clock = 0;
    const sliding = lapInput(1, {
      headingDeg: (distanceM, index) => (distanceM > 640 ? (index * 40) % 360 : 10),
    });
    const insights = analyzeSession([sliding, lapInput(2, { profileShiftM: 10 })], CORNERS, CONTEXT);
    expect(insights.laps[0]?.status).toBe('clean');
    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(ro).toMatch(/Turul 1:.*derapaj/);
    expect(en).toMatch(/Lap 1:.*slide/);
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('renders ABS-suspected oscillation as a neutral label sourced from the accelerometer', () => {
    clock = 0;
    const absLap = lapInput(1, {
      channels: 'imu',
      accelAt: (distanceM) => {
        if (distanceM < 400 || distanceM >= 600) return 0;
        const cyclePos = ((distanceM - 400) / 8) % 1;
        return cyclePos < 0.5 ? -1.4 * GRAVITY_MPS2 : -0.3 * GRAVITY_MPS2;
      },
    });
    const insights = analyzeSession([absLap, lapInput(2, { profileShiftM: 10 })], CORNERS, CONTEXT);
    expect(insights.laps[0]?.labels).toContain('ABS_SUSPECTED');
    const ro = renderReport(insights, 'ro');
    const en = renderReport(insights, 'en');
    expect(ro).toMatch(/ABS/);
    expect(en).toMatch(/ABS/);
    expect(ro).not.toMatch(FORBIDDEN);
    expect(en).not.toMatch(FORBIDDEN);
  });

  it('exposes structured sections for the mobile screen and refuses another language', () => {
    const report = buildReport(session(), 'ro');
    expect(report.sections.map((entry) => entry.id)).toContain('overview');
    expect(report.sections.map((entry) => entry.id)).toContain('corner-1');
    expect(report.sections.every((entry) => entry.heading.length > 0)).toBe(true);
    // @ts-expect-error -- the guard exists for callers without TypeScript.
    expect(() => buildReport(session(), 'de')).toThrow(RangeError);
  });
});
