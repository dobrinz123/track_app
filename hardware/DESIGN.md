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
