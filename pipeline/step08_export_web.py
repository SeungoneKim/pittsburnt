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
import pandas as pd

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent / "api"))

from config import (BBOX, CACHE, CENTER, CORRIDORS, CRS_METRIC,  # noqa: E402
                    CRS_WGS84, HOURS, PERSONAS, ROOT)
from engine import Adapter, Engine  # noqa: E402

OUT = ROOT / "web" / "public" / "data"
# Budgets the UI offers as presets; arbitrary amounts need the live API.
FALLBACK_BUDGETS = [50_000, 100_000, 250_000, 500_000, 1_000_000]

# Which intervention types the optimiser may spend on. The brief's ADAPT row
# says "add or optimize Trees / Shade structures / Cooling stations", so the
# choice belongs to the user. Trees dominate on exposure-per-dollar for
# people who are *walking*, so without this the other two are never bought
# and the demo could never show them at all.
# The UI's ADAPT choice is the allocation policy, not a subset of
# intervention types, so that is what the offline bundle caches.
POLICIES = ["balanced_protection", "pure_efficiency"]
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


def impact_scopes(e, props, before, after) -> list[dict]:
    """Corridor and whole-network impact, side by side.

    The spec forbids a bare network percentage: a large local improvement and
    a small city-wide one are different claims.
    """
    seg_len = np.array([props[s]["length_m"] for s in e.seg_ids])
    corr = np.array([props[s].get("corridor") for s in e.seg_ids])
    hero = np.isin(corr, CORRIDORS)

    def scope(mask, label):
        use_sev = float(before.severe_minutes[mask].sum()) > 0
        b = float((before.severe_minutes if use_sev else before.heat_load)[mask].sum())
        a = float((after.severe_minutes if use_sev else after.heat_load)[mask].sum())
        return {"label": label,
                "length_km": round(float(seg_len[mask].sum()) / 1000, 2),
                "segments": int(mask.sum()),
                "before_metric": round(b, 2), "after_metric": round(a, 2),
                "reduction_pct": round(100.0 * (b - a) / b, 2) if b else 0.0,
                "metric": "severe_person_minutes" if use_sev else "heat_load"}

    return [scope(hero, "Forbes / Fifth / Craig corridors"),
            scope(np.ones(len(e.seg_ids), dtype=bool), "Whole modelled network")]


