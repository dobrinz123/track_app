# TRACE GNSS Pod rev A: 3D-printed enclosure and mounts

Parametric OpenSCAD case for the rev A board (`hardware/kicad/gnss-pod/gnss-pod.kicad_pcb`).
The pod is a two-part shell (**base + lid**) with a **magnetic base**, Dragy-style.
It snaps onto one of three mounts:

1. **Adjustable windscreen mount.** A glass plate (3M VHB) and a cradle, joined by a
   serrated friction hinge on an M3 bolt. It fits any rake from about 15° to 75°.
2. **Dash disc.** A flat plate, VHB'd to the dashboard near the base of the windscreen.
3. **Any flat steel surface**, with no accessory.

**Status: NOT test-fitted.** Board geometry comes from the `.kicad_pcb` file.
Component heights come from datasheets and KiCad 3D models (table below). Print one
set, fit a real board, then correct the parameters.

| File | What | Print orientation |
|---|---|---|
| `trace-pod-case.scad` | Source. All dimensions are variables at the top. | |
| `trace-pod-base.stl` | Bottom shell, 2 magnet pockets | floor on the bed |
| `trace-pod-lid.stl` | Top shell (sky side) | top face on the bed |
| `trace-pod-mount-glass.stl` | Windscreen plate with hinge fork | VHB face on the bed |
| `trace-pod-mount-cradle.stl` | Cradle tray with hinge tongue | tray on the bed |
| `trace-pod-mount-disc.stl` | Dash disc | VHB face on the bed |
| `preview-assembled.png`, `preview-exploded.png` | Pod with a board mock-up; exploded view with the dash disc | |
| `preview-on-glass.png`, `preview-on-glass-side.png` | Pod on the windscreen mount at a 30° rake (side view is orthographic) | |

Re-render (OpenSCAD 2021.01 portable, `%LOCALAPPDATA%\Programs\OpenSCAD-portable\openscad-2021.01\openscad.exe`):

```
openscad -o trace-pod-base.stl         -D "part=\"base\""   trace-pod-case.scad
openscad -o trace-pod-lid.stl          -D "part=\"lid\""    trace-pod-case.scad
openscad -o trace-pod-mount-glass.stl  -D "part=\"glass\""  trace-pod-case.scad
openscad -o trace-pod-mount-cradle.stl -D "part=\"cradle\"" trace-pod-case.scad
openscad -o trace-pod-mount-disc.stl   -D "part=\"disc\""   trace-pod-case.scad
openscad -o preview-on-glass-side.png -D "part=\"onglass\"" -D windscreen_rake_deg=30 --imgsize=1400,900 --viewall --autocenter --camera=0,0,0,90,0,0,0 --projection=ortho trace-pod-case.scad
```

## Orientation

- **TOP = lid = component side = SAM-M10Q side. It faces the SKY in use**
  (DESIGN-REV-A §10.11). There is 1.6 mm of plain PETG/ASA over the module:
  no ribs, no metal.
- **BASE = bottom shell.** It carries the two Ø20 × 3 mm magnets flush in its
  floor, the screw heads, the label and the floor vents.
- **Never mount the pod with its top flat against the glass.** The GNSS antenna
  would then face the cabin. None of the mounts here allows that.

## Dimensions derived from the board

Coordinates follow DESIGN-REV-A §8: origin at the bottom-left board corner, X along
the 50 mm edge, Y along the long edge (`Y = 72 − Y_kicad`), Z up from the outside
of the base floor.

