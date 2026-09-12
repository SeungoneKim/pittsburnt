"""Step 1 - Oakland walking graph -> fixed-length street segments.

The raw OSM walk network is noded at every crossing, so its edges have a
median length of ~22m - far shorter than the 50-150m analysis unit the brief
asks for. Plain linemerge does not fix this: it stops at every junction, and
a mapped sidewalk network has a junction every ~30m.

So we build "strokes" instead - chains that walk *through* junctions by
following the straightest continuation of the same walk class, preferring to
stay on the same street name. That reconstructs Forbes Avenue as one long
corridor, which we then cut to a uniform ~100m.

Artifacts:
  segments.geojson   - the analysis/display unit, with stable seg_ids
  edge_segments.json - maps each OSM graph edge to the segments it covers, so
                       a routed trip becomes per-segment metres walked.
"""
from __future__ import annotations

import json
import math
import re
from collections import defaultdict

import geopandas as gpd
import networkx as nx
import numpy as np
import osmnx as ox
from shapely.geometry import LineString
from shapely.ops import substring
from shapely.strtree import STRtree

from config import (BBOX, CACHE, CORRIDORS, CRS_METRIC, CRS_WGS84,
                    SEGMENT_MAX_M, SEGMENT_MIN_M, SEGMENT_TARGET_M)
from corridors import (assign_corridors, build_corridor_lines,
                       dominant_corridor)

GRAPH_PATH = CACHE / "walk_graph.graphml"
SEGMENTS_PATH = CACHE / "segments.geojson"
EDGE_MAP_PATH = CACHE / "edge_segments.json"

# How we bucket OSM highway tags for display + filtering. Nothing is dropped:
# the frontend decides what to draw, the model scores all of it.
WALK_CLASS = {
    "primary": "street", "primary_link": "street",
    "secondary": "street", "secondary_link": "street",
    "tertiary": "street", "tertiary_link": "street",
    "trunk": "street", "trunk_link": "street",
    "residential": "street", "unclassified": "street",
    "living_street": "street", "pedestrian": "street",
    "footway": "sidewalk", "path": "sidewalk", "track": "sidewalk",
    "steps": "steps",
    "service": "service",
}

MAX_TURN_DEG = 60.0   # beyond this, a continuation is a turn, not a corridor
NAME_BONUS_DEG = 25.0  # staying on the same street is worth this much turn


def _scalar(val):
    """OSM tags are sometimes lists when ways were merged; take the first."""
    return val[0] if isinstance(val, list) else val


def load_graph(force: bool = False) -> nx.MultiDiGraph:
    if GRAPH_PATH.exists() and not force:
        print(f"  loading cached graph {GRAPH_PATH.name}")
        return ox.load_graphml(GRAPH_PATH)
    print("  downloading OSM walk network (one time)...")
    G = ox.graph.graph_from_bbox(
        bbox=(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]),
        network_type="walk", simplify=True, retain_all=False,
    )
    ox.save_graphml(G, GRAPH_PATH)
    return G


def edge_table(Gp: nx.MultiDiGraph) -> list[dict]:
    """One record per undirected street edge, geometry oriented a -> b."""
    rows, seen = [], set()
    for u, v, k, data in Gp.edges(keys=True, data=True):
        ek = (min(u, v), max(u, v), k)
        if ek in seen:
            continue
        seen.add(ek)
        geom = data.get("geometry") or LineString([
            (Gp.nodes[u]["x"], Gp.nodes[u]["y"]),
            (Gp.nodes[v]["x"], Gp.nodes[v]["y"]),
        ])
        if geom.length < 0.5:
            continue
        hw = _scalar(data.get("highway")) or "unclassified"
        rows.append({
            # a/b follow the stored geometry's direction; key_str is the
            # canonical undirected id used by the edge -> segment map.
            "a": u, "b": v,
            "key_str": f"{ek[0]}_{ek[1]}_{ek[2]}",
            "name": _scalar(data.get("name")),
            "highway": hw,
            "walk_class": WALK_CLASS.get(hw, "service"),
            "geometry": geom,
        })
    return rows


def _bearing(p0, p1) -> float:
    return math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))


def _turn(b_in: float, b_out: float) -> float:
    """Absolute deviation from going straight on, in degrees."""
    return abs((b_out - b_in + 180.0) % 360.0 - 180.0)


