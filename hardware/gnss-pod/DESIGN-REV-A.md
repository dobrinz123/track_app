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
                                          │ BAT ◄──► J2 1-cell LiPo (JST-PH, hand-soldered)
                                          │                └──► U6 XC6206 (always on) ──► VBCKP ──► U2 V_BCKP
VSYS ──► U5 TLV75733P 1 A LDO (EN ← SW3 slide switch) ──► 3V3 ──► U1 ESP32-S3-MINI-1-N8
                                                             ├──► U2 SAM-M10Q (VCC + V_IO)
                                                             └──► U3 LSM6DSV16X (Vdd + Vdd_IO)
U2 UART  ◄──► U1 UART1 (GPIO38 TX / GPIO39 RX)   U2 TIMEPULSE ──► U1 GPIO21 (PPS)
U3 I2C 400 kHz ◄──► U1 (GPIO8 SDA / GPIO9 SCL)    U3 INT1/INT2 ──► U1 GPIO10/GPIO11
U1 USB (GPIO19 D- / GPIO20 D+) ──► USB-C: flashing, serial console, power
```

There is no external NAND (that is rev B), no CAN and no USB-UART bridge.

## 2. Decisions on the open points (and why)

| Point | Decision | Why (source) |
|---|---|---|
| Board size | **50 × 72 mm**, not ~50 × 40 | u-blox IM §4.4: the module goes "in the middle of a 50 x 50 mm GND size board", "significant degradation … smaller than 40 x 40 mm²", and "not to place anything closer than 10 mm to each edge". A 15.5 mm module plus 10 mm on every side already needs a 35.5 × 35.5 mm clear square. That leaves no room for the ESP32 (15.4 × 20.5 mm) at the far end of a 40 mm board. **The lead's ~50 × 40 target cannot meet the manual, see §10.1.** |
| GNSS ground plane | Full 50 × 50 mm GNSS zone plus the electronics zone (50 × 72 total copper) | u-blox allows a larger plane ("A larger ground plane can be used"). The datasheet sensitivity is specified "on a 50 x 50 mm² ground plane" (DS footnote 12). **Expected penalty from board size: none relative to the datasheet.** The real penalties come from the enclosure, the windscreen and the ESP32 radio (§10). |
| Layer count | **2-layer**, 1.6 mm FR-4 | Neither manual requires 4 layers. SAM-M10Q has an integrated antenna, so there is no 50 Ω RF trace. The ESP32-S3-MINI-1 carries its own RF. USB full-speed needs no controlled impedance. The IM layout example is a solid top-layer ground with short top-layer supply and digital lines, which a 2-layer board can do. The bottom layer stays solid GND under the whole GNSS zone (§8). 4-layer is a drop-in upgrade with the same schematic if bring-up shows GNSS C/N0 loss (§10.3). |
| Charger | **TI BQ24073RGTR** (power-path, TS/NTC input) | Power-path (DPPM plus battery supplement) runs the pod from USB with a flat or missing cell. There is 6.6 V input OVP. The TS pin stops charging outside 0–50 °C, which matters for a LiPo behind a windscreen. The '73 variant regulates OUT at 4.4 V. The '75 variant regulates at 5.5 V, which is the TLV757P's absolute input limit and would triple LDO heat on USB. |
| 3.3 V LDO | **TI TLV75733PDYDR**, 1 A, SOT-23-5 with thermal pad | Espressif requires ≥ 0.5 A supply capability (module DS Table 6-2, "Current delivered by external power supply 0.5 A min"). The module's worst-case peak is 355 mA (802.11b at 20.5 dBm). A 1 A LDO with 1.2 A minimum current limit gives about 2× margin. Dropout is 425 mV max at 1 A, which keeps 3.3 V down to a partly discharged cell. The DYD package is 92.5 °C/W JEDEC against 231 °C/W for DBV. **No JLCPCB basic LDO qualifies.** The only basic 1 A part is AMS1117-3.3 (C6186), whose ~1 V dropout does not work from one LiPo cell. |
| V_BCKP | **Dedicated always-on XC6206P332MR (basic) from VBAT, via 0 Ω R17** | The SAM-M10Q backup domain keeps RTC and orbits (IM §4.1.3) and costs 28 µA typ in hardware backup mode (DS Table 15). Tying V_BCKP to the switched 3V3 rail gains nothing, because it dies with VCC. A supercap only lasts hours: 0.1 F from 3.3 V to 1.65 V at 28 µA is ~1.6 h. A 1 µA-Iq LDO from the cell keeps hot/warm-start data for months. That means fast fix acquisition at the track even after the pod sat switched off overnight. The cost is ~3 µA extra. R17 lets it be cut for current measurements. |
| Power switch | **SPDT slide switch SW3 drives the LDO EN pin** (ON = VSYS, OFF = GND) | The switch carries no load current, so a tiny THT switch is fine. Charging still works while the pod is off, because the BQ24073 is upstream of the switch. SYSOFF-style battery cut (BQ24075) was rejected: TI states that with SYSOFF high "When an adapter is connected, charging is also disabled", so a switched-off pod would not charge. |
| Battery divider | **1 MΩ / 1 MΩ, unswitched, 100 nF hold cap, to GPIO1 (ADC1_CH0)** | 4.2 V → 2.1 V, inside ADC ATTEN3's 0–2900 mV "effective measurement range" (S3 DS). It draws 2.1 µA at 4.2 V, about 30 years to drain 600 mAh, so a MOSFET switch buys nothing. It must be ADC1: "ADC2 … cannot be used with Wi-Fi simultaneously" (S3 DS §4.2.2.1). Source impedance 500 kΩ × max 50 nA leakage (module DS IIL) is ≤ 25 mV. Calibrate once. The 100 nF gives τ = 50 ms, fine for ≤ 1 Hz sampling. |
| Input current mode | **USB500 fixed** (EN1 = VSYS, EN2 = GND) | USB-C sink with Rd only: the default USB current is the only guaranteed budget. 450 mA min (BQ DS) covers the 355 + 20 mA 3V3 peak with no battery. With a cell, battery-supplement mode covers bursts. Firmware cannot change this in rev A (§10). |
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
| U5 | TI TLV75733PDYDR | C22399950 | Extended | 2,733 | 0.279 | 1 A LDO, 425 mV max dropout at 1 A, thermal-pad SOT-23-5 (§2). |
| U6 | Torex XC6206P332MR-G | C5446 | **Basic** | 462,690 | 0.142 | Always-on V_BCKP supply, Iq 1.0 µA typ / 3.0 µA max, Vin max 6.0 V. |
| U7 | ST USBLC6-2SC6 | C7519 | Extended | 38,410 | 0.176 | USB D+/D− and VBUS ESD (±8 kV contact per ST). Cheap insurance on a connector that gets plugged in daily in a car. |
| J1 | HRO TYPE-C-31-M-12 (USB 2.0 Type-C receptacle, 16 contacts) | C165948 | Extended | 98,780 | 0.186 | Listed as SMD. Has 4 shell tabs. JLCPCB-assembled; if JLCPCB rejects the shell tabs the owner hand-solders them (§9). |
| J2 | JST B2B-PH-K-S(LF)(SN), 2-pin 2.0 mm, top entry, THT | C131337 | (hand) | 211,787 | 0.035 | LiPo connector. **Hand-soldered by owner**, not in the CPL. |
| J3 | 1×8 2.54 mm pad row (3V3, GND, GPIO5, 6, 7, 14, 47, 48) | — | DNP | — | — | Spare pins for rev-A experiments (e.g. an SPI NAND breakout for logging trials). Bare pads, no part. |
| SW1 | XKB TS-1187A-B-A-B 5.1 × 5.1 mm SMD tact (BOOT, GPIO0) | C318884 | **Basic** | 520,986 | 0.021 | Download-mode strap. |
| SW2 | XKB TS-1187A-B-A-B (RESET, EN) | C318884 | **Basic** | (same) | 0.021 | Reset. |
| SW3 | SOFNG SS-12D00-G3 SPDT slide, THT, 3 mm pitch | C22355741 | (hand) | 9,605 | 0.059 | Power switch on the LDO EN pin (§2). **Hand-soldered by owner.** |
| RT1 | Murata NCP18XH103F03RB 10 kΩ NTC 0603 (B25/50 = 3380 K) | C13564 | Extended | 218,319 | 0.046 | BQ24073 TS input. The TI thresholds assume a 103AT-type (B ≈ 3435 K) curve. The trip points shift slightly (VERIFY on bench, §10.4). |
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
| R17 | 0 Ω 0402 | C17168 | Basic | 10,541,790 | 0.003 | V_BCKP supply link (remove to cut backup for measurement). |

Extended parts JLCPCB must load: U1, U2, U3, U4, U5, U7, J1, RT1, LED1 = **9 unique** (J2 and SW3 are hand-soldered and bought loose).

## 4. Netlist (binding, schematic + PCB must match exactly)

Net names in CAPS. `Ux.n` = pin number n (pin maps in §5).

```
GND:        U1.1,2,42,43,46-65 (+EPAD), U2.1,4,5,6,10,11,15,16,20, U3.6,7,
            U4.8 (VSS) + thermal pad, U5.2 + thermal pad, U6.1, U7.2,
            J1 GND contacts (A1,A12,B1,B12) + shell tabs, J2.2 (BAT-),
            all capacitor low sides, R1/R2/R14 low sides, RT1.2, SW1/SW2 one side, SW3 OFF throw

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
            R11 1.5k VSYS -> LED3 anode
