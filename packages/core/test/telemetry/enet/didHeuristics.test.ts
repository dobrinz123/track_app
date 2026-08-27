import { describe, expect, it } from 'vitest';

import { SeededPrng } from '../../../src/fixtures/prng';
import {
  classifyResponders,
  enetSpecsFromSuggestion,
  type DidResponderSeries,
  type DidHeuristicSuggestion,
} from '../../../src/telemetry/enet/didHeuristics';
import {
  DEFAULT_ENET_DID_SCENARIO,
  ENET_DID_PEDAL_DID,
  ENET_DID_STEERING_DID,
  ENET_DID_TEMPERATURE_DID,
} from '../../../src/telemetry/enet/simulatedEnetTransport';
import { validateEnetChannelSpecs } from '../../../src/telemetry/enet/enetChannelSpecs';

function samplesFrom(count: number, stepMs: number, encode: (tMs: number) => Uint8Array): DidResponderSeries['samples'] {
  return Array.from({ length: count }, (_, i) => ({ tMs: i * stepMs, raw: encode(i * stepMs) }));
}

describe('classifyResponders', () => {
  it('classifies a slow monotonic drift within plausible range as temperature-like (u8-40)', () => {
    const samples = samplesFrom(20, 1_000, (tMs) => {
      const celsius = 70 + (40 * tMs) / 19_000; // 70 -> 110C over 19s, strictly monotonic
      return Uint8Array.from([Math.round(celsius + 40)]);
    });
    const [result] = classifyResponders([{ did: 0x5c, samples }]);
    expect(result?.kind).toBe('temperature');
    expect(result?.decode).toBe('u8-40');
    expect(result?.confidence).toBeGreaterThan(0.55);
  });

  it('classifies fast bimodal steps as pedal-like (u8 raw)', () => {
    const samples = samplesFrom(12, 200, (tMs) => Uint8Array.from([(tMs / 200) % 2 === 0 ? 20 : 220]));
    const [result] = classifyResponders([{ did: 0x30, samples }]);
    expect(result?.kind).toBe('pedal');
    expect(result?.decode).toBe('u8');
    expect(result?.confidence).toBeGreaterThan(0.55);
  });

  it('classifies a zero-centred, sign-flipping oscillation as steering-like (i16 raw)', () => {
    const samples = samplesFrom(24, 200, (tMs) => {
      const value = Math.round(300 * Math.sin(tMs / 800));
      const raw = value < 0 ? value + 0x1_0000 : value;
      return Uint8Array.from([(raw >> 8) & 0xff, raw & 0xff]);
    });
    const [result] = classifyResponders([{ did: 0x40, samples }]);
    expect(result?.kind).toBe('steering');
    expect(result?.decode).toBe('i16');
    expect(result?.confidence).toBeGreaterThan(0.55);
  });

  it('classifies a series correlating with GNSS speed as speed-like when context is given', () => {
    const stepMs = 250;
    const speedAt = (i: number) => 60 + 50 * Math.sin((i / 23) * Math.PI); // rises then falls back to ~60
    const samples = samplesFrom(24, stepMs, (tMs) => {
      const i = tMs / stepMs;
      return Uint8Array.from([Math.max(0, Math.min(255, Math.round(speedAt(i) * 2)))]);
    });
    const gnssSpeedKph = Array.from({ length: 24 }, (_, i) => ({ tMs: i * stepMs, v: speedAt(i) }));

    const [result] = classifyResponders([{ did: 0x50, samples }], { gnssSpeedKph });
    expect(result?.kind).toBe('speed');
    expect(result?.confidence).toBeGreaterThan(0.55);
  });

  it('classifies unstructured noise as unknown', () => {
    const prng = new SeededPrng(7);
    const samples = samplesFrom(20, 1_000, () => Uint8Array.from([Math.round(100 + prng.next() * 60)]));
    const [result] = classifyResponders([{ did: 0x99, samples }]);
    expect(result?.kind).toBe('unknown');
  });

  it('ranks multiple responders by confidence, ties broken by ascending DID', () => {
    const flat = samplesFrom(10, 500, () => Uint8Array.from([128])); // constant -- no shape at all
    const drift = samplesFrom(20, 1_000, (tMs) => Uint8Array.from([Math.round(70 + (40 * tMs) / 19_000 + 40)]));
    const results = classifyResponders([
      { did: 0x02, samples: flat },
      { did: 0x01, samples: drift },
    ]);
    expect(results.map((r) => r.did)).toEqual([0x01, 0x02]);
    expect(results[0]?.kind).toBe('temperature');
    expect(results[1]?.kind).toBe('unknown');
  });
});

describe('enetSpecsFromSuggestion', () => {
  it('builds an EnetChannelSpec with the addendum-shaped provenance, valid against validateEnetChannelSpecs', () => {
    const suggestion: DidHeuristicSuggestion = {
      did: 0x1e1c,
      kind: 'temperature',
      confidence: 0.91,
      decode: 'u8-40',
      rationale: 'monotonic drift, plausible range',
    };
    const spec = enetSpecsFromSuggestion(suggestion, 'engineOilC', '2026-08-27');

    expect(spec).toEqual({
      channel: 'engineOilC',
      mode: 'did',
      requestHex: '1E1C',
      decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: -40 },
      provenance: 'in-car sweep 2026-08-27, DID 0x1E1C, decode u8-40',
    });
    expect(validateEnetChannelSpecs([spec]).warnings).toEqual([]);
  });

  it('maps every decode label to its matching EnetChannelDecodeSpec', () => {
    const base: DidHeuristicSuggestion = { did: 0x1234, kind: 'unknown', confidence: 0, decode: 'u8', rationale: '' };
    expect(enetSpecsFromSuggestion({ ...base, decode: 'u16/10' }, 'transOilC', 'x').decode).toEqual({
      byteOffset: 0,
      byteLength: 2,
      scale: 0.1,
      offset: 0,
    });
    expect(enetSpecsFromSuggestion({ ...base, decode: 'i16' }, 'transOilC', 'x').decode).toEqual({
      byteOffset: 0,
      byteLength: 2,
      signed: true,
      scale: 1,
      offset: 0,
    });
  });
});

describe('simulator DID table (DEFAULT_ENET_DID_SCENARIO) matches the intended heuristic shapes', () => {
  it('classifies each scripted DID as the shape it was designed to look like', () => {
    const stepMs = 1_000;
    const windowSamples = 20;
    const series: DidResponderSeries[] = DEFAULT_ENET_DID_SCENARIO.map((script) => ({
      did: Number.parseInt(script.requestHex, 16),
      samples: samplesFrom(windowSamples, stepMs, (tMs) => script.encodeDataBytes(tMs)),
    }));

    const results = classifyResponders(series);
    const byDid = new Map(results.map((r) => [r.did, r] as const));

    expect(byDid.get(Number.parseInt(ENET_DID_TEMPERATURE_DID, 16))?.kind).toBe('temperature');
    expect(byDid.get(Number.parseInt(ENET_DID_PEDAL_DID, 16))?.kind).toBe('pedal');
    expect(byDid.get(Number.parseInt(ENET_DID_STEERING_DID, 16))?.kind).toBe('steering');
  });
});
