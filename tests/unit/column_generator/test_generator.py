"""Integration test for the full ``generate_schemes`` pipeline."""

from __future__ import annotations

import time

import pytest

from packages.engine.column_generator import (
    GenerationConstraints,
    generate_schemes,
)
from tests.fixtures.parsed_geometry_fixture import make_fixture


# ---------------------------------------------------------------------------
# Output shape
# ---------------------------------------------------------------------------


def test_returns_five_schemes():
    schemes = generate_schemes(make_fixture())
    assert len(schemes) == 5


def test_each_scheme_has_columns_beams_metrics():
    schemes = generate_schemes(make_fixture())
    for s in schemes:
        assert s.columns, f"{s.strategy} produced no columns"
        assert s.beams, f"{s.strategy} produced no beams"
        assert s.metrics is not None
        assert s.shear_walls == []
        assert s.braces == []


def test_exactly_one_active_scheme():
    schemes = generate_schemes(make_fixture())
    actives = [s for s in schemes if s.status == "active"]
    alts = [s for s in schemes if s.status == "alternate"]
    assert len(actives) == 1
    assert len(alts) == len(schemes) - 1


def test_active_is_highest_score():
    schemes = generate_schemes(make_fixture())
    active = next(s for s in schemes if s.status == "active")
    for other in schemes:
        if other.status == "active":
            continue
        assert (active.score or 0) >= (other.score or 0)


def test_no_sizing_metrics_populated():
    schemes = generate_schemes(make_fixture())
    for s in schemes:
        assert s.metrics.steel_tonnage is None
        assert s.metrics.cost_index is None
        assert s.metrics.max_drift is None
        assert s.metrics.max_beam_depth is None
        assert s.metrics.unique_sections is None
        for col in s.columns:
            assert col.size is None
            assert col.dcr is None
            assert col.status is None
        for beam in s.beams:
            assert beam.size is None
            assert beam.dcr is None


def test_all_column_ids_unique_within_each_scheme():
    schemes = generate_schemes(make_fixture())
    for s in schemes:
        ids = [c.id for c in s.columns]
        assert len(ids) == len(set(ids)), f"{s.strategy}: duplicate column ids"


def test_all_beam_level_ids_reference_known_levels():
    fx = make_fixture()
    level_ids = {lvl["id"] for lvl in fx["levels"]}
    schemes = generate_schemes(fx)
    for s in schemes:
        for b in s.beams:
            assert b.level_id in level_ids


def test_schemes_have_meaningfully_different_column_counts():
    schemes = generate_schemes(make_fixture())
    counts = {s.metrics.column_count for s in schemes}
    # Five strategies should produce at least 3 distinct column counts.
    # If they collapsed to 1-2 values the strategy parameters aren't
    # producing interesting variation.
    assert len(counts) >= 3


def test_display_labels_are_a_through_e_in_creation_order():
    schemes = generate_schemes(make_fixture())
    # Schemes are sorted by score after generation, but display labels
    # reflect creation order. Re-sort by strategy creation order to
    # check labels.
    from packages.engine.column_generator.constants import STRATEGY_DEFINITIONS

    expected_labels = {spec["key"]: chr(ord("A") + i)
                       for i, spec in enumerate(STRATEGY_DEFINITIONS)}
    for s in schemes:
        assert s.display_label == expected_labels[s.strategy]


def test_camelcase_serialisation():
    """Frontend reads camelCase — make sure the alias config sticks."""
    schemes = generate_schemes(make_fixture())
    payload = schemes[0].model_dump(by_alias=True)
    assert "displayLabel" in payload
    assert "shearWalls" in payload
    metrics = payload["metrics"]
    assert "columnCount" in metrics
    assert "maxSpan" in metrics
    assert "averageSpan" in metrics
    assert "uniqueBayPatterns" in metrics
    assert "warningCount" in metrics
    assert "steelTonnage" in metrics  # present, just None
    assert metrics["steelTonnage"] is None
    assert "costIndex" in metrics
    if payload["columns"]:
        col = payload["columns"][0]
        assert "gridLabel" in col
        assert "startLevel" in col
        assert "endLevel" in col
    if payload["beams"]:
        beam = payload["beams"][0]
        assert "levelId" in beam


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_same_input_produces_identical_output():
    a = generate_schemes(make_fixture())
    b = generate_schemes(make_fixture())
    a_dump = [s.model_dump(by_alias=True) for s in a]
    b_dump = [s.model_dump(by_alias=True) for s in b]
    assert a_dump == b_dump


def test_scheme_ids_are_deterministic_uuids():
    a = generate_schemes(make_fixture())
    b = generate_schemes(make_fixture())
    for sa, sb in zip(a, b):
        assert sa.id == sb.id
        # Each id is a parseable UUID.
        import uuid

        uuid.UUID(sa.id)


# ---------------------------------------------------------------------------
# Constraints behaviour
# ---------------------------------------------------------------------------


def test_locked_columns_appear_in_output():
    fx = make_fixture()
    constraints = GenerationConstraints(locked_column_ids=["C1", "C5"])
    schemes = generate_schemes(fx, constraints)
    for s in schemes:
        ids = {c.id for c in s.columns}
        assert "C1" in ids, f"{s.strategy} missing locked C1"
        assert "C5" in ids, f"{s.strategy} missing locked C5"
        for col in s.columns:
            if col.id == "C1":
                assert col.locked is True
                assert col.source == "locked"
                assert col.x == 0.0 and col.y == 0.0
            if col.id == "C5":
                assert col.locked is True
                assert col.x == 112.0 and col.y == 0.0


def test_columns_avoid_no_column_zones():
    """No column should land inside the L1 lobby NCZ (4–30, 50–72)."""
    schemes = generate_schemes(make_fixture())
    for s in schemes:
        for col in s.columns:
            inside_lobby = (4 < col.x < 30) and (50 < col.y < 72)
            # Locked/existing columns are exempt — engineers may have
            # placed them inside the zone deliberately.
            if col.source in ("locked", "existing"):
                continue
            assert not inside_lobby, (
                f"{s.strategy}: column {col.id} at ({col.x}, {col.y}) sits inside the lobby NCZ"
            )


def test_columns_avoid_core_buffered_region():
    """No column should sit within the 3 ft core buffer."""
    schemes = generate_schemes(make_fixture())
    for s in schemes:
        for col in s.columns:
            if col.source in ("locked", "existing"):
                continue
            # CORE-1 buffered: (35..59, 19..53).
            in_core1 = (35 < col.x < 59) and (19 < col.y < 53)
            # CORE-2 buffered: (101..123, 15..47).
            in_core2 = (101 < col.x < 123) and (15 < col.y < 47)
            assert not (in_core1 or in_core2), (
                f"{s.strategy}: column {col.id} too close to a core"
            )


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_generation_completes_within_5_seconds():
    fx = make_fixture()
    t0 = time.monotonic()
    generate_schemes(fx)
    elapsed = time.monotonic() - t0
    assert elapsed < 5.0, f"generation took {elapsed:.2f}s"


# ---------------------------------------------------------------------------
# Validation guards
# ---------------------------------------------------------------------------


def test_missing_levels_raises():
    fx = make_fixture()
    fx["levels"] = []
    with pytest.raises(ValueError):
        generate_schemes(fx)


def test_degenerate_building_bounds_raises():
    fx = make_fixture()
    fx["buildingBounds"] = {"minX": 0, "minY": 0, "maxX": 0, "maxY": 0}
    with pytest.raises(ValueError):
        generate_schemes(fx)
