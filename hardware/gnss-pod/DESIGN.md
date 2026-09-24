# TRACE GNSS Pod — Design proposal (rev 0.1, 2026-09-23)

A windscreen-mounted GNSS + IMU unit that gives TRACE the position, speed and
G-forces a phone cannot, and that pairs with a cheap BLE OBD adapter so engine
data lands on the same clock. Rev 0 is a PROPOSAL: architecture and part
candidates, plus the spike that has to run before any PCB. Every electrical
fact below is either sourced (§9) or marked **VERIFY** — the rev-A3 rule of
`hardware/DESIGN.md` §8 applies here too: no from-memory electrical facts in a
board that gets ordered.

## 1. What we are matching, and where we can beat it

Benchmark: **dragy Pro** (godragy.com, USD 249): u-blox 10th-gen GNSS, "up to
25 Hz", GPS/GLONASS/Galileo/BeiDou L1, 6-axis IMU, 128 MB storage, BLE,
magnetic windscreen mount, 12 h battery at 25 Hz (30 h at 10 Hz). It talks to
RaceChrono and others.

It is sold with a companion **dragy OBD II adapter** (godragy.com/dragy-obd,
the "dragy Motorsport" pairing): Bluetooth 5.0, marketed as "up to 200 Hz"
ECU data ("all channels up to 200 times per second", Amazon listing; the
conditions — per channel or total, which protocols — are not published).
Pre-order USD 49 (list 119). Its own page states it **requires a dragy GPS
unit**, that its Ultra-Fast and Fast modes work **only inside the dragy app**
(third-party apps get standard BLE OBD modes), that custom PIDs are a future
update, and that it is optimised for CAN cars. So the competitor is a
GPS + fast-OBD pair, not a GPS alone.

The "25 Hz" has a condition the box does not print. u-blox's own note
UBX-23006557 gives the M10 platform's maximum navigation rate:

| Constellations | GPS only | GPS+GAL | +GLO | +BDS (4) |
|---|---|---|---|---|
| Max rate | **25 Hz** | 20 Hz | 16 Hz | 10 Hz |

So 25 Hz means GPS-only, which is fewer satellites and worse position under
trees and grandstands. Where TRACE can honestly be better:

1. **Rate chosen per use, not per brochure.** Default 20 Hz GPS+Galileo on
   circuits (two constellations, still 20 Hz); 25 Hz GPS-only offered for
   drag/0-100 runs where the sky is open and rate matters most.
2. **G-forces measured, not differentiated from GPS.** IMU sampled at
   ≥400 Hz in the pod, low-pass filtered and fused with GNSS velocity in the
   pod, streamed at 50–100 Hz. Mounting orientation is solved automatically
   (gravity at rest + first straight-line acceleration gives the car frame),
   the same idea core's `imu/` Madgwick path already uses on the phone.
3. **Car data on the same clock.** The pod reads the OBD adapter itself
   (§3), so RPM/throttle/speed samples carry pod timestamps, not
   phone-reception timestamps. Whether dragy fuses on the phone or in the
   GPS unit is not published; we do it in the pod, against the GNSS PPS.
4. **Dual-band later without redesigning the product.** u-blox F11
   (dual-band L1/L5, up to 25 Hz single-GNSS / 10 Hz three-GNSS) has a
   MAX-F11N module expected Q4 2026 (CNX, 2026-07-06). Rev B can take it if
   its footprint and rates hold up — **VERIFY** pin/footprint compatibility
   with MAX-M10S before promising a drop-in.
5. **Rate parity on OBD needs our own adapter, not a clone.** A generic
   ELM327 clone cannot approach "200 Hz" (§6). The competitive tier is the
   TRACE CAN dongle (rev A4, `hardware/DESIGN.md`) speaking raw CAN to the
   ECU with no ELM327 ASCII layer, reached over BLE by the pod. The V03H4
   stays as the cheap entry tier.

## 2. Why a separate pod, not GNSS inside the OBD dongle

- The OBD port sits under the dashboard: no sky view, and a metal-and-glass
  cabin above it. GNSS there loses satellites exactly in corners.
- An IMU must be rigidly fixed to the body. An OBD plug wobbles in its
  socket, so the "G-force" it would measure is partly plug rattle.
- The windscreen gives sky view and a rigid mount. The pod lives there; the
  OBD adapter stays cheap and dumb.

## 3. Architecture: the pod is the hub

```
 [iKiKin V03H4]  --BLE (ELM327 over GATT UART)-->  [ TRACE Pod ]  --BLE-->  [ Phone / TRACE app ]
   ELM327 v1.5, BT 4.0                              GNSS 20-25 Hz          one fused stream
   (or: MHD / TRACE WiFi dongle --WiFi STA-->)      IMU >=400 Hz           one pairing
                                                    flash log              phone WiFi stays free
```

