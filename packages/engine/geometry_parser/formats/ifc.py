"""IFC extractor.

This is the gold-path. IFC carries semantic structural data — every
entity self-identifies — so the parser is deterministic and high
confidence.

The implementation:

1. Opens the file with :mod:`ifcopenshell`.
2. Iterates ``IfcBuildingStorey`` for levels and floor plate boundaries
   (via the union of all ``IfcSlab`` footprints).
3. Reads ``IfcGrid`` for grid lines, falling back to inference from
   ``IfcColumn`` positions if absent.
4. Reads ``IfcColumn`` for existing columns, reconciling each against
   the grid.
5. Reads ``IfcSpace``, ``IfcElevator``, ``IfcStairFlight`` for cores.
6. Computes a building-centroid origin transform and re-bases all
   coordinates to that local frame.

All operations are wrapped in step-level try/except so a failure in,
say, "openings" never wipes out the levels and grids that succeeded
upstream.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from packages.engine.geometry_parser.constants import (
    FLAG_TOLERANCE_FT,
    PARSER_VERSION,
    SCHEMA_VERSION,
    SNAP_TOLERANCE_FT,
)
from packages.engine.geometry_parser.errors import ErrorCode, ParserError, StepFailure
from packages.engine.geometry_parser.ids import column_id, grid_id, level_id, opening_id, zone_id
from packages.engine.geometry_parser.inference.core_inference import (
    CoreCandidate,
    infer_cores,
)
from packages.engine.geometry_parser.inference.grid_inference import (
    infer_grids_from_columns,
    reconcile_columns_to_grid,
)
from packages.engine.geometry_parser.models import (
    BuildingBounds,
    Core,
    ExistingColumn,
    FloorPlate,
    GridLine,
    Level,
    NoColumnZone,
    Opening,
    OriginTransform,
    ParseMetadata,
    ParsedGeometry,
    Point2D,
)
from packages.engine.geometry_parser.progress import ProgressTracker

log = logging.getLogger(__name__)

_ifcopenshell_extra_path_done = False


def _bootstrap_ifcopenshell_search_path() -> None:
    """Prepend optional dirs so :mod:`ifcopenshell` resolves.

    Official install is ``pip install ifcopenshell`` (see IfcOpenShell-Python
    installation docs). On Windows, a downloaded wheel is sometimes
    unpacked manually; the directory that *contains* the ``ifcopenshell``
    package folder must be on ``sys.path``. Set
    ``CIVILAGENT_IFCOPENSHELL_EXTRAPATH`` to one or more such directories
    (``os.pathsep``-separated, e.g. ``;`` on Windows).
    """
    global _ifcopenshell_extra_path_done
    if _ifcopenshell_extra_path_done:
        return
    _ifcopenshell_extra_path_done = True
    raw = (os.environ.get("CIVILAGENT_IFCOPENSHELL_EXTRAPATH") or "").strip()
    if not raw:
        return
    for part in raw.split(os.pathsep):
        p = part.strip()
        if not p or not os.path.isdir(p):
            continue
        if p not in sys.path:
            sys.path.insert(0, p)
            log.debug("ifcopenshell_extra_path", extra={"path": p})


# ---------------------------------------------------------------------------
# Step runner — every extractor step uses this to guarantee isolation.
# ---------------------------------------------------------------------------


async def _run_step(
    *,
    name: str,
    tracker: ProgressTracker,
    completed: list[str],
    failures: list[StepFailure],
    warnings: list[str],
    fn: Callable[[], Any],
    on_failure_default: Any,
    detail_format: Callable[[Any], str],
    error_code: ErrorCode,
    cpu_bound: bool = True,
) -> Any:
    """Run an extractor step with isolation + cooperative cancellation.

    ``cpu_bound=True`` (default) runs ``fn`` via :func:`asyncio.to_thread`
    so the parent ``asyncio.wait_for`` can deliver cancellation even when
    the extractor is mid-CPU-burn (large IFC slab unioning, ezdxf
    iteration, etc). The thread keeps running to completion in the
    background — we don't kill it — but the orchestrator returns a
    partial result on time, which is the production-correct behaviour.
    """
    await tracker.start_step(name, detail=f"Extracting {name}…")
    try:
        if cpu_bound:
            result = await asyncio.to_thread(fn)
        else:
            result = fn()
        completed.append(name)
        await tracker.complete_step(name, detail=detail_format(result))
        return result
    except asyncio.CancelledError:
        # Propagate so the orchestrator's wait_for translates this into
        # the timeout / partial path. Don't try to publish here — once
        # cancellation is delivered, awaiting the sink could re-raise.
        # The orchestrator's terminal event will mark the remaining
        # substeps correctly.
        raise
    except Exception as exc:  # noqa: BLE001 — every step must be isolated
        log.exception("ifc.step_failed", extra={"step": name})
        failure = StepFailure(
            step=name,
            code=error_code,
            message=str(exc) or exc.__class__.__name__,
        )
        failures.append(failure)
        warnings.append(failure.to_warning())
        await tracker.fail_step(name, detail=str(exc), error_code=error_code.value)
        return on_failure_default


# ---------------------------------------------------------------------------
# IfcOpenShell loader (lazy)
# ---------------------------------------------------------------------------


def _open_ifc(path: str) -> Any:
    _bootstrap_ifcopenshell_search_path()
    try:
        import ifcopenshell  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise ParserError(
            code=ErrorCode.IFC_GEOMETRY_FAIL,
            message="ifcopenshell is not installed in this environment",
            step="init",
        ) from exc
    try:
        return ifcopenshell.open(path)
    except Exception as exc:
        raise ParserError(
            code=ErrorCode.IFC_GEOMETRY_FAIL,
            message=f"Failed to open IFC: {exc}",
            step="init",
            context={"path": path},
        ) from exc


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _placement_xy(entity: Any) -> tuple[float, float]:
    """Best-effort extraction of (x, y) from an IfcLocalPlacement chain.

    For columns, IfcOpenShell exposes an :func:`get_placement` matrix
    helper. We tolerate older IFC shapes by walking the chain.
    """
    placement = getattr(entity, "ObjectPlacement", None)
    if placement is None:
        return 0.0, 0.0
    try:
        from ifcopenshell.util.placement import get_local_placement  # type: ignore

        m = get_local_placement(placement)
        return _safe_float(m[0][3]), _safe_float(m[1][3])
    except Exception:
        return 0.0, 0.0


def _slab_footprint(slab: Any) -> list[Point2D]:
    """Return slab footprint in local IFC coordinates.

    Falls back to an empty list on failure — caller must handle.
    """
    try:
        from ifcopenshell import geom  # type: ignore
        from ifcopenshell.util.shape import get_footprint_area  # noqa: F401  # type: ignore
    except Exception:
        return []
    try:
        settings = geom.settings()
        settings.set("use-world-coords", True)
        shape = geom.create_shape(settings, slab)
        verts = shape.geometry.verts
        # verts is a flat list [x0,y0,z0,x1,...]; project to XY and dedupe.
        seen: set[tuple[float, float]] = set()
        ordered: list[Point2D] = []
        for i in range(0, len(verts), 3):
            x, y = round(verts[i], 4), round(verts[i + 1], 4)
            key = (x, y)
            if key in seen:
                continue
            seen.add(key)
            ordered.append(Point2D(x=x, y=y))
        return _convex_hull(ordered)
    except Exception:
        return []


def _convex_hull(points: list[Point2D]) -> list[Point2D]:
    """Andrew's monotone-chain hull. Stable + no Shapely dep here."""
    pts = sorted({(round(p.x, 4), round(p.y, 4)) for p in points})
    if len(pts) <= 2:
        return [Point2D(x=x, y=y) for x, y in pts]

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    return [Point2D(x=x, y=y) for x, y in hull]


