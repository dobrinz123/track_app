import type { ObdTransport, TelemetryChannelId, TelemetrySample, TelemetrySession } from '../contracts';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  bytesToHex,
  encodeAliveCheckShort,
  encodeFrame,
  encodeHsfzFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  HsfzParseError,
  type HsfzDiagnosticFrame,
  type HsfzFrame,
} from './hsfzCodec';
import {
  assertAllowedRequest,
  buildObdMode01Request,
  buildReadDataByIdentifierRequest,
  buildTesterPresentRequest,
  extractObdMode01Data,
  extractReadDataByIdentifierData,
  parseUdsResponse,
  UDS_NRC,
  UNSUPPORTED_CHANNEL_NRCS,
} from './udsCodec';
import { decodeEnetChannelValue, validateEnetChannelSpecs, type EnetChannelSpec } from './enetChannelSpecs';

// ---------- Public types ----------

/**
 * `contracts.md`'s ENET addendum: "States: idle -> connecting -> handshake
 * -> polling -> stopped | failed (reuse the ELM state vocabulary so the
 * monitor screen works)". There is no separate HSFZ init command sequence
 * (unlike ELM327's ATZ/ATE0/...) -- 'handshake' is a transient, observable
 * state emitted right after `connect()` succeeds; the first poll request is
 * itself the "first successful diag exchange" the addendum refers to.
 */
export type EnetState = 'idle' | 'connecting' | 'handshake' | 'polling' | 'stopped' | 'failed';

export interface EnetConfig {
  channelSpecs: readonly EnetChannelSpec[];
  pollPlan: Array<{ channel: TelemetryChannelId; hz: number }>;
  /** EMPIRICAL (addendum: default 0xF4, alt 0xF1) -- never hardcoded without this override. */
  testerAddress: number;
  /** EMPIRICAL (addendum: default 0x12 = DME) -- never hardcoded without this override. */
  targetAddress: number;
  /** default 2000 -- TesterPresent cadence while polling. */
  testerPresentIntervalMs: number;
  /** per-request timeout, extended by each 0x78 responsePending. */
  commandTimeoutMs: number;
  /** default 5 -> 'failed'. */
  maxConsecutiveErrors: number;
  /** EMPIRICAL: whether `mode: 'obd01'` channel specs are attempted at all (addendum: "EMPIRICAL whether the DME answers it over ENET"). `false` drops every obd01 entry from the poll plan up front instead of spending the error budget discovering it. */
  attemptObd01: boolean;
}

export const DEFAULT_ENET_CONFIG: Readonly<
  Pick<
    EnetConfig,
    'testerAddress' | 'targetAddress' | 'testerPresentIntervalMs' | 'commandTimeoutMs' | 'maxConsecutiveErrors' | 'attemptObd01'
  >
> = {
  testerAddress: 0xf4,
  targetAddress: 0x12,
  testerPresentIntervalMs: 2_000,
  commandTimeoutMs: 1_500,
  maxConsecutiveErrors: 5,
  attemptObd01: true,
};

export interface EnetDiagnostics {
  observedHzByChannel: Record<string, number>;
  errorCount: number;
  lastError?: string;
  /** Channels currently in the active poll rotation. */
  supportedChannels: TelemetryChannelId[];
  /** Channels permanently removed after NRC 0x11/0x12/0x31 (never retried in-session). */
  unsupportedChannels: TelemetryChannelId[];
  lastNrcByChannel: Record<string, number>;
  framesTx: number;
  framesRx: number;
  ackLatencyMsP50?: number;
  ackLatencyMsP95?: number;
  aliveChecksAnswered: number;
  /** Hex dump of the most recently received HSFZ frame (dev DID-probe screen). */
  lastRawFrameHex?: string;
  /**
   * Diagnostic responses that did NOT correlate to the in-flight request
   * (wrong addresses, wrong echoed SID, or wrong echoed identifier/PID/DID) --
   * counted, never resolving/clearing the pending slot and never marking a
   * channel unsupported (framing & correlation amendment).
   */
  unmatchedResponses: number;
  /**
   * Diagnostic payloads from the CORRECT addresses that do not parse as a
   * UDS response at all (empty, or a negative response too short to carry
   * its NRC) -- counted, never clearing/rejecting the in-flight slot (poll
   * plan, probe & robustness amendment). The real response, or the
   * request's own timeout, is still free to resolve it afterward.
   */
  malformedResponses: number;
  /**
   * Samples dropped because the decoded value was not finite (NaN/Infinity
   * from a bad scale/offset/spec) -- counted separately from `errorCount` and
   * never resets `consecutiveErrors` either way (framing & correlation
   * amendment: "no error-counter reset").
   */
  decodeErrors: number;
}

