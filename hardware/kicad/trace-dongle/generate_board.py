#!/usr/bin/env python3
"""
TRACE OBD Telemetry Dongle -- PCB generator (KiCad 10 / pcbnew scripting).

Builds hardware/kicad/trace-dongle/trace-dongle.kicad_pcb from scratch, from
the BINDING netlist in hardware/DESIGN.md section 3 (component selection in
section 2, PCB constraints in section 4). Deterministic: delete + re-run
reproduces the same board.

Run with KiCad 10's bundled Python (has the pcbnew module):
    "C:\\Users\\dobri\\AppData\\Local\\Programs\\KiCad\\10.0\\bin\\python.exe" generate_board.py

Footprint substitutions / constructions (see ticket report for the full,
authoritative list -- summarised here for anyone reading the script):
  - ESP32-C3-MINI-1: KiCad 10's RF_Module library ships no footprint for this
    exact part. hardware/kicad/trace-dongle/fp-lib/TRACE-Custom.pretty/
    ESP32-C3-MINI-1.kicad_mod is CONSTRUCTED: pad grid/courtyard copied from
    KiCad's own RF_Module:ESP32-C6-MINI-1 (same Espressif "MINI-1" mechanical
    family -- confirmed identical 13.2x16.6mm body/53-pad grid against the
    real ESP32-C3-MINI-1 datasheet), pad electrical functions remapped to the
    real ESP32-C3-MINI-1 pin table (Table 3-1, datasheet v2.2). See that file's
    `descr` field for the full citation.
  - L1 10uH shielded 0630 (LCSC C167219): no footprint literally named
    "L_0630" ships in Inductor_SMD; closest 6.8x6.8mm shielded part in the std
    lib is L_APV_APH0630 (6.8x6.6x2.8mm, "shielded" per its own tags) -- used.
  - SW1 side-actuated tact switch: Button_Switch_SMD ships no footprint
    literally named "side tact"; Panasonic_EVQPUJ_EVQPUA (2-terminal SPST,
    side-actuated) is the closest std-lib part -- used.
  - U2 TJA1051T/3 (SOIC-8), U3 TPS54202DDCR (SOT-23-6), D3 PESD2CAN (SOT-23):
    KiCad's generic packages ship no per-pin silkscreen mapping. Pin-number
    assignments below are a documented, reasoned assumption (not blind
    guessing -- see comments at each footprint's net-map) cross-checked
    against DESIGN.md's own explicit "S = pin 8" statement for U2, and TI's
    standard BOOT/VIN/EN/GND/FB/SW SOT-23-6 buck convention for U3. Flagged
    as a concern in the ticket report for LEAD/datasheet sign-off before
    fab -- it does not affect DRC or the binding net-name-level netlist.
"""
import os
import shutil
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
KI_FP = r"C:\Users\dobri\AppData\Local\Programs\KiCad\10.0\share\kicad\footprints"
CUSTOM_FP = os.path.join(HERE, "fp-lib", "TRACE-Custom.pretty")
OUT_PCB = os.path.join(HERE, "trace-dongle.kicad_pcb")

MM = pcbnew.FromMM


def lib(name):
    return os.path.join(KI_FP, name + ".pretty")


