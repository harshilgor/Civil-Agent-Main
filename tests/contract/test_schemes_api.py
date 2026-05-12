"""Contract tests for the scheme generation API (Agent 3).

Mirrors the harness used by ``test_api_state_machine``: in-memory
SQLite, ARQ + Redis stubbed, dev-bypass auth headers.
"""

from __future__ import annotations

import json
import os

# Force aiosqlite for contract tests — keeps CI dependency-free.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


PROJECT_ID = "33333333-3333-3333-3333-333333333333"
OTHER_PROJECT_ID = "44444444-4444-4444-4444-444444444444"
ORG_ID = "11111111-1111-1111-1111-111111111111"
OTHER_ORG_ID = "22222222-2222-2222-2222-222222222222"
USER_ID = "55555555-5555-5555-5555-555555555555"


@pytest_asyncio.fixture
async def app_client(monkeypatch):
    from apps.api.core import db as db_mod
    from apps.api.core.db import Organization, Project, get_session
    from apps.api.main import create_app

    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async with engine.begin() as conn:
        await conn.run_sync(db_mod.Base.metadata.create_all)

    db_mod._engine = engine  # type: ignore[attr-defined]
    db_mod._session_factory = factory  # type: ignore[attr-defined]

    # Stub ARQ so the route doesn't try to talk to Redis.
    captured_jobs: list[dict] = []

    class _FakePool:
        async def enqueue_job(self, *args, **kwargs):
            captured_jobs.append({"args": args, "kwargs": kwargs})
            return None

        async def close(self):
            return None

    async def _create_pool(*_a, **_kw):
        return _FakePool()

    import arq

    monkeypatch.setattr(arq, "create_pool", _create_pool)

    app = create_app()

    async def _get_test_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = _get_test_session

    async with factory() as session:
        session.add_all(
            [
                Organization(id=ORG_ID, name="Acme"),
                Organization(id=OTHER_ORG_ID, name="Other"),
                Project(id=PROJECT_ID, org_id=ORG_ID, name="Tower One"),
                Project(id=OTHER_PROJECT_ID, org_id=OTHER_ORG_ID, name="Tower Two"),
            ]
        )
        await session.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Dev-User": USER_ID, "X-Dev-Org": ORG_ID},
    ) as client:
        client._test_factory = factory  # type: ignore[attr-defined]
        client._captured_jobs = captured_jobs  # type: ignore[attr-defined]
        yield client

    await engine.dispose()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _seed_geometry(
    client: AsyncClient,
    *,
    project_id: str = PROJECT_ID,
    parse_status: str = "completed",
    review_status: str = "pending",
) -> str:
    """Insert a parsed geometry row and return its id."""
    import uuid

    from apps.api.core.db import ParsedGeometryRow
    from tests.fixtures.parsed_geometry_fixture import make_fixture

    factory = client._test_factory  # type: ignore[attr-defined]
    geometry_id = str(uuid.uuid4())
    async with factory() as session:
        session.add(
            ParsedGeometryRow(
                id=geometry_id,
                project_id=project_id,
                version=1,
                parse_status=parse_status,
                review_status=review_status,
                geometry_data=make_fixture(),
                parser_version="1.0.0",
                schema_version="parsed_geometry@1.0.0",
                run_id=str(uuid.uuid4()),
                job_id=str(uuid.uuid4()),
                idempotency_key=f"key-{geometry_id[:8]}",
            )
        )
        await session.commit()
    return geometry_id


async def _seed_scheme(
    client: AsyncClient,
    *,
    geometry_id: str,
    project_id: str = PROJECT_ID,
    display_label: str = "A",
    strategy: str = "balanced",
    score: float = 80.0,
    status: str = "alternate",
    generation_run_id: str | None = None,
) -> str:
    import uuid

    from apps.api.core.db import SchemeRow

    factory = client._test_factory  # type: ignore[attr-defined]
    scheme_id = str(uuid.uuid4())
    async with factory() as session:
        session.add(
            SchemeRow(
                id=scheme_id,
                project_id=project_id,
                geometry_id=geometry_id,
                display_label=display_label,
                name=f"Scheme {display_label}",
                strategy=strategy,
                description="",
                status=status,
                columns_data=[],
                beams_data=[],
                shear_walls_data=[],
                braces_data=[],
                metrics={
                    "column_count": 0,
                    "max_span": 0.0,
                    "average_span": 0.0,
                    "unique_bay_patterns": 0,
                    "warning_count": 0,
                    "warnings": [],
                },
                score=score,
                generation_run_id=generation_run_id or str(uuid.uuid4()),
            )
        )
        await session.commit()
    return scheme_id


