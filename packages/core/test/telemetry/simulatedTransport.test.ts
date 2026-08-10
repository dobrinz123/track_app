import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createElm327Session,
  decodeMode01Response,
  DEFAULT_SIMULATED_VEHICLE_SCENARIO,
  SimulatedElm327Transport,
  type Elm327Config,
  type Elm327Session,
  type Elm327State,
  type ObdTransport,
  type TelemetrySample,
} from '../../src/telemetry';
import { FakeClock } from '../controller/testSupport';

/** Awaits exactly the microtask the simulated transport schedules its response on. */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

function config(overrides: Partial<Elm327Config> = {}): Elm327Config {
  return {
    pollPlan: [],
    initTimeoutMs: 500,
    commandTimeoutMs: 200,
    maxConsecutiveErrors: 5,
    ...overrides,
  };
}

function nextState(session: Elm327Session, target: Elm327State): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = session.onStateChange((state) => {
      if (state !== target) return;
      unsubscribe();
      resolve();
    });
  });
}

async function startUntil(session: Elm327Session, target: Elm327State): Promise<void> {
  const reached = nextState(session, target);
  session.start();
  await reached;
}

/**
 * Minimal transport local to one test: the simulator has no knob for a
 * post-connect adapter rejection, so this scripts 'UNABLE TO CONNECT' for
 * the very first init command and echoes OK for everything after.
 */
class UnableToConnectTransport implements ObdTransport {
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();

  async connect(): Promise<void> {}

  send(line: string): void {
    const command = line.replace(/[\r\n]+/g, '');
    const reply = command === 'ATZ' ? 'UNABLE TO CONNECT\r' : `${command}\rOK\r`;
    queueMicrotask(() => {
      for (const listener of [...this.dataListeners]) listener(`${reply}>`);
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

  async close(): Promise<void> {}
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SimulatedElm327Transport', () => {
  it('is deterministic: same scenario+seed, same command sequence, identical response streams', async () => {
    const commands = ['ATZ\r', 'ATE0\r', 'ATL0\r', 'ATS0\r', 'ATSP0\r', '010C\r', '010D\r', '0105\r', '010C\r'];

    async function run(): Promise<string[]> {
      const clock = new FakeClock();
      const transport = new SimulatedElm327Transport({
        monotonicNow: () => clock.now(),
        scenario: DEFAULT_SIMULATED_VEHICLE_SCENARIO,
        seed: 42,
      });
      const chunks: string[] = [];
      transport.onData((chunk) => chunks.push(chunk));
      await transport.connect();
      for (const command of commands) {
        transport.send(command);
        await flushMicrotasks();
        clock.advance(50);
      }
      return chunks;
    }

    const a = await run();
    const b = await run();
    expect(a).toHaveLength(commands.length);
    expect(a).toEqual(b);
  });

  it('decodes samples through a live session when responses arrive byte-fragmented', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedElm327Transport({
      monotonicNow: () => clock.now(),
      chunkFragmentation: true,
      seed: 7,
    });
    const session = createElm327Session(
      transport,
      config({ pollPlan: [{ channel: 'rpm', hz: 10 }] }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 5; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((sample) => sample.channel === 'rpm' && Number.isFinite(sample.value))).toBe(true);
    expect(session.getDiagnostics().errorCount).toBe(0);
  });

  it('counts noDataOnChannels errors on the affected channel while other channels keep flowing', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedElm327Transport({
      monotonicNow: () => clock.now(),
      noDataOnChannels: ['coolantC'],
      seed: 3,
    });
    const session = createElm327Session(
      transport,
      config({
        pollPlan: [
          { channel: 'rpm', hz: 1 },
          { channel: 'coolantC', hz: 1 },
        ],
      }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 8; index += 1) {
      clock.advance(500);
      await vi.advanceTimersByTimeAsync(500);
    }
    await session.stop();

    const diagnostics = session.getDiagnostics();
    expect(diagnostics.errorCount).toBeGreaterThan(0);
    expect(diagnostics.lastError).toContain('coolantC');
    expect(samples.some((sample) => sample.channel === 'rpm')).toBe(true);
    expect(samples.some((sample) => sample.channel === 'coolantC')).toBe(false);
  });

  it('drives the session to failed on disconnectAfterNCommands, with no unhandled rejection', async () => {
    const clock = new FakeClock();
    const transport = new SimulatedElm327Transport({
      monotonicNow: () => clock.now(),
      disconnectAfterNCommands: 2,
      seed: 5,
    });
    const session = createElm327Session(transport, config(), () => clock.now());

    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const failed = nextState(session, 'failed');
      session.start();
      await failed;
      // Give any would-be unhandled rejection a chance to surface before asserting.
      await flushMicrotasks();
      await flushMicrotasks();
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }

    expect(session.getDiagnostics().lastError).toBeDefined();
    expect(rejections).toEqual([]);
  });

  it('still decodes samples when a deterministic garbage-byte prefix corrupts every frame', async () => {
    const clock = new FakeClock();
    const transport = new SimulatedElm327Transport({
      monotonicNow: () => clock.now(),
      garbagePrefixBytes: 4,
      seed: 9,
    });
    const chunks: string[] = [];
    transport.onData((chunk) => chunks.push(chunk));
    await transport.connect();
    for (const command of ['ATZ\r', 'ATE0\r', 'ATL0\r', 'ATS0\r', 'ATSP0\r', '010C\r']) {
      transport.send(command);
      await flushMicrotasks();
    }

    const rpmFrame = chunks[chunks.length - 1] ?? '';
    expect(rpmFrame.length).toBeGreaterThan(4);
    expect(() => decodeMode01Response('rpm', rpmFrame)).not.toThrow();
    expect(Number.isFinite(decodeMode01Response('rpm', rpmFrame))).toBe(true);
  });
});

describe("SimulatedElm327Transport-adjacent 'UNABLE TO CONNECT' handling", () => {
  it("fails the session when init receives 'UNABLE TO CONNECT' (scripted locally: the simulator has no knob for it)", async () => {
    const transport = new UnableToConnectTransport();
    const session = createElm327Session(transport, config(), () => 0);

    const failed = nextState(session, 'failed');
    session.start();
    await failed;

    expect(session.getDiagnostics().lastError).toContain('UNABLE TO CONNECT');
  });
});
