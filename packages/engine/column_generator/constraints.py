"""Exclusion-zone enforcement, locked-column preservation, existing-
column merging.

Pure geometry — no Pydantic models in the signatures, just dicts. The
orchestrator hands these helpers raw candidate lists and gets back
filtered lists plus warnings.
"""

from __future__ import annotations

from typing import Iterable

from shapely.geometry import Point, Polygon
from shapely.ops import nearest_points

from packages.engine.column_generator.constants import (
    CORE_BUFFER,
    EDGE_TOLERANCE,
    NCZ_BUFFER,
    OPENING_BUFFER,
    STACK_TOLERANCE,
)


# ---------------------------------------------------------------------------
# Exclusion-zone construction
# ---------------------------------------------------------------------------


def build_exclusion_zones(
    cores: list[dict] | None,
    openings: list[dict] | None,
    no_column_zones: list[dict] | None,
) -> list[Polygon]:
    """Build buffered Shapely polygons for all exclusion zones.

    Buffers:
      * cores       → +CORE_BUFFER
      * openings    → +OPENING_BUFFER
      * no-column   → +NCZ_BUFFER (zero — hard boundary)

    Invalid / collapsed boundaries are silently skipped; the parser
    is the layer responsible for emitting warnings about malformed
    geometry.
    """
    out: list[Polygon] = []
    for c in cores or []:
        poly = _polygon_from_boundary(c.get("boundary"))
        if poly is None:
            continue
        buffered = poly.buffer(CORE_BUFFER, join_style=2)
        if not buffered.is_empty:
            out.append(buffered)
    for o in openings or []:
        poly = _polygon_from_boundary(o.get("boundary"))
        if poly is None:
            continue
        buffered = poly.buffer(OPENING_BUFFER, join_style=2)
        if not buffered.is_empty:
            out.append(buffered)
    for ncz in no_column_zones or []:
        poly = _polygon_from_boundary(ncz.get("boundary"))
        if poly is None:
            continue
        buffered = poly.buffer(NCZ_BUFFER, join_style=2) if NCZ_BUFFER else poly
        if not buffered.is_empty:
            out.append(buffered)
    return out


def _polygon_from_boundary(boundary: list | None) -> Polygon | None:
    if not boundary or len(boundary) < 3:
        return None
    pts: list[tuple[float, float]] = []
    for p in boundary:
        if isinstance(p, dict):
            x, y = p.get("x"), p.get("y")
        else:  # tuple/list
            try:
                x, y = p[0], p[1]
            except (IndexError, TypeError):
                continue
        if x is None or y is None:
            continue
        try:
            pts.append((float(x), float(y)))
        except (TypeError, ValueError):
            continue
    if len(pts) < 3:
        return None
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3:
        return None
    try:
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = poly.buffer(0)  # standard self-intersection fix
        if poly.is_empty or poly.area <= 1e-6:
            return None
        return poly
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Column–zone enforcement
# ---------------------------------------------------------------------------


def enforce_exclusions(
    columns: list[dict],
    exclusion_zones: list[Polygon],
    max_bay: float,
) -> tuple[list[dict], list[str]]:
    """Remove or shift columns that fall in exclusion zones.

    Strategy:
      1. If the column is outside every zone → keep.
      2. If it's inside a zone → try shifting it to the nearest point
         on the zone boundary plus a sliver. If the shift would not
         exceed half a max-bay, accept the shift. Otherwise drop the
         column and emit a warning.
    """
    if not exclusion_zones:
        return list(columns), []

    survivors: list[dict] = []
    warnings: list[str] = []

    for col in columns:
        pt = Point(col["x"], col["y"])
        offending = _zone_containing(pt, exclusion_zones)
        if offending is None:
            survivors.append(col)
            continue

        shifted = _shift_to_boundary(pt, offending, exclusion_zones)
        if shifted is None:
            warnings.append(
                f"Column at ({col['x']:.1f}, {col['y']:.1f}) dropped: "
                "no valid position outside exclusion zone."
            )
            continue

        dx = shifted.x - col["x"]
        dy = shifted.y - col["y"]
        if (dx * dx + dy * dy) ** 0.5 > max_bay * 0.5:
            warnings.append(
                f"Column at ({col['x']:.1f}, {col['y']:.1f}) dropped: "
                f"shift to {shifted.x:.1f}, {shifted.y:.1f} exceeds half max bay."
            )
            continue

        new_col = dict(col)
        new_col["x"] = round(shifted.x, 6)
        new_col["y"] = round(shifted.y, 6)
        new_col["snapped_to_grid"] = False
        survivors.append(new_col)

    # De-dup any columns that got shifted onto the same point.
    survivors = _dedup_by_position(survivors)
    return survivors, warnings


def _zone_containing(pt: Point, zones: Iterable[Polygon]) -> Polygon | None:
    for zone in zones:
        if zone.contains(pt):
            return zone
    return None


