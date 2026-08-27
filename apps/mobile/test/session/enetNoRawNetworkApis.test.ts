import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P4e-FIX2 L3 (binding, Codex P4e-REV2 Part B item 7 -- "Offline mandate:
 * the ENET socket is the only network activity"): a static source-text check
 * that none of the ENET-related mobile files reach for a network API other
 * than `react-native-tcp-socket` (via `EnetTcpTransport`, this repo's ONE
 * ENET transport). No `fetch`, `XMLHttpRequest`, `WebSocket`, or any UDP API
 * (the ENET addendum's own note: "UDP 6811 discovery -- NOT used in v1, no
 * UDP dep") may appear in ANY of these files' source text. A simple `grep`
 * over source text, not a bundler/AST analysis -- deliberately so: it is the
 * exact static check a reviewer would run, and it needs no build step.
 */
const ENET_SOURCE_FILES = [
  '../../src/session/enetTcpTransport.ts',
  '../../src/session/telemetryProvider.ts',
  '../../src/session/enetSettingsValidation.ts',
  '../../src/session/didProbe.ts',
  '../../src/ui/screens/DidProbeScreen.tsx',
  '../../src/ui/screens/SettingsScreen.tsx',
  '../../src/ui/screens/TelemetryScreen.tsx',
  // ENET auto-discovery & DID sweep addendum (binding, Phase 4f): the new
  // files this ticket adds.
  '../../src/session/networkInfo.ts',
  '../../src/session/didSweepController.ts',
  '../../src/ui/screens/DidSweepScreen.tsx',
];

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'fetch(', pattern: /\bfetch\s*\(/ },
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { label: 'WebSocket', pattern: /\bWebSocket\b/ },
  { label: 'UDP (dgram)', pattern: /\bdgram\b/ },
  { label: 'react-native-udp', pattern: /react-native-udp/ },
  { label: 'createSocket( (UDP-style socket API)', pattern: /\bcreateSocket\s*\(/ },
];

describe('ENET files: no raw network API besides react-native-tcp-socket (offline mandate, static check)', () => {
  for (const relativePath of ENET_SOURCE_FILES) {
    it(`${relativePath} contains no fetch/XMLHttpRequest/WebSocket/UDP usage`, () => {
      const absolutePath = resolve(__dirname, relativePath);
      const source = readFileSync(absolutePath, 'utf8');
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        expect(pattern.test(source), `${relativePath} unexpectedly contains ${label}`).toBe(false);
      }
    });
  }

  it('the ONE network-capable module (EnetTcpTransport) reaches only react-native-tcp-socket, nothing else', () => {
    const source = readFileSync(resolve(__dirname, '../../src/session/enetTcpTransport.ts'), 'utf8');
    expect(source).toContain("import('react-native-tcp-socket')");
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      expect(pattern.test(source), `EnetTcpTransport unexpectedly contains ${label}`).toBe(false);
    }
  });
});
