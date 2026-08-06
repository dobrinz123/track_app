import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme, type Theme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
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

/**
 * Splash-gate: nothing renders until the design system's fonts (Space
 * Grotesk, Inter, JetBrains Mono -- theme/index.ts's `fontFamily`) are
 * loaded, so the system-font fallback never flashes mid-session. No
 * `expo-splash-screen` dependency is available to this work package (MUST
 * NOT: "add deps beyond the 4 font packages"), so the gate is a plain
 * background-colored blank view rather than a controlled native splash
 * hold -- still zero mixed-font frames, just without an explicit
 * `hideAsync()` call.
 */
export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
    JetBrainsMono_700Bold,
  });

  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={navigationTheme}>
        <RootNavigator />
        <StatusBar style="light" />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
