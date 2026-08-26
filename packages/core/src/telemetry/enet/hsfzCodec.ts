/**
 * HSFZ (BMW ENET) frame codec -- pure encode/decode, no I/O.
 *
 * Frame layout (verified from primary sources, see
 * `.foreman/scratch/enet-protocol-research.md` #1a/#1b; reimplemented from the
 * documented layout, NO code copied from scapy/ediabaslib -- both GPL):
 *
 *   [length  u32 BE][control u16 BE][body bytes, `length` of them...]
 *
 * `length` counts everything AFTER the control word. Total wire size of one
 * frame is therefore `4 + 2 + length` bytes.
 *
 * The BODY layout is CONTROL-SPECIFIC (contracts.md ENET addendum, "framing &
 * correlation amendment"), not one universal `[source][target][payload]`
 * shape:
 *   - 0x0001 diagnostic req/res and 0x0002 acknowledge: `[source][target][UDS PDU / echoed head]`.
 *   - 0x0012 alive check: EITHER the short addressed form `[source][target]`
 *     (body length exactly 2) OR a long identification-string form (opaque
 *     bytes, any other body length) -- there is no reliable way to tell them
 *     apart except by length, per the cited scapy reference.
 *   - 0x0040-0x0045 error frames: `[expected][received]` bytes -- NOT
 *     addresses. No source/target exists for these.
 *   - everything else (0x0010 terminal15, 0x0011 vehicle-ident, 0x0013
 *     status, 0x00FF out-of-memory, and any unrecognized control word):
 *     opaque payload, no source/target fabricated.
 *
 * `HsfzFrame` is therefore a discriminated union keyed by `kind` (with
 * `control` kept on every variant so a caller can still switch/compare on the
 * raw control word). The parser never invents source/target fields for a
 * frame type that does not carry them.
 */

export const HSFZ_CONTROL = {
  DIAGNOSTIC_REQ_RES: 0x0001,
  ACKNOWLEDGE: 0x0002,
  TERMINAL_15: 0x0010,
  VEHICLE_IDENT_DATA: 0x0011,
  ALIVE_CHECK: 0x0012,
  STATUS_DATA_INQUIRY: 0x0013,
  ERROR_UNKNOWN_TESTER_ADDRESS: 0x0040,
  ERROR_UNKNOWN_CONTROL_WORD: 0x0041,
  ERROR_FORMAT_ERROR: 0x0042,
  ERROR_UNKNOWN_DESTINATION_ADDRESS: 0x0043,
  ERROR_MESSAGE_TOO_LARGE: 0x0044,
  ERROR_APPLICATION_NOT_READY: 0x0045,
  OUT_OF_MEMORY: 0x00ff,
} as const;

export type HsfzControlWord = (typeof HSFZ_CONTROL)[keyof typeof HSFZ_CONTROL];

/**
 * Inclusive bounds for a well-formed frame's `length` field (see module
 * doc). The wire field itself is a u32; the binding amendment caps the
 * APP-LEVEL accepted length at 4096 (not the u32's own ceiling) -- any
 * diagnostic PDU this app sends or expects is far below that. A length below
 * 2 is impossible for any real frame (the smallest body, a short alive-check
 * address pair or a 2-byte error expected/received pair, is 2 bytes).
 */
export const HSFZ_MIN_LENGTH = 2;
export const HSFZ_MAX_LENGTH = 4_096;

const ERROR_CONTROL_NAMES: Readonly<Record<number, string>> = {
  [HSFZ_CONTROL.ERROR_UNKNOWN_TESTER_ADDRESS]: 'UNKNOWN_TESTER_ADDRESS',
  [HSFZ_CONTROL.ERROR_UNKNOWN_CONTROL_WORD]: 'UNKNOWN_CONTROL_WORD',
  [HSFZ_CONTROL.ERROR_FORMAT_ERROR]: 'FORMAT_ERROR',
  [HSFZ_CONTROL.ERROR_UNKNOWN_DESTINATION_ADDRESS]: 'UNKNOWN_DESTINATION_ADDRESS',
  [HSFZ_CONTROL.ERROR_MESSAGE_TOO_LARGE]: 'MESSAGE_TOO_LARGE',
  [HSFZ_CONTROL.ERROR_APPLICATION_NOT_READY]: 'APPLICATION_NOT_READY',
};

export function isHsfzErrorControl(control: number): boolean {
  return (
    control >= HSFZ_CONTROL.ERROR_UNKNOWN_TESTER_ADDRESS && control <= HSFZ_CONTROL.ERROR_APPLICATION_NOT_READY
  );
}

// ---------- Discriminated frame union ----------

