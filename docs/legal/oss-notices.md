> **DRAFT — prepared for review by a qualified lawyer licensed in Romania and the EU.**
> This is **not legal advice**. It states what the project's own inventory and licence-policy job
> found on **23 September 2026**, and proposes a form for discharging the attribution obligations.
> Document version: **1.0-draft**.

# Open-source notices — what TRACE must ship, and how to generate it

## 1. Where this stands today

The app has **no open-source notices screen**. What exists is one sentence on the Settings → ABOUT
card:

> "Built with Expo, React Native, and React Navigation, each under their respective open-source
> licenses."

That sentence names three projects out of roughly a thousand packages and reproduces no licence
text. **It does not discharge the MIT/BSD/Apache-2.0 obligation**, which is to reproduce the
copyright notice and the licence text in the documentation or materials distributed with the
software, and it does not discharge the OFL or Creative Commons attribution obligations at all.

The ODbL obligation for the circuit geometry **is** discharged. See §5.

---

## 2. What must appear

### 2.1 The permissive bulk (MIT, BSD-2/3-Clause, ISC, Apache-2.0, 0BSD, CC0, Unlicense, Python-2.0, BlueOak-1.0.0)

These are the licences the project's CI policy already allows
(`.github/workflows/security-and-ci.yml`, `license-policy` job). For each package that ships inside
the binary, the notices screen must reproduce:

- the package name and version;
- the licence identifier;
- **the copyright line(s) and the full licence text**, verbatim.

MIT and BSD say this literally ("The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software"). Apache-2.0 §4 adds that any
`NOTICE` file shipped by the package must be reproduced too — check for `NOTICE` files in the
dependency tree and carry their contents through.

### 2.2 The nine packages outside the allowlist

None is GPL or AGPL, so none forces source disclosure of TRACE itself. All nine require
attribution, and two of them need a little more care.

| Package(s) | Licence | Ships in the binary? | What is required |
|---|---|---|---|
| `@expo-google-fonts/inter`, `@expo-google-fonts/jetbrains-mono`, `@expo-google-fonts/space-grotesk` | **MIT AND OFL-1.1** | **Yes.** `App.tsx` loads nine faces (`Inter_400/500/600`, `JetBrainsMono_400/500/600/700`, `SpaceGrotesk_600/700`) through `useFonts`; the `.ttf` files are packaged | OFL-1.1 §1–§2: the font files may be bundled and redistributed, but the **copyright notice and the full OFL licence text must travel with them**, and the Reserved Font Names must not be used for modified versions. Reproduce the copyright line for each family (Inter — The Inter Project Authors; JetBrains Mono — The JetBrains Mono Project Authors; Space Grotesk — Florian Karsten) plus the OFL-1.1 text once. The wrapper packages' own MIT licence is reproduced under §2.1 |
| `caniuse-lite` | **CC-BY-4.0** | **No** — browser-support data used by build tooling (browserslist), not reachable from a React Native runtime | Attribution required **if distributed**. Since it is not in the binary, it belongs in a repository-level `THIRD-PARTY-BUILD.md`, not in the app's notices screen. Include it anyway if the screen is generated from the full tree: over-crediting costs nothing |
| `lightningcss` + its `win32` native binary | **MPL-2.0** | **No** — CSS transform used by the web/bundler path | MPL-2.0 is **file-level copyleft**: if you modify an MPL file you must publish that file's source under MPL. We modify nothing. The obligation is to reproduce the licence and state where the source is (https://github.com/parcel-bundler/lightningcss). Same placement as `caniuse-lite` |
| `spdx-exceptions`, `spdx-expression-validate`, `spdx-ranges` | **CC-BY-3.0** | **No** — transitive dependencies of the licence checker itself | Attribution required if distributed. Repository-level notice only |

**The practical consequence:** the only one of the nine that genuinely has to be on the in-app
screen is the font group. The other six are build-time tooling. Keep both lists anyway — one
generated inventory, two rendered documents — because "is it in the binary?" is a question that
changes every time a dependency moves, and a generated list that is too long is safe while a curated
list that is too short is not.

