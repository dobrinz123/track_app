import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  SimulatedEnetTransport,
  DEFAULT_ENET_DID_SCENARIO,
  SIGNAL_TARGET_CATALOGS,
  resolveSignalTargetCatalog,
  resolveSignalTargetCatalogLabel,
  resolveSignalTargetLabel,
  type ObdTransport,
  type SignalCandidateScore,
  type SignalTargetDefinition,
  type SignalTargetId,
} from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { getTelemetryReadDb, refreshVehicleProfileBindingsCache, settingsStore } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { EnetTcpTransport } from '../../session/enetTcpTransport';
import { createDidSweepStore, createVehicleProfileBindingStore, type VehicleProfileBinding } from '../../persistence/didSweepStore';
import { createSignalFinderController, type SignalFinderSnapshot } from '../../session/signalFinderController';
import { resolveSignalFinderScreenStrings, signalFinderErrorMessage, type SignalFinderScreenStrings } from './signalFinderStrings';
import {
  buildSignalFinderExportDocument,
  buildSignalFinderSummaryMarkdown,
  buildVehicleProfileDocument,
  shareSignalFinderExport,
  shareSignalFinderJson,
  shareVehicleProfileExport,
  signalFinderExportInputFromSnapshot,
  type SignalFinderExportDocument,
} from '../../session/signalFinderExport';

type Props = NativeStackScreenProps<RootStackParamList, 'SignalFinder'>;

/**
 * Signal Finder screen (ticket P4l S4; contracts.md "Signal Finder (Phase 4l,
 * 2026-08-29)", binding). The user's own words: "a tool that has targets:
 * find the brake → reads the channels we think carry the brake → tells me to
 * press the brake 5 times → shows the candidates that changed → brake found;
 * then the next missing signal."
 *
 * Reachable from Settings' developer section (same `isDev ||
 * developerModeEnabled` gating as DID Probe / DID Sweep); the ROUTE itself is
 * registered in every build, mirroring both of those.
 *
 * The screen owns NO logic: it supplies a `transportFactory` (never connects
 * or closes anything), renders `controller`'s own snapshot, and shows the
 * SAME summary text the shared `.md` carries (item 8: "the summary is what
 * the user forwards").
 */

const VERDICT_COLOR: Readonly<Record<SignalCandidateScore['verdict'], string>> = {
  found: colors.success,
  probable: colors.warning,
  unrelated: colors.textMuted,
  insufficient: colors.textMuted,
};

/**
 * P4m-FIX1 X8 (Codex P4m-REV1 finding 9): every visible string of this screen
 * — evidence, verdicts, statuses, engine text, banners, the next step, the
 * share controls and every accessibility label — comes from
 * `signalFinderStrings.ts`'s RO/EN table, and every NAME (targets, discovery
 * notes, metronome prompts) from the target catalog's own per-language data.
 * Nothing below writes prose of its own, in either language.
 */

