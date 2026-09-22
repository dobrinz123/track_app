import type {
  CalibrationAttemptRecord,
  LapRecord,
  LapValidityVerdict,
  LocalSessionRepository,
  LocationSample,
  ReferenceLap,
  SessionMachineSnapshot,
  SessionSummary,
  StoredRecordRead,
} from '../contracts';
import { checkpointSupersedes } from './checkpointCodec';
import { assertJsonSerializable } from './jsonSerializable';
import { validateReferenceLap } from './referenceLap';

interface CheckpointEntry {
  snapshot: SessionMachineSnapshot;
  laps: LapRecord[];
}

// A separator unlikely to appear inside ordinary IDs (userId/circuitId/layoutId/
// sessionId are expected to be slug-like). Composite keys below are internal to
// this module only, never exposed to callers.
const KEY_SEP = '::';

function referenceLapKey(userId: string, circuitId: string, layoutId: string, layoutVersion: number): string {
  return [userId, circuitId, layoutId, String(layoutVersion)].join(KEY_SEP);
}

function telemetryKey(sessionId: string, lapNumber: number): string {
  return `${sessionId}${KEY_SEP}${lapNumber}`;
}

function telemetryKeyPrefix(sessionId: string): string {
  return `${sessionId}${KEY_SEP}`;
}

/**
 * In-memory reference implementation of `LocalSessionRepository`.
 *
 * This is the semantic reference for the future SQLite-backed adapter: every
 * method is Promise-based even though the backing store is a synchronous Map,
 * so callers can never accidentally depend on synchronous resolution.
 *
 * All getters return deep copies -- callers mutating a returned object can
 * never corrupt the store, and vice versa.
 */
export class InMemorySessionRepository implements LocalSessionRepository {
  private readonly checkpoints = new Map<string, CheckpointEntry>();
  private readonly sessions = new Map<string, SessionSummary>();
  // sessionId -> userId. This is the only source of truth for attributing a
  // session's checkpoints/telemetry to a user (the contract does not pass
  // userId to saveCheckpoint/saveTelemetry), so deleteUserData relies on
  // saveSession having been called for a session before it can be swept.
  private readonly sessionOwners = new Map<string, string>();
  private readonly telemetry = new Map<string, LocationSample[]>();
  private readonly referenceLaps = new Map<string, ReferenceLap>();
  /** Ticket P12 item A: keyed `sessionId::lapNumber`, exactly like `telemetry`. */
  private readonly lapVerdicts = new Map<string, LapValidityVerdict>();
  /** Ticket P12 item B: keyed by `attemptId`; a provisional row is REPLACED by its concluded successor. */
  private readonly calibrationAttempts = new Map<string, CalibrationAttemptRecord>();

  async saveCheckpoint(sessionId: string, snapshot: SessionMachineSnapshot, laps: LapRecord[]): Promise<void> {
    assertJsonSerializable(snapshot, `checkpoint(${sessionId}).snapshot`);
    assertJsonSerializable(laps, `checkpoint(${sessionId}).laps`);
    this.checkpoints.set(sessionId, structuredClone({ snapshot, laps }));
  }

  async loadCheckpoint(sessionId: string): Promise<{ snapshot: SessionMachineSnapshot; laps: LapRecord[] } | null> {
    const entry = this.checkpoints.get(sessionId);
    return entry ? structuredClone(entry) : null;
  }

  async saveSession(s: SessionSummary): Promise<void> {
    const stored = structuredClone(s);
    // Ticket P16 C1: `unreadableLapCount` is a READ diagnostic -- what the
    // store could not decode -- so a writer may not set it and a store may not
    // echo it back. (`SqlSessionRepository` drops it for free: there is no
    // column for it. This keeps the two implementations identical, which the
    // class comment there promises.) An in-memory Map has no corrupt rows, so
    // this read always reports complete, i.e. absent.
    delete stored.unreadableLapCount;
    this.sessions.set(s.sessionId, stored);
    this.sessionOwners.set(s.sessionId, s.userId);
  }

