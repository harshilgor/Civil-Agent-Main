"""Unit tests for vertical stacking validation."""

from __future__ import annotations

from packages.engine.column_generator.stacking import validate_stacking


def _square(x0, y0, x1, y1):
    return [
        {"x": x0, "y": y0},
        {"x": x1, "y": y0},
        {"x": x1, "y": y1},
        {"x": x0, "y": y1},
    ]


def _level(level_id, elevation, boundary):
    return {"id": level_id, "elevation": elevation, "planBoundary": boundary}


def test_no_warnings_when_floor_plates_are_identical():
    plate = _square(0, 0, 100, 80)
    levels = [
        _level("L1", 0.0, plate),
        _level("L2", 13.0, plate),
        _level("L3", 26.0, plate),
    ]
    columns = [
        {"id": "C1", "x": 50.0, "y": 40.0, "start_level": "L1", "end_level": "L3"},
    ]
    assert validate_stacking(columns, levels) == []


def test_setback_floor_plate_triggers_stacking_warning():
    bottom = _square(0, 0, 100, 80)
    setback = _square(0, 0, 60, 80)  # upper levels narrower in x
    levels = [
        _level("L1", 0.0, bottom),
        _level("L2", 13.0, setback),
        _level("L3", 26.0, setback),
    ]
    # Column at x=80 is inside L1 but outside L2/L3.
    columns = [
        {"id": "C-edge", "x": 80.0, "y": 40.0,
         "start_level": "L1", "end_level": "L3"},
    ]
    warnings = validate_stacking(columns, levels)
    assert any("transfer structure" in w for w in warnings)
    assert any("L2" in w or "L3" in w for w in warnings)


def test_only_one_warning_per_failing_column():
    bottom = _square(0, 0, 100, 80)
    setback = _square(0, 0, 60, 80)
    levels = [
        _level("L1", 0.0, bottom),
        _level("L2", 13.0, setback),
        _level("L3", 26.0, setback),
    ]
    columns = [
        {"id": "C-edge", "x": 80.0, "y": 40.0,
         "start_level": "L1", "end_level": "L3"},
    ]
    warnings = validate_stacking(columns, levels)
    # We bail after the first failing level for a column — keeps the
    # warning list focused on the engineer-actionable item.
    assert len(warnings) == 1


def test_levels_without_planboundary_are_skipped():
    plate = _square(0, 0, 100, 80)
    levels = [
        _level("L1", 0.0, plate),
        {"id": "L2", "elevation": 13.0, "planBoundary": []},  # no boundary
        _level("L3", 26.0, plate),
    ]
    columns = [
        {"id": "C1", "x": 50.0, "y": 40.0, "start_level": "L1", "end_level": "L3"},
    ]
    assert validate_stacking(columns, levels) == []


def test_empty_input_is_safe():
    assert validate_stacking([], []) == []
    assert validate_stacking([{"id": "C", "x": 0, "y": 0,
                              "start_level": "L1", "end_level": "L1"}], []) == []
