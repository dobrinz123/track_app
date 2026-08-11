# TRACE OBD Telemetry Dongle — Hardware Design (rev A, 2026-08-11)

LEAD-authored binding design for the first prototype. Workers materialize this
into schematic (schemdraw SVG + KiCad), PCB (KiCad, 2-layer, JLCPCB assembly),
and enclosure (OpenSCAD -> STL). READ-ONLY on the vehicle bus by design intent;
firmware enforces listen-mode where possible (P4c firmware ticket, separate).

## 1. Architecture

OBD-II (J1962) plug -> protection -> 12V->3.3V buck -> ESP32-C3 module
                    -> CAN transceiver (3.3V) on OBD pins 6/14 (CAN-H/CAN-L)
WiFi AP: ESP32-C3 SoftAP -> TCP server :35000 -> phone (TRACE app, existing
ELM327-compatible transport OR native protocol later; prototype speaks a
minimal ELM327-compatible subset so the shipped app works unmodified).

## 2. Component selection (JLCPCB-assemblable, LCSC parts)

| Ref | Part | LCSC | Why |
|---|---|---|---|
| U1 | ESP32-C3-MINI-1-N4 | C3013922 | WiFi+RISC-V, tiny, TWAI(CAN) controller built in, castellated (hand-solder fallback) |
| U2 | TJA1051T/3 (3.3V IO) | C264757 | Automotive-qualified CAN transceiver (better than SN65HVD230 for 12V car env), 3.3V VIO variant |
| U3 | TPS54202DDCR buck | C316922 | 4.5-28V in, 2A sync buck: survives 12-14.4V nominal + transients w/ input protection below |
| D1 | SMBJ24A TVS | C114213 | Load-dump / transient clamp on 12V input (ISO 7637 reality on cars) |
| D2 | SS34 Schottky | C8678 | Reverse-polarity series protection (simple + robust at 150mA load) |
| F1 | 0603 PTC 350mA | C88724 | Resettable fuse on 12V input |
| U4 | AMS1117-3.3 OMITTED — buck goes direct to 3.3V (single rail; ESP32-C3 + TJA1051 both 3.3V) |
| C-group | 22uF/35V x2 in, 22uF/10V x2 out, 100nF decoupling x4 | basic parts | buck app-note values |
| L1 | 10uH 2A shielded 0630 | C167219 | buck inductor per TPS54202 datasheet 500kHz |
| R-group | buck FB divider 100k/13k (3.3V), CAN term NOT fitted (node, not end), 10k EN pullups | basic | |
| J1 | OBD-II male plug, PCB right-angle (through-hole) | C718401 (or harness pigtail fallback) | direct-plug dongle |
| J2 | 1x6 2.54mm header (3V3, GND, TX, RX, IO9/BOOT, EN) | basic | UART programming |
| SW1 | side tact switch on IO9 | C318884 | BOOT strap for flashing |
| LED1/2 | 0603 green (power) / amber (activity) + 1k | basic | status |

Notes:
- CAN termination: NOT fitted (the car bus is already terminated; a dongle is a
  stub node). Footprint R120 left unpopulated (DNP) for bench testing.
- OBD pin 16 = +12V batt, pins 4/5 = GND, pin 6 = CAN-H, pin 14 = CAN-L. All
  other J1962 pins unconnected rev A (K-line etc. out of scope).
- ESP32-C3 TWAI uses two GPIO: IO4 = CAN TX -> U2.TXD, IO5 = CAN RX <- U2.RXD.
- U2.S (silent mode, pin 8 on TJA1051T/3) tied to IO6 so firmware can force
  LISTEN-ONLY in hardware — read-only mandate enforceable below software.
- Power budget: ESP32-C3 WiFi peak ~350mA @3.3V -> buck 2A has 5x headroom.

## 3. Netlist (binding, schematic + PCB must match exactly)

12V_RAW:   J1.16 -> F1.1
F1.2 -> D2.A;  D2.K -> VIN_PROT
D1: VIN_PROT -> GND (TVS clamp, SMBJ24A)
VIN_PROT -> U3.VIN, C_in x2 (22uF/35V) VIN_PROT->GND
U3: TPS54202 per datasheet: BST cap 100nF SW->BST, L1 SW->VOUT_3V3,
    FB divider VOUT_3V3 -100k- FB -13k- GND, C_out x2 22uF VOUT_3V3->GND,
    EN -> VIN_PROT via 100k + 24k to GND (UVLO ~8V so a dying car battery
    browns out cleanly instead of brownout-looping the ESP32)
GND:       J1.4, J1.5 -> GND plane
3V3 rail:  U1.3V3 (+100nF+10uF), U2.VCC (+100nF), LED1 via 1k -> GND
U1 ESP32-C3-MINI-1: EN -> 10k to 3V3 + 1uF to GND; IO9 -> 10k pullup + SW1 to GND;
    IO4 -> U2.TXD; IO5 <- U2.RXD; IO6 -> U2.S; IO8 -> LED2 via 1k;
    TXD0/RXD0 -> J2 UART; 3V3/GND -> J2