/**
 * `control`'s type on each variant below is deliberately the SPECIFIC
 * literal(s) that kind can carry (not a bare `number`) so the union
 * discriminates on EITHER `kind` or `control` -- a caller that only ever
 * checks `frame.control === HSFZ_CONTROL.DIAGNOSTIC_REQ_RES` (as an
 * existing consumer does, comparing against the raw control word rather
 * than `kind`) still gets a fully narrowed `HsfzDiagnosticFrame` from that
 * check alone, with every one of its fields (`source`/`target`/`payload`)
 * available -- exactly what the OLD flat `HsfzFrame` shape provided.
 */

/** 0x0001 diagnostic request/response, or 0x0002 acknowledge (same `[source][target][...]` layout per the addendum). */
export interface HsfzDiagnosticFrame {
  kind: 'diagnostic';
  control: typeof HSFZ_CONTROL.DIAGNOSTIC_REQ_RES | typeof HSFZ_CONTROL.ACKNOWLEDGE;
  source: number;
  target: number;
  /** The UDS PDU (0x0001), or the adapter's echoed request head (0x0002 acknowledge). */
  payload: Uint8Array;
}

/** 0x0012 alive check, short addressed form: body is exactly `[source][target]`. */
export interface HsfzAliveCheckShortFrame {
  kind: 'aliveCheck';
  control: typeof HSFZ_CONTROL.ALIVE_CHECK;
  form: 'short';
  source: number;
  target: number;
}

/** 0x0012 alive check, long identification-string form: body is any length other than 2, opaque bytes. */
export interface HsfzAliveCheckLongFrame {
  kind: 'aliveCheck';
  control: typeof HSFZ_CONTROL.ALIVE_CHECK;
  form: 'long';
  identification: Uint8Array;
}

export type HsfzAliveCheckFrame = HsfzAliveCheckShortFrame | HsfzAliveCheckLongFrame;

type HsfzErrorControlWord =
  | typeof HSFZ_CONTROL.ERROR_UNKNOWN_TESTER_ADDRESS
  | typeof HSFZ_CONTROL.ERROR_UNKNOWN_CONTROL_WORD
  | typeof HSFZ_CONTROL.ERROR_FORMAT_ERROR
  | typeof HSFZ_CONTROL.ERROR_UNKNOWN_DESTINATION_ADDRESS
  | typeof HSFZ_CONTROL.ERROR_MESSAGE_TOO_LARGE
  | typeof HSFZ_CONTROL.ERROR_APPLICATION_NOT_READY;

/** 0x0040-0x0045 error frame: `[expected][received]` bytes, no source/target. */
export interface HsfzErrorFrame {
  kind: 'error';
  control: HsfzErrorControlWord;
  /** Same value as `control` -- named per the binding spec's `{code, expected, received, raw}` shape. */
  code: HsfzErrorControlWord;
  name: string;
  expected: number;
  received: number;
  /** The full body bytes (>= 2). Equal to `[expected, received]` for the common 2-byte case; kept in full for any longer, not-independently-confirmed variant. */
  raw: Uint8Array;
}

type HsfzOtherControlWord =
  | typeof HSFZ_CONTROL.TERMINAL_15
  | typeof HSFZ_CONTROL.VEHICLE_IDENT_DATA
  | typeof HSFZ_CONTROL.STATUS_DATA_INQUIRY
  | typeof HSFZ_CONTROL.OUT_OF_MEMORY;

/** Anything else (0x0010 terminal15, 0x0011 vehicle-ident, 0x0013 status, 0x00FF OOM, or an unrecognized control word): opaque payload, no fields fabricated. */
export interface HsfzOtherFrame {
  kind: 'other';
  /** One of the 4 known "other" words above -- an as-yet-undocumented control word is still routed here at runtime (see `decodeFrameBody`'s fallback) and still carries its real numeric value, just outside what this type enumerates. */
  control: HsfzOtherControlWord;
  payload: Uint8Array;
}

export type HsfzFrame = HsfzDiagnosticFrame | HsfzAliveCheckFrame | HsfzErrorFrame | HsfzOtherFrame;

/** Narrows to the error variant (or `null` for any other frame kind) -- kept as a named helper for callers that only care about errors. */
export function decodeHsfzError(frame: HsfzFrame): HsfzErrorFrame | null {
  return frame.kind === 'error' ? frame : null;
}

