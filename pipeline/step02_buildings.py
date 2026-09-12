"""Step 2 - building footprints with a tiered height estimate.

The brief calls this the thing most likely to block the hack: footprints are
easy, reliable heights are not. Only ~27% of OSM buildings here carry any
height tag. So height is resolved through an explicit ladder, and every
building records which rung it landed on:

  manual         hand-patched hero buildings (data/manual/building_heights.json)
  osm_part       tallest building:part inside the footprint - OSM's 3D data,
                 which is how the Cathedral of Learning gets its real 163 m
  osm_height     an explicit height=* tag, in metres
  osm_levels     building:levels x storey height (+ roof levels)
  county_stories Allegheny County assessment STORIES, joined via parcel centroid
  modeled_default  median measured height of buildings with the same OSM
                 building=* value AND a similar footprint size. Footprint area
                 correlates with height here (r=0.50 on log-log), so a flat
                 per-type median would hand a 10,000 m2 museum the same 6.4 m
                 as a row house. This is still a guess, and labelled as one.

Every building carries a full provenance record - source type, human-readable
label, reference URL, the raw value it came from, the conversion rule applied,
and a confidence class. The revision spec is explicit that migration adds
disclosure and must not pretend a modelled estimate became measured data, so
nothing is upgraded here; the existing numbers are kept and labelled.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import geopandas as gpd
import numpy as np
import osmnx as ox
import pandas as pd
import requests
from shapely.geometry import Point

from config import BBOX, CACHE, CORRIDORS, CRS_METRIC, CRS_WGS84, RAW

BUILDINGS_PATH = CACHE / "buildings.geojson"
PARCELS_RAW = RAW / "parcels_stories.json"
MANUAL_PATH = RAW.parent / "manual" / "building_heights.json"

WPRDC_SQL = "https://data.wprdc.org/api/3/action/datastore_search_sql"
RES_CENTROIDS = "3fab7152-3f11-4788-8372-4c33f86ea813"
RES_ASSESS = "65855e14-549e-4992-b5be-d629afc676fa"

# Metres per storey. A flat average: Oakland mixes ~3m residential floors with
# ~4m+ institutional ones, and we have no per-building floor height anywhere.
STOREY_M = 3.2

# Provenance for each rung of the ladder. Confidence follows the revision
# spec's mapping: a direct measured height is high, a floor-count conversion
# is medium, a modelled estimate is low - and stays low.
SOURCE_META = {
    "manual": {
        "label": "Hand-patched height",
        "url": None,
        "conversion_rule": "direct",
        "confidence": "medium",
        "notes": "Entered by hand for a hero-corridor building.",
    },
    "osm_part": {
        "label": "OpenStreetMap 3D building:part height",
        "url": "https://wiki.openstreetmap.org/wiki/Key:height",
        "conversion_rule": "direct",
        "confidence": "high",
        "notes": "Tallest mapped part of the building; direct height in metres.",
    },
    "osm_height": {
        "label": "OpenStreetMap height tag",
        "url": "https://wiki.openstreetmap.org/wiki/Key:height",
        "conversion_rule": "direct",
        "confidence": "high",
        "notes": "Direct height in metres, unit-validated.",
    },
    "osm_levels": {
        "label": "OpenStreetMap building:levels",
        "url": "https://wiki.openstreetmap.org/wiki/Key:building:levels",
        "conversion_rule": "levels_x_assumed_floor_height",
        "confidence": "medium",
        "notes": ("Floor count converted with an assumed storey height. "
                  "Levels exclude underground and roof levels."),
    },
    "county_stories": {
        "label": "Allegheny County property assessment STORIES",
        "url": "https://data.wprdc.org/dataset/property-assessments",
        "conversion_rule": "levels_x_assumed_floor_height",
        "confidence": "medium",
        "notes": ("Dwelling characteristic, so it is weak for institutional "
                  "and commercial buildings; values top out at 4 storeys."),
    },
    "modeled_default": {
        "label": "Modelled estimate by building type and footprint size",
        "url": None,
        "conversion_rule": "legacy_manual",
        "confidence": "low",
        "notes": ("No height source exists for this building. Estimated from "
                  "the median measured height of the same building type at a "
                  "similar footprint size. Not measured data."),
    },
}
ROOF_STOREY_M = 2.0   # roof levels are shallower than occupied floors
MIN_HEIGHT_M = 2.5    # sheds and garages still cast some shadow


# --- sources ---------------------------------------------------------------

def fetch_buildings() -> gpd.GeoDataFrame:
    g = ox.features.features_from_bbox(
        bbox=(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]),
        tags={"building": True},
    )
    g = g[g.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    return g.to_crs(CRS_METRIC)


def fetch_building_parts() -> gpd.GeoDataFrame:
    """OSM 3D building:part polygons - sparse, but accurate where present."""
    try:
        g = ox.features.features_from_bbox(
            bbox=(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]),
            tags={"building:part": True},
        )
    except Exception:
        return gpd.GeoDataFrame({"geometry": []}, crs=CRS_WGS84).to_crs(CRS_METRIC)
    g = g[g.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    return g.to_crs(CRS_METRIC)


def join_part_heights(bld: gpd.GeoDataFrame, parts: gpd.GeoDataFrame) -> pd.Series:
    """Tallest building:part whose centroid falls inside each footprint."""
    if parts.empty:
        return pd.Series(np.nan, index=bld.index)
    h = parts.apply(lambda r: osm_height(r) if not np.isnan(osm_height(r))
                    else osm_levels_height(r), axis=1)
    pts = gpd.GeoDataFrame({"h": h}, geometry=parts.geometry.centroid,
                           crs=parts.crs).dropna(subset=["h"])
    if pts.empty:
        return pd.Series(np.nan, index=bld.index)
    hit = gpd.sjoin(pts, bld[["geometry"]], how="inner", predicate="within")
    return hit.groupby("index_right")["h"].max().reindex(bld.index)


def fetch_parcel_stories(force: bool = False) -> pd.DataFrame:
    """Parcel centroids in the bbox, carrying the county STORIES field."""
    if PARCELS_RAW.exists() and not force:
        return pd.DataFrame(json.loads(PARCELS_RAW.read_text()))
    sql = f'''SELECT c."PIN", c."LAT", c."LONG", c."CITY_NEIGHBORHOOD",
        a."STORIES", a."YEARBLT", a."CLASSDESC", a."USEDESC"
        FROM "{RES_CENTROIDS}" c LEFT JOIN "{RES_ASSESS}" a ON c."PIN" = a."PARID"
        WHERE c."LAT" BETWEEN {BBOX["south"]} AND {BBOX["north"]}
          AND c."LONG" BETWEEN {BBOX["west"]} AND {BBOX["east"]}'''
    r = requests.get(WPRDC_SQL, params={"sql": sql}, timeout=180)
    r.raise_for_status()
    recs = r.json()["result"]["records"]
    PARCELS_RAW.parent.mkdir(parents=True, exist_ok=True)
    PARCELS_RAW.write_text(json.dumps(recs))
    return pd.DataFrame(recs)


# --- height ladder ---------------------------------------------------------

def _num(val) -> float:
    """OSM tag values are dirty: '12', '12 m', '12;14', ' 3.5 '."""
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return np.nan
    try:
        return float(str(val).split(";")[0].lower().replace("m", "").strip())
    except (ValueError, AttributeError):
        return np.nan


def osm_height(row) -> float:
    for col in ("height", "building:height"):
        h = _num(row.get(col))
        if not np.isnan(h) and 0 < h < 400:
            return h
    return np.nan


def osm_levels_height(row) -> float:
    lv = _num(row.get("building:levels"))
    if np.isnan(lv):
        lv = _num(row.get("levels"))
    if np.isnan(lv) or not (0 < lv < 120):
        return np.nan
    roof = _num(row.get("roof:levels"))
    roof = 0.0 if np.isnan(roof) or roof < 0 or roof > 5 else roof
    return lv * STOREY_M + roof * ROOF_STOREY_M


def join_county_stories(bld: gpd.GeoDataFrame, parcels: pd.DataFrame) -> pd.Series:
    """Height implied by assessment STORIES, matched by containing footprint.

    STORIES is a dwelling characteristic, so this mostly rescues houses. It is
    close to useless for Oakland's institutional and commercial buildings,
    which is exactly what the manual tier is for.
    """
    p = parcels.dropna(subset=["STORIES"]).copy()
    p["st"] = pd.to_numeric(p["STORIES"], errors="coerce")
    p = p[(p["st"] > 0) & (p["st"] < 60)]
    if p.empty:
        return pd.Series(np.nan, index=bld.index)

    pts = gpd.GeoDataFrame(
        p, geometry=[Point(xy) for xy in zip(p["LONG"], p["LAT"])], crs=CRS_WGS84
    ).to_crs(CRS_METRIC)

    hit = gpd.sjoin(pts[["st", "geometry"]], bld[["geometry"]],
                    how="inner", predicate="within")
    # A footprint can contain several parcels (row houses); take the tallest,
    # since the shadow is cast by the tallest part of the massing.
    per = hit.groupby("index_right")["st"].max()
    return per.reindex(bld.index) * STOREY_M


# Footprint size classes, in m2. Chosen to separate row houses from
# mid-blocks from institutional slabs rather than by any statistical rule.
SIZE_BINS = [0, 300, 1000, 3000, float("inf")]
SIZE_LABELS = ["s", "m", "l", "xl"]
MIN_SUPPORT = 5  # observations needed before a group median is trusted


def modeled_defaults(bld: gpd.GeoDataFrame, known: pd.Series) -> pd.Series:
    """Estimate height from building type and footprint size.

    Backs off through three progressively coarser groupings so a rare type or
    an unusual size never rests on one or two observations:
        (building type, size class) -> (size class) -> (building type) -> all
    """
    df = pd.DataFrame({
        "b": bld["building"].astype(str),
        "sz": pd.cut(bld["area_m2"], SIZE_BINS, labels=SIZE_LABELS,
                     include_lowest=True).astype(str),
        "h": known.values,
    }, index=bld.index)
    obs = df.dropna(subset=["h"])
    overall = float(obs["h"].median()) if not obs.empty else 8.0

    def table(keys):
        g = obs.groupby(keys)["h"]
        return g.median()[g.size() >= MIN_SUPPORT]

    by_type_size = table(["b", "sz"])
    by_size = table(["sz"])
    by_type = table(["b"])

    idx = pd.MultiIndex.from_arrays([df["b"], df["sz"]])
    out = pd.Series(by_type_size.reindex(idx).values, index=df.index)
    out = out.fillna(pd.Series(by_size.reindex(df["sz"]).values, index=df.index))
    out = out.fillna(pd.Series(by_type.reindex(df["b"]).values, index=df.index))
    return out.fillna(overall)


def load_manual() -> dict:
    if MANUAL_PATH.exists():
        return {k: v for k, v in json.loads(MANUAL_PATH.read_text()).items()
                if not k.startswith("_")}
    return {}


def resolve_heights(bld: gpd.GeoDataFrame, parcels: pd.DataFrame,
                    parts: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    h_part = join_part_heights(bld, parts)
    h_osm = bld.apply(osm_height, axis=1)
    h_lvl = bld.apply(osm_levels_height, axis=1)
    h_cty = join_county_stories(bld, parcels)
    manual = load_manual()
    h_man = bld["bldg_id"].map(manual).astype(float)

    # Highest-confidence rung wins.
    height = pd.Series(np.nan, index=bld.index, dtype=float)
    source = pd.Series("", index=bld.index, dtype=object)
    for series, label in [(h_man, "manual"), (h_part, "osm_part"),
                          (h_osm, "osm_height"), (h_lvl, "osm_levels"),
                          (h_cty, "county_stories")]:
        take = height.isna() & series.notna()
        height[take] = series[take]
        source[take] = label

    measured = height.copy()  # defaults must not train the defaults
    fill = modeled_defaults(bld, measured)
    take = height.isna()
    height[take] = fill[take]
    source[take] = "modeled_default"

    bld["height_m"] = height.clip(lower=MIN_HEIGHT_M).round(2)
    bld["height_source"] = source
    bld["height_is_measured"] = source != "modeled_default"

    # Record-level provenance. What the number came from, how it was
    # converted, and how much to trust it - carried to the UI, not inferred
    # there.
    raw = pd.Series(np.nan, index=bld.index, dtype=object)
    raw[source == "osm_part"] = h_part[source == "osm_part"].round(2)
    raw[source == "osm_height"] = h_osm[source == "osm_height"].round(2)
    lv = bld.apply(lambda r: _num(r.get("building:levels")), axis=1)
    raw[source == "osm_levels"] = lv[source == "osm_levels"]
    raw[source == "county_stories"] = (h_cty[source == "county_stories"]
                                       / STOREY_M).round(1)
    raw[source == "manual"] = h_man[source == "manual"]

    meta = source.map(SOURCE_META)
    bld["height_source_label"] = meta.map(lambda m: m["label"])
    bld["height_source_url"] = meta.map(lambda m: m["url"])
    bld["conversion_rule"] = meta.map(lambda m: m["conversion_rule"])
    bld["confidence"] = meta.map(lambda m: m["confidence"])
    bld["height_notes"] = meta.map(lambda m: m["notes"])
    bld["raw_source_value"] = raw
    bld["assumed_floor_height_m"] = np.where(
        source.isin(["osm_levels", "county_stories"]), STOREY_M, np.nan)
    bld["verified_at"] = datetime.now(timezone.utc).date().isoformat()
    return bld


# --- main ------------------------------------------------------------------

def main() -> None:
    print("STEP 2  building footprints + tiered heights")
    raw = fetch_buildings()
    print(f"  OSM building polygons: {len(raw)}")

    # osmnx 2.x indexes features by ('element', 'id'); 'w1234' / 'r5678'
    bld = raw.reset_index()
    bld["bldg_id"] = bld["element"].astype(str).str[0] + bld["id"].astype(str)
    name = bld["name"] if "name" in bld.columns else pd.Series(None, index=bld.index)
    bld["bldg_name"] = name
    bld = bld[bld.geometry.notna() & bld.geometry.is_valid].copy()
    bld["area_m2"] = bld.geometry.area.round(1)
    bld = bld[bld["area_m2"] >= 10].copy()   # drop map noise
    print(f"  usable footprints (>=10 m2): {len(bld)}")

    parcels = fetch_parcel_stories()
    print(f"  county parcels in bbox: {len(parcels)}  "
          f"(STORIES on {parcels['STORIES'].notna().sum()})")
    parts = fetch_building_parts()
    print(f"  OSM building:part polygons: {len(parts)}")

    bld = resolve_heights(bld, parcels, parts)

    keep = ["bldg_id", "bldg_name", "building", "area_m2", "height_m",
            "height_source", "height_source_label", "height_source_url",
            "raw_source_value", "conversion_rule", "assumed_floor_height_m",
            "confidence", "height_notes", "verified_at",
            "height_is_measured", "geometry"]
    out = bld[[c for c in keep if c in bld.columns]].copy()
    out["building"] = out["building"].astype(str)
    out["bldg_name"] = out["bldg_name"].astype(object).where(out["bldg_name"].notna(), None)
    out.to_crs(CRS_WGS84).to_file(BUILDINGS_PATH, driver="GeoJSON")

    print("  height source ladder:")
    tot_a = out["area_m2"].sum()
    for src, grp in out.groupby("height_source"):
        print(f"    {src:16} {len(grp):5} bldgs ({len(grp)/len(out)*100:5.1f}%)  "
              f"{grp.area_m2.sum()/tot_a*100:5.1f}% of area  "
              f"median {grp.height_m.median():5.1f} m")
    meas = out["height_is_measured"]
    print(f"  MEASURED: {meas.sum()}/{len(out)} buildings "
          f"({meas.mean()*100:.1f}%), {out[meas].area_m2.sum()/tot_a*100:.1f}% of footprint area")
    print("  confidence:")
    for conf, grp in out.groupby("confidence"):
        print(f"    {conf:8} {len(grp):5} bldgs ({len(grp)/len(out)*100:5.1f}%)  "
              f"{grp.area_m2.sum()/tot_a*100:5.1f}% of area")
    missing = out[out[["height_source_label", "conversion_rule",
                       "confidence"]].isna().any(axis=1)]
    print(f"  records missing provenance: {len(missing)}")

    seg = gpd.read_file(CACHE / "segments.geojson").to_crs(CRS_METRIC)
    bm = out.to_crs(CRS_METRIC)
    print("  shadow-casting coverage near hero corridors (60 m buffer):")
    for nm in CORRIDORS:
        s = seg[seg["corridor"] == nm]
        if s.empty:
            continue
        near = bm[bm.geometry.intersects(s.geometry.buffer(60).union_all())]
        print(f"    {nm:20} {len(near):4} bldgs  measured "
              f"{near.height_is_measured.mean()*100:5.1f}%  "
              f"({near[near.height_is_measured].area_m2.sum()/near.area_m2.sum()*100:.1f}% of area)  "
              f"tallest {near.height_m.max():.0f} m")
    print(f"  wrote {BUILDINGS_PATH.name}")


def emit_candidates(top: int = 25) -> None:
    """Write a manual-patch template for the tallest-impact unmeasured buildings.

    These are the buildings whose height is currently a model estimate AND
    which sit close enough to a hero corridor to actually move its shadows.
    Filling a height here promotes it to the 'manual' rung of the ladder.
    """
    bld = gpd.read_file(BUILDINGS_PATH).to_crs(CRS_METRIC)
    seg = gpd.read_file(CACHE / "segments.geojson").to_crs(CRS_METRIC)
    hero = seg[seg["corridor"].isin(CORRIDORS)].geometry.buffer(60).union_all()

    cand = bld[(~bld["height_is_measured"]) & bld.geometry.intersects(hero)]
    cand = cand.sort_values("area_m2", ascending=False).head(top)

    out = {
        "_README": ("Hand-patched building heights in metres, keyed by bldg_id. "
                    "These override every automatic tier. Set a number to use "
                    "it; leave null to fall back to the ladder. Heights entered "
                    "here are prototype estimates unless a source is noted."),
        "_generated_for": "unmeasured buildings within 60 m of a hero corridor",
    }
    for _, r in cand.iterrows():
        out[r["bldg_id"]] = None
        out[f"_note_{r['bldg_id']}"] = (
            f"{r['bldg_name'] or '(unnamed)'} | building={r['building']} | "
            f"{r['area_m2']:.0f} m2 | model estimate {r['height_m']:.1f} m")

    path = MANUAL_PATH.parent / "building_heights.candidates.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2))
    print(f"  wrote {path.name}: {len(cand)} candidates covering "
          f"{cand.area_m2.sum():.0f} m2 of unmeasured hero-corridor footprint")


if __name__ == "__main__":
    import sys
    main()
    if "--candidates" in sys.argv:
        emit_candidates()