  async listSessions(userId: string, circuitId: string): Promise<SessionSummary[]> {
    const matches = [...this.sessions.values()].filter((s) => s.userId === userId && s.circuitId === circuitId);
    matches.sort((a, b) => (a.startedAtUtc < b.startedAtUtc ? 1 : a.startedAtUtc > b.startedAtUtc ? -1 : 0));
    return matches.map((s) => structuredClone(s));
  }

  async saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void> {
    // One write per (sessionId, lapNumber) key: a second write REPLACES, it
    // does not append. This matches the "atomic replace" semantics used
    // elsewhere in the contract (e.g. putReferenceLap).
    this.telemetry.set(telemetryKey(sessionId, lapNumber), structuredClone(samples));
  }

  /**
   * Ticket P10A H4. The Map has no transactions, so atomicity is achieved the
   * only way it can be here: every entry is validated and deep-copied FIRST,
   * and only then are the copies committed in one synchronous, un-awaited
   * loop -- nothing can interleave, and nothing is applied if any entry was
   * rejected.
   */
  async saveTelemetryBatch(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
  ): Promise<void> {
    const staged = entries.map((entry) => ({
      key: telemetryKey(sessionId, entry.lapNumber),
      samples: structuredClone(entry.samples),
    }));
    for (const entry of staged) this.telemetry.set(entry.key, entry.samples);
  }

  /**
   * Ticket P10B H4-B: the lap rows, the reclaim and the recovery checkpoint
   * in one indivisible step. Same technique as `saveTelemetryBatch` above --
   * validate and deep-copy everything first, then apply the copies in one
   * synchronous loop with no `await` in it, so no interleaving observer can
   * ever see the lap rows without the checkpoint that names them.
   *
   * Ticket P11C: the checkpoint half is a monotonic compare-and-set -- the
   * stored checkpoint is replaced only by one that SUPERSEDES it (see
   * `checkpointSupersedes`), so a retried older lap commit persists its
   * telemetry without dragging the checkpoint backwards. The comparison sits
   * in the same synchronous, un-awaited block as the write, which is this
   * store's equivalent of "inside the transaction": nothing can run between
   * the read and the write.
   */
  async saveLapCommit(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
    checkpoint: { snapshot: SessionMachineSnapshot; laps: LapRecord[] },
  ): Promise<void> {
    assertJsonSerializable(checkpoint.snapshot, `checkpoint(${sessionId}).snapshot`);
    assertJsonSerializable(checkpoint.laps, `checkpoint(${sessionId}).laps`);
    const staged = entries.map((entry) => ({
      key: telemetryKey(sessionId, entry.lapNumber),
      samples: structuredClone(entry.samples),
    }));
    const stagedCheckpoint = structuredClone({ snapshot: checkpoint.snapshot, laps: checkpoint.laps });
    for (const entry of staged) this.telemetry.set(entry.key, entry.samples);
    const stored = this.checkpoints.get(sessionId);
    if (checkpointSupersedes(stagedCheckpoint.laps, stored === undefined ? null : stored.laps)) {
      this.checkpoints.set(sessionId, stagedCheckpoint);
    }
  }

  async loadTelemetry(sessionId: string, lapNumber: number): Promise<LocationSample[]> {
    const entry = this.telemetry.get(telemetryKey(sessionId, lapNumber));
    return entry ? structuredClone(entry) : [];
  }

  /**
   * Ticket P12 item A. Validated BEFORE the store is touched, like every other
   * write here: a verdict that cannot be serialized must never half-land, or
   * the export would report an answer the owner's next launch cannot read.
   */
  async saveLapValidityVerdict(verdict: LapValidityVerdict): Promise<void> {
    assertJsonSerializable(verdict, `lapVerdict(${verdict.sessionId}, lap ${verdict.lapNumber})`);
    this.lapVerdicts.set(telemetryKey(verdict.sessionId, verdict.lapNumber), structuredClone(verdict));
  }