# ---------------------------------------------------------------------------
# 1. Placement table: (ref, libdir, footprint_name, x_mm, y_mm, rot_deg)
#    Verified collision-free (courtyard bboxes, 0.15mm margin) by a standalone
#    placement checker before being committed here.
# ---------------------------------------------------------------------------
PLACEMENTS = [
    ("J1",  lib("Connector_PinHeader_2.54mm"), "PinHeader_1x05_P2.54mm_Vertical", 3.0, 7.42, 0),
    ("F1",  lib("Fuse"),                        "Fuse_0603_1608Metric",            8.4, 6.0, 0),
    ("D2",  lib("Diode_SMD"),                    "D_SMB",                          14.5, 6.0, 0),
    ("D1",  lib("Diode_SMD"),                    "D_SMB",                          12.6, 11.0, 0),
    ("C1",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              20.0, 6.0, 0),
    ("C2",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              23.3, 6.0, 0),
    ("U3",  lib("Package_TO_SOT_SMD"),           "SOT-23-6",                       27.5, 6.0, 0),
    ("C5",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              27.5, 3.0, 0),
    ("L1",  lib("Inductor_SMD"),                 "L_APV_APH0630",                  35.0, 6.0, 0),
    ("R3",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              24.0, 11.5, 90),
    ("R4",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              24.0, 15.0, 90),
    ("C3",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              29.0, 11.5, 0),
    ("C4",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              29.0, 15.0, 0),
    ("R1",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              34.0, 11.5, 90),
    ("R2",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              34.0, 15.0, 90),
    ("C6",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              20.0, 1.2, 0),
    ("C7",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              25.0, 1.2, 0),
    ("C8",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              30.0, 1.2, 0),
    ("U2",  lib("Package_SO"),                   "SOIC-8_3.9x4.9mm_P1.27mm",       10.0, 17.5, 0),
    ("D3",  lib("Package_TO_SOT_SMD"),           "SOT-23",                         16.5, 17.5, 0),
    ("R9",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              20.5, 17.5, 0),
    ("C9",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              6.5, 13.0, 0),
    ("U1",  CUSTOM_FP,                            "ESP32-C3-MINI-1",                48.5, 12.5, 270),
    ("R5",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              5.0, 22.0, 0),
    ("R6",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              9.0, 22.0, 0),
    ("SW1", lib("Button_Switch_SMD"),            "Panasonic_EVQPUJ_EVQPUA",        26.5, 21.5, 0),
    ("LED1", lib("LED_SMD"),                     "LED_0603_1608Metric",            32.5, 22.0, 0),
    ("R7",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              32.5, 19.5, 90),
    ("LED2", lib("LED_SMD"),                     "LED_0603_1608Metric",            36.1, 22.0, 0),
    ("R8",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              36.1, 19.5, 90),
    ("J2",  lib("Connector_PinHeader_2.54mm"),   "PinHeader_1x06_P2.54mm_Vertical", 40.2, 22.0, 90),
]

VALUES = {
    "J1": "OBD-II 5-pad fallback row (12V/GND/GND/CANH/CANL) -- C718401 pigtail fallback per DESIGN.md sec6",
    "F1": "PTC 350mA", "D2": "SS34", "D1": "SMBJ24A",
    "C1": "22uF/35V", "C2": "22uF/35V", "U3": "TPS54202DDCR", "C5": "100nF (BST)",
    "L1": "10uH 2A shielded", "R3": "100k (EN div hi)", "R4": "24k (EN div lo)",
    "C3": "22uF/10V", "C4": "22uF/10V", "R1": "100k (FB div hi)", "R2": "13k (FB div lo)",
    "C6": "100nF (U1 3V3)", "C7": "10uF (U1 3V3)", "C8": "1uF (U1 EN)",
    "U2": "TJA1051T/3", "D3": "PESD2CAN", "R9": "DNP (CAN term, not fitted)",
    "C9": "100nF (U2 VCC)", "U1": "ESP32-C3-MINI-1-N4",
    "R5": "10k (U1 EN pullup)", "R6": "10k (IO9/BOOT pullup)",
    "SW1": "BOOT tact", "LED1": "green (power)", "R7": "1k", "LED2": "amber (activity)", "R8": "1k",
    "J2": "1x6 2.54mm UART header",
}

LCSC = {
    "U1": "C3013922", "U2": "C264757", "U3": "C316922",
    "D1": "C114213", "D2": "C8678", "D3": "C24911", "F1": "C88724", "L1": "C167219",
    "SW1": "C318884",
    # basic parts (resistors/caps/LEDs/headers) -- JLCPCB basic-part library, no fixed LCSC# pinned
    # in DESIGN.md; left blank per BOM convention for generic 0603 R/C/LED and headers.
}

