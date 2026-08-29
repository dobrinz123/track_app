import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  type ObdTransport,
} from '@circuit/core';

/**
 * Ticket P4l: a scriptable transport double for the Signal Finder
 * controller. Modelled on `didSweepHarness.ts`'s `FakeSweepTransport` (same
 * real HSFZ encode/decode through `@circuit/core`, so `createRawUdsChannel`'s
 * own address-swap parsing is exercised exactly as against a real adapter),
 * with the one difference the finder needs: it answers as WHICHEVER ECU the
 * request was addressed to, because the finder iterates target addresses
 * (0x12, 0x29, ...) within one session. Kept separate rather than bolted onto
 * the sweep harness so no existing sweep test's double changes behaviour.
 */

export const TESTER_ADDRESS = 0xf4;

/** What one DID answers at a given moment. `'nrc'` -> 0x7F 0x22 0x31; `null` -> silence (the request times out). */
export type DidAnswer = Uint8Array | 'nrc' | null;

export interface SignalFinderScript {
  /** `(ecu, did, tMs)` where `tMs` is milliseconds since this transport's FIRST request. */
  answer(ecu: number, did: number, tMs: number): DidAnswer;
}

export function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class MultiEcuFakeTransport implements ObdTransport {
  closed = false;
  connectCalls = 0;
  closeCalls = 0;
  /** Every `(ecu, did)` this transport was asked for, in order. */
  readonly requests: Array<{ ecu: number; did: number; tMs: number }> = [];
  keepAliveSendCount = 0;
  private firstRequestAtMs: number | null = null;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(err?: Error) => void>();
  private readonly parser = new HsfzFrameParser();

  constructor(
    private readonly script: SignalFinderScript,
    private readonly opts: { refuseConnect?: boolean; responseDelayMs?: number } = {},
  ) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.opts.refuseConnect === true) throw new Error('refused (test double)');
  }

  send(line: string): void {
    if (this.closed) return;
    let frames: ReturnType<HsfzFrameParser['push']>;
    try {
      frames = this.parser.push(binaryStringToBytes(line));
    } catch {
      return;
    }
    for (const frame of frames) {
      if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue;
      const pdu = frame.payload;
      if ((pdu[0] ?? 0) === 0x3e) {
        this.keepAliveSendCount += 1;
        continue;
      }
      if ((pdu[0] ?? 0) !== 0x22) continue;
      const ecu = frame.target;
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      this.firstRequestAtMs ??= Date.now();
      const tMs = Date.now() - this.firstRequestAtMs;
      this.requests.push({ ecu, did, tMs });
      const answer = this.script.answer(ecu, did, tMs);
      if (answer === null) continue; // silence -- the DID times out.
      const payload =
        answer === 'nrc'
          ? Uint8Array.from([0x7f, 0x22, 0x31])
          : Uint8Array.from([0x62, (did >> 8) & 0xff, did & 0xff, ...answer]);
      setTimeout(() => this.deliver(ecu, payload), this.opts.responseDelayMs ?? 5);
    }
  }

  private deliver(ecu: number, payload: Uint8Array): void {
    if (this.closed) return;
    const frame = encodeFrame({
      control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
      source: ecu,
      target: TESTER_ADDRESS,
      payload,
    });
    const chunk = bytesToBinaryString(frame);
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onClose(cb: (err?: Error) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }
}

export async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
