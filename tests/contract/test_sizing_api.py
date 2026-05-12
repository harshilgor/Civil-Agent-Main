"""Contract tests for the sizing API (Agent 4).

Mirrors the harness from ``test_schemes_api``: in-memory SQLite, ARQ +
Redis stubbed, dev-bypass auth headers. Verifies:

* POST /calculate enqueues a job + flips lifecycle columns
* GET /members returns sized data when present, empty list when not
* GET /members/{id} returns the per-member detail with takedown
* GET /takedown groups by column
* Cross-tenant access returns 404 for every endpoint
* Status thresholds align with the frontend's DCR_THRESHOLDS
"""

from __future__ import annotations

import os
import uuid

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


async def _seed_scheme_with_data(
    client: AsyncClient,
    *,
    project_id: str = PROJECT_ID,
    sizing_status: str = "unsized",
    columns_data: list | None = None,
    beams_data: list | None = None,
) -> tuple[str, str]:
    """Insert a geometry + scheme, return ``(geometry_id, scheme_id)``."""
    from apps.api.core.db import ParsedGeometryRow, SchemeRow
    from tests.fixtures.parsed_geometry_fixture import make_fixture

    factory = client._test_factory  # type: ignore[attr-defined]
    geometry_id = str(uuid.uuid4())
    scheme_id = str(uuid.uuid4())
    async with factory() as session:
        session.add(
            ParsedGeometryRow(
                id=geometry_id,
                project_id=project_id,
                version=1,
                parse_status="completed",
                review_status="pending",
                geometry_data=make_fixture(),
                parser_version="1.0.0",
                schema_version="parsed_geometry@1.0.0",
                run_id=str(uuid.uuid4()),
                idempotency_key=f"key-{geometry_id[:8]}",
            )
        )
        session.add(
            SchemeRow(
                id=scheme_id,
                project_id=project_id,
                geometry_id=geometry_id,
                display_label="A",
                name="Test Scheme",
                strategy="balanced",
                description="",
                status="active",
                columns_data=columns_data
                if columns_data is not None
                else [
                    {
                        "id": "C-1",
                        "x": 0,
                        "y": 0,
                        "startLevel": "L3",
                        "endLevel": "L1",
                        "locked": False,
                        "source": "generated",
                        "gridLabel": "A-1",
                    }
                ],
                beams_data=beams_data
                if beams_data is not None
                else [
                    {
                        "id": "B-1",
                        "start": {"x": 0, "y": 0},
                        "end": {"x": 30, "y": 0},
                        "levelId": "L2",
                        "span": 30.0,
                    }
                ],
                shear_walls_data=[],
                braces_data=[],
                metrics={"column_count": 1, "max_span": 30.0,
                         "average_span": 30.0, "unique_bay_patterns": 1,
                         "warning_count": 0, "warnings": []},
                score=85.0,
                sizing_status=sizing_status,
                generation_run_id=str(uuid.uuid4()),
            )
        )
        await session.commit()
    return geometry_id, scheme_id


async def _insert_member_check(
    client: AsyncClient,
    *,
    scheme_id: str,
    member_id: str,
    member_type: str = "beam",
    selected_size: str = "W21x44",
    check_type: str = "flexure",
    dcr: float = 0.81,
    governing: bool = True,
    status: str = "efficient",
) -> str:
    from apps.api.core.db import MemberCheckRow

    factory = client._test_factory  # type: ignore[attr-defined]
    cid = str(uuid.uuid4())
    async with factory() as session:
        session.add(
            MemberCheckRow(
                id=cid,
                scheme_id=scheme_id,
                member_id=member_id,
                member_type=member_type,
                selected_size=selected_size,
                check_type=check_type,
                demand=472.5,
                capacity=583.0,
                dcr=dcr,
                status=status,
                governing=governing,
                load_combination="1.2D + 1.6L",
                explanation="Test explanation.",
                demand_unit="kip-ft",
                capacity_unit="kip-ft",
                warnings=[],
            )
        )
        await session.commit()
    return cid


async def _insert_takedown(
    client: AsyncClient,
    *,
    scheme_id: str,
    column_id: str,
    level_idx: int,
    factored_load_kip: float,
) -> None:
    from apps.api.core.db import ColumnTakedownRow

    factory = client._test_factory  # type: ignore[attr-defined]
    async with factory() as session:
        session.add(
            ColumnTakedownRow(
                id=str(uuid.uuid4()),
                scheme_id=scheme_id,
                column_id=column_id,
                level_id=f"L{8-level_idx}",
                level_name=f"Level {8-level_idx}",
                level_index_from_top=level_idx,
                tributary_area_sf=900.0,
                cumulative_tributary_area_sf=900.0 * (level_idx + 1),
                dead_load_kip=67.5 * (level_idx + 1),
                live_load_kip=27.0 * (level_idx + 1),
                live_load_unreduced_kip=45.0 * (level_idx + 1),
                reduction_factor=max(0.40, 0.6 / (level_idx + 1)),
                factored_load_kip=factored_load_kip,
                governing_combination="1.2D + 1.6L",
            )
        )
        await session.commit()


