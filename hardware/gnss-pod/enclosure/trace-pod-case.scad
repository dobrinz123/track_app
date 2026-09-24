// TRACE GNSS Pod rev A -- 3D-printable enclosure + mounts
// hardware/gnss-pod/enclosure/trace-pod-case.scad
//
// Parametric OpenSCAD, OpenSCAD 2021.01 language only (same rule as
// hardware/enclosure/trace-dongle-case.scad). Select the output with `part`:
//
//   openscad -o trace-pod-base.stl          -D "part=\"base\""   trace-pod-case.scad
//   openscad -o trace-pod-lid.stl           -D "part=\"lid\""    trace-pod-case.scad
//   openscad -o trace-pod-mount-glass.stl   -D "part=\"glass\""  trace-pod-case.scad
//   openscad -o trace-pod-mount-cradle.stl  -D "part=\"cradle\"" trace-pod-case.scad
//   openscad -o trace-pod-mount-disc.stl    -D "part=\"disc\""   trace-pod-case.scad
//   part = "assembled" | "exploded" | "onglass" -> colour previews (board mock-up)
//
// STL parts come out in PRINT orientation, no supports needed.
//
// ORIENTATION (owner decision): the pod has a MAGNETIC BASE, Dragy-style.
//   TOP  = lid  = component side = SAM-M10Q side -> faces the SKY in use
//          (DESIGN-REV-A §10.11). Never mount the pod with its top against glass.
//   BASE = cabin/bottom shell, carries 2 x 20x3 mm magnets flush in its floor.
// The base snaps onto: (1) the adjustable windscreen mount (glass plate + cradle,
// serrated friction hinge, M3 bolt), (2) a flat dash disc (VHB), (3) any flat
// steel surface.
//
// POD COORDINATES = board coordinates of DESIGN-REV-A §8, taken from
// hardware/kicad/gnss-pod/gnss-pod.kicad_pcb (Y_design = 72 - Y_kicad):
// origin = bottom-left board corner, X along the 50 mm edge, Y along the long edge,
// Z = 0 at the outside of the base floor, +Z = up (sky).
//
// NOT TEST-FITTED. Component heights come from datasheets / KiCad models (README).

part = "assembled"; // base | lid | glass | cradle | disc | assembled | exploded | onglass

/* ===================== Board (from gnss-pod.kicad_pcb) ===================== */
pcb_w   = 50.0;    // X, Edge.Cuts
pcb_l   = 66.95;   // Y, Edge.Cuts (board ends at the ESP32 antenna boundary)
pcb_t   = 1.6;
ant_overhang = 5.05;          // ESP32-S3-MINI-1 antenna end overhangs Y 66.95 -> 72.0
ant_x   = [17.25, 32.75];
holes   = [[3.5, 3.5], [46.5, 3.5], [3.5, 60.0], [46.5, 60.0]]; // MH1..4, 2.2 mm NPTH
screwed_holes = [[3.5, 3.5], [46.5, 3.5]];  // the two north holes sit over the magnets: clamped only
u2_c    = [25.0, 25.0];
u2_body = 15.5;

/* ===================== Component heights above the board top (mm) ===================== */
u2_h_max  = 6.8;   // SAM-M10Q 6.3 typ / 6.8 max (UBX-22013293 R05 Table 19)
u1_h      = 2.4;   // ESP32-S3-MINI-1 (DESIGN-REV-A §5)
usb_h     = 3.3;   // HRO TYPE-C-31-M-12, ~3.2 (VERIFY)
sw3_h     = 6.8;   // SS-12D00-G3 body ~3.8 + 3.0 lever (VERIFY)
btn_h     = 1.5;   // TS-1187A-B-A-B (LCSC C318884)
led_h     = 1.1;   // 0603 LED (KiCad model)
j2_h      = 6.0;   // JST B3B-PH-K vertical (KiCad model), NOT fitted on rev A

