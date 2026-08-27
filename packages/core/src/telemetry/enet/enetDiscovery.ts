/**
 * ENET auto-discovery -- pure orchestrator (contracts.md "ENET auto-discovery
 * & DID sweep addendum", binding; hard bounds per the "hard bounds & sweep
 * boundary amendment"). Builds an ordered list of `{host, port}` candidates
 * from the phone's own network info, then probes them (via an INJECTED
 * transport factory + clock) up to a two-level confidence:
 *
 *   level 1: TCP connect resolved within `connectTimeoutMs`.
 *   level 2: after level 1, ONE whitelisted TesterPresent (built through
 *            `assertAllowedRequest`, same as the real session) is sent, and
 *            an ACK / diagnostic / alive-check / decodable-error HSFZ frame
 *            (NOT any other structurally-valid frame -- an unrecognized/
 *            terminal15/vehicle-ident/status/OOM "other" frame stays level 1)
 *            arrives within `replyTimeoutMs`.
 *
 * Hard bounds (amendment, binding): concurrency is capped at 16 regardless of
 * what's configured; at budget expiry OR an abort, no new probe starts and
 * every probe still in flight is cancelled immediately -- its transport is
 * closed right away (raced against a 200 ms close-timeout so a hanging
 * `close()` can never block the run), and the abort/budget check happens
 * SYNCHRONOUSLY right before the TesterPresent is ever sent (never after).
 *
 * No I/O happens in this module itself -- `probe` is the caller's transport
 * factory (a real TCP socket wrapper at the mobile layer, or
 * `createSimulatedDiscoveryProbeFactory` in tests/preview).
 */

import type { ObdTransport } from '../contracts';
import type { MonotonicClock } from '../../contracts';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  HsfzParseError,
  type HsfzFrame,
} from './hsfzCodec';
import { assertAllowedRequest, buildTesterPresentRequest } from './udsCodec';

// ---------- Candidate building ----------

/** MHD web UI's fixed address (contracts.md addendum) -- always tried, regardless of the phone's own subnet. */
export const ENET_DISCOVERY_MHD_HOST = '192.168.4.1';
/** Fallback ENET port tried on every host (contracts.md addendum). */
export const ENET_DISCOVERY_DEFAULT_PORT = 6801;
/** Hard cap on the number of `{host, port}` candidates ever produced (contracts.md addendum: "cap 260"). */
export const MAX_DISCOVERY_CANDIDATES = 260;

export interface BuildDiscoveryCandidatesInput {
  configuredHost?: string;
  configuredPort?: number;
  phoneIpv4?: string;
  /**
   * Accepted for forward/backward API compatibility (a caller may still pass
   * whatever `expo-network` reports) but NO LONGER consulted: the hard-bounds
   * amendment removed the "/24 only" gate -- the phone's /24 is now always
   * enumerated whenever `phoneIpv4` itself parses, regardless of the reported
   * mask (a phone reporting a wrong/missing mask must not silently lose the
   * subnet sweep).
   */
  subnetMask?: string;
}

export interface DiscoveryCandidate {
  host: string;
  port: number;
}

/**
 * Builds the ordered, deduped, capped candidate list per the addendum:
 * configured host, then the MHD default, then the phone subnet's `.1`, then
 * every other host of the phone's /24 (skipping the phone itself) -- each
 * host tried on its configured port (if any) then 6801, deduped by
 * `host:port`, capped at `MAX_DISCOVERY_CANDIDATES`. Every host is
 * canonicalized (trimmed, no leading-zero-octet ambiguity) before dedupe/
 * comparison, so equivalent inputs never produce duplicate or self-probing
 * candidates.
 */
