import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
import { CoachStrip, COACH_STRIP_HEIGHT } from '../components/CoachStrip';
import { TelemetryStrip } from '../components/TelemetryStrip';
import { facade, settingsStore } from '../../session/composition';
import { useFacadeState } from '../hooks/useFacadeState';
import { useSettings } from '../hooks/useSettings';
import { resolvePitScreenStrings } from './trackdayStrings';

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
  const settings = useSettings(settingsStore);
  const pitStrings = resolvePitScreenStrings(settings.language);
  // The car is stopped: the pit-lane state the pipeline already detects, or a
  // paused session. The pit view is never one tap away at speed.
  const stopped = state.sessionState === 'inPit' || state.sessionState === 'paused';
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

  // C7 fix: a failed async command (e.g. endSession()'s persistence
  // rejecting) takes priority over the other, more routine banner states --
  // it's the one case that means the app did NOT do what the driver asked.
  const banner =
    state.lastError !== null
      ? { variant: 'error' as const, message: state.lastError }
      : state.gnssQuality === 'unreliable' || state.gnssQuality === 'invalid'
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

        {/* Fixed-height slot (Phase 3 coaching addendum, S7): reserved ONLY while
            coaching is on, so the strip's own cue appearing/disappearing never
            shifts anything below it -- but toggling the SETTING itself does
            change layout, same as the banner slot above already does. */}
        {settings.coachingEnabled ? (
          <View style={styles.coachSlot}>
            <CoachStrip cue={state.coachCue} />
          </View>
        ) : null}

        {/* H1 fix (Telemetry addendum — P4b amendment, S7, binding
            SUPERSEDES the original "fixed slot" design): `TelemetryStrip`
            contributes ZERO normal-flow height -- no reserved row, no extra
            container gap -- unlike `coachSlot` above. It is instead an
            absolutely-positioned overlay pinned to the TOP of `deltaZone`
            (React Native Views default to `position: 'relative'`, so this
            positions relative to `deltaZone` with no style change needed
            here) -- `deltaZone`'s large dead space above the centered delta
            figure. `TelemetryStrip` itself renders `null` (no styled card,
            no border/background, no accessibility node) unless
            settings.telemetryEnabled AND the provider is 'polling' (M1 fix,
            `isTelemetryStripVisible`) -- so it is always mounted here,
            unconditionally, and never reflows or occludes `DeltaDisplay`'s
            own centering (the ONLY normal-flow child of `deltaZone` once the
            strip is removed from flow) or anything below it. When hidden,
            this is byte-identical to pre-P4b: no telemetry-related node in
            the tree at all. */}
        <View style={styles.deltaZone}>
          <TelemetryStrip />
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
            <Text style={styles.speedPlaceholder} maxFontSizeMultiplier={1.2}>
              {state.speedKph === null ? '-- km/h' : `${Math.round(state.speedKph)} km/h`}
            </Text>
          </View>
        </View>

        {/* Ticket P5c-B D3 (contracts.md R2-3b): the ONLY new control on the
            driving screen, and it is not shown at all unless the driver opted
            into trackday suggestions. Advice never appears while driving --
            this is a door to the between-stint view, so it is enabled only
            once the car is stopped (`inPit`/`paused`) and there is at least
            one completed lap to look at. */}
        {settings.suggestionsEnabled && state.laps.length > 0 ? (
          <Pressable
            style={[styles.pitButton, !stopped && styles.pitButtonDisabled]}
            onPress={() => navigation.navigate('PitView')}
            disabled={!stopped}
            accessibilityRole="button"
            accessibilityLabel={pitStrings.entryButtonA11y}
            accessibilityState={{ disabled: !stopped }}
          >
            <Text style={styles.pitButtonText} maxFontSizeMultiplier={1.2}>
              {pitStrings.entryButton}
            </Text>
          </Pressable>
        ) : null}

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
  coachSlot: { height: COACH_STRIP_HEIGHT },
  deltaZone: { flexGrow: 3, alignItems: 'center', justifyContent: 'center' },
  lapTimeZone: { alignItems: 'center', justifyContent: 'center' },
  lapTimeCaption: { ...typography.label, color: colors.textMuted, marginTop: spacing.xs, letterSpacing: 1 },
  bottomRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  bottomStat: { alignItems: 'flex-start' },
  bottomStatLabel: { ...typography.label, color: colors.textMuted, marginBottom: spacing.xs },
  speedPlaceholder: { ...typography.timeSmall, color: colors.textMuted },
  controlZone: { marginTop: spacing.sm },
  pitButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  pitButtonDisabled: { opacity: 0.4 },
  pitButtonText: { ...typography.label, color: colors.textSecondary, letterSpacing: 1 },
});
