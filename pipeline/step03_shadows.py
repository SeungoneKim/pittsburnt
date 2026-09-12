"""Step 3 - building shadows -> sun_exposure(segment, hour).

The brief's shadow math:  shadow length = height / tan(solar altitude)

A shadow is the polygon swept by translating a footprint along the
anti-solar direction. Taking the convex hull of the footprint and its
translate would be wrong for L-shaped and courtyard buildings, so the sweep
is built properly: the footprint, its translate, and a quad for every
boundary edge joining the two.

The output that matters is sun_exposure.npz - an [n_segments x n_hours]
array in [0, 1] giving the unshaded fraction of each segment. Everything the
runtime engine does is array arithmetic on top of it.
"""
from __future__ import annotations

import json

import geopandas as gpd
import numpy as np
import pandas as pd
import pvlib
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

from config import (CACHE, CENTER, CRS_METRIC, CRS_WGS84, HOURS, HOUR_LABELS,
                    SOLAR_DATE, TIMEZONE)

SUN_PATH = CACHE / "sun_exposure.npz"
SOLAR_PATH = CACHE / "solar_positions.json"

# Past this the sun is so low that shadow geometry stops being meaningful and
# the whole street is in shade anyway.
MIN_ALTITUDE_DEG = 3.0
MAX_SHADOW_M = 400.0


def solar_positions() -> pd.DataFrame:
    """Apparent elevation + azimuth at each snapshot hour, for the frozen date."""
    lat, lon = CENTER
    times = pd.DatetimeIndex(
        [f"{SOLAR_DATE} {h:02d}:00:00" for h in HOURS]
    ).tz_localize(TIMEZONE)
    sp = pvlib.solarposition.get_solarposition(times, lat, lon)
    sp["hour"] = HOURS
    return sp[["hour", "apparent_elevation", "azimuth"]]


def shadow_vector(elevation_deg: float, azimuth_deg: float, height_m: float
                  ) -> tuple[float, float]:
    """Offset (east, north) in metres from a footprint to its shadow tip."""
    alt = np.radians(max(elevation_deg, MIN_ALTITUDE_DEG))
    length = min(height_m / np.tan(alt), MAX_SHADOW_M)
    # Azimuth is clockwise from north; the shadow points the opposite way.
    az = np.radians(azimuth_deg)
    return -length * np.sin(az), -length * np.cos(az)


def sweep(poly: Polygon, dx: float, dy: float) -> Polygon:
    """Region swept by translating `poly` along (dx, dy) - the shadow body."""
    parts = [poly, translate(poly, dx, dy)]
    rings = [poly.exterior] + list(poly.interiors)
    for ring in rings:
        cs = list(ring.coords)
        for (x0, y0), (x1, y1) in zip(cs[:-1], cs[1:]):
            quad = Polygon([(x0, y0), (x1, y1),
                            (x1 + dx, y1 + dy), (x0 + dx, y0 + dy)])
            if quad.is_valid and quad.area > 0:
                parts.append(quad)
    return unary_union(parts)


def build_hour_shadow(bld: gpd.GeoDataFrame, elev: float, azim: float):
    """Union of every building's shadow at one instant."""
    if elev <= MIN_ALTITUDE_DEG:
        return None  # sun effectively down: handled as full shade upstream
    shadows = []
    for geom, h in zip(bld.geometry.values, bld["height_m"].values):
        dx, dy = shadow_vector(elev, azim, float(h))
        polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
        for p in polys:
            if p.is_valid and p.area > 0:
                shadows.append(sweep(p, dx, dy))
    return unary_union(shadows)


def main() -> None:
    print("STEP 3  building shadows -> sun_exposure(segment, hour)")
    bld = gpd.read_file(CACHE / "buildings.geojson").to_crs(CRS_METRIC)
    seg = gpd.read_file(CACHE / "segments.geojson").to_crs(CRS_METRIC)
    print(f"  {len(bld)} buildings, {len(seg)} segments")

    sp = solar_positions()
    print(f"  solar geometry for {SOLAR_DATE} ({TIMEZONE}):")
    for _, r in sp.iterrows():
        alt = r["apparent_elevation"]
        ratio = (1 / np.tan(np.radians(max(alt, MIN_ALTITUDE_DEG))))
        print(f"    {HOUR_LABELS[int(r['hour'])]:>5}  elevation {alt:5.1f}°  "
              f"azimuth {r['azimuth']:5.1f}°  shadow = {ratio:4.2f} x height")

    seg_ids = seg["seg_id"].tolist()
    lengths = seg["length_m"].to_numpy()
    sun = np.ones((len(seg), len(HOURS)), dtype=np.float32)

    for hi, (_, r) in enumerate(sp.iterrows()):
        hour = int(r["hour"])
        shade = build_hour_shadow(bld, r["apparent_elevation"], r["azimuth"])
        if shade is None:
            sun[:, hi] = 0.0
            print(f"    {HOUR_LABELS[hour]:>5}  sun below horizon - full shade")
            continue

        shaded = seg.geometry.intersection(shade).length.to_numpy()
        frac = np.clip(shaded / np.maximum(lengths, 1e-6), 0.0, 1.0)
        sun[:, hi] = 1.0 - frac

        gpd.GeoDataFrame(geometry=[shade], crs=CRS_METRIC).to_crs(CRS_WGS84) \
            .to_file(CACHE / f"shadow_{hour:02d}.geojson", driver="GeoJSON")
        print(f"    {HOUR_LABELS[hour]:>5}  shaded {frac.mean()*100:5.1f}% of "
              f"segment length (by metres {shaded.sum()/lengths.sum()*100:5.1f}%)  "
              f"| fully sunlit {int((frac < .01).sum()):4}  "
              f"fully shaded {int((frac > .99).sum()):4}")

    np.savez_compressed(SUN_PATH, sun_exposure=sun,
                        seg_ids=np.array(seg_ids), hours=np.array(HOURS))
    SOLAR_PATH.write_text(json.dumps({
        "date": SOLAR_DATE, "timezone": TIMEZONE,
        "lat": CENTER[0], "lon": CENTER[1],
        "positions": [{"hour": int(r["hour"]),
                       "elevation_deg": round(float(r["apparent_elevation"]), 3),
                       "azimuth_deg": round(float(r["azimuth"]), 3)}
                      for _, r in sp.iterrows()],
    }, indent=2))
    print(f"  wrote {SUN_PATH.name} {sun.shape} and per-hour shadow polygons")


if __name__ == "__main__":
    main()
