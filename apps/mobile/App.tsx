import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme, type Theme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/ui/navigation/RootNavigator';
import { colors } from './src/ui/theme';

// Dark theme is the app default (MUST DO: "Dark theme default (track use)") —
// track-side legibility, not a system-preference toggle. React Navigation's
// chrome (header, screen background, focus rings) is themed to match our
// design tokens so screens with a native header don't flash the library
// default dark palette before their own styles apply.
const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.background,
    card: colors.surface,
    text: colors.textPrimary,
    border: colors.border,
    notification: colors.danger,
  },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer theme={navigationTheme}>
        <RootNavigator />
        <StatusBar style="light" />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
