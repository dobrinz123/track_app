import { describe, expect, it } from 'vitest';

import { createBoundaryScheduler } from '../../src/session/stintCoaching';

/**
 * Ticket P5c-FIX1 E6 (Codex P5c-REV1 finding 6): a lap that completes while an
 * analysis pass is running must not lose its boundary.
 *
 * Before this, the caller advanced its "last handled" counter and then returned
 * early because a pass was in flight — so that boundary never ran at all. After
 * E1 that is worse than a missed analysis: the boundary is also where the
 * PREVIOUS pass's queued cue moves get applied, so dropping it strands them.
 */

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every already-queued microtask/`finally` chain run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('boundary scheduler (E6)', () => {
  it('runs one pass at a time', async () => {
    const gate = deferred();
    const started: number[] = [];
    const scheduler = createBoundaryScheduler({
      run: async (count) => {
        started.push(count);
        await gate.promise;
      },
    });

    scheduler.onBoundary(3);
    await settle();
    expect(started).toEqual([3]);
    expect(scheduler.busy()).toBe(true);

    scheduler.onBoundary(4);
    await settle();
    expect(started).toEqual([3]);
    expect(scheduler.pendingBoundary()).toBe(4);

    gate.resolve();
    await settle();
    expect(started).toEqual([3, 4]);
  });

  it('coalesces several missed boundaries into ONE follow-up pass, at the latest count', async () => {
    const gate = deferred();
    const started: number[] = [];
    const scheduler = createBoundaryScheduler({
      run: async (count) => {
        started.push(count);
        if (started.length === 1) await gate.promise;
      },
    });

    scheduler.onBoundary(3);
    await settle();
    scheduler.onBoundary(4);
    scheduler.onBoundary(5);
    scheduler.onBoundary(6);
    gate.resolve();
    await settle();
    await settle();
    // Not 4, 5 AND 6 -- one catch-up pass, for the newest boundary.
    expect(started).toEqual([3, 6]);
    expect(scheduler.pendingBoundary()).toBeNull();
  });

  it('does not re-run a boundary that is not newer than the one just finished', async () => {
    const gate = deferred();
    const started: number[] = [];
    const scheduler = createBoundaryScheduler({
      run: async (count) => {
        started.push(count);
        await gate.promise;
      },
    });
    scheduler.onBoundary(3);
    await settle();
    scheduler.onBoundary(3);
    gate.resolve();
    await settle();
    expect(started).toEqual([3]);
  });

  it('a failing pass still releases the scheduler and runs the retained boundary', async () => {
    const gate = deferred();
    const started: number[] = [];
    const errors: unknown[] = [];
    const scheduler = createBoundaryScheduler({
      run: async (count) => {
        started.push(count);
        if (started.length === 1) {
          await gate.promise;
          throw new Error('the pass blew up');
        }
      },
      onError: (error) => errors.push(error),
    });

    scheduler.onBoundary(2);
    await settle();
    scheduler.onBoundary(3);
    gate.resolve();
    await settle();
    await settle();
    expect(errors).toHaveLength(1);
    expect(started).toEqual([2, 3]);
    expect(scheduler.busy()).toBe(false);
  });

  it('forgets a retained boundary when the session ends', async () => {
    const gate = deferred();
    const started: number[] = [];
    const scheduler = createBoundaryScheduler({
      run: async (count) => {
        started.push(count);
        await gate.promise;
      },
    });
    scheduler.onBoundary(2);
    await settle();
    scheduler.onBoundary(3);
    scheduler.reset();
    gate.resolve();
    await settle();
    expect(started).toEqual([2]);
  });
});
