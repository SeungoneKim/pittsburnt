"""Step 8 - static fallback bundle for the web app.

The brief's reliability rule: "If live APIs fail: all core demo data should
have a local cached GeoJSON/JSON fallback." So every answer the demo can ask
for is precomputed here and shipped as static files next to the frontend.

If the API is unreachable the UI switches to these and the whole
before -> adapt -> after loop still runs, just without arbitrary budgets.
There are only 3 scenarios x 4 hours x 5 personas = 60 crash tests, and a
handful of budgets, so precomputing all of them is cheap.
"""
from __future__ import annotations

import json
import sys

import geopandas as gpd
import numpy as np

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent / "api"))

from config import (CACHE, CENTER, CORRIDORS, CRS_METRIC, CRS_WGS84, HOURS,  # noqa: E402
                    PERSONAS, ROOT)
from engine import Adapter, Engine  # noqa: E402

OUT = ROOT / "web" / "public" / "data"
# Budgets the UI offers as presets; arbitrary amounts need the live API.
FALLBACK_BUDGETS = [50_000, 100_000, 250_000, 500_000, 1_000_000]

# Which intervention types the optimiser may spend on. The brief's ADAPT row
# says "add or optimize Trees / Shade structures / Cooling stations", so the
# choice belongs to the user. Trees dominate on exposure-per-dollar for
# people who are *walking*, so without this the other two are never bought
# and the demo could never show them at all.
VARIANTS: dict[str, list[str] | None] = {
    "all": None,
    "tree": ["tree"],
    "shade_structure": ["shade_structure"],
}
# Coordinate precision: ~1 m at this latitude, and it roughly halves the file.
COORD_DP = 5


def round_geojson(gj: dict, dp: int = COORD_DP) -> dict:
    def walk(c):
        if isinstance(c, (int, float)):
            return round(c, dp)
        return [walk(x) for x in c]
    for f in gj["features"]:
        f["geometry"]["coordinates"] = walk(f["geometry"]["coordinates"])
    return gj


