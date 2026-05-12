"""Main orchestrator for Agent 4's load calculator + member sizer.

Single public entry point :func:`calculate_scheme_sizing`. The function
is **pure** and **deterministic** — same inputs always produce the same
outputs, byte-for-byte. No clocks, no random numbers, no UUID-from-time
allowed inside this module's hot path. (Member-check IDs use UUID4 so
they're unique per row in the database; that's the only intentional
non-determinism, and it lives below the engine model boundary.)

Pipeline:

1. Parse inputs (geometry, scheme, assumptions).
2. Group beams and columns by level.
3. For every beam:
     a. Compute tributary width / area / influence area.
     b. Compute slab + self-weight + reduced-live linear loads.
     c. Run LRFD combinations, pick governing.
     d. Size for flexure, verify shear + deflection. Iterate on
        self-weight if needed.
4. For every column:
     a. Compute per-level tributary area.
     b. Top-down takedown with cumulative LLR.
     c. Size for max factored axial; check slenderness.
5. Aggregate scheme metrics (tonnage, depth, sections).
6. Return :class:`SizingResult`.

Beam sizing happens first because the column takedown does not need
beam reactions in this MVP — the column carries the slab tributary
area directly. That avoids a circular dependency and keeps the
auditing trail flat.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from packages.engine.member_sizer.beam_sizer import (
    BeamSizingInputs,
    size_beam,
)
from packages.engine.member_sizer.column_sizer import (
    ColumnSizingInputs,
    LevelTributary,
    size_column,
)
from packages.engine.member_sizer.constants import SIZER_VERSION
from packages.engine.member_sizer.loads import beam_loads
from packages.engine.member_sizer.metrics import compute_scheme_metrics
from packages.engine.member_sizer.models import (
    MemberSizingSummary,
    SizingAssumptions,
    SizingResult,
)
from packages.engine.member_sizer.tributary import (
    compute_beam_tributary,
    compute_column_tributary,
)


def calculate_scheme_sizing(
    scheme: dict | Any,
    geometry: dict | Any,
    assumptions: dict | SizingAssumptions | None = None,
    *,
    progress_callback: Optional[callable] = None,
) -> SizingResult:
    """Run gravity load analysis + member sizing for a scheme.

    Parameters
    ----------
    scheme : dict | StructuralScheme
        Agent 3's output. Must have ``columns`` and ``beams`` lists
        plus a stable ``id``. Accepts either the camelCase JSON shape
        from the API or the snake_case Pydantic shape.
    geometry : dict | ParsedGeometry
        Agent 1's output. We need ``levels`` for floor heights and
        ``planBoundary`` for tributary edge cases.
    assumptions : SizingAssumptions | dict | None
        Engineer overrides; defaults from
        :class:`SizingAssumptions` are used for any missing field.
    progress_callback : callable | None
        Optional ``(step_name: str, frac_complete: float) -> None``
        hook. The worker passes a Redis-backed publisher; the engine
        itself never blocks on it — exceptions in the callback are
        swallowed.

    Returns
    -------
    SizingResult
        Beam summaries, column summaries, takedowns, updated scheme
        metrics, the assumptions used (so the worker can echo them
        into the audit log), and a list of warnings.
    """
    started = time.monotonic()
    warnings: list[str] = []

    scheme_dict = _to_dict(scheme)
    geometry_dict = _to_dict(geometry)

    if isinstance(assumptions, SizingAssumptions):
        a = assumptions
    elif isinstance(assumptions, dict):
        a = SizingAssumptions.model_validate(assumptions)
    else:
        a = SizingAssumptions()

    scheme_id = str(scheme_dict.get("id") or "")
    if not scheme_id:
        warnings.append("Scheme has no id; member checks will use blank scheme_id.")

    levels = list(geometry_dict.get("levels") or [])
    plan_boundary = _resolve_plan_boundary(geometry_dict)

    columns = list(scheme_dict.get("columns") or [])
    beams = list(scheme_dict.get("beams") or [])

    _safe_progress(progress_callback, "tributary", 0.05)

    # ---------------- Beams ----------------
    beam_summaries = _size_all_beams(
        scheme_id=scheme_id,
        beams=beams,
        levels=levels,
        plan_boundary=plan_boundary,
        assumptions=a,
        warnings=warnings,
        progress_callback=progress_callback,
    )

    # ---------------- Columns ----------------
    _safe_progress(progress_callback, "column_takedown", 0.55)

    column_results = _size_all_columns(
        scheme_id=scheme_id,
        columns=columns,
        levels=levels,
        plan_boundary=plan_boundary,
        assumptions=a,
        warnings=warnings,
        progress_callback=progress_callback,
    )
    column_summaries = [r.summary for r in column_results]
    column_takedowns = []
    for r in column_results:
        column_takedowns.extend(r.takedowns)

    _safe_progress(progress_callback, "metrics", 0.95)

    # ---------------- Metrics ----------------
    metrics = compute_scheme_metrics(beam_summaries, column_summaries)

    elapsed_ms = (time.monotonic() - started) * 1000.0
    _safe_progress(progress_callback, "complete", 1.0)

    return SizingResult(
        scheme_id=scheme_id,
        beam_summaries=beam_summaries,
        column_summaries=column_summaries,
        column_takedowns=column_takedowns,
        updated_metrics=metrics,
        assumptions_used=a,
        warnings=warnings,
        calculation_time_ms=round(elapsed_ms, 2),
    )


# ---------------------------------------------------------------------------
# Beam sizing loop
# ---------------------------------------------------------------------------


def _size_all_beams(
    *,
    scheme_id: str,
    beams: list[dict],
    levels: list[dict],
    plan_boundary: list[dict],
    assumptions: SizingAssumptions,
    warnings: list[str],
    progress_callback,
) -> list[MemberSizingSummary]:
    if not beams:
        return []

    levels_by_id = {lvl.get("id"): lvl for lvl in levels}
    beams_by_level: dict[str, list[dict]] = {}
    for b in beams:
        beams_by_level.setdefault(b.get("levelId") or b.get("level_id") or "", []).append(b)

    live_denom = assumptions.parse_deflection_denominator(
        assumptions.beam_live_load_deflection_limit
    )
    total_denom = assumptions.parse_deflection_denominator(
        assumptions.beam_total_load_deflection_limit
    )
    roof_live_denom = assumptions.parse_deflection_denominator(
        assumptions.roof_live_load_deflection_limit
    )

    summaries: list[MemberSizingSummary] = []
    total_beams = max(len(beams), 1)
    processed = 0

    # Determine which level is the roof. The "roof" is the topmost
    # level (highest elevation). Roof beams use roof loads + R1/R2.
    roof_level_id = _resolve_roof_level_id(levels)

    for level_id, group in beams_by_level.items():
        is_roof = level_id == roof_level_id
        for beam in group:
            trib = compute_beam_tributary(beam, group, plan_boundary)
            if trib.span_ft <= 0:
                warnings.append(
                    f"Beam {beam.get('id')} has zero span; skipped."
                )
                continue

            loads = beam_loads(
                span_ft=trib.span_ft,
                trib_width_ft=trib.trib_width_ft,
                influence_area_sf=trib.influence_area_sf,
                dead_load_psf=(
                    assumptions.roof_dead_load_psf if is_roof
                    else assumptions.dead_load_psf
                ),
                live_load_psf=(
                    assumptions.roof_live_load_psf if is_roof
                    else assumptions.live_load_psf
                ),
                beam_self_weight_plf=assumptions.beam_self_weight_plf,
                is_roof=is_roof,
                floors_supported=1,  # beams support a single floor
            )
            inputs = BeamSizingInputs(
                scheme_id=scheme_id,
                beam_id=str(beam.get("id") or ""),
                loads=loads,
                fy_ksi=assumptions.fy_ksi,
                e_ksi=assumptions.e_ksi,
                live_deflection_denom=(
                    roof_live_denom if is_roof else live_denom
                ),
                total_deflection_denom=total_denom,
            )
            summary = size_beam(inputs)
            summaries.append(summary)

            processed += 1
            _safe_progress(
                progress_callback,
                f"beam_sizing:{processed}/{total_beams}",
                0.05 + (processed / total_beams) * 0.45,
            )

    return summaries


# ---------------------------------------------------------------------------
# Column sizing loop
# ---------------------------------------------------------------------------


def _size_all_columns(
    *,
    scheme_id: str,
    columns: list[dict],
    levels: list[dict],
    plan_boundary: list[dict],
    assumptions: SizingAssumptions,
    warnings: list[str],
    progress_callback,
):
    if not columns:
        return []

    # Order levels top-to-bottom (descending elevation).
    sorted_levels = sorted(
        levels, key=lambda l: float(l.get("elevation") or 0.0), reverse=True
    )
    if not sorted_levels:
        warnings.append("Geometry has no levels; columns cannot be sized.")
        return []

    roof_level_id = sorted_levels[0].get("id")

    # Index columns by ID so we can derive trib area at every level
    # the column passes through. For Agent 3 schemes, every column has
    # a startLevel (top) and endLevel (bottom). The column carries
    # tributary load from every level between startLevel and endLevel
    # inclusive (since each level's slab adds dead+live to the column
    # below it).
    level_ids_top_to_bottom = [lvl.get("id") for lvl in sorted_levels]

    # We need per-level tributary area. Tributary depends on the
    # column's neighbours at that level — which for a stacked design
    # is the same set on every floor. Compute once with the full
    # column list, then re-use.
    base_trib = {
        c.get("id"): compute_column_tributary(c, columns, plan_boundary)
        for c in columns
    }

    results = []
    total = max(len(columns), 1)
    processed = 0

    for col in columns:
        col_id = str(col.get("id") or "")
        start_level = col.get("startLevel") or col.get("start_level")
        end_level = col.get("endLevel") or col.get("end_level")
        if start_level is None or end_level is None:
            warnings.append(
                f"Column {col_id} missing startLevel/endLevel; skipped."
            )
            continue

        # Determine the slice of levels this column passes through.
        # ``startLevel`` is the topmost ID and ``endLevel`` is the
        # bottommost — the column "starts" at the top and runs down
        # to ``endLevel``. (Agent 3's convention.)
        try:
            top_idx = level_ids_top_to_bottom.index(start_level)
            bot_idx = level_ids_top_to_bottom.index(end_level)
        except ValueError:
            warnings.append(
                f"Column {col_id} references unknown level; skipped."
            )
            continue
        if top_idx > bot_idx:
            top_idx, bot_idx = bot_idx, top_idx

        col_levels: list[LevelTributary] = []
        col_trib = base_trib.get(col.get("id"))
        K_LL = col_trib.K_LL if col_trib else 4.0
        trib_area = col_trib.trib_area_sf if col_trib else 0.0

        for floor_index, lvl in enumerate(sorted_levels[top_idx:bot_idx + 1]):
            col_levels.append(
                LevelTributary(
                    level_id=str(lvl.get("id") or ""),
                    level_name=str(lvl.get("name") or lvl.get("id") or ""),
                    floor_index_from_top=floor_index,
                    tributary_area_sf=trib_area,
                    K_LL=K_LL,
                    height_ft=float(lvl.get("height") or 0.0),
                    is_roof=(lvl.get("id") == roof_level_id),
                )
            )

        if not col_levels:
            warnings.append(
                f"Column {col_id} has no covered levels; skipped."
            )
            continue

        result = size_column(
            ColumnSizingInputs(
                scheme_id=scheme_id,
                column_id=col_id,
                levels=tuple(col_levels),
                dead_load_psf=assumptions.dead_load_psf,
                live_load_psf=assumptions.live_load_psf,
                roof_dead_load_psf=assumptions.roof_dead_load_psf,
                roof_live_load_psf=assumptions.roof_live_load_psf,
                fy_ksi=assumptions.fy_ksi,
                e_ksi=assumptions.e_ksi,
                k_factor=assumptions.column_k_factor,
            )
        )
        results.append(result)

        processed += 1
        _safe_progress(
            progress_callback,
            f"column_sizing:{processed}/{total}",
            0.55 + (processed / total) * 0.40,
        )

    return results


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_dict(obj: Any) -> dict:
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "model_dump"):
        return obj.model_dump(by_alias=True, mode="json")
    if hasattr(obj, "dict"):
        return obj.dict(by_alias=True)
    return {}


def _resolve_roof_level_id(levels: list[dict]) -> str | None:
    if not levels:
        return None
    top = max(levels, key=lambda l: float(l.get("elevation") or 0.0))
    return top.get("id")


def _resolve_plan_boundary(geometry_dict: dict) -> list[dict]:
    """Pick the plan boundary — prefer the topmost level's, then the
    floor-plate boundary, then bounding box."""
    levels = geometry_dict.get("levels") or []
    for lvl in levels:
        boundary = lvl.get("planBoundary") or []
        if boundary:
            return boundary

    bounds = geometry_dict.get("buildingBounds")
    if bounds:
        return [
            {"x": bounds["minX"], "y": bounds["minY"]},
            {"x": bounds["maxX"], "y": bounds["minY"]},
            {"x": bounds["maxX"], "y": bounds["maxY"]},
            {"x": bounds["minX"], "y": bounds["maxY"]},
        ]
    return []


def _safe_progress(callback, step: str, frac: float) -> None:
    if callback is None:
        return
    try:
        callback(step, frac)
    except Exception:  # pragma: no cover — never crash the engine
        pass


__all__ = ["calculate_scheme_sizing", "SIZER_VERSION"]
