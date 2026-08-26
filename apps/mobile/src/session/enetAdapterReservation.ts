/**
 * ENET telemetry addendum -- adapter reservation (P4e-FIX3 H2, binding,
 * Codex P4e-REV3): the MHD ENET adapter accepts exactly ONE ECU client at a
 * time. Before this module, `telemetryProvider`'s polling session and the
 * dev DID-probe screen each opened their own `EnetTcpTransport`/
 * `SimulatedEnetTransport` independently, gated only by UI-level state
 * checks (`evaluateDidProbeGating`, `didProbe.ts`) that have a race window:
 * the review's exact scenario -- the provider reaches `'failed'`, the probe
 * is then allowed in (state is `'failed'`, one of the gating's own allowed
 * states) and acquires the adapter, and the provider's OWN scheduled retry
 * fires moments later and opens a SECOND client on the same adapter.
 *
 * This module is the single, atomic arbiter: whichever of `'provider'`/
 * `'probe'` calls `tryAcquire` first holds the adapter until it calls
 * `release` (or the other owner's release, which is a no-op -- an owner can
 * only ever release its OWN hold). `telemetryProvider.ts`'s `start()` AND
 * its scheduled retry both call `tryAcquire('provider')` immediately before
 * opening any ENET socket (never for the unrelated ELM327 path); the dev
 * probe (`DidProbeScreen.tsx`) calls `tryAcquire('probe')` immediately
 * before opening its own one-shot transport and `release('probe')` as soon
 * as that one request's socket closes.
 *
 * Pure module, single-process in-memory state (JS has no real concurrency
 * within one runtime -- "exclusive under interleaving" means correct
 * ordering across async call sequences, not a cross-process lock). No
 * react-native, no react import -- directly importable by vitest.
 */

export type EnetAdapterOwner = 'provider' | 'probe';

export interface EnetAdapterReservation {
  /**
   * Attempts to acquire the adapter for `owner`. Succeeds (returns `true`)
   * when nobody holds it, OR when `owner` ALREADY holds it (idempotent
   * re-entry for the same owner -- e.g. a provider retry re-acquiring after
   * its own earlier successful acquire was never released). Fails (returns
   * `false`, the reservation is untouched) when the OTHER owner holds it.
   */
  tryAcquire(owner: EnetAdapterOwner): boolean;
  /** Releases `owner`'s hold, if it currently holds the reservation. A no-op (never touches the other owner's hold) if `owner` does not currently hold it -- safe to call unconditionally on teardown. */
  release(owner: EnetAdapterOwner): void;
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
  let current: EnetAdapterOwner | null = null;
  const listeners = new Set<(holder: EnetAdapterOwner | null) => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener(current);
  }

  return {
    tryAcquire(owner: EnetAdapterOwner): boolean {
      if (current !== null && current !== owner) return false;
      if (current === owner) return true; // idempotent re-entry -- nothing changed, no spurious notify.
      current = owner;
      notify();
      return true;
    },
    release(owner: EnetAdapterOwner): void {
      if (current !== owner) return;
      current = null;
      notify();
    },
    holder(): EnetAdapterOwner | null {
      return current;
    },
    subscribe(cb: (holder: EnetAdapterOwner | null) => void): () => void {
      listeners.add(cb);
      cb(current);
      return () => listeners.delete(cb);
    },
  };
}

/** The ONE production reservation shared by `telemetryProvider.ts` and `DidProbeScreen.tsx`. */
export const enetAdapterReservation: EnetAdapterReservation = createEnetAdapterReservation();