U2 TJA1051T/3: CANH -> J1.6, CANL -> J1.14, VCC=3V3, GND, S=IO6, VIO=3V3 (T/3 variant)
    R120 DNP between CANH-CANL
ESD: PESD2CAN (C24911) across CANH/CANL to GND (D3) — automotive ESD on the bus pins

## 4. PCB constraints (binding)

- 2-layer, 1.6mm FR-4, HASL, 55 x 25 mm max (fits J1962 plug shell + enclosure).
- J1 (OBD plug) at board edge; ESP32-C3 antenna edge OPPOSITE the connector,
  antenna keep-out per module datasheet (no copper under antenna zone).
- Buck section compact loop (C_in -> U3 -> L1 -> C_out) away from CAN pair.
- CANH/CANL routed as differential pair, short, straight to J1.
- GND pour both layers, stitching vias; TVS/PTC at the connector entry.
- JLCPCB assembly: all SMD top side; J1/J2/SW1 may be through-hole/hand.

## 5. Deliverables map

- hardware/schematic/trace-dongle.svg        (schemdraw render, human-review)
- hardware/kicad/trace-dongle/               (KiCad 9 project: .kicad_sch/.kicad_pcb,
                                              ERC+DRC clean via kicad-cli)
- hardware/kicad/trace-dongle/production/    (gerbers.zip, drill, bom.csv, cpl.csv
                                              — JLCPCB-format)
- hardware/enclosure/trace-dongle-case.scad  (parametric: body + lid, snap-fit,
                                              OBD plug aperture, LED light pipes,
                                              vent slots; 3D-print no-support)