/* ===================== Fit / wall ===================== */
tol       = 0.3;   // board-to-cavity clearance (XY)
ant_gap   = 1.0;   // air beyond the antenna tip (plastic only)
wall      = 2.4;
floor_t   = 2.0;
lid_t     = 1.6;   // >= 1.5 plain plastic over the SAM-M10Q, no ribs
top_gap   = 0.5;
lip_t     = 1.0;
lip_h     = 1.5;
fit_clear = 0.2;
preload   = 0.2;   // lid bosses 0.2 longer than the gap -> the board is clamped
corner_r  = 3.0;

/* ===================== Magnetic base (in the pod floor) ===================== */
magnet_d   = 20.0;
magnet_h   = 3.0;
magnet_fit = 0.3;                  // pocket dia = 20.3
pocket_h   = magnet_h + 0.1;       // flush (0.1 glue line)
pad_skin   = 0.8;                  // plastic over the magnet inside the pod
// Under Z2 only (DESIGN-REV-A §8 "behind Z2, never Z1 or Z3"), pushed to the X
// extremes and to the south edge of Z2 to stay as far as possible from both the
// SAM-M10Q and the ESP32 antenna (numbers in README).
magnets    = [[9.0, 52.75], [41.0, 52.75]];
cones      = [[25, 45.75], [25, 59.75]]; // registration dimples (pod) / bumps (mounts)
cone_d     = 5.0;
cone_h     = 1.2;
cone_clear = 0.2;

/* ===================== Screws (M2 x 12 thread-forming, from below) ===================== */
standoff_h   = 4.0;   // leaves 2.1 mm between magnet pads and the board underside
standoff_d   = 5.0;
boss_d       = 4.2;
screw_clear  = 2.4;
pilot_d      = 1.7;
head_cb_d    = 4.4;
head_cb_h    = 1.8;
corner_posts = [[1.5, 70.5], [48.5, 70.5]]; // north case screws (outside the board, >= 15 mm from the antenna)
corner_post_d = 5.2;
support_posts = [[25, 40], [25, 12]];
post_d       = 5.0;
post_gap     = 0.1;

/* ===================== Openings ===================== */
usb_y      = 48.2;
usb_open_w = 12.0;
usb_open_h = 7.5;
led_win_y  = [54.3, 57.9];
led_win_h  = 2.8;
sw3_c      = [4.7, 64.68];
sw3_slot   = [6.5, 3.0];
btn_pos    = [[46.3, 18.2], [46.3, 10.4]]; // SW1 BOOT, SW2 RESET
btn_hole_d = 2.0;
btn_tube_d = 4.0;
btn_tube_gap = 0.8;
j2_slot    = false;
j2_y       = [48.6, 57.0];

/* ===================== Mounts ===================== */
acc_t      = pocket_h + 1.1;   // tray / disc thickness (counter-magnet flush + 1.1 floor)
// windscreen mount: fork (glass plate) + tongue (cradle), serrated, M3 bolt
windscreen_rake_deg = 30;      // PREVIEW ONLY: the hinge is adjustable ~15..75 deg
knuckle_r  = 9.0;
tongue_t   = 6.0;
ear_t      = 5.0;
leg_len    = 16.0;             // pivot to glass surface
pivot_gap  = 2.0;              // pod east wall to knuckle edge
teeth_n    = 24;               // 15 deg steps
teeth_r    = [2.1, 8.6];
m3_clear   = 3.4;
m3_nut_af  = 5.8;              // M3 nyloc 5.5 AF + 0.3
m3_nut_depth = 2.4;
glass_pad  = [-22, 6];         // pad extent along the glass, relative to the leg foot (down-slope -, up-slope +)
glass_pad_w = 40;
glass_pad_t = 3.0;
tray_y     = [36, 69.5];       // cradle tray extent along the pod's long axis

/* ===================== Vents / text ===================== */
vent_w   = 1.6;
text_depth = 0.4;

$fn = 48;
eps = 0.01;

/* ===================== Derived ===================== */
z_pcb_bot = floor_t + standoff_h;
z_split   = z_pcb_bot + pcb_t;
top_clear = u2_h_max + top_gap;
z_lid_in  = z_split + top_clear;
z_top     = z_lid_in + lid_t;
pad_top   = pocket_h + pad_skin;

