import { describe, expect, it, vi } from 'vitest';
import { createEnetAdapterReservation, type EnetAdapterOwner } from '../../src/session/enetAdapterReservation';

describe('enetAdapterReservation (P4e-FIX3 H2 / P4e-FIX4 token model, binding: single-client adapter reservation)', () => {
  it('tryAcquire succeeds when the adapter is free, returning a token, and holder() reflects it', () => {
    const reservation = createEnetAdapterReservation();
    expect(reservation.holder()).toBeNull();
    const token = reservation.tryAcquire('provider');
    expect(token).not.toBeNull();
    expect(reservation.holder()).toBe('provider');
  });

  /**
   * P4e-FIX4 HIGH fix (binding, Codex P4e-REV4): NO same-owner reacquire --
   * a second `tryAcquire` for the SAME owner while its own earlier token is
   * still held must fail (`null`), never silently succeed. This is the
   * exact generation-identity gap the review found: two overlapping
   * provider generations could otherwise both believe they held the
   * reservation.
   */
  it('a SECOND tryAcquire for the SAME owner is refused (null) while its own token is still held -- no same-owner reacquire', () => {
    const reservation = createEnetAdapterReservation();
    const first = reservation.tryAcquire('provider');
    expect(first).not.toBeNull();

    const second = reservation.tryAcquire('provider');
    expect(second).toBeNull();
    expect(reservation.holder()).toBe('provider'); // untouched by the refused second attempt.
  });

  /** "probe refused while provider polling" (ticket, binding) -- the provider holds the reservation for the whole polling lifecycle; the probe's tryAcquire must fail, never silently steal it. */
  it('tryAcquire for the OTHER owner fails while one owner holds it (exclusive), and does not change the holder', () => {
    const reservation = createEnetAdapterReservation();
    reservation.tryAcquire('provider');
    expect(reservation.tryAcquire('probe')).toBeNull();
    expect(reservation.holder()).toBe('provider'); // untouched by the failed attempt.
  });

  it('release(token) frees the reservation, letting either owner then acquire it again', () => {
    const reservation = createEnetAdapterReservation();
    const token = reservation.tryAcquire('provider');
    expect(reservation.tryAcquire('probe')).toBeNull();

    reservation.release(token!);
    expect(reservation.holder()).toBeNull();

    const probeToken = reservation.tryAcquire('probe');
    expect(probeToken).not.toBeNull();
    expect(reservation.holder()).toBe('probe');
  });

  /**
   * P4e-FIX4 (binding): "releasing with a stale token does not release the
   * current claim" -- a token from an ALREADY-SUPERSEDED acquisition (e.g.
   * an older generation that never got its own release call in before a
   * newer one acquired) must never clobber whichever claim is current now.
   */
  it('release() with a STALE token (from an earlier, already-released acquisition) is a harmless no-op -- never clobbers the CURRENT holder\'s claim', () => {
    const reservation = createEnetAdapterReservation();
    const staleToken = reservation.tryAcquire('provider');
    expect(staleToken).not.toBeNull();
    reservation.release(staleToken!);
    expect(reservation.holder()).toBeNull();

    // A different owner acquires a NEW token in the meantime.
    const currentToken = reservation.tryAcquire('probe');
    expect(currentToken).not.toBeNull();

    // The stale token (already spent) must not release the probe's current claim.
    reservation.release(staleToken!);
    expect(reservation.holder()).toBe('probe');
    expect(currentToken).not.toBe(staleToken);
  });

  it('release() on an already-free reservation is a harmless no-op for any token', () => {
    const reservation = createEnetAdapterReservation();
    const neverAcquiredToken = Symbol('never acquired');
    expect(() => reservation.release(neverAcquiredToken)).not.toThrow();
    expect(reservation.holder()).toBeNull();
  });

  it('subscribe() replays the current holder synchronously, and notifies on every change', () => {
    const reservation = createEnetAdapterReservation();
    const seen: Array<EnetAdapterOwner | null> = [];
    const unsubscribe = reservation.subscribe((holder) => seen.push(holder));
    expect(seen).toEqual([null]); // replayed immediately.

    const token = reservation.tryAcquire('provider');
    expect(seen).toEqual([null, 'provider']);

    reservation.release(token!);
    expect(seen).toEqual([null, 'provider', null]);

    unsubscribe();
    reservation.tryAcquire('probe');
    expect(seen).toEqual([null, 'provider', null]); // no further delivery after unsubscribe.
  });

  it('subscribe() does NOT notify for a refused same-owner reacquire attempt (no spurious change event)', () => {
    const reservation = createEnetAdapterReservation();
    reservation.tryAcquire('provider');
    const seen: Array<EnetAdapterOwner | null> = [];
    reservation.subscribe((holder) => seen.push(holder));
    expect(seen).toEqual(['provider']);

    reservation.tryAcquire('provider'); // refused -- no change.
    expect(seen).toEqual(['provider']);
  });

  /**
   * "reservation is exclusive under interleaving" (ticket, binding): a
   * sequence of interleaved acquire/release calls from both owners, using
   * their own returned tokens throughout, must never leave the reservation
   * held by both, or silently transferred without an explicit release.
   */
  it('is exclusive under an interleaved acquire/release sequence from both owners, tokens tracked throughout', () => {
    const reservation = createEnetAdapterReservation();

    const providerToken1 = reservation.tryAcquire('provider');
    expect(providerToken1).not.toBeNull();
    expect(reservation.tryAcquire('probe')).toBeNull(); // provider still holds it.
    expect(reservation.tryAcquire('provider')).toBeNull(); // no same-owner reacquire either.

    reservation.release(Symbol('probe never held it')); // no-op: a foreign/never-issued token.
    expect(reservation.holder()).toBe('provider');

    reservation.release(providerToken1!);
    expect(reservation.holder()).toBeNull();

    const probeToken = reservation.tryAcquire('probe');
    expect(probeToken).not.toBeNull();
    expect(reservation.tryAcquire('provider')).toBeNull(); // probe now holds it.

    reservation.release(probeToken!);
    expect(reservation.holder()).toBeNull();
  });

  it('two provider acquisitions in a row: the second is refused, and releasing with the SECOND (never-issued) attempt\'s null does not affect the first\'s real token', () => {
    const reservation = createEnetAdapterReservation();
    const firstToken = reservation.tryAcquire('provider');
    expect(firstToken).not.toBeNull();

    const secondToken = reservation.tryAcquire('provider');
    expect(secondToken).toBeNull();

    // The real (first) token still correctly releases the actual claim.
    reservation.release(firstToken!);
    expect(reservation.holder()).toBeNull();
  });

  /** ENET auto-discovery & DID sweep addendum (binding, Phase 4f): the two new owner kinds share this SAME exclusive reservation, mutually exclusive with every other owner (and each other). */
  it("'discovery' and 'sweep' are valid owners, mutually exclusive with 'provider'/'probe'/each other, same as any other owner pair", () => {
    const reservation = createEnetAdapterReservation();
    const discoveryToken = reservation.tryAcquire('discovery');
    expect(discoveryToken).not.toBeNull();
    expect(reservation.holder()).toBe('discovery');
    expect(reservation.tryAcquire('provider')).toBeNull();
    expect(reservation.tryAcquire('probe')).toBeNull();
    expect(reservation.tryAcquire('sweep')).toBeNull();

    reservation.release(discoveryToken!);
    const sweepToken = reservation.tryAcquire('sweep');
    expect(sweepToken).not.toBeNull();
    expect(reservation.holder()).toBe('sweep');
    expect(reservation.tryAcquire('discovery')).toBeNull();

    reservation.release(sweepToken!);
    expect(reservation.holder()).toBeNull();
  });

  /**
   * Ticket P4j-FIX2 V2 (binding, after Codex P4j-REV2 MEDIUM #2 "the screen's
   * unmount cleanup still fire-and-forgets stop()"): `whenFree()` is the
   * reservation-level primitive `didSweepController.ts`'s `start()`/
   * `resumePersistedRun()` await on a refused first `tryAcquire`, so a
   * REMOUNTED screen's fresh controller no longer transiently reports
   * "adapter in use" while a PRIOR instance's close-then-release is still in
   * flight -- "acquire after stop() resolves only after release."
   */
  describe('whenFree() (P4j-FIX2 V2, binding)', () => {
    it('resolves immediately when the reservation is already free', async () => {
      const reservation = createEnetAdapterReservation();
      let resolved = false;
      void reservation.whenFree().then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(true);
    });

    it('does NOT resolve while the reservation is still held -- only AFTER release() actually runs', async () => {
      const reservation = createEnetAdapterReservation();
      const token = reservation.tryAcquire('sweep');
      expect(token).not.toBeNull();

      let resolved = false;
      void reservation.whenFree().then(() => {
        resolved = true;
      });
      // Flush several microtask turns -- still held, so still NOT resolved
      // (the exact defect this proves is fixed: a caller must never see this
      // settle before the real release happens).
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(resolved).toBe(false);

      reservation.release(token!);
      await Promise.resolve();
      expect(resolved).toBe(true);
    });

    it('resolves EVERY outstanding waiter on the same release, and a fresh whenFree() after that release resolves immediately', async () => {
      const reservation = createEnetAdapterReservation();
      const token = reservation.tryAcquire('provider');
      expect(token).not.toBeNull();

      const seen: number[] = [];
      void reservation.whenFree().then(() => seen.push(1));
      void reservation.whenFree().then(() => seen.push(2));
      await Promise.resolve();
      expect(seen).toEqual([]);

      reservation.release(token!);
      await Promise.resolve();
      expect(seen.sort()).toEqual([1, 2]);

      let resolvedAfter = false;
      void reservation.whenFree().then(() => {
        resolvedAfter = true;
      });
      await Promise.resolve();
      expect(resolvedAfter).toBe(true);
    });

    it('a whenFree() waiter registered while held still resolves even if a DIFFERENT owner immediately reacquires after the release (the waiter only reports that ITS wait ended, never a false "still free")', async () => {
      const reservation = createEnetAdapterReservation();
      const token = reservation.tryAcquire('provider');
      let resolved = false;
      void reservation.whenFree().then(() => {
        resolved = true;
      });

      reservation.release(token!);
      reservation.tryAcquire('probe'); // immediately reacquired by someone else.
      await Promise.resolve();
      expect(resolved).toBe(true); // the WAIT ended -- a caller must re-check tryAcquire itself, exactly what start()/resumePersistedRun() do.
      expect(reservation.holder()).toBe('probe');
    });
  });

  it('createEnetAdapterReservation() returns a FRESH, independent instance each call (no shared state across instances)', () => {
    const a = createEnetAdapterReservation();
    const b = createEnetAdapterReservation();
    a.tryAcquire('provider');
    expect(a.holder()).toBe('provider');
    expect(b.holder()).toBeNull();
    expect(b.tryAcquire('probe')).not.toBeNull();
  });

  /**
   * P4e-FIX5 HIGH fix (binding, Codex P4e-REV5): a subscriber notification
   * must never affect state transitions. Before this fix, `tryAcquire`
   * called `notify()` unguarded AFTER committing `held` but BEFORE
   * returning the token -- a throwing subscriber propagated straight out of
   * `tryAcquire`, so the caller that legitimately just acquired the
   * reservation never received its own token (a permanent leak: nothing
   * left alive to ever release it).
   */
  it('a throwing subscriber during tryAcquire does not prevent the token from being returned, and holder() is still correct', () => {
    const reservation = createEnetAdapterReservation();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      reservation.subscribe(() => {
        throw new Error('boom: throwing subscriber (test double)');
      });

      let token: ReturnType<typeof reservation.tryAcquire> = null;
      expect(() => {
        token = reservation.tryAcquire('provider');
      }).not.toThrow();

      expect(token).not.toBeNull();
      expect(reservation.holder()).toBe('provider');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  /**
   * The `release()` counterpart of the same fix: a throwing subscriber
   * during `release` used to propagate before `held` visibly settled to
   * `null` for the CALLER's own subsequent logic (`telemetryProvider.ts`'s
   * `resolveStopping()` in its own `finally`, right after calling
   * `release`) -- deadlocking anything queued behind that. Proven here at
   * the reservation layer: `release()` never throws, `holder()` reads
   * `null` afterward, AND a subsequent `tryAcquire` (standing in for "a
   * later ENET start() proceeds") succeeds -- no deadlock.
   */
  it('release() with a throwing subscriber still clears the claim (holder() null), never throws, and a subsequent tryAcquire succeeds (no deadlock)', () => {
    const reservation = createEnetAdapterReservation();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const token = reservation.tryAcquire('provider');
      expect(token).not.toBeNull();

      reservation.subscribe(() => {
        throw new Error('boom: throwing subscriber on release (test double)');
      });

      expect(() => reservation.release(token!)).not.toThrow();
      expect(reservation.holder()).toBeNull();
      expect(warnSpy).toHaveBeenCalled();

      // Standing in for "a subsequent ENET start() proceeds" -- must
      // succeed, proving nothing is deadlocked by the earlier throw.
      const nextToken = reservation.tryAcquire('provider');
      expect(nextToken).not.toBeNull();
      expect(reservation.holder()).toBe('provider');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a throwing subscriber never prevents OTHER subscribers from being notified', () => {
    const reservation = createEnetAdapterReservation();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const seen: Array<EnetAdapterOwner | null> = [];
      reservation.subscribe(() => {
        throw new Error('boom (test double)');
      });
      reservation.subscribe((holder) => seen.push(holder));

      reservation.tryAcquire('provider');
      expect(seen).toEqual([null, 'provider']); // the well-behaved subscriber's initial replay + the change, both delivered.
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('subscribe()\'s own initial replay call does not throw (and still returns a working unsubscribe) when the callback itself throws', () => {
    const reservation = createEnetAdapterReservation();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let unsubscribe: (() => void) | undefined;
      expect(() => {
        unsubscribe = reservation.subscribe(() => {
          throw new Error('boom on initial replay (test double)');
        });
      }).not.toThrow();
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe!()).not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