# ---------------------------------------------------------------------------
# POST /calculate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_calculate_returns_202_with_job_id(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(app_client)
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/calculate",
        json={},
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["jobId"]
    assert body["schemeId"] == scheme_id
    assert body["sizingRunId"]
    assert body["status"] == "queued"


@pytest.mark.asyncio
async def test_calculate_flips_scheme_status_to_calculating(app_client: AsyncClient):
    from apps.api.core.db import SchemeRow

    _, scheme_id = await _seed_scheme_with_data(app_client)
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/calculate",
        json={},
    )
    assert r.status_code == 202

    factory = app_client._test_factory  # type: ignore[attr-defined]
    async with factory() as session:
        row = await session.get(SchemeRow, scheme_id)
    assert row is not None
    assert row.sizing_status == "calculating"
    assert row.sizing_run_id is not None


@pytest.mark.asyncio
async def test_calculate_writes_audit_event(app_client: AsyncClient):
    from apps.api.core.db import AuditLog
    from sqlalchemy import select

    _, scheme_id = await _seed_scheme_with_data(app_client)
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/calculate",
        json={"assumptions": {"deadLoadPsf": 100.0}},
    )
    assert r.status_code == 202

    factory = app_client._test_factory  # type: ignore[attr-defined]
    async with factory() as session:
        rows = (await session.scalars(
            select(AuditLog).where(AuditLog.event_type == "sizing_calculation")
        )).all()
    assert len(rows) == 1
    assert rows[0].payload["scheme_id"] == scheme_id
    assert rows[0].payload["assumptions_provided"] is True


@pytest.mark.asyncio
async def test_calculate_returns_404_for_unknown_scheme(app_client: AsyncClient):
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/{uuid.uuid4()}/calculate",
        json={},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "SCHEME_NOT_FOUND"


@pytest.mark.asyncio
async def test_calculate_returns_404_for_cross_tenant_scheme(
    app_client: AsyncClient,
):
    """Cross-tenant access yields 404, never leaks existence."""
    _, scheme_id = await _seed_scheme_with_data(
        app_client, project_id=OTHER_PROJECT_ID
    )
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/calculate",
        json={},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_calculate_returns_422_when_scheme_empty(app_client: AsyncClient):
    """Empty scheme — nothing to size."""
    _, scheme_id = await _seed_scheme_with_data(
        app_client, columns_data=[], beams_data=[]
    )
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/calculate",
        json={},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "SCHEME_EMPTY"