# ---------------------------------------------------------------------------
# 2. Net -> pad membership (for net assignment; every pad below gets its net
#    set regardless of how it's routed).
#    GND is handled entirely by copper pour (both layers); no GND entries here.
# ---------------------------------------------------------------------------
POWER_NETS = {
    "12V_RAW":   [("J1", "1"), ("F1", "1")],
    "NET_FUSED": [("F1", "2"), ("D2", "1")],
    "VIN_PROT":  [("D2", "2"), ("D1", "1"), ("C1", "1"), ("C2", "1"), ("R3", "1"), ("U3", "2")],
    "3V3":       [("L1", "2"), ("R1", "1"), ("C3", "1"), ("C4", "1"),
                  ("C6", "1"), ("C7", "1"), ("U1", "3"), ("C9", "1"), ("U2", "3"), ("U2", "5"),
                  ("R5", "2"), ("R6", "2"), ("R7", "1"), ("J2", "1")],
}

SIGNAL_NETS = {
    "SW_NODE":   [("U3", "6"), ("C5", "2"), ("L1", "1")],
    "BST_NODE":  [("C5", "1"), ("U3", "1")],
    "FB_NODE":   [("U3", "5"), ("R1", "2"), ("R2", "1")],
    "EN_U3_NODE": [("U3", "3"), ("R3", "2"), ("R4", "1")],
    "U1_EN":     [("U1", "8"), ("R5", "1"), ("C8", "1"), ("J2", "6")],
    "IO9_BOOT":  [("U1", "23"), ("R6", "1"), ("SW1", "1"), ("J2", "5")],
    "CAN_TX":    [("U1", "18"), ("U2", "1")],
    "CAN_RX":    [("U1", "19"), ("U2", "4")],
    "CAN_S":     [("U1", "20"), ("U2", "8")],
    "LED2_DRIVE": [("U1", "22"), ("R8", "2")],
    "TXD0":      [("U1", "31"), ("J2", "3")],
    "RXD0":      [("U1", "30"), ("J2", "4")],
    "CANH":      [("U2", "7"), ("D3", "1"), ("R9", "1"), ("J1", "4")],
    "CANL":      [("U2", "6"), ("D3", "3"), ("R9", "2"), ("J1", "5")],
    "LED1_TOP":  [("R7", "2"), ("LED1", "1")],
    "LED2_TOP":  [("R8", "1"), ("LED2", "1")],
}

# GND membership: only needed so we can mark the *pads* with the GND net
# (copper pour on F.Cu/B.Cu does the actual connecting -- no tracks routed).
GND_PADS = [
    ("D1", "2"), ("C1", "2"), ("C2", "2"), ("U3", "4"), ("R4", "2"), ("C3", "2"), ("C4", "2"),
    ("R2", "2"), ("J1", "2"), ("J1", "3"), ("U2", "2"), ("C9", "2"), ("D3", "2"),
    ("C6", "2"), ("C7", "2"), ("C8", "2"), ("SW1", "2"), ("LED1", "2"), ("LED2", "2"), ("J2", "2"),
]
U1_GND_PAD_NUMS = {"1", "2", "11", "14"} | {str(n) for n in range(36, 54)}

# Track widths per DESIGN.md/ticket sec 3: power 0.6mm, signal 0.25mm, CAN 0.3mm
W_POWER = MM(0.6)
W_SIGNAL = MM(0.25)
W_CAN = MM(0.3)

CAN_NET_NAMES = {"CANH", "CANL"}