cav = [-tol, -tol, pcb_w + tol, pcb_l + ant_overhang + ant_gap];
out = [cav[0] - wall, cav[1] - wall, cav[2] + wall, cav[3] + wall];
usb_zc = z_split + usb_h/2;

hinge_y  = (tray_y[0] + tray_y[1]) / 2;
pivot    = [out[2] + pivot_gap + knuckle_r, hinge_y, -acc_t + knuckle_r]; // pod coords, pod bottom at z=0
teeth_h_max = teeth_r[1] * sin(180 / teeth_n);

function glass_gap(a) = leg_len + (pivot[0] - out[2]) * sin(a) - (z_top - pivot[2]) * cos(a);

echo(str("Z stack: pad_top=", pad_top, " pcb_bot=", z_pcb_bot, " split=", z_split, " lid_in=", z_lid_in, " top=", z_top));
echo(str("Pod outer ", out[2]-out[0], " x ", out[3]-out[1], " x ", z_top, " mm"));
echo(str("Screw: head seat z=", head_cb_h, " board top=", z_split, " pilot end=", z_lid_in + 0.6,
         " -> max screw ", z_lid_in + 0.6 - head_cb_h));
echo(str("Pod top to glass (perpendicular): 15deg=", glass_gap(15), " 30deg=", glass_gap(30),
         " 45deg=", glass_gap(45), " 75deg=", glass_gap(75)));
echo(str("Hinge: stack ", 2*ear_t + tongue_t, " mm, teeth ", teeth_n, " (", 360/teeth_n, " deg), max tooth ", teeth_h_max));

/* ===================== Helpers ===================== */
module rrect(x0, y0, x1, y1, h, r = corner_r) {
  hull() for (x = [x0 + r, x1 - r], y = [y0 + r, y1 - r])
    translate([x, y, 0]) cylinder(r = r, h = h);
}
module box(x0, y0, z0, x1, y1, z1) { translate([x0, y0, z0]) cube([x1 - x0, y1 - y0, z1 - z0]); }

module west_openings() {
  box(out[0] - 1, usb_y - usb_open_w/2, usb_zc - usb_open_h/2, cav[0] + eps, usb_y + usb_open_w/2, usb_zc + usb_open_h/2);
  box(out[0] - 1, led_win_y[0], z_split - 1, cav[0] + eps, led_win_y[1], z_split + led_win_h);
}

/* ===================== Base (bottom shell, magnetic) ===================== */
module base() {
  difference() {
    union() {
      rrect(out[0], out[1], out[2], out[3], z_split);
      difference() {
        translate([0, 0, z_split - eps]) rrect(cav[0] - lip_t, cav[1] - lip_t, cav[2] + lip_t, cav[3] + lip_t, lip_h + eps, 1.0);
        box(cav[0], cav[1], z_split - 1, cav[2], cav[3], z_split + lip_h + 1);
      }
    }
    box(cav[0], cav[1], floor_t, cav[2], cav[3], z_split + lip_h + 1);
    west_openings();
    if (j2_slot) box(cav[2] - eps, j2_y[0], z_split - eps, out[2] + 1, j2_y[1], z_split + lip_h + 1);
  }
  difference() {
    union() {
      for (h = holes) translate([h[0], h[1], floor_t - eps]) cylinder(d = standoff_d, h = standoff_h + eps);
      for (p = support_posts) translate([p[0], p[1], floor_t - eps]) cylinder(d = post_d, h = standoff_h - post_gap + eps);
      for (p = corner_posts) translate([p[0], p[1], floor_t - eps]) cylinder(d = corner_post_d, h = z_split - floor_t + eps);
      for (m = magnets) translate([m[0], m[1], floor_t - eps]) cylinder(d = magnet_d + magnet_fit + 2.4, h = pad_top - floor_t + eps, $fn = 96);
    }
  }
}
module base_cuts() {
  for (h = concat(screwed_holes, corner_posts)) {
    translate([h[0], h[1], -1]) cylinder(d = screw_clear, h = z_split + 2, $fn = 24);
    translate([h[0], h[1], -1]) cylinder(d = head_cb_d, h = head_cb_h + 1, $fn = 32);
  }
  // magnet pockets, open on the bottom face (flush magnets)
  for (m = magnets) translate([m[0], m[1], -1]) cylinder(d = magnet_d + magnet_fit, h = pocket_h + 1, $fn = 96);
  // registration dimples (45 deg cones)
  for (c = cones) translate([c[0], c[1], -eps]) cylinder(d1 = cone_d, d2 = cone_d - 2*cone_h, h = cone_h + eps);
  // floor vents under Z1 (cabin side, away from magnets)
  for (y = [16, 20, 24, 28]) box(12, y, -1, 38, y + vent_w, floor_t + 1);
  // labels on the bottom face (mirrored so they read from outside)
  translate([25, 34.8, -eps]) mirror([1, 0, 0]) linear_extrude(text_depth + eps)
    text("TRACE POD A", size = 4.2, halign = "center", valign = "center");
  translate([25, 6.5, -eps]) mirror([1, 0, 0]) linear_extrude(text_depth + eps)
    text("TOP = SKY", size = 3, halign = "center", valign = "center");
}
module base_final() { difference() { base(); base_cuts(); } }

