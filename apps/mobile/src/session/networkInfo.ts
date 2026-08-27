/**
 * ENET auto-discovery addendum (contracts.md, binding, Phase 4f): "the app
 * reads its own IPv4/subnet (`expo-network`, SDK-matched) and shows it on the
 * telemetry screen". `expo-network` (SDK 57 -- see `apps/mobile/AGENTS.md`)
 * exposes only `getIpAddressAsync()`; there is no subnet-mask API in this
 * SDK version at all, so `subnetMask` is always omitted here -- `@circuit/core`'s
 * `buildDiscoveryCandidates` already treats an omitted mask as "assume /24"
 * (the common phone-tethered-to-the-adapter's-AP case this addendum
 * describes), so this is not a degraded result, just the honest one.
 *
 * Lazy dynamic import (same seam as `tcpObdTransport.ts`'s own
 * `loadTcpSocketModule`/`enetTcpTransport.ts`'s `loadTcpSocketModule`): a
 * static top-level `import * as Network from 'expo-network'` would reach
 * `expo-modules-core`'s `requireNativeModule`, which itself imports
 * `react-native` -- Flow-typed source vitest's parser cannot handle (see
 * `composition.ts`'s own `IS_WEB_RUNTIME` comment) -- at MODULE-LOAD time,
 * crashing every test that merely imports this file (or anything importing
 * it, e.g. `telemetryProvider.ts`) regardless of whether it ever calls
 * `getNetworkInfo()`. The dynamic import below defers that entirely to the
 * point this function is actually CALLED, and is wrapped in try/catch so a
 * missing/incompatible native module (any non-native-RN runtime: web
 * preview, vitest) resolves to `null` -- NEVER throws.
 */
export interface NetworkInfo {
  ipv4: string;
  /** Always omitted -- see this module's own doc comment above. Kept on the type so a future SDK that adds a mask API is a same-shape addition, not a breaking one. */
  subnetMask?: string;
}

/** Web detection without importing react-native (mirrors `composition.ts`'s own `IS_WEB_RUNTIME`). */
const IS_WEB_RUNTIME = typeof document !== 'undefined';

/** `0.0.0.0` is `expo-network`'s own documented placeholder for "could not be retrieved" -- never a real phone IP, so treated the same as `null`. */
const PLACEHOLDER_IPV4 = '0.0.0.0';

/** Test-only seam (mirrors `enetTcpTransport.ts`'s `loadModule`): overrides the lazy `expo-network` import. Production callers never pass this. */
export async function getNetworkInfo(
  loadModule: () => Promise<typeof import('expo-network')> = () => import('expo-network'),
): Promise<NetworkInfo | null> {
  if (IS_WEB_RUNTIME) return null;
  try {
    const Network = await loadModule();
    const ip = await Network.getIpAddressAsync();
    if (typeof ip !== 'string' || ip.trim() === '' || ip === PLACEHOLDER_IPV4) return null;
    return { ipv4: ip };
  } catch {
    return null;
  }
}
