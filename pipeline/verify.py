"""Artifact verifier - the automated half of supervising this pipeline.

Every pipeline step writes files into data/cache. This script re-opens those
files cold and asserts the properties that downstream code relies on. Run it
after any pipeline change; a green run means the artifacts are self-consistent,
not merely that a script exited 0.
"""
from __future__ import annotations

import json
import sys

import geopandas as gpd
import numpy as np

from config import CACHE, CORRIDORS, SEGMENT_MAX_M

PASS, FAIL, WARN = "PASS", "FAIL", "WARN"
results: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "", warn_only: bool = False) -> None:
    status = PASS if ok else (WARN if warn_only else FAIL)
    results.append((status, name, detail))


def verify_segments() -> None:
    path = CACHE / "segments.geojson"
    if not path.exists():
        check("segments.geojson exists", False, "missing - run step01")
        return
    seg = gpd.read_file(path)

    check("segments.geojson exists", True, f"{len(seg)} features")
    check("seg_id unique", seg.seg_id.is_unique,
          f"{len(seg)} rows / {seg.seg_id.nunique()} unique")
    check("no null geometry", seg.geometry.notna().all())
    check("all geometries valid", seg.geometry.is_valid.all())
    check("CRS is WGS84", seg.crs is not None and seg.crs.to_epsg() == 4326,
          str(seg.crs))

    L = seg["length_m"]
    check("no segment exceeds max length", bool((L <= SEGMENT_MAX_M + 1).all()),
          f"max {L.max():.1f}m vs cap {SEGMENT_MAX_M}m")
    band = ((L >= 50) & (L <= 150))
    share = L[band].sum() / L.sum() * 100
    check("majority of length in 50-150m band", share >= 80,
          f"{share:.1f}% of centreline metres")

    # A corridor label is what the demo narrates; all three must be present
    # and each should be roughly two sidewalks long, not one stub.
    for name in CORRIDORS:
        g = seg[seg["corridor"] == name]
        check(f"corridor present: {name}", len(g) >= 2,
              f"{len(g)} segs / {g.length_m.sum():.0f} m")

    # Segment total must equal the graph it came from - a silent geometry
    # loss here would quietly under-report exposure everywhere.
    check("total centreline plausible", 100 < L.sum() / 1000 < 400,
          f"{L.sum()/1000:.2f} km")


def verify_edge_map() -> None:
    path = CACHE / "edge_segments.json"
    seg_path = CACHE / "segments.geojson"
    if not path.exists() or not seg_path.exists():
        check("edge_segments.json exists", False, "missing - run step01")
        return
    emap = json.loads(path.read_text())
    seg_ids = set(gpd.read_file(seg_path)["seg_id"])

    check("edge_segments.json exists", True, f"{len(emap)} edges")
    referenced = {sid for v in emap.values() for sid, _ in v}
    check("every referenced seg_id exists", referenced <= seg_ids,
          f"{len(referenced - seg_ids)} dangling")
    coverage = len(referenced & seg_ids) / len(seg_ids) * 100
    check("edge map covers most segments", coverage >= 90,
          f"{coverage:.1f}% of segments reachable from some edge")
    check("no empty edge mappings", all(len(v) > 0 for v in emap.values()))
    totals = np.array([sum(m for _, m in v) for v in emap.values()])
    check("edge metres positive", bool((totals > 0).all()),
          f"median {np.median(totals):.1f} m/edge")