function decodeFrameBody(control: number, body: Uint8Array): HsfzFrame {
  if (control === HSFZ_CONTROL.DIAGNOSTIC_REQ_RES || control === HSFZ_CONTROL.ACKNOWLEDGE) {
    return {
      kind: 'diagnostic',
      control,
      source: body[0] ?? 0,
      target: body[1] ?? 0,
      payload: body.slice(2),
    };
  }
  if (control === HSFZ_CONTROL.ALIVE_CHECK) {
    if (body.length === 2) {
      return { kind: 'aliveCheck', control, form: 'short', source: body[0] ?? 0, target: body[1] ?? 0 };
    }
    return { kind: 'aliveCheck', control, form: 'long', identification: body };
  }
  if (isHsfzErrorControl(control)) {
    const errorControl = control as HsfzErrorControlWord;
    return {
      kind: 'error',
      control: errorControl,
      code: errorControl,
      name: ERROR_CONTROL_NAMES[control] ?? `0x${control.toString(16).padStart(4, '0')}`,
      expected: body[0] ?? 0,
      received: body[1] ?? 0,
      raw: body,
    };
  }
  // Fallback also covers a control word this module doesn't otherwise
  // recognize -- still tagged 'other' with its real numeric value at
  // runtime; see `HsfzOtherFrame.control`'s doc comment about the cast.
  return { kind: 'other', control: control as HsfzOtherControlWord, payload: body };
}

// ---------- Encoding ----------

function assertByteRange(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`HSFZ ${label} out of range: ${value}`);
  }
}

function encodeRawFrame(control: number, body: Uint8Array): Uint8Array {
  if (!Number.isInteger(control) || control < 0 || control > 0xffff) {
    throw new RangeError(`HSFZ control word out of range: ${control}`);
  }
  const length = body.length;
  if (length > HSFZ_MAX_LENGTH) {
    throw new RangeError(`HSFZ payload too large: length would be ${length} (max ${HSFZ_MAX_LENGTH})`);
  }
  if (length < HSFZ_MIN_LENGTH) {
    throw new RangeError(`HSFZ frame body too small: length would be ${length} (min ${HSFZ_MIN_LENGTH})`);
  }

  const out = new Uint8Array(6 + length);
  writeUint32BE(out, 0, length);
  writeUint16BE(out, 4, control);
  out.set(body, 6);
  return out;
}

/**
 * Generic diagnostic-layout encoder: `[source][target][payload]` under
 * `control` (0x0001 diagnostic req/res by default, or any other control word
 * that shares this layout, e.g. 0x0002 acknowledge). Kept under its original
 * name/signature for existing callers (additive: nothing about this
 * function's behavior changed for the diagnostic/acknowledge layout it always
 * implemented).
 */
export function encodeFrame(frame: {
  control: number;
  source: number;
  target: number;
  payload: Uint8Array;
}): Uint8Array {
  assertByteRange(frame.source, 'source address');
  assertByteRange(frame.target, 'target address');
  const body = new Uint8Array(2 + frame.payload.length);
  body[0] = frame.source;
  body[1] = frame.target;
  body.set(frame.payload, 2);
  return encodeRawFrame(frame.control, body);
}

/** Encodes an alive-check short addressed reply/request: body = `[source][target]`, no extra payload byte. */
export function encodeAliveCheckShort(args: { source: number; target: number }): Uint8Array {
  assertByteRange(args.source, 'source address');
  assertByteRange(args.target, 'target address');
  return encodeRawFrame(HSFZ_CONTROL.ALIVE_CHECK, Uint8Array.from([args.source, args.target]));
}

/** Encodes an alive-check long identification-string frame. Refuses a 2-byte identification (indistinguishable on the wire from the short addressed form). */
export function encodeAliveCheckLong(args: { identification: Uint8Array }): Uint8Array {
  if (args.identification.length === 2) {
    throw new RangeError(
      'alive-check long-form identification must not be exactly 2 bytes -- it would be parsed back as the short addressed form',
    );
  }
  return encodeRawFrame(HSFZ_CONTROL.ALIVE_CHECK, args.identification);
}

/** Encodes an 0x0040-0x0045 error frame: body = `[expected][received]`. */
export function encodeErrorFrame(args: { control: number; expected: number; received: number }): Uint8Array {
  if (!isHsfzErrorControl(args.control)) {
    throw new RangeError(`not an HSFZ error control word: 0x${args.control.toString(16).padStart(4, '0')}`);
  }
  assertByteRange(args.expected, 'error expected byte');
  assertByteRange(args.received, 'error received byte');
  return encodeRawFrame(args.control, Uint8Array.from([args.expected, args.received]));
}

/** Encodes any other opaque-payload control word (terminal15, vehicle-ident, status, OOM). */
export function encodeOtherFrame(args: { control: number; payload: Uint8Array }): Uint8Array {
  return encodeRawFrame(args.control, args.payload);
}

