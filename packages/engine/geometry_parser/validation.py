"""Cross-entity validation + confidence aggregation.

Runs as the final pipeline step. Behaviour:

* Append a structured warning string for every check that fails.
* Subtract from the affected category's confidence, proportional to the
  failure severity.
* Compute the overall confidence as a weighted average of category
  confidences, using :data:`CONFIDENCE_WEIGHTS`.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Iterable

from packages.engine.geometry_parser.constants import CONFIDENCE_CRITICAL, CONFIDENCE_WARNING
from packages.engine.geometry_parser.errors import ErrorCode
from packages.engine.geometry_parser.models import (
    BuildingBounds,
    Core,
    ExistingColumn,
    GridLine,
    Level,
    NoColumnZone,
    ParsedGeometry,
    Point2D,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Geometry helpers (kept minimal — Shapely is preferred when available
# but we don't take a hard dep just for validation, so the basic point /
# polygon checks are open-coded for determinism).
# ---------------------------------------------------------------------------


def _point_in_polygon(p: Point2D, polygon: list[Point2D]) -> bool:
    """Ray-casting point-in-polygon. Stable across platforms."""
    if len(polygon) < 3:
        return False
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i].x, polygon[i].y
        xj, yj = polygon[j].x, polygon[j].y
        intersects = ((yi > p.y) != (yj > p.y)) and (
            p.x < (xj - xi) * (p.y - yi) / ((yj - yi) or 1e-12) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def _bounds_contain(bounds: BuildingBounds, p: Point2D, slack: float = 1.0) -> bool:
    return (
        bounds.minX - slack <= p.x <= bounds.maxX + slack
        and bounds.minY - slack <= p.y <= bounds.maxY + slack
    )


def _polygon_is_valid(polygon: list[Point2D]) -> bool:
    return len(polygon) >= 3


def _format_warning(code: ErrorCode, message: str, **ctx: object) -> str:
    if ctx:
        ctx_str = " " + " ".join(f"{k}={v}" for k, v in sorted(ctx.items()))
    else:
        ctx_str = ""
    return f"[{code.value}] step=validation: {message}{ctx_str}"


# ---------------------------------------------------------------------------
# Per-category checks
# ---------------------------------------------------------------------------


def _check_levels(levels: list[Level]) -> tuple[float, list[str]]:
    if not levels:
        return 0.0, [_format_warning(ErrorCode.VALIDATION_FAIL, "no levels detected")]
    warnings: list[str] = []
    score = sum(l.confidence for l in levels) / len(levels)
    seen_elev: set[float] = set()
    for lvl in levels:
        if not _polygon_is_valid(lvl.planBoundary):
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "level has empty plan boundary",
                    level=lvl.id,
                )
            )
            score *= 0.9
        rounded = round(lvl.elevation, 2)
        if rounded in seen_elev:
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "duplicate level elevation",
                    level=lvl.id,
                )
            )
            score *= 0.9
        seen_elev.add(rounded)
    return max(0.0, min(1.0, score)), warnings


def _check_grids(grids: list[GridLine]) -> tuple[float, list[str]]:
    if not grids:
        return 0.0, [_format_warning(ErrorCode.VALIDATION_FAIL, "no grid lines detected")]
    warnings: list[str] = []
    score = sum(g.confidence for g in grids) / len(grids)
    by_axis: dict[str, list[GridLine]] = defaultdict(list)
    for g in grids:
        by_axis[g.axis].append(g)
    for axis, lines in by_axis.items():
        coords = sorted(l.coordinate for l in lines)
        for a, b in zip(coords, coords[1:], strict=False):
            if abs(a - b) < 0.01:
                warnings.append(
                    _format_warning(
                        ErrorCode.VALIDATION_FAIL,
                        "grid lines overlap within axis",
                        axis=axis,
                    )
                )
                score *= 0.9
                break
    labels: dict[str, set[str]] = defaultdict(set)
    for g in grids:
        if g.label in labels[g.axis]:
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "duplicate grid label",
                    axis=g.axis,
                    label=g.label,
                )
            )
            score *= 0.95
        labels[g.axis].add(g.label)
    return max(0.0, min(1.0, score)), warnings


def _check_cores(cores: list[Core], columns: list[ExistingColumn]) -> tuple[float, list[str]]:
    if not cores:
        return 1.0, []
    warnings: list[str] = []
    score = sum(c.confidence for c in cores) / len(cores)
    for core in cores:
        if not _polygon_is_valid(core.boundary):
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "core has invalid boundary",
                    core=core.id,
                )
            )
            score *= 0.8
        for col in columns:
            if _point_in_polygon(Point2D(x=col.x, y=col.y), core.boundary):
                warnings.append(
                    _format_warning(
                        ErrorCode.VALIDATION_FAIL,
                        "column lies inside core boundary",
                        core=core.id,
                        column=col.id,
                    )
                )
                score *= 0.95
                break
    return max(0.0, min(1.0, score)), warnings


def _check_columns(
    columns: list[ExistingColumn],
    levels: list[Level],
    bounds: BuildingBounds,
) -> tuple[float, list[str]]:
    if not columns:
        return 1.0, []
    warnings: list[str] = []
    level_ids = {l.id for l in levels}
    score = sum(c.confidence for c in columns) / len(columns)
    for col in columns:
        if col.startLevel not in level_ids:
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "column references unknown startLevel",
                    column=col.id,
                    level=col.startLevel,
                )
            )
            score *= 0.9
        if col.endLevel not in level_ids:
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "column references unknown endLevel",
                    column=col.id,
                    level=col.endLevel,
                )
            )
            score *= 0.9
        if not _bounds_contain(bounds, Point2D(x=col.x, y=col.y)):
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "column outside building bounds",
                    column=col.id,
                )
            )
            score *= 0.9
    return max(0.0, min(1.0, score)), warnings


def _check_no_column_zones(zones: list[NoColumnZone]) -> tuple[float, list[str]]:
    if not zones:
        return 1.0, []
    warnings: list[str] = []
    score = sum(z.confidence for z in zones) / len(zones)
    for zone in zones:
        if not _polygon_is_valid(zone.boundary):
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "no-column zone has invalid polygon",
                    zone=zone.id,
                )
            )
            score *= 0.8
    return max(0.0, min(1.0, score)), warnings


def _check_floor_plates(geometry: ParsedGeometry) -> tuple[float, list[str]]:
    if not geometry.levels:
        return 0.0, []
    warnings: list[str] = []
    plates_by_level = {p.levelId: p for p in geometry.floorPlates}
    score = 1.0
    for lvl in geometry.levels:
        plate = plates_by_level.get(lvl.id)
        if plate is None and not lvl.planBoundary:
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "level has neither plate nor planBoundary",
                    level=lvl.id,
                )
            )
            score *= 0.8
        elif plate and not plate.isConvex:
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "floor plate is non-convex (notches/cantilevers)",
                    level=lvl.id,
                )
            )
            score *= 0.95
    if geometry.floorPlates:
        score *= sum(p.confidence for p in geometry.floorPlates) / len(geometry.floorPlates)
    return max(0.0, min(1.0, score)), warnings


def _check_openings(geometry: ParsedGeometry) -> tuple[float, list[str]]:
    if not geometry.openings:
        return 1.0, []
    warnings: list[str] = []
    level_ids = {l.id for l in geometry.levels}
    score = sum(o.confidence for o in geometry.openings) / len(geometry.openings)
    for o in geometry.openings:
        if o.levelId not in level_ids:
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "opening references unknown level",
                    opening=o.id,
                    level=o.levelId,
                )
            )
            score *= 0.9
        if not _polygon_is_valid(o.boundary):
            warnings.append(
                _format_warning(
                    ErrorCode.VALIDATION_FAIL,
                    "opening has invalid polygon",
                    opening=o.id,
                )
            )
            score *= 0.8
    return max(0.0, min(1.0, score)), warnings


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def validate_and_score(
    geometry: ParsedGeometry,
    *,
    weights: dict[str, float],
) -> tuple[ParsedGeometry, list[str], float]:
    """Return (geometry, warnings, overall_confidence).

    The geometry is returned unmodified. The caller is responsible for
    persisting the warnings + confidence on the metadata.
    """
    all_warnings: list[str] = []
    scores: dict[str, float] = {}

    s, w = _check_levels(geometry.levels)
    scores["levels"] = s
    all_warnings.extend(w)

    s, w = _check_grids(geometry.gridLines)
    scores["gridLines"] = s
    all_warnings.extend(w)

    s, w = _check_cores(geometry.cores, geometry.existingColumns)
    scores["cores"] = s
    all_warnings.extend(w)

    s, w = _check_columns(geometry.existingColumns, geometry.levels, geometry.buildingBounds)
    scores["existingColumns"] = s
    all_warnings.extend(w)

    s, w = _check_no_column_zones(geometry.noColumnZones)
    scores["noColumnZones"] = s
    all_warnings.extend(w)

    s, w = _check_floor_plates(geometry)
    scores["floorPlates"] = s
    all_warnings.extend(w)

    s, w = _check_openings(geometry)
    scores["openings"] = s
    all_warnings.extend(w)

    overall = _weighted_overall(scores, weights)

    log.debug(
        "validation.summary",
        extra={
            "scores": scores,
            "overall_confidence": overall,
            "warning_count": len(all_warnings),
        },
    )

    if overall < CONFIDENCE_CRITICAL:
        all_warnings.append(
            _format_warning(
                ErrorCode.VALIDATION_FAIL,
                "overall confidence is critical; manual review required",
                overall=f"{overall:.2f}",
            )
        )
    elif overall < CONFIDENCE_WARNING:
        all_warnings.append(
            _format_warning(
                ErrorCode.VALIDATION_FAIL,
                "overall confidence below warning threshold",
                overall=f"{overall:.2f}",
            )
        )

    return geometry, all_warnings, overall


def _weighted_overall(scores: dict[str, float], weights: dict[str, float]) -> float:
    num = 0.0
    den = 0.0
    for cat, w in weights.items():
        s = scores.get(cat, 1.0)
        num += s * w
        den += w
    if den <= 0:
        return 0.0
    return max(0.0, min(1.0, num / den))


def collect_warnings(items: Iterable[str]) -> list[str]:
    """De-duplicate while preserving first-seen order."""
    seen: set[str] = set()
    out: list[str] = []
    for w in items:
        if w in seen:
            continue
        seen.add(w)
        out.append(w)
    return out
