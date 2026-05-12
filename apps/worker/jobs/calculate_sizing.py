"""ARQ job: calculate gravity loads and size members for a scheme.

Lifecycle:

1. Fetch the scheme + its parsed geometry from Postgres. Cross-tenant
   safety is the API's responsibility — by this point the project_id
   was validated when the API enqueued us.
2. Fetch the project's stored assumptions (or fall back to engine
   defaults if absent / overridden by the request body).
3. Run :func:`calculate_scheme_sizing` on the deserialised payloads.
4. In a single transaction:
     * delete existing ``member_checks`` and ``column_takedowns``
       rows for this scheme (recalculation policy: fresh batch each
       run);
     * insert the new ``member_checks`` rows;
     * insert the new ``column_takedowns`` rows;
     * patch ``schemes.metrics`` with the Agent 4 fields, leaving
       Agent 3's fields intact;
     * flip ``schemes.sizing_status = 'sized'``, set ``sized_at``;
     * write an ``audit_log`` row noting the run id, scheme summary,
       and elapsed ms.
5. Stream progress on the scheme-scoped Redis channel
   ``sizing-progress:{scheme_id}`` so the frontend WebSocket can
   render a live progress bar without cross-talk between schemes.

Error handling: any exception in the engine flips ``sizing_status``
back to ``'failed'`` and emits a terminal failure event so the UI
clears the spinner and shows a retry button.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import delete, select

from apps.api.core.db import (
    AsyncSessionLocal,
    AuditLog,
    ColumnTakedownRow,
    MemberCheckRow,
    ParsedGeometryRow,
    ProjectAssumptionsRow,
    SchemeRow,
)
from apps.api.core.logging_config import configure_logging, get_logger
from apps.api.core.redis_client import sizing_progress_sink_for
from packages.engine.geometry_parser.progress import ProgressTracker
from packages.engine.member_sizer import (
    SIZER_VERSION,
    SizingAssumptions,
    SizingResult,
    calculate_scheme_sizing,
)


log = get_logger(__name__)


SIZING_PROGRESS_STEPS = (
    "init",
    "tributary",
    "beam_sizing",
    "column_takedown",
    "metrics",
    "persist",
    "complete",
)

# Equal weight per step is fine — sizing is fast (<5s typical for an
# 8-story building). The frontend renders a step list, not a smooth
# bar, so weight skew doesn't matter.
_STEP_WEIGHTS = {s: 1.0 / len(SIZING_PROGRESS_STEPS) for s in SIZING_PROGRESS_STEPS}


async def calculate_sizing_job(
    ctx: dict[str, Any],
    *,
    project_id: str,
    scheme_id: str,
    sizing_run_id: str,
    org_id: str,
    user_id: Optional[str] = None,
    assumptions: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """ARQ entrypoint."""
    configure_logging(service="civilagent.worker")
    job_id: str = ctx.get("job_id", "")
    start_wall = time.monotonic()
    sink = sizing_progress_sink_for(scheme_id)

    # The ProgressTracker was originally built for the parser, where
    # the second positional id is the "geometry id" used as a
    # transport label. Here we substitute the scheme id; it's never
    # echoed back as anything other than the WS key, so the rename
    # is local to this site.
    tracker = ProgressTracker(
        job_id=job_id,
        geometry_id=scheme_id,
        sink=sink,
        steps=SIZING_PROGRESS_STEPS,
        weights=_STEP_WEIGHTS,
    )

    log.info(
        "sizing_worker.start",
        job_id=job_id,
        sizing_run_id=sizing_run_id,
        project_id=project_id,
        scheme_id=scheme_id,
        org_id=org_id,
        sizer_version=SIZER_VERSION,
    )

    try:
        await tracker.start_step("init", detail="Loading scheme...")

        # ----- Fetch scheme + geometry + assumptions ------------------
        async with AsyncSessionLocal() as session:
            scheme_row = await session.get(SchemeRow, scheme_id)
            if scheme_row is None or scheme_row.project_id != project_id:
                await _terminal_failure(
                    tracker, "init", "Scheme not found.", "SCHEME_NOT_FOUND"
                )
                return {"status": "failed", "error": "SCHEME_NOT_FOUND"}

            geometry_row = await session.get(
                ParsedGeometryRow, scheme_row.geometry_id
            )
            if geometry_row is None:
                await _terminal_failure(
                    tracker, "init", "Geometry not found.", "GEOMETRY_NOT_FOUND"
                )
                # Still flip the scheme back to failed below.
                await _mark_scheme_failed(scheme_id, project_id)
                return {"status": "failed", "error": "GEOMETRY_NOT_FOUND"}

            scheme_payload = _scheme_row_to_engine_input(scheme_row)
            geometry_payload = geometry_row.geometry_data or {}

            # Resolve assumptions: explicit body > project_assumptions > defaults.
            project_assumptions = (
                await session.scalar(
                    select(ProjectAssumptionsRow).where(
                        ProjectAssumptionsRow.project_id == project_id
                    )
                )
            )

        a = _resolve_assumptions(assumptions, project_assumptions)

        await tracker.complete_step("init", detail="Inputs loaded.")

        # ----- Run the engine ----------------------------------------
        await tracker.start_step("tributary", detail="Computing tributary areas...")

        progress_state = {"current_step": "tributary"}

        def on_progress(step: str, frac: float) -> None:
            # The engine emits step names like "beam_sizing:3/30" — we
            # collapse them to the high-level step the tracker knows
            # about (beam_sizing, column_sizing, metrics, ...). Errors
            # here are swallowed by the engine's safe-progress wrapper.
            high_level = step.split(":", 1)[0]
            if high_level in SIZING_PROGRESS_STEPS and high_level != progress_state["current_step"]:
                progress_state["current_step"] = high_level

        result: SizingResult = calculate_scheme_sizing(
            scheme_payload,
            geometry_payload,
            a,
            progress_callback=on_progress,
        )

        await tracker.complete_step(
            "tributary", detail=f"{len(result.beam_summaries)} beams analysed."
        )
        await tracker.start_step(
            "beam_sizing",
            detail=f"Sized {len(result.beam_summaries)} beams.",
        )
        await tracker.complete_step("beam_sizing")

        await tracker.start_step(
            "column_takedown",
            detail=f"Sized {len(result.column_summaries)} columns.",
        )
        await tracker.complete_step("column_takedown")

        await tracker.start_step("metrics", detail="Aggregating metrics...")
        await tracker.complete_step("metrics")

        # ----- Persist ----------------------------------------------
        await tracker.start_step("persist", detail="Writing results...")

        async with AsyncSessionLocal() as session:
            # Recalc policy: blow away any prior rows for this scheme.
            await session.execute(
                delete(MemberCheckRow).where(
                    MemberCheckRow.scheme_id == scheme_id
                )
            )
            await session.execute(
                delete(ColumnTakedownRow).where(
                    ColumnTakedownRow.scheme_id == scheme_id
                )
            )

            # All-checks rows.
            for summary in result.beam_summaries + result.column_summaries:
                for check in summary.all_checks:
                    session.add(_check_to_row(check))

            # Takedown rows.
            for entry in result.column_takedowns:
                session.add(_takedown_to_row(scheme_id, entry))

            # Patch scheme.metrics — preserve Agent 3 fields.
            scheme_row = await session.get(SchemeRow, scheme_id)
            if scheme_row is not None:
                merged_metrics = dict(scheme_row.metrics or {})
                updates = result.updated_metrics.model_dump(by_alias=True)
                # Preserve None for fields the engine intentionally
                # left out (concrete_volume, max_drift). Don't
                # overwrite existing values with None unless the
                # engine returned a real value.
                for k, v in updates.items():
                    if v is not None:
                        merged_metrics[k] = v
                scheme_row.metrics = merged_metrics
                scheme_row.sizing_status = "sized"
                scheme_row.sized_at = datetime.now(timezone.utc)
                scheme_row.updated_at = datetime.now(timezone.utc)

            session.add(
                AuditLog(
                    id=str(uuid.uuid4()),
                    project_id=project_id,
                    event_type="sizing_calculation_complete",
                    user_id=user_id,
                    payload={
                        "job_id": job_id,
                        "sizing_run_id": sizing_run_id,
                        "scheme_id": scheme_id,
                        "beam_count": len(result.beam_summaries),
                        "column_count": len(result.column_summaries),
                        "steel_tonnage": result.updated_metrics.steel_tonnage,
                        "calculation_time_ms": result.calculation_time_ms,
                        "warnings": result.warnings[:50],
                        "sizer_version": SIZER_VERSION,
                    },
                )
            )

            await session.commit()

        await tracker.complete_step("persist")

        await tracker.emit_terminal(
            status="completed",
            detail=(
                f"Sized {len(result.beam_summaries)} beams, "
                f"{len(result.column_summaries)} columns "
                f"in {result.calculation_time_ms:.0f} ms."
            ),
        )

        duration_ms = int((time.monotonic() - start_wall) * 1000)
        log.info(
            "sizing_worker.complete",
            job_id=job_id,
            scheme_id=scheme_id,
            beam_count=len(result.beam_summaries),
            column_count=len(result.column_summaries),
            duration_ms=duration_ms,
            warnings=len(result.warnings),
        )
        return {
            "status": "completed",
            "beam_count": len(result.beam_summaries),
            "column_count": len(result.column_summaries),
            "duration_ms": duration_ms,
        }

    except Exception as exc:  # noqa: BLE001 — top-level safety net
        log.exception(
            "sizing_worker.unhandled",
            job_id=job_id,
            scheme_id=scheme_id,
        )
        try:
            await tracker.emit_terminal(
                status="failed",
                detail=f"{type(exc).__name__}: {exc}",
                error_code="INTERNAL_ERROR",
            )
        except Exception:  # pragma: no cover — best effort
            pass
        await _mark_scheme_failed(scheme_id, project_id)
        return {"status": "failed", "error": str(exc)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _terminal_failure(
    tracker: ProgressTracker,
    step: str,
    detail: str,
    error_code: str,
) -> None:
    try:
        await tracker.fail_step(
            step, detail=detail, error_code=error_code, terminal=False
        )
    except Exception:
        pass
    try:
        await tracker.emit_terminal(
            status="failed", detail=detail, error_code=error_code
        )
    except Exception:
        pass


async def _mark_scheme_failed(scheme_id: str, project_id: str) -> None:
    """Best-effort: flip sizing_status back so the UI doesn't get stuck
    on the spinner."""
    try:
        async with AsyncSessionLocal() as session:
            row = await session.get(SchemeRow, scheme_id)
            if row is None or row.project_id != project_id:
                return
            row.sizing_status = "failed"
            row.updated_at = datetime.now(timezone.utc)
            await session.commit()
    except Exception:
        log.exception("sizing_worker.mark_failed_failed", scheme_id=scheme_id)


def _resolve_assumptions(
    body_payload: dict | None,
    project_row: ProjectAssumptionsRow | None,
) -> SizingAssumptions:
    """Layered assumption resolution: body > project row > defaults."""
    if body_payload:
        return SizingAssumptions.model_validate(body_payload)
    if project_row is not None and project_row.assumptions_data:
        try:
            return SizingAssumptions.model_validate(
                project_row.assumptions_data
            )
        except Exception:
            log.warning(
                "sizing_worker.assumptions_invalid",
                project_id=project_row.project_id,
            )
    return SizingAssumptions()


def _scheme_row_to_engine_input(row: SchemeRow) -> dict[str, Any]:
    """Reconstruct the dict shape the engine consumes from a SchemeRow.

    The engine accepts both the camelCase JSON and snake_case dicts —
    the JSONB columns are stored in the engine's snake_case shape so
    we can pass them through directly with light shaping.
    """
    return {
        "id": row.id,
        "displayLabel": row.display_label,
        "name": row.name,
        "strategy": row.strategy,
        "description": row.description,
        "columns": row.columns_data or [],
        "beams": row.beams_data or [],
        "shearWalls": row.shear_walls_data or [],
        "braces": row.braces_data or [],
        "metrics": row.metrics or {},
        "status": row.status,
    }


def _check_to_row(check) -> MemberCheckRow:
    return MemberCheckRow(
        id=check.id,
        scheme_id=check.scheme_id,
        member_id=check.member_id,
        member_type=check.member_type,
        selected_size=check.selected_size,
        check_type=check.check_type,
        demand=check.demand,
        capacity=check.capacity,
        dcr=check.dcr,
        status=check.status,
        governing=check.governing,
        load_combination=check.load_combination or None,
        explanation=check.explanation or None,
        demand_unit=check.demand_unit or None,
        capacity_unit=check.capacity_unit or None,
        warnings=list(check.warnings or []),
    )


def _takedown_to_row(scheme_id: str, entry) -> ColumnTakedownRow:
    return ColumnTakedownRow(
        id=str(uuid.uuid4()),
        scheme_id=scheme_id,
        column_id=entry.column_id,
        level_id=entry.level_id,
        level_name=entry.level_name,
        level_index_from_top=entry.level_index_from_top,
        tributary_area_sf=entry.tributary_area_sf,
        cumulative_tributary_area_sf=entry.cumulative_tributary_area_sf,
        dead_load_kip=entry.dead_load_kip,
        live_load_kip=entry.live_load_kip,
        live_load_unreduced_kip=entry.live_load_unreduced_kip,
        reduction_factor=entry.reduction_factor,
        factored_load_kip=entry.factored_load_kip,
        governing_combination=entry.governing_combination,
    )


calculate_sizing_job.__qualname__ = "calculate_sizing_job"


__all__ = ["calculate_sizing_job", "SIZING_PROGRESS_STEPS"]