The pod is a BLE **central** towards the OBD adapter and a BLE **peripheral**
towards the phone at the same time. Alternatives considered:

| Option | For | Against | Verdict |
|---|---|---|---|
| Phone connects to pod AND adapter separately | Simplest pod firmware | Two pairings; OBD timestamped on phone reception (BLE jitter); iOS throttles BLE when screen locks | Spike only (P0), not product |
| **Pod is hub** | One clock, one pairing, pod logs even if phone sleeps, can also bridge WiFi adapters | Pod firmware speaks ELM327 | **Chosen** |
| GNSS inside OBD dongle | One device | §2: no sky, no rigid mount | Rejected |

**Owner decision 2026-09-24: the product will NOT use the MHD adapter.** The MHD WiFi bridge below is therefore a development convenience for the owner's own car only, not a product requirement; WiFi can stay off in product firmware (which also lowers the GNSS coexistence risk, DESIGN-REV-A §10A test 4). For rev B, weigh a BLE-only MCU (e.g. nRF52840) against the ESP32-S3 for battery life once rev A power is measured. Original rev-A note, kept for history: **The MHD WiFi bridge is a rev A requirement.** The owner's car (Supra B58)
runs on the MHD WiFi adapter today (ENET/HSFZ, already supported by the app;
the brake switch 0x29/0x500C and brake pressure 0x12/0x58B7 were found through
it). Today the iPhone has to join the MHD WiFi and loses internet. With the
pod as a WiFi station on the MHD network, the phone keeps its own connection
and only talks BLE to the pod. MHD/ENET covers BMW-platform cars only, so it
is the owner's reference path, not the any-car answer (that is §6).

**Time base.** The GNSS time pulse (1 PPS, TIMEPULSE pin) disciplines the
pod's microsecond clock. Every GNSS epoch, IMU FIFO sample and OBD response
gets a pod timestamp; OBD samples also carry the request→response latency so
the app can place them at mid-flight. This is what makes "car data on the same
clock" true rather than approximately true.

## 4. Part candidates (rev A)

| Function | Candidate | Why | Status |
|---|---|---|---|
| GNSS | u-blox **MAX-M10S** | 25/20/16/10 Hz per §1 table, L1, ~25 mW tracking, 1.5 m CEP (datasheet UBX-20035208), stock part | Rates sourced; footprint/antenna design VERIFY |
| GNSS antenna | Ceramic patch 18×18 or 25×25 mm on the pod's ground plane | Size vs gain trade-off decides pod thickness | VERIFY gain/axial ratio; ground-plane size |
| IMU | ST **LSM6DSV16X** (alt. Bosch BMI270; automotive-grade alt. ST ASM330LHHX) | 6-axis, ±16 g, FIFO with timestamps | ALL VERIFY — chosen on criteria, not from a datasheet yet |
| MCU + radio | Espressif **ESP32-S3-MINI-1** | BLE 5 central+peripheral concurrently, WiFi for the MHD bridge, same toolchain as the rev-A4 dongle firmware | VERIFY concurrent-role limits; alt. nRF52840 if battery life wins over WiFi |
| Log storage | SPI NAND 1 Gbit (e.g. W25N01GV) | ~12–13 MB/h at full rate (§5) → ~10 h at 128 MB, far more at 1 Gbit | VERIFY part + wear handling |
| Power | USB-C 5 V + 1-cell LiPo 600–1000 mAh + charger IC | Car-powered by default, battery for pit walks and grid | Charger IC VERIFY |
| Mount | Magnetic windscreen mount (Dragy-style) | Rigid, removable | Mechanical design in P2 |

## 5. Data budget

- GNSS: 25 Hz × ~100 B (UBX-NAV-PVT) ≈ 2.5 kB/s raw; ~1 kB/s packed.
- IMU: 400 Hz × 12 B ≈ 4.8 kB/s raw in the pod; streamed at 100 Hz ≈ 1.2 kB/s.
- OBD: entry tier <20 samples/s (negligible); competitive tier up to ~200
  samples/s × ~8 B ≈ 1.6 kB/s.
- Stream to phone ≈ 2.5–5 kB/s: fine over BLE (2M PHY gives tens of kB/s).
- Log ≈ 3.5–5 kB/s ≈ 12.6–18 MB/h.

## 6. The cheap OBD adapter: what to expect honestly

The **iKiKin V03H4** (ELM327 v1.5, Bluetooth 4.0, "no master chip") is a
clone. Clones commonly manage only a handful of standard-PID round trips per
second in total, so RPM/throttle/vehicle speed/coolant would each arrive at a
few Hz. Brake pressure and steering angle are not standard PIDs at all.

Two OBD tiers, therefore:

