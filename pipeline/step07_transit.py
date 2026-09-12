"""Step 7 - bus stops as existing shade and as intervention sites.

Pittsburgh DOMI's Transit Stop Improvement Program installs shelters at high
ridership bus stops, explicitly so riders can wait in shade. That makes a
transit shelter a real, funded city intervention rather than a hypothetical
one - and unlike a tree, it can only go where a bus stop actually is.

So shelters are modelled as a *site-constrained* intervention: the candidate
list is the set of real unsheltered stops, and capacity per street segment is
the number of such stops on it, not how much pavement it has.

Existing sheltered stops are carried too, as a baseline protection layer.

Note on cooling centres: the brief is explicit that they are "activated
episodically; treat as safe destinations, not permanent shade
infrastructure". Modelling one as shade would be wrong, so they are not an
intervention here - a cooling centre shortens a trip by being somewhere to
go, which is a routing change and out of MVP scope.
"""
from __future__ import annotations

import json

import geopandas as gpd
import osmnx as ox
import pandas as pd
import requests
from shapely.strtree import STRtree

from config import BBOX, CACHE, CRS_METRIC, CRS_WGS84, RAW

STOPS_PATH = CACHE / "bus_stops.geojson"
SITES_PATH = CACHE / "shelter_sites.json"
PRT_RAW = RAW / "prt_stops.geojson"
PRT_RESOURCE = "d6e6ed6e-9220-4a0e-9796-e72d83ce8e7a"

# A stop must be within this distance of a walking segment to be attached to
# it; beyond that it is probably serving a road we do not model.
MAX_SNAP_M = 40.0


def fetch_prt(force: bool = False) -> gpd.GeoDataFrame:
    """PRT stop locations and weekly service frequency."""
    if not PRT_RAW.exists() or force:
        url = requests.get(
            "https://data.wprdc.org/api/3/action/resource_show",
            params={"id": PRT_RESOURCE}, timeout=60).json()["result"]["url"]
        PRT_RAW.parent.mkdir(parents=True, exist_ok=True)
        PRT_RAW.write_bytes(requests.get(url, timeout=300).content)
    g = gpd.read_file(PRT_RAW)
    g = g.cx[BBOX["west"]:BBOX["east"], BBOX["south"]:BBOX["north"]]
    return g.to_crs(CRS_METRIC)


def fetch_osm_stops() -> gpd.GeoDataFrame:
    """OSM bus stops - the only source here that records shelter=yes/no."""
    g = ox.features.features_from_bbox(
        bbox=(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]),
        tags={"highway": "bus_stop"})
    g = g[g.geometry.geom_type == "Point"].copy()
    return g.to_crs(CRS_METRIC)


def main() -> None:
    print("STEP 7  bus stops -> existing shelter + shelter sites")
    seg = gpd.read_file(CACHE / "segments.geojson").to_crs(CRS_METRIC)

    osm = fetch_osm_stops()
    shelter = osm["shelter"].astype(str).str.lower() if "shelter" in osm else pd.Series(dtype=str)
    osm["sheltered"] = shelter.isin(["yes", "roof", "covered"]).reindex(osm.index, fill_value=False)
    print(f"  OSM bus stops in bbox: {len(osm)}  "
          f"({int(osm.sheltered.sum())} already sheltered, "
          f"{int((~osm.sheltered).sum())} not)")

    # PRT gives service frequency, which is the closest available proxy for
    # DOMI's "high ridership" eligibility rule.
    try:
        prt = fetch_prt()
        prt["trips_7d"] = pd.to_numeric(prt.get("trips_7d"), errors="coerce")
        ptree = STRtree(list(prt.geometry.values))
        freq = []
        for pt in osm.geometry.values:
            j = ptree.nearest(pt)
            near = prt.iloc[j]
            freq.append(float(near["trips_7d"]) if near.geometry.distance(pt) <= 60
                        and pd.notna(near["trips_7d"]) else float("nan"))
        osm["trips_7d"] = freq
        matched = int(pd.Series(freq).notna().sum())
        print(f"  PRT stops in bbox: {len(prt)}  "
              f"(service frequency matched to {matched}/{len(osm)} OSM stops)")
    except Exception as exc:
        osm["trips_7d"] = float("nan")
        print(f"  PRT service data unavailable ({exc}); proceeding without frequency")

    # Attach each stop to the walking segment it sits beside.
    stree = STRtree(list(seg.geometry.values))
    seg_ids, dists = [], []
    for pt in osm.geometry.values:
        i = stree.nearest(pt)
        seg_ids.append(seg.iloc[i]["seg_id"])
        dists.append(float(seg.iloc[i].geometry.distance(pt)))
    osm["seg_id"] = seg_ids
    osm["snap_m"] = dists
    osm = osm[osm["snap_m"] <= MAX_SNAP_M].copy()
    print(f"  stops attached to a walking segment (<= {MAX_SNAP_M:.0f} m): {len(osm)}")

    name = osm["name"] if "name" in osm else pd.Series(None, index=osm.index)
    out = gpd.GeoDataFrame({
        "stop_name": name.astype(object),
        "sheltered": osm["sheltered"].astype(bool),
        "trips_7d": osm["trips_7d"],
        "seg_id": osm["seg_id"],
        "snap_m": osm["snap_m"].round(1),
    }, geometry=osm.geometry, crs=CRS_METRIC)
    out.to_crs(CRS_WGS84).to_file(STOPS_PATH, driver="GeoJSON")

    # Capacity for the shelter intervention: unsheltered stops per segment.
    sites = out[~out["sheltered"]].groupby("seg_id").size().to_dict()
    SITES_PATH.write_text(json.dumps(
        {"sites": {k: int(v) for k, v in sites.items()},
         "total_sites": int(sum(sites.values())),
         "already_sheltered": int(out["sheltered"].sum()),
         "note": ("Candidate sites are real unsheltered OSM bus stops. A "
                  "shelter can only be placed where a stop exists, matching "
                  "Pittsburgh DOMI's Transit Stop Improvement Program.")},
        indent=2))
    print(f"  shelter candidate sites: {sum(sites.values())} across "
          f"{len(sites)} segments")
    if out["trips_7d"].notna().any():
        busiest = out[~out["sheltered"]].nlargest(5, "trips_7d")
        print("  busiest unsheltered stops (weekly trips):")
        for _, r in busiest.iterrows():
            print(f"    {str(r.stop_name)[:44]:44} {r.trips_7d:6.0f}")
    print(f"  wrote {STOPS_PATH.name}, {SITES_PATH.name}")


if __name__ == "__main__":
    main()
