import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, spacing, typography } from '../theme';
import { DeltaDisplay } from '../components/DeltaDisplay';
import { TimeDisplay } from '../components/TimeDisplay';
import { QualityPill } from '../components/QualityPill';
import { SectorBar } from '../components/SectorBar';
import { LongPressButton } from '../components/LongPressButton';
import { StatusBanner } from '../components/StatusBanner';
import { facade } from '../../session/composition';
import { useFacadeState } from '../hooks/useFacadeState';

type Props = NativeStackScreenProps<RootStackParamList, 'ActiveDashboard'>;

const SECTOR_COUNT = 3; // Transilvania Motor Ring: 3 app-defined sectors (ADR-0002).

/**
 * S7 — THE driving screen. Portrait, fixed layout, no scrolling. The live
 * delta is the dominant element (~30% of height). The only control is
 * End Session via a 2s long-press (MUST DO: no accidental touch). No modal
 * dialogs are ever shown here — status changes render as the inline banner
 * slot below the quality pill.
 */
export function ActiveDashboardScreen({ navigation }: Props): React.JSX.Element {
  useKeepAwake();
  const state = useFacadeState(facade);
  const armedRef = useRef(false);
  const navigatedRef = useRef(false);

  // Kick off the scripted drive (armed → outLap → timing) once on arrival.
  useEffect(() => {
    if (!armedRef.current) {
      armedRef.current = true;
      facade.arm();
    }
  }, []);

  useEffect(() => {
    if (state.sessionState === 'sessionComplete' && !navigatedRef.current) {
      navigatedRef.current = true;
      navigation.replace('SessionResults');
    }
  }, [navigation, state.sessionState]);

  const banner =
    state.gnssQuality === 'unreliable' || state.gnssQuality === 'invalid'
      ? { variant: 'error' as const, message: 'GNSS signal is unreliable — timing may be inaccurate.' }
      : state.sessionState === 'paused'
        ? { variant: 'warning' as const, message: 'Session paused.' }
        : state.sessionState === 'outLap'
          ? { variant: 'info' as const, message: 'Out lap — timing starts at the line.' }
          : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.container}>
        <View style={styles.topRow}>
          <QualityPill quality={state.gnssQuality} compact />
          <Text style={styles.lapCounter} maxFontSizeMultiplier={1.2} accessibilityLabel={`Lap ${state.lapNumber}`}>
            LAP {state.lapNumber}
          </Text>
        </View>

        <View style={styles.bannerSlot}>{banner ? <StatusBanner variant={banner.variant} message={banner.message} /> : null}</View>

        <View style={styles.deltaZone}>
          <DeltaDisplay delta={state.delta} fontSize={100} />
        </View>

        <View style={styles.lapTimeZone}>
          <TimeDisplay ms={state.currentLapMs} size="display" live accessibilityLabel={`Current lap time`} />
          <Text style={styles.lapTimeCaption} maxFontSizeMultiplier={1.2}>
            CURRENT LAP
          </Text>
        </View>

        <SectorBar currentSector={state.sector} sectorCount={SECTOR_COUNT} />

        <View style={styles.bottomRow}>
          <View style={styles.bottomStat}>
            <Text style={styles.bottomStatLabel} maxFontSizeMultiplier={1.2}>
              LAST LAP
            </Text>
            <TimeDisplay ms={state.lastLapMs} size="small" />
          </View>
          <View style={styles.bottomStat}>
            <Text style={styles.bottomStatLabel} maxFontSizeMultiplier={1.2}>
              PERSONAL BEST
            </Text>
            <TimeDisplay ms={state.pbMs} size="small" />
          </View>
          <View style={styles.bottomStat}>
            <Text style={styles.bottomStatLabel} maxFontSizeMultiplier={1.2}>
              SPEED
            </Text>
            {/* Not part of FacadeState (MUST DO #1) — wire up when the facade
                gains a live speed field from the real pipeline. */}
            <Text style={styles.speedPlaceholder} maxFontSizeMultiplier={1.2}>
              -- km/h
            </Text>
          </View>
        </View>

        <View style={styles.controlZone}>
          <LongPressButton
            label="Hold to End Session"
            accessibilityLabel="End session, press and hold for two seconds"
            onLongPressComplete={() => facade.endSession()}
            durationMs={2000}
            danger
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, padding: spacing.md, gap: spacing.sm },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lapCounter: { ...typography.subtitle, color: colors.textSecondary, letterSpacing: 1 },
  bannerSlot: { minHeight: 0 },
  deltaZone: { flexGrow: 3, alignItems: 'center', justifyContent: 'center' },
  lapTimeZone: { alignItems: 'center', justifyContent: 'center' },
  lapTimeCaption: { ...typography.label, color: colors.textMuted, marginTop: spacing.xs, letterSpacing: 1 },
  bottomRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  bottomStat: { alignItems: 'flex-start' },
  bottomStatLabel: { ...typography.label, color: colors.textMuted, marginBottom: spacing.xs },
  speedPlaceholder: { ...typography.timeSmall, color: colors.textMuted },
  controlZone: { marginTop: spacing.sm },
});