def _polygon_area(pts: list[Point2D]) -> float:
    if len(pts) < 3:
        return 0.0
    a = 0.0
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
    return abs(a) / 2.0


def _is_convex(pts: list[Point2D]) -> bool:
    if len(pts) < 4:
        return True
    sign = 0
    n = len(pts)
    for i in range(n):
        dx1 = pts[(i + 1) % n].x - pts[i].x
        dy1 = pts[(i + 1) % n].y - pts[i].y
        dx2 = pts[(i + 2) % n].x - pts[(i + 1) % n].x
        dy2 = pts[(i + 2) % n].y - pts[(i + 1) % n].y
        cross = dx1 * dy2 - dy1 * dx2
        if cross != 0:
            new_sign = 1 if cross > 0 else -1
            if sign == 0:
                sign = new_sign
            elif sign != new_sign:
                return False
    return True


# ---------------------------------------------------------------------------
# Step implementations (sync — async wrapper handled by _run_step caller)
# ---------------------------------------------------------------------------


def _extract_levels(model: Any) -> list[Level]:
    storeys = sorted(
        model.by_type("IfcBuildingStorey"),
        key=lambda s: _safe_float(getattr(s, "Elevation", 0.0)),
    )
    if not storeys:
        return []
    out: list[Level] = []
    for i, st in enumerate(storeys):
        elevation = _safe_float(getattr(st, "Elevation", 0.0))
        if i + 1 < len(storeys):
            height = _safe_float(getattr(storeys[i + 1], "Elevation", 0.0)) - elevation
        else:
            height = out[-1].height if out else 14.0
        name = getattr(st, "Name", None) or f"Level {i + 1}"
        out.append(
            Level(
                id=level_id(name, elevation),
                name=name,
                elevation=round(elevation, 3),
                height=round(max(height, 0.0), 3),
                planBoundary=[],
                confidence=1.0,
                source="ifc",
            )
        )
    return out


