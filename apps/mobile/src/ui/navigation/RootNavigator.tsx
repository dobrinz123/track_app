import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from './types';
import { colors, fontFamily } from '../theme';
import { CircuitSelectionScreen } from '../screens/CircuitSelectionScreen';
import { CircuitDetailScreen } from '../screens/CircuitDetailScreen';
import { PreflightScreen } from '../screens/PreflightScreen';
import { CalibrationInstructionsScreen } from '../screens/CalibrationInstructionsScreen';
import { ActiveCalibrationScreen } from '../screens/ActiveCalibrationScreen';
import { CalibrationResultScreen } from '../screens/CalibrationResultScreen';
import { ActiveDashboardScreen } from '../screens/ActiveDashboardScreen';
import { SessionResultsScreen } from '../screens/SessionResultsScreen';
import { SessionHistoryScreen } from '../screens/SessionHistoryScreen';
import { LapDetailScreen } from '../screens/LapDetailScreen';
// Ticket P5b B1 (binding): the post-session analysis is an ORDINARY product
// screen -- registered in every build and reachable from the results and
// history screens with no developer gate of any kind. It imports no DevReplay
// fixtures, so shipping it always costs a release bundle nothing beyond the
// screen itself.
import { AnalysisScreen } from '../screens/AnalysisScreen';
import { resolveAnalysisScreenStrings } from '../screens/analysisStrings';
import { useSettings } from '../hooks/useSettings';
import { settingsStore } from '../../session/composition';
import { PersonalBestScreen } from '../screens/PersonalBestScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TelemetryScreen } from '../screens/TelemetryScreen';
// Field revision (2026-08-27, binding, "hidden developer mode"): DidProbe/
// DidSweep are NOW ordinary top-level imports -- their routes are registered
// in every build, release included (only their Settings-screen entry points
// are gated on `developerModeEnabled`/`__DEV__`, see `SettingsScreen.tsx`).
// Neither screen imports DevReplay's own dev-only fixtures, so shipping them
// unconditionally never pulls fixture data into a release bundle.
import { DidProbeScreen } from '../screens/DidProbeScreen';
import { DidSweepScreen } from '../screens/DidSweepScreen';
// Ticket P4l (binding, contracts.md "Signal Finder (Phase 4l)"): same
// unconditional route registration as DidProbe/DidSweep above -- only its
// Settings entry point is gated on `developerModeEnabled`/`__DEV__`. It
// imports no DevReplay fixtures either, so shipping it always costs a
// release bundle nothing beyond the screen itself.
import { SignalFinderScreen } from '../screens/SignalFinderScreen';
// F6 fix (B4 residue): NO top-level import of `DevReplayScreen` -- see the
// inline `require` below for why. `typeof import(...)` (used at that call
// site) gives full type-checking on the resolved component with zero
// runtime footprint, so nothing here needs a type-only import either.

const Stack = createNativeStackNavigator<RootStackParamList>();

