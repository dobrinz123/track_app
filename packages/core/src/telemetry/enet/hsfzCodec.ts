/**
 * HSFZ (BMW ENET) frame codec -- pure encode/decode, no I/O.
 *
 * Frame layout (verified from primary sources, see
 * `.foreman/scratch/enet-protocol-research.md` #1a/#1b; reimplemented from the
 * documented layout, NO code copied from scapy/ediabaslib -- both GPL):
 *
 *   [length  u32 BE][control u16 BE][source u8][target u8][UDS PDU bytes...]
 *
 * `length` counts everything AFTER the control word: source + target + the
 * UDS PDU (i.e. `2 + pdu.length`). It does NOT include the control word or
 * itself. This is why a well-formed frame's minimum `length` is 2 (an empty
 * PDU, e.g. a bare alive-check-style exchange) -- so a declared `length < 2`
 * is already impossible for a real frame, and `length > 65535` is judged
 * unreasonable for a diagnostic session (contracts.md's addendum's own
 * bound). Total wire size of one frame is therefore `4 + 2 + length` bytes
 * (length field + control word + the `length`-counted tail).
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

/** Inclusive bounds for a well-formed frame's `length` field (see module doc). */
export const HSFZ_MIN_LENGTH = 2;
export const HSFZ_MAX_LENGTH = 65_535;

export interface HsfzFrame {
  control: number;
  source: number;
  target: number;
  payload: Uint8Array;
}

const ERROR_CONTROL_NAMES: Readonly<Record<number, string>> = {
  [HSFZ_CONTROL.ERROR_UNKNOWN_TESTER_ADDRESS]: 'UNKNOWN_TESTER_ADDRESS',
  [HSFZ_CONTROL.ERROR_UNKNOWN_CONTROL_WORD]: 'UNKNOWN_CONTROL_WORD',
  [HSFZ_CONTROL.ERROR_FORMAT_ERROR]: 'FORMAT_ERROR',
  [HSFZ_CONTROL.ERROR_UNKNOWN_DESTINATION_ADDRESS]: 'UNKNOWN_DESTINATION_ADDRESS',
  [HSFZ_CONTROL.ERROR_MESSAGE_TOO_LARGE]: 'MESSAGE_TOO_LARGE',
  [HSFZ_CONTROL.ERROR_APPLICATION_NOT_READY]: 'APPLICATION_NOT_READY',
};

export interface HsfzErrorFrame {
  control: number;
  name: string;
  source: number;
  target: number;
  /**
   * Whatever bytes followed source/target in the error frame. The research
   * notes an `expected`/`received` sub-structure exists in this range but its
   * exact byte layout was NOT independently confirmed in any fetched source
   * -- rather than guess a shape, this exposes the raw remainder so a caller
   * (or a future, evidence-backed revision) can interpret it.
   */
  raw: Uint8Array;
}

export function isHsfzErrorControl(control: number): boolean {
  return (
    control >= HSFZ_CONTROL.ERROR_UNKNOWN_TESTER_ADDRESS && control <= HSFZ_CONTROL.ERROR_APPLICATION_NOT_READY
  );
}

/** Decodes a frame whose control word is in the 0x0040-0x0045 error range; `null` for any other control word. */
export function decodeHsfzError(frame: HsfzFrame): HsfzErrorFrame | null {
  const name = ERROR_CONTROL_NAMES[frame.control];
  if (name === undefined) return null;
  return { control: frame.control, name, source: frame.source, target: frame.target, raw: frame.payload };
}

export function encodeFrame(frame: {
  control: number;
  source: number;
  target: number;
  payload: Uint8Array;
}): Uint8Array {
  if (!Number.isInteger(frame.control) || frame.control < 0 || frame.control > 0xffff) {
    throw new RangeError(`HSFZ control word out of range: ${frame.control}`);
  }
  if (!Number.isInteger(frame.source) || frame.source < 0 || frame.source > 0xff) {
    throw new RangeError(`HSFZ source address out of range: ${frame.source}`);
  }
  if (!Number.isInteger(frame.target) || frame.target < 0 || frame.target > 0xff) {
    throw new RangeError(`HSFZ target address out of range: ${frame.target}`);
  }
  const length = 2 + frame.payload.length;
  if (length > HSFZ_MAX_LENGTH) {
    throw new RangeError(`HSFZ payload too large: length would be ${length} (max ${HSFZ_MAX_LENGTH})`);
  }

  const out = new Uint8Array(8 + frame.payload.length);
  writeUint32BE(out, 0, length);
  writeUint16BE(out, 4, frame.control);
  out[6] = frame.source;
  out[7] = frame.target;
  out.set(frame.payload, 8);
  return out;
}

export type HsfzParseErrorReason = 'LENGTH_TOO_LARGE' | 'LENGTH_TOO_SMALL';

/**
 * Thrown by `HsfzFrameParser.push` when a declared frame length is outside
 * `[HSFZ_MIN_LENGTH, HSFZ_MAX_LENGTH]`. HSFZ has no in-band resync marker
 * (no fixed sync byte, no checksum to hunt for), so once a length prefix is
 * untrustworthy there is no principled way to find the next real frame
 * boundary inside the already-buffered bytes -- the documented recovery
 * choice is to DROP THE ENTIRE BUFFERED STREAM and let the next chunk(s)
 * start fresh. Any frames the same `push()` call had already parsed BEFORE
 * hitting the bad length are still returned, via `framesBeforeError`, so a
 * caller never loses already-valid data.
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
      const source = this.buffer[6] ?? 0;
      const target = this.buffer[7] ?? 0;
      const payload = this.buffer.slice(8, totalFrameLength);
      frames.push({ control, source, target, payload });
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
