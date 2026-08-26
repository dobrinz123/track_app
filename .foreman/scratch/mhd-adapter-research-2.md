# MHD Adapter & 2026 Toyota GR Supra A90 (BMW B58 / ZF 8HP) Research

**Date:** 2026-08-27  
**Vehicle:** 2026 Toyota GR Supra MK5 (A90/J29), BMW B58 engine, ZF 8HP automatic  
**Adapter:** MHD WiFi Adapter ("OBD2 Flasher WiFi ENET Module")  
**Status:** RESEARCH COMPLETE — KEY FINDINGS BELOW

---

## Summary Table

| Question | Finding | Source | Confidence |
|----------|---------|--------|-----------|
| **Q1: MHD is ENET, not ELM327?** | **YES, confirmed ENET only.** NOT ELM327 compatible. Uses EDIABAS/ENET protocol (different from ELM327). Manual shows TCP/UDP but NO ELM327 mode. Supports BimmerCode, BimmerLink, xHP, Protool, Bimmer-Tool. | [MHD official](https://mhdtuning.com/pages/mhd-wireless-adapter), [ediabaslib ENET doc](https://github.com/uholeschak/ediabaslib/blob/master/docs/ENET_WiFi_Adapter.md), [MHD manual](https://manuals.plus/mhd-tuning/obd2-flasher-wifi-enet-module-manual), [forum](http://forum.gps-laptimer.de/viewtopic.php?t=5876) | **High** |
| **Q2: BimmerLink supports A90 Supra?** | **YES, confirmed.** BimmerLink officially supports A90/A91 Supra via ENET adapters (MHD, Bootmod3, KIES, AMHTDOL, OBDLink MX+). BimmerCode A90 page lists "oil temperature transmission temperature" as available. | [BimmerCode A90 official](https://bimmercode.app/vehicles/toyota/supra/a90/), [MHD official](https://mhdtuning.com/pages/mhd-wireless-adapter), [Amazon ENET adapters](https://www.amazon.com/AMHTDOL-Bootmod3-Compatible-BimmerCode-Bimmerlink/dp/B0C2461DQ6) | **High** |
| **Q3: B58 Oil Temp DID (0x22)?** | **NOT FOUND in public sources.** MHD Monitor confirms 50+ parameters including oil temperature monitored on B58 Supra, but underlying DID/request bytes NOT disclosed. Operating range: ~232°F (111°C) nominal. E46 reference: mode-22 req `12050b031f` → index 12, decode `(val × 0.796098) − 48.0137`, but S55/B58 DID unknown. | [MHD B58 Monitor](https://mhdtuning.com/products/b58-monitor-license), [Bimmerpost B58 threads](https://g20.bimmerpost.com/forums/showthread/2052475/m340i-b58-oil-temperature), [E46 reference](https://github.com/tomicooler/bmwe46oil) | **Low** |
| **Q4: ZF 8HP Trans Oil Temp DID?** | **NOT FOUND in public sources.** Operating range: 175–212°F (79–100°C) normal. BimmerLink and OBD Fusion can read trans oil temp but ECU address/DID codes not publicly documented. No confirmation of 0x18/0x19 addressing found. | [ZF aftermarket](https://aftermarket.zf.com/us/aftermarket-portal/for-workshops/useful-tips/transmission/transmission-oil-change-for-passenger-cars/), [Jeep forums](https://www.jeepgarage.org/threads/transmission-oil-temperatures.71455/page-4), [Bimmerfest](https://www.bimmerfest.com/threads/f30-zf-8hp45-automatic-transmission-fluid-service-60k-80k-100k-never.1395939/) | **Low** |
| **Q5: Standard OBD Mode-01 PIDs (0x0C/0x05/0x0D/0x11/0x5C)?** | **NOT CONFIRMED for standard mode-01 support.** Torque requires custom PIDs for Supra; forums indicate manufacturer-specific PIDs needed. No evidence that Supra responds to standard mode-01. | [Torque Pro forums](https://torque-bhp.com/community/main-forum/mode-01-pid-problem/), [SupraMKV](https://www.supramkv.com/threads/whats-the-pid-for-flex-fuel-tune-e.11454/), [OBD-II standard](https://en.wikipedia.org/wiki/OBD-II_PIDs) | **Low** |

---

## Detailed Findings

### 1. MHD WiFi Adapter Protocol: ENET vs. ELM327

**Official Statement (MHD Tuning):**
> "The universal adapter supports two critical protocols: **ENET** for F/G series BMW and Supra models; **CAN** for E-series vehicles."

**Explicit Non-Support of ELM327:**
- MHD forums and Harry's GPS Suite forum explicitly confirm MHD is **NOT ELM327 compatible**
- EDIABAS/ENET protocol is "suitable for ECU flashing but **not for OBD reading**" (generic mode-01 OBD)
- The adapter is an ENET/CAN bridge, not a serial/OBD passthrough like ELM327

**Protocol Specifications:**
- Wireless: 2.4GHz 802.11b/g/n
- Protocols: PPPOE, TCP, UDP, DHCP, DNS, HTTP (per manual)
- SSID: `MHD_XXXX`, WiFi password: `MHD_ENET`, link-local IP: `169.254.x.x`
- **TCP port for OBD NOT documented** (likely undisclosed or custom)

**Compatible Tuning Apps:**
- MHD (all versions)
- BimmerCode / BimmerLink
- xHP, xDelete
- Protool, Bimmer-Tool
- **Does NOT list generic Torque, Car Scanner, ELM327-compatible apps**

**Conclusion:** MHD WiFi is ENET-only; it is NOT an ELM327 adapter and cannot operate in ELM327/AT-command mode.

---

### 2. BimmerLink Support for Toyota GR Supra A90

**Confirmed Support:**
- **BimmerCode official page** (bimmercode.app/vehicles/toyota/supra/a90/) explicitly lists Supra A90 as supported
- Lists available features: "oil temperature, transmission temperature" + coding options
- BimmerLink is the companion diagnostics app for real-time monitoring

**Compatible Adapters for A90 + BimmerLink:**
1. **MHD WiFi ENET Adapter** — ENET bridge, supports BimmerCode/BimmerLink
2. **Bootmod3 WiFi ENET Adapter** — 2020+ Supra A90/A91, BimmerCode/BimmerLink compatible
3. **KIES WiFi ENET Adapter** — F/G Series + A90/A91 Supra, BimmerCode compatible
4. **AMHTDOL Bootmod3 Adapter** — BimmerCode, BimmerLink, iOS/Android/Windows
5. **OBDLink MX+ (MX201)** — Bluetooth/WiFi, full ECU access for A90 Supra

**MHD's Explicit Supra Support:**
- Multiple vendors (Burger Motorsports, Kies, SPEED LOGIC, Graveyard Performance) sell "MHD WiFi for Supra A90"
- MHD B58 Monitor License explicitly available for "B58 Supra, M340i, 340i, 440i"
- MHD Super Tuning License marketed for "B58 Supra"

**Conclusion:** BimmerLink fully supports A90 Supra; MHD WiFi Adapter is compatible via ENET protocol.

---

### 3. Toyota GR Supra A90 / BMW B58 — Oil Temperature DID

**What IS Known:**
- MHD Monitor supports 50+ engine parameters for B58, including **oil temperature**
- B58 nominal operating temperature: **~232°F (111°C)**
- BimmerLink can display real-time oil temperature for Supra
- **UNDERLYING DID/PID NOT DISCLOSED in any public source**

**Historical Reference (E46, NOT applicable to Supra):**
- E46 (2000–2006) Motronic: Mode-22 request `12 05 0b 03 1f`
- Response: 45 bytes, oil temp at index 12
- Decode: `(raw_byte × 0.796098) − 48.0137` → °C
- **E46 ≠ B58 (different era, engine, protocols)**

**Why DIDs Remain Private:**
- MHD, BimmerLink, BMW proprietary — reverse-engineering only
- Not published in BMW service bulletins
- Competitive IP guarded by tuning software vendors

**Confidence: LOW** — DIDs not publicly available; must obtain from MHD/BMW sources or reverse-engineer.

---

### 4. ZF 8HP Transmission — Oil Temperature DID

**Confirmed Operating Range:**
- Normal: **175–212°F (79–100°C)**
- Service check temperature: **30–40°C max**
- Thermostatic bypass valve regulates cooler

**What IS Known:**
- Transmission oil temperature can be read via **BimmerLink** and **OBD Fusion**
- ISTA+ provides transmission balancing procedures requiring oil temp
- Transmission ECU is separate from engine DME

**What IS NOT Known:**
- Specific **ECU address** (no confirmation of 0x18/0x19)
- **DID/Mode-22 request format**
- **Decode formula**
- **Transmission ECU header** for Supra ZF 8HP

**Confidence: LOW** — DIDs accessible via OEM diagnostics only; not publicly documented.

---

### 5. Supra A90 & Standard OBD Mode-01 PIDs (0x0C/0x05/0x0D/0x11/0x5C)

**Standard OBD-II Mode-01 PID Reference:**
- PID 0x0C: Engine RPM
- PID 0x05: Engine Coolant Temperature
- PID 0x0D: Vehicle Speed
- PID 0x11: Throttle Position
- PID 0x5C: **Oil Temperature** (standard, NOT always implemented)

**Supra A90 Support: UNCLEAR**
- Torque Pro forums indicate custom CAN-based PIDs required for Supra
- Standard mode-01 support NOT explicitly confirmed or denied
- BMW engines historically do NOT support standard mode-01 PIDs 0x5C for oil temp
- Would require actual OBD query on the vehicle to confirm

**Similar Vehicle Pattern:**
- BMW vehicles (including those using B58) require **proprietary DS2/KWP2000 or CAN diagnostics**, not standard OBD-II mode-01
- Supra may inherit this limitation due to BMW ECU hardware

**Confidence: LOW** — No definitive test report found; empirical vehicle testing needed.

---

## Critical Gaps in Public Documentation

1. **B58 Oil Temperature DID Request Bytes** — MHD knows it, won't publish
2. **ZF 8HP Trans Oil Temp ECU Address & DID** — Not in public BMW docs; likely in ISTA+ only
3. **Supra Standard Mode-01 PID Support** — No published compatibility matrix found
4. **MHD WiFi OBD Port Number** — ENET protocol used but TCP port unspecified
5. **Supra A90 Custom PID Database** — No centralized Torque Pro database for A90 published

---

## Recommendations

1. **For Oil Temperature Logging:**
   - Use MHD Monitor or BimmerLink (they have the DIDs)
   - Do NOT attempt to reverse-engineer DIDs without Wireshark CAN capture

2. **For Generic OBD Access:**
   - MHD WiFi Adapter is NOT suitable for generic ELM327 tools (Torque, Car Scanner)
   - Use OBDLink MX+ if you need ELM327-compatible adapter for Supra

3. **For DIDs:**
   - Contact MHD support directly for B58 oil temp DID
   - BMW TIS/ISTA+ subscription required for official ZF 8HP trans temp DID

4. **For Testing Standard PIDs:**
   - Query PID 0x00 on Supra to see supported mode-01 PIDs
   - Expect manufacturer-specific PIDs instead of standards

---

## Sources

- [MHD Tuning — Wireless Adapter](https://mhdtuning.com/pages/mhd-wireless-adapter)
- [MHD Tuning — B58 Monitor License](https://mhdtuning.com/products/b58-monitor-license)
- [MHD Tuning Manual — OBD2 Flasher WiFi ENET Module](https://manuals.plus/mhd-tuning/obd2-flasher-wifi-enet-module-manual)
- [BimmerCode Official — Toyota Supra A90 Support](https://bimmercode.app/vehicles/toyota/supra/a90/)
- [EDIABAS Library — ENET WiFi Adapter Docs](https://github.com/uholeschak/ediabaslib/blob/master/docs/ENET_WiFi_Adapter.md)
- [Harry's GPS Suite Forum — MHD vs ELM327](http://forum.gps-laptimer.de/viewtopic.php?t=5876)
- [Bimmerpost — B58 Oil Temperature](https://g20.bimmerpost.com/forums/showthread/2052475/m340i-b58-oil-temperature)
- [GitHub — BMW E46 Oil Temperature Reference](https://github.com/tomicooler/bmwe46oil)
- [ZF Aftermarket — 8HP Operating Specs](https://aftermarket.zf.com/us/aftermarket-portal/for-workshops/useful-tips/transmission/transmission-oil-change-for-passenger-cars/)

**END OF REPORT**
