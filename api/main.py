"""FastAPI service for the Pittsburnt crash test.

Every expensive thing - the walking graph, shadow geometry, canopy sampling,
trip routing - happened offline. This service only does array arithmetic over
the cached artifacts, so a crash test and an optimiser run both return in
milliseconds and nothing here can be broken by a network call during a demo.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from engine import FULL_SUN_BONUS_C, INTERVENTIONS, Adapter, Engine

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"

app = FastAPI(title="Pittsburnt", version="0.1.0",
              description="A crash test for cities - pedestrian heat exposure")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

engine = Engine(CACHE)
_seg_props = {f["properties"]["seg_id"]: f["properties"]
              for f in json.loads((CACHE / "segments.geojson").read_text())["features"]}
_lengths = np.array([_seg_props[s]["length_m"] for s in engine.seg_ids])
adapter = Adapter(engine, _lengths)

DISCLAIMER = (
    "This is not a medical forecast. Pittsburnt reports a modelled Heat "
    "Exposure Score in At-risk Pedestrian Minutes, using published climate "
    "and city data to compare the same city before and after an intervention. "
    "It does not predict any individual's health outcome."
)


class CrashTestRequest(BaseModel):
    scenario: str = Field("heat2035", examples=["today", "heat2035", "heat2050"])
    hour: int = Field(15, examples=[8, 12, 15, 18])
    persona: str = Field("older_adults")


class AdaptRequest(CrashTestRequest):
    budget_usd: float = Field(250000, gt=0)
    kinds: list[str] | None = None


def _segments_payload(res, top: int) -> dict:
    order = np.argsort(-res.exposure)
    rank = np.empty(len(order), dtype=int)
    rank[order] = np.arange(len(order))
    peak = float(res.exposure.max()) or 1.0
    return {
        "segments": [{
            "seg_id": sid,
            "corridor": _seg_props[sid].get("corridor"),
            "exposure": round(float(res.exposure[i]), 4),
            "exposure_unweighted": round(float(res.exposure_unweighted[i]), 4),
            # Normalised for colouring: low -> elevated -> high -> hotspot.
            "intensity": round(float(res.exposure[i] / peak), 4),
            "sun_exposure": round(float(res.sun[i]), 4),
            "minutes": round(float(res.minutes[i]), 3),
            "rank": int(rank[i]),
        } for i, sid in enumerate(res.seg_ids)],
        "hotspots": engine.hotspots(res, top),
    }


@app.get("/health")
def health() -> dict:
    return {"ok": True, "segments": len(engine.seg_ids)}


@app.get("/meta")
def meta() -> dict:
    """Everything the assumptions panel needs to disclose."""
    sun = np.load(CACHE / "sun_exposure.npz", allow_pickle=True)
    return {
        "disclaimer": DISCLAIMER,
        "metric": "At-risk Pedestrian Minutes (modelled Heat Exposure Score)",
        "hours": engine.hours,
        "personas": [{"key": p["persona"], "label": p["label"],
                      "speed_mps": p["speed_mps"],
                      "planning_weight": p["planning_weight"],
                      "trips": p["trips"]} for p in engine.trip_meta["personas"]],
        "planning_weight_note": (
            "Planning weight is a city priority for who a heat plan should "
            "protect first. It is not a physiological risk coefficient, and "
            "unweighted exposure is reported alongside every weighted figure."),
        "scenarios": [{"key": k, "label": v["label"], "delta_c": v["delta_c"],
                       "is_extrapolated": v["is_extrapolated"]}
                      for k, v in engine.scenarios["scenarios"].items()],
        "climate_method": engine.scenarios["method"],
        "interventions": INTERVENTIONS,
        "full_sun_bonus_c": FULL_SUN_BONUS_C,
        "data_sources": {
            "street_network": "OpenStreetMap walking network via OSMnx",
            "buildings": "OpenStreetMap footprints; heights from OSM 3D "
                         "building:part, height and levels tags, Allegheny "
                         "County assessment STORIES, else modelled by type and size",
            "canopy": str(sun["canopy_source"]),
            "canopy_vintage": str(sun["canopy_vintage"]),
            "trees": "City of Pittsburgh street tree inventory (crown dimensions)",
            "solar": "pvlib solar position",
        },
        "trip_seed": engine.trip_meta["seed"],
    }


@app.get("/geometry/segments")
def geometry_segments() -> dict:
    """Segment centrelines. Static for the life of a build, so cache hard."""
    return json.loads((CACHE / "segments.geojson").read_text())


@app.get("/geometry/{layer}")
def geometry_layer(layer: str, hour: int | None = None) -> dict:
    """Baseline context layers: buildings, trees, trips, corridors, shadows."""
    names = {"buildings": "buildings.geojson", "trees": "trees.geojson",
             "trips": "trips.geojson", "corridors": "corridors.geojson"}
    if layer == "shadow":
        if hour not in engine.hours:
            raise HTTPException(400, f"hour must be one of {engine.hours}")
        path = CACHE / f"shadow_{hour:02d}.geojson"
    elif layer in names:
        path = CACHE / names[layer]
    else:
        raise HTTPException(404, f"unknown layer '{layer}'")
    if not path.exists():
        raise HTTPException(404, f"{path.name} not built")
    return json.loads(path.read_text())


@app.post("/crash-test")
def crash_test(req: CrashTestRequest) -> dict:
    try:
        res = engine.crash_test(req.scenario, req.hour, req.persona)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {
        "request": req.model_dump(),
        "heat_index_c": engine.heat_index_c(req.scenario, req.hour),
        "total_exposure": round(res.total, 2),
        "total_exposure_unweighted": round(res.total_unweighted, 2),
        **_segments_payload(res, 20),
        "disclaimer": DISCLAIMER,
    }


@app.post("/adapt")
def adapt(req: AdaptRequest) -> dict:
    """Spend a budget, then re-run the identical scenario and compare."""
    try:
        out = adapter.optimize(req.scenario, req.hour, req.persona,
                               req.budget_usd, req.kinds)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    before, after = out["before"], out["after"]
    changed = [{"seg_id": engine.seg_ids[i],
                "sun_reduction": round(float(out["sun_delta"][i]), 4)}
               for i in np.nonzero(out["sun_delta"] > 1e-6)[0]]
    return {
        "request": req.model_dump(),
        "budget_usd": out["budget_usd"], "spent_usd": out["spent_usd"],
        "counts": out["counts"],
        "before_total": round(before.total, 2),
        "after_total": round(after.total, 2),
        "reduction_pct": round(out["reduction_pct"], 2),
        "placements": out["placements"],
        "changed_segments": changed,
        **_segments_payload(after, 20),
        "disclaimer": DISCLAIMER,
    }
