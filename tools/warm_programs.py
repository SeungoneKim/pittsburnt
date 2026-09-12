"""Compile the shipped example sentences once, so a demo never needs the network.

Compiling is the only slow, networked step in the app - 8-25 s against a
reasoning model. It is also deterministic at temperature 0, so a compiled
program can be stored and replayed rather than recomputed. Running this once
before a demo means the "State a goal" panel works with the wifi unplugged,
exactly like the crash-test and adapt paths already do.

    set -a; . ./.env; set +a
    .venv/bin/python tools/warm_programs.py

It refuses to store a program that does not survive every check, so an
ambiguous sentence stays ambiguous rather than being frozen into a wrong
answer.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8000"

# Kept in step with EXAMPLES in web/components/ProgramPanel.tsx.
SENTENCES = [
    "Protect older adults on Forbes, don't let any corridor get nothing, "
    "cap Forbes at half the budget",
    "Use a $250,000 budget to protect older adults. Prioritize Forbes Avenue, "
    "guarantee at least one intervention on Fifth Avenue and South Craig "
    "Street, cap spending on Forbes at 50% of the total budget, and use both "
    "trees and shaded waiting shelters where they produce measurable impact.",
    "Spread the money so nowhere gets left out",
    "Prioritise students at noon and spend at least a third on Fifth Avenue",
]


def compile_one(text: str, recompile: bool) -> dict:
    body = json.dumps({"text": text, "recompile": recompile}).encode()
    req = urllib.request.Request(f"{API}/program/compile", data=body,
                                 headers={"content-type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def main() -> int:
    recompile = "--force" in sys.argv
    print(f"warming {len(SENTENCES)} example programs"
          f"{' (forcing a fresh compile)' if recompile else ''}\n")
    failures = 0
    for n, text in enumerate(SENTENCES, 1):
        started = time.time()
        try:
            out = compile_one(text, recompile)
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"{n}. FAILED  {text[:56]}...\n   {exc}")
            failures += 1
            continue
        took = time.time() - started
        v = out["verdict"]
        kinds = [c.get("type") for c in out["spec"].get("constraints") or []]
        mark = "ok  " if v["ok"] else "REFUSED"
        print(f"{n}. {mark} [{out['source']:5}] {took:5.1f}s  {text[:52]}...")
        print(f"   {len(kinds)} constraints: {', '.join(kinds) or 'none'}")
        for r in v["reasons"]:
            print(f"   ! {r[:100]}")
        failures += not v["ok"]
    print(f"\n{len(SENTENCES) - failures}/{len(SENTENCES)} stored and replayable")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
