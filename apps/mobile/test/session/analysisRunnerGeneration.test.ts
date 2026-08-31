import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@circuit/core';

import {
  createAnalysisController,
  createAnalysisRunner,
  sessionIsActive,
  type AnalysisRunResult,
  type AnalysisSessionSource,
} from '../../src/session/analysisViewModel';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5-FIX2 W1 (Codex P5-REV finding 12, HIGH): the runner's promises are
 * GENERATION-SCOPED. A run that a session-state change supersedes -- a session
 * starting, and equally a session ending while the run was already under way --
 * is invalidated: it is never rejoined by a later `run()`, its result is never
 * published and never cached, and the next eligible view starts a FRESH pass.
 *
 * The bug this pins: the controller bumped its own generation on
 * `active -> inactive`, then called `runner.run()`, which handed back the very
 * promise of the superseded run (`inFlight` was keyed by session id alone), so
 * a result computed across a session boundary could be published and memoised.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(check: () => boolean, turns = 80): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (check()) return;
    await flush();
  }
}

function sourceFor(laps: number): AnalysisSessionSource {
  const { circuit } = allBundledCircuits()[0]!;
  const session = driveSession(circuit, { laps, channels: 'full' });
  return {
    sessionId: 'session-under-test',
    circuit,
    displayDateUtc: '2026-08-29T09:15:00.000Z',
    recordings: session.recordings,
  };
}

function fakeFacade(initial: SessionState = 'idle') {
  const listeners = new Set<(state: SessionState) => void>();
  let current = initial;
  return {
    isActive: (): boolean => sessionIsActive(current),
    set(next: SessionState): void {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe(cb: (state: SessionState) => void): () => void {
      listeners.add(cb);
      cb(current);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('P5-FIX2 W1 -- generation-scoped runner promises', () => {
  it('never hands a superseded in-flight run to a later caller', async () => {
    const first = sourceFor(2);
    const second = sourceFor(4);
    const gate = deferred<AnalysisSessionSource>();
    let call = 0;
    const loadSession = vi.fn(async () => {
      call += 1;
      return call === 1 ? await gate.promise : second;
    });
    const runner = createAnalysisRunner({ loadSession, isSessionActive: () => false });

    const superseded = runner.run(first.sessionId);
    runner.invalidate();
    const fresh = runner.run(first.sessionId);
    expect(loadSession).toHaveBeenCalledTimes(2);
    expect(fresh).not.toBe(superseded);

    gate.resolve(first);
    const freshResult = await fresh;
    expect(freshResult.status).toBe('ready');
    // The fresh run analysed the SECOND load -- the superseded work never
    // reached the caller that started after the invalidation.
    expect(freshResult.status === 'ready' && freshResult.insights.lapCount).toBe(4);
    expect((await superseded).status).toBe('superseded');
  });

  it('never caches a superseded run, so the next view starts fresh', async () => {
    const source = sourceFor(2);
    const gate = deferred<AnalysisSessionSource>();
    const loadSession = vi.fn(() => gate.promise);
    const runner = createAnalysisRunner({ loadSession, isSessionActive: () => false });

    const run = runner.run(source.sessionId);
    runner.invalidate();
    gate.resolve(source);
    expect((await run).status).toBe('superseded');
    expect(runner.peek(source.sessionId)).toBeNull();
  });

  it('stops the chunked pass at the first yield after the run is superseded', async () => {
    const source = sourceFor(6);
    let yields = 0;
    let yieldsAfterInvalidation: number | null = null;
    const runner = createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: () => false,
      yieldToUi: async () => {
        yields += 1;
        if (yields === 2) {
          runner.invalidate();
          yieldsAfterInvalidation = 0;
        } else if (yieldsAfterInvalidation !== null) {
          yieldsAfterInvalidation += 1;
        }
      },
    });

    const result = await runner.run(source.sessionId);
    expect(result.status).toBe('superseded');
    // The epoch is checked at every chunk yield, so the pass stops there rather
    // than projecting the remaining laps first.
    expect(yieldsAfterInvalidation).toBeLessThanOrEqual(1);
  });

  it('aborts the pass at the first yield after a session starts mid-run', async () => {
    const source = sourceFor(6);
    const facade = fakeFacade('idle');
    let yields = 0;
    let yieldsAfterStart: number | null = null;
    const runner = createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: facade.isActive,
      yieldToUi: async () => {
        yields += 1;
        if (yields === 2) {
          facade.set('timing');
          yieldsAfterStart = 0;
        } else if (yieldsAfterStart !== null) {
          yieldsAfterStart += 1;
        }
      },
    });

    const result = await runner.run(source.sessionId);
    expect(result.status === 'unavailable' && result.reason).toBe('session-active');
    expect(yieldsAfterStart).toBeLessThanOrEqual(1);
  });
});

describe('P5-FIX2 W1 -- the controller invalidates on every state change', () => {
  it('publishes a fresh run after active -> inactive, never the superseded one', async () => {
    const stale = sourceFor(2);
    const current = sourceFor(4);
    const gate = deferred<AnalysisSessionSource>();
    let call = 0;
    const loadSession = vi.fn(async () => {
      call += 1;
      return call === 1 ? await gate.promise : current;
    });
    const runner = createAnalysisRunner({ loadSession, isSessionActive: () => false });
    const facade = fakeFacade('idle');
    const controller = createAnalysisController({
      runner,
      sessionId: stale.sessionId,
      subscribeSessionState: facade.subscribe,
    });
    const seen: (AnalysisRunResult | null)[] = [];
    controller.subscribe((result) => seen.push(result));

    // A session starts and ends while the first run is still loading.
    facade.set('timing');
    facade.set('sessionComplete');
    gate.resolve(stale);

    await settle(() => seen.at(-1)?.status === 'ready');
    const last = seen.at(-1);
    expect(last?.status).toBe('ready');
    expect(last?.status === 'ready' && last.insights.lapCount).toBe(4);
    expect(loadSession).toHaveBeenCalledTimes(2);
    // Nothing computed across the session boundary was ever published.
    expect(seen.some((entry) => entry?.status === 'ready' && entry.insights.lapCount === 2)).toBe(
      false,
    );
    controller.dispose();
  });

  it('leaves the cache empty for a run the session boundary invalidated', async () => {
    const source = sourceFor(2);
    const gate = deferred<AnalysisSessionSource>();
    const runner = createAnalysisRunner({
      loadSession: () => gate.promise,
      isSessionActive: () => false,
    });
    const facade = fakeFacade('idle');
    const controller = createAnalysisController({
      runner,
      sessionId: source.sessionId,
      subscribeSessionState: facade.subscribe,
    });
    controller.subscribe(() => undefined);
    facade.set('timing');
    gate.resolve(source);
    await flush();
    await flush();
    expect(runner.peek(source.sessionId)).toBeNull();
    controller.dispose();
  });
});
