> **DRAFT — NOT YET IN FORCE.**
> This document was prepared for review by a qualified lawyer licensed in Romania and the European
> Union. It is **not legal advice** and must not be published, linked from an app store listing, or
> relied on by users until that review is complete.
> Drafted: **23 September 2026**. Document version: **1.0-draft**.
> Placeholders written as `[OWNER: …]` are facts only the app's owner can supply; every one of them
> is also listed in `docs/legal/compliance-checklist.md` §8.

# TRACE — Privacy Policy

**Applies to:** the TRACE mobile application for iOS and Android (bundle identifier
`app.circuittimer.tmr`), version 1.0.0 and later, until replaced by a newer version of this policy.

**Last updated:** 23 September 2026
**Effective from:** `[OWNER: date of first public release]`

---

## 1. In one paragraph

TRACE is a lap timer and driving-analysis app for **closed racetracks**. It records where your car
is, how fast it is going, and — if you connect an OBD-II adapter — what your car's own sensors
report, so it can time your laps and tell you what happened on each corner. **All of it stays on
your phone.** TRACE contains no network code at all: there is no account, no server, no cloud
backup, no analytics, no advertising and no crash reporting. The only way data leaves your phone is
if you tap a share button yourself and choose where to send it. You can delete everything from
inside the app.

---

## 2. Who is responsible for your data (the controller)

| | |
|---|---|
| Controller | `[OWNER: full legal name — individual, PFA/ÎI, or SRL]` |
| Registered address | `[OWNER: full postal address in Romania]` |
| Contact for privacy matters | `[OWNER: email address, e.g. privacy@…]` |
| Data Protection Officer | Not appointed. TRACE does not carry out large-scale monitoring on a controller's behalf; the processing described here happens entirely on the user's own device. `[OWNER/LAWYER: confirm no DPO is required under GDPR Art. 37]` |
| EU representative | Not required — the controller is established in Romania, inside the EU. |

The General Data Protection Regulation (Regulation (EU) 2016/679, "GDPR") applies to this app.

**A note on what "controller" means here.** For almost everything TRACE records, we never receive
the data at all — it is written to a private database inside the app's own sandbox on your phone and
we have no access to it. We are nonetheless treating ourselves as the controller for this processing,
because we decide what the app records and why. Where that distinction changes your rights in
practice, this policy says so explicitly (see §7).

---

## 3. What TRACE records, why, and on what legal basis

Everything in this table is stored **only** in a private SQLite database inside the app on your
device, and in files the app writes into its own cache folder when you export something.

### 3.1 Location data

| | |
|---|---|
| What | Latitude, longitude, horizontal accuracy, speed, heading and altitude, sampled continuously while a session is running |
| Why | This is the entire product. Lap and sector times are produced by detecting when your position crosses a start/finish or sector line; the analysis of each corner is computed from the same trace |
| When | Only while a session is active (calibration lap and timed laps), and only while the app is in the foreground |
| Where stored | `telemetry` table, per lap, plus a "raw trace" of everything captured even when no lap was detected |
| Legal basis | **Consent** (GDPR Art. 6(1)(a)), given by granting the operating system's location permission and starting a session. The app cannot start a session without it |
| Sent anywhere | **No** |

**Precise location is mandatory for this app to work.** iOS's "reduced accuracy" mode gives a
position circle roughly 1.9 km wide, which cannot time a lap. TRACE treats reduced accuracy as a
hard failure at the pre-session check and tells you how to turn Precise Location on, rather than
silently producing wrong times.

**Background location is never requested.** The app never asks for "Always" permission on iOS and
never declares `ACCESS_BACKGROUND_LOCATION` on Android. If you leave the app, recording stops.

**Under EU law, a position trace is personal data even though your name is nowhere in it.** A
sequence of precise positions and times says where a person was, and the European Data Protection
Board's *Guidelines 01/2020 on processing personal data in the context of connected vehicles and
mobility related applications* (version 2.0, adopted 9 March 2021) treats location data as requiring
particular care for exactly this reason. We treat your trace accordingly.

### 3.2 Vehicle data from the OBD-II port (optional)

| | |
|---|---|
| What | Engine RPM, vehicle speed, throttle plate position, accelerator pedal position, coolant temperature, intake air temperature, calculated engine load, engine oil temperature, transmission oil temperature (if you configure a custom PID for it), brake-pedal switch state and brake pressure |
| Why | So the analysis can say *where* you braked and *how hard*, and where you got back on the throttle — which is what turns a lap time into a usable observation |
| When | Only if you turn the "Telemetry" setting on **and** connect an adapter. It is off by default |
| Where stored | `telemetry_samples` table (one row per sample: session, lap, timestamp, channel, value) |
| Legal basis | **Consent** (Art. 6(1)(a)), given by enabling the setting and connecting the adapter |
| Sent anywhere | **No.** The connection is to an adapter on your own local Wi-Fi, not to the internet |

