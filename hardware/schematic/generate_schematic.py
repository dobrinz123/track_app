#!/usr/bin/env python3
"""
TRACE OBD Telemetry Dongle -- schematic generator.

Renders hardware/schematic/trace-dongle.svg from schemdraw, following the
BINDING netlist in hardware/DESIGN.md sections 2-3 exactly. Do not edit the
SVG by hand -- edit this script and re-run it.

Run (from repo root, with schemdraw installed):
    python hardware/schematic/generate_schematic.py

Deterministic: no randomness, no wall-clock timestamps in the output, fixed
layout coordinates -> re-running produces a byte-identical SVG.
"""
import os

import schemdraw
import schemdraw.elements as elm
from schemdraw.elements import IcPin

OUT_SVG = os.path.join(os.path.dirname(__file__), "trace-dongle.svg")

schemdraw.theme("default")


def gnd(pos, lead=0.35):
    """Standard ground symbol dropped below `pos`."""
    return elm.Ground(lead=lead).at(pos)


def net_flag(pos, name, width=1.5, direction="right", fontsize=10):
    """Small rectangular net-name flag (professional schematic net label),
    used instead of routing long wires for nets that fan out across zones
    (3V3, GND handled separately via gnd(), CANH/CANL, 12V_RAW)."""
    t = elm.Tag(width=width).at(pos)
    if direction == "right":
        t = t.right()
    elif direction == "left":
        t = t.left()
    elif direction == "up":
        t = t.up()
    elif direction == "down":
        t = t.down()
    return t.label(name, fontsize=fontsize)


def vdd_flag(pos, name="3V3", fontsize=10):
    """3V3 rail flag (arrow-up style Vdd symbol)."""
    return elm.Vdd().at(pos).label(name, fontsize=fontsize, loc="top")


d = schemdraw.Drawing(file=str(OUT_SVG))
d.config(fontsize=9, unit=2)

TITLE = (
    "TRACE OBD Telemetry Dongle -- Schematic (rev A)  |  "
    "hardware/DESIGN.md secs 2-3 binding  |  schemdraw autogen, see generate_schematic.py"
)
d += elm.Label().at((0, 24.5)).label(TITLE, fontsize=11, halign="left")

# =====================================================================
# ZONE 1 (x 0-9):  OBD-II input + protection (rev A3, DESIGN.md sec8 items 5+6)
#   J1.16 -> F1.1 ; F1.2 -> NET_FUSED
#   D1 (SMBJ18A TVS): NET_FUSED -> GND  (moved BEFORE D2 -- clamps negative
#     pulses via forward conduction too, and its 29.2V clamp stays under the
#     TPS54202's 30V Vin abs-max without the Schottky's forward drop eating
#     into the margin)
#   NET_FUSED -> D2.A ; D2.K -> VIN_PROT
# =====================================================================
d += elm.Label().at((0.2, 20.6)).label("(1) OBD-II INPUT + PROTECTION", fontsize=10, halign="left")

j1 = elm.Ic(
    size=(2.2, 6),
    pins=[
        IcPin(name="16", pin="16", side="R", slot="1/5"),
        IcPin(name="6", pin="6", side="R", slot="2/5"),
        IcPin(name="14", pin="14", side="R", slot="3/5"),
        IcPin(name="4", pin="4", side="R", slot="4/5"),
        IcPin(name="5", pin="5", side="R", slot="5/5"),
    ],
).at((0.5, 14)).label(
    "J1\nOBD-II (J1962) male plug\n"
    "1x5 2.54mm pigtail fallback, C2337 (cut to 5 pins)\n"
    "pins 16/4/5/6/14 used;\nothers NC rev A",
    loc="center", fontsize=8,
)
d += j1

# --- 12V_RAW: J1.16 -> F1.1 ---
d += elm.Line().at(j1.absanchors["16"]).right(0.6)
f1 = elm.Fuse().right(2).label("F1\nPTC 350mA 0603\nC910820 (16V)", fontsize=7.5)
d += f1
d += net_flag(j1.absanchors["16"], "12V_RAW", width=1.7, direction="left")
net_fused = f1.end

