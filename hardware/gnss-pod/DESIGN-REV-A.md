# TRACE GNSS Pod — Hardware Design rev A (BINDING, 2026-09-24)

This is the binding design for the first GNSS Pod PCB. It builds on the rev-0.1
proposal (`hardware/gnss-pod/DESIGN.md`) and uses the same format as the OBD
dongle design (`hardware/DESIGN.md`). The dongle's §8 rule applies in full:
**no from-memory electrical facts.** Every pin map, value and LCSC number below
was checked against the live datasheet or LCSC/JLCPCB page on 2026-09-24, and
the URL is listed in §12. The few items that could not be checked from text are
marked **VERIFY-AT-LAYOUT** (§11.3). The layout worker must close those before
the board is ordered.

Workers turn this document into the schematic and a KiCad 2-layer PCB with
JLCPCB assembly. The schematic and PCB must match the netlist in §4 exactly.
No KiCad files are part of this document.

## 1. Architecture

```
USB-C (5 V, native USB) ──► U7 ESD ──► U4 BQ24073 power-path charger ──► VSYS (4.4 V on USB / VBAT on battery)
                                          │ BAT ◄──► J2 1-cell LiPo (3-pin JST-PH: BAT+, BAT−, pack NTC → TS)
                                          │                └──► U6 XC6206 (always on) ──► VBCKP ──► U2 V_BCKP
VSYS ──► U5 TLV75733P 1 A LDO (EN ← SW3 slide switch) ──► 3V3 ──► U1 ESP32-S3-MINI-1-N8
                                                             ├──► U2 SAM-M10Q (VCC + V_IO)
                                                             └──► U3 LSM6DSV16X (Vdd + Vdd_IO)
U2 UART  ◄──► U1 UART1 (GPIO38 TX / GPIO39 RX)   U2 TIMEPULSE ──► U1 GPIO21 (PPS)
U3 I2C 400 kHz ◄──► U1 (GPIO9 SDA / GPIO10 SCL)   U3 INT1 ──► U1 GPIO8 (INT2 NC)
U1 USB (GPIO19 D- / GPIO20 D+) ──► USB-C: flashing, serial console, power
U1 GPIO37 (CHG_EN) ──► Q1 ──► U4 CE (charging off unless the MCU enables it)   U4 TS ──► U1 GPIO6 (ADC)
```

There is no external NAND (that is rev B), no CAN and no USB-UART bridge.

## 2. Decisions on the open points (and why)

| Point | Decision | Why (source) |
|---|---|---|
| Board size | **50 × 66.95 mm** (review fix: the 5.05 mm ESP32 antenna end overhangs the 72 mm envelope, §8), not ~50 × 40 | u-blox IM §4.4: the module goes "in the middle of a 50 x 50 mm GND size board", "significant degradation … smaller than 40 x 40 mm²", and "not to place anything closer than 10 mm to each edge". A 15.5 mm module plus 10 mm on every side already needs a 35.5 × 35.5 mm clear square. That leaves no room for the ESP32 (15.4 × 20.5 mm) at the far end of a 40 mm board. **The lead's ~50 × 40 target cannot meet the manual, see §10.1.** |
| GNSS ground plane | Full 50 × 50 mm GNSS zone plus the electronics zone (50 × 66.95 total copper) | u-blox allows a larger plane ("A larger ground plane can be used"). The datasheet sensitivity is specified "on a 50 x 50 mm² ground plane" (DS footnote 12). **Expected penalty from board size: none relative to the datasheet.** The real penalties come from the enclosure, the windscreen and the ESP32 radio (§10). |
| Layer count | **2-layer**, 1.6 mm FR-4 | Neither manual requires 4 layers. SAM-M10Q has an integrated antenna, so there is no 50 Ω RF trace. The ESP32-S3-MINI-1 carries its own RF. USB: Espressif's layout guide asks for a parallel, equal-length differential pair at 90 Ω ±10 % over continuous reference copper with minimal transitions. Rev A meets all of that except the impedance (review fix wave, §8 "USB pair"): 90 Ω is not practical on 1.6 mm 2-layer FR-4, and whether full-speed (12 Mbit/s) over ~25 mm of uncontrolled-impedance pair enumerates reliably is **unvalidated**: §10A test 1 decides it. The IM layout example is a solid top-layer ground with short top-layer supply and digital lines, which a 2-layer board can do. The bottom layer stays solid GND under the whole GNSS zone (§8). 4-layer is a drop-in upgrade with the same schematic if bring-up shows GNSS C/N0 loss (§10.3). |
| Charger | **TI BQ24073RGTR** (power-path, TS/NTC input) | Power-path (DPPM plus battery supplement) runs the pod from USB with a flat or missing cell. There is 6.6 V input OVP. The TS pin reads the **10 kΩ NTC inside the battery pack** (TI: "Connect the TS input to the NTC thermistor in the battery pack") through J2 pin 3 and suspends charging outside the NTC window (≈ 0–50 °C for a 103AT-type B ≈ 3435 K NTC, ≈ 3.5–47 °C for a B ≈ 3950 K pack NTC, §10.4). That matters for a LiPo behind a windscreen. The '73 variant regulates OUT at 4.4 V. The '75 variant regulates at 5.5 V, which is the TLV757P's absolute input limit and would triple LDO heat on USB. |
| 3.3 V LDO | **TI TLV75733PDYDR**, 1 A, SOT-23-5 with thermal pad | Espressif requires ≥ 0.5 A supply capability (module DS Table 6-2, "Current delivered by external power supply 0.5 A min"). The module's worst-case peak is 355 mA (802.11b at 20.5 dBm). A 1 A LDO with 1.2 A minimum current limit gives about 2× margin on the LDO itself (the USB input path is the tighter limit, see the next rows and §7). Dropout for the DYD package at 1 A is **450 mV max (−40…+85 °C) / 500 mV max (−40…+125 °C)** (SBVS322C §5.5); at the ~0.4 A real peak it is proportionally lower (PMOS in dropout ≈ resistor). Estimate only (not proven): scaling the dropout suggests 3.3 V holds down to VBAT ≈ 3.75 V at a 1 A burst (≈ 3.5 V at 0.4 A), before the charger's BAT→OUT FET, cell and wiring resistance, capacitor derating and the LDO's transient response, none of which is bounded here. Espressif's current figures are at 3.3 V / 25 °C, not an operating-corner budget. The firmware low-battery cutoff (§10.5) is therefore a starting point that §10A test 2 must confirm or raise. The DYD package is 92.5 °C/W JEDEC against 231 °C/W for DBV. **No JLCPCB basic LDO qualifies.** The only basic 1 A part is AMS1117-3.3 (C6186), whose ~1 V dropout does not work from one LiPo cell. |
| V_BCKP | **Dedicated always-on XC6206P332MR (basic) from VBAT, via 0 Ω R17** | The SAM-M10Q backup domain keeps RTC and orbits (IM §4.1.3) and costs 28 µA typ in hardware backup mode (DS Table 15). Tying V_BCKP to the switched 3V3 rail gains nothing, because it dies with VCC. A supercap only lasts hours: 0.1 F from 3.3 V to 1.65 V at 28 µA is ~1.6 h. A 1 µA-Iq LDO from the cell keeps hot/warm-start data for months. That means fast fix acquisition at the track even after the pod sat switched off overnight. The cost is ~3 µA extra. R17 lets it be cut for current measurements. |
| Power switch | **SPDT slide switch SW3 drives the LDO EN pin** (ON = VSYS, OFF = GND) | The switch carries no load current, so a tiny THT switch is fine. **Review rev2:** charging now runs only while the MCU is powered and enables it (CE supervision, §4 CHG_CE/CHG_EN): with SW3 OFF the 3V3 domain is off, Q1's gate is held low and the charger stays disabled. To charge, leave SW3 ON (the firmware then decides, §6). The BQ24073 still powers the system from USB with charging disabled. SYSOFF-style battery cut (BQ24075) was rejected: TI states that with SYSOFF high "When an adapter is connected, charging is also disabled", so a switched-off pod would not charge. |
| Battery divider | **1 MΩ / 1 MΩ, unswitched, 100 nF hold cap, to GPIO1 (ADC1_CH0)** | 4.2 V → 2.1 V, inside ADC ATTEN3's 0–2900 mV "effective measurement range" (S3 DS). It draws 2.1 µA at 4.2 V, about 30 years to drain 600 mAh, so a MOSFET switch buys nothing. It must be ADC1: "ADC2 … cannot be used with Wi-Fi simultaneously" (S3 DS §4.2.2.1). Source impedance 500 kΩ × max 50 nA leakage (module DS IIL) is ≤ 25 mV. Calibrate once. The 100 nF gives τ = 50 ms, fine for ≤ 1 Hz sampling. |
| Input current mode | **USB500 fixed** (EN1 = VSYS, EN2 = GND) | USB-C sink with Rd only: the default USB current is the only guaranteed budget. USB500 limits the input at **450 mA min / 475 typ / 500 max** (BQ DS I_INmax). Without a battery that covers the ~380 mA steady 3V3 peak (355 + 20 mA) but **not** the ~480 mA worst case (GNSS inrush during a full-power WiFi TX burst): with no cell fitted, VSYS can dip in that coincidence and the ESP32 may brown out. On USB alone the design therefore does **not** guarantee Espressif's ≥ 0.5 A supply capability; with a cell, battery-supplement mode covers the bursts. Firmware cannot change the input limit in rev A (§10). |
| Charge current | **R9 = 3.3 kΩ → I_CHG = 890 A·Ω / 3300 Ω ≈ 270 mA typ** (241–295 mA over K_ISET 797–975) | ≤ 0.5 C for any cell ≥ 540 mAh. The target cell is 600–1000 mAh. |
| GNSS I2C | **Not connected** (UART only) | SAM-M10Q I2C is "peripheral mode with a maximum clock frequency of 320 kHz" (DS §5.2). Sharing the IMU bus would cap the IMU below its 400 kHz. |
| PPS pin | **GPIO21** | SAM-M10Q "SAFEBOOT_N pin is internally connected to TIMEPULSE pin through a 1 kΩ series resistor". The IM says "Do not drive the TIMEPULSE pin low at startup because it will put the receiver in safeboot mode". The S3 datasheet Table 2-2 lists a **60 µs low-level output glitch at power-up on GPIO1–14, 17, 18**. GPIO21 is not in that table, is not a strapping pin, and has no reset pull-down. |
| Extra GNSS lines | RESET_N → GPIO40 and EXTINT → GPIO41 (plus test pads) | This goes beyond the lead's "test pads only". It lets firmware recover a hung receiver (RESET_N ≥ 1 ms low) and time-mark OBD requests (EXTINT). Both are non-glitching pins with no reset pulls. The GNSS internal pull-ups keep both inactive while the MCU is in reset. |
| Third LED | LED3 on the charger's CHG pin (hardware) | This follows the BQ DS §10.2.2.4 application. It shows charging even while the pod is switched off. It does not replace the two GPIO LEDs. |