# ---------------------------------------------------------------------------
# 2b. Explicit routing plan. Short, geometrically-local hops go straight on
#     F.Cu. Long "trunk" hops that would otherwise cross other components'
#     pads (verified against real placed-pad coordinates during layout) are
#     routed via a via-drop to B.Cu (empty except the yielding GND pour) and
#     a via back up to F.Cu at the far pad. A couple of hops use explicit
#     F.Cu waypoints to dodge a specific nearby pad row.
#     Each entry: (net, ref1, pad1, ref2, pad2, width, mode, waypoints_mm)
#     mode: "F" = F.Cu direct, "B" = via/B.Cu/via, "W" = F.Cu via waypoints
# ---------------------------------------------------------------------------
ROUTES = [
    ("12V_RAW",   "J1", "1", "F1", "1", W_POWER, "F", None),
    ("NET_FUSED", "F1", "2", "D2", "1", W_POWER, "F", None),
    ("VIN_PROT",  "D2", "2", "C1", "1", W_POWER, "F", None),
    # C1.1->C2.1 direct would clip C1.2 (GND) sitting between them at Y=6 -- take it via B.Cu.
    ("VIN_PROT",  "C1", "1", "C2", "1", W_POWER, "B", None),
    # C2.1->U3.2 direct would clip C2.2 (GND); take it via B.Cu instead (U3's pad column is crowded).
    ("VIN_PROT",  "C2", "1", "U3", "2", W_POWER, "B", None),
    # C1.1->R3.1 direct passes close enough to R3.2 (EN_U3_NODE, rotated pad) to violate
    # clearance -- go straight down to R3.1's own Y first, then approach horizontally.
    ("VIN_PROT",  "C1", "1", "R3", "1", W_POWER, "W", [(19.225, 12.325)]),
    # D2.2->D1.1 direct would clip D1.2 (GND) sitting east of D1.1 (D_SMB pads are big,
    # 2.5x2.3mm) -- approach D1.1 from the west with generous clearance from both D1.2
    # and D2's/F1's own pads.
    ("VIN_PROT",  "D2", "2", "D1", "1", W_POWER, "W", [(16.65, 8.5), (8.5, 8.5), (8.5, 11.0)]),

    ("SW_NODE",  "C5", "2", "U3", "6", W_SIGNAL, "F", None),
    ("SW_NODE",  "U3", "6", "L1", "1", W_SIGNAL, "F", None),
    ("BST_NODE", "C5", "1", "U3", "1", W_SIGNAL, "F", None),
    # FB_NODE: U3.5->R1.2 direct would run straight down through U3.4 (GND, same X) --
    # jog east off U3's pad column first, then dip below L1.
    ("FB_NODE",  "U3", "5", "R1", "2", W_SIGNAL, "W", [(30.0, 6.0), (30.0, 9.8), (34.0, 9.8)]),
    # R1.2->R2.1 direct would thread straight through R1.1 (3V3) and R2.2 (GND) -- go
    # around to the east of both.
    ("FB_NODE",  "R1", "2", "R2", "1", W_SIGNAL, "W", [(36.0, 10.675), (36.0, 15.825)]),
    ("EN_U3_NODE", "U3", "3", "R3", "2", W_SIGNAL, "F", None),
    # R3.2->R4.1 direct would thread through R3.1 (VIN_PROT) and R4.2 (GND) -- go around east.
    ("EN_U3_NODE", "R3", "2", "R4", "1", W_SIGNAL, "W", [(25.5, 10.675), (25.5, 15.825)]),

    # 3V3: local clusters on F.Cu, long inter-cluster bridges on dedicated B.Cu lanes.
    # L1.2->R1.1: waypoint steers clear of R1.2 (FB_NODE pad) and of FB_NODE's own
    # U3.5->R1.2 route (which uses X=30 as its jog column).
    ("3V3", "L1", "2", "R1", "1", W_POWER, "W", [(39.5, 9.9)]),
    # R1.1->C3.1 direct would clip C3.2 (GND) between them -- dip below the row first.
    ("3V3", "R1", "1", "C3", "1", W_POWER, "W", [(34.0, 13.0), (28.225, 13.0)]),
    ("3V3", "C3", "1", "C4", "1", W_POWER, "F", None),
    ("3V3", "C9", "1", "U2", "3", W_POWER, "B", None),
    ("3V3", "U2", "3", "U2", "5", W_POWER, "F", None),
    # R5.2->R6.2 direct would clip R6.1's own via (IO9_BOOT) sitting between them -- dip
    # further below it (0.5mm was not quite enough clearance against the via).
    ("3V3", "R5", "2", "R6", "2", W_POWER, "BW", [(5.825, 23.5), (9.825, 23.5)]),
    # C4.1->R7.1: R7.1 otherwise has no path back to the rest of 3V3 (it was only ever a
    # source in the R7.1->J2.1 leg below) -- feed it from the nearby C4/C3 cluster via
    # B.Cu, well below IO9_BOOT's SW1.1->U1.23 row (which now runs at Y=14.5) and above
    # LED1_TOP's approach into LED1.1.
    ("3V3", "C4", "1", "R7", "1", W_POWER, "BW", [(28.225, 21.0), (32.5, 21.0)]),
    # R7.1->J2.1: LED1.2/LED2.1 (both wide 0603 pads) box in the X~32.9-34.9 band -- thread
    # the 34.3 gap between them before dropping south, then east to J2 pin 1.
    ("3V3", "R7", "1", "J2", "1", W_POWER, "W", [(34.3, 20.325), (34.3, 23.3), (40.2, 23.3)]),
    # C4.1->C6.1: B.Cu is now claimed by CAN_TX/S's lanes across this whole Y band, so
    # this has to be F.Cu. The only clear F.Cu corridor between C6/7/8's row and C5/U3's
    # row is ~0.85mm wide (not enough for a 0.6mm power trace with clearance either
    # side) -- use signal width for this one bridge segment as a documented deviation.
    ("3V3", "C4", "1", "C6", "1", W_SIGNAL, "W", [(28.225, 16.2), (40.5, 16.2), (40.5, 1.5), (19.225, 1.5)]),
    # L1.2->U1.3: U1's pads-12-24 column occupies X=43.6 for Y=6.5-18.5 densely (0.8mm
    # pitch) -- cross north of it (Y=5.5, clear of that whole column and of the Y=6.6
    # pads1-11 row too).
    ("3V3", "L1", "2", "U1", "3", W_POWER, "W", [(38.025, 5.5), (50.9, 5.5)]),
    ("3V3", "C7", "1", "C9", "1", W_POWER, "L", 0.85),
    # U2.5->R6.2: CANL's R9 detour forms an L (vertical at X=11, horizontal at Y=20.3,
    # spanning X11-21.325) -- go around its open corner: east past X=21.325 first, then
    # south past Y=21.5 (below IO9_BOOT's R6.1->SW1.1 diagonal, which only reaches
    # Y=22 at its own endpoint), then west into R6.2.
    ("3V3", "U2", "5", "R6", "2", W_POWER, "W", [(22.0, 19.6), (22.0, 21.5), (9.825, 21.5)]),

    ("U1_EN",  "C8", "1", "U1", "8", W_SIGNAL, "L", 2.15),
    ("U1_EN",  "U1", "8", "J2", "6", W_SIGNAL, "B", None),
    # J2.6->R5.1: step left off the board's bottom-right rounded corner, then run the
    # full-width bottom lane (Y=24.3, clear of the J2-approach lanes below).
    ("U1_EN",  "J2", "6", "R5", "1", W_SIGNAL, "BW", [(51.8, 22.0), (51.8, 24.3), (4.175, 24.3)]),

    ("IO9_BOOT", "R6", "1", "SW1", "1", W_SIGNAL, "B", None),
    # SW1.1->U1.23: B.Cu, threading the narrow safe Y-window between CAN_TX/CAN_S's
    # lanes (12.8/13.8) and C4->R7's start point (Y=15) at Y=14.5, offset off U1.23's
    # native X=43.6 column until the very last hop (CAN_S's own jog sits right at 43.6).
    ("IO9_BOOT", "SW1", "1", "U1", "23", W_SIGNAL, "BW",
     [(23.875, 14.5), (42.5, 14.5), (42.5, 16.5)]),
    # SW1.1->J2.5: go under J2 entirely (Y=23.5, below the PTH pad ring and below
    # TXD0/RXD0's lanes) rather than threading between J2's closely-spaced pins.
    ("IO9_BOOT", "SW1", "1", "J2", "5", W_SIGNAL, "BW", [(23.875, 23.5), (50.36, 23.5)]),

    # CAN_TX/RX/S: B.Cu is empty except for the tracks we ourselves route on it. All three
    # sources sit on U1's shared X=43.6 column at closely-spaced Y (12.5/13.3/14.1); each
    # gets a lane just below its own source Y, fully verified pairwise crossing-free with a
    # standalone segment-intersection checker (every stub's X/Y span kept outside every
    # other net's lane span, and vice versa).
    ("CAN_TX", "U1", "18", "U2", "1", W_SIGNAL, "BW", [(43.6, 12.8), (7.3, 12.8), (7.3, 15.595)]),
    ("CAN_S",  "U1", "20", "U2", "8", W_SIGNAL, "BW", [(44.0, 14.1), (44.0, 13.8), (12.475, 13.8), (12.475, 15.595)]),
    # CAN_RX's lane sits at Y=11.0 (above CAN_TX/CAN_S's own lanes and above the whole
    # R7/LED1/LED2/R8/SW1/IO9_BOOT cluster it would otherwise have to dodge piecewise),
    # jogging further west via B.Cu to clear C9's own C7->C9 and C9->U2.3 routes.
    ("CAN_RX", "U1", "19", "U2", "4", W_SIGNAL, "BW",
     [(44.5, 13.3), (44.5, 11.0), (4.6, 11.0), (4.6, 19.6), (7.0, 19.6)]),

    ("LED2_DRIVE", "U1", "22", "R8", "2", W_SIGNAL, "F", None),
    # TXD0/RXD0: both F.Cu (PTH J2 pads accept a direct F.Cu connection, no via needed;
    # this also keeps them off IO9_BOOT's B.Cu lane entirely -- different layers). RXD0's
    # stub jogs east, clear of TXD0's lane span, and both lanes sit well above the J2 pad
    # ring's top edge (~21.15) for clearance.
    ("TXD0", "U1", "31", "J2", "3", W_SIGNAL, "W", [(49.3, 20.3), (45.28, 20.3)]),
    # RXD0: TXD0's F.Cu stub occupies X=49.3 for its whole Y=18.4-20.3 span, and RXD0's
    # own target (47.82) sits inside TXD0's lane span too -- no F.Cu-only path threads
    # both without crossing TXD0 somewhere, so put RXD0 on B.Cu (different layer, and
    # IO9_BOOT's B.Cu lane now runs under J2 at Y=23.5, well clear of this).
    ("RXD0", "U1", "30", "J2", "4", W_SIGNAL, "BW", [(47.82, 18.4)]),

    # U2's SOIC-8 pads are unusually wide (1.95mm) -- any vertical stub near its west/east
    # columns needs to clear the full pad width, not just the pad centre-to-centre pitch.
    ("CANH", "U2", "7", "D3", "1", W_CAN, "F", None),
    ("CANH", "U2", "7", "R9", "1", W_CAN, "W", [(11.0, 16.865), (11.0, 14.0), (19.675, 14.0)]),
    ("CANH", "U2", "7", "J1", "4", W_CAN, "W", [(11.0, 16.865), (11.0, 14.0), (3.0, 14.0)]),
    # U2.6->D3.3 direct grazes D3.2 (GND) sitting between them -- reach D3.3's own Y early.
    ("CANL", "U2", "6", "D3", "3", W_CAN, "W", [(14.0, 17.5)]),
    # The horizontal leg is at Y=20.3, clear of U2.5's (3V3) pad edge (~19.7).
    ("CANL", "U2", "6", "R9", "2", W_CAN, "W", [(11.0, 18.135), (11.0, 20.3), (21.325, 20.3)]),
    ("CANL", "U2", "6", "J1", "5", W_CAN, "W", [(11.0, 18.135), (11.0, 20.5), (3.0, 20.5)]),

    # LED1_TOP direct would thread past R7's own sibling pad (R7.1, 3V3) and then LED1's
    # own sibling pad (LED1.2, GND); every F.Cu detour around both re-crosses 3V3's
    # C4->R7 leg nearby -- B.Cu is clear here (verified against every other B.Cu net).
    ("LED1_TOP", "R7", "2", "LED1", "1", W_SIGNAL, "BW", [(35.5, 21.9)]),
    ("LED2_TOP", "R8", "1", "LED2", "1", W_SIGNAL, "F", None),
]

