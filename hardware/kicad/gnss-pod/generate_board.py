#!/usr/bin/env python3
"""
TRACE GNSS Pod rev A -- PCB generator (KiCad 10 / pcbnew scripting).

Builds hardware/kicad/gnss-pod/gnss-pod.kicad_pcb from scratch. The BINDING
spec is hardware/gnss-pod/DESIGN-REV-A.md: netlist sec 4, pin maps sec 5,
GPIO table sec 6, PCB constraints sec 8. Deterministic: delete and re-run
reproduces the same board.

Run with KiCad 10's bundled Python (has pcbnew + numpy):
    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" generate_board.py

Pipeline
  1. footprints.py writes the custom footprints (fp-lib/TRACE-GNSS.pretty).
  2. Place parts (table PLACEMENTS) and assign nets from netlist_spec.NETS.
  3. self_check(): every pad's net must match the spec table (loud failure).
     place_check(): zone and keep-out rules of sec 8 (loud failure).
  4. Routing (all deterministic; the Freerouting result is stored in
     routing/gnss-pod.ses and re-used unless POD_REROUTE=1):
     a. Fixed copper first: U2_ESCAPES / HAND_EXTRA / HAND_VIAS (GNSS lanes,
        J1 pairs, PPS / V_BCKP jumpers), thermal vias, GND_RESERVE (IMU GND).
     b. Phase 1, own router (autoroute.py, 0.1 mm grid A* with negotiated
        congestion): GNSS nets, supply trunks, USB, I2C/INT, some IO/LEDs.
     c. Phase 2, Freerouting 2.4.1 (portable Temurin JRE 25, per-user
        download) for everything else, with the phase-1 copper locked, GND
        removed from the DSN and temporary rule areas for the zone rules.
     d. Negotiated repair of the Freerouting result, then phase 3 (hard-rule
        A* joins), phase 4 (local rip-up with exact rollback) and phase 5
        (off-grid micro joins checked with KiCad's own shape collision).
  5. GND: via drops next to GND pads, EPAD/thermal vias, stitching vias,
     both-layer GND pours, antenna keep-out rule areas, zone fill, then
     island stitching / island routing until the pour is one node.
  6. Post-route checks: bottom-layer jumper length, GNSS via rule, 3V3
     resistance U5 -> U2.VCC. Then self_check() runs again.

Env: POD_OUT (output path), POD_CKPT / POD_RESUME (checkpoint after the
repair, to iterate on the later phases), POD_BOT_COST, POD_P1_MORE,
POD_REROUTE, FREEROUTING_JAR / FREEROUTING_JAVA (only with POD_REROUTE).
Defaults (POD_BOT_COST=3, POD_P1_MORE=LED1,LED2) are the delivered settings.

Deviations from DESIGN-REV-A.md (all listed in the layout report):
  * GNSS-net vias closer than 20 mm to U2 (PPS, TP18/VBCKP, GNSS_RXD at
    17.5-18.7 mm); 3V3 vias in the Z1/Z2 overlap band are on the rail's
    non-U2 branches (U2's VCC / V_IO branches are the hand lanes, top only).
  * The Z1/Z2 overlap band (y 22..29.25) carries bottom jumpers; south of
    the U2 keep-out box edge the bottom is GND only (checked).
  * Supply trunks 0.5 mm, branches / taps 0.25 mm (spec: >= 0.5 mm).
  * V_IO and VCC are not tied at the module (no single-layer path); C9 sits
    on VCC, C10 on V_IO, both on the 3V3 net.
  * U1's GND pins are a footprint jumper-pad group (one node inside the
    module); U1.63 and the DNP C17/C18 GND pads reach GND through it.
  * IMU GND pins tied under the U3 body; C11, C14, C17, C18 placed/rotated
    for GND access (GND_RESERVE).

Coordinates: the spec uses origin bottom-left, Y up (X along the 50 mm edge).
This board uses KiCad's convention: origin top-left, y down, so
    kicad_x = X,  kicad_y = 72 - Y.
The ESP32 antenna end is therefore at the TOP (y = 0) and the GNSS zone at
the BOTTOM (y 22..72).

VERIFY-AT-LAYOUT outcomes (spec sec 11.3), also in the report:
  * J1 HRO TYPE-C-31-M-12: KiCad footprint pad names were checked against the
    HRO drawing (LCSC C165948 PDF, "Recommend PCB layout"). The drawing's
    left-to-right order A1/B12, A4/B9, B8, A5, B7, A6, A7, B6, A8, B5,
    B4/A9, B1/A12 matches the footprint's pad X order, and the signal table
    (A1/A12/B1/B12 GND, A4/A9/B4/B9 VBUS, A5 CC1, B5 CC2, A6/B6 DP, A7/B7 DN,
    A8/B8 SBU) matches too. NAMES VERIFIED.
    The 4 shell tabs are plated slots (THT) in both the drawing and the
    footprint, so JLCPCB must through-hole solder them or the owner
    hand-solders them (spec sec 9 item 3 applies).
  * SW1/SW2 XKB TS-1187A: the drawing (LCSC C318884) shows A-B shorted and
    C-D shorted, with the switch between the two pairs. KiCad footprint
    SW_Push_1P1T_XKB_TS-1187A numbers A,B = "1" (y = -1.875) and C,D = "2"
    (y = +1.875), and the drawing's PCB-layout 7.0/5.0/4.5/3.0 dims match the
    footprint's pads. So pad "1" = signal, pad "2" = GND. The duplicate pad numbers are
    declared as jumpers (internal short), so one pad of each pair carries
    the route. VERIFIED.
  * SW3 SOFNG SS-12D00-G3: the circuit diagram in the drawing shows the
    middle terminal as the common. LDO_EN goes to pin 2 (middle). VERIFIED.
    SPEC ERROR: the pin pitch is 2.5 mm, not 3 mm (G3 = handle length).
  * SAM-M10Q bypass (C9/C10 values): Fig. 28 of the IM was not re-extracted
    here. The values stay as the spec chose them. NOT VERIFIED (schematic).
  * LSM6DSV16X rev: pin map re-checked against DS13510 Rev 4 Fig. 5 (bottom
    view, mirrored) and Fig. 33 (package): pins 1-4 left, 5-7 bottom, 8-11
    right, 12-14 top. Custom land pattern (footprints.py). The st.com
    current revision was not fetched. PARTLY VERIFIED.
"""
import math
import os
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import footprints  # noqa: E402
import netlist_spec as spec  # noqa: E402
from autoroute import Router, VIA_D, VIA_DRILL, HW, CLR, astar2, MARGIN as ROUTER_MARGIN  # noqa: E402

KI_FP = os.path.join(os.environ.get("LOCALAPPDATA", r"C:\Users\dobri\AppData\Local"),
                     r"Programs\KiCad\10.0\share\kicad\footprints")
CUSTOM = os.path.join(HERE, "fp-lib", "TRACE-GNSS.pretty")
OUT_PCB = os.environ.get("POD_OUT") or os.path.join(HERE, "gnss-pod.kicad_pcb")
def MM(v):
    return pcbnew.FromMM(float(v))
BOARD_W, BOARD_H = 50.0, 72.0


def S(X, Y):
    """spec coordinates (origin bottom-left, Y up) -> KiCad board mm."""
    return X, BOARD_H - Y


def lib(name):
    return os.path.join(KI_FP, name + ".pretty")


# ---------------------------------------------------------------------------
# Spec sec 8 geometry, in KiCad coordinates
# ---------------------------------------------------------------------------
Z3_Y = BOARD_H - 66.9          # 5.1: antenna band y < 5.1 (both-layer copper keep-out)
Z1_Y = BOARD_H - 50.0          # 22.0: GNSS zone y > 22 (bottom solid GND, nothing on bottom)
GNSS_VIA_Y = BOARD_H - 52.75   # 19.25: no via on a GNSS net at y > 19.25 (spec)
GNSS_VIA_RELAXED_Y = 21.75     # deviation, see report (via copper stays inside Z2)
VBUS_EXC = (10.8, 23.7)        # deviation: VBUS bottom/via corner in Z1 (x <, y <), see report
KEEPOUT = (7.25, BOARD_H - 42.75, 42.75, BOARD_H - 7.25)   # x0, y0(29.25), x1, y1(64.75)
U2_POS = S(25.0, 25.0)         # (25, 47)
U1_POS = (25.0, 12.8)          # module body y 0..20.5 = spec Y 51.5..72, antenna flush with top edge
U3_POS = (25.0, 25.45)        # spec (25, ~46.5); y 25.45 puts the 0.5 mm LGA pads on the 0.1 mm routing grid

# ---------------------------------------------------------------------------
# 1. Placement: (ref, libdir, footprint, x, y, rot, side)   side "F" or "B"
# ---------------------------------------------------------------------------
R0402 = (lib("Resistor_SMD"), "R_0402_1005Metric")
C0402 = (lib("Capacitor_SMD"), "C_0402_1005Metric")
C0603 = (lib("Capacitor_SMD"), "C_0603_1608Metric")
C0805 = (lib("Capacitor_SMD"), "C_0805_2012Metric")
R0603 = (lib("Resistor_SMD"), "R_0603_1608Metric")
LED0603 = (lib("LED_SMD"), "LED_0603_1608Metric")
TP = (lib("TestPoint"), "TestPoint_Pad_D1.0mm")
MH = (lib("MountingHole"), "MountingHole_2.2mm_M2")
TACT = (lib("Button_Switch_SMD"), "SW_Push_1P1T_XKB_TS-1187A")

PLACEMENTS = [
    # -- spec-fixed ----------------------------------------------------------
    ("U1", CUSTOM, "ESP32-S3-MINI-1", *U1_POS, 0, "F"),
    ("U2", CUSTOM, "u-blox_SAM-M10Q", *U2_POS, 0, "F"),    # pins 16-20 edge faces +Y (spec) = -y
    ("U3", CUSTOM, "LGA-14_2.5x3mm_P0.5mm_LSM6DSV16X", *U3_POS, 0, "F"),
    ("J1", lib("Connector_USB"), "USB_C_Receptacle_HRO_TYPE-C-31-M-12", 3.65, 20.05, 270, "F"),
    ("MH1", *MH, *S(3.5, 3.5), 0, "F"),
    ("MH2", *MH, *S(46.5, 3.5), 0, "F"),
    ("MH3", *MH, *S(3.5, 60.0), 0, "F"),
    ("MH4", *MH, *S(46.5, 60.0), 0, "F"),
    # -- west half (spec sec 8): J1 -> U7 -> U4 -> U5, NW corner = U5/U4 (heat
    #    far from U2/U3). Placement grid solved against courtyards by
    #    place_check(); U4 (VQFN) >= 10 mm from U3 (checked).
    ("U7", lib("Package_TO_SOT_SMD"), "SOT-23-6", 13.02, 19.95, 0, "F"),
    ("R4", *R0402, 15.8, 19.0, 90, "F"),
    ("R3", *R0402, 15.8, 21.0, 90, "F"),
    # C17/C18 (DNP D+/D- caps) just south of U1's bottom-left corner: their
    # GND pads tie to U1.63 (module GND corner pad), see GND_RESERVE
    ("C18", *C0402, 18.0, 21.8, 90, "F"),
    ("C17", *C0402, 16.8, 23.3, 0, "F"),
    ("R1", *R0402, 9.94, 18.45, 0, "F"),
    ("R2", *R0402, 10.2, 22.25, 0, "F"),
    ("C1", *C0603, 12.1, 16.4, 0, "F"),
    ("R9", *R0402, 14.2, 17.2, 90, "F"),
    ("U4", CUSTOM, "TI_RGT0016C_VQFN-16_3x3mm_P0.5mm_EP1.68mm", 12.15, 13.25, 180, "F"),
    ("R10", *R0402, 9.4, 13.3, 90, "F"),
    ("C2", *C0805, 7.8, 12.0, 90, "F"),
    ("C3", *C0805, 15.3, 12.8, 90, "F"),
    ("R12", *R0402, 12.4, 10.0, 0, "F"),
    ("U5", CUSTOM, "TI_DYD0005A_SOT-23-5_ThermalPad", 11.7, 7.0, 0, "F"),
    ("C4", *C0402, 8.55, 6.05, 180, "F"),
    ("C5", *C0603, 15.4, 6.0, 180, "F"),
    ("C7", *C0402, 16.4, 7.8, 90, "F"),
    ("C6", *C0805, 15.15, 9.9, 180, "F"),
    # VBAT divider in the free pocket above MH3
    ("R13", *R0402, 6.2, 6.4, 90, "F"),
    ("R14", *R0402, 6.2, 8.5, 90, "F"),
    ("C16", *C0402, 7.4, 8.5, 90, "F"),
    # J3 spare pad row (DNP bare SMD pads, no part), west band just north of
    # the U2 keep-out box (top only, nothing added to the bottom layer).
    ("J3", CUSTOM, "PadRow_1x08_P2.54mm_SMD", 10.9, 27.7, 0, "F"),
    # -- east half (spec sec 8): J2 + SW3 on the east edge, U6, LEDs on the edge,
    #    SW1/SW2 near the edge. THT parts (J2, SW3) stay in Z2 (y < 22) so no
    #    non-GND pad reaches the solid bottom GND of Z1. x 33..36 is kept free
    #    as the corridor for the U2 lines climbing to U1's east pins.
    ("SW3", CUSTOM, "SW_Slide_SPDT_SOFNG_SS-12D00-G3", 45.2, 7.32, 0, "F"),
    ("SW2", *TACT, 41.2, 13.5, 90, "F"),
    ("R5", *R0402, 34.1, 6.6, 90, "F"),
    ("C8", *C0402, 34.1, 9.0, 90, "F"),
    ("J2", lib("Connector_JST"), "JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical", 46.6, 19.0, 90, "F"),
    ("RT1", *R0603, 43.4, 19.0, 90, "F"),
    ("U6", lib("Package_TO_SOT_SMD"), "SOT-23", 40.0, 19.6, 0, "F"),
    ("C12", *C0402, 43.2, 21.2, 0, "F"),
    ("C13", *C0402, 39.5, 22.0, 0, "F"),
    ("R6", *R0402, 34.1, 11.2, 90, "F"),  # BOOT pull-up: on the BOOT route to SW1 (east)
    ("SW1", *TACT, 42.0, 25.5, 0, "F"),
    ("LED1", *LED0603, 48.45, 23.5, 0, "F"),
    ("LED2", *LED0603, 48.45, 25.5, 0, "F"),
    ("LED3", *LED0603, 48.45, 27.5, 0, "F"),
    ("R15", *R0402, 46.4, 23.5, 90, "F"),
    ("R16", *R0402, 46.4, 25.5, 90, "F"),
    ("R11", *R0402, 46.4, 27.5, 90, "F"),
    # -- GNSS support at the +Y edge of the 10 mm keep-out (spec sec 8) -------------
    # C9 (4.7 uF) on the VCC branch, C10 (100 nF) on the V_IO branch: the two
    # U2 supply pins cannot be tied at the module on one layer (see report).
    # R17 sits west with C11 because V_BCKP (pin 3) must escape west.
    ("C9", *C0402, 35.6, 27.6, 0, "F"),
    ("C10", *C0402, 23.3, 28.55, 0, "F"),
    ("C11", *C0402, 21.3, 28.55, 0, "F"),        # VBCKP pad west (lane end), GND east
    ("R17", *R0402, 21.2, 26.6, 270, "F"),
    # -- IMU support --------------------------------------------------------------
    ("C14", *C0402, 27.8, 26.2, 270, "F"),       # GND pad south (strap into Z1)
    ("C15", *C0402, 22.6, 26.4, 90, "F"),
    ("R7", *R0402, 22.9, 22.6, 90, "F"),
    ("R8", *R0402, 27.6, 23.0, 90, "F"),
    # -- bottom test pads (spec: bottom, electronics zone only -> y < 22) ----------
    ("TP1", *TP, 19.9, 7.4, 0, "B"),
    ("TP17", *TP, 19.9, 9.6, 0, "B"),
    ("TP10", *TP, 19.9, 11.8, 0, "B"),
    ("TP11", *TP, 19.9, 14.0, 0, "B"),
    ("TP19", *TP, 19.9, 16.2, 0, "B"),
    ("TP16", *TP, 30.1, 7.4, 0, "B"),
    ("TP14", *TP, 30.1, 9.6, 0, "B"),
    ("TP13", *TP, 30.1, 11.8, 0, "B"),
    ("TP15", *TP, 30.1, 14.0, 0, "B"),
    ("TP7", *TP, 30.1, 16.2, 0, "B"),
    ("TP8", *TP, 27.6, 16.4, 0, "B"),
    ("TP12", *TP, 25.0, 16.4, 0, "B"),
    ("TP2", *TP, 22.4, 7.4, 0, "B"),
    ("TP3", *TP, 25.0, 7.4, 0, "B"),
    # via-in-pad test pads on the hand-routed PPS / V_BCKP copper (see HAND_EXTRA)
    ("TP9", *TP, 26.7, 21.45, 0, "B"),
    ("TP18", *TP, 21.9, 20.75, 0, "B"),
    ("TP4", *TP, 13.0, 9.4, 0, "B"),
    ("TP5", *TP, 8.4, 9.9, 0, "B"),
    ("TP6", *TP, 10.5, 17.3, 0, "B"),
]

VALUES = {
    "U1": "ESP32-S3-MINI-1-N8", "U2": "SAM-M10Q-00B", "U3": "LSM6DSV16XTR", "U4": "BQ24073RGTR",
    "U5": "TLV75733PDYDR", "U6": "XC6206P332MR-G", "U7": "USBLC6-2SC6",
    "J1": "TYPE-C-31-M-12", "J2": "B2B-PH-K-S(LF)(SN)", "J3": "DNP 1x8 spare pads",
    "SW1": "TS-1187A-B-A-B BOOT", "SW2": "TS-1187A-B-A-B RESET", "SW3": "SS-12D00-G3 POWER",
    "RT1": "NCP18XH103F03RB 10k NTC", "LED1": "KT-0603Y yellow", "LED2": "KT-0603R red",
    "LED3": "KT-0603R red CHG",
    "C1": "1uF 50V X5R 0603", "C2": "22uF 25V X5R 0805", "C3": "22uF 25V X5R 0805",
    "C6": "22uF 25V X5R 0805", "C4": "1uF 25V X5R 0402", "C8": "1uF 25V X5R 0402",
    "C12": "1uF 25V X5R 0402", "C13": "1uF 25V X5R 0402", "C5": "10uF 10V X5R 0603",
    "C9": "4.7uF 10V X5R 0402",
    "C7": "100nF 16V X7R 0402", "C10": "100nF 16V X7R 0402", "C11": "100nF 16V X7R 0402",
    "C14": "100nF 16V X7R 0402", "C15": "100nF 16V X7R 0402", "C16": "100nF 16V X7R 0402",
    "C17": "DNP", "C18": "DNP",
    "R1": "5.1k 1%", "R2": "5.1k 1%", "R3": "22R", "R4": "22R", "R5": "10k 1%", "R6": "10k 1%",
    "R7": "4.7k 1%", "R8": "4.7k 1%", "R9": "3.3k 1%", "R10": "1.5k 1%", "R11": "1.5k 1%",
    "R12": "100k 1%", "R13": "1M 1%", "R14": "1M 1%", "R15": "1k 1%", "R16": "1k 1%", "R17": "0R",
}
for i in range(1, 20):
    VALUES[f"TP{i}"] = "TP"
for i in range(1, 5):
    VALUES[f"MH{i}"] = "M2"

# LCSC codes, spec sec 3 (checked live by the spec author on 2026-09-24)
LCSC = {
    "U1": "C2913206", "U2": "C5443880", "U3": "C5267406", "U4": "C15220", "U5": "C22399950",
    "U6": "C5446", "U7": "C7519", "J1": "C165948", "J2": "C131337",
    "SW1": "C318884", "SW2": "C318884", "SW3": "C22355741", "RT1": "C13564",
    "LED1": "C2287", "LED2": "C2286", "LED3": "C2286",
    "C1": "C15849", "C2": "C45783", "C3": "C45783", "C6": "C45783",
    "C4": "C52923", "C8": "C52923", "C12": "C52923", "C13": "C52923",
    "C5": "C19702", "C9": "C23733",
    "C7": "C1525", "C10": "C1525", "C11": "C1525", "C14": "C1525", "C15": "C1525", "C16": "C1525",
    "R1": "C25905", "R2": "C25905", "R3": "C25092", "R4": "C25092", "R5": "C25744", "R6": "C25744",
    "R7": "C25900", "R8": "C25900", "R9": "C25890", "R10": "C25867", "R11": "C25867",
    "R12": "C25741", "R13": "C26083", "R14": "C26083", "R15": "C11702", "R16": "C11702",
    "R17": "C17168",
}
DNP = {"C17", "C18", "J3"}              # footprint only, never assembled
HAND_SOLDER = {"J2", "SW3"}              # bought loose, hand-soldered by the owner (spec sec 9)
NOT_A_PART = {f"TP{i}" for i in range(1, 20)} | {f"MH{i}" for i in range(1, 5)}


# ---------------------------------------------------------------------------
# 2. Board construction helpers
# ---------------------------------------------------------------------------
def add_outline(board):
    """50 x 72 mm rectangle (spec sec 8), square corners (the antenna edge
    must be straight and flush with the module)."""
    pts = [(0, 0), (BOARD_W, 0), (BOARD_W, BOARD_H), (0, BOARD_H)]
    for a, b in zip(pts, pts[1:] + pts[:1]):
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(pcbnew.VECTOR2I(MM(a[0]), MM(a[1])))
        s.SetEnd(pcbnew.VECTOR2I(MM(b[0]), MM(b[1])))
        s.SetLayer(pcbnew.Edge_Cuts)
        s.SetWidth(MM(0.1))
        board.Add(s)


def add_rect_graphic(board, x0, y0, x1, y1, layer, width=0.1):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for a, b in zip(pts, pts[1:] + pts[:1]):
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(pcbnew.VECTOR2I(MM(a[0]), MM(a[1])))
        s.SetEnd(pcbnew.VECTOR2I(MM(b[0]), MM(b[1])))
        s.SetLayer(layer)
        s.SetWidth(MM(width))
        board.Add(s)


def add_text(board, txt, x, y, layer, size=0.8, rot=0, mirror=False):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(txt)
    t.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
    t.SetLayer(layer)
    t.SetTextSize(pcbnew.VECTOR2I(MM(size), MM(size)))
    t.SetTextThickness(MM(max(0.12, size * 0.15)))
    t.SetTextAngleDegrees(rot)
    if mirror:
        t.SetMirrored(True)
    board.Add(t)


