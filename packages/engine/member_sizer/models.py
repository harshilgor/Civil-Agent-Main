"""Pydantic models for the load calculator + member sizer (Agent 4).

Contract surface between the engine and every downstream consumer
(worker → DB → API → frontend). Field renames or removals require a
bump of :data:`SIZER_VERSION` in ``constants.py``.

Casing convention matches Agent 3: snake_case Python attributes with
camelCase serialisation aliases. Use ``model.model_dump(by_alias=True)``
for the JSON shape the frontend expects, or ``mode="json"`` to also
serialise enums/dates.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from packages.engine.member_sizer.constants import (
    DEFAULT_BEAM_SELF_WEIGHT_PLF,
    DEFAULT_DEAD_LOAD_PSF,
    DEFAULT_E_KSI,
    DEFAULT_FY_KSI,
    DEFAULT_K_FACTOR,
    DEFAULT_LIVE_LOAD_PSF,
    DEFAULT_ROOF_DEAD_LOAD_PSF,
    DEFAULT_ROOF_LIVE_LOAD_PSF,
    BEAM_LIVE_DEFLECTION_LIMIT,
    BEAM_TOTAL_DEFLECTION_LIMIT,
    ROOF_LIVE_DEFLECTION_LIMIT,
)


MemberType = Literal["beam", "column"]
CheckType = Literal[
    "flexure",
    "shear",
    "deflection_live",
    "deflection_total",
    "axial_compression",
    "slenderness",
]
StatusLabel = Literal["pass", "efficient", "near-capacity", "fail", "unsized"]


# ---------------------------------------------------------------------------
# Input — engineer-controlled assumptions
# ---------------------------------------------------------------------------


class SizingAssumptions(BaseModel):
    """Engineering parameters that control the calculation.

    Defaults match :mod:`packages.engine.member_sizer.constants`. The
    project_assumptions table stores per-project overrides; the worker
    materialises this model from JSON so anything not in the JSON
    falls back to the constants module's default.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    dead_load_psf: float = Field(
        default=DEFAULT_DEAD_LOAD_PSF, alias="deadLoadPsf", gt=0
    )
    live_load_psf: float = Field(
        default=DEFAULT_LIVE_LOAD_PSF, alias="liveLoadPsf", ge=0
    )
    roof_dead_load_psf: float = Field(
        default=DEFAULT_ROOF_DEAD_LOAD_PSF, alias="roofDeadLoadPsf", ge=0
    )
    roof_live_load_psf: float = Field(
        default=DEFAULT_ROOF_LIVE_LOAD_PSF, alias="roofLiveLoadPsf", ge=0
    )
    fy_ksi: float = Field(default=DEFAULT_FY_KSI, alias="fyKsi", gt=0)
    e_ksi: float = Field(default=DEFAULT_E_KSI, alias="eKsi", gt=0)
    beam_live_load_deflection_limit: str = Field(
        default=BEAM_LIVE_DEFLECTION_LIMIT,
        alias="beamLiveLoadDeflectionLimit",
    )
    beam_total_load_deflection_limit: str = Field(
        default=BEAM_TOTAL_DEFLECTION_LIMIT,
        alias="beamTotalLoadDeflectionLimit",
    )
    roof_live_load_deflection_limit: str = Field(
        default=ROOF_LIVE_DEFLECTION_LIMIT,
        alias="roofLiveLoadDeflectionLimit",
    )
    column_k_factor: float = Field(
        default=DEFAULT_K_FACTOR, alias="columnKFactor", gt=0
    )
    beam_self_weight_plf: float = Field(
        default=DEFAULT_BEAM_SELF_WEIGHT_PLF,
        alias="beamSelfWeightPlf",
        gt=0,
    )

    def parse_deflection_denominator(self, limit_str: str) -> float:
        """Parse "L/360" → 360.0. Accepts ``L/n`` or just ``n``.

        Falls back to a very permissive value (1.0) if the string is
        un-parseable so the engine never crashes — but the warnings
        list will surface it.
        """
        s = (limit_str or "").strip().upper().replace(" ", "")
        if s.startswith("L/"):
            s = s[2:]
        try:
            return max(float(s), 1.0)
        except ValueError:
            return 360.0


# ---------------------------------------------------------------------------
# Output — per-failure-mode check
# ---------------------------------------------------------------------------


