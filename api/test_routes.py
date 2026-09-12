"""Every endpoint the frontend calls still exists.

This is here because of a real mistake. Refactoring main.py by replacing a
slice of text between two anchors deleted four /program/* endpoints along the
way: the file still imported, still parsed, still served the rest of the app,
and every Python property test passed. The only symptom was "Not Found" when
a person clicked Build the program.

No amount of unit testing the engine catches a route that stopped being
registered, so this asserts the surface itself, cheaply, with no server and
no network.
"""
from __future__ import annotations

import sys

from main import app

# Kept in step with the fetch calls in web/lib/*.ts.
EXPECTED = [
    ("GET", "/health"),
    ("GET", "/meta"),
    ("GET", "/geometry/segments"),
    ("GET", "/geometry/{layer}"),
    ("POST", "/crash-test"),
    ("POST", "/adapt"),
    # Add a solution (Beta)
    ("GET", "/solutions/mechanisms"),
    ("POST", "/solutions/chat"),
    ("POST", "/solutions/clarify"),
    ("POST", "/solutions/validate"),
    ("POST", "/solutions/simulate"),
    # State a goal - the stated-program path
    ("GET", "/program/vocabulary"),
    ("POST", "/program/compile"),
    ("POST", "/program/solve"),
]


def main() -> int:
    have = {(m, r.path) for r in app.routes
            for m in getattr(r, "methods", set()) or set()}
    width = max(len(p) for _, p in EXPECTED)
    missing = 0
    print("\nAPI SURFACE")
    print("-" * (width + 22))
    for method, path in EXPECTED:
        ok = (method, path) in have
        print(f"{'  ok ' if ok else 'FAIL '} {method:<5} {path:<{width}}")
        missing += not ok
    print("-" * (width + 22))
    print(f"{len(EXPECTED)-missing}/{len(EXPECTED)} routes registered")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
