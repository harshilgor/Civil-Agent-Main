"""ARQ job: generate column-layout scheme variants.

Lifecycle:

1. Look up the parsed geometry row from Postgres (tenant-scoped via
   the API; the worker trusts the project-id contract here).
2. Run :func:`generate_schemes` on the deserialised geometry payload.
3. Open a single transaction:
     - flip every prior, non-archived scheme for the same
       ``geometry_id`` to ``status='archived'``;
     - insert one new ``schemes`` row per generated variant;
     - append a ``audit_log`` event noting completion.
4. Stream progress events on the same Redis channel the parse job
   uses, so the frontend can reuse its existing WebSocket plumbing.

The worker is the single source of truth for archiving previous
schemes — the API endpoint only enqueues. That keeps generation
atomic: if the worker crashes mid-run, the prior schemes survive.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select, update

from apps.api.core.db import (
    AsyncSessionLocal,
    AuditLog,
    ParsedGeometryRow,
    SchemeRow,
)
from apps.api.core.logging_config import configure_logging, get_logger
from apps.api.core.redis_client import progress_sink_for
from packages.engine.column_generator import (
    GenerationConstraints,
    generate_schemes,
)
from packages.engine.column_generator.models import StructuralScheme
from packages.engine.geometry_parser.progress import ProgressTracker

log = get_logger(__name__)


# Step names — re-used for progress events. We don't need every parser
# step here; the scheme generator is fast enough that one progress
# update per strategy is plenty.
SCHEME_PROGRESS_STEPS = (
    "init",
    "balanced",
    "minimum_columns",
    "short_span",
    "offset_grid",
    "long_span",
    "scoring",
    "complete",
)


async def generate_schemes_job(
    ctx: dict[str, Any],
    *,
    project_id: str,
    geometry_id: str,
    run_id: str,
    org_id: str,
    user_id: Optional[str] = None,
    constraints: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """ARQ entrypoint."""
    configure_logging(service="civilagent.worker")
    job_id: str = ctx.get("job_id", "")
    start_wall = time.monotonic()
    sink = progress_sink_for(geometry_id)
    tracker = ProgressTracker(
        job_id=job_id,
        geometry_id=geometry_id,
        sink=sink,
        steps=SCHEME_PROGRESS_STEPS,
        weights={s: 1.0 / len(SCHEME_PROGRESS_STEPS) for s in SCHEME_PROGRESS_STEPS},
    )

    log.info(
        "scheme_worker.start",
        job_id=job_id,
        run_id=run_id,
        project_id=project_id,
        geometry_id=geometry_id,
        org_id=org_id,
    )

    try:
        await tracker.start_step("init", detail="Loading parsed geometry...")

        async with AsyncSessionLocal() as session:
            geometry_row = await session.get(ParsedGeometryRow, geometry_id)
            if geometry_row is None or geometry_row.project_id != project_id:
                await tracker.fail_step(
                    "init",
                    detail="Geometry not found.",
                    error_code="GEOMETRY_NOT_FOUND",
                    terminal=False,
                )
                await tracker.emit_terminal(
                    status="failed",
                    detail="Geometry not found for project.",
                    error_code="GEOMETRY_NOT_FOUND",
                )
                return {"status": "failed", "error": "GEOMETRY_NOT_FOUND"}
            geometry_payload = geometry_row.geometry_data or {}

        if not geometry_payload:
            await tracker.fail_step(
                "init",
                detail="Geometry payload is empty — cannot generate schemes.",
                error_code="GEOMETRY_EMPTY",
                terminal=False,
            )
            await tracker.emit_terminal(
                status="failed",
                detail="Geometry payload empty.",
                error_code="GEOMETRY_EMPTY",
            )
            return {"status": "failed", "error": "GEOMETRY_EMPTY"}

        await tracker.complete_step("init", detail="Geometry loaded.")

        # Materialise constraints. ``model_validate`` accepts both
        # camelCase aliases (from the API request) and snake_case so
        # callers in either dialect work.
        constraints_obj = (
            GenerationConstraints.model_validate(constraints)
            if constraints
            else GenerationConstraints()
        )

        # Stream a progress event per strategy. We can't easily hook
        # into the engine's per-strategy loop without changing its
        # signature, so we run it once and spread synthetic events
        # across the strategies the engine produced.
        schemes = generate_schemes(geometry_payload, constraints_obj)

        for spec_step in (
            "balanced",
            "minimum_columns",
            "short_span",
            "offset_grid",
            "long_span",
        ):
            try:
                await tracker.start_step(spec_step, detail=f"Generating {spec_step}...")
                await tracker.complete_step(spec_step)
            except ValueError:
                # Constraints may filter strategies — ignore unknowns.
                pass

        await tracker.start_step("scoring", detail="Scoring and ranking variants...")
        await tracker.complete_step("scoring")

        # Persist + archive previous run in a single transaction.
        async with AsyncSessionLocal() as session:
            await session.execute(
                update(SchemeRow)
                .where(
                    SchemeRow.project_id == project_id,
                    SchemeRow.geometry_id == geometry_id,
                    SchemeRow.status != "archived",
                )
                .values(status="archived", updated_at=datetime.now(timezone.utc))
            )
            for scheme in schemes:
                row = _scheme_to_row(
                    scheme,
                    project_id=project_id,
                    geometry_id=geometry_id,
                    generation_run_id=run_id,
                    constraints_payload=constraints,
                )
                session.add(row)

            session.add(
                AuditLog(
                    id=str(uuid.uuid4()),
                    project_id=project_id,
                    event_type="scheme_generation_complete",
                    user_id=user_id,
                    payload={
                        "job_id": job_id,
                        "generation_run_id": run_id,
                        "geometry_id": geometry_id,
                        "scheme_count": len(schemes),
                        "active_strategy": next(
                            (s.strategy for s in schemes if s.status == "active"),
                            None,
                        ),
                        "duration_ms": int((time.monotonic() - start_wall) * 1000),
                    },
                )
            )
            await session.commit()

        await tracker.emit_terminal(
            status="completed",
            detail=f"Generated {len(schemes)} schemes.",
        )

        duration_ms = int((time.monotonic() - start_wall) * 1000)
        log.info(
            "scheme_worker.complete",
            job_id=job_id,
            geometry_id=geometry_id,
            scheme_count=len(schemes),
            duration_ms=duration_ms,
        )
        return {
            "status": "completed",
            "scheme_count": len(schemes),
            "duration_ms": duration_ms,
        }

    except Exception as exc:  # noqa: BLE001 — top-level safety net
        log.exception(
            "scheme_worker.unhandled",
            job_id=job_id,
            geometry_id=geometry_id,
        )
        try:
            await tracker.emit_terminal(
                status="failed",
                detail=f"{type(exc).__name__}: {exc}",
                error_code="INTERNAL_ERROR",
            )
        except Exception:  # pragma: no cover — best effort
            pass
        return {"status": "failed", "error": str(exc)}


_DB_SCHEME_NS = uuid.UUID("9b3d5cf8-d11e-4b25-8e76-2c7d4a72f1a0")


def _scheme_to_row(
    scheme: StructuralScheme,
    *,
    project_id: str,
    geometry_id: str,
    generation_run_id: str,
    constraints_payload: dict | None,
) -> SchemeRow:
    """Serialize a :class:`StructuralScheme` into a :class:`SchemeRow`.

    The engine produces deterministic scheme ids derived from
    (strategy, geometry_hash) — useful for the engine's own
    determinism guarantee. But the database PK has to change between
    regeneration runs (we INSERT new rows; we don't UPDATE). We mix
    ``generation_run_id`` into a fresh UUID5 here so each run
    produces its own row identities while remaining deterministic
    *within* a run.

    JSON columns are stored using the engine's snake_case shape so
    round-trips are lossless. ``_row_to_scheme`` in the router re-
    materialises them.
    """
    db_id = str(uuid.uuid5(_DB_SCHEME_NS, f"{generation_run_id}|{scheme.id}"))
    return SchemeRow(
        id=db_id,
        project_id=project_id,
        geometry_id=geometry_id,
        display_label=scheme.display_label,
        name=scheme.name,
        strategy=scheme.strategy,
        description=scheme.description or "",
        status=scheme.status,
        columns_data=[c.model_dump(mode="json") for c in scheme.columns],
        beams_data=[b.model_dump(mode="json") for b in scheme.beams],
        shear_walls_data=[w.model_dump(mode="json") for w in scheme.shear_walls],
        braces_data=[br.model_dump(mode="json") for br in scheme.braces],
        metrics=scheme.metrics.model_dump(mode="json"),
        score=scheme.score,
        constraints_used=constraints_payload,
        generation_run_id=generation_run_id,
    )


# ARQ requires the function to be referenced by name in worker settings.
generate_schemes_job.__qualname__ = "generate_schemes_job"


__all__ = ["generate_schemes_job"]
