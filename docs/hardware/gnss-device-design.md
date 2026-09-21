# TRACE GNSS Timing Device — Engineering Design

**Status:** design deliverable, not a build order. Nothing here is committed to hardware yet.
**Date:** 2026-09-21
**Scope:** a standalone, battery-powered, high-rate GNSS timing device for the TRACE app, operating
alongside a cheap off-the-shelf OBD-II adapter, both connected to the same iPhone simultaneously.
**Author role:** LEAD design, in the same binding style as `hardware/DESIGN.md` (rev-A OBD dongle).

Every factual claim below is either footnoted to a source in §12 or explicitly tagged
**UNVERIFIED**. §13 is the consolidated register of everything that is unverified and what
measurement would close it.

---

## 0. Executive summary and the one recommendation that matters

**Build the protocol before you build the box.**

RaceBox publishes a complete, public BLE protocol specification for the RaceBox Mini / Mini S /
Micro [S1]. It is Nordic UART Service carrying a UBX-framed 80-byte payload derived from u-blox
`NAV-PVT`, emitted at up to 25 Hz, with iTOW, UTC date/time to nanosecond resolution, lat/lon at
1e-7 deg, ground speed in mm/s, heading at 1e-5 deg, per-field accuracy estimates, and 6-DOF IMU —
all in one message. RaceChrono Pro already consumes it [S2].

That changes the shape of this project:

| Phase | What you do | Cost | Elapsed | Risk |
|---|---|---|---|---|
| **A** | Implement a RaceBox-protocol BLE client in TRACE. Buy one RaceBox Mini S (~$199–266 [S3]) or a Dragy DRG70-C (~$159 [S4], different protocol — see §9). | ~$200 | weeks | software only |
| **B** | Field-validate 25 Hz timing, the clock-alignment scheme (§5), and the failover logic (§7) against real laps at Transilvania Motor Ring and MotorPark. | $0 | 2 track days | none |
| **C** | Only then build TRACE hardware — and make it **speak the RaceBox protocol verbatim**. The app code from Phase A is already written, tested and field-proven; the device also works with RaceChrono on day one, which is free third-party validation. | ~$30–60/unit at 100 | months | contained |

Phase C is a real project and the rest of this document specifies it. But Phase A is the one that
actually improves lap-time accuracy this season, and skipping straight to C would mean debugging new
firmware, a new board, a new RF layout, a new BLE stack in Expo and a new clock-alignment algorithm
simultaneously, with no known-good reference to bisect against.

**Headline answers to the brief:**

- **Connectivity:** GNSS device on **BLE**; OBD adapter on **either WiFi AP (what you have today) or
  BLE**. Both work concurrently. The forbidden combination is two WiFi devices. §2.
- **Module:** u-blox **SAM-M10Q-00B** for rev A (integrated patch antenna + SAW + LNA, no RF layout
  work), **MAX-M10S-00B** + external antenna for volume. Run **20 Hz GPS+Galileo**, not 25 Hz
  GPS-only. §3.
- **BOM:** ~**$60 of parts** for unit 1 (~$95–130 delivered with JLCPCB assembly setup and enclosure);
  ~**$30–33/unit at 100** on the MAX-M10S path, ~$55/unit at 100 if you keep SAM-M10Q. §8.
- **Timing:** GNSS-to-phone-clock alignment **±2–5 ms (1σ)**, lap-to-lap repeatability **±5–15 ms**
  (from ±50–80 ms today). But **OBD-to-phone alignment is ±30–60 ms and that, not GNSS, is the
  binding constraint on any fused brake/position claim.** §5. This is the uncomfortable conclusion
  the brief asked for and the answer is yes, it is real.
- **Top three risks:** (1) fused OBD+GNSS claims overpromise because the OBD clock is 10–20× worse;
  (2) buy-vs-build — unit 1 costs more than a RaceBox and takes months; (3) BLE-under-Expo-57
  integration on a sideloaded iPhone is unproven in this repo. §10.

---

## 1. What exists today (the ground truth this design attaches to)

Read before designing; verified against the repo on 2026-09-21.

- `firmware/` — PlatformIO, `[env:esp32c3]`, Arduino framework on **ESP32-C3**. `wifi_ap.cpp` SoftAP +
  `elm_server.cpp` TCP server on :35000, `can_obd.cpp` on TWAI. All protocol logic is framework-free
  C (`elm_line_parser.c`, `elm_server_core.c`, `pid_codec.c`, `read_only_guard.c`,
  `can_response_match.c`) with a host-native `[env:native]` unit-test target. **This team ships
  ESP32 firmware with unit tests. That competence is real and is the main reason Phase C is viable.**
- `hardware/DESIGN.md` — rev-A OBD dongle, 2-layer, JLCPCB assembly, LCSC part numbers with C-codes,
  explicit netlist, explicit power budget. This document follows that format deliberately.
- `hardware/kicad/trace-dongle/` — DRC reports, production CSVs, board renders. Board capability is
  real.
- `apps/mobile/package.json` — Expo **57.0.11**, React Native **0.86.2**, React 19.2.3,
  `expo-dev-client` 57, `react-native-tcp-socket` ^6.4.2, `expo-location`, `expo-sensors`.
  **There is already a custom dev client with a third-party native module in it.** Adding BLE is not
  a new class of problem; it is the same problem again.
- `packages/core/src/contracts.ts` — `LocationSample { tMono, lat, lon, accuracyM, speedMps,
  headingDeg, source: 'gnss' | 'replay' | 'fused' }`. `'fused'` already exists.
- `packages/core/src/telemetry/contracts.ts:53` — the binding clause:
  ```ts
  tMonoMs: number;             // SAME monotonic clock as LocationSample — injected, never Date.now()
  ```
  This single line is why §5 is the hardest section of this document.
- `packages/core/src/telemetry/enet/` — a second transport engine (HSFZ/DoIP/UDS) already exists
  alongside the ELM327 one, both behind `TelemetrySession<TState>`. The Supra path is ENET over WiFi,
  not ELM327.
- `apps/mobile/src/platform/gnssLocationProvider.ts` — `expo-location`, with
  `sampleIntervalHistogramMs` diagnostics already bucketed at 200/500/1000/2000/5000 ms. That
  histogram is the instrument that will prove or disprove every claim in §5 in the field.

---

## 2. The connectivity matrix

This is answered first because it constrains everything downstream.

### 2.1 The three physical link types, and what iOS actually allows

| Link | Works with a sideloaded third-party app on a stock iPhone? | Notes |
|---|---|---|
| **WiFi (device runs a SoftAP, app opens a TCP socket)** | **Yes.** This is what TRACE does today via `react-native-tcp-socket`. | The iPhone can join exactly one WiFi network. Joining the adapter's AP means **no internet** for the duration. iOS may also show "no internet connection" and try to fall back to cellular for data. |
| **Bluetooth Low Energy (GATT)** | **Yes**, via Core Bluetooth. No certification needed. | The only Bluetooth route open to a third-party accessory. |
| **Bluetooth Classic SPP (RFCOMM)** | **No.** | iOS does not expose Bluetooth Classic serial to third-party apps; Classic accessories require MFi (External Accessory framework, Apple-issued authentication coprocessor) [S5][S6]. |
| **MFi (Classic + auth chip, e.g. OBDLink MX+)** | Yes, but only if *you* are MFi-licensed, which you are not, and the adapter's app is the licensee's. | Not an option for a device you build. It *is* how OBDLink MX+ works on iOS. |

### 2.2 What cheap Chinese ELM327 dongles actually are

This matters because the owner intends to buy one in bulk.

- The overwhelming majority of the sub-$10 ELM327 clones on AliExpress/Amazon are **Bluetooth
  Classic 2.0/3.0 SPP**. Those are **completely unusable on any iPhone** — not "flaky", not "needs a
  workaround", simply not reachable from iOS [S5][S6]. If a listing says "Bluetooth 3.0", "works
  with Torque Pro", or "Android/Windows", it is a paperweight for this project.
- The iPhone-capable cheap adapters fall into exactly two buckets:
  - **BLE (Bluetooth 4.0+) ELM327 clones** — Vgate iCar Pro BLE 4.0 (~$26–34 [S7]), Veepeak OBDCheck
    BLE (~$32 [S8]). These are the cheap-and-works tier.
  - **WiFi ELM327 clones** — a SoftAP at 192.168.0.10:35000, which is exactly the shape TRACE already
    speaks. Cheapest tier, and the one that costs you internet.
- **Practical buying rule for bulk:** you must filter on "BLE / Bluetooth 4.0 / iOS compatible" or
  "WiFi". Budget ~$25–35/unit for a BLE unit, not $8. The $8 tier is Classic and is dead on arrival.
  Cheap clones also frequently have incomplete protocol support and fake ELM327 version strings
  [S6][S9] — for a **BMW B58 on ENET/DoIP** this partly does not matter (see below), but for the
  "any-car beginner trainer" product direction it very much does.

### 2.3 The matrix

Rows = OBD link, columns = GNSS link. ✅ works, ⚠️ works with a cost, ❌ impossible.

| OBD adapter ↓ / GNSS device → | GNSS on **WiFi AP** | GNSS on **BLE** | GNSS on **MFi** |
|---|---|---|---|
| **OBD on WiFi AP** (today: MHD WiFi/ENET; also cheap WiFi ELM327) | ❌ **Impossible.** One WiFi interface, one network. | ✅ **RECOMMENDED.** WiFi radio serves OBD, BLE radio serves GNSS. Zero change to the existing, working `react-native-tcp-socket` ENET path. Cost: still no internet while on the OBD AP. | ❌ not available to you |
| **OBD on BLE** (Vgate iCar Pro BLE, Veepeak OBDCheck BLE) | ⚠️ Works — BLE for OBD, WiFi for GNSS — but now your *own* device is the thing costing the user their internet, which is a self-inflicted wound. Also puts 2.4 GHz WiFi traffic in the car for no reason. | ✅ **Also fine.** Two concurrent BLE peripherals; iOS handles this routinely (exact simultaneous-peripheral limit is **UNVERIFIED**, practically ≫2). **Internet stays available** — this is the only row that keeps cellular/WiFi data alive. | ❌ |
| **OBD on Bluetooth Classic SPP** (the $8 clones) | ❌ OBD side already dead on iOS | ❌ | ❌ |
| **OBD on MFi** (OBDLink MX+) | ⚠️ | ✅ works, but you are paying $130 for the adapter | — |

### 2.4 Decision

> **The GNSS device is BLE. Full stop. The OBD adapter may be WiFi or BLE; the app must support both
> and must not care which.**

Rationale:

