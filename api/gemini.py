"""The Gemini adapter for Add New Solution (Beta).

Responsibility boundary, restated where it is enforced: Gemini may search for
grounded evidence, translate it into a typed draft, and ask for the fields it
could not find. It may not choose coordinates, compute an effect on UTCI, or
decide what gets built. Everything it returns is a *proposal* that the
deterministic gate in solutions.py then accepts or refuses.

Two calls, deliberately. Google Search grounding and a strict response schema
cannot be combined in one request, so research runs first with grounding on,
and a second, ungrounded call structures that research into the typed draft.
That also means every number in the draft can be traced to the retrieved text
in the same exchange.

Stdlib HTTP on purpose: this must not add a dependency that could fail to
install on a demo machine, and if the network or the key is absent the caller
falls back to the two deterministic built-ins.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

ENDPOINT = ("https://generativelanguage.googleapis.com/v1beta/models/"
            "{model}:generateContent")
DEFAULT_MODEL = "gemini-2.5-flash"
TIMEOUT_S = 20

DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "geometry": {"type": "string", "enum": ["point", "linear", "area"]},
        "mechanism": {
            "type": "string",
            "enum": ["solar_block", "tmrt_modifier", "microclimate_node",
                     "wait_or_rest", "access_only"],
        },
        "eligibleSite": {"type": "string"},
        "unitCost": {
            "type": "object",
            "properties": {
                "capexUsd": {"type": "number"},
                "annualOpexUsd": {"type": "number"},
                "sourceStatus": {
                    "type": "string",
                    "enum": ["sourced", "user_assumption", "unsupported"]},
            },
            "required": ["capexUsd", "sourceStatus"],
        },
        "effect": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "parameter": {"type": "string"},
                    "value": {"type": "number"},
                    "unit": {"type": "string"},
                    "sourceStatus": {
                        "type": "string",
                        "enum": ["sourced", "user_assumption", "unsupported"]},
                },
                "required": ["parameter", "value", "unit", "sourceStatus"],
            },
        },
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "openQuestions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "geometry", "mechanism", "unitCost", "effect",
                 "confidence"],
}

RESEARCH_PROMPT = """You are researching a proposed pedestrian heat-mitigation \
measure for a street-level thermal model of Oakland, Pittsburgh.

Proposal: {text}

Find published evidence for:
  - what the measure physically does to a pedestrian's thermal environment
  - typical installed capital cost per unit, and annual operating cost
  - any measured effect size, with its units
  - where it can physically be sited

Report only what you find, with the figure and its source. If a number is not \
published, say so explicitly rather than estimating it. Do not predict any \
health outcome. Do not state a UTCI or heat-load reduction unless a source \
measured one."""

STRUCTURE_PROMPT = """Convert the research below into one SolutionDraft object.

Rules you must follow:
  - Every numeric value carries sourceStatus: "sourced" only if the research \
text gives that figure with a source; "user_assumption" if it is a plausible \
planning figure the user must confirm; "unsupported" if no basis exists.
  - Never invent a value to fill a field. Leave it out and add an entry to \
openQuestions instead.
  - mechanism must describe the PHYSICS, not the product:
      solar_block       blocks direct beam over the footway (sail, awning, arcade)
      wait_or_rest      covers stationary time at a stop or rest point
      tmrt_modifier     changes surface radiative behaviour (cool pavement)
      microclimate_node changes local air temperature or humidity (misting)
      access_only       improves access or refuge only (hydration station)
  - For solar_block, include effect parameters "solar_block_fraction" (0-1) \
and "shaded_length_m".

RESEARCH:
{research}"""


def configured() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY"))


def _call(body: dict) -> dict:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    model = os.environ.get("GEMINI_MODEL", DEFAULT_MODEL)
    req = urllib.request.Request(
        ENDPOINT.format(model=model) + f"?key={key}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.loads(r.read())


def _text(resp: dict) -> str:
    parts = (resp.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts)


def _sources(resp: dict) -> list[dict]:
    """Grounding citations, as returned - never a URL the model wrote inline."""
    meta = (resp.get("candidates") or [{}])[0].get("groundingMetadata") or {}
    out = []
    for chunk in meta.get("groundingChunks") or []:
        web = chunk.get("web") or {}
        if web.get("uri"):
            out.append({"url": web["uri"], "title": web.get("title") or web["uri"]})
    return out[:8]


def draft_solution(text: str) -> dict:
    """Research a proposal, then return a typed draft plus its citations."""
    research = _call({
        "contents": [{"role": "user",
                      "parts": [{"text": RESEARCH_PROMPT.format(text=text[:800])}]}],
        "tools": [{"google_search": {}}],
    })
    notes = _text(research)
    structured = _call({
        "contents": [{"role": "user",
                      "parts": [{"text": STRUCTURE_PROMPT.format(research=notes)}]}],
        "generationConfig": {"responseMimeType": "application/json",
                             "responseSchema": DRAFT_SCHEMA},
    })
    try:
        draft = json.loads(_text(structured))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Gemini did not return a valid draft: {exc}")
    return {"draft": draft, "research": notes, "sources": _sources(research)}
