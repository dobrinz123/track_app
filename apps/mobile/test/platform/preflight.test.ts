import { describe, expect, it, vi } from 'vitest';

/**
 * Pins C11 (preflight collectors linger). `PreflightScreen` unmounting must
 * actually cancel the in-flight GNSS-fix collector's native location
 * subscription -- previously only a `cancelled` React-state-update guard
 * existed, which suppressed the resulting `setState` but left the native
 * `watchPositionAsync` watcher running until it either got a qualifying fix
 * or hit the full 30s timeout on its own.
 */

interface FakeSubscription {
  remove: ReturnType<typeof vi.fn>;
}

const watchCalls: Array<{ resolve: (sub: FakeSubscription) => void }> = [];

function resolveWatchCall(index: number): FakeSubscription {
  const call = watchCalls[index];
  if (call === undefined) throw new Error(`no pending watchPositionAsync call at index ${index}`);
  const sub: FakeSubscription = { remove: vi.fn() };
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
  hasServicesEnabledAsync: vi.fn(async () => true),
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted', canAskAgain: true })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted', canAskAgain: true })),
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
}));
// `expo-keep-awake`'s package `main` resolves to raw TypeScript source that
// pulls in expo-modules-core's native-module bridging -- unparseable/unusable
// under plain Node+vitest (same class of issue `composition.ts` documents for
// react-native's Flow-typed source). `preflight.ts` only needs `isAvailableAsync`.
vi.mock('expo-keep-awake', () => ({
  isAvailableAsync: vi.fn(async () => true),
}));

import { collectGnssFix } from '../../src/platform/preflight';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('collectGnssFix cancellation (C11 fix)', () => {
  it('aborting removes the native subscription immediately (well before the 30s timeout) once it has been established', async () => {
    watchCalls.length = 0;
    const controller = new AbortController();
    const timeoutMs = 30_000;
    const resultPromise = collectGnssFix(timeoutMs, 25, controller.signal);

    await flushMicrotasks();
    expect(watchCalls).toHaveLength(1);
    const sub = resolveWatchCall(0);
    await flushMicrotasks(); // let the subscription assignment land.
    expect(sub.remove).not.toHaveBeenCalled();

    controller.abort();

    const result = await resultPromise;
    expect(result).toEqual({ acquired: false, accuracyM: null });
    expect(sub.remove).toHaveBeenCalledTimes(1); // removed by the abort, not by a 30s timeout that never had to fire.
  });

  it('aborting before the native subscription is even established still removes it as soon as it resolves, and resolves the same way a timeout would', async () => {
    watchCalls.length = 0;
    const controller = new AbortController();
    const resultPromise = collectGnssFix(30_000, 25, controller.signal);

    // Abort before watchPositionAsync's own promise has resolved at all.
    controller.abort();
    const result = await resultPromise;
    expect(result).toEqual({ acquired: false, accuracyM: null });

    // The native call was still in flight -- once it resolves, the
    // now-already-cancelled collector must remove the subscription right
    // away instead of leaving it running.
    await flushMicrotasks();
    expect(watchCalls).toHaveLength(1);
    const sub = resolveWatchCall(0);
    await flushMicrotasks();
    expect(sub.remove).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal resolves immediately as acquired:false, without waiting for the timeout', async () => {
    watchCalls.length = 0;
    const controller = new AbortController();
    controller.abort();
    const result = await collectGnssFix(30_000, 25, controller.signal);
    expect(result).toEqual({ acquired: false, accuracyM: null });
  });
});
