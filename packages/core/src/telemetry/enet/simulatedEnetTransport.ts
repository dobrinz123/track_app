import { SeededPrng } from '../../fixtures/prng';
import type { ObdTransport } from '../contracts';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeAliveCheckShort,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  type HsfzFrame,
} from './hsfzCodec';

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

/** Deterministic warm-up model for the ENET addendum's 6 default channels (field revision, 2026-08-27: added accelPedalPct), same shape as `DEFAULT_SIMULATED_VEHICLE_SCENARIO` (ELM327). */
export const DEFAULT_ENET_SCENARIO: readonly EnetSimulatedChannelScript[] = [
  { mode: 'obd01', requestHex: '0C', encodeDataBytes: (t) => twoBytesBE((850 + 2_700 * wave(t, 4_000)) * 4) },
  { mode: 'obd01', requestHex: '0D', encodeDataBytes: (t) => oneByte(15 + 95 * wave(t, 10_000)) },
  { mode: 'obd01', requestHex: '11', encodeDataBytes: (t) => oneByte(((8 + 72 * wave(t + 500, 3_500)) * 255) / 100) },
  // Field revision: the accelerator PEDAL (PID 0x49) -- idles near 0%,
  // distinct from PID 0x11's own throttle-plate opening above.
  { mode: 'obd01', requestHex: '49', encodeDataBytes: (t) => oneByte(((2 + 60 * wave(t + 1_000, 3_500)) * 255) / 100) },
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
    const frame = encodeAliveCheckShort({ source: this.targetAddress, target: this.testerAddress });
    queueMicrotask(() => this.deliver(frame));
  }

  private handleClientFrame(frame: HsfzFrame): void {
    if (frame.kind === 'aliveCheck') return; // the client's reply to our alive-check; nothing further to do.
    if (frame.kind !== 'diagnostic' || frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) return;

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
        // P4f-FIX2 (binding, E2E finding): an UNKNOWN DID under
        // ReadDataByIdentifier is `0x31` (requestOutOfRange) per UDS
        // convention -- "this identifier doesn't exist", not "this SERVICE
        // isn't supported" (0x11), which would be wrong for a DID sweep: the
        // adapter plainly DOES support 0x22 (it answers scripted DIDs), it
        // just doesn't recognize this particular one. obd01's fallback stays
        // 0x11 (unchanged) -- no ticket/test relies on this branch for did.
        this.deliverNegative(testerAddress, sid, mode === 'did' ? 0x31 : 0x11);
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

// ---------------------------------------------------------------------------
// DID sweep addendum extension (additive): a small scripted DID table shaped
// like the three heuristic signal shapes `didHeuristics.ts` looks for, and a
// scripted discovery probe factory for `enetDiscovery.ts`'s `runDiscovery`.
// Nothing above this comment changed.
// ---------------------------------------------------------------------------

/** DID 0x1E1C: temperature-like -- slow monotonic warm-up, u8-40 decode (same warm-up model as `defaultEngineOilC` above). */
export const ENET_DID_TEMPERATURE_DID = '1E1C';
/** DID 0x1E20: pedal-like -- fast bimodal steps (u8 raw decode), toggling every 1.5s. */
export const ENET_DID_PEDAL_DID = '1E20';
/** DID 0x1E24: steering-like -- zero-centred oscillation (i16 raw decode). */
export const ENET_DID_STEERING_DID = '1E24';

function signedTwoBytesBE(value: number): Uint8Array {
  const clamped = Math.max(-32_768, Math.min(32_767, Math.round(value)));
  const raw = clamped < 0 ? clamped + 0x1_0000 : clamped;
  return Uint8Array.from([(raw >> 8) & 0xff, raw & 0xff]);
}

/** Three scripted DID responders for the DID sweep addendum's dev screen/tests -- one shaped like each non-`unknown` heuristic `didHeuristics.ts` classifies for a temperature/pedal/steering DID (speed-like is already covered by `DEFAULT_ENET_SCENARIO`'s obd01 `speedKph`, which correlates with GNSS by construction in a real drive). Feed into `SimulatedEnetTransportConfig.scenario` alongside (or instead of) `DEFAULT_ENET_SCENARIO`. */
export const DEFAULT_ENET_DID_SCENARIO: readonly EnetSimulatedChannelScript[] = [
  {
    mode: 'did',
    requestHex: ENET_DID_TEMPERATURE_DID,
    encodeDataBytes: (t) => oneByte(defaultEngineOilC(t) + 40),
  },
  {
    mode: 'did',
    requestHex: ENET_DID_PEDAL_DID,
    encodeDataBytes: (t) => oneByte(Math.floor(t / 1_500) % 2 === 0 ? 20 : 220),
  },
  {
    mode: 'did',
    requestHex: ENET_DID_STEERING_DID,
    encodeDataBytes: (t) => signedTwoBytesBE(300 * Math.sin(t / 2_000)),
  },
];

export type SimulatedDiscoveryBehavior = 'level2' | 'level1' | 'refuse';

export interface SimulatedDiscoveryHostScript {
  host: string;
  /** When omitted, this entry matches `host` on any port. */
  port?: number;
  behavior: SimulatedDiscoveryBehavior;
}

export interface SimulatedDiscoveryProbeFactoryConfig {
  /**
   * Per-host (optionally per-port) scripted behavior. The addendum's own
   * example shape: answer level-2 on exactly one host, level-1 on another,
   * refuse the rest (`defaultBehavior`, default `'refuse'`).
   */
  script: readonly SimulatedDiscoveryHostScript[];
  defaultBehavior?: SimulatedDiscoveryBehavior;
  /** default 5. Real (not `monotonicNow`-driven) delay -- discovery's own timeouts are wall-clock via `setTimeout`, matching `enetSession`'s pattern; tests drive this with `vi.useFakeTimers()`. */
  connectDelayMs?: number;
  /** default 5. */
  replyDelayMs?: number;
}

/**
 * Builds a `runDiscovery`-compatible `probe` factory: a fresh scripted
 * `ObdTransport` per `(host, port)` call, resolving/rejecting `connect()` and
 * replying (or not) to the probe's TesterPresent per `config.script`.
 */
export function createSimulatedDiscoveryProbeFactory(
  config: SimulatedDiscoveryProbeFactoryConfig,
): (host: string, port: number) => ObdTransport {
  const defaultBehavior = config.defaultBehavior ?? 'refuse';
  const connectDelayMs = config.connectDelayMs ?? 5;
  const replyDelayMs = config.replyDelayMs ?? 5;
  return (host, port) => {
    const matched = config.script.find(
      (entry) => entry.host === host && (entry.port === undefined || entry.port === port),
    );
    const behavior = matched?.behavior ?? defaultBehavior;
    return new SimulatedDiscoveryProbeTransport(behavior, connectDelayMs, replyDelayMs);
  };
}

class SimulatedDiscoveryProbeTransport implements ObdTransport {
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private closed = false;

  constructor(
    private readonly behavior: SimulatedDiscoveryBehavior,
    private readonly connectDelayMs: number,
    private readonly replyDelayMs: number,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (this.closed) return;
        if (this.behavior === 'refuse') {
          reject(new Error('Simulated discovery probe refused the connection'));
          return;
        }
        resolve();
      }, this.connectDelayMs);
    });
  }

  /** `level1` never replies (connects only, per the addendum's example script); `level2` replies with one minimal valid HSFZ frame (an acknowledge -- level-2 only requires ANY valid frame, per the addendum). */
  send(_line: string): void {
    if (this.closed || this.behavior !== 'level2') return;
    const reply = encodeFrame({
      control: HSFZ_CONTROL.ACKNOWLEDGE,
      source: 0,
      target: 0,
      payload: new Uint8Array(0),
    });
    setTimeout(() => {
      if (this.closed) return;
      const chunk = bytesToBinaryString(reply);
      for (const listener of [...this.dataListeners]) listener(chunk);
    }, this.replyDelayMs);
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
    this.closed = true;
  }
}