/** Same shape as `TelemetrySession<EnetState>`, with `getDiagnostics()` narrowed (covariantly) to the richer `EnetDiagnostics` this engine actually returns. */
export interface EnetSession extends TelemetrySession<EnetState> {
  getDiagnostics(): EnetDiagnostics;
}

// ---------- Internal machinery ----------

/** Defensive bound (NOT a protocol fact): caps how many 0x78 responsePending extensions one request may consume before it is treated as timed out, so a misbehaving ECU can never wedge the single in-flight slot forever. */
const MAX_RESPONSE_PENDING_EXTENSIONS = 20;
/** Bounds the ack-latency sample window kept for the p50/p95 diagnostics. */
const MAX_ACK_LATENCY_SAMPLES = 500;

interface PollEntry {
  channel: TelemetryChannelId;
  spec: EnetChannelSpec;
  weight: number;
  currentWeight: number;
}

type RequestOutcome =
  | { kind: 'positive'; sid: number; dataBytes: Uint8Array; arrivedAtMonoMs: number }
  | { kind: 'nrcUnsupported'; nrc: number; arrivedAtMonoMs: number }
  | { kind: 'nrcOther'; nrc: number; arrivedAtMonoMs: number };

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>;
  pendingExtensions: number;
  /** The request's own SID (0x01, 0x22, or 0x3E) -- a response only correlates if its echoed SID matches this. */
  requestSid: number;
  /** obd01: the PID; did: the DID -- a POSITIVE response only correlates if its echoed identifier matches this. */
  identifier: number;
  mode: 'obd01' | 'did';
  /** Expected response addressing: source/target SWAPPED relative to the request we sent. */
  expectedResponseSource: number;
  expectedResponseTarget: number;
  resolve(outcome: RequestOutcome): void;
  reject(error: Error): void;
}

/** Minimum enforced TesterPresent cadence (binding amendment: "clamped to >= 500 ms"), regardless of configured value. */
const MIN_TESTER_PRESENT_INTERVAL_MS = 500;

class EnetSessionEngine implements EnetSession {
  private state: EnetState = 'idle';
  private readonly sampleListeners = new Set<(sample: TelemetrySample) => void>();
  private readonly stateListeners = new Set<(state: EnetState, detail?: string) => void>();
  private readonly parser = new HsfzFrameParser();
  private pollEntries: PollEntry[];
  private totalHz: number;
  private readonly sampleCounts = new Map<TelemetryChannelId, number>();
  private readonly unsupportedChannels = new Set<TelemetryChannelId>();
  private readonly lastNrcByChannel = new Map<TelemetryChannelId, number>();
  private pending: PendingRequest | null = null;
  private runPromise: Promise<void> | null = null;
  private stopRequested = false;
  private intentionalClose = false;
  private transportClosed = false;
  private transportError: Error | null = null;
  private unsubscribeData: (() => void) | null = null;
  private unsubscribeClose: (() => void) | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveWait: (() => void) | null = null;
  private pollingStartedAtMonoMs: number | null = null;
  private pollingEndedAtMonoMs: number | null = null;
  private consecutiveErrors = 0;
  private errorCount = 0;
  private lastError: string | undefined;
  private framesTx = 0;
  private framesRx = 0;
  private aliveChecksAnswered = 0;
  private lastRawFrameHex: string | undefined;
  private readonly ackLatenciesMs: number[] = [];
  /** Bumped on every `stop()`: any outcome resolved for a request started in an earlier generation is discarded silently (no late samples). */
  private generation = 0;
  private nextTesterPresentAtMonoMs = 0;
  /** Clamped >= `MIN_TESTER_PRESENT_INTERVAL_MS`, per the binding amendment -- computed once, config's raw value is never used directly. */
  private readonly testerPresentIntervalMs: number;
  /** L1 starvation guarantee: at least one channel poll must happen between two TesterPresent sends (irrelevant, trivially satisfied, when there are no channels to poll). */
  private channelPolledSinceLastTesterPresent = true;
  private unmatchedResponses = 0;
  private malformedResponses = 0;
  private decodeErrorsCount = 0;
  /** L2: the head bytes (SID + first data byte) of the last REAL diagnostic request sent -- TesterPresent/alive-check replies never set this, so their acks never match it. */
  private lastDiagnosticRequestHead: Uint8Array | null = null;
  private lastDiagnosticRequestSentAtMonoMs: number | null = null;