# --- GND: J1.4, J1.5 -> GND plane ---
d += elm.Line().at(j1.absanchors["4"]).right(0.5)
d += gnd((j1.absanchors["4"][0] + 0.5, j1.absanchors["4"][1]))
d += elm.Line().at(j1.absanchors["5"]).right(0.9)
d += gnd((j1.absanchors["5"][0] + 0.9, j1.absanchors["5"][1]))

# --- D1 (SMBJ18A TVS): NET_FUSED -> GND (rev A3: moved to right at F1's
#     output, BEFORE D2 -- item 6) ---
d += elm.Dot().at(net_fused)
d += elm.DiodeTVS().at(net_fused).down(2.4).label(
    "D1\nSMBJ18A TVS\nC151256 (18V standoff,\n29.2V clamp)", loc="bottom", fontsize=7.5
)
d += gnd((net_fused[0], net_fused[1] - 2.4))

# --- NET_FUSED -> D2.A ; D2.K -> VIN_PROT ---
d += elm.Line().at(net_fused).right(0.6)
d2 = elm.Diode().right(2).label("D2\nSS34B Schottky\nC880746 (SMB)", fontsize=7.5)
d += d2
vin_prot = d2.end

# --- Cin x2 10uF/50V X7R 1210, VIN_PROT -> GND (rev A3 item 8: 22uF/35V in
#     0603 was not a real part; close to U3.VIN, drawn here, zone1/2 boundary) ---
cin1_top = (vin_prot[0] + 1.6, vin_prot[1])
d += elm.Line().at(vin_prot).to(cin1_top)
d += elm.Dot().at(cin1_top)
d += elm.Capacitor().at(cin1_top).down(2.4).label(
    "C1\n10uF/50V X7R 1210\nC138687", loc="bottom", fontsize=7.5
)
d += gnd((cin1_top[0], cin1_top[1] - 2.4))

cin2_top = (cin1_top[0] + 1.4, vin_prot[1])
d += elm.Line().at(cin1_top).to(cin2_top)
d += elm.Dot().at(cin2_top)
d += elm.Capacitor().at(cin2_top).down(2.4).label(
    "C2\n10uF/50V X7R 1210\nC138687", loc="bottom", fontsize=7.5
)
d += gnd((cin2_top[0], cin2_top[1] - 2.4))

vin_prot_rail_end = cin2_top
d += net_flag(vin_prot_rail_end, "VIN_PROT", width=2.0, direction="right")

# =====================================================================
# ZONE 2 (x 11-22):  TPS54202 buck (rev A3, DESIGN.md sec8 items 1-3)
#   U3.VIN <- VIN_PROT ; BST cap SW->BST ; L1 SW->VOUT_3V3(=3V3)
#   FB divider 100k/22.1k (Vref 0.598V typ, verified TI datasheet) ; EN
#   divider 133k/24k off VIN_PROT (~7.8V rising UVLO -- 137k, nearest E96 to
#   the 136.6k target, was 0 in stock at LCSC; 133k is the nearest in-stock
#   E96 value, see report)
#   Physical pin map verified against the live TI datasheet (DDC/SOT-23-6):
#   1=GND, 2=SW, 3=VIN, 4=FB, 5=EN, 6=BOOT -- LEAD's original sec3/sec7
#   pin maps were both wrong (Codex NO-GO review); this schematic's pin
#   NAMES were always electrically correct, only generate_board.py's
#   numeric mapping needed the fix.
# =====================================================================
d += elm.Label().at((11, 20.6)).label("(2) TPS54202 BUCK 12V -> 3V3 (2A)", fontsize=10, halign="left")

u3 = elm.Ic(
    size=(3, 6),
    pins=[
        IcPin(name="VIN", pin="3", side="L", slot="1/2"),
        IcPin(name="EN", pin="5", side="L", slot="2/2"),
        IcPin(name="BST", pin="6", side="T", slot="1/1"),
        IcPin(name="SW", pin="2", side="R", slot="1/2"),
        IcPin(name="FB", pin="4", side="R", slot="2/2"),
        IcPin(name="GND", pin="1", side="B", slot="1/1"),
    ],
).at((13, 14)).label("U3\nTPS54202DDCR\nC191884", loc="center", fontsize=8)
d += u3

# VIN_PROT -> U3.VIN
d += elm.Line().at(vin_prot_rail_end).to((13, u3.absanchors["VIN"][1]))
d += elm.Line().to(u3.absanchors["VIN"])