def place(board):
    fps = {}
    for ref, libdir, name, x, y, rot, side in PLACEMENTS:
        fp = pcbnew.FootprintLoad(libdir, name)
        if fp is None:
            raise SystemExit(f"FATAL: footprint not found: {libdir}/{name} ({ref})")
        fp.SetReference(ref)
        fp.SetValue(VALUES.get(ref, name))
        board.Add(fp)
        if side == "B":
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        fp.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
        fp.SetOrientationDegrees(rot)
        if ref in DNP:
            fp.SetDNP(True)
            fp.SetExcludedFromBOM(False)
        if ref in NOT_A_PART:
            fp.SetExcludedFromBOM(True)
            fp.SetExcludedFromPosFiles(True)
        fps[ref] = fp
    return fps


def assign_nets(board, fps):
    p2n = spec.pad_to_net()
    nets = {}
    for name in sorted(spec.NETS):
        n = pcbnew.NETINFO_ITEM(board, name)
        board.Add(n)
        nets[name] = n
    for fp in fps.values():
        for p in fp.Pads():
            key = (fp.GetReference(), p.GetNumber())
            if key in p2n:
                p.SetNet(nets[p2n[key]])
    return nets


def self_check(board):
    """Compare every pad on the board with the spec netlist (sec 4). Fails loudly."""
    p2n = spec.pad_to_net()
    nc = set(spec.NO_CONNECT)
    errors = []
    seen = set()
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        for p in fp.Pads():
            num = p.GetNumber()
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH or (num == "" and not p.IsOnCopperLayer()):
                continue
            if num == "":   # paste-only apertures (SAM-M10Q)
                continue
            key = (ref, num)
            got = p.GetNetname() or None
            want = p2n.get(key)
            if want is None and key not in nc:
                errors.append(f"{ref}.{num}: pad not in spec netlist and not a listed NC (has net {got})")
            elif want != got:
                errors.append(f"{ref}.{num}: board net {got!r} != spec net {want!r}")
            seen.add(key)
    for key, net in p2n.items():
        if key not in seen:
            errors.append(f"{key[0]}.{key[1]}: spec pad (net {net}) missing on the board")
    for key in nc:
        if key not in seen:
            errors.append(f"{key[0]}.{key[1]}: spec NC pad missing on the board")
    if errors:
        print("NETLIST SELF-CHECK FAILED:")
        for e in errors:
            print("   ", e)
        raise SystemExit(2)
    print(f"netlist self-check OK: {len(seen)} pads match DESIGN-REV-A.md sec 4 "
          f"({len(p2n)} netted, {len(nc)} no-connect)")


def courtyard_bbox(fp):
    side = pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd
    cy = fp.GetCourtyard(side)
    if cy.OutlineCount() == 0:
        bb = fp.GetBoundingBox(False)
    else:
        bb = cy.BBox()
    return (pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()),
            pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()))


def place_check(fps):
    """Spec sec 8 placement rules. Fails loudly."""
    errs = []
    k0x, k0y, k1x, k1y = KEEPOUT
    for ref, fp in fps.items():
        if ref.startswith("MH"):
            continue
        x0, y0, x1, y1 = courtyard_bbox(fp)
        if ref != "U2" and x1 > k0x and x0 < k1x and y1 > k0y and y0 < k1y:
            errs.append(f"{ref} courtyard enters the 10 mm GNSS keep-out box")
        if ref != "U1" and y0 < Z3_Y - 0.001:
            errs.append(f"{ref} courtyard enters the antenna band Z3 (y < {Z3_Y:.2f})")
        if fp.IsFlipped() and max(pcbnew.ToMM(p.GetBoundingBox().GetBottom()) for p in fp.Pads()) > Z1_Y:
            errs.append(f"{ref} is on the bottom inside Z1 (bottom must be solid GND)")
        if ref not in ("U1", "J1") and (x0 < 0 or y0 < 0 or x1 > BOARD_W or y1 > BOARD_H):
            errs.append(f"{ref} courtyard outside the board")
        if fp.IsFlipped() is False and ref.startswith("TP"):
            errs.append(f"{ref} must be on the bottom")
    for ref in fps:
        if ref.startswith("TP") and not fps[ref].IsFlipped():
            errs.append(f"{ref} not on bottom")
    # U3 distances (sec 8): >= 10 mm from U4/U5, >= 5 mm from SW1/SW2 (courtyard gap)

    def gap(a, b):
        ax0, ay0, ax1, ay1 = courtyard_bbox(fps[a])
        bx0, by0, bx1, by1 = courtyard_bbox(fps[b])
        dx = max(bx0 - ax1, ax0 - bx1, 0)
        dy = max(by0 - ay1, ay0 - by1, 0)
        return math.hypot(dx, dy)
    for other, lim in (("U4", 10), ("U5", 10), ("SW1", 5), ("SW2", 5)):
        d = gap("U3", other)
        if d < lim:
            errs.append(f"U3 only {d:.1f} mm from {other} (spec >= {lim})")
    # courtyard overlaps (same side); mounting holes = 2.45 mm courtyard circle
    refs = [r for r in fps if not r.startswith("MH")]
    for i, a in enumerate(refs):
        for b in refs[i + 1:]:
            if fps[a].IsFlipped() != fps[b].IsFlipped():
                continue
            ax0, ay0, ax1, ay1 = courtyard_bbox(fps[a])
            bx0, by0, bx1, by1 = courtyard_bbox(fps[b])
            if ax1 > bx0 and bx1 > ax0 and ay1 > by0 and by1 > ay0:
                errs.append(f"courtyard overlap {a} / {b}")
    for m in [r for r in fps if r.startswith("MH")]:
        c = fps[m].GetPosition()
        cx, cy = pcbnew.ToMM(c.x), pcbnew.ToMM(c.y)
        for r in refs:
            x0, y0, x1, y1 = courtyard_bbox(fps[r])
            dx = max(x0 - cx, cx - x1, 0)
            dy = max(y0 - cy, cy - y1, 0)
            if math.hypot(dx, dy) < 2.45:
                errs.append(f"courtyard of {r} too close to mounting hole {m}")
    if errs:
        print("PLACEMENT CHECK FAILED:")
        for e in errs:
            print("   ", e)
        if os.environ.get("PLACE_ONLY"):
            return False
        raise SystemExit(3)
    print("placement check OK (keep-out box, Z1/Z3, U3 distances, courtyards)")
    return True



# ---------------------------------------------------------------------------
# 4. Routing (autoroute.Router with the spec sec 8 rules)
# ---------------------------------------------------------------------------
W_SIG = 0.2        # spec sec 8: 0.2 mm track minimum
W_NECK = 0.25      # power nets inside fine-pitch pad fields (QFN/LGA/USB-C/module) only
W_PWR = 0.5        # spec sec 8: VBUS/VSYS/VBAT/3V3 >= 0.5 mm
PAD_PEN = float(os.environ.get('POD_PAD_PEN', '0.4'))
BOT_COST = float(os.environ.get('POD_BOT_COST', '3.0'))
NEG_GROWTH = float(os.environ.get('POD_NEG_GROWTH', '1.6'))
NEG_HIST = float(os.environ.get('POD_NEG_HIST', '1.5'))
# Current-carrying power paths (spec sec 8: power tracks >= 0.5 mm). Every
# other connection of a power net is a tap (pull-ups, divider, logic EN pins,
# the LDO-EN slide switch, ESD VBUS pin, test pads, IMU/J3 supply) carrying
# <= 10 mA; taps are routed 0.25 mm (deviation, see report).
TRUNK = {
    "3V3": {"U5.5", "C5.1", "C6.1", "C7.1", "U1.3", "C9.1", "C10.1", "U2.17", "U2.2"},
    "VSYS": {"U4.10", "U4.11", "C2.1", "U5.1", "C4.1"},
    "VBAT": {"J2.1", "U4.2", "U4.3", "C3.1"},
    "VBUS": {"J1.A4", "J1.B9", "J1.A9", "J1.B4", "U4.13", "C1.1"},
}
W_TAP = 0.25
NO_TOP_UNDER = ("U1", "U2", "U3", "U4", "U5", "U7", "J1")

# U2 escapes, hand-routed on F.Cu (spec sec 8 "GNSS routing rule"). On one
# layer, with no vias allowed within 20 mm of the module, the escape order
# around the module is fixed by the pin order. So the 8 escapes are scripted
# as lanes that hug the module (0.45 mm pitch, 0.6 mm next to the 0.5 mm supply),
# and the router continues from each lane end:
#   east bundle, west->east: EXTINT, RESET_N, VCC(3V3), RXD, TXD, SAFEBOOT_N
#     (top-edge pins go north then east, flank pins go east, SAFEBOOT_N goes
#     south then east round the corner), all climbing north at x 33.7..37.8
#     towards U1's east pins; they hand off at y = 22.0.
#   west, west->east: PPS (south, then round the west flank; it must end
#     west of the east bundle to reach U1.25 on U1's bottom row), V_BCKP -> C11,
#     V_IO (3V3) -> C10.
# VCC and V_IO are NOT tied at the module: a one-layer tie round the corner
# would enclose RESET_N/EXTINT (spec error). They meet through the 3V3 rail.
U2_ESCAPES = [
    # east bundle, all on the 0.1 mm routing grid: lanes x 33.7 / 34.2 / 34.8 /
    # 36.8 / 37.3 / 37.8 (0.5 mm pitch, 0.6 mm next to the 0.5 mm supply), hand-off y 22.0
    ("GNSS_EXTINT", 0.2, [(23.1, 40.4), (23.1, 36.9), (33.7, 36.9), (33.7, 22.0)]),
    ("GNSS_RESET_N", 0.2, [(25.0, 40.4), (25.0, 37.4), (34.2, 37.4), (34.2, 22.0)]),
    ("3V3", 0.5, [(26.9, 40.4), (26.9, 38.0), (34.8, 38.0), (34.8, 22.0)]),        # VCC, passes C9.1
    ("GNSS_RXD", 0.2, [(31.6, 45.1), (36.8, 45.1), (36.8, 22.0)]),
    ("GNSS_TXD", 0.2, [(31.6, 47.0), (37.3, 47.0), (37.3, 22.0)]),
    ("GNSS_SAFEBOOT_N", 0.2, [(25.0, 53.6), (25.0, 56.1), (37.8, 56.1), (37.8, 22.0)]),
    # west: PPS (outermost), V_BCKP, V_IO
    ("PPS", 0.2, [(23.1, 53.6), (23.1, 56.1), (15.6, 56.1), (15.6, 25.0)]),
    ("VBCKP", 0.2, [(18.4, 47.0), (16.1, 47.0), (16.1, 29.4), (20.82, 29.4), (20.82, 28.55)]),  # -> C11.1
    ("3V3", 0.5, [(18.4, 45.1), (16.8, 45.1), (16.8, 30.1), (22.82, 30.1), (22.82, 28.55)]),    # V_IO -> C10.1
]

# Hand-routed continuations (group, net, width, layer 0=F/1=B, points).
#   PPS: its lane ends west of the band at (15.6, 25.0). It dives at y 21.7
#   (via copper still inside Z2), runs on the bottom along U1's bottom edge and
#   comes up under U1.25, so everything that runs north-south under U1 crosses
#   it on the top layer. TP9 sits via-in-pad on the east via.
#   V_BCKP: a branch from R17.2 goes north to TP18 (via-in-pad).
HAND_EXTRA = [
    ("PPS", "PPS", 0.2, 0, [(15.6, 25.0), (14.1, 23.6), (14.1, 21.7)]),
    ("PPS", "PPS", 0.2, 1, [(14.1, 21.7), (26.7, 21.7)]),
    ("PPS", "PPS", 0.2, 0, [(26.7, 21.7), (26.7, 19.8)]),
    ("VBTP", "VBCKP", 0.2, 0, [(21.2, 27.11), (21.9, 27.11), (21.9, 20.75)]),
    # J1: A6/B6 (D+) and A7/B7 (D-) interleave at 0.5 mm pitch, so no via fits
    # between them. D+ is joined just east of the pad row; D- just west of it
    # (under the receptacle body, clear of the NPTH pegs at y 17.11 / 22.89).
    ("J1DP", "USB_DP_C", 0.2, 0, [(8.2, 19.8), (8.9, 19.8), (8.9, 20.8), (8.2, 20.8)]),
    ("J1DN", "USB_DN_C", 0.2, 0, [(7.2, 19.3), (6.6, 19.3), (6.6, 20.3), (7.2, 20.3)]),
    # J1 lower VBUS pair (A9/B4, in Z1 behind CC2): short top neck, via in the
    # documented Z1-corner exception, bottom run through the J3 pad gap, and up
    # again through TP6 (VBUS test pad, via-in-pad).
    ("J1VB", "VBUS", 0.3, 0, [(8.3, 22.45), (8.8, 22.45), (9.1, 23.2)]),
    ("J1VB", "VBUS", 0.5, 1, [(9.1, 23.2), (9.9, 22.4), (9.9, 18.2), (10.5, 17.6), (10.5, 17.3)]),
    # U7.5 (VBUS) sits between its own D+/D- flow-through outputs: via beside it
    ("U7VB", "VBUS", 0.25, 0, [(14.1, 19.95), (14.95, 19.95)]),
]
# Reserved GND copper, placed before any routing (fixed for every router):
# the IMU and its caps sit in the busy band between U1 and the GNSS keep-out,
# where the GND pour would otherwise be cut into islands. Each GND pad gets a
# stub + via, and bottom GND straps run south into the solid Z1 bottom pour.
# (width, layer 0=F/1=B, points)
GND_RESERVE_TRACKS = [
    # IMU: U3.1-3 (SA0, SDx, SCx -> GND) + C15.2 tied to U3.6 inside the pad
    # ring (under the solder-masked body), U3.6/7 strapped south on the top
    # layer into the Z1 top pour
    (0.2, 0, [(23.84, 24.7), (23.84, 25.7)]),
    (0.2, 0, [(22.6, 25.92), (23.2, 25.75), (23.84, 25.7)]),
    (0.2, 0, [(23.84, 25.7), (24.75, 25.7), (25.0, 25.95), (25.0, 26.36)]),
    (0.25, 0, [(25.0, 26.36), (25.25, 26.95)]),
    (0.25, 0, [(25.5, 26.36), (25.25, 26.95)]),
    (0.3, 0, [(25.25, 26.95), (25.25, 29.7)]),
    (0.3, 0, [(27.8, 26.68), (27.8, 29.7)]),                       # C14.2 (IMU Vdd cap) south
    (0.25, 0, [(21.78, 28.55), (21.8, 29.1)]),                     # C11.2 -> via into Z1
    (0.25, 0, [(18.0, 19.8), (18.0, 21.32)]),                      # U1.63 (GND) -> C18.2
    (0.25, 0, [(17.28, 23.3), (17.28, 21.6), (18.0, 21.32)]),      # C17.2 -> C18.2
]
GND_RESERVE_VIAS = [(21.8, 29.1)]

HAND_VIAS = [("PPS", 14.1, 21.7), ("PPS", 26.7, 21.7), ("VBCKP", 21.9, 20.75),
             ("VBUS", 9.1, 23.2), ("VBUS", 10.5, 17.3), ("VBUS", 14.95, 19.95)]


def pad_shape(p):
    """Axis-aligned approximation of a pad's copper ("rect" or "seg" capsule)."""
    bb = p.GetBoundingBox()
    x0, y0 = pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop())
    x1, y1 = pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom())
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hw, hh = (x1 - x0) / 2, (y1 - y0) / 2
    shp = p.GetShape()
    if shp in (pcbnew.PAD_SHAPE_CIRCLE, pcbnew.PAD_SHAPE_OVAL):
        r = min(hw, hh)
        if hw >= hh:
            return ("seg", cx - hw + r, cy, cx + hw - r, cy, r)
        return ("seg", cx, cy - hh + r, cx, cy + hh - r, r)
    return ("rect", cx, cy, hw, hh)


def pad_layers(p):
    ls = []
    if p.IsOnLayer(pcbnew.F_Cu):
        ls.append(0)
    if p.IsOnLayer(pcbnew.B_Cu):
        ls.append(1)
    return ls


def body_rect(fp):
    """F.Fab outline bbox of a footprint (the component body)."""
    xs, ys = [], []
    for g in fp.GraphicalItems():
        if g.GetLayer() == pcbnew.F_Fab and isinstance(g, pcbnew.PCB_SHAPE):
            bb = g.GetBoundingBox()
            xs += [pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetRight())]
            ys += [pcbnew.ToMM(bb.GetTop()), pcbnew.ToMM(bb.GetBottom())]
    if not xs:
        return courtyard_bbox(fp)
    return min(xs), min(ys), max(xs), max(ys)


def seg_seg_dist(a, b):
    """Min distance between segments a=(x0,y0,x1,y1), b=(...); returns (d, mid x, mid y)."""
    def pt_seg(px, py, x0, y0, x1, y1):
        vx, vy = x1 - x0, y1 - y0
        L2 = vx * vx + vy * vy
        t = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, ((px - x0) * vx + (py - y0) * vy) / L2))
        qx, qy = x0 + t * vx, y0 + t * vy
        return math.hypot(px - qx, py - qy), qx, qy
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    # proper intersection
    def cross(ox, oy, px, py, qx, qy):
        return (px - ox) * (qy - oy) - (py - oy) * (qx - ox)
    d1 = cross(bx0, by0, bx1, by1, ax0, ay0)
    d2 = cross(bx0, by0, bx1, by1, ax1, ay1)
    d3 = cross(ax0, ay0, ax1, ay1, bx0, by0)
    d4 = cross(ax0, ay0, ax1, ay1, bx1, by1)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 * d2 < 0 and d3 * d4 < 0:
        return 0.0, (ax0 + ax1) / 2, (ay0 + ay1) / 2
    best = None
    for (px, py, sx0, sy0, sx1, sy1) in ((ax0, ay0, bx0, by0, bx1, by1), (ax1, ay1, bx0, by0, bx1, by1),
                                         (bx0, by0, ax0, ay0, ax1, ay1), (bx1, by1, ax0, ay0, ax1, ay1)):
        d, qx, qy = pt_seg(px, py, sx0, sy0, sx1, sy1)
        if best is None or d < best[0]:
            best = (d, (px + qx) / 2, (py + qy) / 2)
    return best


def shape_touches(shape, x0, y0, x1, y1, r):
    """True if a track segment (half-width r) overlaps a pad shape."""
    n = max(int(math.hypot(x1 - x0, y1 - y0) / 0.05), 1)
    for s_ in range(n + 1):
        t = s_ / n
        x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        if shape[0] == "rect":
            _, cx, cy, hw, hh = shape
            dx = max(abs(x - cx) - hw, 0)
            dy = max(abs(y - cy) - hh, 0)
            if math.hypot(dx, dy) < r - 1e-6:
                return True
        else:
            _, ax, ay, bx, by, rr = shape
            vx, vy = bx - ax, by - ay
            L2 = vx * vx + vy * vy
            tt = 0 if L2 < 1e-12 else max(0, min(1, ((x - ax) * vx + (y - ay) * vy) / L2))
            if math.hypot(x - ax - tt * vx, y - ay - tt * vy) < rr + r - 1e-6:
                return True
    return False


