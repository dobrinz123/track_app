import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  type ObdTransport,
} from '@circuit/core';

/**
 * Shared scriptable transport double for the DID-sweep controller tests
 * (ticket P4j-FIX1). Structurally identical to the one that grew inside
 * `didSweepController.test.ts` -- extracted here so the P4j-FIX1 test file can
 * reuse it without a second hand-copy drifting out of sync. It encodes/decodes
 * REAL HSFZ frames through `@circuit/core`, so `createRawUdsChannel`'s own
 * address-swap parsing is exercised exactly as against a real adapter.
 */

export const TESTER_ADDRESS = 0xf4;
export const TARGET_ADDRESS = 0x12;

export function positivePdu(did: number, dataBytes: readonly number[]): Uint8Array {
  return Uint8Array.from([0x62, (did >> 8) & 0xff, did & 0xff, ...dataBytes]);
}

export function negativePdu(nrc: number): Uint8Array {
  return Uint8Array.from([0x7f, 0x22, nrc]);
}

export interface ScriptEntry {
  responses: Uint8Array[];
  /** `'burst'`: every response is delivered for the FIRST send. `'oneFramePerSend'`: each send delivers the next entry (the last entry repeats forever). */
  mode?: 'burst' | 'oneFramePerSend';
  /** ms delay before EACH response (fake-timer controlled). */
  delayMs?: number;
  /** When set, `mode: 'oneFramePerSend'` STOPS delivering once the cursor passes the list (the DID then times out) -- models a DID that goes quiet mid-run. */
  stopAfterList?: boolean;
}

export class FakeSweepTransport implements ObdTransport {
  closed = false;
  connectCalls = 0;
  closeCalls = 0;
  sendCallCountByDid = new Map<number, number>();
  keepAliveSendCount = 0;
  /** `Date.now()` of every TesterPresent seen -- lets a test assert the binding "never > 2 s between keep-alives", including across phase/slice/batch boundaries. */
  keepAliveAtMs: number[] = [];
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(err?: Error) => void>();
  private readonly parser = new HsfzFrameParser();
  private readonly oneFramePerSendCursor = new Map<number, number>();

  constructor(
    private readonly script: Map<number, ScriptEntry>,
    private readonly opts: { refuseConnect?: boolean; connectDelayMs?: number; closeDelayMs?: number } = {},
  ) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.opts.connectDelayMs !== undefined) await new Promise((r) => setTimeout(r, this.opts.connectDelayMs));
    if (this.opts.refuseConnect) throw new Error('refused (test double)');
  }

  send(line: string): void {
    if (this.closed) return;
    const bytes = binaryStringToBytes(line);
    let frames: ReturnType<HsfzFrameParser['push']>;
    try {
      frames = this.parser.push(bytes);
    } catch {
      return;
    }
    for (const frame of frames) {
      if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue;
      const pdu = frame.payload;
      if ((pdu[0] ?? 0) === 0x3e) {
        this.keepAliveSendCount += 1;
        this.keepAliveAtMs.push(Date.now());
        continue;
      }
      if ((pdu[0] ?? 0) !== 0x22) continue;
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      this.sendCallCountByDid.set(did, (this.sendCallCountByDid.get(did) ?? 0) + 1);
      const entry = this.script.get(did);
      if (entry === undefined) continue; // no scripted reply -- the request times out.
      const delayStep = entry.delayMs ?? 5;
      if (entry.mode === 'oneFramePerSend') {
        const cursor = this.oneFramePerSendCursor.get(did) ?? 0;
        this.oneFramePerSendCursor.set(did, cursor + 1);
        if (entry.stopAfterList === true && cursor >= entry.responses.length) continue; // goes quiet.
        const response = entry.responses[Math.min(cursor, entry.responses.length - 1)];
        if (response !== undefined) setTimeout(() => this.deliver(response), delayStep);
        continue;
      }
      let delay = delayStep;
      for (const response of entry.responses) {
        setTimeout(() => this.deliver(response), delay);
        delay += delayStep;
      }
    }
  }

  private deliver(payload: Uint8Array): void {
    if (this.closed) return;
    const frame = encodeFrame({ control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES, source: TARGET_ADDRESS, target: TESTER_ADDRESS, payload });
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
    if (this.opts.closeDelayMs !== undefined) await new Promise((r) => setTimeout(r, this.opts.closeDelayMs));
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }
}

/** A `MonotonicClock` backed by the fake-timer-controlled `Date.now()` -- required so the controller's timing math advances in lockstep with `vi.advanceTimersByTimeAsync`. */
export function monotonicCounter(): { now: () => number } {
  return { now: () => Date.now() };
}

export async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
