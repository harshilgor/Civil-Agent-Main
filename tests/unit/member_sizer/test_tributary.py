"""Tributary area / width tests."""

from __future__ import annotations

import pytest

from packages.engine.member_sizer.constants import (
    K_LL_CORNER_COLUMN,
    K_LL_EDGE_COLUMN,
    K_LL_INTERIOR_BEAM,
    K_LL_INTERIOR_COLUMN,
)
from packages.engine.member_sizer.tributary import (
    beam_direction,
    compute_beam_tributary,
    compute_column_tributary,
)


PLAN_BOUNDARY = [
    {"x": 0, "y": 0},
    {"x": 90, "y": 0},
    {"x": 90, "y": 60},
    {"x": 0, "y": 60},
]


def _x_beam(bid: str, x_start: float, x_end: float, y: float, level: str = "L1") -> dict:
    return {
        "id": bid,
        "start": {"x": x_start, "y": y},
        "end": {"x": x_end, "y": y},
        "levelId": level,
        "span": abs(x_end - x_start),
    }


def _y_beam(bid: str, x: float, y_start: float, y_end: float, level: str = "L1") -> dict:
    return {
        "id": bid,
        "start": {"x": x, "y": y_start},
        "end": {"x": x, "y": y_end},
        "levelId": level,
        "span": abs(y_end - y_start),
    }


# ---------------------------------------------------------------------------
# Direction classification
# ---------------------------------------------------------------------------


def test_beam_direction_x_dominant():
    assert beam_direction(0, 0, 30, 0) == "x"
    assert beam_direction(0, 0, 30, 5) == "x"


def test_beam_direction_y_dominant():
    assert beam_direction(0, 0, 0, 30) == "y"
    assert beam_direction(0, 0, 5, 30) == "y"


# ---------------------------------------------------------------------------
# Beam tributary
# ---------------------------------------------------------------------------


def test_interior_beam_30ft_trib_width():
    """30ft beam with parallel beams 30ft above and below → width=30."""
    target = _x_beam("B-mid", 0, 30, 30)
    siblings = [
        _x_beam("B-bot", 0, 30, 0),
        target,
        _x_beam("B-top", 0, 30, 60),
    ]
    trib = compute_beam_tributary(target, siblings, PLAN_BOUNDARY)
    assert trib.trib_width_ft == pytest.approx(30.0, abs=0.5)
    assert trib.K_LL == K_LL_INTERIOR_BEAM
    assert not trib.is_edge_beam


def test_edge_beam_extends_to_floor_plate():
    """Bottom edge beam (y=0). Only neighbour is at y=30, no neighbour
    below. Floor plate is at y=0, so the negative-side distance is 0
    and the positive-side half-distance is 15 → width=15."""
    target = _x_beam("B-edge", 0, 30, 0)
    siblings = [
        target,
        _x_beam("B-mid", 0, 30, 30),
    ]
    trib = compute_beam_tributary(target, siblings, PLAN_BOUNDARY)
    assert trib.trib_width_ft == pytest.approx(15.0, abs=0.5)
    assert trib.is_edge_beam


def test_beam_tributary_influence_area_uses_K_LL():
    target = _x_beam("B-mid", 0, 30, 30)
    siblings = [
        _x_beam("B-bot", 0, 30, 0),
        target,
        _x_beam("B-top", 0, 30, 60),
    ]
    trib = compute_beam_tributary(target, siblings, PLAN_BOUNDARY)
    # A_T = 30 * 30 = 900; A_I = 2 * 900 = 1800.
    assert trib.trib_area_sf == pytest.approx(900.0, abs=20)
    assert trib.influence_area_sf == pytest.approx(1800.0, abs=40)


# ---------------------------------------------------------------------------
# Column tributary
# ---------------------------------------------------------------------------


def _col(cid: str, x: float, y: float) -> dict:
    return {
        "id": cid,
        "x": x,
        "y": y,
        "startLevel": "L3",
        "endLevel": "L1",
    }


def test_interior_column_30x30_grid():
    """Column at center of a 4x3 grid (30ft bays).

    A_trib = 30 * 30 = 900 sf.
    K_LL = 4 (interior).
    """
    cols = [_col(f"C-{x}-{y}", x, y)
            for x in (0, 30, 60, 90)
            for y in (0, 30, 60)]
    target = next(c for c in cols if c["x"] == 30 and c["y"] == 30)
    trib = compute_column_tributary(target, cols, PLAN_BOUNDARY)
    assert trib.trib_area_sf == pytest.approx(900.0, abs=10)
    assert trib.K_LL == K_LL_INTERIOR_COLUMN
    assert trib.position == "interior"


def test_corner_column_quarter_bay():
    """Corner column (0,0) on 30ft bays. A_trib = 15 * 15 = 225."""
    cols = [_col(f"C-{x}-{y}", x, y)
            for x in (0, 30, 60, 90)
            for y in (0, 30, 60)]
    target = next(c for c in cols if c["x"] == 0 and c["y"] == 0)
    trib = compute_column_tributary(target, cols, PLAN_BOUNDARY)
    assert trib.trib_area_sf == pytest.approx(225.0, abs=20)
    assert trib.K_LL == K_LL_CORNER_COLUMN
    assert trib.position == "corner"


def test_edge_column_half_bay():
    """Edge column at (30, 0). 30ft bays.

    Neighbour at (0,0) → 30ft to left, (60,0) → 30ft to right,
    (30,30) → 30ft up, no neighbour below (floor plate edge at y=0).
    A_trib = 30 * 15 = 450.
    """
    cols = [_col(f"C-{x}-{y}", x, y)
            for x in (0, 30, 60, 90)
            for y in (0, 30, 60)]
    target = next(c for c in cols if c["x"] == 30 and c["y"] == 0)
    trib = compute_column_tributary(target, cols, PLAN_BOUNDARY)
    assert trib.trib_area_sf == pytest.approx(450.0, abs=30)
    assert trib.K_LL == K_LL_EDGE_COLUMN
    assert trib.position == "edge"