# U3.GND -> GND
d += elm.Line().at(u3.absanchors["GND"]).down(0.6)
d += gnd((u3.absanchors["GND"][0], u3.absanchors["GND"][1] - 0.6))

# BST cap: SW -> 100nF -> BST
sw_pt = u3.absanchors["SW"]
bst_pt = u3.absanchors["BST"]
bst_via = (sw_pt[0] + 1.2, sw_pt[1])
d += elm.Line().at(sw_pt).to(bst_via)
d += elm.Dot().at(bst_via)
d += elm.Capacitor().at(bst_via).up(1.6).label("100nF\nBST", fontsize=7.5, loc="right")
d += elm.Line().at((bst_via[0], bst_via[1] + 1.6)).to((bst_pt[0], bst_pt[1] + 1.6))
d += elm.Line().to(bst_pt)

# L1: SW -> VOUT_3V3
d += elm.Dot().at(sw_pt)
d += elm.Inductor2().at(sw_pt).right(2.2).label("L1\n10uH 2A shielded\nC167223", fontsize=7.5)
vout = (sw_pt[0] + 2.2, sw_pt[1])
d += elm.Dot().at(vout)

# FB divider: VOUT_3V3 -100k- FB -22.1k- GND ; FB node wired across to U3.FB
fb_node = (vout[0] + 1.6, vout[1] - 2.2)
d += elm.Resistor().at(vout).down(1.8).label("R1\n100k 1%\nC25803", fontsize=7.5, loc="right")
r_fb1_end = (vout[0], vout[1] - 1.8)
d += elm.Line().at(r_fb1_end).to(fb_node)
d += elm.Dot().at(fb_node)
d += elm.Resistor().at(fb_node).down(1.8).label("R2\n22.1k 1%\nC25961", fontsize=7.5, loc="right")
d += gnd((fb_node[0], fb_node[1] - 1.8))
fb_pt = u3.absanchors["FB"]
d += elm.Line().at(fb_node).to((fb_pt[0], fb_node[1]))
d += elm.Line().to(fb_pt)

# C_out x2 22uF/10V X7R 0805 (rev A3 item 8), VOUT_3V3 -> GND
cout1_top = (vout[0] + 3.2, vout[1])
d += elm.Line().at(vout).to(cout1_top)
d += elm.Dot().at(cout1_top)
d += elm.Capacitor().at(cout1_top).down(2.2).label(
    "C3\n22uF/10V X7R 0805\nC907991", loc="bottom", fontsize=7.5
)
d += gnd((cout1_top[0], cout1_top[1] - 2.2))

cout2_top = (cout1_top[0] + 1.4, vout[1])
d += elm.Line().at(cout1_top).to(cout2_top)
d += elm.Dot().at(cout2_top)
d += elm.Capacitor().at(cout2_top).down(2.2).label(
    "C4\n22uF/10V X7R 0805\nC907991", loc="bottom", fontsize=7.5
)
d += gnd((cout2_top[0], cout2_top[1] - 2.2))

vout_3v3_end = cout2_top
d += vdd_flag((vout_3v3_end[0] + 0.4, vout_3v3_end[1]), "3V3")
d += elm.Line().at(vout_3v3_end).to((vout_3v3_end[0] + 0.4, vout_3v3_end[1]))

# EN divider: EN -> 133k -> VIN_PROT ; EN -> 24k -> GND (~7.8V rising UVLO;
# 137k target was 0 in stock, 133k is the nearest in-stock E96 -- see report)
en_pt = u3.absanchors["EN"]
en_node = (en_pt[0] - 1.6, en_pt[1])
d += elm.Line().at(en_pt).to(en_node)
d += elm.Dot().at(en_node)
d += elm.Resistor().at(en_node).up(1.8).label("R3\n133k 1%\nC22870", fontsize=7.5, loc="left")
en_top = (en_node[0], en_node[1] + 1.8)
d += net_flag(en_top, "VIN_PROT", width=2.0, direction="up")
d += elm.Resistor().at(en_node).down(1.8).label("R4\n24k 1%\nC23352", fontsize=7.5, loc="left")
d += gnd((en_node[0], en_node[1] - 1.8))

# =====================================================================
# ZONE 3 (x 24-34):  ESP32-C3-MINI-1
# =====================================================================
d += elm.Label().at((24, 20.6)).label("(3) ESP32-C3-MINI-1 (WiFi + TWAI/CAN ctrl)", fontsize=10, halign="left")

