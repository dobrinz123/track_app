# Persistence model

The on-device storage layer: `packages/core/src/persistence/` (in-memory reference implementation
+ shared codecs/validators) and `packages/core/src/persistence-sql/` (the real SQL-backed
`LocalSessionRepository`, run over `expo-sqlite` in the app and `sql.js` in tests). Both implement
the same `LocalSessionRepository` contract (`packages/core/src/contracts.ts`) with matching
semantics — see `docs/architecture/contracts.md`.

## Table schema v1 + v2

DDL lives in `packages/core/src/persistence-sql/schema.ts`. `SQL_SCHEMA_VERSION` tracks the
*table* shapes — independent of `CHECKPOINT_SCHEMA_VERSION` (`persistence/checkpointCodec.ts`),
which tracks the JSON *payload* shape written into the `checkpoints.payload` column.

**v1 tables** (`SQL_DDL`):

| Table | Columns | Notes |
|---|---|---|
| `schema_migrations` | `version INTEGER` | single row, current schema version |
| `sessions` | `sessionId TEXT PK`, `userId`, `circuitId`, `layoutId`, `layoutVersion INTEGER`, `startedAtUtc` | one row per ended session; index `idx_sessions_user_circuit (userId, circuitId)` |
| `laps` | `sessionId`, `lapNumber INTEGER`, `payload TEXT`, PK `(sessionId, lapNumber)` | one row per lap, `payload` = JSON `LapRecord` |
| `checkpoints` | `sessionId TEXT PK`, `payload TEXT` | one row per (possibly still-active) session, `payload` = `CheckpointCodec`-serialized `{snapshot, laps}` |
| `telemetry` | `sessionId`, `lapNumber INTEGER`, `payload TEXT`, PK `(sessionId, lapNumber)` | one row per lap, `payload` = JSON `LocationSample[]` (the full raw stream for that lap) |
| `reference_laps` | `userId`, `circuitId`, `layoutId`, `layoutVersion INTEGER`, `payload TEXT`, PK `(userId, circuitId, layoutId, layoutVersion)` | at most one row per (user, circuit, layout, version) — the stored personal best |

**v2 addition** (`SQL_DDL_V2`, WP14 integration): `settings (key TEXT PK, value TEXT NOT NULL)` — a
simple key-value table. Not part of the `LocalSessionRepository` contract; `apps/mobile/src/persistence/sqlSettingsStore.ts`
and `composition.ts`'s `activeSessionId` pointer (see Recovery below) both build directly on this
table via the same `SqlDatabase` handle a `SqlSessionRepository` was created from.

## Migration approach

`SqlSessionRepository.create(db)` always runs `migrate()` (`sqlSessionRepository.ts:47-84`):

1. `PRAGMA journal_mode = WAL;` — write-throughput only, wrapped in try/catch because `sql.js` (no
   VFS/file backing, used in tests) throws on it; the failure is swallowed by design. Real SQLite
   via `expo-sqlite` applies it.
2. Run `SQL_DDL`, then unconditionally `SQL_DDL_V2` — every statement is `CREATE TABLE IF NOT
   EXISTS`, so re-running against an already-migrated database is a no-op that never touches
   existing rows.
3. Read `schema_migrations`: if no row exists (fresh DB), insert `SQL_SCHEMA_VERSION` outright. If
   an existing row's version is below `SQL_SCHEMA_VERSION` (a v1 database being opened by the v2
   code — `SQL_DDL_V2` above has already created the missing `settings` table), `UPDATE
   schema_migrations SET version = ?` to bump the recorded version in place. Every other table's
   existing rows are left untouched by this path.

This means opening the same on-device database twice (e.g. across app launches) is always safe and
idempotent — proven by a dedicated "migration idempotence" test in
`packages/core/test/persistence-sql/sqlSessionRepository.contract.test.ts` that opens the same
underlying store twice and asserts no error and prior data intact.

## Checkpoint cadence

A checkpoint (`{snapshot: SessionMachineSnapshot, laps: LapRecord[]}`) is **not** written on every
sample. `SessionController` writes one at exactly three points (`sessionController.ts`):

1. **On `pause()`** (`sessionController.ts:347-354`) — every explicit pause.
2. **On every completed lap** (`onLapCompleted()`, `sessionController.ts:489-498`) — right after
   `saveTelemetry` for that lap, before PB evaluation.
