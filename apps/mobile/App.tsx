import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
// Import from the workspace domain package — proves @circuit/core is resolvable
// AND actually bundled from apps/mobile via the npm workspace + Metro monorepo
// config. No feature UI / domain logic is implemented here; this is scaffold
// wiring only. CORE_PACKAGE_ID is a real value import (types alone get erased
// from the Metro bundle, so a type-only import can't prove runtime wiring).
import { CORE_PACKAGE_ID } from '@circuit/core';
import type { MonotonicClock, SessionState } from '@circuit/core';
// Value import (not type-only) of the platform integration layer, for the same
// reason as CORE_PACKAGE_ID above: proves src/platform/** is actually resolved
// and bundled by Metro from the app entry point, not just type-checked in
// isolation. No feature UI wiring beyond this proof is in scope here.
import { PerformanceNowClock } from './src/platform';

const scaffoldClock: MonotonicClock = { now: () => 0 };
const scaffoldState: SessionState = 'idle';
const platformClock: MonotonicClock = new PerformanceNowClock();

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Circuit Timer — scaffold</Text>
      <Text style={styles.subtitle}>
        {CORE_PACKAGE_ID} wired (state: {scaffoldState}, t0: {scaffoldClock.now()})
      </Text>
      <Text style={styles.subtitle}>platform layer wired (t0: {platformClock.now()})</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  subtitle: {
    marginTop: 8,
    color: '#666',
  },
});