# ---------------------------------------------------------------------------
# Generate route
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_returns_202_with_job_id(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/generate",
        json={"geometryId": geometry_id},
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["jobId"]
    assert body["geometryId"] == geometry_id
    assert body["generationRunId"]
    assert body["status"] == "queued"


@pytest.mark.asyncio
async def test_generate_resolves_latest_geometry_when_id_omitted(
    app_client: AsyncClient,
):
    geometry_id = await _seed_geometry(app_client)
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/generate",
        json={},
    )
    assert r.status_code == 202, r.text
    assert r.json()["geometryId"] == geometry_id


@pytest.mark.asyncio
async def test_generate_returns_404_when_no_geometry_exists(app_client: AsyncClient):
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/generate",
        json={},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "GEOMETRY_NOT_FOUND"


@pytest.mark.asyncio
async def test_generate_returns_422_when_geometry_still_processing(
    app_client: AsyncClient,
):
    geometry_id = await _seed_geometry(app_client, parse_status="processing")
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/generate",
        json={"geometryId": geometry_id},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "GEOMETRY_NOT_READY"


@pytest.mark.asyncio
async def test_generate_writes_audit_event(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/generate",
        json={
            "geometryId": geometry_id,
            "constraints": {"materialSystem": "steel_composite"},
        },
    )
    assert r.status_code == 202

    factory = app_client._test_factory  # type: ignore[attr-defined]
    from apps.api.core.db import AuditLog
    from sqlalchemy import select

    async with factory() as session:
        rows = (
            await session.scalars(
                select(AuditLog).where(AuditLog.event_type == "scheme_generation")
            )
        ).all()
    assert len(rows) == 1
    payload = rows[0].payload
    assert payload["geometry_id"] == geometry_id
    assert payload["constraints"]["material_system"] == "steel_composite"
    assert rows[0].user_id == USER_ID


@pytest.mark.asyncio
async def test_generate_enqueues_arq_job(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/generate",
        json={"geometryId": geometry_id},
    )
    assert r.status_code == 202
    captured = app_client._captured_jobs  # type: ignore[attr-defined]
    assert len(captured) == 1
    args, kwargs = captured[0]["args"], captured[0]["kwargs"]
    assert args[0] == "generate_schemes_job"
    assert kwargs["project_id"] == PROJECT_ID
    assert kwargs["geometry_id"] == geometry_id