u1 = elm.Ic(
    size=(3.6, 8),
    pins=[
        IcPin(name="EN", side="L", slot="1/2"),
        IcPin(name="IO9", side="L", slot="2/2"),
        IcPin(name="IO4", side="R", slot="1/5"),
        IcPin(name="IO5", side="R", slot="2/5"),
        IcPin(name="IO6", side="R", slot="3/5"),
        IcPin(name="IO7", side="R", slot="4/5"),
        IcPin(name="IO8", side="R", slot="5/5"),
        IcPin(name="3V3", side="T", slot="1/1"),
        IcPin(name="TXD0", side="B", slot="1/4"),
        IcPin(name="RXD0", side="B", slot="2/4"),
        IcPin(name="GND", side="B", slot="3/4"),
    ],
).at((26, 13)).label("U1\nESP32-C3-MINI-1-N4\nC2838502", loc="center", fontsize=8)
d += u1

d += vdd_flag((u1.absanchors["3V3"][0], u1.absanchors["3V3"][1] + 0.8), "3V3")
d += elm.Line().at(u1.absanchors["3V3"]).up(0.8)
d += elm.Capacitor().at((u1.absanchors["3V3"][0] - 1.0, u1.absanchors["3V3"][1] + 0.4)).down(1.2).label(
    "100nF", fontsize=7, loc="bottom"
)
d += gnd((u1.absanchors["3V3"][0] - 1.0, u1.absanchors["3V3"][1] - 0.8))
d += elm.Capacitor().at((u1.absanchors["3V3"][0] - 2.0, u1.absanchors["3V3"][1] + 0.4)).down(1.2).label(
    "10uF", fontsize=7, loc="bottom"
)
d += gnd((u1.absanchors["3V3"][0] - 2.0, u1.absanchors["3V3"][1] - 0.8))

# EN: 10k to 3V3 + 1uF to GND
en1 = u1.absanchors["EN"]
en1_node = (en1[0] - 1.4, en1[1])
d += elm.Line().at(en1).to(en1_node)
d += elm.Dot().at(en1_node)
d += elm.Resistor().at(en1_node).up(1.6).label("10k", fontsize=7.5, loc="left")
d += vdd_flag((en1_node[0], en1_node[1] + 1.6), "3V3")
d += elm.Capacitor().at(en1_node).down(1.6).label("1uF", fontsize=7.5, loc="left")
d += gnd((en1_node[0], en1_node[1] - 1.6))

# IO9: 10k pullup to 3V3 + SW1 to GND (BOOT strap)
io9 = u1.absanchors["IO9"]
io9_node = (io9[0] - 1.4, io9[1])
d += elm.Line().at(io9).to(io9_node)
d += elm.Dot().at(io9_node)
d += elm.Resistor().at(io9_node).up(1.6).label("10k", fontsize=7.5, loc="left")
d += vdd_flag((io9_node[0], io9_node[1] + 1.6), "3V3")
d += elm.Switch().at(io9_node).down(1.6).label("SW1\nBOOT tact\nC79174", fontsize=7, loc="left")
d += gnd((io9_node[0], io9_node[1] - 1.6))

# IO8: 10k pullup to 3V3 ONLY (rev A3 item 7 -- LED2 moved off this
# strapping pin to IO7; IO8 must read HIGH at boot for J2 UART flashing,
# so it now carries nothing but the pullup that guarantees that level)
io8_pin = u1.absanchors["IO8"]
io8_node = (io8_pin[0] + 1.2, io8_pin[1])
d += elm.Line().at(io8_pin).to(io8_node)
d += elm.Dot().at(io8_node)
d += elm.Resistor().at(io8_node).up(1.6).label("R10\n10k\nC2906982", fontsize=7.5, loc="right")
d += vdd_flag((io8_node[0], io8_node[1] + 1.6), "3V3")

