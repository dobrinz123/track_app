#!/usr/bin/env python3
"""
TRACE OBD Telemetry Dongle -- PCB generator (KiCad 10 / pcbnew scripting).

Builds hardware/kicad/trace-dongle/trace-dongle.kicad_pcb from scratch, from
the BINDING netlist in hardware/DESIGN.md section 3 (component selection in
section 2, PCB constraints in section 4), AS AMENDED by DESIGN.md section 7
("Rev A2 amendments", added after HW2 wave 1 hit 19 DRC violations / 4
unconnected pads on the original 55x25mm board). Deterministic: delete +
re-run reproduces the same board.

Run with KiCad 10's bundled Python (has the pcbnew module):
    "C:\\Users\\dobri\\AppData\\Local\\Programs\\KiCad\\10.0\\bin\\python.exe" generate_board.py

WAVE 2 CHANGES (see ticket report for full rationale):
  - Board envelope raised to 62 x 30mm (DESIGN.md sec7). Used entirely for
    SPACING, not new parts -- component count is unchanged from wave 1.
  - Full re-placement (not just the two hotspot areas): wave 1's root
    problem was that U1's own decoupling/pullup/status parts (C6/C7/C8/R5/
    R6/SW1/LED1/LED2/R7/R8/J2) were placed on the *opposite side of the
    board* from U1 itself, forcing several long trunk routes to fight for
    the same corridor as the CAN_TX/RX/S trunk near U1's pin column --
    that convergence was the "U1 CAN pin column" hotspot. Wave 2 clusters
    every U1-local net's components physically next to U1 (right side of
    the board), leaving only three genuine long-haul nets: CAN_TX/RX/S
    (U1 <-> U2, unavoidable -- transceiver is at the connector end) and
    the two 3V3 power bridges (buck output -> each cluster). Those three
    CAN lines get a dedicated, component-free B.Cu corridor along the top
    edge (y=2.2/2.9/3.6mm) so they cannot contend with anything else.
  - BINDING pin maps corrected per DESIGN.md sec7 (LEAD-supplied, verified
    against wave 1's assumptions -- see PIN MAP CORRECTIONS below).
  - SW1 moved off the bottom-left CAN cluster entirely, onto the bottom
    long edge near U1's side of the board (x=43, far from U2/D3 at
    x=13/19.5) per the amendment.
  - U1 castellated pads (numbers 1-48) get a local 0.15mm clearance
    override per the amendment; everywhere else keeps the board's global
    0.2mm minimum clearance.

PIN MAP CORRECTIONS (DESIGN.md sec7, LEAD-supplied from standard
datasheets -- wave 1 had these three wrong; U2 TJA1051T/3 was already
correct and needed no change):
  - U3 TPS54202 SOT-23-6: wave 1 assumed 1=BST,2=VIN,3=EN,4=GND,5=FB,6=SW.
    Correct (binding): 1=BOOT,2=GND,3=FB,4=EN,5=VIN,6=SW. Four of six pins
    were wrong (2,3,4,5); only 1 (BOOT/BST) and 6 (SW) happened to match.
  - D3 PESD2CAN SOT-23: wave 1 assumed 1=CANH,2=CANL,3=GND. Correct
    (binding, common-cathode): 1=CANL line, 2=CANH line, 3=GND. Pins 1/2
    were swapped relative to CANH/CANL and GND was on 2, not 3.

Footprint substitutions / constructions (unchanged from wave 1 -- see
that report for the full list; summarised here for anyone reading the
script):
  - ESP32-C3-MINI-1: hardware/kicad/trace-dongle/fp-lib/TRACE-Custom.pretty/
    ESP32-C3-MINI-1.kicad_mod is CONSTRUCTED (see that file's `descr`).
  - L1 10uH shielded 0630 (LCSC C167219): L_APV_APH0630 (closest 6.8mm
    shielded std-lib part) used, as wave 1.
  - SW1 side-actuated tact switch: Panasonic_EVQPUJ_EVQPUA used, as wave 1.
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
#
#    Layout (62 x 30mm board), left to right:
#      x  2-24: J1 (OBD pad row) + CAN transceiver cluster (U2/D3/R9/C9) --
#               CANH/CANL stay short and local to this cluster per DESIGN
#               sec4; SW1 is explicitly NOT here (amendment).
#      x 24-42: buck section (F1/D2/D1/C1/C2/U3/C5/L1/C3/C4/R3/R4/R1/R2).
#      x 42-62: U1 + every net that is U1-local (C6/C7/C8/R5/R7/LED1 above
#               U1; R8/LED2 left of U1; R6/SW1/J2 below U1). SW1 sits on
#               the bottom long edge here, ~30mm from the U2/D3 cluster.
#    A dedicated, component-free B.Cu corridor at y=2.2/2.9/3.6mm carries
#    the three CAN_TX/RX/S trunk lines from U1's left edge to U2, clear of
#    every other footprint and every other track on the board.
# ---------------------------------------------------------------------------
PLACEMENTS = [
    # -- CAN cluster + J1 --
    ("J1",  lib("Connector_PinHeader_2.54mm"), "PinHeader_1x05_P2.54mm_Vertical", 4.0, 10.0, 0),
    ("U2",  lib("Package_SO"),                 "SOIC-8_3.9x4.9mm_P1.27mm",        13.0, 18.0, 0),
    ("D3",  lib("Package_TO_SOT_SMD"),         "SOT-23",                          19.5, 18.0, 0),
    ("R9",  lib("Resistor_SMD"),               "R_0603_1608Metric",               19.5, 21.5, 90),
    ("C9",  lib("Capacitor_SMD"),              "C_0603_1608Metric",               8.0, 15.0, 90),

    # -- buck section --
    ("F1",  lib("Fuse"),                        "Fuse_0603_1608Metric",            6.5, 6.0, 0),
    ("D2",  lib("Diode_SMD"),                    "D_SMB",                          13.0, 6.0, 0),
    ("D1",  lib("Diode_SMD"),                    "D_SMB",                          13.0, 11.5, 0),
    ("C1",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              19.0, 6.0, 0),
    ("C2",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              23.0, 6.0, 0),
    ("C5",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              26.5, 4.5, 0),
    ("R3",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              27.0, 9.0, 90),
    ("R4",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              27.0, 12.5, 90),
    ("U3",  lib("Package_TO_SOT_SMD"),           "SOT-23-6",                       31.0, 6.0, 0),
    ("L1",  lib("Inductor_SMD"),                 "L_APV_APH0630",                  39.0, 6.0, 0),
    ("C3",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              34.0, 11.0, 0),
    ("C4",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              38.0, 13.0, 0),
    ("R1",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              41.0, 12.0, 90),
    ("R2",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              41.0, 15.2, 90),

    # -- U1 + local support --
    ("U1",  CUSTOM_FP,                            "ESP32-C3-MINI-1",                50.5, 15.0, 270),
    ("C6",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              46.3, 6.0, 0),
    ("C7",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              49.8, 6.0, 0),
    ("C8",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              53.3, 6.0, 0),
    ("R5",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              56.8, 6.0, 180),
    ("LED1", lib("LED_SMD"),                     "LED_0603_1608Metric",            33.0, 18.2, 0),
    ("R7",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              35.5, 18.2, 90),
    ("LED2", lib("LED_SMD"),                     "LED_0603_1608Metric",            39.0, 18.2, 0),
    ("R8",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              42.5, 18.2, 0),
    ("R6",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              43.0, 21.0, 90),
    ("SW1", lib("Button_Switch_SMD"),            "Panasonic_EVQPUJ_EVQPUA",        41.0, 27.3, 0),
    ("J2",  lib("Connector_PinHeader_2.54mm"),   "PinHeader_1x06_P2.54mm_Vertical", 47.0, 24.5, 90),
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
#
#    U3 and D3 pin numbers below reflect the CORRECTED binding pin maps from
#    DESIGN.md sec7 (see PIN MAP CORRECTIONS in the module docstring). U2's
#    map was already correct in wave 1 and is unchanged.
# ---------------------------------------------------------------------------
POWER_NETS = {
    "12V_RAW":   [("J1", "1"), ("F1", "1")],
    "NET_FUSED": [("F1", "2"), ("D2", "1")],
    # U3 pin 5 = VIN (corrected; wave 1 wrongly used pin 2 = GND).
    "VIN_PROT":  [("D2", "2"), ("D1", "1"), ("C1", "1"), ("C2", "1"), ("R3", "1"), ("U3", "5")],
    "3V3":       [("L1", "2"), ("R1", "1"), ("C3", "1"), ("C4", "1"),
                  ("C6", "1"), ("C7", "1"), ("U1", "3"), ("C9", "1"), ("U2", "3"), ("U2", "5"),
                  ("R5", "2"), ("R6", "2"), ("R7", "1"), ("J2", "1")],
}

SIGNAL_NETS = {
    "SW_NODE":   [("U3", "6"), ("C5", "2"), ("L1", "1")],
    "BST_NODE":  [("C5", "1"), ("U3", "1")],
    # U3 pin 3 = FB (corrected; wave 1 wrongly used pin 5 = VIN).
    "FB_NODE":   [("U3", "3"), ("R1", "2"), ("R2", "1")],
    # U3 pin 4 = EN (corrected; wave 1 wrongly used pin 3 = FB).
    "EN_U3_NODE": [("U3", "4"), ("R3", "2"), ("R4", "1")],
    "U1_EN":     [("U1", "8"), ("R5", "1"), ("C8", "1"), ("J2", "6")],
    "IO9_BOOT":  [("U1", "23"), ("R6", "1"), ("SW1", "1"), ("J2", "5")],
    "CAN_TX":    [("U1", "18"), ("U2", "1")],
    "CAN_RX":    [("U1", "19"), ("U2", "4")],
    "CAN_S":     [("U1", "20"), ("U2", "8")],
    "LED2_DRIVE": [("U1", "22"), ("R8", "2")],
    "TXD0":      [("U1", "31"), ("J2", "3")],
    "RXD0":      [("U1", "30"), ("J2", "4")],
    # D3 pin 2 = CANH line (corrected; wave 1 wrongly used pin 1).
    "CANH":      [("U2", "7"), ("D3", "2"), ("R9", "1"), ("J1", "4")],
    # D3 pin 1 = CANL line (corrected; wave 1 wrongly used pin 3, which is GND).
    "CANL":      [("U2", "6"), ("D3", "1"), ("R9", "2"), ("J1", "5")],
    "LED1_TOP":  [("R7", "2"), ("LED1", "1")],
    "LED2_TOP":  [("R8", "1"), ("LED2", "1")],
}

# GND membership: only needed so we can mark the *pads* with the GND net
# (copper pour on F.Cu/B.Cu does the actual connecting -- no tracks routed).
GND_PADS = [
    ("D1", "2"), ("C1", "2"), ("C2", "2"),
    # U3 pin 2 = GND (corrected; wave 1 wrongly used pin 4 = EN).
    ("U3", "2"),
    ("R4", "2"), ("C3", "2"), ("C4", "2"),
    ("R2", "2"), ("J1", "2"), ("J1", "3"), ("U2", "2"), ("C9", "2"),
    # D3 pin 3 = GND common cathode (corrected; wave 1 wrongly used pin 2 = CANH).
    ("D3", "3"),
    ("C6", "2"), ("C7", "2"), ("C8", "2"), ("SW1", "2"), ("LED1", "2"), ("LED2", "2"), ("J2", "2"),
]
U1_GND_PAD_NUMS = {"1", "2", "11", "14"} | {str(n) for n in range(36, 54)}
# U1's castellated pads (all edge contacts, numbers 1-48) get the amendment's
# local 0.15mm clearance relief; the thermal pad (49) and corner GND anchors
# (50-53) are not castellations and keep the board-wide 0.2mm rule.
U1_CASTELLATED_PAD_NUMS = {str(n) for n in range(1, 49)}

# Track widths per DESIGN.md/ticket sec 3: power 0.6mm, signal 0.25mm, CAN 0.3mm
W_POWER = MM(0.6)
W_SIGNAL = MM(0.25)
W_CAN = MM(0.3)

CAN_NET_NAMES = {"CANH", "CANL"}

# ---------------------------------------------------------------------------
# 2b. Explicit routing plan. With the wave-2 layout, almost every net is now
#     local to one of the three clusters (CAN, buck, U1) and routes as a
#     short direct F.Cu hop. Two kinds of routes still cross the whole
#     board and get dedicated, verified-clear paths:
#       - CAN_TX/RX/S: U1 (right cluster) <-> U2 (left cluster). Each gets
#         its own B.Cu lane in the component-free top corridor
#         (y=2.2/2.9/3.6mm, 0.7mm pitch -- well over the 0.45mm minimum
#         for two 0.25mm-wide traces at 0.2mm clearance).
#       - 3V3: two bridge hops from the buck section's output to the CAN
#         cluster and to the U1 cluster, routed on B.Cu at a y-band
#         (13.5mm) that is clear of the CAN corridor (y<3.6) and of every
#         footprint's pads (checked against the placement table above).
#     Each entry: (net, ref1, pad1, ref2, pad2, width, mode, waypoints_mm)
#     mode: "F" = F.Cu direct, "B" = via/B.Cu/via, "W" = F.Cu via waypoints,
#           "BW" = via/B.Cu via waypoints/via
# ---------------------------------------------------------------------------
ROUTES = [
    # -- protection chain (F.Cu, local, x=4..27) --
    ("12V_RAW",   "J1", "1", "F1", "1", W_POWER, "W", [(4.0, 6.0)]),
    ("NET_FUSED", "F1", "2", "D2", "1", W_POWER, "F", None),
    # D2.2 -> D1.1: dip below the row first so it doesn't clip D1's own
    # GND pad (D1.2 sits at the same Y, between the two in a direct line).
    ("VIN_PROT",  "D2", "2", "D1", "1", W_POWER, "W", [(15.15, 9.5), (10.85, 9.5)]),
    ("VIN_PROT",  "D2", "2", "C1", "1", W_POWER, "F", None),
    # C1.1 -> C2.1: direct would clip C1's own GND pad sitting between them
    # -- hop over it on a bypass lane above the row (row top edge ~5.53,
    # C5's pad top ~4.03 -- Y=4.3 threads clear of both).
    ("VIN_PROT",  "C1", "1", "C2", "1", W_POWER, "W", [(18.225, 4.3), (22.225, 4.3)]),
    ("VIN_PROT",  "C2", "1", "R3", "1", W_POWER, "W", [(22.225, 9.825)]),
    # R3.1 -> U3.5 (VIN): B.Cu -- a direct F.Cu run at R3.1's own Y would
    # cross FB_NODE's vertical drop from U3.3 (same Y band); B.Cu sidesteps
    # that (different layer), so approach via a via at R3.1, east past
    # U3's whole footprint (clear of L1 -- different layer, no conflict
    # with L1's F.Cu pads either), then a via at U3.5.
    ("VIN_PROT",  "R3", "1", "U3", "5", W_POWER, "BW", [(33.0, 9.825), (33.0, 6.0)]),

    # -- buck switching node (local to U3/C5/L1, F.Cu) --
    ("SW_NODE",  "U3", "6", "L1", "1", W_SIGNAL, "F", None),
    # C5.1/C5.2 are only 1.55mm apart and U3.1/U3.6 sit on opposite ends of
    # U3's top row -- any same-layer pairing has one net's vertical
    # (leaving C5's own tight pad spacing) crossing the other's horizontal
    # run above the row. BST_NODE goes B.Cu for this one short hop so it
    # cannot interact with SW_NODE's F.Cu run at all.
    ("SW_NODE",  "C5", "2", "U3", "6", W_SIGNAL, "W", [(27.275, 3.3), (32.138, 3.3)]),
    ("BST_NODE", "C5", "1", "U3", "1", W_SIGNAL, "B", None),

    # -- FB / EN dividers --
    # U3.3 (FB) -> R2.1: F.Cu, straight down U3.3's own column then east
    # under R1/R2's pad rows (Y=16) and up into R2.1. Doesn't interact with
    # the B.Cu bridge/EN routes below even though it shares X/Y space with
    # them (different layer).
    ("FB_NODE",  "U3", "3", "R2", "1", W_SIGNAL, "W", [(29.863, 16.0), (41.0, 16.0)]),
    # R1.2 -> R2.1 direct would thread through R1.1 (3V3) and R2.2 (GND)
    # sitting between them -- detour east of the whole R1/R2 column.
    ("FB_NODE",  "R1", "2", "R2", "1", W_SIGNAL, "W", [(43.5, 11.175), (43.5, 16.025)]),
    # EN_U3_NODE: B.Cu throughout (avoids F.Cu conflicts with VIN_PROT and
    # FB_NODE crossing the same U3-adjacent real estate).
    ("EN_U3_NODE", "U3", "4", "R3", "2", W_SIGNAL, "BW", [(32.138, 8.175)]),
    ("EN_U3_NODE", "R3", "2", "R4", "1", W_SIGNAL, "BW", [(25.0, 8.175), (25.0, 13.325)]),

    # -- buck output rail (3V3), local hops (F.Cu) --
    # L1.2 does not connect to R1.1 directly (any path east runs parallel
    # too close to FB_NODE's R1.2->R2.1 detour at X=43.5) -- instead it
    # joins the already-verified-clear R1.1->C6.1 rail at Y=7.3 (same net,
    # so sharing that lane is harmless).
    ("3V3", "L1", "2", "C6", "1", W_POWER, "W", [(42.025, 7.3), (45.525, 7.3)]),
    # C3.1 -> C4.1 direct would clip C3's own GND pad (C3.2) sitting
    # between them -- dip down first, clear of it.
    ("3V3", "C3", "1", "C4", "1", W_POWER, "W", [(33.225, 12.0)]),
    # C4.1 -> R1.1 direct at C4's own Y would clip C4's own GND pad (C4.2)
    # sitting between them -- drop below the row and approach R1.1 from
    # the WEST at X=40.0 (clear of C4.2's own edge, 39.25, by 0.2mm+
    # margin, and clear of FB_NODE's detour, which only exists east of
    # X=41 at X=43.5).
    ("3V3", "C4", "1", "R1", "1", W_POWER, "W",
     [(37.225, 10.0), (40.0, 10.0), (40.0, 12.825)]),

    # -- CAN cluster, local (J1/U2/D3/R9/C9), F.Cu --
    # D3.2 (CANH) and D3.1 (CANL) sit only 1.9mm apart -- any route leaving
    # one toward R9 that passes near the other's Y needs to detour around
    # it first. CANH exits east (clear of D3.1, which is north of D3.2),
    # CANL exits west (clear of D3.2, which is south of D3.1); R9.1 (south
    # pad) is approached from below, R9.2 (north pad) from the west, so
    # neither route threads the other's pad.
    # U2.7->D3.2 and U2.6->D3.1 swap vertical order between source and
    # destination (U2.7 north of U2.6, but D3.2 south of D3.1) -- any
    # same-layer direct or waypointed pair crosses. Put CANL on B.Cu for
    # this one short hop so it cannot interact with CANH's F.Cu diagonal.
    ("CANH", "U2", "7", "D3", "2", W_CAN, "F", None),
    ("CANL", "U2", "6", "D3", "1", W_CAN, "B", None),
    ("CANH", "D3", "2", "R9", "1", W_CAN, "W", [(21.0, 18.95), (21.0, 23.5), (19.5, 23.5)]),
    # CANL D3.1->R9.2: also B.Cu -- an F.Cu detour west (X=17) crosses
    # CANH's own F.Cu diagonal (U2.7->D3.2 passes through X=17 around
    # Y=18.1, right in the middle of this hop's vertical span).
    ("CANL", "D3", "1", "R9", "2", W_CAN, "B", None),
    # CANH/CANL to J1: thread the SOIC-8's own clear middle channel
    # (|x-13|<1.5mm is copper-free at any Y -- no copper between the pin
    # columns) then jog to a Y band with no left-column pad before
    # crossing under it, then a final approach column at x=6 (clear of
    # both U2's left column and J1's pad column at x=4) down to the
    # target pin's own Y.
    # CANH's own bypass at Y=15/Y=13.3 must dodge C9 (pads at Y=14.225 and
    # 15.775, X=8 -- directly in the naive path): stop short of C9's X at
    # Y=15, dip below its lower pad (Y=13.3, clear of the 13.75 pad edge),
    # continue past it, then resume the original approach into J1.
    ("CANH", "U2", "7", "J1", "4", W_CAN, "W",
     [(13.0, 17.365), (13.0, 15.0), (9.0, 15.0), (9.0, 13.3), (6.0, 13.3), (6.0, 17.62)]),
    ("CANL", "U2", "6", "J1", "5", W_CAN, "W",
     [(13.0, 18.635), (13.0, 21.0), (6.0, 21.0), (6.0, 20.16)]),
    # U2.3 -> C9.1: B.Cu. Steps west to X=9.5 first (same departure point
    # as the U2.5 jumper below -- clear of CAN_RX's descent at X=11.5,
    # which a direct move toward X=13 would otherwise cross at Y=18.635),
    # then straight down past the whole CAN corridor cluster (Y=24.6) and
    # into C9's own column from below.
    ("3V3", "U2", "3", "C9", "1", W_POWER, "BW",
     [(9.5, 18.635), (9.5, 24.6), (8.0, 24.6)]),
    # U2.3 -> U2.5 (VCC -> VIO jumper): B.Cu -- an F.Cu path here
    # unavoidably crosses CANL's middle-channel vertical (X=13.0, spanning
    # Y=18.635-21, which the jumper's own Y=19.905 target sits inside). A
    # straight-down departure from U2.3's own via would sit only 0.475mm
    # from CAN_RX's descent column (X=11.5, clearance needs 0.575mm) --
    # step west first (X=9.5, clear of CAN_TX's own descent at X=9.0) then
    # under CAN_RX (Y=20.7, comfortably below its final approach track at
    # Y=19.7 and its via at Y=19.905) before the final run east into U2.5.
    ("3V3", "U2", "3", "U2", "5", W_POWER, "BW",
     [(9.5, 18.635), (9.5, 20.7), (15.475, 20.7)]),

    # -- 3V3 bridge: buck output (C3.1) -> CAN cluster (U2.5) --
    # B.Cu throughout. Targets U2.5 (not C9.1) -- C9 sits boxed in between
    # CAN_TX/CAN_RX's via cluster (X=10.525) and CAN_S's vertical
    # (X=12.5), leaving no clear approach lane on B.Cu either. U2.5 is
    # approached from due south (X=15.475, past R9/D3 to the east and
    # below everything at Y=25), clear of the whole CAN-corridor cluster.
    ("3V3", "C3", "1", "U2", "5", W_POWER, "BW",
     [(33.225, 25.0), (15.475, 25.0)]),

    # -- 3V3 bridge: buck output (R1.1) -> U1 cluster (C6.1) --
    # F.Cu at Y=12.825 (R1.1's own row) then Y=7.3 (the U1-cluster rail,
    # below), threading the L1-pad gap (clear channel between L1's two
    # 2.35mm-wide pads) at x=39.8.
    ("3V3", "R1", "1", "C6", "1", W_POWER, "W",
     [(39.8, 12.825), (39.8, 7.3), (45.525, 7.3)]),

    # -- U1 cluster, local (F.Cu) --
    # Local 3V3 rail at Y=7.3 (above the C6/C7/C8/R5 row, clear of every
    # pad in it -- each hop only needs to clear its OWN part's sibling GND
    # pad, which a same-Y horizontal run would otherwise clip).
    ("3V3", "C6", "1", "C7", "1", W_POWER, "W", [(45.525, 7.3), (49.025, 7.3)]),
    ("3V3", "C7", "1", "R5", "2", W_POWER, "W", [(49.025, 7.3), (55.975, 7.3)]),
    # U1.3 taps into the rail via C7.1 (its own column first, clear of C8's
    # pads which sit at a different Y).
    ("3V3", "U1", "3", "C7", "1", W_POWER, "W", [(52.9, 7.3), (49.025, 7.3)]),
    # R7.2 -> LED1.1 direct would clip LED1's own GND pad (LED1.2) sitting
    # between them -- hop above the row instead.
    ("LED1_TOP", "R7", "2", "LED1", "1", W_SIGNAL, "W", [(35.5, 17.0), (32.212, 17.0)]),
    # R7.1 (3V3) has no other path onto the 3V3 mesh -- feed it via R6.2
    # (also otherwise-isolated 3V3, see below), sharing one bridge to C6.1.
    ("3V3", "R7", "1", "R6", "2", W_POWER, "W", [(35.5, 20.175), (43.0, 20.175)]),

    ("LED2_DRIVE", "U1", "22", "R8", "2", W_SIGNAL, "F", None),
    # R8.1 -> LED2.1 direct would clip LED2's own GND pad (LED2.2) sitting
    # between them -- hop above the row instead.
    ("LED2_TOP", "R8", "1", "LED2", "1", W_SIGNAL, "W", [(41.675, 17.0), (38.212, 17.0)]),

    # U1.23 -> R6.1: step off U1's pin column in X immediately (at the
    # pin's own Y) before descending, so the vertical leg doesn't graze
    # U1's corner GND anchor pad (pad 51, ~45.55mm) or R6.2 (also x=43,
    # 1.65mm north of R6.1) -- approach R6.1 from below instead.
    ("IO9_BOOT", "U1", "23", "R6", "1", W_SIGNAL, "W", [(44.0, 19.0), (44.0, 22.5), (43.0, 22.5)]),
    # R6.1 -> SW1.1: straight down R6.1's own column first (clear of R6.2,
    # which is north of it) then a short final hop into SW1 -- a direct
    # diagonal here would cross the 3V3/R6.2 bridge below (different X
    # bands were needed for both, see the 3V3 route a few lines down).
    ("IO9_BOOT", "R6", "1", "SW1", "1", W_SIGNAL, "W", [(43.0, 26.45)]),
    # SW1.1 -> J2.5: pad() resolves to SW1's west physical pad (38.375,
    # 26.45); exit straight up first (away from SW1's own GND pad 2, which
    # sits south of pad 1) before the long horizontal at Y=26 (clear of
    # J2's own PTH pads at Y=24.5, 0.85mm radius), rather than a diagonal
    # that would clip pad 2 on the way.
    ("IO9_BOOT", "SW1", "1", "J2", "5", W_SIGNAL, "W",
     [(38.375, 26.0), (57.16, 26.0)]),
    # R6.2 (3V3, also carries R7.1's feed -- see above) -> U1 cluster rail
    # (C6.1). B.Cu. X=41.5 stays west of every CAN net's own near-U1 jog
    # (CAN_S/RX/TX all start their X=42.6/43.3/44.0 jogs no further west
    # than X=42.6) so this vertical never runs parallel through one of
    # them; it also clears R1/R2 and FB_NODE's detour (different layer,
    # no interaction regardless).
    # Targets C7.1, not C6.1 (same net, C6.1 already reaches the rail via
    # the R1.1 bridge) -- C6.1 sits at X=45.525, inside CAN_S's own jog
    # span (X=42.6-45.6) AND only 0.075mm from U1's pin column (X=45.6),
    # so a vertical descent into it crosses CAN_S's jog on B.Cu and crosses
    # U1's own pads on F.Cu -- blocked on both layers. The descent to
    # C7.1 also has to dodge U1_EN's own B.Cu diagonal (U1.8->C8.1,
    # X=48.9-52.525) -- descend at X=48.0 (west of that diagonal's whole
    # X-span, so it can't cross regardless of Y) and jog east into C7.1
    # only at Y=6, clear of C6.2 (X=47.075) on the way.
    ("3V3", "R6", "2", "C7", "1", W_SIGNAL, "BW",
     [(41.5, 20.175), (41.5, 17.5), (48.0, 17.5), (48.0, 6.0)]),
    # J2.1 (3V3) -> R6.2: B.Cu -- an F.Cu path anywhere in this X band
    # (41.5-47) crosses one of IO9_BOOT's own two segments there (U1.23's
    # dogleg at X=44, or R6.1->SW1's vertical at X=43); B.Cu sidesteps
    # both regardless of X.
    ("3V3", "J2", "1", "R6", "2", W_POWER, "B", None),

    # -- U1_EN, B.Cu throughout. U1's row-1-11 pins are on a strict 0.8mm
    #    pitch with 0.8mm-wide pads -- edge-to-edge with ZERO gap between
    #    neighbours, so no F.Cu track can thread between any two of them
    #    (C8.1 at x=52.525 falls squarely between pins 3 and 4, x=52.9/
    #    52.1, with no room at all). Since U1's pads are SMD (F.Cu only),
    #    B.Cu passes underneath the whole row freely. --
    ("U1_EN", "U1", "8", "C8", "1", W_SIGNAL, "B", None),
    # R5.1 (U1_EN) sits at x=57.625 (R5 rotated 180 deg so its U1_EN pin
    # lands clear of U1's own pin-36-48 column at x=55.4).
    ("U1_EN", "C8", "1", "R5", "1", W_SIGNAL, "B", None),
    # R5.1 -> J2.6: B.Cu bridge, well clear of the CAN corridor (max
    # x=44.0) and of every F.Cu pad along the way (different layer).
    ("U1_EN", "R5", "1", "J2", "6", W_SIGNAL, "BW", [(57.625, 8.5), (59.7, 8.5)]),

    # TXD0/RXD0 to J2: TXD0's target (X=52.08) sits inside RXD0's own X
    # span (50.5-54.62) -- any same-layer Manhattan pairing has one net's
    # vertical crossing the other's horizontal somewhere in that shared
    # band. Put TXD0 on B.Cu (short bridge) so it can't interact with
    # RXD0's F.Cu run at all; RXD0's horizontal also clears J2.3's PTH pad
    # itself (0.85mm radius) by staying at Y=22.5, well above the pad.
    ("TXD0", "U1", "31", "J2", "3", W_SIGNAL, "BW", [(51.3, 24.0), (52.08, 24.0)]),
    ("RXD0", "U1", "30", "J2", "4", W_SIGNAL, "W", [(50.5, 22.5), (54.62, 22.5)]),

    # -- CAN trunk: U1 <-> U2, dedicated top corridor. Each net travels its
    #    own Y band (1.5/2.1/2.7) west from its own near-U1 jog, descends
    #    at its own X, then makes a short final approach into its target
    #    pin's own Y (each net's target pin is on U2 itself, so entering
    #    that pin's bounding box at the very end is normal termination,
    #    not a foreign-pad clearance issue).
    #
    #    Deliberately NESTED (not simply ordered) so all four pairwise
    #    horizontal-vs-vertical checks pass for every net pair:
    #      CAN_TX  descends at X=9.0,  Y=[1.5, 15.4]  (target Y=16.095,
    #        approached from above -- clear of U2 pin1's own pad edge,
    #        15.795, by 0.27mm; never goes near C9 or J1 at all since it
    #        never reaches X=8 or below).
    #      CAN_RX  descends at X=11.0, Y=[2.1, 19.7]   (target Y=19.905,
    #        approached from above -- clear of D3's block, which ends at
    #        Y=19.25, and of U2 pin4's own edge).
    #      CAN_S   descends at X=12.5, Y=[2.7, 16.095] (unchanged).
    #    X=9.0 < X=11.0 < X=12.5 and each net's final-approach horizontal
    #    only spans [own-X, target-X] (never reaching past X=11 westward
    #    or needing to cross another net's corridor band at a conflicting
    #    Y) -- verified pairwise: TX's Y=15.4 final run (X=9-10.525) never
    #    reaches CAN_RX's X=11 or CAN_S's X=12.5; RX's Y=19.7 final run
    #    (X=10.525-11) is fully west of CAN_S's X=12.5 and CAN_TX's whole
    #    Y-range tops out at 15.4, well above RX's corridor Y=2.1 crossing
    #    point only in the sense that TX's descent (X=9) is itself west of
    #    RX's corridor reach (X=11), so RX's corridor horizontal (Y=2.1,
    #    reaching down to X=11) never gets as far as X=9.
    ("CAN_TX", "U1", "18", "U2", "1", W_SIGNAL, "BW",
     [(44.0, 15.0), (44.0, 1.5), (9.0, 1.5), (9.0, 15.4), (10.525, 15.4)]),
    # CAN_RX's descent column is X=11.5 (not 11.0) -- U2.3's own via sits
    # at (10.525, 18.635), only 0.475mm from X=11.0 (needs 0.575mm).
    ("CAN_RX", "U1", "19", "U2", "4", W_SIGNAL, "BW",
     [(43.3, 15.8), (43.3, 2.1), (11.5, 2.1), (11.5, 19.7), (10.525, 19.7)]),
    ("CAN_S",  "U1", "20", "U2", "8", W_SIGNAL, "BW",
     [(42.6, 16.6), (42.6, 2.7), (12.5, 2.7), (12.5, 16.095)]),
]

BOARD_W, BOARD_H = 62.0, 30.0
CORNER_R = 2.0


def add_board_outline(board):
    """62x30mm board outline, 2mm rounded corners, on Edge.Cuts."""
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

    # -- amendment: local 0.15mm clearance relief on U1's castellated pads --
    for p in footprints["U1"].Pads():
        if p.GetNumber() in U1_CASTELLATED_PAD_NUMS:
            p.SetLocalClearance(MM(0.15))

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

    # Small isolated 0603 GND pads can end up with only one thermal-relief
    # spoke reaching the pour (starved_thermal). Use a solid (no
    # thermal-relief) zone connection for every pad instead -- fine for
    # JLCPCB reflow assembly, and it removes the spoke-count requirement.
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

    # -- GND copper pour (both layers) --
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        zone = pcbnew.ZONE(board)
        zone.SetLayer(layer)
        zone.SetNet(gnd_net)
        zone.SetIsFilled(False)
        zone.SetLocalClearance(MM(0.25))
        zone.SetMinThickness(MM(0.2))
        outline = zone.Outline()
        outline.NewOutline()
        pts = [(1.2, 1.2), (BOARD_W - 1.2, 1.2), (BOARD_W - 1.2, BOARD_H - 1.2), (1.2, BOARD_H - 1.2)]
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
