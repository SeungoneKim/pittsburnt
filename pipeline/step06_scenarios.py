"""Step 6 - observed hot-day baseline + CMIP6-LOCA2 future windows.

The baseline is observed, not modelled: 20 summers of hourly weather for
Oakland, reduced to the median diurnal profile of the hottest 5% of summer
days. It is labelled "Observed hot-day baseline" and never presented as
current weather - there is no live weather service attached.

The futures shift that same observed day by a warming increment taken from
the 27-model CMIP6-LOCA2 county release, paired model-by-model against each
model's own 1981-2010 run. The windows are the ones the spec names:
2025-2049 and 2050-2074. Nothing is extrapolated.

Because the engine now computes UTCI rather than a Heat Index, this step also
carries the two inputs UTCI needs and the old model did not: pedestrian wind
and the shortwave radiation components that drive mean radiant temperature.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import requests

from config import CACHE, CENTER, HOURS, HOUR_LABELS, RAW
from loca2 import PRIMARY_SSP, warming_deltas
from step03_shadows import solar_positions
from utci import SEVERE_UTCI_C, mean_radiant_temperature, stress_band, utci_c

SCENARIOS_PATH = CACHE / "scenarios.json"
OBS_RAW = RAW / "observed_hourly.csv"
ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive"

OBS_START, OBS_END = "2005-01-01", "2024-12-31"
SUMMER = (6, 8)
HOT_DAY_PCT = 95   # "a heatwave day" = hottest 5% of summer days

HOURLY_VARS = [
    "temperature_2m", "relative_humidity_2m", "wind_speed_10m",
    "shortwave_radiation", "direct_radiation", "diffuse_radiation",
    "direct_normal_irradiance",
]


def fetch_observed(force: bool = False) -> pd.DataFrame:
    """Hourly weather for the study area over the observation period."""
    if OBS_RAW.exists() and not force:
        df = pd.read_csv(OBS_RAW, parse_dates=["time"])
        if all(c in df.columns for c in HOURLY_VARS):
            return df
    lat, lon = CENTER
    j = requests.get(ARCHIVE_API, params={
        "latitude": lat, "longitude": lon,
        "start_date": OBS_START, "end_date": OBS_END,
        "hourly": ",".join(HOURLY_VARS),
        "timezone": "America/New_York"}, timeout=600).json()
    df = pd.DataFrame(j["hourly"])
    df["time"] = pd.to_datetime(df["time"])
    OBS_RAW.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OBS_RAW, index=False)
    return df


def observed_hot_day(obs: pd.DataFrame) -> pd.DataFrame:
    """Median conditions at each snapshot hour, across hot summer days."""
    s = obs[obs["time"].dt.month.between(*SUMMER)].copy()
    s["date"] = s["time"].dt.date
    daily_max = s.groupby("date")["temperature_2m"].max()
    threshold = float(np.percentile(daily_max.dropna(), HOT_DAY_PCT))
    hot_dates = set(daily_max[daily_max >= threshold].index)

    hot = s[s["date"].isin(hot_dates)].copy()
    hot["hour"] = hot["time"].dt.hour
    prof = hot[hot["hour"].isin(HOURS)].groupby("hour")[HOURLY_VARS] \
        .median().reset_index()
    prof.attrs["threshold_c"] = threshold
    prof.attrs["n_days"] = len(hot_dates)
    return prof


def main() -> None:
    print("STEP 6  observed hot-day baseline + CMIP6-LOCA2 windows")
    obs = fetch_observed()
    print(f"  observed hourly records {OBS_START[:4]}-{OBS_END[:4]}: {len(obs)}")
    prof = observed_hot_day(obs)
    print(f"  hot day = hottest {100-HOT_DAY_PCT}% of summer days "
          f"(daily max >= {prof.attrs['threshold_c']:.1f} C, "
          f"{prof.attrs['n_days']} days)")

    deltas = warming_deltas(PRIMARY_SSP)
    print(f"  CMIP6-LOCA2 ({PRIMARY_SSP}), paired per model vs 1981-2010:")
    for k, v in deltas.items():
        print(f"    {v['window']}  +{v['delta_c']:.2f} C  "
              f"({v['n_models']} models, spread {v['model_spread_c'][0]:+.2f} "
              f"to {v['model_spread_c'][1]:+.2f})")

    # Solar geometry for the frozen date supplies cos(zenith) for Tmrt.
    sp = solar_positions().set_index("hour")
    cosz = {int(h): float(np.cos(np.radians(90.0 - sp.loc[h, "apparent_elevation"])))
            for h in HOURS}

    specs = [("baseline", "Observed hot-day baseline", 0.0, None),
             ("heat2035", "2035 Heatwave", deltas["heat2035"]["delta_c"], deltas["heat2035"]),
             ("heat2050", "2050 Heatwave", deltas["heat2050"]["delta_c"], deltas["heat2050"])]

    scenarios = {}
    print(f"\n  {'scenario':26} {'hour':>6} {'air C':>6} {'RH':>4} {'wind':>6} "
          f"{'UTCI sun':>9} {'UTCI shade':>11}  band (sun)")
    for key, label, delta, meta in specs:
        rows = {}
        for _, r in prof.iterrows():
            hour = int(r["hour"])
            ta = float(r["temperature_2m"]) + delta
            rh = float(r["relative_humidity_2m"])
            wind = float(r["wind_speed_10m"]) / 3.6       # km/h -> m/s
            ghi = float(r["shortwave_radiation"])
            dirh = float(r["direct_radiation"])
            dif = float(r["diffuse_radiation"])
            dni = float(r["direct_normal_irradiance"])
            cz = cosz[hour]

            # Reported at the two extremes so the scenario file is readable;
            # the engine computes per segment from its own sun exposure.
            mrt_sun = float(mean_radiant_temperature(ta, rh, ghi, dirh, dif, dni, cz, 1.0))
            mrt_shade = float(mean_radiant_temperature(ta, rh, ghi, dirh, dif, dni, cz, 0.0))
            u_sun = float(utci_c(ta, rh, wind, mrt_sun))
            u_shade = float(utci_c(ta, rh, wind, mrt_shade))

            rows[hour] = {
                "air_temp_c": round(ta, 2), "rh_pct": round(rh, 1),
                "wind_ms": round(wind, 2),
                "ghi_wm2": round(ghi, 1), "direct_horizontal_wm2": round(dirh, 1),
                "diffuse_wm2": round(dif, 1), "dni_wm2": round(dni, 1),
                "cos_zenith": round(cz, 4),
                "tmrt_sun_c": round(mrt_sun, 2), "tmrt_shade_c": round(mrt_shade, 2),
                "utci_sun_c": round(u_sun, 2), "utci_shade_c": round(u_shade, 2),
                "shade_relief_c": round(u_sun - u_shade, 2),
            }
            print(f"  {label:26} {HOUR_LABELS[hour]:>6} {ta:6.1f} {rh:4.0f} "
                  f"{wind:6.2f} {u_sun:9.1f} {u_shade:11.1f}  "
                  f"{str(stress_band(u_sun))}")
        scenarios[key] = {"label": label, "delta_c": round(delta, 3),
                          "hours": rows, "is_extrapolated": False,
                          "ensemble": meta}

    SCENARIOS_PATH.write_text(json.dumps({
        "scenarios": scenarios,
        "method": {
            "baseline": (f"Observed hourly weather {OBS_START[:4]}-{OBS_END[:4]}, "
                         f"median diurnal profile of the hottest "
                         f"{100-HOT_DAY_PCT}% of summer days"),
            "baseline_source": "Open-Meteo Historical Weather API (ERA5 reanalysis)",
            "baseline_note": ("This is an observed hot-day baseline, not current "
                              "weather. No live weather service is connected."),
            "projection_source": (f"CMIP6-LOCA2 27-model county release, {PRIMARY_SSP}, "
                                  f"paired per model against each model's own "
                                  f"1981-2010 run"),
            "projection_windows": {k: v["window"] for k, v in deltas.items()},
            "thermal_index": ("UTCI (Universal Thermal Climate Index), ECMWF "
                              "thermofeel implementation"),
            "mean_radiant_temperature": ("Computed from shortwave components; sun "
                                         "exposure scales the direct beam only"),
            "longwave_assumption": ("Downward longwave estimated from screen-level "
                                    "temperature and humidity, Prata (1996)"),
            "severe_threshold": (f"UTCI >= {SEVERE_UTCI_C} C is the published "
                                 f"'Very Strong Heat Stress' class - a "
                                 f"thermal-stress category, not a diagnosis"),
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