def _extract_floor_plates(
    model: Any, levels: list[Level], columns: list[ExistingColumn]
) -> tuple[list[Level], list[FloorPlate]]:
    """Plan boundary per level: slab union, then column bbox, walls, spaces.

    The frontend 3D view requires at least one usable ``planBoundary`` per
    building; without slabs we synthesize a footprint so the canvas is not
    blank.
    """
    by_storey: dict[str, list[Any]] = {}
    for slab in model.by_type("IfcSlab"):
        storey = _slab_storey(slab)
        if storey is None:
            continue
        key = _storey_level_id(storey)
        by_storey.setdefault(key, []).append(slab)

    plates: list[FloorPlate] = []
    updated_levels: list[Level] = []

    def _emit_level(lvl: Level, boundary: list[Point2D], source: str, conf: float, note: str) -> None:
        hull = _convex_hull(boundary)
        plates.append(
            FloorPlate(
                levelId=lvl.id,
                boundary=boundary,
                convexHull=hull,
                isConvex=_is_convex(boundary),
                area=_polygon_area(boundary),
                confidence=conf,
            )
        )
        updated_levels.append(
            lvl.model_copy(
                update={
                    "planBoundary": boundary,
                    "planBoundarySource": source,
                    "confidence": min(lvl.confidence, conf),
                    "rationale": note,
                    "renderable": True,
                }
            )
        )

    for lvl in levels:
        slabs = by_storey.get(lvl.id, [])
        boundary: list[Point2D] = []
        source = "slab_footprint"
        conf = 1.0
        note: Optional[str] = None

        if slabs:
            all_pts: list[Point2D] = []
            for s in slabs:
                all_pts.extend(_slab_footprint(s))
            boundary = _convex_hull(all_pts) if all_pts else []

        if not boundary:
            col_pts = _column_points_for_level(columns, lvl.id)
            rect = _padded_bbox_polygon(col_pts, pad=6.0)
            if rect:
                boundary = rect
                source = "columns_bbox"
                conf = 0.82
                note = "Inferred from IfcColumn positions on this storey (no slab footprint)."

        if not boundary:
            wall_pts = _points_from_walls_on_level(model, lvl.id)
            if wall_pts:
                boundary = _convex_hull(wall_pts)
                source = "walls_bbox"
                conf = 0.75
                note = "Inferred from IfcWall geometry/placements on this storey."

        if not boundary:
            space_pts = _points_from_spaces_on_level(model, lvl.id)
            if space_pts:
                boundary = _convex_hull(space_pts)
                source = "spaces_bbox"
                conf = 0.72
                note = "Inferred from IfcSpace footprints on this storey."

        if boundary:
            if len(boundary) < 3:
                padded = _padded_bbox_polygon(boundary, pad=10.0)
                if padded:
                    boundary = padded
            if len(boundary) >= 3:
                _emit_level(lvl, boundary, source, conf, note or "")
                continue

        updated_levels.append(
            lvl.model_copy(
                update={"planBoundarySource": "missing", "renderable": False}
            )
        )

    # Last resort: one shared bbox from all columns for any still-empty level.
    still = [L for L in updated_levels if not L.planBoundary]
    if still and columns:
        all_pts = [Point2D(x=c.x, y=c.y) for c in columns]
        global_rect = _padded_bbox_polygon(all_pts, pad=12.0)
        if global_rect:
            new_levels: list[Level] = []
            for L in updated_levels:
                if L.planBoundary:
                    new_levels.append(L)
                    continue
                shared_note = (
                    "Synthetic footprint from all column positions — "
                    "no storey-specific slab/wall/space boundary."
                )
                hull = _convex_hull(global_rect)
                plates.append(
                    FloorPlate(
                        levelId=L.id,
                        boundary=global_rect,
                        convexHull=hull,
                        isConvex=_is_convex(global_rect),
                        area=_polygon_area(global_rect),
                        confidence=0.55,
                    )
                )
                new_levels.append(
                    L.model_copy(
                        update={
                            "planBoundary": global_rect,
                            "planBoundarySource": "elements_bbox",
                            "confidence": min(L.confidence, 0.55),
                            "rationale": shared_note,
                            "renderable": True,
                        }
                    )
                )
            updated_levels = new_levels

    return updated_levels, plates