## 3. Component selection (JLCPCB-assemblable, LCSC parts)

Stock and unit price are **as seen on 2026-09-24** from JLCPCB's parts API (`jlcpcb.com/partdetail/<code>`, JLCPCB qty-1 price, USD). Basic = JLCPCB basic library (no loading fee); Extended = extended library (US$3.07 economic-PCBA loading fee per unique part).

| Ref | Part | LCSC | Lib | Stock | Unit $ | Why |
|---|---|---|---|---|---|---|
| U1 | Espressif ESP32-S3-MINI-1-N8 | C2913206 | Extended | 7,580 | 4.708 | Lead decision. 8 MB in-package flash, no PSRAM, so GPIO26 is free. BLE 5 central+peripheral, WiFi STA for the MHD bridge, native USB. |
| U2 | u-blox SAM-M10Q-00B | C5443880 | Extended | **10** | 22.835 | Lead decision. Antenna, SAW and LNA integrated; up to 25 Hz single-GNSS (high-performance mode). **Stock is only 10: order promptly, see §10.6.** |
| U3 | ST LSM6DSV16XTR | C5267406 | Extended | 7,141 | 3.485 | Lead decision. ±16 g / ±4000 dps, 4.5 KB FIFO with timestamps, I2C Fast-mode and Fast-mode Plus. |
| U4 | TI BQ24073RGTR | C15220 | Extended | 33,855 | 0.898 | Power-path Li-ion charger, OUT = 4.4 V, TS/NTC, OVP 6.6 V (§2). |
| U5 | TI TLV75733PDYDR | C22399950 | Extended | 2,733 | 0.279 | 1 A LDO, DYD dropout 450 mV max at 1 A to 85 °C (500 mV to 125 °C), thermal-pad SOT-23-5 (§2). |
| U6 | Torex XC6206P332MR-G | C5446 | **Basic** | 462,690 | 0.142 | Always-on V_BCKP supply, Iq 1.0 µA typ / 3.0 µA max, Vin max 6.0 V. |
| U7 | ST USBLC6-2SC6 | C7519 | Extended | 38,410 | 0.176 | USB D+/D− and VBUS ESD (±8 kV contact per ST). Cheap insurance on a connector that gets plugged in daily in a car. |
| J1 | HRO TYPE-C-31-M-12 (USB 2.0 Type-C receptacle, 16 contacts) | C165948 | Extended | 98,780 | 0.186 | Listed as SMD. Has 4 shell tabs. JLCPCB-assembled; if JLCPCB rejects the shell tabs the owner hand-solders them (§9). |
| J2 | JST B3B-PH-K-S(LF)(SN), 3-pin 2.0 mm, top entry, THT (1 = BAT+, 2 = BAT−, 3 = NTC) | C131339 | (hand) | 150,191 | 0.045 | 1-cell LiPo pack with integrated 10 kΩ NTC (the standard 3-wire pack TI's BQ2407x application assumes). **Hand-soldered by owner**, not in the CPL. (JLCPCB parts API, 2026-09-24.) |
| J3 | 1×8 2.54 mm pad row (pin 1…8: GND, 3V3, GPIO34, 33, 47, 35, 36, NC) | — | DNP | — | — | Spare pins for rev-A experiments (e.g. an SPI NAND breakout for logging trials). Bare pads, no part. |
| SW1 | XKB TS-1187A-B-A-B 5.1 × 5.1 mm SMD tact (BOOT, GPIO0) | C318884 | **Basic** | 520,986 | 0.021 | Download-mode strap. |
| SW2 | XKB TS-1187A-B-A-B (RESET, EN) | C318884 | **Basic** | (same) | 0.021 | Reset. |
| SW3 | SOFNG SS-12D00-G3 SPDT slide, THT, **2.5 mm pitch** (drawing "P.C.B LAYOUT"; G3 = 3.0 mm handle length, not the pitch; the drawing is an image, so check a part in hand before soldering) | C22355741 | (hand) | 9,605 | 0.059 | Power switch on the LDO EN pin (§2). **Hand-soldered by owner.** |
| Q1 | JCET 2N7002, N-MOSFET, SOT-23 (1 = G, 2 = S, 3 = D) | C8545 | **Basic** | 1,703,497 | 0.018 | Charge-enable switch (review rev2): pulls CE low only while the MCU drives CHG_EN high. V_GS(th) 1.0–1.6 V, R_DS(on) ≤ 7 Ω at 5 V (JCET datasheet). |
| LED1 | KENTO KT-0603Y yellow 0603 | C2287 | Extended | 85,024 | 0.011 | Status LED A (GPIO12). Yellow/red (AlGaInP) chosen because green/white InGaN parts need ~3.1 V Vf and barely light from 3.3 V. |
| LED2 | KENTO KT-0603R red 0603 | C2286 | **Basic** | 4,108,067 | 0.008 | Status LED B (GPIO13). |
| LED3 | KENTO KT-0603R red 0603 | C2286 | **Basic** | (same) | 0.008 | Charge indicator (BQ CHG). |
| C1 | 1 µF 50 V X5R 0603 (CL10A105KB8NNNC) | C15849 | Basic | 6,964,943 | 0.017 | BQ IN bypass ("1 µF to 10 µF"). |
| C2, C3, C6 | 22 µF 25 V X5R 0805 (CL21A226MAQNNNE) | C45783 | Basic | 4,323,487 | 0.222 | C2 on BQ OUT/VSYS and C3 on BQ BAT (both "4.7 µF to 47 µF"). C6 on ESP 3V3 (Espressif reference C1 = 22 µF). |
| C4, C8, C12, C13 | 1 µF 25 V X5R 0402 (CL05A105KA5NQNC) | C52923 | Basic | 6,778,380 | 0.010 | C4 on LDO IN. C8 for the EN RC. C12/C13 on XC6206 IN/OUT. |
| C5 | 10 µF 10 V X5R 0603 (CL10A106KP8NNNC) | C19702 | Basic | 11,364,972 | 0.032 | LDO OUT (TLV757P: C_OUT 1–200 µF). |
| C9 | 4.7 µF 10 V X5R 0402 (CL05A475MP5NRNC) | C23733 | Basic | 2,709,575 | 0.017 | GNSS VCC/V_IO bulk (our choice; u-blox text gives no value, see §11.3). |
| C7, C10, C11, C14, C15, C16 | 100 nF 16 V X7R 0402 (CL05B104KO5NNNC) | C1525 | Basic | 25,636,234 | 0.005 | ESP 3V3, GNSS VCC/V_IO, GNSS V_BCKP, IMU Vdd and Vdd_IO (ST: "C1, C2 = 100 nF"), ADC hold. |
| C17, C18 | 0402 footprints on USB D+/D− to GND | — | **DNP** | — | — | Espressif: "capacitors to ground … initially can be unpopulated". |
| R1, R2 | 5.1 kΩ 1 % 0402 | C25905 | Basic | 6,573,559 | 0.002 | USB-C CC1/CC2 sink Rd, one per CC pin. |
| R3, R4 | 22 Ω 0402 | C25092 | Basic | 3,571,664 | 0.003 | USB D+/D− series ("initial value can be 22/33 Ω", Espressif). |
| R5, R6 | 10 kΩ 1 % 0402 | C25744 | Basic | 24,431,534 | 0.003 | R5 EN RC (Espressif "R = 10 kΩ and C = 1 µF"). R6 GPIO0 pull-up ("recommended to place a pull-up resistor at the GPIO0 pin"). |
| R7, R8 | 4.7 kΩ 1 % 0402 | C25900 | Basic | 16,341,514 | 0.003 | I2C pull-ups to 3V3 for 400 kHz. ST's figure shows 10 kΩ generically; 4.7 kΩ keeps rise time short at 400 kHz. |
| R9 | 3.3 kΩ 1 % 0402 | C25890 | Basic | 2,226,476 | 0.004 | BQ ISET → ~270 mA charge. |
| R10 | 1.5 kΩ 1 % 0402 | C25867 | Basic | 2,202,352 | 0.003 | BQ ILIM. Fitted because TI says "Leaving ILIM unconnected disables all charging". It would set ~1.07 A typ if ILIM mode were ever selected. Unused in USB500 mode. |
| R11 | 1.5 kΩ 1 % 0402 | C25867 | Basic | (same) | 0.003 | CHG LED series (TI: "1.5-kΩ resistor in series with a LED between OUT and CHG"). |
| R12 | 100 kΩ 1 % 0402 | C25741 | Basic | 9,246,138 | 0.003 | PGOOD pull-up to 3V3 (TI: "on the order of 100 kΩ"). |
| R13, R14 | 1 MΩ 1 % 0402 | C26083 | Basic | 2,735,243 | 0.003 | VBAT divider. |
| R15, R16 | 1 kΩ 1 % 0402 | C11702 | Basic | 9,031,305 | 0.002 | LED1/LED2 series (~1.3 mA red). |
| R18 | 100 kΩ 1 % 0402 | C25741 | Basic | (as R12) | 0.003 | CE pull-up to VSYS: charging disabled unless Q1 conducts (review rev2). |
| R19 | 10 kΩ 1 % 0402 | C25744 | Basic | (as R5) | 0.003 | Q1 gate pull-down: holds charging off through reset/boot/unflashed/unpowered MCU; strong enough to beat a 45 kΩ internal pull-up (gate ≤ 0.6 V < V_GS(th) 1.0 V min). |
| R17 | 0 Ω 0402 | C17168 | Basic | 10,541,790 | 0.003 | V_BCKP supply link (remove to cut backup for measurement). |

Extended parts JLCPCB must load: U1, U2, U3, U4, U5, U7, J1, LED1 = **8 unique** (J2 and SW3 are hand-soldered and bought loose; Q1/R18/R19 are basic parts). RT1 (board NTC) was removed in review rev2: no PCB-NTC fallback.

## 4. Netlist (binding, schematic + PCB must match exactly)

Net names in CAPS. `Ux.n` = pin number n (pin maps in §5).

```
GND:        U1.1,2,42,43,46-65 (+EPAD), U2.1,4,5,6,10,11,15,16,20, U3.6,7,
            U4.8 (VSS) + thermal pad, U5.2 + thermal pad, U6.1, U7.2,
            J1 GND contacts (A1,A12,B1,B12) + shell tabs, J2.2 (BAT-),
            all capacitor low sides, R1/R2/R14 low sides, SW1/SW2 one side, SW3 OFF throw, J3.1,
            Q1.2 (source), R19 low side

--- USB / input ---
VBUS:       J1 VBUS contacts (A4,A9,B4,B9) -> U7.5 (VBUS) -> U4.13 (IN); C1 VBUS->GND
CC1:        J1.A5 -> R1 5.1k -> GND
CC2:        J1.B5 -> R2 5.1k -> GND
USB_DP_C:   J1.A6 + J1.B6 (tied) -> U7.3 + U7.4 (I/O2, flow-through) -> R3 22R -> USB_DP
USB_DN_C:   J1.A7 + J1.B7 (tied) -> U7.1 + U7.6 (I/O1, flow-through) -> R4 22R -> USB_DN
USB_DP:     R3 -> U1.24 (IO20, USB_D+); C17 DNP USB_DP->GND
USB_DN:     R4 -> U1.23 (IO19, USB_D-); C18 DNP USB_DN->GND
J1 SBU1/SBU2 (A8,B8): no connect

--- charger U4 BQ24073RGTR ---
VBAT:       J2.1 (BAT+) -> U4.2 + U4.3 (BAT); C3 22uF VBAT->GND; U6.3 (VIN); C12 1uF VBAT->GND;
            R13 1M VBAT -> VBAT_SENSE
VSYS:       U4.10 + U4.11 (OUT); C2 22uF VSYS->GND; U5.1 (IN); C4 1uF VSYS->GND;
            SW3 ON throw; U4.6 (EN1) tied to VSYS (logic high, <= 4.4 V < 6 V VIH max);
            R11 1.5k VSYS -> LED3 anode; R18 100k VSYS -> CHG_CE
U4.5  EN2  -> GND        (EN2=0, EN1=1 -> USB500 mode, 450-500 mA)
CHG_CE:     U4.4 (CE, active low) -> R18 100k -> VSYS; Q1.3 (drain)   (review rev2)
            R18 holds CE high = charging DISABLED; Q1 pulls it low only while CHG_EN is high
CHG_EN:     U1.33 (IO37) -> Q1.1 (gate); R19 10k gate -> GND
U4.15 TD   -> GND        (termination enabled)
U4.14 TMR  -> no connect (TI: "Leave TMR unconnected to set the timers to the default values")
ISET:       U4.16 -> R9 3.3k -> GND
ILIM:       U4.12 -> R10 1.5k -> GND
TS:         U4.1 -> J2.3 (pack NTC, 10k B3950 required, §4 notes; its other end is BAT-/GND
            inside the pack); U4.1 -> U1.10 (IO6, ADC1_CH5) direct: firmware measures the cell
            temperature itself (review rev2). No board NTC (RT1 removed), no Rs/Rp network (§10.4).
CHG_N:      U4.9 -> LED3 cathode           (LED3 lights while charging)
PGOOD_N:    U4.7 -> R12 100k -> 3V3; U4.7 -> U1.6 (IO2)

--- 3.3 V rail U5 TLV75733PDYDR ---
LDO_EN:     U5.3 (EN) -> SW3 common        (SW3: ON throw = VSYS, OFF throw = GND)
3V3:        U5.5 (OUT); C5 10uF 3V3->GND;
            U1.3 (3V3) + C6 22uF + C7 100nF at the pin;
            U2.17 (VCC) + C9 4.7uF and U2.2 (V_IO) + C10 100nF: two top-layer lanes that
            join on the 3V3 trunk >= 20 mm from U2 (review fix wave: the tie at the
            module is not routable on one layer, RESET_N/EXTINT sit between the pins; §8);
            U3.8 (Vdd) + C14 100nF; U3.5 (Vdd_IO) + C15 100nF; U3.12 (CS) -> 3V3 (I2C mode);
            R5, R6, R7, R8, R12 high sides; J3.2 (review fix wave: J3.1/J3.2 swapped)
U5.4 NC -> no connect

--- GNSS backup U6 XC6206P332MR ---
U6.3 (VIN) = VBAT; U6.2 (VOUT) -> C13 1uF -> GND; U6.2 -> R17 0R -> VBCKP
VBCKP:      R17 -> U2.3 (V_BCKP) + C11 100nF (at the module pin)

--- MCU U1 ESP32-S3-MINI-1-N8 ---
EN:         U1.45 -> R5 10k -> 3V3; C8 1uF EN->GND; SW2 EN->GND
BOOT:       U1.4 (IO0) -> R6 10k -> 3V3; SW1 IO0->GND   (no capacitor on IO0: Espressif)
VBAT_SENSE: R13/R14 midpoint -> U1.5 (IO1, ADC1_CH0); R14 1M -> GND; C16 100nF -> GND
GNSS_RXD:   U1.34 (IO38, UART1 TX) -> U2.14 (RXD)
GNSS_TXD:   U2.13 (TXD) -> U1.35 (IO39, UART1 RX)
PPS:        U2.7 (TIMEPULSE) -> U1.25 (IO21)     (input only, never driven by MCU)
GNSS_RESET_N:  U1.36 (IO40, open-drain use only) -> U2.18 (RESET_N)   (NO capacitor: u-blox IM)
GNSS_EXTINT:   U1.37 (IO41) -> U2.19 (EXTINT)
GNSS_SAFEBOOT_N: U2.8 -> test pad TP12 only
U2.9 (SDA), U2.12 (SCL): no connect (internal pull-ups, "Leave open if not used")
I2C_SDA:    U1.13 (IO9) -> U3.14 (SDA); R7 4.7k -> 3V3   (review fix wave: pins re-ordered, planar)
I2C_SCL:    U1.14 (IO10) -> U3.13 (SCL); R8 4.7k -> 3V3
IMU_INT1:   U3.4 -> U1.12 (IO8)
IMU_INT2:   U3.9 (INT2) NOT CONNECTED (review fix wave). INT2 sits between two 3V3 pins of U3
            (CS pin 12 and Vdd pin 8); with no copper allowed through the land pattern (ST TN0018)
            and no via allowed within 20 mm of U2, an INT2 line to U1 would cut CS off from 3V3.
            Firmware routes all interrupts to INT1 (the LSM6DSV16X can map every source to INT1).
U3.1 (SDO/SA0) -> GND  (I2C address 1101010b = 0x6A)
U3.2 (SDx/AH1/Qvar1) -> GND, U3.3 (SCx/AH2/Qvar2) -> GND   (ST: "Connect to Vdd_IO or GND if the analog hub and Qvar are disabled")
U3.10 (OCS_Aux), U3.11 (SDO_Aux): no connect, pads soldered (ST mode 1: "Leave pin electrically unconnected and soldered to PCB")
LED1:       U1.16 (IO12) -> R15 1k -> LED1 anode; LED1 cathode -> GND
LED2:       U1.17 (IO13) -> R16 1k -> LED2 anode; LED2 cathode -> GND
U0TXD:      U1.39 (TXD0/GPIO43) -> TP13
U0RXD:      U1.40 (RXD0/GPIO44) -> TP14
Spare:      U1.29 (IO34) -> J3.3, U1.28 (IO33) -> J3.4, U1.27 (IO47) -> J3.5, U1.31 (IO35) -> J3.6,
            U1.32 (IO36) -> J3.7; J3.8 no connect (IO37 is CHG_EN since review rev2); J3.1 = GND, J3.2 = 3V3   (review fix wave: moved from
            IO5/6/7/14/48, whose pins face the west power chain, to U1's south-east pins so the
            J3 bus reaches the east strip; IO33-37 are free on the -N8 (no PSRAM), no strap/JTAG)
Strapping:  U1.7 (IO3), U1.41 (IO45), U1.44 (IO46): NO CONNECT (see §6)
All other U1 IO pins: no connect.

--- test pads (1.0 mm round, bottom side, electronics zone only; exception: TP12 is on the TOP side
    in the Z1 south strip at the end of the SAFEBOOT_N lane, review fix wave, §8) ---
TP1 3V3, TP2 GND, TP3 GND, TP4 VBAT, TP5 VSYS, TP6 VBUS, TP7 GNSS_TXD, TP8 GNSS_RXD,
TP9 PPS, TP10 I2C_SDA, TP11 I2C_SCL, TP12 GNSS_SAFEBOOT_N, TP13 U0TXD, TP14 U0RXD,
TP15 GNSS_RESET_N, TP16 EN, TP17 BOOT (IO0), TP18 VBCKP, TP19 IMU_INT1
```

Notes:

- SAFEBOOT_N / TIMEPULSE: pulling TP12 (or TP9) to GND while the GNSS powers up forces u-blox safeboot for firmware recovery. That is the only reason TP12 exists. Nothing on the board may pull PPS low at power-up.
- Hardware backup mode (u-blox DS): "In hardware backup mode (VCC = 0 V and V_IO = 0 V), PIOs must not be driven." With SW3 OFF the whole 3V3 domain (MCU included) is unpowered, so nothing drives the GNSS pins.
- J2 pinout: **1 = BAT+, 2 = BAT−, 3 = NTC**. LiPo pack wiring is not standardised: the silkscreen marks **+**, **−** and **T** at J2 (bottom side, next to the pins); check the pack against them before the first plug-in (there is no reverse-battery protection, §10.5).
- A pack plugged in **without** an NTC leaves TS open: V_TS rises above V_COLD and the BQ24073 suspends charging, and the firmware reads an out-of-range TS and keeps CE disabled (fail-safe). There is no board-NTC fallback (review rev2): such a pack cannot be charged by this board.
- **What battery to buy (binding):** protected 1-cell LiPo (PCM for over-charge / over-discharge / over-current), 600–1200 mAh, **integrated 10 kΩ ±1 % NTC with B25/50 = 3950 K ±1 %** (the common "10K 3950" pack NTC), **3-wire JST-PH 2.0 mm plug** wired BAT+ / BAT− / NTC in J2's pin order (re-pin the plug if the pack's order differs), and a manufacturer charge-temperature rating that covers **0–45 °C** (the usual LiPo rating). The firmware charges only inside 5–40 °C (§6); §10.4 gives the worst-case windows. A B3435 (103AT) pack also stays inside 0–45 °C under firmware control but gives a wider hardware backstop window (§10.4); packs with B ≈ 3380 K or an unknown NTC are not allowed.

