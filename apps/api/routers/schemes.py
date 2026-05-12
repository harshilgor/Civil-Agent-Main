"""Scheme CRUD + generation routes (Agent 3).

Mirrors the patterns in ``apps/api/routers/geometry.py``:

* tenant isolation via ``project_dep`` (404 for cross-tenant);
* structured ``{code, message, context}`` error envelope;
* enqueue-then-return for long-running work (the actual constraint
  satisfaction runs in the worker, not the request handler).

Regeneration policy: archiving prior schemes happens in the worker,
not here. The API just enqueues the job and trusts the worker to
flip ``status='archived'`` on the previous batch before writing the
new one. That keeps the API request handler fast and avoids
race-y partial states.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy import desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from apps.api.core.auth import CurrentUser, project_dep
from apps.api.core.config import Settings, get_settings
from apps.api.core.db import (
    AuditLog,
    ParsedGeometryRow,
    Project,
    SchemeRow,
    get_session,
)
from apps.api.core.errors import Conflict, NotFound, UnprocessableEntity
from apps.api.core.logging_config import get_logger
from apps.api.schemas import (
    GenerateJobResponse,
    GenerateSchemeRequest,
    SchemeListResponse,
    SchemeStatusUpdate,
)
from packages.engine.column_generator.models import StructuralScheme

router = APIRouter(prefix="/api/projects/{project_id}/schemes", tags=["schemes"])
log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Trigger generation
# ---------------------------------------------------------------------------


@router.post(
    "/generate",
    response_model=GenerateJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def generate_schemes_route(
    body: GenerateSchemeRequest,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> GenerateJobResponse:
    geometry = await _resolve_geometry(session, project.id, body.geometry_id)
    if geometry is None:
        raise NotFound(
            "GEOMETRY_NOT_FOUND",
            "No parsed geometry available for this project.",
        )
    if geometry.parse_status not in ("completed", "partial"):
        raise UnprocessableEntity(
            "GEOMETRY_NOT_READY",
            "Geometry must be in completed or partial status before scheme generation.",
            parse_status=geometry.parse_status,
        )

    constraints_payload: dict | None = None
    if body.constraints is not None:
        constraints_payload = body.constraints.model_dump(mode="json", by_alias=False)

    job_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())

    # Audit the trigger before enqueue so we always have a record even
    # if the worker crashes immediately.
    session.add(
        AuditLog(
            id=str(uuid.uuid4()),
            project_id=project.id,
            event_type="scheme_generation",
            user_id=principal.user_id,
            payload={
                "job_id": job_id,
                "generation_run_id": run_id,
                "geometry_id": geometry.id,
                "constraints": constraints_payload,
            },
        )
    )
    await session.commit()

    from arq import create_pool
    from arq.connections import RedisSettings as ArqRedis

    pool = await create_pool(ArqRedis.from_dsn(settings.redis_url))
    try:
        await pool.enqueue_job(
            "generate_schemes_job",
            project_id=project.id,
            geometry_id=geometry.id,
            run_id=run_id,
            org_id=principal.org_id,
            user_id=principal.user_id,
            constraints=constraints_payload,
            _job_id=job_id,
        )
    finally:
        await pool.close()

    log.info(
        "schemes.enqueued",
        project_id=project.id,
        geometry_id=geometry.id,
        job_id=job_id,
        run_id=run_id,
    )
    return GenerateJobResponse(
        job_id=job_id,
        geometry_id=geometry.id,
        generation_run_id=run_id,
        status="queued",
    )


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


@router.get("", response_model=SchemeListResponse)
async def list_schemes(
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
    geometry_id: str | None = None,
    include_archived: bool = False,
) -> SchemeListResponse:
    target_geometry_id = geometry_id
    if target_geometry_id is None:
        latest = await _resolve_geometry(session, project.id, None)
        if latest is not None:
            target_geometry_id = latest.id

    if target_geometry_id is None:
        return SchemeListResponse(schemes=[], geometry_id=None, generation_run_id=None)

    q = select(SchemeRow).where(
        SchemeRow.project_id == project.id,
        SchemeRow.geometry_id == target_geometry_id,
    )
    if not include_archived:
        q = q.where(SchemeRow.status != "archived")
    q = q.order_by(desc(SchemeRow.score), SchemeRow.display_label)

    rows = (await session.scalars(q)).all()
    schemes = [_row_to_scheme(r) for r in rows]
    run_id = rows[0].generation_run_id if rows else None
    return SchemeListResponse(
        schemes=schemes,
        geometry_id=target_geometry_id,
        generation_run_id=run_id,
    )


# ---------------------------------------------------------------------------
# Single scheme
# ---------------------------------------------------------------------------


@router.get("/{scheme_id}", response_model=StructuralScheme)
async def get_scheme(
    scheme_id: str,
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StructuralScheme:
    row = await _load_scheme_for_project(session, project.id, scheme_id)
    return _row_to_scheme(row)


@router.patch("/{scheme_id}", response_model=StructuralScheme)
async def update_scheme(
    scheme_id: str,
    body: SchemeStatusUpdate,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StructuralScheme:
    row = await _load_scheme_for_project(session, project.id, scheme_id)
    if row.status == "archived":
        raise Conflict(
            "SCHEME_ARCHIVED",
            "Cannot activate an archived scheme.",
            scheme_id=scheme_id,
        )

    # Demote every other (non-archived) scheme for this geometry to alternate.
    await session.execute(
        update(SchemeRow)
        .where(
            SchemeRow.project_id == project.id,
            SchemeRow.geometry_id == row.geometry_id,
            SchemeRow.id != scheme_id,
            SchemeRow.status == "active",
        )
        .values(status="alternate", updated_at=datetime.now(timezone.utc))
    )
    row.status = "active"
    row.updated_at = datetime.now(timezone.utc)

    session.add(
        AuditLog(
            id=str(uuid.uuid4()),
            project_id=project.id,
            event_type="scheme_activated",
            user_id=principal.user_id,
            payload={
                "scheme_id": scheme_id,
                "geometry_id": row.geometry_id,
                "strategy": row.strategy,
                "display_label": row.display_label,
            },
        )
    )
    await session.commit()

    log.info(
        "schemes.activated",
        project_id=project.id,
        scheme_id=scheme_id,
        user_id=principal.user_id,
    )
    return _row_to_scheme(row)


@router.delete("/{scheme_id}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_scheme(
    scheme_id: str,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    row = await _load_scheme_for_project(session, project.id, scheme_id)
    row.status = "archived"
    row.updated_at = datetime.now(timezone.utc)

    session.add(
        AuditLog(
            id=str(uuid.uuid4()),
            project_id=project.id,
            event_type="scheme_archived",
            user_id=principal.user_id,
            payload={"scheme_id": scheme_id, "geometry_id": row.geometry_id},
        )
    )
    await session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _resolve_geometry(
    session: AsyncSession,
    project_id: str,
    requested_id: str | None,
) -> ParsedGeometryRow | None:
    if requested_id is not None:
        row = await session.get(ParsedGeometryRow, requested_id)
        if row is None or row.project_id != project_id:
            return None
        return row

    # Latest accepted → completed → partial → processing → failed
    base = select(ParsedGeometryRow).where(ParsedGeometryRow.project_id == project_id)
    for review, parse in (
        ("accepted", None),
        (None, "completed"),
        (None, "partial"),
        (None, "processing"),
        (None, "failed"),
    ):
        q = base
        if review is not None:
            q = q.where(ParsedGeometryRow.review_status == review)
        if parse is not None:
            q = q.where(ParsedGeometryRow.parse_status == parse)
        row = await session.scalar(q.order_by(desc(ParsedGeometryRow.version)).limit(1))
        if row is not None:
            return row
    return None


async def _load_scheme_for_project(
    session: AsyncSession,
    project_id: str,
    scheme_id: str,
) -> SchemeRow:
    row = await session.get(SchemeRow, scheme_id)
    if row is None or row.project_id != project_id:
        # 404 on cross-tenant access — never leak existence.
        raise NotFound("SCHEME_NOT_FOUND", "Scheme not found.")
    return row


def _row_to_scheme(row: SchemeRow) -> StructuralScheme:
    """Reconstruct the engine model from a database row.

    The ``columns_data``/``beams_data``/``metrics`` columns are stored
    as JSON in the same shape the engine emits (snake_case keys with
    aliases recognised), so Pydantic ``model_validate`` reconstructs
    cleanly. We pass ``populate_by_name`` via the model config so
    either casing works at parse time.
    """
    payload: dict[str, Any] = {
        "id": row.id,
        "display_label": row.display_label,
        "name": row.name,
        "strategy": row.strategy,
        "description": row.description or "",
        "columns": row.columns_data or [],
        "beams": row.beams_data or [],
        "shear_walls": row.shear_walls_data or [],
        "braces": row.braces_data or [],
        "metrics": row.metrics or {},
        "status": row.status,
        "score": row.score,
    }
    return StructuralScheme.model_validate(payload)


__all__ = ["router"]