class PodRouter:
    def __init__(self, board, fps):
        import numpy as np
        self.np = np
        self.board, self.fps = board, fps
        self.R = Router(BOARD_W, BOARD_H, res=0.1, edge_clr=0.3)
        self.net_names = sorted(spec.NETS)
        self.nid = {n: i for i, n in enumerate(self.net_names)}
        self.terms = {}           # net -> list of terminals
        self.fine = {}            # net -> fine-pitch pad shapes (neck zones for power nets)
        R = self.R
        for fp in fps.values():
            for p in fp.Pads():
                ls = pad_layers(p)
                if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                    c = p.GetPosition()
                    r = pcbnew.ToMM(max(p.GetDrillSize().x, p.GetDrillSize().y)) / 2
                    x, y = pcbnew.ToMM(c.x), pcbnew.ToMM(c.y)
                    R.add_obstacle(("seg", x, y, x, y, r), [0, 1], -2, clr=0.35)
                    R.forbid_vias(("seg", x, y, x, y, r), extra=0.4)
                    continue
                if not ls:
                    continue
                shape = pad_shape(p)
                net = p.GetNetname()
                R.add_obstacle(shape, ls, self.nid[net] if net else -2)
                R.forbid_vias(shape, extra=0.05)
                if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                    c = p.GetPosition()
                    x, y = pcbnew.ToMM(c.x), pcbnew.ToMM(c.y)
                    R.forbid_vias(("seg", x, y, x, y, pcbnew.ToMM(p.GetDrillSize().x) / 2), extra=0.4)
                if net and net != "GND":
                    self.terms.setdefault(net, []).append((f"{fp.GetReference()}.{p.GetNumber()}", p, ls, shape))
                    if shape[0] == "rect" and min(shape[3], shape[4]) * 2 <= 0.61:
                        self.fine.setdefault(net, []).append(shape)
        # merge coincident pads (J1 A4/B9 etc.) into one terminal
        for net, lst in self.terms.items():
            merged = []
            for key, p, ls, shape in lst:
                c = p.GetPosition()
                pos = (round(pcbnew.ToMM(c.x), 3), round(pcbnew.ToMM(c.y), 3))
                for m in merged:
                    if m["pos"] == pos:
                        m["keys"].append(key)
                        m["pads"].append((p, ls, shape))
                        break
                else:
                    merged.append({"pos": pos, "keys": [key], "pads": [(p, ls, shape)]})
            self.terms[net] = merged
        # antenna band Z3: copper keep-out, both layers (spec sec 8)
        R.add_obstacle(("rect", BOARD_W / 2, Z3_Y / 2, BOARD_W / 2, Z3_Y / 2), [0, 1], -2, clr=0.0)
        # thermal vias (U1 EPAD, U4/U5 thermal pads) are fixed GND copper for the router
        self.thermal = thermal_vias(fps)
        for (x, y) in self.thermal + GND_RESERVE_VIAS:
            R.add_obstacle(("seg", x, y, x, y, VIA_D / 2), [0, 1], self.nid["GND"])
            R.forbid_vias(("seg", x, y, x, y, VIA_DRILL / 2), extra=0.3)
        for w, l, pts in GND_RESERVE_TRACKS:
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                R.add_obstacle(("seg", x0, y0, x1, y1, w / 2), [l], self.nid["GND"])
        self.base_lab = [[a.copy() for a in lk] for lk in R.lab]
        self.base_vf = R.via_forbid.copy()
        for grp, net, w, l, pts in HAND_EXTRA:
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                R.add_obstacle(("seg", x0, y0, x1, y1, w / 2), [l], self.nid[net])
        for net, x, y in HAND_VIAS:
            R.add_obstacle(("seg", x, y, x, y, VIA_D / 2), [0, 1], self.nid[net])
            R.forbid_vias(("seg", x, y, x, y, VIA_DRILL / 2), extra=0.3)
        # --- static region masks (spec sec 8) ------------------------------------
        X, Y = R.X, R.Y
        m = HW[1] + 0.1
        # bottom: Z2 and the Z1/Z2 overlap band, never south of the 10 mm box edge
        self.bot_ok = (Y > Z3_Y + m) & (Y < KEEPOUT[1] - 0.3 - m)
        self.via_ok = (Y > Z3_Y + 0.6) & (Y < KEEPOUT[1] - 0.3 - 0.6)
        # GND (late GND-island joins only): anywhere outside Z3, incl. under
        # part bodies, where the GND pour is anyway
        self.gnd_ok = (Y > Z3_Y + m) & (Y < BOARD_H - 0.3 - m) & (X > 0.3 + m) & (X < BOARD_W - 0.3 - m)
        self.via_ok_gnd = self.gnd_ok & (Y > Z3_Y + 0.6)
        # spec: no GNSS via at spec Y < 52.75 (y > 19.25). Allowed down to y < 21.4
        # (>= 17.85 mm from the module edge) at a heavy cost: needed for the
        # PPS / TP18 topology (see report). post_checks() lists every such via.
        self.via_ok_gnss = self.via_ok & (Y < GNSS_VIA_RELAXED_Y)
        self.via_pen_gnss = np.where(Y > GNSS_VIA_Y - 0.35, 60.0, 0.0)
        # J1's lower VBUS pair (A9/B4, y 22.45) lies in Z1 behind CC2: its only
        # way out is a via. Deviation: VBUS may use the bottom / vias in this
        # small corner of Z1 (x < 10.8, y < 23.7), 14 mm from the U2 box.
        self.vbus_z1 = (X < VBUS_EXC[0]) & (Y < VBUS_EXC[1])
        self.bot_ok_vbus = self.bot_ok | (self.vbus_z1 & (Y > Z3_Y + m))
        self.via_ok_vbus = self.via_ok | (self.vbus_z1 & (Y < VBUS_EXC[1] - 0.35) & (Y > Z3_Y + 0.6))
        under = np.zeros(X.shape, bool)
        for ref in NO_TOP_UNDER:
            fp = fps[ref]
            x0, y0, x1, y1 = body_rect(fp)
            box = (X > x0) & (X < x1) & (Y > y0) & (Y < y1)
            allow = np.zeros(X.shape, bool)
            for p in fp.Pads():
                if not p.IsOnLayer(pcbnew.F_Cu) or p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                    continue
                shp = pad_shape(p)
                if shp[0] != "rect":
                    continue
                _, cx, cy, hw, hh = shp
                allow |= (np.abs(X - cx) <= hw + 0.4) & (np.abs(Y - cy) <= hh + 0.4)
            under |= box & ~allow
        self.under = under
        self.top_ok_all = ~under
        # non-GNSS nets stay out of Z1 below the keep-out box edge (top = GND pour there)
        self.top_ok_nongnss = ~under & (Y < KEEPOUT[1] - 0.3)
        # soft cost around every pad so early routes leave pin escapes open
        pen = [np.zeros(X.shape), np.zeros(X.shape)]
        for fp in fps.values():
            for p in fp.Pads():
                if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                    continue
                shape = pad_shape(p)
                x0, y0, x1, y1 = R._bbox(shape)
                sl = R._win(x0, y0, x1, y1, 0.8)
                d = R._dist(shape, sl)
                for l in pad_layers(p):
                    pen[l][sl] += np.where(d < 0.6, PAD_PEN, 0.0)
        self.penalty = pen

    def region(self, net):
        if net == "GND":
            return self.gnd_ok, self.gnd_ok, self.via_ok_gnd
        # Z1 is hand-routed (U2_ESCAPES); the router stays north of the box edge
        if net in spec.GNSS_NETS:
            return self.top_ok_nongnss, self.bot_ok, self.via_ok_gnss
        if net == "VBUS":
            return self.top_ok_nongnss, self.bot_ok_vbus, self.via_ok_vbus
        return self.top_ok_nongnss, self.bot_ok, self.via_ok

    def term_cells(self, term, net):
        cells = []
        nid = self.nid[net]
        k = 1 if net in spec.POWER_NETS else 0
        top_ok, bot_ok, _ = self.region(net)
        okm = [top_ok, bot_ok]
        for p, ls, shape in term["pads"]:
            for (i, j) in self.R.cells_in(shape):
                for l in ls:
                    lab = self.R.lab[0][l][j, i]
                    if (lab == -1 or lab == nid) and okm[l][j, i]:
                        cells.append((i, j, l))
        return cells

    def track_cells(self, x0, y0, x1, y1, l):
        res = self.R.res
        n = int(math.hypot(x1 - x0, y1 - y0) / 0.05) + 1
        out = set()
        for s in range(n + 1):
            t = s / n
            out.add((int(round((x0 + (x1 - x0) * t) / res)), int(round((y0 + (y1 - y0) * t) / res)), l))
        return out

    def neck_mask(self, net):
        np = self.np
        if net not in spec.POWER_NETS or net not in self.fine:
            return None
        X, Y = self.R.X, self.R.Y
        m = np.zeros(X.shape, bool)
        for shp in self.fine[net]:
            _, cx, cy, hw, hh = shp
            m |= (np.abs(X - cx) <= hw + 0.9) & (np.abs(Y - cy) <= hh + 0.9)
        return m

    def u2_edge(self, net, keys):
        return any(k.startswith("U2.") for k in keys)

    def conn_region(self, net, keys):
        """GNSS nets: GNSS rule (top only in Z1, vias only >= 20 mm from U2).
        3V3: the U2 supply branches (U2 pins and their caps C9/C10) follow the
        GNSS rule; the rest of the rail is an ordinary power net."""
        if net == "3V3" and not any(k.split(".")[0] in ("U2", "C9", "C10") for k in keys):
            return self.top_ok_nongnss, self.bot_ok, self.via_ok
        return self.region(net)

    # -- label rebuild (for rip-up) ------------------------------------------------
    def snapshot_static(self):
        """Call once after pads, keep-outs and hand routes are in: rip-up rebuilds from here."""
        self.static_lab = [[a.copy() for a in lk] for lk in self.R.lab]
        self.static_vf = self.R.via_forbid.copy()

    def rebuild(self):
        R = self.R
        R.lab = [[a.copy() for a in lk] for lk in self.static_lab]
        R.via_forbid = self.static_vf.copy()
        for net, lst in self.net_tracks.items():
            nid = self.nid[net]
            for (x0, y0, x1, y1, w, l) in lst:
                R.add_obstacle(("seg", x0, y0, x1, y1, w / 2), [l], nid)
        for net, lst in self.net_vias.items():
            nid = self.nid[net]
            for (x, y) in lst:
                R.add_obstacle(("seg", x, y, x, y, VIA_D / 2), [0, 1], nid)
                R.forbid_vias(("seg", x, y, x, y, VIA_DRILL / 2), extra=0.3)

    def connect(self, net, src_cells, dst_cells, bot_cost, keys=(), soft=False):
        R = self.R
        k = 1 if net in spec.POWER_NETS else 0
        neck = self.neck_mask(net) if k == 1 else None
        region = self.conn_region(net, keys)
        pen = self.penalty
        saved = None
        if soft:
            # rip-up probe: routed copper of other nets is only expensive, not blocked
            np = self.np
            nid = self.nid[net]
            dyn = [((lab != -1) & (lab != nid)) & ~((st != -1) & (st != nid))
                   for lab, st in zip(R.lab[k], self.static_lab[k])]
            pen = [self.penalty[0] + np.where(dyn[0], 25.0, 0.0), self.penalty[1] + np.where(dyn[1], 25.0, 0.0)]
            saved = (R.lab, R.via_forbid)
            R.lab, R.via_forbid = self.static_lab, self.static_vf
        allc = list(src_cells) + list(dst_cells)
        xs = [c[0] for c in allc]
        ys = [c[1] for c in allc]
        path = None
        try:
            for marg in (40, 120, None):
                win = None if marg is None else (min(xs) - marg, min(ys) - marg, max(xs) + marg + 1, max(ys) + marg + 1)
                vpen = self.via_pen_gnss if (net in spec.GNSS_NETS and region[2] is self.via_ok_gnss) else None
                path = R.astar(self.nid[net], k, src_cells, dst_cells, region, neck=neck,
                               bot_cost=bot_cost, via_cost=10.0, window=win, penalty=pen, via_pen=vpen)
                if path:
                    break
        finally:
            if saved is not None:
                R.lab, R.via_forbid = saved
        if soft or not path:
            return path
        return self.emit(net, path, k, neck, region)

    def blockers(self, net, path):
        """Nets whose router-placed copper the probe path runs through."""
        np = self.np
        res = self.R.res
        k = 1 if net in spec.POWER_NETS else 0
        hw = HW[k]
        pts = {0: [], 1: []}
        for i, j, l in path:
            pts[l].append((i * res, j * res))
        arr = {l: np.array(v) for l, v in pts.items() if v}
        out = set()
        for other, lst in self.net_tracks.items():
            if other == net:
                continue
            for (x0, y0, x1, y1, w, l) in lst:
                if l not in arr:
                    continue
                P = arr[l]
                vx, vy = x1 - x0, y1 - y0
                L2 = vx * vx + vy * vy
                t = np.clip(((P[:, 0] - x0) * vx + (P[:, 1] - y0) * vy) / L2, 0, 1) if L2 > 1e-12 else 0
                d = np.hypot(P[:, 0] - (x0 + t * vx), P[:, 1] - (y0 + t * vy))
                if (d < w / 2 + hw + CLR + 0.03).any():
                    out.add(other)
                    break
        for other, lst in self.net_vias.items():
            if other == net or other in out:
                continue
            for (x, y) in lst:
                hit = False
                for P in arr.values():
                    if (np.hypot(P[:, 0] - x, P[:, 1] - y) < VIA_D / 2 + hw + CLR + 0.03).any():
                        hit = True
                        break
                if hit:
                    out.add(other)
                    break
        return out

    def emit(self, net, path, k, neck, region):
        R = self.R
        nid = self.nid[net]
        top_ok, bot_ok, _ = region
        free_k = R.free_masks(nid, k, neck)
        free_k = [free_k[0] & top_ok, free_k[1] & bot_ok]
        tl = self.net_tracks.setdefault(net, [])
        vl = self.net_vias.setdefault(net, [])
        runs = []
        cur = [path[0]]
        for c in path[1:]:
            if c[2] != cur[-1][2]:
                runs.append(cur)
                x, y = c[0] * R.res, c[1] * R.res
                vl.append((x, y))
                R.commit_via(x, y, nid)
                cur = [c]
            else:
                cur.append(c)
        runs.append(cur)
        cells = set(path)
        for run in runs:
            l = run[0][2]
            if neck is not None:
                pieces, piece = [], [run[0]]
                for c in run[1:]:
                    if bool(neck[c[1], c[0]]) != bool(neck[piece[-1][1], piece[-1][0]]):
                        piece.append(c)
                        pieces.append(piece)
                        piece = [c]
                    else:
                        piece.append(c)
                pieces.append(piece)
            else:
                pieces = [run]
            for pc in pieces:
                pts = [(c[0], c[1]) for c in pc]
                is_neck = neck is not None and any(neck[c[1], c[0]] for c in pc)
                w = (W_NECK if is_neck else W_PWR) if k == 1 else W_SIG
                fm = free_k[l]
                if is_neck:
                    f0 = R.free_masks(nid, 0)
                    fm = f0[l] & (top_ok if l == 0 else bot_ok)
                simp = R.simplify(pts, l, fm) if len(pts) > 2 else pts
                for (a, b) in zip(simp, simp[1:]):
                    x0, y0, x1, y1 = a[0] * R.res, a[1] * R.res, b[0] * R.res, b[1] * R.res
                    tl.append((x0, y0, x1, y1, w, l))
                    R.commit_track(x0, y0, x1, y1, w, l, nid)
                    cells |= self.track_cells(x0, y0, x1, y1, l)
        return cells

    @property
    def out_tracks(self):
        out = [(x0, y0, x1, y1, w, 0, net) for net, w, pts in U2_ESCAPES
               for (x0, y0), (x1, y1) in zip(pts, pts[1:])]
        for net in sorted(self.net_tracks):
            out += [(x0, y0, x1, y1, w, l, net) for (x0, y0, x1, y1, w, l) in self.net_tracks[net]]
        return out

    @property
    def out_vias(self):
        out = []
        for net in sorted(self.net_vias):
            out += [(x, y, net) for (x, y) in self.net_vias[net]]
        return out

    def connections(self):
        """MST edges (Euclid) over each net's terminals -> [(length, net, ia, ib)]."""
        out = []
        for net, terms in self.terms.items():
            n = len(terms)
            if n < 2:
                continue
            excl = set()
            if net == "3V3":
                # U2.2 (V_IO) and U2.17 (VCC) cannot be tied at the module on one
                # layer (they would trap RESET_N/EXTINT). Each has its own hand
                # route to its own bypass cap; the caps join the rail.
                idx = {k: i for i, t in enumerate(terms) for k in t["keys"]}
                excl = {idx["U2.17"], idx["U2.2"]}
            trunk = [i for i, t in enumerate(terms) if any(k in TRUNK.get(net, ()) for k in t["keys"])]
            first = min((i for i in (trunk or range(n)) if i not in excl), default=None)
            if first is None:
                first = min(i for i in range(n) if i not in excl)
            inside = {first} | excl
            while len(inside) < n:
                best = None
                # trunk terminals join the tree first (so the trunk never runs through a tap)
                pending_trunk = [j for j in trunk if j not in inside]
                for i in sorted(inside - excl):
                    for j in (pending_trunk or range(n)):
                        if j in inside:
                            continue
                        d = math.hypot(terms[i]["pos"][0] - terms[j]["pos"][0], terms[i]["pos"][1] - terms[j]["pos"][1])
                        if best is None or d < best[0]:
                            best = (d, i, j)
                inside.add(best[2])
                out.append((best[0], net, best[1], best[2]))
        return out

    def hand_components(self):
        """Per net: groups of terminal indices joined by hand-routed copper, + cells."""
        self.hand = {}
        extra = {}
        for grp, net, w, l, pts in HAND_EXTRA:
            extra.setdefault(grp, []).append((net, w, l, pts))
        for grp, pieces in extra.items():
            if grp in [n for n, _, _ in U2_ESCAPES]:
                continue          # merged into the escape lane below
            self._hand_group(pieces)
        for net, w, pts in U2_ESCAPES:
            pieces = [(net, w, 0, pts)] + (extra.get(net, []) if net != "3V3" else [])
            self._hand_group(pieces)

    def _hand_group(self, pieces):
        net = pieces[0][0]
        nid = self.nid[net]
        hand_cells = set()
        touched = set()
        for _, w, l, pts in pieces:
            segs = list(zip(pts, pts[1:]))
            for (x0, y0), (x1, y1) in segs:
                self.R.commit_track(x0, y0, x1, y1, w, l, nid)
                hand_cells |= self.track_cells(x0, y0, x1, y1, l)
            for i, t in enumerate(self.terms[net]):
                if any(l in ls and any(shape_touches(shape, x0, y0, x1, y1, w / 2) for (x0, y0), (x1, y1) in segs)
                       for p, ls, shape in t["pads"]):
                    touched.add(i)
        ends = {(round(x, 2), round(y, 2)) for _, _, _, pts in pieces for x, y in pts}
        for vnet, vx, vy in HAND_VIAS:
            if vnet == net and (round(vx, 2), round(vy, 2)) in ends:
                i, j = int(round(vx / self.R.res)), int(round(vy / self.R.res))
                hand_cells |= {(i, j, 0), (i, j, 1)}
        if not touched:
            raise SystemExit(f"hand route for {net} touches no pad")
        self.hand.setdefault(net, []).append((sorted(touched), hand_cells))

    def init_net(self, net):
        """Fresh components for one net (terminals + hand copper only)."""
        for i, t in enumerate(self.terms[net]):
            self.comp[(net, i)] = (net, i)
            self.cells[(net, i)] = set(self.term_cells(t, net))
        for touched, hand_cells in self.hand.get(net, []):
            base = self.comp[(net, touched[0])]
            for i in touched[1:]:
                self.merge(net, base, self.comp[(net, i)])
            self.cells[base] |= hand_cells

    def merge(self, net, a, b):
        if a == b:
            return
        for key, c in list(self.comp.items()):
            if c == b:
                self.comp[key] = a
        self.cells[a] |= self.cells.pop(b)

    # -- negotiated congestion (PathFinder-style) ------------------------------------
    # Other nets' copper is not a hard wall but a cost that rises every round
    # (present-congestion factor), plus a history cost on cells that stayed
    # contested. Static obstacles (pads, holes, keep-outs, hand routes, thermal
    # vias) remain hard. Converges to a conflict-free routing; any net still in
    # conflict at the end is left unrouted (DRC then reports it; no shorts).
    def occ_add(self, net, shape, layers, sign):
        np = self.np
        R = self.R
        o = self.occ_net.get(net)
        if o is None:
            o = [[np.zeros(R.X.shape, np.int16) for _ in range(2)] for _ in range(2)]
            self.occ_net[net] = o
        x0, y0, x1, y1 = R._bbox(shape)
        for k in range(2):
            infl = CLR + HW[k] + ROUTER_MARGIN
            sl = R._win(x0, y0, x1, y1, infl)
            m = (R._dist(shape, sl) < infl).astype(np.int16) * sign
            for l in layers:
                self.occ_tot[k][l][sl] += m
                o[k][l][sl] += m

    def occ_other(self, net, k, l):
        o = self.occ_net.get(net)
        if o is None:
            return self.occ_tot[k][l]
        return self.occ_tot[k][l] - o[k][l]

    def rip_neg(self, net):
        for (x0, y0, x1, y1, w, l) in self.net_tracks.get(net, []):
            self.occ_add(net, ("seg", x0, y0, x1, y1, w / 2), [l], -1)
        for (x, y) in self.net_vias.get(net, []):
            self.occ_add(net, ("seg", x, y, x, y, VIA_D / 2), [0, 1], -1)
        self.net_tracks[net] = []
        self.net_vias[net] = []
        self.init_net(net)

    def connect_neg(self, net, src, dst, keys, pres, hist, bot_cost):
        np = self.np
        R = self.R
        nid = self.nid[net]
        trunk = net in spec.POWER_NETS and all(any(k_ in TRUNK.get(net, ()) for k_ in grp) for grp in keys)
        k = 1 if trunk else 0
        neck = self.neck_mask(net) if k == 1 else None
        region = self.conn_region(net, keys[0] + keys[1])
        top_ok, bot_ok, via_ok = region
        st = self.static_lab
        okm, cst, fmask = [], [], []
        for l in range(2):
            base = (st[k][l] == -1) | (st[k][l] == nid)
            oth = self.occ_other(net, k, l)
            if neck is not None:
                base0 = (st[0][l] == -1) | (st[0][l] == nid)
                base = np.where(neck, base0, base)
                oth = np.where(neck, self.occ_other(net, 0, l), oth)
            base = base & (top_ok if l == 0 else bot_ok)
            okm.append(base)
            cst.append(self.penalty[l] + hist[l] + pres * oth)
            fmask.append(base & (oth == 0))
        vb = [(st[1][l] == -1) | (st[1][l] == nid) for l in range(2)]
        vok = vb[0] & vb[1] & via_ok & ~self.static_vf & top_ok & bot_ok
        vc = pres * (self.occ_other(net, 1, 0) + self.occ_other(net, 1, 1)) + hist[0] + hist[1]
        if net in spec.GNSS_NETS and via_ok is self.via_ok_gnss:
            vc = vc + self.via_pen_gnss
        allc = list(src) + list(dst)
        xs = [c[0] for c in allc]
        ys = [c[1] for c in allc]
        path = None
        costl = [cst[0].ravel().tolist(), cst[1].ravel().tolist()]
        vcl = vc.ravel().tolist()
        for marg in (40, 120, None):
            if marg is None:
                ok = [okm[0].ravel().tolist(), okm[1].ravel().tolist()]
                vk = vok.ravel().tolist()
            else:
                w = np.zeros(R.X.shape, bool)
                w[max(min(ys) - marg, 0):max(ys) + marg + 1, max(min(xs) - marg, 0):max(xs) + marg + 1] = True
                ok = [(okm[0] & w).ravel().tolist(), (okm[1] & w).ravel().tolist()]
                vk = (vok & w).ravel().tolist()
            path = astar2(R.nx, R.ny, ok, costl, vk, vcl, src, dst, bot_cost=bot_cost, via_cost=10.0)
            if path:
                break
        if not path:
            return None
        return self.emit_neg(net, path, k, neck, fmask, W_TAP if net in spec.POWER_NETS else W_SIG)

    def emit_neg(self, net, path, k, neck, fmask, wsig=0.2):
        R = self.R
        tl = self.net_tracks.setdefault(net, [])
        vl = self.net_vias.setdefault(net, [])
        runs = []
        cur = [path[0]]
        for c in path[1:]:
            if c[2] != cur[-1][2]:
                runs.append(cur)
                x, y = c[0] * R.res, c[1] * R.res
                vl.append((x, y))
                self.occ_add(net, ("seg", x, y, x, y, VIA_D / 2), [0, 1], 1)
                cur = [c]
            else:
                cur.append(c)
        runs.append(cur)
        cells = set(path)
        for run in runs:
            l = run[0][2]
            if neck is not None:
                pieces, piece = [], [run[0]]
                for c in run[1:]:
                    if bool(neck[c[1], c[0]]) != bool(neck[piece[-1][1], piece[-1][0]]):
                        piece.append(c)
                        pieces.append(piece)
                        piece = [c]
                    else:
                        piece.append(c)
                pieces.append(piece)
            else:
                pieces = [run]
            for pc in pieces:
                pts = [(c[0], c[1]) for c in pc]
                is_neck = neck is not None and any(neck[c[1], c[0]] for c in pc)
                w = (W_NECK if is_neck else W_PWR) if k == 1 else wsig
                simp = R.simplify(pts, l, fmask[l]) if len(pts) > 2 else pts
                for (a, b) in zip(simp, simp[1:]):
                    x0, y0, x1, y1 = a[0] * R.res, a[1] * R.res, b[0] * R.res, b[1] * R.res
                    tl.append((x0, y0, x1, y1, w, l))
                    self.occ_add(net, ("seg", x0, y0, x1, y1, w / 2), [l], 1)
                    cells |= self.track_cells(x0, y0, x1, y1, l)
        return cells

    def geo_conflicts(self):
        """Exact clearance check between routed copper of different nets.
        Returns {net: set((i, j, layer))} of cells near each violation."""
        items = []
        for net, lst in self.net_tracks.items():
            for (x0, y0, x1, y1, w, l) in lst:
                items.append((net, l, x0, y0, x1, y1, w / 2))
        for net, lst in self.net_vias.items():
            for (x, y) in lst:
                for l in (0, 1):
                    items.append((net, l, x, y, x, y, VIA_D / 2))
        buckets = {}
        for idx, it in enumerate(items):
            _, l, x0, y0, x1, y1, r = it
            m = r + CLR
            for bx in range(int((min(x0, x1) - m) // 1), int((max(x0, x1) + m) // 1) + 1):
                for by in range(int((min(y0, y1) - m) // 1), int((max(y0, y1) + m) // 1) + 1):
                    buckets.setdefault((l, bx, by), []).append(idx)
        out = {}
        seen = set()
        self.last_pairs = []
        self.last_items = []
        res = self.R.res
        for key, lst in buckets.items():
            for a in range(len(lst)):
                ia = items[lst[a]]
                for b in range(a + 1, len(lst)):
                    ib = items[lst[b]]
                    if ia[0] == ib[0]:
                        continue
                    pair = (min(lst[a], lst[b]), max(lst[a], lst[b]))
                    if pair in seen:
                        continue
                    seen.add(pair)
                    d, px, py = seg_seg_dist(ia[2:6], ib[2:6])
                    if d < ia[6] + ib[6] + CLR - 0.005:
                        self.last_pairs.append((ia[0], ib[0], round(px, 1), round(py, 1), ia[1]))
                        self.last_items.append((ia, ib))
                        c = (int(round(px / res)), int(round(py / res)), ia[1])
                        out.setdefault(ia[0], set()).add(c)
                        out.setdefault(ib[0], set()).add(c)
        return out

    def conflict_cells(self, net):
        out = set()
        for (x0, y0, x1, y1, w, l) in self.net_tracks.get(net, []):
            k = 1 if w > 0.3 else 0
            oth = self.occ_other(net, k, l)
            for (i, j, _) in self.track_cells(x0, y0, x1, y1, l):
                if oth[j, i] > 0:
                    out.add((i, j, l))
        for (x, y) in self.net_vias.get(net, []):
            i, j = int(round(x / self.R.res)), int(round(y / self.R.res))
            for l in (0, 1):
                if self.occ_other(net, 1, l)[j, i] > 0:
                    out.add((i, j, l))
        return out

    def negotiate(self, order, rounds=60, bot_cost=None):
        np = self.np
        bot_cost = BOT_COST if bot_cost is None else bot_cost
        R = self.R
        self.comp, self.cells = {}, {}
        self.net_tracks, self.net_vias = {}, {}
        self.hand_components()
        self.snapshot_static()
        R.lab = self.static_lab
        R.via_forbid = self.static_vf
        self.occ_tot = [[np.zeros(R.X.shape, np.int16) for _ in range(2)] for _ in range(2)]
        self.occ_net = {}
        for net in self.terms:
            self.init_net(net)
        by_net, nets = {}, []
        for c in order:
            if c[1] not in by_net:
                nets.append(c[1])
            by_net.setdefault(c[1], []).append(c)
        hist = [np.zeros(R.X.shape, np.float32), np.zeros(R.X.shape, np.float32)]
        pres = 0.5
        todo = list(nets)
        hard = set()
        conf = {}
        for rnd in range(rounds):
            for net in todo:
                self.rip_neg(net)
                okn = True
                for conn in by_net[net]:
                    _, _, ia, ib = conn
                    ca, cb = self.comp[(net, ia)], self.comp[(net, ib)]
                    if ca == cb:
                        continue
                    keys = (self.terms[net][ia]["keys"], self.terms[net][ib]["keys"])
                    got = self.connect_neg(net, self.cells[ca], self.cells[cb], keys, pres, hist, bot_cost)
                    if got is None:
                        okn = False
                        continue
                    self.cells[ca] |= got
                    self.merge(net, ca, cb)
                if okn:
                    hard.discard(net)
                else:
                    hard.add(net)
            conf = self.geo_conflicts()
            print(f"  negotiation round {rnd + 1}: {len(conf)} nets in conflict, {len(hard)} unroutable"
                  f"{' ' + str(sorted(conf))[:160] if conf else ''}", flush=True)
            if os.environ.get("NEGDBG"):
                import collections
                byp = collections.defaultdict(set)
                for a, b, x, y, l in self.last_pairs:
                    byp[(min(a, b), max(a, b))].add((x, y, l))
                for (a, b), v in sorted(byp.items()):
                    print("      ", a, "x", b, len(v), sorted(v)[:2])
            if False:
                for net in sorted(conf):
                    others = {}
                    for (i, j, l) in conf[net]:
                        for n2, o in self.occ_net.items():
                            if n2 != net and (o[0][l][j, i] > 0 or o[1][l][j, i] > 0):
                                others.setdefault(n2, []).append((round(i * 0.1, 1), round(j * 0.1, 1), l))
                    print("     ", net, {k: (len(v), v[0]) for k, v in others.items()})
            if not conf and not hard:
                break
            for cc in conf.values():
                for (i, j, l) in cc:
                    hist[l][j, i] += NEG_HIST
            pres *= NEG_GROWTH
            todo = [n for n in nets if n in conf or n in hard]
        self.final_conflicts = {n: sorted(c) for n, c in conf.items()}
        if not os.environ.get("NEG_KEEP"):
            for net in conf:
                self.rip_neg(net)       # never leave a short: unrouted instead
        # restore hard label maps (static + final copper) for the GND stage
        self.static_lab = [[a.copy() for a in lk] for lk in self.static_lab]
        self.rebuild()
        failed = []
        for c in order:
            _, net, ia, ib = c
            if self.comp[(net, ia)] != self.comp[(net, ib)]:
                failed.append(c)
        return failed

    def route_connections(self, order, bot_cost=None, max_rips=20):
        bot_cost = BOT_COST if bot_cost is None else bot_cost
        from collections import deque
        self.comp, self.cells = {}, {}
        self.net_tracks, self.net_vias = {}, {}
        self.hand_components()
        self.snapshot_static()
        for net in self.terms:
            self.init_net(net)
        by_net = {}
        for c in order:
            by_net.setdefault(c[1], []).append(c)
        queue = deque(order)
        rips = {}
        tries = {}
        budget = 15 * len(order)
        while queue and budget > 0:
            budget -= 1
            conn = queue.popleft()
            _, net, ia, ib = conn
            ca, cb = self.comp[(net, ia)], self.comp[(net, ib)]
            if ca == cb:
                continue
            src, dst = self.cells[ca], self.cells[cb]
            keys = self.terms[net][ia]["keys"] + self.terms[net][ib]["keys"]
            got = self.connect(net, src, dst, bot_cost, keys) if src and dst else None
            if got is None and src and dst:
                probe = self.connect(net, src, dst, bot_cost, keys, soft=True)
                victims = self.blockers(net, probe) if probe else set()
                victims = {v for v in victims if rips.get(v, 0) < max_rips}
                if victims:
                    for v in sorted(victims):
                        rips[v] = rips.get(v, 0) + 1
                        self.net_tracks.pop(v, None)
                        self.net_vias.pop(v, None)
                        self.init_net(v)
                    self.rebuild()
                    ca, cb = self.comp[(net, ia)], self.comp[(net, ib)]
                    src, dst = self.cells[ca], self.cells[cb]
                    got = self.connect(net, src, dst, bot_cost, keys)
                    for v in sorted(victims):
                        queue.extend(by_net[v])
            if got is None:
                tries[conn] = tries.get(conn, 0) + 1
                if tries[conn] < 3:
                    queue.append(conn)
                continue
            self.cells[ca] |= got
            self.merge(net, ca, cb)
        self.rip_counts = rips
        failed = []
        for c in order:
            _, net, ia, ib = c
            if self.comp[(net, ia)] != self.comp[(net, ib)]:
                failed.append(c)
        return failed


# ---------------------------------------------------------------------------
# 5. GND: thermal vias, GND via drops, stitching, pours, keep-outs
# ---------------------------------------------------------------------------
def thermal_vias(fps):
    """Thermal vias placed BEFORE routing (the router treats them as GND copper).
      U1 EPAD: 12 vias in the gaps of the 3x3 EPAD grid, per Espressif Fig. 11-1.
      U4 EP:   5 vias (centre + 4 at +-0.55), per TI RGT0016C example layout (>= 4, spec).
      U5 PAD:  2 in the pad + 2 just beyond its ends (joined by the top pour), >= 4 (spec).
    Returns [(x, y)]."""
    out = []
    ux, uy = pcbnew.ToMM(fps["U1"].GetPosition().x), pcbnew.ToMM(fps["U1"].GetPosition().y)
    for dx, dy in [(-0.825, -1.65), (0.825, -1.65), (-0.825, 0), (0.825, 0), (-0.825, 1.65), (0.825, 1.65),
                   (-1.65, -0.825), (0, -0.825), (1.65, -0.825), (-1.65, 0.825), (0, 0.825), (1.65, 0.825)]:
        out.append((ux + dx, uy + dy))
    ep = [p for p in fps["U4"].Pads() if p.GetNumber() == "17"][0].GetPosition()
    ex, ey = pcbnew.ToMM(ep.x), pcbnew.ToMM(ep.y)
    for dx, dy in [(0, 0), (-0.55, -0.55), (0.55, -0.55), (-0.55, 0.55), (0.55, 0.55)]:
        out.append((ex + dx, ey + dy))
    tp = [p for p in fps["U5"].Pads() if p.GetNumber() == "6"][0].GetPosition()
    tx, ty = pcbnew.ToMM(tp.x), pcbnew.ToMM(tp.y)
    for dy in (-0.45, 0.45, -1.45, 1.45):
        out.append((tx, ty + dy))
    return out


def gnd_via_ok(pr, x, y, extra_forbid=None):
    """A GND via fits at (x, y): both layers free for GND at via size, no hole conflict, not in Z3."""
    R = pr.R
    i, j = int(round(x / R.res)), int(round(y / R.res))
    if not (0 <= i < R.nx and 0 <= j < R.ny):
        return False
    if y < Z3_Y + 0.6:
        return False
    g = pr.nid["GND"]
    for l in (0, 1):
        lab = R.lab[1][l][j, i]
        if lab not in (-1, g):
            return False
    if R.via_forbid[j, i]:
        return False
    return True


def place_gnd_vias(pr, fps):
    """GND via drops next to GND pads, then stitching (spec sec 8)."""
    import numpy as np
    R = pr.R
    g = pr.nid["GND"]
    drops, stubs, stitch = [], [], []

    def commit(x, y, lst):
        lst.append((x, y))
        R.commit_via(x, y, g)

    # -- 1. drop next to each GND pad of the small parts (top side) --------------
    free0 = R.free_masks(g, 0)[0]
    skip = {"U1", "U2", "J1", "MH1", "MH2", "MH3", "MH4"}
    for ref in sorted(fps):
        if ref in skip or ref.startswith("TP"):
            continue
        fp = fps[ref]
        for p in fp.Pads():
            if p.GetNetname() != "GND" or not p.IsOnLayer(pcbnew.F_Cu):
                continue
            if p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
                continue
            if (ref, p.GetNumber()) in (("U4", "17"), ("U5", "6")):
                continue
            shp = pad_shape(p)
            if shp[0] != "rect":
                continue
            _, cx, cy, hw, hh = shp
            best = None
            for r in (0.75, 0.95, 1.2, 1.5, 1.9):
                for a in range(0, 360, 15):
                    vx = cx + (hw + r) * math.cos(math.radians(a)) if abs(math.cos(math.radians(a))) > 0.7 else cx + hw * math.cos(math.radians(a)) * 1.0
                    vy = cy + (hh + r) * math.sin(math.radians(a)) if abs(math.sin(math.radians(a))) > 0.7 else cy + hh * math.sin(math.radians(a)) * 1.0
                    vx, vy = round(vx / R.res) * R.res, round(vy / R.res) * R.res
                    if not gnd_via_ok(pr, vx, vy):
                        continue
                    a_ = (int(round(cx / R.res)), int(round(cy / R.res)))
                    b_ = (int(round(vx / R.res)), int(round(vy / R.res)))
                    if not R.los_ok(a_, b_, 0, free0):
                        continue
                    best = (vx, vy)
                    break
                if best:
                    break
            if best:
                vx, vy = best
                stubs.append((cx, cy, vx, vy))
                R.commit_track(cx, cy, vx, vy, 0.3, 0, g)
                commit(vx, vy, drops)
                free0 = R.free_masks(g, 0)[0]

    # -- 2. stitching ------------------------------------------------------------
    def try_line(pts):
        for x, y in pts:
            ok = gnd_via_ok(pr, x, y)
            if ok and all(math.hypot(x - a, y - b) >= 0.9 for a, b in stitch + drops):
                commit(x, y, stitch)

    # perimeter, every <= 5 mm (target 2.5 mm), outside Z3
    step = 2.5
    ys = [Z3_Y + 1.0 + k * step for k in range(int((BOARD_H - Z3_Y - 2.0) / step) + 1)]
    xs = [1.0 + k * step for k in range(int((BOARD_W - 2.0) / step) + 1)]
    try_line([(1.0, y) for y in ys] + [(BOARD_W - 1.0, y) for y in ys]
             + [(x, BOARD_H - 1.0) for x in xs])
    # dense row along spec Y = 66.5 (y = 5.5) both sides of U1 (Espressif)
    try_line([(0.8 + 0.8 * k, 5.6) for k in range(21)] + [(33.4 + 0.8 * k, 5.6) for k in range(21)])
    # ring around U2 just outside the 10 mm keep-out box
    k0x, k0y, k1x, k1y = KEEPOUT
    ring = []
    n = 16
    for k in range(n + 1):
        t = k / n
        ring += [(k0x - 0.6 + (k1x - k0x + 1.2) * t, k1y + 0.6), (k0x - 0.6, k0y + (k1y - k0y) * t),
                 (k1x + 0.6, k0y + (k1y - k0y) * t)]
    try_line(ring)
    # via field under U2 (u-blox IM: "GND plane below the module is filled with GND vias")
    ux, uy = U2_POS
    try_line([(ux + dx, uy + dy) for dx in (-3.75, -1.25, 1.25, 3.75) for dy in (-3.75, -1.25, 1.25, 3.75)])
    # a sparse field over the rest of Z1 (top and bottom GND tied together)
    try_line([(x, y) for x in np.arange(3.0, 48.0, 4.0) for y in np.arange(32.0, 70.0, 4.0)])
    # and over Z2 wherever it fits
    try_line([(x, y) for x in np.arange(2.0, 49.0, 3.0) for y in np.arange(7.0, 22.0, 3.0)])
    return drops, stubs, stitch


def add_zones(board, nets):
    gnd = nets["GND"]
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        z = pcbnew.ZONE(board)
        z.SetLayer(layer)
        z.SetNet(gnd)
        z.SetLocalClearance(MM(0.25))
        z.SetMinThickness(MM(0.2))
        z.SetThermalReliefGap(MM(0.3))
        z.SetThermalReliefSpokeWidth(MM(0.35))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
        z.SetZoneName(f"GND_{'F' if layer == pcbnew.F_Cu else 'B'}")
        o = z.Outline()
        o.NewOutline()
        for x, y in [(0.3, 0.3), (BOARD_W - 0.3, 0.3), (BOARD_W - 0.3, BOARD_H - 0.3), (0.3, BOARD_H - 0.3)]:
            o.Append(pcbnew.VECTOR2I(MM(x), MM(y)))
        board.Add(z)
    # Z3: ESP32 antenna band, copper keep-out on both layers, full width (spec sec 8)
    ko = pcbnew.ZONE(board)
    ko.SetIsRuleArea(True)
    ls = pcbnew.LSET()
    ls.AddLayer(pcbnew.F_Cu)
    ls.AddLayer(pcbnew.B_Cu)
    ko.SetLayerSet(ls)
    ko.SetDoNotAllowZoneFills(True)
    ko.SetDoNotAllowTracks(True)
    ko.SetDoNotAllowVias(True)
    ko.SetDoNotAllowPads(True)
    ko.SetDoNotAllowFootprints(False)   # U1's own antenna end lies here by design; checked in place_check
    ko.SetZoneName("Z3_ESP32_ANTENNA_KEEPOUT")
    o = ko.Outline()
    o.NewOutline()
    for x, y in [(0, 0), (BOARD_W, 0), (BOARD_W, Z3_Y), (0, Z3_Y)]:
        o.Append(pcbnew.VECTOR2I(MM(x), MM(y)))
    board.Add(ko)
    # Z1 bottom: nothing but GND (spec sec 8): tracks/vias are allowed only for
    # GND, which KiCad rule areas cannot express per net, so this is enforced by
    # the router region masks and checked in post_checks().


def fab_drawings(board):
    """Human-review graphics: the zones of spec sec 8 on User.Drawings / Cmts.User."""
    add_rect_graphic(board, *KEEPOUT, pcbnew.Dwgs_User, 0.15)
    add_text(board, "U2 10mm COMPONENT KEEP-OUT (u-blox IM 4.4)", 25.0, KEEPOUT[3] + 0.9, pcbnew.Dwgs_User, 0.8)
    add_rect_graphic(board, 0.0, Z1_Y, BOARD_W, BOARD_H, pcbnew.Cmts_User, 0.1)
    add_text(board, "Z1 GNSS ZONE: bottom = solid GND", 25.0, BOARD_H - 2.2, pcbnew.Cmts_User, 0.8)
    add_rect_graphic(board, 0.0, 0.0, BOARD_W, Z3_Y, pcbnew.Cmts_User, 0.1)
    add_text(board, "Z3 ESP32 ANTENNA: no copper, both layers", 25.0, 2.5, pcbnew.Cmts_User, 0.7)


def design_rules(board):
    """Spec sec 8 rules: 0.2 mm clearance / 0.2 mm track; JLCPCB 2-layer limits."""
    ds = board.GetDesignSettings()
    ds.m_MinClearance = MM(0.2)
    ds.m_TrackMinWidth = MM(0.2)
    ds.m_ViasMinSize = MM(0.5)
    ds.m_ViasMinAnnularWidth = MM(0.1)
    ds.m_ViasMinDrill = MM(0.3)
    ds.m_MinThroughDrill = MM(0.3)
    ds.m_HoleClearance = MM(0.25)
    ds.m_HoleToHoleMin = MM(0.25)
    ds.m_CopperEdgeClearance = MM(0.3)
    ds.m_SilkClearance = MM(0.0)
    ds.m_MinSilkTextHeight = MM(0.6)
    ds.m_MinSilkTextThickness = MM(0.1)
    # drill/place (aux) origin = board bottom-left, so gerbers, drill and the
    # CPL all use the spec's coordinate frame (origin bottom-left, Y up).
    ds.SetAuxOrigin(pcbnew.VECTOR2I(0, MM(72.0)))
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetClearance(MM(0.2))
    nc.SetTrackWidth(MM(0.2))
    nc.SetViaDiameter(MM(VIA_D))
    nc.SetViaDrill(MM(VIA_DRILL))


# Parts whose reference stays on the silkscreen (the rest go to F.Fab only:
# 0402 fields are too dense for readable silk; the BOM/CPL carry the refs).
SILK_REFS = {"U1", "U2", "U3", "U5", "J1", "J3", "SW2", "SW3"}


def silkscreen(board, fps):
    for ref, fp in fps.items():
        t = fp.Reference()
        t.SetTextSize(pcbnew.VECTOR2I(MM(0.8), MM(0.8)))
        t.SetTextThickness(MM(0.12))
        if ref not in SILK_REFS:
            t.SetLayer(pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab)
    for fp in fps.values():
        fp.Value().SetVisible(False)
    # J1 overhangs the board edge by design: drop its silk that crosses or
    # touches the edge (it would be clipped by the fab anyway)
    for g in list(fps["J1"].GraphicalItems()):
        if g.GetLayer() == pcbnew.F_SilkS and pcbnew.ToMM(g.GetBoundingBox().GetLeft()) < 2.0:
            fps["J1"].Remove(g)
    # owner-facing marks (spec sec 4 notes / sec 8)
    # J2 battery polarity: bottom silk beside the THT pads (the top side is
    # full around the connector), mirrored so it reads from the bottom
    for p in fps["J2"].Pads():
        c = p.GetPosition()
        mark = "+" if p.GetNumber() == "1" else "-"
        add_text(board, mark, pcbnew.ToMM(c.x) + 1.9, pcbnew.ToMM(c.y), pcbnew.B_SilkS, 1.0, mirror=True)
    sw3 = {p.GetNumber(): p.GetPosition() for p in fps["SW3"].Pads()}
    add_text(board, "ON", pcbnew.ToMM(sw3["1"].x), pcbnew.ToMM(sw3["1"].y) - 2.9, pcbnew.F_SilkS, 0.8)
    add_text(board, "OFF", pcbnew.ToMM(sw3["3"].x), pcbnew.ToMM(sw3["3"].y) - 2.9, pcbnew.F_SilkS, 0.8)
    # IMU axes (spec sec 8): arrows south-east of U3, clear of pads
    ux, uy = U3_POS
    add_text(board, "X>", ux + 1.4, uy + 2.5, pcbnew.F_SilkS, 0.7)
    add_text(board, "Y^", ux + 1.4, uy + 3.35, pcbnew.F_SilkS, 0.7)
    add_text(board, "TRACE GNSS POD rev A", 25.0, 67.0, pcbnew.B_SilkS, 1.2, mirror=True)
    add_text(board, "2026-09", 25.0, 69.0, pcbnew.B_SilkS, 0.8, mirror=True)


def post_checks(board, pr):
    """Spec sec 8 checks on the finished copper; prints a summary for the report."""
    import heapq as hq
    print("--- post-route checks (spec sec 8) ---")
    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    # bottom-layer runs per net (connected groups of B.Cu segments)
    runs = []
    bt = [t for t in tracks if t.GetLayer() == pcbnew.B_Cu]
    seen = set()
    for i in range(len(bt)):
        if i in seen:
            continue
        grp, stack = [], [i]
        seen.add(i)
        while stack:
            k = stack.pop()
            grp.append(bt[k])
            a = bt[k]
            for j, u in enumerate(bt):
                if j in seen or u.GetNetname() != a.GetNetname():
                    continue
                ends_a = [a.GetStart(), a.GetEnd()]
                ends_u = [u.GetStart(), u.GetEnd()]
                if any((e - f).EuclideanNorm() < MM(0.05) for e in ends_a for f in ends_u):
                    seen.add(j)
                    stack.append(j)
        L = sum(pcbnew.ToMM(g.GetLength()) for g in grp)
        runs.append((L, grp[0].GetNetname()))
    long_runs = sorted([r for r in runs if r[0] > 10.0], reverse=True)
    pr.bottom_runs = runs
    pr.long_runs = long_runs
    print("bottom jumper runs: %d; longest %.1f mm; > 10 mm: %s"
          % (len(runs), max(runs)[0] if runs else 0.0, [(n, round(L, 1)) for L, n in long_runs]))
    # nothing on the bottom in Z1 except GND
    z1_bottom = sorted({t.GetNetname() for t in bt
                        if max(pcbnew.ToMM(t.GetStart().y), pcbnew.ToMM(t.GetEnd().y)) + pcbnew.ToMM(t.GetWidth()) / 2 > Z1_Y})
    z1_vias = sorted({(v.GetNetname(), round(pcbnew.ToMM(v.GetPosition().x), 2), round(pcbnew.ToMM(v.GetPosition().y), 2))
                      for v in vias if v.GetNetname() != "GND" and pcbnew.ToMM(v.GetPosition().y) + VIA_D / 2 > Z1_Y})
    print("non-GND bottom tracks reaching Z1: %s; non-GND vias in Z1: %s" % (z1_bottom, z1_vias))
    # GNSS vias closer than 20 mm to the module edge
    ux, uy = U2_POS
    close = []
    for v in vias:
        n = v.GetNetname()
        if n in spec.GNSS_NETS and pcbnew.ToMM(v.GetPosition().y) > GNSS_VIA_Y:
            x, y = pcbnew.ToMM(v.GetPosition().x), pcbnew.ToMM(v.GetPosition().y)
            dx = max(abs(x - ux) - 7.75, 0)
            dy = max(abs(y - uy) - 7.75, 0)
            close.append((n, round(x, 2), round(y, 2), round(math.hypot(dx, dy), 2)))
    pr.gnss_close = close
    print("GNSS-net vias < 20 mm from the U2 edge (spec Y < 52.75): %s" % close)
    # 3V3 series resistance U5.5 -> U2.17 (1 oz copper, 0.49 mOhm/sq)
    RS = 0.49e-3
    nodes = {}

    def nid_(pt):
        key = (round(pt[0], 2), round(pt[1], 2), pt[2])
        if key not in nodes:
            nodes[key] = len(nodes)
        return nodes[key]
    edges = {}

    def add_e(a, b, r):
        edges.setdefault(a, []).append((b, r))
        edges.setdefault(b, []).append((a, r))
    samples = []
    segs3 = []      # (x0, y0, x1, y1, w, l, [node ids])
    for t in tracks:
        if t.GetNetname() != "3V3":
            continue
        x0, y0 = pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y)
        x1, y1 = pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y)
        w = pcbnew.ToMM(t.GetWidth())
        l = 0 if t.GetLayer() == pcbnew.F_Cu else 1
        n = max(int(math.hypot(x1 - x0, y1 - y0) / 0.2), 1)
        prev = None
        ids = []
        for k in range(n + 1):
            pt = (x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, l)
            idn = nid_(pt)
            ids.append(idn)
            samples.append((pt, w, idn, len(segs3)))
            if prev is not None:
                add_e(prev, idn, RS * (math.hypot(x1 - x0, y1 - y0) / n) / w)
            prev = idn
        segs3.append((x0, y0, x1, y1, w, l, ids))
    # T-junctions: a track end lying on another track of the same layer
    for (ax0, ay0, ax1, ay1, aw, al, aids) in segs3:
        for (ex, ey), eid in (((ax0, ay0), aids[0]), ((ax1, ay1), aids[-1])):
            for (bx0, by0, bx1, by1, bw, bl, bids) in segs3:
                if bl != al or bids is aids:
                    continue
                dx, dy = bx1 - bx0, by1 - by0
                L2 = dx * dx + dy * dy
                tt = 0.0 if L2 == 0 else max(0.0, min(1.0, ((ex - bx0) * dx + (ey - by0) * dy) / L2))
                px, py = bx0 + tt * dx, by0 + tt * dy
                if math.hypot(ex - px, ey - py) <= (aw + bw) / 2 + 0.01:
                    add_e(eid, bids[int(round(tt * (len(bids) - 1)))], 0.0)
    for i, (pt, w, a, ta) in enumerate(samples):
        for q, w2, b, tb in samples[i + 1:]:
            if ta != tb and pt[2] == q[2] and a != b and abs(pt[0] - q[0]) < 0.3 and math.hypot(pt[0] - q[0], pt[1] - q[1]) < (w + w2) / 2:
                add_e(a, b, 0.0)
    for v in vias:
        if v.GetNetname() != "3V3":
            continue
        x, y = pcbnew.ToMM(v.GetPosition().x), pcbnew.ToMM(v.GetPosition().y)
        on = [(s_[2], s_[0][2]) for s_ in samples if math.hypot(s_[0][0] - x, s_[0][1] - y) < 0.3]
        for a, la in on:
            for b, lb in on:
                if a < b:
                    add_e(a, b, 0.002 if la != lb else 0.0)

    def pad_nodes(ref, num):
        p = [p for p in pr.fps[ref].Pads() if p.GetNumber() == num][0]
        shp = pad_shape(p)
        lay = pad_layers(p)
        out = []
        for s_ in samples:
            if s_[0][2] in lay and shape_touches(shp, s_[0][0], s_[0][1], s_[0][0], s_[0][1], 0.01):
                out.append(s_[2])
        return out
    src, dst = pad_nodes("U5", "5"), set(pad_nodes("U2", "17"))
    for ref, num in spec.NETS["3V3"]:
        pn = pad_nodes(ref, num)
        for a in pn:
            for b in pn:
                if a < b:
                    add_e(a, b, 0.0)
    dist = {n: 0.0 for n in src}
    pq = [(0.0, n) for n in src]
    best = None
    while pq:
        d, n = hq.heappop(pq)
        if d > dist.get(n, 1e9):
            continue
        if n in dst:
            best = d
            break
        for m, r in edges.get(n, []):
            if d + r < dist.get(m, 1e9):
                dist[m] = d + r
                hq.heappush(pq, (d + r, m))
    pr.vcc_r = best
    if best is None and os.environ.get("POD_DEBUG_R"):
        seen = set(src)
        st = list(src)
        while st:
            n = st.pop()
            for m, _r in edges.get(n, []):
                if m not in seen:
                    seen.add(m)
                    st.append(m)
        inv = {v: k for k, v in nodes.items()}
        pts = [inv[n] for n in seen]
        print("  R debug: reached", len(seen), "of", len(nodes), "x", min(p[0] for p in pts), max(p[0] for p in pts),
              "y", min(p[1] for p in pts), max(p[1] for p in pts))
        far = [inv[n] for n in nodes.values() if n not in seen]
        print("  R debug: unreached sample e.g.", sorted(far)[:5], "dst nodes", len(dst))
        best_pairs = sorted((math.hypot(a[0] - b_[0], a[1] - b_[1]), a, b_) for a in pts for b_ in far)[:5]
        print("  R debug: closest reached/unreached:", best_pairs)
        d0, a0, b0 = best_pairs[0]
        na, nb = nodes[a0], nodes[b0]
        print("  R debug: edge?", [m for m, _ in edges.get(na, [])][:10], nb,
              [s_ for s_ in samples if s_[2] in (na, nb)][:4])
    print("3V3 series resistance U5.OUT -> U2.VCC along copper: %s (limit 200 mOhm, u-blox IM 4.1.1)"
          % ("n/a" if best is None else "%.0f mOhm" % (best * 1000)))


# ---------------------------------------------------------------------------
# 4b. Two-phase routing
#   phase 1 (autoroute.Router, this file): every connection of the GNSS nets
#     (their via rules are net-specific, which Freerouting cannot express) and
#     the current-carrying power trunks (0.5 mm, with 0.25 mm necks into
#     fine-pitch pads). Few nets, so the negotiated router converges.
#   phase 2 (Freerouting 2.4.1, headless): all remaining connections. The
#     phase-1 copper is locked. Spec rules are passed as temporary keep-out
#     rule areas. The session result is stored in routing/gnss-pod.ses, so a
#     re-run without Java/Freerouting reproduces the board exactly. Set
#     POD_REROUTE=1 (+ FREEROUTING_JAR, FREEROUTING_JAVA) to route again.
# ---------------------------------------------------------------------------
SES_PATH = os.path.join(HERE, "routing", "gnss-pod.ses")
# local, crossing-heavy nets around U1's bottom edge and the IMU also go in phase 1
PHASE1_EXTRA = {"USB_DP", "USB_DN", "USB_DP_C", "USB_DN_C", "I2C_SDA", "I2C_SCL", "IMU_INT1", "IMU_INT2",
                "IO5", "IO6", "IO7", "IO14", "IO47", "IO48"} | set(filter(None, os.environ.get("POD_P1_MORE", "LED1,LED2").split(",")))
DSN_PATH = os.path.join(HERE, "routing", "gnss-pod.dsn")


def phase1_order(pr):
    conns = pr.connections()
    out = []
    for c in conns:
        L, net, ia, ib = c
        ka, kb = pr.terms[net][ia]["keys"], pr.terms[net][ib]["keys"]
        tr = TRUNK.get(net, ())
        trunk = net in spec.POWER_NETS and any(k in tr for k in ka) and any(k in tr for k in kb)
        gnss = net in spec.GNSS_NETS and net != "3V3"
        imu3 = net == "3V3" and any(k.split(".")[0] in ("U3", "C14", "C15", "R7", "R8") for k in ka + kb)
        if trunk or gnss or imu3 or net in PHASE1_EXTRA:
            out.append(c)
    return sorted(out, key=lambda c: (c[1] not in spec.GNSS_NETS, c[0], c[1], c[2], c[3]))


def rule_area(board, pts, layers, name, tracks=True, vias=True):
    z = pcbnew.ZONE(board)
    z.SetIsRuleArea(True)
    ls = pcbnew.LSET()
    for l in layers:
        ls.AddLayer(l)
    z.SetLayerSet(ls)
    z.SetDoNotAllowZoneFills(True)
    z.SetDoNotAllowTracks(tracks)
    z.SetDoNotAllowVias(vias)
    z.SetDoNotAllowPads(False)
    z.SetDoNotAllowFootprints(False)
    z.SetZoneName(name)
    o = z.Outline()
    o.NewOutline()
    for x, y in pts:
        o.Append(pcbnew.VECTOR2I(MM(x), MM(y)))
    board.Add(z)
    return z


def freerouting_phase(board, fps):
    """Phase 2. Returns True if a session was imported."""
    import re
    import shutil
    import subprocess
    os.makedirs(os.path.dirname(SES_PATH), exist_ok=True)
    for t in board.GetTracks():
        t.SetLocked(True)
    ds = board.GetDesignSettings()
    ns = ds.m_NetSettings
    nc = pcbnew.NETCLASS("PowerTap")
    nc.SetClearance(MM(0.2))
    nc.SetTrackWidth(MM(W_TAP))
    nc.SetViaDiameter(MM(VIA_D))
    nc.SetViaDrill(MM(VIA_DRILL))
    ns.SetNetclass("PowerTap", nc)
    for n in sorted(spec.POWER_NETS):
        ns.SetNetclassPatternAssignment(n, "PowerTap")
    W, H = BOARD_W, BOARD_H
    tmp = [
        rule_area(board, [(0, 0), (W, 0), (W, Z3_Y), (0, Z3_Y)], [pcbnew.F_Cu, pcbnew.B_Cu], "tmp_Z3"),
        # bottom: nothing south of the 10 mm keep-out box edge (see report, Z1/Z2 overlap)
        rule_area(board, [(0, KEEPOUT[1] - 0.3), (W, KEEPOUT[1] - 0.3), (W, H), (0, H)], [pcbnew.B_Cu], "tmp_Z1B"),
        # top: Z1 below the box edge carries only the hand-routed GNSS lanes
        rule_area(board, [(0, KEEPOUT[1] - 0.3), (W, KEEPOUT[1] - 0.3), (W, H), (0, H)], [pcbnew.F_Cu], "tmp_Z1T"),
        # no GNSS-style via crowding just under U1's bottom row is not needed; keep bodies clear
        rule_area(board, [(18.6, 6.4), (31.4, 6.4), (31.4, 19.2), (18.6, 19.2)], [pcbnew.F_Cu], "tmp_U1"),
        rule_area(board, [(0, 15.7), (6.8, 15.7), (6.8, 24.4), (0, 24.4)], [pcbnew.F_Cu], "tmp_J1"),
    ]
    # GND_RESERVE copper goes to Freerouting as keep-out areas, not as GND
    # wiring (GND is not in its design): lifted here, put back after import
    for t in list(board.GetTracks()):
        if t.GetNetname() != "GND":
            continue
        ls, g, r = _geom(t)
        if t.GetClass() == "PCB_VIA":
            hit = any(math.hypot(g[0] - x, g[1] - y) < 0.01 for x, y in GND_RESERVE_VIAS)
        else:
            hit = any(abs(g[0] - a[0]) < 0.01 and abs(g[1] - a[1]) < 0.01 and abs(g[2] - c[0]) < 0.01 and abs(g[3] - c[1]) < 0.01
                      for _w, _l, pts in GND_RESERVE_TRACKS for a, c in zip(pts, pts[1:]))
        if hit:
            detach(board, t)
    for i, (w, l, pts) in enumerate(GND_RESERVE_TRACKS):
        for j, ((x0, y0), (x1, y1)) in enumerate(zip(pts, pts[1:])):
            L_ = math.hypot(x1 - x0, y1 - y0) or 1.0
            nx, ny = -(y1 - y0) / L_ * w / 2, (x1 - x0) / L_ * w / 2
            ex, ey = (x1 - x0) / L_ * w / 2, (y1 - y0) / L_ * w / 2
            tmp.append(rule_area(board, [(x0 - ex + nx, y0 - ey + ny), (x1 + ex + nx, y1 + ey + ny),
                                         (x1 + ex - nx, y1 + ey - ny), (x0 - ex - nx, y0 - ey - ny)],
                                 [pcbnew.F_Cu if l == 0 else pcbnew.B_Cu], f"tmp_gres{i}_{j}"))
    for i, (x, y) in enumerate(GND_RESERVE_VIAS):
        r = VIA_D / 2
        tmp.append(rule_area(board, [(x - r, y - r), (x + r, y - r), (x + r, y + r), (x - r, y + r)],
                             [pcbnew.F_Cu, pcbnew.B_Cu], f"tmp_gresv{i}"))
    reroute = os.environ.get("POD_REROUTE") or not os.path.exists(SES_PATH)
    if reroute:
        pcbnew.ExportSpecctraDSN(board, DSN_PATH)
        t = open(DSN_PATH).read()
        # GND is poured, not routed
        t = re.sub(r"\(net GND\s*\(pins[^)]*\)\s*\)", "", t)
        t = re.sub(r"(\(class [^\n]*?)\sGND(\s)", r"\1\2", t)
        open(DSN_PATH, "w").write(t)
        jar = os.environ.get("FREEROUTING_JAR")
        java = os.environ.get("FREEROUTING_JAVA", "java")
        if not jar:
            raise SystemExit("no stored session and FREEROUTING_JAR not set")
        tmp_ses = DSN_PATH[:-4] + ".tmp.ses"
        passes = os.environ.get("POD_FR_PASSES", "60")
        r = subprocess.run([java, "-jar", jar, "-de", DSN_PATH, "-do", tmp_ses, "-mp", passes, "-mt", "1"],
                           capture_output=True, text=True)
        open(os.path.join(os.path.dirname(SES_PATH), "freerouting.log"), "w").write(r.stdout + r.stderr)
        last = [l for l in (r.stdout + r.stderr).splitlines() if "unrouted" in l]
        print("  freerouting:", last[-1][-120:] if last else r.returncode)
        shutil.copyfile(tmp_ses, SES_PATH)
        os.remove(tmp_ses)
    for z in tmp:
        detach(board, z)
    ok = pcbnew.ImportSpecctraSES(board, SES_PATH)
    print(f"  imported {os.path.relpath(SES_PATH, HERE)}: {ok}")
    for t in board.GetTracks():
        t.SetLocked(False)
    return ok


def sync_router(pr, board):
    """Rebuild the router's copper maps from the board (for the GND stage)."""
    pr.net_tracks, pr.net_vias = {}, {}
    for t in board.GetTracks():
        n = t.GetNetname()
        if not n:
            continue
        if t.GetClass() == "PCB_VIA":
            pr.net_vias.setdefault(n, []).append((pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)))
        else:
            l = 0 if t.GetLayer() == pcbnew.F_Cu else 1
            pr.net_tracks.setdefault(n, []).append((pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y),
                                                    pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y),
                                                    pcbnew.ToMM(t.GetWidth()), l))
    pr.static_lab = [[a.copy() for a in lk] for lk in pr.base_lab]
    pr.static_vf = pr.base_vf.copy()
    pr.rebuild()