## 5. Pin maps (datasheet-verified)

### U2 — u-blox SAM-M10Q-00B (LGA-20, 15.5 × 15.5 mm)
Source: DS UBX-22013293 R05 Table 9 plus Figure 2 (top view, patch antenna side), checked visually.

| Pin | Name | Pin | Name |
|---|---|---|---|
| 1 | GND | 11 | GND |
| 2 | V_IO | 12 | SCL |
| 3 | V_BCKP | 13 | TXD (out) |
| 4 | GND | 14 | RXD (in) |
| 5 | GND | 15 | GND |
| 6 | GND | 16 | GND |
| 7 | TIMEPULSE (PIO4, out, 2 mA) | 17 | VCC |
| 8 | SAFEBOOT_N (1 kΩ internal to TIMEPULSE) | 18 | RESET_N (≥ 1 ms low = reset; clears BBR) |
| 9 | SDA | 19 | EXTINT |
| 10 | GND | 20 | GND |

Sides, top view: pins 1–5 left, 6–10 bottom, 11–15 right, 16–20 top.

Supply facts: VCC 2.7–3.6 V (3.0 typ). V_IO 2.7 V to VCC (max 3.6). V_BCKP 1.65–3.6 V. V_IO ramp 25–35,000 µs/V (the TLV757P's 550 µs soft-start gives ~167 µs/V, inside the window). Inrush up to 100 mA at startup. Series resistance on the supply must stay below 0.2 Ω (IM §4.1.1). UART 9600 default, up to 921,600 bit/s.

Navigation rate (DS Tables 1–2): single-GNSS 18 Hz default / **25 Hz high-performance**. GPS+GAL 10 / **20 Hz**. GPS+GAL+GLO 6 / 16 Hz. 4-GNSS default 4 / 10 Hz. "High performance" needs a one-time **OTP** write (IM §2.1.5, "Changes made in the OTP configuration are permanent").

### U3 — ST LSM6DSV16XTR (LGA-14, 2.5 × 3 × 0.83 mm)
Source: DS13510 Rev 4 Table 2 and Figure 28 (mode 1).

| Pin | Name | Our use | Pin | Name | Our use |
|---|---|---|---|---|---|
| 1 | SDO/SA0 | GND → addr 0x6A | 8 | Vdd | 3V3 + 100 nF |
| 2 | SDx/AH1/Qvar1 | GND | 9 | INT2 | NC (review fix wave, §4) |
| 3 | SCx/AH2/Qvar2 | GND | 10 | OCS_Aux | NC, pad soldered |
| 4 | INT1 | IO8 | 11 | SDO_Aux | NC, pad soldered |
| 5 | Vdd_IO | 3V3 + 100 nF | 12 | CS | 3V3 (I2C enabled) |
| 6 | GND | GND | 13 | SCL | IO10 |
| 7 | GND | GND | 14 | SDA | IO9 |

Supply 1.71–3.6 V. I2C "fast mode (400 kHz) … as well as fast mode plus (1000 kHz)". 0.65 mA in combo high-performance mode.

### U1 — ESP32-S3-MINI-1-N8 (65 pads, 15.4 × 20.5 × 2.4 mm)
Source: module DS v1.7 Table 3-1. Only the pins this design uses are listed.

| Pad | Name | Pad | Name |
|---|---|---|---|
| 1, 2, 42, 43, 46–65 | GND | 23 | IO19 / USB_D− |
| 3 | 3V3 | 24 | IO20 / USB_D+ |
| 4 | IO0 (strap) | 25 | IO21 |
| 5 | IO1 (ADC1_CH0) | 27 | IO47 |
| 6 | IO2 (ADC1_CH1) | 30 | IO48 (NC) |
| 7 | IO3 (strap) | 34 | IO38 |
| 9, 10, 11 | IO5 (NC), IO6 (→ TS_ADC), IO7 (NC) | 35 | IO39 (MTCK) |
| 12, 13 | IO8, IO9 | 36 | IO40 (MTDO) |
| 14, 15 | IO10, IO11 | 37 | IO41 (MTDI) |
| 16, 17 | IO12, IO13 | 39 / 40 | TXD0 (GPIO43) / RXD0 (GPIO44) |
| 18 | IO14 (NC) | 41 | IO45 (strap) |
| 28, 29 | IO33, IO34 (→ J3) | 31, 32, 33 | IO35, IO36 (→ J3), IO37 (→ CHG_EN) |
| 19, 20, 21 | IO15, IO16, IO17 (NC) | 22 | IO18 (NC) |
|  |  | 44 | IO46 (strap) |
|  |  | 45 | EN ("Do not leave the EN pin floating") |

Supply 3.0–3.6 V, ≥ 0.5 A. The antenna area is the 5.05 mm × 15.4 mm end of the module (land pattern Fig. 11-1).

### U4 — TI BQ24073RGTR (VQFN-16 3 × 3, RGT)
Source: SLUS810N Figure 7-1 and Table 7-1.

| Pin | Name | Pin | Name |
|---|---|---|---|
| 1 | TS | 9 | CHG (open-drain) |
| 2 | BAT | 10 | OUT |
| 3 | BAT | 11 | OUT |
| 4 | CE (active low) | 12 | ILIM |
| 5 | EN2 | 13 | IN |
| 6 | EN1 | 14 | TMR |
| 7 | PGOOD (open-drain) | 15 | TD |
| 8 | VSS | 16 | ISET |

The thermal pad is tied to VSS ("Do not use the thermal pad as the primary ground"; pin 8 must be grounded). IN operating range 4.35–6.4 V, OVP 6.6 V, survives 28 V. Logic VIH 1.4–6 V.

### U5 — TI TLV75733PDYDR (SOT-23-5 with thermal pad, DYD)
Source: SBVS322C Table 4-1: **1 = IN, 2 = GND, 3 = EN, 4 = NC, 5 = OUT**, thermal pad = GND. VIN 1.45–5.5 V (abs max 6.0). EN VHI 1 V / VLO 0.3 V with an internal pull-down. I_CL min 1.2 A. Iq 25 µA typ. Shutdown current 0.1 µA typ / 1 µA max. Startup 550 µs.

### U6 — Torex XC6206P332MR-G (SOT-23)
Source: XC6206 DS pin table, SOT-23 column: **1 = VSS, 2 = VOUT, 3 = VIN.** Max operating input 6.0 V, supply current 1.0 µA typ / 3.0 µA max.

### U7 — ST USBLC6-2SC6 (SOT-23-6)
Source: ST DS Doc ID 11265 Rev 5 Figure 1: **1 = I/O1, 2 = GND, 3 = I/O2, 4 = I/O2, 5 = VBUS, 6 = I/O1** (1↔6 and 3↔4 are the same line, flow-through).

### J1 — USB-C receptacle (HRO TYPE-C-31-M-12)
Contact names follow the USB Type-C specification: A1/A12/B1/B12 GND, A4/A9/B4/B9 VBUS, A5 CC1, B5 CC2, A6/B6 D+, A7/B7 D−, A8/B8 SBU. **VERIFY-AT-LAYOUT** that the KiCad footprint `USB_C_Receptacle_HRO_TYPE-C-31-M-12` pad names match the HRO drawing (the LCSC PDF is image-only, §11.3).

## 6. GPIO assignment and strapping check

Strapping pins from S3 DS / module DS §4: **GPIO0 (weak pull-up, boot mode), GPIO3 (floating, JTAG source), GPIO45 (weak pull-down, VDD_SPI voltage), GPIO46 (weak pull-down, boot mode + ROM print).** Power-up glitch pins (S3 DS Table 2-2): GPIO1–14, 17, 18 (60 µs low-level), GPIO19/20 (USB glitches).

| GPIO | Module pad | Function | Direction | Strap? | Power-up glitch? | Reset state | Verdict |
|---|---|---|---|---|---|---|---|
| 0 | 4 | BOOT button + 10 kΩ pull-up | in | **yes** | no | WPU, IE | Intended strap use. High = SPI boot. |
| 1 | 5 | VBAT_SENSE (ADC1_CH0) | analog | no | yes (60 µs low) | IE | OK. The glitch only disturbs the RC node briefly. |
| 2 | 6 | PGOOD_N (100 kΩ pull-up) | in | no | yes | IE | OK. The input is open-drain from the BQ. |
| 3 | 7 | **NC** | — | **yes** | yes | IE | Left floating on purpose. It only matters if EFUSE_STRAP_JTAG_SEL is burned (it is not). |
| 8 | 12 | IMU_INT1 | in | no | yes | IE | OK (review fix wave: was I2C_SDA). |
| 9 | 13 | I2C_SDA | io | no | yes | IE | OK. A 60 µs low at power-up is a non-event for the IMU, which powers up at the same moment. |
| 10 | 14 | I2C_SCL | out | no | yes | IE | OK (same reason). |
| 11 | 15 | **NC** (review fix wave) | — | no | yes | IE | Freed (INT2 not connected, §4). |
| 12 | 16 | LED1 (yellow) | out | no | yes | IE | OK. A 60 µs flash is invisible. |
| 13 | 17 | LED2 (red) | out | no | yes | IE | OK. |
| 19 | 23 | USB_D− | io | no | USB | USB | Native USB. |
| 20 | 24 | USB_D+ | io | no | USB | USB_PU | Native USB. |
| 21 | 25 | **PPS** (GNSS TIMEPULSE) | in | no | **no** | — (no pulls) | **Required choice**: must never be low at GNSS power-up (SAFEBOOT_N). |
| 38 | 34 | GNSS_RXD (UART1 TX) | out | no | no | IE | OK. |
| 39 | 35 | GNSS_TXD (UART1 RX) | in | no | no | IE (WPU per eFuse) | OK. |
| 40 | 36 | GNSS_RESET_N (drive open-drain low only) | od | no | no | IE | OK. The GNSS internal 10 kΩ pull-up keeps it high. |
| 41 | 37 | GNSS_EXTINT | out | no | no | IE | OK. The GNSS internal pull-up keeps it inactive. |
| 43 | 39 | U0TXD → TP13 | out | no | no | WPU, IE | ROM/boot log fallback. |
| 44 | 40 | U0RXD → TP14 | in | no | no | WPU, IE | Fallback console. |
| 45 | 41 | **NC** | — | **yes** | no | WPD | **Must never be pulled high**: it selects VDD_SPI voltage for the in-package 3.3 V flash. |
| 46 | 44 | **NC** | — | **yes** | no | WPD | Left at the default. GPIO0 low + GPIO46 low = download mode via SW1. |
| 33, 34, 35, 36, 47 | 28, 29, 31, 32, 27 | spare → J3 | — | no | no | — | Free for experiments (e.g. an SPI NAND breakout). IO33–37 are the octal-PSRAM pins on -R8 variants; the -N8 has no PSRAM, so they are plain GPIOs. Not ADC-capable. |
| 37 | 33 | **CHG_EN** → Q1 gate (review rev2) | out | no | **no** (not in DS Table 2-2) | IE | High = charging allowed. R19 10 kΩ holds it low whenever the pin is not driven (reset, boot, unflashed, 3V3 off). |
| 6 | 10 | **TS_ADC** (ADC1_CH5, review rev2) | analog | no | yes (60 µs low) | IE | Reads V_TS = I_TS × R_NTC. The glitch is harmless on an input. The BQ's ≤ 78 µA TS source is the only current into the pin; with 3V3 off the pad clamps TS low, which the charger reads as "hot" (charging off, and CE is off anyway). |
| 5, 7, 14, 48 | 9, 11, 18, 30 | NC | — | no | — | — | Freed by the review fix wave (their pins face the power chain). |

Firmware rules this implies (hand to the firmware ticket):

- Never configure GPIO21 as an output.
- Drive GPIO40 only as open-drain low for ≥ 1 ms to reset the GNSS, and remember that reset clears BBR.
- Read VBAT on ADC1 only, with ATTEN3 (0–2900 mV).
- UART1 on GPIO38/39 at up to 921,600 bit/s.
- Write the SAM-M10Q high-performance OTP string once during bring-up (IM Table 3) before expecting 20/25 Hz.
- IMU (review fix wave): I2C on GPIO9 (SDA) / GPIO10 (SCL), INT1 on GPIO8; INT2 is not connected, so map every LSM6DSV16X interrupt source to INT1.
- J3 spares: GPIO34/33/47/35/36 on J3.3…7 (J3.1 GND, J3.2 3V3, J3.8 NC).
- **Charge supervision (binding, review rev2).** Charging is enabled only by driving GPIO37 (CHG_EN) high, and only while all of these hold: (a) USB present (PGOOD_N low); (b) the cell temperature from TS is inside **5–40 °C**; (c) no TS/ADC fault. Measure V_TS on GPIO6 (ADC1_CH5, 12 dB attenuation, averaged, curve-fitted calibration) at ≥ 1 Hz while USB is present; R_NTC = V_TS / 75 µA; T from the B3950 β equation (R25 = 10 kΩ). Disable (GPIO37 low) when T > 40 °C or T < 5 °C, re-enable only after 3 °C of hysteresis (below 37 °C / above 8 °C). Treat V_TS < 0.15 V or > 2.4 V as a fault (shorted/open NTC): charging off. Keep the task watchdog enabled: every reset drops GPIO37 and stops charging. If bench test §10A-3 shows that the BQ does not bias TS while CE is high, enable for ≤ 200 ms to read TS and disable again if it is out of window.

## 7. Power budget

Datasheet values are marked (DS). Everything else is an **estimate** until measured on the first article.

| Rail / load | Peak | Average (estimate) | Source |
|---|---|---|---|
| ESP32-S3-MINI-1 | 355 mA (802.11b TX, 20.5 dBm); BLE TX 20 dBm 340 mA | BLE-only hub at 160 MHz: ~70–90 mA. WiFi STA to MHD + BLE, no modem sleep: ~130–180 mA | DS Tables 6-4/6-5; modem-sleep 160 MHz single-core 39.9–54.6 mA (DS Table 6-6) + radio duty (estimate) |
| SAM-M10Q VCC + V_IO | 100 mA inrush at startup; 13 + 2.3 mA acquisition (4-GNSS) | ~10 + 2.3 mA tracking, plus the "minor increase" of the HP clock → budget 20 mA | DS Table 14 (1 Hz, 3.0 V) + IM §2.1.5 |
| LSM6DSV16X | 0.65 mA | 0.65 mA | DS features |
| LED1 + LED2 | ~1.3 mA each | ~1 mA | (3.3 − ~2.0 V) / 1 kΩ |
| I2C pull-ups | 0.7 mA each while low | < 0.5 mA | 3.3 V / 4.7 kΩ |
| **3V3 total** | **~380 mA** steady peak; ~480 mA only if GNSS inrush coincided with a full-power WiFi TX burst | **~95–115 mA** BLE-only; **~155–205 mA** with WiFi | LDO I_CL min 1.2 A: ≥ 2.4× margin over 480 mA at the LDO. The **source** is the limit: USB500 guarantees only 450 mA, so the ≥ 0.5 A Espressif figure is met only with a cell fitted (battery supplement); USB-only operation is safe at the ~380 mA steady peak but not at the 480 mA coincidence (§2) |
| LDO dissipation (from VSYS = 4.4 V on USB) | (4.4 − 3.3) × 0.48 A = 0.53 W, a transient of milliseconds | 1.1 V × 0.15 A = 0.17 W → ~+15 °C at 92.5 °C/W | TLV757P θJA (DYD, JEDEC) |
| VSYS (BQ OUT) | 3V3 load + LED3 (≤ 1.6 mA) | ≈ 3V3 average | — |
| VBUS input | limited to 450–500 mA (USB500, I_INmax 450 min / 475 typ / 500 max) | 3V3 average + charge current (DPPM shares it) | BQ DS |
| Battery charge | 241–295 mA (R9 = 3.3 kΩ) | — | K_ISET 797–975 A·Ω |
| VBCKP | ~3 µA while running; 28 µA typ in hardware backup | — | u-blox DS Table 15 + footnote 26 |
| **OFF-state battery drain** (SW3 OFF, no USB) | — | BQ IBAT(PDWN) ≤ 6.5 µA + LDO shutdown ≤ 1 µA + XC6206 ≤ 3 µA + GNSS backup 28 µA + divider 2.1 µA + CE pull-up R18 into the BQ's ~285 kΩ CE pull-down ≤ 10 µA (review rev2; only if that pull-down stays connected without VIN, not specified) ≈ **≤ 51 µA** | → 1000 mAh lasts ~2.2 years (cell self-discharge dominates) |

Bulk capacitance near U1 (review item, verified): the module datasheet's peripheral schematic puts **22 µF + 0.1 µF** on 3V3 at the module; that is C6 (22 µF 0805) + C7 (100 nF) at U1.3, plus C5 (10 µF) at the LDO output. Nothing more is called for, so nothing was added. On VSYS, C2 (22 µF) is BQ OUT's bulk (TI: 4.7–47 µF).

**Firmware low-battery cutoff (requirement):** deep sleep with the radios off below VBAT = 3.5 V under load; no WiFi start below 3.6 V (§10.5). The board has no under-voltage cutoff of its own. These thresholds are **not proven** to keep 3V3 in spec during TX bursts; §10A test 2 validates them (and USB-only operation).

Runtime estimate (VBAT current ≈ 3V3 current through an LDO):

| Cell | BLE-only (~105 mA) | WiFi + BLE (~180 mA) |
|---|---|---|
| 600 mAh | ~5.5 h | ~3.3 h |
| 1000 mAh | ~9.5 h | ~5.5 h |

dragy Pro advertises 12 h at 25 Hz. Matching it needs ≥ 1200 mAh or aggressive modem-sleep (§10.7).

## 8. PCB constraints (binding)

**Outline and stack.** 50.0 × 66.95 mm rectangle (review fix wave, Espressif: the module antenna must overhang the base board; the board ends at the antenna boundary, Y = 66.95, and the 5.05 mm antenna end sticks out beyond it to Y 72.0), 1.6 mm FR-4, 2-layer, 1 oz copper, HASL lead-free (or ENIG; LGA benefits from flatness, cost delta in §9). All SMD parts on the **top** side, so JLCPCB assembles one side only. Coordinates below: origin at the bottom-left corner, X along the 50 mm edge, Y along the 72 mm edge.

**Zones.**

- **Z1, GNSS zone, Y 0–50.**
  - U2 is centred at (25.0, 25.0). Its body spans X/Y 17.25–32.75.
  - **Component keep-out: X 7.25–42.75 and Y 7.25–42.75** (u-blox: nothing within 10 mm of any module edge). This applies to every part, including tall parts (> 3 mm: "at least 10 mm away").
  - Low-profile parts may sit in Z1 outside that box (Y 42.75–50 and the two 7 mm side strips).
  - No traces under the module on either layer.
  - Top layer: GND pour everywhere except the GNSS signal/supply traces.
  - **Bottom layer: solid, unbroken GND over all of Z1, no traces, no test pads.**
  - GND via field under the module (u-blox: "The GND plane below the module is filled with GND vias").
- **GNSS routing rule.** All U2 traces run on the **top layer only** until they are ≥ 20 mm from the module edge (IM: "keep at least 20 mm distance from the module edge when swapping any signal from the top to other layers"). As built this is applied to **every net, not only the GNSS nets**: no via closer than 20 mm to the U2 body (Euclidean distance to the 17.25–32.75 square), and the generator fails the build if any exists. Bottom-layer copper inside Z1 (Y < 50) is GND only (no VSYS/VBAT/GNSS_RXD/PPS runs), also a hard build check.
  - Orientation: rotate U2 so the pin 16–20 edge (VCC, RESET_N, EXTINT) faces +Y (the electronics). VCC is the only line with a series-resistance limit (< 0.2 Ω). For scale, a 0.5 mm × 30 mm 1 oz trace is ≈ 0.03 Ω.
  - ~~Tie V_IO (pin 2) to VCC (pin 17) with a short top-layer trace around the module corner.~~ **Not routable (spec error):** pins 18/19 (RESET_N, EXTINT) sit between them on the same edge, and a via is not allowed within 20 mm. As built, VCC (0.5 mm) and V_IO (0.5 mm) run as separate top-layer lanes and join on the 3V3 trunk ~20 mm north of the module (VCC through a via, V_IO on top). Both lanes carry their own cap (C9 / C10) at the 10 mm boundary. VCC-lane series resistance is checked by the generator (< 0.2 Ω; ~0.08 Ω as built).
  - The remaining signal pins (TXD, RXD on one flank; TIMEPULSE, SAFEBOOT_N on the far edge; V_BCKP) run as thin traces hugging the module outline, then out to +Y.
  - The layout worker may rotate U2 by 90° steps if it shortens total top-layer GNSS routing. Record the choice here.
  - C9/C10/C11 are low-profile 0402s placed at the 10 mm boundary on the +Y side, not at the pins. u-blox gives no bypass value in text and its 10 mm rule takes precedence (§11.3).
  - GND pads may use 0.2 mm thermal reliefs (IM Fig. 22). Stencil 120 µm and mask 0.1 mm wider than the pads (IM §4.4.1).
- **Z2, electronics zone, Y 42.75–66.9.**
  - **U1 ESP32** is centred on X = 25. Body pads span Y ≈ 51.5–66.9; the antenna area Y ≈ 66.95–72.0 **overhangs the board edge** (review fix wave).
  - **West half (X 0–15), power:** U4 → U5 in a compact chain with C1–C7 in the NW corner. **As built (review fix wave):** J1 USB-C sits on the west edge at Y ≈ 48.2, in the band between U1 and the GNSS keep-out (west side strip, outside the 10 mm box), so the D+/D− pair runs J1 → U7 → R3/R4 → U1.23/24 as one top-layer coupled pair with no vias. LED1/LED2/LED3 (+R11/R15/R16) and SW3 moved to the west edge (light pipes / switch on the west face).
  - **East half (X 35–50):** J2 (3-pin JST-PH) on the east edge (Y ≈ 51); Q1 + R19 (charge-enable switch, review rev2) near the NE corner, R18 (CE pull-up) next to U5 in the NW power corner, with CHG_CE running under U1's north edge on the bottom (Y ≈ 64.9); U6 with C11/C12/C13/R17; the VBAT divider R13/R14/C16; SW1/SW2 and J3 in the east strip of Z1 (outside the keep-out box, top only) so enclosure pin-holes line up. **East-strip bus (review fix wave, hand-routed):** the six J3 lines cross under the GNSS lanes on the bottom (Z2), come up through one row of vias at Y ≈ 52.7 (≥ 20 mm from U2) and run south on the top at 0.5 mm pitch west of J3; the 3V3 line runs west of them to J3.2, R6 and on to R5; BOOT (with R6 on it, east of J3) and EN run east of J3 to SW1/SW2. R5/C8 (EN RC) sit south of SW2 in the Z1 south strip, outside the keep-out box. **TP12 (SAFEBOOT_N) is a top-side pad** at the end of its lane in the Z1 south strip (X 36, Y ≈ 5.4): the lane can no longer climb to Z2 because the east corridor carries the J3 bus. It is > 10 mm from U2.
  - **U3 IMU at (22.3, 47.2)** as built (review fix wave: 2.7 mm west of the original (25, ≈46.5) to clear the USB pair), between the GNSS keep-out and U1. Keep it ≥ 10 mm from U4 and U5 (heat drift) and ≥ 5 mm from SW1/SW2 (button shock). Align its axes with the board edges and silkscreen the X/Y/Z arrows. **Land pattern (ST TN0018):** no copper through the land-pattern interior (a rule-area keep-out covers it); the GND pads connect with equal, symmetric 0.2 mm stubs outside the body to one via per side. No via is allowed within 20 mm of U2, so every U3 line is top-only near the part: the 3V3 pins (CS, Vdd, Vdd_IO) are joined around the outside (east side, then south of C14/C15) and leave as the inner-most line of the bundle to a via west of U1.63; SCL, SDA and INT1 follow in ring order to U1.14/.13/.12 (hence the re-ordered GPIOs, §4/§6), and INT2 is not connected.
- **Z3, ESP32 antenna band.** As built the antenna area Y 66.95–72.0 is off the board (overhang); Z3 on the board is the 0.3 mm edge band Y 66.65–66.95 (copper keep-out, both layers) plus Espressif's keep-out around the module.
  - **Review fix wave:** the earlier full-width copper keep-out on FR-4 was not equivalent to Espressif's cutout (FR-4 stayed under and beside the antenna). The board now ends at the antenna boundary, so there is no FR-4 under or beside the 5.05 mm antenna end at all (Espressif's preferred "antenna outside the base board" placement). The remaining on-board band (0.3 mm to the edge) is a copper and via keep-out on both layers across the full width.
  - The board edge sits at the antenna boundary (module fab line), so the whole 5.05 mm antenna end overhangs.
  - Dense GND vias along Y = 66.5 on both sides of the module (Espressif: "Sufficient ground copper and dense ground vias … near the antenna").
  - In the product: ≥ 15 mm clearance from metal around the antenna (Espressif).

