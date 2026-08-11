// TRACE OBD Telemetry Dongle -- 3D-printable enclosure
// hardware/enclosure/trace-dongle-case.scad
//
// Parametric OpenSCAD (targets OpenSCAD 2021.01 language features only --
// no textmetrics, no newer builtins). Produces two parts selected via the
// `part` variable (set from the CLI with -D part=\"body\" / -D part=\"lid\"):
//
//   openscad -o trace-dongle-body.stl -D part=\"body\" trace-dongle-case.scad
//   openscad -o trace-dongle-lid.stl  -D part=\"lid\"  trace-dongle-case.scad
//
// part="both" (default below) renders both side-by-side for a quick visual
// sanity check / preview.png export.
//
// *** COMPONENT POSITIONS ARE NOT FINAL ***
// PCB layout (hardware/kicad/trace-dongle/) runs in parallel with this file.
// Every feature that depends on component placement (standoff XY, SW1 cutout
// X position, LED light-pipe XY, plug aperture centering) is a named
// parameter below with a *placeholder* default. Re-render this file (and
// re-check standoff_positions / sw1_pos_frac / led*_pos / plug_aperture_z)
// once the PCB layout freezes.

part = "both"; // "body" | "lid" | "both"

/* ===================== Board envelope (hardware/DESIGN.md section 4) ===================== */
pcb_l = 62;      // PCB length (mm), along X
pcb_w = 30;      // PCB width (mm), along Y
pcb_t = 1.6;     // PCB thickness (mm)

/* ===================== Wall / fit / tolerance ===================== */
wall        = 2.0;   // case wall thickness (body + lid plate)
clearance   = 0.4;   // general mating/tolerance clearance (lid-skirt-to-cavity gap, snap window slack)
cavity_margin = 2.5;  // extra XY room around the PCB inside the body cavity (wires/headers/fingers)

/* ===================== Body height budget ===================== */
standoff_h        = 3.0;  // PCB stands this high above the floor (bottom clearance)
standoff_od       = 4.0;  // standoff boss outer diameter
standoff_hole_d   = 2.0;  // pilot hole diameter for M2 self-tap screw
standoff_hole_depth = standoff_h - 0.6; // blind hole (0.6mm solid floor under the hole)
component_clear_h = 8.0;  // headroom above PCB top face for tallest component + wiggle room
floor_t = wall;           // case floor thickness = wall

/* ===================== Standoff XY (PLACEHOLDER -- re-check after PCB layout freezes) ===================== */
standoff_inset_x = 4; // inset from PCB left/right edge to standoff center
standoff_inset_y = 4; // inset from PCB front/back edge to standoff center

/* ===================== J1962 plug aperture (one end wall; plug shell protrudes through it) ===================== */
// Generous per ticket -- trimmed at print time once the real connector shell
// is on hand. The plug shell (~38mm) is WIDER than the 25mm PCB, so the case
// overall width is derived to be at least plug_aperture_w + 2*plug_wall_margin
// (see case width derivation below) rather than tapering/stepping the case --
// simplest printable geometry for a first-pass prototype.
plug_aperture_w   = 38;  // aperture width (mm), centered on the end wall
plug_aperture_h   = 12;  // aperture height (mm)
plug_wall_margin  = 3;   // min solid wall material either side of the aperture
plug_aperture_z   = standoff_h + pcb_t/2 + 3; // aperture center height above floor (PLACEHOLDER)

/* ===================== SW1 side cutout (PLACEHOLDER position) ===================== */
sw1_cutout_w  = 3;    // cutout width along the wall (X)
sw1_cutout_h  = 8;    // cutout height (Z)
sw1_pos_frac  = 0.15; // SW1 X position as a fraction of case length -- PLACEHOLDER, re-check vs PCB layout
                       // (kept near one end, clear in X of the vent group and snap windows below)
sw1_z         = standoff_h + pcb_t/2 + 2; // cutout center height above floor

/* ===================== Vent slot groups (two groups, one per long side wall) ===================== */
// Sized/positioned to stay clear (in X) of the SW1 cutout and the snap-catch
// windows on the same walls -- span = count*l + (count-1)*pitch must fit the
// gap between the two snap windows (see snap_x_fracs below).
vent_slot_w     = 1.2;  // slot height (Z) -- kept small, bridges trivially
vent_slot_l     = 4;    // slot length (X)
vent_slot_count = 3;    // slots per group
vent_slot_pitch = 2.0;  // gap between slots
vent_group_x    = 0.5;  // group center as a fraction of case length
vent_z          = standoff_h + pcb_t + component_clear_h*0.5; // group center height above floor