# =====================================================================
# ZONE 4 (x 36-46):  TCAN330DR CAN transceiver + PESD2CANFD24V + R120 DNP
# (rev A3 item 4: TJA1051T/3 REPLACED -- its VCC needs 4.5-5.5V and this
#  design has only a single 3.3V rail. TCAN330DR pin map VERIFIED against
#  the live TI datasheet (SOIC-8, D package) via LCSC's hosted PDF viewer:
#  1=TXD,2=GND,3=VCC,4=RXD,5=SHDN,6=CANL,7=CANH,8=S -- note this is pins 5
#  and 8 SWAPPED from the ticket's proposed map (5=S,8=SHDN), which was
#  itself wrong; SHDN (pin5, "drive high for shutdown, internal pulldown")
#  ties to GND so the device stays alive, S (pin8, "drive high for silent
#  mode, internal pulldown") goes to IO6 for the firmware hw listen-only
#  control -- functionally identical to the TJA1051T/3's S pin.)
# =====================================================================
d += elm.Label().at((36, 20.6)).label("(4) TCAN330DR CAN TRANSCEIVER + ESD", fontsize=10, halign="left")

u2 = elm.Ic(
    size=(3, 6),
    pins=[
        IcPin(name="TXD", pin="1", side="L", slot="1/3"),
        IcPin(name="RXD", pin="4", side="L", slot="2/3"),
        IcPin(name="S", pin="8", side="L", slot="3/3"),
        IcPin(name="CANH", pin="7", side="R", slot="1/2"),
        IcPin(name="CANL", pin="6", side="R", slot="2/2"),
        IcPin(name="VCC", pin="3", side="T", slot="1/2"),
        IcPin(name="SHDN", pin="5", side="T", slot="2/2"),
        IcPin(name="GND", pin="2", side="B", slot="1/1"),
    ],
).at((38, 13)).label("U2\nTCAN330DR\nC2652876", loc="center", fontsize=8)
d += u2

# IO4 -> U2.TXD, IO5 <- U2.RXD, IO6 -> U2.S  (cross zone3/4 wires, adjacent zones)
io4 = u1.absanchors["IO4"]
io5 = u1.absanchors["IO5"]
io6 = u1.absanchors["IO6"]
txd = u2.absanchors["TXD"]
rxd = u2.absanchors["RXD"]
s_pin = u2.absanchors["S"]

d += elm.Line().at(io4).to((io4[0] + 1.0, io4[1]))
d += elm.Line().to((txd[0] - 1.0, txd[1]))
d += elm.Line().to(txd)
d += elm.Label().at(((io4[0] + txd[0]) / 2, io4[1] + 0.25)).label("IO4 -> TXD (CAN TX)", fontsize=6.5)

d += elm.Line().at(io5).to((io5[0] + 0.7, io5[1]))
d += elm.Line().to((rxd[0] - 0.7, rxd[1]))
d += elm.Line().to(rxd)
d += elm.Label().at(((io5[0] + rxd[0]) / 2, io5[1] + 0.25)).label("IO5 <- RXD (CAN RX)", fontsize=6.5)

d += elm.Line().at(io6).to((io6[0] + 0.4, io6[1]))
d += elm.Line().to((s_pin[0] - 0.4, s_pin[1]))
d += elm.Line().to(s_pin)
d += elm.Label().at(((io6[0] + s_pin[0]) / 2, io6[1] + 0.25)).label("IO6 -> S (silent/listen-only)", fontsize=6.5)

# U2.VCC -> 3V3 (+100nF decouple), U2.SHDN -> GND (device stays enabled;
# firmware's only hw-level control is the S pin above), U2.GND -> GND
vcc = u2.absanchors["VCC"]
shdn = u2.absanchors["SHDN"]
d += vdd_flag((vcc[0], vcc[1] + 1.0), "3V3")
d += elm.Line().at(vcc).up(1.0)
d += elm.Capacitor().at((vcc[0] - 0.9, vcc[1] + 0.5)).down(1.1).label("100nF", fontsize=7, loc="bottom")
d += gnd((vcc[0] - 0.9, vcc[1] - 0.6))
d += elm.Line().at(shdn).up(1.0)
d += gnd((shdn[0], shdn[1] + 1.0))

d += elm.Line().at(u2.absanchors["GND"]).down(0.6)
d += gnd((u2.absanchors["GND"][0], u2.absanchors["GND"][1] - 0.6))

