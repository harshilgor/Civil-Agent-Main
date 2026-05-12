"""Unit tests for the grid builder."""

from __future__ import annotations

import pytest
from shapely.geometry import Polygon

from packages.engine.column_generator.grid_builder import (
    build_regular_grid,
    reduce_interior,
)


BOUNDS = {"minX": 0.0, "maxX": 120.0, "minY": 0.0, "maxY": 80.0}


def test_regular_grid_at_30ft_covers_full_floor():
    cols = build_regular_grid(BOUNDS, bay_x=30.0, bay_y=30.0)
    assert cols, "expected non-empty grid"

    xs = sorted({c["x"] for c in cols})
    ys = sorted({c["y"] for c in cols})
    # Endpoints always included.
    assert xs[0] == pytest.approx(0.0)
    assert xs[-1] == pytest.approx(120.0)
    assert ys[0] == pytest.approx(0.0)
    assert ys[-1] == pytest.approx(80.0)


def test_grid_snaps_to_existing_grid_lines_within_tolerance():
    grids = [
        {"axis": "x", "label": "1", "coordinate": 0.0},
        {"axis": "x", "label": "2", "coordinate": 27.8},  # within 0.5 of 28
        {"axis": "x", "label": "3", "coordinate": 56.2},
    ]
    cols = build_regular_grid(BOUNDS, bay_x=28.0, bay_y=80.0, grid_lines=grids)
    xs = {c["x"] for c in cols}
    # The 28.0 candidate snaps to 27.8 (within 0.5 tolerance).
    assert 27.8 in xs


def test_grid_respects_building_bounds_no_columns_outside():
    cols = build_regular_grid(BOUNDS, bay_x=25.0, bay_y=25.0)
    for c in cols:
        assert -0.5 <= c["x"] <= 120.5
        assert -0.5 <= c["y"] <= 80.5


def test_different_bay_sizes_produce_different_column_counts():
    big = build_regular_grid(BOUNDS, bay_x=40.0, bay_y=40.0)
    small = build_regular_grid(BOUNDS, bay_x=20.0, bay_y=20.0)
    assert len(small) > len(big)


def test_floor_polygon_filters_out_columns_outside():
    # Triangle floor plate — columns inside the bbox but outside the
    # polygon must be dropped.
    triangle = Polygon([(0, 0), (120, 0), (0, 80)])
    cols = build_regular_grid(BOUNDS, bay_x=30.0, bay_y=30.0, floor_polygon=triangle)
    # Top-right corner (120, 80) is outside the triangle.
    assert not any(c["x"] >= 119 and c["y"] >= 79 for c in cols)


def test_offset_shifts_grid():
    cols_no_offset = build_regular_grid(BOUNDS, bay_x=30.0, bay_y=30.0, offset_x=0.0)
    cols_offset = build_regular_grid(BOUNDS, bay_x=30.0, bay_y=30.0, offset_x=15.0)
    xs_no = sorted({c["x"] for c in cols_no_offset})
    xs_off = sorted({c["x"] for c in cols_offset})
    # 15.0 should appear in the offset grid but not the unshifted one.
    assert 15.0 in xs_off
    assert 15.0 not in xs_no


def test_zero_or_negative_bay_returns_empty():
    assert build_regular_grid(BOUNDS, bay_x=0.0, bay_y=30.0) == []
    assert build_regular_grid(BOUNDS, bay_x=30.0, bay_y=-1.0) == []


def test_degenerate_bounds_returns_empty():
    bad = {"minX": 0.0, "maxX": 0.0, "minY": 0.0, "maxY": 0.0}
    assert build_regular_grid(bad, bay_x=10.0, bay_y=10.0) == []


# ---------------------------------------------------------------------------
# Interior reduction
# ---------------------------------------------------------------------------


def _grid_columns(rows: list[float], cols_per_row: list[float]) -> list[dict]:
    out = []
    for y in rows:
        for x in cols_per_row:
            out.append({"x": x, "y": y})
    return out


def test_interior_reduction_keeps_perimeter_columns():
    cols = _grid_columns(rows=[0, 30, 60], cols_per_row=[0, 30, 60, 90])
    reduced, _ = reduce_interior(
        cols, perimeter_xs=(0, 90), perimeter_ys=(0, 60), max_bay=45.0
    )
    # Every perimeter column survives.
    perim = {(0, 0), (30, 0), (60, 0), (90, 0),
             (0, 60), (30, 60), (60, 60), (90, 60),
             (0, 30), (90, 30)}
    survivors = {(c["x"], c["y"]) for c in reduced}
    for p in perim:
        assert p in survivors


def test_interior_reduction_skips_when_span_would_exceed_max():
    cols = _grid_columns(rows=[0, 25, 50], cols_per_row=[0, 25, 50, 75])
    # max_bay=30 means we cannot remove interior columns without
    # violating the span constraint.
    reduced, warnings = reduce_interior(
        cols, perimeter_xs=(0, 75), perimeter_ys=(0, 50), max_bay=30.0
    )
    assert len(reduced) == len(cols)
    assert any("span would exceed" in w for w in warnings)
