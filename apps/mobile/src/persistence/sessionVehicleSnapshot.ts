import type { SqlDatabase } from '@circuit/core';

/**
 * Ticket P14 H7 (Codex P13 round) -- WHICH CAR WAS THIS SESSION RECORDED
 * WITH?
 *
 * The session report used to answer that with the vehicle profile that is
 * active TODAY. Record a session with profile A, switch to B, export A's
 * session, and the document carried B's channel bindings -- and, when B had
 * none, additionally claimed "no OBD channel was decoded from a binding" about
 * a session that decoded plenty. That corrupts exactly the offline analysis
 * this build exists to enable: a trace is only interpretable against the
 * bindings that produced it.
 *
 * So the profile identity and its confirmed bindings are SNAPSHOTTED when a
 * session starts, keyed by session id, and the export reads the snapshot. A
 * session with no snapshot (recorded before this existed) is reported as
 * UNAVAILABLE -- never as today's configuration, and never as "no channel was
 * decoded".
 *
 * WHY THE SETTINGS TABLE AND NOT A COLUMN ON `sessions`. Exactly the reason
 * `sqlSettingsStore.ts`'s unvalidated-matching log gives: the session row
 * belongs to `@circuit/core`'s `SessionSummary`, and a fact the mobile app
 * owns is stored beside the session, keyed by its id, in the one durable
 * table the app owns. It is not transactional with the session write, so a
 * crash between the two loses the snapshot rather than inventing one -- the
 * failure direction that under-claims, which is the right way round here.
 */

/** One confirmed channel binding, as the snapshot keeps it. Deliberately loose: this module carries it, it does not interpret it. */
export interface VehicleProfileSnapshotBinding {
  channel: string;
  [key: string]: unknown;
}

/**
 * WHAT THIS IS, EXACTLY: the configuration the session STARTED under.
 *
 * Ticket P15 F2 (Codex P14 round, disclosed limit): it is a snapshot at one
 * instant, not an account of the whole recording. A profile switched or a
 * channel re-bound while the session was running is NOT described here, and
 * nothing in this record may be read as covering every sample in the trace.
 * The report states that in the row it exports.
 */
export interface SessionVehicleSnapshot {
  /** The profile that was ACTIVE when this session started. */
  profileId: string;
  /** Its confirmed channel bindings at that moment, exactly as the store held them. */
  bindings: VehicleProfileSnapshotBinding[];
  /** When the snapshot was taken -- the session's start, not the export. */
  capturedAtUtc: string;
}

/**
 * `vehicle-profile-snapshot:<sessionId>`. One row per session, WRITTEN ONCE
 * -- see {@link writeSessionVehicleSnapshot}.
 */
export const SESSION_VEHICLE_SNAPSHOT_KEY_PREFIX = 'vehicle-profile-snapshot:';

export function sessionVehicleSnapshotKey(sessionId: string): string {
  return `${SESSION_VEHICLE_SNAPSHOT_KEY_PREFIX}${sessionId}`;
}

function isSnapshot(value: unknown): value is SessionVehicleSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionVehicleSnapshot>;
  return (
    typeof candidate.profileId === 'string' &&
    candidate.profileId.length > 0 &&
    Array.isArray(candidate.bindings) &&
    typeof candidate.capturedAtUtc === 'string'
  );
}

/**
 * Records the profile this session is being driven under. WRITE-ONCE: a
 * session id that already has a snapshot keeps the one it has.
 *
 * Ticket P15 F2 (Codex P14 round) -- WHY WRITE-ONCE AND NOT `OR REPLACE`.
 *
 * This is called from `initializeSessionStage()`, which runs on a normal
 * session start AND from `resumeRecovery()` with the EXISTING session id.
 * With `INSERT OR REPLACE` the recovery call overwrote the snapshot of the
 * profile the session was actually recorded with (A) with whatever is active
 * at recovery time (B) -- reinstating, on the recovery path, precisely the
 * defect this module was introduced to prevent, and with B empty the export
 * went on to claim the session had decoded no OBD channel at all.
 *
 * A session is recorded under the configuration it STARTED under, so the
 * first snapshot is the true one and every later write for that id is noise.
 * `INSERT OR IGNORE` against `settings(key TEXT PRIMARY KEY)` is that rule in
 * one statement -- no read-then-write window for a second call to slip
 * through. An existing row is kept even when it will not decode: an
 * unreadable snapshot is reported UNAVAILABLE, and replacing it with today's
 * profile would turn "we do not know" into a confident wrong answer.
 *
 * NEVER THROWS: a driver must not be refused a session by a bookkeeping
 * write. Resolves `true` when this session HAS a snapshot afterwards --
 * whether this call wrote it or an earlier one did -- and `false` when the
 * write did not land, which is the state the export reports as UNAVAILABLE.
 */
export async function writeSessionVehicleSnapshot(
  db: SqlDatabase,
  sessionId: string,
  snapshot: SessionVehicleSnapshot,
): Promise<boolean> {
  if (sessionId.length === 0) return false;
  try {
    await db.runAsync('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [
      sessionVehicleSnapshotKey(sessionId),
      JSON.stringify(snapshot),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The snapshot for one session, or `null` when there is none.
 *
 * `null` means UNAVAILABLE and nothing else. It is NOT an invitation to
 * substitute the currently active profile, which is the whole bug: a caller
 * that reads `null` must say the historical configuration is not on this
 * device, and must not make any claim about what the car decoded.
 */
export async function readSessionVehicleSnapshot(
  db: SqlDatabase,
  sessionId: string,
): Promise<SessionVehicleSnapshot | null> {
  try {
    const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      sessionVehicleSnapshotKey(sessionId),
    ]);
    const raw = rows[0]?.value;
    if (raw === undefined) return null;
    const parsed: unknown = JSON.parse(raw);
    // A row that will not decode is UNREADABLE, which is `null` here and
    // UNAVAILABLE in the report -- the one thing it must never become is
    // "this session had no bindings".
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