/* ===================== Lid (top shell, sky side) ===================== */
module lid_shell() {
  difference() {
    translate([0, 0, z_split]) rrect(out[0], out[1], out[2], out[3], z_top - z_split);
    box(cav[0], cav[1], z_split - 1, cav[2], cav[3], z_lid_in);
    translate([0, 0, z_split - 1])
      rrect(cav[0] - lip_t - fit_clear, cav[1] - lip_t - fit_clear, cav[2] + lip_t + fit_clear, cav[3] + lip_t + fit_clear,
            1 + lip_h + fit_clear, 1.0);
  }
}
module lid() {
  difference() {
    union() {
      lid_shell();
      for (h = holes) translate([h[0], h[1], z_split - preload]) cylinder(d = boss_d, h = z_lid_in - z_split + preload + eps);
      // corner screw posts stop 0.1 above the base posts (the board bosses take the clamp load)
      for (p = corner_posts) translate([p[0], p[1], z_split - preload + 0.1]) cylinder(d = corner_post_d, h = z_lid_in - z_split + preload - 0.1 + eps);
      for (b = btn_pos) translate([b[0], b[1], z_split + btn_h + btn_tube_gap]) cylinder(d = btn_tube_d, h = z_lid_in - (z_split + btn_h + btn_tube_gap) + eps);
    }
    for (h = concat(screwed_holes, corner_posts)) translate([h[0], h[1], z_split - 1]) cylinder(d = pilot_d, h = z_lid_in + 0.6 - z_split + 1, $fn = 20);
    for (b = btn_pos) {
      translate([b[0], b[1], z_split]) cylinder(d = btn_hole_d, h = z_top, $fn = 24);
      translate([b[0], b[1], z_top - 0.6]) cylinder(d1 = btn_hole_d, d2 = btn_hole_d + 1.4, h = 0.6 + eps, $fn = 24);
    }
    hull() {
      translate([sw3_c[0] - sw3_slot[0]/2, sw3_c[1] - sw3_slot[1]/2, z_lid_in - 1]) cube([sw3_slot[0], sw3_slot[1], z_top - z_lid_in]);
      translate([sw3_c[0] - sw3_slot[0]/2 - 0.8, sw3_c[1] - sw3_slot[1]/2 - 0.8, z_top - 0.8]) cube([sw3_slot[0] + 1.6, sw3_slot[1] + 1.6, 0.8 + eps]);
    }
    west_openings();
    if (j2_slot) box(cav[2] - eps, j2_y[0], z_split - 1, out[2] + 1, j2_y[1], z_split + j2_h + 1);
    // wall vents, high on the walls
    for (x = [11, 21.5, 32]) box(x, cav[3] - 1, z_lid_in - 3.2, x + 7, out[3] + 1, z_lid_in - 3.2 + vent_w);
    for (y = [24, 32]) {
      box(out[0] - 1, y, z_lid_in - 3.2, cav[0] + 1, y + 6, z_lid_in - 3.2 + vent_w);
      box(cav[2] - 1, y, z_lid_in - 3.2, out[2] + 1, y + 6, z_lid_in - 3.2 + vent_w);
    }
    translate([41.2, btn_pos[0][1], z_top - text_depth]) linear_extrude(1) text("B", size = 3, halign = "center", valign = "center");
    translate([41.2, btn_pos[1][1], z_top - text_depth]) linear_extrude(1) text("R", size = 3, halign = "center", valign = "center");
    translate([sw3_c[0] + 1.5, sw3_c[1] - 4.5, z_top - text_depth]) linear_extrude(1) text("ON/OFF", size = 2.2, halign = "center", valign = "center");
  }
}

