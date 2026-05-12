"""API state-machine contract tests.

Exercises the FastAPI router stack with an in-memory SQLite database.
External services (Redis, S3, ARQ) are stubbed; only HTTP semantics +
DB state transitions are asserted here.
"""

from __future__ import annotations

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


@pytest_asyncio.fixture
async def app_client(monkeypatch):
    from apps.api.core import db as db_mod
    from apps.api.core.db import (
        Organization,
        Project,
        get_session,
    )
    from apps.api.main import create_app

    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async with engine.begin() as conn:
        await conn.run_sync(db_mod.Base.metadata.create_all)

    # Make sure direct imports of AsyncSessionLocal also use this engine.
    db_mod._engine = engine  # type: ignore[attr-defined]
    db_mod._session_factory = factory  # type: ignore[attr-defined]

    # Patch S3 + ARQ + Redis so router code doesn't reach the network.
    # We patch the imported symbol inside the router module (not the
    # source module) because `from ... import presign_upload` rebinds
    # the name at import time.
    from apps.api.routers import files as files_router

    monkeypatch.setattr(
        files_router,
        "presign_upload",
        lambda **kw: ("https://example.invalid/upload", "key/path"),
    )

    class _FakePool:
        async def enqueue_job(self, *args, **kwargs):
            return None

        async def close(self):
            return None

    async def _create_pool(*_a, **_kw):
        return _FakePool()

    import arq

    monkeypatch.setattr(arq, "create_pool", _create_pool)

    # Build the app, then override the per-request session dependency.
    app = create_app()

    async def _get_test_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = _get_test_session

    # Seed the DB with org + project rows.
    async with factory() as session:
        session.add_all(
            [
                Organization(id="11111111-1111-1111-1111-111111111111", name="Acme"),
                Organization(id="22222222-2222-2222-2222-222222222222", name="Other"),
                Project(
                    id=PROJECT_ID,
                    org_id="11111111-1111-1111-1111-111111111111",
                    name="Tower One",
                ),
                Project(
                    id=OTHER_PROJECT_ID,
                    org_id="22222222-2222-2222-2222-222222222222",
                    name="Tower Two",
                ),
            ]
        )
        await session.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={
            "X-Dev-User": "55555555-5555-5555-5555-555555555555",
            "X-Dev-Org": "11111111-1111-1111-1111-111111111111",
        },
    ) as client:
        client._test_factory = factory  # type: ignore[attr-defined]  — for direct DB access
        yield client

    await engine.dispose()


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_health_endpoint(app_client: AsyncClient):
    r = await app_client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["parserVersion"] == "1.0.0"
    assert body["schemaVersion"] == "parsed_geometry@1.0.0"


# ---------------------------------------------------------------------------
# Tenant isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cross_tenant_project_access_returns_404(app_client: AsyncClient):
    """User in one org must never see resources owned by another org.
    The response must be 404 (not 403) so we don't leak existence."""
    r = await app_client.post(
        f"/api/projects/{OTHER_PROJECT_ID}/files/upload-url",
        json={"filename": "model.ifc", "contentType": "application/x-step"},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "PROJECT_NOT_FOUND"


@pytest.mark.asyncio
async def test_upload_url_requires_known_extension(app_client: AsyncClient):
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/files/upload-url",
        json={"filename": "model.exe", "contentType": "application/octet-stream"},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "FORMAT_NOT_ALLOWED"


@pytest.mark.asyncio
async def test_upload_url_validates_content_type(app_client: AsyncClient):
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/files/upload-url",
        json={"filename": "model.pdf", "contentType": "text/plain"},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "CONTENT_TYPE_MISMATCH"


@pytest.mark.asyncio
async def test_upload_url_creates_record_and_signed_url(app_client: AsyncClient):
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/files/upload-url",
        json={"filename": "model.ifc", "contentType": "application/x-step"},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["fileId"]
    assert body["presignedUrl"].startswith("https://")
    assert body["maxBytes"] > 0


# ---------------------------------------------------------------------------
# Parse trigger + idempotency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_requires_registered_file(app_client: AsyncClient):
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/files/upload-url",
        json={"filename": "model.ifc", "contentType": "application/x-step"},
    )
    file_id = r.json()["fileId"]

    r2 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse",
        json={"fileId": file_id},
    )
    assert r2.status_code == 422
    assert r2.json()["detail"]["code"] == "FILE_HASH_MISSING"


@pytest.mark.asyncio
async def test_parse_dedupes_identical_request(app_client: AsyncClient):
    file_id = await _create_registered_file(app_client, sha="a" * 64)
    r1 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse", json={"fileId": file_id}
    )
    assert r1.status_code == 202
    body1 = r1.json()
    assert body1["status"] == "queued"

    r2 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse", json={"fileId": file_id}
    )
    assert r2.status_code == 202
    body2 = r2.json()
    assert body2["status"] == "deduped"
    assert body1["geometryId"] == body2["geometryId"]
    assert body1["idempotencyKey"] == body2["idempotencyKey"]


