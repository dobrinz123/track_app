import { describe, expect, it } from 'vitest';
import { SIGNAL_TARGET_CATALOGS, findSignalTarget, resolveSignalTargetCatalog } from '@circuit/core';
import {
  discoverySweepParamsForTarget,
  formatDidRange,
  sweepRangeDraftsFromParams,
} from '../../src/session/signalFinderController';
import { SIGNAL_FINDER_SCREEN_STRINGS } from '../../src/ui/screens/signalFinderStrings';

/**
 * Ticket P4p G3 (binding, field test 9): both steering finds re-read the same
 * handful of known DIDs and found nothing, because the ONLY place the steering
 * angle can still be is the unswept `0x29 0x58F3–0x6FFF` discovery range. The
 * finder already SAID so in its next-step line -- prose the driver could not
 * act on. It becomes a button that runs the existing DID sweep with that range
 * prefilled (navigation params, not a second sweep implementation).
 *
 * Tested at the view-model/navigation-params level: this repo has no
 * `@testing-library/react-native`, so what is pinned is the params the row
 * produces and the drafts the sweep screen hydrates from them.
 */

const SUPRA = resolveSignalTargetCatalog('toyota-supra-b58');

describe('P4p G3 -- the scan params a steering row hands the DID sweep', () => {
  it('names the FIRST unswept discovery range of the Supra steering target', () => {
    const target = findSignalTarget(SUPRA, 'steeringAngle');
    expect(target).not.toBeNull();
    const params = discoverySweepParamsForTarget(target!, 12.3);
    expect(params).toEqual({
      ecu: 0x29,
      fromDid: 0x58f3,
      toDid: 0x6fff,
      estimatedMinutes: expect.any(Number),
    });
    expect(params!.estimatedMinutes).toBeGreaterThan(0);
  });

  it('is null for a target that has no discovery range left to offer', () => {
    expect(
      discoverySweepParamsForTarget(
        { ...findSignalTarget(SUPRA, 'steeringAngle')!, discoveryRanges: [] },
        12.3,
      ),
    ).toBeNull();
  });

  it('every bundled catalog target either offers a scan or has no ranges at all (no half-built rows)', () => {
    for (const catalog of SIGNAL_TARGET_CATALOGS) {
      for (const target of catalog.targets) {
        const params = discoverySweepParamsForTarget(target, 12.3);
        if (target.discoveryRanges.length === 0) expect(params).toBeNull();
        else expect(params).not.toBeNull();
      }
    }
  });
});

describe('P4p G3 -- the DID sweep screen hydrates its range drafts from those params', () => {
  it('prefills the range the finder asked for', () => {
    expect(sweepRangeDraftsFromParams({ fromDid: 0x58f3, toDid: 0x6fff })).toEqual({ from: '58F3', to: '6FFF' });
  });

  it('falls back to the screen s own full-range defaults when it was opened directly', () => {
    expect(sweepRangeDraftsFromParams(undefined)).toEqual({ from: '0000', to: 'FFFF' });
    expect(sweepRangeDraftsFromParams({})).toEqual({ from: '0000', to: 'FFFF' });
  });

  it('ignores a malformed param rather than starting a sweep over a nonsense range', () => {
    expect(sweepRangeDraftsFromParams({ fromDid: -1, toDid: 0x1_0000 })).toEqual({ from: '0000', to: 'FFFF' });
  });
});

describe('P4p G3 -- the button text, in both languages', () => {
  it('reads as the concrete action, with the range, the estimate and the engine state', () => {
    expect(formatDidRange(0x58f3, 0x6fff)).toBe('58F3–6FFF');
    expect(SIGNAL_FINDER_SCREEN_STRINGS.en.scanRange('0x29', '58F3–6FFF', 8)).toBe(
      'Scan 0x29 58F3–6FFF (≈ 8 min, engine off)',
    );
    expect(SIGNAL_FINDER_SCREEN_STRINGS.ro.scanRange('0x29', '58F3–6FFF', 8)).toBe(
      'Scanează 0x29 58F3–6FFF (≈ 8 min, motor oprit)',
    );
  });
});
