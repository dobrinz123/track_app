import type { ObdTransport } from '@circuit/core';
import { binaryStringToBytes, bytesToBinaryString } from '@circuit/core';
// Type-only -- erased at compile time, mirrors `tcpObdTransport.ts`'s own
// comment: this never actually loads `react-native-tcp-socket`'s
// native-module entry point outside the lazy dynamic `import()` inside
// `connect()` below.
import type TcpSocketApi from 'react-native-tcp-socket';

type TcpSocketNamespace = typeof TcpSocketApi;
type TcpSocketInstance = ReturnType<TcpSocketNamespace['createConnection']>;

/** Same lazy-load reasoning as `tcpObdTransport.ts`'s `loadTcpSocketModule` -- keeps this module's own static imports (and every test importing `telemetryProvider.ts`/this module without mocking it) safe under vitest's pure-Node transform. */
async function loadTcpSocketModule(): Promise<typeof import('react-native-tcp-socket')> {
  return import('react-native-tcp-socket');
}

export interface EnetTcpTransportConfig {
  host: string;
  port: number;
  /** `connect()` timeout in ms -- rejects and destroys the socket if exceeded. Default 5000, same as `tcpObdTransport.ts`. */
  connectTimeoutMs?: number;
  /** Test-only seam (mirrors `tcpObdTransport.ts`'s own `loadModule`): overrides the lazy `react-native-tcp-socket` import so a test can control exactly when it resolves. Production callers never pass this. */
  loadModule?: () => Promise<typeof import('react-native-tcp-socket')>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * `ObdTransport` (contracts.md's ENET addendum) implementation over
 * `react-native-tcp-socket` for the BMW ENET adapter -- the mobile-side
 * transport an `EnetSession` (`@circuit/core`) drives against the adapter's
 * TCP port 6801 on the local network. STRICTLY a byte pipe, same division of
 * responsibility as `tcpObdTransport.ts`: HSFZ framing/UDS PDU parsing all
 * live in `@circuit/core`'s `telemetry/enet/**`, never here.
 *
 * Byte-safety (the one real difference from `tcpObdTransport.ts`, whose
 * ELM327 wire protocol is 7-bit-clean ASCII): HSFZ is a raw binary protocol
 * with byte values across the full 0-255 range, so this transport never asks
 * the socket to encode/decode a string at all --
 * `react-native-tcp-socket`'s `write()` accepts a `Uint8Array` directly (no
 * `'ascii'`/`'binary'` encoding choice that could silently mask high bits),
 * and incoming `data` is read as `Buffer` (no `setEncoding()` call) and
 * turned into the `ObdTransport` binary-string convention via
 * `@circuit/core`'s own `bytesToBinaryString`/`binaryStringToBytes` helpers
 * (the addendum's own recommendation: "prefer Uint8Array end to end").
 *
 * Same lazy-load, closed-flag, connect-timeout and single-close-notification
 * discipline as `tcpObdTransport.ts` -- deliberately NOT refactored to share
 * a base class with it (that file is unchanged by this ticket; duplicating
 * the small amount of socket-lifecycle glue here is safer than touching a
 * transport whose ELM327 behavior must stay byte-identical).
 */
export class EnetTcpTransport implements ObdTransport {
  private socket: TcpSocketInstance | null = null;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(err?: Error) => void>();
  /** Guards against `onClose` firing twice for one lifecycle (e.g. an 'error' event immediately followed by 'close'). */
  private closeEmitted = false;
  /** Set by `close()`, re-checked by `connect()` AFTER the lazy module import resolves and BEFORE a socket is created (mirrors `tcpObdTransport.ts`'s F9 fix) -- one-shot: this transport instance is never reused after `close()`. */
  private closed = false;

  constructor(private readonly config: EnetTcpTransportConfig) {}

  async connect(): Promise<void> {
    const load = this.config.loadModule ?? loadTcpSocketModule;
    const module = await load();
    if (this.closed) {
      // P4e-FIX2 (binding): ALSO the "second connect() on a one-shot
      // instance" guard -- `notifyClose` (below) sets `closed` on a REMOTE
      // close/error too, not just a local `close()` call, so this same check
      // now also rejects a second `connect()` attempt after the adapter (or
      // an earlier `close()`) has ended this transport's one lifecycle.
      throw new Error(
        'EnetTcpTransport: closed (locally or by the remote) -- connect() cannot be reused, construct a fresh transport instance',
      );
    }
    const TcpSocket = module.default;
    const timeoutMs = this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.terminalizeConnectionPhaseFailure();
        reject(
          new Error(
            `EnetTcpTransport: connect to ${this.config.host}:${this.config.port} timed out after ${timeoutMs}ms`,
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
        // No `setEncoding()` was called -- a non-string chunk is a `Buffer`,
        // itself a `Uint8Array`, so this never round-trips through any
        // string encoding that could mask a byte >= 0x80. The `string`
        // branch is defensive only (the underlying native module's own
        // typings allow it); if it were ever hit, treating it as already
        // one-char-per-byte (this transport's own binary-string convention)
        // is the least lossy interpretation available.
        const bytes = typeof chunk === 'string' ? binaryStringToBytes(chunk) : chunk;
        const text = bytesToBinaryString(bytes);
        for (const listener of [...this.dataListeners]) listener(text);
      });

      socket.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.terminalizeConnectionPhaseFailure();
          reject(err);
          return;
        }
        this.notifyClose(err);
      });

      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.terminalizeConnectionPhaseFailure();
          reject(new Error('EnetTcpTransport: socket closed before connecting'));
          return;
        }
        this.notifyClose();
      });
    });
  }

  send(line: string): void {
    if (this.socket === null) throw new Error('EnetTcpTransport: send() called before connect() resolved');
    // `line` is already the `ObdTransport` binary-string encoding of a raw
    // HSFZ frame (`@circuit/core`'s `bytesToBinaryString`) -- decoded back to
    // bytes and written directly as a `Uint8Array`, never as an encoded
    // string, so every byte value 0-255 survives intact.
    this.socket.write(binaryStringToBytes(line));
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

  /**
   * P4e-FIX2 fix (binding, review finding): a REMOTE close/error AFTER a
   * successful `connect()` must leave this transport in the SAME one-shot
   * terminal state a local `close()` does -- `closed = true` and `socket =
   * null` UNCONDITIONALLY (even on a repeat call, e.g. 'error' immediately
   * followed by 'close'), so a `send()` after a remote close throws
   * (`this.socket === null`) instead of writing to a dead socket, and a
   * second `connect()` rejects via the `closed` check above -- instead of
   * ONLY the single close-notification itself being deduplicated while the
   * transport's own state silently kept claiming to be open.
   */
  private notifyClose(err?: Error): void {
    this.closed = true;
    this.socket = null;
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of [...this.closeListeners]) listener(err);
  }

  /**
   * P4e-FIX3 M2 fix (binding, Codex P4e-REV3 residual): a `close/error`/the
   * connect timeout arriving BEFORE `connect()`'s own callback ("connection
   * phase") used to reject the `connect()` promise WITHOUT terminalizing the
   * instance at all -- `closed` stayed `false` and `socket` stayed
   * non-`null`, so `send()` would write to the failed socket and a second
   * `connect()` would be allowed to create ANOTHER one on the same
   * supposedly one-shot instance. This is the SAME terminal state
   * `notifyClose` reaches after a successful connect (`closed = true`,
   * socket destroyed and `null`), reached from all three connection-phase
   * failure paths (timeout, pre-connect `error`, pre-connect `close`).
   *
   * Close-notification rule for THIS phase (deliberately chosen, documented
   * here per the ticket's "pick one, document it, test it"): a socket that
   * never successfully connected NEVER fires `onClose` -- a caller only
   * ever learns of a connection-phase failure through the REJECTED
   * `connect()` promise itself, never through `onClose` (which models "an
   * established connection went away", not "never established at all").
   * `closeEmitted` is set here too so a stray native double-fire (e.g. an
   * 'error' immediately followed by 'close', both pre-connect) can never
   * leak a delayed `onClose` call afterward either.
   */
  private terminalizeConnectionPhaseFailure(): void {
    this.closed = true;
    this.closeEmitted = true;
    const stale = this.socket;
    this.socket = null;
    stale?.destroy();
  }
}