**TRACE only reads from the vehicle bus.** The app sends standard read-only OBD-II requests
(service 01) and the two read-only diagnostic services 0x21/0x22 used for manufacturer-specific
readings. It never sends a command that writes to, actuates, or clears anything in the car.

### 3.3 The vehicle identification number (VIN)

| | |
|---|---|
| What | Your car's 17-character VIN, read once per app run from the engine control unit (ISO 14229-1 data identifier `0xF190`) when a BMW-ENET-type adapter is connected |
| Why | To recognise which car you are in and select the right vehicle profile automatically, so you do not have to identify your car by hand every session |
| When | Only on the ENET adapter path, only when telemetry is enabled, and at most once per app launch |
| Where stored | `settings` table, key `lastSeenVin` |
| Legal basis | **Consent** (Art. 6(1)(a)) |
| Sent anywhere | **No** |

**A VIN is personal data.** It identifies a specific vehicle, and through registration records a
specific keeper — the EDPB's connected-vehicles guidelines say so directly. TRACE handles it as
such:

- It is **never written into an exported analysis, session report or raw session export.** We
  checked; it is not in those documents.
- Where the app writes the VIN to a developer log, it is **masked** — first three and last two
  characters only, e.g. `WBA************12`.
- It is shown in full on the Signal Finder screen, which is where you would need to read it.

- "Delete all my data" (§7) removes the stored VIN, and with it a vehicle profile the app selected
  from the VIN. The app tries to read the VIN again the next time a BMW-ENET-type adapter is
  connected and not busy with another task.

### 3.4 Device motion sensors

| | |
|---|---|
| What | Accelerometer readings (converted to lateral and longitudinal g) and gyroscope readings (converted to yaw rate) |
| Why | To measure cornering and braking forces, and to tell a real corner from GPS noise. Gyroscope readings are used only if you turn that setting on |
| When | While a session is running |
| Where stored | Same `telemetry_samples` table, as channels `latG`, `longG`, `yawRateDps` |
| Legal basis | **Consent** (Art. 6(1)(a)) |
| Sent anywhere | **No** |

### 3.5 Timing, laps and your own judgements

| | |
|---|---|
| What | Session start time, lap numbers, lap and sector times, validity flags and the reason a lap was marked invalid, calibration attempts, your personal-best reference lap, and the verdicts **you** record when you agree or disagree with the app's judgement of a lap |
| Why | To show your history, to compare against your best lap, and — for your verdicts — so the app can be corrected by the person who was actually driving |
| Where stored | `sessions`, `laps`, `checkpoints`, `reference_laps`, `lap_verdicts`, `calibration_attempts` tables |
| Legal basis | **Consent** (Art. 6(1)(a)) |
| Sent anywhere | **No** |

### 3.6 App settings and diagnostic tooling

| | |
|---|---|
| What | Units, display preferences, language, adapter host and port, which vehicle profile is active, confirmed per-vehicle signal bindings, and — if you use the built-in diagnostic tools — records of OBD "sweep" runs including raw hexadecimal responses from your car's control units |
| Why | To remember how you configured the app, and to let the app find the right brake/throttle signal on your specific car |
| Where stored | `settings`, `vehicle_profile_bindings`, `signal_finder_ruled_out`, `did_sweep_*` tables |
| Legal basis | **Consent** (Art. 6(1)(a)) |
| Sent anywhere | **No** |

> **A caution about the diagnostic tools.** The Signal Finder and DID Sweep screens record raw
> responses from your car's control units. If you sweep a range that happens to include the VIN
> data identifier, the raw hexadecimal in that record — and in any export of it you choose to share
> — may contain your VIN. Check a sweep export before sending it to anyone.

### 3.7 GNSS diagnostics

The app keeps a rolling in-memory window of the last 300 position samples to compute signal-quality
statistics (sample intervals, accuracy percentiles, count of rejected mock locations on Android).
**This is never written to disk and never leaves the device**; it exists only for the lifetime of
the running process.

---

## 4. What TRACE does *not* do

- **No account.** There is no sign-up, no login, no email address, no password. The app uses a
  single fixed local identifier internally to tag rows in its own database.
- **No servers.** As of this version, TRACE contains no networking code whatsoever. An audit of the
  source found zero uses of `fetch`, `XMLHttpRequest`, `axios`, `WebSocket` or over-the-air updates
  anywhere in the application or its domain package. The circuit maps are compiled into the app
  itself, not downloaded.
