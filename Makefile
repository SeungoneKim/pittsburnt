PY := .venv/bin/python
export PYTHONPATH := pipeline:api

# Every target here is a command, not a file. Without this, `make api` is a
# no-op because a directory named api/ exists and make considers the target
# already satisfied.
.PHONY: help api web run \
        step1 step2 step3 step4 step5 step6 step7 step7b step8 pipeline \
        verify test-engine test-program test-routes check-determinism inspect check \
        clean-cache gates gates-live gates-program

help:
	@echo "Run the demo"
	@echo "  make api               - FastAPI engine on :8000"
	@echo "  make web               - Next.js frontend on :3000"
	@echo ""
	@echo "Check the work"
	@echo "  make check             - verify + test-engine together"
	@echo "  make verify            - assert every cached artifact is consistent"
	@echo "  make test-engine       - engine property tests"
	@echo "  make test-program      - MILP / stated-program property tests"
	@echo "  make test-routes       - every endpoint the frontend calls is registered"
	@echo "  make check-determinism - same seed reproduces the same trips"
	@echo "  make inspect           - visual QA map of the pipeline geometry"
	@echo "  make gates             - browser release gates (needs api + web up)"
	@echo "  make gates-ui          - the 2.7 UI checklist at 1366x768 and 1920x1080"
	@echo "  make gates-live        - Beta panel against the real model (needs a key)"
	@echo "  make gates-program     - the demo sentence, compiled and solved (needs a key)"
	@echo "  make warm-programs     - compile the example sentences once, so a demo needs no network"
	@echo ""
	@echo "Rebuild the data (each step caches; run only what you need)"
	@echo "  make step1  walk graph -> corridor-labelled segments"
	@echo "  make step2  building footprints + tiered heights"
	@echo "  make step3  shadows at 8/12/15/18"
	@echo "  make step4  tree canopy -> sun exposure"
	@echo "  make step5  deterministic synthetic trips"
	@echo "  make step6  observed hot day + CMIP6-LOCA2 -> heat scenarios"
	@echo "  make step7  transit stops -> shelter sites"
	@echo "  make step7b waiting exposure at stops"
	@echo "  make step8  static fallback bundle for the web app"
	@echo "  make pipeline          - all of the above, in order"

# --- run ------------------------------------------------------------------
api:
	$(PY) -m uvicorn main:app --app-dir api --reload --port 8000

web:
	cd web && npm run dev

# --- pipeline -------------------------------------------------------------
step1:  ; $(PY) pipeline/step01_graph.py
step2:  ; $(PY) pipeline/step02_buildings.py --candidates
step3:  ; $(PY) pipeline/step03_shadows.py
step4:  ; $(PY) pipeline/step04_trees.py
step5:  ; $(PY) pipeline/step05_trips.py
step6:  ; $(PY) pipeline/step06_scenarios.py
step7:  ; $(PY) pipeline/step07_transit.py
step7b: ; $(PY) pipeline/step07b_waiting.py
step8:  ; $(PY) pipeline/step08_export_web.py
pipeline: step1 step2 step3 step4 step5 step6 step7 step7b step8

# --- checks ---------------------------------------------------------------
check: verify test-engine test-program test-routes
verify:      ; @$(PY) pipeline/verify.py
test-engine: ; @$(PY) api/test_engine.py
test-program: ; @$(PY) api/test_program.py
test-routes: ; @$(PY) api/test_routes.py
inspect:     ; @$(PY) pipeline/inspect_map.py && open data/cache/inspect.html

# The before/after comparison is only meaningful if the same seed reproduces
# the same people; this proves it rather than asserting it.
check-determinism:
	@$(PY) -c "import numpy,hashlib;print('before:',hashlib.sha256(numpy.load('data/cache/minutes.npz',allow_pickle=True)['minutes'].tobytes()).hexdigest()[:16])"
	@$(PY) pipeline/step05_trips.py > /dev/null
	@$(PY) -c "import numpy,hashlib;print(' after:',hashlib.sha256(numpy.load('data/cache/minutes.npz',allow_pickle=True)['minutes'].tobytes()).hexdigest()[:16])"

clean-cache:
	rm -f data/cache/segments.geojson data/cache/edge_segments.json data/cache/inspect.html

# Browser release gates. Needs `make api` and `make web` already running:
# they assert the six judge-facing moments, the reset contract and the
# responsive gate against a real render, which no unit test can do.
gates:
	node tests/release_gates.mjs
	node tests/ui_27_gates.mjs
	node tests/solution_lab_gate.mjs

# The 2.7 UI checklist on its own: empty start, people, motion, contrast,
# metric truth, panel collision and reset. No model or key needed.
gates-ui:
	node tests/ui_27_gates.mjs

# The Beta panel driven against a real configured model. Separate from
# `gates` on purpose: it needs a key and a network, and the core demo must
# stay verifiable without either.
gates-live:
	node tests/live_model_gate.mjs

# The demo sentence, driven through the real UI against the real model and
# HiGHS. Needs a key, so it is separate from `gates`.
gates-program:
	node tests/program_gate.mjs

# Compile the shipped example sentences once and store them. Compiling is the
# only slow, networked step in the app; after this the panel replays stored
# programs and works with the wifi unplugged. Needs the API running and a key.
warm-programs:
	$(PY) tools/warm_programs.py
