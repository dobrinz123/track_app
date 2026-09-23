# Handoff: cloud session, 2026-09-23 (afternoon)

For the local lead session. Read this after `docs/HANDOFF.md`. It lists what the cloud session did, what is
merged, what is still sitting in open PRs, and the one step that has to happen before any of it reaches a
build.

Nothing from this session has been built, installed or seen on the phone.

---

## State of `main`

`main` is at `dd84864`. Everything below "On main" is merged. Everything below "Open PRs" is **not** on
`main`, so a plain `git pull` does not bring it in.

### On main (documentation and config only, no code)

- `21c07c3` (PR #1) and `dd84864`: prompt audit of the agent instruction files. Report and patch are in
  `docs/audits/prompt-audit-2026-09-23.md`. What changed:
  - `apps/mobile/AGENTS.md`: the Expo-docs rule now applies only to changes that touch Expo or React Native
    APIs.
  - `docs/HANDOFF.md` and `docs/NEXT-CIRCUIT-PLAYBOOK.md` §0: the "read before anything" lines are scoped
    to the area being changed; the missing `/fable-foreman` skill reference is gone.
  - `docs/roadmap/phase-5-llm-corner-analysis.md`: a status note says the LLM plan in §3 step 4 was replaced
    by the deterministic engine.
  - `.claude/settings.local.json`: 14 one-off permission entries removed (Windows paths, one commit
    message, echo/cp/awk one-liners). Check that your local allowlist still has what you use.

### Open PRs

| PR | Branch | Head | What it does | CI |
|---|---|---|---|---|
| #2 | `claude/api-prompt-audit-j5cmxo` | `ae12a10` | HANDOFF item 1: delete-all now clears the VIN and the vehicle data | Gates green on the PR run |
| #3 | `claude/signal-finder-early-wake` | `8c495b6` | Signal Finder round no longer ends on an early timer wake-up | Gates green |

On both PRs, License policy and osv-scan are red. They are red on `main` too, and HANDOFF §6 says to leave
them.

**PR #2** (`apps/mobile` + docs):
- New `apps/mobile/src/persistence/deviceDataWipe.ts`, called from `deleteAllStoredUserData()` in
  `composition.ts`. It deletes, in one transaction, and then verifies:
  - the VIN in the stored settings, and a vehicle profile the app picked from the VIN
  - `vehicle_profile_bindings`, `signal_finder_ruled_out` and the four `did_sweep_*` tables
  - the `vehicle-profile-snapshot:*` settings keys
  - `learned_circuits`, except a circuit that a remaining session still uses
- It also clears the in-memory copies (VIN, bindings cache, snapshots, learned catalog). If the selected
  circuit was a learned one, the selection falls back to TMR.
- Kept on purpose: preferences, and a vehicle profile the user chose.
- The privacy policies (EN/RO §3.3 and §7), compliance checklist item 3.5 and HANDOFF item 1 are updated in
  the same PR.
- Four composition test doubles now create the DID sweep tables that `openAppDatabase()` always creates.

**PR #3** (`packages/core` only):
- `packages/core/src/telemetry/signalFinder/runner.ts`: when every entry is backed off, the round used to
  end if the timer woke up even 1 ms before `Date.now()` reached the window boundary. That happened on
  about 5% of wake-ups locally. It now keeps waiting until the clock itself crosses the boundary.
- This is why the Y3 test failed once in CI on PR #2 (run 35843788977). A new test with a 2%-slow clock
  failed 3/3 before the fix and passes after.

Gates run locally in the cloud session, on each branch:

| | typecheck | lint | tests | expo export (iOS, from `apps/mobile`) |
|---|---|---|---|---|
| PR #2 | 0 | 0 errors, 6 old warnings | 3406 (1786 core + 1620 mobile) | 0 |
| PR #3 | 0 | 0 errors, 6 old warnings | 3398 (1787 core + 1611 mobile) | 0 |

---

## What the local session should do next

1. **Run the Codex review before any build.** HANDOFF rule 1 requires zero HIGH findings. Codex was not
   available in the cloud. The ticket is `.foreman/scratch/ticket-p18-rev1-codex.md`:

   ```
   git fetch origin
   codex exec --sandbox read-only -C <repo> - < .foreman/scratch/ticket-p18-rev1-codex.md
   ```

   If Codex runs out of quota partway through, say so. A partial run is not a pass.
2. **Fix what it finds on the PR branches.** Push to the same branch, and CI re-runs on the PR.
3. **Merge #3 before #2, or merge `main` into #2 after #3 lands.** They touch different files, so there is
   no conflict. Doing it in that order just gives #2 a CI run with the Y3 fix in place.
4. **Check delete-all on the device before Monday's session at MotorPark (28 Sep).** There is no render
   harness:
   - Delete all data on a phone that has a VIN and a learned circuit.
   - Confirm the success banner appears.
   - Confirm the Signal Finder shows no VIN.
   - Confirm the learned circuit is gone from the list.
   - Only do this if it fits into the next build's install budget. Monday's test protocol does not depend on
     it.

## Not done, on purpose

- The test-loop adoption journal (`testLoopAdoption` in `settings`) survives delete-all. It holds only a
  circuit id and a session id, and the next launch cleans it up.
- `.claude/settings.local.json` is still tracked by git. Removing it from git would delete it from every
  existing clone on the next pull.
- `.foreman/ledger.md` has no entry for this session. Add one when you pick this up, so the ledger stays the
  single history.
