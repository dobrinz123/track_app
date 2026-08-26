import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBinaryString } from '@circuit/core';
import { EnetTcpTransport } from '../../src/session/enetTcpTransport';

/** A minimal fake `react-native-tcp-socket` `Socket`: a tiny event emitter plus `write`/`destroy` spies, enough for every test in this file to drive `connect`/`data`/`error`/`close` deterministically. */
function makeFakeSocket() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event: string, handler: (...args: unknown[]) => void): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event: string, ...args: unknown[]): void {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    write: vi.fn(() => true),
    destroy: vi.fn(),
  };
}

async function connectedTransport(fakeSocket: ReturnType<typeof makeFakeSocket>): Promise<EnetTcpTransport> {
  const createConnection = (_opts: unknown, onConnect: () => void) => {
    queueMicrotask(onConnect);
    return fakeSocket;
  };
  const transport = new EnetTcpTransport({
    host: '192.168.4.20',
    port: 6_801,
    loadModule: async () => ({ default: { createConnection } }) as unknown as typeof import('react-native-tcp-socket'),
  });
  await transport.connect();
  return transport;
}

/**
 * Mirrors `tcpObdTransport.test.ts`'s own F9-fix coverage (same lazy-load /
 * closed-flag / single-close-notification discipline), plus the ONE real
 * difference this transport has from the ELM327 one: byte-safety. HSFZ is a
 * raw binary protocol (byte values 0-255), so this transport must never let
 * a byte >= 0x80 round-trip through a lossy string encoding.
 */
describe('EnetTcpTransport: close() during a pending module import (mirrors tcpObdTransport.ts F9 fix)', () => {
  it('close() while connect() is still loading the transport module leaves connect() rejecting cleanly, without ever creating a socket', async () => {
    const createConnection = vi.fn();
    let resolveImport: (() => void) | null = null;
    const importPromise = new Promise<typeof import('react-native-tcp-socket')>((resolve) => {
      resolveImport = () => {
        resolve({ default: { createConnection } } as unknown as typeof import('react-native-tcp-socket'));
      };
    });

    const transport = new EnetTcpTransport({
      host: '192.168.4.20',
      port: 6_801,
      loadModule: () => importPromise,
    });

    const connectPromise = transport.connect();
    await transport.close();
    resolveImport!();

    await expect(connectPromise).rejects.toThrow(/closed/);
    expect(createConnection).not.toHaveBeenCalled();
  });
});

describe('EnetTcpTransport: byte-safety over react-native-tcp-socket', () => {
  it('send() decodes the ObdTransport binary-string convention back into a raw Uint8Array and writes it directly (no string encoding)', async () => {
    const written: Array<string | Buffer | Uint8Array> = [];
    const fakeSocket = {
      on: () => undefined,
      write: (data: string | Buffer | Uint8Array) => {
        written.push(data);
        return true;
      },
      destroy: () => undefined,
    };
    const createConnection = (_opts: unknown, onConnect: () => void) => {
      queueMicrotask(onConnect);
      return fakeSocket;
    };

    const transport = new EnetTcpTransport({
      host: '192.168.4.20',
      port: 6_801,
      loadModule: async () =>
        ({ default: { createConnection } }) as unknown as typeof import('react-native-tcp-socket'),
    });
    await transport.connect();

    // A byte sequence spanning the full 0-255 range, including values >= 0x80
    // that an 'ascii'-encoded write (Node's convention: masks to 7 bits)
    // would silently corrupt.
    const frameBytes = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xa5, 0xff]);
    transport.send(bytesToBinaryString(frameBytes));

    expect(written).toHaveLength(1);
    expect(written[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(written[0] as Uint8Array)).toEqual(Array.from(frameBytes));
  });

  it('onData() converts a received Buffer/Uint8Array chunk into the ObdTransport binary-string convention losslessly, byte-for-byte', async () => {
    let dataHandler: ((chunk: Buffer) => void) | null = null;
    const fakeSocket = {
      on: (event: string, handler: (...args: never[]) => void) => {
        if (event === 'data') dataHandler = handler as (chunk: Buffer) => void;
      },
      write: () => true,
      destroy: () => undefined,
    };
    const createConnection = (_opts: unknown, onConnect: () => void) => {
      queueMicrotask(onConnect);
      return fakeSocket;
    };

    const transport = new EnetTcpTransport({
      host: '192.168.4.20',
      port: 6_801,
      loadModule: async () =>
        ({ default: { createConnection } }) as unknown as typeof import('react-native-tcp-socket'),
    });
    await transport.connect();

    const received: string[] = [];
    transport.onData((chunk) => received.push(chunk));

    const incomingBytes = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xa5, 0xff]);
    dataHandler!(Buffer.from(incomingBytes));

    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!, (ch) => ch.charCodeAt(0))).toEqual(Array.from(incomingBytes));
  });
});

