"""Unit tests for the scoring module."""

from __future__ import annotations

from packages.engine.column_generator.scoring import (
    collect_bay_sizes,
    score_scheme,
    unique_bay_patterns,
)


def _columns(n: int) -> list[dict]:
    return [{"x": float(i), "y": 0.0} for i in range(n)]


def _beams(spans: list[float]) -> list[dict]:
    return [{"span": s} for s in spans]


def test_higher_regularity_yields_higher_score():
    regular = _beams([30.0] * 20)
    irregular = _beams([30.0, 18.0, 25.0, 35.0, 22.0, 30.0, 28.0, 16.0])

    s_reg, _ = score_scheme(
        columns=_columns(20),
        beams=regular,
        bay_sizes=collect_bay_sizes(regular),
        target_bay=30.0,
        exclusion_zones=[],
    )
    s_irreg, _ = score_scheme(
        columns=_columns(20),
        beams=irregular,
        bay_sizes=collect_bay_sizes(irregular),
        target_bay=30.0,
        exclusion_zones=[],
    )
    assert s_reg > s_irreg


def test_score_in_zero_to_hundred_range():
    bays = _beams([30.0] * 20)
    score, components = score_scheme(
        columns=_columns(20),
        beams=bays,
        bay_sizes=collect_bay_sizes(bays),
        target_bay=30.0,
        exclusion_zones=[],
    )
    assert 0.0 <= score <= 100.0
    for v in components.values():
        assert 0.0 <= v <= 1.0


def test_fewer_columns_score_higher_on_count_component():
    s_few, _ = score_scheme(
        columns=_columns(20),
        beams=_beams([30.0] * 10),
        bay_sizes=[30.0] * 10,
        target_bay=30.0,
        exclusion_zones=[],
    )
    s_many, _ = score_scheme(
        columns=_columns(180),
        beams=_beams([30.0] * 100),
        bay_sizes=[30.0] * 100,
        target_bay=30.0,
        exclusion_zones=[],
    )
    assert s_few > s_many


def test_average_span_close_to_target_scores_well():
    near = _beams([29.0, 31.0, 30.0, 30.5])
    far = _beams([18.0, 16.0, 20.0])
    s_near, _ = score_scheme(
        columns=_columns(8),
        beams=near,
        bay_sizes=[b["span"] for b in near],
        target_bay=30.0,
        exclusion_zones=[],
    )
    s_far, _ = score_scheme(
        columns=_columns(8),
        beams=far,
        bay_sizes=[b["span"] for b in far],
        target_bay=30.0,
        exclusion_zones=[],
    )
    assert s_near > s_far


def test_unique_bay_patterns_counts_distinct_rounded_spans():
    assert unique_bay_patterns([30.0, 30.0, 30.0]) == 1
    assert unique_bay_patterns([30.0, 28.0, 35.0]) == 3
    # Rounded to nearest foot — 30.2 and 29.9 collapse.
    assert unique_bay_patterns([30.2, 29.9]) == 1


def test_empty_inputs_safe():
    score, _ = score_scheme(
        columns=[],
        beams=[],
        bay_sizes=[],
        target_bay=30.0,
        exclusion_zones=[],
    )
    assert score == 0.0