1. **BLE for GNSS is the only choice that is compatible with *both* OBD link types.** Putting the
   GNSS device on WiFi forecloses the WiFi-OBD path permanently, and the WiFi-OBD path is the one
   that already works in this repo today (ENET/DoIP to the MHD adapter on the Supra).
2. **The data rate demands nothing more.** 88 bytes per message (80-byte payload + 6-byte UBX header
   + 2-byte checksum) at 25 Hz is **2.2 kB/s** [S1]. BLE with Data Length Extension at a 15 ms
   connection interval clears that by more than an order of magnitude. There is no throughput
   argument for WiFi here.
3. **BLE is what the incumbents do**, which means the phone-side code is reusable against bought
   hardware in Phase A and against your own hardware in Phase C.
4. **It preserves internet when the OBD adapter is also BLE**, which unlocks live upload, the
   backend-hosted LLM path (per the Phase-5 decision that no API keys live in the app), and OTA
   circuit data — none of which work while the phone is captive on an OBD SoftAP.

**What this forces the owner to buy:** a **BLE (Bluetooth 4.0+) ELM327-class adapter, not a Bluetooth
Classic one** — Vgate iCar Pro BLE 4.0 or Veepeak OBDCheck BLE class, ~$26–34 each [S7][S8] — *if*
he wants the internet-preserving configuration. If he is content to stay on the WiFi OBD adapter he
already owns, he buys nothing extra and the GNSS device still works.

### 2.5 The coexistence caveat nobody mentions

If the OBD adapter is on **2.4 GHz WiFi** and the GNSS device is on **BLE**, both links share the
2.4 GHz band and, on the iPhone, a single combo radio. Expect measurable degradation of both:
increased BLE connection-event misses (dropped or late GNSS packets) and reduced OBD poll rate.
Magnitude is **UNVERIFIED** and must be measured — the existing `sampleIntervalHistogramMs`
diagnostic plus `getDiagnostics().observedHzByChannel` on the telemetry session are exactly the two
instruments needed, and both already exist. Mitigations, in order of preference:

1. Move the OBD adapter to BLE too (removes WiFi from the car entirely).
2. If the OBD adapter supports 5 GHz, use it (most cheap ones do not — **UNVERIFIED** per model).
3. Accept it and make the app degrade visibly rather than silently (§7.4).

---

## 3. GNSS module selection

### 3.1 What actually moves lap-time accuracy (and what is marketing)

The brief is right that fix rate is a hard constraint, but it is worth being precise about *why*,
because the wrong spec is easy to chase.

Lap timing error decomposes into four terms. At **150 km/h = 41.67 m/s**:

| Term | Phone (1 Hz, CEP ≈ 3–5 m) | 20 Hz module (CEP 1.5 m [S10]) | Does it cancel lap-to-lap? |
|---|---|---|---|
| **(a) Along-track position bias** — ionosphere, multipath, slowly varying | 3 m → **72 ms** | 1.5 m → **36 ms** | **Yes, largely.** Correlated over tens of seconds, so it is nearly identical at the same line on consecutive laps. It hurts *absolute* lap time, not *delta* between your laps. |
| **(b) Chord/interpolation error** — straight-line interpolation across the gap while the car is accelerating | at 1.0 g braking, a·T²/8 = 11.8·1²/8 = **1.47 m → 35 ms** | T = 0.05 s → 0.0037 m → **0.09 ms** | **No.** It varies with where in the sample window the crossing falls. This is the clean, unambiguous win. |
| **(c) Crossing-phase jitter** — the crossing lands at a uniformly random phase within the sample interval, so (b) varies randomly lap to lap | **±20–40 ms** | **±1–2 ms** | **No.** This is the dominant source of "why does my phone say I was 0.08 s faster when I know I wasn't". |
| **(d) Velocity error** (drives dead-reckoning between fixes and every braking/throttle-point derivative) | derived, lagged, unspecified | **0.05 m/s** (50% @ 30 m/s) from raw Doppler [S10] | n/a |

**Conclusion:** the honest claim is not "10× better lap times". It is:

- **Absolute** lap time accuracy improves from roughly ±80–120 ms to roughly **±30–50 ms**, and is
  then floored by term (a), which no consumer L1 receiver escapes.
- **Lap-to-lap repeatability and delta-time** — the thing a coaching app actually lives on — improves
  from roughly **±50–80 ms to ±5–15 ms**. That *is* the order-of-magnitude claim, and it is
  defensible. (Estimates are engineering derivations from the sourced specs, not measurements:
  **UNVERIFIED** until a track day says otherwise.)

Therefore:

| Spec | Verdict |
|---|---|
| **Update rate 10 → 20/25 Hz** | **Real, and the main event.** Kills terms (b) and (c). |
| **Raw Doppler velocity** | **Real.** u-blox reports 0.05 m/s velocity accuracy and 0.3° dynamic heading [S10] — this is Doppler-derived, not position-differenced, and it is what makes braking-point detection crisp. Any module you pick must expose it; `NAV-PVT` does. |
| **Multi-constellation** | **Real but with a direct cost** — see §3.2. More satellites = better geometry = smaller term (a), but a *lower* maximum update rate. |
| **Dual-band L1+L5** | **Mostly marketing at this price point, for this use case.** L5 helps with multipath and ionosphere — term (a) — which largely cancels lap-to-lap. It roughly triples module cost and complicates the antenna (needs an L1/L5 antenna, e.g. Taoglas AHP5354A). **Not recommended for rev A.** |
| **RTK / cm-level** | **Marketing, for this product.** RTK needs a correction stream (NTRIP over internet, or a local base). You are frequently captive on an OBD SoftAP with no internet, at a circuit that may have poor coverage. Pointless. |
| **Cold start TTFF** | Minor. 23–28 s cold, 1 s hot [S10]. With the device left powered in the paddock between sessions, it is always hot-starting. AssistNow needs internet — see above. |

### 3.2 The 25 Hz trap

u-blox raised the M10 maximum navigation rate via a configuration setting, no firmware update
required [S11]:

| Constellations | Previously | Now |
|---|---|---|
| Single (GPS only) | 18 Hz | **25 Hz** |
| 2 concurrent (GPS+GAL) | 10 Hz | **20 Hz** |
| 3 concurrent (GPS+GAL+GLO) | 10 Hz | **16 Hz** |
| 4 concurrent (GPS+GAL+GLO+BDS) | 5 Hz | **10 Hz** |

The per-module datasheets agree: MAX-M10S "high performance" is 20 Hz for GPS+GAL, 16 Hz for
GPS+GAL+GLO [S10]; SAM-M10Q is 20 Hz for GPS+GAL, 16 Hz for GPS+GAL+GLO, 10 Hz for the 4-GNSS default
[S12].

> **Recommendation: run 20 Hz GPS + Galileo.** Not 25 Hz GPS-only.
>
> Going from 20 Hz to 25 Hz shrinks the inter-fix distance at 150 km/h from 2.08 m to 1.67 m and
> shrinks term (b) from 0.09 ms to 0.06 ms. It is *nothing*. Dropping Galileo costs you roughly half
> your usable satellites, which directly worsens term (a) and hurts badly at circuits with tree
> lines, pit buildings, or an armco/grandstand horizon — which describes both Transilvania Motor
> Ring and MotorPark. Dragy advertises "up to 25 Hz" [S4] and RaceBox advertises 25 Hz with four
> concurrent constellations [S3]; at least one of those numbers is a configuration the buyer will
> never actually see. Do not chase the number on the box.
>
> Make it configurable (the RaceBox protocol itself exposes 25/20/10/5/1 Hz [S1]) and default to 20 Hz
> GPS+GAL. Add GLONASS at 16 Hz as a user-selectable "maximum satellites" mode for bad-sky circuits.

### 3.3 Module candidates

All prices USD, checked 2026-09-21.

| Part | Platform | Max rate | Antenna | Unit price | 100-qty | Verdict |
|---|---|---|---|---|---|---|
| **u-blox SAM-M10Q-00B** | M10 | 20 Hz GPS+GAL, 16 Hz +GLO [S12] | **Integrated 15×15 mm patch + SAW + LNA** [S12] | ~$37.41 (LCSC C5443880) [S13] | ~$37 [S13] | **RECOMMENDED for rev A.** Expensive, but it deletes the entire RF-design risk. No antenna selection, no matching network, no impedance-controlled trace, no separate SAW. For a team with KiCad skill but no RF lab, this is worth every cent of the $27 premium. |
| **u-blox MAX-M10S-00B** | M10 | 20 Hz GPS+GAL, 16 Hz +GLO [S10] | External. Internal LNA + SAW + LTE-B13 notch; **internal LNA has enough gain for a passive antenna** [S14] | **$11.42** (DigiKey) [S15]; $9.81 (LCSC C4153167) [S13] | **$9.70–10.12** [S15] | **RECOMMENDED for volume.** Same silicon, same specs, one-third the price, but you now own the antenna, the 50 Ω trace and the ground plane. Move here only after rev A has proven the rest of the design. |
| u-blox MAX-M10M-00B | M10 | same family | External | (DigiKey listed [S15], price **UNVERIFIED**) | — | Multi-band-capable variant; no reason to prefer it here. |
| u-blox NEO-M9N-00B | M9 | 25 Hz single-GNSS per the M9 datasheet family | External | ~$12.10 [S16] | — | Previous generation, higher power, no advantage over M10. Skip. |
| Quectel L76-K | MTK | 10 Hz NMEA | varies | ~$12.50–15.90 [S17] | — | **10 Hz ceiling.** Halves the benefit for the same money. Skip. |
| Quectel LC76G | — | 10 Hz NMEA only [S17] | External | — | — | Skip, same reason. |
| Quectel LC29H(EA) | dual-band + RTK | 10 Hz [S17] | External, dual-band | ~$55 for a devboard [S17] | — | Dual-band/RTK for less money than u-blox F9P, but **10 Hz** and RTK is useless here (§3.1). Skip. |
| u-blox ZED-F9P | F9 | — | External, dual-band | ~$150+ (**UNVERIFIED**) | — | Survey-grade RTK. Wrong product, wrong price, wrong problem. |

### 3.4 Selected

- **Rev A (units 1–10): `SAM-M10Q-00B`.** LCSC C5443880. Integrated patch, SAW and LNA; 20-pin LGA;
  −40…+85 °C [S12]. Datasheet performance is quoted on a **50×50 mm² ground plane** [S12] — that
  sets the board size (see §4 and §6.4).
- **Rev B / volume: `MAX-M10S-00B`.** LCSC C4153167 / DigiKey 15712906. Keep the SAM-M10Q footprint
  option on the same board revision if you can afford the area, so you can A/B them on one PCB.
