"""Step 6 - TODAY / 2035 / 2050 heat scenarios.

TODAY is observed, not modelled: 20 summers of hourly temperature and
humidity for Oakland, reduced to the median diurnal profile of the hottest
5% of days. That is a real Pittsburgh heatwave day, not a synthetic one.

The futures are delta-shifted versions of that same observed day, using a
7-model CMIP6 ensemble. Holding the observed diurnal shape and shifting it
by a modelled warming increment is the standard delta-change approach, and
it keeps the comparison honest: the only thing that differs between TODAY
and 2035 is the temperature offset.

Framing, per the brief: these are stress-test values, not forecasts for a
calendar year. The 2035 scenario uses the 2025-2049 projection window that
the brief names. The 2050 scenario's 2050-2074 window lies beyond this
source's 2050 cutoff, so it is a trend extrapolation - flagged as such in
the artifact and intended for the assumptions panel.
"""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd
import requests

from config import CACHE, CENTER, HOURS, HOUR_LABELS, RAW
from heatindex import HI_CAUTION_C, HI_DANGER_C, heat_index_c, severity

SCENARIOS_PATH = CACHE / "scenarios.json"
OBS_RAW = RAW / "observed_hourly.csv"
PROJ_RAW = RAW / "cmip6_tmax.csv"

ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive"
CLIMATE_API = "https://climate-api.open-meteo.com/v1/climate"

# High-resolution CMIP6 models served by Open-Meteo. Using the ensemble
# median rather than one model: single-model spread here is over 7 deg C.
MODELS = ["CMCC_CM2_VHR4", "FGOALS_f3_H", "HiRAM_SIT_HR", "MRI_AGCM3_2_S",
          "EC_Earth3P_HR", "MPI_ESM1_2_XR", "NICAM16_8S"]

OBS_START, OBS_END = "2005-01-01", "2024-12-31"
MODEL_BASE = (1995, 2014)
SUMMER = (6, 8)
HOT_DAY_PCT = 95      # "a heatwave day" = hottest 5% of summer days
PROJ_END = 2050       # source cutoff


def fetch_observed(force: bool = False) -> pd.DataFrame:
    if OBS_RAW.exists() and not force:
        return pd.read_csv(OBS_RAW, parse_dates=["time"])
    lat, lon = CENTER
    j = requests.get(ARCHIVE_API, params={
        "latitude": lat, "longitude": lon,
        "start_date": OBS_START, "end_date": OBS_END,
        "hourly": "temperature_2m,relative_humidity_2m",
        "timezone": "America/New_York"}, timeout=300).json()
    df = pd.DataFrame(j["hourly"])
    df["time"] = pd.to_datetime(df["time"])
    OBS_RAW.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OBS_RAW, index=False)
    return df


def fetch_projections(force: bool = False) -> pd.DataFrame:
    """Fetch each model's daily tmax, caching incrementally.

    The free Climate API rate-limits partway through a 7-model sweep, so
    models already on disk are kept and only the missing ones are retried.
    Re-running the step fills the ensemble in rather than starting over.
    """
    have = pd.DataFrame()
    if PROJ_RAW.exists() and not force:
        have = pd.read_csv(PROJ_RAW, parse_dates=["time"])
        missing = [m for m in MODELS if m not in set(have["model"])]
        if not missing:
            return have
        print(f"    cached: {have['model'].nunique()} models; "
              f"retrying {len(missing)}")
    else:
        missing = list(MODELS)

    lat, lon = CENTER
    frames = [have] if not have.empty else []
    for m in missing:
        # The free tier rate-limits; back off rather than losing the model.
        d = None
        for attempt in range(4):
            try:
                j = requests.get(CLIMATE_API, params={
                    "latitude": lat, "longitude": lon,
                    "start_date": f"{MODEL_BASE[0]}-01-01",
                    "end_date": f"{PROJ_END}-12-31",
                    "models": m, "daily": "temperature_2m_max",
                    "timezone": "America/New_York"}, timeout=300).json()
                if "daily" in j:
                    d = pd.DataFrame(j["daily"])
                    break
                reason = j.get("reason", "no daily block")
            except Exception as exc:
                reason = str(exc)[:60]
            time.sleep(5 * (attempt + 1))
        if d is None:
            print(f"    {m:18} SKIPPED ({reason})")
            continue
        d["time"] = pd.to_datetime(d["time"])
        d["model"] = m
        frames.append(d)
        print(f"    {m:18} {d['temperature_2m_max'].notna().sum()} days")
        time.sleep(2)
    if not frames:
        raise RuntimeError("no CMIP6 models returned data")
    df = pd.concat(frames, ignore_index=True)
    df.to_csv(PROJ_RAW, index=False)
    return df


def summer(df: pd.DataFrame) -> pd.DataFrame:
    return df[df["time"].dt.month.between(*SUMMER)]


def observed_hot_day(obs: pd.DataFrame) -> pd.DataFrame:
    """Median temperature and humidity at each snapshot hour on hot days."""
    s = summer(obs).copy()
    s["date"] = s["time"].dt.date
    daily_max = s.groupby("date")["temperature_2m"].max()
    threshold = np.percentile(daily_max.dropna(), HOT_DAY_PCT)
    hot_dates = set(daily_max[daily_max >= threshold].index)

    hot = s[s["date"].isin(hot_dates)].copy()
    hot["hour"] = hot["time"].dt.hour
    prof = hot[hot["hour"].isin(HOURS)].groupby("hour").agg(
        temp_c=("temperature_2m", "median"),
        rh_pct=("relative_humidity_2m", "median")).reset_index()
    prof.attrs["threshold_c"] = float(threshold)
    prof.attrs["n_days"] = len(hot_dates)
    return prof


