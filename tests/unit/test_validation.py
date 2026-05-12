"""Validation step tests."""

from __future__ import annotations

from datetime import datetime, timezone

from packages.engine.geometry_parser.constants import CONFIDENCE_WEIGHTS
from packages.engine.geometry_parser.models import (
    BuildingBounds,
    Core,
    ExistingColumn,
    GridLine,
    Level,
    OriginTransform,
    ParseMetadata,
    ParsedGeometry,
    Point2D,
)
from packages.engine.geometry_parser.validation import validate_and_score


def _meta() -> ParseMetadata:
    return ParseMetadata(
        runId="00000000-0000-0000-0000-000000000001",
        fileFormat="ifc",
        fileHash="0" * 64,
        overallConfidence=1.0,
        status="processing",
        completedSteps=[],
        warnings=[],
        originTransform=OriginTransform(tx=0.0, ty=0.0),
        parsedAt=datetime.now(timezone.utc),
    )


def _geometry(**parts) -> ParsedGeometry:
    base = dict(
        levels=[],
        gridLines=[],
        cores=[],
        existingColumns=[],
        noColumnZones=[],
        floorPlates=[],
        openings=[],
        buildingBounds=BuildingBounds(minX=-100, minY=-100, maxX=100, maxY=100),
        metadata=_meta(),
    )
    base.update(parts)
    return ParsedGeometry(**base)


def test_overlapping_grids_emit_warning():
    grids = [
        GridLine(id="a", axis="x", label="1", coordinate=10.0, source="ifc"),
        GridLine(id="b", axis="x", label="2", coordinate=10.0, source="ifc"),
    ]
    g = _geometry(gridLines=grids, levels=[_basic_level()])
    _, warnings, _ = validate_and_score(g, weights=CONFIDENCE_WEIGHTS)
    assert any("overlap" in w for w in warnings)


def test_duplicate_level_elevation_warns():
    levels = [_basic_level(elev=0), _basic_level(elev=0, name="Ghost Level")]
    g = _geometry(levels=levels, gridLines=[_grid("x")])
    _, warnings, _ = validate_and_score(g, weights=CONFIDENCE_WEIGHTS)
    assert any("duplicate" in w.lower() for w in warnings)


def test_column_pointing_at_unknown_level_warns():
    columns = [
        ExistingColumn(
            id="c1", x=0, y=0, startLevel="lvl_unknown", endLevel="lvl_1",
            gridAligned=True,
        )
    ]
    g = _geometry(existingColumns=columns, levels=[_basic_level()], gridLines=[_grid("x")])
    _, warnings, _ = validate_and_score(g, weights=CONFIDENCE_WEIGHTS)
    assert any("unknown startLevel" in w for w in warnings)


def test_core_containing_column_warns():
    boundary = [Point2D(x=-5, y=-5), Point2D(x=5, y=-5), Point2D(x=5, y=5), Point2D(x=-5, y=5)]
    core = Core(
        id="core1", type="elevator", boundary=boundary, levelIds=["lvl_1"],
        confidence=0.9, source="ifc",
    )
    column = ExistingColumn(
        id="c1", x=0, y=0, startLevel="lvl_1", endLevel="lvl_2", gridAligned=True,
    )
    g = _geometry(
        cores=[core],
        existingColumns=[column],
        levels=[_basic_level()],
        gridLines=[_grid("x")],
    )
    _, warnings, _ = validate_and_score(g, weights=CONFIDENCE_WEIGHTS)
    assert any("inside core boundary" in w for w in warnings)


def test_overall_confidence_weighted_correctly():
    g = _geometry(levels=[_basic_level()], gridLines=[_grid("x")])
    _, _, overall = validate_and_score(g, weights=CONFIDENCE_WEIGHTS)
    assert 0 < overall <= 1.0


def test_no_levels_gives_zero_levels_score():
    g = _geometry(levels=[], gridLines=[_grid("x")])
    _, warnings, overall = validate_and_score(g, weights=CONFIDENCE_WEIGHTS)
    assert any("no levels detected" in w for w in warnings)
    assert overall < 1.0


def _basic_level(*, elev: float = 0, name: str = "L1") -> Level:
    return Level(
        id=f"lvl_{name}_{elev}",
        name=name,
        elevation=elev,
        height=14.0,
        planBoundary=[
            Point2D(x=0, y=0), Point2D(x=10, y=0),
            Point2D(x=10, y=10), Point2D(x=0, y=10),
        ],
        confidence=1.0,
    )


def _grid(axis: str) -> GridLine:
    return GridLine(id=f"g_{axis}", axis=axis, label="1", coordinate=0.0, source="ifc")
