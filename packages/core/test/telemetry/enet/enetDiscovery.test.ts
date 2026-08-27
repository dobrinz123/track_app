import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObdTransport } from '../../../src/telemetry/contracts';
import {
  buildDiscoveryCandidates,
  ENET_DISCOVERY_DEFAULT_PORT,
  ENET_DISCOVERY_MHD_HOST,
  MAX_DISCOVERY_CANDIDATES,
  runDiscovery,
  type DiscoveryCandidate,
} from '../../../src/telemetry/enet/enetDiscovery';
import { encodeOtherFrame, HSFZ_CONTROL, bytesToBinaryString } from '../../../src/telemetry/enet/hsfzCodec';
import { createSimulatedDiscoveryProbeFactory } from '../../../src/telemetry/enet/simulatedEnetTransport';
import { FakeClock } from '../../controller/testSupport';

afterEach(() => {
  vi.useRealTimers();
});

describe('buildDiscoveryCandidates', () => {
  it('orders configured host, MHD default, phone .1, then the rest of the /24, each on [configuredPort, 6801]', () => {
    const candidates = buildDiscoveryCandidates({
      configuredHost: '10.0.0.5',
      configuredPort: 1000,
      phoneIpv4: '10.0.0.23',
      subnetMask: '255.255.255.0',
    });

    expect(candidates.slice(0, 8)).toEqual([
      { host: '10.0.0.5', port: 1000 },
      { host: '10.0.0.5', port: ENET_DISCOVERY_DEFAULT_PORT },
      { host: ENET_DISCOVERY_MHD_HOST, port: 1000 },
      { host: ENET_DISCOVERY_MHD_HOST, port: ENET_DISCOVERY_DEFAULT_PORT },
      { host: '10.0.0.1', port: 1000 },
      { host: '10.0.0.1', port: ENET_DISCOVERY_DEFAULT_PORT },
      { host: '10.0.0.2', port: 1000 },
      { host: '10.0.0.2', port: ENET_DISCOVERY_DEFAULT_PORT },
    ]);
    // the phone itself is never a candidate
    expect(candidates.some((c) => c.host === '10.0.0.23')).toBe(false);
  });

  it('dedupes host:port pairs when the configured host/port coincide with the MHD default', () => {
    const candidates = buildDiscoveryCandidates({
      configuredHost: ENET_DISCOVERY_MHD_HOST,
      configuredPort: ENET_DISCOVERY_DEFAULT_PORT,
    });
    expect(candidates).toEqual([{ host: ENET_DISCOVERY_MHD_HOST, port: ENET_DISCOVERY_DEFAULT_PORT }]);
  });

  it('caps the total candidate count at 260 even for a full /24 sweep on 2 ports', () => {
    const candidates = buildDiscoveryCandidates({
      phoneIpv4: '192.168.50.7',
      subnetMask: '255.255.255.0',
      configuredPort: 1234,
    });
    expect(candidates.length).toBe(MAX_DISCOVERY_CANDIDATES);
    const keys = new Set(candidates.map((c) => `${c.host}:${c.port}`));
    expect(keys.size).toBe(MAX_DISCOVERY_CANDIDATES); // no duplicates within the cap
  });

  it('ALWAYS enumerates the phone /24 regardless of the reported mask (amendment: removed the invented "/24 only" gate)', () => {
    const candidates = buildDiscoveryCandidates({
      phoneIpv4: '10.1.2.3',
      subnetMask: '255.255.0.0', // NOT a /24 -- must no longer suppress the subnet sweep
    });
    expect(candidates.some((c) => c.host === '10.1.2.1')).toBe(true);
    expect(candidates.some((c) => c.host === '10.1.2.2')).toBe(true);
    expect(candidates.some((c) => c.host === '10.1.2.254')).toBe(true);
    expect(candidates.some((c) => c.host === '10.1.2.3')).toBe(false); // still never the phone itself
  });

  it('enumerates the phone /24 even with no subnetMask reported at all', () => {
    const candidates = buildDiscoveryCandidates({ phoneIpv4: '172.16.9.40' });
    expect(candidates.some((c) => c.host === '172.16.9.1')).toBe(true);
    expect(candidates.some((c) => c.host === '172.16.9.2')).toBe(true);
    expect(candidates.some((c) => c.host === '172.16.9.40')).toBe(false);
  });

  it('ignores a malformed phoneIpv4 without throwing', () => {
    const candidates = buildDiscoveryCandidates({ phoneIpv4: 'not-an-ip' });
    expect(candidates).toEqual([{ host: ENET_DISCOVERY_MHD_HOST, port: ENET_DISCOVERY_DEFAULT_PORT }]);
  });

  it('canonicalizes whitespace so a padded configured host dedupes against the MHD default', () => {
    const candidates = buildDiscoveryCandidates({ configuredHost: ' 192.168.4.1 ', configuredPort: ENET_DISCOVERY_DEFAULT_PORT });
    expect(candidates).toEqual([{ host: ENET_DISCOVERY_MHD_HOST, port: ENET_DISCOVERY_DEFAULT_PORT }]);
  });

  it('rejects a leading-zero octet as ambiguous, so it is never enumerated and never mistaken for the phone itself', () => {
    const candidates = buildDiscoveryCandidates({ phoneIpv4: '10.0.0.010' });
    // '10.0.0.010' does not parse -- no subnet sweep at all, and '10.0.0.10'
    // (the decimal reading some parsers would apply) must NOT slip through
    // as a leftover host either.
    expect(candidates.some((c) => c.host === '10.0.0.10')).toBe(false);
    expect(candidates).toEqual([{ host: ENET_DISCOVERY_MHD_HOST, port: ENET_DISCOVERY_DEFAULT_PORT }]);
  });

  it('rejects octets outside 0-255', () => {
    const candidates = buildDiscoveryCandidates({ configuredHost: '999.1.1.1', phoneIpv4: '1.2.3.256' });
    expect(candidates).toEqual([{ host: ENET_DISCOVERY_MHD_HOST, port: ENET_DISCOVERY_DEFAULT_PORT }]);
  });
});

