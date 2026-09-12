PY := .venv/bin/python
export PYTHONPATH := pipeline

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