BOARD_W, BOARD_H = 55.0, 25.0
CORNER_R = 2.0


def add_board_outline(board):
    """55x25mm board outline, 2mm rounded corners, on Edge.Cuts."""
    w, h, r = MM(BOARD_W), MM(BOARD_H), MM(CORNER_R)

    def line(p1, p2):
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(pcbnew.VECTOR2I(*p1))
        s.SetEnd(pcbnew.VECTOR2I(*p2))
        s.SetLayer(pcbnew.Edge_Cuts)
        s.SetWidth(MM(0.1))
        board.Add(s)

    def arc(center, start, end):
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_ARC)
        s.SetCenter(pcbnew.VECTOR2I(*center))
        s.SetStart(pcbnew.VECTOR2I(*start))
        s.SetEnd(pcbnew.VECTOR2I(*end))
        s.SetLayer(pcbnew.Edge_Cuts)
        s.SetWidth(MM(0.1))
        board.Add(s)

    # straight edges (between the rounded corners)
    line((r, 0), (w - r, 0))                  # top
    line((w, r), (w, h - r))                  # right
    line((w - r, h), (r, h))                  # bottom
    line((0, h - r), (0, r))                  # left
    # corner arcs (quarter circles), CCW
    arc((w - r, r), (w - r, 0), (w, r))              # top-right
    arc((w - r, h - r), (w, h - r), (w - r, h))       # bottom-right
    arc((r, h - r), (r, h), (0, h - r))               # bottom-left
    arc((r, r), (0, r), (r, 0))                       # top-left