3. **On `endSession()`** (`sessionController.ts:366-392`) — a final terminal checkpoint is saved
   *in addition to* `saveSession`, specifically so recovery never re-offers a session that has
   already been fully saved (its checkpoint's `snapshot.state` is `'sessionComplete'`, which
   `composition.ts`'s recovery check treats as not-recoverable).

Each `saveCheckpoint` call is a full replace (`INSERT OR REPLACE INTO checkpoints`) — there is only
ever one checkpoint row per `sessionId`, always the most recent. Because checkpoints are not
per-sample, an app crash or kill *mid-lap between checkpoints* can lose in-progress telemetry back
to the last lap boundary or pause — the recovery flow below appends a `RECOVERY` placeholder lap
for exactly that gap rather than fabricating a real duration for it.

## Recovery flow (ADR-0003 §3, as implemented)

Binding rule from ADR-0003 §3: `performance.now()`'s origin resets every process launch, so a
`tMono` from before an app kill is never comparable to one after — recovery must never try to
resume an in-flight lap's live timer.

`SessionController.restoreFromCheckpoint(sessionId, snapshot, laps)` (`sessionController.ts:409-443`)
implements this:

1. Every historical `LapRecord` from the checkpoint's `laps` array is appended as-is to a **fresh**
   `SessionPipelineCore` (already-computed durations are safe to keep verbatim).
2. If the checkpoint's `snapshot.state` was mid-session (`'outLap'`, `'timing'`, or `'inPit'` — or
   `'paused'` with one of those as `context.priorState`), a synthetic **`RECOVERY` lap** is
   appended: `lapNumber: snapshot.lapNumber`, `tStart: 0`, `tEnd: 0`, `durationMs: 0`,
   `sectorTimes: []`, `valid: false`, `invalidReasons: ['RECOVERY']`, `quality: 'invalid'` — never
   a fabricated real duration for the lap that was actually still open.
3. The pipeline re-enters `awaitingCalibration` (`START_PREFLIGHT` → `PREFLIGHT_PASSED`) — a fresh
   Learn lap is required before timing can resume, because the position bias and matcher state from
   before the restart are gone.
4. `lastLapMs` is seeded from the last lap in the restored list (including a `RECOVERY` lap's `0`,
   if one was appended).

Two distinct resume paths exist after `restoreFromCheckpoint`:

