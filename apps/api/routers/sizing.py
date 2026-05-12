"""Sizing routes (Agent 4).

Mirrors the patterns established by ``schemes.py``:

* tenant isolation via ``project_dep`` (404 for cross-tenant);
* structured ``{code, message, context}`` error envelope;
* enqueue-then-return for long-running work — the API handler does
  the validation, writes an audit-log entry, and queues an ARQ job
  that performs the actual calculation and writes the
  ``member_checks`` / ``column_takedowns`` rows.

Concurrency: a scheme can have at most one active sizing run at a
time. The worker honours this by checking ``schemes.sizing_status`` —
if the column is already ``calculating`` and the job id matches a
recent run, the new job is short-circuited as ``deduped``. The API
layer does not block on this; engineers expect ``POST /calculate`` to
always queue, and the worker does the de-dup check transactionally.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from apps.api.core.auth import CurrentUser, project_dep
from apps.api.core.config import Settings, get_settings
from apps.api.core.db import (
    AuditLog,
    ColumnTakedownRow,
    MemberCheckRow,
    Project,
    ProjectAssumptionsRow,
    SchemeRow,
    get_session,
)
from apps.api.core.errors import NotFound, UnprocessableEntity
from apps.api.core.logging_config import get_logger
from apps.api.schemas import (
    CalculateSizingRequest,
    CalculateSizingResponse,
    ColumnTakedownGroup,
    MemberDetailResponse,
    MembersListResponse,
    ProjectAssumptionsResponse,
    TakedownResponse,
)
from packages.engine.member_sizer.models import (
    ColumnTakedownEntry,
    MemberCheck,
    MemberSizingSummary,
    SizingAssumptions,
)

router = APIRouter(prefix="/api/projects/{project_id}/schemes", tags=["sizing"])
log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Trigger calculation
# ---------------------------------------------------------------------------


@router.post(
    "/{scheme_id}/calculate",
    response_model=CalculateSizingResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_sizing_calculation(
    scheme_id: str,
    body: CalculateSizingRequest,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CalculateSizingResponse:
    """Enqueue a sizing job for the scheme.

    Behaviour:

    * 404 if the scheme is not in this project (cross-tenant).
    * 422 if the scheme has no columns/beams (Agent 3 produced an
      empty layout — sizing is meaningless).
    * Otherwise: write an audit-log entry, flip
      ``schemes.sizing_status = 'calculating'``, enqueue ARQ job.
    * Returns 202 with the job id.
    """
    scheme = await _load_scheme_for_project(session, project.id, scheme_id)

    if not scheme.columns_data or not scheme.beams_data:
        raise UnprocessableEntity(
            "SCHEME_EMPTY",
            "Scheme has no columns or beams; nothing to size.",
            scheme_id=scheme_id,
        )

    job_id = str(uuid.uuid4())
    sizing_run_id = str(uuid.uuid4())

    # Resolve assumptions: explicit body > project_assumptions row > defaults.
    assumptions_payload: dict | None = None
    if body.assumptions is not None:
        assumptions_payload = body.assumptions.model_dump(
            mode="json", by_alias=False
        )

    # Update scheme lifecycle columns up-front so the API caller can
    # poll without a race against the worker.
    scheme.sizing_status = "calculating"
    scheme.sizing_run_id = sizing_run_id
    scheme.updated_at = datetime.now(timezone.utc)

    session.add(
        AuditLog(
            id=str(uuid.uuid4()),
            project_id=project.id,
            event_type="sizing_calculation",
            user_id=principal.user_id,
            payload={
                "job_id": job_id,
                "sizing_run_id": sizing_run_id,
                "scheme_id": scheme_id,
                "geometry_id": scheme.geometry_id,
                "assumptions_provided": assumptions_payload is not None,
            },
        )
    )
    await session.commit()

    from arq import create_pool
    from arq.connections import RedisSettings as ArqRedis

    pool = await create_pool(ArqRedis.from_dsn(settings.redis_url))
    try:
        await pool.enqueue_job(
            "calculate_sizing_job",
            project_id=project.id,
            scheme_id=scheme_id,
            sizing_run_id=sizing_run_id,
            org_id=principal.org_id,
            user_id=principal.user_id,
            assumptions=assumptions_payload,
            _job_id=job_id,
        )
    finally:
        await pool.close()

    log.info(
        "sizing.enqueued",
        project_id=project.id,
        scheme_id=scheme_id,
        job_id=job_id,
        sizing_run_id=sizing_run_id,
    )

    return CalculateSizingResponse(
        job_id=job_id,
        scheme_id=scheme_id,
        sizing_run_id=sizing_run_id,
        status="queued",
    )


# ---------------------------------------------------------------------------
# List members
# ---------------------------------------------------------------------------


@router.get(
    "/{scheme_id}/members",
    response_model=MembersListResponse,
)
async def list_members(
    scheme_id: str,
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> MembersListResponse:
    """All beams + columns with their governing check.

    Returns an empty members list when the scheme has not been sized
    yet — the frontend differentiates that state by inspecting
    ``sizingStatus``. We DO NOT return ``null``; an empty list keeps
    the consumer code simple.
    """
    scheme = await _load_scheme_for_project(session, project.id, scheme_id)

    rows = (
        await session.scalars(
            select(MemberCheckRow).where(
                MemberCheckRow.scheme_id == scheme_id
            )
        )
    ).all()

    summaries = _rows_to_summaries(rows)
    assumptions = _project_assumptions_or_default(
        await _project_assumptions_row(session, project.id)
    )

    return MembersListResponse(
        scheme_id=scheme_id,
        sizing_status=scheme.sizing_status or "unsized",
        members=summaries,
        assumptions_used=assumptions,
        sized_at=scheme.sized_at,
    )


# ---------------------------------------------------------------------------
# Single member detail
# ---------------------------------------------------------------------------


@router.get(
    "/{scheme_id}/members/{member_id}",
    response_model=MemberDetailResponse,
)
async def get_member_detail(
    scheme_id: str,
    member_id: str,
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> MemberDetailResponse:
    """Full set of checks for a single member, plus column takedown
    if the member is a column."""
    await _load_scheme_for_project(session, project.id, scheme_id)

    rows = (
        await session.scalars(
            select(MemberCheckRow).where(
                MemberCheckRow.scheme_id == scheme_id,
                MemberCheckRow.member_id == member_id,
            )
        )
    ).all()

    if not rows:
        raise NotFound(
            "MEMBER_NOT_FOUND",
            "No sizing checks for this member.",
            scheme_id=scheme_id,
            member_id=member_id,
        )

    summaries = _rows_to_summaries(rows)
    summary = summaries[0]  # single member → exactly one summary

    takedown_entries: list[ColumnTakedownEntry] = []
    if summary.member_type == "column":
        td_rows = (
            await session.scalars(
                select(ColumnTakedownRow)
                .where(
                    ColumnTakedownRow.scheme_id == scheme_id,
                    ColumnTakedownRow.column_id == member_id,
                )
                .order_by(ColumnTakedownRow.level_index_from_top)
            )
        ).all()
        takedown_entries = [_takedown_row_to_entry(r) for r in td_rows]

    return MemberDetailResponse(summary=summary, takedown=takedown_entries)


# ---------------------------------------------------------------------------
# Column takedowns
# ---------------------------------------------------------------------------


@router.get(
    "/{scheme_id}/takedown",
    response_model=TakedownResponse,
)
async def get_column_takedown(
    scheme_id: str,
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TakedownResponse:
    """Per-column load takedown grouped by column id.

    Each group is ordered top-to-bottom (``level_index_from_top``) so
    a renderer can show the foundation reaction at the bottom row.
    """
    scheme = await _load_scheme_for_project(session, project.id, scheme_id)

    rows = (
        await session.scalars(
            select(ColumnTakedownRow)
            .where(ColumnTakedownRow.scheme_id == scheme_id)
            .order_by(
                ColumnTakedownRow.column_id,
                ColumnTakedownRow.level_index_from_top,
            )
        )
    ).all()

    grid_label_lookup = {
        c.get("id"): c.get("gridLabel") or ""
        for c in (scheme.columns_data or [])
    }

    grouped: dict[str, ColumnTakedownGroup] = {}
    for r in rows:
        group = grouped.get(r.column_id)
        if group is None:
            group = ColumnTakedownGroup(
                column_id=r.column_id,
                grid_label=grid_label_lookup.get(r.column_id, ""),
                levels=[],
            )
            grouped[r.column_id] = group
        group.levels.append(_takedown_row_to_entry(r))

    return TakedownResponse(
        scheme_id=scheme_id,
        columns=list(grouped.values()),
    )


# ---------------------------------------------------------------------------
# Project assumptions — read/write the engineer overrides
# ---------------------------------------------------------------------------


assumptions_router = APIRouter(
    prefix="/api/projects/{project_id}/assumptions",
    tags=["sizing"],
)


@assumptions_router.get("", response_model=ProjectAssumptionsResponse)
async def get_project_assumptions(
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ProjectAssumptionsResponse:
    row = await _project_assumptions_row(session, project.id)
    return ProjectAssumptionsResponse(
        project_id=project.id,
        assumptions=_project_assumptions_or_default(row),
        updated_at=row.updated_at if row else None,
    )


@assumptions_router.put("", response_model=ProjectAssumptionsResponse)
async def upsert_project_assumptions(
    body: SizingAssumptions,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ProjectAssumptionsResponse:
    """Replace the engineer overrides. We persist the full assumptions
    set (so unset fields default to engine constants on next read)."""
    payload = body.model_dump(mode="json", by_alias=False)
    row = await _project_assumptions_row(session, project.id)
    if row is None:
        row = ProjectAssumptionsRow(
            id=str(uuid.uuid4()),
            project_id=project.id,
            assumptions_data=payload,
        )
        session.add(row)
    else:
        row.assumptions_data = payload
        row.updated_at = datetime.now(timezone.utc)

    session.add(
        AuditLog(
            id=str(uuid.uuid4()),
            project_id=project.id,
            event_type="assumptions_updated",
            user_id=principal.user_id,
            payload={"assumptions": payload},
        )
    )
    await session.commit()
    await session.refresh(row)

    return ProjectAssumptionsResponse(
        project_id=project.id,
        assumptions=SizingAssumptions.model_validate(row.assumptions_data),
        updated_at=row.updated_at,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _load_scheme_for_project(
    session: AsyncSession,
    project_id: str,
    scheme_id: str,
) -> SchemeRow:
    row = await session.get(SchemeRow, scheme_id)
    if row is None or row.project_id != project_id:
        raise NotFound("SCHEME_NOT_FOUND", "Scheme not found.")
    return row


async def _project_assumptions_row(
    session: AsyncSession,
    project_id: str,
) -> ProjectAssumptionsRow | None:
    return await session.scalar(
        select(ProjectAssumptionsRow).where(
            ProjectAssumptionsRow.project_id == project_id
        )
    )


def _project_assumptions_or_default(
    row: ProjectAssumptionsRow | None,
) -> SizingAssumptions:
    if row is None:
        return SizingAssumptions()
    try:
        return SizingAssumptions.model_validate(row.assumptions_data or {})
    except Exception:  # pragma: no cover — corrupted JSON, fall back
        log.warning(
            "assumptions.invalid_json",
            project_id=row.project_id,
        )
        return SizingAssumptions()


def _rows_to_summaries(rows: list[MemberCheckRow]) -> list[MemberSizingSummary]:
    """Group ``MemberCheckRow`` rows by member id and reconstruct
    :class:`MemberSizingSummary`.

    Picks the row with ``governing=True`` for the headline values; if
    none is flagged (data integrity issue) falls back to the highest
    DCR.
    """
    by_member: dict[str, list[MemberCheckRow]] = {}
    for r in rows:
        by_member.setdefault(r.member_id, []).append(r)

    summaries: list[MemberSizingSummary] = []
    for member_id, member_rows in by_member.items():
        checks = [_check_row_to_model(r) for r in member_rows]
        governing = next((c for c in checks if c.governing), None)
        if governing is None and checks:
            governing = max(checks, key=lambda c: c.dcr)
        if governing is None:
            continue

        # We don't store the per-member length on member_checks (it's
        # derivable from the scheme). Set to 0 here — the consumer
        # reads it from the scheme bundle for display. (Future: cache
        # the length on a member_summaries table.)
        weight_plf = _shape_weight(governing.selected_size)
        summaries.append(
            MemberSizingSummary(
                member_id=member_id,
                member_type=governing.member_type,
                selected_size=governing.selected_size,
                weight_plf=weight_plf,
                length_ft=0.0,
                dcr=governing.dcr,
                governing_check=governing.check_type,
                status=governing.status,
                all_checks=checks,
                warnings=list(governing.warnings or []),
            )
        )
    return summaries


def _check_row_to_model(r: MemberCheckRow) -> MemberCheck:
    return MemberCheck(
        id=r.id,
        scheme_id=r.scheme_id,
        member_id=r.member_id,
        member_type=r.member_type,
        selected_size=r.selected_size,
        check_type=r.check_type,
        demand=r.demand,
        capacity=r.capacity,
        dcr=r.dcr,
        status=r.status,
        governing=r.governing,
        load_combination=r.load_combination or "",
        explanation=r.explanation or "",
        demand_unit=r.demand_unit or "",
        capacity_unit=r.capacity_unit or "",
        warnings=list(r.warnings or []),
    )


def _takedown_row_to_entry(r: ColumnTakedownRow) -> ColumnTakedownEntry:
    return ColumnTakedownEntry(
        column_id=r.column_id,
        level_id=r.level_id,
        level_name=r.level_name or r.level_id,
        level_index_from_top=r.level_index_from_top,
        tributary_area_sf=r.tributary_area_sf,
        cumulative_tributary_area_sf=r.cumulative_tributary_area_sf,
        dead_load_kip=r.dead_load_kip,
        live_load_kip=r.live_load_kip,
        live_load_unreduced_kip=r.live_load_unreduced_kip,
        reduction_factor=r.reduction_factor,
        factored_load_kip=r.factored_load_kip,
        governing_combination=r.governing_combination,
    )


def _shape_weight(name: str) -> float:
    from packages.engine.member_sizer.aisc_database import get_shape

    s = get_shape(name)
    return s.weight_plf if s else 0.0


__all__ = ["router", "assumptions_router"]
