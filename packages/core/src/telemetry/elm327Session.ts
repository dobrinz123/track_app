import type {
  Elm327Config,
  Elm327Session,
  Elm327State,
  ObdTransport,
  TelemetryChannelId,
  TelemetrySample,
} from './contracts';
import {
  decodeMode01Response,
  encodeMode01Request,
  isMode01TelemetryChannel,
} from './pidCodec';

const INIT_COMMANDS = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATSP0'] as const;
const CHANNEL_ERROR_PATTERN = /(?:NO DATA|STOPPED|CAN ERROR|(?:^|[\r\n])\s*\?\s*(?:$|[\r\n]))/i;

export const DEFAULT_ELM327_CONFIG: Elm327Config = {
  pollPlan: [],
  initTimeoutMs: 5_000,
  commandTimeoutMs: 1_500,
  maxConsecutiveErrors: 5,
};

/** Incremental `>` response framer. One `push` may complete zero or many frames. */
export class Elm327ResponseFramer {
  private buffered = '';

  push(chunk: string): string[] {
    this.buffered += chunk;
    const frames: string[] = [];
    let promptIndex = this.buffered.indexOf('>');
    while (promptIndex >= 0) {
      frames.push(this.buffered.slice(0, promptIndex));
      this.buffered = this.buffered.slice(promptIndex + 1);
      promptIndex = this.buffered.indexOf('>');
    }
    return frames;
  }

  reset(): void {
    this.buffered = '';
  }
}

interface CommandResult {
  response: string;
  arrivedAtMonoMs: number;
}

interface PendingCommand {
  command: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve(result: CommandResult): void;
  reject(error: Error): void;
}

interface PollEntry {
  channel: TelemetryChannelId;
  command: string;
  custom: boolean;
  weight: number;
  currentWeight: number;
}

class Elm327SessionEngine implements Elm327Session {
  private state: Elm327State = 'idle';
  private readonly sampleListeners = new Set<(sample: TelemetrySample) => void>();
  private readonly stateListeners = new Set<(state: Elm327State, detail?: string) => void>();
  private readonly framer = new Elm327ResponseFramer();
  private readonly pollEntries: PollEntry[];
  private readonly totalHz: number;
  private readonly sampleCounts = new Map<TelemetryChannelId, number>();
  private pending: PendingCommand | null = null;
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
  private readonly pollingWarning: string | undefined;

