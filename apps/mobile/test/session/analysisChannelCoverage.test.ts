import { describe, expect, it } from 'vitest';
import type { CornerLapSample } from '@circuit/core';

import {
  ANALYSIS_MIN_CHANNEL_COVERAGE,
  assembleSessionAnalysis,
  excludedChannelsForSamples,
} from '../../src/session/analysisAssembly';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5b-FIX1 C2 (Codex P5b-REV1 finding 2): channel coverage is decided
 * PER LAP -- a channel enters a lap's engine input only if it covered THAT
 * lap -- the 50 % boundary is conservative (exactly half is not enough), and a
 * channel missing from any analysed lap is reported rather than silently mixed
 * with the fallback estimators of the laps that lacked it.
 */

function sample(tMonoMs: number, channels?: Record<string, number>): CornerLapSample {
  return {
    tMonoMs,
    distanceM: tMonoMs / 10,
    speedKph: 100,
    ...(channels === undefined ? {} : { channels }),
  } as CornerLapSample;
}

describe('P5b-FIX1 C2 -- per-lap channel coverage', () => {
  it('treats exactly 50 % coverage as too little (the boundary is conservative)', () => {
    const half = [
      sample(0, { rpm: 1_000 }),
      sample(100, { rpm: 1_100 }),
      sample(200),
      sample(300),
    ];
    expect(excludedChannelsForSamples(half, ANALYSIS_MIN_CHANNEL_COVERAGE)).toContain('rpm');

    const overHalf = [
      sample(0, { rpm: 1_000 }),
      sample(100, { rpm: 1_100 }),
      sample(200, { rpm: 1_200 }),
      sample(300),
    ];
    expect(excludedChannelsForSamples(overHalf, ANALYSIS_MIN_CHANNEL_COVERAGE)).not.toContain('rpm');
  });

  it('keeps a channel on the lap that carried it and strips it from the lap that did not', () => {
    const { circuit } = allBundledCircuits()[0]!;
    const session = driveSession(circuit, { laps: 2, channels: 'full' });
    // Lap 2 loses its rpm rows entirely; lap 1 keeps all of them.
    const second = session.recordings[1]!;
    second.telemetry = second.telemetry.filter((entry) => entry.channel !== 'rpm');

    const assembled = assembleSessionAnalysis(circuit, session.recordings);

    const lapOne = assembled.laps.find((lap) => lap.lap.lapNumber === 1)!;
    const lapTwo = assembled.laps.find((lap) => lap.lap.lapNumber === 2)!;
    expect(lapOne.samples.some((entry) => Number.isFinite(entry.channels?.rpm))).toBe(true);
    expect(lapTwo.samples.some((entry) => Number.isFinite(entry.channels?.rpm))).toBe(false);

    // The channel still counts as used (lap 1 has it) ...
    expect(assembled.usedChannels).toContain('rpm');
    // ... and the lap that lacked it is REPORTED, never quietly mixed in.
    const excluded = assembled.lowCoverageChannels.find((entry) => entry.channel === 'rpm');
    expect(excluded).toBeDefined();
    expect(excluded!.excludedLapNumbers).toEqual([2]);
    expect(assembled.perLapCoverage.map((entry) => entry.lapNumber)).toEqual([1, 2]);
    expect(
      assembled.perLapCoverage.find((entry) => entry.lapNumber === 2)!.excluded,
    ).toContain('rpm');
  });

  it('drops a channel from every lap when no lap carried enough of it', () => {
    const { circuit } = allBundledCircuits()[0]!;
    const session = driveSession(circuit, { laps: 2, channels: 'full' });
    for (const recording of session.recordings) {
      let kept = 0;
      recording.telemetry = recording.telemetry.filter((entry) => {
        if (entry.channel !== 'brakeSwitch') return true;
        kept += 1;
        return kept <= 2;
      });
    }
    const assembled = assembleSessionAnalysis(circuit, session.recordings);
    expect(assembled.usedChannels).not.toContain('brakeSwitch');
    const excluded = assembled.lowCoverageChannels.find((entry) => entry.channel === 'brakeSwitch');
    expect(excluded!.excludedLapNumbers).toEqual([1, 2]);
    for (const lap of assembled.laps) {
      expect(lap.samples.some((entry) => Number.isFinite(entry.channels?.brakeSwitch))).toBe(false);
    }
  });
});
