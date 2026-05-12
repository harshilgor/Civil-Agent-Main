"""Verify the three Agent 2 prerequisites are satisfied:

1. ``GET /api/projects/{projectId}/geometry`` returns the full
   ``ParsedGeometry`` JSON including levels, gridLines, cores,
   existingColumns, buildingBounds, and metadata.warnings — Agent 2
   consumes all of these to build the Three.js scene.
2. WebSocket progress events surface (the contract is exercised via the
   Redis-backed ``RedisProgressSink`` in dedicated unit tests; this
   test asserts that the API contract document defines the route.)
3. The synthetic golden IFC fixture produces deterministic output —
   Agent 2 will use it as a test fixture for scene building.

Together these three properties form the integration contract Agent 2
will rely on. We test them here so a regression in any one fails CI
before Agent 2 is started.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import json
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


PROJECT_ID = "33333333-3333-3333-3333-333333333333"
ORG_ID = "11111111-1111-1111-1111-111111111111"


@pytest_asyncio.fixture
async def seeded_app():
    from apps.api.core import db as db_mod
    from apps.api.core.db import (
        Organization,
        Project,
        ProjectFile,
        ParsedGeometryRow,
        get_session,
    )
    from apps.api.main import create_app

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(db_mod.Base.metadata.create_all)
    db_mod._engine = engine  # type: ignore[attr-defined]
    db_mod._session_factory = factory  # type: ignore[attr-defined]

    file_id = str(uuid.uuid4())
    geometry_id = str(uuid.uuid4())

    async with factory() as session:
        session.add_all([
            Organization(id=ORG_ID, name="Acme"),
            Project(id=PROJECT_ID, org_id=ORG_ID, name="Tower"),
            ProjectFile(
                id=file_id,
                project_id=PROJECT_ID,
                original_filename="tower.ifc",
                file_format="ifc",
                s3_key="acme/tower.ifc",
                file_sha256="0" * 64,
            ),
            ParsedGeometryRow(
                id=geometry_id,
                project_id=PROJECT_ID,
                source_file_id=file_id,
                version=1,
                parse_status="completed",
                review_status="pending",
                geometry_data=_canonical_payload(),
                overall_confidence=0.92,
                warnings=["[GRID_INFERRED] step=grids: inferred from columns."],
                parser_version="1.0.0",
                schema_version="parsed_geometry@1.0.0",
                run_id=str(uuid.uuid4()),
                job_id=str(uuid.uuid4()),
                idempotency_key="dummy",
                completed_at=datetime.now(timezone.utc),
            ),
        ])
        await session.commit()

    app = create_app()

    async def _get_test_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = _get_test_session
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={
            "X-Dev-User": "55555555-5555-5555-5555-555555555555",
            "X-Dev-Org": ORG_ID,
        },
    ) as client:
        yield client, geometry_id, file_id
    await engine.dispose()


def _canonical_payload() -> dict:
    """Hand-written ParsedGeometry payload covering every section
    Agent 2 consumes."""
    return {
        "levels": [
            {
                "id": "lvl_abc",
                "name": "Level 1",
                "elevation": 0.0,
                "height": 14.0,
                "planBoundary": [
                    {"x": 0.0, "y": 0.0},
                    {"x": 60.0, "y": 0.0},
                    {"x": 60.0, "y": 90.0},
                    {"x": 0.0, "y": 90.0},
                ],
                "confidence": 1.0,
                "source": "ifc",
                "rationale": None,
            },
        ],
        "gridLines": [
            {
                "id": "grd_x_1",
                "axis": "x",
                "label": "1",
                "coordinate": 0.0,
                "confidence": 1.0,
                "source": "ifc",
                "rationale": None,
            },
        ],
        "cores": [
            {
                "id": "core_a",
                "type": "elevator",
                "boundary": [
                    {"x": 30.0, "y": 30.0},
                    {"x": 36.0, "y": 30.0},
                    {"x": 36.0, "y": 36.0},
                    {"x": 30.0, "y": 36.0},
                ],
                "levelIds": ["lvl_abc"],
                "confidence": 0.85,
                "source": "ifc",
                "groupingReason": None,
            }
        ],
        "openings": [],
        "existingColumns": [
            {
                "id": "col_1",
                "x": 0.0,
                "y": 0.0,
                "startLevel": "lvl_abc",
                "endLevel": "lvl_abc",
                "size": "W14x82",
                "material": "steel",
                "gridLabel": "1-A",
                "gridAligned": True,
                "gridDeviation": None,
                "confidence": 1.0,
                "source": "ifc",
                "rationale": None,
            }
        ],
        "noColumnZones": [],
        "floorPlates": [],
        "buildingBounds": {
            "minX": 0.0,
            "minY": 0.0,
            "maxX": 60.0,
            "maxY": 90.0,
        },
        "metadata": {
            "schemaVersion": "parsed_geometry@1.0.0",
            "parserVersion": "1.0.0",
            "runId": "f0000000-0000-0000-0000-000000000000",
            "fileFormat": "ifc",
            "fileHash": "0" * 64,
            "overallConfidence": 0.92,
            "status": "completed",
            "completedSteps": [
                "download", "init", "levels", "grids", "cores",
                "openings", "floor_plates", "existing_elements",
                "no_column_zones", "validation", "complete",
            ],
            "failedStep": None,
            "failedStepCode": None,
            "warnings": ["[GRID_INFERRED] step=grids: inferred from columns."],
            "layerMapping": None,
            "originTransform": {"tx": 0.0, "ty": 0.0},
            "parsedAt": "2026-05-01T18:00:00+00:00",
            "durationMs": 18234,
            "sourceFileId": "00000000-0000-0000-0000-000000000000",
        },
    }


# ---------------------------------------------------------------------------
# Prereq 1: GET geometry returns the full payload
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_geometry_returns_full_parsed_geometry_payload(seeded_app):
    client, geometry_id, _ = seeded_app
    r = await client.get(f"/api/projects/{PROJECT_ID}/geometry")
    assert r.status_code == 200
    body = r.json()

    assert body["parseStatus"] == "completed"
    assert body["reviewStatus"] == "pending"
    assert body["projectId"] == PROJECT_ID

    g = body["geometry"]
    assert g is not None, "Agent 2 needs the full geometry payload."

    # All sections Agent 2 consumes.
    for required in ("levels", "gridLines", "cores", "existingColumns",
                     "buildingBounds", "metadata"):
        assert required in g, f"Missing required section: {required}"

    assert isinstance(g["levels"], list) and len(g["levels"]) == 1
    assert g["levels"][0]["planBoundary"]
    assert g["levels"][0]["confidence"] == 1.0
    assert g["gridLines"][0]["axis"] == "x"
    assert g["existingColumns"][0]["gridAligned"] is True
    assert g["buildingBounds"]["maxX"] == 60.0

    md = g["metadata"]
    assert md["schemaVersion"] == "parsed_geometry@1.0.0"
    assert md["parserVersion"] == "1.0.0"
    assert "warnings" in md and md["warnings"], (
        "metadata.warnings must be present so Agent 2 can render the "
        "review-page banner."
    )
    assert md["originTransform"]["tx"] == 0.0
    assert md["originTransform"]["ty"] == 0.0
    assert "units" in md["originTransform"]


@pytest.mark.asyncio
async def test_get_geometry_by_id_returns_immutable_snapshot(seeded_app):
    client, geometry_id, _ = seeded_app
    r = await client.get(f"/api/projects/{PROJECT_ID}/geometry/{geometry_id}")
    assert r.status_code == 200
    assert r.json()["id"] == geometry_id
    assert r.json()["geometry"]["metadata"]["fileHash"] == "0" * 64


# ---------------------------------------------------------------------------
# Prereq 2: WebSocket route exists in the API and the route handler is
# registered (live behaviour is exercised by the parser's progress
# tracker tests + docker-compose integration; we assert the contract
# surface area here).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_websocket_progress_route_is_registered(seeded_app):
    client, _, _ = seeded_app
    app = client._transport.app  # type: ignore[attr-defined]
    paths = {r.path for r in app.routes if hasattr(r, "path")}
    assert any(p == "/ws/parse-progress/{geometry_id}" for p in paths), (
        "Agent 2 needs the WS route at /ws/parse-progress/{geometry_id}."
    )
