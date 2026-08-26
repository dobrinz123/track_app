/**
 * The ONE ordering boundary for session-lifecycle work (contracts.md's
 * "Multi-circuit selection — lifecycle lock amendment", binding, ticket
 * CN-FIX3).
 *
 * `composition.ts` previously had THREE independent serialization mechanisms
 * -- `selectionChain` (settings/history writes), `rebuildInFlight`
 * (controller dispose+install), and `withDevReplayLock` (replay transitions).
 * Each was individually correct, but they did not form a single ordering
 * boundary: a rebuild could dispose the controller another operation had
 * already captured, and the preflight gate could forward START_PREFLIGHT to a
 * controller built for a circuit a queued selection was about to replace
 * (Codex CN-REV3 findings H3/N2/N3). All three are replaced by ONE mutex:
 * every operation that reads or replaces the production controller runs
 * entirely inside `run()`.
 *
 * Semantics:
 *  - FIFO: sections execute in the order `run()` was called, never
 *    overlapping. A section "holds" the lock across its own `await`s, so a
 *    controller it captured cannot be disposed underneath it.
 *  - Errors propagate to that section's caller only, and always release the
 *    lock (including a synchronous throw before the section's first `await`),
 *    so one failed operation can never wedge every later one.
 *  - Re-entrancy is NOT supported, by design: a section that calls `run()`
 *    again would queue behind ITSELF and deadlock forever. Composition-level
 *    code therefore calls `unlocked*` inner routines from inside a section,
 *    never the locked public wrapper. The synchronously-detectable form of
 *    that mistake (a `run()` issued from a section's own synchronous body) is
 *    REFUSED with `LifecycleLockReentry` instead of hanging.
 *
 * Detection limit (documented deliberately): JavaScript gives no way to tell
 * a `run()` issued from a holder's post-`await` continuation apart from a
 * legitimate concurrent call that must queue -- both see `isHeld() === true`
 * from an unrelated task. Refusing on `isHeld()` alone would break the
 * queueing this lock exists for, so the assert covers the synchronous case
 * only; the structural rule ("inside a section, call `unlocked*`") is what
 * covers the rest, and every call site in `composition.ts` follows it.
 */

/** Thrown by `run()` when a section re-enters the lock from its own synchronous body -- a coding error that would otherwise self-deadlock. */
export class LifecycleLockReentry extends Error {
  constructor(message = 'lifecycleLock: re-entrant run() from inside a held section -- call the unlocked* inner routine instead') {
    super(message);
    this.name = 'LifecycleLockReentry';
  }
}

export interface LifecycleLock {
  /** Queues `fn` behind every earlier call and runs it with the lock held for its whole duration (awaits included). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** `true` while a section is executing -- diagnostics/tests only; never a substitute for queueing through `run()`. */
  isHeld(): boolean;
}

export function createLifecycleLock(): LifecycleLock {
  let tail: Promise<unknown> = Promise.resolve();
  let held = false;
  /** `> 0` only while a section's SYNCHRONOUS body is on the stack -- the one re-entrancy case that is precisely detectable (see the module doc comment). */
  let syncDepth = 0;

  return {
    isHeld(): boolean {
      return held;
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      if (syncDepth > 0) return Promise.reject(new LifecycleLockReentry());
      const result = tail.then(async () => {
        held = true;
        try {
          let started: Promise<T>;
          syncDepth += 1;
          try {
            started = fn();
          } finally {
            syncDepth -= 1;
          }
          return await started;
        } finally {
          held = false;
        }
      });
      // The chain tail must survive a rejected section (mirrors
      // `SqlWriteGate`'s own tail discipline) -- otherwise one failure would
      // leave every later section queued behind a never-settling link.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