def warming_deltas(proj: pd.DataFrame) -> dict:
    """Per-scenario warming increment, in degrees C, as an ensemble median."""
    s = summer(proj).copy()
    s["year"] = s["time"].dt.year
    out: dict = {}
    per_model = {"2035": [], "2050": []}

    for m, g in s.groupby("model"):
        base = g[g["year"].between(*MODEL_BASE)]["temperature_2m_max"]
        if base.dropna().empty:
            continue
        base_p = np.nanpercentile(base, HOT_DAY_PCT)

        fut = g[g["year"].between(2025, 2049)]["temperature_2m_max"]
        per_model["2035"].append(np.nanpercentile(fut, HOT_DAY_PCT) - base_p)

        # 2050-2074 is past the source's cutoff, so take the fitted trend in
        # hot-day temperature and evaluate it at that window's midpoint.
        ann = g[g["year"] >= 2015].groupby("year")["temperature_2m_max"] \
               .quantile(HOT_DAY_PCT / 100).dropna()
        slope, intercept = np.polyfit(ann.index.values, ann.values, 1)
        per_model["2050"].append((slope * 2062 + intercept) - base_p)

    for k, v in per_model.items():
        out[k] = {"delta_c": float(np.median(v)),
                  "model_spread_c": [float(np.min(v)), float(np.max(v))],
                  "n_models": len(v)}
    return out


def main() -> None:
    print("STEP 6  heat scenarios (observed baseline + CMIP6 delta)")
    obs = fetch_observed()
    print(f"  observed hourly records {OBS_START[:4]}-{OBS_END[:4]}: {len(obs)}")
    prof = observed_hot_day(obs)
    print(f"  heatwave day = hottest {100-HOT_DAY_PCT}% of summer days "
          f"(daily max >= {prof.attrs['threshold_c']:.1f} C, "
          f"{prof.attrs['n_days']} days)")

    print("  fetching CMIP6 projections...")
    proj = fetch_projections()
    deltas = warming_deltas(proj)
    for k, v in deltas.items():
        print(f"    {k}: +{v['delta_c']:.2f} C  (ensemble of {v['n_models']}, "
              f"spread {v['model_spread_c'][0]:+.1f} to {v['model_spread_c'][1]:+.1f})")

    scenarios = {}
    specs = [("today", "Today", 0.0, None),
             ("heat2035", "2035 Heatwave", deltas["2035"]["delta_c"], deltas["2035"]),
             ("heat2050", "2050 Heatwave", deltas["2050"]["delta_c"], deltas["2050"])]

    print(f"\n  {'scenario':14} {'hour':>6} {'air C':>7} {'RH %':>6} "
          f"{'heat idx C':>11} {'severity':>9}")
    for key, label, delta, meta in specs:
        rows = {}
        for _, r in prof.iterrows():
            t = float(r["temp_c"]) + delta
            rh = float(r["rh_pct"])
            # Relative humidity is held at the observed value while
            # temperature shifts. Stated as an assumption, not a finding.
            hi = float(heat_index_c(t, rh))
            rows[int(r["hour"])] = {
                "air_temp_c": round(t, 2), "rh_pct": round(rh, 1),
                "heat_index_c": round(hi, 2),
                "heat_severity": round(float(severity(hi)), 4)}
            print(f"  {label:14} {HOUR_LABELS[int(r['hour'])]:>6} {t:7.1f} "
                  f"{rh:6.0f} {hi:11.1f} {rows[int(r['hour'])]['heat_severity']:9.2f}")
        scenarios[key] = {
            "label": label, "delta_c": round(delta, 3),
            "hours": rows,
            "is_extrapolated": key == "heat2050",
            "ensemble": meta,
        }

    SCENARIOS_PATH.write_text(json.dumps({
        "scenarios": scenarios,
        "method": {
            "baseline": (f"Observed hourly temperature and relative humidity, "
                         f"{OBS_START[:4]}-{OBS_END[:4]}, median diurnal profile "
                         f"of the hottest {100-HOT_DAY_PCT}% of summer days"),
            "baseline_source": "Open-Meteo Historical Weather API (ERA5 reanalysis)",
            "projection_source": (f"CMIP6 downscaled ensemble via Open-Meteo Climate API, "
                                  f"{len(MODELS)} models, summer hot-day "
                                  f"{HOT_DAY_PCT}th percentile delta vs "
                                  f"{MODEL_BASE[0]}-{MODEL_BASE[1]}"),
            "models": MODELS,
            "heat_index": "NWS Rothfusz regression with official adjustments",
            "severity_scale": (f"0 at the NWS Caution onset ({HI_CAUTION_C} C), "
                               f"1.0 at the Danger onset ({HI_DANGER_C} C)"),
            "humidity_assumption": ("relative humidity held at observed values "
                                    "while temperature is shifted"),
            "extrapolation_note": ("The 2050-2074 window the brief names lies "
                                   "beyond this source's 2050 cutoff. The 2050 "
                                   "scenario is a linear trend in hot-day "
                                   "temperature evaluated at 2062."),
            "disclaimer": ("Stress-test values for comparing interventions, not "
                           "forecasts for a calendar year, and not a medical "
                           "prediction for any person."),
        },
        "threshold_c": round(prof.attrs["threshold_c"], 2),
        "n_hot_days": int(prof.attrs["n_days"]),
    }, indent=2))
    print(f"\n  wrote {SCENARIOS_PATH.name}")


if __name__ == "__main__":
    main()
