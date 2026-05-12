"""Async SQLAlchemy session + ORM models.

The DB layer is shared between the API and the worker — both packages
import :class:`AsyncSessionLocal` to talk to the same Postgres instance.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, AsyncIterator, Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


# UUID / array compatibility shims. We want production to use native
# Postgres UUID + ARRAY for indexability, but the test suite needs
# SQLite portability. SQLAlchemy 2.0 ``Uuid`` handles dialect-specific
# rendering for us; for arrays we fall back to JSON on non-Postgres.
def _uuid_col() -> Any:
    from sqlalchemy import Uuid

    return Uuid(as_uuid=False)


from apps.api.core.config import get_settings


def _string_array_col() -> Any:
    """``Text[]`` on Postgres, JSON list on SQLite.

    The migration creates the column explicitly as ``ARRAY(TEXT)`` so
    on Postgres we *must* match that schema, otherwise SQLAlchemy
    serialises lists as JSON strings and Postgres rejects the bind
    with ``DatatypeMismatchError`` (column is ``text[]``, expression
    is ``json``). For SQLite (test suite) we fall back to ``JSON``.
    """
    settings = get_settings()
    if (settings.database_url or "").startswith(("postgresql", "postgres+")):
        from sqlalchemy.dialects.postgresql import ARRAY

        return ARRAY(Text)
    return JSON


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# Domain ORM models
# ---------------------------------------------------------------------------


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    org_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_projects_org", "org_id"),)


class ProjectFile(Base):
    __tablename__ = "project_files"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    original_filename: Mapped[str] = mapped_column(Text, nullable=False)
    file_format: Mapped[str] = mapped_column(String(8), nullable=False)
    s3_key: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    file_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    file_sha256: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_files_project", "project_id"),
        Index("ix_files_hash", "file_sha256"),
    )


class ParsedGeometryRow(Base):
    __tablename__ = "parsed_geometries"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_file_id: Mapped[Optional[str]] = mapped_column(
        _uuid_col(),
        ForeignKey("project_files.id", ondelete="SET NULL"),
        nullable=True,
    )
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    parse_status: Mapped[str] = mapped_column(
        String(16), default="processing", nullable=False
    )  # processing | completed | partial | failed
    review_status: Mapped[str] = mapped_column(
        String(16), default="pending", nullable=False
    )  # pending | accepted | superseded

    geometry_data: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    overall_confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    warnings: Mapped[Optional[list[str]]] = mapped_column(
        _string_array_col(), nullable=True
    )

    parser_version: Mapped[str] = mapped_column(String(32), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(64), nullable=False)
    run_id: Mapped[str] = mapped_column(_uuid_col(), nullable=False)
    job_id: Mapped[Optional[str]] = mapped_column(_uuid_col(), nullable=True)
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    failed_step: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    failed_step_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    parse_options: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    accepted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    accepted_by: Mapped[Optional[str]] = mapped_column(_uuid_col(), nullable=True)

    __table_args__ = (
        UniqueConstraint("project_id", "idempotency_key", name="uq_parsed_idempotency"),
        Index("ix_parsed_project_status", "project_id", "parse_status"),
        Index("ix_parsed_project_review", "project_id", "review_status"),
    )


class SchemeRow(Base):
    """One row per generated column-layout variant (Agent 3 output).

    Schemes are grouped by ``generation_run_id``: every call to
    ``POST /schemes/generate`` archives all prior schemes for the same
    ``geometry_id`` and writes a fresh batch with a new run id, so the
    UI never sees stale duplicates.

    Agent 4 adds the sizing-lifecycle columns: ``sizing_status``,
    ``sizing_run_id``, ``sized_at``. They mirror the geometry-side
    ``parse_status`` pattern so the API can return a single column
    instead of joining sizing tables for the lifecycle decision.
    """

    __tablename__ = "schemes"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    geometry_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("parsed_geometries.id", ondelete="CASCADE"),
        nullable=False,
    )

    display_label: Mapped[str] = mapped_column(String(4), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    strategy: Mapped[str] = mapped_column(String(50), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(
        String(20), default="alternate", nullable=False
    )  # active | alternate | archived

    columns_data: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    beams_data: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    shear_walls_data: Mapped[list] = mapped_column(
        JSON, default=list, nullable=False
    )
    braces_data: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    constraints_used: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    generation_run_id: Mapped[Optional[str]] = mapped_column(_uuid_col(), nullable=True)

    # Agent 4 — sizing lifecycle.
    sizing_status: Mapped[str] = mapped_column(
        String(20), default="unsized", nullable=False
    )  # unsized | calculating | sized | failed
    sizing_run_id: Mapped[Optional[str]] = mapped_column(
        _uuid_col(), nullable=True
    )
    sized_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("idx_schemes_project", "project_id"),
        Index("idx_schemes_geometry", "geometry_id"),
        Index("idx_schemes_run", "generation_run_id"),
        Index("idx_schemes_sizing_status", "sizing_status"),
    )


class AuditLog(Base):
    """Append-only audit trail for engineer-meaningful events.

    Every column-placement decision must be auditable: who triggered
    generation, what constraints were used, how many variants were
    produced, who chose the active scheme. This table is written to
    by both the API (scheme activation) and the worker (generation).
    """

    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    user_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("idx_audit_project", "project_id"),
        Index("idx_audit_event", "event_type"),
    )


class MemberCheckRow(Base):
    """One row per failure-mode evaluation (Agent 4 output).

    Recalculation policy: the worker DELETEs every row for a scheme_id
    before INSERTing the fresh batch. We never UPDATE in place — the
    audit trail prefers immutable rows so older calculations remain
    reconstructable when ``audit_log`` records the run id.
    """

    __tablename__ = "member_checks"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    scheme_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("schemes.id", ondelete="CASCADE"),
        nullable=False,
    )
    member_id: Mapped[str] = mapped_column(String(64), nullable=False)
    member_type: Mapped[str] = mapped_column(String(20), nullable=False)
    selected_size: Mapped[str] = mapped_column(String(30), nullable=False)
    check_type: Mapped[str] = mapped_column(String(40), nullable=False)
    demand: Mapped[float] = mapped_column(Float, nullable=False)
    capacity: Mapped[float] = mapped_column(Float, nullable=False)
    dcr: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    governing: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    load_combination: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )
    explanation: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    demand_unit: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )
    capacity_unit: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )
    warnings: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("idx_member_checks_scheme", "scheme_id"),
        Index("idx_member_checks_member", "member_id"),
        Index("idx_member_checks_governing", "scheme_id", "governing"),
    )


class ColumnTakedownRow(Base):
    """One row per (scheme, column, level) — Agent 4 output."""

    __tablename__ = "column_takedowns"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    scheme_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("schemes.id", ondelete="CASCADE"),
        nullable=False,
    )
    column_id: Mapped[str] = mapped_column(String(64), nullable=False)
    level_id: Mapped[str] = mapped_column(String(40), nullable=False)
    level_name: Mapped[Optional[str]] = mapped_column(
        String(120), nullable=True
    )
    level_index_from_top: Mapped[int] = mapped_column(Integer, nullable=False)
    tributary_area_sf: Mapped[float] = mapped_column(Float, nullable=False)
    cumulative_tributary_area_sf: Mapped[float] = mapped_column(
        Float, nullable=False
    )
    dead_load_kip: Mapped[float] = mapped_column(Float, nullable=False)
    live_load_kip: Mapped[float] = mapped_column(Float, nullable=False)
    live_load_unreduced_kip: Mapped[float] = mapped_column(
        Float, nullable=False
    )
    reduction_factor: Mapped[float] = mapped_column(Float, nullable=False)
    factored_load_kip: Mapped[float] = mapped_column(Float, nullable=False)
    governing_combination: Mapped[str] = mapped_column(
        String(64), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("idx_takedown_scheme", "scheme_id"),
        Index("idx_takedown_column", "column_id"),
        Index("idx_takedown_scheme_column", "scheme_id", "column_id"),
    )


class ProjectAssumptionsRow(Base):
    """Per-project engineer overrides for sizing assumptions (Agent 4).

    One row per project (UNIQUE on ``project_id``). When the engineer
    saves overrides via ``PATCH /projects/{id}/assumptions`` we UPSERT
    by project id so a single project never accumulates stale rows.

    The default values live in
    :mod:`packages.engine.member_sizer.constants` — anything the
    engineer doesn't override picks up the engine default.
    """

    __tablename__ = "project_assumptions"

    id: Mapped[str] = mapped_column(_uuid_col(), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        _uuid_col(),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    assumptions_data: Mapped[dict] = mapped_column(
        JSON, default=dict, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("project_id", name="uq_project_assumptions_project"),
    )


# ---------------------------------------------------------------------------
# Engine factory
# ---------------------------------------------------------------------------


_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def _build_engine() -> tuple[Any, async_sessionmaker[AsyncSession]]:
    settings = get_settings()
    engine = create_async_engine(
        settings.database_url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_pre_ping=True,
        future=True,
    )
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    return engine, factory


def get_engine_and_factory() -> tuple[object, async_sessionmaker[AsyncSession]]:
    global _engine, _session_factory
    if _engine is None or _session_factory is None:
        _engine, _session_factory = _build_engine()
    return _engine, _session_factory


def AsyncSessionLocal() -> AsyncSession:
    """Return a new session bound to the configured engine."""
    _, factory = get_engine_and_factory()
    return factory()


async def get_session() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        yield session
