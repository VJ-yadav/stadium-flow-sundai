"""Turn raw OpenStreetMap exports into one small JSON the viewer loads.

Input:  data/raw/osm.json        roads, parking, rail, buildings, parks, water, the ballpark
                                 (written by scripts/fetch_osm.py, not committed)
        data/facilities.json     where Red Sox fans park: published space counts, type, levels
Output: public/data/fenway.json

Coordinates are local metres around Fenway Park: x east, z south (three.js: -z is north).

Fenway has no stadium lots. Fans park in small surface lots, multi-level garages and
underground garages spread over about a mile, and leave through a street grid, not one road.
So this script does three things the Gillette version did not need:

1. Parking: the Red Sox list of lots and garages is the base. Each one is matched to its mapped
   footprint when OpenStreetMap has one. Public garages and pay lots on the map that the list
   leaves out are added with an ESTIMATED share of their spaces (see osm_extras).
2. Exits: eleven gateways where traffic leaves the map (Storrow Drive, the Mass Pike ramp,
   Route 9, the bridges and so on), found on the real roads by name and direction of travel.
3. Routes: the quickest legal drive from every lot to every gateway over the mapped one-way
   streets. The streets those routes use become the links of the traffic model.
"""
import heapq
import json
import math
import os
import re
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAT0, LON0 = 42.3465, -71.0971  # Fenway Park, centre of the mapped ballpark
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110540
M2_PER_CAR_LOT = 30      # surface lot, aisles included (same figure as the Gillette model)
M2_PER_CAR_DECK = 32     # garage deck, ramps and columns included
WALK_DETOUR = 1.25       # walking distance over straight-line distance on a street grid
BOUNDS = (-2400, 2400, -1350, 2350)   # x min, x max, z min, z max of the model, metres
SHOW = (-2300, 2300, -1300, 2300)     # what the viewer draws

# Closed to cars on game days: Jersey Street beside the park becomes part of the ballpark.
CLOSED = [("Jersey Street", 260)]     # (street name, within this many metres of the park)

# Road class for the traffic model, and the speed used to pick routes (m/s).
SPEED = {"motorway": 22, "trunk": 16, "ramp": 9, "primary": 8, "secondary": 7, "tertiary": 6, "street": 3.5}
FREE_FLOWING = {"Storrow Drive", "Soldiers Field Road", "Charlesgate"}   # trunk roads with no signals
DEFAULT_LANES = {"motorway": 3, "trunk": 2, "ramp": 1, "primary": 2, "secondary": 1, "tertiary": 1, "street": 1}

# Where traffic leaves the map. name: regex on the road name or ref. heading: compass bearing of
# travel. The gateway is the matching point furthest along that heading inside 'box'.
# regions: which fans use it and how popular it is among them, before travel time (estimates:
# a fan going west would rather reach the Pike than crawl out Beacon Street).
GATEWAYS = [
    {"id": "storrow_e", "label": "Storrow Drive east · I-93, Route 1", "name": r"Storrow Drive", "heading": 70, "regions": {"north": 1.0, "south": 0.5}, "box": (-2300, 1900, -1300, 0)},
    {"id": "massave_n", "label": "Mass Ave bridge · Cambridge", "name": r"Massachusetts Avenue|Harvard Bridge", "heading": 335, "regions": {"north": 0.35}, "box": (0, 1200, -1150, -300)},
    {"id": "bu_bridge", "label": "BU Bridge · Cambridge", "name": r"Boston University Bridge", "heading": 340, "regions": {"north": 0.2}, "box": (-2000, -500, -1100, 0)},
    {"id": "pike_w", "label": "Mass Pike west · I-90", "name": r"Massachusetts Turnpike|I 90", "heading": 270, "regions": {"west": 1.0}, "box": (-2000, 1900, -1300, 800)},
    {"id": "storrow_w", "label": "Storrow Drive west · Soldiers Field Road", "name": r"Storrow Drive|Soldiers Field Road", "heading": 270, "regions": {"west": 0.7}, "box": (-2000, 1900, -1300, 0)},
    {"id": "comm_w", "label": "Commonwealth Ave west · Allston", "name": r"Commonwealth Avenue", "heading": 275, "regions": {"west": 0.25}, "box": (-1900, 0, -1000, 0)},
    {"id": "beacon_w", "label": "Beacon Street west · Brookline", "name": r"Beacon Street", "heading": 250, "regions": {"west": 0.3}, "box": (-1900, 0, -400, 800)},
    {"id": "rt9_w", "label": "Route 9 west · Brookline, Newton", "name": r"MA 9|Boylston Street", "heading": 260, "regions": {"west": 0.5, "south": 0.2}, "box": (-2100, -600, 1100, 2000)},
    {"id": "jamaicaway_s", "label": "Jamaicaway south · Jamaica Plain, Route 1", "name": r"Jamaicaway|Riverway", "heading": 180, "regions": {"south": 0.6}, "box": (-2000, -400, 800, 2300)},
    {"id": "massave_s", "label": "Mass Ave south · I-93 south", "name": r"Massachusetts Avenue", "heading": 140, "regions": {"south": 0.8}, "box": (600, 1900, 200, 1300)},
    {"id": "backbay_e", "label": "Boylston Street east · downtown", "name": r"Boylston Street", "heading": 75, "regions": {"south": 0.2, "north": 0.1}, "box": (800, 2000, -700, 200)},
]