# CANH -> J1.6 , CANL -> J1.14  (far zone1<->zone4: net flags, not a full-sheet wire)
canh = u2.absanchors["CANH"]
canl = u2.absanchors["CANL"]
d += net_flag(canh, "CANH", width=1.7, direction="right")
d += net_flag(canl, "CANL", width=1.7, direction="right")
d += net_flag(j1.absanchors["6"], "CANH", width=1.7, direction="right")
d += net_flag(j1.absanchors["14"], "CANL", width=1.7, direction="right")

# R120 DNP between CANH-CANL (not fitted -- dashed, explicit "DNP")
r120_top = (canh[0] + 3.0, canh[1])
r120_bot = (canl[0] + 3.0, canl[1])
d += elm.Line().at(canh).to(r120_top).linestyle("--")
d += elm.Resistor().at(r120_top).to(r120_bot).linestyle("--").label(
    "R120\nDNP (not fitted)\nbus already terminated", fontsize=7, loc="right"
)
d += elm.Line().at(r120_bot).to(canl).linestyle("--")

# PESD2CAN (D3): CANH -> GND and CANL -> GND, automotive ESD across the bus pins.
# Both diode legs are drawn down to the SAME absolute y (esd_gnd_y) so they land
# on one shared GND node -- avoids a dangling, unconnected diode leg.
esd_x1 = canh[0] + 1.4
esd_x2 = canh[0] + 2.6
esd_gnd_y = canl[1] - 1.6

d += elm.Dot().at((esd_x1, canh[1]))
d += elm.Line().at(canh).to((esd_x1, canh[1]))
d += elm.DiodeTVS().at((esd_x1, canh[1])).to((esd_x1, esd_gnd_y))

d += elm.Dot().at((esd_x2, canl[1]))
d += elm.Line().at(canl).to((esd_x2, canl[1]))
d += elm.DiodeTVS().at((esd_x2, canl[1])).to((esd_x2, esd_gnd_y)).label(
    "D3\nPESD2CANFD24V-TR\nC552486 (Nexperia)", fontsize=7.5, loc="bottom"
)

d += elm.Line().at((esd_x1, esd_gnd_y)).to((esd_x2, esd_gnd_y))
d += gnd(((esd_x1 + esd_x2) / 2, esd_gnd_y))

# =====================================================================
# ZONE 5 (x 24-46, y 0-9):  LEDs + programming header J2
# =====================================================================
d += elm.Label().at((24, 8.6)).label("(5) STATUS LEDs + PROGRAMMING HEADER", fontsize=10, halign="left")

# LED1 (power, green) from 3V3 via 1k -> GND -- independent of U1 pins
led1_top = (25, 7)
d += vdd_flag(led1_top, "3V3")
d += elm.Resistor().at(led1_top).down(1.4).label("R7\n1k\nC2907002", fontsize=7.5, loc="right")
d += elm.LED().down(1.4).label("LED1\ngreen (power)\nC84267", fontsize=7.5, loc="right")
d += gnd((led1_top[0], led1_top[1] - 2.8))

# LED2 (activity, amber/orange) driven from U1.IO7 via 1k -> GND (rev A3
# item 7: moved OFF strapping pin IO8 -- IO8 now carries only R10's pullup)
led2_top = (28, 7)
io7 = u1.absanchors["IO7"]
d += elm.Line().at(io7).to((io7[0] + 0.6, io7[1]))
d += elm.Line().to((led2_top[0], io7[1]))
d += elm.Line().to(led2_top)
d += elm.Resistor().at(led2_top).down(1.4).label("R8\n1k\nC2907002", fontsize=7.5, loc="right")
d += elm.LED().down(1.4).label("LED2\namber/orange (activity)\nIO7-driven, C84269", fontsize=7.5, loc="right")
d += gnd((led2_top[0], led2_top[1] - 2.8))

# J2 UART programming header: 3V3, GND, TXD0, RXD0, IO9, EN
# Netlist sec3 text explicitly states TXD0/RXD0 -> J2 and 3V3/GND -> J2;
# BOM (sec2) additionally lists IO9/BOOT and EN as J2 pins 5/6 (needed for
# auto-reset/boot-strap during flashing). Both nets already exist in this
# design (IO9 pulldown/SW1 node, EN RC node) so J2 taps them -- see report
# for this interpretation note (no DESIGN.md edit made).
j2 = elm.Ic(
    size=(2, 5),
    pins=[
        IcPin(name="3V3", pin="1", side="L", slot="1/6"),
        IcPin(name="GND", pin="2", side="L", slot="2/6"),
        IcPin(name="TXD0", pin="3", side="L", slot="3/6"),
        IcPin(name="RXD0", pin="4", side="L", slot="4/6"),
        IcPin(name="IO9", pin="5", side="L", slot="5/6"),
        IcPin(name="EN", pin="6", side="L", slot="6/6"),
    ],
).at((36, 2)).label("J2\n1x6 2.54mm header\nC2337 (cut to 6 pins)", loc="center", fontsize=8)
d += j2