U4.5  EN2  -> GND        (EN2=0, EN1=1 -> USB500 mode, 450-500 mA)
U4.4  CE   -> GND        (charge enabled)
U4.15 TD   -> GND        (termination enabled)
U4.14 TMR  -> no connect (TI: "Leave TMR unconnected to set the timers to the default values")
ISET:       U4.16 -> R9 3.3k -> GND
ILIM:       U4.12 -> R10 1.5k -> GND
TS:         U4.1 -> RT1 10k NTC -> GND
CHG_N:      U4.9 -> LED3 cathode           (LED3 lights while charging)
PGOOD_N:    U4.7 -> R12 100k -> 3V3; U4.7 -> U1.6 (IO2)

--- 3.3 V rail U5 TLV75733PDYDR ---
LDO_EN:     U5.3 (EN) -> SW3 common        (SW3: ON throw = VSYS, OFF throw = GND)
3V3:        U5.5 (OUT); C5 10uF 3V3->GND;
            U1.3 (3V3) + C6 22uF + C7 100nF at the pin;
            U2.17 (VCC) + U2.2 (V_IO) tied at the module + C9 4.7uF + C10 100nF;
            U3.8 (Vdd) + C14 100nF; U3.5 (Vdd_IO) + C15 100nF; U3.12 (CS) -> 3V3 (I2C mode);
            R5, R6, R7, R8, R12 high sides; J3.1
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
I2C_SDA:    U1.12 (IO8) -> U3.14 (SDA); R7 4.7k -> 3V3
I2C_SCL:    U1.13 (IO9) -> U3.13 (SCL); R8 4.7k -> 3V3
IMU_INT1:   U3.4 -> U1.14 (IO10)
IMU_INT2:   U3.9 -> U1.15 (IO11)
U3.1 (SDO/SA0) -> GND  (I2C address 1101010b = 0x6A)
U3.2 (SDx/AH1/Qvar1) -> GND, U3.3 (SCx/AH2/Qvar2) -> GND   (ST: "Connect to Vdd_IO or GND if the analog hub and Qvar are disabled")
U3.10 (OCS_Aux), U3.11 (SDO_Aux): no connect, pads soldered (ST mode 1: "Leave pin electrically unconnected and soldered to PCB")
LED1:       U1.16 (IO12) -> R15 1k -> LED1 anode; LED1 cathode -> GND
LED2:       U1.17 (IO13) -> R16 1k -> LED2 anode; LED2 cathode -> GND
U0TXD:      U1.39 (TXD0/GPIO43) -> TP13
U0RXD:      U1.40 (RXD0/GPIO44) -> TP14
Spare:      U1.9 (IO5), U1.10 (IO6), U1.11 (IO7), U1.18 (IO14), U1.27 (IO47), U1.30 (IO48) -> J3.3..8; J3.2 = GND
Strapping:  U1.7 (IO3), U1.41 (IO45), U1.44 (IO46): NO CONNECT (see §6)
All other U1 IO pins: no connect.

