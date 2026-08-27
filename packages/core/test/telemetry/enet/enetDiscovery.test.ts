import { describe, expect, it } from 'vitest';

import type { ObdTransport } from '../../../src/telemetry/contracts';
import {
  buildDiscoveryCandidates,
  ENET_DISCOVERY_DEFAULT_PORT,
  ENET_DISCOVERY_MHD_HOST,
  MAX_DISCOVERY_CANDIDATES,
  runDiscovery,
  type DiscoveryCandidate,
} from '../../../src/telemetry/enet/enetDiscovery';
import { createSimulatedDiscoveryProbeFactory } from '../../../src/telemetry/enet/simulatedEnetTransport';
import { FakeClock } from '../../controller/testSupport';

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

  it('skips the phone-subnet sweep entirely for a non-/24 mask ("/24 only")', () => {
    const candidates = buildDiscoveryCandidates({
      phoneIpv4: '10.1.2.3',
      subnetMask: '255.255.0.0',
    });
    // only the MHD default host survives -- no phone .1, no /24 enumeration
    expect(candidates).toEqual([
      { host: ENET_DISCOVERY_MHD_HOST, port: ENET_DISCOVERY_DEFAULT_PORT },
    ]);
  });

  it('ignores a malformed phoneIpv4 without throwing', () => {
    const candidates = buildDiscoveryCandidates({ phoneIpv4: 'not-an-ip' });
    expect(candidates).toEqual([{ host: ENET_DISCOVERY_MHD_HOST, port: ENET_DISCOVERY_DEFAULT_PORT }]);
  });

  it('assumes /24 when subnetMask is omitted entirely', () => {
    const candidates = buildDiscoveryCandidates({ phoneIpv4: '172.16.9.40' });
    expect(candidates.some((c) => c.host === '172.16.9.1')).toBe(true);
    expect(candidates.some((c) => c.host === '172.16.9.2')).toBe(true);
    expect(candidates.some((c) => c.host === '172.16.9.40')).toBe(false);
  });
});

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

  it('bounds concurrency at the configured limit', async () => {
    let active = 0;
    let peak = 0;
    const candidates: DiscoveryCandidate[] = Array.from({ length: 6 }, (_, i) => ({ host: `10.0.1.${i}`, port: 6801 }));
    const probe = (): ObdTransport => ({
      connect: () =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          setTimeout(() => {
            active -= 1;
            resolve();
          }, 15);
        }),
      send: () => {},
      onData: () => () => {},
      onClose: () => () => {},
      close: async () => {},
    });

    await runDiscovery({
      candidates,
      probe,
      clock: new FakeClock(),
      concurrency: 2,
      connectTimeoutMs: 100,
      replyTimeoutMs: 5,
      budgetMs: 5_000,
      testerAddress: 0xf4,
      targetAddress: 0x12,
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it('truncates when the injected clock reports the budget has elapsed, leaving later candidates unscanned', async () => {
    const clock = new FakeClock();
    const candidates: DiscoveryCandidate[] = Array.from({ length: 5 }, (_, i) => ({ host: `10.0.2.${i}`, port: 6801 }));
    // Each "connect" costs 100ms of the injected clock's budget (deterministic
    // regardless of real wall-clock time) -- with a 250ms budget, only the
    // first 3 candidates fit before the 4th worker iteration sees the budget
    // has elapsed.
    const probe = (): ObdTransport => ({
      connect: async () => {
        clock.advance(100);
      },
      send: () => {},
      onData: () => () => {},
      onClose: () => () => {},
      close: async () => {},
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
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.level === 1)).toBe(true);
  });

  it('stops scheduling new probes once the abort signal is set, without throwing', async () => {
    const signal = { aborted: false };
    const candidates: DiscoveryCandidate[] = Array.from({ length: 5 }, (_, i) => ({ host: `10.0.3.${i}`, port: 6801 }));
    let calls = 0;
    const probe = (): ObdTransport => ({
      connect: async () => {
        calls += 1;
        if (calls === 1) signal.aborted = true; // abort right after the first candidate starts
      },
      send: () => {},
      onData: () => () => {},
      onClose: () => () => {},
      close: async () => {},
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
