import { describe, expect, it } from 'vitest';

import { SeededPrng } from '../../../src/fixtures/prng';
import {
  classifyResponders,
  enetSpecsFromSuggestion,
  type DidResponderSeries,
  type DidHeuristicSuggestion,
} from '../../../src/telemetry/enet/didHeuristics';
import { DEFAULT_ENET_DID_SCENARIO } from '../../../src/telemetry/enet/simulatedEnetTransport';
import { validateEnetChannelSpecs } from '../../../src/telemetry/enet/enetChannelSpecs';

function samplesFrom(count: number, stepMs: number, encode: (tMs: number) => Uint8Array): DidResponderSeries['samples'] {
  return Array.from({ length: count }, (_, i) => ({ tMs: i * stepMs, raw: encode(i * stepMs) }));
}

describe('classifyResponders', () => {
  it('classifies a slow monotonic drift over >= 30s within plausible range as temperature-like (u8-40)', () => {
    // 35 samples, 1s apart -> 34s window (amendment: "slow monotonic drift over >= 30 s").
    const samples = samplesFrom(35, 1_000, (tMs) => {
      const celsius = 70 + (30 * tMs) / 34_000; // 70 -> 100C over 34s: slope ~0.88 C/s, well under the 2 C/s bound
      return Uint8Array.from([Math.round(celsius + 40)]);
    });
    const [result] = classifyResponders([{ did: 0x5c, samples }]);
    expect(result?.kind).toBe('temperature');
    expect(result?.decode).toBe('u8-40');
    expect(result?.confidence).toBeGreaterThan(0.55);
  });

  it('classifies fast bimodal steps (transitions <= 2s apart) as pedal-like (u8 raw)', () => {
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

  it('classifies a series correlating with GNSS speed AND matching its scale (gain ~1) as speed-like', () => {
    const stepMs = 250;
    const speedAt = (i: number) => 60 + 50 * Math.sin((i / 23) * Math.PI); // rises then falls back to ~60
    const samples = samplesFrom(24, stepMs, (tMs) => {
      const i = tMs / stepMs;
      return Uint8Array.from([Math.max(0, Math.min(255, Math.round(speedAt(i))))]); // decode ~= GNSS speed directly (gain ~1)
    });
    const gnssSpeedKph = Array.from({ length: 24 }, (_, i) => ({ tMs: i * stepMs, v: speedAt(i) }));

    const [result] = classifyResponders([{ did: 0x50, samples }], { gnssSpeedKph });
    expect(result?.kind).toBe('speed');
    expect(result?.decode).toBe('u8'); // asserted, not just `kind` -- the decode must be the scale-correct one
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
    const drift = samplesFrom(35, 1_000, (tMs) => Uint8Array.from([Math.round(70 + (30 * tMs) / 34_000 + 40)]));
    const results = classifyResponders([
      { did: 0x02, samples: flat },
      { did: 0x01, samples: drift },
    ]);
    expect(results.map((r) => r.did)).toEqual([0x01, 0x02]);
    expect(results[0]?.kind).toBe('temperature');
    expect(results[1]?.kind).toBe('unknown');
  });

  // --- The 4 counterexamples from Codex P4f-REV1, verifying the amendment's fixes ---

  it('[REV1 counterexample] temperature: [60,70,80] C sampled over only 2ms is NOT confidently temperature (duration gate, ">= 30s")', () => {
    const samples: DidResponderSeries['samples'] = [
      { tMs: 0, raw: Uint8Array.from([100]) }, // 60C
      { tMs: 1, raw: Uint8Array.from([110]) }, // 70C
      { tMs: 2, raw: Uint8Array.from([120]) }, // 80C
    ];
    const [result] = classifyResponders([{ did: 0x01, samples }]);
    expect(result?.kind).toBe('unknown');
  });

  it('[REV1 counterexample] pedal: [20,20,20,220,220,220] sampled 1 HOUR apart is NOT confidently pedal (transition-speed gate, "<= 2s")', () => {
    const hourMs = 3_600_000;
    const samples = samplesFrom(6, hourMs, (tMs) => Uint8Array.from([tMs / hourMs < 3 ? 20 : 220]));
    const [result] = classifyResponders([{ did: 0x02, samples }]);
    expect(result?.kind).toBe('unknown');
  });

  it('[REV1 counterexample] speed: DID [20,40,60,40,20] vs GNSS [1,2,3,2,1] is NOT speed-like (gain ~20x, outside +/-25% of 1)', () => {
    const values = [20, 40, 60, 40, 20];
    const gnss = [1, 2, 3, 2, 1];
    const samples = values.map((v, i) => ({ tMs: i * 200, raw: Uint8Array.from([v]) }));
    const gnssSpeedKph = gnss.map((v, i) => ({ tMs: i * 200, v }));
    const [result] = classifyResponders([{ did: 0x03, samples }], { gnssSpeedKph });
    expect(result?.kind).not.toBe('speed');
  });

  it('[REV1 counterexample] steering: [-100,0,100,0,-100] IS steering-like (crossing counted with prev<=0<curr, not prev*curr<0)', () => {
    const values = [-100, 0, 100, 0, -100];
    const samples: DidResponderSeries['samples'] = values.map((v, i) => {
      const raw = v < 0 ? v + 0x1_0000 : v;
      return { tMs: i * 200, raw: Uint8Array.from([(raw >> 8) & 0xff, raw & 0xff]) };
    });
    const [result] = classifyResponders([{ did: 0x04, samples }]);
    expect(result?.kind).toBe('steering');
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

  it('[REV1 fix] rejects an out-of-range DID, an empty date, and a forbidden channel instead of returning an invalid spec', () => {
    const valid: DidHeuristicSuggestion = { did: 0x1e1c, kind: 'temperature', confidence: 0.9, decode: 'u8-40', rationale: '' };
    expect(() => enetSpecsFromSuggestion({ ...valid, did: 0x10000 }, 'engineOilC', '2026-08-27')).toThrow(RangeError);
    expect(() => enetSpecsFromSuggestion(valid, 'engineOilC', '')).toThrow();
    expect(() => enetSpecsFromSuggestion(valid, 'engineOilC', '   ')).toThrow();
    expect(() => enetSpecsFromSuggestion(valid, 'latG', '2026-08-27')).toThrow(); // forbidden device-sensor channel
  });
});

describe('simulator DID table (DEFAULT_ENET_DID_SCENARIO)', () => {
  // NOT a round-trip through classifyResponders (the classifier's own
  // fixtures above are independent of these functions) -- this only checks
  // the simulator's own contract: deterministic given the same scenario
  // time, as `SimulatedEnetTransport` requires for reproducible tests/preview.
  it('every scripted DID is a deterministic pure function of scenario time', () => {
    for (const script of DEFAULT_ENET_DID_SCENARIO) {
      for (const tMs of [0, 1_234, 50_000]) {
        expect(script.encodeDataBytes(tMs)).toEqual(script.encodeDataBytes(tMs));
      }
    }
  });
});