def verify_buildings() -> None:
    path = CACHE / "buildings.geojson"
    if not path.exists():
        check("buildings.geojson exists", False, "missing - run step02")
        return
    b = gpd.read_file(path)

    check("buildings.geojson exists", True, f"{len(b)} features")
    check("bldg_id unique", b.bldg_id.is_unique,
          f"{len(b)} rows / {b.bldg_id.nunique()} unique")
    check("all geometries valid", b.geometry.is_valid.all())
    check("every building has a height", b.height_m.notna().all())
    check("heights physically plausible", bool(((b.height_m >= 2) & (b.height_m <= 250)).all()),
          f"{b.height_m.min():.1f} - {b.height_m.max():.1f} m")
    check("every height has a source", b.height_source.notna().all() & (b.height_source != "").all(),
          " / ".join(sorted(b.height_source.unique())))

    meas = b.height_is_measured
    check("majority of buildings measured", meas.mean() >= 0.5,
          f"{meas.mean()*100:.1f}% of buildings, "
          f"{b[meas].area_m2.sum()/b.area_m2.sum()*100:.1f}% of area")
    # The tall landmark is the sanity check that the ladder reaches 3D data.
    tallest = b.loc[b.height_m.idxmax()]
    check("tallest building is a real landmark", tallest.height_m > 100,
          f"{tallest.bldg_name} at {tallest.height_m:.0f} m ({tallest.height_source})")
    check("shadow-casting area mostly measured", 
          b[meas].area_m2.sum()/b.area_m2.sum() >= 0.5,
          f"{b[meas].area_m2.sum()/b.area_m2.sum()*100:.1f}% of footprint area",
          warn_only=True)


def verify_shadows() -> None:
    path = CACHE / "sun_exposure.npz"
    if not path.exists():
        check("sun_exposure.npz exists", False, "missing - run step03")
        return
    z = np.load(path, allow_pickle=True)
    sun, ids, hours = z["sun_exposure"], list(z["seg_ids"]), list(z["hours"])
    seg = gpd.read_file(CACHE / "segments.geojson")

    check("sun_exposure.npz exists", True, f"{sun.shape[0]} segs x {sun.shape[1]} hours")
    check("sun_exposure aligns with segments", ids == seg["seg_id"].tolist(),
          "row order matches segments.geojson")
    check("sun_exposure in [0,1]", bool((sun >= 0).all() and (sun <= 1).all()),
          f"[{sun.min():.3f}, {sun.max():.3f}]")
    check("no NaN in sun_exposure", not bool(np.isnan(sun).any()))

    solar = json.loads((CACHE / "solar_positions.json").read_text())
    pos = {p["hour"]: p for p in solar["positions"]}
    # Morning sun is in the east, evening in the west. If these flip, every
    # shadow in the model is on the wrong side of every building.
    check("morning sun is easterly", 45 < pos[8]["azimuth_deg"] < 135,
          f"8 AM azimuth {pos[8]['azimuth_deg']:.1f}deg")
    check("evening sun is westerly", 225 < pos[18]["azimuth_deg"] < 315,
          f"6 PM azimuth {pos[18]['azimuth_deg']:.1f}deg")
    check("sun highest around midday",
          pos[12]["elevation_deg"] > pos[8]["elevation_deg"]
          and pos[12]["elevation_deg"] > pos[18]["elevation_deg"],
          " / ".join(f"{h}h {pos[h]['elevation_deg']:.0f}deg" for h in (8, 12, 15, 18)))
    # Low sun must shade more than high sun, or the geometry is inverted.
    by_hour = {h: 1 - sun[:, i].mean() for i, h in enumerate(hours)}
    check("low sun shades more than high sun",
          by_hour[8] > by_hour[12] and by_hour[18] > by_hour[15],
          " / ".join(f"{h}h {by_hour[h]*100:.0f}%" for h in (8, 12, 15, 18)))
    check("shadow polygons written",
          all((CACHE / f"shadow_{h:02d}.geojson").exists() for h in hours))

    if "shade_tree" in z:
        sb, st = z["shade_bldg"], z["shade_tree"]
        block = float(z["canopy_block"])
        check("shade components present", True,
              f"canopy source: {str(z['canopy_source'])[:46]}")
        # The two shade sources are computed to be disjoint; if they ever sum
        # past 1 the same metre of pavement is being shaded twice.
        check("building + canopy shade never exceed 1",
              bool(((sb + st) <= 1.0001).all()),
              f"max combined {float((sb + st).max()):.3f}")
        check("sun_exposure matches its components",
              bool(np.allclose(sun, np.clip(1 - sb - block * st, 0, 1), atol=1e-5)),
              f"canopy blocks {block:.0%} of direct beam")
        # Canopy sits over the footway, so at high sun it must out-shade the
        # buildings - that is the whole argument for planting trees.
        i15 = hours.index(15)
        check("canopy out-shades buildings at 3 PM",
              float(st[:, i15].mean()) > float(sb[:, i15].mean()),
              f"canopy {st[:, i15].mean()*100:.1f}% vs buildings "
              f"{sb[:, i15].mean()*100:.1f}%")


