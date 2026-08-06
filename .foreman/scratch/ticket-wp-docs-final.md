TASK: Author the remaining required documentation set for the track-session app, accurate against the current code (read the actual implementations — do not guess).

EXPECTED OUTCOME: New docs exist, cross-linked from README's docs index (update it), each consistent with the code at HEAD and with existing ADRs/docs. No code changes. `npm run lint` unaffected.

CONTEXT: Read the implementations first: packages/core/src/{calibration,matching,timing,reference,controller,persistence,persistence-sql,fixtures,replay}/, apps/mobile/src/{session,platform,persistence}/, docs/architecture/current-state.md (WP14 section), docs/decisions/*.md, docs/verification/real-track-validation-checklist.md, README.md.

MUST DO — write these files:
1. docs/algorithms/calibration.md — the Learn flow as implemented: quality thresholds, coverage bins, direction detection, bounded bias rules ([1.5,8] m + 20% p95-improvement gate), acceptance criteria (coverage ≥95%, auto-finish at 98% and WHY — cite the code comment), failure codes and their user-facing meaning, confidence blend, what calibration does NOT do (never creates geometry).
2. docs/algorithms/timing-and-crossings.md — directed-gate semantics (segment intersection, crossing direction sign, interpolated tCross), rearm/debounce, all guards, lap/sector validity rules with the full invalid-reason code table, monotonic-time rules incl. the cross-launch rule.
3. docs/algorithms/live-delta.md — reference resampling (10 m grid, monotone clamp), PB replacement rules table, delta computation, EMA display smoothing, confidence/neutral rules, sign convention, staleness/regression handling, estimated-lap gating.
4. docs/persistence-model.md — table schema v1+v2, migration approach, checkpoint cadence, recovery flow (cite ADR-0003 §3 semantics as implemented incl. RECOVERY lap), sessionId convention, deleteUserData coverage, retention (nothing auto-deleted; manual deletion path), what is stored where incl. full PB telemetry.
5. docs/testing-and-replay.md — test architecture (unit/property/contract/integration layers, counts per suite), fixture catalog (every scenario in fixtures/scenarios.ts with what it exercises), how to run suites, how to use DevReplayScreen on-device (steps), how runSessionPipeline is used for new tests, determinism rules (seeded PRNG, no Date.now).
6. docs/known-limitations.md — honest list, at minimum: GNSS ~1 Hz bounds timing precision (~±0.3 s vs pro timing); gates are app-defined not official; geometry community-derived (OSM), unvalidated on-site; no calibration-stall timeout (manual cancel); lap numbering resets to 1 after recovery resume; iOS mocked-location rejection gap; foreground-only (no background timing); Expo Go dev caveats (Info.plist); no per-user accounts (single local user); thermal-state API unavailable; native builds require EAS cloud; anything else you find documented in code comments as a limitation.
7. docs/privacy.md — data inventory (precise location persisted locally only, per-session; no network transmission — cite the offline audit; no analytics), permission posture, deletion path, diagnostics content, the advisory-tool disclaimer.
8. docs/adding-a-circuit.md — future circuit onboarding: profile schema requirements, provenance rules (never fabricate; license/attribution; geometryStatus/sectorStatus honesty), the generator-script pattern (cite generate-tmr-profile.ts), validation gates a new profile must pass, layoutVersion discipline, real-world validation checklist reuse.
9. Update README.md docs index with all new files (keep existing entries).

MUST NOT: modify code, app.json, package.json, eas.json, ADRs, docs/verification/performance.md (concurrent worker owns it), or the validation checklist; contradict ADRs or implementations; invent numbers not found in code/tests/docs; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files written, code references consulted per doc (path lists), any implementation oddities you noticed while reading (report, don't fix), limitations.

WRITE SET: docs/algorithms/**, docs/persistence-model.md, docs/testing-and-replay.md, docs/known-limitations.md, docs/privacy.md, docs/adding-a-circuit.md, README.md (docs index section only).
