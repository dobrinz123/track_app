import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  binaryStringToBytes,
  bytesToBinaryString,
  bytesToHex,
  decodeHsfzError,
  encodeAliveCheckLong,
  encodeAliveCheckShort,
  encodeErrorFrame,
  encodeFrame,
  encodeHsfzFrame,
  encodeOtherFrame,
  HSFZ_CONTROL,
  HSFZ_MAX_LENGTH,
  HsfzFrameParser,
  HsfzParseError,
  isHsfzErrorControl,
  type HsfzFrame,
} from '../../../src/telemetry/enet/hsfzCodec';

/**
 * Every vector below is HAND-BUILT from the addendum's documented,
 * control-specific layout (`[length u32 BE][control u16 BE][body]`, length =
 * body byte count) -- none are produced by the codec under test.
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

// Alive check, SHORT addressed form: source 0xF4, target 0x00. length = 2.
const ALIVE_CHECK_SHORT_FRAME_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x02, // length = 2
  0x00, 0x12, // control = alive check
  0xf4, // source
  0x00, // target
]);

// Review's cited error-frame vector: `[00 00 00 02 00 40 AA BB]`.
// Error frames carry [expected][received], NOT source/target.
const ERROR_FRAME_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x02, // length = 2
  0x00, 0x40, // control = error: unknown tester address
  0xaa, // expected
  0xbb, // received
]);

// Review's cited alive-check LONG (identification-string) vector:
// `[00 00 00 03 00 12 41 42 43]` -- length 3 (not 2) means this is the long
// identification form, opaque bytes "ABC", NOT an addressed src/tgt pair.
const ALIVE_CHECK_LONG_FRAME_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x03, // length = 3
  0x00, 0x12, // control = alive check
  0x41, 0x42, 0x43, // identification bytes "ABC"
]);

describe('encodeFrame (diagnostic/acknowledge layout: [source][target][payload])', () => {
  it('matches the hand-built ReadDataByIdentifier vector', () => {
    const encoded = encodeFrame({
      control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
      source: 0xf4,
      target: 0x12,
      payload: Uint8Array.from([0x22, 0x1e, 0x1c]),
    });
    expect(encoded).toEqual(READ_DID_FRAME_BYTES);
  });

  it('rejects an out-of-range control word, source, or target', () => {
    const base = { control: 0x0001, source: 0xf4, target: 0x12, payload: new Uint8Array(0) };
    expect(() => encodeFrame({ ...base, control: 0x10000 })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, source: 256 })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, target: -1 })).toThrow(RangeError);
  });

  it('rejects a payload that would push length past the max', () => {
    expect(() => encodeFrame({ control: 1, source: 0, target: 0, payload: new Uint8Array(65_535) })).toThrow(
      RangeError,
    );
  });
});

describe('HSFZ_MAX_LENGTH bound (binding amendment: 4096, not 65535)', () => {
  it('is 4096', () => {
    expect(HSFZ_MAX_LENGTH).toBe(4_096);
  });

  it('accepts a body exactly at the 4096 boundary', () => {
    const encoded = encodeFrame({
      control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
      source: 0xf4,
      target: 0x12,
      payload: new Uint8Array(HSFZ_MAX_LENGTH - 2), // + 2 (source/target) = 4096 exactly
    });
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(encoded);
    expect(frame?.kind).toBe('diagnostic');
  });

  it('rejects a body one byte past the 4096 boundary (encode and parse)', () => {
    expect(() =>
      encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: 0xf4,
        target: 0x12,
        payload: new Uint8Array(HSFZ_MAX_LENGTH - 1), // + 2 = 4097
      }),
    ).toThrow(RangeError);

    const parser = new HsfzFrameParser();
    const lengthTooLarge = new Uint8Array(8);
    new DataView(lengthTooLarge.buffer).setUint32(0, HSFZ_MAX_LENGTH + 1, false);
    expect(() => parser.push(lengthTooLarge)).toThrow(HsfzParseError);
  });
});

describe('control-specific alive-check encoders', () => {
  it('encodeAliveCheckShort matches the hand-built short-addressed vector', () => {
    const encoded = encodeAliveCheckShort({ source: 0xf4, target: 0x00 });
    expect(encoded).toEqual(ALIVE_CHECK_SHORT_FRAME_BYTES);
  });

  it('encodeAliveCheckLong matches the review-cited long identification vector', () => {
    const encoded = encodeAliveCheckLong({ identification: Uint8Array.from([0x41, 0x42, 0x43]) });
    expect(encoded).toEqual(ALIVE_CHECK_LONG_FRAME_BYTES);
  });

  it('encodeAliveCheckLong refuses a 2-byte identification (ambiguous with the short form)', () => {
    expect(() => encodeAliveCheckLong({ identification: Uint8Array.from([0x01, 0x02]) })).toThrow(RangeError);
  });

  it('a short alive-check request/reply round-trips through the short form, unchanged length', () => {
    // Review's concrete failing case: a short alive request must produce a
    // short (length=2) reply -- NOT a 3-byte frame with a spurious extra byte.
    const request = encodeAliveCheckShort({ source: 0x12, target: 0xf4 });
    const parser = new HsfzFrameParser();
    const [parsedRequest] = parser.push(request);
    expect(parsedRequest).toEqual<HsfzFrame>({
      kind: 'aliveCheck',
      control: 0x0012,
      form: 'short',
      source: 0x12,
      target: 0xf4,
    });

    // The addressed reply: tester address as source, echo the requester as target.
    const reply = encodeAliveCheckShort({ source: 0xf4, target: 0x12 });
    expect(reply.length).toBe(8); // 4 (length) + 2 (control) + 2 (body) -- length field stays 2, not 3.
    const [parsedReply] = new HsfzFrameParser().push(reply);
    expect(parsedReply).toEqual<HsfzFrame>({
      kind: 'aliveCheck',
      control: 0x0012,
      form: 'short',
      source: 0xf4,
      target: 0x12,
    });
  });
});

describe('encodeErrorFrame / encodeOtherFrame', () => {
  it('encodeErrorFrame matches the review-cited error vector', () => {
    const encoded = encodeErrorFrame({
      control: HSFZ_CONTROL.ERROR_UNKNOWN_TESTER_ADDRESS,
      expected: 0xaa,
      received: 0xbb,
    });
    expect(encoded).toEqual(ERROR_FRAME_BYTES);
  });

  it('encodeErrorFrame rejects a non-error control word', () => {
    expect(() =>
      encodeErrorFrame({ control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES, expected: 0, received: 0 }),
    ).toThrow(RangeError);
  });

  it('encodeOtherFrame round-trips an opaque payload for an unaddressed control word', () => {
    const encoded = encodeOtherFrame({
      control: HSFZ_CONTROL.VEHICLE_IDENT_DATA,
      payload: Uint8Array.from([0x56, 0x49, 0x4e]),
    });
    const [frame] = new HsfzFrameParser().push(encoded);
    expect(frame).toEqual<HsfzFrame>({
      kind: 'other',
      control: HSFZ_CONTROL.VEHICLE_IDENT_DATA,
      payload: Uint8Array.from([0x56, 0x49, 0x4e]),
    });
  });
});

describe('HsfzFrameParser', () => {
  it('decodes the hand-built ReadDataByIdentifier vector as a diagnostic frame', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(READ_DID_FRAME_BYTES);
    expect(frame).toEqual<HsfzFrame>({
      kind: 'diagnostic',
      control: 0x0001,
      source: 0xf4,
      target: 0x12,
      payload: Uint8Array.from([0x22, 0x1e, 0x1c]),
    });
  });

  it('decodes the hand-built short alive-check vector', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(ALIVE_CHECK_SHORT_FRAME_BYTES);
    expect(frame).toEqual<HsfzFrame>({ kind: 'aliveCheck', control: 0x0012, form: 'short', source: 0xf4, target: 0x00 });
  });

  it('decodes the review-cited long alive-check identification vector, NOT as src/tgt', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(ALIVE_CHECK_LONG_FRAME_BYTES);
    expect(frame).toEqual<HsfzFrame>({
      kind: 'aliveCheck',
      control: 0x0012,
      form: 'long',
      identification: Uint8Array.from([0x41, 0x42, 0x43]),
    });
  });

  it('decodes the review-cited error vector as expected/received, never fabricating source/target', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(ERROR_FRAME_BYTES);
    expect(frame).toBeDefined();
    expect(isHsfzErrorControl(frame!.control)).toBe(true);
    expect(decodeHsfzError(frame!)).toEqual({
      kind: 'error',
      control: 0x0040,
      code: 0x0040,
      name: 'UNKNOWN_TESTER_ADDRESS',
      expected: 0xaa,
      received: 0xbb,
      raw: Uint8Array.from([0xaa, 0xbb]),
    });
    // The bug this replaces: source/target must NOT appear on an error frame.
    expect(frame).not.toHaveProperty('source');
    expect(frame).not.toHaveProperty('target');
  });

  it('decodeHsfzError returns null for a non-error control word', () => {
    const parser = new HsfzFrameParser();
    const [frame] = parser.push(READ_DID_FRAME_BYTES);
    expect(decodeHsfzError(frame!)).toBeNull();
  });

  it('coalesces two frames of different kinds delivered in a single chunk', () => {
    const parser = new HsfzFrameParser();
    const twoFrames = new Uint8Array(ALIVE_CHECK_SHORT_FRAME_BYTES.length + READ_DID_FRAME_BYTES.length);
    twoFrames.set(ALIVE_CHECK_SHORT_FRAME_BYTES, 0);
    twoFrames.set(READ_DID_FRAME_BYTES, ALIVE_CHECK_SHORT_FRAME_BYTES.length);

    const frames = parser.push(twoFrames);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.kind).toBe('aliveCheck');
    expect(frames[1]?.kind).toBe('diagnostic');
  });

  it('reassembles a frame fed one byte at a time', () => {
    const parser = new HsfzFrameParser();
    const frames: HsfzFrame[] = [];
    for (const byte of READ_DID_FRAME_BYTES) {
      frames.push(...parser.push(Uint8Array.from([byte])));
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual<HsfzFrame>({
      kind: 'diagnostic',
      control: 0x0001,
      source: 0xf4,
      target: 0x12,
      payload: Uint8Array.from([0x22, 0x1e, 0x1c]),
    });
  });

  it('parses identically for every generated byte split (fragmentation/coalescing property)', () => {
    const stream = new Uint8Array(ALIVE_CHECK_SHORT_FRAME_BYTES.length + READ_DID_FRAME_BYTES.length);
    stream.set(ALIVE_CHECK_SHORT_FRAME_BYTES, 0);
    stream.set(READ_DID_FRAME_BYTES, ALIVE_CHECK_SHORT_FRAME_BYTES.length);
    const expected: HsfzFrame[] = [
      { kind: 'aliveCheck', control: 0x0012, form: 'short', source: 0xf4, target: 0x00 },
      { kind: 'diagnostic', control: 0x0001, source: 0xf4, target: 0x12, payload: Uint8Array.from([0x22, 0x1e, 0x1c]) },
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
    // length = 1 (impossible: the smallest real body is 2 bytes).
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

    // Resync proof (parser-level only): the parser's internal buffer was
    // dropped, so a fresh valid frame parses standalone afterward on the SAME
    // instance. This is a property of the pure codec class only -- the
    // session engine deliberately does NOT keep using its parser this way
    // after a fatal error (see enetSession.test.ts's M1 coverage).
    const frames = parser.push(ALIVE_CHECK_SHORT_FRAME_BYTES);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('aliveCheck');
  });

  it('rejects a declared length above the maximum (4096)', () => {
    const parser = new HsfzFrameParser();
    // length = 0x000186A0 = 100000 > 4096.
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
    const combined = new Uint8Array(ALIVE_CHECK_SHORT_FRAME_BYTES.length + 4);
    combined.set(ALIVE_CHECK_SHORT_FRAME_BYTES, 0);
    combined.set([0x00, 0x00, 0x00, 0x00], ALIVE_CHECK_SHORT_FRAME_BYTES.length); // length = 0 -> too small

    let caught: HsfzParseError | undefined;
    try {
      parser.push(combined);
    } catch (error) {
      caught = error as HsfzParseError;
    }
    expect(caught).toBeDefined();
    expect(caught?.framesBeforeError).toHaveLength(1);
    expect(caught?.framesBeforeError[0]?.kind).toBe('aliveCheck');
  });
});

describe('encodeHsfzFrame (round-trips a decoded frame back to wire bytes for every kind)', () => {
  it('round-trips diagnostic, alive-check (both forms), error, and other frames', () => {
    for (const bytes of [READ_DID_FRAME_BYTES, ALIVE_CHECK_SHORT_FRAME_BYTES, ALIVE_CHECK_LONG_FRAME_BYTES, ERROR_FRAME_BYTES]) {
      const [frame] = new HsfzFrameParser().push(bytes);
      expect(encodeHsfzFrame(frame!)).toEqual(bytes);
    }
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
