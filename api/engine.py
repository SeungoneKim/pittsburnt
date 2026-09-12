"""The exposure engine: turn a scenario into a score per street segment.

The brief's MVP formula is

    Exposure = heat severity x sun exposure x time spent x planning weight

We follow it with one deliberate change. Taken literally, multiplying by sun
exposure makes a fully shaded segment score exactly zero - which would say a
pedestrian accumulates no heat burden in the shade, and would make any
intervention look infinitely effective. Instead, sun enters where it
physically belongs: the NWS Heat Index is a *shade* measure, and standing in
full sun adds roughly 8 C to apparent temperature. So sun raises the heat
index, and severity is computed from the result.

    effective heat index = HI(scenario, hour) + 8 C x sun_exposure(seg, hour)
    exposure(seg)        = severity(effective HI) x minutes(seg, persona, hour)

The score is reported as At-risk Pedestrian Minutes. It is a relative
measure for comparing the same city before and after an intervention, not a
medical prediction for any person.

All of the heavy geometry is precomputed, so a crash test is array
arithmetic over cached arrays and returns in milliseconds.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"

# Full sun versus shade, in degrees C of apparent temperature. The NWS notes
# that its Heat Index is measured in shade and that full sunshine can raise
# the apparent temperature by up to about 8 C (15 F).
FULL_SUN_BONUS_C = 8.0

HI_CAUTION_C = 27.0
HI_DANGER_C = 39.0


def severity(hi_c: np.ndarray) -> np.ndarray:
    """0 at the NWS Caution onset, 1.0 at Danger; unbounded above."""
    return np.clip(hi_c - HI_CAUTION_C, 0, None) / (HI_DANGER_C - HI_CAUTION_C)


@dataclass
class Result:
    seg_ids: list[str]
    exposure: np.ndarray          # at-risk pedestrian minutes, per segment
    exposure_unweighted: np.ndarray
    sun: np.ndarray               # sun exposure actually used, per segment
    minutes: np.ndarray
    total: float
    total_unweighted: float


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
        self.canopy_block = float(sun["canopy_block"])
        self.minutes = mins["minutes"].astype(np.float32)

        if [str(s) for s in mins["seg_ids"]] != self.seg_ids:
            raise ValueError("minutes.npz and sun_exposure.npz disagree on segments")

        # Real unsheltered bus stops per segment - the candidate sites for
        # the shelter intervention.
        sites_path = cache / "shelter_sites.json"
        self.shelter_sites: dict[str, int] = (
            json.loads(sites_path.read_text())["sites"] if sites_path.exists() else {})

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

    def heat_index_c(self, scenario: str, hour: int) -> float:
        sc = self.scenarios["scenarios"].get(scenario)
        if sc is None:
            raise ValueError(f"scenario must be one of "
                             f"{list(self.scenarios['scenarios'])}")
        return float(sc["hours"][str(hour)]["heat_index_c"])

    # -- the crash test -----------------------------------------------------

    def crash_test(self, scenario: str, hour: int, persona: str,
                   sun_delta: np.ndarray | None = None) -> Result:
        """Score every segment under one scenario.

        sun_delta is a per-segment reduction in sun exposure contributed by
        interventions, in [0, 1]. Passing None gives the baseline city.
        """
        hi_idx = self.hour_index(hour)
        p_idx = self.persona_index(persona)

        sun = self.sun_exposure[:, hi_idx].astype(np.float64)
        if sun_delta is not None:
            sun = np.clip(sun - sun_delta, 0.0, 1.0)

        hi = self.heat_index_c(scenario, hour) + FULL_SUN_BONUS_C * sun
        sev = severity(hi)
        minutes = self.minutes[:, p_idx, hi_idx].astype(np.float64)

        unweighted = sev * minutes
        weighted = unweighted * self.weights.get(persona, 1.0)
        return Result(
            seg_ids=self.seg_ids, exposure=weighted,
            exposure_unweighted=unweighted, sun=sun, minutes=minutes,
            total=float(weighted.sum()), total_unweighted=float(unweighted.sum()),
        )

    def hotspots(self, res: Result, top: int = 20) -> list[dict]:
        order = np.argsort(-res.exposure)[:top]
        return [{"seg_id": res.seg_ids[i],
                 "exposure": round(float(res.exposure[i]), 3),
                 "sun_exposure": round(float(res.sun[i]), 3),
                 "minutes": round(float(res.minutes[i]), 2)} for i in order]


# --- interventions ---------------------------------------------------------

# Cost and shading reach of each intervention the ADAPT step can place.
# Costs are planning-order-of-magnitude figures for a prototype, and are
# surfaced in the UI as assumptions rather than quoted as procurement prices.
INTERVENTIONS = {
    "tree": {
        "label": "Street tree",
        "cost_usd": 1200,
        # A mature street tree casts roughly its crown diameter along the
        # footway. 4 m crown radius is the median of the mature trees in the
        # City inventory, so a tree covers about 8 m of pavement.
        "shade_m": 8.0,
        # Canopy transmits some direct beam; it is not an opaque roof.
        "block": 0.85,
    },
    "shade_structure": {
        "label": "Shade structure",
        "cost_usd": 25000,
        "shade_m": 15.0,
        "block": 0.95,   # solid canopy
    },
    "transit_shelter": {
        "label": "Bus shelter",
        # Pittsburgh DOMI's Transit Stop Improvement Program installs
        # shelters at high-ridership stops explicitly to give riders shade.
        # No per-shelter figure is published for that programme; this sits
        # inside the $9k-$30k industry range and is surfaced as an
        # assumption, not quoted as a procurement price.
        "cost_usd": 15000,
        "shade_m": 4.0,   # a shelter is roughly 4 m of covered pavement
        "block": 0.95,
        # Unlike a tree, a shelter can only go where a bus stop already is,
        # so capacity comes from the real stop inventory rather than from
        # how long the segment happens to be.
        "site_constrained": True,
    },
}


class Adapter:
    """Places interventions and measures what they buy.

    Interventions act by removing sun exposure from a segment: a unit shades
    `shade_m` of pavement, and can only remove sun that was there to begin
    with. That keeps the effect bounded by physics rather than by a tuning
    constant.
    """

    def __init__(self, engine: Engine, lengths: np.ndarray):
        self.e = engine
        self.lengths = lengths.astype(np.float64)

    def max_units(self, kind: str) -> np.ndarray:
        """How many units a segment can take.

        Shade you build yourself is limited by how long the segment is. A bus
        shelter is limited by how many unsheltered bus stops are actually on
        it, which is usually one or two.
        """
        spec = INTERVENTIONS[kind]
        if spec.get("site_constrained"):
            sites = self.e.shelter_sites
            return np.array([int(sites.get(sid, 0)) for sid in self.e.seg_ids],
                            dtype=int)
        return np.floor(self.lengths / spec["shade_m"]).astype(int)

    def sun_delta(self, kind: str, units: np.ndarray, hour_idx: int) -> np.ndarray:
        spec = INTERVENTIONS[kind]
        covered = np.clip(units * spec["shade_m"] / np.maximum(self.lengths, 1e-6),
                          0.0, 1.0)
        return spec["block"] * covered * self.e.sun_exposure[:, hour_idx]

    def optimize(self, scenario: str, hour: int, persona: str, budget_usd: float,
                 kinds: list[str] | None = None) -> dict:
        """Greedy placement by exposure reduction per dollar.

        At each step, every candidate segment is asked what one more unit
        would save; the best value-for-money unit is bought. Greedy is the
        right shape here because each unit has diminishing returns on its own
        segment (it can only remove the sun that is left), so the marginal
        gains fall as a segment fills up.
        """
        kinds = kinds or list(INTERVENTIONS)
        hi = self.e.hour_index(hour)
        p = self.e.persona_index(persona)

        base = self.e.crash_test(scenario, hour, persona)
        hi_base = self.e.heat_index_c(scenario, hour)
        minutes = self.e.minutes[:, p, hi].astype(np.float64)
        weight = self.e.weights.get(persona, 1.0)
        sun0 = self.e.sun_exposure[:, hi].astype(np.float64)

        placed = {k: np.zeros(len(self.e.seg_ids), dtype=int) for k in kinds}
        caps = {k: self.max_units(k) for k in kinds}
        spent, log = 0.0, []

        def exposure_at(sun):
            return severity(hi_base + FULL_SUN_BONUS_C * sun) * minutes * weight

        cur_sun = sun0.copy()
        cur_exp = exposure_at(cur_sun)

        # Only segments that carry people and see sun are worth shading.
        live = (minutes > 0) & (sun0 > 0.01)

        while True:
            best = None
            for k in kinds:
                spec = INTERVENTIONS[k]
                if spent + spec["cost_usd"] > budget_usd:
                    continue
                room = live & (placed[k] < caps[k])
                if not room.any():
                    continue
                trial_units = placed[k] + room.astype(int)
                trial_sun = np.clip(
                    sun0 - self.sun_delta(k, trial_units, hi)
                    - sum(self.sun_delta(j, placed[j], hi) for j in kinds if j != k),
                    0.0, 1.0)
                gain = cur_exp - exposure_at(trial_sun)
                gain[~room] = -np.inf
                value = gain / spec["cost_usd"]
                i = int(np.argmax(value))
                if not np.isfinite(value[i]) or gain[i] <= 0:
                    continue
                if best is None or value[i] > best[0]:
                    best = (value[i], k, i, gain[i], spec["cost_usd"])
            if best is None:
                break

            _, kind, idx, gain, cost = best
            placed[kind][idx] += 1
            spent += cost
            log.append({"seg_id": self.e.seg_ids[idx], "kind": kind,
                        "cost_usd": cost, "exposure_saved": round(float(gain), 4)})
            cur_sun = np.clip(
                sun0 - sum(self.sun_delta(j, placed[j], hi) for j in kinds), 0.0, 1.0)
            cur_exp = exposure_at(cur_sun)

        total_delta = sun0 - cur_sun
        after = self.e.crash_test(scenario, hour, persona, sun_delta=total_delta)
        return {
            "budget_usd": budget_usd, "spent_usd": spent,
            "placements": log,
            "counts": {k: int(v.sum()) for k, v in placed.items()},
            "before": base, "after": after,
            "sun_delta": total_delta,
            "reduction_pct": (100.0 * (base.total - after.total) / base.total
                              if base.total else 0.0),
        }
