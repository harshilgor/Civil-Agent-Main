"""ASCE 7-22 live load reduction tests — CRITICAL.

This is the single most-scrutinised calculation in the tool. Every
case below maps to an example in ASCE 7-22 Chapter 4 commentary or
to AISC Design Examples (Volume 5).
"""

from __future__ import annotations

import pytest

from packages.engine.member_sizer.loads import (
    beam_loads,
    compute_floor_llr_factor,
    compute_roof_llr_factor,
)


# ---------------------------------------------------------------------------
# Floor LLR — ASCE 7-22 §4.7
# ---------------------------------------------------------------------------


def test_no_reduction_below_400sf():
    """A_I < 400 → no reduction at all."""
    assert compute_floor_llr_factor(50.0, 350.0) == 1.0
    assert compute_floor_llr_factor(50.0, 399.9) == 1.0


def test_no_reduction_for_heavy_live_loads():
    """L0 > 100 psf → no reduction (assembly, heavy storage)."""
    assert compute_floor_llr_factor(125.0, 5000.0) == 1.0
    assert compute_floor_llr_factor(101.0, 10_000.0) == 1.0


def test_standard_office_beam_900sf_influence():
    """Office beam with K_LL=2 and A_T=450 → A_I=900.

    Factor = 0.25 + 15/√900 = 0.25 + 0.5 = 0.75
    """
    factor = compute_floor_llr_factor(50.0, 900.0)
    assert factor == pytest.approx(0.75, abs=0.005)


def test_minimum_factor_single_floor():
    """Large area on a single floor saturates at 0.50."""
    factor = compute_floor_llr_factor(50.0, 100_000.0, floors_supported=1)
    assert factor == 0.50


def test_minimum_factor_multi_floor_drops_to_040():
    """Column supporting many floors → minimum is 0.40 (not 0.50).

    A_I_cumulative = 100_000 → raw factor = 0.25 + 15/√100000 ≈ 0.297.
    With floors_supported=4 the floor is 0.40.
    """
    factor = compute_floor_llr_factor(50.0, 100_000.0, floors_supported=4)
    assert factor == 0.40


def test_8_story_column_takedown_governing_value():
    """Spot check from the worked example in the agent spec.

    K_LL = 2, A_T per floor = 900 sf, 8 floors → A_I_cumulative = 14400.
    Factor = max(0.25 + 15/√14400, 0.40) = max(0.375, 0.40) = 0.40.
    """
    factor = compute_floor_llr_factor(
        50.0, 2 * 8 * 900.0, floors_supported=8
    )
    assert factor == pytest.approx(0.40, abs=1e-6)


def test_factor_bounded_above_by_one():
    """Should never increase the live load."""
    factor = compute_floor_llr_factor(40.0, 5_000_000.0)
    assert factor <= 1.0


def test_at_threshold_400sf_no_reduction():
    """A_I exactly at 400: ASCE allows reduction; we only kick in above
    the threshold to keep behaviour conservative on the edge."""
    factor = compute_floor_llr_factor(50.0, 400.0)
    # Allow either 1.0 (boundary inclusive) or the formula value
    # depending on interpretation; our impl uses < 400 → 1.0.
    assert factor in (1.0, pytest.approx(1.0))


# ---------------------------------------------------------------------------
# Roof LLR — ASCE 7-22 §4.8
# ---------------------------------------------------------------------------


def test_roof_llr_small_area_no_reduction():
    """A_t = 200 → R1 = 1.0."""
    assert compute_roof_llr_factor(200.0) == 1.0
    assert compute_roof_llr_factor(150.0) == 1.0


def test_roof_llr_intermediate_area():
    """A_t = 400 → R1 = 1.2 - 0.001*400 = 0.8."""
    factor = compute_roof_llr_factor(400.0)
    assert factor == pytest.approx(0.80, abs=0.005)


def test_roof_llr_large_area_floor():
    """A_t = 600 → R1 = 0.6."""
    assert compute_roof_llr_factor(600.0) == pytest.approx(0.60, abs=0.005)
    assert compute_roof_llr_factor(10_000.0) == pytest.approx(0.60, abs=0.005)


def test_roof_llr_factor_bounded():
    factor = compute_roof_llr_factor(0.0)
    assert factor == 1.0


# ---------------------------------------------------------------------------
# Beam-load aggregator
# ---------------------------------------------------------------------------


def test_beam_loads_office_typical():
    """30ft span, 30ft trib width, 75 psf D / 50 psf L.

    A_T = 900, K_LL=2 → A_I = 1800. LLR ≈ 0.604.
    DL slab = 75 * 30 / 1000 = 2.25 klf
    DL self = 50 / 1000 = 0.05 klf
    LL_unred = 50 * 30 / 1000 = 1.50 klf
    LL_red ≈ 1.50 * 0.604 = 0.906 klf
    """
    loads = beam_loads(
        span_ft=30.0,
        trib_width_ft=30.0,
        influence_area_sf=1800.0,
        dead_load_psf=75.0,
        live_load_psf=50.0,
        beam_self_weight_plf=50.0,
    )
    assert loads.w_dead_slab_klf == pytest.approx(2.25, abs=0.005)
    assert loads.w_dead_self_klf == pytest.approx(0.050, abs=0.001)
    assert loads.w_live_unreduced_klf == pytest.approx(1.50, abs=0.005)
    assert loads.llr_factor == pytest.approx(0.604, abs=0.005)
    assert loads.w_live_reduced_klf == pytest.approx(0.906, abs=0.01)


def test_beam_loads_zero_trib_no_load():
    loads = beam_loads(
        span_ft=20.0,
        trib_width_ft=0.0,
        influence_area_sf=0.0,
        dead_load_psf=75.0,
        live_load_psf=50.0,
        beam_self_weight_plf=50.0,
    )
    assert loads.w_dead_slab_klf == 0
    assert loads.w_live_reduced_klf == 0
    # Self-weight still adds in.
    assert loads.w_dead_self_klf > 0
