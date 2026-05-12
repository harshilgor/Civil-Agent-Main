"""Column sizing + load takedown tests."""

from __future__ import annotations

import pytest

from packages.engine.member_sizer.column_sizer import (
    ColumnSizingInputs,
    LevelTributary,
    size_column,
)


def _make_levels(num_floors: int, *, trib_sf: float = 900.0,
                 height_ft: float = 13.5) -> tuple[LevelTributary, ...]:
    """Build a stack of levels, top-to-bottom. Floor 0 is the roof."""
    out = []
    for i in range(num_floors):
        out.append(
            LevelTributary(
                level_id=f"L{num_floors - i}",
                level_name=f"Level {num_floors - i}" if i > 0 else "Roof",
                floor_index_from_top=i,
                tributary_area_sf=trib_sf,
                K_LL=4.0,
                height_ft=height_ft,
                is_roof=(i == 0),
            )
        )
    return tuple(out)


def _inputs(levels, *, dl: float = 75.0, ll: float = 50.0) -> ColumnSizingInputs:
    return ColumnSizingInputs(
        scheme_id="S",
        column_id="C-test",
        levels=levels,
        dead_load_psf=dl,
        live_load_psf=ll,
        roof_dead_load_psf=30.0,
        roof_live_load_psf=20.0,
    )


def test_takedown_accumulates_top_to_bottom():
    """Loads grow as we walk down the column."""
    levels = _make_levels(5)
    result = size_column(_inputs(levels))
    cum_dead = [t.dead_load_kip for t in result.takedowns]
    assert cum_dead == sorted(cum_dead), "Dead loads must increase down the column"


def test_takedown_includes_one_entry_per_level():
    levels = _make_levels(8)
    result = size_column(_inputs(levels))
    assert len(result.takedowns) == 8


def test_llr_decreases_with_more_floors_supported():
    """LLR factor at the base of an 8-story column should be lower than
    at level 2 (where only 1-2 floors are above)."""
    levels = _make_levels(8)
    result = size_column(_inputs(levels))
    top_factor = result.takedowns[0].reduction_factor   # roof — small influence area
    base_factor = result.takedowns[-1].reduction_factor  # base — large influence area
    assert base_factor <= top_factor


def test_8_story_column_governing_load_matches_hand_calc():
    """30x30 grid (interior column), 8 floors, K_LL=4.

    Per floor: A_T = 900, DL = 67.5 kip, LL = 45 kip
    8 floors: cum DL = 540, cum LL_unred = 360
    A_I_cumulative = 4 * 8 * 900 = 28,800
    LLR = max(0.25 + 15/√28800, 0.40) = max(0.338, 0.40) = 0.40
    LL_reduced = 360 * 0.40 = 144
    Pu = 1.2 * 540 + 1.6 * 144 = 648 + 230 = 878 kip
    """
    levels = _make_levels(8, trib_sf=900.0)
    # Note: the engine uses K_LL=4 for interior. Roof floor uses
    # roof-load (30/20 psf) — roof contributes 27 + 18 = 45 kip
    # cumulatively, less than a typical floor (67.5 + 45 = 112.5).
    result = size_column(_inputs(levels))

    # Find the base entry (the deepest floor index).
    base = max(result.takedowns, key=lambda t: t.level_index_from_top)

    # Dead load: 7 floors × 67.5 + 1 roof × (30 × 900 / 1000) = 472.5 + 27.0 = 499.5 kip
    assert base.dead_load_kip == pytest.approx(499.5, abs=1.0)
    # LLR factor at the base — should be at the 0.40 floor.
    assert base.reduction_factor == pytest.approx(0.40, abs=0.005)
    # Pu (1.2D + 1.6L_reduced):
    # LL_unred at base = 7 * 45 + 18 = 333 kip
    # LL_red = 333 * 0.40 = 133.2
    # Pu = 1.2 * 499.5 + 1.6 * 133.2 = 599.4 + 213.1 = 812.5
    assert base.factored_load_kip == pytest.approx(812.5, abs=2.0)


def test_column_selects_w14_series_for_typical_loads():
    levels = _make_levels(8, trib_sf=900.0)
    result = size_column(_inputs(levels))
    assert result.summary.selected_size.startswith("W14")


def test_column_passes_capacity_check():
    levels = _make_levels(6, trib_sf=900.0)
    result = size_column(_inputs(levels))
    # The selected section must satisfy the demand.
    assert result.summary.dcr <= 1.0
    assert result.summary.status in ("pass", "efficient", "near-capacity")


def test_column_takedown_covers_columns_only():
    """Each takedown entry refers back to the column id we asked for."""
    levels = _make_levels(4)
    result = size_column(_inputs(levels))
    for entry in result.takedowns:
        assert entry.column_id == "C-test"


def test_governing_combination_is_lrfd_string():
    levels = _make_levels(3)
    result = size_column(_inputs(levels))
    for entry in result.takedowns:
        assert entry.governing_combination in ("1.4D", "1.2D + 1.6L")


def test_column_summary_has_axial_check():
    levels = _make_levels(3)
    result = size_column(_inputs(levels))
    types = {c.check_type for c in result.summary.all_checks}
    assert "axial_compression" in types
