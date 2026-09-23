# Handoff: cloud session, 2026-09-23

For the local lead session. Read `docs/HANDOFF.md` first, then this.

All of the cloud session's work is on `main`. **`git pull` brings in everything.** No build has been made,
nothing is installed, and nothing has been seen on the phone. The cloud session did not have Codex, so none
of this has had the cross-family review that HANDOFF rule 1 requires before a build. That review is the
first thing to do (see "What to do next").

---

## What is on `main`

The session's commits start after `966887d` ("Handoff brief for a fresh session"). To see everything it
changed:

```
git pull
git log --oneline 966887d..HEAD
git diff 966887d..HEAD --stat
```

There are three pieces of work. Only 2 and 3 change code.

| # | What | Where | Merged as |
|---|---|---|---|
| 1 | Prompt audit of the agent instruction files | docs, `apps/mobile/AGENTS.md`, `.claude/settings.local.json` | PR #1 + `dd84864` |
| 2 | Delete-all now clears the VIN and the vehicle data | `apps/mobile` + legal docs | PR #2 (`ae12a10`) |
| 3 | Signal Finder round no longer ends on an early timer wake-up | `packages/core` | PR #3 (`8c495b6`) |

---

## 1. Prompt audit (documentation and config only)

The report and the patch it proposed are in `docs/audits/prompt-audit-2026-09-23.md` and `.patch`. They
were applied as follows:

- **`apps/mobile/AGENTS.md`** (loaded on every turn through `apps/mobile/CLAUDE.md`)
  - Before: "Expo HAS CHANGED, read the docs before writing any code".
  - Now: it says why (Expo SDK 57 is newer than most training data) and applies only to changes that touch
    Expo or React Native APIs.
- **`docs/HANDOFF.md`**
  - "Read these before doing anything" now reads "Before changing an area, read the documents that cover it".
  - A pressure-only sentence under rule 1 is removed; the rule and its reason are unchanged.
- **`docs/NEXT-CIRCUIT-PLAYBOOK.md` §0**
  - The reference to a `/fable-foreman` skill that doesn't exist is removed, and so is "Sonnet-class workers".
    The lead / worker / cross-reviewer process stays.
  - "Read this before touching anything" is scoped to the area being changed.
  - "(non-negotiable process)" is removed from the heading.
- **`docs/roadmap/phase-5-llm-corner-analysis.md`**: a status note at the top says the LLM plan (§3 step 4)
  and the backend decision were replaced by the deterministic engine. The file used to say so only at the
  very bottom.
- **`.claude/settings.local.json`**: 14 one-off permission entries are removed (absolute Windows paths, one
  specific commit message, echo/cp/awk one-liners). **Check that your local allowlist still has what you
  use.**

---

## 2. Delete-all now clears the VIN and the vehicle data (HANDOFF item 1)

### The problem

"Delete all my data" (Settings → DATA) wiped the session tables through `@circuit/core`'s `deleteUserData`
and the mobile `telemetry_samples` step. It never touched:
- the VIN, `settings.lastSeenVin` inside the `app-settings` row (in the EU a VIN is personal data);
- `vehicle_profile_bindings`, `signal_finder_ruled_out` and `did_sweep_runs` / `_responders` /
  `_observation_samples` / `_observation_summaries`;
- the per-session vehicle snapshots, stored as `settings` keys `vehicle-profile-snapshot:<sessionId>`;
- `learned_circuits` (the geometry of circuits the driver taught the app).

### The fix

- **New `apps/mobile/src/persistence/deviceDataWipe.ts`:**
  - `wipeDeviceUserData(db)` runs inside ONE transaction:
    1. `DELETE` from the six vehicle tables, then counts each one.
    2. `DELETE FROM learned_circuits WHERE circuit_id NOT IN (SELECT circuitId FROM sessions)`. A learned
       circuit that a remaining session still uses is kept, so that session can still be analysed and
       replayed. It is counted as "remaining", so the wipe reports failure.
    3. Deletes every `vehicle-profile-snapshot:*` settings key.
    4. Rewrites the `app-settings` row without the VIN, then reads it back to confirm. If the row can't be
       parsed at all, it is deleted, because it might still hold a VIN.
    5. Returns `{ ok, remaining }`, where `remaining` lists only what was left behind.
  - `vehicleIdentityResetPatch(settings)` builds the settings patch. It always sets `lastSeenVin: null`. It
    also resets `activeVehicleProfileId` / `activeVehicleProfileSource` to their defaults **only when the
    source is `'vin'`**: a profile the VIN picked reveals the car's make and model. A profile the user
    chose is a preference and stays.
