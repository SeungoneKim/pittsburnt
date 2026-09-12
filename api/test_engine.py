"""Property tests for the exposure engine.

These assert the behaviours the demo's argument depends on. If any of them
fails, the before/after story on stage is not true.
"""
from __future__ import annotations

import json
import sys

import numpy as np

from engine import Adapter, Engine

CACHE = __import__("pathlib").Path(__file__).resolve().parent.parent / "data" / "cache"
results: list[tuple[bool, str, str]] = []


def check(name, ok, detail=""):
    results.append((bool(ok), name, detail))


def main() -> int:
    e = Engine(CACHE)
    props = {f["properties"]["seg_id"]: f["properties"]
             for f in json.loads((CACHE / "segments.geojson").read_text())["features"]}
    lengths = np.array([props[s]["length_m"] for s in e.seg_ids])
    a = Adapter(e, lengths)

    base = e.crash_test("today", 15, "older_adults")
    check("crash test returns a score per segment",
          len(base.exposure) == len(e.seg_ids), f"{len(e.seg_ids)} segments")
    check("exposure is finite and non-negative",
          bool(np.isfinite(base.exposure).all() and (base.exposure >= 0).all()))

    # A hotter climate must score higher on identical geometry and people.
    t = e.crash_test("today", 15, "older_adults").total
    m = e.crash_test("heat2035", 15, "older_adults").total
    f = e.crash_test("heat2050", 15, "older_adults").total
    check("hotter scenarios score strictly higher", t < m < f,
          f"{t:.0f} < {m:.0f} < {f:.0f} at-risk pedestrian-minutes")

    # Slower, weighted personas must not score lower than the average walker.
    allp = e.crash_test("heat2035", 15, "all").total
    old = e.crash_test("heat2035", 15, "older_adults").total
    check("vulnerable persona scores above the average walker", old > allp,
          f"older adults {old:.0f} vs all {allp:.0f}")

    # Shade must reduce exposure, and never increase it.
    full = np.ones(len(e.seg_ids))
    shaded = e.crash_test("heat2035", 15, "older_adults", sun_delta=full)
    check("total shade strictly reduces exposure", shaded.total < base.total,
          f"{shaded.total:.0f} vs unshaded {m:.0f}")
    check("shade never increases any segment's exposure",
          bool((shaded.exposure <= e.crash_test('heat2035',15,'older_adults').exposure + 1e-9).all()))

    # Shade cannot take exposure to zero: the heat index in shade is still hot.
    check("shade does not zero out exposure", shaded.total > 0,
          f"{shaded.total:.0f} ped-min remain in full shade")

    # The optimiser must respect its budget and actually help.
    out = a.optimize("heat2035", 15, "older_adults", 250000)
    check("optimiser stays within budget", out["spent_usd"] <= out["budget_usd"],
          f"spent ${out['spent_usd']:,.0f} of ${out['budget_usd']:,.0f}")
    check("optimiser reduces exposure", out["after"].total < out["before"].total,
          f"{out['reduction_pct']:.1f}% reduction")
    # No segment may be given more shade than it has pavement to shade.
    from collections import Counter
    pos = {sid: i for i, sid in enumerate(e.seg_ids)}
    tally = Counter((pl["kind"], pl["seg_id"]) for pl in out["placements"])
    over = [(k, sid, n) for (k, sid), n in tally.items()
            if n > int(a.max_units(k)[pos[sid]])]
    check("optimiser never over-fills a segment", not over,
          f"{len(tally)} segment-kind pairs placed, {len(over)} over capacity")

    # Spending must be exactly what the placements say it is.
    from engine import INTERVENTIONS
    claimed = sum(INTERVENTIONS[pl["kind"]]["cost_usd"] for pl in out["placements"])
    check("spend matches the placement log", abs(claimed - out["spent_usd"]) < 1e-6,
          f"${claimed:,.0f}")

    # More money must not buy less benefit.
    small = a.optimize("heat2035", 15, "older_adults", 50000)
    check("a larger budget helps at least as much",
          out["reduction_pct"] >= small["reduction_pct"] - 1e-9,
          f"$250k {out['reduction_pct']:.2f}% vs $50k {small['reduction_pct']:.2f}%")

    # A bus shelter can only go where a real unsheltered stop is, so the
    # optimiser must never buy more shelters than there are sites.
    from engine import INTERVENTIONS as IV
    if "transit_shelter" in IV and e.shelter_sites:
        cap = int(sum(e.shelter_sites.values()))
        big = a.optimize("heat2035", 15, "older_adults", 10_000_000,
                         ["transit_shelter"])
        check("shelters bounded by real stop inventory",
              big["counts"]["transit_shelter"] <= cap,
              f"{big['counts']['transit_shelter']} placed, {cap} real sites")
        check("restricting the kind restricts the spend",
              set(big["counts"]) == {"transit_shelter"},
              " / ".join(f"{k}:{v}" for k, v in big["counts"].items()))

    # Determinism: the same request twice must give the same answer.
    r1 = e.crash_test("heat2035", 15, "older_adults").total
    r2 = e.crash_test("heat2035", 15, "older_adults").total
    check("crash test is deterministic", r1 == r2, f"{r1:.6f}")

    width = max(len(n) for _, n, _ in results)
    fails = 0
    print("\nENGINE PROPERTY TESTS")
    print("-" * (width + 34))
    for ok, name, detail in results:
        print(f"{'  ok ' if ok else 'FAIL '} {name:<{width}}  {detail}")
        fails += not ok
    print("-" * (width + 34))
    print(f"{len(results)-fails}/{len(results)} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