/* ===================== Serrated hinge face (Hirth-style) =====================
   Local frame: axis = z, pitch plane z = 0, teeth crests +h/2, valleys -h/2,
   h(r) = r*sin(180/N) -> 45 deg flanks everywhere (prints without support in
   any orientation, meshes with a copy rotated by half a pitch). Solid below
   down to z = -h_max/2 - 0.3 so it fuses with the knuckle. */
module crown(phase = 0) {
  d = 180 / teeth_n;
  zb = -teeth_h_max/2 - 0.3;
  for (i = [0 : teeth_n - 1]) rotate([0, 0, phase + i * 2 * d])
    polyhedron(
      points = [ for (r = teeth_r) each [
        [r * cos(-d), r * sin(-d), -r * sin(d) / 2],
        [r * cos(d),  0,            r * sin(d) / 2],
        [r * cos(d),  r * sin(d),  -r * sin(d) / 2],
        [r * cos(d),  r * sin(d),  zb],
        [r * cos(-d), r * sin(-d), zb] ] ],
      faces = [[4, 3, 2, 1, 0], [5, 6, 7, 8, 9],
               [1, 6, 5, 0], [2, 7, 6, 1], [3, 8, 7, 2], [4, 9, 8, 3], [0, 5, 9, 4]]);
  translate([0, 0, zb]) cylinder(r = teeth_r[0] + 0.05, h = -zb - teeth_r[0] * sin(d) / 2, $fn = 24);
}
// knuckle disc + crown on its inner face. side = +1: teeth point +y; -1: -y.
module toothed_face(side, phase) {
  rotate([side > 0 ? -90 : 90, 0, 0]) crown(phase);
}

/* ===================== Cradle (tray + tongue), pod coordinates ===================== */
// tray top at z = 0 (= pod bottom), tray bottom at -acc_t
module acc_magnet_cuts(z_face) {
  for (m = magnets) translate([m[0], m[1], z_face - pocket_h]) cylinder(d = magnet_d + magnet_fit, h = pocket_h + 1, $fn = 96);
}
module acc_bumps(z_face) {
  for (c = cones) translate([c[0], c[1], z_face - eps])
    cylinder(d1 = cone_d - 2*cone_clear, d2 = cone_d - 2*cone_clear - 2*(cone_h - cone_clear), h = cone_h - cone_clear + eps);
}
module tongue() {
  // tongue plate in the XZ plane, centred on y = hinge_y, recessed by h_max/2 on both faces
  tt = tongue_t - teeth_h_max;
  difference() {
    union() {
      // knuckle arm stays east of the pod wall (x > out[2] + 0.5); the link to the
      // tray runs under the pod (z < 0) only
      hull() {
        translate([pivot[0], hinge_y - tt/2, pivot[2]]) rotate([-90, 0, 0]) cylinder(r = knuckle_r, h = tt, $fn = 64);
        box(out[2] + 0.5, hinge_y - tt/2, -acc_t, pivot[0], hinge_y + tt/2, pivot[2]);
      }
      box(out[2] - 8, hinge_y - tt/2, -acc_t, out[2] + 1, hinge_y + tt/2, 0);
      translate([pivot[0], hinge_y + tongue_t/2, pivot[2]]) toothed_face(+1, 180 / teeth_n);
      translate([pivot[0], hinge_y - tongue_t/2, pivot[2]]) toothed_face(-1, 180 / teeth_n);
    }
    translate([pivot[0], hinge_y, pivot[2]]) teardrop_y(m3_clear, 40);
  }
}
// horizontal (Y-axis) hole with a 45 deg peak on top: prints without support
module teardrop_y(d, len) {
  rotate([90, 0, 0]) linear_extrude(len, center = true)
    union() { circle(d = d, $fn = 24); rotate(45) square(d / 2); }
}
module cradle() {
  difference() {
    union() {
      translate([0, 0, -acc_t]) rrect(out[0], tray_y[0], out[2], tray_y[1], acc_t);
      acc_bumps(0);
      tongue();
    }
    acc_magnet_cuts(0);
  }
}

