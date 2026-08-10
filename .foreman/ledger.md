# Foreman Ledger — Transilvania Motor Ring track-session app

BASELINE: (empty repo, git initialized 2026-08-06, branch main, no commits yet) | untracked: .claude/, docs/, .foreman/ | 2026-08-06

MODE: Codex-boosted Full (Agent tool ✓, real shell ✓, Codex CLI 0.145.0 ✓ ChatGPT-subscription login — consent: user's mission spec explicitly requests Codex workers; echo check passed, default seat)

SEATS: LEAD = Fable 5 (frontier). Claude: sonnet (WORKHORSE), haiku (FAST), opus/fable (FRONTIER). Codex: account-default = gpt-5.6-sol (observed in exec headers), ChatGPT login; treated as FRONTIER-class for algorithmic work; per-dispatch effort via `-c model_reasoning_effort`.

## Plan
See docs/implementation-plan.md (WP0–WP16).

## Routing
- WP1 scaffold → Sonnet: well-specified config-heavy work
- WP2, WP3 research → Haiku scouts (read-only web research, bounded)
- WP4–WP7, WP9, WP10 → Codex (algorithmic/geometry/timing/fixtures)
- WP8, WP11–WP14 → Sonnet (implementation with clear contracts)
- WP15 → Codex read-only reviewer; WP16 → foreman-verifier (Claude) + Codex read-only (cross-family)

## Tasks
| id | state | owned paths | job id |
|----|-------|-------------|--------|
| WP0 | DONE (LEAD) | docs/**, .foreman/ledger.md | — |
| WP1 | REPORTED(DONE) + LEAD deterministic checks passed (typecheck/test/lint green, commit 79e974b); blind verification batched into core-group gate | root configs, packages/core scaffold, apps/mobile | wave1-scaffold |
| WP5 | REPORTED(DONE) + LEAD gates green (287/287, commit dabbdc6); blind verification batched into core-group gate | packages/core/src/geometry/**, test/geometry/** | br3xpj3dd |
| WP6 | DISPATCHED (Codex, effort=high, background, log .foreman/scratch/wp6-codex-output.log) | packages/core/src/timing/** | wave2-timing |
| WP8 | REPORTED(DONE_WITH_CONCERNS) — concerns triaged: test placement accepted (vitest convention); geometry failures belong to in-flight WP5, judged at WP5 collection | packages/core/src/statemachine/**, test/statemachine/** | wave2-sm |
| WP11a | REPORTED(DONE) + LEAD verified slice (35/35, lint ✓, commit b6241b6); group gate pending | packages/core/src/persistence/**, test/persistence/** | wave2-persist |
| WP12 | REPORTED(DONE) + LEAD verified (mobile tsc ✓ eslint ✓ expo export 1.5MB hbc ✓, commit 73d0d9c) | apps/mobile/src/platform/**, app.json | wave2-platform |
| WP4 | REPORTED(DONE_WITH_CONCERNS→resolved: tests relocated by LEAD) + gates green 366/366, commit c8de532 | packages/core/src/profile/**, test/profile/** | wave3-schema |
| WP4b | REPORTED(DONE_WITH_CONCERNS→resolved: test relocated) + gates 371/371, asset provenance verified by LEAD, commit 8eb9046 | packages/core/scripts/**, assets/** | wave3-tmr |
| WP7 | DISPATCHED (Codex effort=high, background, log wp7-codex-output.log) | packages/core/src/matching/**, src/calibration/**, test/{matching,calibration}/** | bl0hsl1ru |
| WP11b | REPORTED(DONE) + LEAD verified slice (64/64), commit d813aeb | persistence-sql + contract suite | wave4-sqlite |
| WP12b | REPORTED(DONE_WITH_CONCERNS→resolved by ADR-0003 amendment: SDK gap accepted + WP14 watchdog mandate) commit d96d59b | apps/mobile platform + app.json | wave4-ios |
| WP-docs | REPORTED(DONE, amendment applied) + LEAD spot-checks, commit 22515da | README, ios-no-mac-workflow, validation checklist | wave4-docs |
| WP7 | REPORTED(DONE) + LEAD gates 423/423, commit 94b4d86; in core-group blind verification | matching/, calibration/ | bl0hsl1ru |
| WP9 | REPORTED(DONE_WITH_CONCERNS→sandbox-only concern; LEAD gates 458/458) commit cf508e2 | reference/ | bxebf85az |
| WP10 | REPORTED(DONE) + LEAD gates 474/474 + production-composition spot-check, commit b1e0dd8 | fixtures/, replay/ | brahtmjo2 |
| WP14 | REPORTED(DONE_WITH_CONCERNS→deviations reviewed & accepted; limitations queued to known-limitations doc) + LEAD gates 484/484 + offline audit re-run + composition bootstrap inspection, commit 4f39338 | controller/, index.ts, session/, eas.json | wave6-integration |
| WP-perf | DISPATCHED (Codex effort=high, background, log wp-perf-codex-output.log) | track-matcher.ts, test/perf/**, docs/verification/performance.md | bc35jr2w5 |
| WP-sec | ACCEPTED (DONE): 0 CRIT/HIGH, 3 MED (M1 profile-array DoS, M2 unbounded session telemetry, M3 no deletion UI), 3 LOW, 6 INFO clean | .foreman/scratch/security-review-findings.md | wave7-sec |
| WP-secfix | REPORTED(DONE) + LEAD gates 502/502, commit 699b663 — all 6 findings fixed w/ tests | see ticket | wave7-fix |
| WP-perf | REPORTED(DONE) + LEAD verified slice (3.67x measured, 44 relevant tests), commit fadf080 | matcher + perf tests + perf doc | bc35jr2w5 |
| WP-docs2 | REPORTED(DONE) + LEAD spot-checks, commit e368945; surfaced 5 real integration oddities → WP-oddfix | docs set | wave7-docs |
| WP-oddfix | REPORTED(DONE) + LEAD gates 513/513 + export:ios, commit 12a6378 — corridor wiring, reason copy, diagnostics UI, background checkpoint, recovery lap numbering | see ticket | wave8-odd |
| FINAL-VERIFY | COMPLETE. Claude blind verifier: PASS_WITH_NOTES (18/18 DoD rows, 1 LOW → fixed bf9397a). Codex cross-review: nominal FAIL from sandbox write-denials (no app defect; gates pass in real workspace, dual-reproduced) + 1 MEDIUM (sectorIndex assertions → fixed c3ca773) + procedural note (HEAD moved mid-verify — logged). PROJECT VERIFIED at c3ca773: 515/515 tests, all gates green. | — | done |

FINAL STATE v1: delivered (see docs/verification/final-report.md). — Post-delivery phase 2 opened 2026-08-06: user directives = premium UI redesign (kill generic blue/system font/centered text; dark stays), multi-circuit-ready selection UI, app naming (Haiku research → user picks), legal text relocated to About/CircuitDetail (ODbL compliance kept — LEAD decision, deletion refused as license-required). Bundle id FROZEN at app.circuittimer.tmr regardless of display-name choice (resign data preservation).

| id | state | owned paths | job id |
|----|-------|-------------|--------|
| WP-name | ACCEPTED (DONE, 24 candidates, 6 verified finalists) → USER DECISION: app name = TRACE. Display name applied in app.json (CFBundleDisplayName); APP_NAME constant flips at UI-worker collection. Bundle id UNCHANGED (app.circuittimer.tmr). | scratch/naming-research.md | wave9-name |
| WP-catalog | DISPATCHED (Codex effort=medium) | packages/core/src/catalog/**, test/catalog/**, index.ts (1 line) | bmbgre6tu |
| WP-ui2 | DISPATCHED (Sonnet) | apps/mobile/src/ui/**, session/circuitCatalog.ts, App.tsx, fonts deps | wave9-ui |
| WP-docs2 | DISPATCHED (Sonnet) | docs/algorithms/**, docs/*.md, README index | wave7-docs |
| VERIFY-CORE | VERDICT: PASS_WITH_NOTES — all 8 tickets OK, 7/7 adversarial probes passed, purity guard fires. Finding 1 (MEDIUM, uncommitted generate:tmr script) fixed by LEAD commit. Notes 3 (matcher hint gives no compute savings — full search every call; spec requires local-first search) → queued for WP-perf pass. Note 4 accepted (stricter debounce consistent with contracts). Core group = VERIFIED. | — | wave5-verify |
| WP13a | REPORTED(DONE) + LEAD verified (tsc/lint/export 890-module 2MB hbc, commit b4c83bf) | apps/mobile/src/ui/**, src/session/**, App.tsx | wave3-ui |

NOTE: WP11b (SQLite adapter) intentionally held until WP4b collects — package-lock.json write overlap (concurrent npm installs). Facade integration notes: add speedKph to FacadeState at WP14; SessionHistoryStore interface lives outside SessionFacade (accepted design call).
| WP2 | ACCEPTED (DONE_WITH_CONCERNS; concerns dispositioned — see Decisions) | docs/research/**, data/osm/** | wave1-circuit |
| WP3 | ACCEPTED (DONE; scout report consumed) | .foreman/scratch/platform-research.md | wave1-platform |
| WP4–WP16 | PENDING | see plan | — |

## Attempts
(append-only)
- WP0 | 1 | LEAD | — | DONE | n/a | docs written | 2026-08-06
- WP3 | 1 | Haiku scout | ticket inline | DONE→ACCEPTED | n/a (read-only) | .foreman/scratch/platform-research.md (Expo SDK 57, 1Hz GNSS, perf.now monotonic) | 2026-08-06
- WP2 | 1 | Haiku scout | ticket inline | DONE_WITH_CONCERNS→ACCEPTED (concerns dispositioned in Decisions) | LEAD Overpass verification confirmed OSM ways | docs/research/transilvania-motor-ring.md, data/osm/ | 2026-08-06
- WP1 | 1 | Sonnet | ticket inline | DONE; LEAD re-ran typecheck+test+lint = green | typecheck ✓ test 2/2 ✓ lint ✓ expo export ✓ (worker) re-verified by LEAD | commit 79e974b | 2026-08-06
- WP5 | 1 | Codex effort=high | ticket-wp5-geometry.md | DISPATCHED | — | job br3xpj3dd → wp5-codex-output.log | 2026-08-06
- WP8 | 1 | Sonnet | ticket-wp8-statemachine.md | DONE_WITH_CONCERNS; 257 sm tests pass; concerns triaged by LEAD | worker: typecheck ✓ lint ✓ sm-suite 257/257 ✓ | pending group verification | 2026-08-06
- WP11a | 1 | Sonnet | ticket-wp11a-persistence-core.md | DISPATCHED | — | — | 2026-08-06

## Decisions
- 2026-08-06 USER CLARIFICATION: Expo Go = dev-only; on-track = standalone EAS-built offline iOS app installed from Windows (TestFlight paid path OR AltStore/Sideloadly free path w/ 7-day expiry). ADR-0004 amended; docs worker re-scoped mid-flight via SendMessage. WP14 MUST verify: TMR profile statically imported (inlined in Hermes bundle, never fetched) + zero network calls in session paths + eas.json with development/preview/production profiles.
- 2026-08-06 USER PRODUCT DECISION: iOS is primary target (ADR-0003). WP12b dispatched (iOS hardening); docs/validation checklist to be iOS-first in WP14/15; ios export added to verification gates. Architecture stays cross-platform.
- WP2 concerns dispositioned: (a) no public pit/SF/sector data → gates are app-defined + versioned per ADR-0002, never labeled official; (b) turn-count conflict (17 vs 10) → not modeled in MVP, documented; (c) OSM IDs missing → resolved by LEAD Overpass query: way 488429454 (circuit, closed, ~3706 m ≈ verified 3.708 km) + way 488429716 (pit lane); raw JSON archived in data/osm/, ODbL attribution mandated (ADR-0002). New task WP4b: deterministic TMR profile generator from OSM data.
- Stack: Expo/RN + TS monorepo (ADR-0001) — local verifiability + worker proficiency.
- Codex consent: granted in mission spec ("Codex agents — algorithmic and verification work"); billing = ChatGPT subscription.
- Contracts authored by LEAD in docs/architecture/contracts.md; workers materialize verbatim.
- Verifier cadence: blind verification per integration group (core group, app group, final), not per micro-ticket — logged as a deliberate batching decision.

## Scratch
.foreman/scratch/

## Pre-install gate (2026-08-09)
- IPA forensics (LEAD): PASS — bundle id/plist/v2-gates-binary/fonts/icon/unsigned all verified in the actual artifact.
- Blind verifier: FAIL (discipline) — binary behavior clean, but 2/4 controller fixes unpinned (B1 PB-capture, B2 flush-propagation) + DevReplay in release bundle (B4).
- Codex cross-review: FAIL (lifecycle) — C1 one-shot controller (CRITICAL), C2 bootstrap gate, C3 GNSS races, C4 endSession no-flush, C5 recovery pointer, C6 replay swap leaks, C7 silent command errors, C8 unawaited checkpoint, C9 keep-awake gap on Learn, C10 recovery lock+copy, C11 preflight collector linger.
- DECISION: DO NOT INSTALL current artifact; single batched fix wave WP-lifecycle (Sonnet) with pre-decided designs; install slots preserved. Re-verify + fresh build after.
- WP-lifecycle: DONE, all 14 findings fixed with sensitivity-proven tests (590 total green); LEAD re-verified gates + bootstrap-gate UI live check; commit 361b708; build 31283955432 GREEN (11m6s); final ipa forensics PASS (bundle id, v2 binary, all fix markers, no bg modes); TRACE-release-FINAL-2026-08-09.ipa delivered to user with install green-light. Install slots consumed by this campaign: ZERO.

## Phase 3 — Coaching (opened 2026-08-10, user directive)
Goal: advisory on-track guidance — corner severity + braking zones + live cues. Contracts authored by LEAD (contracts.md Coaching addendum, commit pending push). Plan: WPC1 corners analysis (Codex, DISPATCHED bh9srayjn) → WPC2 braking zones + CoachEngine (Codex, ticket staged) → WPC3 controller/facade/settings wiring (Sonnet) → WPC4 dashboard coach strip + corners list + optional expo-speech audio (Sonnet) → E2E preview + Codex cross-review → build. Validation anchor: TMR corner count must land 8-12 vs reference map's T1-T10.
- Phase 3 COMPLETE (2026-08-10): WPC1 corners (Codex) → WPC1b speed model v2 + observed calibration (Codex, LEAD bucket 1.65g) → WPC2 zones+CoachEngine (Codex) → WPC3 wiring (Sonnet) → WPC4 UI+voice (Sonnet) → LEAD live E2E (cues verified in preview) → Codex cross-review FAIL (5H/6M) → WPC5 fix wave (Sonnet, incl. direction-split 9→12 corners real bug; T1/T2 obs unlocked) → Codex re-verify (10/11 FIXED + 2 new) → LEAD takeover residues (immediate invalidation, background voice gating) → 676 tests green → build 31344276647 GREEN → ipa forensics PASS (all coach markers, observed asset, DevReplay excluded). Delivered TRACE-COACH-release-2026-08-10.ipa.
- Voice pack: user-selected ElevenLabs voice id SLniEZuwscN3JIxjTknk (voice-library link provided 2026-08-10); GT-minimal vocabulary amendment sent to WPC6 (3 clips: "Brake hard."/"Brake."/"Lift.", CORNER_AHEAD silent). Awaiting: WPC6 delivery, then ELEVENLABS_API_KEY (env-only) from user to generate.
- Voice pack CLOSED (2026-08-10): user generated 3 clips locally (22 chars ElevenLabs credit, key env-only, never in repo/chat). Populated clip map broke vitest (vite-node parses mp3 require as JS; 24 mobile tests red). Three config-level fixes failed (vite plugin stub, absolute alias, regex alias — reverted). LEAD fix at source: safeRequire(() => require(...)) in generated file + emitter patched to match (conditional block, eslint-disable per entry); vitest.config.ts restored to simple form; stub deleted. Gates all real-exit-code green: typecheck 0, tests 694 (580 core + 114 mobile), lint 0, expo export 0 with all 3 mp3s content-hash-verified in dist/assets. Commit 064668a pushed; build 31383570618 dispatched (variant=both). Pending: watch → ipa forensics (mp3s bundled, clip map markers) → deliver final voice ipa.
- Voice build DELIVERED (2026-08-10): run 31383570618 GREEN (15m, variant=both, SHA 064668a). Release ipa forensics PASS: all 3 mp3s byte-identical in Payload/TRACE.app/assets/assets/voice/, bytecode markers brake-hard/Brake hard./Lift./safeRequire present (prev release had brake-hard=0 -> clip map populated delta confirmed), DevReplay residual strings = 3 = accepted baseline from previous PASS, bundle id app.circuittimer.tmr intact. Delivered builds/ipa/TRACE-VOICE-release-2026-08-10.ipa (13.7 MB). Install slots consumed by voice campaign: ZERO.
- LEAD live E2E post-voice-build (2026-08-10, web preview): full production flow driven via DevReplay "Three timed laps" (looping). Calibration accepted 92% -> dashboard live (GNSS GOOD, sectors, delta vs reference, PB 1:31.178) -> 16 laps -> hold-to-end -> Results (seam laps L1/L4/L7/... correctly INVALID pause-gap/reverse-travel, PB lap green) -> History persisted (1 stored session, per-lap validity chips). VOICE VERIFIED WITH INSTRUMENTATION: 188 real clip playbacks captured (brake.mp3 x120, lift.mp3 x68, tts fallback x0, brake-hard x0 = correct, TMR has no sev-6). CoachStrip live cues confirmed on screen (BRAKE IN -> C9 . 5 . 99 km/h . 9 m, distance countdown, correct corner order). Watchdog restarts: 6 (loop-seam self-recovery). Startup console errors seen initially were STALE HMR bundle history (fresh tab clean); one benign web-only noise: expo-keep-awake's own useKeepAwake unmount rejection (ERR_KEEP_AWAKE_TAG_INVALID x2, library-internal, no native path on iOS). No app-code errors. Verdict: voice ipa remains GREEN for install.
- Graphify refresh (2026-08-10, foreman): graph was stale (built 01:02, missed WPC3-6). Worker ran the incremental runbook: 188 changed code files AST-extracted (1739 nodes/5019 edges merged), then LEAD verified and closed the worker's non-code CONCERN with a semantic pass — cache resolved 78/89 changed docs/images, 1 extraction agent covered the 11 true misses (Phase-3 tickets, ledger, contracts.md coaching addendum, voice-pack.md; 48 nodes/79 edges/3 hyperedges). Final graph: 2025 nodes, 4713 edges, 155 communities, health OK (0 dangling/missing/collapsed), detect_incremental reports 0 pending. New communities labeled (Voice Coach & Audio Clips, Coach Engine, Coach UI Components, Voice Pack Generator Script, ...). graph.html regenerated (2.19 MB).

## Phase 4 — OBD Telemetry (opened 2026-08-10, user directive "PORNESTE FAZA 4 CU FOREMAN INCEPE CU P4a")
Baseline: 897a7b7, tree clean. LEAD: Fable (frontier). Codex: ChatGPT login, verified seat gpt-5.6-sol. Consent: standing (mission spec).
Goal P4a: hardware-free spike — app-side ELM327-WiFi transport + parsing + recording, validated against a deterministic simulated adapter. Roadmap context in memory (phase4-obd-telemetry): P4a spike -> P4b UI -> P4c ESP32 CAN device -> P4d coaching fusion.
Plan: LEAD authors Telemetry contracts addendum -> WPT1 ELM327 core engine + simulator (Codex, workspace-write) -> cross-verify (Claude) -> WPT2 mobile wiring: TCP transport, TelemetryProvider, SQLite recording w/ retention cap, settings, dev screen (Sonnet) -> cross-verify (Codex read-only) -> gates -> E2E preview.
Constraints carried forward: 100% offline at runtime (local socket only), READ-ONLY OBD (mode 01 PIDs only, never clear-codes/actuation), advisory-only labeling, monotonic timestamps, retention caps (security finding M2 lineage), no Expo Go (native TCP needs dev-client/standalone).
| WP | seat | status |
| WPT0 contracts | LEAD | PENDING |
| WPT1 elm327 core | codex gpt-5.6-sol | PENDING |
| WPT2 mobile wiring | sonnet | PENDING |
- WPT0 contracts: DONE (LEAD) — Telemetry addendum appended to contracts.md (channels/transport/session/simulator/recording semantics, retention cap 200k, read-only mode-01 rule).
- WPT1 DISPATCHED: codex gpt-5.6-sol high, workspace-write, bg job b5bkvgho6, ticket .foreman/scratch/ticket-wpt1-elm327.md, out /tmp/wpt1-out.log.
- WPT1 COLLECTED: Codex DONE_WITH_CONCERNS (sandbox could not spawn vitest/tsc; in-process claims). LEAD ran authoritative gates: typecheck 0, tests 720 green (26 new), lint 0. Checkpoint commit 4fceb7b.
- WPT1 VERIFIED: blind foreman-verifier PASS_WITH_NOTES — formulas re-derived w/ independent vectors, 2 mutations caught by tests, tree clean/HEAD unchanged. Notes: sim-transport knobs untested, UNABLE TO CONNECT untested, no session-level split E2E -> batched into WPT-cov ticket.
- WPT2 DISPATCHED (sonnet, bg): mobile wiring per ticket-wpt2-mobile.md. WPT-cov DISPATCHED (sonnet, bg): ticket-wptcov-simtests.md. Parallel OK: disjoint write sets (apps/mobile+lockfile vs packages/core/test/telemetry/simulatedTransport.test.ts).
- WPT-cov COLLECTED: sonnet DONE — 1 new test file, 6 tests (32/32 telemetry green, exit 0 claimed; LEAD will re-gate with WPT2). Write set respected.
- WPT2 CROSS-VERIFY (codex read-only, commit 6e83281): FAIL — 2 HIGH (H1 telemetry flush opens nested SQLite transaction vs controller lap/PB transaction -> "cannot start a transaction within a transaction" can break endSession; H2 end-flush fire-and-forget -> last batch lossy + telemetry left running if controller persistence rejects) + 8 MED (provider stop/start generation race, lap0 not NULL, cap-exact flag, recovery bypasses telemetry start, delete-all leaves telemetry_samples, simulate honored in release, close-during-import race, monitor stale state) + 1 LOW (port field). Clean: retry cleanup, timeout double-settle, SQL binding, migration idempotence, settings hydration, offline/read-only mandates, plist.
- WPT3 fix wave DISPATCHED (sonnet, bg): ticket-wpt3-fixwave.md with 11 LEAD-authored binding designs (F1 no recorder transactions + tail-chain serialization; F2 awaited allSettled end barrier + finally; F3 generation tokens; F4 lap0->NULL; F5 cap>=; F6 recovery hook; F7 mobile delete-all incl telemetry_samples; F8 __DEV__ gate via injected isDev; F9 closed-check post-import; F10 subscribe replay; F11 port draft validation).
- WPT3 re-verify (codex): FAIL — F3-F6,F8-F11 FIXED; F1/F2 PARTIALLY (worker serialization self-deadlocked all repo transactions = NEW HIGH N1; end-barrier awaited wrong promise); F7 blocked by N1. Second failed wave on same area -> LEAD TAKEOVER.
- LEAD takeover (commits 4192a7c + this): sqlWriteGate.ts — gate held only around whole transactions (gateSqlTransactions) + telemetry batch INSERTs (recorder constructor gate param); inner transaction statements ungated (reentrancy-safe, kills N1); stopTelemetryRecording caches+returns shared in-flight shutdown promise (real final flush awaited by onSessionEnded barrier); N1 pin test (deadlocks under old design) + gate ordering test. Codex confirm pass: N1 CONFIRM fixed, F2 CONFIRM fixed, no new defects except delete-all straggler-flush race -> fixed inline (await shutdown, DELETE+verify under gate). Accepted residual (documented): controller emits sessionComplete before telemetry flush settles (needs packages/core realFacade barrier — deferred to P4b; loss window = ms-scale app-kill from Results).
- P4a CLOSED: contracts + ELM327 core engine (Codex) + sim transport w/ fault injection + mobile wiring (Sonnet) + 2 fix rounds. Final: 762 tests green (612 core + 150 mobile), typecheck/lint/export 0. Telemetry is settings-gated OFF by default; zero impact on existing flows when disabled. Next: P4b (gauges UI + lap overlay), P4c (ESP32 CAN), P4d (coaching fusion).

## Phase 4b — Telemetry UI (opened 2026-08-10, user directive)
Baseline: 5c2dd82 + contracts amendment commit. Plan: WPB-A (sonnet): sessionComplete barrier (facade relay hold, 2s cap) + dashboard TelemetryStrip. WPB-B (sonnet): readLapTelemetry + LapDetail bucket charts (View-based, NO new deps — decision: no react-native-svg, bar-sparklines from Views). Parallel, disjoint write sets. Then one Codex cross-review over both, batched fixes if needed, E2E preview w/ simulate.
- P4b contracts amendment committed. WPB-A DISPATCHED (sonnet, bg): barrier + TelemetryStrip, ticket-wpb-a-session.md. WPB-B ticket staged (ticket-wpb-b-lapdetail.md) — SERIALIZED after A (composition.ts overlap; parallel-disjoint rule).
- WPB-A COLLECTED: sonnet DONE — barrier in SwappableFacade (relaySessionCompleteBarrier pure fn + 2s cap), TelemetryStrip w/ fixed slot, pure viewmodel helpers; worker also fixed a real pre-existing bug (stale telemetryShutdown leaking into a later disabled session's barrier). +20 tests (782 claimed green). LEAD will re-gate together with WPB-B before commit.
- WPB-B DISPATCHED (sonnet, bg) after A collected (serialization honored).
- WPB-A+B COLLECTED, gates green (791 tests), commit 50f6125. Codex cross-review: FAIL — 1 HIGH (strip adds normal-flow row: 360x640@1.3 font scale pushes Hold-to-End off-screen = on-track control failure) + 3 MED (card rendered when not polling; stale telemetryShutdown feeds replay barrier; LapDetail read rejection unhandled) + 1 LOW (bucketCount unvalidated). Clean: barrier ordering/cap/once, facade swaps, lap-number scheme agreement, SQL, bucket edges, strip unsubscribes.
- WPB fix wave DISPATCHED (sonnet, bg): ticket-wpb-fixwave.md — LEAD binding designs: H1 strip becomes zero-height overlay pinned in delta zone (removes reserved slot; supersedes contracts "fixed slot" bullet), M1 render-nothing-unless-polling, M2 clear telemetryShutdown at facade swap-ins, M3 rejection -> empty rows + warn, L1 positive-integer guard.
- WPB fix wave COLLECTED (sonnet DONE): H1 strip -> zero-height overlay in delta zone (360x640@1.3 budget back to 600dp pre-P4b baseline), M1 render-null-unless-polling, M2 telemetryShutdown cleared at all 3 facade swap-ins (pinned), M3 loadLapTelemetry rejection->[]+warn (pinned x5), L1 bucketCount TypeError guard (pinned x5). LEAD gates green: 802 tests, typecheck/lint/export 0. Commit 8dbcf16.
- LEAD live E2E (web preview, 360x640 mobile viewport): sim telemetry pipeline verified in UI (Telemetry monitor CONNECTED, RPM@10.1Hz/speed@5Hz/throttle@5Hz/coolant@0.7Hz = poll-plan ratios); dashboard WORST CASE verified visually — coach cue (BRAKE IN C5) + telemetry strip (RPM/THR/COOLANT overlay) + live delta + timer/sectors/PB row + Hold-to-End ALL visible at 360x640, no occlusion of delta digits, no overflow (H1 confirmed fixed in the exact reviewer scenario); sessionComplete barrier functional (Results reached, NEW PERSONAL BEST); console clean (only known benign web keep-awake library noise). LapDetail charts not visually exercisable on web (db=null in-memory -> no recorded rows; hidden-section behavior is the correct rendering there) — chart visuals remain device-verified-by-tests+arithmetic only.
- P4b CLOSED: contracts amendments + barrier + TelemetryStrip + readLapTelemetry/bucketTelemetry + LapDetail sparklines; 1 Codex cross-review (1H/3M/1L) + 1 batched fix wave; 802 tests green. Telemetry UI ships dark until telemetryEnabled.

## P4b+ channel revision (2026-08-11, user directive: oil temps > coolant on strip, rpm record-only, G-forces recorded/analyzed not displayed)
Baseline a0d4c4a + contracts amendment. Plan: WPT-core2 (codex): engineOilC PID 0x5C + custom-PID support + poll plan revision. WPT-mobile2 (sonnet, after core): GForceProvider on existing motionCapture/expo-sensors, strip revision w/ thresholds, trans-PID setting, chart order, TelemetryScreen rows. Cross-verify: foreman-verifier on core, codex on mobile. Sequential.
- WPT-core2 COLLECTED: codex DONE_WITH_CONCERNS (sandbox spawn denial, in-process claims). LEAD gates authoritative: 811 green (621 core + 190 mobile), typecheck/lint 0. Commit 056e0d9. Custom-PID: verbatim hex request, last-byte-minus-40, unconfigured transOilC filtered + one warning; no poll defaults hardcoded in core (confirmed).
- WPT-mobile2 DISPATCHED (sonnet, bg): ticket-wpt-mobile2.md — poll plan revision, transOilPidHex setting, GForceProvider on motionCapture, strip slots THR|ENG OIL|TRANS OIL (coolant fallback), TelemetryScreen rows, chart order. Verification plan after collection: foreman-verifier (core scope) + codex read-only (mobile scope), parallel on committed state.

## P4c-hw — OBD dongle hardware (opened 2026-08-11 overnight, user directive: schematic + production PCB + 3D-printable enclosure, autonomous, token-efficient)
Env installs (user pre-authorized): KiCad 10.0.5 per-user via winget OK (kicad-cli at %LOCALAPPDATA%\Programs\KiCad\10.0\bin); OpenSCAD MSI UAC-canceled -> official portable zip at %LOCALAPPDATA%\Programs\OpenSCAD-portable (2021.01, verified). Python via uv (graphify interpreter).
LEAD design doc: hardware/DESIGN.md (binding) — ESP32-C3-MINI-1 + TJA1051T/3 (hw listen-only via S pin), TPS54202 buck w/ 8V UVLO, SMBJ24A/PTC/SS34 protection, PESD2CAN on bus pins, JLCPCB-assemblable BOM, 55x25mm 2-layer, CAN term DNP.
Plan: HW1 (sonnet) schemdraw SVG schematic; HW3 (sonnet) OpenSCAD enclosure + STL — parallel, disjoint dirs; then HW2 (sonnet, DRC-loop) pcbnew-scripted board -> kicad-cli DRC 0 errors -> JLCPCB gerbers/BOM/CPL. Verification: LEAD visual+netlist review of SVG/renders, DRC as deterministic gate, Codex read-only design review of the full hardware package at the end. Note honest limitation recorded in DESIGN.md §6 (no simulation/bench validation yet).
Concurrent: WPT-mobile2 (channel revision) still in flight — disjoint write sets (apps/mobile vs hardware/), parallel OK.
- HW4 firmware ADDED (user directive): ESP32-C3 firmware via foreman — PlatformIO (headless toolchain, auto-installs on first build = the real compile gate), TWAI/CAN driver, WiFi SoftAP + TCP :35000, minimal ELM327-compatible subset (existing app works unmodified: AT handshake + mode-01 PIDs incl. 0x5C + custom-PID passthrough); host-side unit tests (pio test -e native) for the ELM parser/PID codec; LEAD design note: "read-only" mandate = standard 0x7DF mode-01 queries allowed, NO writes/clears/actuation; hardware S-pin listen-only reserved for future passive sniff mode. Dispatch AFTER a current worker slot frees (3 in flight); Sonnet seat (needs real shell for pio gates), Codex read-only review after.