def add_hand_copper(board):
    netinfo = board.GetNetInfo()
    for _grp, net, w, layer, pts in HAND_EXTRA:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(pcbnew.VECTOR2I(MM(x0), MM(y0)))
            t.SetEnd(pcbnew.VECTOR2I(MM(x1), MM(y1)))
            t.SetWidth(MM(w))
            t.SetLayer(pcbnew.F_Cu if layer == 0 else pcbnew.B_Cu)
            t.SetNet(netinfo.GetNetItem(net))
            board.Add(t)
    for net, x, y in HAND_VIAS:
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
        v.SetWidth(MM(VIA_D))
        v.SetDrill(MM(VIA_DRILL))
        v.SetNet(netinfo.GetNetItem(net))
        board.Add(v)


_DETACHED = []


def detach(board, item):
    """board.Remove() hands ownership to the Python wrapper, which frees the C++
    object when collected while the board's connectivity cache may still hold
    it (seen as SWIG type corruption later in the run). Keep removed items
    alive instead: a few KB leaked per run."""
    board.Remove(item)
    item.thisown = 0
    _DETACHED.append(item)


def stitch_gnd_islands(board, pr, iters=8):
    """After the pour: find GND fill islands that are not connected to the
    main GND net (union-find over F/B fill islands joined by GND vias and
    THT GND pads) and give each one a stitching via into a connected pour on
    the other layer. The via sits inside the island, or at the end of a short
    0.25 mm stub from one of the island's GND pads. Clearances are checked
    exactly (0.2 mm to other-net copper, 0.25 mm hole-to-hole), with no via in
    a pad and none in the Z3 antenna band."""
    zones = {z.GetLayer(): z for z in board.Zones() if not z.GetIsRuleArea() and z.GetNetname() == "GND"}
    filler = pcbnew.ZONE_FILLER(board)
    added_all = []
    shrink = MM(VIA_D / 2 - 0.05 + 0.005)
    CS = pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS
    for it in range(iters):
        filler.Fill(board.Zones())
        isl = []     # (layer_idx, poly, deflated)
        for li, l in ((0, pcbnew.F_Cu), (1, pcbnew.B_Cu)):
            ps = zones[l].GetFilledPolysList(l)
            for i in range(ps.OutlineCount()):
                u = ps.UnitSet(i)
                d = pcbnew.SHAPE_POLY_SET(u)
                d.Deflate(shrink, CS, MM(0.005))
                isl.append((li, u, d))
        links = [t.GetPosition() for t in board.GetTracks()
                 if t.GetClass() == "PCB_VIA" and t.GetNetname() == "GND"]
        links += [p.GetPosition() for fp in board.GetFootprints() for p in fp.Pads()
                  if p.HasHole() and p.GetNetname() == "GND"]
        par = list(range(len(isl)))

        def find(a):
            while par[a] != a:
                par[a] = par[par[a]]
                a = par[a]
            return a
        for v in links:
            hit = [k for k, (_li, u, _d) in enumerate(isl) if u.Contains(v)]
            for k in hit[1:]:
                par[find(k)] = find(hit[0])
        main = find(max(range(len(isl)), key=lambda k: isl[k][1].Area()))
        lost = [k for k in range(len(isl)) if find(k) != main]
        if not lost:
            break
        ones = pr.np.ones(pr.R.X.shape, bool)
        added = []
        for k in sorted(lost, key=lambda k: -isl[k][1].Area()):
            li, u, d = isl[k]
            if find(k) == main:
                continue
            ck = _Clear(board, pr, "GND", 0.25)
            ck.masks, ck.vmask = [ones, ones], ones
            pads = []
            gpads = []
            for fp in board.GetFootprints():
                for p in fp.Pads():
                    bb = p.GetBoundingBox()
                    pads.append((pcbnew.ToMM(bb.GetLeft()) - 0.26, pcbnew.ToMM(bb.GetTop()) - 0.26,
                                 pcbnew.ToMM(bb.GetRight()) + 0.26, pcbnew.ToMM(bb.GetBottom()) + 0.26))
                    if p.GetNetname() == "GND" and p.IsOnLayer((pcbnew.F_Cu, pcbnew.B_Cu)[li]) and u.Contains(p.GetPosition()):
                        gpads.append((pcbnew.ToMM(p.GetPosition().x), pcbnew.ToMM(p.GetPosition().y)))
            lands = [isl[j][2] for j in range(len(isl)) if isl[j][0] != li and find(j) == main]
            bb = u.BBox()
            x0, y0 = pcbnew.ToMM(bb.GetLeft()) - 1.0, pcbnew.ToMM(bb.GetTop()) - 1.0
            x1, y1 = pcbnew.ToMM(bb.GetRight()) + 1.0, pcbnew.ToMM(bb.GetBottom()) + 1.0
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            cands = [(round(x0 + i * 0.05, 2), round(y0 + j * 0.05, 2))
                     for i in range(int((x1 - x0) / 0.05) + 1) for j in range(int((y1 - y0) / 0.05) + 1)]
            cands.sort(key=lambda c: (c[0] - cx) ** 2 + (c[1] - cy) ** 2)
            best = None
            dbg = [0, 0, 0, 0, 0]
            for x, y in cands:
                dbg[0] += 1
                if y < Z3_Y + VIA_D / 2 + 0.05:
                    continue
                v = pcbnew.VECTOR2I(MM(x), MM(y))
                if not any(ld.Contains(v) for ld in lands):
                    continue
                dbg[1] += 1
                if any(a <= x <= c and b <= y <= e for a, b, c, e in pads):
                    continue
                dbg[2] += 1
                if not ck.via_ok((x, y)):
                    continue
                dbg[3] += 1
                if d.Contains(v):
                    best = ((x, y), None)
                    break
                # stub from the nearest island pad
                for p in sorted(gpads, key=lambda p: math.hypot(p[0] - x, p[1] - y)):
                    if math.hypot(p[0] - x, p[1] - y) > 2.0:
                        break
                    ck.ends = [p]
                    if ck.seg_ok(p, (x, y), li):
                        if best is None or math.hypot(p[0] - x, p[1] - y) < best[2]:
                            best = ((x, y), p, math.hypot(p[0] - x, p[1] - y))
                        break
            if os.environ.get("POD_DEBUG_GND"):
                print("   island", li, round(u.Area() / 1e12, 2), [round(v, 1) for v in (x0 + 1, y0 + 1, x1 - 1, y1 - 1)],
                      "pads", gpads[:3], "funnel", dbg, "->", best)
            if best is None:
                continue
            (x, y), p = best[0], best[1]
            add_vias(board, "GND", [(x, y)])
            if p is not None:
                add_track(board, "GND", p[0], p[1], x, y, 0.25, li)
            added.append((x, y))
            # this island now reaches the main pour
            par[find(k)] = main
        if not added:
            break
        added_all += added
    filler.Fill(board.Zones())
    print(f"GND island stitching: {len(added_all)} vias added; islands still apart: {len(lost)}")
    return added_all