/**
 * P4e-FIX2 M2 fix (binding, Codex P4e-REV2 Part B): "remote close/error ->
 * closed=true, socket=null; send() after close rejects; second connect()
 * rejects" -- the review's finding was that ONLY the close-notification
 * itself was deduplicated (`closeEmitted`), while `closed`/`socket` silently
 * kept claiming the transport was still open, so `send()` after a remote
 * close wrote to a dead socket instead of throwing, and nothing stopped a
 * second `connect()` from creating ANOTHER socket on the same "one-shot"
 * instance.
 */
describe('EnetTcpTransport: one-shot terminal state after remote close/error (P4e-FIX2 M2 fix)', () => {
  it('a remote "close" event: closed=true, socket=null (send() throws instead of writing to a dead socket)', async () => {
    const fakeSocket = makeFakeSocket();
    const transport = await connectedTransport(fakeSocket);

    const closeEvents: Array<Error | undefined> = [];
    transport.onClose((err) => closeEvents.push(err));

    fakeSocket.emit('close');

    expect(closeEvents).toHaveLength(1);
    expect(() => transport.send('x')).toThrow(/send\(\)/);
    expect(fakeSocket.write).not.toHaveBeenCalled();
  });

  it('a remote "error" event (with no following close): closed=true, socket=null, send() throws', async () => {
    const fakeSocket = makeFakeSocket();
    const transport = await connectedTransport(fakeSocket);

    const closeEvents: Array<Error | undefined> = [];
    transport.onClose((err) => closeEvents.push(err));

    const remoteError = new Error('ECONNRESET (test double)');
    fakeSocket.emit('error', remoteError);

    expect(closeEvents).toEqual([remoteError]);
    expect(() => transport.send('x')).toThrow(/send\(\)/);
  });

  it('a second connect() after a remote close rejects (one-shot instance, never reused)', async () => {
    const fakeSocket = makeFakeSocket();
    const transport = await connectedTransport(fakeSocket);

    fakeSocket.emit('close');

    await expect(transport.connect()).rejects.toThrow(/closed/);
  });

  it('"error" immediately followed by "close" emits exactly ONE close notification, carrying the error', async () => {
    const fakeSocket = makeFakeSocket();
    const transport = await connectedTransport(fakeSocket);

    const closeEvents: Array<Error | undefined> = [];
    transport.onClose((err) => closeEvents.push(err));

    const remoteError = new Error('boom (test double)');
    fakeSocket.emit('error', remoteError);
    fakeSocket.emit('close');

    expect(closeEvents).toHaveLength(1);
    expect(closeEvents[0]).toBe(remoteError);
  });

  it("close() (local) still leaves closed/socket in the SAME terminal state remote close does -- a second connect() rejects", async () => {
    const fakeSocket = makeFakeSocket();
    const transport = await connectedTransport(fakeSocket);

    await transport.close();

    expect(() => transport.send('x')).toThrow(/send\(\)/);
    await expect(transport.connect()).rejects.toThrow(/closed/);
  });
});