- **Configuration (both):** `CFG-RATE-MEAS` = 50 ms (20 Hz), `CFG-SIGNAL` = GPS + Galileo,
  `CFG-NAVSPG-DYNMODEL` = **4 (automotive)** — the same value RaceBox defaults to and exposes [S1] —
  and **switch to 8 (airborne <4 g) above ~300 km/h**, which is also what RaceBox advises [S1].
  Output `UBX-NAV-PVT` on UART at 460800 baud (20 Hz × 100 bytes = 2 kB/s; 115200 is enough but
  leaves no headroom for `NAV-SAT` diagnostics).

### 3.5 What the module does *not* fix

None of this addresses **track altitude/elevation** or **start-line geometry**. A 20 Hz receiver
crossing a badly-surveyed start/finish line is still crossing a badly-surveyed line. The existing
MotorPark work flagged "field-unvalidated geometry"; high-rate GNSS makes that error *more* visible,
not less. Budget a session of line-surveying per circuit once the device exists.

---

## 4. Antenna and physical placement

The antenna is at least as important as the module and is where amateur GNSS designs die.

### 4.1 Active vs passive

| | Passive patch | Active patch (integrated LNA) |
|---|---|---|
| Needs | Very short, controlled 50 Ω trace to the module; module must have an internal LNA | Tolerates a long cable (LNA is at the antenna, before the cable loss) |
| MAX-M10S | **Supported** — "the internal LNA provides enough gain for passive antennas" [S14] | Supported; supply from `VCC_RF` or external, with `LNA_EN` gating [S10][S14] |
| Cost | ~$1.50–4 (**UNVERIFIED** specific SKU) | $10–63 depending on grade (Taoglas AA.171 MagmaX, IP67, 3 m RG-174, SMA, ~$63 [S18]) |
| Use it when | Antenna is on the same board as the module | Antenna is remote (roof mount, or cable to the windscreen) |

### 4.2 Ground plane — the part that gets skipped

A ceramic patch antenna is a half-structure; the ground plane under it is the other half. Undersize
it and you lose gain, distort the pattern, and raise the axial ratio, which specifically degrades
performance on low-elevation satellites — the ones that give you good horizontal geometry.

- u-blox quote SAM-M10Q performance **on a 50×50 mm² ground plane** [S12]. Treat that as the design
  target, not a suggestion.
- **Binding layout rules for rev A:**
  - Solid, unbroken ground pour on the bottom layer, **≥ 50×50 mm**, centred under the patch.
  - Nothing — no traces, no components, no battery — directly under or above the patch.
  - Keep the **ESP32-C3 antenna ≥ 25 mm from the GNSS patch**, at the opposite end of the board, with
    its keep-out honoured per the Espressif module datasheet, and preferably with the board's long
    axis separating them. 2.4 GHz broadband noise desensing a 1575 MHz front end is the classic
    failure of exactly this class of device.
  - Provide a **DNP footprint for an external L1 SAW filter** in series with the RF path on the
    MAX-M10S variant. u-blox explicitly recommend this "for designs with other radio systems" [S14] —
    which is precisely a board with a WiFi/BLE radio on it. Fit it only if measurement says you need
    it; the footprint is free, the respin is not.
  - Provide a **DNP u.FL/SMA footprint** so an external active antenna can be substituted for the
    on-board patch during bring-up. This is the single most valuable debug feature on the board: it
    lets you prove whether a disappointing C/N0 is the antenna or the module.

### 4.3 Where the device physically sits in the car

Ranked:

1. **Roof, outside, magnetic-mount active antenna (Taoglas AA.171 class, IP67, SMA [S18]) with the
   box in the cabin.** Best sky view by a wide margin, no windscreen attenuation, no thermal problem
   for the battery. Costs $63 and a cable through a door seal. **This is the right answer for a
   serious data day and should be an offered accessory, not the default.**
2. **Top of the dashboard, hard against the base of the windscreen, patch facing up, box horizontal.**
   This is where Dragy and RaceBox live. Good enough. Attenuation through an **athermic /
   IR-reflective (metallised) windscreen is severe** — many European cars, including recent Toyota/BMW
   products, have them, sometimes with a printed "antenna window" patch near the mirror. **UNVERIFIED
   for the user's 2026 GR Supra specifically; must be measured** (compare C/N0 on the dash vs on the
   roof — a 6+ dB delta means the screen is metallised and the roof antenna becomes mandatory, not
   optional).
3. **Rear parcel shelf / boot lid.** Fine on a coupe, blocked on many cars.
4. **Anywhere in the footwell, in a pocket, under a seat.** Do not.

**Mount:** 3M Dual Lock SJ3550 or VHB on the dash, plus a lanyard. Suction cups on glass fail in
summer heat, exactly when you need them. Design the enclosure with a flat, slightly wedged base
(≈ 5–10°) so the patch is near-horizontal on a raked dash top.

---

## 5. Time synchronisation — the hardest problem

### 5.1 The contract that must be satisfied

`packages/core/src/telemetry/contracts.ts:53` states it plainly:

```ts
tMonoMs: number;             // SAME monotonic clock as LocationSample — injected, never Date.now()
```

and `packages/core/src/contracts.ts:14` gives `LocationSample.tMono` as "monotonic ms". So every
sample of every kind — GNSS position, brake pressure, throttle, rpm, accelerometer, gyro — has to
land on **one** timeline: the phone's monotonic clock (`performance.now()`-class, injected as
`MonotonicClock`, as the replay machinery in `apps/mobile/src/session/liveTimestampedProvider.ts`
already demonstrates).

Today that is trivially satisfied because every sample is stamped **on the phone, at arrival**. The
moment an external device with its own clock enters, it stops being trivial.

### 5.2 Three clocks

| Clock | Source | Stability | What it knows |
|---|---|---|---|
| **Phone monotonic** | iOS mach_absolute_time via RN | excellent, monotonic, arbitrary epoch | nothing about the world |
| **GNSS device** | GPS time of week (iTOW), disciplined by the satellite constellation; `TIMEPULSE` pin, 1PPS, **30 ns RMS / 60 ns 99%** [S10][S12] | essentially perfect | absolute time to ~25 ns (the RaceBox worked example shows a Time Accuracy field reading **25 ns** [S1]) |
| **OBD adapter** | none worth the name — an ELM327 clone has no real-time clock and reports nothing about *when* a value was sampled | n/a | nothing |

### 5.3 What GNSS gives you, and why PPS is a red herring here

The receiver hands you, in every `NAV-PVT`:

- `iTOW` — milliseconds since the start of the GPS week,
- full UTC Y/M/D h:m:s plus a **signed nanoseconds** correction,
- `tAcc` — time accuracy in nanoseconds,
- validity/confirmation flags.

The RaceBox message carries all of these verbatim at offsets 0, 4–10, 11, 12, 16 [S1].

The **PPS pin is not useful to you** in the BLE architecture. PPS disciplines a clock on a wire
*inside* the device. It cannot cross a BLE link. What PPS *is* good for is disciplining the **ESP32's
own** clock so that the IMU samples the firmware interleaves between GNSS epochs carry accurate
timestamps — that is a genuine and worthwhile internal use (§5.7), but it does nothing for
phone alignment. Do not let "it has PPS, so timing is solved" into the design conversation.

The key insight is this:

> **The relative timing between GNSS samples is already perfect and is completely immune to BLE
> latency and jitter, because it is carried *inside* the message as `iTOW`, not inferred from arrival
> time.**
>
> The only unknown is a single scalar: the offset between GPS time and the phone's monotonic clock.

### 5.4 What BLE does to you

| Contributor | Magnitude | Shape |
|---|---|---|
| Connection interval quantisation | iOS will not accept below **15 ms**, requires multiples of 15 ms, and may unilaterally offer 30 ms [S19] | ~uniform 0–15 ms (or 0–30 ms), **positive only** |
| Peripheral stack queuing (ESP32 notify → controller) | ~1–5 ms (**UNVERIFIED**) | positive only |
| iOS Core Bluetooth → JS bridge delivery | ~1–10 ms, occasional tens of ms under load (**UNVERIFIED**) | positive only, heavy right tail |
| Retransmissions / missed connection events (WiFi coexistence, §2.5) | one or more whole connection intervals | positive only, rare, large |

Total one-way delay **D** is bounded below by a hardware minimum **D_min** (a few ms) and has a
one-sided, heavy-right-tailed distribution. **Nothing is ever early.** That one-sidedness is what
makes the problem solvable.

### 5.5 The scheme

A **skew-and-offset fit on the lower envelope** — structurally the same trick NTP uses, and exactly
right for a one-sided delay distribution.

For each received packet *i*, record the pair:
- `g_i` = GPS time reconstructed from `iTOW` + nanoseconds (monotonic within a week; handle the
  week rollover and the leap-second-free nature of GPS time explicitly),
- `p_i` = the phone monotonic clock read **in the BLE notification callback, as the very first
  statement, before any parsing**.

Then `p_i = a·g_i + b + D_i`, with `D_i ≥ D_min > 0`, `a ≈ 1 + ε` where ε is the phone oscillator's
skew relative to GPS time (**10–50 ppm** for a consumer crystal, **UNVERIFIED** for iPhone
specifically).

Estimate `(a, b + D_min)` by fitting the **lower envelope** of the scatter over a sliding window:

1. Window: the last **60 s** of pairs. At 20 Hz that is 1200 points.
2. Partition the window into ~20 sub-buckets of 3 s each; in each bucket keep only the point with
   the smallest residual `p_i − g_i`. That is 20 near-minimum-delay anchors.
3. Ordinary least squares on those 20 anchors → `â`, `b̂`.
4. Clamp `â` to [1 − 100 ppm, 1 + 100 ppm]; reject and hold the previous fit if the clamp trips
   (it means a clock step, an app suspend/resume, or a device reconnect).
5. Emit `tMono = â·g_i + b̂` for every sample. **Not** the arrival time.
6. Make the estimator **monotone**: never let a re-fit move an already-emitted timestamp backwards;
   apply offset corrections by slewing (bounded rate, e.g. 1 ms/s) rather than stepping, precisely the
   way `ReplayTimeSource` in `apps/mobile/src/session/liveTimestampedProvider.ts` already enforces a
   monotonic floor across runs. That file is the pattern to copy.

**Where it lives:** pure TypeScript in `packages/core` — e.g. `packages/core/src/timing/
gnssClockAligner.ts`, with `MonotonicClock` injected, no I/O. It is a pure function of a sequence of
`(g, p)` pairs; it is trivially unit-testable with synthetic delay distributions, including the
pathological ones (a 300 ms stall, an app backgrounding, a reconnect, a week rollover). This fits the
repo's existing discipline of keeping every decidable thing in pure, tested core.

### 5.6 Residual error, quantified