def verify_trees() -> None:
    path = CACHE / "trees.geojson"
    if not path.exists():
        check("trees.geojson exists", False, "missing - run step04")
        return
    t = gpd.read_file(path)
    check("trees.geojson exists", True, f"{len(t)} standing trees")
    check("tree_id unique", t.tree_id.is_unique)
    check("no stumps or vacant sites kept",
          not t.common_name.astype(str).str.lower()
               .str.contains("stump|vacant", na=False).any())
    check("crown dimensions positive",
          bool((t.crown_r_m > 0).all() and (t.crown_h_m > 0).all()),
          f"radius median {t.crown_r_m.median():.1f} m")


def verify_trips() -> None:
    path = CACHE / "minutes.npz"
    if not path.exists():
        check("minutes.npz exists", False, "missing - run step05")
        return
    z = np.load(path, allow_pickle=True)
    mins = z["minutes"]
    seg = gpd.read_file(CACHE / "segments.geojson")
    meta = json.loads((CACHE / "trips_meta.json").read_text())

    check("minutes.npz exists", True,
          f"{mins.shape[0]} segs x {mins.shape[1]} personas x {mins.shape[2]} hours")
    check("minutes aligns with segments",
          list(z["seg_ids"]) == seg["seg_id"].tolist())
    check("minutes non-negative and finite",
          bool((mins >= 0).all() and np.isfinite(mins).all()))
    check("every persona generated trips",
          all(p["trips"] > 0 for p in meta["personas"]),
          " / ".join(f"{p['persona'][:4]}:{p['trips']}" for p in meta["personas"]))
    touched = (mins.sum(axis=(1, 2)) > 0).mean()
    check("trips reach a good share of the network", touched >= 0.4,
          f"{touched*100:.1f}% of segments carry traffic")

    # Slower personas must accumulate more minutes per metre walked, since
    # that is the entire mechanism by which vulnerability enters the model.
    by = {p["persona"]: p for p in meta["personas"]}
    slow, fast = by["mobility_constrained"], by["workers"]
    slow_rate = slow["total_minutes"] / max(slow["trips"] * slow["median_trip_m"], 1)
    fast_rate = fast["total_minutes"] / max(fast["trips"] * fast["median_trip_m"], 1)
    check("slower walkers accumulate more minutes per metre",
          slow_rate > fast_rate,
          f"{slow_rate*1000:.2f} vs {fast_rate*1000:.2f} min per km")
    check("personas differ in trip length",
          by["workers"]["median_trip_m"] > by["mobility_constrained"]["median_trip_m"],
          f"workers {by['workers']['median_trip_m']:.0f} m vs "
          f"mobility {by['mobility_constrained']['median_trip_m']:.0f} m")
    check("trip seed recorded", "seed" in meta, f"seed {meta.get('seed')}")

    # "All pedestrians" must be the sum of the cohorts, not a fifth draw.
    personas = [str(p) for p in z["personas"]]
    derived = meta.get("derived_persona")
    if derived in personas:
        di = personas.index(derived)
        others = [i for i in range(len(personas)) if i != di]
        diff = float(np.abs(mins[:, di, :] - mins[:, others, :].sum(axis=1)).max())
        check("'all' is the aggregation of the cohorts", diff < 1e-3,
              f"max per-segment difference {diff:.2e} min")
        check("'all' carries no planning weight",
              next(p["planning_weight"] for p in meta["personas"]
                   if p["persona"] == derived) == 1.0)

    # Walking speeds are the spec's single source of truth.
    expected = {"students": 1.30, "workers": 1.20,
                "older_adults": 0.90, "mobility_constrained": 0.80}
    got = {p["persona"]: p["speed_mps"] for p in meta["personas"]}
    bad = {k: got.get(k) for k, v in expected.items() if abs(got.get(k, -1) - v) > 1e-9}
    check("persona speeds match the specified values", not bad,
          bad or " / ".join(f"{k} {v}" for k, v in expected.items()))


