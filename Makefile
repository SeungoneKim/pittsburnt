PY := .venv/bin/python

.PHONY: help step1 verify inspect clean-cache
help:
	@echo "make step1    - build Oakland walk graph -> segments"
	@echo "make verify   - assert every cached artifact is self-consistent"
	@echo "make inspect  - regenerate + open the visual QA map"
	@echo "make clean-cache - drop derived artifacts (keeps downloaded graphs)"

step1:      ; $(PY) pipeline/step01_graph.py
verify:     ; @$(PY) pipeline/verify.py
inspect:    ; @$(PY) pipeline/inspect_map.py && open data/cache/inspect.html
clean-cache:; rm -f data/cache/segments.geojson data/cache/edge_segments.json data/cache/inspect.html

step2:      ; $(PY) pipeline/step02_buildings.py --candidates
step3:      ; $(PY) pipeline/step03_shadows.py
step4:      ; $(PY) pipeline/step04_trees.py
step5:      ; $(PY) pipeline/step05_trips.py

# The before/after comparison is only meaningful if the same seed reproduces
# the same people; this proves it rather than asserting it.
check-determinism:
	@$(PY) -c "import numpy,hashlib;print('before:',hashlib.sha256(numpy.load('data/cache/minutes.npz',allow_pickle=True)['minutes'].tobytes()).hexdigest()[:16])"
	@$(PY) pipeline/step05_trips.py > /dev/null
	@$(PY) -c "import numpy,hashlib;print(' after:',hashlib.sha256(numpy.load('data/cache/minutes.npz',allow_pickle=True)['minutes'].tobytes()).hexdigest()[:16])"
step6:      ; $(PY) pipeline/step06_scenarios.py
export PYTHONPATH := pipeline:api

api:        ; $(PY) -m uvicorn main:app --app-dir api --reload --port 8000
test-engine:; @$(PY) api/test_engine.py
step8:      ; $(PY) pipeline/step08_export_web.py
step7:      ; $(PY) pipeline/step07_transit.py