def _height_sources() -> dict:
    """Provenance labels keyed by source, shipped once instead of per record."""
    import geopandas as _gpd
    b = _gpd.read_file(CACHE / "buildings.geojson")
    cols = ["height_source_label", "height_source_url", "conversion_rule",
            "confidence", "height_notes", "assumed_floor_height_m"]
    out = {}
    for src, grp in b.groupby("height_source"):
        row = grp.iloc[0]
        rec = {c: (None if pd.isna(row[c]) else row[c]) for c in cols}
        rec["count"] = int(len(grp))
        rec["area_share_pct"] = round(
            float(grp.area_m2.sum()) / float(b.area_m2.sum()) * 100, 1)
        out[str(src)] = rec
    return out


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

    for name, src, simp in [("trips", "trips.geojson", 0.0),
                            ("trees", "trees.geojson", 0.0),
                            ("buildings", "buildings.geojson", 0.00003)]:
        path = CACHE / src
        if not path.exists():
            continue
        g = gpd.read_file(path)
        if name == "buildings":
            # Provenance labels are identical for every record of a given
            # source, so ship them once in meta and keep only the keys here.
            g = g[["bldg_id", "bldg_name", "building", "area_m2", "height_m",
                   "height_source", "confidence", "height_is_measured",
                   "geometry"]]
        # Trip routes are deliberately NOT simplified: each carries one sun
        # value per vertex, and dropping vertices would silently misalign the
        # agent colours from the geometry they are meant to describe.
        if simp:
            g["geometry"] = g.geometry.simplify(simp)
        if "sun" in g.columns:
            g["sun"] = g["sun"].map(
                lambda v: v if isinstance(v, str) else json.dumps(list(v)))
        # GeoJSON round-trips dates back as Timestamps, which json cannot
        # encode; keep them as the ISO strings they were written as.
        for col in g.columns:
            if pd.api.types.is_datetime64_any_dtype(g[col]):
                g[col] = g[col].dt.date.astype(str)
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
        # Display uses the padded context raster, so the layer does not end in
        # a hard rectangle that makes leafy neighbouring areas look bare.
        # The simulation still reads the narrow 1 m mask and is unaffected.
        mask, geo = canopy_mod.build_context_mask()
        sim_mask, _ = canopy_mod.build_mask()
        rgba = np.zeros((*mask.shape, 4), dtype=np.uint8)
        rgba[mask] = (31, 122, 62, 195)
        img = Image.fromarray(np.flipud(rgba))
        img.thumbnail((2200, 2200))
        img.save(OUT / "canopy.png", optimize=True)

        minx, miny, px = geo
        maxx = minx + mask.shape[1] * px
        maxy = miny + mask.shape[0] * px
        w, s_, e_, n_ = gpd.GeoSeries([_box(minx, miny, maxx, maxy)], crs=CRS_METRIC) \
            .to_crs(CRS_WGS84).iloc[0].bounds
        canopy_meta = {
            "bounds": [[w, n_], [e_, n_], [e_, s_], [w, s_]],
            "cover_pct": round(float(sim_mask.mean()) * 100, 1),
            "context_cover_pct": round(float(mask.mean()) * 100, 1),
            "source": canopy_mod.CANOPY_SOURCE,
            "vintage": canopy_mod.CANOPY_VINTAGE,
        }
        print(f"  canopy overlay: {mask.shape[1]}x{mask.shape[0]} px @ "
              f"{px:.0f} m (display), {canopy_meta['cover_pct']}% cover in the "
              f"study area")
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

    from engine import HEAT_LOAD_BASE_C, INTERVENTIONS, SEVERE_UTCI_C
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
                    "input_hash": r.input_hash,
                    "snapshot_id": r.snapshot_id,
                    "status": r.status,
                    "severe_total": round(r.severe_total, 2),
                    "walking_severe_total": round(r.walking_severe_total, 2),
                    "waiting_severe_total": round(r.waiting_severe_total, 2),
                    "heat_load_total": round(r.heat_load_total, 2),
                    "weighted_severe_total": round(r.weighted_severe_total, 2),
                    "planning_weight": r.planning_weight,
                    "utci_sun_c": r.utci_sun_c,
                    "utci_shade_c": r.utci_shade_c,
                    "conditions": r.meta,
                    "severe_minutes": [round(float(x), 3) for x in r.severe_minutes],
                    "heat_load": [round(float(x), 2) for x in r.heat_load],
                    "minutes": [round(float(x), 3) for x in r.minutes],
                    "day_profile": e.day_profile(sc, persona),
                    "baseline_state": e.baseline_state(hour, persona),
                }
    print(f"  precomputed {len(crash)} crash tests "
          f"({len(scenarios)} scenarios x {len(HOURS)} hours x {len(e.personas)} personas)")

    for sc in scenarios:
        for hour in HOURS:
            for persona in e.personas:
                for budget in FALLBACK_BUDGETS:
                  for pol in POLICIES:
                    out = adapter.optimize(sc, hour, persona, budget, None, pol)
                    use_sev = out["before"].severe_total > 0
                    before = (out["before"].severe_minutes if use_sev
                              else out["before"].heat_load)
                    after = (out["after"].severe_minutes if use_sev
                             else out["after"].heat_load)
                    # An intervention only ever touches a few dozen segments,
                    # so ship the diff rather than a full 2,409-value array -
                    # the difference between an 8 MB bundle and a 100 KB one.
                    moved = np.nonzero(np.abs(after - before) > 1e-6)[0]
                    adapts[f"{sc}|{hour}|{persona}|{budget}|{pol}"] = {
                        "input_hash": out["input_hash"],
                        "snapshot_id": out["snapshot_id"],
                        "status": out["status"],
                        "spent_usd": out["spent_usd"],
                        "counts": out["counts"],
                        "metric_used": out["metric_used"],
                        "before_severe": round(out["before"].severe_total, 2),
                        "after_severe": round(out["after"].severe_total, 2),
                        "before_walking_severe": round(out["before"].walking_severe_total, 2),
                        "after_walking_severe": round(out["after"].walking_severe_total, 2),
                        "before_waiting_severe": round(out["before"].waiting_severe_total, 2),
                        "after_waiting_severe": round(out["after"].waiting_severe_total, 2),
                        "before_heat_load": round(out["before"].heat_load_total, 2),
                        "after_heat_load": round(out["after"].heat_load_total, 2),
                        "reduction_pct": round(out["reduction_pct"], 2),
                        "impact_scopes": impact_scopes(e, props, out["before"],
                                                       out["after"]),
                        "policy": out["policy"],
                        "policy_label": out["policy_label"],
                        "service_floor": out["service_floor"],
                        # An intervention touches a few dozen segments out of
                        # 2,409, so the after-state ships as a diff. Storing
                        # it in full made the bundle 69 MB.
                        "after_sun_diff": [
                            [int(i), round(float(out["after_sun"][i]), 4)]
                            for i in np.nonzero(
                                np.abs(out["after_sun"]
                                       - e.sun_exposure[:, e.hour_index(hour)])
                                > 1e-6)[0]],
                        "after_utci_diff": [
                            [int(i), round(float(out["after_utci_c"][i]), 2)]
                            for i in np.nonzero(
                                np.abs(out["after_sun"]
                                       - e.sun_exposure[:, e.hour_index(hour)])
                                > 1e-6)[0]],
                        # Placements as tuples, not objects: 900 cached runs
                        # x ~200 units makes key repetition the dominant cost.
                        "units": [[kinds.index(u["kind"]),
                                   round(u["lon"], 5), round(u["lat"], 5),
                                   0 if u["phase"] == "service_floor" else 1]
                                  for u in out["unit_placements"]],
                        "rank_trace": out["rank_trace"],
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
          f"({len(FALLBACK_BUDGETS)} budgets x {len(POLICIES)} policies)")

    (OUT / "crash_tests.json").write_text(json.dumps(
        {"sun_by_hour": sun_by_hour, "results": crash}, separators=(",", ":")))
    (OUT / "adapts.json").write_text(json.dumps(
        {"kinds": kinds, "policies": POLICIES,
         "unitFields": ["kind", "lon", "lat", "phase"],
         "results": adapts},
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
        "policies": POLICIES,
        "severe_threshold_utci_c": SEVERE_UTCI_C,
        "heat_load_base_utci_c": HEAT_LOAD_BASE_C,
        "hero_corridors": CORRIDORS,
        "waiting_exposure": json.loads((CACHE / "wait_meta.json").read_text())
                            if (CACHE / "wait_meta.json").exists() else None,
        # One entry per height source, so each building only carries its key.
        "height_sources": _height_sources(),
        "dataset_version": e.dataset_version,
        "value_meta": e.value_meta,
        "personas": [{"key": p["persona"], "label": p["label"],
                      "speed_mps": p["speed_mps"],
                      "planning_weight": p["planning_weight"],
                      "trips": p["trips"],
                      "derived": bool(p.get("derived")),
                      "composition": p.get("composition"),
                      "composition_note": p.get("composition_note")}
                     for p in e.trip_meta["personas"]],
        "scenarios": [{
            "key": k, "label": v["label"], "delta_c": v["delta_c"],
            "is_extrapolated": v["is_extrapolated"],
            "crossing_hours": sorted(int(hr) for hr, h in v["hours"].items()
                                     if h["utci_sun_c"] >= SEVERE_UTCI_C),
            "peak_utci_c": round(max(h["utci_sun_c"] for h in v["hours"].values()), 1),
        } for k, v in e.scenarios["scenarios"].items()],
        "climate_method": e.scenarios["method"],
        "canopy": canopy_meta,
        # The square the model actually runs in. Drawn on the map so a viewer
        # can tell the difference between "no exposure here" and "not modelled
        # here" - a distinction the canopy layer alone cannot make.
        "scope": {"west": BBOX["west"], "south": BBOX["south"],
                  "east": BBOX["east"], "north": BBOX["north"]},
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
