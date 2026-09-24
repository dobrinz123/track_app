"""Faceless motion graphics in TRACE's own visual language, rendered frame-by-frame with Pillow.

No stock footage, no faces, no GPU: every frame is drawn from brand colours, the app's lap-timer
screen, and real circuit geometry from the app's bundled OSM-derived catalog (ODbL, attributed
on screen). Static layers are built once per scene; per frame only the moving parts are drawn.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG = (10, 10, 12)
PANEL = (18, 18, 22)
PANEL2 = (26, 26, 32)
LINE = (44, 44, 52)
TEXT = (242, 242, 244)
MUTED = (154, 154, 163)
AMBER = (255, 179, 0)
GREEN = (0, 230, 118)
RED = (255, 59, 48)

FONT_DIR = Path("C:/Windows/Fonts")
FONTS = {"black": "seguibl.ttf", "bold": "segoeuib.ttf", "label": "bahnschrift.ttf", "mono": "consolab.ttf"}
_font_cache: dict = {}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    key = (kind, size)
    if key not in _font_cache:
        try:
            _font_cache[key] = ImageFont.truetype(str(FONT_DIR / FONTS[kind]), size)
        except OSError:
            _font_cache[key] = ImageFont.load_default(size)
    return _font_cache[key]


def ease_out(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def wrap(draw: ImageDraw.ImageDraw, text: str, fnt, max_w: int) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=fnt) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def text_block(text: str, size: int, max_w: int, color=TEXT, kind="black", accent_last=True) -> Image.Image:
    """Render a centred multi-line headline once; the last line is amber for emphasis."""
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    fnt = font(kind, size)
    lines = wrap(probe, text.upper(), fnt, max_w)
    lh = int(size * 1.08)
    img = Image.new("RGBA", (max_w, lh * len(lines) + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, ln in enumerate(lines):
        w = d.textlength(ln, font=fnt)
        col = AMBER if (accent_last and i == len(lines) - 1 and len(lines) > 1) else color
        d.text(((max_w - w) / 2, i * lh), ln, font=fnt, fill=col)
    return img


def paste_anim(frame: Image.Image, layer: Image.Image, x: int, y: int, t: float, delay=0.0, rise=60):
    """Slide-up + fade-in over 0.35 s."""
    p = ease_out((t - delay) / 0.35)
    if p <= 0:
        return
    if p < 1:
        layer = layer.copy()
        alpha = layer.getchannel("A").point(lambda a: int(a * p))
        layer.putalpha(alpha)
    frame.alpha_composite(layer, (int(x), int(y + (1 - p) * rise)))


# ---------------------------------------------------------------- circuits

CIRCUIT_FILES = {"tmr": "transilvania-motor-ring.v2.json", "motorpark": "motorpark-romania.v1.json"}


def load_circuit(repo_root: Path, cid: str) -> dict:
    path = repo_root / "packages/core/assets/circuits" / CIRCUIT_FILES[cid]
    data = json.loads(path.read_text(encoding="utf-8"))
    pts = data["centerline"]
    lat0 = sum(p["lat"] for p in pts) / len(pts)
    k = math.cos(math.radians(lat0))
    xy = [(p["lon"] * k, -p["lat"]) for p in pts]  # equirectangular, north up
    if xy[0] != xy[-1]:
        xy.append(xy[0])
    return {"name": data["displayName"], "length_m": data["totalLengthM"],
            "direction": data["direction"], "xy": xy}


def fit(xy, box_w, box_h, ox, oy):
    xs, ys = [p[0] for p in xy], [p[1] for p in xy]
    s = min(box_w / (max(xs) - min(xs)), box_h / (max(ys) - min(ys)))
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    return [(ox + box_w / 2 + (x - cx) * s, oy + box_h / 2 + (y - cy) * s) for x, y in xy]


def cumulative(pts):
    acc = [0.0]
    for a, b in zip(pts, pts[1:]):
        acc.append(acc[-1] + math.dist(a, b))
    return acc


def point_at(pts, acc, dist):
    dist %= acc[-1]
    lo, hi = 0, len(acc) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if acc[mid] <= dist:
            lo = mid
        else:
            hi = mid
    seg = acc[hi] - acc[lo] or 1
    f = (dist - acc[lo]) / seg
    (x1, y1), (x2, y2) = pts[lo], pts[hi]
    return x1 + (x2 - x1) * f, y1 + (y2 - y1) * f


def sub_path(pts, acc, d0, d1, steps=90):
    return [point_at(pts, acc, d0 + (d1 - d0) * i / steps) for i in range(steps + 1)]


# ---------------------------------------------------------------- scenes

class Renderer:
    def __init__(self, width: int, height: int, repo_root: Path, lang: str):
        self.W, self.H = width, height
        self.repo = repo_root
        self.lang = lang
        self.logo = Image.open(repo_root / "apps/mobile/assets/trace_logo_mark.png").convert("RGBA")
        self.bg = self._background()

    def _background(self) -> Image.Image:
        img = Image.new("RGBA", (self.W, self.H), BG + (255,))
        d = ImageDraw.Draw(img)
        for x in range(0, self.W, 90):
            d.line([(x, 0), (x, self.H)], fill=(16, 16, 20), width=1)
        for y in range(0, self.H, 90):
            d.line([(0, y), (self.W, y)], fill=(16, 16, 20), width=1)
        glow = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse([-300, -500, self.W + 300, 700], fill=AMBER + (22,))
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(160)))
        return img

    # Chrome shared by all scenes: brand tag top-left, progress bar at the very top.
    def chrome(self, frame: Image.Image, progress: float):
        d = ImageDraw.Draw(frame)
        d.rectangle([0, 0, int(self.W * progress), 10], fill=AMBER)
        small = self.logo.resize((64, 64), Image.LANCZOS)
        frame.alpha_composite(small, (56, 70))
        d.text((132, 82), "TRACE", font=font("black", 40), fill=TEXT)

    def prepare(self, scene: dict, duration: float, circuit_id: str | None) -> dict:
        kind = scene["kind"]
        st = {"kind": kind, "dur": duration,
              "head": text_block(scene["onscreen"], 112 if kind in ("hook", "cta") else 92, self.W - 160)}
        if kind == "track":
            cid = circuit_id or "tmr"
            c = load_circuit(self.repo, cid)
            pts = fit(c["xy"], self.W - 160, 900, 80, 420)
            st.update(circuit=c, pts=pts, acc=cumulative(pts))
            base = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
            bd = ImageDraw.Draw(base)
            bd.line(pts, fill=LINE, width=34, joint="curve")
            bd.line(pts, fill=(30, 30, 36), width=22, joint="curve")
            st["track_base"] = base
        return st

    def frame(self, st: dict, t: float, progress: float) -> Image.Image:
        f = self.bg.copy()
        getattr(self, f"_{st['kind']}")(f, st, t)
        self.chrome(f, progress)
        return f

    def _speed_lines(self, f, t, n=14):
        d = ImageDraw.Draw(f)
        for i in range(n):
            y = 260 + (i * 97) % 1100
            x = (i * 311 + t * (900 + i * 60)) % (self.W + 600) - 300
            ln = 120 + (i * 37) % 200
            d.line([(x, y), (x + ln, y)], fill=(255, 179, 0, 40 if i % 3 else 70), width=4)

    def _hook(self, f, st, t):
        self._speed_lines(f, t)
        head = st["head"]
        y = 820 - head.height // 2
        paste_anim(f, head, 80, y, t, rise=90)
        d = ImageDraw.Draw(f)
        bar = int(ease_out((t - 0.25) / 0.5) * 360)
        if bar > 0:
            d.rectangle([self.W / 2 - bar / 2, y + head.height + 20, self.W / 2 + bar / 2, y + head.height + 32], fill=AMBER)

    def _point(self, f, st, t):
        d = ImageDraw.Draw(f)
        d.rounded_rectangle([60, 470, self.W - 60, 1180], radius=40, fill=PANEL + (255,), outline=LINE, width=3)
        idx = st.get("index", 1)
        num = Image.new("RGBA", (400, 190), (0, 0, 0, 0))
        ImageDraw.Draw(num).text((0, 0), f"{idx:02d}", font=font("black", 170), fill=AMBER)
        paste_anim(f, num, 110, 520, t, rise=30)
        head = st["head"]
        paste_anim(f, head, 80, 1180 - 90 - head.height, t, delay=0.12)
        grow = ease_out(t / max(0.5, st["dur"]))
        d.rectangle([110, 745, 110 + int((self.W - 220) * grow), 753], fill=AMBER)

    def _track(self, f, st, t):
        pts, acc, c = st["pts"], st["acc"], st["circuit"]
        f.alpha_composite(st["track_base"])
        total = acc[-1]
        draw_in = ease_out(t / 1.2)
        glow = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        if draw_in < 1:
            gd.line(sub_path(pts, acc, 0, total * draw_in, 140), fill=AMBER + (255,), width=10, joint="curve")
        else:
            lap = (t - 1.2) / max(1.0, st["dur"] - 1.2)
            head_d = (lap * total) % total
            trail = sub_path(pts, acc, head_d - total * 0.14, head_d, 60)
            gd.line(trail, fill=AMBER + (255,), width=12, joint="curve")
            x, y = point_at(pts, acc, head_d)
            gd.ellipse([x - 22, y - 22, x + 22, y + 22], fill=AMBER + (255,))
        f.alpha_composite(glow.filter(ImageFilter.GaussianBlur(9)))
        f.alpha_composite(glow)
        d = ImageDraw.Draw(f)
        sx, sy = pts[0]
        d.rectangle([sx - 6, sy - 30, sx + 6, sy + 30], fill=GREEN)
        paste_anim(f, st["head"], 80, 250, t)
        km = c["length_m"] / 1000
        info = f"{c['name'].upper()}  ·  {km:.1f} KM  ·  {c['direction'].upper()}"
        w = d.textlength(info, font=font("label", 38))
        d.text(((self.W - w) / 2, 1480), info, font=font("label", 38), fill=MUTED)
        attr = "Map data © OpenStreetMap contributors, ODbL"
        w = d.textlength(attr, font=font("label", 24))
        d.text(((self.W - w) / 2, self.H - 70), attr, font=font("label", 24), fill=(90, 90, 98))

    def _timer(self, f, st, t):
        """The app's live lap screen (see LAP_VIEW.png), animated with illustrative values."""
        paste_anim(f, st["head"], 80, 230, t)
        d = ImageDraw.Draw(f)
        x0, y0, x1, y1 = 110, 480, self.W - 110, 1250
        d.rounded_rectangle([x0, y0, x1, y1], radius=48, fill=(12, 12, 14), outline=LINE, width=4)
        # GNSS pill + lap
        d.rounded_rectangle([x0 + 36, y0 + 34, x0 + 250, y0 + 84], radius=25, outline=GREEN, width=3)
        d.ellipse([x0 + 54, y0 + 52, x0 + 68, y0 + 66], fill=GREEN)
        d.text((x0 + 78, y0 + 44), "GNSS GOOD", font=font("bold", 26), fill=GREEN)
        d.text((x1 - 170, y0 + 40), "LAP 4", font=font("bold", 38), fill=MUTED)
        # delta: drifts from +0.31 to -0.42, colour flips at zero
        p = ease_out(t / max(1.0, st["dur"] * 0.8))
        delta = 0.31 + (-0.42 - 0.31) * p
        col = GREEN if delta < 0 else RED
        cx = (x0 + x1) / 2
        bar = int(min(1.0, abs(delta) / 0.5) * 300)
        if delta < 0:
            d.rounded_rectangle([cx - bar, y0 + 190, cx, y0 + 214], radius=10, fill=col)
        else:
            d.rounded_rectangle([cx, y0 + 190, cx + bar, y0 + 214], radius=10, fill=col)
        d.ellipse([cx - 16, y0 + 186, cx + 16, y0 + 218], fill=(80, 80, 88))
        txt = f"{delta:+.2f}"
        w = d.textlength(txt, font=font("mono", 120))
        d.text((cx - w / 2, y0 + 240), txt, font=font("mono", 120), fill=col)
        lab = "SECONDS VS. REFERENCE"
        w = d.textlength(lab, font=font("label", 28))
        d.text((cx - w / 2, y0 + 380), lab, font=font("label", 28), fill=MUTED)
        # running lap time
        lt = 58.2 + t
        clock = f"{int(lt // 60)}:{lt % 60:06.3f}"
        w = d.textlength(clock, font=font("mono", 150))
        d.text((cx - w / 2, y0 + 440), clock, font=font("mono", 150), fill=TEXT)
        # sectors
        active = min(2, int(t / max(0.8, st["dur"] / 3)))
        cw = (x1 - x0 - 72 - 40) / 3
        for i in range(3):
            sx = x0 + 36 + i * (cw + 20)
            on = i == active
            d.rounded_rectangle([sx, y0 + 640, sx + cw, y0 + 710], radius=14,
                                fill=AMBER if on else PANEL2, outline=None if on else LINE, width=2)
            s = f"S{i + 1}"
            w = d.textlength(s, font=font("bold", 34))
            d.text((sx + (cw - w) / 2, y0 + 652), s, font=font("bold", 34), fill=BG if on else MUTED)
        tag = "ILLUSTRATIVE" if self.lang == "en" else "ILUSTRATIV"
        d.text((x0 + 36, y1 - 44), tag, font=font("label", 22), fill=(90, 90, 98))

    def _cta(self, f, st, t):
        d = ImageDraw.Draw(f)
        cx, cy = self.W // 2, 640
        pulse = (t % 1.4) / 1.4
        r = 230 + pulse * 120
        ring = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
        ImageDraw.Draw(ring).ellipse([cx - r, cy - r, cx + r, cy + r], outline=AMBER + (int(160 * (1 - pulse)),), width=6)
        f.alpha_composite(ring)
        s = 0.6 + 0.4 * ease_out(t / 0.5)
        logo = self.logo.resize((int(420 * s), int(420 * s)), Image.LANCZOS)
        f.alpha_composite(logo, (cx - logo.width // 2, cy - logo.height // 2))
        word = "TRACE"
        w = d.textlength(word, font=font("black", 130))
        d.text((cx - w / 2, 890), word, font=font("black", 130), fill=TEXT)
        paste_anim(f, st["head"], 80, 1060, t, delay=0.2)

    # ------------------------------------------------------------ coaching product shots
    # All three mirror real app screens (CoachStrip, PitViewScreen, AnalysisScreen) with illustrative numbers.

    def _card(self, d, top=480, bottom=1250):
        x0, x1 = 110, self.W - 110
        d.rounded_rectangle([x0, top, x1, bottom], radius=48, fill=(12, 12, 14), outline=LINE, width=4)
        return x0, top, x1, bottom

    def _tag(self, d, x, y):
        d.text((x, y + 8), "ILLUSTRATIVE" if self.lang == "en" else "ILUSTRATIV", font=font("label", 22), fill=(90, 90, 98))

    def _center(self, d, text, y, fnt, fill, cx=None):
        cx = self.W / 2 if cx is None else cx
        d.text((cx - d.textlength(text, font=fnt) / 2, y), text, font=fnt, fill=fill)

    def _coach(self, f, st, t):
        """Live: the corner-ahead strip counting down, then the spoken callout."""
        paste_anim(f, st["head"], 80, 230, t)
        d = ImageDraw.Draw(f)
        x0, y0, x1, y1 = self._card(d)
        cx = (x0 + x1) / 2
        dur = max(1.5, st["dur"])
        # countdown 180 m -> 0 over ~70 % of the scene
        dist = max(0, 180 * (1 - t / (dur * 0.7)))
        d.text((x0 + 40, y0 + 40), "NEXT CORNER" if self.lang == "en" else "VIRAJUL URMĂTOR",
               font=font("label", 30), fill=MUTED)
        d.text((x0 + 40, y0 + 90), "T5", font=font("black", 170), fill=TEXT)
        # severity chip (6 = hairpin, red like the app's top severity)
        d.rounded_rectangle([x0 + 330, y0 + 140, x0 + 640, y0 + 210], radius=16, outline=RED, width=4)
        d.text((x0 + 352, y0 + 150), "6 · HAIRPIN" if self.lang == "en" else "6 · AC DE PĂR",
               font=font("bold", 36), fill=RED)
        d.text((x0 + 40, y0 + 300), ("TARGET" if self.lang == "en" else "ȚINTĂ") + "  62 km/h",
               font=font("bold", 48), fill=AMBER)
        # countdown bar + metres
        bw = x1 - x0 - 80
        d.rounded_rectangle([x0 + 40, y0 + 400, x1 - 40, y0 + 436], radius=18, fill=PANEL2)
        d.rounded_rectangle([x0 + 40, y0 + 400, x0 + 40 + int(bw * dist / 180), y0 + 436], radius=18, fill=AMBER)
        self._center(d, f"{dist:,.0f} m", y0 + 450, font("mono", 110), TEXT, cx)
        # spoken callout appears as the countdown closes
        if dist < 70:
            p = ease_out((70 - dist) / 25)
            pulse = 1 + 0.04 * math.sin(t * 12)
            w, h = int(560 * pulse), int(120 * pulse)
            bubble = Image.new("RGBA", (w + 40, h + 40), (0, 0, 0, 0))
            bd = ImageDraw.Draw(bubble)
            bd.rounded_rectangle([20, 20, 20 + w, 20 + h], radius=60, fill=RED + (int(235 * p),))
            label = "“BRAKE HARD”"
            fnt = font("black", int(62 * pulse))
            lw = bd.textlength(label, font=fnt)
            bd.text((20 + (w - lw) / 2, 20 + (h - 70 * pulse) / 2), label, font=fnt, fill=(255, 255, 255, int(255 * p)))
            f.alpha_composite(bubble, (int(cx - (w + 40) / 2), y0 + 575))
        self._tag(d, x0 + 40, y1 - 44)

    def _pit(self, f, st, t):
        """Between sessions: the Pit view's 'Where you are losing the most'."""
        paste_anim(f, st["head"], 80, 230, t)
        d = ImageDraw.Draw(f)
        x0, y0, x1, y1 = self._card(d)
        en = self.lang == "en"
        d.text((x0 + 40, y0 + 36), "Pit view" if en else "Vedere din boxă", font=font("black", 50), fill=TEXT)
        d.text((x0 + 40, y0 + 100), ("6 laps so far" if en else "6 tururi până acum"), font=font("label", 30), fill=MUTED)
        for i, chip in enumerate(["6 laps" if en else "6 tururi", "4 clean" if en else "4 curate"]):
            cxp = x1 - 330 + i * 160
            d.rounded_rectangle([cxp, y0 + 44, cxp + 145, y0 + 90], radius=23, outline=LINE, width=3)
            d.text((cxp + 18, y0 + 52), chip, font=font("bold", 26), fill=GREEN if i else MUTED)
        d.text((x0 + 40, y0 + 170), ("WHERE YOU ARE LOSING THE MOST" if en else "UNDE PIERZI CEL MAI MULT"),
               font=font("bold", 32), fill=AMBER)
        rows = [("T5", "+0.42 s"), ("T9", "+0.31 s"), ("T2", "+0.18 s")]
        for i, (corner, loss) in enumerate(rows):
            p = ease_out((t - 0.3 - i * 0.35) / 0.4)
            if p <= 0:
                continue
            ry = y0 + 225 + i * 140 + int((1 - p) * 40)
            layer = Image.new("RGBA", (x1 - x0 - 80, 130), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            ld.rounded_rectangle([0, 0, layer.width - 1, 129], radius=22, fill=PANEL2 + (int(255 * p),))
            ld.text((26, 26), corner, font=font("black", 64), fill=TEXT + (int(255 * p),))
            ld.text((layer.width - 250, 36), loss, font=font("mono", 54), fill=RED + (int(255 * p),))
            # brake points lap by lap: dots drifting = inconsistency
            for k, off in enumerate([0, 14, -9, 22, 5, -4]):
                bx = 190 + k * 58
                ld.ellipse([bx, 52 + off * 0.4, bx + 22, 74 + off * 0.4], fill=AMBER + (int(230 * p),))
            f.alpha_composite(layer, (x0 + 40, ry))
        d.text((x0 + 40, y1 - 100), ("Brake points, lap by lap" if en else "Punctele de frânare, tur cu tur"),
               font=font("label", 28), fill=MUTED)
        self._tag(d, x0 + 40, y1 - 44)

    def _report(self, f, st, t):
        """After the session: one corner of the corner-by-corner report."""
        paste_anim(f, st["head"], 80, 230, t)
        d = ImageDraw.Draw(f)
        x0, y0, x1, y1 = self._card(d)
        en = self.lang == "en"
        d.text((x0 + 40, y0 + 36), ("Corner 5" if en else "Virajul 5"), font=font("black", 64), fill=TEXT)
        d.text((x1 - 300, y0 + 58), "62 → 97 km/h", font=font("bold", 38), fill=AMBER)
        metrics = [("Brake point" if en else "Punct de frânare", "112 m"),
                   ("Lift point" if en else "Ridicare", "—"),
                   ("Min speed" if en else "Viteză minimă", "62 km/h"),
                   ("Exit speed" if en else "Viteză la ieșire", "97 km/h"),
                   ("Peak decel" if en else "Decelerare maximă", "0.9 g")]
        for i, (k, v) in enumerate(metrics):
            p = ease_out((t - 0.2 - i * 0.18) / 0.3)
            if p <= 0:
                continue
            ry = y0 + 140 + i * 70
            col = tuple(int(c * p) for c in TEXT)
            d.text((x0 + 40, ry), k, font=font("label", 36), fill=tuple(int(c * p) for c in MUTED))
            d.text((x1 - 40 - d.textlength(v, font=font("mono", 42)), ry - 4), v, font=font("mono", 42), fill=col)
            d.line([(x0 + 40, ry + 56), (x1 - 40, ry + 56)], fill=(30, 30, 36), width=2)
        # brake point per lap, best clean lap highlighted
        bars = [118, 109, 104, 121, 112, 106]
        base = y0 + 500
        d.text((x0 + 40, base), ("Brake point by lap" if en else "Frânare pe tururi"), font=font("label", 28), fill=MUTED)
        for i, b in enumerate(bars):
            p = ease_out((t - 1.0 - i * 0.1) / 0.3)
            h = int((b - 90) * 3.2 * p)
            bx = x0 + 40 + i * 120
            best = i == 2
            d.rectangle([bx, base + 160 - h, bx + 80, base + 160], fill=GREEN if best else PANEL2)
            d.text((bx + 22, base + 166), f"L{i + 1}", font=font("label", 24), fill=GREEN if best else MUTED)
        note = ("Your best clean lap: latest brake 104 m (lap 3)" if en
                else "Cel mai bun tur curat: frânare la 104 m (turul 3)")
        d.text((x0 + 40, base + 200), note, font=font("label", 28), fill=TEXT)
        self._tag(d, x0 + 40, y1 - 44)
