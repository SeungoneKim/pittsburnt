"""Attach named road corridors to the unnamed sidewalks that run beside them.

Oakland's main streets are tagged sidewalk=separate in OSM, so the walking
network routes people along footways that carry no street name at all. For
routing that is correct; for a demo that narrates "Forbes A / Fifth B /
Craig C" it is useless.

This module pulls named centrelines from the *drive* network and labels a
walk edge with a corridor when it is both close to and roughly parallel with
that centreline.
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict

import geopandas as gpd
import osmnx as ox
from shapely.geometry import LineString
from shapely.strtree import STRtree

from config import (BBOX, CACHE, CORRIDOR_MAX_ANGLE_DEG, CORRIDOR_MAX_DIST_M,
                    CRS_METRIC, CRS_WGS84)

DRIVE_GRAPH_PATH = CACHE / "drive_graph.graphml"
CORRIDORS_PATH = CACHE / "corridors.geojson"

# Aisles and driveways should not inherit a street name.
CORRIDOR_ELIGIBLE = {"sidewalk", "street", "steps"}


def load_drive_graph(force: bool = False):
    if DRIVE_GRAPH_PATH.exists() and not force:
        return ox.load_graphml(DRIVE_GRAPH_PATH)
    G = ox.graph.graph_from_bbox(
        bbox=(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]),
        network_type="drive", simplify=True, retain_all=True,
    )
    ox.save_graphml(G, DRIVE_GRAPH_PATH)
    return G


def build_corridor_lines() -> gpd.GeoDataFrame:
    """One row per named roadway piece, in metric CRS."""
    G = load_drive_graph()
    Gp = ox.project_graph(G, to_crs=CRS_METRIC)
    rows, seen = [], set()
    for u, v, k, d in Gp.edges(keys=True, data=True):
        ek = (min(u, v), max(u, v), k)
        if ek in seen:
            continue
        seen.add(ek)
        name = d.get("name")
        name = name[0] if isinstance(name, list) else name
        if not name:
            continue
        # Bike-lane ways duplicate the carriageway under a near-identical
        # name; they would fragment the corridor label for no benefit.
        if "bike" in str(name).lower():
            continue
        geom = d.get("geometry") or LineString([
            (Gp.nodes[u]["x"], Gp.nodes[u]["y"]),
            (Gp.nodes[v]["x"], Gp.nodes[v]["y"]),
        ])
        if geom.length < 5.0:
            continue
        rows.append({"corridor": name, "geometry": geom})
    return gpd.GeoDataFrame(rows, crs=CRS_METRIC)


def _bearing(p0, p1) -> float:
    return math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))


def _parallel_gap(b1: float, b2: float) -> float:
    """Angle between two undirected bearings, 0-90 degrees."""
    return abs((b1 - b2 + 90.0) % 180.0 - 90.0)


def _local_bearing(line: LineString, dist: float, eps: float = 6.0) -> float:
    a = line.interpolate(max(0.0, dist - eps))
    b = line.interpolate(min(line.length, dist + eps))
    if a.distance(b) < 1e-6:
        return _bearing(line.coords[0], line.coords[-1])
    return _bearing((a.x, a.y), (b.x, b.y))


def assign_corridors(edges: list[dict], corr: gpd.GeoDataFrame) -> None:
    """Set edge['corridor'] in place for every eligible walk edge.

    Works on anything with 'geometry', 'walk_class' and 'name' keys - used
    both for raw walk edges (to steer stroke chaining) and for the final
    segments (which is what the label actually comes from).
    """
    geoms = list(corr.geometry.values)
    names = corr["corridor"].tolist()
    tree = STRtree(geoms)

    for e in edges:
        e["corridor"] = None
        if e["walk_class"] not in CORRIDOR_ELIGIBLE:
            continue

        line = e["geometry"]
        # A walk edge that already carries a street name is its own corridor.
        if e.get("name"):
            e["corridor"] = e["name"]
            continue

        mid = line.interpolate(line.length / 2)
        eb = _local_bearing(line, line.length / 2)

        best, best_d = None, None
        for idx in tree.query(mid.buffer(CORRIDOR_MAX_DIST_M)):
            g = geoms[idx]
            d = g.distance(mid)
            if d > CORRIDOR_MAX_DIST_M:
                continue
            if _parallel_gap(eb, _local_bearing(g, g.project(mid))) > CORRIDOR_MAX_ANGLE_DEG:
                continue
            if best_d is None or d < best_d:
                best, best_d = names[idx], d
        e["corridor"] = best


def dominant_corridor(members: list[str], by_key: dict) -> str | None:
    """The corridor covering the most metres across a stroke's edges."""
    tally: Counter = Counter()
    for m in members:
        e = by_key.get(m)
        if e and e.get("corridor"):
            tally[e["corridor"]] += e["geometry"].length
    return tally.most_common(1)[0][0] if tally else None


def main() -> None:
    corr = build_corridor_lines()
    corr.to_crs(CRS_WGS84).to_file(CORRIDORS_PATH, driver="GeoJSON")
    by = defaultdict(float)
    for _, r in corr.iterrows():
        by[r["corridor"]] += r.geometry.length
    print(f"  named corridor centrelines: {len(corr)} pieces / {len(by)} streets")
    for n in ["Forbes Avenue", "Fifth Avenue", "South Craig Street"]:
        print(f"    {n:20} {by.get(n, 0):7.1f} m")


if __name__ == "__main__":
    main()
