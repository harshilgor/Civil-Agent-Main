"""Column-layout generator orchestrator.

Single public entry point :func:`generate_schemes`. Drives the whole
pipeline: validate input → build exclusion polygons (once) → for each
strategy, generate grid → enforce exclusions → preserve locked
columns → merge existing → assign grid labels → validate stacking →
generate beams → score → wrap in :class:`StructuralScheme`.

The function is **pure** and **deterministic**: same input → same
output, byte-for-byte. No clocks, no random numbers, no UUID-from-time
allowed inside this file.
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from typing import Any

from shapely.geometry import Polygon

from packages.engine.column_generator.beam_builder import generate_beams
from packages.engine.column_generator.constants import (
    DISPLAY_LABELS,
    EDGE_TOLERANCE,
    GRID_SNAP_TOLERANCE,
    MATERIAL_BAY_LIMITS,
    PERF_HARD_CAP_S,
    STRATEGY_DEFINITIONS,
)
from packages.engine.column_generator.constraints import (
    build_exclusion_zones,
    enforce_exclusions,
    merge_existing_columns,
    preserve_locked_columns,
)
from packages.engine.column_generator.grid_builder import (
    build_regular_grid,
    reduce_interior,
)
from packages.engine.column_generator.models import (
    Beam,
    Column,
    GenerationConstraints,
    Point2D,
    SchemeMetrics,
    StructuralScheme,
)
from packages.engine.column_generator.scoring import (
    collect_bay_sizes,
    score_scheme,
    unique_bay_patterns,
)
from packages.engine.column_generator.stacking import validate_stacking

log = logging.getLogger(__name__)

# Stable namespace so deterministic UUID5 ids don't change between runs.
_SCHEME_NS = uuid.UUID("4f3b8a2c-3a9d-4f29-9b1d-91d2c9c7c5d4")


def generate_schemes(
    parsed_geometry: dict | Any,
    constraints: GenerationConstraints | None = None,
) -> list[StructuralScheme]:
    """Produce 4–5 :class:`StructuralScheme` variants for a parsed
    building.

    Parameters
    ----------
    parsed_geometry : dict | ParsedGeometry
        Either the raw JSON shape produced by Agent 1 (preferred — the
        worker hands us a dict from JSONB storage) or a Pydantic
        :class:`ParsedGeometry` instance (for ad-hoc Python callers).
    constraints : GenerationConstraints, optional
        Engineer's overrides. Defaults to material-system bay limits
        with no locked columns and all five strategies.

    Returns
    -------
    list[StructuralScheme]
        Ordered by **score descending** (highest-quality first). The
        first item carries ``status="active"``; the rest
        ``status="alternate"``. Display labels A/B/C/D/E reflect
        creation order, not score, so the UI can always offer a
        deterministic letter regardless of which one is "best".
    """
    geometry_dict = _to_dict(parsed_geometry)
    _validate_geometry(geometry_dict)

    if constraints is None:
        constraints = GenerationConstraints()
    min_bay, target_bay, max_bay = constraints.resolved_bay_limits()
    if min_bay > max_bay:
        raise ValueError("min_bay must be <= max_bay")
    target_bay = max(min_bay, min(max_bay, target_bay))

    # Build exclusion polygons once — they don't change between strategies.
    exclusion_zones = build_exclusion_zones(
        geometry_dict.get("cores"),
        geometry_dict.get("openings"),
        geometry_dict.get("noColumnZones"),
    )

    levels = list(geometry_dict.get("levels") or [])
    grid_lines = list(geometry_dict.get("gridLines") or [])
    existing_columns = list(geometry_dict.get("existingColumns") or [])
    building_bounds = dict(geometry_dict["buildingBounds"])
    floor_polygon = _floor_polygon(levels)

    start_wall = time.monotonic()
    schemes: list[StructuralScheme] = []
    strategies = constraints.resolved_strategies()
    seen_strategy_keys: set[str] = set()

    for strategy_key in strategies:
        if strategy_key in seen_strategy_keys:
            continue
        seen_strategy_keys.add(strategy_key)
        spec = _strategy_spec(strategy_key)
        if spec is None:
            continue
        scheme = _generate_one_strategy(
            spec=spec,
            constraints=constraints,
            min_bay=min_bay,
            target_bay=target_bay,
            max_bay=max_bay,
            building_bounds=building_bounds,
            grid_lines=grid_lines,
            existing_columns=existing_columns,
            levels=levels,
            exclusion_zones=exclusion_zones,
            floor_polygon=floor_polygon,
            geometry_hash=_geometry_hash(geometry_dict),
        )
        schemes.append(scheme)

    elapsed = time.monotonic() - start_wall
    if elapsed > PERF_HARD_CAP_S:
        msg = f"Scheme generation took {elapsed:.2f}s — exceeded hard cap of {PERF_HARD_CAP_S}s."
        for s in schemes:
            s.metrics.warnings.append(msg)
            s.metrics.warning_count = len(s.metrics.warnings)

    # Assign display labels in creation order.
    for idx, scheme in enumerate(schemes):
        scheme.display_label = DISPLAY_LABELS[idx] if idx < len(DISPLAY_LABELS) else f"S{idx + 1}"

    # Status: highest-scoring → active, rest → alternate. Sort by score
    # descending; on ties, the earlier-created (lower display-label
    # alphabetically) wins.
    schemes.sort(
        key=lambda s: (-(s.score or 0.0), DISPLAY_LABELS.index(s.display_label)
                       if s.display_label in DISPLAY_LABELS else 99)
    )
    if schemes:
        schemes[0].status = "active"
        for s in schemes[1:]:
            s.status = "alternate"

    log.info(
        "column_generator.complete",
        extra={
            "scheme_count": len(schemes),
            "elapsed_s": round(elapsed, 3),
            "active_strategy": schemes[0].strategy if schemes else None,
        },
    )
    return schemes


# ---------------------------------------------------------------------------
# Per-strategy pipeline
# ---------------------------------------------------------------------------


def _generate_one_strategy(
    *,
    spec: dict,
    constraints: GenerationConstraints,
    min_bay: float,
    target_bay: float,
    max_bay: float,
    building_bounds: dict,
    grid_lines: list[dict],
    existing_columns: list[dict],
    levels: list[dict],
    exclusion_zones: list[Polygon],
    floor_polygon: Polygon | None,
    geometry_hash: str,
) -> StructuralScheme:
    """Run all 12 algorithm steps for a single strategy."""
    warnings: list[str] = []
    strategy_key: str = spec["key"]

    # Step 1: effective bay sizes.
    bay = max(min_bay, min(max_bay, target_bay * float(spec["bay_factor"])))
    bay_x = bay
    bay_y = bay

    # Step 2: candidate grid.
    offset_fraction = float(spec["offset_fraction"])
    offset_x = bay_x * offset_fraction
    offset_y = bay_y * offset_fraction
    candidates = build_regular_grid(
        building_bounds=building_bounds,
        bay_x=bay_x,
        bay_y=bay_y,
        offset_x=offset_x,
        offset_y=offset_y,
        grid_lines=grid_lines,
        floor_polygon=floor_polygon,
    )

    # Step 3: interior reduction.
    if spec.get("reduce_interior", False):
        candidates, reduce_warnings = reduce_interior(
            candidates,
            (float(building_bounds["minX"]), float(building_bounds["maxX"])),
            (float(building_bounds["minY"]), float(building_bounds["maxY"])),
            max_bay,
        )
        warnings.extend(reduce_warnings)

    # Step 4: exclusion-zone enforcement.
    candidates, excl_warnings = enforce_exclusions(
        candidates, exclusion_zones, max_bay
    )
    warnings.extend(excl_warnings)

    # Step 5: locked columns.
    candidates, locked_warnings = preserve_locked_columns(
        candidates,
        existing_columns,
        constraints.locked_column_ids,
        exclusion_zones,
    )
    warnings.extend(locked_warnings)

    # Step 6: merge non-locked existing columns.
    candidates = merge_existing_columns(
        candidates, existing_columns, constraints.locked_column_ids
    )

    # Step 7: building-wide planBoundary filtering. The grid_builder
    # already filtered by floor_polygon (level 1) but late-arriving
    # locked / existing columns may sit outside.
    if floor_polygon is not None:
        before = len(candidates)
        candidates = [
            c
            for c in candidates
            if c.get("source") in ("locked", "existing")
            or _point_inside(floor_polygon, c["x"], c["y"])
        ]
        dropped = before - len(candidates)
        if dropped:
            warnings.append(
                f"{dropped} candidate column(s) dropped: outside floor plate."
            )

    # Promote to first-class column dicts with stable level spans + ids.
    span_levels = _level_span(levels)
    columns = _materialise_columns(candidates, span_levels, strategy_key)

    # Step 8: grid label assignment for any column that doesn't already
    # carry one (locked/existing columns keep theirs).
    _assign_grid_labels(columns, grid_lines)

    # Step 9: stacking validation.
    warnings.extend(validate_stacking(columns, levels))

    # Step 10: beam generation at every level.
    beams_data, beam_warnings = generate_beams(
        columns,
        levels,
        exclusion_zones,
        max_bay,
        id_prefix=strategy_key,
    )
    warnings.extend(beam_warnings)

    # Step 11: metrics.
    bay_sizes = collect_bay_sizes(beams_data)
    metrics = SchemeMetrics(
        column_count=len(columns),
        max_span=round(max(bay_sizes), 3) if bay_sizes else 0.0,
        average_span=round(sum(bay_sizes) / len(bay_sizes), 3) if bay_sizes else 0.0,
        unique_bay_patterns=unique_bay_patterns(bay_sizes),
        warning_count=len(warnings),
        warnings=list(warnings),
    )

    # Step 12: scoring.
    score, _components = score_scheme(
        columns=columns,
        beams=beams_data,
        bay_sizes=bay_sizes,
        target_bay=target_bay,
        exclusion_zones=exclusion_zones,
    )

    # Wrap in Pydantic models.
    column_models = [
        Column(
            id=c["id"],
            grid_label=c.get("grid_label", ""),
            x=c["x"],
            y=c["y"],
            start_level=c["start_level"],
            end_level=c["end_level"],
            locked=bool(c.get("locked", False)),
            source=c.get("source", "generated"),
        )
        for c in columns
    ]
    beam_models = [
        Beam(
            id=b["id"],
            start=Point2D(x=b["start"]["x"], y=b["start"]["y"]),
            end=Point2D(x=b["end"]["x"], y=b["end"]["y"]),
            level_id=b["level_id"],
            span=b["span"],
        )
        for b in beams_data
    ]

    scheme_id = _stable_scheme_id(strategy_key, geometry_hash)
    return StructuralScheme(
        id=scheme_id,
        display_label="?",  # set by orchestrator after the loop
        name=spec["name"],
        strategy=strategy_key,
        description=spec["description"],
        columns=column_models,
        beams=beam_models,
        shear_walls=[],
        braces=[],
        metrics=metrics,
        status="alternate",
        score=score,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_dict(parsed_geometry: dict | Any) -> dict:
    """Accept dict or Pydantic ParsedGeometry."""
    if isinstance(parsed_geometry, dict):
        return parsed_geometry
    if hasattr(parsed_geometry, "model_dump"):
        return parsed_geometry.model_dump(mode="json")
    raise TypeError(
        "parsed_geometry must be a dict or a Pydantic model with model_dump()."
    )


def _validate_geometry(geom: dict) -> None:
    levels = geom.get("levels") or []
    if not levels:
        raise ValueError("ParsedGeometry must contain at least one level.")
    bb = geom.get("buildingBounds")
    if not bb or any(k not in bb for k in ("minX", "minY", "maxX", "maxY")):
        raise ValueError("ParsedGeometry.buildingBounds is required.")
    if float(bb["maxX"]) <= float(bb["minX"]) or float(bb["maxY"]) <= float(bb["minY"]):
        raise ValueError("ParsedGeometry.buildingBounds must be non-degenerate.")
    has_plate = any(lvl.get("planBoundary") for lvl in levels)
    if not has_plate:
        raise ValueError("ParsedGeometry must contain at least one level with planBoundary.")


def _floor_polygon(levels: list[dict]) -> Polygon | None:
    """Use the lowest level's planBoundary as the canonical floor
    polygon. Most fixtures have identical plates per level; if they
    differ, stacking validation flags it later.
    """
    for lvl in sorted(levels, key=lambda l: l.get("elevation", 0.0)):
        boundary = lvl.get("planBoundary")
        if not boundary or len(boundary) < 3:
            continue
        pts: list[tuple[float, float]] = []
        for p in boundary:
            if isinstance(p, dict):
                pts.append((float(p["x"]), float(p["y"])))
            else:
                pts.append((float(p[0]), float(p[1])))
        if len(pts) >= 4 and pts[0] == pts[-1]:
            pts = pts[:-1]
        if len(pts) < 3:
            continue
        try:
            poly = Polygon(pts)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_empty:
                return poly
        except Exception:
            continue
    return None


def _level_span(levels: list[dict]) -> tuple[str, str]:
    """Return ``(lowest_level_id, highest_level_id)`` by elevation."""
    if not levels:
        return ("L1", "L1")
    sorted_levels = sorted(levels, key=lambda l: l.get("elevation", 0.0))
    return (sorted_levels[0]["id"], sorted_levels[-1]["id"])


def _materialise_columns(
    candidates: list[dict],
    span_levels: tuple[str, str],
    strategy_key: str,
) -> list[dict]:
    """Promote candidate dicts into final column dicts with stable
    deterministic ids and a level span. Sort the result by (y, x) so
    downstream steps process columns in a deterministic order.
    """
    low, high = span_levels
    out: list[dict] = []
    seen: set[tuple[float, float]] = set()
    for c in candidates:
        key = (round(c["x"], 3), round(c["y"], 3))
        if key in seen:
            continue
        seen.add(key)
        col_id = c.get("id") or _stable_column_id(strategy_key, c["x"], c["y"])
        out.append(
            {
                "id": col_id,
                "x": float(c["x"]),
                "y": float(c["y"]),
                "start_level": c.get("start_level") or low,
                "end_level": c.get("end_level") or high,
                "grid_label": c.get("grid_label") or "",
                "snapped_to_grid": c.get("snapped_to_grid", False),
                "locked": bool(c.get("locked", False)),
                "source": c.get("source", "generated"),
            }
        )
    out.sort(key=lambda c: (c["y"], c["x"]))
    return out


def _assign_grid_labels(columns: list[dict], grid_lines: list[dict]) -> None:
    if not grid_lines:
        return
    x_grid = sorted(
        ({"label": g["label"], "coord": float(g["coordinate"])} for g in grid_lines if g.get("axis") == "x"),
        key=lambda g: g["coord"],
    )
    y_grid = sorted(
        ({"label": g["label"], "coord": float(g["coordinate"])} for g in grid_lines if g.get("axis") == "y"),
        key=lambda g: g["coord"],
    )
    for col in columns:
        if col.get("grid_label"):
            continue
        x_match = _nearest_within(col["x"], x_grid, GRID_SNAP_TOLERANCE)
        y_match = _nearest_within(col["y"], y_grid, GRID_SNAP_TOLERANCE)
        if x_match and y_match:
            col["grid_label"] = f"{y_match['label']}-{x_match['label']}"


def _nearest_within(value: float, grid: list[dict], tol: float) -> dict | None:
    if not grid:
        return None
    best = min(grid, key=lambda g: abs(g["coord"] - value))
    if abs(best["coord"] - value) <= tol + EDGE_TOLERANCE:
        return best
    return None


def _point_inside(polygon: Polygon, x: float, y: float) -> bool:
    from shapely.geometry import Point

    pt = Point(x, y)
    return polygon.covers(pt) or polygon.distance(pt) <= EDGE_TOLERANCE


def _strategy_spec(key: str) -> dict | None:
    for spec in STRATEGY_DEFINITIONS:
        if spec["key"] == key:
            return spec
    return None


def _geometry_hash(geom: dict) -> str:
    """Stable hash of the geometry's column-relevant fields. Used to
    seed deterministic UUIDs so the same input always produces the
    same scheme ids."""
    import json

    payload = {
        "buildingBounds": geom.get("buildingBounds"),
        "levels": [
            {"id": lvl.get("id"), "elevation": lvl.get("elevation")}
            for lvl in (geom.get("levels") or [])
        ],
        "gridLines": [
            {"axis": g.get("axis"), "coord": g.get("coordinate"), "label": g.get("label")}
            for g in (geom.get("gridLines") or [])
        ],
        "cores": [c.get("id") for c in (geom.get("cores") or [])],
        "openings": [o.get("id") for o in (geom.get("openings") or [])],
        "noColumnZones": [z.get("id") for z in (geom.get("noColumnZones") or [])],
        "existingColumns": [
            {"id": c.get("id"), "x": c.get("x"), "y": c.get("y")}
            for c in (geom.get("existingColumns") or [])
        ],
    }
    serialised = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(serialised.encode("utf-8")).hexdigest()


def _stable_scheme_id(strategy_key: str, geometry_hash: str) -> str:
    """Deterministic UUID5 from (strategy, geometry_hash). Same geometry
    + same strategy always yields the same scheme id."""
    return str(uuid.uuid5(_SCHEME_NS, f"{strategy_key}|{geometry_hash}"))


def _stable_column_id(strategy_key: str, x: float, y: float) -> str:
    raw = f"{strategy_key}|{x:.3f}|{y:.3f}"
    h = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
    return f"C-{h}"


__all__ = ["generate_schemes"]
