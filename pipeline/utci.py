"""UTCI - Universal Thermal Climate Index, and the mean radiant temperature
it needs.

This replaces the Heat Index model. The revision spec is explicit about why:
the NWS Heat Index is a shade measure, and the old engine bolted sun on as
"+8 C x sun_exposure", which is an assumption dressed as physics.

UTCI takes four inputs - air temperature, humidity, wind, and mean radiant
temperature - and Tmrt is where sun exposure belongs. A pedestrian in shade
receives diffuse sky radiation only; one in full sun also receives the direct
beam. So sun_exposure scales the direct component of the radiation budget and
UTCI falls out of it, rather than being nudged by a constant.

Stress bands are the published UTCI assessment scale. Red is >= 38 C, "Very
Strong Heat Stress" - a thermal-stress class, not a diagnosis and not a
heatstroke probability.

References:
  UTCI assessment scale - Brode et al. 2012 / utci.org
  thermofeel (ECMWF) for the UTCI polynomial and Tmrt radiant budget
  Prata (1996) for clear-sky downward longwave from screen-level data
"""
from __future__ import annotations

import numpy as np
import thermofeel as tf

SIGMA = 5.670374419e-8      # Stefan-Boltzmann, W m-2 K-4
URBAN_ALBEDO = 0.20         # typical mixed urban surface
SURFACE_EMISSIVITY = 0.95

# Published UTCI assessment scale, in degrees C.
UTCI_BANDS = [
    (-float("inf"), 9.0, "no_stress_cool"),
    (9.0, 26.0, "no_thermal_stress"),
    (26.0, 32.0, "moderate"),
    (32.0, 38.0, "strong"),
    (38.0, 46.0, "very_strong"),
    (46.0, float("inf"), "extreme"),
]
# The threshold the UI colours red, per the revision spec.
SEVERE_UTCI_C = 38.0


def vapour_pressure_hpa(temp_c, rh_pct):
    """Water vapour pressure from temperature and relative humidity."""
    t = np.asarray(temp_c, dtype=float)
    es = 6.112 * np.exp(17.67 * t / (t + 243.5))   # saturation, hPa
    return es * np.asarray(rh_pct, dtype=float) / 100.0


def downward_longwave(temp_c, rh_pct):
    """Clear-sky downward longwave at the surface, Prata (1996).

    Open-Meteo's archive serves no thermal flux, so this is estimated from
    screen-level temperature and humidity. Labelled an assumption, not a
    measurement.
    """
    t_k = np.asarray(temp_c, dtype=float) + 273.15
    e = vapour_pressure_hpa(temp_c, rh_pct)
    w = 46.5 * (e / t_k)
    eps = 1.0 - (1.0 + w) * np.exp(-np.sqrt(1.2 + 3.0 * w))
    return eps * SIGMA * t_k ** 4


def mean_radiant_temperature(temp_c, rh_pct, ghi, direct_horizontal,
                             diffuse, dni, cos_zenith, sun_exposure=1.0):
    """Tmrt in degrees C for a pedestrian with a given fraction of sun.

    sun_exposure in [0, 1] scales the *direct* beam only: shade removes the
    sun, not the sky. That is the whole mechanism by which a tree or a
    shelter cools someone in this model.
    """
    f = np.clip(np.asarray(sun_exposure, dtype=float), 0.0, 1.0)
    diffuse = np.asarray(diffuse, dtype=float)

    fdir = np.asarray(direct_horizontal, dtype=float) * f
    dsrp = np.asarray(dni, dtype=float) * f
    ssrd = diffuse + fdir
    ssr = ssrd * (1.0 - URBAN_ALBEDO)

    strd = downward_longwave(temp_c, rh_pct)
    t_k = np.asarray(temp_c, dtype=float) + 273.15
    # Net thermal at the surface: down minus what the ground emits back.
    strr = strd - SURFACE_EMISSIVITY * SIGMA * t_k ** 4

    cossza = np.clip(np.asarray(cos_zenith, dtype=float), 0.0, None)
    mrt_k = tf.calculate_mean_radiant_temperature(
        ssrd=ssrd, ssr=ssr, dsrp=dsrp, strd=strd, fdir=fdir, strr=strr,
        cossza=cossza)
    return np.asarray(mrt_k) - 273.15


def utci_c(temp_c, rh_pct, wind_ms, tmrt_c):
    """UTCI in degrees C. Wind is the 10 m value the index is defined on."""
    t_k = np.asarray(temp_c, dtype=float) + 273.15
    # The UTCI polynomial is fitted for 0.5-17 m/s; clamp rather than
    # extrapolate into a region the fit does not cover.
    va = np.clip(np.asarray(wind_ms, dtype=float), 0.5, 17.0)
    mrt_k = np.asarray(tmrt_c, dtype=float) + 273.15
    ehpa = vapour_pressure_hpa(temp_c, rh_pct)
    return np.asarray(tf.calculate_utci(t2_k=t_k, va=va, mrt=mrt_k,
                                        ehPa=ehpa)) - 273.15


def stress_band(utci_value_c) -> np.ndarray:
    """Published UTCI category for each value."""
    v = np.asarray(utci_value_c, dtype=float)
    out = np.empty(v.shape, dtype=object)
    for lo, hi, name in UTCI_BANDS:
        out[(v >= lo) & (v < hi)] = name
    return out


def severe_minutes(utci_value_c, minutes):
    """Person-minutes spent at or above Very Strong Heat Stress.

    This is the primary metric: a count of exposed minutes, unweighted, not
    a severity-scaled score. Planning priority is applied separately and
    reported separately.
    """
    return np.where(np.asarray(utci_value_c) >= SEVERE_UTCI_C,
                    np.asarray(minutes, dtype=float), 0.0)