def _element_storey(entity: Any) -> Any:
    """IfcBuildingStorey from ``ContainedInStructure``, if any."""
    rels = getattr(entity, "ContainedInStructure", None) or []
    for r in rels:
        relating = getattr(r, "RelatingStructure", None)
        if relating is not None and relating.is_a("IfcBuildingStorey"):
            return relating
    return None


def _slab_storey(slab: Any) -> Any:
    return _element_storey(slab)


def _storey_level_id(storey: Any) -> str:
    name = getattr(storey, "Name", None) or "Level"
    elev = _safe_float(getattr(storey, "Elevation", 0.0))
    return level_id(name, elev)


def _padded_bbox_polygon(pts: list[Point2D], pad: float) -> list[Point2D]:
    """Axis-aligned rectangle hull with margin (feet)."""
    if not pts:
        return []
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    minx, maxx = min(xs) - pad, max(xs) + pad
    miny, maxy = min(ys) - pad, max(ys) + pad
    return [
        Point2D(x=minx, y=miny),
        Point2D(x=maxx, y=miny),
        Point2D(x=maxx, y=maxy),
        Point2D(x=minx, y=maxy),
    ]


def _column_points_for_level(columns: list[ExistingColumn], level_id: str) -> list[Point2D]:
    return [
        Point2D(x=c.x, y=c.y)
        for c in columns
        if c.startLevel == level_id
    ]


def _wall_sample_points(wall: Any) -> list[Point2D]:
    """Footprint from tessellation when possible; else placement + small stub."""
    fp = _slab_footprint(wall)
    if len(fp) >= 3:
        return fp
    x, y = _placement_xy(wall)
    d = 2.0
    return [
        Point2D(x=x - d, y=y - d),
        Point2D(x=x + d, y=y - d),
        Point2D(x=x + d, y=y + d),
        Point2D(x=x - d, y=y + d),
    ]


def _space_sample_points(space: Any) -> list[Point2D]:
    fp: list[Point2D] = []
    try:
        from ifcopenshell import geom  # type: ignore

        settings = geom.settings()
        settings.set("use-world-coords", True)
        shape = geom.create_shape(settings, space)
        verts = shape.geometry.verts
        seen: set[tuple[float, float]] = set()
        for i in range(0, len(verts), 3):
            x, y = round(verts[i], 4), round(verts[i + 1], 4)
            key = (x, y)
            if key in seen:
                continue
            seen.add(key)
            fp.append(Point2D(x=x, y=y))
    except Exception:
        fp = []
    if len(fp) >= 3:
        return fp
    x, y = _placement_xy(space)
    d = 5.0
    return [
        Point2D(x=x - d, y=y - d),
        Point2D(x=x + d, y=y - d),
        Point2D(x=x + d, y=y + d),
        Point2D(x=x - d, y=y + d),
    ]


def _points_from_walls_on_level(model: Any, level_id: str) -> list[Point2D]:
    pts: list[Point2D] = []
    for w in model.by_type("IfcWall"):
        st = _element_storey(w)
        if st is None or _storey_level_id(st) != level_id:
            continue
        pts.extend(_wall_sample_points(w))
    return pts


def _points_from_spaces_on_level(model: Any, level_id: str) -> list[Point2D]:
    pts: list[Point2D] = []
    for sp in model.by_type("IfcSpace"):
        st = _element_storey(sp)
        if st is None or _storey_level_id(st) != level_id:
            continue
        pts.extend(_space_sample_points(sp))
    return pts


def _extract_grids(model: Any, columns: list[ExistingColumn]) -> tuple[list[GridLine], bool]:
    """Return (grids, was_inferred)."""
    grids = model.by_type("IfcGrid")
    if grids:
        out: list[GridLine] = []
        for grid in grids:
            for axis_name, axes_attr in (("x", "UAxes"), ("y", "VAxes")):
                axes = getattr(grid, axes_attr, []) or []
                for ax in axes:
                    label = getattr(ax, "AxisTag", None) or ""
                    coord = _axis_coordinate(ax)
                    if coord is None:
                        continue
                    out.append(
                        GridLine(
                            id=grid_id(axis_name, label, coord),
                            axis=axis_name,  # type: ignore[arg-type]
                            label=label,
                            coordinate=round(coord, 3),
                            confidence=1.0,
                            source="ifc",
                        )
                    )
        if out:
            return out, False

    # Fallback — infer from column positions.
    return infer_grids_from_columns(columns), True


