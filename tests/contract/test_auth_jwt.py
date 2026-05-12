"""End-to-end JWT verification tests.

We sign tokens with a freshly-generated RSA keypair, expose the public
key via a synthetic JWKS dict, and patch the JWKS verifier's HTTP fetch
to return that dict. Every failure mode (expired, wrong issuer, wrong
audience, missing kid, missing org claim, prod-bypass abuse) is
exercised.
"""

from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import ASGITransport, AsyncClient
from jwt.algorithms import RSAAlgorithm
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


PROJECT_ID = "33333333-3333-3333-3333-333333333333"
ORG_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "55555555-5555-5555-5555-555555555555"


@pytest.fixture(scope="module")
def keypair():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    public_jwk["kid"] = "test-kid-1"
    public_jwk["alg"] = "RS256"
    public_jwk["use"] = "sig"
    return private_key, public_jwk


def _sign(
    private_key,
    *,
    sub: str = USER_ID,
    org_id: str = ORG_ID,
    aud: str = "civilagent",
    iss: str = "https://idp.example.test",
    exp_offset: int = 3600,
    extra: dict[str, Any] | None = None,
    kid: str = "test-kid-1",
) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": sub,
        "org_id": org_id,
        "aud": aud,
        "iss": iss,
        "iat": now,
        "exp": now + exp_offset,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, private_key, algorithm="RS256", headers={"kid": kid})


@pytest_asyncio.fixture
async def jwt_client(monkeypatch, keypair):
    private_key, public_jwk = keypair
    jwks_doc = {"keys": [public_jwk]}

    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    monkeypatch.setenv("AUTH_JWKS_URL", "https://idp.example.test/.well-known/jwks.json")
    monkeypatch.setenv("AUTH_JWT_ISSUER", "https://idp.example.test")
    monkeypatch.setenv("AUTH_JWT_AUDIENCE", "civilagent")
    monkeypatch.setenv("AUTH_DEV_BYPASS", "false")
    monkeypatch.setenv("CIVILAGENT_ENV", "dev")

    from apps.api.core import db as db_mod
    from apps.api.core import jwks as jwks_mod
    from apps.api.core.config import get_settings
    from apps.api.core.db import (
        Organization,
        Project,
        get_session,
    )
    from apps.api.main import create_app

    get_settings.cache_clear()
    jwks_mod.reset_verifier_for_tests()

    # Bypass real network — return our synthetic JWKS doc.
    class _FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def get(self, url):
            return _FakeResponse(jwks_doc)

    monkeypatch.setattr("apps.api.core.jwks.httpx.AsyncClient", _FakeClient)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(db_mod.Base.metadata.create_all)
    db_mod._engine = engine  # type: ignore[attr-defined]
    db_mod._session_factory = factory  # type: ignore[attr-defined]

    async with factory() as session:
        session.add_all([
            Organization(id=ORG_ID, name="Acme"),
            Project(id=PROJECT_ID, org_id=ORG_ID, name="Tower"),
        ])
        await session.commit()

    app = create_app()

    async def _get_test_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = _get_test_session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client._private_key = private_key  # type: ignore[attr-defined]
        yield client

    await engine.dispose()
    jwks_mod.reset_verifier_for_tests()


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


# A protected endpoint we can hit without coupling to S3/Redis. The
# upload-url endpoint authenticates first, validates project ownership
# next, then presigns. Auth-only assertions look at the 401 short-circuit.
_PROTECTED_PATH = f"/api/projects/{PROJECT_ID}/geometry"


@pytest.mark.asyncio
async def test_valid_token_authenticates_protected_endpoint(jwt_client):
    token = _sign(jwt_client._private_key)
    r = await jwt_client.get(
        _PROTECTED_PATH,
        headers={"Authorization": f"Bearer {token}"},
    )
    # No geometry yet → 404 GEOMETRY_NOT_FOUND. What matters is we got
    # past auth/tenancy without a 401/403.
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "GEOMETRY_NOT_FOUND"


# ---------------------------------------------------------------------------
# Failure paths — every code is stable + asserted
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_authorization_returns_401(jwt_client):
    r = await jwt_client.get(_PROTECTED_PATH)
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "AUTH_MISSING_TOKEN"


@pytest.mark.asyncio
async def test_expired_token_rejected(jwt_client):
    token = _sign(jwt_client._private_key, exp_offset=-60)
    r = await jwt_client.get(
        _PROTECTED_PATH, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "AUTH_TOKEN_EXPIRED"


@pytest.mark.asyncio
async def test_wrong_audience_rejected(jwt_client):
    token = _sign(jwt_client._private_key, aud="some-other-app")
    r = await jwt_client.get(
        _PROTECTED_PATH, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "AUTH_AUDIENCE_INVALID"


@pytest.mark.asyncio
async def test_wrong_issuer_rejected(jwt_client):
    token = _sign(jwt_client._private_key, iss="https://attacker.example.com")
    r = await jwt_client.get(
        _PROTECTED_PATH, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "AUTH_ISSUER_INVALID"


@pytest.mark.asyncio
async def test_unknown_kid_rejected(jwt_client):
    token = _sign(jwt_client._private_key, kid="not-a-real-kid")
    r = await jwt_client.get(
        _PROTECTED_PATH, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "AUTH_KID_UNKNOWN"


@pytest.mark.asyncio
async def test_token_without_org_claim_rejected(jwt_client):
    now = int(time.time())
    payload = {
        "sub": USER_ID,
        "aud": "civilagent",
        "iss": "https://idp.example.test",
        "iat": now,
        "exp": now + 3600,
    }
    token = jwt.encode(
        payload, jwt_client._private_key,
        algorithm="RS256", headers={"kid": "test-kid-1"},
    )
    r = await jwt_client.get(
        _PROTECTED_PATH, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "AUTH_MISSING_ORG"


@pytest.mark.asyncio
async def test_cross_tenant_via_jwt_returns_404(jwt_client):
    """A valid JWT for a different org cannot see another tenant's project."""
    token = _sign(
        jwt_client._private_key,
        org_id="22222222-2222-2222-2222-222222222222",
    )
    r = await jwt_client.get(
        _PROTECTED_PATH,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "PROJECT_NOT_FOUND"


@pytest.mark.asyncio
async def test_dev_bypass_refused_in_prod(monkeypatch, jwt_client):
    """Even if dev headers are sent, env=prod must refuse to honour them."""
    from apps.api.core.config import get_settings

    monkeypatch.setenv("CIVILAGENT_ENV", "prod")
    monkeypatch.setenv("AUTH_DEV_BYPASS", "true")
    get_settings.cache_clear()
    try:
        r = await jwt_client.get(
            _PROTECTED_PATH,
            headers={"X-Dev-User": USER_ID, "X-Dev-Org": ORG_ID},
        )
        assert r.status_code == 401
        assert r.json()["detail"]["code"] == "AUTH_MISSING_TOKEN"
    finally:
        get_settings.cache_clear()
