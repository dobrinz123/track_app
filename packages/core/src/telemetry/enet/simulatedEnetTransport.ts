import { SeededPrng } from '../../fixtures/prng';
import type { ObdTransport } from '../contracts';
import { binaryStringToBytes, bytesToBinaryString, encodeFrame, HSFZ_CONTROL, HsfzFrameParser, type HsfzFrame } from './hsfzCodec';

/**
 * One scripted ECU channel: how the simulator answers a specific
 * `mode`/`requestHex` request (matching `EnetChannelSpec`). The simulator
 * operates at the wire level -- it fabricates the raw response DATA bytes a
 * real ECU would send (the bytes after the echoed PID/DID), never reusing
 * the session's own decode path, so a codec bug in the session cannot also
 * hide inside the fixture that is supposed to catch it.
 */
export interface EnetSimulatedChannelScript {
  mode: 'obd01' | 'did';
  requestHex: string;
  encodeDataBytes(scenarioTimeMs: number): Uint8Array;
  /** Always answer with this NRC instead of a positive response (e.g. 0x11 to script "channel unsupported"). */
  nrc?: number;
  /** Emit this many 0x78 responsePending frames before the real (positive or NRC) response. */
  responsePendingCount?: number;
}

export interface SimulatedEnetTransportConfig {
  monotonicNow: () => number;
  scenario?: readonly EnetSimulatedChannelScript[];
  seed?: number;
  testerAddress?: number;
  targetAddress?: number;
  /** default true. */
  ackEnabled?: boolean;
  /** When true, every outgoing frame is split into 1-3 byte TCP-style fragments delivered as separate `onData` chunks. */
  fragmentResponses?: boolean;
  /** When set, an unsolicited alive-check (0x0012) frame is emitted once scenario time crosses each multiple of this interval. */
  aliveCheckIntervalMs?: number;
  /** 1-based count of diagnostic (0x0001) requests after which the transport disconnects instead of replying. */
  disconnectOnRequestNumber?: number;
}