def _axis_coordinate(ax: Any) -> Optional[float]:
    """Best-effort coordinate extraction from an IfcGridAxis."""
    curve = getattr(ax, "AxisCurve", None)
    if curve is None:
        return None
    try:
        pts = getattr(curve, "Points", None) or []
        if pts:
            coords = getattr(pts[0], "Coordinates", None)
            if coords:
                return _safe_float(coords[0])
        edge = getattr(curve, "EdgeStart", None)
        if edge is not None:
            coords = getattr(edge, "Coordinates", None)
            if coords:
                return _safe_float(coords[0])
    except Exception:
        return None
    return None


def _extract_columns(model: Any, levels: list[Level]) -> list[ExistingColumn]:
    cols = model.by_type("IfcColumn")
    if not cols:
        return []
    levels_sorted = sorted(levels, key=lambda l: l.elevation)
    out: list[ExistingColumn] = []
    for c in cols:
        x, y = _placement_xy(c)
        start_level = _column_storey_id(c, levels_sorted)
        end_level = _column_top_level_id(c, levels_sorted, start_level)
        out.append(
            ExistingColumn(
                id=column_id(x, y, start_level),
                x=round(x, 4),
                y=round(y, 4),
                startLevel=start_level,
                endLevel=end_level,
                size=_pset_value(c, "Pset_ColumnCommon", "Reference"),
                material=_material_name(c),
                gridAligned=True,
                confidence=1.0,
                source="ifc",
            )
        )
    return out


def _column_storey_id(col: Any, levels: list[Level]) -> str:
    rels = getattr(col, "ContainedInStructure", None) or []
    for r in rels:
        relating = getattr(r, "RelatingStructure", None)
        if relating is not None and relating.is_a("IfcBuildingStorey"):
            name = getattr(relating, "Name", None) or "Level"
            elev = _safe_float(getattr(relating, "Elevation", 0.0))
            return level_id(name, elev)
    return levels[0].id if levels else "lvl_unknown"


def _column_top_level_id(col: Any, levels: list[Level], start_level: str) -> str:
    if not levels:
        return start_level
    indices = {lvl.id: i for i, lvl in enumerate(levels)}
    si = indices.get(start_level, 0)
    if si + 1 < len(levels):
        return levels[si + 1].id
    return start_level


def _pset_value(entity: Any, pset_name: str, prop_name: str) -> Optional[str]:
    try:
        from ifcopenshell.util.element import get_psets  # type: ignore

        psets = get_psets(entity)
        return psets.get(pset_name, {}).get(prop_name)
    except Exception:
        return None


def _material_name(entity: Any) -> Optional[str]:
    try:
        from ifcopenshell.util.element import get_material  # type: ignore

        m = get_material(entity)
        if m is None:
            return None
        return getattr(m, "Name", None)
    except Exception:
        return None


def _extract_cores(model: Any, levels: list[Level]) -> list[Core]:
    candidates: list[CoreCandidate] = []

    for stair in model.by_type("IfcStairFlight") + model.by_type("IfcStair"):
        x, y = _placement_xy(stair)
        candidates.append(
            CoreCandidate(
                x=round(x, 4),
                y=round(y, 4),
                type="stair",
                width=10.0,
                depth=20.0,
                level_ids=tuple(l.id for l in levels),
            )
        )

    for elev in model.by_type("IfcTransportElement"):
        if (getattr(elev, "PredefinedType", "") or "").upper() == "ELEVATOR":
            x, y = _placement_xy(elev)
            candidates.append(
                CoreCandidate(
                    x=round(x, 4),
                    y=round(y, 4),
                    type="elevator",
                    width=8.0,
                    depth=8.0,
                    level_ids=tuple(l.id for l in levels),
                )
            )

    for space in model.by_type("IfcSpace"):
        long_name = (getattr(space, "LongName", "") or "").lower()
        if any(k in long_name for k in ("shaft", "mechanical", "elec", "service")):
            x, y = _placement_xy(space)
            candidates.append(
                CoreCandidate(
                    x=round(x, 4),
                    y=round(y, 4),
                    type="service",
                    width=8.0,
                    depth=8.0,
                    level_ids=tuple(l.id for l in levels),
                )
            )

    if not candidates:
        return []
    return infer_cores(candidates, source="ifc", confidence=0.9)


