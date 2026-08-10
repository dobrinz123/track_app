import type { ObdTransport } from '@circuit/core';
// Type-only -- erased at compile time, so this never actually loads
// `react-native-tcp-socket`'s native-module entry point (mirrors
// `voiceCoach.ts`'s `import type { AudioPlayer, AudioStatus } from
// 'expo-audio';`). The real module is only ever reached through
// `loadTcpSocketModule`'s lazy dynamic `import()` inside `connect()` below.
import type TcpSocketApi from 'react-native-tcp-socket';

type TcpSocketNamespace = typeof TcpSocketApi;
type TcpSocketInstance = ReturnType<TcpSocketNamespace['createConnection']>;

/**
 * `react-native-tcp-socket` is a native module -- loading it lazily, only
 * inside `connect()` below, keeps this module's own static imports (and
 * every test that imports `telemetryProvider.ts`/this module without mocking
 * it) safe under vitest's pure-Node/Vite transform, exactly the reasoning
 * `voiceCoach.ts`'s `loadAudioModule`/`loadSpeechModule` document for
 * `expo-audio`/`expo-speech`.
 */
async function loadTcpSocketModule(): Promise<typeof import('react-native-tcp-socket')> {
  return import('react-native-tcp-socket');
}

export interface TcpObdTransportConfig {
  host: string;
  port: number;
  /** `connect()` timeout in ms -- rejects and destroys the socket if exceeded. Default 5000 (Telemetry addendum). */
  connectTimeoutMs?: number;
  /** Test-only seam (F9 fix, WPT3): overrides the lazy `react-native-tcp-socket` import so a test can control exactly when it resolves. Production callers never pass this -- defaults to the real dynamic `import()`. */
  loadModule?: () => Promise<typeof import('react-native-tcp-socket')>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * `ObdTransport` (Telemetry addendum, docs/architecture/contracts.md)
 * implementation over `react-native-tcp-socket` -- the mobile-side transport
 * an `Elm327Session` (`@circuit/core`) drives against a WiFi OBD-II adapter
 * on the local network. STRICTLY a byte pipe: no protocol knowledge lives
 * here (framing/parsing/PID decoding are `@circuit/core`'s job) -- `send()`
 * writes ASCII lines, `onData` delivers raw ASCII chunks exactly as the
 * socket emits them (arbitrary split/merge, per the contract), and
 * `onClose`/error handling never retries internally (`ObdTransport.connect`'s
 * own contract: "rejects on failure; no auto-retry inside" -- reconnect
 * policy is `telemetryProvider.ts`'s job, one layer up).
 */
export class TcpObdTransport implements ObdTransport {
  private socket: TcpSocketInstance | null = null;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(err?: Error) => void>();
  /** Guards against `onClose` firing twice for one lifecycle (e.g. an 'error' event immediately followed by 'close'). */
  private closeEmitted = false;
  /** F9 fix (WPT3): set by `close()`, re-checked by `connect()` AFTER the lazy module import resolves and BEFORE a socket is created -- a `close()` that lands while the import is still pending must leave `connect()` unable to open a socket at all. One-shot: this transport instance is never reused after `close()` (`telemetryProvider.ts` builds a fresh instance per session/retry). */
  private closed = false;

  constructor(private readonly config: TcpObdTransportConfig) {}

  async connect(): Promise<void> {
    const load = this.config.loadModule ?? loadTcpSocketModule;
    const module = await load();
    if (this.closed) {
      throw new Error('TcpObdTransport: close() was called before connect() finished loading the transport module');
    }
    const TcpSocket = module.default;
    const timeoutMs = this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const stale = this.socket;
        this.socket = null;
        stale?.destroy();
        reject(
          new Error(
            `TcpObdTransport: connect to ${this.config.host}:${this.config.port} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const socket = TcpSocket.createConnection({ host: this.config.host, port: this.config.port }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      this.socket = socket;

      socket.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('ascii');
        for (const listener of [...this.dataListeners]) listener(text);
      });

      socket.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        this.notifyClose(err);
      });

      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('TcpObdTransport: socket closed before connecting'));
          return;
        }
        this.notifyClose();
      });
    });
  }

  send(line: string): void {
    if (this.socket === null) throw new Error('TcpObdTransport: send() called before connect() resolved');
    this.socket.write(line, 'ascii');
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onClose(cb: (err?: Error) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  async close(): Promise<void> {
    this.closed = true;
    const stale = this.socket;
    this.socket = null;
    stale?.destroy();
  }

  private notifyClose(err?: Error): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of [...this.closeListeners]) listener(err);
  }
}