/* ===================== LED light-pipe holes (lid, PLACEHOLDER positions relative to PCB origin) ===================== */
// Offset off the PCB Y centerline so they don't collide with the centered
// engraved text below (also on the Y centerline).
led_hole_d = 3;
led1_pos = [pcb_l*0.20, pcb_w*0.78];
led2_pos = [pcb_l*0.32, pcb_w*0.78];

/* ===================== Lid / snap-fit ===================== */
lid_t          = wall; // lid top plate thickness
lid_skirt_h    = 6.0;  // depth of the skirt that plugs into the body cavity
skirt_wall_t   = 1.4;  // skirt ring wall thickness

finger_w       = 5.0;  // cantilever snap finger width
finger_length  = lid_skirt_h; // fingers run the full skirt height (free tip at skirt end)
kerf           = 0.6;  // relief-slot width freeing each finger from the skirt ring
nub_from_tip   = 2.2;  // distance from the finger's free tip down to the nub apex
nub_h          = 0.8;  // nub protrusion (ramp rise) -- ramp angle = atan(nub_h/nub_from_tip) ~ 20 deg, well under 50 deg
shoulder_len   = 1.2;  // length of the flat retention shoulder above the ramp apex
snap_window_w  = finger_w + 1.6; // body wall cutout width the nub engages into (generous for assembly)
snap_x_fracs   = [0.28, 0.72];   // two snaps per long side, as fractions of case length

/* ===================== Engraved text (lid top face) ===================== */
text_line1  = "TRACE";
text_line2  = ""; // optional second line, "2 lines max" per ticket -- empty by default
text_size   = 4.5;
text_depth  = 0.4; // shallow engrave

/* ===================== Derived geometry ===================== */
inner_l = pcb_l + 2*cavity_margin;
// Case must be wide enough to host the plug aperture in its end wall as well
// as the PCB + margin -- take whichever requirement is larger.
outer_w = max(pcb_w + 2*cavity_margin + 2*wall, plug_aperture_w + 2*plug_wall_margin);
outer_l = inner_l + 2*wall;
inner_w = outer_w - 2*wall;

pcb_x0 = wall + (inner_l - pcb_l)/2;
pcb_y0 = wall + (inner_w - pcb_w)/2;

body_wall_h = max(standoff_h + pcb_t + component_clear_h,
                   plug_aperture_z + plug_aperture_h/2 + 2,
                   lid_skirt_h + 3);

standoff_positions = [
  [pcb_x0 + standoff_inset_x,          pcb_y0 + standoff_inset_y],
  [pcb_x0 + pcb_l - standoff_inset_x,  pcb_y0 + standoff_inset_y],
  [pcb_x0 + standoff_inset_x,          pcb_y0 + pcb_w - standoff_inset_y],
  [pcb_x0 + pcb_l - standoff_inset_x,  pcb_y0 + pcb_w - standoff_inset_y],
];

sw1_pos_x = outer_l * sw1_pos_frac;
snap_x_positions = [for (f = snap_x_fracs) outer_l * f];

nub_apex_z    = finger_length - nub_from_tip;      // measured from the finger root (0 = at the lid plate)
shoulder_bot_z = nub_apex_z - shoulder_len;
snap_window_h  = shoulder_len + 1;                 // world-space cutout height in the body wall
snap_window_z0 = floor_t + body_wall_h - nub_apex_z - 0.5; // world z of the window's bottom edge

$fn = 32;

/* ===================== Modules ===================== */

module standoff(x, y) {
  translate([x, y, floor_t])
    difference() {
      cylinder(h = standoff_h, d = standoff_od);
      translate([0, 0, standoff_h - standoff_hole_depth])
        cylinder(h = standoff_hole_depth + 0.1, d = standoff_hole_d, $fn = 16);
    }
}

module vent_group(side) {
  // side 0 -> y=0 wall, side 1 -> y=outer_w wall
  y0 = (side == 0) ? -0.5 : outer_w - wall - 0.5;
  group_span = vent_slot_count*vent_slot_l + (vent_slot_count-1)*vent_slot_pitch;
  x_start = outer_l*vent_group_x - group_span/2;
  for (i = [0:vent_slot_count-1]) {
    translate([x_start + i*(vent_slot_l+vent_slot_pitch), y0, floor_t+vent_z-vent_slot_w/2])
      cube([vent_slot_l, wall+1, vent_slot_w]);
  }
}