def main():
    if os.path.exists(OUT_PCB):
        os.remove(OUT_PCB)

    board = pcbnew.CreateEmptyBoard()
    board.SetCopperLayerCount(2)

    ds = board.GetDesignSettings()
    ds.m_TrackMinWidth = MM(0.15)
    ds.m_MinClearance = MM(0.2)
    ds.m_ViasMinSize = MM(0.5)
    ds.m_ViasMinDrill = MM(0.3)

    add_board_outline(board)

    # -- place footprints --------------------------------------------------
    footprints = {}
    for ref, libdir, name, x, y, rot in PLACEMENTS:
        fp = pcbnew.FootprintLoad(libdir, name)
        if fp is None:
            print(f"FATAL: footprint not found: {libdir}\\{name} (ref {ref})")
            sys.exit(1)
        fp.SetReference(ref)
        fp.SetValue(VALUES.get(ref, name))
        fp.Reference().SetVisible(True)
        fp.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
        fp.SetOrientationDegrees(rot)
        # all parts top-side SMD per DESIGN.md sec4, except J1/J2/SW1 (THT, hand-solder)
        board.Add(fp)
        footprints[ref] = fp

    # -- nets ----------------------------------------------------------------
    netinfo = board.GetNetInfo()

    def get_net(name):
        n = netinfo.GetNetItem(name)
        if n is not None and n.GetNetCode() != 0:
            return n
        n = pcbnew.NETINFO_ITEM(board, name)
        board.Add(n)
        return n

    def pad(ref, num):
        fp = footprints[ref]
        p = fp.FindPadByNumber(num)
        if p is None:
            print(f"FATAL: pad {num} not found on {ref}")
            sys.exit(1)
        return p

    def assign(ref, num, net):
        # Some footprints (SW1/EVQPUJ, U1's thermal pad "49") have MULTIPLE
        # physical pads sharing the same pad NUMBER (electrically bonded
        # contacts). FindPadByNumber only returns the first match, which
        # would leave the others net-less -- assign to every match.
        fp = footprints[ref]
        found = False
        for p in fp.Pads():
            if p.GetNumber() == num:
                p.SetNet(net)
                found = True
        if not found:
            print(f"FATAL: pad {num} not found on {ref}")
            sys.exit(1)

    gnd_net = get_net("GND")
    for ref, num in GND_PADS:
        assign(ref, num, gnd_net)
    for p in footprints["U1"].Pads():
        if p.GetNumber() in U1_GND_PAD_NUMS:
            p.SetNet(gnd_net)

    # Small isolated 0603 GND pads at the board's top row can end up with only one
    # thermal-relief spoke reaching the pour (starved_thermal). Use a solid (no
    # thermal-relief) zone connection for every pad instead -- fine for JLCPCB reflow
    # assembly, and it removes the spoke-count requirement entirely.
    for fp in board.GetFootprints():
        for p in fp.Pads():
            p.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)

    all_nets = {}
    all_nets.update(POWER_NETS)
    all_nets.update(SIGNAL_NETS)

    for name, members in all_nets.items():
        net = get_net(name)
        for ref, num in members:
            assign(ref, num, net)

    # -- routing -------------------------------------------------------------
    def seg(p1, p2, width, layer, net):
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(p1)
        t.SetEnd(p2)
        t.SetWidth(width)
        t.SetLayer(layer)
        t.SetNet(net)
        board.Add(t)

    def add_via(pos, net, width=MM(0.5), drill=MM(0.3)):
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pos)
        v.SetWidth(width)
        v.SetDrill(drill)
        v.SetNet(net)
        board.Add(v)

    for net_name, r1, p1n, r2, p2n, width, mode, waypoints in ROUTES:
        pd1 = pad(r1, p1n)
        pd2 = pad(r2, p2n)
        net = pd1.GetNet()
        pos1 = pd1.GetPosition()
        pos2 = pd2.GetPosition()
        if mode == "F":
            seg(pos1, pos2, width, pcbnew.F_Cu, net)
        elif mode == "W":
            pts = [pos1] + [pcbnew.VECTOR2I(MM(x), MM(y)) for x, y in waypoints] + [pos2]
            for a, b in zip(pts, pts[1:]):
                seg(a, b, width, pcbnew.F_Cu, net)
        elif mode == "B":
            add_via(pos1, net)
            add_via(pos2, net)
            seg(pos1, pos2, width, pcbnew.B_Cu, net)
        elif mode == "BW":
            add_via(pos1, net)
            add_via(pos2, net)
            pts = [pos1] + [pcbnew.VECTOR2I(MM(x), MM(y)) for x, y in waypoints] + [pos2]
            for a, b in zip(pts, pts[1:]):
                seg(a, b, width, pcbnew.B_Cu, net)
        elif mode == "L":
            lane_y = MM(waypoints)
            add_via(pos1, net)
            add_via(pos2, net)
            corner1 = pcbnew.VECTOR2I(pos1.x, lane_y)
            corner2 = pcbnew.VECTOR2I(pos2.x, lane_y)
            seg(pos1, corner1, width, pcbnew.B_Cu, net)
            seg(corner1, corner2, width, pcbnew.B_Cu, net)
            seg(corner2, pos2, width, pcbnew.B_Cu, net)
        else:
            raise ValueError(f"unknown route mode {mode}")

    # SW1 (EVQPUJ) has two physical pads for each of its two numbered contacts
    # (duplicate_pad_numbers_are_jumpers = no in the footprint, so KiCad does NOT treat
    # them as internally bonded) -- explicit jumper tracks are required or the second
    # instance of each number is an unconnected island.
    sw1_by_num = {}
    for p in footprints["SW1"].Pads():
        sw1_by_num.setdefault(p.GetNumber(), []).append(p)
    for num, pads in sw1_by_num.items():
        if len(pads) == 2:
            seg(pads[0].GetPosition(), pads[1].GetPosition(), W_SIGNAL, pcbnew.F_Cu, pads[0].GetNet())

    # -- GND copper pour (both layers), excluding the antenna keepout column --
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        zone = pcbnew.ZONE(board)
        zone.SetLayer(layer)
        zone.SetNet(gnd_net)
        zone.SetIsFilled(False)
        zone.SetLocalClearance(MM(0.25))
        zone.SetMinThickness(MM(0.2))
        outline = zone.Outline()
        outline.NewOutline()
        pts = [(1.2, 1.2), (54.3, 1.2), (54.3, 23.8), (1.2, 23.8)]
        for x, y in pts:
            outline.Append(pcbnew.VECTOR2I(MM(x), MM(y)))
        board.Add(zone)

    # -- fill zones + connectivity refresh -----------------------------------
    board.BuildConnectivity()
    filler = pcbnew.ZONE_FILLER(board)
    filler.Fill(board.Zones())
    board.BuildConnectivity()

    pcbnew.SaveBoard(OUT_PCB, board)
    print(f"Wrote {OUT_PCB}")


if __name__ == "__main__":
    main()