# ---------------------------------------------------------------------------
# List route
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_returns_schemes_for_geometry(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    run_id = "deadbeef-dead-beef-dead-beefdeadbeef"
    await _seed_scheme(
        app_client, geometry_id=geometry_id, display_label="A",
        score=90.0, status="active", generation_run_id=run_id,
    )
    await _seed_scheme(
        app_client, geometry_id=geometry_id, display_label="B",
        score=70.0, status="alternate", generation_run_id=run_id,
    )

    r = await app_client.get(f"/api/projects/{PROJECT_ID}/schemes")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["geometryId"] == geometry_id
    assert body["generationRunId"] == run_id
    assert len(body["schemes"]) == 2
    # Sorted by score descending.
    assert body["schemes"][0]["score"] >= body["schemes"][1]["score"]


@pytest.mark.asyncio
async def test_list_excludes_archived_by_default(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    await _seed_scheme(
        app_client, geometry_id=geometry_id, status="archived", display_label="A",
    )
    await _seed_scheme(
        app_client, geometry_id=geometry_id, status="active", display_label="B",
    )

    r = await app_client.get(f"/api/projects/{PROJECT_ID}/schemes")
    assert r.status_code == 200
    labels = {s["displayLabel"] for s in r.json()["schemes"]}
    assert labels == {"B"}


@pytest.mark.asyncio
async def test_list_with_include_archived_returns_all(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    await _seed_scheme(
        app_client, geometry_id=geometry_id, status="archived", display_label="A",
    )
    await _seed_scheme(
        app_client, geometry_id=geometry_id, status="active", display_label="B",
    )

    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes",
        params={"include_archived": "true"},
    )
    assert r.status_code == 200
    labels = {s["displayLabel"] for s in r.json()["schemes"]}
    assert labels == {"A", "B"}


@pytest.mark.asyncio
async def test_list_returns_empty_when_no_geometry(app_client: AsyncClient):
    r = await app_client.get(f"/api/projects/{PROJECT_ID}/schemes")
    assert r.status_code == 200
    body = r.json()
    assert body["schemes"] == []
    assert body["geometryId"] is None


# ---------------------------------------------------------------------------
# Single-scheme + activation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_scheme_returns_full_payload(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    scheme_id = await _seed_scheme(
        app_client, geometry_id=geometry_id, display_label="A",
    )
    r = await app_client.get(f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == scheme_id
    assert body["displayLabel"] == "A"
    assert "metrics" in body
    assert body["metrics"]["steelTonnage"] is None  # Agent 4 territory


@pytest.mark.asyncio
async def test_patch_activates_scheme_and_demotes_others(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    a = await _seed_scheme(
        app_client, geometry_id=geometry_id, display_label="A", status="active",
    )
    b = await _seed_scheme(
        app_client, geometry_id=geometry_id, display_label="B", status="alternate",
    )

    r = await app_client.patch(
        f"/api/projects/{PROJECT_ID}/schemes/{b}",
        json={"status": "active"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"

    r2 = await app_client.get(f"/api/projects/{PROJECT_ID}/schemes/{a}")
    assert r2.json()["status"] == "alternate"


@pytest.mark.asyncio
async def test_patch_writes_activation_audit_event(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    scheme_id = await _seed_scheme(
        app_client, geometry_id=geometry_id, status="alternate",
    )

    r = await app_client.patch(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}",
        json={"status": "active"},
    )
    assert r.status_code == 200

    factory = app_client._test_factory  # type: ignore[attr-defined]
    from apps.api.core.db import AuditLog
    from sqlalchemy import select

    async with factory() as session:
        events = (
            await session.scalars(
                select(AuditLog).where(AuditLog.event_type == "scheme_activated")
            )
        ).all()
    assert len(events) == 1
    assert events[0].payload["scheme_id"] == scheme_id


@pytest.mark.asyncio
async def test_patch_archived_scheme_returns_409(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    scheme_id = await _seed_scheme(
        app_client, geometry_id=geometry_id, status="archived",
    )
    r = await app_client.patch(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}",
        json={"status": "active"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "SCHEME_ARCHIVED"


@pytest.mark.asyncio
async def test_delete_archives_scheme(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    scheme_id = await _seed_scheme(
        app_client, geometry_id=geometry_id, status="active",
    )

    r = await app_client.delete(f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}")
    assert r.status_code == 204

    r2 = await app_client.get(f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}")
    assert r2.status_code == 200
    assert r2.json()["status"] == "archived"


# ---------------------------------------------------------------------------
# Tenant isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cross_tenant_generate_returns_404(app_client: AsyncClient):
    r = await app_client.post(
        f"/api/projects/{OTHER_PROJECT_ID}/schemes/generate",
        json={},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "PROJECT_NOT_FOUND"


@pytest.mark.asyncio
async def test_cross_tenant_get_scheme_returns_404(app_client: AsyncClient):
    # Seed a scheme under the OTHER project but try to access it as
    # the principal of PROJECT.
    geometry_id = await _seed_geometry(
        app_client, project_id=OTHER_PROJECT_ID,
    )
    scheme_id = await _seed_scheme(
        app_client, geometry_id=geometry_id, project_id=OTHER_PROJECT_ID,
    )
    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}",
    )
    # The project itself is owned by us → not 404 on project. But the
    # scheme is on a different geometry/project → must 404 on scheme.
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "SCHEME_NOT_FOUND"


# ---------------------------------------------------------------------------
# Response shape contract
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_response_uses_camelcase_keys(app_client: AsyncClient):
    geometry_id = await _seed_geometry(app_client)
    scheme_id = await _seed_scheme(
        app_client, geometry_id=geometry_id, display_label="A",
    )
    r = await app_client.get(f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}")
    assert r.status_code == 200
    body = r.json()
    assert "displayLabel" in body
    assert "shearWalls" in body
    assert "columnCount" in body["metrics"]
    assert "uniqueBayPatterns" in body["metrics"]
    assert "steelTonnage" in body["metrics"]
    # No snake_case leakage.
    assert "display_label" not in body
    assert "shear_walls" not in body
    assert "column_count" not in body["metrics"]