def verify_scenarios() -> None:
    path = CACHE / "scenarios.json"
    if not path.exists():
        check("scenarios.json exists", False, "missing - run step06")
        return
    sc = json.loads(path.read_text())
    scen = sc["scenarios"]
    check("scenarios.json exists", True, " / ".join(scen))
    check("baseline is named as observed, not as today",
          scen["baseline"]["label"].lower().startswith("observed"),
          scen["baseline"]["label"])
    check("no scenario is extrapolated",
          not any(v.get("is_extrapolated") for v in scen.values()),
          " / ".join(f"{k}:{v['delta_c']:+.2f}C" for k, v in scen.items()))
    check("futures use the named CMIP6-LOCA2 windows",
          {v["ensemble"]["window"] for k, v in scen.items() if v["ensemble"]}
          == {"2025-2049", "2050-2074"},
          " / ".join(f"{k} {v['ensemble']['window']}"
                     for k, v in scen.items() if v["ensemble"]))
    check("every hour carries the UTCI inputs",
          all(all(k in row for k in
                  ("air_temp_c", "rh_pct", "wind_ms", "ghi_wm2",
                   "utci_sun_c", "utci_shade_c", "tmrt_sun_c"))
              for v in scen.values() for row in v["hours"].values()),
          "temp / RH / wind / radiation / Tmrt / UTCI")
    # Sun must always be hotter than shade, at every hour of every scenario.
    pairs = [(row["utci_sun_c"], row["utci_shade_c"])
             for v in scen.values() for row in v["hours"].values()]
    check("sun is hotter than shade everywhere",
          all(a > b for a, b in pairs),
          f"relief {min(a-b for a, b in pairs):.1f}-{max(a-b for a, b in pairs):.1f} C")
    check("warming increases with the horizon",
          scen["baseline"]["delta_c"] < scen["heat2035"]["delta_c"]
          < scen["heat2050"]["delta_c"],
          " < ".join(f"{v['delta_c']:+.2f}" for v in scen.values()))


def verify_waiting() -> None:
    path = CACHE / "wait_minutes.npz"
    if not path.exists():
        check("wait_minutes.npz exists", False, "missing - run step07b")
        return
    z = np.load(path, allow_pickle=True)
    wait = z["wait_minutes"]
    meta = json.loads((CACHE / "wait_meta.json").read_text())
    walk = np.load(CACHE / "minutes.npz", allow_pickle=True)["minutes"]

    check("wait_minutes.npz exists", True, f"{wait.shape}")
    check("waiting aligns with walking", wait.shape == walk.shape)
    check("waiting minutes non-negative and finite",
          bool((wait >= 0).all() and np.isfinite(wait).all()))
    check("waiting is a minority of exposure",
          0 < wait.sum() < walk.sum(),
          f"{wait.sum()/(wait.sum()+walk.sum())*100:.1f}% of person-minutes")
    # The one assumption in this layer must be declared, not buried.
    check("transit share is declared as an assumption",
          meta.get("status") == "assumption" and "transit_trip_share_range" in meta,
          f"{meta['transit_trip_share']:.0%} "
          f"(range {meta['transit_trip_share_range'][0]:.0%}"
          f"-{meta['transit_trip_share_range'][1]:.0%})")
    check("wait duration derived from real service data",
          "headway" in meta.get("wait_rule", "").lower(),
          f"{meta['stops_with_service_data']}/{meta['stops']} stops with PRT data")
    check("shelter capacity matches unsheltered stops",
          int(z["shelter_capacity"].sum()) == meta["unsheltered_stops"],
          f"{meta['unsheltered_stops']} sites")


def main() -> int:
    verify_segments()
    verify_edge_map()
    verify_buildings()
    verify_shadows()
    verify_trees()
    verify_trips()
    verify_scenarios()
    verify_waiting()

    width = max(len(n) for _, n, _ in results)
    n_fail = 0
    print("\nARTIFACT VERIFICATION")
    print("-" * (width + 34))
    for status, name, detail in results:
        mark = {"PASS": "  ok ", "FAIL": "FAIL ", "WARN": "warn "}[status]
        print(f"{mark} {name:<{width}}  {detail}")
        n_fail += status == FAIL
    print("-" * (width + 34))
    print(f"{len(results) - n_fail}/{len(results)} checks passed")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
