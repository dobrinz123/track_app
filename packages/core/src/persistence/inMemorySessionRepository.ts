import type {
  LapRecord,
  LocalSessionRepository,
  LocationSample,
  ReferenceLap,
  SessionMachineSnapshot,
  SessionSummary,
} from '../contracts';
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
    this.sessions.set(s.sessionId, structuredClone(s));
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

  async loadTelemetry(sessionId: string, lapNumber: number): Promise<LocationSample[]> {
    const entry = this.telemetry.get(telemetryKey(sessionId, lapNumber));
    return entry ? structuredClone(entry) : [];
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
    }

    for (const [key, ref] of [...this.referenceLaps.entries()]) {
      if (ref.userId === userId) this.referenceLaps.delete(key);
    }
  }
}
