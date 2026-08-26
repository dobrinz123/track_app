import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  binaryStringToBytes,
  bytesToBinaryString,
  bytesToHex,
  decodeHsfzError,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  HsfzParseError,
  isHsfzErrorControl,
  type HsfzFrame,
} from '../../../src/telemetry/enet/hsfzCodec';

/**
 * Every vector below is HAND-BUILT from the addendum's documented layout
 * (`[length u32 BE][control u16 BE][source u8][target u8][payload]`, length
 * = 2 + payload.length) -- none are produced by the codec under test.
 */

// ReadDataByIdentifier request 0x22 0x1E 0x1C, source 0xF4, target 0x12.
// length = 2 (src+tgt) + 3 (payload) = 5.
const READ_DID_FRAME_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x05, // length = 5
  0x00, 0x01, // control = diagnostic req/res
  0xf4, // source
  0x12, // target
  0x22, 0x1e, 0x1c, // payload: ReadDataByIdentifier DID 0x1E1C
]);

// Alive check, source 0xF4, target 0x00, empty payload. length = 2 + 0 = 2.
const ALIVE_CHECK_FRAME_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x02, // length = 2
  0x00, 0x12, // control = alive check
  0xf4, // source
  0x00, // target
]);

// Error frame: unknown tester address (0x0040), source 0x00, target 0xF4, 2 arbitrary trailing bytes.
// length = 2 + 2 = 4.
const ERROR_FRAME_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x04, // length = 4
  0x00, 0x40, // control = error: unknown tester address
  0x00, // source
  0xf4, // target
  0xaa, 0xbb, // raw trailing bytes
]);

describe('encodeFrame', () => {
  it('matches the hand-built ReadDataByIdentifier vector', () => {
    const encoded = encodeFrame({
      control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
      source: 0xf4,
      target: 0x12,
      payload: Uint8Array.from([0x22, 0x1e, 0x1c]),
    });
    expect(encoded).toEqual(READ_DID_FRAME_BYTES);
  });

  it('matches the hand-built alive-check vector (empty payload)', () => {
    const encoded = encodeFrame({
      control: HSFZ_CONTROL.ALIVE_CHECK,
      source: 0xf4,
      target: 0x00,
      payload: new Uint8Array(0),
    });
    expect(encoded).toEqual(ALIVE_CHECK_FRAME_BYTES);
  });

  it('rejects an out-of-range control word, source, or target', () => {
    const base = { control: 0x0001, source: 0xf4, target: 0x12, payload: new Uint8Array(0) };
    expect(() => encodeFrame({ ...base, control: 0x10000 })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, source: 256 })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, target: -1 })).toThrow(RangeError);
  });

  it('rejects a payload that would push length past 65535', () => {
    expect(() => encodeFrame({ control: 1, source: 0, target: 0, payload: new Uint8Array(65_535) })).toThrow(
      RangeError,
    );
  });
});

