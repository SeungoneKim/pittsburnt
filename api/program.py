"""Optimisation programs: say what you want, and let a solver decide where.

The 2.6 optimiser answered one question well - "spend B dollars to avoid the
most severe minutes for one cohort at one hour" - and answered it with a
greedy search. Measuring that search found it within 0.05% of optimal, which
sounds like success and is actually a diagnosis: the question was easy
because it was under-specified. A single cohort, a single hour and a single
objective is a separable problem under one budget, and greedy is near-exact
for that shape.

The hard problem was still there, hidden behind a hard-coded rule. Pure
efficiency gives 118 of 128 named streets nothing and one of the three hero
corridors zero dollars, so "Balanced Protection" existed to jam one shelter
onto each hero corridor by name. That is a policy written as a for-loop.

This module replaces it with a program a person can state and a solver can
answer:

    minimise   weighted exposure across a set of (scenario, hour, persona)
    subject to a budget, and any number of stated constraints
               - no corridor left with nothing
               - no more than a share of the budget in one place
               - a floor on what each corridor must receive

Every constraint is declarative. Nothing here knows the name of a street.

WHY A MILP, AND WHY IT IS EXACT
-------------------------------
Tree shade enters as sun_after = sun0 * (1 - block * k * shade_m / length),
clipped at full coverage. Capacity is one site per SITE_SPACING_M = 10 m
while a crown spans shade_m = 8 m, so the most any segment can reach is
k*8/L <= 0.8 and THE CLIP NEVER BINDS. Exposure is therefore exactly linear
in the number of trees - no piecewise approximation, no concave envelope.

The single non-linearity is the waiting term, where unsheltered waiting sees
whatever sun the footway sees: wt * (1 - cover) * sun couples a shelter
variable to a tree variable. That product is linearised exactly with a
standard big-M pair on the 84 segments that carry both, so the program is a
true reformulation rather than a relaxation.

Sizes: ~619 integer tree variables, ~90 binary shelter variables. HiGHS,
which ships inside SciPy, closes it in well under a second and returns a
certified optimality gap - so the UI can say how far from optimal a plan is
instead of claiming "greedy search, not a proven global optimum".
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import LinearConstraint, milp
from scipy.sparse import csr_matrix

from engine import HEAT_LOAD_BASE_C, INTERVENTIONS, SEVERE_UTCI_C

OBJECTIVES = {
    "min_heat_load": "Minimise cumulative heat load (continuous above 26 C)",
    "min_severe": "Minimise person-minutes at or above UTCI 38 C",
}

CONSTRAINT_TYPES = {
    "corridor_floor": {
        "summary": "Named corridors - or every corridor carrying walking "
                   "demand, if no scope is given - must each receive "
                   "something.",
        "fields": {"min_units": "int >= 1, units each corridor must receive",
                   "scope": "optional corridor or list of corridors; "
                            "defaults to every corridor with demand"},
    },
    "kind_floor": {
        "summary": "At least N units of one intervention type must be bought. "
                   "Pure efficiency buys no shelters at 3 PM, so this is how "
                   "'use both trees and shelters' is stated.",
        "fields": {"kind": "tree | shaded_shelter", "min_units": "int >= 1"},
    },
    "kind_cap": {
        "summary": "At most N units of one intervention type.",
        "fields": {"kind": "tree | shaded_shelter", "max_units": "int >= 0"},
    },
    "spend_cap": {
        "summary": "No more than a share of the budget inside one scope.",
        "fields": {"max_fraction": "0 < f <= 1", "scope": "corridor or list"},
    },
    "spend_floor": {
        "summary": "At least a share of the budget inside one scope.",
        "fields": {"min_fraction": "0 <= f < 1", "scope": "corridor or list"},
    },
    "focus": {
        "summary": "Weight benefit inside a scope more heavily. A preference, "
                   "not a requirement - it changes the objective, never "
                   "feasibility.",
        "fields": {"weight": "> 0, multiplier on benefit inside the scope",
                   "scope": "corridor or list"},
    },
}


@dataclass
class Cell:
    scenario: str
    hour: int
    persona: str
    weight: float = 1.0


@dataclass
class SpecVerdict:
    ok: bool
    reasons: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    # Short forms the gate expanded to real corridor names, so a person can
    # see what their words were taken to mean.
    resolved: list[dict] = field(default_factory=list)


def _rewrite_scope(scope, mapping: dict[str, str]):
    """Rebuild a scope with every name replaced by its resolved form."""
    if isinstance(scope, str):
        return mapping.get(scope, scope)
    if isinstance(scope, list):
        return [_rewrite_scope(x, mapping) for x in scope]
    if isinstance(scope, dict):
        out = dict(scope)
        if "corridor" in out:
            out["corridor"] = _rewrite_scope(out["corridor"], mapping)
        if "corridors" in out:
            out["corridors"] = _rewrite_scope(out["corridors"], mapping)
        return out
    return scope


def resolve_corridors(spec: dict, engine) -> tuple[list[dict], list[str]]:
    """Expand short street names deterministically, or refuse and say why.

    Oakland has both a North and a South Craig Street, so "Craig Street" is
    genuinely ambiguous. Leaving that judgement to the language model made it
    non-deterministic - one run picked South, the next declined - which is the
    worst of both worlds. The rule now lives here: an exact match stands, a
    name matching exactly one corridor is expanded and reported, and a name
    matching several is refused with the candidates named so a person can
    choose. The model never guesses a street.
    """
    known = sorted({c for c in engine.seg_corridor.values() if c})
    lower = {c.lower(): c for c in known}
    mapping: dict[str, str] = {}
    resolved: list[dict] = []
    problems: list[str] = []

    for k in spec.get("constraints") or []:
        for raw in _scope_names(k.get("scope")):
            if raw in known or raw in mapping:
                continue
            if raw.lower() in lower:
                mapping[raw] = lower[raw.lower()]
                resolved.append({"wrote": raw, "meant": lower[raw.lower()],
                                 "why": "differs only in capitalisation"})
                continue
            needle = raw.lower().strip()
            hits = [c for c in known
                    if needle in c.lower() or c.lower() in needle]
            if len(hits) == 1:
                mapping[raw] = hits[0]
                resolved.append({"wrote": raw, "meant": hits[0],
                                 "why": "the only corridor it can mean"})
            elif len(hits) > 1:
                problems.append(
                    f"'{raw}' is ambiguous - it could mean "
                    + " or ".join(f"'{h}'" for h in hits)
                    + ". Name the one you want; the engine will not guess.")
            else:
                problems.append(f"'{raw}' is not a corridor in the modelled "
                                f"network.")
    if mapping:
        for k in spec.get("constraints") or []:
            if "scope" in k:
                k["scope"] = _rewrite_scope(k["scope"], mapping)
    return resolved, problems


def validate_spec(spec: dict, engine) -> SpecVerdict:
    """The gate for a stated program. Same contract as solutions.validate.

    A language model writes these. So every field is checked against what the
    engine actually has - a corridor that does not exist, an objective that is
    not implemented, or a fraction outside (0, 1] is refused by name rather
    than silently coerced into something that runs.
    """
    reasons: list[str] = []
    missing: list[str] = []
    questions: list[str] = []

    obj = str(spec.get("objective") or "")
    if obj not in OBJECTIVES:
        missing.append("objective")
        reasons.append(f"'{obj or 'none'}' is not an objective this engine "
                       f"implements. Supported: {', '.join(OBJECTIVES)}.")

    budget = spec.get("budget_usd")
    try:
        budget = float(budget)
    except (TypeError, ValueError):
        budget = 0.0
    if budget < min(v["cost_usd"] for v in INTERVENTIONS.values()):
        missing.append("budget_usd")
        reasons.append("The budget is below the cheapest single unit, so no "
                       "plan can be built.")

    cells = spec.get("cells") or []
    if not cells:
        missing.append("cells")
        questions.append("Which scenario, hour and population should this "
                         "plan be built for?")
    for n, c in enumerate(cells):
        if str(c.get("scenario")) not in engine.scenarios["scenarios"]:
            reasons.append(f"cells[{n}]: unknown scenario "
                           f"'{c.get('scenario')}'.")
            missing.append(f"cells[{n}].scenario")
        if int(c.get("hour", -1)) not in engine.hours:
            reasons.append(f"cells[{n}]: hour must be one of {engine.hours}.")
            missing.append(f"cells[{n}].hour")
        if str(c.get("persona")) not in engine.personas:
            reasons.append(f"cells[{n}]: unknown population "
                           f"'{c.get('persona')}'.")
            missing.append(f"cells[{n}].persona")

    # Resolve short street names BEFORE checking them, so "Fifth" is
    # expanded rather than refused, and "Craig Street" is refused with both
    # candidates named rather than silently resolved to one of them.
    resolved, scope_problems = resolve_corridors(spec, engine)
    reasons.extend(scope_problems)
    if scope_problems:
        missing.append("constraints.scope")
        questions.extend(p for p in scope_problems if "ambiguous" in p)

    known = {c for c in engine.seg_corridor.values() if c}
    for n, k in enumerate(spec.get("constraints") or []):
        kind = str(k.get("type") or "")
        if kind not in CONSTRAINT_TYPES:
            reasons.append(f"constraints[{n}]: '{kind or 'none'}' is not a "
                           f"constraint this engine can express. Supported: "
                           f"{', '.join(CONSTRAINT_TYPES)}.")
            missing.append(f"constraints[{n}].type")
            continue
        # Any name still unresolved was already reported once, by name, with
        # its candidates. Reporting it again here only told a person the same
        # thing twice in different words.
        if any(name not in known for name in _scope_names(k.get("scope"))):
            continue
        if kind == "spend_cap":
            f = k.get("max_fraction")
            if not isinstance(f, (int, float)) or not 0 < float(f) <= 1:
                reasons.append(f"constraints[{n}]: max_fraction must be a "
                               f"share in (0, 1].")
                missing.append(f"constraints[{n}].max_fraction")
        if kind == "spend_floor":
            f = k.get("min_fraction")
            if not isinstance(f, (int, float)) or not 0 <= float(f) < 1:
                reasons.append(f"constraints[{n}]: min_fraction must be a "
                               f"share in [0, 1).")
                missing.append(f"constraints[{n}].min_fraction")
        if kind == "focus":
            w = k.get("weight")
            if not isinstance(w, (int, float)) or float(w) <= 0:
                reasons.append(f"constraints[{n}]: weight must be above zero.")
                missing.append(f"constraints[{n}].weight")
        if kind in ("kind_floor", "kind_cap"):
            kk = str(k.get("kind") or "")
            if kk not in INTERVENTIONS:
                reasons.append(f"constraints[{n}]: '{kk or 'none'}' is not an "
                               f"intervention this engine models. Available: "
                               f"{', '.join(INTERVENTIONS)}.")
                missing.append(f"constraints[{n}].kind")
            field = "min_units" if kind == "kind_floor" else "max_units"
            v = k.get(field)
            if not isinstance(v, int) or v < 0:
                reasons.append(f"constraints[{n}]: {field} must be a "
                               f"non-negative whole number of units.")
                missing.append(f"constraints[{n}].{field}")

    return SpecVerdict(not missing, reasons, missing, questions[:3], resolved)


def _scope_names(scope) -> list[str]:
    if scope is None:
        return []
    if isinstance(scope, str):
        return [scope]
    if isinstance(scope, dict):
        v = scope.get("corridor") or scope.get("corridors")
        return _scope_names(v)
    if isinstance(scope, list):
        out: list[str] = []
        for s in scope:
            out.extend(_scope_names(s))
        return out
    return []


# --- building the program --------------------------------------------------

def _cell_arrays(engine, cell: Cell, objective: str):
    """Per-segment coefficients for one (scenario, hour, persona) cell."""
    hi = engine.hour_index(cell.hour)
    pi = engine.persona_index(cell.persona)
    cond = engine.conditions(cell.scenario, cell.hour)
    u_sun, u_shade = float(cond["utci_sun_c"]), float(cond["utci_shade_c"])
    if objective == "min_severe":
        hot, cool = float(u_sun >= SEVERE_UTCI_C), float(u_shade >= SEVERE_UTCI_C)
    else:
        hot = max(u_sun - HEAT_LOAD_BASE_C, 0.0)
        cool = max(u_shade - HEAT_LOAD_BASE_C, 0.0)
    return {
        "sun0": engine.sun_exposure[:, hi].astype(float),
        "minutes": engine.minutes[:, pi, hi].astype(float),
        "waiting": engine.wait_minutes[:, pi, hi].astype(float),
        # The gap between being in sun and being in shade. This is the whole
        # value of shade under this objective; when it is zero - as the severe
        # metric is at 8 AM, noon and 6 PM - the cell can express no
        # preference at all, which is why heat load is the default.
        "delta": hot - cool,
        "hour_index": hi,
    }


def solve(engine, adapter, spec: dict) -> dict:
    """Solve a stated program exactly, and report how exactly.

    Returns the same shape the greedy optimiser returns, so every consumer -
    the map, the result card, the offline bundle - keeps working, plus a
    `solver` block carrying the certified gap and the fate of each stated
    constraint.
    """
    objective = str(spec["objective"])
    budget = float(spec["budget_usd"])
    cells = [Cell(str(c["scenario"]), int(c["hour"]), str(c["persona"]),
                  float(c.get("weight", 1.0))) for c in spec["cells"]]
    constraints = list(spec.get("constraints") or [])

    n_seg = len(engine.seg_ids)
    corridor = [engine.seg_corridor.get(s) for s in engine.seg_ids]
    tcap = adapter.max_units("tree").astype(int)
    scap = adapter.max_units("shaded_shelter").astype(int)
    cover0 = engine.shelter_coverage.astype(float)
    tree_cost = float(adapter.interventions["tree"]["cost_usd"])
    shel_cost = float(adapter.interventions["shaded_shelter"]["cost_usd"])
    tspec = adapter.interventions["tree"]
    # Shade a single tree removes, as a fraction of the segment's own sun.
    g = np.where(adapter.lengths > 0,
                 tspec["block"] * tspec["shade_m"] / np.maximum(adapter.lengths, 1e-9),
                 0.0)

    per_cell = [_cell_arrays(engine, c, objective) for c in cells]
    demand = np.zeros(n_seg, dtype=bool)
    for d in per_cell:
        demand |= (d["minutes"] > 0) | (d["waiting"] > 0)

    # --- focus multipliers (objective only, never feasibility) -------------
    focus = np.ones(n_seg)
    for k in constraints:
        if str(k.get("type")) == "focus":
            names = set(_scope_names(k.get("scope")))
            w = float(k.get("weight", 1.0))
            for i in range(n_seg):
                if corridor[i] in names:
                    focus[i] *= w

    # --- variables ---------------------------------------------------------
    tree_of: dict[int, int] = {}          # segment -> column
    cols: list[str] = []
    lo: list[float] = []
    hi_: list[float] = []
    integ: list[int] = []
    for i in np.nonzero((tcap > 0) & demand)[0]:
        tree_of[int(i)] = len(cols)
        cols.append(f"tree[{i}]"); lo.append(0.0); hi_.append(float(tcap[i]))
        integ.append(1)

    shel_of: dict[tuple[int, int], int] = {}
    for i in np.nonzero(scap > 0)[0]:
        for m in range(int(scap[i])):
            shel_of[(int(i), m)] = len(cols)
            cols.append(f"shelter[{i},{m}]"); lo.append(0.0); hi_.append(1.0)
            integ.append(1)

    # Exact linearisation of wt * (1 - cover) * sun: one product variable per
    # (cell, shelter site), bounded so it can never exceed the sun actually
    # left on that segment after trees.
    prod_of: dict[tuple[int, int, int], int] = {}
    for ci, d in enumerate(per_cell):
        for (i, m), _ in shel_of.items():
            if d["waiting"][i] > 0 and d["delta"] > 0:
                prod_of[(ci, i, m)] = len(cols)
                cols.append(f"p[{ci},{i},{m}]")
                lo.append(0.0); hi_.append(float(d["sun0"][i])); integ.append(0)

    n = len(cols)
    obj = np.zeros(n)

    # --- objective: minimise weighted exposure -----------------------------
    for ci, (cell, d) in enumerate(zip(cells, per_cell)):
        if d["delta"] <= 0:
            continue                       # this cell cannot tell shade apart
        w = cell.weight
        C = 1.0 - cover0
        for i, col in tree_of.items():
            # One tree removes sun0*g fraction of sun, felt by everyone
            # walking it and by anyone waiting unsheltered on it.
            obj[col] -= (w * d["delta"] * focus[i] * d["sun0"][i] * g[i]
                         * (d["minutes"][i] + d["waiting"][i] * C[i]))
        for (cj, i, m), col in prod_of.items():
            if cj != ci:
                continue
            obj[col] -= (w * d["delta"] * focus[i] * d["waiting"][i] * C[i]
                         / max(int(scap[i]), 1))

    rows: list[tuple[list[int], list[float], float, float]] = []   # cols, vals, lb, ub
    stated: list[dict] = []

    # --- product linearisation --------------------------------------------
    for (ci, i, m), col in prod_of.items():
        s_col = shel_of[(i, m)]
        S = float(per_cell[ci]["sun0"][i])
        # p <= S * s      (no shelter, no product)
        rows.append(([col, s_col], [1.0, -S], -np.inf, 0.0))
        # p <= sun_after  (a shelter is worth only the sun still there)
        if i in tree_of:
            rows.append(([col, tree_of[i]], [1.0, S * g[i]], -np.inf, S))
        else:
            rows.append(([col], [1.0], -np.inf, S))

    # --- budget ------------------------------------------------------------
    bcols = list(tree_of.values()) + list(shel_of.values())
    bvals = ([tree_cost] * len(tree_of)) + ([shel_cost] * len(shel_of))
    rows.append((bcols, bvals, -np.inf, budget))

    # --- stated constraints ------------------------------------------------
    for k in constraints:
        kind = str(k.get("type"))
        names = set(_scope_names(k.get("scope")))
        in_scope = [i for i in range(n_seg) if corridor[i] in names] if names else []

        if kind in ("spend_cap", "spend_floor"):
            cc = [tree_of[i] for i in in_scope if i in tree_of]
            vv = [tree_cost] * len(cc)
            for (i, m), col in shel_of.items():
                if i in in_scope:
                    cc.append(col); vv.append(shel_cost)
            if not cc:
                stated.append({"type": kind, "scope": sorted(names),
                               "status": "vacuous",
                               "note": "no candidate site lies in that scope, "
                                       "so the constraint cannot bind."})
                continue
            if kind == "spend_cap":
                lim = float(k["max_fraction"]) * budget
                rows.append((cc, vv, -np.inf, lim))
                stated.append({"type": kind, "scope": sorted(names),
                               "limit_usd": lim, "cols": cc, "vals": vv,
                               "sense": "<="})
            else:
                lim = float(k["min_fraction"]) * budget
                rows.append((cc, vv, lim, np.inf))
                stated.append({"type": kind, "scope": sorted(names),
                               "limit_usd": lim, "cols": cc, "vals": vv,
                               "sense": ">="})

        elif kind == "corridor_floor":
            need = int(k.get("min_units", 1))
            # Default scope: every corridor that carries demand AND has at
            # least one candidate site. A corridor with demand but nowhere to
            # plant would make the program infeasible rather than fair, so it
            # is reported instead of imposed.
            # Two passes on purpose. A single pass that collected plantable
            # segments only after meeting a demand segment was
            # order-dependent, and silently covered 67 of 128 corridors.
            wanted = {corridor[i] for i in range(n_seg)
                      if corridor[i] and demand[i]
                      and (not names or corridor[i] in names)}
            groups: dict[str, list[int]] = {c: [] for c in wanted}
            for i in range(n_seg):
                c = corridor[i]
                if c in groups and (i in tree_of or scap[i] > 0):
                    groups[c].append(i)
            skipped: list[str] = []
            covered = 0
            for c, segs in sorted(groups.items()):
                cc = [tree_of[i] for i in segs if i in tree_of]
                vv = [1.0] * len(cc)
                for (i, m), col in shel_of.items():
                    if i in segs:
                        cc.append(col); vv.append(1.0)
                if not cc:
                    skipped.append(c)
                    continue
                rows.append((cc, vv, float(need), np.inf))
                covered += 1
            stated.append({"type": kind, "min_units": need,
                           "corridors": covered, "skipped": skipped,
                           "sense": ">=", "status": "applied",
                           "floor_cost_usd": round(covered * need * tree_cost, 2),
                           "note": (f"{covered} of {len(wanted)} corridors with "
                                    f"demand must each receive >= {need} unit(s)")
                           + (f"; {len(skipped)} carry demand but have no "
                              f"plantable site, so they are reported rather "
                              f"than forced (that would be infeasible, not fair)"
                              if skipped else "")})

        elif kind in ("kind_floor", "kind_cap"):
            want = str(k["kind"])
            cc = ([tree_of[i] for i in tree_of] if want == "tree"
                  else list(shel_of.values()))
            if not cc:
                stated.append({"type": kind, "kind": want, "status": "vacuous",
                               "note": f"no {want} site exists in this "
                                       f"network, so the constraint cannot "
                                       f"bind."})
                continue
            if kind == "kind_floor":
                need = int(k["min_units"])
                rows.append((cc, [1.0] * len(cc), float(need), np.inf))
                stated.append({"type": kind, "kind": want, "units": need,
                               "sense": ">=", "status": "applied",
                               "note": f"at least {need} {want.replace('_', ' ')}"
                                       f"(s) must be bought, whether or not "
                                       f"efficiency alone would choose any"})
            else:
                lim = int(k["max_units"])
                rows.append((cc, [1.0] * len(cc), -np.inf, float(lim)))
                stated.append({"type": kind, "kind": want, "units": lim,
                               "sense": "<=", "status": "applied",
                               "note": f"at most {lim} "
                                       f"{want.replace('_', ' ')}(s)"})

        elif kind == "focus":
            stated.append({"type": kind, "scope": sorted(names),
                           "weight": float(k.get("weight", 1.0)),
                           "status": "applied",
                           "note": f"benefit inside {', '.join(sorted(names))} "
                                   f"weighted x{float(k.get('weight', 1.0)):g} "
                                   f"in the objective; a preference, so it "
                                   f"cannot make the program infeasible."})

    # --- solve -------------------------------------------------------------
    data: list[float] = []; ri: list[int] = []; ci_: list[int] = []
    lb = np.empty(len(rows)); ub = np.empty(len(rows))
    for r, (cc, vv, l, u) in enumerate(rows):
        for c, v in zip(cc, vv):
            ri.append(r); ci_.append(c); data.append(v)
        lb[r] = l; ub[r] = u
    A = csr_matrix((data, (ri, ci_)), shape=(len(rows), n))

    res = milp(c=obj, integrality=np.array(integ),
               bounds=(np.array(lo), np.array(hi_)),
               constraints=LinearConstraint(A, lb, ub),
               options={"time_limit": 25.0, "mip_rel_gap": 1e-4,
                        "presolve": True})
    if res.x is None:
        return {"status": "infeasible", "solver": {
            "backend": "HiGHS", "status": res.message,
            "note": "No plan satisfies every stated constraint at this "
                    "budget. Relax a constraint or raise the budget."}}

    x = np.array(res.x)
    trees = np.zeros(n_seg, dtype=int)
    shelters = np.zeros(n_seg, dtype=int)
    for i, col in tree_of.items():
        trees[i] = int(round(x[col]))
    for (i, m), col in shel_of.items():
        shelters[i] += int(round(x[col]))

    # --- what happened to each stated constraint ---------------------------
    for s in stated:
        if "cols" not in s:
            continue
        used = float(sum(v * x[c] for c, v in zip(s["cols"], s["vals"])))
        s["used_usd"] = round(used, 2)
        lim = s.pop("limit_usd")
        s["limit_usd"] = round(lim, 2)
        slack = lim - used if s["sense"] == "<=" else used - lim
        # Binding, for an INTEGER program, means "one more unit would break
        # it" - not "the bound is met exactly". A $25,000 ceiling with
        # $1,200 trees stops at $24,000 and is fully binding there; testing
        # for equality called that slack and would have told a planner the
        # constraint cost them nothing.
        step = min(v["cost_usd"] for v in adapter.interventions.values())
        s["status"] = "binding" if slack < step - 1e-6 else "slack"
        s["note"] = (
            f"${used:,.0f} of the ${lim:,.0f} "
            f"{'ceiling' if s['sense'] == '<=' else 'floor'}"
            + (f"; no further unit fits inside it, so this is what stopped "
               f"the optimiser." if s["status"] == "binding"
               else "; the constraint never bound, so it cost nothing."))
        s.pop("cols"); s.pop("vals")

    gap = getattr(res, "mip_gap", None)
    return {
        "status": "complete",
        "trees": trees, "shelters": shelters,
        "spent_usd": float(trees.sum() * tree_cost + shelters.sum() * shel_cost),
        "solver": {
            "backend": "HiGHS via scipy.optimize.milp",
            "variables": n, "constraints": len(rows),
            "integer_variables": int(sum(integ)),
            "mip_gap": None if gap is None else float(gap),
            "objective": objective,
            "certificate": (
                f"proved within {gap * 100:.4f}% of the true optimum"
                if gap is not None and np.isfinite(gap)
                else "solved to optimality"),
        },
        "constraint_report": stated,
    }


def materialise(engine, adapter, spec: dict, sol: dict) -> dict:
    """Turn a solved program into the plan shape the rest of the app speaks.

    The solver returns counts; everything a person sees - exact coordinates,
    real shade footprints, before and after exposure - is produced here by the
    same engine calls the greedy path uses, so a MILP plan and a greedy plan
    are rendered and measured identically and can be compared honestly.
    """
    cells = spec["cells"]
    primary = cells[0]
    sc, hr, pe = str(primary["scenario"]), int(primary["hour"]), str(primary["persona"])
    hi = engine.hour_index(hr)
    trees, shelters = sol["trees"], sol["shelters"]

    sun_delta = adapter.sun_delta("tree", trees, hi)
    shelter_delta = adapter.shelter_delta(shelters)
    before = engine.crash_test(sc, hr, pe)
    after = engine.crash_test(sc, hr, pe, sun_delta=sun_delta,
                              shelter_delta=shelter_delta)

    # Per-unit saving, analytically. Exposure is linear in tree count, so a
    # unit's contribution is exact rather than an attribution guess - and
    # ordering by it makes the placement animation show the best sites first.
    d_sev = _cell_arrays(engine, Cell(sc, hr, pe), "min_severe")
    d_load = _cell_arrays(engine, Cell(sc, hr, pe), "min_heat_load")
    C = 1.0 - np.clip(engine.shelter_coverage.astype(float) + shelter_delta, 0, 1)
    tspec = adapter.interventions["tree"]
    g = np.where(adapter.lengths > 0,
                 tspec["block"] * tspec["shade_m"] / np.maximum(adapter.lengths, 1e-9), 0.0)

    log: list[dict] = []
    for i in np.nonzero(trees)[0]:
        reach = d_sev["sun0"][i] * g[i] * (d_sev["minutes"][i]
                                           + d_sev["waiting"][i] * C[i])
        log.append({"seg_id": engine.seg_ids[i], "kind": "tree",
                    "cost_usd": tspec["cost_usd"], "_n": int(trees[i]),
                    "severe_minutes_saved": round(float(d_sev["delta"] * reach), 4),
                    "heat_load_saved": round(float(d_load["delta"] * d_load["sun0"][i]
                                                   * g[i] * (d_load["minutes"][i]
                                                   + d_load["waiting"][i] * C[i])), 3),
                    "phase": "marginal"})
    for i in np.nonzero(shelters)[0]:
        gain = float(adapter.shelter_delta(np.where(np.arange(len(trees)) == i,
                                                    shelters[i], 0))[i])
        saved = float(d_sev["delta"] * d_sev["waiting"][i] * gain
                      * max(d_sev["sun0"][i] - sun_delta[i], 0.0))
        log.append({"seg_id": engine.seg_ids[i], "kind": "shaded_shelter",
                    "cost_usd": adapter.interventions["shaded_shelter"]["cost_usd"],
                    "_n": int(shelters[i]),
                    "severe_minutes_saved": round(saved, 4),
                    "heat_load_saved": round(saved, 3), "phase": "marginal"})
    log.sort(key=lambda x: -x["severe_minutes_saved"] - 1e-9 * x["heat_load_saved"])
    expanded: list[dict] = []
    for entry in log:
        n = entry.pop("_n")
        for _ in range(n):
            expanded.append(dict(entry))

    units = adapter._unit_points(expanded)
    cond = engine.conditions(sc, hr)
    u_sun, u_shade = float(cond["utci_sun_c"]), float(cond["utci_shade_c"])
    after_sun = np.clip(d_sev["sun0"] - sun_delta, 0, 1)
    denom = before.severe_total or before.heat_load_total or 1.0
    num = ((before.severe_total - after.severe_total) if before.severe_total
           else (before.heat_load_total - after.heat_load_total))
    return {
        "before": before, "after": after,
        "placements": expanded,
        "counts": {"tree": int(trees.sum()),
                   "shaded_shelter": int(shelters.sum())},
        "spent_usd": sol["spent_usd"],
        "budget_usd": float(spec["budget_usd"]),
        "sun_delta": sun_delta, "shelter_delta": shelter_delta,
        "after_sun": after_sun,
        "after_utci_c": after_sun * u_sun + (1.0 - after_sun) * u_shade,
        "after_shelter_coverage": np.clip(
            engine.shelter_coverage.astype(float) + shelter_delta, 0, 1),
        "unit_placements": units,
        "shade_footprints": adapter.shade_footprints(units),
        "reduction_pct": 100.0 * num / denom,
        "metric_used": ("severe_person_minutes" if before.severe_total
                        else "heat_load"),
        "solver": sol["solver"],
        "constraint_report": sol["constraint_report"],
    }


# --- auditing a compiled program against the sentence it came from ---------

def _tokens(text: str) -> list[str]:
    """Words, lowercased, punctuation dropped.

    Token matching rather than substring matching, because "University Drive
    A" ends in a word that occurs as a substring of almost any sentence.
    """
    import re as _re
    return _re.findall(r"[a-z0-9]+", text.lower())


def _has_run(seq: list[str], run: list[str]) -> bool:
    n = len(run)
    return n > 0 and any(seq[i:i + n] == run for i in range(len(seq) - n + 1))


def _longest_mention(name: str, text_tokens: list[str]) -> list[str]:
    """The longest run of words from `name` the planner actually wrote."""
    w = _tokens(name)
    for span in range(len(w), 0, -1):
        for i in range(len(w) - span + 1):
            if _has_run(text_tokens, w[i:i + span]):
                return w[i:i + span]
    return []


def audit_references(spec: dict, text: str, engine) -> list[dict]:
    """Check every street the program names against what the planner wrote.

    This exists because of a real failure. Asked to guarantee something on
    "Craig Street", the model emitted "North Craig Street" - a valid corridor,
    so every name check passed - when Oakland has both a North and a South
    Craig Street and the planner meant neither in particular. A model silently
    narrowing an ambiguous reference to one valid option is the exact failure
    this architecture exists to prevent, and no amount of prompting makes it
    reliable.

    So the program is verified against its source. For each corridor the
    program names, find the longest run of that name the planner actually
    wrote, then ask how many corridors that run could mean. More than one and
    the planner is asked which; none and the reference is reported as absent
    from the sentence entirely.

    Judging each reference by its OWN wording matters: "prioritise Fifth and
    cap Forbes" mentions two streets, and an earlier version that compared
    support globally called them rivals for the same slot.
    """
    known = sorted({c for c in engine.seg_corridor.values() if c})
    tok = {c: _tokens(c) for c in known}
    text_tokens = _tokens(text)
    seen: set[str] = set()
    out: list[dict] = []

    for k in spec.get("constraints") or []:
        for name in _scope_names(k.get("scope")):
            if name in seen or name not in known:
                continue
            seen.add(name)
            mention = _longest_mention(name, text_tokens)
            if not mention:
                out.append({
                    "kind": "unmentioned", "chose": name, "candidates": [],
                    "message": (f"The program constrains '{name}', but your "
                                f"sentence never mentions it."),
                })
                continue
            could_mean = [c for c in known if _has_run(tok[c], mention)]
            if len(could_mean) > 1:
                out.append({
                    "kind": "ambiguous", "chose": name,
                    "candidates": sorted(could_mean),
                    "message": (
                        f"You wrote \"{' '.join(mention)}\", which could mean "
                        + " or ".join(f"'{c}'" for c in sorted(could_mean))
                        + f". The program picked '{name}'. Name the one you "
                        f"want; the engine will not guess."),
                })
    return out