def _shift_to_boundary(
    pt: Point, zone: Polygon, all_zones: list[Polygon]
) -> Point | None:
    """Find the nearest valid point on the zone's exterior, plus a
    half-foot sliver outward, that is not inside any other zone.
    Returns None if no such point exists.
    """
    boundary = zone.exterior
    if boundary is None or boundary.is_empty:
        return None
    p_on_zone = nearest_points(boundary, pt)[0]

    # Push outward by EDGE_TOLERANCE * 4 (~1 ft) along the (zone-centroid → boundary) direction.
    centroid = zone.centroid
    dx = p_on_zone.x - centroid.x
    dy = p_on_zone.y - centroid.y
    norm = (dx * dx + dy * dy) ** 0.5
    if norm < 1e-9:
        return None
    push = max(EDGE_TOLERANCE * 4, 0.5)
    candidate = Point(
        p_on_zone.x + (dx / norm) * push,
        p_on_zone.y + (dy / norm) * push,
    )
    if any(z.contains(candidate) for z in all_zones):
        return None
    return candidate


# ---------------------------------------------------------------------------
# Locked column preservation
# ---------------------------------------------------------------------------


def preserve_locked_columns(
    columns: list[dict],
    existing_columns: list[dict],
    locked_ids: list[str],
    exclusion_zones: list[Polygon],
) -> tuple[list[dict], list[str]]:
    """Insert locked existing columns at their exact positions.

    Locked columns are sacred: they appear in the output at the
    coordinates the engineer froze, even if that position now lies
    inside an exclusion zone (in which case we emit a warning but keep
    the column — the engineer locked it deliberately).

    If a generated column already sits on top of a locked position
    (within :data:`STACK_TOLERANCE`) it is removed in favour of the
    locked one.
    """
    if not locked_ids:
        return list(columns), []

    by_id = {c["id"]: c for c in existing_columns}
    survivors = list(columns)
    warnings: list[str] = []

    for lid in locked_ids:
        ex = by_id.get(lid)
        if ex is None:
            warnings.append(f"Locked column id '{lid}' not found in existing columns.")
            continue

        survivors = [
            c
            for c in survivors
            if not _within_tolerance(c, ex, STACK_TOLERANCE)
        ]

        locked_col = {
            "x": float(ex["x"]),
            "y": float(ex["y"]),
            "id": ex["id"],
            "start_level": ex.get("startLevel") or ex.get("start_level"),
            "end_level": ex.get("endLevel") or ex.get("end_level"),
            "grid_label": ex.get("gridLabel") or "",
            "snapped_to_grid": ex.get("gridAligned", True),
            "source": "locked",
            "locked": True,
        }
        survivors.append(locked_col)

        # Warn if it lives inside an exclusion zone.
        pt = Point(locked_col["x"], locked_col["y"])
        if any(z.contains(pt) for z in exclusion_zones):
            warnings.append(
                f"Locked column {lid} is inside an exclusion zone — kept by engineer override."
            )

    return survivors, warnings


def merge_existing_columns(
    generated_columns: list[dict],
    existing_columns: list[dict],
    locked_ids: list[str],
    tolerance: float = STACK_TOLERANCE,
) -> list[dict]:
    """Merge non-locked existing columns into the generated grid.

    For each non-locked existing column:
      * If a generated column sits within ``tolerance`` of it, drop the
        generated one and keep the existing one (it carries metadata
        the engineer cares about: ``size``, ``gridLabel``, etc.).
      * Otherwise, append the existing column as-is.
    """
    locked_set = set(locked_ids or [])
    survivors = list(generated_columns)
    out_existing: list[dict] = []

    for ex in existing_columns:
        if ex["id"] in locked_set:
            continue  # already handled by preserve_locked_columns
        ex_norm = {
            "x": float(ex["x"]),
            "y": float(ex["y"]),
            "id": ex["id"],
            "start_level": ex.get("startLevel") or ex.get("start_level"),
            "end_level": ex.get("endLevel") or ex.get("end_level"),
            "grid_label": ex.get("gridLabel") or "",
            "snapped_to_grid": ex.get("gridAligned", True),
            "source": "existing",
            "locked": False,
        }
        # Drop colliding generated columns.
        survivors = [
            c
            for c in survivors
            if not (
                c.get("source") not in ("locked", "existing")
                and _within_tolerance(c, ex_norm, tolerance)
            )
        ]
        out_existing.append(ex_norm)

    return survivors + out_existing


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _within_tolerance(a: dict, b: dict, tol: float) -> bool:
    return abs(a["x"] - b["x"]) <= tol and abs(a["y"] - b["y"]) <= tol


def _dedup_by_position(columns: list[dict], tol: float = STACK_TOLERANCE) -> list[dict]:
    """Drop duplicates within ``tol``. Stable: earlier entries win."""
    out: list[dict] = []
    for col in columns:
        if any(_within_tolerance(col, kept, tol) for kept in out):
            continue
        out.append(col)
    return out


__all__ = [
    "build_exclusion_zones",
    "enforce_exclusions",
    "merge_existing_columns",
    "preserve_locked_columns",
]
