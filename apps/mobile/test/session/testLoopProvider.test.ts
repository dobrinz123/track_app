import { describe, expect, it, vi } from 'vitest';
import type { LocationProvider, LocationSample } from '@circuit/core';

import { TestLoopLocationProvider } from '../../src/session/testLoopProvider';

/**
 * Ticket P5d-FIX2 N2 (Codex P5d-REV2 HIGH 2): the replay must not be able to
 * lose a fix. It drains the backlog INCREMENTALLY, survives a listener that
 * throws, keeps everything that arrives mid-drain in order behind it, and only
 * goes live once the backlog is genuinely empty.
 */

function upstream(): LocationProvider & { push(sample: LocationSample): void; stops: number } {
  const listeners = new Set<(sample: LocationSample) => void>();
  return {
    stops: 0,
    async start(): Promise<void> {},
    async stop(): Promise<void> {
      this.stops += 1;
    },
    subscribe(cb: (sample: LocationSample) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    push(sample: LocationSample): void {
      for (const listener of [...listeners]) listener(sample);
    },
  };
}

function fix(tMono: number): LocationSample {
  return { tMono, lat: 46.77 + tMono / 1e6, lon: 23.62, speedMps: 10, source: 'gnss' };
}

describe('TestLoopLocationProvider (P5d-FIX2 N2)', () => {
  it('replays the whole backlog in order, then goes live', async () => {
    const source = upstream();
    const learned: LocationSample[] = [];
    const provider = new TestLoopLocationProvider(source, (sample) => learned.push(sample));
    await provider.start();

    source.push(fix(1));
    source.push(fix(2));
    provider.beginHandover();
    source.push(fix(3));

    const delivered: LocationSample[] = [];
    provider.subscribe((sample) => delivered.push(sample));
    expect(delivered).toEqual([]);

    provider.flushBuffered();
    source.push(fix(4));

    expect(learned.map((sample) => sample.tMono)).toEqual([1, 2]);
    expect(delivered.map((sample) => sample.tMono)).toEqual([1, 2, 3, 4]);
    expect(provider.currentPhase()).toBe('live');
  });

  it('does not lose the tail when a listener throws mid-drain', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = upstream();
    const provider = new TestLoopLocationProvider(source, () => undefined);
    await provider.start();
    for (const tMono of [1, 2, 3, 4]) source.push(fix(tMono));
    provider.beginHandover();

    const delivered: number[] = [];
    provider.subscribe((sample) => {
      if (sample.tMono === 2) throw new Error('listener blew up');
      delivered.push(sample.tMono);
    });
    provider.flushBuffered();

    // Everything after the throwing fix still arrived, and the fix that threw
    // was not silently swallowed twice.
    expect(delivered).toEqual([1, 3, 4]);
    expect(provider.currentPhase()).toBe('live');
    warn.mockRestore();
  });

  it('keeps fixes that arrive DURING the drain behind the backlog, in order', async () => {
    const source = upstream();
    const provider = new TestLoopLocationProvider(source, () => undefined);
    await provider.start();
    for (const tMono of [1, 2]) source.push(fix(tMono));
    provider.beginHandover();

    const delivered: number[] = [];
    provider.subscribe((sample) => {
      delivered.push(sample.tMono);
      // A listener that pumps the event loop the way the real controller does:
      // a fix landing here must not overtake the rest of the backlog.
      if (sample.tMono === 1) source.push(fix(99));
    });
    provider.flushBuffered();

    expect(delivered).toEqual([1, 2, 99]);
    expect(provider.currentPhase()).toBe('live');
  });
});
