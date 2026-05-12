"""AISC W-shape database verification.

Spot-checks the published values against the AISC Steel Construction
Manual, 16th edition. Engineers will spot bad section properties on
sight — these tests are the first line of defence.
"""

from __future__ import annotations

import math

import pytest

from packages.engine.member_sizer.aisc_database import (
    column_capacity,
    find_lightest_beam,
    find_lightest_column,
    get_all_shapes_sorted_by_weight,
    get_section_depth,
    get_shape,
    shapes_in_series,
)


# ---------------------------------------------------------------------------
# Section property verification — exact values from AISC Manual 16th ed.
# ---------------------------------------------------------------------------


def test_w21x44_properties():
    s = get_shape("W21x44")
    assert s is not None
    assert s.weight_plf == 44
    assert s.d == pytest.approx(20.66, abs=0.05)
    assert s.bf == pytest.approx(6.50, abs=0.05)
    assert s.tw == pytest.approx(0.350, abs=0.005)
    assert s.tf == pytest.approx(0.450, abs=0.005)
    assert s.A == pytest.approx(13.0, abs=0.1)
    assert s.Ix == pytest.approx(843, abs=2)
    assert s.Zx == pytest.approx(95.4, abs=0.5)


def test_w14x82_properties():
    s = get_shape("W14x82")
    assert s is not None
    assert s.weight_plf == 82
    assert s.A == pytest.approx(24.0, abs=0.1)
    assert s.Ix == pytest.approx(881, abs=2)
    assert s.ry == pytest.approx(2.48, abs=0.05)


def test_w24x55_properties():
    s = get_shape("W24x55")
    assert s is not None
    assert s.Zx == pytest.approx(134, abs=1)
    assert s.Ix == pytest.approx(1350, abs=5)


def test_section_lookup_case_insensitive():
    assert get_shape("w21x44") is get_shape("W21x44")
    assert get_shape("W21X44") is get_shape("W21x44")


def test_unknown_section_returns_none():
    assert get_shape("W99x999") is None
    assert get_shape("") is None
    assert get_shape("not a section") is None


def test_get_section_depth_from_name():
    assert get_section_depth("W21x44") == 21.0
    assert get_section_depth("W14x82") == 14.0
    assert get_section_depth("W36x150") == 36.0
    assert get_section_depth("") == 0.0


# ---------------------------------------------------------------------------
# Lightest-shape selection — beam
# ---------------------------------------------------------------------------


def test_lightest_beam_for_zx_requirement():
    s = find_lightest_beam(required_Zx=90.0)
    # W21x44 (Zx=95.4) is the canonical answer at this Zx level.
    assert s is not None
    assert s.Zx >= 90.0
    # Sanity: we pick a lighter shape than a much-bigger one.
    assert s.weight_plf <= 60


def test_lightest_beam_with_depth_constraint():
    """Short-span schemes constrain depth; the selector must respect it."""
    s = find_lightest_beam(required_Zx=90.0, max_depth_in=18.0)
    assert s is not None
    assert s.d <= 18.5
    assert s.Zx >= 90.0


def test_lightest_beam_zero_demand_returns_small():
    """Zero demand should still yield a valid section."""
    s = find_lightest_beam(required_Zx=0.0)
    assert s is not None


# ---------------------------------------------------------------------------
# Column capacity (AISC 360 Chapter E)
# ---------------------------------------------------------------------------


def test_column_capacity_w14x82_at_13p5_ft():
    """W14x82 at KL=13.5 ft. Hand calc:

    KL/r = 162 / 2.48 = 65.3
    Threshold = 4.71 * sqrt(29000/50) = 113.4 → inelastic regime
    Fe = π² × 29000 / 65.3² = 67.1 ksi
    Fcr = 0.658^(50/67.1) × 50 = 0.730 × 50 = 36.5 ksi
    φPn = 0.9 × 36.5 × 24.0 = 788 kip
    """
    s = get_shape("W14x82")
    phi_Pn, slen = column_capacity(s, KL_ft=13.5)
    assert slen == pytest.approx(65.3, abs=0.5)
    # AISC tabulated ~790 kip; our derivation should match within 3%.
    assert phi_Pn == pytest.approx(788, rel=0.03)


def test_column_capacity_slender_regime():
    """W10x33 at KL=30 ft → very slender, elastic regime."""
    s = get_shape("W10x33")
    phi_Pn, slen = column_capacity(s, KL_ft=30.0)
    # KL/r = 360 / 1.94 = 185.6 → above threshold (113), elastic.
    assert slen == pytest.approx(185.6, abs=0.5)
    assert phi_Pn > 0
    # Capacity should be modest — slender column.
    assert phi_Pn < 200


def test_column_capacity_zero_for_degenerate():
    s = get_shape("W14x82")
    phi_Pn, slen = column_capacity(s, KL_ft=0)
    assert phi_Pn == 0
    assert slen == 0


# ---------------------------------------------------------------------------
# Column selection
# ---------------------------------------------------------------------------


def test_find_lightest_column_prefers_w14():
    """For typical office loads, W14 should be selected."""
    s = find_lightest_column(required_phi_Pn=400, KL_ft=13.5)
    assert s is not None
    assert s.name.startswith("W14")
    # And it really should pass the capacity check.
    phi_Pn, _ = column_capacity(s, KL_ft=13.5)
    assert phi_Pn >= 400


def test_find_lightest_column_falls_back_to_lighter_series():
    """Tiny load — even W14x22 is overkill, but we still get something."""
    s = find_lightest_column(required_phi_Pn=10, KL_ft=12.0)
    assert s is not None


def test_find_lightest_column_for_heavy_load():
    """1500 kip at 14ft → heavy W14."""
    s = find_lightest_column(required_phi_Pn=1500, KL_ft=14.0)
    assert s is not None
    phi_Pn, _ = column_capacity(s, KL_ft=14.0)
    assert phi_Pn >= 1500
    # Should be a heavy W14.
    assert s.weight_plf >= 100


# ---------------------------------------------------------------------------
# Database integrity
# ---------------------------------------------------------------------------


def test_database_has_at_least_80_shapes():
    pool = get_all_shapes_sorted_by_weight()
    assert len(pool) >= 80


def test_database_sorted_by_weight_ascending():
    pool = get_all_shapes_sorted_by_weight()
    weights = [s.weight_plf for s in pool]
    assert weights == sorted(weights)


def test_w14_series_has_workhorse_columns():
    """The W14 family should include both light beams (W14x22) and
    heavy columns (W14x82+)."""
    family = shapes_in_series("W14")
    names = {s.name for s in family}
    assert "W14x22" in names
    assert "W14x82" in names
    assert "W14x132" in names


def test_section_modulus_increases_with_weight_within_depth():
    """Within a given nominal depth, heavier shapes have higher Zx."""
    w21s = sorted(
        [s for s in get_all_shapes_sorted_by_weight() if s.nominal_depth == 21],
        key=lambda s: s.weight_plf,
    )
    zxs = [s.Zx for s in w21s]
    # Strictly monotonic — every heavier W21 has a larger Zx.
    for i in range(1, len(zxs)):
        assert zxs[i] > zxs[i - 1], (
            f"W21 series Zx not monotonic at "
            f"{w21s[i-1].name}={zxs[i-1]} → {w21s[i].name}={zxs[i]}"
        )
