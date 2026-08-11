#!/usr/bin/env python3
"""Generate production/bom.csv and production/cpl.csv from the built board.

bom.csv columns (JLCPCB): Comment,Designator,Footprint,LCSC
cpl.csv columns (JLCPCB): Designator,Mid X,Mid Y,Layer,Rotation

R9 (R120, DNP per DESIGN.md sec2/sec3 -- CAN bus already terminated) is
excluded from both: it is not assembled, only its footprint/copper is on
the board for optional manual fitting later.
"""
import csv
import os

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, "trace-dongle.kicad_pcb")
PROD = os.path.join(HERE, "production")

DNP = {"R9"}

LCSC = {
    "U1": "C3013922", "U2": "C264757", "U3": "C316922",
    "D1": "C114213", "D2": "C8678", "D3": "C24911", "F1": "C88724", "L1": "C167219",
    "SW1": "C318884",
}

board = pcbnew.LoadBoard(PCB)

bom_rows = []
cpl_rows = []
for fp in board.GetFootprints():
    ref = fp.GetReference()
    if ref in DNP:
        continue
    comment = fp.GetValue()
    footprint = fp.GetFPID().GetLibItemName().wx_str() if hasattr(fp.GetFPID().GetLibItemName(), "wx_str") else str(fp.GetFPID().GetLibItemName())
    lcsc = LCSC.get(ref, "")
    bom_rows.append((comment, ref, footprint, lcsc))

    pos = fp.GetPosition()
    x_mm = pcbnew.ToMM(pos.x)
    y_mm = pcbnew.ToMM(pos.y)
    layer = "Top" if fp.GetLayer() == pcbnew.F_Cu else "Bottom"
    rot = fp.GetOrientationDegrees()
    cpl_rows.append((ref, f"{x_mm:.4f}", f"{y_mm:.4f}", layer, f"{rot:.1f}"))

bom_rows.sort(key=lambda r: r[1])
cpl_rows.sort(key=lambda r: r[0])

with open(os.path.join(PROD, "bom.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Comment", "Designator", "Footprint", "LCSC"])
    w.writerows(bom_rows)

with open(os.path.join(PROD, "cpl.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
    w.writerows(cpl_rows)

print(f"Wrote bom.csv ({len(bom_rows)} rows) and cpl.csv ({len(cpl_rows)} rows)")
