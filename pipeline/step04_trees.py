"""Step 4 - existing tree canopy -> the other half of sun_exposure.

Canopy shade comes from the Allegheny County Urban Tree Canopy raster, not
from the City street-tree inventory: the inventory only covers the public
right-of-way, and using it alone put tree shade at 0.6% of the network in a
bbox containing Schenley Park and two campuses. The raster sees 32% canopy.

The inventory is still loaded and written out - it carries per-tree crown
width and height, which is what the ADAPT step needs to size a *new* tree,
and it is what the representative canopy height below is derived from.

At 3 PM in July the sun is still ~62 degrees up, so building shadows are
short (0.54 x height) and shade only ~11% of the network. Trees, whose crowns
sit directly over the footway, are what actually shades a pedestrian at the
hottest hour. This step is therefore load-bearing for the demo, not a detail.

Shade is stored decomposed, not merged:
    shade_bldg[seg, hour]  fraction of the segment in building shadow
    shade_tree[seg, hour]  fraction shaded by canopy and NOT already in
                           building shadow (so the two never double-count)
    sun_exposure = 1 - shade_bldg - CANOPY_BLOCK * shade_tree
Keeping them apart is what lets the ADAPT step add or remove canopy later
without recomputing building geometry.
"""
from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import Point

import canopy as canopy_mod
from config import CACHE, CRS_METRIC, CRS_WGS84, HOURS, HOUR_LABELS, RAW
from step03_shadows import shadow_vector, solar_positions

TREES_PATH = CACHE / "trees.geojson"
SUN_PATH = CACHE / "sun_exposure.npz"
TREES_CSV = RAW / "city_trees_bbox.csv"
TREES_DUMP = "https://data.wprdc.org/datastore/dump/1515a93c-73e3-4425-9b35-1cd11b2196da"

FT_TO_M = 0.3048
# A closed canopy transmits some direct beam; it is not an opaque roof.
CANOPY_BLOCK = 0.85
# Crown centre sits below the top of the tree, which is what casts the shadow.
CROWN_CENTRE_FRAC = 0.65
MIN_CROWN_RADIUS_M = 1.0

# Inventory rows that are not standing trees.
NOT_A_TREE = ("stump", "vacant")
NO_CANOPY_CONDITION = ("dead",)


