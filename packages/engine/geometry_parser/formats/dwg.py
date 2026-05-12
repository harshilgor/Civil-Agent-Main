"""DWG fallback handler.

DWG is the proprietary binary form of DXF. We attempt to open it via
``ezdxf``'s experimental DWG support; if that fails we return an
explicit ``DWG_UNSUPPORTED`` failure so the API can instruct the user
to re-export as DXF. We never attempt to invoke ODA / Teigha tooling.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from packages.engine.geometry_parser.constants import PARSER_VERSION, SCHEMA_VERSION
from packages.engine.geometry_parser.errors import ErrorCode, ParserError, StepFailure
from packages.engine.geometry_parser.models import (
    BuildingBounds,
    OriginTransform,
    ParseMetadata,
    ParsedGeometry,
)
from packages.engine.geometry_parser.progress import ProgressTracker

log = logging.getLogger(__name__)


async def extract_dwg(
    *,
    file_path: str,
    tracker: ProgressTracker,
    run_id: str,
    source_file_id: Optional[str],
    completed: list[str],
    warnings: list[str],
    failures: list[StepFailure],
    file_hash_: str,
    on_layer_map: Callable[[Optional[dict[str, str]]], None],
    parse_options: Optional[dict[str, Any]] = None,
) -> ParsedGeometry:
    on_layer_map(None)
    await tracker.start_step("init", detail="Attempting DWG read via ezdxf experimental loader")

    # Try the experimental DWG loader.
    try:
        from ezdxf.addons import odafc  # type: ignore

        try:
            doc = odafc.readfile(file_path)
        except Exception as exc:
            raise ParserError(
                code=ErrorCode.DWG_UNSUPPORTED,
                message=(
                    "DWG could not be opened (ODA File Converter unavailable). "
                    "Re-export the drawing as DXF and re-upload."
                ),
                step="init",
            ) from exc
        # If we got here we have a doc — delegate to the DXF extractor.
        from packages.engine.geometry_parser.formats.dxf import extract_dxf

        log.info("dwg.delegating_to_dxf")
        # ezdxf returns a Document compatible with DXF reader; we treat
        # it as a DXF and re-route through the DXF extractor by writing
        # a temp DXF copy.
        import os
        import tempfile

        tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False)
        tmp.close()
        try:
            doc.saveas(tmp.name)
            return await extract_dxf(
                file_path=tmp.name,
                tracker=tracker,
                run_id=run_id,
                source_file_id=source_file_id,
                completed=completed,
                warnings=warnings,
                failures=failures,
                file_hash_=file_hash_,
                on_layer_map=on_layer_map,
                parse_options=parse_options,
            )
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
    except ImportError as exc:
        raise ParserError(
            code=ErrorCode.DWG_UNSUPPORTED,
            message=(
                "DWG support requires the optional ezdxf ODA File Converter integration. "
                "Re-export the drawing as DXF and re-upload."
            ),
            step="init",
        ) from exc
    except ParserError:
        # The DWG_UNSUPPORTED path: return a graceful empty result with a
        # clear warning rather than letting the orchestrator turn this
        # into an opaque failure.
        warnings.append(
            f"[{ErrorCode.DWG_UNSUPPORTED.value}] step=init: "
            "DWG opening failed — please re-upload as DXF."
        )
        completed.append("init")
        await tracker.fail_step(
            "init",
            detail="DWG unsupported in this environment.",
            error_code=ErrorCode.DWG_UNSUPPORTED.value,
        )
        return ParsedGeometry(
            buildingBounds=BuildingBounds(minX=0.0, minY=0.0, maxX=0.0, maxY=0.0),
            metadata=ParseMetadata(
                schemaVersion=SCHEMA_VERSION,
                parserVersion=PARSER_VERSION,
                runId=run_id,
                fileFormat="dwg",
                fileHash=file_hash_,
                overallConfidence=0.0,
                status="processing",
                completedSteps=list(dict.fromkeys(completed)),
                warnings=list(warnings),
                originTransform=OriginTransform(tx=0.0, ty=0.0),
                parsedAt=datetime.now(timezone.utc),
                sourceFileId=source_file_id,
                failedStep="init",
                failedStepCode=ErrorCode.DWG_UNSUPPORTED.value,
            ),
        )