describe('EnetTcpTransport: connect() timeout (P4e-FIX2 M2, binding: "connect timeout is tested")', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects after connectTimeoutMs when the socket never connects, and destroys the socket', async () => {
    const fakeSocket = makeFakeSocket();
    const createConnection = () => fakeSocket; // never invokes the connect callback.
    const transport = new EnetTcpTransport({
      host: '192.168.4.20',
      port: 6_801,
      connectTimeoutMs: 5_000,
      loadModule: async () => ({ default: { createConnection } }) as unknown as typeof import('react-native-tcp-socket'),
    });

    const connectPromise = transport.connect();
    const assertion = expect(connectPromise).rejects.toThrow(/timed out after 5000ms/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(fakeSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('a connect() that resolves before the timeout never rejects (no spurious timeout)', async () => {
    const fakeSocket = makeFakeSocket();
    const createConnection = (_opts: unknown, onConnect: () => void) => {
      queueMicrotask(onConnect);
      return fakeSocket;
    };
    const transport = new EnetTcpTransport({
      host: '192.168.4.20',
      port: 6_801,
      connectTimeoutMs: 5_000,
      loadModule: async () => ({ default: { createConnection } }) as unknown as typeof import('react-native-tcp-socket'),
    });

    await expect(transport.connect()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fakeSocket.destroy).not.toHaveBeenCalled();
  });
});

/**
 * P4e-FIX3 M2 fix (binding, Codex P4e-REV3 residual): "error/close/timeout
 * BEFORE the connect callback -> connect() rejects AND the instance becomes
 * terminal (closed=true, socket destroyed & null; later send() rejects;
 * second connect() rejects)". Chosen and documented close-notification rule
 * for this phase (see `terminalizeConnectionPhaseFailure`'s own doc
 * comment): a socket that never successfully connects NEVER fires
 * `onClose` -- only the rejected `connect()` promise reports the failure.
 */
describe('EnetTcpTransport: connection-phase failures terminalize the instance (P4e-FIX3 M2 fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A transport whose `connect()` is left pending (the fake socket never
   * invokes the connect callback) so a test can fire `error`/`close` on it
   * BEFORE that callback would ever run. `connect()` itself `await`s the
   * (async) `loadModule()` before the fake socket's `.on()` handlers are
   * even registered -- this helper awaits past that microtask first, so the
   * returned `fakeSocket` is guaranteed listener-ready before the caller
   * emits anything on it.
   */
  async function pendingConnectTransport(fakeSocket: ReturnType<typeof makeFakeSocket>): Promise<{
    transport: EnetTcpTransport;
    connectPromise: Promise<void>;
  }> {
    const createConnection = () => fakeSocket; // never invokes the connect callback.
    const transport = new EnetTcpTransport({
      host: '192.168.4.20',
      port: 6_801,
      loadModule: async () => ({ default: { createConnection } }) as unknown as typeof import('react-native-tcp-socket'),
    });
    const connectPromise = transport.connect();
    await Promise.resolve();
    await Promise.resolve();
    return { transport, connectPromise };
  }

  it('a pre-connect "error": connect() rejects, closed=true (send() throws, a second connect() rejects), onClose is NEVER called', async () => {
    const fakeSocket = makeFakeSocket();
    const { transport, connectPromise } = await pendingConnectTransport(fakeSocket);
    const closeEvents: Array<Error | undefined> = [];
    transport.onClose((err) => closeEvents.push(err));

    const connectError = new Error('ECONNREFUSED (test double)');
    fakeSocket.emit('error', connectError);

    await expect(connectPromise).rejects.toBe(connectError);
    expect(() => transport.send('x')).toThrow(/send\(\)/);
    await expect(transport.connect()).rejects.toThrow(/closed/);
    expect(closeEvents).toEqual([]); // chosen rule: no onClose for a never-connected socket.
  });

  it('a pre-connect "close" (no prior error): connect() rejects, closed=true, send() throws, a second connect() rejects, onClose is NEVER called', async () => {
    const fakeSocket = makeFakeSocket();
    const { transport, connectPromise } = await pendingConnectTransport(fakeSocket);
    const closeEvents: Array<Error | undefined> = [];
    transport.onClose((err) => closeEvents.push(err));

    fakeSocket.emit('close');

    await expect(connectPromise).rejects.toThrow(/closed before connecting/);
    expect(() => transport.send('x')).toThrow(/send\(\)/);
    await expect(transport.connect()).rejects.toThrow(/closed/);
    expect(closeEvents).toEqual([]);
  });

  it('a pre-connect "error" immediately followed by "close" still yields ZERO onClose calls (both are connection-phase)', async () => {
    const fakeSocket = makeFakeSocket();
    const { transport, connectPromise } = await pendingConnectTransport(fakeSocket);
    const closeEvents: Array<Error | undefined> = [];
    transport.onClose((err) => closeEvents.push(err));

    fakeSocket.emit('error', new Error('boom (test double)'));
    fakeSocket.emit('close');

    await expect(connectPromise).rejects.toThrow();
    expect(closeEvents).toEqual([]);
  });

  it('connect-timeout: closed=true (send() throws, a second connect() rejects), onClose is NEVER called', async () => {
    const fakeSocket = makeFakeSocket();
    const createConnection = () => fakeSocket; // never invokes the connect callback.
    const transport = new EnetTcpTransport({
      host: '192.168.4.20',
      port: 6_801,
      connectTimeoutMs: 5_000,
      loadModule: async () => ({ default: { createConnection } }) as unknown as typeof import('react-native-tcp-socket'),
    });
    const closeEvents: Array<Error | undefined> = [];
    transport.onClose((err) => closeEvents.push(err));

    const connectPromise = transport.connect();
    const assertion = expect(connectPromise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(fakeSocket.destroy).toHaveBeenCalledTimes(1);
    expect(() => transport.send('x')).toThrow(/send\(\)/);
    await expect(transport.connect()).rejects.toThrow(/closed/);
    expect(closeEvents).toEqual([]);
  });
});