  async listLapValidityVerdicts(sessionId: string): Promise<LapValidityVerdict[]> {
    return [...this.lapVerdicts.values()]
      .filter((verdict) => verdict.sessionId === sessionId)
      .sort((a, b) => a.lapNumber - b.lapNumber)
      .map((verdict) => structuredClone(verdict));
  }

  /**
   * Ticket P14 H5: parity with `SqlSessionRepository`. Nothing here can be
   * unreadable -- the records are held as objects, never as text -- so the
   * count is always `0`, and that ZERO is a real answer: this store knows it
   * lost nothing. It is not the same as a store that cannot tell.
   */
  async listLapValidityVerdictsWithDiagnostics(
    sessionId: string,
  ): Promise<StoredRecordRead<LapValidityVerdict>> {
    return { records: await this.listLapValidityVerdicts(sessionId), unreadableCount: 0 };
  }

  /** Ticket P12 item B. Keyed by `attemptId`, so rewriting a provisional row replaces it rather than accumulating duplicates. */
  async saveCalibrationAttempt(record: CalibrationAttemptRecord): Promise<void> {
    assertJsonSerializable(record, `calibrationAttempt(${record.attemptId})`);
    this.calibrationAttempts.set(record.attemptId, structuredClone(record));
  }

  async listCalibrationAttempts(sessionId: string): Promise<CalibrationAttemptRecord[]> {
    return [...this.calibrationAttempts.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((a, b) =>
        a.startedAtUtc < b.startedAtUtc ? -1 : a.startedAtUtc > b.startedAtUtc ? 1 : a.attemptId.localeCompare(b.attemptId),
      )
      .map((record) => structuredClone(record));
  }

  /** Ticket P14 H5: parity with `SqlSessionRepository` -- see the verdict read above. */
  async listCalibrationAttemptsWithDiagnostics(
    sessionId: string,
  ): Promise<StoredRecordRead<CalibrationAttemptRecord>> {
    return { records: await this.listCalibrationAttempts(sessionId), unreadableCount: 0 };
  }

  async getReferenceLap(
    userId: string,
    circuitId: string,
    layoutId: string,
    layoutVersion: number,
  ): Promise<ReferenceLap | null> {
    const entry = this.referenceLaps.get(referenceLapKey(userId, circuitId, layoutId, layoutVersion));
    return entry ? structuredClone(entry) : null;
  }

  async putReferenceLap(ref: ReferenceLap): Promise<void> {
    // Validate BEFORE touching the store: a failed validation must leave any
    // previously-stored reference lap for this key completely untouched, so a
    // corrupt candidate can never partially or fully overwrite a good one.
    validateReferenceLap(ref);
    const key = referenceLapKey(ref.userId, ref.circuitId, ref.layoutId, ref.layoutVersion);
    this.referenceLaps.set(key, structuredClone(ref));
  }

  async deleteUserData(userId: string): Promise<void> {
    const ownedSessionIds = [...this.sessionOwners.entries()]
      .filter(([, owner]) => owner === userId)
      .map(([sessionId]) => sessionId);

    for (const sessionId of ownedSessionIds) {
      this.sessions.delete(sessionId);
      this.checkpoints.delete(sessionId);
      this.sessionOwners.delete(sessionId);

      const prefix = telemetryKeyPrefix(sessionId);
      for (const key of [...this.telemetry.keys()]) {
        if (key.startsWith(prefix)) this.telemetry.delete(key);
      }
      // Ticket P12 items A/B: the owner's verdicts and the calibration
      // attempts are this session's data too -- a delete-all that left them
      // behind would leave a record of a drive the user asked to be erased.
      for (const key of [...this.lapVerdicts.keys()]) {
        if (key.startsWith(prefix)) this.lapVerdicts.delete(key);
      }
      for (const [attemptId, record] of [...this.calibrationAttempts.entries()]) {
        if (record.sessionId === sessionId) this.calibrationAttempts.delete(attemptId);
      }
    }

    for (const [key, ref] of [...this.referenceLaps.entries()]) {
      if (ref.userId === userId) this.referenceLaps.delete(key);
    }
  }
}