  constructor(
    private readonly transport: ObdTransport,
    private readonly config: EnetConfig,
    private readonly monotonicNow: () => number,
  ) {
    validateEnetConfig(config);
    this.testerPresentIntervalMs = Math.max(MIN_TESTER_PRESENT_INTERVAL_MS, config.testerPresentIntervalMs);
    const { valid: validSpecs, warnings } = validateEnetChannelSpecs(config.channelSpecs);
    for (const warning of warnings) console.warn(`[enetSession] ${warning}`);
    const specByChannel = new Map(validSpecs.map((spec) => [spec.channel, spec] as const));

    const entries = new Map<TelemetryChannelId, PollEntry>();
    for (const item of config.pollPlan) {
      const spec = specByChannel.get(item.channel);
      if (spec === undefined) continue;
      if (spec.mode === 'obd01' && !config.attemptObd01) continue;
      const existing = entries.get(item.channel);
      if (existing === undefined) {
        entries.set(item.channel, { channel: item.channel, spec, weight: item.hz, currentWeight: 0 });
      } else {
        existing.weight += item.hz;
      }
      this.sampleCounts.set(item.channel, 0);
    }
    this.pollEntries = [...entries.values()];
    this.totalHz = sumWeights(this.pollEntries);
    this.channelPolledSinceLastTesterPresent = this.pollEntries.length === 0;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.runPromise = this.run();
    void this.runPromise.catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.stopRequested = true;
    this.generation += 1;
    this.cancelWait();

    if (this.runPromise !== null) {
      await this.runPromise;
      return;
    }
    await this.closeTransport();
    this.transition('stopped');
  }

  onSample(cb: (sample: TelemetrySample) => void): () => void {
    this.sampleListeners.add(cb);
    return () => this.sampleListeners.delete(cb);
  }