### 2.3 Policy change to make alongside this

The CI `license-policy` job fails today, by design, and the ledger's instruction was not to widen
the allowlist until the findings were understood. They now are. The correct fix is a **documented**
widening — each newly admitted licence class carrying, in the workflow file or a policy document
beside it, the written reason it is admitted and what discharges it:

```
OFL-1.1     admitted — font files shipped in the binary; discharged by the in-app notices screen
CC-BY-4.0   admitted — build-time data (caniuse-lite); discharged by the repository notices file
CC-BY-3.0   admitted — build-time data (SPDX tables); discharged by the repository notices file
MPL-2.0     admitted — build-time tool (lightningcss), unmodified; discharged by licence + source URL
```

Do not add GPL or AGPL to that list. The gate exists to catch exactly those.

### 2.4 The three `UNLICENSED` workspace packages

`circuit-timer`, `@circuit/core` and `mobile` carry no `license` field. That is the normal convention
for private packages — but **this repository is public**, and "UNLICENSED" on a public repository
means nobody may legally use, copy or contribute to the code, which is probably not what is
intended. This is a deliberate decision for the owner, not a default to leave standing. See
`compliance-checklist.md` §8.

---

## 3. The in-app notices screen — the form it should take

**Where.** Settings → ABOUT → a new row, *"Open-source licences" / "Licențe open-source"*, opening a
scrollable screen. Both stores expect the notices to be reachable inside the app, not only from a
website.

**What it contains, in order:**

1. **One-line heading**, in the app's current language:
   - EN: "TRACE includes the open-source software listed below. Each component is used under its own
     licence, reproduced in full."
   - RO: "TRACE include software-ul open-source listat mai jos. Fiecare componentă este folosită sub
     licența proprie, reprodusă integral."
2. **Map data attribution**, first, because it is the one with a placement rule (§5).
3. **Fonts**, with their copyright lines and the OFL-1.1 text in full.
4. **Every other bundled package**, alphabetically: `name@version — SPDX-ID`, then the copyright
   line, then the licence text. Identical licence texts may be de-duplicated — render the text once
   and list the packages that share it — as long as each package's own copyright line is shown.
5. **App version and the date the inventory was generated**, so a reviewer can tell whether the
   screen matches the build.

**How it is implemented.** A generated `licenses.json` asset, imported statically into the bundle
exactly the way the circuit profiles are, rendered by a plain scrolling screen. No runtime fetch —
the app has no network code and must not acquire any for this.

**Do not translate the licence texts.** Licence text is reproduced verbatim in its original English.
Only the surrounding headings and the screen's own title are localised.

---

## 4. How to generate it repeatably

The requirement is that the notices can be regenerated from the lockfile by a single command, so
they cannot drift from what is actually shipped.

**Proposed script:** `packages/core/scripts/generate-oss-notices.ts` (or `apps/mobile/scripts/`),
run as `npm run generate:notices`, following the same discipline as the circuit generators —
deterministic output, byte-pinned by a test.

```
npm run generate:notices
```

**What it must do:**

1. Resolve the **production** dependency tree of `apps/mobile` from the single root
   `package-lock.json` (`npm ls --all --omit=dev --json` from the repo root).
2. For each resolved package, read `node_modules/<pkg>/package.json` for `name`, `version`,
   `license`/`licenses`, `author`, `repository`, and read the first file matching
   `LICENSE*`/`LICENCE*`/`COPYING*`/`NOTICE*` in that package's root.
3. **Fail loudly** on any package with no licence file and no `license` field, and on any SPDX id
   outside the documented policy of §2.3 — same posture as the circuit generators, which throw
   rather than emit a quietly different asset.
4. Emit two artefacts:
   - `apps/mobile/assets/licenses.json` — the in-app data, restricted to packages that reach the
     binary;
   - `THIRD-PARTY-NOTICES.md` at the repository root — the complete list including build-time
     tooling, which is where `caniuse-lite`, `lightningcss` and the SPDX packages are discharged.
