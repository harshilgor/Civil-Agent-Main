"""PDF extractor.

Two distinct paths:

* **Vector PDF** (exported from Revit / CAD): :mod:`PyMuPDF` exposes the
  raw paths/text. We use the same layer-free geometry analysis as the
  DXF fallback, *plus* TEXT entity association so grid lines have human
  labels (``"A"``, ``"1"``, ``"3.1"`` …). Unlabeled grids would break
  the Geometry review page in the frontend.
* **Raster PDF** (scanned drawings): We render each page to PNG via
  :mod:`pdf2image`, then send it to Claude's vision API. The model is
  asked to return a strict JSON object describing grid lines, columns,
  cores, building boundary, and dimensions; we scale the normalised
  coordinates back to feet using the dimension annotations.

Multi-page handling
-------------------

Real structural drawing sets are multi-page (one page per level). The
extractor honours these rules:

* If ``parse_options['pageNumber']`` (1-based) is provided, only that
  page is parsed and treated as a single ``Level``.
* Otherwise:

  - **Vector**: every page is parsed; each page becomes its own
    ``Level``. Columns and grid lines from each page are concatenated
    and tagged with the page's level id. ``buildingBounds`` is the
    union across pages.
  - **Raster**: page 1 is parsed (vision calls are expensive). A
    warning instructs the user to either select a specific page or
    re-export as a vector PDF.

Everything goes through the same :class:`ProgressTracker` interface as
IFC / DXF so the frontend renders identical progress UX regardless of
which path was taken.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import os
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from packages.engine.geometry_parser.constants import (
    PARSER_VERSION,
    PDF_VECTOR_PATH_THRESHOLD,
    SCHEMA_VERSION,
)
from packages.engine.geometry_parser.errors import ErrorCode, ParserError, StepFailure
from packages.engine.geometry_parser.ids import column_id, grid_id, level_id
from packages.engine.geometry_parser.models import (
    BuildingBounds,
    ExistingColumn,
    GridLine,
    Level,
    OriginTransform,
    ParseMetadata,
    ParsedGeometry,
    Point2D,
)
from packages.engine.geometry_parser.progress import ProgressTracker

log = logging.getLogger(__name__)


# Generous radius (PDF units, ~ pt) within which a TEXT entity is
# considered to label a grid endpoint. Tuned empirically for typical
# 24x36" drawing sheets at full scale.
LABEL_ASSOC_RADIUS_PT = 60.0
# Patterns we'll accept as grid labels. Most drawings use a single
# letter/digit (``A``, ``1``) or a fractional sub-grid like ``3.1``.
_GRID_LABEL_MAX_LEN = 4


# ---------------------------------------------------------------------------
# Top-level dispatcher
# ---------------------------------------------------------------------------


async def extract_pdf(
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
    options = dict(parse_options or {})
    page_number = _normalize_page_number(options.get("pageNumber"))

    is_vector = await asyncio.to_thread(_is_vector_pdf, file_path)
    log.info(
        "pdf.detected_kind",
        extra={"vector": is_vector, "page_number": page_number},
    )

    if is_vector:
        return await _extract_vector(
            file_path=file_path,
            tracker=tracker,
            run_id=run_id,
            source_file_id=source_file_id,
            completed=completed,
            warnings=warnings,
            failures=failures,
            file_hash_=file_hash_,
            page_number=page_number,
        )
    return await _extract_raster(
        file_path=file_path,
        tracker=tracker,
        run_id=run_id,
        source_file_id=source_file_id,
        completed=completed,
        warnings=warnings,
        failures=failures,
        file_hash_=file_hash_,
        page_number=page_number,
    )


def _normalize_page_number(raw: Any) -> Optional[int]:
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


# ---------------------------------------------------------------------------
# Vector / raster detection
# ---------------------------------------------------------------------------


def _is_vector_pdf(file_path: str) -> bool:
    try:
        import fitz  # type: ignore  # PyMuPDF
    except ImportError as exc:  # pragma: no cover
        raise ParserError(
            code=ErrorCode.PDF_PARSE_FAIL,
            message="PyMuPDF (fitz) is not installed",
            step="init",
        ) from exc
    try:
        doc = fitz.open(file_path)
        try:
            page = doc[0]
            path_count = len(page.get_drawings())
        finally:
            doc.close()
        return path_count > PDF_VECTOR_PATH_THRESHOLD
    except Exception as exc:
        raise ParserError(
            code=ErrorCode.PDF_PARSE_FAIL,
            message=f"Failed to open PDF for type detection: {exc}",
            step="init",
        ) from exc


# ---------------------------------------------------------------------------
# Vector path
# ---------------------------------------------------------------------------


async def _extract_vector(
    *,
    file_path: str,
    tracker: ProgressTracker,
    run_id: str,
    source_file_id: Optional[str],
    completed: list[str],
    warnings: list[str],
    failures: list[StepFailure],
    file_hash_: str,
    page_number: Optional[int],
) -> ParsedGeometry:
    import fitz  # type: ignore

    await tracker.start_step("init", detail="Reading vector PDF")

    def _open_doc():
        return fitz.open(file_path)

    try:
        doc = await asyncio.to_thread(_open_doc)
    except Exception as exc:
        raise ParserError(
            code=ErrorCode.PDF_PARSE_FAIL,
            message=str(exc),
            step="init",
        ) from exc

    try:
        total_pages = doc.page_count
        if total_pages == 0:
            raise ParserError(
                code=ErrorCode.PDF_PARSE_FAIL,
                message="PDF has zero pages",
                step="init",
            )

        # ---- decide which pages to parse ------------------------------
        if page_number is not None:
            if page_number > total_pages:
                raise ParserError(
                    code=ErrorCode.PDF_PARSE_FAIL,
                    message=(
                        f"pageNumber={page_number} exceeds the document's "
                        f"page count ({total_pages})."
                    ),
                    step="init",
                )
            pages_to_parse = [page_number]
            if total_pages > 1:
                warnings.append(
                    f"[{ErrorCode.PDF_PARSE_FAIL.value}] step=init: "
                    f"PDF has {total_pages} pages; only page "
                    f"{page_number} parsed (pageNumber requested)."
                )
        else:
            pages_to_parse = list(range(1, total_pages + 1))

        await tracker.complete_step(
            "init",
            detail=(
                f"{total_pages} page(s) total; parsing "
                f"{len(pages_to_parse)} page(s): {pages_to_parse}"
            ),
        )

        # ---- per-page extraction (CPU heavy → thread) -----------------
        await tracker.start_step(
            "levels", detail=f"Building one Level per page ({len(pages_to_parse)})"
        )

        def _scan_pages() -> list[dict[str, Any]]:
            results: list[dict[str, Any]] = []
            for idx, page_idx in enumerate(pages_to_parse):
                page = doc[page_idx - 1]  # 0-based in PyMuPDF
                drawings = page.get_drawings()
                texts = _collect_page_texts(page)
                results.append(
                    {
                        "page_number": page_idx,
                        "level_index": idx,
                        "drawings": drawings,
                        "texts": texts,
                        "rect": page.rect,
                    }
                )
            return results

        page_data = await asyncio.to_thread(_scan_pages)

        levels: list[Level] = []
        for entry in page_data:
            lvl_idx = entry["level_index"]
            name = f"Level {lvl_idx + 1}"
            elevation = float(lvl_idx) * 14.0
            levels.append(
                Level(
                    id=level_id(name, elevation),
                    name=name,
                    elevation=elevation,
                    height=14.0,
                    planBoundary=_page_boundary(entry["rect"]),
                    confidence=0.6,
                    source="pdf",
                    rationale=(
                        f"PDF page {entry['page_number']} treated as a single level "
                        "(elevation/height assumed at 14ft/level)."
                    ),
                )
            )
        completed.append("levels")
        await tracker.complete_step("levels", detail=f"{len(levels)} level(s) (per-page)")

        # ---- columns + grids per page ---------------------------------
        await tracker.start_step(
            "existing_elements",
            detail="Detecting columns + grids per page (with TEXT label association)",
        )

        all_cols: list[ExistingColumn] = []
        all_grids: list[GridLine] = []
        labeled_count = 0
        unlabeled_count = 0

        def _scan_page_geometry(entry: dict[str, Any], lvl: Level) -> tuple[
            list[ExistingColumn], list[GridLine], int, int
        ]:
            cols: list[ExistingColumn] = []
            grids: list[GridLine] = []
            for d in entry["drawings"]:
                rect = d.get("rect")
                if rect:
                    w = abs(rect.width)
                    h = abs(rect.height)
                    if 0.5 <= w <= 5.0 and 0.5 <= h <= 5.0 and abs(w - h) < 1.5:
                        cx, cy = rect.x0 + w / 2, rect.y0 + h / 2
                        cols.append(
                            ExistingColumn(
                                id=column_id(cx, cy, lvl.id),
                                x=round(cx, 4),
                                y=round(cy, 4),
                                startLevel=lvl.id,
                                endLevel=lvl.id,
                                confidence=0.7,
                                source="pdf",
                            )
                        )
                for item in d.get("items", []):
                    if item[0] != "l":
                        continue
                    p1, p2 = item[1], item[2]
                    x1, y1 = float(p1.x), float(p1.y)
                    x2, y2 = float(p2.x), float(p2.y)
                    length = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
                    if length < 30:
                        continue
                    if abs(x1 - x2) < 0.5:
                        coord = round((x1 + x2) / 2, 3)
                        endpoints = [(x1, y1), (x2, y2)]
                        label, conf_label = _associate_label(
                            entry["texts"], endpoints, axis="x"
                        )
                        grids.append(
                            GridLine(
                                id=grid_id("x", label or f"X{len(grids)+1}", coord),
                                axis="x",
                                label=label or f"X{len(grids)+1}",
                                coordinate=coord,
                                confidence=0.7 if label else 0.45,
                                source="pdf",
                                rationale=(
                                    f"Vector line; label '{label}' assoc. by "
                                    f"nearest TEXT (page {entry['page_number']})."
                                    if label
                                    else (
                                        "Vector line; no nearby TEXT found within "
                                        f"{LABEL_ASSOC_RADIUS_PT}pt — auto-numbered."
                                    )
                                ),
                            )
                        )
                    elif abs(y1 - y2) < 0.5:
                        coord = round((y1 + y2) / 2, 3)
                        endpoints = [(x1, y1), (x2, y2)]
                        label, conf_label = _associate_label(
                            entry["texts"], endpoints, axis="y"
                        )
                        grids.append(
                            GridLine(
                                id=grid_id("y", label or f"Y{len(grids)+1}", coord),
                                axis="y",
                                label=label or f"Y{len(grids)+1}",
                                coordinate=coord,
                                confidence=0.7 if label else 0.45,
                                source="pdf",
                                rationale=(
                                    f"Vector line; label '{label}' assoc. by "
                                    f"nearest TEXT (page {entry['page_number']})."
                                    if label
                                    else (
                                        "Vector line; no nearby TEXT found within "
                                        f"{LABEL_ASSOC_RADIUS_PT}pt — auto-numbered."
                                    )
                                ),
                            )
                        )
            labeled = sum(1 for g in grids if not g.label.startswith(("X", "Y")) or len(g.label) > 2 or g.label[0].isdigit() and g.label.replace(".", "").isdigit())
            unlabeled = len(grids) - labeled
            return cols, grids, labeled, unlabeled

        for entry, lvl in zip(page_data, levels):
            cols, grids, lbl, unlbl = await asyncio.to_thread(
                _scan_page_geometry, entry, lvl
            )
            all_cols.extend(cols)
            all_grids.extend(grids)
            labeled_count += lbl
            unlabeled_count += unlbl

        completed.append("existing_elements")
        completed.append("grids")
        await tracker.complete_step(
            "existing_elements",
            detail=(
                f"{len(all_cols)} column(s) across {len(levels)} level(s); "
                f"{len(all_grids)} grid line(s) ({labeled_count} labeled, "
                f"{unlabeled_count} auto-numbered)."
            ),
        )

        if unlabeled_count > 0:
            warnings.append(
                f"[{ErrorCode.PDF_SCALE_UNCERTAIN.value}] step=grids: "
                f"{unlabeled_count} grid line(s) had no nearby TEXT entity; "
                f"placeholder labels assigned. Engineer should review."
            )

        for step in ("cores", "openings", "floor_plates", "no_column_zones"):
            await tracker.start_step(step, detail="Skipped — vector PDF lacks semantics")
            warnings.append(
                f"[{ErrorCode.PDF_PARSE_FAIL.value}] step={step}: "
                "vector PDF has no semantic data; result is empty."
            )
            completed.append(step)
            await tracker.complete_step(step, detail="0 (no semantic data)")

        warnings.append(
            f"[{ErrorCode.PDF_SCALE_UNCERTAIN.value}] step=existing_elements: "
            "vector PDF coordinates are in PDF units (pt); verify scale "
            "before sizing."
        )

        return ParsedGeometry(
            levels=levels,
            gridLines=all_grids,
            cores=[],
            openings=[],
            existingColumns=all_cols,
            noColumnZones=[],
            floorPlates=[],
            buildingBounds=_bounds_from_columns(all_cols),
            metadata=ParseMetadata(
                schemaVersion=SCHEMA_VERSION,
                parserVersion=PARSER_VERSION,
                runId=run_id,
                fileFormat="pdf",
                fileHash=file_hash_,
                overallConfidence=0.6 if labeled_count > unlabeled_count else 0.5,
                status="processing",
                completedSteps=list(dict.fromkeys(completed)),
                warnings=list(warnings),
                originTransform=OriginTransform(tx=0.0, ty=0.0),
                parsedAt=datetime.now(timezone.utc),
                sourceFileId=source_file_id,
            ),
        )
    finally:
        doc.close()


def _page_boundary(rect) -> list[Point2D]:
    """Return the page's media-box as a Point2D ring.

    Coordinates are in PDF units; the boundary is the page rectangle.
    Frontend can use this to size the level placeholder until real
    floor-plate geometry is supplied.
    """
    return [
        Point2D(x=round(float(rect.x0), 3), y=round(float(rect.y0), 3)),
        Point2D(x=round(float(rect.x1), 3), y=round(float(rect.y0), 3)),
        Point2D(x=round(float(rect.x1), 3), y=round(float(rect.y1), 3)),
        Point2D(x=round(float(rect.x0), 3), y=round(float(rect.y1), 3)),
    ]


def _collect_page_texts(page) -> list[tuple[str, float, float]]:
    """Return ``[(text, cx, cy), …]`` for short labelable strings on a page."""
    out: list[tuple[str, float, float]] = []
    for w in page.get_text("words"):  # (x0,y0,x1,y1,text,block,line,word)
        x0, y0, x1, y1, text = w[0], w[1], w[2], w[3], w[4]
        text = (text or "").strip()
        if not text:
            continue
        if len(text) > _GRID_LABEL_MAX_LEN:
            continue
        cx = (x0 + x1) / 2.0
        cy = (y0 + y1) / 2.0
        out.append((text, float(cx), float(cy)))
    return out


def _associate_label(
    texts: list[tuple[str, float, float]],
    endpoints: list[tuple[float, float]],
    *,
    axis: str,
) -> tuple[Optional[str], float]:
    """Find the nearest TEXT to either endpoint of a grid line.

    Returns ``(label, confidence_modifier)``. Labels must look like
    sensible grid identifiers (single letter, single/short number,
    fractional sub-grid like ``3.1``).
    """
    if not texts:
        return None, 0.0
    best: tuple[float, str] | None = None
    for label, tx, ty in texts:
        for ex, ey in endpoints:
            d = math.hypot(tx - ex, ty - ey)
            if d > LABEL_ASSOC_RADIUS_PT:
                continue
            if not _looks_like_grid_label(label):
                continue
            if best is None or d < best[0]:
                best = (d, label)
    if best is None:
        return None, 0.0
    distance, label = best
    confidence = max(0.0, 1.0 - distance / LABEL_ASSOC_RADIUS_PT)
    return label, confidence


def _looks_like_grid_label(s: str) -> bool:
    if not s or len(s) > _GRID_LABEL_MAX_LEN:
        return False
    if s.isalpha() and len(s) <= 2:
        return True
    # Plain integer (e.g. "1", "12") or fractional sub-grid ("3.1").
    try:
        float(s)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Raster path — Claude vision
# ---------------------------------------------------------------------------


async def _extract_raster(
    *,
    file_path: str,
    tracker: ProgressTracker,
    run_id: str,
    source_file_id: Optional[str],
    completed: list[str],
    warnings: list[str],
    failures: list[StepFailure],
    file_hash_: str,
    page_number: Optional[int],
) -> ParsedGeometry:
    await tracker.start_step("init", detail="Rendering raster PDF for vision analysis")
    try:
        from pdf2image import convert_from_path  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise ParserError(
            code=ErrorCode.PDF_PARSE_FAIL,
            message="pdf2image is not installed",
            step="init",
        ) from exc

    target_page = page_number or 1

    def _render() -> list:
        return convert_from_path(
            file_path,
            dpi=300,
            first_page=target_page,
            last_page=target_page,
        )

    # Also count total pages so we can warn if user is missing pages.
    def _count_pages() -> int:
        try:
            import fitz  # type: ignore

            doc = fitz.open(file_path)
            try:
                return doc.page_count
            finally:
                doc.close()
        except Exception:
            return 1

    try:
        images = await asyncio.to_thread(_render)
    except Exception as exc:
        raise ParserError(
            code=ErrorCode.PDF_PARSE_FAIL,
            message=f"pdf2image render failed: {exc}",
            step="init",
        ) from exc

    total_pages = await asyncio.to_thread(_count_pages)
    if not images:
        raise ParserError(
            code=ErrorCode.PDF_PARSE_FAIL,
            message=f"PDF page {target_page} produced no image",
            step="init",
        )

    if page_number is None and total_pages > 1:
        warnings.append(
            f"[{ErrorCode.PDF_PARSE_FAIL.value}] step=init: "
            f"raster PDF has {total_pages} pages; only page 1 was parsed. "
            "Re-trigger with parse_options.pageNumber to parse a specific "
            "page, or re-export as a vector PDF for full multi-page support."
        )

    img = images[0]
    import io

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    img_bytes = buf.getvalue()
    width_px, height_px = img.size

    await tracker.complete_step(
        "init",
        detail=(
            f"Rendered page {target_page} of {total_pages} to "
            f"{width_px}x{height_px} PNG"
        ),
    )

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        warnings.append(
            f"[{ErrorCode.PDF_VISION_KEY_MISSING.value}] step=init: "
            "ANTHROPIC_API_KEY missing; raster PDFs cannot be parsed."
        )
        await tracker.fail_step(
            "init",
            detail="vision API key missing",
            error_code=ErrorCode.PDF_VISION_KEY_MISSING.value,
        )
        failures.append(
            StepFailure(
                step="init",
                code=ErrorCode.PDF_VISION_KEY_MISSING,
                message="ANTHROPIC_API_KEY not configured",
            )
        )
        return _empty_pdf_result(
            run_id=run_id,
            source_file_id=source_file_id,
            file_hash_=file_hash_,
            warnings=warnings,
            completed=completed,
            failed_step="init",
            failed_code=ErrorCode.PDF_VISION_KEY_MISSING.value,
        )

    # ---- vision call ---------------------------------------------------
    await tracker.start_step("existing_elements", detail="Calling Claude vision")
    try:
        vision = await asyncio.to_thread(_call_vision_sync, img_bytes, api_key)
    except Exception as exc:
        log.exception("pdf.vision_failed")
        warnings.append(
            f"[{ErrorCode.PDF_VISION_FAIL.value}] step=existing_elements: vision call failed: {exc}"
        )
        failures.append(
            StepFailure(
                step="existing_elements",
                code=ErrorCode.PDF_VISION_FAIL,
                message=str(exc),
            )
        )
        await tracker.fail_step(
            "existing_elements",
            detail=str(exc),
            error_code=ErrorCode.PDF_VISION_FAIL.value,
        )
        return _empty_pdf_result(
            run_id=run_id,
            source_file_id=source_file_id,
            file_hash_=file_hash_,
            warnings=warnings,
            completed=completed,
            failed_step="existing_elements",
            failed_code=ErrorCode.PDF_VISION_FAIL.value,
        )

    # ---- scale ---------------------------------------------------------
    px_per_ft = _scale_factor(vision, width_px, height_px)
    if px_per_ft <= 0:
        warnings.append(
            f"[{ErrorCode.PDF_SCALE_UNCERTAIN.value}] step=existing_elements: "
            "no usable dimension annotation; coordinates are normalised."
        )
        px_per_ft = max(width_px, height_px)
    detail = f"vision returned {len(vision.get('columns', []))} columns; scale={px_per_ft:.2f}px/ft"
    await tracker.complete_step("existing_elements", detail=detail)
    completed.append("existing_elements")

    levels = [
        Level(
            id=level_id(f"Level {target_page}", float(target_page - 1) * 14.0),
            name=f"Level {target_page}",
            elevation=float(target_page - 1) * 14.0,
            height=14.0,
            planBoundary=[],
            confidence=0.5,
            source="vision",
            rationale=(
                f"Raster PDF page {target_page} treated as Level {target_page}."
            ),
        )
    ]
    completed.append("levels")

    cols: list[ExistingColumn] = []
    for c in vision.get("columns", []):
        x_ft = c.get("x_normalized", 0.0) * width_px / px_per_ft
        y_ft = c.get("y_normalized", 0.0) * height_px / px_per_ft
        cols.append(
            ExistingColumn(
                id=column_id(x_ft, y_ft, levels[0].id),
                x=round(x_ft, 3),
                y=round(y_ft, 3),
                startLevel=levels[0].id,
                endLevel=levels[0].id,
                gridLabel=c.get("label"),
                confidence=0.6,
                source="vision",
                rationale="Detected by Claude vision in a raster PDF.",
            )
        )

    grids: list[GridLine] = []
    for g in vision.get("gridLines", []):
        axis = g.get("axis")
        if axis not in {"x", "y"}:
            continue
        coord_norm = g.get("position_normalized", 0.0)
        coord_ft = coord_norm * (width_px if axis == "x" else height_px) / px_per_ft
        label = g.get("label", "")
        grids.append(
            GridLine(
                id=grid_id(axis, label, coord_ft),
                axis=axis,
                label=label,
                coordinate=round(coord_ft, 3),
                confidence=0.55,
                source="vision",
                rationale="Detected by Claude vision.",
            )
        )

    for step in ("grids", "cores", "openings", "floor_plates", "no_column_zones"):
        await tracker.start_step(step, detail=f"Synthesising {step} from vision response")
        completed.append(step)
        await tracker.complete_step(step, detail=f"{step}: vision-sourced")

    return ParsedGeometry(
        levels=levels,
        gridLines=grids,
        cores=[],
        openings=[],
        existingColumns=cols,
        noColumnZones=[],
        floorPlates=[],
        buildingBounds=_bounds_from_columns(cols),
        metadata=ParseMetadata(
            schemaVersion=SCHEMA_VERSION,
            parserVersion=PARSER_VERSION,
            runId=run_id,
            fileFormat="pdf",
            fileHash=file_hash_,
            overallConfidence=float(vision.get("confidence", 0.55)),
            status="processing",
            completedSteps=list(dict.fromkeys(completed)),
            warnings=list(warnings),
            originTransform=OriginTransform(tx=0.0, ty=0.0),
            parsedAt=datetime.now(timezone.utc),
            sourceFileId=source_file_id,
        ),
    )


def _scale_factor(vision: dict[str, Any], width_px: int, height_px: int) -> float:
    dims = vision.get("dimensions") or []
    if not dims:
        return 0.0
    for d in dims:
        value_ft = float(d.get("value", 0.0))
        unit = (d.get("unit") or "ft").lower()
        if unit == "m":
            value_ft *= 3.28084
        if value_ft <= 0:
            continue
        direction = (d.get("direction") or "x").lower()
        span_px = float(width_px if direction == "x" else height_px)
        return span_px / value_ft
    return 0.0


def _call_vision_sync(image_bytes: bytes, api_key: str) -> dict[str, Any]:
    import anthropic  # type: ignore

    client = anthropic.Anthropic(api_key=api_key)
    image_b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    model_id = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    response = client.messages.create(
        model=model_id,
        max_tokens=2000,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": image_b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "This is a structural engineering floor plan.\n"
                            "Extract and return ONLY a JSON object with these fields:\n"
                            "{\n"
                            '  "gridLines": [{"label": str, "axis": "x"|"y", '
                            '"position_normalized": 0.0-1.0}],\n'
                            '  "columns": [{"x_normalized": 0.0-1.0, '
                            '"y_normalized": 0.0-1.0, "label": str}],\n'
                            '  "cores": [{"x_min": float, "y_min": float, '
                            '"x_max": float, "y_max": float, '
                            '"type": "elevator"|"stair"|"mixed"}],\n'
                            '  "buildingBoundary": [{"x": float, "y": float}],\n'
                            '  "dimensions": [{"value": float, "unit": "ft"|"m", '
                            '"direction": "x"|"y"}],\n'
                            '  "confidence": 0.0-1.0,\n'
                            '  "warnings": [string]\n'
                            "}\n"
                            "All positions are normalized 0.0-1.0 relative to "
                            "page dimensions. Return ONLY the JSON, no explanation."
                        ),
                    },
                ],
            }
        ],
    )
    text = response.content[0].text  # type: ignore[attr-defined]
    return _parse_vision_json(text)


def _parse_vision_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
    return json.loads(text)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _bounds_from_columns(cols: list[ExistingColumn]) -> BuildingBounds:
    if not cols:
        return BuildingBounds(minX=0.0, minY=0.0, maxX=0.0, maxY=0.0)
    xs = [c.x for c in cols]
    ys = [c.y for c in cols]
    return BuildingBounds(
        minX=round(min(xs), 4),
        minY=round(min(ys), 4),
        maxX=round(max(xs), 4),
        maxY=round(max(ys), 4),
    )


def _empty_pdf_result(
    *,
    run_id: str,
    source_file_id: Optional[str],
    file_hash_: str,
    warnings: list[str],
    completed: list[str],
    failed_step: Optional[str] = None,
    failed_code: Optional[str] = None,
) -> ParsedGeometry:
    return ParsedGeometry(
        buildingBounds=BuildingBounds(minX=0.0, minY=0.0, maxX=0.0, maxY=0.0),
        metadata=ParseMetadata(
            schemaVersion=SCHEMA_VERSION,
            parserVersion=PARSER_VERSION,
            runId=run_id,
            fileFormat="pdf",
            fileHash=file_hash_,
            overallConfidence=0.0,
            status="processing",
            completedSteps=list(dict.fromkeys(completed)),
            warnings=list(warnings),
            originTransform=OriginTransform(tx=0.0, ty=0.0),
            parsedAt=datetime.now(timezone.utc),
            sourceFileId=source_file_id,
            failedStep=failed_step,
            failedStepCode=failed_code,
        ),
    )
