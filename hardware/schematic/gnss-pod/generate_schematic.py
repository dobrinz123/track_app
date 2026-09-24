#!/usr/bin/env python3
"""
TRACE GNSS Pod rev A -- schematic generator (schemdraw -> SVG, for human review).

Renders hardware/schematic/gnss-pod/gnss-pod.svg from the BINDING netlist in
hardware/gnss-pod/DESIGN-REV-A.md section 4. The pin -> net connections come
from hardware/kicad/gnss-pod/netlist_spec.py, the same table the PCB generator
assigns and self-checks against, so schematic and board cannot drift apart.
Pin function names follow the pin maps in DESIGN-REV-A.md section 5.

Style: every IC pin and every passive terminal carries its net name as a flag
(net-label schematic, like the dongle's net_flag() for long nets). Pins with
the same flag are connected. "NC" marks a spec no-connect.

Run with a Python that has schemdraw (KiCad 10's bundled Python has it):
    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" generate_schematic.py

Deterministic: fixed coordinates and no timestamps, so a re-run gives the same SVG.
"""
import os
import sys

import schemdraw
import schemdraw.elements as elm
from schemdraw.elements import IcPin

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "hardware", "kicad", "gnss-pod"))
import netlist_spec as spec  # noqa: E402

OUT_SVG = os.path.join(HERE, "gnss-pod.svg")
P2N = spec.pad_to_net()
NC = set(spec.NO_CONNECT)

# LCSC / value text (spec sec 3)
PART = {
    "U1": "ESP32-S3-MINI-1-N8  C2913206", "U2": "SAM-M10Q-00B  C5443880", "U3": "LSM6DSV16XTR  C5267406",
    "U4": "BQ24073RGTR  C15220", "U5": "TLV75733PDYDR  C22399950", "U6": "XC6206P332MR-G  C5446",
    "U7": "USBLC6-2SC6  C7519", "J1": "HRO TYPE-C-31-M-12  C165948",
    "J2": "JST B3B-PH-K-S  C131339 (hand-solder, pack with NTC)", "J3": "1x8 2.54 pad row (DNP)",
    "SW1": "BOOT  TS-1187A C318884", "SW2": "RESET  TS-1187A C318884",
    "SW3": "POWER  SS-12D00-G3 C22355741 (hand-solder)",
    "RT1": "DNP 10k NTC C13564 (fallback, pack w/o NTC)", "LED1": "yellow C2287", "LED2": "red C2286", "LED3": "red C2286 (CHG)",
    "C1": "1u 50V 0603", "C2": "22u 25V 0805", "C3": "22u 25V 0805", "C4": "1u 0402", "C5": "10u 0603",
    "C6": "22u 0805", "C7": "100n", "C8": "1u", "C9": "4.7u", "C10": "100n", "C11": "100n", "C12": "1u",
    "C13": "1u", "C14": "100n", "C15": "100n", "C16": "100n", "C17": "DNP", "C18": "DNP",
    "R1": "5.1k", "R2": "5.1k", "R3": "22R", "R4": "22R", "R5": "10k", "R6": "10k", "R7": "4.7k", "R8": "4.7k",
    "R9": "3.3k", "R10": "1.5k", "R11": "1.5k", "R12": "100k", "R13": "1M", "R14": "1M", "R15": "1k",
    "R16": "1k", "R17": "0R",
}