txd0 = u1.absanchors["TXD0"]
rxd0 = u1.absanchors["RXD0"]
u1gnd = u1.absanchors["GND"]

d += elm.Line().at(txd0).down(0.6)
d += elm.Line().to((txd0[0], j2.absanchors["TXD0"][1]))
d += elm.Line().to(j2.absanchors["TXD0"])

d += elm.Line().at(rxd0).down(0.9)
d += elm.Line().to((rxd0[0], j2.absanchors["RXD0"][1]))
d += elm.Line().to(j2.absanchors["RXD0"])

d += elm.Line().at(u1gnd).down(0.5)
d += elm.Line().to((u1gnd[0], j2.absanchors["GND"][1]))
d += elm.Line().to(j2.absanchors["GND"])
d += gnd((j2.absanchors["GND"][0] - 1.0, j2.absanchors["GND"][1]))

d += vdd_flag((j2.absanchors["3V3"][0] - 1.0, j2.absanchors["3V3"][1]), "3V3")
d += elm.Line().at((j2.absanchors["3V3"][0] - 1.0, j2.absanchors["3V3"][1])).to(j2.absanchors["3V3"])

d += elm.Line().at(io9_node).to((io9_node[0], -1.5))
d += elm.Line().to((j2.absanchors["IO9"][0] - 2.0, -1.5))
d += elm.Line().to((j2.absanchors["IO9"][0] - 2.0, j2.absanchors["IO9"][1]))
d += elm.Line().to(j2.absanchors["IO9"])

d += elm.Line().at(en1_node).to((en1_node[0], -2.1))
d += elm.Line().to((j2.absanchors["EN"][0] - 2.6, -2.1))
d += elm.Line().to((j2.absanchors["EN"][0] - 2.6, j2.absanchors["EN"][1]))
d += elm.Line().to(j2.absanchors["EN"])

# =====================================================================
# BOM / legend block
# =====================================================================
bom_lines = [
    "BOM rev A3 (ref: LCSC part -- every number below verified live against LCSC/datasheet, see ticket report)",
    "U1 ESP32-C3-MINI-1-N4 C2838502   U2 TCAN330DR C2652876 (was TJA1051T/3 -- VCC needed 4.5-5.5V)",
    "U3 TPS54202DDCR C191884   D1 SMBJ18A TVS C151256 (was SMBJ24A)   D2 SS34B Schottky (SMB) C880746",
    "D3 PESD2CANFD24V-TR C552486 (Nexperia)   F1 0603 PTC 350mA 16V C910820   L1 10uH 2A shielded C167223",
    "J1/J2 1x40P 2.54mm header (cut to length) C2337   SW1 side tact EVQPUC02K C79174",
    "C1/C2 10uF/50V X7R 1210 C138687   C3/C4 22uF/10V X7R 0805 C907991   C5/C6/C9 100nF/50V 0603 C1591",
    "C7 10uF/25V 0603 C96446   C8 1uF/25V 0603 C5673",
    "R1 100k C25803 / R2 22.1k C25961 (FB div)   R3 133k C22870 / R4 24k C23352 (EN UVLO div, 137k target OOS)",
    "R5/R6/R10 10k C2906982   R7/R8 1k C2907002   R120 DNP (CAN term, not fitted)",
    "LED1 green C84267   LED2 amber/orange C84269",
    "Nets: 12V_RAW, NET_FUSED, VIN_PROT, 3V3, GND, CANH, CANL  (flags = net ties, not physical wire runs)",
]
for i, line in enumerate(bom_lines):
    d += elm.Label().at((0.2, -3.5 - i * 0.7)).label(line, fontsize=7.5, halign="left")

d.draw(show=False)
d.save(str(OUT_SVG))
print(f"Wrote {OUT_SVG}")
