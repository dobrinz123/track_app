TASK: Render the TRACE OBD dongle schematic as a professional SVG using Python schemdraw, EXACTLY matching the binding netlist in hardware/DESIGN.md sections 2-3 (read it first — it is the single source of truth; any ambiguity -> follow the netlist literally, note it in your report).

EXPECTED OUTCOME: hardware/schematic/trace-dongle.svg — one readable landscape schematic sheet with functional grouping: (1) OBD-II input + protection (J1 pins 16/4/5/6/14 labeled, F1 PTC, D2 reverse Schottky, D1 SMBJ24A TVS), (2) TPS54202 buck (BST cap, L1, FB divider 100k/13k, EN UVLO divider 100k/24k, in/out caps), (3) ESP32-C3-MINI-1 (EN RC, IO9 boot sw + pullup, IO4/IO5 CAN TX/RX, IO6 -> U2.S, IO8 LED2, UART to J2 header), (4) TJA1051T/3 + PESD2CAN + DNP R120 marked "DNP", (5) LEDs + programming header. Every component labeled with ref + value + LCSC part from the BOM table. Net labels for 12V_RAW, VIN_PROT, 3V3, GND, CANH, CANL.

CONTEXT: Repo D:\CODE\APLICTIE_Circuit. Python interpreter: the one at the path inside graphify-out/.graphify_python (uv-managed). Create a venv in the session scratchpad (C:\Users\dobri\AppData\Local\Temp\claude\D--CODE-APLICTIE-Circuit\99e8bb0d-e01a-46e7-8e09-704662c78ba7\scratchpad\hwvenv) and pip install schemdraw in it. Write the generator script to hardware/schematic/generate_schematic.py (checked in, reproducible) and run it to produce the SVG.

CONSTRAINTS: schemdraw only (no other new packages beyond its deps). The SVG must be self-contained (no external refs). Iterate until it renders without errors AND you have re-read the netlist line by line against your drawing code (do this check explicitly, report "netlist cross-check: N connections verified").

MUST DO: run the script for real and confirm the SVG file exists with nonzero size; include the netlist cross-check count; keep the script deterministic.
MUST NOT: No subagents. Do not touch anything outside hardware/schematic/ and the scratchpad venv. Do not modify DESIGN.md (report discrepancies instead).
WRITE SET: hardware/schematic/**, scratchpad venv.
OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then: file path + size; netlist cross-check count; any DESIGN.md ambiguities found; concerns.