- **`start('session')`** (the app's `resumeRecovery()` in `composition.ts:309-320`) — the
  "resume without recalibrating" path, used only right after a successful
  `restoreFromCheckpoint`. It skips a live Learn lap entirely: `SessionController` loads the
  last-known **stored reference lap** and dispatches a synthetic always-accepted calibration result
  (`recoverySkippedCalibrationResult()`, `confidence: 1`, `coverageFraction: 1`,
  `sessionController.ts:137-155`) straight to `armed`. See that method's own doc comment for why
  recovery deliberately never resumes a live calibration.
- **`start('calibration')`** — the normal, non-recovery path: a real live Learn lap.

`composition.ts`'s bootstrap additionally checks for a recoverable checkpoint at every app launch
(`bootstrapPromise`, `composition.ts:281-290`): it reads the `activeSessionId` settings key (see
sessionId convention below), loads that session's checkpoint, and if its `snapshot.state` is not
`'sessionComplete'` computes a `lapCount` for the recovery banner (`checkpoint.laps.length + 1` if
the checkpoint was mid-session) and publishes it via `subscribeRecovery()` for
`CircuitDetailScreen`'s inline (non-modal) recovery banner. `discardRecovery()` marks a
checkpoint terminal (overwrites its snapshot to `{state: 'sessionComplete', lapNumber: 0, context:
{}}`, laps `[]`) without resuming it — `LocalSessionRepository` has no delete method, so this is
the only way to stop a checkpoint from being offered again.

## `sessionId` convention

Minted once per session by `SessionController.start()` as `` `${userId}--<random>` `` (base-36
timestamp + random suffix, `randomToken()`, `sessionController.ts:112-114,272-275`). The app's
single local user id is the constant `'local-driver'` (`composition.ts:20`, see
`docs/known-limitations.md` — no per-user accounts exist). This prefix convention is load-bearing:
`SqlSessionRepository.deleteUserData()`'s orphan sweep (below) relies on it to find checkpoints/
telemetry rows for a session that has a checkpoint but was never `saveSession`d (e.g. the app
crashed before session end).

## `deleteUserData` coverage

Both implementations (`InMemorySessionRepository.deleteUserData`,
`SqlSessionRepository.deleteUserData`) delete, for a given `userId`:

- every `sessions`/`laps`/`checkpoints`/`telemetry` row belonging to a session the user owns (a
  session "owned" by a user is tracked via `saveSession` having recorded that mapping — the SQL
  version does this with a `sessions`-table join, the in-memory version with a separate
  `sessionOwners` map since `saveCheckpoint`/`saveTelemetry` are never themselves passed a
  `userId`);
- an **orphan sweep** by `sessionId` prefix (`` `${userId}--` ``) over `checkpoints` and `telemetry`
  — covering a session that was never `saveSession`d at all (still active, or crashed before
  saving) and therefore has no `sessions` row to join through;
- every `reference_laps` row where `userId` matches.

Both are wrapped in a single transaction (SQL) — `deleteUserData` either fully succeeds or leaves
the store untouched.

**Implementation note (reported, not fixed — out of this ticket's scope):** `deleteUserData` is
fully implemented and covered by contract tests
(`packages/core/test/persistence/contractSuite.ts`, `packages/core/test/persistence-sql/sqlSessionRepository.contract.test.ts`),
but nothing in `apps/mobile/src` ever calls it — there is no "Delete my data" affordance on
`SettingsScreen` or anywhere else in the UI (confirmed by search: `deleteUserData` has zero
call sites outside `packages/core`). See `docs/privacy.md`'s deletion-path section.

## Retention

**Nothing is deleted automatically.** Sessions, laps, telemetry, checkpoints, and the reference lap
persist indefinitely on-device until either (a) a newer valid lap replaces the stored PB (atomic
write-new-then-swap of the single `reference_laps` row for that circuit/layout/version — the old PB
row is gone, but its originating session/lap/telemetry rows are not touched), or (b) `deleteUserData`
is invoked (currently only reachable programmatically — see above). There is no time-based
expiry, size cap, or automatic pruning of old sessions anywhere in the repository implementations.

## What is stored where (including full PB telemetry)

| Data | Table | Written by | Shape |
|---|---|---|---|
| Session metadata (circuit/layout/start time/laps) | `sessions` + `laps` | `saveSession()`, called once at `endSession()` | `SessionSummary`; `laps` is a full replace of that session's lap rows |
| In-progress/resumable state | `checkpoints` | `saveCheckpoint()` (see cadence above) | `CheckpointCodec`-versioned `{snapshot, laps}` |
| **Raw per-lap telemetry** (every accepted `LocationSample` in that lap's time window) | `telemetry` | `saveTelemetry()`, called from `onLapCompleted()` for every completed lap, not just the PB lap | `LocationSample[]`, one row per `(sessionId, lapNumber)`, replace-not-append on a second write |
| **The personal best, resampled** | `reference_laps` | `putReferenceLap()`, called only when `shouldReplacePb` accepts a candidate | `ReferenceLap` — the 10 m-grid-resampled shape from `docs/algorithms/live-delta.md`, **not** the raw sample stream; provenance fields (`userId`, `sessionId`, `recordedAtUtc`, `appVersion`, `algorithmVersion`, `profileSchemaVersion`) are mandatory on every stored reference lap |
| App settings (units, delta deadband, coverage bins, `activeSessionId`) | `settings` (v2) | `SqlSettingsStore`/`composition.ts`'s `setActiveSessionId` | key-value JSON-ish text values |

"Full PB telemetry" is stored twice, in two different shapes, for two different purposes: the raw
`LocationSample[]` for the PB's originating lap lives in `telemetry` (same as every other lap's raw
telemetry — nothing PB-specific about that row), while the PB's own *resampled* distance/time grid
(what the live delta engine actually reads from) lives in `reference_laps`. Losing/clearing the
`telemetry` row for the PB's lap would not affect live-delta computation; it would only remove the
ability to re-inspect that lap's raw trace later (e.g. `LapDetailScreen`).
