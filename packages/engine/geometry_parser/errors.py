"""Structured error taxonomy for the geometry parser.

Every error raised inside the parser carries a stable :class:`ErrorCode`
so that on-call dashboards, alerting, and the runbook can refer to errors
by code rather than free-text. New codes MUST be appended to the enum
(never reordered) to preserve historical telemetry.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ErrorCode(str, Enum):
    UNKNOWN_FORMAT = "UNKNOWN_FORMAT"
    UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"
    DOWNLOAD_FAIL = "DOWNLOAD_FAIL"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"
    FILE_NOT_FOUND = "FILE_NOT_FOUND"
    FILE_READ_FAIL = "FILE_READ_FAIL"

    IFC_GEOMETRY_FAIL = "IFC_GEOMETRY_FAIL"
    IFC_SCHEMA_UNSUPPORTED = "IFC_SCHEMA_UNSUPPORTED"
    IFC_NO_STRUCTURAL_ELEMENTS = "IFC_NO_STRUCTURAL_ELEMENTS"

    DXF_LAYER_UNKNOWN = "DXF_LAYER_UNKNOWN"
    DXF_PARSE_FAIL = "DXF_PARSE_FAIL"

    DWG_UNSUPPORTED = "DWG_UNSUPPORTED"
    DWG_OPEN_FAIL = "DWG_OPEN_FAIL"

    PDF_PARSE_FAIL = "PDF_PARSE_FAIL"
    PDF_SCALE_UNCERTAIN = "PDF_SCALE_UNCERTAIN"
    PDF_VISION_FAIL = "PDF_VISION_FAIL"
    PDF_VISION_KEY_MISSING = "PDF_VISION_KEY_MISSING"

    EXTRACTOR_FAIL = "EXTRACTOR_FAIL"
    INFERENCE_FAIL = "INFERENCE_FAIL"
    VALIDATION_FAIL = "VALIDATION_FAIL"
    TIMEOUT = "TIMEOUT"
    INTERNAL_ERROR = "INTERNAL_ERROR"


@dataclass(frozen=True, slots=True)
class ParserError(Exception):
    """Base error raised inside the parser pipeline."""

    code: ErrorCode
    message: str
    step: str | None = None
    context: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        Exception.__init__(self, f"[{self.code.value}] {self.message}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code.value,
            "message": self.message,
            "step": self.step,
            "context": dict(self.context),
        }


@dataclass(frozen=True, slots=True)
class TimeoutParserError(ParserError):
    """Raised when the global parse timeout fires."""


@dataclass(frozen=True, slots=True)
class StepFailure:
    """Captured non-fatal failure of a single parsing step.

    The orchestrator stores these in :class:`ParseMetadata.warnings`
    rather than raising, so the caller still receives partial results.
    """

    step: str
    code: ErrorCode
    message: str
    context: dict[str, Any] = field(default_factory=dict)

    def to_warning(self) -> str:
        return f"[{self.code.value}] step={self.step}: {self.message}"