5. Append the hand-maintained entries that npm metadata cannot produce: the **OpenStreetMap/ODbL**
   block, the three **font copyright lines and the OFL-1.1 text**, and any `NOTICE` file contents
   found in step 2.

**Pin it with a test**, in the same style as `tmr-profile.asset.test.ts`: regenerate in-memory and
assert byte-identity with the checked-in `licenses.json`. Then a dependency change that alters the
notices fails the suite instead of shipping a stale screen.

**Wire it into the gate.** `npm run generate:notices && git diff --exit-code` in CI proves the
checked-in notices match the lockfile.

**Tooling note.** The repo already has `@onebeyond/license-checker` as a dev dependency for the CI
policy job. It answers "is this licence allowed?"; it does not produce notice text. Use it for the
gate and the generator script for the content — do not try to make one do both.

---

## 5. OpenStreetMap / ODbL — already discharged, do not remove

Circuit geometry is derived from OpenStreetMap, © OpenStreetMap contributors, under the **Open
Database License 1.0**. The OSM Foundation's attribution guidelines accept "© OpenStreetMap
contributors" as the credit, and for an app allow the attribution to appear next to the map, on a
splash screen, or behind an info/menu item as long as it is reachable.

Verified locations in this codebase:

| Where | File | Text |
|---|---|---|
| Settings → About card | `apps/mobile/src/ui/screens/SettingsScreen.tsx` (~line 1076) | "Circuit geometry data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0. Start/finish and sector boundaries are app-defined, not official." |
| Circuit detail screen | `apps/mobile/src/ui/screens/CircuitDetailScreen.tsx` (~line 262), composed from `apps/mobile/src/ui/data/circuit.ts:5` | `© OpenStreetMap contributors (ODbL)` plus a per-circuit provenance line with OSM way ids and the retrieval date |
| The data itself | each circuit asset's `source: { name, license, url, retrievedAt }` field, plus MotorPark's `confidenceNotes` | — |
| Repository | `README.md`, licence/attribution section | — |

Guarded by `apps/mobile/test/ui/data/circuit.test.ts` and by the per-build forensic pass, which
greps the compiled Hermes bundle for `ODbL`.

**A UI-cleanup request to delete this text was previously refused as licence-required and the text
relocated instead. Keep it that way.** When the notices screen is built, the ODbL block goes at the
top of it **in addition to** the existing two placements, not instead of them.

**One open point:** the generated circuit assets are a *Derivative Database* of OSM under ODbL, not
merely a Produced Work. They are compiled into the app rather than published as a database, and the
generators plus their archived Overpass inputs are in a public repository, which is the substance of
the share-alike obligation. `[LAWYER: confirm that publishing the generator scripts and the archived
input snapshots satisfies ODbL §4.6 for the derivative database, or whether the generated
`*.json` profiles should additionally be offered under ODbL explicitly.]`

---

## 6. Where the notices must also appear outside the app

| Place | What to put there |
|---|---|
| App Store listing | No notices field exists; the in-app screen is the discharge. Do not put licence text in the description |
| Play listing | Same |
| Public website / support page | Publish `THIRD-PARTY-NOTICES.md` at a stable URL and link it from the privacy policy and the support page — useful for the build-time components that are not on the in-app screen |
| Repository | `THIRD-PARTY-NOTICES.md` at the root, regenerated by the same command |

---

## Sources

- [OpenStreetMap Foundation — Licence/Attribution Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
- SIL Open Font License 1.1 — https://openfontlicense.org/
- Mozilla Public License 2.0 — https://www.mozilla.org/MPL/2.0/
- Creative Commons BY 3.0 / BY 4.0 — https://creativecommons.org/licenses/
- Project inventory: `.github/workflows/security-and-ci.yml` (`license-policy` job),
  `docs/architecture/map-data-and-infra.md` §6.1
