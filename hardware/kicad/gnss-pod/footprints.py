#!/usr/bin/env python3
"""
TRACE GNSS Pod rev A -- custom footprint writer.

Called by generate_board.py before placement. Writes fp-lib/TRACE-GNSS.pretty/.
Deterministic: same input, byte-identical output. Plain text s-expressions,
no uuids (KiCad assigns them on load).

Every pad dimension below cites its drawing. Nothing here comes from memory.
The drawings were downloaded on 2026-09-24 from the URLs in
hardware/gnss-pod/DESIGN-REV-A.md section 12 and rendered page by page to
check each number.

  u-blox_SAM-M10Q      u-blox SAM-M10Q Integration Manual UBX-22020019 R02,
                       section 4.4.1: Figure 23 (footprint and solder mask
                       opening) and Figure 24 (paste mask per pad). Pin
                       order from Data Sheet UBX-22013293 R05, Figure 2
                       (top view) and Table 9. The IM (Appendix A.1) states
                       "SAM-M10Q is pin-to-pin compatible with the SAM-M8Q
                       module". The footprint below is still built from the
                       M10Q figures, not copied from KiCad's ublox_SAM-M8Q.
  ESP32-S3-MINI-1      Espressif ESP32-S3-MINI-1 & MINI-1U Datasheet v1.7,
                       Figure 11-1 (recommended PCB land pattern) and
                       Figure 3-1 / Table 3-1 (pin layout). The pad
                       coordinates match Espressif's official KiCad library
                       footprint (github.com/espressif/kicad-libraries,
                       footprints/Espressif.pretty/ESP32-S3-MINI-1.kicad_mod
                       at commit dd76561812ab300351234ba6e0ec1295641796f0).
                       Checked against Fig. 11-1: 60 x 0.4x0.8 pads, pad-row
                       centres 14.0 apart, first-to-last pad centres 11.9
                       apart (0.85 pitch), 4 x 0.8x0.8 corner pads, EPAD =
                       3x3 grid of 1.2 squares, 4.5 overall (pitch 1.65),
                       pin-1 square chamfered 0.6, EPAD centred on the pad
                       field, module 15.4 x 20.5, antenna band 5.05 deep.
                       The footprint-level keep-out zone of Espressif's file
                       is dropped. generate_board.py draws a board-level,
                       full-width, both-layer keep-out instead (spec sec 8 Z3).
  TI_DYD0005A          TI TLV757P datasheet SBVS322C, DYD0005A "Example
                       board layout" (4228946/A 08/2022): 5 x 1.1x0.6 pads,
                       2.6 between the pad-row centres, 0.95 pitch, and a
                       thermal pad 0.975 x 1.7 offset +0.0625 in X from the
                       package centreline. Pin map sec 5: 1 IN, 2 GND,
                       3 EN, 4 NC, 5 OUT, thermal pad = GND (pad "6" here).
  TI_RGT0016C          TI BQ2407x datasheet SLUS810N, RGT0016C "Example
                       board layout" (4222419/E 07/2025): 16 x 0.6x0.24
                       pads, 2.8 between the pad-row centres, 0.5 pitch,
                       thermal pad 1.68 square (pad "17" here). Paste on the
                       thermal pad follows the 1.55 square in the RGT0016C
                       "Example stencil design".
  SOFNG_SS-12D00-G3    SOFNG SS-12D00 drawing (LCSC C22355741 PDF),
                       "P.C.B LAYOUT": 3 holes at 2.5 pitch (5.0 over 3
                       pins). The pins are 0.5 x 0.3 flat, so a 0.9 drill
                       with a 1.6 pad is used. Body 8.8 x 3.9. CIRCUIT
                       DIAGRAM: the middle terminal (filled) is the common
                       one and the slider bridges it to either outer pin.
                       NOTE: the spec's "3 mm pitch" is wrong. G3 in the
                       part number is the 3.0 mm actuator (handle) length;
                       the pin pitch is 2.5 mm.
  LGA-14_2.5x3mm_LSM6DSV16X  ST DS13510 Rev 4 Figure 33 (LGA-14L 2.5 x 3.0 x
                       0.86): leads 0.25 x 0.475 at 0.5 pitch, 0.1 from the
                       body edge. Pad centres = KiCad LGA-14_3x2.5mm_P0.5mm
                       (+-1.1625 / +-0.9125), which match the drawing. Pads
                       are 0.30 x 0.625 (lead + 0.05, extended outward) so
                       the gap between pads is 0.20 mm, the spec's clearance
                       (KiCad's stock 0.35-wide pads leave 0.15 mm). Pin order
                       = DS Fig. 5 mirrored to top view: 1-4 left top->bottom,
                       5-7 bottom left->right, 8-11 right bottom->top, 12-14 top
                       right->left.
  PadRow_1x08_P2.54_SMD  J3 spare-pin pad row (DNP, bare pads, spec sec 3).
                       SMD so it adds nothing to the bottom layer (see
                       generate_board.py placement notes). 1.0 x 2.4 pads
                       at 2.54 pitch.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "fp-lib", "TRACE-GNSS.pretty")


def _f(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _hdr(name, descr, tags, attr="smd", ref_y=-2.0, val_y=2.0):
    return [
        f'(footprint "{name}"',
        '\t(version 20260206)',
        '\t(generator "gnss-pod-footprints.py")',
        '\t(layer "F.Cu")',
        f'\t(descr "{descr}")',
        f'\t(tags "{tags}")',
        f'\t(property "Reference" "REF**" (at 0 {_f(ref_y)} 0) (layer "F.SilkS") (effects (font (size 0.8 0.8) (thickness 0.12))))',
        f'\t(property "Value" "{name}" (at 0 {_f(val_y)} 0) (layer "F.Fab") (effects (font (size 0.8 0.8) (thickness 0.12))))',
        f'\t(attr {attr})',
    ]


def _rect(x0, y0, x1, y1, layer, w):
    return (f'\t(fp_rect (start {_f(x0)} {_f(y0)}) (end {_f(x1)} {_f(y1)}) '
            f'(stroke (width {_f(w)}) (type solid)) (fill no) (layer "{layer}"))')


def _line(x0, y0, x1, y1, layer, w):
    return (f'\t(fp_line (start {_f(x0)} {_f(y0)}) (end {_f(x1)} {_f(y1)}) '
            f'(stroke (width {_f(w)}) (type solid)) (layer "{layer}"))')


def _text(txt, x, y, layer, size=0.6):
    return (f'\t(fp_text user "{txt}" (at {_f(x)} {_f(y)} 0) (layer "{layer}") '
            f'(effects (font (size {_f(size)} {_f(size)}) (thickness 0.1))))')


def _smd(num, x, y, w, h, layers='"F.Cu" "F.Mask" "F.Paste"', shape="rect", extra=""):
    return (f'\t(pad "{num}" smd {shape} (at {_f(x)} {_f(y)}) (size {_f(w)} {_f(h)}) '
            f'(layers {layers}){extra})')


def _write(name, lines):
    os.makedirs(LIB, exist_ok=True)
    with open(os.path.join(LIB, name + ".kicad_mod"), "w", newline="\n") as f:
        f.write("\n".join(lines + [")"]) + "\n")


# ---------------------------------------------------------------------------
def sam_m10q():
    """IM UBX-22020019 R02 Fig. 23: pads 1.5 x 1.8, 5 per side, pitch 1.9
    (1.5 pad + 0.4 gap), outer pad edge flush with the 15.0 x 15.0 land
    outline (7.5 from centre), so pad centres sit 6.6 from centre and
    the outer pads' outer edges are 4.55 from the centreline (3.8 + 0.75).
    Solder mask 0.05 wider per side ("0.1 mm wider than the pad").
    Fig. 24: paste = 4 windows of 0.58 x 0.72 per pad, 0.03 / 0.04 in from
    the pad edge (window centres at +-0.43 / +-0.50 from the pad centre).
    Top view pin order (DS Fig. 2): 1-5 left side top->bottom, 6-10 bottom
    left->right, 11-15 right bottom->top, 16-20 top right->left.
    KiCad Y points down, so "top" = -Y."""
    L = _hdr("u-blox_SAM-M10Q",
             "u-blox SAM-M10Q LGA-20 15.5x15.5mm. Pads/mask: IM UBX-22020019 R02 Fig.23; "
             "paste: Fig.24 (4 windows 0.58x0.72 per pad, 120um stencil); pin order: DS "
             "UBX-22013293 R05 Fig.2. Built by hardware/kicad/gnss-pod/footprints.py",
             "u-blox SAM-M10Q GNSS patch", ref_y=-9.0, val_y=9.0)
    L.append(_rect(-7.75, -7.75, 7.75, 7.75, "F.Fab", 0.1))
    L.append(_rect(-8.0, -8.0, 8.0, 8.0, "F.CrtYd", 0.05))
    L.append(_line(-7.9, -7.9, -5.0, -7.9, "F.SilkS", 0.12))
    L.append(_line(-7.9, -7.9, -7.9, -5.0, "F.SilkS", 0.12))
    L.append(_line(7.9, 7.9, 5.0, 7.9, "F.SilkS", 0.12))
    L.append(_line(7.9, 7.9, 7.9, 5.0, "F.SilkS", 0.12))
    L.append(_line(7.9, -7.9, 5.0, -7.9, "F.SilkS", 0.12))
    L.append(_line(7.9, -7.9, 7.9, -5.0, "F.SilkS", 0.12))
    L.append(_line(-7.9, 7.9, -5.0, 7.9, "F.SilkS", 0.12))
    L.append(_line(-7.9, 7.9, -7.9, 5.0, "F.SilkS", 0.12))
    L.append(_text("1", -8.5, -3.8, "F.SilkS", 0.7))
    L.append(_text("patch antenna side up / 10mm keep-out", 0, 0, "F.Fab", 0.6))
    offs = [-3.8, -1.9, 0.0, 1.9, 3.8]
    pads = []
    for i, o in enumerate(offs):            # 1..5 left, top->bottom
        pads.append((str(1 + i), -6.6, o, True))
    for i, o in enumerate(offs):            # 6..10 bottom, left->right
        pads.append((str(6 + i), o, 6.6, False))
    for i, o in enumerate(reversed(offs)):  # 11..15 right, bottom->top
        pads.append((str(11 + i), 6.6, o, True))
    for i, o in enumerate(reversed(offs)):  # 16..20 top, right->left
        pads.append((str(16 + i), o, -6.6, False))
    for num, x, y, side in pads:
        w, h = (1.8, 1.5) if side else (1.5, 1.8)
        L.append(_smd(num, x, y, w, h, layers='"F.Cu" "F.Mask"',
                      extra=" (solder_mask_margin 0.05)"))
        # paste windows (Fig. 24), rotated with the pad
        for sx in (-1, 1):
            for sy in (-1, 1):
                if side:
                    px, py, pw, ph = x + sx * 0.50, y + sy * 0.43, 0.72, 0.58
                else:
                    px, py, pw, ph = x + sx * 0.43, y + sy * 0.50, 0.58, 0.72
                L.append(_smd("", px, py, pw, ph, layers='"F.Paste"'))
    _write("u-blox_SAM-M10Q", L)


def esp32_s3_mini_1():
    """Espressif datasheet v1.7 Fig. 11-1 + official KiCad library (see module
    docstring). Local origin = pad-field centre. Antenna towards -Y."""
    L = _hdr("ESP32-S3-MINI-1",
             "Espressif ESP32-S3-MINI-1 15.4x20.5mm. Land pattern: datasheet v1.7 Fig.11-1; "
             "pad coordinates identical to espressif/kicad-libraries ESP32-S3-MINI-1.kicad_mod "
             "@dd76561 (verified). Antenna area Y -12.8..-7.75. Built by footprints.py",
             "esp32-s3 mini", ref_y=-13.8, val_y=9.2)
    L.append(_rect(-7.7, -12.8, 7.7, 7.7, "F.Fab", 0.1))
    L.append(_line(-7.7, -7.75, 7.7, -7.75, "F.Fab", 0.1))
    L.append(_text("ANTENNA", 0, -10.3, "F.Fab", 0.8))
    L.append(_rect(-8.0, -13.1, 8.0, 8.0, "F.CrtYd", 0.05))
    # antenna-end silk stops 0.3 mm inside the module edge (it sits on the
    # board edge on this PCB)
    for x0, y0, x1, y1 in [(-7.85, 6.8, -7.85, 7.85), (-7.85, 7.85, -6.8, 7.85),
                           (7.85, 6.8, 7.85, 7.85), (7.85, 7.85, 6.8, 7.85),
                           (-7.85, -12.5, 7.85, -12.5), (-7.85, -12.5, -7.85, -7.9),
                           (7.85, -12.5, 7.85, -7.9)]:
        L.append(_line(x0, y0, x1, y1, "F.SilkS", 0.12))
    L.append(_text("1", -8.6, -5.95, "F.Fab", 0.7))
    p = 0.85
    for i in range(15):                     # 1..15 left column, top->bottom
        L.append(_smd(str(1 + i), -7.0, -5.95 + i * p, 0.8, 0.4))
    for i in range(15):                     # 16..30 bottom row, left->right
        L.append(_smd(str(16 + i), -5.95 + i * p, 7.0, 0.4, 0.8))
    for i in range(15):                     # 31..45 right column, bottom->top
        L.append(_smd(str(31 + i), 7.0, 5.95 - i * p, 0.8, 0.4))
    for i in range(15):                     # 46..60 top row, right->left
        L.append(_smd(str(46 + i), 5.95 - i * p, -7.0, 0.4, 0.8))
    for gx in (-1.65, 0.0, 1.65):           # 61 EPAD, 3x3 of 1.2 squares
        for gy in (-1.65, 0.0, 1.65):
            if gx == -1.65 and gy == -1.65:
                L.append(_smd("61", gx, gy, 1.2, 1.2, shape="roundrect",
                              extra=" (roundrect_rratio 0) (chamfer_ratio 0.5) (chamfer top_left)"))
            else:
                L.append(_smd("61", gx, gy, 1.2, 1.2))
    for num, x, y in (("62", -7, -7), ("63", -7, 7), ("64", 7, 7), ("65", 7, -7)):
        L.append(_smd(num, x, y, 0.8, 0.8))
    # The module's GND pins share its internal ground plane (datasheet pin
    # table: 1, 2, 42, 43, 46-65 are all "GND"). Declared as a KiCad jumper pad
    # group so DRC knows they are one node inside the part (a corner pad whose
    # board-side copper is boxed in by signal pads is still grounded).
    gnd = ["1", "2", "42", "43"] + [str(n) for n in range(46, 66)]
    L.append("	(jumper_pad_groups (" + " ".join(f'"{n}"' for n in gnd) + "))")
    _write("ESP32-S3-MINI-1", L)


def ti_dyd0005a():
    """TLV757P SBVS322C DYD0005A example board layout."""
    L = _hdr("TI_DYD0005A_SOT-23-5_ThermalPad",
             "TI DYD0005A SOT-23-5 with thermal pad (TLV757P). Land pattern: SBVS322C "
             "DYD0005A example board layout 4228946/A 08/2022. Pad 6 = thermal pad (GND).",
             "SOT-23-5 DYD TLV757P", ref_y=-2.2, val_y=2.2)
    L.append(_rect(-0.8, -1.5, 0.8, 1.5, "F.Fab", 0.1))
    L.append(_rect(-2.1, -1.75, 2.1, 1.75, "F.CrtYd", 0.05))
    L.append(_line(-0.8, -1.62, 0.8, -1.62, "F.SilkS", 0.12))
    L.append(_line(-0.8, 1.62, 0.8, 1.62, "F.SilkS", 0.12))
    L.append(_line(-1.9, -1.45, -0.9, -1.45, "F.SilkS", 0.12))
    for num, x, y in (("1", -1.3, -0.95), ("2", -1.3, 0.0), ("3", -1.3, 0.95),
                      ("4", 1.3, 0.95), ("5", 1.3, -0.95)):
        L.append(_smd(num, x, y, 1.1, 0.6, shape="roundrect", extra=" (roundrect_rratio 0.0833)"))
    L.append(_smd("6", 0.0625, 0.0, 0.975, 1.7))
    _write("TI_DYD0005A_SOT-23-5_ThermalPad", L)


def ti_rgt0016c():
    """BQ24073RGTR, SLUS810N RGT0016C example board layout."""
    L = _hdr("TI_RGT0016C_VQFN-16_3x3mm_P0.5mm_EP1.68mm",
             "TI RGT0016C VQFN-16 3x3mm (BQ24073RGTR). Land pattern: SLUS810N RGT0016C "
             "example board layout 4222419/E 07/2025; EP paste 1.55 sq per example stencil. "
             "Pad 17 = thermal pad (VSS).",
             "VQFN-16 RGT BQ24073", ref_y=-2.5, val_y=2.5)
    L.append(_rect(-1.5, -1.5, 1.5, 1.5, "F.Fab", 0.1))
    L.append(_rect(-2.0, -2.0, 2.0, 2.0, "F.CrtYd", 0.05))
    for x0, y0, x1, y1 in [(-1.6, -1.6, -1.2, -1.6), (1.6, -1.6, 1.2, -1.6), (1.6, -1.6, 1.6, -1.2),
                           (-1.6, 1.6, -1.2, 1.6), (-1.6, 1.6, -1.6, 1.2), (1.6, 1.6, 1.2, 1.6),
                           (1.6, 1.6, 1.6, 1.2)]:
        L.append(_line(x0, y0, x1, y1, "F.SilkS", 0.12))
    L.append(_text("1", -2.1, -0.75, "F.SilkS", 0.6))
    rr = ' (roundrect_rratio 0.2083)'
    ys = [-0.75, -0.25, 0.25, 0.75]
    for i, y in enumerate(ys):                              # 1..4 left
        L.append(_smd(str(1 + i), -1.4, y, 0.6, 0.24, shape="roundrect", extra=rr))
    for i, x in enumerate(ys):                              # 5..8 bottom
        L.append(_smd(str(5 + i), x, 1.4, 0.24, 0.6, shape="roundrect", extra=rr))
    for i, y in enumerate(reversed(ys)):                    # 9..12 right
        L.append(_smd(str(9 + i), 1.4, y, 0.6, 0.24, shape="roundrect", extra=rr))
    for i, x in enumerate(reversed(ys)):                    # 13..16 top
        L.append(_smd(str(13 + i), x, -1.4, 0.24, 0.6, shape="roundrect", extra=rr))
    L.append(_smd("17", 0, 0, 1.68, 1.68, layers='"F.Cu" "F.Mask"'))
    L.append(_smd("", 0, 0, 1.55, 1.55, layers='"F.Paste"'))
    _write("TI_RGT0016C_VQFN-16_3x3mm_P0.5mm_EP1.68mm", L)


def sofng_ss12d00():
    L = _hdr("SW_Slide_SPDT_SOFNG_SS-12D00-G3",
             "SOFNG SS-12D00-G3 SPDT slide switch, THT, 2.5mm pitch (LCSC C22355741 drawing). "
             "Pin 2 (middle) = common. Hand-soldered.",
             "slide switch SPDT", attr="through_hole", ref_y=-3.0, val_y=3.0)
    L.append(_rect(-4.4, -1.95, 4.4, 1.95, "F.Fab", 0.1))
    L.append(_rect(-4.65, -2.17, 4.65, 2.17, "F.CrtYd", 0.05))
    L.append(_rect(-4.52, -2.07, 4.52, 2.07, "F.SilkS", 0.12))
    for i, x in enumerate((-2.5, 0.0, 2.5)):
        shape = "rect" if i == 0 else "circle"
        L.append(f'\t(pad "{i + 1}" thru_hole {shape} (at {_f(x)} 0) (size 1.6 1.6) (drill 0.9) '
                 f'(layers "*.Cu" "*.Mask"))')
    _write("SW_Slide_SPDT_SOFNG_SS-12D00-G3", L)


def padrow_1x08():
    L = _hdr("PadRow_1x08_P2.54mm_SMD",
             "1x8 bare SMD pad row, 2.54mm pitch, 1.0x2.4mm pads (J3 spare pins, DNP).",
             "pad row spare", ref_y=-2.2, val_y=2.2)
    L.append(_rect(-9.4, -1.5, 9.4, 1.5, "F.CrtYd", 0.05))
    for i in range(8):
        x = -8.89 + i * 2.54
        L.append(_smd(str(i + 1), x, 0, 1.0, 2.4, layers='"F.Cu" "F.Mask"'))
    L.append(_text("1", -8.89, -1.9, "F.SilkS", 0.6))
    _write("PadRow_1x08_P2.54mm_SMD", L)


def lsm6dsv16x():
    L = _hdr("LGA-14_2.5x3mm_P0.5mm_LSM6DSV16X",
             "ST LSM6DSV16X LGA-14L 2.5x3.0x0.86mm. DS13510 Rev4 Fig.33 (leads 0.25x0.475, P0.5); "
             "pads 0.30x0.625 for a 0.20mm pad gap. Built by footprints.py",
             "LGA-14 LSM6DSV16X IMU", ref_y=-2.0, val_y=2.0)
    L.append(_rect(-1.5, -1.25, 1.5, 1.25, "F.Fab", 0.1))
    L.append(_rect(-1.75, -1.5, 1.75, 1.5, "F.CrtYd", 0.05))
    L.append(_line(-1.62, -1.37, -1.3, -1.37, "F.SilkS", 0.12))
    L.append(_line(-1.62, -1.37, -1.62, -1.1, "F.SilkS", 0.12))
    ys = [-0.75, -0.25, 0.25, 0.75]
    for i, y in enumerate(ys):                     # 1..4 left, top->bottom
        L.append(_smd(str(1 + i), -1.1625, y, 0.625, 0.3))
    for i, x in enumerate((-0.5, 0.0, 0.5)):       # 5..7 bottom, left->right
        L.append(_smd(str(5 + i), x, 0.9125, 0.3, 0.625))
    for i, y in enumerate(reversed(ys)):           # 8..11 right, bottom->top
        L.append(_smd(str(8 + i), 1.1625, y, 0.625, 0.3))
    for i, x in enumerate((0.5, 0.0, -0.5)):       # 12..14 top, right->left
        L.append(_smd(str(12 + i), x, -0.9125, 0.3, 0.625))
    _write("LGA-14_2.5x3mm_P0.5mm_LSM6DSV16X", L)


def write_all():
    sam_m10q()
    esp32_s3_mini_1()
    ti_dyd0005a()
    ti_rgt0016c()
    sofng_ss12d00()
    padrow_1x08()
    lsm6dsv16x()
    return LIB


if __name__ == "__main__":
    print(write_all())
