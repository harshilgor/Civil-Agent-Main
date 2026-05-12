"""DXF extractor.

DXF carries CAD geometry without semantics. We:

1. Walk every entity.
2. Score its layer name against the configured fuzzy patterns.
3. Bucket each entity into ``columns | grids | walls | other``.
4. Fall back to geometry-only heuristics for any entity whose layer
   name fails to match.

All layer-name decisions are recorded in ``metadata.layerMapping`` so
the engineer can audit / override them.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Callable, Optional

from packages.engine.geometry_parser.constants import (
    COLUMN_LAYER_PATTERNS,
    FLAG_TOLERANCE_FT,
    GRID_LAYER_PATTERNS,
    LAYER_MATCH_THRESHOLD,
    PARSER_VERSION,
    SCHEMA_VERSION,
    SNAP_TOLERANCE_FT,
    WALL_LAYER_PATTERNS,
)
from packages.engine.geometry_parser.errors import ErrorCode, ParserError, StepFailure
from packages.engine.geometry_parser.ids import column_id, grid_id, level_id
from packages.engine.geometry_parser.inference.grid_inference import (
    infer_grids_from_columns,
    reconcile_columns_to_grid,
)
from packages.engine.geometry_parser.models import (
    BuildingBounds,
    ExistingColumn,
    GridLine,
    Level,
    OriginTransform,
    ParseMetadata,
    ParsedGeometry,
    Point2D,
)
from packages.engine.geometry_parser.progress import ProgressTracker

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Layer fuzzy matching
# ---------------------------------------------------------------------------


def _score(layer: str, patterns: tuple[str, ...]) -> float:
    layer_l = layer.lower()
    best = 0.0
    for p in patterns:
        if p in layer_l:
            best = max(best, 0.9)
            continue
        ratio = SequenceMatcher(None, layer_l, p).ratio()
        best = max(best, ratio)
    return best


def _classify_layer(layer: str) -> tuple[str, float]:
    candidates = {
        "grid": _score(layer, GRID_LAYER_PATTERNS),
        "column": _score(layer, COLUMN_LAYER_PATTERNS),
        "wall": _score(layer, WALL_LAYER_PATTERNS),
    }
    cat, score = max(candidates.items(), key=lambda kv: kv[1])
    if score < LAYER_MATCH_THRESHOLD:
        return "other", score
    return cat, score


# ---------------------------------------------------------------------------
# Document loader
# ---------------------------------------------------------------------------


def _open_dxf(path: str) -> Any:
    try:
        import ezdxf  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise ParserError(
            code=ErrorCode.DXF_PARSE_FAIL,
            message="ezdxf is not installed",
            step="init",
        ) from exc
    try:
        return ezdxf.readfile(path)
    except Exception as exc:
        raise ParserError(
            code=ErrorCode.DXF_PARSE_FAIL,
            message=f"Failed to open DXF: {exc}",
            step="init",
        ) from exc


# ---------------------------------------------------------------------------
# Entity helpers
# ---------------------------------------------------------------------------


def _entity_xy(entity: Any) -> Optional[tuple[float, float]]:
    dxftype = entity.dxftype()
    try:
        if dxftype == "LWPOLYLINE":
            pts = list(entity.get_points("xy"))
            if not pts:
                return None
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            return (sum(xs) / len(xs), sum(ys) / len(ys))
        if dxftype == "CIRCLE":
            return (float(entity.dxf.center[0]), float(entity.dxf.center[1]))
        if dxftype == "INSERT":
            return (float(entity.dxf.insert[0]), float(entity.dxf.insert[1]))
        if dxftype in {"TEXT", "MTEXT"}:
            ip = entity.dxf.insert
            return (float(ip[0]), float(ip[1]))
        if dxftype == "LINE":
            mx = (entity.dxf.start[0] + entity.dxf.end[0]) / 2
            my = (entity.dxf.start[1] + entity.dxf.end[1]) / 2
            return (float(mx), float(my))
    except Exception:
        return None
    return None


def _line_endpoints(entity: Any) -> Optional[tuple[tuple[float, float], tuple[float, float]]]:
    if entity.dxftype() != "LINE":
        return None
    try:
        s = entity.dxf.start
        e = entity.dxf.end
        return (float(s[0]), float(s[1])), (float(e[0]), float(e[1]))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------


async def extract_dxf(
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
    doc = _open_dxf(file_path)
    msp = doc.modelspace()

    # ---- discover layer mapping ----------------------------------------
    await tracker.start_step("init", detail="(re-init) classifying layers")

    def _build_layer_map() -> dict[str, str]:
        out: dict[str, str] = {}
        for layer in doc.layers:
            cat, _score = _classify_layer(layer.dxf.name)
            out[layer.dxf.name] = cat
        return out

    layer_map = await asyncio.to_thread(_build_layer_map)
    on_layer_map(layer_map)
    log.info("dxf.layer_map", extra={"map": layer_map})
    await tracker.complete_step("init", detail=f"{len(layer_map)} layer(s) classified")

    # ---- levels --------------------------------------------------------
    await tracker.start_step("levels", detail="Heuristic level detection from DXF")
    try:
        # DXF rarely encodes elevations explicitly; we treat the DXF as a
        # single ground-floor plan unless the engineer uploaded multiple
        # files. Frontend can override this.
        levels = [
            Level(
                id=level_id("Level 1", 0.0),
                name="Level 1",
                elevation=0.0,
                height=14.0,
                planBoundary=[],
                confidence=0.5,
                source="dxf",
                rationale="DXF lacks explicit storey metadata; assumed single level.",
            )
        ]
        warnings.append(
            f"[{ErrorCode.DXF_LAYER_UNKNOWN.value}] step=levels: "
            "DXF has no storey metadata; treated as single Level 1."
        )
        completed.append("levels")
        await tracker.complete_step("levels", detail="1 level (assumed)")
    except Exception as exc:  # pragma: no cover
        await _record_failure(
            tracker, "levels", exc, ErrorCode.EXTRACTOR_FAIL, failures, warnings
        )
        levels = []

    # ---- columns -------------------------------------------------------
    await tracker.start_step("existing_elements", detail="Detecting columns from layers")

    def _scan_columns() -> list[ExistingColumn]:
        out: list[ExistingColumn] = []
        for ent in msp:
            cat = layer_map.get(ent.dxf.layer, "other")
            if cat != "column":
                continue
            xy = _entity_xy(ent)
            if not xy:
                continue
            out.append(
                ExistingColumn(
                    id=column_id(xy[0], xy[1], levels[0].id if levels else "lvl_unknown"),
                    x=round(xy[0], 4),
                    y=round(xy[1], 4),
                    startLevel=levels[0].id if levels else "lvl_unknown",
                    endLevel=levels[0].id if levels else "lvl_unknown",
                    gridAligned=True,
                    confidence=0.85,
                    source="dxf",
                )
            )
        return out

    try:
        cols = await asyncio.to_thread(_scan_columns)
        completed.append("existing_elements")
        await tracker.complete_step(
            "existing_elements", detail=f"{len(cols)} column(s) detected"
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await _record_failure(
            tracker, "existing_elements", exc, ErrorCode.EXTRACTOR_FAIL, failures, warnings
        )
        cols = []

    # ---- grids ---------------------------------------------------------
    await tracker.start_step("grids", detail="Reading grid layer + falling back to inference")
    grids: list[GridLine] = []

    def _scan_grids() -> list[GridLine]:
        out: list[GridLine] = []
        for ent in msp:
            cat = layer_map.get(ent.dxf.layer, "other")
            if cat != "grid":
                continue
            seg = _line_endpoints(ent)
            if seg is None:
                continue
            (sx, sy), (ex, ey) = seg
            if abs(sx - ex) < 0.01:
                coord = round((sx + ex) / 2, 3)
                label = _nearby_label(msp, sx, sy, ex, ey) or f"X{len(out) + 1}"
                out.append(
                    GridLine(
                        id=grid_id("x", label, coord),
                        axis="x",
                        label=label,
                        coordinate=coord,
                        confidence=0.9,
                        source="dxf",
                    )
                )
            elif abs(sy - ey) < 0.01:
                coord = round((sy + ey) / 2, 3)
                label = _nearby_label(msp, sx, sy, ex, ey) or f"Y{len(out) + 1}"
                out.append(
                    GridLine(
                        id=grid_id("y", label, coord),
                        axis="y",
                        label=label,
                        coordinate=coord,
                        confidence=0.9,
                        source="dxf",
                    )
                )
        return out

    try:
        grids = await asyncio.to_thread(_scan_grids)
        if not grids:
            grids = infer_grids_from_columns(cols)
            if grids:
                warnings.append(
                    f"[{ErrorCode.DXF_LAYER_UNKNOWN.value}] step=grids: "
                    "no grid layer detected; inferred from column positions."
                )
        completed.append("grids")
        await tracker.complete_step("grids", detail=f"{len(grids)} grid line(s)")
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await _record_failure(tracker, "grids", exc, ErrorCode.EXTRACTOR_FAIL, failures, warnings)

    cols = reconcile_columns_to_grid(
        cols, grids, snap_tolerance=SNAP_TOLERANCE_FT, flag_tolerance=FLAG_TOLERANCE_FT
    )

    # ---- cores / openings / floor plates / no-column zones -------------
    # DXF has no semantic core/opening info — we report empty + warning.
    for step in ("cores", "openings", "floor_plates", "no_column_zones"):
        await tracker.start_step(step, detail="Skipping — DXF lacks semantic data")
        warnings.append(
            f"[{ErrorCode.DXF_LAYER_UNKNOWN.value}] step={step}: "
            "DXF has no semantic data for this category; result is empty."
        )
        completed.append(step)
        await tracker.complete_step(step, detail="0 (DXF has no semantic data)")

    # ---- bounds + origin ----------------------------------------------
    xs = [c.x for c in cols]
    ys = [c.y for c in cols]
    if xs and ys:
        ox = round(sum(xs) / len(xs), 4)
        oy = round(sum(ys) / len(ys), 4)
    else:
        ox, oy = 0.0, 0.0

    cols = [
        c.model_copy(update={"x": round(c.x - ox, 4), "y": round(c.y - oy, 4)}) for c in cols
    ]
    grids = [
        g.model_copy(
            update={"coordinate": round(g.coordinate - (ox if g.axis == "x" else oy), 4)}
        )
        for g in grids
    ]

    bounds = (
        BuildingBounds(
            minX=round(min(xs) - ox, 4),
            minY=round(min(ys) - oy, 4),
            maxX=round(max(xs) - ox, 4),
            maxY=round(max(ys) - oy, 4),
        )
        if xs
        else BuildingBounds(minX=0.0, minY=0.0, maxX=0.0, maxY=0.0)
    )

    metadata = ParseMetadata(
        schemaVersion=SCHEMA_VERSION,
        parserVersion=PARSER_VERSION,
        runId=run_id,
        fileFormat="dxf",
        fileHash=file_hash_,
        overallConfidence=0.7,
        status="processing",
        completedSteps=list(dict.fromkeys(completed)),
        warnings=list(warnings),
        layerMapping=layer_map,
        originTransform=OriginTransform(tx=ox, ty=oy),
        parsedAt=datetime.now(timezone.utc),
        sourceFileId=source_file_id,
    )

    return ParsedGeometry(
        levels=levels,
        gridLines=grids,
        cores=[],
        openings=[],
        existingColumns=cols,
        noColumnZones=[],
        floorPlates=[],
        buildingBounds=bounds,
        metadata=metadata,
    )


def _nearby_label(msp: Any, sx: float, sy: float, ex: float, ey: float) -> Optional[str]:
    """Find the nearest TEXT / MTEXT to a line segment endpoint."""
    cx = (sx + ex) / 2
    cy = (sy + ey) / 2
    best_dist = float("inf")
    best: Optional[str] = None
    for ent in msp:
        if ent.dxftype() not in {"TEXT", "MTEXT"}:
            continue
        xy = _entity_xy(ent)
        if not xy:
            continue
        d = (xy[0] - cx) ** 2 + (xy[1] - cy) ** 2
        if d < best_dist:
            try:
                txt = ent.dxf.text if ent.dxftype() == "TEXT" else ent.text
                best = (txt or "").strip()
                best_dist = d
            except Exception:
                continue
    return best or None


async def _record_failure(
    tracker: ProgressTracker,
    step: str,
    exc: Exception,
    code: ErrorCode,
    failures: list[StepFailure],
    warnings: list[str],
) -> None:
    log.exception("dxf.step_failed", extra={"step": step})
    failure = StepFailure(step=step, code=code, message=str(exc) or exc.__class__.__name__)
    failures.append(failure)
    warnings.append(failure.to_warning())
    await tracker.fail_step(step, detail=str(exc), error_code=code.value)
