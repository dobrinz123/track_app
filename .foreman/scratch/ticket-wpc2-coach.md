TASK: Implement braking-zone derivation and the CoachEngine in packages/core, per the Coaching addendum contracts. This is the live-guidance brain: "brake in X m", "hard corner ahead".

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` green; new suites green including a replay integration test proving cues fire at correct distances on the real TMR v2 profile.

CONTEXT: Read first: docs/architecture/contracts.md §"Coaching addendum" (BrakingZone, CoachCue, CoachEngine — binding semantics incl. look-ahead formula, per-corner-per-lap debounce with S/F rearm, confidence gating); packages/core/src/corners/ (WPC1, just landed — analyzeCorners API); packages/core/src/reference/ (ReferenceLap: distanceGridM + elapsedMsAtGrid — speed derivable as ds/dt between grid points); packages/core/src/fixtures/ + test/replay/ patterns.

CONSTRAINTS: code in packages/core/src/coach/; tests in test/coach/; contracts.ts additive only if a gap emerges (justify); root index.ts re-export. No new deps. Deterministic. TypeScript strict.

MUST DO:
1. deriveBrakingZones(reference: ReferenceLap | null, corners: Corner[], config?):
   - source 'reference' path: reconstruct speed profile from the PB grid (v[i] = (d[i+1]-d[i]) / (t[i+1]-t[i]) with smoothing window 3), for each corner scan backward from entryDistanceM to find brakeStartDistanceM = last point before entry where speed starts a sustained descent (dv/ds < -decelOnsetThreshold default -0.02 (m/s)/m for >= 3 consecutive grid steps); entrySpeed/apexSpeed from profile (apex = min speed in [entry, exit]).
   - source 'physics' fallback (reference null OR corner segment poorly covered): straight-line decel model from approach speed estimate (previous corner's advisorySpeed or vMax config default 180 kph on long straights) down to corner advisorySpeed at decel default 8 m/s²: brakeDistance = (vApproach²−vCorner²)/(2*decel); brakeStart = entry − brakeDistance (wrap-aware).
   - Zones must never overlap the previous corner's exit (clamp; if clamped to zero-length, drop the BRAKE cue for that corner — flag in zone).
2. CoachEngine per contract: configure(corners, zones); onMatch(match, speedMps) → CoachCue | null. Look-ahead: cue when distance-to-target <= max(minLeadM 80, leadSeconds 3.0 * speed); BRAKE for zones, CORNER_AHEAD for corners without usable zone or when already past brakeStart at first sight; debounce one cue kind per corner per lap; reset()/S-F rearm via unwrappedProgressM lap rollover detection (engine tracks it internally from match.unwrappedProgressM — no external wiring needed); gate: return null if match.quality worse than 'degraded' or confidence < 0.4; wrap-aware distances near S/F.
3. Tests: unit — reference-derived zones on a synthetic PB built from a driveLap through dev-test-ring (assert brakeStart lands before each arc entry and after previous exit; entry/apex speeds plausible); physics fallback zones sane on TMR (all brakeStart in-bounds, non-overlapping); property — for any corner, brakeStartDistanceM < entryDistanceM (mod lap) and cue distances non-negative; CoachEngine sequence test on synthetic matches at 1 Hz through TMR: cues fire once per corner in order, at lead distance within tolerance, silent under degraded quality window, re-arm on lap 2; replay integration (test/coach/coach.replay.test.ts): runSessionPipeline-style loop feeding driveLap TMR samples through TrackMatcher + CoachEngine → per-lap cue count == corner count (with zones), ordered by corner id, deterministic across two runs.
MUST NOT: touch controller/facade/UI (next WP wires them); modify corners/ or reference/ modules; no subagents; no git commit.

OUTPUT FORMAT: first line status; per-corner TMR zone table (cornerId, brakeStart, source, entry/apex kph); files; commands + results.

WRITE SET: packages/core/src/coach/**, packages/core/test/coach/**, packages/core/src/index.ts (re-export), packages/core/src/contracts.ts (additive only if justified).
