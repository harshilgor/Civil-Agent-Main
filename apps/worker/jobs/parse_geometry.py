"""ARQ job: parse a previously-uploaded file and persist results.

Lifecycle:

1. Look up the source file from Postgres (tenant-scoped).
2. Download the bytes from S3 to a tmp path.
3. Drive :func:`parse_file` with a Redis-backed progress sink.
4. Write the resulting :class:`ParsedGeometry` to Postgres in a single
   transaction, transitioning ``parse_status`` to one of
   ``completed | partial | failed``.
5. **Always** clean up the tmp file in ``finally``.

Every exit path emits exactly one terminal progress event. Unhandled
exceptions are converted to a ``failed`` row plus a terminal event;
ARQ retry policy is left at default (no retries) — re-running a
deterministic parser does not buy us anything.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select

from apps.api.core.config import get_settings
from apps.api.core.db import (
    AsyncSessionLocal,
    ParsedGeometryRow,
    ProjectFile,
)
from apps.api.core.logging_config import configure_logging, get_logger
from apps.api.core.metrics import (
    PARSE_DURATION_SECONDS,
    PARSE_RUNS_TOTAL,
    PARSE_TIMEOUTS_TOTAL,
)
from apps.api.core.redis_client import progress_sink_for
from apps.api.core.s3 import download_to_path
from packages.engine.geometry_parser import (
    PARSER_VERSION,
    SCHEMA_VERSION,
    ParsedGeometry,
    parse_file,
)
from packages.engine.geometry_parser.errors import ErrorCode

log = get_logger(__name__)


async def parse_geometry_job(
    ctx: dict[str, Any],
    *,
    project_id: str,
    file_id: str,
    geometry_id: str,
    run_id: str,
    org_id: str,
    parse_options: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """ARQ entrypoint."""
    job_id: str = ctx.get("job_id", "")
    start_wall = time.monotonic()
    settings = get_settings()
    sink = progress_sink_for(geometry_id)

    log.info(
        "worker.start",
        job_id=job_id,
        run_id=run_id,
        project_id=project_id,
        file_id=file_id,
        geometry_id=geometry_id,
        org_id=org_id,
    )

    tmp_path: Optional[str] = None
    fmt = "unknown"
    try:
        async with AsyncSessionLocal() as session:
            pf = await session.scalar(
                select(ProjectFile).where(
                    ProjectFile.id == file_id,
                    ProjectFile.project_id == project_id,
                )
            )
        if pf is None:
            await _persist_failed(
                geometry_id=geometry_id,
                run_id=run_id,
                duration_ms=0,
                code=ErrorCode.FILE_NOT_FOUND.value,
                step="download",
                warnings=[
                    f"[{ErrorCode.FILE_NOT_FOUND.value}] step=download: source file not found."
                ],
            )
            from packages.engine.geometry_parser.progress import ProgressTracker

            tracker = ProgressTracker(job_id=job_id, geometry_id=geometry_id, sink=sink)
            await tracker.emit_terminal(
                status="failed",
                step="download",
                detail="Source file row missing.",
                error_code=ErrorCode.FILE_NOT_FOUND.value,
            )
            PARSE_RUNS_TOTAL.labels(status="failed", format="unknown").inc()
            return {"status": "failed"}

        fmt = pf.file_format
        ext = pf.file_format
        tmp_path = _download_temp(pf.s3_key, ext)

        geometry = await parse_file(
            file_path=tmp_path,
            run_id=run_id,
            project_id=project_id,
            job_id=job_id,
            geometry_id=geometry_id,
            progress_sink=sink,
            timeout_seconds=settings.parse_timeout_seconds,
            source_file_id=pf.id,
            parse_options=parse_options,
        )

        duration_ms = int((time.monotonic() - start_wall) * 1000)
        await _persist_result(
            geometry_id=geometry_id,
            run_id=run_id,
            geometry=geometry,
            duration_ms=duration_ms,
        )
        PARSE_RUNS_TOTAL.labels(status=geometry.metadata.status, format=fmt).inc()
        PARSE_DURATION_SECONDS.labels(
            status=geometry.metadata.status, format=fmt
        ).observe(duration_ms / 1000.0)
        if geometry.metadata.failedStepCode == ErrorCode.TIMEOUT.value:
            PARSE_TIMEOUTS_TOTAL.labels(format=fmt).inc()

        log.info(
            "worker.complete",
            job_id=job_id,
            geometry_id=geometry_id,
            status=geometry.metadata.status,
            duration_ms=duration_ms,
            warnings=len(geometry.metadata.warnings),
        )
        return {
            "status": geometry.metadata.status,
            "duration_ms": duration_ms,
            "warnings": len(geometry.metadata.warnings),
        }

    except Exception as exc:  # noqa: BLE001 — top-level safety net
        duration_ms = int((time.monotonic() - start_wall) * 1000)
        log.exception(
            "worker.unhandled",
            job_id=job_id,
            geometry_id=geometry_id,
            duration_ms=duration_ms,
        )
        warnings = [
            f"[{ErrorCode.INTERNAL_ERROR.value}] step=worker: {type(exc).__name__}: {exc}"
        ]
        await _persist_failed(
            geometry_id=geometry_id,
            run_id=run_id,
            duration_ms=duration_ms,
            code=ErrorCode.INTERNAL_ERROR.value,
            step="worker",
            warnings=warnings,
        )
        from packages.engine.geometry_parser.progress import ProgressTracker

        tracker = ProgressTracker(job_id=job_id, geometry_id=geometry_id, sink=sink)
        await tracker.emit_terminal(
            status="failed",
            detail=f"{type(exc).__name__}: {exc}",
            error_code=ErrorCode.INTERNAL_ERROR.value,
        )
        PARSE_RUNS_TOTAL.labels(status="failed", format=fmt).inc()
        return {"status": "failed", "error": str(exc)}

    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
                log.info("worker.tmp_cleanup", tmp_path=tmp_path)
            except OSError:
                log.exception("worker.tmp_cleanup_failed", tmp_path=tmp_path)


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


async def _persist_result(
    *,
    geometry_id: str,
    run_id: str,
    geometry: ParsedGeometry,
    duration_ms: int,
) -> None:
    async with AsyncSessionLocal() as session:
        row = await session.get(ParsedGeometryRow, geometry_id)
        if row is None:
            log.error("worker.row_missing", geometry_id=geometry_id, run_id=run_id)
            return
        row.parse_status = geometry.metadata.status
        row.geometry_data = geometry.model_dump(mode="json")
        row.overall_confidence = geometry.metadata.overallConfidence
        row.warnings = list(geometry.metadata.warnings)
        row.parser_version = geometry.metadata.parserVersion or PARSER_VERSION
        row.schema_version = geometry.metadata.schemaVersion or SCHEMA_VERSION
        row.failed_step = geometry.metadata.failedStep
        row.failed_step_code = geometry.metadata.failedStepCode
        row.duration_ms = duration_ms
        row.completed_at = datetime.now(timezone.utc)
        await session.commit()


async def _persist_failed(
    *,
    geometry_id: str,
    run_id: str,
    duration_ms: int,
    code: str,
    step: str,
    warnings: list[str],
) -> None:
    async with AsyncSessionLocal() as session:
        row = await session.get(ParsedGeometryRow, geometry_id)
        if row is None:
            return
        row.parse_status = "failed"
        row.warnings = warnings
        row.failed_step = step
        row.failed_step_code = code
        row.duration_ms = duration_ms
        row.completed_at = datetime.now(timezone.utc)
        await session.commit()


# ---------------------------------------------------------------------------
# S3 download helper
# ---------------------------------------------------------------------------


def _download_temp(s3_key: str, ext: str) -> str:
    fd, path = tempfile.mkstemp(suffix=f".{ext or 'bin'}", prefix="civilagent_")
    os.close(fd)
    download_to_path(key=s3_key, dest_path=path)
    return path


# ARQ requires the function to be referenced by name in worker settings.
parse_geometry_job.__qualname__ = "parse_geometry_job"
