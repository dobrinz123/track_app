import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pins C3 (GNSS start/stop races). `GnssLocationProvider.start()`/`stop()`
 * are not safe while a `start()` is still pending -- before the fix, two
 * overlapping `start()` calls could both observe `this.subscription === null`
 * and both create a native watcher (only one of which stays reachable to
 * `stop()` later), and a `stop()` landing mid-`start()` was a no-op because
 * `this.subscription` hadn't been assigned yet.
 *
 * `expo-location`'s `watchPositionAsync` is mocked with a controllable,
 * manually-resolved promise per call so this test can assert exactly how
 * many native watchers were created and removed at each point in an
 * interleaved start/start/stop/start sequence.
 */

interface FakeSubscription {
  remove: ReturnType<typeof vi.fn>;
}

interface PendingWatchCall {
  resolve: (sub: FakeSubscription) => void;
}

const watchCalls: PendingWatchCall[] = [];
const createdSubscriptions: FakeSubscription[] = [];

function makeSubscription(): FakeSubscription {
  const sub: FakeSubscription = { remove: vi.fn() };
  createdSubscriptions.push(sub);
  return sub;
}

/** Resolves the Nth (0-indexed) pending `watchPositionAsync` call with a fresh subscription and returns it. */
function resolveWatchCall(index: number): FakeSubscription {
  const call = watchCalls[index];
  if (call === undefined) throw new Error(`no pending watchPositionAsync call at index ${index}`);
  const sub = makeSubscription();
  call.resolve(sub);
  return sub;
}

vi.mock('expo-location', () => ({
  LocationAccuracy: { BestForNavigation: 6 },
  watchPositionAsync: vi.fn(
    () =>
      new Promise<FakeSubscription>((resolve) => {
        watchCalls.push({ resolve });
      }),
  ),
}));

vi.mock('../../src/platform/permissions', () => ({
  getPermissionState: vi.fn(async () => ({ state: 'granted' as const, canAskAgain: true })),
}));

import { GnssLocationProvider } from '../../src/platform/gnssLocationProvider';

/** Flushes pending microtasks (permission lookup + promise chaining) without resolving the controlled `watchPositionAsync` promise itself. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  watchCalls.length = 0;
  createdSubscriptions.length = 0;
});

describe('GnssLocationProvider start/stop serialization (C3 fix)', () => {
  it('an interleaved start/start/stop/start storm never creates two live watchers, and settles with exactly one active', async () => {
    const provider = new GnssLocationProvider();

    // start() #1, start() #2 (queued behind #1), stop() (queued behind #2),
    // start() #3 (queued behind stop) -- all issued back-to-back, synchronously,
    // exactly like a rapid watchdog restart racing a double calibration start.
    const p1 = provider.start();
    const p2 = provider.start();
    const p3 = provider.stop();
    const p4 = provider.start();

    // Let start() #1's permission lookup resolve and reach watchPositionAsync.
    // start() #2 is chained strictly behind #1 in the `op` queue, so it
    // cannot have called watchPositionAsync yet at this point either way --
    // this only confirms #1 itself got there.
    await flushMicrotasks();
    expect(watchCalls).toHaveLength(1);

    const sub1 = resolveWatchCall(0);
    // One flush now drains the ENTIRE synchronous remainder of the chain
    // that #1 unblocks: start() #2 (no-op -- subscription already set by
    // #1, so it never calls watchPositionAsync again), stop() (removes the
    // one real watcher #1 created), and start() #3 (creates a fresh one,
    // since subscription is null again after stop()) up to ITS OWN
    // watchPositionAsync call, where it pauses.
    await flushMicrotasks();
    expect(watchCalls).toHaveLength(2); // exactly 2 real watcher-creation attempts across the whole storm, never 3.
    expect(sub1.remove).toHaveBeenCalledTimes(1); // removed by the queued stop() -- proves it awaited the start rather than no-op'ing.

    const sub2 = resolveWatchCall(1);
    await Promise.all([p1, p2, p3, p4]);

    expect(sub2.remove).not.toHaveBeenCalled(); // the final start() left exactly one active watcher.
    expect(watchCalls).toHaveLength(2); // still exactly 2 -- two live watchers never coexisted at any point.
  });

  it('a stop() that lands while start() is still pending awaits the start, then removes the watcher it just created -- zero watchers remain', async () => {
    const provider = new GnssLocationProvider();

    const startPromise = provider.start();
    const stopPromise = provider.stop(); // issued before start()'s watchPositionAsync has even resolved.

    await flushMicrotasks();
    expect(watchCalls).toHaveLength(1);
    const sub = resolveWatchCall(0);

    await startPromise;
    await stopPromise;

    expect(sub.remove).toHaveBeenCalledTimes(1);

    // A subsequent start() must create a brand new watcher (proves the
    // provider genuinely ended at zero active watchers, not just "didn't
    // double-create").
    watchCalls.length = 0;
    const nextStart = provider.start();
    await flushMicrotasks();
    expect(watchCalls).toHaveLength(1);
    resolveWatchCall(0);
    await nextStart;
  });
});
