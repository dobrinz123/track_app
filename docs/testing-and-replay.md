# Testing and replay

How `packages/core` is tested, the deterministic fixture catalog it's tested against, how to run
the suites, how to drive the same fixtures on-device via `DevReplayScreen`, and the determinism
rules that make all of this reproducible.

## Test architecture

All tests live under `packages/core/test/`, run by Vitest (`packages/core/vitest.config.ts`,
`include: ['test/**/*.test.ts']`, `environment: 'node'`). As of this writing: **25 test files, 487
total test cases** (one file currently reports a failing assertion — see the note at the end of
this section; it is a performance-regression check owned by a concurrent work package, not a
correctness failure, and is unrelated to anything in this document's write set).

Four layers, by what a file actually exercises:

- **Unit** — a single module in isolation (pure functions or one class), fixture-driven or with
  hand-built inputs. The large majority of files: `geometry/{intersection,polyline,projection}`,
  `matching/{quality-evaluator,track-matcher}`, `calibration/calibration-engine`,
  `timing/{crossing-detector,lap-timing-engine}`, `statemachine/reducer`,
  `reference/{personal-best,live-delta-engine,build-reference-lap}`,
  `persistence/checkpointCodec`, `profile/{validation,loader}`.
- **Property-based** (`fast-check`) — layered on top of several of the unit files above rather than
  living in separate files: `geometry/intersection`, `geometry/polyline`, `geometry/projection`,
  `profile/loader`, `reference/build-reference-lap`, `reference/live-delta-engine`,
  `timing/lap-timing-engine`, and the dedicated `persistence/referenceLap.property.test.ts`
  (asserts `elapsedMsAtGrid` stays non-decreasing under randomized small regressions in synthetic
  telemetry — the property `buildReferenceLap`'s monotone-clamp logic in
  `docs/algorithms/live-delta.md` exists to guarantee).
- **Contract** — one assertion suite (`packages/core/test/persistence/contractSuite.ts`,
  `runRepositoryContractTests`) run **verbatim against every `LocalSessionRepository`
  implementation**: `persistence/inMemorySessionRepository.test.ts` (26 tests) and
  `persistence-sql/sqlSessionRepository.contract.test.ts` (29 tests — the shared contract suite
  plus SQL-specific cases: migration idempotence, the orphan-sweep sessionId-prefix case, atomic
  transaction rollback). This is what guarantees `InMemorySessionRepository` and
  `SqlSessionRepository` are behaviorally interchangeable (deep-copy reads, atomic PB replace,
  structural validation, last-write-wins telemetry — see `docs/persistence-model.md`).
- **Integration** — drives multiple real modules together through their production wiring, not a
  mock: `controller/sessionController.test.ts` (7 tests, full `SessionController` against
  `FakeLocationProvider`/`FakeClock`/`FakeWatchdogScheduler` — see `controller/testSupport.ts`),
  `controller/sqlSettingsMigration.test.ts` (3 tests, opens a real sql.js-backed
  `SqlSessionRepository` and settings table across a v1→v2 upgrade), `replay/replay-harness.integration.test.ts`
  (16 tests, drives named fixture scenarios through `runSessionPipeline` against the real bundled
  TMR profile asset), `profile/tmr-profile.asset.test.ts` (5 tests, loads and validates the actual
  bundled `assets/circuits/transilvania-motor-ring.v1.json`), and `contracts.smoke.test.ts` (2
  tests — the package's public export surface stays import-clean).
- **Performance/benchmark** (not part of this document's normal coverage — flagged separately) —
  `geometry/benchmark.test.ts` (1 test, hinted-projection throughput) and
  `test/perf/core-pipeline.benchmark.test.ts` (3 tests: matcher throughput, `LiveDeltaEngine.onMatch`
  throughput, pipeline memory footprint). The latter directory is the concurrent performance work
  package's territory (`docs/verification/performance.md`, out of this ticket's write set); at the
  time of writing one of its three assertions (`>= 3x` speedup over forced full search) fails on
  this machine (measured `2.57x`) — a machine-dependent performance regression, not a correctness
  bug, and not something this ticket touches or fixes.

## Fixture catalog (`packages/core/src/fixtures/scenarios.ts`)

Every scenario wraps `driveLap()`/`sampleAtLapDistance()` (`fixtures/drive-lap.ts`) — a
deterministic kinematic drive around the **real** circuit centerline — with
`FixtureMetadata {scenario, seed, expectedOutcome}` attached (`withFixtureMetadata`). All take a
`CircuitProfile` and an optional seed/options argument.

| Scenario | Exercises | Expected outcome |
|---|---|---|
| `cleanRecognitionLap` | full-lap calibration | accepted, correct direction, ≥95% coverage |
| `multiLapSession(laps)` | continuous multi-lap timing | exactly `laps` complete, valid laps |
| `pbImprovementSession` | PB replacement | 3 laps at increasing speed (36/41/48 m/s); lap 3 replaces the PB |
| `slowerLapSession` | PB rejection + positive delta | lap 2 (36 m/s) slower than lap 1 (48 m/s), cannot replace it |
| `noisyGpsLap` | matcher robustness | 8 m Gaussian position noise + 8 m reported accuracy; lowers confidence, stays deterministic |
| `signalLossLap` | GNSS-gap propagation | a 15 s mid-lap gap invalidates the affected lap `LOW_QUALITY` |
| `impossibleJumpLap` | impossible-speed rejection | a 500 m mid-lap teleport is rejected, emits no crossing |
| `startLineJitterLap` | gate debounce/rearm | five ±3 m oscillations across start/finish count as exactly one forward crossing |
| `reverseTravelLap` | reverse progress | no lap completes; the open lap is `REVERSE_TRAVEL` invalid |
| `pitLaneTransitLap` | real pit geometry | pit entry/exit gates fire, `inPit` is visited, the lap is `PIT_TRANSIT` invalid |
| `stoppedOnLineSession` | zero-motion line contact | 60 s stationary directly on the gate creates no duplicate start/finish crossings |
| `pauseResumeSession` | pause-state propagation | a 45 s position hold invalidates only the paused lap with `PAUSE_GAP`; lap 2 stays valid |
| `outOfOrderTimestampsLap` | timestamp validation | one swapped non-increasing timestamp pair is rejected; later samples still process |
| `lowQualitySamplesLap` | accuracy grading | 30–60 m reported accuracy surfaces as `unreliable`/`invalid`, never silently `good` |
| `wraparoundSession` | progress-zero unwrapping | starting 50 m before the line, the early interpolated S/F crossing opens a lap and unwrapped progress crosses zero monotonically |

`driveLap()` itself (used directly by `wraparoundSession`/`pbImprovementSession`/etc. and available
standalone) is the base generator: configurable sample rate, Gaussian position noise, per-sample
accuracy (constant or a function of sample index), start offset, end padding, direction, lap count,
a speed profile (constant or a function of `{distanceM, progress, lapIndex}`), and an optional
lateral racing-line offset function.

## How to run the suites

From the repo root:

```
npm test                                  # vitest run in packages/core (all suites above)
npm run typecheck                         # tsc --noEmit across all workspaces
npm run lint                              # eslint . (flat config, both workspaces)
```

From `packages/core` directly, Vitest's own CLI filtering works normally, e.g.
`npx vitest run test/timing` or `npx vitest run -t "PAUSE_GAP"`.

## How to use `DevReplayScreen` on-device

`apps/mobile/src/ui/screens/DevReplayScreen.tsx` is a `__DEV__`-gated screen that drives the
**real, production** `SessionController` (not a mock) with a bundled `@circuit/core` fixture
scenario, through the same real Calibration/Dashboard screens a live GNSS session uses. Steps:

1. Run the dev loop (`npx expo start` from `apps/mobile`, Expo Go on the phone — see the README
   Quickstart / `docs/ios-no-mac-workflow.md`).
2. Navigate to **Settings** (bottom of the `CircuitSelection` → `CircuitDetail` flow, or directly
   via the tab/stack), then tap **"Dev: Replay Fixtures"** — only visible when `__DEV__` is true.
3. Pick a fixture row (Clean recognition lap / Three timed laps / PB improvement / Noisy GPS /
   Signal loss / Reverse travel / Pit lane transit — the seven scenarios `DevReplayScreen` lists;
   see its `SCENARIOS` array for the exact seeds used, e.g. `cleanRecognitionLap(profile, 901)`).
4. This calls `startDevReplaySession(samples)` (`session/composition.ts:351-373`), which builds a
   **fresh `SessionController`** wired to a `ReplayLocationProvider` (10x accelerated,
   `speedFactor: 10`) wrapped in `LiveTimestampedLocationProvider` (re-stamps each replayed
   sample's `tMono` to the live clock at delivery time, so `currentLapMs` ticks the same way a live
   GNSS session's clock-based display would) over the **same real repository/profile/user** as the
   production controller, then swaps it in as the app's active `facade`.
5. The screen navigates to `CalibrationInstructions` — from there it's the real
   Calibration Instructions → Active Calibration → Calibration Result → Active Dashboard flow,
   indistinguishable from a live session, except the "GNSS" samples are the fixture's.
6. Results land in the **real on-device SQLite history** (same repository), visible afterward in
   Session History / Personal Best like any other session.
7. **"Scripted mock (no real pipeline)"** is a separate toggle (`useMockFacadeForDevReplay()`) that
   swaps the app back to a fully scripted `MockSessionFacade` for pure UI/style iteration — no
   pipeline, no persistence.

## How `runSessionPipeline` is used for new tests

`runSessionPipeline(runtimeProfile, samples, config)` (`packages/core/src/replay/replay-harness.ts`)
is the batch entry point new tests should use to drive a fixture through the full production
pipeline (quality → matcher → crossings → state machine → lap/sector timing → live delta), via the
same `SessionPipelineCore` the live `SessionController` uses (`controller/pipelineCore.ts` — see
that module's own doc comment for why this sharing matters: the two consumers can never
independently reimplement, and diverge on, the pipeline order).

Minimal pattern (mirrors `replay-harness.integration.test.ts`):

```ts
import { loadProfileFromJson } from '../../src/profile';
import { cleanRecognitionLap } from '../../src/fixtures';
import { runSessionPipeline } from '../../src/replay';

const { runtime, profile } = /* load the TMR asset, see tmr() helper in the integration test */;
const samples = cleanRecognitionLap(profile, 42);          // deterministic, seed = 42
const result = runSessionPipeline(runtime, samples, {
  calibrateFirst: samples,   // omit to start pre-calibrated instead
  referenceLap: null,        // or a built ReferenceLap to exercise live delta
});
// result.laps, result.crossings, result.finalState, result.deltas, result.diagnostics
```

`config.calibrateFirst` (omit to start pre-calibrated via a synthetic always-accepted result),
`config.referenceLap` (feeds the live delta engine), and all five engines' own config overrides
(`quality`, `matcher`, `crossings`, `timing`, `delta`) are available on `ReplayHarnessConfig`.
`runCalibration(runtimeProfile, samples, config)` is the lower-level entry point for calibration
alone, used internally by `runSessionPipeline` when `calibrateFirst` is supplied and directly by
`calibration-engine.test.ts`-style tests that only care about the calibration verdict.

## Determinism rules

- **Seeded PRNG, never `Math.random()` in fixtures.** `SeededPrng` (`fixtures/prng.ts`) is a
  32-bit linear-congruential generator (`state = (1_664_525 * state + 1_013_904_223) mod 2^32`)
  with a Box-Muller `gaussian()` built on top of `next()`. Every fixture that adds noise
  (`driveLap`'s `noiseSigmaM`) takes an explicit `seed` and is bit-for-bit reproducible from it —
  the same seed always produces the same telemetry.
- **No `Date.now()` anywhere in the pipeline.** Every duration-bearing computation uses `tMono`
  (monotonic ms), stamped by fixtures as a synthetic counter (`driveLap`'s `tMono`/`intervalMs`
  progression) rather than wall-clock time — see `docs/algorithms/timing-and-crossings.md`'s
  monotonic-time rules. This is what makes a fixture's output identical on every run and every
  machine, independent of when the test actually executes.
- **Fixture metadata is non-enumerable and frozen** (`withFixtureMetadata`,
  `Object.defineProperty(..., {enumerable: false, writable: false, value: Object.freeze(...)})`) —
  it travels with the sample array without being iterated over by anything that spreads/maps the
  array, and cannot be mutated after creation.
- **Real profile, not a synthetic one.** Every fixture is generated against the actual
  `CircuitProfile` (loaded from the bundled TMR asset in integration tests, or passed in directly)
  — there is no separate "test track" geometry, so replay behavior is validated against the same
  gates/centerline production code runs against.
