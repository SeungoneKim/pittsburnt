"""Value provenance and the snapshot input-hash contract.

Two ideas from the revision spec, both aimed at the same thing: a number on
screen should be traceable to where it came from, and a cached answer should
be provably an answer to the question actually asked.

ValueMeta says what kind of number this is:

    source      loaded directly from a named dataset or record
    computed    derived by a versioned function from source or assumption
    assumption  a planning input with no authoritative local calibration
    missing     required value absent, or the snapshot failed validation

input_hash is a fingerprint of everything that can change a result. The
runtime rule is that a cache may only be served when its input_hash equals
the hash of the current request - so the $250K plan can never be shown for a
$137,500 budget, and that rule is checkable rather than merely intended.

The hash uses FNV-1a rather than a cryptographic digest: it is a cache-key
equality check, not a security boundary, and it is trivial to reimplement
identically in the browser so both sides can agree without a shared runtime.
"""
from __future__ import annotations

import json
from typing import Any, Literal

Status = Literal["source", "computed", "assumption", "missing"]
Confidence = Literal["high", "medium", "low"]


def value_meta(status: Status, source_label: str, *,
               source_url: str | None = None, method: str | None = None,
               confidence: Confidence = "medium") -> dict:
    return {"status": status, "sourceLabel": source_label,
            "sourceUrl": source_url, "method": method,
            "confidence": confidence}


def fnv1a(text: str) -> str:
    """32-bit FNV-1a, as lowercase hex. Must match the TypeScript twin."""
    h = 0x811C9DC5
    for ch in text.encode("utf-8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def canonical(parts: dict[str, Any]) -> str:
    """Stable string for hashing: sorted keys, no whitespace, lists ordered."""
    def norm(v):
        if isinstance(v, (list, tuple)):
            return [norm(x) for x in sorted(v, key=str)]
        if isinstance(v, float):
            # Avoid 250000.0 vs 250000 hashing differently across languages.
            return int(v) if v == int(v) else round(v, 6)
        return v
    return json.dumps({k: norm(parts[k]) for k in sorted(parts)},
                      separators=(",", ":"), sort_keys=True)


def input_hash(*, dataset_version: str, scenario: str, hour: int,
               persona: str, budget_usd: float | None = None,
               kinds: list[str] | None = None) -> str:
    """Fingerprint of every input that can change a result."""
    return fnv1a(canonical({
        "dataset": dataset_version,
        "scenario": scenario,
        "hour": int(hour),
        "persona": persona,
        # A crash test has no budget; keep the field present so the two
        # request shapes can never collide on the same hash.
        "budget": None if budget_usd is None else int(round(budget_usd)),
        "kinds": kinds if kinds else ["*"],
    }))


def snapshot_id(ihash: str, kind: str) -> str:
    return f"{kind}-{ihash}"


# --- the value catalogue ---------------------------------------------------

def build_catalogue(engine) -> dict:
    """ValueMeta for every quantity the UI puts on screen."""
    method = engine.scenarios["method"]
    wait = getattr(engine, "wait_meta", {}) or {}
    return {
        "air_temp_c": value_meta(
            "source", "Observed hourly weather, hottest 5% of summer days",
            source_url="https://open-meteo.com/en/docs/historical-weather-api",
            method=method.get("baseline"), confidence="high"),
        "rh_pct": value_meta(
            "source", "Observed hourly relative humidity",
            source_url="https://open-meteo.com/en/docs/historical-weather-api",
            confidence="high"),
        "wind_ms": value_meta(
            "source", "Observed 10 m wind speed",
            source_url="https://open-meteo.com/en/docs/historical-weather-api",
            confidence="high"),
        "scenario_delta_c": value_meta(
            "source", "CMIP6-LOCA2 county percentile summaries (27 models)",
            source_url="https://www.sciencebase.gov/catalog/item/68409857d4be022b9cea5dbe",
            method=method.get("projection_source"), confidence="high"),
        "tmrt_c": value_meta(
            "computed", "Mean radiant temperature from shortwave components",
            method=method.get("mean_radiant_temperature"), confidence="medium"),
        "longwave": value_meta(
            "assumption", "Clear-sky downward longwave, Prata (1996)",
            method=method.get("longwave_assumption"), confidence="medium"),
        "utci_c": value_meta(
            "computed", "UTCI via thermofeel (ECMWF)",
            source_url="https://www.utci.org/", method=method.get("thermal_index"),
            confidence="high"),
        "severe_person_minutes": value_meta(
            "computed", "Person-minutes at or above UTCI 38 C",
            method=method.get("severe_threshold"), confidence="medium"),
        "sun_exposure": value_meta(
            "computed", "Building shadow geometry and 2010 canopy raster",
            method="shadow length = height / tan(solar altitude); "
                   "canopy sampled at 1 m", confidence="medium"),
        "walking_minutes": value_meta(
            "assumption", "Synthetic trips from a fixed seed",
            method=f"seed {engine.trip_meta.get('seed')}; origins residential, "
                   f"destinations weighted by footprint", confidence="low"),
        "walking_speed": value_meta(
            "assumption", "Planning walking speeds by persona",
            confidence="medium"),
        "waiting_minutes": value_meta(
            "assumption", wait.get("basis", "Transit trip share"),
            method=wait.get("wait_rule"), confidence="low"),
        "wait_duration": value_meta(
            "computed", wait.get("wait_source", "PRT service frequency"),
            method=wait.get("wait_rule"), confidence="medium"),
        "planning_weight": value_meta(
            "assumption", "City planning priority, not a risk coefficient",
            method="Reported beside the primary metric, never folded into it",
            confidence="low"),
        "intervention_cost": value_meta(
            "assumption", "Planning-order-of-magnitude unit costs",
            method="Comparable bids as proxies, not Pittsburgh quotes",
            confidence="low"),
        "building_height": value_meta(
            "computed", "Tiered height ladder with per-record provenance",
            method="OSM 3D part / height / levels, county STORIES, else "
                   "modelled by type and footprint size", confidence="medium"),
    }
