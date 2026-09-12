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

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"

SEVERE_UTCI_C = 38.0        # "Very Strong Heat Stress"
HEAT_LOAD_BASE_C = 26.0     # onset of "Moderate Heat Stress"


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
    severe_total: float = 0.0
    heat_load_total: float = 0.0
    weighted_severe_total: float = 0.0
    planning_weight: float = 1.0
    meta: dict = field(default_factory=dict)


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
                   shelter_delta: np.ndarray | None = None) -> Result:
        """Score every segment under one scenario.

        sun_delta reduces the sun on the footway (trees). shelter_delta adds
        shelter coverage at transit stops, which protects waiting time only.
        Both are per-segment fractions in [0, 1]; None gives the baseline.
        """
        hi = self.hour_index(hour)
        p_idx = self.persona_index(persona)
        cond = self.conditions(scenario, hour)

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

        u_sun = float(cond["utci_sun_c"])
        u_shade = float(cond["utci_shade_c"])
        sev_sun = float(u_sun >= SEVERE_UTCI_C)
        sev_shade = float(u_shade >= SEVERE_UTCI_C)
        load_sun = max(u_sun - HEAT_LOAD_BASE_C, 0.0)
        load_shade = max(u_shade - HEAT_LOAD_BASE_C, 0.0)

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

        return Result(
            seg_ids=self.seg_ids, utci_c=utci, severe_minutes=severe,
            heat_load=load, sun=sun, minutes=minutes,
            walking_severe=walk_sev, waiting_severe=wait_sev,
            walking_severe_total=float(walk_sev.sum()),
            waiting_severe_total=float(wait_sev.sum()),
            utci_sun_c=u_sun, utci_shade_c=u_shade,
            severe_total=float(severe.sum()),
            heat_load_total=float(load.sum()),
            weighted_severe_total=float(severe.sum() * weight),
            planning_weight=weight,
            meta={"air_temp_c": cond["air_temp_c"], "rh_pct": cond["rh_pct"],
                  "wind_ms": cond["wind_ms"],
                  "tmrt_sun_c": cond["tmrt_sun_c"],
                  "tmrt_shade_c": cond["tmrt_shade_c"],
                  "shade_relief_c": cond["shade_relief_c"]},
        )

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

    def __init__(self, engine: Engine, lengths: np.ndarray):
        self.e = engine
        self.lengths = lengths.astype(np.float64)

    def max_units(self, kind: str) -> np.ndarray:
        """How many units a segment can take.

        Shade you build along the footway is limited by how long the segment
        is. A shelter is limited by how many real unsheltered bus stops are
        on it, which is usually one or two.
        """
        spec = INTERVENTIONS[kind]
        if spec.get("site_constrained"):
            return self.e.shelter_capacity.astype(int)
        return np.floor(self.lengths / spec["shade_m"]).astype(int)

    def shelter_delta(self, units: np.ndarray) -> np.ndarray:
        """Extra shelter coverage from placing `units` shelters per segment."""
        cap = np.maximum(self.e.shelter_capacity.astype(np.float64), 1.0)
        room = 1.0 - self.e.shelter_coverage.astype(np.float64)
        return np.clip(units / cap, 0.0, 1.0) * room

    def sun_delta(self, kind: str, units: np.ndarray, hour_idx: int) -> np.ndarray:
        """Footway sun removed by `units` of this kind. Shelters remove none:
        they cover the stop, not the pavement people walk along."""
        spec = INTERVENTIONS[kind]
        if spec.get("protects") == "waiting":
            return np.zeros(len(self.lengths))
        covered = np.clip(units * spec["shade_m"] / np.maximum(self.lengths, 1e-6),
                          0.0, 1.0)
        return spec["block"] * covered * self.e.sun_exposure[:, hour_idx]

    def optimize(self, scenario: str, hour: int, persona: str, budget_usd: float,
                 kinds: list[str] | None = None) -> dict:
        """Greedy placement by severe-minutes avoided per dollar.

        Objective order follows the spec: maximise severe person-minutes
        avoided first, then cumulative heat load avoided, then minimise cost.
        Heat load breaks ties when no candidate can cross the severe
        threshold - without it the optimiser would be blind whenever the
        whole scenario sits below 38 C.

        This is a simulation-recommended allocation, not a proven optimum:
        greedy explores one unit at a time rather than every combination.
        """
        kinds = kinds or list(INTERVENTIONS)
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

        def state(placed_map):
            sun = np.clip(sun0 - sum(self.sun_delta(j, placed_map[j], hi)
                                     for j in kinds), 0.0, 1.0)
            shelters = placed_map.get("shaded_shelter")
            cover = (np.clip(cover0 + self.shelter_delta(shelters), 0.0, 1.0)
                     if shelters is not None else cover0)
            return sun, cover

        cur_sun, cur_cover = sun0.copy(), cover0.copy()
        cur_sev, cur_load = score(cur_sun, cur_cover)
        # A candidate is worth considering if anyone is there and there is sun
        # to remove - walkers for a tree, waiters for a shelter.
        live_walk = (minutes > 0) & (sun0 > 0.01)
        live_wait = (waiting > 0) & (sun0 > 0.01)

        while True:
            best = None
            for k in kinds:
                spec = INTERVENTIONS[k]
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
                        "heat_load_saved": round(float(g_load), 3)})
            cur_sun, cur_cover = state(placed)
            cur_sev, cur_load = score(cur_sun, cur_cover)

        total_delta = sun0 - cur_sun
        cover_delta = cur_cover - cover0
        after = self.e.crash_test(scenario, hour, persona,
                                  sun_delta=total_delta,
                                  shelter_delta=cover_delta)
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
        }