--- test pads (1.0 mm round, bottom side, electronics zone only) ---
TP1 3V3, TP2 GND, TP3 GND, TP4 VBAT, TP5 VSYS, TP6 VBUS, TP7 GNSS_TXD, TP8 GNSS_RXD,
TP9 PPS, TP10 I2C_SDA, TP11 I2C_SCL, TP12 GNSS_SAFEBOOT_N, TP13 U0TXD, TP14 U0RXD,
TP15 GNSS_RESET_N, TP16 EN, TP17 BOOT (IO0), TP18 VBCKP, TP19 IMU_INT1
```

Notes:

- SAFEBOOT_N / TIMEPULSE: pulling TP12 (or TP9) to GND while the GNSS powers up forces u-blox safeboot for firmware recovery. That is the only reason TP12 exists. Nothing on the board may pull PPS low at power-up.
- Hardware backup mode (u-blox DS): "In hardware backup mode (VCC = 0 V and V_IO = 0 V), PIOs must not be driven." With SW3 OFF the whole 3V3 domain (MCU included) is unpowered, so nothing drives the GNSS pins.
- Pin 1 of J2 is BAT+. LiPo pack wiring is not standardised: silkscreen **+** and **−** at J2 and check the pack before first plug-in (there is no reverse-battery protection, §10.5).

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
| 2 | SDx/AH1/Qvar1 | GND | 9 | INT2 | IO11 |
| 3 | SCx/AH2/Qvar2 | GND | 10 | OCS_Aux | NC, pad soldered |
| 4 | INT1 | IO10 | 11 | SDO_Aux | NC, pad soldered |
| 5 | Vdd_IO | 3V3 + 100 nF | 12 | CS | 3V3 (I2C enabled) |
| 6 | GND | GND | 13 | SCL | IO9 |
| 7 | GND | GND | 14 | SDA | IO8 |

Supply 1.71–3.6 V. I2C "fast mode (400 kHz) … as well as fast mode plus (1000 kHz)". 0.65 mA in combo high-performance mode.

### U1 — ESP32-S3-MINI-1-N8 (65 pads, 15.4 × 20.5 × 2.4 mm)
Source: module DS v1.7 Table 3-1. Only the pins this design uses are listed.

| Pad | Name | Pad | Name |
|---|---|---|---|
| 1, 2, 42, 43, 46–65 | GND | 23 | IO19 / USB_D− |
| 3 | 3V3 | 24 | IO20 / USB_D+ |
| 4 | IO0 (strap) | 25 | IO21 |
| 5 | IO1 (ADC1_CH0) | 27 | IO47 |
| 6 | IO2 (ADC1_CH1) | 30 | IO48 |
| 7 | IO3 (strap) | 34 | IO38 |
| 9, 10, 11 | IO5, IO6, IO7 | 35 | IO39 (MTCK) |
| 12, 13 | IO8, IO9 | 36 | IO40 (MTDO) |
| 14, 15 | IO10, IO11 | 37 | IO41 (MTDI) |
| 16, 17 | IO12, IO13 | 39 / 40 | TXD0 (GPIO43) / RXD0 (GPIO44) |
| 18 | IO14 | 41 | IO45 (strap) |
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
| 8 | 12 | I2C_SDA | io | no | yes | — | OK. A 60 µs low at power-up is a non-event for the IMU, which powers up at the same moment. |
| 9 | 13 | I2C_SCL | out | no | yes | IE | OK (same reason). |
| 10 | 14 | IMU_INT1 | in | no | yes | IE | OK. |
| 11 | 15 | IMU_INT2 | in | no | yes | IE | OK. |
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
| 5, 6, 7, 14, 47, 48 | 9, 10, 11, 18, 27, 30 | spare → J3 | — | no | 5–14 yes; 47/48 no | — | Free for experiments (e.g. an SPI NAND breakout). |

Firmware rules this implies (hand to the firmware ticket):

- Never configure GPIO21 as an output.
- Drive GPIO40 only as open-drain low for ≥ 1 ms to reset the GNSS, and remember that reset clears BBR.
- Read VBAT on ADC1 only, with ATTEN3 (0–2900 mV).
- UART1 on GPIO38/39 at up to 921,600 bit/s.
- Write the SAM-M10Q high-performance OTP string once during bring-up (IM Table 3) before expecting 20/25 Hz.

## 7. Power budget

Datasheet values are marked (DS). Everything else is an **estimate** until measured on the first article.

| Rail / load | Peak | Average (estimate) | Source |
|---|---|---|---|
| ESP32-S3-MINI-1 | 355 mA (802.11b TX, 20.5 dBm); BLE TX 20 dBm 340 mA | BLE-only hub at 160 MHz: ~70–90 mA. WiFi STA to MHD + BLE, no modem sleep: ~130–180 mA | DS Tables 6-4/6-5; modem-sleep 160 MHz single-core 39.9–54.6 mA (DS Table 6-6) + radio duty (estimate) |
| SAM-M10Q VCC + V_IO | 100 mA inrush at startup; 13 + 2.3 mA acquisition (4-GNSS) | ~10 + 2.3 mA tracking, plus the "minor increase" of the HP clock → budget 20 mA | DS Table 14 (1 Hz, 3.0 V) + IM §2.1.5 |
| LSM6DSV16X | 0.65 mA | 0.65 mA | DS features |
| LED1 + LED2 | ~1.3 mA each | ~1 mA | (3.3 − ~2.0 V) / 1 kΩ |
| I2C pull-ups | 0.7 mA each while low | < 0.5 mA | 3.3 V / 4.7 kΩ |
| **3V3 total** | **~380 mA** steady peak; ~480 mA only if GNSS inrush coincided with a full-power WiFi TX burst | **~95–115 mA** BLE-only; **~155–205 mA** with WiFi | LDO I_CL min 1.2 A: ≥ 2.4× margin over 480 mA; meets Espressif's ≥ 0.5 A |
| LDO dissipation (from VSYS = 4.4 V on USB) | (4.4 − 3.3) × 0.48 A = 0.53 W, a transient of milliseconds | 1.1 V × 0.15 A = 0.17 W → ~+15 °C at 92.5 °C/W | TLV757P θJA (DYD, JEDEC) |
| VSYS (BQ OUT) | 3V3 load + LED3 (≤ 1.6 mA) | ≈ 3V3 average | — |
| VBUS input | limited to 450–500 mA (USB500) | 3V3 average + charge current (DPPM shares it) | BQ DS |
| Battery charge | 241–295 mA (R9 = 3.3 kΩ) | — | K_ISET 797–975 A·Ω |
| VBCKP | ~3 µA while running; 28 µA typ in hardware backup | — | u-blox DS Table 15 + footnote 26 |
| **OFF-state battery drain** (SW3 OFF, no USB) | — | BQ IBAT(PDWN) ≤ 6.5 µA + LDO shutdown ≤ 1 µA + XC6206 ≤ 3 µA + GNSS backup 28 µA + divider 2.1 µA ≈ **≤ 41 µA** | → 1000 mAh lasts ~2.8 years (cell self-discharge dominates) |

Runtime estimate (VBAT current ≈ 3V3 current through an LDO):

| Cell | BLE-only (~105 mA) | WiFi + BLE (~180 mA) |
|---|---|---|
| 600 mAh | ~5.5 h | ~3.3 h |
| 1000 mAh | ~9.5 h | ~5.5 h |

dragy Pro advertises 12 h at 25 Hz. Matching it needs ≥ 1200 mAh or aggressive modem-sleep (§10.7).

## 8. PCB constraints (binding)

**Outline and stack.** 50.0 × 72.0 mm rectangle, 1.6 mm FR-4, 2-layer, 1 oz copper, HASL lead-free (or ENIG; LGA benefits from flatness, cost delta in §9). All SMD parts on the **top** side, so JLCPCB assembles one side only. Coordinates below: origin at the bottom-left corner, X along the 50 mm edge, Y along the 72 mm edge.

**Zones.**

- **Z1, GNSS zone, Y 0–50.**
  - U2 is centred at (25.0, 25.0). Its body spans X/Y 17.25–32.75.
  - **Component keep-out: X 7.25–42.75 and Y 7.25–42.75** (u-blox: nothing within 10 mm of any module edge). This applies to every part, including tall parts (> 3 mm: "at least 10 mm away").
  - Low-profile parts may sit in Z1 outside that box (Y 42.75–50 and the two 7 mm side strips).
  - No traces under the module on either layer.
  - Top layer: GND pour everywhere except the GNSS signal/supply traces.
  - **Bottom layer: solid, unbroken GND over all of Z1, no traces, no test pads.**
  - GND via field under the module (u-blox: "The GND plane below the module is filled with GND vias").
- **GNSS routing rule.** All U2 traces run on the **top layer only** until they are ≥ 20 mm from the module edge (IM: "keep at least 20 mm distance from the module edge when swapping any signal from the top to other layers"). That means no via on a GNSS net at Y < 52.75.
  - Orientation: rotate U2 so the pin 16–20 edge (VCC, RESET_N, EXTINT) faces +Y (the electronics). VCC is the only line with a series-resistance limit (< 0.2 Ω). For scale, a 0.5 mm × 30 mm 1 oz trace is ≈ 0.03 Ω.
  - Tie V_IO (pin 2) to VCC (pin 17) with a short top-layer trace around the module corner.
  - The remaining signal pins (TXD, RXD on one flank; TIMEPULSE, SAFEBOOT_N on the far edge; V_BCKP) run as thin traces hugging the module outline, then out to +Y.
  - The layout worker may rotate U2 by 90° steps if it shortens total top-layer GNSS routing. Record the choice here.
  - C9/C10/C11 are low-profile 0402s placed at the 10 mm boundary on the +Y side, not at the pins. u-blox gives no bypass value in text and its 10 mm rule takes precedence (§11.3).
  - GND pads may use 0.2 mm thermal reliefs (IM Fig. 22). Stencil 120 µm and mask 0.1 mm wider than the pads (IM §4.4.1).
- **Z2, electronics zone, Y 42.75–66.9.**
  - **U1 ESP32** is centred on X = 25 with its antenna end at the +Y board edge. Body pads span Y ≈ 51.5–66.9 and the antenna area Y ≈ 66.9–72.0.
  - **West half (X 0–15), power:** J1 USB-C on the west edge centred at Y ≈ 52, then U7 → U4 → U5 in a compact chain with C1/C2/C3/C4/C5. RT1 sits next to J2's position mirrored to the battery (see below).
  - **East half (X 35–50):** J2 (JST-PH) and SW3 (slide) on the east edge; U6; LED1/LED2/LED3 on the east edge for light pipes; SW1/SW2 near the east edge so enclosure pin-holes line up.
  - **U3 IMU at (25, ≈46.5)**, between the GNSS keep-out and U1. Keep it ≥ 10 mm from U4 and U5 (heat drift) and ≥ 5 mm from SW1/SW2 (button shock). Align its axes with the board edges and silkscreen the X/Y/Z arrows.
- **Z3, ESP32 antenna band, Y 66.9–72.0, full board width.**
  - **Copper keep-out on both layers** and component keep-out across the full 50 mm width. This extends the 15.4 × 5.05 mm module antenna area to the full width, which is the conservative reading of Espressif's "cut off the base board on both sides of the antenna" guidance without routing a slot.
  - The antenna feed end sits flush with the board edge.
  - Dense GND vias along Y = 66.5 on both sides of the module (Espressif: "Sufficient ground copper and dense ground vias … near the antenna").
  - In the product: ≥ 15 mm clearance from metal around the antenna (Espressif).

**Antenna separation.** The ESP32 antenna (Y 66.9–72) and GNSS patch (Y 17.25–32.75) are at opposite ends: ~34 mm edge-to-edge, ~45 mm centre-to-centre. That is the most a 72 mm board gives (see §10.3).

**Heat.** U4 and U5 go in the far west corner of Z2, away from U2 (u-blox: TCXO is sensitive to "co-located power devices … thermal conduction via the PCB") and away from U3.

**Ground and stitching.**
- Both layers are poured GND.
- Stitching vias (0.3 mm drill) every ≤ 5 mm along the board perimeter and in a ring around U2 outside the 10 mm keep-out.
- U1 EPAD gets thermal vias per Espressif land pattern Fig. 11-1.
- U4 and U5 thermal pads get ≥ 4 vias each to the bottom GND.

**Bottom layer in Z2.** GND pour, the test pads TP1–TP19, and short jumper traces (≤ 10 mm) only where top routing cannot close. Nothing on the bottom in Z1 or Z3.

**Mounting.**
- 4 × M2 NPTH holes (2.2 mm) at (3.5, 3.5), (46.5, 3.5), (3.5, 60.0), (46.5, 60.0).
- The Z1 holes are corner-only and outside the 10 mm keep-out.
- No mounting hole in Z3.
- The magnet of any magnetic mount (P2 enclosure) must sit behind Z2, never behind Z1 or Z3.

**Rules.** 0.2 mm clearance / 0.2 mm track minimum. Power tracks VBUS/VSYS/VBAT/3V3 ≥ 0.5 mm. Castellation-area fine-rule exceptions like the dongle's are allowed at U1 pads only.

## 9. Hand-solder list, and cost estimate (5 PCBs, 2 assembled)

**Hand-soldered by the owner** (not in the CPL, bought loose from LCSC):

1. J2 JST B2B-PH-K-S (C131337), 2 THT pins.
2. SW3 SS-12D00-G3 (C22355741), 3 THT pins.
3. Conditional: the 4 shell tabs of J1 if JLCPCB flags them as through-hole. The 12 signal pads are always machine-placed.

Everything fine-pitch or LGA (U1, U2, U3, U4 QFN, U5, U7, 0402s) is JLCPCB-assembled.

**Cost estimate.** JLCPCB Economic PCBA fees are quoted from `jlcpcb.com/help/article/pcb-assembly-price` on 2026-09-24. Part prices come from §3. **PCB fabrication price, shipping and taxes are estimates, not quotes.**

| Item | Basis | Estimate (USD) |
|---|---|---|
| 5 × bare PCB, 2-layer, 50 × 72 mm, HASL | JLCPCB standard; not quoted in the configurator | ~5–10 (ENIG +~15) |
| PCBA setup (Economic) | $8.18 | 8.18 |
| Stencil | $1.53 | 1.53 |
| Extended-part loading fee | 9 × $3.07 | 27.63 |
| SMT joints | ~2 × 240 joints × $0.0016 | ~0.80 |
| Parts for 2 boards | SAM 2 × 22.84 + ESP 2 × 4.71 + IMU 2 × 3.48 + BQ 2 × 0.90 + LDO 2 × 0.28 + USB-C, ESD, XC6206, NTC, LEDs, buttons 2 × ~0.70 + passives ~2 × 1.50 (plus JLCPCB attrition extras) | ~70 |
| Hand-solder parts, loose | 5 × JST + 5 × slide switch | ~0.50 |
| Shipping to Romania (courier) | estimate | ~20–30 |
| Import VAT and fees | Romanian standard rate on goods + shipping | not computed |
| **Total before VAT** | | **~135–160** |

A 1-cell LiPo (600–1200 mAh, **with a protection circuit**) is not included. Buy it locally.

## 10. Honest limitations and risks (rev A)

1. **Board size vs the lead's ~50 × 40 mm.** This board is 50 × 72 mm. A 50 × 40 board would put the GNSS below u-blox's 40 × 40 mm "significant degradation" limit. It would also force the ESP32 inside the 10 mm GNSS keep-out, or put its 2.4 GHz antenna ~10 mm from the patch. The smallest defensible alternative is ~45 × 65 mm (45 × 45 GNSS zone, below the 50 × 50 optimum, gain penalty not quantified by u-blox).
2. **No simulation and no physical validation.** Like the dongle, the design is datasheet-derived and must pass bench bring-up before it goes near a car:
   - USB power;
   - charge-cycle with the NTC;
   - GNSS C/N0 against the P0 breakout;
   - IMU noise.
3. **ESP32 radio next to the GNSS.** SAM-M10Q out-of-band immunity is "0 dBm at 400–1460 MHz and 1710–3300 MHz" at the antenna feed. The ESP32 transmits up to +20.5 dBm about 45 mm away on the same ground plane. The coupled level was not computed and must be **measured**: UBX-NAV-SAT C/N0 and UBX-MON-SPAN with the radio off, BLE only, and WiFi TX. Mitigations, in order:
   1. firmware TX-power cap (BLE ≤ 9 dBm, WiFi ≤ 13 dBm);
   2. 4-layer rebuild;
   3. longer board.
4. **NTC placement.** RT1 is on the PCB, not in the cell (the lead fixed a 2-pin JST). It senses board temperature near the pack. The TI thresholds (0/50 °C) are tuned for a 103AT curve; Murata's B = 3380 K shifts them by roughly a degree (VERIFY on bench). Rev B could use a 3-pin pack with its own NTC.
5. **No reverse-polarity protection on J2.** A reversed LiPo destroys U4 and U6. Mitigations: silkscreen polarity, check every pack. The cell must also have its own protection PCM, because nothing on the board cuts off at under-voltage (the LDO simply drops out).
6. **SAM-M10Q stock is 10 pieces** at JLCPCB/LCSC (2026-09-24). Enough for 2 boards, but it can vanish before ordering. Fallback: JLCPCB global sourcing or consignment of Mouser/DigiKey parts. Re-check stock on the order day.
7. **Battery life** is estimated at ~5–10 h (§7), below dragy's 12 h, until a larger cell or modem-sleep firmware closes it.
8. **Charging in a hot car stops at 50 °C** (TS). This is intended for safety. The pod runs from USB without charging. Operating limits are 85 °C for ESP32-S3-MINI-1 (N8 standard temp), SAM-M10Q and LSM6DSV16X. A windscreen in summer sun can exceed that. The enclosure (P2) needs shading and venting.
9. **USB current is fixed at 500 mA.** There is no CC-level sensing, so a 3 A USB-C car port is used as a 500 mA port. Rev B can route CC1/CC2 to ADC pins and drive EN1/EN2 through level-safe logic.
10. **Flashing requires SW3 ON.** With SW3 OFF the MCU is unpowered even on USB (the charger still charges).
11. **Mount orientation.** The patch radiates away from the component side. The pod must hold the component side toward the sky and glass, which constrains the P2 mount design (§11.2).

## 11. Open questions and verification list

### 11.1 Lead decisions challenged

- **~50 × 40 mm board: not achievable with u-blox's ground-plane and keep-out guidance. Replaced by 50 × 72 mm (§2, §10.1). Needs LEAD sign-off.**
- V_BCKP: neither of the two offered options (3V3 rail or supercap) was chosen. A third one was, justified in §2.
- The rev-0.1 proposal said "4-layer (GNSS RF needs a solid ground)". Rev A is 2-layer because the integrated-antenna SAM-M10Q has no RF trace and a solid bottom GND is achievable. 4-layer stays the fallback (§10.3).

### 11.2 Field facts to get from the owner (not to be guessed)

- Does the Supra's windscreen have a metallised / athermic / heated coating, or an uncoated "sensor window" behind the mirror? Coatings attenuate GNSS.
- Where on the windscreen will the pod sit, and what cell size fits the planned enclosure (target ≥ 1000 mAh)?

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
