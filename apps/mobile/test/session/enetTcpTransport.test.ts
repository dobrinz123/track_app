import { describe, expect, it, vi } from 'vitest';
import { bytesToBinaryString } from '@circuit/core';
import { EnetTcpTransport } from '../../src/session/enetTcpTransport';

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

    await expect(connectPromise).rejects.toThrow(/close\(\)/);
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