class MemberCheck(BaseModel):
    """Single failure-mode evaluation for one member.

    Every beam yields three (flexure, shear, deflection_live) plus
    deflection_total when applicable. Every column yields one
    (axial_compression) plus a slenderness warning when KL/r > 200.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    scheme_id: str = Field(..., alias="schemeId")
    member_id: str = Field(..., alias="memberId")
    member_type: MemberType = Field(..., alias="memberType")
    selected_size: str = Field(..., alias="selectedSize")
    check_type: CheckType = Field(..., alias="checkType")
    demand: float
    capacity: float
    dcr: float
    status: StatusLabel
    governing: bool = False
    load_combination: str = Field(default="", alias="loadCombination")
    explanation: str = ""
    demand_unit: str = Field(default="", alias="demandUnit")
    capacity_unit: str = Field(default="", alias="capacityUnit")
    warnings: list[str] = Field(default_factory=list)


class MemberSizingSummary(BaseModel):
    """Roll-up of all checks for a single member, with the governing
    one identified."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    member_id: str = Field(..., alias="memberId")
    member_type: MemberType = Field(..., alias="memberType")
    selected_size: str = Field(..., alias="selectedSize")
    weight_plf: float = Field(..., alias="weightPlf")
    length_ft: float = Field(default=0.0, alias="lengthFt")
    dcr: float
    governing_check: CheckType = Field(..., alias="governingCheck")
    status: StatusLabel
    all_checks: list[MemberCheck] = Field(default_factory=list, alias="allChecks")
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Output — column load takedown
# ---------------------------------------------------------------------------


class ColumnTakedownEntry(BaseModel):
    """Cumulative load on a column at one level.

    Levels are reported top-to-bottom: the topmost entry is the load
    arriving at the underside of the roof, the bottom entry is the
    foundation reaction.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    column_id: str = Field(..., alias="columnId")
    level_id: str = Field(..., alias="levelId")
    level_name: str = Field(..., alias="levelName")
    level_index_from_top: int = Field(..., alias="levelIndexFromTop")
    tributary_area_sf: float = Field(..., alias="tributaryAreaSf")
    cumulative_tributary_area_sf: float = Field(
        ..., alias="cumulativeTributaryAreaSf"
    )
    dead_load_kip: float = Field(..., alias="deadLoadKip")
    live_load_kip: float = Field(..., alias="liveLoadKip")
    live_load_unreduced_kip: float = Field(..., alias="liveLoadUnreducedKip")
    reduction_factor: float = Field(..., alias="reductionFactor")
    factored_load_kip: float = Field(..., alias="factoredLoadKip")
    governing_combination: str = Field(..., alias="governingCombination")


# ---------------------------------------------------------------------------
# Top-level sizing result
# ---------------------------------------------------------------------------


class UpdatedSchemeMetrics(BaseModel):
    """Subset of ``SchemeMetrics`` that Agent 4 fills in.

    Returned alongside the per-member results so the worker can patch
    the scheme row's ``metrics`` JSONB column without re-deriving the
    Agent 3 fields.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    steel_tonnage: Optional[float] = Field(default=None, alias="steelTonnage")
    concrete_volume: Optional[float] = Field(
        default=None, alias="concreteVolume"
    )
    cost_index: Optional[float] = Field(default=None, alias="costIndex")
    max_drift: Optional[str] = Field(default=None, alias="maxDrift")
    max_beam_depth: Optional[float] = Field(default=None, alias="maxBeamDepth")
    unique_sections: Optional[int] = Field(default=None, alias="uniqueSections")


class SizingResult(BaseModel):
    """Output of :func:`calculate_scheme_sizing`.

    The worker writes the per-member rows to ``member_checks`` and
    ``column_takedowns``; the metrics dict is patched into the scheme
    row's JSONB ``metrics`` column.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    scheme_id: str = Field(..., alias="schemeId")
    beam_summaries: list[MemberSizingSummary] = Field(
        default_factory=list, alias="beamSummaries"
    )
    column_summaries: list[MemberSizingSummary] = Field(
        default_factory=list, alias="columnSummaries"
    )
    column_takedowns: list[ColumnTakedownEntry] = Field(
        default_factory=list, alias="columnTakedowns"
    )
    updated_metrics: UpdatedSchemeMetrics = Field(
        default_factory=UpdatedSchemeMetrics, alias="updatedMetrics"
    )
    assumptions_used: SizingAssumptions = Field(..., alias="assumptionsUsed")
    warnings: list[str] = Field(default_factory=list)
    calculation_time_ms: float = Field(default=0.0, alias="calculationTimeMs")


__all__ = [
    "MemberType",
    "CheckType",
    "StatusLabel",
    "SizingAssumptions",
    "MemberCheck",
    "MemberSizingSummary",
    "ColumnTakedownEntry",
    "UpdatedSchemeMetrics",
    "SizingResult",
]
