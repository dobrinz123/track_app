#!/usr/bin/env python3
"""
TRACE GNSS Pod rev A -- production outputs (JLCPCB) + DRC + review renders.

Run AFTER generate_board.py, with KiCad 10's Python:
    "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" generate_production.py

Writes:
  production/bom.csv     JLCPCB BOM: Comment, Designator, Footprint, LCSC
                         (grouped by identical part). Hand-soldered parts stay in
                         the BOM for procurement and are marked in Comment.
  production/cpl.csv     JLCPCB CPL: Designator, Mid X, Mid Y, Layer, Rotation.
                         Machine-placed parts only: no hand-solder parts, no DNP,
                         no test pads or mounting holes. Coordinates are relative
                         to the drill/place origin at the board's bottom-left
                         corner (= spec coordinates, Y up), like the gerbers.
  production/*.g*, *.drl, gerbers.zip   2-layer gerbers + Excellon drill
  gnss-pod-drc.rpt / drc.json           kicad-cli DRC (all severities)
  render-top.png / render-bottom.png    3D renders; review-top/bottom.svg plots

Mirrors hardware/kicad/trace-dongle/generate_production_csv.py: the LCSC table
is imported from generate_board.py (single source).
"""
import csv
import os
import subprocess
import sys
import zipfile
from collections import OrderedDict

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from generate_board import LCSC, DNP, HAND_SOLDER, NOT_A_PART, OUT_PCB, BOARD_H  # noqa: E402

PROD = os.path.join(HERE, "production")
KICAD_CLI = os.path.join(os.environ.get("LOCALAPPDATA", r"C:\Users\dobri\AppData\Local"),
                         r"Programs\KiCad\10.0\bin\kicad-cli.exe")

# Human-readable comments (value + JLCPCB handling notes)
HAND_NOTE = "HAND-SOLDER by owner - NOT in CPL (bought loose, spec sec 9)"
J1_NOTE = ("JLCPCB SMT; 4 shell tabs are plated slots (THT) - JLCPCB to hand/THT-solder "
           "or owner solders them (spec sec 9 item 3)")


def run(args):
    print("  $", " ".join(os.path.basename(a) if i == 0 else a for i, a in enumerate(args)))
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode not in (0, 5):   # 5 = DRC violations with --exit-code-violations
        print(r.stdout, r.stderr)
        raise SystemExit(f"command failed ({r.returncode})")
    return r


def bom_cpl(board):
    groups = OrderedDict()
    cpl = []
    for fp in sorted(board.GetFootprints(), key=lambda f: f.GetReference()):
        ref = fp.GetReference()
        if ref in NOT_A_PART or ref in DNP:
            continue
        value = fp.GetValue()
        comment = value
        if ref in HAND_SOLDER:
            comment = f"{value} ({HAND_NOTE})"
        elif ref == "J1":
            comment = f"{value} ({J1_NOTE})"
        footprint = str(fp.GetFPID().GetLibItemName())
        lcsc = LCSC.get(ref, "")
        if not lcsc:
            raise SystemExit(f"no LCSC code for {ref}")
        key = (comment, footprint, lcsc)
        groups.setdefault(key, []).append(ref)
        if ref in HAND_SOLDER:
            continue
        if fp.IsFlipped():
            raise SystemExit(f"{ref} is on the bottom: spec requires all SMD on top")
        pos = fp.GetPosition()
        x = pcbnew.ToMM(pos.x)
        y = BOARD_H - pcbnew.ToMM(pos.y)
        cpl.append((ref, f"{x:.4f}", f"{y:.4f}", "Top", f"{fp.GetOrientationDegrees() % 360:.1f}"))

    def refkey(r):
        head = r.rstrip("0123456789")
        return (head, int(r[len(head):]))
    with open(os.path.join(PROD, "bom.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Comment", "Designator", "Footprint", "LCSC"])
        for (comment, footprint, lcsc), refs in groups.items():
            w.writerow([comment, ",".join(sorted(refs, key=refkey)), footprint, lcsc])
    with open(os.path.join(PROD, "cpl.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for row in sorted(cpl, key=lambda r: refkey(r[0])):
            w.writerow(row)
    print(f"bom.csv: {len(groups)} lines / {sum(len(v) for v in groups.values())} parts; cpl.csv: {len(cpl)} parts")


def gerbers():
    for fn in os.listdir(PROD):
        if fn.endswith((".gbr", ".gtl", ".gbl", ".gto", ".gbo", ".gts", ".gbs", ".gtp", ".gbp",
                        ".gm1", ".drl", ".zip", ".gbrjob")):
            os.remove(os.path.join(PROD, fn))
    run([KICAD_CLI, "pcb", "export", "gerbers", "-o", PROD + os.sep,
         "--layers", "F.Cu,B.Cu,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask,Edge.Cuts",
         "--use-drill-file-origin", "--subtract-soldermask", OUT_PCB])
    run([KICAD_CLI, "pcb", "export", "drill", "-o", PROD + os.sep, "--format", "excellon",
         "--drill-origin", "plot", "--excellon-units", "mm", OUT_PCB])
    files = sorted(f for f in os.listdir(PROD) if not f.endswith((".csv", ".zip")))
    with zipfile.ZipFile(os.path.join(PROD, "gerbers.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(os.path.join(PROD, f), f)
    print(f"gerbers.zip: {files}")


def drc_and_renders():
    rpt = os.path.join(HERE, "gnss-pod-drc.rpt")
    run([KICAD_CLI, "pcb", "drc", "--severity-all", "--units", "mm", "-o", rpt, OUT_PCB])
    run([KICAD_CLI, "pcb", "drc", "--severity-all", "--format", "json", "--units", "mm",
         "-o", os.path.join(HERE, "drc.json"), OUT_PCB])
    with open(rpt) as f:
        print("".join(l for l in f if l.startswith("**")))
    for side in ("top", "bottom"):
        run([KICAD_CLI, "pcb", "render", "--side", side, "--width", "1400", "--height", "2000",
             "--quality", "high", "--background", "opaque", "-o", os.path.join(HERE, f"render-{side}.png"), OUT_PCB])
    run([KICAD_CLI, "pcb", "export", "svg", "--mode-single", "--page-size-mode", "2", "--exclude-drawing-sheet",
         "-l", "F.Cu,F.Silkscreen,F.Fab,Edge.Cuts,User.Drawings,User.Comments",
         "-o", os.path.join(HERE, "review-top.svg"), OUT_PCB])
    run([KICAD_CLI, "pcb", "export", "svg", "--mode-single", "--page-size-mode", "2", "--exclude-drawing-sheet",
         "--mirror", "-l", "B.Cu,B.Silkscreen,B.Fab,Edge.Cuts",
         "-o", os.path.join(HERE, "review-bottom.svg"), OUT_PCB])


def main():
    os.makedirs(PROD, exist_ok=True)
    board = pcbnew.LoadBoard(OUT_PCB)
    bom_cpl(board)
    gerbers()
    drc_and_renders()


if __name__ == "__main__":
    main()
