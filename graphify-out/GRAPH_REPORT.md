# Graph Report - D:/CODE/APLICTIE_Circuit  (2026-08-10)

## Corpus Check
- 254 files · ~213,771 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1778 nodes · 4074 edges · 144 communities (79 shown, 65 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 137 edges (avg confidence: 0.81)
- Token cost: 69,000 input · 21,500 output

## Community Hubs (Navigation)
- Telemetry Fixtures & Replay Scenarios
- TMR Geometry Verification Script
- Composition Facade Wrappers
- Real Session Facade
- SQL Settings Store
- TMR Profile Generator
- Composition Bootstrap Root
- Architecture & Algorithm Docs
- iOS Distribution Decisions
- Work-Package Tickets & Pipeline
- Session Repository & History
- Expo App Config
- Dashboard Display Components
- Geo Projection & Profile Loader
- UI Interaction Components
- Calibration Engine Config
- Monotonic Clock & Watchdog
- Monorepo Package Manifests
- Geometry Intersection Math
- Lap Timing Engine
- Crossing Detector
- History Store Wrappers
- Brand & Sector UI Components
- Track Matcher
- calibration-engine
- sqlJsDatabase
- gnssLocationProvider.reverted
- preflight
- PreflightScreen
- composition.lifecycle.test
- package
- live-delta-engine
- catalog
- liveTimestampedProvider
- build-reference-lap
- reducer.test
- SettingsScreen
- contracts
- inMemorySessionRepository
- replayLocationProvider
- package
- checkpointCodec
- personal-best
- sqlSessionRepository
- coreTestDoubles
- pipelineCore
- package
- LAP_VIEW
- migration
- fixtures
- track-day.soak.test
- tsconfig.base
- tmrProfile
- ticket-wp-wordmark
- motionCapture
- package
- gnssLocationProvider
- gnssLocationProvider
- referenceLap.property.test
- tsconfig
- ledger
- permissions
- gnssLocationProvider.test
- pipelineCore
- icon
- liveTimestampedProvider.test
- realFacade.test
- ticket-wp4b-tmr-profile
- App
- splash-icon
- metro.config
- preflight.test
- tsconfig
- .prettierrc
- android-icon-foreground
- favicon
- trace_logo_icon
- trace_logo_mark
- lifecycle
- tsconfig
- android-icon-background
- android-icon-monochrome
- ledger
- platform-research
- platform-research
- ticket-wp-apptests
- package
- package
- package
- package
- package
- package
- package
- package
- package
- package
- package
- package
- package
- package
- package
- package
- branding
- ticket-wp10-replay
- ticket-wp11a-persistence-core
- ticket-wp11a-persistence-core
- ticket-wp12-platform
- ticket-wp12-platform
- ticket-wp4b-tmr-profile
- ticket-wp5-geometry
- ticket-wp6-timing
- build-unsigned-ios
- ticket-wp10-replay
- ticket-wp10-replay
- ticket-wp11b-sqlite
- ticket-wp11b-sqlite
- ticket-wp12-platform
- ticket-wp12-platform
- ticket-wp12-platform
- ticket-wp12b-ios
- ticket-wp13a-ui
- ticket-wp13a-ui
- ticket-wp13a-ui
- ticket-wp14-integration
- ticket-wp14-integration
- ticket-wp4-schema
- ticket-wp4-schema
- ticket-wp4b-tmr-profile
- ticket-wp6-timing
- ticket-wp7-calibration
- ticket-wp7-calibration
- ticket-wp7-calibration
- ticket-wp8-statemachine
- ticket-wp9-delta
- ticket-wp-ui-redesign
- ticket-wp-wordmark
- build-unsigned-ios
- build-unsigned-ios
- README
- README
- README

## God Nodes (most connected - your core abstractions)
1. `LocationSample` - 74 edges
2. `LapRecord` - 46 edges
3. `SessionController` - 45 edges
4. `ReferenceLap` - 38 edges
5. `LocalPoint` - 36 edges
6. `CircuitProfile` - 30 edges
7. `RuntimeProfile` - 30 edges
8. `CalibrationEngine` - 28 edges
9. `LocalSessionRepository` - 28 edges
10. `driveLap()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `WP12 Mobile Platform Integration Task` --semantically_similar_to--> `Expo SDK 57 changed-docs verification notice`  [INFERRED] [semantically similar]
  .foreman/scratch/ticket-wp12-platform.md → apps/mobile/AGENTS.md
- `WP12b iOS Platform Hardening Task` --semantically_similar_to--> `Expo SDK 57 changed-docs verification notice`  [INFERRED] [semantically similar]
  .foreman/scratch/ticket-wp12b-ios.md → apps/mobile/AGENTS.md
- `DeltaDisplayProps` --references--> `DeltaUpdate`  [EXTRACTED]
  apps/mobile/src/ui/components/DeltaDisplay.tsx → packages/core/src/contracts.ts
- `WP Wordmark Task` --references--> `TRACE full logo (squircle container: metallic-silver T chassis + glowing amber apex racing curve)`  [EXTRACTED]
  .foreman/scratch/ticket-wp-wordmark.md → apps/mobile/assets/trace_logo.svg
- `TraceWordmark component` --references--> `TRACE full logo (squircle container: metallic-silver T chassis + glowing amber apex racing curve)`  [EXTRACTED]
  .foreman/scratch/ticket-wp-wordmark.md → apps/mobile/assets/trace_logo.svg

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Pre-install verification and fix campaign** — _foreman_ledger_pre_install_gate, _foreman_scratch_ticket_preinstall_codex_lifecycle_cross_review, _foreman_scratch_ticket_wp_lifecycle_fix_wave_1, _foreman_scratch_ticket_fixwave_codex_verify_fixwave1_reverification, _foreman_scratch_ticket_wp_lifecycle2_fix_wave_2, _foreman_scratch_ticket_final_codex_verify_final_cross_family_verdict [EXTRACTED 1.00]
- **Security review-and-fix loop** — _foreman_scratch_ticket_wp_security_security_review_ticket, _foreman_scratch_security_review_findings_security_review_report, _foreman_scratch_ticket_wp_secfix_security_fix_wave, _foreman_scratch_security_review_findings_m1_profile_dos, _foreman_scratch_security_review_findings_m2_telemetry_accumulation, _foreman_scratch_security_review_findings_m3_missing_deletion_ui [EXTRACTED 1.00]
- **Free iOS install path (ADR-0005 flow)** — _foreman_scratch_free_ios_install_research_expo_go_retirement, _foreman_scratch_free_ios_install_research_unsigned_ipa_route, _foreman_scratch_free_ios_install_research_github_actions_macos, _foreman_scratch_free_ios_install_research_sideloadly, _foreman_scratch_free_ios_install_research_seven_day_resign_cycle, _foreman_scratch_ticket_wp_freeios_unsigned_ios_ci [EXTRACTED 1.00]
- **TMR circuit profile generation + validation pipeline** — foreman_scratch_ticket_wp4_schema_loadprofilefromjson, foreman_scratch_ticket_wp4b_tmr_profile_generator_script, foreman_scratch_ticket_wp5_geometry_createprojection, foreman_scratch_tmr_geometry_check_report [INFERRED 0.85]
- **Production session pipeline composition (matcher/calibration/timing/statemachine/delta/controller)** — foreman_scratch_ticket_wp10_replay_replayharness, foreman_scratch_ticket_wp14_integration_sessioncontroller, foreman_scratch_ticket_wp6_timing_laptimingengine, foreman_scratch_ticket_wp7_calibration_calibrationengine, foreman_scratch_ticket_wp8_statemachine_reducer, foreman_scratch_ticket_wp9_delta_livedeltaengine [INFERRED 0.85]
- **TRACE brand visual identity system (logo marks + wordmark + palette)** — apps_mobile_assets_trace_logo_svg_mark, apps_mobile_assets_trace_logo_mark_svg, foreman_scratch_ticket_wp_wordmark_tracewordmark, foreman_scratch_ticket_wp_ui_redesign_palette [INFERRED 0.85]
- **iOS free install path decision chain** — docs_decisions_adr_0004_no_mac_ios_workflow, docs_decisions_adr_0005_free_install_path, docs_ios_no_mac_workflow, docs_verification_real_track_validation_checklist [EXTRACTED 1.00]
- **Core timing pipeline documentation set** — docs_architecture_contracts, docs_algorithms_calibration, docs_algorithms_timing_and_crossings, docs_algorithms_live_delta [EXTRACTED 1.00]
- **TMR geometry provenance chain (research to onboarding rules)** — docs_research_transilvania_motor_ring, docs_decisions_adr_0002_circuit_geometry_source, docs_adding_a_circuit, docs_research_transilvania_motor_ring_circuit [EXTRACTED 1.00]
- **Live Timing Display Group (timer, sectors, last lap, personal best, speed)** — lap_view_current_lap_timer, lap_view_sector_indicators, lap_view_last_lap_readout, lap_view_personal_best_readout, lap_view_speed_readout [EXTRACTED 1.00]
- **GNSS-Derived Telemetry Elements** — lap_view_gnss_status_indicator, lap_view_current_lap_timer, lap_view_speed_readout, lap_view_sector_indicators [INFERRED 0.85]
- **TRACE Icon Visual Composition** — apps_mobile_assets_icon_metallic_t_monogram, apps_mobile_assets_icon_amber_telemetry_trace, apps_mobile_assets_icon_dark_squircle_background [EXTRACTED 1.00]
- **Visual elements forming the TRACE splash-icon identity** — apps_mobile_assets_splash_icon_chrome_t_letterform, apps_mobile_assets_splash_icon_neon_racing_line, apps_mobile_assets_splash_icon_dark_theme_palette [EXTRACTED 1.00]
- **TRACE Logo Mark Composition** — apps_mobile_assets_trace_logo_mark_logo, apps_mobile_assets_trace_logo_mark_metallic_t_letterform, apps_mobile_assets_trace_logo_mark_amber_racing_line [EXTRACTED 1.00]

## Communities (144 total, 65 thin omitted)

### Community 0 - "Telemetry Fixtures & Replay Scenarios"
Cohesion: 0.09
Nodes (47): load(), driveLap(), DriveLapOptions, FixtureMetadata, modulo(), pointAtRawDistance(), resolvedSpeed(), runtimeFor() (+39 more)

### Community 1 - "TMR Geometry Verification Script"
Cohesion: 0.05
Nodes (55): allPoints, area, arrowSvg, assertions, asset, assetPath, bbox, centerEs (+47 more)

### Community 2 - "Composition Facade Wrappers"
Cohesion: 0.06
Nodes (7): currentControllerState(), gateErrorMessage(), PendingFacade, SwappableFacade, FacadeState, SessionFacade, MockSessionFacade

### Community 3 - "Real Session Facade"
Cohesion: 0.07
Nodes (11): errorMessage(), mapState(), RealSessionFacade, RealSessionFacadeCallbacks, ADR-0003, cancelledCalibrationResult(), randomToken(), recoverySkippedCalibrationResult() (+3 more)

### Community 4 - "SQL Settings Store"
Cohesion: 0.06
Nodes (21): isPartialAppSettings(), SqlSettingsStore, SwappableSettingsStore, AppSettings, CoverageBinsSetting, DEFAULT_SETTINGS, InMemorySettingsStore, SettingsStore (+13 more)

### Community 5 - "TMR Profile Generator"
Cohesion: 0.08
Nodes (45): absoluteTurningAngle(), centerlineCurvatureAtDistance(), centerlineVertexCurvatures(), centroid(), closedLength(), ClosedProjection, createLocalProjection(), cumulativeDistances() (+37 more)

### Community 6 - "Composition Bootstrap Root"
Cohesion: 0.08
Nodes (45): activateProductionFacade(), appVersion(), bootstrapPromise, BootstrapState, bootstrapStateListeners, buildProductionController(), createProductionController(), devReplayLock (+37 more)

### Community 7 - "Architecture & Algorithm Docs"
Cohesion: 0.10
Nodes (48): Mobile App CLAUDE.md (Expo v57 docs pointer), Adding a Circuit (onboarding process doc), Generator Script Pattern, layoutVersion Discipline, Never-Fabricate Provenance Rules, Calibration (Learn Lap) Algorithm Doc, Bounded Bias Estimation, Coverage Bins (25 m monotonic centerline coverage) (+40 more)

### Community 8 - "iOS Distribution Decisions"
Cohesion: 0.05
Nodes (45): Bundle id freeze (app.circuittimer.tmr), Expo Go dev-only / standalone on-track decision, FINAL-VERIFY campaign (515/515 tests), App name decision: TRACE, AltStore Classic, EU DMA sideloading allowance (Romania), Expo Go SDK 57 absent from iOS App Store, Free personal-team entitlement limits (+37 more)

### Community 9 - "Work-Package Tickets & Pipeline"
Cohesion: 0.05
Nodes (45): Expo SDK 57 changed-docs verification notice, ReplayHarness (runSessionPipeline), runSessionPipeline(runtimeProfile, samples, config) function, WP10 Replay Harness Task, Atomic PB replace semantics (putReferenceLap), Deep-copy read semantics (getReferenceLap), WP11a Persistence Core Task, Orphan sessionId cleanup rule (${userId}--<random> prefix) (+37 more)

### Community 10 - "Session Repository & History"
Cohesion: 0.09
Nodes (7): deleteAllStoredUserData(), syntheticLapFromReference(), LocalSessionRepository, SessionSummary, deleteAllUserData(), ControllableRepository, RecordingRepository

### Community 11 - "Expo App Config"
Cohesion: 0.06
Nodes (34): backgroundColor, backgroundImage, foregroundImage, monochromeImage, adaptiveIcon, package, permissions, predictiveBackGestureEnabled (+26 more)

### Community 12 - "Dashboard Display Components"
Cohesion: 0.11
Nodes (26): sessionHistoryStore, DeltaDisplay(), DeltaDisplayProps, styles, COLOR, LABEL, QualityPill(), styles (+18 more)

### Community 13 - "Geo Projection & Profile Loader"
Cohesion: 0.13
Nodes (21): GeoProjection, polylineLength(), createProjection(), MAX_PROFILE_JSON_BYTES, gateAt(), makeTestProfile(), superellipsePoint(), TEST_ORIGIN (+13 more)

### Community 14 - "UI Interaction Components"
Cohesion: 0.11
Nodes (26): facade, LongPressButton(), LongPressButtonProps, styles, ProgressRing(), ProgressRingProps, StatusBanner(), StatusBannerProps (+18 more)

### Community 15 - "Calibration Engine Config"
Cohesion: 0.15
Nodes (21): CalibrationConfig, DEFAULT_CONFIG, TelemetryQualityEvaluator, PipelineCoreConfig, SessionControllerConfig, DEFAULT_TELEMETRY_QUALITY_CONFIG, distanceM(), LEVEL_RANK (+13 more)

### Community 16 - "Monotonic Clock & Watchdog"
Cohesion: 0.08
Nodes (13): PerformanceNowClock, ADR-0003, MonotonicClock, SessionControllerDeps, WatchdogScheduler, ProjectedGate, RuntimeProfile, FakeClock (+5 more)

### Community 17 - "Monorepo Package Manifests"
Cohesion: 0.06
Nodes (30): eslint, eslint-config-prettier, @eslint/js, globals, description, devDependencies, eslint, eslint-config-prettier (+22 more)

### Community 18 - "Geometry Intersection Math"
Cohesion: 0.18
Nodes (21): adjacentFloat(), cross(), crossingDirection(), crossTolerance(), interpolateCrossingTime(), segmentIntersection, circularDistance(), modulo() (+13 more)

### Community 19 - "Lap Timing Engine"
Cohesion: 0.13
Nodes (14): QualityPillProps, CrossingEvent, LapTimingEngine, QualityLevel, SectorTime, ActiveLap, isLowQuality(), LapTimingEngine (+6 more)

### Community 20 - "Crossing Detector"
Cohesion: 0.12
Nodes (18): CrossingDetector, Gate, CrossingDetector, interpolate(), isTimingGate(), nonNegativeFinite(), ProjectedGate, LapTimingProfile (+10 more)

### Community 21 - "History Store Wrappers"
Cohesion: 0.13
Nodes (9): SwappableSessionHistoryStore, lap(), MOCK_SESSIONS, MockSessionHistoryStore, PersonalBestEntry, sectorTimes(), SessionHistoryStore, StoredSession (+1 more)

### Community 22 - "Brand & Sector UI Components"
Cohesion: 0.10
Nodes (20): SectorBar(), SectorBarProps, styles, styles, TraceLogo(), TraceLogoProps, GLOW, LETTER_COLORS (+12 more)

### Community 23 - "Track Matcher"
Cohesion: 0.14
Nodes (14): AcceptedPoint, LocalPoint, TrackMatcher, PolylineProjection, circularDistance(), clamp01(), DEFAULT_CONFIG, hintedSegmentIndices() (+6 more)

### Community 24 - "calibration-engine"
Cohesion: 0.13
Nodes (6): CalibrationEngine, clamp01(), inferredDirection(), mean(), percentile95(), CalibrationEngine

### Community 25 - "sqlJsDatabase"
Cohesion: 0.18
Nodes (17): createSqliteSessionRepository(), openAppDatabase(), wrapExpoSqliteDatabase(), SQL_DDL, SQL_DDL_V2, SQL_SCHEMA_VERSION, SqlBindValue, SqlDatabase (+9 more)

### Community 26 - "gnssLocationProvider.reverted"
Cohesion: 0.11
Nodes (17): AccuracyDistributionSummary, computeAccuracyDistribution(), computeIntervalHistogram(), GnssDiagnostics, GnssLocationProvider, INTERVAL_BUCKET_UPPER_BOUNDS_MS, SampleIntervalBucket, ADR-0003 (+9 more)

### Community 27 - "preflight"
Cohesion: 0.18
Nodes (21): BATTERY_CRITICAL_THRESHOLD, BatteryCheckResult, BatteryModuleLike, collectBatteryCheck(), collectGnssFix(), collectKeepAwakeActivatable(), collectLocationServicesEnabled(), collectPermissionGranted() (+13 more)

### Community 28 - "PreflightScreen"
Cohesion: 0.13
Nodes (19): Stack, RootStackParamList, CalibrationInstructionsScreen(), Props, STEPS, styles, CalibrationResultScreen(), explain() (+11 more)

### Community 29 - "composition.lifecycle.test"
Cohesion: 0.12
Nodes (14): bootFresh(), driveOneFullSession(), feed(), flushBootstrap(), freshSessionControllerClass(), latestFacadeState(), seeded, StubClock (+6 more)

### Community 30 - "package"
Cohesion: 0.08
Nodes (23): fast-check, dependencies, zod, devDependencies, fast-check, sql.js, @types/sql.js, typescript (+15 more)

### Community 31 - "live-delta-engine"
Cohesion: 0.14
Nodes (10): LiveDeltaEngine, TrackMatch, CORE_PACKAGE_ID, bounded(), clamp01(), cloneReference(), LiveDeltaEngine, nonNegative() (+2 more)

### Community 32 - "catalog"
Cohesion: 0.16
Nodes (14): AppCircuitCatalog, CircuitCatalog, CircuitCatalogEntry, CircuitCatalogError, circuitCatalogKey(), CircuitCatalogProfile, CircuitSummary, createCircuitCatalog() (+6 more)

### Community 33 - "liveTimestampedProvider"
Cohesion: 0.15
Nodes (6): ReplayTimeSource, ReplayTimestampedLocationProvider, ScaledReplayClock, ADR-0003, ADR-0003, LocationProvider

### Community 34 - "build-reference-lap"
Cohesion: 0.16
Nodes (20): buildReferenceLap(), BuildReferenceLapBase, BuildReferenceLapInput, BuildReferenceLapResult, failure(), gridFor(), interpolate(), interpolationPoints() (+12 more)

### Community 35 - "reducer.test"
Cohesion: 0.17
Nodes (18): SessionReducer, createInitialSessionSnapshot(), ctxOf(), SessionContext, sessionReducer(), SessionSnapshot, startLap(), withReason() (+10 more)

### Community 36 - "SettingsScreen"
Cohesion: 0.13
Nodes (16): GnssDiagnostics, estimateObservedRateHz(), getLiveDiagnostics(), LiveDiagnosticsSnapshot, settingsStore, useSettings(), DevReplayScreen(), Props (+8 more)

### Community 37 - "contracts"
Cohesion: 0.17
Nodes (15): LAP_SCRIPTS, LapScript, CalibrationDiagnostics, CalibrationResult, DeltaUpdate, FixSource, LapRecord, SessionPipelineResult (+7 more)

### Community 38 - "inMemorySessionRepository"
Cohesion: 0.19
Nodes (7): DeleteUserDataResult, InMemorySessionRepository, referenceLapKey(), telemetryKey(), telemetryKeyPrefix(), assertJsonSerializable(), validateReferenceLap()

### Community 39 - "replayLocationProvider"
Cohesion: 0.17
Nodes (4): ReplayLocationProvider, ReplayOptions, LocationSample, FakeLocationProvider

### Community 40 - "package"
Cohesion: 0.13
Nodes (15): dependencies, @circuit/core, expo, expo-font, @expo-google-fonts/jetbrains-mono, expo-keep-awake, react-native, @react-native-masked-view/masked-view (+7 more)

### Community 41 - "checkpointCodec"
Cohesion: 0.19
Nodes (9): SessionMachineSnapshot, CHECKPOINT_SCHEMA_VERSION, CheckpointCodec, CheckpointPayload, isLapRecordShape(), isPlainObject(), isSerializedCheckpoint(), SerializedCheckpoint (+1 more)

### Community 42 - "personal-best"
Cohesion: 0.23
Nodes (12): ReferenceLap, hasFullReferenceGrid(), hasProvenance(), PersonalBestCandidate, PersonalBestCandidateAliases, PersonalBestCandidateInput, sectorsAreCompleteAndOrdered(), shouldReplacePb() (+4 more)

### Community 44 - "coreTestDoubles"
Cohesion: 0.16
Nodes (3): FakeClock, FakeLocationProvider, feedSamples()

### Community 45 - "pipelineCore"
Cohesion: 0.26
Nodes (8): QualityAssessment, createPipelineComponents(), MatchedTelemetrySample, PipelineComponents, projectedGates(), RejectedTelemetrySample, SampleIngestResult, InspectedMatch

### Community 46 - "package"
Cohesion: 0.17
Nodes (11): devDependencies, @types/react, typescript, vitest, typescript, vitest, main, name (+3 more)

### Community 47 - "LAP_VIEW"
Cohesion: 0.21
Nodes (12): Current Lap Timer (0:00.000 monospaced display), Delta Bar (Seconds vs. Reference), Delta-to-Reference Timing Concept, Hold to End Session Button (red outline, hold-to-confirm), Glanceable Dark High-Contrast UI Design, GNSS Status Indicator (GNSS GOOD pill), Lap Counter (LAP 0), Last Lap Readout (placeholder --:--.---) (+4 more)

### Community 48 - "migration"
Cohesion: 0.20
Nodes (10): isObject(), JsonObject, migrateProfile(), Migration, migrations, circuitProfileSchema, CURRENT_SCHEMA_VERSION, finiteNumber (+2 more)

### Community 49 - "fixtures"
Cohesion: 0.55
Nodes (7): NOTE: sweeping orphan checkpoints/telemetry for sessionIds minted as, runRepositoryContractTests(), makeLapRecord(), makeLocationSample(), makeReferenceLap(), makeSessionSummary(), makeSnapshot()

### Community 50 - "track-day.soak.test"
Cohesion: 0.20
Nodes (3): controllerRig, SoakClock, SoakLocationProvider

### Community 51 - "tsconfig.base"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule (+3 more)

### Community 52 - "tmrProfile"
Cohesion: 0.33
Nodes (7): circuitCatalog, CircuitSummary, ENTRIES, loaded, TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE, ADR-0004

### Community 53 - "ticket-wp-wordmark"
Cohesion: 0.20
Nodes (10): TRACE logo mark (cropped, no container background), TRACE full logo (squircle container: metallic-silver T chassis + glowing amber apex racing curve), APP_NAME branding constant (branding.ts), TRACE dark palette (near-black + racing amber #FFB300), S1 CircuitSelectionScreen multi-circuit list rebuild, S1 brandRow lockup (logo + wordmark + kicker), WP Wordmark Task, Telemetry-line motif (gradient bar under wordmark) (+2 more)

### Community 54 - "motionCapture"
Cohesion: 0.20
Nodes (4): createMotionCapture(), MotionCapture, MotionCaptureOptions, MotionSample

### Community 55 - "package"
Cohesion: 0.22
Nodes (9): scripts, android, export:android, export:ios, ios, start, test, typecheck (+1 more)

### Community 56 - "gnssLocationProvider"
Cohesion: 0.25
Nodes (7): AccuracyDistributionSummary, computeAccuracyDistribution(), computeIntervalHistogram(), INTERVAL_BUCKET_UPPER_BOUNDS_MS, SampleIntervalBucket, ADR-0003, WATCH_OPTIONS

### Community 58 - "referenceLap.property.test"
Cohesion: 0.22
Nodes (6): CIRCUIT_IDS, LAYOUT_IDS, LAYOUT_VERSIONS, Op, opArb, USER_IDS

### Community 59 - "tsconfig"
Cohesion: 0.22
Nodes (8): compilerOptions, outDir, rootDir, extends, include, src/**/*.ts, test/**/*.ts, ../../tsconfig.base.json

### Community 60 - "ledger"
Cohesion: 0.39
Nodes (8): Pre-install Gate (2026-08-09), WP-lifecycle outcome (TRACE-release-FINAL ipa), expo-keep-awake usage, Final Codex cross-family verdict ticket (fix wave 2 residue), Codex re-verification of fix wave 1 (C1-C11 + B1/B4), Pre-install adversarial lifecycle review (produced C1-C11), Fix wave 2 residue closure (F1-F6), Pre-install fix wave 1 (WP-lifecycle, C1-C11 + B1/B4)

### Community 61 - "permissions"
Cohesion: 0.29
Nodes (7): LOCATION_PERMISSION_RATIONALE, PermissionOutcome, PermissionState, PRECISE_LOCATION_INSTRUCTIONS, requestForegroundLocationPermission(), toOutcome(), ADR-0003

### Community 62 - "gnssLocationProvider.test"
Cohesion: 0.29
Nodes (6): createdSubscriptions, FakeSubscription, makeSubscription(), PendingWatchCall, resolveWatchCall(), watchCalls

### Community 64 - "icon"
Cohesion: 0.47
Nodes (6): TRACE App Icon (icon.png), Amber Neon Telemetry Trace, Dark Squircle Background, Metallic T Monogram, Motorsport Night-Mode Aesthetic, TRACE Brand Identity

### Community 67 - "ticket-wp4b-tmr-profile"
Cohesion: 0.40
Nodes (6): Pit entry/exit determination rule from travel-direction geometry, Sector gate rule: perpendicular gates at 1/3 and 2/3 of totalLengthM, S/F gate placement rule (pit-lane midpoint projected onto centerline), TMR Geometry Verification Report, Sanity assertions (closed loop, S/F gate distance, sector 1/3-2/3, direction match -- all PASS), TMR geometry verification diagram (north-up centerline, pit lane, gates, direction arrows)

### Community 68 - "App"
Cohesion: 0.50
Nodes (3): App(), navigationTheme, RootNavigator()

### Community 69 - "splash-icon"
Cohesion: 0.50
Nodes (5): TRACE Splash Icon (app icon artwork), Chrome/silver outlined T letterform, Dark near-black background with amber/yellow accent palette, Neon glowing racing-line tube motif, TRACE brand mark (racing line traces the letter T)

### Community 70 - "metro.config"
Cohesion: 0.40
Nodes (4): config, { getDefaultConfig }, path, workspaceRoot

### Community 72 - "tsconfig"
Cohesion: 0.40
Nodes (4): compilerOptions, strict, extends, expo/tsconfig.base

### Community 73 - ".prettierrc"
Cohesion: 0.40
Nodes (4): printWidth, semi, singleQuote, trailingComma

### Community 74 - "android-icon-foreground"
Cohesion: 0.83
Nodes (4): Android Adaptive Icon Foreground (TRACE), Glossy Blue Gradient Treatment, Blue Chevron Apex Mark, TRACE Brand Identity

### Community 75 - "favicon"
Cohesion: 0.83
Nodes (4): TRACE Favicon (favicon.png), Amber-on-Black Brand Palette, Stylized Slanted T Letterform Glyph, TRACE App Brand Identity

### Community 76 - "trace_logo_icon"
Cohesion: 0.67
Nodes (4): TRACE App Icon (neon T on dark rounded square), Dark Brand Theme (near-black background, amber accent), Neon T Monogram, Racing-Line Motif (glowing curved stroke)

### Community 77 - "trace_logo_mark"
Cohesion: 0.83
Nodes (4): Amber Neon Racing-Line Trace, TRACE Logo Mark (transparent PNG), Metallic T Letterform, TRACE Lap-Timing App Brand Identity

### Community 78 - "lifecycle"
Cohesion: 0.50
Nodes (3): LifecycleCallbacks, LifecycleController, startLifecycleListener()

### Community 79 - "tsconfig"
Cohesion: 0.50
Nodes (3): compilerOptions, extends, expo/tsconfig.base

### Community 80 - "android-icon-background"
Cohesion: 1.00
Nodes (3): Android Adaptive Icon Background Layer, Blueprint Construction-Grid Motif, TRACE Brand Identity (precision lap timing)

### Community 81 - "android-icon-monochrome"
Cohesion: 1.00
Nodes (3): Android Adaptive Icon Monochrome Layer (Material You Themed Icon), TRACE Chevron Brand Mark (Monochrome Android Icon), TRACE Brand Identity

## Knowledge Gaps
- **404 isolated node(s):** `LatLon`, `Point`, `Gate`, `here`, `root` (+399 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **65 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `LocationSample` connect `replayLocationProvider` to `Telemetry Fixtures & Replay Scenarios`, `Real Session Facade`, `Composition Bootstrap Root`, `Session Repository & History`, `Geo Projection & Profile Loader`, `Calibration Engine Config`, `Monotonic Clock & Watchdog`, `Crossing Detector`, `Track Matcher`, `calibration-engine`, `sqlJsDatabase`, `gnssLocationProvider.reverted`, `composition.lifecycle.test`, `liveTimestampedProvider`, `contracts`, `inMemorySessionRepository`, `sqlSessionRepository`, `coreTestDoubles`, `pipelineCore`, `fixtures`, `track-day.soak.test`, `gnssLocationProvider`, `gnssLocationProvider`, `pipelineCore`, `liveTimestampedProvider.test`, `realFacade.test`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Why does `LocationProvider` connect `liveTimestampedProvider` to `Telemetry Fixtures & Replay Scenarios`, `liveTimestampedProvider.test`, `realFacade.test`, `contracts`, `Composition Bootstrap Root`, `replayLocationProvider`, `coreTestDoubles`, `Monotonic Clock & Watchdog`, `track-day.soak.test`, `gnssLocationProvider`, `gnssLocationProvider`, `gnssLocationProvider.reverted`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `LocalSessionRepository` connect `Session Repository & History` to `Telemetry Fixtures & Replay Scenarios`, `contracts`, `Composition Bootstrap Root`, `inMemorySessionRepository`, `checkpointCodec`, `sqlSessionRepository`, `Monotonic Clock & Watchdog`, `fixtures`, `History Store Wrappers`, `sqlJsDatabase`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **What connects `LatLon`, `Point`, `Gate` to the rest of the system?**
  _404 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Telemetry Fixtures & Replay Scenarios` be split into smaller, more focused modules?**
  _Cohesion score 0.08530020703933748 - nodes in this community are weakly interconnected._
- **Should `TMR Geometry Verification Script` be split into smaller, more focused modules?**
  _Cohesion score 0.05084745762711865 - nodes in this community are weakly interconnected._
- **Should `Composition Facade Wrappers` be split into smaller, more focused modules?**
  _Cohesion score 0.06170598911070781 - nodes in this community are weakly interconnected._