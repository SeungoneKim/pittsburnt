"""CMIP6-LOCA2 county warming deltas for Allegheny County.

The revision spec requires the 1981-2010, 2025-2049 and 2050-2074 windows
from the 27-model LOCA2 release, not a trend extrapolation. These files are
the USGS "resilient roadway design" county percentile summaries; they cannot
be fetched programmatically (ScienceBase serves an HTML app shell for
S3-backed files, the LOCA2 archive at cirrus.ucsd.edu is gone, and the USGS
THREDDS server has been retired), so they are downloaded by hand once and
committed to data/raw.

TX95p_per is the 95th percentile of daily maximum near-surface air
temperature over each window - the same definition as our observed hot-day
baseline, which is what makes a simple delta valid.
"""
from __future__ import annotations

import numpy as np
import xarray as xr

from config import RAW

GEOID_ALLEGHENY = "42003"
PRIMARY_SSP = "ssp370"
WINDOWS = {
    "historical": ("historical_1981-2010", "1981-2010"),
    "heat2035": ("ssp_2025-2049", "2025-2049"),
    "heat2050": ("ssp_2050-2074", "2050-2074"),
}
STEM = "DOT-Pavement_CMIP6-LOCA2_{}_percentiles_County2023.nc"
SOURCE = ("USGS CMIP6-LOCA2 county percentile summaries "
          "(DOT resilient roadway design release), GEOID 42003")


def _f_to_c(f):
    return (np.asarray(f, dtype=float) - 32.0) * 5.0 / 9.0


def _window(key: str) -> xr.Dataset:
    stem, _ = WINDOWS[key]
    path = RAW / STEM.format(stem)
    if not path.exists():
        raise FileNotFoundError(
            f"{path.name} missing. Download the three county percentile files "
            f"from https://www.sciencebase.gov/catalog/item/"
            f"68409857d4be022b9cea5dbe into data/raw/")
    return xr.open_dataset(path).sel(GEOID=GEOID_ALLEGHENY)


def _tx95_by_model(ds: xr.Dataset, ssp: str | None) -> dict[str, float]:
    """Hot-day temperature in C for each model, for one experiment."""
    tx = _f_to_c(ds["TX95p_per"].values)
    src = np.array([str(x) for x in ds["source_id"].values])
    exp = np.array([str(x) for x in ds["experiment_id"].values])
    keep = np.ones(len(tx), dtype=bool) if ssp is None else (exp == ssp)
    out: dict[str, list[float]] = {}
    for model, value, ok in zip(src, tx, keep):
        if ok and np.isfinite(value):
            out.setdefault(model, []).append(float(value))
    # A model may contribute several variants; average them first.
    return {m: float(np.mean(v)) for m, v in out.items()}


def warming_deltas(ssp: str = PRIMARY_SSP) -> dict:
    """Per-scenario warming, paired model-by-model against the same model's
    own historical run. Pairing matters: comparing medians across different
    model subsets conflates model spread with climate change."""
    hist = _tx95_by_model(_window("historical"), None)
    out: dict = {}
    for key in ("heat2035", "heat2050"):
        fut = _tx95_by_model(_window(key), ssp)
        shared = sorted(set(hist) & set(fut))
        deltas = np.array([fut[m] - hist[m] for m in shared])
        out[key] = {
            "delta_c": float(np.median(deltas)),
            "model_spread_c": [float(np.min(deltas)), float(np.max(deltas))],
            "n_models": len(shared),
            "window": WINDOWS[key][1],
            "experiment": ssp,
            "baseline_window": WINDOWS["historical"][1],
            "baseline_tx95_c": float(np.median(list(hist.values()))),
            "source": SOURCE,
            "variable": "TX95p_per (95th percentile daily maximum temperature)",
        }
    return out


if __name__ == "__main__":
    for ssp in ("ssp245", "ssp370", "ssp585"):
        d = warming_deltas(ssp)
        print(f"  {ssp}:")
        for k, v in d.items():
            print(f"    {k:9} {v['window']}  +{v['delta_c']:.2f} C  "
                  f"(paired over {v['n_models']} models, spread "
                  f"{v['model_spread_c'][0]:+.2f} to {v['model_spread_c'][1]:+.2f})")
