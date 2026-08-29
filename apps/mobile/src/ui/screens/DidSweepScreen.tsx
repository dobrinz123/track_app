import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ENET_SPEC_CHANNELS,
  SimulatedEnetTransport,
  DEFAULT_ENET_DID_SCENARIO,
  DID_OBSERVATION_PHASES,
  MAX_FOCUSED_SHORTLIST_SIZE,
  filterCandidatePool,
  type DidCandidateSummary,
  type ObdTransport,
  type TelemetryChannelId,
} from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { facade, getTelemetryReadDb, settingsStore } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { EnetTcpTransport } from '../../session/enetTcpTransport';
import { formatHexByte, mergeEnetChannelSpecJson } from '../../session/enetSettingsValidation';
import { createDidSweepController, parseFocusedDidList, type DidSweepSnapshot } from '../../session/didSweepController';
import { createDidSweepStore, selectResumableRun, type DidSweepRunRecord } from '../../persistence/didSweepStore';
import { buildDidSweepExportForRun, buildCopySummaryText, shareDidSweepExport } from '../../session/didSweepExport';

type Props = NativeStackScreenProps<RootStackParamList, 'DidSweep'>;

const ENET_TAG_CHANNELS: readonly TelemetryChannelId[] = [...ENET_SPEC_CHANNELS];

function parseHexRange(text: string): number | null {
  const compact = text.trim().replace(/^0[Xx]/, '');
  if (!/^[0-9A-Fa-f]{1,4}$/.test(compact)) return null;
  const value = Number.parseInt(compact, 16);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
  return value;
}