  constructor(
    private readonly transport: ObdTransport,
    private readonly config: Elm327Config,
    private readonly monotonicNow: () => number,
  ) {
    validateConfig(config);
    const customRequests = new Map(
      (config.customPids ?? []).map(({ channel, request }) => [channel, request] as const),
    );
    const entries = new Map<TelemetryChannelId, PollEntry>();
    let ignoredUnconfiguredTransOil = false;
    for (const item of config.pollPlan) {
      const customRequest = customRequests.get(item.channel);
      let command: string;
      let custom: boolean;
      if (customRequest !== undefined) {
        command = customRequest;
        custom = true;
      } else if (isMode01TelemetryChannel(item.channel)) {
        command = encodeMode01Request(item.channel);
        custom = false;
      } else {
        if (item.channel === 'transOilC') ignoredUnconfiguredTransOil = true;
        continue;
      }

      const existing = entries.get(item.channel);
      if (existing === undefined) {
        entries.set(item.channel, {
          channel: item.channel,
          command,
          custom,
          weight: item.hz,
          currentWeight: 0,
        });
      } else {
        existing.weight += item.hz;
      }
      this.sampleCounts.set(item.channel, 0);
    }
    this.pollEntries = [...entries.values()];
    this.totalHz = this.pollEntries.reduce((sum, entry) => sum + entry.weight, 0);
    this.pollingWarning = ignoredUnconfiguredTransOil
      ? 'Ignoring transOilC poll entry: no matching custom PID is configured'
      : undefined;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.runPromise = this.run();
    // `start()` is deliberately fire-and-forget; keep every failure owned by
    // the session so transport rejection can never become unhandled.
    void this.runPromise.catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.stopRequested = true;
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

  onStateChange(cb: (state: Elm327State, detail?: string) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  getDiagnostics(): {
    observedHzByChannel: Record<string, number>;
    errorCount: number;
    lastError?: string;
  } {
    const observedHzByChannel: Record<string, number> = {};
    const end = this.pollingEndedAtMonoMs ?? this.monotonicNow();
    const elapsedMs =
      this.pollingStartedAtMonoMs === null ? 0 : Math.max(0, end - this.pollingStartedAtMonoMs);
    for (const [channel, count] of this.sampleCounts) {
      observedHzByChannel[channel] = elapsedMs > 0 ? (count * 1_000) / elapsedMs : 0;
    }
    return {
      observedHzByChannel,
      errorCount: this.errorCount,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  private async run(): Promise<void> {
    this.subscribeToTransport();
    try {
      this.transition('connecting');
      await this.transport.connect();
      this.throwIfTransportClosed();
      if (this.stopRequested) return;

      this.transition('initializing');
      for (const command of INIT_COMMANDS) {
        const result = await this.executeCommand(command, this.config.initTimeoutMs);
        const response = stripEcho(result.response, command);
        if (/UNABLE TO CONNECT/i.test(response)) {
          throw new Error(`ELM327 initialization failed: ${normalizedDetail(response)}`);
        }
        if (this.stopRequested) return;
      }

      this.transition('polling', this.pollingWarning);
      this.pollingStartedAtMonoMs = this.monotonicNow();
      if (this.pollEntries.length === 0) {
        await this.waitForStopOrClose();
        this.throwIfTransportClosed();
      } else {
        await this.pollLoop();
      }
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
    let nextPollAtMonoMs = this.monotonicNow();
    const tickIntervalMs = 1_000 / this.totalHz;

    while (!this.stopRequested) {
      await this.wait(Math.max(0, nextPollAtMonoMs - this.monotonicNow()));
      if (this.stopRequested) break;
      this.throwIfTransportClosed();

      const entry = this.selectNextChannel();
      nextPollAtMonoMs += tickIntervalMs;
      const command = entry.command;
      let result: CommandResult;
      try {
        result = await this.executeCommand(command, this.config.commandTimeoutMs);
      } catch (error) {
        if (this.stopRequested) break;
        if (this.transportClosed) throw error;
        this.recordChannelError(`${entry.channel}: ${errorMessage(error)}`);
        continue;
      }

      const response = stripEcho(result.response, command);
      const channelError = response.match(CHANNEL_ERROR_PATTERN)?.[0]?.trim();
      if (channelError !== undefined) {
        this.recordChannelError(`${entry.channel}: ${channelError}`);
        continue;
      }

      let value: number;
      try {
        if (entry.custom) {
          value = decodeCustomResponse(response, entry.channel);
        } else if (isMode01TelemetryChannel(entry.channel)) {
          value = decodeMode01Response(entry.channel, response);
        } else {
          throw new Error(`No telemetry decoder for ${entry.channel}`);
        }
      } catch (error) {
        this.recordChannelError(`${entry.channel}: ${errorMessage(error)}`);
        continue;
      }
      this.consecutiveErrors = 0;
      this.sampleCounts.set(entry.channel, (this.sampleCounts.get(entry.channel) ?? 0) + 1);
      this.emitSample({
        channel: entry.channel,
        value,
        tMonoMs: result.arrivedAtMonoMs,
      });
    }
  }

  private selectNextChannel(): PollEntry {
    let selected: PollEntry | undefined;
    for (const entry of this.pollEntries) {
      entry.currentWeight += entry.weight;
      if (selected === undefined || entry.currentWeight > selected.currentWeight) selected = entry;
    }
    if (selected === undefined) throw new Error('Polling requires at least one channel');
    selected.currentWeight -= this.totalHz;
    return selected;
  }

  private recordChannelError(detail: string): void {
    this.errorCount += 1;
    this.consecutiveErrors += 1;
    this.lastError = detail;
    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      throw new Error(
        `Maximum consecutive telemetry errors reached (${this.config.maxConsecutiveErrors}): ${detail}`,
      );
    }
  }

  private executeCommand(command: string, timeoutMs: number): Promise<CommandResult> {
    if (this.pending !== null) return Promise.reject(new Error('ELM327 command already in flight'));
    if (this.transportClosed) {
      return Promise.reject(this.transportError ?? new Error('ELM327 transport closed'));
    }

    return new Promise<CommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.command !== command) return;
        this.pending = null;
        reject(new Error(`ELM327 command timed out: ${command}`));
      }, timeoutMs);
      this.pending = { command, timeout, resolve, reject };
      try {
        this.transport.send(`${command}\r`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending = null;
        reject(asError(error));
      }
    });
  }