  onStateChange(cb: (state: EnetState, detail?: string) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  getDiagnostics(): EnetDiagnostics {
    const observedHzByChannel: Record<string, number> = {};
    const end = this.pollingEndedAtMonoMs ?? this.monotonicNow();
    const elapsedMs =
      this.pollingStartedAtMonoMs === null ? 0 : Math.max(0, end - this.pollingStartedAtMonoMs);
    for (const [channel, count] of this.sampleCounts) {
      observedHzByChannel[channel] = elapsedMs > 0 ? (count * 1_000) / elapsedMs : 0;
    }
    const lastNrcByChannel: Record<string, number> = {};
    for (const [channel, nrc] of this.lastNrcByChannel) lastNrcByChannel[channel] = nrc;

    const sortedAck = [...this.ackLatenciesMs].sort((a, b) => a - b);

    return {
      observedHzByChannel,
      errorCount: this.errorCount,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      supportedChannels: this.pollEntries.map((entry) => entry.channel),
      unsupportedChannels: [...this.unsupportedChannels],
      lastNrcByChannel,
      framesTx: this.framesTx,
      framesRx: this.framesRx,
      ...(sortedAck.length === 0
        ? {}
        : { ackLatencyMsP50: percentile(sortedAck, 0.5), ackLatencyMsP95: percentile(sortedAck, 0.95) }),
      aliveChecksAnswered: this.aliveChecksAnswered,
      ...(this.lastRawFrameHex === undefined ? {} : { lastRawFrameHex: this.lastRawFrameHex }),
      unmatchedResponses: this.unmatchedResponses,
      malformedResponses: this.malformedResponses,
      decodeErrors: this.decodeErrorsCount,
    };
  }

  private async run(): Promise<void> {
    this.subscribeToTransport();
    try {
      this.transition('connecting');
      await this.transport.connect();
      this.throwIfTransportClosed();
      if (this.stopRequested) return;

      this.transition('handshake');
      this.transition('polling');
      this.pollingStartedAtMonoMs = this.monotonicNow();
      this.nextTesterPresentAtMonoMs = this.monotonicNow() + this.testerPresentIntervalMs;
      await this.pollLoop();
    } catch (error) {
      if (!this.stopRequested) {
        const detail = errorMessage(error);
        this.lastError = detail;
        this.transition('failed', detail);
      }
    } finally {
      if (this.pollingStartedAtMonoMs !== null && this.pollingEndedAtMonoMs === null) {
        this.pollingEndedAtMonoMs = this.monotonicNow();
      }
      await this.closeTransport();
      this.unsubscribeFromTransport();
      if (this.state !== 'failed') this.transition('stopped');
    }
  }

  private async pollLoop(): Promise<void> {
    let nextChannelPollAtMonoMs = this.totalHz > 0 ? this.monotonicNow() : Number.POSITIVE_INFINITY;

    while (!this.stopRequested) {
      const nextEventAtMonoMs = Math.min(nextChannelPollAtMonoMs, this.nextTesterPresentAtMonoMs);
      await this.wait(Math.max(0, nextEventAtMonoMs - this.monotonicNow()));
      if (this.stopRequested) break;
      this.throwIfTransportClosed();

      const now = this.monotonicNow();
      // L1 starvation guarantee: a TesterPresent send is skipped for this
      // iteration (falling through to a channel poll instead, if one is due)
      // until at least one channel poll has happened since the last one --
      // otherwise a very small configured interval could make TesterPresent
      // fire on every loop iteration and starve channel polling entirely.
      if (now >= this.nextTesterPresentAtMonoMs && this.channelPolledSinceLastTesterPresent) {
        await this.sendTesterPresent();
        this.nextTesterPresentAtMonoMs = now + this.testerPresentIntervalMs;
        this.channelPolledSinceLastTesterPresent = this.pollEntries.length === 0;
        continue;
      }

      if (this.pollEntries.length === 0 || this.totalHz <= 0) {
        nextChannelPollAtMonoMs = Number.POSITIVE_INFINITY;
        continue;
      }

      const entry = this.selectNextChannel();
      nextChannelPollAtMonoMs = now + 1_000 / this.totalHz;
      await this.pollChannel(entry);
      this.channelPolledSinceLastTesterPresent = true;
    }
  }

  private selectNextChannel(): PollEntry {
    let selected: PollEntry | undefined;
    for (const entry of this.pollEntries) {
      entry.currentWeight += entry.weight;
      if (selected === undefined || entry.currentWeight > selected.currentWeight) selected = entry;
    }
    if (selected === undefined) throw new Error('ENET polling requires at least one channel');
    selected.currentWeight -= this.totalHz;
    return selected;
  }

  private async pollChannel(entry: PollEntry): Promise<void> {
    const requestGeneration = this.generation;
    const requestValue = Number.parseInt(entry.spec.requestHex.replace(/\s+/g, ''), 16);
    let pdu: Uint8Array;
    try {
      pdu = entry.spec.mode === 'obd01' ? buildObdMode01Request(requestValue) : buildReadDataByIdentifierRequest(requestValue);
    } catch (error) {
      this.recordChannelError(entry.channel, errorMessage(error));
      return;
    }
    const targetAddress = entry.spec.targetAddress ?? this.config.targetAddress;

    let outcome: RequestOutcome;
    try {
      outcome = await this.executeDiagnosticRequest(
        pdu,
        targetAddress,
        this.config.commandTimeoutMs,
        entry.spec.mode,
        requestValue,
      );
    } catch (error) {
      if (this.stopRequested || requestGeneration !== this.generation) return;
      if (this.transportClosed) throw error;
      this.recordChannelError(entry.channel, errorMessage(error));
      return;
    }
    // Generation guard (binding requirement): a request already in flight
    // when stop() is called must never emit a sample or record a channel
    // error once it finally resolves -- discard it silently.
    if (this.stopRequested || requestGeneration !== this.generation) return;

    if (outcome.kind === 'nrcUnsupported') {
      this.markUnsupported(entry.channel, outcome.nrc);
      return;
    }
    if (outcome.kind === 'nrcOther') {
      this.lastNrcByChannel.set(entry.channel, outcome.nrc);
      this.recordChannelError(entry.channel, `NRC 0x${outcome.nrc.toString(16).padStart(2, '0')}`);
      return;
    }

    let dataBytes: Uint8Array;
    try {
      dataBytes =
        entry.spec.mode === 'obd01'
          ? extractObdMode01Data(outcome.sid, outcome.dataBytes, requestValue)
          : extractReadDataByIdentifierData(outcome.sid, outcome.dataBytes, requestValue);
    } catch (error) {
      this.recordChannelError(entry.channel, errorMessage(error));
      return;
    }

    let value: number;
    try {
      value = decodeEnetChannelValue(entry.spec, dataBytes);
    } catch (error) {
      this.recordChannelError(entry.channel, errorMessage(error));
      return;
    }

    if (!Number.isFinite(value)) {
      // M2 (binding amendment): a non-finite decoded value (bad scale/offset,
      // arithmetic overflow) is dropped and counted on its OWN counter --
      // never emitted as a sample, and NEVER touches consecutiveErrors either
      // way ("no error-counter reset": this is not a success, so it must not
      // reset the streak, but it is also not the kind of transient failure
      // that should push toward 'failed').
      this.decodeErrorsCount += 1;
      return;
    }

    this.consecutiveErrors = 0;
    this.sampleCounts.set(entry.channel, (this.sampleCounts.get(entry.channel) ?? 0) + 1);
    this.emitSample({ channel: entry.channel, value, tMonoMs: outcome.arrivedAtMonoMs });
  }

  private markUnsupported(channel: TelemetryChannelId, nrc: number): void {
    this.unsupportedChannels.add(channel);
    this.lastNrcByChannel.set(channel, nrc);
    this.pollEntries = this.pollEntries.filter((entry) => entry.channel !== channel);
    this.totalHz = sumWeights(this.pollEntries);
    // A definitive UNSUPPORTED determination is a graceful outcome, not a
    // transient failure -- it must not push the session toward 'failed'.
    this.consecutiveErrors = 0;
  }

  private recordChannelError(channel: TelemetryChannelId, detail: string): void {
    this.errorCount += 1;
    this.consecutiveErrors += 1;
    this.lastError = `${channel}: ${detail}`;
    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      throw new Error(
        `Maximum consecutive telemetry errors reached (${this.config.maxConsecutiveErrors}): ${channel}: ${detail}`,
      );
    }
  }

