"""Regular column-grid generation.

Given a building footprint, a (bay_x, bay_y) target, and an optional
offset, lay down a rectangular grid of candidate column positions.
Snap to existing :class:`GridLine` objects from the parsed geometry
when within :data:`GRID_SNAP_TOLERANCE`. Filter by floor polygon when
provided so we never generate columns outside the slab edge.

This module is deliberately stateless and takes raw dicts so it can be
unit-tested without spinning up the full Pydantic ParsedGeometry.
"""

from __future__ import annotations

from typing import Optional

from shapely.geometry import Point, Polygon

from packages.engine.column_generator.constants import (
    EDGE_TOLERANCE,
    GRID_SNAP_TOLERANCE,
)


def build_regular_grid(
    building_bounds: dict,
    bay_x: float,
    bay_y: float,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
    grid_lines: Optional[list[dict]] = None,
    floor_polygon: Optional[Polygon] = None,
) -> list[dict]:
    """Generate candidate column positions on a regular grid.

    Parameters
    ----------
    building_bounds : dict
        ``{"minX", "maxX", "minY", "maxY"}`` from ParsedGeometry.
    bay_x, bay_y : float
        Effective bay dimensions in feet (already strategy-adjusted).
    offset_x, offset_y : float
        Offset of the first column from the bottom-left corner.
    grid_lines : list of dict, optional
        Existing :class:`GridLine` records — used for snapping.
    floor_polygon : shapely Polygon, optional
        If provided, candidates that fall outside the polygon are
        dropped. Building-bound boxes are usually larger than the
        actual slab, so passing the slab polygon is the cleanest
        filter.

    Returns
    -------
    list of dict
        Each candidate is ``{"x", "y", "snapped_to_grid", "grid_label"}``.
        ``grid_label`` is empty here; the orchestrator assigns it after
        all the filters have run.
    """
    min_x = float(building_bounds["minX"])
    max_x = float(building_bounds["maxX"])
    min_y = float(building_bounds["minY"])
    max_y = float(building_bounds["maxY"])

    if max_x <= min_x or max_y <= min_y:
        return []
    if bay_x <= 0 or bay_y <= 0:
        return []

    # Stable, sorted axis-aligned coordinates from existing gridlines.
    x_grid = sorted({float(g["coordinate"]) for g in (grid_lines or []) if g.get("axis") == "x"})
    y_grid = sorted({float(g["coordinate"]) for g in (grid_lines or []) if g.get("axis") == "y"})

    xs = _axis_positions(min_x, max_x, bay_x, offset_x, x_grid)
    ys = _axis_positions(min_y, max_y, bay_y, offset_y, y_grid)

    candidates: list[dict] = []
    for y in ys:
        for x in xs:
            if floor_polygon is not None and not _point_inside_or_on(
                floor_polygon, x, y
            ):
                continue
            candidates.append(
                {
                    "x": x,
                    "y": y,
                    "snapped_to_grid": _snapped(x, y, x_grid, y_grid),
                    "grid_label": "",
                }
            )
    return candidates


def _axis_positions(
    lo: float,
    hi: float,
    step: float,
    offset: float,
    snap_targets: list[float],
) -> list[float]:
    """Generate coordinates on ``[lo, hi]`` at ``step`` intervals from
    ``lo + offset``, snapping to ``snap_targets`` within
    :data:`GRID_SNAP_TOLERANCE`.

    The first and last position are always inside ``[lo, hi]`` (no
    candidate column outside the building footprint). If the offset
    would push the first column past ``lo + step``, we still emit a
    column at ``lo`` so the perimeter is supported.
    """
    out: list[float] = []
    # Always include the lower edge so we have perimeter columns.
    edge = round(lo, 6)
    out.append(edge)

    start = lo + (offset % step if step else 0.0)
    if start <= lo + EDGE_TOLERANCE:
        start += step

    pos = start
    # Generate interior + upper-edge candidates. Cap iteration count
    # belt-and-braces to never loop unbounded if step is pathological.
    max_iters = int((hi - lo) / step) + 4 if step else 0
    iters = 0
    while pos < hi - EDGE_TOLERANCE and iters < max_iters:
        out.append(round(pos, 6))
        pos += step
        iters += 1

    out.append(round(hi, 6))

    # Snap each generated coordinate to the nearest gridline within
    # tolerance. Stable output: deduplicate then sort.
    snapped = []
    for v in out:
        snapped.append(_snap(v, snap_targets))
    deduped = sorted({round(v, 6) for v in snapped})
    return deduped


