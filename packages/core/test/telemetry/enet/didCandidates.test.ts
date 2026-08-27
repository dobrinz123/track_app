import { describe, expect, it } from 'vitest';
import {
  filterSweepCandidates,
  isAsciiLike,
  selectChangingCandidates,
  type DidChangeSamplePair,
} from '../../../src/telemetry/enet/didCandidates';
import type { DidSweepResponder } from '../../../src/telemetry/enet/didSweep';

function responder(did: number, raw: Uint8Array, rttMs = 20): DidSweepResponder {
  return { did, raw, length: raw.length, rttMs };
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text.split('').map((c) => c.charCodeAt(0)));
}

/**
 * DID sweep — results persistence, export & candidate filtering addendum
 * (2026-08-27, binding — Phase 4i). Field shapes from the sweep test
 * (`.foreman/ledger.md`, contracts.md): 0x4097 (200+ byte software/coding
 * table blob), 0x4098 (ASCII software identification string), 0x1002 (a
 * short 6-byte plausible-candidate responder).
 */
describe('isAsciiLike (Field revision, binding, P4i)', () => {
  it('a short (< 4 byte) response is NEVER ASCII-like, regardless of content', () => {
    expect(isAsciiLike(ascii('AB'))).toBe(false); // 2 printable bytes -- would be 100% printable, but too short to judge.
    expect(isAsciiLike(Uint8Array.from([0x00, 0x00, 0x00]))).toBe(false);
  });

  it('0x4098-shaped: an 8-byte printable ASCII identification string is ASCII-like', () => {
    const bytes = ascii('SW1.2.34'); // 8 chars, all printable ASCII.
    expect(isAsciiLike(bytes)).toBe(true);
  });

  it('a 6-byte non-ASCII (binary) response is NOT ASCII-like', () => {
    const bytes = Uint8Array.from([0x00, 0x1a, 0xff, 0x03, 0x22, 0x59]); // mostly control/high bytes.
    expect(isAsciiLike(bytes)).toBe(false);
  });

  it('honors a custom threshold', () => {
    // 4 bytes, 2 printable ('A','B') + 2 non-printable -- exactly 50%.
    const bytes = Uint8Array.from([0x41, 0x42, 0x00, 0x01]);
    expect(isAsciiLike(bytes, 0.6)).toBe(false);
    expect(isAsciiLike(bytes, 0.5)).toBe(true);
  });
});

describe('filterSweepCandidates (Field revision, binding, P4i)', () => {
  it('0x4098 (ASCII software ID blob, 8 bytes) is EXCLUDED -- ASCII-like, even though its length alone would pass', () => {
    const responders = [responder(0x4098, ascii('SW1.2.34'))];
    expect(filterSweepCandidates(responders)).toEqual([]);
  });

  it('0x4097 (200+ byte software/coding table) is EXCLUDED -- too long, regardless of content', () => {
    const bigBlob = new Uint8Array(220);
    for (let i = 0; i < bigBlob.length; i += 1) bigBlob[i] = i % 256; // non-ASCII-shaped (mostly outside printable range).
    const responders = [responder(0x4097, bigBlob)];
    expect(filterSweepCandidates(responders)).toEqual([]);
  });

  it('0x1002 (6-byte non-ASCII responder) is KEPT', () => {
    const bytes = Uint8Array.from([0x00, 0x1a, 0x2b, 0x00, 0x59, 0x00]);
    const responders = [responder(0x1002, bytes)];
    expect(filterSweepCandidates(responders)).toEqual(responders);
  });

  it('a mixed batch keeps only the plausible candidates, in the SAME order', () => {
    const keep1002 = responder(0x1002, Uint8Array.from([0x00, 0x1a, 0x2b, 0x00, 0x59, 0x00]));
    const drop4098 = responder(0x4098, ascii('SW1.2.34'));
    const bigBlob = new Uint8Array(200);
    const drop4097 = responder(0x4097, bigBlob);
    const keepShort = responder(0x0001, Uint8Array.from([0x2a]));
    const result = filterSweepCandidates([drop4098, keep1002, drop4097, keepShort]);
    expect(result).toEqual([keep1002, keepShort]);
  });

  it('a zero-length responder is excluded (length must be >= 1)', () => {
    const responders = [responder(0x2000, new Uint8Array(0))];
    expect(filterSweepCandidates(responders)).toEqual([]);
  });

  it('a custom maxLen is honored (not hardcoded to 8)', () => {
    const responders = [responder(0x1002, Uint8Array.from([1, 2, 3, 4, 5]))];
    expect(filterSweepCandidates(responders, { maxLen: 4 })).toEqual([]);
    expect(filterSweepCandidates(responders, { maxLen: 5 })).toEqual(responders);
  });
});

describe('selectChangingCandidates (Field revision, binding, P4i: two-sample changing-values pre-pass)', () => {
  it('a DID whose bytes CHANGED between the two samples is selected', () => {
    const pairs: DidChangeSamplePair[] = [
      { did: 0x1002, first: Uint8Array.from([0x10]), second: Uint8Array.from([0x20]) },
    ];
    expect(selectChangingCandidates(pairs)).toEqual([0x1002]);
  });

  it('a STATIC responder whose value decodes into a plausible physical range (u8-40 temperature-like) is STILL selected', () => {
    // 0x59 = 89 -> 89-40 = 49 C, well within the -40..150 plausible range.
    const pairs: DidChangeSamplePair[] = [
      { did: 0x2001, first: Uint8Array.from([0x59]), second: Uint8Array.from([0x59]) },
    ];
    expect(selectChangingCandidates(pairs)).toEqual([0x2001]);
  });

  it('a STATIC responder whose value does NOT decode into any plausible range is DROPPED from candidates', () => {
    // 0xFF (255) -40 = 215, outside the -40..150 u8-40 range -- a sentinel/placeholder-looking static byte.
    const pairs: DidChangeSamplePair[] = [
      { did: 0x3001, first: Uint8Array.from([0xff]), second: Uint8Array.from([0xff]) },
    ];
    expect(selectChangingCandidates(pairs)).toEqual([]);
  });

  it('a mix of changing, plausible-static, and implausible-static DIDs -- only the first two are kept, in input order', () => {
    const pairs: DidChangeSamplePair[] = [
      { did: 0x1002, first: Uint8Array.from([0x10]), second: Uint8Array.from([0x20]) }, // changing.
      { did: 0x3001, first: Uint8Array.from([0xff]), second: Uint8Array.from([0xff]) }, // implausible static.
      { did: 0x2001, first: Uint8Array.from([0x59]), second: Uint8Array.from([0x59]) }, // plausible static.
    ];
    expect(selectChangingCandidates(pairs)).toEqual([0x1002, 0x2001]);
  });

  it('a 2-byte STATIC responder decoding via u16/10 into a plausible range (-40..300) is selected', () => {
    // 0x0BB8 = 3000 -> /10 = 300.0, at the boundary (still plausible).
    const bytes = Uint8Array.from([0x0b, 0xb8]);
    const pairs: DidChangeSamplePair[] = [{ did: 0x4001, first: bytes, second: bytes }];
    expect(selectChangingCandidates(pairs)).toEqual([0x4001]);
  });

  it('a length that matches no known decode at all (e.g. 3 bytes) and is static is dropped', () => {
    const bytes = Uint8Array.from([0x01, 0x02, 0x03]);
    const pairs: DidChangeSamplePair[] = [{ did: 0x5001, first: bytes, second: bytes }];
    expect(selectChangingCandidates(pairs)).toEqual([]);
  });
});
