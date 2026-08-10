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
# ZONE 1 (x 0-9):  OBD-II input + protection
#   J1.16 -> F1.1 ; F1.2 -> D2.A ; D2.K -> VIN_PROT
#   D1 (SMBJ24A TVS): VIN_PROT -> GND
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
    "J1\nOBD-II (J1962) male plug\nC718401 (pigtail fallback)\n"
    "pins 16/4/5/6/14 used;\nothers NC rev A",
    loc="center", fontsize=8,
)
d += j1

# --- 12V_RAW: J1.16 -> F1.1 ---
d += elm.Line().at(j1.absanchors["16"]).right(0.6)
f1 = elm.Fuse().right(2).label("F1\nPTC 350mA 0603\nC88724", fontsize=7.5)
d += f1
d += net_flag(j1.absanchors["16"], "12V_RAW", width=1.7, direction="left")

# --- GND: J1.4, J1.5 -> GND plane ---
d += elm.Line().at(j1.absanchors["4"]).right(0.5)
d += gnd((j1.absanchors["4"][0] + 0.5, j1.absanchors["4"][1]))
d += elm.Line().at(j1.absanchors["5"]).right(0.9)
d += gnd((j1.absanchors["5"][0] + 0.9, j1.absanchors["5"][1]))

# --- F1.2 -> D2.A ; D2.K -> VIN_PROT ---
d2 = elm.Diode().right(2).label("D2\nSS34 Schottky\nC8678", fontsize=7.5)
d += d2
vin_prot = d2.end

# --- D1 (SMBJ24A TVS): VIN_PROT -> GND ---
d += elm.Dot().at(vin_prot)
d += elm.DiodeTVS().at(vin_prot).down(2.4).label("D1\nSMBJ24A TVS\nC114213", loc="bottom", fontsize=7.5)
d += gnd((vin_prot[0], vin_prot[1] - 2.4))

# --- Cin x2 22uF/35V, VIN_PROT -> GND (close to U3.VIN, drawn here, zone1/2 boundary) ---
cin1_top = (vin_prot[0] + 1.6, vin_prot[1])
d += elm.Line().at(vin_prot).to(cin1_top)
d += elm.Dot().at(cin1_top)
d += elm.Capacitor().at(cin1_top).down(2.4).label("C1\n22uF/35V", loc="bottom", fontsize=7.5)
d += gnd((cin1_top[0], cin1_top[1] - 2.4))

cin2_top = (cin1_top[0] + 1.4, vin_prot[1])
d += elm.Line().at(cin1_top).to(cin2_top)
d += elm.Dot().at(cin2_top)
d += elm.Capacitor().at(cin2_top).down(2.4).label("C2\n22uF/35V", loc="bottom", fontsize=7.5)
d += gnd((cin2_top[0], cin2_top[1] - 2.4))

vin_prot_rail_end = cin2_top
d += net_flag(vin_prot_rail_end, "VIN_PROT", width=2.0, direction="right")

# =====================================================================
# ZONE 2 (x 11-22):  TPS54202 buck
#   U3.VIN <- VIN_PROT ; BST cap SW->BST ; L1 SW->VOUT_3V3(=3V3)
#   FB divider 100k/13k ; EN divider 100k/24k off VIN_PROT
# =====================================================================
d += elm.Label().at((11, 20.6)).label("(2) TPS54202 BUCK 12V -> 3V3 (2A)", fontsize=10, halign="left")

u3 = elm.Ic(
    size=(3, 6),
    pins=[
        IcPin(name="VIN", side="L", slot="1/2"),
        IcPin(name="EN", side="L", slot="2/2"),
        IcPin(name="BST", side="T", slot="1/1"),
        IcPin(name="SW", side="R", slot="1/2"),
        IcPin(name="FB", side="R", slot="2/2"),
        IcPin(name="GND", side="B", slot="1/1"),
    ],
).at((13, 14)).label("U3\nTPS54202DDCR\nC316922", loc="center", fontsize=8)
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
d += elm.Inductor2().at(sw_pt).right(2.2).label("L1\n10uH 2A shielded\nC167219", fontsize=7.5)
vout = (sw_pt[0] + 2.2, sw_pt[1])
d += elm.Dot().at(vout)

