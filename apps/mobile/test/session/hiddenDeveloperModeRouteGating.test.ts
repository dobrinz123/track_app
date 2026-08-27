import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Field revision (2026-08-27, binding, "hidden developer mode"): "when on
 * (or __DEV__), Settings shows 'Dev: DID Probe (ENET)' and 'Dev: DID Sweep
 * (ENET)' and the routes are registered in release too (screens must not
 * import DevReplay fixtures); DevReplay stays __DEV__-only." A static
 * source-text check (the same convention `enetNoRawNetworkApis.test.ts`
 * uses) rather than rendering `RootNavigator`/`SettingsScreen` -- both import
 * `react-native`/`@react-navigation`, which cannot be imported under this
 * project's plain-Node vitest environment (see those files' own module-graph
 * constraints).
 */

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('RootNavigator: DidProbe/DidSweep routes are registered unconditionally; DevReplay stays __DEV__-only (binding)', () => {
  const source = readSource('../../src/ui/navigation/RootNavigator.tsx');

  it('DidProbe and DidSweep are top-level imports (never a runtime require()) -- the release-tree-shaking `require()` treatment is gone now that they ship unconditionally', () => {
    expect(source).toMatch(/import\s*\{\s*DidProbeScreen\s*\}\s*from\s*'..\/screens\/DidProbeScreen'/);
    expect(source).toMatch(/import\s*\{\s*DidSweepScreen\s*\}\s*from\s*'..\/screens\/DidSweepScreen'/);
  });

  it('the DidProbe/DidSweep <Stack.Screen> registrations are UNCONDITIONAL -- no `__DEV__ ?` ternary wraps them', () => {
    const didProbeMatch = /<Stack\.Screen\s+name="DidProbe"[^>]*\/>/.exec(source);
    const didSweepMatch = /<Stack\.Screen\s+name="DidSweep"[^>]*\/>/.exec(source);
    expect(didProbeMatch).not.toBeNull();
    expect(didSweepMatch).not.toBeNull();

    // Neither registration is preceded by an un-closed `__DEV__ ?` ternary
    // (the OLD gating this replaces) -- checks for the TERNARY specifically
    // (`__DEV__` followed by `?`), not the bare token, since this file's own
    // doc comments legitimately mention `__DEV__` in prose nearby.
    const beforeDidProbe = source.slice(Math.max(0, didProbeMatch!.index - 200), didProbeMatch!.index);
    const beforeDidSweep = source.slice(Math.max(0, didSweepMatch!.index - 200), didSweepMatch!.index);
    expect(beforeDidProbe).not.toMatch(/__DEV__\s*\?/);
    expect(beforeDidSweep).not.toMatch(/__DEV__\s*\?/);
  });

  it('DevReplay is UNAFFECTED -- still __DEV__-gated end to end (regression pin)', () => {
    // A real top-level import statement (line-anchored, no closing brace
    // inside) -- NOT the doc comment above that quotes this exact pattern in
    // prose while explaining why it's avoided (`require()` used instead).
    expect(source).not.toMatch(/^import\s*\{[^}]*\bDevReplayScreen\b[^}]*\}/m);
    const devReplayMatch = /<Stack\.Screen\s+name="DevReplay"/.exec(source);
    expect(devReplayMatch).not.toBeNull();
    const before = source.slice(Math.max(0, devReplayMatch!.index - 300), devReplayMatch!.index);
    expect(before).toMatch(/__DEV__\s*\?/);
  });
});

describe('SettingsScreen: the DID Probe/DID Sweep dev buttons are gated on developerModeEnabled OR __DEV__; DevReplay stays __DEV__-only (binding)', () => {
  const source = readSource('../../src/ui/screens/SettingsScreen.tsx');

  it('imports registerDevTap from settingsStore.ts (the pure tap-counter)', () => {
    expect(source).toMatch(/registerDevTap/);
  });

  it('the DID Probe and DID Sweep buttons are gated on `isDev || settings.developerModeEnabled`', () => {
    const didProbeIndex = source.indexOf("navigate('DidProbe')");
    const didSweepIndex = source.indexOf("navigate('DidSweep')");
    expect(didProbeIndex).toBeGreaterThan(-1);
    expect(didSweepIndex).toBeGreaterThan(-1);

    const beforeDidProbe = source.slice(Math.max(0, didProbeIndex - 300), didProbeIndex);
    const beforeDidSweep = source.slice(Math.max(0, didSweepIndex - 300), didSweepIndex);
    expect(beforeDidProbe).toMatch(/isDev\s*\|\|\s*settings\.developerModeEnabled/);
    expect(beforeDidSweep).toMatch(/isDev\s*\|\|\s*settings\.developerModeEnabled/);
  });

  it('the DevReplay button is UNAFFECTED -- still plain __DEV__-gated (regression pin)', () => {
    const devReplayIndex = source.indexOf("navigate('DevReplay')");
    expect(devReplayIndex).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, devReplayIndex - 300), devReplayIndex);
    expect(before).toMatch(/__DEV__/);
    expect(before).not.toMatch(/developerModeEnabled/);
  });
});

describe('DidProbeScreen.tsx / DidSweepScreen.tsx never import DevReplay fixtures (binding: "screens must not import DevReplay fixtures")', () => {
  it.each(['../../src/ui/screens/DidProbeScreen.tsx', '../../src/ui/screens/DidSweepScreen.tsx'])('%s has no DevReplay/fixture import', (relativePath) => {
    const source = readSource(relativePath);
    expect(source).not.toMatch(/from\s+['"].*DevReplay/);
    expect(source).not.toMatch(/from\s+['"].*[Ff]ixtures?['"]/);
  });
});
