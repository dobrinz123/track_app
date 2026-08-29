import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket P4l S4 (binding): "`SignalFinderScreen.tsx` reachable from the
 * Developer screen". Same shape as the existing DID Probe / DID Sweep
 * arrangement (field revision 2026-08-27, "hidden developer mode"): the ROUTE
 * is registered in every build, only the Settings entry point is gated on
 * `developerModeEnabled` / `__DEV__`.
 *
 * A static source-text check (the convention
 * `hiddenDeveloperModeRouteGating.test.ts` established) rather than rendering
 * the navigator: both files import `react-native`/`@react-navigation`, which
 * cannot load under this project's plain-Node vitest environment.
 */

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('SignalFinder route registration', () => {
  const source = readSource('../../src/ui/navigation/RootNavigator.tsx');

  it('is a top-level import and an UNCONDITIONAL <Stack.Screen> (no __DEV__ ternary)', () => {
    expect(source).toMatch(/import\s*\{\s*SignalFinderScreen\s*\}\s*from\s*'..\/screens\/SignalFinderScreen'/);
    const match = /<Stack\.Screen\s+name="SignalFinder"[^>]*\/>/.exec(source);
    expect(match).not.toBeNull();
    const before = source.slice(Math.max(0, match!.index - 200), match!.index);
    expect(before).not.toMatch(/__DEV__\s*\?/);
  });

  it('is declared in the navigator s param list', () => {
    expect(readSource('../../src/ui/navigation/types.ts')).toMatch(/SignalFinder:\s*undefined;/);
  });
});

describe('SignalFinder developer entry point', () => {
  const source = readSource('../../src/ui/screens/SettingsScreen.tsx');

  it('is gated on `isDev || settings.developerModeEnabled`, like DID Probe/Sweep', () => {
    const index = source.indexOf("navigate('SignalFinder')");
    expect(index).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, index - 300), index);
    expect(before).toMatch(/isDev\s*\|\|\s*settings\.developerModeEnabled/);
  });
});

describe('SignalFinderScreen source constraints', () => {
  const source = readSource('../../src/ui/screens/SignalFinderScreen.tsx');

  it('imports no DevReplay fixtures (it ships in release builds)', () => {
    expect(source).not.toMatch(/DevReplay|devReplayScenarios/);
  });

  it('carries no vehicle constants -- every ECU/DID comes from the target catalog (data)', () => {
    // No hex ECU addresses or DIDs written into the screen itself. The two
    // helpers that FORMAT hex (`didHex`/`ecuHex`) use `toString(16)`, never a
    // literal.
    expect(source).not.toMatch(/0x[0-9a-fA-F]{2,4}\b/);
    expect(source).toMatch(/SIGNAL_TARGET_CATALOGS/);
  });

  it('never connects or closes a transport itself -- it only supplies the factory', () => {
    expect(source).toMatch(/transportFactory/);
    expect(source).not.toMatch(/\.connect\(\)/);
  });
});