module body() {
  difference() {
    union() {
      cube([outer_l, outer_w, floor_t + body_wall_h]);
    }
    // hollow interior, open top
    translate([wall, wall, floor_t])
      cube([inner_l, inner_w, body_wall_h + 1]);
    // J1962 plug aperture, end wall at x=0
    translate([-0.5, outer_w/2 - plug_aperture_w/2, floor_t + plug_aperture_z - plug_aperture_h/2])
      cube([wall+1, plug_aperture_w, plug_aperture_h]);
    // SW1 side cutout, y=0 wall
    translate([sw1_pos_x - sw1_cutout_w/2, -0.5, floor_t + sw1_z - sw1_cutout_h/2])
      cube([sw1_cutout_w, wall+1, sw1_cutout_h]);
    // vent slot groups, both long walls
    vent_group(0);
    vent_group(1);
    // snap-catch windows, two per long wall
    for (sx = snap_x_positions) {
      translate([sx - snap_window_w/2, -0.5, snap_window_z0])
        cube([snap_window_w, wall+1, snap_window_h]);
      translate([sx - snap_window_w/2, outer_w-wall-0.5, snap_window_z0])
        cube([snap_window_w, wall+1, snap_window_h]);
    }
  }
  for (p = standoff_positions) standoff(p[0], p[1]);
}

module finger_relief(sx, side, so_w) {
  y0 = (side == 0) ? -0.1 : so_w - skirt_wall_t - 0.1;
  yl = skirt_wall_t + 0.2;
  translate([sx - finger_w/2 - kerf, y0, -0.5]) cube([kerf, yl, finger_length+1]);
  translate([sx + finger_w/2,        y0, -0.5]) cube([kerf, yl, finger_length+1]);
}

module nub(sx, side, so_w) {
  sign   = (side == 0) ? -1 : 1;
  y_flush = (side == 0) ? 0 : so_w;
  x0 = sx - finger_w/2;
  // ramp: flush at the free tip -> full protrusion at the nub apex.
  // vertical run = nub_from_tip, horizontal run = nub_h => angle from vertical
  // = atan(nub_h/nub_from_tip) ~ 20 deg (< 50 deg overhang limit).
  hull() {
    translate([x0, y_flush, finger_length - 0.3]) cube([finger_w, 0.05, 0.3]);
    translate([x0, y_flush + sign*nub_h, nub_apex_z - 0.3]) cube([finger_w, 0.05, 0.6]);
  }
  // retention shoulder: constant protrusion back down to shoulder_bot_z
  translate([x0, min(y_flush, y_flush + sign*nub_h), shoulder_bot_z])
    cube([finger_w, nub_h, nub_apex_z - shoulder_bot_z]);
}

module skirt() {
  so_l = outer_l - 2*wall - 2*clearance;
  so_w = outer_w - 2*wall - 2*clearance;
  translate([wall+clearance, wall+clearance, 0]) {
    difference() {
      union() {
        difference() {
          cube([so_l, so_w, lid_skirt_h]);
          translate([skirt_wall_t, skirt_wall_t, -0.5])
            cube([so_l - 2*skirt_wall_t, so_w - 2*skirt_wall_t, lid_skirt_h+1]);
        }
        for (sx = snap_x_positions_local(so_l)) {
          nub(sx, 0, so_w);
          nub(sx, 1, so_w);
        }
      }
      for (sx = snap_x_positions_local(so_l))
        for (side = [0, 1])
          finger_relief(sx, side, so_w);
    }
  }
}

// snap x positions expressed in the skirt's local frame (skirt origin is
// offset from the body/lid world origin by wall+clearance)
function snap_x_positions_local(so_l) = [for (f = snap_x_fracs) outer_l*f - (wall+clearance)];

module lid() {
  difference() {
    union() {
      cube([outer_l, outer_w, lid_t]);
      translate([0, 0, lid_t]) skirt();
    }
    // LED light-pipe holes
    translate([pcb_x0 + led1_pos[0], pcb_y0 + led1_pos[1], -0.5])
      cylinder(h = lid_t+1, d = led_hole_d);
    translate([pcb_x0 + led2_pos[0], pcb_y0 + led2_pos[1], -0.5])
      cylinder(h = lid_t+1, d = led_hole_d);
    // engraved text, top face of the plate (this face sits against the print
    // bed in this file's print orientation -- see header note)
    y_line1 = (text_line2 == "") ? outer_w/2 : outer_w/2 + text_size*0.75;
    translate([outer_l/2, y_line1, lid_t - text_depth + 0.01])
      linear_extrude(height = text_depth + 0.02)
        text(text_line1, size = text_size, halign = "center", valign = "center");
    if (text_line2 != "")
      translate([outer_l/2, outer_w/2 - text_size*0.75, lid_t - text_depth + 0.01])
        linear_extrude(height = text_depth + 0.02)
          text(text_line2, size = text_size*0.8, halign = "center", valign = "center");
  }
}

/* ===================== Part selector ===================== */
if (part == "body") {
  body();
} else if (part == "lid") {
  lid();
} else {
  body();
  translate([outer_l + 15, 0, 0]) lid();
}
