PY := .venv/bin/python
export PYTHONPATH := pipeline:api

# Every target here is a command, not a file. Without this, `make api` is a
# no-op because a directory named api/ exists and make considers the target
# already satisfied.
.PHONY: help api web run \
        step1 step2 step3 step4 step5 step6 step7 step7b step8 pipeline \
        verify test-engine check-determinism inspect check clean-cache

help:
	@echo "Run the demo"
	@echo "  make api               - FastAPI engine on :8000"
	@echo "  make web               - Next.js frontend on :3000"
	@echo ""
	@echo "Check the work"
	@echo "  make check             - verify + test-engine together"
	@echo "  make verify            - assert every cached artifact is consistent"
	@echo "  make test-engine       - engine property tests"
	@echo "  make check-determinism - same seed reproduces the same trips"
	@echo "  make inspect           - visual QA map of the pipeline geometry"
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
check: verify test-engine
verify:      ; @$(PY) pipeline/verify.py
test-engine: ; @$(PY) api/test_engine.py
inspect:     ; @$(PY) pipeline/inspect_map.py && open data/cache/inspect.html

# The before/after comparison is only meaningful if the same seed reproduces
# the same people; this proves it rather than asserting it.
check-determinism:
	@$(PY) -c "import numpy,hashlib;print('before:',hashlib.sha256(numpy.load('data/cache/minutes.npz',allow_pickle=True)['minutes'].tobytes()).hexdigest()[:16])"
	@$(PY) pipeline/step05_trips.py > /dev/null
	@$(PY) -c "import numpy,hashlib;print(' after:',hashlib.sha256(numpy.load('data/cache/minutes.npz',allow_pickle=True)['minutes'].tobytes()).hexdigest()[:16])"

clean-cache:
	rm -f data/cache/segments.geojson data/cache/edge_segments.json data/cache/inspect.html
