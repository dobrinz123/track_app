#!/usr/bin/env python3
"""
BINDING netlist of the TRACE GNSS Pod rev A, transcribed from
hardware/gnss-pod/DESIGN-REV-A.md section 4 (pin maps in section 5).

It is a single source of truth: generate_board.py assigns nets from it and
then re-reads every pad of the finished board and compares it against this
table (self_check). hardware/schematic/gnss-pod/generate_schematic.py draws
its connections from it too.

Pad-number conventions of the footprints used (verified, see footprints.py and
generate_board.py):
  U1 ESP32-S3-MINI-1: 1..60 perimeter, 61 = EPAD (9 sub-pads), 62..65 corners
  U4 RGT0016C: 1..16, 17 = thermal pad        U5 DYD0005A: 1..5, 6 = thermal pad
  J1 HRO TYPE-C-31-M-12: USB Type-C contact names, "SH" = 4 shell tabs
  SW1/SW2 TS-1187A: pad "1" = contacts A+B (internally shorted),
                    pad "2" = contacts C+D (internally shorted)
  SW3 SS-12D00-G3: 1 = ON throw, 2 = common (middle), 3 = OFF throw
  LEDx LED_0603: pad 1 = cathode, pad 2 = anode (KiCad convention)
  2-pin passives: pad 1 = the "from"/high side named first in the spec,
                  pad 2 = the other side (GND for every capacitor)
Net names follow section 4. The spec leaves a few internal nodes unnamed; they
get these names:
  VBCKP_SRC (U6.VOUT -> C13 -> R17), LED1_A/LED2_A (resistor -> LED anode),
  LED3_A (R11 -> LED3 anode), IO33/IO34/IO35/IO36/IO47 (spare pins -> J3),
  CHG_CE (U4.CE -> R18 / Q1 drain), CHG_EN (U1.33 IO37 -> Q1 gate / R19).
  Q1 SOT-23 2N7002: 1 = gate, 2 = source, 3 = drain.
"""

GND_U1 = ["1", "2", "42", "43"] + [str(n) for n in range(46, 66)]

