# Handoff — TRACE, 2026-09-23

Brief for a fresh session. Self-contained: you should not need the previous conversation.

---

## What this is

**TRACE** — a GNSS lap timer and driver-coaching app for racetracks. TypeScript npm-workspaces monorepo:
`packages/core` is a pure engine (one runtime dependency, `zod`), `apps/mobile` is Expo SDK 57 / React
Native 0.86 on iOS, installed by sideloading. Repo is **public**: `dobrinz123/track_app`.

State at this commit: **3397 tests green**, typecheck 0, lint 0 errors (6 pre-existing warnings in
`didSweep*` files — leave them). Build 13 delivered to the owner.

**Before changing an area, read the documents that cover it.** They are current and were written for exactly this purpose:

| Document | What it gives you |
|---|---|
| `docs/architecture/map-core-timing.md` | How a GNSS sample becomes a lap time; the invariants and why |
| `docs/architecture/map-core-analysis.md` | The analysis engine, the data model, schema v1→v6 |
| `docs/architecture/map-mobile-app.md` | The composition root, the screens, **the platform fences** |
| `docs/architecture/map-data-and-infra.md` | Assets, generators, CI, firmware, and a clean-clone runbook |
| `docs/architecture/flow-review.md` | End-to-end journeys and where they still break |
| `docs/architecture/public-release-plan.md` | What blocks App Store / Play, ordered |
| `docs/legal/` | Draft privacy policy, terms, store privacy labels, permission strings, compliance checklist |
| `.foreman/ledger.md` | 200 KB append-only history. Grep it; do not read it whole |

---

## The hard rules this project runs on

These are the owner's, learned the hard way. Breaking them is how this app lost him a track day.

1. **No build without the full chain.** Gates → independent review at **zero HIGH findings** → then build.
2. **Never report success you did not observe.** Weeks of work went into making a failed read surface as
   FAILED rather than as "there was nothing". If you cannot verify something, say so.
3. **Field facts come from the owner, never guessed.** What happened at the track, how the phone is
   mounted, what he saw on screen — ask. Technical trade-offs are yours to decide; do not quiz him on those.
4. **Honesty gates are load-bearing, not decoration.** `geometryStatus`, calibration provenance, the
   four-valued availability model. Do not widen one to make a feature appear.
5. **Never delete a lap boundary you cannot confirm — mark it.** Three attempts at deciding the pit
   question each silently deleted or invented real laps. The rule that finally worked is that nothing is
   deleted, so no threshold can be outrun.
6. Gates run from the repo root; **`npx expo export --platform ios` runs from `apps/mobile`** — from the
   root it fails on AppEntry resolution, and that is expected, not a defect.
7. There is **no React Native render harness** and adding one has been declined repeatedly. Put decisions
   in pure tested modules and keep JSX thin. Never claim render coverage you do not have.

---

## Open work, in the order I would take it

### 1. `deleteUserData` does not delete the VIN — RELEASE BLOCKER

`packages/core/src/persistence-sql/sqlSessionRepository.ts` `deleteUserData` clears `sessions`, `laps`,
`checkpoints`, `telemetry`, `lap_verdicts`, `calibration_attempts`, reference laps and the active-session
pointer. **It does not touch `settings`**, where `lastSeenVin` lives (`apps/mobile/src/persistence/sqlSettingsStore.ts`),
along with vehicle bindings, ruled-out signals, DID sweep records and learned-circuit geometry.

So "Delete all my data" in Settings leaves the vehicle's VIN on the device. In the EU a VIN is personal
data. The drafted privacy policy states this gap plainly rather than papering over it — fix the code and
then correct `docs/legal/privacy-policy.*.md`.

Decide deliberately what a full delete should keep: user *preferences* are arguably not user *data*, but
the VIN, the bindings and learned geometry clearly are.

### 2. MotorPark's corner segmentation reads wrong

Corner 1 is a 158 m "corner" with a 324 m brake distance. The numbers are true; the label is not useful.
This is the resolution limit of a coarse traced line, not a bug in the gate. `analyzeCorners` against the
densified MotorPark asset is the place to look. The owner sees this on Monday.

### 3. Off-track classification is the last ungated geometry-sensitive verdict

`packages/core/src/coaching/cleanLap.ts:762` calls a lap off-track at |lateral| > 15 m from the traced
line. On a badly traced circuit it can drop clean laps from every corner's clean set. It fails closed, so
it only ever reduces what is claimed — but it is the one place a traced line still decides a verdict.

### 4. Flow-review leftovers

F8 (a "CALIBRATION UNKNOWN" flash at every session end, from an unordered cache refresh), F9
(`PAUSE_GAP`/`RECOVERY` have no plain-language copy, so locking your phone yields "• pause gap"), F10
(learned circuits always draw three sectors against an empty `sectorGates`), F11 (a personal best can link
to "Lap not found"), plus a ten-item *correct but confusing* list. Details in `flow-review.md`.

### 5. Store readiness

`docs/architecture/public-release-plan.md` and `docs/legal/compliance-checklist.md`. The long poles are
legal identity and EU DSA trader status — Apple **removes** EU apps without it — and the fact that Android
has never once been built. Twenty-one questions only the owner can answer are consolidated in the
checklist's §8; get answers before doing store work, not during.

### 6. Parked backlogs

Licence policy: nine packages outside the allowlist, none AGPL/GPL, all attribution-only. Advisories: 29
(1 critical, dev-only). Both have a CI job that is **expected red** today. Do not "fix" them by widening
the policy.

---

## Accepted residuals — documented, in the owner's test protocol, do not re-report as new

Each needs a failure **plus** a specific sequence; raw data survives in all of them.

- A GPS gap over 7 s at the start/finish line can coalesce two laps into one.
- An 8 m bias sustained ~30 s near the pit lane can emit an unmarked lap boundary.
- A crash-and-resume can report a section `empty` where `partial` would be honest.
- A verdict saved immediately after a read failure can regress its revision number.

---

## Context you would otherwise have to rediscover

- **Monday 28 Sep the owner drives MotorPark România (Adâncata)** — the app's first ever real circuit
  session. Everything recent is aimed at that: the app has never timed a lap on a track, and he already
  came home from Transilvania Motor Ring once with nothing, because calibration stalled at 83 % and he
  never reached a session. `builds/ipa/TEST-13-PROTOCOL.md` is what he will follow.
- **The verdict control is the point of build 12/13.** He answers, per lap, whether the app judged
  validity correctly. That is ground truth for rules nobody has ever checked. Expect that data back.
- **Coaching was just unlocked (P17)** on the argument that the analysis is self-referential — every lap
  measured through the same windows, so a displaced line cancels. Pit suggestions run on any stated
  provenance; live cue moves stay on `'official'`. If you touch this, read the reasoning first; it was
  earned and it is easy to undo by accident.
- **Codex is the release reviewer** (`codex exec --sandbox read-only -C <repo> - < ticket.md`). It has
  found things a same-family reviewer missed, twice. It has also hit its quota mid-review twice — if that
  happens, say so rather than treating a partial run as a pass.
- **`builds/` is gitignored** and holds the only copies of every shipped `.ipa`. GitHub artifact retention
  is 90 days.
- Delivery is Sideloadly, unsigned builds, one phone. There is no TestFlight and no signing yet.

---

## Working style that has worked here

Delegate implementation, verify it yourself — run the gates rather than trusting a report. Write tickets
that say what to prove, not only what to build; the measurement table has repeatedly been worth more than
the diff. When a worker pushes back with numbers, it is usually right. And prefer a precise "this cannot
be done safely, here is why" over a plausible fix.
