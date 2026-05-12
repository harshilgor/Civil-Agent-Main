"""Parser orchestrator.

Public entry point: :func:`parse_file`. Contract:

* Same input + parser version + config → identical output
  (excluding ``parsedAt`` / ``runId``, which are explicit metadata).
* Never crashes — any single-step failure is captured as a
  :class:`StepFailure` and the job continues toward ``partial`` status.
* Always emits exactly one terminal progress event.
* Always returns a fully populated :class:`ParsedGeometry`, even on
  catastrophic failure paths.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from packages.engine.geometry_parser.constants import (
    CONFIDENCE_WEIGHTS,
    PARSE_STEPS,
    PARSE_TIMEOUT_SECONDS,
    PARSER_VERSION,
    SUPPORTED_FORMATS,
)
from packages.engine.geometry_parser.errors import ErrorCode, ParserError, StepFailure
from packages.engine.geometry_parser.ids import file_hash
from packages.engine.geometry_parser.models import (
    BuildingBounds,
    OriginTransform,
    ParseMetadata,
    ParsedGeometry,
)
from packages.engine.geometry_parser.progress import (
    NullProgressSink,
    ProgressSink,
    ProgressTracker,
)
from packages.engine.geometry_parser.validation import validate_and_score

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------


def detect_format(path: str | Path) -> str:
    ext = Path(path).suffix.lower().lstrip(".")
    if ext not in SUPPORTED_FORMATS:
        raise ParserError(
            code=ErrorCode.UNSUPPORTED_FORMAT,
            message=f"Unsupported file extension: {ext or '(none)'}",
            step="init",
            context={"path": str(path)},
        )
    return ext


# ---------------------------------------------------------------------------
# Per-call mutable state. Passed by reference into the inner pipeline so
# that a timeout / fatal error can salvage whatever was produced before
# the deadline fired. Each ``parse_file`` invocation owns its own
# instance — no cross-call contamination.
# ---------------------------------------------------------------------------


@dataclass
class _ParseState:
    run_id: str
    project_id: str
    source_file_id: Optional[str]
    file_path: str
    file_sha: str = "unknown"
    fmt: str = "unknown"
    completed: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    failures: list[StepFailure] = field(default_factory=list)
    layer_mapping: Optional[dict[str, str]] = None
    geometry: Optional[ParsedGeometry] = None
    parse_options: dict[str, Any] = field(default_factory=dict)


FormatExtractor = Callable[..., Awaitable[ParsedGeometry]]


def _format_extractor(fmt: str) -> FormatExtractor:
    """Lazy import keeps the parser package importable in environments
    where a particular native library (IfcOpenShell, ezdxf, PyMuPDF) is
    unavailable."""
    if fmt == "ifc":
        from packages.engine.geometry_parser.formats.ifc import extract_ifc
        return extract_ifc
    if fmt == "dxf":
        from packages.engine.geometry_parser.formats.dxf import extract_dxf
        return extract_dxf
    if fmt == "dwg":
        from packages.engine.geometry_parser.formats.dwg import extract_dwg
        return extract_dwg
    if fmt == "pdf":
        from packages.engine.geometry_parser.formats.pdf import extract_pdf
        return extract_pdf
    raise ParserError(
        code=ErrorCode.UNSUPPORTED_FORMAT,
        message=f"No extractor registered for format: {fmt}",
        step="init",
    )


# ---------------------------------------------------------------------------
# Empty / fallback helpers
# ---------------------------------------------------------------------------


def _empty_bounds() -> BuildingBounds:
    return BuildingBounds(minX=0.0, minY=0.0, maxX=0.0, maxY=0.0)


def _empty_origin() -> OriginTransform:
    return OriginTransform(tx=0.0, ty=0.0)


def _terminal_metadata(
    *,
    status: str,
    file_format: str,
    file_sha: str,
    run_id: str,
    completed: list[str],
    failed_step: Optional[str],
    failed_code: Optional[str],
    warnings: list[str],
    layer_mapping: Optional[dict[str, str]],
    origin_transform: OriginTransform,
    overall_confidence: float,
    duration_ms: int,
    source_file_id: Optional[str],
) -> ParseMetadata:
    return ParseMetadata(
        runId=run_id,
        fileFormat=file_format,
        fileHash=file_sha,
        overallConfidence=overall_confidence,
        status=status,  # type: ignore[arg-type]
        completedSteps=completed,
        failedStep=failed_step,
        failedStepCode=failed_code,
        warnings=warnings,
        layerMapping=layer_mapping,
        originTransform=origin_transform,
        parsedAt=datetime.now(timezone.utc),
        durationMs=duration_ms,
        sourceFileId=source_file_id,
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def parse_file(
    *,
    file_path: str | Path,
    run_id: str,
    project_id: str,
    job_id: str,
    geometry_id: str,
    progress_sink: ProgressSink | None = None,
    timeout_seconds: int = PARSE_TIMEOUT_SECONDS,
    source_file_id: str | None = None,
    parse_options: dict[str, Any] | None = None,
) -> ParsedGeometry:
    """Parse a building file into the canonical :class:`ParsedGeometry`.

    Always returns a result. Caller does not need a try/except for
    parsing failures; check ``result.metadata.status`` instead.

    ``parse_options`` is a forward-compatible bag of per-job knobs.
    Currently honoured keys:

    * ``pageNumber`` (int, 1-based) — for PDFs only. If supplied, parses
      only that page; otherwise multi-page PDFs return one ``Level`` per
      page. Other formats ignore this key.
    """
    sink = progress_sink or NullProgressSink()
    tracker = ProgressTracker(job_id=job_id, geometry_id=geometry_id, sink=sink)
    state = _ParseState(
        run_id=run_id,
        project_id=project_id,
        source_file_id=source_file_id,
        file_path=str(file_path),
        parse_options=dict(parse_options or {}),
    )
    start = time.monotonic()

    log.info(
        "parser.start",
        extra={
            "run_id": run_id,
            "job_id": job_id,
            "geometry_id": geometry_id,
            "project_id": project_id,
            "file_path": state.file_path,
            "parser_version": PARSER_VERSION,
        },
    )

    try:
        try:
            await asyncio.wait_for(
                _run_pipeline(tracker=tracker, state=state),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            duration_ms = int((time.monotonic() - start) * 1000)
            state.warnings.append(
                f"[{ErrorCode.TIMEOUT.value}] step=timeout: parser exceeded "
                f"{timeout_seconds}s budget; returning partial result."
            )
            log.warning(
                "parser.timeout",
                extra={
                    "run_id": run_id,
                    "job_id": job_id,
                    "geometry_id": geometry_id,
                    "duration_ms": duration_ms,
                },
            )
            partial = _build_partial_result(
                state=state,
                failed_step="timeout",
                failed_code=ErrorCode.TIMEOUT.value,
                duration_ms=duration_ms,
                status="partial",
            )
            await tracker.emit_terminal(
                status="timeout",
                step="validation"
                if state.geometry is None
                else "complete",
                detail=f"Timeout after {timeout_seconds}s",
                error_code=ErrorCode.TIMEOUT.value,
            )
            return partial

        # Successful pipeline run.
        assert state.geometry is not None
        duration_ms = int((time.monotonic() - start) * 1000)
        if state.failures:
            geometry = _attach_partial_status(
                state.geometry,
                completed=state.completed,
                warnings=state.warnings,
                failed_step=state.failures[-1].step,
                failed_code=state.failures[-1].code.value,
                duration_ms=duration_ms,
            )
            log.warning(
                "parser.partial",
                extra={
                    "run_id": run_id,
                    "geometry_id": geometry_id,
                    "warnings": len(state.warnings),
                    "duration_ms": duration_ms,
                },
            )
            await tracker.emit_terminal(
                status="partial",
                detail=f"Completed with {len(state.failures)} step failure(s).",
                error_code=state.failures[-1].code.value,
            )
            return geometry

        geometry = _attach_completed_status(
            state.geometry,
            completed=state.completed,
            warnings=state.warnings,
            duration_ms=duration_ms,
        )
        log.info(
            "parser.complete",
            extra={
                "run_id": run_id,
                "geometry_id": geometry_id,
                "duration_ms": duration_ms,
                "overall_confidence": geometry.metadata.overallConfidence,
            },
        )
        await tracker.emit_terminal(status="completed", detail="Parse complete.")
        return geometry

    except ParserError as exc:
        duration_ms = int((time.monotonic() - start) * 1000)
        log.error(
            "parser.fatal",
            extra={
                "run_id": run_id,
                "geometry_id": geometry_id,
                "code": exc.code.value,
                "step": exc.step,
                "duration_ms": duration_ms,
            },
        )
        state.warnings.append(
            f"[{exc.code.value}] step={exc.step or 'unknown'}: {exc.message}"
        )
        result = _build_partial_result(
            state=state,
            failed_step=exc.step or "unknown",
            failed_code=exc.code.value,
            duration_ms=duration_ms,
            status="failed",
        )
        await tracker.emit_terminal(
            status="failed",
            step=exc.step or "init",
            detail=exc.message,
            error_code=exc.code.value,
        )
        return result

    except Exception as exc:  # pragma: no cover — defence in depth
        duration_ms = int((time.monotonic() - start) * 1000)
        log.exception(
            "parser.unhandled",
            extra={"run_id": run_id, "geometry_id": geometry_id, "duration_ms": duration_ms},
        )
        state.warnings.append(
            f"[{ErrorCode.INTERNAL_ERROR.value}] step=unknown: {type(exc).__name__}"
        )
        result = _build_partial_result(
            state=state,
            failed_step="unknown",
            failed_code=ErrorCode.INTERNAL_ERROR.value,
            duration_ms=duration_ms,
            status="failed",
        )
        await tracker.emit_terminal(
            status="failed",
            detail="Unhandled error; see warnings.",
            error_code=ErrorCode.INTERNAL_ERROR.value,
        )
        return result


# ---------------------------------------------------------------------------
# Pipeline body
# ---------------------------------------------------------------------------


async def _run_pipeline(*, tracker: ProgressTracker, state: _ParseState) -> None:
    # ----- download ----------------------------------------------------
    await tracker.start_step("download", detail="Locating local file…")
    if not os.path.exists(state.file_path):
        raise ParserError(
            code=ErrorCode.FILE_NOT_FOUND,
            message=f"File not found at {state.file_path}",
            step="download",
        )
    state.file_sha = file_hash(state.file_path)
    state.completed.append("download")
    await tracker.complete_step(
        "download",
        detail=(
            f"Located file (sha256={state.file_sha[:12]}…, "
            f"size={os.path.getsize(state.file_path)}B)"
        ),
    )

    # ----- init --------------------------------------------------------
    await tracker.start_step("init", detail="Detecting format…")
    state.fmt = detect_format(state.file_path)
    state.completed.append("init")
    await tracker.complete_step("init", detail=f"Format: {state.fmt.upper()}")

    # ----- format extraction -------------------------------------------
    extractor = _format_extractor(state.fmt)
    state.geometry = await extractor(
        file_path=state.file_path,
        tracker=tracker,
        run_id=state.run_id,
        source_file_id=state.source_file_id,
        completed=state.completed,
        warnings=state.warnings,
        failures=state.failures,
        file_hash_=state.file_sha,
        on_layer_map=lambda m: _set_layer(state, m),
        parse_options=state.parse_options,
    )

    # ----- validation --------------------------------------------------
    await tracker.start_step("validation", detail="Running consistency checks…")
    geometry, vwarnings, overall = validate_and_score(state.geometry, weights=CONFIDENCE_WEIGHTS)
    state.warnings.extend(vwarnings)
    state.geometry = geometry.model_copy(
        update={
            "metadata": geometry.metadata.model_copy(update={"overallConfidence": overall})
        }
    )
    state.completed.append("validation")
    await tracker.complete_step(
        "validation",
        detail=f"{len(vwarnings)} validation warning(s); confidence={overall:.2f}",
    )


def _set_layer(state: _ParseState, mapping: Optional[dict[str, str]]) -> None:
    state.layer_mapping = mapping


# ---------------------------------------------------------------------------
# Result builders
# ---------------------------------------------------------------------------


def _build_partial_result(
    *,
    state: _ParseState,
    failed_step: Optional[str],
    failed_code: Optional[str],
    duration_ms: int,
    status: str = "partial",
) -> ParsedGeometry:
    if state.geometry is not None:
        existing = state.geometry.metadata.layerMapping
        meta = state.geometry.metadata.model_copy(
            update={
                "status": status,
                "completedSteps": list(dict.fromkeys(state.completed)),
                "warnings": list(state.warnings),
                "failedStep": failed_step,
                "failedStepCode": failed_code,
                "durationMs": duration_ms,
                "layerMapping": state.layer_mapping or existing,
            }
        )
        return state.geometry.model_copy(update={"metadata": meta})

    return ParsedGeometry(
        levels=[],
        gridLines=[],
        cores=[],
        openings=[],
        existingColumns=[],
        noColumnZones=[],
        floorPlates=[],
        buildingBounds=_empty_bounds(),
        metadata=_terminal_metadata(
            status=status,
            file_format=state.fmt,
            file_sha=state.file_sha,
            run_id=state.run_id,
            completed=list(dict.fromkeys(state.completed)),
            failed_step=failed_step,
            failed_code=failed_code,
            warnings=list(state.warnings),
            layer_mapping=state.layer_mapping,
            origin_transform=_empty_origin(),
            overall_confidence=0.0,
            duration_ms=duration_ms,
            source_file_id=state.source_file_id,
        ),
    )


def _attach_completed_status(
    geometry: ParsedGeometry,
    *,
    completed: list[str],
    warnings: list[str],
    duration_ms: int,
) -> ParsedGeometry:
    completed_seq = list(dict.fromkeys(completed + ["complete"]))
    meta = geometry.metadata.model_copy(
        update={
            "status": "completed",
            "completedSteps": completed_seq,
            "warnings": list(warnings),
            "failedStep": None,
            "failedStepCode": None,
            "durationMs": duration_ms,
        }
    )
    return geometry.model_copy(update={"metadata": meta})


def _attach_partial_status(
    geometry: ParsedGeometry,
    *,
    completed: list[str],
    warnings: list[str],
    failed_step: str,
    failed_code: str,
    duration_ms: int,
) -> ParsedGeometry:
    meta = geometry.metadata.model_copy(
        update={
            "status": "partial",
            "completedSteps": list(dict.fromkeys(completed)),
            "warnings": list(warnings),
            "failedStep": failed_step,
            "failedStepCode": failed_code,
            "durationMs": duration_ms,
        }
    )
    return geometry.model_copy(update={"metadata": meta})


# ---------------------------------------------------------------------------
# Sentinel for extractor authors
# ---------------------------------------------------------------------------
_VALID_STEP_NAMES: frozenset[str] = frozenset(PARSE_STEPS)


def assert_valid_step(name: str) -> None:
    if name not in _VALID_STEP_NAMES:
        raise ParserError(
            code=ErrorCode.INTERNAL_ERROR,
            message=f"unknown step name: {name}",
            step="init",
        )


__all__ = [
    "_ParseState",
    "assert_valid_step",
    "detect_format",
    "parse_file",
]
