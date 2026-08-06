import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
// Import from the workspace domain package — proves @circuit/core is resolvable
// AND actually bundled from apps/mobile via the npm workspace + Metro monorepo
// config. No feature UI / domain logic is implemented here; this is scaffold
// wiring only. CORE_PACKAGE_ID is a real value import (types alone get erased
// from the Metro bundle, so a type-only import can't prove runtime wiring).
import { CORE_PACKAGE_ID } from '@circuit/core';
import type { MonotonicClock, SessionState } from '@circuit/core';

const scaffoldClock: MonotonicClock = { now: () => 0 };
const scaffoldState: SessionState = 'idle';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Circuit Timer — scaffold</Text>
      <Text style={styles.subtitle}>
        {CORE_PACKAGE_ID} wired (state: {scaffoldState}, t0: {scaffoldClock.now()})
      </Text>
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
