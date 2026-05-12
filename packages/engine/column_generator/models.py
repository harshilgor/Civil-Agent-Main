"""Pydantic models for the column-layout generator.

These models are the contract surface between Agent 3 and every
downstream consumer (worker → DB → API → frontend). Field renames or
removals require a bump of :data:`GENERATOR_VERSION` in
``column_generator/constants.py`` and a migration note.

The models use **snake_case** Python attribute names with **camelCase**
serialisation aliases. Use ``model.model_dump(by_alias=True)`` to get
the JSON shape the frontend expects (matching the existing
``parsed-geometry-adapter.js`` convention).

Sizing-dependent fields (``size``, ``dcr``, ``status``,
``steel_tonnage``, ``cost_index``, ``max_drift``, ``max_beam_depth``,
``unique_sections``) are intentionally :data:`None` in this agent —
they belong to Agent 4. An engineer who sees plausible-looking fake D/C
values is a liability nightmare.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from packages.engine.column_generator.constants import (
    DEFAULT_MATERIAL_SYSTEM,
    MATERIAL_BAY_LIMITS,
    STRATEGY_DEFINITIONS,
)


# ---------------------------------------------------------------------------
# Enum-ish literals
# ---------------------------------------------------------------------------

MaterialSystem = Literal[
    "steel_composite",
    "steel_moment_frame",
    "concrete_flat_plate",
    "concrete_pan_joist",
    "timber",
]
ColumnSource = Literal["generated", "existing", "locked"]
SchemeStatus = Literal["active", "alternate", "archived"]
StrategyName = Literal[
    "balanced",
    "minimum_columns",
    "short_span",
    "offset_grid",
    "long_span",
]


# ---------------------------------------------------------------------------
# Geometry primitives
# ---------------------------------------------------------------------------


class Point2D(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    x: float
    y: float


# ---------------------------------------------------------------------------
# Member models
# ---------------------------------------------------------------------------


class Column(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    grid_label: str = Field(default="", alias="gridLabel")
    x: float
    y: float
    start_level: str = Field(..., alias="startLevel")
    end_level: str = Field(..., alias="endLevel")
    locked: bool = False
    source: ColumnSource = "generated"
    # Sizing — Agent 4 owns these. Always None at Agent 3.
    size: Optional[str] = None
    dcr: Optional[float] = None
    status: Optional[str] = None
    axial_load: Optional[float] = Field(default=None, alias="axialLoad")
    tributary_area: Optional[float] = Field(default=None, alias="tributaryArea")


class Beam(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    start: Point2D
    end: Point2D
    level_id: str = Field(..., alias="levelId")
    span: float
    # Sizing — Agent 4 owns these.
    size: Optional[str] = None
    dcr: Optional[float] = None
    status: Optional[str] = None


class ShearWall(BaseModel):
    """Shear wall stored as a centreline + thickness.

    The frontend ``buildSchemeShearWall`` expects a plan polygon
    boundary; ``scheme-adapter.js`` is responsible for expanding the
    centreline by ``thickness`` into a 4-point rectangle. For Agent 3
    this list is always empty (lateral system is a separate workstream)
    so the conversion is deferred — but documenting the contract here
    keeps the 3D path correct when shear walls are ever populated.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    start: Point2D
    end: Point2D
    start_level: str = Field(..., alias="startLevel")
    end_level: str = Field(..., alias="endLevel")
    thickness: float = 12.0  # inches
    dcr: Optional[float] = None
    status: Optional[str] = None


