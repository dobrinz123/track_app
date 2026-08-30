import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket P5b B1 (binding): "an 'Analysis' button on the session summary
 * (post-session) and on the lap-history/session views for a past session of
 * EITHER circuit. Dev-independent (not behind the dev gate). No analysis
 * during an active session."
 *
 * A static source-text check -- the convention
 * `hiddenDeveloperModeRouteGating.test.ts` / `signalFinderRouteGating.test.ts`
 * established, because both the navigator and the screens import
 * `react-native`/`@react-navigation`, which cannot load under this project's
 * plain-Node vitest environment.
 */

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('Analysis route registration', () => {
  const source = readSource('../../src/ui/navigation/RootNavigator.tsx');

  it('is a top-level import and an UNCONDITIONAL <Stack.Screen> (no __DEV__ ternary)', () => {
    expect(source).toMatch(/import\s*\{\s*AnalysisScreen\s*\}\s*from\s*'..\/screens\/AnalysisScreen'/);
    const match = /<Stack\.Screen\s+name="Analysis"[\s\S]*?\/>/.exec(source);
    expect(match).not.toBeNull();
    const before = source.slice(Math.max(0, match!.index - 200), match!.index);
    expect(before).not.toMatch(/__DEV__\s*\?/);
  });

  it('takes the session id as a route param', () => {
    expect(readSource('../../src/ui/navigation/types.ts')).toMatch(
      /Analysis:\s*\{\s*sessionId:\s*string\s*\};/,
    );
  });
});

describe('Analysis entry points (dev-independent)', () => {
  it('the post-session results screen offers it, without a developer gate', () => {
    const source = readSource('../../src/ui/screens/SessionResultsScreen.tsx');
    const index = source.indexOf("navigate('Analysis'");
    expect(index).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, index - 600), index);
    expect(before).not.toMatch(/developerModeEnabled|__DEV__/);
  });

  it('the session-history screen offers it per stored session, without a developer gate', () => {
    const source = readSource('../../src/ui/screens/SessionHistoryScreen.tsx');
    const index = source.indexOf("navigate('Analysis'");
    expect(index).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, index - 600), index);
    expect(before).not.toMatch(/developerModeEnabled|__DEV__/);
    // The button is rendered per session row, so ANY stored session of ANY
    // circuit can be analysed -- never a single hard-coded circuit.
    expect(source).toMatch(/sessionId:\s*session\.sessionId/);
  });
});

describe('AnalysisScreen source constraints', () => {
  const source = readSource('../../src/ui/screens/AnalysisScreen.tsx');

  it('imports no DevReplay fixtures (it ships in release builds)', () => {
    expect(source).not.toMatch(/DevReplay|devReplayScenarios/);
  });

  it('carries no circuit or vehicle constants', () => {
    expect(source).not.toMatch(/transilvania|motorpark|supra|b58/i);
  });

  it('keeps its logic in the view model -- it neither analyses nor writes report text', () => {
    expect(source).not.toMatch(/analyzeSession|buildReport\(/);
    expect(source).toMatch(/createAnalysisRunner|buildAnalysisScreenState/);
  });

  it('refuses to analyse while a session is live (the runner is told, not trusted)', () => {
    expect(source).toMatch(/isSessionActive/);
  });
});
