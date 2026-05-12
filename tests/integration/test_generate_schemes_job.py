"""Integration test for the generate_schemes_job worker entrypoint.

Exercises the full path: engine runs against the fixture geometry,
results land in the schemes table, archived schemes are flipped,
audit log gets a completion event, and the function returns the
expected envelope.
"""

from __future__ import annotations

import os

# Force aiosqlite for the worker job test — we don't want a real DB.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


PROJECT_ID = "33333333-3333-3333-3333-333333333333"
GEOMETRY_ID = "66666666-6666-6666-6666-666666666666"
RUN_ID = "77777777-7777-7777-7777-777777777777"
ORG_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "55555555-5555-5555-5555-555555555555"


@pytest_asyncio.fixture
async def db(monkeypatch):
    """Spin up an in-memory DB with org/project/geometry seeded, and
    monkeypatch :func:`AsyncSessionLocal` so the worker job uses it."""
    from apps.api.core import db as db_mod
    from apps.api.core.db import (
        Organization,
        ParsedGeometryRow,
        Project,
    )
    from tests.fixtures.parsed_geometry_fixture import make_fixture

    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async with engine.begin() as conn:
        await conn.run_sync(db_mod.Base.metadata.create_all)

    db_mod._engine = engine  # type: ignore[attr-defined]
    db_mod._session_factory = factory  # type: ignore[attr-defined]

    async with factory() as session:
        session.add_all(
            [
                Organization(id=ORG_ID, name="Acme"),
                Project(id=PROJECT_ID, org_id=ORG_ID, name="Tower One"),
                ParsedGeometryRow(
                    id=GEOMETRY_ID,
                    project_id=PROJECT_ID,
                    version=1,
                    parse_status="completed",
                    review_status="accepted",
                    geometry_data=make_fixture(),
                    parser_version="1.0.0",
                    schema_version="parsed_geometry@1.0.0",
                    run_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    job_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    idempotency_key="key-1",
                ),
            ]
        )
        await session.commit()

    # Stub the Redis progress sink — we don't want to hit a real Redis.
    from apps.api.core import redis_client as rc

    class _NullSink:
        async def publish(self, _event):
            return None

    monkeypatch.setattr(rc, "progress_sink_for", lambda _gid: _NullSink())

    yield factory

    await engine.dispose()


@pytest.mark.asyncio
async def test_job_persists_five_schemes_and_writes_audit(db):
    from apps.api.core.db import AuditLog, SchemeRow
    from apps.worker.jobs.generate_schemes import generate_schemes_job

    result = await generate_schemes_job(
        {"job_id": "job-1"},
        project_id=PROJECT_ID,
        geometry_id=GEOMETRY_ID,
        run_id=RUN_ID,
        org_id=ORG_ID,
        user_id=USER_ID,
        constraints=None,
    )
    assert result["status"] == "completed"
    assert result["scheme_count"] == 5

    async with db() as session:
        schemes = (
            await session.scalars(
                select(SchemeRow).where(SchemeRow.geometry_id == GEOMETRY_ID)
            )
        ).all()
        assert len(schemes) == 5
        statuses = {s.status for s in schemes}
        assert statuses == {"active", "alternate"}
        assert sum(1 for s in schemes if s.status == "active") == 1
        for s in schemes:
            assert s.generation_run_id == RUN_ID
            assert s.metrics is not None
            # Sizing fields stay null.
            assert s.metrics.get("steel_tonnage") is None
            assert s.metrics.get("cost_index") is None

        events = (
            await session.scalars(
                select(AuditLog).where(
                    AuditLog.event_type == "scheme_generation_complete"
                )
            )
        ).all()
        assert len(events) == 1
        assert events[0].payload["scheme_count"] == 5
        assert events[0].payload["generation_run_id"] == RUN_ID
        assert events[0].user_id == USER_ID


@pytest.mark.asyncio
async def test_job_archives_previous_schemes(db):
    """A second generation run must archive the first one's schemes."""
    from apps.api.core.db import SchemeRow
    from apps.worker.jobs.generate_schemes import generate_schemes_job

    await generate_schemes_job(
        {"job_id": "job-1"},
        project_id=PROJECT_ID,
        geometry_id=GEOMETRY_ID,
        run_id=RUN_ID,
        org_id=ORG_ID,
        user_id=USER_ID,
        constraints=None,
    )

    second_run = "88888888-8888-8888-8888-888888888888"
    await generate_schemes_job(
        {"job_id": "job-2"},
        project_id=PROJECT_ID,
        geometry_id=GEOMETRY_ID,
        run_id=second_run,
        org_id=ORG_ID,
        user_id=USER_ID,
        constraints=None,
    )

    async with db() as session:
        rows = (
            await session.scalars(
                select(SchemeRow).where(SchemeRow.geometry_id == GEOMETRY_ID)
            )
        ).all()

    by_run: dict[str, list[SchemeRow]] = {}
    for r in rows:
        by_run.setdefault(r.generation_run_id, []).append(r)
    assert len(by_run) == 2

    first_batch = by_run[RUN_ID]
    second_batch = by_run[second_run]
    assert all(s.status == "archived" for s in first_batch)
    assert any(s.status == "active" for s in second_batch)


@pytest.mark.asyncio
async def test_job_handles_missing_geometry(db, monkeypatch):
    from apps.worker.jobs.generate_schemes import generate_schemes_job

    result = await generate_schemes_job(
        {"job_id": "job-x"},
        project_id=PROJECT_ID,
        geometry_id="00000000-0000-0000-0000-000000000000",
        run_id=RUN_ID,
        org_id=ORG_ID,
        user_id=USER_ID,
        constraints=None,
    )
    assert result["status"] == "failed"
    assert result["error"] == "GEOMETRY_NOT_FOUND"
