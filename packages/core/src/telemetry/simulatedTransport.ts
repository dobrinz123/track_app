import { SeededPrng } from '../fixtures/prng';
import type { ObdTransport, TelemetryChannelId } from './contracts';
import { channelForMode01Request, type Mode01TelemetryChannelId } from './pidCodec';

export interface SimulatedVehicleScenario {
  rpm(scenarioTimeMs: number): number;
  speedKph(scenarioTimeMs: number): number;
  throttlePct(scenarioTimeMs: number): number;
  /** Field revision (2026-08-27): the accelerator PEDAL, distinct from `throttlePct` (the plate) -- must idle near 0%, unlike the plate's ~14-15% idle opening. */
  accelPedalPct(scenarioTimeMs: number): number;
  coolantC(scenarioTimeMs: number): number;
  intakeC(scenarioTimeMs: number): number;
  engineLoadPct(scenarioTimeMs: number): number;
  engineOilC?(scenarioTimeMs: number): number;
}

export interface SimulatedElm327TransportConfig {
  monotonicNow: () => number;
  scenario?: SimulatedVehicleScenario;
  seed?: number;
  chunkFragmentation?: boolean;
  noDataOnChannels?: readonly TelemetryChannelId[];
  /**
   * Field revision 2 (2026-08-27, binding — Phase 4h, pedal PID fallback):
   * simulates a specific standard-PID BYTE (2 uppercase hex chars, e.g.
   * `'5A'`) answering "NO DATA" regardless of which channel it was asked
   * for -- distinct from `noDataOnChannels` above (which is channel-keyed,
   * so it would refuse EVERY PID that decodes into that channel). This is
   * what lets a test script "0x5A NRC'd, 0x49 still answers" for
   * `accelPedalPct` -- the mobile provider's PID-switch fallback needs the
   * TWO PIDS for the SAME channel to behave differently, which
   * `noDataOnChannels` cannot express.
   */
  noDataOnPids?: readonly string[];
  /** The command after this many completed sends disconnects before replying. */
  disconnectAfterNCommands?: number;
  /** Literal prefix, byte values, or a deterministic number of garbage bytes. */
  garbagePrefixBytes?: string | readonly number[] | number;
}

/** A deterministic warm-up/acceleration model suitable for dev telemetry. */
export const DEFAULT_SIMULATED_VEHICLE_SCENARIO: SimulatedVehicleScenario = {
  rpm: (timeMs) => 850 + 2_700 * wave(timeMs, 4_000),
  speedKph: (timeMs) => 15 + 95 * wave(timeMs, 10_000),
  throttlePct: (timeMs) => 8 + 72 * wave(timeMs + 500, 3_500),
  // Idles near 0% (field revision: the pedal, not the plate) -- rises with a
  // shorter floor than throttlePct so the two are visibly distinct in the
  // dev/preview monitor.
  accelPedalPct: (timeMs) => 2 + 60 * wave(timeMs + 1_000, 3_500),
  coolantC: (timeMs) => 70 + 25 * Math.min(1, timeMs / 180_000),
  intakeC: (timeMs) => 24 + 7 * wave(timeMs, 30_000),
  engineLoadPct: (timeMs) => 15 + 70 * wave(timeMs + 250, 3_500),
  engineOilC: defaultEngineOilC,
};

/**
 * In-memory ELM327 adapter. Responses are delivered on a microtask so the
 * session observes realistic asynchronous transport behavior without any
 * wall-clock dependency.
 */
export class SimulatedElm327Transport implements ObdTransport {
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly scenario: SimulatedVehicleScenario;
  private readonly noDataOnChannels: ReadonlySet<TelemetryChannelId>;
  private readonly noDataOnPids: ReadonlySet<string>;
  private readonly prng: SeededPrng;
  private connected = false;
  private closed = false;
  private echoEnabled = true;
  private connectedAtMonoMs = 0;
  private commandCount = 0;

  constructor(private readonly config: SimulatedElm327TransportConfig) {
    if (config.disconnectAfterNCommands !== undefined) {
      if (!Number.isInteger(config.disconnectAfterNCommands) || config.disconnectAfterNCommands < 0) {
        throw new RangeError('disconnectAfterNCommands must be a non-negative integer');
      }
    }
    if (
      typeof config.garbagePrefixBytes === 'number' &&
      (!Number.isInteger(config.garbagePrefixBytes) || config.garbagePrefixBytes < 0)
    ) {
      throw new RangeError('garbagePrefixBytes count must be a non-negative integer');
    }
    this.scenario = config.scenario ?? DEFAULT_SIMULATED_VEHICLE_SCENARIO;
    this.noDataOnChannels = new Set(config.noDataOnChannels ?? []);
    this.noDataOnPids = new Set((config.noDataOnPids ?? []).map((pid) => pid.toUpperCase()));
    this.prng = new SeededPrng(config.seed ?? 1);
  }

  async connect(): Promise<void> {
    if (this.connected && !this.closed) return;
    this.connected = true;
    this.closed = false;
    this.echoEnabled = true;
    this.connectedAtMonoMs = this.config.monotonicNow();
    this.commandCount = 0;
  }

