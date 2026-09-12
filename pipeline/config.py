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

# --- Determinism -----------------------------------------------------------
SEED = 20260911
N_TRIPS = 300

