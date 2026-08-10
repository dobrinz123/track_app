# Graph Report - .  (2026-08-10)

## Corpus Check
- 89 files · ~243,658 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2025 nodes · 4713 edges · 155 communities (93 shown, 62 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 139 edges (avg confidence: 0.81)
- Token cost: 110,000 input · 19,000 output

## Community Hubs (Navigation)
- Composition Lifecycle Test Fixtures
- Braking Zone & Coach Config
- TMR Geometry Verification Script
- Architecture & Algorithm Docs
- Real Session Facade
- TMR Profile Generator
- iOS Distribution Decisions
- Session Repository & Test Support
- Live Delta & Personal Best
- Voice Coach & Audio Clips
- Composition Bootstrap Root
- Track Matcher & Quality Eval
- Composition Facade Wrappers
- Work-Package Tickets & Pipeline
- Pipeline Core & Session Controller
- Geometry Intersection Math
- Dashboard Display Components
- Reference Lap Repository
- Circuit Profile Schema & Migration
- SQL Settings Store
- App Navigation & Screens
- Session History Store Wrappers
- Composition Recovery Tests
- Coach UI Components
- UI Interaction Components
- GNSS Provider (Reverted) & Sensitivity
- Lap Timing Engine
- Calibration & Braking Zone Tests
- Preflight Platform Checks
- Calibration Engine Core
- Mobile App Dependencies
- Facade & Core Contracts
- Crossing Detector
- Coach Engine
- Session State Machine
- Replay Time Source & Clock
- SQLite Session Repository
- SQL Persistence Schema
- SQL Database Schema & DDL
- Replay Location Provider
- Circuit Catalog Benchmark
- Reference Lap Builder
- Voice Pack Generator Script
- Brand Logo & Wordmark
- Dev Replay & Settings Screens
- Circuit Catalog Core
- Mobile Circuit & TMR Profile
- Core Test Doubles
- ESLint & Prettier Config
- Monorepo Package Manifests
- Checkpoint Codec & Data Deletion
- Expo App Config
- Mobile Dev Dependencies
- Core Package Manifest
- Lap View Screen Design
- Corner Analysis Tests
- Soak Test Harness
- TypeScript Base Config
- Dev Replay Session Controller
- Fake Facade Test Double
- Persistence Contract Suite
- Expo App Identity Config
- Brand & Wordmark Design Notes
- Mobile npm Scripts
- GNSS Diagnostics
- Motion Capture
- Core Dev Dependencies
- Session Summary Contract
- iOS Info.plist Config
- GNSS Location Provider
- Circuit Detail & Corners List
- Core TypeScript Config
- Pre-Install Lifecycle Verification
- Location Permissions
- Preflight Screen UI
- GNSS Provider Tests
- TypeScript Project Config
- Session Pipeline Core
- Monotonic Clock & Watchdog
- Voice Pack Manifest
- Android Adaptive Icon
- TRACE App Icon
- Scripted Location Provider
- Flaky Location Provider Test
- TMR Geometry Verification Rules
- Geo Projection & Profile Loader
- Expo Plugins Config
- TRACE Splash Icon
- Metro Bundler Config
- Preflight Tests
- Prettier Config
- TRACE Favicon
- TRACE Logo Icon Art
- TRACE Logo Mark Art
- Performance Clock
- App Lifecycle Controller
- Android Icon Background
- Orchestration Ledger Notes
- Mock-Location Detection Research
- Monotonic Time Rule
- App Tests & Catalog Tickets
- Expo Dependency Pin
- Expo Dev Client Dependency
- Google Fonts Dependency
- Expo Keep-Awake Dependency
- Expo Location Dependency
- Expo Metro Runtime Dependency
- Expo Sensors Dependency
- Expo Status Bar Dependency
- React Native Dependency
- Masked View Dependency
- React Native Screens Dependency
- App Branding Constant
- Replay Fixture Wiring Notes
- Checkpoint Recovery Notes
- Repository Contract Notes
- GNSS iOS Config Notes
- Mock-Location Rejection Notes
- TMR Profile Determinism Notes
- Crossing Direction Convention
- Invalid-Lap Reason Codes
- iOS Build Workflow & README
- Mobile Vitest Config
- Seeded PRNG Utility
- SQLite Adapter Notes
- SQL Database Interface Notes
- Foreground Permission MVP Notes
- Monotonic Clock Notes
- Replay Provider Dev Tool Notes
- iOS Location Usage Notes
- Facade Swap Point Notes
- End Session Control Notes
- Mock Facade Demo Notes
- Real Facade Adapter Notes
- Watchdog Restart Notes
- Profile Schema Notes
- Profile Migration Notes
- Determinism Rule Notes
- Rearm Distance Guard Notes
- Bias Estimation Notes
- Quality Evaluator Notes
- Track Matcher Notes
- Illegal Event Rule Notes
- EMA Smoothing Notes
- Typography System Notes
- MaskedView Fallback Notes
- Expo Prebuild Step Notes
- Unsigned Build Notes
- Core Vitest Config
- Monorepo Layout Notes
- Verification Commands Notes
- README Verification Commands

## God Nodes (most connected - your core abstractions)
1. `LocationSample` - 73 edges
2. `SessionController` - 49 edges
3. `LapRecord` - 46 edges
4. `ReferenceLap` - 41 edges
5. `LocalPoint` - 38 edges
6. `driveLap()` - 36 edges
7. `RuntimeProfile` - 32 edges
8. `CircuitProfile` - 30 edges
9. `polylineLength()` - 29 edges
10. `CalibrationEngine` - 28 edges

## Surprising Connections (you probably didn't know these)
- `WP12 Mobile Platform Integration Task` --semantically_similar_to--> `Expo SDK 57 changed-docs verification notice`  [INFERRED] [semantically similar]
  .foreman/scratch/ticket-wp12-platform.md → apps/mobile/AGENTS.md
- `WP12b iOS Platform Hardening Task` --semantically_similar_to--> `Expo SDK 57 changed-docs verification notice`  [INFERRED] [semantically similar]
  .foreman/scratch/ticket-wp12b-ios.md → apps/mobile/AGENTS.md
- `WP Wordmark Task` --references--> `TRACE full logo (squircle container: metallic-silver T chassis + glowing amber apex racing curve)`  [EXTRACTED]
  .foreman/scratch/ticket-wp-wordmark.md → apps/mobile/assets/trace_logo.svg
- `TraceWordmark component` --references--> `TRACE full logo (squircle container: metallic-silver T chassis + glowing amber apex racing curve)`  [EXTRACTED]
  .foreman/scratch/ticket-wp-wordmark.md → apps/mobile/assets/trace_logo.svg
- `Telemetry-line motif (gradient bar under wordmark)` --references--> `TRACE full logo (squircle container: metallic-silver T chassis + glowing amber apex racing curve)`  [EXTRACTED]
  .foreman/scratch/ticket-wp-wordmark.md → apps/mobile/assets/trace_logo.svg

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Free iOS install path (ADR-0005 flow)** — _foreman_scratch_free_ios_install_research_expo_go_retirement, _foreman_scratch_free_ios_install_research_unsigned_ipa_route, _foreman_scratch_free_ios_install_research_github_actions_macos, _foreman_scratch_free_ios_install_research_sideloadly, _foreman_scratch_free_ios_install_research_seven_day_resign_cycle, _foreman_scratch_ticket_wp_freeios_unsigned_ios_ci [EXTRACTED 1.00]
- **Security review-and-fix loop** — _foreman_scratch_ticket_wp_security_security_review_ticket, _foreman_scratch_security_review_findings_security_review_report, _foreman_scratch_ticket_wp_secfix_security_fix_wave, _foreman_scratch_security_review_findings_m1_profile_dos, _foreman_scratch_security_review_findings_m2_telemetry_accumulation, _foreman_scratch_security_review_findings_m3_missing_deletion_ui [EXTRACTED 1.00]
- **TRACE brand visual identity system (logo marks + wordmark + palette)** — apps_mobile_assets_trace_logo_svg_mark, apps_mobile_assets_trace_logo_mark_svg, foreman_scratch_ticket_wp_wordmark_tracewordmark, foreman_scratch_ticket_wp_ui_redesign_palette [INFERRED 0.85]
- **Production session pipeline composition (matcher/calibration/timing/statemachine/delta/controller)** — foreman_scratch_ticket_wp6_timing_laptimingengine, foreman_scratch_ticket_wp7_calibration_calibrationengine, foreman_scratch_ticket_wp8_statemachine_reducer, foreman_scratch_ticket_wp9_delta_livedeltaengine [INFERRED 0.85]
- **TMR circuit profile generation + validation pipeline** — foreman_scratch_ticket_wp4_schema_loadprofilefromjson, foreman_scratch_ticket_wp4b_tmr_profile_generator_script, foreman_scratch_ticket_wp5_geometry_createprojection, foreman_scratch_tmr_geometry_check_report [INFERRED 0.85]
- **TMR geometry provenance chain (research to onboarding rules)** — docs_research_transilvania_motor_ring, docs_decisions_adr_0002_circuit_geometry_source, docs_adding_a_circuit, docs_research_transilvania_motor_ring_circuit [EXTRACTED 1.00]
- **iOS free install path decision chain** — docs_decisions_adr_0004_no_mac_ios_workflow, docs_decisions_adr_0005_free_install_path, docs_ios_no_mac_workflow, docs_verification_real_track_validation_checklist [EXTRACTED 1.00]
- **Live Timing Display Group (timer, sectors, last lap, personal best, speed)** — lap_view_current_lap_timer, lap_view_sector_indicators, lap_view_last_lap_readout, lap_view_personal_best_readout, lap_view_speed_readout [EXTRACTED 1.00]
- **GNSS-Derived Telemetry Elements** — lap_view_gnss_status_indicator, lap_view_current_lap_timer, lap_view_speed_readout, lap_view_sector_indicators [INFERRED 0.85]
- **TRACE Icon Visual Composition** — apps_mobile_assets_icon_metallic_t_monogram, apps_mobile_assets_icon_amber_telemetry_trace, apps_mobile_assets_icon_dark_squircle_background [EXTRACTED 1.00]
- **Visual elements forming the TRACE splash-icon identity** — apps_mobile_assets_splash_icon_chrome_t_letterform, apps_mobile_assets_splash_icon_neon_racing_line, apps_mobile_assets_splash_icon_dark_theme_palette [EXTRACTED 1.00]
- **TRACE Logo Mark Composition** — apps_mobile_assets_trace_logo_mark_logo, apps_mobile_assets_trace_logo_mark_metallic_t_letterform, apps_mobile_assets_trace_logo_mark_amber_racing_line [EXTRACTED 1.00]
- **Phase 3 Coaching Pipeline (corners → speeds → zones → cues)** — _foreman_scratch_ticket_wpc1_corners_analyzecorners, _foreman_scratch_ticket_wpc1b_speedmodel_speed_model_v2, _foreman_scratch_ticket_wpc2_coach_derivebrakingzones, docs_architecture_contracts_coachengine, docs_architecture_contracts_coachcue [EXTRACTED 1.00]
- **Coaching Cross-Family Verification Cycle** — _foreman_scratch_ticket_coach_codex_verify_codex_cross_review, _foreman_scratch_ticket_wpc5_coachfix_coach_fix_wave, _foreman_scratch_wpc5_coachfix_report_wpc5_report, _foreman_scratch_ticket_coach_reverify_codex_reverification [EXTRACTED 1.00]
- **Offline Voice Pack Flow (generate once, bundle, fall back)** — docs_voice_pack_generate_voice_pack_script, docs_voice_pack_elevenlabs_api, docs_voice_pack_voiceclips_gen, docs_voice_pack_expo_speech_fallback, docs_voice_pack_gt_minimal_vocabulary [EXTRACTED 1.00]

## Communities (155 total, 62 thin omitted)

### Community 0 - "Composition Lifecycle Test Fixtures"
Cohesion: 0.08
Nodes (46): driveLap(), DriveLapOptions, FixtureMetadata, modulo(), pointAtRawDistance(), resolvedSpeed(), runtimeFor(), sampleAtLapDistance() (+38 more)

### Community 1 - "Braking Zone & Coach Config"
Cohesion: 0.05
Nodes (25): PerformanceNowClock, ADR-0003, circuitCatalog, CircuitSummary, ENTRIES, ReplayTimeSource, ReplayTimestampedLocationProvider, ScaledReplayClock (+17 more)

### Community 2 - "TMR Geometry Verification Script"
Cohesion: 0.06
Nodes (10): errorMessage(), mapState(), RealSessionFacade, cancelledCalibrationResult(), randomToken(), recoverySkippedCalibrationResult(), SessionController, WatchdogScheduler (+2 more)

### Community 3 - "Architecture & Algorithm Docs"
Cohesion: 0.05
Nodes (55): allPoints, area, arrowSvg, assertions, asset, assetPath, bbox, centerEs (+47 more)

### Community 4 - "Real Session Facade"
Cohesion: 0.08
Nodes (53): Mobile App CLAUDE.md (Expo v57 docs pointer), Adding a Circuit (onboarding process doc), Generator Script Pattern, layoutVersion Discipline, Never-Fabricate Provenance Rules, Calibration (Learn Lap) Algorithm Doc, Bounded Bias Estimation, Coverage Bins (25 m monotonic centerline coverage) (+45 more)

### Community 5 - "TMR Profile Generator"
Cohesion: 0.08
Nodes (46): activateProductionFacade(), appVersion(), bootstrapPromise, BootstrapState, bootstrapStateListeners, buildProductionController(), COACHING_REBUILD_STATES, coachingConfig() (+38 more)

### Community 6 - "iOS Distribution Decisions"
Cohesion: 0.06
Nodes (27): bootFresh(), coachingDenseLap(), driveOneCoachingSession(), driveOneFullSession(), feed(), flushBootstrap(), freshSessionControllerClass(), latestFacadeState() (+19 more)

### Community 7 - "Session Repository & Test Support"
Cohesion: 0.08
Nodes (44): centerlineCurvatureAtDistance(), centerlineVertexCurvatures(), centroid(), closedLength(), ClosedProjection, createLocalProjection(), cumulativeDistances(), curvatureModule (+36 more)

### Community 8 - "Live Delta & Personal Best"
Cohesion: 0.09
Nodes (43): load(), CornerSeverity, analyzeCorners(), apexIndex(), collectRuns(), CornerAnalysisConfig, CornerLatGBucket, CornerSeverityBand (+35 more)

### Community 9 - "Voice Coach & Audio Clips"
Cohesion: 0.07
Nodes (48): Foreman Ledger (TMR track-session app), Phase 3 — Coaching, Pre-install Gate (IPA forensics + blind verify), Voice Pack Campaign (ledger), Codex Cross-Family Review (coaching phase), Codex Re-Verification (fix wave verdict), analyzeCorners (WPC1 corner-analysis module), curvatureProfile (shared geometry util) (+40 more)

### Community 10 - "Composition Bootstrap Root"
Cohesion: 0.08
Nodes (34): COLOR, LABEL, QualityPill(), styles, SectorBarProps, styles, styles, TraceLogo() (+26 more)

### Community 11 - "Track Matcher & Quality Eval"
Cohesion: 0.07
Nodes (36): AltStore Classic, EU DMA sideloading allowance (Romania), Expo Go SDK 57 absent from iOS App Store, Free personal-team entitlement limits, GitHub Actions free macOS runners (public repo), Free iOS sideloading research packet (Aug 2026), 7-day signature / re-sign cycle (free Apple ID), Sideloadly (Windows sideloading tool) (+28 more)

### Community 12 - "Composition Facade Wrappers"
Cohesion: 0.10
Nodes (19): QualityPillProps, CrossingEvent, LapTimingEngine, QualityLevel, SectorTime, ActiveLap, isLowQuality(), LapTimingEngine (+11 more)

### Community 13 - "Work-Package Tickets & Pipeline"
Cohesion: 0.07
Nodes (35): Expo SDK 57 changed-docs verification notice, WP10 Replay Harness Task, Atomic PB replace semantics (putReferenceLap), Deep-copy read semantics (getReferenceLap), WP11a Persistence Core Task, Orphan sessionId cleanup rule (${userId}--<random> prefix), SqlSessionRepository (sql.js / expo-sqlite backed), WP11b SQLite Adapter Task (+27 more)

### Community 14 - "Pipeline Core & Session Controller"
Cohesion: 0.12
Nodes (23): CORNER_ANALYSIS_VERSION, LocalPoint, polylineLength(), createProjection(), gateAt(), makeTestProfile(), superellipsePoint(), TEST_ORIGIN (+15 more)

### Community 15 - "Geometry Intersection Math"
Cohesion: 0.14
Nodes (27): settingsStore, accessibleLabel(), COACH_STRIP_HEIGHT, CoachStrip(), SEVERITY_STYLE, SeverityChip(), styles, cornerAccessibilityLabel() (+19 more)

### Community 16 - "Dashboard Display Components"
Cohesion: 0.11
Nodes (17): deleteAllStoredUserData(), SessionMachineSnapshot, CHECKPOINT_SCHEMA_VERSION, CheckpointCodec, CheckpointPayload, isLapRecordShape(), isPlainObject(), isSerializedCheckpoint() (+9 more)

### Community 17 - "Reference Lap Repository"
Cohesion: 0.10
Nodes (18): FacadeState, LAP_SCRIPTS, LapScript, ADR-0003, CoachStripProps, DeltaDisplayProps, FakeFacade, CalibrationResult (+10 more)

### Community 18 - "Circuit Profile Schema & Migration"
Cohesion: 0.15
Nodes (16): CrossingDetector, GeoProjection, adjacentFloat(), cross(), crossingDirection(), crossTolerance(), interpolateCrossingTime(), SegmentIntersection (+8 more)

### Community 19 - "SQL Settings Store"
Cohesion: 0.11
Nodes (3): LocalSessionRepository, ControllableRepository, RecordingRepository

### Community 20 - "App Navigation & Screens"
Cohesion: 0.12
Nodes (22): facade, LongPressButton(), LongPressButtonProps, styles, ProgressRing(), ProgressRingProps, useFacadeState(), ActiveCalibrationScreen() (+14 more)

### Community 21 - "Session History Store Wrappers"
Cohesion: 0.12
Nodes (10): SwappableSessionHistoryStore, lap(), MOCK_SESSIONS, MockSessionHistoryStore, PersonalBestEntry, sectorTimes(), SessionHistoryStore, StoredSession (+2 more)

### Community 22 - "Composition Recovery Tests"
Cohesion: 0.14
Nodes (23): CORE_PACKAGE_ID, buildReferenceLap(), BuildReferenceLapBase, BuildReferenceLapInput, BuildReferenceLapResult, failure(), gridFor(), interpolate() (+15 more)

### Community 23 - "Coach UI Components"
Cohesion: 0.16
Nodes (18): createSqliteSessionRepository(), openAppDatabase(), wrapExpoSqliteDatabase(), isPartialAppSettings(), SQL_DDL, SQL_DDL_V2, SQL_SCHEMA_VERSION, SqlBindValue (+10 more)

### Community 24 - "UI Interaction Components"
Cohesion: 0.11
Nodes (17): AccuracyDistributionSummary, computeAccuracyDistribution(), computeIntervalHistogram(), GnssDiagnostics, GnssLocationProvider, INTERVAL_BUCKET_UPPER_BOUNDS_MS, SampleIntervalBucket, ADR-0003 (+9 more)

### Community 25 - "GNSS Provider (Reverted) & Sensitivity"
Cohesion: 0.15
Nodes (19): loadProfileFromJson(), MAX_PROFILE_JSON_BYTES, isObject(), JsonObject, migrateProfile(), Migration, migrations, circuitProfileSchema (+11 more)

### Community 26 - "Lap Timing Engine"
Cohesion: 0.18
Nodes (21): BATTERY_CRITICAL_THRESHOLD, BatteryCheckResult, BatteryModuleLike, collectBatteryCheck(), collectGnssFix(), collectKeepAwakeActivatable(), collectLocationServicesEnabled(), collectPermissionGranted() (+13 more)

### Community 27 - "Calibration & Braking Zone Tests"
Cohesion: 0.09
Nodes (23): dependencies, @circuit/core, @expo-google-fonts/jetbrains-mono, expo-linear-gradient, expo-speech, react, react-dom, react-native-safe-area-context (+15 more)

### Community 28 - "Preflight Platform Checks"
Cohesion: 0.11
Nodes (17): expo-audio, ADR-0004, VOICE_CLIPS, BRAKE_UTTERANCES, BrakeUtteranceId, ClipSpeakerOptions, createClipSpeaker(), cueKey() (+9 more)

### Community 29 - "Calibration Engine Core"
Cohesion: 0.16
Nodes (19): SessionEvent, SessionReducer, createInitialSessionSnapshot(), ctxOf(), SessionContext, sessionReducer(), SessionSnapshot, startLap() (+11 more)

### Community 30 - "Mobile App Dependencies"
Cohesion: 0.12
Nodes (5): ReplayLocationProvider, ReplayOptions, FlakyStartLocationProvider, LocationSample, FakeLocationProvider

### Community 31 - "Facade & Core Contracts"
Cohesion: 0.13
Nodes (17): sessionHistoryStore, SIZE_STYLE, styles, TimeDisplay(), TimeDisplayProps, TimeDisplaySize, ADVISORY_NOTICE, TRANSILVANIA_MOTOR_RING (+9 more)

### Community 32 - "Crossing Detector"
Cohesion: 0.15
Nodes (13): CornersListProps, Candidate, CoachEngine, CoachEngineConfig, DEFAULT_COACH_ENGINE_CONFIG, finitePositive(), forwardDistance(), modulo() (+5 more)

### Community 33 - "Coach Engine"
Cohesion: 0.17
Nodes (5): CalibrationEngine, clamp01(), inferredDirection(), mean(), percentile95()

### Community 34 - "Session State Machine"
Cohesion: 0.20
Nodes (13): SessionPipelineCore, alreadyCalibratedResult(), inferredDirection(), ReplayMatchedTelemetry, ReplayRejectedSample, runCalibration(), runSessionPipeline(), forwardDistance() (+5 more)

### Community 35 - "Replay Time Source & Clock"
Cohesion: 0.13
Nodes (12): AppCircuitCatalog, ScenarioDefinition, CircuitCatalogProfile, CircuitProfile, RuntimeProfile, TmrFixture, ASSET_URL, TimedRun (+4 more)

### Community 36 - "SQLite Session Repository"
Cohesion: 0.22
Nodes (17): BrakingZoneConfig, buildSpeedProfile(), DEFAULT_BRAKING_ZONE_CONFIG, deriveBrakingZones(), finitePositive(), forwardDistance(), minimumSpeed(), modulo() (+9 more)

### Community 37 - "SQL Persistence Schema"
Cohesion: 0.17
Nodes (9): LiveDeltaEngine, TrackMatch, bounded(), clamp01(), cloneReference(), LiveDeltaEngine, nonNegative(), referenceCompleteness() (+1 more)

### Community 39 - "Replay Location Provider"
Cohesion: 0.17
Nodes (11): AcceptedPoint, CalibrationConfig, DEFAULT_CONFIG, CalibrationDiagnostics, TelemetryQualityEvaluator, DEFAULT_TELEMETRY_QUALITY_CONFIG, distanceM(), LEVEL_RANK (+3 more)

### Community 40 - "Circuit Catalog Benchmark"
Cohesion: 0.19
Nodes (11): TrackMatcher, circularDistance(), clamp01(), DEFAULT_CONFIG, hintedSegmentIndices(), modulo(), projectOntoValidatedHintWindow(), segmentIsInHintWindow() (+3 more)

### Community 41 - "Reference Lap Builder"
Cohesion: 0.20
Nodes (16): ASSETS_DIRECTORY, buildManifestEntries(), clipFilename(), CLIPS_MODULE_PATH, generateClipsModule(), main(), MANIFEST_PATH, ADR-0004 (+8 more)

### Community 42 - "Voice Pack Generator Script"
Cohesion: 0.24
Nodes (10): CircuitCatalog, CircuitCatalogEntry, CircuitCatalogError, circuitCatalogKey(), CircuitSummary, createCircuitCatalog(), entryLabel(), serializeRaw() (+2 more)

### Community 43 - "Brand Logo & Wordmark"
Cohesion: 0.25
Nodes (13): QualityAssessment, createPipelineComponents(), MatchedTelemetrySample, PipelineComponents, PipelineCoreConfig, projectedGates(), RejectedTelemetrySample, SampleIngestResult (+5 more)

### Community 44 - "Dev Replay & Settings Screens"
Cohesion: 0.26
Nodes (12): circularDistance(), modulo(), polylineCumulative(), PolylineProjection, ProjectionHint, projectOntoPolyline(), segmentIsInHintWindow(), segmentLength() (+4 more)

### Community 45 - "Circuit Catalog Core"
Cohesion: 0.17
Nodes (12): estimateObservedRateHz(), getLiveDiagnostics(), LiveDiagnosticsSnapshot, DevReplayScreen(), Props, SCENARIOS, styles, ACTIVE_SESSION_STATES (+4 more)

### Community 46 - "Mobile Circuit & TMR Profile"
Cohesion: 0.22
Nodes (3): assertJsonSerializable(), SqlSessionRepository, withInjectedRunFailure()

### Community 47 - "Core Test Doubles"
Cohesion: 0.18
Nodes (5): CoverageBinsSetting, DEFAULT_SETTINGS, InMemorySettingsStore, SettingsStore, SpeedUnits

### Community 48 - "ESLint & Prettier Config"
Cohesion: 0.14
Nodes (7): VoiceCoachSpeaker, audioMock, FakeAudioPlayer, flush(), flushUntil(), lifecycleMock, speechMock

### Community 49 - "Monorepo Package Manifests"
Cohesion: 0.13
Nodes (15): eslint, eslint-config-prettier, @eslint/js, globals, devDependencies, eslint, eslint-config-prettier, @eslint/js (+7 more)

### Community 50 - "Checkpoint Codec & Data Deletion"
Cohesion: 0.18
Nodes (12): StatusBanner(), StatusBannerProps, StatusBannerVariant, styles, VARIANT_COLOR, CheckRow, explainFailure(), FAILURE_COPY (+4 more)

### Community 51 - "Expo App Config"
Cohesion: 0.14
Nodes (13): description, name, private, scripts, format, generate:tmr, lint, test (+5 more)

### Community 52 - "Mobile Dev Dependencies"
Cohesion: 0.15
Nodes (13): backgroundColor, backgroundImage, foregroundImage, monochromeImage, adaptiveIcon, package, permissions, predictiveBackGestureEnabled (+5 more)

### Community 53 - "Core Package Manifest"
Cohesion: 0.15
Nodes (12): devDependencies, @types/react, typescript, vitest, vitest, main, name, private (+4 more)

### Community 55 - "Corner Analysis Tests"
Cohesion: 0.15
Nodes (12): dependencies, zod, main, name, private, scripts, test, typecheck (+4 more)

### Community 56 - "Soak Test Harness"
Cohesion: 0.27
Nodes (10): ReferenceLap, hasFullReferenceGrid(), hasProvenance(), PersonalBestCandidate, sectorsAreCompleteAndOrdered(), shouldReplacePb(), unpack(), candidate() (+2 more)

### Community 57 - "TypeScript Base Config"
Cohesion: 0.30
Nodes (3): SqlSettingsStore, AppSettings, FakeSettingsStore

### Community 58 - "Dev Replay Session Controller"
Cohesion: 0.21
Nodes (12): Current Lap Timer (0:00.000 monospaced display), Delta Bar (Seconds vs. Reference), Delta-to-Reference Timing Concept, Hold to End Session Button (red outline, hold-to-confirm), Glanceable Dark High-Contrast UI Design, GNSS Status Indicator (GNSS GOOD pill), Lap Counter (LAP 0), Last Lap Readout (placeholder --:--.---) (+4 more)

### Community 59 - "Fake Facade Test Double"
Cohesion: 0.55
Nodes (7): NOTE: sweeping orphan checkpoints/telemetry for sessionIds minted as, runRepositoryContractTests(), makeLapRecord(), makeLocationSample(), makeReferenceLap(), makeSessionSummary(), makeSnapshot()

### Community 60 - "Persistence Contract Suite"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule (+3 more)

### Community 61 - "Expo App Identity Config"
Cohesion: 0.22
Nodes (3): SessionSummary, coachingCorners(), tmr()

### Community 62 - "Brand & Wordmark Design Notes"
Cohesion: 0.20
Nodes (9): expo, icon, name, orientation, slug, userInterfaceStyle, version, web (+1 more)

### Community 63 - "Mobile npm Scripts"
Cohesion: 0.20
Nodes (10): TRACE logo mark (cropped, no container background), TRACE full logo (squircle container: metallic-silver T chassis + glowing amber apex racing curve), APP_NAME branding constant (branding.ts), TRACE dark palette (near-black + racing amber #FFB300), S1 CircuitSelectionScreen multi-circuit list rebuild, S1 brandRow lockup (logo + wordmark + kicker), WP Wordmark Task, Telemetry-line motif (gradient bar under wordmark) (+2 more)

### Community 64 - "GNSS Diagnostics"
Cohesion: 0.20
Nodes (10): scripts, android, export:android, export:ios, generate:voice-pack, ios, start, test (+2 more)

### Community 65 - "Motion Capture"
Cohesion: 0.22
Nodes (8): AccuracyDistributionSummary, computeAccuracyDistribution(), computeIntervalHistogram(), GnssDiagnostics, INTERVAL_BUCKET_UPPER_BOUNDS_MS, SampleIntervalBucket, ADR-0003, WATCH_OPTIONS

### Community 66 - "Core Dev Dependencies"
Cohesion: 0.20
Nodes (4): createMotionCapture(), MotionCapture, MotionCaptureOptions, MotionSample

### Community 67 - "Session Summary Contract"
Cohesion: 0.20
Nodes (10): fast-check, devDependencies, fast-check, sql.js, @types/sql.js, typescript, vitest, vitest (+2 more)

### Community 68 - "iOS Info.plist Config"
Cohesion: 0.22
Nodes (9): ios, CFBundleDisplayName, NSLocationTemporaryUsageDescriptionDictionary, NSLocationWhenInUseUsageDescription, bundleIdentifier, infoPlist, requireFullScreen, supportsTablet (+1 more)

### Community 73 - "Location Permissions"
Cohesion: 0.33
Nodes (8): Gate, ProjectedGate, cross(), gate(), match(), projectedGate(), projection, sample()

### Community 74 - "Preflight Screen UI"
Cohesion: 0.22
Nodes (6): CIRCUIT_IDS, LAYOUT_IDS, LAYOUT_VERSIONS, Op, opArb, USER_IDS

### Community 75 - "GNSS Provider Tests"
Cohesion: 0.22
Nodes (8): compilerOptions, outDir, rootDir, extends, include, src/**/*.ts, test/**/*.ts, ../../tsconfig.base.json

### Community 76 - "TypeScript Project Config"
Cohesion: 0.29
Nodes (7): LOCATION_PERMISSION_RATIONALE, PermissionOutcome, PermissionState, PRECISE_LOCATION_INSTRUCTIONS, requestForegroundLocationPermission(), toOutcome(), ADR-0003

### Community 77 - "Session Pipeline Core"
Cohesion: 0.29
Nodes (6): createdSubscriptions, FakeSubscription, makeSubscription(), PendingWatchCall, resolveWatchCall(), watchCalls

### Community 78 - "Monotonic Clock & Watchdog"
Cohesion: 0.25
Nodes (6): compilerOptions, strict, extends, compilerOptions, extends, expo/tsconfig.base

### Community 79 - "Voice Pack Manifest"
Cohesion: 0.25
Nodes (3): FixSource, SessionPipelineResult, InspectedMatch

### Community 80 - "Android Adaptive Icon"
Cohesion: 0.29
Nodes (6): entries, generatedAtUtc, schemaVersion, voice, model, outputFormat

### Community 81 - "TRACE App Icon"
Cohesion: 0.53
Nodes (6): expo-keep-awake usage, Final Codex cross-family verdict ticket (fix wave 2 residue), Codex re-verification of fix wave 1 (C1-C11 + B1/B4), Pre-install adversarial lifecycle review (produced C1-C11), Fix wave 2 residue closure (F1-F6), Pre-install fix wave 1 (WP-lifecycle, C1-C11 + B1/B4)

### Community 82 - "Scripted Location Provider"
Cohesion: 0.53
Nodes (6): Android Adaptive Icon Foreground (TRACE), Glossy Blue Gradient Treatment, Blue Chevron Apex Mark, TRACE Brand Identity, Android Adaptive Icon Monochrome Layer (Material You Themed Icon), TRACE Chevron Brand Mark (Monochrome Android Icon)

### Community 83 - "Flaky Location Provider Test"
Cohesion: 0.47
Nodes (6): TRACE App Icon (icon.png), Amber Neon Telemetry Trace, Dark Squircle Background, Metallic T Monogram, Motorsport Night-Mode Aesthetic, TRACE Brand Identity

### Community 84 - "TMR Geometry Verification Rules"
Cohesion: 0.40
Nodes (6): Pit entry/exit determination rule from travel-direction geometry, Sector gate rule: perpendicular gates at 1/3 and 2/3 of totalLengthM, S/F gate placement rule (pit-lane midpoint projected onto centerline), TMR Geometry Verification Report, Sanity assertions (closed loop, S/F gate distance, sector 1/3-2/3, direction match -- all PASS), TMR geometry verification diagram (north-up centerline, pit lane, gates, direction arrows)

### Community 85 - "Geo Projection & Profile Loader"
Cohesion: 0.50
Nodes (3): App(), navigationTheme, RootNavigator()

### Community 86 - "Expo Plugins Config"
Cohesion: 0.40
Nodes (5): plugins, expo-font, expo-sqlite, expo-font, expo-sqlite

### Community 87 - "TRACE Splash Icon"
Cohesion: 0.50
Nodes (5): TRACE Splash Icon (app icon artwork), Chrome/silver outlined T letterform, Dark near-black background with amber/yellow accent palette, Neon glowing racing-line tube motif, TRACE brand mark (racing line traces the letter T)

### Community 88 - "Metro Bundler Config"
Cohesion: 0.40
Nodes (4): config, { getDefaultConfig }, path, workspaceRoot

### Community 90 - "Prettier Config"
Cohesion: 0.40
Nodes (4): printWidth, semi, singleQuote, trailingComma

### Community 91 - "TRACE Favicon"
Cohesion: 0.83
Nodes (4): TRACE Favicon (favicon.png), Amber-on-Black Brand Palette, Stylized Slanted T Letterform Glyph, TRACE App Brand Identity

### Community 92 - "TRACE Logo Icon Art"
Cohesion: 0.67
Nodes (4): TRACE App Icon (neon T on dark rounded square), Dark Brand Theme (near-black background, amber accent), Neon T Monogram, Racing-Line Motif (glowing curved stroke)

### Community 93 - "TRACE Logo Mark Art"
Cohesion: 0.83
Nodes (4): Amber Neon Racing-Line Trace, TRACE Logo Mark (transparent PNG), Metallic T Letterform, TRACE Lap-Timing App Brand Identity

### Community 94 - "Performance Clock"
Cohesion: 0.50
Nodes (3): LifecycleCallbacks, LifecycleController, startLifecycleListener()

### Community 96 - "Android Icon Background"
Cohesion: 0.67
Nodes (3): App Store name-collision analysis, TRACE (naming candidate, 34/35), VECTOR (naming candidate, 33/35)

### Community 97 - "Orchestration Ledger Notes"
Cohesion: 1.00
Nodes (3): Android Adaptive Icon Background Layer, Blueprint Construction-Grid Motif, TRACE Brand Identity (precision lap timing)

## Knowledge Gaps
- **439 isolated node(s):** `LatLon`, `Point`, `Gate`, `here`, `root` (+434 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **62 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `Calibration & Braking Zone Tests` to `Expo Dev Client Dependency`, `Google Fonts Dependency`, `Expo Keep-Awake Dependency`, `Expo Location Dependency`, `Expo Metro Runtime Dependency`, `Expo Sensors Dependency`, `Expo Status Bar Dependency`, `React Native Dependency`, `Masked View Dependency`, `React Native Screens Dependency`, `App Branding Constant`, `Core Package Manifest`, `Expo Plugins Config`, `Preflight Platform Checks`?**
  _High betweenness centrality (0.114) - this node is a cross-community bridge._
- **Why does `expo-audio` connect `Preflight Platform Checks` to `Expo Plugins Config`?**
  _High betweenness centrality (0.102) - this node is a cross-community bridge._
- **Why does `expo-audio` connect `Preflight Platform Checks` to `Calibration & Braking Zone Tests`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **What connects `LatLon`, `Point`, `Gate` to the rest of the system?**
  _439 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Composition Lifecycle Test Fixtures` be split into smaller, more focused modules?**
  _Cohesion score 0.07885968159940762 - nodes in this community are weakly interconnected._
- **Should `Braking Zone & Coach Config` be split into smaller, more focused modules?**
  _Cohesion score 0.05110809588421529 - nodes in this community are weakly interconnected._
- **Should `TMR Geometry Verification Script` be split into smaller, more focused modules?**
  _Cohesion score 0.060451977401129946 - nodes in this community are weakly interconnected._