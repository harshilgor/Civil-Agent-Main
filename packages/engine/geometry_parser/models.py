"""Canonical Pydantic models — the contract surface of Agent 1.

These models are the single source of truth shared between:

* the parser (this package),
* the worker job that persists results,
* the FastAPI layer that returns them to the frontend,
* every downstream agent (column layout, loads, member sizing).

Field renames or removals require a bump of :data:`SCHEMA_VERSION` and
a migration note. Additions remain backward compatible.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from packages.engine.geometry_parser.constants import PARSER_VERSION, SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Geometry primitives
# ---------------------------------------------------------------------------


class Point2D(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=False)

    x: float = Field(..., description="X coordinate, feet, local frame.")
    y: float = Field(..., description="Y coordinate, feet, local frame.")


class BuildingBounds(BaseModel):
    model_config = ConfigDict(extra="forbid")

    minX: float
    minY: float
    maxX: float
    maxY: float

    @model_validator(mode="after")
    def _ordered(self) -> "BuildingBounds":
        if self.maxX < self.minX or self.maxY < self.minY:
            raise ValueError("buildingBounds: max < min")
        return self


class OriginTransform(BaseModel):
    """Local→global affine. ``global = local + (tx, ty)``.

    The parser always emits coordinates in a local frame anchored at the
    centroid of detected columns (or floor plate centroid as a fallback).
    Storing the transform makes the operation reversible for round-trip
    workflows (Revit re-import, vendor exports).
    """

    model_config = ConfigDict(extra="forbid")

    tx: float = Field(..., description="Global X offset (feet).")
    ty: float = Field(..., description="Global Y offset (feet).")
    units: Literal["ft"] = "ft"
    rotation_rad: float = 0.0


# ---------------------------------------------------------------------------
# Domain entities
# ---------------------------------------------------------------------------


class Level(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    elevation: float = Field(..., description="Feet above datum.")
    height: float = Field(..., description="Floor-to-floor height in feet.")
    planBoundary: list[Point2D] = Field(default_factory=list)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    source: str = "ifc"
    rationale: Optional[str] = Field(
        default=None, description="Human-readable explanation when inferred."
    )
    planBoundarySource: Optional[str] = Field(
        default=None,
        description=(
            "slab_footprint | columns_bbox | walls_bbox | spaces_bbox | "
            "elements_bbox — how planBoundary was obtained."
        ),
    )
    renderable: bool = Field(
        default=True,
        description="False when no usable boundary could be derived for this level.",
    )


class GridLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    axis: Literal["x", "y"]
    label: str
    coordinate: float = Field(..., description="Feet on the relevant axis (local frame).")
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    source: Literal["ifc", "inferred", "dxf", "pdf", "vision"] = "ifc"
    rationale: Optional[str] = None


class Core(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: Literal["elevator", "stair", "mixed", "service"]
    boundary: list[Point2D]
    levelIds: list[str] = Field(default_factory=list)
    confidence: float = Field(..., ge=0.0, le=1.0)
    source: str
    groupingReason: Optional[str] = None

    @field_validator("boundary")
    @classmethod
    def _boundary_min_points(cls, v: list[Point2D]) -> list[Point2D]:
        if len(v) < 3:
            raise ValueError("Core boundary requires at least 3 points.")
        return v


class ExistingColumn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    x: float
    y: float
    startLevel: str
    endLevel: str
    size: Optional[str] = None
    material: Optional[str] = None
    gridLabel: Optional[str] = None
    gridAligned: bool = True
    gridDeviation: Optional[float] = Field(
        default=None, description="Feet from nearest grid intersection. None if aligned."
    )
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    source: Literal["ifc", "dxf", "pdf", "vision"] = "ifc"
    rationale: Optional[str] = None


class Opening(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    levelId: str
    boundary: list[Point2D]
    type: Literal["shaft", "atrium", "stair_well", "duct", "other"] = "other"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    source: str = "ifc"


class NoColumnZone(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    boundary: list[Point2D]
    reason: str
    source: Literal["ifc", "inferred", "manual"]
    confidence: float = Field(..., ge=0.0, le=1.0)
    levelIds: list[str] = Field(default_factory=list)


class FloorPlate(BaseModel):
    """Detailed floor plate per level. The actual (possibly non-convex)
    boundary lives on :class:`Level.planBoundary`; the convex hull is
    pre-computed here for downstream tributary-area calculations."""

    model_config = ConfigDict(extra="forbid")

    levelId: str
    boundary: list[Point2D]
    convexHull: list[Point2D]
    isConvex: bool
    area: float = Field(..., description="Square feet (signed positive).")
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------


ParseStatus = Literal["processing", "completed", "partial", "failed"]
ReviewStatus = Literal["pending", "accepted", "superseded"]


class ParseMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: str = Field(default=SCHEMA_VERSION)
    parserVersion: str = Field(default=PARSER_VERSION)
    runId: str
    fileFormat: str
    fileHash: str
    overallConfidence: float = Field(..., ge=0.0, le=1.0)
    status: ParseStatus
    completedSteps: list[str] = Field(default_factory=list)
    failedStep: Optional[str] = None
    failedStepCode: Optional[str] = None
    warnings: list[str] = Field(default_factory=list)
    layerMapping: Optional[dict[str, str]] = None
    originTransform: OriginTransform
    parsedAt: datetime
    durationMs: Optional[int] = None
    sourceFileId: Optional[str] = None

    @field_validator("parsedAt", mode="before")
    @classmethod
    def _ensure_aware(cls, v: Any) -> Any:
        if isinstance(v, datetime) and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


# ---------------------------------------------------------------------------
# Top-level contract
# ---------------------------------------------------------------------------


class ParsedGeometry(BaseModel):
    """Canonical output of Agent 1.

    Always present (possibly empty) keys: ``levels``, ``gridLines``,
    ``cores``, ``buildingBounds``, ``metadata``. Downstream agents can
    rely on shape; missing-data is communicated via empty arrays plus
    warnings on :class:`ParseMetadata`, never via missing keys.
    """

    model_config = ConfigDict(extra="forbid")

    levels: list[Level] = Field(default_factory=list)
    gridLines: list[GridLine] = Field(default_factory=list)
    cores: list[Core] = Field(default_factory=list)
    openings: list[Opening] = Field(default_factory=list)
    existingColumns: list[ExistingColumn] = Field(default_factory=list)
    noColumnZones: list[NoColumnZone] = Field(default_factory=list)
    floorPlates: list[FloorPlate] = Field(default_factory=list)
    buildingBounds: BuildingBounds
    metadata: ParseMetadata

    def is_terminal(self) -> bool:
        return self.metadata.status in ("completed", "partial", "failed")
