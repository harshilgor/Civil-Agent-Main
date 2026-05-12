"""LRFD load combination tests."""

from __future__ import annotations

import pytest

from packages.engine.member_sizer.combinations import (
    factored_axial_load,
    factored_uniform_load,
)


def test_uniform_combinations_dead_dominated():
    """Heavy DL with no LL → 1.4D governs."""
    out = factored_uniform_load(w_dead_klf=2.0, w_live_klf=0.0)
    assert out[0].name == "1.4D"
    assert out[0].factored_value == pytest.approx(2.8, abs=0.001)


def test_uniform_combinations_live_dominated():
    """Typical office: 1.2D + 1.6L should govern."""
    out = factored_uniform_load(w_dead_klf=2.25, w_live_klf=1.5)
    governing = out[0]
    assert governing.name == "1.2D + 1.6L"
    expected = 1.2 * 2.25 + 1.6 * 1.5
    assert governing.factored_value == pytest.approx(expected, abs=0.001)


def test_uniform_combinations_results_sorted_descending():
    out = factored_uniform_load(w_dead_klf=2.25, w_live_klf=1.5)
    values = [r.factored_value for r in out]
    assert values == sorted(values, reverse=True)


def test_no_redundant_120D_plus_10L_combination():
    """1.2D + 1.0L is intentionally omitted — for pure gravity it's
    always less than 1.2D + 1.6L. This test pins the design choice."""
    out = factored_uniform_load(w_dead_klf=1.0, w_live_klf=1.0)
    names = {r.name for r in out}
    assert "1.2D + 1.0L" not in names


def test_axial_combinations_for_columns():
    """Same combos applied to axial loads for column takedown."""
    out = factored_axial_load(P_dead_kip=540, P_live_kip=144)
    governing = out[0]
    expected = 1.2 * 540 + 1.6 * 144
    assert governing.name == "1.2D + 1.6L"
    assert governing.factored_value == pytest.approx(expected, abs=0.1)


def test_roof_combinations_use_lr():
    out = factored_uniform_load(w_dead_klf=1.0, w_live_klf=0.5, is_roof=True)
    names = [r.name for r in out]
    assert "1.2D + 1.6Lr" in names
    assert "1.4D" in names
