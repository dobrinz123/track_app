/**
 * ENET auto-discovery -- pure orchestrator (contracts.md "ENET auto-discovery
 * & DID sweep addendum", binding). Builds an ordered list of `{host, port}`
 * candidates from the phone's own network info, then probes them (via an
 * INJECTED transport factory + clock) up to a two-level confidence:
 *
 *   level 1: TCP connect resolved within `connectTimeoutMs`.
 *   level 2: after level 1, ONE whitelisted TesterPresent (built through
 *            `assertAllowedRequest`, same as the real session) is sent, and
 *            ANY frame that parses as a valid HSFZ frame (ack, diagnostic,
 *            alive-check, or a decodable error frame) arrives within
 *            `replyTimeoutMs` -- the addendum only requires a valid FRAME,
 *            not a frame that correlates to the request (TesterPresent
 *            suppresses its own positive response, so nothing would ever
 *            correlate to it anyway).
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
   * Only a plain /24 mask (`255.255.255.0`) triggers the phone-subnet
   * candidates (addendum: "/24 only") -- anything else (including an
   * unparseable mask) is treated as "no subnet sweep", NOT as some other
   * prefix length. Omitted entirely, a /24 is assumed (the common
   * phone-tethered-to-adapter-AP case the addendum describes).
   */
  subnetMask?: string;
}

export interface DiscoveryCandidate {
  host: string;
  port: number;
}

const SLASH_24_MASK = '255.255.255.0';

/**
 * Builds the ordered, deduped, capped candidate list per the addendum:
 * configured host, then the MHD default, then the phone subnet's `.1`, then
 * every other host of the phone's /24 (skipping the phone itself) -- each
 * host tried on its configured port (if any) then 6801, deduped by
 * `host:port`, capped at `MAX_DISCOVERY_CANDIDATES`.
 */
export function buildDiscoveryCandidates(input: BuildDiscoveryCandidatesInput): DiscoveryCandidate[] {
  const hosts: string[] = [];
  const seenHosts = new Set<string>();
  const pushHost = (host: string | undefined): void => {
    if (host === undefined) return;
    if (parseIpv4(host) === null) return;
    if (seenHosts.has(host)) return;
    seenHosts.add(host);
    hosts.push(host);
  };

  pushHost(input.configuredHost);
  pushHost(ENET_DISCOVERY_MHD_HOST);

  const phoneOctets = input.phoneIpv4 !== undefined ? parseIpv4(input.phoneIpv4) : null;
  const maskOk = input.subnetMask === undefined || input.subnetMask === SLASH_24_MASK;
  if (phoneOctets !== null && maskOk) {
    const [a, b, c] = phoneOctets;
    pushHost(`${a}.${b}.${c}.1`);
    for (let last = 1; last <= 254; last += 1) {
      const host = `${a}.${b}.${c}.${last}`;
      if (host === input.phoneIpv4) continue; // never probe the phone itself
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

function parseIpv4(ip: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (match === null) return null;
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number.parseInt(part ?? '', 10));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets as [number, number, number, number];
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
  /** default 16 (addendum: "Concurrency <= 16 sockets"). */
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
  /** Candidates actually probed (bounded by budget/abort; may be less than `candidates.length`). */
  scanned: number;
  elapsedMs: number;
  /** True when the budget or an abort stopped scanning before every candidate was probed. */
  truncated: boolean;
}

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_CONNECT_TIMEOUT_MS = 300;
const DEFAULT_REPLY_TIMEOUT_MS = 500;
const DEFAULT_BUDGET_MS = 8_000;

/** Runs discovery across `candidates`. Never throws on a per-candidate failure -- a refused/timed-out/erroring candidate simply contributes no result. */
export async function runDiscovery(input: RunDiscoveryInput): Promise<RunDiscoveryResult> {
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);
  const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const replyTimeoutMs = input.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const { clock, signal } = input;
  const startedAtMs = clock.now();
  const deadlineMs = startedAtMs + budgetMs;
  const total = input.candidates.length;

  const slots: Array<DiscoveryProbeResult | null> = new Array(total).fill(null);
  let scanned = 0;
  let nextIndex = 0;
  let stoppedEarly = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if ((signal?.aborted ?? false) || clock.now() >= deadlineMs) {
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
        signal,
      });
    }
  };

  const workerCount = Math.min(concurrency, Math.max(total, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const truncated = stoppedEarly || nextIndex < total;
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
  signal?: DiscoveryAbortSignal;
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
    await raceWithDeadline(transport.connect(), ctx.connectTimeoutMs, ctx.signal);
  } catch {
    await safeClose(transport);
    return null;
  }
  const level1RttMs = Math.max(0, ctx.clock.now() - connectStartedMs);

  let level2RttMs: number | null;
  try {
    level2RttMs = await probeLevel2(transport, ctx);
  } catch {
    level2RttMs = null;
  }
  await safeClose(transport);

  if (level2RttMs !== null) return { host: candidate.host, port: candidate.port, level: 2, rttMs: level2RttMs };
  return { host: candidate.host, port: candidate.port, level: 1, rttMs: level1RttMs };
}

/** Sends ONE whitelisted TesterPresent and resolves with the round-trip ms of the first valid HSFZ frame received, or `null` if none arrives within `replyTimeoutMs`. */
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

    unsubscribe = transport.onData((chunk) => {
      const bytes = binaryStringToBytes(chunk);
      try {
        const frames = parser.push(bytes);
        if (frames.length > 0) finish(Math.max(0, ctx.clock.now() - sentAtMs));
      } catch (error) {
        // A decodable error frame still counts as level-2 evidence (addendum:
        // "...or a decodable error frame"); frames completed before the
        // corruption still qualify. A genuinely undecodable chunk (the
        // HsfzParseError case with none) proves nothing either way.
        if (error instanceof HsfzParseError && error.framesBeforeError.length > 0) {
          finish(Math.max(0, ctx.clock.now() - sentAtMs));
        }
      }
    });

    timer = setTimeout(() => finish(null), ctx.replyTimeoutMs);
    if (ctx.signal !== undefined) {
      poll = setInterval(() => {
        if (ctx.signal?.aborted ?? false) finish(null);
      }, 10);
    }

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

/** Races an arbitrary promise (e.g. `transport.connect()`) against a timeout and an optional abort signal. Rejects on whichever comes first; never leaves a dangling timer/interval. */
function raceWithDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: DiscoveryAbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    const poll =
      signal === undefined
        ? null
        : setInterval(() => {
            if (signal.aborted) finishReject(new Error('aborted'));
          }, 10);

    function cleanup(): void {
      clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
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

async function safeClose(transport: ObdTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Best-effort: a probe connection's close failure must never surface as a discovery error.
  }
}
