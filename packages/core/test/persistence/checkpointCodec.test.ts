import { describe, expect, it } from 'vitest';
import { CheckpointCodec, CHECKPOINT_SCHEMA_VERSION } from '../../src/persistence';
import { makeLapRecord, makeSnapshot } from './fixtures';

describe('CheckpointCodec', () => {
  it('round-trips a valid payload through serialize/deserialize', () => {
    const payload = { snapshot: makeSnapshot({ lapNumber: 2 }), laps: [makeLapRecord(), makeLapRecord({ lapNumber: 2 })] };
    const text = CheckpointCodec.serialize(payload);
    const decoded = CheckpointCodec.deserialize(text);
    expect(decoded).toEqual(payload);
  });

  it('serialize embeds the current schemaVersion', () => {
    const payload = { snapshot: makeSnapshot(), laps: [] };
    const text = CheckpointCodec.serialize(payload);
    const parsed = JSON.parse(text) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
  });

  it('deserialize returns null (never throws) on truncated JSON', () => {
    const truncated = '{"schemaVersion":1,"snapshot":{"state":"timing"';
    expect(() => CheckpointCodec.deserialize(truncated)).not.toThrow();
    expect(CheckpointCodec.deserialize(truncated)).toBeNull();
  });

  it('deserialize returns null (never throws) on empty / non-JSON input', () => {
    expect(CheckpointCodec.deserialize('')).toBeNull();
    expect(CheckpointCodec.deserialize('not json at all')).toBeNull();
    expect(CheckpointCodec.deserialize('undefined')).toBeNull();
  });

  it('deserialize returns null on a schemaVersion mismatch', () => {
    const payload = { snapshot: makeSnapshot(), laps: [] };
    const text = CheckpointCodec.serialize(payload);
    const wrongVersion = text.replace('"schemaVersion":1', '"schemaVersion":999');
    expect(CheckpointCodec.deserialize(wrongVersion)).toBeNull();
  });

  it('deserialize returns null for well-formed JSON missing required fields', () => {
    expect(CheckpointCodec.deserialize(JSON.stringify({ schemaVersion: CHECKPOINT_SCHEMA_VERSION }))).toBeNull();
    expect(CheckpointCodec.deserialize(JSON.stringify({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, snapshot: {} }))).toBeNull();
    expect(CheckpointCodec.deserialize(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(CheckpointCodec.deserialize('null')).toBeNull();
  });

  it('serialize rejects a payload containing a function', () => {
    const payload = { snapshot: makeSnapshot({ context: { cb: () => 1 } }), laps: [] };
    expect(() => CheckpointCodec.serialize(payload)).toThrow(Error);
  });

  it('serialize rejects a payload containing an explicit undefined value', () => {
    const payload = { snapshot: makeSnapshot({ context: { missing: undefined } }), laps: [] };
    expect(() => CheckpointCodec.serialize(payload)).toThrow(Error);
  });
});
