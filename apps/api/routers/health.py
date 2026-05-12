"""Health + readiness + metrics endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from prometheus_client import generate_latest

from apps.api.core.config import Settings, get_settings
from apps.api.core.metrics import REGISTRY
from apps.api.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(settings: Annotated[Settings, Depends(get_settings)]) -> HealthResponse:
    return HealthResponse(
        status="ok",
        parserVersion=settings.parser_version,
        schemaVersion=settings.schema_version,
    )


@router.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    payload = generate_latest(REGISTRY)
    return Response(content=payload, media_type="text/plain; version=0.0.4")
