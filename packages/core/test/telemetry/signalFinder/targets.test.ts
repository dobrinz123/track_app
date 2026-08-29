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
    expect(targetHypothesisEcus(findSignalTarget(catalog, 'brakeSwitch')!)).toEqual([0x29]);
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