def _extract_openings(model: Any, levels: list[Level]) -> list[Opening]:
    out: list[Opening] = []
    for op in model.by_type("IfcOpeningElement"):
        x, y = _placement_xy(op)
        level_obj = levels[0] if levels else None
        if level_obj is None:
            continue
        boundary = [
            Point2D(x=x - 2, y=y - 2),
            Point2D(x=x + 2, y=y - 2),
            Point2D(x=x + 2, y=y + 2),
            Point2D(x=x - 2, y=y + 2),
        ]
        out.append(
            Opening(
                id=opening_id(level_obj.id, x, y),
                levelId=level_obj.id,
                boundary=boundary,
                type="other",
                confidence=0.8,
                source="ifc",
            )
        )
    return out


def _extract_no_column_zones(model: Any, levels: list[Level]) -> list[NoColumnZone]:
    out: list[NoColumnZone] = []
    if not levels:
        return out
    for sp in model.by_type("IfcSpace"):
        long_name = (getattr(sp, "LongName", "") or "").lower()
        if "lobby" not in long_name and "atrium" not in long_name:
            continue
        x, y = _placement_xy(sp)
        boundary = [
            Point2D(x=x - 15, y=y - 15),
            Point2D(x=x + 15, y=y - 15),
            Point2D(x=x + 15, y=y + 15),
            Point2D(x=x - 15, y=y + 15),
        ]
        name = getattr(sp, "Name", None) or "no-column zone"
        out.append(
            NoColumnZone(
                id=zone_id(name, levels[0].id),
                name=name,
                boundary=boundary,
                reason=f"Detected from IfcSpace LongName='{long_name}'",
                source="ifc",
                confidence=0.9,
                levelIds=[levels[0].id],
            )
        )
    return out


# ---------------------------------------------------------------------------
# Local-frame transformation
# ---------------------------------------------------------------------------


def _local_origin(columns: list[ExistingColumn], plates: list[FloorPlate]) -> tuple[float, float]:
    if columns:
        cx = sum(c.x for c in columns) / len(columns)
        cy = sum(c.y for c in columns) / len(columns)
        return round(cx, 4), round(cy, 4)
    if plates:
        all_pts = [p for plate in plates for p in plate.boundary]
        if all_pts:
            cx = sum(p.x for p in all_pts) / len(all_pts)
            cy = sum(p.y for p in all_pts) / len(all_pts)
            return round(cx, 4), round(cy, 4)
    return 0.0, 0.0


def _shift_xy(point: Point2D, ox: float, oy: float) -> Point2D:
    return Point2D(x=round(point.x - ox, 4), y=round(point.y - oy, 4))


def _rebase(
    geometry_kwargs: dict[str, Any], ox: float, oy: float
) -> dict[str, Any]:
    levels = [
        l.model_copy(update={"planBoundary": [_shift_xy(p, ox, oy) for p in l.planBoundary]})
        for l in geometry_kwargs["levels"]
    ]
    grids = [
        g.model_copy(update={"coordinate": round(g.coordinate - (ox if g.axis == "x" else oy), 4)})
        for g in geometry_kwargs["gridLines"]
    ]
    cores = [
        c.model_copy(update={"boundary": [_shift_xy(p, ox, oy) for p in c.boundary]})
        for c in geometry_kwargs["cores"]
    ]
    openings = [
        o.model_copy(update={"boundary": [_shift_xy(p, ox, oy) for p in o.boundary]})
        for o in geometry_kwargs["openings"]
    ]
    columns = [
        c.model_copy(update={"x": round(c.x - ox, 4), "y": round(c.y - oy, 4)})
        for c in geometry_kwargs["existingColumns"]
    ]
    zones = [
        z.model_copy(update={"boundary": [_shift_xy(p, ox, oy) for p in z.boundary]})
        for z in geometry_kwargs["noColumnZones"]
    ]
    plates = [
        p.model_copy(
            update={
                "boundary": [_shift_xy(pt, ox, oy) for pt in p.boundary],
                "convexHull": [_shift_xy(pt, ox, oy) for pt in p.convexHull],
            }
        )
        for p in geometry_kwargs["floorPlates"]
    ]
    return {
        "levels": levels,
        "gridLines": grids,
        "cores": cores,
        "openings": openings,
        "existingColumns": columns,
        "noColumnZones": zones,
        "floorPlates": plates,
    }