| Source | Contribution to the GNSS↔phone alignment |
|---|---|
| GPS time itself | 25–60 ns [S1][S10] — **negligible** |
| Skew residual after a 60 s fit | at 50 ppm mis-estimated by 10%, over the 50 ms between samples: **< 0.001 ms** — negligible |
| Uncertainty in the lower envelope (`D_min` estimate) — the dominant term | **±2–5 ms (1σ)** with a 15 ms connection interval, worse with a 30 ms one (**UNVERIFIED**; this is the number the bring-up must actually measure) |
| Residual bias from `D_min` itself | **a constant**, therefore **zero effect on lap times, deltas, or per-corner shapes.** It only matters for cross-sensor alignment. |

> **GNSS-to-phone-clock alignment: ±2–5 ms (1σ), bounded at roughly ±10 ms.** At 150 km/h that is
> **0.08–0.4 m** of along-track uncertainty. Comfortably better than every other term in §3.1.

### 5.7 The IMU-between-epochs question

If the device carries an IMU (§6.5), its samples arrive between GNSS epochs and must be timestamped
in the *device's* frame, then mapped by the same `(â, b̂)`. Discipline the ESP32's timebase to the
GNSS `TIMEPULSE` output (hardware capture on a GPIO, 30 ns RMS [S10][S12]) and stamp IMU samples from
that disciplined counter. This is where PPS earns its keep. **Do not** stamp IMU samples with the
arrival time of the nearest GNSS packet.

Simpler alternative, and what RaceBox does: put the IMU reading **inside** the GNSS message at the
GNSS epoch [S1]. You lose inter-epoch IMU resolution but you inherit the GNSS timestamp for free and
the whole problem disappears. **Recommended for rev A.** 20 Hz IMU is plenty for the coaching engine;
`latG`/`longG`/`yawRateDps` already exist as channels in `packages/core/src/telemetry/contracts.ts`
and are currently sourced from `expo-sensors` at comparable rates.

### 5.8 The OBD clock — and the honest conclusion

Now the bad news, which the brief correctly anticipated.

An ELM327-class adapter is **request/response**. The app sends `01 0C`, and some time later a string
comes back. The value in that string was sampled by the ECU at an *unknown instant* somewhere inside
that window. There is no timestamp anywhere in the protocol.

| Contributor | Magnitude |
|---|---|
| ELM327 round-trip per PID | **100–200 ms** is the commonly reported figure (5–10 PIDs/s) [S20] |
| ENET/DoIP round-trip (the Supra path, `packages/core/src/telemetry/enet/`) | faster, but still request/response over WiFi + HSFZ + UDS. **UNVERIFIED** — measure it with the existing `getDiagnostics().observedHzByChannel` |
| ECU-internal sampling latency for the value itself | **UNVERIFIED**, and unknowable from outside. A brake-pressure DID may be a filtered value updated at 50 Hz, or a snapshot, or stale by a frame |

Best case, the app timestamps at the **midpoint** `(t_send + t_recv)/2` rather than at arrival — the
standard NTP-style estimator — which halves the bias and leaves a residual of roughly ±(RTT/2). Even
with a fast ENET path at, say, 40 ms RTT, that is **±20 ms**; with an ELM327 at 150 ms it is **±75 ms**.

> ### The conclusion, stated plainly
>
> **Yes — the brief's worry is correct, and it is the single most important finding in this document.**
>
> After all this work, **GNSS aligns to the phone clock at ±3 ms, and OBD aligns at ±30–60 ms
> (ENET, optimistic) to ±75 ms (ELM327).** The fused product is governed by the worse of the two.
> Spending money on a 25 Hz receiver and then claiming 10 ms resolution on "where exactly you hit the
> brake pedal relative to the apex" is **overclaiming by an order of magnitude**.
>
> At a 70 km/h corner-entry speed (19.4 m/s), ±50 ms is **±1.0 m** of along-track uncertainty on the
> brake point. At 150 km/h it is **±2.1 m**.
>
> That is still genuinely useful — a coaching app that says "you braked about 2 m later than your best
> lap" is honest and actionable. A coaching app that draws a brake-release marker on a corner map at
> 10 cm resolution is lying to the driver.

**Three things follow, and all three are binding:**

1. **Calibrate the lag, do not guess it.** OBD `speedKph` (PID 0x0D) and GNSS ground speed measure the
   same physical quantity. Cross-correlate them over a full lap; the lag that maximises correlation
   *is* the end-to-end adapter+ECU latency for that channel, on that car, with that adapter. It is a
   **constant bias** and is therefore removable. Apply the fitted offset per channel (brake and
   throttle ride the same transport, so the speed-derived lag is a good first-order estimate for
   them; the residual is the per-DID difference). This is a pure, testable function and belongs in
   `packages/core` next to the aligner. It converts most of the ±50 ms from *bias* into *jitter*,
   and jitter is what you are then honestly left with — call it **±15–30 ms after calibration**
   (**UNVERIFIED**, must be measured).
2. **Carry the uncertainty in the data model, not in a footnote.** Every fused derived quantity should
   know its own time uncertainty, and the analysis engine should refuse to render a claim finer than
   it. The deterministic engine (Phase 5a) is exactly the right place to enforce this because it is
   rule-based and auditable.
3. **Never let the marketing of the GNSS device leak onto the OBD channels.** "20 Hz GPS" is true.
   "20 Hz telemetry" would not be.

---

## 6. Power and packaging

### 6.1 Power budget (20 Hz, BLE connected)

| Rail item | Current @ 3.3 V | Basis |
|---|---|---|
| SAM-M10Q, tracking, GPS+GAL, 1 Hz | 8 mA | datasheet, 3.0 V supply [S12] (MAX-M10S: also 8 mA GPS+GAL [S10]) |
| …same, at **20 Hz** | **budget 30 mA** | **UNVERIFIED** — u-blox do not publish a high-rate figure; the CPU no longer idles between epochs. 3–4× the 1 Hz figure is the conservative assumption. **Measure this first.** |
| ESP32-C3, BLE connected, 15 ms interval, ~2.2 kB/s notify | **budget 40 mA** average | **UNVERIFIED**. Peak TX is ~80–130 mA but duty cycle is low. Measure. |
| IMU (ICM-42688-P class), 1 kHz, or decimated to 20 Hz | ~1 mA | **UNVERIFIED** for the specific part |
| Charger quiescent, LDO/buck loss, 2 status LEDs at low duty | ~10 mA | estimate |
| **Total** | **≈ 80 mA @ 3.3 V ≈ 264 mW** | |

Cell-side, at 3.7 V nominal and ~88% converter efficiency: **≈ 81 mA from the cell.**

**Sanity check against a shipping product:** RaceBox Mini S claims 1100 mAh and "up to 20 hours"
[S3] → **≈ 55 mA average**. That is the same order as the budget above and suggests 80 mA is
appropriately conservative. Good.

### 6.2 Battery

| Requirement | Choice |
|---|---|
| Runtime | A track day is 8–10 h of paddock-plus-sessions. At 81 mA: **1500 mAh gives 18 h**, **2000 mAh gives 24 h**. |
| Chemistry | **Li-Po (LiCoO₂/graphite), single cell, 3.7 V nominal**, with **protection circuit (PCM) integrated on the cell**. |
| Form factor | **103450** (10 × 34 × 50 mm, ~2000 mAh) or **603450** (~1100 mAh) — standard, second-sourceable, JST-PH 2.0 pigtail. **Specific vendor SKU: UNVERIFIED** — select one whose datasheet states discharge to **+60 °C** and charge to **+45 °C**, and buy from a distributor that will actually supply that datasheet. Do not buy an unbranded AliExpress cell for a device that lives on a windscreen. |
| Recommended | **2000 mAh / 103450**, for the ~2× margin that lets you derate hard in summer heat and still finish the day after two years of cycling. |

Reject alternatives, briefly: **18650** — too thick for a dash-top wedge and the holder is a
vibration liability. **LiFePO₄** — better thermally but 3.2 V nominal, lower energy density, needs a
different charger, and its top temperature is not meaningfully better for the same money.
**Supercap + 12 V** — see the 12 V SKU below, which is the real answer to the thermal problem.

### 6.3 Charging

- **USB-C receptacle**, CC1/CC2 5.1 kΩ pulldowns to GND (so a C-to-C cable actually supplies 5 V).
  Charge-only is acceptable for rev A; wire D+/D− to the ESP32-C3's native USB pins if you want
  USB-serial-JTAG flashing and logging over the same port, which you do.
- **`MCP73831T-2ACI/OT`** single-cell Li-Po charger, SOT-23-5. **$0.76 @1 (DigiKey)** [S21];
  LCSC **C424093** [S22]. Programme I_charge with `R_PROG`: **2 kΩ → 500 mA** (2 h for 2000 mAh at
  0.25 C, gentle and heat-friendly). The `-2` suffix is the 4.20 V variant — correct for Li-Po.
- **Charge-inhibit on temperature is mandatory, not optional** (§6.6). MCP73831 has no thermistor
  input, so gate its `CE`/`PROG` path from an ESP32 GPIO driven by an NTC reading. If you would
  rather buy the interlock than build it, **`BQ25185`/`BQ24074`-class parts have native TS pins**
  (**price UNVERIFIED**) — worth the swap if the NTC gating proves fiddly.
- **Fuel gauge:** `MAX17048` (ModelGauge, I²C, no sense resistor) is the clean answer; SparkFun sell
  a breakout at **$5.95** [S23], the bare IC is cheaper (**price UNVERIFIED**). **Cheaper rev-A
  alternative:** a 2× 1 MΩ divider into an ESP32-C3 ADC pin, gated by a MOSFET so it does not drain
  the cell when off. Report battery percentage in the RaceBox-compatible field at payload offset 67
  [S1] and the app gets a battery indicator for free.
- **Rail:** the ESP32-C3 needs 3.3 V and tolerates 3.0–3.6 V; the GNSS module the same. A single-cell
  Li-Po runs 4.2 → 3.0 V, which crosses 3.3 V. Use a **buck-boost** (TPS63020-class [S24]) rather
  than an LDO, or accept an LDO and lose the bottom ~15% of the cell. At 80 mA the LDO's dissipation
  is trivial (~70 mW at full charge); the argument for buck-boost here is **runtime, not heat**.
  Rev A: LDO for simplicity; rev B: buck-boost.

### 6.4 Enclosure and mounting

- **Size driven by the 50×50 mm ground plane** [S12] plus the 103450 cell plus connector clearance:
  target **~75 × 58 × 20 mm**. That is very close to a Dragy/RaceBox footprint, which is a good sign.