# IC pin functions (spec sec 5). (pin, function, side)
IC_PINS = {
    "U1": [("3", "3V3", "L"), ("45", "EN", "L"), ("4", "IO0/BOOT", "L"), ("5", "IO1/ADC1_0", "L"),
           ("6", "IO2", "L"), ("12", "IO8", "L"), ("13", "IO9/SDA", "L"), ("14", "IO10/SCL", "L"),
           ("16", "IO12", "L"), ("17", "IO13", "L"), ("28", "IO33", "L"),
           ("29", "IO34", "L"), ("31", "IO35", "L"), ("32", "IO36", "L"), ("33", "IO37", "L"),
           ("23", "IO19/D-", "R"), ("24", "IO20/D+", "R"), ("25", "IO21", "R"), ("34", "IO38/U1TX", "R"),
           ("35", "IO39/U1RX", "R"), ("36", "IO40", "R"), ("37", "IO41", "R"), ("39", "TXD0", "R"),
           ("40", "RXD0", "R"), ("27", "IO47", "R"), ("7", "IO3 strap", "R"),
           ("41", "IO45 strap", "R"), ("44", "IO46 strap", "R"),
           ("1,2,42,43,46-65", "GND+EPAD", "B")],
    "U2": [("17", "VCC", "L"), ("2", "V_IO", "L"), ("3", "V_BCKP", "L"), ("14", "RXD", "L"), ("13", "TXD", "L"),
           ("7", "TIMEPULSE", "R"), ("8", "SAFEBOOT_N", "R"), ("18", "RESET_N", "R"), ("19", "EXTINT", "R"),
           ("9", "SDA", "R"), ("12", "SCL", "R"),
           ("1,4,5,6,10,11,15,16,20", "GND", "B")],
    "U3": [("8", "Vdd", "L"), ("5", "Vdd_IO", "L"), ("12", "CS", "L"), ("14", "SDA", "L"), ("13", "SCL", "L"),
           ("4", "INT1", "R"), ("9", "INT2", "R"), ("1", "SDO/SA0", "R"), ("2", "SDx", "R"), ("3", "SCx", "R"),
           ("10", "OCS_Aux", "R"), ("11", "SDO_Aux", "R"), ("6,7", "GND", "B")],
    "U4": [("13", "IN", "L"), ("6", "EN1", "L"), ("5", "EN2", "L"), ("4", "CE_N", "L"), ("15", "TD", "L"),
           ("14", "TMR", "L"), ("16", "ISET", "L"), ("12", "ILIM", "L"),
           ("10,11", "OUT", "R"), ("2,3", "BAT", "R"), ("1", "TS", "R"), ("9", "CHG_N", "R"), ("7", "PGOOD_N", "R"),
           ("8,17", "VSS+PAD", "B")],
    "U5": [("1", "IN", "L"), ("3", "EN", "L"), ("5", "OUT", "R"), ("4", "NC", "R"), ("2,6", "GND+PAD", "B")],
    "U6": [("3", "VIN", "L"), ("2", "VOUT", "R"), ("1", "VSS", "B")],
    "U7": [("1,6", "I/O1", "L"), ("3,4", "I/O2", "L"), ("5", "VBUS", "R"), ("2", "GND", "B")],
    "J1": [("A4,A9,B4,B9", "VBUS", "R"), ("A5", "CC1", "R"), ("B5", "CC2", "R"), ("A6,B6", "D+", "R"),
           ("A7,B7", "D-", "R"), ("A8", "SBU1", "R"), ("B8", "SBU2", "R"), ("A1,A12,B1,B12,SH", "GND", "B")],
    "J2": [("1", "BAT+", "R"), ("2", "BAT-", "R"), ("3", "NTC", "R")],
    "J3": [(str(i), str(i), "R") for i in range(1, 9)],
    "SW3": [("1", "ON", "R"), ("2", "COM", "R"), ("3", "OFF", "R")],
}
TWO_PIN = {"R", "C", "LED", "RT", "SW"}


def net_of(ref, pins):
    nets = []
    for p in pins.split(","):
        if "-" in p and ref == "U1":
            a, b = p.split("-")
            rng = [str(n) for n in range(int(a), int(b) + 1)]
        else:
            rng = [p]
        for q in rng:
            if (ref, q) in NC:
                nets.append("NC")
            else:
                nets.append(P2N[(ref, q)])
    u = sorted(set(nets))
    if len(u) != 1:
        raise SystemExit(f"schematic: {ref} pins {pins} span nets {u}")
    return u[0]


def flag(d, pos, name, direction):
    if name == "NC":
        d += elm.Label().at(pos).label("NC x", fontsize=7, halign="left" if direction == "right" else "right")
        return
    if name == "GND":
        d += elm.Ground(lead=0.3).at(pos)
        return
    t = elm.Tag(width=max(1.2, 0.2 * len(name) + 0.4), height=0.45).at(pos)
    t = t.right() if direction == "right" else (t.left() if direction == "left" else t.down())
    d += t.label(name, fontsize=7)


