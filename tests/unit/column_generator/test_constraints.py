"""Unit tests for exclusion-zone enforcement, locked columns, merge."""

from __future__ import annotations

from packages.engine.column_generator.constraints import (
    build_exclusion_zones,
    enforce_exclusions,
    merge_existing_columns,
    preserve_locked_columns,
)


def _square(x0, y0, x1, y1):
    return [
        {"x": x0, "y": y0},
        {"x": x1, "y": y0},
        {"x": x1, "y": y1},
        {"x": x0, "y": y1},
    ]


# ---------------------------------------------------------------------------
# Exclusion enforcement
# ---------------------------------------------------------------------------


def test_columns_inside_core_are_removed_or_shifted():
    cores = [{"id": "CORE", "boundary": _square(40, 30, 60, 50)}]
    zones = build_exclusion_zones(cores, [], [])
    cols = [
        {"x": 50, "y": 40, "source": "generated"},   # dead centre — must be shifted/removed
        {"x": 0, "y": 0, "source": "generated"},     # safe — keep as-is
    ]
    survivors, warns = enforce_exclusions(cols, zones, max_bay=45.0)
    # The (0,0) column is unchanged.
    assert any(c["x"] == 0 and c["y"] == 0 for c in survivors)
    # The (50,40) column is gone or shifted.
    assert not any(c["x"] == 50 and c["y"] == 40 for c in survivors)


def test_columns_inside_no_column_zones_are_removed():
    nczs = [{"id": "NCZ", "boundary": _square(0, 0, 30, 30)}]
    zones = build_exclusion_zones([], [], nczs)
    cols = [
        {"x": 15, "y": 15, "source": "generated"},
        {"x": 50, "y": 50, "source": "generated"},
    ]
    survivors, _ = enforce_exclusions(cols, zones, max_bay=45.0)
    # The interior point is gone (or pushed onto the boundary edge).
    interior = [c for c in survivors if c["x"] == 15 and c["y"] == 15]
    assert not interior


def test_columns_near_zone_can_be_shifted_to_valid_position():
    cores = [{"id": "CORE", "boundary": _square(40, 30, 60, 50)}]
    zones = build_exclusion_zones(cores, [], [])
    # Column 1ft inside the buffered core — should be shifted out.
    cols = [{"x": 39, "y": 40, "source": "generated"}]
    survivors, _ = enforce_exclusions(cols, zones, max_bay=45.0)
    if survivors:
        new = survivors[0]
        # Must no longer sit inside the buffered core.
        from shapely.geometry import Point

        for z in zones:
            assert not z.contains(Point(new["x"], new["y"]))


def test_zero_buffer_for_no_column_zones_enforced():
    nczs = [{"id": "NCZ", "boundary": _square(0, 0, 30, 30)}]
    zones = build_exclusion_zones([], [], nczs)
    # The polygon should match the raw NCZ — no expansion.
    assert zones[0].area == 30 * 30


# ---------------------------------------------------------------------------
# Locked columns
# ---------------------------------------------------------------------------


def test_locked_column_preserved_at_exact_position():
    existing = [
        {"id": "ENG-1", "x": 50.0, "y": 40.0, "startLevel": "L1", "endLevel": "L8"},
    ]
    zones = build_exclusion_zones([], [], [])
    cols = []
    survivors, warns = preserve_locked_columns(cols, existing, ["ENG-1"], zones)
    assert any(c["id"] == "ENG-1" and c["x"] == 50.0 and c["y"] == 40.0 for c in survivors)
    # And it is marked locked + source=locked.
    locked = [c for c in survivors if c["id"] == "ENG-1"][0]
    assert locked["locked"] is True
    assert locked["source"] == "locked"


def test_locked_column_warns_when_inside_exclusion_zone():
    cores = [{"id": "CORE", "boundary": _square(40, 30, 60, 50)}]
    existing = [
        {"id": "ENG-1", "x": 50.0, "y": 40.0, "startLevel": "L1", "endLevel": "L8"},
    ]
    zones = build_exclusion_zones(cores, [], [])
    survivors, warns = preserve_locked_columns([], existing, ["ENG-1"], zones)
    # Still kept — engineer's choice is sacred.
    assert any(c["id"] == "ENG-1" for c in survivors)
    assert any("inside an exclusion zone" in w for w in warns)


def test_locked_column_replaces_collocated_generated():
    existing = [
        {"id": "ENG-1", "x": 50.0, "y": 40.0, "startLevel": "L1", "endLevel": "L8"},
    ]
    cols = [{"x": 50.1, "y": 40.0, "source": "generated"}]
    zones = build_exclusion_zones([], [], [])
    survivors, _ = preserve_locked_columns(cols, existing, ["ENG-1"], zones)
    # No duplicate columns at that position.
    near = [c for c in survivors if abs(c["x"] - 50.0) < 1 and abs(c["y"] - 40.0) < 1]
    assert len(near) == 1
    assert near[0]["id"] == "ENG-1"


def test_unknown_locked_id_warns_and_continues():
    survivors, warns = preserve_locked_columns([], [], ["DOES-NOT-EXIST"], [])
    assert any("not found" in w for w in warns)


# ---------------------------------------------------------------------------
# Existing column merge
# ---------------------------------------------------------------------------


def test_existing_column_replaces_nearby_generated():
    generated = [{"x": 28.0, "y": 0.0, "source": "generated"}]
    existing = [
        {"id": "C2", "x": 28.0, "y": 0.0, "startLevel": "L1", "endLevel": "L8",
         "gridLabel": "A-2", "gridAligned": True},
    ]
    merged = merge_existing_columns(generated, existing, locked_ids=[])
    by_pos = [c for c in merged if abs(c["x"] - 28.0) < 1 and abs(c["y"]) < 1]
    assert len(by_pos) == 1
    assert by_pos[0]["id"] == "C2"
    assert by_pos[0]["source"] == "existing"


def test_locked_existing_columns_skipped_in_merge():
    generated = []
    existing = [
        {"id": "C2", "x": 28.0, "y": 0.0, "startLevel": "L1", "endLevel": "L8"},
    ]
    merged = merge_existing_columns(generated, existing, locked_ids=["C2"])
    # preserve_locked_columns is the layer that adds locked entries; the
    # merge step must skip them so we don't double-insert.
    assert merged == []