def main() -> None:
    print("STEP 8  static fallback bundle for the web app")
    OUT.mkdir(parents=True, exist_ok=True)

    e = Engine(CACHE)
    props = {f["properties"]["seg_id"]: f["properties"]
             for f in json.loads((CACHE / "segments.geojson").read_text())["features"]}
    lengths = np.array([props[s]["length_m"] for s in e.seg_ids])
    adapter = Adapter(e, lengths)

    # --- geometry ---------------------------------------------------------
    seg = gpd.read_file(CACHE / "segments.geojson")
    seg["geometry"] = seg.geometry.simplify(0.00002)  # ~2 m
    seg_gj = round_geojson(json.loads(seg.to_json()))
    # The frontend joins scores to segments by array position, so the feature
    # order here must match the engine's segment order exactly.
    order = {sid: i for i, sid in enumerate(e.seg_ids)}
    seg_gj["features"].sort(key=lambda f: order[f["properties"]["seg_id"]])
    assert [f["properties"]["seg_id"] for f in seg_gj["features"]] == e.seg_ids
    (OUT / "segments.geojson").write_text(json.dumps(seg_gj, separators=(",", ":")))

    for name, src, simp in [("trips", "trips.geojson", 0.00002),
                            ("trees", "trees.geojson", 0.0),
                            ("buildings", "buildings.geojson", 0.00003)]:
        path = CACHE / src
        if not path.exists():
            continue
        g = gpd.read_file(path)
        if simp:
            g["geometry"] = g.geometry.simplify(simp)
        (OUT / f"{name}.geojson").write_text(
            json.dumps(round_geojson(json.loads(g.to_json())), separators=(",", ":")))

    # Canopy is a 1 m raster, so it ships as a PNG overlay with its corner
    # coordinates rather than as polygons. It is the dominant shade source at
    # the demo's hero hour, so the UI has to be able to show it.
    try:
        import base64  # noqa: F401
        import io as _io

        from PIL import Image
        from shapely.geometry import box as _box

        import canopy as canopy_mod
        mask, geo = canopy_mod.build_mask()
        rgba = np.zeros((*mask.shape, 4), dtype=np.uint8)
        rgba[mask] = (31, 122, 62, 205)
        img = Image.fromarray(np.flipud(rgba))
        img.thumbnail((2000, 2000))
        img.save(OUT / "canopy.png", optimize=True)

        minx, miny, px = geo
        maxx = minx + mask.shape[1] * px
        maxy = miny + mask.shape[0] * px
        w, s_, e_, n_ = gpd.GeoSeries([_box(minx, miny, maxx, maxy)], crs=CRS_METRIC) \
            .to_crs(CRS_WGS84).iloc[0].bounds
        canopy_meta = {
            "bounds": [[w, n_], [e_, n_], [e_, s_], [w, s_]],
            "cover_pct": round(float(mask.mean()) * 100, 1),
            "source": canopy_mod.CANOPY_SOURCE,
            "vintage": canopy_mod.CANOPY_VINTAGE,
        }
        print(f"  canopy overlay: {mask.shape[1]}x{mask.shape[0]} px, "
              f"{canopy_meta['cover_pct']}% cover")
    except Exception as exc:
        canopy_meta = None
        print(f"  canopy overlay skipped: {exc}")

    for h in HOURS:
        sp = CACHE / f"shadow_{h:02d}.geojson"
        if sp.exists():
            g = gpd.read_file(sp)
            g["geometry"] = g.geometry.simplify(0.00003)
            (OUT / f"shadow_{h:02d}.geojson").write_text(
                json.dumps(round_geojson(json.loads(g.to_json())), separators=(",", ":")))

    # --- precomputed results ---------------------------------------------
    from collections import Counter

    from engine import INTERVENTIONS
    kinds = list(INTERVENTIONS)
    scenarios = list(e.scenarios["scenarios"])
    crash, adapts = {}, {}
    # Sun exposure depends only on the hour, so store it once per hour rather
    # than repeating the same 2,409 values in all 15 combos that share it.
    sun_by_hour = {str(h): [round(float(x), 3)
                            for x in e.sun_exposure[:, e.hour_index(h)]]
                   for h in HOURS}
    for sc in scenarios:
        for hour in HOURS:
            for persona in e.personas:
                r = e.crash_test(sc, hour, persona)
                crash[f"{sc}|{hour}|{persona}"] = {
                    "total": round(r.total, 2),
                    "total_unweighted": round(r.total_unweighted, 2),
                    "heat_index_c": e.heat_index_c(sc, hour),
                    "exposure": [round(float(x), 2) for x in r.exposure],
                }
    print(f"  precomputed {len(crash)} crash tests "
          f"({len(scenarios)} scenarios x {len(HOURS)} hours x {len(e.personas)} personas)")

    for sc in scenarios:
        for hour in HOURS:
            for persona in e.personas:
                for budget in FALLBACK_BUDGETS:
                  for vname, kinds_sel in VARIANTS.items():
                    out = adapter.optimize(sc, hour, persona, budget, kinds_sel)
                    before, after = out["before"].exposure, out["after"].exposure
                    # An intervention only ever touches a few dozen segments,
                    # so ship the diff rather than a full 2,409-value array -
                    # the difference between an 8 MB bundle and a 100 KB one.
                    moved = np.nonzero(np.abs(after - before) > 1e-6)[0]
                    adapts[f"{sc}|{hour}|{persona}|{budget}|{vname}"] = {
                        "spent_usd": out["spent_usd"],
                        "counts": out["counts"],
                        "before_total": round(out["before"].total, 2),
                        "after_total": round(out["after"].total, 2),
                        "reduction_pct": round(out["reduction_pct"], 2),
                        "changed": [[int(i), round(float(after[i]), 2)] for i in moved],
                        # [segment index, kind index, how many] - a big budget
                        # puts many units on the same segment, so counting
                        # beats listing each unit separately.
                        "placements": [[order[sid], kinds.index(k), n]
                                       for (sid, k), n in
                                       Counter((p["seg_id"], p["kind"])
                                               for p in out["placements"]).items()],
                    }
    print(f"  precomputed {len(adapts)} adapt runs "
          f"({len(FALLBACK_BUDGETS)} budgets x {len(VARIANTS)} intervention sets)")

    (OUT / "crash_tests.json").write_text(json.dumps(
        {"sun_by_hour": sun_by_hour, "results": crash}, separators=(",", ":")))
    (OUT / "adapts.json").write_text(json.dumps(
        {"kinds": kinds, "variants": list(VARIANTS), "results": adapts},
        separators=(",", ":")))

    # --- meta -------------------------------------------------------------
    sun = np.load(CACHE / "sun_exposure.npz", allow_pickle=True)
    meta = {
        "center": {"lat": CENTER[0], "lon": CENTER[1]},
        "corridors": CORRIDORS,
        "hours": HOURS,
        "seg_ids": e.seg_ids,
        "budgets": FALLBACK_BUDGETS,
        "interventions": {k: {"label": v["label"], "cost_usd": v["cost_usd"],
                              "shade_m": v["shade_m"],
                              }
                          for k, v in INTERVENTIONS.items()},
        "variants": list(VARIANTS),
        "personas": [{"key": p["persona"], "label": p["label"],
                      "speed_mps": p["speed_mps"],
                      "planning_weight": p["planning_weight"],
                      "trips": p["trips"]} for p in e.trip_meta["personas"]],
        "scenarios": [{"key": k, "label": v["label"], "delta_c": v["delta_c"],
                       "is_extrapolated": v["is_extrapolated"]}
                      for k, v in e.scenarios["scenarios"].items()],
        "climate_method": e.scenarios["method"],
        "canopy": canopy_meta,
        "canopy_source": str(sun["canopy_source"]),
        "canopy_vintage": str(sun["canopy_vintage"]),
        "trip_seed": e.trip_meta["seed"],
    }
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

    total = sum(f.stat().st_size for f in OUT.glob("*"))
    print(f"  bundle: {len(list(OUT.glob('*')))} files, {total/1e6:.1f} MB")
    for f in sorted(OUT.glob("*"), key=lambda x: -x.stat().st_size):
        print(f"    {f.name:24} {f.stat().st_size/1e6:6.2f} MB")


if __name__ == "__main__":
    main()
