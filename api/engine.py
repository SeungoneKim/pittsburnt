"""The exposure engine: turn a scenario into a thermal-stress score per segment.

Thermal index is UTCI, the Universal Thermal Climate Index. The previous
model used the NWS Heat Index plus a flat "+8 C x sun exposure", which was an
assumption presented as physics: the Heat Index is defined in shade, and the
8 C was a constant chosen by hand.

Under UTCI, sun enters where it physically belongs. A pedestrian in shade
receives diffuse sky radiation; one in sun also receives the direct beam.
That difference drives mean radiant temperature, and UTCI follows from it.
Scenario files carry both ends - UTCI in full sun and in full shade, at each
hour - so the engine only has to mix them.

sun_exposure(segment, hour) is a *spatial fraction*: how much of that
segment's length is unshaded. So a pedestrian walking it spends that fraction
of their time in sun and the rest in shade, and their exposure is the sum of
the two. That is what makes shade act smoothly rather than as a switch.

Exposure has two parts. Walking time is spread along the network; waiting
time is concentrated at transit stops, where a person is standing still and
cannot leave. A model that scored only walking would always undervalue a
shelter, so both are counted and reported separately.

    total_severe = walking_severe + waiting_severe

A street tree shades the footway, and the stop beside it. A shaded shelter
covers waiting time only - which is why the two interventions compete on
different ground rather than one simply dominating.

Metrics, following the revision spec:

    severe_person_minutes  person-minutes at or above UTCI 38 C, the
                           published "Very Strong Heat Stress" class.
                           PRIMARY, and unweighted.
    heat_load              SUM(max(UTCI - 26, 0) x person_minutes), a
                           cumulative burden that also counts time below the
                           severe threshold.
    weighted_*             the same figures under city planning priority.
                           Reported alongside, never as the primary number.

Neither is a medical prediction. UTCI 38 C is a thermal-stress category.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import thermofeel as _tf

from provenance import (build_catalogue, canonical, fnv1a, input_hash,
                        snapshot_id)

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"

def _vapour_pressure_hpa(temp_c, rh_pct):
    t = np.asarray(temp_c, dtype=float)
    es = 6.112 * np.exp(17.67 * t / (t + 243.5))
    return es * np.asarray(rh_pct, dtype=float) / 100.0


def utci_from_tmrt(temp_c, rh_pct, wind_ms, tmrt_c):
    """UTCI in degrees C from the four inputs the index is defined on.

    The same wrapper as pipeline/utci.py, needed here because a measure that
    changes mean radiant temperature cannot be scored from the precomputed
    per-scenario constants - its whole effect is on Tmrt, which is upstream of
    them. A property test asserts this reproduces the cached scenario values,
    so the two implementations cannot drift apart silently.
    """
    t_k = np.asarray(temp_c, dtype=float) + 273.15
    # The polynomial is fitted for 0.5-17 m/s; clamp rather than extrapolate.
    va = np.clip(np.asarray(wind_ms, dtype=float), 0.5, 17.0)
    mrt_k = np.asarray(tmrt_c, dtype=float) + 273.15
    return np.asarray(_tf.calculate_utci(
        t2_k=t_k, va=va, mrt=mrt_k,
        ehPa=_vapour_pressure_hpa(temp_c, rh_pct)), dtype=float) - 273.15


SEVERE_UTCI_C = 38.0        # "Very Strong Heat Stress"
HEAT_LOAD_BASE_C = 26.0     # onset of "Moderate Heat Stress"

# Minimum spacing between two purchased street trees, in metres. The 2.6 spec
# asks for a candidate-site layer at 8-10 m rather than a per-segment unit
# count, so a segment's capacity is how many sites fit on it at this spacing
# and each purchased unit lands on one of them. 10 m is the upper end of the
# band: it exceeds the 8 m crown a mature tree casts, so two purchased crowns
# on the same street component never overlap and no person-minute is counted
# as protected twice.
SITE_SPACING_M = 10.0

# Local metre-per-degree scale at Oakland's latitude. Good to ~0.1% over a
# 3 km study square, and it keeps the placement geometry dependency-free.
_M_PER_DEG_LAT = 110_940.0
_M_PER_DEG_LON = 84_600.0   # 111,320 x cos(40.44 deg)


@dataclass
class Result:
    seg_ids: list[str]
    utci_c: np.ndarray            # effective UTCI per segment
    severe_minutes: np.ndarray    # walking + waiting, at or above 38 C
    heat_load: np.ndarray
    sun: np.ndarray
    minutes: np.ndarray           # walking person-minutes
    walking_severe: np.ndarray = field(default_factory=lambda: np.zeros(0))
    waiting_severe: np.ndarray = field(default_factory=lambda: np.zeros(0))
    walking_severe_total: float = 0.0
    waiting_severe_total: float = 0.0
    utci_sun_c: float = 0.0
    utci_shade_c: float = 0.0
    # Person-minute-weighted UTCI: what the modelled cohort actually felt,
    # not the full-sun anchor. Waiting minutes use the sheltered or
    # unsheltered value that rider actually stood in.
    experienced_utci_c: float = 0.0
    person_minutes_total: float = 0.0
    severe_total: float = 0.0
    heat_load_total: float = 0.0
    weighted_severe_total: float = 0.0
    planning_weight: float = 1.0
    meta: dict = field(default_factory=dict)
    # Snapshot identity. A result is only valid for the inputs that produced
    # it, and this is what lets a consumer prove that.
    input_hash: str = ""
    snapshot_id: str = ""
    status: str = "complete"


class Engine:
    """Holds the precomputed grids and scores scenarios against them."""

    def __init__(self, cache: Path = CACHE):
        self.cache = cache
        sun = np.load(cache / "sun_exposure.npz", allow_pickle=True)
        mins = np.load(cache / "minutes.npz", allow_pickle=True)

        self.seg_ids: list[str] = [str(s) for s in sun["seg_ids"]]
        self.hours: list[int] = [int(h) for h in sun["hours"]]
        self.personas: list[str] = [str(p) for p in mins["personas"]]

        self.sun_exposure = sun["sun_exposure"].astype(np.float32)
        self.shade_bldg = sun["shade_bldg"].astype(np.float32)
        self.shade_tree = sun["shade_tree"].astype(np.float32)
        self.minutes = mins["minutes"].astype(np.float32)

        # Waiting exposure at transit stops. Optional: without it the engine
        # scores walking only, which is what the previous version did.
        wait_path = cache / "wait_minutes.npz"
        if wait_path.exists():
            w = np.load(wait_path, allow_pickle=True)
            self.wait_minutes = w["wait_minutes"].astype(np.float32)
            self.shelter_coverage = w["shelter_coverage"].astype(np.float32)
            self.shelter_capacity = w["shelter_capacity"].astype(np.int32)
            self.wait_meta = json.loads((cache / "wait_meta.json").read_text())
        else:
            self.wait_minutes = np.zeros_like(self.minutes)
            self.shelter_coverage = np.zeros(len(self.seg_ids), dtype=np.float32)
            self.shelter_capacity = np.zeros(len(self.seg_ids), dtype=np.int32)
            self.wait_meta = {}

        if [str(s) for s in mins["seg_ids"]] != self.seg_ids:
            raise ValueError("minutes.npz and sun_exposure.npz disagree on segments")

        self.scenarios = json.loads((cache / "scenarios.json").read_text())
        self.trip_meta = json.loads((cache / "trips_meta.json").read_text())
        self.weights = {p["persona"]: float(p["planning_weight"])
                        for p in self.trip_meta["personas"]}
        self.index = {sid: i for i, sid in enumerate(self.seg_ids)}

        # Fingerprint of the artifacts themselves. If the pipeline is rebuilt
        # with different geometry, trips or climate, every cached answer from
        # the old build stops matching and is refused rather than reused.
        self.dataset_version = fnv1a(canonical({
            "segments": len(self.seg_ids),
            "hours": self.hours,
            "personas": self.personas,
            "seed": self.trip_meta.get("seed"),
            "deltas": [round(float(v["delta_c"]), 4)
                       for v in self.scenarios["scenarios"].values()],
            "sun": round(float(self.sun_exposure.sum()), 3),
            "minutes": round(float(self.minutes.sum()), 3),
            "wait": round(float(self.wait_minutes.sum()), 3),
        }))
        self.value_meta = build_catalogue(self)

        # Geometry needed to place a unit at a real point rather than merely
        # naming the segment it belongs to.
        segs = json.loads((cache / "segments.geojson").read_text())
        self.seg_coords: dict[str, list] = {}
        self.seg_corridor: dict[str, str | None] = {}
        for f in segs["features"]:
            sid = f["properties"]["seg_id"]
            self.seg_coords[sid] = f["geometry"]["coordinates"]
            self.seg_corridor[sid] = f["properties"].get("corridor")

        stops_path = cache / "bus_stops.geojson"
        self.stops: list[dict] = []
        if stops_path.exists():
            for f in json.loads(stops_path.read_text())["features"]:
                pr = f["properties"]
                self.stops.append({
                    "stop_name": pr.get("stop_name"),
                    "sheltered": bool(pr.get("sheltered")),
                    "trips_7d": pr.get("trips_7d"),
                    "seg_id": pr.get("seg_id"),
                    "lon": f["geometry"]["coordinates"][0],
                    "lat": f["geometry"]["coordinates"][1],
                })
        self.hero_corridors = ["Forbes Avenue", "Fifth Avenue",
                               "South Craig Street"]

    def input_hash(self, scenario: str, hour: int, persona: str,
                   budget_usd: float | None = None,
                   kinds: list[str] | None = None) -> str:
        return input_hash(dataset_version=self.dataset_version,
                          scenario=scenario, hour=hour, persona=persona,
                          budget_usd=budget_usd, kinds=kinds)

    # -- lookups ------------------------------------------------------------

    def hour_index(self, hour: int) -> int:
        if hour not in self.hours:
            raise ValueError(f"hour must be one of {self.hours}")
        return self.hours.index(hour)

    def persona_index(self, persona: str) -> int:
        if persona not in self.personas:
            raise ValueError(f"persona must be one of {self.personas}")
        return self.personas.index(persona)

    def conditions(self, scenario: str, hour: int) -> dict:
        sc = self.scenarios["scenarios"].get(scenario)
        if sc is None:
            raise ValueError(f"scenario must be one of "
                             f"{list(self.scenarios['scenarios'])}")
        row = sc["hours"].get(str(hour))
        if row is None:
            raise ValueError(f"hour must be one of {self.hours}")
        return row

    # -- the crash test -----------------------------------------------------

    def crash_test(self, scenario: str, hour: int, persona: str,
                   sun_delta: np.ndarray | None = None,
                   shelter_delta: np.ndarray | None = None,
                   tmrt_delta: np.ndarray | None = None) -> Result:
        """Score every segment under one scenario.

        sun_delta reduces the sun on the footway (trees). shelter_delta adds
        shelter coverage at transit stops, which protects waiting time only.
        Both are per-segment fractions in [0, 1]; None gives the baseline.

        tmrt_delta shifts mean radiant temperature per segment, in degrees C,
        and UTCI is recomputed from it. This is how a surface treatment is
        scored, and the sign is not assumed: a treatment that raises Tmrt
        raises UTCI, which is what the Phoenix cool-pavement measurements
        found at midday even though surface temperature fell.
        """
        hi = self.hour_index(hour)
        p_idx = self.persona_index(persona)
        cond = self.conditions(scenario, hour)
        ihash = self.input_hash(scenario, hour, persona)

        sun = self.sun_exposure[:, hi].astype(np.float64)
        if sun_delta is not None:
            sun = np.clip(sun - sun_delta, 0.0, 1.0)
        minutes = self.minutes[:, p_idx, hi].astype(np.float64)
        waiting = self.wait_minutes[:, p_idx, hi].astype(np.float64)

        cover = self.shelter_coverage.astype(np.float64)
        if shelter_delta is not None:
            cover = np.clip(cover + shelter_delta, 0.0, 1.0)
        # Sheltered waiting is in shade regardless of the sky; unsheltered
        # waiting sees whatever sun the surrounding footway sees.
        wait_sun = (1.0 - cover) * sun

        if tmrt_delta is None:
            u_sun = float(cond["utci_sun_c"])
            u_shade = float(cond["utci_shade_c"])
        else:
            # Per-segment now, because Tmrt is. Recomputed through the same
            # polynomial the pipeline used rather than nudged by a constant.
            u_sun = utci_from_tmrt(cond["air_temp_c"], cond["rh_pct"],
                                   cond["wind_ms"],
                                   float(cond["tmrt_sun_c"]) + tmrt_delta)
            u_shade = utci_from_tmrt(cond["air_temp_c"], cond["rh_pct"],
                                     cond["wind_ms"],
                                     float(cond["tmrt_shade_c"]) + tmrt_delta)
        sev_sun = (np.asarray(u_sun) >= SEVERE_UTCI_C).astype(float)
        sev_shade = (np.asarray(u_shade) >= SEVERE_UTCI_C).astype(float)
        load_sun = np.maximum(np.asarray(u_sun) - HEAT_LOAD_BASE_C, 0.0)
        load_shade = np.maximum(np.asarray(u_shade) - HEAT_LOAD_BASE_C, 0.0)

        # Time splits between sun and shade in proportion to the unshaded
        # fraction, so each part is scored on its own UTCI.
        walk_sev = minutes * sun * sev_sun + minutes * (1.0 - sun) * sev_shade
        wait_sev = (waiting * wait_sun * sev_sun
                    + waiting * (1.0 - wait_sun) * sev_shade)
        severe = walk_sev + wait_sev
        load = (minutes * sun * load_sun + minutes * (1.0 - sun) * load_shade
                + waiting * wait_sun * load_sun
                + waiting * (1.0 - wait_sun) * load_shade)

        # Effective UTCI for display and for the thermal colour threshold.
        utci = sun * u_sun + (1.0 - sun) * u_shade
        weight = self.weights.get(persona, 1.0)

        # Experienced UTCI. A person-minute-weighted average over walking and
        # waiting time - never an unweighted mean of street segments, which
        # would let 2,409 empty kerbs outvote the corridor everyone is on.
        person_minutes = float(minutes.sum() + waiting.sum())
        degree_minutes = float(
            (minutes * (sun * u_sun + (1.0 - sun) * u_shade)).sum()
            + (waiting * (wait_sun * u_sun + (1.0 - wait_sun) * u_shade)).sum())
        experienced = degree_minutes / person_minutes if person_minutes else u_shade

        return Result(
            seg_ids=self.seg_ids, utci_c=utci, severe_minutes=severe,
            heat_load=load, sun=sun, minutes=minutes,
            walking_severe=walk_sev, waiting_severe=wait_sev,
            walking_severe_total=float(walk_sev.sum()),
            waiting_severe_total=float(wait_sev.sum()),
            utci_sun_c=float(np.mean(u_sun)), utci_shade_c=float(np.mean(u_shade)),
            experienced_utci_c=experienced,
            person_minutes_total=person_minutes,
            severe_total=float(severe.sum()),
            heat_load_total=float(load.sum()),
            weighted_severe_total=float(severe.sum() * weight),
            planning_weight=weight,
            input_hash=ihash, snapshot_id=snapshot_id(ihash, "crash"),
            status="complete",
            meta={"air_temp_c": cond["air_temp_c"], "rh_pct": cond["rh_pct"],
                  "wind_ms": cond["wind_ms"],
                  "tmrt_sun_c": cond["tmrt_sun_c"],
                  "tmrt_shade_c": cond["tmrt_shade_c"],
                  "shade_relief_c": cond["shade_relief_c"]},
        )

    def baseline_state(self, hour: int, persona: str) -> dict:
        """The observed hot-day baseline at the same hour, for comparison.

        The spec forbids reading 2026 -> adjusted future as the effect of an
        intervention: that difference contains the warming too. So the
        baseline is carried alongside as context, and the intervention effect
        is only ever future-before -> future-after.
        """
        r = self.crash_test("baseline", hour, persona)
        return {
            "label": self.scenarios["scenarios"]["baseline"]["label"],
            "air_temp_c": r.meta["air_temp_c"],
            "utci_sun_c": r.utci_sun_c,
            "experienced_utci_c": round(r.experienced_utci_c, 2),
            "heat_load": round(r.heat_load_total, 2),
            "severe": round(r.severe_total, 2),
        }

    def day_profile(self, scenario: str, persona: str) -> list[dict]:
        """Severe minutes and peak UTCI across the whole day.

        Two thirds of scenario-hour combinations legitimately produce zero
        severe minutes, and a bare 0 reads as a broken product rather than as
        the finding it is. Showing the day's shape turns "nothing here" into
        "not yet, and here is when" - and it costs four array operations.
        """
        out = []
        for hour in self.hours:
            r = self.crash_test(scenario, hour, persona)
            out.append({
                "hour": hour,
                "severe": round(r.severe_total, 2),
                "heat_load": round(r.heat_load_total, 2),
                "utci_sun_c": r.utci_sun_c,
                "utci_shade_c": r.utci_shade_c,
                "crosses": r.utci_sun_c >= SEVERE_UTCI_C,
                # How far the hottest exposure sits from the threshold; the
                # sign is what makes a zero legible.
                "headroom_c": round(r.utci_sun_c - SEVERE_UTCI_C, 2),
            })
        return out

    def hotspots(self, res: Result, top: int = 20) -> list[dict]:
        """Ranked by human exposure, which is not the same as by temperature.

        The hottest street is not necessarily the one where people accumulate
        the most severe minutes; this ranks the latter, while the map colours
        the former.
        """
        rank_by = res.severe_minutes if res.severe_minutes.sum() > 0 else res.heat_load
        order = np.argsort(-rank_by)[:top]
        return [{"seg_id": res.seg_ids[i],
                 "severe_minutes": round(float(res.severe_minutes[i]), 3),
                 "heat_load": round(float(res.heat_load[i]), 2),
                 "utci_c": round(float(res.utci_c[i]), 2),
                 "sun_exposure": round(float(res.sun[i]), 3),
                 "minutes": round(float(res.minutes[i]), 2)} for i in order]


# --- interventions ---------------------------------------------------------

INTERVENTIONS = {
    "tree": {
        "label": "Street tree",
        "cost_usd": 1200,
        # A mature street tree casts roughly its crown diameter along the
        # footway; 4 m crown radius is the median mature crown in the City
        # inventory, so one tree covers about 8 m of pavement.
        "shade_m": 8.0,
        "block": 0.85,   # canopy transmits some direct beam
    },
    "shaded_shelter": {
        "label": "Shaded waiting shelter",
        # Pittsburgh DOMI's Transit Stop Improvement Program installs
        # shelters at high-ridership stops explicitly to give riders shade.
        # No per-shelter figure is published for that programme; this sits
        # inside the $9k-$30k industry range and is shown as an assumption,
        # not quoted as a procurement price.
        "cost_usd": 15000,
        "shade_m": 4.0,
        "block": 0.95,   # solid roof
        # A shelter protects waiting time, not the footway, and can only be
        # placed where a real unsheltered stop exists.
        "protects": "waiting",
        "site_constrained": True,
    },
}


class Adapter:
    """Places interventions and measures what they buy."""

    def _unit_points(self, log: list[dict]) -> list[dict]:
        """One record per purchased unit, on a real candidate site.

        A placement is a point on the ground, not a highlighted street. Trees
        take the next free site on their segment's candidate layer - sites are
        generated every SITE_SPACING_M metres along the centreline, so two
        trees on one street component are always at least that far apart and
        the row spreads across the segment instead of stacking on a pixel.
        A shelter takes the validated coordinate of the unsheltered stop it
        protects.

        The old rule placed unit n at the fraction (n + 0.5) / capacity, which
        made spacing depend on how many were bought rather than on the ground.
        """
        used: dict[str, int] = {}
        out: list[dict] = []
        for order, entry in enumerate(log):
            sid = entry["seg_id"]
            n = used.get(sid, 0)
            used[sid] = n + 1
            coords = self.e.seg_coords.get(sid) or []

            if entry["kind"] == "shaded_shelter":
                stop = next((s for s in self.e.stops
                             if s["seg_id"] == sid and not s["sheltered"]), None)
                if stop:
                    lon, lat = stop["lon"], stop["lat"]
                    stop_id = stop["stop_name"]
                    bearing = self._bearing_at(coords, self._length_m(coords) / 2)
                else:
                    lon, lat, bearing = self._along_m(
                        coords, self._length_m(coords) / 2)
                    stop_id = None
                site_id = f"{sid}-stop"
            else:
                # The nth site on this segment's candidate layer. Which
                # coordinate that is was decided once, by spacing on the
                # ground - not by how many units happened to be bought.
                sites = self.sites.get(sid) or []
                if n < len(sites):
                    lon, lat, bearing = sites[n]
                else:
                    lon, lat, bearing = self._along_m(
                        coords, self._length_m(coords) / 2)
                stop_id = None
                site_id = f"{sid}-s{n:02d}"

            out.append({
                "unitId": f"{entry['kind']}-{sid}-{n}",
                "siteId": site_id,
                "kind": entry["kind"], "segmentId": sid, "stopId": stop_id,
                "lon": round(lon, 6), "lat": round(lat, 6),
                "bearing_deg": round(bearing, 1),
                "costUsd": entry["cost_usd"], "order": order,
                "phase": entry.get("phase", "marginal"),
            })
        return out

    def shade_footprints(self, units: list[dict]) -> dict:
        """The ground each purchased unit actually shades.

        The map used to bloom a fixed circle, which is decoration. This is the
        modelled footprint: a tree shades SHADE_M of footway along the
        centreline across a crown's width; a shelter roof covers its stop.
        Both are returned by the engine so the UI never invents geometry.
        """
        feats = []
        for u in units:
            spec = self.interventions[u["kind"]]
            along = float(spec["shade_m"])
            across = 8.0 if u["kind"] == "tree" else 3.0
            feats.append({
                "type": "Feature",
                "properties": {"unitId": u["unitId"], "siteId": u["siteId"],
                               "kind": u["kind"], "order": u["order"],
                               "along_m": along, "across_m": across},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [self._rect(u["lon"], u["lat"],
                                               u["bearing_deg"], along, across)],
                },
            })
        return {"type": "FeatureCollection", "features": feats}

    @staticmethod
    def _rect(lon: float, lat: float, bearing_deg: float,
              along_m: float, across_m: float) -> list:
        """An oriented rectangle around a point, closed, in lon/lat."""
        import math
        th = math.radians(bearing_deg)
        ux, uy = math.cos(th), math.sin(th)          # along the street
        vx, vy = -uy, ux                             # across it
        a, b = along_m / 2.0, across_m / 2.0
        ring = []
        for sa, sb in ((1, 1), (1, -1), (-1, -1), (-1, 1), (1, 1)):
            dx = sa * a * ux + sb * b * vx
            dy = sa * a * uy + sb * b * vy
            ring.append([round(lon + dx / _M_PER_DEG_LON, 6),
                         round(lat + dy / _M_PER_DEG_LAT, 6)])
        return ring

    @staticmethod
    def _seg_lengths_m(coords: list) -> list[float]:
        out = []
        for i in range(1, len(coords)):
            dx = (coords[i][0] - coords[i - 1][0]) * _M_PER_DEG_LON
            dy = (coords[i][1] - coords[i - 1][1]) * _M_PER_DEG_LAT
            out.append((dx * dx + dy * dy) ** 0.5)
        return out

    @classmethod
    def _length_m(cls, coords: list) -> float:
        return sum(cls._seg_lengths_m(coords)) if len(coords) > 1 else 0.0

    @classmethod
    def _along_m(cls, coords: list, metres: float) -> tuple[float, float, float]:
        """Point `metres` along a LineString, plus the local bearing there."""
        import math
        if not coords:
            return (0.0, 0.0, 0.0)
        if len(coords) == 1:
            return (coords[0][0], coords[0][1], 0.0)
        segs = cls._seg_lengths_m(coords)
        acc = 0.0
        for i, d in enumerate(segs):
            if acc + d >= metres or i == len(segs) - 1:
                t = (metres - acc) / d if d else 0.0
                t = min(max(t, 0.0), 1.0)
                a, b = coords[i], coords[i + 1]
                dx = (b[0] - a[0]) * _M_PER_DEG_LON
                dy = (b[1] - a[1]) * _M_PER_DEG_LAT
                return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                        math.degrees(math.atan2(dy, dx)))
            acc += d
        return (coords[-1][0], coords[-1][1], 0.0)

    @classmethod
    def _bearing_at(cls, coords: list, metres: float) -> float:
        return cls._along_m(coords, metres)[2] if len(coords) > 1 else 0.0

    def _rank_trace(self, log, placed, kinds, hi, minutes, waiting,
                    budget_usd, spent) -> dict:
        """Evidence for why this plan, drawn only from the optimiser's own
        decisions.

        The spec's rule is that an explanation may use optimiser-trace values
        and nothing else - no invented costs, no invented impacts, and no
        chain-of-thought. So this reports what was bought, what it saved, the
        single highest-value site, and why a type that was not bought lost.
        """
        by_kind: dict[str, dict] = {}
        for entry in log:
            k = entry["kind"]
            rec = by_kind.setdefault(k, {"units": 0, "cost": 0.0,
                                         "severe_saved": 0.0, "load_saved": 0.0})
            rec["units"] += 1
            rec["cost"] += entry["cost_usd"]
            rec["severe_saved"] += entry["severe_minutes_saved"]
            rec["load_saved"] += entry["heat_load_saved"]

        best = max(log, key=lambda e: e["severe_minutes_saved"], default=None)
        # Why a permitted type went unbought: compare best-value units.
        unbought = []
        for k in kinds:
            if by_kind.get(k, {}).get("units"):
                continue
            spec = self.interventions[k]
            reach = ("waiting time at transit stops"
                     if spec.get("protects") == "waiting" else "footway")
            unbought.append({
                "kind": k, "label": spec["label"],
                "cost_usd": spec["cost_usd"],
                "reason": (f"{spec['label']} costs ${spec['cost_usd']:,} and "
                           f"covers {reach}; no unit of it removed more severe "
                           f"minutes per dollar than the cheapest tree still "
                           f"available."),
            })

        return {
            "by_kind": {k: {"units": v["units"],
                            "cost_usd": round(v["cost"], 2),
                            "severe_minutes_saved": round(v["severe_saved"], 3),
                            "heat_load_saved": round(v["load_saved"], 2),
                            "severe_per_1k_usd": round(
                                v["severe_saved"] / max(v["cost"], 1) * 1000, 3)}
                        for k, v in by_kind.items()},
            "best_site": ({"seg_id": best["seg_id"], "kind": best["kind"],
                           "cost_usd": best["cost_usd"],
                           "severe_minutes_saved": best["severe_minutes_saved"]}
                          if best else None),
            "placements_considered": len(log),
            "unspent_usd": round(budget_usd - spent, 2),
            "unbought": unbought,
            "objective": ("maximise severe person-minutes avoided, then heat "
                          "load avoided, then minimise cost"),
            "claim": ("simulation-recommended allocation; greedy search over "
                      "unit placements, not a proven global optimum"),
        }

    def __init__(self, engine: Engine, lengths: np.ndarray):
        self.e = engine
        self.lengths = lengths.astype(np.float64)
        # Per-instance, not the module dict: a custom solution registered for
        # one request must never leak into the next one's built-ins.
        self.interventions = {k: dict(v) for k, v in INTERVENTIONS.items()}
        self.sites = {sid: self._candidate_sites(coords)
                      for sid, coords in self.e.seg_coords.items()}
        self._tree_capacity = np.array(
            [len(self.sites.get(sid, ())) for sid in self.e.seg_ids], dtype=int)

    @classmethod
    def _candidate_sites(cls, coords: list) -> list[tuple[float, float, float]]:
        """The planting sites on one segment: lon, lat and street bearing.

        Sites are walked along the centreline and kept only when they are at
        least SITE_SPACING_M from the previous kept site *in a straight line*.
        Measuring along the polyline is not enough - on a curved street two
        points 10 m apart along the kerb can be 7.8 m apart on the ground,
        which would let two purchased crowns overlap and double-count the
        person-minutes underneath them.
        """
        total = cls._length_m(coords)
        if total < SITE_SPACING_M:
            return []
        out: list[tuple[float, float, float]] = []
        step = 2.0
        d = step
        while d <= total - step:
            lon, lat, bearing = cls._along_m(coords, d)
            if not out:
                out.append((lon, lat, bearing))
            else:
                plon, plat, _ = out[-1]
                dx = (lon - plon) * _M_PER_DEG_LON
                dy = (lat - plat) * _M_PER_DEG_LAT
                if (dx * dx + dy * dy) ** 0.5 >= SITE_SPACING_M:
                    out.append((lon, lat, bearing))
            d += step
        return out

    def register(self, spec: dict) -> str:
        """Add a user-confirmed custom solution for this Adapter only.

        The spec must already have passed the mechanism gate: by the time it
        arrives here it is numbers, not prose. The language model never
        reaches this function - a person confirms the draft first.
        """
        key = str(spec["key"])
        if key in INTERVENTIONS:
            raise ValueError(f"'{key}' is a built-in; choose another name")
        for field in ("label", "cost_usd", "shade_m", "block"):
            if field not in spec:
                raise ValueError(f"custom solution is missing '{field}'")
        self.interventions[key] = dict(spec)
        return key

    def max_units(self, kind: str) -> np.ndarray:
        """How many units a segment can take.

        Shade you build along the footway is limited by how long the segment
        is. A shelter is limited by how many real unsheltered bus stops are
        on it, which is usually one or two.
        """
        spec = self.interventions[kind]
        if spec.get("site_constrained"):
            return self.e.shelter_capacity.astype(int)
        # How many sites the candidate layer actually generated on each
        # segment. Spacing on the ground, not crown width and not a length
        # division, is what limits how many trees a street can take.
        return self._tree_capacity

    def shelter_delta(self, units: np.ndarray) -> np.ndarray:
        """Extra shelter coverage from placing `units` shelters per segment."""
        cap = np.maximum(self.e.shelter_capacity.astype(np.float64), 1.0)
        room = 1.0 - self.e.shelter_coverage.astype(np.float64)
        return np.clip(units / cap, 0.0, 1.0) * room

    def sun_delta(self, kind: str, units: np.ndarray, hour_idx: int) -> np.ndarray:
        """Footway sun removed by `units` of this kind. Shelters remove none:
        they cover the stop, not the pavement people walk along."""
        spec = self.interventions[kind]
        if spec.get("protects") == "waiting":
            return np.zeros(len(self.lengths))
        covered = np.clip(units * spec["shade_m"] / np.maximum(self.lengths, 1e-6),
                          0.0, 1.0)
        return spec["block"] * covered * self.e.sun_exposure[:, hour_idx]

    def service_floor(self, hour: int, persona: str) -> list[tuple[str, int]]:
        """One shaded shelter at the worst unsheltered stop on each corridor.

        Phase A of the Balanced Protection policy. Pure severe-minutes-per-
        dollar always buys trees - waiting is 3.4% of exposure and a shelter
        costs 12.5x a tree - so an unconstrained objective never protects a
        waiting rider anywhere. This is a stated policy floor, not a discovery:
        every hero corridor gets one protected stop before efficiency is
        allowed to spend the rest.
        """
        hi = self.e.hour_index(hour)
        p = self.e.persona_index(persona)
        waiting = self.e.wait_minutes[:, p, hi]
        sun = self.e.sun_exposure[:, hi]
        picks: list[tuple[str, int]] = []
        for corridor in self.e.hero_corridors:
            best, best_val = None, 0.0
            for stop in self.e.stops:
                if stop["sheltered"]:
                    continue
                sid = stop["seg_id"]
                if self.e.seg_corridor.get(sid) != corridor:
                    continue
                i = self.e.index.get(sid)
                if i is None or self.e.shelter_capacity[i] <= 0:
                    continue
                # Rank by the waiting exposure one shelter would actually
                # remove, not by a proxy: a stop whose segment is already
                # partly sheltered, or which shares its segment with other
                # stops, has less left to protect.
                units = np.zeros(len(self.e.seg_ids), dtype=int)
                units[i] = 1
                gain = float(self.shelter_delta(units)[i])
                val = float(waiting[i]) * float(sun[i]) * gain
                if val > best_val:
                    best, best_val = (sid, i), val
            if best:
                picks.append(best)
        return picks

    def deploy(self, scenario: str, hour: int, persona: str,
               budget_usd: float, kind: str) -> dict:
        """Spend the whole budget on one measure, whether it helps or not.

        The optimiser only ever buys a unit that improves the objective, so a
        measure that makes things worse is bought zero times and its effect
        never appears. That is the right answer to "what should we build",
        and the wrong answer to "what happens if we build this" - which is the
        question a person proposing a measure is actually asking.

        So this deploys it on its own best ground: the segments carrying the
        most person-minutes first, up to capacity, until the money runs out.
        A measure that helps therefore gets its most favourable showing, and
        one that hurts is shown hurting rather than quietly skipped.
        """
        hi = self.e.hour_index(hour)
        p = self.e.persona_index(persona)
        spec = self.interventions[kind]
        cost = float(spec["cost_usd"])
        caps = self.max_units(kind)
        demand = (self.e.minutes[:, p, hi].astype(float)
                  + self.e.wait_minutes[:, p, hi].astype(float))

        units = np.zeros(len(self.e.seg_ids), dtype=int)
        spent = 0.0
        log: list[dict] = []
        for i in np.argsort(-demand):
            if demand[i] <= 0:
                break
            room = int(caps[i])
            while units[i] < room and spent + cost <= budget_usd:
                units[i] += 1
                spent += cost
                log.append({"seg_id": self.e.seg_ids[i], "kind": kind,
                            "cost_usd": cost, "severe_minutes_saved": 0.0,
                            "heat_load_saved": 0.0, "phase": "deployed"})
            if spent + cost > budget_usd:
                break

        before = self.e.crash_test(scenario, hour, persona)
        after = self.e.crash_test(scenario, hour, persona,
                                  **self.deltas(kind, units, hi))
        return {"units": units, "spent_usd": spent, "count": int(units.sum()),
                "before": before, "after": after, "placements": log}

    def deltas(self, kind: str, units: np.ndarray, hour_idx: int) -> dict:
        """The environmental change one measure's units produce."""
        spec = self.interventions[kind]
        if spec.get("mechanism") == "tmrt_modifier":
            # Partial coverage scales the shift, exactly as shade coverage
            # scales sun removal: treating half a segment moves half its Tmrt.
            covered = np.clip(units * float(spec["treated_length_m"])
                              / np.maximum(self.lengths, 1e-6), 0.0, 1.0)
            return {"tmrt_delta": covered * float(spec["tmrt_delta_c"])}
        if spec.get("protects") == "waiting":
            return {"shelter_delta": self.shelter_delta(units)}
        return {"sun_delta": self.sun_delta(kind, units, hour_idx)}

    def optimize(self, scenario: str, hour: int, persona: str, budget_usd: float,
                 kinds: list[str] | None = None,
                 policy: str = "balanced_protection") -> dict:
        """Balanced Protection: a service floor, then marginal allocation.

        Objective order follows the spec: maximise severe person-minutes
        avoided first, then cumulative heat load avoided, then minimise cost.
        Heat load breaks ties when no candidate can cross the severe
        threshold - without it the optimiser would be blind whenever the
        whole scenario sits below 38 C.

        This is a simulation-recommended allocation, not a proven optimum:
        greedy explores one unit at a time rather than every combination.
        """
        # Hash the request AS MADE, before defaulting. The caller asked for
        # "any intervention"; expanding that to the concrete list first would
        # produce a hash the caller cannot reproduce, and every such plan
        # would be refused as a mismatch.
        plan_hash = self.e.input_hash(scenario, hour, persona, budget_usd,
                                      (kinds or []) + [f"policy:{policy}"])
        kinds = kinds or list(self.interventions)
        hi = self.e.hour_index(hour)
        p = self.e.persona_index(persona)
        cond = self.e.conditions(scenario, hour)

        base = self.e.crash_test(scenario, hour, persona)
        minutes = self.e.minutes[:, p, hi].astype(np.float64)
        waiting = self.e.wait_minutes[:, p, hi].astype(np.float64)
        sun0 = self.e.sun_exposure[:, hi].astype(np.float64)
        cover0 = self.e.shelter_coverage.astype(np.float64)

        u_sun, u_shade = float(cond["utci_sun_c"]), float(cond["utci_shade_c"])
        sev_sun = float(u_sun >= SEVERE_UTCI_C)
        sev_shade = float(u_shade >= SEVERE_UTCI_C)
        load_sun = max(u_sun - HEAT_LOAD_BASE_C, 0.0)
        load_shade = max(u_shade - HEAT_LOAD_BASE_C, 0.0)

        def score(sun, cover):
            wait_sun = (1.0 - cover) * sun
            ms, mh = minutes * sun, minutes * (1.0 - sun)
            ws, wh = waiting * wait_sun, waiting * (1.0 - wait_sun)
            return (ms * sev_sun + mh * sev_shade + ws * sev_sun + wh * sev_shade,
                    ms * load_sun + mh * load_shade
                    + ws * load_sun + wh * load_shade)

        placed = {k: np.zeros(len(self.e.seg_ids), dtype=int) for k in kinds}
        caps = {k: self.max_units(k) for k in kinds}
        spent, log = 0.0, []
        floor_sites: list[dict] = []


        def state(placed_map):
            sun = np.clip(sun0 - sum(self.sun_delta(j, placed_map[j], hi)
                                     for j in kinds), 0.0, 1.0)
            shelters = placed_map.get("shaded_shelter")
            cover = (np.clip(cover0 + self.shelter_delta(shelters), 0.0, 1.0)
                     if shelters is not None else cover0)
            return sun, cover


        # --- Phase A: the transparent service floor -----------------------
        if policy == "balanced_protection" and "shaded_shelter" in kinds:
            cost = self.interventions["shaded_shelter"]["cost_usd"]
            base_sev, base_load = score(sun0, cover0)
            for sid, i in self.service_floor(hour, persona):
                if spent + cost > budget_usd or placed["shaded_shelter"][i] >= caps["shaded_shelter"][i]:
                    continue
                placed["shaded_shelter"][i] += 1
                spent += cost
                trial_sun, trial_cover = state(placed)
                t_sev, t_load = score(trial_sun, trial_cover)
                saved = float(base_sev[i] - t_sev[i])
                log.append({"seg_id": sid, "kind": "shaded_shelter",
                            "cost_usd": cost,
                            "severe_minutes_saved": round(saved, 4),
                            "heat_load_saved": round(float(base_load[i] - t_load[i]), 3),
                            "phase": "service_floor"})
                floor_sites.append({
                    "corridor": self.e.seg_corridor.get(sid),
                    "seg_id": sid,
                    "waiting_severe_minutes_avoided": round(saved, 4)})
                base_sev, base_load = t_sev, t_load

        cur_sun, cur_cover = state(placed)
        cur_sev, cur_load = score(cur_sun, cur_cover)
        # A candidate is worth considering if anyone is there and there is sun
        # to remove - walkers for a tree, waiters for a shelter.
        live_walk = (minutes > 0) & (sun0 > 0.01)
        live_wait = (waiting > 0) & (sun0 > 0.01)

        while True:
            best = None
            for k in kinds:
                spec = self.interventions[k]
                if spent + spec["cost_usd"] > budget_usd:
                    continue
                live = (live_wait if spec.get("protects") == "waiting"
                        else live_walk)
                room = live & (placed[k] < caps[k])
                if not room.any():
                    continue
                trial = {j: (v + room.astype(int) if j == k else v)
                         for j, v in placed.items()}
                trial_sun, trial_cover = state(trial)
                t_sev, t_load = score(trial_sun, trial_cover)
                gain_sev = cur_sev - t_sev
                gain_load = cur_load - t_load
                gain_sev[~room] = -np.inf
                gain_load[~room] = -np.inf
                # Primary objective, with heat load as the tie-break.
                value = (gain_sev + 1e-6 * gain_load) / spec["cost_usd"]
                i = int(np.argmax(value))
                if not np.isfinite(value[i]) or value[i] <= 0:
                    continue
                if best is None or value[i] > best[0]:
                    best = (value[i], k, i, gain_sev[i], gain_load[i],
                            spec["cost_usd"])
            if best is None:
                break

            _, kind, idx, g_sev, g_load, cost = best
            placed[kind][idx] += 1
            spent += cost
            log.append({"seg_id": self.e.seg_ids[idx], "kind": kind,
                        "cost_usd": cost,
                        "severe_minutes_saved": round(float(g_sev), 4),
                        "heat_load_saved": round(float(g_load), 3),
                        "phase": "marginal"})
            cur_sun, cur_cover = state(placed)
            cur_sev, cur_load = score(cur_sun, cur_cover)

        total_delta = sun0 - cur_sun
        cover_delta = cur_cover - cover0
        after = self.e.crash_test(scenario, hour, persona,
                                  sun_delta=total_delta,
                                  shelter_delta=cover_delta)
        units = self._unit_points(log)
        denom = base.severe_total or base.heat_load_total or 1.0
        num = ((base.severe_total - after.severe_total) if base.severe_total
               else (base.heat_load_total - after.heat_load_total))
        return {
            "budget_usd": budget_usd, "spent_usd": spent,
            "placements": log,
            "counts": {k: int(v.sum()) for k, v in placed.items()},
            "before": base, "after": after,
            "sun_delta": total_delta,
            "shelter_delta": cover_delta,
            "reduction_pct": 100.0 * num / denom,
            "metric_used": "severe_person_minutes" if base.severe_total else "heat_load",
            "policy": policy,
            "policy_label": ("Balanced Protection policy"
                             if policy == "balanced_protection"
                             else "Pure marginal efficiency"),
            "service_floor": floor_sites,
            # The engine owns the post-intervention environment. The UI used
            # to back out the new sun fraction from a ratio of exposure
            # scores, which is a reconstruction, not a result.
            "after_sun": cur_sun,
            "after_utci_c": (cur_sun * u_sun + (1.0 - cur_sun) * u_shade),
            "after_shelter_coverage": cur_cover,
            "unit_placements": units,
            "shade_footprints": self.shade_footprints(units),
            "rank_trace": self._rank_trace(log, placed, kinds, hi, minutes,
                                           waiting, budget_usd, spent),
            "input_hash": plan_hash,
            "snapshot_id": snapshot_id(plan_hash, "adapt"),
            "status": "complete",
        }