function stubTransport(overrides: Partial<ObdTransport> = {}): ObdTransport {
  return {
    connect: async () => {},
    send: () => {},
    onData: () => () => {},
    onClose: () => () => {},
    close: async () => {},
    ...overrides,
  };
}

describe('runDiscovery', () => {
  it('answers level-2 on exactly one host, level-1 on another, refuses the rest -- deterministic ordering (level desc, then candidate order)', async () => {
    const candidates: DiscoveryCandidate[] = [
      { host: '10.0.0.1', port: 6801 },
      { host: '10.0.0.2', port: 6801 },
      { host: '10.0.0.3', port: 6801 },
      { host: '10.0.0.4', port: 6801 },
    ];
    const probe = createSimulatedDiscoveryProbeFactory({
      script: [
        { host: '10.0.0.2', behavior: 'level2' },
        { host: '10.0.0.4', behavior: 'level1' },
      ],
      defaultBehavior: 'refuse',
      connectDelayMs: 1,
      replyDelayMs: 1,
    });

    const result = await runDiscovery({
      candidates,
      probe,
      clock: new FakeClock(),
      connectTimeoutMs: 50,
      replyTimeoutMs: 20,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    expect(result.scanned).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.results).toEqual([
      expect.objectContaining({ host: '10.0.0.2', port: 6801, level: 2 }),
      expect.objectContaining({ host: '10.0.0.4', port: 6801, level: 1 }),
    ]);
    // the higher-level result must sort first even though it was NOT scanned first
    expect(result.results[0]?.host).toBe('10.0.0.2');
  });

  it('never throws on a per-candidate probe factory error', async () => {
    const candidates: DiscoveryCandidate[] = [{ host: '10.0.0.9', port: 6801 }];
    const probe = (): ObdTransport => {
      throw new Error('factory blew up');
    };
    const result = await runDiscovery({
      candidates,
      probe,
      clock: new FakeClock(),
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });
    expect(result.results).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  it('HARD-caps concurrency at 16 even when a higher value is configured', async () => {
    let active = 0;
    let peak = 0;
    const candidates: DiscoveryCandidate[] = Array.from({ length: 20 }, (_, i) => ({ host: `10.0.1.${i}`, port: 6801 }));
    const probe = (): ObdTransport =>
      stubTransport({
        connect: () =>
          new Promise((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            setTimeout(() => {
              active -= 1;
              resolve();
            }, 15);
          }),
      });

    await runDiscovery({
      candidates,
      probe,
      clock: new FakeClock(),
      concurrency: 20, // configured ABOVE the hard cap
      connectTimeoutMs: 100,
      replyTimeoutMs: 5,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(0);
  });

  it('[P4f-FIX2] sanitizes a non-finite concurrency (NaN) to 16 workers, not zero', async () => {
    let active = 0;
    let peak = 0;
    const candidates: DiscoveryCandidate[] = Array.from({ length: 20 }, (_, i) => ({ host: `10.0.9.${i}`, port: 6801 }));
    const probe = (): ObdTransport =>
      stubTransport({
        connect: () =>
          new Promise((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            setTimeout(() => {
              active -= 1;
              resolve();
            }, 15);
          }),
      });

    const result = await runDiscovery({
      candidates,
      probe,
      clock: new FakeClock(),
      concurrency: Number.NaN,
      connectTimeoutMs: 100,
      replyTimeoutMs: 5,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    // Before the fix: `Math.max(1, NaN)` is itself `NaN`, so `Array.from({length: NaN}, ...)` produced ZERO
    // workers and every candidate was silently left unscanned.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(16);
    expect(result.scanned).toBe(20);
  });

  it('[P4f-FIX2] hard-caps budgetMs at 8000ms even when a higher value is configured, with a PENDING connect', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    // The connect() never resolves. A one-shot scheduled bump pushes the
    // injected clock to 9000ms -- past the hard 8000ms ceiling but well
    // within the (bogus, configured) 60000ms budget. If the cap were NOT
    // enforced (deadline computed as 60000), the run would still be waiting
    // (connectTimeoutMs is also 60000). With the cap enforced (deadline =
    // min(60000, 8000) = 8000), the cancellation poll notices 9000 >= 8000
    // and the run returns, truncated, well before either configured 60s value.
    setTimeout(() => clock.advance(9_000), 20);
    const probe = (): ObdTransport => stubTransport({ connect: () => new Promise(() => {}) });

    const resultPromise = runDiscovery({
      candidates: [{ host: '10.0.0.1', port: 6801 }],
      probe,
      clock,
      concurrency: 1,
      connectTimeoutMs: 60_000,
      replyTimeoutMs: 60_000,
      budgetMs: 60_000, // configured WAY above the hard 8s ceiling
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    await vi.advanceTimersByTimeAsync(200); // nowhere near 60s -- proves the run did not wait for the 60s budget/timeout
    const result = await resultPromise;

    expect(result.truncated).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('[P4f-FIX3] budgetMs <= 0 means NO probes at all -- empty result, truncated FALSE (not expanded to the 8000ms default)', async () => {
    let probeCalls = 0;
    const probe = (): ObdTransport => {
      probeCalls += 1;
      return stubTransport();
    };
    const candidates: DiscoveryCandidate[] = [
      { host: '10.0.0.1', port: 6801 },
      { host: '10.0.0.2', port: 6801 },
    ];

    for (const budgetMs of [0, -1, -1_000]) {
      const result = await runDiscovery({
        candidates,
        probe,
        clock: new FakeClock(),
        testerAddress: 0xf4,
        targetAddress: 0x12,
        budgetMs,
      });
      expect(result).toEqual({ results: [], scanned: 0, elapsedMs: 0, truncated: false });
    }
    expect(probeCalls).toBe(0); // not one candidate was ever probed
  });

  it('an OMITTED/non-finite budgetMs still falls back to the 8000ms default (only an EXPLICIT <= 0 means "no probes")', async () => {
    const result = await runDiscovery({
      candidates: [{ host: '10.0.0.1', port: 6801 }],
      probe: () => stubTransport(),
      clock: new FakeClock(),
      testerAddress: 0xf4,
      targetAddress: 0x12,
      budgetMs: Number.NaN,
    });
    expect(result.scanned).toBe(1); // NaN is "not configured", not "explicitly zero"
  });

  it('a probe still "in flight" when the budget expires is cancelled and contributes NO result -- "truncated: true with only completed results"', async () => {
    const clock = new FakeClock();
    const candidates: DiscoveryCandidate[] = Array.from({ length: 5 }, (_, i) => ({ host: `10.0.2.${i}`, port: 6801 }));
    // Each "connect" costs 100ms of the injected clock's budget (deterministic
    // regardless of real wall-clock time) -- with a 250ms budget, candidate 2's
    // OWN connect() is what pushes the clock past the deadline, so candidate 2
    // must be discarded entirely (not reported as level 1) even though its
    // connect() itself resolved successfully.
    const probe = (): ObdTransport =>
      stubTransport({
        connect: async () => {
          clock.advance(100);
        },
      });

    const result = await runDiscovery({
      candidates,
      probe,
      clock,
      concurrency: 1,
      connectTimeoutMs: 50,
      replyTimeoutMs: 5,
      budgetMs: 250,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    expect(result.scanned).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.results).toHaveLength(2); // candidates 0 and 1 only -- candidate 2 was cancelled
    expect(result.results.every((r) => r.level === 1)).toBe(true);
  });

  it('budget expiry cancels an ACTIVE probe mid-wait and closes its transport promptly (raced against 200ms) -- does not wait out replyTimeoutMs', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    let closeCalled = false;
    let connectResolved = false;
    const probe = (): ObdTransport =>
      stubTransport({
        connect: async () => {
          connectResolved = true;
        },
        close: async () => {
          closeCalled = true;
        },
      });

    // Simulate 1000ms of real elapsed time pushing the injected clock past
    // its 50ms budget WHILE the probe is sitting in its level-2 wait --
    // exactly the scenario the review reproduced ("budgetMs: 20, a 5ms
    // connect and no reply... returned after 277ms").
    setTimeout(() => clock.advance(1_000), 20);

    const resultPromise = runDiscovery({
      candidates: [{ host: '10.0.0.1', port: 6801 }],
      probe,
      clock,
      connectTimeoutMs: 1_000,
      replyTimeoutMs: 5_000, // would hang the OLD implementation for 5s
      budgetMs: 50,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    await vi.advanceTimersByTimeAsync(200); // far less than replyTimeoutMs
    const result = await resultPromise;

    expect(connectResolved).toBe(true);
    expect(closeCalled).toBe(true); // the still-open transport was force-closed, not left dangling
    expect(result.truncated).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('a hanging close() cannot hang the run -- raced against a 200ms timeout', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const probe = (): ObdTransport =>
      stubTransport({
        close: () => new Promise(() => {}), // never resolves
      });

    const resultPromise = runDiscovery({
      candidates: [{ host: '10.0.0.1', port: 6801 }],
      probe,
      clock,
      connectTimeoutMs: 20,
      replyTimeoutMs: 20,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    await vi.advanceTimersByTimeAsync(1_000); // well past connect+reply+the 200ms close race
    const result = await resultPromise;
    expect(result.scanned).toBe(1); // the run completed at all -- it did not hang
  });

  it('a probe whose connect() never resolves cannot hang the run (bounded by connectTimeoutMs)', async () => {
    vi.useFakeTimers();
    const probe = (): ObdTransport => stubTransport({ connect: () => new Promise(() => {}) });

    const resultPromise = runDiscovery({
      candidates: [{ host: '10.0.0.1', port: 6801 }],
      probe,
      clock: new FakeClock(),
      connectTimeoutMs: 30,
      replyTimeoutMs: 5,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;
    expect(result.results).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  it('level 2 counts only ACK/diagnostic/alive-check/decodable-error frames -- an "other" control word (e.g. terminal15/unrecognized) stays level 1', async () => {
    const otherFrameBytes = encodeOtherFrame({ control: HSFZ_CONTROL.TERMINAL_15, payload: Uint8Array.from([1, 2, 3]) });
    const probe = (): ObdTransport => {
      let dataListener: ((chunk: string) => void) | null = null;
      return stubTransport({
        onData: (cb) => {
          dataListener = cb;
          return () => {
            dataListener = null;
          };
        },
        send: () => {
          // Reply with an 'other'-kind frame -- structurally valid HSFZ, but
          // NOT one of the qualifying kinds.
          dataListener?.(bytesToBinaryString(otherFrameBytes));
        },
      });
    };

    const result = await runDiscovery({
      candidates: [{ host: '10.0.0.1', port: 6801 }],
      probe,
      clock: new FakeClock(),
      connectTimeoutMs: 50,
      replyTimeoutMs: 30,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    expect(result.results).toEqual([expect.objectContaining({ host: '10.0.0.1', level: 1 })]);
  });

  it('abort is checked SYNCHRONOUSLY before the TesterPresent send -- a probe aborted right as connect() resolves never transmits', async () => {
    let sendCalled = false;
    const signal = { aborted: false };
    // `connect()` resolving is exactly the moment the review reproduced: "When
    // connect() set signal.aborted=true and resolved, one TesterPresent was
    // still sent before the 10ms abort poll noticed."
    const probe = (): ObdTransport =>
      stubTransport({
        connect: async () => {
          signal.aborted = true;
        },
        send: () => {
          sendCalled = true;
        },
      });

    const result = await runDiscovery({
      candidates: [{ host: '10.0.0.1', port: 6801 }],
      probe,
      clock: new FakeClock(),
      connectTimeoutMs: 50,
      replyTimeoutMs: 30,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
      signal,
    });

    expect(sendCalled).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('stops scheduling new probes once the abort signal is set, without throwing', async () => {
    const signal = { aborted: false };
    const candidates: DiscoveryCandidate[] = Array.from({ length: 5 }, (_, i) => ({ host: `10.0.3.${i}`, port: 6801 }));
    let calls = 0;
    const probe = (): ObdTransport =>
      stubTransport({
        connect: async () => {
          calls += 1;
          if (calls === 1) signal.aborted = true; // abort right after the first candidate starts
        },
      });

    const result = await runDiscovery({
      candidates,
      probe,
      clock: new FakeClock(),
      concurrency: 1,
      connectTimeoutMs: 20,
      replyTimeoutMs: 5,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
      signal,
    });

    expect(calls).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
