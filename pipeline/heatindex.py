"""NWS Heat Index (Rothfusz regression), with the official adjustments.

The brief is specific that heat severity should start from the NWS Heat
Index, and equally specific about what the Heat Index is NOT: it is a
shade-based measure. Standing in direct sun can add roughly 8 degrees C to
the apparent temperature, which is exactly why sun exposure is a separate
multiplier in the model rather than being folded in here.

Reference: NWS WPC, "The Heat Index Equation".
"""
from __future__ import annotations

import numpy as np

# NWS heat-index categories, in degrees C.
HI_CAUTION_C = 27.0    # 80 F  - onset of "Caution"
HI_DANGER_C = 39.0     # 103 F - onset of "Danger"


def _f(c):
    return c * 9.0 / 5.0 + 32.0


def _c(f):
    return (f - 32.0) * 5.0 / 9.0


def heat_index_c(temp_c, rh_pct):
    """Apparent temperature in degrees C from air temperature and humidity."""
    T = np.asarray(_f(temp_c), dtype=float)
    R = np.asarray(rh_pct, dtype=float)

    # Steadman's simple form, valid when the result is below ~80 F.
    simple = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + R * 0.094)

    full = (-42.379 + 2.04901523 * T + 10.14333127 * R
            - 0.22475541 * T * R - 6.83783e-3 * T * T
            - 5.481717e-2 * R * R + 1.22874e-3 * T * T * R
            + 8.5282e-4 * T * R * R - 1.99e-6 * T * T * R * R)

    # Official adjustments at the dry and humid extremes.
    dry = ((13.0 - R) / 4.0) * np.sqrt(np.clip(17.0 - np.abs(T - 95.0), 0, None) / 17.0)
    full = np.where((R < 13) & (T >= 80) & (T <= 112), full - dry, full)
    humid = ((R - 85.0) / 10.0) * ((87.0 - T) / 5.0)
    full = np.where((R > 85) & (T >= 80) & (T <= 87), full + humid, full)

    hi_f = np.where(0.5 * (simple + T) < 80.0, simple, full)
    return _c(hi_f)


def severity(hi_c):
    """Dimensionless heat stress: 0 at the NWS Caution onset, 1.0 at Danger.

    Anchored on published NWS category thresholds rather than a chosen curve,
    and deliberately unbounded above 1 so an extreme scenario keeps scaling.
    """
    return np.clip((np.asarray(hi_c, dtype=float) - HI_CAUTION_C), 0, None) \
        / (HI_DANGER_C - HI_CAUTION_C)
