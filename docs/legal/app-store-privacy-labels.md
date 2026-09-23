> **DRAFT — prepared for review by a qualified lawyer licensed in Romania and the EU.**
> This is **not legal advice**. It is a filled-in worksheet for two store questionnaires, based on a
> reading of the TRACE source tree on **23 September 2026**. Verify each row against the shipping
> build before you submit; a label that does not match the app is a rejection, and a label that does
> not match `privacy-policy.en.md` is a worse one.
> Document version: **1.0-draft**.

# App Store privacy labels and Google Play Data Safety — the answers to give

## 0. The one decision this whole document rests on

Both stores define "collection" as **data leaving the device**, not data being recorded on it.

- **Apple:** *"'Collect' refers to transmitting data off the device in a way that allows you and/or
  your third-party partners to access it for a period longer than necessary to service the
  transmitted request in real time."* Data processed only on-device and never sent to a server does
  not have to be disclosed.
  ([App Privacy Details on the App Store](https://developer.apple.com/app-store/app-privacy-details/))
- **Google:** the Data safety form covers data your app **collects** (transmits off the device) or
  **shares** (transfers to a third party). Data that stays on the device and is never transmitted is
  outside the form.
  ([Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469))

**TRACE transmits nothing.** There is no networking code in the application at all: a source audit
of `apps/mobile/src` and `packages/core/src` found zero occurrences of `fetch`, `XMLHttpRequest`,
`axios`, `WebSocket` or `expo-updates`. There is no account, no analytics SDK, no ad SDK and no
crash reporter. The only egress is the user tapping a share button, which hands a file to the OS
share sheet — a **user-initiated transfer to a destination the user picks**, not developer
collection.

**Therefore the correct answer on both forms is: no data collected, no data shared, no tracking.**

That answer is correct, but it looks surprising next to a privacy policy that lists GPS traces, a
VIN and brake pressure. §4 below gives the reviewer-notes wording that reconciles the two. §5 gives
the conservative alternative if the owner decides not to rely on the on-device carve-out.

---

## 1. Apple — App Store Connect → App Privacy

Apple asks, per data type: **is it collected?** If yes: **is it linked to the user's identity?**,
**is it used for tracking?**, and **for what purposes?** (Third-Party Advertising; Developer's
Advertising or Marketing; Analytics; Product Personalization; App Functionality; Other Purposes.)

### 1.1 The declaration

**Top-level answer: "Data Not Collected."**

Every data type below is therefore answered **No**. The table records, for each one, what the app
actually does with it — so that if a reviewer asks, the answer is already written down.

| Apple data type | Collected? | Linked to identity | Used for tracking | Purpose | What the app actually does |
|---|---|---|---|---|---|
| Contact Info → Name / Email / Phone / Address / Other | **No** | — | — | — | Never requested. No account exists |
| Health & Fitness → Health / Fitness | **No** | — | — | — | Not used |
| Financial Info → Payment / Credit / Other | **No** | — | — | — | No purchases in this version |
| **Location → Precise Location** | **No** | — | — | — | **Recorded continuously during a session** (lat/lon/accuracy/speed/heading/altitude) and written to on-device SQLite. Foreground only. Never transmitted. Precise accuracy is required; reduced accuracy fails the pre-session check |
| Location → Coarse Location | **No** | — | — | — | `ACCESS_COARSE_LOCATION` is declared on Android only because the fine-location grant implies it; no coarse-only path exists |
| Sensitive Info | **No** | — | — | — | None of Apple's sensitive categories (racial/ethnic, sexual orientation, pregnancy, disability, religious/political, biometric, genetic) is touched |
| Contacts | **No** | — | — | — | Permission never requested |
| User Content → Emails/Texts, Photos/Videos, Audio, Gameplay, Customer Support, Other | **No** | — | — | — | The session data the user records is their own content but is never transmitted; text-to-speech is synthesis, not recording; **no microphone, camera or photo-library permission is requested anywhere** |
| Browsing History / Search History | **No** | — | — | — | No browser, no search |
| **Identifiers → User ID** | **No** | — | — | — | A single fixed local identifier tags rows in the app's own database. It is not an account, is not device-unique in any meaningful sense, and never leaves the device |
| Identifiers → Device ID | **No** | — | — | — | No IDFA, no IDFV, no advertising identifier, no `AppTrackingTransparency` prompt (none is needed — the app does not track) |
| Purchases → Purchase History | **No** | — | — | — | None in this version |
| Usage Data → Product Interaction | **No** | — | — | — | Settings and the driver's own lap verdicts are stored locally; no interaction telemetry is produced or sent |
| Usage Data → Advertising Data | **No** | — | — | — | No advertising |
| Usage Data → Other Usage Data | **No** | — | — | — | — |
| Diagnostics → Crash Data | **No** | — | — | — | No crash reporting SDK of any kind |
| Diagnostics → Performance Data | **No** | — | — | — | GNSS signal-quality statistics are computed in memory over the last 300 samples and never written to disk |
| Diagnostics → Other Diagnostic Data | **No** | — | — | — | OBD sweep records stay in local SQLite |
| Surroundings → Environment Scanning | **No** | — | — | — | No ARKit, no LiDAR |
| Body → Hands / Head | **No** | — | — | — | Not applicable |
| **Other Data → Other Data Types** | **No** | — | — | — | This is where **vehicle data (RPM, throttle, brake pressure and switch, temperatures), the VIN, and accelerometer/gyroscope readings** would sit if they were transmitted. They are not |

### 1.2 Tracking

**"Does this app use data for tracking purposes?" → No.**

Apple's definition of tracking is linking data from this app with **third-party data** for targeted
advertising or ad measurement, or sharing it with a data broker. TRACE does none of this, has no
third-party data to link to, and contains no ad or attribution SDK. It therefore does **not** need
to present an App Tracking Transparency prompt.

### 1.3 The rest of the App Privacy section

| Field | Answer |
|---|---|
| Privacy Policy URL (required) | `[OWNER: public URL where privacy-policy.en.md is hosted, with the Romanian version reachable from it]` |
| Privacy Choices URL | Not applicable — no account, nothing to opt out of server-side |
| App Store localisations | Provide the listing in **English and Romanian**; the privacy policy must be reachable in both |

### 1.4 Other App Store Connect answers that are commonly forgotten

| Question | Answer for TRACE | Note |
|---|---|---|
| Export compliance — `ITSAppUsesNonExemptEncryption` | `false` | The app uses no encryption of its own. Declare it **in `app.json` under `expo.ios.infoPlist`** so it is answered at build time rather than by hand on every upload. It is **absent today** |
| EU Digital Services Act trader status | **Required.** The developer is in Romania and distributing in the EU | Apple removes EU apps without a verified trader status; name, address, phone and email are displayed publicly on the listing. See [Apple's notice](https://developer.apple.com/news/?id=einwn76m) and [the App Store Connect help page](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/) |
| Content rights | No third-party content beyond open-source components and OpenStreetMap data, both attributed |
| Age rating | `[OWNER: decide. Nothing in the app is age-restricted content, but the activity it supports is adult. A 17+/18+ rating is a product decision, not a compliance one]` |
| Privacy manifest (`PrivacyInfo.xcprivacy`) | Expo SDK packages ship their own. The app declares **no** `expo.ios.privacyManifests` block. Required-reason API declarations may still be demanded for the app target | See `compliance-checklist.md` item 4.4 |

---

## 2. Google Play — Play Console → App content → Data safety

Google asks, per data type: **collected?**, **shared?**, **processed ephemerally?**, **required or
optional?**, and **purposes** (App functionality; Analytics; Developer communications; Advertising
or marketing; Fraud prevention, security, and compliance; Personalization; Account management).

### 2.1 The declaration

**Top-level answer: "No data collected" and "No data shared."**

| Play category | Data types | Collected | Shared | Purpose | What the app actually does |
|---|---|---|---|---|---|
| **Location** | Approximate location | **No** | **No** | — | Not used as a distinct path |
| | **Precise location** | **No** | **No** | — | **Recorded during a session, stored on-device, never transmitted.** `ACCESS_FINE_LOCATION` + `FOREGROUND_SERVICE_LOCATION`; `ACCESS_BACKGROUND_LOCATION` is **not** requested |
| **Personal info** | Name, Email, User IDs, Address, Phone, Race/ethnicity, Political or religious beliefs, Sexual orientation, Other info | **No** | **No** | — | None requested. The **VIN** would fall under "Other info" if it were transmitted; it is not |
| **Financial info** | Payment info, Purchase history, Credit score, Other | **No** | **No** | — | None in this version |
| **Health and fitness** | Health info, Fitness info | **No** | **No** | — | Not used |
| **Messages** | Emails, SMS/MMS, Other in-app messages | **No** | **No** | — | Not used |
| **Photos and videos** | Photos, Videos | **No** | **No** | — | No permission requested |
| **Audio files** | Voice or sound recordings, Music, Other audio | **No** | **No** | — | **No microphone permission.** Voice cues are text-to-speech output |
| **Files and docs** | Files and docs | **No** | **No** | — | Export files are written to the app's own cache and handed to the system share sheet at the user's request |
| **Calendar** | Calendar events | **No** | **No** | — | Not used |
| **Contacts** | Contacts | **No** | **No** | — | Not used |
| **App activity** | App interactions, In-app search history, Installed apps, Other user-generated content, Other actions | **No** | **No** | — | Lap times, settings and the driver's own verdicts are on-device only |
| **Web browsing** | Web browsing history | **No** | **No** | — | No browser |
| **App info and performance** | Crash logs, Diagnostics, Other app performance data | **No** | **No** | — | No crash reporting, no remote diagnostics. Sensor and OBD diagnostics stay in local SQLite |
| **Device or other IDs** | Device or other IDs | **No** | **No** | — | No advertising ID, no device ID read or transmitted |

### 2.2 Security section

| Question | Answer |
|---|---|
| Is all of the data collected/shared encrypted in transit? | **Not applicable** — no data is collected or shared, so nothing is in transit. (If the form forces an answer, the honest note is that the only network activity is a plain TCP link to a local Wi-Fi OBD adapter on the user's own network, carrying vehicle telemetry only) |
| Do you provide a way for users to request that their data be deleted? | **Yes** — in-app: **Settings → DATA → "Delete all my data"**. This question is normally only shown when collection is declared; answer it as Yes if it appears |
| Independent security review badge | No |
| Committed to Play Families Policy | No — the app is not directed at children |

### 2.3 Other Play Console declarations that are easy to miss

| Item | Status for TRACE |
|---|---|
| **Privacy policy URL** in the store listing | **Mandatory for every app on Play, regardless of what the Data safety form says.** `[OWNER: hosting URL]` |
| **Foreground service permission declaration** (App content → Foreground service permissions) | **Required.** The app declares `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_LOCATION` and must justify the `location` type: the session must keep recording while the screen is on and the app is in front during a lap |
| **Sensitive permissions / precise location justification** | Be ready to state the core use case: lap and sector timing cannot be done at coarse resolution |
| Ads declaration | **No ads** |
| Target API level | New apps and updates must target **API 36 (Android 16)** from **31 August 2026** ([Play target API policy](https://support.google.com/googleplay/android-developer/answer/11926878)). An Android build has never been produced for this app — verify the Expo SDK 57 target |
| Account deletion requirement | **Not applicable** — the app creates no account |
| Data deletion URL | Not applicable for the same reason; the in-app control is the mechanism |

---

## 3. Cross-check: the labels against the privacy policy

Run this before every submission. The two documents must agree **on facts**, even where the store
answer is "no" because of the transmission definition.

| Fact | Privacy policy says | Label says | Consistent? |
|---|---|---|---|
| Precise location recorded during a session | Yes, §3.1 | Not *collected* (never transmitted) | Yes — different question |
| Location recorded in the background | No | No background location declared | Yes |
| VIN read and stored | Yes, §3.3 | Not *collected* | Yes |
| OBD vehicle data recorded | Yes, §3.2, optional | Not *collected* | Yes |
| Accelerometer/gyroscope recorded | Yes, §3.4 | Not *collected* | Yes |
| Any analytics, ads, crash reporting, third-party SDK collection | No | No | Yes |
| Tracking / advertising identifiers | No | No | Yes |
| User-initiated export via share sheet | Yes, §5 | Not developer collection | Yes |
| In-app deletion exists | Yes, §7, with the stated gaps | Play: "Yes, users can request deletion" | Yes |
| Data retained until the user deletes it | Yes, §6 | No retention question on either form | Yes |

**If the planned backend ever ships, every "No" in §1 and §2 that touches transmitted data becomes a
"Yes" and both forms must be re-submitted in the same release as the privacy-policy amendment.**
Design the amendment and the label change as one change.

---

## 4. Reviewer notes — wording to paste into the submission

Use this in App Store Connect's "Notes for Review" and in any Play policy correspondence. It heads
off the obvious question.

> TRACE is an offline lap timer for closed racetracks. The app records precise GNSS position,
> optional OBD-II vehicle data and device motion while a session is running, and stores all of it in
> a private SQLite database inside the app's own sandbox on the device.
>
> The app contains no networking code: there is no account, no server, no analytics, no advertising
> and no crash reporting, and no data is transmitted off the device at any time. The only egress is
> a user-initiated export, where the user taps a share button and chooses a destination in the
> system share sheet.
>
> Because Apple's and Google's privacy questionnaires define collection as transmitting data off the
> device, the App Privacy answer is "Data Not Collected" and the Data safety answer is "No data
> collected or shared". The privacy policy nonetheless describes everything the app records, in
> full, because EU law requires that transparency regardless of where the data sits.
>
> Location is foreground-only. The app never requests Always/background location authorisation.
> Precise location is functionally required: lap and sector timing is performed by detecting when
> the vehicle's position crosses a start/finish or sector line, which is impossible at reduced
> accuracy — the app treats reduced accuracy as a hard pre-session failure and explains how to turn
> Precise Location on.
>
> The app is for closed-circuit use only and says so prominently. It is advisory and is not an
> official or certified timing system.

`[OWNER: if the app ships the Signal Finder / DID Sweep diagnostic screens to the public, add a
sentence here stating that they issue read-only OBD-II requests only — no write, actuation or
clear-DTC service is ever sent.]`

---

## 5. The conservative alternative, if the owner prefers to declare

Some developers declare on-device-only data anyway, on the view that a "Data Not Collected" label on
an app that visibly reads your GPS invites questions. It is permitted to over-declare; it is not
permitted to under-declare. If the owner chooses this route, the answers change to:

| | Apple | Google |
|---|---|---|
| Precise Location | Collected · **Not** Linked to You · Not used for tracking · Purpose: **App Functionality** | Collected · Not shared · Required · Purpose: **App functionality** |
| Other Data (vehicle data, VIN) | Collected · **Linked to You** (a VIN identifies a vehicle) · Not used for tracking · Purpose: **App Functionality** | Personal info → Other info: Collected · Not shared · **Optional** · Purpose: App functionality |
| Usage Data → Product Interaction | Collected · Not Linked to You · Not used for tracking · App Functionality | App activity → App interactions: Collected · Not shared · Required · App functionality |
| Everything else | Unchanged (No) | Unchanged (No) |

**Recommendation: declare "not collected", and paste the §4 reviewer note.** It is the accurate
answer under both definitions, and the reviewer note removes the surprise. Over-declaring has a real
cost: it puts "Data Linked to You" on the store card of an app that has no server, and it makes the
label wrong in the other direction.

---

## Sources

- [App Privacy Details on the App Store — Apple Developer](https://developer.apple.com/app-store/app-privacy-details/)
- [Apps without trader status will be removed from the App Store in the EU — Apple Developer](https://developer.apple.com/news/?id=einwn76m)
- [Manage European Union Digital Services Act trader requirements — App Store Connect Help](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/)
- [Provide information for Google Play's Data safety section — Play Console Help](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Target API level requirements for Google Play apps — Play Console Help](https://support.google.com/googleplay/android-developer/answer/11926878)
