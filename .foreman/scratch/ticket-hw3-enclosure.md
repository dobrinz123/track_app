TASK: Design the 3D-printable enclosure for the TRACE OBD dongle in OpenSCAD and render STLs. Board envelope per hardware/DESIGN.md section 4 (read it): PCB 55 x 25 x 1.6 mm, OBD-II J1962 male plug at one board edge (plug shell protrudes THROUGH the case wall), ESP32 antenna at the opposite edge, side tact switch SW1, two 0603 LEDs top side, 1x6 2.54mm UART header (internal, no aperture needed).

EXPECTED OUTCOME:
- hardware/enclosure/trace-dongle-case.scad — ONE parametric file (all dims as named parameters at top: pcb_l=55, pcb_w=25, pcb_t=1.6, wall=2.0, clearance=0.4, standoff heights, plug aperture dims) producing two parts via a `part` selector: "body" and "lid".
  Body: open-top box; internal PCB standoffs with M2 self-tap bosses (4x, 2mm hole); one end wall has the J1962 plug aperture (rectangular cutout 38 x 12 mm centered, parameterized — generous, trimmed at print time); two side vent slot groups; a 3 x 8 mm side cutout aligned to SW1 position (parameter).
  Lid: snap-fit (two cantilever snaps per long side, parameterized snap geometry printable without supports), 2 x 3mm diameter light-pipe holes above LED positions (parameters), engraved text "TRACE" (2 lines max, shallow 0.4mm).
  Both parts must print WITHOUT supports in the natural orientation (body opening up, lid top down): no overhangs > 50 degrees except the snap cantilevers (they are vertical in print orientation on the lid perimeter — verify your geometry achieves this).
- hardware/enclosure/trace-dongle-body.stl and trace-dongle-lid.stl rendered via the OpenSCAD CLI at C:\Users\dobri\AppData\Local\Programs\OpenSCAD-portable\openscad-2021.01\openscad.exe (example: "<exe>" -o out.stl -D part=\"body\" trace-dongle-case.scad). Confirm both render with exit 0 and nonzero file sizes; report vertex/facet counts if printed in the CLI output.

CONTEXT: Repo D:\CODE\APLICTIE_Circuit. Component positions are NOT finalized (PCB layout runs in parallel) — therefore ALL feature positions (LED holes, SW1 cutout, standoff XY) must be top-of-file parameters with sensible defaults, and the report must state clearly: "positions parametric — re-render after PCB layout freezes."

CONSTRAINTS: OpenSCAD 2021.01 language (no newer features like textmetrics). Wall 2.0mm, tolerance/clearance parameterized. Keep it printable and simple — no threads, no hinges.

MUST DO: actually run the CLI renders (real exit codes); visually sanity-check by also exporting a PNG preview per part (openscad -o preview.png --imgsize 800,600) and confirm the files exist.
MUST NOT: No subagents. Nothing outside hardware/enclosure/.
WRITE SET: hardware/enclosure/**.
OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then: files + sizes; render exit codes; the parametric-positions caveat; concerns.
