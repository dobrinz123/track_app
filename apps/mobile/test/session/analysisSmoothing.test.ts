import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { TelemetrySample } from '@circuit/core';

import {
  assembleSessionAnalysis,
  smoothGForceTelemetry,
} from '../../src/session/analysisAssembly';
import {
  createAnalysisRunner,
  type AnalysisSessionSource,
} from '../../src/session/analysisViewModel';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';
import type { AnalysisLapRecording } from '../../src/session/analysisAssembly';

/**
 * Ticket P6a — Savitzky-Golay smoothing of the recorded latG/longG series, in
 * the POST-SESSION analysis read path and nowhere else.
 *
 * Two things are on trial here. First, that with `analysisSmoothingEnabled`
 * off the assembly is byte-identical to the assembly that existed before this
 * ticket. Second, that with it on the only thing that changes is the VALUE of
 * latG/longG rows: never their count, never their order, never their
 * timestamps, and never any other channel.
 */

const G_CHANNELS = new Set(['latG', 'longG']);

/** A noisy but finite G trace at the provider's ~25 Hz, plus an unrelated channel. */
function gTrace(count: number, seed = 7): TelemetrySample[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
  const out: TelemetrySample[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = index * 40;
    const base = Math.sin(index / 6);
    out.push({ channel: 'latG', value: base + next() * 0.3, tMonoMs: t });
    out.push({ channel: 'longG', value: -base + next() * 0.3, tMonoMs: t });
    out.push({ channel: 'rpm', value: 4_000 + index, tMonoMs: t });
  }
  return out;
}

/**
 * Noisy latG/longG rows stamped on the lap's OWN GNSS timestamps, so the
 * channels clear the assembly's per-lap coverage gate and actually reach the
 * engine input -- a short burst at the start of a lap would be stripped as
 * low-coverage and the smoothing would never show up downstream.
 */
function withGChannels(
  recording: AnalysisLapRecording,
  seed: number,
): AnalysisLapRecording {
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
  const rows: TelemetrySample[] = [];
  recording.locationSamples.forEach((sample, index) => {
    const base = Math.sin(index / 5);
    rows.push({ channel: 'latG', value: base + next() * 0.35, tMonoMs: sample.tMono });
    rows.push({ channel: 'longG', value: -base + next() * 0.35, tMonoMs: sample.tMono });
  });
  return { ...recording, telemetry: [...recording.telemetry, ...rows] };
}

