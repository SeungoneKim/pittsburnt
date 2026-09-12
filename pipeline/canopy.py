"""Tree canopy baseline from the Allegheny County Urban Tree Canopy raster.

Why not the City tree inventory: it covers only street trees in the public
right-of-way - ~2,500 points in a bbox that contains Schenley Park, Pitt and
CMU. Driving canopy shade from those points alone put tree shade at 0.6% of
the network, which is plainly wrong for Oakland.

This is the Tree Pittsburgh / University of Vermont land-cover classification
(lidar + high-resolution imagery). Tree canopy is the green class, and it
covers ~34% of the study area - park, campus and backyard canopy included.

Vintage note: this layer is 2010. The brief flags exactly this ("2020 vintage
... expose vintage/limitations rather than imply real-time completeness"), so
canopy_vintage travels with the artifact and belongs in the assumptions panel.
"""
from __future__ import annotations

import io
import json

import geopandas as gpd
import numpy as np
import requests
from PIL import Image
from shapely.geometry import box

from config import BBOX, CRS_METRIC, CRS_WGS84, RAW

SERVICE = ("https://imagery.pasda.psu.edu/arcgis/rest/services/pasda/"
           "AlleghenyCountyUrbanTreeCanopy2010/MapServer/export")
MASK_PATH = RAW / "canopy_mask.npz"
CANOPY_VINTAGE = "2010"
CANOPY_SOURCE = "Allegheny County Urban Tree Canopy 2010 (Tree Pittsburgh / Univ. of Vermont)"

# Class colours in the served rendering, sampled from the raster itself.
CANOPY_RGB = (0, 128, 0)
PIXEL_M = 1.0          # one metre per pixel, for the simulation raster
MAX_PIXELS = 4000      # service-side export cap

# A second, wider raster exists only so the map does not end in a hard green
# rectangle. Drawing canopy for the study area alone makes leafy neighbours
# like Squirrel Hill and Shadyside look bare, because "no data" and "no
# trees" render identically. This layer is never sampled for exposure - the
# simulation still runs on the narrow study area and nothing else.
CONTEXT_PAD_M = 3000.0
CONTEXT_PIXEL_M = 4.0
CONTEXT_PATH = RAW / "canopy_context.npz"


def _metric_bounds(pad_m: float = 0.0) -> tuple[float, float, float, float]:
    bb = gpd.GeoSeries(
        [box(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"])],
        crs=CRS_WGS84).to_crs(CRS_METRIC).iloc[0]
    minx, miny, maxx, maxy = bb.bounds
    return (minx - pad_m, miny - pad_m, maxx + pad_m, maxy + pad_m)


def _fetch_mask(minx: float, miny: float, maxx: float, maxy: float,
                pixel_m: float) -> np.ndarray:
    """Export the land-cover rendering and keep only the tree-canopy class."""
    w = int(np.ceil((maxx - minx) / pixel_m))
    h = int(np.ceil((maxy - miny) / pixel_m))
    if max(w, h) > MAX_PIXELS:
        raise RuntimeError(f"export {w}x{h} exceeds service cap {MAX_PIXELS}")

    epsg = int(CRS_METRIC.split(":")[1])
    r = requests.get(SERVICE, params={
        "bbox": f"{minx},{miny},{maxx},{maxy}", "bboxSR": epsg, "imageSR": epsg,
        "size": f"{w},{h}", "format": "png", "transparent": "false",
        "f": "image", "layers": "show:0",
    }, timeout=300)
    r.raise_for_status()
    rgb = np.array(Image.open(io.BytesIO(r.content)).convert("RGB"))
    mask = np.all(rgb == np.array(CANOPY_RGB, dtype=np.uint8), axis=-1)
    # PNG rows run north->south; flip so row index increases with northing.
    return np.flipud(mask)


def build_context_mask(force: bool = False) -> tuple[np.ndarray, tuple]:
    """Coarser canopy over a padded area, for display context only."""
    if CONTEXT_PATH.exists() and not force:
        z = np.load(CONTEXT_PATH)
        return z["mask"], (float(z["minx"]), float(z["miny"]), float(z["pixel_m"]))
    minx, miny, maxx, maxy = _metric_bounds(CONTEXT_PAD_M)
    mask = _fetch_mask(minx, miny, maxx, maxy, CONTEXT_PIXEL_M)
    CONTEXT_PATH.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(CONTEXT_PATH, mask=mask, minx=minx, miny=miny,
                        pixel_m=CONTEXT_PIXEL_M)
    return mask, (minx, miny, CONTEXT_PIXEL_M)


def build_mask(force: bool = False) -> tuple[np.ndarray, tuple]:
    """Boolean canopy mask plus its (minx, miny, pixel_m) georeference.

    The export is requested directly in the metric CRS so a pixel is a square
    metre and sampling is a plain array index, with no reprojection per point.
    """
    if MASK_PATH.exists() and not force:
        z = np.load(MASK_PATH)
        return z["mask"], (float(z["minx"]), float(z["miny"]), float(z["pixel_m"]))

    minx, miny, maxx, maxy = _metric_bounds()
    mask = _fetch_mask(minx, miny, maxx, maxy, PIXEL_M)
    MASK_PATH.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(MASK_PATH, mask=mask, minx=minx, miny=miny,
                        pixel_m=PIXEL_M)
    return mask, (minx, miny, PIXEL_M)


def sample(mask: np.ndarray, geo: tuple, xs: np.ndarray, ys: np.ndarray
           ) -> np.ndarray:
    """Is there canopy at each (x, y) in metric coordinates? Outside = False."""
    minx, miny, px = geo
    col = np.floor((xs - minx) / px).astype(np.int64)
    row = np.floor((ys - miny) / px).astype(np.int64)
    ok = (row >= 0) & (row < mask.shape[0]) & (col >= 0) & (col < mask.shape[1])
    out = np.zeros(xs.shape, dtype=bool)
    out[ok] = mask[row[ok], col[ok]]
    return out


if __name__ == "__main__":
    mask, geo = build_mask()
    print(f"  simulation mask {mask.shape[1]}x{mask.shape[0]} px @ {geo[2]:.0f} m")
    print(f"  canopy cover: {mask.mean()*100:.1f}% of the study area")
    cmask, cgeo = build_context_mask()
    print(f"  context mask   {cmask.shape[1]}x{cmask.shape[0]} px @ {cgeo[2]:.0f} m "
          f"({CONTEXT_PAD_M/1000:.0f} km pad, display only)")
    print(f"  context cover: {cmask.mean()*100:.1f}%")
    print(f"  source: {CANOPY_SOURCE}")
