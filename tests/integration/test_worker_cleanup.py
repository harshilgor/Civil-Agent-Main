"""Worker lifecycle tests focused on the operational contract.

* Tmp files are always cleaned up (success, partial, failure paths).
* Exactly one terminal progress event is emitted per job.
* DB row reflects the final ``parse_status``.
"""

from __future__ import annotations

import os
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from apps.api.core import db as db_mod
from apps.api.core.db import (
    Organization,
    ParsedGeometryRow,
    Project,
    ProjectFile,
)
from apps.worker.jobs import parse_geometry as parse_job
from packages.engine.geometry_parser.models import (
    BuildingBounds,
    OriginTransform,
    ParseMetadata,
    ParsedGeometry,
)


PROJECT_ID = "33333333-3333-3333-3333-333333333333"
FILE_ID = "66666666-6666-6666-6666-666666666666"
GEOM_ID = "77777777-7777-7777-7777-777777777777"


@pytest_asyncio.fixture
async def seeded_db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(db_mod.Base.metadata.create_all)

    db_mod._engine = engine  # type: ignore[attr-defined]
    db_mod._session_factory = factory  # type: ignore[attr-defined]

    async with factory() as s:
        s.add_all([
            Organization(id="11111111-1111-1111-1111-111111111111", name="Acme"),
            Project(
                id=PROJECT_ID,
                org_id="11111111-1111-1111-1111-111111111111",
                name="Tower",
            ),
            ProjectFile(
                id=FILE_ID,
                project_id=PROJECT_ID,
                original_filename="model.ifc",
                file_format="ifc",
                s3_key="orgs/x/projects/y/uploads/z.ifc",
                file_sha256="d" * 64,
            ),
            ParsedGeometryRow(
                id=GEOM_ID,
                project_id=PROJECT_ID,
                source_file_id=FILE_ID,
                version=1,
                parse_status="processing",
                review_status="pending",
                geometry_data={},
                parser_version="1.0.0",
                schema_version="parsed_geometry@1.0.0",
                run_id="88888888-8888-8888-8888-888888888888",
                job_id="99999999-9999-9999-9999-999999999999",
                idempotency_key="abc",
            ),
        ])
        await s.commit()

    yield factory
    await engine.dispose()


def _completed_geometry() -> ParsedGeometry:
    return ParsedGeometry(
        buildingBounds=BuildingBounds(minX=0, minY=0, maxX=10, maxY=10),
        metadata=ParseMetadata(
            runId="88888888-8888-8888-8888-888888888888",
            fileFormat="ifc",
            fileHash="d" * 64,
            overallConfidence=0.95,
            status="completed",
            completedSteps=["download", "init", "complete"],
            warnings=[],
            originTransform=OriginTransform(tx=0, ty=0),
            parsedAt=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
        ),
    )


@pytest.mark.asyncio
async def test_worker_cleans_temp_file_on_success(monkeypatch, seeded_db, tmp_path):
    fake_path = tmp_path / "downloaded.ifc"
    fake_path.write_text("fake")
    monkeypatch.setattr(parse_job, "_download_temp", lambda key, ext: str(fake_path))

    async def _fake_parse(**_kw):
        return _completed_geometry()

    monkeypatch.setattr(parse_job, "parse_file", _fake_parse)

    class _Sink:
        def __init__(self, *a, **k):
            pass

        async def publish(self, event):
            pass

    monkeypatch.setattr(parse_job, "progress_sink_for", lambda gid: _Sink())

    out = await parse_job.parse_geometry_job(
        ctx={"job_id": "j"},
        project_id=PROJECT_ID,
        file_id=FILE_ID,
        geometry_id=GEOM_ID,
        run_id="r",
        org_id="11111111-1111-1111-1111-111111111111",
    )
    assert out["status"] == "completed"
    assert not os.path.exists(fake_path), "temp file must be deleted"

    factory = seeded_db
    async with factory() as s:
        row = await s.get(ParsedGeometryRow, GEOM_ID)
        assert row.parse_status == "completed"
        assert row.overall_confidence == 0.95
        assert row.completed_at is not None


@pytest.mark.asyncio
async def test_worker_cleans_temp_file_on_failure(monkeypatch, seeded_db, tmp_path):
    fake_path = tmp_path / "downloaded.ifc"
    fake_path.write_text("fake")
    monkeypatch.setattr(parse_job, "_download_temp", lambda key, ext: str(fake_path))

    async def _explode(**_kw):
        raise RuntimeError("bang")

    monkeypatch.setattr(parse_job, "parse_file", _explode)

    class _Sink:
        def __init__(self, *a, **k):
            pass

        async def publish(self, event):
            pass

    monkeypatch.setattr(parse_job, "progress_sink_for", lambda gid: _Sink())

    out = await parse_job.parse_geometry_job(
        ctx={"job_id": "j"},
        project_id=PROJECT_ID,
        file_id=FILE_ID,
        geometry_id=GEOM_ID,
        run_id="r",
        org_id="11111111-1111-1111-1111-111111111111",
    )
    assert out["status"] == "failed"
    assert not os.path.exists(fake_path), "temp file must be deleted even on failure"


@pytest.mark.asyncio
async def test_worker_handles_missing_file_row(monkeypatch, seeded_db):
    """File row missing → worker emits failed terminal event without blowing up."""
    class _Sink:
        events: list[Any] = []

        def __init__(self, *a, **k):
            pass

        async def publish(self, event):
            _Sink.events.append(event)

    monkeypatch.setattr(parse_job, "progress_sink_for", lambda gid: _Sink())

    out = await parse_job.parse_geometry_job(
        ctx={"job_id": "j"},
        project_id=PROJECT_ID,
        file_id="00000000-0000-0000-0000-000000000000",  # nonexistent
        geometry_id=GEOM_ID,
        run_id="r",
        org_id="11111111-1111-1111-1111-111111111111",
    )
    assert out["status"] == "failed"
    terminals = [e for e in _Sink.events if getattr(e, "terminal", False)]
    assert len(terminals) == 1