  /**
   * HSFZ-level anomalies (malformed frame length, an 0x0040-0x0045 error
   * frame) are recorded in diagnostics (`errorCount`/`lastError`) but
   * deliberately do NOT feed `consecutiveErrors` -> 'failed': they arrive
   * asynchronously off the transport's `onData` callback, outside any
   * in-flight request's own try/catch, so escalating them synchronously
   * from here would require reaching into whichever request happens to be
   * pending -- which may not even be the frame's actual source. A
   * genuinely dead link still surfaces as 'failed' through the normal
   * per-request timeout path (`recordChannelError`) or a transport close.
   */
  private recordProtocolAnomaly(detail: string): void {
    this.errorCount += 1;
    this.lastError = detail;
  }

  private executeDiagnosticRequest(
    pdu: Uint8Array,
    targetAddress: number,
    timeoutMs: number,
    mode: 'obd01' | 'did',
    identifier: number,
  ): Promise<RequestOutcome> {
    if (this.pending !== null) return Promise.reject(new Error('ENET request already in flight'));
    if (this.transportClosed) {
      return Promise.reject(this.transportError ?? new Error('ENET transport closed'));
    }
    assertAllowedRequest(pdu); // hard gate: re-checked here even though every builder above only ever emits a whitelisted SID.

    return new Promise<RequestOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === null) return;
        this.pending = null;
        reject(new Error(`ENET request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = {
        timer,
        pendingExtensions: 0,
        requestSid: pdu[0] ?? 0,
        identifier,
        mode,
        // H2 (binding amendment): a response's addresses are the request's
        // SWAPPED -- our source becomes its expected target, our target
        // becomes its expected source.
        expectedResponseSource: targetAddress,
        expectedResponseTarget: this.config.testerAddress,
        resolve,
        reject,
      };

      try {
        const frame = encodeFrame({
          control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
          source: this.config.testerAddress,
          target: targetAddress,
          payload: pdu,
        });
        // L2: only a REAL diagnostic request's head is eligible for ack-latency
        // attribution -- TesterPresent/alive-check replies never set this.
        this.lastDiagnosticRequestHead = pdu.slice(0, 2);
        this.lastDiagnosticRequestSentAtMonoMs = this.monotonicNow();
        this.sendFrame(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending = null;
        reject(asError(error));
      }
    });
  }

  /** TesterPresent (0x3E 0x80) suppresses the positive response, so this never occupies the single in-flight slot -- it is fire-and-forget by design, matching the addendum's "no response expected" wire behavior. Deliberately does NOT set `lastDiagnosticRequestHead` (L2: its ack must never be attributed as diagnostic-request latency). */
  private async sendTesterPresent(): Promise<void> {
    if (this.transportClosed) return;
    try {
      const pdu = buildTesterPresentRequest();
      assertAllowedRequest(pdu);
      const frame = encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: this.config.testerAddress,
        target: this.config.targetAddress,
        payload: pdu,
      });
      this.sendFrame(frame);
    } catch (error) {
      this.lastError = `TesterPresent send failed: ${errorMessage(error)}`;
    }
  }

  /**
   * Only the SHORT addressed alive-check form (H1: `form === 'short'`) has a
   * defined reply -- "the short form with the tester address" (addendum).
   * The long identification-string form has no documented reply behavior
   * (EMPIRICAL either way); it is recorded via `lastRawFrameHex` by the
   * caller and otherwise ignored, never fabricating a reply.
   */
  private handleAliveCheck(frame: HsfzFrame & { kind: 'aliveCheck' }): void {
    if (frame.form !== 'short') return;
    try {
      const reply = encodeAliveCheckShort({ source: this.config.testerAddress, target: frame.source });
      this.sendFrame(reply);
      this.aliveChecksAnswered += 1;
    } catch {
      // Best-effort: a failed alive-check reply must not fail the session.
    }
  }

  /**
   * H2 (binding amendment): a diagnostic response is only allowed to resolve
   * (or otherwise touch) the in-flight request once it correlates: addresses
   * swapped relative to what we sent, AND the echoed SID (+0x40 positive, or
   * 0x7F-echoed-SID negative) matches the request's own SID. A POSITIVE
   * response additionally must echo the request's own identifier (PID/DID).
   * Anything that fails to correlate is counted (`unmatchedResponses`) and
   * otherwise ignored -- the pending slot is left untouched, so the real
   * response (or the request's own timeout) is still free to resolve it
   * later, and no channel is ever marked unsupported by a response that was
   * never actually an answer to ITS request.
   */
  private handleDiagnosticFrame(frame: HsfzDiagnosticFrame): void {
    const pending = this.pending;
    if (pending === null) {
      // No request is in flight at all -- this is definitionally unmatched
      // (poll plan, probe & robustness amendment), not merely ignored.
      this.unmatchedResponses += 1;
      return;
    }

    if (frame.source !== pending.expectedResponseSource || frame.target !== pending.expectedResponseTarget) {
      this.unmatchedResponses += 1;
      return;
    }

    let parsed: ReturnType<typeof parseUdsResponse>;
    try {
      parsed = parseUdsResponse(frame.payload);
    } catch {
      // Correct addresses, but the payload doesn't parse as a UDS response at
      // all (empty, or a negative response too short to carry its NRC) --
      // counted, but the in-flight slot is left untouched: the real response
      // (or this request's own timeout) is still free to resolve it later
      // (poll plan, probe & robustness amendment -- H2 residual).
      this.malformedResponses += 1;
      return;
    }

    const arrivedAtMonoMs = this.monotonicNow();

    if (parsed.kind === 'negative') {
      if (parsed.requestSid !== pending.requestSid) {
        // e.g. a delayed `7F 3E 31` (TesterPresent's own negative response)
        // arriving while an OBD/DID request is pending -- same address pair,
        // wrong echoed SID: not an answer to this request.
        this.unmatchedResponses += 1;
        return;
      }
      if (parsed.nrc === UDS_NRC.RESPONSE_PENDING) {
        if (pending.pendingExtensions >= MAX_RESPONSE_PENDING_EXTENSIONS) {
          this.pending = null;
          clearTimeout(pending.timer);
          pending.reject(
            new Error(`ENET request exceeded ${MAX_RESPONSE_PENDING_EXTENSIONS} responsePending (0x78) extensions`),
          );
          return;
        }
        pending.pendingExtensions += 1;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          if (this.pending !== pending) return;
          this.pending = null;
          pending.reject(new Error('ENET request timed out after a responsePending (0x78) extension'));
        }, this.config.commandTimeoutMs);
        return; // keep waiting -- 0x78 extends, it never resolves the request itself.
      }

      this.pending = null;
      clearTimeout(pending.timer);
      if (UNSUPPORTED_CHANNEL_NRCS.has(parsed.nrc)) {
        pending.resolve({ kind: 'nrcUnsupported', nrc: parsed.nrc, arrivedAtMonoMs });
      } else {
        pending.resolve({ kind: 'nrcOther', nrc: parsed.nrc, arrivedAtMonoMs });
      }
      return;
    }

    if (!positiveResponseMatchesIdentifier(parsed.sid, parsed.data, pending.mode, pending.identifier)) {
      // A positive response with the right addresses but the WRONG
      // identifier (different PID/DID) -- e.g. a different-DID answer
      // arriving while this DID is still outstanding. Never decoded as this
      // channel's sample, and the request stays pending for its real answer.
      this.unmatchedResponses += 1;
      return;
    }

    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve({ kind: 'positive', sid: parsed.sid, dataBytes: parsed.data, arrivedAtMonoMs });
  }

  private sendFrame(frame: Uint8Array): void {
    this.framesTx += 1;
    this.transport.send(bytesToBinaryString(frame));
  }

  private subscribeToTransport(): void {
    this.unsubscribeData = this.transport.onData((chunk) => {
      // M1: once a fatal framing error has closed us down, ignore any further
      // chunks outright -- a corrupted length has no in-stream resync point,
      // so nothing arriving after it may be treated as a fresh frame header.
      if (this.transportClosed) return;

      const bytes = binaryStringToBytes(chunk);
      let frames: HsfzFrame[];
      try {
        frames = this.parser.push(bytes);
      } catch (error) {
        if (error instanceof HsfzParseError) {
          // Frames the parser had already completed before the corruption,
          // within this SAME chunk, are still legitimate and are processed.
          for (const frame of error.framesBeforeError) {
            this.framesRx += 1;
            this.lastRawFrameHex = bytesToHex(encodeHsfzFrame(frame));
            this.routeFrame(frame);
          }
          this.recordProtocolAnomaly(error.message);
          this.failFatally(error);
        } else {
          this.recordProtocolAnomaly(errorMessage(error));
        }
        return;
      }
      for (const frame of frames) {
        this.framesRx += 1;
        this.lastRawFrameHex = bytesToHex(encodeHsfzFrame(frame));
        this.routeFrame(frame);
      }
    });
    this.unsubscribeClose = this.transport.onClose((error) => {
      if (this.intentionalClose) return;
      this.transportClosed = true;
      this.transportError = error ?? new Error('ENET transport closed');
      const pending = this.pending;
      if (pending !== null) {
        this.pending = null;
        clearTimeout(pending.timer);
        pending.reject(this.transportError);
      }
      this.cancelWait();
    });
  }

  /**
   * M1 (binding amendment): a corrupted HSFZ length is FATAL -- there is no
   * in-stream resync point, and TCP chunk boundaries carry no
   * resynchronization meaning either, so "clear buffer and continue" is not
   * a valid recovery. This marks the transport closed (so no further chunk
   * is processed, see `subscribeToTransport`'s guard above) and rejects any
   * in-flight request, exactly like an `onClose` from the transport itself --
   * `run()`'s normal catch/finally then closes the real transport and
   * transitions to 'failed' through the SAME path a transport-initiated
   * close already uses.
   */
  private failFatally(error: Error): void {
    if (this.transportClosed) return;
    this.transportClosed = true;
    this.transportError = error;
    const pending = this.pending;
    if (pending !== null) {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.cancelWait();
  }

  private routeFrame(frame: HsfzFrame): void {
    if (frame.kind === 'aliveCheck') {
      this.handleAliveCheck(frame);
      return;
    }
    if (frame.kind === 'error') {
      this.recordProtocolAnomaly(`HSFZ error frame ${frame.name}`);
      return;
    }
    if (frame.kind === 'other') {
      // Unhandled control words (terminal15, vehicle_ident, status_data_inquiry,
      // out-of-memory): diagnostics-only via lastRawFrameHex, already recorded
      // by the caller -- none of these are expected during normal polling.
      return;
    }
    // frame.kind === 'diagnostic': either an acknowledge (0x0002) or an
    // actual diagnostic response (0x0001) -- both share the same
    // [source][target][payload] layout.
    if (frame.control === HSFZ_CONTROL.ACKNOWLEDGE) {
      this.handleAcknowledge(frame);
      return;
    }
    this.handleDiagnosticFrame(frame);
  }

  /** L2: an ack's latency is only attributed when its echoed head matches the last REAL diagnostic request's head -- an ack for TesterPresent or an alive-check reply (which never set `lastDiagnosticRequestHead`) is ignored. */
  private handleAcknowledge(frame: HsfzDiagnosticFrame): void {
    if (this.lastDiagnosticRequestHead === null || this.lastDiagnosticRequestSentAtMonoMs === null) return;
    if (!bytesEqual(frame.payload, this.lastDiagnosticRequestHead)) return;
    this.ackLatenciesMs.push(Math.max(0, this.monotonicNow() - this.lastDiagnosticRequestSentAtMonoMs));
    if (this.ackLatenciesMs.length > MAX_ACK_LATENCY_SAMPLES) this.ackLatenciesMs.shift();
  }

  private unsubscribeFromTransport(): void {
    this.unsubscribeData?.();
    this.unsubscribeClose?.();
    this.unsubscribeData = null;
    this.unsubscribeClose = null;
    this.parser.reset();
  }

  private async closeTransport(): Promise<void> {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    try {
      await this.transport.close();
    } catch (error) {
      if (this.state !== 'failed') {
        const detail = `ENET close failed: ${errorMessage(error)}`;
        this.lastError = detail;
        this.transition('failed', detail);
      }
    }
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolveWait = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.resolveWait = null;
        resolve();
      }, delayMs);
    });
  }

  private cancelWait(): void {
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const resolve = this.resolveWait;
    this.resolveWait = null;
    resolve?.();
  }

  private throwIfTransportClosed(): void {
    if (this.transportClosed) {
      throw this.transportError ?? new Error('ENET transport closed');
    }
  }

  private emitSample(sample: TelemetrySample): void {
    for (const listener of [...this.sampleListeners]) {
      try {
        listener(sample);
      } catch {
        // Listener isolation: telemetry collection must remain alive.
      }
    }
  }

  private transition(state: EnetState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state, detail);
      } catch {
        // Listener isolation: state reporting must not control the engine.
      }
    }
  }
}

export function createEnetSession(
  transport: ObdTransport,
  config: EnetConfig,
  monotonicNow: () => number,
): EnetSession {
  return new EnetSessionEngine(transport, config, monotonicNow);
}

function validateEnetConfig(config: EnetConfig): void {
  if (!Number.isInteger(config.testerAddress) || config.testerAddress < 0 || config.testerAddress > 0xff) {
    throw new RangeError(`ENET testerAddress out of range: ${config.testerAddress}`);
  }
  if (!Number.isInteger(config.targetAddress) || config.targetAddress < 0 || config.targetAddress > 0xff) {
    throw new RangeError(`ENET targetAddress out of range: ${config.targetAddress}`);
  }
  if (!Number.isFinite(config.testerPresentIntervalMs) || config.testerPresentIntervalMs <= 0) {
    throw new RangeError('ENET testerPresentIntervalMs must be positive');
  }
  if (!Number.isFinite(config.commandTimeoutMs) || config.commandTimeoutMs <= 0) {
    throw new RangeError('ENET commandTimeoutMs must be positive');
  }
  if (!Number.isInteger(config.maxConsecutiveErrors) || config.maxConsecutiveErrors <= 0) {
    throw new RangeError('ENET maxConsecutiveErrors must be positive');
  }
  for (const item of config.pollPlan) {
    if (!Number.isFinite(item.hz) || item.hz <= 0) {
      throw new RangeError(`ENET poll rate must be positive for ${item.channel}`);
    }
  }
}

/** H2: does a positive UDS response's SID+identifier echo the request it's being checked against? obd01: SID 0x41 + echoed PID; did: SID 0x62 + echoed DID (2 bytes, big-endian). */
function positiveResponseMatchesIdentifier(
  sid: number,
  data: Uint8Array,
  mode: 'obd01' | 'did',
  identifier: number,
): boolean {
  if (mode === 'obd01') {
    return sid === 0x41 && data[0] === identifier;
  }
  return sid === 0x62 && data.length >= 2 && (((data[0] ?? 0) << 8) | (data[1] ?? 0)) === identifier;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function sumWeights(entries: readonly PollEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.weight, 0);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index] ?? 0;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return asError(error).message;
}
