#!/usr/bin/env python3
"""
Small deterministic grid router for the TRACE GNSS Pod (pcbnew + numpy only).

No Freerouting or Java is installed on this machine, so the GNSS pod uses this
~500-line A* maze router instead of hand-typed waypoints (the dongle's
approach does not scale to ~150 connections). It knows the spec's layer
rules directly. The spec reference is hardware/gnss-pod/DESIGN-REV-A.md sec 8.

Model
  * 0.1 mm grid, 2 layers (0 = F.Cu, 1 = B.Cu), 8-neighbour moves plus vias.
  * Two clearance classes: k=0 for 0.2 mm signal tracks, k=1 for 0.5 mm
    power tracks and 0.5 mm vias. For each class and layer, a label map holds
    -1 (free), a net id (only that net may use the cell) or -2 (blocked).
    Every copper object is inflated by clearance + half-width + margin.
  * Static region masks carry the spec rules (antenna keep-out, bottom only
    in Z2, no traces under U2, GNSS via limit, ...). The caller supplies them
    per net through `region_fn(net) -> (top_ok, bot_ok, via_ok)`.
  * Power nets use the k=1 map. Near fine-pitch pads of their own net ("neck"
    zones) they fall back to the k=0 map and are emitted 0.2 mm wide there.
  * Multi-pin nets grow a tree (Prim order, nearest pad first). Each branch is
    a multi-source A* from all cells of the current tree.
  * Paths are simplified by line-of-sight checks against the same maps, so
    segments can be any angle.
Deterministic: no randomness, and ties break by insertion counter.
"""
import heapq
import math

import numpy as np

CLR = 0.2          # copper-copper clearance (mm)
MARGIN = 0.035     # grid discretisation safety margin (mm)
HW = [0.1, 0.25]   # half-width per class: 0.2 mm signal track / 0.5 mm power track + 0.5 mm via
VIA_D, VIA_DRILL = 0.5, 0.3