- **`apps/mobile/src/session/composition.ts`, `unlockedDeleteAllStoredUserData()`:**
  - Calls the wipe after the telemetry step. Like the telemetry step, it always runs, even when an earlier
    step failed.
  - A failure makes the overall `ok` false and adds "vehicle or learned-circuit data remained or could not
    be deleted" to `errorText`. The Settings screen therefore shows the error, not the success banner.
  - Then `forgetDeviceUserDataInMemory()` clears the in-memory copies:
    - the settings store (same patch, so the next `persist()` can't write the VIN back);
    - `cachedDetectedVin`, `vehicleProfileBindingsCache` and `sessionVehicleSnapshots`;
    - the learned circuits: `memoryLearnedCircuits` is emptied, then the store is refreshed and the catalog
      republished;
    - if the selected circuit no longer exists, the selection falls back to TMR through
      `unlockedApplySelection` (we are already inside `lifecycleLock`).
  - The circuit fallback is wrapped in try/catch, so it can never turn delete-all into an error the UI
    can't handle.
- **Small exports:** `SETTINGS_KEY` from `sqlSettingsStore.ts`, `SESSION_VEHICLE_SNAPSHOT_KEY_PREFIX` from
  `sessionVehicleSnapshot.ts`.

**What delete-all keeps, on purpose:** units, language, adapter address and port, the coaching / voice /
suggestion toggles, the selected circuit, and a vehicle profile the user chose. None of these identify the
driver or the car. The test-loop adoption journal (`testLoopAdoption`) also survives. It holds only a
circuit id and a session id, and the next launch cleans it up.

### Documentation changed with it

- `docs/legal/privacy-policy.en.md` and `.ro.md`: §3.3 (VIN) and §7 (right to erasure) now say what
  delete-all removes and what it keeps. The old "known limitation" text is gone.
- `docs/legal/compliance-checklist.md`: item 3.5 is DONE.
- `docs/HANDOFF.md`: item 1 is marked fixed.

### Tests

- **New `apps/mobile/test/persistence/deviceDataWipe.test.ts`** (8 tests, real SQLite via sql.js):
  - the full wipe;
  - preferences and unrelated settings keys are kept;
  - a learned circuit that a session still uses is kept and reported;
  - an empty device;
  - an unreadable settings row;
  - a missing table rolls back and rejects;
  - the two `vehicleIdentityResetPatch` cases.
- **New end-to-end test** in `apps/mobile/test/session/composition.circuitSelection.test.ts` ("HANDOFF
  release blocker: …"):
  - Sets up a VIN, a binding, a sweep run, a learned circuit and a snapshot, then calls
    `deleteAllStoredUserData()` and checks memory and disk.
  - **Verified to fail without the `composition.ts` change** (`expected 'WZ1DB0C04LW000001' to be null`).
- **Four composition test files** (`circuitSelection`, `facadeBoundary`, `gForceOwnership`,
  `telemetryRecording`) now call `migrateDidSweepSchema`, as `openAppDatabase()` does in production. Their
  databases never had those tables. Before this change their six delete-all tests failed with
  `no such table: vehicle_profile_bindings`.

---

## 3. Signal Finder: an early timer wake-up no longer ends the round

### The problem

In `packages/core/src/telemetry/signalFinder/runner.ts`, when every entry is backed off, `runFinderRound`
sleeps with `setTimeout` until the next evidence-window boundary. Then it ends the round if
`clock.now() < boundaryMs`.

The timer and `Date.now()` are separate clocks. A timer can fire a millisecond before `Date.now()` reaches
its target: locally, 22 out of 400 wake-ups did. When that happened, the round ended in the first backed-off
window. A DID that recovered moments later was never sampled again and scored `insufficient`. This is the
same result the Y3 fix (Codex P4m-REV2 finding 13) had removed.

It showed up once in CI: the Y3 test failed on the push run of PR #2 (run 35843788977), and the round ended
after 212 ms of 600.

### The fix

The sleep is now a loop. It keeps waiting (at least 1 ms each time) until the round's own clock reaches
`min(boundary, end of round)`, or until a stop. After that, the existing check decides whether the round
continues. Nothing else in the runner changed.

### Tests

- **New test in `packages/core/test/telemetry/signalFinder/runner.test.ts`** ("Y3: a cooldown sleep that
  wakes before the clock reaches the window boundary…"):
  - The clock runs 2 % slower than the timers, so every wake-up is early.
  - Failed 3/3 before the fix (the round ended at ~98 ms). Passes after.
- **Signal Finder suite:** all 169 tests, 5 runs in a row.
- **Other core code that sleeps and then compares the clock:** `didSweep.ts` just keeps looping after an
  early wake-up, so it isn't affected.

---

## Verification done in the cloud (on the merged `main`, `edb7bd5`)

| Gate | Result |
|---|---|
| `npm run typecheck` | 0 |
| `npm run lint` | 0 errors, 6 warnings (the existing `didSweep*` ones) |
| `npm test` | 3407 passed (1787 core + 1620 mobile) |
| `cd apps/mobile && npx expo export --platform ios` | 0 |

In GitHub CI, Gates (typecheck / lint / test) was green on both PRs. License policy and osv-scan are red,
the same way as on `main` before this session (HANDOFF §6: leave them, don't widen the policy).

**Not verified:**
- No run on a device. There is no React Native render harness, so the Settings screen itself is not
  covered.
- No Codex review.

---

## What to do next

1. **Pull and re-run the gates locally** on real exit codes (playbook §0):

   ```
   git pull
   npm ci
   npm run typecheck > tc.log 2>&1; echo $?
   npm test > test.log 2>&1; echo $?
   npm run lint > lint.log 2>&1; echo $?
   cd apps/mobile && npx expo export --platform ios; echo $?
   ```

2. **Run the Codex review.** The ticket is `.foreman/scratch/ticket-p18-rev1-codex.md`:

   ```
   codex exec --sandbox read-only -C <repo> - < .foreman/scratch/ticket-p18-rev1-codex.md
   ```

   - It reviews `git diff dd84864..edb7bd5` (items 2 and 3 above) and names seven specific things to attack.
   - The review must end with zero HIGH findings before any build (HANDOFF rule 1).
   - If Codex runs out of quota partway through, say so. A partial run is not a pass.
3. **Fix the findings** in one batched fix wave (playbook §0), then run Codex again on the fix diff.
4. **Check delete-all on the phone,** if it fits the install budget before Monday's session at MotorPark
   (28 Sep):
   - Delete all data on a phone that has a VIN and a learned circuit.
   - The success banner appears.
   - The Signal Finder shows no VIN.
   - The learned circuit is gone from the list.
   - Units and language are unchanged.
   - Monday's test protocol does not depend on this.
5. **Add a ledger entry** in `.foreman/ledger.md` for this session and the review result. The cloud session
   did not write one.
