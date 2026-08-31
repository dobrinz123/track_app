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
  type SignalEngineRequirement,
  type SignalTargetDefinition,
  type SignalTargetId,
} from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import {
  dismissVinAutoDetectNotice,
  getTelemetryReadDb,
  maybeDetectVehicleFromVin,
  refreshVehicleProfileBindingsCache,
  setActiveVehicleProfileIdExplicit,
  settingsStore,
  subscribeVinAutoDetectNotice,
  telemetryProvider,
  type VinAutoDetectNotice,
} from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { EnetTcpTransport } from '../../session/enetTcpTransport';
import {
  createDidSweepStore,
  createSignalFinderRuledOutStore,
  createVehicleProfileBindingStore,
  type VehicleProfileBinding,
} from '../../persistence/didSweepStore';
import {
  createSignalFinderController,
  discoverySweepParamsForTarget,
  finderEngineWarning,
  formatDidRange,
  type SignalFinderSnapshot,
} from '../../session/signalFinderController';
import { shouldShowBrakeBindingRestartHint } from '../../session/telemetryProvider';
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

/**
 * Ticket P4o-FIX3 T1 (binding, Codex P4o-REV3 finding 6, HIGH): "found
 * (graded)" for strong evidence, "found (graded — weak evidence: ...)" for
 * weak — appended only to a `found` verdict, and only for a series that IS
 * graded (`gradedEvidence` is `null` for boolean/flag and for `two-level`).
 * `confirm` stays enabled either way; this is a disclosure, not a cap.
 */
