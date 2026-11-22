"""Turn raw OpenStreetMap exports into one small JSON the viewer loads.

Input:  data/raw/foxborough.json (roads, lots, rail), data/raw/buildings.json (optional)
Output: public/data/foxborough.json

Coordinates are local metres around the stadium: x east, z south (three.js: -z is north).
Lot capacities are ESTIMATES from area (30 m2 a car incl. aisles), not stadium figures.
"""
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAT0, LON0 = 42.0909, -71.2643  # Gillette Stadium, approximate centre
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110540
M2_PER_CAR = 30


def xz(p):
    return [round((p["lon"] - LON0) * KX, 1), round(-(p["lat"] - LAT0) * KZ, 1)]


def area(pts):
    s = 0
    for i in range(len(pts) - 1):
        s += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
    return abs(s) / 2


def centroid(pts):
    n = len(pts) - 1 if pts[0] == pts[-1] else len(pts)
    return [round(sum(p[0] for p in pts[:n]) / n, 1), round(sum(p[1] for p in pts[:n]) / n, 1)]


def route1_centerline(ways):
    """Both carriageways of US 1 averaged into one ordered centreline, 25 m apart."""
    pts = [xz(p) for w in ways for p in w["geometry"]]
    mx = sum(p[0] for p in pts) / len(pts)
    mz = sum(p[1] for p in pts) / len(pts)
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    szz = sum((p[1] - mz) ** 2 for p in pts)
    sxz = sum((p[0] - mx) * (p[1] - mz) for p in pts)
    ang = 0.5 * math.atan2(2 * sxz, sxx - szz)
    ux, uz = math.cos(ang), math.sin(ang)
    if uz > 0:  # point the axis north (-z)
        ux, uz = -ux, -uz
    bins = {}
    for p in pts:
        t = (p[0] - mx) * ux + (p[1] - mz) * uz
        bins.setdefault(int(t // 25), []).append(p)
    line = []
    for k in sorted(bins):
        b = bins[k]
        line.append([round(sum(p[0] for p in b) / len(b), 1), round(sum(p[1] for p in b) / len(b), 1)])
    # light smoothing
    sm = [line[0]]
    for i in range(1, len(line) - 1):
        sm.append([round((line[i - 1][j] + 2 * line[i][j] + line[i + 1][j]) / 4, 1) for j in (0, 1)])
    sm.append(line[-1])
    return sm  # ordered south to north


def nearest(line, p):
    best, bi = 1e18, 0
    for i, q in enumerate(line):
        d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
        if d < best:
            best, bi = d, i
    return bi, math.sqrt(best)


def main():
    raw = json.load(open(os.path.join(ROOT, "data/raw/foxborough.json")))["elements"]
    roads, lots, rail, us1 = [], [], [], []
    keep = {"primary", "primary_link", "secondary", "tertiary", "tertiary_link", "unclassified", "residential", "service"}
    for e in raw:
        t = e.get("tags", {})
        g = e.get("geometry")
        if not g:
            continue
        pts = [xz(p) for p in g]
        if t.get("highway") in keep:
            if t.get("highway") == "service" and t.get("service") not in (None, "parking_aisle", "driveway"):
                continue
            roads.append({"c": t["highway"], "n": t.get("name"), "l": t.get("lanes"), "p": pts})
            if t.get("highway") == "primary" and "US 1" in (t.get("ref") or ""):
                us1.append(e)
        elif t.get("amenity") == "parking" and len(pts) > 3:
            a = area(pts)
            if a < 2000:
                continue
            lots.append({"name": t.get("name") or t.get("ref"), "p": pts, "area": round(a), "capEst": round(a / M2_PER_CAR), "c": centroid(pts)})
        elif t.get("railway") == "rail":
            rail.append({"n": t.get("name"), "p": pts})

    line = route1_centerline(us1)
    # Only lots that plausibly empty onto Route 1 near the stadium (within 900 m of it).
    for lot in lots:
        i, d = nearest(line, lot["c"])
        a, b = line[max(0, i - 1)], line[min(len(line) - 1, i + 1)]
        cross = (b[0] - a[0]) * (lot["c"][1] - a[1]) - (b[1] - a[1]) * (lot["c"][0] - a[0])
        lot["join"] = i
        lot["dist"] = round(d)
        lot["side"] = "east" if cross < 0 else "west"
    lots = [l for l in lots if l["dist"] < 900]
    lots.sort(key=lambda l: -l["area"])

    buildings = []
    bpath = os.path.join(ROOT, "data/raw/buildings.json")
    stadium = None
    if os.path.exists(bpath):
        try:
            braw = json.load(open(bpath))["elements"]
        except ValueError:
            braw = []
        for e in braw:
            t = e.get("tags", {})
            g = e.get("geometry")
            if t.get("leisure") == "stadium" and e["type"] == "relation":
                outer = [m for m in e.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
                if outer:
                    stadium = [xz(p) for p in max(outer, key=lambda m: len(m["geometry"]))["geometry"]]
            elif t.get("leisure") == "stadium" and g:
                stadium = [xz(p) for p in g]
            elif t.get("building") and g:
                h = t.get("height")
                lv = t.get("building:levels")
                try:
                    hh = float(h) if h else (float(lv) * 3.5 if lv else 8)
                except ValueError:
                    hh = 8
                buildings.append({"p": [xz(p) for p in g], "h": round(hh, 1), "n": t.get("name")})

    out = {
        "origin": {"lat": LAT0, "lon": LON0},
        "note": "OpenStreetMap data (c) OpenStreetMap contributors, ODbL. Lot capacities are estimates from area.",
        "route1": line,
        "roads": roads,
        "lots": lots,
        "rail": rail,
        "buildings": buildings,
        "stadium": stadium,
    }
    os.makedirs(os.path.join(ROOT, "public/data"), exist_ok=True)
    dst = os.path.join(ROOT, "public/data/foxborough.json")
    json.dump(out, open(dst, "w"), separators=(",", ":"))
    tot = sum(l["capEst"] for l in lots)
    print(f"route1 {len(line)} pts, roads {len(roads)}, lots {len(lots)} (~{tot} cars est.), rail {len(rail)}, buildings {len(buildings)}, stadium {'yes' if stadium else 'no'}")
    print(f"wrote {dst} {os.path.getsize(dst)//1024} KB")
    for l in lots:
        print(f"  {l['name']!s:16} {l['capEst']:5} cars est. {l['side']:4} of Route 1, {l['dist']} m away")


if __name__ == "__main__":
    main()