function wave(timeMs: number, periodMs: number): number {
  return (Math.sin((timeMs / periodMs) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function oneByte(value: number): Uint8Array {
  return Uint8Array.from([clampByte(value)]);
}

function twoBytesBE(value: number): Uint8Array {
  const raw = Math.max(0, Math.min(65_535, Math.round(value)));
  return Uint8Array.from([(raw >> 8) & 0xff, raw & 0xff]);
}

function defaultEngineOilC(timeMs: number): number {
  return 75 + 35 * Math.min(1, timeMs / 240_000);
}

/** Deterministic warm-up model for the ENET addendum's 5 default channels, same shape as `DEFAULT_SIMULATED_VEHICLE_SCENARIO` (ELM327). */
export const DEFAULT_ENET_SCENARIO: readonly EnetSimulatedChannelScript[] = [
  { mode: 'obd01', requestHex: '0C', encodeDataBytes: (t) => twoBytesBE((850 + 2_700 * wave(t, 4_000)) * 4) },
  { mode: 'obd01', requestHex: '0D', encodeDataBytes: (t) => oneByte(15 + 95 * wave(t, 10_000)) },
  { mode: 'obd01', requestHex: '11', encodeDataBytes: (t) => oneByte(((8 + 72 * wave(t + 500, 3_500)) * 255) / 100) },
  { mode: 'obd01', requestHex: '05', encodeDataBytes: (t) => oneByte(70 + 25 * Math.min(1, t / 180_000) + 40) },
  { mode: 'obd01', requestHex: '5C', encodeDataBytes: (t) => oneByte(defaultEngineOilC(t) + 40) },
];

/**
 * In-memory scripted ECU over HSFZ. Responses are delivered on a microtask
 * (same convention as `SimulatedElm327Transport`) so the session observes
 * realistic asynchronous transport behavior with no wall-clock dependency --
 * value functions and cadence are driven entirely by the injected
 * `monotonicNow`.
 */
export class SimulatedEnetTransport implements ObdTransport {
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly scenario: readonly EnetSimulatedChannelScript[];
  private readonly prng: SeededPrng;
  private readonly serverParser = new HsfzFrameParser();
  private readonly testerAddress: number;
  private readonly targetAddress: number;
  private readonly ackEnabled: boolean;
  private readonly fragmentResponses: boolean;
  private connected = false;
  private closed = false;
  private connectedAtMonoMs = 0;
  private diagnosticRequestCount = 0;
  private nextAliveCheckAtMonoMs = Number.POSITIVE_INFINITY;

  constructor(private readonly config: SimulatedEnetTransportConfig) {
    if (
      config.disconnectOnRequestNumber !== undefined &&
      (!Number.isInteger(config.disconnectOnRequestNumber) || config.disconnectOnRequestNumber < 1)
    ) {
      throw new RangeError('disconnectOnRequestNumber must be a positive integer');
    }
    this.scenario = config.scenario ?? DEFAULT_ENET_SCENARIO;
    this.prng = new SeededPrng(config.seed ?? 1);
    this.testerAddress = config.testerAddress ?? 0xf4;
    this.targetAddress = config.targetAddress ?? 0x12;
    this.ackEnabled = config.ackEnabled ?? true;
    this.fragmentResponses = config.fragmentResponses ?? false;
  }

  async connect(): Promise<void> {
    if (this.connected && !this.closed) return;
    this.connected = true;
    this.closed = false;
    this.connectedAtMonoMs = this.config.monotonicNow();
    this.diagnosticRequestCount = 0;
    this.serverParser.reset();
    this.nextAliveCheckAtMonoMs =
      this.config.aliveCheckIntervalMs === undefined
        ? Number.POSITIVE_INFINITY
        : this.connectedAtMonoMs + this.config.aliveCheckIntervalMs;
  }

  send(line: string): void {
    if (!this.connected || this.closed) throw new Error('Simulated ENET transport is not connected');
    this.maybeEmitAliveCheck();

    const bytes = binaryStringToBytes(line);
    let frames: HsfzFrame[];
    try {
      frames = this.serverParser.push(bytes);
    } catch {
      return; // A malformed frame from the client is a client bug, not ECU behavior to script.
    }
    for (const frame of frames) this.handleClientFrame(frame);
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onClose(cb: (error?: Error) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    for (const listener of [...this.closeListeners]) listener();
  }

  private maybeEmitAliveCheck(): void {
    if (this.config.aliveCheckIntervalMs === undefined) return;
    if (this.config.monotonicNow() < this.nextAliveCheckAtMonoMs) return;
    this.nextAliveCheckAtMonoMs += this.config.aliveCheckIntervalMs;
    const frame = encodeFrame({
      control: HSFZ_CONTROL.ALIVE_CHECK,
      source: this.targetAddress,
      target: this.testerAddress,
      payload: new Uint8Array(0),
    });
    queueMicrotask(() => this.deliver(frame));
  }

  private handleClientFrame(frame: HsfzFrame): void {
    if (frame.control === HSFZ_CONTROL.ALIVE_CHECK) return; // the client's reply to our alive-check; nothing further to do.
    if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) return;

    this.diagnosticRequestCount += 1;
    const disconnectAt = this.config.disconnectOnRequestNumber;
    if (disconnectAt !== undefined && this.diagnosticRequestCount >= disconnectAt) {
      queueMicrotask(() => this.disconnect(new Error('Simulated ENET disconnect')));
      return;
    }

    if (this.ackEnabled) {
      const ack = encodeFrame({
        control: HSFZ_CONTROL.ACKNOWLEDGE,
        source: this.targetAddress,
        target: frame.source,
        payload: frame.payload.slice(0, 2), // "adapter echoes the request head" (addendum)
      });
      queueMicrotask(() => this.deliver(ack));
    }

    const pdu = frame.payload;
    const sid = pdu[0] ?? 0;
    if (sid === 0x3e) return; // TesterPresent, suppress-positive-response bit set: no application response to script.

    const isDid = sid === 0x22;
    const requestKey = isDid ? bytesToHexPairsCompact(pdu.slice(1, 3)) : bytesToHexPairsCompact(pdu.slice(1, 2));
    const mode: 'obd01' | 'did' = isDid ? 'did' : 'obd01';
    const script = this.scenario.find(
      (entry) => entry.mode === mode && entry.requestHex.replace(/\s+/g, '').toUpperCase() === requestKey,
    );
    const responseSid = isDid ? 0x62 : 0x41;
    const scenarioTimeMs = Math.max(0, this.config.monotonicNow() - this.connectedAtMonoMs);
    const testerAddress = frame.source;

    queueMicrotask(() => {
      if (this.closed) return;
      if (script === undefined) {
        this.deliverNegative(testerAddress, sid, 0x11); // serviceNotSupported: no scripted entry for this request.
        return;
      }
      this.deliverScripted(testerAddress, sid, responseSid, script, scenarioTimeMs);
    });
  }

  /**
   * Delivers one full UDS transaction for a single incoming request: the
   * scripted number of 0x78 responsePending frames (each a distinct wire
   * frame/onData delivery, exactly as a real ECU stalling for time would
   * send), THEN the real answer (a scripted NRC, or the positive response).
   * All within the response to ONE client request -- 0x78 never requires
   * (or gets) a fresh request from the tester, matching UDS semantics.
   */
  private deliverScripted(
    testerAddress: number,
    requestSid: number,
    responseSid: number,
    script: EnetSimulatedChannelScript,
    scenarioTimeMs: number,
  ): void {
    for (let index = 0; index < (script.responsePendingCount ?? 0); index += 1) {
      this.deliverNegative(testerAddress, requestSid, 0x78);
    }

    if (script.nrc !== undefined) {
      this.deliverNegative(testerAddress, requestSid, script.nrc);
      return;
    }

    const dataBytes = script.encodeDataBytes(scenarioTimeMs);
    const echoedIdBytes = hexToBytes(script.requestHex);
    const payload = concatBytes(concatBytes(Uint8Array.from([responseSid]), echoedIdBytes), dataBytes);
    const frame = encodeFrame({
      control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
      source: this.targetAddress,
      target: testerAddress,
      payload,
    });
    this.deliver(frame);
  }

  private deliverNegative(testerAddress: number, requestSid: number, nrc: number): void {
    const frame = encodeFrame({
      control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
      source: this.targetAddress,
      target: testerAddress,
      payload: Uint8Array.from([0x7f, requestSid, nrc]),
    });
    this.deliver(frame);
  }

  private deliver(frameBytes: Uint8Array): void {
    if (this.closed) return;
    if (!this.fragmentResponses) {
      for (const listener of [...this.dataListeners]) listener(bytesToBinaryString(frameBytes));
      return;
    }
    for (const chunk of splitIntoFragments(frameBytes, this.prng)) {
      const chunkString = bytesToBinaryString(chunk);
      for (const listener of [...this.dataListeners]) listener(chunkString);
    }
  }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    for (const listener of [...this.closeListeners]) listener(error);
  }
}

function bytesToHexPairsCompact(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const compact = hex.replace(/\s+/g, '');
  const out = new Uint8Array(Math.floor(compact.length / 2));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Splits `bytes` into 1-3 byte chunks, deterministic given the seeded prng. */
function splitIntoFragments(bytes: Uint8Array, prng: SeededPrng): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const size = Math.min(remaining, 1 + Math.floor(prng.next() * 3));
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}