function didHex(did: number): string {
  return `0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
}

function ecuHex(ecu: number): string {
  return `0x${ecu.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** P4l-FIX3 J6 (binding, Codex re-review finding L12): the SAME `netEdges`-first evidence line as the `.md`/JSON export (`signalFinderExport.ts`'s `evidenceCell`) — what the verdict was ACTUALLY computed from, plus the P4l-FIX2 extras/cap reason when present. */
function evidenceLine(score: SignalCandidateScore, strings: SignalFinderScreenStrings): string {
  const extraTransitions = score.extraTransitions ?? 0;
  const didBaselineChanges = score.didBaselineChanges ?? 0;
  const netEdges = Math.max(0, score.matchedEdges - extraTransitions);
  // P4m item 11: a sparse verdict rests on window AGREEMENT, so that is the
  // count shown for it (the transition count understates thin evidence).
  let line = strings.edges(score.sparse === true ? score.windowMatchedEdges ?? netEdges : netEdges, score.expectedEdges);
  if (extraTransitions > 0) line += ` ${strings.extra(extraTransitions)}`;
  if (didBaselineChanges > 0) line += `, ${strings.baselineMoved(didBaselineChanges)}`;
  if (score.verdictCapReason != null) line += `, ${strings.capped(strings.capReasons[score.verdictCapReason])}`;
  return line;
}

export function SignalFinderScreen(_props: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  const [snapshot, setSnapshot] = React.useState<SignalFinderSnapshot | null>(null);
  const [banner, setBanner] = React.useState<string | null>(null);
  const [sharing, setSharing] = React.useState(false);
  const [summary, setSummary] = React.useState<string | null>(null);
  const [bindings, setBindings] = React.useState<VehicleProfileBinding[]>([]);

  const sweepStoreRef = React.useRef(createDidSweepStore(getTelemetryReadDb()));
  const bindingStoreRef = React.useRef(createVehicleProfileBindingStore(getTelemetryReadDb()));
  // Which vehicle profile's targets this session works against. There is no
  // profile setting in `settingsStore` yet, so the choice is made HERE, from
  // the registry (data) -- defaulting to the hypothesis-free generic catalog
  // rather than assuming anybody's car. Session-local by design: nothing is
  // persisted until "Confirm as ..." writes a real binding.
  const [profileId, setProfileId] = React.useState('generic');
  const catalog = React.useMemo(() => resolveSignalTargetCatalog(profileId), [profileId]);

  // Read inside the controller factory, which is built once -- a later
  // profile change rebuilds the controller (below) rather than going stale.
  const profileIdRef = React.useRef(profileId);
  profileIdRef.current = profileId;

  const controllerRef = React.useRef<ReturnType<typeof createSignalFinderController> | null>(null);

  function ensureController(): ReturnType<typeof createSignalFinderController> {
    if (controllerRef.current !== null) return controllerRef.current;
    // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
    const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
    const controller = createSignalFinderController({
      transportFactory: (): ObdTransport => {
        const current = settingsRef.current;
        return current.telemetrySimulate && isDev
          ? new SimulatedEnetTransport({
              monotonicNow: () => Date.now(),
              scenario: DEFAULT_ENET_DID_SCENARIO,
              testerAddress: current.enetTesterAddress,
              targetAddress: current.enetTargetAddress,
            })
          : new EnetTcpTransport({ host: current.enetHost, port: current.enetPort });
      },
      testerAddress: settingsRef.current.enetTesterAddress,
      clock: { now: () => Date.now() },
      // M4 (binding): the metronome's prompts follow the app's language
      // setting, read at the moment each round builds its timeline.
      getLanguage: () => settingsRef.current.language,
      profileId: profileIdRef.current,
      catalog: resolveSignalTargetCatalog(profileIdRef.current),
      sweepStore: sweepStoreRef.current,
      bindingStore: bindingStoreRef.current,
    });
    controllerRef.current = controller;
    controller.subscribe(setSnapshot);
    return controller;
  }

  React.useEffect(() => {
    // A profile change swaps the whole catalog, so the controller (which
    // resolved its targets from the OLD one) is torn down and rebuilt rather
    // than left resolving against a catalog the screen no longer shows.
    void controllerRef.current?.stop().catch(() => undefined);
    controllerRef.current = null;
    setSnapshot(null);
    setSummary(null);
    ensureController();
    void bindingStoreRef.current.listBindings(profileId).then(setBindings);
    void refreshEligibility();
    // (No `react-hooks/exhaustive-deps` suppression here: this project's flat
    // eslint config does not wire `eslint-plugin-react-hooks`, and referencing
    // an unknown rule is itself a lint ERROR -- the F8 fix `DidSweepScreen.tsx`
    // already documents. `ensureController` is a ref-memoized factory,
    // deliberately not part of this effect's dependency list.)
  }, [profileId]);

  React.useEffect(
    () => () => {
      // Unmount: stop() closes the transport and releases the reservation on
      // every path (idempotent when already idle). A React cleanup cannot be
      // async, so this is deliberately fire-and-forget WITH a catch.
      void controllerRef.current?.stop().catch(() => undefined);
    },
    [],
  );

  const busy = snapshot !== null && (snapshot.phase === 'preparing' || snapshot.phase === 'reading' || snapshot.phase === 'scoring');
  const strings = resolveSignalFinderScreenStrings(settings.language);
  /**
   * X9 (binding, Codex P4m-REV1 finding 10): how many DIDs a find for each
   * target could read at all. A target with 0 has its Find button DISABLED
   * with the reason on the row — "one script per find" is a promise about
   * what a tap does, and a tap that performs no script at all breaks it.
   * Refreshed whenever the profile changes or a round finishes (a sweep run
   * or a confirmed binding can make a target eligible).
   */
  const [eligible, setEligible] = React.useState<Partial<Record<SignalTargetId, number>>>({});
  const refreshEligibility = React.useCallback(async (): Promise<void> => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const counts: Partial<Record<SignalTargetId, number>> = {};
    for (const target of catalog.targets) counts[target.id] = await controller.eligibleDidCount(target.id);
    setEligible(counts);
  }, [catalog]);
  /** The target the RESULT section is about, in the app's language (the label the catalog carries is the English/export one). */
  const resultTargetLabel =
    snapshot?.targetId == null
      ? ''
      : resolveSignalTargetLabel(
          catalog.targets.find((target) => target.id === snapshot.targetId) ?? {
            label: snapshot.targetLabel ?? '',
          } as SignalTargetDefinition,
          settings.language,
        );
  /** What one more script would cost the driver: how many DIDs it reads, and how long it takes. */
  const nextRoundDidCount = snapshot === null ? 0 : Math.min(snapshot.budget, snapshot.notReadCount);
  const nextRoundSeconds = snapshot?.timeline == null ? 0 : Math.round(snapshot.timeline.pollDurationMs / 1_000);

  /**
   * P4l-FIX3 J2 (binding, after Codex P4l-REV1 M7/MEDIUM: "the on-screen
   * summary is built from a stale React snapshot"): reads `controller`'s
   * CURRENT `getSnapshot()`, never the `snapshot` REACT STATE variable --
   * that state is whatever the render that STARTED a `find()` closed over,
   * so a `buildDocument()` reading it after `await find()` resolves could
   * mix a previous run's confirmed state into the JUST-finished run's
   * export. `signalFinderExportInputFromSnapshot` is the pure bridge (unit
   * tested directly in `signalFinderExport.test.ts` -- no
   * `@testing-library/react-native` in this repo to render-test the
   * component itself).
   */
  function buildDocument(): SignalFinderExportDocument | null {
    const controller = controllerRef.current;
    if (controller === null) return null;
    const input = signalFinderExportInputFromSnapshot(controller.getSnapshot(), controller.getSamples(), bindings, new Date().toISOString());
    return input === null ? null : buildSignalFinderExportDocument(input);
  }

  async function handleFind(target: SignalTargetDefinition): Promise<void> {
    setBanner(null);
    setSummary(null);
    await ensureController().find(target.id);
    const doc = buildDocument();
    if (doc !== null) setSummary(buildSignalFinderSummaryMarkdown(doc, settings.language));
    void refreshEligibility();
  }

  /**
   * P4m item 10 (binding): "each round is one more full script" — and only on
   * this explicit tap. The controller reads the NEXT budget slice of what is
   * still unread; nothing is ever re-read.
   */
  async function handleNextRound(): Promise<void> {
    setBanner(null);
    setSummary(null);
    await ensureController().nextRound();
    const doc = buildDocument();
    if (doc !== null) setSummary(buildSignalFinderSummaryMarkdown(doc, settings.language));
  }

  async function handleConfirm(score: SignalCandidateScore): Promise<void> {
    const controller = controllerRef.current;
    if (controller === null || snapshot === null || snapshot.targetId === null) return;
    const written = await controller.confirmBinding(snapshot.targetId, score);
    setBanner(
      written === null
        ? strings.bannerNoProfileStorage
        : strings.bannerConfirmed(written.channel, ecuHex(written.ecu), didHex(written.did)),
    );
    setBindings(await bindingStoreRef.current.listBindings(profileId));
    // P4l-FIX3 J5 (binding): a confirmed channel must reach live telemetry
    // without the user restarting the app -- refreshes composition.ts's own
    // cached snapshot so the NEXT `telemetryProvider.start()` picks it up.
    if (written !== null) void refreshVehicleProfileBindingsCache();
  }

  async function handleShare(kind: 'summary' | 'json'): Promise<void> {
    const doc = buildDocument();
    if (doc === null) {
      setBanner(strings.bannerRunFindFirst);
      return;
    }
    setSharing(true);
    try {
      const result = kind === 'summary' ? await shareSignalFinderExport(doc, settings.language) : await shareSignalFinderJson(doc);
      // P4m-FIX2 Y7: a share error is a RAW platform string -- shown inside a
      // localized line, never as the whole banner.
      setBanner(
        result.shared
          ? kind === 'summary'
            ? strings.bannerSummaryShared
            : strings.bannerJsonShared
          : result.error === undefined
            ? strings.bannerSharingUnavailable
            : strings.bannerShareFailed(result.error),
      );
    } finally {
      setSharing(false);
    }
  }

  /**
   * P4l-FIX3 J4 (binding): "Share profile" — the whole car's accumulated
   * confirmed bindings (not tied to any one find session), merged into the
   * canonical vehicle-profile shape. Independent of `busy`/`phase === 'result'`
   * on purpose: a profile can be shared any time bindings already exist, even
   * before this screen's very first find in the current app run.
   */
  async function handleShareProfile(): Promise<void> {
    setSharing(true);
    try {
      const doc = buildVehicleProfileDocument(profileId, bindings, new Date().toISOString());
      const result = await shareVehicleProfileExport(doc);
      setBanner(
        result.shared
          ? strings.bannerProfileShared
          : result.error === undefined
            ? strings.bannerSharingUnavailable
            : strings.bannerShareFailed(result.error),
      );
    } finally {
      setSharing(false);
    }
  }

  const targetStatus = (target: SignalTargetDefinition): string => {
    if (bindings.some((binding) => binding.channel === target.id)) return strings.statusConfirmed;
    if (snapshot?.targetId === target.id && snapshot.phase === 'result') {
      return snapshot.scores.some((score) => score.verdict === 'found') ? strings.statusFound : strings.statusMissing;
    }
    // X9 (binding): a target with nothing to read says so HERE, and its Find
    // button is disabled -- "one script per find" must not mean "a find that
    // performs no script at all".
    if (eligible[target.id] === 0) return strings.nothingToRead;
    return target.hypotheses.length > 0 ? strings.statusHypotheses(target.hypotheses.length) : strings.statusNoHypotheses;
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>{strings.screenTitle}</Text>
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{strings.vehicleProfile}</Text>
          <View style={styles.chipRow}>
            {SIGNAL_TARGET_CATALOGS.map((entry) => (
              <Pressable
                key={entry.profileId}
                style={[styles.chip, entry.profileId === profileId ? styles.chipActive : null]}
                disabled={busy}
                onPress={() => setProfileId(entry.profileId)}
                accessibilityRole="button"
                accessibilityLabel={strings.useProfile(resolveSignalTargetCatalogLabel(entry, settings.language))}
              >
                {/* P4m-FIX2 Y7: a PROFILE NAME is catalog data, so it is
                    resolved per language like every target name -- the chips
                    were the last English left on an RO screen. */}
                <Text style={entry.profileId === profileId ? styles.chipTextActive : styles.chipText}>
                  {resolveSignalTargetCatalogLabel(entry, settings.language)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.caption}>
            {resolveSignalTargetCatalogLabel(catalog, settings.language)} ({catalog.profileId})
          </Text>
          <Pressable
            style={[styles.secondaryButton, sharing || bindings.length === 0 ? styles.buttonDisabled : null]}
            disabled={sharing || bindings.length === 0}
            onPress={() => void handleShareProfile()}
            accessibilityRole="button"
            accessibilityLabel={strings.shareProfileA11y}
          >
            <Text style={styles.secondaryButtonText}>{strings.shareProfile}</Text>
          </Pressable>
        </View>

        {banner !== null ? <Text style={styles.banner}>{banner}</Text> : null}

        {/* Metronome -- the whole point of the screen while a find is running. */}
        {snapshot !== null && snapshot.step !== null ? (
          <View style={styles.metronome}>
            <Text style={styles.metronomePrompt} maxFontSizeMultiplier={1.2}>
              {snapshot.step.prompt}
            </Text>
            <Text style={styles.metronomeCountdown}>{(snapshot.step.countdownMs / 1000).toFixed(1)}s</Text>
            {/* P4m M4: ONE script per find -- there is no "pass N/total" any
                more, because there are no passes. The ECUs of this round are
                all read inside this single script. */}
            <Text style={styles.caption}>
              {strings.stepCounter(snapshot.step.index + 1, snapshot.step.total)}
              {snapshot.ecus.length > 0 ? ` · ${snapshot.ecus.map(ecuHex).join(', ')}` : ''}
            </Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{strings.targets}</Text>
          {catalog.targets.map((target) => (
            <View key={target.id} style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{resolveSignalTargetLabel(target, settings.language)}</Text>
                <Text style={styles.caption}>
                  {target.engineRequirement === 'running' ? strings.engineRunningHint : strings.engineOffHint} ·{' '}
                  {targetStatus(target)}
                </Text>
              </View>
              <Pressable
                style={[styles.button, busy || eligible[target.id] === 0 ? styles.buttonDisabled : null]}
                disabled={busy || eligible[target.id] === 0}
                onPress={() => void handleFind(target)}
                accessibilityRole="button"
                accessibilityLabel={strings.findA11y(resolveSignalTargetLabel(target, settings.language))}
              >
                <Text style={styles.buttonText}>{strings.find}</Text>
              </Pressable>
            </View>
          ))}
        </View>

        {busy ? (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => void controllerRef.current?.stop()}
            accessibilityRole="button"
            accessibilityLabel={strings.stopA11y}
          >
            <Text style={styles.secondaryButtonText}>{strings.stop}</Text>
          </Pressable>
        ) : null}

        {/* P4m-FIX2 Y7: the controller's raw message never reaches the driver —
            its CODE selects a localized line, with the raw text in parentheses
            when nothing more specific is known. */}
        {snapshot !== null && snapshot.error !== null ? (
          <Text style={styles.error}>{signalFinderErrorMessage(snapshot, strings)}</Text>
        ) : null}

        {snapshot !== null && snapshot.phase === 'result' ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{strings.result}</Text>
            {/* P4m M3/M4 (binding): "Read N DIDs across E ECUs in R round(s)"
                -- what the DRIVER actually did, never a pass count. */}
            <Text style={styles.caption}>
              {strings.readSummary(
                snapshot.passes.reduce((total, pass) => total + pass.dids.length, 0),
                snapshot.passes.length,
                snapshot.round,
              )}
              {snapshot.passes.length > 0 ? ` (${snapshot.passes.map((pass) => ecuHex(pass.ecu)).join(', ')})` : ''} ·{' '}
              {snapshot.engineRequirement === 'running' ? strings.engineRunning : strings.engineOff} ·{' '}
              {/* X1 (binding): the header says whether the rate the budget rests on was MEASURED or assumed. */}
              {snapshot.rateSource === 'measured'
                ? strings.rateMeasured(snapshot.measuredReqPerSec)
                : strings.rateAssumed(snapshot.measuredReqPerSec)}
            </Text>
            {snapshot.scores.length === 0 ? <Text style={styles.caption}>{strings.nothingAnswered}</Text> : null}
            {snapshot.scores.slice(0, 20).map((score) => (
              <View key={`${score.ecu}-${score.did}-${score.byteOffset ?? 'n'}`} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.mono}>
                    {didHex(score.did)}
                    {score.byteOffset === null ? '' : ` b${score.byteOffset}`} · {ecuHex(score.ecu)}
                  </Text>
                  <Text style={styles.caption}>
                    {evidenceLine(score, strings)} ·{' '}
                    {strings.rawRange(score.restValueHex ?? '-', String(score.min ?? '-'), String(score.max ?? '-'))}
                    {score.insufficientReason === null ? '' : ` · ${strings.insufficientReasons[score.insufficientReason]}`}
                  </Text>
                </View>
                <View style={styles.verdictColumn}>
                  {/* P4m item 11: sparse-but-consistent evidence says so. */}
                  <Text style={[styles.verdict, { color: VERDICT_COLOR[score.verdict] }]}>
                    {strings.verdicts[score.verdict]}
                    {score.sparse === true ? strings.sparseSuffix : ''}
                  </Text>
                  {score.verdict === 'found' || score.verdict === 'probable' ? (
                    <Pressable
                      style={styles.button}
                      onPress={() => void handleConfirm(score)}
                      accessibilityRole="button"
                      accessibilityLabel={strings.confirmA11y(didHex(score.did), resultTargetLabel)}
                    >
                      <Text style={styles.buttonText}>{strings.confirmAs(resultTargetLabel)}</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ))}

            {snapshot.noResponseDids.length > 0 ? (
              <Text style={styles.caption}>
                {strings.noResponse}:{' '}
                {snapshot.noResponseDids.map((entry) => `${didHex(entry.did)} (${ecuHex(entry.ecu)})`).join(', ')}
              </Text>
            ) : null}

            {/* P4m items 10/12 (binding): what was NOT read is stated with its
                count and a button for one more script -- never silently
                dropped, and never mixed into "No response". */}
            {/* X2 (binding): a silent ECU's DIDs are listed with THAT reason,
                never as "no response" and never as work a Next round could do. */}
            {snapshot.silentDids.length > 0 ? (
              <Text style={styles.caption}>
                {strings.notReadSilent(snapshot.silentDids.length, snapshot.silentEcus.map(ecuHex).join(', '))}
              </Text>
            ) : null}

            {snapshot.notReadCount > 0 ? (
              <View style={styles.shareRow}>
                <Text style={styles.caption}>{strings.notRead(snapshot.notReadCount)}</Text>
                <Pressable
                  style={[styles.button, busy ? styles.buttonDisabled : null]}
                  disabled={busy}
                  onPress={() => void handleNextRound()}
                  accessibilityRole="button"
                  accessibilityLabel={strings.nextRound(nextRoundDidCount, nextRoundSeconds)}
                >
                  <Text style={styles.buttonText}>{strings.nextRound(nextRoundDidCount, nextRoundSeconds)}</Text>
                </Pressable>
              </View>
            ) : null}

            {snapshot.nextStep !== null ? (
              <Text style={styles.nextStep}>
                {strings.nextStep(
                  `${didHex(snapshot.nextStep.fromDid)}–${didHex(snapshot.nextStep.toDid)}`,
                  snapshot.nextStep.ecu === null ? strings.everyEcuThatAnswered : ecuHex(snapshot.nextStep.ecu),
                  Math.max(1, Math.round(snapshot.nextStep.estimatedMinutes)),
                  snapshot.nextStep.engineRequirement === 'running' ? strings.engineRunning : strings.engineOff,
                  snapshot.nextStep.note,
                )}
              </Text>
            ) : null}

            <View style={styles.shareRow}>
              <Pressable
                style={[styles.button, sharing ? styles.buttonDisabled : null]}
                disabled={sharing}
                onPress={() => void handleShare('summary')}
                accessibilityRole="button"
                accessibilityLabel={strings.shareA11y}
              >
                <Text style={styles.buttonText}>{strings.share}</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, sharing ? styles.buttonDisabled : null]}
                disabled={sharing}
                onPress={() => void handleShare('json')}
                accessibilityRole="button"
                accessibilityLabel={strings.shareJsonA11y}
              >
                <Text style={styles.secondaryButtonText}>{strings.shareJson}</Text>
              </Pressable>
            </View>

            {summary !== null ? (
              <View style={styles.summaryBox}>
                <Text style={styles.sectionLabel}>{strings.summaryHeading}</Text>
                <Text selectable style={styles.summaryText}>
                  {summary}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  caption: { ...typography.caption, color: colors.textSecondary },
  section: { gap: spacing.sm },
  sectionLabel: { ...typography.label, color: colors.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { ...typography.subtitle, color: colors.textPrimary },
  verdictColumn: { alignItems: 'flex-end', gap: spacing.xs },
  verdict: { ...typography.label },
  mono: { fontFamily: fontFamily.monoMedium, fontSize: 14, color: colors.textPrimary },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { ...typography.label, color: colors.onAccent },
  secondaryButton: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  secondaryButtonText: { ...typography.label, color: colors.textPrimary },
  metronome: {
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  metronomePrompt: { ...typography.title, color: colors.accent, textAlign: 'center' },
  metronomeCountdown: { ...typography.timeLarge, color: colors.textPrimary },
  banner: { ...typography.caption, color: colors.accent },
  error: { ...typography.caption, color: colors.danger },
  nextStep: { ...typography.caption, color: colors.warning },
  shareRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  summaryBox: {
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  summaryText: { fontFamily: fontFamily.monoRegular, fontSize: 11, color: colors.textSecondary },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  chipText: { ...typography.caption, color: colors.textSecondary },
  chipTextActive: { ...typography.caption, color: colors.accent },
});
