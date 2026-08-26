import { describe, expect, it } from 'vitest';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';

describe('enetAdapterReservation (P4e-FIX3 H2, binding: single-client adapter reservation)', () => {
  it('tryAcquire succeeds when the adapter is free, and holder() reflects it', () => {
    const reservation = createEnetAdapterReservation();
    expect(reservation.holder()).toBeNull();
    expect(reservation.tryAcquire('provider')).toBe(true);
    expect(reservation.holder()).toBe('provider');
  });

  it('tryAcquire is idempotent for the SAME owner already holding it', () => {
    const reservation = createEnetAdapterReservation();
    expect(reservation.tryAcquire('provider')).toBe(true);
    expect(reservation.tryAcquire('provider')).toBe(true);
    expect(reservation.holder()).toBe('provider');
  });

  /** "probe refused while provider polling" (ticket, binding) -- the provider holds the reservation for the whole polling lifecycle; the probe's tryAcquire must fail, never silently steal it. */
  it('tryAcquire for the OTHER owner fails while one owner holds it (exclusive), and does not change the holder', () => {
    const reservation = createEnetAdapterReservation();
    expect(reservation.tryAcquire('provider')).toBe(true);
    expect(reservation.tryAcquire('probe')).toBe(false);
    expect(reservation.holder()).toBe('provider'); // untouched by the failed attempt.
  });

  it('release() frees the reservation, letting the other owner then acquire it', () => {
    const reservation = createEnetAdapterReservation();
    expect(reservation.tryAcquire('provider')).toBe(true);
    expect(reservation.tryAcquire('probe')).toBe(false);

    reservation.release('provider');
    expect(reservation.holder()).toBeNull();

    expect(reservation.tryAcquire('probe')).toBe(true);
    expect(reservation.holder()).toBe('probe');
  });

  it('release() by the owner that does NOT hold it is a harmless no-op (never clobbers the other owner\'s hold)', () => {
    const reservation = createEnetAdapterReservation();
    expect(reservation.tryAcquire('provider')).toBe(true);

    reservation.release('probe'); // probe never held it.
    expect(reservation.holder()).toBe('provider'); // provider's hold survives.
  });

  it('release() on an already-free reservation is a harmless no-op', () => {
    const reservation = createEnetAdapterReservation();
    expect(() => reservation.release('provider')).not.toThrow();
    expect(reservation.holder()).toBeNull();
  });

  it('subscribe() replays the current holder synchronously, and notifies on every change', () => {
    const reservation = createEnetAdapterReservation();
    const seen: Array<'provider' | 'probe' | null> = [];
    const unsubscribe = reservation.subscribe((holder) => seen.push(holder));
    expect(seen).toEqual([null]); // replayed immediately.

    reservation.tryAcquire('provider');
    expect(seen).toEqual([null, 'provider']);

    reservation.release('provider');
    expect(seen).toEqual([null, 'provider', null]);

    unsubscribe();
    reservation.tryAcquire('probe');
    expect(seen).toEqual([null, 'provider', null]); // no further delivery after unsubscribe.
  });

  it('subscribe() does NOT notify for an idempotent re-acquire by the same owner (no spurious change event)', () => {
    const reservation = createEnetAdapterReservation();
    reservation.tryAcquire('provider');
    const seen: Array<'provider' | 'probe' | null> = [];
    reservation.subscribe((holder) => seen.push(holder));
    expect(seen).toEqual(['provider']);

    reservation.tryAcquire('provider'); // already holds it -- no change.
    expect(seen).toEqual(['provider']);
  });

  /**
   * "reservation is exclusive under interleaving" (ticket, binding): a
   * sequence of interleaved acquire/release calls from both owners must
   * never leave the reservation held by both, or silently transferred
   * without an explicit release.
   */
  it('is exclusive under an interleaved acquire/release sequence from both owners', () => {
    const reservation = createEnetAdapterReservation();

    expect(reservation.tryAcquire('provider')).toBe(true);
    expect(reservation.tryAcquire('probe')).toBe(false); // provider still holds it.
    expect(reservation.tryAcquire('provider')).toBe(true); // idempotent.

    reservation.release('probe'); // no-op: probe never held it.
    expect(reservation.holder()).toBe('provider');

    reservation.release('provider');
    expect(reservation.holder()).toBeNull();

    expect(reservation.tryAcquire('probe')).toBe(true);
    expect(reservation.tryAcquire('provider')).toBe(false); // probe now holds it.

    reservation.release('probe');
    expect(reservation.holder()).toBeNull();
  });

  it('createEnetAdapterReservation() returns a FRESH, independent instance each call (no shared state across instances)', () => {
    const a = createEnetAdapterReservation();
    const b = createEnetAdapterReservation();
    a.tryAcquire('provider');
    expect(a.holder()).toBe('provider');
    expect(b.holder()).toBeNull();
    expect(b.tryAcquire('probe')).toBe(true);
  });
});