function formatHexDid(did: number): string {
  return `0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
}

function formatBytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * Ticket P4j (binding): "UI shows '0x40B5 · bytes 4-5 changed (brake)'."
 * Collapses a sorted list of changed byte offsets into contiguous ranges
 * (`[4, 5, 9]` -> `"4-5, 9"`) so a wide block's change report reads as ranges
 * rather than a long list of individual offsets.
 */
function formatOffsetRanges(offsets: readonly number[]): string {
  if (offsets.length === 0) return '';
  const sorted = [...offsets].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i <= sorted.length; i += 1) {
    const current = sorted[i];
    if (current === undefined || current !== prev + 1) {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      if (current !== undefined) {
        start = current;
        prev = current;
      }
    } else {
      prev = current;
    }
  }
  return ranges.join(', ');
}

/**
 * Ticket P4j-FIX1 A3 / coordinator addendum (binding): "add a 'Shortlist
 * presets' hook: the screen can prefill the shortlist from `data`-style
 * presets ... keep it data, not logic."
 *
 * DATA, not logic: a plain, labelled list of DIDs the user may prefill the
 * focused shortlist with in one tap. Every entry is an explicit HYPOTHESIS
 * from the user's own field sweeps, never a claim of fact and never consulted
 * by any decision path -- the vehicle-agnostic addendum (2026-08-28, binding)
 * forbids brand-specific knowledge in generic modules, so this stays a
 * screen-local constant with the make/model named in its own label and never
 * leaks into the controller, the export, or a channel spec.
 */
const SHORTLIST_PRESETS: readonly { label: string; dids: readonly number[] }[] = [
  {
    label: 'Supra B58 brake/accel (hypothesis)',
    dids: [0x4a1d, 0x5892, 0x58b7, 0x4811, 0x4812, 0x4536, 0x4520, 0x4659],
  },
];

function formatDidListDraft(dids: readonly number[]): string {
  return dids.map((did) => did.toString(16).toUpperCase().padStart(4, '0')).join(', ');
}

/**
 * Dev-only tool, hidden by default (field revision, 2026-08-27, binding: the
 * ROUTE is registered in every build, release included -- only its
 * `SettingsScreen.tsx` entry point is gated on `developerModeEnabled`/
 * `__DEV__`, mirrors `DidProbe`; `DevReplay` remains the one screen still
 * `__DEV__`-only end to end). DID sweep screen (contracts.md "ENET auto-discovery & DID sweep addendum" +
 * "sweep transport interface & lifecycle amendment", both binding): iterates
 * a configurable DID range, shows live progress and responders, then (after
 * the sweep, or on demand) re-polls the responders found for an observation
 * window and shows heuristic suggestions the user can confirm with one tap
 * ("Tag as <channel>"), writing the resulting spec into `enetChannelSpecsJson`.
 *
 * H1/H2 (binding): the CONTROLLER owns the transport's whole lifecycle
 * (acquire the reservation, open a fresh transport, run, close, release) --
 * this screen supplies only a `transportFactory` (never connects/closes
 * anything itself) and renders `controller`'s own snapshot.
 */
export function DidSweepScreen(_props: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const [fromDraft, setFromDraft] = React.useState('0000');
  const [toDraft, setToDraft] = React.useState('FFFF');
  const [observationWindowDraft, setObservationWindowDraft] = React.useState('60');
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<DidSweepSnapshot | null>(null);
  const [tagPickerDid, setTagPickerDid] = React.useState<number | null>(null);
  const [tagBanner, setTagBanner] = React.useState<string | null>(null);
  // DID sweep — results persistence, export & candidate filtering addendum
  // (2026-08-27, binding — Phase 4i): "Resume button when a persisted run
  // exists" -- refreshed after every start()/stop()/resumePersistedRun() so
  // it never shows a run that's now superseded.
  const [resumableRuns, setResumableRuns] = React.useState<DidSweepRunRecord[]>([]);
  // "responders collapsed with count + expand".
  const [respondersExpanded, setRespondersExpanded] = React.useState(false);
  const [staticExpanded, setStaticExpanded] = React.useState(false);
  // Ticket P4j-FIX2 V1 (binding): the collapsed "insufficient" section --
  // same convention as `staticExpanded` above.
  const [insufficientExpanded, setInsufficientExpanded] = React.useState(false);
  const [insufficientBlockExpanded, setInsufficientBlockExpanded] = React.useState(false);
  // Ticket P4j (binding): "FOCUSED observation: the user can tick candidates
  // (or type DIDs) -> one long guided cycle on the shortlist only." Ticked
  // candidates (DID -> selected) plus a free-text typed-DID field; either
  // (or both) source the shortlist `startFocusedObservation` runs.
  const [selectedDids, setSelectedDids] = React.useState<ReadonlySet<number>>(new Set());
  const [focusedDidsDraft, setFocusedDidsDraft] = React.useState('');
  // Ticket P4j-FIX1 M1 (binding): an invalid hex token (or a shortlist longer
  // than the hard bound) is SHOWN, never silently dropped -- the pre-fix
  // screen started a two-DID run for `1234,ZZZZ,5678` without a word.
  const [focusedDidsError, setFocusedDidsError] = React.useState<string | null>(null);
  const [shareBanner, setShareBanner] = React.useState<string | null>(null);
  const [sharing, setSharing] = React.useState(false);
  // R1 fix (P4i-FIX2, binding, after Codex P4hrev3 H3 PARTIAL): "public
  // stop()/pause() resolve after the checkpoint is committed; screen shows
  // 'Saving…' until then." The phase itself already flips immediately
  // (unchanged) -- this is purely a local UI cue for the awaited persistence
  // write, cleared once the returned promise settles.
  const [saving, setSaving] = React.useState(false);
  // X1 fix (P4i-FIX3, binding, after Codex P4irev3 R1 PARTIAL): "screen shows
  // 'Save failed -- results kept in memory, share now'" -- set from EITHER
  // this explicit Stop/Pause's own rejected promise, OR (natural completion,
  // no direct caller to catch) `snapshot.persistError` -- both surface the
  // SAME message; Share is never blocked by this (it reads straight from the
  // live controller/store).
  const [saveFailedBanner, setSaveFailedBanner] = React.useState<string | null>(null);
  const didSweepStoreRef = React.useRef(createDidSweepStore(getTelemetryReadDb()));

  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  // M3 (binding): "pass GNSS speed context if a live speed source exists in
  // the app" -- `facade`'s `speedKph` is already computed every match tick
  // (cheap, no new subscription cost this screen introduces beyond one
  // `facade.subscribe`), so it is wired here rather than omitted. Collected
  // ONLY while an observation is actually running (cleared at each
  // `startObservation()`), read by the controller exactly once when the
  // observation phase finishes.
  //
  // P4f-FIX5 (binding, after Codex P4f-REV5): samples are buffered as RAW
  // wall-clock instants (`Date.now()`), NOT pre-converted to an elapsed time
  // -- the controller's `onObservationStarted` callback (below) supplies the
  // REAL anchor (the moment its core observation loop actually begins, AFTER
  // the transport finishes connecting), which arrives strictly LATER than
  // this ref is reset at the tap (`handleStartObservation`). Anchoring at the
  // tap instead (the REV5 defect) offset every GNSS sample by the connection
  // delay relative to the DID series' own (post-connect) relative `tMs` --
  // `gnssSpeedContext()` does the actual re-basing once the anchor is known,
  // dropping any sample that landed before it (no corresponding DID-relative
  // instant exists for those).
  const gnssSpeedSamplesRef = React.useRef<Array<{ wallClockMs: number; v: number }>>([]);
  const observingRef = React.useRef(false);
  const observationAnchorWallClockMsRef = React.useRef<number | null>(null);

  React.useEffect(
    () =>
      facade.subscribe((state) => {
        if (!observingRef.current || state.speedKph === null) return;
        gnssSpeedSamplesRef.current.push({ wallClockMs: Date.now(), v: state.speedKph });
      }),
    [],
  );

  const controllerRef = React.useRef<ReturnType<typeof createDidSweepController> | null>(null);

  function ensureController(): ReturnType<typeof createDidSweepController> {
    if (controllerRef.current !== null) return controllerRef.current;
    // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
    const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
    const controller = createDidSweepController({
      // H1/H2 (binding): a FRESH transport per `start()`/observation-from-
      // terminal-state -- this factory is called by the controller itself,
      // never invoked (or connected/closed) here.
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
      targetAddress: settingsRef.current.enetTargetAddress,
      clock: { now: () => Date.now() },
      // P4f-FIX5 (binding): the REAL anchor -- fired once the core
      // observation loop actually begins (post-connect), in the SAME
      // wall-clock domain `Date.now()` (above) already uses for GNSS
      // samples.
      onObservationStarted: (anchor) => {
        observationAnchorWallClockMsRef.current = anchor.wallClockMs;
      },
      gnssSpeedContext: () => {
        const anchor = observationAnchorWallClockMsRef.current;
        if (anchor === null) return { gnssSpeedKph: [] }; // the loop never actually started (e.g. connect failed) -- nothing valid to offer.
        return {
          gnssSpeedKph: gnssSpeedSamplesRef.current
            .map((sample) => ({ tMs: sample.wallClockMs - anchor, v: sample.v }))
            .filter((sample) => sample.tMs >= 0), // drop samples collected before the anchor (the tap-to-connect gap) -- no corresponding DID-relative instant exists for them.
        };
      },
      // DID sweep persistence addendum (binding, P4i): `null` (web preview /
      // before bootstrap resolves the on-device db) falls back to
      // `createDidSweepStore`'s own in-memory implementation -- same
      // ternary convention `composition.ts` uses everywhere else.
      store: didSweepStoreRef.current,
    });
    controllerRef.current = controller;
    controller.subscribe((next) => {
      observingRef.current = next.phase === 'observing';
      setSnapshot(next);
      if (next.phase === 'sweepComplete' || next.phase === 'stopped' || next.phase === 'idle') {
        void controller.listPersistedRuns().then(setResumableRuns);
      }
    });
    void controller.listPersistedRuns().then(setResumableRuns);
    return controller;
  }

  React.useEffect(
    () => () => {
      // Unmount cleanup: stop() closes the transport and releases the
      // reservation on every path (idempotent if already idle/stopped).
      // Ticket P4j-FIX1 M2 (binding): that promise now settles only AFTER the
      // socket closed and the reservation was released -- but a React cleanup
      // function cannot be async, so this stays deliberately fire-and-forget
      // WITH a `.catch` (the teardown itself starts synchronously inside
      // `stop()`, so the release is not delayed by not awaiting it here; only
      // the durable persistence checkpoint is unobserved, which is the
      // documented residual for a dev-only screen's unmount path).
      // X1 fix (P4i-FIX3, binding): `stop()` can now REJECT on a failed
      // terminal flush -- caught here (never an unhandled rejection); there
      // is no screen left to show a banner on after unmount anyway.
      // P4j-FIX2 V2 (binding, after Codex P4j-REV2 MEDIUM #2): this fire-and-
      // forget is still never AWAITED here, but a remounted screen's fresh
      // controller no longer transiently sees "adapter in use" as a result --
      // `start()`/`resumePersistedRun()` (`didSweepController.ts`) now await
      // `enetAdapterReservation`'s `whenFree()` on a refused first acquire and
      // retry once, so this instance's still-in-flight close+release (kicked
      // off right here) is waited out at the RESERVATION level instead.
      void controllerRef.current?.stop().catch(() => undefined);
    },
    [],
  );

  // "Resume button when a persisted run exists" -- built (and its store
  // queried) on mount, so the affordance is available BEFORE the user ever
  // taps Start.
  // F8 fix (P4i-FIX1, binding, after Codex P4hrev2c): the `react-hooks/
  // exhaustive-deps` inline suppression below this comment used to reference
  // a rule this project's flat `eslint.config.mjs` never configures
  // (`eslint-plugin-react-hooks` is not installed/wired here) -- ESLint
  // reports "Definition for rule ... was not found" for an unknown-rule
  // reference, red-lining the lint gate. `ensureController` genuinely IS a
  // stable ref-memoized factory not meant to re-run per render (unchanged
  // intent), so this empty-deps effect needs no suppression at all once the
  // phantom rule reference is gone.
  React.useEffect(() => {
    ensureController();
  }, []);

  // DID sweep — range presets addendum (binding, P4i): "Full (slow, ~70
  // min)", "Resume", and the two priority presets discovered from the field
  // sweep (0x1000-0x1FFF, 0x4000-0x4FFF are dense on this DME -- EMPIRICAL).
  function applyRangePreset(preset: 'full' | 'range1000' | 'range4000'): void {
    setRangeError(null);
    if (preset === 'full') {
      setFromDraft('0000');
      setToDraft('FFFF');
    } else if (preset === 'range1000') {
      setFromDraft('1000');
      setToDraft('1FFF');
    } else {
      setFromDraft('4000');
      setToDraft('4FFF');
    }
  }

  function handleResume(runId: string): void {
    setRangeError(null);
    setTagBanner(null);
    setSaveFailedBanner(null);
    void ensureController().resumePersistedRun(runId);
  }

  function handleStart(): void {
    setRangeError(null);
    setTagBanner(null);
    setSaveFailedBanner(null);
    const from = parseHexRange(fromDraft);
    const to = parseHexRange(toDraft);
    if (from === null || to === null) {
      setRangeError('Enter hex DIDs, 0000-FFFF, for both From and To');
      return;
    }
    ensureController().start({ from, to });
  }

  // R1 fix (P4i-FIX2, binding): `controller.stop()` now returns a promise
  // that resolves only once its own terminal persistence checkpoint has
  // committed -- awaited here so the "Saving…" cue reflects the REAL write,
  // not just the (already-immediate) phase transition.
  async function handleStop(): Promise<void> {
    setSaving(true);
    setSaveFailedBanner(null);
    try {
      await controllerRef.current?.stop();
    } catch {
      // X1 fix (P4i-FIX3, binding): the checkpoint failed to commit -- the
      // sweep's results are still fully intact in memory (Share still works
      // from them), only the on-disk copy is behind.
      setSaveFailedBanner('Save failed — results kept in memory, share now');
    } finally {
      setSaving(false);
    }
  }

  async function handlePause(): Promise<void> {
    setSaving(true);
    setSaveFailedBanner(null);
    try {
      await controllerRef.current?.pause();
    } catch {
      setSaveFailedBanner('Save failed — results kept in memory, share now');
    } finally {
      setSaving(false);
    }
  }

  function handleStartObservation(): void {
    const seconds = Number.parseInt(observationWindowDraft, 10);
    const windowMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
    gnssSpeedSamplesRef.current = [];
    // P4f-FIX5 (binding): NOT `Date.now()` here (the REV5 defect) -- the real
    // anchor arrives later, via `onObservationStarted`, once the core loop
    // actually begins post-connect. `null` until then; any GNSS sample
    // collected in the meantime is buffered (raw wall-clock) and re-based
    // once the anchor lands.
    observationAnchorWallClockMsRef.current = null;
    controllerRef.current?.startObservation(windowMs);
  }

  // DID sweep — guided candidate observation addendum (2026-08-27, binding —
  // Phase 4i, user clarification), superseded by ticket P4j's BATCHED guided
  // flow: the same visible, guided, repeated re-read (baseline -> brake ->
  // steering -> throttle) but batch by batch over the WIDENED candidate pool
  // (1-32 bytes -- mid-size blocks join numeric candidates), sized from the
  // sweep's own measured req/s so every DID gets >= 5 samples/phase (field
  // evidence: a single pass over 128 candidates gave only 1-2/phase, which
  // is why 0x4522's ordinary jitter (297 -> 305 -> 295) looked like a brake
  // signal before this fix).
  function handleStartGuidedObservation(): void {
    controllerRef.current?.startBatchedObservation();
  }

  function handleStopGuidedObservationEarly(): void {
    controllerRef.current?.stopGuidedObservationEarly();
  }

  // Ticket P4j (binding): "the user can tick candidates (or type DIDs) -> one
  // long guided cycle on the shortlist only." The shortlist is the UNION of
  // ticked candidates and typed DIDs -- either source alone is enough.
  function toggleSelectedDid(did: number): void {
    setSelectedDids((prev) => {
      const next = new Set(prev);
      if (next.has(did)) next.delete(did);
      else next.add(did);
      return next;
    });
  }

  function handleStartFocusedObservation(): void {
    // M1 (binding): parse FIRST and refuse on any invalid token -- never a
    // partially-honoured shortlist.
    const parsed = parseFocusedDidList(focusedDidsDraft);
    if (parsed.error !== null) {
      setFocusedDidsError(parsed.error);
      return;
    }
    const shortlist = new Set<number>(selectedDids);
    for (const did of parsed.dids) shortlist.add(did);
    if (shortlist.size > MAX_FOCUSED_SHORTLIST_SIZE) {
      setFocusedDidsError(`Pick at most ${MAX_FOCUSED_SHORTLIST_SIZE} DIDs for a focused run (got ${shortlist.size}).`);
      return;
    }
    setFocusedDidsError(null);
    controllerRef.current?.startFocusedObservation([...shortlist]);
  }

  /** A3 (binding, coordinator addendum): one-tap prefill from the {@link SHORTLIST_PRESETS} data table -- it only fills the text field, nothing is started. */
  function applyShortlistPreset(dids: readonly number[]): void {
    setFocusedDidsError(null);
    setFocusedDidsDraft(formatDidListDraft(dids));
  }

  async function handleShareResults(): Promise<void> {
    const controller = controllerRef.current;
    const runId = controller?.getCurrentRunId() ?? null;
    if (controller === null || runId === null) {
      setShareBanner('Nothing to share yet -- start a sweep first.');
      return;
    }
    setSharing(true);
    setShareBanner(null);
    try {
      // F3 fix (P4i-FIX1, binding, after Codex P4hrev2c): this is the ONE
      // handoff point -- delegates straight to `buildDidSweepExportForRun`
      // (controller + store -> export document) rather than re-assembling
      // the builder's input inline, which is what previously omitted
      // `getGuidedSamples()` (`observationSamples` was never passed at all).
      const doc = await buildDidSweepExportForRun(controller, didSweepStoreRef.current, runId, new Date().toISOString());
      if (doc === null) {
        setShareBanner('Could not find this run in storage.');
        return;
      }
      const result = await shareDidSweepExport(doc);
      setShareBanner(
        result.shared
          ? 'Shared.'
          : `Export ready (${result.jsonLength} bytes) -- sharing isn't available on this platform; see the console log.`,
      );
    } finally {
      setSharing(false);
    }
  }

  function confirmTag(did: number, channel: TelemetryChannelId): void {
    const controller = controllerRef.current;
    if (controller === null) return;
    const spec = controller.buildTaggedSpec(did, channel, new Date().toISOString().slice(0, 10));
    if (spec === null) {
      setTagBanner(`Could not build a spec for ${formatHexDid(did)}.`);
      return;
    }
    const merged = mergeEnetChannelSpecJson(settingsStore.getSettings().enetChannelSpecsJson, spec);
    settingsStore.update({ enetChannelSpecsJson: merged });
    setTagBanner(`Tagged ${formatHexDid(did)} as ${channel}.`);
    setTagPickerDid(null);
  }

  const phase = snapshot?.phase ?? 'idle';
  // X1 fix (P4i-FIX3, binding): the SAME "Save failed" message whether it
  // came from THIS explicit Stop/Pause (caught above) or from a natural
  // completion's own terminal flush failing (no direct caller to catch --
  // surfaced only through the snapshot). Results stay fully in memory either
  // way; Share is never blocked by this.
  const saveFailedMessage = saveFailedBanner ?? (snapshot?.persistError == null ? null : 'Save failed — results kept in memory, share now');
  const running = phase === 'sweeping' || phase === 'paused';
  const observing = phase === 'observing';
  const canStart = phase === 'idle' || phase === 'stopped' || phase === 'sweepComplete' || phase === 'observationComplete';
  const totalNrc = Object.values(snapshot?.nrcCounts ?? {}).reduce((sum, n) => sum + n, 0);
  // Addendum (binding, P4i): "the observation phase uses the filtered
  // candidate set and shows 'N candidates of M responders'" -- computed here
  // (pure, deterministic) purely for DISPLAY; the controller applies the
  // SAME filter internally when it actually builds its own poll list.
  // Ticket P4j (binding): "Mid-size blocks (9-32 bytes) join the candidate
  // pool" -- the WIDENED pool (1-32 bytes), vs. the legacy 1-8-byte
  // `filterSweepCandidates` `startGuidedObservation()` used before batching.
  const candidateDids = snapshot === null ? [] : filterCandidatePool(snapshot.responders);
  // F6 fix (P4i-FIX1, binding): the single most-recent RESUMABLE run, or
  // `null` if none qualifies -- see `selectResumableRun`'s own doc comment.
  const resumableRun = selectResumableRun(resumableRuns);
  const guidedPhaseSpec = snapshot?.guidedPhase == null ? null : DID_OBSERVATION_PHASES.find((p) => p.id === snapshot.guidedPhase) ?? null;
  const rankedCandidates = snapshot?.candidateSummaries ?? [];
  // Ticket P4j-FIX2 V1 (binding, after Codex P4j-REV2 HIGH #1 PARTIAL): a DID
  // ranked `insufficient` (evidence missing in at least one phase) is EXCLUDED
  // from the ranked/active list -- never shown as a candidate (the pre-fix
  // defect: it could still read "changed (several)" here). It gets its own
  // collapsed section below, listed separately with its failing phases.
  const activeCandidates = rankedCandidates.filter((c) => c.rank !== 'static' && c.rank !== 'insufficient');
  const staticCandidates = rankedCandidates.filter((c) => c.rank === 'static');
  const insufficientCandidates = rankedCandidates.filter((c) => c.rank === 'insufficient');
  // Ticket P4j (binding): mid-size block candidates, shown alongside the
  // numeric ones -- static blocks are just as uninteresting as static
  // numeric candidates, so they are collapsed the same way.
  const blockCandidates = snapshot?.blockCandidateSummaries ?? [];
  const activeBlockCandidates = blockCandidates.filter((b) => b.rank !== 'static' && b.rank !== 'insufficient');
  const insufficientBlockCandidates = blockCandidates.filter((b) => b.rank === 'insufficient');
  // Ticket P4j (binding): "make sure the sweep screen shows the active
  // target" -- e.g. "Target 0x12". Formatted the same way the export's own
  // `run.targetAddress` is (a 2-hex-digit byte), never a hard-coded ECU name
  // (vehicle-agnostic contract, 2026-08-28, binding).
  const targetAddressHex = `0x${formatHexByte(settings.enetTargetAddress)}`;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          DID sweep (ENET)
        </Text>
        <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
          Dev-only. Sweeps a DID range with one 0x22 request at a time, then re-polls responders to suggest a
          channel/decode. No suggestion is ever applied without your confirmation.
        </Text>

        <View style={styles.card}>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
              From (hex)
            </Text>
            <TextInput
              style={styles.fieldInput}
              value={fromDraft}
              onChangeText={setFromDraft}
              editable={canStart}
              autoCapitalize="characters"
              autoCorrect={false}
              // M1 (binding, P4j-FIX1): the DEFAULT keyboard -- `numbers-and-punctuation` hides A-F on iOS, and every value here is HEX.
              accessibilityLabel="Sweep range start, hex DID"
            />
          </View>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
              To (hex)
            </Text>
            <TextInput
              style={styles.fieldInput}
              value={toDraft}
              onChangeText={setToDraft}
              editable={canStart}
              autoCapitalize="characters"
              autoCorrect={false}
              // M1 (binding, P4j-FIX1): the DEFAULT keyboard -- `numbers-and-punctuation` hides A-F on iOS, and every value here is HEX.
              accessibilityLabel="Sweep range end, hex DID"
            />
          </View>

          {/* Range presets addendum (binding, P4i): "Full (slow, ~70 min)",
              "Resume", and the two priority presets discovered from the
              field sweep -- 0x1000-0x1FFF/0x4000-0x4FFF are dense on this
              DME (EMPIRICAL). */}
          {canStart ? (
            <View style={styles.buttonRow}>
              <Pressable style={styles.presetChip} onPress={() => applyRangePreset('full')} accessibilityRole="button" accessibilityLabel="Full range preset, 0000 to FFFF">
                <Text style={styles.presetChipText} maxFontSizeMultiplier={1.3}>
                  Full (~70 min)
                </Text>
              </Pressable>
              <Pressable style={styles.presetChip} onPress={() => applyRangePreset('range1000')} accessibilityRole="button" accessibilityLabel="Preset range 0x1000 to 0x1FFF">
                <Text style={styles.presetChipText} maxFontSizeMultiplier={1.3}>
                  0x1000–0x1FFF
                </Text>
              </Pressable>
              <Pressable style={styles.presetChip} onPress={() => applyRangePreset('range4000')} accessibilityRole="button" accessibilityLabel="Preset range 0x4000 to 0x4FFF">
                <Text style={styles.presetChipText} maxFontSizeMultiplier={1.3}>
                  0x4000–0x4FFF
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* "Resume button when a persisted run exists" (binding, P4i).
              F6 fix (P4i-FIX1, binding, after Codex P4hrev2c): the MOST
              RECENT RESUMABLE run (status paused/stopped/interrupted with
              lastDid < rangeEnd) -- never the most recently updated run
              regardless of status (a naturally COMPLETED run is never
              offered here, even if it happens to be the newest one). */}
          {canStart && resumableRun !== null ? (
            <Pressable
              style={styles.buttonSecondary}
              onPress={() => handleResume(resumableRun.runId)}
              accessibilityRole="button"
              accessibilityLabel={`Resume sweep from ${formatHexDid(resumableRun.lastDid ?? resumableRun.rangeFrom)}`}
            >
              <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                Resume from {resumableRun.lastDid === null ? formatHexDid(resumableRun.rangeFrom) : formatHexDid(resumableRun.lastDid)} (
                {resumableRun.responderCount} responders so far)
              </Text>
            </Pressable>
          ) : null}

          {rangeError === null ? null : (
            <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {rangeError}
            </Text>
          )}
          {snapshot?.error == null ? null : (
            <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {snapshot.error}
            </Text>
          )}

          <View style={styles.buttonRow}>
            {canStart ? (
              <Pressable style={styles.button} onPress={handleStart} accessibilityRole="button" accessibilityLabel="Start sweep">
                <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>
                  Start
                </Text>
              </Pressable>
            ) : (
              <>
                {phase === 'sweeping' ? (
                  <Pressable style={styles.buttonSecondary} onPress={() => void handlePause()} disabled={saving} accessibilityRole="button" accessibilityLabel="Pause sweep">
                    <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                      Pause
                    </Text>
                  </Pressable>
                ) : null}
                {/* Ticket P4j-FIX1 M2 (binding): pause is now available DURING
                    a batched observation too -- it takes effect at the next
                    BATCH boundary (the running batch always finishes its own
                    four phases, so no batch is left half-observed). */}
                {observing && snapshot !== null && snapshot.batchTotal !== null ? (
                  <Pressable
                    style={styles.buttonSecondary}
                    onPress={() => void handlePause()}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityLabel="Pause observation at the next batch"
                  >
                    <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                      Pause after this batch
                    </Text>
                  </Pressable>
                ) : null}
                {phase === 'paused' ? (
                  <Pressable style={styles.button} onPress={() => controllerRef.current?.resume()} accessibilityRole="button" accessibilityLabel="Resume sweep">
                    <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>
                      Resume
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.buttonDanger} onPress={() => void handleStop()} disabled={saving} accessibilityRole="button" accessibilityLabel="Stop sweep">
                  <Text style={styles.buttonDangerText} maxFontSizeMultiplier={1.3}>
                    Stop
                  </Text>
                </Pressable>
              </>
            )}
          </View>
          {/* R1 fix (P4i-FIX2, binding): "screen shows 'Saving…' until [the
              checkpoint is committed]." */}
          {saving ? (
            <Text style={styles.helperText} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              Saving…
            </Text>
          ) : null}
          {/* X1 fix (P4i-FIX3, binding): a terminal checkpoint failure is
              VISIBLE, never silently swallowed -- results stay in memory
              (Share still works) regardless. */}
          {!saving && saveFailedMessage !== null ? (
            <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {saveFailedMessage}
            </Text>
          ) : null}
        </View>

        {snapshot === null ? null : (
          <View style={styles.card}>
            {/* Ticket P4j (binding): "make sure the sweep screen shows the
                active target" (e.g. "DME 0x12" / "0x29"). */}
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel} maxFontSizeMultiplier={1.3}>
                Target
              </Text>
              <Text style={styles.progressValue} maxFontSizeMultiplier={1.3}>
                {targetAddressHex}
              </Text>
            </View>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel} maxFontSizeMultiplier={1.3}>
                {phase.toUpperCase()}
              </Text>
              {snapshot.progress === null ? null : (
                <Text style={styles.progressValue} maxFontSizeMultiplier={1.3} numberOfLines={2}>
                  {formatHexDid(snapshot.progress.did)} · {snapshot.progress.index}/{snapshot.progress.total} ·{' '}
                  {snapshot.progress.reqPerSec.toFixed(1)} req/s
                </Text>
              )}
            </View>
            {/* Ticket P4j (binding): "progress 'Batch 3/8'" -- shown only
                during a BATCHED guided observation run. */}
            {snapshot.batchIndex === null || snapshot.batchTotal === null ? null : (
              <View style={styles.progressRow}>
                <Text style={styles.progressLabel} maxFontSizeMultiplier={1.3}>
                  Batch
                </Text>
                <Text style={styles.progressValue} maxFontSizeMultiplier={1.3}>
                  {snapshot.batchIndex + 1}/{snapshot.batchTotal}
                </Text>
              </View>
            )}
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel} maxFontSizeMultiplier={1.3}>
                Responders
              </Text>
              <Text style={styles.progressValue} maxFontSizeMultiplier={1.3}>
                {snapshot.responders.length}
              </Text>
            </View>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel} maxFontSizeMultiplier={1.3}>
                NRC / timeouts
              </Text>
              <Text style={styles.progressValue} maxFontSizeMultiplier={1.3}>
                {totalNrc} / {snapshot.timeouts}
              </Text>
            </View>
          </View>
        )}

        {snapshot === null || snapshot.responders.length === 0 ? null : (
          <View style={styles.card}>
            <Pressable
              style={styles.collapseHeaderRow}
              onPress={() => setRespondersExpanded((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={respondersExpanded ? 'Collapse responders' : `Expand ${snapshot.responders.length} responders`}
            >
              <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
                RESPONDERS ({snapshot.responders.length})
              </Text>
              <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                {respondersExpanded ? 'Hide' : 'Show'}
              </Text>
            </Pressable>
            <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
              {candidateDids.length} candidate{candidateDids.length === 1 ? '' : 's'} of {snapshot.responders.length} responders
              (length 1-32 bytes, not an ASCII string -- mid-size 9-32 byte blocks join numeric 1-8 byte candidates).
            </Text>
            {respondersExpanded
              ? snapshot.responders.map((responder) => (
                  <View key={responder.did} style={styles.responderRow}>
                    <Text style={styles.responderDid} maxFontSizeMultiplier={1.3}>
                      {formatHexDid(responder.did)}
                    </Text>
                    <Text style={styles.responderRaw} maxFontSizeMultiplier={1.3}>
                      {formatBytesHex(responder.raw)}
                    </Text>
                  </View>
                ))
              : null}

            {(phase === 'sweepComplete' || phase === 'paused' || phase === 'stopped' || phase === 'observationComplete') && !observing ? (
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                  Observe window (s)
                </Text>
                <TextInput
                  style={styles.fieldInputSmall}
                  value={observationWindowDraft}
                  onChangeText={setObservationWindowDraft}
                  keyboardType="number-pad"
                  accessibilityLabel="Observation window, seconds"
                />
              </View>
            ) : null}
            {(phase === 'sweepComplete' || phase === 'paused' || phase === 'stopped' || phase === 'observationComplete') && !observing ? (
              <Pressable style={styles.buttonSecondary} onPress={handleStartObservation} accessibilityRole="button" accessibilityLabel="Start observation">
                <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                  Start observation (single window, suggestions)
                </Text>
              </Pressable>
            ) : null}
            {/* Guided candidate observation addendum (binding, P4i, user
                clarification), BATCHED per ticket P4j: the visible, guided,
                repeated re-read across baseline/brake/steering/throttle,
                batch by batch over the whole candidate pool -- fixes the
                noise a single pass over a large candidate set produced
                (field evidence: 1-2 samples/DID/phase was not enough). */}
            {(phase === 'sweepComplete' || phase === 'stopped' || phase === 'observationComplete') && !observing ? (
              <Pressable style={styles.button} onPress={handleStartGuidedObservation} accessibilityRole="button" accessibilityLabel="Start batched guided observation">
                <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>
                  Start guided observation (baseline → brake → steering → throttle, batch by batch)
                </Text>
              </Pressable>
            ) : null}
            {/* F2 fix (P4i-FIX1, binding): the two-sample changing-value
                pre-pass runs BEFORE "baseline" -- its own distinct prompt,
                wired to the SAME `stopGuidedObservationEarly` (never the
                plain single-window `stopObservationEarly`). */}
            {observing && snapshot.guidedPhase === 'prePass' ? (
              <>
                <Text style={styles.helperText} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                  Reading candidates twice (blip the throttle / press the brake / turn the wheel) —{' '}
                  {Math.max(0, Math.ceil((snapshot.guidedPhaseDurationMs - snapshot.guidedPhaseElapsedMs) / 1_000))}s
                </Text>
                <Pressable style={styles.buttonDanger} onPress={handleStopGuidedObservationEarly} accessibilityRole="button" accessibilityLabel="Stop guided observation now">
                  <Text style={styles.buttonDangerText} maxFontSizeMultiplier={1.3}>
                    Stop now
                  </Text>
                </Pressable>
              </>
            ) : null}
            {observing && guidedPhaseSpec !== null ? (
              <>
                <Text style={styles.helperText} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                  {/* F2 fix (binding, "show it"): the countdown uses the
                      ACTUAL (possibly auto-raised) duration, not the fixed
                      ~6s spec -- a large candidate set's phase can run far
                      longer than 6s.
                      Ticket P4j-FIX1 H1 (binding): the countdown keeps showing
                      that NOMINAL window; when the phase runs past it to
                      finish the per-DID sample guarantee it says "extending…"
                      rather than silently stalling at 0s. */}
                  {guidedPhaseSpec.prompt} —{' '}
                  {snapshot.guidedPhaseExtending
                    ? 'extending… (finishing the sample count)'
                    : `${Math.max(0, Math.ceil((snapshot.guidedPhaseDurationMs - snapshot.guidedPhaseElapsedMs) / 1_000))}s`}
                </Text>
                <Pressable style={styles.buttonDanger} onPress={handleStopGuidedObservationEarly} accessibilityRole="button" accessibilityLabel="Stop guided observation now">
                  <Text style={styles.buttonDangerText} maxFontSizeMultiplier={1.3}>
                    Stop now
                  </Text>
                </Pressable>
              </>
            ) : null}
            {observing && guidedPhaseSpec === null && snapshot.guidedPhase !== 'prePass' ? (
              <>
                <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                  Observing… {(snapshot.observationElapsedMs / 1_000).toFixed(0)}s
                  {snapshot.observationCadenceDegraded ? ' · cadence degraded (too many responders for ~1 Hz each)' : ''}
                </Text>
                <Pressable
                  style={styles.buttonDanger}
                  onPress={() => controllerRef.current?.stopObservationEarly()}
                  accessibilityRole="button"
                  accessibilityLabel="Stop observation now"
                >
                  <Text style={styles.buttonDangerText} maxFontSizeMultiplier={1.3}>
                    Stop observation now
                  </Text>
                </Pressable>
              </>
            ) : null}
          </View>
        )}

        {/* Guided candidate observation results (binding, P4i, user
            clarification): "Sort: DIDs that changed in exactly one active
            phase ... first, then changed-in-several, then static
            (collapsed)." */}
        {rankedCandidates.length === 0 ? null : (
          <View style={styles.card}>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              CANDIDATES ({rankedCandidates.length})
            </Text>
            {activeCandidates.map((candidate) => (
              <View key={candidate.did} style={styles.suggestionRow}>
                <Text style={styles.responderDid} maxFontSizeMultiplier={1.3}>
                  {formatHexDid(candidate.did)} — {candidate.lastRawHex} ·{' '}
                  {/* F5 fix (P4i-FIX1, binding): labelled by the ONE phase
                      that actually changed it -- never a merged "BRAKE/STEERING?" guess. */}
                  {candidate.rank === 'brakeCandidate'
                    ? 'BRAKE?'
                    : candidate.rank === 'steeringCandidate'
                      ? 'STEERING?'
                      : candidate.rank === 'throttleCandidate'
                        ? 'THROTTLE?'
                        : 'changed (several)'}
                </Text>
                <Text style={styles.rationaleText} maxFontSizeMultiplier={1.3}>
                  {(['baseline', 'brake', 'steering', 'throttle'] as const)
                    .filter((p) => candidate.changedInPhase[p])
                    .map((p) => p.toUpperCase())
                    .join(', ') || 'no change observed'}{' '}
                  · {candidate.sampleCount} samples
                  {candidate.min !== null && candidate.max !== null ? ` · range ${candidate.min}-${candidate.max}` : ''}
                  {/* Ticket P4j-FIX1 H2 (binding): an under-sampled phase says
                      so -- a bare "no change observed" used to be
                      indistinguishable from "never measured". */}
                  {(['brake', 'steering', 'throttle'] as const).some((p) => candidate.phaseEvidence[p] === 'insufficient')
                    ? ` · not enough samples in ${(['brake', 'steering', 'throttle'] as const)
                        .filter((p) => candidate.phaseEvidence[p] === 'insufficient')
                        .join(', ')}`
                    : ''}
                </Text>
                {/* Ticket P4j (binding): "the user can tick candidates ...
                    -> one long guided cycle on the shortlist only." */}
                <Pressable
                  style={styles.presetChip}
                  onPress={() => toggleSelectedDid(candidate.did)}
                  accessibilityRole="button"
                  accessibilityLabel={selectedDids.has(candidate.did) ? `Deselect ${formatHexDid(candidate.did)} from the focused shortlist` : `Select ${formatHexDid(candidate.did)} for the focused shortlist`}
                >
                  <Text style={styles.presetChipText} maxFontSizeMultiplier={1.3}>
                    {selectedDids.has(candidate.did) ? '☑ Selected' : '☐ Select'}
                  </Text>
                </Pressable>
                {tagPickerDid === candidate.did ? (
                  <View style={styles.channelPickerRow}>
                    {ENET_TAG_CHANNELS.map((channel) => (
                      <Pressable
                        key={channel}
                        style={styles.channelChip}
                        onPress={() => confirmTag(candidate.did, channel)}
                        accessibilityRole="button"
                        accessibilityLabel={`Tag ${formatHexDid(candidate.did)} as ${channel}`}
                      >
                        <Text style={styles.channelChipText} maxFontSizeMultiplier={1.3}>
                          {channel}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <Pressable
                    style={styles.buttonSecondary}
                    onPress={() => setTagPickerDid(candidate.did)}
                    accessibilityRole="button"
                    accessibilityLabel={`Tag ${formatHexDid(candidate.did)} as a channel`}
                  >
                    <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                      Tag as…
                    </Text>
                  </Pressable>
                )}
              </View>
            ))}
            {staticCandidates.length === 0 ? null : (
              <>
                <Pressable
                  style={styles.collapseHeaderRow}
                  onPress={() => setStaticExpanded((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={staticExpanded ? 'Collapse static candidates' : `Expand ${staticCandidates.length} static candidates`}
                >
                  <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                    Static ({staticCandidates.length})
                  </Text>
                  <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                    {staticExpanded ? 'Hide' : 'Show'}
                  </Text>
                </Pressable>
                {staticExpanded
                  ? staticCandidates.map((candidate) => (
                      <Text key={candidate.did} style={styles.responderRaw} maxFontSizeMultiplier={1.3}>
                        {formatHexDid(candidate.did)} — {candidate.lastRawHex}
                      </Text>
                    ))
                  : null}
              </>
            )}
            {/* Ticket P4j-FIX2 V1 (binding): DIDs excluded from ranking for
                want of samples in at least one phase -- listed SEPARATELY
                from both the active candidates above and the static set,
                each with its own failing phase(s), never merged into either. */}
            {insufficientCandidates.length === 0 ? null : (
              <>
                <Pressable
                  style={styles.collapseHeaderRow}
                  onPress={() => setInsufficientExpanded((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={insufficientExpanded ? 'Collapse insufficient-evidence candidates' : `Expand ${insufficientCandidates.length} insufficient-evidence candidates`}
                >
                  <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                    Insufficient evidence ({insufficientCandidates.length})
                  </Text>
                  <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                    {insufficientExpanded ? 'Hide' : 'Show'}
                  </Text>
                </Pressable>
                {insufficientExpanded
                  ? insufficientCandidates.map((candidate) => (
                      <Text key={candidate.did} style={styles.responderRaw} maxFontSizeMultiplier={1.3}>
                        {formatHexDid(candidate.did)} — not enough samples in{' '}
                        {(['baseline', 'brake', 'steering', 'throttle'] as const)
                          .filter((p) => candidate.phaseEvidence[p] === 'insufficient')
                          .map((p) => p.toUpperCase())
                          .join(', ')}
                      </Text>
                    ))
                  : null}
              </>
            )}
          </View>
        )}

        {/* Ticket P4j (binding): "Mid-size blocks (9-32 bytes) join the
            candidate pool with per-byte-offset diffing ... UI shows '0x40B5
            · bytes 4-5 changed (brake)'." */}
        {activeBlockCandidates.length === 0 ? null : (
          <View style={styles.card}>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              BLOCK CANDIDATES ({activeBlockCandidates.length})
            </Text>
            {activeBlockCandidates.map((block) => {
              // Ticket P4j-FIX1 M4 (binding, after Codex P4j-REV1 MEDIUM #4:
              // "Multi-phase block offset reporting hides all but the first
              // changed phase"): EVERY active phase with changed offsets is
              // reported -- the pre-fix code picked the first one and showed
              // "changed (several) · bytes 4-5 changed (brake)" while byte 9's
              // throttle change stayed invisible.
              const changedPhases = (['brake', 'steering', 'throttle'] as const).filter(
                (p) => block.changedOffsetsByPhase[p].length > 0,
              );
              const label =
                block.rank === 'brakeCandidate'
                  ? 'BRAKE?'
                  : block.rank === 'steeringCandidate'
                    ? 'STEERING?'
                    : block.rank === 'throttleCandidate'
                      ? 'THROTTLE?'
                      : 'changed (several)';
              return (
                <View key={block.did} style={styles.suggestionRow}>
                  <Text style={styles.responderDid} maxFontSizeMultiplier={1.3}>
                    {formatHexDid(block.did)} · {block.length} bytes — {label}
                  </Text>
                  <Text style={styles.rationaleText} maxFontSizeMultiplier={1.3}>
                    {changedPhases.length === 0
                      ? 'no changed offsets'
                      : changedPhases
                          .map((p) => `bytes ${formatOffsetRanges(block.changedOffsetsByPhase[p])} changed (${p})`)
                          .join(' · ')}{' '}
                    · {block.sampleCount} samples
                    {/* H2 (binding): an under-sampled phase is reported as such, never as "nothing changed". */}
                    {(['brake', 'steering', 'throttle'] as const).some((p) => block.phaseEvidence[p] === 'insufficient')
                      ? ` · not enough samples in ${(['brake', 'steering', 'throttle'] as const)
                          .filter((p) => block.phaseEvidence[p] === 'insufficient')
                          .join(', ')}`
                      : ''}
                  </Text>
                  <Pressable
                    style={styles.presetChip}
                    onPress={() => toggleSelectedDid(block.did)}
                    accessibilityRole="button"
                    accessibilityLabel={selectedDids.has(block.did) ? `Deselect ${formatHexDid(block.did)} from the focused shortlist` : `Select ${formatHexDid(block.did)} for the focused shortlist`}
                  >
                    <Text style={styles.presetChipText} maxFontSizeMultiplier={1.3}>
                      {selectedDids.has(block.did) ? '☑ Selected' : '☐ Select'}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}

        {/* Ticket P4j-FIX2 V1 (binding): same "excluded from ranking, listed
            separately with the failing phases" treatment for mid-size block
            candidates. */}
        {insufficientBlockCandidates.length === 0 ? null : (
          <View style={styles.card}>
            <Pressable
              style={styles.collapseHeaderRow}
              onPress={() => setInsufficientBlockExpanded((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={insufficientBlockExpanded ? 'Collapse insufficient-evidence block candidates' : `Expand ${insufficientBlockCandidates.length} insufficient-evidence block candidates`}
            >
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                Insufficient evidence, block ({insufficientBlockCandidates.length})
              </Text>
              <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                {insufficientBlockExpanded ? 'Hide' : 'Show'}
              </Text>
            </Pressable>
            {insufficientBlockExpanded
              ? insufficientBlockCandidates.map((block) => (
                  <Text key={block.did} style={styles.responderRaw} maxFontSizeMultiplier={1.3}>
                    {formatHexDid(block.did)} · {block.length} bytes — not enough samples in{' '}
                    {(['baseline', 'brake', 'steering', 'throttle'] as const)
                      .filter((p) => block.phaseEvidence[p] === 'insufficient')
                      .map((p) => p.toUpperCase())
                      .join(', ')}
                  </Text>
                ))
              : null}
          </View>
        )}

        {/* Ticket P4j (binding): "FOCUSED observation: the user can tick
            candidates (or type DIDs) -> one long guided cycle on the
            shortlist only (>= 10 samples per phase)." */}
        {snapshot === null || snapshot.responders.length === 0 ? null : (
          <View style={styles.card}>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              FOCUSED OBSERVATION
            </Text>
            <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
              {selectedDids.size} selected, max {MAX_FOCUSED_SHORTLIST_SIZE}. Type extra DIDs (hex, comma/space-separated) —
              a DID the sweep never saw is read directly; an NRC answer shows as "no response".
            </Text>
            {/* A3 (binding, coordinator addendum): "Shortlist presets" -- pure
                data (see SHORTLIST_PRESETS), one tap prefills the field. */}
            <View style={styles.presetRow}>
              {SHORTLIST_PRESETS.map((preset) => (
                <Pressable
                  key={preset.label}
                  style={styles.presetChip}
                  onPress={() => applyShortlistPreset(preset.dids)}
                  disabled={observing}
                  accessibilityRole="button"
                  accessibilityLabel={`Prefill the shortlist with the ${preset.label} preset`}
                >
                  <Text style={styles.presetChipText} maxFontSizeMultiplier={1.3}>
                    {preset.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                DIDs (hex)
              </Text>
              <TextInput
                style={styles.fieldInput}
                value={focusedDidsDraft}
                onChangeText={(text) => {
                  setFocusedDidsDraft(text);
                  setFocusedDidsError(null);
                }}
                editable={!observing}
                autoCapitalize="characters"
                autoCorrect={false}
                // M1 (binding): the DEFAULT keyboard -- `numbers-and-punctuation`
                // does not expose A-F on iOS, so half of every hex DID was
                // untypeable on the device this screen exists for.
                accessibilityLabel="Typed DIDs for focused observation, hex, comma or space separated"
              />
            </View>
            {focusedDidsError === null ? null : (
              <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                {focusedDidsError}
              </Text>
            )}
            {(phase === 'sweepComplete' || phase === 'stopped' || phase === 'observationComplete') && !observing ? (
              <Pressable
                style={styles.buttonSecondary}
                onPress={handleStartFocusedObservation}
                disabled={selectedDids.size === 0 && focusedDidsDraft.trim().length === 0}
                accessibilityRole="button"
                accessibilityLabel="Start focused observation on the shortlist"
              >
                <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                  Start focused observation on shortlist (≥10 samples/phase)
                </Text>
              </Pressable>
            ) : null}
            {/* H1 + coordinator addendum (binding): DIDs that never produced
                enough (or any) positive samples are REPORTED, never silently
                absent from the ranking. */}
            {snapshot.observationNoResponseDids.length === 0 ? null : (
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                No response: {snapshot.observationNoResponseDids.map(formatHexDid).join(', ')}
              </Text>
            )}
            {snapshot.observationInsufficientDids.length === 0 ? null : (
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                Not enough samples to judge: {snapshot.observationInsufficientDids.map(formatHexDid).join(', ')}
              </Text>
            )}
            {snapshot.inconsistentCandidateDids.length === 0 ? null : (
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                Inconsistent response length (not ranked): {snapshot.inconsistentCandidateDids.map(formatHexDid).join(', ')}
              </Text>
            )}
          </View>
        )}

        {/* "Share results" addendum (binding, P4i). */}
        {snapshot === null || snapshot.responders.length === 0 ? null : (
          <View style={styles.card}>
            {shareBanner === null ? null : (
              <Text style={styles.successBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                {shareBanner}
              </Text>
            )}
            {/* X1 fix (P4i-FIX3, binding): "Share is enabled only once
                persisted or explicitly failed" -- disabled while the
                terminal checkpoint is still in flight (`persisting`); a
                failure still re-enables it immediately (results are already
                fully in memory either way). */}
            <Pressable
              style={styles.button}
              onPress={() => void handleShareResults()}
              disabled={sharing || snapshot.persisting}
              accessibilityRole="button"
              accessibilityLabel="Share results"
            >
              <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>
                {sharing ? 'Preparing…' : snapshot.persisting ? 'Saving…' : 'Share results'}
              </Text>
            </Pressable>
          </View>
        )}

        {snapshot === null || snapshot.suggestions.length === 0 ? null : (
          <View style={styles.card}>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              SUGGESTIONS
            </Text>
            {tagBanner === null ? null : (
              <Text style={styles.successBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                {tagBanner}
              </Text>
            )}
            {snapshot.suggestions.map((suggestion) => (
              <View key={suggestion.did} style={styles.suggestionRow}>
                <Text style={styles.responderDid} maxFontSizeMultiplier={1.3}>
                  {formatHexDid(suggestion.did)} — {suggestion.kind} ({(suggestion.confidence * 100).toFixed(0)}%,{' '}
                  {suggestion.decode})
                </Text>
                <Text style={styles.rationaleText} maxFontSizeMultiplier={1.3}>
                  {suggestion.rationale}
                </Text>
                {tagPickerDid === suggestion.did ? (
                  <View style={styles.channelPickerRow}>
                    {ENET_TAG_CHANNELS.map((channel) => (
                      <Pressable
                        key={channel}
                        style={styles.channelChip}
                        onPress={() => confirmTag(suggestion.did, channel)}
                        accessibilityRole="button"
                        accessibilityLabel={`Tag ${formatHexDid(suggestion.did)} as ${channel}`}
                      >
                        <Text style={styles.channelChipText} maxFontSizeMultiplier={1.3}>
                          {channel}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <Pressable
                    style={styles.buttonSecondary}
                    onPress={() => setTagPickerDid(suggestion.did)}
                    accessibilityRole="button"
                    accessibilityLabel={`Tag ${formatHexDid(suggestion.did)} as a channel`}
                  >
                    <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                      Tag as…
                    </Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}

        <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
          Adapter:{' '}
          {settings.telemetrySimulate
            ? 'simulated'
            : `${settings.enetHost || '(no host)'} · tester 0x${formatHexByte(settings.enetTesterAddress)} → target 0x${formatHexByte(settings.enetTargetAddress)}`}
        </Text>
        <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
          Speed-like suggestions use GNSS speed from the current driving session when one is active; otherwise
          that shape simply won't score confidently.
        </Text>
        {running || observing ? (
          <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
            The adapter is reserved for this sweep (single-client rule) -- stop it before using telemetry or the DID probe.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  helperText: { ...typography.caption, color: colors.textMuted, lineHeight: 18 },
  sectionLabel: { ...typography.label, color: colors.textMuted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  fieldLabel: { ...typography.body, color: colors.textSecondary, flexShrink: 1 },
  fieldInput: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    minWidth: 90,
    textAlign: 'right',
  },
  fieldInputSmall: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    minWidth: 64,
    textAlign: 'right',
  },
  errorBanner: { ...typography.caption, color: colors.danger },
  successBanner: { ...typography.caption, color: colors.success },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  button: {
    flex: 1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  buttonText: { ...typography.body, color: colors.onAccent, fontFamily: fontFamily.bodySemibold },
  buttonSecondary: {
    flex: 1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  buttonSecondaryText: { ...typography.body, color: colors.textSecondary },
  buttonDanger: {
    flex: 1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  buttonDangerText: { ...typography.body, color: colors.danger, fontFamily: fontFamily.bodySemibold },
  // L 360pt (binding, Codex P4f-REV2 Low finding): the progress VALUE text
  // (e.g. "0xFFFF · 65536/65536 · 123.4 req/s") is the longest string this
  // screen renders in a padded row next to a label -- `flexShrink: 1` lets it
  // shrink/wrap instead of forcing the row wider than a 360pt screen; the
  // label side keeps its own `flexShrink: 1` too (both sides may need room).
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  progressLabel: { ...typography.caption, color: colors.textMuted, flexShrink: 1 },
  progressValue: {
    ...typography.caption,
    color: colors.textPrimary,
    fontFamily: fontFamily.monoSemibold,
    textAlign: 'right',
    flexShrink: 1,
    flexGrow: 0,
  },
  responderRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  responderDid: { ...typography.body, color: colors.textPrimary, fontFamily: fontFamily.monoSemibold },
  responderRaw: { ...typography.caption, color: colors.textSecondary, fontFamily: fontFamily.monoSemibold, textAlign: 'right', flexShrink: 1 },
  suggestionRow: { gap: spacing.xs, paddingVertical: spacing.xs },
  rationaleText: { ...typography.caption, color: colors.textMuted },
  channelPickerRow: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },
  channelChip: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  channelChipText: { ...typography.caption, color: colors.accent },
  // "responders collapsed with count + expand" / "static (collapsed)" (binding, P4i).
  collapseHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  // Range presets addendum (binding, P4i) -- small chip buttons, wraps on a 360pt screen.
  presetChip: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  presetChipText: { ...typography.caption, color: colors.textSecondary },
  // A3 (binding, coordinator addendum): the shortlist-preset chip row -- wraps
  // rather than clipping at 360pt / 1.3x (the preset labels are long).
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