class Router:
    def __init__(self, w, h, res=0.1, edge_clr=0.3):
        self.res = res
        self.nx = int(round(w / res)) + 1
        self.ny = int(round(h / res)) + 1
        self.w, self.h = w, h
        self.lab = [[np.full((self.ny, self.nx), -1, np.int32) for _ in range(2)] for _ in range(2)]
        self.via_forbid = np.zeros((self.ny, self.nx), bool)   # no router vias here (pads, holes)
        self.vias = []          # (x, y, net)
        self.tracks = []        # (x0, y0, x1, y1, width, layer, net)
        xs = np.arange(self.nx) * res
        ys = np.arange(self.ny) * res
        self.X, self.Y = np.meshgrid(xs, ys)
        # board edge keep-in (per class)
        for k in range(2):
            m = edge_clr + HW[k] + MARGIN
            bad = (self.X < m) | (self.X > w - m) | (self.Y < m) | (self.Y > h - m)
            for l in range(2):
                self.lab[k][l][bad] = -2

    # -- geometry -------------------------------------------------------------
    def _win(self, x0, y0, x1, y1, pad):
        i0 = max(int(math.floor((x0 - pad) / self.res)), 0)
        i1 = min(int(math.ceil((x1 + pad) / self.res)) + 1, self.nx)
        j0 = max(int(math.floor((y0 - pad) / self.res)), 0)
        j1 = min(int(math.ceil((y1 + pad) / self.res)) + 1, self.ny)
        return slice(j0, j1), slice(i0, i1)

    def _dist(self, shape, sl):
        X, Y = self.X[sl], self.Y[sl]
        kind = shape[0]
        if kind == "rect":            # ("rect", cx, cy, hw, hh)
            _, cx, cy, hw, hh = shape
            dx = np.maximum(np.abs(X - cx) - hw, 0)
            dy = np.maximum(np.abs(Y - cy) - hh, 0)
            return np.hypot(dx, dy)
        if kind == "seg":             # ("seg", x0, y0, x1, y1, r)
            _, ax, ay, bx, by, r = shape
            vx, vy = bx - ax, by - ay
            L2 = vx * vx + vy * vy
            if L2 < 1e-12:
                t = 0.0
            else:
                t = np.clip(((X - ax) * vx + (Y - ay) * vy) / L2, 0, 1)
            return np.maximum(np.hypot(X - (ax + t * vx), Y - (ay + t * vy)) - r, 0)
        raise ValueError(kind)

    @staticmethod
    def _bbox(shape):
        if shape[0] == "rect":
            _, cx, cy, hw, hh = shape
            return cx - hw, cy - hh, cx + hw, cy + hh
        _, ax, ay, bx, by, r = shape
        return min(ax, bx) - r, min(ay, by) - r, max(ax, bx) + r, max(ay, by) + r

    def add_obstacle(self, shape, layers, net, clr=CLR):
        """net = int id, or -2 for 'blocks every net' (holes, keep-outs)."""
        x0, y0, x1, y1 = self._bbox(shape)
        for k in range(2):
            infl = clr + HW[k] + MARGIN
            sl = self._win(x0, y0, x1, y1, infl)
            d = self._dist(shape, sl)
            m = d < infl
            for l in layers:
                sub = self.lab[k][l][sl]
                if net == -2:
                    sub[m] = -2
                else:
                    free = m & (sub == -1)
                    other = m & (sub != -1) & (sub != net)
                    sub[free] = net
                    sub[other] = -2

    def forbid_vias(self, shape, extra=0.0):
        x0, y0, x1, y1 = self._bbox(shape)
        infl = VIA_D / 2 + extra + MARGIN
        sl = self._win(x0, y0, x1, y1, infl)
        self.via_forbid[sl] |= self._dist(shape, sl) < infl

    def cells_in(self, shape, shrink=0.0):
        x0, y0, x1, y1 = self._bbox(shape)
        sl = self._win(x0, y0, x1, y1, 0)
        d = self._dist(shape, sl)
        if shape[0] == "rect":
            _, cx, cy, hw, hh = shape
            inside = (np.abs(self.X[sl] - cx) <= hw - shrink) & (np.abs(self.Y[sl] - cy) <= hh - shrink)
        else:
            _, ax, ay, bx, by, r = shape
            inside = d <= 0
            if shrink:
                inside &= self._dist(("seg", ax, ay, bx, by, max(r - shrink, 0.001)), sl) <= 0
        jj, ii = np.nonzero(inside)
        return [(int(i + sl[1].start), int(j + sl[0].start)) for j, i in zip(jj, ii)]

    # -- commit routed copper -----------------------------------------------------
    def commit_track(self, x0, y0, x1, y1, width, layer, net):
        self.tracks.append((x0, y0, x1, y1, width, layer, net))
        self.add_obstacle(("seg", x0, y0, x1, y1, width / 2), [layer], net)

    def commit_via(self, x, y, net):
        self.vias.append((x, y, net))
        self.add_obstacle(("seg", x, y, x, y, VIA_D / 2), [0, 1], net)
        # hole-to-hole spacing for later vias of any net
        self.forbid_vias(("seg", x, y, x, y, VIA_DRILL / 2), extra=0.3)

    # -- search -------------------------------------------------------------------
    def free_masks(self, net, k, neck=None):
        """Per-layer boolean 'cell usable by net' for class k (neck cells use k=0)."""
        out = []
        for l in range(2):
            lab = self.lab[k][l]
            ok = (lab == -1) | (lab == net)
            if neck is not None and k == 1:
                lab0 = self.lab[0][l]
                ok0 = (lab0 == -1) | (lab0 == net)
                ok = np.where(neck, ok0, ok)
            out.append(ok)
        return out

    def astar(self, net, k, sources, targets, region, neck=None, bot_cost=4.0,
              via_cost=12.0, window=None, max_exp=2_500_000, penalty=None, via_pen=None):
        """sources/targets: iterables of (i, j, l). region = (top_ok, bot_ok, via_ok).
        Returns list of (i, j, l) from a source to a target, or None."""
        nx, ny = self.nx, self.ny
        free = self.free_masks(net, k, neck)
        top_ok, bot_ok, via_ok = region
        okl = [free[0] & top_ok, free[1] & bot_ok]
        # a via needs the k=1 (via-size) map free on both layers
        vf = self.free_masks(net, 1)
        vok = vf[0] & vf[1] & via_ok & ~self.via_forbid & top_ok & bot_ok
        if window is not None:
            wmask = np.zeros((ny, nx), bool)
            i0, j0, i1, j1 = window
            wmask[max(j0, 0):min(j1, ny), max(i0, 0):min(i1, nx)] = True
            okl = [okl[0] & wmask, okl[1] & wmask]
            vok = vok & wmask
        ok = [okl[0].ravel().tolist(), okl[1].ravel().tolist()]
        if penalty is None:
            pen = [[0.0] * (nx * ny)] * 2
        else:
            pen = [penalty[0].ravel().tolist(), penalty[1].ravel().tolist()]
        vokl = vok.ravel().tolist()
        vpl = via_pen.ravel().tolist() if via_pen is not None else None
        tset = set()
        for i, j, l in targets:
            tset.add((l, j * nx + i))
        if not tset:
            return None
        tx = [t[1] % nx for t in tset]
        ty = [t[1] // nx for t in tset]
        tx0, tx1, ty0, ty1 = min(tx), max(tx), min(ty), max(ty)
        S2 = math.sqrt(2)

        def hfun(i, j):
            dx = max(tx0 - i, 0, i - tx1)
            dy = max(ty0 - j, 0, j - ty1)
            return (max(dx, dy) + (S2 - 1) * min(dx, dy)) * 1.05

        g = {}
        parent = {}
        heap = []
        cnt = 0
        for i, j, l in sources:
            idx = j * nx + i
            if not (0 <= i < nx and 0 <= j < ny):
                continue
            key = (l, idx)
            if key in g:
                continue
            g[key] = 0.0
            parent[key] = None
            heapq.heappush(heap, (hfun(i, j), cnt, key))
            cnt += 1
        moves = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
                 (1, 1, S2), (1, -1, S2), (-1, 1, S2), (-1, -1, S2)]
        lcost = [1.0, bot_cost]
        closed = set()
        exp = 0
        while heap:
            f, _, key = heapq.heappop(heap)
            if key in closed:
                continue
            closed.add(key)
            if key in tset:
                path = []
                while key is not None:
                    l, idx = key
                    path.append((idx % nx, idx // nx, l))
                    key = parent[key]
                return path[::-1]
            exp += 1
            if exp > max_exp:
                return None
            l, idx = key
            i, j = idx % nx, idx // nx
            gc = g[key]
            okL = ok[l]
            penL = pen[l]
            for di, dj, c in moves:
                ii, jj = i + di, j + dj
                if ii < 0 or jj < 0 or ii >= nx or jj >= ny:
                    continue
                nidx = jj * nx + ii
                if not okL[nidx]:
                    continue
                if di and dj:   # no corner cutting
                    if not okL[j * nx + ii] or not okL[jj * nx + i]:
                        continue
                nk = (l, nidx)
                ng = gc + c * (lcost[l] + penL[nidx])
                if ng < g.get(nk, 1e18):
                    g[nk] = ng
                    parent[nk] = key
                    heapq.heappush(heap, (ng + hfun(ii, jj), cnt, nk))
                    cnt += 1
            if vokl[idx]:
                nl = 1 - l
                nk = (nl, idx)
                if ok[nl][idx]:
                    ng = gc + via_cost + (vpl[idx] if vpl is not None else 0.0)
                    if ng < g.get(nk, 1e18):
                        g[nk] = ng
                        parent[nk] = key
                        heapq.heappush(heap, (ng + hfun(i, j), cnt, nk))
                        cnt += 1
        return None

    # -- path post-processing -------------------------------------------------------
    def los_ok(self, a, b, l, free_l):
        """Straight segment a->b (cell coords) stays inside free cells (4-corner test)."""
        (ax, ay), (bx, by) = a, b
        n = int(max(abs(bx - ax), abs(by - ay)) * 2) + 1
        for s in range(n + 1):
            t = s / n
            x = ax + (bx - ax) * t
            y = ay + (by - ay) * t
            for xi in {math.floor(x), math.ceil(x)}:
                for yi in {math.floor(y), math.ceil(y)}:
                    if not free_l[yi, xi]:
                        return False
        return True

    def simplify(self, pts, l, free_l):
        """Greedy line-of-sight simplification of a same-layer cell run."""
        if len(pts) <= 2:
            return pts
        out = [pts[0]]
        i = 0
        while i < len(pts) - 1:
            j = len(pts) - 1
            while j > i + 1 and not self.los_ok(pts[i], pts[j], l, free_l):
                j -= 1
            out.append(pts[j])
            i = j
        return out


def astar2(nx, ny, ok, cost, vok, vcost, sources, targets, bot_cost=3.0, via_cost=10.0,
           max_exp=3_000_000, hweight=1.05):
    """Generic A* on precomputed flat lists (negotiated-congestion router).
    ok[l]: list of bool per cell, cost[l]: list of extra per-step cost (or None),
    vok: list of bool (via allowed), vcost: list of extra via cost (or None)."""
    tset = set()
    for i, j, l in targets:
        tset.add((l, j * nx + i))
    if not tset:
        return None
    tx = [t[1] % nx for t in tset]
    ty = [t[1] // nx for t in tset]
    tx0, tx1, ty0, ty1 = min(tx), max(tx), min(ty), max(ty)
    S2 = math.sqrt(2)

    def hfun(i, j):
        dx = max(tx0 - i, 0, i - tx1)
        dy = max(ty0 - j, 0, j - ty1)
        return (max(dx, dy) + (S2 - 1) * min(dx, dy)) * hweight

    g = {}
    parent = {}
    heap = []
    cnt = 0
    for i, j, l in sources:
        if not (0 <= i < nx and 0 <= j < ny):
            continue
        key = (l, j * nx + i)
        if key in g or not ok[l][key[1]]:
            continue
        g[key] = 0.0
        parent[key] = None
        heapq.heappush(heap, (hfun(i, j), cnt, key))
        cnt += 1
    moves = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
             (1, 1, S2), (1, -1, S2), (-1, 1, S2), (-1, -1, S2)]
    lcost = [1.0, bot_cost]
    closed = set()
    exp = 0
    while heap:
        f, _, key = heapq.heappop(heap)
        if key in closed:
            continue
        closed.add(key)
        if key in tset:
            path = []
            while key is not None:
                l, idx = key
                path.append((idx % nx, idx // nx, l))
                key = parent[key]
            return path[::-1]
        exp += 1
        if exp > max_exp:
            return None
        l, idx = key
        i, j = idx % nx, idx // nx
        gc = g[key]
        okL = ok[l]
        cL = cost[l]
        for di, dj, c in moves:
            ii, jj = i + di, j + dj
            if ii < 0 or jj < 0 or ii >= nx or jj >= ny:
                continue
            nidx = jj * nx + ii
            if not okL[nidx]:
                continue
            if di and dj:
                if not okL[j * nx + ii] or not okL[jj * nx + i]:
                    continue
            nk = (l, nidx)
            ng = gc + c * (lcost[l] + (cL[nidx] if cL is not None else 0.0))
            if ng < g.get(nk, 1e18):
                g[nk] = ng
                parent[nk] = key
                heapq.heappush(heap, (ng + hfun(ii, jj), cnt, nk))
                cnt += 1
        if vok[idx]:
            nl = 1 - l
            nk = (nl, idx)
            if ok[nl][idx]:
                ng = gc + via_cost + (vcost[idx] if vcost is not None else 0.0)
                if ng < g.get(nk, 1e18):
                    g[nk] = ng
                    parent[nk] = key
                    heapq.heappush(heap, (ng + hfun(i, j), cnt, nk))
                    cnt += 1
    return None
