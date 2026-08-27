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

  /**
   * Field revision 2 (2026-08-27, binding — Phase 4h, P4h ticket item 3):
   * `noDataOnPids` is PID-keyed (unlike `noDataOnChannels`, which is
   * channel-keyed and would refuse EVERY PID mapping to that channel) --
   * this is what lets a test script "0x5A NRC'd, 0x49 still answers" for
   * `accelPedalPct`, the exact scenario `telemetryProvider.ts`'s pedal
   * fallback needs to react to.
   *
   * P4h-FIX1 H4 (after Codex P4h-REV1 HIGH): the source is no longer
   * process-global state a test has to set and restore -- it is
   * `Elm327Config.accelPedalPidSource`, frozen for that session's lifetime.
   */
  describe('noDataOnPids (Field revision 2, binding: pedal 0x5A NRC / 0x49 fallback simulation)', () => {
    it('refuses ONLY the scripted PID (0x5A) for accelPedalPct -- a session built for 0x49 (unscripted) then answers normally', async () => {
      vi.useFakeTimers();
      const clock = new FakeClock();
      const transport = new SimulatedElm327Transport({
        monotonicNow: () => clock.now(),
        noDataOnPids: ['5A'],
        seed: 7,
      });
      const session = createElm327Session(
        transport,
        config({ pollPlan: [{ channel: 'accelPedalPct', hz: 1 }], accelPedalPidSource: '5A' }),
        () => clock.now(),
      );
      const samples: TelemetrySample[] = [];
      session.onSample((sample) => samples.push(sample));
      await startUntil(session, 'polling');

      for (let index = 0; index < 4; index += 1) {
        clock.advance(500);
        await vi.advanceTimersByTimeAsync(500);
      }
      await session.stop();

      expect(samples).toHaveLength(0); // 0x5A was scripted NO DATA -- no accelPedalPct sample ever arrived.
      expect(session.getDiagnostics().errorCount).toBeGreaterThan(0);
      expect(session.getDiagnostics().lastError).toContain('accelPedalPct');
    });

    it('the SAME scripted noDataOnPids leaves 0x49 (unscripted) answering normally -- proves the refusal is PID-keyed, not channel-keyed', async () => {
      vi.useFakeTimers();
      const clock = new FakeClock();
      const transport = new SimulatedElm327Transport({
        monotonicNow: () => clock.now(),
        noDataOnPids: ['5A'],
        seed: 7,
      });
      const session = createElm327Session(
        transport,
        // The mobile provider's fallback -- a FRESH session built with the
        // switched source in ITS OWN config (P4h-FIX1 H4).
        config({ pollPlan: [{ channel: 'accelPedalPct', hz: 1 }], accelPedalPidSource: '49' }),
        () => clock.now(),
      );
      const samples: TelemetrySample[] = [];
      session.onSample((sample) => samples.push(sample));
      await startUntil(session, 'polling');

      for (let index = 0; index < 4; index += 1) {
        clock.advance(500);
        await vi.advanceTimersByTimeAsync(500);
      }
      await session.stop();

      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((sample) => sample.channel === 'accelPedalPct' && Number.isFinite(sample.value))).toBe(
        true,
      );
      expect(session.getDiagnostics().errorCount).toBe(0);
    });

    /**
     * P4h-FIX1 H4 (after Codex P4h-REV1 HIGH, `pidCodec.ts:40-58,88-93`;
     * `elm327Session.ts:123-125,274-284`): "provider/session A was constructed
     * for 0x5A; provider B or a test switches the global to 0x49; A continues
     * sending 0x5A but rejects every valid response as 'Missing mode 01 PID
     * 49'." Two LIVE sessions, each frozen to its own source, polling at the
     * same time: each must decode its own responses cleanly.
     */
    it('two concurrent sessions with DIFFERENT accelPedal PIDs decode independently (no shared state)', async () => {
      vi.useFakeTimers();
      const clock = new FakeClock();
      const makeSession = (source: '5A' | '49', noDataOnPids: string[]): Elm327Session =>
        createElm327Session(
          new SimulatedElm327Transport({ monotonicNow: () => clock.now(), noDataOnPids, seed: 7 }),
          config({ pollPlan: [{ channel: 'accelPedalPct', hz: 1 }], accelPedalPidSource: source }),
          () => clock.now(),
        );

      // Session A polls the PRIMARY source against an ECU that answers it;
      // session B polls the FALLBACK against an ECU that refuses 0x5A -- the
      // exact "old generation still alive while a new one switched" shape.
      const sessionA = makeSession('5A', []);
      const sessionB = makeSession('49', ['5A']);
      const samplesA: TelemetrySample[] = [];
      const samplesB: TelemetrySample[] = [];
      sessionA.onSample((sample) => samplesA.push(sample));
      sessionB.onSample((sample) => samplesB.push(sample));
      await Promise.all([startUntil(sessionA, 'polling'), startUntil(sessionB, 'polling')]);

      for (let index = 0; index < 4; index += 1) {
        clock.advance(500);
        await vi.advanceTimersByTimeAsync(500);
      }
      await Promise.all([sessionA.stop(), sessionB.stop()]);

      expect(samplesA.length).toBeGreaterThan(0);
      expect(samplesB.length).toBeGreaterThan(0);
      expect(samplesA.every((s) => s.channel === 'accelPedalPct' && Number.isFinite(s.value))).toBe(true);
      expect(samplesB.every((s) => s.channel === 'accelPedalPct' && Number.isFinite(s.value))).toBe(true);
      // Neither session ever rejected a valid response for "the other one's" PID.
      expect(sessionA.getDiagnostics().errorCount).toBe(0);
      expect(sessionB.getDiagnostics().errorCount).toBe(0);
    });
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
