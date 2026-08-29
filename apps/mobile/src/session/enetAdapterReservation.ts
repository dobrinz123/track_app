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

/**
 * ENET auto-discovery & DID sweep addendum (binding, Phase 4f): two more
 * owner kinds share this SAME single-client reservation -- `'discovery'`
 * (Settings' manual "Find adapter" button, `runDiscovery` against the real
 * network) and `'sweep'` (the dev DID-sweep screen). `telemetryProvider.ts`'s
 * own auto-discovery-on-connect-failure path acquires under the EXISTING
 * `'provider'` owner (it IS the provider attempting to connect, just via a
 * discovery detour first) -- it never uses the `'discovery'` owner, which is
 * reserved for the user-initiated Settings button.
 */
export type EnetAdapterOwner = 'provider' | 'probe' | 'discovery' | 'sweep';

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
  /**
   * Ticket P4j-FIX2 V2 (binding, after Codex P4j-REV2 MEDIUM #2: "the screen's
   * unmount cleanup still fire-and-forgets `stop()`"): resolves once the
   * reservation becomes free -- IMMEDIATELY (already-resolved) if it already
   * is, otherwise the next time `release()` actually runs. A React effect
   * cleanup cannot itself be `async`, so `DidSweepScreen.tsx`'s unmount kicks
   * `controller.stop()`'s close-then-release off fire-and-forget; a
   * REMOUNTED screen's own next `tryAcquire('sweep')` (`start()`/
   * `resumePersistedRun()`) used to see a transient "adapter in use" while
   * the OLD instance's socket close was still in flight. Those call sites
   * await this (only on a first refused `tryAcquire`, never unconditionally)
   * before retrying -- the reacquire then fails ONLY when someone ELSE
   * (never merely a still-draining prior holder) truly holds the claim.
   */
  whenFree(): Promise<void>;
  /**
   * Ticket P4j-FIX2 V2 (binding): the CURRENT holder marks itself as "a
   * close-then-release is now in flight for my own token" -- purely
   * advisory bookkeeping (never blocks/affects `tryAcquire`/`release`
   * themselves) so a caller refused by `tryAcquire` can tell "worth a short
   * wait" apart from "held by a live, unrelated owner that never signaled
   * it's releasing" (see `isReleasePending`). A no-op, silently ignored, if
   * `token` is not the CURRENT holder's token (stale/foreign).
   */
  markReleasing(token: EnetAdapterToken): void;
  /**
   * True exactly when the CURRENT holder has called `markReleasing` with
   * its own (still current) token and the reservation has not yet been
   * released. `false` once free (or before anyone ever marked it) -- a
   * caller uses this to decide whether awaiting `whenFree()` (bounded by
   * its own short race) is worth attempting instead of reporting "busy"
   * immediately.
   */
  isReleasePending(): boolean;
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
  /** P4j-FIX2 V2 (binding): resolvers for every outstanding `whenFree()` call -- drained (and cleared) the instant `release()` actually clears `held`, so a caller awaiting a pending release is never left hanging past that point. */
  let freeWaiters: Array<() => void> = [];
  /** P4j-FIX2 V2 (binding): the token `markReleasing` was last called with, while it is STILL the current holder's token -- see `isReleasePending`'s own doc comment. */
  let releasingToken: EnetAdapterToken | null = null;

  /**
   * P4e-FIX5 HIGH fix (binding, Codex P4e-REV5): a subscriber callback must
   * NEVER be able to affect `tryAcquire`/`release`'s own outcome -- each
   * call is individually wrapped in try/catch (a throwing subscriber is
   * `console.warn`ed and skipped, every OTHER subscriber still gets
   * notified) so `notify()` itself can never throw. Before this fix,
   * `notify()` called listeners unguarded: a throwing subscriber during
   * `tryAcquire` would propagate OUT before the `return token` line ever
   * ran, so the caller that legitimately just acquired the reservation
   * never received its own token (permanently leaking the claim -- nothing
   * left alive to ever release it); the SAME throw during `release` would
   * propagate before `telemetryProvider.ts`'s `stop()` could reach its own
   * `resolveStopping()` continuation, deadlocking every later ENET
   * `start()` that queues behind `stopping` forever.
   */
  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener(held?.owner ?? null);
      } catch (error) {
        console.warn('[enetAdapterReservation] a subscriber threw -- ignored, other subscribers still notified', error);
      }
    }
  }

  return {
    tryAcquire(owner: EnetAdapterOwner): EnetAdapterToken | null {
      if (held !== null) return null; // ANYONE holding it (including this same owner) blocks a new acquire.
      const token: EnetAdapterToken = Symbol(owner);
      held = { owner, token };
      releasingToken = null; // a fresh holder never inherits a PRIOR holder's "releasing" flag.
      // State is already committed above -- `notify()` can never throw
      // (see its own doc comment), so this call can never prevent the
      // token below from being returned to the caller that just acquired.
      notify();
      return token;
    },
    release(token: EnetAdapterToken): void {
      if (held === null || held.token !== token) return; // stale/foreign token -- never touches a newer holder's claim.
      held = null;
      releasingToken = null;
      // P4j-FIX2 V2 (binding): every `whenFree()` waiter is resolved the
      // instant `held` is ACTUALLY cleared -- before `notify()`, so a
      // re-entrant subscriber that itself calls `tryAcquire` synchronously
      // still sees waiters already released (order never matters for a
      // promise resolution observed on a later microtask either way, but
      // this keeps the "freed" signal as close to the state change as
      // possible).
      const waiters = freeWaiters;
      freeWaiters = [];
      for (const resolve of waiters) resolve();
      // Same guarantee as `tryAcquire` above: `held` is already cleared, and
      // `notify()` can never throw, so a caller's own cleanup AFTER this
      // call (e.g. `telemetryProvider.ts`'s `resolveStopping()`) always runs.
      notify();
    },
    holder(): EnetAdapterOwner | null {
      return held?.owner ?? null;
    },
    whenFree(): Promise<void> {
      if (held === null) return Promise.resolve();
      return new Promise((resolve) => freeWaiters.push(resolve));
    },
    markReleasing(token: EnetAdapterToken): void {
      if (held !== null && held.token === token) releasingToken = token;
    },
    isReleasePending(): boolean {
      return held !== null && releasingToken === held.token;
    },
    subscribe(cb: (holder: EnetAdapterOwner | null) => void): () => void {
      listeners.add(cb);
      // Same guard as `notify()` above -- a throwing subscriber must not
      // prevent `subscribe()` itself from returning its unsubscribe function.
      try {
        cb(held?.owner ?? null);
      } catch (error) {
        console.warn('[enetAdapterReservation] a subscriber threw on initial replay -- ignored', error);
      }
      return () => listeners.delete(cb);
    },
  };
}

/** The ONE production reservation shared by `telemetryProvider.ts` and `DidProbeScreen.tsx`. */
export const enetAdapterReservation: EnetAdapterReservation = createEnetAdapterReservation();
