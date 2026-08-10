import { describe, expect, it, vi } from 'vitest';
import { TcpObdTransport } from '../../src/session/tcpObdTransport';

/**
 * F9 fix (WPT3): `connect()` re-checks its `closed` flag AFTER the lazy
 * `react-native-tcp-socket` import resolves and BEFORE creating a socket --
 * a `close()` that lands while that import is still pending must leave
 * `connect()` unable to open a socket at all. `loadModule` (this ticket's
 * new test-only injection seam) is what makes the import's timing
 * controllable here, instead of the real dynamic `import()`.
 */
describe('TcpObdTransport: close() during a pending module import (F9 fix)', () => {
  it('close() while connect() is still loading the transport module leaves connect() rejecting cleanly, without ever creating a socket', async () => {
    const createConnection = vi.fn();
    let resolveImport: (() => void) | null = null;
    const importPromise = new Promise<typeof import('react-native-tcp-socket')>((resolve) => {
      resolveImport = () => {
        resolve({ default: { createConnection } } as unknown as typeof import('react-native-tcp-socket'));
      };
    });

    const transport = new TcpObdTransport({
      host: '192.168.4.1',
      port: 35_000,
      loadModule: () => importPromise,
    });

    const connectPromise = transport.connect();
    // close() races in WHILE the import above is still pending.
    await transport.close();
    resolveImport!();

    await expect(connectPromise).rejects.toThrow(/close\(\)/);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('a normal connect() (no close() racing in) still creates exactly one socket and resolves once it connects', async () => {
    const fakeSocket = { on: vi.fn(), write: vi.fn(), destroy: vi.fn() };
    const createConnection = vi.fn((_opts: unknown, onConnect: () => void) => {
      queueMicrotask(onConnect);
      return fakeSocket;
    });

    const transport = new TcpObdTransport({
      host: '192.168.4.1',
      port: 35_000,
      loadModule: async () =>
        ({ default: { createConnection } }) as unknown as typeof import('react-native-tcp-socket'),
    });

    await transport.connect();
    expect(createConnection).toHaveBeenCalledTimes(1);
  });
});