  private subscribeToTransport(): void {
    this.unsubscribeData = this.transport.onData((chunk) => {
      for (const response of this.framer.push(chunk)) {
        const pending = this.pending;
        if (pending === null) continue;
        this.pending = null;
        clearTimeout(pending.timeout);
        pending.resolve({ response, arrivedAtMonoMs: this.monotonicNow() });
      }
    });
    this.unsubscribeClose = this.transport.onClose((error) => {
      if (this.intentionalClose) return;
      this.transportClosed = true;
      this.transportError = error ?? new Error('ELM327 transport closed');
      const pending = this.pending;
      if (pending !== null) {
        this.pending = null;
        clearTimeout(pending.timeout);
        pending.reject(this.transportError);
      }
      this.cancelWait();
    });
  }

  private unsubscribeFromTransport(): void {
    this.unsubscribeData?.();
    this.unsubscribeClose?.();
    this.unsubscribeData = null;
    this.unsubscribeClose = null;
    this.framer.reset();
  }

  private async closeTransport(): Promise<void> {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    try {
      await this.transport.close();
    } catch (error) {
      if (this.state !== 'failed') {
        const detail = `ELM327 close failed: ${errorMessage(error)}`;
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

  private waitForStopOrClose(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveWait = resolve;
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
      throw this.transportError ?? new Error('ELM327 transport closed');
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

  private transition(state: Elm327State, detail?: string): void {
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

export function createElm327Session(
  transport: ObdTransport,
  config: Elm327Config,
  monotonicNow: () => number,
): Elm327Session {
  return new Elm327SessionEngine(transport, config, monotonicNow);
}

function validateConfig(config: Elm327Config): void {
  if (
    !Number.isFinite(config.initTimeoutMs) ||
    config.initTimeoutMs <= 0 ||
    !Number.isFinite(config.commandTimeoutMs) ||
    config.commandTimeoutMs <= 0 ||
    !Number.isInteger(config.maxConsecutiveErrors) ||
    config.maxConsecutiveErrors <= 0
  ) {
    throw new RangeError('ELM327 timeouts and maxConsecutiveErrors must be positive');
  }
  for (const item of config.pollPlan) {
    if (!Number.isFinite(item.hz) || item.hz <= 0) {
      throw new RangeError(`Telemetry poll rate must be positive for ${item.channel}`);
    }
  }
  for (const customPid of config.customPids ?? []) {
    const compactRequest = customPid.request.replace(/\s+/g, '');
    if (
      compactRequest.length === 0 ||
      compactRequest.length % 2 !== 0 ||
      !/^[0-9A-F]+$/i.test(compactRequest) ||
      /[\r\n]/.test(customPid.request)
    ) {
      throw new RangeError(`Custom PID request must be raw hex bytes for ${customPid.channel}`);
    }
  }
}

/** Binding custom-PID rule: decode the response's final data byte as A - 40. */
function decodeCustomResponse(response: string, channel: TelemetryChannelId): number {
  const match = /([0-9A-F]{2})$/i.exec(response.trim());
  if (match === null || match[1] === undefined) {
    throw new Error(`Missing custom PID data byte response for ${channel}`);
  }
  return Number.parseInt(match[1], 16) - 40;
}

function stripEcho(response: string, command: string): string {
  const compactCommand = command.replace(/\s+/g, '').toUpperCase();
  return response
    .split(/[\r\n]+/)
    .filter((line) => line.trim().replace(/\s+/g, '').toUpperCase() !== compactCommand)
    .join('\n');
}

function normalizedDetail(response: string): string {
  return response.replace(/[\r\n]+/g, ' ').trim() || 'empty response';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return asError(error).message;
}
