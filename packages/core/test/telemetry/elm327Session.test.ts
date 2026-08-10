import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createElm327Session,
  type Elm327Config,
  type Elm327Session,
  type Elm327State,
  type ObdTransport,
  type TelemetrySample,
} from '../../src/telemetry';
import { FakeClock } from '../controller/testSupport';

type Reply = string | 'close' | 'hold';

class ScriptedTransport implements ObdTransport {
  readonly sent: string[] = [];
  closeCount = 0;
  connectCount = 0;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private heldCommand: string | null = null;

  constructor(private readonly reply: (command: string, commandNumber: number) => Reply) {}

  async connect(): Promise<void> {
    this.connectCount += 1;
  }

  send(line: string): void {
    this.sent.push(line);
    const command = line.replace(/[\r\n]+/g, '');
    const reply = this.reply(command, this.sent.length);
    if (reply === 'hold') {
      this.heldCommand = command;
      return;
    }
    void Promise.resolve().then(() => {
      if (reply === 'close') {
        for (const listener of [...this.closeListeners]) {
          listener(new Error('socket dropped mid-command'));
        }
        return;
      }
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

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  respondHeld(response: string): void {
    if (this.heldCommand === null) throw new Error('No command is held');
    this.heldCommand = null;
    for (const listener of [...this.dataListeners]) listener(`${response}>`);
  }
}

const INIT_COMMANDS_WITH_CR = ['ATZ\r', 'ATE0\r', 'ATL0\r', 'ATS0\r', 'ATSP0\r'];

function config(overrides: Partial<Elm327Config> = {}): Elm327Config {
  return {
    pollPlan: [],
    initTimeoutMs: 500,
    commandTimeoutMs: 200,
    maxConsecutiveErrors: 5,
    ...overrides,
  };
}

function normalReply(command: string): string {
  if (command.startsWith('AT')) return `${command}\rOK\r`;
  if (command === '010C') return `${command}\r41 0C 1A F8\r`;
  if (command === '0105') return `${command}\r41 05 78\r`;
  return 'NO DATA\r';
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

afterEach(() => {
  vi.useRealTimers();
});

describe('ELM327 session', () => {
  it('pins the exact initialization command sequence and awaits every prompt', async () => {
    const transport = new ScriptedTransport(normalReply);
    const session = createElm327Session(transport, config(), () => 10);

    await startUntil(session, 'polling');
    expect(transport.sent).toEqual(INIT_COMMANDS_WITH_CR);
    expect(transport.connectCount).toBe(1);

    await session.stop();
    expect(transport.closeCount).toBe(1);
  });

  it('honors a 10:1 weighted poll plan on an injected fake clock', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new ScriptedTransport(normalReply);
    const session = createElm327Session(
      transport,
      config({
        pollPlan: [
          { channel: 'rpm', hz: 10 },
          { channel: 'coolantC', hz: 1 },
        ],
      }),
      () => clock.now(),
    );
    await startUntil(session, 'polling');

    for (let index = 0; index < 100; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    const observed = session.getDiagnostics().observedHzByChannel;
    expect(observed.coolantC).toBeGreaterThan(0.5);
    expect((observed.rpm ?? 0) / (observed.coolantC ?? 1)).toBeGreaterThanOrEqual(9);
    expect((observed.rpm ?? 0) / (observed.coolantC ?? 1)).toBeLessThanOrEqual(11);
  });

  it('escalates max consecutive channel errors but survives one NO DATA', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    let pollReplies = 0;
    const recoveringTransport = new ScriptedTransport((command) => {
      if (command.startsWith('AT')) return normalReply(command);
      pollReplies += 1;
      return pollReplies === 1 ? 'NO DATA\r' : normalReply(command);
    });
    const recoveringStates: Elm327State[] = [];
    const recovering = createElm327Session(
      recoveringTransport,
      config({ pollPlan: [{ channel: 'rpm', hz: 10 }], maxConsecutiveErrors: 3 }),
      () => clock.now(),
    );
    recovering.onStateChange((state) => recoveringStates.push(state));
    await startUntil(recovering, 'polling');
    clock.advance(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(recoveringStates).not.toContain('failed');
    expect(recovering.getDiagnostics().errorCount).toBe(1);
    expect(recovering.getDiagnostics().observedHzByChannel.rpm).toBeGreaterThan(0);
    await recovering.stop();

    const failingTransport = new ScriptedTransport((command) =>
      command.startsWith('AT') ? normalReply(command) : 'NO DATA\r',
    );
    const failing = createElm327Session(
      failingTransport,
      config({ pollPlan: [{ channel: 'rpm', hz: 10 }], maxConsecutiveErrors: 3 }),
      () => clock.now(),
    );
    const failed = nextState(failing, 'failed');
    failing.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(failing.getDiagnostics().errorCount).toBe(3);
    expect(failing.getDiagnostics().lastError).toContain('Maximum consecutive telemetry errors');
  });

  it('polls a custom PID verbatim and decodes the last byte of a multi-byte response', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new ScriptedTransport((command) => {
      if (command.startsWith('AT')) return normalReply(command);
      if (command === '221E1C') return `${command}\r62 1E 1C 87\r`;
      return 'NO DATA\r';
    });
    const session = createElm327Session(
      transport,
      config({
        pollPlan: [{ channel: 'transOilC', hz: 2 }],
        customPids: [{ channel: 'transOilC', request: '221E1C' }],
      }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));

    await startUntil(session, 'polling');
    await vi.advanceTimersByTimeAsync(0);
    await session.stop();

    expect(transport.sent[5]).toBe('221E1C\r');
    expect(samples[0]).toEqual({ channel: 'transOilC', value: 95, tMonoMs: 0 });
    expect(session.getDiagnostics().errorCount).toBe(0);
  });

  it('escalates custom PID channel errors through the shared error budget', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new ScriptedTransport((command) =>
      command.startsWith('AT') ? normalReply(command) : 'NO DATA\r',
    );
    const session = createElm327Session(
      transport,
      config({
        pollPlan: [{ channel: 'transOilC', hz: 10 }],
        customPids: [{ channel: 'transOilC', request: '221E1C' }],
        maxConsecutiveErrors: 3,
      }),
      () => clock.now(),
    );
    const failed = nextState(session, 'failed');

    session.start();
    clock.advance(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;

    expect(session.getDiagnostics().errorCount).toBe(3);
    expect(session.getDiagnostics().lastError).toContain('Maximum consecutive telemetry errors');
    expect(transport.sent.filter((line) => line === '221E1C\r')).toHaveLength(3);
  });

  it('ignores transOilC without custom configuration and warns exactly once', async () => {
    vi.useFakeTimers();
    const transport = new ScriptedTransport(normalReply);
    const session = createElm327Session(
      transport,
      config({ pollPlan: [{ channel: 'transOilC', hz: 2 }] }),
      () => 0,
    );
    const warningDetails: string[] = [];
    session.onStateChange((state, detail) => {
      if (state === 'polling' && detail !== undefined) warningDetails.push(detail);
    });

    await startUntil(session, 'polling');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.sent).toEqual(INIT_COMMANDS_WITH_CR);
    expect(warningDetails).toEqual([
      'Ignoring transOilC poll entry: no matching custom PID is configured',
    ]);

    await session.stop();
    expect(transport.sent).toEqual(INIT_COMMANDS_WITH_CR);
  });

  it('turns a mid-command disconnect into failed without an escaping rejection', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new ScriptedTransport((command, commandNumber) =>
      commandNumber === 6 ? 'close' : normalReply(command),
    );
    const session = createElm327Session(
      transport,
      config({ pollPlan: [{ channel: 'rpm', hz: 10 }] }),
      () => clock.now(),
    );
    const failed = nextState(session, 'failed');
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    await failed;

    expect(session.getDiagnostics().lastError).toContain('socket dropped mid-command');
    expect(transport.closeCount).toBe(1);
  });

  it('stop during polling finishes the in-flight command, then closes', async () => {
    vi.useFakeTimers();
    const transport = new ScriptedTransport((command, commandNumber) =>
      commandNumber === 6 ? 'hold' : normalReply(command),
    );
    const session = createElm327Session(
      transport,
      config({ pollPlan: [{ channel: 'rpm', hz: 10 }] }),
      () => 0,
    );
    await startUntil(session, 'polling');
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sent).toHaveLength(6);

    let stopped = false;
    const stopping = session.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(transport.closeCount).toBe(0);

    transport.respondHeld('41 0C 1A F8\r');
    await stopping;
    expect(stopped).toBe(true);
    expect(transport.closeCount).toBe(1);
  });
});
