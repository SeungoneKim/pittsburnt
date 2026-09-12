"""Step 5 - deterministic synthetic trip populations.

Each persona gets its own population of walking trips: residential origins,
persona-specific destinations weighted by building footprint (a bigger
building attracts more trips), a departure hour drawn from that persona's
daily rhythm, and a shortest-path route on the Oakland walking graph.

Everything is drawn from one frozen seed. That is the whole point: the
before/after comparison the demo rests on must run the *same* people over
the *same* geometry, so that the only thing that changed is the intervention.

The artifact that matters is minutes.npz - minutes[segment, persona, hour],
the pedestrian-minutes each persona spends on each segment at each snapshot.
Multiply by heat, sun exposure and planning weight and you have the score.
"""
from __future__ import annotations

import json
from collections import defaultdict

import geopandas as gpd
import networkx as nx
import numpy as np
import osmnx as ox

from config import (CACHE, CRS_METRIC, CRS_WGS84, HOURS, HOUR_LABELS, N_TRIPS,
                    PERSONAS, RESIDENTIAL_BUILDINGS, SEED)

MINUTES_PATH = CACHE / "minutes.npz"
TRIPS_PATH = CACHE / "trips.geojson"
TRIP_META_PATH = CACHE / "trips_meta.json"

# Trips shorter than this are not really a walk through the city.
MIN_TRIP_M = 120.0
# How many destination candidates to consider before giving up on a distance
# constraint; keeps generation deterministic and bounded.
MAX_DRAW_ATTEMPTS = 40


def weighted_choice(rng: np.random.Generator, idx: np.ndarray,
                    weights: np.ndarray, size: int) -> np.ndarray:
    p = weights / weights.sum()
    return rng.choice(idx, size=size, p=p)


def build_trip_population(rng, Gp, nodes_xy, origins, dests, persona, n):
    """Sample origin/destination pairs and snap them to graph nodes."""
    o_idx = weighted_choice(rng, np.arange(len(origins)),
                            origins["area_m2"].to_numpy(), n * MAX_DRAW_ATTEMPTS)
    d_idx = weighted_choice(rng, np.arange(len(dests)),
                            dests["area_m2"].to_numpy(), n * MAX_DRAW_ATTEMPTS)
    ox_, oy_ = origins.geometry.x.to_numpy(), origins.geometry.y.to_numpy()
    dx_, dy_ = dests.geometry.x.to_numpy(), dests.geometry.y.to_numpy()

    # Accept the first draw that lands inside the persona's trip-length band,
    # so short-range personas really do make short-range trips.
    picks, k = [], 0
    while len(picks) < n and k < len(o_idx):
        oi, di = o_idx[k], d_idx[k]
        k += 1
        d = float(np.hypot(ox_[oi] - dx_[di], oy_[oi] - dy_[di]))
        if MIN_TRIP_M <= d <= persona["max_trip_m"]:
            picks.append((oi, di))
    if not picks:
        return []

    oxs = np.array([ox_[a] for a, _ in picks])
    oys = np.array([oy_[a] for a, _ in picks])
    dxs = np.array([dx_[b] for _, b in picks])
    dys = np.array([dy_[b] for _, b in picks])
    o_nodes = ox.distance.nearest_nodes(Gp, oxs, oys)
    d_nodes = ox.distance.nearest_nodes(Gp, dxs, dys)
    return list(zip(o_nodes, d_nodes))


def route_to_segments(Gp, route, edge_map):
    """Convert a node route into {seg_id: metres walked} plus total metres."""
    per_seg, total = defaultdict(float), 0.0
    for u, v in zip(route[:-1], route[1:]):
        data = Gp.get_edge_data(u, v)
        if not data:
            continue
        k = min(data, key=lambda kk: data[kk].get("length", np.inf))
        length = float(data[k].get("length", 0.0))
        total += length
        entry = edge_map.get(f"{min(u, v)}_{max(u, v)}_{k}")
        if not entry:
            continue
        covered = sum(m for _, m in entry)
        if covered <= 0:
            continue
        # Apportion this edge's length across the segments it overlaps.
        for sid, m in entry:
            per_seg[sid] += length * (m / covered)
    return per_seg, total