| Item | Value (from `.kicad_pcb`) |
|---|---|
| Board outline | 50.00 × 66.95 mm, 1.6 mm thick. ESP32 antenna overhangs Y 66.95 → 72.0, X 17.25–32.75 |
| Mounting holes | 4 × 2.2 mm NPTH at (3.5, 3.5), (46.5, 3.5), (3.5, 60.0), (46.5, 60.0) |
| U2 SAM-M10Q | centre (25, 25), body 17.25–32.75 square |
| U1 ESP32-S3-MINI-1 | X 17.25–32.75, Y 51.45–72.05 (fab outline) |
| U3 IMU | (22.3, 47.2) |
| J1 USB-C | west edge, centre Y 48.2, body X 0–7.35 × Y 43.73–52.67, mouth flush with X = 0 |
| SW3 slide switch | centre (4.7, 64.68), body 8.8 × 3.9 (X 0.25–9.15), lever points up, slides along X |
| SW1 BOOT / SW2 RESET | (46.3, 18.2) / (46.3, 10.4), top-actuated |
| LED2 / LED1 / LED3 | (1.75, 55.15) / (1.75, 56.7) / (4.95, 56.7), 0603, top-emitting, west edge |
| J2 (not fitted) | east edge, Y 48.6–57.0 |
| Bottom side | test pads only (flat), plus the THT pins of SW3, the J1 shell tabs and pegs, and the J2 pads. No bottom-side components. |

Case numbers (echoed by the SCAD):

| | |
|---|---|
| Pod outer | **55.4 × 78.1 × 16.5 mm** (X −2.7 … 52.7, Y −2.7 … 75.4) |
| Cavity | board + 0.3 mm (`tol`) each side; +1.0 mm of air beyond the antenna tip |
| Z stack | floor 2.0 (magnet pads 3.9) → standoffs 4.0 → board 6.0–7.6 (split plane) → 7.3 mm of air → lid inner 14.9 → lid 1.6 → top 16.5 |
| Over the SAM-M10Q | 0.5 mm of air at its 6.8 mm maximum height (1.0 mm at 6.3 typ), then 1.6 mm plastic |
| Around the ESP32 antenna | plastic only. Nearest case metal is the M2 screws at (1.5 / 48.5, 70.5), **15.75 mm** away |
| Walls | 2.4 mm sides, 2.0 mm floor, 1.6 mm lid plate. Lip joint: 1.2 mm lid rim with a 1.0 mm base lip inside it (0.2 mm fit clearance) |

## Component heights used (above the board top)