def _snap(value: float, targets: list[float]) -> float:
    if not targets:
        return value
    nearest = min(targets, key=lambda t: abs(t - value))
    if abs(nearest - value) <= GRID_SNAP_TOLERANCE:
        return float(nearest)
    return value


def _snapped(x: float, y: float, x_grid: list[float], y_grid: list[float]) -> bool:
    sx = any(abs(x - g) <= GRID_SNAP_TOLERANCE for g in x_grid) if x_grid else False
    sy = any(abs(y - g) <= GRID_SNAP_TOLERANCE for g in y_grid) if y_grid else False
    return sx and sy


def _point_inside_or_on(polygon: Polygon, x: float, y: float) -> bool:
    """``polygon.contains`` excludes the boundary; we want it included
    so columns sit exactly on the slab edge. Buffer by a hair for
    floating-point sloppiness."""
    if polygon is None or polygon.is_empty:
        return False
    pt = Point(x, y)
    if polygon.covers(pt):
        return True
    return polygon.distance(pt) <= EDGE_TOLERANCE


# ---------------------------------------------------------------------------
# Helpers used by the orchestrator (kept here so all "grid math" is
# co-located).
# ---------------------------------------------------------------------------


def reduce_interior(
    columns: list[dict],
    perimeter_xs: tuple[float, float],
    perimeter_ys: tuple[float, float],
    max_bay: float,
) -> tuple[list[dict], list[str]]:
    """Remove every other interior column.

    Interior = column not on the perimeter (at minX/maxX or minY/maxY).
    Removal is checkerboard-style based on the column's grid row index;
    if the resulting span across a row would exceed ``max_bay``, that
    column is kept (we'd rather have a few extra columns than blow the
    span limit).

    Returns ``(survivors, warnings)``.
    """
    if not columns:
        return columns, []

    min_x, max_x = perimeter_xs
    min_y, max_y = perimeter_ys

    def is_perimeter(col: dict) -> bool:
        return (
            abs(col["x"] - min_x) <= EDGE_TOLERANCE
            or abs(col["x"] - max_x) <= EDGE_TOLERANCE
            or abs(col["y"] - min_y) <= EDGE_TOLERANCE
            or abs(col["y"] - max_y) <= EDGE_TOLERANCE
        )

    # Group columns by row (y) for span-based gating.
    rows: dict[float, list[dict]] = {}
    for col in columns:
        rows.setdefault(round(col["y"], 3), []).append(col)
    for row in rows.values():
        row.sort(key=lambda c: c["x"])

    warnings: list[str] = []
    drop_ids: set[int] = set()  # by id() of dict — stable within this call

    # Row-by-row checkerboard-ish reduction.
    sorted_y_keys = sorted(rows.keys())
    for row_idx, y_key in enumerate(sorted_y_keys):
        row = rows[y_key]
        for col_idx, col in enumerate(row):
            if is_perimeter(col):
                continue
            if (row_idx + col_idx) % 2 != 1:
                continue  # keep this interior column
            # Tentatively remove. Check resulting span on this row.
            xs = [c["x"] for j, c in enumerate(row) if j != col_idx and id(c) not in drop_ids]
            xs.sort()
            ok = True
            for a, b in zip(xs, xs[1:]):
                if (b - a) > max_bay + EDGE_TOLERANCE:
                    ok = False
                    break
            if ok:
                drop_ids.add(id(col))
            else:
                warnings.append(
                    f"Interior reduction skipped column at ({col['x']:.1f}, {col['y']:.1f}): "
                    f"span would exceed max bay {max_bay:.1f} ft."
                )

    survivors = [c for c in columns if id(c) not in drop_ids]
    return survivors, warnings


__all__ = ["build_regular_grid", "reduce_interior"]
