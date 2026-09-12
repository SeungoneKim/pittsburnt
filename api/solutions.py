"""Add New Solution (Beta): the boundary between a language model and the engine.

The rule this file exists to enforce: a language model may research, structure
and question. It may never invent an effect, choose a coordinate, alter an
engine array, or turn prose into a number the optimiser then spends money on.

So a proposed solution arrives as a typed draft, is checked here against a
mechanism gate, and only a draft that clears the gate AND is confirmed by a
person is translated into an intervention the deterministic engine can price
and site. Everything else is reported as un-simulatable, with the specific
evidence that is missing - not silently converted into a cooling factor.
"""
from __future__ import annotations

from dataclasses import dataclass

# What this engine can honestly represent, and what each route needs before it
# can be simulated. The statuses come from the 2.6 spec's mechanism gate.
#
#   simulate_now   the engine already models this physics
#   guarded        representable only with measured radiative evidence
#   new_adapter    needs a model this build does not have
#   access_only    a real benefit that is not a UTCI or heat-load reduction
#   out_of_scope   outside a street-level pedestrian model
MECHANISMS: dict[str, dict] = {
    "solar_block": {
        "status": "simulate_now",
        "summary": "Blocks direct beam over the footway, like a sail, awning "
                   "or arcade.",
        "requires": ["solar_block_fraction", "shaded_length_m", "cost_usd"],
        "note": "Modelled exactly as a street tree is: it removes a measured "
                "fraction of the direct beam over a measured length.",
    },
    "wait_or_rest": {
        "status": "simulate_now",
        "summary": "Covers stationary time at a stop or rest point.",
        "requires": ["solar_block_fraction", "cost_usd"],
        "note": "Protects waiting exposure only. It does not cool the street "
                "a walker passes along.",
    },
    "tmrt_modifier": {
        "status": "guarded",
        "summary": "Changes surface radiative behaviour, like cool pavement.",
        "requires": ["tmrt_delta_c_by_hour", "cost_usd"],
        "note": "Phoenix measured lower pavement surface temperature but "
                "HIGHER midday mean radiant temperature over the treatment. A "
                "generic 'cool pavement = lower pedestrian UTCI' factor is "
                "therefore refused; hourly measured Tmrt is required.",
    },
    "microclimate_node": {
        "status": "new_adapter",
        "summary": "Changes local air temperature and humidity, like a "
                   "misting rest node.",
        "requires": ["air_temp_delta_c", "rh_delta_pct", "radius_m",
                     "operating_hours", "dwell_minutes", "cost_usd",
                     "water_opex_usd"],
        "note": "This engine holds humidity and wind constant by design, so "
                "a misting node needs an adapter that does not exist in 2.6. "
                "It is reported, not faked.",
    },
    "access_only": {
        "status": "access_only",
        "summary": "Improves access or refuge, like a hydration station.",
        "requires": ["service_radius_m", "cost_usd"],
        "note": "A real benefit, but not a thermal one: it is reported as "
                "population within the service radius and never as avoided "
                "severe minutes.",
    },
}

# The evidence quality a draft claims about its own numbers.
SOURCE_STATUS = ("sourced", "user_assumption", "unsupported")


@dataclass
class Verdict:
    """The gate's answer. `can_simulate` is the only thing that unlocks money."""
    can_simulate: bool
    status: str
    reasons: list[str]
    missing: list[str]
    questions: list[str]
    mechanism_note: str


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None      # reject NaN