def xz(lat, lon):
    return ((lon - LON0) * KX, -(lat - LAT0) * KZ)


def r1(p):
    return [round(p[0], 1), round(p[1], 1)]


def area(pts):
    s = 0
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        s += a[0] * b[1] - b[0] * a[1]
    return abs(s) / 2


def centroid(pts):
    n = len(pts) - 1 if len(pts) > 1 and pts[0] == pts[-1] else len(pts)
    return (sum(p[0] for p in pts[:n]) / n, sum(p[1] for p in pts[:n]) / n)


def inside(pts, x, z):
    c = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, zi = pts[i]
        xj, zj = pts[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            c = not c
        j = i
    return c


def in_box(p, box):
    return box[0] <= p[0] <= box[1] and box[2] <= p[1] <= box[3]


def simplify(pts, tol):
    """Douglas-Peucker. A closed ring is split at its far corner so it cannot collapse."""
    if len(pts) < 3:
        return pts
    if pts[0] == pts[-1]:
        k = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
        if 0 < k < len(pts) - 1:
            return simplify(pts[:k + 1], tol) + simplify(pts[k:], tol)[1:]
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, az = pts[a]
        bx, bz = pts[b]
        dx, dz = bx - ax, bz - az
        L = math.hypot(dx, dz) or 1e-9
        best, bi = 0, -1
        for i in range(a + 1, b):
            d = abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def rings(members):
    """Stitch the outer ways of a multipolygon into closed rings."""
    segs = [list(m) for m in members if len(m) > 1]
    out = []
    while segs:
        ring = segs.pop()
        grew = True
        while grew and ring[0] != ring[-1]:
            grew = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[-2::-1]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[:0:-1] + ring
                else:
                    continue
                segs.pop(i)
                grew = True
                break
        if len(ring) > 3 and ring[0] == ring[-1]:
            out.append(ring)
    return out


def clip(poly, box):
    """Sutherland-Hodgman clip of a ring to the box."""
    def cut(pts, keep, cross):
        res = []
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            ka, kb = keep(a), keep(b)
            if ka:
                res.append(a)
            if ka != kb:
                res.append(cross(a, b))
        return res
    x0, x1, z0, z1 = box
    def at_x(x):
        return lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))
    def at_z(z):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]), z)
    pts = poly[:-1] if poly[0] == poly[-1] else poly
    for keep, cross in ((lambda p: p[0] >= x0, at_x(x0)), (lambda p: p[0] <= x1, at_x(x1)), (lambda p: p[1] >= z0, at_z(z0)), (lambda p: p[1] <= z1, at_z(z1))):
        pts = cut(pts, keep, cross)
        if len(pts) < 3:
            return []
    return pts


def row_direction(ring):
    """Which way the parking rows run, in degrees (0 = east, 90 = south): the long side of the
    tightest rectangle around the footprint. Checked against overhead imagery for the Kenmore
    Lot (38 degrees) and the Van Ness / Jersey Street lot (160 degrees): rows follow the long
    edge and cars sit across them."""
    best = None
    for i in range(len(ring) - 1):
        ang = math.atan2(ring[i + 1][1] - ring[i][1], ring[i + 1][0] - ring[i][0])
        c, s = math.cos(ang), math.sin(ang)
        us = [p[0] * c + p[1] * s for p in ring]
        vs = [-p[0] * s + p[1] * c for p in ring]
        w, h = max(us) - min(us), max(vs) - min(vs)
        if best is None or w * h < best[0]:
            best = (w * h, ang if w >= h else ang + math.pi / 2)
    return round(math.degrees(best[1]) % 180, 1) if best else 0.0