  send(line: string): void {
    if (!this.connected || this.closed) throw new Error('Simulated ELM327 transport is not connected');
    const command = line.replace(/[\r\n\s]+/g, '').toUpperCase();
    this.commandCount += 1;
    const disconnectAfter = this.config.disconnectAfterNCommands;
    if (disconnectAfter !== undefined && this.commandCount > disconnectAfter) {
      queueMicrotask(() => this.disconnect(new Error('Simulated ELM327 disconnect')));
      return;
    }

    const response = this.buildResponse(command);
    queueMicrotask(() => {
      if (this.closed) return;
      this.deliver(`${this.garbagePrefix()}${response}>`);
    });
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

  private buildResponse(command: string): string {
    const echo = this.echoEnabled ? `${command}\r` : '';
    switch (command) {
      case 'ATZ':
        this.echoEnabled = true;
        return `${echo}\rELM327 v2.2\r`;
      case 'ATE0':
        this.echoEnabled = false;
        return `${echo}OK\r`;
      case 'ATL0':
      case 'ATS0':
      case 'ATSP0':
        return `${echo}OK\r`;
      default:
        return `${echo}${this.buildPidResponse(command)}\r`;
    }
  }

  private buildPidResponse(command: string): string {
    const channel = channelForMode01Request(command);
    if (channel === undefined) return '?';
    // Field revision 2 (binding): the ACTUAL PID byte the caller asked for
    // -- `command` is `01<PID>` (see `pidCodec.ts`'s `encodeMode01Request`)
    // -- so the response always echoes whichever PID was really requested,
    // never a channel-hardcoded one. This matters for `accelPedalPct`
    // specifically: the SAME channel now has two valid source PIDs (0x5A
    // primary, 0x49 fallback), and `noDataOnPids` below needs to refuse ONE
    // of them while the other still answers normally.
    const requestedPidHex = command.replace(/^01/i, '').toUpperCase();
    if (this.noDataOnPids.has(requestedPidHex)) return 'NO DATA';
    if (this.noDataOnChannels.has(channel)) return 'NO DATA';

    const scenarioTimeMs = Math.max(0, this.config.monotonicNow() - this.connectedAtMonoMs);
    const value =
      channel === 'engineOilC'
        ? (this.scenario.engineOilC ?? defaultEngineOilC)(scenarioTimeMs)
        : this.scenario[channel](scenarioTimeMs);
    const jittered = value + jitterScale(channel) * (this.prng.next() * 2 - 1);
    return encodeResponse(channel, requestedPidHex, jittered);
  }

  private garbagePrefix(): string {
    const configured = this.config.garbagePrefixBytes;
    if (configured === undefined) return '';
    if (typeof configured === 'string') return configured;
    if (typeof configured === 'number') {
      let result = '';
      for (let index = 0; index < configured; index += 1) {
        result += String.fromCharCode(1 + Math.floor(this.prng.next() * 30));
      }
      return result;
    }
    return String.fromCharCode(...configured.map((byte) => clampByte(byte)));
  }

  private deliver(response: string): void {
    const chunks = this.config.chunkFragmentation ? [...response] : [response];
    for (const chunk of chunks) {
      for (const listener of [...this.dataListeners]) listener(chunk);
    }
  }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    for (const listener of [...this.closeListeners]) listener(error);
  }
}

function wave(timeMs: number, periodMs: number): number {
  return (Math.sin((timeMs / periodMs) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
}

function defaultEngineOilC(timeMs: number): number {
  return 75 + 35 * Math.min(1, timeMs / 240_000);
}

function jitterScale(channel: Mode01TelemetryChannelId): number {
  switch (channel) {
    case 'rpm':
      return 2;
    case 'speedKph':
    case 'coolantC':
    case 'intakeC':
    case 'engineOilC':
      return 0.1;
    case 'throttlePct':
    case 'accelPedalPct':
    case 'engineLoadPct':
      return 0.2;
  }
}

/**
 * Field revision 2 (binding): `requestedPidHex` is echoed back verbatim as
 * the response's PID byte -- for every channel except `accelPedalPct` this
 * is always the SAME literal as before (each channel had exactly one PID),
 * but `accelPedalPct` now has two valid source PIDs (0x5A/0x49, identical
 * decode formula) and the response must echo whichever one was actually
 * asked, not a hardcoded one.
 */
function encodeResponse(channel: Mode01TelemetryChannelId, requestedPidHex: string, value: number): string {
  switch (channel) {
    case 'rpm': {
      const raw = Math.max(0, Math.min(65_535, Math.round(value * 4)));
      return `41 0C ${hexByte(raw >> 8)} ${hexByte(raw)}`;
    }
    case 'speedKph':
      return `41 0D ${hexByte(value)}`;
    case 'throttlePct':
      return `41 11 ${hexByte((value * 255) / 100)}`;
    case 'accelPedalPct':
      return `41 ${requestedPidHex} ${hexByte((value * 255) / 100)}`;
    case 'coolantC':
      return `41 05 ${hexByte(value + 40)}`;
    case 'intakeC':
      return `41 0F ${hexByte(value + 40)}`;
    case 'engineLoadPct':
      return `41 04 ${hexByte((value * 255) / 100)}`;
    case 'engineOilC':
      return `41 5C ${hexByte(value + 40)}`;
  }
}

function hexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0').toUpperCase();
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