| Tier | Adapter | Expected rate | Role |
|---|---|---|---|
| Entry | iKiKin V03H4 (any BLE ELM327) | a few Hz per channel — MEASURE | Cheapest bundle; any car |
| Competitive | TRACE CAN dongle, BLE variant | raw CAN request/response, no ELM layer; target ≥100 Hz total on CAN cars — MEASURE | Answer to dragy OBD's "200 Hz" |

The dongle's rev A4 speaks WiFi (SoftAP + ELM327 subset). For the pod
pairing it needs a BLE link instead: the ESP32-C3 already has BLE, so this is
a firmware change plus a native binary protocol, not a new board — **VERIFY**
that the rev-A4 antenna/layout is fine for BLE use (same 2.4 GHz radio).
**Baseline already measured (MHD, Supra B58).** The Signal Finder exports in
`data/field/signal-finder/` record the app's own `measuredReqPerSec` over the
MHD ENET adapter: 36–45 requests/s total on 2026-08-30/31 (one UDS DID per
request; ~27–30/s counting timeouts), 12–15/s in two sessions on older builds
or one outlier. So MHD ≈ 40 reads/s shared across all polled channels —
about 10 Hz per channel when four channels are polled. That is the number the
competitive tier has to beat (dragy claims "200 Hz"). Measured while the
Signal Finder rotated through 12–48 DIDs; re-measure with a fixed telemetry
poll list in P0b.

**Measure the V03H4's real PID/s in P0 before designing anything around a
number**, and benchmark against a dragy OBD if one can be borrowed.

BLE ELM327 clones usually expose a UART-like GATT service (often FFE0/FFE1)
— **VERIFY on the actual unit**, service UUIDs vary between clones.

## 7. App impact

- New BLE transport: `react-native-ble-plx` (config plugin; the app already
  runs on `expo-dev-client` with native modules such as
  `react-native-tcp-socket`, so this fits the existing build).
- New `LocationProvider` fed by the pod at 20–25 Hz. Core's timing path was
  tuned on ~1 Hz phone fixes; crossing interpolation, the quality gate, Doppler
  speed and the pit logic must be re-validated at 25 Hz (replay fixtures at
  25 Hz first, then field).
- IMU channels from the pod replace the phone accelerometer when present;
  the phone path stays for tier 0 (no hardware).
- The ELM327 session code in `packages/core/src/telemetry/elm327Session.ts`
  can be reused unchanged in the P0 phone-direct spike.

## 8. Plan

| Phase | What | Exit criterion |
|---|---|---|
| **P0 spike** (no PCB) | Buy: V03H4, MAX-M10S breakout, LSM6DSV16X breakout, ESP32-S3 devkit, patch antenna. App: BLE transport. Measure V03H4 PID/s phone-direct; stream breadboard pod at 20/25 Hz; one driveway + one circuit session vs phone GPS | Real numbers for PID/s, BLE rate, lap-time repeatability 25 Hz vs phone |
| P0b OBD rate | First on MHD (no new hardware: existing ENET transport + known Supra DIDs), measure reads/s phone-direct and then through the breadboard pod as WiFi station. Then rev-A4 dongle firmware: BLE + raw CAN polling (read-only guard unchanged) | Measured numbers for MHD and for our dongle, next to dragy's "200 Hz" |
| P1 PCB rev A | Schematic + 4-layer board (GNSS RF needs a solid ground), JLCPCB assembly | ERC/DRC clean, Codex hardware review 0 HIGH (same bar as the dongle) |
| P2 enclosure | Slim shell + magnetic mount, antenna window | Fits, rigid, no GNSS gain loss vs breadboard |
| P3 firmware | Hub, PPS time base, fusion, logging, OTA | Field session: fused stream, OBD on pod clock |

Not before Monday's MotorPark session (28 Sep): that one runs build 14 with
phone GNSS as planned.

## 9. Sources

- dragy Pro product page: https://www.godragy.com/dragy-pro/
- u-blox UBX-23006557, "u-blox M10 platform offers up to 25 Hz navigation
  update rate" (rate table in §1)
- u-blox MAX-M10S data sheet UBX-20035208 (25 mW tracking, 1.5 m CEP)
- CNX Software, 2026-07-06, "u-blox F11 low-power dual-band GNSS chips and
  modules" (F11 rates, MAX-F11N Q4 2026)
- Quectel LG290P product page (quad-band RTK, up to 20 Hz, 12.2×16 mm):
  considered and parked — RTK needs a correction source, overkill for rev A
- iKiKin V03H4 listing (owner-supplied specs: ELM327 v1.5, Bluetooth 4.0)
- dragy OBD II page: https://www.godragy.com/dragy-obd/ (BT 5.0, USD 49
  pre-order / 119 list, requires dragy GPS, fast modes dragy-app-only,
  custom PIDs future)
- dragy OBD II Amazon listing (the "200 Hz ... all channels" claim):
  https://www.amazon.com/Dragy-dragy-OBD-High-Performance-II/dp/B0DSV31WRQ