def geom(e):
    return [xz(p["lat"], p["lon"]) for p in e["geometry"]]


def key(p):
    return (round(p["lat"] * 1e6), round(p["lon"] * 1e6))


def outer_rings(e):
    """Closed outline(s) of a way or a multipolygon relation, in local metres."""
    if e["type"] == "way":
        g = geom(e)
        return [g] if len(g) > 3 and e["geometry"][0] == e["geometry"][-1] else []
    mem = [[(round(p["lat"] * 1e6), round(p["lon"] * 1e6)) for p in m["geometry"]] for m in e.get("members", []) if m.get("role") != "inner"]
    return [[xz(a / 1e6, b / 1e6) for a, b in r] for r in rings(mem)]


def road_class(t):
    h = t.get("highway", "")
    if h.endswith("_link"):
        return "ramp"
    if h == "motorway":
        return "motorway"
    if h == "trunk":
        return "trunk" if t.get("name") in FREE_FLOWING else "primary"   # parkways with signals behave like arterials
    if h in ("primary", "secondary", "tertiary"):
        return h
    return "street"


def lanes_each_way(t, cls, oneway):
    def num(k):
        try:
            return int(float(str(t.get(k)).split(";")[0]))
        except (TypeError, ValueError):
            return None
    n = num("lanes")
    if oneway:
        return (max(1, min(4, n or DEFAULT_LANES[cls])),) * 2
    f, b = num("lanes:forward"), num("lanes:backward")
    if f is None and b is None:
        f = b = max(1, (n or 2 * DEFAULT_LANES[cls]) // 2)
    elif f is None:
        f = max(1, (n or b + 1) - b)
    elif b is None:
        b = max(1, (n or f + 1) - f)
    return (max(1, min(4, f)), max(1, min(4, b)))


def build_graph(els):
    """Directed graph of the streets a car may drive. Nodes are mapped points."""
    pos, adj, radj = {}, defaultdict(list), defaultdict(list)
    drivable = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
                "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
    for e in els:
        t = e["tags"]
        if e["type"] != "way" or t.get("highway") not in drivable:
            continue
        if t.get("access") in ("private", "no") or t.get("motor_vehicle") in ("private", "no"):
            continue
        cls = road_class(t)
        ow = t.get("oneway")
        oneway = ow in ("yes", "-1", "1", "true") or t.get("junction") == "roundabout" or (t.get("highway") in ("motorway", "motorway_link") and ow != "no")
        lf, lb = lanes_each_way(t, cls, oneway)
        name = t.get("name") or t.get("ref") or ""
        ref = t.get("ref") or ""
        g = e["geometry"]
        for i in range(len(g) - 1):
            a, b = key(g[i]), key(g[i + 1])
            pa, pb = xz(g[i]["lat"], g[i]["lon"]), xz(g[i + 1]["lat"], g[i + 1]["lon"])
            if a == b or not (in_box(pa, BOUNDS) and in_box(pb, BOUNDS)):
                continue
            if any(name == n and math.hypot(*pa) < d and math.hypot(*pb) < d for n, d in CLOSED):
                continue
            pos[a], pos[b] = pa, pb
            d = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
            fwd = {"len": d, "t": d / SPEED[cls], "cls": cls, "lanes": lf, "name": name, "ref": ref, "ow": oneway}
            if ow != "-1":
                adj[a].append((b, fwd)); radj[b].append((a, fwd))
            if not oneway or ow == "-1":
                back = dict(fwd, lanes=lb if not oneway else lf)
                adj[b].append((a, back)); radj[a].append((b, back))
    return pos, adj, radj


def dijkstra(adj, src, dst=None, pen=None):
    dist, prev = {src: 0.0}, {}
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18):
            continue
        if u == dst:
            break
        for v, e in adj.get(u, ()):
            nd = d + (e["t"] + 4) * (pen.get((u, v), 1) if pen else 1)   # 4 s for every block crossed
            if nd < dist.get(v, 1e18):
                dist[v], prev[v] = nd, u
                heapq.heappush(pq, (nd, v))
    return dist, prev


