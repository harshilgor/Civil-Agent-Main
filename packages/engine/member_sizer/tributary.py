"""Tributary area / width computation for beams and columns.

Pure geometry. No engineering parameters live here — just the rules
for partitioning a floor plate among the members that frame it.

Coordinate convention: the same plan frame Agent 1/3 produce. ``x`` and
``y`` in feet, ``y`` is the in-plan north-south axis (Three.js maps it
to ``z`` later, but that is not this module's concern).

For the MVP we use a straightforward "half-distance to nearest parallel
neighbour" rule for beams, and the "half-bay rectangle" rule for
columns. Both rules collapse to the textbook tributary partition for
regular grids and degrade gracefully on irregular layouts. The exact
voronoi/midline polygon is only needed for the influence area used
in ASCE 7 LLR — for that we compute ``A_T`` and apply the
position-classified ``K_LL`` from :mod:`constants`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Optional

from packages.engine.member_sizer.constants import (
    K_LL_CORNER_COLUMN,
    K_LL_EDGE_BEAM,
    K_LL_EDGE_COLUMN,
    K_LL_INTERIOR_BEAM,
    K_LL_INTERIOR_COLUMN,
)


# Tolerance (ft) for "are these two beams parallel?" checks.
_PARALLEL_TOL = 0.10
# Tolerance (ft) for "is this column on the floor-plate edge?".
_EDGE_TOL = 1.5


@dataclass
class BeamTributary:
    """Result of tributary-width computation for one beam."""

    beam_id: str
    span_ft: float
    direction: str  # "x" | "y" | "diagonal"
    trib_width_ft: float
    trib_area_sf: float            # = trib_width * span
    influence_area_sf: float       # K_LL * A_T (ASCE 7-22 4.7.2)
    K_LL: float
    is_edge_beam: bool


@dataclass
class ColumnTributary:
    """Result of tributary-area computation for one column at one level."""

    column_id: str
    level_id: str
    trib_area_sf: float
    K_LL: float
    position: str   # "interior" | "edge" | "corner"


# ---------------------------------------------------------------------------
# Beams
# ---------------------------------------------------------------------------


def beam_direction(start_x: float, start_y: float, end_x: float, end_y: float) -> str:
    """Classify a beam as primarily ``x`` or ``y`` spanning.

    A beam where ``|dx| > |dy|`` runs along the x-axis. Diagonal beams
    are vanishingly rare in our generator output; we lump them with
    "x" (whichever component is larger) so the tributary search still
    works.
    """
    dx = abs(end_x - start_x)
    dy = abs(end_y - start_y)
    if dx >= dy:
        return "x"
    return "y"


def _beam_midpoint(beam: dict) -> tuple[float, float]:
    return (
        (beam["start"]["x"] + beam["end"]["x"]) / 2.0,
        (beam["start"]["y"] + beam["end"]["y"]) / 2.0,
    )


def _floor_plate_extent(
    plan_boundary: list[dict],
) -> tuple[float, float, float, float]:
    """Return (min_x, min_y, max_x, max_y) for a polygon boundary."""
    if not plan_boundary:
        return (0.0, 0.0, 0.0, 0.0)
    xs = [pt["x"] for pt in plan_boundary]
    ys = [pt["y"] for pt in plan_boundary]
    return (min(xs), min(ys), max(xs), max(ys))


def compute_beam_tributary(
    beam: dict,
    sibling_beams: list[dict],
    plan_boundary: list[dict],
) -> BeamTributary:
    """Tributary width / area / influence area for a single beam.

    Algorithm:

    1. Classify the beam direction (x-spanning or y-spanning).
    2. Find the nearest parallel neighbour beams on each side
       (perpendicular to span). "Parallel" means same direction class
       and overlapping along the span axis.
    3. Tributary width = (dist_left/2) + (dist_right/2). On the side
       with no neighbour, fall back to the floor-plate edge distance.
    4. Influence area = K_LL × tributary area. ``K_LL`` is 2 for
       interior/edge beams without cantilevers — see
       :mod:`constants`.

    The result is conservative for irregular layouts (a beam with no
    parallel neighbour and far floor-plate boundaries gets a wide
    tributary, leading to heavier sizing).
    """
    span = float(beam.get("span") or _euclid(beam))
    direction = beam_direction(
        beam["start"]["x"], beam["start"]["y"],
        beam["end"]["x"],   beam["end"]["y"],
    )

    bmid = _beam_midpoint(beam)
    min_x, min_y, max_x, max_y = _floor_plate_extent(plan_boundary)

    # The "perpendicular axis" is the axis we measure trib width along.
    if direction == "x":
        perp_axis_value = bmid[1]  # this beam's y position
        perp_min, perp_max = min_y, max_y
    else:
        perp_axis_value = bmid[0]
        perp_min, perp_max = min_x, max_x

    # Find nearest parallel neighbours that overlap with this beam
    # along the span axis.
    pos_neighbours: list[float] = []
    neg_neighbours: list[float] = []
    for other in sibling_beams:
        if other.get("id") == beam.get("id"):
            continue
        if beam_direction(
            other["start"]["x"], other["start"]["y"],
            other["end"]["x"],   other["end"]["y"],
        ) != direction:
            continue
        omid = _beam_midpoint(other)
        # Perpendicular offset — does this neighbour live above or below us?
        if direction == "x":
            offset = omid[1] - perp_axis_value
            # Span overlap on the x-axis.
            if not _ranges_overlap(
                beam["start"]["x"], beam["end"]["x"],
                other["start"]["x"], other["end"]["x"],
            ):
                continue
        else:
            offset = omid[0] - perp_axis_value
            if not _ranges_overlap(
                beam["start"]["y"], beam["end"]["y"],
                other["start"]["y"], other["end"]["y"],
            ):
                continue
        if abs(offset) < _PARALLEL_TOL:
            continue  # same beam line / coincident
        if offset > 0:
            pos_neighbours.append(offset)
        else:
            neg_neighbours.append(-offset)

    nearest_pos = min(pos_neighbours) if pos_neighbours else None
    nearest_neg = min(neg_neighbours) if neg_neighbours else None

    # Distance from this beam line to the floor-plate boundary on each side.
    dist_to_pos_edge = max(perp_max - perp_axis_value, 0.0)
    dist_to_neg_edge = max(perp_axis_value - perp_min, 0.0)

    half_pos = (nearest_pos / 2.0) if nearest_pos is not None else dist_to_pos_edge
    half_neg = (nearest_neg / 2.0) if nearest_neg is not None else dist_to_neg_edge

    trib_width = max(half_pos + half_neg, 0.0)
    is_edge_beam = nearest_pos is None or nearest_neg is None

    K_LL = K_LL_EDGE_BEAM if is_edge_beam else K_LL_INTERIOR_BEAM
    trib_area = trib_width * span
    influence = K_LL * trib_area

    return BeamTributary(
        beam_id=beam.get("id", ""),
        span_ft=span,
        direction=direction,
        trib_width_ft=trib_width,
        trib_area_sf=trib_area,
        influence_area_sf=influence,
        K_LL=K_LL,
        is_edge_beam=is_edge_beam,
    )


# ---------------------------------------------------------------------------
# Columns
# ---------------------------------------------------------------------------


def compute_column_tributary(
    column: dict,
    sibling_columns: list[dict],
    plan_boundary: list[dict],
) -> ColumnTributary:
    """Tributary area for a single column at a single level.

    The simple-grid rule:

        A_trib = ((bay_left + bay_right) / 2) × ((bay_up + bay_down) / 2)

    where ``bay_*`` is the distance to the nearest column in that
    cardinal direction. For corner / edge columns the missing bay is
    replaced by the distance to the floor-plate boundary.

    This collapses to ``bay × bay`` for an interior column on a
    regular grid (each adjacent bay equals ``bay``), and to
    ``(bay/2) × (bay/2)`` for a corner column — matching the textbook
    distribution. For irregular layouts it remains a conservative
    upper bound (no overlap with neighbouring tributaries).

    K_LL is classified separately: interior=4, edge=3, corner=2 per
    ASCE 7-22 Table 4.7-1.
    """
    cx = float(column.get("x", 0.0))
    cy = float(column.get("y", 0.0))
    level_id = column.get("startLevel") or column.get("start_level") or ""

    # Find nearest column distances in +x, -x, +y, -y. We treat
    # near-coincident columns (delta < 0.5 ft) as "same column" and
    # ignore them — that handles sub-foot float jitter from the grid
    # generator.
    pos_x: list[float] = []
    neg_x: list[float] = []
    pos_y: list[float] = []
    neg_y: list[float] = []
    for other in sibling_columns:
        if other.get("id") == column.get("id"):
            continue
        ox = float(other.get("x", 0.0))
        oy = float(other.get("y", 0.0))
        dx = ox - cx
        dy = oy - cy
        # We only count "in-line" neighbours: those whose perpendicular
        # offset is within half a bay or so. Use a coarse threshold —
        # the nearest neighbour test then picks the closest.
        if abs(dy) < abs(dx) * 0.6 + _EDGE_TOL:
            if dx > 0.5:
                pos_x.append(dx)
            elif dx < -0.5:
                neg_x.append(-dx)
        if abs(dx) < abs(dy) * 0.6 + _EDGE_TOL:
            if dy > 0.5:
                pos_y.append(dy)
            elif dy < -0.5:
                neg_y.append(-dy)

    nearest_pos_x = min(pos_x) if pos_x else None
    nearest_neg_x = min(neg_x) if neg_x else None
    nearest_pos_y = min(pos_y) if pos_y else None
    nearest_neg_y = min(neg_y) if neg_y else None

    min_x, min_y, max_x, max_y = _floor_plate_extent(plan_boundary)

    half_pos_x = nearest_pos_x / 2.0 if nearest_pos_x is not None else max(max_x - cx, 0.0)
    half_neg_x = nearest_neg_x / 2.0 if nearest_neg_x is not None else max(cx - min_x, 0.0)
    half_pos_y = nearest_pos_y / 2.0 if nearest_pos_y is not None else max(max_y - cy, 0.0)
    half_neg_y = nearest_neg_y / 2.0 if nearest_neg_y is not None else max(cy - min_y, 0.0)

    width_x = half_pos_x + half_neg_x
    width_y = half_pos_y + half_neg_y
    trib_area = max(width_x * width_y, 0.0)

    # Position classification.
    missing_x = (nearest_pos_x is None) + (nearest_neg_x is None)
    missing_y = (nearest_pos_y is None) + (nearest_neg_y is None)
    on_edge = missing_x >= 1 or missing_y >= 1
    on_corner = missing_x >= 1 and missing_y >= 1

    if on_corner:
        position = "corner"
        K_LL = K_LL_CORNER_COLUMN
    elif on_edge:
        position = "edge"
        K_LL = K_LL_EDGE_COLUMN
    else:
        position = "interior"
        K_LL = K_LL_INTERIOR_COLUMN

    return ColumnTributary(
        column_id=column.get("id", ""),
        level_id=level_id,
        trib_area_sf=trib_area,
        K_LL=K_LL,
        position=position,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _euclid(beam: dict) -> float:
    dx = beam["end"]["x"] - beam["start"]["x"]
    dy = beam["end"]["y"] - beam["start"]["y"]
    return math.sqrt(dx * dx + dy * dy)


def _ranges_overlap(
    a1: float, a2: float, b1: float, b2: float, *, tol: float = 0.5
) -> bool:
    """1D range overlap with a small tolerance.

    Used to decide whether a parallel beam is "next to" the candidate
    along its span axis. Two beams whose spans don't overlap at all
    don't share tributary load.
    """
    a_lo, a_hi = (a1, a2) if a1 <= a2 else (a2, a1)
    b_lo, b_hi = (b1, b2) if b1 <= b2 else (b2, b1)
    return a_lo - tol <= b_hi and a_hi + tol >= b_lo


__all__ = [
    "BeamTributary",
    "ColumnTributary",
    "beam_direction",
    "compute_beam_tributary",
    "compute_column_tributary",
]