def add_gnd_reserve(board):
    """GND_RESERVE copper onto the board (skipping pieces already there)."""
    have_v = [(pcbnew.ToMM(v.GetPosition().x), pcbnew.ToMM(v.GetPosition().y))
              for v in board.GetTracks() if v.GetClass() == "PCB_VIA" and v.GetNetname() == "GND"]
    add_vias(board, "GND", [(x, y) for x, y in GND_RESERVE_VIAS
                            if not any(math.hypot(x - a, y - b) < 0.05 for a, b in have_v)])
    have_t = {(round(pcbnew.ToMM(t.GetStart().x), 2), round(pcbnew.ToMM(t.GetStart().y), 2),
               round(pcbnew.ToMM(t.GetEnd().x), 2), round(pcbnew.ToMM(t.GetEnd().y), 2))
              for t in board.GetTracks() if t.GetClass() == "PCB_TRACK" and t.GetNetname() == "GND"}
    for w, l, pts in GND_RESERVE_TRACKS:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if (round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)) not in have_t:
                add_track(board, "GND", x0, y0, x1, y1, w, l)


def _via_touches(board, v):
    """Copper layers on which a via actually touches something (track ends,
    pads, fills). A via that touches only one layer is useless."""
    x, y = v.GetPosition().x, v.GetPosition().y
    r = MM(VIA_D / 2)
    layers = set()
    net = v.GetNetname()
    for t in board.GetTracks():
        if t is v or t.GetNetname() != net or t.GetClass() == "PCB_VIA":
            continue
        for e in (t.GetStart(), t.GetEnd()):
            if math.hypot(e.x - x, e.y - y) <= r + t.GetWidth() / 2:
                layers.add(t.GetLayer())
                break
    for fp in board.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname() == net and p.HitTest(v.GetPosition()):
                for lay in (pcbnew.F_Cu, pcbnew.B_Cu):
                    if p.IsOnLayer(lay):
                        layers.add(lay)
    for z in board.Zones():
        if z.GetIsRuleArea() or z.GetNetname() != net:
            continue
        for lay in (pcbnew.F_Cu, pcbnew.B_Cu):
            if z.IsOnLayer(lay) and z.GetFilledPolysList(lay).Contains(v.GetPosition()):
                layers.add(lay)
    return len(layers)


