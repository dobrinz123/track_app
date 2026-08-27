/**
 * ENET telemetry addendum -- adapter reservation (P4e-FIX3 H2, binding,
 * Codex P4e-REV3; token model added P4e-FIX4, binding, Codex P4e-REV4): the
 * MHD ENET adapter accepts exactly ONE ECU client at a time. Before this
 * module, `telemetryProvider`'s polling session and the dev DID-probe screen
 * each opened their own `EnetTcpTransport`/`SimulatedEnetTransport`
 * independently, gated only by UI-level state checks (`evaluateDidProbeGating`,
 * `didProbe.ts`) that have a race window: the review's exact scenario -- the
 * provider reaches `'failed'`, the probe is then allowed in (state is
 * `'failed'`, one of the gating's own allowed states) and acquires the
 * adapter, and the provider's OWN scheduled retry fires moments later and
 * opens a SECOND client on the same adapter.
 *
 * This module is the single, atomic arbiter: whichever of `'provider'`/
 * `'probe'` calls `tryAcquire` first holds the adapter until its OWN opaque
 * token is passed to `release`. `telemetryProvider.ts`'s `start()` AND its
 * scheduled retry both call `tryAcquire('provider')` immediately before
 * opening any ENET socket (never for the unrelated ELM327 path); the dev
 * probe (`DidProbeScreen.tsx`) calls `tryAcquire('probe')` immediately
 * before opening its own one-shot transport and releases its token as soon
 * as that one request's socket closes.
 *
 * P4e-FIX4 fix (binding, Codex P4e-REV4 HIGH finding): `tryAcquire` used to
 * return a bare `boolean`, treating a SECOND acquire by the SAME owner
 * (e.g. a new provider generation started while an older one from the same
 * owner has not yet released) as automatic success -- there was no way to
 * tell "the caller that already held it is re-entering" apart from "a
 * DIFFERENT instance of the same owner kind now also holds it", so two
 * overlapping provider generations could each believe they held the
 * reservation. Fixed by generation IDENTITY: `tryAcquire` now returns an
 * opaque `EnetAdapterToken` (or `null` when ANYONE holds it, including the
 * SAME owner -- no same-owner reacquire), and `release` takes that SAME
 * token, releasing only if it is still the CURRENT holder's token (a stale
 * token from an already-superseded acquisition is a harmless no-op, same as
 * before). Each caller must therefore track its OWN token per
 * generation/request rather than merely its owner kind.
 *
 * Pure module, single-process in-memory state (JS has no real concurrency
 * within one runtime -- "exclusive under interleaving" means correct
 * ordering across async call sequences, not a cross-process lock). No
 * react-native, no react import -- directly importable by vitest.
 */

export type EnetAdapterOwner = 'provider' | 'probe';

/** Opaque -- callers must not construct one, only store what `tryAcquire` returns and pass it back to `release`. */
export type EnetAdapterToken = symbol;

interface HeldReservation {
  owner: EnetAdapterOwner;
  token: EnetAdapterToken;
}

export interface EnetAdapterReservation {
  /**
   * Attempts to acquire the adapter for `owner`. Succeeds -- returns a
   * fresh, unique `EnetAdapterToken` -- ONLY when nobody currently holds
   * it. Fails -- returns `null`, the reservation is untouched -- whenever
   * ANYONE holds it already, including `owner` itself (no same-owner
   * reacquire: a caller that still holds an earlier token must `release`
   * it first, then acquire again, to get a fresh one).
   */
  tryAcquire(owner: EnetAdapterOwner): EnetAdapterToken | null;
  /** Releases the reservation ONLY if `token` is still the CURRENT holder's token. A no-op (never touches a different/newer holder's claim) for a stale or already-released token -- safe to call unconditionally on teardown. */
  release(token: EnetAdapterToken): void;
  /** The current holder, or `null` if the adapter is free. */
  holder(): EnetAdapterOwner | null;
  /** Subscribes to holder changes; replays the current holder synchronously on subscribe (same "replay on subscribe" convention as `telemetryProvider.ts`'s own `onStateChange`). */
  subscribe(cb: (holder: EnetAdapterOwner | null) => void): () => void;
}

/**
 * Factory (not a bare module-singleton export) so tests can construct a
 * FRESH, isolated reservation per test -- avoiding cross-test state leakage
 * that a single shared module-level instance would cause across a test
 * file's many `it()` blocks. Production wiring uses the ONE shared instance
 * below (`enetAdapterReservation`), imported directly by both
 * `telemetryProvider.ts` (as `TelemetryProviderDeps`'s default) and
 * `DidProbeScreen.tsx` -- ES modules are cached per resolved path, so both
 * consumers importing this same module get the identical singleton at
 * runtime without any change to `composition.ts`.
 */
export function createEnetAdapterReservation(): EnetAdapterReservation {
  let held: HeldReservation | null = null;
  const listeners = new Set<(holder: EnetAdapterOwner | null) => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener(held?.owner ?? null);
  }

  return {
    tryAcquire(owner: EnetAdapterOwner): EnetAdapterToken | null {
      if (held !== null) return null; // ANYONE holding it (including this same owner) blocks a new acquire.
      const token: EnetAdapterToken = Symbol(owner);
      held = { owner, token };
      notify();
      return token;
    },
    release(token: EnetAdapterToken): void {
      if (held === null || held.token !== token) return; // stale/foreign token -- never touches a newer holder's claim.
      held = null;
      notify();
    },
    holder(): EnetAdapterOwner | null {
      return held?.owner ?? null;
    },
    subscribe(cb: (holder: EnetAdapterOwner | null) => void): () => void {
      listeners.add(cb);
      cb(held?.owner ?? null);
      return () => listeners.delete(cb);
    },
  };
}

/** The ONE production reservation shared by `telemetryProvider.ts` and `DidProbeScreen.tsx`. */
export const enetAdapterReservation: EnetAdapterReservation = createEnetAdapterReservation();