class Brace(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    start: Point2D
    end: Point2D
    levels: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Scheme-level metrics
# ---------------------------------------------------------------------------


class SchemeMetrics(BaseModel):
    """Layout metrics that Agent 3 can compute deterministically.

    Sizing-dependent fields are present in the schema for downstream
    code, but always :data:`None` here. Agent 4 fills them in.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    column_count: int = Field(default=0, alias="columnCount")
    max_span: float = Field(default=0.0, alias="maxSpan")
    average_span: float = Field(default=0.0, alias="averageSpan")
    unique_bay_patterns: int = Field(default=0, alias="uniqueBayPatterns")
    warning_count: int = Field(default=0, alias="warningCount")
    warnings: list[str] = Field(default_factory=list)

    # Agent 4 territory.
    steel_tonnage: Optional[float] = Field(default=None, alias="steelTonnage")
    concrete_volume: Optional[float] = Field(default=None, alias="concreteVolume")
    cost_index: Optional[float] = Field(default=None, alias="costIndex")
    max_drift: Optional[str] = Field(default=None, alias="maxDrift")
    max_beam_depth: Optional[float] = Field(default=None, alias="maxBeamDepth")
    unique_sections: Optional[int] = Field(default=None, alias="uniqueSections")


# ---------------------------------------------------------------------------
# Constraints — input
# ---------------------------------------------------------------------------


class GenerationConstraints(BaseModel):
    """Input parameters for the generator.

    Defaults derive from :data:`MATERIAL_BAY_LIMITS` for the chosen
    material system. Any field can be overridden by the caller (the
    UI's "Placement" assumption set).
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    material_system: MaterialSystem = Field(
        default=DEFAULT_MATERIAL_SYSTEM, alias="materialSystem"
    )
    min_bay: Optional[float] = Field(default=None, alias="minBay")
    target_bay: Optional[float] = Field(default=None, alias="targetBay")
    max_bay: Optional[float] = Field(default=None, alias="maxBay")
    grid_regularity_preference: float = Field(
        default=1.0,
        ge=0.0,
        le=1.0,
        alias="gridRegularityPreference",
        description="0=tolerate irregular bays, 1=prefer perfectly regular",
    )
    locked_column_ids: list[str] = Field(
        default_factory=list, alias="lockedColumnIds"
    )
    strategies: Optional[list[StrategyName]] = Field(
        default=None,
        description=(
            "Strategy keys to generate, in order. Defaults to all five. "
            "Display labels (A..E) are assigned by position in this list."
        ),
    )

    def resolved_bay_limits(self) -> tuple[float, float, float]:
        """Return ``(min_bay, target_bay, max_bay)`` with material defaults
        filling any unset values."""
        defaults = MATERIAL_BAY_LIMITS.get(
            self.material_system, MATERIAL_BAY_LIMITS[DEFAULT_MATERIAL_SYSTEM]
        )
        d_min, d_target, d_max = defaults
        return (
            float(self.min_bay) if self.min_bay is not None else d_min,
            float(self.target_bay) if self.target_bay is not None else d_target,
            float(self.max_bay) if self.max_bay is not None else d_max,
        )

    def resolved_strategies(self) -> list[str]:
        """Return ordered list of strategy keys."""
        if self.strategies is None:
            return [s["key"] for s in STRATEGY_DEFINITIONS]
        return list(self.strategies)


# ---------------------------------------------------------------------------
# Top-level scheme
# ---------------------------------------------------------------------------


class StructuralScheme(BaseModel):
    """One generated column-layout variant.

    Either four or five of these are returned per call. The single
    highest-scoring variant carries ``status="active"``; the rest carry
    ``status="alternate"``. Archived schemes (from a prior generation
    run) are filtered out by the API by default.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    display_label: str = Field(..., alias="displayLabel")
    name: str
    strategy: StrategyName
    description: str = ""
    columns: list[Column] = Field(default_factory=list)
    beams: list[Beam] = Field(default_factory=list)
    shear_walls: list[ShearWall] = Field(default_factory=list, alias="shearWalls")
    braces: list[Brace] = Field(default_factory=list)
    metrics: SchemeMetrics = Field(default_factory=SchemeMetrics)
    status: SchemeStatus = "alternate"
    score: Optional[float] = None