def routes(adj, edge, src, dst, k=3):
    """Up to k different drives from src to dst: the quickest, then the quickest that avoids
    most of the streets already used (drivers and police spread traffic over parallel streets)."""
    found, pen = [], {}
    for _ in range(k + 2):
        dist, prev = dijkstra(adj, src, dst, pen)
        if dst not in dist:
            break
        path, v = [dst], dst
        while v != src:
            v = prev[v]
            path.append(v)
        path.reverse()
        legs = list(zip(path, path[1:]))
        t = sum(edge[l]["t"] + 4 for l in legs)
        length = sum(edge[l]["len"] for l in legs) or 1
        shared = max((sum(edge[l]["len"] for l in legs if l in set(zip(q, q[1:]))) / length for _, q in found), default=0)
        if not found or (t <= 1.5 * found[0][0] and shared < 0.75):
            found.append((t, path))
            if len(found) == k:
                break
        for l in legs:
            pen[l] = pen.get(l, 1) * 2
    return found


def find_gateways(pos, adj):
    out = []
    for g in GATEWAYS:
        rx = re.compile(g["name"])
        hx, hz = math.sin(math.radians(g["heading"])), -math.cos(math.radians(g["heading"]))
        best, node = -1e18, None
        for u, edges in adj.items():
            for v, e in edges:
                if not (rx.search(e["name"]) or rx.search(e["ref"])):
                    continue
                a, b = pos[u], pos[v]
                if not in_box(b, g["box"]) or e["len"] < 1:
                    continue
                if ((b[0] - a[0]) * hx + (b[1] - a[1]) * hz) / e["len"] < 0.6:
                    continue
                s = b[0] * hx + b[1] * hz
                if s > best:
                    best, node = s, v
        if node is None:
            print(f"  ! gateway {g['id']} not found on the map")
            continue
        out.append(dict(g, node=node))
    return out


def load_parking(els):
    """Every mapped car park: outline, type, tags."""
    out = []
    for e in els:
        t = e["tags"]
        if t.get("amenity") != "parking":
            continue
        kind = {"surface": "surface", "multi-storey": "garage", "underground": "underground"}.get(t.get("parking", "surface"))
        if not kind:
            continue
        rs = outer_rings(e) if e["type"] != "node" else []
        if rs:
            p = max(rs, key=area)
            c, a = centroid(p), area(p)
        elif e["type"] == "node":
            p, c, a = None, xz(e["lat"], e["lon"]), 0
        else:
            continue
        out.append({"tags": t, "kind": kind, "p": p, "c": c, "area": a, "name": t.get("name")})
    return out


def tag_int(t, *keys):
    for k in keys:
        try:
            return int(float(t[k]))
        except (KeyError, ValueError):
            pass
    return None


def square(c, side):
    h = side / 2
    return [(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h), (c[0] - h, c[1] - h)]


def curated_lots(mapped, buildings):
    fac = json.load(open(os.path.join(ROOT, "data/facilities.json")))["facilities"]
    lots, used = [], set()
    for f in fac:
        c = xz(f["lat"], f["lon"])
        m = None
        if f.get("osm_name"):
            m = next((i for i, o in enumerate(mapped) if o["name"] == f["osm_name"] and o["p"]), None)
        if m is None:   # a mapped car park of the same type right there
            near = [(math.hypot(o["c"][0] - c[0], o["c"][1] - c[1]), i) for i, o in enumerate(mapped)
                    if o["p"] and i not in used and o["kind"] == f["kind"] and (inside(o["p"], *c) or math.hypot(o["c"][0] - c[0], o["c"][1] - c[1]) < 70)]
            m = min(near)[1] if near else None
        shape = "mapped"
        if m is not None:
            used.add(m)
            p = mapped[m]["p"]
        else:
            # garages sit in or under a building: use its outline. Otherwise draw a square of the right size.
            b = next((b for b in buildings if inside(b, *c)), None) if f["kind"] != "surface" else None
            need = f.get("total", f["fans"]) * (M2_PER_CAR_LOT if f["kind"] == "surface" else M2_PER_CAR_DECK) / f["levels"]
            if b and area(b) > 0.4 * need:
                p, shape = b, "building outline"
            else:
                p, shape = square(c, math.sqrt(need)), "square of the right area"
        doors = [xz(*d) for d in f.get("doors", [])] or None
        lots.append({
            "name": f["name"], "kind": f["kind"], "levels": f["levels"], "exits": f["exits"], "fans": f["fans"],
            "listed": f.get("listed"), "total": f.get("total"), "room": f.get("room"), "official": bool(f.get("official")), "rows_deg": f.get("rows_deg"),
            "p": p, "c": centroid(p), "doors": doors, "shape": shape, "src": "Red Sox parking list" if "redsox" in f["src"] else "local parking guide",
            "assumed": sorted(k[:-4] for k, v in f.items() if k.endswith("_src") and str(v).startswith("assumed")),
        })
    # every mapped car park that touches a listed one is the same place, not an extra
    for i, o in enumerate(mapped):
        if any(math.hypot(o["c"][0] - l["c"][0], o["c"][1] - l["c"][1]) < 70 or (o["p"] is None and inside(l["p"], *o["c"])) for l in lots):
            used.add(i)
    return lots, used