@pytest.mark.asyncio
async def test_parse_force_creates_new_run(app_client: AsyncClient):
    file_id = await _create_registered_file(app_client, sha="b" * 64)
    r1 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse", json={"fileId": file_id}
    )
    r2 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse",
        json={"fileId": file_id, "force": True},
    )
    assert r1.status_code == 202 and r2.status_code == 202
    assert r1.json()["geometryId"] != r2.json()["geometryId"]


@pytest.mark.asyncio
async def test_parse_options_pagenumber_does_not_dedupe_against_no_options(
    app_client: AsyncClient,
):
    """Page 1 and page 7 of the same PDF must produce distinct jobs."""
    file_id = await _create_registered_file(
        app_client, sha="f" * 64, filename="plans.pdf", content_type="application/pdf"
    )
    r_no_opts = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse",
        json={"fileId": file_id},
    )
    r_page_1 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse",
        json={"fileId": file_id, "options": {"pageNumber": 1}},
    )
    r_page_7 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse",
        json={"fileId": file_id, "options": {"pageNumber": 7}},
    )
    for r in (r_no_opts, r_page_1, r_page_7):
        assert r.status_code == 202

    keys = {r.json()["idempotencyKey"] for r in (r_no_opts, r_page_1, r_page_7)}
    assert len(keys) == 3, f"Expected 3 unique keys, got {keys}"
    geom_ids = {r.json()["geometryId"] for r in (r_no_opts, r_page_1, r_page_7)}
    assert len(geom_ids) == 3


@pytest.mark.asyncio
async def test_parse_options_pagenumber_ignored_for_non_pdf(app_client: AsyncClient):
    """For an IFC, ``pageNumber`` is meaningless — must not poison the
    idempotency key, so a re-trigger with options dedupes against the
    original."""
    file_id = await _create_registered_file(app_client, sha="9" * 64)
    r1 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse", json={"fileId": file_id}
    )
    r2 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse",
        json={"fileId": file_id, "options": {"pageNumber": 5}},
    )
    assert r1.status_code == 202 and r2.status_code == 202
    assert r1.json()["idempotencyKey"] == r2.json()["idempotencyKey"]
    assert r2.json()["status"] == "deduped"


@pytest.mark.asyncio
async def test_parse_options_rejects_invalid_page_number(app_client: AsyncClient):
    file_id = await _create_registered_file(
        app_client, sha="0" * 64, filename="plans.pdf", content_type="application/pdf"
    )
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse",
        json={"fileId": file_id, "options": {"pageNumber": 0}},
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Acceptance state machine
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cannot_accept_processing_geometry(app_client: AsyncClient):
    file_id = await _create_registered_file(app_client, sha="c" * 64)
    r1 = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse", json={"fileId": file_id}
    )
    geom_id = r1.json()["geometryId"]

    r = await app_client.patch(
        f"/api/projects/{PROJECT_ID}/geometry/{geom_id}/accept",
        json={},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "INVALID_STATE_TRANSITION"


@pytest.mark.asyncio
async def test_accept_completed_supersedes_prior(app_client: AsyncClient):
    """Manually flip a row to ``completed`` then accept. A subsequent
    accept on a different geometry must transition the prior accepted
    row to ``superseded``."""
    file_id_a = await _create_registered_file(app_client, sha="d" * 64)
    file_id_b = await _create_registered_file(app_client, sha="e" * 64)

    factory = app_client._test_factory  # type: ignore[attr-defined]
    from apps.api.core.db import ParsedGeometryRow

    r_a = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse", json={"fileId": file_id_a}
    )
    r_b = await app_client.post(
        f"/api/projects/{PROJECT_ID}/geometry/parse", json={"fileId": file_id_b}
    )
    geom_a = r_a.json()["geometryId"]
    geom_b = r_b.json()["geometryId"]

    async with factory() as s:
        for gid in (geom_a, geom_b):
            row = await s.get(ParsedGeometryRow, gid)
            row.parse_status = "completed"
        await s.commit()

    r1 = await app_client.patch(
        f"/api/projects/{PROJECT_ID}/geometry/{geom_a}/accept", json={}
    )
    assert r1.status_code == 200
    assert r1.json()["reviewStatus"] == "accepted"

    r2 = await app_client.patch(
        f"/api/projects/{PROJECT_ID}/geometry/{geom_b}/accept", json={}
    )
    assert r2.status_code == 200
    assert r2.json()["reviewStatus"] == "accepted"

    async with factory() as s:
        prior = await s.get(ParsedGeometryRow, geom_a)
        assert prior.review_status == "superseded"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_registered_file(
    client: AsyncClient,
    *,
    sha: str,
    filename: str = "model.ifc",
    content_type: str = "application/x-step",
) -> str:
    r = await client.post(
        f"/api/projects/{PROJECT_ID}/files/upload-url",
        json={"filename": filename, "contentType": content_type},
    )
    assert r.status_code == 201, r.text
    file_id = r.json()["fileId"]
    r2 = await client.post(
        f"/api/projects/{PROJECT_ID}/files/{file_id}/registered",
        json={"fileId": file_id, "fileSize": 1024, "sha256": sha},
    )
    assert r2.status_code == 204
    return file_id
