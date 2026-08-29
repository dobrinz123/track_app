import { describe, expect, it } from 'vitest';
import {
  GENERIC_SIGNAL_TARGET_CATALOG,
  SIGNAL_TARGET_CATALOGS,
  SIGNAL_TARGET_IDS,
  estimateSweepMinutes,
  findSignalTarget,
  nextDiscoveryStep,
  resolveSignalTargetCatalog,
  targetHypothesisEcus,
  resolveSignalActionVerbs,
  resolveSignalTargetLabel,
  resolveDiscoveryRangeNote,
} from '../../../src/telemetry/signalFinder';

/**
 * Ticket P4l / contracts.md "Signal Finder (Phase 4l)" item 1 (binding):
 * "Targets are data ... never UI constants: brakeSwitch, brakePressure,
 * steeringAngle, accelPedal, longG, latG. Each target declares
 * engineRequirement, actionScript, expectedShape, and sources: hypothesis
 * DIDs per ECU (with provenance) + discoveryRanges per ECU (used ONLY when
 * the user asks for the next step, with the minutes shown)."
 */

describe('signal target catalog (data)', () => {
  it('declares all six targets in every catalog', () => {
    expect([...SIGNAL_TARGET_IDS]).toEqual([
      'brakeSwitch',
      'brakePressure',
      'steeringAngle',
      'accelPedal',
      'longG',
      'latG',
    ]);
    for (const catalog of SIGNAL_TARGET_CATALOGS) {
      expect(catalog.targets.map((t) => t.id).sort()).toEqual([...SIGNAL_TARGET_IDS].sort());
    }
  });

  it('the GENERIC catalog (unknown car) is hypothesis-free -- discovery ranges only', () => {
    for (const target of GENERIC_SIGNAL_TARGET_CATALOG.targets) {
      expect(target.hypotheses).toEqual([]);
      expect(target.discoveryRanges.length).toBeGreaterThan(0);
    }
    expect(resolveSignalTargetCatalog('some-car-nobody-has-profiled')).toBe(GENERIC_SIGNAL_TARGET_CATALOG);
    expect(resolveSignalTargetCatalog(null)).toBe(GENERIC_SIGNAL_TARGET_CATALOG);
  });

  it('the Supra B58 catalog carries the profile s field hypotheses WITH provenance and status', () => {
    const catalog = resolveSignalTargetCatalog('toyota-supra-b58');
    expect(catalog.profileId).toBe('toyota-supra-b58');
    const brake = findSignalTarget(catalog, 'brakeSwitch');
    expect(brake).not.toBeNull();
    // data/vehicle-profiles/toyota-supra-b58.draft.json: 0x29 DID 0x500C,
    // 1 byte, "bit0 (0x04 released -> 0x05 pressed)", field-observed.
    const observed = brake!.hypotheses.find((h) => h.ecu === 0x29 && h.did === 0x500c);
    expect(observed).toMatchObject({ length: 1, status: 'field-observed' });
    expect(observed!.provenance).toMatch(/test 4/i);
    for (const target of catalog.targets) {
      for (const hypothesis of target.hypotheses) {
        expect(hypothesis.provenance.length).toBeGreaterThan(10);
      }
    }
  });

  it('every target declares its engine requirement and expected shape', () => {
    const catalog = resolveSignalTargetCatalog('toyota-supra-b58');
    expect(findSignalTarget(catalog, 'brakeSwitch')).toMatchObject({
      engineRequirement: 'off-ok',
      expectedShape: 'boolean-edge',
    });
    expect(findSignalTarget(catalog, 'brakePressure')?.expectedShape).toBe('analog-monotone');
    expect(findSignalTarget(catalog, 'steeringAngle')?.expectedShape).toBe('analog-bipolar');
    // Lateral acceleration cannot be produced in a stationary car.
    expect(findSignalTarget(catalog, 'latG')?.engineRequirement).toBe('running');
    // Field facts 2026-08-29: no booster vacuum / EPS unpowered with the engine off.
    expect(findSignalTarget(catalog, 'brakePressure')?.engineRequirement).toBe('running');
    expect(findSignalTarget(catalog, 'steeringAngle')?.engineRequirement).toBe('running');
    expect(findSignalTarget(catalog, 'brakeSwitch')?.engineRequirement).toBe('off-ok');
  });

  it('targetHypothesisEcus lists each ECU once, in ascending address order', () => {
    const catalog = resolveSignalTargetCatalog('toyota-supra-b58');
    // P4m M5: the brake now has a DME (0x12) hypothesis too -- field test 5's
    // own 0x4002 -- alongside the 0x29 one from test 4.
    expect(targetHypothesisEcus(findSignalTarget(catalog, 'brakeSwitch')!)).toEqual([0x12, 0x29]);
    expect(targetHypothesisEcus(findSignalTarget(catalog, 'brakePressure')!)).toEqual([0x12]);
    expect(targetHypothesisEcus(GENERIC_SIGNAL_TARGET_CATALOG.targets[0]!)).toEqual([]);
  });
});