# FB divider: VOUT_3V3 -100k- FB -13k- GND ; FB node wired across to U3.FB
fb_node = (vout[0] + 1.6, vout[1] - 2.2)
d += elm.Resistor().at(vout).down(1.8).label("R_fb1\n100k", fontsize=7.5, loc="right")
r_fb1_end = (vout[0], vout[1] - 1.8)
d += elm.Line().at(r_fb1_end).to(fb_node)
d += elm.Dot().at(fb_node)
d += elm.Resistor().at(fb_node).down(1.8).label("R_fb2\n13k", fontsize=7.5, loc="right")
d += gnd((fb_node[0], fb_node[1] - 1.8))
fb_pt = u3.absanchors["FB"]
d += elm.Line().at(fb_node).to((fb_pt[0], fb_node[1]))
d += elm.Line().to(fb_pt)

# C_out x2 22uF, VOUT_3V3 -> GND
cout1_top = (vout[0] + 3.2, vout[1])
d += elm.Line().at(vout).to(cout1_top)
d += elm.Dot().at(cout1_top)
d += elm.Capacitor().at(cout1_top).down(2.2).label("C3\n22uF/10V", loc="bottom", fontsize=7.5)
d += gnd((cout1_top[0], cout1_top[1] - 2.2))

cout2_top = (cout1_top[0] + 1.4, vout[1])
d += elm.Line().at(cout1_top).to(cout2_top)
d += elm.Dot().at(cout2_top)
d += elm.Capacitor().at(cout2_top).down(2.2).label("C4\n22uF/10V", loc="bottom", fontsize=7.5)
d += gnd((cout2_top[0], cout2_top[1] - 2.2))

vout_3v3_end = cout2_top
d += vdd_flag((vout_3v3_end[0] + 0.4, vout_3v3_end[1]), "3V3")
d += elm.Line().at(vout_3v3_end).to((vout_3v3_end[0] + 0.4, vout_3v3_end[1]))

# EN divider: EN -> 100k -> VIN_PROT ; EN -> 24k -> GND
en_pt = u3.absanchors["EN"]
en_node = (en_pt[0] - 1.6, en_pt[1])
d += elm.Line().at(en_pt).to(en_node)
d += elm.Dot().at(en_node)
d += elm.Resistor().at(en_node).up(1.8).label("R_en1\n100k", fontsize=7.5, loc="left")
en_top = (en_node[0], en_node[1] + 1.8)
d += net_flag(en_top, "VIN_PROT", width=2.0, direction="up")
d += elm.Resistor().at(en_node).down(1.8).label("R_en2\n24k", fontsize=7.5, loc="left")
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
        IcPin(name="IO4", side="R", slot="1/4"),
        IcPin(name="IO5", side="R", slot="2/4"),
        IcPin(name="IO6", side="R", slot="3/4"),
        IcPin(name="IO8", side="R", slot="4/4"),
        IcPin(name="3V3", side="T", slot="1/1"),
        IcPin(name="TXD0", side="B", slot="1/4"),
        IcPin(name="RXD0", side="B", slot="2/4"),
        IcPin(name="GND", side="B", slot="3/4"),
    ],
).at((26, 13)).label("U1\nESP32-C3-MINI-1-N4\nC3013922", loc="center", fontsize=8)
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
d += elm.Switch().at(io9_node).down(1.6).label("SW1\nBOOT tact\nC318884", fontsize=7, loc="left")
d += gnd((io9_node[0], io9_node[1] - 1.6))