def osm_extras(mapped, used):
    """Public garages and pay lots on the map that the Red Sox list leaves out.

    ESTIMATE: spaces come from the capacity tag, or from area times levels. Fans take a share
    of them that falls with the walk to the park: 90% within 300 m, 60% within 500 m, 35% within
    800 m, 15% within 1,050 m, none beyond.
    """
    out = []
    for i, o in enumerate(mapped):
        if i in used or o["p"] is None:
            continue
        t = o["tags"]
        if t.get("access") not in ("yes", "customers", "permissive", None) or t.get("fee") == "no":
            continue
        if t.get("access") is None and t.get("fee") != "yes":
            continue   # untagged lots are mostly private yards
        d = math.hypot(*o["c"])
        share = 0.9 if d < 300 else 0.6 if d < 500 else 0.35 if d < 800 else 0.15 if d < 1050 else 0
        if not share:
            continue
        levels = 1 if o["kind"] == "surface" else (tag_int(t, "building:levels", "levels", "parking:levels") or (4 if o["kind"] == "garage" else 2))
        spaces = tag_int(t, "capacity") or round(o["area"] * levels / (M2_PER_CAR_LOT if o["kind"] == "surface" else M2_PER_CAR_DECK))
        fans = round(spaces * share)
        if fans < 25:
            continue
        out.append({
            "name": o["name"], "kind": o["kind"], "levels": levels, "exits": max(1, min(3, round(spaces / (250 if o["kind"] == "surface" else 400)))),
            "fans": fans, "listed": None, "total": spaces, "room": None, "official": False, "p": o["p"], "c": o["c"], "doors": None,
            "shape": "mapped", "src": "OpenStreetMap, spaces and fan share estimated", "assumed": ["fans", "spaces"] if not tag_int(t, "capacity") else ["fans"],
        })
    return out


