"""Contract tests for the canonical Pydantic models."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from packages.engine.geometry_parser.models import (
    BuildingBounds,
    Core,
    ExistingColumn,
    GridLine,
    Level,
    NoColumnZone,
    OriginTransform,
    ParseMetadata,
    ParsedGeometry,
    Point2D,
)


def _meta(**overrides) -> ParseMetadata:
    base = dict(
        runId="00000000-0000-0000-0000-000000000001",
        fileFormat="ifc",
        fileHash="0" * 64,
        overallConfidence=0.9,
        status="completed",
        completedSteps=[],
        warnings=[],
        originTransform=OriginTransform(tx=0.0, ty=0.0),
        parsedAt=datetime.now(timezone.utc),
    )
    base.update(overrides)
    return ParseMetadata(**base)


def _bounds() -> BuildingBounds:
    return BuildingBounds(minX=0, minY=0, maxX=100, maxY=100)


def test_parsed_geometry_required_fields_default_to_empty_lists():
    pg = ParsedGeometry(buildingBounds=_bounds(), metadata=_meta())
    assert pg.levels == []
    assert pg.gridLines == []
    assert pg.cores == []
    assert pg.openings == []
    assert pg.existingColumns == []
    assert pg.noColumnZones == []
    assert pg.floorPlates == []
    assert pg.metadata.schemaVersion == "parsed_geometry@1.0.0"
    assert pg.metadata.parserVersion == "1.0.0"


def test_building_bounds_rejects_inverted_min_max():
    with pytest.raises(ValueError):
        BuildingBounds(minX=10, minY=0, maxX=0, maxY=10)


def test_core_requires_three_boundary_points():
    with pytest.raises(ValueError):
        Core(
            id="c", type="elevator",
            boundary=[Point2D(x=0, y=0), Point2D(x=1, y=1)],
            confidence=0.9, source="ifc",
        )


def test_grid_line_constraints():
    g = GridLine(id="g", axis="x", label="1", coordinate=10, confidence=1.0, source="ifc")
    assert g.axis == "x"
    with pytest.raises(ValueError):
        GridLine(id="g", axis="z", label="1", coordinate=10, source="ifc")  # type: ignore[arg-type]


def test_existing_column_grid_deviation_optional():
    c = ExistingColumn(
        id="c1", x=0, y=0, startLevel="lvl_1", endLevel="lvl_2",
        gridAligned=True, gridDeviation=None,
    )
    assert c.gridDeviation is None
    c2 = c.model_copy(update={"gridAligned": False, "gridDeviation": 4.2})
    assert c2.gridDeviation == 4.2


def test_no_column_zone_validates_source_literal():
    with pytest.raises(ValueError):
        NoColumnZone(
            id="z", name="lobby",
            boundary=[Point2D(x=0, y=0), Point2D(x=1, y=0), Point2D(x=1, y=1)],
            reason="lobby",
            source="random",  # type: ignore[arg-type]
            confidence=0.5,
        )


def test_origin_transform_units_locked_to_feet():
    OriginTransform(tx=10, ty=20)
    with pytest.raises(ValueError):
        OriginTransform(tx=0, ty=0, units="m")  # type: ignore[arg-type]


def test_metadata_status_enum():
    with pytest.raises(ValueError):
        _meta(status="weird-status")
