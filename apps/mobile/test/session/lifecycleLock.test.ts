import { describe, expect, it } from 'vitest';
import { LifecycleLockReentry, createLifecycleLock } from '../../src/session/lifecycleLock';

/**
 * ticket CN-FIX3 (N7 (f)) -- unit tests for the ONE ordering boundary
 * contracts.md's "lifecycle lock amendment" makes binding: FIFO ordering, a
 * re-entrant `run()` from inside a held section throwing
 * `LifecycleLockReentry` (instead of silently self-deadlocking), and a
 * rejected section releasing the lock for whatever queued behind it.
 */
describe('lifecycleLock (ticket CN-FIX3)', () => {
  it('runs queued sections FIFO -- never overlapping, always in call order', async () => {
    const lock = createLifecycleLock();
    const events: string[] = [];
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    // The FIRST call is deliberately the SLOWEST -- without real mutual
    // exclusion its tail would land last.
    const a = lock.run(async () => {
      events.push('a:start');
      await delay(20);
      events.push('a:end');
    });
    const b = lock.run(async () => {
      events.push('b:start');
      await delay(1);
      events.push('b:end');
    });
    const c = lock.run(async () => {
      events.push('c:start');
      events.push('c:end');
    });

    await Promise.all([a, b, c]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a section that calls run() again re-entrantly is REFUSED with LifecycleLockReentry (never a silent self-deadlock)', async () => {
    const lock = createLifecycleLock();
    let inner: unknown = null;
    await lock.run(async () => {
      inner = await lock.run(async () => 'nested').then(
        () => 'resolved',
        (error: unknown) => error,
      );
    });
    expect(inner).toBeInstanceOf(LifecycleLockReentry);
    // The lock is NOT wedged by the refusal -- the next section still runs.
    await expect(lock.run(async () => 'after')).resolves.toBe('after');
  });

  it('a rejected section propagates its error AND releases the lock for the next queued section', async () => {
    const lock = createLifecycleLock();
    const order: string[] = [];
    const failing = lock.run(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const next = lock.run(async () => {
      order.push('next');
      return 42;
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe(42);
    expect(order).toEqual(['failing', 'next']);
    expect(lock.isHeld()).toBe(false);
  });

  it('a section that throws SYNCHRONOUSLY (before its first await) still releases the lock', async () => {
    const lock = createLifecycleLock();
    const thrown = lock.run((): Promise<void> => {
      throw new Error('sync-boom');
    });
    await expect(thrown).rejects.toThrow('sync-boom');
    expect(lock.isHeld()).toBe(false);
    await expect(lock.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('isHeld() reports the section boundary -- held across the section\'s awaits, released after it settles', async () => {
    const lock = createLifecycleLock();
    expect(lock.isHeld()).toBe(false);
    let heldDuringAwait: boolean | null = null;
    await lock.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      heldDuringAwait = lock.isHeld();
    });
    expect(heldDuringAwait).toBe(true);
    expect(lock.isHeld()).toBe(false);
  });
});
