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
    # float32 accumulation across cohorts, so compare relatively.
    check("'all' equals the sum of the cohorts",
          abs(allp.severe_total - parts) <= 1e-6 * max(parts, 1.0),
          f"{allp.severe_total:.4f} vs {parts:.4f} summed over {len(cohorts)}")

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

    # --- waiting exposure -------------------------------------------------
    check("severe splits into walking and waiting",
          abs(base.severe_total
              - (base.walking_severe_total + base.waiting_severe_total)) < 1e-6,
          f"walking {base.walking_severe_total:.0f} + waiting "
          f"{base.waiting_severe_total:.0f} = {base.severe_total:.0f}")
    check("waiting exposure exists at transit stops",
          base.waiting_severe_total > 0,
          f"{base.waiting_severe_total:.0f} person-min "
          f"({base.waiting_severe_total/base.severe_total*100:.1f}% of total)")
    # A shelter must protect waiting time and leave the footway alone,
    # otherwise it is just a differently priced tree.
    shelter_cov = np.ones(len(e.seg_ids))
    sheltered = e.crash_test(*HERO, shelter_delta=shelter_cov)
    check("shelter coverage removes waiting exposure",
          sheltered.waiting_severe_total < base.waiting_severe_total,
          f"{base.waiting_severe_total:.0f} -> {sheltered.waiting_severe_total:.0f}")
    check("shelter coverage does not change walking exposure",
          abs(sheltered.walking_severe_total - base.walking_severe_total) < 1e-9,
          f"{base.walking_severe_total:.0f} unchanged")
    check("shelters bounded by the real stop inventory",
          int(a.max_units("shaded_shelter").sum()) == int(e.shelter_capacity.sum()),
          f"{int(e.shelter_capacity.sum())} unsheltered stops")

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
    check("a shelter-only budget reduces waiting, not walking",
          shelter_only["after"].waiting_severe_total
          < shelter_only["before"].waiting_severe_total
          and abs(shelter_only["after"].walking_severe_total
                  - shelter_only["before"].walking_severe_total) < 1e-9,
          f"waiting {shelter_only['before'].waiting_severe_total:.0f} -> "
          f"{shelter_only['after'].waiting_severe_total:.0f}")

    # --- snapshot contract -------------------------------------------------
    from provenance import fnv1a, input_hash as ihash
    check("fnv1a matches the reference vector", fnv1a("hello") == "4f9f2cab",
          fnv1a("hello"))
    check("snapshot carries an identity and a status",
          bool(base.input_hash) and base.snapshot_id.startswith("crash-")
          and base.status == "complete", base.snapshot_id)
    check("hash is reproducible from the same inputs",
          base.input_hash == e.input_hash(*HERO), base.input_hash)
    # Each input that can change a result must change the hash, or a cache
    # could answer a question it was not asked.
    variants = {
        "hour": e.input_hash("heat2035", 12, "older_adults"),
        "scenario": e.input_hash("heat2050", 15, "older_adults"),
        "persona": e.input_hash("heat2035", 15, "students"),
        "budget": e.input_hash("heat2035", 15, "older_adults", 250000),
    }
    clashes = [k for k, v in variants.items() if v == base.input_hash]
    check("every input changes the hash", not clashes,
          clashes or " / ".join(variants))
    # The hash must describe the request as made. Expanding an omitted
    # "kinds" to the concrete list before hashing produces a value the caller
    # cannot reproduce, and every such plan is then refused as a mismatch -
    # which is exactly what happened until this was caught.
    # The allocation policy changes the plan, so it is part of the question
    # and therefore part of the hash. The client builds the same key.
    for kinds, policy, label in [
        (None, "balanced_protection", "balanced"),
        (None, "pure_efficiency", "pure"),
        (["tree"], "balanced_protection", "tree-only"),
    ]:
        got = a.optimize(*HERO, 250000, kinds, policy)["input_hash"]
        want = ihash(dataset_version=e.dataset_version, scenario=HERO[0],
                     hour=HERO[1], persona=HERO[2], budget_usd=250000,
                     kinds=(kinds or []) + [f"policy:{policy}"])
        check(f"plan hash reproducible by the caller ({label})", got == want,
              f"{got} vs {want}")
    # Two policies over the same inputs must not collide.
    check("policy changes the plan hash",
          a.optimize(*HERO, 250000, None, "balanced_protection")["input_hash"]
          != a.optimize(*HERO, 250000, None, "pure_efficiency")["input_hash"])
    # And the balanced default must actually buy the service floor.
    bal = a.optimize(*HERO, 250000, None, "balanced_protection")
    check("balanced protection buys the service floor",
          bal["counts"]["shaded_shelter"] == 3
          and len(bal["service_floor"]) == 3,
          " / ".join(f["corridor"] for f in bal["service_floor"]))
    check("one placement record per purchased unit",
          len(bal["unit_placements"])
          == bal["counts"]["tree"] + bal["counts"]["shaded_shelter"],
          f"{len(bal['unit_placements'])} units")
    check("placements have distinct coordinates",
          len({(u["lon"], u["lat"]) for u in bal["unit_placements"]})
          == len(bal["unit_placements"]))

    b250 = a.optimize(*HERO, 250000)["input_hash"]
    b137 = a.optimize(*HERO, 137500)["input_hash"]
    check("different budgets produce different plan hashes", b250 != b137,
          f"{b250} vs {b137}")
    check("dataset version fingerprints the artifacts",
          len(e.dataset_version) == 8, e.dataset_version)
    check("every displayed quantity has a value status",
          all(v["status"] in ("source", "computed", "assumption", "missing")
              for v in e.value_meta.values()),
          f"{len(e.value_meta)} fields")
    # The honest split matters: if everything claimed to be "source" the
    # badge would be meaningless.
    from collections import Counter as _C
    kinds = _C(v["status"] for v in e.value_meta.values())
    check("provenance distinguishes sourced from assumed",
          kinds["source"] > 0 and kinds["assumption"] > 0,
          " / ".join(f"{k}:{v}" for k, v in kinds.items()))

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