def cleanup_dangling(board, rounds=6):
    """Remove track stubs and vias that end in nothing (left by rip-up /
    re-join steps). A dangling track that still connects something along its
    length is trimmed back to that point. Nothing is removed if it would add
    an unconnected item."""
    removed = trimmed = 0

    def unconnected():
        board.BuildConnectivity()
        c = board.GetConnectivity()
        c.RecalculateRatsnest()
        return c.GetUnconnectedCount(False)
    for _ in range(rounds):
        base = unconnected()
        conn = board.GetConnectivity()
        cand = []
        for t in board.GetTracks():
            if t.GetClass() == "PCB_VIA":
                if _via_touches(board, t) < 2:
                    cand.append(t)
            elif conn.TestTrackEndpointDangling(t, False):
                cand.append(t)
        if not cand:
            break
        done = 0
        for t in cand:
            board.RemoveNative(t)
            if unconnected() <= base:
                _DETACHED.append(t)
                done += 1
                continue
            board.Add(t)
            if t.GetClass() == "PCB_VIA":
                continue
            # trim: keep the part up to the same-net via / pad it passes over
            a, e = pcbnew.VECTOR2I(t.GetStart()), pcbnew.VECTOR2I(t.GetEnd())
            best = None
            for o in board.GetTracks():
                if o.GetClass() != "PCB_VIA" or o.GetNetname() != t.GetNetname():
                    continue
                c = pcbnew.VECTOR2I(o.GetPosition())
                d, _, _ = seg_seg_dist((a.x, a.y, e.x, e.y), (c.x, c.y, c.x, c.y))
                if d < MM(VIA_D / 2 - 0.05) and c != a and c != e:
                    best = c if best is None else best
            if best is None:
                continue
            for keep_start in (True, False):
                old_s, old_e = pcbnew.VECTOR2I(t.GetStart()), pcbnew.VECTOR2I(t.GetEnd())
                if keep_start:
                    t.SetEnd(best)
                else:
                    t.SetStart(best)
                if unconnected() <= base and not board.GetConnectivity().TestTrackEndpointDangling(t, False):
                    trimmed += 1
                    break
                t.SetStart(old_s)
                t.SetEnd(old_e)
        removed += done
        if not done and not trimmed:
            break
    # same-net vias whose holes are too close (hole-to-hole < 0.25 mm): drop
    # one when that does not disconnect anything
    merged = 0
    base = unconnected()
    vias = [v for v in board.GetTracks() if v.GetClass() == "PCB_VIA"]
    gone = set()
    for i, a in enumerate(vias):
        if i in gone:
            continue
        pa = a.GetPosition()
        for j in range(i + 1, len(vias)):
            if j in gone:
                continue
            b = vias[j]
            if b.GetNetname() != a.GetNetname():
                continue
            pb = b.GetPosition()
            if math.hypot(pa.x - pb.x, pa.y - pb.y) < MM(VIA_DRILL + 0.25):
                board.RemoveNative(b)
                if unconnected() <= base:
                    _DETACHED.append(b)
                    gone.add(j)
                    merged += 1
                else:
                    board.Add(b)
    unconnected()
    print(f"dangling cleanup: {removed} stubs removed, {trimmed} trimmed, {merged} near-duplicate vias merged")
    return removed


def add_vias(board, net, pts):
    n = board.FindNet(net)
    out = []
    for x, y in pts:
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
        v.SetWidth(MM(VIA_D))
        v.SetDrill(MM(VIA_DRILL))
        v.SetNet(n)
        board.Add(v)
        out.append(v)
    return out


def add_track(board, net, x0, y0, x1, y1, w, layer):
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(pcbnew.VECTOR2I(MM(x0), MM(y0)))
    t.SetEnd(pcbnew.VECTOR2I(MM(x1), MM(y1)))
    t.SetWidth(MM(w))
    t.SetLayer(pcbnew.F_Cu if layer == 0 else pcbnew.B_Cu)
    t.SetNet(board.FindNet(net))
    board.Add(t)
    return t


# ---------------------------------------------------------------------------
# 4c. Phase 3: close whatever Freerouting left open (hard-constraint A* on
#     top of all existing copper). Copper clusters per net come from a
#     union-find over pads, tracks and vias.
# ---------------------------------------------------------------------------
def net_clusters(board, net):
    items = []   # (kind, geom, layers)
    for fp in board.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname() == net and pad_layers(p):
                items.append(("pad", pad_shape(p), set(pad_layers(p))))
    for t in board.GetTracks():
        if t.GetNetname() != net:
            continue
        if t.GetClass() == "PCB_VIA":
            x, y = pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)
            items.append(("via", ("seg", x, y, x, y, VIA_D / 2), {0, 1}))
        else:
            l = 0 if t.GetLayer() == pcbnew.F_Cu else 1
            items.append(("trk", ("seg", pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y),
                                  pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y), pcbnew.ToMM(t.GetWidth()) / 2), {l}))
    n = len(items)
    par = list(range(n))

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a

    def touch(a, b):
        ga, gb = a[1], b[1]
        if ga[0] == "seg" and gb[0] == "seg":
            d, _, _ = seg_seg_dist(ga[1:5], gb[1:5])
            return d <= ga[5] + gb[5] + 0.005
        if ga[0] == "rect" and gb[0] == "rect":
            return abs(ga[1] - gb[1]) <= ga[3] + gb[3] and abs(ga[2] - gb[2]) <= ga[4] + gb[4]
        r, s = (ga, gb) if ga[0] == "rect" else (gb, ga)
        return shape_touches(r, s[1], s[2], s[3], s[4], s[5] + 0.005)
    for i in range(n):
        for j in range(i + 1, n):
            if items[i][2] & items[j][2] and find(i) != find(j) and touch(items[i], items[j]):
                par[find(i)] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(items[i])
    return list(groups.values())


def cluster_cells(pr, net, grp):
    nid = pr.nid[net]
    cells = set()
    for kind, g, layers in grp:
        if kind == "pad":
            for (i, j) in pr.R.cells_in(g):
                for l in layers:
                    lab = pr.R.lab[0][l][j, i]
                    if lab in (-1, nid):
                        cells.add((i, j, l))
        else:
            for l in layers:
                cells |= {c for c in pr.track_cells(g[1], g[2], g[3], g[4], l)}
    return cells


def phase3(board, pr, rounds=3):
    """Returns the list of nets still split after the attempts."""
    left = []
    for rnd in range(rounds):
        sync_router(pr, board)
        left = []
        added = 0
        for net in sorted(spec.NETS):
            if net == "GND":
                continue
            grps = net_clusters(board, net)
            if len(grps) < 2:
                continue
            cells = [cluster_cells(pr, net, g) for g in grps]
            # join the largest cluster with each other one, nearest first
            order = sorted(range(len(grps)), key=lambda i: -len(cells[i]))
            base = set(cells[order[0]])
            ok_all = True
            for i in order[1:]:
                path = hard_route(pr, net, base, cells[i])
                if path is None:
                    ok_all = False
                    continue
                segs, vias = path
                for (x0, y0, x1, y1, w, l) in segs:
                    add_track(board, net, x0, y0, x1, y1, w, l)
                    pr.R.commit_track(x0, y0, x1, y1, w, l, pr.nid[net])
                add_vias(board, net, vias)
                for (x, y) in vias:
                    pr.R.commit_via(x, y, pr.nid[net])
                base |= cells[i]
                added += 1
            if not ok_all:
                left.append(net)
        print(f"  phase 3 round {rnd + 1}: {added} links added, still split: {left}")
        if not left or added == 0:
            break
    return left


# ---------------------------------------------------------------------------
# 4e. Phase 4: local rip-up for nets phase 3 could not join. For the gap
#     between two copper clusters of a split net, the other nets' non-hand
#     copper inside a window around the gap is lifted, the split net is
#     joined, then every lifted net is re-joined (hard rules). If anything
#     fails the board is rolled back exactly. Windows grow, then nets are
#     lifted one at a time before all together.
# ---------------------------------------------------------------------------
def _join_net(board, pr, net, added):
    """Join all copper clusters of `net` (hard rules). Appends created board
    items to `added`. Returns True when the net is one cluster."""
    grps = net_clusters(board, net)
    if len(grps) < 2:
        return True
    cells = [cluster_cells(pr, net, g) for g in grps]
    order = sorted(range(len(grps)), key=lambda i: -len(cells[i]))
    base = set(cells[order[0]])
    for i in order[1:]:
        path = hard_route(pr, net, base, cells[i])
        if path is None:
            return False
        segs, vias = path
        for (x0, y0, x1, y1, w, l) in segs:
            added.append(add_track(board, net, x0, y0, x1, y1, w, l))
            pr.R.commit_track(x0, y0, x1, y1, w, l, pr.nid[net])
        added += add_vias(board, net, vias)
        for (x, y) in vias:
            pr.R.commit_via(x, y, pr.nid[net])
        base |= cells[i]
    return True


def _gap_window(board, net):
    """Closest points between the net's first two clusters -> (cx, cy)."""
    grps = net_clusters(board, net)
    best = None
    pts = []
    for g in grps:
        p = []
        for kind, geo, _l in g:
            if geo[0] == "seg":
                p += [(geo[1], geo[2]), (geo[3], geo[4])]
            else:
                p.append((geo[1], geo[2]))
        pts.append(p)
    for a in range(len(pts)):
        for b in range(a + 1, len(pts)):
            for pa in pts[a]:
                for pb in pts[b]:
                    d = math.hypot(pa[0] - pb[0], pa[1] - pb[1])
                    if best is None or d < best[0]:
                        best = (d, pa, pb)
    return best


def _items_in_window(board, win, protect, skip_nets):
    x0, y0, x1, y1 = win
    hk, hv = protect
    out = {}
    for t in board.GetTracks():
        n = t.GetNetname()
        if not n or n == "GND" or n in skip_nets:
            continue
        if t.GetClass() == "PCB_VIA":
            x, y = pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)
            if (n, round(x, 2), round(y, 2)) in hv:
                continue
            if x0 <= x <= x1 and y0 <= y <= y1:
                out.setdefault(n, []).append(t)
        else:
            a = (pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y))
            b = (pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y))
            l = 0 if t.GetLayer() == pcbnew.F_Cu else 1
            if (n, round(a[0], 2), round(a[1], 2), round(b[0], 2), round(b[1], 2), l) in hk:
                continue
            # segment vs window: sample
            hit = False
            for k in range(11):
                x = a[0] + (b[0] - a[0]) * k / 10
                y = a[1] + (b[1] - a[1]) * k / 10
                if x0 <= x <= x1 and y0 <= y <= y1:
                    hit = True
                    break
            if hit:
                out.setdefault(n, []).append(t)
    return out


def _try_lift(board, pr, net, lift):
    """Lift `lift` = {net: [items]}, join net + lifted nets; roll back on failure."""
    removed = [t for items in lift.values() for t in items]
    for t in removed:
        board.RemoveNative(t)     # wrapper keeps thisown = 0: the item stays alive
    sync_router(pr, board)
    added = []
    ok = _join_net(board, pr, net, added)
    why = net
    if ok:
        for n in sorted(lift, key=lambda n: n in spec.POWER_NETS, reverse=True):
            if not _join_net(board, pr, n, added):
                ok, why = False, n
                break
    if os.environ.get("POD_DEBUG4") and len(lift) > 1:
        print(f"    lift {sorted(lift)} for {net}: {'ok' if ok else 'failed at ' + why}")
    if not ok:
        for t in added:
            detach(board, t)
        for t in removed:
            board.Add(t)
        sync_router(pr, board)
        return False
    _DETACHED.extend(removed)
    return True


def _is_hand(t, protect):
    hk, hv = protect
    n = t.GetNetname()
    if t.GetClass() == "PCB_VIA":
        x, y = pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)
        return (n, round(x, 2), round(y, 2)) in hv
    key = (n, round(pcbnew.ToMM(t.GetStart().x), 2), round(pcbnew.ToMM(t.GetStart().y), 2),
           round(pcbnew.ToMM(t.GetEnd().x), 2), round(pcbnew.ToMM(t.GetEnd().y), 2),
           0 if t.GetLayer() == pcbnew.F_Cu else 1)
    return key in hk


def _geom(t):
    """(layers, (x0, y0, x1, y1), radius) of a track/via in mm."""
    if t.GetClass() == "PCB_VIA":
        x, y = pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)
        return (0, 1), (x, y, x, y), VIA_D / 2
    l = 0 if t.GetLayer() == pcbnew.F_Cu else 1
    return (l,), (pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y),
                  pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y)), pcbnew.ToMM(t.GetWidth()) / 2


def _corridor_lift(board, pr, net, protect):
    """Route `net` as if the board had only pads + hand copper; return the
    other nets' movable items that the ideal path would collide with."""
    others = [t for t in board.GetTracks()
              if t.GetNetname() not in ("", "GND", net) and not _is_hand(t, protect)]
    for t in others:
        board.RemoveNative(t)
    sync_router(pr, board)
    added = []
    ok = _join_net(board, pr, net, added)
    path = [_geom(t) for t in added]
    for t in added:
        detach(board, t)
    for t in others:
        board.Add(t)
    sync_router(pr, board)
    if not ok:
        return None
    lift = {}
    for t in others:
        ls, g, r = _geom(t)
        for pls, pg, pr_ in path:
            if set(ls) & set(pls):
                d, _, _ = seg_seg_dist(g, pg)
                if d < r + pr_ + CLR + 0.05:
                    lift.setdefault(t.GetNetname(), []).append(t)
                    break
    return lift


def phase4(board, pr, left):
    protect = hand_segment_keys()
    still = []
    for net in left:
        done = False
        for _ in range(6):      # several gaps per net
            if len(net_clusters(board, net)) < 2:
                done = True
                break
            gap = _gap_window(board, net)
            if gap is None:
                break
            dist, pa, pb = gap
            progress = False
            # long gaps: straight to the corridor lift (windows would cover
            # half the board)
            pads_try = (0.8, 1.5, 2.5, 4.0) if dist < 6.0 else ()
            for pad in pads_try:
                win = (min(pa[0], pb[0]) - pad, min(pa[1], pb[1]) - pad,
                       max(pa[0], pb[0]) + pad, max(pa[1], pb[1]) + pad)
                cand = _items_in_window(board, win, protect, set())
                own = cand.pop(net, [])
                trials = [{n: cand[n]} for n in sorted(cand, key=lambda n: len(cand[n]))[:6]]
                if len(cand) > 1:
                    trials.append(dict(cand))
                if own:
                    # also let the net re-path its own pieces inside the window
                    trials = trials + [dict(t, **{net: own}) for t in trials]
                for lift in trials:
                    if _try_lift(board, pr, net, lift):
                        print(f"  phase 4: {net} joined by lifting {sorted(lift)} (window +{pad} mm)")
                        progress = True
                        break
                if progress:
                    break
            if not progress:
                lift = _corridor_lift(board, pr, net, protect)
                if lift and _try_lift(board, pr, net, lift):
                    print(f"  phase 4: {net} joined along its free-board corridor, lifting {sorted(lift)}")
                    progress = True
            if not progress:
                break
        if not done and len(net_clusters(board, net)) >= 2:
            still.append(net)
    print(f"  phase 4: still split: {still}")
    return still


# ---------------------------------------------------------------------------
# 4f. Phase 5: off-grid micro joins. What is left after phase 4 are short
#     gaps (a few tenths of a mm to ~2 mm) that the 0.1 mm router grid cannot
#     thread. Candidate straight / one-bend / one-via paths on a 0.05 mm grid
#     are checked with KiCad's exact shape collision (0.2 mm clearance to
#     every other-net pad, track and via, 0.25 mm hole-to-hole) and with the
#     same zone rules (router region masks) as everything else.
# ---------------------------------------------------------------------------
def _ports(grp):
    out = []
    for kind, geo, layers in grp:
        if geo[0] == "seg":
            pts = [(geo[1], geo[2])] if kind == "via" else [(geo[1], geo[2]), (geo[3], geo[4])]
        else:
            pts = [(geo[1], geo[2])]
        for p in pts:
            out.append((p, tuple(sorted(layers))))
    return out


class _Clear:
    def __init__(self, board, pr, net, w):
        self.pr, self.net, self.w = pr, net, w
        self.ends = []
        top_ok, bot_ok, via_ok = pr.conn_region(net, [])
        self.masks = [top_ok, bot_ok]
        self.vmask = via_ok & top_ok & bot_ok
        self.obst = {0: [], 1: []}
        self.holes = []
        L = {0: pcbnew.F_Cu, 1: pcbnew.B_Cu}
        for t in board.GetTracks():
            is_via = t.GetClass() == "PCB_VIA"
            if is_via:
                x, y = pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)
                self.holes.append((x, y, pcbnew.ToMM(t.GetDrill()) / 2))
            if t.GetNetname() == net:
                continue
            bb = t.GetBoundingBox()
            box = (pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()), pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()))
            for l in ((0, 1) if is_via else (0 if t.GetLayer() == pcbnew.F_Cu else 1,)):
                self.obst[l].append((box, t.GetEffectiveShape(L[l])))
        for fp in board.GetFootprints():
            for p in fp.Pads():
                if p.HasHole():
                    ds = p.GetDrillSize()
                    self.holes.append((pcbnew.ToMM(p.GetPosition().x), pcbnew.ToMM(p.GetPosition().y),
                                       pcbnew.ToMM(max(ds.x, ds.y)) / 2))
                if p.GetNetname() == net and net:
                    continue
                bb = p.GetBoundingBox()
                box = (pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()), pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()))
                for l in (0, 1):
                    if p.IsOnLayer(L[l]) or p.HasHole():
                        self.obst[l].append((box, p.GetEffectiveShape(L[l])))

    def _mask_ok(self, x0, y0, x1, y1, l):
        R = self.pr.R
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / 0.05))
        for k in range(n + 1):
            x = x0 + (x1 - x0) * k / n
            y = y0 + (y1 - y0) * k / n
            # the path's own end ports (pads under a body, etc.) are exempt
            if any(math.hypot(x - px, y - py) < 0.35 for px, py in self.ends):
                continue
            i, j = int(round(x / R.res)), int(round(y / R.res))
            if not (0 <= i < R.nx and 0 <= j < R.ny) or not self.masks[l][j, i]:
                return False
        return True

    def seg_ok(self, a, b, l):
        w = self.w
        m = w / 2 + CLR + 0.01
        if min(a[0], b[0]) < 0.3 + w / 2 or max(a[0], b[0]) > BOARD_W - 0.3 - w / 2:
            return False
        if min(a[1], b[1]) < Z3_Y + w / 2 or max(a[1], b[1]) > BOARD_H - 0.3 - w / 2:
            return False
        if not self._mask_ok(a[0], a[1], b[0], b[1], l):
            return False
        s = pcbnew.SEG(pcbnew.VECTOR2I(MM(a[0]), MM(a[1])), pcbnew.VECTOR2I(MM(b[0]), MM(b[1])))
        lo_x, hi_x = min(a[0], b[0]) - m, max(a[0], b[0]) + m
        lo_y, hi_y = min(a[1], b[1]) - m, max(a[1], b[1]) + m
        cl = MM(CLR + w / 2 + 0.005)
        for box, sh in self.obst[l]:
            if box[2] < lo_x or box[0] > hi_x or box[3] < lo_y or box[1] > hi_y:
                continue
            if sh.Collide(s, cl):
                return False
        return True

    def via_ok(self, v):
        R = self.pr.R
        i, j = int(round(v[0] / R.res)), int(round(v[1] / R.res))
        # zone rules from the region masks; clearances checked exactly below
        # (the router's via_forbid map is a conservative grid inflation)
        if not (0 <= i < R.nx and 0 <= j < R.ny) or not self.vmask[j, i]:
            return False
        if v[1] < Z3_Y + VIA_D / 2 or not (0.3 + VIA_D / 2 <= v[0] <= BOARD_W - 0.3 - VIA_D / 2):
            return False
        for hx, hy, hr in self.holes:
            if math.hypot(v[0] - hx, v[1] - hy) < hr + VIA_DRILL / 2 + 0.25:
                return False
        p = pcbnew.VECTOR2I(MM(v[0]), MM(v[1]))
        m = VIA_D / 2 + CLR + 0.01
        cl = MM(CLR + VIA_D / 2 + 0.005)
        for l in (0, 1):
            for box, sh in self.obst[l]:
                if box[2] < v[0] - m or box[0] > v[0] + m or box[3] < v[1] - m or box[1] > v[1] + m:
                    continue
                if sh.Collide(p, cl):
                    return False
        return True