describe('P6a -- smoothGForceTelemetry', () => {
  it('rewrites only latG/longG values, preserving length, order, channels and timestamps', () => {
    const raw = gTrace(60);
    const smoothed = smoothGForceTelemetry(raw);

    expect(smoothed).toHaveLength(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      const before = raw[index]!;
      const after = smoothed[index]!;
      expect(after.channel).toBe(before.channel);
      expect(after.tMonoMs).toBe(before.tMonoMs);
      if (!G_CHANNELS.has(before.channel)) expect(after.value).toBe(before.value);
    }
    // ... and it really did smooth: the G rows are not the rows it was handed.
    const changed = smoothed.filter((s, i) => s.value !== raw[i]!.value);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((s) => G_CHANNELS.has(s.channel))).toBe(true);
  });

  it('never mutates its input', () => {
    const raw = gTrace(40);
    const snapshot = raw.map((s) => ({ ...s }));
    smoothGForceTelemetry(raw);
    expect(raw).toEqual(snapshot);
  });

  it('reduces sample-to-sample noise while keeping the peak of a braking spike', () => {
    const raw: TelemetrySample[] = [];
    for (let index = 0; index < 61; index += 1) {
      // A clean triangular braking event, plus a hard alternating noise term.
      const spike = index < 30 ? index / 30 : (60 - index) / 30;
      raw.push({
        channel: 'longG',
        value: -spike + (index % 2 === 0 ? 0.08 : -0.08),
        tMonoMs: index * 40,
      });
    }
    const smoothed = smoothGForceTelemetry(raw);
    const roughness = (rows: readonly TelemetrySample[]): number => {
      let sum = 0;
      for (let i = 1; i < rows.length; i += 1) sum += Math.abs(rows[i]!.value - rows[i - 1]!.value);
      return sum;
    };
    expect(roughness(smoothed)).toBeLessThan(roughness(raw) * 0.6);
    // The peak survives: a moving average would have clipped it noticeably.
    const peakRaw = Math.min(...raw.map((s) => s.value));
    const peakSmoothed = Math.min(...smoothed.map((s) => s.value));
    expect(peakSmoothed).toBeLessThan(peakRaw * 0.9);
  });

  it('degrades to the raw series rather than throwing: too few samples, or a non-finite value', () => {
    const shortSeries: TelemetrySample[] = Array.from({ length: 8 }, (_, index) => ({
      channel: 'latG' as const,
      value: index,
      tMonoMs: index * 40,
    }));
    expect(smoothGForceTelemetry(shortSeries)).toBe(shortSeries);

    const withNaN = gTrace(40);
    withNaN[0] = { channel: 'latG', value: Number.NaN, tMonoMs: 0 };
    const smoothed = smoothGForceTelemetry(withNaN);
    // The corrupt channel is passed through row for row, NaN included -- a
    // recording fault the analysis must still be able to see.
    let latGTouched = 0;
    let longGTouched = 0;
    for (let index = 0; index < withNaN.length; index += 1) {
      const before = withNaN[index]!;
      const after = smoothed[index]!;
      if (Object.is(after.value, before.value)) continue;
      if (before.channel === 'latG') latGTouched += 1;
      if (before.channel === 'longG') longGTouched += 1;
    }
    expect(latGTouched).toBe(0);
    // ... while longG, which is entirely finite, was still smoothed.
    expect(longGTouched).toBeGreaterThan(0);
  });

  it('property: output is always the same length, always finite, and never touches a non-G channel', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -3, max: 3, noNaN: true }), { minLength: 1, maxLength: 80 }),
        (values) => {
          const rows: TelemetrySample[] = values.flatMap((value, index) => [
            { channel: 'latG' as const, value, tMonoMs: index * 40 },
            { channel: 'speedKph' as const, value: 100 + index, tMonoMs: index * 40 },
          ]);
          const smoothed = smoothGForceTelemetry(rows);
          expect(smoothed).toHaveLength(rows.length);
          for (let index = 0; index < rows.length; index += 1) {
            expect(Number.isFinite(smoothed[index]!.value)).toBe(true);
            if (rows[index]!.channel === 'speedKph') {
              expect(smoothed[index]!.value).toBe(rows[index]!.value);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('P6a -- the assembly only smooths when explicitly asked to', () => {
  for (const { circuitId, circuit } of allBundledCircuits()) {
    it(`${circuitId}: smoothGForceChannels omitted === smoothGForceChannels false === the pre-P6a assembly`, () => {
      const session = driveSession(circuit, { laps: 2, channels: 'full' });
      const recordings = session.recordings.map((recording, lapIndex) =>
        withGChannels(recording, 11 + lapIndex),
      );

      const omitted = assembleSessionAnalysis(circuit, recordings);
      const explicitlyOff = assembleSessionAnalysis(circuit, recordings, {
        smoothGForceChannels: false,
      });
      expect(explicitlyOff).toEqual(omitted);

      const on = assembleSessionAnalysis(circuit, recordings, { smoothGForceChannels: true });
      // Same laps, same sample counts, same channel set -- only the values move.
      expect(on.laps.map((lap) => lap.samples.length)).toEqual(
        omitted.laps.map((lap) => lap.samples.length),
      );
      expect(on.usedChannels).toEqual(omitted.usedChannels);
      expect(on).not.toEqual(omitted);
      for (const lap of on.laps) {
        for (const sample of lap.samples) {
          const latG = sample.channels?.latG;
          const longG = sample.channels?.longG;
          if (latG !== undefined) expect(Number.isFinite(latG)).toBe(true);
          if (longG !== undefined) expect(Number.isFinite(longG)).toBe(true);
        }
      }
    });
  }
});

describe('P6a -- the runner reads the flag fresh and keys its memo by it', () => {
  function sourceFor(): AnalysisSessionSource {
    const { circuit } = allBundledCircuits()[0]!;
    const session = driveSession(circuit, { laps: 2, channels: 'full' });
    const recordings = session.recordings.map((recording, lapIndex) =>
      withGChannels(recording, 23 + lapIndex),
    );
    return {
      sessionId: 'p6a-session',
      circuit,
      displayDateUtc: '2026-09-21T09:15:00.000Z',
      recordings,
    };
  }

  it('flipping analysisSmoothingEnabled produces a genuinely different run, not the memoised one', async () => {
    const source = sourceFor();
    let smoothing = false;
    let loads = 0;
    const runner = createAnalysisRunner({
      loadSession: async () => {
        loads += 1;
        return source;
      },
      isSessionActive: () => false,
      analysisSmoothingEnabled: () => smoothing,
      yieldToUi: async () => undefined,
    });

    const off = await runner.run('p6a-session');
    const offAgain = await runner.run('p6a-session');
    expect(off.status).toBe('ready');
    expect(offAgain).toBe(off); // memoised
    expect(loads).toBe(1);

    smoothing = true;
    const on = await runner.run('p6a-session');
    expect(on.status).toBe('ready');
    expect(loads).toBe(2); // NOT served from the unsmoothed memo
    if (off.status !== 'ready' || on.status !== 'ready') throw new Error('unreachable');
    expect(on.assembled).not.toEqual(off.assembled);

    // ... and turning it back off returns the original, still-valid result.
    smoothing = false;
    expect(await runner.run('p6a-session')).toBe(off);
    expect(loads).toBe(2);
  });

  it('H2: flipping the flag DURING the load never files a smoothed result under the flags-off key', async () => {
    // Ticket P6a-FIX1 H2 (HIGH, Codex, reproduced with the real runner). The
    // interleaving: start a pass with smoothing OFF, turn it ON while the
    // session is still loading, let the pass finish, turn it OFF again. Before
    // the fix, `run()` picked the UNSUFFIXED key from the first read and
    // `compute()` picked SMOOTHED options from the second, so the flags-off
    // cache entry held smoothed data from then on.
    const source = sourceFor();
    let smoothing = false;
    let releaseLoad: () => void = () => undefined;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });

    const runner = createAnalysisRunner({
      loadSession: async () => {
        await loadGate; // the await the flag flip slips through
        return source;
      },
      isSessionActive: () => false,
      analysisSmoothingEnabled: () => smoothing,
      yieldToUi: async () => undefined,
    });

    const inFlight = runner.run('p6a-session'); // captured with smoothing FALSE
    smoothing = true; // flipped mid-load
    releaseLoad();
    const result = await inFlight;
    smoothing = false; // and back off again

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');

    // The pass was started as a flags-off pass, so it must BE a flags-off pass.
    const unsmoothed = assembleSessionAnalysis(source.circuit, source.recordings);
    expect(result.assembled).toEqual(unsmoothed);

    // ... and the flags-off cache entry it left behind is the unsmoothed one.
    const afterwards = runner.peek('p6a-session');
    expect(afterwards?.status).toBe('ready');
    if (afterwards?.status !== 'ready') throw new Error('unreachable');
    expect(afterwards.assembled).toEqual(unsmoothed);
    expect(await runner.run('p6a-session')).toBe(result);

    // The smoothed variant is genuinely different, so the assertions above are
    // not passing by coincidence.
    expect(
      assembleSessionAnalysis(source.circuit, source.recordings, { smoothGForceChannels: true }),
    ).not.toEqual(unsmoothed);
  });

  it('H2 mirror: flipping OFF during the load never files an unsmoothed result under the smoothed key', async () => {
    const source = sourceFor();
    let smoothing = true;
    let releaseLoad: () => void = () => undefined;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const runner = createAnalysisRunner({
      loadSession: async () => {
        await loadGate;
        return source;
      },
      isSessionActive: () => false,
      analysisSmoothingEnabled: () => smoothing,
      yieldToUi: async () => undefined,
    });

    const inFlight = runner.run('p6a-session'); // captured with smoothing TRUE
    smoothing = false;
    releaseLoad();
    const result = await inFlight;
    smoothing = true;

    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.assembled).toEqual(
      assembleSessionAnalysis(source.circuit, source.recordings, { smoothGForceChannels: true }),
    );
  });

  it('with no analysisSmoothingEnabled dep wired at all, the runner behaves exactly as before', async () => {
    const source = sourceFor();
    const runner = createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: () => false,
      yieldToUi: async () => undefined,
    });
    const first = await runner.run('p6a-session');
    expect(first.status).toBe('ready');
    expect(runner.peek('p6a-session')).toBe(first);
    runner.clear();
    expect(runner.peek('p6a-session')).toBeNull();
  });
});