- **Rev A: 3D print.** The repo already has `hardware/enclosure/` and an OpenSCAD workflow from the
  OBD dongle. **Print in a light colour** — white or light grey — in **ASA or PETG, not PLA.** PLA's
  glass transition is around 60 °C and it *will* sag on a dashboard in July. ASA additionally has the
  UV resistance the windscreen position demands.
- **Base:** flat, wedged ~5–10°, with a recessed 3M Dual Lock SJ3550 pad area and a lanyard loop.
- **Nothing metallic, and no ground plane in the lid**, above the patch.
- **Ingress:** IP-nothing. It lives inside the car. Seal against dust only.
- **Volume (100 units):** the same printed part, or a simple two-part injection mould if unit
  economics ever justify it (they probably will not at 100).

### 6.5 IMU (optional, recommended)

`ICM-42688-P` (TDK InvenSense) or `LSM6DSO32` — 6-DOF, I²C/SPI, low power. Rationale:

- It fills GNSS dropouts (pit lane, bridges, tunnels, the tree line at MotorPark).
- It gives `latG`/`longG`/`yawRateDps` from a **rigidly mounted, known-orientation** sensor instead
  of from a phone in a cradle that vibrates and rotates. The existing `gforceProvider.ts` comment in
  `packages/core/src/telemetry/contracts.ts` documents a portrait-mount assumption that a dash-mounted
  box simply does not need.
- It is how the device knows it is in a session (§6.7).
- RaceBox carries one and puts it in the same message [S1], so the protocol slot already exists at
  payload offsets 68–79.

**Specific part price: UNVERIFIED.** Budget $4–7 @1, $3–5 @100.

### 6.6 Thermal — the real constraint

This is the section most likely to produce a warranty-class failure.

| Fact | Source |
|---|---|
| Car interiors in summer sun "can exceed 60 °C", and dark cars can pass **70 °C** | [S25] |
| Li-ion/Li-Po manufacturers state **60 °C** as the maximum exposure | [S25] |
| Charging Li-Po above ~45 °C is damaging and, above that, unsafe | industry-standard; **cite the selected cell's own datasheet** |
| Self-heating of a 264 mW device in a sealed ~75×58×20 mm plastic box | **+8–15 °C over ambient — UNVERIFIED, must be measured with a thermocouple on the cell** |
| SAM-M10Q / MAX-M10S operating range | **−40 to +85 °C** [S10][S12] — the silicon is not the problem |
| ESP32-C3-MINI-1 | −40 to +85 °C (**UNVERIFIED**, per module datasheet) |

The battery is the weak component, by a wide margin, and a device parked on a windscreen in a
Romanian July is genuinely outside its safe envelope.

**Mitigations, all of which are binding:**

1. **NTC thermistor (10 kΩ B3950, 0603) bonded to the cell**, read by the ESP32-C3 ADC.
2. **Charging is inhibited above 45 °C cell temperature.** Hardware-gated `CE` on the charger, plus a
   firmware interlock. Non-negotiable.
3. **Above 60 °C: stop advertising, shut down cleanly, flash the LED red.** Better to lose the session
   than the car.
4. **Light-coloured, matte enclosure.** A black box on a dash is a solar oven. This is the cheapest
   mitigation available and it is free.
5. **Auto-shutdown on stationary + no client**, copying the RaceBox filter design [S1] — the device
   spends far more of its life parked than driving, and the parked hours are the hot ones.
6. **Tell the user, in the app, once: "take it off the dash when you park."** A product that requires
   this is worse than one that does not, which is why:
7. **Offer a 12 V SKU.** A variant powered from the cigarette lighter / USB port with **no cell at
   all** (or a tiny 100 mAh ride-through) eliminates the thermal problem, the charging problem, the
   fuel-gauge problem and about $12 of BOM. It is what RaceBox did with the Micro (3.5–16 V input,
   reports input voltage rather than battery percent in the same protocol field [S1][S3]). Strongly
   consider making **this** the default SKU and the battery version the accessory, not the reverse.

### 6.7 How the device knows it is in a session

Four-state machine, copying the shape of the RaceBox standalone-recording filters [S1] because they
are a solved, field-proven design:

| State | Entry | Behaviour |
|---|---|---|
| `OFF` | long-press, or auto-shutdown timeout | everything down |
| `IDLE` | power-on | GNSS at 1 Hz (cheap, keeps the almanac hot so TTFF stays at 1 s [S10]), BLE advertising, LED slow blue |
| `ARMED` | 3D fix acquired AND (BLE client connected OR speed > 5 km/h sustained 3 s) | GNSS to 20 Hz, notifications streaming, LED solid green |
| `SESSION` | app sends an explicit "session start", or speed > 30 km/h | as ARMED; if standalone logging is fitted, write to flash |

Auto-shutdown: no motion **and** no BLE client for **15 minutes** → `OFF`. This is both a battery
saver and, per §6.6, a thermal safety feature.

**Do not** try to infer "on track" on the device. The app knows the circuit geometry, the lifecycle
lock and the lap state; the device's only job is to stream honest, well-timestamped samples. Keep the
firmware dumb and the engine in `packages/core`, which is the architecture this repo already has.

---

## 7. The phone side

### 7.1 Transport stack

- **Library: `react-native-ble-plx`** (dotintent). The mature, maintained choice; it is what the Expo
  BLE guide itself uses [S26][S27].
- **Expo integration: `npx expo install react-native-ble-plx` + the config plugin**, which writes
  `NSBluetoothAlwaysUsageDescription` and the background modes into the iOS project at prebuild
  [S26][S28].
  ```json
  ["react-native-ble-plx", {
    "isBackgroundEnabled": true,
    "modes": ["central"],
    "bluetoothAlwaysPermission": "TRACE connects to your GNSS timing device"
  }]
  ```
- **Does this work under Expo with a dev client and Sideloadly? Yes — and this repo has already
  proved the mechanism.** `react-native-tcp-socket` is a third-party native module that is in the
  shipped app today, which means the prebuild → custom dev client → `expo export` → ipa → Sideloadly
  chain already carries arbitrary native modules. BLE adds a permission string and a background mode;
  it does not change the pipeline.
- **UNVERIFIED and a real risk:** `react-native-ble-plx` on **Expo SDK 57 / RN 0.86.2 / React 19.2.3
  with the New Architecture (bridgeless) enabled**. RN has defaulted to bridgeless since 0.76 and
  library compatibility is tracked per-library [S29]. **Spike this before any hardware spend** — see
  §10, risk 3.
- **Background:** enable "Uses Bluetooth LE Accessories", and pass `restoreStateIdentifier` /
  `restoreStateFunction` to the `BleManager` constructor so a backgrounded or relaunched app
  reattaches to the device rather than silently losing the session [S26]. The app already uses
  `expo-keep-awake`, so the screen-on path is covered, but state restoration is what saves a session
  from an incoming phone call.

### 7.2 Protocol client

Implement the **RaceBox protocol** [S1], both because it lets Phase A ship against bought hardware and
because Phase C hardware then inherits a tested client:

- Scan filter: device name prefix, plus the **Nordic UART Service `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`**
  (RX `...0002`, TX notify `...0003`) [S1].
- **Reassemble across notifications.** The specification is explicit: "Do NOT assume that each BLE
  notification contains only one message or that it contains a complete message" [S1]. A ring buffer,
  a `0xB5 0x62` sync hunt, a length check and the two-byte Fletcher checksum [S1]. This is exactly the
  kind of byte-stream framing the repo already does well in `firmware/src/elm_line_parser.c` — and it
  should live in `packages/core` as a pure, unit-tested decoder over `Uint8Array`, not in the mobile
  app.
- Read the **Device Information Service `0x180A`** (model `0x2A24`, firmware revision `0x2A26`) at
  connect, and branch on it [S1]. A TRACE device should report a TRACE model string while keeping the
  same message format — same wire protocol, honest identity.
- **Ignore the NMEA service** (`0x1101`) entirely; the spec warns that running both causes high
  packet loss [S1].

### 7.3 Integration with `LocationProvider`

New file `apps/mobile/src/platform/bleGnssLocationProvider.ts`, implementing the **existing**
`LocationProvider` interface — the same contract `gnssLocationProvider.ts` and
`replayLocationProvider.ts` already satisfy. Nothing in `packages/core`'s timing engine changes.

Mapping from the 80-byte payload [S1] to `LocationSample`:

| `LocationSample` | From | Conversion |
|---|---|---|
| `tMono` | `iTOW` + nanoseconds, via the §5.5 aligner | **never** the arrival time |
| `lat` / `lon` | offsets 28 / 24, Int32 | ÷ 1e7 |
| `accuracyM` | offset 40, UInt32 horizontal accuracy | ÷ 1000 (mm → m) |
| `speedMps` | offset 48, Int32 | ÷ 1000 (mm/s → m/s) |
| `headingDeg` | offset 52, Int32 | ÷ 1e5 |
| `source` | — | `'gnss'` when external-only; `'fused'` only when actually blended (§7.4) |

Also emit, through the **existing** `TelemetrySample` path, at the **same** `tMonoMs`:
`latG` (offset 68 ÷ 1000), `longG` (offset 70 ÷ 1000), `yawRateDps` (offset 78 ÷ 100, with the
sign convention already documented in `packages/core/src/telemetry/contracts.ts:31–48`). Those three
channels exist today and are fed from `expo-sensors`; the device becomes a better source for the
same channels, gated behind the existing `imuFusionEnabled` setting so that every pre-existing
recording and every default install behaves exactly as before.

Gate acceptance on the fix quality the protocol gives you: **Fix Status == 3 (3D) AND Fix Status Flags
bit 0 set** [S1], plus the lat/lon invalid flag at offset 66 bit 0 [S1]. Everything else is a
diagnostic, not a gate.

Reuse the existing diagnostics wholesale: `sampleIntervalHistogramMs` will show a 20 Hz device as a
solid spike in the 0–200 ms bucket, and any BLE stall as a tail. **That histogram is the field-test
instrument for the entire §5 scheme** and it is already written.

### 7.4 Degradation — "never worse off with the device than without it"

This is a product-safety requirement, not a nicety, and it earns explicit state.