def build_strokes(edges: list[dict]) -> list[dict]:
    """Chain edges into long corridors through junctions."""
    adj: dict[int, list[int]] = defaultdict(list)
    for i, e in enumerate(edges):
        adj[e["a"]].append(i)
        adj[e["b"]].append(i)

    coords = [list(e["geometry"].coords) for e in edges]
    used = [False] * len(edges)
    # Seed from the longest edges first so major streets anchor the strokes.
    order = sorted(range(len(edges)),
                   key=lambda i: (-edges[i]["geometry"].length, edges[i]["key_str"]))

    def extend(node: int, bearing_in: float, wclass: str, name) -> tuple | None:
        """Pick the straightest unused continuation at `node`, or None."""
        best, best_score = None, None
        for j in sorted(adj[node], key=lambda j: edges[j]["key_str"]):
            if used[j] or edges[j]["walk_class"] != wclass:
                continue
            ej, cj = edges[j], coords[j]
            if ej["a"] == node:
                flip, b_out = False, _bearing(cj[0], cj[1])
            elif ej["b"] == node:
                flip, b_out = True, _bearing(cj[-1], cj[-2])
            else:
                continue
            score = _turn(bearing_in, b_out)
            if name is not None and (ej.get("corridor") or ej["name"]) == name:
                score -= NAME_BONUS_DEG
            if score <= MAX_TURN_DEG and (best_score is None or score < best_score):
                best, best_score = (j, flip), score
        return best

    strokes = []
    for i0 in order:
        if used[i0]:
            continue
        used[i0] = True
        chain = [(i0, False)]
        wclass = edges[i0]["walk_class"]
        # Prefer to stay on the same corridor; most sidewalks have no OSM name.
        name = edges[i0].get("corridor") or edges[i0]["name"]

        # Grow forward off the tail, then backward off the head.
        for direction in ("fwd", "bwd"):
            while True:
                idx, flip = chain[-1] if direction == "fwd" else chain[0]
                e, c = edges[idx], coords[idx]
                if direction == "fwd":
                    node = e["a"] if flip else e["b"]
                    pts = c[::-1] if flip else c
                    b_in = _bearing(pts[-2], pts[-1])
                else:
                    node = e["b"] if flip else e["a"]
                    pts = c[::-1] if flip else c
                    # Looking backwards out of the head of the chain.
                    b_in = _bearing(pts[1], pts[0])
                nxt = extend(node, b_in, wclass, name)
                if nxt is None:
                    break
                j, jflip = nxt
                used[j] = True
                if direction == "fwd":
                    chain.append((j, jflip))
                else:
                    # Reverse it so the chain stays head-to-tail consistent.
                    chain.insert(0, (j, not jflip))

        pts: list = []
        members = []
        for idx, flip in chain:
            c = coords[idx][::-1] if flip else coords[idx]
            members.append(edges[idx]["key_str"])
            pts.extend(c if not pts else c[1:])
        if len(pts) < 2:
            continue
        strokes.append({
            "geometry": LineString(pts),
            "walk_class": wclass,
            "members": members,
        })
    return strokes


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:28] or "x"


def split_line(line: LineString) -> list[LineString]:
    """Cut a corridor into pieces as close to SEGMENT_TARGET_M as possible."""
    total = line.length
    if total <= SEGMENT_MAX_M:
        return [line]
    n = max(1, round(total / SEGMENT_TARGET_M))
    while n > 1 and total / n < SEGMENT_MIN_M:
        n -= 1
    step = total / n
    return [substring(line, i * step, (i + 1) * step) for i in range(n)]


def build_segments(strokes: list[dict], by_key: dict) -> gpd.GeoDataFrame:
    strokes = sorted(strokes, key=lambda s: (round(s["geometry"].bounds[0], 2),
                                             round(s["geometry"].bounds[1], 2)))
    rows = []
    for si, st in enumerate(strokes):
        corridor = dominant_corridor(st["members"], by_key)
        base = _slug(corridor or st["walk_class"])
        for pi, piece in enumerate(split_line(st["geometry"])):
            if piece.length < 0.5:
                continue
            rows.append({
                # stroke index is global, so seg_ids cannot collide
                "seg_id": f"{base}-{si:04d}-{pi:02d}",
                "corridor": corridor,
                "walk_class": st["walk_class"],
                "length_m": round(piece.length, 2),
                "geometry": piece,
            })
    return gpd.GeoDataFrame(rows, crs=CRS_METRIC)