- **No analytics, no advertising, no tracking.** There is no analytics SDK, no advertising SDK, no
  crash-reporting service, and no third-party library in the app that collects data. TRACE does not
  track you across other companies' apps or websites, does not use advertising identifiers, and
  does not share anything with data brokers.
- **No selling or sharing of personal data.** There is nothing to sell; we never receive it.
- **No profiling and no automated decisions with legal effect.** The app's coaching analysis is an
  automated evaluation of your driving, but it produces advice you are free to ignore. It has no
  legal or similarly significant effect within the meaning of GDPR Art. 22.
- **No children's data collected knowingly.** TRACE is intended for licensed drivers taking part in
  circuit activities and is not directed at children. `[OWNER: confirm the age rating you will
  declare in both stores.]`

---

## 5. When data leaves your phone — and only then

TRACE has export buttons. They are the only route out, and you press them.

| Export | Where it is | What it contains |
|---|---|---|
| **Share report** (session results, session history) | End of a session, and each row of session history | The session report as JSON, plus a one-page human-readable Markdown summary: lap and sector times, validity and its reasons, circuit provenance, calibration state |
| **Share report / Share the JSON file** (analysis screen) | Analysis screen | The per-corner analysis document, in Romanian or English according to your language setting |
| **Raw session export** | Session history | Everything on disk for that session with no interpretation: the full GNSS trace of every lap, the unclaimed trace of a session where no lap was detected, and every OBD/motion sample recorded |
| **Signal Finder export**, **DID Sweep export** | The respective diagnostic screens | The guided-observation or sweep record, including raw responses from your car |

When you tap one of these, the app writes the file into its own cache folder (files are named like
`trace-report-<circuit>-<date>-<session>.json`) and hands it to your operating system's standard
share sheet. **From that point on, where the file goes is your choice and is governed by whatever
service you send it to** — a messaging app, email, cloud storage. We receive nothing.

Exported reports and analyses **do not contain your VIN**. A raw session export contains your full
position trace, which is precise location data — treat it as you would a photograph of where you
were.

---

## 6. How long the data is kept

**Until you delete it.** There is no automatic expiry, no retention timer and no background clean-up
of sessions in this version. A session recorded today is still on your phone in five years unless
you remove it, or uninstall the app.

Two technical limits apply, and neither is a retention policy:

- At most **200,000 vehicle/motion telemetry rows per session** are stored; recording of that
  channel stops for the session once the cap is reached.
- The diagnostic **DID sweep store keeps the five most recent runs** and drops older ones.

Because nothing is transmitted, there is no server-side copy with its own retention period.
Uninstalling TRACE removes its private database along with it, in the normal way your operating
system removes an app's data.

**If you have exported files**, those files are yours and have their own life: this policy cannot
reach them. Delete them from wherever you sent them.

---

## 7. Your rights, and exactly how to use each one in this app

Under GDPR Articles 15–22 you have the rights listed below. Because your data is on your own device
and we hold no copy, most of these are things you exercise **directly in the app** — that is faster
and more complete than asking us, because we would have nothing to send you.

### Right of access (Art. 15) — "give me a copy of my data"

**In the app:** Session history → the session you want → **Share report** for the readable version,
or **raw session export** for everything on disk without interpretation. The analysis screen's
**Share report / Share the JSON file** gives you the corner-by-corner analysis. These exports are
the complete machine-readable record; there is no hidden copy elsewhere.

### Right to rectification (Art. 16) — "this is wrong, correct it"

**In the app:** you can record your own verdict on any lap the app judged, which is stored alongside
the app's judgement and used in reporting. Measured values (a recorded position, a recorded brake
pressure) are raw sensor readings and are not editable — correcting a measurement would mean
falsifying a record of what the sensors reported.

### Right to erasure (Art. 17) — "delete it"

**In the app:** **Settings → DATA → "Delete all my data"**, then confirm. This permanently removes
every session, lap, checkpoint, GNSS trace, vehicle and motion sample, lap verdict, calibration
attempt and your personal-best reference lap — for every circuit, not just the one selected — and
verifies the deletion actually landed before reporting success. It cannot be undone.

It also removes the stored VIN, a vehicle profile the app selected from the VIN, confirmed
per-vehicle signal bindings, ruled-out signals, diagnostic sweep records, custom signal channel
definitions (whether tagged from a sweep with "Tag as channel" or typed in Settings), the record of
which vehicle profile each session used, the note of an interrupted Test Loop, a track the Test Loop
learned but could not save, and the geometry of circuits you taught the app.

