TASK: Implement the complete UI layer of the track-session app in apps/mobile against a mock session facade (real pipeline wiring is a later work package). Production-quality motorsport UI, portrait-first, high legibility.

EXPECTED OUTCOME: `npm run typecheck` and `npm run lint` pass from repo root; `npx expo export --platform android --output-dir dist-export` exits 0 in apps/mobile with the new UI bundled. Paste decisive output.

CONTEXT: Read first: docs/architecture/contracts.md (SessionState, LapRecord, DeltaUpdate, QualityLevel, CalibrationResult types come from @circuit/core); apps/mobile/src/platform/ (existing providers/preflight — you may call preflight collectors and permissions from screens); docs/research/transilvania-motor-ring.md §Addendum + docs/decisions/ADR-0002 (circuit metadata + mandatory OSM ODbL attribution). App is Expo SDK 57, blank template, App.tsx currently minimal.

CONSTRAINTS:
- UI code under apps/mobile/src/ui/ (screens/, components/, theme/), facade under apps/mobile/src/session/. You may rewrite App.tsx, add navigation deps to apps/mobile/package.json via `npx expo install`: @react-navigation/native, @react-navigation/native-stack, react-native-screens, react-native-safe-area-context (ONLY these). package-lock.json updates allowed.
- Do NOT touch packages/core/** (concurrent workers) or apps/mobile/src/platform/** except importing from it.
- TypeScript strict. No inline `any`. Dark theme default (track use), large type scale.

MUST DO — facade first:
1. `apps/mobile/src/session/facade.ts`: define `SessionFacade` interface — the ONLY surface the UI consumes: observable state (subscribe(cb: (s: FacadeState) => void)), where FacadeState = { sessionState: SessionState; lapNumber: number; currentLapMs: number; lastLapMs: number | null; pbMs: number | null; delta: DeltaUpdate | null; sector: number; gnssQuality: QualityLevel; calibration: { coverageFraction: number; onTrack: boolean } | null; calibrationResult: CalibrationResult | null; laps: LapRecord[] }, plus commands: startPreflight(), beginCalibration(), acceptCalibration(), rejectCalibration(), arm(), endSession(), pause(), resume().
2. `MockSessionFacade` implementing it with a scripted deterministic demo (timer-driven state progression through calibration → armed → 3 timed laps with a plausible oscillating delta, ~20 s per lap for demo) — clearly marked dev-only. App wires MockSessionFacade for now behind `const facade: SessionFacade = new MockSessionFacade()` in a single composition file `apps/mobile/src/session/composition.ts` (the later integration package swaps exactly this file).

MUST DO — screens (react-navigation native-stack; names binding):
S1 CircuitSelectionScreen — single card: Transilvania Motor Ring (name, locality, 3.708 km, layout 'main'), tap → S2. Footer: "© OpenStreetMap contributors (ODbL)" + advisory notice "Recreational timing aid — not an official timing system".
S2 CircuitDetailScreen — circuit metadata from research (length, direction, opened 2018, county), geometry provenance line (community-derived from OSM, app-defined sectors — never labeled official), buttons: Start Session (→S3), Session History (→S9), Settings (→S12).
S3 PreflightScreen — runs platform preflight collectors, shows pass/fail per check with retry; on pass → S4.
S4 CalibrationInstructionsScreen — explains Learn: drive one complete steady recognition lap; Start Calibration → S5.
S5 ActiveCalibrationScreen — live coverageFraction progress ring, onTrack indicator, cancel; on calibrationResult → S6.
S6 CalibrationResultScreen — accepted: confidence + Continue (→S7 armed); rejected: failureReasons in plain language + Retry (→S4).
S7 ActiveDashboardScreen — THE driving screen, portrait: dominant live delta (biggest element, ~30% of height, sign convention: negative=faster shown GREEN with minus, positive=slower RED, neutral GRAY when delta.display==='neutral'); current lap time (large, monospaced digits); sector indicator (S1/S2/S3 highlighting current); PB time small; GNSS quality pill (good=green/degraded=amber/unreliable=red/invalid=gray); lap counter; speed secondary. NO map. NO scrolling. Controls: only End Session via LONG-PRESS (2 s) with visual progress — no accidental touch; keep-awake active (expo-keep-awake); screen stays on. No modals ever while sessionState==='timing' (status changes render as inline banners).
S8 SessionResultsScreen — after endSession: lap list (number, time, valid/invalid with reasons in plain language, best lap highlighted), sector bests, PB badge if new PB; → S9/S2.
S9 SessionHistoryScreen + S10 LapDetailScreen + S11 PersonalBestScreen — list stored sessions (mock data via facade for now), lap detail with sector breakdown, PB details with provenance (date, session); clearly display quality flags.
S12 SettingsScreen — units (km/h / mph), delta deadband, coverage bins — persisted via simple in-memory settings store for now (interface SettingsStore, swap later); About section: full ODbL attribution, advisory-tool disclaimer, licenses.
S13 DevReplayScreen — dev-only (gated by __DEV__): placeholder listing bundled fixtures (wire-up later), documents replay purpose.
- Shared components: TimeDisplay (monospace, ms formatting mm:ss.mmm), DeltaDisplay, QualityPill, SectorBar, LongPressButton (generic, tested manually), StatusBanner.
- Accessibility: accessibilityLabel on all interactive elements; dashboard values have accessibilityLiveRegion where meaningful; text scales tolerably at 1.3× font scale (use maxFontSizeMultiplier where layout would break, document each use).

MUST NOT: implement timing/geometry logic in UI (everything through the facade); no map libraries; no analytics; no network calls; no modal dialogs during timing; no subagent spawning; no git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes (exact swap point for the real facade).

WRITE SET: apps/mobile/src/ui/**, apps/mobile/src/session/**, apps/mobile/App.tsx, apps/mobile/package.json, package-lock.json.
