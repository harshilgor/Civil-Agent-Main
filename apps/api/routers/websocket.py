"""Progress WebSocket.

Each client connecting to ``/ws/parse-progress/{geometry_id}`` is:

1. Authenticated using the same JWKS-backed JWT path as REST. Browsers
   can't send custom ``Authorization`` headers on WS handshakes, so we
   accept the token via ``?token=<jwt>`` query string. Dev environments
   may instead pass ``X-Dev-Org`` + ``X-Dev-User`` headers (only
   honoured when ``CIVILAGENT_ENV in {"local","dev"}`` and
   ``AUTH_DEV_BYPASS=true``).
2. Verified to own the geometry (cross-tenant access blocked).
3. Sent the last cached snapshot if one exists (reconnect support).
4. Subscribed to live Redis pub/sub events for that geometry.

The connection is closed cleanly once a terminal event arrives.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession

from apps.api.core.auth import _is_dev_environment
from apps.api.core.config import Settings, get_settings
from apps.api.core.db import ParsedGeometryRow, get_session
from apps.api.core.jwks import AuthError, get_verifier
from apps.api.core.logging_config import get_logger
from apps.api.core.metrics import WS_CLIENTS_CONNECTED
from apps.api.core.redis_client import (
    get_last_sizing_snapshot,
    get_last_snapshot,
    get_redis,
    progress_channel,
    sizing_progress_channel,
)

router = APIRouter(prefix="/ws", tags=["websocket"])
log = get_logger(__name__)


@dataclass(frozen=True)
class _WsPrincipal:
    user_id: str
    org_id: str


async def _resolve_ws_principal(
    websocket: WebSocket, settings: Settings
) -> _WsPrincipal | None:
    """Return a principal or ``None`` (caller closes the socket)."""
    if _is_dev_environment(settings):
        # Browsers can't send arbitrary headers on a WS handshake, so we
        # also accept the dev principal via query string. Header takes
        # priority for non-browser callers (e.g. integration tests).
        x_dev_user = (
            websocket.headers.get("x-dev-user")
            or websocket.query_params.get("user_id")
        )
        x_dev_org = (
            websocket.headers.get("x-dev-org")
            or websocket.query_params.get("org_id")
        )
        if x_dev_user and x_dev_org:
            return _WsPrincipal(user_id=x_dev_user, org_id=x_dev_org)

    token = (
        websocket.query_params.get("token")
        or websocket.headers.get("sec-websocket-protocol")
    )
    if not token:
        return None
    if token.startswith("Bearer "):
        token = token.split(" ", 1)[1]

    try:
        claims = await get_verifier().verify(token)
    except AuthError as exc:
        log.info("ws.auth_rejected", code=exc.code)
        return None

    user_id = claims.get("sub")
    org_id = (
        claims.get(settings.auth_jwt_org_claim)
        or claims.get("org")
        or claims.get("azp")
    )
    if not user_id or not org_id:
        return None
    return _WsPrincipal(user_id=str(user_id), org_id=str(org_id))


@router.websocket("/parse-progress/{geometry_id}")
async def parse_progress_socket(
    websocket: WebSocket,
    geometry_id: str,
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    principal = await _resolve_ws_principal(websocket, settings)
    if principal is None:
        WS_CLIENTS_CONNECTED.labels(result="rejected_auth").inc()
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    row = await session.get(ParsedGeometryRow, geometry_id)
    if row is None:
        WS_CLIENTS_CONNECTED.labels(result="rejected_not_found").inc()
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    from apps.api.core.db import Project

    project = await session.get(Project, row.project_id)
    if project is None or project.org_id != principal.org_id:
        WS_CLIENTS_CONNECTED.labels(result="rejected_tenant").inc()
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    WS_CLIENTS_CONNECTED.labels(result="accepted").inc()

    # ----- replay last snapshot ----------------------------------------
    snapshot = await get_last_snapshot(geometry_id)
    if snapshot:
        await websocket.send_text(json.dumps(snapshot))
        if snapshot.get("terminal"):
            await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
            return

    # ----- subscribe live ----------------------------------------------
    redis = get_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe(progress_channel(geometry_id))
    try:
        while True:
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15.0)
            if msg is None:
                # Heartbeat — keeps proxies happy and surfaces disconnects.
                try:
                    await websocket.send_text('{"type":"heartbeat"}')
                except WebSocketDisconnect:
                    break
                continue
            data = msg.get("data")
            if not data:
                continue
            try:
                await websocket.send_text(data)
            except WebSocketDisconnect:
                break
            try:
                payload = json.loads(data)
                if payload.get("terminal"):
                    await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
                    break
            except json.JSONDecodeError:
                continue
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("ws.error", geometry_id=geometry_id)
    finally:
        try:
            await pubsub.unsubscribe(progress_channel(geometry_id))
            await pubsub.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Sizing-progress (Agent 4) — scheme-scoped channel.
# ---------------------------------------------------------------------------


@router.websocket("/sizing-progress/{scheme_id}")
async def sizing_progress_socket(
    websocket: WebSocket,
    scheme_id: str,
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """Stream sizing-job progress for a single scheme.

    Same auth + reconnect semantics as the parse-progress socket, but
    keyed by scheme id and gated by scheme ownership rather than
    geometry ownership. The worker publishes to
    ``sizing-progress:{scheme_id}`` exactly once per event.
    """
    principal = await _resolve_ws_principal(websocket, settings)
    if principal is None:
        WS_CLIENTS_CONNECTED.labels(result="rejected_auth").inc()
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    from apps.api.core.db import Project, SchemeRow

    scheme = await session.get(SchemeRow, scheme_id)
    if scheme is None:
        WS_CLIENTS_CONNECTED.labels(result="rejected_not_found").inc()
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    project = await session.get(Project, scheme.project_id)
    if project is None or project.org_id != principal.org_id:
        WS_CLIENTS_CONNECTED.labels(result="rejected_tenant").inc()
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    WS_CLIENTS_CONNECTED.labels(result="accepted").inc()

    snapshot = await get_last_sizing_snapshot(scheme_id)
    if snapshot:
        await websocket.send_text(json.dumps(snapshot))
        if snapshot.get("terminal"):
            await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
            return

    redis = get_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe(sizing_progress_channel(scheme_id))
    try:
        while True:
            msg = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=15.0
            )
            if msg is None:
                try:
                    await websocket.send_text('{"type":"heartbeat"}')
                except WebSocketDisconnect:
                    break
                continue
            data = msg.get("data")
            if not data:
                continue
            try:
                await websocket.send_text(data)
            except WebSocketDisconnect:
                break
            try:
                payload = json.loads(data)
                if payload.get("terminal"):
                    await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
                    break
            except json.JSONDecodeError:
                continue
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("ws.sizing_error", scheme_id=scheme_id)
    finally:
        try:
            await pubsub.unsubscribe(sizing_progress_channel(scheme_id))
            await pubsub.close()
        except Exception:
            pass
