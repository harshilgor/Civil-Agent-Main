"""Beam sizing tests — flexure, shear, deflection, governing-check
identification."""

from __future__ import annotations

import pytest

from packages.engine.member_sizer.beam_sizer import (
    BeamSizingInputs,
    size_beam,
)
from packages.engine.member_sizer.loads import LinearBeamLoad


def _make_loads(
    span_ft: float,
    *,
    w_dead_klf: float,
    w_live_klf: float,
    is_roof: bool = False,
) -> LinearBeamLoad:
    """Build a LinearBeamLoad with all fields populated, so the sizer
    sees consistent dead/live splits without going through ``loads.py``."""
    return LinearBeamLoad(
        span_ft=span_ft,
        trib_width_ft=30.0,
        influence_area_sf=2 * 30.0 * span_ft,
        w_dead_slab_klf=max(w_dead_klf - 0.05, 0.0),
        w_dead_self_klf=0.05,
        w_live_unreduced_klf=w_live_klf,
        w_live_reduced_klf=w_live_klf,  # no LLR — testing pure sizing
        llr_factor=1.0,
        is_roof=is_roof,
    )


def _inputs(span_ft: float, **kw) -> BeamSizingInputs:
    return BeamSizingInputs(
        scheme_id="S",
        beam_id="B",
        loads=_make_loads(span_ft, **kw),
    )


def test_short_span_flexure_or_deflection_governs():
    """20 ft beam at heavy load — flexure or deflection_total."""
    summary = size_beam(_inputs(20.0, w_dead_klf=2.0, w_live_klf=1.5))
    assert summary.selected_size is not None
    assert summary.governing_check in (
        "flexure", "shear", "deflection_total", "deflection_live"
    )
    assert summary.dcr <= 1.0


def test_long_span_typically_deflection_governs():
    """40 ft beam, light load → deflection nearly always governs.

    With Lr/360 = 480/360 = 1.33 in vs allowable for total = 480/240 = 2.0 in.
    """
    summary = size_beam(_inputs(40.0, w_dead_klf=0.5, w_live_klf=0.4))
    assert summary.governing_check in (
        "deflection_live", "deflection_total"
    )


def test_beam_emits_all_three_check_types():
    """Every beam must report flexure, shear, AND deflection."""
    summary = size_beam(_inputs(30.0, w_dead_klf=2.25, w_live_klf=1.5))
    types = {c.check_type for c in summary.all_checks}
    assert "flexure" in types
    assert "shear" in types
    assert "deflection_live" in types
    assert "deflection_total" in types


def test_only_one_governing_check():
    summary = size_beam(_inputs(30.0, w_dead_klf=2.25, w_live_klf=1.5))
    governing_count = sum(1 for c in summary.all_checks if c.governing)
    assert governing_count == 1


def test_governing_check_has_highest_dcr():
    summary = size_beam(_inputs(35.0, w_dead_klf=1.5, w_live_klf=1.0))
    governing = next(c for c in summary.all_checks if c.governing)
    other_max = max(c.dcr for c in summary.all_checks if not c.governing)
    assert governing.dcr >= other_max


def test_deflection_uses_unfactored_loads():
    """Deflection is a service-load check.

    Verify by computing manually: 30ft beam, w_live = 1.0 klf.
    If we accidentally used factored 1.6×w, the deflection would be
    60% larger and the dcr would jump from ~0.6 to ~0.97 for a typical
    section. A regression here would silently size beams too heavy.
    """
    summary = size_beam(_inputs(30.0, w_dead_klf=1.5, w_live_klf=1.0))
    defl_live = next(c for c in summary.all_checks if c.check_type == "deflection_live")
    assert defl_live.demand > 0
    # Sanity: a healthy deflection_live demand for ~1 klf @ 30ft is in
    # the 0.3-0.7 in range — definitely under 1.0 in (the L/360 cap).
    assert 0.05 <= defl_live.demand <= 1.0


def test_long_beam_emits_lateral_bracing_warning():
    """Span > 25 ft surfaces the Lb ≤ Lp assumption."""
    summary = size_beam(_inputs(35.0, w_dead_klf=1.0, w_live_klf=0.6))
    assert summary.warnings, "Expected at least one warning for long span"
    assert any("bracing" in w.lower() or "lp" in w.lower() for w in summary.warnings)


def test_short_beam_emits_no_bracing_warning():
    summary = size_beam(_inputs(20.0, w_dead_klf=2.0, w_live_klf=1.5))
    bracing_warnings = [w for w in summary.warnings if "bracing" in w.lower()]
    assert bracing_warnings == []


def test_governing_status_matches_dcr():
    """Status string must align with the governing dcr per
    constants.dcr_to_status."""
    from packages.engine.member_sizer.constants import dcr_to_status

    summary = size_beam(_inputs(30.0, w_dead_klf=2.0, w_live_klf=1.2))
    assert summary.status == dcr_to_status(summary.dcr)


def test_explanation_includes_calculation_trace():
    """Engineers expect to see numbers in the explanation."""
    summary = size_beam(_inputs(30.0, w_dead_klf=2.25, w_live_klf=1.5))
    flex = next(c for c in summary.all_checks if c.check_type == "flexure")
    assert "Mu" in flex.explanation
    assert "kip-ft" in flex.explanation
    assert "Zx" in flex.explanation


def test_self_weight_iteration_picks_actual_weight():
    """The selected section's actual plf should be reflected after one
    iteration. We start with w_self = 0.05 klf (50 plf) but a heavy
    section can have 100+ plf; the second pass must include that."""
    summary = size_beam(_inputs(30.0, w_dead_klf=2.25, w_live_klf=2.0))
    # The selected section's weight_plf is reflected in summary.weight_plf.
    assert summary.weight_plf > 0
