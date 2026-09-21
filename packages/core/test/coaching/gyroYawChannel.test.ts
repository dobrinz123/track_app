import { describe, expect, it } from 'vitest';

import { classifyLap, joinTelemetryChannels } from '../../src/coaching';
import type { ClassifiableLap, CornerLapSample } from '../../src/coaching';
import type { TelemetrySample } from '../../src/telemetry/contracts';

import { driveCircuitSession, motorpark, transilvania, type TestCircuit } from './circuits';

/**
 * Ticket P6a — `yawRateDps` is a `TelemetryChannelId` now, because a provider
 * finally emits it (`apps/mobile/src/session/gforceProvider.ts`, behind
 * `imuFusionEnabled`). `coaching/types.ts` always said that is how the tier-2
 * channels would arrive: "when a provider starts emitting them they move into
 * `TelemetryChannelId` and this alias collapses to it."
 *
 * What is proved here is that the yaw check in `cleanLap.ts` really TAKES the
 * gyro path when the channel is present, rather than quietly staying on its
 * GNSS course-over-ground fallback -- on a real catalog circuit, on the same
 * `driveCircuitSession` rig the rest of the coaching suite drives, and on BOTH
 * bundled circuits (nothing here may key off a circuit id).
 */

const CIRCUITS: readonly { name: string; load: () => TestCircuit }[] = [
  { name: 'transilvania-motor-ring', load: transilvania },
  { name: 'motorpark-romania', load: motorpark },
];

/** Adds `deltaDps` to `yawRateDps` over a run of samples, touching nothing else. */
function injectGyroOnlyRotation(
  samples: readonly CornerLapSample[],
  fromIndex: number,
  count: number,
  deltaDps: number,
): CornerLapSample[] {
  return samples.map((sample, index) => {
    if (index < fromIndex || index >= fromIndex + count) return sample;
    const channels = sample.channels;
    if (channels === undefined) return sample;
    const current = channels.yawRateDps;
    if (current === undefined) return sample;
    return { ...sample, channels: { ...channels, yawRateDps: current + deltaDps } };
  });
}

/** The same samples with the gyro channel removed and everything else, `headingDeg` included, intact. */
function withoutGyro(samples: readonly CornerLapSample[]): CornerLapSample[] {
  return samples.map((sample) => {
    const channels = sample.channels;
    if (channels === undefined || channels.yawRateDps === undefined) return sample;
    const kept = Object.fromEntries(
      Object.entries(channels).filter(([channel]) => channel !== 'yawRateDps'),
    );
    return { ...sample, channels: kept };
  });
}

describe('P6a -- classifyLap reads the recorded gyro channel in preference to GNSS heading', () => {
  for (const { name, load } of CIRCUITS) {
    describe(name, () => {
      const circuit = load();
      const session = driveCircuitSession(circuit, { laps: 1, channels: 'tier2', seed: 6_301 });
      const lapInput = session[0];
      if (lapInput === undefined) throw new Error(`${name}: the rig produced no lap`);
      const lap: ClassifiableLap = lapInput.lap;
      const options = { totalLengthM: circuit.totalLengthM };

      it('the rig really does carry a gyro channel on this circuit', () => {
        const withGyro = lapInput.samples.filter((s) => Number.isFinite(s.channels?.yawRateDps));
        expect(withGyro.length).toBeGreaterThan(50);
        // ... and a heading fallback too, so the two paths are genuinely both available.
        expect(lapInput.samples.filter((s) => Number.isFinite(s.headingDeg)).length).toBeGreaterThan(50);
      });

      it('a rotation that ONLY the gyro saw is reported -- proof the gyro path is the one taken', () => {
        // A burst the GNSS course over ground knows nothing about: heading and
        // the centreline are untouched, only `yawRateDps` moves. If the check
        // were still reading `headingDeg` this would be invisible.
        const spun = injectGyroOnlyRotation(lapInput.samples, 40, 6, 400);

        const withGyro = classifyLap(lap, spun, options);
        expect(withGyro.yawExcessDps).not.toBeNull();
        expect(withGyro.yawExcessDps!).toBeGreaterThan(150);
        expect(withGyro.labels).toContain('SLIDE_ROTATION');

        // The identical samples with the channel removed: the check falls back
        // to heading, which never saw the rotation, so nothing is reported.
        const headingOnly = classifyLap(lap, withoutGyro(spun), options);
        expect(headingOnly.yawExcessDps).toBeNull();
        expect(headingOnly.labels).not.toContain('SLIDE_ROTATION');
      });

      it('the yaw check is available on the gyro channel, and unavailable when NEITHER signal is there', () => {
        const onGyro = classifyLap(lap, lapInput.samples, options);
        expect(onGyro.unavailableChecks).not.toContain('yawSpike');
        expect(onGyro.checkCoverage.yawSpike).toBeGreaterThan(0.5);

        const blind: CornerLapSample[] = withoutGyro(lapInput.samples).map((sample) =>
          Object.fromEntries(
            Object.entries(sample).filter(([key]) => key !== 'headingDeg'),
          ) as CornerLapSample,
        );
        expect(classifyLap(lap, blind, options).unavailableChecks).toContain('yawSpike');
      });
    });
  }
});

describe('P6a -- yawRateDps is a TelemetryChannelId that survives the join', () => {
  it('a recorded yawRateDps TelemetrySample lands on the projected sample it belongs to', () => {
    const samples: CornerLapSample[] = [0, 1, 2, 3].map((index) => ({
      tMonoMs: index * 200,
      distanceM: index * 10,
      speedKph: 120,
    }));
    // Typed as `TelemetrySample` -- this line is itself the contract change:
    // before P6a `yawRateDps` was not a member of `TelemetryChannelId`.
    const recorded: TelemetrySample[] = [
      { channel: 'yawRateDps', value: 12.5, tMonoMs: 0 },
      { channel: 'yawRateDps', value: -30, tMonoMs: 400 },
      { channel: 'latG', value: 0.8, tMonoMs: 400 },
    ];

    const joined = joinTelemetryChannels(samples, recorded);
    expect(joined[0]?.channels?.yawRateDps).toBe(12.5);
    expect(joined[2]?.channels?.yawRateDps).toBe(-30);
    expect(joined[2]?.channels?.latG).toBe(0.8);
  });
});
