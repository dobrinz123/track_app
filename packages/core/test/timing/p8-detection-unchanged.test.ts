/**
 * Ticket P8 -- the non-negotiable part of the ticket, asserted rather than
 * argued: turning P8.1 and P8.2 on must not change WHICH crossings are
 * detected on any existing fixture or replay scenario. Only `tCross` may move.
 *
 * The owner's first real circuit session is the reason this file exists. A
 * slightly wrong timestamp is recoverable; a suppressed crossing is a lost
 * day, so the guarantee is checked event by event across every scenario the
 * repository ships, on both circuits.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CircuitProfile, CrossingEvent, LocationSample } from '../../src/contracts';
import {
  cleanRecognitionLap,
  driveLap,
  impossibleJumpLap,
  lowQualitySamplesLap,
  motorparkCleanRecognitionLap,
  motorparkMultiLapSession,
  motorparkPitLaneTransitLap,
  multiLapSession,
  noisyGpsLap,
  outOfOrderTimestampsLap,
  pauseResumeSession,
  pbImprovementSession,
  pitLaneTransitLap,
  reverseTravelLap,
  signalLossLap,
  slowerLapSession,
  startLineJitterLap,
  stoppedOnLineSession,
  wraparoundSession,
} from '../../src/fixtures';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';
import { runSessionPipeline } from '../../src/replay';
import type { CrossingDetectorConfig } from '../../src/timing/crossing-detector';

function load(file: string): { profile: CircuitProfile; runtime: RuntimeProfile } {
  const json = readFileSync(new URL(`../../assets/circuits/${file}`, import.meta.url), 'utf8');
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

const tmr = load('transilvania-motor-ring.v2.json');
const motorpark = load('motorpark-romania.v1.json');

/** Everything a `CrossingEvent` carries EXCEPT the instant P8 is allowed to move. */
function identity(event: CrossingEvent): string {
  return [
    event.gateId,
    event.kind,
    event.direction,
    event.confidence.toFixed(12),
    event.lapDistanceM.toFixed(9),
  ].join('|');
}

const P8_OFF: CrossingDetectorConfig = { dopplerCrossingTime: false, alongTrackFusion: false };

interface Case {
  name: string;
  runtime: RuntimeProfile;
  samples: readonly LocationSample[];
}

const CASES: Case[] = [
  { name: 'cleanRecognitionLap', runtime: tmr.runtime, samples: cleanRecognitionLap(tmr.profile) },
  { name: 'driveLap', runtime: tmr.runtime, samples: driveLap(tmr.profile) },
  { name: 'driveLap 10 Hz', runtime: tmr.runtime, samples: driveLap(tmr.profile, { sampleRateHz: 10 }) },
  {
    name: 'driveLap heavy braking profile',
    runtime: tmr.runtime,
    samples: driveLap(tmr.profile, {
      speedMps: ({ progress }) => 20 + 35 * Math.abs(Math.sin(progress * Math.PI * 6)),
    }),
  },
  { name: 'impossibleJumpLap', runtime: tmr.runtime, samples: impossibleJumpLap(tmr.profile) },
  { name: 'lowQualitySamplesLap', runtime: tmr.runtime, samples: lowQualitySamplesLap(tmr.profile) },
  { name: 'multiLapSession', runtime: tmr.runtime, samples: multiLapSession(tmr.profile, 3) },
  { name: 'noisyGpsLap', runtime: tmr.runtime, samples: noisyGpsLap(tmr.profile) },
  {
    name: 'outOfOrderTimestampsLap',
    runtime: tmr.runtime,
    samples: outOfOrderTimestampsLap(tmr.profile),
  },
  { name: 'pauseResumeSession', runtime: tmr.runtime, samples: pauseResumeSession(tmr.profile) },
  { name: 'pbImprovementSession', runtime: tmr.runtime, samples: pbImprovementSession(tmr.profile) },
  { name: 'pitLaneTransitLap', runtime: tmr.runtime, samples: pitLaneTransitLap(tmr.profile) },
  { name: 'reverseTravelLap', runtime: tmr.runtime, samples: reverseTravelLap(tmr.profile) },
  { name: 'signalLossLap', runtime: tmr.runtime, samples: signalLossLap(tmr.profile) },
  { name: 'slowerLapSession', runtime: tmr.runtime, samples: slowerLapSession(tmr.profile) },
  { name: 'startLineJitterLap', runtime: tmr.runtime, samples: startLineJitterLap(tmr.profile) },
  { name: 'stoppedOnLineSession', runtime: tmr.runtime, samples: stoppedOnLineSession(tmr.profile) },
  { name: 'wraparoundSession', runtime: tmr.runtime, samples: wraparoundSession(tmr.profile) },
  {
    name: 'motorparkCleanRecognitionLap',
    runtime: motorpark.runtime,
    samples: motorparkCleanRecognitionLap(motorpark.profile),
  },
  {
    name: 'motorparkMultiLapSession',
    runtime: motorpark.runtime,
    samples: motorparkMultiLapSession(motorpark.profile, 3),
  },
  {
    name: 'motorparkPitLaneTransitLap',
    runtime: motorpark.runtime,
    samples: motorparkPitLaneTransitLap(motorpark.profile),
  },
];