What it keeps are your **preferences**: units, language, adapter address and port, coaching, voice
and suggestion toggles, the selected circuit, and a vehicle profile you chose yourself. None of these
identify you or your car. Uninstalling the app removes them too.

Two honest caveats:

1. The control is **refused while a session is running, or while a Test Loop is learning a track or
   saving one**; end the session or stop the Test Loop first. This exists so the deletion
   cannot race a live recording and leave data behind.
2. If any part of the deletion fails, the app says so instead of reporting success. In that case a
   learned circuit that a surviving session still uses is kept, so that session can still be
   analysed; run the deletion again.

### Right to restriction (Art. 18) — "stop using it for now"

**In the app:** turn off telemetry, coaching and suggestions in Settings; do not start a session. The
app records nothing when no session is active.

### Right to data portability (Art. 20) — "give it to me in a usable format"

**In the app:** the same exports as under access. They are JSON — open, documented, machine-readable
and not tied to TRACE.

### Right to object (Art. 21) and to withdraw consent (Art. 7(3))

**On your device:** withdraw the location permission in your operating system's settings, or turn
telemetry off, at any time. Withdrawal stops future recording; it does not retroactively make past
recording unlawful, and it does not by itself delete what is already stored — use the deletion
control for that.

### Right not to be subject to automated decision-making (Art. 22)

Not engaged. TRACE's analysis produces advice, not decisions with legal or similarly significant
effects.

### If you want to ask us instead

Write to `[OWNER: privacy contact email]`. Please understand what we can and cannot do: **we have no
copy of your data**, so we cannot send you an export, and we cannot delete anything from your phone.
What we can do is help you use the controls above, answer questions about what the app records, and
correct this policy if it is wrong. We will respond within **one month** of your request, as GDPR
Art. 12(3) requires, and will tell you if we need the extension that article allows.

### Right to complain to a supervisory authority (Art. 77)

You may lodge a complaint with the Romanian supervisory authority:

> **Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal (ANSPDCP)**
> B-dul G-ral. Gheorghe Magheru 28-30, Sector 1, 010336 București, Romania
> Telephone: +40 318 059 211
> Email: anspdcp@dataprotection.ro
> Web: https://www.dataprotection.ro/

If you live in another EU or EEA country, you may complain to your own national authority instead.

---

## 8. Security

- The database lives in the app's **private sandbox directory**, which the operating system protects
  from other apps.
- On a modern iPhone or Android phone, that storage is covered by the device's **full-disk
  encryption**, which is active whenever the device is locked with a passcode. **Set a passcode.**
  Without one, this protection does not apply.
- **We do not encrypt the database separately** with a key of the app's own. If someone has your
  unlocked phone, they have your sessions.
- There is **no transmission to secure**: nothing is encrypted in transit because nothing is in
  transit.
- The Wi-Fi OBD adapter connection is a plain TCP link on your own local network, with no
  encryption. It carries vehicle telemetry only, and only over the few metres between adapter and
  phone. If you use the project's own prototype dongle, **change its default Wi-Fi password.**
- Files you export sit in the app's cache and then wherever you send them. The share sheet's
  destination is outside our control.

**There is no backup.** If you lose or reset your phone, your sessions are gone unless you exported
them yourself. This is the price of the app holding nothing.

---

## 9. International transfers

None. No data is transferred outside your device, and therefore none is transferred outside the
European Economic Area.

---

## 10. Changes to this policy — and the backend that does not exist yet

We will keep a version number and a date at the top of this document, and publish the previous
version alongside it. If a change materially affects what is collected or where it goes, we will
tell you **inside the app before the change takes effect**, and where the change requires your
consent we will ask for it rather than assume it.

**About a future server.** There is a plan to add a backend service so that a language model can
produce a written driving analysis. **It does not exist. No such service is contacted by this
version of the app, and no code in this version is capable of contacting one.** When and if it is
built, it will arrive as a **numbered amendment to this policy** — a new section describing exactly
what is sent, to whom, on what legal basis and for how long it is kept — together with a separate,
explicit opt-in inside the app. The local-only processing described in this document will remain
available and will remain the default. We are structuring the policy this way so you can see the
change as a change, rather than finding it folded into a rewrite.

---

## 11. Contact

`[OWNER: name]`
`[OWNER: postal address]`
`[OWNER: privacy email]`
`[OWNER: support URL]`

---

*Romanian version: `privacy-policy.ro.md`. In case of divergence between the two language versions,
`[OWNER/LAWYER: state which version governs — Romanian is the safer choice for a Romanian
controller and Romanian consumers].`*
