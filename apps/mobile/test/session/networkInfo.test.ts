import { describe, expect, it } from 'vitest';
import { getNetworkInfo } from '../../src/session/networkInfo';

describe('networkInfo (ENET auto-discovery addendum, binding): getNetworkInfo() never throws', () => {
  it('returns null under a plain Node/vitest environment (no expo-network native module) without throwing', async () => {
    await expect(getNetworkInfo()).resolves.toBeNull();
  });

  it('returns {ipv4} (no subnetMask -- SDK 57 exposes none) when the injected module resolves a real address', async () => {
    const info = await getNetworkInfo(async () => ({
      getIpAddressAsync: async () => '192.168.4.23',
    }) as unknown as typeof import('expo-network'));
    expect(info).toEqual({ ipv4: '192.168.4.23' });
  });

  it('returns null for the documented "could not be retrieved" placeholder 0.0.0.0', async () => {
    const info = await getNetworkInfo(async () => ({
      getIpAddressAsync: async () => '0.0.0.0',
    }) as unknown as typeof import('expo-network'));
    expect(info).toBeNull();
  });

  it('returns null when the injected loader itself rejects', async () => {
    const info = await getNetworkInfo(() => Promise.reject(new Error('boom: native module unavailable (test double)')));
    expect(info).toBeNull();
  });

  it('returns null when getIpAddressAsync() rejects', async () => {
    const info = await getNetworkInfo(async () => ({
      getIpAddressAsync: async () => {
        throw new Error('boom (test double)');
      },
    }) as unknown as typeof import('expo-network'));
    expect(info).toBeNull();
  });
});