describe('P8 leaves crossing DETECTION untouched', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s detects exactly the same crossings with P8 on and off',
    (_name, testCase) => {
      const off = runSessionPipeline(testCase.runtime, testCase.samples, { crossings: P8_OFF });
      const on = runSessionPipeline(testCase.runtime, testCase.samples);

      expect(on.crossings.map(identity)).toEqual(off.crossings.map(identity));
      expect(on.laps.map((lap) => lap.lapNumber)).toEqual(off.laps.map((lap) => lap.lapNumber));
      expect(on.laps.map((lap) => lap.valid)).toEqual(off.laps.map((lap) => lap.valid));
      expect(on.laps.map((lap) => [...lap.invalidReasons].sort())).toEqual(
        off.laps.map((lap) => [...lap.invalidReasons].sort()),
      );
      // ...and every crossing instant still lies inside the fix stream.
      const firstT = testCase.samples[0]?.tMono ?? 0;
      const lastT = testCase.samples[testCase.samples.length - 1]?.tMono ?? 0;
      for (const event of on.crossings) {
        expect(Number.isFinite(event.tCross)).toBe(true);
        expect(event.tCross).toBeGreaterThanOrEqual(Math.min(firstT, lastT));
        expect(event.tCross).toBeLessThanOrEqual(Math.max(firstT, lastT));
      }
    },
  );

  it('at least one fixture actually exercised the new timing path', () => {
    // A green suite that never ran the code under test would prove nothing.
    const off = runSessionPipeline(tmr.runtime, multiLapSession(tmr.profile, 3), { crossings: P8_OFF });
    const on = runSessionPipeline(tmr.runtime, multiLapSession(tmr.profile, 3));
    const moved = on.crossings.filter(
      (event, index) => event.tCross !== off.crossings[index]?.tCross,
    );
    expect(moved.length).toBeGreaterThan(0);
  });

  it('a fix stream WITHOUT Doppler speed is bit-identical to today', () => {
    const stripped = multiLapSession(tmr.profile, 3).map((sample) => {
      const rest: LocationSample = { ...sample };
      delete rest.speedMps;
      return rest;
    });
    const off = runSessionPipeline(tmr.runtime, stripped, { crossings: P8_OFF });
    const on = runSessionPipeline(tmr.runtime, stripped);
    expect(on.crossings.length).toBeGreaterThan(0);
    on.crossings.forEach((event, index) => {
      expect(Object.is(event.tCross, off.crossings[index]?.tCross)).toBe(true);
    });
    expect(on.laps.map((lap) => lap.durationMs)).toEqual(off.laps.map((lap) => lap.durationMs));
  });

  it('a fix stream whose Doppler is iOS -1 is also bit-identical to today', () => {
    const invalidSpeed = multiLapSession(tmr.profile, 3).map((sample) => ({
      ...sample,
      speedMps: -1,
    }));
    const off = runSessionPipeline(tmr.runtime, invalidSpeed, { crossings: P8_OFF });
    const on = runSessionPipeline(tmr.runtime, invalidSpeed);
    expect(on.crossings.length).toBeGreaterThan(0);
    on.crossings.forEach((event, index) => {
      expect(Object.is(event.tCross, off.crossings[index]?.tCross)).toBe(true);
    });
    expect(on.laps.map((lap) => lap.durationMs)).toEqual(off.laps.map((lap) => lap.durationMs));
  });
});
