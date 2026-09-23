> **DRAFT — prepared for review by a qualified lawyer licensed in Romania and the EU.**
> This is **not legal advice**. The strings below are product copy with a compliance function; they
> were written against the TRACE source tree as it stood on **23 September 2026**.
> Document version: **1.0-draft**.

# Permission strings — iOS usage descriptions and Android equivalents

## 1. Why these sentences matter more than their length suggests

Apple rejects generic purpose strings under **App Store Review Guideline 5.1.1(i)**: the string must
say *what* the app does with the data and *why the user benefits*, specifically enough that the
person reading a modal at 9 p.m. understands the trade. "Allow this app to access your device
motion" says nothing and is a known rejection.

Two of TRACE's three strings are already good. One is Expo's default and must be replaced. The
Romanian translations below matter because the app ships a Romanian UI: a system prompt in English
inside an otherwise Romanian app is both a review risk and simply worse.

---

## 2. iOS — current state

From `apps/mobile/app.json`, `expo.ios.infoPlist`:

| Key | Present | Assessment |
|---|---|---|
| `NSLocationWhenInUseUsageDescription` | Yes | **Good.** States what, when, and that there is no background use |
| `NSLocationTemporaryUsageDescriptionDictionary.TrackSession` | Yes | **Good.** Explains why approximate location is not enough |
| `NSLocalNetworkUsageDescription` | Yes | **Good.** States the purpose, that it is read-only, and that it is not used for timing |
| `NSMotionUsageDescription` | **Absent from `app.json`** | **Must be fixed.** Because the key is not declared, the `expo-sensors` config plugin supplies its default, *"Allow $(PRODUCT_NAME) to access your device motion"* — exactly the generic phrasing 5.1.1(i) targets |
| `ITSAppUsesNonExemptEncryption` | Absent | Not a permission string, but it belongs in the same `infoPlist` block. See `compliance-checklist.md` |

The app requests **no** microphone, camera, photo-library, contacts, calendar, Bluetooth, tracking
or background-location permission. Do not add usage-description keys for permissions the app does
not request — an unused key with a plausible string invites a reviewer to ask which feature uses it.

---

## 3. The replacement for `NSMotionUsageDescription`

Written in the same voice as the two good strings: concrete about what is read, concrete about what
it is for, and honest about the boundary.

**English (to ship in `infoPlist`):**

> TRACE reads your phone's accelerometer and gyroscope during a track session to measure cornering
> and braking forces and to tell a real corner apart from GPS noise. Motion data is recorded only
> while a session is running and never leaves your device.

*(232 characters. Apple imposes no hard limit, but iOS truncates long strings in the alert on small
devices; this fits.)*

**Romanian (for the localised `InfoPlist.strings`):**

> TRACE citește accelerometrul și giroscopul telefonului în timpul unei sesiuni pe circuit, ca să
> măsoare forțele din viraj și din frânare și ca să deosebească un viraj real de zgomotul GPS. Datele
> de mișcare se înregistrează doar cât timp sesiunea rulează și nu părăsesc niciodată dispozitivul.

**Where it goes.** Add the key to `apps/mobile/app.json` under `expo.ios.infoPlist`, alongside the
three existing strings, so `expo prebuild` writes it and the `expo-sensors` default never applies:

```jsonc
"NSMotionUsageDescription": "TRACE reads your phone's accelerometer and gyroscope during a track session to measure cornering and braking forces and to tell a real corner apart from GPS noise. Motion data is recorded only while a session is running and never leaves your device."
```

**Verify after prebuild**, the same way builds are already verified: unzip the `.ipa`, read
`Payload/TRACE.app/Info.plist`, and confirm the string is the one above and not the Expo default.
A config-plugin ordering mistake is silent otherwise.

---

## 4. The full iOS set, both languages

Keep the English strings in `app.json` and add a Romanian `InfoPlist.strings` for the `ro`
localisation. iOS then shows the Romanian text to a device set to Romanian, matching the app's own
language default (`ro` primary subtag → Romanian UI).

### 4.1 `NSLocationWhenInUseUsageDescription`

**EN (current — keep as is):**
> TRACE records your position on track during an active session to time your laps and sectors.
> Location is only used while a session is running and never in the background.

**RO:**
> TRACE îți înregistrează poziția pe circuit în timpul unei sesiuni active, ca să cronometreze turele
> și sectoarele. Locația este folosită doar cât timp sesiunea rulează și niciodată în fundal.

### 4.2 `NSLocationTemporaryUsageDescriptionDictionary` → key `TrackSession`

**EN (current — keep as is):**
> TRACE needs precise location during this track session to time your laps and sectors accurately;
> approximate location isn't accurate enough for lap timing.

**RO:**
> TRACE are nevoie de locație precisă în timpul acestei sesiuni pe circuit ca să cronometreze exact
> turele și sectoarele; locația aproximativă nu este suficient de precisă pentru cronometraj.

### 4.3 `NSLocalNetworkUsageDescription`

**EN (current — keep as is):**
> TRACE can optionally connect to a WiFi OBD-II adapter on your local network to show advisory
> vehicle telemetry (RPM, speed, throttle, coolant temperature). This is read-only and never used
> for lap timing.

**RO:**
> TRACE se poate conecta opțional la un adaptor OBD-II pe Wi-Fi din rețeaua ta locală, ca să afișeze
> telemetrie orientativă a vehiculului (turație, viteză, accelerație, temperatura lichidului de
> răcire). Conexiunea este doar de citire și nu este folosită niciodată pentru cronometraj.

