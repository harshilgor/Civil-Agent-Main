"""FastAPI application factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from apps.api.core.config import get_settings
from apps.api.core.logging_config import configure_logging, get_logger
from apps.api.routers import (
    files,
    geometry,
    health,
    projects,
    schemes,
    sizing,
    websocket,
)

logger = logging.getLogger("uvicorn.access")


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:  # noqa: ARG001
    configure_logging(service="civilagent.api")
    log = get_logger(__name__)
    settings = get_settings()
    log.info(
        "api.startup",
        env=settings.civilagent_env,
        parser_version=settings.parser_version,
        schema_version=settings.schema_version,
    )
    # Local-dev convenience: when running on SQLite (no Alembic / Docker
    # required), make sure the ORM tables exist before serving requests.
    # Production deploys use Postgres + Alembic and skip this branch.
    if settings.database_url.startswith("sqlite") and settings.civilagent_env == "local":
        from apps.api.core.db import Base, get_engine_and_factory

        engine, _ = get_engine_and_factory()
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        log.info("api.dev_bootstrap.schema_ready", driver="sqlite+aiosqlite")
    yield
    log.info("api.shutdown")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="CivilAgent API",
        version=settings.parser_version,
        lifespan=_lifespan,
        docs_url="/docs",
        redoc_url=None,
    )
    # Dev-time origins are always allowed so the browser can hit the API from
    # Live Server / Vite / Next dev servers without depending on env vars.
    # Production deployments should set civilagent_env != "local" and add their
    # own origins here.
    _dev_origins = [
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]
    if settings.civilagent_env == "local":
        app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
            allow_credentials=False,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["*"],
        )
    else:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=_dev_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["*"],
        )
    app.include_router(health.router)
    app.include_router(projects.router)
    app.include_router(files.router)
    app.include_router(geometry.router)
    app.include_router(schemes.router)
    app.include_router(sizing.router)
    app.include_router(sizing.assumptions_router)
    app.include_router(websocket.router)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:  # noqa: ARG001
        log = get_logger(__name__)
        log.exception("api.unhandled_error")
        # Stamp CORS headers on the error response — Starlette runs
        # exception handlers OUTSIDE the middleware stack, so without
        # this the browser sees "blocked by CORS policy" instead of the
        # real 500 and the actual error never reaches the dev console.
        origin = request.headers.get("origin")
        cors_headers: dict[str, str] = {}
        if origin and (
            settings.civilagent_env == "local" or origin in _dev_origins
        ):
            cors_headers["Access-Control-Allow-Origin"] = origin
            cors_headers["Vary"] = "Origin"
        return JSONResponse(
            status_code=500,
            content={
                "code": "INTERNAL_ERROR",
                "message": "An unexpected error occurred.",
                "context": {},
            },
            headers=cors_headers,
        )

    return app


app = create_app()
