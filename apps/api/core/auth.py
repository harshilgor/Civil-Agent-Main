"""Tenant-aware authentication.

Every authenticated request resolves to a :class:`Principal` carrying
``user_id`` and ``org_id``. Project-level ownership is enforced
separately in :func:`assert_project_ownership` against the DB.

Two paths:

* **Production**: ``Authorization: Bearer <jwt>``. Verified against the
  configured JWKS (see :mod:`apps.api.core.jwks`). ``aud``, ``iss``,
  ``exp``, signature, and algorithm allow-list are all enforced. The
  ``org_id`` claim name is configurable
  (``AUTH_JWT_ORG_CLAIM``, default ``org_id``).
* **Local dev**: ``X-Dev-User`` + ``X-Dev-Org`` headers, accepted only
  when ``AUTH_DEV_BYPASS=true``. We refuse to honour dev headers in
  production environments even if both flags happen to be set, so a
  misconfigured ``CIVILAGENT_ENV=prod`` still fails closed.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from apps.api.core.config import Settings, get_settings
from apps.api.core.db import Project, get_session
from apps.api.core.jwks import AuthError, get_verifier

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Principal:
    user_id: str
    org_id: str

    @property
    def safe_dict(self) -> dict[str, str]:
        return {"user_id": self.user_id, "org_id": self.org_id}


def _401(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": code, "message": message},
    )


def _is_dev_environment(settings: Settings) -> bool:
    """Belt-and-braces: dev bypass only honoured in non-prod envs."""
    return (
        settings.auth_dev_bypass
        and settings.civilagent_env in {"local", "dev"}
    )


async def authenticate(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    x_dev_user: Annotated[str | None, Header(alias="X-Dev-User")] = None,
    x_dev_org: Annotated[str | None, Header(alias="X-Dev-Org")] = None,
) -> Principal:
    if _is_dev_environment(settings) and x_dev_user and x_dev_org:
        return Principal(user_id=x_dev_user, org_id=x_dev_org)

    if not authorization or not authorization.lower().startswith("bearer "):
        raise _401("AUTH_MISSING_TOKEN", "Bearer token required.")
    token = authorization.split(" ", 1)[1].strip()

    try:
        claims = await get_verifier().verify(token)
    except AuthError as exc:
        log.info("auth.rejected", extra={"code": exc.code})
        raise _401(exc.code, exc.message) from exc

    user_id = claims.get("sub")
    if not user_id:
        raise _401("AUTH_MISSING_SUB", "Token has no 'sub' claim.")

    org_claim_name = settings.auth_jwt_org_claim
    org_id = (
        claims.get(org_claim_name)
        or claims.get("org")
        or claims.get("azp")
    )
    if not org_id:
        raise _401(
            "AUTH_MISSING_ORG",
            f"Token has no '{org_claim_name}' (or 'org'/'azp') claim.",
        )

    return Principal(user_id=str(user_id), org_id=str(org_id))


CurrentUser = Annotated[Principal, Depends(authenticate)]


async def assert_project_ownership(
    project_id: str,
    principal: Principal,
    session: AsyncSession,
) -> Project:
    """Verify the principal's org owns the project. Returns the row."""
    # Project IDs are UUIDs in the DB; reject malformed input up front so
    # we don't bubble a Postgres ValueError out of asyncpg as a 500. The
    # response is intentionally identical to the "not found" case so we
    # never leak existence to other tenants (or hint that an ID is
    # syntactically valid but unknown).
    try:
        uuid.UUID(project_id)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "PROJECT_NOT_FOUND", "message": "Project not found."},
        )
    row = await session.scalar(select(Project).where(Project.id == project_id))
    if row is None or row.org_id != principal.org_id:
        # Identical 404 for "missing" and "wrong org" — never leak
        # existence to other tenants.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "PROJECT_NOT_FOUND", "message": "Project not found."},
        )
    return row


async def project_dep(
    project_id: str,
    principal: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Project:
    return await assert_project_ownership(project_id, principal, session)
