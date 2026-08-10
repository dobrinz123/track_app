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