/** The app's single navigator (S1–S13). Screen options keep chrome minimal and dark. */
export function RootNavigator(): React.JSX.Element {
  // P5b-FIX1 C9: the app's language, live, so the Analysis header follows the
  // language its report is written in.
  const settings = useSettings(settingsStore);
  const analysisStrings = resolveAnalysisScreenStrings(settings.language);
  return (
    <Stack.Navigator
      initialRouteName="CircuitSelection"
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.textPrimary, fontFamily: fontFamily.displaySemibold, fontSize: 17 },
        headerTitleAlign: 'left',
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
        animation: 'fade_from_bottom',
      }}
    >
      <Stack.Screen name="CircuitSelection" component={CircuitSelectionScreen} options={{ headerShown: false }} />
      <Stack.Screen name="CircuitDetail" component={CircuitDetailScreen} options={{ title: 'Circuit' }} />
      <Stack.Screen name="Preflight" component={PreflightScreen} options={{ title: 'Preflight' }} />
      <Stack.Screen
        name="CalibrationInstructions"
        component={CalibrationInstructionsScreen}
        options={{ title: 'Learn Your Line' }}
      />
      <Stack.Screen
        name="ActiveCalibration"
        component={ActiveCalibrationScreen}
        options={{ title: 'Calibrating', headerBackVisible: false, gestureEnabled: false }}
      />
      <Stack.Screen name="CalibrationResult" component={CalibrationResultScreen} options={{ title: 'Calibration', headerBackVisible: false }} />
      <Stack.Screen
        name="ActiveDashboard"
        component={ActiveDashboardScreen}
        options={{ title: 'Timing', headerShown: false, gestureEnabled: false }}
      />
      <Stack.Screen name="SessionResults" component={SessionResultsScreen} options={{ title: 'Results', headerBackVisible: false }} />
      <Stack.Screen name="SessionHistory" component={SessionHistoryScreen} options={{ title: 'History' }} />
      <Stack.Screen name="LapDetail" component={LapDetailScreen} options={{ title: 'Lap Detail' }} />
      {
        // P5b-FIX1 C9 (Codex P5b-REV1 finding 11): the header title comes from
        // the SAME RO/EN table the screen's own chrome does -- a Romanian
        // report under an English navigator title was half-translated.
      }
      <Stack.Screen
        name="Analysis"
        component={AnalysisScreen}
        options={{ title: analysisStrings.screenTitle }}
      />
      <Stack.Screen name="PersonalBest" component={PersonalBestScreen} options={{ title: 'Personal Best' }} />
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      <Stack.Screen name="Telemetry" component={TelemetryScreen} options={{ title: 'Telemetry' }} />
      {
        // Field revision (2026-08-27, binding, "hidden developer mode"): the
        // DID-probe screen's ROUTE is now registered in every build --
        // release included -- unconditionally (only its `SettingsScreen.tsx`
        // entry point is gated on `developerModeEnabled`/`__DEV__`).
      }
      <Stack.Screen name="DidProbe" component={DidProbeScreen} options={{ title: 'DID Probe' }} />
      {
        // ENET auto-discovery & DID sweep addendum (Phase 4f), field revision
        // (2026-08-27, binding): same unconditional route registration as
        // `DidProbe` immediately above.
      }
      <Stack.Screen name="DidSweep" component={DidSweepScreen} options={{ title: 'DID Sweep' }} />
      <Stack.Screen name="SignalFinder" component={SignalFinderScreen} options={{ title: 'Signal Finder' }} />
      {
        // B4 fix: DevReplay must not ship in a release build -- SettingsScreen's
        // entry point to it is already __DEV__-gated; this gates the route
        // registration itself too.
        //
        // F6 fix (B4 residue): gating the <Stack.Screen> registration alone
        // was not enough -- a top-level `import { DevReplayScreen } from
        // '../screens/DevReplayScreen'` reaches the module unconditionally
        // at bundle time regardless of what runtime branch it's used in, so
        // it (and its `@circuit/core` fixture-scenario dependencies) still
        // entered a release bundle's dependency graph. Metro constant-folds
        // `__DEV__` (a literal boolean substituted at bundle time) and drops
        // statically-unreachable code, but only when the module boundary
        // itself is inside the folded branch -- an inline `require()` here,
        // not a top-level `import`, is what actually keeps the module (and
        // its deps) out of a release build's graph.
        // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
        __DEV__ ? (
          <Stack.Screen
            name="DevReplay"
            component={
              // eslint-disable-next-line @typescript-eslint/no-require-imports -- see the F6 comment above: this MUST be a runtime require(), not a top-level import, for Metro to drop the module from a release bundle.
              (require('../screens/DevReplayScreen') as typeof import('../screens/DevReplayScreen')).DevReplayScreen
            }
            options={{ title: 'Dev Replay' }}
          />
        ) : null
      }
    </Stack.Navigator>
  );
}