def draw_ic(d, ref, x, y, width=4.2):
    pins = IC_PINS[ref]
    sides = {"L": [p for p in pins if p[2] == "L"], "R": [p for p in pins if p[2] == "R"],
             "B": [p for p in pins if p[2] == "B"]}
    n = max(len(sides["L"]), len(sides["R"]), 1)
    h = 0.7 * n + 0.6
    icpins = []
    for side in ("L", "R", "B"):
        for k, (pn, fn, _) in enumerate(sides[side]):
            icpins.append(IcPin(name=fn, pin=pn, side=side, slot=f"{k + 1}/{len(sides[side])}",
                                anchorname=f"a{side}{k}", pinlblsize=6.5, lblsize=7.5))
    ic = elm.Ic(size=(width, h), pins=icpins, pinspacing=0.7).at((x, y)).theta(0).label(
        f"{ref}\n{PART.get(ref, '')}", loc="top", fontsize=8)
    d += ic
    for side, lst in sides.items():
        for k, (pn, fn, _) in enumerate(lst):
            a = ic.absanchors[f"a{side}{k}"]
            net = net_of(ref, pn)
            if side == "L":
                d += elm.Line().at(a).left(0.5)
                flag(d, (a[0] - 0.5, a[1]), net, "left")
            elif side == "R":
                d += elm.Line().at(a).right(0.5)
                flag(d, (a[0] + 0.5, a[1]), net, "right")
            else:
                d += elm.Line().at(a).down(0.3)
                flag(d, (a[0], a[1] - 0.3), net, "down")
    return ic


def draw_two(d, ref, x, y):
    kind = ref.rstrip("0123456789")
    n1, n2 = net_of(ref, "1"), net_of(ref, "2")
    top = (x, y)
    if kind == "R":
        e = elm.Resistor()
    elif kind == "RT":
        e = elm.Thermistor()
    elif kind == "C":
        e = elm.Capacitor()
    elif kind == "LED":
        e = elm.LED().reverse()   # pad 2 = anode on top, pad 1 = cathode below
        n1, n2 = n2, n1
    else:
        e = elm.Button()
    d += e.at(top).down(1.4).label(f"{ref}\n{PART.get(ref, '')}", loc="right", fontsize=7)
    flag(d, top, n1, "up_tag")
    flag(d, (x, y - 1.4), n2, "down")


def flag_up(d, pos, name):
    if name == "GND":
        d += elm.Ground(lead=0.3).at(pos)
        return
    d += elm.Label().at((pos[0], pos[1] + 0.25)).label(name, fontsize=7)
    d += elm.Dot(radius=0.06).at(pos)


# route the "up_tag" direction used for the top terminal of two-pin parts
_flag = flag


def flag(d, pos, name, direction):  # noqa: F811
    if direction == "up_tag":
        return flag_up(d, pos, name)
    return _flag(d, pos, name, direction)


