"""Property tests for the UTCI exposure engine.

These assert the behaviours the demo's argument depends on. If any of them
fails, the story told on stage is not true.
"""
from __future__ import annotations

import json
import pathlib
import sys
from collections import Counter

import numpy as np

from engine import (HEAT_LOAD_BASE_C, INTERVENTIONS, SEVERE_UTCI_C, Adapter,
                    Engine)

CACHE = pathlib.Path(__file__).resolve().parent.parent / "data" / "cache"
results: list[tuple[bool, str, str]] = []


def check(name, ok, detail=""):
    results.append((bool(ok), name, detail))


def main() -> int:
    e = Engine(CACHE)
    props = {f["properties"]["seg_id"]: f["properties"]
             for f in json.loads((CACHE / "segments.geojson").read_text())["features"]}
    lengths = np.array([props[s]["length_m"] for s in e.seg_ids])
    a = Adapter(e, lengths)

    HERO = ("heat2035", 15, "older_adults")
    base = e.crash_test(*HERO)

    # --- shape and sanity -------------------------------------------------
    check("crash test returns a score per segment",
          len(base.severe_minutes) == len(e.seg_ids), f"{len(e.seg_ids)} segments")
    check("all outputs finite and non-negative",
          bool(np.isfinite(base.severe_minutes).all()
               and (base.severe_minutes >= 0).all()
               and np.isfinite(base.heat_load).all()
               and (base.heat_load >= 0).all()))

    # --- thermal model ----------------------------------------------------
    check("sun is hotter than shade", base.utci_sun_c > base.utci_shade_c,
          f"UTCI sun {base.utci_sun_c:.1f} C vs shade {base.utci_shade_c:.1f} C "
          f"({base.meta['shade_relief_c']:.1f} C relief)")
    check("per-segment UTCI lies between the shade and sun values",
          bool((base.utci_c >= base.utci_shade_c - 1e-9).all()
               and (base.utci_c <= base.utci_sun_c + 1e-9).all()))
    check("severe threshold is the published Very Strong band",
          SEVERE_UTCI_C == 38.0 and HEAT_LOAD_BASE_C == 26.0,
          f"severe >= {SEVERE_UTCI_C} C, heat load above {HEAT_LOAD_BASE_C} C")

    # --- scenarios --------------------------------------------------------
    b = e.crash_test("baseline", 15, "older_adults")
    m = e.crash_test("heat2035", 15, "older_adults")
    f = e.crash_test("heat2050", 15, "older_adults")
    check("hotter scenarios are hotter", b.utci_sun_c < m.utci_sun_c < f.utci_sun_c,
          f"{b.utci_sun_c:.1f} < {m.utci_sun_c:.1f} < {f.utci_sun_c:.1f} C")
    check("heat load rises with the scenario",
          b.heat_load_total < m.heat_load_total < f.heat_load_total,
          f"{b.heat_load_total:.0f} < {m.heat_load_total:.0f} < {f.heat_load_total:.0f}")
    check("severe minutes never fall as it gets hotter",
          b.severe_total <= m.severe_total <= f.severe_total,
          f"{b.severe_total:.0f} <= {m.severe_total:.0f} <= {f.severe_total:.0f} person-min")
    # The observed baseline must not already be in the severe band, or the
    # "this is what is coming" story is false.
    check("observed baseline stays below the severe threshold",
          b.severe_total == 0 and b.utci_sun_c < SEVERE_UTCI_C,
          f"baseline UTCI in sun {b.utci_sun_c:.1f} C")

    # --- the primary metric is unweighted ---------------------------------
    allp = e.crash_test("heat2035", 15, "all")
    old = e.crash_test("heat2035", 15, "older_adults")
    check("primary metric carries no planning weight",
          abs(old.severe_total - old.weighted_severe_total / old.planning_weight) < 1e-9,
          f"unweighted {old.severe_total:.0f}, "
          f"weighted {old.weighted_severe_total:.0f} at x{old.planning_weight}")
    check("planning weight is reported, not baked in",
          old.planning_weight != 1.0 and allp.planning_weight == 1.0,
          f"older adults x{old.planning_weight}, all x{allp.planning_weight}")
    # "All" is the population, so it must equal its parts exactly - not merely
    # exceed them, which a fifth independent sample would also do by luck.
    cohorts = [p for p in e.personas if p != "all"]
    parts = sum(e.crash_test("heat2035", 15, c).severe_total for c in cohorts)
    check("'all' equals the sum of the cohorts",
          abs(allp.severe_total - parts) < 1e-6,
          f"{allp.severe_total:.1f} vs {parts:.1f} summed over {len(cohorts)}")

    # --- shade ------------------------------------------------------------
    full = np.ones(len(e.seg_ids))
    shaded = e.crash_test(*HERO, sun_delta=full)
    check("total shade removes the severe band", shaded.severe_total == 0,
          f"{base.severe_total:.0f} -> 0 person-minutes")
    check("shade never increases any segment's burden",
          bool((shaded.heat_load <= base.heat_load + 1e-9).all()))
    # Shade is a big lever, not a magic one: heat load persists in shade.
    check("shade does not zero out heat load", shaded.heat_load_total > 0,
          f"{shaded.heat_load_total:.0f} heat-load units remain in full shade")

    # --- interventions ----------------------------------------------------
    check("exactly two interventions exist",
          set(INTERVENTIONS) == {"tree", "shaded_shelter"},
          " / ".join(sorted(INTERVENTIONS)))
    check("cooling station and shade_structure are absent",
          not ({"cooling_station", "cooling_node", "shade_structure"}
               & set(INTERVENTIONS)))

    # --- optimiser --------------------------------------------------------
    out = a.optimize(*HERO, 250000)
    check("optimiser stays within budget", out["spent_usd"] <= out["budget_usd"],
          f"spent ${out['spent_usd']:,.0f} of ${out['budget_usd']:,.0f}")
    check("optimiser reduces the primary metric",
          out["after"].severe_total < out["before"].severe_total,
          f"{out['before'].severe_total:.0f} -> {out['after'].severe_total:.0f} "
          f"({out['reduction_pct']:.1f}%)")
    pos = {sid: i for i, sid in enumerate(e.seg_ids)}
    tally = Counter((pl["kind"], pl["seg_id"]) for pl in out["placements"])
    over = [(k, s) for (k, s), n in tally.items() if n > int(a.max_units(k)[pos[s]])]
    check("optimiser never over-fills a segment", not over,
          f"{len(tally)} segment-kind pairs, {len(over)} over capacity")
    claimed = sum(INTERVENTIONS[p["kind"]]["cost_usd"] for p in out["placements"])
    check("spend matches the placement log", abs(claimed - out["spent_usd"]) < 1e-6,
          f"${claimed:,.0f}")
    small = a.optimize(*HERO, 50000)
    check("a larger budget helps at least as much",
          out["reduction_pct"] >= small["reduction_pct"] - 1e-9,
          f"$250k {out['reduction_pct']:.2f}% vs $50k {small['reduction_pct']:.2f}%")
    # Where nothing crosses the severe threshold the optimiser must still
    # have something to optimise, or a cool scenario would be a dead UI.
    cool = a.optimize("baseline", 15, "older_adults", 250000)
    check("optimiser falls back to heat load when nothing is severe",
          cool["metric_used"] == "heat_load" and cool["reduction_pct"] > 0,
          f"{cool['metric_used']}, {cool['reduction_pct']:.2f}%")
    shelter_only = a.optimize(*HERO, 250000, ["shaded_shelter"])
    check("restricting the kind restricts the spend",
          set(k for k, v in shelter_only["counts"].items() if v) <= {"shaded_shelter"},
          " / ".join(f"{k}:{v}" for k, v in shelter_only["counts"].items()))

    # --- determinism ------------------------------------------------------
    r1 = e.crash_test(*HERO).severe_total
    r2 = e.crash_test(*HERO).severe_total
    check("crash test is deterministic", r1 == r2, f"{r1:.6f}")

    width = max(len(n) for _, n, _ in results)
    fails = 0
    print("\nENGINE PROPERTY TESTS (UTCI)")
    print("-" * (width + 36))
    for ok, name, detail in results:
        print(f"{'  ok ' if ok else 'FAIL '} {name:<{width}}  {detail}")
        fails += not ok
    print("-" * (width + 36))
    print(f"{len(results)-fails}/{len(results)} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