def validate(draft: dict) -> Verdict:
    """Check one typed draft against the mechanism gate.

    Returns the reasons and the exact missing fields, so the chat can ask a
    person for them instead of a model inventing them.
    """
    reasons: list[str] = []
    missing: list[str] = []
    questions: list[str] = []

    name = str(draft.get("name") or "").strip()
    if not name:
        missing.append("name")

    mech = str(draft.get("mechanism") or "")
    spec = MECHANISMS.get(mech)
    if spec is None:
        return Verdict(False, "unknown_mechanism",
                       [f"'{mech or 'none'}' is not a mechanism this engine "
                        f"models. Supported: {', '.join(MECHANISMS)}."],
                       ["mechanism"],
                       ["Which physical mechanism does this use - blocking "
                        "sun, covering a wait, changing surface radiation, "
                        "changing local air, or improving access?"],
                       "")

    effects = {str(e.get("parameter")): e for e in (draft.get("effect") or [])}
    for field in spec["requires"]:
        if field == "cost_usd":
            cost = _num((draft.get("unitCost") or {}).get("capexUsd"))
            if cost is None or cost <= 0:
                missing.append("unitCost.capexUsd")
                questions.append("What does one unit cost to install, and does "
                                 "that figure include plumbing and O&M?")
            continue
        if field not in effects or _num(effects[field].get("value")) is None:
            missing.append(f"effect.{field}")

    # Every claimed number has to say where it came from. An unsupported claim
    # is never silently promoted to a modelling parameter.
    for key, e in effects.items():
        st = str(e.get("sourceStatus") or "")
        if st not in SOURCE_STATUS:
            missing.append(f"effect.{key}.sourceStatus")
        elif st == "unsupported":
            reasons.append(f"'{key}' is marked unsupported, so it cannot be "
                           f"used as a modelling parameter.")

    frac = _num((effects.get("solar_block_fraction") or {}).get("value"))
    if frac is not None and not 0 < frac <= 1:
        reasons.append("solar_block_fraction must sit in (0, 1]; "
                       f"{frac} is not a fraction of the direct beam.")

    if spec["status"] == "guarded":
        reasons.append(spec["note"])
        questions.append("Do you have measured mean radiant temperature by "
                         "hour over the treated surface? Surface temperature "
                         "alone is not enough.")
    elif spec["status"] == "new_adapter":
        reasons.append(spec["note"])
    elif spec["status"] == "access_only":
        reasons.append(spec["note"])

    if missing:
        reasons.append("Missing required evidence: " + ", ".join(missing) + ".")
        questions.extend(
            f"What value, unit and source should '{f}' take?" for f in missing[:3])

    can = (spec["status"] == "simulate_now" and not missing
           and not any(str(e.get("sourceStatus")) == "unsupported"
                       for e in effects.values())
           and (frac is None or 0 < frac <= 1))

    status = "can_simulate" if can else (
        "cannot_simulate" if spec["status"] == "simulate_now"
        else spec["status"])
    if can:
        reasons.append(spec["note"])
    return Verdict(can, status, reasons, missing, questions[:3], spec["note"])


def to_intervention(draft: dict) -> dict:
    """Translate a gate-cleared, user-confirmed draft into an engine spec.

    Only ever called after `validate(...).can_simulate` and after a person has
    confirmed the numbers. Free-form model text never reaches this function -
    every value here was a typed, sourced field in the draft.
    """
    v = validate(draft)
    if not v.can_simulate:
        raise ValueError("; ".join(v.reasons) or "draft did not clear the gate")

    effects = {str(e["parameter"]): e for e in draft["effect"]}
    block = float(effects["solar_block_fraction"]["value"])
    cost = float(draft["unitCost"]["capexUsd"])
    mech = str(draft["mechanism"])

    spec: dict = {
        "key": "custom_" + "".join(
            c if c.isalnum() else "_" for c in str(draft["name"]).lower())[:40],
        "label": str(draft["name"])[:60],
        "cost_usd": cost,
        "block": block,
        "custom": True,
        "mechanism": mech,
    }
    if mech == "wait_or_rest":
        # Covers stationary time at a validated stop, exactly as a shelter
        # does, and is limited to the same real sites.
        spec["shade_m"] = 4.0
        spec["protects"] = "waiting"
        spec["site_constrained"] = True
    else:
        spec["shade_m"] = float(effects["shaded_length_m"]["value"])
    return spec


def catalogue() -> list[dict]:
    """What a person can propose, and what each route will be asked for."""
    return [{"mechanism": k, **v} for k, v in MECHANISMS.items()]
