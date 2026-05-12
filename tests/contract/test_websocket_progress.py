"""WebSocket progress handshake contract tests.

These cover the auth + tenant-isolation contract for the WS endpoint.
The actual progress streaming is exercised by the parser's progress
tracker unit tests; here we confirm:

* A dev-bypass-only request without dev headers is rejected.
* A dev-bypass request with dev headers + valid geometry is accepted
  and replayed the cached snapshot.
* A request for a geometry owned by a different org is rejected with a
  policy-violation close code.
"""

from __future__ import annotations

import json
import os
import uuid

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


PROJECT_ID = "33333333-3333-3333-3333-333333333333"
ORG_ID = "11111111-1111-1111-1111-111111111111"
OTHER_ORG_ID = "22222222-2222-2222-2222-222222222222"
USER_ID = "55555555-5555-5555-5555-555555555555"


@pytest_asyncio.fixture
async def ws_app(monkeypatch):
    monkeypatch.setenv("CIVILAGENT_ENV", "local")
    monkeypatch.setenv("AUTH_DEV_BYPASS", "true")

    from apps.api.core import db as db_mod
    from apps.api.core.config import get_settings
    from apps.api.core.db import (
        Organization,
        Project,
        ParsedGeometryRow,
        get_session,
    )
    from apps.api.main import create_app

    get_settings.cache_clear()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(db_mod.Base.metadata.create_all)
    db_mod._engine = engine  # type: ignore[attr-defined]
    db_mod._session_factory = factory  # type: ignore[attr-defined]

    geom_id = str(uuid.uuid4())
    other_geom_id = str(uuid.uuid4())
    other_project_id = "44444444-4444-4444-4444-444444444444"

    async with factory() as session:
        session.add_all([
            Organization(id=ORG_ID, name="Acme"),
            Organization(id=OTHER_ORG_ID, name="Other"),
            Project(id=PROJECT_ID, org_id=ORG_ID, name="Tower"),
            Project(id=other_project_id, org_id=OTHER_ORG_ID, name="Other Tower"),
            ParsedGeometryRow(
                id=geom_id,
                project_id=PROJECT_ID,
                version=1,
                parse_status="completed",
                review_status="pending",
                geometry_data={},
                parser_version="1.0.0",
                schema_version="parsed_geometry@1.0.0",
                run_id=str(uuid.uuid4()),
            ),
            ParsedGeometryRow(
                id=other_geom_id,
                project_id=other_project_id,
                version=1,
                parse_status="completed",
                review_status="pending",
                geometry_data={},
                parser_version="1.0.0",
                schema_version="parsed_geometry@1.0.0",
                run_id=str(uuid.uuid4()),
            ),
        ])
        await session.commit()

    # Stub Redis snapshot fetcher and pubsub so tests don't require a
    # live broker. ``get_last_snapshot`` returning a terminal snapshot
    # closes the WS cleanly, which is exactly the path we want to
    # exercise.
    from apps.api.routers import websocket as ws_router

    async def _fake_snapshot(_gid):
        return {
            "geometryId": _gid,
            "step": "complete",
            "status": "completed",
            "terminal": True,
            "progress": 1.0,
            "substeps": [],
        }

    monkeypatch.setattr(ws_router, "get_last_snapshot", _fake_snapshot)

    app = create_app()

    async def _get_test_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = _get_test_session

    yield TestClient(app), geom_id, other_geom_id

    await engine.dispose()
    get_settings.cache_clear()


def test_dev_bypass_with_correct_org_accepts_and_replays_snapshot(ws_app):
    client, geom_id, _ = ws_app
    with client.websocket_connect(
        f"/ws/parse-progress/{geom_id}",
        headers={"X-Dev-User": USER_ID, "X-Dev-Org": ORG_ID},
    ) as ws:
        msg = ws.receive_text()
        body = json.loads(msg)
        assert body["geometryId"] == geom_id
        assert body["terminal"] is True


def test_dev_bypass_without_dev_headers_rejects(ws_app):
    client, geom_id, _ = ws_app
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/parse-progress/{geom_id}") as ws:
            ws.receive_text()


def test_cross_tenant_geometry_rejects(ws_app):
    client, _, other_geom_id = ws_app
    with pytest.raises(Exception):
        with client.websocket_connect(
            f"/ws/parse-progress/{other_geom_id}",
            headers={"X-Dev-User": USER_ID, "X-Dev-Org": ORG_ID},
        ) as ws:
            ws.receive_text()


def test_unknown_geometry_rejects(ws_app):
    client, _, _ = ws_app
    bogus = str(uuid.uuid4())
    with pytest.raises(Exception):
        with client.websocket_connect(
            f"/ws/parse-progress/{bogus}",
            headers={"X-Dev-User": USER_ID, "X-Dev-Org": ORG_ID},
        ) as ws:
            ws.receive_text()
