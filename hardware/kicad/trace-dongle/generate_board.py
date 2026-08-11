#!/usr/bin/env python3
"""
TRACE OBD Telemetry Dongle -- PCB generator (KiCad 10 / pcbnew scripting).

Builds hardware/kicad/trace-dongle/trace-dongle.kicad_pcb from scratch, from
the BINDING netlist in hardware/DESIGN.md section 3 (component selection in
section 2, PCB constraints in section 4), AS AMENDED by DESIGN.md sections 7
and 8. Deterministic: delete + re-run reproduces the same board.

Run with KiCad 10's bundled Python (has the pcbnew module):
    "C:\\Users\\dobri\\AppData\\Local\\Programs\\KiCad\\10.0\\bin\\python.exe" generate_board.py

REV A3 CHANGES (DESIGN.md sec8, NO-GO remediation -- see ticket report for
full rationale and the live datasheet/LCSC citations behind every value
below; nothing here is from memory, per the ledger rule):
  - U3 TPS54202DDCR pin map CORRECTED AGAIN: sec7's map was *also* wrong
    (LEAD had it from memory). Verified against the live TI datasheet
    (DDC/SOT-23-6 pinout table): 1=GND, 2=SW, 3=VIN, 4=FB, 5=EN, 6=BOOT.
  - U2 CAN transceiver REPLACED: TJA1051T/3 (needs 4.5-5.5V VCC; this
    design has only one 3.3V rail) -> TCAN330DR. Pin map verified against
    the live TI datasheet: 1=TXD, 2=GND, 3=VCC, 4=RXD, 5=SHDN, 6=CANL,
    7=CANH, 8=S -- note pins 5/8 are SWAPPED from what the remediation
    ticket proposed (it said 5=S,8=SHDN); the ticket's map was itself an
    unverified from-memory guess and was wrong. SHDN(5)->GND (device
    stays enabled), S(8)->IO6 (unchanged firmware hw listen-only control
    -- TCAN330DR's S pin is functionally identical to TJA1051T/3's).
    Pins 1/2/3/4/6/7 (TXD/GND/VCC/RXD/CANL/CANH) are numerically IDENTICAL
    between the two parts, so only pin 5's net membership changes
    (3V3->GND) and the old VCC<->VIO jumper route is removed (would now
    short VCC to GND).
  - D2 (Schottky) ROTATED 180 degrees so pad 1 (cathode, KiCad D_SMB
    convention) faces VIN_PROT and pad 2 (anode) faces the fused input --
    was reversed, blocking forward current from the battery.
  - D1 (TVS) MOVED: now clamps NET_FUSED (right at F1's output, before
    D2) instead of VIN_PROT, so it also clamps negative pulses via
    forward conduction; value changed SMBJ24A -> SMBJ18A (18V standoff >
    14.4V nominal, 29.2V clamp <= TPS54202's 30V Vin abs max -- verified
    against both the live TI and LCSC-hosted TVS datasheets).
  - LED1/LED2 polarity fixed: KiCad LED_0603 pad 1 = cathode (verified
    against the same convention already confirmed for D_SMB/PESD2CANFD);
    the board had pad 1 wired to the series resistor and pad 2 to GND,
    reversed, which would leave both LEDs dark.
  - LED2 moved off strapping pin IO8 -> IO7 (non-strapping); IO8 now
    carries only a new 10k pullup (R10) to guarantee a HIGH boot-mode
    level for J2 UART flashing.
  - C1/C2 (buck input caps): 22uF/35V in 0603 was never a real part.
    Real 10uF/50V X7R chip caps only exist in 1210+ (verified on LCSC) --
    footprint grown 0603->1210. C3/C4 (output caps) grown 0603->0805 for
    the real 22uF/10V X7R part. Every downstream component (rest of the
    buck section + the whole U1 cluster) is translated by REV_A3_SHIFT so
    the wave-2 layout's internal geometry (routes, clearances) is
    preserved exactly; only the C1<->C2 gap and the C3/C4 footprints
    actually change shape. Board width grown 62->68mm to keep the U1
    cluster inside the outline after the shift.
  - EVERY LCSC part number in the BOM is now real and stock-verified
    (several of the sec7 numbers were flat wrong: U3's pointed at an
    unrelated resistor, F1's at a THT electrolytic cap, L1's at a 3.3uH
    inductor not 10uH, SW1's at a 4-pad top-actuated switch not the
    2-pad side-actuated part the footprint expects, D3's didn't exist at
    all, U1's was the external-antenna -1U variant not the on-board-
    antenna -N4 the board is laid out for). See ticket report for the
    LCSC URL behind each one.
  - Antenna keepout (item 10): a real both-layer copper keepout/rule-area
    zone under U1's antenna end, per the module datasheet's "no copper
    under antenna" guidance -- absent before (only a text comment
    existed on the footprint, no enforced KiCad object).

WAVE 2 CHANGES (kept for history -- see ticket report for full rationale):
  - Board envelope raised to 62 x 30mm (DESIGN.md sec7, now 68x30 after
    rev A3's C1/C2/C3/C4 footprint growth above).
  - Full re-placement clustering every U1-local net's components next to
    U1, leaving CAN_TX/RX/S as the only genuine long-haul nets, routed
    through a dedicated component-free B.Cu corridor along the top edge.
  - U1 castellated pads (numbers 1-48) get a local 0.15mm clearance
    override; everywhere else keeps the board's global 0.2mm minimum.

Footprint substitutions / constructions (unchanged from wave 1/2 -- see
that report for the full list; summarised here for anyone reading the
script):
  - ESP32-C3-MINI-1: hardware/kicad/trace-dongle/fp-lib/TRACE-Custom.pretty/
    ESP32-C3-MINI-1.kicad_mod is CONSTRUCTED (see that file's `descr`).
  - L1 10uH shielded 0630 (LCSC C167223): L_APV_APH0630 (closest 6.8mm
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
#    Layout (68 x 30mm board, rev A3), left to right:
#      x  2-24: J1 (OBD pad row) + CAN transceiver cluster (U2/D3/R9/C9) --
#               CANH/CANL stay short and local to this cluster per DESIGN
#               sec4; SW1 is explicitly NOT here (amendment). UNMOVED from
#               wave 2, including F1/D2/D1 (the protection chain feeding
#               the buck section starts here too).
#      x 24-46: buck section (C1/C2/U3/C5/L1/C3/C4/R3/R4/R1/R2) -- every
#               component from C1 onward is translated +REV_A3_SHIFT in X
#               versus wave 2's layout, to make room for C1/C2 growing
#               0603->1210 and C3/C4 growing 0603->0805 (rev A3 item 8:
#               22uF/35V and the old 22uF/10V values were never real parts
#               in 0603). The translation preserves wave-2's DRC-clean
#               internal geometry exactly -- only the C1<->C2 gap and the
#               C3/C4 footprint shape actually change.
#      x 46-68: U1 + every net that is U1-local (also +REV_A3_SHIFT).
#               New: R10, a 10k pullup keeping IO8 HIGH at boot now that
#               LED2 has moved off it onto IO7 (item 7).
#    A dedicated, component-free B.Cu corridor near the top edge carries
#    the three CAN_TX/RX/S trunk lines from U1's left edge to U2, clear of
#    every other footprint and every other track on the board.
# ---------------------------------------------------------------------------
REV_A3_SHIFT = 5.0  # mm; see module docstring and the comment above

PLACEMENTS = [
    # -- CAN cluster + J1 (unmoved) --
    ("J1",  lib("Connector_PinHeader_2.54mm"), "PinHeader_1x05_P2.54mm_Vertical", 4.0, 10.0, 0),
    ("U2",  lib("Package_SO"),                 "SOIC-8_3.9x4.9mm_P1.27mm",        13.0, 18.0, 0),
    ("D3",  lib("Package_TO_SOT_SMD"),         "SOT-23",                          19.5, 18.0, 0),
    ("R9",  lib("Resistor_SMD"),               "R_0603_1608Metric",               19.5, 21.5, 90),
    ("C9",  lib("Capacitor_SMD"),              "C_0603_1608Metric",               8.0, 15.0, 90),

    # -- protection chain (unmoved; D2 rotated 180 deg for correct
    #    polarity -- rev A3 item 5) --
    # rev A4: footprint grown 0603->0805 -- C910821 (24V-rated replacement
    # for the 16V C910820) is only stocked in 0805 (see LCSC dict below).
    ("F1",  lib("Fuse"),                        "Fuse_0805_2012Metric",            6.5, 6.0, 0),
    ("D2",  lib("Diode_SMD"),                    "D_SMB",                          13.0, 6.0, 180),
    ("D1",  lib("Diode_SMD"),                    "D_SMB",                          13.0, 11.5, 0),

    # -- buck section, downstream of D1/D2 (+REV_A3_SHIFT; C1/C2/C3/C4
    #    footprints grown per item 8) --
    ("C1",  lib("Capacitor_SMD"),                "C_1210_3225Metric",              20.0, 6.0, 0),
    # rev A4 (C2 finding): moved off the C1<->C2 row and placed immediately
    # west of U3's own VIN pin (pin 3, verified at X=34.8625/Y=6.95 once
    # placed -- see the VIN_PROT route below) so it is the closest bypass
    # cap to VIN/GND, per TI's close-placement guidance. Rotated 270 so
    # pad 1 (VIN_PROT) lands at U3.3's own Y for a short direct F.Cu hop;
    # pad 2 (GND) lands south, clear of U3's courtyard. R3/R4 (below) moved
    # west out of this corridor to make room.
    ("C2",  lib("Capacitor_SMD"),                "C_1210_3225Metric",              31.8, 8.425, 270),
    # C5 (bootstrap cap) placed SOUTH of U3, rotated 90deg so its two pads
    # stack in Y instead of X -- verified TI pin geometry put SW/pin2 and
    # BOOT/pin6 on diagonally opposite corners of the chip (not adjacent,
    # as the old wrong pin map assumed), and the narrow 1.5mm gap directly
    # between U3 and L1's own (much larger) courtyard has no room for C5
    # at all. South of U3 (not north/above the CAN B.Cu corridor) avoids
    # that corridor conflicting with BST_NODE/SW_NODE's own B.Cu spans.
    ("C5",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              36.5, 9.8, 90),
    # rev A4: shifted west 4mm (32->28) out of the corridor directly west
    # of U3, which C2 (above) now occupies. Same Y positions, same
    # rotation -- only X changes.
    ("R3",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              28.0, 9.0, 90),
    ("R4",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              28.0, 12.5, 90),
    ("U3",  lib("Package_TO_SOT_SMD"),           "SOT-23-6",                       31.0 + REV_A3_SHIFT, 6.0, 0),
    ("L1",  lib("Inductor_SMD"),                 "L_APV_APH0630",                  39.0 + REV_A3_SHIFT, 6.0, 0),
    ("C3",  lib("Capacitor_SMD"),                "C_0805_2012Metric",              34.0 + REV_A3_SHIFT, 11.0, 0),
    ("C4",  lib("Capacitor_SMD"),                "C_0805_2012Metric",              38.0 + REV_A3_SHIFT, 13.0, 0),
    ("R1",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              41.0 + REV_A3_SHIFT, 12.0, 90),
    ("R2",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              41.0 + REV_A3_SHIFT, 15.2, 90),

    # -- U1 + local support (+REV_A3_SHIFT) --
    ("U1",  CUSTOM_FP,                            "ESP32-C3-MINI-1",                50.5 + REV_A3_SHIFT, 15.0, 270),
    ("C6",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              46.3 + REV_A3_SHIFT, 6.0, 0),
    ("C7",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              49.8 + REV_A3_SHIFT, 6.0, 0),
    ("C8",  lib("Capacitor_SMD"),                "C_0603_1608Metric",              53.3 + REV_A3_SHIFT, 6.0, 0),
    ("R5",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              56.8 + REV_A3_SHIFT, 6.0, 180),
    ("LED1", lib("LED_SMD"),                     "LED_0603_1608Metric",            33.0 + REV_A3_SHIFT, 18.2, 0),
    ("R7",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              35.5 + REV_A3_SHIFT, 18.2, 90),
    ("LED2", lib("LED_SMD"),                     "LED_0603_1608Metric",            39.0 + REV_A3_SHIFT, 18.2, 0),
    ("R8",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              42.5 + REV_A3_SHIFT, 18.2, 0),
    ("R6",  lib("Resistor_SMD"),                 "R_0603_1608Metric",              43.0 + REV_A3_SHIFT, 21.0, 90),
    # rev A4 (SW1 finding): footprint corrected to Panasonic_EVQPUL_EVQPUC,
    # the KiCad std-lib footprint family for EVQPUC02K/C79174 (was
    # EVQPUJ_EVQPUA, a different Panasonic side-tact variant with
    # incompatible pads) -- see LCSC dict below for the verification note.
    ("SW1", lib("Button_Switch_SMD"),            "Panasonic_EVQPUL_EVQPUC",        41.0 + REV_A3_SHIFT, 27.3, 0),
    ("J2",  lib("Connector_PinHeader_2.54mm"),   "PinHeader_1x06_P2.54mm_Vertical", 47.0 + REV_A3_SHIFT, 24.5, 90),
    # -- NEW (rev A3 item 7): IO8 pullup, keeps it HIGH at boot now that
    #    LED2 (below) moved off it onto IO7. Placed WEST of U1's own
    #    courtyard (which spans X:[U1.x-6.0, U1.x+11.4] at this rotation --
    #    a first attempt placed it inside that box and shorted straight
    #    into U1's own unrelated pads) and south of the R7->R6 3V3 lane at
    #    Y=20.175 (a second attempt at Y=20.5 blocked that pre-existing
    #    route). Absolute position, NOT translated by REV_A3_SHIFT again.
    ("R10", lib("Resistor_SMD"),                 "R_0603_1608Metric",              44.5, 22.0, 0),
]

VALUES = {
    "J1": "OBD-II 5-pad fallback row (12V/GND/GND/CANH/CANL) -- hand-solder, TSW-105-07-T-S 1x5 header",
    "F1": "PTC 350mA 24V", "D2": "SS34B", "D1": "SMBJ18A",
    "C1": "10uF/50V X7R 1210", "C2": "10uF/50V X7R 1210", "U3": "TPS54202DDCR", "C5": "100nF (BST)",
    "L1": "10uH 2A shielded", "R3": "274k (EN div hi)", "R4": "44.2k (EN div lo)",
    "C3": "22uF/10V X7R 0805", "C4": "22uF/10V X7R 0805", "R1": "100k (FB div hi)", "R2": "22.1k (FB div lo)",
    "C6": "100nF (U1 3V3)", "C7": "10uF (U1 3V3)", "C8": "1uF (U1 EN)",
    "U2": "TCAN330DR", "D3": "PESD2CANFD24V-TR", "R9": "DNP (CAN term, not fitted)",
    "C9": "100nF (U2 VCC)", "U1": "ESP32-C3-MINI-1-N4",
    "R5": "10k (U1 EN pullup)", "R6": "10k (IO9/BOOT pullup)", "R10": "10k (IO8 pullup, boot-mode high)",
    "SW1": "BOOT tact", "LED1": "green (power)", "R7": "1k", "LED2": "amber/orange (activity)", "R8": "1k",
    "J2": "1x6 2.54mm UART header -- hand-solder, HTSW-106-07-T-S 1x6 header",
}

# Every LCSC number below is verified live (LCSC product page and/or the
# manufacturer datasheet hosted there) against the exact value/tolerance/
# package used -- see ticket report for the URL behind each one. Several
# of the wave-2 numbers this replaces were flatly wrong (wrong part
# entirely, wrong package, or nonexistent), not just unstocked.
LCSC = {
    "U1": "C2838502",  # ESP32-C3-MINI-1-N4 (on-board PCB antenna variant)
    "U2": "C2652876",  # TCAN330DR, 86 in stock
    "U3": "C191884",   # TPS54202DDCR
    "D1": "C151256",   # SMBJ18A, Littelfuse, SMB(DO-214AA)
    "D2": "C880746",   # SS34B, SMB(DO-214AA) -- matches the D_SMB footprint (plain SS34/C8678 was SMA)
    "D3": "C552486",   # PESD2CANFD24V-TR, Nexperia, SOT-23
    # rev A4 (NO-GO reverdict item F1): C910820 was only 16V-rated -- not
    # coordinated with the 18V-standoff SMBJ18A TVS or automotive load-dump/
    # jump-start transients. Replaced with C910821 (BSMD0805-035-24V,
    # BHFUSE): 24V max, 350mA hold, 750mA trip, 0805, 49,540 in stock --
    # https://www.lcsc.com/product-detail/C910821.html (footprint grown
    # 0603->0805 below to match).
    "F1": "C910821",   # 0805 PTC 350mA/24V (BHFUSE BSMD0805-035-24V)
    "L1": "C167223",   # 10uH 2A shielded (C167219 was a 3.3uH part)
    # rev A4 (SW1 finding): footprint switched to Panasonic_EVQPUL_EVQPUC
    # (matches the EVQPUC02K part family -- see PLACEMENTS below); C79174
    # itself re-verified in stock at https://www.lcsc.com/product-detail/C79174.html
    "SW1": "C79174",   # EVQPUC02K, side-actuated 2-pad SMD tact
    "C1": "C138687", "C2": "C138687",  # 10uF/50V X7R 1210
    "C3": "C907991", "C4": "C907991",  # 22uF/10V X7R 0805
    "C5": "C1591", "C6": "C1591", "C9": "C1591",  # 100nF/50V X7R 0603
    "C7": "C96446",  # 10uF/25V X5R 0603
    "C8": "C5673",   # 1uF/25V X5R 0603
    "R1": "C25803",  # 100k 1% 0603
    "R2": "C25961",  # 22.1k 1% 0603
    # rev A4 (UVLO hysteresis finding): 133k/24k gave only 0.337V hysteresis
    # (below TI's >0.5V recommendation). Re-solved the TPS54202 EN/UVLO
    # equations (Ip=0.7uA, Ih=1.55uA, VENrising=1.21V, VENfalling=1.19V,
    # TI datasheet SLVSD26C section 6.3.5) for E96 values in LCSC stock --
    # see ticket report for the math. R3=274k/R4=44.2k -> Vstart=8.519V,
    # Vstop=7.950V, hysteresis=0.569V (both targets met).
    "R3": "C22968",  # 274k 1% 0603, UNI-ROYAL 0603WAF2743T5E, 2,200 in stock
    "R4": "C23056",  # 44.2k 1% 0603, UNI-ROYAL 0603WAF4422T5E, 285,900 in stock
    "R5": "C2906982", "R6": "C2906982", "R10": "C2906982",  # 10k 1% 0603
    "R7": "C2907002", "R8": "C2907002",  # 1k 1% 0603
    "LED1": "C84267",  # green 0603
    "LED2": "C84269",  # orange/amber 0603
    # rev A4 (J1/J2 finding): replaced the generic C2337 1x40P cut-to-length
    # strip with exact-count, in-stock straight male headers (both
    # hand-solder THT, excluded from cpl.csv -- see generate_production_csv.py):
    # J1 -- https://www.lcsc.com/product-detail/C5967238.html (Samtec
    #   TSW-105-07-T-S, 1x5P, Through Hole P=2.54mm, 30 in stock)
    # J2 -- https://www.lcsc.com/product-detail/C6209271.html (Samtec
    #   HTSW-106-07-T-S, 1x6P, Through Hole P=2.54mm, 66 in stock)
    "J1": "C5967238", "J2": "C6209271",  # SW1 is also hand-solder THT/SMD-R/A
    # R9 stays DNP -- no LCSC number, not populated (matches production BOM convention).
}

# ---------------------------------------------------------------------------
# 2. Net -> pad membership (for net assignment; every pad below gets its net
#    set regardless of how it's routed).
#    GND is handled entirely by copper pour (both layers); no GND entries here.
#
#    U3 and U2 pin numbers below reflect the rev A3 pin maps VERIFIED
#    against the live TI datasheets (see module docstring) -- sec7's U3
#    map was ALSO wrong (a second from-memory error), and U2 is now a
#    different part (TCAN330DR) entirely.
# ---------------------------------------------------------------------------
POWER_NETS = {
    "12V_RAW":   [("J1", "1"), ("F1", "1")],
    # rev A3 item 6: D1 (TVS) moved here, right at F1's output, before D2 --
    # D2 pad 2 (anode, after the 180deg rotation -- item 5) also lands on
    # this node.
    "NET_FUSED": [("F1", "2"), ("D2", "2"), ("D1", "1")],
    # D2 pad 1 = cathode after the 180deg rotation, now correctly facing
    # VIN_PROT. U3 pin 3 = VIN (verified TI datasheet; sec7's pin 5 was
    # wrong too).
    "VIN_PROT":  [("D2", "1"), ("C1", "1"), ("C2", "1"), ("R3", "1"), ("U3", "3")],
    # rev A3 item 4: U2 pin 5 (was TJA1051T/3's VIO, now TCAN330DR's SHDN)
    # REMOVED from 3V3 -- SHDN ties to GND instead (see GND_PADS). R10
    # ADDED (new IO8 pullup, item 7).
    "3V3":       [("L1", "2"), ("R1", "1"), ("C3", "1"), ("C4", "1"),
                  ("C6", "1"), ("C7", "1"), ("U1", "3"), ("C9", "1"), ("U2", "3"),
                  ("R5", "2"), ("R6", "2"), ("R7", "1"), ("J2", "1"), ("R10", "2")],
}

SIGNAL_NETS = {
    # U3 pin map verified against the live TI TPS54202 DDC datasheet:
    # 1=GND, 2=SW, 3=VIN, 4=FB, 5=EN, 6=BOOT.
    "SW_NODE":   [("U3", "2"), ("C5", "2"), ("L1", "1")],
    "BST_NODE":  [("C5", "1"), ("U3", "6")],
    "FB_NODE":   [("U3", "4"), ("R1", "2"), ("R2", "1")],
    "EN_U3_NODE": [("U3", "5"), ("R3", "2"), ("R4", "1")],
    "U1_EN":     [("U1", "8"), ("R5", "1"), ("C8", "1"), ("J2", "6")],
    "IO9_BOOT":  [("U1", "23"), ("R6", "1"), ("SW1", "1"), ("J2", "5")],
    # U2 pin map verified against the live TI TCAN330 datasheet (SOIC-8):
    # 1=TXD, 2=GND, 3=VCC, 4=RXD, 5=SHDN, 6=CANL, 7=CANH, 8=S. Pins
    # 1/4/6/7/8 are numerically identical to TJA1051T/3's map, so CAN_TX/
    # RX/S/CANH/CANL below are unchanged from wave 2.
    "CAN_TX":    [("U1", "18"), ("U2", "1")],
    "CAN_RX":    [("U1", "19"), ("U2", "4")],
    "CAN_S":     [("U1", "20"), ("U2", "8")],
    # rev A3 item 7: LED2 moved off strapping pin IO8 (22) -> IO7 (21).
    "LED2_DRIVE": [("U1", "21"), ("R8", "2")],
    # NEW (item 7): IO8 (22) now carries only R10's pullup.
    "IO8_PU":    [("U1", "22"), ("R10", "1")],
    "TXD0":      [("U1", "31"), ("J2", "3")],
    "RXD0":      [("U1", "30"), ("J2", "4")],
    "CANH":      [("U2", "7"), ("D3", "2"), ("R9", "1"), ("J1", "4")],
    "CANL":      [("U2", "6"), ("D3", "1"), ("R9", "2"), ("J1", "5")],
    # rev A3 item 5: KiCad LED_0603 pad 1 = cathode (same convention as
    # D_SMB/PESD2CANFD, verified) -- was wired anode-to-resistor/cathode-
    # to-resistor-node (pad 1), which the GND_PADS list below then also
    # grounded, i.e. BOTH LED pads were tied together with no series path
    # to GND at all. Now: pad 2 (anode) -> resistor, pad 1 (cathode) -> GND.
    "LED1_TOP":  [("R7", "2"), ("LED1", "2")],
    "LED2_TOP":  [("R8", "1"), ("LED2", "2")],
}

# GND membership: only needed so we can mark the *pads* with the GND net
# (copper pour on F.Cu/B.Cu does the actual connecting -- no tracks routed).
GND_PADS = [
    ("D1", "2"), ("C1", "2"), ("C2", "2"),
    ("U3", "1"),  # GND (verified TI datasheet)
    ("R4", "2"), ("C3", "2"), ("C4", "2"),
    ("R2", "2"), ("J1", "2"), ("J1", "3"), ("U2", "2"),
    ("U2", "5"),  # SHDN (rev A3 item 4: TCAN330DR, ties low so the device stays enabled)
    ("C9", "2"),
    ("D3", "3"),  # common cathode (verified Nexperia PESD2CANFD24V-TR datasheet)
    ("C6", "2"), ("C7", "2"), ("C8", "2"), ("SW1", "2"),
    ("LED1", "1"), ("LED2", "1"),  # cathodes (rev A3 item 5 polarity fix)
    ("J2", "2"),
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
# rev A3: one short 3V3 bridge segment (R1.1->C6.1) has to squeeze between
# C4's now-larger (0805) GND pad and R1.2's FB_NODE pad with under 1mm to
# spare on EITHER side -- no route geometry threads that gap at the
# nominal 0.6mm power width (checked: F.Cu, B.Cu, and every reasonable
# detour around R2's own column all ran out of room or collided with an
# existing route). This carries only the ESP32-C3's own supply current
# (350mA WiFi TX peak) over a <2mm span, so a 0.3mm trace here is not a
# current-capacity concern; it is a documented, deliberate exception, not
# an overlooked default.
W_POWER_THIN = MM(0.3)

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
    # -- protection chain (F.Cu, local, x=4..27) -- rev A3 items 5+6: D2
    # rotated 180deg (pad 1 now the physical position pad 2 used to
    # occupy, and vice versa -- so "F1.2->D2.2" below is the SAME
    # geometry the old "F1.2->D2.1" route used); D1 (TVS) moved to clamp
    # this NET_FUSED node instead of VIN_PROT.
    ("12V_RAW",   "J1", "1", "F1", "1", W_POWER, "W", [(4.0, 6.0)]),
    ("NET_FUSED", "F1", "2", "D2", "2", W_POWER, "F", None),
    # F1.2 -> D1.1: same short vertical hop the old D2.2->D1.1 dogleg's
    # low-x endpoint used to require dodging -- D2's pad 2 (post-rotation)
    # and D1's pad 1 now sit in the same X column (~10.85), so this is a
    # clean direct drop, clear of D1's own pad 2 (GND, at ~15.15) the
    # whole way.
    ("NET_FUSED", "D2", "2", "D1", "1", W_POWER, "F", None),
    # D2.1 (cathode, post-rotation) -> C1.1: same geometry the old
    # D2.2->C1.1 route used.
    ("VIN_PROT",  "D2", "1", "C1", "1", W_POWER, "F", None),
    # C1.1 -> C2.1 (rev A4: C2 relocated next to U3.VIN -- see PLACEMENTS
    # above): rise to Y=3.0 clear of F1/D2/D1 and of U3's own courtyard,
    # travel east to C2's new X, then drop straight down (same X as C2.1)
    # into the pad.
    ("VIN_PROT",  "C1", "1", "C2", "1", W_POWER, "W", [(19.0, 3.0), (31.8, 3.0)]),
    # C2.1 -> R3.1 (rev A4: R3 relocated to X=28 -- see PLACEMENTS above):
    # leave C2.1 heading west at its own Y (clear of C2's own pad 2/GND,
    # which is a full row south) to X=29.5 -- west of C2's own pad-2
    # footprint (rotated 1210 pad spans X=[30.45,33.15]) and east of
    # R3/R4's own pads (X=28, +-~0.5mm) -- before dropping to R3.1's Y and
    # making the final short hop west into the pad.
    ("VIN_PROT",  "C2", "1", "R3", "1", W_POWER, "W", [(29.5, 6.95), (29.5, 9.825)]),
    # C2.1 -> U3.3 (VIN): rev A4 -- C2 is now placed with pad 1 at U3.3's
    # own Y (6.95), immediately west of it -- short hop either way, but a
    # direct F.Cu line still crosses SW_NODE's own F.Cu vertical at
    # X=33.8 (Y 6.0-9.025, see below), same conflict the pre-rev-A4 design
    # avoided by going via/B.Cu/via. Kept on B.Cu for that reason; still a
    # single short 2-via hop (3mm), not the old 8mm+ detour -- satisfies
    # TI's close-placement guidance for the input bypass cap.
    ("VIN_PROT",  "C2", "1", "U3", "3", W_POWER, "B", None),

    # -- buck switching / bootstrap network -- U3 SW=pin2 (west, mid),
    # BOOT=pin6 (east, north) -- DIAGONALLY opposite corners of the chip
    # (TI's real DDC pinout, verified), not adjacent as the old wrong map
    # assumed. C5 (bootstrap cap) is placed SOUTH of U3, ROTATED 90deg so
    # its two pads stack in Y (verified: pad1/BST_NODE at (36.5,10.575),
    # pad2/SW_NODE at (36.5,9.025) -- north pad closer to U3) instead of
    # X -- the narrow 1.5mm gap directly between U3 and L1's own (much
    # larger) courtyard has no room for C5 at all, and a north-of-U3
    # placement collided with the CAN B.Cu corridor once BST_NODE needed
    # a B.Cu leg (see below), so it moved south instead.
    # U3.2 (SW) -> C5.2 (north pad, 9.025): departs WEST first (clear of
    # pin1/GND directly above pin2 in the same column) at X=33.8 (clear
    # of R3/R4's real pads at X=32 by 1.8mm, and 0.5mm east of
    # VIN_PROT's own approach column above), then south to C5.2's own Y,
    # then east into it.
    ("SW_NODE",  "U3", "2", "C5", "2", W_SIGNAL, "W",
     [(33.8, 6.0), (33.8, 9.025)]),
    # C5.2 -> L1.1: a direct diagonal crosses BST_NODE's own vertical
    # (X=38.5, see below -- the diagonal's Y at that X falls inside
    # BST_NODE's Y span) AND there's no room to detour between BST_NODE's
    # row (Y=10.575) and C3's pad (Y=11.0, only 0.425mm apart -- nowhere
    # near enough for this track's own clearance). Go back NORTH instead,
    # over U3's own courtyard at X=36.0 (the narrow safe gap between its
    # west pin column at 34.8625 and east at 37.1375 -- clear of BOTH by
    # >=1.1mm; X=36.5, C5's own X, tried first, was only 0.64mm from the
    # east column and clipped pins 4/5/6), then east and south into L1.
    ("SW_NODE",  "C5", "2", "L1", "1", W_SIGNAL, "W",
     [(36.0, 9.025), (36.0, 4.0), (42.0, 4.0), (42.0, 6.0)]),
    # U3.6 (BOOT) -> C5.1 (south pad, 10.575): departs EAST first (clear
    # of U3's own courtyard, right edge X=38.05) then south to Y=9.9
    # (short of C3's pad at Y=11.0 by 1.1mm, and short of C3's courtyard
    # top at 10.02) then west, then a final short drop at C5.1's own X
    # (36.5 -- clear of C3, whose X range starts at 37.3) into the pad.
    ("BST_NODE", "U3", "6", "C5", "1", W_SIGNAL, "W",
     [(38.5, 5.05), (38.5, 9.9), (36.5, 9.9)]),

    # -- FB / EN dividers -- U3 FB=pin4 (east, south -- was WEST in the
    # old wrong map, a full side flip), EN=pin5 (east, mid).
    # U3.4 (FB) -> R1.2: B.Cu -- a Y=9.0 F.Cu traverse east crossed
    # BST_NODE's own vertical (X=38.5, spanning Y=5.05-9.9); every Y
    # between BST_NODE's reach and C3's courtyard (10.02) is a <0.15mm
    # sliver, nowhere near enough room for an F.Cu detour underneath it.
    # Steps east to X=39.0 immediately after the via (was going straight
    # down at X=37.1375, U3.4's own X -- but that's the SAME column
    # EN_U3_NODE's own B.Cu via/track already occupies at U3.5, one row
    # north; both nets' B.Cu verticals overlapped there).
    # EN_U3_NODE's own B.Cu path (via at U3.5, then to (40.0,6.0), then
    # to (40.0,8.175), then west to R3.2) forms a 3-sided "staple"
    # bounding U3.4's own via from the east and south -- ANY exit toward
    # R1 (east) has to cross one of those three sides UNLESS it leaves
    # through the one open side: west, through the narrow safe gap
    # between U3's two pin columns (X=35.85-36.15, verified clear of
    # both real pin pads by >=0.6mm), then north above EN's Y=6.0 roof
    # (crossing it at X=36.0, west of where EN's own horizontal even
    # starts, X=37.1375), then east and south, well clear of the whole
    # staple.
    ("FB_NODE",  "U3", "4", "R1", "2", W_SIGNAL, "BW",
     [(36.0, 6.95), (36.0, 5.3), (41.0, 5.3), (41.0, 9.0), (46.0, 9.0)]),
    # R1.2 -> R2.1 direct would thread through R1.1 (3V3) and R2.2 (GND)
    # sitting between them -- detour east of the whole R1/R2 column.
    ("FB_NODE",  "R1", "2", "R2", "1", W_SIGNAL, "W", [(43.5 + REV_A3_SHIFT, 11.175), (43.5 + REV_A3_SHIFT, 16.025)]),
    # EN_U3_NODE: B.Cu throughout (avoids F.Cu conflicts with VIN_PROT and
    # FB_NODE crossing the same U3-adjacent real estate).
    # Steps east to X=39.5 immediately after the via (was going straight
    # down at X=37.1375, U3.5's own X -- but FB_NODE's via at U3.4, one
    # row north at the SAME X, sits inside that vertical's Y span; a
    # via can't be routed "around" the way a track can).
    # rev A4: R3 moved to X=28 (from X=32) to make room for C2 next to
    # U3.VIN -- final leg now runs further west, on B.Cu the whole way so
    # it passes freely underneath C2's F.Cu footprint (different layer,
    # no clearance interaction) on its way to R3.2.
    ("EN_U3_NODE", "U3", "5", "R3", "2", W_SIGNAL, "BW",
     [(40.0, 6.0), (40.0, 8.175)]),
    # rev A4: R3/R4 share the same X (28) one above the other, but R3's own
    # pad 1 (VIN_PROT, Y=9.825) and R4's own pad 2 (GND, Y=11.675) also sit
    # on that same column, directly between R3.2(Y=8.175) and R4.1
    # (Y=13.325) -- a direct vertical would short both. Detour west to
    # X=26.5 (clear of R3/R4's own pads by >1mm, and of the VIN_PROT
    # C2->R3.1 detour at X=29.5 above by 3mm) for the full span.
    ("EN_U3_NODE", "R3", "2", "R4", "1", W_SIGNAL, "W", [(26.5, 8.175), (26.5, 13.325)]),

    # -- buck output rail (3V3), local hops (F.Cu) --
    # L1.2 does not connect to R1.1 directly (any path east runs parallel
    # too close to FB_NODE's R1.2->R2.1 detour) -- instead it joins the
    # already-verified-clear R1.1->C6.1 rail at Y=7.3 (same net, so
    # sharing that lane is harmless).
    ("3V3", "L1", "2", "C6", "1", W_POWER, "W", [(42.025 + REV_A3_SHIFT, 7.3), (45.525 + REV_A3_SHIFT, 7.3)]),
    # C3.1 -> C4.1 (both now 0805, rev A3 item 8): dip down first, clear of
    # C3's own GND pad sitting between them.
    ("3V3", "C3", "1", "C4", "1", W_POWER, "W", [(33.225 + REV_A3_SHIFT, 12.0)]),
    # C4.1 -> R1.1 (verified pad position 46.0,12.825): B.Cu -- an F.Cu
    # approach at X=45.5 is 1.55mm clear of C4's own (now-larger 0805)
    # GND pad -- fine on its own; F.Cu here only conflicted with
    # FB_NODE's approach into R1.2, which now runs on B.Cu instead (see
    # above), so this stays F.Cu.
    ("3V3", "C4", "1", "R1", "1", W_POWER, "W",
     [(37.225 + REV_A3_SHIFT, 10.0), (45.0, 10.0), (45.0, 12.825)]),

    # -- CAN cluster, local (J1/U2/D3/R9/C9), F.Cu -- unmoved from wave 2.
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
    # (rev A3 item 4: the old U2.3->U2.5 VCC<->VIO jumper is REMOVED here
    # -- U2 pin 5 is now TCAN330DR's SHDN, tied to GND via GND_PADS/the
    # copper pour, not bridged to 3V3. Bridging it would short VCC to GND.)

    # -- 3V3 bridge: buck output (C3.1) -> CAN cluster (U2.3, VCC) --
    # rev A3 item 4: retargeted from U2.5 (old VIO, now SHDN/GND) to U2.3
    # (VCC). The straight-line final approach into U2.3 from due south
    # crossed CAN_RX's own B.Cu descent at X=11.5 -- reuse the X=9.5
    # approach lane the U2.3->C9.1 route above already proves clear (west
    # of CAN_RX's X=11.5 the whole way, same pattern: due south past
    # everything, then a short final hop east into U2.3 at its own Y).
    ("3V3", "C3", "1", "U2", "3", W_POWER, "BW",
     [(33.225 + REV_A3_SHIFT, 25.0), (9.5, 25.0), (9.5, 18.635)]),

    # -- 3V3 bridge: buck output (R1.1) -> U1 cluster (C6.1) --
    # F.Cu (unchanged from wave 2), W_POWER_THIN (see its definition
    # above) -- the X=45.5 approach column's long vertical span (Y=7.3 to
    # 12.825) runs straight past C4.2's GND pad on one side and R1.2's
    # FB_NODE pad on the other, with under 1mm total between them; the
    # thinner trace clears both. B.Cu was tried first, but that put it on
    # the same layer as the CAN_TX trunk's own vertical (X=49.0, spanning
    # the corridor's whole Y=1.5-15.0 reach) sitting directly across this
    # bridge's path to C6 -- F.Cu avoids that regardless, and FB_NODE
    # (also B.Cu, see above) no longer shares this X at all.
    ("3V3", "R1", "1", "C6", "1", W_POWER_THIN, "W",
     [(45.0, 12.825), (45.0, 7.3), (45.525 + REV_A3_SHIFT, 7.3)]),

    # -- U1 cluster, local (F.Cu) --
    # Local 3V3 rail at Y=7.3 (above the C6/C7/C8/R5 row, clear of every
    # pad in it -- each hop only needs to clear its OWN part's sibling GND
    # pad, which a same-Y horizontal run would otherwise clip).
    ("3V3", "C6", "1", "C7", "1", W_POWER, "W", [(45.525 + REV_A3_SHIFT, 7.3), (49.025 + REV_A3_SHIFT, 7.3)]),
    # rev A4: final approach to R5.2 dips to Y=7.0 -- a narrow but real
    # corridor clear of C8's own pads (1 and 2, GND, Y up to 6.475) to the
    # south by >=0.2mm AND clear of the enlarged antenna keepout's
    # Y0=~7.4 (see below) to the north by 0.1mm -- BEFORE crossing into
    # the keepout's X band (>=~60.6), then a short final drop at R5's own
    # X (which IS inside the keepout's X band, but the drop stays at
    # Y<7.4 throughout, so it never enters the keepout rectangle).
    ("3V3", "C7", "1", "R5", "2", W_POWER, "W",
     [(49.025 + REV_A3_SHIFT, 7.3), (54.5, 7.0), (60.975, 7.0)]),
    # U1.3 taps into the rail via C7.1 (its own column first, clear of C8's
    # pads which sit at a different Y).
    ("3V3", "U1", "3", "C7", "1", W_POWER, "W", [(52.9 + REV_A3_SHIFT, 7.3), (49.025 + REV_A3_SHIFT, 7.3)]),
    # R7.2 -> LED1.2 (anode, rev A3 item 5 polarity fix) direct would clip
    # LED1's own cathode pad (LED1.1) sitting between them -- hop above
    # the row instead.
    ("LED1_TOP", "R7", "2", "LED1", "2", W_SIGNAL, "W", [(35.5 + REV_A3_SHIFT, 17.0), (32.212 + REV_A3_SHIFT, 17.0)]),
    # R7.1 (3V3) has no other path onto the 3V3 mesh -- feed it via R6.2
    # (also otherwise-isolated 3V3, see below), sharing one bridge to C6.1.
    ("3V3", "R7", "1", "R6", "2", W_POWER, "W", [(35.5 + REV_A3_SHIFT, 20.175), (43.0 + REV_A3_SHIFT, 20.175)]),

    # rev A3 item 7: LED2 driven from IO7 (pin 21) now, not IO8 (pin 22) --
    # same short direct F.Cu hop pattern the old IO8 drive used (IO7 is
    # 0.8mm north of IO8 in the same physical pin column).
    ("LED2_DRIVE", "U1", "21", "R8", "2", W_SIGNAL, "F", None),
    # R8.1 -> LED2.2 (anode, rev A3 item 5 polarity fix) direct would clip
    # LED2's own cathode pad (LED2.1) sitting between them -- hop above
    # the row instead.
    ("LED2_TOP", "R8", "1", "LED2", "2", W_SIGNAL, "W", [(41.675 + REV_A3_SHIFT, 17.0), (38.212 + REV_A3_SHIFT, 17.0)]),

    # NEW (rev A3 item 7): IO8 (pin 22) -> R10.1 (verified pad position
    # 43.675,22.0) pullup. IO8 sits in the same physical pin column as
    # IO9 (pin 23, see the IO9_BOOT route below) -- step off in X
    # immediately at IO8's own Y before descending, same pattern but a
    # SHORT step (to 49.7, not IO9_BOOT's 49.0) that clears both the pin
    # column itself and LED2_DRIVE's diagonal (which only reaches this Y
    # band right at R8's pad, x=47.9 -- 0.5mm+ west of this dodge) while
    # staying 0.7mm east of IO9_BOOT's own dodge column. B.Cu throughout
    # (via at U1.22, via at R10.1) -- an F.Cu path here still crossed
    # IO9_BOOT's own R6.1->SW1.1 vertical (X=48, Y=21.825-26.45) no matter
    # which Y it used to get past it; B.Cu sidesteps that regardless of X/Y.
    # Dips to Y=25.0 (was 23.5) -- the "3V3: J2.1->R6.2" B.Cu route's own
    # vertical at X=49.0 spans Y=20.175-24.5, which the shorter dip
    # crossed; 25.0 is south of its endpoint.
    ("IO8_PU", "U1", "22", "R10", "1", W_SIGNAL, "BW",
     [(49.7, 18.2), (49.7, 25.0), (43.675, 25.0)]),
    # R10.2 -> R6.2 (3V3, already on the mesh -- see above): short direct
    # hop south of the R7->R6 lane, clear of every other pad nearby.
    ("3V3", "R10", "2", "R6", "2", W_SIGNAL, "F", None),

    # U1.23 -> R6.1: step off U1's pin column in X immediately (at the
    # pin's own Y) before descending, so the vertical leg doesn't graze
    # U1's corner GND anchor pad or R6.2 (also at this X, north of R6.1)
    # -- approach R6.1 from below instead.
    ("IO9_BOOT", "U1", "23", "R6", "1", W_SIGNAL, "W",
     [(44.0 + REV_A3_SHIFT, 19.0), (44.0 + REV_A3_SHIFT, 22.5), (43.0 + REV_A3_SHIFT, 22.5)]),
    # R6.1 -> SW1.1: straight down R6.1's own column first (clear of R6.2,
    # which is north of it) then a short final hop into SW1 -- a direct
    # diagonal here would cross the 3V3/R6.2 bridge below (different X
    # bands were needed for both, see the 3V3 route a few lines down).
    # rev A4: dips to Y=27.2 while crossing SW1's centerline (X=46) --
    # straight-at-Y=26.45 used to run directly over the new footprint's
    # NPTH mounting hole at (46,25.925), only 0.525mm away (needs 0.625mm).
    ("IO9_BOOT", "R6", "1", "SW1", "1", W_SIGNAL, "W", [(48.0, 26.45), (46.0, 27.2)]),
    # SW1.1 -> J2.5: pad() resolves to SW1's west physical pad. rev A4:
    # the horizontal lane moved from Y=26.0 to Y=26.9 -- SW1's new
    # footprint (Panasonic_EVQPUL_EVQPUC) has an NPTH mounting hole at
    # (SW1.x, 25.925) that Y=26.0 ran straight through; moving it NORTH to
    # clear that hole would instead run it straight into J2's own PTH
    # pads (Y=24.5, 0.85mm annular clearance needed), so it moves SOUTH of
    # the hole instead -- still >=1mm clear of SW1's own GND pad row
    # (Y=28.15) and lower NPTH hole (Y=28.675), and touches only SW1's own
    # pad 1 (same net, both physical instances, Y=[25.95,26.95]) on the
    # way, which is not a DRC violation.
    ("IO9_BOOT", "SW1", "1", "J2", "5", W_SIGNAL, "W",
     [(38.375 + REV_A3_SHIFT, 26.9), (57.16 + REV_A3_SHIFT, 26.9)]),
    # R6.2 (3V3, also carries R7.1's and R10.2's feeds -- see above) -> U1
    # cluster rail (C7.1). B.Cu, same pattern as wave 2: stays west of
    # every CAN net's own near-U1 jog so this vertical never runs parallel
    # through one of them; it also clears R1/R2 and FB_NODE's detour
    # (different layer, no interaction regardless), and dodges U1_EN's own
    # B.Cu diagonal by descending west of its whole X-span before jogging
    # east into C7.1 only at the very end.
    ("3V3", "R6", "2", "C7", "1", W_SIGNAL, "BW",
     [(41.5 + REV_A3_SHIFT, 20.175), (41.5 + REV_A3_SHIFT, 17.5),
      (48.0 + REV_A3_SHIFT, 17.5), (48.0 + REV_A3_SHIFT, 6.0)]),
    # J2.1 (3V3) -> R6.2: B.Cu -- an F.Cu path anywhere in this X band
    # crosses one of IO9_BOOT's own two segments there; B.Cu sidesteps
    # both regardless of X.
    # Waypointed (was direct "B") -- a direct diagonal, and two later
    # detours south of J2, all crossed IO8_PU's own B.Cu path (rev A3
    # item 7's new net) somewhere -- it's L-shaped (vertical at X=49.7
    # down to Y=25.0, then horizontal from there to X=43.675), and R6.2
    # sits inside that L's own corner, so no detour below or to either
    # side avoids crossing ONE of its two legs. Approach from ABOVE
    # instead -- Y=18.2 is where IO8_PU's vertical leg starts, so
    # anything north of that is clear regardless of X.
    # Y=17.4, W_POWER_THIN (see its definition above) -- squeezed between
    # CAN_S's own near-U1 via (50.6,16.6) and U1.22's own IO8_PU via
    # (50.6,18.2), only 1.6mm apart total; the nominal 0.6mm power width
    # doesn't fit between both vias' clearance zones at once, the
    # thinner trace does. Short bridge, same current-capacity rationale
    # as the R1->C6 bridge above.
    ("3V3", "J2", "1", "R6", "2", W_POWER_THIN, "BW",
     [(52.0, 17.4), (48.7, 17.4), (48.7, 20.175)]),

    # -- U1_EN, B.Cu throughout. U1's row-1-11 pins are on a strict 0.8mm
    #    pitch with 0.8mm-wide pads -- edge-to-edge with ZERO gap between
    #    neighbours, so no F.Cu track can thread between any two of them.
    #    Since U1's pads are SMD (F.Cu only), B.Cu passes underneath the
    #    whole row freely. --
    ("U1_EN", "U1", "8", "C8", "1", W_SIGNAL, "B", None),
    # R5.1 (U1_EN) sits east of U1's own pin-36-48 column (R5 rotated
    # 180deg for this).
    ("U1_EN", "C8", "1", "R5", "1", W_SIGNAL, "B", None),
    # R5.1 -> J2.6: B.Cu bridge. rev A4: the enlarged antenna keepout (see
    # below) now covers X>=~60.6, Y=~7.9-22.1 on BOTH copper layers, so the
    # old straight-down approach at X=64.7 (J2.6's own X) through that
    # whole band is no longer legal. Rerouted around the WEST side of the
    # keepout instead: west to X=59.0 (clear of the keepout's X0 by 1.6mm,
    # and of U1's own SMD pad column at X=60.4 -- different layer anyway)
    # while still above the keepout's Y0, straight down the whole
    # antenna-adjacent span at that X, then east into J2.6 only at
    # Y=23.0 (south of the keepout's Y1=22.1).
    ("U1_EN", "R5", "1", "J2", "6", W_SIGNAL, "BW",
     [(62.625, 6.5), (59.0, 6.5), (59.0, 23.0), (64.7, 23.0)]),

    # TXD0/RXD0 to J2: TXD0's target sits inside RXD0's own X span -- any
    # same-layer Manhattan pairing has one net's vertical crossing the
    # other's horizontal somewhere in that shared band. Put TXD0 on B.Cu
    # (short bridge) so it can't interact with RXD0's F.Cu run at all;
    # RXD0's horizontal also clears J2.3's PTH pad itself (0.85mm radius)
    # by staying well above the pad.
    ("TXD0", "U1", "31", "J2", "3", W_SIGNAL, "BW",
     [(51.3 + REV_A3_SHIFT, 24.0), (52.08 + REV_A3_SHIFT, 24.0)]),
    ("RXD0", "U1", "30", "J2", "4", W_SIGNAL, "W",
     [(50.5 + REV_A3_SHIFT, 22.5), (54.62 + REV_A3_SHIFT, 22.5)]),

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
    # Only the near-U1 end of each waypoint chain moves with REV_A3_SHIFT;
    # the CAN-cluster end (near U2, unmoved) stays at its original literal
    # coordinates.
    ("CAN_TX", "U1", "18", "U2", "1", W_SIGNAL, "BW",
     [(44.0 + REV_A3_SHIFT, 15.0), (44.0 + REV_A3_SHIFT, 1.5), (9.0, 1.5), (9.0, 15.4), (10.525, 15.4)]),
    # CAN_RX's descent column is X=11.5 (not 11.0) -- U2.3's own via sits
    # at (10.525, 18.635), only 0.475mm from X=11.0 (needs 0.575mm).
    ("CAN_RX", "U1", "19", "U2", "4", W_SIGNAL, "BW",
     [(43.3 + REV_A3_SHIFT, 15.8), (43.3 + REV_A3_SHIFT, 2.1), (11.5, 2.1), (11.5, 19.7), (10.525, 19.7)]),
    ("CAN_S",  "U1", "20", "U2", "8", W_SIGNAL, "BW",
     [(42.6 + REV_A3_SHIFT, 16.6), (42.6 + REV_A3_SHIFT, 2.7), (12.5, 2.7), (12.5, 16.095)]),
]

# rev A3 item 8: grown 62->68mm (+REV_A3_SHIFT x 1 plus the C8/R5-area
# footprint margin) so the U1 cluster still fits inside the outline after
# the whole-cluster translation above.
BOARD_W, BOARD_H = 68.0, 30.0
CORNER_R = 2.0


def add_board_outline(board):
    """68x30mm board outline (rev A3, was 62x30), 2mm rounded corners, on Edge.Cuts."""
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

    # SW1 (Panasonic_EVQPUL_EVQPUC, rev A4) has two physical pads for each of
    # its two numbered contacts (duplicate_pad_numbers_are_jumpers = no in
    # the footprint, so KiCad does NOT treat them as internally bonded) --
    # explicit jumper tracks are required or the second instance of each
    # number is an unconnected island. The footprint also has two NPTH
    # mounting/alignment holes (empty pad number "", no net) -- these must
    # be excluded here or the same length==2 grouping wrongly bridges them
    # with a floating, netless track that DRC flags (tracks_crossing / no
    # net) against whatever real route happens to run nearby.
    # The two NPTH mounting holes sit on SW1's own centerline (X=46, one
    # 0.525mm north of the pad-1 row, one 0.525mm south of the pad-2 row --
    # a straight pad-to-pad bridge for either number clips its nearest
    # hole's 0.25mm clearance). Each bridge instead dips 0.35mm TOWARD
    # the footprint center (into the >=1.5mm-wide band that is clear of
    # both holes) while crossing X=46, then returns to its own pad row.
    sw1_center = footprints["SW1"].GetPosition()
    sw1_center_x_mm = pcbnew.ToMM(sw1_center.x)
    sw1_center_y_mm = pcbnew.ToMM(sw1_center.y)
    sw1_by_num = {}
    for p in footprints["SW1"].Pads():
        if p.GetNumber() == "":
            continue  # NPTH mounting hole, not an electrical contact
        sw1_by_num.setdefault(p.GetNumber(), []).append(p)
    for num, pads in sw1_by_num.items():
        if len(pads) == 2:
            pos_a, pos_b = pads[0].GetPosition(), pads[1].GetPosition()
            row_y_mm = pcbnew.ToMM(pos_a.y)
            dip_y_mm = row_y_mm + (0.35 if row_y_mm < sw1_center_y_mm else -0.35)
            apex = pcbnew.VECTOR2I(MM(sw1_center_x_mm), MM(dip_y_mm))
            net = pads[0].GetNet()
            seg(pos_a, apex, W_SIGNAL, pcbnew.F_Cu, net)
            seg(apex, pos_b, W_SIGNAL, pcbnew.F_Cu, net)

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

    # -- antenna keepout (rev A3 item 10, ENLARGED rev A4): a real
    # both-layer rule-area zone under U1's antenna end, per the
    # ESP32-C3-MINI-1 datasheet's "no copper under antenna" guidance
    # (DESIGN.md sec4). The antenna region is bounded by the constructed
    # footprint's own F.Fab reference lines (fp-lib/TRACE-Custom.pretty/
    # ESP32-C3-MINI-1.kicad_mod: local Y -11 to -5.6, local X -6.6 to 6.6,
    # i.e. the full 5.4mm-tall x 13.2mm-wide antenna trace area, not just
    # the single "no copper" text-comment point at local (0,-7.675) that
    # the rev A3 keepout was (wrongly) centered on). Transform verified
    # empirically against pcbnew's own placed coordinates for U1's rot=270
    # (global_X = u1.x - local_Y, global_Y = u1.y + local_X): the antenna
    # zone maps to X in [u1.x+5.6, u1.x+11.0], Y in [u1.y-6.6, u1.y+6.6].
    # A 1mm margin is added on every non-board-edge side (Espressif's
    # guidance gives no exact on-module figure, only "keep the antenna
    # clear and cut the board close to it" -- see
    # https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/pcb-layout-design.html
    # -- 1mm is the conservative, commonly-used allowance for a module
    # whose antenna is fully inside the board like this one). Extends all
    # the way to the board edge in X (nothing useful can route past the
    # antenna anyway). U1_EN's bridge to J2 (below) is rerouted around the
    # west side of this zone instead of through it.
    u1_pos = footprints["U1"].GetPosition()
    u1_x_mm = pcbnew.ToMM(u1_pos.x)
    u1_y_mm = pcbnew.ToMM(u1_pos.y)
    ANTENNA_MARGIN = 1.0
    ant_x0, ant_x1 = u1_x_mm + 5.6 - ANTENNA_MARGIN, BOARD_W - 0.5
    ant_y0, ant_y1 = u1_y_mm - 6.6 - ANTENNA_MARGIN, u1_y_mm + 6.6 + ANTENNA_MARGIN
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        keepout = pcbnew.ZONE(board)
        keepout.SetLayer(layer)
        keepout.SetIsRuleArea(True)
        keepout.SetDoNotAllowZoneFills(True)
        keepout.SetDoNotAllowTracks(True)
        keepout.SetDoNotAllowVias(True)
        keepout.SetDoNotAllowPads(False)
        keepout.SetDoNotAllowFootprints(False)
        keepout.SetZoneName("U1_ANTENNA_KEEPOUT")
        outline = keepout.Outline()
        outline.NewOutline()
        for x, y in [(ant_x0, ant_y0), (ant_x1, ant_y0), (ant_x1, ant_y1), (ant_x0, ant_y1)]:
            outline.Append(pcbnew.VECTOR2I(MM(x), MM(y)))
        board.Add(keepout)

    # -- fill zones + connectivity refresh -----------------------------------
    board.BuildConnectivity()
    filler = pcbnew.ZONE_FILLER(board)
    filler.Fill(board.Zones())
    board.BuildConnectivity()

    pcbnew.SaveBoard(OUT_PCB, board)
    print(f"Wrote {OUT_PCB}")


if __name__ == "__main__":
    main()