def map_edges_to_segments(edges: list[dict], seg: gpd.GeoDataFrame) -> dict:
    """For each OSM edge, how many metres of it fall on each segment.

    Routing happens on the graph, but scoring happens on segments. Sampling
    each edge every ~10m and snapping to the nearest segment gives a robust
    edge -> [(seg_id, metres)] translation without needing exact topology.
    """
    tree = STRtree(list(seg.geometry.values))
    seg_ids = seg["seg_id"].tolist()
    out: dict[str, list] = {}
    for e in edges:
        line, L = e["geometry"], e["geometry"].length
        n = max(1, int(np.ceil(L / 10.0)))
        share = L / n
        acc: dict[str, float] = defaultdict(float)
        for i in range(n):
            acc[seg_ids[tree.nearest(line.interpolate((i + 0.5) * share))]] += share
        out[e["key_str"]] = [[sid, round(m, 2)]
                             for sid, m in sorted(acc.items(), key=lambda kv: -kv[1])]
    return out


def main() -> None:
    print("STEP 1  walking graph -> segments")
    G = load_graph()
    Gp = ox.project_graph(G, to_crs=CRS_METRIC)
    print(f"  graph: {G.number_of_nodes()} nodes / {G.number_of_edges()} directed edges")

    edges = edge_table(Gp)
    print(f"  undirected street edges: {len(edges)}  "
          f"(median {np.median([e['geometry'].length for e in edges]):.1f} m)")

    corr = build_corridor_lines()
    assign_corridors(edges, corr)
    by_key = {e["key_str"]: e for e in edges}
    matched = sum(1 for e in edges if e.get("corridor"))
    print(f"  corridor centrelines: {len(corr)} pieces / "
          f"{corr.corridor.nunique()} streets")
    print(f"  walk edges matched to a corridor: {matched}/{len(edges)} "
          f"({matched/len(edges)*100:.1f}%)")

    strokes = build_strokes(edges)
    sl = np.array([s["geometry"].length for s in strokes])
    print(f"  strokes: {len(strokes)}  median {np.median(sl):.1f} m  max {sl.max():.1f} m")

    seg = build_segments(strokes, by_key)
    assert seg["seg_id"].is_unique, "seg_id collision"

    # Re-label each segment against the centrelines directly. Strokes chain
    # straight through the South/North Craig boundary, so a stroke-level
    # majority vote would hand the whole corridor to one of the two names.
    recs = seg.to_dict("records")
    assign_corridors(recs, corr)
    seg["corridor"] = [r["corridor"] for r in recs]
    seg.to_crs(CRS_WGS84).to_file(SEGMENTS_PATH, driver="GeoJSON")

    emap = map_edges_to_segments(edges, seg)
    EDGE_MAP_PATH.write_text(json.dumps(emap))

    L = seg["length_m"]
    print(f"  segments: {len(seg)}  (all seg_ids unique)")
    print(f"  length:   min {L.min():.1f}  p25 {L.quantile(.25):.1f}  "
          f"median {L.median():.1f}  p75 {L.quantile(.75):.1f}  max {L.max():.1f} m")
    print(f"  in 50-150m band: {((L >= 50) & (L <= 150)).mean()*100:.1f}%  "
          f"| share of total length: "
          f"{L[(L >= 50) & (L <= 150)].sum()/L.sum()*100:.1f}%")
    print(f"  total centreline: {L.sum()/1000:.2f} km (input {sum(e['geometry'].length for e in edges)/1000:.2f} km)")
    print("  by class:")
    for cls, grp in seg.groupby("walk_class"):
        print(f"    {cls:10} {len(grp):5} segs  {grp.length_m.sum()/1000:7.2f} km  "
              f"median {grp.length_m.median():6.1f} m")
    named = seg[seg["corridor"].notna()]
    print(f"  segments with a corridor: {len(named)}/{len(seg)} "
          f"({len(named)/len(seg)*100:.1f}%), {named.corridor.nunique()} streets")
    print("  hero corridors:")
    for nm in CORRIDORS:
        g = seg[seg["corridor"] == nm]
        print(f"    {nm:20} {len(g):3} segs  {g.length_m.sum():7.1f} m  "
              f"median {g.length_m.median() if len(g) else 0:5.1f} m")
    print(f"  edge->segment mappings: {len(emap)}")


if __name__ == "__main__":
    main()
