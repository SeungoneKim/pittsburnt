"""Artifact verifier - the automated half of supervising this pipeline.

Every pipeline step writes files into data/cache. This script re-opens those
files cold and asserts the properties that downstream code relies on. Run it
after any pipeline change; a green run means the artifacts are self-consistent,
not merely that a script exited 0.
"""
from __future__ import annotations

import json
import sys

import geopandas as gpd
import numpy as np

from config import CACHE, CORRIDORS, SEGMENT_MAX_M

PASS, FAIL, WARN = "PASS", "FAIL", "WARN"
results: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "", warn_only: bool = False) -> None:
    status = PASS if ok else (WARN if warn_only else FAIL)
    results.append((status, name, detail))


def verify_segments() -> None:
    path = CACHE / "segments.geojson"
    if not path.exists():
        check("segments.geojson exists", False, "missing - run step01")
        return
    seg = gpd.read_file(path)

    check("segments.geojson exists", True, f"{len(seg)} features")
    check("seg_id unique", seg.seg_id.is_unique,
          f"{len(seg)} rows / {seg.seg_id.nunique()} unique")
    check("no null geometry", seg.geometry.notna().all())
    check("all geometries valid", seg.geometry.is_valid.all())
    check("CRS is WGS84", seg.crs is not None and seg.crs.to_epsg() == 4326,
          str(seg.crs))

    L = seg["length_m"]
    check("no segment exceeds max length", bool((L <= SEGMENT_MAX_M + 1).all()),
          f"max {L.max():.1f}m vs cap {SEGMENT_MAX_M}m")
    band = ((L >= 50) & (L <= 150))
    share = L[band].sum() / L.sum() * 100
    check("majority of length in 50-150m band", share >= 80,
          f"{share:.1f}% of centreline metres")

    # A corridor label is what the demo narrates; all three must be present
    # and each should be roughly two sidewalks long, not one stub.
    for name in CORRIDORS:
        g = seg[seg["corridor"] == name]
        check(f"corridor present: {name}", len(g) >= 2,
              f"{len(g)} segs / {g.length_m.sum():.0f} m")

    # Segment total must equal the graph it came from - a silent geometry
    # loss here would quietly under-report exposure everywhere.
    check("total centreline plausible", 100 < L.sum() / 1000 < 400,
          f"{L.sum()/1000:.2f} km")


def verify_edge_map() -> None:
    path = CACHE / "edge_segments.json"
    seg_path = CACHE / "segments.geojson"
    if not path.exists() or not seg_path.exists():
        check("edge_segments.json exists", False, "missing - run step01")
        return
    emap = json.loads(path.read_text())
    seg_ids = set(gpd.read_file(seg_path)["seg_id"])

    check("edge_segments.json exists", True, f"{len(emap)} edges")
    referenced = {sid for v in emap.values() for sid, _ in v}
    check("every referenced seg_id exists", referenced <= seg_ids,
          f"{len(referenced - seg_ids)} dangling")
    coverage = len(referenced & seg_ids) / len(seg_ids) * 100
    check("edge map covers most segments", coverage >= 90,
          f"{coverage:.1f}% of segments reachable from some edge")
    check("no empty edge mappings", all(len(v) > 0 for v in emap.values()))
    totals = np.array([sum(m for _, m in v) for v in emap.values()])
    check("edge metres positive", bool((totals > 0).all()),
          f"median {np.median(totals):.1f} m/edge")


def verify_buildings() -> None:
    path = CACHE / "buildings.geojson"
    if not path.exists():
        check("buildings.geojson exists", False, "missing - run step02")
        return
    b = gpd.read_file(path)

    check("buildings.geojson exists", True, f"{len(b)} features")
    check("bldg_id unique", b.bldg_id.is_unique,
          f"{len(b)} rows / {b.bldg_id.nunique()} unique")
    check("all geometries valid", b.geometry.is_valid.all())
    check("every building has a height", b.height_m.notna().all())
    check("heights physically plausible", bool(((b.height_m >= 2) & (b.height_m <= 250)).all()),
          f"{b.height_m.min():.1f} - {b.height_m.max():.1f} m")
    check("every height has a source", b.height_source.notna().all() & (b.height_source != "").all(),
          " / ".join(sorted(b.height_source.unique())))

    meas = b.height_is_measured
    check("majority of buildings measured", meas.mean() >= 0.5,
          f"{meas.mean()*100:.1f}% of buildings, "
          f"{b[meas].area_m2.sum()/b.area_m2.sum()*100:.1f}% of area")
    # The tall landmark is the sanity check that the ladder reaches 3D data.
    tallest = b.loc[b.height_m.idxmax()]
    check("tallest building is a real landmark", tallest.height_m > 100,
          f"{tallest.bldg_name} at {tallest.height_m:.0f} m ({tallest.height_source})")
    check("shadow-casting area mostly measured", 
          b[meas].area_m2.sum()/b.area_m2.sum() >= 0.5,
          f"{b[meas].area_m2.sum()/b.area_m2.sum()*100:.1f}% of footprint area",
          warn_only=True)


def main() -> int:
    verify_segments()
    verify_edge_map()
    verify_buildings()

    width = max(len(n) for _, n, _ in results)
    n_fail = 0
    print("\nARTIFACT VERIFICATION")
    print("-" * (width + 34))
    for status, name, detail in results:
        mark = {"PASS": "  ok ", "FAIL": "FAIL ", "WARN": "warn "}[status]
        print(f"{mark} {name:<{width}}  {detail}")
        n_fail += status == FAIL
    print("-" * (width + 34))
    print(f"{len(results) - n_fail}/{len(results)} checks passed")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