| Situation | Required behaviour |
|---|---|
| **Device absent / never paired** | Identical to today. `gnssLocationProvider` runs, `source: 'gnss'`, nothing in the UI changes. No nagging. |
| **Device present, healthy** | External provider is authoritative. Phone GNSS **also runs, at 1 Hz, in the background, purely as a cross-check** (`expo-location` is already running and costs little). Its samples are **not** emitted into the engine. |
| **Device drops mid-session** | Fail over to phone GNSS **within one watchdog period** (`SessionController`'s watchdog is already 5000 ms with a 1000 ms poll). **Never abort the session. Never discard the lap.** Mark the affected lap `degraded` in the session record, show a single non-modal banner, and keep timing. |
| **Device returns** | Re-attach, but **do not switch source mid-lap.** Switch at the next start/finish crossing. A lap whose first half is 20 Hz and second half is 1 Hz is worse than either, and comparing it to other laps is meaningless. |
| **Device and phone disagree** | Cross-check continuously: if \|p_ext − p_phone\| > (accuracy_ext + accuracy_phone + 20 m) for > 2 s, the external device is lying (or is in a different car). Demote to phone GNSS, mark the lap degraded, raise a diagnostic. Do **not** average them. |
| **Device battery < 5%** | Warn the driver **between** sessions, never during a lap. Per the protocol note, disconnect gracefully at 0% unless recording matters [S1]. |
| **Both sources healthy** | Use the external device. Do **not** blend by default. |

**On `source: 'fused'`:** it already exists in the contract, and it is tempting to reach for. Resist
it for rev A. Emit `'gnss'` for external samples and `'gnss'` for phone samples, and record *which
device produced the lap* as lap metadata instead. Reserve `'fused'` for an actual GNSS+IMU tight
coupling if you ever build one. The reason is auditability: when a lap time looks wrong six months
from now, "which sensor produced this?" must have a one-word answer.

**The invariant to write a test for:**

> For every session, the set of laps detected and timed with the external device present must be a
> superset of what would have been detected without it, and no lap may be *lost* because the device
> was present. A device that adds precision but costs you a lap is a net negative.

Make that an explicit test in the mobile test suite, alongside the existing `composition.recovery`
and `composition.lifecycle` tests, which are exactly the right neighbours for it.

---

## 8. Bill of materials and cost

Prices USD, checked 2026-09-21, ex-VAT, ex-shipping, ex-customs. Romania import duty and 19% VAT are
**not** included and are material on a 1-unit order from DigiKey.

### 8.1 Unit 1 — prototype, SAM-M10Q path

| Ref | Part | Source | Unit $ | Note |
|---|---|---|---|---|
| U1 | **SAM-M10Q-00B** GNSS + patch antenna | LCSC C5443880 [S13] | **37.41** | integrated patch + SAW + LNA; the RF risk buy-out |
| U2 | **ESP32-C3-MINI-1-N4** (PCB antenna, 4 MB) | LCSC; C3-MINI-1-H4 is C2934569 at **$2.17** [S30] | **~2.30** | exact N4 C-code **UNVERIFIED**; reuse the code already proven in `hardware/DESIGN.md` |
| U3 | **MCP73831T-2ACI/OT** Li-Po charger | DigiKey **$0.76** [S21] / LCSC C424093 [S22] | **0.76** | R_PROG 2 kΩ → 500 mA |
| U4 | LDO 3.3 V, low-Iq, 300 mA (rev A) | LCSC basic part | 0.30 | rev B: TPS63020-class buck-boost [S24] |
| U5 | IMU, ICM-42688-P class | — | **~5.00** | **price UNVERIFIED**; optional for rev A |
| BT1 | Li-Po 2000 mAh, 103450, PCM, JST-PH | — | **~10.00** | **SKU UNVERIFIED**; must have a datasheet stating 60 °C discharge / 45 °C charge |
| J1 | USB-C receptacle, 16-pin SMD | LCSC basic | 0.50 | + 2× 5.1 kΩ CC |
| RT1 | NTC 10 kΩ B3950 0603 | LCSC basic | 0.05 | bonded to the cell |
| — | Passives, 2× LED, tact switch, DNP SAW + u.FL footprints | LCSC basic | ~4.00 | |
| — | PCB, JLCPCB 2-layer, 5 pcs min | JLCPCB | ~5.00 total | ~$1/board |
| — | JLCPCB assembly setup + extended-part fees | JLCPCB | **~30–60** | dominates a 1-unit order |
| — | Enclosure, 3D printed ASA | in-house | ~3.00 | |
| | **Parts subtotal** | | **≈ $60** | ≈ $55 without the IMU |
| | **Delivered cost of unit 1** | | **≈ $95–130** | with assembly setup + enclosure, ex-VAT/shipping |

### 8.2 100 units — MAX-M10S path

| Ref | Part | Source | @100 $ |
|---|---|---|---|
| U1 | **MAX-M10S-00B** | Symmetry **$9.70** / DigiKey **$10.12** @100 [S15]; LCSC $9.81 [S13] | **9.70** |
| A1 | Passive ceramic patch, 25×25 mm, L1 | **SKU UNVERIFIED** | ~1.50 |
| U2 | ESP32-C3-MINI-1 | LCSC $2.08–2.17 [S30] | 2.10 |
| U3 | MCP73831T-2ACI/OT | LCSC C424093 [S22] | ~0.50 |
| U4 | Buck-boost / LDO | | ~0.80 |
| U5 | IMU | **UNVERIFIED** | ~4.00 |
| BT1 | Li-Po 2000 mAh 103450 | **UNVERIFIED** | ~4.50 |
| — | USB-C, NTC, passives, LEDs, switch | | ~2.00 |
| — | PCB + JLCPCB assembly @100 | | ~4.00 |
| — | Enclosure | | ~3.00 |
| | **Total @100** | | **≈ $32** (≈ $28 without IMU) |

**If you keep SAM-M10Q at 100 units** (i.e. never retire the RF risk): **≈ $59/unit**. The $27 delta
per unit — **$2,700 across the run** — is what a competent RF bring-up on MAX-M10S is worth. Do the
bring-up on rev B with both footprints on one board and a u.FL escape, and you get to decide with
measurements instead of opinions.

### 8.3 What you are competing against, at retail

| Product | Price | Note |
|---|---|---|
| Dragy DRG70-C | **$159** [S4] | 25 Hz, u-blox M10 ("10th gen") [S4] |
| RaceBox Mini | ~$199 [S3] | 25 Hz + IMU, open protocol [S1] |
| RaceBox Mini S | **$199–266** [S3] | + 1100 mAh / 20 h, standalone recording [S3] |
| Vgate iCar Pro BLE 4.0 (OBD) | $26–34 [S7] | the BLE ELM327 you should buy |
| Veepeak OBDCheck BLE (OBD) | ~$32 [S8] | ditto |

At **$32 BOM at 100**, a $150 retail price would carry a healthy margin. **But that is not the
business.** The device exists to make TRACE better than a phone-only app; building 100 of them is a
decision about a *hardware business*, and it should be taken on its own merits, separately.

---

## 9. What this beats, and what it does not

### 9.1 It beats, decisively

- **The iPhone's own GPS.** 1 Hz [S31] vs 20 Hz; derived speed vs 0.05 m/s Doppler [S10];
  windscreen-attenuated phone antenna vs a horizontal patch on a 50 mm ground plane. §3.1 quantifies
  it: **lap-to-lap repeatability from roughly ±50–80 ms to ±5–15 ms.** That is the whole reason to
  build it, and it is real.
- **Any lap timer that is phone-only.** This is most of the App Store.

### 9.2 It matches

- **Dragy and RaceBox Mini/Mini S, on the GNSS spec** — because it would be the same u-blox M10
  silicon [S4][S11]. There is no secret in the box. Where they win is enclosure tooling, QA, firmware
  maturity, warranty, an established app, and years of field data.

### 9.3 It does not beat

- **Racelogic VBOX / VBOX Sport class.** Dual-band, higher-grade antennas, tight GNSS+IMU Kalman
  coupling, 100 Hz IMU, and a decade of motorsport validation. Different price tier, different
  product.
- **Anything with a real timing beacon.** An optical/IR beacon at start/finish gives millisecond
  crossings that no GNSS receiver at any price matches. If absolute lap-time truth is the goal, a
  beacon beats this device for less money.
- **A commercial unit on cost of *your time*, at quantity 1.** A RaceBox Mini S costs $199–266 [S3],
  arrives next week, and has a published protocol [S1]. Unit 1 of a TRACE device costs $95–130 in
  parts *plus* weeks of firmware, board bring-up, RF debugging and enclosure iteration. **At quantity
  1, buying is unambiguously correct.** This is the single strongest argument for the Phase A / B / C
  staging in §0.

### 9.4 The strategic point — do I agree?

> *"A GPS-only competitor structurally cannot read brake pressure, throttle and rpm off the car, and
> this device plus a cheap OBD adapter can."*

**Substantially yes, with one correction and one caveat that matters more than the claim.**

**Where it is right.** A GPS box is a kinematic sensor. It can infer that you decelerated; it can
never know *pedal force*, *pedal travel*, *throttle plate vs pedal*, *rpm*, *gear*, *coolant*,
*oil temp*, or *steering*. The distinction between `throttlePct` (plate) and `accelPedalPct` (pedal)
that this repo already discovered empirically on the Supra — documented right there in
`packages/core/src/telemetry/contracts.ts:5–9` — is exactly the kind of thing a GPS-only device is
structurally blind to, and it is precisely the thing a coach cares about. The field work behind
`brakeSwitch` (0x29/0x500C) and `brakePct` (0x12/0x58B7) on the B58 is a genuine asset that no GPS
box can replicate.

**The correction.** "GPS-only competitor" undersells the competition. **RaceBox Pro accepts a BLE
OBD-II adapter and records rpm, throttle and temperatures itself** [S32]. **RaceChrono Pro** has
supported RaceBox Mini plus a separate OBD adapter for years [S2], and RaceChrono users routinely run
exactly the iPhone + RaceBox + OBDLink MX+ stack this design proposes [S2]. The combination is
therefore **not a moat**. It is table stakes among the serious tools, and TRACE is currently *behind*
on the GNSS half of it.

**The caveat, which is the actually important point.** What RaceChrono gives you is a *graph*. What
the Phase-5a deterministic coaching engine in `packages/core` gives you is a **per-corner,
RO/EN, plain-language observation with named channels and an audit trail** — and it is on-device,
session-scoped, with a safety validator. *That* is the differentiator. The hardware is the
**precondition** for it being credible, not the differentiator itself. A brilliant coaching engine
fed 1 Hz phone GPS will produce confidently wrong statements about where a driver braked; the same
engine fed 20 Hz Doppler-quality data will not.

So the correct framing is:

> **The GNSS device is not the product and it is not a moat. It is the instrument that makes the
> product's claims true.** Build it (or buy it) for that reason, and do not let it become the
> roadmap.

And one more time, because §5.8 says it and it belongs here too: **the fused brake-vs-position claim
is limited by the OBD clock at ±30–60 ms, not by the GNSS clock at ±3 ms.** The combination is real
and valuable. It is not as precise as the GNSS spec sheet invites you to believe.

---

## 10. Risks, ranked, each with a mitigation

### Risk 1 — The fused data overpromises, and the product's credibility goes with it
**Likelihood: high. Impact: severe.**
GNSS aligns at ±3 ms; OBD at ±30–75 ms (§5.8). A coaching app that draws a brake-release marker at
10 cm resolution on a corner map is lying, and an experienced driver will catch it on the first
track day. Credibility, once lost with that user, does not come back.
**Mitigation:** (a) implement the speed-cross-correlation lag calibration in `packages/core` and run
it every session; (b) carry a time-uncertainty figure alongside every fused derived quantity and have
the deterministic engine refuse to emit a claim finer than it; (c) show the driver the actual
uncertainty in the UI, once, honestly. An app that says "brake point ±2 m" is *more* trustworthy than
one that says "brake point" and is silently wrong.

### Risk 2 — Buy-vs-build: the hardware never ships, and the app stalls waiting for it
**Likelihood: high. Impact: high.**
Unit 1 costs more than a RaceBox and takes months. Hardware projects absorb unbounded time, and this
one sits on the critical path of a feature (high-rate timing) that the app needs *this season*.
**Mitigation:** the Phase A/B/C staging in §0. Buy a RaceBox Mini S now, implement its public
protocol [S1], ship the accuracy win in weeks with zero hardware risk, and let Phase C be a
genuinely optional hardware project that inherits a tested client. **This mitigation costs $200 and
retires most of the risk in this document.**

### Risk 3 — BLE under Expo 57 / RN 0.86 / New Architecture, on a sideloaded iPhone
**Likelihood: medium. Impact: high (blocks everything).**
`react-native-ble-plx` compatibility with RN 0.86.2 bridgeless is **UNVERIFIED** [S29]. Sideloadly
adds a 7-day re-sign cycle on top. A native-module incompatibility discovered *after* hardware exists
is the worst possible ordering.
**Mitigation:** **spike it first, before spending a cent on hardware.** A throwaway dev client that
scans, connects to any BLE peripheral and reads a characteristic is a day of work and it is a hard
gate on the whole project. Fallback if BLE is blocked: the ESP32-C3 SoftAP + TCP path the repo
**already has working** in `firmware/src/wifi_ap.cpp` and `elm_server.cpp` — at the cost of the
WiFi-OBD conflict in §2.3, meaning the OBD adapter would then have to be BLE, which the app also
does not yet support. Neither fallback is free; verify early.

### Risk 4 — GNSS performance shortfall on a first-spin board
**Likelihood: medium (low if SAM-M10Q, high if MAX-M10S). Impact: medium.**
A 2.4 GHz radio 25 mm from a 1575 MHz front end, on a 2-layer board, designed without a spectrum
analyser. Symptom: C/N0 several dB below a reference receiver, longer TTFF, fix loss under trees.
**Mitigation:** SAM-M10Q for rev A (integrated antenna + SAW + LNA [S12], nothing to get wrong);
≥ 50×50 mm ground plane [S12]; ≥ 25 mm module separation; DNP footprints for an external SAW [S14]
and a u.FL escape; and an explicit **acceptance test**: park next to a bought RaceBox/Dragy for
10 minutes, log both, and require median C/N0 within 2 dB and TTFF within 5 s. No RF lab needed —
just a reference device you already bought in Phase A.

### Risk 5 — Thermal / battery on a summer windscreen
**Likelihood: medium-high (it is Romania, in July). Impact: high (safety, not just function).**
Interiors exceed 60–70 °C [S25]; Li-Po's ceiling is 60 °C [S25]; self-heating adds an **UNVERIFIED**
8–15 °C. A swollen or vented cell on a customer's dashboard is a product-ending event.
**Mitigation:** the full §6.6 list — NTC, hard charge-inhibit above 45 °C, shutdown above 60 °C,
light matte ASA enclosure, aggressive auto-shutdown, explicit user guidance. **And seriously consider
making the 12 V-powered, battery-free SKU the default**, which deletes this risk outright along with
~$12 of BOM.

### Risk 6 — Metallised windscreen kills reception at the intended mounting position
**Likelihood: medium. Impact: medium.**
Athermic/IR-reflective screens are common on recent European-market cars and attenuate L1 badly.
**UNVERIFIED** for the 2026 GR Supra.
**Mitigation:** measure C/N0 dash vs roof on day one of Phase B — a 6+ dB delta settles it. Design the
enclosure with an SMA/u.FL bulkhead option from the start, so a roof-mount active antenna
(Taoglas AA.171 class, ~$63 [S18]) is a $63 accessory rather than a board respin.

### Risk 7 — Regulatory, if this is ever sold rather than used
**Likelihood: low while personal; certain if sold. Impact: medium.**
A product with a 2.4 GHz radio placed on the EU market needs RED (2014/53/EU) conformity assessment
and CE marking. Using a **pre-certified module** (ESP32-C3-MINI-1 carries module-level approvals)
substantially reduces but **does not eliminate** the obligation on the finished product.
**Mitigation:** use only pre-certified radio modules; keep the module's reference antenna and layout
keep-outs exactly as the datasheet specifies; do not sell until assessed. For personal and
prototype use this is a non-issue — but decide *before* the 100-unit order, not after.

### Risk 8 — Yet another device to charge, pair and not forget
**Likelihood: high. Impact: low-medium, but corrosive.**
Products die of friction. A driver who forgets to charge the box, or who spends five minutes pairing
in the paddock, will stop using it.
**Mitigation:** auto-connect on sight with no pairing dialog (BLE GATT needs no bonding for this);
never block the session on the device (§7.4); surface battery level in the app from the protocol field
at offset 67 [S1]; and, again, **the 12 V SKU makes this risk disappear entirely.**

---

## 11. Recommended plan

| Step | Deliverable | Gate to pass before the next step |
|---|---|---|
| **0** | BLE spike: throwaway Expo 57 dev client, `react-native-ble-plx`, scan + connect + notify, installed via Sideloadly on the real iPhone | It connects and receives notifications on the actual device. **Hard gate — no hardware spend before this passes.** |
| **1** | Buy one **RaceBox Mini S** (~$199–266 [S3]) and one **Vgate iCar Pro BLE 4.0** (~$34 [S7]) | Hardware in hand |
| **2** | `packages/core`: pure RaceBox UBX frame decoder + `gnssClockAligner` (§5.5) + OBD lag cross-correlator (§5.8), all unit-tested to the repo's existing standard | Tests green, Codex 0 HIGH, per the standing no-build-without-final-verification rule |
| **3** | `apps/mobile`: `bleGnssLocationProvider`, failover state machine (§7.4), degraded-lap marking | The §7.4 invariant test passes |
| **4** | **Track day at Transilvania Motor Ring**: BLE GNSS + WiFi ENET concurrently. Log `sampleIntervalHistogramMs`, `observedHzByChannel`, and phone-vs-device position delta | Measured numbers for every **UNVERIFIED** item in §13 that a track day can close |
| **5** | Decide, on data, whether Phase C hardware is worth building at all | — |
| **6** | *(if yes)* rev-A board: SAM-M10Q + ESP32-C3, both footprints, u.FL escape, DNP SAW. 5 boards, JLCPCB | C/N0 within 2 dB of the RaceBox reference (Risk 4 acceptance test) |
| **7** | *(if yes)* firmware speaking the RaceBox protocol verbatim, validated against **both** TRACE and RaceChrono | Both apps see it as a valid device |

---

## 12. Sources

- **[S1]** RaceBox BLE Protocol Documentation, Revision 9 — https://www.racebox.pro/products/mini-micro-protocol-documentation — NUS UUIDs `6E400001/2/3-B5A3-F393-E0A9-E50E24DCCA9E`; DIS `0x180A`; UBX framing `0xB5 0x62`, Fletcher checksum; RaceBox Data Message class `0xFF` id `0x01`, **80-byte payload**, "up to 25 times per second"; field table and worked example (Time Accuracy **25 ns**); MTU/connection-interval and reassembly guidance; GNSS Platform Config `0xFF 0x27` (dynamic model 4 = automotive, 8 = >300 kph); standalone data rates 25/10/5/1/20 Hz; stationary / no-fix / auto-shutdown filters; battery field at offset 67. *(Retrieved and text-extracted 2026-09-21.)*
- **[S2]** RaceChrono — "RaceChrono Pro v7.5 now supports RaceBox Mini", https://racechrono.com/article/3004 ; supported-receiver list at https://racechrono.com/support ; community stack write-up https://alexcena.net/2026/02/22/complete-track-day-data-system-racechrono-mxplus-racebox-gopro/
- **[S3]** RaceBox Mini S product page, https://www.racebox.pro/products/racebox-mini-s — 25 Hz, GPS/GLONASS/Galileo/BeiDou, BT 5.2, 1100 mAh / up to 20 h, 6-DOF IMU, >2 h @25 Hz internal storage. Pricing $199–266 via Walmart / LITPro listings.
- **[S4]** Dragy DRG70-C, https://www.amazon.com/dp/B0BQ6DWMLT — "up to 25Hz GPS Laptimer, Upgraded UBLOX 10th Gen"; pricing $159 (realstreetperformance.com), $179 elsewhere.
- **[S5]** Car Scanner — "Configuring Bluetooth 4.0 (LE) connection on iPhone/iPad", https://www.carscanner.info/ios-bt4/ — iOS supports only BLE (4.0+) or WiFi adapters; Classic is not supported.
- **[S6]** AsTools — ELM327 pairing guide, https://www.astools.eu/blogs/obd-cables-adapters/elm327-connect-phone-pairing-guide — Apple restricts Classic SPP to MFi accessories; "blocks 90% of the cheap ELM327 dongles"; sub-$10 clones have incomplete protocol support.
- **[S7]** Vgate iCar Pro BLE 4.0 — https://www.vgatemall.com/products-detail/i-9/ and Amazon B06XGB4873 — $26–34.
- **[S8]** Veepeak OBDCheck BLE — https://veepeak.com/products/obdcheck-ble — ~$32; BLE+ ~$42.
- **[S9]** OBDadvisor ELM327 guide, https://obdadvisor.com/elm327/
- **[S10]** u-blox **MAX-M10S Data sheet UBX-20035208 R08** (30-Jan-2026), https://content.u-blox.com/sites/default/files/MAX-M10S_DataSheet_UBX-20035208.pdf — max nav update rate (high-performance) 20 Hz GPS+GAL / 16 Hz GPS+GAL+GLO; CEP 1.5 m; velocity accuracy 0.05 m/s; dynamic heading 0.3°; cold start 23–28 s, hot start 1 s; time pulse 30 ns RMS / 60 ns 99%; tracking current 8 mA (GPS+GAL, 3.0 V), acquisition 10 mA; "25 mW in continuous tracking"; −40…+85 °C; pinout incl. TIMEPULSE, LNA_EN, VCC_RF. *(Downloaded and text-extracted 2026-09-21.)*
- **[S11]** u-blox Information Note **UBX-23006557**, "u-blox M10 platform offers up to 25 Hz navigation update rate" (10 July 2023), https://content.u-blox.com/sites/default/files/documents/u-bloxM10-with-25Hz-Navigation-UpdateRate_IN_UBX-23006557.pdf — the 18→25 / 10→20 / 10→16 / 5→10 Hz table; applies to MAX-M10S, MAX-M10M, MIA-M10Q, SAM-M10Q, UBX-M10050-KB on ROM SPG 5.10; **no firmware update required**, configured via UBX messages. *(Downloaded and text-extracted 2026-09-21.)*
- **[S12]** u-blox **SAM-M10Q Data sheet UBX-22013293 R05**, https://content.u-blox.com/sites/default/files/documents/SAM-M10Q_DataSheet_UBX-22013293.pdf — 20 Hz GPS+GAL / 16 Hz +GLO / 10 Hz 4-GNSS default; CEP 1.5 m; 0.05 m/s; 0.3°; **integrated front-end SAW + LNA**; 15×15 mm patch; **"On a 50 × 50 mm² ground plane"**; time pulse 30 ns RMS; tracking 8 mA GPS+GAL; −40…+85 °C. *(Downloaded and text-extracted 2026-09-21.)*
- **[S13]** LCSC — MAX-M10S-00B **C4153167** (from $9.8054), SAM-M10Q-00B **C5443880** (from $37.4083).
- **[S14]** u-blox **MAX-M10S Integration manual UBX-20053088**, https://content.u-blox.com/sites/default/files/MAX-M10S_IntegrationManual_UBX-20053088.pdf — RF front end matched to 50 Ω with DC block, LTE-B13 notch, LNA, SAW; **internal LNA has enough gain for passive antennas**; active antenna may be fed from VCC_RF; **external SAW recommended where other radio systems share the design**.
- **[S15]** DigiKey MAX-M10S-00B (PN 15712906) **$11.42 @1**, ~12,467 in stock; Octopart @100: DigiKey $10.12, Braemac/Symmetry $9.70, Arrow/Verical $10.84, Future $11.41. https://octopart.com/part/u-blox/MAX-M10S-00B
- **[S16]** NEO-M9N-00B ≈ $12.10 (distributor listings via Octopart / Richardson RFPD).
- **[S17]** Quectel — L76-K ~$12.50–15.90 (LCSC); LC76G NMEA 10 Hz max; LC29H series spec, https://www.mouser.com/datasheet/2/1052/Quectel_LC29H_Series_GNSS_Specification_V1_3-3009838.pdf ; LC29HEA field reports, https://rtklibexplorer.wordpress.com/2024/04/28/dual-frequency-rtk-for-less-than-60-with-the-quectel-lc29hea/
- **[S18]** Taoglas **AA.171** MagmaX, GPS/GLONASS/Galileo/BeiDou magnetic-mount active patch, IP67, 3 m RG-174, SMA(M), front-end SAW — https://www.taoglas.com/product/magmax-aa-171-gpsglonassbeidou-antenna-2/ ; ~$63.14 via westwardsales.com. Embedded alternatives: ADFGP.25A / AGGBP.25A.
- **[S19]** Silicon Labs, "Selecting Suitable Connection Parameters for Apple Devices", https://docs.silabs.com/bluetooth/9.1.1/mobile-apps-suitable-connection-parameters/ — Apple Accessory Design Guidelines: **interval min ≥ 15 ms and a multiple of 15 ms**; 7.5 ms requests rejected; supervision timeout 6–18 s; peripheral latency ≤ 30 intervals; 30 ms may be offered instead of 15 ms.
- **[S20]** Car Scanner, "Optimizing connection speed", https://www.carscanner.info/optimizing-connection-speed/ — ELM327 practical throughput **5–10 PIDs/s** (⇒ ~100–200 ms per request); ATST timeout trade-off.
- **[S21]** DigiKey MCP73831T-2ACI/OT (PN 964301 / 1979972) — **$0.76**.
- **[S22]** JLCPCB part listing, MCP73831T-2ACI/OT = LCSC **C424093**, https://jlcpcb.com/partdetail/MicrochipTech-MCP73831T_2ACIOT/C424093
- **[S23]** SparkFun Qwiic Fuel Gauge MAX17048, **$5.95**, https://www.sparkfun.com/qwiic-fuel-gauge-max17048.html ; IC datasheet https://www.analog.com/en/products/max17048.html
- **[S24]** TI TPS63020 buck-boost, https://www.ti.com/product/TPS63020
- **[S25]** EBL, "Lithium-Ion Battery Safe Temperature Range", https://www.eblofficial.com/blogs/battery-101/lithium-ion-battery-temperature-range — interiors exceed 60 °C, dark cars >70 °C, manufacturers state 60 °C max exposure. Corroborated by https://www.candlepowerforums.com/threads/how-hot-is-too-hot-in-a-car-lithium-ion-rechargeable.484928/
- **[S26]** dotintent/react-native-ble-plx, https://github.com/dotintent/react-native-ble-plx and docs https://dotintent.github.io/react-native-ble-plx/ — iOS background: "Uses Bluetooth LE Accessories" + `restoreStateIdentifier` / `restoreStateFunction`.
- **[S27]** Expo blog, "How to build a Bluetooth Low Energy powered Expo app", https://expo.dev/blog/how-to-build-a-bluetooth-low-energy-powered-expo-app
- **[S28]** `@config-plugins/react-native-ble-plx`, https://github.com/expo/config-plugins/blob/main/packages/react-native-ble-plx/README.md — `isBackgroundEnabled`, `modes`, `bluetoothAlwaysPermission`; requires prebuild.
- **[S29]** reactwg/react-native-new-architecture, "Library support for New Architecture + Bridgeless", https://github.com/reactwg/react-native-new-architecture/discussions/167 ; react-native-ble-plx new-arch issue #1277, https://github.com/dotintent/react-native-ble-plx/issues/1277
- **[S30]** LCSC — ESP32-C3-MINI-1-H4 **C2934569** $2.1680; ESP32-C3-MINI-1U-N4 **C2911374** from $2.284; ESP32-C3-MINI-1-H4X **C41349510** from $2.0829.
- **[S31]** Apple Developer Forums, "iPhone GPS or Location Update Rate?", https://developer.apple.com/forums/thread/722855 and https://developer.apple.com/forums/thread/5521 — the iOS GPS update rate is 1 Hz and `kCLLocationAccuracyBestForNavigation` does not change it; deferred updates still deliver at 1 Hz.
- **[S32]** iobd.io, "Racebox Pro is an equivalent to Dragy and RaceLogic", https://iobd.io/racebox-pro — RaceBox Pro accepts a BLE OBD2 adapter and records rpm, throttle opening and temperatures.
- **[S33]** Open-source prior art on ESP32: anchit92/ESP32-RaceBox-mini-Emulator (88-byte packet, 25 Hz, ESP32 + u-blox M10 + MPU6050), https://github.com/anchit92/ESP32-RaceBox-mini-Emulator ; renatobo/bonogps (ESP32 GPS logger with BLE / BT / WiFi phone interfaces), https://github.com/renatobo/bonogps — **both are directly reusable references for Phase C firmware.**

---

## 13. UNVERIFIED register

Everything below is an assumption, not a fact. Each row names the measurement that closes it.

| # | Claim | How to close it |
|---|---|---|
| 1 | GNSS module current at **20 Hz** (budgeted 30 mA; datasheets give 8 mA at default rate [S10][S12]) | Bench: current probe on VCC, 1 Hz vs 20 Hz |
| 2 | ESP32-C3 BLE average current at 15 ms interval, 2.2 kB/s (budgeted 40 mA) | Bench, connected to the actual iPhone |
| 3 | iOS BLE→JS delivery jitter, and the resulting **±2–5 ms** alignment residual (§5.6) | Log `(iTOW, p_i)` pairs for 10 min and plot the lower envelope |
| 4 | Actual connection interval iOS grants (15 vs 30 ms) [S19] | BLE sniffer, or infer from the arrival-time histogram |
| 5 | 2.4 GHz WiFi(OBD) ↔ BLE(GNSS) coexistence penalty on the iPhone (§2.5) | A/B a session: BLE-only vs BLE+WiFi-AP; compare `sampleIntervalHistogramMs` and `observedHzByChannel` |
| 6 | **ENET/DoIP round-trip latency** on the Supra, and therefore the real OBD timestamp error (§5.8) | Instrument `enetSession`; log send/recv deltas per DID |
| 7 | Residual OBD jitter **after** speed cross-correlation calibration (claimed ±15–30 ms) | Lag-calibrate over a lap, then check the residual against a known event (brake switch vs longitudinal g) |
| 8 | Lap-to-lap repeatability **±5–15 ms** at 20 Hz (§3.1) — the headline claim | 10 consecutive clean laps, same line; compute the σ of the crossing |
| 9 | Windscreen attenuation on the 2026 GR Supra (athermic glass?) | C/N0 on the dash vs on the roof, same 10-minute window |
| 10 | `react-native-ble-plx` on Expo 57 / RN 0.86.2 / React 19.2.3 bridgeless [S29] | **The Step-0 spike. Hard gate.** |
| 11 | Enclosure self-heating (+8–15 °C assumed) | Thermocouple on the cell, device running, in a car in the sun |
| 12 | 2000 mAh 103450 Li-Po cell **SKU** with a datasheet stating 60 °C discharge / 45 °C charge | Distributor datasheet before ordering |
| 13 | Passive 25×25 mm L1 patch antenna **SKU** at ~$1.50 @100 | Distributor selection + gain/return-loss datasheet |
| 14 | IMU part number and price (ICM-42688-P class, $4–7 assumed) | Distributor quote |
| 15 | MAX17048 bare-IC price; BQ25185 / BQ24074 price | Distributor quote |
| 16 | ESP32-C3-MINI-1-**N4** LCSC C-code (the existing `hardware/DESIGN.md` gives C3013922, which search indicates is the **1U-H4** variant) | LCSC lookup — reconcile with `hardware/DESIGN.md` before ordering |
| 17 | ESP32-C3-MINI-1 operating temperature range (−40…+85 °C assumed) | Espressif module datasheet |
| 18 | Maximum simultaneous BLE peripherals on iOS (assumed ≫2) | Connect GNSS + OBD + anything else and observe |
| 19 | ZED-F9P price (~$150+, quoted only to dismiss it) | Not worth closing |
| 20 | Whether cheap WiFi ELM327 adapters support 5 GHz (assumed not) | Per-model datasheet, only if the coexistence penalty (row 5) proves material |