*(Note for the owner: the string names four channels but the app reads more than that — brake
pressure and switch, pedal position, oil and intake temperatures, engine load. "(RPM, speed,
throttle, coolant temperature)" is accurate but incomplete. Consider "…vehicle telemetry such as
RPM, speed, pedal and brake inputs, and temperatures." It is a truthfulness improvement, not a
blocker.)*

### 4.4 `NSMotionUsageDescription`

As drafted in §3.

---

## 5. In-app rationale copy — a name bug to fix first

The app shows its own explanation before triggering the OS prompt, which is the right pattern.
Both strings in `apps/mobile/src/platform/permissions.ts` still call the app **"Circuit Timer"**:

> `LOCATION_PERMISSION_RATIONALE` — "Circuit Timer needs your location while the app is open…"
> `PRECISE_LOCATION_INSTRUCTIONS` — "Turn on Precise Location for Circuit Timer: Settings > Privacy
> & Security > Location Services > Circuit Timer > Precise Location."

The app is called **TRACE** and that is the name iOS Settings displays. The second string therefore
sends the user to look for an entry that does not exist. Fix both, and translate:

**EN rationale:**
> TRACE needs your location while the app is open, to time your laps and sectors on track. Location
> is only used during an active session and never in the background.

**RO rationale:**
> TRACE are nevoie de locația ta cât timp aplicația este deschisă, ca să îți cronometreze turele și
> sectoarele pe circuit. Locația este folosită doar în timpul unei sesiuni active și niciodată în
> fundal.

**EN precise-location instructions:**
> Turn on Precise Location for TRACE: Settings > Privacy & Security > Location Services > TRACE >
> Precise Location.

**RO precise-location instructions:**
> Activează Locația Precisă pentru TRACE: Setări > Confidențialitate și securitate > Servicii de
> localizare > TRACE > Locație precisă.

---

## 6. Android

Android has no per-permission purpose string in the manifest. The equivalent obligations are:
(a) the manifest permission set, (b) an in-app rationale shown before the request, (c) the
foreground-service type, and (d) the Play Console declarations.

### 6.1 Declared today

`apps/mobile/app.json`, `expo.android.permissions`:

```
ACCESS_FINE_LOCATION
ACCESS_COARSE_LOCATION
FOREGROUND_SERVICE
FOREGROUND_SERVICE_LOCATION
```

Assessment:

- **Correct, and notably restrained.** `ACCESS_BACKGROUND_LOCATION` is deliberately not requested —
  the location plugin is configured `isAndroidBackgroundLocationEnabled: false`,
  `locationAlwaysPermission: false`. That avoids Play's background-location review entirely. Keep
  it that way.
- `ACCESS_COARSE_LOCATION` is required alongside `ACCESS_FINE_LOCATION` on Android 12+ (the system
  shows the precise/approximate choice and denies fine-only requests). Keep it, and be ready to
  explain in the Play form that approximate is not sufficient for the app's core function.
- **`HIGH_SAMPLING_RATE_SENSORS` is not needed** unless motion sampling exceeds 200 Hz. The app's
  accelerometer/gyroscope interval is far below that. Do not add it.
- `INTERNET` is added automatically by the React Native manifest merge and is what the local OBD TCP
  socket uses. It cannot be removed and needs no declaration, but expect it to appear in the app's
  permission list on the store page — the privacy policy already explains that the only network
  activity is to a local adapter.

### 6.2 In-app rationale (Android)

Use the same §5 copy. Android's own guidance is to show the rationale **before** calling the
permission API when the user has previously denied it, which the existing flow does.

### 6.3 Foreground service

The `location` foreground-service type must be declared in the manifest **and** justified in Play
Console → App content → *Foreground service permissions*. Suggested justification:

> TRACE times laps on a racetrack. While a session is running the app must continue receiving
> position updates at a high rate for the whole session, including while the screen stays on in a
> phone mount, so that a lap crossing is never missed. The service runs only during an explicitly
> started session, is stopped when the session ends, and the app does not request background
> location.

### 6.4 Play Console store-listing note on precise location

> Precise location is the app's core function: lap and sector times are produced by detecting when
> the vehicle crosses a start/finish or sector line, which approximate location cannot resolve. The
> data is stored only on the device and is never transmitted.

---

## 7. Checklist for whoever applies this

- [ ] Add `NSMotionUsageDescription` (§3) to `app.json`.
- [ ] Add `ITSAppUsesNonExemptEncryption: false` to the same `infoPlist` block.
- [ ] Add a Romanian `InfoPlist.strings` with the four §4 translations.
- [ ] Fix the two "Circuit Timer" strings in `permissions.ts` and localise them (§5).
- [ ] Consider widening the local-network string's channel list (§4.3 note).
- [ ] Re-run `npx expo export --platform ios` and the usual gates; then verify the built
      `Info.plist` contains the new motion string, not the Expo default.
- [ ] Write the Play Console foreground-service and precise-location justifications from §6.

---

## Sources

- [App Review Guidelines §5.1.1 — Apple Developer](https://developer.apple.com/app-store/review/guidelines/)
- [Privacy manifests — Expo Documentation](https://docs.expo.dev/guides/apple-privacy/)
- [Provide information for Google Play's Data safety section — Play Console Help](https://support.google.com/googleplay/android-developer/answer/10787469)