**Antenna separation.** The ESP32 antenna (Y 66.95–72, overhanging) and GNSS patch (Y 17.25–32.75) are at opposite ends: ~34 mm edge-to-edge, ~45 mm centre-to-centre. That is the most a 72 mm envelope gives (see §10.3).

**Heat.** U4 and U5 go in the far west corner of Z2, away from U2 (u-blox: TCXO is sensitive to "co-located power devices … thermal conduction via the PCB") and away from U3.

**Ground and stitching.**
- Both layers are poured GND.
- Stitching vias (0.3 mm drill) every ≤ 5 mm along the board perimeter and in a ring around U2 outside the 10 mm keep-out.
- U1 EPAD gets thermal vias per Espressif land pattern Fig. 11-1.
- U4 and U5 thermal pads get ≥ 4 vias each to the bottom GND.

**Bottom layer in Z2.** GND pour, the test pads TP1–TP19 (except TP12, top side, see above), and jumper traces where top routing cannot close. **As built (review fix wave)** the U1 fan-out needs longer bottom runs than 10 mm: the 3V3 trunk (0.5 mm), VBAT (0.5 mm), TS, BOOT, VBAT_SENSE and EN cross under U1's north edge to the east side, and the GNSS/J3 lines run under U1's east pad column to vias 1.25 mm inside the pad ring. All of it is north of Y = 50 (Z2). Nothing but GND on the bottom in Z1 or Z3. Review rev2 adds CHG_CE to that bundle (Y ≈ 64.9, the northmost line under U1) and a 0.3 mm **bottom GND spine along the north edge** (Y ≈ 66.25, from U5's thermal vias to the NE corner) with GND drops for the top pockets that the W–E bottom lines cut off (U6, C11–C13, R14/C16, Q1/R19, C5).

**USB pair (review fix wave).** D+/D− run as a coupled pair: same (top) layer, zero vias, 0.2 mm tracks at 0.2 mm gap where coupled, length-matched within 0.5 mm (a 0.47 mm bump on D− between U7 and R4 compensates D+ being the outer line at the corners), over the unbroken bottom GND (a bottom-layer keep-out under the pair). Not 90 Ω controlled on 1.6 mm 2-layer FR-4 (that would need ~1.9 mm wide traces), and the pair spacing is not constant (0.2 mm gap on the coupled runs, 0.65 mm between the final vertical legs into U1.23/U1.24, set by the module's 0.85 mm pad pitch). This departs from Espressif's USB layout guidance and is **unvalidated**: §10A test 1 is mandatory.

**Supply taps (review fix wave).** Hand-routed trunks are 0.5 mm. Router-made VBUS/VSYS/VBAT/3V3 segments narrower than 0.5 mm are widened by the generator to 0.5, 0.4 or 0.3 mm, whichever still keeps 0.2 mm clearance; the 0.25 mm neck-downs remain only inside fine-pitch pad fields.

**Mounting.**
- 4 × M2 NPTH holes (2.2 mm) at (3.5, 3.5), (46.5, 3.5), (3.5, 60.0), (46.5, 60.0).
- The Z1 holes are corner-only and outside the 10 mm keep-out.
- No mounting hole in Z3.
- The magnet of any magnetic mount (P2 enclosure) must sit behind Z2, never behind Z1 or Z3.

**Rules (as built, review rev2: the text matches the generated board, measured on it).** 0.2 mm clearance and 0.2 mm track minimum everywhere. Power nets (VBUS/VSYS/VBAT/3V3): hand-routed trunks are 0.5 mm (3V3 U5 → U1 → U2 VCC/V_IO lanes, VBAT to J2); router-made power segments are widened to the widest of 0.5/0.4/0.3 mm that keeps clearance (`widen_power_taps`). The **segments narrower than 0.3 mm**, all of them, are: 3V3 **0.2 mm**, 21 mm total: the IMU branch around U3 (Vdd + Vdd_IO + CS, < 1 mA; no wider line fits between U3's 0.5 mm-pitch pads and the land-pattern keep-out) and its feed to the via west of U1.63; VBUS **0.2 mm**, 5 mm total: the four J1 VBUS pad stubs between the NPTH pegs (then a 0.3 mm spine); VBUS **0.25 mm**, 3.8 mm: U7.5's escape under its own body; VSYS **0.25 mm**, 2.1 mm: the stub to test pad TP5. Everything else on the power nets is ≥ 0.3 mm (3V3 0.3 mm: the hand-routed east-strip branch J3.2 → R6 → R5 and the tap to TP1, ≈ 66 mm total, < 1 mA). At the pod's ≤ 0.5 A input these widths are a voltage-drop question, not a heating one (0.2 mm × 5 mm 1 oz ≈ 13 mΩ); §10A tests 1–2 cover it. The rev 0.1 blanket "≥ 0.5 mm" rule is replaced by this list.

## 9. Hand-solder list, and cost estimate (5 PCBs, 2 assembled)

**Hand-soldered by the owner** (not in the CPL, bought loose from LCSC):

1. J2 JST B3B-PH-K-S(LF)(SN) (C131339), 3 THT pins (BAT+, BAT−, NTC).
2. SW3 SS-12D00-G3 (C22355741), 3 THT pins.
3. Conditional: the 4 shell tabs of J1 if JLCPCB flags them as through-hole. The 12 signal pads are always machine-placed.

Everything fine-pitch or LGA (U1, U2, U3, U4 QFN, U5, U7, 0402s) is JLCPCB-assembled.

**Cost estimate.** JLCPCB Economic PCBA fees are quoted from `jlcpcb.com/help/article/pcb-assembly-price` on 2026-09-24. Part prices come from §3. **PCB fabrication price, shipping and taxes are estimates, not quotes.**

| Item | Basis | Estimate (USD) |
|---|---|---|
| 5 × bare PCB, 2-layer, 50 × 66.95 mm, HASL | JLCPCB standard; not quoted in the configurator | ~5–10 (ENIG +~15) |
| PCBA setup (Economic) | $8.18 | 8.18 |
| Stencil | $1.53 | 1.53 |
| Extended-part loading fee | 8 × $3.07 | 24.56 |
| SMT joints | ~2 × 240 joints × $0.0016 | ~0.80 |
| Parts for 2 boards | SAM 2 × 22.84 + ESP 2 × 4.71 + IMU 2 × 3.48 + BQ 2 × 0.90 + LDO 2 × 0.28 + USB-C, ESD, XC6206, 2N7002, LEDs, buttons 2 × ~0.70 + passives ~2 × 1.50 (plus JLCPCB attrition extras) | ~70 |
| Hand-solder parts, loose | 5 × JST B3B + 5 × slide switch | ~0.55 |
| Shipping to Romania (courier) | estimate | ~20–30 |
| Import VAT and fees | Romanian standard rate on goods + shipping | not computed |
| **Total before VAT** | | **~132–157** |

A 1-cell LiPo is not included. Buy it locally: 600–1200 mAh, **protected (PCM)**, **integrated 10 kΩ NTC**, **3-wire JST-PH** (§4 notes).

## 10. Honest limitations and risks (rev A)

1. **Board size vs the lead's ~50 × 40 mm.** This board is 50 × 66.95 mm (72 mm envelope including the overhanging ESP32 antenna). A 50 × 40 board would put the GNSS below u-blox's 40 × 40 mm "significant degradation" limit. It would also force the ESP32 inside the 10 mm GNSS keep-out, or put its 2.4 GHz antenna ~10 mm from the patch. The smallest defensible alternative is ~45 × 65 mm (45 × 45 GNSS zone, below the 50 × 50 optimum, gain penalty not quantified by u-blox).
2. **No simulation and no physical validation.** Like the dongle, the design is datasheet-derived and must pass bench bring-up before it goes near a car:
   - USB power;
   - charge-cycle with the NTC;
   - GNSS C/N0 against the P0 breakout;
   - IMU noise.
3. **ESP32 radio next to the GNSS.** SAM-M10Q out-of-band immunity is "0 dBm at 400–1460 MHz and 1710–3300 MHz" at the antenna feed. The ESP32 transmits up to +20.5 dBm about 45 mm away on the same ground plane. The coupled level was not computed and must be **measured**: UBX-NAV-SAT C/N0 and UBX-MON-SPAN with the radio off, BLE only, and WiFi TX. Mitigations, in order:
   1. firmware TX-power cap (BLE ≤ 9 dBm, WiFi ≤ 13 dBm);
   2. 4-layer rebuild;
   3. longer board.
4. **Cell temperature (TS), review rev2.** Two independent layers; neither alone keeps every corner inside 0–45 °C, so both are binding.
   - **Layer 1, hardware (BQ24073 TS, always active).** TS reads the pack NTC through J2.3. SLUS810N electrical characteristics ("BATTERY-PACK NTC MONITOR"): I_NTC = **72 / 75 / 78 µA** (min/typ/max), V_HOT = **270 / 300 / 330 mV** (falling), V_COLD = **2000 / 2100 / 2200 mV** (rising), hysteresis 30 mV / 300 mV, 50 ms deglitch. NTC tolerances (required pack type): R25 **±1 %**, B25/50 **±1 %**; resistors ±1 %. Charging is suspended when I·R < V_HOT (hot) or I·R > V_COLD (cold).
   - **Can a threshold network (TI Fig. 9-9, Rs/Rp) pull the window inside 0–45 °C? No.** TI states it directly (SLUS810N §9.3.6): "The temperature window cannot be tightened more than using only the thermistor connected to TS, it can only be extended." Numerically: a guaranteed stop at ≥ 45 °C and at ≤ 0 °C needs R_eq,min(0 °C) / R_eq,max(45 °C) ≥ V_COLD,max / V_HOT,min = 2.2 / 0.27 = **8.15** (8.83 if I_NTC is taken independently at the two trips). A bare NTC gives exp(B·(1/273.15 − 1/318.15)) with B at −1 %: **5.82 for B3435, 7.58 for B3950**; any series or parallel resistor lowers that ratio further. An exhaustive E96 search (Rs 0–10 kΩ, Rp 1 kΩ–10 MΩ or none) with all tolerance corners confirms it: holding the cold corner ≥ 0 °C, the best hot corner is 51.3 °C (B3950, Rp 442 kΩ, no useful gain over bare), 49.1 °C (B4250), 103 °C (B3435). So **no network is fitted**, and the required NTC is the one with the best bare window.
   - **Worst-case hardware windows (bare NTC, all tolerances above, β model):**

     | Pack NTC | Nominal window | Cold trip range | Hot trip range | Worst-case window |
     |---|---|---|---|---|
     | **10k B3950 (required)** | 3.5–47.2 °C | 1.4…5.6 °C | 43.2…51.5 °C | **1.4–51.5 °C** |
     | 10k B3435 (103AT) | 0.5–50.8 °C | −1.8…2.9 °C | 46.1…55.9 °C | −1.8–55.9 °C |

     With the required B3950 the hardware cold corner is safe (≥ 1.4 °C); the **hot corner can reach 51.5 °C**, above a 45 °C cell rating. The hardware layer alone therefore does **not** meet the 0–45 °C target; it is the backstop for a firmware failure while CE is enabled.
   - **Layer 2, firmware supervision (binding, §6).** CE is pulled high (charging disabled) by R18 and only Q1, driven by GPIO37, enables it; R19 keeps it disabled through reset, boot, an unflashed MCU and with 3V3 off. Firmware reads V_TS on GPIO6 and enables charging only inside **5–40 °C**. Error budget (B3950, I_NTC ±4 %, ADC ±15 mV after calibration (to be confirmed in §10A test 3), NTC ±1 %/±1 %): **±2.4 °C at 40 °C** and **±1.4 °C at 5 °C**, so the firmware window is at worst **3.6–42.4 °C**, inside 0–45 °C. A B3435 pack read with the B3950 equation shifts to ≈ 2.2–42.4 °C nominal, worst ≈ 0.8–44.8 °C: still inside 0–45 °C, with less margin; that is why B3950 is the named type.
   - **What remains:** if firmware enables charging and then hangs without the watchdog resetting it, only layer 1 acts (≤ 51.5 °C). The pack NTC's thermal lag to the cell is not modelled. §10A test 3 measures the real trip points. A fully hardware-only 0–45 °C guarantee would need an extra window comparator on TS driving Q1's gate (not in rev A; proposed for rev B).
5. **No reverse-polarity protection on J2.** A reversed LiPo destroys U4 and U6. Mitigations: silkscreen polarity, check every pack. The cell must also have its own protection PCM, because nothing on the board cuts off at under-voltage (the LDO simply drops out). **Firmware requirement (binding for the firmware ticket):** measure VBAT on ADC1 and enter deep sleep with the radios off below **3.5 V** under load, and do not start WiFi below **3.6 V**. These thresholds are an estimate, not a proven headroom (§2 LDO row); §10A test 2 decides whether they are high enough. The PCM stays the last-resort cutoff.
6. **SAM-M10Q stock is 10 pieces** at JLCPCB/LCSC (2026-09-24). Enough for 2 boards, but it can vanish before ordering. Fallback: JLCPCB global sourcing or consignment of Mouser/DigiKey parts. Re-check stock on the order day.
7. **Battery life** is estimated at ~5–10 h (§7), below dragy's 12 h, until a larger cell or modem-sleep firmware closes it.
8. **Charging in a hot car stops at 40 °C cell temperature (firmware, §6), with the BQ's TS trip (47.2 °C nominal, ≤ 51.5 °C worst case, §10.4) as the hardware backstop.** This is intended for safety. The pod runs from USB without charging. Operating limits are 85 °C for ESP32-S3-MINI-1 (N8 standard temp), SAM-M10Q and LSM6DSV16X. A windscreen in summer sun can exceed that. The enclosure (P2) needs shading and venting.
9. **USB current is fixed at 500 mA.** There is no CC-level sensing, so a 3 A USB-C car port is used as a 500 mA port. Rev B can route CC1/CC2 to ADC pins and drive EN1/EN2 through level-safe logic.
10. **Flashing requires SW3 ON.** With SW3 OFF the MCU is unpowered even on USB (the charger still charges).
11. **Mount orientation.** The patch radiates away from the component side. The pod must hold the component side toward the sky and glass, which constrains the P2 mount design (§11.2).

## 10A. Bring-up validation (mandatory before trusting the board)

Review rev2: USB signal integrity, low-battery supply headroom, the real charge-temperature trip points and GNSS/WiFi coexistence cannot be closed on paper. Every board is untrusted until these pass on **2 boards**. Record the numbers in the bring-up log.

| # | Test | Setup | Pass / fail |
|---|---|---|---|
| 1 | **USB enumeration and flashing** | 2 boards; a 1 m USB-C cable and a USB 2.0 hub, plus one direct laptop port; esptool at 921 600 baud. | Enumerates as USB-Serial/JTAG on first plug-in on both ports, **10 of 10** full flash + verify cycles pass on each board, and a 10-minute serial log shows no disconnects. Any failure = fail (review the pair, rev B gets a 4-layer or controlled-impedance pair). |
| 2 | **3V3 during WiFi TX bursts** | Scope (≥ 100 MHz, 10× probe, short ground spring) on U1.3 and U2.17 (VCC) to GND; firmware in continuous 802.11b TX at max power, BLE advertising and GNSS on. (a) USB only, no cell; (b) cell at VBAT = 3.5 V under load (bench supply on J2 with 0.1 Ω series to emulate cell + wiring). | Minimum of 3V3 at the module pins **≥ 3.0 V** in both cases over 60 s (infinite persistence), no brown-out reset. If (b) fails, raise the firmware cutoff (§10.5) until it passes; if (a) fails, the USB-only mode is not supported. |
| 3 | **Charge temperature trips** | Cell with the required B3950 NTC; thermocouple taped to the cell next to the NTC; hair dryer to heat, fridge/freezer to cool; CHG LED and battery current (series meter) logged. First with firmware supervision, then with CHG_EN forced high (firmware disabled) to measure the hardware backstop. Also check whether TS is biased while CE is high (V_TS with CE disabled). | Firmware: charging stops at **≤ 42.4 °C** and **≥ 3.6 °C** cell temperature, and restarts with hysteresis. Hardware backstop: stops at ≤ 51.5 °C and ≥ 1.4 °C (§10.4). ADC error ≤ ±15 mV against a DMM at 0.4 V and 1.9 V. Any trip outside those = fail. |
| 4 | **GNSS C/N0 with WiFi TX on vs off** | Board on the windscreen mount outdoors, open sky, 10 min warm-up; u-center / UBX-NAV-SAT logging; 10 min with WiFi TX idle, then 10 min with continuous TX at the firmware's capped power (BLE ≤ 9 dBm, WiFi ≤ 13 dBm). | Median C/N0 of the 8 strongest satellites drops by **≤ 2 dB** with TX on, and fix/satellite count is unchanged. More = fail (reduce TX power, add shielding, or rev B layout). |

## 11. Open questions and verification list

### 11.1 Lead decisions challenged

- **~50 × 40 mm board: not achievable with u-blox's ground-plane and keep-out guidance. Replaced by 50 × 66.95 mm (72 mm with the antenna overhang; §2, §10.1). Needs LEAD sign-off.**
- V_BCKP: neither of the two offered options (3V3 rail or supercap) was chosen. A third one was, justified in §2.
- The rev-0.1 proposal said "4-layer (GNSS RF needs a solid ground)". Rev A is 2-layer because the integrated-antenna SAM-M10Q has no RF trace and a solid bottom GND is achievable. 4-layer stays the fallback (§10.3).

### 11.2 Field facts to get from the owner (not to be guessed)

- Does the Supra's windscreen have a metallised / athermic / heated coating, or an uncoated "sensor window" behind the mirror? Coatings attenuate GNSS.
- Where on the windscreen will the pod sit, and what cell size fits the planned enclosure (target ≥ 1000 mAh)?

### 11.2a Documented deviations (accepted for rev A, review rev2)

- **V_IO / VCC are not tied at the module** (§8): both lanes are 3V3 and join on the trunk ≥ 20 mm away. Their transient voltages are not independently validated; §10A tests 2 and 4 cover the effect.
- **U1 GND pins are one jumper group in the footprint** (module-internal common ground). This lets DRC pass for GND pins joined only through the module; it does not prove the board-side return paths. Measured on the generated board: the pours reach every U1 GND pad directly except **U1.63 and U1.64** (the two south corner pads), which rely on the module-internal ground. Three small bottom fill fragments in the north-east W–E line bundle carry GND stitching vias but touch no pad (floating copper, DRC-clean); remove them in rev B.
- **Power-track widths** follow the as-built rule table in §8, not a blanket 0.5 mm.

### 11.3 VERIFY-AT-LAYOUT (could not be text-verified; image-only PDFs)

- J1 HRO TYPE-C-31-M-12 pad naming vs the KiCad footprint (datasheet: https://datasheet.lcsc.com/datasheet/pdf/9e56b777c022540fcce7c7f67825f55e.pdf?productCode=C165948).
- SW1/SW2 TS-1187A-B-A-B: which pad pairs are internally shorted. Wire one pair to the signal and the other to GND. Datasheet: https://datasheet.lcsc.com/datasheet/pdf/56c8799ae5193945a16a1ffbe378246a.pdf?productCode=C318884.
- SW3 SS-12D00-G3: the middle pin is the common in the SOFNG circuit diagram (image). Confirm before routing LDO_EN to it.
- SAM-M10Q bypass capacitors: u-blox text gives no value, and the IM typical-design figure (Fig. 28) is a graphic I could not extract. C9 4.7 µF + C10 100 nF is our choice. Compare against Fig. 28 when drawing the schematic.
- LSM6DSV16X: verified against DS13510 **Rev 4** (LCSC copy). The st.com download timed out, so check ST's current revision for pin-map changes (unlikely).

## 12. Sources (all accessed 2026-09-24)

- u-blox SAM-M10Q Data sheet UBX-22013293 **R05** (08-Apr-2024): https://content.u-blox.com/sites/default/files/documents/SAM-M10Q_DataSheet_UBX-22013293.pdf
- u-blox SAM-M10Q Integration manual UBX-22020019 **R02** (01-Jun-2023): https://content.u-blox.com/sites/default/files/documents/SAM-M10Q_IntegrationManual_UBX-22020019.pdf
- ST LSM6DSV16X datasheet DS13510 Rev 4: https://www.st.com/resource/en/datasheet/lsm6dsv16x.pdf (verified from the LCSC copy: https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/2309061516_STMicroelectronics-LSM6DSV16XTR_C5267406.pdf)
- Espressif ESP32-S3-MINI-1 & MINI-1U Datasheet **v1.7**: https://www.espressif.com/sites/default/files/documentation/esp32-s3-mini-1_mini-1u_datasheet_en.pdf
- Espressif ESP32-S3 Series Datasheet **v2.2** (strapping, reset states, power-up glitches Table 2-2, ADC ranges): https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf
- Espressif ESP32-S3 Hardware Design Guidelines, schematic checklist: https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/schematic-checklist.html
- Espressif ESP32-S3 Hardware Design Guidelines, PCB layout: https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/pcb-layout-design.html
- TI BQ2407x SLUS810N (Oct 2021): https://www.ti.com/lit/ds/symlink/bq24075.pdf
- TI TLV757P SBVS322C (Mar 2024): https://www.ti.com/lit/ds/symlink/tlv757p.pdf
- Torex XC6206 (LCSC copy): https://datasheet.lcsc.com/datasheet/pdf/221c990eb3a74b8a8233f22168ce0d59.pdf?productCode=C5446
- ST USBLC6-2 Doc ID 11265 Rev 5 (LCSC copy): https://datasheet.lcsc.com/datasheet/pdf/0d3a2ab954b34651a0695e7ccf534db0.pdf?productCode=C7519
- SOFNG SS-12D00 (LCSC copy): https://datasheet.lcsc.com/datasheet/pdf/7357551f1ab94cd5763cc9d7033faef8.pdf?productCode=C22355741
- Part stock, price and library type: `https://jlcpcb.com/partdetail/<LCSC code>` and `https://www.lcsc.com/product-detail/<LCSC code>.html` (JLCPCB parts API, 2026-09-24)
- JLCPCB PCBA pricing: https://jlcpcb.com/help/article/pcb-assembly-price
