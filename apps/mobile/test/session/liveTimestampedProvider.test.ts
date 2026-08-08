import { describe, expect, it } from 'vitest';
import type { LocationProvider, LocationSample } from '@circuit/core';
import { LiveTimestampedLocationProvider } from '../../src/session/liveTimestampedProvider';
import { FakeClock } from '../support/coreTestDoubles';

/**
 * A `LocationProvider` test double that only emits while "active" -- unlike
 * core's `FakeLocationProvider` (which ignores start/stop entirely), this
 * models a real provider that genuinely ceases emission once stopped, which
 * is exactly the behavior under test in the `stop()` case below.
 */
class ScriptedProvider implements LocationProvider {
  private readonly listeners = new Set<(s: LocationSample) => void>();
  active = false;

  async start(): Promise<void> {
    this.active = true;
  }

  async stop(): Promise<void> {
    this.active = false;
  }

  subscribe(cb: (s: LocationSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Delivers a sample to subscribers only while active. */
  deliver(sample: LocationSample): void {
    if (!this.active) return;
    for (const listener of this.listeners) listener(sample);
  }
}

function sample(tMono: number, extra: Partial<LocationSample> = {}): LocationSample {
  return { tMono, lat: 46.435, lon: 25.06, source: 'replay', ...extra };
}

describe('LiveTimestampedLocationProvider', () => {
  it('re-stamps tMono to the clock reading at delivery time, discarding the inner tMono, in delivery order', async () => {
    const inner = new ScriptedProvider();
    const clock = new FakeClock(500_000);
    const wrapper = new LiveTimestampedLocationProvider(inner, clock);
    await wrapper.start();

    const received: LocationSample[] = [];
    wrapper.subscribe((s) => received.push(s));

    // Inner tMono values (10, 20, 15) are small, fixture-relative, and even
    // non-monotonic -- none of that may leak through; only the clock reading
    // at delivery time matters.
    clock.set(500_100);
    inner.deliver(sample(10));
    clock.set(500_250);
    inner.deliver(sample(20));
    clock.set(500_400);
    inner.deliver(sample(15));

    expect(received.map((s) => s.tMono)).toEqual([500_100, 500_250, 500_400]);
    for (let i = 1; i < received.length; i += 1) {
      expect(received[i]!.tMono).toBeGreaterThan(received[i - 1]!.tMono);
    }
  });

  it('preserves every other sample field unchanged', async () => {
    const inner = new ScriptedProvider();
    const clock = new FakeClock(0);
    const wrapper = new LiveTimestampedLocationProvider(inner, clock);
    await wrapper.start();

    const received: LocationSample[] = [];
    wrapper.subscribe((s) => received.push(s));
    inner.deliver(sample(1, { accuracyM: 3, speedMps: 12, headingDeg: 90 }));

    expect(received[0]).toMatchObject({ lat: 46.435, lon: 25.06, accuracyM: 3, speedMps: 12, headingDeg: 90, source: 'replay' });
  });

  it('stop() delegates to the inner provider and ceases emission', async () => {
    const inner = new ScriptedProvider();
    const clock = new FakeClock(0);
    const wrapper = new LiveTimestampedLocationProvider(inner, clock);
    await wrapper.start();
    expect(inner.active).toBe(true);

    const received: LocationSample[] = [];
    wrapper.subscribe((s) => received.push(s));
    inner.deliver(sample(1));
    expect(received).toHaveLength(1);

    await wrapper.stop();
    expect(inner.active).toBe(false);

    inner.deliver(sample(2)); // inner is stopped -- must be a no-op
    expect(received).toHaveLength(1);
  });

  it("subscribe()'s unsubscribe stops only that listener", async () => {
    const inner = new ScriptedProvider();
    const clock = new FakeClock(0);
    const wrapper = new LiveTimestampedLocationProvider(inner, clock);
    await wrapper.start();

    const a: LocationSample[] = [];
    const b: LocationSample[] = [];
    const unsubscribeA = wrapper.subscribe((s) => a.push(s));
    wrapper.subscribe((s) => b.push(s));

    inner.deliver(sample(1));
    unsubscribeA();
    inner.deliver(sample(2));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });
});
