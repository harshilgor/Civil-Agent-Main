"""Project CRUD routes — minimal surface for the New Project flow.

The "real" CivilAgent will gate org creation behind invitations and
billing, but for the engineering-tool MVP we just need:

* POST /api/projects   – create a project for the principal's org
* GET  /api/projects   – list projects in the principal's org
* GET  /api/projects/{id} – fetch a single project (404s cross-tenant)

A bootstrap step creates the organisation row on first write if it
doesn't exist. This is safe because :func:`authenticate` already
rejected the request if the principal couldn't supply an ``org_id``,
so we're only ever vivifying an org that the auth layer (or dev
bypass) has already vouched for.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from apps.api.core.auth import CurrentUser
from apps.api.core.db import Organization, Project, get_session
from apps.api.core.errors import BadRequest, NotFound
from apps.api.core.logging_config import get_logger

router = APIRouter(prefix="/api/projects", tags=["projects"])
log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class CreateProjectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(..., min_length=1, max_length=255)
    location: str | None = Field(default=None, max_length=255)
    buildingType: str | None = Field(default=None, max_length=64)
    metadata: dict | None = Field(
        default=None,
        description=(
            "Free-form client-side context (stories, floor heights, code "
            "year, etc). Stored on the client for now; the server only "
            "validates it isn't egregiously large."
        ),
    )


class ProjectResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    orgId: str
    name: str
    createdAt: datetime


class ProjectListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    projects: list[ProjectResponse]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _ensure_org(session: AsyncSession, org_id: str) -> Organization:
    """Return the org row, vivifying it for dev bypass principals.

    In production the JWT issuer is responsible for creating org rows
    via a billing webhook, so this `add()` path will be a no-op there.
    """
    org = await session.scalar(select(Organization).where(Organization.id == org_id))
    if org is not None:
        return org
    org = Organization(id=org_id, name="dev-org")
    session.add(org)
    await session.flush()
    log.info("organizations.bootstrapped", org_id=org_id)
    return org


def _to_response(row: Project) -> ProjectResponse:
    return ProjectResponse(
        id=row.id,
        orgId=row.org_id,
        name=row.name,
        createdAt=row.created_at,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project(
    body: CreateProjectRequest,
    principal: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ProjectResponse:
    if body.metadata is not None and len(str(body.metadata)) > 16_384:
        raise BadRequest(
            "PROJECT_METADATA_TOO_LARGE",
            "Project metadata may not exceed 16 KB.",
        )

    await _ensure_org(session, principal.org_id)

    project = Project(
        id=str(uuid.uuid4()),
        org_id=principal.org_id,
        name=body.name.strip(),
    )
    session.add(project)
    await session.commit()

    log.info(
        "projects.created",
        project_id=project.id,
        org_id=principal.org_id,
        name=project.name,
    )
    return _to_response(project)


@router.get("", response_model=ProjectListResponse)
async def list_projects(
    principal: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ProjectListResponse:
    rows = await session.scalars(
        select(Project)
        .where(Project.org_id == principal.org_id)
        .order_by(desc(Project.created_at))
        .limit(100)
    )
    return ProjectListResponse(projects=[_to_response(r) for r in rows.all()])


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    principal: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ProjectResponse:
    # Reject malformed UUIDs as 404 (matches assert_project_ownership) so
    # asyncpg's UUID-parse ValueError can't bubble as a 500 to the browser.
    try:
        uuid.UUID(project_id)
    except (ValueError, AttributeError, TypeError):
        raise NotFound("PROJECT_NOT_FOUND", "Project not found.")
    row = await session.scalar(select(Project).where(Project.id == project_id))
    if row is None or row.org_id != principal.org_id:
        # Identical 404 for "missing" and "wrong org" — never leak
        # cross-tenant existence (matches assert_project_ownership).
        raise NotFound("PROJECT_NOT_FOUND", "Project not found.")
    return _to_response(row)


__all__ = ["router"]