export type HsfzParseErrorReason = 'LENGTH_TOO_LARGE' | 'LENGTH_TOO_SMALL';

/**
 * Thrown by `HsfzFrameParser.push` when a declared frame length is outside
 * `[HSFZ_MIN_LENGTH, HSFZ_MAX_LENGTH]`. HSFZ has no in-band resync marker (no
 * fixed sync byte, no checksum to hunt for), so once a length prefix is
 * untrustworthy there is no principled way to find the next real frame
 * boundary inside the already-buffered bytes. This is FATAL at the session
 * level: a corrupted length has no in-stream resync point, and TCP chunk
 * boundaries carry no resynchronization meaning either, so the only safe
 * recovery is to close the transport and reconnect -- "clear buffer and
 * continue" is not a valid recovery (see `enetSession.ts`'s handling of this
 * error). This class only clears ITS OWN internal buffer so a caller that
 * chooses to keep using the same parser instance is not permanently wedged;
 * it does not by itself imply the connection is safe to keep reading from.
 * Any frames the same `push()` call had already parsed BEFORE hitting the bad
 * length are still returned, via `framesBeforeError`, so a caller never loses
 * already-valid data.
 */
export class HsfzParseError extends Error {
  constructor(
    message: string,
    public readonly reason: HsfzParseErrorReason,
    public readonly framesBeforeError: readonly HsfzFrame[],
  ) {
    super(message);
    this.name = 'HsfzParseError';
  }
}

/**
 * Incremental HSFZ frame parser. Feed it arbitrary TCP chunks -- it tolerates
 * both fragmentation (a frame split across many `push` calls, down to a
 * single byte at a time) and coalescing (several frames delivered in one
 * chunk), returning zero or more complete frames per call.
 */
export class HsfzFrameParser {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): HsfzFrame[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const frames: HsfzFrame[] = [];

    for (;;) {
      if (this.buffer.length < 4) break;
      const length = readUint32BE(this.buffer, 0);
      if (length > HSFZ_MAX_LENGTH || length < HSFZ_MIN_LENGTH) {
        this.buffer = new Uint8Array(0);
        throw new HsfzParseError(
          `Malformed HSFZ frame: declared length ${length} is outside [${HSFZ_MIN_LENGTH}, ${HSFZ_MAX_LENGTH}] -- stream dropped for resync`,
          length < HSFZ_MIN_LENGTH ? 'LENGTH_TOO_SMALL' : 'LENGTH_TOO_LARGE',
          frames,
        );
      }

      const totalFrameLength = 4 + 2 + length;
      if (this.buffer.length < totalFrameLength) break; // wait for more bytes

      const control = readUint16BE(this.buffer, 4);
      const body = this.buffer.slice(6, totalFrameLength);
      frames.push(decodeFrameBody(control, body));
      this.buffer = this.buffer.slice(totalFrameLength);
    }

    return frames;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

/**
 * Renders bytes as a JS string, one UTF-16 code unit (0-255) per byte -- the
 * same "binary string" convention `ObdTransport` already relies on for the
 * ELM327 transport (whose `send`/`onData` are `string`-typed even though the
 * ELM327 wire protocol is ASCII). HSFZ is a raw binary protocol, so ENET's
 * transport carries frame bytes through that same string channel via this
 * lossless byte<->char-code mapping rather than any text encoding.
 */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index] ?? 0);
  }
  return out;
}

export function binaryStringToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    out[index] = text.charCodeAt(index) & 0xff;
  }
  return out;
}

/** Renders bytes as upper-case hex pairs separated by single spaces, e.g. `41 0C 1A F8` -- used for `lastRawFrameHex` diagnostics. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Encodes any `HsfzFrame` variant back to wire bytes -- used for diagnostics (`lastRawFrameHex`) and by callers that received a frame and want its raw bytes without re-deriving the layout per kind. */
export function encodeHsfzFrame(frame: HsfzFrame): Uint8Array {
  switch (frame.kind) {
    case 'diagnostic':
      return encodeFrame(frame);
    case 'aliveCheck':
      return frame.form === 'short'
        ? encodeAliveCheckShort(frame)
        : encodeAliveCheckLong({ identification: frame.identification });
    case 'error':
      return encodeErrorFrame({ control: frame.control, expected: frame.expected, received: frame.received });
    case 'other':
      return encodeOtherFrame(frame);
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  return b0 * 0x1000000 + b1 * 0x10000 + b2 * 0x100 + b3;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  return b0 * 0x100 + b1;
}

function writeUint32BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

function writeUint16BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}
