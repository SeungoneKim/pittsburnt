"""Property tests for stated optimisation programs.

These assert the claims the "State a goal" panel makes on screen. No language
model is involved: a program is a typed object, and everything below builds
one by hand so the solver can be tested without a network or a key.
"""
from __future__ import annotations

import json
import pathlib
import sys
from collections import Counter

import numpy as np

import program
from engine import Adapter, Engine

CACHE = pathlib.Path(__file__).resolve().parent.parent / "data" / "cache"
results: list[tuple[bool, str, str]] = []


def check(name, ok, detail=""):
    results.append((bool(ok), name, detail))


def main() -> int:
    e = Engine(CACHE)
    props = {f["properties"]["seg_id"]: f["properties"]
             for f in json.loads((CACHE / "segments.geojson").read_text())["features"]}
    a = Adapter(e, np.array([props[s]["length_m"] for s in e.seg_ids]))
    corridor = {s: e.seg_corridor.get(s) for s in e.seg_ids}

    BASE = {"objective": "min_severe", "budget_usd": 250000,
            "cells": [{"scenario": "heat2035", "hour": 15,
                       "persona": "older_adults"}]}

    def run(constraints, base=BASE):
        spec = {**base, "constraints": constraints}
        v = program.validate_spec(spec, e)
        if not v.ok:
            return None, v
        return program.solve(e, a, spec), v

    def spend_by_corridor(sol):
        out = Counter()
        for i, n in enumerate(sol["trees"]):
            if n:
                out[corridor[e.seg_ids[i]]] += int(n) * 1200
        for i, n in enumerate(sol["shelters"]):
            if n:
                out[corridor[e.seg_ids[i]]] += int(n) * 15000
        return out

    # --- the solver agrees with, and then certifies, the greedy answer ------
    free, _ = run([])
    greedy = a.optimize("heat2035", 15, "older_adults", 250000, None,
                        "pure_efficiency")
    after = e.crash_test("heat2035", 15, "older_adults",
                         sun_delta=a.sun_delta("tree", free["trees"],
                                               e.hour_index(15)),
                         shelter_delta=a.shelter_delta(free["shelters"]))
    check("MILP never does worse than greedy",
          after.severe_total <= greedy["after"].severe_total + 1e-6,
          f"{after.severe_total:.4f} vs greedy {greedy['after'].severe_total:.4f}")
    check("MILP returns an optimality certificate",
          free["solver"]["mip_gap"] is not None
          and free["solver"]["mip_gap"] < 1e-3,
          free["solver"]["certificate"])
    check("the solved plan respects the budget",
          free["spent_usd"] <= 250000 + 1e-6,
          f"${free['spent_usd']:,.0f} of $250,000")

    # --- the constraint that replaces the hard-coded policy ----------------
    floored, _ = run([{"type": "corridor_floor", "min_units": 1}])
    base_named = {c for c, v in spend_by_corridor(free).items() if c and v}
    floor_named = {c for c, v in spend_by_corridor(floored).items() if c and v}
    check("a corridor floor reaches corridors efficiency ignores",
          len(floor_named) > len(base_named) * 3,
          f"{len(base_named)} corridors -> {len(floor_named)}")
    report = next(r for r in floored["constraint_report"]
                  if r["type"] == "corridor_floor")
    per = {}
    for i, n in enumerate(floored["trees"]):
        c = corridor[e.seg_ids[i]]
        if c:
            per[c] = per.get(c, 0) + int(n)
    for i, n in enumerate(floored["shelters"]):
        c = corridor[e.seg_ids[i]]
        if c:
            per[c] = per.get(c, 0) + int(n)
    check("every corridor the floor covers really receives a unit",
          all(per.get(c, 0) >= 1 for c in floor_named),
          f"{report['corridors']} corridors, min received "
          f"{min(per.get(c, 0) for c in floor_named)}")

    # --- equity costs something, and the cost is reported ------------------
    e_free = e.crash_test("heat2035", 15, "older_adults",
                          sun_delta=a.sun_delta("tree", free["trees"], e.hour_index(15)),
                          shelter_delta=a.shelter_delta(free["shelters"]))
    e_floor = e.crash_test("heat2035", 15, "older_adults",
                           sun_delta=a.sun_delta("tree", floored["trees"], e.hour_index(15)),
                           shelter_delta=a.shelter_delta(floored["shelters"]))
    check("spreading protection costs total benefit, and not a lot",
          e_free.severe_total <= e_floor.severe_total,
          f"{e_free.severe_total:.2f} -> {e_floor.severe_total:.2f} severe "
          f"(+{100*(e_floor.severe_total-e_free.severe_total)/e_free.severe_total:.2f}%)")

    # --- a spend cap binds, and says so ------------------------------------
    tight, _ = run([{"type": "focus", "scope": {"corridor": "Forbes Avenue"},
                     "weight": 50},
                    {"type": "spend_cap", "scope": {"corridor": "Forbes Avenue"},
                     "max_fraction": 0.1}])
    forbes = spend_by_corridor(tight).get("Forbes Avenue", 0)
    cap = next(r for r in tight["constraint_report"] if r["type"] == "spend_cap")
    check("a spend cap is obeyed even against a strong preference",
          forbes <= 0.1 * 250000 + 1e-6,
          f"${forbes:,.0f} of a ${0.1*250000:,.0f} ceiling")
    check("a binding constraint is reported as binding",
          cap["status"] == "binding", cap["note"][:70])

    # --- a slack constraint is reported as slack, not as an achievement ----
    loose, _ = run([{"type": "spend_cap", "scope": {"corridor": "Forbes Avenue"},
                     "max_fraction": 0.95}])
    cap2 = next(r for r in loose["constraint_report"] if r["type"] == "spend_cap")
    check("a constraint that never bound is reported as costing nothing",
          cap2["status"] == "slack", cap2["note"][:70])

    # --- the gate refuses what the engine cannot express -------------------
    _, bad = run([{"type": "spend_cap", "scope": {"corridor": "Nonexistent Blvd"},
                   "max_fraction": 0.5}])
    check("a program naming a street that does not exist is refused",
          not bad.ok and any("Nonexistent" in r for r in bad.reasons),
          bad.reasons[0][:80] if bad.reasons else "")
    _, bad2 = run([{"type": "make_it_cooler"}])
    check("a constraint the vocabulary lacks is refused by name",
          not bad2.ok and any("make_it_cooler" in r for r in bad2.reasons))
    _, bad3 = run([], {**BASE, "objective": "minimise_deaths"})
    check("an objective the engine does not implement is refused",
          not bad3.ok, bad3.reasons[0][:70] if bad3.reasons else "")

    # --- an impossible program is reported, never silently relaxed ---------
    imp, _ = run([{"type": "corridor_floor", "min_units": 4}],
                 {**BASE, "budget_usd": 20000})
    check("an infeasible program is reported, not quietly relaxed",
          imp["status"] == "infeasible", imp["solver"]["note"][:70])

    # --- the second demo sentence, as a program ---------------------------
    # "...guarantee at least one intervention on Fifth Avenue and Craig
    # Street ... and use both trees and shaded waiting shelters"
    both, _ = run([
        {"type": "focus", "scope": {"corridor": "Forbes Avenue"}, "weight": 3},
        {"type": "corridor_floor", "min_units": 1,
         "scope": ["Fifth Avenue", "South Craig Street"]},
        {"type": "spend_cap", "scope": {"corridor": "Forbes Avenue"},
         "max_fraction": 0.5},
        {"type": "kind_floor", "kind": "tree", "min_units": 1},
        {"type": "kind_floor", "kind": "shaded_shelter", "min_units": 1}])
    check("efficiency alone buys no shelter at this hour",
          int(free["shelters"].sum()) == 0,
          "so 'use both kinds' has to be stated, not hoped for")
    check("a kind floor forces a shelter efficiency would not buy",
          int(both["shelters"].sum()) >= 1,
          f"{int(both['trees'].sum())} trees + {int(both['shelters'].sum())} shelter")
    named = spend_by_corridor(both)
    check("a scoped corridor floor reaches exactly the named streets",
          named.get("Fifth Avenue", 0) > 0
          and named.get("South Craig Street", 0) > 0,
          f"Fifth ${named.get('Fifth Avenue', 0):,}  "
          f"S Craig ${named.get('South Craig Street', 0):,}")
    check("a scoped floor does NOT force every other corridor",
          len([c for c, v in named.items() if c and v]) < 30,
          f"{len([c for c in named if c])} corridors touched, not all 67")
    cap3 = next(r for r in both["constraint_report"] if r["type"] == "spend_cap")
    check("the Forbes cap binds once Forbes is also prioritised",
          cap3["status"] == "binding", cap3["note"][:70])

    # --- the gate refuses an intervention type the engine lacks ------------
    _, bad4 = run([{"type": "kind_floor", "kind": "misting_fan",
                    "min_units": 2}])
    check("a kind floor naming an intervention we do not model is refused",
          not bad4.ok and any("misting_fan" in r for r in bad4.reasons),
          bad4.reasons[0][:75] if bad4.reasons else "")

    # --- the program is audited against the sentence it came from ---------
    # A model that narrows "Craig Street" to one of the two real Craig
    # Streets writes a VALID program that answers a question nobody asked.
    # Only the source text can catch that, so the audit reads it.
    def audit(text, cons):
        return program.audit_references({"constraints": cons}, text, e)

    amb = audit("guarantee one intervention on Craig Street",
                [{"type": "corridor_floor", "min_units": 1,
                  "scope": ["North Craig Street"]}])
    check("a silently narrowed street reference is caught",
          len(amb) == 1 and amb[0]["kind"] == "ambiguous",
          amb[0]["message"][:72] if amb else "nothing flagged")
    check("both real candidates are offered back",
          amb and amb[0]["candidates"] == ["North Craig Street",
                                           "South Craig Street"])
    check("naming the street explicitly passes the audit",
          not audit("guarantee one intervention on South Craig Street",
                    [{"type": "corridor_floor", "min_units": 1,
                      "scope": ["South Craig Street"]}]))
    # Two short names in one sentence are two references, not rivals for one
    # slot - an earlier version compared support globally and flagged both.
    check("two different short names in one sentence are not rivals",
          not audit("Prioritise Fifth and cap Forbes at a third of the budget",
                    [{"type": "focus", "scope": {"corridor": "Fifth Avenue"},
                      "weight": 3},
                     {"type": "spend_cap",
                      "scope": {"corridor": "Forbes Avenue"},
                      "max_fraction": 0.33}]),
          "Fifth -> Fifth Avenue, Forbes -> Forbes Avenue")
    unm = audit("Spread the money around",
                [{"type": "corridor_floor", "min_units": 1,
                  "scope": ["Forbes Avenue"]}])
    check("a street the sentence never mentions is reported",
          len(unm) == 1 and unm[0]["kind"] == "unmentioned",
          unm[0]["message"][:70] if unm else "nothing flagged")

    # --- determinism -------------------------------------------------------
    r1, _ = run([{"type": "corridor_floor", "min_units": 1}])
    r2, _ = run([{"type": "corridor_floor", "min_units": 1}])
    check("solving the same program twice gives the same plan",
          bool((r1["trees"] == r2["trees"]).all()
               and (r1["shelters"] == r2["shelters"]).all()),
          f"{int(r1['trees'].sum())} trees both times")

    width = max(len(n) for _, n, _ in results)
    fails = 0
    print("\nSTATED-PROGRAM PROPERTY TESTS (MILP)")
    print("-" * (width + 40))
    for ok, name, detail in results:
        print(f"{'  ok ' if ok else 'FAIL '} {name:<{width}}  {detail}")
        fails += not ok
    print("-" * (width + 40))
    print(f"{len(results)-fails}/{len(results)} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
