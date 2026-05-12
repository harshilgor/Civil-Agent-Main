"""End-to-end calculator tests.

Verifies the full pipeline (tributary → loads → LRFD → sizing →
metrics) against a known-good 8-story office model.
"""

from __future__ import annotations

import pytest

from packages.engine.member_sizer import (
    SIZER_VERSION,
    SizingAssumptions,
    calculate_scheme_sizing,
)


def _make_geometry(num_floors: int = 8, *, plan_w: int = 90,
                   plan_h: int = 60, height: float = 13.5) -> dict:
    boundary = [
        {"x": 0, "y": 0},
        {"x": plan_w, "y": 0},
        {"x": plan_w, "y": plan_h},
        {"x": 0, "y": plan_h},
    ]
    levels = []
    for i in range(num_floors):
        levels.append({
            "id": f"L{i+1}",
            "name": f"Level {i+1}" if i < num_floors - 1 else "Roof",
            "elevation": i * height,
            "height": height,
            "planBoundary": boundary,
        })
    return {
        "levels": levels,
        "buildingBounds": {
            "minX": 0, "minY": 0, "maxX": plan_w, "maxY": plan_h,
        },
    }


def _make_scheme(num_floors: int = 8, *, plan_w: int = 90,
                 plan_h: int = 60, bay: int = 30) -> dict:
    """4x3 grid on a 90x60 plan (30ft bays)."""
    columns = []
    for x in range(0, plan_w + 1, bay):
        for y in range(0, plan_h + 1, bay):
            columns.append({
                "id": f"C-{x}-{y}",
                "x": float(x),
                "y": float(y),
                "startLevel": f"L{num_floors}",
                "endLevel": "L1",
                "locked": False,
                "source": "generated",
                "gridLabel": f"{chr(65 + x // bay)}-{(y // bay) + 1}",
            })

    beams = []
    bid = 0
    # Beams on every level above the first (floors L2..LN; L1 is grade).
    for level_idx in range(2, num_floors + 1):
        level_id = f"L{level_idx}"
        # x-direction beams
        for y in range(0, plan_h + 1, bay):
            for x in range(0, plan_w, bay):
                bid += 1
                beams.append({
                    "id": f"B-{bid}",
                    "start": {"x": float(x), "y": float(y)},
                    "end":   {"x": float(x + bay), "y": float(y)},
                    "levelId": level_id,
                    "span": float(bay),
                })
        # y-direction beams
        for x in range(0, plan_w + 1, bay):
            for y in range(0, plan_h, bay):
                bid += 1
                beams.append({
                    "id": f"B-{bid}",
                    "start": {"x": float(x), "y": float(y)},
                    "end":   {"x": float(x), "y": float(y + bay)},
                    "levelId": level_id,
                    "span": float(bay),
                })

    return {
        "id": "S-test",
        "displayLabel": "A",
        "name": "Balanced Strategy",
        "strategy": "balanced",
        "columns": columns,
        "beams": beams,
        "shearWalls": [],
        "braces": [],
        "metrics": {},
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_8_story_office_full_calculation():
    """Run the full pipeline on an 8-story office building."""
    geom = _make_geometry(num_floors=8)
    scheme = _make_scheme(num_floors=8)
    result = calculate_scheme_sizing(scheme, geom)

    # All members sized.
    assert len(result.beam_summaries) == len(scheme["beams"])
    assert len(result.column_summaries) == len(scheme["columns"])

    # Every D/C is a finite float.
    for s in result.beam_summaries + result.column_summaries:
        assert s.dcr > 0
        assert s.dcr < 100  # nothing absurd
        assert s.selected_size != ""


def test_metrics_populated():
    geom = _make_geometry(num_floors=5)
    scheme = _make_scheme(num_floors=5)
    result = calculate_scheme_sizing(scheme, geom)
    m = result.updated_metrics

    assert m.steel_tonnage is not None and m.steel_tonnage > 0
    assert m.unique_sections is not None and m.unique_sections >= 1
    assert m.max_beam_depth is not None and m.max_beam_depth >= 8
    # cost_index is the raw value here; orchestrator normalises later.
    assert m.cost_index is not None and m.cost_index > 0
    # Out-of-scope fields stay None.
    assert m.concrete_volume is None
    assert m.max_drift is None


def test_deterministic_given_same_inputs():
    """Same scheme + assumptions → same metrics, byte-for-byte."""
    geom = _make_geometry(num_floors=4)
    scheme = _make_scheme(num_floors=4)
    a = SizingAssumptions()
    r1 = calculate_scheme_sizing(scheme, geom, a)
    r2 = calculate_scheme_sizing(scheme, geom, a)
    assert r1.updated_metrics.steel_tonnage == r2.updated_metrics.steel_tonnage
    assert r1.updated_metrics.unique_sections == r2.updated_metrics.unique_sections
    # Per-member sizes must match exactly.
    sizes_1 = sorted([s.selected_size for s in r1.beam_summaries])
    sizes_2 = sorted([s.selected_size for s in r2.beam_summaries])
    assert sizes_1 == sizes_2


def test_deflection_governs_for_some_beams():
    """A realistic 30ft bay typically has multiple deflection-controlled
    beams. If none are deflection-controlled, the calculation is
    suspect."""
    geom = _make_geometry(num_floors=8)
    scheme = _make_scheme(num_floors=8)
    result = calculate_scheme_sizing(scheme, geom)
    governing = {s.governing_check for s in result.beam_summaries}
    assert "deflection_total" in governing or "deflection_live" in governing


def test_columns_use_w14_series_for_office():
    geom = _make_geometry(num_floors=8)
    scheme = _make_scheme(num_floors=8)
    result = calculate_scheme_sizing(scheme, geom)
    w14_count = sum(1 for s in result.column_summaries
                    if s.selected_size.startswith("W14"))
    # Vast majority should be W14.
    assert w14_count >= 0.8 * len(result.column_summaries)


def test_steel_tonnage_in_realistic_range():
    """An 8-story 90'×60' steel office is roughly 60-150 tons of steel.
    Well-formed result must land in that range — wildly different
    means a unit bug."""
    geom = _make_geometry(num_floors=8)
    scheme = _make_scheme(num_floors=8)
    result = calculate_scheme_sizing(scheme, geom)
    tonnage = result.updated_metrics.steel_tonnage
    assert 30 <= tonnage <= 250, f"unexpected tonnage {tonnage} t"


def test_calculation_completes_under_5_seconds():
    """The whole pipeline should run quickly on a typical building."""
    geom = _make_geometry(num_floors=10)
    scheme = _make_scheme(num_floors=10)
    result = calculate_scheme_sizing(scheme, geom)
    assert result.calculation_time_ms < 5000


def test_assumptions_echoed_in_result():
    """Auditing — the result must include the assumptions that were
    actually used."""
    geom = _make_geometry(num_floors=3)
    scheme = _make_scheme(num_floors=3)
    a = SizingAssumptions(dead_load_psf=80.0, live_load_psf=100.0)
    result = calculate_scheme_sizing(scheme, geom, a)
    assert result.assumptions_used.dead_load_psf == 80.0
    assert result.assumptions_used.live_load_psf == 100.0


def test_assumptions_accept_camelcase_dict():
    """The worker passes a JSON dict with camelCase keys; the engine
    must accept that as well as the snake_case Python instance."""
    geom = _make_geometry(num_floors=3)
    scheme = _make_scheme(num_floors=3)
    result = calculate_scheme_sizing(
        scheme,
        geom,
        {"deadLoadPsf": 80.0, "liveLoadPsf": 60.0},
    )
    assert result.assumptions_used.dead_load_psf == 80.0
    assert result.assumptions_used.live_load_psf == 60.0


def test_sizer_version_string_present():
    assert isinstance(SIZER_VERSION, str)
    assert len(SIZER_VERSION) >= 3
