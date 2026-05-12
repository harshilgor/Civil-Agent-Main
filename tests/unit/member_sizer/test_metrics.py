"""Scheme metrics aggregation tests."""

from __future__ import annotations

from packages.engine.member_sizer.metrics import (
    compute_scheme_metrics,
    normalise_cost_index_across_schemes,
)
from packages.engine.member_sizer.models import MemberSizingSummary


def _beam(member_id: str, size: str, weight: float, length: float) -> MemberSizingSummary:
    from packages.engine.member_sizer.models import MemberCheck

    return MemberSizingSummary(
        member_id=member_id,
        member_type="beam",
        selected_size=size,
        weight_plf=weight,
        length_ft=length,
        dcr=0.5,
        governing_check="flexure",
        status="pass",
        all_checks=[],
    )


def _col(member_id: str, size: str, weight: float, length: float) -> MemberSizingSummary:
    return MemberSizingSummary(
        member_id=member_id,
        member_type="column",
        selected_size=size,
        weight_plf=weight,
        length_ft=length,
        dcr=0.5,
        governing_check="axial_compression",
        status="pass",
        all_checks=[],
    )


def test_steel_tonnage_sums_member_weights():
    """Tonnage = Σ (plf × length) / 2000."""
    beams = [_beam("B1", "W21x44", 44, 30), _beam("B2", "W21x44", 44, 30)]
    cols = [_col("C1", "W14x82", 82, 100)]
    metrics = compute_scheme_metrics(beams, cols)
    expected_lb = 44 * 30 + 44 * 30 + 82 * 100  # 10840 lb
    assert metrics.steel_tonnage == round(expected_lb / 2000, 1)


def test_max_beam_depth_uses_nominal():
    beams = [_beam("B1", "W21x44", 44, 30), _beam("B2", "W12x26", 26, 20)]
    metrics = compute_scheme_metrics(beams, [])
    assert metrics.max_beam_depth == 21.0


def test_unique_sections_dedupes():
    beams = [
        _beam("B1", "W21x44", 44, 30),
        _beam("B2", "W21x44", 44, 30),
        _beam("B3", "W18x35", 35, 25),
    ]
    cols = [_col("C1", "W14x82", 82, 100)]
    metrics = compute_scheme_metrics(beams, cols)
    assert metrics.unique_sections == 3  # W21x44, W18x35, W14x82


def test_concrete_volume_and_drift_remain_null():
    metrics = compute_scheme_metrics([_beam("B", "W21x44", 44, 30)], [])
    assert metrics.concrete_volume is None
    assert metrics.max_drift is None


def test_cost_normalisation_picks_cheapest_as_baseline():
    """Cheapest scheme should normalise to 1.0; others scaled proportionally."""
    raw = [120.0, 100.0, 150.0]
    out = normalise_cost_index_across_schemes(raw)
    assert out == [1.2, 1.0, 1.5]


def test_cost_normalisation_handles_none():
    raw = [None, 100.0, 200.0, None]
    out = normalise_cost_index_across_schemes(raw)
    assert out == [None, 1.0, 2.0, None]


def test_cost_normalisation_all_none_returns_none_list():
    assert normalise_cost_index_across_schemes([None, None]) == [None, None]
