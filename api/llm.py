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

TIMEOUT_S = 45

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

5. Never predict a health outcome. Never state a UTCI or heat-load reduction \
unless a study measured one - the engine computes those, not you."""

QUESTION_PROMPT = """The proposal below could not be simulated. Write at most \
three short, specific questions that would let a planner supply the missing \
evidence. Ask for values, units and sources - never for opinions. One \
question per line, no numbering, no preamble.

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


def _chat(messages: list[dict], json_mode: bool = False) -> str:
    base = (os.environ.get("IFM_BASE_URL") or "").rstrip("/")
    key = os.environ.get("IFM_API_KEY")
    model = os.environ.get("IFM_MODEL")
    if not (base and key and model):
        raise RuntimeError("IFM_BASE_URL, IFM_API_KEY and IFM_MODEL must be set")

    body: dict = {"model": model, "messages": messages, "temperature": 0.2}
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
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        resp = json.loads(r.read())
    return (resp.get("choices") or [{}])[0].get("message", {}).get("content", "")


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
    raw = _chat([{"role": "system", "content": SYSTEM},
                 {"role": "user", "content": text[:800]}], json_mode=True)
    draft, downgraded = normalise(_json_object(raw))
    return {"draft": draft, "downgraded": downgraded, "raw": raw[:4000]}


def clarify(text: str, missing: list[str], why: str) -> list[str]:
    """Ask for the evidence the gate found missing. Optional, and best-effort."""
    try:
        out = _chat([{"role": "user", "content": QUESTION_PROMPT.format(
            text=text[:400], missing=", ".join(missing) or "none",
            why=why[:400])}])
    except Exception:
        return []
    lines = [ln.strip(" -•\t") for ln in out.splitlines() if ln.strip()]
    return lines[:3]