def main():
    schemdraw.theme("default")
    d = schemdraw.Drawing(file=OUT_SVG, show=False)
    d.config(fontsize=8, unit=1.5)
    d += elm.Label().at((0, 2.5)).label(
        "TRACE GNSS Pod rev A -- schematic (net-label style). Binding netlist: hardware/gnss-pod/DESIGN-REV-A.md sec 4; "
        "pin maps sec 5. Generated by hardware/schematic/gnss-pod/generate_schematic.py from netlist_spec.py "
        "(same table the PCB is self-checked against).", fontsize=9, halign="left")

    # row 1: USB input, charger, LDOs
    d += elm.Label().at((0, 0.8)).label("(1) USB-C INPUT + ESD", fontsize=10, halign="left")
    draw_ic(d, "J1", 2.5, -6.5, width=3.0)
    draw_ic(d, "U7", 10.5, -3.5, width=2.6)
    for i, r in enumerate(["R1", "R2", "R3", "R4", "C17", "C18", "C1"]):
        draw_two(d, r, 8.5 + i * 2.2, -8.0)

    d += elm.Label().at((25, 0.8)).label("(2) CHARGER BQ24073 (USB500, ISET 3.3k ~270 mA) + BATTERY + POWER SWITCH",
                                          fontsize=10, halign="left")
    draw_ic(d, "U4", 29, -7.5, width=3.4)
    for i, r in enumerate(["C2", "C3", "R9", "R10", "RT1", "R11", "LED3", "R12"]):
        draw_two(d, r, 37.5 + i * 2.3, -1.5)
    draw_ic(d, "J2", 38.5, -8.5, width=2.2)
    draw_ic(d, "SW3", 46.5, -8.5, width=2.2)

    d += elm.Label().at((58, 0.8)).label("(3) 3V3 LDO TLV75733P + GNSS BACKUP XC6206", fontsize=10, halign="left")
    draw_ic(d, "U5", 60.5, -3.5, width=2.6)
    draw_ic(d, "U6", 60.5, -9.5, width=2.6)
    for i, r in enumerate(["C4", "C5", "C12", "C13", "R17", "C11"]):
        draw_two(d, r, 66.5 + i * 2.2, -3.0)

    # row 2: MCU
    d += elm.Label().at((0, -14.5)).label("(4) ESP32-S3-MINI-1-N8 + boot/reset/status/ADC/spare",
                                           fontsize=10, halign="left")
    draw_ic(d, "U1", 5.5, -26.5, width=5.0)
    for i, r in enumerate(["C6", "C7", "R5", "C8", "SW2", "R6", "SW1", "R13", "R14", "C16", "R15", "LED1",
                           "R16", "LED2"]):
        draw_two(d, r, 17.5 + (i % 7) * 2.4, -17.0 - (i // 7) * 4.2)
    draw_ic(d, "J3", 20.5, -30.0, width=2.0)

    # row 2 right: GNSS + IMU
    d += elm.Label().at((36, -14.5)).label("(5) GNSS SAM-M10Q (UART1, PPS, RESET_N, EXTINT; I2C unused)",
                                            fontsize=10, halign="left")
    draw_ic(d, "U2", 41, -22.5, width=3.6)
    for i, r in enumerate(["C9", "C10"]):
        draw_two(d, r, 49 + i * 2.3, -17.5)
    d += elm.Label().at((56, -14.5)).label("(6) IMU LSM6DSV16X (I2C 0x6A)", fontsize=10, halign="left")
    draw_ic(d, "U3", 61, -22.0, width=3.4)
    for i, r in enumerate(["C14", "C15", "R7", "R8"]):
        draw_two(d, r, 67.5 + i * 2.3, -17.5)

    # test pads
    tps = []
    for i in range(1, 20):
        tps.append(f"TP{i}={P2N[(f'TP{i}', '1')]}")
    d += elm.Label().at((36, -31.5)).label("Test pads (1.0 mm, bottom, electronics zone): " + ", ".join(tps[:10]),
                                            fontsize=8, halign="left")
    d += elm.Label().at((36, -32.3)).label(", ".join(tps[10:]), fontsize=8, halign="left")
    notes = [
        "Notes: U2 V_IO (pin 2) and VCC (pin 17) are joined through the 3V3 rail, each with its own bypass",
        "(C10 on V_IO, C9 on VCC): a one-layer tie round the module corner would trap RESET_N/EXTINT (see PCB report).",
        "SW1/SW2 pads '1' = contacts A+B (internally shorted), pads '2' = C+D. SW3 pin 2 (middle) = common.",
        "Firmware: never drive GPIO21 (PPS); drive GPIO40 open-drain only; VBAT on ADC1 ATTEN3 (spec sec 6).",
    ]
    for i, n in enumerate(notes):
        d += elm.Label().at((36, -33.6 - 0.8 * i)).label(n, fontsize=8, halign="left")
    d.draw(show=False)
    d.save(OUT_SVG)
    print(f"Wrote {OUT_SVG}")


if __name__ == "__main__":
    main()