def _micro_path(ck, a, la, b, lb, reach=0.6, step=0.05):
    """Straight / one-bend on a shared layer, else one via. -> (segs, vias)."""
    ax, ay = a
    bx, by = b
    ck.ends = [a, b]
    x0, x1 = min(ax, bx) - reach, max(ax, bx) + reach
    y0, y1 = min(ay, by) - reach, max(ay, by) + reach
    grid = [(round(x0 + i * step, 3), round(y0 + j * step, 3))
            for i in range(int((x1 - x0) / step) + 1) for j in range(int((y1 - y0) / step) + 1)]
    cost = lambda m: math.hypot(m[0] - ax, m[1] - ay) + math.hypot(bx - m[0], by - m[1])
    grid.sort(key=cost)
    for l in sorted(set(la) & set(lb)):
        if ck.seg_ok(a, b, l):
            return [(a, b, l)], []
        for m in grid[:6000]:
            if ck.seg_ok(a, m, l) and ck.seg_ok(m, b, l):
                return [(a, m, l), (m, b, l)], []
    for l1 in la:
        for l2 in lb:
            if l1 == l2:
                continue
            for v in grid:
                if not ck.via_ok(v):
                    continue
                s1 = [] if v == a else [(a, v, l1)]
                s2 = [] if v == b else [(v, b, l2)]
                if all(ck.seg_ok(p, q, l) for p, q, l in s1 + s2):
                    return s1 + s2, [v]
    return None


def micro_join(board, pr, nets, max_d=2.5, added=None, quiet=False):
    still = []
    for net in nets:
        w = W_TAP if net in spec.POWER_NETS else W_SIG
        for _ in range(8):
            grps = net_clusters(board, net)
            if len(grps) < 2:
                break
            ck = _Clear(board, pr, net, w)
            ports = [_ports(g) for g in grps]
            pairs = []
            for ia in range(len(ports)):
                for ib in range(ia + 1, len(ports)):
                    for pa, la in ports[ia]:
                        for pb, lb in ports[ib]:
                            d = math.hypot(pa[0] - pb[0], pa[1] - pb[1])
                            if d <= max_d:
                                pairs.append((d, pa, la, pb, lb))
            pairs.sort()
            done = False
            got = None
            for reach, step in ((0.6, 0.05), (1.0, 0.025)):
                for d, pa, la, pb, lb in pairs[:16]:
                    got = _micro_path(ck, pa, la, pb, lb, reach, step)
                    if got:
                        break
                if got:
                    break
            if got:
                segs, vias = got
                for p, q, l in segs:
                    t = add_track(board, net, p[0], p[1], q[0], q[1], w, l)
                    if added is not None:
                        added.append(t)
                vs = add_vias(board, net, vias)
                if added is not None:
                    added += vs
                if not quiet:
                    print(f"  phase 5: {net} micro-joined {pa}->{pb} ({len(segs)} segs, {len(vias)} vias)")
                done = True
            if not done:
                break
        if len(net_clusters(board, net)) > 1:
            still.append(net)
    if not quiet:
        print(f"  phase 5: still split: {still}")
    return still


def _gnd_islands(board):
    """GND fill islands + union-find over GND vias / THT pads.
    -> (isl [(layer_idx, poly, deflated)], root_of(k), main_root)"""
    zones = {z.GetLayer(): z for z in board.Zones() if not z.GetIsRuleArea() and z.GetNetname() == "GND"}
    shrink = MM(VIA_D / 2 - 0.05 + 0.005)
    isl = []
    for li, l in ((0, pcbnew.F_Cu), (1, pcbnew.B_Cu)):
        ps = zones[l].GetFilledPolysList(l)
        for i in range(ps.OutlineCount()):
            u = ps.UnitSet(i)
            d = pcbnew.SHAPE_POLY_SET(u)
            d.Deflate(shrink, pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.005))
            isl.append((li, u, d))
    links = [t.GetPosition() for t in board.GetTracks() if t.GetClass() == "PCB_VIA" and t.GetNetname() == "GND"]
    links += [p.GetPosition() for fp in board.GetFootprints() for p in fp.Pads()
              if p.HasHole() and p.GetNetname() == "GND"]
    par = list(range(len(isl)))

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    for v in links:
        hit = [k for k, (_li, u, _d) in enumerate(isl) if u.Contains(v)]
        for k in hit[1:]:
            par[find(k)] = find(hit[0])
    # U1's GND pads are one node inside the module (footprint jumper group)
    u1 = board.FindFootprintByReference("U1")
    if u1 is not None:
        ks = []
        for p in u1.Pads():
            if p.GetNetname() != "GND":
                continue
            for k, (li, u, _d) in enumerate(isl):
                if li == 0 and u.Contains(p.GetPosition()):
                    ks.append(k)
        for k in ks[1:]:
            par[find(k)] = find(ks[0])
    main = find(max(range(len(isl)), key=lambda k: isl[k][1].Area()))
    return isl, find, main


def gnd_lift(board, pr, rounds=6):
    """For GND islands that stitching could not reach: put a GND via (plus a
    short stub from an island GND pad) where the other layer has connected
    pour, lifting the few signal pieces in the way, then re-join the lifted
    nets (hard rules, then micro joins). Rolled back if any net stays split."""
    protect = hand_segment_keys()
    filler = pcbnew.ZONE_FILLER(board)
    fixed = 0
    for rnd in range(rounds):
        filler.Fill(board.Zones())
        isl, find, main = _gnd_islands(board)
        lost = [k for k in range(len(isl)) if find(k) != main]
        if not lost:
            break
        progress = False
        # snapshot of movable other-net copper
        movable = []
        for t in board.GetTracks():
            n = t.GetNetname()
            if not n or n == "GND":
                continue
            ls, g, r = _geom(t)
            movable.append((t, ls, g, r, _is_hand(t, protect)))
        pads = []
        for fp in board.GetFootprints():
            for p in fp.Pads():
                bb = p.GetBoundingBox()
                pads.append((p, (pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()),
                                 pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()))))
        holes = []
        for fp in board.GetFootprints():
            for p in fp.Pads():
                if p.HasHole():
                    ds = p.GetDrillSize()
                    holes.append((pcbnew.ToMM(p.GetPosition().x), pcbnew.ToMM(p.GetPosition().y), pcbnew.ToMM(max(ds.x, ds.y)) / 2))
        gvias = [(pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y))
                 for t in board.GetTracks() if t.GetClass() == "PCB_VIA" and t.GetNetname() == "GND"]
        done_roots = set()
        for k in sorted(lost, key=lambda k: -isl[k][1].Area()):
            if find(k) in done_roots:
                continue
            li, u, dfl = isl[k]
            L = (pcbnew.F_Cu, pcbnew.B_Cu)[li]
            gp = [(pcbnew.ToMM(p.GetPosition().x), pcbnew.ToMM(p.GetPosition().y)) for p, _b in pads
                  if p.GetNetname() == "GND" and p.IsOnLayer(L) and u.Contains(p.GetPosition())]
            if not gp:
                continue
            lands = [isl[j][2] for j in range(len(isl)) if isl[j][0] != li and find(j) == main]
            cands = []
            for (px, py) in gp:
                for i in range(-50, 51):
                    for j in range(-50, 51):
                        x, y = round(px + i * 0.05, 2), round(py + j * 0.05, 2)
                        dd = math.hypot(x - px, y - py)
                        if dd > 2.5 or y < Z3_Y + VIA_D / 2 + 0.05:
                            continue
                        cands.append((dd, (px, py), (x, y)))
            cands.sort()
            tried = 0
            for dd, p0, (x, y) in cands:
                v = pcbnew.VECTOR2I(MM(x), MM(y))
                if not any(ld.Contains(v) for ld in lands):
                    continue
                if any(b[0] - 0.26 <= x <= b[2] + 0.26 and b[1] - 0.26 <= y <= b[3] + 0.26 for _p, b in pads):
                    continue
                near = [p for p, b in pads if p.GetNetname() != "GND" and
                        b[0] - 0.5 <= x <= b[2] + 0.5 and b[1] - 0.5 <= y <= b[3] + 0.5]
                if any(p.GetEffectiveShape(lay).Collide(v, MM(CLR + VIA_D / 2 + 0.005))
                       for p in near for lay in (pcbnew.F_Cu, pcbnew.B_Cu) if p.IsOnLayer(lay)):
                    continue
                if any(math.hypot(x - hx, y - hy) < hr + VIA_DRILL / 2 + 0.3 for hx, hy, hr in holes):
                    continue
                if any(math.hypot(x - gx, y - gy) < VIA_DRILL + 0.3 for gx, gy in gvias):
                    continue
                inside = dfl.Contains(v)
                stub = None if inside else (p0[0], p0[1], x, y)
                # which other-net copper is in the way (exact, own layer + via on both)
                lift, bad = {}, False
                for t, ls, g, r, hand in movable:
                    hitv = seg_seg_dist(g, (x, y, x, y))[0] < r + VIA_D / 2 + CLR + 0.01
                    hits = stub is not None and li in ls and seg_seg_dist(g, stub)[0] < r + 0.125 + CLR + 0.01
                    if hitv or hits:
                        if hand:
                            bad = True
                            break
                        lift.setdefault(t.GetNetname(), []).append(t)
                if bad:
                    continue
                # pads of other nets in the stub's way
                if stub is not None:
                    s = pcbnew.SEG(pcbnew.VECTOR2I(MM(stub[0]), MM(stub[1])), pcbnew.VECTOR2I(MM(x), MM(y)))
                    blocked = False
                    for p, b in pads:
                        if p.GetNetname() == "GND" or not p.IsOnLayer(L):
                            continue
                        if b[2] < min(stub[0], x) - 0.4 or b[0] > max(stub[0], x) + 0.4 or \
                           b[3] < min(stub[1], y) - 0.4 or b[1] > max(stub[1], y) + 0.4:
                            continue
                        if p.GetEffectiveShape(L).Collide(s, MM(CLR + 0.125 + 0.005)):
                            blocked = True
                            break
                    if blocked:
                        continue
                if sum(len(v_) for v_ in lift.values()) > 6:
                    continue
                tried += 1
                if tried > 25:
                    break
                if _gnd_try(board, pr, lift, (x, y), stub, li):
                    print(f"  GND island at {p0} joined: via ({x}, {y}){' + stub' if stub else ''}, "
                          f"lifted {sorted(lift)}")
                    fixed += 1
                    progress = True
                    done_roots.add(find(k))
                    break
            if progress:
                break      # geometry changed: refill and recompute
        if not progress:
            break
    filler.Fill(board.Zones())
    return fixed


def _gnd_try(board, pr, lift, v, stub, li):
    removed = [t for items in lift.values() for t in items]
    for t in removed:
        board.RemoveNative(t)
    added = add_vias(board, "GND", [v])
    if stub is not None:
        added.append(add_track(board, "GND", stub[0], stub[1], stub[2], stub[3], 0.25, li))
    sync_router(pr, board)
    ok = True
    for n in sorted(lift):
        if not _join_net(board, pr, n, added):
            sync_router(pr, board)
            if micro_join(board, pr, [n], added=added, quiet=True):
                ok = False
                break
    if not ok:
        for t in added:
            detach(board, t)
        for t in removed:
            board.Add(t)
        sync_router(pr, board)
        return False
    _DETACHED.extend(removed)
    return True


def _snapshot(board):
    snap = []
    for t in board.GetTracks():
        if t.GetClass() == "PCB_VIA":
            snap.append((t.GetNetname(), "v", pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)))
        else:
            snap.append((t.GetNetname(), "t", pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y),
                         pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y), pcbnew.ToMM(t.GetWidth()),
                         0 if t.GetLayer() == pcbnew.F_Cu else 1))
    return snap


def _restore(board, snap):
    for t in list(board.GetTracks()):
        detach(board, t)
    for it in snap:
        if it[1] == "v":
            add_vias(board, it[0], [(it[2], it[3])])
        else:
            add_track(board, it[0], *it[2:])


def stitch_two_hop(board, pr, iters=6):
    """GND islands that hold GND pads but reach the main pour only through a
    pour fragment on the other layer that KiCad would drop as an island: keep
    all fragments while stitching (island removal off), join
    pad island -> via -> fragment -> via -> main pour, then switch island
    removal back on (unused fragments disappear again)."""
    zones = [z for z in board.Zones() if not z.GetIsRuleArea() and z.GetNetname() == "GND"]
    for z in zones:
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_NEVER)
    filler = pcbnew.ZONE_FILLER(board)
    ones = pr.np.ones(pr.R.X.shape, bool)
    added = 0
    for _ in range(iters):
        filler.Fill(board.Zones())
        isl, find, main = _gnd_islands(board)
        gpads = [p for fp in board.GetFootprints() for p in fp.Pads() if p.GetNetname() == "GND"]
        need = []
        for k, (li, u, d) in enumerate(isl):
            if find(k) == main:
                continue
            L = (pcbnew.F_Cu, pcbnew.B_Cu)[li]
            if any(p.IsOnLayer(L) and u.Contains(p.GetPosition()) for p in gpads):
                need.append(k)
        if os.environ.get("POD_DEBUG_GND"):
            print("   two-hop need:", [(isl[k][0], round(isl[k][1].Area() / 1e12, 2),
                                     [round(pcbnew.ToMM(v), 1) for v in (isl[k][1].BBox().GetLeft(), isl[k][1].BBox().GetTop())])
                                    for k in need])
        if not need:
            break
        pads = []
        holes = []
        for fp in board.GetFootprints():
            for p in fp.Pads():
                bb = p.GetBoundingBox()
                pads.append((pcbnew.ToMM(bb.GetLeft()) - 0.26, pcbnew.ToMM(bb.GetTop()) - 0.26,
                             pcbnew.ToMM(bb.GetRight()) + 0.26, pcbnew.ToMM(bb.GetBottom()) + 0.26))
        ck = _Clear(board, pr, "GND", 0.25)
        ck.masks, ck.vmask = [ones, ones], ones

        def spot_ok(x, y):
            if y < Z3_Y + VIA_D / 2 + 0.05:
                return False
            if any(a <= x <= c and b <= y <= e for a, b, c, e in pads):
                return False
            return ck.via_ok((x, y))

        def spots(poly_a, poly_b_list, step=0.1):
            bb = poly_a.BBox()
            x0, y0 = pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop())
            x1, y1 = pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom())
            for i in range(int((x1 - x0) / step) + 1):
                for j in range(int((y1 - y0) / step) + 1):
                    x, y = round(x0 + i * step, 2), round(y0 + j * step, 2)
                    v = pcbnew.VECTOR2I(MM(x), MM(y))
                    if not poly_a.Contains(v):
                        continue
                    for bi, pb in poly_b_list:
                        if pb.Contains(v) and spot_ok(x, y):
                            yield (x, y), bi
                            break
        progress = False
        for k in need:
            li, u, d = isl[k]
            L = (pcbnew.F_Cu, pcbnew.B_Cu)[li]
            others = [(j, isl[j][2]) for j in range(len(isl)) if isl[j][0] != li]
            mains_same = [(j, isl[j][2]) for j in range(len(isl)) if isl[j][0] == li and find(j) == main]
            my_pads = [(pcbnew.ToMM(p.GetPosition().x), pcbnew.ToMM(p.GetPosition().y)) for p in gpads
                       if p.IsOnLayer(L) and u.Contains(p.GetPosition())]
            cands = []
            for (px, py) in my_pads:
                for i in range(-30, 31):
                    for j in range(-30, 31):
                        x, y = round(px + i * 0.05, 2), round(py + j * 0.05, 2)
                        dd = math.hypot(x - px, y - py)
                        if dd <= 1.5:
                            cands.append((dd, (px, py), (x, y)))
            cands.sort()
            done = None
            stub = None
            tried = set()
            for dd, p0, (x, y) in cands:
                v = pcbnew.VECTOR2I(MM(x), MM(y))
                js = [jj for jj, pb in others if pb.Contains(v)]
                if not js or not spot_ok(x, y):
                    continue
                inside = d.Contains(v)
                if not inside:
                    ck.ends = [p0]
                    if not ck.seg_ok(p0, (x, y), li):
                        continue
                jj = js[0]
                if find(jj) == main:
                    done, stub = [(x, y)], (None if inside else p0)
                    break
                if jj in tried:
                    continue
                tried.add(jj)
                for (x2, y2), _m in spots(isl[jj][2], mains_same):
                    if math.hypot(x2 - x, y2 - y) >= VIA_DRILL + 0.3:
                        done, stub = [(x, y), (x2, y2)], (None if inside else p0)
                        break
                if done:
                    break
            if done and stub is not None:
                add_track(board, "GND", stub[0], stub[1], done[0][0], done[0][1], 0.25, li)
            if os.environ.get("POD_DEBUG_GND"):
                print("   two-hop island", k, "tried fragments", sorted(tried), "->", done)
            if done:
                add_vias(board, "GND", done)
                added += len(done)
                progress = True
                print(f"  GND two-hop stitch: {done}")
                break          # geometry changed: refill
        if not progress:
            break
    for z in zones:
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    filler.Fill(board.Zones())
    return added


def _commit_path(board, pr, net, path, added):
    segs, vias = path
    for (x0, y0, x1, y1, w, l) in segs:
        added.append(add_track(board, net, x0, y0, x1, y1, w, l))
    added += add_vias(board, net, vias)


def gnd_route(board, pr, rounds=8, win=4.0):
    """Last GND stage: route a GND track (A*, hard rules) from an isolated
    island's GND pads to the nearest connected pour; if the way is blocked,
    route it on a board without the movable signal copper around it, lift the
    signal pieces that path collides with and re-join those nets. Rolled back
    when a lifted net cannot be re-joined."""
    protect = hand_segment_keys()
    filler = pcbnew.ZONE_FILLER(board)
    R = pr.R
    fixed = 0
    for rnd in range(rounds):
        filler.Fill(board.Zones())
        isl, find, main = _gnd_islands(board)
        lost = [k for k in range(len(isl)) if find(k) != main]
        if not lost:
            break
        progress = False
        for k in sorted(lost, key=lambda k: -isl[k][1].Area()):
            li, u, _d = isl[k]
            L = (pcbnew.F_Cu, pcbnew.B_Cu)[li]
            gp = [p for fp in board.GetFootprints() for p in fp.Pads()
                  if p.GetNetname() == "GND" and p.IsOnLayer(L) and u.Contains(p.GetPosition())]
            if not gp:
                continue
            nid = pr.nid["GND"]
            src = set()
            for p in gp:
                for (i, j) in R.cells_in(pad_shape(p)):
                    src.add((i, j, li))
            cx = sum(pcbnew.ToMM(p.GetPosition().x) for p in gp) / len(gp)
            cy = sum(pcbnew.ToMM(p.GetPosition().y) for p in gp) / len(gp)
            dst = set()
            mains = [(isl[j][0], isl[j][2]) for j in range(len(isl)) if find(j) == main]
            step = 2    # every 0.2 mm
            i0, i1 = max(0, int((cx - win) / R.res)), min(R.nx - 1, int((cx + win) / R.res))
            j0, j1 = max(0, int((cy - win) / R.res)), min(R.ny - 1, int((cy + win) / R.res))
            for i in range(i0, i1 + 1, step):
                for j in range(j0, j1 + 1, step):
                    v = pcbnew.VECTOR2I(MM(i * R.res), MM(j * R.res))
                    for ml, md in mains:
                        if md.Contains(v):
                            dst.add((i, j, ml))
            if not dst:
                continue
            sync_router(pr, board)
            path = hard_route(pr, "GND", src, dst)
            if os.environ.get("POD_DEBUG_GND"):
                top_ok, bot_ok, via_ok = pr.region("GND")
                fr = R.free_masks(nid, 0)
                okm = [fr[0] & top_ok, fr[1] & bot_ok]
                print(f"   gnd island ({cx:.1f},{cy:.1f}) L{li}: src {len(src)} ok {sum(1 for c in src if okm[c[2]][c[1], c[0]])}, "
                      f"dst {len(dst)} ok {sum(1 for c in dst if okm[c[2]][c[1], c[0]])} -> {path is not None}")
            added = []
            if path is not None:
                _commit_path(board, pr, "GND", path, added)
                print(f"  GND island at ({cx:.2f}, {cy:.2f}) routed to the pour")
                fixed += 1
                progress = True
                break
            # corridor: path on a board without movable signal copper nearby;
            # a net that cannot be re-joined is kept fixed on the next try
            keep = set()
            for _try in range(5):
                others = []
                for t in board.GetTracks():
                    n = t.GetNetname()
                    if not n or n == "GND" or n in keep or _is_hand(t, protect):
                        continue
                    _ls, g, _r = _geom(t)
                    if min(g[0], g[2]) > cx + win or max(g[0], g[2]) < cx - win or                        min(g[1], g[3]) > cy + win or max(g[1], g[3]) < cy - win:
                        continue
                    others.append(t)
                np_ = pr.np
                soft = [np_.zeros(R.X.shape, np_.float32), np_.zeros(R.X.shape, np_.float32)]
                for t in others:
                    ls, g, r = _geom(t)
                    cells = R.cells_in(("seg", g[0], g[1], g[2], g[3], r + CLR + W_SIG / 2))
                    if not cells:
                        continue
                    ii = np_.array([c[0] for c in cells])
                    jj = np_.array([c[1] for c in cells])
                    for l in ls:
                        soft[l][jj, ii] += 15.0
                for t in others:
                    board.RemoveNative(t)
                sync_router(pr, board)
                path = hard_route(pr, "GND", src, dst, soft=soft)
                for t in others:
                    board.Add(t)
                sync_router(pr, board)
                if path is None:
                    if os.environ.get("POD_DEBUG_GND"):
                        print(f"   corridor (keeping {sorted(keep)}): no path")
                    break
                lift = {}
                segs, vias = path
                geo = [((l,), (x0, y0, x1, y1), w / 2) for (x0, y0, x1, y1, w, l) in segs] +                       [((0, 1), (x, y, x, y), VIA_D / 2) for (x, y) in vias]
                for t in others:
                    ls, g, r = _geom(t)
                    for pls, pg, prr in geo:
                        if set(ls) & set(pls) and seg_seg_dist(g, pg)[0] < r + prr + CLR + 0.05:
                            lift.setdefault(t.GetNetname(), []).append(t)
                            break
                snap = _snapshot(board)
                removed = [t for items in lift.values() for t in items]
                for t in removed:
                    detach(board, t)
                added = []
                _commit_path(board, pr, "GND", path, added)
                sync_router(pr, board)
                ok, bad = True, None
                for n in sorted(lift):
                    if not _join_net(board, pr, n, added):
                        sync_router(pr, board)
                        if micro_join(board, pr, [n], added=added, quiet=True):
                            sync_router(pr, board)
                            if phase4(board, pr, [n]):
                                ok, bad = False, n
                                break
                if ok:
                    print(f"  GND island at ({cx:.2f}, {cy:.2f}) routed to the pour, lifting {sorted(lift)}")
                    fixed += 1
                    progress = True
                    break
                if os.environ.get("POD_DEBUG_GND"):
                    print(f"   corridor: lifted {sorted(lift)}, re-join failed at {bad}")
                _restore(board, snap)
                sync_router(pr, board)
                keep.add(bad)
            if progress:
                break
        if not progress:
            break
    filler.Fill(board.Zones())
    isl, find, main = _gnd_islands(board)
    left = [k for k in range(len(isl)) if find(k) != main]
    print(f"GND routing: {fixed} island(s) joined, {len(left)} still apart")
    return fixed


