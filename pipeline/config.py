"""Frozen scope + shared constants for the Pittsburnt pipeline.

Everything downstream reads from here. The bbox and corridor list are
deliberately locked (brief H0-1: "Freeze Oakland bbox + three corridors")
so that every artifact in data/cache is reproducible from a fixed input.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
RAW = ROOT / "data" / "raw"

# Keep OSMnx's raw Overpass responses out of the repo root and out of git;
# the cached .graphml files are the reproducible artifact, not these.
import osmnx as _ox  # noqa: E402
_ox.settings.cache_folder = str(RAW / "osm_cache")
_ox.settings.use_cache = True

# --- Scope -----------------------------------------------------------------
# Oakland, Pittsburgh. Covers the Forbes / Fifth / Craig demo corridors plus
# enough surrounding grid that synthetic trips have somewhere to go.
BBOX = {
    "west": -79.9690,
    "south": 40.4360,
    "east": -79.9405,
    "north": 40.4545,
}
CENTER = (40.4443, -79.9530)  # lat, lon - map initial view

# The three hero corridors the demo narrates.
CORRIDORS = ["Forbes Avenue", "Fifth Avenue", "South Craig Street"]

# In Oakland the main carriageways are tagged sidewalk=separate, so OSMnx's
# walk filter drops them and pedestrians route on unnamed footways instead.
# We therefore pull named centrelines from the drive network and attach each
# sidewalk to the roadway it runs alongside, within these tolerances.
CORRIDOR_MAX_DIST_M = 30.0
CORRIDOR_MAX_ANGLE_DEG = 35.0

# --- Projection ------------------------------------------------------------
# All metric work (segment lengths, shadow geometry, canopy buffers) happens
# in this projected CRS. Artifacts are written back out in WGS84.
CRS_WGS84 = "EPSG:4326"
CRS_METRIC = "EPSG:32617"  # UTM zone 17N - covers Pittsburgh

# --- Segmentation ----------------------------------------------------------
SEGMENT_TARGET_M = 100.0   # aim for ~100m segments
SEGMENT_MIN_M = 50.0       # never emit anything shorter than this
SEGMENT_MAX_M = 150.0      # split anything longer than this

# --- Time snapshots --------------------------------------------------------
# The brief's 8 AM / 12 PM / 3 PM / 6 PM buttons. Sun position, shadows and
# pedestrian demand are all precomputed at exactly these four hours.
HOURS = [8, 12, 15, 18]
HOUR_LABELS = {8: "8 AM", 12: "12 PM", 15: "3 PM", 18: "6 PM"}

# Reference date for solar geometry: a hot summer day in Pittsburgh.
# Shadows are a function of date+time, so this is frozen too.
SOLAR_DATE = "2026-07-21"
TIMEZONE = "America/New_York"

# --- Personas --------------------------------------------------------------
# Each persona is a synthetic trip population: where it starts, what it walks
# toward, how fast, and when it is out.
#
# planning_weight is a CITY PRIORITY, not a physiological risk coefficient.
# The brief is explicit about this and so is the UI: weighting older adults
# above the average walker is a statement about who a heat plan should
# protect first, not a claim about anyone's medical outcome. Exposure is
# always reported unweighted alongside the weighted figure.
#
# Walking speeds are disclosed planning assumptions in m/s, and this table is
# their single source of truth. Slower walkers accumulate more exposure simply
# by being outside longer, which is the mechanism the brief asks for - there
# are no invented physiological multipliers anywhere in the model.
# "all" is NOT sampled. It is the aggregation of the four persona cohorts
# below, so it is arithmetically consistent with them - selecting it shows the
# whole modelled population, not a fifth independent draw that happens to
# disagree with the sum of its parts.
DERIVED_PERSONA = "all"
DERIVED_PERSONA_LABEL = "All pedestrians"

PERSONAS = {
    "students": {
        "label": "Students",
        "speed_mps": 1.30,
        "planning_weight": 1.0,
        "max_trip_m": 1800,
        "destinations": ["university", "college", "school", "library",
                         "dormitory"],
        "departure_mix": {8: 0.25, 12: 0.30, 15: 0.30, 18: 0.15},
    },
    "older_adults": {
        "label": "Older adults",
        "speed_mps": 0.90,
        "planning_weight": 1.4,
        "max_trip_m": 900,
        "destinations": ["retail", "supermarket", "commercial",
                         "church", "cathedral", "hospital"],
        "departure_mix": {8: 0.20, 12: 0.40, 15: 0.30, 18: 0.10},
    },
    "workers": {
        "label": "Workers",
        "speed_mps": 1.20,
        "planning_weight": 1.0,
        "max_trip_m": 2000,
        "destinations": ["hospital", "office", "commercial", "university",
                         "industrial"],
        "departure_mix": {8: 0.35, 12: 0.20, 15: 0.10, 18: 0.35},
    },
    "mobility_constrained": {
        "label": "Mobility-constrained",
        "speed_mps": 0.80,
        "planning_weight": 1.6,
        "max_trip_m": 600,
        "destinations": ["retail", "supermarket", "hospital", "commercial",
                         "church", "cathedral"],
        "departure_mix": {8: 0.20, 12: 0.40, 15: 0.30, 18: 0.10},
    },
}

# OSM building values treated as places people start a walking trip from.
RESIDENTIAL_BUILDINGS = ["house", "residential", "apartments", "detached",
                         "semidetached_house", "terrace", "dormitory",
                         "bungalow"]

# --- Determinism -----------------------------------------------------------
# Every trip population is regenerated from this seed, so the before/after
# comparison runs the identical people over the identical geometry.
SEED = 20260911
N_TRIPS = 300