NETS = {
    "GND": (
        [("U1", p) for p in GND_U1]
        + [("U2", p) for p in ("1", "4", "5", "6", "10", "11", "15", "16", "20")]
        + [("U3", "6"), ("U3", "7"), ("U3", "1"), ("U3", "2"), ("U3", "3")]
        + [("U4", "8"), ("U4", "17"), ("U4", "5"), ("U4", "15")]
        + [("U5", "2"), ("U5", "6"), ("U6", "1"), ("U7", "2")]
        + [("J1", "A1"), ("J1", "A12"), ("J1", "B1"), ("J1", "B12"), ("J1", "SH")]
        + [("J2", "2"), ("J3", "1")]
        + [("C%d" % n, "2") for n in range(1, 19)]
        + [("R1", "2"), ("R2", "2"), ("R14", "2"), ("R9", "2"), ("R10", "2")]
        + [("SW1", "2"), ("SW2", "2"), ("SW3", "3")]
        + [("LED1", "1"), ("LED2", "1"), ("Q1", "2"), ("R19", "2")]
        + [("TP2", "1"), ("TP3", "1")]
    ),
    # --- USB / input ---
    "VBUS": [("J1", "A4"), ("J1", "A9"), ("J1", "B4"), ("J1", "B9"), ("U7", "5"), ("U4", "13"),
             ("C1", "1"), ("TP6", "1")],
    "CC1": [("J1", "A5"), ("R1", "1")],
    "CC2": [("J1", "B5"), ("R2", "1")],
    "USB_DP_C": [("J1", "A6"), ("J1", "B6"), ("U7", "3"), ("U7", "4"), ("R3", "1")],
    "USB_DN_C": [("J1", "A7"), ("J1", "B7"), ("U7", "1"), ("U7", "6"), ("R4", "1")],
    "USB_DP": [("R3", "2"), ("U1", "24"), ("C17", "1")],
    "USB_DN": [("R4", "2"), ("U1", "23"), ("C18", "1")],
    # --- charger U4 ---
    "VBAT": [("J2", "1"), ("U4", "2"), ("U4", "3"), ("C3", "1"), ("U6", "3"), ("C12", "1"),
             ("R13", "1"), ("TP4", "1")],
    "VSYS": [("U4", "10"), ("U4", "11"), ("C2", "1"), ("U5", "1"), ("C4", "1"), ("SW3", "1"),
             ("U4", "6"), ("R11", "1"), ("TP5", "1"), ("R18", "2")],
    "ISET": [("U4", "16"), ("R9", "1")],
    "ILIM": [("U4", "12"), ("R10", "1")],
    # TS senses the CELL: J2 is a 3-pin JST-PH (1 = BAT+, 2 = BAT-, 3 = pack
    # NTC). No board NTC (review rev2: RT1 removed). TS also goes straight to
    # an ADC1 pin (IO6) so firmware measures the cell temperature itself; the
    # BQ's TS source (<= 78 uA) is the only current into that pin.
    "TS": [("U4", "1"), ("J2", "3"), ("U1", "10")],
    # Charge enable (review rev2): CE is active-low. R18 pulls it to VSYS
    # (charging DISABLED); Q1 (2N7002) pulls it low only while the MCU drives
    # CHG_EN (IO37) high. R19 holds the gate low through reset, boot, an
    # unflashed or unpowered MCU (3V3 off with SW3 OFF).
    "CHG_CE": [("U4", "4"), ("R18", "1"), ("Q1", "3")],
    "CHG_EN": [("U1", "33"), ("Q1", "1"), ("R19", "1")],
    "CHG_N": [("U4", "9"), ("LED3", "1")],
    "LED3_A": [("R11", "2"), ("LED3", "2")],
    "PGOOD_N": [("U4", "7"), ("R12", "1"), ("U1", "6")],
    # --- 3.3 V rail ---
    "LDO_EN": [("U5", "3"), ("SW3", "2")],
    "3V3": [("U5", "5"), ("C5", "1"), ("U1", "3"), ("C6", "1"), ("C7", "1"),
            ("U2", "17"), ("U2", "2"), ("C9", "1"), ("C10", "1"),
            ("U3", "8"), ("C14", "1"), ("U3", "5"), ("C15", "1"), ("U3", "12"),
            ("R5", "2"), ("R6", "2"), ("R7", "2"), ("R8", "2"), ("R12", "2"),
            ("J3", "2"), ("TP1", "1")],
    # --- GNSS backup ---
    "VBCKP_SRC": [("U6", "2"), ("C13", "1"), ("R17", "1")],
    "VBCKP": [("R17", "2"), ("U2", "3"), ("C11", "1"), ("TP18", "1")],
    # --- MCU ---
    "EN": [("U1", "45"), ("R5", "1"), ("C8", "1"), ("SW2", "1"), ("TP16", "1")],
    "BOOT": [("U1", "4"), ("R6", "1"), ("SW1", "1"), ("TP17", "1")],
    "VBAT_SENSE": [("R13", "2"), ("R14", "1"), ("U1", "5"), ("C16", "1")],
    "GNSS_RXD": [("U1", "34"), ("U2", "14"), ("TP8", "1")],
    "GNSS_TXD": [("U2", "13"), ("U1", "35"), ("TP7", "1")],
    "PPS": [("U2", "7"), ("U1", "25"), ("TP9", "1")],
    "GNSS_RESET_N": [("U1", "36"), ("U2", "18"), ("TP15", "1")],
    "GNSS_EXTINT": [("U1", "37"), ("U2", "19")],
    "GNSS_SAFEBOOT_N": [("U2", "8"), ("TP12", "1")],
    # IMU on U1.12-14 in the order the top-only lines arrive from U3 (review fix
    # wave: no via is allowed near U3, so the pin order has to be planar);
    # INT2 is not connected (it sits between two 3V3 pins of U3, see sec 4)
    "I2C_SDA": [("U1", "13"), ("U3", "14"), ("R7", "1"), ("TP10", "1")],
    "I2C_SCL": [("U1", "14"), ("U3", "13"), ("R8", "1"), ("TP11", "1")],
    "IMU_INT1": [("U3", "4"), ("U1", "12"), ("TP19", "1")],
    "LED1": [("U1", "16"), ("R15", "1")],
    "LED1_A": [("R15", "2"), ("LED1", "2")],
    "LED2": [("U1", "17"), ("R16", "1")],
    "LED2_A": [("R16", "2"), ("LED2", "2")],
    "U0TXD": [("U1", "39"), ("TP13", "1")],
    "U0RXD": [("U1", "40"), ("TP14", "1")],
    # J3 spare pins (review fix wave: all on U1's south-east corner so their
    # lines reach J3 on the east edge without crossing U1; no strap, no
    # power-up glitch pin, all free on the -N8 part)
    # (pad order = the order the lines leave U1, so the east-strip bus does not
    # cross itself; J3.1 = GND, J3.2 = 3V3). J3.8 is unconnected since review
    # rev2: IO37 became CHG_EN.
    "IO34": [("U1", "29"), ("J3", "3")],
    "IO33": [("U1", "28"), ("J3", "4")],
    "IO47": [("U1", "27"), ("J3", "5")],
    "IO35": [("U1", "31"), ("J3", "6")],
    "IO36": [("U1", "32"), ("J3", "7")],
}

# Pads that must stay unconnected (spec: "no connect"). Anything not listed in
# NETS must be in here, or the self-check fails.
NO_CONNECT = (
    [("U1", str(n)) for n in (7, 8, 9, 11, 15, 18) + tuple(range(19, 23)) + (26, 30, 38, 41, 44)]
    + [("U2", "9"), ("U2", "12"), ("U3", "9"), ("U3", "10"), ("U3", "11"), ("U4", "14"), ("U5", "4"),
       ("J1", "A8"), ("J1", "B8"), ("J3", "8")]
)

# GNSS nets = nets touching U2 (section 8 "GNSS routing rule": top layer only,
# no via at spec Y < 52.75).
GNSS_NETS = {"3V3", "VBCKP", "GNSS_RXD", "GNSS_TXD", "PPS", "GNSS_RESET_N",
             "GNSS_EXTINT", "GNSS_SAFEBOOT_N"}
# Section 8 rules: power tracks >= 0.5 mm.
POWER_NETS = {"VBUS", "VSYS", "VBAT", "3V3"}


def pad_to_net():
    m = {}
    for net, pads in NETS.items():
        for ref, num in pads:
            key = (ref, num)
            if key in m and m[key] != net:
                raise SystemExit(f"netlist_spec: pad {ref}.{num} in two nets ({m[key]}, {net})")
            m[key] = net
    for key in NO_CONNECT:
        if key in m:
            raise SystemExit(f"netlist_spec: NC pad {key} also in net {m[key]}")
    return m
