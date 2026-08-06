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
import { PersonalBestScreen } from '../screens/PersonalBestScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { DevReplayScreen } from '../screens/DevReplayScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** The app's single navigator (S1–S13). Screen options keep chrome minimal and dark. */
export function RootNavigator(): React.JSX.Element {
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
      <Stack.Screen name="PersonalBest" component={PersonalBestScreen} options={{ title: 'Personal Best' }} />
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      <Stack.Screen name="DevReplay" component={DevReplayScreen} options={{ title: 'Dev Replay' }} />
    </Stack.Navigator>
  );
}