function gradedSuffixFor(score: SignalCandidateScore, strings: SignalFinderScreenStrings): string {
  if (score.verdict !== 'found' || score.gradedEvidence == null) return '';
  return score.gradedEvidence === 'strong' ? strings.gradedSuffix : strings.gradedWeakSuffix;
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

export function SignalFinderScreen(props: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  const [snapshot, setSnapshot] = React.useState<SignalFinderSnapshot | null>(null);
  const [banner, setBanner] = React.useState<string | null>(null);
  const [sharing, setSharing] = React.useState(false);
  const [summary, setSummary] = React.useState<string | null>(null);
  const [bindings, setBindings] = React.useState<VehicleProfileBinding[]>([]);
  /**
   * Ticket P4o O5 (binding): the soft engine check needs the app's own most
   * recent rpm reading, whatever telemetry (if any) happens to be live —
   * `null` until the FIRST sample this screen ever sees, which
   * `engineNotDetectedRunning` already reads as "not detected running".
   * Never touches `telemetryProvider.ts` itself: this is a plain
   * `onSample` subscriber, same discipline as the Telemetry monitor's own.
   *
   * Ticket P4o-FIX1 V3 (binding, Codex P4o-REV1 finding 4, MEDIUM): "accept
   * RPM only while telemetry is active and the sample is fresh". Two
   * changes over O5's own version:
   *
   *  - `tMonoMs` is retained (the sample's own monotonic stamp), so the
   *    predicate can judge its AGE rather than trust it forever;
   *  - the reading is cleared the moment telemetry stops being an ACTIVE
   *    session (`onStateChange` -> anything other than `'polling'`), so a
   *    stopped/failed session reads as "no sample" immediately rather than
   *    waiting out the 5 s staleness window on a value that can no longer
   *    arrive a fresher one to replace it.
   */
  const [lastRpmSample, setLastRpmSample] = React.useState<{ rpm: number | null; tMonoMs: number } | null>(null);
  const telemetryActiveRef = React.useRef(telemetryProvider.getDiagnostics().state === 'polling');
  React.useEffect(() => {
    const unsubscribeState = telemetryProvider.onStateChange((state) => {
      telemetryActiveRef.current = state === 'polling';
      if (state !== 'polling') setLastRpmSample(null);
    });
    const unsubscribeSample = telemetryProvider.onSample((sample) => {
      if (sample.channel === 'rpm' && telemetryActiveRef.current) {
        setLastRpmSample({ rpm: sample.value, tMonoMs: sample.tMonoMs });
      }
    });
    return () => {
      unsubscribeState();
      unsubscribeSample();
    };
  }, []);
  /**
   * Ticket P4o-FIX2 U2 (binding, Codex P4o-REV2 finding 3, PARTIAL): `rpm`'s
   * AGE moves on its own, with no new sample and no controller snapshot to
   * trigger a re-render -- so a fresh rpm reading kept suppressing
   * `engineWarning` long after it crossed `ENGINE_SAMPLE_MAX_AGE_MS` and
   * telemetry had actually gone quiet, with the screen stuck rendering
   * whatever `performance.now()` happened to read at the LAST unrelated
   * render. `engineNotDetectedRunning` is a pure function of `lastRpmSample`
   * and the current instant (targets.test.ts's own `NOW`/`sampleAge` cases
   * already prove IT ages correctly); the missing piece was purely this
   * screen never asking it again. Re-render on a 1 s ticker -- same
   * discipline as `PreflightScreen.tsx`'s own staleness ticker and
   * `TelemetryScreen.tsx`'s G-force one -- so `engineWarning` is actually
   * RE-EVALUATED as time passes rather than only on the next unrelated state
   * change.
   */
  const [, forceEngineWarningTick] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => forceEngineWarningTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  /**
   * P4o O5: armed replace tracking lives on the CONTROLLER (testable without
   * rendering) — this is just a render helper.
   *
   * Ticket P4p G2 (binding, field test 9 BUG-B): the FINDER's own rpm reading
   * (taken at probe time, over the adapter this screen holds) decides first;
   * the telemetry sample below it is a bonus that only applies while the
   * finder has read nothing itself. Telemetry is stopped for the whole time a
   * find runs (one adapter reservation), which is exactly why the old
   * telemetry-only check could never clear.
   */
  const engineWarning = (engineRequirement: SignalEngineRequirement): boolean =>
    finderEngineWarning({
      engineRequirement,
      engineRunning: snapshot?.engineRunning ?? null,
      recentSample: lastRpmSample,
      // V3: the SAME monotonic clock basis `TelemetrySample.tMonoMs` is stamped
      // from (`platform/clock.ts`'s `PerformanceNowClock`) — never `Date.now()`.
      nowMs: performance.now(),
    });

  const sweepStoreRef = React.useRef(createDidSweepStore(getTelemetryReadDb()));
  const bindingStoreRef = React.useRef(createVehicleProfileBindingStore(getTelemetryReadDb()));
  /** Ticket P4p G5: where a completed find records the DIDs it ruled out, and where every later plan reads them from. */
  const ruledOutStoreRef = React.useRef(createSignalFinderRuledOutStore(getTelemetryReadDb()));
  // Ticket P4p G1 (binding, field test 9 BUG-A): which vehicle profile this
  // screen -- and the whole app -- works against is a PERSISTED setting now,
  // not this screen's own React state. The chip below SETS it, and
  // `composition.ts`'s binding cache (what the telemetry monitor polls) reads
  // the same value, so a channel confirmed here can never again be confirmed
  // "under" one profile while the monitor polls another's stale binding.
  const profileId = settings.activeVehicleProfileId;
  const setProfileId = (nextProfileId: string): void => {
    // Ticket P4q (binding): an explicit chip tap goes through the ONE place
    // that also marks "the user chose this app run" -- auto-select must
    // never later override it.
    setActiveVehicleProfileIdExplicit(nextProfileId);
  };
  const catalog = React.useMemo(() => resolveSignalTargetCatalog(profileId), [profileId]);

  /**
   * Ticket P4q (binding): "VIN: <value>" once known, and the dismissible
   * "Detected from VIN — <label>" banner auto-select raises. The one-shot
   * read itself is triggered here too ("when the Signal Finder screen
   * opens") -- `maybeDetectVehicleFromVin` is idempotent per app run and
   * never blocks/steals the adapter (see its own doc comment).
   */
  const [vinNotice, setVinNotice] = React.useState<VinAutoDetectNotice | null>(null);
  React.useEffect(() => {
    const unsubscribe = subscribeVinAutoDetectNotice(setVinNotice);
    void maybeDetectVehicleFromVin();
    return unsubscribe;
  }, []);
  const vinNoticeProfileLabel =
    vinNotice === null ? '' : resolveSignalTargetCatalogLabel(resolveSignalTargetCatalog(vinNotice.profileId), settings.language);

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
      ruledOutStore: ruledOutStoreRef.current,
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
    // Ticket P4p G1: the profile the provider polls changed with the chip --
    // the cached bindings composition.ts hands `telemetryProvider` follow it.
    void refreshVehicleProfileBindingsCache();
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

  const busy =
    snapshot !== null &&
    (snapshot.phase === 'preparing' ||
      snapshot.phase === 'probing' ||
      snapshot.phase === 'running' ||
      snapshot.phase === 'scoring');
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
  /** Ticket P4p G5: how many DIDs earlier completed finds ruled out, per target -- the row's own count line and its reset control. */
  const [ruledOut, setRuledOut] = React.useState<Partial<Record<SignalTargetId, number>>>({});
  const refreshEligibility = React.useCallback(async (): Promise<void> => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const counts: Partial<Record<SignalTargetId, number>> = {};
    const ruledOutCounts: Partial<Record<SignalTargetId, number>> = {};
    for (const target of catalog.targets) {
      counts[target.id] = await controller.eligibleDidCount(target.id);
      ruledOutCounts[target.id] = await controller.ruledOutDidCount(target.id);
    }
    setEligible(counts);
    setRuledOut(ruledOutCounts);
  }, [catalog]);

  /**
   * Ticket P4p G3 (binding): coming BACK from the DID sweep the scan button
   * opened, the row that sent the driver there must show what the sweep found
   * (its responders are the finder's cached pool) instead of the same
   * "nothing to read yet" it showed before.
   */
  React.useEffect(() => props.navigation.addListener('focus', () => void refreshEligibility()), [props.navigation, refreshEligibility]);

  /** Ticket P4p G5: the "Re-test all" control -- one target's exclusions, cleared, and the row recounted. */
  async function handleRetestAll(targetId: SignalTargetId): Promise<void> {
    await controllerRef.current?.clearRuledOut(targetId);
    await refreshEligibility();
  }

  /**
   * Ticket P4p G3 (binding): the params the DID sweep screen is opened with --
   * the target's own first unswept discovery range, sized from the rate this
   * session measured (or the assumed one, before any probe).
   */
  function scanParamsFor(target: SignalTargetDefinition): ReturnType<typeof discoverySweepParamsForTarget> {
    return discoverySweepParamsForTarget(target, snapshot?.measuredReqPerSec ?? 12);
  }
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
    // P4l-FIX3 J5 (binding): a confirmed channel must reach live telemetry
    // without the user restarting the app -- refreshes composition.ts's own
    // cached snapshot so the NEXT `telemetryProvider.start()` picks it up.
    //
    // Ticket P4n-FIX1 Q3 (binding, Codex P4n-REV1 LOW): AWAITED (not
    // fire-and-forget) before the restart-hint check below -- the hint must
    // read what THIS confirm just wrote, not whatever the cache held before
    // it. `shouldShowBrakeBindingRestartHint` is the SAME rule the Telemetry
    // monitor uses: ENET only, and only when the confirm actually changed the
    // ACTIVE poll plan's signature -- never for ELM327, an identical
    // reconfirmation, or a channel that was never polled to begin with.
    if (written !== null) await refreshVehicleProfileBindingsCache();
    const showRestartHint = written !== null && shouldShowBrakeBindingRestartHint(telemetryProvider.getDiagnostics());
    // Ticket P4o O3: a `null` result is EITHER "no profile storage on this
    // platform" OR "this tap just ARMED a replace, waiting for the second
    // one" -- the controller's own `pendingReplace` (not a guess from the
    // score) tells them apart. An armed row already shows its own inline
    // evidence line, so no banner is needed for it.
    const armed = controller.getSnapshot().pendingReplace !== null;
    setBanner(
      written === null
        ? armed
          ? null
          : strings.bannerNoProfileStorage
        : showRestartHint
          ? `${strings.bannerConfirmed(written.channel, ecuHex(written.ecu), didHex(written.did))} ${strings.bannerConfirmedRestartHint}`
          : strings.bannerConfirmed(written.channel, ecuHex(written.ecu), didHex(written.did)),
    );
    setBindings(await bindingStoreRef.current.listBindings(profileId));
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
            : strings.bannerShareFailed,
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
            : strings.bannerShareFailed,
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
          {/* Ticket P4q (binding): "VIN: <value>" once the one-shot ENET read
              has found one -- persisted, so it still shows on a later app
              run even before that run has read one itself. */}
          {settings.lastSeenVin !== null ? <Text style={styles.caption}>{strings.vinLabel(settings.lastSeenVin)}</Text> : null}
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

        {/* Ticket P4q (binding): "exactly ONE profile matches -> auto-select
            ... with a dismissible banner". The chip above still overrides --
            dismissing this only clears the notice, never the selection. */}
        {vinNotice !== null ? (
          <View style={styles.shareRow}>
            <Text style={styles.banner}>{strings.vinDetectedBanner(vinNoticeProfileLabel)}</Text>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => dismissVinAutoDetectNotice()}
              accessibilityRole="button"
              accessibilityLabel={strings.vinDetectedDismissA11y}
            >
              <Text style={styles.secondaryButtonText}>×</Text>
            </Pressable>
          </View>
        ) : null}

        {/* P4m-FIX3 Z6: the adapter never confirmed its own shutdown -- the next
            find waits for it, and the driver is told rather than left wondering
            why Find does nothing. */}
        {snapshot?.adapterTeardownPending === true ? (
          <Text style={styles.banner}>{strings.warningTeardownPending}</Text>
        ) : null}

        {/* P4m-FIX3 Z5: the pre-script probe counts itself out, with the bound
            it cannot exceed (entries x the per-DID timeout) -- build 8 spent
            those seconds on a screen that looked frozen. */}
        {snapshot?.probeProgress != null ? (
          <Text style={styles.caption}>
            {strings.probing(
              snapshot.probeProgress.probed,
              snapshot.probeProgress.total,
              Math.max(1, Math.ceil(snapshot.probeProgress.boundMs / 1_000)),
            )}
          </Text>
        ) : null}

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
                {/* P4o O5 (binding): a SOFT warning on the Find row itself — never a
                    hard block, since this app has no tachometer reading of its own
                    beyond whatever telemetry happens to be live. */}
                {engineWarning(target.engineRequirement) ? (
                  <Text style={styles.warningInline}>{strings.warningEngineNotDetected}</Text>
                ) : null}
                {/* Ticket P4p G5 (binding, the user's own request after field
                    test 9): what earlier finds already ruled out for THIS
                    target, with the one control that puts it all back. */}
                {(ruledOut[target.id] ?? 0) > 0 ? (
                  <View style={styles.shareRow}>
                    <Text style={styles.caption}>{strings.ruledOut(ruledOut[target.id] ?? 0)}</Text>
                    <Pressable
                      style={[styles.secondaryButton, busy ? styles.buttonDisabled : null]}
                      disabled={busy}
                      onPress={() => void handleRetestAll(target.id)}
                      accessibilityRole="button"
                      accessibilityLabel={strings.retestAllA11y(resolveSignalTargetLabel(target, settings.language))}
                    >
                      <Text style={styles.secondaryButtonText}>{strings.retestAll}</Text>
                    </Pressable>
                  </View>
                ) : null}
                {/* Ticket P4p G3 (binding, field test 9): a target with
                    nothing left to read is a DEAD END unless the driver is
                    handed the one action that changes that -- the sweep of
                    its own unswept discovery range, engine off, with the
                    range already filled in. */}
                {eligible[target.id] === 0 && scanParamsFor(target) !== null ? (
                  <Pressable
                    style={[styles.secondaryButton, busy ? styles.buttonDisabled : null]}
                    disabled={busy}
                    onPress={() => {
                      const params = scanParamsFor(target);
                      if (params === null) return;
                      props.navigation.navigate('DidSweep', {
                        fromDid: params.fromDid,
                        toDid: params.toDid,
                        ...(params.ecu === null ? {} : { ecu: params.ecu }),
                      });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={strings.scanRangeA11y(
                      scanParamsFor(target)?.ecu == null
                        ? strings.everyEcuThatAnswered
                        : ecuHex(scanParamsFor(target)?.ecu ?? 0),
                      formatDidRange(scanParamsFor(target)?.fromDid ?? 0, scanParamsFor(target)?.toDid ?? 0),
                    )}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {strings.scanRange(
                        scanParamsFor(target)?.ecu == null
                          ? strings.everyEcuThatAnswered
                          : ecuHex(scanParamsFor(target)?.ecu ?? 0),
                        formatDidRange(scanParamsFor(target)?.fromDid ?? 0, scanParamsFor(target)?.toDid ?? 0),
                        Math.max(1, Math.round(scanParamsFor(target)?.estimatedMinutes ?? 0)),
                      )}
                    </Text>
                  </Pressable>
                ) : null}
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
            {/* P4o O5 (binding): the result HEADER's own soft warning. */}
            {snapshot.engineRequirement !== null && engineWarning(snapshot.engineRequirement) ? (
              <Text style={styles.warningInline}>{strings.warningEngineNotDetected}</Text>
            ) : null}
            {snapshot.scores.length === 0 ? <Text style={styles.caption}>{strings.nothingAnswered}</Text> : null}
            {snapshot.scores.slice(0, 20).map((score) => {
              /**
               * Ticket P4o O3 (binding): the existing binding for THIS
               * target/channel, read from the same `bindings` state the
               * screen already loads — no need to ask the controller before
               * the driver has tapped anything.
               */
              const existingBinding = bindings.find((b) => b.channel === snapshot.targetId);
              const isReplaceRow =
                existingBinding !== undefined &&
                existingBinding.status === 'field-confirmed' &&
                (existingBinding.ecu !== score.ecu || existingBinding.did !== score.did);
              const isArmedForThisRow =
                snapshot.pendingReplace !== null &&
                snapshot.pendingReplace.channel === snapshot.targetId &&
                snapshot.pendingReplace.ecu === score.ecu &&
                snapshot.pendingReplace.did === score.did &&
                snapshot.pendingReplace.byteOffset === score.byteOffset;
              // P4o O2 (binding): "Confirm as <analog target>" is disabled
              // for a row capped at `probable` for being switch-like, not
              // analog — never a silent no-op, the row's own evidence line
              // already says "capped: switch-like, not analog".
              const confirmDisabled = score.verdictCapReason === 'two-level';
              return (
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
                    {isArmedForThisRow && existingBinding !== undefined ? (
                      <Text style={styles.caption}>
                        {strings.replaceArmed}{' '}
                        {strings.replaceExistingEvidence(
                          ecuHex(existingBinding.ecu),
                          didHex(existingBinding.did),
                          existingBinding.decode,
                        )}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.verdictColumn}>
                    {/* P4m item 11: sparse-but-consistent evidence says so. */}
                    <Text style={[styles.verdict, { color: VERDICT_COLOR[score.verdict] }]}>
                      {strings.verdicts[score.verdict]}
                      {score.sparse === true ? strings.sparseSuffix : ''}
                      {gradedSuffixFor(score, strings)}
                    </Text>
                    {score.verdict === 'found' || score.verdict === 'probable' ? (
                      <Pressable
                        style={[styles.button, confirmDisabled ? styles.buttonDisabled : null]}
                        disabled={confirmDisabled}
                        onPress={() => void handleConfirm(score)}
                        accessibilityRole="button"
                        accessibilityLabel={
                          confirmDisabled
                            ? `${strings.confirmA11y(didHex(score.did), resultTargetLabel)} — ${strings.confirmDisabledTwoLevel}`
                            : isReplaceRow
                              ? strings.replaceA11y(
                                  existingBinding !== undefined ? didHex(existingBinding.did) : '',
                                  didHex(score.did),
                                  resultTargetLabel,
                                )
                              : strings.confirmA11y(didHex(score.did), resultTargetLabel)
                        }
                      >
                        <Text style={styles.buttonText}>
                          {isReplaceRow
                            ? strings.replaceAs(existingBinding !== undefined ? didHex(existingBinding.did) : '', didHex(score.did))
                            : strings.confirmAs(resultTargetLabel)}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })}

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
            {/* P4m-FIX3 Z4: an ECU is called silent only when the probe found it
                WHOLLY silent; a DID that answered neither the probe nor its one
                retry on a live ECU gets its own, truthful line. */}
            {snapshot.silentDids.length > 0 ? (
              <Text style={styles.caption}>
                {snapshot.silentEcus.length > 0
                  ? strings.notReadSilent(snapshot.silentDids.length, snapshot.silentEcus.map(ecuHex).join(', '))
                  : strings.notReadSilentDids(snapshot.silentDids.length)}
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
  warningInline: { ...typography.caption, color: colors.warning },
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
