"""The language-model adapter for Add New Solution (Beta).

Responsibility boundary, restated where it is enforced: the model may draft
and question. It may not choose coordinates, compute an effect on UTCI, or
decide what gets built. Everything it returns is a *proposal* that the
deterministic gate in solutions.py then accepts or refuses.

Provider: any OpenAI-compatible chat endpoint. Configured with IFM_BASE_URL,
IFM_API_KEY and IFM_MODEL.

Stdlib HTTP on purpose. The `openai` package would work and speaks exactly
this wire format, but a demo machine that cannot `pip install` must still be
able to run this, and an adapter this small does not earn a dependency.

ONE THING TO KNOW ABOUT GROUNDING
---------------------------------
This endpoint has no retrieval tool, so the model answers from its weights
alone. It can therefore *believe* a cost figure but cannot show you where it
came from. The spec's truth rule says a number may only be called sourced if
a source was actually retrieved, so `normalise()` below downgrades every
"sourced" claim to "user_assumption" whenever the provider is ungrounded -
server-side, not by asking the prompt nicely. A person confirming the draft
is then confirming a model-suggested planning figure, which is what it is.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request

# Two budgets, because the two calls have different stakes. The draft is the
# feature and is worth waiting for; the follow-up questions are a nicety that
# already has a deterministic fallback, so they get a short leash.
# Drafting a measure is the longest single call: the system prompt carries the
# whole mechanism vocabulary, and a reasoning model spends real time on the
# sign of a Tmrt change. Measured at 45-90 s, so the budget is 120.
TIMEOUT_S = 120
CLARIFY_TIMEOUT_S = 25

# This provider is a reasoning model, and that shapes both calls below.
#
# Asking for JSON is what makes it fast: the same prompt as free-form text
# spent 4,494 completion tokens thinking and took 42 s, against 628 tokens
# and 6.8 s with response_format json_object. So every call asks for JSON.
#
# Do NOT send max_tokens. The cap is charged against reasoning tokens, so the
# model spends the entire budget thinking and returns EMPTY content with
# finish_reason "length" - measured identically at 900, 1,600 and 2,500. An
# unbounded request finishes on its own in 628.

# Whether the configured provider can retrieve and cite live sources. No
# OpenAI-compatible chat completion does this without a tool, so it is False
# and the honesty downgrade below is always applied.
GROUNDED = False

DRAFT_KEYS = ("name", "geometry", "mechanism", "eligibleSite", "unitCost",
              "effect", "confidence", "openQuestions")

SYSTEM = """You draft pedestrian heat-mitigation measures for a street-level \
thermal model of Oakland, Pittsburgh. You do not decide anything. A \
deterministic engine prices, sites and simulates; a person confirms every \
number before it is used.

Return ONE JSON object and nothing else. No prose, no code fence.

{
  "name": string,
  "geometry": "point" | "linear" | "area",
  "mechanism": "solar_block" | "wait_or_rest" | "tmrt_modifier"
             | "microclimate_node" | "access_only",
  "eligibleSite": string,
  "unitCost": { "capexUsd": number, "annualOpexUsd": number,
                "sourceStatus": "sourced"|"user_assumption"|"unsupported" },
  "effect": [ { "parameter": string, "value": number, "unit": string,
                "sourceStatus": "sourced"|"user_assumption"|"unsupported" } ],
  "confidence": "high" | "medium" | "low",
  "openQuestions": [string]
}

Rules you must follow.

1. `mechanism` describes the PHYSICS, not the product:
     solar_block        blocks direct beam over the footway (sail, awning, arcade)
     wait_or_rest       covers stationary time at a stop or rest point
     tmrt_modifier      changes surface radiative behaviour (cool pavement)
     microclimate_node  changes local air temperature or humidity (misting)
     access_only        improves access or refuge only (hydration station)

2. NEVER invent a value to fill a field. If you do not know it, leave the \
field out and add a specific question to `openQuestions` instead. An absent \
field is correct; a guessed one is not.

3. `sourceStatus` is "sourced" only if you can name the specific published \
document the figure comes from, "user_assumption" for a plausible planning \
figure a person must confirm, and "unsupported" when no basis exists.

4. For solar_block, include effect parameters "solar_block_fraction" (0-1, a \
fraction of the direct beam) and "shaded_length_m".

