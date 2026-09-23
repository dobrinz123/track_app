> **DRAFT — prepared for review by a qualified lawyer licensed in Romania and the EU.**
> This is **not legal advice**. It is an engineering-and-compliance checklist assembled from the
> TRACE source tree and the two stores' current published requirements, on **23 September 2026**.
> Document version: **1.0-draft**.

# TRACE — pre-submission compliance checklist

**How to read the status column**

| Status | Meaning |
|---|---|
| **DONE** | Verified true in the code or configuration as it stands |
| **TODO** | Work the team can complete without outside help |
| **NEEDS A LAWYER** | Cannot be closed without a qualified Romanian/EU lawyer signing it off |
| **OWNER** | A decision or a fact only the app's owner can supply — all collected in §8 |

Ordered so that each stage unblocks the next. Do not reorder §1 and §2: the legal drafting and the
account verification are the two long poles and both start on day one.

---

## 1. Start these first — they are slow and depend on nothing else

| # | Item | Status | What unblocks it |
|---|---|---|---|
| 1.1 | Decide the legal identity that publishes the app (individual / PFA / ÎI / SRL) | **OWNER** | An hour with an accountant. Everything else with a name in it waits on this |
| 1.2 | Engage a Romanian lawyer to review `privacy-policy.*.md` and `terms.*.md` | **NEEDS A LAWYER** | The drafts exist; hand them over as they are |
| 1.3 | Apple Developer Program enrolment (99 USD/yr), identity verification | **TODO** | 1.1. Allow 1–3 days |
| 1.4 | Google Play Console registration (25 USD once) + developer identity verification | **TODO** | 1.1 |
| 1.5 | **EU Digital Services Act trader status** in App Store Connect: name, address, phone, email, verified | **TODO / OWNER** | 1.1 and 1.3. **Apps without verified trader status are removed from the EU App Store.** The contact details become public on the listing ([Apple](https://developer.apple.com/news/?id=einwn76m)) |
| 1.6 | Play Console equivalent: verified developer contact details and (for individual accounts) identity verification | **TODO / OWNER** | 1.1, 1.4 |
| 1.7 | Public hosting for the privacy policy and terms, RO + EN, at stable URLs | **TODO / OWNER** | Both stores require a reachable privacy-policy URL; Play requires it for **every** app regardless of the Data safety answers |
| 1.8 | A support email and support URL that a real person reads | **OWNER** | — |

---

## 2. The documents themselves

| # | Item | Status | Notes |
|---|---|---|---|
| 2.1 | Privacy policy, EN | **DONE (draft)** | `privacy-policy.en.md` |
| 2.2 | Privacy policy, RO | **DONE (draft)** | `privacy-policy.ro.md` |
| 2.3 | Terms of use, EN | **DONE (draft)** | `terms.en.md` |
| 2.4 | Terms of use, RO | **DONE (draft)** | `terms.ro.md` |
| 2.5 | Lawyer review of all four, with particular attention to the liability limits and the motorsport assumption of risk | **NEEDS A LAWYER** | Romanian unfair-terms law (Law 193/2000) governs how far §11 of the terms can go |
| 2.6 | Fill every `[OWNER: …]` placeholder | **OWNER** | See §8 |
| 2.7 | Decide which language version governs on divergence | **NEEDS A LAWYER** | Romanian is the safer default for a Romanian controller |
| 2.8 | Decide whether a DPIA is required (GDPR Art. 35) | **NEEDS A LAWYER** | Arguments both ways: systematic precise-location monitoring points toward one; entirely on-device processing with no controller access points away. The ANSPDCP list of processing requiring a DPIA is the reference |
| 2.9 | Version and date on every published document, with the previous version kept online | **TODO** | The drafts already carry version and date headers |

---

## 3. What the app must do before the policy is true

Each of these is a statement the privacy policy makes, or needs to make, and which the code must
support.

| # | Item | Status | Notes |
|---|---|---|---|
| 3.1 | Data stays on the device; no network egress | **DONE** | Source audit: zero `fetch` / `XMLHttpRequest` / `axios` / `WebSocket` / `expo-updates` in `apps/mobile/src` and `packages/core/src`. Re-run this audit on the submission commit |
| 3.2 | No analytics, ads, crash reporting or third-party data-collecting SDK | **DONE** | Verified against both workspace `package.json` files |
| 3.3 | Foreground-only location; no background/Always permission | **DONE** | `permissions.ts` never calls `requestBackgroundPermissionsAsync`; `app.json` sets the location plugin's background flags false |
| 3.4 | In-app delete control | **DONE** | Settings → DATA → "Delete all my data", with confirm-again, refusal while a session is active, and verify-empty before reporting success |
| 3.5 | Delete-all clears the stored VIN, VIN-selected vehicle profile, confirmed vehicle bindings, ruled-out signals, DID sweep records, per-session vehicle snapshots and learned-circuit geometry | **DONE** | `wipeDeviceUserData()` (`apps/mobile/src/persistence/deviceDataWipe.ts`) runs inside `deleteAllStoredUserData()` and verifies every table empty before success is reported. Preferences are kept by design (units, language, adapter address, toggles, selected circuit, a user-chosen profile). A learned circuit a surviving session still uses is kept and the wipe reports failure. Privacy policy §3.3 and §7 updated to match |
| 3.6 | In-app export (access + portability) | **DONE** | Session report share (JSON + Markdown), analysis export, raw session export; all user-initiated through the OS share sheet |
| 3.7 | Learned circuits can be deleted individually | **DONE** | `CircuitDetailScreen` calls `deleteLearnedCircuit()` |
| 3.8 | Settings screen is English-only while the app ships a Romanian UI | **TODO** | The delete control, the About card and the ODbL attribution are all hardcoded English. A Romanian user exercising erasure reads an English screen; the licence-required attribution is also English-only |
| 3.9 | In-app permission rationale names the app "Circuit Timer", not "TRACE" | **TODO** | `permissions.ts`; the precise-location instructions send users to a Settings entry that does not exist. See `permission-strings.md` §5 |
| 3.10 | Links to the privacy policy and terms from inside the app | **TODO** | Both stores expect them reachable in-app, not only from the listing. Add rows to the About card |
| 3.11 | Open-source notices screen | **TODO** | See `oss-notices.md` §3–§4 |
| 3.12 | ODbL attribution surfaced in-app | **DONE** | Settings About card and circuit detail screen; guarded by a test and by the per-build Hermes-bundle grep |
| 3.13 | Diagnostic exports may contain the VIN in raw hex if a sweep range includes DID `0xF190` | **TODO** | Either warn on the sweep export screen, redact known VIN DIDs from sweep records, or keep the diagnostic screens behind the existing developer-mode gesture for public builds |

---

## 4. Store configuration

| # | Item | Status | Notes |
|---|---|---|---|
| 4.1 | Replace the Expo-default `NSMotionUsageDescription` | **TODO** | Replacement drafted in `permission-strings.md` §3 |
| 4.2 | Romanian `InfoPlist.strings` for all four usage descriptions | **TODO** | `permission-strings.md` §4 |
| 4.3 | `ITSAppUsesNonExemptEncryption: false` declared in `app.json` | **TODO** | Absent today; Apple asks on every upload otherwise |
| 4.4 | iOS privacy manifest (`expo.ios.privacyManifests`) | **TODO / verify** | No block is declared. Expo SDK packages ship their own `PrivacyInfo.xcprivacy`, and Apple has rejected builds where static CocoaPods manifests were not parsed. Submit once; if App Store Connect emails a required-reason API notice, add the declarations it names ([Expo docs](https://docs.expo.dev/guides/apple-privacy/)) |
| 4.5 | App Store privacy answers entered and matching the policy | **TODO** | Filled-in worksheet: `app-store-privacy-labels.md` §1 |
| 4.6 | Play Data safety form completed and matching the policy | **TODO** | `app-store-privacy-labels.md` §2 |
| 4.7 | Play foreground-service permission declaration (`location` type) | **TODO** | Justification drafted in `permission-strings.md` §6.3 |
| 4.8 | Play precise-location justification | **TODO** | `permission-strings.md` §6.4 |
| 4.9 | Age rating questionnaires, both stores | **OWNER** | Nothing in the content is age-restricted; the activity is adult. A product decision |
| 4.10 | Reviewer notes explaining the offline architecture | **TODO** | Text ready to paste: `app-store-privacy-labels.md` §4. Expect the "you read GPS but declare no collection" question; answer it before it is asked |
| 4.11 | Store listing in Romanian and English | **TODO** | The app's UI is bilingual; the listing should be too |
| 4.12 | Android target API 36 (Android 16) | **TODO** | Required for new apps and updates from **31 Aug 2026** ([Play](https://support.google.com/googleplay/android-developer/answer/11926878)). **An Android build has never been produced for this project** — this is the largest unknown on the list |
| 4.13 | Signing: iOS certificate + provisioning, Android keystore with off-machine backup | **TODO** | Losing the Android keystore means never updating the app again |
| 4.14 | Build-number automation | **TODO** | `CFBundleVersion: 1` with no increment; Apple rejects a repeated build number |
| 4.15 | Bundle identifier decision | **OWNER — irreversible** | `app.circuittimer.tmr` names the first circuit. It cannot be changed after the first publish |

---

## 5. Content and safety review risk

| # | Item | Status | Notes |
|---|---|---|---|
| 5.1 | **App Store Review Guideline 1.4.4** — apps must not encourage reckless behaviour such as excessive speed | **TODO** | This is a motorsport coaching app; it will be read against this guideline. Mitigations: circuit-only framing in the listing, the first screen of the terms, an in-app first-run notice, no public-road use case anywhere in the marketing copy, and the existing rule that suggestions are never shown while driving |
| 5.2 | Listing copy must not imply road use | **TODO / OWNER** | Screenshots taken on a circuit. No "test your car anywhere" phrasing |
| 5.3 | A first-run safety acknowledgement inside the app | **TODO** | Recommended: a one-screen "circuit use only, you are responsible, not an instructor" acknowledgement, with a link to the terms. Cheap, and it is the evidence that the warning was given |
| 5.4 | "Not an official timing system" disclaimer | **DONE** | On the About card and in every exported report |
| 5.5 | Honesty gate keeps coaching suggestions off on unvalidated geometry | **DONE** | `geometryValidated` requires `geometryStatus: 'official'`; both shipped circuits are `community-derived`. Note the product consequence: a first-time user gets timing and analysis but no suggestions |
| 5.6 | Decide whether to ship the Signal Finder / DID Sweep screens publicly | **OWNER** | They talk to the vehicle bus. Read-only, and guarded by a read-only whitelist in the dongle firmware, but they are diagnostic tools in a consumer app |

---

## 6. Licences and dependencies

| # | Item | Status | Notes |
|---|---|---|---|
| 6.1 | Nine packages outside the CI licence allowlist, classified and understood | **DONE** | None is GPL/AGPL. `oss-notices.md` §2.2 |
| 6.2 | Widen the CI policy deliberately, each admission with its written reason | **TODO** | `oss-notices.md` §2.3 |
| 6.3 | Generate `licenses.json` + `THIRD-PARTY-NOTICES.md` repeatably, pinned by a test | **TODO** | `oss-notices.md` §4 |
| 6.4 | In-app notices screen rendering them | **TODO** | `oss-notices.md` §3 |
| 6.5 | Font attribution (OFL-1.1) for Inter, JetBrains Mono, Space Grotesk — **these ship in the binary** | **TODO** | Currently undischarged |
| 6.6 | ODbL attribution | **DONE** | See 3.12 |
| 6.7 | ODbL share-alike position for the generated circuit profiles (derivative database) | **NEEDS A LAWYER** | `oss-notices.md` §5, final paragraph |
| 6.8 | Three workspace packages marked `UNLICENSED` in a **public** repository | **OWNER** | Decide the intended licence, or make the repository private |
| 6.9 | 29 open dependency advisories (1 critical dev-only, 10 high) | **TODO** | The open question — never resolved — is which of them reach the shipped Hermes bundle, since Expo declares `metro`/`vite` as production dependencies. Answer that before triaging |
| 6.10 | Change the prototype dongle's default Wi-Fi password, or stop documenting one | **TODO** | `tracetrace`, WPA2-PSK, on a device attached to a vehicle CAN bus. Irrelevant to store review; relevant to anyone who builds one |

---

## 7. Before the very first submission

| # | Item | Status |
|---|---|---|
| 7.1 | Re-run the standing gate set on the submission commit: `npm run typecheck`, `npm test`, `npm run lint`, and `npx expo export --platform ios` from `apps/mobile` | **TODO** |
| 7.2 | Re-run the no-network source audit and record the result with the build | **TODO** |
| 7.3 | Forensic pass on the built binary: bundle id, ODbL string, the new permission strings (byte-search UTF-16-LE for Romanian text) | **TODO** |
| 7.4 | Confirm the published privacy-policy URL resolves, in both languages, before hitting Submit | **TODO** |
| 7.5 | Confirm the store answers in §4.5/§4.6 still match the shipped policy | **TODO** |
| 7.6 | TestFlight / Play internal testing on phones that are not the developer's | **TODO** |
| 7.7 | The project's own binding rule: gates → cross-review with 0 HIGH → E2E → build → forensics → deliver | **TODO** |

---

## 8. Questions only the owner can answer

Consolidated from every document in `docs/legal/`. Nothing here can be inferred from the code.

**Identity and contact**

1. Who publishes TRACE — you as an individual, a PFA/ÎI, or an SRL? Exact legal name.
2. What registered postal address goes on the DSA trader record (it becomes public on the App Store
   listing)?
3. What phone number and email go on that record?
4. What email should receive privacy and data-subject requests?
5. What support URL and support email will you publish?
6. Where will the privacy policy and terms be hosted (both languages, stable URLs)?

**Commercial model**

7. Free, paid, or in-app purchases/subscription? This changes the terms materially — a paid app
   needs consumer-law content on price, delivery and the 14-day withdrawal right.
8. Which countries will you distribute to? EU-only keeps the analysis to GDPR; adding the US brings
   state privacy laws into scope even for an offline app.
9. Is "TRACE" a name you own or have cleared? It is a common word and a common product name.

**Product decisions with legal consequences**

10. Keep the bundle id `app.circuittimer.tmr`, or change it now? It is irreversible after the first
    publish.
11. What age rating will you declare in each store?
12. Will the Signal Finder and DID Sweep diagnostic screens ship to the public, or stay behind the
    developer-mode gesture?
13. Do you want a first-run safety acknowledgement screen (recommended — it is the record that the
    warning was given)?
14. What licence do the three `UNLICENSED` workspace packages carry, given the repository is public?

**For the lawyer, not for you to decide alone**

15. Which language version of the policy and terms governs on divergence?
16. Is a DPIA required for this processing under Art. 35 and the ANSPDCP list?
17. How far can the liability limitation in §11 of the terms go under Law 193/2000 and Romanian
    civil law?
18. Does publishing the generator scripts and the archived OSM snapshots satisfy the ODbL
    share-alike obligation for the generated circuit profiles, or should those profiles be offered
    under ODbL explicitly?
19. Does the European Accessibility Act (Directive (EU) 2019/882, applicable from 28 June 2025)
    reach a consumer app of this kind, and does the microenterprise exemption apply to your legal
    form?
20. Is a written record of processing activities (Art. 30) required, given the size of the
    undertaking and the nature of the data?

**Timeline**

21. When do you intend to build the planned backend? The privacy policy is structured so it arrives
    as a numbered amendment plus an in-app opt-in; that structure needs to be respected, not
    rewritten, when it happens.

---

## Sources

- [App Review Guidelines — Apple Developer](https://developer.apple.com/app-store/review/guidelines/)
- [Apps without trader status will be removed from the App Store in the EU](https://developer.apple.com/news/?id=einwn76m)
- [App Privacy Details on the App Store](https://developer.apple.com/app-store/app-privacy-details/)
- [Privacy manifests — Expo Documentation](https://docs.expo.dev/guides/apple-privacy/)
- [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Target API level requirements for Google Play apps](https://support.google.com/googleplay/android-developer/answer/11926878)
- [EDPB Guidelines 01/2020 on connected vehicles and mobility related applications, v2.0](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-012020-processing-personal-data-context_en)
- [ANSPDCP — Romanian supervisory authority](https://www.dataprotection.ro/)
