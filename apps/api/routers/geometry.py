"""Geometry parse + retrieval routes."""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from apps.api.core.auth import CurrentUser, project_dep
from apps.api.core.config import Settings, get_settings
from apps.api.core.db import (
    ParsedGeometryRow,
    Project,
    ProjectFile,
    get_session,
)
from apps.api.core.errors import BadRequest, Conflict, NotFound, UnprocessableEntity
from apps.api.core.logging_config import get_logger
from apps.api.core.metrics import PARSE_REQUESTS_TOTAL
from apps.api.core.s3 import presign_download
from apps.api.schemas import (
    FileDownloadUrlResponse,
    GeometryAcceptRequest,
    GeometryResponse,
    ParseTriggerRequest,
    ParseTriggerResponse,
)
from packages.engine.geometry_parser.constants import (
    PARSER_VERSION,
    SCHEMA_VERSION,
)
from packages.engine.geometry_parser.ids import idempotency_key as build_idempotency_key
from packages.engine.geometry_parser.models import ParsedGeometry

router = APIRouter(prefix="/api/projects/{project_id}/geometry", tags=["geometry"])
log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Trigger parse
# ---------------------------------------------------------------------------


@router.post(
    "/parse",
    response_model=ParseTriggerResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_parse(
    body: ParseTriggerRequest,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ParseTriggerResponse:
    pf = await session.get(ProjectFile, body.fileId)
    if pf is None or pf.project_id != project.id:
        raise NotFound("FILE_NOT_FOUND", "File not registered for this project.")
    if not pf.file_sha256:
        raise UnprocessableEntity(
            "FILE_HASH_MISSING",
            "File hash unknown — call POST /files/{file_id}/registered first.",
        )

    force_token = secrets.token_hex(8) if body.force else None
    options_dict: dict = {}
    if body.options is not None:
        options_dict = body.options.model_dump(exclude_none=True)
    if pf.file_format != "pdf" and "pageNumber" in options_dict:
        # Don't poison the idempotency key with a knob the parser will
        # silently ignore for this format.
        options_dict.pop("pageNumber", None)

    key = build_idempotency_key(
        file_sha256=pf.file_sha256,
        parser_version=PARSER_VERSION,
        project_id=project.id,
        force_token=force_token,
        options=options_dict or None,
    )

    existing = await session.scalar(
        select(ParsedGeometryRow).where(
            ParsedGeometryRow.project_id == project.id,
            ParsedGeometryRow.idempotency_key == key,
        )
    )
    if existing is not None and existing.parse_status in {
        "processing",
        "completed",
        "partial",
    }:
        log.info(
            "parse.deduped",
            project_id=project.id,
            file_id=pf.id,
            geometry_id=existing.id,
            parse_status=existing.parse_status,
        )
        PARSE_REQUESTS_TOTAL.labels(
            project_id_kind="org", format=pf.file_format, outcome="deduped"
        ).inc()
        return ParseTriggerResponse(
            jobId=existing.job_id or "",
            geometryId=existing.id,
            status="deduped",
            idempotencyKey=key,
        )

    geometry_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())

    next_version = await _next_version(session, project.id)
    row = ParsedGeometryRow(
        id=geometry_id,
        project_id=project.id,
        source_file_id=pf.id,
        version=next_version,
        parse_status="processing",
        review_status="pending",
        geometry_data={},
        parser_version=PARSER_VERSION,
        schema_version=SCHEMA_VERSION,
        run_id=run_id,
        job_id=job_id,
        idempotency_key=key,
        parse_options=options_dict or None,
    )
    session.add(row)
    await session.flush()  # ensure unique index is checked before enqueue

    # Enqueue inside the same transaction's "after-commit" semantics.
    from arq import create_pool
    from arq.connections import RedisSettings as ArqRedis

    pool = await create_pool(ArqRedis.from_dsn(settings.redis_url))
    try:
        await pool.enqueue_job(
            "parse_geometry_job",
            project_id=project.id,
            file_id=pf.id,
            geometry_id=geometry_id,
            run_id=run_id,
            org_id=principal.org_id,
            parse_options=options_dict or None,
            _job_id=job_id,
        )
    finally:
        await pool.close()

    await session.commit()

    PARSE_REQUESTS_TOTAL.labels(
        project_id_kind="org", format=pf.file_format, outcome="queued"
    ).inc()
    log.info(
        "parse.enqueued",
        project_id=project.id,
        file_id=pf.id,
        geometry_id=geometry_id,
        job_id=job_id,
        run_id=run_id,
        idempotency_key=key,
    )
    return ParseTriggerResponse(
        jobId=job_id,
        geometryId=geometry_id,
        status="queued",
        idempotencyKey=key,
    )


async def _next_version(session: AsyncSession, project_id: str) -> int:
    last = await session.scalar(
        select(ParsedGeometryRow.version)
        .where(ParsedGeometryRow.project_id == project_id)
        .order_by(desc(ParsedGeometryRow.version))
        .limit(1)
    )
    return (last or 0) + 1


# ---------------------------------------------------------------------------
# Retrieval — latest accepted, then completed, then processing
# ---------------------------------------------------------------------------


@router.get("", response_model=GeometryResponse)
async def get_latest_geometry(
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> GeometryResponse:
    row = await _resolve_latest(session, project.id)
    if row is None:
        raise NotFound("GEOMETRY_NOT_FOUND", "No parse runs exist for this project.")
    return _row_to_response(row)


async def _resolve_latest(session: AsyncSession, project_id: str) -> ParsedGeometryRow | None:
    """Documented precedence: accepted → completed → partial → processing → failed.

    Versions break ties so the engineer's most recent acceptance always
    wins.
    """
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


@router.get("/{geometry_id}", response_model=GeometryResponse)
async def get_geometry_version(
    geometry_id: str,
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> GeometryResponse:
    row = await session.get(ParsedGeometryRow, geometry_id)
    if row is None or row.project_id != project.id:
        raise NotFound("GEOMETRY_NOT_FOUND", "Geometry not found.")
    return _row_to_response(row)


# ---------------------------------------------------------------------------
# Acceptance state machine
# ---------------------------------------------------------------------------


_VALID_ACCEPT_TRANSITIONS = {
    ("completed", "pending"),
    ("partial", "pending"),
}


@router.patch("/{geometry_id}/accept", response_model=GeometryResponse)
async def accept_geometry(
    geometry_id: str,
    body: GeometryAcceptRequest,  # noqa: ARG001 — note reserved for future audit field
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> GeometryResponse:
    row = await session.get(ParsedGeometryRow, geometry_id)
    if row is None or row.project_id != project.id:
        raise NotFound("GEOMETRY_NOT_FOUND", "Geometry not found.")
    if (row.parse_status, row.review_status) not in _VALID_ACCEPT_TRANSITIONS:
        raise Conflict(
            "INVALID_STATE_TRANSITION",
            "Cannot accept geometry in current state.",
            parse_status=row.parse_status,
            review_status=row.review_status,
        )

    # Supersede any previously accepted version for this project.
    prior = await session.scalars(
        select(ParsedGeometryRow).where(
            ParsedGeometryRow.project_id == project.id,
            ParsedGeometryRow.review_status == "accepted",
        )
    )
    for p in prior.all():
        p.review_status = "superseded"

    row.review_status = "accepted"
    row.accepted_at = datetime.now(timezone.utc)
    row.accepted_by = principal.user_id
    await session.commit()

    log.info(
        "geometry.accepted",
        project_id=project.id,
        geometry_id=geometry_id,
        accepted_by=principal.user_id,
    )
    return _row_to_response(row)


# ---------------------------------------------------------------------------
# Source-file download URL — geometry-scoped
# ---------------------------------------------------------------------------


@router.get(
    "/{geometry_id}/source-file-url",
    response_model=FileDownloadUrlResponse,
)
async def get_geometry_source_file_url(
    geometry_id: str,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> FileDownloadUrlResponse:
    """Return a presigned S3 GET URL for the original source file that was
    parsed into this geometry version.

    Resolution order:
    1. ``ParsedGeometryRow.source_file_id`` — the authoritative FK set by
       the parse worker at job time.  When the file row is deleted the FK
       is SET NULL automatically, so we always know if it is gone.
    2. Most-recently-uploaded IFC file for the project — fallback used
       when the original ``ProjectFile`` row no longer exists (e.g. after
       a DB migration or manual cleanup) but a newer upload is present.

    Returns ``SOURCE_FILE_NOT_FOUND`` (404) when neither path finds an IFC.
    """
    row = await session.get(ParsedGeometryRow, geometry_id)
    if row is None or row.project_id != project.id:
        raise NotFound("GEOMETRY_NOT_FOUND", "Geometry not found.")

    pf: ProjectFile | None = None

    # Preferred: follow the proper FK stored at parse time.
    if row.source_file_id:
        candidate = await session.get(ProjectFile, row.source_file_id)
        if candidate is not None and candidate.project_id == project.id:
            pf = candidate
        else:
            log.warning(
                "geometry.source_file_missing",
                project_id=project.id,
                geometry_id=geometry_id,
                source_file_id=row.source_file_id,
            )

    # Fallback: most recent IFC upload for the project.
    if pf is None:
        pf = await session.scalar(
            select(ProjectFile)
            .where(
                ProjectFile.project_id == project.id,
                ProjectFile.file_format == "ifc",
            )
            .order_by(desc(ProjectFile.uploaded_at))
            .limit(1)
        )
        if pf is not None:
            log.info(
                "geometry.source_file_fallback",
                project_id=project.id,
                geometry_id=geometry_id,
                fallback_file_id=pf.id,
            )

    if pf is None:
        raise NotFound(
            "SOURCE_FILE_NOT_FOUND",
            "No IFC source file found for this geometry. "
            "Re-upload the original IFC and trigger a new parse.",
        )
    if not pf.s3_key:
        raise NotFound("FILE_KEY_MISSING", "Source file has no S3 key on record.")

    url = presign_download(key=pf.s3_key, ttl_seconds=settings.s3_presign_ttl_seconds)
    log.info(
        "geometry.source_file_url",
        org_id=principal.org_id,
        project_id=project.id,
        geometry_id=geometry_id,
        file_id=pf.id,
        format=pf.file_format,
    )
    return FileDownloadUrlResponse(
        fileId=pf.id,
        downloadUrl=url,
        expiresInSeconds=settings.s3_presign_ttl_seconds,
        filename=pf.original_filename,
        fileFormat=pf.file_format or "",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row_to_response(row: ParsedGeometryRow) -> GeometryResponse:
    geometry: ParsedGeometry | None = None
    if row.geometry_data:
        try:
            geometry = ParsedGeometry.model_validate(row.geometry_data)
        except Exception:
            log.exception("geometry.deserialize_fail", geometry_id=row.id)
            geometry = None
    return GeometryResponse(
        id=row.id,
        projectId=row.project_id,
        version=row.version,
        parseStatus=row.parse_status,  # type: ignore[arg-type]
        reviewStatus=row.review_status,  # type: ignore[arg-type]
        createdAt=row.created_at,
        completedAt=row.completed_at,
        acceptedAt=row.accepted_at,
        acceptedBy=row.accepted_by,
        geometry=geometry,
    )

# Re-exported for tests.
__all__ = ["router", "_resolve_latest", "_VALID_ACCEPT_TRANSITIONS"]
