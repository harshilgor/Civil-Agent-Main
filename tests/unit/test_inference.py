"""Tests for grid + core inference."""

from __future__ import annotations

from packages.engine.geometry_parser.inference.core_inference import (
    CoreCandidate,
    infer_cores,
)
from packages.engine.geometry_parser.inference.grid_inference import (
    infer_grids_from_columns,
    reconcile_columns_to_grid,
)
from packages.engine.geometry_parser.models import ExistingColumn, GridLine


def _col(x: float, y: float, idx: int) -> ExistingColumn:
    return ExistingColumn(
        id=f"c_{idx}",
        x=x,
        y=y,
        startLevel="lvl_1",
        endLevel="lvl_2",
        gridAligned=True,
    )


def test_grid_inference_builds_x_and_y_lines():
    cols = []
    for ix in range(4):
        for iy in range(3):
            cols.append(_col(ix * 30.0, iy * 25.0, ix * 10 + iy))
    grids = infer_grids_from_columns(cols)
    xs = [g.coordinate for g in grids if g.axis == "x"]
    ys = [g.coordinate for g in grids if g.axis == "y"]
    assert xs == [0.0, 30.0, 60.0, 90.0]
    assert ys == [0.0, 25.0, 50.0]
    assert all(g.source == "inferred" for g in grids)


def test_grid_inference_skips_when_too_few_columns():
    cols = [_col(0.0, 0.0, 0), _col(30.0, 0.0, 1)]
    assert infer_grids_from_columns(cols) == []


def test_reconciliation_marks_off_grid_columns():
    cols = [_col(0.0, 0.0, 0), _col(30.0, 0.0, 1), _col(33.0, 0.0, 2)]  # 3rd is 3ft from grid 30
    grids = [
        GridLine(id="g1", axis="x", label="1", coordinate=0.0, source="ifc"),
        GridLine(id="g2", axis="x", label="2", coordinate=30.0, source="ifc"),
        GridLine(id="g3", axis="y", label="A", coordinate=0.0, source="ifc"),
    ]
    out = reconcile_columns_to_grid(cols, grids, snap_tolerance=0.5, flag_tolerance=2.0)
    assert out[0].gridAligned and out[0].gridDeviation is None
    assert out[1].gridAligned and out[1].gridDeviation is None
    assert out[2].gridAligned is False
    assert out[2].gridDeviation == 3.0


def test_core_inference_groups_by_proximity():
    cands = [
        CoreCandidate(x=0, y=0, type="elevator", width=8, depth=8, level_ids=("lvl_1",)),
        CoreCandidate(x=10, y=0, type="stair", width=10, depth=20, level_ids=("lvl_1",)),
        CoreCandidate(x=200, y=200, type="service", width=8, depth=8, level_ids=("lvl_1",)),
    ]
    cores = infer_cores(cands, radius=15.0)
    assert len(cores) == 2
    types = {c.type for c in cores}
    assert "mixed" in types or {"elevator", "stair"} & types


def test_core_inference_produces_valid_polygons():
    cands = [
        CoreCandidate(x=0, y=0, type="elevator", width=8, depth=8, level_ids=("lvl_1",)),
    ]
    cores = infer_cores(cands)
    assert len(cores) == 1
    assert len(cores[0].boundary) == 4
    assert cores[0].groupingReason