- hardware/enclosure/*.stl                   (openscad -o renders)

## 6. Honest limitations (rev A)

- Board is designed to standard practice + datasheet app-notes, ERC/DRC-clean,
  but NO electrical simulation and NO physical validation yet — first article
  must be bench-tested (12V supply + CAN generator) before plugging into a car.
- ELM327-subset firmware is P4c-firmware scope, not this campaign.
- J1962 plug part availability varies; fallback documented: pigtail cable
  (OBD plug w/ leads) soldered to 5 pads (12V, GND, GND, CANH, CANL) — the PCB
  provides both the connector footprint AND the 5-pad fallback row.

## 7. Rev A2 amendments (LEAD, 2026-08-11 — routability unlock after HW2 wave 1)

- Board envelope RAISED to 62 x 30 mm max (was 55 x 25; case width is governed by
  the 38mm plug aperture anyway, so PCB width up to ~32mm costs nothing — the
  parametric enclosure re-renders). Use the extra area for spacing, not parts.
- SW1 may move anywhere along either long edge (do not co-locate with the
  U2/D3 CAN cluster).
- BINDING pin maps (LEAD-supplied from standard datasheets; report if any
  KiCad footprint numbering disagrees):
  U2 TJA1051T/3 (SO8): 1=TXD, 2=GND, 3=VCC, 4=RXD, 5=VIO, 6=CANL, 7=CANH, 8=S
  U3 TPS54202 (SOT-23-6 DDC): 1=BOOT, 2=GND, 3=FB, 4=EN, 5=VIN, 6=SW
  D3 PESD2CAN (SOT-23): 1=CANL line, 2=CANH line, 3=GND (common cathode)
- DRC fine-rule allowance near U1 castellated pads only: clearance may drop to
  0.15mm locally. Everywhere else the 0.2mm rule stands.

## 8. Rev A3 (LEAD, 2026-08-11 — NO-GO remediation; supersedes conflicting earlier sections)

Source of truth for every value below: the datasheets cited in the Codex NO-GO
review (.foreman/scratch/hwpkg-review-out.log). LEAD's earlier from-memory U3
pin map was WRONG — everything here is datasheet-derived, and the fix worker
must re-verify each pin map and LCSC number against the live datasheet/LCSC
page (web) before applying. No more from-memory electrical facts.

1. U3 TPS54202DDC CORRECT pin map: 1=GND, 2=SW, 3=VIN, 4=FB, 5=EN, 6=BOOT.
2. FB divider for 3.3V (Vref 0.596V): 100k / 22.1k 1% (replaces 13k).
3. EN/UVLO divider for ~8.0V rising: 137k (nearest E96 to 136.6k) / 24k.
4. CAN transceiver REPLACED: TJA1051T/3 out (VCC needs 4.5-5.5V). Use a TRUE
   3.3V-VCC transceiver WITH a silent-mode pin so the hw listen-only feature
   survives: first choice TCAN330DR (SOIC-8: 1=TXD,2=GND,3=VCC,4=RXD,5=S,
   6=CANL,7=CANH,8=SHDN — VERIFY on TI datasheet), SHDN tied to GND, S -> IO6.
   Fallback if LCSC stock fails: SN65HVD230DR (Rs pin via 10k to GND; hw
   silent-mode lost -> document that firmware guard is then the only layer).
   Single 3.3V rail stays.
5. D2 orientation on BOARD: KiCad D_SMB pad 1 = cathode -> pad 1 must carry
   VIN_PROT, pad 2 (anode) carries F1 side. Fix net assignment or rotation;
   same review for LED1/LED2 polarity (pad 1 = cathode -> to GND side... NO:
   verify per KiCad LED_0603 convention pad 1 = cathode; wire cathode to GND,
   anode to resistor).
6. TVS: SMBJ24A out. SMBJ18A (standoff 18V > 14.4V nominal, clamp ~29.2V
   <= TPS54202 Vin abs max 30V) placed BEFORE D2 (right at F1 output) so it
   clamps negative pulses via forward conduction too. C_in rating: see 8.
7. LED2 moved OFF strapping pin IO8 -> IO7 (non-strapping). IO8 gets a 10k
   pullup to 3V3 only (boot-mode high). firmware/src/status_led.cpp pin
   updated to IO7.
8. C_in: 22uF/35V in 0603 is not a real part. Use 2x 10uF/50V X7R 1210
   (VERIFY LCSC basic-part availability); C_out 2x 22uF/10V X7R 0805+.
9. BOM: EVERY row gets a real LCSC part number (verify each exists and is
   in-stock basic/extended on the live site; prefer basic parts). No blank
   LCSC cells in production/bom.csv.
10. Antenna keepout: both-layer copper/zone keepout under the U1 antenna area
    per module datasheet, as a real KiCad rule/keepout zone object.
11. J1: rev A is PIGTAIL-ONLY (5-pad row) — declared, not pretended; the
    direct-plug J1962 footprint is deferred to rev B.
12. Firmware: accept spaced custom-PID hex ("22 1E 0C") like the app does;
    correlate CAN responses (match positive-response service byte 0x41/0x61/
    0x62 + echoed PID/DID to the request) instead of first-frame-wins.

## 9. Rev A4 (final hardware fix wave, 2026-08-11 — NO-GO reverdict remediation)

Source of truth: the reverdict review (.foreman/scratch/hwpkg-reverdict-out.log,
"New defects in the remediation diff" + the M1/H6-PARTIAL notes above it).
Every part/value below is live-verified against LCSC/datasheet pages (see
generate_board.py's LCSC dict comments and the ticket report for URLs).

1. F1: C910820 (16V) was rating-uncoordinated with the 18V-standoff SMBJ18A
   TVS and automotive transients. Replaced with C910821 (BSMD0805-035-24V,
   BHFUSE): 24V max, 350mA hold, 750mA trip, 0805 — footprint grown
   0603->0805 to match.
2. SW1: footprint corrected to Panasonic_EVQPUL_EVQPUC (the KiCad std-lib
   family for EVQPUC02K/C79174) — was Panasonic_EVQPUJ_EVQPUA, a different,
   pad-incompatible Panasonic side-tact variant.
3. Enclosure: trace-dongle-case.scad pcb_l updated 62->68 to match the
   board's actual rev A3 envelope; STLs/preview re-rendered.
4. Antenna keepout: enlarged to the antenna footprint's real F.Fab-line
   extent (local Y -11 to -5.6, X -6.6 to 6.6 in
   fp-lib/TRACE-Custom.pretty/ESP32-C3-MINI-1.kicad_mod) plus a 1mm margin,
   instead of the old undersized manually-picked rectangle. U1_EN's and
   3V3's routes through that corner were rerouted around it.
5. J1/J2: excluded from production/cpl.csv (hand-solder, not JLCPCB
   machine-placed) via generate_production_csv.py; bom.csv comment column
   says "hand-solder"; real correctly-sized in-stock LCSC headers used —
   J1 Samtec TSW-105-07-T-S (1x5, C5967238), J2 Samtec HTSW-106-07-T-S
   (1x6, C6209271) — replacing the generic C2337 40-pin cut-to-length strip.
6. C2 (buck input cap): relocated immediately west of U3's VIN pin (pin 3)
   instead of sitting on the C1<->C2 row 8mm+ away, per TI's close-placement
   guidance; VIN_PROT now reaches U3.3 in a single short 2-via hop. R3/R4
   (EN divider) shifted 4mm west to make room.
7. UVLO divider: R3/R4 changed from 133k/24k (0.337V hysteresis, below TI's
   >0.5V recommendation) to 274k/44.2k E96 values (C22968/C23056, both in
   LCSC stock): Vstart=8.519V, Vstop=7.950V, hysteresis=0.569V, solved from
   the TPS54202 datasheet's EN/UVLO equations (Ip=0.7uA, Ih=1.55uA,
   VENrising=1.21V, VENfalling=1.19V — SLVSD26C section 6.3.5). See ticket
   report for the full derivation.

Two script-level fixes surfaced while re-verifying the board after the SW1
footprint swap (not separate reverdict findings, but required for a clean
DRC): the SW1 same-numbered-pad bridge helper in generate_board.py now
skips the new footprint's NPTH mounting-hole pads (empty pad number) rather
than wiring a netless track between them, and two nearby IO9_BOOT/3V3
routes were nudged to clear those same NPTH holes.