describe('HsfzFrameParser', () => {
  it('decodes the hand-built ReadDataByIdentifier vector', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(READ_DID_FRAME_BYTES);
    expect(frame).toEqual<HsfzFrame>({
      control: 0x0001,
      source: 0xf4,
      target: 0x12,
      payload: Uint8Array.from([0x22, 0x1e, 0x1c]),
    });
  });

  it('decodes the hand-built alive-check vector', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(ALIVE_CHECK_FRAME_BYTES);
    expect(frame).toEqual<HsfzFrame>({ control: 0x0012, source: 0xf4, target: 0x00, payload: new Uint8Array(0) });
  });

  it('decodes the hand-built error-frame vector and isHsfzErrorControl/decodeHsfzError agree', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(ERROR_FRAME_BYTES);
    expect(frame).toBeDefined();
    expect(isHsfzErrorControl(frame!.control)).toBe(true);
    expect(decodeHsfzError(frame!)).toEqual({
      control: 0x0040,
      name: 'UNKNOWN_TESTER_ADDRESS',
      source: 0x00,
      target: 0xf4,
      raw: Uint8Array.from([0xaa, 0xbb]),
    });
  });

  it('decodeHsfzError returns null for a non-error control word', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(READ_DID_FRAME_BYTES);
    expect(decodeHsfzError(frame!)).toBeNull();
  });

  it('coalesces two frames delivered in a single chunk', () => {
    const parser = new HsfzFrameParser();
    const twoFrames = new Uint8Array(ALIVE_CHECK_FRAME_BYTES.length + READ_DID_FRAME_BYTES.length);
    twoFrames.set(ALIVE_CHECK_FRAME_BYTES, 0);
    twoFrames.set(READ_DID_FRAME_BYTES, ALIVE_CHECK_FRAME_BYTES.length);

    const frames = parser.push(twoFrames);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.control).toBe(0x0012);
    expect(frames[1]?.control).toBe(0x0001);
  });

  it('reassembles a frame fed one byte at a time', () => {
    const parser = new HsfzFrameParser();
    const frames: HsfzFrame[] = [];
    for (const byte of READ_DID_FRAME_BYTES) {
      frames.push(...parser.push(Uint8Array.from([byte])));
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual<HsfzFrame>({
      control: 0x0001,
      source: 0xf4,
      target: 0x12,
      payload: Uint8Array.from([0x22, 0x1e, 0x1c]),
    });
  });

  it('parses identically for every generated byte split (fragmentation/coalescing property)', () => {
    const stream = new Uint8Array(ALIVE_CHECK_FRAME_BYTES.length + READ_DID_FRAME_BYTES.length);
    stream.set(ALIVE_CHECK_FRAME_BYTES, 0);
    stream.set(READ_DID_FRAME_BYTES, ALIVE_CHECK_FRAME_BYTES.length);
    const expected: HsfzFrame[] = [
      { control: 0x0012, source: 0xf4, target: 0x00, payload: new Uint8Array(0) },
      { control: 0x0001, source: 0xf4, target: 0x12, payload: Uint8Array.from([0x22, 0x1e, 0x1c]) },
    ];

    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: stream.length - 1, maxLength: stream.length - 1 }),
        (splitAfter) => {
          const chunks: number[][] = [];
          let chunk: number[] = [stream[0] ?? 0];
          for (let index = 0; index < splitAfter.length; index += 1) {
            if (splitAfter[index]) {
              chunks.push(chunk);
              chunk = [];
            }
            chunk.push(stream[index + 1] ?? 0);
          }
          chunks.push(chunk);

          const parser = new HsfzFrameParser();
          const actual = chunks.flatMap((part) => parser.push(Uint8Array.from(part)));
          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects a declared length below the minimum (2) and drops the stream for resync', () => {
    const parser = new HsfzFrameParser();
    // length = 1 (impossible: a real frame's tail is at least source+target = 2 bytes).
    const malformed = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0xf4, 0x12]);
    let caught: unknown;
    try {
      parser.push(malformed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HsfzParseError);
    expect((caught as HsfzParseError).reason).toBe('LENGTH_TOO_SMALL');
    expect((caught as HsfzParseError).framesBeforeError).toEqual([]);

    // Resync proof: the parser's internal buffer was dropped, so a fresh
    // valid frame parses standalone afterward, unaffected by the malformed bytes.
    const frames = parser.push(ALIVE_CHECK_FRAME_BYTES);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.control).toBe(0x0012);
  });

  it('rejects a declared length above the maximum (65535)', () => {
    const parser = new HsfzFrameParser();
    // length = 0x000186A0 = 100000 > 65535.
    const malformed = Uint8Array.from([0x00, 0x01, 0x86, 0xa0, 0x00, 0x01, 0xf4, 0x12]);
    expect(() => parser.push(malformed)).toThrow(HsfzParseError);
    try {
      parser.push(malformed);
    } catch (error) {
      expect((error as HsfzParseError).reason).toBe('LENGTH_TOO_LARGE');
    }
  });

  it('returns frames already parsed before a malformed length in the SAME push call', () => {
    const parser = new HsfzFrameParser();
    const combined = new Uint8Array(ALIVE_CHECK_FRAME_BYTES.length + 4);
    combined.set(ALIVE_CHECK_FRAME_BYTES, 0);
    combined.set([0x00, 0x00, 0x00, 0x00], ALIVE_CHECK_FRAME_BYTES.length); // length = 0 -> too small

    let caught: HsfzParseError | undefined;
    try {
      parser.push(combined);
    } catch (error) {
      caught = error as HsfzParseError;
    }
    expect(caught).toBeDefined();
    expect(caught?.framesBeforeError).toHaveLength(1);
    expect(caught?.framesBeforeError[0]?.control).toBe(0x0012);
  });
});

describe('bytesToBinaryString / binaryStringToBytes', () => {
  it('round-trips every byte value 0-255 losslessly', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(binaryStringToBytes(bytesToBinaryString(bytes))).toEqual(bytes);
  });
});

describe('bytesToHex', () => {
  it('renders upper-case space-separated hex pairs', () => {
    expect(bytesToHex(Uint8Array.from([0x41, 0x0c, 0x1a, 0xf8]))).toBe('41 0C 1A F8');
  });
});
