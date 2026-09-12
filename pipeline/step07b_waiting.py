"""Step 7b - waiting exposure at transit stops.

Walking is not the only way a pedestrian accumulates heat. Someone standing
at an unshaded bus stop in full sun accumulates it faster, because they are
not moving and cannot leave. A shaded waiting shelter protects exactly that
time, and a model that scores only walking will always undervalue shelters -
which is what the previous version did.

Two inputs, with very different status:

  wait duration   DERIVED. Half the headway is the standard estimate for
                  passengers arriving at random, and the headway comes from
                  real PRT weekly service frequency at each stop.

  transit share   ASSUMPTION. PRT publishes ridership by route, not by stop,
                  so there is no stop-level boarding count to calibrate
                  against. The share of simulated trips ending in a wait is
                  declared, ranged, and shown in the UI as an assumption.

Output is wait_minutes.npz - waiting person-minutes per segment, persona and
hour, in the same shape as the walking minutes so the engine can simply add
the two.
"""
from __future__ import annotations

import json

import geopandas as gpd
import numpy as np
import pandas as pd

from config import (CACHE, HOURS, HOUR_LABELS, MAX_WAIT_MINUTES,
                    MIN_WAIT_MINUTES, PERSONAS, TRANSIT_SERVICE_HOURS_PER_WEEK,
                    TRANSIT_SHARE_BASIS, TRANSIT_SHARE_STATUS,
                    TRANSIT_TRIP_SHARE, TRANSIT_TRIP_SHARE_RANGE)

WAIT_PATH = CACHE / "wait_minutes.npz"
WAIT_META_PATH = CACHE / "wait_meta.json"


def mean_wait_minutes(trips_7d: pd.Series) -> pd.Series:
    """Half the headway, from real weekly service frequency."""
    per_hour = pd.to_numeric(trips_7d, errors="coerce") / TRANSIT_SERVICE_HOURS_PER_WEEK
    headway = 60.0 / per_hour.where(per_hour > 0)
    return (headway / 2.0).clip(lower=MIN_WAIT_MINUTES, upper=MAX_WAIT_MINUTES)


