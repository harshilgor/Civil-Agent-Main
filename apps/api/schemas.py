"""API request / response schemas (separate from parser models).

This file is the API surface contract. Parser-side models flow through
unchanged for the geometry payload; everything API-specific (file
upload, parse trigger, accept) lives here.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from packages.engine.geometry_parser.models import ParsedGeometry


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


class UploadUrlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filename: str = Field(..., min_length=1, max_length=255)
    contentType: str = Field(..., min_length=1, max_length=255)


class UploadUrlResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileId: str
    presignedUrl: str
    expiresInSeconds: int
    s3Key: str
    maxBytes: int


class FileRegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileId: str
    fileSize: int = Field(..., ge=0)
    sha256: str | None = None


class FileDownloadUrlResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileId: str
    downloadUrl: str
    expiresInSeconds: int
    filename: str
    fileFormat: str


# ---------------------------------------------------------------------------
# Geometry / parsing
# ---------------------------------------------------------------------------


class ParseOptions(BaseModel):
    """Optional knobs that influence parser behaviour and idempotency.

    Adding a key here automatically participates in the idempotency hash
    (see :func:`packages.engine.geometry_parser.ids.idempotency_key`),
    which means two parse triggers with different options produce
    separate jobs/geometries by design.
    """

    model_config = ConfigDict(extra="forbid")
    pageNumber: int | None = Field(
        default=None,
        ge=1,
        le=999,
        description=(
            "PDF only: 1-based page number to parse. Omit for vector PDFs "
            "to parse every page (one Level per page)."
        ),
    )


class ParseTriggerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileId: str
    force: bool = False
    options: ParseOptions | None = None


class ParseTriggerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    jobId: str
    geometryId: str
    status: Literal["queued", "deduped"] = "queued"
    idempotencyKey: str


class GeometryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    projectId: str
    version: int
    parseStatus: Literal["processing", "completed", "partial", "failed"]
    reviewStatus: Literal["pending", "accepted", "superseded"]
    createdAt: datetime
    completedAt: datetime | None = None
    acceptedAt: datetime | None = None
    acceptedBy: str | None = None
    geometry: ParsedGeometry | None = None


class GeometryAcceptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(default=None, max_length=1000)


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["ok", "degraded"] = "ok"
    parserVersion: str
    schemaVersion: str


# ---------------------------------------------------------------------------
# Schemes (Agent 3)
# ---------------------------------------------------------------------------


from packages.engine.column_generator.models import (  # noqa: E402
    GenerationConstraints,
    StructuralScheme,
)


class GenerateSchemeRequest(BaseModel):
    """Request body for ``POST /schemes/generate``.

    Both fields are optional: when ``constraints`` is omitted the
    worker uses the material-system bay defaults, and when
    ``geometry_id`` is omitted the latest accepted/completed geometry
    for the project is used. This keeps the happy-path UI call to a
    single ``POST`` with no body.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    constraints: GenerationConstraints | None = None
    geometry_id: str | None = Field(default=None, alias="geometryId")


class GenerateJobResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    job_id: str = Field(..., alias="jobId")
    geometry_id: str = Field(..., alias="geometryId")
    generation_run_id: str = Field(..., alias="generationRunId")
    status: Literal["queued"] = "queued"


class SchemeListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    schemes: list[StructuralScheme]
    geometry_id: str | None = Field(default=None, alias="geometryId")
    generation_run_id: str | None = Field(default=None, alias="generationRunId")


class SchemeStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["active"] = "active"


# ---------------------------------------------------------------------------
# Sizing (Agent 4)
# ---------------------------------------------------------------------------


from packages.engine.member_sizer.models import (  # noqa: E402
    ColumnTakedownEntry,
    MemberCheck,
    MemberSizingSummary,
    SizingAssumptions,
)


class CalculateSizingRequest(BaseModel):
    """Request body for ``POST /schemes/{id}/calculate``.

    ``assumptions`` is optional — when omitted the worker reads
    ``project_assumptions`` from the DB, then falls back to engine
    defaults for any field not present.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    assumptions: SizingAssumptions | None = None


class CalculateSizingResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    job_id: str = Field(..., alias="jobId")
    scheme_id: str = Field(..., alias="schemeId")
    sizing_run_id: str = Field(..., alias="sizingRunId")
    status: Literal["queued", "deduped"] = "queued"


class MembersListResponse(BaseModel):
    """Response shape for ``GET /schemes/{id}/members``."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    scheme_id: str = Field(..., alias="schemeId")
    sizing_status: Literal["unsized", "calculating", "sized", "failed"] = (
        Field(..., alias="sizingStatus")
    )
    members: list[MemberSizingSummary] = Field(default_factory=list)
    assumptions_used: SizingAssumptions | None = Field(
        default=None, alias="assumptionsUsed"
    )
    sized_at: datetime | None = Field(default=None, alias="sizedAt")


class MemberDetailResponse(BaseModel):
    """Response shape for ``GET /schemes/{id}/members/{member_id}``."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    summary: MemberSizingSummary
    takedown: list[ColumnTakedownEntry] = Field(default_factory=list)


class ColumnTakedownGroup(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    column_id: str = Field(..., alias="columnId")
    grid_label: str = Field(default="", alias="gridLabel")
    levels: list[ColumnTakedownEntry] = Field(default_factory=list)


class TakedownResponse(BaseModel):
    """Response shape for ``GET /schemes/{id}/takedown``."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    scheme_id: str = Field(..., alias="schemeId")
    columns: list[ColumnTakedownGroup] = Field(default_factory=list)


class ProjectAssumptionsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    project_id: str = Field(..., alias="projectId")
    assumptions: SizingAssumptions
    updated_at: datetime | None = Field(default=None, alias="updatedAt")