export function buildDiscoveryCandidates(input: BuildDiscoveryCandidatesInput): DiscoveryCandidate[] {
  const hosts: string[] = [];
  const seenHosts = new Set<string>();
  const pushHost = (host: string | undefined): void => {
    if (host === undefined) return;
    const canonical = parseIpv4(host);
    if (canonical === null) return;
    if (seenHosts.has(canonical)) return;
    seenHosts.add(canonical);
    hosts.push(canonical);
  };

  pushHost(input.configuredHost);
  pushHost(ENET_DISCOVERY_MHD_HOST);

  const phoneCanonical = input.phoneIpv4 !== undefined ? parseIpv4(input.phoneIpv4) : null;
  if (phoneCanonical !== null) {
    const [a, b, c] = phoneCanonical.split('.');
    pushHost(`${a}.${b}.${c}.1`);
    for (let last = 1; last <= 254; last += 1) {
      const host = `${a}.${b}.${c}.${last}`;
      if (host === phoneCanonical) continue; // never probe the phone itself (canonical-to-canonical compare)
      pushHost(host);
    }
  }

  const portsForHost = dedupePorts([input.configuredPort, ENET_DISCOVERY_DEFAULT_PORT]);
  const candidates: DiscoveryCandidate[] = [];
  const seenPairs = new Set<string>();
  outer: for (const host of hosts) {
    for (const port of portsForHost) {
      const key = `${host}:${port}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      candidates.push({ host, port });
      if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break outer;
    }
  }
  return candidates;
}

function dedupePorts(ports: ReadonlyArray<number | undefined>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const port of ports) {
    if (port === undefined) continue;
    if (!Number.isInteger(port) || port <= 0 || port > 0xffff) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    out.push(port);
  }
  return out;
}

/**
 * Parses `ip` into its CANONICAL dotted-decimal form (trimmed, each octet
 * re-rendered without leading zeros), or `null` if it isn't a well-formed
 * IPv4 literal. An octet written with a leading zero (`"010"`) is REJECTED
 * outright rather than silently reinterpreted -- different parsers disagree
 * on whether that means octal 8 or decimal 10, and the addendum's "no
 * leading zeros ambiguity" is satisfied by never accepting the ambiguous
 * form at all, not by picking one interpretation over the other.
 */
function parseIpv4(ip: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (match === null) return null;
  const parts = [match[1], match[2], match[3], match[4]];
  const octets: number[] = [];
  for (const part of parts) {
    if (part === undefined) return null;
    if (part.length > 1 && part.startsWith('0')) return null; // ambiguous leading zero -- reject
    const value = Number.parseInt(part, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets.join('.');
}

// ---------- Probing ----------

/** AbortSignal-like: only the field this module reads. No dependency on the DOM/Node `AbortSignal` global (packages/core stays pure TS). */
export interface DiscoveryAbortSignal {
  readonly aborted: boolean;
}

export interface RunDiscoveryInput {
  candidates: readonly DiscoveryCandidate[];
  /** Injected transport factory -- one fresh `ObdTransport` per candidate. Never called more than once per candidate. */
  probe: (host: string, port: number) => ObdTransport;
  clock: MonotonicClock;
  /** Hard-capped at 16 regardless of what's passed (addendum: "concurrency = min(configured, 16) enforced"). default 16. */
  concurrency?: number;
  /** default 300 (addendum). */
  connectTimeoutMs?: number;
  /** default 500 (addendum). */
  replyTimeoutMs?: number;
  /** default 8000 (addendum: "total budget <= 8 s"). */
  budgetMs?: number;
  testerAddress: number;
  targetAddress: number;
  signal?: DiscoveryAbortSignal;
}

export interface DiscoveryProbeResult {
  host: string;
  port: number;
  level: 1 | 2;
  rttMs: number;
}

export interface RunDiscoveryResult {
  /** Deterministic order: level desc, then candidate order -- NEVER completion order. */
  results: DiscoveryProbeResult[];
  /** Candidates actually started (bounded by budget/abort; may be less than `candidates.length`). A started-but-cancelled candidate is counted here even though it contributes no result. */
  scanned: number;
  elapsedMs: number;
  /** True when the budget or an abort stopped scanning before every candidate was probed. */
  truncated: boolean;
}

const HARD_MAX_CONCURRENCY = 16;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_CONNECT_TIMEOUT_MS = 300;
const DEFAULT_REPLY_TIMEOUT_MS = 500;
const DEFAULT_BUDGET_MS = 8_000;
/** Hard ceiling on how long any single `transport.close()` may take before discovery gives up on it and moves on (amendment: "close raced against a 200 ms timeout so a hanging close cannot block"). NOT configurable -- this is a safety net, not a tuning knob. */
const CLOSE_TIMEOUT_MS = 200;

/** Runs discovery across `candidates`. Never throws on a per-candidate failure -- a refused/timed-out/erroring candidate simply contributes no result. */
export async function runDiscovery(input: RunDiscoveryInput): Promise<RunDiscoveryResult> {
  const concurrency = Math.min(HARD_MAX_CONCURRENCY, Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY));
  const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const replyTimeoutMs = input.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const { clock, signal } = input;
  const startedAtMs = clock.now();
  const deadlineMs = startedAtMs + budgetMs;
  const total = input.candidates.length;

  // A single cancellation predicate that folds BOTH the external abort signal
  // and the budget deadline into one check -- every internal wait (connect,
  // level-2 reply) polls this SAME predicate, so budget expiry cancels an
  // in-flight probe exactly like an external abort does, not merely blocking
  // new ones from starting.
  const isCancelled = (): boolean => (signal?.aborted ?? false) || clock.now() >= deadlineMs;

  const slots: Array<DiscoveryProbeResult | null> = new Array(total).fill(null);
  let scanned = 0;
  let nextIndex = 0;
  let stoppedEarly = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled()) {
        stoppedEarly = stoppedEarly || nextIndex < total;
        return;
      }
      const index = nextIndex;
      if (index >= total) return;
      nextIndex += 1;
      scanned += 1;
      const candidate = input.candidates[index];
      if (candidate === undefined) continue;
      slots[index] = await probeCandidate(candidate, {
        probe: input.probe,
        clock,
        connectTimeoutMs,
        replyTimeoutMs,
        testerAddress: input.testerAddress,
        targetAddress: input.targetAddress,
        isCancelled,
      });
    }
  };

  const workerCount = Math.min(concurrency, Math.max(total, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // A probe that itself completed its `nextIndex` slot can still have been
  // cancelled MID-FLIGHT (its own connect pushed the clock past the deadline,
  // or an abort landed while it was waiting) and therefore contributed no
  // result -- `isCancelled()` checked here, after every worker has finished,
  // catches that case too (a monotonic clock/an abort signal that isn't
  // un-set stays true), not just "were later candidates blocked from ever
  // starting".
  const truncated = stoppedEarly || nextIndex < total || isCancelled();
  const results = slots
    .map((result, index) => ({ result, index }))
    .filter((entry): entry is { result: DiscoveryProbeResult; index: number } => entry.result !== null)
    .sort((a, b) => b.result.level - a.result.level || a.index - b.index)
    .map((entry) => entry.result);

  return {
    results,
    scanned,
    elapsedMs: Math.max(0, clock.now() - startedAtMs),
    truncated,
  };
}

interface ProbeContext {
  probe: (host: string, port: number) => ObdTransport;
  clock: MonotonicClock;
  connectTimeoutMs: number;
  replyTimeoutMs: number;
  testerAddress: number;
  targetAddress: number;
  isCancelled: () => boolean;
}

async function probeCandidate(candidate: DiscoveryCandidate, ctx: ProbeContext): Promise<DiscoveryProbeResult | null> {
  let transport: ObdTransport;
  try {
    transport = ctx.probe(candidate.host, candidate.port);
  } catch {
    return null;
  }

  const connectStartedMs = ctx.clock.now();
  try {
    await raceWithCancellation(transport.connect(), ctx.connectTimeoutMs, ctx.isCancelled);
  } catch {
    await closeWithTimeout(transport);
    return null;
  }
  // Cancelled right as connect finished, before ever attempting level-2 --
  // the transport is closed immediately and this candidate contributes
  // nothing (amendment: "the run returns truncated: true with only
  // completed results").
  if (ctx.isCancelled()) {
    await closeWithTimeout(transport);
    return null;
  }
  const level1RttMs = Math.max(0, ctx.clock.now() - connectStartedMs);

  let level2RttMs: number | null;
  try {
    level2RttMs = await probeLevel2(transport, ctx);
  } catch {
    level2RttMs = null;
  }
  await closeWithTimeout(transport);

  // Cancelled during (or right after) the level-2 wait -- discard entirely
  // rather than reporting a stale "level 1" for a probe that never actually
  // ran to its natural conclusion.
  if (ctx.isCancelled()) return null;

  if (level2RttMs !== null) return { host: candidate.host, port: candidate.port, level: 2, rttMs: level2RttMs };
  return { host: candidate.host, port: candidate.port, level: 1, rttMs: level1RttMs };
}

/** Only these HSFZ frame kinds count as level-2 evidence (amendment: "'other' controls stay level 1") -- an unrecognized/terminal15/vehicle-ident/status/OOM frame proves the host speaks SOME protocol on that port, but not decodably enough to trust as an ENET adapter reply. */
function isQualifyingLevel2Frame(frame: HsfzFrame): boolean {
  return frame.kind !== 'other';
}

function anyQualifyingFrame(frames: readonly HsfzFrame[]): boolean {
  return frames.some(isQualifyingLevel2Frame);
}

/** Sends ONE whitelisted TesterPresent and resolves with the round-trip ms of the first qualifying HSFZ frame (ACK/diagnostic/alive-check/decodable-error) received, or `null` if none arrives within `replyTimeoutMs` -- also `null` immediately, without sending anything, if `ctx.isCancelled()` is already true (checked SYNCHRONOUSLY right before the send). */
function probeLevel2(transport: ObdTransport, ctx: ProbeContext): Promise<number | null> {
  return new Promise((resolve) => {
    const parser = new HsfzFrameParser();
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const sentAtMs = ctx.clock.now();

    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      unsubscribe?.();
      resolve(value);
    };

    // Checked BEFORE subscribing/sending anything: an already-cancelled probe
    // must never transmit even one more frame (amendment: "abort is checked
    // synchronously before any send").
    if (ctx.isCancelled()) {
      finish(null);
      return;
    }

    unsubscribe = transport.onData((chunk) => {
      const bytes = binaryStringToBytes(chunk);
      try {
        const frames = parser.push(bytes);
        if (anyQualifyingFrame(frames)) finish(Math.max(0, ctx.clock.now() - sentAtMs));
      } catch (error) {
        // A decodable error frame still counts as level-2 evidence; frames
        // completed before the corruption still qualify individually. A
        // genuinely undecodable chunk (no frames before the error) proves
        // nothing either way.
        if (error instanceof HsfzParseError && anyQualifyingFrame(error.framesBeforeError)) {
          finish(Math.max(0, ctx.clock.now() - sentAtMs));
        }
      }
    });

    timer = setTimeout(() => finish(null), ctx.replyTimeoutMs);
    poll = setInterval(() => {
      if (ctx.isCancelled()) finish(null);
    }, 10);

    try {
      const pdu = buildTesterPresentRequest();
      assertAllowedRequest(pdu);
      const frame = encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: ctx.testerAddress,
        target: ctx.targetAddress,
        payload: pdu,
      });
      transport.send(bytesToBinaryString(frame));
    } catch {
      finish(null);
    }
  });
}

/** Races an arbitrary promise (e.g. `transport.connect()`) against a timeout and a cancellation predicate (polled every 10ms). Rejects on whichever comes first; never leaves a dangling timer/interval. */
function raceWithCancellation<T>(promise: Promise<T>, timeoutMs: number, isCancelled: () => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    const poll = setInterval(() => {
      if (isCancelled()) finishReject(new Error('cancelled'));
    }, 10);

    function cleanup(): void {
      clearTimeout(timer);
      clearInterval(poll);
    }
    function finishReject(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function finishResolve(value: T): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    promise.then(finishResolve, (error: unknown) => finishReject(error instanceof Error ? error : new Error(String(error))));
  });
}

/** Closes `transport`, but never waits more than `CLOSE_TIMEOUT_MS` for it -- a `close()` that never resolves must never hang `runDiscovery` (amendment). Never throws. */
async function closeWithTimeout(transport: ObdTransport): Promise<void> {
  try {
    await Promise.race([
      transport.close(),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
  } catch {
    // Best-effort: a probe connection's close failure must never surface as a discovery error.
  }
}
