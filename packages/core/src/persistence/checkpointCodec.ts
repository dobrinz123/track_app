import type { LapRecord, SessionMachineSnapshot } from '../contracts';
import { assertJsonSerializable } from './jsonSerializable';

export const CHECKPOINT_SCHEMA_VERSION = 1;

export interface CheckpointPayload {
  snapshot: SessionMachineSnapshot;
  laps: LapRecord[];
}

interface SerializedCheckpoint extends CheckpointPayload {
  schemaVersion: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ticket P11C — WHAT "NEWER" MEANS FOR A RECOVERY CHECKPOINT.
 *
 * A checkpoint's GENERATION is the number of laps it names. Nothing else:
 * not a timestamp (two writes inside one millisecond are indistinguishable,
 * and a monotonic clock does not survive a relaunch), and not a counter the
 * writer supplies (a retry replays whatever it captured, so a counter it
 * carries is exactly as stale as the rest of it).
 *
 * The lap list is the one part of a checkpoint that is DERIVED FROM
 * COMMITTED WORK and can only grow:
 *   - `SessionController` captures `[...core.laps]` at each lap boundary, and
 *     `core.laps` is only ever appended to within a session;
 *   - `restoreFromCheckpoint` REHYDRATES `core.laps` from the checkpoint it
 *     restores (and only adds the synthetic RECOVERY lap on top), so the
 *     count does not reset across a relaunch either.
 *
 * So a retry cannot fake being newer: the array it carries was frozen before
 * the laps it is competing with existed, and it has no field to increment —
 * to present a higher generation it would have to invent laps that a later
 * checkpoint already names, which is the same thing as being newer.
 */
export function checkpointGeneration(laps: readonly LapRecord[]): number {
  return laps.length;
}

/**
 * Ticket P11C — may `incomingLaps` replace `storedLaps`?
 *
 * Strictly-greater generation, so an equal-generation write is a no-op
 * rather than a rewrite. Two checkpoints of the same generation name the
 * same laps (one lap boundary appends exactly one lap), and of those the
 * stored one is never the older: it either IS this one, or it was captured
 * at the same boundary. `null` (no row, or a row the codec refuses to
 * decode) is generation "absent" and is always superseded — a corrupt
 * checkpoint must be replaceable, or a session could never recover from one.
 */
export function checkpointSupersedes(
  incomingLaps: readonly LapRecord[],
  storedLaps: readonly LapRecord[] | null,
): boolean {
  if (storedLaps === null) return true;
  return checkpointGeneration(incomingLaps) > checkpointGeneration(storedLaps);
}

/** Minimal per-lap shape check (L2 fix) -- catches a structurally-valid-JSON `laps` entry that doesn't match `LapRecord` (e.g. `{}`) before it flows into `restoreFromCheckpoint`. Not a full schema: just the fields consumers read as numbers/booleans/arrays without further guarding. */
function isLapRecordShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.lapNumber !== 'number') return false;
  if (typeof value.tStart !== 'number') return false;
  if (typeof value.tEnd !== 'number') return false;
  if (typeof value.durationMs !== 'number') return false;
  if (typeof value.valid !== 'boolean') return false;
  if (!Array.isArray(value.sectorTimes)) return false;
  if (!Array.isArray(value.invalidReasons)) return false;
  return true;
}

function isSerializedCheckpoint(value: unknown): value is SerializedCheckpoint {
  if (!isPlainObject(value)) return false;
  if (typeof value.schemaVersion !== 'number') return false;
  if (!isPlainObject(value.snapshot)) return false;
  if (typeof value.snapshot.state !== 'string') return false;
  if (typeof value.snapshot.lapNumber !== 'number') return false;
  if (!isPlainObject(value.snapshot.context)) return false;
  if (!Array.isArray(value.laps)) return false;
  if (!value.laps.every(isLapRecordShape)) return false;
  return true;
}

// Serializes/deserializes a session checkpoint {snapshot, laps} with an explicit
// schemaVersion envelope. `deserialize` is a corruption guard: it NEVER throws,
// returning null for truncated/malformed JSON or a schema version it doesn't recognize.
export const CheckpointCodec = {
  schemaVersion: CHECKPOINT_SCHEMA_VERSION,

  serialize(payload: CheckpointPayload): string {
    assertJsonSerializable(payload.snapshot, 'checkpoint.snapshot');
    assertJsonSerializable(payload.laps, 'checkpoint.laps');
    const wire: SerializedCheckpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      snapshot: payload.snapshot,
      laps: payload.laps,
    };
    return JSON.stringify(wire);
  },

  deserialize(text: string): CheckpointPayload | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }

    if (!isSerializedCheckpoint(parsed)) return null;
    if (parsed.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return null;

    return { snapshot: parsed.snapshot, laps: parsed.laps };
  },
};
