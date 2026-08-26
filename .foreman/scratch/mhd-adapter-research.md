# MHD Adapter & BMW S55 Oil Temperature Research

**Date:** 2026-08-27  
**Status:** DONE_WITH_CONCERNS  
**Confidence Levels:** Mixed; MHD adapter specs partial; S55 OBD DIDs NOT FOUND in public sources.

---

## Summary Table

| Question | Finding | Source | Confidence |
|----------|---------|--------|-----------|
| **Q1: MHD ELM327-compatible?** | NOT stated; official page claims "supports MHD, BimmerCode/BimmerLink, xHP, Protool, Bimmer-Tool, and **other tuning apps**" but no explicit ELM327 claim | [mhdtuning.com](https://mhdtuning.com/pages/mhd-wireless-adapter) | Medium |
| **Q1: WiFi Protocol & Port** | WiFi SSID: `MHD_XXXX` (password `MHD_ENET`); assigned IP: `169.254.x.x /24`; **TCP port NOT documented**; web UI: `http://192.168.4.1/` | [MODE Auto Concepts](https://modeautoconcepts.com/en-us/pages/mhd-adapter-wifi-network-settings); [MHD manual](https://manuals.plus/mhd-tuning/obd2-flasher-wifi-enet-module-manual) | Medium |
| **Q2: Single client enforced?** | YES: "only one connection to the ECU is supported. If you try connecting to the ECU while one device is already connected, it freezes the other connection" | [SpoolStreet Forums MHD Wifi thread](https://spoolstreet.com/threads/mhd-wifi.4992/page-11) | High |
| **Q3: S55 Engine Oil Temp PID/DID** | **NOT FOUND in public docs.** E46 reference: mode-22 req `12050b031f` → byte 12, decode: `(val × 0.796098) − 48.0137` (E46 only; no S55 equivalent located). MHD's S55 Monitor lists "Oil Temperature" as available parameter but **does not disclose the underlying OBD DID/PID**. | [github.com/tomicooler/bmwe46oil](https://github.com/tomicooler/bmwe46oil); [MHD S55 Monitor](https://mhdtuning.com/products/s55-monitor-license) | Low |
| **Q3: S55 DCT Oil Temp DID** | **NOT FOUND.** Forums confirm F87 M2 DCT can be monitored via "BMW-capable OBD2 scanner" but **specific DID/mode-22 values absent from all sources**. | [Bimmerfest, Bimmerpost F87 threads](https://www.bimmerfest.com/threads/reading-dct-transmission-fluid-temperature.1308869/) | Low |
| **Q4: PID 0x5C supported on S55?** | **NOT SUPPORTED.** Generic OBDII mode-01 PID 0x5C is the standard, but BMW DME responds "invalid request" to standard OBD PIDs. Oil temp requires **BMW proprietary protocols (DS2/KWP2000 or CAN-bus broadcast)**. | [E46 Fanatics](https://www.e46fanatics.com/threads/oil-temperature-via-obd.1106967/); [Wikipedia OBD-II PIDs](https://en.wikipedia.org/wiki/OBD-II_PIDs) | High |

---

## Detailed Findings

### 1. MHD WiFi Adapter — ELM327 Compatibility & Third-Party Apps

**Official Statement (MHD Tuning Website):**
> "Supports MHD (all versions), BimmerCode / BimmerLink, xHP and xDelete, Protool, Bimmer-Tool… **and other tuning apps**."

- **Not explicitly ELM327-compliant** but explicitly lists third-party compatibility
- Does NOT mention ELM327 in the compatibility matrix
- Acts as a BMW ENET/CAN WiFi bridge (not a raw ELM327 serial passthrough)
- **Confidence: Medium** — exact protocol/wire format not documented publicly

### 2. WiFi Network Defaults

**Documented Settings:**
- **SSID:** `MHD_XXXX` (adapter-specific suffix; e.g., `MHD_A1B2C3`)
- **WiFi Password:** `MHD_ENET`
- **IP Assignment:** Link-local `169.254.x.x /255.255.0.0` (APIPA)
- **Web UI Port:** `http://192.168.4.1/` (management interface)
- **TCP OBD Port:** **NOT DOCUMENTED** — Mode Auto Concepts page and official manual do not specify a port number

**Sources:**
- MODE Auto Concepts: "The WiFi Network (SSID) is MHD_XXXX with password MHD_ENET… IP settings show 169.254.x.x address and a 255.255.0.0 Subnet Mask."
- MHD Manual (manuals.plus): Confirms SSID search for `MHD_XXXX` but no port specified

### 3. Single-Client Connection Requirement

**CONFIRMED:** SpoolStreet Forums, MHD Wifi thread page 11:
> "You can connect to the adapter with multiple devices, but **only one connection to the ECU is supported**. If you try connecting to the ECU while one device is already connected, it freezes the other connection."

**Impact:** User must disconnect the MHD app before connecting a third-party tool (BimmerCode, BimmerLink, Torque, etc.) — no simultaneous dual-app access.

---

### 4. BMW S55 Oil Temperature — OBD Access

**Status: SEVERE DOCUMENTATION GAP**

#### What IS Known:

1. **MHD S55 Monitor** lists "Oil Temperature" and "Transmission Temperature" as available parameters in the live-gauge UI (`50+ engine parameters`), but **does not document the underlying DID or how to request it**.

2. **BimmerLink** (via Bimmerpost) offers S55 oil temperature monitoring ("BimmerLink provides... oil temperature or boost pressure"), but specific OBD DID not disclosed.

3. **E46 Reference (oldest documented BMW oil temp OBD access):**
   - Mode-22 protocol, Motronic ECU
   - Request bytes: `12 05 0b 03 1f`
   - Response: 45 bytes, oil temp at byte index 12
   - Decode: `(raw_byte × 0.796098) − 48.0137` → °C
   - **NOTE:** E46 is 2000–2006; S55 is 2015+ F80/F82/F87. Protocol may differ significantly.

4. **Standard OBD Mode-01 PID 0x5C:** 
   - Is the generic OBD-II standard for engine oil temperature
   - **BMW does NOT implement it** — DME responds "invalid request"
   - Requires proprietary BMW DS2/KWP2000 or CAN-bus access instead

#### Why S55 DIDs Are Not Public:

- BMW does not publish OBD diagnostics in service bulletins (reverse-engineering only)
- MHD, BimmerLink, and INPA guard proprietary DID mappings (competitive IP)
- Accessed via manufacturer-locked tools or dealership software

---

### 5. BMW DCT (ZF 8HP) Transmission Oil Temperature

**Status: NOT FOUND**

- F87 M2 Competition uses BMW M DCT (dual-clutch; 7-speed, later versions have 8-speed ZF)
- Forums confirm "BMW-capable OBD2 scanner can monitor live transmission fluid temperature"
- **Specific Mode-22 DID values for DCT oil temp: ABSENT from all public sources**
- Transmission ECU is addressed separately (likely different CAN header/ATSH than DME)
- **Recommendation:** Check BMW TIS (Technical Information System) or dealership ISTA documentation

---

## Conclusions & Caveats

1. **MHD Adapter is NOT a generic ELM327 device** but explicitly supports multiple BMW tuning apps. Exact protocol (pure ENET pass-through vs. proprietary gateway) unconfirmed.

2. **WiFi defaults are documented (SSID, IP, password)** but **no TCP port is publicly specified**. May require reverse engineering (e.g., Wireshark capture) or contacting MHD support.

3. **Single-client ECU connection enforced** — user must disconnect MHD app to use BimmerCode/Torque/BimmerLink.

4. **S55 Oil Temperature OBD DID is NOT PUBLICLY DOCUMENTED.** MHD and BimmerLink have access (shown in their monitoring UIs) but do not release the underlying DID/PID or request format.

5. **Standard OBD Mode-01 PID 0x5C does NOT work on BMW S55** (or E46–G-series in general). BMW requires DS2/KWP2000 or CAN-bus protocols.

6. **DCT Transmission Oil Temp DID also not in public sources** — likely available via BMW TIS subscription or dealership software only.

---

## Recommended Next Steps

- Contact MHD Tuning support for TCP port and protocol details
- Obtain BMW Technical Information System (TIS) access for S55/M DCT DIDs
- Reverse-engineer with Wireshark/OBD logger while MHD app is live if DIDs are critical
- Check BimmerLink/BimmerCode GitHub repositories for hardcoded DID constants (unlikely but possible)

---

**Sources:**
- [MHD Tuning — Wireless Adapter](https://mhdtuning.com/pages/mhd-wireless-adapter)
- [MODE Auto Concepts — MHD WiFi Settings](https://modeautoconcepts.com/en-us/pages/mhd-adapter-wifi-network-settings)
- [MHD Manual — OBD2 Flasher WiFi ENET Module](https://manuals.plus/mhd-tuning/obd2-flasher-wifi-enet-module-manual)
- [MHD S55 Monitor License](https://mhdtuning.com/products/s55-monitor-license)
- [SpoolStreet Forums — MHD Wifi (page 11)](https://spoolstreet.com/threads/mhd-wifi.4992/page-11)
- [E46 Fanatics — Oil Temperature via OBD](https://www.e46fanatics.com/threads/oil-temperature-via-obd.1106967/)
- [GitHub — tomicooler/bmwe46oil](https://github.com/tomicooler/bmwe46oil)
- [Bimmerfest — OBD2 CAN Reader Oil Temp](https://www.bimmerfest.com/threads/obd2-can-reader-oil-temp.1474660/)
- [Bimmerpost F87 — Reading DCT Transmission Fluid Temperature](https://www.bimmerfest.com/threads/reading-dct-transmission-fluid-temperature.1308869/)
- [Wikipedia — OBD-II PIDs](https://en.wikipedia.org/wiki/OBD-II_PIDs)