def load_trees(force: bool = False) -> pd.DataFrame:
    if TREES_CSV.exists() and not force:
        df = pd.read_csv(TREES_CSV, low_memory=False)
    else:
        from config import BBOX
        df = pd.read_csv(TREES_DUMP, low_memory=False)
        for c in ("latitude", "longitude"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        df = df[df.latitude.between(BBOX["south"], BBOX["north"])
                & df.longitude.between(BBOX["west"], BBOX["east"])]
        TREES_CSV.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(TREES_CSV, index=False)
    for c in ("latitude", "longitude", "height", "width"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def clean_and_impute(df: pd.DataFrame) -> gpd.GeoDataFrame:
    """Drop non-trees, then fill missing crown dimensions from species medians."""
    name = df["common_name"].astype(str).str.lower()
    cond = df["condition"].astype(str).str.lower()
    keep = (df["common_name"].notna()
            & ~name.str.contains("|".join(NOT_A_TREE), na=False)
            & ~cond.isin(NO_CANOPY_CONDITION)
            & df["latitude"].notna() & df["longitude"].notna())
    t = df[keep].copy()

    # The inventory is in feet, and records 0 where a dimension was not taken.
    for c in ("height", "width"):
        t[c] = t[c].where(t[c] > 0) * FT_TO_M

    # Impute from the same species where there is enough support, so a young
    # London planetree is not given the crown of a mature oak.
    for c in ("height", "width"):
        grp = t.dropna(subset=[c]).groupby("common_name")[c]
        med = grp.median()[grp.size() >= 5]
        t[f"{c}_imputed"] = t[c].isna()
        t[c] = t[c].fillna(t["common_name"].map(med)).fillna(t[c].median())

    t["crown_r_m"] = (t["width"] / 2).clip(lower=MIN_CROWN_RADIUS_M)
    t["crown_h_m"] = (t["height"] * CROWN_CENTRE_FRAC).clip(lower=1.5)

    g = gpd.GeoDataFrame(
        t[["common_name", "condition", "height", "width", "crown_r_m",
           "crown_h_m", "height_imputed", "width_imputed", "neighborhood"]],
        geometry=[Point(xy) for xy in zip(t["longitude"], t["latitude"])],
        crs=CRS_WGS84,
    ).to_crs(CRS_METRIC)
    g["tree_id"] = [f"t{i:05d}" for i in range(len(g))]
    return g


SAMPLE_SPACING_M = 2.0


def sample_points(seg: gpd.GeoDataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Evenly spaced points along every segment, tagged with their segment row."""
    xs, ys, owner = [], [], []
    for i, (geom, L) in enumerate(zip(seg.geometry.values, seg["length_m"].values)):
        n = max(1, int(np.ceil(L / SAMPLE_SPACING_M)))
        for k in range(n):
            pt = geom.interpolate((k + 0.5) / n, normalized=True)
            xs.append(pt.x); ys.append(pt.y); owner.append(i)
    return np.array(xs), np.array(ys), np.array(owner)


def main() -> None:
    print("STEP 4  tree canopy -> sun_exposure")
    raw = load_trees()
    trees = clean_and_impute(raw)
    print(f"  inventory rows in bbox: {len(raw)}  ->  standing trees: {len(trees)}")
    print(f"  crown radius: median {trees.crown_r_m.median():.1f} m  "
          f"max {trees.crown_r_m.max():.1f} m")
    print(f"  crown height: median {trees.crown_h_m.median():.1f} m  "
          f"max {trees.crown_h_m.max():.1f} m")
    print(f"  imputed dimensions: height {trees.height_imputed.mean()*100:.0f}%  "
          f"width {trees.width_imputed.mean()*100:.0f}%")
    trees.to_crs(CRS_WGS84).to_file(TREES_PATH, driver="GeoJSON")

    seg = gpd.read_file(CACHE / "segments.geojson").to_crs(CRS_METRIC)
    lengths = seg["length_m"].to_numpy()
    sp = solar_positions()

    mask, geo = canopy_mod.build_mask()
    print(f"  canopy raster {mask.shape[1]}x{mask.shape[0]} px @ {geo[2]:.0f} m  "
          f"-> {mask.mean()*100:.1f}% canopy cover ({canopy_mod.CANOPY_VINTAGE})")

    # Representative crown-centre height for the raster, taken from the trees
    # in the inventory that were actually measured rather than imputed.
    measured = trees[~trees["height_imputed"]]
    crown_h = float(measured["crown_h_m"].median())
    print(f"  representative crown-centre height: {crown_h:.1f} m "
          f"(median of {len(measured)} measured trees)")

    xs, ys, owner = sample_points(seg)
    per_seg = np.bincount(owner, minlength=len(seg)).astype(np.float64)
    print(f"  sampling {len(xs)} points at {SAMPLE_SPACING_M:.0f} m spacing")

    n, nh = len(seg), len(HOURS)
    shade_bldg = np.zeros((n, nh), dtype=np.float32)
    shade_tree = np.zeros((n, nh), dtype=np.float32)

    for hi, (_, r) in enumerate(sp.iterrows()):
        hour = int(r["hour"])
        bshade = gpd.read_file(CACHE / f"shadow_{hour:02d}.geojson") \
                    .to_crs(CRS_METRIC).geometry.union_all()

        # Buildings: exact polygon intersection, as in step 3.
        b_len = seg.geometry.intersection(bshade).length.to_numpy()
        shade_bldg[:, hi] = np.clip(b_len / np.maximum(lengths, 1e-6), 0, 1)

        # Canopy: a point is shaded if canopy sits where it would cast onto
        # that point, i.e. one shadow-vector *back* along the sun direction.
        dx, dy = shadow_vector(r["apparent_elevation"], r["azimuth"], crown_h)
        under = canopy_mod.sample(mask, geo, xs - dx, ys - dy)
        in_b = shapely.intersects_xy(bshade, xs, ys)

        # Building shade is an exact length; canopy shade is sampled. Mixing
        # the two measures directly lets them sum past the length of the
        # segment, because sampling and intersection disagree at the margin.
        # So the samples give only a *rate* - how much of the not-already-
        # shaded pavement the canopy covers - and that rate is applied to the
        # exact unshaded fraction. Bounded by construction: the two sum to 1.
        free = (~in_b).astype(np.float64)
        n_free = np.bincount(owner, weights=free, minlength=n)
        hit_free = np.bincount(owner, weights=(under & ~in_b).astype(np.float64),
                               minlength=n)
        rate = np.divide(hit_free, n_free, out=np.zeros(n), where=n_free > 0)
        shade_tree[:, hi] = np.clip((1.0 - shade_bldg[:, hi]) * rate, 0, 1)

        print(f"    {HOUR_LABELS[hour]:>5}  buildings shade {shade_bldg[:, hi].mean()*100:5.1f}%  "
              f"| canopy adds {shade_tree[:, hi].mean()*100:5.1f}%")

    sun = np.clip(1.0 - shade_bldg - CANOPY_BLOCK * shade_tree, 0.0, 1.0)
    np.savez_compressed(
        SUN_PATH, sun_exposure=sun, shade_bldg=shade_bldg, shade_tree=shade_tree,
        seg_ids=seg["seg_id"].to_numpy(), hours=np.array(HOURS),
        canopy_block=np.float32(CANOPY_BLOCK),
        canopy_vintage=canopy_mod.CANOPY_VINTAGE,
        canopy_source=canopy_mod.CANOPY_SOURCE,
    )
    print("  mean sun exposure by hour:")
    for hi, h in enumerate(HOURS):
        print(f"    {HOUR_LABELS[h]:>5}  {sun[:, hi].mean():.3f}   "
              f"(buildings only would be {1-shade_bldg[:, hi].mean():.3f})")
    print(f"  wrote {TREES_PATH.name}, {SUN_PATH.name} {sun.shape}")


if __name__ == "__main__":
    main()