/* ===================== Glass plate (fork), own frame =====================
   Frame: glass face at z = 0 (VHB side, on the print bed), leg grows +z,
   pivot at (0, 0, leg_len), hinge axis = y, +x = up-slope along the glass.
   Fork ears clamp the tongue: inner faces at y = +-tongue_t/2. */
module ear(side) {   // side +1: ear at +y, its teeth point -y
  y_in  = side * (tongue_t/2 + teeth_h_max/2);
  y_out = side * (tongue_t/2 + ear_t);
  difference() {
    union() {
      hull() {
        translate([0, min(y_in, y_out), leg_len]) rotate([-90, 0, 0]) cylinder(r = knuckle_r, h = abs(y_out - y_in), $fn = 64);
        box(glass_pad[0] + 4, min(y_in, y_out), glass_pad_t - eps, glass_pad[1], max(y_in, y_out), glass_pad_t + 1);
      }
      translate([0, side * tongue_t/2, leg_len]) toothed_face(-side, 0);
    }
    translate([0, 0, leg_len]) teardrop_y(m3_clear, 60);
    // captive nyloc on the -y ear (hex, vertex up)
    if (side < 0) translate([0, y_out - eps, leg_len]) rotate([-90, 0, 0])
      rotate([0, 0, 90]) cylinder(d = m3_nut_af / cos(30), h = m3_nut_depth + eps, $fn = 6);
  }
}
module glass_plate() {
  union() {
    difference() {
      translate([0, 0, 0]) hull() {
        box(glass_pad[0] + 1, -glass_pad_w/2, 0, glass_pad[1] - 1, glass_pad_w/2, glass_pad_t - 0.8);
        box(glass_pad[0] + 1.8, -glass_pad_w/2 + 0.8, 0, glass_pad[1] - 1.8, glass_pad_w/2 - 0.8, glass_pad_t);
      }
      translate([-8, 0, -eps]) linear_extrude(0.4) mirror([1, 0, 0]) text("GLASS", size = 4, halign = "center", valign = "center");
    }
    ear(+1);
    ear(-1);
    // web between the ears near the pad (stays below the tongue's swing radius)
    box(glass_pad[0] + 4, -tongue_t/2 - eps, glass_pad_t - eps, -knuckle_r - 1, tongue_t/2 + eps, leg_len - 1);
    box(-knuckle_r - 1, -tongue_t/2 - eps, glass_pad_t - eps, glass_pad[1], tongue_t/2 + eps, leg_len - knuckle_r - 1.5);
  }
}

/* ===================== Dash disc ===================== */
module disc() {
  pr = (magnet_d + magnet_fit)/2 + 2.5;
  difference() {
    union() {
      hull() for (m = magnets) translate([m[0], m[1], -acc_t]) {
        cylinder(r = pr - 0.8, h = acc_t, $fn = 96);
        cylinder(r = pr, h = acc_t - 0.8, $fn = 96);
      }
      acc_bumps(0);
    }
    acc_magnet_cuts(0);
    translate([25, 52.75 - 9, -acc_t - eps]) linear_extrude(0.4) mirror([1, 0, 0]) text("DASH", size = 3.5, halign = "center", valign = "center");
  }
}