| Part | Height used | Source |
|---|---|---|
| U2 SAM-M10Q | **6.3 typ / 6.8 max** (design uses 6.8) | u-blox UBX-22013293 R05, Table 19 (the PDF's text extraction scrambles the table columns: confirm with the drawing) |
| SW3 SS-12D00-G3 | 6.8 (body ~3.8 + 3.0 lever) | Seller drawings/listings. The footprint's 8.8 × 3.9 body is from the SOFNG drawing. **VERIFY.** No KiCad model. |
| J1 HRO TYPE-C-31-M-12 | 3.3 | Typical. **No KiCad 3D model** in the KiCad 10 library and the datasheet is image-only: **VERIFY** |
| U1 ESP32-S3-MINI-1 | 2.4 | DESIGN-REV-A §5 (Espressif datasheet) |
| SW1/SW2 TS-1187A-B-A-B | 1.5 | LCSC C318884 (5.1 × 5.1 × 1.5). No KiCad model. |
| LEDs 0603 | 1.1 | KiCad model (via `kicad-cli pcb export glb`) |
| 0805 / SOT-23 / SOT-23-6 | 1.24 / 1.2 / 1.54 | KiCad models (same export) |
| J2 JST B3B-PH-K (not fitted) | 6.0 (+1.8 of pins below) | KiCad model. It would fit under the lid; `j2_slot = true` opens the east wall for the lead. |

The lid clears the tallest parts (SAM-M10Q and the SW3 lever, 6.8 mm) by 0.5 mm.
The OpenSCAD interference check (lid ∩ board mock-up) comes out empty.

## Pod features

- **Clamping (no rattle for the IMU).** The board sits on 5 mm base standoffs and is
  pressed from above by 4.2 mm lid bosses at all four board holes. The bosses are
  0.2 mm longer than the gap (`preload`).
  - The **two south holes** take M2 screws from below, through the board, into the
    lid bosses.
  - The **two north holes** sit where the magnets are, so they are clamped by the
    bosses only. Two extra case screws at (1.5, 70.5) and (48.5, 70.5), outside
    the board and 15.75 mm from the antenna, pull that end of the lid down.
  - Two posts under the board, at (25, 40) and (25, 12), stop 0.1 mm short of it
    to limit flex.
- **Magnetic base.** Two Ø20.3 × 3.1 mm pockets open on the bottom face, magnets
  flush, 0.8 mm plastic between magnet and cabin, 2.1 mm air to the board
  underside. Two 45° registration dimples (Ø5 × 1.2 mm) at (25, 45.75) and
  (25, 59.75) take matching bumps on the cradle and disc. With ~2 × 5 kg of magnet
  pull on 45° cones, the pod cannot slide under G-loads. On bare steel it stays
  flat (the dimples are recessed).
- **USB-C.** A 12.0 × 7.5 mm opening, centred on the receptacle, for the cable
  overmould (west side, facing the cabin on the windscreen mount).
- **LEDs.** A side window in the west wall (Y 54.3–57.9, 2.8 mm tall), merged with
  the USB opening.
- **SW3.** A 6.5 × 3.0 mm chamfered slot in the lid over the lever. The lever top
  sits about 2 mm under the surface. Use a fingernail or toothpick.
- **BOOT / RESET.** 2.0 mm holes in the lid, marked B and R, with guide tubes
  ending 0.8 mm above the buttons. Use a 1.5 mm pin or a paper clip.
- **Vents.** Floor slots under Z1, and slots high on the north, east and west walls.

## Magnet placement: honest numbers

DESIGN-REV-A §8: "magnet … behind Z2, never behind Z1 or Z3". The magnets sit fully
under Z2 (Y 42.75–62.75), at the X extremes (centres (9, 52.75) and (41, 52.75)).
That is as far as the 50 mm width allows from both the module and the antenna:

| Distance (magnet edge) | In plan | 3D (magnet top 4.6 mm below the board top) |
|---|---|---|
| to the SAM-M10Q body | **11.6 mm** (11.3 to its 16.0 mm max outline) | ~12.5 mm, with the board's solid bottom GND plane in between |
| to the ESP32 antenna | **6.4 mm** | ~7.9 mm |

**The ≥ 15 mm target is not met for either antenna.** Inside the board width a
Ø20 mm magnet cannot be 15 mm from both, and anywhere else is Z1 or Z3, which the
design doc forbids. The GNSS side is the lesser worry: the magnets sit below the
board's ground plane, while the patch radiates upward. The ESP32 antenna overhangs
the board edge and has no ground plane between it and the magnet. **Check BLE RSSI
and GNSS C/N0 with the magnets fitted vs removed** during DESIGN-REV-A §10A test 4.
If BLE suffers, move `magnets` south (lower Y) at the GNSS's expense, or use
smaller discs.

The board has **no magnetometer** (LSM6DSV16X is accel + gyro). The magnets cannot
disturb any heading sensor, and a static field does not affect the GNSS receiver
or the IMU. The question is only metal near the antennas.

## The three mounts

### 1. Adjustable windscreen mount (glass plate + cradle)

- **Glass plate.** A 40 × 28 × 3 mm pad for 3M VHB, with a hinge fork: two 5 mm
  ears, pivot 16 mm from the glass.
- **Cradle.** A 55.4 × 33.5 × 4.2 mm tray under the magnet area of the pod, with two
  counter-magnets flush and the two registration bumps. A 6 mm hinge tongue sits
  on the pod's east side (J2 side). The USB-C side therefore faces rearward, toward
  the cabin.
- **Hinge.** One M3 bolt clamps the fork and tongue (16 mm stack). A nyloc nut sits
  captive in a hex pocket in one ear.
  - All four clamping faces carry **24 radial Hirth-style teeth** (15° steps,
    45° flanks, 1.1 mm tall at the rim). Tightened, the angle cannot slip; the lock
    does not rely on friction alone.
  - Range: **15°–75°** windscreen rake (from horizontal). Set it so the pod sits
    roughly level. The exact tilt does not matter: firmware finds the mount
    orientation, and the patch tolerates ±20–30° off-zenith. There is no angle scale.
  - To adjust: back the bolt off ~1.5 turns, click the tongue to the next tooth
    (the ears flex apart ~1.1 mm), then retighten.
- **Pod top to glass** (perpendicular, at the pod's nearest top edge), from the
  SCAD's `glass_gap()`:

  | Rake | 15° | 30° | 45° | 75° |
  |---|---|---|---|---|
  | Gap | **7.5 mm** | 11.4 mm | 15.5 mm | 23.6 mm |

  I chose ≥ 7.5 mm (above the 5 mm floor) so a curved windscreen or a slightly
  tilted pod still keeps the top off the glass. Checked in OpenSCAD: the pod does
  not touch a glass slab offset by 5 mm at 15°, and the pod and glass plate do not
  collide at 15° or 75°.
- **Deviation from "print the knuckles flat".** A hinge whose knuckle faces print
  flat can only have one knuckle per part. That puts the hinge at one end of the
  pod, and the pod then hangs sideways off it. A 4 mm tray cantilevered 80 mm
  resonates at roughly **40 Hz**, right in the band the IMU is meant to measure.
  I used a centred fork-and-tongue instead, clamped on two serrated faces. Its
  knuckles are vertical walls in print. They still **need no supports**: the teeth
  have 45° flanks everywhere, the bolt holes are teardrops, and the nut pocket is
  a vertex-up hexagon.

### 2. Dash disc

A 57 × 25 × 4.2 mm stadium plate (5.2 mm including the bumps), with two
counter-magnets flush and the registration bumps. Put VHB underneath. Stick it on
a flat part of the dash near the base of the windscreen: pod level, top up, clear
of the defrost vents.

### 3. Any flat steel surface

The base sticks directly. The dimples are recessed, so the pod sits flat.

## Print settings

| | |
|---|---|
| Material | **ASA** preferred (softens ~100 °C) or **PETG** (Tg ~80 °C). **Not PLA**: it softens at ~55–60 °C, and a windscreen in summer sun gets hotter. Use light/natural colours. |
| Nozzle / layer | 0.4 mm / 0.2 mm |
| Perimeters | 4 (≥ 1.6 mm solid walls); top/bottom 5 layers |
| Infill | pod shells 30 % gyroid; **glass plate and cradle 60–100 %** (hinge parts); disc 100 % |
| Supports | **None.** The base prints floor-down (the Ø4.4 counterbores bridge). The lid prints top-down (pin holes and the SW3 slot are on the bed; the USB/LED notches open at the top of the print). The glass plate prints pad-down with the ears standing, and the cradle tray-down with the tongue standing. |
| Brim | ASA: 5 mm brim + enclosure, especially for the tall ears/tongue. PETG: brim on the glass plate and cradle only. |
| After printing | Pilot holes Ø1.7 (drill 1.6–1.8 to suit the screw), base holes Ø2.4, hinge holes Ø3.4 (run a 3.4 mm drill through the teardrops) |

Tolerances: 0.3 mm board clearance (`tol`), 0.2 mm lip fit (`fit_clear`), 0.3 mm on
magnet pockets (`magnet_fit`), 0.2 mm on the cones (`cone_clear`). Tune these after
the first print.

## Buy list

| Qty | Part |
|---|---|
| 4 | **M2 × 12 mm pan-head thread-forming screws for plastics** (e.g. "PT / KA / plastite M2×12", thread OD 2.0 mm, head ≤ Ø4.0). Engagement ~6 mm; the blind pilots allow 13.7 mm max. Do **not** use ST2.2 (DIN 7981): it binds in the 2.2 mm board holes. |
| 2 + 2 per mount | **Neodymium discs Ø20 × 3 mm, high-temperature grade (N35H / N42SH, 120 °C).** Standard N-grade magnets start losing strength above 80 °C. 2 go in the pod, 2 in the cradle, 2 in the dash disc (6 for everything). **Alternative for the mounts:** Ø20 × 3 mm mild-steel discs. They hold less and have no polarity keying. |
| 1 | **M3 × 20 mm** bolt (socket or pan head) + M3 washer, or an **M3 × 20 thumb screw** for tool-free adjustment |
| 1 | **M3 nyloc nut** (DIN 985, 5.5 mm AF, 4 mm tall), pressed into the hex pocket |
| 2 pieces | **3M VHB** for glass, e.g. 4910 (clear, 1.0 mm): **40 × 26 mm** for the glass plate, **50 × 22 mm** (or cut to the stadium) for the dash disc. Plus an IPA wipe. |
| – | 2-part epoxy for the magnets (not CA: CA creeps when hot) |

## Assembly order

1. **Board prep:** trim the SW3 pins and J1 shell tabs to ≤ 2 mm under the board.
   The gap to the magnet pads is 2.1 mm.
2. **Pod magnets, keyed.** Epoxy both magnets flush into the base pockets **with
   opposite poles facing out**. Check with a loose magnet: one pod magnet attracts
   a given face of it, the other repels that face. This keys the pod so it only
   seats one way round (USB side away from the hinge). Let it cure.
3. **Mount magnets (cradle and disc).** Put a loose magnet on each glued pod
   magnet. It snaps on in the attracting orientation. Mark its *exposed* face, pull
   it off and epoxy it flush into the matching mount pocket with the **marked face
   down**. Repeat for the other pocket, then let it cure. Dry-fit the pod: it must
   pull in, and the cones must seat. (With steel discs, polarity does not matter.)
4. Put the board into the base on the standoffs, USB-C to the west opening.
5. Fit the lid (lip into rebate). Drive the 4 M2 × 12 screws from below: the 2
   south board screws and the 2 north corner screws. Stop at snug plus about a
   quarter turn: they cut into plastic and will strip if forced.
6. **Hinge.** Press the nyloc into the hex pocket, fit the tongue between the ears,
   put the bolt in with its washer and tighten until the teeth are fully engaged.
7. **Glass plate.** Clean the glass with IPA. Above ~15 °C, apply VHB, press it on
   hard for 30 s and leave it 24 h before hanging the pod (VHB reaches full
   strength in ~72 h). Use an uncoated area: whether the Supra's glass is
   metallised/athermic is still an open owner question (DESIGN-REV-A §11.2). Then
   set the angle so the pod is roughly level.

## Honest limitations

- **Not test-fitted.** Heights come from datasheets and KiCad models. J1 and SW3
  have no KiCad model; their heights are VERIFY items.
- **Magnet distances are under target:** 11.6 mm to the SAM-M10Q and 6.4 mm to the
  ESP32 antenna, in plan (see above). Measure RSSI and C/N0 with and without them.
- **The north board holes are not screwed**; the lid bosses clamp them, loaded by
  the two corner screws. Check for rattle by tapping the assembled pod.
- **The hinge ears flex about 1.1 mm** each time the angle changes. PETG/ASA
  handles that, but do not over-tighten the bolt: snug is enough, because the
  teeth do the locking.
- **The hinge knuckles print upright, not flat** (reason above). The teeth are
  45° and print without support, but their surface is stepped. They mesh after a
  few clicks.
- **The pod hangs 16 mm below the glass on a single plastic hinge.** Stiffness is
  estimated, not measured: log the IMU at idle and on a rough road before trusting
  the G data.
- **SW3, BOOT and RESET are on top.** Take the pod off its magnets to reach them.
  On rev A (USB only, no cell) SW3 can just stay ON.
- **GNSS through plastic + air + glass is unmeasured.** The real check is
  DESIGN-REV-A §10A test 4.
- **Heat.** Vents help, but this is not a sun shield. Component limits are 85 °C
  (§10.8). Do not leave the pod on the glass in parked summer sun.
- There is no IP rating: the vents and openings let dust in.