@pytest.mark.asyncio
async def test_calculate_enqueues_arq_job(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(app_client)
    r = await app_client.post(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/calculate",
        json={},
    )
    assert r.status_code == 202
    jobs = app_client._captured_jobs  # type: ignore[attr-defined]
    assert len(jobs) == 1
    assert jobs[0]["args"][0] == "calculate_sizing_job"
    assert jobs[0]["kwargs"]["scheme_id"] == scheme_id


# ---------------------------------------------------------------------------
# GET /members
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_members_returns_empty_when_unsized(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(app_client)
    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/members"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["sizingStatus"] == "unsized"
    assert body["members"] == []
    # Default assumptions echoed.
    assert body["assumptionsUsed"]["deadLoadPsf"] == 75.0


@pytest.mark.asyncio
async def test_members_returns_summaries_when_sized(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(
        app_client, sizing_status="sized"
    )
    await _insert_member_check(
        app_client,
        scheme_id=scheme_id,
        member_id="B-1",
        check_type="flexure",
        dcr=0.85,
        governing=False,
    )
    await _insert_member_check(
        app_client,
        scheme_id=scheme_id,
        member_id="B-1",
        check_type="deflection_total",
        dcr=0.91,
        governing=True,
        status="efficient",
    )

    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/members"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["sizingStatus"] == "sized"
    assert len(body["members"]) == 1
    member = body["members"][0]
    assert member["memberId"] == "B-1"
    assert member["governingCheck"] == "deflection_total"
    assert member["dcr"] == 0.91
    assert len(member["allChecks"]) == 2


@pytest.mark.asyncio
async def test_members_404_cross_tenant(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(
        app_client, project_id=OTHER_PROJECT_ID
    )
    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/members"
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# GET /members/{member_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_member_detail_returns_full_check_set(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(app_client)
    await _insert_member_check(
        app_client, scheme_id=scheme_id, member_id="B-1",
        check_type="flexure", governing=True,
    )
    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/members/B-1"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["memberId"] == "B-1"
    assert len(body["summary"]["allChecks"]) == 1
    assert body["takedown"] == []  # not a column


@pytest.mark.asyncio
async def test_member_detail_for_column_includes_takedown(
    app_client: AsyncClient,
):
    _, scheme_id = await _seed_scheme_with_data(app_client)
    await _insert_member_check(
        app_client,
        scheme_id=scheme_id,
        member_id="C-1",
        member_type="column",
        check_type="axial_compression",
        governing=True,
        selected_size="W14x82",
    )
    for i in range(3):
        await _insert_takedown(
            app_client,
            scheme_id=scheme_id,
            column_id="C-1",
            level_idx=i,
            factored_load_kip=100.0 * (i + 1),
        )

    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/members/C-1"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["memberType"] == "column"
    assert len(body["takedown"]) == 3
    # Sorted by level_index_from_top ascending.
    indices = [t["levelIndexFromTop"] for t in body["takedown"]]
    assert indices == sorted(indices)


@pytest.mark.asyncio
async def test_member_detail_404_for_unknown_member(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(app_client)
    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/members/unknown"
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "MEMBER_NOT_FOUND"


# ---------------------------------------------------------------------------
# GET /takedown
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_takedown_groups_by_column(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(app_client)
    for i in range(3):
        await _insert_takedown(
            app_client,
            scheme_id=scheme_id,
            column_id="C-1",
            level_idx=i,
            factored_load_kip=100.0 * (i + 1),
        )
    for i in range(3):
        await _insert_takedown(
            app_client,
            scheme_id=scheme_id,
            column_id="C-2",
            level_idx=i,
            factored_load_kip=200.0 * (i + 1),
        )

    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/takedown"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["schemeId"] == scheme_id
    assert len(body["columns"]) == 2
    by_id = {c["columnId"]: c for c in body["columns"]}
    assert "C-1" in by_id
    assert len(by_id["C-1"]["levels"]) == 3
    # Levels ordered from top (index 0) to bottom (index 2).
    indices = [l["levelIndexFromTop"] for l in by_id["C-1"]["levels"]]
    assert indices == [0, 1, 2]


@pytest.mark.asyncio
async def test_takedown_includes_grid_label(app_client: AsyncClient):
    _, scheme_id = await _seed_scheme_with_data(app_client)
    await _insert_takedown(
        app_client,
        scheme_id=scheme_id,
        column_id="C-1",
        level_idx=0,
        factored_load_kip=100.0,
    )
    r = await app_client.get(
        f"/api/projects/{PROJECT_ID}/schemes/{scheme_id}/takedown"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["columns"][0]["gridLabel"] == "A-1"


# ---------------------------------------------------------------------------
# Project assumptions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assumptions_returns_defaults_when_unset(app_client: AsyncClient):
    r = await app_client.get(f"/api/projects/{PROJECT_ID}/assumptions")
    assert r.status_code == 200
    body = r.json()
    assert body["projectId"] == PROJECT_ID
    assert body["assumptions"]["deadLoadPsf"] == 75.0
    assert body["assumptions"]["liveLoadPsf"] == 50.0
    assert body["updatedAt"] is None


@pytest.mark.asyncio
async def test_assumptions_upsert_persists_overrides(app_client: AsyncClient):
    r = await app_client.put(
        f"/api/projects/{PROJECT_ID}/assumptions",
        json={"deadLoadPsf": 100.0, "liveLoadPsf": 80.0},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["assumptions"]["deadLoadPsf"] == 100.0
    assert body["assumptions"]["liveLoadPsf"] == 80.0
    assert body["updatedAt"] is not None

    # Read-back returns the persisted values.
    r = await app_client.get(f"/api/projects/{PROJECT_ID}/assumptions")
    assert r.json()["assumptions"]["deadLoadPsf"] == 100.0


@pytest.mark.asyncio
async def test_assumptions_404_for_cross_tenant_project(app_client: AsyncClient):
    r = await app_client.get(f"/api/projects/{OTHER_PROJECT_ID}/assumptions")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Status threshold alignment with frontend
# ---------------------------------------------------------------------------


def test_status_strings_match_frontend_constants():
    """Backend status labels must use the exact strings the frontend
    uses. ``js/data/constants.js`` ``dcrToStatus()`` returns:
        "pass" | "efficient" | "near-capacity" | "fail" | "unsized"
    Any drift here means engineers see one label in the audit trail
    and another in the 3D overlay — confusing at best, dangerous at
    worst."""
    from packages.engine.member_sizer.constants import (
        STATUS_EFFICIENT,
        STATUS_FAIL,
        STATUS_NEAR_CAPACITY,
        STATUS_PASS,
        STATUS_UNSIZED,
        dcr_to_status,
    )

    assert STATUS_PASS == "pass"
    assert STATUS_EFFICIENT == "efficient"
    assert STATUS_NEAR_CAPACITY == "near-capacity"
    assert STATUS_FAIL == "fail"
    assert STATUS_UNSIZED == "unsized"

    # Threshold smoke test.
    assert dcr_to_status(0.50) == "pass"
    assert dcr_to_status(0.85) == "efficient"
    assert dcr_to_status(0.95) == "near-capacity"
    assert dcr_to_status(1.5) == "fail"
    assert dcr_to_status(None) == "unsized"
    assert dcr_to_status(-0.1) == "unsized"
