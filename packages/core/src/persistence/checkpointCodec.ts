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

function isSerializedCheckpoint(value: unknown): value is SerializedCheckpoint {
  if (!isPlainObject(value)) return false;
  if (typeof value.schemaVersion !== 'number') return false;
  if (!isPlainObject(value.snapshot)) return false;
  if (typeof value.snapshot.state !== 'string') return false;
  if (typeof value.snapshot.lapNumber !== 'number') return false;
  if (!isPlainObject(value.snapshot.context)) return false;
  if (!Array.isArray(value.laps)) return false;
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
