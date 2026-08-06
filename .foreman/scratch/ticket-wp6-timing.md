TASK: Implement the crossing detector and lap/sector timing engines for a GNSS lap-timing app in packages/core, with unit + property-based tests covering all adversarial guards.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root; new Vitest suites (including fast-check properties) cover every guard listed below. Paste decisive command output.

CONTEXT: Read first: docs/architecture/contracts.md (binding: CrossingEvent, CrossingDetector, LapRecord, SectorTime, LapTimingEngine, QualityLevel — already in packages/core/src/contracts.ts) and packages/core/src/geometry/ (existing, tested — use its segmentIntersection, crossingDirection, interpolateCrossingTime; do not reimplement geometry).

CONSTRAINTS:
- All code under packages/core/src/timing/ with its own index.ts. Do NOT edit contracts.ts, geometry/**, statemachine/**, or packages/core/src/index.ts.
- Pure logic: time comes only from sample/match timestamps (monotonic ms). No Date.now. No new dependencies. TypeScript strict.

MUST DO — CrossingDetector (configurable via a config object with these defaults):
- Detects gate crossings between consecutive positions using segment intersection in local ENU coordinates; needs the CircuitProfile gates projected to local (accept a pre-projected gate list in its constructor: {gate, aLocal, bLocal}[]).
- tCross via interpolation between prev/curr sample tMono. direction via crossingDirection.
- Guards (each individually tested):
  1. Rearm distance: after a counted crossing of a gate, ignore that gate until unwrappedProgressM advances ≥ minRearmDistanceM (default 50) — kills duplicate/jitter crossings and stop-on-line oscillation.
  2. Reverse crossings are reported with direction 'reverse' but never rearm-consume forward state; timing engine ignores them.
  3. Quality gate: samples whose match quality is 'invalid' produce no crossings; 'unreliable' crossings carry confidence ≤ 0.3.
  4. Max plausible step: if the segment prev→curr is longer than maxStepM (default 120 — covers ~2 s at 60 m/s) treat as teleport: no crossing, emit nothing.
  5. Pit exclusion: matches with onPitLane=true cannot produce startFinish/sector crossings (pitEntry/pitExit gates still fire).
- Stateless w.r.t. wall time; reset() clears rearm state.

MUST DO — LapTimingEngine + sector timing (one module, may be one class):
- Consumes forward CrossingEvents plus current QualityLevel and inPit flag.
- Lap = startFinish forward crossing → next startFinish forward crossing. durationMs = tEnd - tStart; NEVER negative (property test).
- Sector times from ordered sector gates; a valid lap requires ALL sector gates crossed exactly once, in profile order, between the bounding startFinish crossings (test skipped-sector and duplicate-sector cases → invalid, reasons 'MISSED_SECTOR_GATE' / 'DUPLICATE_SECTOR_GATE', sector list still reported with what was seen).
- Invalid-lap reasons (exact codes, all tested): 'SHORT_LAP' (duration < minLapMs default 60000 or distance progressed < 0.9*totalLength), 'PIT_TRANSIT' (inPit at any point during lap), 'LOW_QUALITY' (any window of > lowQualityWindowMs default 10000 continuously at 'unreliable' or worse), 'PAUSE_GAP' (externally injected via markInvalid(reason)), 'REVERSE_TRAVEL' (net unwrapped progress regressed > 30 m during lap).
- markInvalid(reason: string) external hook (state machine feeds PAUSE_GAP / PIT_TRANSIT).
- currentLap() live view per contract.
- Sector bests are NOT computed here (presentation concern) — but each completed LapRecord carries per-sector durations and quality.
- Property tests (fast-check): random crossing sequences with jitter → no lap with negative or zero duration; duplicate startFinish crossings within rearm distance never produce laps shorter than minLapMs; sector times always sum ≤ lap duration + 1 ms tolerance when lap valid.

MUST NOT: modify files outside WRITE SET; add dependencies; spawn subagents; git commit; reimplement geometry primitives.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes (public API surface).

WRITE SET: packages/core/src/timing/** (new files), colocated *.test.ts allowed.