def main():
    els = json.load(open(os.path.join(ROOT, "data/raw/osm.json")))["elements"]
    pos, adj, radj = build_graph(els)
    print(f"street graph: {len(pos)} points, {sum(len(v) for v in adj.values())} one-way segments")

    # ---- buildings, ballpark, water, parks, rail (for the picture) ----
    stadium = None
    for e in els:
        if e["tags"].get("leisure") == "stadium" and e["tags"].get("name") == "Fenway Park":
            rs = outer_rings(e)
            stadium = max(rs, key=area) if rs else None
    buildings, bshapes = [], []
    for e in els:
        t = e["tags"]
        if t.get("building") and t.get("building") != "construction":
            for ring in outer_rings(e):
                c = centroid(ring)
                if math.hypot(*c) > 1150 or area(ring) < 40:
                    continue
                if stadium and inside(stadium, *c):
                    continue   # the grandstands are drawn as the ballpark itself
                try:
                    h = float(str(t.get("height", "")).split()[0])
                except (ValueError, IndexError):
                    lv = tag_int(t, "building:levels")
                    h = lv * 3.5 if lv else 12
                bshapes.append(ring)
                buildings.append({"p": [r1(p) for p in simplify(ring, 1.2)], "h": round(min(h, 240), 1)})
    water, parks = [], []
    for e in els:
        t = e["tags"]
        dst = water if t.get("natural") == "water" else parks if t.get("leisure") == "park" else None
        if dst is None:
            continue
        for ring in outer_rings(e):
            c = clip(ring, SHOW)
            if len(c) > 2 and area(c) > 400:
                dst.append([r1(p) for p in simplify(c + [c[0]], 2.0)])
    rail, stations, seen = [], [], set()
    for e in els:
        t = e["tags"]
        if e["type"] == "way" and t.get("railway") in ("rail", "light_rail", "subway") and not t.get("service"):
            pts = [p for p in geom(e) if in_box(p, SHOW)]
            if len(pts) > 1:
                rail.append({"k": t["railway"], "u": 1 if t.get("tunnel") in ("yes", "building_passage") else 0, "n": t.get("name"), "p": [r1(p) for p in simplify(pts, 1.0)]})
        elif e["type"] == "node" and t.get("railway") in ("station", "stop", "tram_stop") and t.get("name") in ("Kenmore", "Lansdowne", "Fenway", "Hynes Convention Center", "Prudential", "Copley", "Back Bay") and t["name"] not in seen:
            seen.add(t["name"])
            stations.append({"n": t["name"], "c": r1(xz(e["lat"], e["lon"]))})

    # ---- roads for the picture ----
    roads = []
    for e in els:
        t = e["tags"]
        h = t.get("highway")
        if e["type"] != "way" or not h:
            continue
        g = geom(e)
        if h == "service":
            if t.get("service") == "parking_aisle" or min(math.hypot(*p) for p in g) > 700:
                continue
        run = []
        for p in g + [None]:
            if p is not None and in_box(p, SHOW):
                run.append(p)
            else:
                if len(run) > 1:
                    roads.append({"c": h, "n": t.get("name"), "u": 1 if t.get("tunnel") == "yes" else 0, "p": [r1(q) for q in simplify(run, 0.8)]})
                run = []

    # ---- parking ----
    mapped = load_parking(els)
    lots, used = curated_lots(mapped, bshapes)
    lots += osm_extras(mapped, used)

    # ---- gateways and routes ----
    gateways = find_gateways(pos, adj)
    local = {u for u, edges in adj.items() if any(e["cls"] in ("primary", "secondary", "tertiary", "street") for _, e in edges)}
    def street_name(u):
        names = Counter(e["name"] for _, e in adj[u] if e["name"])
        return names.most_common(1)[0][0] if names else None
    edge = {(u, v): e for u, edges in adj.items() for v, e in edges}
    paths_nodes = {}   # (lot index, gateway id) -> [(seconds, [graph nodes]), ...] best first
    for li, lot in enumerate(lots):
        doors = lot["doors"] or [lot["c"]]
        ring = lot["p"]
        best, access = {}, []
        for d in doors:
            # the nearest few street points to this door (or, with no door known, to the outline)
            ref = [d] if lot["doors"] else ring
            near = sorted(local, key=lambda u: min((pos[u][0] - q[0]) ** 2 + (pos[u][1] - q[1]) ** 2 for q in ref))[:4]
            for u in near:
                dist, _ = dijkstra(adj, u)
                reach = [g for g in gateways if g["node"] in dist]
                if len(reach) >= len(gateways) - 2:   # skip dead ends and one-way traps
                    access.append(u)
                    for g in reach:
                        if g["id"] not in best or dist[g["node"]] < best[g["id"]][0]:
                            best[g["id"]] = (dist[g["node"]], u)
                    break
        if not best:
            print(f"  ! no way out found for {lot['name']}")
        for g in gateways:
            if g["id"] in best:
                paths_nodes[(li, g["id"])] = routes(adj, edge, best[g["id"]][1], g["node"])
        lot["access"] = access
        lot["street"] = street_name(access[0]) if access else None

    # ---- links: runs of street between junctions of the route network ----
    used_out, used_in = defaultdict(set), defaultdict(set)
    for alts in paths_nodes.values():
        for _, path in alts:
            for a, b in zip(path, path[1:]):
                used_out[a].add(b); used_in[b].add(a)
    breaks = {l_access for l in lots for l_access in l["access"]} | {g["node"] for g in gateways}
    for u in set(used_out) | set(used_in):
        if len(used_out[u]) != 1 or len(used_in[u]) != 1:
            breaks.add(u)
    links, link_id = [], {}
    def link_for(run):
        k = (run[0], run[1])
        if k not in link_id:
            es = [edge[(a, b)] for a, b in zip(run, run[1:])]
            by_cls, by_name = Counter(), Counter()
            for e in es:
                by_cls[e["cls"]] += e["len"]; by_name[e["name"]] += e["len"]
            link_id[k] = len(links)
            links.append({"p": [r1(pos[u]) for u in run], "lanes": min(e["lanes"] for e in es), "ff": round(sum(e["t"] for e in es), 1), "cls": by_cls.most_common(1)[0][0],
                          "ow": 1 if sum(e["len"] for e in es if e["ow"]) * 2 >= sum(e["len"] for e in es) else 0,
                          "n": by_name.most_common(1)[0][0] or None, "len": round(sum(e["len"] for e in es))})
        return link_id[k]
    lot_paths = defaultdict(dict)
    for (li, gid), alts in paths_nodes.items():
        for t, path in alts:
            ids, run = [], [path[0]]
            for u in path[1:]:
                run.append(u)
                if u in breaks:
                    ids.append(link_for(run)); run = [u]
            if len(run) > 1:
                ids.append(link_for(run))
            lot_paths[li].setdefault(gid, []).append({"l": ids, "t": round(t)})

    out_lots = []
    for li, lot in enumerate(json_lots := lots):
        if not lot_paths.get(li):
            continue
        walk = round(math.hypot(*lot["c"]) * WALK_DETOUR)
        name = lot["name"] or (("Garage" if lot["kind"] != "surface" else "Lot") + (" on " + lot["street"] if lot["street"] else ""))
        ring = simplify(lot["p"], 0.5)
        out_lots.append({
            "name": name, "kind": lot["kind"], "levels": lot["levels"], "exits": lot["exits"], "fans": lot["fans"],
            "listed": lot["listed"], "total": lot["total"], "room": lot["room"], "official": lot["official"], "walk": walk,
            "street": lot["street"], "p": [r1(p) for p in ring], "c": r1(lot["c"]), "area": round(area(ring)), "shape": lot["shape"],
            "rot": lot.get("rows_deg") if lot.get("rows_deg") is not None else row_direction(ring),
            "src": lot["src"], "assumed": lot["assumed"], "paths": lot_paths[li],
        })
    out_lots.sort(key=lambda l: -l["fans"])

    out = {
        "origin": {"lat": LAT0, "lon": LON0},
        "note": "OpenStreetMap data (c) OpenStreetMap contributors, ODbL. Parking counts: Red Sox parking list where given, otherwise estimates. See README.",
        "bounds": SHOW,
        "stadium": [r1(p) for p in stadium] if stadium else None,
        "roads": roads, "rail": rail, "stations": stations, "buildings": buildings, "water": water, "parks": parks,
        "lots": out_lots,
        "gateways": [{"id": g["id"], "label": g["label"], "regions": g["regions"], "c": r1(pos[g["node"]])} for g in gateways],
        "links": links,
    }
    os.makedirs(os.path.join(ROOT, "public/data"), exist_ok=True)
    dst = os.path.join(ROOT, "public/data/fenway.json")
    json.dump(out, open(dst, "w"), separators=(",", ":"))

    kinds = Counter()
    for l in out_lots:
        kinds[l["kind"]] += l["fans"]
    print(f"roads {len(roads)}, rail {len(rail)}, buildings {len(buildings)}, water {len(water)}, parks {len(parks)}, ballpark {'yes' if stadium else 'no'}")
    print(f"gateways {len(gateways)}, links {len(links)} ({sum(l['len'] for l in links) / 1000:.1f} km of route network)")
    print(f"parking: {len(out_lots)} places, about {sum(kinds.values())} fan cars: " + ", ".join(f"{k} {v}" for k, v in kinds.most_common()))
    print(f"wrote {dst} {os.path.getsize(dst) // 1024} KB")
    for l in out_lots:
        print(f"  {l['name'][:40]:40} {l['kind']:11} L{l['levels']} {l['fans']:5} cars, {l['walk']:5} m walk, out via {l['street']}, {sum(len(v) for v in l['paths'].values())} routes [{l['shape']}]")


if __name__ == "__main__":
    main()