def _building_bounds(parts: dict[str, Any]) -> BuildingBounds:
    xs: list[float] = []
    ys: list[float] = []
    for plate in parts["floorPlates"]:
        for p in plate.boundary:
            xs.append(p.x)
            ys.append(p.y)
    for col in parts["existingColumns"]:
        xs.append(col.x)
        ys.append(col.y)
    if not xs or not ys:
        return BuildingBounds(minX=0.0, minY=0.0, maxX=0.0, maxY=0.0)
    return BuildingBounds(
        minX=round(min(xs), 4),
        minY=round(min(ys), 4),
        maxX=round(max(xs), 4),
        maxY=round(max(ys), 4),
    )


def _write_ifc_parse_debug(
    file_path: str,
    model: Any,
    parts: dict[str, Any],
    ox: float,
    oy: float,
    warnings: list[str],
) -> None:
    """Log + optionally write ``parsed_geometry_debug.json`` beside the IFC."""
    levels: list[Level] = parts["levels"]
    bounds: BuildingBounds = parts["buildingBounds"]
    lv_pb = sum(1 for L in levels if len(L.planBoundary) >= 3)
    summary = {
        "source_format": "ifc",
        "levels_count": len(levels),
        "storeys_count": len(model.by_type("IfcBuildingStorey")),
        "walls_count": len(model.by_type("IfcWall")),
        "columns_count": len(parts["existingColumns"]),
        "slabs_count": len(model.by_type("IfcSlab")),
        "spaces_count": len(model.by_type("IfcSpace")),
        "grids_count": len(parts["gridLines"]),
        "floor_plates_count": len(parts["floorPlates"]),
        "has_levels": len(levels) > 0,
        "levels_with_plan_boundary": lv_pb,
        "has_bounding_boxes": bounds.maxX > bounds.minX or bounds.maxY > bounds.minY,
        "coordinate_normalization": {
            "applied": bool(ox or oy),
            "originalCenterFt": [ox, oy, 0.0],
            "note": "Coordinates rebased to local frame; see metadata.originTransform.",
        },
        "warnings_tail": warnings[-16:],
    }
    line = json.dumps(summary, default=str)
    log.info("ifc.parse_debug %s", line)
    if os.environ.get("CIVIL_AGENT_WRITE_PARSE_DEBUG", "").lower() in ("1", "true", "yes"):
        try:
            dbg_path = os.path.join(os.path.dirname(file_path), "parsed_geometry_debug.json")
            with open(dbg_path, "w", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as exc:
            log.warning("ifc.parse_debug_write_failed %s", exc)


# ---------------------------------------------------------------------------
# Public entry — called from the orchestrator
# ---------------------------------------------------------------------------


async def extract_ifc(
    *,
    file_path: str,
    tracker: ProgressTracker,
    run_id: str,
    source_file_id: Optional[str],
    completed: list[str],
    warnings: list[str],
    failures: list[StepFailure],
    file_hash_: str,
    on_layer_map: Callable[[Optional[dict[str, str]]], None],
    parse_options: Optional[dict[str, Any]] = None,
) -> ParsedGeometry:
    on_layer_map(None)  # IFC has no layer mapping

    model = _open_ifc(file_path)

    # ---- levels --------------------------------------------------------
    levels: list[Level] = await _run_step(
        name="levels",
        tracker=tracker,
        completed=completed,
        failures=failures,
        warnings=warnings,
        fn=lambda: _extract_levels(model),
        on_failure_default=[],
        detail_format=lambda r: f"{len(r)} level(s)",
        error_code=ErrorCode.EXTRACTOR_FAIL,
    )

    # ---- existing columns (before floor plates — bbox fallbacks need x,y) -
    columns: list[ExistingColumn] = await _run_step(
        name="existing_elements",
        tracker=tracker,
        completed=completed,
        failures=failures,
        warnings=warnings,
        fn=lambda: _extract_columns(model, levels),
        on_failure_default=[],
        detail_format=lambda r: f"{len(r)} existing column(s)",
        error_code=ErrorCode.EXTRACTOR_FAIL,
    )

    # ---- floor plates --------------------------------------------------
    levels, floor_plates = await _run_step(
        name="floor_plates",
        tracker=tracker,
        completed=completed,
        failures=failures,
        warnings=warnings,
        fn=lambda: _extract_floor_plates(model, levels, columns),
        on_failure_default=(levels, []),
        detail_format=lambda r: f"{len(r[1])} floor plate(s)",
        error_code=ErrorCode.EXTRACTOR_FAIL,
    )

    # ---- grids ---------------------------------------------------------
    grids_inferred = [False]

    def _do_grids() -> list[GridLine]:
        gs, inferred = _extract_grids(model, columns)
        grids_inferred[0] = inferred
        if inferred:
            warnings.append(
                f"[{ErrorCode.IFC_GEOMETRY_FAIL.value}] step=grids: "
                "no IfcGrid present; grid lines inferred from column positions."
            )
        return gs

    grids: list[GridLine] = await _run_step(
        name="grids",
        tracker=tracker,
        completed=completed,
        failures=failures,
        warnings=warnings,
        fn=_do_grids,
        on_failure_default=[],
        detail_format=lambda r: (
            f"{len(r)} grid line(s) ({'inferred' if grids_inferred[0] else 'from IfcGrid'})"
        ),
        error_code=ErrorCode.EXTRACTOR_FAIL,
    )

    columns = reconcile_columns_to_grid(
        columns, grids, snap_tolerance=SNAP_TOLERANCE_FT, flag_tolerance=FLAG_TOLERANCE_FT
    )

    # ---- cores ---------------------------------------------------------
    cores: list[Core] = await _run_step(
        name="cores",
        tracker=tracker,
        completed=completed,
        failures=failures,
        warnings=warnings,
        fn=lambda: _extract_cores(model, levels),
        on_failure_default=[],
        detail_format=lambda r: f"{len(r)} core(s)",
        error_code=ErrorCode.EXTRACTOR_FAIL,
    )

    # ---- openings ------------------------------------------------------
    openings: list[Opening] = await _run_step(
        name="openings",
        tracker=tracker,
        completed=completed,
        failures=failures,
        warnings=warnings,
        fn=lambda: _extract_openings(model, levels),
        on_failure_default=[],
        detail_format=lambda r: f"{len(r)} opening(s)",
        error_code=ErrorCode.EXTRACTOR_FAIL,
    )

    # ---- no-column zones ----------------------------------------------
    zones: list[NoColumnZone] = await _run_step(
        name="no_column_zones",
        tracker=tracker,
        completed=completed,
        failures=failures,
        warnings=warnings,
        fn=lambda: _extract_no_column_zones(model, levels),
        on_failure_default=[],
        detail_format=lambda r: f"{len(r)} no-column zone(s)",
        error_code=ErrorCode.EXTRACTOR_FAIL,
    )

    if not columns:
        warnings.append(
            f"[{ErrorCode.IFC_NO_STRUCTURAL_ELEMENTS.value}] step=existing_elements: "
            "no IfcColumn entities found; downstream agents will treat the building "
            "as a fresh structural design."
        )

    # ---- local frame ---------------------------------------------------
    parts = {
        "levels": levels,
        "gridLines": grids,
        "cores": cores,
        "openings": openings,
        "existingColumns": columns,
        "noColumnZones": zones,
        "floorPlates": floor_plates,
    }
    ox, oy = _local_origin(columns, floor_plates)
    parts = _rebase(parts, ox, oy)
    bounds = _building_bounds(parts)
    parts["buildingBounds"] = bounds
    if not any(len(L.planBoundary) >= 3 for L in parts["levels"]):
        warnings.append(
            "ifc: no level has a usable planBoundary after slab/column/wall/space "
            "inference; the 3D workspace needs footprints or structural placements."
        )
    _write_ifc_parse_debug(file_path, model, parts, ox, oy, warnings)

    metadata = ParseMetadata(
        schemaVersion=SCHEMA_VERSION,
        parserVersion=PARSER_VERSION,
        runId=run_id,
        fileFormat="ifc",
        fileHash=file_hash_,
        overallConfidence=1.0,
        status="processing",
        completedSteps=list(dict.fromkeys(completed)),
        failedStep=None,
        failedStepCode=None,
        warnings=list(warnings),
        layerMapping=None,
        originTransform=OriginTransform(tx=ox, ty=oy),
        parsedAt=datetime.now(timezone.utc),
        sourceFileId=source_file_id,
    )

    return ParsedGeometry(
        levels=parts["levels"],
        gridLines=parts["gridLines"],
        cores=parts["cores"],
        openings=parts["openings"],
        existingColumns=parts["existingColumns"],
        noColumnZones=parts["noColumnZones"],
        floorPlates=parts["floorPlates"],
        buildingBounds=bounds,
        metadata=metadata,
    )
