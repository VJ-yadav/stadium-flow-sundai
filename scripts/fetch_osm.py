"""Download the OpenStreetMap data the model is built from.

Output: data/raw/osm.json (not committed; scripts/build_data.py reads it).

Asks the Overpass API for everything within 2.5 km of a point just south of Fenway Park:
streets, car parks, rail, water and parks, plus building outlines within 1.1 km of the park.
The area is asked for in small pieces because public Overpass servers time out on big ones,
and every piece is retried on the next server when one is busy.

Run:  python3 -I scripts/fetch_osm.py     (or: npm run fetch)
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
AREA = "(around:2500,42.3445,-71.097)"      # the streets cars leave by
NEAR = "(around:1100,42.3467,-71.0972)"     # buildings drawn around the park
PARK = "(around:400,42.3467,-71.0972)"


def ways(*classes):
    return "(" + "".join(f"way[highway={c}]{AREA};" for c in classes) + ");out tags geom;"


QUERIES = {
    "motorways": ways("motorway", "motorway_link", "trunk", "trunk_link"),
    "primary": ways("primary", "primary_link"),
    "secondary": ways("secondary", "secondary_link"),
    "tertiary": ways("tertiary", "tertiary_link"),
    "streets": ways("residential", "unclassified", "living_street"),
    "service": "way[highway=service](around:1300,42.3467,-71.0972);out tags geom;",
    "parking": f"(node[amenity=parking]{AREA};way[amenity=parking]{AREA};node[amenity=parking_entrance]{AREA};);out tags geom;",
    "parking relations": f"relation[amenity=parking]{AREA};out geom;",
    "rail": f"(way[railway=rail]{AREA};way[railway=light_rail]{AREA};way[railway=subway]{AREA};node[railway=station]{AREA};node[railway=stop]{AREA};node[railway=tram_stop]{AREA};);out tags geom;",
    "buildings": f"way[building]{NEAR};out tags geom;",
    "building relations": f"relation[building]{NEAR};out geom;",
    "ballpark": f"(relation[leisure=stadium]{PARK};way[leisure=stadium]{PARK};);out geom;",
    "water": f"(way[natural=water]{AREA};);out tags geom;",
    "water relations": f"relation[natural=water]{AREA};out geom;",
    "parks": f"way[leisure=park]{AREA};out tags geom;",
    "park relations": f"relation[leisure=park]{AREA};out geom;",
}


def ask(query, tries=4):
    body = urllib.parse.urlencode({"data": "[out:json][timeout:60];" + query}).encode()
    last = None
    for attempt in range(tries):
        for server in SERVERS:
            try:
                req = urllib.request.Request(server, data=body, headers={"User-Agent": "stadium-flow-fenway/0.1 (data build script)"})
                with urllib.request.urlopen(req, timeout=90) as r:
                    els = json.loads(r.read().decode("utf-8"))["elements"]
                return els
            except Exception as e:  # busy server, timeout, or an error page that is not JSON
                last = e
                time.sleep(2 + 2 * attempt)
    raise RuntimeError(f"no Overpass server answered: {last}")


def merge(batches):
    """One element per (type, id). The copy with the most detail wins."""
    out = {}
    for els in batches:
        for e in els:
            e.setdefault("tags", {})
            if e["type"] == "relation":
                e["members"] = [m for m in e.get("members", []) if m.get("geometry")]
            k = (e["type"], e["id"])
            old = out.get(k)
            if old is None:
                out[k] = e
                continue
            if len(e["tags"]) > len(old["tags"]):
                old["tags"] = e["tags"]
            if len(e.get("members", [])) > len(old.get("members", [])):
                old["members"] = e["members"]
            if "geometry" in e and "geometry" not in old:
                old["geometry"] = e["geometry"]
    return list(out.values())


def main():
    batches = []
    for name, q in QUERIES.items():
        print(f"{name}...", end=" ", flush=True)
        els = ask(q)
        print(len(els))
        batches.append(els)
        time.sleep(1)
    els = merge(batches)
    dst = os.path.join(ROOT, "data/raw/osm.json")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    json.dump({"version": 0.6, "generator": "Overpass API, merged by scripts/fetch_osm.py", "elements": els}, open(dst, "w"), separators=(",", ":"))
    print(f"wrote {dst}: {len(els)} elements, {os.path.getsize(dst) // 1024} KB")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        sys.exit(str(e))