# ---------------------------------------------------------------------------
# 4g. Local GND fixes. The IMU and its caps sit in the busiest part of the
#     band between U1 and the GNSS keep-out; after routing, their GND pads end
#     up on pour islands. For each box below: lift every movable (non-hand,
#     non-GND) piece of copper inside it, lay the listed GND copper, then
#     re-join every lifted net (hard-rule A*, micro joins, local rip-up).
#     All-or-nothing: the board is restored exactly if any net stays split.
# ---------------------------------------------------------------------------
LOCAL_GND_FIXES = []       # (name, box, gnd tracks, gnd vias); now covered by GND_RESERVE


def box_reroute(board, pr, name, box, gtracks, gvias):
    protect = hand_segment_keys()
    snap = _snapshot(board)
    lift = _items_in_window(board, box, protect, set())
    nets = sorted(lift)
    orders = [sorted(nets, key=lambda n: (n not in spec.POWER_NETS, n))]
    failed_before = []
    for attempt in range(4):
        if attempt:
            _restore(board, snap)
            lift = _items_in_window(board, box, protect, set())
        for items in lift.values():
            for t in items:
                detach(board, t)
        for w, l, pts in gtracks:
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                add_track(board, "GND", x0, y0, x1, y1, w, l)
        add_vias(board, "GND", gvias)
        sync_router(pr, board)
        order = orders[-1]
        left = [n for n in order if not _join_net(board, pr, n, [])]
        if left:
            sync_router(pr, board)
            left = micro_join(board, pr, left, quiet=True)
        if left:
            sync_router(pr, board)
            left = phase4(board, pr, left)
        split = [n for n in nets if len(net_clusters(board, n)) > 1]
        if not split:
            print(f"  local GND fix {name}: done, lifted and re-joined {nets}")
            return True
        print(f"  local GND fix {name}: order {order} left {split} split")
        if attempt == 0:
            # second try: negotiated congestion over everything that is split
            negotiated_repair(pr, board, rounds=25)
            left = phase3(board, pr)
            if left:
                left = phase4(board, pr, left)
            if left:
                left = micro_join(board, pr, left)
            split_all = [n for n in sorted(spec.NETS) if n != "GND" and len(net_clusters(board, n)) > 1]
            if not split_all:
                print(f"  local GND fix {name}: done after a negotiated re-route")
                return True
            print(f"  local GND fix {name}: negotiated re-route left {split_all} split")
            _restore(board, snap)
            lift = _items_in_window(board, box, protect, set())
            for items in lift.values():
                for t in items:
                    detach(board, t)
            for w, l, pts in gtracks:
                for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                    add_track(board, "GND", x0, y0, x1, y1, w, l)
            add_vias(board, "GND", gvias)
            sync_router(pr, board)
        # next: the nets that failed go first (they need the free room most)
        failed_before = [n for n in split if n not in failed_before] + failed_before
        nxt = failed_before + [n for n in orders[0] if n not in failed_before]
        if nxt in orders:
            nxt = list(reversed(orders[0]))
            if nxt in orders:
                break
        orders.append(nxt)
    print(f"  local GND fix {name}: could not re-join; restored")
    _restore(board, snap)
    sync_router(pr, board)
    return False


def hard_route(pr, net, src, dst, soft=None):
    """soft: optional per-layer extra cell costs (movable copper to avoid)."""
    R = pr.R
    nid = pr.nid[net]
    # late joins: the U2 supply branches are hand lanes, so 3V3 is ordinary here
    top_ok, bot_ok, via_ok = pr.conn_region(net, [])
    free = R.free_masks(nid, 0)
    okm = [free[0] & top_ok, free[1] & bot_ok]
    vf = R.free_masks(nid, 1)
    vok = vf[0] & vf[1] & via_ok & ~R.via_forbid & top_ok & bot_ok
    src = [c for c in src if okm[c[2]][c[1], c[0]]]
    dst = [c for c in dst if okm[c[2]][c[1], c[0]]]
    if not src or not dst:
        return None
    ok = [okm[0].ravel().tolist(), okm[1].ravel().tolist()]
    cost = [pr.penalty[0].ravel().tolist(), pr.penalty[1].ravel().tolist()]
    vpen = pr.via_pen_gnss.ravel().tolist() if net in spec.GNSS_NETS else None
    if soft is not None:
        cost = [(pr.penalty[l] + soft[l]).ravel().tolist() for l in (0, 1)]
        vs = soft[0] + soft[1]
        vpen = (vs + (pr.via_pen_gnss if net in spec.GNSS_NETS else 0)).ravel().tolist()
    path = astar2(R.nx, R.ny, ok, cost, vok.ravel().tolist(), vpen, src, dst, bot_cost=BOT_COST, via_cost=10.0)
    if not path:
        return None
    w = W_TAP if net in spec.POWER_NETS else W_SIG
    segs, vias = [], []
    runs, cur = [], [path[0]]
    for c in path[1:]:
        if c[2] != cur[-1][2]:
            runs.append(cur)
            vias.append((c[0] * R.res, c[1] * R.res))
            cur = [c]
        else:
            cur.append(c)
    runs.append(cur)
    for run in runs:
        l = run[0][2]
        pts = [(c[0], c[1]) for c in run]
        simp = R.simplify(pts, l, okm[l]) if len(pts) > 2 else pts
        for a, b in zip(simp, simp[1:]):
            segs.append((a[0] * R.res, a[1] * R.res, b[0] * R.res, b[1] * R.res, w, l))
    return segs, vias


# ---------------------------------------------------------------------------
# 4d. Negotiated repair on top of the Freerouting result: nets that are still
#     split are rerouted by the negotiated-congestion router; any net they
#     collide with is ripped and rerouted too, until nothing conflicts.
#     Hand-routed copper (U2_ESCAPES, HAND_EXTRA) stays fixed.
# ---------------------------------------------------------------------------
def hand_segment_keys():
    keys = set()
    for net, w, pts in U2_ESCAPES:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            keys.add((net, round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2), 0))
    for _g, net, w, l, pts in HAND_EXTRA:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            keys.add((net, round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2), l))
    vias = {(net, round(x, 2), round(y, 2)) for net, x, y in HAND_VIAS}
    return keys, vias


def negotiated_repair(pr, board, rounds=40, bot_cost=None):
    np = pr.np
    bot_cost = BOT_COST if bot_cost is None else bot_cost
    R = pr.R
    hk, hv = hand_segment_keys()
    # router state from scratch: static = pads + keep-outs + thermal + hand copper
    R.lab = [[a.copy() for a in lk] for lk in pr.base_lab]
    R.via_forbid = pr.base_vf.copy()
    for _g, net, w, l, pts in HAND_EXTRA:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            R.add_obstacle(("seg", x0, y0, x1, y1, w / 2), [l], pr.nid[net])
    for net, x, y in HAND_VIAS:
        R.add_obstacle(("seg", x, y, x, y, VIA_D / 2), [0, 1], pr.nid[net])
        R.forbid_vias(("seg", x, y, x, y, VIA_DRILL / 2), extra=0.3)
    # GND copper already on the board (thermal, reserve, local GND fixes) is fixed
    for t in board.GetTracks():
        if t.GetNetname() != "GND":
            continue
        ls, g, r = _geom(t)
        R.add_obstacle(("seg", g[0], g[1], g[2], g[3], r), list(ls), pr.nid["GND"])
        if t.GetClass() == "PCB_VIA":
            R.forbid_vias(("seg", g[0], g[1], g[0], g[1], VIA_DRILL / 2), extra=0.3)
    pr.comp, pr.cells = {}, {}
    pr.hand_components()
    pr.snapshot_static()
    R.lab = pr.static_lab
    R.via_forbid = pr.static_vf
    pr.occ_tot = [[np.zeros(R.X.shape, np.int16) for _ in range(2)] for _ in range(2)]
    pr.occ_net = {}
    pr.net_tracks, pr.net_vias = {}, {}
    for t in board.GetTracks():
        n = t.GetNetname()
        if not n or n == "GND":
            continue
        if t.GetClass() == "PCB_VIA":
            x, y = pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)
            if (n, round(x, 2), round(y, 2)) in hv:
                continue
            pr.net_vias.setdefault(n, []).append((x, y))
            pr.occ_add(n, ("seg", x, y, x, y, VIA_D / 2), [0, 1], 1)
        else:
            x0, y0 = pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y)
            x1, y1 = pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y)
            w = pcbnew.ToMM(t.GetWidth())
            l = 0 if t.GetLayer() == pcbnew.F_Cu else 1
            if (n, round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2), l) in hk:
                continue
            pr.net_tracks.setdefault(n, []).append((x0, y0, x1, y1, w, l))
            pr.occ_add(n, ("seg", x0, y0, x1, y1, w / 2), [l], 1)
    conns = pr.connections()
    by_net = {}
    for c in sorted(conns, key=lambda c: c[0]):
        by_net.setdefault(c[1], []).append(c)
    nets = sorted(by_net)
    for net in pr.terms:
        pr.init_net(net)

    def split_nets():
        out = []
        for net in nets:
            grps = net_clusters(board_view, net)
            idx_of = {}
            for gi, grp in enumerate(grps):
                for kind, g, layers in grp:
                    if kind != "pad":
                        continue
                    for ti, t in enumerate(pr.terms[net]):
                        if any(sh == g for _p, _ls, sh in t["pads"]):
                            idx_of[ti] = gi
            if len(set(idx_of.values())) > 1 or len(idx_of) < len(pr.terms[net]):
                out.append(net)
        return out
    board_view = board
    hist = [np.zeros(R.X.shape, np.float32), np.zeros(R.X.shape, np.float32)]
    pres = 2.0
    todo = split_nets()
    print(f"  repair: {len(todo)} split nets {todo}")
    hard = set()
    conf = {}
    for rnd in range(rounds):
        for net in todo:
            pr.rip_neg(net)
            okn = True
            for conn in by_net.get(net, []):
                _, _, ia, ib = conn
                ca, cb = pr.comp[(net, ia)], pr.comp[(net, ib)]
                if ca == cb:
                    continue
                keys = (pr.terms[net][ia]["keys"], pr.terms[net][ib]["keys"])
                got = pr.connect_neg(net, pr.cells[ca], pr.cells[cb], keys, pres, hist, bot_cost)
                if got is None:
                    okn = False
                    continue
                pr.cells[ca] |= got
                pr.merge(net, ca, cb)
            (hard.discard if okn else hard.add)(net)
        conf = pr.geo_conflicts()
        print(f"  repair round {rnd + 1}: {len(conf)} nets in conflict {sorted(conf)[:12]}, {len(hard)} unroutable", flush=True)
        if not conf and not hard:
            break
        for cc in conf.values():
            for (i, j, l) in cc:
                hist[l][j, i] += NEG_HIST
        pres *= NEG_GROWTH
        todo = sorted(set(conf) | hard)
    if rounds == 0:
        conf = pr.geo_conflicts()
    elif os.environ.get("POD_CKPT"):
        # checkpoint (all copper incl. the conflicts) for POD_RESUME runs
        _repair_writeback(pr, board, hk, hv)
        pcbnew.SaveBoard(os.environ["POD_CKPT"], board)
    # leftover conflicts: rip the fewest nets that clear them (greedy: the net
    # in most conflicting pairs first, signals before supply nets, which are
    # wide and hard to re-thread); phase 3 then rejoins them hard-rule.
    while conf:
        cnt = {}
        for a, b, *_ in pr.last_pairs:
            cnt[a] = cnt.get(a, 0) + 1
            cnt[b] = cnt.get(b, 0) + 1
        sig = [n for n in sorted(cnt) if n not in spec.POWER_NETS]
        if True:
            # lift just the offending pieces of one net (signals before
            # supplies); the rest stays, phases 3/4 re-join the pieces
            worst = max(sig or sorted(cnt), key=lambda n: cnt[n])
            bad = {it for pair in pr.last_items for it in pair if it[0] == worst}
            keep_t, keep_v = [], []
            for (x0, y0, x1, y1, w, l) in pr.net_tracks.get(worst, []):
                if (worst, l, x0, y0, x1, y1, w / 2) in bad:
                    pr.occ_add(worst, ("seg", x0, y0, x1, y1, w / 2), [l], -1)
                else:
                    keep_t.append((x0, y0, x1, y1, w, l))
            for (x, y) in pr.net_vias.get(worst, []):
                if any((worst, l, x, y, x, y, VIA_D / 2) in bad for l in (0, 1)):
                    pr.occ_add(worst, ("seg", x, y, x, y, VIA_D / 2), [0, 1], -1)
                else:
                    keep_v.append((x, y))
            pr.net_tracks[worst], pr.net_vias[worst] = keep_t, keep_v
            print(f"  repair: lifted {len(bad)} pieces of {worst}")
            conf = pr.geo_conflicts()
            continue
        worst = max(sig, key=lambda n: cnt[n])
        pr.rip_neg(worst)
        pr.net_tracks.pop(worst, None)
        pr.net_vias.pop(worst, None)
        print(f"  repair: ripped {worst} ({cnt[worst]} conflicting pairs: "
              f"{[q for q in pr.last_pairs if worst in q[:2]][:4]})")
        conf = pr.geo_conflicts()
    _repair_writeback(pr, board, hk, hv)
    return sorted(conf) + sorted(hard)


def _repair_writeback(pr, board, hk, hv):
    """Replace all non-hand, non-GND copper on the board with the router's."""
    for t in list(board.GetTracks()):
        n = t.GetNetname()
        if not n or n == "GND":
            continue
        if t.GetClass() == "PCB_VIA":
            x, y = pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)
            if (n, round(x, 2), round(y, 2)) in hv:
                continue
        else:
            key = (n, round(pcbnew.ToMM(t.GetStart().x), 2), round(pcbnew.ToMM(t.GetStart().y), 2),
                   round(pcbnew.ToMM(t.GetEnd().x), 2), round(pcbnew.ToMM(t.GetEnd().y), 2),
                   0 if t.GetLayer() == pcbnew.F_Cu else 1)
            if key in hk:
                continue
        detach(board, t)
    for net, lst in pr.net_tracks.items():
        for (x0, y0, x1, y1, w, l) in lst:
            add_track(board, net, x0, y0, x1, y1, w, l)
    for net, lst in pr.net_vias.items():
        add_vias(board, net, lst)


def main():
    footprints.write_all()
    if os.environ.get("POD_RESUME"):
        return finish(pcbnew.LoadBoard(os.environ["POD_RESUME"]), resume=True)
    if os.path.exists(OUT_PCB):
        os.remove(OUT_PCB)
    board = pcbnew.CreateEmptyBoard()
    board.SetCopperLayerCount(2)
    add_outline(board)
    fps = place(board)
    assign_nets(board, fps)
    self_check(board)
    ok = place_check(fps)
    if os.environ.get("PLACE_ONLY"):
        pcbnew.SaveBoard(OUT_PCB, board)
        print("placement-only board saved")
        return
    if not ok:
        raise SystemExit(3)

    for ref in ("SW1", "SW2"):
        # TS-1187A: A-B and C-D are shorted inside the switch (drawing, see
        # docstring): KiCad treats the duplicate pad numbers as one jumpered pad.
        fps[ref].SetDuplicatePadNumbersAreJumpers(True)
    design_rules(board)

    # phase 1: GNSS nets + power trunks (autoroute.Router)
    pr = PodRouter(board, fps)
    order1 = phase1_order(pr)
    failed1 = pr.negotiate(order1)
    print(f"phase 1: {len(order1)} connections, {len(failed1)} unrouted "
          f"{sorted({c[1] for c in failed1})}")
    commit_routes(board, pr, pr.thermal, [])
    add_hand_copper(board)
    add_gnd_reserve(board)
    # phase 2: everything else (Freerouting session)
    freerouting_phase(board, fps)
    # thermal vias are GND and GND is not in the Freerouting design: re-add if dropped
    have = [(pcbnew.ToMM(v.GetPosition().x), pcbnew.ToMM(v.GetPosition().y))
            for v in board.GetTracks() if v.GetClass() == "PCB_VIA"]
    missing = [(x, y) for x, y in pr.thermal if not any(math.hypot(x - a, y - b) < 0.05 for a, b in have)]
    add_vias(board, "GND", missing)
    add_gnd_reserve(board)
    # phase 3: close what Freerouting left open (negotiated repair, then a
    # last hard-constraint pass)
    negotiated_repair(pr, board)
    finish(board, fps, pr)


def finish(board, fps=None, pr=None, resume=False):
    if resume:
        # POD_RESUME: continue from a POD_CKPT checkpoint (board after the
        # negotiated repair, before its leftover rip-up)
        fps = {fp.GetReference(): fp for fp in board.GetFootprints()}
        for ref in ("SW1", "SW2"):
            fps[ref].SetDuplicatePadNumbersAreJumpers(True)
        design_rules(board)
        pr = PodRouter(board, fps)
        negotiated_repair(pr, board, rounds=0)
    left = phase3(board, pr)
    if left:
        left = phase4(board, pr, left)
    if left:
        left = micro_join(board, pr, left)
    if left:
        print(f"ROUTING INCOMPLETE: {left}")
    for name, box, gtracks, gvias in LOCAL_GND_FIXES:
        box_reroute(board, pr, name, box, gtracks, gvias)
    # Freerouting necks tracks down to 0.15 mm at fine-pitch pads: restore the
    # spec's 0.2 mm minimum (the pads are wide enough for a centred 0.2 mm track)
    for t in board.GetTracks():
        if t.GetClass() == "PCB_TRACK" and t.GetWidth() < MM(0.2):
            t.SetWidth(MM(0.2))
    # GND stage
    sync_router(pr, board)
    drops, stubs, stitch = place_gnd_vias(pr, fps)
    add_vias(board, "GND", drops + stitch)
    for x0, y0, x1, y1 in stubs:
        add_track(board, "GND", x0, y0, x1, y1, 0.3, 0)
    design_rules(board)
    add_zones(board, {n: board.FindNet(n) for n in spec.NETS})
    fab_drawings(board)
    silkscreen(board, fps)
    board.BuildConnectivity()
    filler = pcbnew.ZONE_FILLER(board)
    filler.Fill(board.Zones())
    stitch_gnd_islands(board, pr)
    if gnd_lift(board, pr):
        stitch_gnd_islands(board, pr)
    gnd_route(board, pr)
    stitch_two_hop(board, pr)
    cleanup_dangling(board)
    filler.Fill(board.Zones())
    board.BuildConnectivity()
    self_check(board)
    post_checks(board, pr)
    pcbnew.SaveBoard(OUT_PCB, board)
    print(f"Wrote {OUT_PCB}")


def net_span(pr, net):
    ts = pr.terms.get(net, [])
    if not ts:
        return 0
    xs = [t["pos"][0] for t in ts]
    ys = [t["pos"][1] for t in ts]
    return (max(xs) - min(xs)) + (max(ys) - min(ys))


# Nets routed first, in this order: the USB pair (short, symmetric), then the
# GNSS supply (series-resistance limit), then the rest by span.
ROUTE_FIRST = ["USB_DN_C", "USB_DP_C", "USB_DN", "USB_DP"]


def route_all(board, fps, max_attempts=10):
    import time
    probe = PodRouter(board, fps)
    conns = probe.connections()
    # shortest first; USB pair and power connections get priority
    def key(c):
        # USB pair, then the GNSS nets (top only, no vias in Z1: must go before
        # the west-east crossings), then everything else shortest-first.
        L, net, ia, ib = c
        keys = probe.terms[net][ia]["keys"] + probe.terms[net][ib]["keys"]
        u2 = any(k.startswith("U2.") for k in keys)
        grp = 0 if u2 else (1 if net in ROUTE_FIRST else (2 if net in spec.GNSS_NETS and net != "3V3" else 3))
        tk = 0
        if net in spec.POWER_NETS:
            ka, kb = probe.terms[net][ia]["keys"], probe.terms[net][ib]["keys"]
            tr = TRUNK.get(net, ())
            tk = 0 if (any(k in tr for k in ka) and any(k in tr for k in kb)) else 1
        return (grp, tk, L, net, c[2], c[3])
    order = sorted(conns, key=key)
    best = None
    for attempt in range(max_attempts):
        t0 = time.time()
        pr = PodRouter(board, fps)
        failed = pr.negotiate(order)
        names = sorted({f"{c[1]}:{pr.terms[c[1]][c[3]]['keys'][0]}" for c in failed})
        print(f"routing attempt {attempt + 1}: {len(failed)} failed {names} ({time.time() - t0:.0f}s)")
        if best is None or len(failed) < len(best[1]):
            best = (pr, failed)
        if not failed:
            return pr
        order = failed + [c for c in order if c not in failed]
    print("ROUTING INCOMPLETE:", len(best[1]))
    return best[0]


def commit_routes(board, pr, gnd_vias=(), gnd_stubs=()):
    netinfo = board.GetNetInfo()
    gnd = netinfo.GetNetItem("GND")
    for x, y in gnd_vias:
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
        v.SetWidth(MM(VIA_D))
        v.SetDrill(MM(VIA_DRILL))
        v.SetNet(gnd)
        board.Add(v)
    for x0, y0, x1, y1 in gnd_stubs:
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(pcbnew.VECTOR2I(MM(x0), MM(y0)))
        t.SetEnd(pcbnew.VECTOR2I(MM(x1), MM(y1)))
        t.SetWidth(MM(0.3))
        t.SetLayer(pcbnew.F_Cu)
        t.SetNet(gnd)
        board.Add(t)
    for x0, y0, x1, y1, w, l, net in pr.out_tracks:
        if abs(x0 - x1) < 1e-9 and abs(y0 - y1) < 1e-9:
            continue
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(pcbnew.VECTOR2I(MM(x0), MM(y0)))
        t.SetEnd(pcbnew.VECTOR2I(MM(x1), MM(y1)))
        t.SetWidth(MM(w))
        t.SetLayer(pcbnew.F_Cu if l == 0 else pcbnew.B_Cu)
        t.SetNet(netinfo.GetNetItem(net))
        board.Add(t)
    for x, y, net in pr.out_vias:
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
        v.SetWidth(MM(VIA_D))
        v.SetDrill(MM(VIA_DRILL))
        v.SetNet(netinfo.GetNetItem(net))
        board.Add(v)


if __name__ == "__main__":
    main()