/* ===================== Board mock-up (preview only) ===================== */
module board_mock() {
  color("darkgreen") box(0, 0, z_pcb_bot, pcb_w, pcb_l, z_split);
  color("burlywood") translate([u2_c[0] - u2_body/2, u2_c[1] - u2_body/2, z_split]) cube([u2_body, u2_body, 6.3]);
  color("silver") box(17.3, 51.5, z_split, 32.7, 66.95, z_split + u1_h);
  color("seagreen") box(17.3, 66.95, z_split, 32.7, 72.0, z_split + 0.8);
  color("silver") box(0, 43.73, z_split, 7.35, 52.67, z_split + usb_h);
  color("white") box(0.25, 62.68, z_split, 9.15, 66.68, z_split + 3.8);
  color("black") translate([sw3_c[0] - 0.75 - 1, sw3_c[1] - 0.75, z_split + 3.8]) cube([1.5, 1.5, 3.0]);
  for (b = btn_pos) color("gray") translate([b[0] - 2.55, b[1] - 2.55, z_split]) cube([5.1, 5.1, btn_h]);
  color("gold") box(0.97, 54.81, z_split, 2.53, 55.49, z_split + led_h);
  color("gold") box(0.97, 56.36, z_split, 2.53, 57.04, z_split + led_h);
  color("red") box(4.17, 56.36, z_split, 5.73, 57.04, z_split + led_h);
  color("black") translate([22.3 - 1.25, 47.2 - 1.5, z_split]) cube([2.5, 3, 0.86]);
}
module magnets_mock() { for (m = magnets) color("lightgray") translate([m[0], m[1], 0.05]) cylinder(d = magnet_d, h = magnet_h); }
module pod_assembled() {
  color("dimgray") base_final();
  board_mock();
  color("slategray", 0.55) lid();
  magnets_mock();
}
// glass frame -> pod frame at rake angle a (pod bottom at z = 0, pod level)
module glass_to_pod(a) {
  c = cos(a); s = sin(a);
  translate(pivot) multmatrix([[-c, 0, -s, 0], [0, 1, 0, 0], [s, 0, -c, 0], [0, 0, 0, 1]])
    translate([0, 0, -leg_len]) children();
}

/* ===================== Part selector (print orientations) ===================== */
if (part == "base") {
  base_final();
} else if (part == "lid") {
  translate([0, 0, z_top]) rotate([180, 0, 0]) lid();          // top face on the bed
} else if (part == "cradle") {
  translate([0, 0, acc_t]) cradle();                            // tray bottom on the bed
} else if (part == "glass") {
  glass_plate();                                                // VHB face on the bed
} else if (part == "disc") {
  translate([0, 0, acc_t]) disc();                              // VHB face on the bed
} else if (part == "assembled") {
  pod_assembled();
} else if (part == "exploded") {
  e = 22;
  color("dimgray") base_final();
  color("lightgray") for (m = magnets) translate([m[0], m[1], -e * 0.7]) cylinder(d = magnet_d, h = magnet_h);
  translate([0, 0, e * 0.8]) board_mock();
  color("slategray") translate([0, 0, e * 1.8]) lid();
  color("orange") translate([0, 0, -e * 1.5]) disc();
  color("lightgray") for (m = magnets) translate([m[0], m[1], -e * 1.5 + 6]) cylinder(d = magnet_d, h = magnet_h);
} else if (part == "onglass") {
  a = windscreen_rake_deg;
  pod_assembled();
  color("orange") cradle();
  color("darkorange") glass_to_pod(a) glass_plate();
  color("lightblue", 0.35) glass_to_pod(a) translate([-45, -40, -4]) cube([150, 150, 4]);
  color("silver") translate([pivot[0], hinge_y, pivot[2]]) rotate([90, 0, 0]) cylinder(d = 3, h = 2*ear_t + tongue_t + 6, center = true);
}