def main() -> None:
    print("STEP 7b  waiting exposure at transit stops")
    seg = gpd.read_file(CACHE / "segments.geojson")
    seg_pos = {sid: i for i, sid in enumerate(seg["seg_id"])}
    stops = gpd.read_file(CACHE / "bus_stops.geojson")

    stops["wait_min"] = mean_wait_minutes(stops["trips_7d"])
    known = stops["wait_min"].notna()
    # Stops with no matched service frequency fall back to the median of the
    # stops that do have one, rather than being dropped or given a guess.
    stops.loc[~known, "wait_min"] = float(stops.loc[known, "wait_min"].median())
    print(f"  stops: {len(stops)}  ({int(known.sum())} with PRT service frequency)")
    print(f"  mean wait: min {stops.wait_min.min():.1f}  "
          f"median {stops.wait_min.median():.1f}  max {stops.wait_min.max():.1f} min")

    z = np.load(CACHE / "minutes.npz", allow_pickle=True)
    personas = [str(p) for p in z["personas"]]
    walk = z["minutes"]
    n_seg, n_per, n_hr = walk.shape

    # How many agents of each persona are out at each hour, from the walking
    # model, so the waiting population is consistent with the walking one.
    trips_meta = json.loads((CACHE / "trips_meta.json").read_text())
    by_persona = {p["persona"]: p for p in trips_meta["personas"]}

    wait = np.zeros_like(walk)
    # Distribute waiting agents across stops in proportion to service
    # frequency: a stop served twice as often sees roughly twice the demand.
    weight = stops["trips_7d"].fillna(stops["trips_7d"].median()).to_numpy()
    weight = weight / weight.sum() if weight.sum() else np.ones(len(stops)) / len(stops)

    for pi, pname in enumerate(personas):
        meta = by_persona.get(pname, {})
        if meta.get("derived"):
            continue   # filled in at the end as the sum of the cohorts
        persona = PERSONAS.get(pname)
        if persona is None:
            continue
        for hi, hour in enumerate(HOURS):
            # Agents out at this hour, inferred from the walking population.
            share = persona["departure_mix"].get(hour, 0.0)
            agents = meta.get("trips", 0) * share * TRANSIT_TRIP_SHARE
            if agents <= 0:
                continue
            per_stop = agents * weight
            for n, (sid, w) in enumerate(zip(stops["seg_id"], stops["wait_min"])):
                j = seg_pos.get(sid)
                if j is not None:
                    wait[j, pi, hi] += per_stop[n] * w

    derived = [i for i, p in enumerate(personas)
               if by_persona.get(p, {}).get("derived")]
    for di in derived:
        others = [i for i in range(n_per) if i != di]
        wait[:, di, :] = wait[:, others, :].sum(axis=1)

    # Per-segment shelter state. Waiting time under an existing shelter is
    # already in shade; the intervention buys coverage for the rest.
    n = len(seg)
    cov0 = np.zeros(n, dtype=np.float32)     # already sheltered share
    cap = np.zeros(n, dtype=np.int32)        # unsheltered stops = capacity
    per_seg_w: dict[int, float] = {}
    per_seg_sheltered: dict[int, float] = {}
    for sid, sheltered, w in zip(stops["seg_id"], stops["sheltered"],
                                 stops["wait_min"] * weight):
        j = seg_pos.get(sid)
        if j is None:
            continue
        per_seg_w[j] = per_seg_w.get(j, 0.0) + float(w)
        if sheltered:
            per_seg_sheltered[j] = per_seg_sheltered.get(j, 0.0) + float(w)
        else:
            cap[j] += 1
    for j, total in per_seg_w.items():
        if total > 0:
            cov0[j] = per_seg_sheltered.get(j, 0.0) / total

    np.savez_compressed(WAIT_PATH, wait_minutes=wait,
                        shelter_coverage=cov0, shelter_capacity=cap,
                        seg_ids=z["seg_ids"], personas=z["personas"],
                        hours=np.array(HOURS))
    WAIT_META_PATH.write_text(json.dumps({
        "transit_trip_share": TRANSIT_TRIP_SHARE,
        "transit_trip_share_range": list(TRANSIT_TRIP_SHARE_RANGE),
        "status": TRANSIT_SHARE_STATUS,
        "basis": TRANSIT_SHARE_BASIS,
        "wait_rule": ("Mean wait is half the headway, derived from PRT weekly "
                      "service frequency at each stop"),
        "wait_source": "Pittsburgh Regional Transit stop service frequency (WPRDC)",
        "stops": int(len(stops)),
        "stops_with_service_data": int(known.sum()),
        "median_wait_minutes": round(float(stops.wait_min.median()), 2),
        "segments_with_stops": int(stops["seg_id"].nunique()),
        "already_sheltered_stops": int(stops["sheltered"].sum()),
        "unsheltered_stops": int((~stops["sheltered"]).sum()),
    }, indent=2))

    print(f"  shelter coverage: {int((cov0 > 0).sum())} segments partly "
          f"sheltered, {int(cap.sum())} unsheltered stops available")
    print(f"  transit trip share: {TRANSIT_TRIP_SHARE:.0%} "
          f"(assumption, range {TRANSIT_TRIP_SHARE_RANGE[0]:.0%}"
          f"-{TRANSIT_TRIP_SHARE_RANGE[1]:.0%})")
    print("  waiting person-minutes by hour:")
    for hi, h in enumerate(HOURS):
        w = wait[:, :, hi].sum() - wait[:, derived, hi].sum()
        k = walk[:, :, hi].sum() - walk[:, derived, hi].sum()
        print(f"    {HOUR_LABELS[h]:>5}  waiting {w:8.0f}   walking {k:8.0f}   "
              f"waiting is {w/(w+k)*100:4.1f}% of total")
    print(f"  wrote {WAIT_PATH.name}, {WAIT_META_PATH.name}")


if __name__ == "__main__":
    main()
