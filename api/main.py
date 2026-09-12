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

from engine import (HEAT_LOAD_BASE_C, INTERVENTIONS, SEVERE_UTCI_C, Adapter,
                    Engine)

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

HERO_CORRIDORS = ["Forbes Avenue", "Fifth Avenue", "South Craig Street"]

DISCLAIMER = (
    "This is not a medical forecast. Pittsburnt reports modelled thermal "
    "stress using UTCI, the Universal Thermal Climate Index, and counts "
    "person-minutes spent at or above the published 'Very Strong Heat Stress' "
    "class (UTCI 38 C). That is a thermal-stress category, not a diagnosis "
    "and not a heatstroke probability. It compares the same simulated people "
    "over the same geometry before and after an intervention."
)


class CrashTestRequest(BaseModel):
    scenario: str = Field("heat2035", examples=["baseline", "heat2035", "heat2050"])
    hour: int = Field(15, examples=[8, 12, 15, 18])
    persona: str = Field("older_adults")


class AdaptRequest(CrashTestRequest):
    budget_usd: float = Field(250000, gt=0)
    kinds: list[str] | None = None
    policy: str = Field("balanced_protection",
                        examples=["balanced_protection", "pure_efficiency"])


def _segments_payload(res, top: int) -> dict:
    # Human-exposure rank is deliberately separate from the thermal colour:
    # the hottest street is not necessarily where people accumulate the most
    # severe minutes, and a percentile must never redefine a stress class.
    rank_by = res.severe_minutes if res.severe_total > 0 else res.heat_load
    order = np.argsort(-rank_by)
    rank = np.empty(len(order), dtype=int)
    rank[order] = np.arange(len(order))
    return {
        "segments": [{
            "seg_id": sid,
            "corridor": _seg_props[sid].get("corridor"),
            "utci_c": round(float(res.utci_c[i]), 2),
            "severe_minutes": round(float(res.severe_minutes[i]), 4),
            "heat_load": round(float(res.heat_load[i]), 3),
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
        "metric": ("Severe Heat Exposure Minutes - person-minutes at or above "
                   "UTCI 38 C (Very Strong Heat Stress)"),
        "secondary_metric": ("Heat load - cumulative person-minutes weighted by "
                             "UTCI above 26 C"),
        "hours": engine.hours,
        "personas": [{"key": p["persona"], "label": p["label"],
                      "speed_mps": p["speed_mps"],
                      "planning_weight": p["planning_weight"],
                      "trips": p["trips"],
                      "derived": bool(p.get("derived")),
                      "composition": p.get("composition"),
                      "composition_note": p.get("composition_note")}
                     for p in engine.trip_meta["personas"]],
        "planning_weight_note": (
            "Planning weight is a city priority for who a heat plan should "
            "protect first. It is not a physiological risk coefficient, and "
            "unweighted exposure is reported alongside every weighted figure."),
        # Whether an hour crosses the severe threshold depends on the
        # scenario and the hour only, not on who is walking - so the climate
        # story can be shown before anything is run.
        "scenarios": [{
            "key": k, "label": v["label"], "delta_c": v["delta_c"],
            "is_extrapolated": v["is_extrapolated"],
            "crossing_hours": sorted(int(hr) for hr, h in v["hours"].items()
                                     if h["utci_sun_c"] >= SEVERE_UTCI_C),
            "peak_utci_c": round(max(h["utci_sun_c"] for h in v["hours"].values()), 1),
        } for k, v in engine.scenarios["scenarios"].items()],
        "climate_method": engine.scenarios["method"],
        "interventions": INTERVENTIONS,
        "severe_threshold_utci_c": SEVERE_UTCI_C,
        "heat_load_base_utci_c": HEAT_LOAD_BASE_C,
        "data_sources": {
            "street_network": "OpenStreetMap walking network via OSMnx",
            "buildings": "OpenStreetMap footprints; heights from OSM 3D "
                         "building:part, height and levels tags, Allegheny "
                         "County assessment STORIES, else modelled by type and size",
            "canopy": str(sun["canopy_source"]),
            "canopy_vintage": str(sun["canopy_vintage"]),
            "trees": "City of Pittsburgh street tree inventory (crown dimensions)",
            "solar": "pvlib solar position",
            "thermal_index": "UTCI via thermofeel (ECMWF)",
        },
        "trip_seed": engine.trip_meta["seed"],
        "dataset_version": engine.dataset_version,
        "value_meta": engine.value_meta,
        "waiting_exposure": engine.wait_meta,
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
        "conditions": {**res.meta,
                       "utci_sun_c": res.utci_sun_c,
                       "utci_shade_c": res.utci_shade_c},
        "snapshot_id": res.snapshot_id,
        "input_hash": res.input_hash,
        "status": res.status,
        "severe_person_minutes": round(res.severe_total, 2),
        "walking_severe_person_minutes": round(res.walking_severe_total, 2),
        "waiting_severe_person_minutes": round(res.waiting_severe_total, 2),
        "heat_load": round(res.heat_load_total, 2),
        "weighted_severe_person_minutes": round(res.weighted_severe_total, 2),
        "planning_weight": res.planning_weight,
        "severe_threshold_utci_c": SEVERE_UTCI_C,
        "day_profile": engine.day_profile(req.scenario, req.persona),
        **_segments_payload(res, 20),
        "disclaimer": DISCLAIMER,
    }


@app.post("/adapt")
def adapt(req: AdaptRequest) -> dict:
    """Spend a budget, then re-run the identical scenario and compare."""
    try:
        out = adapter.optimize(req.scenario, req.hour, req.persona,
                               req.budget_usd, req.kinds, req.policy)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    before, after = out["before"], out["after"]
    scope = _impact_scopes(before, after)
    changed = [{"seg_id": engine.seg_ids[i],
                "sun_reduction": round(float(out["sun_delta"][i]), 4)}
               for i in np.nonzero(out["sun_delta"] > 1e-6)[0]]
    return {
        "request": req.model_dump(),
        "snapshot_id": out["snapshot_id"],
        "input_hash": out["input_hash"],
        "status": out["status"],
        "budget_usd": out["budget_usd"], "spent_usd": out["spent_usd"],
        "counts": out["counts"],
        "metric_used": out["metric_used"],
        "before_severe": round(before.severe_total, 2),
        "after_severe": round(after.severe_total, 2),
        "before_walking_severe": round(before.walking_severe_total, 2),
        "after_walking_severe": round(after.walking_severe_total, 2),
        "before_waiting_severe": round(before.waiting_severe_total, 2),
        "after_waiting_severe": round(after.waiting_severe_total, 2),
        "before_heat_load": round(before.heat_load_total, 2),
        "after_heat_load": round(after.heat_load_total, 2),
        "reduction_pct": round(out["reduction_pct"], 2),
        "impact_scopes": scope,
        "policy": out["policy"],
        "policy_label": out["policy_label"],
        "service_floor": out["service_floor"],
        # The engine owns the post-intervention environment; the UI renders
        # it rather than reconstructing it from a ratio of scores.
        "after_sun": [round(float(x), 4) for x in out["after_sun"]],
        "after_utci_c": [round(float(x), 2) for x in out["after_utci_c"]],
        "after_shelter_coverage": [round(float(x), 4)
                                   for x in out["after_shelter_coverage"]],
        "unit_placements": out["unit_placements"],
        "rank_trace": out["rank_trace"],
        "placements": out["placements"],
        "changed_segments": changed,
        **_segments_payload(after, 20),
        "claim_language": ("simulation-recommended allocation; greedy search, "
                           "not a proven global optimum"),
        "disclaimer": DISCLAIMER,
    }


def _impact_scopes(before, after) -> list[dict]:
    """Corridor and whole-network impact, side by side.

    The revision spec forbids showing a bare network percentage: a large
    local improvement and a small city-wide one are different claims, and
    reporting only one of them misleads in one direction or the other.
    """
    seg_len = np.array([_seg_props[s]["length_m"] for s in engine.seg_ids])
    corridors = np.array([_seg_props[s].get("corridor") for s in engine.seg_ids])
    hero = np.isin(corridors, HERO_CORRIDORS)

    def scope(mask, label):
        use_severe = float(before.severe_minutes[mask].sum()) > 0
        b = float((before.severe_minutes if use_severe else before.heat_load)[mask].sum())
        a = float((after.severe_minutes if use_severe else after.heat_load)[mask].sum())
        return {
            "label": label,
            "length_km": round(float(seg_len[mask].sum()) / 1000, 2),
            "segments": int(mask.sum()),
            "before_metric": round(b, 2),
            "after_metric": round(a, 2),
            "reduction_pct": round(100.0 * (b - a) / b, 2) if b else 0.0,
            "metric": "severe_person_minutes" if use_severe else "heat_load",
        }

    return [scope(hero, "Forbes / Fifth / Craig corridors"),
            scope(np.ones(len(engine.seg_ids), dtype=bool), "Whole modelled network")]