def main() -> None:
    print("STEP 5  synthetic trip populations")
    rng = np.random.default_rng(SEED)

    G = ox.load_graphml(CACHE / "walk_graph.graphml")
    Gp = ox.project_graph(G, to_crs=CRS_METRIC)
    edge_map = json.loads((CACHE / "edge_segments.json").read_text())
    seg = gpd.read_file(CACHE / "segments.geojson")
    seg_pos = {sid: i for i, sid in enumerate(seg["seg_id"])}

    bld = gpd.read_file(CACHE / "buildings.geojson").to_crs(CRS_METRIC)
    cent = bld.copy()
    cent["geometry"] = cent.geometry.centroid
    origins = cent[cent["building"].isin(RESIDENTIAL_BUILDINGS)]
    print(f"  origin pool: {len(origins)} residential buildings")

    nodes_xy = None
    persona_names = list(PERSONAS)
    minutes = np.zeros((len(seg), len(persona_names), len(HOURS)), dtype=np.float32)
    routes_out, meta = [], []
    hour_index = {h: i for i, h in enumerate(HOURS)}

    for pi, pname in enumerate(persona_names):
        persona = PERSONAS[pname]
        dests = cent[cent["building"].isin(persona["destinations"])]
        pairs = build_trip_population(rng, Gp, nodes_xy, origins, dests,
                                      persona, N_TRIPS)

        mix_hours = np.array(list(persona["departure_mix"]))
        mix_p = np.array(list(persona["departure_mix"].values()), dtype=float)
        mix_p /= mix_p.sum()
        depart = rng.choice(mix_hours, size=len(pairs), p=mix_p)

        ok, lens = 0, []
        for ti, ((o, d), hr) in enumerate(zip(pairs, depart)):
            if o == d:
                continue
            try:
                route = nx.shortest_path(Gp, o, d, weight="length")
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue
            per_seg, total_m = route_to_segments(Gp, route, edge_map)
            if total_m < MIN_TRIP_M or not per_seg:
                continue
            ok += 1
            lens.append(total_m)
            hi = hour_index[int(hr)]
            # Slower walkers accumulate more minutes on the same pavement -
            # the mechanism the brief asks for, with no invented multiplier.
            for sid, m in per_seg.items():
                j = seg_pos.get(sid)
                if j is not None:
                    minutes[j, pi, hi] += m / persona["speed_mps"] / 60.0
            if ok <= 60:  # keep a displayable subset for the frontend
                routes_out.append({
                    "persona": pname, "hour": int(hr),
                    "length_m": round(total_m, 1),
                    "minutes": round(total_m / persona["speed_mps"] / 60.0, 2),
                    "geometry": ox.routing.route_to_gdf(Gp, route).geometry.union_all(),
                })

        lens = np.array(lens) if lens else np.array([0.0])
        tot_min = minutes[:, pi, :].sum()
        meta.append({"persona": pname, "label": persona["label"],
                     "trips": ok, "median_trip_m": float(np.median(lens)),
                     "total_minutes": float(tot_min),
                     "speed_mps": persona["speed_mps"],
                     "planning_weight": persona["planning_weight"]})
        print(f"  {persona['label']:22} {ok:4} trips  median {np.median(lens):6.0f} m  "
              f"{tot_min:8.0f} pedestrian-minutes")

    np.savez_compressed(MINUTES_PATH, minutes=minutes,
                        seg_ids=seg["seg_id"].to_numpy(),
                        personas=np.array(persona_names), hours=np.array(HOURS))
    TRIP_META_PATH.write_text(json.dumps(
        {"seed": SEED, "n_trips_requested": N_TRIPS, "personas": meta}, indent=2))
    if routes_out:
        gpd.GeoDataFrame(routes_out, crs=CRS_METRIC).to_crs(CRS_WGS84) \
            .to_file(TRIPS_PATH, driver="GeoJSON")

    touched = (minutes.sum(axis=(1, 2)) > 0).mean()
    print(f"  segments carrying any traffic: {touched*100:.1f}%")
    print("  pedestrian-minutes by hour:")
    for hi, h in enumerate(HOURS):
        print(f"    {HOUR_LABELS[h]:>5}  {minutes[:, :, hi].sum():9.0f}")
    print(f"  wrote {MINUTES_PATH.name} {minutes.shape}, "
          f"{TRIPS_PATH.name}, {TRIP_META_PATH.name}")


if __name__ == "__main__":
    main()