# =====================================================================
# ZONE 4 (x 36-46):  TJA1051T/3 CAN transceiver + PESD2CAN + R120 DNP
# =====================================================================
d += elm.Label().at((36, 20.6)).label("(4) TJA1051T/3 CAN TRANSCEIVER + ESD", fontsize=10, halign="left")

u2 = elm.Ic(
    size=(3, 6),
    pins=[
        IcPin(name="TXD", side="L", slot="1/3"),
        IcPin(name="RXD", side="L", slot="2/3"),
        IcPin(name="S", side="L", slot="3/3"),
        IcPin(name="CANH", side="R", slot="1/2"),
        IcPin(name="CANL", side="R", slot="2/2"),
        IcPin(name="VCC", side="T", slot="1/2"),
        IcPin(name="VIO", side="T", slot="2/2"),
        IcPin(name="GND", side="B", slot="1/1"),
    ],
).at((38, 13)).label("U2\nTJA1051T/3\nC264757", loc="center", fontsize=8)
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

# U2.VCC / VIO -> 3V3 (+100nF decouple on VCC), U2.GND -> GND
vcc = u2.absanchors["VCC"]
vio = u2.absanchors["VIO"]
d += vdd_flag((vcc[0], vcc[1] + 1.0), "3V3")
d += elm.Line().at(vcc).up(1.0)
d += elm.Capacitor().at((vcc[0] - 0.9, vcc[1] + 0.5)).down(1.1).label("100nF", fontsize=7, loc="bottom")
d += gnd((vcc[0] - 0.9, vcc[1] - 0.6))
d += elm.Line().at(vio).up(1.0)
d += vdd_flag((vio[0], vio[1] + 1.0), "3V3")

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
    "D3\nPESD2CAN\nC24911", fontsize=7.5, loc="bottom"
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
d += elm.Resistor().at(led1_top).down(1.4).label("R_l1\n1k", fontsize=7.5, loc="right")
d += elm.LED().down(1.4).label("LED1\ngreen (power)", fontsize=7.5, loc="right")
d += gnd((led1_top[0], led1_top[1] - 2.8))

# LED2 (activity, amber) driven from U1.IO8 via 1k -> GND
led2_top = (28, 7)
io8 = u1.absanchors["IO8"]
d += elm.Line().at(io8).to((io8[0] + 0.6, io8[1]))
d += elm.Line().to((led2_top[0], io8[1]))
d += elm.Line().to(led2_top)
d += elm.Resistor().at(led2_top).down(1.4).label("R_l2\n1k", fontsize=7.5, loc="right")
d += elm.LED().down(1.4).label("LED2\namber (activity)\nIO8-driven", fontsize=7.5, loc="right")
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
).at((36, 2)).label("J2\n1x6 2.54mm header\n(UART programming)", loc="center", fontsize=8)
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
    "BOM (ref: LCSC part -- see hardware/DESIGN.md sec 2 for full table)",
    "U1 ESP32-C3-MINI-1-N4 C3013922   U2 TJA1051T/3 C264757   U3 TPS54202DDCR C316922",
    "D1 SMBJ24A TVS C114213   D2 SS34 Schottky C8678   D3 PESD2CAN C24911   F1 0603 PTC 350mA C88724",
    "L1 10uH 2A shielded C167219   J1 OBD-II plug C718401   SW1 side tact C318884",
    "C1/C2 22uF/35V   C3/C4 22uF/10V   R_fb1 100k / R_fb2 13k (FB div)   R_en1 100k / R_en2 24k (EN UVLO div)",
    "R120 DNP (CAN term, not fitted)   LED1 green + 1k   LED2 amber + 1k",
    "Nets: 12V_RAW, VIN_PROT, 3V3, GND, CANH, CANL  (flags = net ties, not physical wire runs)",
]
for i, line in enumerate(bom_lines):
    d += elm.Label().at((0.2, -3.5 - i * 0.7)).label(line, fontsize=7.5, halign="left")

d.draw(show=False)
d.save(str(OUT_SVG))
print(f"Wrote {OUT_SVG}")