4b. For tmrt_modifier, include "tmrt_delta_c" - the measured change in MEAN \
RADIANT TEMPERATURE a pedestrian standing over the treated surface receives, \
in degrees C - and "treated_length_m". Mind the SIGN. A reflective surface \
lowers the temperature of the ground and RAISES the shortwave a person \
receives, so measured midday Tmrt over reflective pavement is HIGHER, a \
positive delta, even though surface temperature falls. Never report a \
surface-temperature change as if it were a Tmrt change.

5. Never predict a health outcome. Never state a UTCI or heat-load reduction \
unless a study measured one - the engine computes those, not you."""

QUESTION_PROMPT = """The proposal below could not be simulated. Write at most \
three short, specific questions that would let a planner supply the missing \
evidence. Ask for values, units and sources - never for opinions.

Return ONE JSON object and nothing else: {{"questions": [string, ...]}}

Proposal: {text}
Missing: {missing}
Why: {why}"""


def configured() -> bool:
    return bool(os.environ.get("IFM_API_KEY") and os.environ.get("IFM_BASE_URL"))


def provider() -> dict:
    """What is configured, for display. Never includes the key itself."""
    return {
        "configured": configured(),
        "base_url": os.environ.get("IFM_BASE_URL", ""),
        "model": os.environ.get("IFM_MODEL", ""),
        "grounded": GROUNDED,
    }


def _chat(messages: list[dict], json_mode: bool = False,
          timeout: float = TIMEOUT_S, temperature: float = 0.2) -> str:
    base = (os.environ.get("IFM_BASE_URL") or "").rstrip("/")
    key = os.environ.get("IFM_API_KEY")
    model = os.environ.get("IFM_MODEL")
    if not (base and key and model):
        raise RuntimeError("IFM_BASE_URL, IFM_API_KEY and IFM_MODEL must be set")

    body: dict = {"model": model, "messages": messages,
                  "temperature": temperature}
    if json_mode:
        # Honoured by most OpenAI-compatible servers; harmless where it is
        # not, because _json_object below also copes with a fenced reply.
        body["response_format"] = {"type": "json_object"}

    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json",
                 "authorization": f"Bearer {key}"},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read())
    return (resp.get("choices") or [{}])[0].get("message", {}).get("content", "")


def _json_chat(messages: list[dict], timeout: float = TIMEOUT_S,
               temperature: float = 0.0) -> dict:
    """A JSON call that survives one empty reply.

    This provider occasionally returns a 200 with empty content - seen while
    investigating max_tokens, and again at temperature 0 - and a demo should
    not fail on a flake that a second attempt fixes. Two tries, then the
    caller's own fallback takes over.
    """
    last: Exception | None = None
    for _ in range(2):
        try:
            return _json_object(_chat(messages, json_mode=True,
                                      timeout=timeout,
                                      temperature=temperature))
        except (RuntimeError, json.JSONDecodeError) as exc:
            last = exc
    raise RuntimeError(f"the model returned nothing usable twice: {last}")


def _json_object(text: str) -> dict:
    """Parse the reply as one JSON object, tolerating a code fence.

    Not a guess: it takes the outermost braced span, so a model that wraps
    its object in ```json or adds a sentence still parses, and anything that
    genuinely is not an object raises instead of returning half a draft.
    """
    t = re.sub(r"^\s*```(?:json)?|```\s*$", "", text.strip(), flags=re.MULTILINE)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("the model did not return a JSON object")
    obj = json.loads(t[start:end + 1])
    if not isinstance(obj, dict):
        raise RuntimeError("the model returned JSON, but not an object")
    return obj


def normalise(draft: dict) -> tuple[dict, list[str]]:
    """Strip anything the model is not allowed to assert, and say what changed.

    Two jobs. It drops keys that are not part of the draft contract, so a
    model cannot smuggle in a field the gate does not inspect. And when the
    provider cannot retrieve sources, it downgrades every "sourced" claim to
    "user_assumption" - a number the model recalled is a suggestion, not a
    citation, and the difference is the whole point of the badge.
    """
    out = {k: draft[k] for k in DRAFT_KEYS if k in draft}
    notes: list[str] = []

    def fix(holder: dict, label: str) -> None:
        if not isinstance(holder, dict):
            return
        if holder.get("sourceStatus") == "sourced" and not GROUNDED:
            holder["sourceStatus"] = "user_assumption"
            notes.append(label)

    fix(out.get("unitCost") or {}, "unit cost")
    effects = out.get("effect")
    if isinstance(effects, list):
        for e in effects:
            fix(e, str((e or {}).get("parameter", "an effect")))
    else:
        out["effect"] = []
    return out, notes


def draft_solution(text: str) -> dict:
    """Turn a described measure into a typed, normalised draft."""
    # Temperature 0 here too. At 0.2 the same proposal drafted differently
    # between calls - one reply carried a unit cost and the next did not, so
    # the gate refused a measure it had just accepted. A demo cannot have
    # that, and neither can a cache.
    obj = _json_chat([{"role": "system", "content": SYSTEM},
                      {"role": "user", "content": text[:800]}])
    draft, downgraded = normalise(obj)
    return {"draft": draft, "downgraded": downgraded}


def clarify(text: str, missing: list[str], why: str) -> list[str]:
    """Ask for the evidence the gate found missing.

    Strictly optional, and deliberately on its own endpoint: the gate already
    writes usable questions, so anything going wrong here - a timeout, a
    refusal, a malformed reply - returns empty and the caller keeps the
    deterministic ones. It must never be able to make the panel slow or
    broken, which is exactly what it did when it shared the draft request.
    """
    try:
        out = _chat([{"role": "user", "content": QUESTION_PROMPT.format(
            text=text[:400], missing=", ".join(missing) or "none",
            why=why[:400])}], json_mode=True, timeout=CLARIFY_TIMEOUT_S)
        qs = _json_object(out).get("questions")
    except Exception:
        return []
    if not isinstance(qs, list):
        return []
    # Observed on this provider: it sometimes double-encodes, handing back the
    # whole object again as the single question. Unwrap one level rather than
    # showing a planner a JSON blob.
    if len(qs) == 1 and isinstance(qs[0], str) and '"questions"' in qs[0]:
        try:
            inner = _json_object(qs[0]).get("questions")
            if isinstance(inner, list):
                qs = inner
        except Exception:
            pass
    return [q.strip() for q in qs if isinstance(q, str) and q.strip()][:3]


# --- compiling a stated program -------------------------------------------
#
# The second thing the model is allowed to do, and the more useful one. It
# does not choose where a tree goes, what it costs or what it achieves - it
# turns a sentence into a formal program that a MILP then solves exactly.
# Every field it emits is checked against the engine's real vocabulary, and a
# program that names a street the model invented is refused rather than
# quietly dropped.

PROGRAM_SYSTEM = """You translate a planner's sentence into ONE optimisation \
program for a pedestrian heat model of Oakland, Pittsburgh. You never solve \
it, never choose locations, and never estimate any effect. A solver does that.

Return ONE JSON object and nothing else. No prose, no code fence.

{
  "objective": one of OBJECTIVES,
  "budget_usd": number,
  "cells": [ { "scenario": ..., "hour": ..., "persona": ..., "weight": 1.0 } ],
  "constraints": [ ... ],
  "restated": "one plain sentence describing the program you built",
  "unsupported": [ "any part of the request this vocabulary cannot express" ]
}

CONSTRAINT VOCABULARY - use only these six:

  {"type":"focus","scope":{"corridor":NAME},"weight":N}
      A PREFERENCE. Weights benefit on that corridor N times higher in the
      objective. Use for "protect X on Y", "prioritise Y", "focus on Y".
      Default weight 3.

  {"type":"corridor_floor","min_units":N}
      EVERY corridor carrying walking demand must receive at least N units.
      Use for "don't let any corridor get nothing", "spread it around",
      "nowhere left out". Default min_units 1.

  {"type":"corridor_floor","min_units":N,"scope":[NAME, NAME, ...]}
      The SAME constraint restricted to named corridors. Use this whenever
      the planner names the streets that must not be left out - "guarantee
      at least one intervention on Fifth Avenue and Craig Street" is
      {"type":"corridor_floor","min_units":1,
       "scope":["Fifth Avenue","South Craig Street"]}.

  {"type":"spend_cap","scope":{"corridor":NAME},"max_fraction":F}
      At most fraction F of the budget inside that scope. Use for "cap Y at
      half the budget" (F=0.5), "no more than a quarter on Y" (F=0.25).

  {"type":"spend_floor","scope":{"corridor":NAME},"min_fraction":F}
      At least fraction F of the budget inside that scope.

  {"type":"kind_floor","kind":K,"min_units":N}
      At least N units of intervention type K, where K is "tree" or
      "shaded_shelter". Use for "use both trees and shelters", "make sure
      some shelters get built", "include waiting shelters". Pure efficiency
      buys zero shelters at 3 PM, so this is the ONLY way to require them.
      "use both X and Y" means TWO kind_floor constraints, one per type.

  {"type":"kind_cap","kind":K,"max_units":N}
      At most N units of type K.

RULES

1. Every "corridor" value MUST be one of the CORRIDORS listed below, copied
   character for character. You MAY resolve an unambiguous short form: if
   the planner writes a name that matches exactly ONE list entry as a
   substring - "Fifth" matches "Fifth Avenue" - emit the FULL list entry.
   If you cannot decide, still emit the constraint using the planner's own
   wording: the engine resolves short names itself, and refuses ambiguous
   ones by naming the candidates. Do NOT drop a constraint just because a
   street name looks unfamiliar, and do NOT guess between two streets.
2. "persona", "hour" and "scenario" MUST come from the lists below. If the
   sentence does not state one, use the CURRENTLY SELECTED value.
3. If the sentence asks for something this vocabulary cannot express - a
   deadline, a species, a material, a health outcome, a claim about what is
   "measurable" - do NOT approximate it. Leave it out and list it in
   "unsupported". Before doing so, check the vocabulary again: counts of an
   intervention type, and floors on named corridors, ARE expressible.
4. Prefer "min_heat_load". Use "min_severe" only if the planner explicitly
   asks about the severe or 38 C threshold.
5. "protect <group> on <street>" means BOTH: set the persona to that group,
   AND add a focus constraint on that street."""


def compile_program(text: str, vocabulary: dict) -> dict:
    """Turn a sentence into a typed optimisation program.

    `vocabulary` carries the engine's real options - corridors, personas,
    hours, scenarios and the defaults from the current selection - so this
    function never has to know anything about the model itself.
    """
    ctx = (
        f"OBJECTIVES: {', '.join(vocabulary['objectives'])}\n"
        f"PERSONAS: {', '.join(vocabulary['personas'])}\n"
        f"HOURS: {', '.join(str(h) for h in vocabulary['hours'])}\n"
        f"SCENARIOS: {', '.join(vocabulary['scenarios'])}\n"
        f"CURRENTLY SELECTED (use these when the sentence does not say, and "
        f"do not call them 'default' when you restate the program): "
        f"scenario={vocabulary['default_scenario']} "
        f"hour={vocabulary['default_hour']} "
        f"persona={vocabulary['default_persona']} "
        f"budget_usd={vocabulary['default_budget']}\n"
        f"CORRIDORS (exact names, copy verbatim):\n"
        + "\n".join(f"  {c}" for c in vocabulary["corridors"])
    )
    # Temperature 0: the same sentence must compile to the same program every
    # time. At 0.2 one run resolved "Craig Street" to South and the next
    # declined it as ambiguous, which is not something to discover on stage.
    return _json_chat([{"role": "system", "content": PROGRAM_SYSTEM},
                       {"role": "user",
                        "content": f"{ctx}\n\nSENTENCE: {text[:600]}"}])


REPAIR_PROMPT = """The program you produced was refused by the engine. Fix \
exactly these problems and return the corrected JSON object, nothing else.

PROBLEMS:
{reasons}

YOUR PROGRAM:
{program}"""


def repair_program(spec: dict, reasons: list[str], vocabulary: dict) -> dict:
    """One repair attempt against the gate's own complaints.

    The gate decides what is wrong; the model only rewrites. If this fails
    the caller shows the refusal, which is a perfectly good outcome - a
    refused program with named reasons beats a program that silently ran
    against something the planner did not ask for.
    """
    ctx = ("CORRIDORS (exact names): "
           + ", ".join(vocabulary["corridors"][:60]))
    raw = _chat([{"role": "system", "content": PROGRAM_SYSTEM},
                 {"role": "user", "content": ctx + "\n\n" + REPAIR_PROMPT.format(
                     reasons="\n".join(f"  - {r}" for r in reasons),
                     program=json.dumps(spec)[:2000])}], json_mode=True)
    return _json_object(raw)