describe('next concrete step (honesty, item 4)', () => {
  it('estimateSweepMinutes derives the duration from the MEASURED request rate', () => {
    // 0x58F3..0x6FFF = 6413 DIDs at the field-measured ~15.8 req/s.
    expect(estimateSweepMinutes(6_413, 15.8)).toBeCloseTo(6.76, 1);
    expect(estimateSweepMinutes(6_413, 0)).toBeGreaterThan(0); // a non-positive rate falls back, never divides by zero.
    expect(estimateSweepMinutes(0, 15.8)).toBe(0);
  });

  it('names the next unswept ECU range with its minutes and engine state', () => {
    const catalog = resolveSignalTargetCatalog('toyota-supra-b58');
    const step = nextDiscoveryStep(findSignalTarget(catalog, 'steeringAngle')!, 15.8);
    expect(step).not.toBeNull();
    expect(step!.ecu).toBe(0x29);
    expect(step!.fromDid).toBe(0x58f3);
    expect(step!.toDid).toBe(0x6fff);
    expect(step!.didCount).toBe(0x6fff - 0x58f3 + 1);
    expect(step!.estimatedMinutes).toBeGreaterThan(5);
    expect(step!.engineRequirement).toBe('off-ok');
  });

  it('skips ranges on ECUs the caller has already covered', () => {
    const catalog = resolveSignalTargetCatalog('toyota-supra-b58');
    const target = findSignalTarget(catalog, 'steeringAngle')!;
    const first = nextDiscoveryStep(target, 15.8)!;
    expect(first.ecu).not.toBeNull();
    const second = nextDiscoveryStep(target, 15.8, [first.ecu as number]);
    expect(second === null || second.ecu !== first.ecu).toBe(true);
  });
});

/**
 * Ticket P4m M5 (binding): the two channels field test 5 actually observed on
 * the DME, with their provenance, and the 0x29 pair kept as secondary.
 */
describe('Supra catalog after field test 5 (P4m M5)', () => {
  const catalog = resolveSignalTargetCatalog('toyota-supra-b58');

  it('the brake leads with the DME 0x4002 boolean (0x01 rest -> 0x19 pressed), keeping 0x29 0x500C/0x500B behind it', () => {
    const brake = findSignalTarget(catalog, 'brakeSwitch')!;
    expect(brake.hypotheses.map((h) => [h.ecu, h.did])).toEqual([
      [0x12, 0x4002],
      [0x29, 0x500c],
      [0x29, 0x500b],
    ]);
    const dme = brake.hypotheses[0]!;
    expect(dme).toMatchObject({ length: 1, status: 'field-observed' });
    expect(dme.decode).toContain('0x01');
    expect(dme.decode).toContain('0x19');
    expect(dme.provenance).toMatch(/field test 5/i);
    expect(dme.provenance).toContain('2026-08-29-brakeSwitch.json');
  });

  it('the accelerator leads with the DME 0x4007 idle flag (bit0), and 0x4659 is downgraded to weak (engine-running only)', () => {
    const accel = findSignalTarget(catalog, 'accelPedal')!;
    expect(accel.hypotheses.map((h) => [h.ecu, h.did])).toEqual([
      [0x12, 0x4007],
      [0x12, 0x4659],
    ]);
    expect(accel.hypotheses[0]).toMatchObject({ length: 2, status: 'field-observed' });
    expect(accel.hypotheses[0]!.decode).toMatch(/bit0/i);
    expect(accel.hypotheses[0]!.provenance).toContain('2026-08-29-accelPedal.json');
    expect(accel.hypotheses[1]).toMatchObject({ did: 0x4659, status: 'weak' });
  });

  /**
   * P4m-FIX1 X6 (Codex P4m-REV1 finding 7): the flag exception under an
   * ANALOG target is data-driven -- DME 0x4007 is a boolean flag inside a
   * word, and it says so in the catalog rather than being inferred from the
   * XOR shape of whatever samples arrived.
   */
  it('X6: 0x4007 declares itself a boolean-edge flag hypothesis, 0x4659 does not', () => {
    const accel = findSignalTarget(catalog, 'accelPedal')!;
    expect(accel.hypotheses[0]).toMatchObject({ did: 0x4007, expectedShape: 'boolean-edge' });
    expect(accel.hypotheses[1]!.expectedShape).toBeUndefined();
    expect(accel.expectedShape).toBe('analog-monotone'); // the TARGET is still an analog pedal.
  });

  /** P4m-FIX1 X8 (Codex finding 9): nothing the driver reads may be English-only, catalog data included. */
  it('X8: every target label and every discovery-range note has an RO variant', () => {
    for (const entry of [...SIGNAL_TARGET_CATALOGS]) {
      for (const target of entry.targets) {
        expect(resolveSignalTargetLabel(target, 'en')).toBe(target.label);
        expect(resolveSignalTargetLabel(target, 'ro').length).toBeGreaterThan(1);
        expect(resolveSignalTargetLabel(target, 'ro')).not.toBe(resolveSignalTargetLabel(target, 'en'));
        for (const range of target.discoveryRanges) {
          expect(resolveDiscoveryRangeNote(range, 'ro').length).toBeGreaterThan(1);
          expect(resolveDiscoveryRangeNote(range, 'ro')).not.toBe(resolveDiscoveryRangeNote(range, 'en'));
          expect(resolveDiscoveryRangeNote(range, 'en')).toBe(range.note);
        }
      }
    }
  });

  it('X8: nextDiscoveryStep carries the note in the language it was asked for', () => {
    const target = findSignalTarget(catalog, 'steeringAngle')!;
    const en = nextDiscoveryStep(target, 15.8, [], 'en')!;
    const ro = nextDiscoveryStep(target, 15.8, [], 'ro')!;
    expect(ro.note).not.toBe(en.note);
    expect(nextDiscoveryStep(target, 15.8)!.note).toBe(en.note); // default stays English.
  });

  it('every target still carries both languages for every metronome step', () => {
    for (const target of [...catalog.targets, ...GENERIC_SIGNAL_TARGET_CATALOG.targets]) {
      for (const language of ['en', 'ro'] as const) {
        const verbs = resolveSignalActionVerbs(target, language);
        for (const step of ['baseline', 'press', 'hold', 'release'] as const) {
          expect(verbs[step].length).toBeGreaterThan(1);
        }
      }
      expect(resolveSignalActionVerbs(target, 'ro')).not.toEqual(resolveSignalActionVerbs(target, 'en'));
    }
  });
});
